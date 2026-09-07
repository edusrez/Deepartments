// dsh-deepartments — BATCH-DRAIN DE MENSAJES ceremonia (2026-09-07, VALLE 09-07,
// run token d9cc05ce): the drain-on-settle puro implementation (PROGRAMMING
// REQUEST 1662eecf — the delivery to a RUNNING recipient accumulates its queue;
// at the SETTLE (running→idle) the wake successor receives ALL pending messages
// in ONE followup, seq order, instead of 1 message → 1 turn) + the C2 noWake→
// retired fix (a noWake delivery to a RETIRED host-family address is NEVER
// 'prepared' — 'failed' to the sender; m-2523 class).
//
// §HOST POR DISEÑO (the host case, explore-49 verdict — OWNER-APPROVED, 09-07):
// the Asistente is a spec-002 resident with a PERMANENT sleepEpoch (dormant
// between turns; the D4 resume wakes it). The batch-drain appends to the host
// EXACTLY LIKE a post and only MID-TURN: while the host's LIVE session is
// RUNNING, batch-eligible sends accumulate and drain in ONE delta at the
// settle (the tool-level HOST test below pins it); a DORMANT host (no live
// handle) is NEVER accumulated — the first message resumes it and delivers 1:1
// as today. The native host lib engages only at the host RESTART in a clean
// window (the spec-002 rotation), so the host is never batch-reassembled
// across a restart — «solo coalesce mid-turn» is the documented + tested host
// contract (documented here + in the tool-level HOST test; delivery semantics
// untouched — no redesign, the drain-on-settle spec applies to posts unchanged).
//
// Method (LANE ② src-native, the wake-seam-mitigation pattern): register the
// ts-src-loader + import the SOURCE directly; the engine-level cases use
// createDeliveryEngine directly (deterministic, no harness); the tool-level
// cases use the composed harness (bootPluginFromSrc — Loader + StubAgents +
// the real bundle src; temp stateDir; DEEPARTMENTS_QUALITY_INSPECT=1; NO red,
// NO electron). The settle is emitted through the shared cordis events service
// (`pluginCtx().emit('agent/status', { status: 'idle', agent })` — the SAME
// fused payload shape the real dsh-agent-loop setPhase dispatches).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

// The src modules (ts-src-loader — the ts-loader hook targets repo-.ts importers).
const D = await import('../packages/dshd-core/src/delivery.ts')
const { createDeliveryEngine } = D
const C = await import('../packages/dshd-core/src/messages.ts')
const { resolveDeliveriesPath, resolveMessagesPath, parseDeliveryRows, deliveryStatus } = C

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLE_SRC = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href

process.env.DEEPARTMENTS_QUALITY_INSPECT = '1' // the worker-retire QD dice stays DETERMINISTIC

const T0 = 1_700_000_000_000

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'batch-drain-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

