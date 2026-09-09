// dsh-deepartments — DRAIN-VALLE (post-mortem PEAK ítem 2) tests: the
// franja→VALLE fan-out of the transition monitor wakes the ACTOR heads of the
// non-gated pending WORK-REGISTER items (the deferred dispatches ARE those
// items — the config's «NO new data queue»; the complement of the franja GATE
// aba670b). Covers:
//   (1) a VALLE transition → the host notice ONCE + notifyPost to EACH
//       next-actor of the non-gated pending items (per-actor counts, the
//       shared 'pacing-transition' sourceKey, QUEUE semantics);
//   (2) a PEAK transition → the host notice, ZERO fan-out;
//   (3) dedupe — a SECOND transition inside the 30-min window → NO
//       re-notification (host AND fan-out); a re-detected transition (a lost
//       baseline write) → quiet recovery, no fan-out re-fire;
//   (4) exclusions — closed (ya ejecutado) / §3-gated / settlement next:host
//       / unknown-actor / no-next / retired-post items NEVER fan out (the
//       knownIds census; the HOST frame carries the totals);
//   (5) controls — org.pacing.enabled:false → full no-op (0 regression);
//       notifyPost ABSENT → the host path exactly as before (conservative
//       no-op); workRegisterPath ABSENT → no fan-out; no live host → the
//       no-perdible retry delivers BOTH the notice and the fan-out once live.
// Hermetic: temp stateDirs, fixed clocks (deps.now), recording notifyHost +
// notifyPost stubs, against the COMPILED lib (pnpm build first — AGENTS.md
// rule 5). The LANE-5 work-register-idle watchdog is DISABLED in the fixtures
// (health.workRegisterIdleEnabled:false) so the ORTHOGONAL
// continuation-wait / escalation notifyPost deliveries never pollute the
// drain fan-out assertions (the drain is isolated by knob — the same pattern
// the w7 suite uses for its own isolation).
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runHealthDaemonTick, PACING_TRANSITION_KEY, PACING_STATE_FILE, readPacingState } from '../lib/invoke.js'

// ---------------------------------------------------------------------------
// FIXTURES — a fixed Monday (2026-08-24) + a SHARP pacing window (weekday [1],
// hours [8], buffer 0 → Mon PEAK [08:00,09:00) UTC) so the test clocks need no
// 30-min alignment (the pacing.test.js convention). Anchor instants: 07:59 →
// VALLE, 08:01 → PEAK, 09:01 → VALLE.
// ---------------------------------------------------------------------------

/** The rich WORK-REGISTER fixture: open non-gated items WITH next-actors (the
 * fan-out targets — IPD x2, RD x1) plus every EXCLUDED class (a closed item,
 * a settlement next:host, a CERRADO reference section, a §3 PENDIENTE-OWNER
 * gated item, an unknown actor, a retired-post name, a no-next item). The
 * register-wide pending count is 9 (the host notice's N + the frames' total). */
const REGISTER = [
  '## 1. IPD — cola activa',
  '- **Item A — lane IPD-1** — next: internal-programming-head',
  '- **Item B — lane RD-1** — next: research-head',
  '- **Item C — lane IPD-2** — next: internal-programming-head',
  '- **Closed D — lane cerrada** — DONE (ya ejecutado)',
  '- **Settle E — consolidated** — next: host verify+push',
  '## 2. Referencia — CERRADO',
  '- **Ref X** — next: research-head',
  '## 3. PENDIENTE-OWNER',
  '- **Owner F — gated** — next: internal-programming-head',
  '## 4. Backlog',
  '- **Unknown G** — next: some-unknown-post',
  '- **Retired H** — next: retired-head',
  '- **Plain I** — sin next'
].join('\n')

/** The catalog posts: two known heads + one RETIRED post (never in knownIds —
 * the retired exclusion is a first-class census fact). */
const POSTS = [
  { postId: 'internal-programming-head' },
  { postId: 'research-head' },
  { postId: 'retired-head', retired: true }
]

