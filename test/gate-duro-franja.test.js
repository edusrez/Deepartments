// dsh-deepartments — LANE GATE DURO franja (post-mortem PEAK 2026-09-09,
// ítem 1 — D-Q6 «no suplir la sanción temporal con autorizaciones ajenas»).
//
// The HARD PEAK gate for NEW head spawns/dispatches with an ANNOTATED
// override. Covers:
//   (a) the PURE franja predicate (`franjaGateDeferred` — the semantic twin of
//       the wfd-nudge `nudgeFranjaDeferred`): ABSENT org.pacing → legacy,
//       enabled:false → DISARM, PEAK → true, VALLE → false (fixed clocks);
//   (b) the durable override LEDGER (`appendPacingOverrideLedger` →
//       <stateDir>/pacing-overrides.jsonl — {ts, tool, agentId, departmentId,
//       postId|jobId, reason, franja}; best-effort, never throws);
//   (c) the FACTORY gate seam (`franjaDispatchGate` — the SAME closure the
//       dept_worker_spawn / dept_job_run engines AND the legacy dept_post_create
//       tool call): PEAK blocks without an override (the EARLY error cites the
//       franja + the peakOverride parameter), a NON-EMPTY override passes AND
//       records the ledger row, an EMPTY reason is NEVER accepted (a silent
//       override is impossible), VALLE / enabled:false / ABSENT pass, and the
//       P4 `deepartments.pacing` policy substitution wins over the pure path;
//   (d) the REAL engines through the composed bundle (the spawn-factory
//       pattern — real job definition + real role template + stub agents +
//       temp stateDir): dept_job_run in PEAK (armed) rejects EARLY with ZERO
//       materialization; the ANNOTATED override runs it AND writes the ledger;
//       VALLE passes; an ABSENT org.pacing keeps the legacy no-op (0
//       regression); and a BARE engine call in PEAK (no gatePacing flag — the
//       W1 scheduler / parallel-monitor daemon routes) RUNS — the D1 exemption
//       by construction;
//   (e) dept_post_create's shared seam (tool name + postId in the ledger) +
//       the source wiring assert (the legacy tool calls franjaDispatchGate
//       with its args.peakOverride).
// Hermetic: temp stateDirs (withTempStateDir), fixed clocks injected at the
// pure/factory level, composed boots with a temp stateDir + stub agents —
// NEVER the live state. Tests run under plain `node --test` against the
// COMPILED lib (pnpm build first — AGENTS.md rule 5).
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  franjaGateDeferred,
  appendPacingOverrideLedger,
  PACING_OVERRIDES_FILE,
  createSpawnOrchestration
} from '../packages/dshd-orchestration/lib/spawn.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

/** Temp stateDir harness (the withTempStateDir pattern of the suite). */
async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-gate-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

// Fixed UTC anchors (the pacing.test.js convention): 2026-08-24 is a MONDAY,
// 2026-08-29 a SATURDAY — the default franja is Mon-Fri hours {1,2,3,6,7,8,9}.
const MONDAY = Date.UTC(2026, 7, 24)
const SATURDAY = Date.UTC(2026, 7, 29)

// ---------------------------------------------------------------------------
// (a) PURE predicate — the semantic twin of nudgeFranjaDeferred
// ---------------------------------------------------------------------------

test('GATE DURO (a) pure: franjaGateDeferred — PEAK (Mon-Fri, horas {1,2,3,6,7,8,9} UTC) → true; VALLE (weekend / non-peak hour) → false; org.pacing ABSENT → the pre-pacing legacy; enabled:false → the DISARM (even at a PEAK hour); an org whose OWN window says the instant is PEAK follows ITS knobs', () => {
  const defaults = { enabled: true } // the code defaults: Mon-Fri, {1,2,3,6,7,8,9}, ±30 min
  assert.equal(franjaGateDeferred(defaults, MONDAY + 8 * 3_600_000), true, 'Monday 08:00 UTC → PEAK → the gate engages')
  assert.equal(franjaGateDeferred(defaults, SATURDAY + 8 * 3_600_000), false, 'Saturday 08:00 UTC → VALLE (weekend) → pass')
  assert.equal(franjaGateDeferred(defaults, MONDAY + 11 * 3_600_000), false, 'Monday 11:00 UTC → VALLE (after the last peak hour + its 30-min end-buffer → 10:30) → pass')
  assert.equal(franjaGateDeferred(undefined, MONDAY + 8 * 3_600_000), false, 'org.pacing ABSENT → the pre-pacing legacy (an undeclared franja cannot gate — 0 regression)')
  assert.equal(franjaGateDeferred({ enabled: false, peakWindows: { weekday: [1, 2, 3, 4, 5], hours: [1, 2, 3, 6, 7, 8, 9] } }, MONDAY + 8 * 3_600_000), false, 'enabled:false → the knob DISARM restores the legacy (even at a real PEAK hour)')
  assert.equal(franjaGateDeferred({ peakWindows: { weekday: [6], hours: [8] } }, SATURDAY + 8 * 3_600_000), true, 'an org whose window says Saturday 08:00 is PEAK follows ITS knobs (the window wins over the defaults)')
})

