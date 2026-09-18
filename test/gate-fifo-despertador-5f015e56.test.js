// dsh-deepartments — LANE «EL GATE FIFO RETIENE SIN PROGRAMAR EL WAKE» (2026-09-17,
// run token 5f015e56).
//
// MECHANISM (the measured base): `deliverOrQueue`'s fb-117 FIFO gate
// (`packages/dshd-core/src/delivery.ts`, the hold branch — `markFinal(record,
// recipientId, 'prepared', …)` + `return 'prepared'`) RETAINS an ALWAYS-WAKE
// delivery and PROGRAMS NOTHING. The only real waker of a retained queue is
// `deps.onDelivered`, which fires ONLY on a LANDED delivery — i.e. when ANOTHER
// message lands at that recipient. An IDLE recipient never gets that event, so
// the release depends on third-party traffic or on the 10-minute prepared-stuck
// clock (messages.ts:1185/:2208).
//
// WHAT THIS FILE ASSERTS (acceptance + the false-green guard, BY EXECUTION):
//   (a) ACCEPTANCE — a retained ALWAYS-WAKE delivery PROGRAMS the wake its
//       release depends on: the armed wake actually FIRES (no external traffic
//       in the fixture) and the FIFO unwinds head-first (the head lands, then the
//       follower) with NO third-party delivery.
//   (b) FALSE-GREEN GUARD — the gate STILL RETAINS when it must: a SANE pending
//       head keeps the follower 'prepared' with the route NEVER reached (nothing
//       is spliced ahead of the head: fb-117 order intact); a DELIBERATE noWake
//       retention is NEVER armed (the no-wake-until-wake contract untouched); a
//       noWake HEAD (m-2415) still SKIPS the gate (the follower is delivered).
//   (c) THE INSTRUMENT (§3) — the `gate-decision` AND `gate-verdict` families
//       LAND IN A LEDGER (`<stateDir>/gate-decisions.jsonl`): BOTH are asserted,
//       and the ledger DISAMBIGUATES a legitimate `headNoWake=false` from a
//       silent-failure `undefined` (dep-absent / throw) — the asymmetry the
//       trace measured as indistinguishable in the legacy ledger.
//
// FIXTURE: deterministic (fixture ids only: H is a SANE live post), a temp
// stateDir per test, the REAL `createDeliveryEngine` + the REAL pure gates from
// messages.ts, stub wake primitives (0 builds, 0 real APIs).
import { register } from 'node:module'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  markDelivery,
  parseDeliveryRows,
  pendingForRecipient,
  resolveDeliveriesPath,
  hasEarlierPendingPair,
  gatingHeadIsNoWake,
  deliveryStatus
} from '../packages/dshd-core/src/messages.ts'
// The SEND-path engine: imported DYNAMICALLY (the module hook must be registered
// first — a static import is hoisted above it and the src graph fails to link).
const { createDeliveryEngine } = await import('../packages/dshd-core/src/delivery.ts')

const H = 'sane-post-h'
const SENDER = 'sender-head'

/** The ledger the §3 acceptance requires (the sink of BOTH log families). */
const GATE_LEDGER = 'gate-decisions.jsonl'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'gatewake-'))
  try {
    return await fn(stateDir)
  } finally {
    // QUIESCE BEFORE teardown: the programmed wake fires a FIRE-AND-FORGET drain
    // (the production transport's own contract), so a landed pair can still be
    // appending rows when the assertions finish. Removing the tree under an
    // in-flight write is an ENOTEMPTY race in the FIXTURE, not a product defect —
    // so the teardown waits for the writes to settle and retries.
    for (let attempt = 0; ; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      try {
        await rm(stateDir, { recursive: true, force: true })
        return
      } catch (error) {
        if (attempt >= 5) throw error
      }
    }
  }
}

function row(messageId, recipientId, status, ts, noWake) {
  return noWake === true ? { messageId, recipientId, status, ts, noWake } : { messageId, recipientId, status, ts }
}

function record(id, seq, to = [H], from = SENDER) {
  return { id, seq, ts: 1_000, from, to, text: `msg ${id}`, kind: 'agent' }
}

