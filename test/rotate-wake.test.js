// dsh-deepartments — fb-11 (QH ALTO, the host-rotation no-wake defect): after
// dept_sleep → sleepHost → runHostRotation (spec 002 S1.5b-S8) commits, the NEW
// host session is registered (hosts.json live entry) + workspace-attached +
// artifact-persisted, but NOTHING materialized it — it parked until the first
// EXTERNAL wake, so an org at rest slept the host (and its governance)
// indefinitely (evidence: 5c5fc173→024447d9, 2m47s gap; structural in the 3
// prior rotations). The fix: the lifecycle's `enqueueHostWake` seam (invoked by
// sleepHost right after the S3/S7 commit) makes the BUNDLE enqueue + deliver a
// DURABLE 'rotation-wake' bus record from 'deepartments' to the NEW host id
// (message-store append — write-ahead durable-first — then the D4 dormant-host
// delivery `busDeliverToHost`, which RESUMES the new session and starts its
// first turn with the wake pack / the new sessionId identity). NO delivery-
// sidecar row is written (the delivery engine would ACL-deny a
// 'deepartments'-from record as an unclassified sender; a sidecar row would
// make the boot re-drive it through that denied route into a 'failed' row the
// W6 scan re-alerts on) — so the wake is EXACTLY-ONCE: one record, one
// delivery, no double tuple, no loss after the append.
//
// Coverage (the mission's acceptance matrix):
//   (1) rotate → the NEW session starts its first turn WITHOUT any external
//       traffic (it was RESUMED by the rotation's own wake; the materialized
//       agent holds exactly the wake message);
//   (2) zero regression: rotate + SUBSEQUENT traffic → same semantics (the
//       later message enters the SAME live-branch delivery — 'delivered',
//       no second resume — and the rotation asserts stay intact);
//   (3) the rotation chain (spec 002 exactly-one-live), the QD host-rotated
//       directive (100% mandate, no dice) and the PR-2 in-session settle
//       (the retired host's pending rows become terminal AT ROTATION TIME)
//       stay intact;
//   (4) the wake does NOT produce a double tuple / loss (write-ahead): EXACTLY
//       ONE durable 'rotation-wake' record, ZERO sidecar rows for it, EXACTLY
//       ONE resume of the new session.
//
// Rule 5 (AGENTS.md): tests go through the REAL Cordis Loader with the REAL
// dsh services (sessions, sessionProjections, systemPrompt, tools) AND the
// REAL SubagentRuntime continuation manager, with stub subagent providers and
// stub agents/persistence/workspace-registry services — the same hermetic
// harness shape test/rotate-settle.test.js uses (self-contained copy). Temp
// stateDirs, no network, no live DSH_HOME, no LLM. Tests run against the
// compiled lib (pnpm build first).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { loadMessageRecords, parseDeliveryRows, resolveDeliveriesPath, resolveMessagesPath, deliveryStatus } from '../lib/messages-store.js'
import { runHealthDaemonTick } from '../lib/invoke.js'
import { TOOLSET_AUDIT_FLAG_ENV } from '../lib/toolset-audit.js'

// M2.3: the hermetic suite runs with the toolset-audit channel DISABLED (same
// as invoke.test.js / rotate-settle.test.js).
process.env[TOOLSET_AUDIT_FLAG_ENV] = '0'

// The QD org (research + quality heads) so the host-rotation QUALITY INSPECT
// directive has quality-head to be addressed to (the 100% mandate, no dice).
const QD_ORG = {
  departments: [
    {
      id: 'research',
      name: 'Research',
      coordinator: {
        postId: 'research-head',
        role: 'Research department head',
        provider: 'deepseek-official',
        agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' }
      }
    },
    {
      id: 'quality',
      name: 'Quality',
      coordinator: {
        postId: 'quality-head',
        role: 'Quality department head',
        provider: 'deepseek-official',
        agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' }
      }
    }
  ]
}

// --- hermetic harness (self-contained copy of the rotate-settle.test.js shape) --

/** Shared adoption map: durable child session id → its direct parent session id
 * (the stub persistence/agents use it to author a resumed child's header). */
const postAdoption = new Map()

