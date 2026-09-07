// dsh-deepartments — FB-132 WAKE-ON-DELIVERED (2026-09-06, the 2nd-half
// drain-on-wake lane; run token 857d35a6): `drainRecipientQueue` — the
// primitive that finally honors the documented «drains at its next REAL wake»
// contract (messages.ts:1050/:1264/:1314/:1559, tools.ts:5124, dshd-health
// :4326/:4368 — today 100% documentary, the m-1933 family: a no-wake ACK
// 'prepared' at the FIFO head blocked the whole host queue for HOURS because
// NO wake scans the sidecar) + the fire points (busDeliverToPost /
// busDeliverToHost success + the rotation wake) + the 2nd-half sweep criterion
// (a gated pair of an ALIVE recipient is now SKIPPED — no 'terminal' settle,
// which would LOSE the pair for a recipient whose next real wake can drain it
// — and counted in the new P4 class `gatedHeld`).
//
//   MECHANISM: the FIFO-gate degrades any later send to 'prepared' without a
//       wake (delivery.ts:313-314); the sweep historically skipped the queue
//       (B3 dormancy / P2 noWake guards) and the fb-132 v1 settle would have
//       TERMINALIZED alive pairs; NOTHING drained on a real wake. The lane
//       adds: (1) `DeliveryRedeliverer.drainRecipientQueue(recipientId, cap)`
//       — the pair-latest 'prepared' rows of the recipient, STRICT FIFO by seq,
//       re-driven head-first through the deliver seam (a landing delivered/
//       resumed unblocks the next; a failure STOPS; bounded cap 25;
//       re-entrancy-guarded; liveness-authoritative — NEVER consults dormancy);
//       (2) fire-and-forget fires at the three REAL-wake success seams;
//       (3) the sweep criterion: gated + alive → skip + count `gatedHeld`
//       (dead settle unchanged).
//   TESTS (the lane design §5): d1 pure candidate selection · d2 the m-1933
//       integration (noWake head + 3 gated → ONE drain delivers all four in
//       seq order; sidecar final 'delivered' per pair, 0 'terminal') · d3 a
//       failed 2nd pair STOPS the FIFO · d4 cap bounds a backlog · d5 the
//       re-entrancy guard (a drained delivery's own wake re-fires → no-op) ·
//       d6 empty/final queue → byte-identical no-op · d7 the ALTO-1 rebind
//       guard · d8 per-recipient scoping (the wake of A never drains B) · d9 a
//       'failed' pair is never accelerated · g1 the 2nd-half criterion (dead
//       settles terminal, alive gated stays prepared + gatedHeld) · g2 the
//       gatedHeld datum is never synthesized · c1 the COMPOSED fire: a REAL
//       wake through the bundle's busDeliverToPost drains the queued messages
//       in the same instant.
// All src-native (0 real APIs; temp stateDir + stub deps; the composed test
// boots the bundle SRC with stub agents/workspace — the wakeseam-lane pattern).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  DeliveryRedeliverer,
  markDelivery,
  parseDeliveryRows,
  resolveDeliveriesPath,
  resolveMessagesPath,
  hasEarlierPendingPair,
  pendingForRecipient,
  DRAIN_RECIPIENT_QUEUE_DEFAULT_CAP,
  deliveryStatus
} from '../packages/dshd-core/src/messages.ts'

// ---------------------------------------------------------------------------
// Shared helpers: temp stateDir + the lane2-style redeliverer stub harness.
// ---------------------------------------------------------------------------
async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb132-drain-'))
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

/** A deliver stub that MIMICS the REAL seam (deliverOrQueue): the write-ahead
 * 'prepared', then the FIFO gate (an earlier pending pair → queued BEHIND as a
 * SECOND fresh 'prepared' — the delivery.ts:271/:313-314 mechanism), else the
 * final 'delivered'. The drain's sequential awaits re-read the CURRENT sidecar
 * per pair, so the gate opens pair by pair exactly like the live engine. */
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
 * `calls` object is exposed on the instance (r.__calls); the `deliver`
 * override lets a test control the per-pair landing (failed on the 2nd pair,
 * re-entrant fires, ALTO-1 stale heads, …). */
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

