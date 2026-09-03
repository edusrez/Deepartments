// dsh-deepartments — ALTO-1 / ALTO-2 acceptances (QD noise audit 2026-08-28,
// quality request m-775 parte 1; report .dsh/reports/quality/
// 2026-08-28-agent-noise-audit-messaging.md).
//
// ALTO-1 (F1 — deliveries.jsonl id-UNSAFE post-compaction) lives in
// test/messages-store.test.js (same-pass sidecar remap/prune) and
// test/rotate-settle.test.js (the m-728 rebind settle guard) — the PURE
// layers. This file owns ALTO-2 (F2 — the host-session-* ghost delivery) at
// the REAL send seam, through the real Cordis Loader with the real dsh
// services (sessions, projections, systemPrompt, tools) + the real
// SubagentRuntime, with stub agents/persistence/workspace-registry services —
// the hermetic harness shape test/rotate-settle.test.js uses (self-contained
// copy). Temp stateDirs, no network, no live DSH_HOME, no LLM. Tests run
// against the compiled lib (pnpm build first).
//
// Coverage (the mission's acceptance matrix):
//   (1) a `host-session-*` TYPO absent from hosts.json (the exact m-891 shape
//       '…ea3232b' vs the real '…ea32b') reports per-recipient FAILED at the
//       send — the sidecar transitions prepared → failed, NEVER
//       prepared → delivered (the silent-loss ghost is fixed);
//   (2) a VALID registered host-session-* id delivers NORMALLY (raw-wake, the
//       sidecar settles 'delivered') — the fix changes nothing for real hosts;
//   (3) a RETIRED-but-KNOWN host id STILL re-routes to the CURRENT live host
//       (the m-331 Issue-1 role-intent thread is intact — never failed);
//   (4) the m-380 thread: an unknown NON-host session id (no `host-` prefix)
//       still reports per-recipient failed (unchanged 'unknown' path).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { parseDeliveryRows, resolveDeliveriesPath, deliveryStatus } from '../lib/messages-store.js'
import { TOOLSET_AUDIT_FLAG_ENV } from '../lib/toolset-audit.js'

// M2.3: the hermetic suite runs with the toolset-audit channel DISABLED (a
// diagnostics-only file has no place in a temp stateDir).
process.env[TOOLSET_AUDIT_FLAG_ENV] = '0'

/** A one-department org whose head is the SENDER in every test case. */
const ORG = {
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
    }
  ]
}

// --- hermetic harness (self-contained copy of the rotate-settle.test.js shape) ---

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
      // rc.1+ session surface: the `events` getter is gone from 0.1.2-rc.1 on —
      // expose `seq` (= live log length) + `snapshotEvents()` (the full log)
      // over the SAME array so migrated readers observe test-side pushes.
      events: [],
      get seq() { return this.events.length },
      snapshotEvents() { return this.events },
      requestHeader() { return undefined }
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
      agents.store.delete(sessionId)
    }
  }
}

/** Stub agents service: satisfies the real SubagentContinuationManager + the
 * bus wake primitives (materialize/followup/raw-wake) for the send path. */
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
    this.sessionCwds?.set(String(options.sessionId), options.meta?.cwd)
    this.ensureStoreSession(options.sessionId)
    return materializeStubAgent(this, options.sessionId, options)
  }

  async resume(options) {
    this.resumeCalls.push(options)
    this.sessionCwds?.set(String(options.resumeSessionId), options.meta?.cwd)
    this.ensureStoreSession(options.resumeSessionId)
    return materializeStubAgent(this, options.resumeSessionId, options)
  }
}

/** Stub persistence: no real artifact backend is needed for the send path. */
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
    throw new Error('stub persistence: no stored session for this child')
  }

  async list() {
    return []
  }
}

/** Stub of the canonical session-archive service (dsh-workspace
 * `workspaceRegistry`): list/attach/archive enough for the boot hooks. */
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
        if (!this.entitySessions.includes(sessionId)) this.entitySessions.push(sessionId)
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
    const existing = this.entities.find((e) => e.path === path)
    if (existing !== undefined) return existing
    const entity = { path, title, sessionIds: [], attachSession: async () => {} }
    this.entities.push(entity)
    return entity
  }

  async resolveByPath(path) {
    return this.entities.find((e) => e.path === path)
  }

  async archiveSession(sessionId) {
    if (!this.archived.includes(sessionId)) this.archived.push(sessionId)
  }
}

