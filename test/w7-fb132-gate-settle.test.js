// dsh-deepartments — WAVE 7 LANE 4/4 (fb-132, gate/wake-seam 2026-09-05, run
// token 2383574a; UPDATED 2026-09-06 by the WAKE-ON-DELIVERED lane — the 2nd
// half criterion): the re-drive/sweep FIFO-GATE HOLD (the fb-150 deposit —
// «Sweep del gate FIFO DUPLICA rows prepared sin consumirlas»: 28 prepared
// rows / 0 terminal in ~2.4h at the ~660s cadence, the spool growing without
// limit). All src-native (0 builds, 0 real APIs; temp stateDir + stub deps
// only — the lane discipline).
//
//   MECHANISM (the citation the fix removes): drivePair (messages.ts) re-drives
//       a stale 'prepared' pair through the deliver seam
//       (deliverBusRecordForRedeliver → deliverOrQueue): the seam appends the
//       write-ahead 'prepared' (delivery.ts:271) and then, on its FIFO gate
//       (an EARLIER-seq pending pair of the same recipient), appends a SECOND
//       fresh 'prepared' (markFinal 'prepared', delivery.ts:313-314) — TWO new
//       'prepared' rows per sweep pass into a gated inbox, none consumed.
//   FIX v1 (2026-09-05, fe5cab4): drivePair checks the SAME gate predicate
//       before the deliver call and SETTLES the gated row 'terminal'.
//   FIX v2 (2026-09-06, WAKE-ON-DELIVERED): a 'terminal' settle of an ALIVE
//       recipient LOSES the pair ('terminal' is never-re-delivered) now that
//       `drainRecipientQueue` drains a queue at the recipient's next REAL wake.
//       The 2nd-half criterion: the sweep SKIPS a gated pair of an ALIVE
//       recipient — no settle, no re-mark, zero rows — and the P4 summary
//       counts it `gatedHeld` (the legit fb-27 exception of a live-but-blocked
//       queue); the pair stays 'prepared' and becomes a DRAIN CANDIDATE at the
//       next real wake (the FIFO unwinds pair by pair as each head resolves).
//       The DEAD/unknown settle is UNCHANGED (the dead branch precedes the
//       gate branch; only the alive recipient class changed).
//   ONLY a GENUINE (ungated) attempt re-marks 'prepared' (its write-ahead).
//   TESTS:
//     (i)  the fb-150 reproduction: N sweep passes over a GATED inbox of an
//          ALIVE recipient DO NOT grow the spool AND DO NOT settle — the gated
//          pair stays 'prepared' (the shadowed dust stays in-flight) and is
//          counted gatedHeld; the DRAIN then delivers both pairs at the real
//          wake;
//          + the CONTROL: the pre-fix gate-blind sweep GREW the spool by 2
//          'prepared' rows per pass (the exact fb-150 mechanism).
//     (ii) the genuine re-drive still works: an UNGATED stale pair re-drives
//          (deliver called, write-ahead 'prepared' + final 'delivered'); TWO
//          stale pairs of one recipient unblock in seq order in ONE pass (the
//          fb-117 order — the gate reads the sidecar fresh per pair); a
//          subsequent pass is a no-op; the 'self' hold is never gate-settled.
//     (iii) coexistence with B3/G2/m-440 (no regression): a DORMANT recipient's
//          pair is left untouched (B3 holds; reported dormantHeld); a noWake
//          row is left untouched (P2 holds; noWakeHeld); a DUE GATED pair of an
//          ALIVE recipient is HELD (gatedHeld) and re-drives genuinely once its
//          gating earlier pair resolves; the G2 classification keeps the
//          in-flight pair-latest (keptInFlight — never collapsed) and still
//          washes shadowed dust behind a FINAL row; a FRESH live pair
//          (< preparedStuck) is not due → untouched, then AGES into a normal
//          re-drive (the m-440 fresh-live-queue contract); the gate predicate
//          FAIL-SOFT (a throw → warn + proceed gate-blind).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  DeliveryRedeliverer,
  markDelivery,
  parseDeliveryRows,
  resolveDeliveriesPath,
  resolveMessagesPath,
  hasEarlierPendingPair,
  classifyG2LegacyRows,
  deliveryStatus
} from '../packages/dshd-core/src/messages.ts'
// The SEND-path engine: imported DYNAMICALLY (the module-hook registration at
// the top must run FIRST — a static import is hoisted above it and the src
// graph then fails to link; the same discipline the sibling lane tests use).
const { createDeliveryEngine } = await import('../packages/dshd-core/src/delivery.ts')

// ---------------------------------------------------------------------------
// Shared helpers: temp stateDir + the lane2-style redeliverer stub harness.
// ---------------------------------------------------------------------------
async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'w7-fb132-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

