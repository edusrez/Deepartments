// dsh-deepartments — PACING SERVICE-WINDOW tests (builder-361 / run token
// a3f0bf27; owner dispatch «VALLE ABIERTO» ítem 3).
//
// THE DEFECT UNDER TEST: the substitutable pacing policy (`deepartments.pacing`,
// provided by dshd-orchestration) is a PURE PASSTHROUGH — every member forwards
// its `options` argument to the pure dshd-core module verbatim
// (packages/dshd-orchestration/src/index.ts:288-294). The four SERVICE-branch
// call sites invoked it WITHOUT `options`:
//   - packages/dshd-health/src/index.ts:8229-8231 (the work-register-idle franja leg)
//   - packages/dshd-health/src/index.ts:8511-8513 (the transition monitor franja)
//   - packages/dshd-health/src/index.ts:8531-8533 (the transition notice state)
//   - packages/dshd-core/src/wakepack.ts:941-943     (the wake-pack franja line)
// so `resolvePacingWindow(undefined)` applied the CODE DEFAULT buffer
// (PACING_DEFAULT_BUFFER_MS = 1800000 = 30 min) and the CONFIGURED window —
// already resolved on the line above each site (`pacingWindowFromConfig(
// deps.config?.org?.pacing)`) — was DISCARDED. `pacing.ts` is correct and is
// NOT touched (a fix/test inside the pure module proves nothing — fb-512).
//
// THE LABELS (get them RIGHT — the head corrected this in the host's input, and
// the distinction IS the defect): the CONFIGURED value is `peakBufferMs: 0`
// (cordis.patch.yml, the owner change documented in the comment right above it);
// `1800000` (30 min) is the **CODE DEFAULT** (packages/dshd-core/src/pacing.ts:35
// PACING_DEFAULT_BUFFER_MS), NOT the config. Labelling 1800000 as "the configured
// buffer" describes a world with no bug at all.
//
// THE DISCRIMINATING BAND (why this test is not decoration): the config declares
// the SAME hours as the code default ({1,2,3,6,7,8,9}) and ONLY changes the edge
// buffer. Config and default therefore DIVERGE exactly on the buffer-expanded
// edges:
//   [00:30,01:00) · [04:00,04:30) · [05:30,06:00) · [10:00,10:30)
// (both sides: configured VALLE, code default PEAK — the hours are IDENTICAL, so
// ONLY the buffer discriminates). A sample in the MIDDLE of a peak hour is
// INVARIANT to the defect and would prove nothing.
// This suite drives BOTH ends of the list:
//   (a) Monday 2026-08-24 00:45:00 UTC — inside [00:30,01:00);
//   (b) Monday 2026-08-24 10:15:00 UTC — inside [10:00,10:30), the band the LIVE
//       seal PAIR exercises (see test (4)): the durable baseline
//       /.deepartments/pacing-state.json held {franja:"valle", at:10:30:01.187Z}
//       (a write at the 30-min-DEFAULT edge, ~1.19 s after it) while the
//       configured 10:00 edge produced NO rewrite (the same `at` still read
//       ~05:30:17Z ~4.6 h later) — i.e. the live monitor was running the DEFAULT
//       window, which is the defect this fix closes at the service branch.
//
// ACCEPTANCE: this file is RED before the four one-line fixes (the service
// branch answers PEAK / emits no VALLE transition / silences the VALLE leg)
// and GREEN after them. The tests drive the REAL composition
// (dshd-core → the 6 P1 packages → dshd-orchestration → the bundle — the dev
// profile order), so the policy under exercise is the REAL
// dshd-orchestration surface, never a hand-written lookalike.
//
// Style: fixed clocks (deps.now()/DEEPARTMENTS_TEST_NOW), hermetic temp
// stateDirs, the REAL Loader, against the COMPILED lib (pnpm build first —
// AGENTS.md rule 5).
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isPeakAt, pacingWindowFromConfig } from 'dshd-core'
import { runHealthDaemonTick, readPacingState, WORK_REGISTER_IDLE_STATE_FILE, PACING_STATE_FILE } from '../lib/invoke.js'

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

/** 2026-08-24 is a MONDAY (UTC). */
const MON = Date.UTC(2026, 7, 24)
/** The BAND sample: Monday 00:45:00 UTC — inside the discriminating band
 * [00:30,01:00) where the configured buffer (0) and the code default (30 min)
 * disagree. NOT a peak-hour middle: that sample is invariant to the defect. */
