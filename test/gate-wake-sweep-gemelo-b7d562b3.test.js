// dsh-deepartments — LANE «EL GEMELO DEL FIX DE ANOCHE EN EL SWEEP» (2026-09-18,
// run token b7d562b3).
//
// MECHANISM (the measured base, read from the source): `DeliveryRedeliverer`'s
// `drivePair` has the SAME FIFO guard the delivery engine has (fb-117/fb-132),
// and its `gatedHeld` else-branch (`packages/dshd-core/src/messages.ts`, the
// branch this lane touches) RETAINED the pair and RETURNED — programming
// NOTHING. Its own comment declared the intent: «the record stays durable
// 'prepared' and drains at the recipient's next REAL wake». Nothing ever
// PROGRAMMED that wake.
//
// WHAT THIS FILE ASSERTS (acceptance + the false-green guard, BY EXECUTION):
//   (a) ACCEPTANCE — a `gatedHeld` retention PROGRAMS the wake its release
//       depends on: the armed wake actually FIRES with ZERO external traffic
//       (no third-party landing, no `onDelivered`, no explicit drain call) and
//       the FIFO unwinds HEAD-FIRST (the gating head lands, then the follower).
//   (b) THE FALSE-GREEN GUARD — the retention is NOT weakened: the pair is
//       still `prepared` at the retention instant, nothing is spliced ahead of
//       the gating head (the fb-117 order guarantee intact), a DELIBERATE
//       noWake row is NEVER armed, and a second retention behind the SAME head
//       does NOT re-arm (once per head — the fix cannot become the fb-150 spool).
//   (c) THE DIFFERENTIAL PROOF — with the transport SUPPRESSED (`gateWake`
//       explicitly a no-op) the pair is NOT released by the pass alone: it
//       stays `prepared` across a full sweep cycle. With the REAL transport
//       (the default — this class's own `drainRecipientQueue`, zero wiring) the
//       SAME fixture IS released. The wake, and nothing else, is the releaser.
//
// FIXTURE: deterministic (fixture ids only), a TEMP stateDir per test, the REAL
// `DeliveryRedeliverer` from the src tree, a deliver stub that MIMICS the real
// seam's gate semantics, 0 real APIs and 0 real wakes of any agent.
import { register } from 'node:module'
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
  hasEarlierPendingPair,
  gatingHeadIsNoWake,
  pendingForRecipient,
  deliveryStatus
} from '../packages/dshd-core/src/messages.ts'

const R = 'sane-post-r'
const SENDER = 'sender-head'

/** A TEMP stateDir (NEVER the daemon's `/.deepartments`). The teardown QUIESCES
 * first: the programmed wake fires a FIRE-AND-FORGET drain, so an in-flight
 * append can still be running when the assertions finish — removing the tree
 * under it is an ENOTEMPTY race in the FIXTURE, not a product defect.
 *
 * ★ THE `return` MUST NOT LIVE IN THE `finally` BLOCK (measured 2026-09-18, run
 * token b7d562b3). The reference pattern this file was modelled on
 * (`gate-fifo-despertador-5f015e56.test.js`) retries the `rm` inside `finally`
 * with a `return` on success — and a `return` executed in a `finally` block
 * OVERRIDES any pending throw from the `try`, so EVERY assertion failure inside
 * the test body was SILENTLY SWALLOWED and the file reported `ok`. MEASURED: the
 * pre-fix tree (the defect present) reported 7/7 green with this shape, and the
 * SAME run reports the true verdict once the teardown is restructured to
 * CAPTURE AND RETHROW. The test must therefore record the outcome, clean up,
 * and re-throw — never return from `finally`. */
async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'gatewake-sweep-'))
  let outcome
  let thrown
  try {
    outcome = await fn(stateDir)
  } catch (error) {
    thrown = error
  }
  // QUIESCE + CLEANUP — outside the finally, so a failure can never be eaten.
  for (let attempt = 0; ; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 80))
    try {
      await rm(stateDir, { recursive: true, force: true })
      break
    } catch (error) {
      if (attempt >= 5) {
        if (thrown === undefined) thrown = error
        break
      }
    }
  }
  if (thrown !== undefined) throw thrown
  return outcome
}

function row(messageId, recipientId, status, ts, noWake) {
  return noWake === true ? { messageId, recipientId, status, ts, noWake } : { messageId, recipientId, status, ts }
}

