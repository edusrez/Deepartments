// dsh-deepartments — LANE WAKE-SEAM/OUTBOX (2026-09-04, run token 1e9aa035):
// the P1-P5 fixes of the explore-deep WAKE-SEAM diagnosis (reports/explore-deep/
// 2026-09-04-wakeseam-diagnosis-c1a55346.md §5), all written src-native
// (0 builds, 0 real APIs; temp stateDir + stub deps only).
//
//   P1 (fb-131): the `interrupt:true` send BYPASSES the fb-117 FIFO gate (the
//       gate ran BEFORE the route → the interrupt never reached busDeliverToPost)
//       + Candidate-B observability: the send_message tool result distinguishes
//       'prepared (fifo-gated tras m-<seq>)' / 'prepared (noWake)' / 'delivered'.
//   P2 (fb-131): the sweep respects the explicit noWake flag of the LATEST row —
//       a noWake 'prepared' row is NEVER re-driven into a NON-running recipient
//       (the no-wake-until-wake contract the sweep used to violate).
//   P3 (fb-130): retirePost drains the pending next-turn/inbox splices BEFORE/
//       AT the dispose — a sidecar-'delivered' pair whose splice was never
//       exposed settles 'terminal' (delivered ≠ expuesto — the m-981 class).
//   P4 (fb-131): sweepState() exposes the honest prepared-state summary
//       ({oldestPreparedTs, dormantHeld, noWakeHeld}) + the G2 flip preserves
//       the noWake flag (the intent trace no longer destroyed).
//   P5 (O4): the boot reconcile BACKFILLS the retired archive BY STATE —
//       retired:true posts.json entries WITHOUT an archive row of the same
//       (postId, sessionId) get one (the pre-O4 deploy-gap retires).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

// The src modules (ts-src-loader — the ts-loader hook targets repo-.ts
// importers; the value-importing ones load DYNAMIC after the register()).
const C = await import('../packages/dshd-core/src/messages.ts')
const { DeliveryRedeliverer, deliveryStatus, parseDeliveryRows, resolveDeliveriesPath, resolveMessagesPath, markDelivery } = C
const D = await import('../packages/dshd-core/src/delivery.ts')
const { createDeliveryEngine } = D
const R = await import('../packages/dshd-core/src/registry.ts')
const { reconcileDurablePostsRegistry } = R

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLE_SRC = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href

process.env.DEEPARTMENTS_QUALITY_INSPECT = '1' // the worker-retire QD dice stays DETERMINISTIC

// ---------------------------------------------------------------------------
// Shared helpers: temp stateDir + the lane2-style redeliverer stub harness.
// ---------------------------------------------------------------------------
async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'wakeseam-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

