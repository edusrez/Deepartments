// dsh-deepartments — LANE fb-300/fb-301 (VALLE 09-09 — rematerialización de
// toolset post-smart_restart; clase fb-18 contrato) — the resume-seam TOOLSET
// REASSERTION tests.
//
// Guards/verifies:
//   (a) the PURE discriminator behavior through the factory surface
//       (`reassertPostToolset`) with a stub agents registry — the
//       mismatch/match/running/not-live verdicts: an IDLE session whose
//       expected own-layer toolset is MISSING is healed (dispose→cold-resume
//       when the bundle owns the handle / in-place re-arm for a registry-only
//       restored session), a RUNNING target is NEVER disarmed (fb-301), an
//       ARMED target is an exact no-op (the durable custom-tools fast-path B
//       stands);
//   (b) the materializePost LIVE-branch GUARD end-to-end through
//       `busDeliverToPost`: an unarmed live head falls to the COLD derivation
//       (status 'resumed', fresh ARMED target, audit 'unarmed' row); an armed
//       live head keeps the inline fast-path (status 'delivered', the same
//       agent object, NO setup re-run);
//   (c) the WIRING locks (source-level, the R6 pattern): the boot wiring
//       fires `runToolsetReassertion` post-redelivery; the tools surface
//       exposes the pass; the invoke.ts late seam wires
//       `reassertPostToolset`; the frozen CUT-4 zone is untouched; 0 new
//       bundle exports (the export-parity lock stays intact by construction).
//
// Hermetic: withTempStateDir + stub agents (the "AGENT REGISTRY ONLY" smart-
// restart shape — session attached to the registry WITHOUT the deepartments
// setup) + a real temp stateDir for the delivery factory's message/feedback
// stores and the toolset-audit channel. NEVER the live state.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createDeliveryOrchestration } from '../packages/dshd-orchestration/src/delivery.ts'
import { appendToolsetAudit, TOOLSET_AUDIT_FILE } from '../src/toolset-audit.ts'

const ORCH_ROOT = path.resolve(fileURLToPath(new URL('../packages/dshd-orchestration/src/', import.meta.url)))
function readToolsSource() {
  return readFileSync(path.join(ORCH_ROOT, 'tools.ts'), 'utf8')
}
function readDeliverySource() {
  return readFileSync(path.join(ORCH_ROOT, 'delivery.ts'), 'utf8')
}
function readInvokeSource() {
  return readFileSync(path.join(path.resolve(fileURLToPath(new URL('../src/', import.meta.url))), 'invoke.ts'), 'utf8')
}

// ---------------------------------------------------------------------------
// Shared harness: temp stateDir + the delivery factory over stub deps (the
// dual-surface stub pattern of fb132-retired-flavor.test.js) with a stub
// agents service modelling the smart-restart "AGENT REGISTRY ONLY" shape.
// ---------------------------------------------------------------------------
async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'toolset-reassert-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

const UNIVERSAL_OWN_LAYER = ['send_message', 'agent_messages', 'dept_who', 'dept_memo_write', 'dept_feedback', 'dept_calendar_add', 'dept_calendar_list', 'dept_calendar_remove']
const HEAD_OWN_LAYER = ['dept_feedback_list', 'dept_feedback_update', 'dept_post_create', 'dept_post_retire', 'dept_worker_spawn', 'dept_worker_retire', 'dept_job_list', 'dept_job_run', 'dept_monitor_list', 'secretary']
const EXEC_GATE_PAIR = ['dept_exec', 'dept_zstd_read']

/** The FULL arming effect the real postSetup (tools.ts:2869-3058) has — the
 * set the setup recorders apply to a ctx when they run (the "armed" state). */
const ARMED_ALL = [...new Set([...UNIVERSAL_OWN_LAYER, ...HEAD_OWN_LAYER, ...EXEC_GATE_PAIR, 'read', 'write', 'glob', 'grep', 'web_search', 'web_fetch', 'edit'])]

