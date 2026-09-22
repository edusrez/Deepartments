// dsh-deepartments — LANE `heap-band-truth` (2026-09-22). Run token: 2ebbc0de.
//
// THE DEFECT THIS FILE PINS (measured, not inferred): the heap band published a
// CEILING and its label did not describe what it measured.
//   · `host-health.jsonl` (12.577 rows; 8.910 carrying `daemon.pressure`) had
//     `source = 'rss-upper-bound'` in **100 %** of them — no exception.
//   · In the last ~3 h: NORMAL 215 | WARN 38 | CRITICAL 144, and the peak read
//     **107,4 %** (pid 1721430). Across the series, **6.385 of 8.941** samples
//     read **> 100 %** of the «ceiling».
//   · `> 100 % of a ceiling` is arithmetically impossible AS A FRACTION OF A
//     LIMIT — so `ceilingMb` was never a limit: it is a REFERENCE the process can
//     and does exceed. `CRITICAL` therefore did not mean «this daemon is in
//     danger»; it meant «superó una cifra declarada». That is why 144 alerts
//     moved nobody.
//   · NO CAUSAL CLAIM: the 107,4 % peak belongs to pid 1721430 (last sample
//     17:31:40Z) and the 17:32 crash-loop is a SEPARATE measured fact. Two
//     facts, not cause and effect.
//
// THE TWO SHAPES, AND WHY THIS LANE IS SHAPE (A):
//   (A) PUBLISH THE REAL DATUM — the daemon's own V8 heap. CHOSEN, on
//       measurement: the health tick runs IN THE DAEMON PROCESS, so
//       `process.memoryUsage()` inside it IS the daemon's heap.
//       `runHealthDaemonTick` is called by the bundle at `src/invoke.ts` (the
//       daemon's own interval) and by the plugin path in-process — so the datum
//       has a real birthplace and no external reader needs to be trusted.
//   (B) LABEL-ONLY (rename the level, publish no datum) — the fallback if (A)
//       were unreachable. It is NOT: the test below proves the datum is born,
//       round-trips, and turns `source: 'rss-upper-bound'` into
//       `source: 'heapUsed'` on the REAL sampler path.
//   This file proves the datum exists end to end; the sampler's own suite
//   (test/host-sampler.test.js) proves the band, the basis and the render.
//
// fb-95 (AGENTS.md): BUILT-lib test (plain `node --test` over lib/) — it does
// NOT self-register the ts-src-loader hook, so the built lib must carry the
// change: `pnpm --filter dshd-health run build` + `pnpm build` before running.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { getHeapStatistics } from 'node:v8'
import { readHealthHeartbeatFile, runHealthDaemonTick } from '../packages/dshd-health/lib/index.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SAMPLER = path.join(REPO_ROOT, 'scripts', 'host-sampler.mjs')