test('GATE DURO (a) pure: the 30-min edge buffer is respected — [h:00 − buffer, (h+1):00 + buffer), start inclusive / end exclusive; the weekday filter applies BEFORE the buffer (a Friday window never creeps into Saturday)', () => {
  const pacing = { enabled: true, peakWindows: { weekday: [1, 2, 3, 4, 5], hours: [8] }, peakBufferMs: 1_800_000 }
  const mon = (h, min) => MONDAY + (h * 60 + min) * 60_000
  assert.equal(franjaGateDeferred(pacing, mon(7, 29)), false, 'Monday 07:29 → VALLE (1 min before the buffer edge 07:30)')
  assert.equal(franjaGateDeferred(pacing, mon(7, 30)), true, 'Monday 07:30 → PEAK (the buffer start edge is INCLUSIVE)')
  assert.equal(franjaGateDeferred(pacing, mon(9, 29)), true, 'Monday 09:29 → PEAK (inside the buffer end edge 09:30)')
  assert.equal(franjaGateDeferred(pacing, mon(9, 30)), false, 'Monday 09:30 → VALLE (the buffer end edge is EXCLUSIVE)')
  assert.equal(franjaGateDeferred(pacing, SATURDAY + 7 * 3_600_000 + 30 * 60_000), false, 'Saturday 07:30 → VALLE (the weekday filter applies BEFORE the buffer)')
})

// ---------------------------------------------------------------------------
// (b) PURE + FS — the durable override ledger (pacing-overrides.jsonl)
// ---------------------------------------------------------------------------