const BAND_MS = MON + 45 * 60_000
/** The SECOND band sample: Monday 10:15:00 UTC — inside [10:00,10:30). The same
 * divergence at the LAST edge of the day: the configured window closes the peak
 * at 10:00 (VALLE), the code default keeps it open until 10:30 (PEAK). This is
 * the band the LIVE seal pair exercised (see the header). */
const BAND_2_MS = MON + 10 * 3_600_000 + 15 * 60_000
/** The four buffer-expanded bands, as [startMinute, endMinute) offsets from the
 * sample day's 00:00 UTC. Two shapes: `leading` = the 30 min BEFORE a window
 * opens ([00:30,01:00) and [05:30,06:00) — the default opens, the config has
 * not); `trailing` = the 30 min AFTER a window closes ([04:00,04:30) and
 * [10:00,10:30) — the default is still inside its buffer, the config closed). */
const DIVERGENT_BANDS = [
  { startMin: 30, endMin: 60, kind: 'leading' },
  { startMin: 240, endMin: 270, kind: 'trailing' },
  { startMin: 330, endMin: 360, kind: 'leading' },
  { startMin: 600, endMin: 630, kind: 'trailing' }
]

/** `org.pacing` VERBATIM from cordis.patch.yml:47-57 (the owner config: the
 * same hours as the code default, `peakBufferMs: 0`). */
const PACING_CFG = {
  enabled: true,
  peakWindows: { weekday: [1, 2, 3, 4, 5], hours: [1, 2, 3, 6, 7, 8, 9] },
  peakBufferMs: 0
}
/** The window options the consumers resolve from that config (the parameter
 * the service members must be GIVEN). */
const PACING_WINDOW = pacingWindowFromConfig(PACING_CFG)

const HOSTS = [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }]
const LOGGER = { warn() {}, info() {} }

/** The work-register fixture: one NON-gated §1 pending item (the census input
 * of the work-register-idle VALLE leg). */
const WR_REGISTER = ['## 1. IPD — cola activa', '- **Item A — lane IPD-1** — next: internal-programming-head'].join('\n')

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

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-pacing-service-window-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Boot the REAL dev-profile order (dshd-core → 6 P1 → dshd-orchestration →
 * the bundle) so `deepartments.pacing` is the REAL dshd-orchestration
 * passthrough surface (index.ts:288-295). `org.pacing` is declared in BOTH the
 * core row and the bundle row: this suite isolates the SERVICE-BRANCH
 * consumption (does the caller forward the window it already computed?), not
 * the config-routing question (which row wins is a separate finding). */
async function bootComposed(stateDir) {
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
  const org = { departments: [], pacing: PACING_CFG }
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return { pluginCtx, dispose: () => loaderFiber.dispose() }
}

/** The daemon-tick helper: a FIXED clock (`atMs`, default the 00:45Z band
 * sample), the org.pacing config the tick reads (`deps.config.org.pacing` — the
 * bundle-Config shape the inline daemon path passes), the REAL composed pacing
 * service, recording notifyHost. */
async function tick(stateDir, pacingService, { atMs = BAND_MS, config, notifyHost, extra = {} }) {
  await runHealthDaemonTick({
    now: () => atMs,
    stateDir,
    bootId: 'boot-pacing-service-window',
    config,
    hosts: HOSTS,
    posts: [],
    hostRunning: false,
    sessionContexts: [],
    hostWaits: [],
    pacingService,
    notifyHost,
    logger: LOGGER,
    ...extra
  })
}

// ---------------------------------------------------------------------------
// (0) THE BAND IS DISCRIMINATING — the non-decoration proof (pure, no boot).
// ---------------------------------------------------------------------------