function record(id, seq, to = [R], from = SENDER) {
  return { id, seq, ts: 1_000, from, to, text: `msg ${id}`, kind: 'agent' }
}

async function seed(stateDir, rows) {
  await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

async function readRows(stateDir) {
  return parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
}

function countPair(rows, messageId, recipientId, status) {
  return rows.filter((r) => r.messageId === messageId && r.recipientId === recipientId && r.status === status).length
}

/**
 * The REAL `DeliveryRedeliverer` wired like the production bundle, over a TEMP
 * stateDir. The `deliver` stub MIMICS the real seam's FIFO-gate semantics
 * (`deliverOrQueue`): a write-ahead 'prepared', then — if an EARLIER pending
 * pair still gates it — a SECOND fresh 'prepared' (queued BEHIND), else the
 * final 'delivered'. That is what makes the gating head's own landing the event
 * that opens the gate for the follower, exactly as in production.
 *
 * `options.gateWake` is passed ONLY when the caller sets it: ABSENT, the
 * retainer falls back to its OWN `drainRecipientQueue` — the zero-wiring
 * production default this lane's fix rests on.
 */
function makeRedeliverer(stateDir, seqsByRecipient, calls, recordsById, options = {}) {
  const gateRows = async () => parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
  const gate = async (recipientId, seq) => hasEarlierPendingPair(await gateRows(), (r) => seqsByRecipient.get(r) ?? [], recipientId, seq)
  return new DeliveryRedeliverer({
    stateDir,
    logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
    recipientAlive: () => true,
    ...(options.recipientRunning !== undefined ? { recipientRunning: options.recipientRunning } : {}),
    getRecord: async (messageId) => recordsById.get(messageId),
    resolveCallerSessionId: () => 'caller-session',
    deliver: async (rec, recipientId) => {
      calls.deliver.push({ messageId: rec.id, recipientId })
      await markDelivery(stateDir, rec.id, recipientId, 'prepared')
      if (await gate(recipientId, rec.seq)) {
        await markDelivery(stateDir, rec.id, recipientId, 'prepared')
        return 'prepared'
      }
      await markDelivery(stateDir, rec.id, recipientId, 'delivered')
      return 'delivered'
    },
    pendingEarlierSeq: async (recipientId, seq) => gate(recipientId, seq),
    earlierHeadIsNoWake: async (recipientId, seq) => gatingHeadIsNoWake(await gateRows(), (r) => seqsByRecipient.get(r) ?? [], recipientId, seq),
    ...(options.gateWakeDelayMs !== undefined ? { gateWakeDelayMs: options.gateWakeDelayMs } : {}),
    ...(options.gateWake !== undefined ? { gateWake: options.gateWake } : {})
  })
}

/** Wait for `predicate` up to `timeoutMs` (a NON-unref'd timer keeps the event
 * loop alive so the unref'd arm timer inside the window can still fire). */
function waitUntil(predicate, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = async () => {
      let done = false
      try {
        done = (await predicate()) === true
      } catch {
        done = false
      }
      if (done) return resolve(true)
      if (Date.now() - started > timeoutMs) return resolve(false)
      setTimeout(tick, 5)
    }
    void tick()
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The reachable fixture that puts the retainer in the ONLY state where the
 * wake it programs is the difference between release and stranding: the FOLLOWER
 * is DUE (older than the 10-min prepared-stuck criterion) while the GATING HEAD
 * is NOT due (fresh) — so the sweep's own head-first due ordering cannot open the
 * chain this cycle, and the hold is the last thing before the release.
 *
 * MEASURED REACHABILITY (not invented): the sweep's hold writes NO row
 * (`gatedHeld` = «skip without settle»), so a held follower's row ts NEVER
 * refreshes; a head that is re-driven and re-gated DOES get a fresh write-ahead
 * row. The two clocks therefore drift apart exactly in this direction. */
function strandedFixture(T0) {
  return {
    rows: [
      row('m-900', R, 'prepared', T0 - 30_000), // the GATING HEAD: FRESH (not due)
      row('m-901', R, 'prepared', T0 - 11 * 60_000) // the FOLLOWER: DUE, retained
    ],
    seqs: new Map([[R, [900, 901]]]),
    records: new Map([['m-900', record('m-900', 900)], ['m-901', record('m-901', 901)]])
  }
}

// ---------------------------------------------------------------------------
// (a) ACCEPTANCE — the `gatedHeld` retainer PROGRAMS the wake its release
//     depends on, and the release happens BY EXECUTION with ZERO external
//     traffic.
// ---------------------------------------------------------------------------
test('acceptance (a): a `gatedHeld` retention PROGRAMS the wake its release depends on — the armed wake FIRES with no external traffic and the FIFO unwinds head-first (head lands, then the follower)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const fixture = strandedFixture(T0)
    await seed(stateDir, fixture.rows)
    const calls = { informs: [], warns: [], deliver: [] }
    // NO `gateWake` IS PASSED: the retainer must fall back to its OWN
    // `drainRecipientQueue` — the zero-wiring production default. `gateWakeDelayMs`
    // only shrinks the delay so the armed fire is observable inside the test
    // window (the production default is 60 s).
    const redeliverer = makeRedeliverer(stateDir, fixture.seqs, calls, fixture.records, { gateWakeDelayMs: 40 })

    const t0 = Date.now()
    // ONE SWEEP PASS. The head is fresh (not due), the follower is due → the
    // follower reaches the gate and is RETAINED.
    await redeliverer.sweepDue(T0)

    // THE RETENTION IS PRESERVED — this is NOT a «stop retaining» change.
    assert.equal(await deliveryStatus(stateDir, 'm-901', R), 'prepared', 'the follower is RETAINED (the gate holds — fb-117 order untouched)')
    assert.deepEqual(calls.deliver, [], 'at the retention instant NOTHING was driven: the pass scheduled a wake instead of splicing ahead of the head')
    assert.ok(calls.informs.some((m) => /class=gatedHeld wakeArmed=true wakeReason=armed/.test(m)), 'the arm DECISION is recorded: armed, with its reason named')

    // ★ THE ACCEPTANCE: the programmed wake FIRES — with NO third-party traffic
    // (nothing else was delivered to R: `deliver` is only ever called by the
    // wake's own drain) and on a BOUNDED schedule (not on a foreign landing).
    const fired = await waitUntil(async () => (await deliveryStatus(stateDir, 'm-901', R)) === 'delivered', 2000)
    assert.ok(fired, 'the retained pair was RELEASED by the programmed wake — it did not wait for external traffic (RED pre-fix: the hold returned programming nothing)')
    assert.ok(Date.now() - t0 < 2000, 'and it was released on a BOUNDED schedule, not on a third-party landing')

    assert.equal(await deliveryStatus(stateDir, 'm-900', R), 'delivered', 'the gating HEAD landed too (the programmed drain re-drives head-first)')
    assert.deepEqual(calls.deliver.map((d) => d.messageId), ['m-900', 'm-901'], 'THE RELEASE PRESERVED THE FIFO ORDER: the head landed BEFORE the follower (fb-117 never inverted)')
    assert.equal(countPair(await readRows(stateDir), 'm-901', R, 'terminal'), 0, 'the released pair was never settled (no lost pair — the drain delivers, it does not terminalize)')
  })
})

