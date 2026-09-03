// dsh-deepartments — LANE ② (incident-delivery 2026-09-03) CUTS 2+3: the
// NON-BOOT re-drive sweep (no-restart recovery) + the per-pair EXPONENTIAL
// BACKOFF + MAX-ATTEMPTS stop-with-alert (fb-79 — the m-183 450-attempt /
// m-188 226-attempt retry storms had NO backoff).
//
// LANE ② DISCIPLINE: 0 builds — the tests exercise the SOURCE via Node's
// type-stripping + the self-registered ts-src-loader hook (see the gate test
// header); dshd-core/src/messages.ts is self-contained (no relative imports).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  DeliveryRedeliverer,
  redeliveryBackoffMs,
  redeliveryAttemptsExhausted,
  pairAttemptCount,
  RE_DELIVERY_DEFAULT_BASE_DELAY_MS,
  RE_DELIVERY_DEFAULT_MAX_DELAY_MS,
  RE_DELIVERY_DEFAULT_MAX_ATTEMPTS,
  RE_DELIVERY_PREPARED_STUCK_MS,
  resolveDeliveriesPath,
  resolveMessagesPath,
  markDelivery,
  deliveryStatus,
  parseDeliveryRows
} from '../packages/dshd-core/src/messages.ts'
import { readFile } from 'node:fs/promises'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'lane2-redrive-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