/** Subagent provider stub: continuable-capable, records prepare calls. */
function stubProvider(name) {
  const provider = {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: name === 'fork',
    prepareCalls: [],
    async start() {
      throw new Error(`stub provider "${name}": one-shot start is not used in these tests`)
    },
    async prepareContinuable(request) {
      provider.prepareCalls.push(request)
      return { seed: [] }
    }
  }
  return provider
}

/** Materialize one (fresh or resumed) agent with the requested identity. */
async function materializeStubAgent(agents, sessionId, options) {
  const callerSignal = options.signal
  let callerSignalAborted = false
  callerSignal?.addEventListener('abort', () => {
    callerSignalAborted = true
  }, { once: true })
  const parentSession = options.parentSession ?? options.meta?.parentSession
  const agent = {
    id: sessionId,
    options: options.agentOptions ?? {},
    status: 'idle',
    session: {
      header: {
        id: sessionId,
        parentSession,
        delegationDepth: options.meta?.delegationDepth
      },
      events: []
    },
    inboxMessages: [],
    ctx: undefined,
    callerSignalAborted: () => callerSignalAborted,
    followup(message) {
      this.inboxMessages.push(message)
    },
    steer() {},
    inject() {},
    send() {},
    cancelCalls: [],
    cancel(cause, options) {
      this.cancelCalls.push({ cause, options })
    },
    whenIdle() {
      return new Promise(() => {})
    }
  }
  const childKey = Symbol('stub-child-scope')
  const scope = createScope(agents.scopeAnchor, childKey)
  const childCtx = scope.ctx.extend({ agent })
  agent.ctx = childCtx
  agents.childContexts.push({ ctx: childCtx, key: childKey })
  agents.childAgents.push(agent)
  const provision = await options.setup?.(childCtx)
  provision?.commit?.()
  agents.store.set(sessionId, agent)
  return {
    agent,
    dispose: async () => {
      agents.disposeCalls.set(sessionId, (agents.disposeCalls.get(sessionId) ?? 0) + 1)
      const gate = agents.disposeGates.get(sessionId)
      if (gate !== undefined) await gate
      agents.store.delete(sessionId)
    }
  }
}

/** Stub agents service: satisfies the REAL SubagentContinuationManager's
 * materialization + cold-resume contract (the rotation + wake paths exercise
 * `create` (nothing here) + `resume` (the D4 dormant-host wake)). */
class StubAgents extends Service {
  constructor(ctx, sessionCwds) {
    super(ctx, 'agents')
    this.store = new Map()
    this.createCalls = []
    this.resumeCalls = []
    this.childContexts = []
    this.childAgents = []
    this.scopeAnchor = ctx
    this.sessionCwds = sessionCwds
    this.resumeRejects = new Set()
    this.createRejects = new Set()
    this.createNoProviderRejects = new Set()
    this.resumeNotFoundOnce = new Set()
    this.resumeNotFound = new Set()
    this.disposeGates = new Map()
    this.disposeCalls = new Map()
    this.scopeParentKey = undefined
    this.scopeKeyAsAgent = false
    this.scopeCreate = undefined
  }

  get(id) {
    return this.store.get(id)
  }

  list() {
    return [...this.store.values()]
  }

  roots() {
    return [...this.store.values()]
  }

  put(agent) {
    this.store.set(agent.id, agent)
    return agent
  }

  ensureStoreSession(sessionId) {
    const id = SessionId(sessionId)
    const store = this.ctx.get('sessions')
    if (store === undefined || typeof store.get !== 'function') return undefined
    const existing = store.get(id)
    if (existing !== undefined) return existing
    try {
      return store.create(id, {}) ?? store.get(id)
    } catch {
      return store.get(id)
    }
  }

  async create(options) {
    this.createCalls.push(options)
    if (this.createNoProviderRejects.has(String(options.sessionId))) throw new Error(`agent "session-${String(options.sessionId)}" has no provider/model`)
    if (this.createRejects.has(String(options.sessionId))) throw new Error('stub: forced create failure')
    this.sessionCwds?.set(String(options.sessionId), options.meta?.cwd)
    this.ensureStoreSession(options.sessionId)
    return materializeStubAgent(this, options.sessionId, options)
  }