async function seed(stateDir, { records = [], rows = [] } = {}) {
  if (records.length > 0) await writeFile(resolveMessagesPath(stateDir), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  if (rows.length > 0) await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

function row(messageId, recipientId, status, ts, noWake) {
  return noWake === true ? { messageId, recipientId, status, ts, noWake } : { messageId, recipientId, status, ts }
}

function record(id, seq, to, from = 'sender') {
  return { id, seq, ts: 1_000, from, to, text: `msg ${id}`, kind: 'agent' }
}

async function readRows(stateDir) {
  return parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
}

function countPair(rows, messageId, recipientId, status) {
  return rows.filter((r) => r.messageId === messageId && r.recipientId === recipientId && r.status === status).length
}

/** The FIFO-gate predicate wired EXACTLY like the production seam
 * (hasEarlierPendingPair over the CURRENT sidecar + the recipient's seqs). */
function makeGate(stateDir, seqsByRecipient) {
  return async (recipientId, seq) => {
    const text = await readFile(resolveDeliveriesPath(stateDir), 'utf8')
    return hasEarlierPendingPair(parseDeliveryRows(text), (r) => seqsByRecipient.get(r) ?? [], recipientId, seq)
  }
}

/** A deliver stub that MIMICS the real seam (deliverOrQueue): the write-ahead
 * 'prepared', then the FIFO gate (an earlier pending pair → queued BEHIND as a
 * SECOND fresh 'prepared' — the pre-fix fb-150 growth), else the final. Used
 * by the CONTROL (the gate-blind legacy sweep) and by the genuine-attempt
 * tests (the write-ahead of a REAL re-drive must still be observable). */
function seamDeliver(stateDir, calls, gate) {
  return async (record, recipientId) => {
    calls.deliver.push({ messageId: record.id, recipientId })
    await markDelivery(stateDir, record.id, recipientId, 'prepared')
    if (await gate(recipientId, record.seq)) {
      await markDelivery(stateDir, record.id, recipientId, 'prepared')
      return 'prepared'
    }
    await markDelivery(stateDir, record.id, recipientId, 'delivered')
    return 'delivered'
  }
}

function plainDeliver(stateDir, calls) {
  return async (record, recipientId) => {
    calls.deliver.push({ messageId: record.id, recipientId })
    await markDelivery(stateDir, record.id, recipientId, 'delivered')
    return 'delivered'
  }
}

/** The lane2-style DeliveryRedeliverer over a temp stateDir (stub deps). The
 * `calls` object is exposed on the instance (r.__calls) for the assertions.
 * `gate` (optional) swaps the default plain deliver for the REAL-seam mimic
 * (write-ahead 'prepared' → FIFO gate → queued-behind 'prepared' / final) so
 * the pre-fix growth mechanism and the genuine-attempt write-ahead are
 * observable; the seam writes into the SAME `calls` the logger + assertions
 * read. */
function redeliverer(stateDir, { gate, ...overrides } = {}) {
  const calls = { deliver: [], informs: [], warns: [] }
  const recordsById = new Map()
  const deps = {
    stateDir,
    logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
    recipientAlive: () => true,
    recipientDormant: () => false,
    recipientRunning: () => false,
    getRecord: async (id) => (recordsById.get(id) ?? undefined),
    resolveCallerSessionId: (from) => from,
    deliver: gate !== undefined ? seamDeliver(stateDir, calls, gate) : plainDeliver(stateDir, calls),
    ...overrides
  }
  const r = new DeliveryRedeliverer(deps, {
    baseDelayMs: 15_000, maxDelayMs: 600_000, maxAttempts: 12, stormWindowMs: 3600_000,
    preparedStuckMs: 600_000, g2DrainSeedLimit: 250, legacyAgeMs: 600_000
  })
  r.__calls = calls
  r.__records = (id, rec) => recordsById.set(id, rec)
  return r
}

// ---------------------------------------------------------------------------
// (i) the fb-150 reproduction: the FIXED sweep HOLDS a gated pair of an ALIVE
// recipient — the spool stays FLAT across N passes (the 2nd-half criterion of
// the WAKE-ON-DELIVERED lane: skip + gatedHeld, NO settle — a settle to
// 'terminal' would LOSE the pair for an alive recipient whose next real wake
// can drain it).
// ---------------------------------------------------------------------------
test('w7-fb132 (i): N sweep passes over a GATED inbox of an ALIVE recipient DO NOT grow the spool AND DO NOT settle — the gated pair stays \'prepared\' (a drain candidate for its next real wake) and is counted gatedHeld, the pre-seeded shadowed dust stays in-flight (prepared 8 → 8 flat, 0 terminal)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now() // the seam's write-ahead marks use the real clock — the injected pass times are relative to it
    const seqsByRecipient = new Map([['rx', [1, 2]]])
    // The gating pair m-1 → rx: a noWake 'prepared' P2-held (the idle
    // recipient's no-wake intent — it NEVER re-drives via the sweep → gates
    // everything behind it; its only drain is the recipient's next REAL wake,
    // where `drainRecipientQueue` drives it head-first). The spooled pair
    // m-2 → rx: every pre-fix sweep pass appended fresh 'prepared' rows once
    // the latest aged past the 10-min criterion.
    await seed(stateDir, {
      records: [record('m-1', 1, ['rx']), record('m-2', 2, ['rx'])],
      rows: [
        row('m-1', 'rx', 'prepared', T0 - 40 * 60_000, true), // the GATING pair (P2-held)
        // the pre-fix fb-150 deposit of m-2: shadowed 'prepared' dust + the stale latest
        ...[-300, -280, -260, -240, -220, -200].map((min) => row('m-2', 'rx', 'prepared', T0 + min * 60_000)),
        row('m-2', 'rx', 'prepared', T0 - 40 * 60_000)
      ]
    })
    const r = redeliverer(stateDir, { pendingEarlierSeq: makeGate(stateDir, seqsByRecipient) })
    r.__records('m-1', record('m-1', 1, ['rx']))
    r.__records('m-2', record('m-2', 2, ['rx']))

    // Pass 1: m-2 is DUE (stale) but STILL GATED behind m-1's pending pair →
    // the drive SKIPS it (2nd-half criterion: no settle — the recipient is
    // ALIVE and its next real wake drains the queue; never reaches the deliver
    // seam; zero new rows appended).
    await r.sweepDue(T0)
    let rows = await readRows(stateDir)
    assert.equal(r.__calls.deliver.length, 0, 'the GATED pass NEVER reaches the deliver seam (no re-mark \'prepared\')')
    assert.equal(countPair(rows, 'm-2', 'rx', 'prepared'), 7, 'm-2 keeps its 7 prepared rows (6 shadowed dust + the pair-latest — NOT settled, NOT re-marked)')
    assert.equal(countPair(rows, 'm-2', 'rx', 'terminal'), 0, 'm-2 gains ZERO terminal rows (the 2nd-half criterion: no settle of an alive recipient — a settle would lose the pair)')
    assert.equal(countPair(rows, 'm-1', 'rx', 'prepared'), 1, 'the held P2 gating pair is untouched (still its ONE prepared row — noWakeHeld)')
    assert.equal(rows.length, 8, 'the sidecar total after pass 1 is FLAT (8 = the seeded rows; zero appends — the sweep adds nothing)')
    assert.ok(r.__calls.informs.some((l) => /m-2 → rx \(was prepared\) held gatedHeld/.test(l)), 'the skip logs the gatedHeld hold explicitly (no settle marker)')
    assert.ok(!r.__calls.informs.some((l) => /G2 legacy settle: .*'prepared' dust rows/.test(l)), 'G2 settles NOTHING (the shadowed dust of an ALIVE in-flight pair is keptInFlight — the attempt ledger + the drain candidates stay intact)')
    // The P4 honest prepared-state summary (the held classes, by design):
    assert.deepEqual(r.sweepState(), {
      cycles: 1,
      lastCycleTs: T0,
      preparedStuckRemaining: 2, // m-1 (noWake-held) + m-2 (gatedHeld) — the by-design residue
      oldestPreparedTs: T0 - 40 * 60_000,
      dormantHeld: 0,
      noWakeHeld: 1,
      gatedHeld: 1
    }, 'the sweep-state closure datum discriminates the held classes: noWakeHeld (m-1) + gatedHeld (m-2 — the FIFO-blocked ALIVE queue)')

    // Passes 2..4: nothing is due-and-drivable (m-1 P2-held, m-2 gated-held) →
    // the spool CANNOT grow (the N-pass stabilization; the pair stays a DRAIN
    // candidate — `drainRecipientQueue` delivers it at the next real wake).
    const totalAfter1 = rows.length
    const preparedAfter1 = countPair(rows, 'm-1', 'rx', 'prepared') + countPair(rows, 'm-2', 'rx', 'prepared')
    for (const now of [T0 + 61_000, T0 + 700_000, T0 + 1_400_000]) {
      await r.sweepDue(now)
      rows = await readRows(stateDir)
      assert.equal(rows.length, totalAfter1, 'each further sweep pass appends NOTHING (the sidecar total is flat)')
      assert.equal(countPair(rows, 'm-1', 'rx', 'prepared') + countPair(rows, 'm-2', 'rx', 'prepared'), preparedAfter1, 'the prepared count stays flat (8 = 1 gating + 7 spooled) across passes')
    }
    assert.equal(r.__calls.deliver.length, 0, 'the deliver seam was never reached in ANY of the N passes (the skip is the sweep\'s own domain)')
    assert.equal(r.sweepState().cycles, 4, '4 cycles ran — a cycle is a fire, the no-growth holds across every one')
    // The spooled pair is STILL a drain candidate at the recipient's real wake:
    assert.equal(await r.drainRecipientQueue('rx'), 2, 'the real wake drains BOTH pairs in FIFO order (m-1 head-first — the gate opens pair by pair)')
  })
})