async function seed(stateDir, { rows = [] } = {}) {
  if (rows.length > 0) await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

async function readRows(stateDir) {
  return parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
}

/** The ledger rows the sink wrote (empty when the sink does not exist yet —
 * the PRE-FIX tree: `ENOENT` degrades to `[]` so the asserts report the
 * acceptance failure instead of an fs error). */
async function readGateLedger(stateDir) {
  try {
    return (await readFile(path.join(stateDir, GATE_LEDGER), 'utf8')).split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function countPair(rows, messageId, recipientId, status) {
  return rows.filter((r) => r.messageId === messageId && r.recipientId === recipientId && r.status === status).length
}

/** The production catalog route of the fixture: H is a SANE live post. */
function catalogRoute(recipientId) {
  if (recipientId === H) return { kind: 'post', entry: { postId: recipientId, sessionId: `session-${recipientId}`, retired: false, provider: 'head' } }
  return { kind: 'unknown' }
}

/**
 * The REAL engine wired like the production bundle (index.ts): the two sidecar
 * marks on the temp stateDir + the REAL pure gate predicates over the CURRENT
 * sidecar. `options.onDelivered` decides whether the production drain transport
 * is wired (the production composition wires it — tools.ts:7574 via
 * index.ts:791 and orchestration/delivery.ts:3203 in the fallback engine);
 * `options.gateWakeDelayMs` arms the programmed release INSIDE the test window.
 */
function makeEngine(stateDir, seqsByRecipient, calls, options = {}) {
  const gateRows = async () => parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
  const engine = createDeliveryEngine({
    stateDir,
    logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
    markPrepared: (record_, recipientId, opts) => markDelivery(stateDir, record_.id, recipientId, 'prepared', Date.now(), opts?.noWake === true),
    markFinal: (record_, recipientId, status, opts) => markDelivery(stateDir, record_.id, recipientId, status, Date.now(), opts?.noWake === true),
    resolveChild: async () => false,
    deliverChild: async () => 'delivered',
    resolveCatalogRoute: catalogRoute,
    busProfileFor: (memberId) => (memberId === SENDER ? { kind: 'head', memberId, departmentId: 'dept' } : { kind: 'unclassified', memberId }),
    deliverPost: async (entry, framed, rec) => {
      calls.routes.push(rec.id)
      await markDelivery(stateDir, rec.id, entry.postId, 'delivered')
      return 'delivered'
    },
    deliverHost: async () => 'failed',
    pendingEarlierSeq: async (recipientId, seq) => hasEarlierPendingPair(await gateRows(), (r) => seqsByRecipient.get(r) ?? [], recipientId, seq),
    pendingEarlierSeqDetail: async (recipientId, seq) => {
      const rows = await gateRows()
      const latest = new Map()
      for (const x of rows) latest.set(`${x.messageId}\u0000${x.recipientId}`, x)
      for (const earlier of seqsByRecipient.get(recipientId) ?? []) {
        if (earlier >= seq) break
        const x = latest.get(`m-${earlier}\u0000${recipientId}`)
        if (x !== undefined && x.status === 'prepared') return earlier
      }
      return undefined
    },
    ...(options.discriminator === 'absent'
      ? {}
      : {
          earlierHeadIsNoWake: async (recipientId, seq) => {
            if (options.discriminator === 'throw') throw new Error('fixture: sidecar read exploded')
            return gatingHeadIsNoWake(await gateRows(), (r) => seqsByRecipient.get(r) ?? [], recipientId, seq)
          }
        }),
    recipientMaterialized: () => true,
    recipientRunningLive: () => false,
    ...(options.gateWakeDelayMs !== undefined ? { gateWakeDelayMs: options.gateWakeDelayMs } : {}),
    ...(options.onDelivered !== undefined ? { onDelivered: options.onDelivered } : {})
  })
  return engine
}

/** The REAL drain semantics (messages.ts:2151-2195), reduced to its order
 * contract: pair-latest 'prepared' rows of the recipient, STRICTLY FIFO
 * head-first, AWAIT each re-drive and CONTINUE ONLY when it landed
 * (`delivered`/`resumed`) — anything else STOPS the drain. This is the transport
 * `onDelivered` fires in production; here it drives the SAME engine.
 *
 * RE-ENTRANCY GUARD REPLICATED (messages.ts:2153 — `if
 * (this.drainingQueues.has(recipientId)) return 0`): a landed delivery fires
 * `onDelivered` again, so WITHOUT this guard the drain recurses and delivers the
 * same pair twice. The guard is part of the primitive's contract, not an
 * optimization — the fixture must carry it or it measures a bug that does not
 * exist in production.
 *
 * `engineRef` is a THUNK: the engine is built AFTER this drain (the drain is
 * wired into the engine's `onDelivered`), so a captured value would be
 * `undefined` at the first fire. */
function makeDrain(stateDir, engineRef, recordsById, calls) {
  const draining = new Set()
  return async (recipientId) => {
    if (draining.has(recipientId)) return 0
    draining.add(recipientId)
    try {
      let drained = 0
      const pending = pendingForRecipient(await readRows(stateDir), recipientId)
      for (const pendingRow of pending) {
        const rec = recordsById.get(pendingRow.messageId)
        if (rec === undefined || !rec.to.includes(recipientId)) break // ALTO-1 stale head: the FIFO cannot jump it
        const status = await engineRef().deliverOrQueue(recipientId, rec, {})
        drained++
        if (status !== 'delivered' && status !== 'resumed') break
      }
      return drained
    } finally {
      draining.delete(recipientId)
    }
  }
}

/** Wait for `predicate` up to `timeoutMs` (a NON-unref'd timer keeps the event
 * loop alive so an unref'd engine timer inside the window can still fire).
 * The predicate may be sync OR async — an async one is awaited (a bare
 * `if (predicate())` would read a Promise and always be truthy). */
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

// ---------------------------------------------------------------------------
// (c) THE INSTRUMENT (§3) — BOTH families land in a LEDGER, and the ledger
//     DISAMBIGUATES `false` (legitimate crash-class retention) from the
//     silent-failure `undefined` (dep absent / throw). RED pre-fix: the file
//     does not exist at all (both families are log-only).
// ---------------------------------------------------------------------------
test('instrument (§3): the `gate-decision` AND `gate-verdict` families LAND in <stateDir>/gate-decisions.jsonl — a retained pair is EXPLICABLE from the ledger (verdict + bySeq + the resolved discriminator), never inferred', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      rows: [
        row('m-700', H, 'prepared', T0 - 60_000), // the SANE pending head (crash-class: no noWake)
        row('m-701', H, 'prepared', T0 - 60_000) // the RETAINED follower
      ]
    })
    const seqs = new Map([[H, [700, 701]]])
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, seqs, calls, { gateWakeDelayMs: 10_000 })

    const status = await engine.deliverOrQueue(H, record('m-701', 701), {})
    assert.equal(status, 'prepared', 'the follower is retained (the gate holds)')

    const ledger = await readGateLedger(stateDir)
    const decision = ledger.find((r) => r.kind === 'gate-decision')
    const verdict = ledger.find((r) => r.kind === 'gate-verdict')
    assert.ok(decision !== undefined, 'the gate-decision family LANDS in the ledger (RED pre-fix: the file does not exist — the line was log-only)')
    assert.ok(verdict !== undefined, 'the gate-verdict family LANDS TOO (routing only one leaves the ledger counting half)')
    assert.equal(decision.id, 'm-701')
    assert.equal(decision.recipient, H)
    assert.equal(decision.gated, true)
    assert.equal(decision.headNoWake, 'false', 'the DECISION row carries the RESOLVED discriminator (a legitimate crash-class head ⇒ false)')
    assert.equal(verdict.verdict, 'hold-gated')
    assert.equal(verdict.bySeq, 'm-700', 'the ledger names the GATING seq — the next retained pair is EXPLAINABLE, not inferred')
    assert.equal(verdict.headNoWake, 'false')
  })
})

