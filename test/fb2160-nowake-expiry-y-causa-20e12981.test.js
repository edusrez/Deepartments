// dsh-deepartments — fb-2160 (2026-09-21, run token 20e12981) — ENMIENDA DEL
// ACCEPTANCE (head/host, same day).
//
// ⚠️ THE FIRST CUT OF THIS LANE SETTLED AGED NO-WAKE PAIRS TO `terminal` AFTER A
// 6-h TTL, AND THE ENMIENDA REVERTED IT BY READING THE ROWS' OWN TEXT. The
// refutation, verbatim from the live store: `m-17488`/`m-17524`/`m-17836` carry
// «SUSTAINED — the pool gate blocks EVERY dispatch, so do NOT deploy inspectors
// now: inspect IN-HEAD at your next real wake (this directive is DURABLE but was
// NOT woken — it drains at your next real wake)» — a LIVE OPEN ORDER plus the
// gate's own refusal annotation. Sweeping them to `terminal` would DELETE THE
// EVIDENCE AND KILL THE ORDER. (`m-17466` is the only other class: a turn-error
// of the recipient's own session.)
//
// ⇒ THE ACCEPTED OUTPUTS ARE ONLY TWO: (i) IT DRAINS, or (ii) IT IS PRESERVED.
// This file locks BOTH the REVERT and the classification that survives it:
//   • the ledger row is NEVER closed to `terminal` by the sweep;
//   • the armed no-wake pair and the handoff the seam REFUSED are still
//     CLASSIFIABLE (the evidence the gate-refusal ledger will consume);
//   • the classification is BY CONTENT (the pair's own rows), never by the
//     emitter, the kind, or the age.
//
// LANE ② DISCIPLINE: 0 builds — the source is exercised through Node's
// type-stripping + the self-registered ts-src-loader hook; 0 real APIs (the only
// fs is a temp stateDir; the delivery seam is an injected stub).
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
  needsRedelivery,
  noWakeFailuresSince,
  noWakeIntentTs,
  isRefusedNoWakeHold,
  parseDeliveryRows,
  resolveDeliveriesPath
} from '../packages/dshd-core/src/messages.ts'

const M = await import('../packages/dshd-core/src/messages.ts')

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb2160-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

const T0 = 1_789_722_029_987 // the measured m-17488 seal (09-18 09:00:29.987Z)

/** The MEASURED shape of one victim pair, in FILE ORDER: the sealed `prepared`
 * of 09-18, then N today's churn cycles — each a `prepared` write-ahead and its
 * `failed` rejection 0,8 s later, BOTH FLAGLESS (the re-drive seam does not
 * forward the intent; the seal lives only in the 09-18 row). */
function measuredRows(messageId, baseTs, cycles) {
  const rows = [{ messageId, recipientId: 'quality-head', status: 'prepared', ts: baseTs, noWake: true }]
  for (let i = 0; i < cycles; i++) {
    rows.push({ messageId, recipientId: 'quality-head', status: 'prepared', ts: baseTs + 3_000_000 * (i + 1) })
    rows.push({ messageId, recipientId: 'quality-head', status: 'failed', ts: baseTs + 3_000_000 * (i + 1) + 800 })
  }
  return rows
}

function redeliverer(stateDir) {
  const calls = { deliver: [], warns: [] }
  const records = new Map()
  const r = new DeliveryRedeliverer({
    stateDir,
    logger: { info: () => {}, warn: (m) => calls.warns.push(m) },
    recipientAlive: () => true,
    recipientDormant: () => false,
    recipientRunning: () => true, // the MEASURED case: the head was RUNNING
    getRecord: async (id) => records.get(id),
    resolveCallerSessionId: (from) => from,
    deliver: async (record, recipientId) => {
      calls.deliver.push({ messageId: record.id, recipientId })
      await markDelivery(stateDir, record.id, recipientId, 'failed', undefined, undefined, 'acl')
      return 'failed'
    }
  })
  r.__calls = calls
  r.__records = records
  return r
}

