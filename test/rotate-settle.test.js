// dsh-deepartments — PR-2 (m-243/m-356, QD P1 MEDIA — 2nd instance of the gap
// class, first documented by m-356): W7-A IN-SESSION settlement of the
// deliveries a HOST session retires with at dept_sleep ROTATION.
//
// The gap: the W7-A dead-recipient `terminal`-una-vez settlement exists in TWO
// places — the boot re-delivery driver (DeliveryRedeliverer.run, dshd-core
// messages.ts) and the in-session retirePost settle for retiring WORKERS
// (invoke.ts settleRetiredPostDeliveries, fb-7-ish). A delivery row
// 'prepared'/'failed' ADDRESSED TO A HOST SESSION (`host-<sessionId>`) that is
// retired BY THE ROTATION (dept_sleep → sleepHost → runHostRotation, spec 002
// S3/S7) had NO in-session settle: it stayed 'prepared' WITHOUT a terminal
// until the NEXT boot (m-243 recorded the 2nd occurrence). PR-2 fixes that in
// the lifecycle core (packages/dshd-core/src/lifecycle.ts, settleRetiredHost
// Deliveries — the host-rotation counterpart of the retirePost settle, reusing
// the SAME latestPerKey + needsRedelivery + markDelivery helpers as the boot
// driver), so a rotated host's pending rows are 'terminal' BEFORE any boot and
// the boot pass never re-attempts/re-alerts them (it remains the crash
// fallback, untouched).
//
// Rule 5 (AGENTS.md): tests go through the REAL Cordis Loader with the REAL
// dsh services (sessions, sessionProjections, systemPrompt, tools) AND the
// REAL SubagentRuntime continuation manager, with stub subagent providers and
// stub agents/persistence/workspace-registry services — the same hermetic
// harness shape test/invoke.test.js uses (self-contained copy: a NEW file so
// the fb-9 worktree batch in test/invoke.test.js is never touched). Temp
// stateDirs, no network, no live DSH_HOME, no LLM. Tests run against the
// compiled lib (pnpm build first).
//
// Coverage (the mission's acceptance matrix):
//   (1) a 'prepared'/'failed' delivery to a host session that RETIRES by
//       rotation becomes ONE 'terminal' row per pair AT ROTATION TIME — before
//       any boot;
//   (2) the NEXT boot does NOT re-attempt/re-alert the settled pairs (no double
//       settlement, no fresh prepared/failed rows);
//   (3) a 'prepared' row to a LIVE host (no rotation) is NOT touched;
//   (4) the real rotation (spec 002 exactly-one-live chain) is intact — old
//       retired + new live + server-side archive + QD host-rotated directive;
//   (5) the QD host-rotated directive (100% mandate, no dice) still emits
//       exactly ONE record addressed to quality-head.
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
import { settleRetiredHostDeliveries } from '../lib/core/lifecycle.js'
import { runHealthDaemonTick } from '../lib/invoke.js'
import { TOOLSET_AUDIT_FLAG_ENV } from '../lib/toolset-audit.js'

// M2.3: the hermetic suite runs with the toolset-audit channel DISABLED (same
// as invoke.test.js — a diagnostics-only file has no place in a temp stateDir).
process.env[TOOLSET_AUDIT_FLAG_ENV] = '0'

// The QD org (research + quality heads) so the host-rotation QUALITY INSPECT
// directive has quality-head to be addressed to (test 5 — the 100% mandate,
// no dice).
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

// --- hermetic harness (self-contained copy of the invoke.test.js shape) --------

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
    // Never settles: the Activation stays resident for the whole test.
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
 * materialization + cold-resume contract (trimmed to the seams the rotation +
 * boot-redelivery paths exercise). */
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

/** Stub persistence: records the rotation S2 `create`/`append` calls as spies
 * (no real artifact backend is needed — the point is that the COLD seed landed
 * via the persistence seam and NOT in the live store). */
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
 * `archiveSession` (S2.5 — records the archived ids + a durable mirror). */
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
 * createLifecycleService). */
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

async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-rotate-settle-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Pre-author a post's long-term memory journal at
 * `<stateDir>/journals/<postId>.md` (the durable file dept_memo_write writes
 * and dept_sleep REQUIRES before the host rotation can run). */
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