async function seed(stateDir, { records = [], rows = [] } = {}) {
  if (records.length > 0) await writeFile(resolveMessagesPath(stateDir), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  if (rows.length > 0) await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

function row(messageId, recipientId, status, ts) {
  return { messageId, recipientId, status, ts }
}

/** A thin redeliverer with injected stub deps over a temp stateDir. */
function redeliverer(stateDir, overrides = {}) {
  const calls = { deliver: [], terminaled: [], warns: [] }
  const deps = {
    stateDir,
    logger: { info: () => {}, warn: (m) => calls.warns.push(m) },
    recipientAlive: () => true,
    recipientDormant: () => false,
    getRecord: async (id) => Promise.resolve(calls[nextRecordKey(id)]),
    resolveCallerSessionId: (from) => from,
    deliver: async (record, recipientId) => {
      calls.deliver.push({ messageId: record.id, recipientId })
      // Mirror the delivery ENGINE's write-ahead side: the seam records the
      // final status row (deliverBusRecord → markFinal) — the redeliverer
      // itself is a driver over that seam, not a writer.
      await markDelivery(stateDir, record.id, recipientId, 'delivered')
      return 'delivered'
    },
    ...overrides
  }
  // getRecord resolves from a map keyed by messageId — the overrides carry it.
  calls.nextRecordKey = null
  const recordsById = new Map()
  deps.getRecord = async (id) => (recordsById.get(id) ?? undefined)
  Object.defineProperty(calls, 'recordsById', { value: recordsById })
  const r = new DeliveryRedeliverer(deps, {
    baseDelayMs: 15_000,
    maxDelayMs: 600_000,
    maxAttempts: 12,
    stormWindowMs: 3600_000,
    preparedStuckMs: 600_000
  })
  r.__calls = calls
  r.__records = (id, record) => recordsById.set(id, record)
  return r
}

test('LANE ② fb-79 (pure): the exponential backoff — 0 prior attempts → IMMEDIATE (the first re-drive is never delayed), then base, 2ⁱ, CAPPED at maxDelay; the aggregate cadence stays far under the 30/h alert + <3:1 ratio §7.5', () => {
  assert.equal(redeliveryBackoffMs(0), 0, '0 prior attempts → 0 delay (the gate-clean recovery is immediate)')
  assert.equal(redeliveryBackoffMs(1), RE_DELIVERY_DEFAULT_BASE_DELAY_MS, '1 prior attempt → the base delay')
  assert.equal(redeliveryBackoffMs(2), 2 * RE_DELIVERY_DEFAULT_BASE_DELAY_MS, '2 prior attempts → 2x base')
  assert.equal(redeliveryBackoffMs(3), 4 * RE_DELIVERY_DEFAULT_BASE_DELAY_MS, '3 prior attempts → 4x base')
  assert.equal(redeliveryBackoffMs(99), RE_DELIVERY_DEFAULT_MAX_DELAY_MS, 'a huge history is CAPPED at maxDelay (never grows/overflows)')
  // The §7.5 storm bound: a pair re-driven under the backoff cadence (0,15s,30s,
  // 60s,2m,4m,8m,10m-cap) accumulates ≤ 8 attempts in the first hour — below the
  // 30/h alert threshold; with ≥ 3 deliveries in the same hour the ratio is
  // ≤ 8/3 < 3:1 (and a message that delivers first-try has ratio 1:1).
  let t = 0
  let attemptsInHour = 0
  for (let prior = 0; prior < 20; prior++) {
    t += redeliveryBackoffMs(prior)
    if (t <= 3600_000) attemptsInHour++
  }
  assert.ok(attemptsInHour <= 12, `the backoff cadence bounds a failing pair to ${attemptsInHour} attempts/hour (≤ 12 — a 10×-orders-of-magnitude drop from the m-183 450 attempts; far under the 30/h alert threshold)`)
  assert.ok(attemptsInHour <= 30, 'the cadence stays under the storm alert (30 rows/messageId/1h) by construction')
  assert.ok(!redeliveryAttemptsExhausted(11, 12) && redeliveryAttemptsExhausted(12, 12) && redeliveryAttemptsExhausted(450, 12), 'the max-attempts stop fires at the cap (450 ≥ 12)')
  assert.equal(pairAttemptCount([
    row('m-1', 'a', 'prepared', 1000),
    row('m-1', 'a', 'failed', 2000),
    row('m-1', 'a', 'delivered', 3000),
    row('m-1', 'b', 'failed', 4000),
    row('m-2', 'a', 'failed', 5000)
  ], 'm-1', 'a', 10_000, 3600_000), 2, 'pairAttemptCount counts only the pair’s prepared/failed rows inside the window')
  assert.equal(pairAttemptCount([
    row('m-1', 'a', 'failed', 1000)
  ], 'm-1', 'a', 10_000, 3600_000), 1, 'one failed row = one attempt')
  assert.equal(pairAttemptCount([
    row('m-1', 'a', 'failed', 1000)
  ], 'm-1', 'a', 5000, 3600_000), 1, 'rows inside the window count')
})

test('LANE ② sweep (fb-79 + item 2): a DUE failed row to a LIVE recipient is RE-DRIVEN by the sweep (no boot!); a NOT-yet-due pair (backoff window) is left for a later sweep; the attempts/deliveries ledger grows by exactly ONE row per re-drive', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_700_000_000_000
    await seed(stateDir, {
      records: [{ id: 'm-1', seq: 0, ts: T0 - 60_000, from: 'ipd', to: ['head-idle'], text: 'report', kind: 'agent' }],
      rows: [row('m-1', 'head-idle', 'failed', T0 - 60_000)]
    })
    const r = redeliverer(stateDir)
    r.__records('m-1', { id: 'm-1', seq: 0, ts: T0 - 60_000, from: 'ipd', to: ['head-idle'], text: 'report', kind: 'agent' })
    // 1 prior attempt → the backoff (15 s) HAS elapsed (the row is 60 s old) → due.
    await r.sweepDue(T0)
    assert.equal(r.__calls.deliver.length, 1, 'the sweep re-drives the due failed pair (NO boot involved)')
    assert.deepEqual(r.__calls.deliver[0], { messageId: 'm-1', recipientId: 'head-idle' }, 'the re-drive targets the pair')
    assert.equal(await deliveryStatus(stateDir, 'm-1', 'head-idle'), 'delivered', 'the deliver stub records the final status (the pair is settled, the W6 scan silent)')
    // Idempotence: a second sweep over the now-delivered pair does nothing.
    await r.sweepDue(T0 + 61_000)
    assert.equal(r.__calls.deliver.length, 1, 'a settled pair is never re-driven')
    // NOT-yet-due: a fresh failure (0 s old, 1 prior) → the 15 s backoff has
    // NOT elapsed → the sweep SKIPS it (the storm cadence is structurally gone).
    await seed(stateDir, {
      records: [{ id: 'm-2', seq: 1, ts: T0, from: 'ipd', to: ['head-idle'], text: 'r', kind: 'agent' }],
      rows: [row('m-2', 'head-idle', 'failed', T0)]
    })
    r.__records('m-2', { id: 'm-2', seq: 1, ts: T0, from: 'ipd', to: ['head-idle'], text: 'r', kind: 'agent' })
    await r.sweepDue(T0)
    assert.equal(r.__calls.deliver.length, 1, 'a failed row inside its backoff window is NOT re-driven by the same-tick sweep')
    // After the backoff elapses (nowMs advances past the 15 s window) a later
    // sweep re-drives it.
    await r.sweepDue(T0 + 16_000)
    assert.equal(r.__calls.deliver.length, 2, 'a later sweep re-drives the pair once its backoff window elapsed (the exponential cadence)')
  })
})