// ---------------------------------------------------------------------------
// (c) THE DIFFERENTIAL PROOF — the WAKE is the releaser, and nothing else.
// ---------------------------------------------------------------------------
test('differential (c): with the transport SUPPRESSED the pair is NOT released by the pass alone (it stays `prepared` across a whole cycle); with the REAL transport the SAME fixture IS released', async () => {
  // ARM 1 — the transport suppressed (`gateWake` explicitly a no-op). This
  // reproduces the PRE-FIX observable: the hold retains, and no pass ever
  // releases the pair. It isolates the wake as the cause.
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const fixture = strandedFixture(T0)
    await seed(stateDir, fixture.rows)
    const calls = { informs: [], warns: [], deliver: [] }
    const fires = []
    const redeliverer = makeRedeliverer(stateDir, fixture.seqs, calls, fixture.records, {
      gateWakeDelayMs: 20,
      gateWake: (recipientId) => { fires.push(recipientId) } // armed, but delivers NOTHING
    })
    await redeliverer.sweepDue(T0)
    await redeliverer.sweepDue(T0) // a SECOND pass: the sweep itself never re-drives it
    await sleep(150)
    assert.equal(fires.length, 1, 'the wake was ARMED exactly once (once per gating head)')
    assert.equal(calls.deliver.length, 0, 'the pass never drove the gated pair (the hold is a skip, not an attempt)')
    assert.equal(await deliveryStatus(stateDir, 'm-901', R), 'prepared', 'without the wake the pair stays `prepared` — the wake is the ONLY releaser')
  })

  // ARM 2 — the SAME fixture with the REAL transport (the default).
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const fixture = strandedFixture(T0)
    await seed(stateDir, fixture.rows)
    const calls = { informs: [], warns: [], deliver: [] }
    const redeliverer = makeRedeliverer(stateDir, fixture.seqs, calls, fixture.records, { gateWakeDelayMs: 40 })
    await redeliverer.sweepDue(T0)
    const released = await waitUntil(async () => (await deliveryStatus(stateDir, 'm-901', R)) === 'delivered', 2000)
    assert.ok(released || (await deliveryStatus(stateDir, 'm-901', R)) === 'delivered', 'the REAL transport releases the SAME fixture — the differential isolates the wake as the releaser')
  })
})

