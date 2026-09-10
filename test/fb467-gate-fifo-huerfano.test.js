// dsh-deepartments — LANE fb-467 (2026-09-10, run token f76ac64b): «el GATEADO
// NUNCA SE ENRUTA cuando la cabeza cierra por un HUÉRFANO».
//
// MECHANISM (the measured base, delivery.ts:482/:535-588 + messages.ts:1476-1517):
//   `deliverOrQueue`'s fb-117 FIFO gate fires when the recipient has an
//   EARLIER-seq pair whose pair-LATEST row is still 'prepared'. The gate branch
//   marks THIS pair 'prepared' and `return 'prepared'` — BEFORE the catalog
//   route (delivery.ts:611/:614) — so the gated record NEVER reaches the route.
//   That is CORRECT while the gating head is a genuine pending pair of an
//   address that can still receive: the pair waits and the FIFO unwinds at the
//   head's resolution. The variant NOT covered (this lane):
//
//   THE ORPHAN HEAD — the head `h` was addressed to a RETIRED host-family
//   address R whose rotation chain resolves a LIVE SUCCESSOR S. The engine
//   re-routes to S (fb-58 F-3) and the content LANDS AT S — while the R pair's
//   write-ahead row stays 'prepared': the DRENAJE terminalization needs the
//   successor's pair to be ALREADY landed when the final mark runs, and the
//   successor's landing is +37 s LATER (the measured window overlap, family
//   fb-117/fb-137: «filas `prepared` sin terminal»). From then on:
//     - R's pair-latest stays 'prepared' FOREVER: the sweep holds it by the B3
//       dormancy guard (production `recipientDormantForRedeliver` → a retired
//       host keeps its `sleepEpoch` and has no live handle ⇒ dormant forever),
//       the drain never fires (R NEVER wakes again) and the next boot pass
//       re-evaluates the same guard ⇒ a `prepared` row without a terminal.
//     - every pair BEHIND it (later seq at R) is therefore gated FOREVER: the
//       send path degrades it to 'prepared' before the route, and the sweep's
//       fb-132 hold counts it `gatedHeld` on every pass — the head it sees is
//       always the same orphan residue. THE GATED PAIR NEVER REACHES THE ROUTE
//       ⇒ its content never lands at S (the live successor the sender cannot
//       name) and its R pair never closes.
//
// DISCRIMINATOR (this lane): WHERE the head closed. The head closed AT THE
//   SUCCESSOR S — an address its own record never addressed — not at R. The
//   ledger fingerprint is exactly that: the gating head's pair-LATEST at S is
//   LANDED ('delivered'|'resumed') while its pair-latest at R is 'prepared'
//   (and S is not an addressee of the head's record, so a multi-recipient
//   fan-out sibling can never be mistaken for the reroute).
//
// GUARD (preserved byte-identically — the CONTROL gate the host fixed):
//   (a) a SANE head (its pair-latest at the addressed recipient is 'prepared'
//       and it has NOT landed anywhere outside its addressees) keeps the gate
//       EXACTLY as today: 'prepared', no route, the sweep's `gatedHeld` hold,
//       and the FIFO unwinding at the head's resolution;
//   (b) an ORPHAN head that has NOT landed at S yet (inside the window) also
//       keeps today's behavior (no over-rescue, no duplicate content);
//   (c) the B3 dormancy hold of a dormant POST (a real sleepEpoch) is untouched;
//   (d) `headNoWake === true` (m-2415), `interrupt === true`, `materialized
//       === false`, `batchEligible && running` and every fail-soft throw path
//       are untouched.
//
// FIXTURE: deterministic — the two addresses R/S are FIXTURE ids, never live
// ids (`m-100`/`m-101`/… are fixture records); the REAL seams `createDeliveryEngine`
// (delivery.ts) and `DeliveryRedeliverer` (messages.ts) run over a temp stateDir
// with stub deps only (0 builds, 0 real APIs — the lane discipline).
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
  gatingHeadIsNoWake,
  deliveryStatus
} from '../packages/dshd-core/src/messages.ts'
// The SEND-path engine: imported DYNAMICALLY (the module hook must be registered
// first — a static import is hoisted above it and the src graph fails to link).
const { createDeliveryEngine } = await import('../packages/dshd-core/src/delivery.ts')