  async resume(options) {
    this.resumeCalls.push(options)
    if (this.resumeNotFound.has(options.resumeSessionId)) throw new Error(`session "${options.resumeSessionId}" not found`)
    if (this.resumeNotFoundOnce.has(options.resumeSessionId)) {
      this.resumeNotFoundOnce.delete(options.resumeSessionId)
      throw new Error(`session "${options.resumeSessionId}" not found`)
    }
    if (this.resumeRejects.has(options.resumeSessionId)) throw new Error('stub: forced resume failure')
    this.sessionCwds?.set(String(options.resumeSessionId), options.meta?.cwd)
    this.ensureStoreSession(options.resumeSessionId)
    return materializeStubAgent(this, options.resumeSessionId, {
      ...options,
      parentSession: postAdoption.get(options.resumeSessionId)
    })
  }
}

/** Stub persistence: records the rotation S2 `create`/`append` calls as spies. */
class StubPersistence extends Service {
  constructor(ctx) {
    super(ctx, 'sessionPersistence')
    this.createCalls = []
    this.appendCalls = []
  }

  async create(meta) {
    this.createCalls.push(meta)
  }

  async append(id, events) {
    this.appendCalls.push({ id, events })
  }

  async inspect(childId) {
    const parentSession = postAdoption.get(childId)
    if (parentSession === undefined) {
      throw new Error('stub persistence: no stored session for this child')
    }
    return {
      meta: { parentSession, seedLength: 0 },
      events: [{ type: 'subagent/descriptor', data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'board-post' } }]
    }
  }

  async list() {
    return []
  }
}

/** Stub of the canonical session-archive service (dsh-workspace
 * `workspaceRegistry`): `list()`/`attachSession` (spec 002 §3.3 S2.2) and
 * `archiveSession` (S2.5). */
class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir, sessionCwds) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.archived = []
    this.attachCalls = []
    this.sessionCwds = sessionCwds
    this.entitySessions = []
    const defaultEntity = {
      path: stateDir,
      title: 'root',
      sessionIds: this.entitySessions,
      attachSession: async (sessionId) => {
        this.attachCalls.push(sessionId)
        const cwd = this.sessionCwds?.get(String(sessionId))
        if (cwd !== undefined && cwd !== stateDir) throw new Error(`stub: cwd mismatch for ${sessionId} (${cwd} != ${stateDir})`)
        if (!this.entitySessions.includes(sessionId)) {
          this.entitySessions.push(sessionId)
          writeFile(path.join(this.stateDir, 'workspace.json'), JSON.stringify({ path: this.stateDir, sessionIds: [...this.entitySessions] }, null, 2), 'utf8')
            .catch(() => {})
        }
      }
    }
    this.entities = [defaultEntity]
  }

  get archivedSessionIds() {
    return this.archived
  }

  list() {
    return Promise.resolve(this.entities)
  }

  async create(path, title) {
    this.createCalls = [...(this.createCalls ?? []), { path, title }]
    const existing = this.entities.find((e) => e.path === path)
    if (existing !== undefined) return existing
    const sessions = []
    const entity = {
      path,
      title,
      sessionIds: sessions,
      attachSession: async (sessionId) => {
        this.attachCalls.push(sessionId)
        if (!sessions.includes(sessionId)) sessions.push(sessionId)
      }
    }
    this.entities.push(entity)
    return entity
  }

  async resolveByPath(path) {
    const canonical = await realpath(path)
    return this.entities.find((e) => e.path === canonical)
  }

  async archiveSession(sessionId) {
    if (this.archived.includes(sessionId)) return
    this.archived.push(sessionId)
    writeFile(path.join(this.stateDir, 'workspace-registry.json'), JSON.stringify(this.archived, null, 2), 'utf8')
      .catch(() => {})
  }
}

/** A live parent agent as the registry would hold it (exact identity). */
function fakeParentAgent(id = SessionId(randomUUID())) {
  return {
    id,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    status: 'idle',
    session: { header: { id }, events: [] },
    ctx: { get: () => undefined },
    inboxMessages: [],
    injectedMessages: [],
    followup(message) {
      this.inboxMessages.push(message)
    },
    steer() {},
    inject(message) {
      this.injectedMessages.push(message)
    },
    send() {},
    cancelCalls: [],
    cancel(cause, options) {
      this.cancelCalls.push({ cause, options })
    },
    whenIdle() {
      return new Promise(() => {})
    }
  }
}

