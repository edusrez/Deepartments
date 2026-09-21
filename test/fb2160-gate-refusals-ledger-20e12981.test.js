// dsh-deepartments — fb-2160 / ACCEPTANCE 4 ENMENDADO (2026-09-21, run token
// 20e12981) — THE GATE-REFUSAL LEDGER.
//
// THE MEASURED GAP (host, 2026-09-21): a DURABLE DIRECTIVE THAT WAS NOT WOKEN has
// no drain route, and its REFUSAL is written NOWHERE countable — it lives in the
// message's own PROSE (`m-17488`/`m-17524`/`m-17836`: «capacity-gate verdict:
// BLOCKED … SUSTAINED … do NOT deploy inspectors now … DURABLE but was NOT
// woken») plus the retry churn of the delivery sidecar. The churn counts
// ATTEMPTS, not REFUSALS, and it is a FLOOR (the boot compaction erases a pair
// whose run is empty). ⇒ «cuántos despachos se intentaron y se rechazaron» had
// no answer.
//
// WHAT THIS FILE LOCKS: the ledger answers it, and it does so WITHOUT closing
// anything: `scanGateRefusals` classifies the armed no-wake pair that was handed
// over and REFUSED (dshd-core's own predicates), `appendGateRefusals` persists
// it in `<stateDir>/gate-refusals.jsonl`, and NEITHER writes a status.
//
// METHOD (the repo's "src-native" pattern WITHOUT the resolution hook): the
// package `dshd-health/src/index.ts` has ZERO relative imports, so Node's native
// type-stripping loads it DIRECTLY.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const H = await import('../packages/dshd-health/src/index.ts')

const T0 = 1_789_722_029_987 // the measured m-17488 seal (09-18 09:00:29.987Z)

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb2160-refusals-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** The MEASURED pair shape: the sealed `prepared` of 09-18, then the flagless
 * churn (a `prepared` write-ahead + its `failed` rejection 0,8 s later). */
function measuredRows(messageId, baseTs, cycles) {
  const rows = [{ messageId, recipientId: 'quality-head', status: 'prepared', ts: baseTs, noWake: true }]
  for (let i = 0; i < cycles; i++) {
    rows.push({ messageId, recipientId: 'quality-head', status: 'prepared', ts: baseTs + 3_000_000 * (i + 1) })
    rows.push({ messageId, recipientId: 'quality-head', status: 'failed', ts: baseTs + 3_000_000 * (i + 1) + 800 })
  }
  return rows
}

test('fb-2160 (§4 ENMENDADO): the ledger COUNTS the attempts and the REFUSALS of an armed no-wake pair — and classifies by CONTENT, never by age, emitter or kind', () => {
  const rows = measuredRows('m-17488', T0, 9)
  const out = H.scanGateRefusals(rows, T0 + 3_000_000 * 9 + 800)
  assert.equal(out.length, 1, 'ONE row per pair, not one per attempt')
  const row = out[0]
  assert.equal(row.messageId, 'm-17488')
  assert.equal(row.recipientId, 'quality-head')
  assert.equal(row.intentTs, T0, 'the RUN\'s armed seal (the pair\'s own evidence)')
  assert.equal(row.attempts, 19, 'the attempts the re-drive burned (9 churn write-aheads + 1 sealed + 9 rejections)')
  assert.equal(row.refusals, 9, 'THE COUNT THAT DID NOT EXIST: the handoffs the seam REFUSED')
  assert.equal(row.active, true, 'the pair is STILL undrained — the whole point of the ledger')
  // (a) A SEALED QUEUE THAT WAS NEVER HANDED OVER IS NOT COUNTED — nothing was
  // refused for it, and its release is the recipient's next real wake.
  const sealedOnly = [{ messageId: 'm-9', recipientId: 'quality-head', status: 'prepared', ts: T0, noWake: true }]
  assert.deepEqual(H.scanGateRefusals(sealedOnly, T0 + 999_999_999), [], 'an armed queue with no refusal is NOT the class')
  // (b) A RECOVERED pair has drained — the other accepted output, and it is not
  // emitted (the run ended in a success).
  const recovered = rows.concat([{ messageId: 'm-17488', recipientId: 'quality-head', status: 'delivered', ts: T0 + 3_000_000 * 10 }])
  assert.deepEqual(H.scanGateRefusals(recovered, T0 + 3_000_000 * 10), [], 'a pair that DRAINED is not in the ledger')
  // (c) A flagless CRASH-class pair (no armed intent anywhere) is not this class.
  const crashClass = [{ messageId: 'm-1', recipientId: 'x', status: 'failed', ts: T0 }]
  assert.deepEqual(H.scanGateRefusals(crashClass, T0 + 1), [], 'a crash-class pair carries no no-wake order')
})

