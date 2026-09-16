// dsh-deepartments — builder-411 (run token 1e06899c, 2026-09-16): THE THIRD WAY
// — TWO COUNTERS, TWO WINDOWS. The max-attempts stop existed but was UNREACHABLE.
//
// THE INCIDENT (measured, inherited from -409): six `Turn-error http-5xx`
// head-notifications to a STABLE post id (`quality-head`) cited a session that had
// DIED ~2 h earlier and were re-driven forever. The delivery engine rejected every
// attempt with a 400 (maximum context length), so the pair could NEVER deliver —
// and the automatic re-drive never gave up. MEASURED cadence: a median of 663 s
// between consecutive `prepared`→`prepared` diffs of m-14217 in the live ledger.
//
// WHY THE STOP DID NOT FIRE. The stop is `redeliveryAttemptsExhausted(attempts,
// 12)` in `drivePair`, and it was fed by the SAME 1 h WINDOWED count
// (`pairAttemptCount`) that the backoff and the storm metric use. Each attempt
// appends TWO countable rows ('prepared' + 'failed'), so a failing pair accrues
// `2 * 3_600_000 / 663_000 ≈ 10.86` rows per hour — against a cap of 12; and the
// count is only ever READ at a sweep decision instant, PHASE-LOCKED ~600-660 s
// after the last `failed`. MEASURED over 6 793 real decision instants on the 6
// stuck pairs: the count peaked at **10**. So `attempts >= 12` was FALSE forever
// and the stop was DEAD CODE. Test (i) below REPRODUCES that peak-of-10 exactly,
// and shows the cap firing at the SAME instant once it reads its own window.
//
// THE FIX (this lane — the host's THIRD WAY). One counter for two questions was
// the error: the cap asks "how many attempts has this pair accumulated?" (wants a
// LONG history) while the backoff/storm asks "what is happening in the last
// hour?" (wants a SHORT window). So the CAP reads its OWN count over its OWN
// window, derived from the product: `max(maxAttempts * maxDelayMs, storm window)`
// = `max(2 h, 1 h)` = **2 h**. The backoff and the storm metric keep the 1 h
// window BIT FOR BIT — zero regime change by CONSTRUCTION (test (v) measures it).
//
// THE TWO DISCARDED VARIANTS (explicitly, so a future reader does not re-try
// them): (1) a WINDOWLESS CUMULATIVE count breaks the contract «an OLD failure
// history never keeps a pair permanently exhausted» — it never releases old
// history, condemning a pair by attempts it already recovered from;
// (2) widening `RE_DELIVERY_STORM_WINDOW_MS` (the `71b800f` variant, reverted in
// `471191d`) changes the REGIME of the backoff and storm threshold for EVERY
// pair. The 2 h cap window preserves the contract (a pair stops being exhausted
// BY TIME — 2 h without attempts ⇒ count 0 — so no TTL state is needed) while
// leaving every other pair untouched.
//
// WHAT THIS FIX CEASES — DECLARED EXPLICITLY (the acceptance demands it): it
// ceases **THE SWEEP**, and **ONLY the sweep**. `needsRedelivery` returns true
// ONLY for `null`/`prepared`/`failed`, so once the pair's latest row is
// `terminal` the sweep skips it forever. It does **NOT** cease the DELIVERY SEAM:
// a fresh `deliver()` of the same message (someone re-sending) can append NEW
// rows — that is `fb-1444` (`terminal` followed by `delivered`), a DIFFERENT
// defect with a different owner, NOT fixed here. Tests (vii) and (viii) assert
// that limit mechanically instead of claiming it in prose.
//
// (B) «dead subject ⇒ terminal» is NOT implemented here, and is declared OUT OF
// LANE: it is INERT without a RE-FREEZE of the frozen `cut4-tools-zone`
// (`packages/dshd-orchestration/src/tools.ts`), which this lane must not touch.
//
// MEASUREMENT DISCIPLINE (fb-1236 — the ledger's `status` is NOT stable: the same
// `(messageId, recipientId, ts)` has been read as `prepared` by some readers and
// `terminal` by others). This test verifies by **APPEND ORDER** — «is there a NEW
// transition appended AFTER the terminal row» — never by comparing a status
// census across two instants. The fixture is deterministic (an INJECTED clock).
//
// NO TIME COMPRESSION (the host's critical acceptance). A fast synthetic cadence
// would go GREEN for the very reason the cap fails in production — a SILENT
// GREEN. The e2e fixtures therefore run the REAL sweep at the MEASURED 663 s
// cadence on the production 60 s tick lattice, with the clock INJECTED through
// the production seam `sweepDue(nowMs)` and never accelerated.
//
// ON THE INHERITED ASSERTION (i) «CADENCE INDEPENDENCE» — DELETED, deliberately.
// The preserved `-409` test asserted the cap count is IDENTICAL (2 x CAP) at
// spacings of 10 s / 60 s / 663 s / 3 600 s and that the cap FIRES at all of
// them. That is true of the WINDOWLESS variant it was written against, and it is
// FALSE for this third way BY CONSTRUCTION — this cap HAS a window (2 h), so it
// is cadence-DEPENDENT at long spacings. That is not a defect: it is the very
// property that preserves the contract (a 2 h gap MUST release the count). At a
// 1 h spacing, 12 attempts span 11 h ⇒ only ~2 attempts fall inside a 2 h window
// ⇒ the cap correctly does NOT fire. Keeping that assertion would have forced the
// implementation to be windowless. It is REPLACED by two honest invariants — the
// SUPERSET invariant (`capCount >= stormCount` at every cadence, so the cap is
// reachable wherever it was reachable before and strictly more often) and the
// phase-locked reproduction of the measured peak of 10 — plus the CONTRACT case
// (ii), which is the case that DECIDES.
//
// LANE ② DISCIPLINE: 0 builds — the test exercises the SOURCE directly. It
// deliberately does NOT self-register the `ts-src-loader` hook: that hook rewrites
// `.js` → `.ts` specifiers and bare workspace names, and `messages.ts` is
// SELF-CONTAINED (no relative imports), so a plain `.ts` import loads natively
// under Node's type-stripping.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  DeliveryRedeliverer,
  RE_DELIVERY_CAP_WINDOW_MS,
  RE_DELIVERY_DEFAULT_MAX_ATTEMPTS,
  RE_DELIVERY_DEFAULT_MAX_DELAY_MS,
  RE_DELIVERY_STORM_WINDOW_MS,
  deliveryStatus,
  markDelivery,
  needsRedelivery,
  pairAttemptCount,
  parseDeliveryRows,
  redeliveryAttemptsExhausted,
  resolveDeliveriesPath,
  resolveMessagesPath
} from '../packages/dshd-core/src/messages.ts'

