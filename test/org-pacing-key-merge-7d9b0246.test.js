// dsh-deepartments — org.pacing PER-KEY resolution tests (builder-364 / run
// token 7d9b0246; completion of the F1/F2 lane «VALLE ABIERTO»).
//
// THE DEFECT UNDER TEST (packages/dshd-health/src/index.ts:8933, the COMPOSED
// daemon tick): the `org` config row was resolved with `??` over the WHOLE
// OBJECT —
//
//   const orgConfig = (config as HealthConfigLike).org
//     ?? explicit.config?.org
//     ?? (bucketPacing !== undefined ? { pacing: bucketPacing } : undefined)
//
// — so a caller that passes an `org` which EXISTS but does NOT carry `pacing`
// (any composition declaring `org.departments`, `org.poolerBaseURL`, …: the
// LIVE shared-source shape, where `org.pacing` is a bundle-side ONE-SIDED key
// by contract — test/org-config-parity.test.js:160-164) SHADOWS the bucket
// source entirely. `deps.config.org.pacing` then reads `undefined`, the
// consumers (:8228 the work-register-idle franja leg, :8505/:8507 the
// transition monitor + its notice) fall back to the CODE-DEFAULT 30-min buffer,
// and the CONFIGURED window (peakBufferMs 0 → «hasta 01:00 UTC») is lost IN
// SILENCE. It is `X?.k ?? cfg.k` one level up: a SUPERFICIAL fallback, the very
// class this lane has been hunting (boot.ts F1, stateDir).
//
// THE FIX UNDER TEST: resolve `pacing` BY KEY (first source that HAS it), the
// other `org` keys keeping their own precedence —
//   config.org?.pacing ?? explicit.config?.org?.pacing ?? bucketPacing
//
// THE FABRICATION (why these arms exist): the live composition happens to have
// NO caller-passed `org` at this seam, so the defect is LATENT there — and
// latent defects are only measurable by FABRICATING THE DIVERGENCE they would
// produce. Each arm therefore NAMES ITS COMPOSITION and drives the REAL
// composed daemon tick (`deepartments.health.runDaemonTick` — the ONLY path
// where the bucket seam `deepartments.wakepackDeps` exists; the inline
// `runHealthDaemonTick` has no bucket and cannot see this defect at all).
//
// THE DISCRIMINATING BAND (identical to the pacing-service-window suite): the
// configured window declares the SAME hours as the code default
// ({1,2,3,6,7,8,9}) and only changes the edge buffer (peakBufferMs 0 vs the
// CODE DEFAULT 1800000). The two windows therefore diverge EXACTLY on the
// buffer-expanded edges; the sample is Monday 2026-08-24 00:45:00 UTC, inside
// [00:30,01:00): CONFIGURED → VALLE (the peak opens at 01:00), CODE DEFAULT →
// PEAK (its buffer opened at 00:30). The transition monitor turns that one bit
// into a notice count over a real PEAK baseline seal:
//   1 notice «… hasta 01:00 UTC» = the CONFIGURED window (the configured edge)
//   0 notices                    = the CODE-DEFAULT window (peak === peak)
//   1 notice «… hasta 04:30 UTC» = the CODE-DEFAULT window (its own PEAK edge)
// Style: fixed clocks, hermetic temp stateDirs, the REAL Loader, against the
// COMPILED lib (pnpm -r --filter './packages/*' run build first — AGENTS.md
// rule 5; the root `pnpm build` does NOT write `packages/*/lib`).
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isPeakAt, pacingSpan, pacingStateAt, pacingWindowFromConfig } from 'dshd-core'
import { PACING_STATE_FILE, readPacingState } from 'dshd-health'

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

/** 2026-08-24 is a MONDAY (UTC). */
const MON = Date.UTC(2026, 7, 24)
/** The band sample: Monday 00:45:00 UTC — inside the buffer-expanded band
 * [00:30,01:00) where the configured buffer (0) and the code default (30 min)
 * disagree. NEVER a mid-peak-hour sample (that one is invariant). */
const BAND_MS = MON + 45 * 60_000

/** `org.pacing` VERBATIM from cordis.patch.yml:47-57 (the owner config: the
 * same hours as the code default, `peakBufferMs: 0`). This is the value the
 * bundle row carries, i.e. what travels over the `deepartments.wakepackDeps`
 * bucket. */