/** Boot the real Loader with the real dsh services + the deepartments bundle
 * (the hermetic composition — no dshd-core plugin row, so the bundle uses its
 * in-bundle lifecycle construction, which is the SAME dshd-core
 * createLifecycleService with the fb-11 `enqueueHostWake` dep wired). */
async function bootPlugin(stateDir, opts = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })

  const agents = new StubAgents(root, new Map())
  const persistence = new StubPersistence(root)
  const workspaceRegistry = new StubWorkspaceRegistry(root, stateDir, agents.sessionCwds)
  await root.plugin(SubagentRuntime)

  const spawnStub = stubProvider('spawn')
  const forkStub = stubProvider('fork')
  root.subagents.registerProvider(spawnStub)
  root.subagents.registerProvider(forkStub)

  loader.create({
    id: 'deepartments',
    name: '../lib/index.js',
    config: {
      stateDir,
      org: opts.org ?? QD_ORG
    }
  })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return {
    root,
    agents,
    persistence,
    workspaceRegistry,
    spawnStub,
    forkStub,
    pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx,
    dispose: () => loaderFiber.dispose()
  }
}

/** Boot with QD_ORG and wait for BOTH the research head and the quality head. */
async function bootPluginReady(stateDir) {
  const env = await bootPlugin(stateDir)
  await waitFor(() => env.agents.store.has('head-research-head'), 5000, 'research head materialized at boot')
  await waitFor(() => env.agents.store.has('head-quality-head'), 5000, 'quality head materialized at boot')
  return env
}

async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-rotate-wake-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Pre-author a post's long-term memory journal (dept_sleep REQUIRES it). */
async function seedJournal(stateDir, postId, summary) {
  const journalPath = path.join(stateDir, 'journals', `${postId}.md`)
  await mkdir(path.dirname(journalPath), { recursive: true })
  const content = [
    '---',
    `author: ${postId}`,
    `timestamp: ${new Date().toISOString()}`,
    'wake_counter: 1',
    'board_cursor: none',
    'decisions: []',
    'constraints: []',
    'open_items: []',
    '---',
    '',
    summary,
    ''
  ].join('\n')
  await writeFile(journalPath, content, 'utf8')
  return journalPath
}

async function readHosts(stateDir) {
  const hostsPath = path.join(stateDir, 'hosts.json')
  let parsed
  await waitFor(async () => {
    try {
      parsed = JSON.parse(await readFile(hostsPath, 'utf8'))
      return true
    } catch {
      return false
    }
  }, 5000, 'hosts.json readable')
  return parsed
}