// ===========================================================================
// d1 — the PURE candidate selection (design §5.1).
// ===========================================================================
test('fb132-drain (d1): pendingForRecipient returns ONLY the pair-latest \'prepared\' rows of ONE recipient, STRICT FIFO by seq — dust/shadowed/failed/self/terminal/delivered excluded', () => {
  const T0 = 10_000_000
  const rows = [
    // rx — a full mixed ledger:
    row('m-3', 'rx', 'prepared', T0), // pair-latest prepared (candidate)
    row('m-2', 'rx', 'prepared', T0), // pair-latest prepared (candidate)
    row('m-1', 'rx', 'prepared', T0 - 200), // dust of m-1 (shadowed by its later delivered — NOT a candidate)
    row('m-1', 'rx', 'delivered', T0), // m-1 pair-latest delivered (settled)
    row('m-4', 'rx', 'failed', T0), // a FAILED pair — NEVER a drain candidate (the backoff domain)
    row('m-5', 'rx', 'prepared', T0, true), // noWake prepared (candidate — the drain is liveness-authoritative)
    row('m-6', 'rx', 'prepared', T0), // self pair (recipient === from; still 'prepared' → candidate — the drain drives the self hold like any head pair)
    row('m-7', 'rx', 'terminal', T0), // terminal — settled
    row('m-8', 'rx', 'prepared', T0 - 100), // dust of m-8 (shadowed by the later resumed final — NOT a candidate)
    row('m-8', 'rx', 'resumed', T0), // resumed — settled (the pair-latest)
    // Other recipients — NEVER candidates:
    row('m-9', 'other', 'prepared', T0),
    row('m-10', 'other2', 'prepared', T0)
  ]
  const pending = pendingForRecipient(rows, 'rx')
  assert.deepEqual(pending.map((r) => r.messageId), ['m-2', 'm-3', 'm-5', 'm-6'], 'the candidates are ONLY the pair-latest prepared rows of rx, sorted by seq asc (FIFO head-first); failed/terminal/delivered/resumed/dust/other-recipient excluded')
  assert.ok(pending.every((r) => r.recipientId === 'rx' && r.status === 'prepared'), 'every candidate is a prepared pair-latest of rx')
  // Legacy non-parseable ids fall back to their ts (the stable FIFO substitute):
  const legacy = [row('legacy-a', 'rx', 'prepared', 5), row('legacy-b', 'rx', 'prepared', 2)]
  assert.deepEqual(pendingForRecipient(legacy, 'rx').map((r) => r.messageId), ['legacy-b', 'legacy-a'], 'a non-parseable id sorts by its row ts (the sweep\'s stable substitute)')
})

// ===========================================================================
// d2 — the m-1933 INTEGRATION: a noWake head pair + 3 FIFO-gated pairs drain
// head-first at the recipient's real wake, through the REAL seam.
// ===========================================================================
test('fb132-drain (d2): the m-1933 family — a noWake \'prepared\' head pair + 3 FIFO-gated pairs drain in SEQUENCE at the real wake (the drain drives the seam with noWake:false; each landing unblocks the next; the sidecar ends \'delivered\' per pair, 0 \'terminal\')', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const seqsByRecipient = new Map([['rx', [1, 2, 3, 4]]])
    const gate = makeGate(stateDir, seqsByRecipient)
    await seed(stateDir, {
      records: [1, 2, 3, 4].map((seq) => record(`m-${seq}`, seq, ['rx'])),
      rows: [
        row('m-1', 'rx', 'prepared', T0 - 40 * 60_000, true), // the noWake ACK head (the m-1933 class)
        ...[2, 3, 4].map((seq) => row(`m-${seq}`, 'rx', 'prepared', T0 - 39 * 60_000)) // 3 FIFO-gated behind it
      ]
    })
    const r = redeliverer(stateDir, { gate, pendingEarlierSeq: gate })
    for (const seq of [1, 2, 3, 4]) r.__records(`m-${seq}`, record(`m-${seq}`, seq, ['rx']))

    // The queue is STUCK before the wake (the pre-fix reality): the sweep
    // holds everything (m-1 P2 noWake-held; m-2/3/4 gated behind it).
    await r.sweepDue(T0 + 2 * 60_000)
    assert.equal(r.__calls.deliver.length, 0, 'pre-fix: the sweep does NOT drain the queue (P2 holds the noWake head; the gated rows are skipped per the 2nd-half criterion)')
    assert.equal(await deliveryStatus(stateDir, 'm-1', 'rx'), 'prepared', 'pre-fix: m-1 stays prepared (noWake-until-wake)')
    assert.equal(await deliveryStatus(stateDir, 'm-4', 'rx'), 'prepared', 'pre-fix: m-4 stays prepared (FIFO-gated)')

    // THE REAL WAKE — the recipient is materialized, the wake primitive fires
    // drainRecipientQueue('rx') (fire-and-forget). The queue must drain IN THE
    // SAME INSTANT, head-first by seq, each landing unblocking the next.
    const drained = await r.drainRecipientQueue('rx')
    assert.equal(drained, 4, 'all four pairs drained in ONE invocation (the cap 25 is not hit)')
    assert.deepEqual(r.__calls.deliver.map((d) => d.messageId), ['m-1', 'm-2', 'm-3', 'm-4'], 'the deliver seam was reached STRICTLY in seq order (FIFO head-first)')
    for (const seq of [1, 2, 3, 4]) {
      assert.equal(await deliveryStatus(stateDir, `m-${seq}`, 'rx'), 'delivered', `m-${seq} ends delivered (the queue resolved — never terminal, never lost)`)
    }
    const rows = await readRows(stateDir)
    assert.equal(rows.filter((x) => x.status === 'terminal').length, 0, 'ZERO terminal rows (the drain delivers; only the sweep settles dead ends)')
    assert.equal(rows.filter((x) => x.status === 'prepared').length, 8, 'the prepared rows are the shadowed WRITE-AHEAD MARKS only (4 seeded + 4 seam write-aheads - dust behind a delivered latest, the same shape a LIVE delivery leaves)')
    assert.equal(rows.filter((x) => x.status === 'delivered').length, 4, 'every drained pair finalizes delivered')
  })
})