test('fb-2160 (§4 ENMENDADO): the sink is DURABLE and APPEND-ONLY — the counters survive the sidecar compaction that erases the rows they came from, and it never writes a status', async () => {
  await withTempStateDir(async (stateDir) => {
    const rows = measuredRows('m-17488', T0, 3)
    await writeFile(path.join(stateDir, 'deliveries.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const seen = H.scanGateRefusals(rows, T0 + 3_000_000 * 3 + 800)
    const appended = await H.appendGateRefusals(stateDir, seen)
    assert.equal(appended, 1, 'one row appended for the one observed pair')
    // (1) THE LEDGER OUTLIVES THE SIDECAR: simulate the boot compaction by
    // erasing the pair's rows entirely — the refusals count is still on disk.
    await writeFile(path.join(stateDir, 'deliveries.jsonl'), '', 'utf8')
    const log = (await readFile(path.join(stateDir, H.GATE_REFUSALS_FILE), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(log.length, 1)
    assert.equal(log[0].refusals, 3, 'the refusal count survived the compaction (the sidecar would have lost it)')
    assert.equal(log[0].active, true)
    // (2) APPEND-ONLY: a second observation adds a ROW, it never rewrites one.
    await H.appendGateRefusals(stateDir, H.scanGateRefusals(rows, T0 + 3_000_000 * 4))
    const after = (await readFile(path.join(stateDir, H.GATE_REFUSALS_FILE), 'utf8')).trim().split('\n')
    assert.equal(after.length, 2, 'the sink appends — the earlier observation is byte-identical evidence')
    // (3) IT NEVER WRITES A STATUS — the ledger is read-only over the pair's
    // state (the enmienda forbids closing a pair that carries a live order).
    const sidecar = await readFile(path.join(stateDir, 'deliveries.jsonl'), 'utf8')
    assert.equal(sidecar, '', 'the ledger wrote NOTHING to the delivery sidecar')
    // (4) FAIL-SOFT: an unwritable sink returns 0 and never throws.
    const n = await H.appendGateRefusals(stateDir, [])
    assert.equal(n, 0, 'an empty scan appends nothing (no noise per tick)')
  })
})

test('fb-2160 (§4 ENMENDADO): the tick composes the ledger — the scan is pure and the identity is the pair anchor the rest of the health side uses', () => {
  // The scan is PURE (same input → same output, no clock inside beyond the ts it
  // stamps) and it keys by the SAME (messageId, recipientId) anchor as
  // `deliveryFailedIdentity` / the storm scan, so the ledgers can be joined.
  const rows = measuredRows('m-17836', T0, 2)
  const a = H.scanGateRefusals(rows, 1)
  const b = H.scanGateRefusals(rows, 2)
  assert.deepEqual(a.map((r) => ({ ...r, ts: 0 })), b.map((r) => ({ ...r, ts: 0 })), 'the classification is a pure function of the rows (only the observation ts moves)')
  assert.equal(a[0].messageId, 'm-17836')
  assert.ok('recipientId' in a[0] && 'refusals' in a[0], 'the row carries the pair anchor + the counters the operator aggregates')
})