test('PACING service-window (0) the SAMPLE discriminates: at Monday 00:45 UTC the CONFIGURED window (peakBufferMs 0) says VALLE while the CODE DEFAULT (30-min buffer) says PEAK — the hours are identical, only the buffer separates them', () => {
  assert.equal(isPeakAt(new Date(BAND_MS), PACING_WINDOW), false, 'config (bufferMs 0): 00:45 is VALLE — the peak window opens at 01:00')
  assert.equal(isPeakAt(new Date(BAND_MS)), true, 'code default (bufferMs 1800000): 00:45 is PEAK — the window opens at 00:30')
  // The band's bounds (the discriminator is the EDGE, not the hour):
  assert.equal(isPeakAt(new Date(MON + 29 * 60_000), PACING_WINDOW), false, '00:29 → VALLE (config)')
  assert.equal(isPeakAt(new Date(MON + 30 * 60_000), PACING_WINDOW), false, '00:30 → VALLE (config: the default-only edge, inclusive on the DEFAULT side)')
  assert.equal(isPeakAt(new Date(MON + 60 * 60_000), PACING_WINDOW), true, '01:00 → PEAK (config: the nominal window start)')
  // NON-discriminating control (the «decoration» sample this suite refuses):
  assert.equal(isPeakAt(new Date(MON + 8 * 3_600_000), PACING_WINDOW), isPeakAt(new Date(MON + 8 * 3_600_000)), 'a mid-peak-hour sample agrees in BOTH windows — invariant to the defect (never a valid acceptance sample)')
})

test('PACING service-window (0b) the FOUR bands and BOTH ends of the discriminant: in all four buffer-expanded bands the configured window (bufferMs 0) says VALLE exactly where the code default (1800000) says PEAK — the same divergence the live seal pair shows at 10:00 vs 10:30 — and one minute outside each band the two windows AGREE again', () => {
  const labelOf = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}Z`
  for (const { startMin, endMin, kind } of DIVERGENT_BANDS) {
    // Inside the band: configured VALLE vs code default PEAK (the hours are
    // identical — ONLY the buffer discriminates).
    const mid = Math.floor((startMin + endMin) / 2)
    assert.equal(isPeakAt(new Date(MON + mid * 60_000), PACING_WINDOW), false, `${labelOf(mid)} (inside [${labelOf(startMin)},${labelOf(endMin)}), ${kind}): CONFIGURED (bufferMs 0) → VALLE`)
    assert.equal(isPeakAt(new Date(MON + mid * 60_000)), true, `${labelOf(mid)} (inside the band): CODE DEFAULT (1800000) → PEAK`)
    // Band start: the CONFIGURED window is still VALLE (leading: the open has
    // not happened; trailing: the window closed exactly here) while the DEFAULT
    // already says PEAK (its buffer is open on both shapes).
    assert.equal(isPeakAt(new Date(MON + startMin * 60_000), PACING_WINDOW), false, `${labelOf(startMin)} (band start, ${kind}): CONFIGURED → VALLE`)
    assert.equal(isPeakAt(new Date(MON + startMin * 60_000)), true, `${labelOf(startMin)} (band start, ${kind}): the DEFAULT → PEAK (its buffer-expanded window is open here)`)
    // Band end: on a LEADING band the nominal hour OPENS (both windows PEAK);
    // on a TRAILING band the default's buffer expires (both windows VALLE) —
    // i.e. the divergence is EXACTLY the half-open band, never a global flip.
    const configAtEnd = kind === 'leading'
    assert.equal(isPeakAt(new Date(MON + endMin * 60_000), PACING_WINDOW), configAtEnd, `${labelOf(endMin)} (band end, ${kind}): CONFIGURED → ${configAtEnd ? 'PEAK (the nominal hour opens)' : 'VALLE (it closed at the band start)'}`)
    assert.equal(isPeakAt(new Date(MON + endMin * 60_000)), configAtEnd, `${labelOf(endMin)} (band end): the DEFAULT agrees with the CONFIGURED one → the band ends exactly there`)
    // Just before the band both windows AGREE → the band's bounds are exact.
    assert.equal(isPeakAt(new Date(MON + (startMin - 1) * 60_000), PACING_WINDOW), isPeakAt(new Date(MON + (startMin - 1) * 60_000)), `${labelOf(startMin - 1)} (just before the band): BOTH windows agree → the band's lower bound is exact`)
  }
  // The sample this suite drives in the seal-pair tests is the 10:00/10:30
  // pair's interior — a VALLE under the CONFIGURED window, which is why the
  // fixed service branch must answer VALLE there (and why the live write at
  // 10:30:01.187Z is the DEFAULT's signature).
  assert.equal(isPeakAt(new Date(BAND_2_MS), PACING_WINDOW), false, 'Monday 10:15Z → VALLE with the CONFIGURED window (the peak closed at 10:00)')
  assert.equal(isPeakAt(new Date(BAND_2_MS)), true, 'Monday 10:15Z → PEAK with the CODE DEFAULT (it closes at 10:30) — the live seal pair\'s divergence')
})

