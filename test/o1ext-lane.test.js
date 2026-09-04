// dsh-deepartments — LANE O1-EXT (2026-09-04, run token 7d6387e8): the IPH-approved
// fixes of the explore-deep O1-EXT diagnosis (reports/explore-deep/2026-09-04-
// lane-o1ext-diagnosis-862ddbe6.md) — the fb-23 dispose gate / synchronized ACK
// of the last send, the outbox-drain closure, the interrupt observability probe
// and the fb-84 explicit test, all written src-native (0 builds, 0 real APIs).
//
//   P1-1 (fb-23): a HEAD retire of a LIVE worker mid-turn applies the dispose
//       GRACE default (the old head path disposed INSTANTLY → the planned
//       memo_write became ABORTED_BEFORE_DISPATCH; journals/builder-5.md NULL).
//   P1-2 (fb-23 regression): the auto-retire on delivery keeps the grace — the
//       send tool result AND a follow-up planned memo complete before teardown.
//   P2: the post-dispose drain settles a foreign 'prepared' row that lands DURING
//       the grace (the retire-time settle already ran → only the post-dispose
//       drain can settle it in the same cycle).
//   P4: safeInterrupt records the ADDITIVE interrupt-detail entry {reason,
//       sourceKey, ts}; the numeric cooldown gate invariant is intact.
//   P5 (fb-84 — VERIFIED OPEN): the 3 repro commands are ALLOWED; the control
//       `/etc/passwd` in a real command still DENIES (real-path scope unchanged).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { deliveryStatus, parseDeliveryRows, resolveDeliveriesPath, resolveMessagesPath } from '../lib/messages-store.js'
import { readFileSync } from 'node:fs'

// The P4 harness imports the dshd-health SOURCE directly (ts-src-loader).
const H = await import('../packages/dshd-health/src/index.ts')
const { safeInterrupt, readInterruptState, INTERRUPT_COOLDOWN_KEY_PREFIX, INTERRUPT_COOLDOWN_MS } = H
// The P5 harness imports the bundle SRC directly for the pure guard.
const I = await import('../src/invoke.ts')
const { deptExecDenyReason } = I

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLE_SRC = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href

process.env.DEEPARTMENTS_QUALITY_INSPECT = '1' // the worker-retire QD dice stays DETERMINISTIC (a directive may emit)