// ===========================================================================
// d3 — a failure STOPS the FIFO (the drain never skips).
// ===========================================================================
test('fb132-drain (d3): a \'failed\' landing on the 2nd pair STOPS the drain — the 3rd/4th stay \'prepared\' (the FIFO never jumps; the remainder waits for the next wake/sweep)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const seqsByRecipient = new Map([['rx', [1, 2, 3, 4]]])
    const gate = makeGate(stateDir, seqsByRecipient)
    await seed(stateDir, {
      records: [1, 2, 3, 4].map((seq) => record(`m-${seq}`, seq, ['rx'])),
      rows: [1, 2, 3, 4].map((seq) => row(`m-${seq}`, 'rx', 'prepared', T0 - 40 * 60_000))
    })
    const calls = { deliver: [], informs: [], warns: [] }
    const recordsById = new Map([1, 2, 3, 4].map((seq) => [`m-${seq}`, record(`m-${seq}`, seq, ['rx'])]))
    const r = new DeliveryRedeliverer({
      stateDir,
      logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
      recipientAlive: () => true,
      recipientDormant: () => false,
      recipientRunning: () => false,
      getRecord: async (id) => (recordsById.get(id) ?? undefined),
      resolveCallerSessionId: (from) => from,
      deliver: async (rec, recipientId) => {
        calls.deliver.push({ messageId: rec.id, recipientId })
        await markDelivery(stateDir, rec.id, recipientId, rec.id === 'm-2' ? 'failed' : 'delivered')
        return rec.id === 'm-2' ? 'failed' : 'delivered'
      }
    }, { preparedStuckMs: 600_000, legacyAgeMs: 600_000 })
    r.__calls = calls

    const drained = await r.drainRecipientQueue('rx')
    assert.equal(drained, 2, 'exactly TWO pairs were driven (m-1 delivered → continue; m-2 failed → STOP)')
    assert.deepEqual(calls.deliver.map((d) => d.messageId), ['m-1', 'm-2'], 'the FIFO stopped at the failure — m-3/m-4 were NEVER attempted (no skip)')
    assert.equal(await deliveryStatus(stateDir, 'm-3', 'rx'), 'prepared', 'm-3 stays prepared (the remainder waits for the next wake/sweep)')
    assert.equal(await deliveryStatus(stateDir, 'm-4', 'rx'), 'prepared', 'm-4 stays prepared')
  })
})