const PACING_CFG = {
  enabled: true,
  peakWindows: { weekday: [1, 2, 3, 4, 5], hours: [1, 2, 3, 6, 7, 8, 9] },
  peakBufferMs: 0
}
/** A DELIBERATELY DIFFERENT window, used as the caller-declared override in the
 * precedence control: hour 0 is a peak hour here (and nowhere else in this
 * file), so at 00:45 UTC the CALLER's window says PEAK with its next edge at
 * 04:00 — a frame NO other source in this suite can produce (bucket → VALLE /
 * «hasta 01:00 UTC»; code default → PEAK / «hasta 04:30 UTC»). */
const CALLER_PACING_CFG = {
  enabled: true,
  peakWindows: { weekday: [1, 2, 3, 4, 5], hours: [0, 1, 2, 3, 6, 7, 8, 9] },
  peakBufferMs: 0
}
/** The OTHER-org-keys composition — the LIVE shared-source shape
 * (packages/dshd-core/cordis.patch.yml declares `org.departments`; the pooler
 * endpoint rides the same row) with `pacing` ABSENT, exactly as the parity
 * contract requires (`org.pacing` is bundle-only). This is the shape that
 * SHADOWS the bucket under the object-level `??`. */
const OTHER_ORG_KEYS = { departments: [], poolerBaseURL: 'http://127.0.0.1:4097/v1' }

const HOSTS = [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }]

class StubWebServer extends Service {
  constructor(ctx) { super(ctx, 'webServer'); this.routes = [] }
  register() { return () => {} }
}
class StubWebRuntime extends Service {
  constructor(ctx) { super(ctx, 'webRuntime'); this.trustedHosts = [] }
}
class StubConnection extends Service {
  constructor(ctx) { super(ctx, 'connection'); this.trustedHosts = [] }
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-org-pacing-key-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Boot the REAL dev-profile order (dshd-core → 6 P1 → dshd-orchestration → the
 * bundle). `rows` NAMES the composition under test:
 *   - `coreOrg`   — the dshd-core row's `org` (the SHARED source; the parity
 *                   contract forbids `pacing` here),
 *   - `bundleOrg` — the bundle row's `org` (the ONE-SIDED knobs; `pacing` lives
 *                   here in the LIVE layout and reaches this seam through the
 *                   `deepartments.wakepackDeps` fill in
 *                   packages/dshd-orchestration/src/tools.ts),
 *   - `healthOrg` — the dshd-health PLUGIN ROW's `org` (the leftmost source of
 *                   :8933; `HealthConfig` does not declare it, but the line
 *                   casts the row, and the loader passes extra keys through —
 *                   measured, not assumed). */
async function bootComposed(stateDir, rows = {}) {
  const { coreOrg = { departments: [] }, bundleOrg = { pacing: PACING_CFG }, healthOrg } = rows
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
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org: coreOrg } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: id === 'dshd-health' && healthOrg !== undefined ? { org: healthOrg } : {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org: bundleOrg } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return { pluginCtx, dispose: () => loaderFiber.dispose() }
}

/** Drive the COMPOSED daemon tick (the bucket-seam path) on a fixed clock and
 * collect the frames it hands to `notifyHost`. `callerConfig` is the PER-TICK
 * caller config (`explicit.config` — the tick-composition caller of :8933);
 * OMITTED, the composed call is the LIVE one (no caller `org` at all). */
async function composedTick(ctx, { atMs = BAND_MS, callerConfig } = {}) {
  const calls = []
  await ctx.get('deepartments.health').runDaemonTick({
    now: () => atMs,
    hosts: HOSTS,
    posts: [],
    hostRunning: false,
    sessionContexts: [],
    hostWaits: [],
    notifyHost: async (hostEntry, frame, frameKey) => { calls.push({ hostEntry, frame, frameKey }) },
    ...(callerConfig !== undefined ? { config: callerConfig } : {})
  })
  return calls.filter((c) => /Pacing (VALLE|PEAK)/.test(c.frame))
}

/** Write the durable franja baseline the transition monitor compares against. */
const seedBaseline = (stateDir, franja) =>
  writeFile(path.join(stateDir, PACING_STATE_FILE), JSON.stringify({ franja, at: BAND_MS - 3_600_000 }), 'utf8')