// ---------------------------------------------------------------------------
// The fixture addresses (deterministic, never live ids):
//   R — the ORPHAN: a RETIRED host-family address whose rotation chain resolves
//       the live successor S (production `resolveCatalogRoute` → kind 'reroute').
//   S — the live successor (where the re-route actually delivers the content).
//   H — a SANE recipient (a live post, route kind 'post' — the CONTROL).
// ---------------------------------------------------------------------------
const R = 'host-session-orphan-retired'
const S = 'host-session-live-successor'
const H = 'sane-head-post'
const D = 'dormant-head-post'
const SENDER = 'sender-head'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb467-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

function row(messageId, recipientId, status, ts, noWake) {
  return noWake === true ? { messageId, recipientId, status, ts, noWake } : { messageId, recipientId, status, ts }
}

function record(id, seq, to, from = SENDER) {
  return { id, seq, ts: 1_000, from, to, text: `msg ${id}`, kind: 'agent' }
}

async function seed(stateDir, { records = [], rows = [] } = {}) {
  if (records.length > 0) await writeFile(resolveMessagesPath(stateDir), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  if (rows.length > 0) await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

async function readRows(stateDir) {
  return parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
}

function countPair(rows, messageId, recipientId, status) {
  return rows.filter((r) => r.messageId === messageId && r.recipientId === recipientId && r.status === status).length
}

/** The production catalog route of the FIXTURE catalog: the retired host-family
 * address R re-routes to the live successor S; H is a SANE live post; D is a
 * dormant (SANE) post. */
function catalogRoute(recipientId) {
  if (recipientId === R) return { kind: 'reroute', entry: { hostId: S, sessionId: 'session-successor', retired: false } }
  if (recipientId === H || recipientId === D) return { kind: 'post', entry: { postId: recipientId, sessionId: `session-${recipientId}`, retired: false, provider: 'head' } }
  return { kind: 'unknown' }
}

/** The REAL delivery engine (delivery.ts) wired like the production bundle
 * (index.ts): the two sidecar marks on the temp stateDir, the REAL pure gate
 * predicates over the CURRENT sidecar, and the wake primitives replaced by
 * stubs that mark the pair of the recipient they ACTUALLY delivered to (the
 * successor for a re-route — the production host primitive's own row). */
function makeEngine(stateDir, seqsByRecipient, calls) {
  const gateRows = async () => parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
  return createDeliveryEngine({
    stateDir,
    logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
    markPrepared: (record, recipientId, opts) => markDelivery(stateDir, record.id, recipientId, 'prepared', Date.now(), opts?.noWake === true),
    markFinal: (record, recipientId, status, opts) => markDelivery(stateDir, record.id, recipientId, status, Date.now(), opts?.noWake === true),
    resolveChild: async () => false,
    deliverChild: async () => 'delivered',
    resolveCatalogRoute: catalogRoute,
    busProfileFor: (memberId) => (memberId === SENDER ? { kind: 'head', memberId, departmentId: 'dept' } : { kind: 'unclassified', memberId }),
    deliverPost: async (entry, framed, rec) => {
      calls.routes.push({ id: rec.id, target: entry.postId })
      await markDelivery(stateDir, rec.id, entry.postId, 'delivered')
      return 'delivered'
    },
    deliverHost: async (entry, framed, rec) => {
      calls.routes.push({ id: rec.id, target: entry.hostId })
      await markDelivery(stateDir, rec.id, entry.hostId, 'delivered')
      return 'delivered'
    },
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
    earlierHeadIsNoWake: async (recipientId, seq) => gatingHeadIsNoWake(await gateRows(), (r) => seqsByRecipient.get(r) ?? [], recipientId, seq),
    // VARIANTE (i) — the measured live case: the gate APPLIES (the addressee is
    // a catalog address; the retired host resolves as materialized for the
    // engine's probe — the 2 'prepared' rows measured on the live head).
    recipientMaterialized: () => true,
    recipientRunningLive: () => false
  })
}

/** The lane-style `DeliveryRedeliverer` harness whose re-drive seam is the REAL
 * engine (`deliver`), with the PRODUCTION liveness predicates of the fixture:
 *   - `recipientAlive(R) === true` — the production `recipientCatalogAlive`:
 *     a RETIRED host whose rotation chain still resolves a LIVE successor is
 *     ALIVE (fb-58 F-3) ⇒ the sweep NEVER settles it dead;
 *   - `recipientDormant(R) === true` — the production
 *     `recipientDormantForRedeliver`: the retired host kept its `sleepEpoch`
 *     and has no live handle ⇒ DORMANT for the re-drive (the B3 hold);
 *   - H: a SANE live recipient (not dormant); D: a SANE dormant post. */
function redeliverer(stateDir, engine, recordsById, calls, seqsByRecipient, overrides = {}) {
  const sweepRows = async () => parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
  const deps = {
    stateDir,
    logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
    recipientAlive: () => true,
    recipientDormant: (id) => id === R || id === D,
    recipientRunning: () => false,
    getRecord: async (id) => recordsById.get(id) ?? undefined,
    resolveCallerSessionId: (from) => from,
    deliver: async (record, recipientId, callerSessionId) => {
      calls.deliver.push({ messageId: record.id, recipientId })
      return await engine.deliverOrQueue(recipientId, record, { senderSessionId: callerSessionId })
    },
    // The PRODUCTION gate wiring of the sweep (tools.ts:6359+ — the same pure
    // predicates the engine uses, over the SAME sidecar).
    pendingEarlierSeq: async (recipientId, seq) => hasEarlierPendingPair(await sweepRows(), (r) => seqsByRecipient.get(r) ?? [], recipientId, seq),
    earlierHeadIsNoWake: async (recipientId, seq) => gatingHeadIsNoWake(await sweepRows(), (r) => seqsByRecipient.get(r) ?? [], recipientId, seq),
    ...overrides
  }
  const r = new DeliveryRedeliverer(deps, {
    baseDelayMs: 15_000, maxDelayMs: 600_000, maxAttempts: 12, stormWindowMs: 3600_000,
    preparedStuckMs: 600_000, g2DrainSeedLimit: 250, legacyAgeMs: 600_000
  })
  r.__calls = calls
  return r
}

// ---------------------------------------------------------------------------
// A — the SEND PATH: the gated pair behind the ORPHAN head reaches the route.
//   RED today (measured base): the gate branch marks 'prepared' and returns
//   BEFORE the route ⇒ 'prepared', NO delivered row at S, the R pair 'prepared'.
//   GREEN with the fix: the route is reached, the content lands at the LIVE
//   SUCCESSOR S (the re-route) and the R pair closes 'terminal' (the DRENAJE
//   orphan closure — a pure status flip, never a re-delivery).
// ---------------------------------------------------------------------------
test('fb-467 (A): a delivery FIFO-GATED behind an ORPHAN HEAD reaches the ROUTE — it lands at the live SUCCESSOR S and the retired id\'s pair closes \'terminal\' (RED today: \'prepared\', never routed)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const recHead = record('m-100', 100, [R])
    const recFollower = record('m-101', 101, [R])
    await seed(stateDir, {
      records: [recHead, recFollower],
      rows: [
        // The head's ORPHAN RESIDUE: the addressed R pair stays 'prepared'
        // (no terminal) while the content ALREADY landed at the successor S
        // +37 s later — the measured window overlap (family fb-117/fb-137).
        row('m-100', R, 'prepared', T0 - 40 * 60_000),
        row('m-100', S, 'delivered', T0 - 40 * 60_000 + 37_000),
        // The GATED pair behind it: parked 'prepared' by the gate branch.
        row('m-101', R, 'prepared', T0 - 40 * 60_000)
      ]
    })
    const seqsByRecipient = new Map([[R, [100, 101]]])
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, seqsByRecipient, calls)

    const status = await engine.deliverOrQueue(R, recFollower, {})
    const rows = await readRows(stateDir)
    assert.equal(status, 'delivered', 'the gated-behind-an-orphan delivery REACHES the route (today \'prepared\' — the gate returned before the route)')
    assert.equal(await deliveryStatus(stateDir, 'm-101', S), 'delivered', 'the content LANDS at the LIVE SUCCESSOR S (the re-route)')
    assert.equal(await deliveryStatus(stateDir, 'm-101', R), 'terminal', 'the retired id\'s pair closes \'terminal\' (the DRENAJE orphan closure — pure status flip)')
    assert.equal(countPair(rows, 'm-100', S, 'delivered'), 1, 'the head is NEVER re-delivered (its content was already at S: the window overlap, not a lost message)')
    assert.deepEqual(calls.routes, [{ id: 'm-101', target: S }], 'exactly ONE route ran, to the live successor S')
  })
})