const HOSTS = [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }]
const LOGGER = { warn() {}, info() {} }

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-drain-valle-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** The daemon tick helper: fixed clock, hermetic stateDir, the SHARP pacing
 * window + the LANE-5 watchdog knob OFF (drain isolation), recording
 * notifyHost (hostCalls) + notifyPost (postCalls) stubs. `opts.notifyPostAbsent`
 * → the notifyPost dep is OMITTED (the conservative no-op control);
 * `opts.pacingService` / `overrides.pacingService` → the LANE 0.2.2 P4
 * substitutable pacing policy (service-FIRST franja — used by the dedupe test
 * to flip the franja inside a 30-min span, impossible with the hour-granular
 * config window). */
function makeTick(stateDir, opts = {}) {
  const hostCalls = []
  const postCalls = []
  const notifyPost = async (postId, frame, nopts) => { postCalls.push({ postId, frame, opts: nopts }) }
  let nowMs = opts.nowMs
  const tick = async (atMs, overrides = {}) => {
    nowMs = atMs
    const deps = {
      now: () => nowMs,
      stateDir,
      bootId: overrides.bootId ?? 'boot-drain-valle',
      config: overrides.config ?? opts.config ?? {
        org: { pacing: { enabled: true, peakWindows: { weekday: [1], hours: [8] }, peakBufferMs: 0 } },
        health: { workRegisterIdleEnabled: false }
      },
      hosts: overrides.hosts ?? opts.hosts ?? HOSTS,
      posts: overrides.posts ?? opts.posts ?? [],
      workRegisterPath: overrides.workRegisterPath ?? opts.workRegisterPath,
      pacingService: overrides.pacingService ?? opts.pacingService,
      notifyHost: async (hostEntry, frame) => { hostCalls.push({ hostEntry, frame }) },
      logger: LOGGER
    }
    if (opts.notifyPostAbsent !== true && overrides.notifyPostAbsent !== true) deps.notifyPost = notifyPost
    await runHealthDaemonTick(deps)
  }
  return { tick, hostCalls, postCalls }
}

/** The LANE 0.2.2 P4 substitutable pacing policy — a fake service over half-open
 * peak intervals (ms epochs) so a test can flip the franja INSIDE a 30-min
 * span (the hour-granular config window cannot). `pacingStateAt` returns the
 * minimal shape the transition frame builder reads (peak/untilHhMm/span). */
function franjaService(peakIntervals) {
  const tOf = (date) => (typeof date === 'number' ? date : date.getTime())
  const isPeakAt = (date) => peakIntervals.some(([start, end]) => {
    const t = tOf(date)
    return t >= start && t < end
  })
  return {
    isPeakAt,
    pacingStateAt(date) {
      const peak = isPeakAt(date)
      return { peak, untilMs: 0, untilHhMm: '09:00', span: '08:00-09:00' }
    }
  }
}

// ---------------------------------------------------------------------------
// (1) VALLE TRANSITION — the host notice + the actor fan-out
// ---------------------------------------------------------------------------