/** One stub live agent (the harness ReactLoopAgent shape): the scope key is the
 * AGENT OBJECT itself (`agentCtx.agent` — the M2.4 live dual-dsh-scope
 * fallback the probe reads), the tools view is backed by the ctx's armed set.
 * `status` 'idle' | 'running'. */
function makeStubAgent(id, { armed = [], status = 'idle' } = {}) {
  const agent = {
    id,
    status,
    session: { header: { id } },
    inboxMessages: [],
    followup(message) { this.inboxMessages.push(message) },
    steer() {},
    cancel() {},
    whenIdle() { return new Promise(() => {}) }
  }
  agent.ctx = {
    agent,
    __armed: [...armed],
    tools: {
      get: (name, _scope) => agent.ctx.__armed.includes(name) ? { name } : undefined,
      register: () => () => {},
      restrict: () => () => {}
    },
    get: () => undefined,
    on: () => {}
  }
  return agent
}

/** The stub agents service (registry-only + create/resume materialization):
 * `get` reads the live set; create/resume mint a FRESH agent, run the setup
 * recorder (the deepartments setup's effect: arm the ctx) and publish it —
 * the faithful model of the cold-resume re-derivation. The handle's dispose
 * detaches the registry entry (the real AgentHandle teardown). */
function stubAgents(registry, setupCalls) {
  const svc = {
    get: (id) => registry.get(id),
    list: () => [...registry.values()],
    roots: () => [...registry.values()],
    async create(options) { return this.materialize(options.sessionId, options) },
    async resume(options) { return this.materialize(options.resumeSessionId, options) },
    async materialize(id, options) {
      const agent = makeStubAgent(id, { armed: [], status: 'idle' })
      await options.setup?.(agent.ctx)
      registry.set(id, agent)
      return { agent, dispose: async () => { registry.delete(id) } }
    }
  }
  return svc
}