async function writeDeliveries(stateDir, rows) {
  await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

function row(messageId, recipientId, status, ts, noWake) {
  return noWake === true ? { messageId, recipientId, status, ts, noWake } : { messageId, recipientId, status, ts }
}

/** The lane2-style DeliveryRedeliverer over a temp stateDir (stub deps). */
function redeliverer(stateDir, overrides = {}) {
  const calls = { deliver: [] }
  const recordsById = new Map()
  const deps = {
    stateDir,
    logger: { info() {}, warn() {} },
    recipientAlive: () => true,
    recipientDormant: () => false,
    recipientRunning: () => false,
    getRecord: async (id) => (recordsById.get(id) ?? undefined),
    resolveCallerSessionId: (from) => from,
    deliver: async (record, recipientId) => {
      calls.deliver.push({ messageId: record.id, recipientId })
      await markDelivery(stateDir, record.id, recipientId, 'delivered')
      return 'delivered'
    },
    ...overrides
  }
  const r = new DeliveryRedeliverer(deps, {
    baseDelayMs: 15_000, maxDelayMs: 600_000, maxAttempts: 12, stormWindowMs: 3600_000,
    preparedStuckMs: 600_000, g2DrainSeedLimit: 250, legacyAgeMs: 600_000
  })
  r.__calls = calls
  r.__records = (id, record) => recordsById.set(id, record)
  return r
}

// ---------------------------------------------------------------------------
// The o1ext composed-boot harness (spawn a worker + drive the real tools over
// stub agents — 0 real APIs; the tools engine + the redeliver driver + the
// registry + the messages store are all real src wired through the bundle).
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

const postAdoption = new Map()

function stubProvider(name) {
  const provider = {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: name === 'fork',
    async start() { throw new Error('stub provider: one-shot start is not used') },
    async prepareContinuable() { return { seed: [] } }
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
  const childKey = Symbol('wakeseam-stub-child-scope')
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
    return materializeStubAgent(this, options.resumeSessionId, { ...options, parentSession: postAdoption.get(options.resumeSessionId) })
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
  loader.create({ id: 'deepartments', name: BUNDLE_SRC, config: { stateDir, org: opts.org ?? ORG } })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return { root, agents, persistence, workspaceRegistry, pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx, dispose: () => loaderFiber.dispose() }
}

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function childContextFor(agents, sessionId) {
  const index = agents.childAgents.findIndex((agent) => agent && agent.id === sessionId)
  if (index < 0) return undefined
  return { ctx: agents.childContexts[index].ctx, key: agents.childContexts[index].key }
}

async function seedMessageRecords(stateDir, records) {
  await writeFile(resolveMessagesPath(stateDir), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
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
      const spawn = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'wakeseam lane test worker' }, { agent: head, signal })
      assert.ok(spawn.workerId, 'the worker spawned')
      await waitFor(() => env.agents.store.has(spawn.sessionId), 8000, 'the worker is live')
      return await fn({ stateDir, env, head, headCtx, spawn, signal })
    } finally {
      await env.dispose()
    }
  })
}

// ===========================================================================
// P1 (fb-131) — the interrupt BYPASSES the fifo gate + the prepared-class
// observability ('prepared (fifo-gated tras m-<seq>)' vs 'prepared (noWake)').
// ===========================================================================
test('P1 (fb-131): `interrupt:true` BYPASSES the fb-117 FIFO gate — a gated recipient is still delivered/woken; the SAME send WITHOUT interrupt stays gated (the fb-117 regression is intact) + the gateReason observer reports the class', async () => {
  await withTempStateDir(async () => {
    const T0 = 1_700_000_000_000
    // A stub engine whose gate predicate ALWAYS fires (an earlier pending pair).
    const build = (opts = {}) => {
      const calls = { deliverHost: 0, finals: [] }
      const reasons = []
      const engine = createDeliveryEngine({
        stateDir: '/tmp/wakeseam-unused',
        logger: { info() {}, warn() {} },
        markPrepared: async () => {},
        markFinal: async (record, recipientId, status) => calls.finals.push({ id: record.id, recipientId, status }),
        resolveChild: async () => false,
        deliverChild: async () => 'delivered',
        resolveCatalogRoute: (id) => ({ kind: 'host', entry: { hostId: id, sessionId: 's-' + id, roomId: 'board' } }),
        busProfileFor: () => ({ kind: 'host', memberId: 'the-host' }),
        deliverPost: async () => { calls.deliverHost++; return 'delivered' },
        deliverHost: async () => { calls.deliverHost++; return 'delivered' },
        pendingEarlierSeq: async () => true,
        pendingEarlierSeqDetail: async (recipientId, seq) => seq - 1,
        ...opts.deps
      })
      return { engine, calls, reasons }
    }
    const record = (id, seq) => ({ id, seq, ts: T0, from: 'the-host', to: ['rx'], text: 'probe', kind: 'agent' })
    // (1) WITH interrupt: the gate is BYPASSED — the delivery reaches the wake
    // primitive and completes 'delivered' (today the interrupt was swallowed).
    const a = build()
    const statusA = await a.engine.deliverOrQueue('rx', record('m-2', 2), { callerAgentId: 'the-host', senderSessionId: 'the-host', interrupt: true })
    assert.equal(statusA, 'delivered', 'P1: an interrupt:true send to a gated recipient is DELIVERED (the gate no longer swallows the interrupt)')
    assert.equal(a.calls.deliverHost, 1, 'P1: the wake primitive fires exactly once (the recipient is materialized/woken)')
    // (2) REGRESSION (fb-117): the SAME condition WITHOUT interrupt stays gated.
    const b = build()
    const statusB = await b.engine.deliverOrQueue('rx', record('m-2', 2), { callerAgentId: 'the-host', senderSessionId: 'the-host' })
    assert.equal(statusB, 'prepared', 'P1 regression (fb-117): a gated send WITHOUT interrupt is still degraded to the no-wake queue')
    assert.equal(b.calls.deliverHost, 0, 'P1 regression: the wake primitive is NEVER called for the gated non-interrupt send')
    assert.deepEqual(b.calls.finals, [{ id: 'm-2', recipientId: 'rx', status: 'prepared' }], 'P1 regression: the pair finalizes precisely ONE prepared row')
    // (3) the gateReason observer: 'fifo' + the gating seq detail (Candidate B).
    const c = build()
    let cReason
    let cSeq
    const statusC = await c.engine.deliverOrQueue('rx', record('m-7', 7), { callerAgentId: 'the-host', senderSessionId: 'the-host', gateReason: (reason, bySeq) => { cReason = reason; cSeq = bySeq } })
    assert.equal(statusC, 'prepared', 'P1-C: the fifo-gated outcome is still a plain prepared status (the sidecar is never enriched)')
    assert.equal(cReason, 'fifo', 'P1-C: the observer reports the FIFO queue class')
    assert.equal(cSeq, 6, 'P1-C: the observer carries the EARLIEST gating seq (the tras m-<seq> detail)')
    // (4) the noWake branch fires the observer with the 'noWake' class.
    const d = build({ deps: { pendingEarlierSeq: async () => false } })
    let dReason
    const statusD = await d.engine.deliverOrQueue('rx', record('m-8', 8), { callerAgentId: 'the-host', senderSessionId: 'the-host', noWake: true, gateReason: (reason) => { dReason = reason } })
    assert.equal(statusD, 'prepared', 'P1-C: the wired noWake branch returns prepared')
    assert.equal(dReason, 'noWake', 'P1-C: the observer reports the noWake queue class')
  })
})

