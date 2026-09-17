// dsh-deepartments — builder-419 (run token 7e6e29ee, 2026-09-17): THE RESETTER.
//
// THE OBJECTIVE (host, literal): «Que un par al que el CAP acaba de disparar NO
// vuelva a entrar en la rueda por el seam, SIN tocar el contrato de entrega
// legítima.»
//
// THE CHAIN (verified `file:line` before touching anything; source report
// `.dsh/reports/explore-deep/2026-09-17-seam-vs-cap.md`, 449 lines, READ-ONLY):
//   • CAP:                `messages.ts:1862` `redeliveryAttemptsExhausted(attempts, this.maxAttempts)`
//                         → `:1863` writes `terminal` → `:1864` WARN → `:1865` return.
//                         `RE_DELIVERY_DEFAULT_MAX_ATTEMPTS = 12` (`:1048`).
//   • COUNTER:            `pairConsecutiveAttemptCount` (`:1147-1180`) walks FORWARD,
//                         resetting to 0 ONLY at a SUCCESS (`:1162`); `prepared` +1
//                         (`:1167`); `failed` +1 only when unpaired (`:1172`);
//                         `terminal` does NOT break the run (`:1177`).
//   • WHERE THE ROWS GO:  `run()` (`:2196`) → `:2210-2214`: if
//                         `rows.length > COMPACTION_LINE_THRESHOLD` (`:259` = 2000)
//                         → `rows = compactDeliveryRows(rows)` (`:2211`) → REWRITES
//                         the file (`:2212`) → the cap counts over THOSE rows (`:2224`).
//   • THE DESTRUCTOR:     OLD `compactDeliveryRows` kept ONE row per pair.
//                         MEASURED: one boot collapsed 12 428 rows / 111 multi-row
//                         pairs → 12 066 rows / 0 multi-row pairs; `maxConsec` over
//                         the live ledger = 4; pairs that ever reached 12 = 0.
//   • THE RACE:           measured cadence ~90–180 s/attempt ⇒ ~22–33 min for 12
//                         attempts, against a measured 18 min boot interval ⇒ the
//                         cap lost SYSTEMATICALLY (why a stuck pair went 87→58→64).
// The SEAM (`delivery.ts:496` → `index.ts:696` → `messages.ts:701` `appendFile`) is
// write-ahead BY DESIGN and is NOT touched; the three re-drive loops ALREADY honour
// the stop (`needsRedelivery` `:1012` — `terminal` ⇒ false; sweep `:2206`, boot
// `:2223`, drain `:945`). ONE link was broken: THE RESETTER.
//
// ★ THE ONE DEPARTURE FROM THE BRIEF'S LETTER, DECLARED AND PROVED (see test (7)):
// the brief asked for a row budget of «at most 12 attempt ROWS». That is
// UNSATISFIABLE against its own acceptance and PROVED SO exhaustively here: one
// live attempt is TWO rows (`prepared` + `failed`), so ≤ 13 ROWS can encode at most
// 7 ATTEMPTS on the very fixture the brief specifies — against a cap of 12. The
// shipped rule bounds the budget in the CAP'S OWN UNIT instead, and the cap's
// DECISION is exact. Test (7) PINS the contradiction with the numbers.
//
// LANE ② DISCIPLINE (as `redelivery-cap-reachability.test.js`): NO build — the test
// exercises the SOURCE directly; `messages.ts` is SELF-CONTAINED (no relative
// imports), so plain `.ts` import loads under Node's type-stripping.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  RE_DELIVERY_DEFAULT_MAX_ATTEMPTS,
  compactDeliveryRows,
  needsRedelivery,
  pairConsecutiveAttemptCount
} from '../packages/dshd-core/src/messages.ts'

/** The module's success class (`isDeliverySuccess`, :1057 — module-private, so
 * mirrored here: `delivered`/`resumed`/`self` are the run's RESET). */
const SUCCESS = new Set(['delivered', 'resumed', 'self'])
const isDeliverySuccess = (status) => SUCCESS.has(status)

const CAP = RE_DELIVERY_DEFAULT_MAX_ATTEMPTS // 12 — the cap the stop fires at
const P = 'm-cap'
const R = 'stuck-post'

const row = (status, ts, messageId = P, recipientId = R) => ({ messageId, recipientId, status, ts })
/** `attempts` re-drive cycles, each the LIVE 2-row shape: `prepared` + its `failed`
 * rejection DELIVER_LATENCY later (the measured ~0.2–0.5 s signature). */
const cycles = (attempts, t0 = 0, messageId = P, recipientId = R) => {
  const rows = []
  for (let i = 0; i < attempts; i++) {
    rows.push(row('prepared', t0 + i * 1000, messageId, recipientId))
    rows.push(row('failed', t0 + i * 1000 + 300, messageId, recipientId))
  }
  return rows
}
const count = (rows, messageId = P, recipientId = R) => pairConsecutiveAttemptCount(rows, messageId, recipientId)
const keptOf = (rows, messageId = P, recipientId = R) => compactDeliveryRows(rows).filter((r) => r.messageId === messageId && r.recipientId === recipientId)