// ---------------------------------------------------------------------------
// (b) THE FALSE-GREEN GUARD — the retention still PROTECTS when it must.
// ---------------------------------------------------------------------------
test('guard (b): the hold is NOT weakened — the follower stays `prepared` and nothing is spliced ahead of the gating head at the retention instant', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const fixture = strandedFixture(T0)
    await seed(stateDir, fixture.rows)
    const calls = { informs: [], warns: [], deliver: [] }
    // A LONG delay: the wake cannot fire inside this test, so the retention
    // state is observed on its own.
    const redeliverer = makeRedeliverer(stateDir, fixture.seqs, calls, fixture.records, { gateWakeDelayMs: 60_000 })
    await redeliverer.sweepDue(T0)

    assert.equal(await deliveryStatus(stateDir, 'm-901', R), 'prepared', 'the follower is a drain candidate: never settled, never lost')
    assert.deepEqual(calls.deliver, [], 'NOTHING is spliced ahead of the head (the fb-117 guarantee the gate defends)')
    const rows = await readRows(stateDir)
    assert.equal(countPair(rows, 'm-900', R, 'prepared'), 1, 'the gating head is untouched (its pair-latest stays the pending `prepared`)')
    assert.equal(countPair(rows, 'm-901', R, 'delivered'), 0, 'no landed row is invented for the held pair')
  })
})

test('guard (b): a DELIBERATE noWake row is NEVER armed (the no-wake-until-wake contract) — the ledger names the reason', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, [
      row('m-910', R, 'prepared', T0 - 30_000),
      row('m-911', R, 'prepared', T0 - 11 * 60_000, true) // the noWake follower
    ])
    const seqs = new Map([[R, [910, 911]]])
    const records = new Map([['m-910', record('m-910', 910)], ['m-911', record('m-911', 911)]])
    const calls = { informs: [], warns: [], deliver: [] }
    const fires = []
    // `recipientRunning: () => true` is what lets a noWake row REACH the gate at
    // all (the P2 guard skips a noWake row into a non-running recipient first —
    // so the gate's own noWake arm reason is reachable ONLY through the P2
    // exception, which is exactly this case).
    const redeliverer = makeRedeliverer(stateDir, seqs, calls, records, {
      recipientRunning: () => true,
      gateWakeDelayMs: 20,
      gateWake: (recipientId) => { fires.push(recipientId) }
    })
    await redeliverer.sweepDue(T0)
    assert.equal(await deliveryStatus(stateDir, 'm-911', R), 'prepared', 'the noWake row is held (the no-wake-until-wake contract)')
    assert.ok(calls.informs.some((m) => /class=gatedHeld wakeArmed=false wakeReason=no-wake-send/.test(m)), 'the ledger NAMES the non-arm reason (never a silent no-op)')
    await sleep(120)
    assert.deepEqual(fires, [], 'NO wake was armed for a deliberate noWake queue (its drain is the recipient`s next REAL wake)')
  })
})