// ---------------------------------------------------------------------------
// B — the SWEEP: the ALREADY-stranded pair (gated before the head landed) is
//   rescued, and the head's orphan residue gets its terminal (the pure flip —
//   NEVER a re-drive: re-driving it would duplicate the content at S).
// ---------------------------------------------------------------------------
test('fb-467 (B): the sweep RESCUES the already-stranded pair behind the orphan head — the residue gets its terminal (pure flip, no re-delivery) and the pair behind it re-drives to the live SUCCESSOR', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const recHead = record('m-100', 100, [R])
    const recFollower = record('m-101', 101, [R])
    await seed(stateDir, {
      records: [recHead, recFollower],
      rows: [
        row('m-100', R, 'prepared', T0 - 40 * 60_000),
        row('m-100', S, 'delivered', T0 - 40 * 60_000 + 37_000),
        row('m-101', R, 'prepared', T0 - 40 * 60_000)
      ]
    })
    const seqsByRecipient = new Map([[R, [100, 101]]])
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, seqsByRecipient, calls)
    const recordsById = new Map([['m-100', recHead], ['m-101', recFollower]])
    const sweepCalls = { deliver: [], informs: [], warns: [], routes: [] }
    const r = redeliverer(stateDir, engine, recordsById, sweepCalls, seqsByRecipient)

    await r.sweepDue(T0)
    const rows = await readRows(stateDir)
    assert.equal(await deliveryStatus(stateDir, 'm-100', R), 'terminal', 'the orphan residue\'s final word is \'terminal\' (a pure STATUS FLIP — no re-delivery of already-landed content)')
    assert.equal(countPair(rows, 'm-100', S, 'delivered'), 1, 'the head was NEVER re-delivered to S (the flip appends no delivered row)')
    assert.equal(await deliveryStatus(stateDir, 'm-101', S), 'delivered', 'the pair stranded behind the orphan head REACHES the route and lands at the live successor')
    assert.equal(await deliveryStatus(stateDir, 'm-101', R), 'terminal', 'its retired-id pair closes \'terminal\' (the orphan closure)')
    assert.deepEqual(sweepCalls.deliver.map((d) => d.messageId), ['m-101'], 'exactly ONE re-drive (the stranded pair); the residue is settled, never driven')
    // A second pass is a no-op (nothing is left 'prepared' for R).
    const total = rows.length
    await r.sweepDue(T0 + 61_000)
    assert.equal((await readRows(stateDir)).length, total, 'the next pass appends NOTHING (both pairs are settled — no spool growth)')
  })
})

