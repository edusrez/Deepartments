// dsh-deepartments — builder-409 (token 93f338bd, 2026-09-16): THE INFINITE
// RE-DELIVERY LOOP — the max-attempts stop existed but was UNREACHABLE.
//
// THE MEASURED INCIDENT. Six `Turn-error http-5xx` head-notifications to a
// STABLE post id (`quality-head`) cited a session that had DIED ~2 h earlier
// (`head-quality-head-b8073cb5-…`) and were re-driven forever: 44 sidecar rows
// per message, ~260 attempts across the 6, alternating `prepared`/`failed`,
// over ~4 h, each failure emitting a system-health alert that woke the host.
// The delivery engine rejected every attempt with a 400 (maximum context
// length), so the pair could NEVER deliver — and the automatic re-drive never
// gave up.
//
// WHY THE STOP DID NOT FIRE (the mission's whole question). The stop is
// `redeliveryAttemptsExhausted(attempts, 12)` in `drivePair`, fed by
// `pairAttemptCount` over a 1 h window — while the pair's OWN cadence makes
// the cap UNREACHABLE, by construction:
//   * `pairDue` re-drives a `failed` row only once `maxDelayMs` has elapsed
//     (the backoff caps at 10 min), and a `prepared` row only once it is
//     10 min old — so the effective cadence is ~maxDelayMs PLUS the sweep's
//     own 60 s granularity plus the delivery latency ≈ 660 s;
//   * each attempt appends TWO countable rows ('prepared' + 'failed');
//   * MEASURED on the live ledger (`/.deepartments/deliveries.jsonl`,
//     13 266 rows, 2026-09-16): the ten consecutive `prepared`-to-`prepared`
//     diffs of `m-14217` are 666 734 · 661 634 · 666 412 · 666 601 · 661 874 ·
//     663 305 · 663 353 · 652 864 · 665 849 · 662 078 ms (median ≈ 663 s) —
//     i.e. ~10.85 rows/h against a cap of 12;
//   * and the count is only ever READ at a sweep DECISION instant, which is
//     PHASE-LOCKED: `drivePair` fires as soon as the row is due, so the instant
//     sits ~maxDelayMs after the last `failed` row, never at the window's most
//     favourable alignment. MEASURED at every real decision instant (60 s tick
//     lattice, 1 s resolution, all 60 phases) over all 6 stuck pairs: the count
//     peaks at **10** — never 11, never 12. (The mere sliding maximum of the
//     same rows over a 1 h window is 12, but a decision NEVER lands there — that
//     gap IS the defect.)
// The structural statement is therefore `cap reachable <=> windowMs >=
// maxAttempts * maxDelayMs`; here 12 * 600 000 = 7 200 000 (2 h) > 3 600 000
// (1 h), so the stop was DEAD CODE for EVERY pair of EVERY failure class.
//
// THE FIX (option (A), `messages.ts` only). The window is no longer a
// hand-picked round number: it is DERIVED from the cap it must make reachable
// (`redeliveryWindowFloorMs() = maxAttempts * maxDelayMs`) and ENFORCED as a
// FLOOR in the constructor, so no configuration can narrow it back below
// reachability and silently re-arm the loop. The documented semantics the
// window ALSO carries are preserved: a failure history OLDER than the window
// still never keeps a pair permanently exhausted.
//
// LANE ② DISCIPLINE: 0 builds — the test exercises the SOURCE directly. It
// deliberately does NOT self-register the `ts-src-loader` hook: that hook exists
// to rewrite `.js` → `.ts` specifiers and bare workspace package names, and
// `messages.ts` is SELF-CONTAINED (no relative imports — its own header says
// so), so a plain `import('../packages/dshd-core/src/messages.ts')` loads
// natively under Node's type-stripping. Registering it would be gratuitous and
// would also add a row of drift to the fb-1063 "photo" guard in
// `r6-ladder-flat.test.js`, a file this lane does not own.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  DeliveryRedeliverer,
  RE_DELIVERY_DEFAULT_MAX_ATTEMPTS,
  RE_DELIVERY_DEFAULT_MAX_DELAY_MS,
  RE_DELIVERY_STORM_WINDOW_MS,
  deliveryStatus,
  markDelivery,
  pairAttemptCount,
  parseDeliveryRows,
  redeliveryAttemptsExhausted,
  redeliveryWindowFloorMs,
  resolveDeliveriesPath,
  resolveMessagesPath
} from '../packages/dshd-core/src/messages.ts'

