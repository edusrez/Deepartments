// dsh-deepartments — LANE (B) (2026-09-17, run token 79c9bdbb): THE NO-WAKE
// CENSUS with the CORRECTED FILTER (`noWake === true`, ANY status) and its TWO
// DIRECTIONS, src-native (temp stateDir + the lane2-style stub deps; 0 builds,
// 0 real APIs).
//
//   WHAT WAS WRONG: `summarizePreparedState` computed the no-wake census inside
//   a loop gated by `if (row.status !== 'prepared') continue` — so a SEALED pair
//   whose latest row was anything but 'prepared' was INVISIBLE to the census,
//   even though the P2 guard reads exactly that seal on exactly that row
//   (`if (row.noWake === true && recipientRunning !== true) return` — no status
//   filter). And the seal is imposed by the ROUTE, not only requested by the
//   sender: `delivery.ts` seals `opts.noWake === true || routeOut.deferred ===
//   true`, so an ALWAYS-WAKE sender can end up holding a sealed pair it never
//   asked for. Measured 2026-09-17 on the real ledger
//   `/.deepartments/deliveries.jsonl`: 21 sealed+prepared vs 528 sealed pairs
//   (505 `self`, 2 `failed`) — the narrow filter dropped 507 of them.
//
//   THE TWO DIRECTIONS (the criterion is the house's OWN re-deliverability
//   predicate, so it cannot drift from the engine): split by
//   `needsRedelivery(row.status)` —
//     AWAKE   (`prepared` | `failed`): still on the sweep's wheel, a wake is
//             still possible; the pair exists to WAKE someone;
//     CLOSING (every settled status: `self` | `terminal` | `delivered` |
//             `resumed`): the pair can never wake again — it survives only as
//             the durable record of a CLOSED intent (`self` is the ack-loop
//             guard: persisted, never materialized, never re-delivered — the
//             self-directed / retire seal).
//   Invariant BY CONSTRUCTION: noWakeAwake + noWakeClosing === noWakeHeld.
//
//   INSTRUMENTATION, NOT POLICY: this test FREEZES the decision outputs (the
//   deliver calls, every resulting sidecar row, preparedStuckRemaining,
//   oldestPreparedTs, dormantHeld, gatedHeld) to the values the PRE-change
//   engine produced for this same fixture (differential harness, run token
//   79c9bdbb: decision outputs identical = true; only the census fields moved,
//   by exactly the dropped-class size).
import { register } from 'node:module'

register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const C = await import('../packages/dshd-core/src/messages.ts')
const { DeliveryRedeliverer, markDelivery, needsRedelivery, parseDeliveryRows, resolveDeliveriesPath } = C

const T0 = 1_700_000_000_000
const OLD_TS = T0 - 15 * 60_000

const row = (messageId, recipientId, status, ts, noWake) => (noWake === true ? { messageId, recipientId, status, ts, noWake } : { messageId, recipientId, status, ts })

// The fixture strikes EVERY sweep decision path AND carries sealed pairs of
// every status — so a census that is still narrow CANNOT produce these numbers.
const FIXTURE = [
  // AWAKE + sealed, held by the P2 no-wake guard (recipient not running)
  row('m-seal-idle', 'rx-nowake-idle', 'prepared', OLD_TS, true),
  // AWAKE + sealed, recipient DORMANT (B3 guard)
  row('m-seal-dorm', 'rx-nowake-dormant', 'prepared', OLD_TS, true),
  // AWAKE + sealed, recipient RUNNING — the ONLY drain: the pair really lands
  row('m-seal-run', 'rx-nowake-running', 'prepared', OLD_TS, true),
  // AWAKE + sealed + 'failed' — needsRedelivery, but the P2 guard skips it
  row('m-seal-failed', 'rx-nowake-failed', 'failed', OLD_TS, true),
  // CLOSING + sealed — settled statuses: never re-driven, never woken
  row('m-seal-self', 'rx-self', 'self', OLD_TS, true),
  row('m-seal-term', 'rx-term', 'terminal', OLD_TS, true),
  row('m-seal-deliv', 'rx-delivered', 'delivered', OLD_TS, true),
  // The crash class (NO seal) — re-driven; the decision the census must not touch
  row('m-crash', 'rx-crash', 'prepared', OLD_TS),
  // FIFO-gated (fb-132): an EARLIER pending pair of an ALIVE recipient
  row('m-head', 'rx-gated', 'prepared', OLD_TS),
  row('m-follower', 'rx-gated', 'prepared', OLD_TS),
  // Shadowed sealed dust — the G2 settle flips it to 'terminal' KEEPING the seal
  row('m-dust', 'rx-dust', 'prepared', OLD_TS, true),
  row('m-dust', 'rx-dust', 'delivered', OLD_TS + 1000)
]

