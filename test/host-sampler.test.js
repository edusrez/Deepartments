// dsh-deepartments — HOST-SAMPLER tests (LANE HOST-SAMPLER, 2026-09-10).
//
// HERMETIC where it matters: every FIXTURE (the JSONL, the tool-intents rows,
// the host samples) lives in mkdtemp — never the live stateDir. The two CLI
// smoke cases run the REAL scripts against a fixture stateDir, so the declared
// JSONL SCHEMA and the RECIPE's three verdicts are locked as contracts:
//   · the sampler's row key set is asserted EXACTLY (a new/renamed field breaks
//     the readers, so it must break this test too);
//   · PRESSURE / FLAT / INSUFFICIENT are each pinned by a synthetic window
//     (the criterion is the norm's §4 — a change there must be deliberate);
//   · THE HEAP BAND (norm §4.6) is pinned against the MEASURED 2096 MB ceiling
//     — including the fb-1587 defect it exists to prevent: a band compared
//     against the 5,8 G CGROUP peak reads "NORMAL" while the daemon is dying.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ABOVE_REFERENCE_LEVEL,
  DEFAULT_INTERVAL_SEC,
  DEFAULT_KEEP_LINES,
  DEFAULT_MAX_LINES,
  HEAP_BAND,
  HEAP_BASIS,
  HEAP_CEILING_MB,
  cmdlineMatchesDaemon,
  isDshEntrypoint,
  countLines,
  daemonBlock,
  daemonPressure,
  dirBytes,
  heapBand,
  memBlock,
  parseArgs,
  parseLoadavg,
  parseMeminfo,
  parsePressure,
  parsePressureLine,
  parseProcStat,
  parseProcStatus,
  readHeartbeatHeap,
  referenceBandLevel,
  renderStatus,
  rotateIfNeeded,
  tick,
} from '../scripts/host-sampler.mjs'
import {
  CRITERION,
  correlate,
  evaluateCall,
  pairCalls,
  parseInstant,
  selectSlowCalls,
  verdictReading,
} from '../scripts/host-slowcall-correlate.mjs'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SAMPLER = path.join(REPO_ROOT, 'scripts', 'host-sampler.mjs')
const CORRELATE = path.join(REPO_ROOT, 'scripts', 'host-slowcall-correlate.mjs')

/** A throwaway fixture dir (never the live stateDir). */
function fixtureDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'host-sampler-test-'))
  if (t !== undefined && typeof t.after === 'function') t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// --- the /proc parsers -------------------------------------------------------

test('parsePressureLine reads the avg/total shape of /proc/pressure/*', () => {
  const some = parsePressureLine('some avg10=4.16 avg60=2.63 avg300=4.26 total=50478204873')
  assert.deepEqual(some, { avg10: 4.16, avg60: 2.63, avg300: 4.26, totalUs: 50478204873 })
  assert.equal(parsePressureLine('full avg10=0.00 avg60=1.50 avg300=2.50 total=7').avg10, 0)
  assert.equal(parsePressureLine('garbage'), undefined)
  assert.equal(parsePressureLine(undefined), undefined)
})

test('parsePressure splits some/full and degrades an absent full line to null', () => {
  const both = parsePressure('some avg10=1.00 avg60=2.00 avg300=3.00 total=10\nfull avg10=4.00 avg60=5.00 avg300=6.00 total=20\n')
  assert.equal(both.some.avg60, 2)
  assert.equal(both.full.avg60, 5)
  const onlySome = parsePressure('some avg10=1.00 avg60=2.00 avg300=3.00 total=10\n')
  assert.equal(onlySome.some.avg60, 2)
  assert.equal(onlySome.full, null)
  assert.equal(parsePressure(''), null)
  assert.equal(parsePressure(null), null)
})

test('parseMeminfo + memBlock: usedKb is MemAvailable-based, never MemFree-based', () => {
  const info = parseMeminfo('MemTotal:        7937232 kB\nMemFree:          420572 kB\nMemAvailable:    4879088 kB\nSwapTotal:       2097148 kB\nSwapFree:        1511932 kB\nDirty:              3300 kB\n')
  assert.equal(info['MemTotal'], 7937232)
  const mem = memBlock(info)
  assert.equal(mem.usedKb, 7937232 - 4879088)
  assert.equal(mem.swapUsedKb, 2097148 - 1511932)
  assert.equal(mem.usedPct, Number((((7937232 - 4879088) / 7937232) * 100).toFixed(2)))
  assert.equal(mem.dirtyKb, 3300)
  // A truncated meminfo degrades to null, never NaN/throw.
  const empty = memBlock({})
  assert.equal(empty.totalKb, null)
  assert.equal(empty.usedKb, null)
  assert.equal(empty.usedPct, null)
})

test('parseLoadavg + parseProcStatus read the kernel shapes', () => {
  const load = parseLoadavg('1.39 1.87 1.88 2/301 315537')
  assert.deepEqual(load, { load1: 1.39, load5: 1.87, load15: 1.88, runnable: 2, procs: 301 })
  assert.equal(parseLoadavg(''), null)
  const status = parseProcStatus('Name:\tnode\nState:\tR (running)\nVmSize:\t13452736 kB\nVmRSS:\t 1831860 kB\nThreads:\t11\n')
  assert.deepEqual(status, { rssKb: 1831860, vmSizeKb: 13452736, threads: 11, state: 'R' })
  assert.equal(parseProcStatus('Name:\tnode\n').rssKb, null)
})

test('cmdlineMatchesDaemon: the unit profile matches, `dsh web` and other profiles do not', () => {
  const daemon = ['node', '/usr/bin/dsh', '--profile', 'deepartments-dev', '--port', '3090']
  assert.equal(cmdlineMatchesDaemon(daemon, 'deepartments-dev'), true)
  assert.equal(cmdlineMatchesDaemon(['node', '/usr/bin/dsh', 'web', '--port', '3080'], 'deepartments-dev'), false)
  assert.equal(cmdlineMatchesDaemon(['node', '/usr/bin/dsh', '--profile=deepartments-dev'], 'deepartments-dev'), true)
  assert.equal(cmdlineMatchesDaemon(['node', '/usr/bin/dsh', '--profile', 'deepartments-dev-headless'], 'deepartments-dev'), false)
  assert.equal(cmdlineMatchesDaemon([], 'deepartments-dev'), false)
})