// ===========================================================================
// d4 — the cap bounds a backlog (the wake-storm mitigation, R3).
// ===========================================================================
test('fb132-drain (d4): cap bounds ONE invocation — cap=2 drains 2 pairs, the rest stay \'prepared\' for the NEXT wake (the wake-storm guard of a large backlog)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const seqs = [1, 2, 3, 4]
    const seqsByRecipient = new Map([['rx', seqs]])
    const gate = makeGate(stateDir, seqsByRecipient)
    await seed(stateDir, {
      records: seqs.map((seq) => record(`m-${seq}`, seq, ['rx'])),
      rows: seqs.map((seq) => row(`m-${seq}`, 'rx', 'prepared', T0 - 40 * 60_000))
    })
    const r = redeliverer(stateDir, { gate })
    for (const seq of seqs) r.__records(`m-${seq}`, record(`m-${seq}`, seq, ['rx']))

    const drained = await r.drainRecipientQueue('rx', 2)
    assert.equal(drained, 2, 'cap=2 → exactly 2 pairs drained')
    assert.deepEqual(r.__calls.deliver.map((d) => d.messageId), ['m-1', 'm-2'], 'the FIRST two (FIFO head) drained')
    assert.equal(await deliveryStatus(stateDir, 'm-3', 'rx'), 'prepared', 'm-3 stays prepared (the remanente)')
    assert.equal(await deliveryStatus(stateDir, 'm-4', 'rx'), 'prepared', 'm-4 stays prepared')
    // The next wake drains the rest:
    assert.equal(await r.drainRecipientQueue('rx', 2), 2, 'a second invocation drains the next cap')
    assert.equal(await deliveryStatus(stateDir, 'm-4', 'rx'), 'delivered', 'm-4 delivered on the second wake')
  })
})

// ===========================================================================
// d5 — the re-entrancy guard (R1: drain → deliver → wake → drain recursion).
// ===========================================================================
test('fb132-drain (d5): a deliver that RE-FIRES the drain of the SAME recipient is a NO-OP (the re-entrancy guard) — the queue is driven exactly ONCE per wake, no recursion', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      records: [1, 2].map((seq) => record(`m-${seq}`, seq, ['rx'])),
      rows: [1, 2].map((seq) => row(`m-${seq}`, 'rx', 'prepared', T0 - 40 * 60_000))
    })
    let innerDrains = []
    const calls = { deliver: [], informs: [], warns: [] }
    const recordsById = new Map([1, 2].map((seq) => [`m-${seq}`, record(`m-${seq}`, seq, ['rx'])]))
    let r
    r = new DeliveryRedeliverer({
      stateDir,
      logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
      recipientAlive: () => true,
      recipientDormant: () => false,
      recipientRunning: () => false,
      getRecord: async (id) => (recordsById.get(id) ?? undefined),
      resolveCallerSessionId: (from) => from,
      deliver: async (rec, recipientId) => {
        calls.deliver.push({ messageId: rec.id, recipientId })
        // The drained delivery's own wake re-fires the drain (the recursion
        // the guard exists for) — SYNCHRONOUS inside the landing:
        innerDrains.push(await r.drainRecipientQueue(recipientId))
        await markDelivery(stateDir, rec.id, recipientId, 'delivered')
        return 'delivered'
      }
    }, { preparedStuckMs: 600_000, legacyAgeMs: 600_000 })
    r.__calls = calls

    const drained = await r.drainRecipientQueue('rx')
    assert.equal(drained, 2, 'the outer drain drove both pairs')
    assert.deepEqual(innerDrains, [0, 0], 'EVERY re-entrant fire returned 0 (the recipient was already mid-drain — no recursion, no double-drive)')
    assert.equal(calls.deliver.length, 2, 'the deliver seam was reached exactly ONCE per pair (2 total — the guard never re-entered the loop)')
    assert.equal(await deliveryStatus(stateDir, 'm-2', 'rx'), 'delivered', 'the pair resolved normally')
  })
})

// ===========================================================================
// d6 — an empty / already-final queue fires a pure no-op (byte-identical).
// ===========================================================================
test('fb132-drain (d6): a wake of a recipient with NO pending queue is a byte-identical NO-OP (0 drained, 0 rows written) — a normal send to a healthy recipient is never disturbed', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      records: [record('m-1', 1, ['rx']), record('m-2', 2, ['other'])],
      rows: [row('m-1', 'rx', 'delivered', T0), row('m-2', 'other', 'prepared', T0)]
    })
    const before = await readFile(resolveDeliveriesPath(stateDir), 'utf8')
    const r = redeliverer(stateDir)
    r.__records('m-1', record('m-1', 1, ['rx']))
    assert.equal(await r.drainRecipientQueue('rx'), 0, 'an already-delivered queue drains 0')
    const after = await readFile(resolveDeliveriesPath(stateDir), 'utf8')
    assert.equal(after, before, 'the sidecar is BYTE-IDENTICAL (a no-op drain writes nothing — the send normal is never disturbed)')
    assert.equal(r.__calls.deliver.length, 0, 'the deliver seam was never reached')
  })
})