test('w7-fb132 (i-control): the PRE-FIX gate-blind sweep GREW the spool by 2 \'prepared\' rows per pass over the same gated inbox (the exact fb-150 mechanism the settle removes)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const seqsByRecipient = new Map([['rx', [1, 2]]])
    const gate = makeGate(stateDir, seqsByRecipient)
    await seed(stateDir, {
      records: [record('m-1', 1, ['rx']), record('m-2', 2, ['rx'])],
      rows: [
        row('m-1', 'rx', 'prepared', T0 - 40 * 60_000, true), // the GATING pair (P2-held)
        row('m-2', 'rx', 'prepared', T0 - 40 * 60_000)        // the spooled pair (stale)
      ]
    })
    // NO pendingEarlierSeq dep (the gate-blind legacy sweep) + a deliver stub
    // that mimics the REAL seam (write-ahead 'prepared' → gate → queued BEHIND
    // as a second 'prepared' — delivery.ts:271 + 313-314).
    const r = redeliverer(stateDir, { gate })
    r.__records('m-1', record('m-1', 1, ['rx']))
    r.__records('m-2', record('m-2', 2, ['rx']))
    const counts = []
    for (const now of [T0, T0 + 700_000, T0 + 1_400_000]) {
      await r.sweepDue(now)
      counts.push(countPair(await readRows(stateDir), 'm-2', 'rx', 'prepared'))
    }
    // 1 (initial) → 3 → 5 → 7: TWO fresh 'prepared' rows per 10-min pass, none
    // consumed — the unbounded deposit the evidence measured (28 in ~2.4h).
    assert.deepEqual(counts, [3, 5, 7], 'the legacy sweep grows the m-2 prepared rows by exactly 2 per pass (the fb-150 duplication), none consumed')
    assert.equal(r.__calls.deliver.length, 3, 'the legacy sweep reached the deliver seam on every pass (which re-marked \'prepared\')')
  })
})