/** The incident's MEASURED cadence (live ledger: median ≈ 663 s between a
 * pair's consecutive `prepared` rows). A fixture that plants anything FASTER
 * would make the cap look reachable and could not reproduce the incident. */
const MEASURED_CADENCE_MS = 663_000
/** The engine's `prepared` → `failed` write-ahead latency of one attempt
 * (measured: ~6.7 s between a pair's `prepared` and `failed` row). */
const DELIVER_LATENCY_MS = 6_700
/** The session cited by the six stuck messages — DEAD at citation time (the
 * quality head was rotated at 16:36; the notifications kept being re-driven
 * against that dead session, including AFTER the rotation). */
const DEAD_SESSION_ID = 'head-quality-head-b8073cb5-8bf4-4079-be42-a6d4178391e8'
/** The six stuck message ids of the incident (cited by ts in the report: they
 * renumber across compactions, per fb-730). */
const SUBJECT = 'quality-head'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'b409-redelivery-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** The incident's message record in SHAPE: a `Turn-error` head notification
 * addressed to a STABLE post id, whose TEXT cites the dead session. The
 * recipient (`quality-head`) is ALIVE in the catalog — which is exactly why the
 * existing dead-RECIPIENT settle (`drivePair` :1563) never caught it, and why
 * post-id routing (the post survives the rotation) never helps either: the
 * unreachable thing is the SESSION the notification is ABOUT, not its
 * addressee. */
function turnErrorRecord(ts) {
  return {
    id: 'm-stuck',
    seq: 1,
    ts,
    from: 'deepartments',
    to: [SUBJECT],
    kind: 'notice',
    text: `[From deepartments] Turn-error http-5xx: post ${SUBJECT} session ${DEAD_SESSION_ID} turn 41 (14:46Z) — 400: This model's maximum context length is 1048576 tokens`
  }
}

/** The pair's sidecar rows at the MEASURED cadence: `cycles` attempts, each a
 * `prepared` row followed by its `failed` rejection DELIVER_LATENCY_MS later —
 * the incident's exact 2-rows-per-cycle shape. */
function measuredCadenceRows(cycles, t0, messageId = 'm-stuck') {
  const rows = []
  for (let i = 0; i < cycles; i++) {
    const t = t0 + i * MEASURED_CADENCE_MS
    rows.push({ messageId, recipientId: SUBJECT, status: 'prepared', ts: t })
    rows.push({ messageId, recipientId: SUBJECT, status: 'failed', ts: t + DELIVER_LATENCY_MS })
  }
  return rows
}

/** The REAL module's seams, bundled so the SAME driver can run against the
 * neutralized textual copy (the revert-check) without touching the repo. */
const MOD = {
  DeliveryRedeliverer,
  markDelivery,
  deliveryStatus,
  parseDeliveryRows,
  resolveDeliveriesPath,
  resolveMessagesPath
}

/** A redeliverer over the incident's stateDir. The `deliver` stub mirrors the
 * ENGINE's write-ahead side (a `prepared` then a `failed` row) and always
 * REJECTS — the incident's 400. `recipientAlive` is the PRODUCTION
 * `recipientCatalogAlive` semantics for this case: the post id is a live
 * (non-retired) post ⇒ TRUE. */
function incidentRedeliverer(stateDir, MOD, { opts = {} } = {}) {
  const calls = { deliver: [], warns: [] }
  const record = turnErrorRecord(0)
  const r = new MOD.DeliveryRedeliverer({
    stateDir,
    logger: { info() {}, warn: (m) => calls.warns.push(m) },
    recipientAlive: () => true,
    recipientDormant: () => false,
    recipientRunning: () => false,
    getRecord: async (id) => (id === 'm-stuck' ? record : undefined),
    resolveCallerSessionId: () => 'deepartments',
    deliver: async (rec, recipientId) => {
      calls.deliver.push({ messageId: rec.id, recipientId })
      await MOD.markDelivery(stateDir, rec.id, recipientId, 'prepared')
      await MOD.markDelivery(stateDir, rec.id, recipientId, 'failed')
      return 'failed'
    }
  }, { baseDelayMs: 15_000, maxDelayMs: 600_000, maxAttempts: 12, preparedStuckMs: 600_000, ...opts })
  r.__calls = calls
  return r
}

