// LANE HEALTH (usable-window) — the NO-RETURN POINT of the context accounting,
// proved BY EFFECT, and the FRAME + CONSEQUENCE the frozen `error` literal
// cannot carry.
//
// WHAT THIS LANE MEASURED (the verdict the brief asked to verify BEFORE writing):
// the completion reserve is ALREADY in the numerator —
// `effective = projected + reserve`, `pct = effective / contextWindow` — so the
// bands are computed OVER the magnitude that includes it and the point where the
// next request becomes IMPOSSIBLE is `projected + reserve > contextWindow` ⇔
// `pct > 1` ⇔ **b10**, not a hypothetical rung below it. At the real calibration
// (window 1048576, reserve 262144) that is `projected > 786432`. A member in a
// «healthy» b8/b9 band is NOT in an impossible state: b9 spans effective
// [943718, 1048576) and b8 [838860, 943718), both STRICTLY BELOW the window.
// ⇒ THE ALGEBRA IS NOT RECALIBRATED (no second reserve, no moved band edges).
// What IS fixed is the RESIDUE, and it is fixed ADDITIVELY:
//   (D-a) the last rung didn't state its CONSEQUENCE (`beyondUsableWindow` +
//         `contextAction`), and
//   (D-b) the DENOMINATOR did not travel with the figure (MEASURED: the live
//         ledger holds rows over /1048576 AND over /1000000 — the same `b10`
//         names two different requests), so the frame is published.
//
// METHOD (the repo's "src-native" pattern WITHOUT the resolution hook): the
// package `dshd-health/src/index.ts` has ZERO relative imports (its only imports
// are `node:fs`/`node:fs/promises`/`node:path` + the bare workspace packages,
// which resolve through node_modules symlinks), so Node's native type-stripping
// loads it DIRECTLY — the test exercises the CURRENT source without the built
// `lib/` and without self-registering the lane-② resolution hook (which the
// r6-ladder-flat lock reserves for ITS own family; this lane is NOT part of that
// family, so it must not NAME the hook at all — that guard matches the hook's
// filename as plain TEXT, so a mere mention here would be read as a broken
// registration). It also runs NO build: `packages/dshd-health/lib/` is untouched
// by this lane (published artifacts keep their pre-lane mtimes).
import assert from 'node:assert/strict'
import { test } from 'node:test'

const H = await import('../packages/dshd-health/src/index.ts')

// The REAL calibration of the live monitor: the deepseek-v4-flash window and the
// `health.contextCompletionReserve` knob (262144 max output tokens), plus the
// threshold knob (0.85) the fb-50 tests use — the same numbers the live ledger
// rows carry (`792342+262144/1048576`).
const WINDOW = 1_048_576
const RESERVE = 262_144
const THRESHOLD = 0.85
const T0 = new Date(2026, 8, 11, 21, 0, 0).getTime()

/** The utilizable window the host's directive names: `límite − reserve`. */
const USABLE = WINDOW - RESERVE // 786432