test('instrument (§3): the ledger SEPARATES the legitimate `headNoWake=false` from the silent-failure `undefined` (dep-absent / throw) — the asymmetry the trace measured as INDISTINGUISHABLE', async () => {
  for (const [mode, expected] of [['false', 'false'], ['absent', 'dep-absent'], ['throw', 'throw']]) {
    await withTempStateDir(async (stateDir) => {
      const T0 = Date.now()
      await seed(stateDir, {
        rows: [row('m-710', H, 'prepared', T0 - 60_000), row('m-711', H, 'prepared', T0 - 60_000)]
      })
      const seqs = new Map([[H, [710, 711]]])
      const calls = { informs: [], warns: [], routes: [] }
      const engine = makeEngine(stateDir, seqs, calls, { gateWakeDelayMs: 10_000, discriminator: mode })
      const status = await engine.deliverOrQueue(H, record('m-711', 711), {})
      // ALL THREE retain identically (the same branch, the same row, the same
      // 'prepared' outcome) — that indistinction of the FLOW is by design...
      assert.equal(status, 'prepared', `${mode}: the flow is identical (retained)`)
      const ledger = await readGateLedger(stateDir)
      const verdict = ledger.find((r) => r.kind === 'gate-verdict')
      assert.ok(verdict !== undefined, `${mode}: the ledger row lands`)
      // ...and it is the LEDGER that separates them (the whole point).
      assert.equal(verdict.headNoWake, expected, `${mode}: the ledger records the RESOLVED discriminator as ${expected}`)
      if (mode === 'absent') {
        assert.equal(calls.warns.some((w) => /discriminator failed/.test(w)), false, 'a dep-ABSENT composition is not a read failure (no warn) — yet the ledger still names it')
      }
      if (mode === 'throw') {
        assert.ok(calls.warns.some((w) => /no-wake-head discriminator failed/.test(w)), 'the throw keeps its existing warn (fail-soft) AND is now visible in the ledger as a LOST WAKER')
      }
    })
  }
})