test('cmdlineMatchesDaemon: the VERSIONED-TREE form matches too (argv has no arg named `dsh`)', () => {
  // Measured 2026-09-21: the unit relaunched the daemon as
  // `node <tree>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile deepartments-dev ...`
  // and the `dsh`-only test matched NOTHING — 215 samples carried
  // `daemon: no pid for --profile deepartments-dev` (`rssKb=n/a`, heap band inert).
  const viaTree = [
    'node',
    '/opt/dsh/trees/deepartments-dev-0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '--profile',
    'deepartments-dev',
    '--port',
    '3090',
  ]
  assert.equal(cmdlineMatchesDaemon(viaTree, 'deepartments-dev'), true)
  // The other entrypoint form (the `dsh` shim IS this same file) still matches.
  assert.equal(cmdlineMatchesDaemon(['node', '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile=deepartments-dev'], 'deepartments-dev'), true)
  // The profile test is what excludes `dsh web` — never the entrypoint test.
  assert.equal(cmdlineMatchesDaemon(['node', '/opt/dsh/trees/x/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', '--port', '3080'], 'deepartments-dev'), false)
  assert.equal(cmdlineMatchesDaemon(['node', '/opt/dsh/trees/x/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'deepartments-dev-headless'], 'deepartments-dev'), false)
  // An unrelated bin.js (some other package) is NOT a DSH entrypoint.
  assert.equal(cmdlineMatchesDaemon(['node', '/opt/other/node_modules/@acme/thing/lib/bin.js', '--profile', 'deepartments-dev'], 'deepartments-dev'), false)
})

// --- the file-level helpers --------------------------------------------------

test('dirBytes sums apparent sizes and flags a truncated walk', (t) => {
  const dir = fixtureDir(t)
  mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
  writeFileSync(path.join(dir, 'a', 'b', 'x.txt'), 'x'.repeat(100))
  writeFileSync(path.join(dir, 'y.txt'), 'y'.repeat(50))
  const walk = dirBytes(dir, 5000)
  assert.equal(walk.bytes, 150)
  assert.equal(walk.files, 2)
  assert.equal(walk.truncated, false)
  const deadline = dirBytes(dir, -1)
  assert.equal(deadline.truncated, true)
})

test('countLines + rotateIfNeeded: the cap keeps the NEWEST lines (lines and bytes)', (t) => {
  const dir = fixtureDir(t)
  const file = path.join(dir, 'rows.jsonl')
  writeFileSync(file, Array.from({ length: 50 }, (_, i) => `{"i":${i}}`).join('\n') + '\n')
  assert.equal(countLines(file), 50)
  // Under both caps: untouched.
  assert.equal(rotateIfNeeded(file, { maxLines: 100, keepLines: 10, maxBytes: 1_000_000 }).rotated, false)
  assert.equal(countLines(file), 50)
  // Line cap: trimmed to the last 10.
  const rotated = rotateIfNeeded(file, { maxLines: 40, keepLines: 10, maxBytes: 1_000_000 })
  assert.equal(rotated.rotated, true)
  assert.equal(countLines(file), 10)
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual([rows[0].i, rows[rows.length - 1].i], [40, 49])
  // Byte cap fires even when the line count is under the line cap.
  writeFileSync(file, Array.from({ length: 20 }, (_, i) => `{"i":${i},"pad":"${'p'.repeat(80)}"}`).join('\n') + '\n')
  const byBytes = rotateIfNeeded(file, { maxLines: 20_000, keepLines: 3, maxBytes: 500 })
  assert.equal(byBytes.rotated, true)
  assert.equal(countLines(file), 3)
  assert.equal(rotateIfNeeded(path.join(dir, 'absent.jsonl'), { maxLines: 1, keepLines: 1, maxBytes: 0 }).rotated, false)
})

test('the declared defaults are the documented ones', () => {
  assert.equal(DEFAULT_INTERVAL_SEC, 45)
  assert.equal(DEFAULT_MAX_LINES, 20000)
  assert.equal(DEFAULT_KEEP_LINES, 12000)
  assert.ok(DEFAULT_INTERVAL_SEC >= 30 && DEFAULT_INTERVAL_SEC <= 60, 'the cadence stays inside the 30-60 s band the owner asked for')
})

// --- the sampler CLI, end to end (fixture stateDir, REAL /proc reads) --------

test('host-sampler.mjs --once appends ONE row of the DECLARED schema (v1, no secrets)', (t) => {
  const dir = fixtureDir(t)
  const stdout = execFileSync(process.execPath, [SAMPLER, '--once', '--state-dir', dir, '--quiet'], { encoding: 'utf8' })
  const printed = JSON.parse(stdout)
  const lines = readFileSync(path.join(dir, 'host-health.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const row = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(row), [
    'v',
    'ts',
    'iso',
    'intervalSec',
    'uptimeSec',
    'nproc',
    'load1',
    'load5',
    'load15',
    'runnable',
    'procs',
    'load1PerCore',
    'mem',
    'psi',
    'daemon',
    'disk',
    'stateDir',
    'tickMs',
    'errors',
  ])
  assert.deepEqual(Object.keys(row.mem), [
    'totalKb',
    'availableKb',
    'usedKb',
    'usedPct',
    'swapTotalKb',
    'swapFreeKb',
    'swapUsedKb',
    'dirtyKb',
    'writebackKb',
  ])
  assert.deepEqual(Object.keys(row.stateDir), ['path', 'bytes', 'files', 'bytesAt', 'ageSec', 'truncated', 'skipped'])
  assert.deepEqual(Object.keys(row.disk), ['path', 'totalBytes', 'usedBytes', 'availBytes', 'usedPct', 'inodesUsedPct'])
  assert.equal(row.v, 1)
  assert.equal(row.ts, printed.ts)
  assert.equal(row.intervalSec, DEFAULT_INTERVAL_SEC)
  assert.equal(row.iso, new Date(row.ts).toISOString())
  assert.ok(row.nproc >= 1)
  assert.ok(row.disk.totalBytes > 0)
  assert.ok(row.mem.totalKb > 0)
  assert.ok(Array.isArray(row.errors))
  assert.ok(Number(row.tickMs) >= 0)
  // The stateDir measurement targets the FIXTURE, never the live store.
  assert.equal(row.stateDir.path, dir)
  assert.ok(row.stateDir.bytes >= 0)
  assert.ok(row.daemon === null || typeof row.daemon === 'object')
  assert.ok('pid' in (row.daemon ?? {}) || row.daemon === null)
  // fb-16: no secret-shaped keys anywhere in the row.
  assert.equal(/(token|secret|password|apikey|api_key|credential)/i.test(JSON.stringify(row)), false)
})

test('host-sampler.mjs refuses a second sampler on the same output (the pid lock)', (t) => {
  const dir = fixtureDir(t)
  const out = path.join(dir, 'host-health.jsonl')
  execFileSync(process.execPath, [SAMPLER, '--once', '--state-dir', dir, '--quiet'])
  // A LIVE pid in the lockfile (the test process itself) must block a new run.
  writeFileSync(`${out}.pid`, `${process.pid}\n`)
  const stdout = execFileSync(process.execPath, [SAMPLER, '--once', '--state-dir', dir, '--quiet'], { encoding: 'utf8' })
  assert.equal(stdout.trim(), '', 'a blocked run prints no row')
  assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 1, 'and appends nothing')
})

// --- the correlator: pairing, selection, criterion ---------------------------

const T0 = Date.parse('2026-09-10T15:30:00.000Z')

/** A host sample with every criterion-relevant field at a FLAT value. The PSI
 * cumulative counters grow with the instant (2,2 % of CPU stall per 45 s) so the
 * window-exact share — and therefore the BOUND of norm §4.4 — is meaningful. */
function flatSample(ts, overrides = {}) {
  const step = Math.max(0, Math.round((ts - (T0 - 60_000)) / 45_000))
  return {
    v: 1,
    ts,
    iso: new Date(ts).toISOString(),
    intervalSec: 45,
    nproc: 4,
    load1: 0.4,
    load1PerCore: 0.1,
    mem: { availableKb: 4_000_000, usedKb: 2_000_000, swapUsedKb: 1000 },
    psi: {
      cpu: { some: { avg10: 0.2, avg60: 0.2, avg300: 0.2, totalUs: 1_000_000 + step * 990_000 }, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } },
      io: { some: { avg10: 0.1, avg60: 0.1, avg300: 0.1, totalUs: 500 + step * 45_000 }, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } },
      memory: { some: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 }, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } },
    },
    daemon: { unit: 'dsh-deepartments-dev', pid: 1, rssKb: 1_800_000, cpuTicks: 1000 + step * 2250 },
    ...overrides,
  }
}