const ORG = {
  departments: [
    {
      id: 'research',
      name: 'Research',
      coordinator: { postId: 'research-head', role: 'Research department head', provider: 'deepseek-official', agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' } }
    }
  ]
}

// --- the hermetic harness (the lane2-retire-grace-zombie shape, booting the
// bundle FROM SRC — 0 builds, 0 real APIs; temp stateDir + stub deps only) ----
const postAdoption = new Map()

function stubProvider(name) {
  const provider = {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: name === 'fork',
    prepareCalls: [],
    async start() { throw new Error(`stub provider "${name}": one-shot start is not used in these tests`) },
    async prepareContinuable(request) { provider.prepareCalls.push(request); return { seed: [] } }
  }
  return provider
}

async function materializeStubAgent(agents, sessionId, options) {
  const callerSignal = options.signal
  let callerSignalAborted = false
  callerSignal?.addEventListener('abort', () => { callerSignalAborted = true }, { once: true })
  const parentSession = options.parentSession ?? options.meta?.parentSession
  const agent = {
    id: sessionId,
    options: options.agentOptions ?? {},
    status: 'idle',
    session: {
      header: { id: sessionId, parentSession, delegationDepth: options.meta?.delegationDepth },
      events: [],
      get seq() { return this.events.length },
      snapshotEvents() { return this.events },
      requestHeader() { return undefined }
    },
    inboxMessages: [],
    ctx: undefined,
    callerSignalAborted: () => callerSignalAborted,
    followup(message) { this.inboxMessages.push(message) },
    steer() {}, inject() {}, send() {},
    cancelCalls: [],
    cancel(cause, options) { this.cancelCalls.push({ cause, options }) },
    whenIdle() { return new Promise(() => {}) }
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
  return { agent, dispose: async () => {
    agents.disposeCalls.set(sessionId, (agents.disposeCalls.get(sessionId) ?? 0) + 1)
    const gate = agents.disposeGates.get(sessionId)
    if (gate !== undefined) await gate
    agents.store.delete(sessionId)
  } }
}

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
    this.disposeGates = new Map()
    this.disposeCalls = new Map()
  }
  get(id) { return this.store.get(id) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  put(agent) { this.store.set(agent.id, agent); return agent }
  ensureStoreSession(sessionId) {
    const id = SessionId(sessionId)
    const store = this.ctx.get('sessions')
    if (store === undefined || typeof store.get !== 'function') return undefined
    const existing = store.get(id)
    if (existing !== undefined) return existing
    try { return store.create(id, {}) ?? store.get(id) } catch { return store.get(id) }
  }
  async create(options) {
    this.createCalls.push(options)
    if (this.createRejects.has(String(options.sessionId))) throw new Error('stub: forced create failure')
    this.sessionCwds?.set(String(options.sessionId), options.meta?.cwd)
    this.ensureStoreSession(options.sessionId)
    return materializeStubAgent(this, options.sessionId, options)
  }
  async resume(options) {
    this.resumeCalls.push(options)
    if (this.resumeRejects.has(options.resumeSessionId)) throw new Error('stub: forced resume failure')
    this.sessionCwds?.set(String(options.resumeSessionId), options.meta?.cwd)
    this.ensureStoreSession(options.resumeSessionId)
    return materializeStubAgent(this, options.resumeSessionId, { ...options, parentSession: postAdoption.get(options.resumeSessionId) })
  }
}

class StubPersistence extends Service {
  constructor(ctx) { super(ctx, 'sessionPersistence'); this.createCalls = []; this.appendCalls = [] }
  async create(meta) { this.createCalls.push(meta) }
  async append(id, events) { this.appendCalls.push({ id, events }) }
  async inspect(childId) {
    const parentSession = postAdoption.get(childId)
    if (parentSession === undefined) throw new Error('stub persistence: no stored session')
    return { meta: { parentSession, seedLength: 0 }, events: [{ type: 'subagent/descriptor', data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'board-post' } }] }
  }
  async list() { return [] }
}

class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir, sessionCwds) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.archived = []
    this.attachCalls = []
    this.sessionCwds = sessionCwds
    this.entitySessions = []
    this.entities = [{
      path: stateDir, title: 'root', sessionIds: this.entitySessions,
      attachSession: async (sessionId) => {
        this.attachCalls.push(sessionId)
        if (!this.entitySessions.includes(sessionId)) this.entitySessions.push(sessionId)
      }
    }]
  }
  get archivedSessionIds() { return this.archived }
  list() { return Promise.resolve(this.entities) }
  async create(path, title) {
    const existing = this.entities.find((e) => e.path === path)
    if (existing !== undefined) return existing
    const entity = { path, title, sessionIds: [], attachSession: async (sessionId) => { this.attachCalls.push(sessionId); if (!entity.sessionIds.includes(sessionId)) entity.sessionIds.push(sessionId) } }
    this.entities.push(entity)
    return entity
  }
  async resolveByPath(path) { const canonical = await realpath(path); return this.entities.find((e) => e.path === canonical) }
  async archiveSession(sessionId) { if (!this.archived.includes(sessionId)) this.archived.push(sessionId) }
}

async function bootPluginFromSrc(stateDir, opts = {}) {
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
  loader.create({ id: 'deepartments', name: BUNDLE_SRC, config: { stateDir, org: opts.org ?? ORG } })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return { root, agents, persistence, workspaceRegistry, spawnStub, forkStub, pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx, dispose: () => loaderFiber.dispose() }
}

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'o1ext-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

/** The own-layer scoped ctx + scope key of a materialized agent. */
function childContextFor(agents, sessionId) {
  const index = agents.childAgents.findIndex((agent) => agent && agent.id === sessionId)
  if (index < 0) return undefined
  return { ctx: agents.childContexts[index].ctx, key: agents.childContexts[index].key }
}