// ---------------------------------------------------------------------------
// (a) ACCEPTANCE — the retainer PROGRAMS the wake its release depends on, and
//     the release happens BY EXECUTION (the armed wake fires and the FIFO
//     unwinds head-first) with ZERO third-party traffic.
// ---------------------------------------------------------------------------
test('acceptance (a): a retained ALWAYS-WAKE PROGRAMS the wake its release depends on — the armed wake FIRES with no external traffic and the FIFO unwinds head-first (head lands, then the follower)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      rows: [
        row('m-720', H, 'prepared', T0 - 60_000), // the head: a crashed write-ahead pair (re-driveable)
        row('m-721', H, 'prepared', T0 - 60_000) // the follower: retained by the gate
      ]
    })
    const seqs = new Map([[H, [720, 721]]])
    const calls = { informs: [], warns: [], routes: [] }
    const recordsById = new Map([['m-720', record('m-720', 720)], ['m-721', record('m-721', 721)]])
    const fires = []
    // The production transport: onDelivered → the drain (fire-and-forget). ONE
    // drain instance per recipient (its re-entrancy guard is per-recipient STATE
    // — instantiating it per fire would defeat the guard).
    let engine
    const theDrain = makeDrain(stateDir, () => engine, recordsById, calls)
    const drain = (recipientId) => {
      fires.push({ recipientId, at: Date.now() })
      return theDrain(recipientId)
    }
    engine = makeEngine(stateDir, seqs, calls, { gateWakeDelayMs: 40, onDelivered: (recipientId) => { void drain(recipientId) } })

    const t0 = Date.now()
    const status = await engine.deliverOrQueue(H, record('m-721', 721), {})
    assert.equal(status, 'prepared', 'the ALWAYS-WAKE is retained by the gate (unchanged — this is NOT a stop-retaining fix)')
    assert.deepEqual(calls.routes, [], 'at the retention instant NOTHING was spliced ahead of the head (fb-117 order intact)')

    const ledger = await readGateLedger(stateDir)
    const hold = ledger.find((r) => r.kind === 'gate-verdict' && r.verdict === 'hold-gated')
    assert.ok(hold !== undefined, 'the hold verdict landed')
    assert.equal(hold.wakeArmed, true, 'THE RETAINER PROGRAMMED THE WAKE (RED pre-fix: the hold branch returned without programming anything)')
    assert.equal(hold.wakeDelayMs, 40, 'the programmed delay is the engine`s configured bound')
    assert.equal(hold.wakeKey, `m-720`, 'the programmed wake is keyed to the GATING HEAD it depends on')

    const fired = await waitUntil(() => fires.length >= 1, 2000)
    assert.ok(fired, 'the programmed wake FIRED with NO external traffic to H (nothing else was delivered to the recipient)')
    assert.ok(Date.now() - t0 < 2000, 'and it fired on a BOUNDED schedule, not on a third-party landing')

    const released = await waitUntil(async () => (await deliveryStatus(stateDir, 'm-721', H)) === 'delivered', 2000)
    assert.ok(released || (await deliveryStatus(stateDir, 'm-721', H)) === 'delivered', 'the retained pair was RELEASED by the programmed wake (it did not wait indefinitely)')
    assert.equal(await deliveryStatus(stateDir, 'm-720', H), 'delivered', 'the gating head landed (the programmed drain re-drives head-first)')
    assert.deepEqual(calls.routes, ['m-720', 'm-721'], 'the release preserved the FIFO ORDER: the head landed BEFORE the follower (fb-117 never inverted)')
  })
})