test('LANE ② sweep (fb-58/a + fb-79): the MAX-ATTEMPTS STOP-WITH-ALERT — a pair with ≥ maxAttempts in the window settles ONE terminal + a loud WARN (the storm STOPS, the record stays durable); a DEAD recipient settles terminal once (even fresh); a DORMANT recipient’s prepared queue is NEVER re-driven (B3)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_700_000_000_000
    // Exhausted pair: 12 failed rows in the window (the m-183 class, bounded).
    const rows = []
    for (let i = 0; i < RE_DELIVERY_DEFAULT_MAX_ATTEMPTS; i++) rows.push(row('m-1', 'a', 'failed', T0 - 3600_000 + i * 1000))
    await seed(stateDir, {
      records: [{ id: 'm-1', seq: 0, ts: T0 - 3600_000, from: 'ipd', to: ['a'], text: 'r', kind: 'agent' }],
      rows
    })
    const r = redeliverer(stateDir)
    r.__records('m-1', { id: 'm-1', seq: 0, ts: T0 - 3600_000, from: 'ipd', to: ['a'], text: 'r', kind: 'agent' })
    await r.sweepDue(T0)
    assert.equal(r.__calls.deliver.length, 0, 'an exhausted pair is NEVER re-driven again')
    assert.equal(await deliveryStatus(stateDir, 'm-1', 'a'), 'terminal', 'the exhausted pair settles ONE terminal (the automatic re-drive STOPS)')
    assert.ok(r.__calls.warns.some((w) => /STOPPED after 12 attempts \(max 12\)/.test(w)), 'the stop is LOUD (stop-with-alert — the warn names the pair and the attempts)')
    // Dead recipient → terminal once, immediately (the W7-A rule: re-attempting
    // a dead recipient is pointless).
    await seed(stateDir, {
      records: [{ id: 'm-2', seq: 1, ts: T0, from: 'ipd', to: ['dead'], text: 'r', kind: 'agent' }],
      rows: [row('m-2', 'dead', 'failed', T0)]
    })
    const r2 = redeliverer(stateDir, { recipientAlive: () => false })
    r2.__records('m-2', { id: 'm-2', seq: 1, ts: T0, from: 'ipd', to: ['dead'], text: 'r', kind: 'agent' })
    await r2.sweepDue(T0)
    assert.equal(r2.__calls.deliver.length, 0, 'a dead recipient is never re-driven')
    assert.equal(await deliveryStatus(stateDir, 'm-2', 'dead'), 'terminal', 'a dead recipient settles one terminal once')
    // Dormant recipient + prepared → skipped (B3: its noWake queue waits for
    // its next REAL wake — the sweep must never wake it or double-deliver).
    await seed(stateDir, {
      records: [{ id: 'm-3', seq: 2, ts: T0 - 20 * 60_000, from: 'ipd', to: ['dormant'], text: 'r', kind: 'agent' }],
      rows: [row('m-3', 'dormant', 'prepared', T0 - 20 * 60_000)]
    })
    const r3 = redeliverer(stateDir, { recipientDormant: () => true })
    r3.__records('m-3', { id: 'm-3', seq: 2, ts: T0 - 20 * 60_000, from: 'ipd', to: ['dormant'], text: 'r', kind: 'agent' })
    await r3.sweepDue(T0)
    assert.equal(r3.__calls.deliver.length, 0, 'a DORMANT recipient’s prepared queue is NEVER re-driven (B3 noWake intent)')
    assert.equal(await deliveryStatus(stateDir, 'm-3', 'dormant'), 'prepared', 'the dormant pair stays queued (no terminal, no wake)')
  })
})