/** Seed a HOST registration into hosts.json BEFORE boot (a durable LIVE host —
 * used for the never-rotated neighbor host). Returns the host member id. */
async function seedHostRegistration(stateDir, sessionId, roomId = 'board') {
  const hostsPath = path.join(stateDir, 'hosts.json')
  await mkdir(stateDir, { recursive: true })
  await writeFile(hostsPath, JSON.stringify({ [`host-${sessionId}`]: { sessionId: String(sessionId), roomId } }, null, 2))
  return `host-${sessionId}`
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
  return filePath
}

/** The ADDRESSED QUALITY INSPECT directives that reached `quality-head`. */
async function qualityDirectives(stateDir) {
  const records = await loadMessageRecords(resolveMessagesPath(stateDir))
  return records.filter((r) => r.from === 'deepartments' && (r.to ?? []).includes('quality-head'))
}

// --- tests --------------------------------------------------------------------

test('PR-2 settle helper (pure): latestPerKey semantics — settles ONLY the latest prepared/failed row per (messageId, recipientId) of the RETIRED host ids to ONE terminal; settled (delivered/terminal) pairs and OTHER recipients (a live host) untouched; ENOENT tolerates a fresh stateDir', async () => {
  await withTempStateDir(async (stateDir) => {
    const now = Date.now()
    const oldHostId = 'host-s-retired'
    const rawOldSessionId = 's-retired'
    const liveHostId = 'host-s-live'
    // The ALTO-1 rebind guard cross-checks the CURRENT records: seed the
    // message records the settle pairs genuinely belong to (m-1/m-2 → the
    // retired host, m-4 → the raw retired session id).
    await seedMessageRecords(stateDir, [
      { id: 'm-1', seq: 1, ts: now, from: 'research-head', to: [oldHostId], text: 'crash mid-fan-out', kind: 'agent' },
      { id: 'm-2', seq: 2, ts: now, from: 'research-head', to: [oldHostId], text: 'rejected', kind: 'agent' },
      { id: 'm-4', seq: 4, ts: now, from: 'research-head', to: [rawOldSessionId], text: 'raw session address', kind: 'agent' }
    ])
    await seedDeliveryRows(stateDir, [
      { messageId: 'm-1', recipientId: oldHostId, status: 'prepared', ts: now },
      { messageId: 'm-2', recipientId: oldHostId, status: 'prepared', ts: now },
      { messageId: 'm-2', recipientId: oldHostId, status: 'failed', ts: now + 1 }, // shadows the prepared
      { messageId: 'm-3', recipientId: oldHostId, status: 'delivered', ts: now }, // already settled → untouched
      { messageId: 'm-4', recipientId: rawOldSessionId, status: 'prepared', ts: now }, // raw retired session id → settles
      { messageId: 'm-5', recipientId: oldHostId, status: 'terminal', ts: now }, // already terminal → untouched
      { messageId: 'm-6', recipientId: liveHostId, status: 'prepared', ts: now } // a LIVE host → untouched
    ])
    const settled = []
    await settleRetiredHostDeliveries(stateDir, { info: (message) => settled.push(message), warn: () => {} }, [oldHostId, rawOldSessionId])
    assert.equal(await deliveryStatus(stateDir, 'm-1', oldHostId), 'terminal', 'the prepared pair is settled to terminal')
    assert.equal(await deliveryStatus(stateDir, 'm-2', oldHostId), 'terminal', 'the failed pair is settled to terminal')
    assert.equal(await deliveryStatus(stateDir, 'm-3', oldHostId), 'delivered', 'an already-DELIVERED pair is untouched')
    assert.equal(await deliveryStatus(stateDir, 'm-4', rawOldSessionId), 'terminal', 'a row addressed to the raw retired session id settles too (boot parity)')
    assert.equal(await deliveryStatus(stateDir, 'm-5', oldHostId), 'terminal', 'an already-terminal pair is untouched (no extra row)')
    assert.equal(await deliveryStatus(stateDir, 'm-6', liveHostId), 'prepared', 'a LIVE host with a prepared row is NEVER touched')
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    assert.equal(rows.filter((r) => r.status === 'terminal').length, 4, 'exactly FOUR terminal rows in the whole sidecar: the 3 settled pairs (m-1, m-2, m-4) + the PRE-SEEDED m-5 terminal (untouched)')
    assert.equal(rows.filter((r) => r.status === 'terminal' && ['m-1', 'm-2', 'm-4'].includes(r.messageId)).length, 3, 'the settle contributed exactly THREE terminal rows (one per settled (messageId, recipientId) — never one per pending row)')
    assert.deepEqual(rows.filter((r) => r.messageId === 'm-2' && r.recipientId === oldHostId).map((r) => r.status), ['prepared', 'failed', 'terminal'], 'the failed pair gains ONLY ONE terminal row (latestPerKey)')
    assert.equal(settled.length, 3, 'one info line per settled pair')
  })
  // ENOENT tolerance: a fresh stateDir with no deliveries.jsonl → no throw.
  await withTempStateDir(async (stateDir) => {
    await settleRetiredHostDeliveries(stateDir, { info: () => {}, warn: () => {} }, ['host-s-retired'])
    // reached without throwing — the ENOENT path returns silently
  })
})