test('acceptance (a) — NO STORM: a second retention behind the SAME gating head does NOT re-arm (the programmed wake is once per gating head, so the fix cannot become the fb-150 spool)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      rows: [row('m-730', H, 'prepared', T0 - 60_000), row('m-731', H, 'prepared', T0 - 60_000)]
    })
    const seqs = new Map([[H, [730, 731]]])
    const calls = { informs: [], warns: [], routes: [] }
    const fires = []
    // A drain that CANNOT resolve the head (the head is not even a known record:
    // the ALTO-1 stale-head STOP) — so the follower is retained AGAIN and we can
    // observe whether the engine re-arms.
    const engine = makeEngine(stateDir, seqs, calls, { gateWakeDelayMs: 40, onDelivered: (recipientId) => { fires.push(recipientId) } })

    assert.equal(await engine.deliverOrQueue(H, record('m-731', 731), {}), 'prepared', 'first retention')
    assert.ok(await waitUntil(() => fires.length >= 1, 2000), 'the first programmed wake fired')
    // The programmed drain re-drives the follower (the head is stale → the drain
    // STOPS and re-drives nothing in this reduced transport; we model the
    // observable consequence instead: the SAME pair is retained again).
    assert.equal(await engine.deliverOrQueue(H, record('m-731', 731), {}), 'prepared', 'second retention behind the SAME head')
    const ledger = await readGateLedger(stateDir)
    const holds = ledger.filter((r) => r.kind === 'gate-verdict' && r.verdict === 'hold-gated')
    assert.equal(holds.length, 2, 'both retentions are recorded')
    assert.equal(holds[0].wakeArmed, true, 'the first retention arms the wake')
    assert.equal(holds[1].wakeArmed, false, 'the second retention behind the SAME head does NOT re-arm')
    assert.equal(holds[1].wakeReason, 'already-armed', 'and the ledger says WHY (once per gating head — no unbounded re-drive loop)')
    await sleep(120)
    assert.equal(fires.length, 1, 'exactly ONE wake fired (never a 30 s retry storm: the spool class stays closed)')
  })
})

// ---------------------------------------------------------------------------
// (b) THE FALSE-GREEN GUARD — the retention still PROTECTS when it must. A fix
//     that gave up the hold would be «turning the gate off», not a fix.
// ---------------------------------------------------------------------------
test('guard (b): the gate STILL HOLDS — a SANE pending head keeps the follower `prepared` with the route NEVER reached at the retention instant (nothing spliced ahead of the head)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      rows: [row('m-740', H, 'prepared', T0 - 5 * 60_000), row('m-741', H, 'prepared', T0 - 40 * 60_000)]
    })
    const seqs = new Map([[H, [740, 741]]])
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, seqs, calls, { gateWakeDelayMs: 10_000 })

    assert.equal(await engine.deliverOrQueue(H, record('m-741', 741), {}), 'prepared', 'RETENTION IS PRESERVED: the follower degrades to the queue (never delivered ahead of the head)')
    assert.deepEqual(calls.routes, [], 'the route is NEVER reached for the held pair (the fb-117 guarantee)')
    const rows = await readRows(stateDir)
    assert.equal(countPair(rows, 'm-741', H, 'delivered'), 0, 'no landed row is invented for the held pair')
    assert.equal(countPair(rows, 'm-740', H, 'prepared'), 1, 'the SANE head is untouched (its pair-latest stays the pending `prepared`)')
    assert.equal(await deliveryStatus(stateDir, 'm-741', H), 'prepared', 'the pair stays a drain candidate (never settled, never lost)')
    const ledger = await readGateLedger(stateDir)
    assert.equal(ledger.filter((r) => r.verdict === 'hold-gated').length, 1, 'the ledger records the HOLD (not a skip)')
  })
})