// ===========================================================================
// d7 — the ALTO-1 rebind guard (a stale row stops the FIFO).
// ===========================================================================
test('fb132-drain (d7): ALTO-1 rebind guard — a candidate whose CURRENT record is trimmed / never addressed the recipient is SKIPPED and the drain STOPS (the FIFO cannot jump a stale head)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      records: [record('m-1', 1, ['rx']), record('m-2', 2, ['rx'])],
      rows: [
        row('m-1', 'rx', 'prepared', T0 - 40 * 60_000), // stale: record trimmed (never seeded)
        row('m-2', 'rx', 'prepared', T0 - 40 * 60_000)
      ]
    })
    const r = redeliverer(stateDir)
    r.__records('m-2', record('m-2', 2, ['rx'])) // ONLY m-2's CURRENT record exists
    const drained = await r.drainRecipientQueue('rx')
    assert.equal(drained, 0, 'nothing drained — m-1 (stale head) stopped the FIFO before m-2')
    assert.equal(r.__calls.deliver.length, 0, 'm-2 was NEVER delivered (the FIFO does not jump the stale head)')
    assert.equal(await deliveryStatus(stateDir, 'm-2', 'rx'), 'prepared', 'm-2 stays prepared (waits for the next wake/sweep — the ALTO-1 warning fired)')
  })
})

// ===========================================================================
// d8 — per-recipient scoping (a wake of A never drains B).
// ===========================================================================
test('fb132-drain (d8): the drain is PER-RECIPIENT — the wake of A drains ONLY A\'s queue; B\'s pending pairs are untouched', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      records: [record('m-1', 1, ['a']), record('m-2', 2, ['b'])],
      rows: [row('m-1', 'a', 'prepared', T0 - 40 * 60_000), row('m-2', 'b', 'prepared', T0 - 40 * 60_000)]
    })
    const r = redeliverer(stateDir)
    r.__records('m-1', record('m-1', 1, ['a']))
    r.__records('m-2', record('m-2', 2, ['b']))
    assert.equal(await r.drainRecipientQueue('a'), 1, 'A\'s wake drained exactly A\'s pair')
    assert.deepEqual(r.__calls.deliver.map((d) => d.recipientId), ['a'], 'the deliver seam saw ONLY A')
    assert.equal(await deliveryStatus(stateDir, 'm-2', 'b'), 'prepared', 'B\'s pair is UNTOUCHED (it waits for B\'s OWN wake)')
  })
})

// ===========================================================================
// d9 — a 'failed' pair is never accelerated by the drain (backoff domain).
// ===========================================================================
test('fb132-drain (d9): a \'failed\' pair is NEVER a drain candidate — the drain drives ONLY the \'prepared\' pairs (the failed pair stays on the sweep\'s per-pair backoff)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      records: [record('m-1', 1, ['rx']), record('m-2', 2, ['rx'])],
      rows: [row('m-1', 'rx', 'failed', T0 - 40 * 60_000), row('m-2', 'rx', 'prepared', T0 - 40 * 60_000)]
    })
    const r = redeliverer(stateDir)
    r.__records('m-1', record('m-1', 1, ['rx']))
    r.__records('m-2', record('m-2', 2, ['rx']))
    assert.equal(await r.drainRecipientQueue('rx'), 1, 'only the PREPARED pair drained (m-2)')
    assert.deepEqual(r.__calls.deliver.map((d) => d.messageId), ['m-2'], 'the failed pair was never driven (the drain does not accelerate failures)')
    assert.equal(await deliveryStatus(stateDir, 'm-1', 'rx'), 'failed', 'm-1 stays failed (the sweep backoff owns it)')
  })
})