// ---------------------------------------------------------------------------
// C — the CONTROL (the host's literal gate): a SANE head settles EXACTLY as
//   today, and the FIFO still unwinds pair by pair at the head's resolution.
// ---------------------------------------------------------------------------
test('fb-467 (C-CONTROL): a SANE head settles EXACTLY as today — the gate holds the pair behind it (\'prepared\', no route), the sweep reports gatedHeld (no settle, no re-mark), and the FIFO unwinds when the head lands', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const recSane = record('m-200', 200, [H])
    const recBehind = record('m-201', 201, [H])
    await seed(stateDir, {
      records: [recSane, recBehind],
      rows: [
        // A SANE pending head that is FRESH (< the 10-min prepared-stuck
        // criterion — the fb-132 (iii) shape: not due, so only the pair BEHIND
        // it exercises the gate) and the STALE pair behind it.
        row('m-200', H, 'prepared', T0 - 5 * 60_000),
        row('m-201', H, 'prepared', T0 - 40 * 60_000)
      ]
    })
    const seqsByRecipient = new Map([[H, [200, 201]]])
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, seqsByRecipient, calls)
    const recordsById = new Map([['m-200', recSane], ['m-201', recBehind]])
    const sweepCalls = { deliver: [], informs: [], warns: [], routes: [] }
    const r = redeliverer(stateDir, engine, recordsById, sweepCalls, seqsByRecipient)

    // (1) The sweep holds the SANE-gated pair (the fb-132 2nd-half criterion):
    //     gatedHeld, NO deliver, zero new rows.
    await r.sweepDue(T0)
    let rows = await readRows(stateDir)
    assert.equal(sweepCalls.deliver.length, 0, 'the sweep NEVER drives a pair gated by a SANE pending head (unchanged)')
    assert.equal(countPair(rows, 'm-201', H, 'prepared'), 1, 'the held pair keeps its row — no settle, no re-mark (the fb-132 2nd-half criterion)')
    assert.equal(countPair(rows, 'm-201', H, 'terminal'), 0, 'no terminal settle for the SANE hold (a settle would LOSE the pair)')
    assert.ok(r.__calls.informs.some((l) => /m-201 → sane-head-post \(was prepared\) held gatedHeld/.test(l)), 'the SANE hold is still reported gatedHeld (unchanged log class)')
    assert.deepEqual(r.sweepState(), {
      cycles: 1,
      lastCycleTs: T0,
      preparedStuckRemaining: 1,
      oldestPreparedTs: T0 - 40 * 60_000,
      dormantHeld: 0,
      noWakeHeld: 0,
      gatedHeld: 1
    }, 'the SANE sweep summary is EXACTLY today\'s (gatedHeld 1, dormant 0, noWake 0)')

    // (2) The SANE gate on the SEND path: 'prepared' + the write-ahead/gate rows,
    //     the route NEVER reached — byte-identical to the pre-fix behavior.
    const status = await engine.deliverOrQueue(H, recBehind, {})
    assert.equal(status, 'prepared', 'a SANE pending head keeps the gate: the delivery degrades to the queue (\'prepared\') exactly as today')
    assert.deepEqual(calls.routes, [], 'the route is NEVER reached for a SANE head (unchanged)')
    rows = await readRows(stateDir)
    assert.equal(countPair(rows, 'm-201', H, 'prepared'), 3, 'the gated send writes EXACTLY its two rows (the write-ahead + the gate branch) over the seeded one — unchanged (1 seeded + 2)')
    assert.equal(countPair(rows, 'm-201', H, 'delivered'), 0, 'no landed row is invented for the held pair')
    assert.equal(countPair(rows, 'm-200', H, 'prepared'), 1, 'the SANE head is untouched (its pair-latest stays the pending \'prepared\')')
    assert.equal(await deliveryStatus(stateDir, 'm-200', H), 'prepared', 'the SANE head is still pending (the gate\'s cause intact)')

    // (3) The FIFO unwinds at the head's resolution (the designed sequence).
    assert.equal(await engine.deliverOrQueue(H, recSane, {}), 'delivered', 'the SANE head lands (its own pair)')
    assert.equal(await deliveryStatus(stateDir, 'm-200', H), 'delivered', 'the SANE head\'s pair-latest is delivered')
    await r.sweepDue(T0 + 700_000)
    assert.equal(await deliveryStatus(stateDir, 'm-201', H), 'delivered', 'the pair behind the SANE head re-drives genuinely once the head lands (the FIFO unwinds — unchanged)')
    assert.deepEqual(sweepCalls.deliver.map((d) => d.messageId), ['m-201'], 'the unwinding drove exactly the pair behind the head')
  })
})