/** Samples every 45 s over [T0-60s, T0+260s] (the window of the fixture call). */
function coveredSamples(overridesByIndex = {}) {
  const out = []
  for (let ts = T0 - 60_000; ts <= T0 + 260_000; ts += 45_000) {
    const idx = out.length
    out.push(flatSample(ts, overridesByIndex[idx] ?? {}))
  }
  return out
}

const SLOW_CALL = {
  id: 'call_test',
  tool: 'send_message',
  agent: 'worker-builder-1',
  memberId: 'builder-1',
  targets: ['head-x'],
  intentTs: T0,
  settleTs: T0 + 200_000,
  durationMs: 200_000,
  durationSec: 200,
  status: 'settled',
}

test('pairCalls pairs BY id and counts unpaired intents as their own number', () => {
  const rows = [
    { kind: 'intent', id: 'c1', tool: 'send_message', agent: 'a', memberId: 'm1', target: 'h1,h2', ts: T0 },
    { kind: 'settle', id: 'c1', tool: 'send_message', status: 'settled', ts: T0 + 200_000 },
    { kind: 'intent', id: 'c2', tool: 'dept_feedback', agent: 'a', memberId: 'm1', ts: T0 + 1000 },
    { kind: 'settle', id: 'orphan', tool: 'send_message', status: 'settled', ts: T0 + 2000 },
    { kind: 'intent', id: '', tool: 'send_message', ts: T0 },
  ]
  const paired = pairCalls(rows)
  assert.equal(paired.calls.length, 1)
  assert.equal(paired.calls[0].id, 'c1')
  assert.equal(paired.calls[0].durationSec, 200)
  assert.deepEqual(paired.calls[0].targets, ['h1', 'h2'])
  assert.equal(paired.unpaired, 1, 'an intent with no settle is NOT 0 s')
  assert.equal(paired.orphanSettles, 1)
})

test('selectSlowCalls filters by tool, minimum duration and lower time bound', () => {
  const calls = [
    { id: 'a', tool: 'send_message', durationSec: 90, intentTs: T0 },
    { id: 'b', tool: 'send_message', durationSec: 30, intentTs: T0 },
    { id: 'c', tool: 'dept_exec', durationSec: 500, intentTs: T0 },
    { id: 'd', tool: 'dept_feedback', durationSec: 120, intentTs: T0 - 7_200_000 },
  ]
  const filter = { tools: ['send_message', 'dept_feedback'], minSec: 60, sinceTs: T0 - 3_600_000, callId: null }
  assert.deepEqual(
    selectSlowCalls(calls, filter).map((c) => c.id),
    ['a'],
  )
  assert.deepEqual(
    selectSlowCalls(calls, { ...filter, tools: null }).map((c) => c.id),
    ['c', 'a'],
  )
  assert.deepEqual(
    selectSlowCalls(calls, { ...filter, callId: 'b' }).map((c) => c.id),
    ['b'],
    'a known call id bypasses the duration/time filter',
  )
})

test('parseInstant accepts durations, ISO instants and epoch ms', () => {
  const now = Date.parse('2026-09-10T16:00:00.000Z')
  assert.equal(parseInstant('2h', now), now - 7_200_000)
  assert.equal(parseInstant('30m', now), now - 1_800_000)
  assert.equal(parseInstant('45s', now), now - 45_000)
  assert.equal(parseInstant('2026-09-10T15:00:00.000Z', now), Date.parse('2026-09-10T15:00:00.000Z'))
  assert.equal(parseInstant('1789055000000', now), 1789055000000)
  assert.equal(parseInstant('not-a-time', now), null)
})

test('THE CRITERION: FLAT requires FULL coverage and no signal', () => {
  const verdict = evaluateCall(SLOW_CALL, coveredSamples(), { windowSec: 60 })
  assert.equal(verdict.verdict, 'FLAT')
  assert.equal(verdict.coverage, 'full')
  assert.deepEqual(verdict.signals, [])
  assert.equal(verdict.peaks.cpuSomeAvg60Pct, 0.2)
  assert.ok(verdict.sampleCount >= 8)
  assert.match(verdictReading(verdict.verdict, SLOW_CALL), /machine is NOT the cause/)
  assert.match(verdictReading(verdict.verdict, SLOW_CALL), /deliveries\.jsonl/)
})

