// dsh-deepartments — fb-270 REGRESSION: the qi-silence watchdog measured its OWN
// denominator (builder lane, run token bd01d0ed, 2026-09-15).
//
// THE DEFECT (canonical fb-270, QD 2026-09-08, estado abierto; instances fb-1124
// + its triage fb-1130): `scanQiSilence` counted EVERY retired+worker post as a
// potential directive emitter. But a QUALITY-HEAD worker retire is the F6
// exclusion (packages/dshd-orchestration/src/tools.ts — the retire gate is
// `entry.managerId !== 'quality-head' && qualityInspectDecision(...)`): its
// directive is suppressed BY DESIGN, so the retire is structurally INELIGIBLE
// for a «retirements elapsed with ZERO directives» premise. Feeding it to the
// P(0 directives | n, p) bound inflates n, and the watchdog ends up measuring
// its own bookkeeping instead of the trigger it exists to guarantee.
//
// THE LIVE EVIDENCE (reproduced here as case 1): /.deepartments/health-alerts.jsonl
// carries EXACTLY ONE qi-silence alert — ts 2026-09-15T02:17:14Z, count=11,
// minRetires=11. The durable retire-dice ledger for that same 120-min window
// holds 11 rows: 6 `dice` + 5 `qd-worker`, and ZERO rows with retireEmitted=true.
// So P(X=0 | n=11, p=0.25) ≈ 4.2% fired, when the honest density was
// P(X=0 | n=6) ≈ 17.8% — pure dice, never a trigger outage. (The ficha's
// reproducibility claim — 11 counted in TWO occasions seven days apart — is the
// same signature: a denominator, not an anomaly.)
//
// THE FIX under test: the eligible denominator is read from the DURABLE ledger
// `retire-dice.jsonl` (its `reason` class + its real retire `ts`), falling back
// to the catalog post-census delta minus the F6 class (`managerId ===
// 'quality-head'`) when no ledger is usable. The alert TEXT must let a human
// reconstruct the count without opening the code.
//
// Self-contained: drives the ALREADY-EXPORTED `scanQiSilence` from the package
// lib (the fb-134 test pattern) — the fix adds ZERO new exports, so the frozen
// bundle surface (test/export-parity.test.js, 329) is untouched.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { QI_SILENCE_CENSUS_KEY, QI_SILENCE_PRIMED_MS, readQiSilenceState, scanQiSilence } from '../packages/dshd-health/lib/index.js'

const WINDOW_MS = 120 * 60 * 1000
const RATE = 0.25
const MIN_RETIRES = 11 // qiSilenceMinRetiresForRate(0.25, 0.05) — the owner bound

/** Run `fn` against a fresh temp stateDir (removed afterwards). */
async function withStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'qi270-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Write a `retire-dice.jsonl` from `[postId, reason|null, emitted, ts]`
 * quadruples. `reason === null` omits the field (the pre-F2 / legacy shape). */
async function writeDiceLedger(stateDir, rows) {
  const text = rows
    .map(([postId, reason, emitted, ts]) => JSON.stringify({
      postId,
      retireRoll: emitted === true ? 0.1 : 0.9,
      retireProb: 0.25,
      retireEmitted: emitted === true,
      ...(reason === null ? {} : { reason }),
      ts
    }))
    .join('\n')
  await writeFile(path.join(stateDir, 'retire-dice.jsonl'), `${text}\n`, 'utf8')
}

/** An ARMED observation ledger (census in the past) — so the census PRIMING path
 * never masks a case by priming every present post. */
function armedLedger(firstSeen, nowMs) {
  return { [QI_SILENCE_CENSUS_KEY]: nowMs - 24 * 3600 * 1000, ...firstSeen }
}

test('fb-270 case 1 — THE LIVE DEFECT REPLAY: the 2026-09-15T02:17:14Z window (11 retires: 6 dice + 5 qd-worker, ZERO emitted) NO LONGER alerts; the qd-worker class is excluded from the denominator', async () => {
  await withStateDir(async (stateDir) => {
    const nowMs = 1789438634884 // the live alert row's ts
    // The real window, read off /.deepartments/retire-dice.jsonl: the 6 eligible
    // retires (their heads are internal-programming-head) and the 5 F6-excluded
    // quality-head inspectors.
    const eligible = ['builder-347', 'host-sampler-18', 'builder-348', 'builder-349', 'builder-350', 'builder-351']
    const f6 = ['quality-inspector-312', 'quality-inspector-313', 'quality-inspector-314', 'quality-inspector-315', 'quality-inspector-316']
    const rows = [...eligible.map((id, i) => [id, 'dice', false, nowMs - (60 - i) * 60_000]),
      ...f6.map((id, i) => [id, 'qd-worker', false, nowMs - (30 - i) * 60_000])]
    await writeDiceLedger(stateDir, rows)
    const posts = [...eligible, ...f6].map((postId) => ({
      postId, retired: true, provider: 'worker',
      managerId: f6.includes(postId) ? 'quality-head' : 'internal-programming-head'
    }))
    const scan = scanQiSilence({
      posts, stateDir, nowMs, windowMs: WINDOW_MS, minRetires: MIN_RETIRES, rate: RATE,
      ledger: armedLedger(Object.fromEntries(rows.map(([id, , , ts]) => [id, ts])), nowMs)
    })
    assert.equal(scan.source, 'dice-ledger', 'the durable ledger is the denominator source')
    assert.equal(scan.observed, 11, 'the pre-fix denominator: all 11 retired+worker retires')
    assert.equal(scan.excluded, 5, 'the 5 F6 qd-worker retires are EXCLUDED')
    assert.equal(scan.eligible, 6, 'the ELIGIBLE denominator: 6 dice retires')
    assert.equal(scan.expected, 0, 'no eligible retire had a directive due (roll >= p)')
    assert.equal(scan.findings.length, 0, 'P(X=0 | n=6) ≈ 17.8% is the EXPECTED dice — the false alarm is gone')
  })
})