// ─────────────────────────────────────────────────────────────────────────────
// (1) ★ THE OBJECTIVE: the fix makes the cap REACHABLE, and the decision survives
//     compaction — which is exactly what the OLD resetter destroyed.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-419 (1) ★ THE CAP IS REACHABLE AFTER COMPACTION: a pair at 12 attempts (prepared+failed alternating) still reads >= 12 once compacted — the resetter no longer erases the run', () => {
  const rows = cycles(CAP) // 12 attempts, 24 rows, ZERO successes — the stuck class
  assert.equal(count(rows), CAP, `the FULL ledger reads ${CAP} attempts — the premise of the fixture`)
  assert.ok(
    rows.filter((r) => r.status === 'prepared' || r.status === 'failed').length === 2 * CAP,
    'and the fixture really carries 2 rows per attempt (the live write-ahead shape) — 12 ATTEMPTS are 24 ROWS'
  )

  const compacted = compactDeliveryRows(rows)
  const after = count(compacted)
  assert.ok(
    after >= CAP,
    `★ THE FIX: after compaction the pair STILL reads >= ${CAP} (got ${after}) ⇒ redeliveryAttemptsExhausted(attempts, ${CAP}) is TRUE and the stop FIRES on the next pass. PRE-FIX this read 1 (the pair collapsed to a single row) — that is the unreachability the lane repairs.`
  )
  assert.equal(after, CAP, `the compacted count is EXACTLY the cap (${CAP}) — the decision instant is preserved verbatim, not merely crossed (got ${after})`)
  assert.equal(keptOf(rows).length, 2 * CAP - 1, `rows kept for the pair: ${2 * CAP - 1} — the MINIMAL contiguous suffix reading ${CAP} attempts over a 2-row cycle (${CAP - 1} whole \`prepared\`+\`failed\` cycles + the final \`prepared\`)`)

  // ★ THE ROW BOUND — the brief's intent (no unbounded retention), asserted as an
  // ABSOLUTE ceiling over an arbitrarily long history. The honest bound is stated
  // in the cap's UNIT and is proved in (3b): the kept span holds exactly
  // `min(run, CAP)` COUNTED rows, so on the live 2-row-cycle shape (and on the
  // dominant bare-`prepared` shape) it is ≤ 2·CAP rows.
  assert.ok(
    compacted.length <= 2 * CAP,
    `the compaction retains at most ~2 x CAP rows for the pair (${compacted.length} <= ${2 * CAP}) — BOUNDED, never growing with the loop's length`
  )
})

test('builder-419 (1b) ★ THE SAME PAIR, HARDER: 40 attempts still compact to a BOUNDED keep-set that reads the cap — no growth with history', () => {
  const rows = cycles(40)
  assert.equal(count(rows), 40, 'the full ledger reads 40 attempts (well past the cap)')
  const compacted = compactDeliveryRows(rows)
  assert.equal(count(compacted), CAP, `the compacted pair reads EXACTLY ${CAP} — the cap's boolean is preserved, and the number is normalised to the decision point`)
  assert.equal(keptOf(rows).length, 2 * CAP - 1, `rows kept: ${2 * CAP - 1} — IDENTICAL to the 12-attempt case: the keep-set does NOT grow with the loop's length`)
  assert.ok(compacted.length <= 2 * CAP, `and the absolute ceiling holds (${compacted.length} <= ${2 * CAP})`)
})

// ─────────────────────────────────────────────────────────────────────────────
// (2) THE RUN IS CLIPPED AT ITS LAST SUCCESS — the counter's reset is honoured.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-419 (2) THE RUN STOPS AT THE LAST SUCCESS: a pair that DELIVERED and then failed 4 times reads 4, and the success is NOT kept', () => {
  const rows = [
    ...cycles(3, 0), // an older run of 3 attempts
    row('delivered', 10_000), // ← the SUCCESS: the counter's reset
    ...cycles(4, 20_000) // the CURRENT run: 4 attempts
  ]
  assert.equal(count(rows), 4, 'the full ledger reads 4 — the pre-success history is released by the success (the :1000-1001 contract)')

  const compacted = compactDeliveryRows(rows)
  assert.equal(count(compacted), 4, `the compacted pair ALSO reads 4 — the current run is preserved EXACTLY, never counted twice nor deflated (got ${count(compacted)})`)
  assert.ok(
    !compacted.some((r) => isDeliverySuccess(r.status)),
    'NO success row is kept: the run\'s reset is a BOUNDARY, never a retained row — keeping it would let a stale success shadow the pair in a later `latestPerPair` read'
  )
  // The rows BEFORE the last success carry nothing the counter reads: dropping them
  // is count-EXACT (the reset at :1162), which is why the keep-set is tight.
  assert.ok(
    keptOf(rows).length < rows.length,
    `the pre-success run is DROPPED (kept ${keptOf(rows).length} of ${rows.length} rows) — count-exact by construction, since :1162 resets there`
  )
})

test('builder-419 (2b) A PAIR WHOSE HISTORY ENDS IN A SUCCESS RESETS TO 0 — and keeps exactly ONE row', () => {
  const rows = [...cycles(CAP, 0), row('delivered', 90_000)]
  assert.equal(count(rows), 0, 'the success releases the WHOLE 12-attempt run — the pair is at 0')
  assert.equal(needsRedelivery('delivered'), false, 'and it is settled for the re-drive loops')

  const compacted = compactDeliveryRows(rows)
  assert.equal(count(compacted), 0, 'still 0 after compaction (a settled pair is never made to look failing)')
  assert.equal(keptOf(rows).length, 1, `exactly ONE row is kept (got ${keptOf(rows).length}) — the pre-fix behaviour for a settled pair, PRESERVED`)
  assert.equal(keptOf(rows)[0].status, 'delivered', 'and the kept row IS the success (the outcome the loops read)')
})

// ─────────────────────────────────────────────────────────────────────────────
// (3) NO UNBOUNDED GROWTH — the property the old policy did provide, kept.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-419 (3) BOUNDED: an 80-row / 40-attempt pair keeps <= 2 x CAP rows, and so does a 1000-row one — the keep-set is a function of the CAP, not of the history', () => {
  for (const attempts of [40, 250, 1000]) {
    const rows = cycles(attempts)
    const compacted = compactDeliveryRows(rows)
    assert.ok(
      compacted.length <= 2 * CAP,
      `${attempts} attempts (${rows.length} rows) → ${compacted.length} rows kept (<= ${2 * CAP}) — the keep-set is BOUNDED`
    )
    assert.equal(count(compacted), CAP, `and it still reads EXACTLY ${CAP} — the cap's decision survives at every history length`)
  }
  const huge = compactDeliveryRows(cycles(1000))
  const small = compactDeliveryRows(cycles(CAP))
  assert.equal(huge.length, small.length, 'the 1000-attempt keep-set is the SAME SIZE as the 12-attempt one — growth is impossible by construction')
})