test('THE CRITERION: each declared signal fires PRESSURE', () => {
  const cpu = coveredSamples({ 3: { psi: { ...flatSample(0).psi, cpu: { some: { avg10: 7, avg60: 7, avg300: 7, totalUs: 1 }, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } } } } })
  assert.equal(evaluateCall(SLOW_CALL, cpu, { windowSec: 60 }).verdict, 'PRESSURE')
  assert.match(evaluateCall(SLOW_CALL, cpu, { windowSec: 60 }).signals[0], /cpu\.some\.avg60/)

  const io = coveredSamples({ 4: { psi: { ...flatSample(0).psi, io: { some: { avg10: 9, avg60: 9, avg300: 9, totalUs: 1 }, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } } } } })
  assert.match(evaluateCall(SLOW_CALL, io, { windowSec: 60 }).signals.join(' '), /io\.some\.avg60/)

  const memory = coveredSamples({ 2: { psi: { ...flatSample(0).psi, memory: { some: { avg10: 3, avg60: 3, avg300: 3, totalUs: 1 }, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } } } } })
  assert.match(evaluateCall(SLOW_CALL, memory, { windowSec: 60 }).signals.join(' '), /memory\.some\.avg60/)

  const queue = coveredSamples({ 3: { load1PerCore: 3 }, 4: { load1PerCore: 3.5 } })
  assert.match(evaluateCall(SLOW_CALL, queue, { windowSec: 60 }).signals.join(' '), /consecutive samples/)

  const drop = coveredSamples({ 5: { mem: { availableKb: 3_000_000, swapUsedKb: 1000 } } })
  assert.match(evaluateCall(SLOW_CALL, drop, { windowSec: 60 }).signals.join(' '), /MemAvailable fell/)
  assert.match(verdictReading('PRESSURE', SLOW_CALL), /plausible contributor/)
})

// The 2026-09-10 AMENDMENT (norm §4.3): the first version of the criterion
// fired "PRESSURE" on calls whose window showed cpu.some 5-10 % while psi.cpu.full
// was 0 % and load1/nproc ~0.6 — a busy box, NOT a short one. The two families
// keep every signal reported and only CLASS the reading.
test('THE CRITERION (amendment 2026-09-10): cpu.some alone is CONTENTION, not capacity', () => {
  const samples = coveredSamples({
    3: { psi: { ...flatSample(0).psi, cpu: { some: { avg10: 9, avg60: 9, avg300: 9, totalUs: 1 }, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } } } },
  })
  const verdict = evaluateCall(SLOW_CALL, samples, { windowSec: 60 })
  assert.equal(verdict.verdict, 'PRESSURE')
  assert.equal(verdict.pressureClass, 'contention')
  assert.deepEqual(verdict.capacitySignals, [])
  assert.match(verdict.contentionSignals.join(' '), /cpu\.some\.avg60/)
  const reading = verdictReading(verdict.verdict, SLOW_CALL, verdict)
  assert.match(reading, /BUSY BUT NOT SHORT/)
  assert.match(reading, /widening the box does NOT have a basis/)
  assert.match(reading, /\d+\.\d s of 200 s/, 'the contention reading prints the arithmetic bound')
  assert.equal(verdict.hostStallBoundSec, 4.4, '2,2 % of 200 s from the window-exact totalUs delta')
  assert.equal(verdict.hostStallBoundSharePct, 2.2)
})

test('THE CRITERION (amendment 2026-09-10): a GLOBAL stall (psi full) is CAPACITY', () => {
  const full = coveredSamples({
    4: { psi: { ...flatSample(0).psi, cpu: { some: { avg10: 12, avg60: 12, avg300: 12, totalUs: 1 }, full: { avg10: 2, avg60: 1.5, avg300: 1.5, totalUs: 1 } } } },
  })
  const verdict = evaluateCall(SLOW_CALL, full, { windowSec: 60 })
  assert.equal(verdict.pressureClass, 'capacity')
  assert.match(verdict.capacitySignals.join(' '), /psi\.cpu\.full\.avg60/)
  assert.match(verdictReading(verdict.verdict, SLOW_CALL, verdict), /UNDER CAPACITY PRESSURE/)
})

test('THE CRITERION (amendment 2026-09-10): a sustained runqueue is CAPACITY', () => {
  const queue = coveredSamples({ 2: { load1PerCore: 2.4 }, 3: { load1PerCore: 3.1 } })
  const verdict = evaluateCall(SLOW_CALL, queue, { windowSec: 60 })
  assert.equal(verdict.pressureClass, 'capacity')
  assert.match(verdict.capacitySignals.join(' '), /sustained runqueue/)
})

test('THE CRITERION (amendment 2026-09-10): a MemAvailable dip alone is CONTENTION evidence, not capacity', () => {
  const drop = coveredSamples({ 5: { mem: { availableKb: 3_000_000, swapUsedKb: 1000 } } })
  const verdict = evaluateCall(SLOW_CALL, drop, { windowSec: 60 })
  assert.equal(verdict.pressureClass, 'contention')
  assert.deepEqual(verdict.capacitySignals, [])
  assert.match(verdict.contentionSignals.join(' '), /MemAvailable fell/)
  assert.match(verdict.contentionSignals.join(' '), /page-cache churn/)
  assert.match(verdictReading(verdict.verdict, SLOW_CALL, verdict), /BUSY BUT NOT SHORT/)
})

test('parseProcStat reads utime+stime after the LAST parenthesis (a comm with spaces must not break it)', () => {
  const stat = parseProcStat('1234 (node) S 1 1234 1234 0 -1 4194560 12345 0 0 0 500 100 0 0 20 0 11 0 12345 123456 789 0')
  assert.equal(stat.utimeTicks, 500)
  assert.equal(stat.stimeTicks, 100)
  assert.equal(stat.cpuTicks, 600)
  assert.equal(parseProcStat('999 (weird ) name) R 1 2 3 0 -1 0 0 0 0 0 7 8 0 0 20 0 1 0 0 0 0 0').cpuTicks, 15)
  assert.equal(parseProcStat('not a stat line'), null)
  assert.equal(parseProcStat(undefined), null)
})

test('the daemon CPU over the window is the computING vs waitING datum', () => {
  const verdict = evaluateCall(SLOW_CALL, coveredSamples(), { windowSec: 60 })
  assert.equal(verdict.daemonCpuRatio, 0.5, '2250 ticks per 45 s = 22,5 CPU-s = half a core')
  assert.ok(verdict.daemonCpuSec > 0)
  assert.match(verdictReading(verdict.verdict, SLOW_CALL, verdict), /burned .* of CPU over the window/)
})

test('THE CRITERION: a single-sample blip is NOT a sustained runqueue', () => {
  const one = coveredSamples({ 4: { load1PerCore: 2.5 } })
  const verdict = evaluateCall(SLOW_CALL, one, { windowSec: 60 })
  assert.equal(verdict.verdict, 'FLAT')
  assert.deepEqual(verdict.signals, [])
})