async function writeDeliveries(stateDir, rows) {
  await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

function row(messageId, recipientId, status, ts, noWake) {
  return noWake === true ? { messageId, recipientId, status, ts, noWake } : { messageId, recipientId, status, ts }
}

async function latestRowStatuses(stateDir) {
  const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
  const latest = new Map()
  for (const r of rows) latest.set(`${r.messageId}\u0000${r.recipientId}`, r.status)
  return latest
}

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// ---------------------------------------------------------------------------
// ENGINE-LEVEL — the gate-skip, the noWake/ack invariance and the C2 reroute
// fix (deterministic, no harness).
// ---------------------------------------------------------------------------

/** ONE delivery-engine stub with an ALWAYS-gating earlier pair
 * (`pendingEarlierSeq` resolves true — the batch gate-skip condition) and the
 * running-liveness probe injectable per case. */
function buildEngine({ recipientRunningLive, deliverPostImpl } = {}) {
  const calls = { deliverPost: 0, finals: [], reasons: [] }
  const engine = createDeliveryEngine({
    stateDir: '/tmp/batch-drain-unused',
    logger: { info() {}, warn() {} },
    markPrepared: async () => {},
    markFinal: async (record, recipientId, status) => calls.finals.push({ id: record.id, recipientId, status }),
    resolveChild: async () => false,
    deliverChild: async () => 'delivered',
    resolveCatalogRoute: () => ({ kind: 'post', entry: { postId: 'rx', sessionId: 's-rx', roomId: 'r' } }),
    busProfileFor: () => ({ kind: 'host', memberId: 'the-host' }),
    deliverPost: async () => {
      calls.deliverPost++
      if (deliverPostImpl !== undefined) return deliverPostImpl()
      return 'resumed'
    },
    deliverHost: async () => { calls.deliverPost++; return 'resumed' },
    pendingEarlierSeq: async () => true, // an earlier 'prepared' head pair EXISTS (the gate condition)
    ...(recipientRunningLive !== undefined ? { recipientRunningLive } : {})
  })
  return { engine, calls }
}

function record(id, seq, over = {}) {
  return { id, seq, ts: T0, from: 'the-host', to: ['rx'], text: `batch probe ${seq}`, kind: 'agent', ...over }
}

test('VALLE 09-07 (engine): a batch-eligible ALWAYS-WAKE to a CURRENTLY RUNNING recipient SKIPS the fb-117 gate — the wake primitive fires (the batch surface accumulates there); a running recipient WITHOUT batchEligible, a NON-running recipient and an ABSENT probe keep the gate (fb-117 intact, safe default)', async () => {
  // (a) running + batchEligible → the gate is SKIPPED (deliverPost — the
  // accumulation seam — receives the record).
  const a = buildEngine({ recipientRunningLive: () => true })
  let reasonA
  const statusA = await a.engine.deliverOrQueue('rx', record('m-1', 1), { callerAgentId: 'the-host', senderSessionId: 'the-host', batchEligible: true, gateReason: (r, bySeq) => { reasonA = r; void bySeq } })
  assert.equal(statusA, 'resumed', 'a: the batch-eligible ALWAYS-WAKE to the RUNNING recipient proceeds to the wake primitive (never the fifo-gated retention)')
  assert.equal(a.calls.deliverPost, 1, 'a: the wake primitive fires exactly once (the batch accumulates there)')
  assert.equal(reasonA, undefined, 'a: the FIFO queue-class observer NEVER fires (the gate was skipped)')
  // (b) running WITHOUT batchEligible → the gate applies (fb-117 intact).
  const b = buildEngine({ recipientRunningLive: () => true })
  let reasonB
  const statusB = await b.engine.deliverOrQueue('rx', record('m-2', 2), { callerAgentId: 'the-host', senderSessionId: 'the-host', gateReason: (r) => { reasonB = r } })
  assert.equal(statusB, 'prepared', 'b: a running recipient WITHOUT batchEligible is still gated behind the earlier prepared head (fb-117 intact)')
  assert.equal(reasonB, 'fifo', 'b: the fifo queue class reports (the pre-batch gate behavior)')
  assert.equal(b.calls.deliverPost, 0, 'b: the wake primitive is NEVER called for the non-batch gated case')
  // (c) batchEligible but NOT running → the gate applies (batchEligible alone
  // never un-gates — a non-running recipient keeps the pre-batch semantics).
  const c = buildEngine({ recipientRunningLive: () => false })
  const statusC = await c.engine.deliverOrQueue('rx', record('m-3', 3), { callerAgentId: 'the-host', senderSessionId: 'the-host', batchEligible: true })
  assert.equal(statusC, 'prepared', 'c: batchEligible to a NON-running recipient keeps the fifo gate (the batch only applies to a currently-running turn)')
  assert.equal(c.calls.deliverPost, 0, 'c: the wake primitive is NEVER called (gated)')
  // (d) probe ABSENT → the gate applies (the safe default — zero regression
  // for a composition that does not resolve running-liveness).
  const d = buildEngine({})
  const statusD = await d.engine.deliverOrQueue('rx', record('m-4', 4), { callerAgentId: 'the-host', senderSessionId: 'the-host', batchEligible: true })
  assert.equal(statusD, 'prepared', 'd: WITHOUT the recipientRunningLive dep the gate applies (the safe default)')
  assert.equal(d.calls.deliverPost, 0, 'd: the wake primitive is NEVER called (pre-batch)')
  // (e) THROWING probe → the gate applies (conservative — running-status is
  // never assumed on an error).
  const e = buildEngine({ recipientRunningLive: () => { throw new Error('liveness read failed') } })
  const statusE = await e.engine.deliverOrQueue('rx', record('m-5', 5), { callerAgentId: 'the-host', senderSessionId: 'the-host', batchEligible: true })
  assert.equal(statusE, 'prepared', 'e: a throwing running-liveness probe degrades to the gate APPLIED (conservative)')
  assert.equal(e.calls.deliverPost, 0, 'e: the wake primitive is NEVER called (the gate stayed)')
})

test('VALLE 09-07 (engine): noWake/ack wake-seam INTACT under batchEligible — a WIRED noWake send (even with batchEligible set, and even to a RUNNING recipient) returns \'prepared (noWake)\' with ZERO wake; it NEVER accumulates (the batch surface never sees it — the route is cut before the ALWAYS-WAKE)', async () => {
  const { engine, calls } = buildEngine({ recipientRunningLive: () => true })
  let reason
  const status = await engine.deliverOrQueue('rx', record('m-6', 6), {
    callerAgentId: 'the-host',
    senderSessionId: 'the-host',
    noWake: true,
    batchEligible: true, // a buggy caller could set both — the noWake ORDER must win
    gateReason: (r) => { reason = r }
  })
  assert.equal(status, 'prepared', 'noWake: the WIRED noWake send returns prepared (the no-wake-until-wake order never wakes, never batches)')
  assert.equal(reason, 'noWake', 'noWake: the queue-class observer reports the noWake class (never the fifo class)')
  assert.equal(calls.deliverPost, 0, 'noWake: the wake primitive (and thus the batch accumulator) is NEVER reached — the noWake route is cut before the ALWAYS-WAKE branch')
  assert.deepEqual(calls.finals.map((f) => f.status), ['prepared'], 'noWake: the pair finalizes ONE prepared row (the no-wake-until-wake write-ahead)')
})

test('VALLE 09-07 (C2 — the m-2523 class): a WIRED noWake delivery whose CATALOG route is \'reroute\' (a RETIRED host-family address with a live successor) is NEVER \'prepared\' — it FAILS to the sender (\'failed\', the sidebar row transitions), so no noWake row ever parks forever for a never-live recipient; the CONTROL (a noWake to a non-retired host) stays \'prepared\' (the no-wake-until-wake contract intact)', async () => {
  // (a) reroute → 'failed' (the acceptance: «noWake a recipient no-live NO
  // queda \'prepared\' para siempre» — the fail branch; the record stays
  // durable, the sender re-addresses to the live successor).
  const a = buildEngine({ recipientRunningLive: () => false })
  const engineA = createDeliveryEngine({
    stateDir: '/tmp/batch-drain-unused',
    logger: { info() {}, warn() {} },
    markPrepared: async () => {},
    markFinal: async (record, recipientId, status) => a.calls.finals.push({ id: record.id, recipientId, status }),
    resolveChild: async () => false,
    deliverChild: async () => 'delivered',
    resolveCatalogRoute: () => ({ kind: 'reroute', entry: { hostId: 'host-LIVE-SUCCESSOR', sessionId: 's-live', roomId: 'board' } }),
    busProfileFor: () => ({ kind: 'host', memberId: 'the-host' }),
    deliverPost: async () => { a.calls.deliverPost++; return 'delivered' },
    deliverHost: async () => { a.calls.deliverPost++; return 'delivered' }
  })
  let reasonA
  const statusA = await engineA.deliverOrQueue('host-session-RETIRED', record('m-7', 7, { to: ['host-session-RETIRED'] }), { callerAgentId: 'the-host', senderSessionId: 'the-host', noWake: true, gateReason: (r) => { reasonA = r } })
  assert.equal(statusA, 'failed', 'C2-a: the WIRED noWake to the RETIRED host-family address FAILS (never \'prepared\' — the addressed recipient can never wake)')
  assert.equal(reasonA, 'noWake', 'C2-a: the queue-class observer reports the noWake class (the failure is the noWake branch\'s own outcome)')
  assert.equal(a.calls.deliverPost, 0, 'C2-a: the wake primitive is NEVER touched (a noWake to a dead address neither wakes nor materializes the successor)')
  assert.deepEqual(a.calls.finals, [{ id: 'm-7', recipientId: 'host-session-RETIRED', status: 'failed' }], 'C2-a: the pair finalizes ONE failed row — never a stuck \'prepared\' (the P2/B3 guards of the re-drive would hold a noWake \'prepared\' for a never-live recipient forever)')
  // (b) CONTROL — a noWake to a NON-retired host (kind \'host\') stays
  // 'prepared' (it will wake — the no-wake-until-wake contract intact).
  const b = buildEngine({ recipientRunningLive: () => false })
  const engineB = createDeliveryEngine({
    stateDir: '/tmp/batch-drain-unused',
    logger: { info() {}, warn() {} },
    markPrepared: async () => {},
    markFinal: async (record, recipientId, status) => b.calls.finals.push({ id: record.id, recipientId, status }),
    resolveChild: async () => false,
    deliverChild: async () => 'delivered',
    resolveCatalogRoute: () => ({ kind: 'host', entry: { hostId: 'host-LIVE', sessionId: 's-live', roomId: 'board', sleepEpoch: T0 } }),
    busProfileFor: () => ({ kind: 'host', memberId: 'the-host' }),
    deliverPost: async () => { b.calls.deliverPost++; return 'delivered' },
    deliverHost: async () => { b.calls.deliverPost++; return 'delivered' }
  })
  const statusB = await engineB.deliverOrQueue('host-LIVE', record('m-8', 8, { to: ['host-LIVE'] }), { callerAgentId: 'the-host', senderSessionId: 'the-host', noWake: true })
  assert.equal(statusB, 'prepared', 'C2-b: a noWake to a NON-retired host (permanent sleepEpoch — the live successor) stays prepared — it drains at the successor\'s next real wake')
  assert.equal(b.calls.deliverPost, 0, 'C2-b: the wake primitive is NEVER touched')
})

test('VALLE 09-07 (engine): the child route is NEVER batched — a batch-eligible send to a continuable CHILD (resolveChild=true) delivers natively (deliverChild), the catalog/batch surface is never reached', async () => {
  const calls = { child: 0, post: 0 }
  const engine = createDeliveryEngine({
    stateDir: '/tmp/batch-drain-unused',
    logger: { info() {}, warn() {} },
    markPrepared: async () => {},
    markFinal: async () => {},
    subagents: {}, // the child route is consultable
    resolveChild: async () => true,
    deliverChild: async () => { calls.child++; return 'delivered' },
    resolveCatalogRoute: () => ({ kind: 'post', entry: { postId: 'rx', sessionId: 's-rx', roomId: 'r' } }),
    busProfileFor: () => ({ kind: 'host', memberId: 'the-host' }),
    deliverPost: async () => { calls.post++; return 'delivered' },
    deliverHost: async () => { calls.post++; return 'delivered' },
    recipientRunningLive: () => true
  })
  const status = await engine.deliverOrQueue('child-x', record('m-9', 9, { to: ['child-x'] }), { callerAgentId: 'the-host', senderSessionId: 'the-host', batchEligible: true })
  assert.equal(status, 'delivered', 'child: the continuable child is delivered natively (delivered)')
  assert.equal(calls.child, 1, 'child: deliverChild fires exactly once (the child route runs BEFORE the catalog — the batch flag is never consulted)')
  assert.equal(calls.post, 0, 'child: the catalog/wake path (and thus the batch accumulator) is never reached')
})

// ---------------------------------------------------------------------------
// TOOL-LEVEL — the composed bundle (stub agents + the real src): the drain-on-
// settle accumulation + the ONE-delta flush at the settle event.
// ---------------------------------------------------------------------------
const ORG = {
  departments: [
    {
      id: 'research',
      name: 'Research',
      coordinator: { postId: 'research-head', role: 'Research department head', provider: 'deepseek-official', agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' } }
    }
  ]
}

function stubProvider(name) {
  return {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: name === 'fork',
    async start() { throw new Error('stub provider: one-shot start is not used') },
    async prepareContinuable() { return { seed: [] } }
  }
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
  const childKey = Symbol('batch-drain-stub-child-scope')
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
    agents.store.delete(sessionId)
  } }
}