/** THE HOUSE REVERT PATTERN (zero writes into the repo): a TEXTUAL copy of
 * `messages.ts` in a mkdtemp with the fix NEUTRALIZED — the window restored to
 * the incident's bare 1 h and the constructor floor removed. Returns the
 * module so the same acceptance can run against the neutralized copy. */
async function neutralizedModule() {
  const src = readFileSync(new URL('../packages/dshd-core/src/messages.ts', import.meta.url), 'utf8')
  const neutralized = src
    .replace('export const RE_DELIVERY_STORM_WINDOW_MS = redeliveryWindowFloorMs()', 'export const RE_DELIVERY_STORM_WINDOW_MS = 60 * 60_000')
    .replace('this.stormWindowMs = Math.max(requestedWindowMs, windowFloorMs)', 'this.stormWindowMs = requestedWindowMs')
  assert.notEqual(neutralized, src, 'the neutralization must actually apply (both seams present) — otherwise the revert-check would be a tautology')
  const dir = mkdtempSync(path.join(tmpdir(), 'b409-neutral-'))
  writeFileSync(path.join(dir, 'messages.ts'), neutralized)
  const mod = await import(pathToFileURL(path.join(dir, 'messages.ts')).href)
  return { mod, dir }
}

/** Drive ONE incident pair through the REAL sweep on a 60 s tick lattice for
 * `hours` hours past the seeded ledger; return what happened. */
async function driveIncident(MOD, { cycles = 40, hours = 8, opts = {} } = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'b409-e2e-'))
  const T0 = 1_789_570_040_000
  await writeFile(MOD.resolveMessagesPath(stateDir), `${JSON.stringify(turnErrorRecord(T0))}\n`, 'utf8')
  const rows = measuredCadenceRows(cycles, T0)
  await writeFile(MOD.resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  const r = incidentRedeliverer(stateDir, MOD, { opts })
  const lastTs = rows[rows.length - 1].ts
  let terminalAtTick = null
  for (let tick = 1; tick <= hours * 60; tick++) {
    await r.sweepDue(lastTs + tick * 60_000)
    if ((await MOD.deliveryStatus(stateDir, 'm-stuck', SUBJECT)) === 'terminal') { terminalAtTick = tick; break }
  }
  const finalRows = MOD.parseDeliveryRows(await readFile(MOD.resolveDeliveriesPath(stateDir), 'utf8'))
  const out = {
    effectiveWindowMs: r.stormWindowMs,
    status: await MOD.deliveryStatus(stateDir, 'm-stuck', SUBJECT),
    terminalAfterMinutes: terminalAtTick,
    deliverCalls: r.__calls.deliver.length,
    failedRows: finalRows.filter((x) => x.status === 'failed').length,
    totalRows: finalRows.length
  }
  await rm(stateDir, { recursive: true, force: true })
  return out
}

test('builder-409 (pure): the attempt-count window is DERIVED from the cap it must make reachable (`maxAttempts * maxDelayMs`); the 1 h window the incident ran with could never reach a cap of 12', () => {
  // The reachability rule as arithmetic. At the cap's own worst-case cadence
  // (one attempt per maxDelayMs) the pair accrues 2 rows per attempt, so it
  // needs `maxAttempts * maxDelayMs` of window to be able to count `maxAttempts`.
  assert.equal((2 * 3_600_000) / RE_DELIVERY_DEFAULT_MAX_DELAY_MS, 12, 'at exactly maxDelayMs the cadence yields exactly 12 rows/h — the cap with ZERO margin')
  assert.ok(
    RE_DELIVERY_DEFAULT_MAX_ATTEMPTS * RE_DELIVERY_DEFAULT_MAX_DELAY_MS > 3_600_000,
    'the cap therefore requires a window WIDER than the 1 h the incident ran with (12 * 10 min = 2 h)'
  )
  assert.equal(redeliveryWindowFloorMs(), 7_200_000, 'the floor is maxAttempts * maxDelayMs = 7 200 000 ms (2 h)')
  assert.equal(redeliveryWindowFloorMs(12, 600_000), 7_200_000, 'the floor scales with the cap')
  assert.equal(redeliveryWindowFloorMs(5, 60_000), 300_000, 'a smaller cap/backoff yields a proportionally smaller floor')
  assert.equal(RE_DELIVERY_STORM_WINDOW_MS, redeliveryWindowFloorMs(), 'the shipped window IS the floor — derived, never hand-picked')
  assert.ok(RE_DELIVERY_STORM_WINDOW_MS > 3_600_000, 'the shipped window is WIDER than the 1 h that made the cap unreachable')
  // The window is a FLOOR, never a ceiling: a caller may widen it, and a caller
  // asking for the incident's 1 h is RAISED to the floor (the fence).
  const deps = {
    stateDir: '/tmp', logger: { info() {}, warn() {} }, recipientAlive: () => true,
    getRecord: async () => undefined, resolveCallerSessionId: (f) => f, deliver: async () => 'failed'
  }
  assert.equal(new DeliveryRedeliverer(deps, { stormWindowMs: 3_600_000 }).stormWindowMs, redeliveryWindowFloorMs(), 'a sub-floor window is FENCED UP (no configuration can re-arm the loop by narrowing the window)')
  assert.equal(new DeliveryRedeliverer(deps, { stormWindowMs: 10 * 3_600_000 }).stormWindowMs, 36_000_000, 'a WIDER window is honored (the floor never caps a caller)')
  assert.equal(new DeliveryRedeliverer(deps).stormWindowMs, redeliveryWindowFloorMs(), 'the default is exactly the floor')
})