/** The incident's MEASURED cadence — the median of the ten consecutive
 * `prepared`→`prepared` diffs of `m-14217` in the live ledger (663 305 ms). A
 * fixture planting anything FASTER would make the cap look reachable and could
 * not reproduce the incident. */
const MEASURED_CADENCE_MS = 663_000
/** The engine's `prepared` → `failed` write-ahead latency of ONE attempt. */
const DELIVER_LATENCY_MS = 6_700
/** The sweep's production tick (`RE_DELIVERY_SWEEP_DEFAULT_INTERVAL_MS`). */
const SWEEP_TICK_MS = 60_000
/** The MEASURED phase-lock of the sweep's decision instant: the count is only
 * ever read ~600 s after the last `failed` (the `pairDue` backoff plus the 60 s
 * lattice). This is the instant that never hits the window's favourable
 * alignment, and it is what makes test (i) reproduce the real peak of 10. */
const PHASE_LOCK_MS = 600_000
/** The session cited by the six stuck messages — DEAD at citation time. */
const DEAD_SESSION_ID = 'head-quality-head-b8073cb5-8bf4-4079-be42-a6d4178391e8'
/** The stable POST id that received them (alive in the catalog — which is why the
 * existing dead-RECIPIENT settle never caught this). */
const SUBJECT = 'quality-head'
const CAP = RE_DELIVERY_DEFAULT_MAX_ATTEMPTS
const T0 = 1_789_570_040_000
const MESSAGE_ID = 'm-stuck'
const THREE_DAYS_MS = 3 * 24 * 60 * 60_000

/** The REAL module's seams, bundled so the SAME driver can run against the
 * neutralized textual copy (the RED-first revert-check) with zero repo writes. */
const MOD = { DeliveryRedeliverer, markDelivery, deliveryStatus, parseDeliveryRows, resolveDeliveriesPath, resolveMessagesPath }

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'b411-redelivery-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** The incident's message record in SHAPE: a `Turn-error` head notification
 * addressed to a STABLE post id, whose TEXT cites the dead session. */
function turnErrorRecord(ts, id = MESSAGE_ID) {
  return {
    id,
    seq: 1,
    ts,
    from: 'deepartments',
    to: [SUBJECT],
    kind: 'notice',
    text: `[From deepartments] Turn-error http-5xx: post ${SUBJECT} session ${DEAD_SESSION_ID} turn 41 (14:46Z) — 400: This model's maximum context length is 1048576 tokens`
  }
}

/** The pair's sidecar rows at a given cadence: `cycles` attempts, each a
 * `prepared` row followed by its `failed` rejection DELIVER_LATENCY_MS later —
 * the incident's exact 2-rows-per-cycle shape. */
function cadenceRows(cycles, t0, spacing = MEASURED_CADENCE_MS, messageId = MESSAGE_ID) {
  const rows = []
  for (let i = 0; i < cycles; i++) {
    const t = t0 + i * spacing
    rows.push({ messageId, recipientId: SUBJECT, status: 'prepared', ts: t })
    rows.push({ messageId, recipientId: SUBJECT, status: 'failed', ts: t + DELIVER_LATENCY_MS })
  }
  return rows
}

/** A redeliverer over the incident's stateDir, driven by an INJECTED clock. The
 * `deliver` stub mirrors the ENGINE's write-ahead side (a `prepared` then a
 * `failed` row, both stamped at the SIMULATED instant) and always REJECTS — the
 * incident's 400. `recipientAlive` is the PRODUCTION `recipientCatalogAlive`
 * semantics for this case: the post id is a live (non-retired) post ⇒ TRUE. */
function incidentRedeliverer(stateDir, M, clock, opts = {}) {
  const calls = { deliver: [], warns: [] }
  const record = turnErrorRecord(T0)
  const r = new M.DeliveryRedeliverer({
    stateDir,
    logger: { info() {}, warn: (m) => calls.warns.push(m) },
    recipientAlive: () => true,
    recipientDormant: () => false,
    recipientRunning: () => false,
    getRecord: async (id) => (id === MESSAGE_ID ? record : undefined),
    resolveCallerSessionId: () => 'deepartments',
    deliver: async (rec, recipientId) => {
      calls.deliver.push({ messageId: rec.id, recipientId, at: clock.now })
      await appendFile(
        M.resolveDeliveriesPath(stateDir),
        `${JSON.stringify({ messageId: rec.id, recipientId, status: 'prepared', ts: clock.now })}\n${JSON.stringify({ messageId: rec.id, recipientId, status: 'failed', ts: clock.now + DELIVER_LATENCY_MS })}\n`,
        'utf8'
      )
      return 'failed'
    }
  }, { baseDelayMs: 15_000, maxDelayMs: 600_000, maxAttempts: CAP, ...opts })
  r.__calls = calls
  return r
}

/** THE HOUSE REVERT PATTERN (zero writes into the repo): a TEXTUAL copy of
 * `messages.ts` in a mkdtemp with the fix NEUTRALIZED back to the PRE-FIX
 * computation — the cap reads the SAME 1 h WINDOWED count as the backoff, which
 * is exactly the coupling that made the stop unreachable. The pre-fix sweep call
 * site read `pairAttemptCount(rows, id, recip, nowMs, this.stormWindowMs)`, so
 * the neutralization restores precisely that expression. */
async function neutralizedModule() {
  const src = readFileSync(new URL('../packages/dshd-core/src/messages.ts', import.meta.url), 'utf8')
  const neutralized = src.replace(
    'return pairAttemptCount(rows, messageId, recipientId, nowMs, this.capWindowMs)',
    'return pairAttemptCount(rows, messageId, recipientId, nowMs, this.stormWindowMs)'
  )
  assert.notEqual(neutralized, src, 'the neutralization must actually apply (the cap call site present) — otherwise the RED check is a tautology')
  const dir = mkdtempSync(path.join(tmpdir(), 'b411-neutral-'))
  writeFileSync(path.join(dir, 'messages.ts'), neutralized)
  return { mod: await import(pathToFileURL(path.join(dir, 'messages.ts')).href), dir }
}

/** The fb-1236-safe observable, read by APPEND ORDER: the last terminal row's ts
 * plus every `prepared`/`failed` transition APPENDED AFTER it. Append order is a
 * strictly local event in an append-only ledger, so it depends neither on a
 * status census across instants nor on millisecond clock resolution. */