class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.childContexts = []
    this.childAgents = []
    this.scopeAnchor = ctx
    this.disposeCalls = new Map()
    this.createCalls = []
    this.resumeCalls = []
  }
  get(id) { return this.store.get(id) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  async create(options) {
    this.createCalls.push(options)
    return materializeStubAgent(this, options.sessionId, options)
  }
  async resume(options) {
    this.resumeCalls.push(options)
    return materializeStubAgent(this, options.resumeSessionId, { ...options, parentSession: undefined })
  }
}

class StubPersistence extends Service {
  constructor(ctx) { super(ctx, 'sessionPersistence') }
  async readRaw() { return undefined }
}

class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.archived = []
  }
  get archivedSessionIds() { return this.archived }
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
  const agents = new StubAgents(root)
  const persistence = new StubPersistence(root)
  const workspaceRegistry = new StubWorkspaceRegistry(root, stateDir)
  await root.plugin(SubagentRuntime)
  root.subagents.registerProvider(stubProvider('spawn'))
  root.subagents.registerProvider(stubProvider('fork'))
  loader.create({ id: 'deepartments', name: BUNDLE_SRC, config: { stateDir, org: opts.org ?? ORG, ...(opts.config ?? {}) } })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return { root, agents, persistence, workspaceRegistry, pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx, dispose: () => loaderFiber.dispose() }
}