// ===========================================================================
// g1 — the 2nd-half sweep criterion: DEAD settles terminal (unchanged), ALIVE
// gated stays 'prepared' + counted gatedHeld.
// ===========================================================================
test('fb132-drain (g1): the 2nd-half criterion — a DUE gated pair of a DEAD recipient still settles \'terminal\' (unchanged); a DUE gated pair of an ALIVE recipient is HELD (stays \'prepared\', counted gatedHeld); `drainRecipientQueue` then delivers BOTH (the alive one at its real wake)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const seqsByRecipient = new Map([['alive', [1, 2]], ['dead-rx', [3]]])
    const gate = makeGate(stateDir, seqsByRecipient)
    await seed(stateDir, {
      records: [
        record('m-1', 1, ['alive']), record('m-2', 2, ['alive']),
        record('m-3', 3, ['dead-rx'])
      ],
      rows: [
        row('m-1', 'alive', 'prepared', T0 - 40 * 60_000, true), // gating head (P2-held)
        row('m-2', 'alive', 'prepared', T0 - 40 * 60_000), // gated ALIVE (held, never settled)
        row('m-3', 'dead-rx', 'prepared', T0 - 40 * 60_000) // gated DEAD — settled terminal
      ]
    })
    const r = redeliverer(stateDir, {
      recipientAlive: (id) => id !== 'dead-rx',
      pendingEarlierSeq: gate
    })
    r.__records('m-1', record('m-1', 1, ['alive']))
    r.__records('m-2', record('m-2', 2, ['alive']))
    r.__records('m-3', record('m-3', 3, ['dead-rx']))

    await r.sweepDue(T0)
    // The DEAD settle is UNCHANGED (a dead recipient is never worth keeping):
    assert.equal(await deliveryStatus(stateDir, 'm-3', 'dead-rx'), 'terminal', 'the gated pair of a DEAD recipient still settles terminal (the dead settle precedes the gate branch — untouched)')
    // The ALIVE gated pair is HELD (2nd-half: a settle would lose it):
    assert.equal(await deliveryStatus(stateDir, 'm-2', 'alive'), 'prepared', 'the gated ALIVE pair stays prepared (held — a DRAIN candidate, never settled)')
    assert.equal(r.__calls.deliver.length, 0, 'no deliver in the sweep pass')
    assert.deepEqual(r.sweepState(), {
      cycles: 1,
      lastCycleTs: T0,
      preparedStuckRemaining: 2, // m-1 (P2-held head) + m-2 (gatedHeld)
      oldestPreparedTs: T0 - 40 * 60_000,
      dormantHeld: 0,
      noWakeHeld: 1,
      gatedHeld: 1
    }, 'gatedHeld reports the held ALIVE pair; the dead pair (settled terminal) is not in the residue')
    // The alive queue is NOT lost — the recipient's real wake drains it:
    assert.equal(await r.drainRecipientQueue('alive'), 2, 'the real wake of the alive recipient drains BOTH its pairs (the noWake head first — the FIFO unwinds)')
  })
})

// ===========================================================================
// g2 — the gatedHeld datum is never synthesized (P4 honesty).
// ===========================================================================
test('fb132-drain (g2): gatedHeld is NEVER synthesized — ABSENT before the first sweep cycle, present once a cycle computed it (the P4 never-synthesized rule)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const r = redeliverer(stateDir)
    assert.ok(!('gatedHeld' in r.sweepState()), 'pre-first-cycle: gatedHeld is ABSENT (a never-observed class is never guessed)')
    await seed(stateDir, {
      records: [record('m-1', 1, ['rx'])],
      rows: [row('m-1', 'rx', 'prepared', T0 - 40 * 60_000, true)]
    })
    const r2 = redeliverer(stateDir, { pendingEarlierSeq: async () => false })
    r2.__records('m-1', record('m-1', 1, ['rx']))
    await r2.sweepDue(T0)
    assert.equal(r2.sweepState().gatedHeld, 0, 'after a cycle: gatedHeld is PRESENT (the honest 0 — no gated pair)')
  })
})

// ===========================================================================
// c1 — the COMPOSED FIRE: a REAL wake through the bundle's busDeliverToPost
// fires the drain — the queued noWake/gated messages land in the SAME instant.
// Boots the bundle SRC with stub agents/workspace (the wakeseam-lane harness
// pattern); the fire hook must be wired (invoke.ts deliveryDeps →
// toolsSurface.redeliverDrainQueue) for the drain to fire.
// ===========================================================================
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLE_SRC = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href

process.env.DEEPARTMENTS_QUALITY_INSPECT = '1' // the worker-retire QD dice stays DETERMINISTIC

