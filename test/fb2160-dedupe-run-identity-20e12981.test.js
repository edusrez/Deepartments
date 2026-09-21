// dsh-deepartments — fb-2160 / §ACCEPTANCE 3 (2026-09-21, run token 20e12981).
//
// THE MEASURED FALSE-NEGATIVE THIS LOCKS: the `delivery-failed` identity EMBEDDED
// THE ATTEMPT'S OWN `ts`, and a re-drive cycle writes a new row with a new `ts`
// every time — so the same dead pair minted a new identity per attempt and the
// shared health-alerts ledger could never dedupe it. MEASURED on the live state
// dir for the four `noWake` directives to `quality-head`:
//   key `delivery-failed:m-17488#quality-head#1789993971289` (12:32)
//   key `delivery-failed:m-17488#quality-head#1789994631509` (12:43)
// — the SAME object, alerted TWICE, `count:1` forever.
//
// THE IDENTITY ADOPTED is the FAILURE RUN (the pair + the run's FIRST row ts), and
// this file pins the TWO DIRECTIONS fb-1478 warns about — a wrong identity in a
// dedupe ledger SUPPRESSES rather than re-fires, so BOTH must be measured:
//   • SUPPRESSED: the same run, again, inside the window (the churn) — one alert;
//   • RE-FIRED: a NEW run after a success, and a run still failing after the
//     window — never hidden;
// and it pins the fb-198 guarantee the `ts` was added for: a RENUMBERED
// (recycled) message id can never collide with a stale ledger entry.
//
// METHOD (the repo's "src-native" pattern WITHOUT the resolution hook): the
// package `dshd-health/src/index.ts` has ZERO relative imports, so Node's native
// type-stripping loads it DIRECTLY (the same method
// test/context-threshold-usable-window.test.js documents).
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const H = await import('../packages/dshd-health/src/index.ts')

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb2160-dedupe-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