function childContextFor(agents, sessionId) {
  const index = agents.childAgents.findIndex((agent) => agent && agent.id === sessionId)
  if (index < 0) return undefined
  return { ctx: agents.childContexts[index].ctx, key: agents.childContexts[index].key }
}

async function withBootedOrg(fn) {
  return withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const head = env.agents.store.get('head-research-head')
      const headCtx = childContextFor(env.agents, 'head-research-head')
      assert.ok(headCtx, 'the head own-layer context resolves')
      const signal = new AbortController().signal
      const spawn = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'batch-drain test worker' }, { agent: head, signal })
      assert.ok(spawn.workerId, 'the worker spawned')
      await waitFor(() => env.agents.store.has(spawn.sessionId), 8000, 'the worker is live')
      return await fn({ stateDir, env, head, headCtx, spawn, signal })
    } finally {
      await env.dispose()
    }
  })
}

test('VALLE 09-07 (tool): N messages during a RUNNING turn → ONE followup at the SETTLE with all N frames in seq order; rows \'prepared\' until the flush, then \'delivered\'; the per-send result names the batch class', async () => {
  await withBootedOrg(async ({ stateDir, env, head, headCtx, spawn, signal }) => {
    const workerId = spawn.workerId
    const send = (text) => headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: [workerId], text }, { agent: head, signal })
    const worker = env.agents.get(spawn.sessionId)
    const baseline = worker.inboxMessages.length
    // Make the worker CURRENTLY RUNNING (mid-turn — the batch condition).
    worker.status = 'running'
    // 3 always-wake sends while the turn is in flight.
    const r1 = await send('batch probe one')
    const r2 = await send('batch probe two')
    const r3 = await send('batch probe three')
    assert.equal(r1.delivered[workerId], 'prepared (batch-until-settle)', 't1: the first run send reports the batch class (prepared until the settle)')
    assert.equal(r2.delivered[workerId], 'prepared (batch-until-settle)', 't1: the SECOND run send also accumulates — the FIFO gate is SKIPPED for the running recipient (the earlier prepared head would have gated it pre-batch)')
    assert.equal(r3.delivered[workerId], 'prepared (batch-until-settle)', 't1: the THIRD run send accumulates')
    assert.equal(worker.inboxMessages.length, baseline, 't1: NOTHING spliced into the live inbox while running (the batch waits for the settle)')
    let latest = await latestRowStatuses(stateDir)
    assert.equal(latest.get(`${r1.messageId}\u0000${workerId}`), 'prepared', 't1: the rows stay \'prepared\' (write-ahead — crash-safe until the flush)')
    assert.equal(latest.get(`${r2.messageId}\u0000${workerId}`), 'prepared', 't1: the second row is prepared too')
    assert.equal(latest.get(`${r3.messageId}\u0000${workerId}`), 'prepared', 't1: the third row is prepared too')
    // The SETTLE — the running→idle agent/status event (the same fused payload
    // the real dsh-agent-loop setPhase dispatches).
    env.pluginCtx().emit('agent/status', { status: 'idle', agent: worker })
    await waitFor(async () => {
      const ls = await latestRowStatuses(stateDir)
      return ls.get(`${r3.messageId}\u0000${workerId}`) === 'delivered'
    }, 8000, 'the settle flush marks the batch delivered')
    await waitFor(() => worker.inboxMessages.length === baseline + 1, 8000, 'the settle flush splices EXACTLY ONE delta followup')
    assert.equal(worker.inboxMessages.length, baseline + 1, 't1: ONE followup for the 3 messages (1 turn, N messages — the delta multi-mensaje)')
    const delta = worker.inboxMessages[worker.inboxMessages.length - 1]
    const text = delta.content[0].text
    assert.equal(text.includes('[From research-head → ' + workerId + ']: batch probe one'), true, 't1: the delta carries the FIRST frame')
    assert.equal(text.indexOf('batch probe one') < text.indexOf('batch probe two') && text.indexOf('batch probe two') < text.indexOf('batch probe three'), true, 't1: the frames travel in SEQ order (arrival order preserved in the single turn)')
    assert.equal(text.includes('batch probe three'), true, 't1: the delta carries the LAST frame')
    assert.equal(delta.source.batch, true, 't1: the delta source carries the batch marker')
    assert.deepEqual(delta.source.messageIds, [r1.messageId, r2.messageId, r3.messageId], 't1: the delta source lists ALL the message ids (the recipient can track the records)')
    latest = await latestRowStatuses(stateDir)
    assert.equal(latest.get(`${r1.messageId}\u0000${workerId}`), 'delivered', 't1: the rows end \'delivered\' after the flush')
    assert.equal(latest.get(`${r2.messageId}\u0000${workerId}`), 'delivered', 't1: all three rows end delivered')
    assert.equal(latest.get(`${r3.messageId}\u0000${workerId}`), 'delivered', 't1: all three rows end delivered')
  })
})