test('builder-409 (THE CASE): a `Turn-error` notification whose CITED session is dead and whose recipient is ALIVE reaches TERMINAL on the cap — the automatic re-drive STOPS with ZERO further attempts', async () => {
  // The acceptance's core case: two+ attempts on a message whose cited session
  // is no longer alive ⇒ TERMINAL, no re-enqueue. Here the pair carries the
  // incident's full 40-cycle history and the REAL sweep decides.
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_789_570_040_000
    await writeFile(resolveMessagesPath(stateDir), `${JSON.stringify(turnErrorRecord(T0))}\n`, 'utf8')
    const rows = measuredCadenceRows(40, T0)
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const r = incidentRedeliverer(stateDir, MOD)
    // Sweep on the production 60 s lattice until the pair settles (bounded).
    // The decision instant is NOT arbitrary: `drivePair` is only reached on a
    // tick where `pairDue` says yes, and that phase-lock is part of the defect —
    // so the test must let the REAL sweep choose the instant, not pick one.
    let terminalAt = null
    let attemptsAtTerminal = 0
    for (let tick = 1; tick <= 8 * 60; tick++) {
      const nowMs = rows[rows.length - 1].ts + tick * 60_000
      await r.sweepDue(nowMs)
      if ((await deliveryStatus(stateDir, 'm-stuck', SUBJECT)) === 'terminal') {
        terminalAt = nowMs
        attemptsAtTerminal = pairAttemptCount(rows, 'm-stuck', SUBJECT, nowMs, r.stormWindowMs)
        break
      }
    }
    assert.notEqual(terminalAt, null, 'the pair REACHES terminal (with the incident\'s 1 h window it never did — it looped forever)')
    assert.ok(
      redeliveryAttemptsExhausted(attemptsAtTerminal, RE_DELIVERY_DEFAULT_MAX_ATTEMPTS),
      `the attempt count AT THE REAL decision instant must REACH the cap (got ${attemptsAtTerminal}; with the incident's 1 h window it peaked at 10 at every decision instant and the stop never fired)`
    )
    assert.equal(await deliveryStatus(stateDir, 'm-stuck', SUBJECT), 'terminal', 'the pair settles TERMINAL on the cap (not re-enqueued)')
    assert.equal(r.__calls.deliver.length, 0, 'a TERMINAL pair is NEVER re-driven — ZERO further attempts, so there is no third+ attempt at all')
    assert.ok(r.__calls.warns.some((w) => /STOPPED after \d+ attempts \(max 12\)/.test(w)), 'the stop is LOUD (stop-with-alert — the warn names the pair and the count)')
    // No later sweep resurrects it.
    await r.sweepDue(terminalAt + 3 * 3_600_000)
    assert.equal(r.__calls.deliver.length, 0, 'no later sweep resurrects the terminal pair')
    assert.equal(await deliveryStatus(stateDir, 'm-stuck', SUBJECT), 'terminal', 'the terminal mark is stable')
  })
})