// ---------------------------------------------------------------------------
// (0) THE BAND IS DISCRIMINATING — the non-decoration proof (pure, no boot).
//     The hours are IDENTICAL (config == default): ONLY the buffer separates
//     the two windows, so a mid-peak-hour sample would prove nothing.
// ---------------------------------------------------------------------------

test('ORG pacing key-merge (0) the band discriminates: at Monday 00:45 UTC the CONFIGURED window (peakBufferMs 0) says VALLE / «hasta 01:00 UTC» while the CODE DEFAULT (1800000) says PEAK / «hasta 04:30 UTC» — and the caller-declared window says PEAK / «hasta 04:00 UTC»', () => {
  const configured = pacingStateAt(new Date(BAND_MS), pacingWindowFromConfig(PACING_CFG))
  const codeDefault = pacingStateAt(new Date(BAND_MS))
  const callerDeclared = pacingStateAt(new Date(BAND_MS), pacingWindowFromConfig(CALLER_PACING_CFG))
  assert.equal(configured.peak, false, 'the bucket window (configured): 00:45 is VALLE — the peak opens at 01:00')
  assert.equal(configured.untilHhMm, '01:00', 'the configured window\'s next edge is the NOMINAL 01:00 (peakBufferMs 0)')
  assert.equal(codeDefault.peak, true, 'the CODE DEFAULT (30-min buffer): 00:45 is PEAK — its window opened at 00:30')
  assert.equal(codeDefault.untilHhMm, '04:30', 'the CODE-DEFAULT window\'s next edge is 04:30 — its OWN signature (never the configured one)')
  assert.equal(callerDeclared.peak, true, 'the CALLER-declared window: 00:45 is PEAK — hour 0 is a peak hour there')
  assert.equal(callerDeclared.untilHhMm, '04:00', 'the CALLER window\'s next edge is 04:00 — a signature NO other source in this suite can produce')
  // Config and default declare the SAME hours (only the buffer discriminates) —
  // so a mid-peak-hour sample would be invariant to this whole defect family.
  assert.equal(pacingSpan(pacingWindowFromConfig(PACING_CFG)), pacingSpan(pacingWindowFromConfig(undefined)), 'config and default declare the SAME hours/span (only the edge buffer discriminates)')
  // NON-discriminating control (the «decoration» sample this suite refuses): a
  // mid-peak-hour sample agrees in BOTH windows.
  assert.equal(isPeakAt(new Date(MON + 8 * 3_600_000), pacingWindowFromConfig(PACING_CFG)), isPeakAt(new Date(MON + 8 * 3_600_000)), 'a mid-peak-hour sample (08:00Z) agrees in BOTH windows — invariant to the defect (never a valid acceptance sample)')
})

// ---------------------------------------------------------------------------
// (a) THE CASE THAT FAILS TODAY — caller `org` WITH OTHER KEYS and NO `pacing`
//     (the LIVE shared-source shape), bucket carrying the configured window.
//     RED with the object-level `??`, GREEN with the per-key resolution.
// ---------------------------------------------------------------------------