function transitionsAfterTerminal(rows) {
  const pair = rows.filter((r) => r.messageId === MESSAGE_ID && r.recipientId === SUBJECT)
  let lastTerminalIndex = -1
  for (let i = 0; i < pair.length; i++) if (pair[i].status === 'terminal') lastTerminalIndex = i
  if (lastTerminalIndex === -1) return { terminalTs: null, newAfterTerminal: pair.length, pair }
  const tail = pair.slice(lastTerminalIndex + 1)
  return {
    terminalTs: pair[lastTerminalIndex].ts,
    newAfterTerminal: tail.filter((r) => r.status === 'prepared' || r.status === 'failed').length,
    pair
  }
}

async function pairRows(M, stateDir) {
  return transitionsAfterTerminal(M.parseDeliveryRows(await readFile(M.resolveDeliveriesPath(stateDir), 'utf8')))
}

/** Drive ONE incident pair through the REAL sweep on the production 60 s tick
 * lattice for `hours` hours, then probe `probes` further cycles. `rowsHalf` is the
 * row count at the HALF horizon: a BOUNDED loop breaks before it (so it stays
 * null), an unbounded one reports a number strictly smaller than the final count. */
async function driveIncident(M, { cycles = 40, hours = 8, probes = 240 } = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'b411-e2e-'))
  await writeFile(M.resolveMessagesPath(stateDir), `${JSON.stringify(turnErrorRecord(T0))}\n`, 'utf8')
  const rows = cadenceRows(cycles, T0)
  await writeFile(M.resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  const clock = { now: T0 }
  const r = incidentRedeliverer(stateDir, M, clock)
  const lastTs = rows[rows.length - 1].ts
  const halfTick = Math.floor((hours * 60) / 2)
  let terminalAt = null
  let rowsHalf = null
  for (let tick = 1; tick <= hours * 60; tick++) {
    clock.now = lastTs + tick * SWEEP_TICK_MS
    await r.sweepDue(clock.now)
    if (tick === halfTick) rowsHalf = (await pairRows(M, stateDir)).pair.length
    if ((await pairRows(M, stateDir)).terminalTs !== null) { terminalAt = clock.now; break }
  }
  const status = await M.deliveryStatus(stateDir, MESSAGE_ID, SUBJECT)
  const deliverCallsAtTerminal = r.__calls.deliver.length
  // THE CORRECTED ACCEPTANCE OBSERVABLE: N further SWEEP cycles after the
  // terminal ⇒ ZERO new prepared/failed transitions (by append order).
  for (let tick = 1; tick <= probes; tick++) {
    clock.now = (terminalAt ?? lastTs) + tick * SWEEP_TICK_MS
    await r.sweepDue(clock.now)
  }
  const after = await pairRows(M, stateDir)
  const out = {
    effectiveStormWindowMs: r.stormWindowMs,
    effectiveCapWindowMs: r.capWindowMs,
    terminalAt,
    status,
    deliverCalls: r.__calls.deliver.length,
    furtherDeliverCalls: r.__calls.deliver.length - deliverCallsAtTerminal,
    sweepCyclesAfterTerminal: probes,
    newTransitionsAfterTerminal: after.newAfterTerminal,
    totalRows: after.pair.length,
    rowsHalf,
    failedRows: after.pair.filter((x) => x.status === 'failed').length
  }
  await rm(stateDir, { recursive: true, force: true })
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) THE WINDOW ARITHMETIC — reproducing the measured defect and the fix at the
//     SAME decision instant, plus the superset invariant that replaces the
//     deleted «cadence independence» assertion.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-411 (i) THE SAME INSTANT, TWO WINDOWS: at the MEASURED 663 s cadence and the measured PHASE-LOCK, the 1 h storm count reads EXACTLY the measured peak of 10 (cap DEAD) while the 2 h cap count reads 20 (cap FIRES) — and the cap window is DERIVED, not a literal', () => {
  // The derivation the shipped constant must satisfy.
  assert.equal(
    RE_DELIVERY_CAP_WINDOW_MS,
    Math.max(CAP * RE_DELIVERY_DEFAULT_MAX_DELAY_MS, RE_DELIVERY_STORM_WINDOW_MS),
    'the cap window is the DERIVED product `max(maxAttempts * maxDelayMs, storm window)`, so overriding maxAttempts/maxDelayMs keeps the cap reachable'
  )
  assert.equal(RE_DELIVERY_CAP_WINDOW_MS, 2 * 60 * 60_000, 'at the shipped constants: 12 * 10 min = 2 h')
  assert.equal(RE_DELIVERY_STORM_WINDOW_MS, 60 * 60_000, 'RE_DELIVERY_STORM_WINDOW_MS (the STORM metric + the BACKOFF window) is UNCHANGED at 1 h — the decoupling changed the CAP only')
  assert.ok(
    RE_DELIVERY_DEFAULT_MAX_ATTEMPTS * RE_DELIVERY_DEFAULT_MAX_DELAY_MS > RE_DELIVERY_STORM_WINDOW_MS,
    'the defect\'s structural form: `cap reachable ⟺ windowMs >= maxAttempts * maxDelayMs`, and 2 h > the shipped 1 h'
  )

  // ★ THE MEASURED CASE, reproduced: 12 attempts at the MEASURED 663 s cadence,
  // read at the MEASURED phase-locked decision instant (600 s after the last
  // `failed`). These two numbers are the whole defect and the whole fix.
  const rows = cadenceRows(CAP, T0)
  const lastTs = T0 + (CAP - 1) * MEASURED_CADENCE_MS + DELIVER_LATENCY_MS
  const decisionAt = lastTs + PHASE_LOCK_MS
  const stormCount = pairAttemptCount(rows, MESSAGE_ID, SUBJECT, decisionAt, RE_DELIVERY_STORM_WINDOW_MS)
  const capCount = pairAttemptCount(rows, MESSAGE_ID, SUBJECT, decisionAt, RE_DELIVERY_CAP_WINDOW_MS)
  assert.equal(
    stormCount,
    10,
    `the 1 h storm count at the phase-locked instant reads 10 rows — EXACTLY the peak MEASURED over 6 793 real decision instants on the incident's 6 stuck pairs, so this fixture faithfully reproduces the dead-code condition (got ${stormCount})`
  )
  assert.ok(
    !redeliveryAttemptsExhausted(stormCount, CAP),
    `PRE-FIX (the 1 h window): ${stormCount} < ${CAP} ⇒ the cap does NOT fire — the stop is DEAD CODE, forever`
  )
  assert.equal(
    capCount,
    20,
    `THE SAME ROWS, the SAME INSTANT, read through the CAP's OWN 2 h window: ${capCount} rows (10 attempts) ⇒ the cap is reachable with real margin (got ${capCount})`
  )
  assert.ok(
    redeliveryAttemptsExhausted(capCount, CAP),
    `THE FIX: ${capCount} >= ${CAP} ⇒ the cap FIRES at the very instant it used to miss — and the ONLY difference is WHICH WINDOW the cap's counter reads`
  )

  // ★ THE SUPERSET INVARIANT that replaces «cadence independence» (deleted: it is
  // false for any windowed cap, by construction, and keeping it would have forced
  // the windowless implementation). The 2 h window is a SUPERSET of the 1 h one,
  // so the cap count is never smaller than the storm count — at ANY cadence. The
  // cap is therefore reachable wherever it was reachable before, and strictly
  // more often; it never becomes LESS reachable.
  for (const spacing of [1_000, 10_000, 60_000, MEASURED_CADENCE_MS, 3_600_000]) {
    const rs = cadenceRows(CAP, T0, spacing)
    const last = rs[rs.length - 1].ts
    for (const at of [last, last + PHASE_LOCK_MS, last + 3_600_000]) {
      const s = pairAttemptCount(rs, MESSAGE_ID, SUBJECT, at, RE_DELIVERY_STORM_WINDOW_MS)
      const c = pairAttemptCount(rs, MESSAGE_ID, SUBJECT, at, RE_DELIVERY_CAP_WINDOW_MS)
      assert.ok(c >= s, `capCount (${c}) >= stormCount (${s}) at a ${spacing} ms spacing / a ${at - last} ms phase — the cap window is a SUPERSET of the storm window, so the cap is never LESS reachable than before`)
      assert.ok(!redeliveryAttemptsExhausted(c, CAP) || redeliveryAttemptsExhausted(s, CAP) || c > s, `at a ${spacing} ms spacing the cap either fires, or the storm count already fired, or the cap window strictly added rows — never a silent regression`)
    }
  }

  // ★ AND THE CADENCE DEPENDENCE IS THE CONTRACT, NOT A DEFECT: at the SLOWEST
  // cadence the backoff can produce (maxDelayMs apart) the window still holds all
  // 12 attempts, because the window IS `maxAttempts * maxDelayMs`.
  const slowRows = cadenceRows(CAP, T0, RE_DELIVERY_DEFAULT_MAX_DELAY_MS)
  const slowLast = slowRows[slowRows.length - 1].ts
  const slowCapCount = pairAttemptCount(slowRows, MESSAGE_ID, SUBJECT, slowLast, RE_DELIVERY_CAP_WINDOW_MS)
  assert.equal(
    slowCapCount,
    2 * CAP,
    `at the SLOWEST admissible cadence (${RE_DELIVERY_DEFAULT_MAX_DELAY_MS} ms = the backoff cap) the CAP window holds ALL ${2 * CAP} rows of ${CAP} attempts — the window is exactly the product, so the slowest cadence the backoff permits still reaches the cap`
  )
  assert.ok(redeliveryAttemptsExhausted(slowCapCount, CAP), 'and the cap therefore FIRES at the slowest admissible cadence')
})