test('DRAIN-VALLE: the franja→VALLE transition notifies the host ONCE and notifyPost EACH next-actor of the non-gated pending items (per-actor counts, the shared pacing-transition sourceKey, QUEUE semantics); a PEAK transition NEVER fans out', async () => {
  await withTempStateDir(async (stateDir) => {
    const registerPath = path.join(stateDir, 'WORK-REGISTER.md')
    await writeFile(registerPath, REGISTER, 'utf8')
    const { tick, hostCalls, postCalls } = makeTick(stateDir, { workRegisterPath: registerPath, posts: POSTS })
    // Boot at 07:59 (VALLE): baseline only, NOTHING emitted (documented).
    await tick(Date.UTC(2026, 7, 24, 7, 59))
    assert.equal(hostCalls.length, 0, 'first boot records the baseline and emits NOTHING')
    assert.equal(postCalls.length, 0, 'first boot → no fan-out')
    // 08:01 — VALLE → PEAK: the host pause notice, ZERO fan-out.
    await tick(Date.UTC(2026, 7, 24, 8, 1))
    assert.equal(hostCalls.length, 1, 'the PEAK transition notifies the host exactly once')
    assert.equal(postCalls.length, 0, 'a PEAK transition NEVER fans out (the drain is a VALLE border event)')
    assert.match(hostCalls[0].frame, /^\[From deepartments\] Pacing PEAK:/, 'the PEAK notice frame')
    // 09:01 — PEAK → VALLE: the resume notice + the fan-out to BOTH actors.
    await tick(Date.UTC(2026, 7, 24, 9, 1))
    assert.equal(hostCalls.length, 2, 'the VALLE transition notifies the host exactly once')
    assert.match(hostCalls[1].frame, /^\[From deepartments\] Pacing VALLE:/, 'the VALLE notice frame')
    assert.match(hostCalls[1].frame, /despachos diferidos: 9 \(cola del WORK-REGISTER\)/, 'the VALLE notice carries the legible pending count (9 — the CERRADO section + the DONE marker excluded)')
    assert.equal(postCalls.length, 2, 'the VALLE transition fans out to BOTH next-actors')
    assert.deepEqual(postCalls.map((c) => c.postId), ['internal-programming-head', 'research-head'], 'the fan-out targets the known non-retired next-actors, sorted by postId')
    assert.match(postCalls[0].frame, /^\[From deepartments\] Pacing VALLE: VALLE abierto — reanuda tu lane; 2 ítem\(s\) pending a tu nombre/, 'the IPD frame: its 2 pending items')
    assert.match(postCalls[0].frame, /pendientes totales del register: 9/, 'the IPD frame carries the register-wide total for context')
    assert.match(postCalls[1].frame, /1 ítem\(s\) pending a tu nombre/, 'the RD frame: its 1 pending item')
    assert.deepEqual(postCalls[0].opts, { sourceKey: PACING_TRANSITION_KEY }, 'the fan-out rides the SAME pacing-transition dedupe key (the whole transition emission)')
    assert.equal(postCalls[0].opts.interrupt, undefined, 'QUEUE semantics — never interrupt a head (the L2/L3 contract)')
    // 09:02 — same franja: NOTHING new.
    await tick(Date.UTC(2026, 7, 24, 9, 2))
    assert.equal(hostCalls.length, 2, 'a re-tick inside the SAME franja does NOT re-notify')
    assert.equal(postCalls.length, 2, 'a re-tick inside the SAME franja does NOT re-fan-out')
  })
})

// ---------------------------------------------------------------------------
// (3) DEDUPE — ≤1 emission per 30-min window (the whole transition)
// ---------------------------------------------------------------------------

test('DRAIN-VALLE: dedupe — a SECOND transition inside the 30-min window → NO re-notification (the host notice AND the fan-out are suppressed; the baseline advances quietly)', async () => {
  await withTempStateDir(async (stateDir) => {
    const registerPath = path.join(stateDir, 'WORK-REGISTER.md')
    await writeFile(registerPath, REGISTER, 'utf8')
    // A SUBSTITUTABLE pacing policy: PEAK [08:05,08:10) ONLY — the franja flips
    // to VALLE at 08:10, a true 2nd transition 5 min after the 08:05 emission
    // (an hour-granular config window cannot flip inside 30 min).
    const MON = Date.UTC(2026, 7, 24)
    const service = franjaService([[MON + 8 * 3_600_000 + 5 * 60_000, MON + 8 * 3_600_000 + 10 * 60_000]])
    const { tick, hostCalls, postCalls } = makeTick(stateDir, { workRegisterPath: registerPath, posts: POSTS, pacingService: service })
    await tick(MON + 7 * 3_600_000) // 07:00 — boot baseline VALLE
    await tick(MON + 8 * 3_600_000 + 5 * 60_000) // 08:05 — valle → peak: notice 1, no fan-out
    assert.equal(hostCalls.length, 1)
    assert.equal(postCalls.length, 0)
    // The SECOND transition (peak → valle at 08:20, 15 min after the 08:05
    // emission) is INSIDE the shared 30-min dedupe window → the WHOLE emission
    // is suppressed: no host notice, no fan-out, the baseline advances.
    await tick(MON + 8 * 3_600_000 + 20 * 60_000) // 08:20 — peak → valle
    assert.equal(hostCalls.length, 1, 'a transition inside the 30-min dedupe window does NOT notify the host')
    assert.equal(postCalls.length, 0, 'a transition inside the window does NOT fan out')
    assert.equal(readPacingState(stateDir).franja, 'valle', 'the baseline advanced quietly (the transition was consumed)')
  })
})