test('VALLE 09-07 (tool): an INTERRUPT PREEMPTS and its wake brings [interruptor, ...pendientes] in ONE delta (the W9-b cancel runs with keepInbox; nothing accumulates behind a long turn)', async () => {
  await withBootedOrg(async ({ stateDir, env, head, headCtx, spawn, signal }) => {
    const workerId = spawn.workerId
    const send = (text, extra = {}) => headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: [workerId], text, ...extra }, { agent: head, signal })
    const worker = env.agents.get(spawn.sessionId)
    const baseline = worker.inboxMessages.length
    worker.status = 'running'
    const r1 = await send('pending one')
    const r2 = await send('pending two')
    assert.equal(r1.delivered[workerId], 'prepared (batch-until-settle)', 't2: the first pending send accumulates')
    assert.equal(r2.delivered[workerId], 'prepared (batch-until-settle)', 't2: the second pending send accumulates')
    // The W9-b interrupt delivery (never batchEligible — the tools gate it off).
    const ir = await send('INTERRUPTOR', { interrupt: true })
    assert.equal(ir.delivered[workerId], 'delivered', 't2: the interrupt delivery reports delivered (the flush is immediate — the wake path)')
    assert.ok(worker.cancelCalls.length >= 1, 't2: the current turn was aborted (W9-b cancel)')
    assert.equal(worker.cancelCalls[worker.cancelCalls.length - 1].options.keepInbox, true, 't2: the abort preserved the inbox (keepInbox — the W9-b seam)')
    await waitFor(() => worker.inboxMessages.length === baseline + 1, 8000, 'the interrupt wake splices ONE delta (interruptor + pendientes)')
    const delta = worker.inboxMessages[worker.inboxMessages.length - 1]
    const text = delta.content[0].text
    const i = text.indexOf('INTERRUPTOR')
    const p1 = text.indexOf('pending one')
    const p2 = text.indexOf('pending two')
    assert.ok(i >= 0 && p1 >= 0 && p2 >= 0, 't2: the delta carries the interruptor AND both pending messages')
    assert.ok(i < p1 && p1 < p2, 't2: the order is [interruptor FIRST, then the pending in seq order] (the W9-b preemption order)')
    assert.deepEqual(delta.source.messageIds, [ir.messageId, r1.messageId, r2.messageId], 't2: the delta source lists the interruptor first, then the pendientes')
    const latest = await latestRowStatuses(stateDir)
    assert.equal(latest.get(`${ir.messageId}\u0000${workerId}`), 'delivered', 't2: the interruptor row is delivered')
    assert.equal(latest.get(`${r1.messageId}\u0000${workerId}`), 'delivered', 't2: the first pending row is delivered (the drain happened, nothing parked)')
    assert.equal(latest.get(`${r2.messageId}\u0000${workerId}`), 'delivered', 't2: the second pending row is delivered')
  })
})

test('VALLE 09-07 (tool): noWake/ack wake-seam INTACT at the tool level — an explicit noWake (and a B3 dormant-ack) to a RUNNING recipient reports \'prepared (noWake)\', NEVER accumulates (the batch state stays empty) and the settle flush is a no-op for it', async () => {
  await withBootedOrg(async ({ stateDir, env, head, headCtx, spawn, signal }) => {
    const workerId = spawn.workerId
    const send = (text, extra = {}) => headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: [workerId], text, ...extra }, { agent: head, signal })
    const worker = env.agents.get(spawn.sessionId)
    const baseline = worker.inboxMessages.length
    worker.status = 'running'
    const nw = await send('no-wake order', { noWake: true })
    assert.equal(nw.delivered[workerId], 'prepared (noWake)', 't3: the WIRED noWake send reports the noWake class (never the batch class, never a wake)')
    assert.equal(worker.inboxMessages.length, baseline, 't3: nothing spliced (no wake, no accumulation)')
    const ak = await send('ack', { ack: true })
    // The worker is NOT catalog-dormant (no sleepEpoch) → the ack is ALWAYS-WAKE
    // (B3 no-wakes only a DORMANT recipient) → but the recipient is RUNNING →
    // the always-wake ack ACCUMULATES (the batch class) — the day-1 behavior.
    assert.equal(ak.delivered[workerId], 'prepared (batch-until-settle)', 't3: a NON-dormant ack to a running recipient accumulates like any always-wake (B3 dormant-gate untouched)')
    // The settle flush: the noWake record must NOT be part of any delta; only
    // the accumulated ack splices.
    env.pluginCtx().emit('agent/status', { status: 'idle', agent: worker })
    await waitFor(() => worker.inboxMessages.length === baseline + 1, 8000, 'the settle flush splices ONLY the accumulated ack (one delta)')
    const delta = worker.inboxMessages[worker.inboxMessages.length - 1]
    assert.equal(delta.content[0].text.includes('no-wake order'), false, 't3: the noWake record is NOT in the delta (it was never accumulated — the wake-seam contract intact)')
    assert.equal(delta.content[0].text.includes('ack'), true, 't3: the accumulated ack IS in the delta')
    const latest = await latestRowStatuses(stateDir)
    assert.equal(latest.get(`${nw.messageId}\u0000${workerId}`), 'prepared', 't3: the noWake row stays prepared (drains at the recipient\'s next real wake — never consumed by the batch)')
  })
})