const RECORDS = new Map([
  ['m-seal-idle', { id: 'm-seal-idle', seq: 10, ts: T0, from: 'ipd', to: ['rx-nowake-idle'], text: 'x', kind: 'agent' }],
  ['m-seal-dorm', { id: 'm-seal-dorm', seq: 11, ts: T0, from: 'ipd', to: ['rx-nowake-dormant'], text: 'x', kind: 'agent' }],
  ['m-seal-run', { id: 'm-seal-run', seq: 12, ts: T0, from: 'ipd', to: ['rx-nowake-running'], text: 'x', kind: 'agent' }],
  ['m-seal-failed', { id: 'm-seal-failed', seq: 13, ts: T0, from: 'ipd', to: ['rx-nowake-failed'], text: 'x', kind: 'agent' }],
  ['m-crash', { id: 'm-crash', seq: 14, ts: T0, from: 'ipd', to: ['rx-crash'], text: 'x', kind: 'agent' }],
  ['m-head', { id: 'm-head', seq: 20, ts: T0, from: 'ipd', to: ['rx-gated'], text: 'x', kind: 'agent' }],
  ['m-follower', { id: 'm-follower', seq: 21, ts: T0, from: 'ipd', to: ['rx-gated'], text: 'x', kind: 'agent' }],
  ['m-dust', { id: 'm-dust', seq: 22, ts: T0, from: 'ipd', to: ['rx-dust'], text: 'x', kind: 'agent' }]
])

const DORMANT = new Set(['rx-nowake-dormant'])
const RUNNING = new Set(['rx-nowake-running'])

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'laneB-nowake-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

/** The lane2-style DeliveryRedeliverer over a temp stateDir (stub deps). */
function redeliverer(stateDir) {
  const calls = { deliver: [] }
  const deps = {
    stateDir,
    logger: { info() {}, warn() {} },
    recipientAlive: () => true,
    recipientDormant: (id) => DORMANT.has(id),
    recipientRunning: (id) => RUNNING.has(id),
    getRecord: async (id) => RECORDS.get(id),
    resolveCallerSessionId: (from) => from,
    deliver: async (record, recipientId) => {
      calls.deliver.push(`${record.id}->${recipientId}`)
      await markDelivery(stateDir, record.id, recipientId, 'delivered')
      return 'delivered'
    },
    // The fb-132 FIFO gate: 'rx-gated' has an EARLIER pending pair (m-head, seq 20).
    pendingEarlierSeq: async (recipientId, seq) => recipientId === 'rx-gated' && seq > 20
  }
  const r = new DeliveryRedeliverer(deps, {
    baseDelayMs: 15_000, maxDelayMs: 600_000, maxAttempts: 12, stormWindowMs: 3_600_000,
    preparedStuckMs: 600_000, g2DrainSeedLimit: 250, legacyAgeMs: 600_000
  })
  r.__calls = calls
  return r
}