test('DRAIN-VALLE: no-duplicate — a lost baseline write cannot re-notify / re-fan-out the SAME VALLE transition (the shared-ledger dedupe covers the fan-out)', async () => {
  await withTempStateDir(async (stateDir) => {
    const registerPath = path.join(stateDir, 'WORK-REGISTER.md')
    await writeFile(registerPath, REGISTER, 'utf8')
    const { tick, hostCalls, postCalls } = makeTick(stateDir, { workRegisterPath: registerPath, posts: POSTS })
    await tick(Date.UTC(2026, 7, 24, 7, 59)) // boot baseline valle
    await tick(Date.UTC(2026, 7, 24, 8, 1))  // peak notice
    await tick(Date.UTC(2026, 7, 24, 9, 1))  // valle notice + fan-out
    assert.equal(hostCalls.length, 2)
    assert.equal(postCalls.length, 2, 'the first VALLE transition fanned out')
    // A crash that lost the baseline write (the shared-ledger stamp survives).
    await rm(path.join(stateDir, PACING_STATE_FILE), { force: true })
    await tick(Date.UTC(2026, 7, 24, 9, 2))
    assert.equal(hostCalls.length, 2, 'a re-detected transition inside the window does NOT re-notify the host')
    assert.equal(postCalls.length, 2, 'a re-detected transition inside the window does NOT re-fan-out')
    assert.equal(readPacingState(stateDir).franja, 'valle', 'the baseline recovered quietly')
  })
})

// ---------------------------------------------------------------------------
// (4) EXCLUSIONS — the already-executed / gated / settlement / unknown lanes
// ---------------------------------------------------------------------------

test('DRAIN-VALLE: exclusions — closed (ya ejecutado) / §3-gated / settlement next:host / unknown-actor / no-next / retired-post items NEVER fan out (the knownIds census; the HOST frame carries the totals)', async () => {
  // (a) a register whose pending items are ALL excluded classes → ZERO fan-out.
  await withTempStateDir(async (stateDir) => {
    const registerPath = path.join(stateDir, 'WORK-REGISTER.md')
    await writeFile(registerPath, [
      '## 1. IPD — cola activa',
      '- **Closed D — lane cerrada** — DONE (ya ejecutado)',
      '- **Settle E — consolidated** — next: host verify+push',
      '## 3. PENDIENTE-OWNER',
      '- **Owner F — gated** — next: internal-programming-head',
      '## 4. Backlog',
      '- **Unknown G** — next: some-unknown-post',
      '- **Plain I** — sin next'
    ].join('\n'), 'utf8')
    const { tick, hostCalls, postCalls } = makeTick(stateDir, { workRegisterPath: registerPath, posts: POSTS })
    await tick(Date.UTC(2026, 7, 24, 7, 59))
    await tick(Date.UTC(2026, 7, 24, 8, 1)) // peak notice
    await tick(Date.UTC(2026, 7, 24, 9, 1)) // valle notice
    assert.equal(hostCalls.length, 2, 'the host is STILL notified on the VALLE transition (the count covers the totals)')
    assert.equal(postCalls.length, 0, 'an all-excluded register → ZERO fan-out (closed + gated + settlement + unknown + no-next)')
  })
  // (b) a RETIRED post named as next-actor is NOT in knownIds → never fanned out.
  await withTempStateDir(async (stateDir) => {
    const registerPath = path.join(stateDir, 'WORK-REGISTER.md')
    await writeFile(registerPath, [
      '## 1. IPD — cola activa',
      '- **Retired H** — next: retired-head'
    ].join('\n'), 'utf8')
    const { tick, postCalls } = makeTick(stateDir, { workRegisterPath: registerPath, posts: POSTS })
    await tick(Date.UTC(2026, 7, 24, 7, 59))
    await tick(Date.UTC(2026, 7, 24, 8, 1))
    await tick(Date.UTC(2026, 7, 24, 9, 1))
    assert.equal(postCalls.length, 0, 'a next: retired-head item NEVER fans out (the census only adds KNOWN non-retired posts)')
  })
})

// ---------------------------------------------------------------------------
// (5) CONTROLS — no-op knobs, absent seams, the no-perdible retry
// ---------------------------------------------------------------------------