test('P1 (fb-131, Candidate B — tool level): the send_message result distinguishes `prepared (fifo-gated tras m-N)` / `prepared (noWake)` / `delivered`, and an interrupt re-send of the gated pair WAKES the recipient (the inbox splice lands)', async () => {
  await withBootedOrg(async ({ stateDir, env, head, headCtx, spawn, signal }) => {
    const workerId = spawn.workerId
    // The spawn's own first-message followup already spliced the stub inbox —
    // the BASELINE the noWake/gated sends must NOT grow (they never wake).
    const baselineInbox = env.agents.store.get(spawn.sessionId).inboxMessages.length
    const send = (extra) => headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: [workerId], text: `wakeseam probe ${JSON.stringify(extra)}`, ...extra }, { agent: head, signal })
    // (1) a NO-WAKE send → the WIRED no-wake branch: 'prepared (noWake)'.
    const noWakeRes = await send({ noWake: true })
    assert.equal(noWakeRes.delivered[workerId], 'prepared (noWake)', 'P1-B: an explicit noWake send reports the noWake queue class')
    assert.equal(env.agents.store.get(spawn.sessionId).inboxMessages.length, baselineInbox, 'P1-B: the noWake send NEVER wakes the recipient (no followup splice)')
    // (2) the SAME recipient, ALWAYS-WAKE → the fb-117 gate (the earlier
    // 'prepared' noWake pair is still pending) → 'prepared (fifo-gated tras m-N)'.
    const gatedRes = await send({})
    const gated = gatedRes.delivered[workerId]
    assert.match(gated, /^prepared \(fifo-gated tras m-\d+\)$/, `P1-B: the gated send reports the FIFO class + the gating seq (got "${gated}")`)
    assert.equal(env.agents.store.get(spawn.sessionId).inboxMessages.length, baselineInbox, 'P1-B: the gated send stays QUEUED (no wake — the fb-117 behavior intact)')
    // (3) the SAME condition with `interrupt:true` → the gate is BYPASSED —
    // the recipient is WOKEN (the followup splice lands in the inbox).
    const intRes = await send({ interrupt: true })
    assert.equal(intRes.delivered[workerId], 'delivered', 'P1-B: the interrupt re-send of the gated pair is DELIVERED (the interrupt is no longer swallowed)')
    assert.ok(env.agents.store.get(spawn.sessionId).inboxMessages.length >= baselineInbox + 1, 'P1-B: the interrupt delivery splices the recipient inbox (materialized/woken)')
    // (4) the sidecar rows stay the PLAIN statuses (the envelope is tool-only).
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    assert.ok(rows.some((r) => r.recipientId === workerId && r.status === 'prepared'), 'P1-B: the sidecar keeps the plain prepared rows (the enrichment never touches the ledger)')
    assert.ok(rows.some((r) => r.recipientId === workerId && r.status === 'delivered'), 'P1-B: the interrupt delivery finalizes a plain delivered row')
  })
})