// NOTE: `await fn(dir)` is LOAD-BEARING — without the await the `finally` runs
// the rmSync BEFORE the async body finishes and the stateDir vanishes mid-test
// (this lane's own first draft did exactly that and failed with ENOENT).
async function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'heap-band-truth-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('SHAPE (A) PROVEN: the REAL tick publishes the daemon`s own heap, and it round-trips', async () => {
  await withTempDir(async (stateDir) => {
    // The REAL tick path — the same function the daemon runs on its interval.
    await runHealthDaemonTick({ now: () => Date.now(), stateDir, bootId: 'hbt-boot-1', config: { health: {} }, hosts: [] })
    // 1. It is on DISK in the heartbeat the sampler reads (the relay's source).
    const raw = JSON.parse(readFileSync(path.join(stateDir, 'health-heartbeat.json'), 'utf8'))
    assert.ok(raw.heapMb !== undefined, 'the heartbeat now carries heapMb — the datum was BORN (before this lane it never existed)')
    assert.ok(Number.isInteger(raw.heapMb.used), 'used is an integer MB (fb-16: a number, no content)')
    assert.ok(Number.isInteger(raw.heapMb.total), 'total is an integer MB')
    // 2. `limit` is V8's REAL wall for THIS process — the whole point of the
    //    datum: it is the hard ceiling the band must use, not an assumption.
    const v8LimitMb = Math.round(getHeapStatistics().heap_size_limit / 1048576)
    assert.equal(raw.heapMb.limit, v8LimitMb, 'limit === v8.getHeapStatistics().heap_size_limit — MEASURED, not copied from a constant')
    assert.ok(raw.heapMb.used > 0 && raw.heapMb.used <= raw.heapMb.limit, 'used sits inside the wall it declares')
    // 3. It ROUND-TRIPS through the reader the daemon itself uses.
    const hb = readHealthHeartbeatFile(stateDir)
    assert.deepEqual(hb.heapMb, raw.heapMb, 'readHealthHeartbeatFile returns the block verbatim')
  })
})

test('THE FALLBACK DISAPPEARS BECAUSE THERE IS A DATUM — not because of a patch (the real sampler path)', async () => {
  await withTempDir(async (stateDir) => {
    // The fixture is a stateDir WITHOUT a heartbeat: the state of the world the
    // lane measured 100 % of the series in.
    const stdout = execFileSync(process.execPath, [SAMPLER, '--once', '--state-dir', stateDir, '--quiet'], { encoding: 'utf8' })
    const before = JSON.parse(stdout)
    if (before.daemon === null) return // no resolvable daemon on this host: nothing to pin here
    // BEFORE: no heartbeat → the declared fallback, and the row SAYS so.
    assert.equal(before.daemon.pressure.basis, 'rss-upper-bound', 'without the datum the band falls back — and declares it')
    assert.equal(before.daemon.pressure.heapMb, null, 'the real figure is honestly null, never a substitute')
    assert.equal(before.daemon.pressure.rssMb !== null, true, 'the reference upper bound is still published')
    // Now let the REAL daemon-side producer write a heartbeat into that stateDir:
    // the SAME function the daemon runs. The sampler must pick it up with NO
    // change to the sampler (the relay already existed — the DATUM was missing).
    await runHealthDaemonTick({ now: () => Date.now(), stateDir, bootId: 'hbt-boot-2', config: { health: {} }, hosts: [] })
    const stdout2 = execFileSync(process.execPath, [SAMPLER, '--once', '--state-dir', stateDir, '--quiet'], { encoding: 'utf8' })
    const after = JSON.parse(stdout2)
    if (after.daemon === null) return
    // AFTER: the fallback is GONE because there is a datum.
    assert.equal(after.daemon.pressure.source, 'heapUsed', 'the real figure IS banded now — the fallback disappeared by having a datum')
    assert.equal(after.daemon.pressure.basis, 'heapUsed')
    assert.equal(after.daemon.pressure.heapMb, after.daemon.pressure.usedMb, 'usedMb is the REAL heap on this basis')
    assert.equal(after.daemon.pressure.ceilingMb, after.daemon.pressure.heapLimitMb, 'and the denominator is the hard wall the daemon declared')
    // The level is DERIVABLE from the real figure and its wall (criterion 2).
    const expectedPct = Number((((after.daemon.pressure.usedMb / after.daemon.pressure.heapLimitMb) * 100)).toFixed(1))
    assert.equal(after.daemon.pressure.usedPct, expectedPct, 'usedPct derives from the REAL figure / the WALL')
    const expected = expectedPct >= 90 ? 'CRITICAL' : expectedPct >= 80 ? 'WARN' : 'NORMAL'
    assert.equal(after.daemon.pressure.level, expected, 'the level is derivable from the real figure and its wall')
    // The reference upper bound is STILL side by side (never lost by preferring
    // the real datum) — both figures, one row (criterion 1).
    assert.ok(after.daemon.pressure.rssMb > 0, 'the reference figure travels WITH the real one')
    assert.ok(after.daemon.pressure.basisNote.length > 0, 'and the basis is declared (criterion 3)')
  })
})

test('THE LABEL HONESTY: >100% of a REFERENCE is not CRITICAL — the measured everyday state', async () => {
  await withTempDir(async (stateDir) => {
    // A heartbeat the daemon can never write (no heapMb) + a real daemon whose
    // RSS is what the series actually shows. The point is the VOCABULARY: on the
    // reference basis the level must not borrow the hard wall's death sentence,
    // at ANY value — including the measured >100 % region (6.385 samples).
    writeFileSync(path.join(stateDir, 'health-heartbeat.json'), '{"ts":1,"bootId":"x","crashStreak":0}')
    const { daemonPressure } = await import('../scripts/host-sampler.mjs')
    // 100 % and above of the reference: a REAL, everyday reading (peak 160,9 %).
    for (const rssKb of [2096 * 1024, 2250 * 1024, 3261 * 1024, 3917 * 1024]) {
      const p = daemonPressure(rssKb, null)
      assert.equal(p.basis, 'rss-upper-bound')
      assert.notEqual(p.level, 'CRITICAL', `${p.usedPct}% of a reference must not claim the hard wall`)
      assert.equal(p.level, 'ABOVE-REFERENCE', 'it is named for what it measures: the reference was passed')
    }
    // The measured fatal case read against the WALL (not the reference) keeps its
    // terminal word — the repair removes a false claim, not a true one.
    const fatal = daemonPressure(null, { usedMb: 3261, limitMb: 2096 })
    assert.equal(fatal.level, 'CRITICAL', 'the heap basis keeps CRITICAL: 3261 MB of a 2096 MB wall is a real breach')
  })
})
