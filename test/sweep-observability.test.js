// dsh-deepartments — SWEEP OBSERVABILITY test (FINISHER lane, 2026-09-04,
// addendum 4 — m-812, the fb-27 closure health datum): the redelivery-sweep
// observability layer of the LANE ② non-boot re-drive sweep.
//   - the ARMING log: the tools factory logs «[deepartments] redelivery sweep
//     armed …» when `startRedeliverySweep` arms the interval (the synchronous
//     in-fiber call at factory build) — the flag d of the host;
//   - the SWEEP STATE source: the DeliveryRedeliverer's `sweepState()` —
//     {cycles, lastCycleTs?, preparedStuckRemaining?} observed inside
//     `sweepDue` (a fire = a cycle; the prepared-stuck residue = the fb-27
//     closure criterion). NEVER synthesized — absent until a cycle observed it;
//   - the HEARTBEAT datum: runHealthDaemonTick writes `sweep` ONLY when the
//     per-tick dep provides it (absent → omitted — same pattern as
//     sessionSurface/nRestarts/crashStreak).
// Method (LANE ② src-native): register the ts-src-loader + import the SOURCE
// directly; 0 builds, 0 real APIs (temp stateDir + stub ctx/logger only).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'

// The src modules with WORKSPACE value imports load DYNAMIC (top-level await)
// AFTER the register() call — the ts-src-loader hook targets repo-.ts importers.
const C = await import('../packages/dshd-core/src/messages.ts')
const { DeliveryRedeliverer, G2_DRAIN_SEED_DEFAULT_LIMIT } = C
const H = await import('../packages/dshd-health/src/index.ts')
const { runHealthDaemonTick, readHealthHeartbeatFile } = H
const T = await import('../packages/dshd-orchestration/src/tools.ts')
const { createToolsOrchestration } = T

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sweep-obs-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// -------------------------------------------------------------------------
// 1. THE ARMING LOG — the tools factory logs «redelivery sweep armed» at build
//    (the synchronous in-fiber arming) + the surface exposes the sweep state.
// -------------------------------------------------------------------------
const neverResolve = () => new Promise(() => {})
let factoryDisposers = []
after(() => {
  for (const dispose of factoryDisposers.splice(0)) {
    try { dispose() } catch { /* the stub effect disposers are inert */ }
  }
})

/** A stub ctx sufficient for the factory CONSTRUCTION seams (get/on/effect/
 * tools/logger). The logger CAPTURES info lines (the arming-log assert). */
function capturingFactoryCtx(disposers, logs) {
  const logger = {
    warn() {},
    info(m) { logs.push(String(m)) },
    error() {},
    debug() {},
    success() {}
  }
  const ctx = {
    logger,
    get: (key) => {
      if (key === 'deepartments.wakepack') {
        return {
          assembleWakePack: async () => 'stub-wakepack',
          assembleWakeSnapshot: async () => 'stub-snapshot',
          buildCondensedRoster: () => [],
          preStepHandler: async () => {}
        }
      }
      return undefined
    },
    tools: { get: () => undefined, register: () => ({}) },
    effect: (fn) => { disposers.push(fn) },
    on: () => () => {}
  }
  return ctx
}