async function seedMessageRecords(stateDir, records) {
  await writeFile(resolveMessagesPath(stateDir), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

async function seedDeliveryRows(stateDir, rows) {
  await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

// ===========================================================================
// P1-1 (fb-23 — the dispose gate): a HEAD retire of a LIVE worker mid-turn.
// ===========================================================================
test('O1-EXT P1 (fb-23 dispose gate): a HEAD retire of a LIVE worker (turn in progress) does NOT dispose instantly — the AUTO_RETIRE_DISPOSE_GRACE_MS default defers the teardown, the worker\'s PLANNED dept_memo_write executes (its journal lands — the ABORTED_BEFORE_DISPATCH class is structurally gone), and the deferred dispose lands after the grace', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const head = env.agents.store.get('head-research-head')
      const headCtx = childContextFor(env.agents, 'head-research-head')
      assert.ok(headCtx, 'the head own-layer context resolves')
      const signal = new AbortController().signal
      const spawn = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'work the lane and report' }, { agent: head, signal })
      assert.ok(spawn.workerId, `the worker spawned (${spawn.workerId})`)
      await waitFor(() => env.agents.store.has(spawn.sessionId), 8000, 'the worker is live')
      const worker = env.agents.store.get(spawn.sessionId)
      const workerCtx = childContextFor(env.agents, spawn.sessionId)
      assert.ok(workerCtx, 'the worker own-layer context resolves')
      // Simulate the worker mid-turn: its CURRENT turn is in progress when the
      // head sends the retire (the fb-23 datapoint: a memo planned in the same
      // turn was ABORTED_BEFORE_DISPATCH by the instant head-path dispose).
      worker.status = 'running'
      const retire = await headCtx.ctx.tools.get('dept_worker_retire', headCtx.key).execute({ workerId: spawn.workerId }, { agent: head, signal })
      assert.equal(retire.retired, true, 'the retire marks the worker retired')
      // P1 CORE: the worker is LIVE mid-turn → the dispose is DEFERRED by the
      // grace default (the pre-fix head path disposed INSTANTLY).
      assert.equal(env.agents.disposeCalls.get(spawn.sessionId) ?? 0, 0, 'P1: a LIVE worker retire is NOT disposed instantly (the grace default applies to the head path too)')
      assert.ok(env.agents.store.has(spawn.sessionId), 'the live handle is still present during the grace (the turn can continue)')
      // The in-flight turn's PLANNED memo_write now completes (the real-harness
      // ABORTED_BEFORE_DISPATCH is impossible: the machine is still live).
      const memo = await workerCtx.ctx.tools.get('dept_memo_write', workerCtx.key).execute({ summary: 'lane-o1ext-p1-memo' }, { agent: worker, signal })
      assert.equal(memo.member, spawn.workerId, 'the memo is written AS the worker')
      assert.ok(typeof memo.memoPath === 'string' && memo.memoPath.includes('journals'), `a journal path is returned (${memo.memoPath})`)
      const journalText = await readFile(path.join(stateDir, 'journals', `${spawn.workerId}.md`), 'utf8')
      assert.ok(journalText.includes('lane-o1ext-p1-memo'), 'the journal is on disk (never ABORTED_BEFORE_DISPATCH)')
      // The deferred dispose lands within the grace window (unchanged behavior).
      await waitFor(() => (env.agents.disposeCalls.get(spawn.sessionId) ?? 0) >= 1, 8000, 'the deferred dispose runs within the grace')
      assert.ok(!env.agents.store.has(spawn.sessionId), 'the deferred dispose eventually tears the handle down')
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// P1-2 (fb-23 regression — the auto-retire-on-delivery race 34→16→3ms).
// ===========================================================================
test('O1-EXT P1 regression (the auto-retire-on-delivery race 34→16→3ms): the worker→own-head report delivery marks the auto-retire IMMEDIATELY but the grace DEFERS the dispose — the send tool result AND a follow-up planned dept_memo_write in the same turn complete (0 ABORTED_BEFORE_DISPATCH), then the deferred dispose lands', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const head = env.agents.store.get('head-research-head')
      const headCtx = childContextFor(env.agents, 'head-research-head')
      const signal = new AbortController().signal
      const spawn = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'check tracker and report' }, { agent: head, signal })
      assert.ok(spawn.workerId, `the worker spawned (${spawn.workerId})`)
      await waitFor(() => env.agents.store.has(spawn.sessionId), 8000, 'the worker is live')
      const worker = env.agents.store.get(spawn.sessionId)
      const workerCtx = childContextFor(env.agents, spawn.sessionId)
      assert.ok(workerCtx, 'the worker own-layer context resolves')
      // The WORKER sends its final report to its own head — the delivery commits
      // (markFinal 'delivered') and THEN the auto-retire marks it retired.
      const sendResult = await workerCtx.ctx.tools.get('send_message', workerCtx.key).execute({ to: ['research-head'], text: 'final report — deliverable done (O1-EXT P1-2)' }, { agent: worker, signal })
      assert.equal(sendResult.delivered['research-head'], 'delivered', 'the worker→own-head delivery is DELIVERED (one-shot)')
      const posts = JSON.parse(await readFile(path.join(stateDir, 'posts.json'), 'utf8'))
      assert.equal(posts[spawn.workerId]?.retired, true, 'the auto-retire MARK is immediate at the delivery')
      // O1 GRACE: the handle is NOT disposed right after the delivery — the
      // send tool result + a FOLLOW-UP planned tool in the same turn complete
      // before the tear-down (the 34→16→3ms AbortError race window is gone).
      assert.equal(env.agents.disposeCalls.get(spawn.sessionId) ?? 0, 0, 'O1 GRACE: the handle is NOT disposed immediately after the delivery (disposeCalls=0)')
      assert.ok(env.agents.store.has(spawn.sessionId), 'the worker handle is STILL LIVE right after the delivery (the in-flight turn continues)')
      // The SAME in-flight turn continues after its send: a memo planned in the
      // grace window completes (never ABORTED_BEFORE_DISPATCH — the dispose is
      // deferred).
      const memo = await workerCtx.ctx.tools.get('dept_memo_write', workerCtx.key).execute({ summary: 'lane-o1ext-p1-2-memo' }, { agent: worker, signal })
      assert.equal(memo.member, spawn.workerId, 'the follow-up memo is written AS the worker')
      const journalText = await readFile(path.join(stateDir, 'journals', `${spawn.workerId}.md`), 'utf8')
      assert.ok(journalText.includes('lane-o1ext-p1-2-memo'), 'the follow-up memo journal is on disk (the grace closed the race)')
      // The deferred dispose lands within the grace window.
      await waitFor(() => (env.agents.disposeCalls.get(spawn.sessionId) ?? 0) >= 1, 8000, 'the deferred dispose runs within the grace')
      assert.ok(!env.agents.store.has(spawn.sessionId), 'the deferred dispose eventually tears the handle down')
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// P2 (the outbox-drain closure): a 'prepared' row landing DURING the grace.
// ===========================================================================
test('O1-EXT P2 (outbox drain closure): a foreign \'prepared\' row keyed to the retired worker that lands DURING the dispose grace (after the retire-time settle already ran) is settled \'terminal\' by the POST-DISPOSE drain — after the retire cycle, 0 \'prepared\' rows keyed to the retired post', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const head = env.agents.store.get('head-research-head')
      const headCtx = childContextFor(env.agents, 'head-research-head')
      const signal = new AbortController().signal
      const spawn = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'work and report' }, { agent: head, signal })
      assert.ok(spawn.workerId, `the worker spawned (${spawn.workerId})`)
      await waitFor(() => env.agents.store.has(spawn.sessionId), 8000, 'the worker is live')
      const worker = env.agents.store.get(spawn.sessionId)
      const workerCtx = childContextFor(env.agents, spawn.sessionId)
      // The report delivery triggers the auto-retire (mark immediate + dispose
      // grace 5s); the retire-time settle (settleRetiredPostDeliveries) has run
      // by the time retirePost returned.
      const sendResult = await workerCtx.ctx.tools.get('send_message', workerCtx.key).execute({ to: ['research-head'], text: 'final report — O1-EXT P2' }, { agent: worker, signal })
      assert.equal(sendResult.delivered['research-head'], 'delivered', 'the report delivered')
      // A foreign in-flight delivery to the worker lands DURING the grace: the
      // write-ahead row is 'prepared' keyed to the (now retired) worker, and the
      // retire-time settle already ran before this seed — ONLY the post-dispose
      // drain (the O1-EXT closure) can settle it in the SAME cycle.
      const now = Date.now()
      await seedMessageRecords(stateDir, [
        { id: 'm-race', seq: 50, ts: now, from: 'research-head', to: [spawn.workerId], text: 'in-flight at grace expiry', kind: 'agent' }
      ])
      await seedDeliveryRows(stateDir, [
        { messageId: 'm-race', recipientId: spawn.workerId, status: 'prepared', ts: now }
      ])
      assert.equal(await deliveryStatus(stateDir, 'm-race', spawn.workerId), 'prepared', 'the race row is prepared at seed time (after the retire-time settle ran)')
      // The deferred dispose + post-dispose drain land within the grace cycle.
      await waitFor(() => (env.agents.disposeCalls.get(spawn.sessionId) ?? 0) >= 1, 8000, 'the deferred dispose runs within the grace')
      // P2 CORE: the in-flight row is terminal within ONE cycle (0 'prepared'
      // latest-status keyed to the retired post).
      assert.equal(await deliveryStatus(stateDir, 'm-race', spawn.workerId), 'terminal', 'the in-flight prepared row is settled terminal by the post-dispose drain in the SAME retire cycle')
      const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
      const latestPerKey = new Map()
      for (const row of rows) latestPerKey.set(`${row.messageId}\u0000${row.recipientId}`, row)
      const latestForWorker = [...latestPerKey.values()].filter((r) => r.recipientId === spawn.workerId)
      assert.ok(latestForWorker.every((r) => r.status !== 'prepared'), `0 'prepared' rows keyed to the retired post after the retire cycle (got ${JSON.stringify(latestForWorker.map((r) => r.status))})`)
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// P4 (the interrupt observability probe — additive, gate invariant intact).
// ===========================================================================
test('O1-EXT P4 (interrupt observability): safeInterrupt with a sourceKey records the ADDITIVE interrupt-detail:{reason,sourceKey,ts} entry in interrupt-state.json while the NUMERIC cooldown gate stays intact — a second interrupt inside INTERRUPT_COOLDOWN_MS is still blocked (and does NOT overwrite the detail), and an interrupt AFTER the cooldown updates the entry', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_000_000_000_000
    const agent = { cancelCalls: [], cancel(cause, options) { this.cancelCalls.push({ cause, options }) } }
    // First interrupt WITH the trigger source (a daemon frame key).
    const first = await safeInterrupt(agent, 'host-asst', T0, stateDir, 'post-error:quality-inspector-6:session-not-found')
    assert.equal(first, true, 'the first interrupt is allowed')
    assert.equal(agent.cancelCalls.length, 1, 'the first interrupt cancels the turn')
    // The GATE invariant is byte-intact: the numeric entry is still written and
    // read as a plain timestamp (the existing M3 test pins this shape).
    const ledger = readInterruptState(stateDir)
    assert.equal(ledger[`${INTERRUPT_COOLDOWN_KEY_PREFIX}host-asst`], T0, 'the numeric cooldown gate entry is unchanged (the gate value stays a plain ts)')
    // The ADDITIVE observability entry carries the source attribution.
    const raw = JSON.parse(await readFile(path.join(stateDir, 'interrupt-state.json'), 'utf8'))
    assert.deepEqual(raw['interrupt-detail:host-asst'], { reason: 'interrupted', sourceKey: 'post-error:quality-inspector-6:session-not-found', ts: T0 }, 'the extended entry {reason, sourceKey, ts} is recorded (the trigger source is distinguishable)')
    // The cooldown still blocks a second interrupt INSIDE the window — and the
    // blocked call does NOT overwrite the recorded detail.
    const second = await safeInterrupt(agent, 'host-asst', T0 + 60_000, stateDir, 'system-wait:research-head:m-9')
    assert.equal(second, false, 'an interrupt inside the cooldown is blocked (the ≤1/5min invariant is intact)')
    assert.equal(agent.cancelCalls.length, 1, 'the blocked interrupt does NOT cancel')
    const rawAfterBlock = JSON.parse(await readFile(path.join(stateDir, 'interrupt-state.json'), 'utf8'))
    assert.equal(rawAfterBlock['interrupt-detail:host-asst'].sourceKey, 'post-error:quality-inspector-6:session-not-found', 'a COOLDOWN-BLOCKED interrupt never overwrites the first attribution')
    // A DIFFERENT recipient is on its OWN cooldown and its detail is recorded
    // WITHOUT clobbering the first recipient's entry (the carry-forward merge).
    const other = await safeInterrupt(agent, 'head-research', T0 + 60_000, stateDir, PACING_KEY())
    assert.equal(other, true, 'a DIFFERENT recipient is not blocked by the first recipient\u2019s cooldown')
    const rawBoth = JSON.parse(await readFile(path.join(stateDir, 'interrupt-state.json'), 'utf8'))
    assert.deepEqual(rawBoth['interrupt-detail:head-research'], { reason: 'interrupted', sourceKey: 'pacing-transition', ts: T0 + 60_000 }, 'the second recipient\u2019s detail is recorded')
    assert.equal(rawBoth['interrupt-detail:host-asst'].sourceKey, 'post-error:quality-inspector-6:session-not-found', 'the FIRST recipient\u2019s detail survives a later recipient\u2019s write')
    // AFTER the cooldown lapses the same recipient interrupts again and the
    // detail entry is updated (bounded, not permanent).
    const third = await safeInterrupt(agent, 'host-asst', T0 + INTERRUPT_COOLDOWN_MS + 1, stateDir, 'capacity-gate:critical')
    assert.equal(third, true, 'an interrupt after the cooldown lapses is allowed (bounded, not permanent)')
    assert.equal(agent.cancelCalls.length, 3, 'the post-cooldown interrupt cancels again')
    const rawAfterCooldown = JSON.parse(await readFile(path.join(stateDir, 'interrupt-state.json'), 'utf8'))
    assert.deepEqual(rawAfterCooldown['interrupt-detail:host-asst'], { reason: 'interrupted', sourceKey: 'capacity-gate:critical', ts: T0 + INTERRUPT_COOLDOWN_MS + 1 }, 'the post-cooldown interrupt updates the attribution (and the aged-out prior detail is pruned with the gate bound)')
    const ledgerFinal = readInterruptState(stateDir)
    assert.equal(ledgerFinal[`${INTERRUPT_COOLDOWN_KEY_PREFIX}host-asst`], T0 + INTERRUPT_COOLDOWN_MS + 1, 'the numeric gate entry tracks the LAST interrupt (never an object)')
  })
})