test('LANE (B) — the no-wake census reads the seal on ANY status (0→N on the dropped class) and splits it into AWAKE vs CLOSING by `needsRedelivery`; the sweep decisions are UNCHANGED', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(resolveDeliveriesPath(stateDir), `${FIXTURE.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8')
    const r = redeliverer(stateDir)
    await r.sweepDue(T0)
    const state = r.sweepState()

    // ---- (1) THE CENSUS — corrected filter, RED-capable ------------------
    // The census reads the PAIR-LATEST view (shadowed dust never counts — the
    // m-dust pair's latest row is 'delivered', so it is NOT a sealed pair). The
    // narrow (pre-change) filter would have reported 3 (the sealed 'prepared'
    // pairs); the corrected census reports ALL 7 sealed pairs.
    const pairLatest = new Map()
    for (const x of FIXTURE) pairLatest.set(`${x.messageId}\u0000${x.recipientId}`, x)
    const narrowWouldBe = [...pairLatest.values()].filter((x) => x.noWake === true && x.status === 'prepared').length
    assert.equal(narrowWouldBe, 3, 'fixture sanity: the narrow filter (sealed & pair-latest prepared) would have counted 3 — the shadowed sealed dust is NOT one of them')
    assert.equal(state.noWakeHeld, 7, 'LANE (B): the corrected census counts the sealed pairs of EVERY status (3 sealed+prepared + 4 the narrow filter dropped: failed/self/terminal/delivered) — RED-capable, not a 0')

    // ---- (2) THE TWO DIRECTIONS -----------------------------------------
    assert.equal(state.noWakeAwake, 4, 'direction AWAKE: the sealed pairs still on the sweep wheel (prepared|failed — needsRedelivery true)')
    assert.equal(state.noWakeClosing, 3, 'direction CLOSING: the sealed pairs settled for good (self|terminal|delivered — the pair only ever closes)')
    assert.equal(state.noWakeAwake + state.noWakeClosing, state.noWakeHeld, 'the partition is TOTAL (awake + closing === noWakeHeld)')
    // The criterion IS the house predicate — asserted, not assumed.
    assert.equal(needsRedelivery('prepared'), true)
    assert.equal(needsRedelivery('failed'), true)
    for (const settled of ['self', 'terminal', 'delivered', 'resumed']) {
      assert.equal(needsRedelivery(settled), false, `\`${settled}\` is a CLOSING status (the pair can never wake again)`)
    }
    // REAL-shape cases, one per direction, read off the produced ledger.
    assert.ok(FIXTURE.some((x) => x.noWake === true && x.status === 'failed'), 'a real-shape AWAKE case: a sealed pair already in needsRedelivery')
    assert.ok(FIXTURE.some((x) => x.noWake === true && x.status === 'self'), 'a real-shape CLOSING case: the ack-loop/retire seal (self)')

    // ---- (3) NO BEHAVIOR CHANGE (frozen pre-change decision outputs) -----
    assert.deepEqual(r.__calls.deliver, ['m-crash->rx-crash', 'm-head->rx-gated', 'm-seal-run->rx-nowake-running'],
      'the re-drive/drain set is UNTOUCHED: the crash class + the no-wake HEAD (the ALWAYS-WAKE re-drive is the wake) + the sealed pair of a RUNNING recipient (the only drain)')
    assert.equal(state.preparedStuckRemaining, 3, 'the residue integer is UNCHANGED (the sealed+idle, sealed+dormant and gate-blocked follower stay held)')
    assert.equal(state.oldestPreparedTs, OLD_TS, 'oldestPreparedTs is UNCHANGED')
    assert.equal(state.dormantHeld, 1, 'dormantHeld (prepared-only class) is UNCHANGED')
    assert.equal(state.gatedHeld, 1, 'gatedHeld (prepared-only class) is UNCHANGED')
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    const statusOf = (messageId, recipientId) => rows.filter((x) => x.messageId === messageId && x.recipientId === recipientId).map((x) => x.status)
    // The P2 guard still holds a sealed 'prepared' pair into a non-running recipient.
    assert.deepEqual(statusOf('m-seal-idle', 'rx-nowake-idle'), ['prepared'], 'the sealed pair of an idle recipient is NOT re-driven (P2 holds — unchanged)')
    assert.deepEqual(statusOf('m-seal-dorm', 'rx-nowake-dormant'), ['prepared'], 'the sealed pair of a DORMANT recipient is NOT re-driven (B3 holds — unchanged)')
    assert.deepEqual(statusOf('m-seal-failed', 'rx-nowake-failed'), ['failed'], "the sealed 'failed' pair is skipped by the P2 guard (no new row — unchanged)")
    assert.deepEqual(statusOf('m-seal-self', 'rx-self'), ['self'], 'the ack-loop seal is never touched — unchanged')
    assert.deepEqual(statusOf('m-seal-term', 'rx-term'), ['terminal'], 'a settled terminal seal is never re-driven — unchanged')
    assert.deepEqual(statusOf('m-seal-deliv', 'rx-delivered'), ['delivered'], "a settled 'delivered' seal is never re-driven — unchanged")
    assert.deepEqual(statusOf('m-follower', 'rx-gated'), ['prepared'], 'the FIFO-gated follower stays held (fb-132 — unchanged)')
    // The G2 settle flip still KEEPS the seal (the census then sees it as CLOSING).
    const flipped = rows.find((x) => x.messageId === 'm-dust' && x.recipientId === 'rx-dust' && x.status === 'terminal')
    assert.ok(flipped !== undefined && flipped.noWake === true, 'the G2 flip still PRESERVES the noWake seal (unchanged)')
    assert.deepEqual(statusOf('m-seal-run', 'rx-nowake-running'), ['terminal', 'delivered'], 'the sealed pair of a RUNNING recipient still drains (the only exit — unchanged): its write-ahead row is the G2 settle\u2019s in-place flip once the drain shadowed it')
  })
})