test('VALLE 09-07 (tool): IDLE — the first message wakes as today (NO accumulation, immediate followup); the settle-flush without pending messages is a no-op (no starvation, no spurious wake)', async () => {
  await withBootedOrg(async ({ stateDir, env, head, headCtx, spawn, signal }) => {
    const workerId = spawn.workerId
    const send = (text) => headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: [workerId], text }, { agent: head, signal })
    const worker = env.agents.get(spawn.sessionId)
    assert.equal(worker.status, 'idle', 't5: the worker is IDLE (the pre-batch state)')
    const baseline = worker.inboxMessages.length
    const idle = await send('idle wake probe')
    assert.equal(idle.delivered[workerId], 'delivered', 't5: a send to the IDLE recipient delivers immediately (the first message wakes as today — never accumulated)')
    assert.equal(worker.inboxMessages.length, baseline + 1, 't5: the idle delivery splices the plain followup (1:1 — the pre-batch path)')
    // A settle with NO pending batch → flush no-op (nothing splices twice).
    env.pluginCtx().emit('agent/status', { status: 'idle', agent: worker })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(worker.inboxMessages.length, baseline + 1, 't5: the settle without a pending batch adds NOTHING (no starvation, no spurious splice)')
  })
})

test('VALLE 09-07 (tool): NO STARVATION — a pending batch flushes on the SETTLE alone (idle fires WITHOUT any new message: the flush needs only the running→idle event)', async () => {
  await withBootedOrg(async ({ stateDir, env, head, headCtx, spawn, signal }) => {
    const workerId = spawn.workerId
    const send = (text) => headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: [workerId], text }, { agent: head, signal })
    const worker = env.agents.get(spawn.sessionId)
    const baseline = worker.inboxMessages.length
    worker.status = 'running'
    const r1 = await send('starvation probe one')
    const r2 = await send('starvation probe two')
    assert.equal(worker.inboxMessages.length, baseline, 't6: the batch accumulated (nothing spliced while running)')
    // The turn ENDS with NO further traffic — the settle alone must drain.
    env.pluginCtx().emit('agent/status', { status: 'idle', agent: worker })
    await waitFor(async () => {
      const ls = await latestRowStatuses(stateDir)
      return ls.get(`${r2.messageId}\u0000${workerId}`) === 'delivered'
    }, 8000, 'the settle drains the pending batch without any new message')
    assert.equal(worker.inboxMessages.length, baseline + 1, 't6: ONE delta followup carried the whole pending lot (the batch NEVER starves — the flush is purely event-driven)')
  })
})

test('VALLE 09-07 (tool): CRASH-SAFE write-ahead — a batch left UNFLUSHED (rows \'prepared\') is re-driven 1:1 by a FRESH boot over the SAME stateDir (no loss: the rows were durable before the flush)', async () => {
  await withTempStateDir(async (stateDir) => {
    // Boot 1 — accumulate WITHOUT flushing (the simulated crash: the process
    // dies between the sends and the settle).
    const env1 = await bootPluginFromSrc(stateDir)
    let workerId
    let r1
    let r2
    try {
      await waitFor(() => env1.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const head = env1.agents.store.get('head-research-head')
      const headCtx = childContextFor(env1.agents, 'head-research-head')
      assert.ok(headCtx, 'the head own-layer context resolves')
      const signal = new AbortController().signal
      const spawn = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'batch-drain crash worker' }, { agent: head, signal })
      workerId = spawn.workerId
      await waitFor(() => env1.agents.store.has(spawn.sessionId), 8000, 'the worker is live')
      const worker = env1.agents.get(spawn.sessionId)
      worker.status = 'running'
      const send = (text) => headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: [workerId], text }, { agent: head, signal })
      r1 = await send('crash-safe one')
      r2 = await send('crash-safe two')
      assert.equal(r1.delivered[workerId], 'prepared (batch-until-settle)', 't8: the first send accumulated')
      assert.equal(r2.delivered[workerId], 'prepared (batch-until-settle)', 't8: the second send accumulated')
    } finally {
      await env1.dispose() // NO settle flush happened — the crash window
    }
    let latest = await latestRowStatuses(stateDir)
    assert.equal(latest.get(`${r1.messageId}\u0000${workerId}`), 'prepared', 't8: the unflushed rows stay prepared (durable — the write-ahead)')
    assert.equal(latest.get(`${r2.messageId}\u0000${workerId}`), 'prepared', 't8: both rows are prepared')
    // Boot 2 — the boot re-delivery driver re-drives the 'prepared' pairs 1:1.
    const env2 = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(async () => {
        const ls = await latestRowStatuses(stateDir)
        return ls.get(`${r2.messageId}\u0000${workerId}`) === 'delivered'
      }, 10000, 'the fresh boot re-delivers the crash-pending pairs 1:1')
      let latest = await latestRowStatuses(stateDir)
    assert.ok(['delivered', 'resumed'].includes(latest.get(`${r1.messageId}\u0000${workerId}`)), 't8: the first record was re-delivered (the write-ahead: nothing lost; delivered OR resumed — the boot materialized the dormant worker)')
    assert.ok(['delivered', 'resumed'].includes(latest.get(`${r2.messageId}\u0000${workerId}`)), 't8: the second record was re-delivered (final, never stuck prepared)')
    } finally {
      await env2.dispose()
    }
  })
})