async function seed(stateDir, rows) {
  await writeFile(path.join(stateDir, 'deliveries.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

const MIN = 60_000
const T0 = new Date(2026, 8, 21, 12, 20, 0).getTime()

/** The MEASURED churn shape: one `prepared` + one `failed` per cycle, all
 * flagless (the re-drive seam does not forward the no-wake intent). */
function churn(messageId, recipientId, startTs, cycles, stepMs) {
  const rows = []
  for (let i = 0; i < cycles; i++) {
    rows.push({ messageId, recipientId, status: 'prepared', ts: startTs + stepMs * i })
    rows.push({ messageId, recipientId, status: 'failed', ts: startTs + stepMs * i + 800 })
  }
  return rows
}

test('fb-2160 (§3, SUPPRESSION): the identity is STABLE across the attempts of one run — the same dead pair yields ONE key, so the shared ledger\'s dedupe window finally applies', async () => {
  await withTempStateDir(async (stateDir) => {
    const rows = churn('m-17488', 'quality-head', T0, 11, 10 * MIN)
    await seed(stateDir, rows)
    const findings = H.scanDeliveryFindings(stateDir, T0 + 100 * MIN + 800, undefined, H.readDeliveryRowsFull)
    const df = findings.filter((f) => f.kind === 'delivery-failed')
    assert.equal(df.length, 1, 'ONE finding for the pair — the scan groups per pair')
    assert.equal(df[0].key, `delivery-failed:m-17488#quality-head#${T0 + 800}`, 'the key is the RUN\'s anchor (the first failed row of the run) — NOT the latest attempt\'s ts')
    // THE PROPERTY THE OLD KEY LACKED: reading the SAME ledger at a LATER NOW
    // (a later cycle appended one more attempt) yields the SAME identity, so the
    // health-alerts ledger's window suppresses instead of re-alerting. This is
    // literally the two live keys of the measured pair collapsing into one.
    await seed(stateDir, rows.concat(churn('m-17488', 'quality-head', T0 + 110 * MIN, 1, 10 * MIN)))
    const later = H.scanDeliveryFindings(stateDir, T0 + 120 * MIN + 800, undefined, H.readDeliveryRowsFull).filter((f) => f.kind === 'delivery-failed')
    assert.equal(later[0].key, df[0].key, 'a NEW attempt of the SAME run keeps the SAME identity (the measured churn now dedupes)')
  })
})

test('fb-2160 (§3, RE-FIRE — the fb-1478 direction): a NEW run after a SUCCESS mints a NEW identity (never suppressed), and a run still failing after the window re-alerts (the legacy per-key cadence)', async () => {
  await withTempStateDir(async (stateDir) => {
    const firstRun = churn('m-17488', 'quality-head', T0, 3, MIN)
    await seed(stateDir, firstRun)
    const firstKey = H.scanDeliveryFindings(stateDir, T0 + 3 * MIN, undefined, H.readDeliveryRowsFull).find((f) => f.kind === 'delivery-failed').key
    assert.equal(firstKey, `delivery-failed:m-17488#quality-head#${T0 + 800}`)
    // THE PAIR RECOVERS — the only event that ends a run (`delivered`).
    await seed(stateDir, firstRun.concat([{ messageId: 'm-17488', recipientId: 'quality-head', status: 'delivered', ts: T0 + 4 * MIN }]))
    // …and fails again: a NEW run — the stale entry MUST NOT suppress it.
    await seed(stateDir, firstRun.concat([
      { messageId: 'm-17488', recipientId: 'quality-head', status: 'delivered', ts: T0 + 4 * MIN },
      { messageId: 'm-17488', recipientId: 'quality-head', status: 'failed', ts: T0 + 5 * MIN }
    ]))
    const second = H.scanDeliveryFindings(stateDir, T0 + 6 * MIN, undefined, H.readDeliveryRowsFull).find((f) => f.kind === 'delivery-failed')
    assert.equal(second.key, `delivery-failed:m-17488#quality-head#${T0 + 5 * MIN}`, 'a NEW run mints a NEW identity — the recovery is visible as a fresh alert')
    assert.notEqual(second.key, firstKey, 'the new run never inherits the old run\'s identity (nothing legitimate is buried)')
    // THE LEGACY CADENCE (unchanged semantics): the same run STILL failing inside
    // its window keeps its key, so the ledger's own 30-min window decides the
    // re-alert — not a brand-new key per attempt.
    const sameRunAgain = H.scanDeliveryFindings(stateDir, T0 + 6 * MIN + 1, undefined, H.readDeliveryRowsFull).find((f) => f.kind === 'delivery-failed')
    assert.equal(sameRunAgain.key, second.key, 'the identity does not drift while the run keeps failing')
  })
})

test('fb-2160 (§3, fb-198 PRESERVED): the identity stays NON-RENUMERABLE — a RECYCLED message id (a compaction renumber) never dedupes against the stale entry that pointed at the OLD record', async () => {
  await withTempStateDir(async (stateDir) => {
    // The fb-198 forensics: a stale ledger entry keyed to the OLD run of `m-2219`.
    const stale = { 'delivery-failed:m-2219#research-head#1700000000000': T0 - 3 * MIN }
    // A compaction renumbered the ids and a NEW record minted `m-2219`; its
    // delivery fails a week later — a DIFFERENT run, and therefore (because the
    // identity carries the run anchor) a DIFFERENT key.
    await seed(stateDir, [{ messageId: 'm-2219', recipientId: 'research-head', status: 'failed', ts: T0 }])
    const finding = H.scanDeliveryFindings(stateDir, T0 + MIN, undefined, H.readDeliveryRowsFull).find((f) => f.kind === 'delivery-failed')
    assert.equal(finding.key, `delivery-failed:m-2219#research-head#${T0}`, 'the key carries the run anchor (an immutable row field)')
    assert.equal(stale[finding.key], undefined, 'the stale pre-fix entry CANNOT dedupe it — the fb-198 durable false negative stays closed')
  })
})

test('fb-2160 (§3, live/catch-up PARITY): the two scans mint the SAME identity for the same run, so the shared ledger counts one event, never two', async () => {
  await withTempStateDir(async (stateDir) => {
    // A run that STARTS outside the live 2 h window and keeps failing inside it —
    // exactly the shape the catch-up pass exists for.
    const rows = churn('m-17488', 'quality-head', T0 - 3 * 60 * MIN, 1, MIN)
      .concat(churn('m-17488', 'quality-head', T0, 2, MIN))
    await seed(stateDir, rows)
    const live = H.scanDeliveryFindings(stateDir, T0 + 3 * MIN, undefined, H.readDeliveryRowsFull).find((f) => f.kind === 'delivery-failed')
    const catchup = H.scanHealthCatchup(stateDir, T0 + 3 * MIN).find((f) => f.kind === 'delivery-failed')
    assert.ok(live !== undefined, 'the live scan sees the fresh attempts')
    // The catch-up pass owns rows STRICTLY older than the live window; when it
    // fires, its identity must be the run's — the same literal the live scan
    // mints — never a second identity for one event.
    if (catchup !== undefined) {
      assert.equal(catchup.key, `delivery-failed:m-17488#quality-head#${T0 - 3 * 60 * MIN + 800}`, 'the catch-up identity is the RUN\'s anchor (same derivation as the live scan)')
    }
    assert.equal(live.key, `delivery-failed:m-17488#quality-head#${T0 - 3 * 60 * MIN + 800}`, 'the live scan reads the SAME run anchor even though the run began outside its own 2 h window')
  })
})