// ===========================================================================
// P2 (fb-131) — the sweep respects the LATEST row's noWake flag.
// ===========================================================================
test('P2 (fb-131): a noWake `prepared` row is NEVER re-driven into a NON-running recipient (the no-wake-until-wake contract); the plain crash-class row IS re-driven; a noWake row IS drained into a RUNNING recipient; the stuck counter still counts the held noWake pairs', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_700_000_000_000
    const OLD = T0 - 11 * 60_000 // > preparedStuckMs (10 min)
    const rec = (id, seq, recipientId) => ({ id, seq, ts: T0, from: 'ipd', to: [recipientId], text: 'report', kind: 'agent' })
    // (a) noWake row to an IDLE recipient (the fb-131 datapoints: the sweep
    // used to WAKE it at ts+10min); (b) plain crash-class prepared; the
    // recipientRunning predicate says NO for all (idle).
    await writeDeliveries(stateDir, [
      row('m-nowake', 'rx-idle', 'prepared', OLD, true),
      row('m-crash', 'rx-idle2', 'prepared', OLD, false)
    ])
    const r = redeliverer(stateDir, { recipientRunning: () => false })
    r.__records('m-nowake', rec('m-nowake', 0, 'rx-idle'))
    r.__records('m-crash', rec('m-crash', 1, 'rx-idle2'))
    await r.sweepDue(T0)
    assert.deepEqual(r.__calls.deliver.map((d) => d.messageId), ['m-crash'], 'P2: ONLY the plain crash-class row is re-driven — the noWake row is NOT (the sweep no longer wakes an idle recipient)')
    assert.equal(await deliveryStatus(stateDir, 'm-nowake', 'rx-idle'), 'prepared', 'P2: the noWake row stays prepared — it drains at the recipient\'s next REAL wake')
    assert.equal(await deliveryStatus(stateDir, 'm-crash', 'rx-idle2'), 'delivered', 'P2: the plain crash-class row re-drives normally (no regression)')
    // The counter still SEES the held noWake pair (the closure criterion is
    // honest — the pair is counted even though the sweep holds it).
    const state = r.sweepState()
    assert.equal(state.noWakeHeld, 1, 'P2/P4: the noWake-held class is reported separately (the pair the guard holds)')
    assert.equal(state.preparedStuckRemaining, 1, 'P2: the prepared-stuck residue COUNTS the held noWake pair (the QD criterion sees it — closed only by a REAL wake)')
    // (c) EXCEPTION: a noWake row IS drained into a CURRENTLY RUNNING recipient
    // (already live — no wake happens, zero materialization).
    await writeDeliveries(stateDir, [row('m-nowake2', 'rx-running', 'prepared', OLD, true)])
    const r2 = redeliverer(stateDir, { recipientRunning: (recipientId) => recipientId === 'rx-running' })
    r2.__records('m-nowake2', rec('m-nowake2', 2, 'rx-running'))
    await r2.sweepDue(T0)
    assert.deepEqual(r2.__calls.deliver.map((d) => d.messageId), ['m-nowake2'], 'P2: a noWake row to a RUNNING recipient IS re-driven (the only drain — already live, never a wake)')
    assert.equal(await deliveryStatus(stateDir, 'm-nowake2', 'rx-running'), 'delivered', 'P2: the running-recipient drain settles delivered')
  })
})