/** Build ONE tools factory (the sweep arms synchronously at build). */
function buildToolsFactory({ stateDir, logs }) {
  const ctx = capturingFactoryCtx(factoryDisposers, logs)
  const posts = new Map()
  const hosts = new Map()
  return createToolsOrchestration(ctx, {
    config: { health: {} },
    org: { departments: [] },
    stateDir,
    repoRoot: REPO_ROOT,
    byPost: posts,
    byHeadHandle: new Map(),
    coordinatorForPost: () => undefined,
    postIdForChild: () => undefined,
    registerEntry: () => {},
    departmentForPost: () => undefined,
    departmentForEntry: () => undefined,
    agentPresets: undefined,
    disposingHeads: new Map(),
    PRESET_ID: 'deepartments-head',
    HEAD_BASE_TOOLS: [],
    DENIED_POST_TOOLS: new Set(),
    OWN_LAYER_POST_TOOLS: new Set(),
    activeMembersSchema: undefined,
    renderActiveRoster: () => '',
    activeCatalogMembers: () => [],
    memoWriteTool: () => ({ name: 'memo', description: 'x', parameters: {}, output: { schema: {}, render: () => [] } }),
    postRetireTool: { name: 'dept_post_retire', description: 'x', parameters: {}, output: { schema: {}, render: () => [] } },
    pinSessionTitle: async () => 'pinned',
    WORKER_PRESET_ID: 'deepartments-worker',
    WORKER_AGENT_OPTIONS: { provider: 'opencode-zen', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    execFileP: async () => ({ stdout: '', stderr: '' }),
    DEPT_EXEC_DEFAULT_ROOTS: [],
    DEPT_EXEC_TIMEOUT_MS: 1000,
    DEPT_EXEC_MAX_BUFFER: 1024,
    deptExecDenyReason: () => undefined,
    DEPT_ZSTD_READ_MAX_LINES: 100,
    runDeptZstdRead: async () => ({ ok: true, lines: [], truncated: false, totalLines: 0 }),
    deptZstdReadDenyReason: () => undefined,
    resolveParallelMonitorConfig: () => [],
    readParallelMonitorsState: () => ({ monitors: {}, recent: [], spawns: [] }),
    appendToolsetAudit: () => {},
    headPresetIdFor: () => '',
    createSecretaryTool: () => ({ name: 'secretary', description: 'x', parameters: {}, output: { schema: {}, render: () => [] } }),
    secretaryConfig: () => ({ provider: 'opencode-zen' }),
    buildAgentRows: () => [],
    spawn: {},
    registry: { byChild: new Map(), byPost: posts, hosts },
    qualityWorkerInspectProbability: 0.25,
    headProgress: new Map(),
    hosts,
    HOST_ATTACH_REPAIR_TIMEOUT_MS: 250,
    HOST_ATTACH_REPAIR_RETRY_MS: 50,
    HOST_AGENT_OPTIONS: { provider: 'opencode-zen', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    dshHome: () => path.join(tmpdir(), 'sweep-obs-dsh-home'),
    registryLoaded: neverResolve(),
    hostsLoaded: neverResolve(),
    stuckNow: () => Date.now(),
    STUCK_HEAD_MS: 60_000,
    HEAD_DEFAULT_SESSION_TITLE: 'Research Head',
    sleepTool: () => ({ name: 'dept_sleep', description: 'x', parameters: {}, output: { schema: {}, render: () => [] } }),
    subagents: undefined,
    wakePackService: {},
    hostIdForSession: () => undefined,
    readJournal: async () => undefined,
    journalPathFor: () => '',
    refreshPresence: () => {},
    savePresence: async () => {},
    notifyHostPresence: () => {},
    presenceCache: {},
    assembleHeartbeat: () => undefined,
    headRotationJournalStatus: async () => ({ stale: false, fresh: true, text: '' }),
    verifyRotateReason: () => 'ok',
    resolveSessionProjCachePath: () => '',
    deliverDaemonNotice: async () => 'queued',
    captureSchedulerAutoRunFailure: async () => {},
    buildCatalogRows: () => [],
    wakePackInjected: {},
    deferredSleepReplace: async () => {},
    computeHostSleepSurfacePlan: () => undefined,
    readPresenceStateFile: async () => undefined,
    ensureHost: async () => {},
    writeJournal: async () => {},
    bumpHostSleepCounter: async () => {},
    bumpPostSleepCounter: async () => {},
    activeMembersSchemaFallback: undefined,
    late: {
      messagesStoreReady: Promise.resolve({ get: async () => undefined }),
      deliverBusRecord: async () => 'queued',
      isDormantRecipient: () => false
    }
  })
}

test('sweep-observability [arming log + state] the factory logs «redelivery sweep armed» AND exposes {armed, cycles, …} (never synthesized)', async () => {
  await withTempDir(async (stateDir) => {
    const logs = []
    const tools = buildToolsFactory({ stateDir, logs })
    // (a) the ARMING log — the flag d of the host (the in-fiber arming fires
    // synchronously at factory build; the log is the ONE clear line).
    assert.ok(logs.some((l) => /redelivery sweep armed \(every \d+ ms;/.test(l)), 'the factory logged the «redelivery sweep armed» line at build')
    // (b) the surface exposes the sweep state: armed=true (the interval is
    // up), cycles=0 (no fire yet — a truthfully absent lastCycleTs).
    const state = tools.redeliverySweepState()
    assert.ok(state !== undefined, 'the tools surface exposes redeliverySweepState()')
    assert.equal(state.armed, true, 'armed=true right after the synchronous arming')
    assert.equal(state.cycles, 0, 'cycles=0 before any fire (a real counter, never synthesized)')
    assert.equal(state.lastCycleTs, undefined, 'lastCycleTs ABSENT before the first cycle (never synthesized)')
    assert.equal(state.preparedStuckRemaining, undefined, 'preparedStuckRemaining ABSENT before the first cycle (never synthesized)')
  })
})

// -------------------------------------------------------------------------
// 2. THE SWEEP-STATE SOURCE — the DeliveryRedeliverer's sweepState(): a fire
//    counts, the last-ts + the prepared-stuck residue come from the cycle.
// -------------------------------------------------------------------------
test('sweep-observability [redeliverer] sweepDue fires count + the last prepared-stuck residue is observed (fb-27 closure datum)', async () => {
  await withTempDir(async (stateDir) => {
    const r = new DeliveryRedeliverer(
      {
        stateDir,
        logger: { info() {}, warn() {} },
        recipientAlive: () => true,
        getRecord: async () => ({ id: 'm', from: 'a', to: ['recipient'], text: 'x', kind: 'agent', seq: 1 }),
        resolveCallerSessionId: (from) => from,
        deliver: async () => 'delivered'
      },
      { g2DrainSeedLimit: G2_DRAIN_SEED_DEFAULT_LIMIT }
    )
    // before any fire: cycles 0, both optional fields absent.
    assert.deepEqual(r.sweepState(), { cycles: 0 }, 'pre-cycle state: {cycles: 0} only (lastCycleTs/preparedStuckRemaining absent)')
    // ONE fire on an EMPTY sidecar: a cycle ran, the prepared-stuck residue is
    // observed (0 — the empty ledger has nothing stuck) — the fb-27 datum.
    // P4 (fb-131 — WAKE-SEAM lane): the cycle now ALSO observes the honest
    // prepared-state summary — on the empty ledger every count is 0 and
    // oldestPreparedTs stays ABSENT (there is no prepared row).
    await r.sweepDue(5_000)
    assert.deepEqual(r.sweepState(), { cycles: 1, lastCycleTs: 5_000, preparedStuckRemaining: 0, dormantHeld: 0, noWakeHeld: 0 }, 'one sweepDue fire: cycles 1 + lastCycleTs + the observed 0 residue + the P4 held-class summary (0/0; oldestPreparedTs ABSENT — no prepared row)')
    // a SECOND fire advances the counters (the last-ts moves).
    await r.sweepDue(5_000 + 60_000)
    assert.equal(r.sweepState().cycles, 2, 'the second fire bumps cycles to 2')
    assert.equal(r.sweepState().lastCycleTs, 5_000 + 60_000, 'lastCycleTs tracks the LAST cycle')
    assert.equal(r.sweepState().preparedStuckRemaining, 0, 'preparedStuckRemaining stays the observed residue (0 stuck on the empty ledger)')
    assert.equal(r.sweepState().dormantHeld, 0, 'dormantHeld observes 0 on the empty ledger')
    assert.equal(r.sweepState().noWakeHeld, 0, 'noWakeHeld observes 0 on the empty ledger')
    assert.equal(r.sweepState().oldestPreparedTs, undefined, 'oldestPreparedTs stays ABSENT with no prepared row (never synthesized)')
  })
})

// -------------------------------------------------------------------------
// 3. THE HEARTBEAT DATUM — runHealthDaemonTick writes `sweep` ONLY when the
//    per-tick dep provides it; absent → omitted (the tick never synthesizes).
// -------------------------------------------------------------------------
test('sweep-observability [heartbeat] deps.sweep lands in the heartbeat; ABSENT → the field is omitted', async () => {
  await withTempDir(async (stateDir) => {
    await runHealthDaemonTick({
      now: () => 5_000_000,
      stateDir,
      bootId: 'boot-sweep-1',
      config: { health: {} },
      hosts: [],
      sweep: { armed: true, cycles: 3, lastCycleTs: 4_900_000, preparedStuckRemaining: 0 }
    })
    const hb = readHealthHeartbeatFile(stateDir)
    assert.ok(hb !== undefined, 'the real tick wrote the heartbeat')
    assert.deepEqual(hb.sweep, { armed: true, cycles: 3, lastCycleTs: 4_900_000, preparedStuckRemaining: 0 }, 'the heartbeat carries the FULL sweep datum when the wiring provided it')
    // absent sweep dep → the field is OMITTED (never synthesized).
    await rm(path.join(stateDir, 'health-heartbeat.json'), { force: true })
    await runHealthDaemonTick({
      now: () => 5_000_100,
      stateDir,
      bootId: 'boot-sweep-2',
      hosts: [],
      notifyHost: async () => {}
    })
    const hb2 = readHealthHeartbeatFile(stateDir)
    assert.equal(hb2.bootId, 'boot-sweep-2')
    assert.equal(hb2.sweep, undefined, 'absent deps.sweep → the heartbeat OMITS the sweep field (never synthesized)')
  })
})