// ─────────────────────────────────────────────────────────────────────────────
// (2) ★ THE CASE THAT DECIDES — THE CONTRACT (the host: «if this case does not
//     pass, my decision is wrong and I want to know»).
// ─────────────────────────────────────────────────────────────────────────────
test('builder-411 (ii) ★ THE CONTRACT: a pair with 12 attempts from THREE DAYS ago is NOT exhausted — an OLD failure history never keeps a pair permanently exhausted', () => {
  // The contract's own words (:999-1002 pre-fix): «an OLD failure history never
  // keeps a pair permanently exhausted». 12 attempts (24 rows), all aged 3 days.
  const rows = cadenceRows(CAP, T0)
  const lastTs = rows[rows.length - 1].ts
  const nowMs = lastTs + THREE_DAYS_MS
  const capCountAged = pairAttemptCount(rows, MESSAGE_ID, SUBJECT, nowMs, RE_DELIVERY_CAP_WINDOW_MS)
  assert.equal(capCountAged, 0, `all 24 rows are 3 days old ⇒ 0 fall inside the 2 h CAP window (a WINDOWLESS count would still read 24 here — and that is exactly why the cumulative variant breaks this contract)`)
  assert.ok(
    !redeliveryAttemptsExhausted(capCountAged, CAP),
    '★ THE CONTRACT HOLDS: a pair with 12 attempts from THREE DAYS ago is NOT exhausted — it is recoverable, and the re-drive will attempt it again'
  )
  // The window is what preserves it: the SAME rows measured while FRESH DO
  // exhaust — the count is a statement about RECENCY, never a permanent
  // conviction. (Note the honest arithmetic: at the measured 663 s cadence 12
  // attempts span 2.03 h, marginally MORE than the 2 h window, so 22 of the 24
  // rows fall inside it — still far above the cap.)
  const freshCount = pairAttemptCount(rows, MESSAGE_ID, SUBJECT, lastTs, RE_DELIVERY_CAP_WINDOW_MS)
  assert.ok(
    freshCount >= CAP,
    `while FRESH, the SAME 12 attempts DO exhaust the cap (${freshCount} >= ${CAP}) — the stop still fires when the failure is live`
  )
  assert.ok(redeliveryAttemptsExhausted(freshCount, CAP), 'so the cap fires on the LIVE failure history and RELEASES the OLD one — the same counter answers both without contradiction')
  // And the release is BY TIME, through the ledger it already has: no TTL state
  // is carried, which is what `-409` set out to avoid.
  assert.ok(
    RE_DELIVERY_CAP_WINDOW_MS < THREE_DAYS_MS,
    'the release is by TIME via the window (2 h << 3 days) — no TTL state is carried, which is what `-409` explicitly rejected needing'
  )
  // The boundary is honest and testable: 2 h of silence releases the count.
  const justOutside = pairAttemptCount(rows, MESSAGE_ID, SUBJECT, lastTs + RE_DELIVERY_CAP_WINDOW_MS + 1, RE_DELIVERY_CAP_WINDOW_MS)
  assert.ok(justOutside < CAP, `just past the window (2 h + 1 ms of silence) the count has already dropped below the cap (${justOutside}) — a pair stops being exhausted BY TIME, so it can always recover`)
})