function PACING_KEY() {
  // The pacing-transition dedupe key (dshd-health PACING_TRANSITION_KEY — not
  // imported here to keep the test surface minimal; the string is pinned by the
  // dshd-health pacing tests).
  return 'pacing-transition'
}

// ===========================================================================
// P5 (fb-84 — VERIFIED OPEN by the diagnosis; the explicit QD-committed test).
// ===========================================================================
test('O1-EXT P5 (fb-84 — VERIFIED OPEN): the dept_exec guard ALLOWS the three repro commands — the ORIGINAL `grep -n \'health\\|probe\\|/models\\|usage\' README.md` (DENIED "/models\\" pre-fix), the flat `grep -n \'/models\' README.md` (DENIED pre-fix) and the piped `grep -n \'/models\' README.md | head -5` — while the CONTROL `grep -n \'/etc/passwd\'` OUTSIDE a root STILL DENIES (the real-path scope is NOT opened)', async () => {
  const roots = ['/home/esuarez/projects', '/usr/lib/node_modules/@deepseek-ai/dsh', '/srv/dept-ws', '/opt/dsh/.dsh-dev']
  // (1) THE ORIGINAL fb-84 command (the single-quoted grep ERE with escaped
  // pipes — the trailing-`\` token `/models\` was DENIED pre-fix).
  assert.equal(
    deptExecDenyReason("grep -n 'health\\|probe\\|/models\\|usage' README.md", '/srv/dept-ws', roots),
    undefined,
    'the fb-84 ORIGINAL command is ALLOWED (the `/models\\` token is a regex-literal fragment, not a path)'
  )
  // (2) The FLAT quoted `/models` form (the second fb-84 repro — DENIED pre-fix).
  assert.equal(
    deptExecDenyReason("grep -n '/models' README.md", '/srv/dept-ws', roots),
    undefined,
    'the flat `/models` in single quotes is a grep PATTERN (a regex literal), not a path'
  )
  // (3) The piped form with a real operand after the pipe.
  assert.equal(
    deptExecDenyReason("grep -n '/models' README.md | head -5", '/srv/dept-ws', roots),
    undefined,
    'the piped grep pattern is allowed (the pattern is still a regex literal)'
  )
  // (4) CONTROL — `/etc/passwd` in a REAL command (even inside a grep pattern)
  // is a MULTI-SEGMENT real path: STILL DENIED (the fix must NOT open the scope
  // of real paths).
  assert.match(
    deptExecDenyReason("grep -n '/etc/passwd' README.md", '/srv/dept-ws', roots),
    /references absolute path "\/etc\/passwd"/,
    'the control `grep -n \'/etc/passwd\'` OUTSIDE a root STILL DENIES — a real path reference is never a regex literal'
  )
  // (5) REGRESSION CONTROLS of the SAME family (fb-32/fb-106 + real paths):
  assert.equal(deptExecDenyReason("sed -n '/hasEarlierPendingPair/,/^ok/p' src/x.ts", '/srv/dept-ws', roots), undefined, 'the fb-106 sed-range extraction is still allowed')
  assert.equal(deptExecDenyReason("awk '$0 ~ /error/' file", '/srv/dept-ws', roots), undefined, 'the awk ~ regex operand is still allowed')
  assert.equal(deptExecDenyReason('echo /*', '/srv/dept-ws', roots), undefined, 'the bare glob /* is still allowed')
  assert.match(deptExecDenyReason('cat /etc/passwd', '/srv/dept-ws', roots), /references absolute path "\/etc\/passwd"/, 'a real out-of-root path is STILL denied (no scope opening)')
  assert.equal(deptExecDenyReason('cat /home/esuarez/projects/README.md', '/srv/dept-ws', roots), undefined, 'a real IN-ROOT path is still allowed')
})