// ===========================================================================
// P3 (fb-130) — the retire pre-dispose splice drain (delivered ≠ expuesto).
// ===========================================================================
test('P3 (fb-130): retirePost DRAINS a sidecar-\'delivered\' pair whose inbox splice was NEVER exposed — the pending next-turn splice settled \'terminal\' at the retire (the m-981 class: delivered ≠ expuesto, never silently lost)', async () => {
  await withBootedOrg(async ({ stateDir, env, head, headCtx, spawn, signal }) => {
    const workerId = spawn.workerId
    const worker = env.agents.store.get(spawn.sessionId)
    const T0 = Date.now()
    // The RECIPIENT's durable session log carries a PENDING next-turn splice —
    // the harness Inbox event shape (the W7-B JSON-safe bus message: the source
    // carries the bus record id) — delivered by busDeliverToPost but never
    // claimed by any turn (the fb-130 window: followup → retire → dispose).
    worker.session.events.push({
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [{ id: 'uuid-fb130', source: { kind: 'agent', form: 'send', messageId: 'm-fb130', to: [workerId] } }] }
    })
    // The sidecar ALREADY says 'delivered' (the splice mark — NOT the exposure).
    await writeDeliveries(stateDir, [{ messageId: 'm-fb130', recipientId: workerId, status: 'delivered', ts: T0 }])
    // The retire: the pre-dispose drain must settle the never-exposed pair.
    const retire = await headCtx.ctx.tools.get('dept_worker_retire', headCtx.key).execute({ workerId }, { agent: head, signal })
    assert.equal(retire.retired, true, 'P3: the worker retires')
    await waitFor(async () => (await deliveryStatus(stateDir, 'm-fb130', workerId)) === 'terminal', 8000, 'the never-exposed pair settles terminal at the retire')
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    const pair = rows.filter((r) => r.messageId === 'm-fb130' && r.recipientId === workerId).map((r) => r.status)
    assert.deepEqual(pair.slice(-2), ['delivered', 'terminal'], "P3: the sidecar is HONEST — 'delivered' (the splice) corrected by 'terminal' (never exposed); the durable content stays in messages.jsonl")
  })
})

test('P3 regression (fb-130): a retire with NO pending splice gains NO terminal row (0 extra writes — normal retires unchanged)', async () => {
  await withBootedOrg(async ({ stateDir, env, head, headCtx, spawn, signal }) => {
    const workerId = spawn.workerId
    const retire = await headCtx.ctx.tools.get('dept_worker_retire', headCtx.key).execute({ workerId }, { agent: head, signal })
    assert.equal(retire.retired, true, 'P3 regression: the worker retires')
    await waitFor(() => (env.agents.disposeCalls.get(spawn.sessionId) ?? 0) >= 1, 8000, 'the dispose lands')
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    // The ONLY rows are the spawn's own first-message pair (m-0 prepared +
    // delivered — NOT a drain of this retire): no terminal row for the worker,
    // no corrective row at all (a pending-splice drain only writes when the
    // session log actually shows a never-exposed splice).
    assert.ok(rows.every((r) => r.recipientId !== workerId || (r.messageId === 'm-0' && (r.status === 'prepared' || r.status === 'delivered'))), 'P3 regression: the retire adds NO drain/settle row for the worker (only the spawn\'s own m-0 pair exists)')
    assert.equal(rows.filter((r) => r.status === 'terminal').length, 0, 'P3 regression: NO terminal row at all (0 extra writes)')
  })
})