test('LANE HEALTH (2) BY EFFECT: a row AT the no-return point is REJECTED and a row in b9 is NOT — the boundary is `projected > 786432` with the real reserve, i.e. band b10, and b8/b9 stay strictly INSIDE the window', () => {
  // The boundary case, stated as the arithmetic the request actually makes:
  // input = projected, completion = reserve, limit = contextWindow. The request
  // is IMPOSSIBLE iff input + completion > limit.
  const requestFits = (projected) => projected + RESERVE <= WINDOW

  // (i) THE NO-RETURN ROW — the live ledger's own shape (792342+262144).
  const breached = H.scanContextThreshold({
    rows: [{ postId: 'internal-programming-head', contextWindow: WINDOW, projectedTokens: 792_342 }],
    threshold: THRESHOLD,
    completionReserve: RESERVE,
    nowMs: T0
  })
  assert.equal(breached.findings.length, 1, 'the breaching row alerts')
  const b10 = breached.findings[0]
  assert.equal(b10.key, 'context-threshold:internal-programming-head:b10', '1054486/1048576 = 100.6% → band floor(10.06) = 10')
  assert.equal(b10.error, 'internal-programming-head 101% (792342+262144/1048576) — cruce b10', 'the FROZEN literal is byte-identical (this lane never rewords it)')
  assert.equal(requestFits(792_342), false, 'THE CONSEQUENCE, literally: 792342 input + 262144 completion = 1054486 > 1048576 → the request is REJECTED')
  assert.equal(b10.beyondUsableWindow, true, '(D-a) the last rung DECLARES the consequence structurally')
  assert.equal(b10.contextAction, 'compact-or-rotate', '(D-a) …and carries the operational instruction')
  assert.equal(b10.usableWindowTokens, USABLE, '(D-b) the utilizable window = 1048576 − 262144 = 786432 travels with the figure')
  assert.equal(b10.contextWindow, WINDOW, '(D-b) the DENOMINATOR travels with the figure')
  assert.equal(b10.contextProjectedTokens, 792_342, 'the numerator base travels (pct is re-derivable)')
  assert.equal(b10.contextReserveTokens, RESERVE, 'the reserve operand travels')
  // Re-derivable claim: the published operands reproduce the percentage.
  assert.equal(Math.round((b10.contextProjectedTokens + b10.contextReserveTokens) / b10.contextWindow * 100), 101, 'the published frame RE-DERIVES the 101% of the frozen literal')

  // (ii) THE HEALTHY-SIDE ROWS — b9 and b8, from the live ledger's own measured
  // rows. The brief's contrary claim («an agent can be in a healthy band and its
  // request be impossible») is FALSE here, and this is the effect proof.
  const b9row = H.scanContextThreshold({
    rows: [{ postId: 'quality-head', contextWindow: WINDOW, projectedTokens: 681_845 }],
    threshold: THRESHOLD,
    completionReserve: RESERVE,
    nowMs: T0
  }).findings[0]
  assert.equal(b9row.key, 'context-threshold:quality-head:b9', '943989/1048576 = 90.0% → b9 (the MEASURED ledger row 1789078938667)')
  assert.equal(b9row.error, 'quality-head 90% (681845+262144/1048576) — cruce b9', 'b9 literal unchanged')
  assert.equal(681_845 + RESERVE <= WINDOW, true, 'b9 is POSSIBLE: 681845 + 262144 = 943989 ≤ 1048576 — the request fits with 104587 tokens of headroom')
  assert.equal(b9row.beyondUsableWindow, false, '(D-a) a b9 row is NOT beyond the window — the flag is FALSE by effect, not by band')
  assert.equal(b9row.contextAction, undefined, '(D-a) …and carries NO action token (the instruction is for the last rung only)')

  const b8row = H.scanContextThreshold({
    rows: [{ postId: 'explore-deep-58', contextWindow: WINDOW, projectedTokens: 581_855 }],
    // 80.5% is below the 0.85 knob but above the 0.5 code default — the live
    // ledger's b8 rows were emitted under the default threshold.
    threshold: H.CONTEXT_THRESHOLD_DEFAULT,
    completionReserve: RESERVE,
    nowMs: T0
  }).findings[0]
  assert.equal(b8row.key, 'context-threshold:explore-deep-58:b8', '843999/1048576 = 80.5% → b8 (the MEASURED ledger row 1788887847295)')
  assert.equal(581_855 + RESERVE <= WINDOW, true, 'b8 is POSSIBLE: 843999 ≤ 1048576')
  assert.equal(b8row.beyondUsableWindow, false, '(D-a) a b8 row is NOT beyond the window either — every rung below b10 fits')
  assert.equal(b8row.contextAction, undefined, '(D-a) …and carries no action token')

  // (iii) THE ALGEBRA, at the band BOUNDARIES — the rungs are contiguous and only
  // the band that EXCEEDS the denominator is impossible. Derived, not asserted
  // from memory: for each band b, `effective >= b/10 * window`.
  for (let band = 5; band <= 9; band += 1) {
    const lowestEffective = (band / 10) * WINDOW
    assert.ok(lowestEffective < WINDOW, `b${band} LOWER edge effective ${lowestEffective} < window ${WINDOW} → a row at that edge still FITS`)
  }
  assert.ok((10 / 10) * WINDOW === WINDOW, 'b10 begins exactly AT the window: its lower edge is the limit itself')
  // The exact crossing: the last projectable input that still fits is USABLE
  // (786432) and the first that does not is USABLE + 1.
  const atLimit = H.scanContextThreshold({
    rows: [{ postId: 'at-limit', contextWindow: WINDOW, projectedTokens: USABLE }],
    threshold: THRESHOLD,
    completionReserve: RESERVE,
    nowMs: T0
  }).findings[0]
  assert.equal(atLimit.beyondUsableWindow, false, `projected == USABLE (${USABLE}) is the LAST possible row: effective == window, the request fits EXACTLY`)
  assert.equal(atLimit.usableWindowTokens, USABLE, 'the utilizable window IS that last possible input')
  const onePast = H.scanContextThreshold({
    rows: [{ postId: 'one-past', contextWindow: WINDOW, projectedTokens: USABLE + 1 }],
    threshold: THRESHOLD,
    completionReserve: RESERVE,
    nowMs: T0
  }).findings[0]
  assert.equal(onePast.beyondUsableWindow, true, `projected == USABLE + 1 (${USABLE + 1}) is the FIRST impossible row → the boundary is EXACTLY 786432`)
  assert.equal(onePast.key, 'context-threshold:one-past:b10', 'the first impossible row lands in b10 (100.0001% → floor = 10)')
})