async function bootPluginFromSrc(stateDir, org) {
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const { SubagentRuntime } = await import('@deepseek-ai/dsh-subagent')
  const postAdoption = new Map()
  class StubAgents extends Service {
    constructor(ctx) { super(ctx, 'agents'); this.store = new Map(); this.childContexts = []; this.childAgents = []; this.scopeAnchor = ctx; this.createCalls = []; this.resumeCalls = []; this.disposeCalls = new Map() }
    get(id) { return this.store.get(id) }
    list() { return [...this.store.values()] }
    roots() { return [...this.store.values()] }
    async create(options) { this.createCalls.push(options); return materializeStubAgent(this, options.sessionId, options) }
    async resume(options) { this.resumeCalls.push(options); return materializeStubAgent(this, options.resumeSessionId, { ...options, parentSession: postAdoption.get(options.resumeSessionId) }) }
  }
  const materializeStubAgent = async (agents, sessionId, options) => {
    const callerSignal = options.signal
    let callerSignalAborted = false
    callerSignal?.addEventListener('abort', () => { callerSignalAborted = true }, { once: true })
    const parentSession = options.parentSession ?? options.meta?.parentSession
    const agent = {
      id: sessionId,
      options: options.agentOptions ?? {},
      status: 'idle',
      session: {
        header: { id: sessionId, parentSession, delegationDepth: options.meta?.delegationDepth },
        events: [],
        get seq() { return this.events.length },
        snapshotEvents() { return this.events },
        requestHeader() { return undefined }
      },
      inboxMessages: [],
      ctx: undefined,
      callerSignalAborted: () => callerSignalAborted,
      followup(message) { this.inboxMessages.push(message) },
      steer() {}, inject() {}, send() {},
      cancelCalls: [],
      cancel() {},
      whenIdle() { return new Promise(() => {}) }
    }
    const childKey = Symbol('fb132-drain-child-scope')
    const scope = createScope(agents.scopeAnchor, childKey)
    const childCtx = scope.ctx.extend({ agent })
    agent.ctx = childCtx
    agents.childContexts.push({ ctx: childCtx, key: childKey })
    agents.childAgents.push(agent)
    const provision = await options.setup?.(childCtx)
    provision?.commit?.()
    agents.store.set(sessionId, agent)
    return { agent, dispose: async () => {
      agents.disposeCalls.set(sessionId, (agents.disposeCalls.get(sessionId) ?? 0) + 1)
      agents.store.delete(sessionId)
    } }
  }
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  const agents = new StubAgents(root)
  const persistence = new (class extends Service {
    constructor(ctx) { super(ctx, 'sessionPersistence') }
    async readRaw() { return undefined }
  })(root)
  const stateHome = path.join(stateDir, 'ws')
  await root.plugin(SubagentRuntime)
  root.subagents.registerProvider({ name: 'spawn', capabilities: {}, inheritsParentContext: false, async start() { throw new Error('stub') }, async prepareContinuable() { return { seed: [] } } })
  loader.create({ id: 'deepartments', name: BUNDLE_SRC, config: { stateDir, org } })
  await loader.await()
  agents.scopeAnchor = loader.resolve('deepartments').fiber?.ctx ?? root
  void persistence; void stateHome
  return { root, agents, pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx, dispose: () => loaderFiber.dispose() }
}