test('guard (b): a DELIBERATE noWake retention is NEVER armed (the no-wake-until-wake contract) and a noWake HEAD still SKIPS the gate (m-2415 preserved)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      rows: [
        row('m-750', H, 'prepared', T0 - 60_000), // crash-class head
        row('m-751', H, 'prepared', T0 - 60_000)
      ]
    })
    const seqs = new Map([[H, [750, 751]]])
    const calls = { informs: [], warns: [], routes: [] }
    const fires = []
    const engine = makeEngine(stateDir, seqs, calls, { gateWakeDelayMs: 40, onDelivered: (recipientId) => { fires.push(recipientId) } })

    // (1) a noWake send: a DELIBERATE no-wake-until-wake — it must NOT be armed
    //     (arming it would break the documented no-wake semantics).
    assert.equal(await engine.deliverOrQueue(H, record('m-751', 751), { noWake: true }), 'prepared', 'the noWake send is queued')
    const ledger = await readGateLedger(stateDir)
    const hold = ledger.find((r) => r.kind === 'gate-verdict' && r.verdict === 'hold-gated')
    assert.equal(hold.wakeArmed, false, 'a DELIBERATE no-wake retention programs NO wake')
    assert.equal(hold.wakeReason, 'no-wake-send', 'and the ledger names the reason')
    await sleep(120)
    assert.deepEqual(fires, [], 'no wake fired for the deliberate no-wake queue (its drain is the recipient`s next REAL wake)')
  })

  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      rows: [
        row('m-760', H, 'prepared', T0 - 60_000, true), // the noWake HEAD (m-2415)
        row('m-761', H, 'prepared', T0 - 60_000)
      ]
    })
    const seqs = new Map([[H, [760, 761]]])
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, seqs, calls, { gateWakeDelayMs: 10_000 })

    assert.equal(await engine.deliverOrQueue(H, record('m-761', 761), {}), 'delivered', 'm-2415 PRESERVED: an ALWAYS-WAKE behind a noWake head SKIPS the gate (it is the real wake)')
    assert.deepEqual(calls.routes, ['m-761'], 'it reached the route (a noWake head never blocks the wake)')
    const ledger = await readGateLedger(stateDir)
    // The SKIP is a gate decision, and the ledger records it as such (the
    // `gate-decision` row is emitted for every delivery that ENTERS the gate —
    // including this one, which then takes the m-2415 skip branch). What the
    // ledger must NOT contain is a HOLD for this delivery.
    assert.equal(ledger.some((r) => r.kind === 'gate-verdict' && r.verdict === 'hold-gated'), false, 'the m-2415 SKIP never produces a hold verdict (the delivery was not retained)')
    const skipVerdict = ledger.find((r) => r.kind === 'gate-verdict' && r.verdict === 'skip-nowake-head')
    assert.ok(skipVerdict !== undefined, 'the SKIP lands as its OWN verdict — a ledger that recorded only holds would report this delivery as «never gated»')
    assert.equal(skipVerdict.headNoWake, 'true', 'and the ledger names the noWake head that caused the skip')
  })
})

// ---------------------------------------------------------------------------
// (b2) THE ORDER THE GATE DEFENDS, END TO END — the FIFO unwinds pair by pair,
//      head-first, and the programmed wake is what opens the chain.
// ---------------------------------------------------------------------------
test('guard (b): the FIFO unwinds IN ORDER through the programmed wake — the head lands first, the follower second, and the ledger explains the pair that waited', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      rows: [
        row('m-770', H, 'prepared', T0 - 60_000),
        row('m-771', H, 'prepared', T0 - 60_000),
        row('m-772', H, 'prepared', T0 - 60_000)
      ]
    })
    const seqs = new Map([[H, [770, 771, 772]]])
    const calls = { informs: [], warns: [], routes: [] }
    const recordsById = new Map([
      ['m-770', record('m-770', 770)],
      ['m-771', record('m-771', 771)],
      ['m-772', record('m-772', 772)]
    ])
    let engine
    const theDrain = makeDrain(stateDir, () => engine, recordsById, calls)
    const drain = (recipientId) => theDrain(recipientId)
    engine = makeEngine(stateDir, seqs, calls, { gateWakeDelayMs: 40, onDelivered: (recipientId) => { void drain(recipientId) } })

    assert.equal(await engine.deliverOrQueue(H, record('m-772', 772), {}), 'prepared', 'the LAST pair is retained behind two pending heads')
    const ok = await waitUntil(async () => (await deliveryStatus(stateDir, 'm-772', H)) === 'delivered', 3000)
    assert.ok(ok || (await deliveryStatus(stateDir, 'm-772', H)) === 'delivered', 'the chain released by the programmed wake')
    assert.deepEqual(calls.routes, ['m-770', 'm-771', 'm-772'], 'STRICT FIFO: every pair landed in seq order (the order the gate defends, now also SCHEDULED)')
    const ledger = await readGateLedger(stateDir)
    assert.ok(ledger.some((r) => r.verdict === 'hold-gated' && r.bySeq === 'm-770'), 'the ledger names the head the retention depended on')
  })
})