test('GATE DURO (b) ledger: appendPacingOverrideLedger writes the EXACT row {ts, tool, agentId, departmentId, postId|jobId, reason, franja} to <stateDir>/pacing-overrides.jsonl (append-only, mkdir first, one row per line) — and NEVER throws on an unwritable target', async () => {
  await withTempStateDir(async (stateDir) => {
    const row = {
      ts: MONDAY + 8 * 3_600_000,
      tool: 'dept_job_run',
      agentId: 'internal-programming-head',
      departmentId: 'internal-programming',
      jobId: 'system-health-report',
      reason: 'fix-saga fb-276 — recovery canary en PEAK',
      franja: { peak: true, untilHhMm: '10:30', span: '01:00-10:00' }
    }
    await appendPacingOverrideLedger(stateDir, row)
    const text = await readFile(path.join(stateDir, PACING_OVERRIDES_FILE), 'utf8')
    assert.deepEqual(JSON.parse(text), row, 'the ledger row is persisted verbatim (the audit contract)')
    // Append-only: a second row lands on its own line.
    const row2 = { ...row, ts: row.ts + 60_000, tool: 'dept_worker_spawn', postId: 'builder', reason: 'segundo override' }
    await appendPacingOverrideLedger(stateDir, row2)
    const lines = (await readFile(path.join(stateDir, PACING_OVERRIDES_FILE), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 2, 'two rows → two lines (append-only)')
    assert.deepEqual(JSON.parse(lines[1]), row2, 'the second row appends verbatim')
    // FAIL-SOFT: an unwritable target (the stateDir path is a FILE) never throws.
    await withTempStateDir(async (badDir) => {
      await writeFile(path.join(badDir, 'parent-is-file'), 'x', 'utf8')
      await appendPacingOverrideLedger(path.join(badDir, 'parent-is-file', 'nested'), row)
      // reached without throwing — the audit write degrades, the dispatch proceeds
    })
  })
})

// ---------------------------------------------------------------------------
// (c) FACTORY gate seam — franjaDispatchGate (the SAME closure the three tools
//     of head call: dept_worker_spawn / dept_job_run engines + dept_post_create)
// ---------------------------------------------------------------------------

/** Build the REAL spawn factory over a temp stateDir with stub ctx/deps (the
 * fb132-retired dual-surface stub pattern). Only the members the gate seam
 * touches are needed at call time (stateDir / config.org.pacing / ctx.get of
 * the pacing service / ctx.logger); the rest stay inert. */
function buildGateFactory(stateDir, { pacing, ctxGet } = {}) {
  const warns = []
  const ctx = {
    logger: { info() {}, warn: (m) => warns.push(String(m)), error() {}, debug() {}, success() {} },
    get: (name) => (ctxGet !== undefined ? ctxGet(name) : undefined),
    on: () => {}
  }
  const config = { stateDir, org: { departments: [], ...(pacing !== undefined ? { pacing } : {}) } }
  const surface = createSpawnOrchestration(ctx, {
    stateDir,
    repoRoot: '/nonexistent',
    config,
    agents: undefined,
    byPost: new Map(),
    byHeadHandle: new Map(),
    registerEntry: () => {},
    coordinatorForPost: () => undefined,
    dshHome: () => '/nonexistent',
    pinSessionTitle: () => 'pinned',
    WORKER_PRESET_ID: 'deepartments-worker',
    WORKER_AGENT_OPTIONS: {},
    late: {}
  })
  surface.__warns = warns
  return surface
}

/** The sharp test window (the pacing.test.js makeTick convention): Monday
 * 08:00-09:00 UTC, buffer 0 → the fixed clock needs no 30-min alignment. */
const SHARP = { enabled: true, peakWindows: { weekday: [1], hours: [8] }, peakBufferMs: 0 }
const PEAK_AT = MONDAY + 8 * 3_600_000 // Monday 08:00 UTC — inside the sharp window
const VALLE_AT = MONDAY + 11 * 3_600_000 // Monday 11:00 UTC — outside

test('GATE DURO (c) seam: franjaDispatchGate BLOCKS in PEAK without an override — the EARLY error cites the franja (hasta HH:MM UTC), the peakOverride parameter and the audit ledger', async () => {
  await withTempStateDir(async (stateDir) => {
    const surface = buildGateFactory(stateDir, { pacing: SHARP })
    const err = await surface.franjaDispatchGate({
      tool: 'dept_job_run', agentId: 'internal-programming-head', departmentId: 'internal-programming', jobId: 'system-health-report', nowMs: PEAK_AT
    })
    assert.match(err, /\[deepartments\] franja PEAK \(org\.pacing\)/, 'the gate names the franja PEAK')
    assert.match(err, /hasta 09:00 UTC/, 'the gate cites when the current franja ends (08:00 window + 0 buffer → 09:00)')
    assert.match(err, /peakOverride/, 'the gate names the peakOverride parameter')
    assert.match(err, /pacing-overrides\.jsonl/, 'the gate names the audit ledger')
    // Nothing was recorded: the ledger file does not exist.
    assert.equal(existsSync(path.join(stateDir, PACING_OVERRIDES_FILE)), false, 'a BLOCKED dispatch never writes the ledger')
  })
})

test('GATE DURO (c) seam: in PEAK a NON-EMPTY peakOverride PASSES and records the durable ledger row EXACTLY ({ts, tool, agentId, departmentId, postId|jobId, reason, franja:{peak:true, untilHhMm, span}}) + the logger.warn (D3 — ledger + logger ONLY, never a message)', async () => {
  await withTempStateDir(async (stateDir) => {
    const surface = buildGateFactory(stateDir, { pacing: SHARP })
    const gateError = await surface.franjaDispatchGate({
      tool: 'dept_worker_spawn', peakOverride: '  fix-saga fb-276 — recovery canary en PEAK  ', nowMs: PEAK_AT,
      agentId: 'internal-programming-head', departmentId: 'internal-programming', postId: 'builder'
    })
    assert.equal(gateError, undefined, 'the ANNOTATED override authorizes the dispatch')
    const rows = (await readFile(path.join(stateDir, PACING_OVERRIDES_FILE), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(rows.length, 1, 'exactly one ledger row')
    assert.deepEqual(rows[0], {
      ts: PEAK_AT,
      tool: 'dept_worker_spawn',
      agentId: 'internal-programming-head',
      departmentId: 'internal-programming',
      postId: 'builder',
      reason: 'fix-saga fb-276 — recovery canary en PEAK',
      franja: { peak: true, untilHhMm: '09:00', span: '08:00-09:00' }
    }, 'the ledger row shape is EXACT (the reason is trimmed; ts = the injected clock; franja of the instant)')
    assert.ok(surface.__warns.some((w) => w.includes('OVERRIDE anotado') && w.includes('dept_worker_spawn')), 'the logger.warn marks the override (D3 — no message is sent)')
    // The jobId variant (dept_job_run engine) records jobId instead of postId.
    const surface2 = buildGateFactory(stateDir, { pacing: SHARP })
    await surface2.franjaDispatchGate({
      tool: 'dept_job_run', peakOverride: 're-ancla de digest a VALLE', nowMs: PEAK_AT,
      agentId: 'internal-programming-head', departmentId: 'internal-programming', jobId: 'quality-daily'
    })
    const rows2 = (await readFile(path.join(stateDir, PACING_OVERRIDES_FILE), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(rows2[1].jobId, 'quality-daily', 'a job run records jobId in the ledger row')
    assert.equal(rows2[1].postId, undefined, 'no postId alongside a jobId (postId|jobId)')
  })
})

test('GATE DURO (c) seam: an EMPTY / whitespace peakOverride is NEVER accepted in PEAK — the block cites the NON-EMPTY justification (a silent override is impossible); VALLE, enabled:false and ABSENT org.pacing all PASS without any ledger row', async () => {
  await withTempStateDir(async (stateDir) => {
    // (1) Empty reason in PEAK → blocked with the non-empty-justification error.
    const surface = buildGateFactory(stateDir, { pacing: SHARP })
    const emptyErr = await surface.franjaDispatchGate({
      tool: 'dept_post_create', peakOverride: '   ', nowMs: PEAK_AT,
      agentId: 'internal-programming-head', departmentId: 'internal-programming', postId: 'researcher-alpha'
    })
    assert.match(emptyErr, /franja PEAK \(org\.pacing\)/, 'an empty reason still blocks in PEAK')
    assert.match(emptyErr, /justificación NO vacía/, 'the block explains the NON-EMPTY requirement')
    assert.equal(existsSync(path.join(stateDir, PACING_OVERRIDES_FILE)), false, 'a silent/empty override never records a ledger row')
    // (2) VALLE → pass, no ledger.
    const valleSurface = buildGateFactory(stateDir, { pacing: SHARP })
    assert.equal(await valleSurface.franjaDispatchGate({ tool: 'dept_worker_spawn', nowMs: VALLE_AT, agentId: 'h', departmentId: 'ipd', postId: 'builder' }), undefined, 'VALLE passes without an override')
    // (3) enabled:false at a PEAK instant → pass (the DISARM restores the legacy).
    const offSurface = buildGateFactory(stateDir, { pacing: { ...SHARP, enabled: false } })
    assert.equal(await offSurface.franjaDispatchGate({ tool: 'dept_job_run', nowMs: PEAK_AT, agentId: 'h', departmentId: 'ipd', jobId: 'x' }), undefined, 'enabled:false → OFF even at a PEAK instant')
    // (4) ABSENT org.pacing → pass (the pre-pacing legacy — 0 regression).
    const absentSurface = buildGateFactory(stateDir)
    assert.equal(await absentSurface.franjaDispatchGate({ tool: 'dept_worker_spawn', nowMs: PEAK_AT, agentId: 'h', departmentId: 'ipd', postId: 'builder' }), undefined, 'org.pacing ABSENT → legacy (no gate)')
    assert.equal(existsSync(path.join(stateDir, PACING_OVERRIDES_FILE)), false, 'no ledger row in any pass case')
  })
})

test('GATE DURO (c) seam: the P4 policy substitution wins over the pure path — a substituted deepartments.pacing ALWAYS-PEAK surface blocks at a VALLE-config instant, an ALWAYS-VALLE surface passes at a PEAK-config instant (the service-first consumption, dshd-health:7820-7826 pattern)', async () => {
  await withTempStateDir(async (stateDir) => {
    // Substituted always-PEAK at a VALLE instant (config window says VALLE).
    const peakSvc = buildGateFactory(stateDir, {
      pacing: SHARP,
      ctxGet: (name) => (name === 'deepartments.pacing' ? { isPeakAt: () => true } : undefined)
    })
    const blocked = await peakSvc.franjaDispatchGate({ tool: 'dept_worker_spawn', nowMs: VALLE_AT, agentId: 'h', departmentId: 'ipd', postId: 'builder' })
    assert.match(blocked, /franja PEAK \(org\.pacing\)/, 'the substituted always-PEAK policy gates even though the org window says VALLE')
    // Substituted always-VALLE at a PEAK instant → pass (the policy dominates).
    const valleSvc = buildGateFactory(stateDir, {
      pacing: SHARP,
      ctxGet: (name) => (name === 'deepartments.pacing' ? { isPeakAt: () => false } : undefined)
    })
    assert.equal(await valleSvc.franjaDispatchGate({ tool: 'dept_job_run', nowMs: PEAK_AT, agentId: 'h', departmentId: 'ipd', jobId: 'x' }), undefined, 'the substituted always-VALLE policy passes at a PEAK-config instant')
    assert.equal(existsSync(path.join(stateDir, PACING_OVERRIDES_FILE)), false, 'no ledger row on the pass')
  })
})

// ---------------------------------------------------------------------------
// (d) REAL engines through the composed bundle (the spawn-factory pattern —
//     real job definition + real role template + stub agents, temp stateDir)
// ---------------------------------------------------------------------------

/** Stub webServer/webRuntime/connection so the bundle RPC mount effect runs
 * (the smoke-boot pattern). */
class StubWebServer extends Service {
  constructor(ctx) { super(ctx, 'webServer'); this.routes = [] }
  register(route) { this.routes.push(route); return () => {} }
}
class StubWebRuntime extends Service {
  constructor(ctx) { super(ctx, 'webRuntime'); this.trustedHosts = [] }
}
class StubConnection extends Service {
  constructor(ctx) { super(ctx, 'connection'); this.trustedHosts = [] }
}

/** A MINIMAL agents service (the bootPlugin shape — create/get/list/roots) so
 * the composed boot can materialize the driven spawn without a real harness. */
class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.createCalls = []
  }
  get(id) { return this.store.get(String(id)) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  async create(options) {
    this.createCalls.push(options)
    const agent = {
      id: String(options.sessionId),
      status: 'running',
      ctx: this.ctx,
      session: { events: [], get seq() { return this.events.length }, snapshotEvents() { return this.events }, requestHeader() { return undefined } },
      followup() {},
      cancel() {},
      async whenIdle() {}
    }
    this.store.set(String(options.sessionId), agent)
    return { agent, dispose: async () => { this.store.delete(String(options.sessionId)) } }
  }
  async resume(options) {
    return this.create({ ...options, sessionId: options.resumeSessionId })
  }
}

/** The department the composed bundle drives (the spawn-factory shape) + a
 * REAL durable head entry persisted in posts.json BEFORE the boot (the
 * registry loads it into the bundle's byPost — the engine resolves the head
 * from there). */
const DEPARTMENT = { id: 'internal-programming', name: 'Internal Programming', roomId: 'room-ipd' }
const HEAD_POST_JSON = {
  'internal-programming-head': {
    sessionId: 'session-ipd-head-1',
    roomId: 'room-ipd',
    agentPreset: 'deepartments-head'
  }
}

/** The REAL job + role of the repo (the spawn-factory E2 fixtures). */
const JOB_ID = 'system-health-report'
const JOB_PATH = path.join(REPO_ROOT, 'docs', 'departments', 'internal-programming', 'jobs', `${JOB_ID}.md`)
const ROLE_PATH = path.join(REPO_ROOT, 'presets', 'departments', 'internal-programming', 'builder.md')

/** The REAL Loader composition of the dev-profile subset (dshd-core + the 6 P1
 * packages + dshd-orchestration + the bundle, in order — the spawn-factory
 * smokeBoot). The passed org carries the PACING knob (the gate source). */
async function smokeBoot(stateDir, org) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  new StubWebServer(root)
  new StubWebRuntime(root)
  new StubConnection(root)
  const agentsStub = new StubAgents(root)
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return { root, loader, pluginCtx, agentsStub, dispose: () => loaderFiber.dispose() }
}

/** Boot the composed bundle with a pre-seeded head + the given org, and
 * resolve the durable head entry from the composed catalog (poll — the
 * registry loads posts.json asynchronously). */
async function bootWithHead(stateDir, org) {
  await writeFile(path.join(stateDir, 'posts.json'), JSON.stringify(HEAD_POST_JSON, null, 2), 'utf8')
  const env = await smokeBoot(stateDir, org)
  const catalog = env.pluginCtx().get('deepartments.catalog')
  let headEntry
  for (let i = 0; i < 100; i++) {
    headEntry = catalog?.byPost?.get('internal-programming-head')
    if (headEntry !== undefined) break
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.ok(headEntry !== undefined, 'the durable head entry resolved in the composed catalog')
  return { ...env, headEntry }
}

const readJsonLines = async (stateDir, file) =>
  existsSync(path.join(stateDir, file)) ? (await readFile(path.join(stateDir, file), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const readPosts = async (stateDir) => (existsSync(path.join(stateDir, 'posts.json')) ? JSON.parse(await readFile(path.join(stateDir, 'posts.json'), 'utf8')) : {})
const workersOf = (posts) => Object.values(posts).filter((e) => e?.provider === 'worker')

/** The org.pacing window that GUARANTEES PEAK at the REAL current UTC instant
 * (the policy-substitution determinism trick: the window covers the current
 * weekday + hour, buffer 0). */
function peakForcedOrg() {
  const now = new Date()
  const curDow = now.getUTCDay() === 0 ? 7 : now.getUTCDay()
  return { departments: [DEPARTMENT], pacing: { enabled: true, peakWindows: { weekday: [curDow], hours: [now.getUTCHours()] }, peakBufferMs: 0 } }
}
/** GUARANTEED VALLE: a window on a weekday that is NEVER the current one. */
function valleForcedOrg() {
  const now = new Date()
  const curDow = now.getUTCDay() === 0 ? 7 : now.getUTCDay()
  const altDow = curDow === 7 ? 1 : curDow + 1
  return { departments: [DEPARTMENT], pacing: { enabled: true, peakWindows: { weekday: [altDow], hours: [1] }, peakBufferMs: 0 } }
}

test('GATE DURO (d) dept_job_run engine (REAL composed): in PEAK with the gate ARMED (gatePacing:true — the dept_job_run head route) the run is REJECTED EARLY with the franja error and ZERO materialization — no agents.create of a worker, no durable worker entry, no first bus message, no ledger row', async () => {
  assert.ok(existsSync(JOB_PATH) && existsSync(ROLE_PATH), 'the real job definition + role template exist in the repo')
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, agentsStub, headEntry, dispose } = await bootWithHead(stateDir, peakForcedOrg())
    try {
      const spawnSvc = pluginCtx().get('deepartments.spawn')
      assert.ok(spawnSvc?.runJobForDepartment !== undefined, 'deepartments.spawn.runJobForDepartment is the run engine (service-first)')
      await assert.rejects(
        spawnSvc.runJobForDepartment(DEPARTMENT, headEntry, JOB_ID, { callerSessionId: headEntry.sessionId, gatePacing: true }),
        /\[deepartments\] franja PEAK \(org\.pacing\): nuevos spawns\/despachos pausados en PEAK/,
        'the armed gate rejects the PEAK run BEFORE anything is materialized'
      )
      // EARLY: zero materialization — no agent avatar, no durable worker entry,
      // no first bus message, no ledger (the dispatch never happened).
      assert.equal(agentsStub.createCalls.some((c) => c.meta?.agentPreset === 'deepartments-worker'), false, 'no worker avatar was created')
      assert.equal(workersOf(await readPosts(stateDir)).length, 0, 'no durable worker entry was registered')
      if (existsSync(path.join(stateDir, 'messages.jsonl'))) {
        const messages = await readJsonLines(stateDir, 'messages.jsonl')
        assert.equal(messages.some((r) => Array.isArray(r.to) && r.to.includes('system-health-report')), false, 'no first bus message was delivered to a job worker')
      }
      assert.equal(existsSync(path.join(stateDir, PACING_OVERRIDES_FILE)), false, 'a blocked dispatch never writes the override ledger')
    } finally {
      dispose()
    }
  })
})

test('GATE DURO (d) dept_job_run engine (REAL composed): in PEAK the ANNOTATED override (peakOverride NON-EMPTY) RUNS the job AND records the ledger row {tool:dept_job_run, jobId, reason, franja:{peak:true,…}}; in VALLE the armed run passes WITHOUT an override; a BARE run in PEAK (no gatePacing flag — the scheduler daemon route) passes by construction (D1 exemption)', async () => {
  // (1) PEAK + override → runs + ledger row.
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, agentsStub, headEntry, dispose } = await bootWithHead(stateDir, peakForcedOrg())
    try {
      const spawnSvc = pluginCtx().get('deepartments.spawn')
      const outcome = await spawnSvc.runJobForDepartment(DEPARTMENT, headEntry, JOB_ID, {
        callerSessionId: headEntry.sessionId, gatePacing: true, peakOverride: 'fix-saga fb-276 — recovery canary en PEAK'
      })
      assert.equal(outcome.jobId, JOB_ID, 'the overridden run completes')
      const rows = await readJsonLines(stateDir, PACING_OVERRIDES_FILE)
      assert.equal(rows.length, 1, 'ONE ledger row for the override')
      assert.equal(rows[0].tool, 'dept_job_run', 'tool = dept_job_run')
      assert.equal(rows[0].agentId, 'internal-programming-head', 'agentId = the authorizing head')
      assert.equal(rows[0].departmentId, 'internal-programming', 'departmentId = the dispatch department')
      assert.equal(rows[0].jobId, JOB_ID, 'jobId = the run job')
      assert.equal(rows[0].reason, 'fix-saga fb-276 — recovery canary en PEAK', 'reason = the ANNOTATED justification')
      assert.equal(rows[0].franja.peak, true, 'franja of the instant = peak')
      assert.match(rows[0].franja.untilHhMm, /^\d{2}:\d{2}$/, 'untilHhMm is the «hasta HH:MM UTC»')
      assert.match(rows[0].franja.span, /^\d{2}:\d{2}-\d{2}:\d{2}$/, 'span is the merged peak span')
      // The worker DID materialize (approved + annotated).
      await new Promise((r) => setTimeout(r, 150))
      const workers = workersOf(await readPosts(stateDir))
      assert.ok(workers.some((w) => w.jobId === JOB_ID), 'the overridden run spawned the job worker')
    } finally {
      dispose()
    }
  })
  // (2) VALLE + armed → passes without an override, no ledger.
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, headEntry, dispose } = await bootWithHead(stateDir, valleForcedOrg())
    try {
      const spawnSvc = pluginCtx().get('deepartments.spawn')
      const outcome = await spawnSvc.runJobForDepartment(DEPARTMENT, headEntry, JOB_ID, { callerSessionId: headEntry.sessionId, gatePacing: true })
      assert.equal(outcome.jobId, JOB_ID, 'the armed run passes in VALLE')
      assert.equal(existsSync(path.join(stateDir, PACING_OVERRIDES_FILE)), false, 'a VALLE run needs no override / no ledger row')
      // Re-run idempotency cleanup is not needed (temp stateDir), but the W1
      // scheduler daemon may re-fire — irrelevant to the assertions.
    } finally {
      dispose()
    }
  })
  // (3) BARE run in PEAK (no gatePacing — the scheduler/daemon route) → runs.
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, headEntry, dispose } = await bootWithHead(stateDir, peakForcedOrg())
    try {
      const spawnSvc = pluginCtx().get('deepartments.spawn')
      const outcome = await spawnSvc.runJobForDepartment(DEPARTMENT, headEntry, JOB_ID, { callerSessionId: headEntry.sessionId })
      assert.equal(outcome.jobId, JOB_ID, 'a BARE engine call in PEAK runs (the daemon routes pass no gatePacing flag — EXEMPT by design, D1)')
      assert.equal(existsSync(path.join(stateDir, PACING_OVERRIDES_FILE)), false, 'a bare call never writes the ledger')
    } finally {
      dispose()
    }
  })
})