// ---------------------------------------------------------------------------
// D — the CONTROL-2 (the FENCE): an ORPHAN head that has NOT landed at S yet
//   (inside the +37 s window) keeps today's behavior — no over-rescue, no
//   duplicate content, no reordering inside the window.
// ---------------------------------------------------------------------------
test('fb-467 (D-CONTROL): an ORPHAN head whose content has NOT landed at the successor yet keeps the gate EXACTLY as today (the window fence — no over-rescue, no duplicate)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const recHead = record('m-300', 300, [R])
    const recBehind = record('m-301', 301, [R])
    await seed(stateDir, {
      records: [recHead, recBehind],
      rows: [
        row('m-300', R, 'prepared', T0 - 40 * 60_000), // the orphan head IN FLIGHT (nothing landed at S yet)
        row('m-301', R, 'prepared', T0 - 40 * 60_000)
      ]
    })
    const seqsByRecipient = new Map([[R, [300, 301]]])
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, seqsByRecipient, calls)

    const status = await engine.deliverOrQueue(R, recBehind, {})
    assert.equal(status, 'prepared', 'the window fence: the gate still HOLDS (unchanged — the head may still land at R)')
    assert.deepEqual(calls.routes, [], 'the route is NOT reached inside the window (no premature re-route)')
    const rows = await readRows(stateDir)
    assert.equal(countPair(rows, 'm-301', S, 'delivered'), 0, 'no content is duplicated at the successor inside the window')

    const recordsById = new Map([['m-300', recHead], ['m-301', recBehind]])
    const sweepCalls = { deliver: [], informs: [], warns: [], routes: [] }
    const r = redeliverer(stateDir, engine, recordsById, sweepCalls, seqsByRecipient)
    await r.sweepDue(T0)
    assert.equal(sweepCalls.deliver.length, 0, 'the sweep holds the pair behind the in-flight orphan head inside the window (unchanged — the B3 dormancy hold parks both)')
    assert.ok(r.__calls.informs.some((l) => /dormantHeld=2/.test(l)), 'the cycle summary still reports the two pairs as dormantHeld (unchanged classes)')
    assert.equal(await deliveryStatus(stateDir, 'm-301', R), 'prepared', 'the pair stays a drain candidate (never settled)')
    assert.deepEqual(r.sweepState(), {
      cycles: 1,
      lastCycleTs: T0,
      preparedStuckRemaining: 1,
      oldestPreparedTs: T0 - 40 * 60_000,
      dormantHeld: 2,
      noWakeHeld: 0,
      gatedHeld: 1
    }, 'the window-fence summary is EXACTLY today\'s (both pairs dormantHeld, the pair behind counted gatedHeld; only the head is prepared-stuck — the gated pair\'s write-ahead is fresh)')
  })
})