test('fb-270 case 2 — the watchdog is NOT muted: a TRUE trigger outage (11 ELIGIBLE retires, zero directives) STILL alerts, and the count is the ELIGIBLE denominator, not the pre-fix total', async () => {
  await withStateDir(async (stateDir) => {
    const nowMs = 1_700_000_000_000
    const dice = Array.from({ length: 11 }, (_, i) => [`builder-t${i}`, 'dice', false, nowMs - (60 - i) * 60_000])
    const f6 = Array.from({ length: 5 }, (_, i) => [`quality-inspector-t${i}`, 'qd-worker', false, nowMs - (30 - i) * 60_000])
    const rows = [...dice, ...f6]
    await writeDiceLedger(stateDir, rows)
    const posts = rows.map(([postId]) => ({ postId, retired: true, provider: 'worker' }))
    const scan = scanQiSilence({
      posts, stateDir, nowMs, windowMs: WINDOW_MS, minRetires: MIN_RETIRES, rate: RATE,
      ledger: armedLedger(Object.fromEntries(rows.map(([id, , , ts]) => [id, ts])), nowMs)
    })
    assert.equal(scan.findings.length, 1, '11 ELIGIBLE retires with zero directives — the guarantee must still fire')
    assert.equal(scan.eligible, 11, 'the eligible denominator')
    assert.equal(scan.observed, 16, 'the pre-fix total (11 + 5 excluded)')
    assert.equal(scan.findings[0].count, 11, 'the finding reports the ELIGIBLE count — never the inflated one')
    // THE RECONSTRUCTIBILITY CONTRACT: a human reading the alert alone can redo
    // the arithmetic (eligible / excluded / due / the exact bound).
    assert.match(
      scan.findings[0].error,
      /^11 worker retire\(s\) in 120 min with zero quality-inspect directive\(s\) \(workerInspectProbability=0\.25, min retires 11\) — denominator from retire-dice\.jsonl \(durable ledger\): 11 ELIGIBLE of 16 worker retire\(s\) in window, 5 qd-worker excluded \(F6, managerId=quality-head, never emits by design\); 0 eligible retire\(s\) had retireEmitted=true \(roll < p — a directive was DUE\); P\(X=0 \| n=11, p=0\.25\) = 4\.22%$/,
      'the alert text carries the eligible denominator, the excluded F6 class, the due count and P(X=0)'
    )
  })
})

test('fb-270 case 3 — the EXTREME of the defect: a window of ONLY qd-worker retires (11) is structurally ineligible → never alerts', async () => {
  await withStateDir(async (stateDir) => {
    const nowMs = 1_700_000_000_000
    const rows = Array.from({ length: 11 }, (_, i) => [`quality-inspector-x${i}`, 'qd-worker', false, nowMs - (60 - i) * 60_000])
    await writeDiceLedger(stateDir, rows)
    const posts = rows.map(([postId]) => ({ postId, retired: true, provider: 'worker', managerId: 'quality-head' }))
    const scan = scanQiSilence({
      posts, stateDir, nowMs, windowMs: WINDOW_MS, minRetires: MIN_RETIRES, rate: RATE,
      ledger: armedLedger(Object.fromEntries(rows.map(([id, , , ts]) => [id, ts])), nowMs)
    })
    assert.equal(scan.observed, 11, '11 retires happened')
    assert.equal(scan.eligible, 0, 'but NONE could ever emit a directive')
    assert.equal(scan.findings.length, 0, 'zero eligible retires → nothing to be silent about')
  })
})