// ---------------------------------------------------------------------------
// (ii) the GENUINE re-drive still works — regardless of the new gate check.
// ---------------------------------------------------------------------------
test('w7-fb132 (ii): a genuine (UN)gated re-drive still re-drives — deliver called, the write-ahead \'prepared\' of the REAL attempt + final \'delivered\' recorded; TWO stale pairs of one recipient unblock in seq order in ONE pass', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const seqsByRecipient = new Map([['rx', [1, 2]]])
    const gate = makeGate(stateDir, seqsByRecipient)
    await seed(stateDir, {
      records: [record('m-1', 1, ['rx']), record('m-2', 2, ['rx'])],
      rows: [
        row('m-1', 'rx', 'prepared', T0 - 40 * 60_000),
        row('m-2', 'rx', 'prepared', T0 - 40 * 60_000)
      ]
    })
    const r = redeliverer(stateDir, { gate, pendingEarlierSeq: gate })
    r.__records('m-1', record('m-1', 1, ['rx']))
    r.__records('m-2', record('m-2', 2, ['rx']))

    await r.sweepDue(T0)
    assert.deepEqual(r.__calls.deliver.map((d) => d.messageId), ['m-1', 'm-2'], 'BOTH stale pairs re-drive in seq order (m-1 first — its UNGATED drive clears the queue; m-2\'s gate check then reads m-1 as delivered → not gated → genuine)')
    let rows = await readRows(stateDir)
    assert.equal(countPair(rows, 'm-1', 'rx', 'delivered'), 1, 'm-1 final delivered (the genuine attempt consumed its pass row)')
    assert.equal(countPair(rows, 'm-2', 'rx', 'delivered'), 1, 'm-2 final delivered (the gate unblocked in the SAME pass — the fb-117 seq order)')
    assert.equal(await deliveryStatus(stateDir, 'm-1', 'rx'), 'delivered', 'm-1 latest row delivered')
    assert.equal(await deliveryStatus(stateDir, 'm-2', 'rx'), 'delivered', 'm-2 latest row delivered')
    // The ONLY terminal rows are the G2 IN-PLACE WASH of the aged seed rows
    // (shadowed by the new delivered final — ts preserved at T0-40min): never a
    // fb-132 settle MARK (those append at the pass time ≈ T0).
    const terminals = rows.filter((x) => x.status === 'terminal' && (x.messageId === 'm-1' || x.messageId === 'm-2'))
    assert.equal(terminals.length, 2, 'two terminal rows — the G2 stale-dust wash of the aged seeds (the designed spool cleanup, NOT the gate settle)')
    assert.ok(terminals.every((x) => x.ts === T0 - 40 * 60_000), 'the washed rows keep their ORIGINAL ts (the G2 in-place flip — proof they are washes, not fresh settle marks)')
    assert.ok(!r.__calls.informs.some((l) => /FIFO-gated/.test(l)), 'the fb-132 gate settle NEVER fired (a genuine attempt has no terminal settle)')
    assert.equal(countPair(rows, 'm-1', 'rx', 'prepared'), 1, 'the fresh write-ahead \'prepared\' of the REAL attempt remains (re-mark \'prepared\' ONLY because the genuine re-drive started)')
    assert.equal(countPair(rows, 'm-2', 'rx', 'prepared'), 1, 'the same for m-2 — re-mark \'prepared\' happens ONLY when the genuine attempt begins')

    // A subsequent pass: nothing is due anymore → a pure no-op (no re-drive,
    // no new rows, no growth).
    const totalAfter1 = rows.length
    await r.sweepDue(T0 + 61_000)
    rows = await readRows(stateDir)
    assert.equal(rows.length, totalAfter1, 'the next pass appends nothing (both pairs settled delivered)')
    assert.equal(r.__calls.deliver.length, 2, 'deliver was called exactly once per pair (no storm)')
  })
})