test('ORG pacing key-merge (a) caller composition = per-tick `config.org` {departments, poolerBaseURL} WITHOUT `pacing` + bundle row carrying the configured window: the composed daemon notices the CONFIGURED window («VALLE … hasta 01:00 UTC», 1 notice) instead of silently running the CODE DEFAULT (0 notices)', async () => {
  await withTempStateDir(async (stateDir) => {
    await seedBaseline(stateDir, 'peak') // the pre-band observation: PEAK
    const { pluginCtx, dispose } = await bootComposed(stateDir)
    try {
      const ctx = pluginCtx()
      // The composition is MEASURED, not assumed: the bucket really carries the
      // configured window and the caller's org really lacks `pacing`.
      const bucket = ctx.get('deepartments.wakepackDeps').get()
      assert.deepEqual(bucket.pacing, PACING_CFG, 'the composition: the wakepack bucket carries the CONFIGURED window (the bundle row) — this is the source the object-level `??` shadows')
      const callerOrg = { ...OTHER_ORG_KEYS }
      assert.equal('pacing' in callerOrg, false, 'the composition: the per-tick caller org has OTHER keys and NO `pacing`')
      const calls = await composedTick(ctx, { callerConfig: { org: callerOrg } })
      assert.equal(
        calls.length,
        1,
        `ONE pacing notice is owed: with the CONFIGURED window 00:45Z is VALLE against the PEAK baseline (the CODE DEFAULT would see peak === peak and emit NOTHING — the silent regression this arm fabricates) (frames: ${JSON.stringify(calls.map((c) => c.frame))})`
      )
      assert.match(calls[0].frame, /^\[From deepartments\] Pacing VALLE: /, 'the notice is the VALLE resume frame — the configured window')
      assert.match(calls[0].frame, /hasta 01:00 UTC/, 'the notice carries the CONFIGURED window edge (peakBufferMs 0 → the nominal 01:00 open)')
      assert.doesNotMatch(calls[0].frame, /hasta 04:30 UTC/, 'never the CODE-DEFAULT edge (04:30 = 01:00 + the 30-min default buffer)')
      assert.equal(calls[0].frameKey, 'pacing-transition', 'the notice rides the shared pacing-transition dedupe key')
      // The durable seal proves the tick really ran the configured window.
      const seal = readPacingState(stateDir)
      assert.equal(seal.franja, 'valle', 'the durable seal records VALLE — the configured window was the one consulted')
      assert.equal(seal.at, BAND_MS, 'the seal is stamped at the tick instant (fixed clock)')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// (a2) THE SAME DIVERGENCE ONE SOURCE TO THE LEFT — the dshd-health PLUGIN ROW
//      declares the other-keys org (the leftmost source of :8933) and the
//      per-tick caller declares nothing: the row's `org` must contribute its
//      KEYS without erasing the bucket's `pacing`.
// ---------------------------------------------------------------------------

test('ORG pacing key-merge (a2) caller composition = dshd-health PLUGIN ROW `org` {departments, poolerBaseURL} without `pacing` + bundle row carrying the configured window: the composed daemon still notices the CONFIGURED window («hasta 01:00 UTC», 1 notice) — the row contributes KEYS, never a whole-object shadow', async () => {
  await withTempStateDir(async (stateDir) => {
    await seedBaseline(stateDir, 'peak')
    const { pluginCtx, dispose } = await bootComposed(stateDir, { healthOrg: { ...OTHER_ORG_KEYS } })
    try {
      const ctx = pluginCtx()
      assert.deepEqual(ctx.get('deepartments.wakepackDeps').get().pacing, PACING_CFG, 'the composition: the bucket carries the CONFIGURED window')
      // The per-tick caller passes NO config at all → the row org is the only
      // object-level source, which is exactly what shadowed the bucket.
      const calls = await composedTick(ctx)
      assert.equal(
        calls.length,
        1,
        `ONE pacing notice is owed through the ROW composition too (the object-level \`??\` returned the row's pacing-less org → the code default → 0 notices) (frames: ${JSON.stringify(calls.map((c) => c.frame))})`
      )
      assert.match(calls[0].frame, /^\[From deepartments\] Pacing VALLE: /, 'the VALLE resume frame — the configured window')
      assert.match(calls[0].frame, /hasta 01:00 UTC/, 'the CONFIGURED edge, not the default 04:30')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// (b) POSITIVE PRECEDENCE CONTROL — the caller DECLARES `org.pacing`: the
//     caller WINS over the bucket (explicit precedence is never weakened by
//     the per-key merge).
// ---------------------------------------------------------------------------

test('ORG pacing key-merge (b) caller composition = per-tick `config.org` {pacing: CALLER-declared window (hour 0 = peak)} + bundle row carrying a DIFFERENT configured window: the CALLER wins — the composed daemon notices the caller\'s PEAK edge («hasta 04:00 UTC»), never the bucket\'s («hasta 01:00 UTC») nor the code default\'s («hasta 04:30 UTC»)', async () => {
  await withTempStateDir(async (stateDir) => {
    await seedBaseline(stateDir, 'valle') // the caller's window opens its peak at 00:00 → a PEAK transition is owed
    const { pluginCtx, dispose } = await bootComposed(stateDir)
    try {
      const ctx = pluginCtx()
      assert.deepEqual(ctx.get('deepartments.wakepackDeps').get().pacing, PACING_CFG, 'the composition: the bucket carries the CONFIGURED window (which would say VALLE here) — so a PEAK notice can only come from the caller')
      const calls = await composedTick(ctx, { callerConfig: { org: { pacing: CALLER_PACING_CFG } } })
      assert.equal(calls.length, 1, `ONE notice is owed under the CALLER's window (PEAK opens at 00:00, the baseline is VALLE) (frames: ${JSON.stringify(calls.map((c) => c.frame))})`)
      assert.match(calls[0].frame, /^\[From deepartments\] Pacing PEAK: /, "the CALLER's window says PEAK at 00:45Z — the bucket's says VALLE")
      assert.match(calls[0].frame, /hasta 04:00 UTC/, "the CALLER's next edge (04:00) — the caller's OWN window resolved, not the bucket's (01:00)")
      assert.doesNotMatch(calls[0].frame, /hasta 01:00 UTC/, "the bucket's window did not win (explicit precedence intact)")
      assert.doesNotMatch(calls[0].frame, /hasta 04:30 UTC/, 'nor did the CODE-DEFAULT window (04:30) — the caller declared a window and it is the one consulted')
      assert.equal(calls[0].frameKey, 'pacing-transition', 'the notice rides the shared pacing-transition dedupe key')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// (c) REGRESSION CONTROL — NO `org` in the caller: the LIVE path (the bucket
//     source) is byte-for-byte the predecessor's acceptance result.
// ---------------------------------------------------------------------------

test('ORG pacing key-merge (c) caller composition = NO `org` anywhere in the caller (the LIVE layout: per-tick config absent, health row without org) + bundle row carrying the configured window: the LIVE path is UNCHANGED — «VALLE … hasta 01:00 UTC», 1 notice (the F2 acceptance)', async () => {
  await withTempStateDir(async (stateDir) => {
    await seedBaseline(stateDir, 'peak')
    const { pluginCtx, dispose } = await bootComposed(stateDir)
    try {
      const ctx = pluginCtx()
      const calls = await composedTick(ctx)
      assert.equal(calls.length, 1, `the LIVE composed tick still emits its single VALLE notice (frames: ${JSON.stringify(calls.map((c) => c.frame))})`)
      assert.match(calls[0].frame, /^\[From deepartments\] Pacing VALLE: reanuda los despachos a departamentos/, 'the LIVE acceptance frame (verbatim prefix)')
      assert.match(calls[0].frame, /hasta 01:00 UTC/, 'the CONFIGURED edge — the predecessor\'s acceptance value, unchanged')
      assert.doesNotMatch(calls[0].frame, /hasta 04:30 UTC/, 'never the code default')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// (c2) THE ABSENCE HALF — no caller `org` AND no bucket knob: the `org` key is
//      NOT materialized, and the tick keeps the LEGACY (code-default) behavior.
//      A positively observable absence: the default window's OWN edge (04:30).
// ---------------------------------------------------------------------------

test('ORG pacing key-merge (c2) caller composition = NO `org` anywhere AND a bundle row WITHOUT `org.pacing` (bucket knob undefined): the `org` key is NOT materialized and the composed daemon keeps the LEGACY code-default window — at 00:45Z against a VALLE baseline that is a PEAK transition «hasta 04:30 UTC»', async () => {
  await withTempStateDir(async (stateDir) => {
    await seedBaseline(stateDir, 'valle') // default window: PEAK at 00:45Z → a transition is owed
    const { pluginCtx, dispose } = await bootComposed(stateDir, { bundleOrg: {} })
    try {
      const ctx = pluginCtx()
      assert.equal(ctx.get('deepartments.wakepackDeps').get().pacing, undefined, 'the composition: the bundle row declares NO org.pacing → the bucket knob is undefined (absent, never fabricated)')
      const calls = await composedTick(ctx)
      assert.equal(calls.length, 1, `the tick keeps the pre-fix behavior when NOTHING declares a window (frames: ${JSON.stringify(calls.map((c) => c.frame))})`)
      assert.match(calls[0].frame, /^\[From deepartments\] Pacing PEAK: /, 'the CODE DEFAULT says PEAK at 00:45Z — the absence path is the legacy one')
      assert.match(calls[0].frame, /hasta 04:30 UTC/, 'the CODE-DEFAULT edge (04:30): the window is the default, so the `org` key was NOT materialized from a stray empty row')
    } finally {
      dispose()
    }
  })
})
