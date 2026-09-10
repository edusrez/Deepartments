// dsh-deepartments — DRENAJE lane (run token 251c6342, 2026-09-10): the REROUTE
// TERMINALIZATION of the permanent-'prepared' ORPHAN pair.
//
// THE DEFECT (measured on the live ledger, /.deepartments/deliveries.jsonl):
//   A record addressed to a RETIRED host-family id is RE-ROUTED to the live
//   successor (fb-58 F-3 / m-331 — `host-session-<uuid>` means "the Asistente")
//   and DELIVERED TO THE SUCCESSOR — while the delivery engine's FINAL mark is
//   keyed to the RETIRED id (`recipientId`), i.e. to the id that can never
//   receive. The retired id's write-ahead 'prepared' row therefore stays
//   'prepared' FOREVER (`needsRedelivery`) even though the message WAS
//   delivered:
//     m-4028 → host-session-770e4262 'prepared'  + → host-session-e261ea63 'delivered'
//     m-4763 → host-session-496fa3fc 'prepared'  + → host-session-2afe31c8 'delivered'
//     m-4769 → host-session-496fa3fc 'prepared'  (+ the live host delivered)
//   ~24 h / 60.2 min / 58.7 min of permanent 'prepared' residue, re-arming the
//   ~10-min prepared-stuck sweep and the health watchdog on delivered messages.
//
// THE FIX (class-general, ORIGIN-INDEPENDENT — the engine owns it): after a
//   LANDED reroute ('delivered' | 'resumed'), the engine reads the SUCCESSOR's
//   pair status and, when it landed, marks the RETIRED id's pair 'terminal' —
//   a PURE STATUS FLIP, never a re-delivery (the content is already delivered).
//   Class, not symptom: it holds for EVERY caller (send_message / boot re-drive
//   / sweep / drain) and for ANY future variant of "retired address with a live
//   successor", because the seam is the ONE reroute branch of the engine.
//
// These tests are src-native (ts-src-loader, 0 builds, temp stateDir, stub deps).
import { register } from 'node:module'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const { createDeliveryEngine } = await import('../packages/dshd-core/src/delivery.ts')
const { markDelivery, parseDeliveryRows, resolveDeliveriesPath, deliveryStatus } = await import('../packages/dshd-core/src/messages.ts')

const RETIRED = 'host-session-770e4262-f1c1-4490-b7e1-e2dc2bbca265'
const SUCCESSOR = 'host-session-e261ea63-74c6-466d-bf5a-2b9b4e8b69b8'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'w9-b255-reroute-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

async function readRows(stateDir) {
  return parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
}

function record(id, seq) {
  return { id, seq, ts: 1_700_000_000_000, from: 'the-host', to: [RETIRED], text: `probe ${id}`, kind: 'agent' }
}

/** The engine with the REAL reroute route shape (the resolver re-routes the
 * retired host id to the LIVE successor — exactly what `resolveBusCatalogRoute`
 * returns for a retired host entry with a live successor). */
function buildEngine(stateDir, { deliverHostImpl, calls }) {
  return createDeliveryEngine({
    stateDir,
    logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
    markPrepared: async (rec, recipientId, opts) => { calls.marks.push({ id: rec.id, recipientId, status: 'prepared' }); return markDelivery(stateDir, rec.id, recipientId, 'prepared', Date.now(), opts?.noWake === true) },
    markFinal: async (rec, recipientId, status, opts) => { calls.marks.push({ id: rec.id, recipientId, status }); return markDelivery(stateDir, rec.id, recipientId, status, Date.now(), opts?.noWake === true) },
    resolveChild: async () => false,
    deliverChild: async () => 'delivered',
    // THE REROUTE: the retired address resolves to the LIVE successor.
    resolveCatalogRoute: () => ({ kind: 'reroute', entry: { hostId: SUCCESSOR, sessionId: SUCCESSOR, retired: false } }),
    busProfileFor: () => ({ kind: 'host', memberId: 'the-host' }),
    deliverPost: async () => 'delivered',
    deliverHost: async () => deliverHostImpl(),
    recipientMaterialized: () => true
  })
}