test('w7-fb132 (ii-self): the \'self\' hold is NEVER gate-settled (the engine\'s own gate skips self sends — mirrored in the sweep)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    // m-1 self (from rx): its OWN earlier m-0 self pair is pending 'prepared' —
    // the gate predicate would fire for ANY other recipient, but a self hold is
    // never a splice and must never be settled by the re-drive.
    await seed(stateDir, {
      records: [record('m-0', 0, ['rx'], 'rx'), record('m-1', 1, ['rx'], 'rx')],
      rows: [row('m-0', 'rx', 'prepared', T0 - 40 * 60_000), row('m-1', 'rx', 'prepared', T0 - 40 * 60_000)]
    })
    const gate = makeGate(stateDir, new Map([['rx', [0, 1]]]))
    const r = redeliverer(stateDir, { pendingEarlierSeq: gate })
    r.__records('m-0', record('m-0', 0, ['rx'], 'rx'))
    r.__records('m-1', record('m-1', 1, ['rx'], 'rx'))
    await r.sweepDue(T0)
    assert.equal(r.__calls.deliver.length, 2, 'both self pairs re-drive (the gate check is skipped for record.from === recipient — never settled)')
    assert.equal(await deliveryStatus(stateDir, 'm-1', 'rx'), 'delivered', 'the self pair delivered (the engine\'s self hold branch — the ack-loop guard)')
    assert.ok(!r.__calls.informs.some((l) => /FIFO-gated/.test(l)), 'NO fb-132 gate settle fired for the self hold (self sends are never gated — drivePair mirrors the engine)')
  })
})

// ---------------------------------------------------------------------------
// (iii) coexistence — B3 dormancy, P2 noWake, m-440 fresh live queue, and the
// FAIL-SOFT gate (no regression to the mother lanes).
// ---------------------------------------------------------------------------
test('w7-fb132 (iii): B3 dormancy + P2 noWake holds are untouched (never gate-settled; reported dormantHeld/noWakeHeld); a DUE GATED pair of an ALIVE recipient is HELD (stays \'prepared\' — counted gatedHeld, the 2nd-half criterion) and re-drives genuinely ONCE its gating pair ages and resolves; a FRESH live pair is not due → untouched, then AGES into a normal re-drive (m-440 preserved)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const seqsByRecipient = new Map([['rx', [3, 4]]])
    const gate = makeGate(stateDir, seqsByRecipient)
    await seed(stateDir, {
      records: [
        record('m-1', 1, ['dorm']), record('m-2', 2, ['nw']),
        record('m-3', 3, ['rx']), record('m-4', 4, ['rx'])
      ],
      rows: [
        row('m-1', 'dorm', 'prepared', T0 - 40 * 60_000), // B3: dormant recipient
        row('m-2', 'nw', 'prepared', T0 - 40 * 60_000, true), // P2: explicit noWake
        row('m-3', 'rx', 'prepared', T0 - 5 * 60_000), // m-440: FRESH live queue (< 10 min)
        row('m-4', 'rx', 'prepared', T0 - 40 * 60_000) // due + GATED by the fresh m-3 pair
      ]
    })
    const r = redeliverer(stateDir, {
      recipientDormant: (id) => id === 'dorm',
      pendingEarlierSeq: gate
    })
    r.__records('m-1', record('m-1', 1, ['dorm']))
    r.__records('m-2', record('m-2', 2, ['nw']))
    r.__records('m-3', record('m-3', 3, ['rx']))
    r.__records('m-4', record('m-4', 4, ['rx']))

    // Pass 1: m-3 is NOT due (fresh — the m-440 grace); m-1/m-2 are held; m-4
    // is DUE and GATED by m-3's fresh pending pair (the gate reads status, not
    // age) → the 2nd-half criterion HOLDS m-4 (no settle — the recipient is
    // ALIVE; only the dead settle terminates).
    await r.sweepDue(T0)
    let rows = await readRows(stateDir)
    assert.equal(r.__calls.deliver.length, 0, 'nothing genuinely drivable in this pass (m-3 fresh → not due; m-1/m-2 held; m-4 gated → held)')
    assert.equal(countPair(rows, 'm-1', 'dorm', 'prepared'), 1, 'B3: the dormant recipient\'s pair is UNTOUCHED (its queue drains at its next real wake — never settled, never re-driven)')
    assert.equal(countPair(rows, 'm-2', 'nw', 'prepared'), 1, 'P2: the explicit noWake pair is UNTOUCHED (the no-wake-until-wake intent — the WAKE-SEAM guard the lane must not break)')
    assert.equal(countPair(rows, 'm-3', 'rx', 'prepared'), 1, 'm-440: the FRESH live pair is untouched (not due — the fresh-live-queue grace; it AGES into the re-drive criteria, never the settle)')
    assert.equal(countPair(rows, 'm-4', 'rx', 'prepared'), 1, 'the DUE GATED pair is HELD — its prepared row stays (the 2nd-half criterion: alive recipient → skip, no settle, no re-mark)')
    assert.equal(await deliveryStatus(stateDir, 'm-4', 'rx'), 'prepared', 'm-4 latest row is still prepared (the DRAIN candidate for the recipient\'s next real wake)')
    assert.equal(rows.length, 4, 'the sidecar total is FLAT (4 seeded — the held pass appends NOTHING)')
    assert.ok(r.__calls.informs.some((l) => /m-4 → rx \(was prepared\) held gatedHeld/.test(l)), 'the hold log names the gatedHeld class')
    assert.deepEqual(r.sweepState(), {
      cycles: 1,
      lastCycleTs: T0,
      preparedStuckRemaining: 3, // m-1 (dormant-held) + m-2 (noWake-held) + m-4 (gatedHeld) — the by-design residue
      oldestPreparedTs: T0 - 40 * 60_000,
      dormantHeld: 1,
      noWakeHeld: 1,
      gatedHeld: 1
    }, 'the P4 honest summary discriminates ALL THREE held classes (m-3 fresh is NOT prepared-stuck — the criterion stays exact)')

    // The FRESH m-3 pair AGES past the prepared-stuck threshold and re-drives
    // NORMALLY on a later pass (the m-440 live queue is never lost); its
    // delivery UNGATES m-4, which re-drives genuinely in the SAME pass (the
    // FIFO progresses pair by pair — the sequence the drain exploits).
    await r.sweepDue(T0 + 700_000)
    rows = await readRows(stateDir)
    assert.deepEqual(r.__calls.deliver.map((d) => d.messageId), ['m-3', 'm-4'], 'the aged m-3 pair re-drove in seq order AND m-4\'s gate check then read m-3 delivered → unblocked → genuine re-drive in the SAME pass (the FIFO sequence unwinds)')
    assert.equal(countPair(rows, 'm-3', 'rx', 'delivered'), 1, 'm-3 delivered via the genuine re-drive (the m-440 fresh-live-queue contract)')
    assert.equal(countPair(rows, 'm-4', 'rx', 'delivered'), 1, 'm-4 delivered once its gating earlier pair resolved (never lost — the 2nd-half criterion keeps it a drain candidate)')
  })
})