// ===========================================================================
// P4 (fb-131) — the honest sweep prepared-state summary + the G2 noWake keep.
// ===========================================================================
test('P4 (fb-131): sweepState() exposes each held class SEPARATELY — {oldestPreparedTs, dormantHeld, noWakeHeld} (the single integer could not discriminate); the G2 flip PRESERVES the noWake flag', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_700_000_000_000
    const OLD = T0 - 15 * 60_000
    const rec = (id, seq, recipientId) => ({ id, seq, ts: T0, from: 'ipd', to: [recipientId], text: 'report', kind: 'agent' })
    await writeDeliveries(stateDir, [
      // (a) dust shadowed — NOT pair-latest (never counted, never held).
      row('m-1', 'rx-a', 'prepared', OLD), row('m-1', 'rx-a', 'delivered', OLD + 1000),
      // (b) fresh prepared (< 10 min — live write-ahead, not stuck).
      row('m-2', 'rx-b', 'prepared', T0 - 60_000),
      // (c) stuck prepared to a DORMANT recipient (B3-held; a legit 0-residue).
      row('m-3', 'rx-dormant', 'prepared', OLD),
      // (d) stuck prepared with the explicit noWake flag (P2-held).
      row('m-4', 'rx-nowake', 'prepared', OLD, true),
      // (e) plain stuck prepared (the crash class the sweep re-drives).
      row('m-5', 'rx-crash', 'prepared', OLD)
    ])
    const r = redeliverer(stateDir, { recipientDormant: (id) => id === 'rx-dormant' })
    for (const [id, seq, recipientId] of [['m-1', 0, 'rx-a'], ['m-2', 1, 'rx-b'], ['m-3', 2, 'rx-dormant'], ['m-4', 3, 'rx-nowake'], ['m-5', 4, 'rx-crash']]) r.__records(id, rec(id, seq, recipientId))
    await r.sweepDue(T0)
    const state = r.sweepState()
    assert.equal(state.preparedStuckRemaining, 2, 'P4: the stuck residue counts the DORMANT + the noWake pair (2 — m-5 was re-driven; the dust + fresh never count)')
    assert.equal(state.dormantHeld, 1, 'P4: dormantHeld reports the B3-dormancy-held pair separately (a residue that may legitimately never reach 0)')
    assert.equal(state.noWakeHeld, 1, 'P4: noWakeHeld reports the P2-noWake-held pair separately (the explicit no-wake intent)')
    assert.equal(state.oldestPreparedTs, OLD, 'P4: oldestPreparedTs = the OLDEST pair-latest prepared row ts (the age the integer hides)')
    assert.equal(await deliveryStatus(stateDir, 'm-3', 'rx-dormant'), 'prepared', 'P4: the dormant pair is NEVER re-driven (B3)')
    assert.equal(await deliveryStatus(stateDir, 'm-4', 'rx-nowake'), 'prepared', 'P4: the noWake pair is NEVER re-driven (P2)')
    // G2: the flip of a noWake dust row PRESERVES the flag (the intent trace).
    await writeDeliveries(stateDir, [
      row('m-6', 'rx-g2', 'prepared', OLD, true),
      row('m-6', 'rx-g2', 'delivered', OLD + 1000)
    ])
    const r2 = redeliverer(stateDir)
    r2.__records('m-6', rec('m-6', 5, 'rx-g2'))
    const counts = await r2.settleG2Batch(T0)
    assert.equal(counts.settled, 1, 'P4-G2: the shadowed noWake dust row settles to terminal')
    const flipped = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8')).find((r) => r.messageId === 'm-6' && r.recipientId === 'rx-g2' && r.status === 'terminal')
    assert.ok(flipped !== undefined, 'P4-G2: the flipped terminal row exists')
    assert.equal(flipped.noWake, true, 'P4-G2: the G2 flip PRESERVES the noWake flag (the trace of intent survives — the pre-fix flip dropped it)')
  })
})