/** A live parent agent as the registry would hold it (exact identity). */
function fakeParentAgent(id = SessionId(randomUUID())) {
  return {
    id,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    status: 'idle',
    session: { header: { id }, events: [], get seq() { return this.events.length }, snapshotEvents() { return this.events }, requestHeader() { return undefined } },
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
 * (the hermetic composition — same shape as rotate-settle.test.js). */
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
      org: opts.org ?? ORG,
      ...(opts.health !== undefined ? { health: opts.health } : {})
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
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-alto-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

// --- ALTO-2 (F2 — host-session-* ghost delivery) -----------------------------

test('ALTO-2 (m-891): a host-session-* TYPO absent from hosts.json reports per-recipient FAILED at the send (prepared → failed, NEVER prepared → delivered); a VALID registered host-session-* id delivers normally; a RETIRED-but-KNOWN host id still re-routes to the CURRENT live host (the m-331 Issue-1 thread intact); an unknown NON-host session id keeps the m-380 failed path', async () => {
  await withTempStateDir(async (stateDir) => {
    // The exact m-891 shape: the real host session ends '…ea32b'; the QH typo
    // added a '3' ('…ea3232b') and the pre-fix resolver accepted it (ghost
    // delivered). The retired entry is a REAL formerly-valid host (the m-331
    // role-intent re-route target).
    const validSession = 'session-024447d9-a255-4124-96fe-79cc392ea32b'
    const typoSession = 'session-024447d9-a255-4124-96fe-79cc392ea3232b'
    const retiredSession = 'session-5c5fc173-aaaa-bbbb-cccc-000000000000'
    const validHostId = `host-${validSession}`
    const typoHostId = `host-${typoSession}`
    const retiredHostId = `host-${retiredSession}`
    // Seed hosts.json BEFORE boot: the LIVE host + a RETIRED real host (the
    // Issue-1 re-route source). The typo is NOT in the registry.
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({
      schemaVersion: 2,
      [validHostId]: { sessionId: validSession, roomId: 'board' },
      [retiredHostId]: { sessionId: retiredSession, roomId: 'board', retired: true, retiredAt: Date.now() - 1000, rotatedTo: validHostId }
    }, null, 2))

    const env = await bootPlugin(stateDir, { health: { enabled: false } })
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 5000, 'research head materialized at boot')
      // The live host agent the valid + re-routed deliveries raw-wake.
      env.agents.put(fakeParentAgent(validSession))
      const validAgent = env.agents.store.get(validSession)
      const before = validAgent.inboxMessages.length
      const head = env.agents.store.get('head-research-head')
      const { ctx: headCtx, key } = env.agents.childContexts[0]
      const signal = new AbortController().signal

      // (1) THE TYPO (m-891): absent from hosts.json → per-recipient failed;
      //     the sidecar is prepared → failed (NEVER prepared → delivered).
      const typoResult = await headCtx.tools.get('send_message', key).execute(
        { to: [typoHostId], text: 'fb-15 closure — typo id' },
        { agent: head, signal }
      )
      assert.equal(typoResult.delivered[typoHostId], 'failed', 'a host-session-* typo NOT in hosts.json reports failed per-recipient (the m-891 ghost is fixed)')
      assert.equal(await deliveryStatus(stateDir, typoResult.messageId, typoHostId), 'failed', 'the typo pair settles failed')
      const typoRows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
        .filter((r) => r.messageId === typoResult.messageId && r.recipientId === typoHostId)
      assert.deepEqual(typoRows.map((r) => r.status), ['prepared', 'failed'], 'the typo pair transitions prepared → failed ONLY — NO delivered row (silent loss fixed)')
      assert.equal(validAgent.inboxMessages.length, before, 'the TYPO never wakes the live host (no ghost wake)')

      // (2) A VALID registered host-session-* id → normal delivery (raw-wake).
      const validResult = await headCtx.tools.get('send_message', key).execute(
        { to: [validHostId], text: 'fb-15 closure — correct id' },
        { agent: head, signal }
      )
      assert.equal(validResult.delivered[validHostId], 'delivered', 'a VALID registered host-session-* id delivers normally (the fix changes nothing for real hosts)')
      await waitFor(() => validAgent.inboxMessages.length === before + 1, 5000, 'the valid host agent was raw-woken')
      assert.equal(await deliveryStatus(stateDir, validResult.messageId, validHostId), 'delivered', 'the valid pair settles delivered')

      // (3) A RETIRED-but-KNOWN host id → the m-331 Issue-1 re-route to the
      //     CURRENT live host (delivered, NEVER failed) — thread intact.
      const retiredResult = await headCtx.tools.get('send_message', key).execute(
        { to: [retiredHostId], text: 'wake the retired host' },
        { agent: head, signal }
      )
      assert.equal(retiredResult.delivered[retiredHostId], 'delivered', 'a RETIRED-but-real host id still re-routes to the CURRENT live host (Issue-1 re-route intact — never failed)')
      await waitFor(() => validAgent.inboxMessages.length === before + 2, 5000, 'the re-routed delivery woke the live host (the role intent honored)')

      // (4) The m-380 thread: an unknown NON-host session id (no `host-` prefix
      //     — a finished subagent-child id) keeps the per-recipient failed path.
      const childGhost = '75a826f6-0000-4000-8000-000000000000'
      const ghostResult = await headCtx.tools.get('send_message', key).execute(
        { to: [childGhost], text: 'who?' },
        { agent: head, signal }
      )
      assert.equal(ghostResult.delivered[childGhost], 'failed', 'an unknown non-host session id still reports failed (the m-380 thread, unchanged)')
    } finally {
      await env.dispose()
    }
  })
})