test('builder-419 (3b) BOUNDED AGAINST DUST TOO: inline `terminal` rows (the G2 in-place flip) never pull in a COUNTED row older than the cap-th — retention is bounded in ATTEMPTS', () => {
  // ★ THE HONEST BOUND, stated in the unit it is actually bounded by (this test's
  // first draft claimed a tighter ROW bound that is FALSE — the draft was corrected
  // against measurement, and the correction is the point of this test):
  //   • the kept span is a CONTIGUOUS SUFFIX ending at the pair's latest row;
  //   • it holds EXACTLY `min(run, CAP)` COUNTED rows — never more;
  //   • a `terminal` row that the G2 settle flipped IN PLACE can sit INSIDE that
  //     window; it carries no count but it DOES terminate the `preparedAwaiting`
  //     pairing state in the forward walk (measured: `prepared, terminal, failed`
  //     counts 2, while `prepared, failed` counts 1 — so dropping it would DEFLATE
  //     the count). Such rows can therefore lengthen the window in ROWS, but they
  //     can never reach a COUNTED row older than the cap-th. What is bounded — and
  //     what the cap depends on — is the number of ATTEMPTS retained, which is ≤ CAP.
  const rows = []
  for (let i = 0; i < 100; i++) {
    rows.push(row('prepared', i * 1000))
    rows.push(row('failed', i * 1000 + 200))
    rows.push(row('terminal', i * 1000 + 400))
  }
  const compacted = compactDeliveryRows(rows)
  assert.equal(count(compacted), CAP, `the decision is preserved (reads EXACTLY ${CAP}) — \`terminal\` does NOT break the run, exactly as :1153-1157 documents`)

  // (a) IT IS A CONTIGUOUS SUFFIX: it starts at some index and runs to the end.
  const firstKept = rows.indexOf(compacted[0])
  assert.notEqual(firstKept, -1, 'the first kept row is an input row')
  assert.deepEqual(compacted, rows.slice(firstKept), 'the kept span is a CONTIGUOUS SUFFIX of the pair\'s rows, ending at its latest row — no holes, no reordering')

  // (b) NO COUNTED ROW OLDER THAN THE CAP-TH IS EVER RETAINED — the real bound, read
  //     through the module's OWN counter (never a hand-rolled pairing derivation:
  //     the backward walk's pairing state is NOT the mirror of the forward one, and
  //     a hand-rolled version of it is exactly how an earlier draft of this test
  //     went wrong twice). MINIMALITY, asserted directly: the kept span still reads
  //     >= CAP, and dropping its OLDEST row drops below CAP.
  assert.ok(
    count(compacted) >= CAP,
    `the kept span still reads >= ${CAP} (got ${count(compacted)})`
  )
  assert.ok(
    count(compacted.slice(1)) < CAP,
    `and dropping its OLDEST row falls BELOW the cap (${count(compacted.slice(1))} < ${CAP}) — the span is MINIMAL: it starts as late as the decision allows, which is what keeps the retention tight`
  )

  // (c) The honest worst case, DECLARED: dust INSIDE the minimal window lengthens it
  //     in rows (measured: ~500 `terminal` per counted row ⇒ ~5 500 rows kept) — but
  //     the retained ATTEMPTS stay at CAP, and such a pair is an outlier by
  //     construction (a pair with thousands of G2-flipped rows). The pre-fix policy
  //     did bound this at 1 row; the trade is deliberate and is the whole lane: a
  //     bounded window that PRESERVES the cap's decision beats a 1-row window that
  //     destroys it.
  const dustPerAttempt = 5
  const dusty = []
  for (let i = 0; i < CAP + 1; i++) {
    dusty.push(row('prepared', i * 100))
    for (let d = 0; d < dustPerAttempt; d++) dusty.push(row('terminal', i * 100 + d + 1))
  }
  const dustyKept = compactDeliveryRows(dusty)
  assert.equal(count(dustyKept), CAP, 'with 5 `terminal` rows interleaved per attempt the decision is still EXACT')
  assert.ok(
    dustyKept.length < dusty.length,
    `and the window is still strictly smaller than the input (${dustyKept.length} < ${dusty.length}) — the older dust is still discarded`
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// (4) IDEMPOTENCE — compactions chain across boots; a second pass must be a no-op.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-419 (4) IDEMPOTENCE: compact(compact(x)) deep-equals compact(x) — over every fixture shape of this file', () => {
  const fixtures = {
    alternating12: cycles(CAP),
    alternating40: cycles(40),
    successThen4: [...cycles(3, 0), row('delivered', 10_000), ...cycles(4, 20_000)],
    endsInSuccess: [...cycles(CAP), row('delivered', 90_000)],
    singlePrepared: [row('prepared', 1)],
    singleTerminal: [row('terminal', 1)],
    singleFailed: [row('failed', 1)],
    withDust: (() => { const r = []; for (let i = 0; i < 60; i++) { r.push(row('prepared', i * 300)); r.push(row('failed', i * 300 + 100)); r.push(row('terminal', i * 300 + 200)) } return r })(),
    mixedWithOtherPairs: [
      ...cycles(CAP, 0),
      ...cycles(2, 0, 'm-other', 'other-post'),
      row('delivered', 5, 'm-third', 'third-post'),
      ...cycles(20, 0)
    ],
    bareFailedRun: Array.from({ length: 20 }, (_, i) => row('failed', i)),
    barePreparedRun: Array.from({ length: 20 }, (_, i) => row('prepared', i)),
    terminalMidRun: [row('prepared', 1), row('terminal', 2), row('failed', 3), ...cycles(15, 10)],
    empty: []
  }
  for (const [name, rows] of Object.entries(fixtures)) {
    const once = compactDeliveryRows(rows)
    const twice = compactDeliveryRows(once)
    const thrice = compactDeliveryRows(twice)
    assert.deepEqual(twice, once, `fixture "${name}": compact(compact(x)) deep-equals compact(x)`)
    assert.deepEqual(thrice, once, `fixture "${name}": and a THIRD pass is still a no-op (compactions chain across boots)`)
    // Order is SUBSTRATE for the forward-walking counter: verify it is preserved.
    const key = (r) => `${r.messageId}|${r.recipientId}|${r.status}|${r.ts}`
    assert.deepEqual(once.map(key), rows.filter((r) => once.includes(r)).map(key), `fixture "${name}": the kept rows preserve their original RELATIVE FILE ORDER`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// (5) THE LEGITIMATE-DELIVERY CONTRACT IS UNTOUCHED.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-419 (5a) a pair with a SINGLE `prepared` row keeps exactly 1 row — the crash-class write-ahead is unchanged', () => {
  const rows = [row('prepared', 1)]
  const compacted = compactDeliveryRows(rows)
  assert.equal(compacted.length, 1, 'exactly 1 row, as before')
  assert.deepEqual(compacted, rows, 'and it is the same row (byte-identical)')
})

test('builder-419 (5b) a pair whose LATEST row is `delivered` keeps exactly 1 row — a settled legitimate delivery is untouched', () => {
  const rows = [row('prepared', 1), row('failed', 2), row('delivered', 3)]
  const compacted = compactDeliveryRows(rows)
  assert.equal(compacted.length, 1, 'exactly 1 row, as before')
  assert.deepEqual(compacted, [rows[2]], 'the kept row is the SUCCESS (the latest) — the outcome the re-drive loops read')
})

test('builder-419 (5c) THE PREDICATES ARE UNAFFECTED: `needsRedelivery` and the count of a succeeded pair read EXACTLY what they read before (0)', () => {
  // The fix changed a KEEP POLICY, never a predicate — assert the values the
  // re-drive loops consult, BEFORE and AFTER compaction, are identical.
  const succeeded = [...cycles(5, 0), row('delivered', 50_000)]
  assert.equal(needsRedelivery('delivered'), false, 'a delivered latest row is settled (unchanged)')
  assert.equal(needsRedelivery('resumed'), false, 'a resumed latest row is settled (unchanged)')
  assert.equal(needsRedelivery('self'), false, 'self is held by design (unchanged)')
  assert.equal(needsRedelivery('terminal'), false, 'terminal is the stop — NEVER re-driven (unchanged; :1012)')
  assert.equal(needsRedelivery('prepared'), true, 'a prepared write-ahead IS re-driven (unchanged)')
  assert.equal(needsRedelivery('failed'), true, 'a failed rejection IS re-driven (unchanged)')
  assert.equal(needsRedelivery(null), true, 'no row yet ⇒ deliver (unchanged)')

  assert.equal(count(succeeded), 0, 'the count of a pair whose history ends in a success is 0 (unchanged — the contract at :1000-1001)')
  const compacted = compactDeliveryRows(succeeded)
  assert.equal(count(compacted), 0, 'and it reads 0 AFTER compaction too — the compaction cannot resurrect a released run')
  const latest = compacted[compacted.length - 1]
  assert.equal(needsRedelivery(latest.status), false, 'the pair-latest is the success ⇒ the re-drive loops still SKIP it (the legitimate-delivery contract)')

  // The same for EVERY pair in a mixed ledger: compaction is decision-preserving
  // for the predicate the loops read.
  const mixed = [...cycles(20, 0), row('delivered', 5, 'm-ok', 'r-ok'), row('terminal', 9, 'm-dead', 'r-dead')]
  const before = new Map()
  for (const r of mixed) before.set(`${r.messageId}|${r.recipientId}`, r)
  const afterMixed = compactDeliveryRows(mixed)
  for (const r of afterMixed) {
    const latestBefore = before.get(`${r.messageId}|${r.recipientId}`)
    if (r.messageId === latestBefore.messageId && r.ts === latestBefore.ts) {
      assert.equal(needsRedelivery(r.status), needsRedelivery(latestBefore.status), `${r.messageId}: the pair-latest verdict is unchanged by compaction`)
    }
  }
})

test('builder-419 (5d) THE SEAM STILL WINS THE ONE CASE IT MUST: a re-send of a STOPPED pair continues the run (>= CAP) so the cap re-stops it in ONE pass', () => {
  // The host's objective, end to end at the POLICY level: the cap fired, wrote
  // `terminal`; the seam (write-ahead, untouched) then re-sends the same pair,
  // appending `prepared`. What does the next boot count?
  const stopped = [...cycles(CAP, 0), row('terminal', 50_000)]
  assert.equal(count(stopped), CAP, 'the stop did not break the run (`terminal` is not a recovery, :1153-1157)')

  const reSent = [...stopped, row('prepared', 60_000)] // ← THE SEAM (delivery.ts:496 → messages.ts:701)
  assert.ok(count(reSent) >= CAP, `the seam-send extends the SAME run ⇒ ${count(reSent)} >= ${CAP}: the cap re-fires on the very NEXT pass instead of looping forever`)

  const compacted = compactDeliveryRows(reSent)
  assert.ok(
    count(compacted) >= CAP,
    `★ AND IT SURVIVES THE BOOT: after compaction the pair STILL reads >= ${CAP} (got ${count(compacted)}) ⇒ the partner re-enters the wheel is IMPOSSIBLE: the stop is re-applied in ONE pass. PRE-FIX the boot collapsed it to 1 and the loop restarted from zero — the measured 87→58→64 recurrence.`
  )
  assert.ok(
    !compacted.some((r) => r.status === 'terminal' && r.ts === 50_000) || count(compacted) >= CAP,
    'the historical `terminal` may be retained (it costs nothing and does not break the run) but it can never SHADOW the pair: the predicate reads the LATEST row'
  )
  assert.equal(needsRedelivery(compacted[compacted.length - 1].status), true, 'the pair-latest is the seam\'s `prepared` ⇒ it IS in the cap\'s domain ⇒ the cap gets to decide (and fires)')
})

// ─────────────────────────────────────────────────────────────────────────────
// (6) FILE ORDER + PARITY: the compaction is a pure SELECTION.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-419 (6) FILE ORDER IS SUBSTRATE and the compaction is a pure SELECTION — never a merge/rewrite/invention', () => {
  const rows = [
    row('prepared', 1, 'm-a', 'a'),
    row('prepared', 2, 'm-b', 'b'),
    row('failed', 3, 'm-a', 'a'),
    row('delivered', 4, 'm-b', 'b'),
    ...cycles(20, 10, 'm-c', 'c')
  ]
  const compacted = compactDeliveryRows(rows)
  // Pure selection: every kept row is one of the INPUT rows, IDENTICALLY (===).
  for (const kept of compacted) {
    assert.ok(rows.includes(kept), 'every kept row is an input row by identity — no row is synthesised')
  }
  // Order: the kept rows appear in the same relative order as in the input.
  const inputOrder = rows.filter((r) => compacted.includes(r))
  assert.deepEqual(compacted, inputOrder, 'the kept rows preserve their ORIGINAL RELATIVE ORDER (the counter walks FORWARD — order is substrate)')
  // And the pair-latest of every pair is still its latest (the outcome the loops read).
  for (const key of new Set(rows.map((r) => `${r.messageId}|${r.recipientId}`))) {
    const [messageId, recipientId] = key.split('|')
    const pairInput = rows.filter((r) => r.messageId === messageId && r.recipientId === recipientId)
    const pairKept = compacted.filter((r) => r.messageId === messageId && r.recipientId === recipientId)
    const lastInput = pairInput[pairInput.length - 1]
    assert.ok(pairKept.includes(lastInput), `${key}: the pair's LATEST input row is ALWAYS kept (the re-drive loops read it)`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// (7) ★★ THE PROOF THAT THE BRIEF'S ROW BUDGET IS UNSATISFIABLE — pinned, so the
//     departure in (1) is auditable rather than a silent reinterpretation.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-419 (7) ★★ THE ROW-BUDGET CONTRADICTION, PINNED: «<= 13 ROWS» can encode at most 7 ATTEMPTS, so a 12-ROW budget would re-create the very unreachability this lane repairs', () => {
  const rows = cycles(CAP) // the brief's OWN fixture: 12 attempts, prepared+failed alternating
  assert.equal(rows.length, 24, 'the fixture is 24 rows (12 attempts x the live 2-row cycle)')

  // EXHAUSTIVE over EVERY contiguous window <= 13 rows: the best count reachable.
  let best13 = 0
  for (let len = 1; len <= 13; len++) {
    for (let start = 0; start + len <= rows.length; start++) {
      best13 = Math.max(best13, count(rows.slice(start, start + len)))
    }
  }
  assert.equal(
    best13,
    7,
    `★ PROVED: with <= 13 rows kept, the MAXIMUM readable count is ${best13} — against a cap of ${CAP}. So «count >= 12» AND «rows <= 13» CANNOT both hold on the brief's own fixture: the two halves of its test-1 acceptance are mutually exclusive. A 12-ROW budget would ship an unreachable cap AGAIN.`
  )
  assert.ok(best13 < CAP, `and ${best13} < ${CAP} — the cap would be DEAD CODE under a row-counted budget, which is precisely the defect being repaired`)

  // The row budget IS sufficient on the DOMINANT live shape (37 of 39 measured
  // stuck pairs carry ZERO `failed`): there 1 attempt = 1 row.
  const bare = Array.from({ length: CAP }, (_, i) => row('prepared', i))
  assert.equal(count(bare), CAP, 'a 12-row bare-`prepared` run ALREADY reads 12 — this is the shape the brief\'s «12 filas» arithmetic implicitly assumed')
  assert.equal(compactDeliveryRows(bare).length, CAP, `and it keeps exactly ${CAP} rows — <= 13, as the brief intended`)
  assert.equal(count(compactDeliveryRows(bare)), CAP, 'so on the dominant live shape the shipped policy COINCIDES with the brief\'s intent: exact count, bounded rows')

  // What the SHIPPED rule does on the 2-row-cycle fixture: exact decision, bounded.
  const compacted = compactDeliveryRows(rows)
  assert.equal(count(compacted), CAP, `the shipped rule keeps the DECISION exact on the same fixture (reads ${CAP})`)
  assert.ok(compacted.length <= 2 * CAP, `and stays bounded (${compacted.length} <= ${2 * CAP}) — the departure is ONLY in the unit, never in the guarantee`)
})

// ─────────────────────────────────────────────────────────────────────────────
// (8) THE COUNTER ITSELF IS UNTOUCHED — the fix is the KEEP POLICY only.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-419 (8) REGRESSION GUARD — the counter, the cap constant and the predicates are byte-for-byte the pre-fix semantics', () => {
  assert.equal(CAP, 12, 'the cap is still 12 (`RE_DELIVERY_DEFAULT_MAX_ATTEMPTS`) — NOT touched')
  assert.equal(pairConsecutiveAttemptCount(cycles(CAP), P, R), CAP, 'the counter on a 12-attempt run still reads 12 — NOT touched')
  assert.equal(pairConsecutiveAttemptCount([], P, R), 0, 'no rows ⇒ 0')
  assert.equal(pairConsecutiveAttemptCount(cycles(11), P, R), 11, 'and 11 attempts read 11 — the cap needs the 12th')
  // The unit discipline that the counter's own doc pins: 12 bare `failed` = 12.
  assert.equal(
    pairConsecutiveAttemptCount(Array.from({ length: CAP }, (_, i) => row('failed', i)), P, R),
    CAP,
    'the legacy LANE 2 shape (12 bare `failed`, no `prepared`) still reads 12 — the unit is the ATTEMPT, unchanged'
  )
  // `terminal` does not break the run (the property the objective leans on).
  assert.equal(
    pairConsecutiveAttemptCount([row('terminal', 1), ...cycles(CAP, 10)], P, R),
    CAP,
    'a leading `terminal` does not suppress the following run — unchanged'
  )
  assert.equal(
    pairConsecutiveAttemptCount([...cycles(CAP, 0), row('terminal', 99), row('failed', 100)], P, R),
    CAP + 1,
    'and a `failed` after a `terminal` counts alone (the conservative pairing) — unchanged'
  )
  assert.equal(
    pairConsecutiveAttemptCount([row('prepared', 1), row('failed', 2)], P, R),
    1,
    'a `prepared` + its `failed` is ONE attempt, never two — the unit is unchanged'
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// (10) ★★ SEVENTH TEST (amended brief #2): VERBATIM ROW PRESERVATION — the
//      optional `noWake` flag must survive the compaction untouched.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-419 (10) ★★ VERBATIM COPY: rows carrying `noWake: true` survive the compaction FIELD BY FIELD — the policy SELECTS rows, it never reconstructs them', () => {
  // WHY (the amended brief, from the QH\'s live measurement `fb-1641`): a
  // RECONSTRUCTED row of the shape `{messageId, recipientId, status, ts}` SILENTLY
  // DROPS every optional field — concretely `noWake` (`DeliveryRow.noWake`, :156),
  // which means «do NOT wake the recipient». The QH measured that exact loss on
  // the LIVE ledger (pair m-15224: `terminal … noWake:true` followed by rows
  // WITHOUT the flag) — there the SEAM lost it on a re-delivery, which is a
  // DIFFERENT defect and is NOT repaired here. What this test pins is that the
  // COMPACTOR cannot re-introduce the same class in the counter\'s substrate.
  const flagged = [
    { messageId: P, recipientId: R, status: 'prepared', ts: 1000, noWake: true },
    { messageId: P, recipientId: R, status: 'failed', ts: 1300, noWake: true },
    { messageId: P, recipientId: R, status: 'prepared', ts: 2000, noWake: true },
    { messageId: P, recipientId: R, status: 'failed', ts: 2300 }, // ← NO flag (a real ledger mixes both)
    { messageId: P, recipientId: R, status: 'prepared', ts: 3000, noWake: true },
    { messageId: P, recipientId: R, status: 'failed', ts: 3300, noWake: true },
    { messageId: P, recipientId: R, status: 'prepared', ts: 4000, noWake: true } // the latest row
  ]
  const compacted = compactDeliveryRows(flagged)
  assert.ok(compacted.length > 0 && compacted.length <= flagged.length, 'the compaction kept a non-empty subset')

  // (a) FIELD BY FIELD — every kept row is the SAME OBJECT it was given, so ALL
  //     its fields (including the optional `noWake`) are intact. Identity is the
  //     strongest form of the assertion: a reconstruction cannot pass it.
  for (const kept of compacted) {
    assert.ok(flagged.includes(kept), `the kept row ${kept.status}@${kept.ts} is an INPUT row BY IDENTITY — never a synthesized object`)
  }
  // …and restated as a deep field-by-field comparison (so the assertion survives
  // even if a future refactor returns copies: the VALUES must match key for key).
  assert.deepEqual(
    compacted,
    compacted.map((kept) => flagged.find((r) => r.status === kept.status && r.ts === kept.ts)),
    'every kept row deep-equals the original row FIELD BY FIELD (no optional field is lost)'
  )

  // (b) `noWake: true` lives EXACTLY where the original had it — keyed by (status, ts).
  const original = new Map(flagged.map((r) => [`${r.status}@${r.ts}`, r.noWake]))
  for (const kept of compacted) {
    assert.equal(
      kept.noWake,
      original.get(`${kept.status}@${kept.ts}`),
      `the kept row ${kept.status}@${kept.ts} carries noWake=${JSON.stringify(original.get(`${kept.status}@${kept.ts}`))} — EXACTLY as the original had it (got ${JSON.stringify(kept.noWake)})`
    )
    // And the KEY is preserved when the original had it (an absent vs present
    // optional is distinguishable on disk: `{"noWake":true}` vs no key at all).
    if (original.get(`${kept.status}@${kept.ts}`) === true) {
      assert.ok(Object.prototype.hasOwnProperty.call(kept, 'noWake'), 'and the KEY itself is present when the original carried it (the on-disk JSON keeps `"noWake":true`)')
    }
  }
  assert.ok(
    compacted.some((r) => r.noWake === true),
    'at least one `noWake: true` row is retained — the flag really is exercised, not vacuously true'
  )

  // (c) ROWS NOT KEPT DO NOT APPEAR — the complement is honest (selection, not merge).
  const keptTs = new Set(compacted.map((r) => `${r.status}@${r.ts}`))
  const dropped = flagged.filter((r) => !keptTs.has(`${r.status}@${r.ts}`))
  for (const d of dropped) {
    assert.ok(!compacted.includes(d), `the dropped row ${d.status}@${d.ts} does NOT appear in the output`)
  }
  // Every input row is accounted for: kept OR dropped, never duplicated/invented.
  assert.equal(compacted.length + dropped.length, flagged.length, 'kept + dropped = input (NO row is duplicated, invented or lost silently)')
  assert.equal(new Set(compacted).size, compacted.length, 'and no kept row appears twice')

  // (d) The flag survives the SERIALIZATION the boot write performs — the artifact
  //     the next boot parses must still carry `"noWake":true`.
  const lines = compacted.map((r) => JSON.stringify(r))
  const flaggedLines = lines.filter((l) => l.includes('"noWake":true'))
  assert.ok(flaggedLines.length > 0, 'the boot\'s own `JSON.stringify(row)` output still contains `"noWake":true`')
  assert.equal(
    flaggedLines.length,
    compacted.filter((r) => r.noWake === true).length,
    'every kept `noWake:true` row serializes its flag — the round-trip through disk is lossless'
  )
  for (const l of flaggedLines) {
    const round = JSON.parse(l)
    assert.equal(round.noWake, true, 'and it PARSES back as noWake:true (the next boot reads the same intent)')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// (9) ★★ RED-FIRST / REVERT-CHECK (mandatory): the SAME asserts (1) and (5) run
//     against a NEUTRALIZED copy of the PRE-FIX `compactDeliveryRows` — proving
//     this file measures THE FIX and not something else.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-419 (9) ★★ REVERT-CHECK: with `compactDeliveryRows` restored to the PRE-FIX «one row per pair» policy, assert (1) FAILS (count 1, not 12) while assert (5) PASSES — the test measures the fix', async () => {
  // THE HOUSE REVERT PATTERN (`redelivery-cap-reachability.test.js`): a TEXTUAL copy
  // of `messages.ts` in a mkdtemp with the fix NEUTRALIZED back to the pre-fix
  // computation — ZERO writes into the repo. The pre-fix body is exactly what
  // `git show HEAD:packages/dshd-core/src/messages.ts` holds:
  //   keep a row IFF its index is the LAST index of its key ⇒ ONE row per pair.
  const src = readFileSync(new URL('../packages/dshd-core/src/messages.ts', import.meta.url), 'utf8')
  const shipped = /export function compactDeliveryRows\(rows: readonly DeliveryRow\[\]\): DeliveryRow\[\] \{[\s\S]*?\n\}/
  assert.ok(shipped.test(src), 'the shipped `compactDeliveryRows` body must be present and match the neutralization pattern — otherwise the RED check is a tautology')
  const neutralized = src.replace(
    shipped,
    [
      'export function compactDeliveryRows(rows: readonly DeliveryRow[]): DeliveryRow[] {',
      '  const latestIndex = new Map<string, number>()',
      '  for (let i = 0; i < rows.length; i++) latestIndex.set(deliveryKey(rows[i]), i)',
      '  const result: DeliveryRow[] = []',
      '  for (let i = 0; i < rows.length; i++) {',
      '    if (latestIndex.get(deliveryKey(rows[i])) === i) result.push(rows[i])',
      '  }',
      '  return result',
      '}'
    ].join('\n')
  )
  assert.notEqual(neutralized, src, 'the neutralization must actually apply — otherwise the RED check proves nothing')
  const dir = mkdtempSync(path.join(tmpdir(), 'b419-neutral-'))
  writeFileSync(path.join(dir, 'messages.ts'), neutralized)
  try {
    const M = await import(pathToFileURL(path.join(dir, 'messages.ts')).href)
    const pCount = (rs, messageId = P, recipientId = R) => M.pairConsecutiveAttemptCount(rs, messageId, recipientId)
    const pKept = (rs, messageId = P, recipientId = R) => M.compactDeliveryRows(rs).filter((r) => r.messageId === messageId && r.recipientId === recipientId)

    // ── ASSERT (1) — RED against the PRE-FIX implementation ──────────────────
    const rows = cycles(CAP)
    assert.equal(pCount(rows), CAP, 'PRE-FIX module: the FULL fixture reads 12 (the counter is untouched — the fix is the policy)')
    const preKept = M.compactDeliveryRows(rows)
    assert.equal(pKept(rows).length, 1, 'PRE-FIX: the pair collapses to EXACTLY ONE row (the documented pre-fix policy)')
    const preCount = pCount(preKept)
    assert.equal(
      preCount,
      1,
      `★★ ASSERT (1) IS RED PRE-FIX: after the pre-fix compaction the pair reads ${preCount} attempt — NOT ${CAP}. The measured live symptom («maxConsec 4 → 1» across a boot) reproduced exactly. THIS is the defect the lane repairs, and this file FAILS on it.`
    )
    assert.ok(
      preCount < CAP,
      `⇒ under the PRE-FIX policy the cap could NEVER fire on this pair (${preCount} < ${CAP}): redeliveryAttemptsExhausted() is FALSE, the stop is dead code, and the pair loops forever with its run erased at every boot.`
    )
    // And the SHIPPED module is GREEN on the SAME fixture — the check discriminates.
    const postKept = compactDeliveryRows(rows)
    assert.equal(count(postKept), CAP, `★ AND THE SHIPPED MODULE IS GREEN on the IDENTICAL fixture: count ${count(postKept)} >= ${CAP} ⇒ the cap FIRES. The ONLY difference between RED and GREEN is the KEEP POLICY — nothing else in the module is touched.`)

    // ── ASSERT (5) — GREEN under BOTH policies (the legitimate-delivery contract) ──
    // (5a) a pair with a SINGLE `prepared` row keeps exactly 1 row — under BOTH.
    const single = [row('prepared', 1)]
    assert.equal(pKept(single).length, 1, 'PRE-FIX: a single-`prepared` pair keeps 1 row')
    assert.equal(keptOf(single).length, 1, 'SHIPPED: and it STILL keeps exactly 1 row — UNCHANGED')
    assert.deepEqual(M.compactDeliveryRows(single), compactDeliveryRows(single), 'and the two policies return the IDENTICAL result for this pair — the fix is a no-op on the crash-class shape')

    // (5b) a pair whose LATEST row is `delivered` keeps exactly 1 row — under BOTH.
    const delivered = [row('prepared', 1), row('failed', 2), row('delivered', 3)]
    assert.equal(pKept(delivered).length, 1, 'PRE-FIX: a delivered pair keeps 1 row')
    assert.equal(keptOf(delivered).length, 1, 'SHIPPED: and it STILL keeps exactly 1 row — UNCHANGED')
    assert.deepEqual(M.compactDeliveryRows(delivered), compactDeliveryRows(delivered), 'the two policies return the IDENTICAL result — the legitimate-delivery contract survives the fix byte-for-byte')

    // (5c) the PREDICATES and the count of a succeeded pair — identical under both.
    assert.equal(M.needsRedelivery('delivered'), needsRedelivery('delivered'), '`needsRedelivery(delivered)` is identical pre-fix and shipped (false)')
    assert.equal(M.needsRedelivery('terminal'), needsRedelivery('terminal'), '`needsRedelivery(terminal)` is identical (false) — the stop is never re-driven, both before and after')
    assert.equal(M.needsRedelivery('prepared'), needsRedelivery('prepared'), '`needsRedelivery(prepared)` is identical (true)')
    const succeeded = [...cycles(5, 0), row('delivered', 50_000)]
    assert.equal(pCount(succeeded), 0, 'PRE-FIX: the count of a pair whose history ends in a success is 0')
    assert.equal(count(succeeded), 0, 'SHIPPED: and it is STILL 0 — the release is unchanged')
    assert.equal(pCount(M.compactDeliveryRows(succeeded)), 0, 'PRE-FIX: still 0 after compaction')
    assert.equal(count(compactDeliveryRows(succeeded)), 0, 'SHIPPED: still 0 after compaction — a settled pair is never made to look failing')

    // ★ THE DISCRIMINATION, STATED AS DATA: the two policies agree EXACTLY on the
    // legitimate-delivery shapes and differ ONLY on the looping shape.
    const agreeOn = (rs) => JSON.stringify(M.compactDeliveryRows(rs)) === JSON.stringify(compactDeliveryRows(rs))
    assert.ok(agreeOn(single), 'the policies AGREE on a single-row legitimate pair')
    assert.ok(agreeOn(delivered), 'the policies AGREE on a delivered pair')
    assert.ok(agreeOn(succeeded), 'the policies AGREE on a recovered pair')
    assert.ok(!agreeOn(rows), 'and they DIFFER on the looping pair — the fix changes ONLY what it must change')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// (11) ★★ THIRD REVERT-CHECK (amended brief #2): the seventh test must FAIL
//      against an implementation that RECONSTRUCTS the kept row.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-419 (11) ★★ THIRD REVERT-CHECK: with the policy rewritten to RECONSTRUCT the kept row as `{messageId, recipientId, status, ts}`, the seventh test FAILS (noWake is lost) while the shipped policy PASSES', async () => {
  // THE DEFECT CLASS THE AMENDED BRIEF NAMES: a kept row rebuilt from its four
  // REQUIRED fields silently loses every OPTIONAL one — here `noWake`. This
  // revert-check proves test (10) actually measures verbatim preservation, by
  // running the SAME assertions against a reconstructing variant.
  const src = readFileSync(new URL('../packages/dshd-core/src/messages.ts', import.meta.url), 'utf8')
  const shipped = /export function compactDeliveryRows\(rows: readonly DeliveryRow\[\]\): DeliveryRow\[\] \{[\s\S]*?\n\}/
  assert.ok(shipped.test(src), 'the shipped body must match the neutralization pattern — otherwise the check is a tautology')
  // The variant: IDENTICAL selection, but the rows are REBUILT from the four
  // required fields — i.e. exactly the temptation the amended brief forbids.
  // (`deliveryKey` keeps its meaning; the reconstruction is the ONLY difference.)
  const reconstruction = [
    'export function compactDeliveryRows(rows: readonly DeliveryRow[]): DeliveryRow[] {',
    '  const positions = new Map<string, number[]>()',
    '  for (let i = 0; i < rows.length; i++) {',
    '    const key = deliveryKey(rows[i])',
    '    const list = positions.get(key)',
    '    if (list === undefined) positions.set(key, [i])',
    '    else list.push(i)',
    '  }',
    '  const keep = new Set<number>()',
    '  for (const list of positions.values()) {',
    '    const last = list.length - 1',
    '    const pairRows = list.map((i) => rows[i])',
    '    const messageId = pairRows[last].messageId',
    '    const recipientId = pairRows[last].recipientId',
    '    const run = pairConsecutiveAttemptCount(pairRows, messageId, recipientId)',
    '    const target = run < RE_DELIVERY_DEFAULT_MAX_ATTEMPTS ? run : RE_DELIVERY_DEFAULT_MAX_ATTEMPTS',
    '    if (target === 0) { keep.add(list[last]); continue }',
    '    let start = last',
    '    for (let i = last; i >= 0; i--) {',
    '      if (pairConsecutiveAttemptCount(pairRows.slice(i), messageId, recipientId) >= target) { start = i; break }',
    '    }',
    '    for (let i = start; i <= last; i++) keep.add(list[i])',
    '  }',
    '  const result: DeliveryRow[] = []',
    // ★ THE DEFECT: rebuilding from the REQUIRED fields only — `noWake` is dropped.
    '  for (let i = 0; i < rows.length; i++) {',
    '    if (keep.has(i)) result.push({ messageId: rows[i].messageId, recipientId: rows[i].recipientId, status: rows[i].status, ts: rows[i].ts })',
    '  }',
    '  return result',
    '}'
  ].join('\n')
  const neutral = src.replace(shipped, reconstruction)
  assert.notEqual(neutral, src, 'the reconstruction must actually apply — otherwise the check proves nothing')
  const dir = mkdtempSync(path.join(tmpdir(), 'b419-reconstruct-'))
  writeFileSync(path.join(dir, 'messages.ts'), neutral)
  try {
    const M = await import(pathToFileURL(path.join(dir, 'messages.ts')).href)

    const flagged = [
      { messageId: P, recipientId: R, status: 'prepared', ts: 1000, noWake: true },
      { messageId: P, recipientId: R, status: 'failed', ts: 1300, noWake: true },
      { messageId: P, recipientId: R, status: 'prepared', ts: 2000, noWake: true },
      { messageId: P, recipientId: R, status: 'failed', ts: 2300 },
      { messageId: P, recipientId: R, status: 'prepared', ts: 3000, noWake: true },
      { messageId: P, recipientId: R, status: 'failed', ts: 3300, noWake: true },
      { messageId: P, recipientId: R, status: 'prepared', ts: 4000, noWake: true }
    ]

    // ── THE SHIPPED POLICY: GREEN (verbatim) ─────────────────────────────────
    const good = compactDeliveryRows(flagged)
    assert.ok(good.every((r) => flagged.includes(r)), 'SHIPPED: every kept row is an input row BY IDENTITY (verbatim copy)')
    assert.ok(good.some((r) => r.noWake === true), 'SHIPPED: `noWake: true` rows are retained with their flag')
    assert.equal(good.filter((r) => r.noWake === true).length, good.length - 1, 'SHIPPED: every kept row that HAD the flag still HAS it (only the deliberately unflagged `failed@2300` lacks it)')

    // ── THE RECONSTRUCTING VARIANT: RED — the seventh test\'s assertions FAIL ──
    const bad = M.compactDeliveryRows(flagged)
    const identityRed = bad.filter((r) => !flagged.includes(r)).length
    assert.equal(
      identityRed,
      bad.length,
      `★ ASSERT (a) IS RED AGAINST THE RECONSTRUCTING VARIANT: ALL ${identityRed} of its ${bad.length} kept rows are NEWLY BUILT objects — not one is an input row by identity. The seventh test\'s identity assertion FAILS here.`
    )
    const lostFlags = bad.filter((r) => r.noWake === true).length
    assert.equal(
      lostFlags,
      0,
      `★★ AND THE FLAG IS GONE: the variant keeps ${lostFlags} rows carrying \`noWake: true\` — the ORIGINAL carries ${flagged.filter((r) => r.noWake === true).length}. ASSERT (b) FAILS HERE: \`kept.noWake\` is \`undefined\` where the original had \`true\`. This is EXACTLY the fb-1641 class the amended brief forbids.`
    )
    // The variant also loses the KEY, which is what lands on disk.
    assert.ok(
      bad.every((r) => !Object.prototype.hasOwnProperty.call(r, 'noWake')),
      'the reconstructing variant drops the KEY itself — so its to-disk JSON would read `{"messageId":…,"status":…,"ts":…}` with NO `"noWake":true`, the flag silently erased'
    )
    const badLines = bad.map((r) => JSON.stringify(r))
    assert.equal(
      badLines.filter((l) => l.includes('"noWake":true')).length,
      0,
      '★ ASSERT (d) IS RED: the variant\'s own serialization (what the boot writes to disk) contains ZERO `"noWake":true` — the loss SURVIVES the round-trip, so the next boot would read the wrong intent'
    )

    // ── THE DISCRIMINATION: same selection, different fidelity ────────────────
    assert.equal(bad.length, good.length, 'the two variants select the SAME NUMBER of rows (the difference is fidelity, not policy)')
    assert.deepEqual(
      bad.map((r) => `${r.messageId}|${r.recipientId}|${r.status}|${r.ts}`),
      good.map((r) => `${r.messageId}|${r.recipientId}|${r.status}|${r.ts}`),
      'and the SAME rows (status/ts) — so the ONLY difference is the OPTIONAL FIELD, which is precisely what test (10) detects'
    )
    assert.notDeepEqual(bad, good, 'the results nevertheless DIFFER field-by-field — the seventh test tells them apart')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