test('w7-fb132 (iii-failsoft): a THROWING gate predicate only warns and proceeds gate-blind — the re-drive is never broken by the gate check', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      records: [record('m-1', 1, ['rx'])],
      rows: [row('m-1', 'rx', 'prepared', T0 - 40 * 60_000)]
    })
    const r = redeliverer(stateDir, {
      pendingEarlierSeq: async () => { throw new Error('gate read failed') }
    })
    r.__records('m-1', record('m-1', 1, ['rx']))
    await r.sweepDue(T0)
    assert.equal(r.__calls.deliver.length, 1, 'a throwing gate → the re-drive proceeds gate-blind (the ordering fix must never break a delivery — the fb-117 fail-soft contract, mirrored at the sweep)')
    assert.ok(r.__calls.warns.some((l) => /FIFO-gate check failed.*proceeds gate-blind/.test(l)), 'the gate failure is logged (warn)')
    const rows = await readRows(stateDir)
    assert.equal(await deliveryStatus(stateDir, 'm-1', 'rx'), 'delivered', 'the pair delivered (gate-blind)')
    const terminals = rows.filter((x) => x.messageId === 'm-1' && x.status === 'terminal')
    assert.equal(terminals.length, 1, 'the ONLY terminal is the G2 in-place wash of the aged seed — NOT a fb-132 settle mark')
    assert.equal(terminals[0].ts, T0 - 40 * 60_000, 'the washed row keeps its ORIGINAL ts (proving the fail-soft path appended NO fresh settle at pass time)')
  })
})