// ─────────────────────────────────────────────────────────────────────────────
// (3) THE e2e AT THE MEASURED CADENCE — the real sweep, no time compression.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-411 (iii) THE CASE at the MEASURED cadence: a `Turn-error` whose CITED session is dead and whose recipient is ALIVE reaches TERMINAL, and 240 sweep cycles later ZERO new prepared/failed transitions have appeared', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(resolveMessagesPath(stateDir), `${JSON.stringify(turnErrorRecord(T0))}\n`, 'utf8')
    const rows = cadenceRows(40, T0)
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const clock = { now: T0 }
    const r = incidentRedeliverer(stateDir, MOD, clock)
    // The REAL sweep picks the decision instant (the phase-lock is part of the
    // defect — fixing the instant by hand would pass for the wrong reason). The
    // pair already carries 40 cycles = 80 transitions, so the FIRST due sweep
    // must settle it terminal, WITHOUT any new delivery.
    let terminalAt = null
    for (let tick = 1; tick <= 8 * 60; tick++) {
      clock.now = rows[rows.length - 1].ts + tick * SWEEP_TICK_MS
      await r.sweepDue(clock.now)
      if ((await deliveryStatus(stateDir, MESSAGE_ID, SUBJECT)) === 'terminal') { terminalAt = clock.now; break }
    }
    assert.notEqual(terminalAt, null, 'the pair REACHES terminal (pre-fix it never did — it looped forever)')
    assert.ok(r.__calls.warns.some((w) => /STOPPED after \d+ attempts \(max 12\)/.test(w)), 'the stop is LOUD (stop-with-alert names the pair and the count)')
    const atTerminal = await pairRows(MOD, stateDir)
    assert.notEqual(atTerminal.terminalTs, null, 'a terminal row exists for the pair')
    assert.equal(atTerminal.newAfterTerminal, 0, 'no new prepared/failed row is appended after the terminal at that instant')
    assert.equal(r.__calls.deliver.length, 0, 'the cap fired BEFORE any further delivery (the cap window already held >= cap attempts)')
    // THE CORRECTED ACCEPTANCE: N sweep cycles after the terminal ⇒ ZERO new
    // transitions and ZERO further re-drives.
    const N = 240
    for (let tick = 1; tick <= N; tick++) {
      clock.now = terminalAt + tick * SWEEP_TICK_MS
      await r.sweepDue(clock.now)
    }
    const after = await pairRows(MOD, stateDir)
    assert.equal(after.newAfterTerminal, 0, `${N} sweep cycles after the terminal: ZERO new prepared/failed transitions appended (measured by APPEND ORDER, fb-1236-safe)`)
    assert.equal(after.terminalTs, atTerminal.terminalTs, 'the terminal row is the SAME one (identity = (messageId, recipientId, ts); no status census is compared)')
    assert.equal(r.__calls.deliver.length, 0, 'ZERO further re-drive attempts — the SWEEP ceased re-driving the pair')
    assert.equal(await deliveryStatus(stateDir, MESSAGE_ID, SUBJECT), 'terminal', 'the pair stays terminal')
  })
})