async function seedMessageRecords(stateDir, records) {
  const filePath = resolveMessagesPath(stateDir)
  await mkdir(stateDir, { recursive: true })
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

async function seedDeliveryRows(stateDir, rows) {
  const filePath = resolveDeliveriesPath(stateDir)
  await mkdir(stateDir, { recursive: true })
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

/** The ADDRESSED QUALITY INSPECT directives that reached `quality-head`. */
async function qualityDirectives(stateDir) {
  const records = await loadMessageRecords(resolveMessagesPath(stateDir))
  return records.filter((r) => r.from === 'deepartments' && (r.to ?? []).includes('quality-head'))
}

/** The research-head agent + its own-layer scoped toolset (send_message). */
function researchHeadTools(env) {
  const head = env.agents.store.get('head-research-head')
  const index = env.agents.childAgents.findIndex((agent) => agent && agent.id === 'head-research-head')
  assert.ok(index >= 0, 'research-head child scope exists')
  const { ctx: headCtx, key } = env.agents.childContexts[index]
  return { head, headCtx, key }
}

// --- the fb-11 host-rotation wake ---------------------------------------------

test('fb-11 (1): after the dept_sleep ROTATION commits, the NEW host session starts its first turn WITHOUT any external traffic — the rotation wake RESUMES it (D4 dormant-host resume) with exactly the durable rotation-wake record; EXACTLY-ONCE (one record, ZERO sidecar rows, one resume); the rotation chain (spec 002 exactly-one-live) + the QD host-rotated directive (100%, no dice) stay intact', async () => {
  await withTempStateDir(async (stateDir) => {
    const host = fakeParentAgent() // the (OLD) host session about to ROTATE
    const oldHostId = `host-${host.id}`
    await seedJournal(stateDir, oldHostId, 'FB11-ROTATION-MEMORY')
    const env = await bootPluginReady(stateDir)
    try {
      env.agents.put(host)
      const realSession = Session.create(SessionId(String(host.id)))
      realSession.append('user/message', { role: 'user', content: [{ type: 'text', text: 'prior turn' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      host.session = realSession
      let concluded = false
      const signal = new AbortController().signal
      const result = await env.root.tools.get('dept_sleep').execute({}, { agent: host, signal, concludeTurn: () => { concluded = true } })
      assert.ok(concluded, 'the host turn concluded')
      assert.match(result.member, /^host-session-/, 'the rotation returned the NEW host id')
      const newHostId = result.member
      const newSessionId = newHostId.slice('host-'.length)

      // (1) THE FIX — the NEW session starts its first turn WITHOUT external
      // traffic: it was RESUMED by the rotation's own wake at commit time.
      const wakeResumes = env.agents.resumeCalls.filter((c) => String(c.resumeSessionId) === newSessionId)
      assert.equal(wakeResumes.length, 1, 'the NEW host session was resumed EXACTLY once by the rotation wake (no external traffic involved)')
      const resumeCall = wakeResumes[0]
      assert.ok(resumeCall.agentOptions && typeof resumeCall.agentOptions.provider === 'string' && resumeCall.agentOptions.provider.length > 0, 'the rotation wake resume carries the host agent options (D4 parity — busDeliverToHost HOST_AGENT_OPTIONS)')
      const target = env.agents.store.get(newSessionId)
      assert.ok(target !== undefined, 'the NEW host session is MATERIALIZED right after the rotate commit (the wake made it live)')
      assert.equal(target.inboxMessages.length, 1, 'the NEW host received EXACTLY ONE message — the rotation wake (its first turn input)')
      const wake = target.inboxMessages[0]
      assert.match(wake.content[0].text, /^\[From deepartments → host-session-/, 'the rotation wake is framed as the org-system handoff sender')
      assert.match(wake.content[0].text, /rotation/, 'the rotation-wake message names the rotation handoff')

      // (4) EXACTLY-ONCE / write-ahead — one durable record, no double tuple:
      const records = await loadMessageRecords(resolveMessagesPath(stateDir))
      const wakeRecords = records.filter((r) => r.from === 'deepartments' && (r.to ?? []).includes(newHostId))
      assert.equal(wakeRecords.length, 1, 'EXACTLY ONE durable rotation-wake record in messages.jsonl')
      assert.match(wakeRecords[0].text, /rotation/, 'the durable record is the rotation-wake handoff')
      assert.equal(wakeRecords[0].kind, 'notice', 'the rotation-wake record is a notice (never a user-typed message)')
      const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8').catch(() => '')).filter((row) => row.messageId === wakeRecords[0].id)
      assert.equal(rows.length, 0, 'the rotation wake writes ZERO delivery-sidecar rows (no boot re-drive, no W6 anomaly, no double tuple)')
      // the OLD session is never re-woken by the wake (retired identity, S6).
      assert.equal(env.agents.resumeCalls.filter((c) => String(c.resumeSessionId) === String(host.id)).length, 0, 'the OLD (retired) session is NEVER resumed again')

      // (3) the rotation chain is INTACT (spec 002 — exactly-one-live):
      const hosts = await readHosts(stateDir)
      const oldEntry = hosts[oldHostId]
      const newEntry = hosts[newHostId]
      assert.ok(oldEntry?.retired === true, 'the OLD host entry is retired (retired:true + rotatedTo)')
      assert.equal(oldEntry.rotatedTo, newHostId, 'the retired entry names the rotated-to host')
      assert.equal(newEntry.previousSessionId, String(host.id), 'the NEW live entry references the retired old session')
      assert.equal(newEntry.roomId, 'board', 'the new entry keeps the room')
      assert.ok(typeof newEntry.sleepEpoch === 'number', 'the new entry carries the durable sleepEpoch')
      const liveEntries = Object.entries(hosts).filter(([key, e]) => key !== 'schemaVersion' && e.retired !== true)
      assert.equal(liveEntries.length, 1, 'exactly ONE live entry: the rotated NEW host (the retired old + the schemaVersion marker are not live)')
      assert.ok(env.workspaceRegistry.archived.includes(String(host.id)), 'the OLD host session is archived server-side (S2.5)')

      // (3) QD host-rotated directive — still exactly ONE (100% mandate, no dice;
      // the wake neither suppresses nor duplicates it).
      const dirs = await qualityDirectives(stateDir)
      const hostDirs = dirs.filter((d) => /host rotated/.test(d.text))
      assert.equal(hostDirs.length, 1, 'a host rotation ALWAYS emits exactly ONE host-rotated directive (the rotation wake does not disturb it)')
      assert.match(hostDirs[0].text, new RegExp(`old session ${host.id}`), 'the host-rotated directive names the OLD (archived) session')
      assert.match(hostDirs[0].text, /new session session-[0-9a-f-]+/, 'the host-rotated directive names the NEW session')
    } finally {
      await env.dispose()
    }
  })
})

test('fb-11 (2) ZERO REGRESSION: a rotation with SUBSEQUENT traffic keeps the same semantics — the rotation wake is immediate (the new host is LIVE), the later message enters the SAME live-branch delivery (delivered, NO second resume); the rotation chain + the PR-2 in-session settle (the retired host\'s pending rows become terminal AT ROTATION TIME) + the QD directive stay intact; the wake still leaves ZERO sidecar rows', async () => {
  await withTempStateDir(async (stateDir) => {
    const now = Date.now()
    const host = fakeParentAgent() // the (OLD) host session about to ROTATE
    const oldHostId = `host-${host.id}`
    await seedJournal(stateDir, oldHostId, 'FB11-REGRESSION-MEMORY')
    // The CANARY (pre-boot): a 'failed' row to a DEAD recipient whose message
    // record EXISTS. The boot re-delivery pass is FIRE-AND-FORGET — the canary
    // becomes 'terminal' only when the pass has consumed the pre-boot sidecar,
    // which deterministically proves the pass COMPLETED before the in-session
    // seed below (the pass race that would otherwise re-drive the in-session
    // rows at boot #1).
    await seedMessageRecords(stateDir, [
      { id: 'm-canary', seq: 0, ts: now, from: 'research-head', to: ['dead-canary'], text: 'pass-completion canary', kind: 'agent' },
      { id: 'm-1', seq: 1, ts: now, from: 'research-head', to: [oldHostId], text: 'crash mid-fan-out to host', kind: 'agent' }
    ])
    await seedDeliveryRows(stateDir, [{ messageId: 'm-canary', recipientId: 'dead-canary', status: 'failed', ts: now }])
    const env = await bootPluginReady(stateDir)
    try {
      // BARRIER: the pre-boot canary is settled to 'terminal' ONLY BY the boot
      // re-delivery pass — observing it proves the pass finished.
      await waitFor(async () => (await deliveryStatus(stateDir, 'm-canary', 'dead-canary')) === 'terminal', 5000, 'boot re-delivery pass completed (canary settled)')
      // The pending row is seeded IN-SESSION (post-pass), exactly like a
      // mid-session crash leaves it before the next boot (the PR-2 settle
      // target — the retired host must settle it AT ROTATION TIME).
      await seedDeliveryRows(stateDir, [{ messageId: 'm-1', recipientId: oldHostId, status: 'prepared', ts: now }])

      env.agents.put(host)
      const realSession = Session.create(SessionId(String(host.id)))
      realSession.append('user/message', { role: 'user', content: [{ type: 'text', text: 'prior turn' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      host.session = realSession
      let concluded = false
      const signal = new AbortController().signal
      const result = await env.root.tools.get('dept_sleep').execute({}, { agent: host, signal, concludeTurn: () => { concluded = true } })
      assert.ok(concluded, 'the host turn concluded')
      assert.match(result.member, /^host-session-/, 'the rotation returned the NEW host id')
      const newHostId = result.member
      const newSessionId = newHostId.slice('host-'.length)

      // The rotation WAKE is immediate: the new session is LIVE (materialized)
      // with exactly the wake message — no external traffic needed.
      assert.equal(env.agents.resumeCalls.filter((c) => String(c.resumeSessionId) === newSessionId).length, 1, 'the NEW host session was resumed once by the rotation wake')
      const target = env.agents.store.get(newSessionId)
      assert.ok(target !== undefined, 'the NEW host session is LIVE after the rotate commit')
      assert.equal(target.inboxMessages.length, 1, 'exactly the rotation-wake message before any external traffic')
      const recordsAfterRotate = await loadMessageRecords(resolveMessagesPath(stateDir))
      const wakeRecords = recordsAfterRotate.filter((r) => r.from === 'deepartments' && (r.to ?? []).includes(newHostId))
      assert.equal(wakeRecords.length, 1, 'EXACTLY ONE durable rotation-wake record (no double tuple)')

      // (3) PR-2 in-session settle is INTACT: the retired host's pending row
      // became terminal AT ROTATION TIME (no boot involved), and the NEW host
      // has NO terminal/settle row (untouched).
      assert.equal(await deliveryStatus(stateDir, 'm-1', oldHostId), 'terminal', 'the retired host\'s prepared row is settled to terminal AT ROTATION TIME (PR-2 settle intact)')
      const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
      assert.ok(rows.every((row) => row.recipientId !== newHostId), 'NO delivery-sidecar row EVER addresses the NEW live host (the settle + the wake never touch it)')
      assert.equal(rows.filter((row) => row.messageId === wakeRecords[0].id).length, 0, 'the rotation wake still writes ZERO sidecar rows after the settle runs')

      // (2) SUBSEQUENT traffic enters the SAME live-branch delivery: a head
      // sends to the NEW host AFTER the rotation → 'delivered' inline (the host
      // is live because the wake made it so), inbox +1, NO second resume.
      const { head, headCtx, key } = researchHeadTools(env)
      const before = target.inboxMessages.length
      const sendResult = await headCtx.tools.get('send_message', key).execute(
        { to: [newHostId], text: 'external traffic after the rotation' },
        { agent: head, signal }
      )
      assert.equal(sendResult.delivered[newHostId], 'delivered', 'the SUBSEQUENT message is delivered via the live branch (the wake made the host live; zero regression of the D4 path)')
      assert.equal(env.agents.resumeCalls.filter((c) => String(c.resumeSessionId) === newSessionId).length, 1, 'the subsequent traffic does NOT re-resume the new session (STILL exactly one resume — the wake was the only one)')
      await waitFor(() => target.inboxMessages.length === before + 1, 5000, 'the subsequent message reached the new host')
      assert.match(target.inboxMessages.at(-1).content[0].text, /^\[From research-head → host-/, 'the subsequent message carries the normal bus framing')

      // (3) rotation chain + QD directive intact (same asserts as test 1).
      const hosts = await readHosts(stateDir)
      const oldEntry = hosts[oldHostId]
      const newEntry = hosts[newHostId]
      assert.ok(oldEntry?.retired === true, 'the OLD host entry is retired (retired:true + rotatedTo)')
      assert.equal(oldEntry.rotatedTo, newHostId, 'the retired entry names the rotated-to host')
      assert.equal(newEntry.previousSessionId, String(host.id), 'the NEW live entry references the retired old session')
      assert.ok(typeof newEntry.sleepEpoch === 'number', 'the new entry carries the durable sleepEpoch')
      const liveEntries = Object.entries(hosts).filter(([key, e]) => key !== 'schemaVersion' && e.retired !== true)
      assert.equal(liveEntries.length, 1, 'exactly ONE live entry: the rotated NEW host')
      const dirs = await qualityDirectives(stateDir)
      assert.equal(dirs.filter((d) => /host rotated/.test(d.text)).length, 1, 'the QD host-rotated directive stays EXACTLY ONE (the wake + the settle + the subsequent traffic do not disturb it)')
    } finally {
      await env.dispose()
    }
    // (2 continued) the settle survives boot #2 intact (no double settlement /
    // no re-drive of the settled pair; the wake record is NOT re-delivered).
    const second = await bootPlugin(stateDir)
    try {
      await new Promise((resolve) => setTimeout(resolve, 250)) // give the fire-and-forget driver a chance
      const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
      assert.deepEqual(rows.filter((r) => r.messageId === 'm-1' && r.recipientId === oldHostId).map((r) => r.status), ['prepared', 'terminal'], 'boot #2 does not re-attempt the settled pair (no new rows)')
    } finally {
      await second.dispose()
    }
  })
})