function childContextFor(agents, sessionId) {
  const index = agents.childAgents.findIndex((agent) => agent && agent.id === sessionId)
  if (index < 0) return undefined
  return { ctx: agents.childContexts[index].ctx, key: agents.childContexts[index].key }
}

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('fb132-drain (c1): a REAL wake through the bundle fires the drain — a noWake send + 3 FIFO-gated sends to a worker drain IN THE SAME INSTANT a genuine wake lands (the worker inbox receives all four in seq order; the sidecar ends \'delivered\' per pair)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb132-drain-c1-'))
  const org = {
    departments: [
      {
        id: 'research',
        name: 'Research',
        coordinator: { postId: 'research-head', role: 'Research department head', provider: 'deepseek-official', agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' } }
      }
    ]
  }
  const env = await bootPluginFromSrc(stateDir, org)
  try {
    await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
    const head = env.agents.store.get('head-research-head')
    const headCtx = childContextFor(env.agents, 'head-research-head')
    assert.ok(headCtx, 'the head own-layer context resolves')
    const signal = new AbortController().signal
    const spawn = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'drain lane worker' }, { agent: head, signal })
    assert.ok(spawn.workerId, 'the worker spawned')
    await waitFor(() => env.agents.store.has(spawn.sessionId), 8000, 'the worker is live')
    const workerId = spawn.workerId
    const worker = env.agents.store.get(spawn.sessionId)
    const send = (extra) => headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: [workerId], text: `drain probe ${JSON.stringify(extra)}`, ...extra }, { agent: head, signal })
    const baselineInbox = worker.inboxMessages.length

    // (1) A NO-WAKE send (the m-1933 class) → 'prepared (noWake)' — nothing wakes.
    const noWakeRes = await send({ noWake: true })
    assert.equal(noWakeRes.delivered[workerId], 'prepared (noWake)', 'the noWake send queues without waking')
    // (2) THREE normal sends — all FIFO-gated behind the pending noWake pair.
    for (let i = 0; i < 3; i++) {
      const gated = await send({})
      assert.match(gated.delivered[workerId], /^prepared \(fifo-gated tras m-\d+\)$/, `send ${i + 2} is FIFO-gated`)
    }
    assert.equal(env.agents.store.get(spawn.sessionId).inboxMessages.length, baselineInbox, 'nothing splices before a REAL wake (the queue is fully parked)')
    const parked = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    const parkedPrepared = parked.filter((x) => x.recipientId === workerId && x.status === 'prepared').length
    // The m-1933 state: the PAIR-LATEST of m-1..m-4 is 'prepared' (pending);
    // the spawn's m-0 pair-latest is 'delivered' (resolved — only its
    // write-ahead 'prepared' dust lingers).
    const parkedLatest = new Map()
    for (const r of parked) if (r.recipientId === workerId) parkedLatest.set(r.messageId, r.status)
    assert.equal(parkedLatest.get('m-0'), 'delivered', 'the spawns first-message pair is RESOLVED (delivered)')
    assert.deepEqual(['m-1', 'm-2', 'm-3', 'm-4'].map((id) => parkedLatest.get(id)), ['prepared', 'prepared', 'prepared', 'prepared'], 'the m-1933 state: EXACTLY the 4 parked pairs are pending prepared (pair-latest)')

    // (3) A REAL WAKE — interrupt bypasses the gate, materializes the worker,
    // and the busDeliverToPost SUCCESS seam fires the drain: the 4 parked
    // messages must land IN THE SAME INSTANT, in seq order.
    const wakeRes = await send({ interrupt: true })
    assert.equal(wakeRes.delivered[workerId], 'delivered', 'the interrupt send delivers (the real wake)')
    await waitFor(async () => {
      const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
      const latest = new Map()
      for (const r of rows) latest.set(`${r.messageId}\u0000${r.recipientId}`, r)
      const workerPairs = [...latest.values()].filter((r) => r.recipientId === workerId)
      return workerPairs.length >= 4 && workerPairs.every((r) => r.status === 'delivered')
    }, 8000, 'the queue drains (all 4 pairs delivered)')
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    const latest = new Map()
    for (const r of rows) latest.set(`${r.messageId}\u0000${r.recipientId}`, r)
    const workerLatest = [...latest.values()].filter((r) => r.recipientId === workerId)
    assert.ok(workerLatest.every((r) => r.status === 'delivered'), 'the parked queue ends delivered per pair — the wake drained it (no terminal, no loss)')
    assert.ok(workerLatest.every((r) => r.status !== 'terminal'), 'zero terminal rows for the worker')
    const inbox = env.agents.store.get(spawn.sessionId).inboxMessages
    const splicedTexts = inbox.slice(baselineInbox).map((m) => (Array.isArray(m?.content) ? m.content.map((c) => c.text ?? '').join(' ') : JSON.stringify(m))).join('\n')
    assert.ok(inbox.length >= baselineInbox + 5, `the worker inbox received the 4 parked + the wake message (${inbox.length} >= ${baselineInbox + 5})`)
    // The parked noWake message itself landed (the drain drives noWake:false —
    // the recipient is ALREADY live, zero new materialization):
    assert.ok(splicedTexts.includes('drain probe {"noWake":true}'), 'the parked noWake message text is in the worker inbox (the no-wake-until-wake contract fulfilled at the wake)')
  } finally {
    await env.dispose()
    // The fire-and-forget drain + the bundle's boot continuations may still
    // hold a writer for a few ms AFTER the loader dispose — a plain rm races
    // them (ENOTEMPTY). Settle + retry so the cleanup is deterministic; a
    // final residue warns instead of failing the (already-green) assertions.
    await new Promise((resolve) => setTimeout(resolve, 150))
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(stateDir, { recursive: true, force: true })
        return
      } catch (error) {
        if (attempt === 4) {
          console.warn(`[fb132-drain c1] temp stateDir cleanup left a residue (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
  }
})

// The lane-design constant is reachable (a smoke of the public surface):
test('fb132-drain (surface): DRAIN_RECIPIENT_QUEUE_DEFAULT_CAP is exported with the design value 25', () => {
  assert.equal(DRAIN_RECIPIENT_QUEUE_DEFAULT_CAP, 25, 'the default cap is 25 (the wake-storm bound of the lane design)')
})