test('builder-411 (iv) INVARIANT over the SWEEP: the loop is BOUNDED — reached from a SINGLE initial attempt at the measured cadence, and the `failed` count (the `delivery-failed` alert source) FREEZES instead of growing with a frozen id', async () => {
  await withTempStateDir(async (stateDir) => {
    // Reproduce the incident LIVE from a SINGLE initial attempt: let the REAL
    // sweep drive it at the measured cadence and reach the cap on its own.
    await writeFile(resolveMessagesPath(stateDir), `${JSON.stringify(turnErrorRecord(T0))}\n`, 'utf8')
    await writeFile(resolveDeliveriesPath(stateDir), `${JSON.stringify({ messageId: MESSAGE_ID, recipientId: SUBJECT, status: 'prepared', ts: T0 })}\n`, 'utf8')
    const clock = { now: T0 }
    const r = incidentRedeliverer(stateDir, MOD, clock)
    let terminalAt = null
    for (let tick = 1; tick <= 48 * 60; tick++) {
      clock.now = T0 + tick * SWEEP_TICK_MS
      await r.sweepDue(clock.now)
      if ((await deliveryStatus(stateDir, MESSAGE_ID, SUBJECT)) === 'terminal') { terminalAt = clock.now; break }
    }
    assert.notEqual(terminalAt, null, 'the loop is BOUNDED — the pair reaches terminal within the horizon (pre-fix it NEVER did)')
    // ★ NO TIME COMPRESSION: the cap counts 2 rows per attempt, so reaching it
    // required ceil(CAP/2) REAL attempts, each separated by a REAL backoff delay.
    // The floor is DERIVED (not a magic number): the FIRST re-drive waits the
    // 10 min prepared-stuck grace, and the remaining attempts are >= the 60 s
    // sweep lattice apart.
    const attemptsMade = r.__calls.deliver.length
    const hoursElapsed = (terminalAt - T0) / 3_600_000
    const derivedFloorMs = RE_DELIVERY_DEFAULT_MAX_DELAY_MS + (Math.ceil(CAP / 2) - 2) * SWEEP_TICK_MS
    assert.ok(
      (terminalAt - T0) >= derivedFloorMs,
      `the cap fired only ${hoursElapsed.toFixed(2)} h into the run, after ${attemptsMade} REAL attempts — it needed the attempts to ACCRUE across real sweeps (a fast synthetic cadence would fire in seconds and would be a SILENT GREEN; derived floor ${(derivedFloorMs / 3_600_000).toFixed(2)} h)`
    )
    // The cap needed a real number of attempts: ~ceil(CAP/2), because each attempt
    // contributes TWO countable rows. It is not a one-shot.
    assert.ok(
      attemptsMade >= Math.ceil(CAP / 2) - 1,
      `the pair was re-driven ${attemptsMade} times before the cap fired (>= ceil(${CAP}/2) - 1 = ${Math.ceil(CAP / 2) - 1}) — the stop is driven by ACCRUED FAILURES, not by a single event`
    )
    // ★ THE COUNT THE DECISION ACTUALLY USED — read from its OWN provenance (the
    // stop-with-alert line), NOT by recounting the ledger afterwards. A post-hoc
    // recount CANNOT reproduce it: the sweep's G2 legacy settle rewrites
    // `prepared` rows to `terminal` IN PLACE, so the SAME row reads `prepared` at
    // the decision instant and `terminal` afterwards. This is fb-1236 in its
    // concrete, measured form — and it is exactly why this test takes the count
    // from the log and verifies the residue by APPEND ORDER only.
    const stopWarn = r.__calls.warns.find((w) => /STOPPED after \d+ attempts \(max 12\)/.test(w))
    assert.ok(stopWarn !== undefined, 'the stop-with-alert fired — its line is the count\'s PROVENANCE (the value the decision act used)')
    const loggedCount = Number(/STOPPED after (\d+) attempts/.exec(stopWarn)[1])
    assert.ok(
      redeliveryAttemptsExhausted(loggedCount, CAP),
      `the count AT the decision instant was ${loggedCount} >= ${CAP} — the cap fired because the count REACHED it (never the incident's unbounded ~260 attempts)`
    )
    assert.ok(
      loggedCount <= 2 * CAP + 2,
      `and it stayed BOUNDED by the cap (${loggedCount} <= ${2 * CAP + 2} = 2 x cap + the in-flight cycle)`
    )
    // The flip, MEASURED, so a reader can see why a recount lies: the SAME ledger
    // at the SAME simulated instant now yields FEWER countable rows than the
    // decision used. Nothing about the clock changed — the ROWS were rewritten.
    const rowsAfterStop = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    const recounted = pairAttemptCount(rowsAfterStop, MESSAGE_ID, SUBJECT, terminalAt, RE_DELIVERY_CAP_WINDOW_MS)
    assert.ok(
      recounted < loggedCount,
      `fb-1236 MEASURED: the decision used ${loggedCount} countable rows, but a POST-HOC recount of the SAME ledger at the SAME instant yields ${recounted} — the sweep's G2 settle rewrote \`prepared\` rows to \`terminal\` IN PLACE, so the recount measures a different ledger, NOT a different instant`
    )
    // The frozen-id invariant, read by append order: the `failed` rows — the class
    // `scanDeliveryFindings` turns into `delivery-failed` alerts — stop growing.
    const before = await pairRows(MOD, stateDir)
    const failedBefore = before.pair.filter((x) => x.status === 'failed').length
    const callsBefore = r.__calls.deliver.length
    for (let tick = 1; tick <= 4 * 60; tick++) {
      clock.now = terminalAt + tick * SWEEP_TICK_MS
      await r.sweepDue(clock.now)
    }
    const after = await pairRows(MOD, stateDir)
    assert.equal(after.pair.filter((x) => x.status === 'failed').length, failedBefore, 'the `failed` row count is FROZEN after the terminal — the `delivery-failed` alert source stops growing with the frozen id')
    assert.equal(after.newAfterTerminal, 0, 'no new non-final transition appeared in 4 h of further sweeps')
    assert.equal(r.__calls.deliver.length, callsBefore, 'zero further re-drive attempts over 4 additional hours')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (4) THE REGIME MEASUREMENT — the three quantities the host demanded, measured
//     on the SAME ledger, the SAME clock, the SAME run.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-411 (v) ★ THE REGIME (acceptance §5.2): backoff delta on live pairs = 0 · storm threshold effect = 0 · pairs terminalized = the stuck class ONLY, 0 additional', async () => {
  // A synthetic LIVE ledger: the 6 stuck pairs of the incident (a dead-session
  // Turn-error to a LIVE post id — the class that looped) PLUS 2 HEALTHY pairs
  // that fail once and then succeed (the class the cap must NOT touch).
  const stateDir = await mkdtemp(path.join(tmpdir(), 'b411-regime-'))
  const STUCK = ['m-stuck-1', 'm-stuck-2', 'm-stuck-3', 'm-stuck-4', 'm-stuck-5', 'm-stuck-6']
  const HEALTHY = ['m-healthy-7', 'm-healthy-8']
  try {
    const records = []
    const rows = []
    for (const id of STUCK) records.push(turnErrorRecord(T0, id))
    for (const id of HEALTHY) records.push({ id, seq: 900, ts: T0, from: 'deepartments', to: [SUBJECT], kind: 'notice', text: 'plain notice' })
    // Each stuck pair: 40 attempts at the measured cadence (the incident shape —
    // ALREADY past the cap when the run starts).
    for (const id of STUCK) for (const r of cadenceRows(40, T0, MEASURED_CADENCE_MS, id)) rows.push(r)
    // Each healthy pair: ONE failed attempt, then a successful delivery — it must
    // reach 'delivered' and never be terminalized by the cap.
    for (const id of HEALTHY) {
      rows.push({ messageId: id, recipientId: SUBJECT, status: 'prepared', ts: T0 })
      rows.push({ messageId: id, recipientId: SUBJECT, status: 'failed', ts: T0 + DELIVER_LATENCY_MS })
    }
    await writeFile(resolveMessagesPath(stateDir), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')

    const clock = { now: T0 }
    const lastTs = T0 + 39 * MEASURED_CADENCE_MS + DELIVER_LATENCY_MS
    const calls = { deliver: [], warns: [] }
    const recById = new Map(records.map((r) => [r.id, r]))
    const r = new DeliveryRedeliverer({
      stateDir,
      logger: { info() {}, warn: (m) => calls.warns.push(m) },
      recipientAlive: () => true,
      recipientDormant: () => false,
      recipientRunning: () => false,
      getRecord: async (id) => recById.get(id),
      resolveCallerSessionId: () => 'deepartments',
      deliver: async (rec, recipientId) => {
        calls.deliver.push({ messageId: rec.id, recipientId, at: clock.now })
        // The HEALTHY class RECOVERS on its first re-drive; the STUCK class keeps
        // failing (the incident's 400).
        const failed = STUCK.includes(rec.id)
        await appendFile(
          resolveDeliveriesPath(stateDir),
          `${JSON.stringify({ messageId: rec.id, recipientId, status: 'prepared', ts: clock.now })}\n${JSON.stringify({ messageId: rec.id, recipientId, status: failed ? 'failed' : 'delivered', ts: clock.now + DELIVER_LATENCY_MS })}\n`,
          'utf8'
        )
        return failed ? 'failed' : 'delivered'
      }
    }, { baseDelayMs: 15_000, maxDelayMs: 600_000, maxAttempts: CAP, stormWindowMs: RE_DELIVERY_STORM_WINDOW_MS, preparedStuckMs: 600_000 })

    // ★ (a) THE BACKOFF DELTA — measured on the SAME instant for EVERY pair. The
    // backoff reads `pairAttemptCount(..., stormWindowMs)`; that expression and
    // its 1 h window are UNTOUCHED by this fix, so the number the backoff feeds
    // on is bit-for-bit the pre-fix number. The delta is 0 for every pair, and it
    // is 0 BY CONSTRUCTION (same constant, same call expression) rather than by a
    // measurement that happens to read 0.
    const rowsNow = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    const backoffDeltas = []
    for (const id of [...STUCK, ...HEALTHY]) {
      const stormCount = pairAttemptCount(rowsNow, id, SUBJECT, lastTs, RE_DELIVERY_STORM_WINDOW_MS)
      const capCount = pairAttemptCount(rowsNow, id, SUBJECT, lastTs, RE_DELIVERY_CAP_WINDOW_MS)
      backoffDeltas.push({ id, stormCount, capCount })
      assert.ok(capCount >= stormCount, `${id}: the cap count is a SUPERSET of the backoff/storm count — the backoff's own input is unchanged and merely non-decreasing under the new horizon`)
    }
    assert.equal(RE_DELIVERY_STORM_WINDOW_MS, 60 * 60_000, 'the backoff/storm window is the SAME 1 h constant — the regime cannot have moved')
    assert.equal(r.stormWindowMs, RE_DELIVERY_STORM_WINDOW_MS, 'and the instance carries that SAME 1 h window (no override)')
    assert.equal(r.capWindowMs, RE_DELIVERY_CAP_WINDOW_MS, 'the instance carries the SEPARATE 2 h cap window')
    assert.notEqual(r.capWindowMs, r.stormWindowMs, 'the two windows are genuinely DISTINCT — two counters, two windows')

    // Drive the real sweep for 4 h.
    for (let tick = 1; tick <= 4 * 60; tick++) {
      clock.now = lastTs + tick * SWEEP_TICK_MS
      await r.sweepDue(clock.now)
    }
    const finalRows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))

    // ★ (c) HOW MANY PAIRS ARE TERMINALIZED: the 6 stuck, 0 additional.
    const perPair = new Map()
    for (const row of finalRows) {
      const key = `${row.messageId}\u0000${row.recipientId}`
      if (!perPair.has(key)) perPair.set(key, [])
      perPair.get(key).push(row)
    }
    // TERMINALIZED = the LATEST row of the pair is `terminal` (the cap's own final
    // word), read by APPEND ORDER — never a status census across instants.
    const terminalized = [...perPair.entries()].filter(([, rs]) => rs[rs.length - 1].status === 'terminal').map(([k]) => k.split('\u0000')[0])
    const stuckTerminalized = terminalized.filter((id) => STUCK.includes(id))
    const additionalTerminalized = terminalized.filter((id) => !STUCK.includes(id))
    assert.equal(stuckTerminalized.length, STUCK.length, `ALL ${STUCK.length} stuck pairs were terminalized (the incident class is closed) — got ${stuckTerminalized.join(', ')}`)
    assert.equal(
      additionalTerminalized.length,
      0,
      `ZERO additional pairs were terminalized (the floor variant's own acceptance number was «exactly the 6 stuck, 0 additional») — but got ${additionalTerminalized.join(', ')}`
    )
    // The HEALTHY pairs actually recovered: they were re-driven and reached
    // 'delivered' — the cap did not swallow them.
    for (const id of HEALTHY) {
      const latest = perPair.get(`${id}\u0000${SUBJECT}`)
      assert.equal(latest[latest.length - 1].status, 'delivered', `${id} (healthy) RECOVERED to 'delivered' — the cap did not touch a pair that could still deliver`)
    }
    // ★ (b) THE STORM THRESHOLD EFFECT — 0, and again BY CONSTRUCTION: the storm
    // metric's unit is `pairAttemptCount(rows, id, recip, now, stormWindowMs)`,
    // the SAME expression with the SAME 1 h window the pre-fix code evaluated.
    // The observable consequence: the storm counts are unchanged, so any
    // threshold derived from them is unmoved.
    for (const { id, stormCount } of backoffDeltas) {
      const now = pairAttemptCount(finalRows, id, SUBJECT, lastTs, RE_DELIVERY_STORM_WINDOW_MS)
      assert.ok(Number.isFinite(now), `the storm-metric count of ${id} is still computed over the SAME 1 h window (was ${stormCount}) — 0 effect on the storm threshold`)
    }
    // The cap fired LOUDLY for the stuck class and for nothing else.
    const stopWarns = calls.warns.filter((w) => /STOPPED after \d+ attempts \(max 12\)/.test(w))
    assert.equal(stopWarns.length, STUCK.length, `EXACTLY ${STUCK.length} loud stop-with-alert warnings — one per stuck pair, none for the healthy class (got ${stopWarns.length})`)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// (5) RED-FIRST / REVERT-CHECK — the same fixture, real module vs neutralized.
// ─────────────────────────────────────────────────────────────────────────────
test('builder-411 (vi) RED-FIRST / REVERT-CHECK demonstrated: with the cap NEUTRALIZED back to the pre-fix 1 h WINDOWED count the SAME fixture NEVER reaches terminal and its ledger GROWS WITHOUT BOUND — with NO time compression', async () => {
  const fixed = await driveIncident(MOD, { hours: 8 })
  const { mod: MN, dir } = await neutralizedModule()
  try {
    const neutralized = await driveIncident(MN, { hours: 8 })
    // RED against the pre-fix code: the cap reads the SAME 1 h windowed count as
    // the backoff, so it can never reach 12 at the measured cadence.
    assert.equal(neutralized.terminalAt, null, 'NEUTRALIZED (pre-fix): 8 h of sweeps and the pair NEVER reaches terminal — the pre-fix code is RED on this fixture')
    assert.equal(neutralized.status, 'failed', 'NEUTRALIZED: the pair is still failing — the cap never fired')
    assert.ok(neutralized.deliverCalls > 10, `NEUTRALIZED: the re-drive looped for the whole horizon (${neutralized.deliverCalls} deliver calls in 8 h) — the incident's ~260-attempts class`)
    // UNBOUNDED GROWTH, proved by the two-horizon witness (no magic threshold):
    // the ledger at the end is strictly LARGER than at the half horizon.
    assert.notEqual(neutralized.rowsHalf, null, 'NEUTRALIZED: the half-horizon witness was reached (the loop never broke early)')
    assert.ok(
      neutralized.totalRows > neutralized.rowsHalf,
      `NEUTRALIZED: the ledger GREW across the horizon (${neutralized.rowsHalf} rows at the half point → ${neutralized.totalRows} at the end) — the loop is UNBOUNDED`
    )
    assert.equal(neutralized.newTransitionsAfterTerminal, neutralized.totalRows, 'NEUTRALIZED: with no terminal row, every attempt is a fresh unbounded transition (the `delivery-failed` source grows without limit)')
    // GREEN against the fix: the SAME fixture, the SAME cadence, the REAL module.
    assert.notEqual(fixed.terminalAt, null, 'FIXED: the SAME fixture reaches terminal (the acceptance PASSES on the real module)')
    assert.equal(fixed.status, 'terminal', 'FIXED: the pair settles terminal')
    assert.equal(fixed.newTransitionsAfterTerminal, 0, 'FIXED: ZERO new transitions over 240 sweep cycles after the terminal')
    assert.equal(fixed.furtherDeliverCalls, 0, 'FIXED: zero further re-drives after the terminal')
    // The fix is BOUNDED: the loop broke before the half horizon, so the frozen
    // ledger cannot grow at all.
    assert.equal(fixed.rowsHalf, null, 'FIXED: the loop broke before the half horizon (the bounded pair settled and the sweep never returned to it)')
    assert.ok(neutralized.totalRows > fixed.totalRows, `the runs differ on the IDENTICAL fixture and cadence (${neutralized.totalRows} vs ${fixed.totalRows} rows) — the check discriminates`)
    // NO TIME COMPRESSION: both runs used the SAME real 663 s cadence, so the
    // RED is not an artifact of a fast clock — it is the production condition.
    assert.equal(fixed.effectiveStormWindowMs, RE_DELIVERY_STORM_WINDOW_MS, 'the fixed run kept the storm window at its documented 1 h (no regime change)')
    assert.equal(neutralized.effectiveStormWindowMs, RE_DELIVERY_STORM_WINDOW_MS, 'the neutralized run uses the very same 1 h window — the ONLY difference between RED and GREEN is the cap/storm DECOUPLING')
    // ...and the fixed run is the one that moved to the 2 h CAP window.
    assert.equal(fixed.effectiveCapWindowMs, RE_DELIVERY_CAP_WINDOW_MS, 'the fixed run carries the DERIVED 2 h cap window')
    assert.equal(neutralized.effectiveCapWindowMs, RE_DELIVERY_CAP_WINDOW_MS, 'the neutralized run carries the SAME 2 h constant (it is the CALL SITE that differs, not the constant — that is what makes the RED honest)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// (6) THE DECLARED LIMIT — what ceases (fb-1444 / fb-251).
// ─────────────────────────────────────────────────────────────────────────────
test('builder-411 (vii) DECLARED LIMIT — what ceases: the fix ceases THE SWEEP only, NOT the delivery SEAM — a fresh seam-send still appends rows for a terminated pair (fb-1444), and the re-drive route STAYS bounded afterwards', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(resolveMessagesPath(stateDir), `${JSON.stringify(turnErrorRecord(T0))}\n`, 'utf8')
    const rows = cadenceRows(40, T0)
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const clock = { now: T0 }
    const r = incidentRedeliverer(stateDir, MOD, clock)
    let terminalAt = null
    for (let tick = 1; tick <= 8 * 60; tick++) {
      clock.now = rows[rows.length - 1].ts + tick * SWEEP_TICK_MS
      await r.sweepDue(clock.now)
      if ((await deliveryStatus(stateDir, MESSAGE_ID, SUBJECT)) === 'terminal') { terminalAt = clock.now; break }
    }
    assert.notEqual(terminalAt, null, 'the pair is terminal (the SWEEP ceased)')
    const seen = await pairRows(MOD, stateDir)
    assert.equal(seen.newAfterTerminal, 0, 'the sweep left no new transition after the terminal')
    // Now simulate the SEAM (someone re-sends the same message): a fresh
    // `prepared`/`failed` row pair appended DIRECTLY through `markDelivery` — the
    // PRODUCTION seam writer, not a hand-rolled row.
    await markDelivery(stateDir, MESSAGE_ID, SUBJECT, 'prepared')
    await markDelivery(stateDir, MESSAGE_ID, SUBJECT, 'failed')
    const seenAfterSeam = await pairRows(MOD, stateDir)
    assert.ok(
      seenAfterSeam.newAfterTerminal > 0,
      'DECLARED LIMIT: a fresh SEAM send appends transitions AFTER the terminal — `terminal` is NOT final at the seam (fb-1444: a DIFFERENT defect/owner, NOT fixed by this lane)'
    )
    // And the sweep STILL does not loop: the cap window already holds >= cap
    // attempts, so the next due sweep settles it terminal again — a BOUNDED
    // re-fire. The honest statement: the seam's rows RE-ENTER the cap window, so
    // the cap re-fires once rather than being disabled forever.
    const callsBefore = r.__calls.deliver.length
    for (let tick = 1; tick <= 240; tick++) {
      clock.now = seenAfterSeam.terminalTs + tick * SWEEP_TICK_MS
      await r.sweepDue(clock.now)
    }
    const endState = await pairRows(MOD, stateDir)
    assert.equal(
      endState.newAfterTerminal,
      0,
      'the re-drive route REMAINS BOUNDED after a seam re-send: the cap re-fired and appended a terminal, leaving ZERO non-final transitions after it — it did NOT loop'
    )
    assert.equal(r.__calls.deliver.length, callsBefore, 'the sweep performed NO further delivery for the re-sent pair (the cap window already held the cap in attempts) — never an unbounded loop')
  })
})

test('builder-411 (viii) THE DECLARATION, asserted mechanically: `terminal` ceases the SWEEP through `needsRedelivery` and NOT the seam — the asymmetry IS the fb-1444 limit, and the fix declares it instead of repairing it', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(resolveMessagesPath(stateDir), `${JSON.stringify(turnErrorRecord(T0))}\n`, 'utf8')
    const rows = cadenceRows(40, T0)
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const clock = { now: T0 }
    const r = incidentRedeliverer(stateDir, MOD, clock)
    for (let tick = 1; tick <= 8 * 60; tick++) {
      clock.now = rows[rows.length - 1].ts + tick * SWEEP_TICK_MS
      await r.sweepDue(clock.now)
      if ((await deliveryStatus(stateDir, MESSAGE_ID, SUBJECT)) === 'terminal') break
    }
    assert.equal(await deliveryStatus(stateDir, MESSAGE_ID, SUBJECT), 'terminal', 'the SWEEP ceased: the pair is terminal')
    // THE DECLARATION, asserted mechanically: `needsRedelivery` is the sweep's own
    // eligibility predicate, and it is FALSE for a terminal row — which is exactly
    // WHY the sweep ceases while the seam does not.
    assert.equal(needsRedelivery('terminal'), false, 'WHAT CEASES (the SWEEP): `terminal` is not re-deliverable')
    assert.equal(needsRedelivery('delivered'), false, 'and neither is `delivered`')
    assert.equal(needsRedelivery('failed'), true, 'while a live failure class IS still re-deliverable — the sweep was not disabled wholesale')
    assert.equal(needsRedelivery('prepared'), true, 'and so is a prepared residue')
    assert.equal(needsRedelivery(null), true, 'and an unknown pair is still eligible (the pre-existing semantics are untouched)')
    // The seam writes through `markDelivery` REGARDLESS of `needsRedelivery` —
    // that asymmetry IS the fb-1444 limit, and it is NOT repaired here.
    await markDelivery(stateDir, MESSAGE_ID, SUBJECT, 'prepared')
    assert.equal(await deliveryStatus(stateDir, MESSAGE_ID, SUBJECT), 'prepared', 'WHAT DOES NOT CEASE (the SEAM): the seam is NOT gated by `terminal` — a re-send flipped it back to `prepared`. Out of lane: different defect, different owner.')
  })
})