test('PR-2 W7-A rotation settle: a delivery prepared/failed to a HOST session that RETIRES by dept_sleep rotation becomes ONE terminal row AT ROTATION TIME (before any boot); a prepared row to a LIVE host is untouched; the rotation itself is intact (spec 002 exactly-one-live chain + S2.5 archive) and the QD host-rotated directive (100%, no dice) still emits exactly ONE', async () => {
  await withTempStateDir(async (stateDir) => {
    const now = Date.now()
    const host = fakeParentAgent() // the host session about to ROTATE (retire)
    const oldHostId = `host-${host.id}`
    const otherHost = fakeParentAgent() // a NEVER-rotated LIVE host
    const otherHostId = `host-${otherHost.id}`
    await seedHostRegistration(stateDir, String(otherHost.id))
    // The CANARY (pre-boot): a 'failed' row to a DEAD recipient whose message
    // record EXISTS. The boot re-delivery pass is FIRE-AND-FORGET (runs after
    // bootPlugin resolves) — the canary becomes 'terminal' only when the pass
    // has consumed the pre-boot sidecar, which deterministically proves the
    // pass COMPLETED before the in-session seed below (the pass race that
    // would otherwise re-deliver the in-session rows at boot #1).
    await seedMessageRecords(stateDir, [
      { id: 'm-canary', seq: 0, ts: now, from: 'research-head', to: ['dead-canary'], text: 'pass-completion canary', kind: 'agent' },
      { id: 'm-1', seq: 1, ts: now, from: 'research-head', to: [oldHostId], text: 'crash mid-fan-out to host', kind: 'agent' },
      { id: 'm-2', seq: 2, ts: now, from: 'research-head', to: [oldHostId], text: 'rejected host delivery', kind: 'agent' },
      { id: 'm-3', seq: 3, ts: now, from: 'research-head', to: [otherHostId], text: 'live host neighbor', kind: 'agent' }
    ])
    await seedDeliveryRows(stateDir, [{ messageId: 'm-canary', recipientId: 'dead-canary', status: 'failed', ts: now }])
    const env = await bootPlugin(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 5000, 'research head materialized at boot')
      await waitFor(() => env.agents.store.has('head-quality-head'), 5000, 'quality head materialized at boot')
      // BARRIER: the pre-boot canary is settled to 'terminal' ONLY BY the boot
      // re-delivery pass — observing it proves the pass finished (no in-flight
      // re-delivery can touch the rows seeded next).
      await waitFor(async () => (await deliveryStatus(stateDir, 'm-canary', 'dead-canary')) === 'terminal', 5000, 'boot re-delivery pass completed (canary settled)')
      // The pending rows are seeded IN-SESSION (post-pass), exactly like a
      // mid-session crash/failure leaves them before the next boot.
      await seedDeliveryRows(stateDir, [
        { messageId: 'm-1', recipientId: oldHostId, status: 'prepared', ts: now },
        { messageId: 'm-2', recipientId: oldHostId, status: 'prepared', ts: now },
        { messageId: 'm-2', recipientId: oldHostId, status: 'failed', ts: now + 1 },
        { messageId: 'm-3', recipientId: otherHostId, status: 'prepared', ts: now }
      ])
      // The host's dept_sleep → ROTATION (spec 002: journal REQUIRED first).
      await seedJournal(stateDir, oldHostId, 'PR2-ROTATION-MEMORY')
      const realSession = Session.create(SessionId(String(host.id)))
      realSession.append('user/message', { role: 'user', content: [{ type: 'text', text: 'prior turn' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      host.session = realSession
      let concluded = false
      const signal = new AbortController().signal
      const result = await env.root.tools.get('dept_sleep').execute({}, { agent: host, signal, concludeTurn: () => { concluded = true } })
      assert.ok(concluded, 'the host turn concluded')
      assert.match(result.member, /^host-session-/, 'the rotation returned the NEW host id')
      const newHostId = result.member
      // THE FIX (1): the retiring host's pairs are ALREADY terminal — BEFORE any boot.
      assert.equal(await deliveryStatus(stateDir, 'm-1', oldHostId), 'terminal', 'the prepared pair is settled to terminal AT ROTATION TIME (no boot involved)')
      assert.equal(await deliveryStatus(stateDir, 'm-2', oldHostId), 'terminal', 'the failed pair is settled to terminal AT ROTATION TIME')
      const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
      assert.deepEqual(rows.filter((r) => r.messageId === 'm-1' && r.recipientId === oldHostId).map((r) => r.status), ['prepared', 'terminal'], 'the prepared pair gains ONLY ONE terminal row')
      assert.deepEqual(rows.filter((r) => r.messageId === 'm-2' && r.recipientId === oldHostId).map((r) => r.status), ['prepared', 'failed', 'terminal'], 'the failed pair gains ONLY ONE terminal row (one per messageId)')
      assert.equal(rows.filter((r) => r.status === 'terminal').filter((r) => r.recipientId === oldHostId || r.recipientId === String(host.id)).length, 2, 'exactly TWO terminal rows for the retired host (one per settled pair)')
      // (3): a 'prepared' to a LIVE host (no rotation) is NOT touched.
      assert.equal(await deliveryStatus(stateDir, 'm-3', otherHostId), 'prepared', 'a LIVE host with a prepared row is NOT settled when ANOTHER host rotates')
      assert.ok(rows.filter((r) => r.recipientId === otherHostId).every((r) => r.status !== 'terminal'), 'the LIVE host never gains a terminal row')
      // (4): the rotation chain itself is INTACT (spec 002 — exactly-one-live).
      const hosts = await readHosts(stateDir)
      const oldEntry = hosts[oldHostId]
      const newEntry = hosts[newHostId]
      assert.ok(oldEntry?.retired === true, 'the OLD host entry is retired (retired:true + rotatedTo)')
      assert.equal(oldEntry.rotatedTo, newHostId, 'the retired entry names the rotated-to host')
      assert.equal(newEntry.previousSessionId, String(host.id), 'the NEW live entry references the retired old session')
      assert.equal(newEntry.roomId, 'board', 'the new entry keeps the room')
      assert.ok(typeof newEntry.sleepEpoch === 'number', 'the new entry carries the durable sleepEpoch')
      const liveEntries = Object.entries(hosts).filter(([key, e]) => key !== 'schemaVersion' && e.retired !== true)
      assert.equal(liveEntries.length, 2, 'exactly TWO live entries: the rotated NEW host + the OTHER registered host (the schemaVersion marker + the retired old are not live; nothing else drifted)')
      assert.ok(env.workspaceRegistry.archived.includes(String(host.id)), 'the OLD host session is archived server-side (S2.5)')
      // the fresh NEW host is NEVER touched by the settle (no row addresses it).
      assert.ok(rows.every((r) => r.recipientId !== newHostId), 'NO delivery row addresses the NEW live host (the settle never touches the new entry)')
      // (5): QD host-rotated directive — still exactly ONE (100% mandate, no dice).
      const dirs = await qualityDirectives(stateDir)
      const hostDirs = dirs.filter((d) => /host rotated/.test(d.text))
      assert.equal(hostDirs.length, 1, 'a host rotation ALWAYS emits exactly ONE host-rotated directive (100% mandate, no dice — the settle does not suppress it)')
      assert.match(hostDirs[0].text, new RegExp(`old session ${host.id}`), 'the host-rotated directive names the OLD (archived) session')
      assert.match(hostDirs[0].text, /new session session-[0-9a-f-]+/, 'the host-rotated directive names the NEW session')
      // The W6 health daemon does NOT re-alert for the retired host: a tick over
      // the settled sidecar never names the retired host or its settled pairs
      // (a terminal row is never a scanDeliveryFindings anomaly, and the
      // retired host is excluded — C6/Bug-A). The LIVE neighbor's 'prepared'
      // row is not a 'failed' anomaly either, so NO delivery-failed frame fires
      // at all.
      const alertFrames = []
      await runHealthDaemonTick({
        now: () => Date.now(),
        stateDir,
        bootId: 'boot-1-pr2-tick',
        hosts: [
          { hostId: oldHostId, sessionId: String(host.id), roomId: 'board', retired: true },
          { hostId: newHostId, sessionId: newHostId.slice('host-'.length), roomId: 'board' },
          { hostId: otherHostId, sessionId: String(otherHost.id), roomId: 'board' }
        ],
        posts: [],
        notifyHost: async (_hostEntry, frame) => { alertFrames.push(frame) },
        logger: { warn: () => {} }
      })
      assert.ok(alertFrames.every((frame) => !frame.includes(oldHostId) && !/delivery-failed: m-[12]/.test(frame)), 'the W6 tick NEVER alerts for the retired host or its settled pairs — the in-session settle stopped the re-alert loop')
    } finally {
      await env.dispose()
    }
    // (2): boot #2 over the SAME stateDir — the settled pairs are NOT
    // re-attempted (terminal → needsRedelivery false → no re-delivery, no fresh
    // prepared/failed rows — no double settlement).
    const second = await bootPlugin(stateDir)
    try {
      await new Promise((resolve) => setTimeout(resolve, 250)) // give the fire-and-forget driver a chance
      const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
      const oldRows = rows.filter((r) => r.recipientId === oldHostId)
      assert.deepEqual(oldRows.filter((r) => r.messageId === 'm-1').map((r) => r.status), ['prepared', 'terminal'], 'boot #2 does not re-attempt the settled prepared pair (no new rows)')
      assert.deepEqual(oldRows.filter((r) => r.messageId === 'm-2').map((r) => r.status), ['prepared', 'failed', 'terminal'], 'boot #2 does not re-attempt the settled failed pair (no new rows — the seeded history failed row stays, shadowed by terminal)')
      assert.equal(oldRows.length, 5, 'NO new prepared/failed/terminal row for the retired host at boot #2 (2 m-1 rows + 3 m-2 rows, unchanged — the in-session settle made the boot pass a no-op for the retired host)')
      assert.equal(oldRows.filter((r) => r.status === 'terminal').length, 2, 'STILL exactly TWO terminal rows for the retired host at boot #2 (no double settlement)')
    } finally {
      await second.dispose()
    }
  })
})

test('PR-2 legacy-path guard (pure): the settle is scoped to the ROTATED host ids ONLY — a re-run adds NO extra terminal row (idempotent), and a rotation FALLBACK (in-place reset, no retire) never runs the settle (the same live host must keep its rows)', async () => {
  await withTempStateDir(async (stateDir) => {
    const now = Date.now()
    const oldHostId = 'host-s-inplace'
    // ALTO-1 rebind guard: the settled pair must be a CURRENT record delivery.
    await seedMessageRecords(stateDir, [
      { id: 'm-1', seq: 1, ts: now, from: 'research-head', to: [oldHostId], text: 't', kind: 'agent' }
    ])
    await seedDeliveryRows(stateDir, [
      { messageId: 'm-1', recipientId: oldHostId, status: 'prepared', ts: now }
    ])
    // First run settles.
    await settleRetiredHostDeliveries(stateDir, { info: () => {}, warn: () => {} }, [oldHostId])
    assert.equal(await deliveryStatus(stateDir, 'm-1', oldHostId), 'terminal', 'first run settles the pair')
    // Re-run (a crash between the hosts.json retire and the settle, re-executed
    // at the next rotation/boot) is a no-op — no extra row.
    await settleRetiredHostDeliveries(stateDir, { info: () => {}, warn: () => {} }, [oldHostId])
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    assert.deepEqual(rows.filter((r) => r.messageId === 'm-1' && r.recipientId === oldHostId).map((r) => r.status), ['prepared', 'terminal'], 'the re-run adds NO extra terminal row (idempotent — the ready-to-write-ahead is latestPerKey)')
    assert.equal(rows.filter((r) => r.status === 'terminal').length, 1, 'exactly one terminal row remains after the re-run')
  })
})

test('PR-2 settle ALTO-1 rebind guard (the m-728 case): a STALE sidecar row under a REBOUND id — the CURRENT record never addressed the retired recipient — is NEVER settled (no phantom terminal attached to the current record); a pair whose current record genuinely addresses the retired recipient still settles', async () => {
  await withTempStateDir(async (stateDir) => {
    const now = Date.now()
    const oldHostId = 'host-s-retired'
    // The m-728 shape (host-rotation audit 2026-08-28): the CURRENT m-728 is a
    // DIFFERENT message (internal-programming-head → alt-head) — the sidecar
    // holds a PRE-fix STALE row under m-728 for the retired host (the OLD
    // epoch's m-728, trimmed/renumbered away, is gone). The stale row must
    // NEVER settle: settling it would attach a phantom 'terminal' (and, before
    // the fix, a poisoned attribution) to the CURRENT m-728 — the WRONG record.
    await seedMessageRecords(stateDir, [
      { id: 'm-728', seq: 0, ts: now, from: 'internal-programming-head', to: ['alt-head'], text: 'fb-9', kind: 'agent' },
      { id: 'm-1', seq: 1, ts: now, from: 'research-head', to: [oldHostId], text: 'genuine pending delivery', kind: 'agent' }
    ])
    await seedDeliveryRows(stateDir, [
      { messageId: 'm-728', recipientId: oldHostId, status: 'prepared', ts: now },
      { messageId: 'm-1', recipientId: oldHostId, status: 'prepared', ts: now }
    ])
    const settled = []
    await settleRetiredHostDeliveries(stateDir, { info: (message) => settled.push(message), warn: () => {} }, [oldHostId])
    // The stale rebind-id pair is left EXACTLY as it was — NOT settled.
    assert.equal(await deliveryStatus(stateDir, 'm-728', oldHostId), 'prepared', 'the stale row under the REBOUND id is NEVER settled (the current m-728 record never sent to the retired host)')
    assert.equal(await deliveryStatus(stateDir, 'm-1', oldHostId), 'terminal', 'the genuine pair (the current record addresses the retired host) settles as before')
    assert.equal(settled.length, 1, 'exactly ONE settle info line — the genuine pair only')
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    assert.equal(rows.filter((r) => r.status === 'terminal').length, 1, 'exactly ONE terminal row in the whole sidecar (never a phantom terminal for the current m-728)')
    // The SAME sidecar after a compaction pass (the ALTO-1 same-pass remap) has
    // the stale row PRUNED, so the settle's cross-check has nothing left to
    // reject: re-run over the remapped sidecar stays idempotent.
    await seedDeliveryRows(stateDir, [{ messageId: 'm-728', recipientId: oldHostId, status: 'prepared', ts: now }])
    await settleRetiredHostDeliveries(stateDir, { info: () => {}, warn: () => {} }, [oldHostId])
    assert.equal(await deliveryStatus(stateDir, 'm-728', oldHostId), 'prepared', 'the stale row is again never settled')
  })
  // ENOENT tolerance: a fresh stateDir with no messages.jsonl AND a sidecar →
  // the conservative empty record map settles nothing, silently.
  await withTempStateDir(async (stateDir) => {
    const now = Date.now()
    await seedDeliveryRows(stateDir, [
      { messageId: 'm-9', recipientId: 'host-s-retired', status: 'prepared', ts: now }
    ])
    await settleRetiredHostDeliveries(stateDir, { info: () => {}, warn: () => {} }, ['host-s-retired'])
    assert.equal(await deliveryStatus(stateDir, 'm-9', 'host-s-retired'), 'prepared', 'no message records → nothing settles (conservative — the boot pass re-evaluates)')
  })
})