// ---------------------------------------------------------------------------
// (1) THE WAKE-PACK SITE — packages/dshd-core/src/wakepack.ts:941-943
// ---------------------------------------------------------------------------

test('PACING service-window (1) wake pack: with the REAL deepartments.pacing service composed, the franja line follows the CONFIGURED window at the band sample (VALLE), not the code default (PEAK)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, dispose } = await bootComposed(stateDir)
    const prevNow = process.env.DEEPARTMENTS_TEST_NOW
    try {
      const ctx = pluginCtx()
      const pacingService = ctx.get('deepartments.pacing')
      assert.ok(pacingService !== undefined, 'deepartments.pacing resolves — the REAL dshd-orchestration passthrough service IS composed (so the SERVICE branch is the branch under test)')
      // The service itself is a faithful passthrough — the defect is the CALLER
      // that drops the window (never the pure module, never the service).
      assert.equal(pacingService.isPeakAt(new Date(BAND_MS), PACING_WINDOW), false, 'the service honours the window it is GIVEN (a pure passthrough)')
      // The wake-pack franja resolves through the SERVICE branch (the service
      // is composed) — the configured clock sample is injected via the
      // documented DEEPARTMENTS_TEST_NOW override.
      process.env.DEEPARTMENTS_TEST_NOW = String(BAND_MS)
      const pack = await ctx.get('deepartments.wakepack').assembleWakePack('member-x', path.join(stateDir, 'journals', 'member-x.md'))
      const franja = (pack.match(/Franja:[^\n]*/) ?? ['<none>'])[0]
      assert.match(franja, /Franja: VALLE/, `the franja line follows the CONFIGURED window at 00:45 UTC (got: ${franja})`)
      assert.doesNotMatch(franja, /Franja: PEAK/, 'the code-default buffer (30 min, which would say PEAK at 00:45) is NOT used')
      // The SECOND band sample ([10:00,10:30)) — the one the LIVE seal pair
      // exercises — through the SAME composed service + the same pack.
      process.env.DEEPARTMENTS_TEST_NOW = String(BAND_2_MS)
      const pack2 = await ctx.get('deepartments.wakepack').assembleWakePack('member-x', path.join(stateDir, 'journals', 'member-x.md'))
      const franja2 = (pack2.match(/Franja:[^\n]*/) ?? ['<none>'])[0]
      assert.match(franja2, /Franja: VALLE/, `the franja line follows the CONFIGURED window at 10:15 UTC too — the peak closed at 10:00 (got: ${franja2})`)
      assert.doesNotMatch(franja2, /Franja: PEAK/, 'the code-default buffer would still call 10:15 PEAK (it closes at 10:30) — not used')
    } finally {
      if (prevNow === undefined) delete process.env.DEEPARTMENTS_TEST_NOW
      else process.env.DEEPARTMENTS_TEST_NOW = prevNow
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// (2) THE HEALTH DAEMON WRI LEG — packages/dshd-health/src/index.ts:8229-8231
// ---------------------------------------------------------------------------

test('PACING service-window (2) work-register-idle VALLE leg: with the REAL service composed, the daemon sees VALLE at the band sample and ALERTS (the code default would see PEAK and stay silent)', async () => {
  await withTempStateDir(async (stateDir) => {
    const registerPath = path.join(stateDir, 'WORK-REGISTER.md')
    await writeFile(registerPath, WR_REGISTER, 'utf8')
    // The wri OWN ledger: the quiet window is already elapsed (firstQuietTs in
    // the past) so this single tick evaluates the alert condition.
    await writeFile(path.join(stateDir, WORK_REGISTER_IDLE_STATE_FILE), JSON.stringify({ firstQuietTs: BAND_MS - 2 * 3_600_000 }), 'utf8')
    const { pluginCtx, dispose } = await bootComposed(stateDir)
    try {
      const pacingService = pluginCtx().get('deepartments.pacing')
      assert.ok(pacingService !== undefined, 'the REAL pacing service is composed (the SERVICE branch under test)')
      const alerts = []
      await tick(stateDir, pacingService, {
        config: { health: { workRegisterIdleQuietMs: 0 }, org: { pacing: PACING_CFG } },
        notifyHost: async (hostEntry, frame) => { alerts.push(frame) },
        extra: { workRegisterPath: registerPath }
      })
      assert.ok(
        alerts.some((f) => f.includes('work-register-idle') && f.includes('NO-gateado')),
        `the VALLE leg holds at 00:45 UTC through the SERVICE branch (the configured window) → the work-register-idle ALERT is emitted (frames: ${JSON.stringify(alerts)})`
      )
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// (3) THE HEALTH DAEMON TRANSITION MONITOR — dshd-health/src/index.ts:8511-8513
//     (the franja) + :8531-8533 (the notice state)
// ---------------------------------------------------------------------------

test('PACING service-window (3) transition monitor: with the REAL service composed, the baseline PEAK→VALLE transition at the band sample is detected and notified with the CONFIGURED next transition (hasta 01:00 UTC, not the default 04:30)', async () => {
  await withTempStateDir(async (stateDir) => {
    // A durable baseline recorded one hour earlier as PEAK (the pre-band peak
    // hour 00:00 was PEAK under the default buffer only; the baseline is just
    // the previous franja observation).
    await writeFile(path.join(stateDir, PACING_STATE_FILE), JSON.stringify({ franja: 'peak', at: BAND_MS - 3_600_000 }), 'utf8')
    const { pluginCtx, dispose } = await bootComposed(stateDir)
    try {
      const pacingService = pluginCtx().get('deepartments.pacing')
      assert.ok(pacingService !== undefined, 'the REAL pacing service is composed (the SERVICE branch under test)')
      const calls = []
      await tick(stateDir, pacingService, {
        // The LANE-5 watchdog is knobbed OFF (drain-valle isolation pattern):
        // this test isolates the transition monitor.
        config: { health: { workRegisterIdleEnabled: false }, org: { pacing: PACING_CFG } },
        notifyHost: async (hostEntry, frame, frameKey) => { calls.push({ hostEntry, frame, frameKey }) }
      })
      assert.equal(calls.length, 1, `exactly ONE transition notice (the code default sees peak === peak → NO transition at all) (frames: ${JSON.stringify(calls.map((c) => c.frame))})`)
      assert.match(calls[0].frame, /^\[From deepartments\] Pacing VALLE:/, 'the notice is the VALLE resume frame — the configured window says VALLE at 00:45 UTC')
      assert.match(calls[0].frame, /hasta 01:00 UTC/, 'the notice state (site :8531-8533) carries the CONFIGURED window next transition 01:00 (the code-default window would say 04:30)')
      assert.equal(calls[0].frameKey, 'pacing-transition', 'the notice rides the shared pacing-transition dedupe key')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// (4) THE LIVE SEAL PAIR AS A CONTROL — the [10:00,10:30) band, both arms.
//     LIVE OBSERVATION (owner-labelled by the head), with the CORRECT labels:
//     /.deepartments/pacing-state.json held {"franja":"valle","at":1789468201187}
//     = 2026-09-15T10:30:01.187Z (read 17 s later; mtime 10:30:05.736Z), while
//     the SAME field still read the ~05:30:17Z baseline ~4.6 h later.
//       (i) POSITIVE: with the CODE DEFAULT (30-min buffer) the peak ends at
//           10:30 ⇒ there IS a write, ~1.19 s past the edge (seconds, not
//           minutes) — the seal indexes the DEFAULT window.
//      (ii) NEGATIVE: with the CONFIGURED window (buffer 0) the peak ends at
//           10:00 ⇒ a write was owed at 10:00:1x and did NOT happen.
//     The pair is therefore the defect's live signature. Tests (4a)/(4b) replay
//     the SAME two edges on FIXED clocks through the REAL service: post-fix the
//     signature INVERTS (write at the configured 10:00 edge, NONE at 10:30).
// ---------------------------------------------------------------------------

test('PACING service-window (4a) seal pair, POSITIVE arm: at the CONFIGURED edge 10:00 (bufferMs 0 → the peak closes there) the transition IS detected and the durable seal is written FRESH (+1 s of the edge) as {franja, at} ONLY — the notice frame, not the seal, carries the state text', async () => {
  await withTempStateDir(async (stateDir) => {
    // Baseline: PEAK one minute before the configured edge.
    await writeFile(path.join(stateDir, PACING_STATE_FILE), JSON.stringify({ franja: 'peak', at: BAND_2_MS - 15 * 60_000 }), 'utf8')
    const { pluginCtx, dispose } = await bootComposed(stateDir)
    try {
      const pacingService = pluginCtx().get('deepartments.pacing')
      assert.ok(pacingService !== undefined, 'the REAL pacing service is composed (the SERVICE branch under test)')
      const at = MON + 10 * 3_600_000 + 1_000 // 10:00:01.000Z — +1 s past the CONFIGURED edge
      const calls = []
      await tick(stateDir, pacingService, {
        atMs: at,
        config: { health: { workRegisterIdleEnabled: false }, org: { pacing: PACING_CFG } },
        notifyHost: async (hostEntry, frame, frameKey) => { calls.push({ frame, frameKey }) }
      })
      assert.equal(calls.length, 1, `a write IS owed at the configured 10:00 edge and must happen (frames: ${JSON.stringify(calls.map((c) => c.frame))})`)
      assert.match(calls[0].frame, /^\[From deepartments\] Pacing VALLE:/, 'the peak closed at 10:00 with the CONFIGURED window → the VALLE resume notice')
      // FRESHNESS as an assertion (never a string comparison): the durable seal
      // must sit at the tick instant — seconds after the edge, not minutes.
      const seal = readPacingState(stateDir)
      assert.equal(seal.franja, 'valle', 'the durable seal records the new franja')
      assert.equal(seal.at, at, 'the seal is stamped at the TICK instant (+1 s past the edge) — FRESH by construction of the fixed clock')
      assert.ok(Math.abs(seal.at - (MON + 10 * 3_600_000)) <= 5_000, 'FRESHNESS: |seal.at − configured edge| ≤ 5 s (a real transition write, seconds not minutes)')
      // The seal is {franja, at} ONLY (dshd-health:8518/:8525) — an assertion
      // demanding `atIso`/`untilHhMm` on the seal would reject a GENUINE seal.
      assert.deepEqual(Object.keys(seal).sort(), ['at', 'franja'], 'the durable seal carries exactly {franja, at} — no atIso, no untilHhMm')
      // …while the NOTICE carries the state text (the untilHhMm carrier).
      assert.match(calls[0].frame, /hasta \d{2}:\d{2} UTC/, 'the untilHhMm lives in the NOTICE frame (the only carrier), never in the seal')
      assert.equal(calls[0].frameKey, 'pacing-transition', 'the notice rides the shared pacing-transition dedupe key')
    } finally {
      dispose()
    }
  })
})

test('PACING service-window (4b) seal pair, NEGATIVE arm: at the DEFAULT edge 10:30 at the LIVE seal instants (baseline 10:15 → tick 10:30:01.187Z) there is NO transition — the CONFIGURED window had already closed the peak at 10:00, so no write is owed', async () => {
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, dispose } = await bootComposed(stateDir)
    try {
      const pacingService = pluginCtx().get('deepartments.pacing')
      assert.ok(pacingService !== undefined, 'the REAL pacing service is composed (the SERVICE branch under test)')
      const calls = []
      const notifyHost = async (hostEntry, frame, frameKey) => { calls.push({ frame, frameKey }) }
      const config = { health: { workRegisterIdleEnabled: false }, org: { pacing: PACING_CFG } }
      // The first boot records the baseline: 10:15Z is VALLE under the
      // CONFIGURED window (already closed at 10:00).
      await tick(stateDir, pacingService, { atMs: BAND_2_MS, config, notifyHost })
      assert.equal(calls.length, 0, 'the first boot emits NOTHING (baseline only)')
      assert.equal(readPacingState(stateDir).franja, 'valle', 'the baseline at 10:15Z is VALLE with the configured window (peak closed at 10:00)')
      // The LIVE seal's exact instant: 10:30:01.187Z — the 30-min-DEFAULT edge,
      // where the real monitor DID write (test header (i)). With the configured
      // window nothing changes here ⇒ NO write is owed.
      await tick(stateDir, pacingService, { atMs: 1789468201187, config, notifyHost })
      assert.equal(calls.length, 0, `NO transition at 10:30:01.187Z with the configured window (the live write at that instant is the DEFAULT's signature) (frames: ${JSON.stringify(calls.map((c) => c.frame))})`)
      assert.equal(readPacingState(stateDir).franja, 'valle', 'the franja is unchanged (valle → valle): the seal is not rewritten')
      assert.ok(Math.abs(readPacingState(stateDir).at - BAND_2_MS) <= 5_000, 'FRESHNESS/STALENESS as an assertion: the seal still sits at the 10:15Z baseline — no rewrite at the DEFAULT edge')
    } finally {
      dispose()
    }
  })
})