test('w7-fb132 (iii-g2): the G2 classification is UNCHANGED — the in-flight pair-latest stays keptInFlight (the re-drive owns it), and the final-row shadowed dust still settles (the wash path behind ANY final pair-latest)', () => {
  const T0 = 10_000_000
  // (a) TWO prepared rows of ONE ALIVE pair (the pair-latest + its shadowed
  // OLDER row — the attempt ledger): NEITHER is settled by G2 (keptInFlight
  // + keptFresh — the m-440/G2 contract: the re-drive owns the pair; with the
  // 2nd-half criterion these same rows ALSO stay for the drain candidates).
  const aliveRetrying = [
    row('m-1', 'rx', 'prepared', T0 - 5 * 60_000), // fresh — keptFresh
    row('m-1', 'rx', 'prepared', T0 - 40 * 60_000) // shadowed by the fresh one, alive pair — keptInFlight
  ]
  const cls = classifyG2LegacyRows(aliveRetrying, T0, 600_000, () => true)
  assert.equal(cls.keptFresh + cls.keptInFlight, 2, 'G2 never collapses an ALIVE retrying pair\'s rows (the attempt ledger + the in-flight latest stay)')
  assert.equal(cls.settleStaleDust.length + cls.settleDeadEnd.length, 0, 'no G2 settle fires for the alive pair')
  // (b) A DEAD-END pair whose latest is 'terminal' (the DEAD settle — the one
  // terminal the 2nd-half criterion keeps): the pair's OLD 'prepared' dust is
  // shadowed by the FINAL row → stale-dust → G2 washes it in place (the spool
  // collapse path the pre-fix deposit leaves behind a resolved pair).
  const afterSettle = [
    row('m-1', 'rx', 'prepared', T0 - 300 * 60_000),
    row('m-1', 'rx', 'terminal', 2_000)
  ]
  const cls2 = classifyG2LegacyRows(afterSettle, T0, 600_000, () => true)
  assert.deepEqual(cls2.settleStaleDust, [afterSettle[0]], 'the pair-latest \'terminal\' (a dead-end settle) turns the old prepared dust stale-dust → G2 washes it IN PLACE')
  assert.equal(cls2.keptInFlight + cls2.keptFresh, 0, 'no in-flight rows remain after the settle (the pair resolved terminal)')
})
// ---------------------------------------------------------------------------
// (iv) THE DRENADE-LANE ANCHOR (2026-09-10, run token 251c6342) — the noWake
// INTENT must survive the WHOLE path, not just the write-ahead row:
//   (a) the SEND of a FIFO-gated noWake writes TWO 'prepared' rows — the gate
//       branch (delivery.ts markFinal 'prepared') used to write the SECOND one
//       WITHOUT the flag, so the pair-LATEST of a deliberate noWake became
//       indistinguishable from a crash-class pair (the m-4547 defect);
//   (b) the RE-DRIVE (the seam `deps.deliver`) had NO channel to carry the
//       intent at all — drivePair/drainRecipientQueue re-marked 'prepared'
//       WITHOUT the flag over a pair that was noWake;
//   (c) the DRAIN at the recipient's next REAL wake re-drives the recorded pair
//       WITH the flag: the engine takes its noWake branch (skip as the ordered
//       no-wake), never the crash-class FIFO degradation.
//
// STATUS (2026-09-10, run token 251c6342 — the fix lane's own isolation run):
//   (iv-a) is ACTIVE and GREEN — it anchors the send-path fix (delivery.ts
//          markFinal 'prepared' in the FIFO-gate branch now passes `opts`).
//   (iv-b)/(iv-c) are `todo`: RED against the current tree, by DESIGN. They
//          pin the NEXT required contract — the re-drive intent channel — whose
//          implementation COLLIDES with two documented house contracts (the P2
//          live-splice exception and the O1/P1-EXT-EXT tool-level cases of
//          wake-seam-mitigation.test.js, which demand 'delivered' for a noWake
//          row of a LIVE/running recipient: passing the intent into the
//          engine's no-wave branch suppresses that splice — measured 12/2
//          red). Resolving the seal-vs-route conflation is an engine/
//          orchestration CONTRACT DECISION, reported by this lane, not taken
//          here. These two tests are written to go GREEN the moment that
//          decision lands; until then they must NOT be read as a regression.
// ---------------------------------------------------------------------------
test('w7-fb132 (iv-a): the SEND of a FIFO-gated noWake marks EVERY row it writes with noWake:true — the gate branch must not strip the intent (the pair-latest may not become crash-class)', async () => {
  await withTempStateDir(async (stateDir) => {
    const marks = []
    const deps = {
      stateDir,
      logger: { info: () => {}, warn: () => {} },
      markPrepared: async (record, recipientId, opts) => { marks.push({ status: 'prepared', opts }); return markDelivery(stateDir, record.id, recipientId, 'prepared', Date.now(), opts?.noWake === true) },
      markFinal: async (record, recipientId, status, opts) => { marks.push({ status, opts }); return markDelivery(stateDir, record.id, recipientId, status, Date.now(), opts?.noWake === true) },
      resolveChild: async () => false,
      deliverChild: async () => 'delivered',
      resolveCatalogRoute: () => ({ kind: 'post', entry: { postId: 'rx', sessionId: 'session-rx', retired: false } }),
      busProfileFor: () => ({ kind: 'post', memberId: 'rx' }),
      deliverPost: async () => 'prepared',
      deliverHost: async () => 'prepared',
      // The FIFO gate fires for m-9: its earlier pair m-8 is still 'prepared'.
      pendingEarlierSeq: async () => true,
      pendingEarlierSeqDetail: async () => 8,
      recipientMaterialized: () => true
    }
    const engine = createDeliveryEngine(deps)
    // The gating head (m-8) seeded as an EARLIER pending prepared pair.
    await markDelivery(stateDir, 'm-8', 'rx', 'prepared')
    const status = await engine.deliverOrQueue('rx', record('m-9', 9, ['rx']), { noWake: true })
    assert.equal(status, 'prepared', 'the FIFO-gated noWake degrades to the queue (\'prepared\') — it never wakes')
    const rows = (await readRows(stateDir)).filter((x) => x.messageId === 'm-9' && x.recipientId === 'rx')
    assert.equal(rows.length, 2, 'the gated send writes EXACTLY two rows (the write-ahead + the gate branch)')
    assert.equal(rows.filter((x) => x.noWake === true).length, 2, 'BOTH rows carry noWake:true — the gate branch (markFinal \'prepared\') must pass the intent exactly like the final mark of the normal branch')
    assert.equal(rows[rows.length - 1].noWake, true, 'the pair-LATEST (the row the re-drive discriminator reads) carries the flag')
    assert.equal(marks[marks.length - 1].opts?.noWake, true, 'the gate-branch markFinal received the noWake intent (the call-site contract)')
  })
})