test('fb-2160 ENMIENDA: THE TTL SETTLE IS GONE — the module no longer exports an expiry policy, and the sweep writes NO `terminal` for an aged armed no-wake pair (PRESERVATION is the accepted output)', async () => {
  // (1) THE REVERT, asserted on the module surface: a future re-introduction of
  // the TTL must fail THIS line, not just a behavioural test.
  assert.equal(M.RE_DELIVERY_NO_WAKE_EXPIRY_MS, undefined, 'no TTL constant exists (the settle would close a LIVE durable order)')
  assert.equal(M.NO_WAKE_EXPIRY_TERMINAL, undefined, 'no declared terminal exists for this class')
  assert.equal(M.isNoWakePairExpired, undefined, 'no expiry predicate exists')
  assert.equal(M.isNoWakeHeldPair, undefined, 'the census-shaped predicate is gone too — the class is now `isRefusedNoWakeHold`')

  await withTempStateDir(async (stateDir) => {
    // (2) THE BEHAVIOUR: the four measured pairs, ~3 days old, against a sweep
    // that in the reverted cut settled them `terminal`. Read-only proof by
    // EFFECT: the terminal count does not move.
    const ids = ['m-17466', 'm-17488', 'm-17524', 'm-17836']
    const rows = []
    for (const id of ids) rows.push(...measuredRows(id, T0, 9))
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const r = redeliverer(stateDir)
    for (const id of ids) r.__records.set(id, { id, seq: Number(id.slice(2)), ts: T0, from: 'deepartments', to: ['quality-head'], text: 'directive', kind: 'agent' })
    const before = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8')).filter((x) => x.status === 'terminal').length
    await r.sweepDue(Date.now())
    const after = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    assert.equal(after.filter((x) => x.status === 'terminal').length, before, 'the sweep appends NO `terminal` — an aged armed no-wake pair is PRESERVED, never silently closed')
    for (const id of ids) {
      const pair = after.filter((x) => x.messageId === id)
      assert.notEqual(pair.at(-1).status, 'terminal', `${id}: the pair keeps its live state (the durable order is NOT killed)`)
    }
    // The churn itself is the OPEN problem this lane could not legally "solve" by
    // closing the pair: it stays bounded by the LANE ② cap/backoff (measured
    // `consec 9–10/12` on the live pairs) and is reported as the ledger's motive.
    assert.ok(r.__calls.deliver.length > 0, 'the pair is still re-driven (the churn is preserved, declared as the open defect — not hidden by a settle)')
  })
})

test('fb-2160 ENMIENDA (classification BY CONTENT): the armed intent, the refused handoff and the refused-armed-hold class are read from the pair\'s OWN rows — and the sealed queue that was never handed over is excluded', () => {
  const rows = measuredRows('m-17488', T0, 3)
  // The ARMED intent survives the flagless churn: the seal is the pair's, not the
  // latest row's.
  assert.equal(noWakeIntentTs(rows, 'm-17488', 'quality-head'), T0, 'the intent ts is the SEAL\'s own ts')
  assert.equal(rows.at(-1).noWake, undefined, 'the measured shape: the LATEST row lost the flag (the churn writes flagless rows)')
  assert.equal(noWakeFailuresSince(rows, 'm-17488', 'quality-head'), T0 + 3_000_000 + 800, 'the first REFUSED handoff of the current run is named')
  assert.equal(isRefusedNoWakeHold(rows, 'm-17488', 'quality-head'), true, 'THE CLASS: armed + handed over + refused + still needing delivery')

  // A SEALED QUEUE THAT WAS NEVER HANDED OVER IS NOT THE CLASS — its release is
  // the recipient's next real wake, and nothing may be reported/closed for it.
  const sealed = [{ messageId: 'm-9', recipientId: 'quality-head', status: 'prepared', ts: T0, noWake: true }]
  assert.equal(noWakeIntentTs(sealed, 'm-9', 'quality-head'), T0)
  assert.equal(noWakeFailuresSince(sealed, 'm-9', 'quality-head'), undefined, 'no refused handoff yet')
  assert.equal(isRefusedNoWakeHold(sealed, 'm-9', 'quality-head'), false, 'a healthy armed queue is NOT the refused class')

  // A RECOVERED pair is not the class either: the success class ends the run.
  const recovered = rows.concat([
    { messageId: 'm-17488', recipientId: 'quality-head', status: 'delivered', ts: T0 + 10 },
    { messageId: 'm-17488', recipientId: 'quality-head', status: 'failed', ts: T0 + 20 }
  ])
  assert.equal(noWakeIntentTs(recovered, 'm-17488', 'quality-head'), undefined, 'a real delivery spends the no-wake order')
  assert.equal(isRefusedNoWakeHold(recovered, 'm-17488', 'quality-head'), false, 'the post-success failure alone is NOT an armed hold')

  // A settled pair (terminal) is never the class.
  const settled = rows.concat([{ messageId: 'm-17488', recipientId: 'quality-head', status: 'terminal', ts: T0 + 30 }])
  assert.equal(isRefusedNoWakeHold(settled, 'm-17488', 'quality-head'), false, 'a terminal pair is settled')
  assert.equal(needsRedelivery('terminal'), false, 'the SAME predicate the sweep/drain/health read: terminal is never re-driven')
})