test('LANE HEALTH (D-b): the DENOMINATOR travels with the figure — two rows with the SAME percentage over DIFFERENT frames publish DIFFERENT windows, so the band is comparable (the class the live ledger measured: 212 rows over /1048576 and 3 over /1000000)', () => {
  // The two frames, both MEASURED in the live ledger: the deepseek window and the
  // host session that ran on another provider with a 1000000 window. A `b10`
  // means a DIFFERENT absolute pressure in each.
  const scan = H.scanContextThreshold({
    rows: [
      { postId: 'deepseek-frame', contextWindow: 1_048_576, projectedTokens: 792_342 },
      { postId: 'other-frame', contextWindow: 1_000_000, projectedTokens: 780_000 }
    ],
    threshold: THRESHOLD,
    completionReserve: RESERVE,
    nowMs: T0
  })
  const deepseek = scan.findings.find((f) => f.postId === 'deepseek-frame')
  const other = scan.findings.find((f) => f.postId === 'other-frame')
  assert.equal(deepseek.key, 'context-threshold:deepseek-frame:b10', '1054486/1048576 = 100.6% → b10')
  assert.equal(other.key, 'context-threshold:other-frame:b10', '1042144/1000000 = 104.2% → b10 — the SAME band label')
  assert.notEqual(deepseek.contextWindow, other.contextWindow, 'the two b10 rows are computed against DIFFERENT denominators (the band label alone is NOT comparable)')
  assert.equal(deepseek.contextWindow, 1_048_576, 'the first row publishes its own frame')
  assert.equal(other.contextWindow, 1_000_000, 'the second row publishes ITS frame — the consumer can now compare or refuse')
  assert.notEqual(deepseek.usableWindowTokens, other.usableWindowTokens, 'the UTILIZABLE windows differ (786432 vs 737856) — the boundary moved with the denominator')
  // Both are beyond their own window, so the flag is per-row, never a band label.
  assert.equal(deepseek.beyondUsableWindow, true, 'row 1 exceeds ITS window')
  assert.equal(other.beyondUsableWindow, true, 'row 2 exceeds ITS window')
  // The counter-case: the same RATIO at 62% is possible in BOTH — the flag is
  // the arithmetic, never a band or a percentage.
  const mild = H.scanContextThreshold({
    rows: [
      { postId: 'mild-a', contextWindow: 1_048_576, projectedTokens: 388_052 },
      { postId: 'mild-b', contextWindow: 1_000_000, projectedTokens: 357_856 }
    ],
    threshold: 0.5,
    completionReserve: RESERVE,
    nowMs: T0
  }).findings
  for (const f of mild) {
    assert.equal(f.beyondUsableWindow, false, `${f.postId}: 62% is inside its own window → possible`)
    assert.equal(f.contextAction, undefined, `${f.postId}: no action token for a possible request`)
  }
})

test('LANE HEALTH contraprueba: the new fields are ABSENT on a row that does NOT alert and on every non-context finding — the change is ADDITIVE and cannot manufacture a false positive', () => {
  // A below-threshold row produces NO finding at all (the pre-existing rule).
  const quiet = H.scanContextThreshold({
    rows: [{ postId: 'calm', contextWindow: WINDOW, projectedTokens: 100_000 }],
    threshold: THRESHOLD,
    completionReserve: RESERVE,
    nowMs: T0
  })
  assert.deepEqual(quiet.findings, [], 'no finding below the threshold (nothing to annotate)')
  // A row WITHOUT a viable denominator is skipped exactly as before.
  const noWindow = H.scanContextThreshold({
    rows: [{ postId: 'no-window' }],
    threshold: 0.5,
    completionReserve: RESERVE,
    nowMs: T0
  })
  assert.deepEqual(noWindow.findings, [], 'a row without contextWindow is still SKIPPED (never a false positive)')
  // The legacy numerator (reserve 0) keeps its byte-identical literal AND now
  // publishes its frame honestly: usableWindow == contextWindow when nothing is
  // reserved, and the consequence is computed against that same frame.
  const legacy = H.scanContextThreshold({
    rows: [{ postId: 'legacy', contextWindow: 1_000_000, projectedTokens: 520_000 }],
    threshold: 0.5,
    nowMs: T0
  }).findings[0]
  assert.equal(legacy.error, 'legacy 52% (520000/1000000) — cruce b5', 'the LEGACY literal is byte-identical (fb-50 rule intact)')
  assert.equal(legacy.contextReserveTokens, 0, 'an absent reserve publishes 0 (never a fabricated operand)')
  assert.equal(legacy.usableWindowTokens, 1_000_000, 'with no reserve the utilizable window IS the window')
  assert.equal(legacy.beyondUsableWindow, false, '52% is inside the window → possible')
  assert.equal(legacy.contextAction, undefined, 'no action token when the request is possible')
  // The FROZEN frame bullet is untouched: `buildHealthAlertFrame` renders the
  // `error` verbatim and this lane added NO branch to it.
  const frame = H.buildHealthAlertFrame([{
    kind: 'context-threshold',
    key: 'context-threshold:research-head:b5',
    postId: 'research-head',
    ts: T0,
    error: 'research-head 52% (520000/1000000) — cruce b5'
  }])
  assert.match(frame, /^- context-threshold: research-head 52% \(520000\/1000000\) — cruce b5$/m, 'the frozen frame bullet is byte-identical (the alert render is unchanged)')
})