// ---------------------------------------------------------------------------
// (d) RACE ROBUSTNESS (§5a of the mission — the one the tracer could NOT prove).
//     The gate's discriminator reader (`earlierHeadIsNoWake`) does an ASYNC
//     `readFile` of deliveries.jsonl, while the G2 settle rewrites that SAME file
//     with a NON-ATOMIC `writeFileSync` (messages.ts:2599) and boot compaction
//     does the same (messages.ts:2238). `parseDeliveryRows` THROWS on a malformed
//     row (messages.ts:659) — so a reader that interleaves with a truncating
//     write can throw, and BEFORE this change that throw was just a `warn`: the
//     discriminator resolved `undefined` and the retention proceeded with a LOST
//     WAKER (indistinguishable in the ledger from a legitimate crash-class head).
//
//     WHAT IS PROVEN HERE (by execution) and what is NOT:
//       PROVEN — the throw is CAUGHT and the delivery still RETURNS 'prepared'
//       with the release PROGRAMMED anyway (the fix does not depend on the
//       discriminator resolving: `undefined` still arms the wake). A silent
//       failure can no longer become a lost waker.
//       PROVEN — the failure is NAMED in the ledger (`headNoWake: "throw"`),
//       which is the whole asymmetry §3 asked for.
//       NOT PROVEN — the race itself (a real concurrent truncating write
//       interleaved with this read) is NOT reproduced here; that would need real
//       interleaving control. This test FORCES the reader's throw and asserts the
//       consequence, which is the part the delivery contract owes.
// ---------------------------------------------------------------------------
test('race (§5a): a THROWING discriminator reader (the concurrent-truncating-write class) still retains WITH the release programmed, and the ledger NAMES the failure — a silent failure is never again a lost waker', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    await seed(stateDir, {
      rows: [row('m-780', H, 'prepared', T0 - 60_000), row('m-781', H, 'prepared', T0 - 60_000)]
    })
    const seqs = new Map([[H, [780, 781]]])
    const calls = { informs: [], warns: [], routes: [] }
    const recordsById = new Map([['m-780', record('m-780', 780)], ['m-781', record('m-781', 781)]])
    const fires = []
    let engine
    const theDrain = makeDrain(stateDir, () => engine, recordsById, calls)
    engine = makeEngine(stateDir, seqs, calls, {
      discriminator: 'throw',
      gateWakeDelayMs: 40,
      onDelivered: (recipientId) => { fires.push(recipientId); void theDrain(recipientId) }
    })

    // PRE-FIX: the throw left `headNoWake` undefined, the gate applied, and the
    // delivery RETURNED without programming anything — the retained pair waited
    // for third-party traffic (or the 10-min clock) while the ledger showed the
    // SAME shape as a correct crash-class retention.
    const status = await engine.deliverOrQueue(H, record('m-781', 781), {})
    assert.equal(status, 'prepared', 'the retention is preserved (a throwing reader never delivers ahead of the head)')
    assert.ok(calls.warns.some((w) => /no-wake-head discriminator failed/.test(w)), 'the existing fail-soft warn is intact')

    const ledger = await readGateLedger(stateDir)
    const hold = ledger.find((r) => r.kind === 'gate-verdict' && r.verdict === 'hold-gated')
    assert.ok(hold !== undefined, 'the hold verdict landed')
    assert.equal(hold.headNoWake, 'throw', 'THE ASYMMETRY IS CLOSED: the ledger NAMES the failure (a legitimate crash-class head reads "false"; a lost waker reads "throw"/"dep-absent")')
    assert.equal(hold.wakeArmed, true, 'AND the release is programmed ANYWAY — the fix does not depend on the discriminator resolving')
    assert.equal(hold.wakeKey, 'm-780', 'keyed to the gating head')

    const fired = await waitUntil(() => fires.length >= 1, 2000)
    assert.ok(fired, 'the programmed wake FIRED despite the throwing reader (a silent failure can no longer park the pair)')
    assert.deepEqual(calls.routes, ['m-780', 'm-781'], 'and the FIFO unwound head-first: the order the gate defends, preserved through the failure')
  })
})