test('VALLE 09-07 (tool C2 — the m-2523 class, RE-BASED 2026-09-07 over the FB-132 RETIRED-FLAVOR COLLIDE): an ACK to a RETIRED host-session (sleepEpoch preserved, rotated successor) is NEVER parked \'prepared\' — the retired-flavor fix (isDormantRecipient returns FALSE for a retired entry) means the B3 dormant-ack gate does NOT auto-noWake it → the ALWAYS-WAKE re-routes to the LIVE successor (F-3, m-424/425/429 restored; the pair lands \'resumed\' keyed to the OLD id). The m-2523 forever-stuck class is prevented BY CONSTRUCTION (a retired entry is never dormant → never noWaked → never parks); a WIRED noWake ORDER to the same address still FAILS (the engine C2 branch — covered by the engine-level C2 + the control below)', async () => {
  await withTempStateDir(async (stateDir) => {
    // The hosts.json shape that produced the m-2494/m-2523 orphans: a RETIRED
    // host-family entry that KEEPS the permanent spec-002 sleepEpoch + a LIVE
    // successor (the rotation chain). The FB-132 retired-flavor predicate:
    // the retired entry's sleepEpoch is STALE metadata — never dormant — so the
    // b3 dormant-ack noWake gate does NOT fire; the delivery re-routes (F-3).
    // Keys follow the registry convention `host-<sessionId>` (loadHosts skips
    // a mismatched key — the wake-seam O1 precedent).
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({
      schemaVersion: 2,
      'host-s-retired': { sessionId: 's-retired', roomId: 'board', sleepEpoch: T0, boundarySeq: 100, retired: true, retiredAt: T0 - 60_000, rotatedTo: 'host-s-live' },
      'host-s-live': { sessionId: 's-live', roomId: 'board' }
    }, null, 2), 'utf8')
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const head = env.agents.store.get('head-research-head')
      const headCtx = childContextFor(env.agents, 'head-research-head')
      assert.ok(headCtx, 'the head own-layer context resolves')
      const signal = new AbortController().signal
      // (a) The ACK to the RETIRED host-session — re-based contract: NOT a
      // frozen noWake; the ALWAYS-WAKE re-routes to the LIVE successor (the
      // pair lands 'resumed' keyed to the OLD id; the successor receives).
      const res = await headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: ['host-s-retired'], text: 'ACK (retired host)', ack: true }, { agent: head, signal })
      assert.equal(res.delivered['host-s-retired'], 'resumed', 'C2-tool: the ack to the RETIRED host-session RE-ROUTES to the live successor (\'resumed\' keyed to the old id — the F-3 role intent; NEVER the m-2523 frozen \'prepared (noWake)\' class)')
      const latest = await latestRowStatuses(stateDir)
      assert.equal(latest.get(`${res.messageId}\u0000host-s-retired`), 'resumed', 'C2-tool: the pair ends \'resumed\' (settled via the re-route — visible, never a frozen prepared row)')
      assert.ok(![...latest.keys()].some((k) => k.endsWith('\u0000host-s-retired') && latest.get(k) === 'prepared'), 'C2-tool: ZERO \'prepared\' rows keyed to the retired address (the frozen class is structurally impossible — the retired entry is never dormant, never noWaked)')
      // (b) The CONTROL — a WIRED noWake ORDER to the SAME retired address
      // still takes the engine C2 branch: noWake + reroute → 'failed' (the
      // m-2523 acceptance for an explicit no-wake order stays intact).
      const explicit = await headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: ['host-s-retired'], text: 'explicit noWake to retired', noWake: true }, { agent: head, signal })
      assert.equal(explicit.delivered['host-s-retired'], 'failed:reroute', 'C2-tool CONTROL: an EXPLICIT noWake ORDER to the retired address FAILS to the sender with the terminal reroute ground (fb-198 T1 — the engine C2 branch; the noWake-to-a-never-live-address protection is intact)')
    } finally {
      await env.dispose()
    }
  })
})