test('w9-b255 (reroute-orphan): a LANDED reroute to the live successor TERMINALIZES the retired id\'s pair (pure status flip) — the permanent-\'prepared\' orphan class is closed at the reroute seam, and the delivery to the successor is UNCHANGED', async () => {
  await withTempStateDir(async (stateDir) => {
    const calls = { marks: [], informs: [], warns: [] }
    // The successor's pair REALLY lands (the stub marks it exactly like the
    // production host wake: the successor is marked 'delivered').
    const engine = buildEngine(stateDir, {
      calls,
      deliverHostImpl: async () => {
        await markDelivery(stateDir, REC.id, SUCCESSOR, 'delivered')
        return 'delivered'
      }
    })
    const REC = record('m-4028', 4028)
    const status = await engine.deliverOrQueue(RETIRED, REC, {})
    assert.equal(status, 'delivered', 'the reroute STILL delivers (the re-route to the successor is untouched — the message must keep reaching the live host)')
    const rows = await readRows(stateDir)
    assert.equal(await deliveryStatus(stateDir, 'm-4028', SUCCESSOR), 'delivered', 'the SUCCESSOR keeps its delivered pair (the real delivery is unchanged)')
    assert.equal(await deliveryStatus(stateDir, 'm-4028', RETIRED), 'terminal', 'the RETIRED id\'s pair is TERMINAL — the orphan is closed (HOY: it stayed \'prepared\' forever, the measured class)')
    assert.equal(rows.filter((x) => x.messageId === 'm-4028' && x.recipientId === RETIRED && x.status === 'terminal').length, 1, 'exactly ONE terminal row for the retired pair (settled once — never re-attempted)')
    assert.equal(rows.filter((x) => x.messageId === 'm-4028' && x.recipientId === RETIRED && x.status === 'prepared').length, 1, 'the write-ahead prepared row is still there as history (the flip is an APPEND — the ledger keeps its audit trail)')
    // NO RE-DELIVERY: the flip must never duplicate the successor's delivery.
    assert.equal(rows.filter((x) => x.messageId === 'm-4028' && x.recipientId === SUCCESSOR).length, 1, 'the successor pair has EXACTLY ONE row (its own landed delivery — the terminalization never re-delivers)')
    assert.equal(rows.filter((x) => x.messageId === 'm-4028' && x.recipientId === RETIRED).length, 2, 'the retired pair has exactly its history (write-ahead prepared + the terminal) — no extra row, no second delivery')
    assert.ok(calls.informs.some((l) => /reroute terminalization: m-4028 → retired host/.test(l)), 'the closure is observable in the log (the post-deploy exposure runs read it)')
  })
})

test('w9-b255 (reroute-orphan negative): a reroute that did NOT land (the successor delivery FAILED) leaves the retired pair \"prepared\" — the fix never closes a pair that was not delivered', async () => {
  await withTempStateDir(async (stateDir) => {
    const calls = { marks: [], informs: [], warns: [] }
    const engine = buildEngine(stateDir, { calls, deliverHostImpl: async () => 'failed' })
    const status = await engine.deliverOrQueue(RETIRED, record('m-9001', 9001), {})
    assert.equal(status, 'failed', 'the failed reroute keeps its own semantics')
    assert.equal(await deliveryStatus(stateDir, 'm-9001', RETIRED), 'failed', 'the retired pair stays \'failed\' (re-driveable by the sweep/backoff — NEVER terminalized on an unlanded reroute: closing it would LOSE the message)')
    assert.ok(!calls.informs.some((l) => /reroute terminalization/.test(l)), 'no terminalization fires (the gate is the LANDED status)')
  })
})

test('w9-b255 (reroute-orphan multi-recipient): a multi-recipient record with ONE rotated host id closes ONLY the rotated pair — every other recipient keeps its own final mark', async () => {
  await withTempStateDir(async (stateDir) => {
    const calls = { marks: [], informs: [], warns: [] }
    const other = 'post-worker-x'
    const engine = createDeliveryEngine({
      stateDir,
      logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
      markPrepared: async (rec, recipientId) => markDelivery(stateDir, rec.id, recipientId, 'prepared'),
      markFinal: async (rec, recipientId, status) => markDelivery(stateDir, rec.id, recipientId, status),
      resolveChild: async () => false,
      deliverChild: async () => 'delivered',
      // The retired host re-routes; the worker post is a plain post.
      resolveCatalogRoute: (id) => (id === RETIRED
        ? { kind: 'reroute', entry: { hostId: SUCCESSOR, sessionId: SUCCESSOR, retired: false } }
        : { kind: 'post', entry: { postId: other, sessionId: other, retired: false } }),
      busProfileFor: () => ({ kind: 'host', memberId: 'the-host' }),
      deliverPost: async () => { await markDelivery(stateDir, 'm-9100', other, 'delivered'); return 'delivered' },
      deliverHost: async () => { await markDelivery(stateDir, 'm-9100', SUCCESSOR, 'delivered'); return 'delivered' },
      recipientMaterialized: () => true
    })
    // send_message delivers per-recipient (the fan-out calls the seam once per
    // recipient) — the N-recipient case that produced N-1 finals + 1 orphan.
    assert.equal(await engine.deliverOrQueue(other, record('m-9100', 9100), {}), 'delivered', 'the non-rotated recipient delivers normally')
    assert.equal(await engine.deliverOrQueue(RETIRED, record('m-9100', 9100), {}), 'delivered', 'the rotated recipient is re-routed and delivered to the successor')
    assert.equal(await deliveryStatus(stateDir, 'm-9100', other), 'delivered', 'the worker pair keeps its final mark')
    assert.equal(await deliveryStatus(stateDir, 'm-9100', SUCCESSOR), 'delivered', 'the successor pair is delivered')
    assert.equal(await deliveryStatus(stateDir, 'm-9100', RETIRED), 'terminal', 'ONLY the rotated pair is terminalized (N recipients → N closed pairs: NO orphan left)')
  })
})