// ---------------------------------------------------------------------------
// E — the CONTROL-3: the B3 dormancy hold of a SANE dormant recipient (a real
//   sleepEpoch post) is untouched — only the ORPHAN class (content landed
//   outside the record's addressees) is rescued.
// ---------------------------------------------------------------------------
test('fb-467 (E-CONTROL): a SANE dormant recipient\'s \'prepared\' queue is still B3-held (dormantHeld) — the swap touches ONLY the orphan class', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const recDorm = record('m-400', 400, [D])
    await seed(stateDir, {
      records: [recDorm],
      rows: [row('m-400', D, 'prepared', T0 - 40 * 60_000)]
    })
    const seqsByRecipient = new Map([[D, [400]]])
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, seqsByRecipient, calls)
    const recordsById = new Map([['m-400', recDorm]])
    const sweepCalls = { deliver: [], informs: [], warns: [], routes: [] }
    const r = redeliverer(stateDir, engine, recordsById, sweepCalls, seqsByRecipient)
    await r.sweepDue(T0)
    assert.equal(sweepCalls.deliver.length, 0, 'a SANE dormant post is NEVER re-driven (B3 — its queue drains at its next REAL wake; unchanged)')
    assert.equal(await deliveryStatus(stateDir, 'm-400', D), 'prepared', 'its pair stays \'prepared\' (the drain candidate)')
    assert.deepEqual(r.sweepState(), {
      cycles: 1,
      lastCycleTs: T0,
      preparedStuckRemaining: 1,
      oldestPreparedTs: T0 - 40 * 60_000,
      dormantHeld: 1,
      noWakeHeld: 0,
      gatedHeld: 0
    }, 'the SANE dormant summary is EXACTLY today\'s (dormantHeld 1)')
  })
})