test('THE CRITERION: no samples and a coverage hole are INSUFFICIENT (never "flat")', () => {
  const none = evaluateCall(SLOW_CALL, [], { windowSec: 60 })
  assert.equal(none.verdict, 'INSUFFICIENT')
  assert.equal(none.sampleCount, 0)
  assert.match(none.reasons.join(' '), /no host sample in the window/)
  assert.match(verdictReading('INSUFFICIENT', SLOW_CALL), /does not decide anything/)

  const hole = evaluateCall(SLOW_CALL, [flatSample(T0 + 200_000), flatSample(T0 + 245_000)], { windowSec: 60 })
  assert.equal(hole.verdict, 'INSUFFICIENT')
  assert.equal(hole.coverage, 'partial')
  assert.equal(hole.signals.length, 0)
  assert.ok(hole.gapSec > CRITERION.gapToleranceCadences * 45)
})

test('THE CRITERION: a positive signal WINS over a coverage hole', () => {
  const samples = [
    flatSample(T0 + 200_000),
    flatSample(T0 + 245_000, { psi: { ...flatSample(0).psi, cpu: { some: { avg10: 8, avg60: 8, avg300: 8, totalUs: 1 }, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } } } }),
  ]
  const verdict = evaluateCall(SLOW_CALL, samples, { windowSec: 60 })
  assert.equal(verdict.verdict, 'PRESSURE')
  assert.equal(verdict.coverage, 'partial')
})

test('the window-exact PSI percentage comes from the totalUs delta, not from avg60', () => {
  const samples = [
    flatSample(T0, { psi: { ...flatSample(0).psi, cpu: { some: { avg10: 0, avg60: 0, avg300: 0, totalUs: 1_000_000 }, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } } } }),
    flatSample(T0 + 100_000, { psi: { ...flatSample(0).psi, cpu: { some: { avg10: 0, avg60: 0, avg300: 0, totalUs: 6_000_000 }, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } } } }),
  ]
  const verdict = evaluateCall({ ...SLOW_CALL, intentTs: T0, settleTs: T0 + 100_000 }, samples, { windowSec: 0 })
  assert.equal(verdict.psiWindow['cpu.somePct'], 5, '5 s of CPU stall over a 100 s window = 5 %')
})

// --- the recipe CLI ----------------------------------------------------------

test('host-slowcall-correlate.mjs --json joins a slow call with its host window', (t) => {
  const dir = fixtureDir(t)
  const intents = [
    { kind: 'intent', id: 'call_slow', tool: 'send_message', agent: 'worker-x', memberId: 'builder-9', target: 'head-x', ts: T0 },
    { kind: 'settle', id: 'call_slow', tool: 'send_message', status: 'settled', ts: T0 + 200_000 },
    { kind: 'intent', id: 'call_fast', tool: 'send_message', agent: 'worker-x', memberId: 'builder-9', target: 'head-x', ts: T0 + 1000 },
    { kind: 'settle', id: 'call_fast', tool: 'send_message', status: 'settled', ts: T0 + 2000 },
  ]
  writeFileSync(path.join(dir, 'tool-intents.jsonl'), `${intents.map((r) => JSON.stringify(r)).join('\n')}\n`)
  writeFileSync(path.join(dir, 'host-health.jsonl'), `${coveredSamples().map((s) => JSON.stringify(s)).join('\n')}\n`)
  const stdout = execFileSync(
    process.execPath,
    [CORRELATE, '--state-dir', dir, '--since', new Date(T0 - 3_600_000).toISOString(), '--min', '60', '--window', '60', '--json'],
    { encoding: 'utf8' },
  )
  const payload = JSON.parse(stdout)
  assert.equal(payload.summary.minSec, 60)
  assert.equal(payload.summary.unpairedIntents, 0)
  assert.equal(payload.calls.length, 1, 'the 2 s call is not selected by --min 60')
  assert.equal(payload.calls[0].id, 'call_slow')
  assert.equal(payload.calls[0].host.verdict, 'FLAT')
  assert.equal(payload.summary.verdicts.FLAT, 1)
  // fb-16: the fixture carries no args and the output must not invent any.
  assert.equal(stdout.includes('"args"'), false)
})

test('correlate() reports an absent samples file as MISSING, not as a flat host', (t) => {
  const dir = fixtureDir(t)
  writeFileSync(
    path.join(dir, 'tool-intents.jsonl'),
    `${JSON.stringify({ kind: 'intent', id: 'c', tool: 'dept_feedback', agent: 'a', memberId: 'b', ts: T0 })}\n${JSON.stringify({ kind: 'settle', id: 'c', tool: 'dept_feedback', status: 'settled', ts: T0 + 120_000 })}\n`,
  )
  const { summary, results } = correlate({
    stateDir: dir,
    intents: path.join(dir, 'tool-intents.jsonl'),
    samples: path.join(dir, 'host-health.jsonl'),
    tools: ['dept_feedback'],
    minSec: 60,
    windowSec: 60,
    sinceTs: T0 - 3_600_000,
    top: 5,
    callId: null,
  })
  assert.equal(summary.samplesMissing, true)
  assert.equal(results.length, 1)
  assert.equal(results[0].evaluation.verdict, 'INSUFFICIENT')
})


// --- THE HEAP BAND (norm §4.6) ----------------------------------------------
//
// WHY THIS BLOCK EXISTS: the daemon's V8 heap CANNOT be read from outside the
// process. `heapUsed`/`heapTotal` are RUNTIME datums only
// `process.memoryUsage()` can produce, FROM INSIDE; `/proc` has no such field.
// At the 2026-09-16T14:43:47Z `FATAL ERROR: Reached heap limit` the daemon's
// VmRSS was 3261 MB against a 2096 MB heap ceiling (156 %), so RSS is an
// UPPER BOUND on the heap — good enough to warn with, NOT the datum itself.

test('heapBand: NORMAL below 80%, WARN at 80%, CRITICAL at 90% of the ceiling', () => {
  assert.equal(HEAP_BAND.warnPct, 80)
  assert.equal(HEAP_BAND.criticalPct, 90)
  assert.equal(heapBand(1000).level, 'NORMAL') // 47,7 %
  assert.equal(heapBand(1676).level, 'NORMAL') // 79,96 % — just under
  assert.equal(heapBand(1677).level, 'WARN') // 80,0 %
  assert.equal(heapBand(1886).level, 'WARN') // 90,0 % — the boundary is inclusive downwards
  assert.equal(heapBand(1887).level, 'CRITICAL') // 90,03 %
  assert.equal(heapBand(2096).level, 'CRITICAL') // AT the ceiling
  // a non-finite reading is NOT a level: the caller must OMIT the block rather
  // than publish a null slot (a field that is always null is not a datum).
  assert.equal(heapBand(null), null)
  assert.equal(heapBand(Number.NaN), null)
  assert.equal(heapBand(100, 0), null)
})