test('GATE DURO (d) dept_job_run engine (REAL composed): an ABSENT org.pacing keeps the pre-pacing legacy — the armed run passes at the REAL current instant (0 regression for every composition without the knob)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, headEntry, dispose } = await bootWithHead(stateDir, { departments: [DEPARTMENT] })
    try {
      const spawnSvc = pluginCtx().get('deepartments.spawn')
      const outcome = await spawnSvc.runJobForDepartment(DEPARTMENT, headEntry, JOB_ID, { callerSessionId: headEntry.sessionId, gatePacing: true })
      assert.equal(outcome.jobId, JOB_ID, 'org.pacing ABSENT → legacy (the gate is a no-op, 0 regression)')
    } finally {
      dispose()
    }
  })
})

test('GATE DURO (d) dept_worker_spawn engine (REAL composed): in PEAK with the gate ARMED (gatePacing:true) the spawn is REJECTED EARLY (zero materialization); with the ANNOTATED override it spawns AND records the ledger row {tool:dept_worker_spawn, postId (slug base), reason}; a BARE spawn in PEAK runs (the parallel-monitor daemon route — D1 exemption)', async () => {
  // (1) PEAK + armed, no override → rejected early.
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, agentsStub, headEntry, dispose } = await bootWithHead(stateDir, peakForcedOrg())
    try {
      const spawnSvc = pluginCtx().get('deepartments.spawn')
      await assert.rejects(
        spawnSvc.spawnWorkerForDepartment(DEPARTMENT, headEntry, { role: 'builder', task: 'gate test', gatePacing: true }),
        /\[deepartments\] franja PEAK \(org\.pacing\)/,
        'the armed spawn gate rejects in PEAK'
      )
      assert.equal(agentsStub.createCalls.some((c) => c.meta?.agentPreset === 'deepartments-worker'), false, 'no worker avatar was created')
      assert.equal(workersOf(await readPosts(stateDir)).length, 0, 'no durable worker entry was registered')
    } finally {
      dispose()
    }
  })
  // (2) PEAK + override → spawns + ledger row with postId.
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, headEntry, dispose } = await bootWithHead(stateDir, peakForcedOrg())
    try {
      const spawnSvc = pluginCtx().get('deepartments.spawn')
      const outcome = await spawnSvc.spawnWorkerForDepartment(DEPARTMENT, headEntry, {
        role: 'builder', task: 'gate overridden', gatePacing: true, peakOverride: 'respuesta a health-alert — no espera a VALLE'
      })
      assert.equal(outcome.role ?? outcome.title, outcome.title, 'the overridden spawn completes')
      const rows = await readJsonLines(stateDir, PACING_OVERRIDES_FILE)
      assert.equal(rows.length, 1, 'ONE ledger row')
      assert.equal(rows[0].tool, 'dept_worker_spawn', 'tool = dept_worker_spawn')
      assert.equal(rows[0].postId, 'builder', 'postId = the raw role as the slug base (no jobId at the early gate)')
      assert.equal(rows[0].reason, 'respuesta a health-alert — no espera a VALLE', 'reason = the ANNOTATED justification')
      assert.equal(rows[0].franja.peak, true, 'franja = peak')
    } finally {
      dispose()
    }
  })
  // (3) BARE spawn in PEAK (no gatePacing — the parallel-monitor daemon) → runs.
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, headEntry, dispose } = await bootWithHead(stateDir, peakForcedOrg())
    try {
      const spawnSvc = pluginCtx().get('deepartments.spawn')
      const outcome = await spawnSvc.spawnWorkerForDepartment(DEPARTMENT, headEntry, { role: 'builder', task: 'bare daemon spawn' })
      assert.ok(outcome.workerId !== undefined, 'a BARE spawn in PEAK runs (the monitor passes no gatePacing — EXEMPT by design, D1)')
      assert.equal(existsSync(path.join(stateDir, PACING_OVERRIDES_FILE)), false, 'a bare call never writes the ledger')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// (e) dept_post_create — the LEGACY head tool shares the SAME seam
// ---------------------------------------------------------------------------

test('GATE DURO (e) dept_post_create seam: the SAME franjaDispatchGate the legacy tool calls blocks in PEAK without an override and records the ledger row {tool:dept_post_create, postId} with the ANNOTATED override; the compiled tools source wires the tool to the shared seam with args.peakOverride', async () => {
  await withTempStateDir(async (stateDir) => {
    const surface = buildGateFactory(stateDir, { pacing: SHARP })
    // Blocked in PEAK without an override.
    const err = await surface.franjaDispatchGate({
      tool: 'dept_post_create', nowMs: PEAK_AT, agentId: 'internal-programming-head', departmentId: 'internal-programming', postId: 'researcher-alpha'
    })
    assert.match(err, /franja PEAK \(org\.pacing\)/, 'dept_post_create blocks in PEAK without an override')
    assert.equal(existsSync(path.join(stateDir, PACING_OVERRIDES_FILE)), false, 'no ledger row on the block')
    // Annotated override → the ledger row carries tool 'dept_post_create' + postId.
    const surface2 = buildGateFactory(stateDir, { pacing: SHARP })
    const pass = await surface2.franjaDispatchGate({
      tool: 'dept_post_create', peakOverride: 'legacy reset del worker residente', nowMs: PEAK_AT,
      agentId: 'internal-programming-head', departmentId: 'internal-programming', postId: 'researcher-alpha'
    })
    assert.equal(pass, undefined, 'the annotated override authorizes the legacy create')
    const rows = await readJsonLines(stateDir, PACING_OVERRIDES_FILE)
    assert.equal(rows[0].tool, 'dept_post_create', 'tool = dept_post_create')
    assert.equal(rows[0].postId, 'researcher-alpha', 'postId = the legacy worker postId')
    assert.equal(rows[0].reason, 'legacy reset del worker residente', 'reason = the ANNOTATED justification')
  })
  // SOURCE wiring: the legacy tool execute calls the shared seam with its own
  // tool name + the args.peakOverride (the movement-lock assert pattern).
  const toolsSrc = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts'), 'utf8')
  assert.match(toolsSrc, /franjaDispatchGate\(\{\s*tool: 'dept_post_create'/, 'dept_post_create wires the shared gate seam (tool name)')
  assert.match(toolsSrc, /peakOverride: args\.peakOverride/s, 'dept_post_create threads the peakOverride parameter into the seam')
})