test('VALLE 09-07 (tool — the HOST case, §host por diseño): a HOST recipient with the spec-002 PERMANENT sleepEpoch whose LIVE session is mid-turn coalesces — N sends DURING the host turn accumulate and drain as ONE delta at the settle (the running host is the batch condition exactly like a post), rows \'prepared\' → \'delivered\'; the batch NEVER touches a DORMANT host (a permanent-sleepEpoch host NOT mid-turn is delivered 1:1 as today — the D4 resume; the first message wakes it). THE HOST CONTRACT (explore-49 verdict, owner-approved): «solo coalesce mid-turn» — the native host lib engages only at the host restart in a clean window (the spec-002 rotation), so the host is never batch-reassembled across a restart; the mid-turn coalesce here is both the documented and the ONLY host batch surface. Delivery semantics untouched — the test only pins the observable contract', async () => {
  await withTempStateDir(async (stateDir) => {
    // The spec-002 HOST: a permanent sleepEpoch (dormant between turns — the
    // D4 resume wakes it; the registry key follows the `host-<sessionId>`
    // convention loadHosts validates).
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({
      schemaVersion: 2,
      'host-s-host': { sessionId: 's-host', roomId: 'board', sleepEpoch: T0 }
    }, null, 2), 'utf8')
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const head = env.agents.store.get('head-research-head')
      const headCtx = childContextFor(env.agents, 'head-research-head')
      assert.ok(headCtx, 'the head own-layer context resolves')
      const signal = new AbortController().signal
      // Materialize the HOST's live handle (the D4-resume shape — a dormant
      // host's session becomes live when its turn starts) and flip it RUNNING
      // (mid-turn — the ONLY host state the batch accumulates).
      const host = {
        id: 's-host',
        status: 'running',
        inboxMessages: [],
        followup(message) { this.inboxMessages.push(message) },
        cancel() {},
        async whenIdle() {}
      }
      env.agents.store.set('s-host', host)
      const send = (text) => headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: ['host-s-host'], text }, { agent: head, signal })
      const baseline = host.inboxMessages.length
      // 3 always-wake sends while the HOST turn is in flight.
      const r1 = await send('host probe one')
      const r2 = await send('host probe two')
      const r3 = await send('host probe three')
      assert.equal(r1.delivered['host-s-host'], 'prepared (batch-until-settle)', 'host-t1: the first run send to the RUNNING host reports the batch class (accumulated for the settle)')
      assert.equal(r2.delivered['host-s-host'], 'prepared (batch-until-settle)', 'host-t1: the SECOND send accumulates too (the batch surface is keyed by the live session, post AND host)')
      assert.equal(r3.delivered['host-s-host'], 'prepared (batch-until-settle)', 'host-t1: the THIRD send accumulates')
      assert.equal(host.inboxMessages.length, baseline, 'host-t1: NOTHING spliced into the live host inbox while running (the batch waits for the settle)')
      let latest = await latestRowStatuses(stateDir)
      assert.equal(latest.get(`${r1.messageId}\u0000host-s-host`), 'prepared', 'host-t1: the rows stay \'prepared\' (write-ahead)')
      assert.equal(latest.get(`${r3.messageId}\u0000host-s-host`), 'prepared', 'host-t1: the third row is prepared too')
      // The SETTLE (the running→idle agent/status transition — the SAME fused
      // payload the dsh-agent-loop setPhase dispatches, applied to the host).
      env.pluginCtx().emit('agent/status', { status: 'idle', agent: host })
      await waitFor(() => host.inboxMessages.length === baseline + 1, 8000, 'the settle flush splices EXACTLY ONE host delta')
      const delta = host.inboxMessages[host.inboxMessages.length - 1]
      const text = delta.content[0].text
      assert.equal(text.indexOf('host probe one') < text.indexOf('host probe two') && text.indexOf('host probe two') < text.indexOf('host probe three'), true, 'host-t1: the frames travel in SEQ order (the host turn coalesces like a post turn)')
      assert.equal(text.includes('host probe three'), true, 'host-t1: the delta carries the LAST frame')
      assert.equal(delta.source.batch, true, 'host-t1: the delta source carries the batch marker')
      assert.deepEqual(delta.source.messageIds, [r1.messageId, r2.messageId, r3.messageId], 'host-t1: the delta source lists ALL the message ids')
      latest = await latestRowStatuses(stateDir)
      assert.equal(latest.get(`${r1.messageId}\u0000host-s-host`), 'delivered', 'host-t1: the rows end \'delivered\' after the flush')
      assert.equal(latest.get(`${r3.messageId}\u0000host-s-host`), 'delivered', 'host-t1: the third row ends delivered')
      // The DORMANT-HOST CONTROL (§host por diseño): with the live handle GONE
      // (the host back to its permanent sleepEpoch) a send is NOT batch — the
      // D4 resume wakes the host and the FIRST message delivers 1:1 (the
      // batch condition is the RUNNING live session; a dormant host is never
      // accumulated — the documented host contract).
      env.agents.store.delete('s-host')
      const hostWake = await send('host dormant wake')
      assert.equal(hostWake.delivered['host-s-host'], 'resumed', 'host-control: a send to the DORMANT host (permanent sleepEpoch, no live handle) RESUMES it 1:1 — never the batch class (the host coalesces ONLY mid-turn)')
      const dorm = env.agents.get('s-host')
      assert.ok(dorm !== undefined, 'host-control: the D4 resume materialized the host session')
      assert.equal(dorm.inboxMessages.length, 1, 'host-control: the dormant wake delivered ONE plain followup (1:1 — no accumulation, no batch marker)')
      assert.equal(dorm.inboxMessages[0].source.batch, undefined, 'host-control: the plain followup carries NO batch marker')
    } finally {
      await env.dispose()
    }
  })
})