test('referenceBandLevel: the SAME thresholds over a REFERENCE denominator, with no terminal claim', () => {
  // The two thresholds are shared with the wall (a reference is not a different
  // alarm system — it is the same early warning), but the vocabulary STOPS at
  // WARN: >= 100 % is the reference being passed, never a death claim. Measured
  // reason: pid 810027 survived 62,8 h at 187 % of the ceiling.
  assert.equal(referenceBandLevel(79.9), 'NORMAL')
  assert.equal(referenceBandLevel(79.96), 'NORMAL', 'the UNROUNDED ratio decides (1676/2096)')
  assert.equal(referenceBandLevel(80), 'WARN')
  assert.equal(referenceBandLevel(90), 'WARN')
  assert.equal(referenceBandLevel(99.9), 'WARN')
  assert.equal(referenceBandLevel(100), ABOVE_REFERENCE_LEVEL)
  assert.equal(referenceBandLevel(160.9), ABOVE_REFERENCE_LEVEL) // the series peak, measured
  assert.equal(referenceBandLevel(Number.NaN), null)
  // THE INVARIANT: no reference reading ever reads CRITICAL, at ANY value.
  for (const pct of [0, 50, 79.99, 80, 89.99, 90, 99.99, 100, 107.4, 250, 1000]) {
    assert.notEqual(referenceBandLevel(pct), 'CRITICAL', `reference ${pct}% must never claim the hard wall`)
  }
})

test('THE ROUNDING TRAP: the unrounded ratio decides, on BOTH bases (the threshold must not move)', () => {
  // The decision is made on the UNROUNDED ratio; the rounding is for the reader.
  // 1676/2096 = 79,959… → NORMAL, and the row still PRINTS 80.0. This pin exists
  // because this lane's own first draft re-derived a level from the rounded
  // `usedPct` and fired WARN on a reading under the band — the exact defect the
  // code's comment warns about. Both bases and the publish path are pinned.
  const under = daemonPressure(1676 * 1024, null)
  assert.equal(under.usedPct, 80, 'the printed value rounds UP to 80,0 …')
  assert.equal(under.level, 'NORMAL', '… but the DECISION stays NORMAL (79,96 % is under the band)')
  assert.equal(under.rssLevel, 'NORMAL', 'and the side-by-side reference level agrees')
  assert.equal(referenceBandLevel(heapBand(1676).rawPct), 'NORMAL', 'the helper reads the raw ratio')
  // 1677/2096 = 80,00 % → WARN, exactly as before the lane.
  assert.equal(heapBand(1677).level, 'WARN')
  assert.equal(daemonPressure(1677 * 1024, null).level, 'WARN')
  assert.equal(referenceBandLevel(heapBand(1677).rawPct), 'WARN')
})

test('THE CEILING IS THE MEASURED 2096 MB, never the 5,8 G CGROUP peak (fb-1587)', () => {
  assert.equal(HEAP_CEILING_MB, 2096)
  // The defect this pins: with a 5,8 G denominator the fatal daemon's 3261 MB
  // of RSS reads 56 % — NORMAL — at the very instant it was dying.
  const withRealCeiling = heapBand(3261, HEAP_CEILING_MB)
  const withCgroupPeak = heapBand(3261, 5800)
  assert.equal(withRealCeiling.level, 'CRITICAL')
  assert.equal(withCgroupPeak.level, 'NORMAL')
  assert.notEqual(withRealCeiling.level, withCgroupPeak.level)
  // and the fatal incarnation's RSS is, as measured, ABOVE the heap ceiling
  assert.ok(withRealCeiling.usedPct > 150)
})

test('readHeartbeatHeap relays the daemon heap, and degrades to null (never a throw)', (t) => {
  const dir = fixtureDir(t)
  // (a) absent file → null (the state of the world BEFORE the daemon publishes it)
  assert.equal(readHeartbeatHeap(dir), null)
  // (b) a torn read — the daemon's writeFile is NOT atomic, so this really happens
  writeFileSync(path.join(dir, 'health-heartbeat.json'), '{"ts":1,"bootId":"x","heapM')
  assert.equal(readHeartbeatHeap(dir), null)
  // (c) a heartbeat WITHOUT the heap (every heartbeat written to date) → null
  writeFileSync(path.join(dir, 'health-heartbeat.json'), '{"ts":1,"bootId":"x","crashStreak":0}')
  assert.equal(readHeartbeatHeap(dir), null)
  // (d) the datum, when the daemon publishes one
  writeFileSync(path.join(dir, 'health-heartbeat.json'), '{"ts":1,"bootId":"x","heapMb":{"used":2000,"total":2048,"limit":2096}}')
  assert.deepEqual(readHeartbeatHeap(dir), { usedMb: 2000, limitMb: 2096 })
  // (e) no limit published → the caller must fall back to the MEASURED ceiling
  writeFileSync(path.join(dir, 'health-heartbeat.json'), '{"ts":1,"bootId":"x","heapMb":{"used":1800,"total":1900}}')
  assert.deepEqual(readHeartbeatHeap(dir), { usedMb: 1800, limitMb: null })
})

test('daemonBlock: an unresolvable daemon is a null block; a relayed heap names its source', () => {
  // A profile no daemon runs → the block is null (the degrade path, no throw).
  const absent = parseArgs(['--state-dir', '/nonexistent-fixture', '--profile', 'no-such-profile-xyz', '--quiet'])
  assert.equal(daemonBlock(absent, null, null).block, null)
  // The LIVE daemon of this host, banded from a relayed heap and from RSS.
  const live = parseArgs(['--state-dir', '/nonexistent-fixture', '--quiet'])
  const withHeap = daemonBlock(live, null, { usedMb: 2000, limitMb: 2096 })
  if (withHeap.block === null) return // no daemon resolvable in this environment
  // LANE heap-band-truth: the REAL figure drives BOTH the level and the basis,
  // and the row publishes the reference upper bound SIDE BY SIDE (not instead).
  const p = withHeap.block.pressure
  assert.equal(p.source, 'heapUsed')
  assert.equal(p.basis, 'heapUsed')
  assert.equal(p.usedMb, 2000)
  assert.equal(p.ceilingMb, 2096)
  assert.equal(p.usedPct, 95.4)
  assert.equal(p.level, 'CRITICAL')
  assert.equal(p.heapMb, 2000, 'the REAL datum is published as heapMb')
  assert.equal(p.heapLimitMb, 2096, 'and with its own denominator (the hard wall)')
  assert.ok(p.rssMb > 0, 'the RSS upper bound is ALSO published (same row, no join needed)')
  assert.equal(p.rssCeilingMb, HEAP_CEILING_MB)
  assert.ok(typeof p.basisNote === 'string' && p.basisNote.length > 0, 'the basis is DECLARED as prose (criterion 3)')
  const rssOnly = daemonBlock(live, null, null)
  assert.equal(rssOnly.block.pressure.source, 'rss-upper-bound')
  assert.equal(rssOnly.block.pressure.basis, 'rss-upper-bound')
  assert.equal(rssOnly.block.pressure.heapMb, null, 'no heap published → heapMb is null, not a fake number')
  assert.equal(rssOnly.block.pressure.ceilingMb, HEAP_CEILING_MB)
  assert.ok(Math.abs(rssOnly.block.pressure.usedMb - rssOnly.block.rssKb / 1024) < 0.01)
})