test('LANE ② sweep (fb-58/a + the 10-min criterion): a PREPARED row OLDER than preparedStuckMs to a LIVE non-dormant recipient is RE-DRIVEN (the crash-recovery class the boot-only re-drive parked until the next boot); a FRESH prepared row is left alone (the noWake queue grace — never double-delivered)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_700_000_000_000
    // Crash-class prepared: 20 min old (> 10 min) → the sweep re-drives it.
    await seed(stateDir, {
      records: [{ id: 'm-crash', seq: 0, ts: T0 - 20 * 60_000, from: 'ipd', to: ['head-live'], text: 'crash', kind: 'agent' }],
      rows: [row('m-crash', 'head-live', 'prepared', T0 - 20 * 60_000)]
    })
    const r = redeliverer(stateDir)
    r.__records('m-crash', { id: 'm-crash', seq: 0, ts: T0 - 20 * 60_000, from: 'ipd', to: ['head-live'], text: 'crash', kind: 'agent' })
    await r.sweepDue(T0)
    assert.equal(r.__calls.deliver.length, 1, 'a prepared row stuck > 10 min to a live recipient is RE-DRIVEN by the sweep (the fb-58 «0 prepared-stuck > 10 min» criterion)')
    // Fresh prepared (2 min old, LIVE recipient) → left alone (the noWake
    // queue grace / mid-delivery crash window).
    await seed(stateDir, {
      records: [{ id: 'm-nogo', seq: 1, ts: T0 - 120_000, from: 'ipd', to: ['head-live'], text: 'queue', kind: 'agent' }],
      rows: [row('m-nogo', 'head-live', 'prepared', T0 - 120_000)]
    })
    r.__records('m-nogo', { id: 'm-nogo', seq: 1, ts: T0 - 120_000, from: 'ipd', to: ['head-live'], text: 'queue', kind: 'agent' })
    await r.sweepDue(T0)
    assert.equal(r.__calls.deliver.length, 1, 'a FRESH prepared row (< 10 min) is NOT re-driven (never double-delivered/woken prematurely)')
    assert.equal(await deliveryStatus(stateDir, 'm-nogo', 'head-live'), 'prepared', 'the fresh noWake queue stays queued')
  })
})

test('LANE ② boot pass (the C7 one-time contract preserved): a single-row live pair is RE-DELIVERED immediately at the BOOT pass (no backoff delay — a boot is one recovery, not a storm); the max-attempts gate still applies', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_700_000_000_000
    await seed(stateDir, {
      records: [{ id: 'm-0', seq: 0, ts: T0, from: 'ipd', to: ['head-live'], text: 'boot me', kind: 'agent' }],
      rows: [row('m-0', 'head-live', 'prepared', T0)]
    })
    const r = redeliverer(stateDir)
    r.__records('m-0', { id: 'm-0', seq: 0, ts: T0, from: 'ipd', to: ['head-live'], text: 'boot me', kind: 'agent' })
    await r.run()
    assert.equal(r.__calls.deliver.length, 1, 'the boot pass re-delivers an eligible pair IMMEDIATELY (the one-time recovery contract — the existing W7-A/C8′ semantics are unchanged)')
    assert.equal(await deliveryStatus(stateDir, 'm-0', 'head-live'), 'delivered', 'the boot pass settles the pair delivered')
    // A pair with a stale/rebound record (ALTO-1/Issue-3) is NEVER driven.
    await seed(stateDir, {
      records: [{ id: 'm-9', seq: 1, ts: T0, from: 'ipd', to: ['other'], text: 'r', kind: 'agent' }],
      rows: [row('m-9', 'bystander', 'prepared', T0)]
    })
    r.__records('m-9', { id: 'm-9', seq: 1, ts: T0, from: 'ipd', to: ['other'], text: 'r', kind: 'agent' })
    await r.run()
    assert.equal(r.__calls.deliver.filter((c) => c.messageId === 'm-9').length, 0, 'a row whose record never addressed the recipient is never driven (the Issue-3 guard)')
    assert.equal(await deliveryStatus(stateDir, 'm-9', 'bystander'), 'prepared', 'the stale pair stays untouched')
  })
})