// ===========================================================================
// P5 (O4) — the boot-reconcile archive BACKFILL by state (keyed postId-session).
// ===========================================================================
test('P5 (O4/backfill): the reconcile backfills the retired archive BY STATE — a retired:true posts.json entry WITHOUT an archive row of the same (postId, sessionId) gets one (the pre-O4 deploy-gap retires); a same-session row is never duplicated; a DIFFERENT-session row of the SAME postId does NOT cover the new incarnation; ABSENT opt = conservative no-op', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_700_000_000_000
    // The archive already holds: (w-covered, s-same) [covers w-covered] and
    // (w-reinc, s-old) [a PREVIOUS incarnation of w-reinc — does NOT cover the
    // s-new incarnation]. w-pre-o4 has NO row (the deploy-gap class).
    const archivePath = path.join(stateDir, 'posts-retired-archive.jsonl')
    await writeFile(archivePath, [
      JSON.stringify({ postId: 'w-covered', entry: { sessionId: 's-same', provider: 'worker', retired: true }, prunedAt: T0 - 10_000 }),
      JSON.stringify({ postId: 'w-reinc', entry: { sessionId: 's-old', provider: 'worker', retired: true }, prunedAt: T0 - 20_000 })
    ].join('\n') + '\n', 'utf8')
    await writeFile(path.join(stateDir, 'posts.json'), JSON.stringify({
      'head': { sessionId: 'head-fixed', roomId: 'research', agentPreset: 'deepartments-head' },
      'w-covered': { sessionId: 's-same', provider: 'worker', role: 'builder', retired: true, retiredAt: T0 - 5_000 },
      'w-reinc': { sessionId: 's-new', provider: 'worker', role: 'builder', retired: true, retiredAt: T0 - 4_000 },
      'w-pre-o4': { sessionId: 's-gap', provider: 'worker', role: 'builder', retired: true, retiredAt: T0 - 3_000 }
    }, null, 2))
    const logged = []
    const first = await reconcileDurablePostsRegistry(stateDir, {
      logger: { warn: (m) => logged.push(m) },
      isSessionGone: () => false,
      enableRetiredArchiveBackfill: true,
      now: () => T0
    })
    assert.deepEqual(first.backfilledPostIds, ['w-reinc', 'w-pre-o4'], 'P5: the backfill covers the pre-O4 gap (no row at all) AND the new incarnation of a postId whose only row is an OLD session (keyed by sessionId)')
    assert.equal(first.changed, false, 'P5: the backfill NEVER rewrites posts.json (the archive is append-only)')
    const lines = (await readFile(archivePath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.length, 4, 'P5: 2 pre-seeded + 2 backfilled rows')
    const byPostId = new Map(lines.map((l) => [l.postId, l]))
    assert.equal(byPostId.get('w-covered').entry.sessionId, 's-same', 'P5: the covered entry gains NO new row (the SAME session row covers it)')
    assert.equal(byPostId.get('w-reinc').entry.sessionId, 's-new', 'P5: the reincarnated post gains a row for the NEW session (the old-session row does not cover)')
    assert.ok(byPostId.get('w-reinc').entry.sessionId === 's-new' && byPostId.has('w-pre-o4'), 'P5: the gap row carries the full entry + prunedAt shape')
    assert.equal(typeof byPostId.get('w-pre-o4').prunedAt, 'number', 'P5: the backfilled row carries a numeric prunedAt')
    assert.ok(logged.some((m) => m.includes('BACKFILLED 2 retired post(s)')), 'P5: the backfill logs the count')
    // Idempotence: a second run adds NOTHING (the keys are covered now).
    const second = await reconcileDurablePostsRegistry(stateDir, {
      logger: { warn: () => {} },
      isSessionGone: () => false,
      enableRetiredArchiveBackfill: true,
      now: () => T0 + 1
    })
    assert.equal((await readFile(archivePath, 'utf8')).trim().split('\n').length, 4, 'P5: a second run duplicates NOTHING (idempotent by (postId, sessionId))')
    assert.deepEqual(second.backfilledPostIds, [], 'P5: the second run reports no new backfills')
    // Conservative default: ABSENT opt → NO backfill (the opt is explicit).
    const third = await reconcileDurablePostsRegistry(stateDir, {
      logger: { warn: () => {} },
      isSessionGone: () => false
    })
    assert.equal((await readFile(archivePath, 'utf8')).trim().split('\n').length, 4, 'P5: an ABSENT enableRetiredArchiveBackfill leaves the archive untouched (conservative default)')
    assert.equal(third.backfilledPostIds, undefined, 'P5: the result field is ABSENT when the opt did not run')
  })
})