test('DRAIN-VALLE: controls — org.pacing.enabled:false → the monitor is a full no-op (0 regression); notifyPost ABSENT → the host path exactly as before; workRegisterPath ABSENT → no fan-out', async () => {
  // (a) enabled:false → no baseline, no host notices, no fan-out (the legacy).
  await withTempStateDir(async (stateDir) => {
    const { tick, hostCalls, postCalls } = makeTick(stateDir, { config: { org: { pacing: { enabled: false } }, health: { workRegisterIdleEnabled: false } } })
    await tick(Date.UTC(2026, 7, 24, 7, 59))
    await tick(Date.UTC(2026, 7, 24, 8, 1))
    await tick(Date.UTC(2026, 7, 24, 9, 1))
    assert.equal(hostCalls.length, 0, 'enabled:false → the monitor is a full no-op')
    assert.equal(postCalls.length, 0, 'enabled:false → no fan-out')
    let baselineWritten = true
    try { await readFile(path.join(stateDir, PACING_STATE_FILE), 'utf8') } catch { baselineWritten = false }
    assert.equal(baselineWritten, false, 'enabled:false → pacing-state.json is never written')
  })
  // (b) notifyPost ABSENT → the VALLE transition keeps its EXACT pre-drain host
  // behavior (0 regression; the L2/L3 conservative-no-op precedent).
  await withTempStateDir(async (stateDir) => {
    const registerPath = path.join(stateDir, 'WORK-REGISTER.md')
    await writeFile(registerPath, REGISTER, 'utf8')
    const { tick, hostCalls, postCalls } = makeTick(stateDir, { workRegisterPath: registerPath, posts: POSTS, notifyPostAbsent: true })
    await tick(Date.UTC(2026, 7, 24, 7, 59))
    await tick(Date.UTC(2026, 7, 24, 8, 1))
    await tick(Date.UTC(2026, 7, 24, 9, 1))
    assert.equal(hostCalls.length, 2, 'the host notices flow exactly as before')
    assert.equal(postCalls.length, 0, 'absent notifyPost → the drain is a CONSERVATIVE no-op')
  })
  // (c) workRegisterPath ABSENT → the VALLE notice OMITS the count and there is
  // NO fan-out (nothing to census).
  await withTempStateDir(async (stateDir) => {
    const { tick, hostCalls, postCalls } = makeTick(stateDir, { posts: POSTS })
    await tick(Date.UTC(2026, 7, 24, 7, 59))
    await tick(Date.UTC(2026, 7, 24, 8, 1))
    await tick(Date.UTC(2026, 7, 24, 9, 1))
    assert.equal(hostCalls.length, 2, 'the host notices flow')
    assert.ok(!hostCalls[1].frame.includes('despachos diferidos'), 'absent workRegisterPath → the count is omitted (si no, sin conteo)')
    assert.equal(postCalls.length, 0, 'absent workRegisterPath → NO fan-out (the conservative no-op)')
  })
})

test('DRAIN-VALLE: no-perdible — a VALLE transition with NO live host is skipped AND the baseline is NOT advanced; the SAME transition delivers BOTH the notice and the fan-out once a host is live', async () => {
  await withTempStateDir(async (stateDir) => {
    const registerPath = path.join(stateDir, 'WORK-REGISTER.md')
    await writeFile(registerPath, REGISTER, 'utf8')
    const { tick, hostCalls, postCalls } = makeTick(stateDir, { workRegisterPath: registerPath, posts: POSTS })
    await tick(Date.UTC(2026, 7, 24, 8, 3), { hosts: [] }) // boot baseline PEAK (hostless boot is fine)
    await tick(Date.UTC(2026, 7, 24, 9, 1), { hosts: [] })  // peak → valle with NO host → skipped
    assert.equal(hostCalls.length, 0, 'no live host → no valle notice')
    assert.equal(postCalls.length, 0, 'no live host → no fan-out')
    assert.equal(readPacingState(stateDir).franja, 'peak', 'the baseline is NOT advanced (the emission retries)')
    // The SAME transition once a host is live (09:02, still peak→valle pending).
    await tick(Date.UTC(2026, 7, 24, 9, 2), { hosts: HOSTS })
    assert.equal(hostCalls.length, 1, 'the pending VALLE transition notifies ONCE the host is live')
    assert.equal(postCalls.length, 2, 'the pending VALLE fan-out fires ONCE the host is live (nothing is lost, nothing double-fires)')
  })
})