test('NO EMPTY SLOT: with no reading at all, the band is OMITTED — never a null placeholder', () => {
  // The law (fb-1587's "reserva vacía"): a field that always reads null is not a
  // datum. With NO rssKb and NO relayed heap there is nothing to band, so the
  // decision must be null and the caller must OMIT the key.
  assert.equal(daemonPressure(null, null), null)
  assert.equal(daemonPressure(undefined, null), null)
  assert.equal(daemonPressure(Number.NaN, null), null)
  // One reading is enough, and the source names WHICH datum was banded.
  // rssKb is in kB: 2 GiB of RSS = 2097152 kB = 2048 MB — banded against the
  // MEASURED ceiling that is 97,7 % — a REFERENCE, so the level is NOT CRITICAL
  // (see the criterion-2 test below for the measured reason).
  const rss2gib = daemonPressure(2097152, null)
  assert.equal(rss2gib.source, 'rss-upper-bound')
  assert.equal(rss2gib.basis, 'rss-upper-bound')
  assert.equal(rss2gib.usedMb, 2048)
  assert.equal(rss2gib.ceilingMb, HEAP_CEILING_MB)
  assert.equal(rss2gib.usedPct, 97.7)
  assert.equal(rss2gib.level, 'WARN')
  const rss1gib = daemonPressure(1024 * 1024, null)
  assert.equal(rss1gib.usedPct, 48.9)
  assert.equal(rss1gib.level, 'NORMAL')
  const heap = daemonPressure(null, { usedMb: 1900, limitMb: 2096 })
  assert.equal(heap.source, 'heapUsed')
  assert.equal(heap.basis, 'heapUsed')
  assert.equal(heap.usedPct, 90.6)
  assert.equal(heap.level, 'CRITICAL', 'the HEAP basis keeps CRITICAL: its denominator IS the hard wall')
  // The daemon's own heap WINS over RSS when both exist (it is the real datum).
  assert.equal(daemonPressure(9999, { usedMb: 100, limitMb: 2096 }).source, 'heapUsed')
})

// ---------------------------------------------------------------------------
// LANE `heap-band-truth` (2026-09-22) — THE THREE ACCEPTANCE CRITERIA.
// ---------------------------------------------------------------------------

test('criterion 1: BOTH figures and their provenance are published (real heap + reference upper bound)', () => {
  // The real datum AND the upper bound, in the SAME row, each with its own
  // denominator — a reader never has to join two sources to tell them apart.
  const withBoth = daemonPressure(2097152, { usedMb: 1900, limitMb: 2096 })
  assert.equal(withBoth.heapMb, 1900, "THE REAL FIGURE (the daemon's own heap)")
  assert.equal(withBoth.heapLimitMb, 2096, "the real figure's own denominator (the hard wall)")
  assert.equal(withBoth.rssMb, 2048, 'the reference UPPER BOUND, published side by side')
  assert.equal(withBoth.rssCeilingMb, HEAP_CEILING_MB, 'and the reference denominator')
  assert.equal(withBoth.rssUsedPct, 97.7)
  // Without the real datum the reference still carries everything it can, and
  // the PROVENANCE of each figure is explicit rather than implied by a key name.
  const refOnly = daemonPressure(2097152, null)
  assert.equal(refOnly.heapMb, null, 'the absent real datum is null — never a substitute number')
  assert.equal(refOnly.usedMb, 2048)
  assert.match(refOnly.basisNote, /UPPER BOUND/)
  assert.match(daemonPressure(null, { usedMb: 1900, limitMb: 2096 }).basisNote, /HARD WALL/)
})

test('criterion 2: the level is derived from the REAL figure, and `CRITICAL` is reserved to it', () => {
  // A KNOWN relation between the real figure and the ceiling decides the level.
  // heap 1900 / limit 2096 = 90,6 % → CRITICAL, and the basis says WHY that
  // word is allowed here: the denominator is V8's heap_size_limit (a hard wall).
  const wall = daemonPressure(null, { usedMb: 1900, limitMb: 2096 })
  assert.equal(wall.level, 'CRITICAL')
  assert.equal(wall.basis, 'heapUsed')
  assert.equal(wall.usedPct, 90.6)
  // The SAME ratio read against the REFERENCE basis is NOT the same claim: RSS
  // is an upper bound and its denominator is a number the process can exceed, so
  // the terminal word is not available — it reads WARN (a legitimate early
  // warning), never CRITICAL.
  const ref = daemonPressure(1900 * 1024, null)
  assert.equal(ref.usedPct, 90.6, 'same ratio, deliberately')
  assert.equal(ref.level, 'WARN', 'the reference basis cannot claim the wall is near')
  assert.notEqual(ref.level, wall.level, 'the SAME number under the two bases must not read the same claim')
  // ABOVE 100 % of the reference is an EVERYDAY state on this host (measured:
  // 6385 of 8910 samples) — and the norm's OWN table proves RSS does not decide
  // the heap: pid 810027 lived 62,8 h at 187 % of the ceiling while pid 1191415
  // died at 156 % of it. It is named for what it is, not for a death it cannot
  // predict.
  const above = daemonPressure(2250 * 1024, null)
  assert.equal(above.usedPct, 107.3)
  assert.equal(above.level, ABOVE_REFERENCE_LEVEL)
  assert.notEqual(above.level, 'CRITICAL')
  assert.equal(above.rssLevel, ABOVE_REFERENCE_LEVEL, 'the side-by-side reference level says the same thing')
  // The WARN threshold itself is UNTOUCHED — 79,96 % stays NORMAL (the rounding
  // decision in heapBand is deliberate: rounding first would move the threshold).
  assert.equal(daemonPressure(1676 * 1024, null).level, 'NORMAL')
  assert.equal(daemonPressure(1677 * 1024, null).level, 'WARN')
  // A reading ABOVE the hard wall (the fatal 3261 MB) is still CRITICAL when the
  // HEAP is what is being banded: there the ceiling is a wall.
  assert.equal(daemonPressure(null, { usedMb: 3261, limitMb: 2096 }).level, 'CRITICAL')
})