// ===========================================================================
// P6 (fb-129 — QD 2026-09-04, the fb-123 family residue): the «$D» case of
// the guard FP family. The three QD probes — `"$D"/test/*`, `"$D"/src/*.ts`
// and the residual `sed -n '/pat/,$p'` — are ALLOWED: a `/…` token glued
// after a CLOSING quote whose span is a pure `$VAR` reference is the tail of
// a VARIABLE-ROOTED quoted word (statically unverifiable — never a literal
// absolute path; the bare `$D/…` form was never tokenized), and a sed range
// whose SECOND address is the END-OF-FILE `$` (`/…/,$p` — the `,…,$` suffix
// is a last-line address, not a path) joins the two-sided-range regex
// literals. The REAL-path scope stays CLOSED: `/etc/passwd` still denies
// bare, quoted-pattern and as a real sed operand; a LITERAL quoted root with
// a glued tail (`"/etc"/passwd`) is NOT a variable and still denies; a SPACE
// between the quote and the `/`-word breaks the glue (the word is standalone
// and still denies).
// ===========================================================================
test('O1-EXT P6 (fb-129 — the «$D» case of the guard FP family): the three QD probes `"$D"/test/*`, `"$D"/src/*.ts` and the residual `sed -n \'/pat/,$p\'` are ALLOWED (variable-rooted quoted word + sed END-OF-FILE `$` address) while the real-path scope stays CLOSED — `/etc/passwd` STILL denies (bare, quoted-pattern, real sed operand), a literal quoted root with a glued tail STILL denies, and the P5/fb-32/fb-106 family regressions stay green', () => {
  const roots = ['/home/esuarez/projects', '/usr/lib/node_modules/@deepseek-ai/dsh', '/srv/dept-ws', '/opt/dsh/.dsh-dev']
  // (1) THE THREE fb-129 QD probes (bare shapes + the fb-123 operational form).
  assert.equal(deptExecDenyReason('"$D"/test/*', '/srv/dept-ws', roots), undefined, 'QD probe 1: `"$D"/test/*` is a VARIABLE-ROOTED quoted word (the `/test/*` is the tail of `"$D"`, not a literal absolute path)')
  assert.equal(deptExecDenyReason('"$D"/src/*.ts', '/srv/dept-ws', roots), undefined, 'QD probe 2: `"$D"/src/*.ts` is allowed (same variable-rooted shape)')
  assert.equal(deptExecDenyReason("sed -n '/pat/,$p'", '/srv/dept-ws', roots), undefined, 'QD probe 3: `sed -n \'/pat/,$p\'` — the `,…,$` suffix is the sed END-OF-FILE address, not a path')
  assert.equal(deptExecDenyReason("sed -n \"/pat/,$p\" src/x.ts", '/srv/dept-ws', roots), undefined, 'the double-quote variant of the sed end-address form is allowed too')
  assert.equal(deptExecDenyReason("sed -n '/m-[0-9]\\+/,$p' src/x.ts", '/srv/dept-ws', roots), undefined, 'the `m-\\d+` regex body + `$` end-address stays allowed (P5 backslash-escape shape)')
  assert.equal(deptExecDenyReason('ls -dt "$D"/head-internal-programming-head-*', '/srv/dept-ws', roots), undefined, 'the fb-123 ORIGINAL `ls -dt "$D"/head-…*` is allowed (the recorded case this family closes)')
  // (2) CONTROLS — the real-path scope is NOT opened.
  assert.match(deptExecDenyReason('cat /etc/passwd', '/srv/dept-ws', roots), /references absolute path "\/etc\/passwd"/, 'a real out-of-root path STILL denies')
  assert.match(deptExecDenyReason("grep -n '/etc/passwd' README.md", '/srv/dept-ws', roots), /references absolute path "\/etc\/passwd"/, 'a MULTI-SEGMENT quoted pattern is a REAL path reference — still denied')
  assert.match(deptExecDenyReason("sed -n '/pat/,$p' /etc/passwd", '/srv/dept-ws', roots), /references absolute path "\/etc\/passwd"/, 'the sed end-address range is skipped but the REAL file operand is its OWN token — still denied')
  assert.match(deptExecDenyReason('cat "/etc"/passwd', '/srv/dept-ws', roots), /references absolute path "\/etc"/, 'a LITERAL quoted root with a glued tail is NOT a variable — /etc stays a path word and denies')
  assert.match(deptExecDenyReason('echo "$D" /test/*', '/srv/dept-ws', roots), /references absolute path "\/test\/\*"/, 'a SPACE between the quote and the /-word breaks the glue — the word is standalone and still denies')
  assert.equal(deptExecDenyReason('cat /home/esuarez/projects/README.md', '/srv/dept-ws', roots), undefined, 'a real IN-ROOT path is still allowed')
  // (3) FAMILY REGRESSIONS (P5/fb-84 + fb-32/fb-106 remain green).
  assert.equal(deptExecDenyReason("grep -n 'health\\|probe\\|/models\\|usage' README.md", '/srv/dept-ws', roots), undefined, 'the fb-84 ORIGINAL command is still allowed')
  assert.equal(deptExecDenyReason("grep -n '/models' README.md | head -5", '/srv/dept-ws', roots), undefined, 'the fb-84 piped form is still allowed')
  assert.equal(deptExecDenyReason("sed -n '/hasEarlierPendingPair/,/^ok/p' src/x.ts", '/srv/dept-ws', roots), undefined, 'the fb-106 sed-range extraction is still allowed')
  assert.equal(deptExecDenyReason("awk '$0 ~ /error/' file", '/srv/dept-ws', roots), undefined, 'the awk ~ regex operand is still allowed')
  assert.equal(deptExecDenyReason('echo /*', '/srv/dept-ws', roots), undefined, 'the bare glob /* is still allowed')
})