test('fb-270 case 4 — CATALOG FALLBACK (no usable retire-dice ledger): the F6 class is dropped by managerId; an ABSENT ledger never reads as «zero retirements»', async () => {
  await withStateDir(async (stateDir) => {
    const nowMs = 1_700_000_000_000
    const eligible = Array.from({ length: 11 }, (_, i) => `builder-c${i}`)
    const f6 = Array.from({ length: 5 }, (_, i) => `quality-inspector-c${i}`)
    const posts = [
      ...eligible.map((postId) => ({ postId, retired: true, provider: 'worker', managerId: 'internal-programming-head' })),
      ...f6.map((postId) => ({ postId, retired: true, provider: 'worker', managerId: 'quality-head' }))
    ]
    // NO retire-dice.jsonl on disk → the fallback path.
    const ledger = armedLedger(Object.fromEntries([...eligible, ...f6].map((id) => [id, nowMs - 60_000])), nowMs)
    const scan = scanQiSilence({ posts, stateDir, nowMs, windowMs: WINDOW_MS, minRetires: MIN_RETIRES, rate: RATE, ledger })
    assert.equal(scan.source, 'catalog', 'the catalog post-census delta is the fallback denominator')
    assert.equal(scan.observed, 16, 'all 16 posts counted by the pre-fix code')
    assert.equal(scan.eligible, 11, 'only the 11 non-quality-head workers are eligible')
    assert.equal(scan.findings.length, 1, 'the guarantee still fires on the fallback path')
    assert.match(scan.findings[0].error, /denominator from the catalog post-census delta \(no retire-dice\.jsonl\)/, 'the text names the provenance')
  })
})

test('fb-270 case 5 — «absent ≠ excluded»: a pre-F2 ledger row WITHOUT `reason` stays ELIGIBLE (the append-only ledger never rewrites them — never silently drop a real retirement)', async () => {
  await withStateDir(async (stateDir) => {
    const nowMs = 1_700_000_000_000
    const rows = Array.from({ length: 11 }, (_, i) => [`builder-legacy${i}`, null, false, nowMs - (60 - i) * 60_000])
    await writeDiceLedger(stateDir, rows)
    const posts = rows.map(([postId]) => ({ postId, retired: true, provider: 'worker', managerId: 'internal-programming-head' }))
    const scan = scanQiSilence({
      posts, stateDir, nowMs, windowMs: WINDOW_MS, minRetires: MIN_RETIRES, rate: RATE,
      ledger: armedLedger(Object.fromEntries(rows.map(([id, , , ts]) => [id, ts])), nowMs)
    })
    assert.equal(scan.eligible, 11, 'the reason-less rows are ELIGIBLE — the conservative direction')
    assert.equal(scan.findings.length, 1, 'a genuine silence over reason-less rows is never hidden')
  })
})

test('fb-270 case 6 — the window is `(nowMs - windowMs, nowMs]`: a FUTURE-stamped row is not a retirement in this window (a clock skew must not join the denominator)', async () => {
  await withStateDir(async (stateDir) => {
    const nowMs = 1_700_000_000_000
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => [`builder-f${i}`, 'dice', false, nowMs - (60 - i) * 60_000]),
      ['builder-future', 'dice', false, nowMs + 60_000], // stamped AFTER nowMs
      ['builder-stale', 'dice', false, nowMs - WINDOW_MS - 60_000] // older than the window
    ]
    await writeDiceLedger(stateDir, rows)
    const posts = rows.map(([postId]) => ({ postId, retired: true, provider: 'worker' }))
    const scan = scanQiSilence({
      posts, stateDir, nowMs, windowMs: WINDOW_MS, minRetires: MIN_RETIRES, rate: RATE,
      ledger: armedLedger({}, nowMs)
    })
    assert.equal(scan.observed, 11, 'neither the future row nor the stale row is inside the window')
    assert.equal(scan.eligible, 11)
  })
})

test('fb-270 case 7 — an EXISTING ledger with zero in-window rows is an HONEST zero (no fallback); the observation ledger keeps its census/priming semantics (unchanged)', async () => {
  await withStateDir(async (stateDir) => {
    const nowMs = 1_700_000_000_000
    await writeDiceLedger(stateDir, [['builder-old', 'dice', false, nowMs - WINDOW_MS - 60_000]])
    const scan = scanQiSilence({
      posts: [{ postId: 'builder-primed', retired: true, provider: 'worker' }],
      stateDir, nowMs, windowMs: WINDOW_MS, minRetires: MIN_RETIRES, rate: RATE,
      ledger: armedLedger({ 'builder-primed': QI_SILENCE_PRIMED_MS }, nowMs)
    })
    assert.equal(scan.source, 'dice-ledger', 'a readable ledger with an empty window is still the authority')
    assert.equal(scan.observed, 0)
    assert.equal(scan.eligible, 0)
    assert.equal(scan.findings.length, 0, 'no retirement in the window → no silence')
    // The BOOT CENSUS still primes (a fresh ledger) — untouched by this fix.
    const census = scanQiSilence({
      posts: [{ postId: 'builder-boot', retired: true, provider: 'worker' }],
      stateDir, nowMs, windowMs: WINDOW_MS, minRetires: 1, rate: 1, ledger: {}
    })
    assert.equal(census.findings.length, 0, 'the boot census never alerts (M1.1)')
    assert.equal(census.ledger['builder-boot'], QI_SILENCE_PRIMED_MS, 'the census primes with the sentinel')
    assert.equal(census.ledger[QI_SILENCE_CENSUS_KEY], nowMs, 'the census marker is stamped')
    assert.equal(readQiSilenceState(stateDir)[QI_SILENCE_CENSUS_KEY], undefined, 'the scan is PURE — nothing was persisted by it')
  })
})