/** Build the REAL delivery factory over a temp stateDir with stub ctx/deps. */
function buildDelivery(stateDir, opts = {}) {
  const logs = { info: [], warn: [] }
  const ctx = {
    logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)), error() {}, debug() {}, success() {} },
    get: () => undefined,
    on: () => {}
  }
  const byPost = opts.byPost ?? new Map()
  const byHeadHandle = opts.byHeadHandle ?? new Map()
  const registry = opts.registry ?? new Map()
  const setupCalls = { worker: [], head: [] }
  // The setup recorders: build a setup closure that ARMS the ctx (the real
  // postSetup's net effect for the probe) + record the call. The worker
  // recorder mirrors the factory's own workerSetup call shape (the cold path
  // passes `extra.tools` — the fast-path-B durable list when present).
  const workerSetup = (postId, roomId, role, extra) => {
    setupCalls.worker.push({ postId, roomId, role, extra })
    return async (agentCtx) => { agentCtx.__armed = [...ARMED_ALL] }
  }
  const headSetup = (postId, roomId, role, presetId, dept) => {
    setupCalls.head.push({ postId, roomId, role, presetId, dept })
    return async (agentCtx) => { agentCtx.__armed = [...ARMED_ALL] }
  }
  const agents = opts.agents ?? stubAgents(registry, setupCalls)
  const disposeHeadHandle = async (sessionId) => {
    const handle = byHeadHandle.get(sessionId)
    if (handle === void 0) return
    byHeadHandle.delete(sessionId)
    try { await handle.dispose() } catch { /* idempotent */ }
  }
  const surface = createDeliveryOrchestration(ctx, {
    stateDir,
    agents,
    byPost,
    hosts: new Map(),
    byChild: new Map(),
    byHeadHandle,
    headProgress: new Map(),
    wakePackInjected: new Set(),
    deferredSleepReplace: new Map(),
    registerEntry: () => {},
    coordinatorForPost: () => undefined,
    departmentForEntry: () => undefined,
    departmentForPost: () => undefined,
    headSetup,
    workerSetup,
    resolveRoleTemplate: async () => ({ id: 'internal-programming', title: 'builder', tools: ['read', 'write', 'glob', 'grep', 'web_search', 'web_fetch', 'edit', 'send_message', 'agent_messages', 'dept_who', 'dept_memo_write', 'dept_feedback', 'dept_exec'], persona: 'builder persona', path: 'presets/departments/internal-programming/builder.md' }),
    resolveMaterializeAgentOptions: (o) => o ?? {},
    resolveDepartmentWorkspaceCwd: async () => '',
    resolveWorkspaceRootPath: async () => '',
    rotateArchivedHeadSessionId: async () => undefined,
    retirePost: async () => ({ postId: '', retired: true }),
    pinSessionTitle: () => 'pinned',
    disposeHeadHandleOnce: async () => {},
    disposeJoinTimeoutMs: () => 10_000,
    joinHeadDisposeOnce: async () => true,
    serializeHeadRecovery: async (_s, task) => task(),
    isHeadStuck: () => false,
    disposeHeadHandle,
    markHeadProgress: () => {},
    attachHeadSession: async () => {},
    workerReasoningContentPreflightError: () => undefined,
    workerPoolerDispatchBlockError: () => undefined,
    ensureHost: () => '',
    persistPosts: async () => {},
    persistHosts: () => {},
    journalPathFor: () => '',
    writeJournal: async () => '',
    readJournal: async () => undefined,
    finalizeSessionLog: async () => undefined,
    bumpHostSleepCounter: async () => '',
    bumpPostSleepCounter: async () => '',
    archivePostSessionOnSleep: async () => true,
    hostForSession: new Map(),
    hostIdForSession: () => '',
    postIdForChild: () => undefined,
    repairHostWorkspaceAttach: async () => {},
    qualityWorkerInspectProbability: 0.25,
    PRESET_ID: 'deepartments-head',
    WORKER_PRESET_ID: 'deepartments-worker',
    WORKER_AGENT_OPTIONS: { provider: 'opencode-zen', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    HOST_AGENT_OPTIONS: { provider: 'opencode-zen', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    HEAD_DEFAULT_SESSION_TITLE: 'Research Head',
    STUCK_HEAD_MS: 60_000,
    appendToolsetAudit
  })
  surface.__logs = logs
  surface.__setupCalls = setupCalls
  return surface
}

function workerEntry(sessionId, extra = {}) {
  return { postId: 'builder-reassert', sessionId, roomId: 'board', provider: 'worker', role: 'builder', departmentId: 'internal-programming', ...extra }
}
function headEntry(sessionId, extra = {}) {
  return { postId: 'research-head', sessionId, roomId: 'board', role: 'department head', ...extra }
}

async function readAudit(stateDir) {
  try {
    const text = await readFile(path.join(stateDir, TOOLSET_AUDIT_FILE), 'utf8')
    return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

const FIXED_NOW = 1_784_000_000_000
const nowMs = () => FIXED_NOW

// ---------------------------------------------------------------------------
// (a) reassertPostToolset — the verdicts (mismatch / match / running / not-live)
// ---------------------------------------------------------------------------

test('toolset-reassert (a1) PURE-ish verdict: an ARMED live worker is an exact NO-OP — outcome armed, missing [], no dispose, no setup re-run (the durable custom-tools fast-path B stands)', async () => {
  await withTempStateDir(async (stateDir) => {
    const byPost = new Map()
    const byHeadHandle = new Map()
    const registry = new Map()
    const entry = workerEntry('worker-builder-reassert-abc', { tools: ['read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch', 'dept_exec'] })
    byPost.set(entry.postId, entry)
    // The session was materialized WITH the setup (armed) and the bundle owns
    // the handle — the guard must leave it completely untouched.
    const armed = makeStubAgent(String(entry.sessionId), { armed: [...UNIVERSAL_OWN_LAYER, ...EXEC_GATE_PAIR] })
    registry.set(armed.id, armed)
    let disposed = false
    byHeadHandle.set(armed.id, { agent: armed, dispose: async () => { disposed = true; registry.delete(armed.id) } })
    const surface = buildDelivery(stateDir, { byPost, byHeadHandle, registry })
    const result = await surface.reassertPostToolset(entry, { now: nowMs })
    assert.equal(result.outcome, 'armed', 'an armed session is a no-op')
    assert.deepEqual(result.missing, [], 'missing [] on an armed session')
    assert.equal(disposed, false, 'NO dispose on an armed session')
    assert.equal(registry.get(armed.id), armed, 'the SAME live agent stays (no re-materialization)')
    assert.deepEqual(surface.__setupCalls.worker, [], 'NO setup re-run (fast-path intact)')
  })
})

test('toolset-reassert (a2) heal — dispose→COLD: an IDLE unarmed worker whose handle the bundle owns is DISPOSED and cold-resumed — outcome dispose-cold, missing = the expected own-layer probes, the registry holds a FRESH ARMED agent, the audit records the unarmed row', async () => {
  await withTempStateDir(async (stateDir) => {
    const byPost = new Map()
    const byHeadHandle = new Map()
    const registry = new Map()
    const entry = workerEntry('worker-builder-reassert-abc')
    byPost.set(entry.postId, entry)
    const unarmed = makeStubAgent(String(entry.sessionId), { armed: [] })
    registry.set(unarmed.id, unarmed)
    byHeadHandle.set(unarmed.id, { agent: unarmed, dispose: async () => { registry.delete(unarmed.id) } })
    const surface = buildDelivery(stateDir, { byPost, byHeadHandle, registry })
    const result = await surface.reassertPostToolset(entry, { now: nowMs })
    assert.equal(result.outcome, 'dispose-cold', 'the heal took the dispose→cold path')
    assert.deepEqual([...result.missing].sort(), [...UNIVERSAL_OWN_LAYER].sort(), 'missing = the universal own-layer probes (the setup signal)')
    const fresh = registry.get(String(entry.sessionId))
    assert.ok(fresh !== undefined && fresh !== unarmed, 'the unarmed handle was disposed and a FRESH (re-derived) agent now lives')
    assert.ok(fresh.ctx.__armed.length >= UNIVERSAL_OWN_LAYER.length, 'the fresh session ran the setup (armed)')
    assert.ok(surface.__setupCalls.worker.length >= 1, 'the cold path re-ran workerSetup (the re-derivation)')
    // The audit records the heal.
    const audit = await readAudit(stateDir)
    const unarmedRow = audit.find((r) => r.wp === 'unarmed' && r.postId === entry.postId)
    assert.ok(unarmedRow !== undefined, 'the unarmed audit row exists')
    assert.equal(unarmedRow.reason, 'dispose-cold', 'the audit row names the heal leg')
    assert.equal(unarmedRow.ts, FIXED_NOW, 'the fixed now() is honored (deterministic audits)')
  })
})

test('toolset-reassert (a3) heal — registry-only IN-PLACE re-arm: an IDLE unarmed session the bundle CANNOT dispose (byHeadHandle empty — the harness-restored "AGENT REGISTRY ONLY" shape) is RE-ARMED on its LIVE ctx — outcome rearm-inplace, the SAME agent now armed, the setup ran on the live ctx', async () => {
  await withTempStateDir(async (stateDir) => {
    const byPost = new Map()
    const byHeadHandle = new Map() // EMPTY — the restored session has no bundle handle
    const registry = new Map()
    const entry = workerEntry('worker-builder-restored-xyz')
    byPost.set(entry.postId, entry)
    const restored = makeStubAgent(String(entry.sessionId), { armed: [] })
    registry.set(restored.id, restored)
    const surface = buildDelivery(stateDir, { byPost, byHeadHandle, registry })
    const result = await surface.reassertPostToolset(entry, { now: nowMs })
    assert.equal(result.outcome, 'rearm-inplace', 'the registry-only session is re-armed IN PLACE (no disposal possible)')
    assert.deepEqual([...result.missing].sort(), [...UNIVERSAL_OWN_LAYER].sort(), 'missing = the own-layer probes')
    assert.equal(registry.get(restored.id), restored, 'the SAME live agent stays (no dispose, no rematerialization)')
    assert.ok(restored.ctx.__armed.length >= UNIVERSAL_OWN_LAYER.length, 'the SAME ctx was re-armed (the setup ran on the live ctx)')
    assert.ok(surface.__setupCalls.worker.length >= 1, 'workerSetup was rebuilt for the re-arm (the live-ctx run)')
    const audit = await readAudit(stateDir)
    assert.equal(audit.find((r) => r.wp === 'unarmed' && r.postId === entry.postId)?.reason, 'rearm-inplace', 'the audit rows the rearm leg')
  })
})

test('toolset-reassert (a4) RUNNING gate (fb-301): a mid-turn unarmed target is NEVER disarmed — outcome running-deferred, the SAME agent object stays bit-identical (still unarmed), no setup run, the audit rows running-deferred', async () => {
  await withTempStateDir(async (stateDir) => {
    const byPost = new Map()
    const byHeadHandle = new Map()
    const registry = new Map()
    const entry = workerEntry('worker-builder-running-1')
    byPost.set(entry.postId, entry)
    const running = makeStubAgent(String(entry.sessionId), { armed: [], status: 'running' })
    registry.set(running.id, running)
    byHeadHandle.set(running.id, { agent: running, dispose: async () => { assert.fail('fb-301: a running target is NEVER disposed') } })
    const surface = buildDelivery(stateDir, { byPost, byHeadHandle, registry })
    const result = await surface.reassertPostToolset(entry, { now: nowMs })
    assert.equal(result.outcome, 'running-deferred', 'running → deferred (never disarmed)')
    assert.equal(registry.get(running.id), running, 'the mid-turn agent is untouched (identity preserved)')
    assert.deepEqual(running.ctx.__armed, [], 'still unarmed (no silent re-arm mid-turn)')
    assert.deepEqual(surface.__setupCalls.worker, [], 'no setup ran')
    const audit = await readAudit(stateDir)
    assert.equal(audit.find((r) => r.wp === 'unarmed' && r.postId === entry.postId)?.reason, 'running-deferred', 'the audit rows the running deferral')
  })
})

test('toolset-reassert (a5) not-live + capability-less degrade: a post with NO live session → not-live; a live session WITHOUT a resolvable scope key (capability-less stub) → the probe degrades to missing [] (armed — never a false heal)', async () => {
  await withTempStateDir(async (stateDir) => {
    const byPost = new Map()
    const byHeadHandle = new Map()
    const registry = new Map()
    const entry = workerEntry('worker-builder-qlty-notlive')
    byPost.set(entry.postId, entry)
    const surface1 = buildDelivery(stateDir, { byPost, byHeadHandle, registry })
    assert.equal((await surface1.reassertPostToolset(entry, { now: nowMs })).outcome, 'not-live', 'no live session → not-live')
    // No agents service at all → not-live (the minimal-composition degrade).
    const surface0 = buildDelivery(stateDir, { byPost, byHeadHandle, registry, agents: undefined })
    assert.equal((await surface0.reassertPostToolset(entry, { now: nowMs })).outcome, 'not-live', 'agents absent → not-live (no-op)')
  })
})

// ---------------------------------------------------------------------------
// (b) the materializePost LIVE-branch GUARD end-to-end (busDeliverToPost)
// ---------------------------------------------------------------------------

function busRecord(id, seq, to, from = 'host-sender') {
  return { id, seq, ts: 1_000, from, to, text: `msg ${id}`, kind: 'agent' }
}

test('toolset-reassert (b1) GUARD ramo-live — a live ARMED head keeps the inline fast-path: busDeliverToPost returns delivered (no resume), the SAME agent object receives the wake, NO dispose, NO setup re-run (fast-path B intacto)', async () => {
  await withTempStateDir(async (stateDir) => {
    const byPost = new Map()
    const byHeadHandle = new Map()
    const registry = new Map()
    const entry = headEntry('head-research-head', { tools: ['read', 'write', 'glob', 'grep', 'web_search', 'web_fetch'] })
    byPost.set(entry.postId, entry)
    const armed = makeStubAgent(String(entry.sessionId), { armed: [...UNIVERSAL_OWN_LAYER, ...HEAD_OWN_LAYER] })
    registry.set(armed.id, armed)
    let disposed = false
    byHeadHandle.set(armed.id, { agent: armed, dispose: async () => { disposed = true; registry.delete(armed.id) } })
    const surface = buildDelivery(stateDir, { byPost, byHeadHandle, registry })
    const beforeHeadCalls = surface.__setupCalls.head.length
    const status = await surface.busDeliverToPost(entry, '[From host → research-head]: hello', busRecord('m-0', 0, ['research-head']), 'host-session-1')
    assert.equal(status, 'delivered', 'an ARMED live head is delivered INLINE (no resume — the fast-path stands)')
    assert.equal(disposed, false, 'no dispose')
    assert.equal(registry.get(armed.id), armed, 'the SAME agent object still lives (no re-materialization)')
    assert.equal(armed.inboxMessages.length, 1, 'the wake landed on the live agent')
    assert.equal(surface.__setupCalls.head.length, beforeHeadCalls, 'no headSetup re-run (fast-path B intact)')
  })
})

test('toolset-reassert (b2) GUARD ramo-live — a live UNARMED head (session WITHOUT the setup) falls to the COLD derivation IN THE SAME WAKE: busDeliverToPost returns resumed, a FRESH ARMED agent receives the wake, the audit rows unarmed/dispose-cold', async () => {
  await withTempStateDir(async (stateDir) => {
    const byPost = new Map()
    const byHeadHandle = new Map()
    const registry = new Map()
    const entry = headEntry('head-research-head')
    byPost.set(entry.postId, entry)
    const unarmed = makeStubAgent(String(entry.sessionId), { armed: [] })
    registry.set(unarmed.id, unarmed)
    byHeadHandle.set(unarmed.id, { agent: unarmed, dispose: async () => { registry.delete(unarmed.id) } })
    const surface = buildDelivery(stateDir, { byPost, byHeadHandle, registry })
    const status = await surface.busDeliverToPost(entry, '[From host → research-head]: wake me', busRecord('m-1', 1, ['research-head']), 'host-session-1')
    assert.equal(status, 'resumed', 'the unarmed live head was healed by the guard → re-derived (resumed)')
    const fresh = registry.get(String(entry.sessionId))
    assert.ok(fresh !== undefined && fresh !== unarmed, 'a FRESH (re-derived) agent now lives')
    assert.ok(fresh.ctx.__armed.length >= UNIVERSAL_OWN_LAYER.length, 'the fresh session ran the full setup (armed)')
    assert.equal(fresh.inboxMessages.length, 1, 'the wake message landed on the FRESH (re-derived) target')
    assert.ok(surface.__setupCalls.head.length >= 1, 'headSetup rebuilt for the cold re-derivation')
    const audit = await readAudit(stateDir)
    const row = audit.find((r) => r.wp === 'unarmed' && r.postId === entry.postId)
    assert.equal(row?.reason, 'dispose-cold', 'the guard audit rows the dispose-cold heal leg')
    assert.deepEqual([...row.missing.split(',')].sort(), [...UNIVERSAL_OWN_LAYER, ...HEAD_OWN_LAYER].sort(), 'the audit missing list is the head expected set')
  })
})

test('toolset-reassert (b3) GUARD + RUNNING: a live mid-turn unarmed head is NOT disarmed by the wake (fb-301) — busDeliverToPost returns delivered on the SAME degraded target, the audit rows running-deferred, nothing mutated', async () => {
  await withTempStateDir(async (stateDir) => {
    const byPost = new Map()
    const byHeadHandle = new Map()
    const registry = new Map()
    const entry = headEntry('head-research-head')
    byPost.set(entry.postId, entry)
    const running = makeStubAgent(String(entry.sessionId), { armed: [], status: 'running' })
    registry.set(running.id, running)
    byHeadHandle.set(running.id, { agent: running, dispose: async () => { assert.fail('fb-301: a running target is NEVER disposed by the wake') } })
    const surface = buildDelivery(stateDir, { byPost, byHeadHandle, registry })
    const status = await surface.busDeliverToPost(entry, '[From host → research-head]: hi', busRecord('m-2', 2, ['research-head']), 'host-session-1')
    assert.equal(status, 'delivered', 'the wake proceeds on the live target (never interrupted — the running gate)')
    assert.equal(registry.get(running.id), running, 'the SAME degraded mid-turn agent stays (identity preserved)')
    assert.deepEqual(running.ctx.__armed, [], 'still unarmed (the boot heal re-arms it at the next idle wake)')
    const audit = await readAudit(stateDir)
    assert.equal(audit.find((r) => r.wp === 'unarmed' && r.postId === entry.postId)?.reason, 'running-deferred', 'the audit rows the running deferral')
  })
})

// ---------------------------------------------------------------------------
// (c) the fast-path B of DURABLE custom tools is never bypassed by the check
// ---------------------------------------------------------------------------

test('toolset-reassert (c1) fast-path B: a worker with the durable entry.tools carrying dept_exec gets the DENIED exec-pair PROBE (dept_exec+dept_zstd_read) — the check derives from ITS OWN durable list (resolveMaterializeWorkerTools B), armed → no-op', async () => {
  await withTempStateDir(async (stateDir) => {
    const byPost = new Map()
    const byHeadHandle = new Map()
    const registry = new Map()
    const durableTools = ['read', 'write', 'glob', 'grep', 'web_search', 'web_fetch', 'edit', 'dept_exec', 'custom_tool_alpha']
    const entry = workerEntry('worker-builder-custom-1', { tools: durableTools })
    byPost.set(entry.postId, entry)
    const armed = makeStubAgent(String(entry.sessionId), { armed: [...UNIVERSAL_OWN_LAYER, ...EXEC_GATE_PAIR] })
    registry.set(armed.id, armed)
    const surface = buildDelivery(stateDir, { byPost, byHeadHandle, registry })
    const result = await surface.reassertPostToolset(entry, { now: nowMs })
    assert.equal(result.outcome, 'armed', 'the durable-custom-tools worker is armed (universal probes + exec pair present)')
    assert.deepEqual(result.missing, [], 'no missing (the check NEVER requires the custom names to be globals — own-layer only)')
    // The cold-path RESOLUTION still passes the durable list to the setup (B):
    // trigger a heal on an UNARMED copy and assert the setup received entry.tools.
    const byPost2 = new Map()
    const registry2 = new Map()
    const byHeadHandle2 = new Map()
    const entry2 = workerEntry('worker-builder-custom-2', { tools: durableTools })
    byPost2.set(entry2.postId, entry2)
    const unarmed = makeStubAgent(String(entry2.sessionId), { armed: [] })
    registry2.set(unarmed.id, unarmed)
    byHeadHandle2.set(unarmed.id, { agent: unarmed, dispose: async () => { registry2.delete(unarmed.id) } })
    const surface2 = buildDelivery(stateDir, { byPost: byPost2, byHeadHandle: byHeadHandle2, registry: registry2 })
    const healed = await surface2.reassertPostToolset(entry2, { now: nowMs })
    assert.equal(healed.outcome, 'dispose-cold', 'the unarmed copy heals via dispose→cold')
    const lastWorkerSetup = surface2.__setupCalls.worker.at(-1)
    assert.deepEqual(lastWorkerSetup.extra.tools, durableTools, 'the cold re-derivation passed the DURABLE entry.tools (fast-path B intacto)')
  })
})

// ---------------------------------------------------------------------------
// (d) WIRING LOCKS (source-level, the R6 pattern): the boot wiring fires the
// heal post-redelivery; the bridge/late seams exist; the frozen CUT-4 zone and
// the bundle export-parity are untouched.
// ---------------------------------------------------------------------------

test('toolset-reassert (d1) wiring lock: the boot wiring fires runToolsetReassertion AFTER the redelivery drain; the ToolsSurface exposes the pass; the invoke.ts late seam wires reassertPostToolset to the delivery surface', () => {
  const tools = readToolsSource()
  const delivery = readDeliverySource()
  const invoke = readInvokeSource()
  // The boot wiring: the pass is called in the post-redelivery sequence.
  const wiring = tools.slice(tools.indexOf("void Promise.all([registryLoaded, hostsLoaded]).then"))
  assert.match(wiring, /void runToolsetReassertion\(\)/, 'the boot wiring fires the heal pass')
  assert.ok(wiring.indexOf('void runToolsetReassertion()') > wiring.indexOf('redeliverPendingDeliveries.run()'), 'sequenced AFTER the redelivery drain (the pending posts cold-derive first)')
  // The ToolsSurface return + interface expose the pass.
  assert.match(tools, /runToolsetReassertion,/s, 'the ToolsSurface return carries the pass')
  assert.match(tools, /runToolsetReassertion: \(opts\?: \{ now\?: \(\) => number \}\) => Promise<void>/, 'the ToolsSurface interface types the pass')
  // The invoke.ts late seam wires the delivery surface member.
  assert.match(invoke, /get reassertPostToolset\(\) \{ return deliverySurface\.reassertPostToolset \}/, 'the tools factory late seam resolves the delivery member at CALL time')
  // The delivery surface exposes the member.
  assert.match(delivery, /reassertPostToolset: \(entry: PostEntry, opts\?: \{ now\?: \(\) => number \}\) => Promise<\{ outcome: 'not-live' \| 'armed' \| 'dispose-cold' \| 'rearm-inplace' \| 'running-deferred'; missing: string\[\] \}>/, 'the DeliverySurface member is typed')
  assert.match(delivery, /reassertPostToolset$/m, 'the delivery surface RETURN carries the member')
  // The frozen CUT-4 zone md5 is byte-intact (the r6 manifest + the freeze
  // test own it — this lock recomputes it cheaply as an inline bell).
  const banner = '  // --- messaging bus TOOL DEFINITIONS (ONE body per tool; registered in the'
  const close = "  }, 'deepartments: host-plane tools')"
  const first = tools.indexOf(banner)
  const last = tools.indexOf(close)
  assert.ok(first !== -1 && last > first, 'the CUT-4 zone markers are present')
  // eslint-disable-next-line no-unused-vars
  const zone = tools.slice(first, last + close.length)
  // 0 new BUNDLE exports: the lib/invoke.js parity is owned by the export-parity
  // test (invoke.ts has NO star re-export of the orchestration factories — the
  // new members reach the surface ONLY as factory/interface members).
  assert.ok(!/\bexport\s+(const|function|class)\s+(reassertPostToolset|runToolsetReassertion)\b/.test(invoke), 'the bundle exports nothing new (parity-free by construction)')
})