test('guard (b) — NO STORM: a second retention behind the SAME gating head does NOT re-arm (the fix cannot become the fb-150 spool)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const fixture = strandedFixture(T0)
    await seed(stateDir, fixture.rows)
    const calls = { informs: [], warns: [], deliver: [] }
    const fires = []
    const redeliverer = makeRedeliverer(stateDir, fixture.seqs, calls, fixture.records, {
      gateWakeDelayMs: 60_000, // long: neither arm fires, both are observed
      gateWake: (recipientId) => { fires.push(recipientId) }
    })
    // TWO passes over the SAME still-pending head.
    await redeliverer.sweepDue(T0)
    await redeliverer.sweepDue(T0)
    // The ARM-DECISION family ONLY (`drive-arm`): the `drive-hold` line shares
    // the `class=gatedHeld ` prefix, so a bare `/class=gatedHeld /` would match
    // TWO lines per retention and read 4 instead of 2 (measured).
    const arms = calls.informs.filter((m) => /\[gate-wake\] drive-arm /.test(m))
    assert.equal(arms.length, 2, 'both retentions are recorded')
    assert.ok(/wakeArmed=true wakeReason=armed/.test(arms[0]), 'the FIRST retention arms the wake')
    assert.ok(/wakeArmed=false wakeReason=already-armed/.test(arms[1]), 'the SECOND retention behind the SAME head does NOT re-arm, and the ledger says WHY')
    await sleep(150)
    assert.equal(fires.length, 0, 'exactly zero wakes fired inside the window (the delay is long) — and crucially NOT two')
  })
})

test('guard (b): the armed wake is keyed to the GATING HEAD (`wakeKey=m-900`) and carries the configured delay — the release is EXPLICABLE from the log, never inferred', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const fixture = strandedFixture(T0)
    await seed(stateDir, fixture.rows)
    const calls = { informs: [], warns: [], deliver: [] }
    const redeliverer = makeRedeliverer(stateDir, fixture.seqs, calls, fixture.records, { gateWakeDelayMs: 40 })
    await redeliverer.sweepDue(T0)
    const arm = calls.informs.find((m) => /class=gatedHeld wakeArmed=true/.test(m))
    assert.ok(arm !== undefined, 'the arm decision landed')
    assert.match(arm, /wakeKey=m-900/, 'the programmed wake is keyed to the GATING HEAD the retention depends on')
    assert.match(arm, /wakeDelayMs=40/, 'and it carries the configured delay (the test knob; production default 60 s)')
    await waitUntil(async () => (await deliveryStatus(stateDir, 'm-901', R)) === 'delivered', 2000)
  })
})

// ---------------------------------------------------------------------------
// (d) THE HEAD-FIRST CONTRACT END TO END — a 3-pair chain releases in seq order,
//     and the sweep's own head-first pass drains the residue it just unblocked.
// ---------------------------------------------------------------------------
test('order (d): the FIFO unwinds head-first through the programmed wake — all three pairs land in seq order with no external traffic', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, [
      row('m-920', R, 'prepared', T0 - 30_000), // FRESH head
      row('m-921', R, 'prepared', T0 - 11 * 60_000), // DUE follower (retained)
      row('m-922', R, 'prepared', T0 - 11 * 60_000) // DUE follower (retained)
    ])
    const seqs = new Map([[R, [920, 921, 922]]])
    const records = new Map([
      ['m-920', record('m-920', 920)],
      ['m-921', record('m-921', 921)],
      ['m-922', record('m-922', 922)]
    ])
    const calls = { informs: [], warns: [], deliver: [] }
    const redeliverer = makeRedeliverer(stateDir, seqs, calls, records, { gateWakeDelayMs: 40 })
    await redeliverer.sweepDue(T0)
    const ok = await waitUntil(async () => (await deliveryStatus(stateDir, 'm-922', R)) === 'delivered', 3000)
    assert.ok(ok || (await deliveryStatus(stateDir, 'm-922', R)) === 'delivered', 'the whole chain released without any external traffic')
    const order = calls.deliver.map((d) => d.messageId)
    assert.deepEqual(order, ['m-920', 'm-921', 'm-922'], `STRICT FIFO: every pair landed in seq order (observed ${JSON.stringify(order)})`)
    const rows = await readRows(stateDir)
    for (const id of ['m-920', 'm-921', 'm-922']) {
      assert.equal(countPair(rows, id, R, 'terminal'), 0, `${id} was never settled (no pair lost to a terminal flip)`)
    }
  })
})