test('builder-409 (INVARIANT, drift in the live ledger): on the MEASURED cadence the loop is BOUNDED — the pair reaches terminal within the cap, and the `failed` counter (the `delivery-failed` alert source) FREEZES instead of growing with a frozen id', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_789_570_040_000
    // Reproduce the incident LIVE from a SINGLE initial attempt: let the REAL
    // sweep drive it at the measured cadence and see how many attempts
    // accumulate before it settles terminal.
    await writeFile(resolveMessagesPath(stateDir), `${JSON.stringify(turnErrorRecord(T0))}\n`, 'utf8')
    await writeFile(resolveDeliveriesPath(stateDir), `${JSON.stringify({ messageId: 'm-stuck', recipientId: SUBJECT, status: 'prepared', ts: T0 })}\n`, 'utf8')
    const r = incidentRedeliverer(stateDir, MOD)
    let terminalAt = null
    for (let tick = 1; tick <= 12 * 60; tick++) {
      const t = T0 + tick * 60_000
      await r.sweepDue(t)
      if ((await deliveryStatus(stateDir, 'm-stuck', SUBJECT)) === 'terminal') { terminalAt = t; break }
    }
    assert.notEqual(terminalAt, null, 'the loop is BOUNDED — the pair reaches terminal within the horizon (before the fix it NEVER did)')
    const nonFinalRows = r.__calls.deliver.length * 2 + 1
    assert.ok(
      nonFinalRows <= 2 * RE_DELIVERY_DEFAULT_MAX_ATTEMPTS + 2,
      `the pair accumulated ${nonFinalRows} non-final rows before terminal — bounded by the cap (never the incident's unbounded 44+ rows / ~260 attempts)`
    )
    // The frozen-id invariant: a terminal pair is never re-attempted, so the
    // `failed`-row count — the row class `scanDeliveryFindings` turns into
    // `delivery-failed` alerts — stops growing. Sweep 4 more hours and compare.
    const failedBefore = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8')).filter((x) => x.status === 'failed').length
    const callsBefore = r.__calls.deliver.length
    for (let tick = 1; tick <= 4 * 60; tick++) await r.sweepDue(terminalAt + tick * 60_000)
    const failedAfter = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8')).filter((x) => x.status === 'failed').length
    assert.equal(failedAfter, failedBefore, 'the `failed` row count is FROZEN after terminal — the `delivery-failed` alert source stops growing with the frozen id')
    assert.equal(r.__calls.deliver.length, callsBefore, 'zero further re-drive attempts over 4 additional hours')
  })
})

test('builder-409 (REVERT-CHECK, demonstrated): with the fix NEUTRALIZED the SAME fixture loops FOREVER (measured: 471 deliver calls / 1022 rows in 8 h); on the real module it settles terminal with ZERO further attempts', async () => {
  const fixed = await driveIncident(MOD, { hours: 8 })
  const { mod: MODN, dir } = await neutralizedModule()
  try {
    const neutralized = await driveIncident(MODN, { hours: 8 })
    // The neutralized run is the INCIDENT reproduced: it never terminalizes and
    // keeps appending rows forever.
    assert.equal(neutralized.effectiveWindowMs, 3_600_000, 'the neutralized copy runs with the incident\'s 1 h window (the fix is genuinely neutralized)')
    assert.equal(neutralized.status, 'failed', 'NEUTRALIZED: the pair NEVER reaches terminal — the cap is unreachable, exactly the incident')
    assert.equal(neutralized.terminalAfterMinutes, null, 'NEUTRALIZED: 8 h of sweeps and the loop is still running')
    assert.ok(neutralized.deliverCalls > 100, `NEUTRALIZED: the re-drive looped unboundedly (${neutralized.deliverCalls} deliver calls in 8 h) — the incident's ~260 attempts class`)
    assert.ok(neutralized.failedRows > neutralized.deliverCalls, 'NEUTRALIZED: every attempt appends a fresh `failed` row — the `delivery-failed` alert source grows without limit with a FROZEN id')
    // The REAL module on the identical fixture.
    assert.equal(fixed.effectiveWindowMs, redeliveryWindowFloorMs(), 'the real module derives the window from the cap (2 h)')
    assert.equal(fixed.status, 'terminal', 'FIXED: the same fixture settles TERMINAL — the acceptance PASSES on the real module')
    assert.equal(fixed.deliverCalls, 0, 'FIXED: ZERO further re-drive attempts (the loop is CUT at the first decision)')
    assert.equal(fixed.failedRows, 40, 'FIXED: the `failed` count is FROZEN at the seeded history — it does not grow by even one row')
    // The discriminating power of the check (a real revert-check, not a tautology).
    assert.ok(neutralized.totalRows > fixed.totalRows * 10, `the two runs differ by >10x (${neutralized.totalRows} vs ${fixed.totalRows} rows) on the IDENTICAL fixture — the test discriminates`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