test('w7-fb132 (iv-b) [TODO — blocked on the engine contract decision]: the RE-DRIVE seam CARRIES the intent — a noWake pair driven by drivePair re-marks its rows WITH the flag (and stays noWake on the pair-latest)', { todo: 'RED by design: the re-drive intent channel needs the engine seal-vs-route contract decision (see the (iv) header — 2 house contracts collide)' }, async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      records: [record('m-1', 1, ['rx'])],
      rows: [row('m-1', 'rx', 'prepared', T0 - 40 * 60_000, true)]
    })
    // The REAL-seam mimic (write-ahead 'prepared' → gate → final) + the intent
    // channel: the seam receives the row's intent and marks BOTH rows with it.
    const calls = { deliver: [], informs: [], warns: [] }
    const seam = async (rec, recipientId, callerSessionId, noWake) => {
      calls.deliver.push({ messageId: rec.id, recipientId, noWake })
      await markDelivery(stateDir, rec.id, recipientId, 'prepared', Date.now(), noWake === true)
      if (await makeGate(stateDir, new Map([['rx', [1]]]))(recipientId, rec.seq)) {
        await markDelivery(stateDir, rec.id, recipientId, 'prepared', Date.now(), noWake === true)
        return 'prepared'
      }
      await markDelivery(stateDir, rec.id, recipientId, 'delivered', Date.now(), noWake === true)
      return 'delivered'
    }
    const r = redeliverer(stateDir, {
      // P2 drain exception: the recipient is ALREADY running — no wake happens,
      // so the noWake pair is legally driven by the sweep.
      recipientRunning: () => true,
      deliver: seam
    })
    r.__records('m-1', record('m-1', 1, ['rx']))
    await r.sweepDue(T0)
    assert.equal(calls.deliver.length, 1, 'the noWake pair of a RUNNING recipient is genuinely re-driven (the P2 drain exception)')
    const rows = await readRows(stateDir)
    assert.equal(rows.filter((x) => x.messageId === 'm-1' && x.status !== 'terminal').length, 2, 'the genuine re-drive writes its write-ahead + final rows')
    assert.ok(rows.filter((x) => x.messageId === 'm-1' && x.status !== 'terminal').every((x) => x.noWake === true), 'BOTH re-drive rows keep noWake:true — the seam must carry the intent, never re-mark the pair crash-class')
    assert.equal(await deliveryStatus(stateDir, 'm-1', 'rx'), 'delivered', 'the pair lands delivered')
    assert.equal(rows.filter((x) => x.noWake === true).length, 3, 'the seeded write-ahead + the two re-drive rows all carry the flag (the original intent is never lost across the re-drive)')
  })
})

test('w7-fb132 (iv-c) [TODO — blocked on the engine contract decision]: the DRAIN at the recipient\'s next REAL wake re-drives the recorded noWake pair WITH the flag — the engine takes its ORDERED no-wake branch, never the crash-class FIFO degradation', { todo: 'RED by design: same blocked contract as (iv-b) — the drain forwards no intent until the seal-vs-route conflation is resolved' }, async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      records: [record('m-1', 1, ['rx']), record('m-2', 2, ['rx'])],
      // BOTH pairs hold a 'prepared' ledger row — `pendingForRecipient` derives
      // the drain candidates FROM the sidecar rows (a pair with no row is not a
      // candidate), exactly like the live m-4547 pair.
      rows: [
        row('m-1', 'rx', 'prepared', T0 - 40 * 60_000, true),
        row('m-2', 'rx', 'prepared', T0 - 20 * 60_000, true)
      ]
    })
    const calls = { deliver: [], informs: [], warns: [] }
    const seam = async (rec, recipientId, callerSessionId, noWake) => {
      calls.deliver.push({ messageId: rec.id, recipientId, noWake })
      await markDelivery(stateDir, rec.id, recipientId, 'prepared', Date.now(), noWake === true)
      await markDelivery(stateDir, rec.id, recipientId, 'delivered', Date.now(), noWake === true)
      return 'delivered'
    }
    const r = redeliverer(stateDir, { deliver: seam })
    r.__records('m-1', record('m-1', 1, ['rx']))
    r.__records('m-2', record('m-2', 2, ['rx']))
    // The drain is the wake primitive's own fire — it consults NO liveness
    // guard (the wake that just happened IS the liveness).
    assert.equal(await r.drainRecipientQueue('rx'), 2, 'the drain re-drives BOTH pairs in FIFO order (m-1 head-first, then m-2)')
    const rows = await readRows(stateDir)
    const preparedRows = rows.filter((x) => x.status !== 'terminal')
    assert.equal(preparedRows.filter((x) => x.messageId === 'm-2').length, 3, 'the drained m-2 pair keeps its ORIGINAL write-ahead row (the send that parked it) + gains the re-drive\'s write-ahead + its final row')
    assert.equal(preparedRows.filter((x) => x.messageId === 'm-2').every((x) => x.noWake === true), true, 'the m-2 pair re-driven by the DRAIN keeps noWake:true end-to-end — EVERY row it owns')
    assert.equal(rows.filter((x) => x.noWake === true).length, 6, 'the whole path is flagged: the 2 seeded write-ahead rows + 2 m-1 drain rows + 2 m-2 drain rows (the intent survives send AND re-drive AND drain)')
    assert.equal(await deliveryStatus(stateDir, 'm-2', 'rx'), 'delivered', 'the drained pair lands delivered')
  })
})