test('criterion 3: the render DECLARES which of the two it is publishing (the `basis:` rule)', () => {
  const refRow = {
    iso: '2026-09-22T19:00:00.000Z',
    load1: 1,
    tickMs: 4,
    psi: { cpu: { some: { avg60: 1 } }, io: { some: { avg60: 1 } }, memory: { some: { avg60: 0 } } },
    daemon: { rssKb: 2048 * 1024, pressure: daemonPressure(2097152, null) },
  }
  const refLine = renderStatus(refRow, 7)
  assert.match(refLine, /basis=rss-upper-bound/, 'the render says WHICH datum it publishes')
  assert.match(refLine, /REFERENCE, not the heap/, 'and it says what that denominator is NOT')
  assert.match(refLine, /rss=\d+MB/, 'and carries the published figure explicitly')
  // With the real datum the render declares the OTHER basis and the hard wall.
  const heapRow = {
    ...refRow,
    daemon: { rssKb: 2048 * 1024, pressure: daemonPressure(2097152, { usedMb: 1900, limitMb: 2096 }) },
  }
  const heapLine = renderStatus(heapRow, 8)
  assert.match(heapLine, /basis=heapUsed/)
  assert.match(heapLine, /HARD WALL/)
  assert.doesNotMatch(heapLine, /REFERENCE, not the heap/)
})

test('THE BAND IS IN THE ROW: --once publishes daemon.pressure of the DECLARED keys, with NO null slot', (t) => {
  const dir = fixtureDir(t)
  writeFileSync(path.join(dir, 'health-heartbeat.json'), '{"ts":1,"bootId":"x","heapMb":{"used":2000,"total":2048,"limit":2096}}')
  const stdout = execFileSync(process.execPath, [SAMPLER, '--once', '--state-dir', dir, '--quiet'], { encoding: 'utf8' })
  const row = JSON.parse(stdout)
  if (row.daemon === null) return // no resolvable daemon on this host: nothing to pin here
  // EXACT key set: a renamed/added field breaks the readers, so it breaks here too
  assert.deepEqual(Object.keys(row.daemon), ['unit', 'profile', 'pid', 'rssKb', 'vmSizeKb', 'threads', 'state', 'cpuTicks', 'pressure'])
  // LANE `heap-band-truth` (2026-09-22): the declared pressure key set — the
  // basis declaration + BOTH figures (real heap, reference upper bound).
  assert.deepEqual(Object.keys(row.daemon.pressure), [
    'source', 'basis', 'basisNote', 'usedMb', 'ceilingMb', 'usedPct', 'level',
    'heapMb', 'heapLimitMb', 'rssMb', 'rssCeilingMb', 'rssUsedPct', 'rssLevel',
  ])
  assert.equal(row.daemon.pressure.source, 'heapUsed')
  assert.equal(row.daemon.pressure.basis, 'heapUsed')
  assert.equal(row.daemon.pressure.usedMb, 2000)
  assert.equal(row.daemon.pressure.ceilingMb, 2096)
  assert.equal(row.daemon.pressure.usedPct, 95.4)
  assert.equal(row.daemon.pressure.level, 'CRITICAL')
  assert.equal(row.daemon.pressure.heapMb, 2000, 'the REAL figure is the published heapMb')
  assert.equal(row.daemon.pressure.basisNote, HEAP_BASIS.heapUsed, 'the basis is declared verbatim')
  // THE LAW: no READING field may be an empty slot. The `heapMb`/`heapLimitMb`
  // pair is NOT a reading on the reference basis — it is the declared absence of
  // one (null, with `basis` naming the substitute), which is why the two are
  // checked per basis and never blanket-asserted non-null.
  for (const k of ['source', 'basis', 'basisNote', 'usedMb', 'ceilingMb', 'usedPct', 'level', 'rssMb', 'rssCeilingMb', 'rssUsedPct', 'rssLevel']) {
    assert.notEqual(row.daemon.pressure[k], null, `pressure.${k} must never be a null slot`)
  }
})

test('THE ALERT: a WARN/CRITICAL crossing is written to the sampler log (once per crossing)', (t) => {
  const dir = fixtureDir(t)
  const log = path.join(dir, 'sampler.log')
  // (a) the REAL datum (the daemon published its heap) → CRITICAL is allowed
  // and the line declares the basis (lane heap-band-truth, criterion 3).
  writeFileSync(path.join(dir, 'health-heartbeat.json'), '{"ts":1,"bootId":"x","heapMb":{"used":2000,"total":2048,"limit":2096}}')
  const opts = parseArgs(['--state-dir', dir, '--quiet', '--log', log])
  const state = { daemonPid: null, stateDirBlock: null, ticks: 0, bandLevel: null }
  const sample = tick(opts, state)
  if (sample.daemon === null) return // no resolvable daemon on this host
  const text = readFileSync(log, 'utf8')
  assert.match(text, /HEAP CRITICAL \(basis=heapUsed\): 2000 MB of 2096 MB = 95\.4%/)
  assert.match(text, /HARD WALL/)
  assert.match(text, /INVESTIGATE/)
  assert.match(text, /Reached heap limit/)
  // ONCE per crossing, not once per tick (the log is AUXILIARY, norm §6)
  tick(opts, state)
  const after = readFileSync(log, 'utf8').split('HEAP CRITICAL').length - 1
  assert.equal(after, 1, 'the CRITICAL line must not repeat every tick')
  // (b) THE REFERENCE BASIS: with NO heap published the line must NOT claim the
  // hard wall — it declares the basis and says what the denominator is not.
  // This is the lane's own regression pin: the old line read
  // «HEAP CRITICAL (rss-upper-bound) … this daemon can die with FATAL ERROR».
  const dir2 = fixtureDir(t)
  const log2 = path.join(dir2, 'sampler.log')
  const opts2 = parseArgs(['--state-dir', dir2, '--quiet', '--log', log2])
  const state2 = { daemonPid: null, stateDirBlock: null, ticks: 0, bandLevel: null }
  const sample2 = tick(opts2, state2)
  if (sample2.daemon === null || sample2.daemon.pressure === undefined) return
  const text2 = readFileSync(log2, 'utf8')
  assert.match(text2, /basis=rss-upper-bound/, 'the reference basis declares itself')
  assert.match(text2, /NOT a wall/, 'and says the denominator is not a hard wall')
  assert.doesNotMatch(text2, /Reached heap limit/, 'never the wall`s death sentence on a reference reading')
  assert.doesNotMatch(text2, /HEAP CRITICAL \(basis=rss-upper-bound\)/, 'CRITICAL is not in the reference vocabulary')
})
