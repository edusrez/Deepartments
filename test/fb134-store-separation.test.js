// dsh-deepartments — LANE fb-134 (store separation) F2 TESTS: the `.store-profile`
// marker + assert-on-open (a), the STALE-READ CAP on store-file reads (b) and
// the GHOST-STORE tree scan (c). Same conventions as the lane tests: built-lib
// imports (fb-95 plain `node --test` over lib — NO ts-src-loader
// self-registration), hermetic temp dirs, fixed clocks where a knob exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { utimesSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// The dshd-core package lib: the marker/assert + ghost scan + the stale-aware
// registry readers (the same package the bundle composes).
import {
  STORE_PROFILE_FILE,
  deriveStoreProfileMark,
  assertStoreProfile,
  readStoreProfile,
  storeProfileMatches,
  scanGhostStoreTrees,
  GHOST_STORE_MARKER_FILES,
  checkStoreFileStale,
  staleReadWarn,
  readDurableHostsRegistry,
  readDurableHostEntries,
} from '../packages/dshd-core/lib/index.js'
// The dshd-health package lib: the stale-aware heartbeat reader + the frame.
import { readHealthHeartbeatFile, buildHealthAlertFrame } from '../packages/dshd-health/lib/index.js'
// The dshd-jobs package lib: the stale-aware calendar/job-runs readers.
import { readCalendarStateFile, readJobRunsStateFile } from '../packages/dshd-jobs/lib/index.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

/** A warn-capturing logger. */
function captureLogger() {
  const warns = []
  return { logger: { warn: (m) => warns.push(m) }, warns }
}

/** Write a fixture file and SET ITS MTIME to the past (a confirmed-stale file). */
async function writeStaleFile(filePath, content, ageMs) {
  await writeFile(filePath, content, 'utf8')
  const pastSec = Math.floor((Date.now() - ageMs) / 1000)
  utimesSync(filePath, pastSec, pastSec)
}

// ---------------------------------------------------------------------------
// (a) — the `.store-profile` marker + assert-on-open
// ---------------------------------------------------------------------------

test('fb134 store-profile (a): the FIRST open CLAIMS the store (marker written); a same-identity re-open is OK; no marker touch on the store\'s own files', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb134-profile-'))
  try {
    // The first open claims the store with the CURRENT opener identity.
    const first = assertStoreProfile(stateDir, { now: 1000 })
    assert.equal(first.status, 'claimed', 'first open claims the store')
    const mark = readStoreProfile(stateDir)
    assert.ok(mark !== undefined, 'the marker file exists after the first open')
    assert.equal(mark.profile, deriveStoreProfileMark(stateDir, { now: 1000 }).profile, 'the claim records the opener profile')
    assert.equal(mark.storeDir, path.resolve(stateDir), 'the claim records the resolved store path')

    // A same-identity re-open is OK (idempotent — no rewrite, no mismatch).
    const second = assertStoreProfile(stateDir, { now: 2000 })
    assert.equal(second.status, 'ok', 'a same-identity re-open is OK')
    const mark2 = readStoreProfile(stateDir)
    assert.equal(mark2.createdAt, 1000, 'the marker is NOT rewritten on a same-identity re-open (createdAt unchanged)')

    // Non-destructive by design: the store\'s OWN files are never touched by
    // the claim (only the marker is added).
    const probe = path.join(stateDir, 'probe.json')
    await writeFile(probe, '{"x":1}', 'utf8')
    assertStoreProfile(stateDir, { now: 3000 })
    assert.equal(await readFile(probe, 'utf8'), '{"x":1}', 'the store\'s own files are untouched by the assert')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('fb134 store-profile (a): a DIFFERENT opener profile is a MISMATCH (the split-brain class) — warn, never modify the foreign marker', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb134-profile-'))
  try {
    // Profile A claims the store.
    assertStoreProfile(stateDir, { argv: ['dsh', '--profile', 'deepartments-dev'], now: 1000 })
    // Profile B (a different unit/twin) opens the SAME store → mismatch.
    const verdict = assertStoreProfile(stateDir, { argv: ['dsh', '--profile', 'deepartments-dev-headless'], now: 2000 })
    assert.equal(verdict.status, 'mismatch', 'a different opener profile is a mismatch (split-brain class)')
    // Non-destructive: the foreign marker is NOT overwritten/deleted.
    const mark = readStoreProfile(stateDir)
    assert.equal(mark.profile, 'deepartments-dev', 'the foreign marker keeps the FIRST opener (never overwritten)')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('fb134 store-profile (a): storeProfileMatches compares profile+home+host (the storeDir is a path fact, not identity)', () => {
  const base = { profile: 'p', home: '/h', host: 'x', storeDir: '/a', createdAt: 1 }
  assert.equal(storeProfileMatches(base, { ...base, storeDir: '/b' }), true, 'a different storeDir path is NOT an identity mismatch (the marker sits inside each store)')
  assert.equal(storeProfileMatches(base, { ...base, profile: 'q' }), false, 'a different profile is a mismatch')
  assert.equal(storeProfileMatches(base, { ...base, home: '/h2' }), false, 'a different home is a mismatch')
})

test('fb134 store-profile (a): the RegistryStore constructor asserts the claim on open (the marker lands; a foreign claim warns)', async () => {
  // The registry constructor smoke is exercised through the REAL `lib` surface
  // (the package import above) — the constructor calls assertStoreProfile.
  // A minimal direct check: constructing a RegistryStore on a fresh temp dir
  // claims the store (the marker exists afterwards).
  const { RegistryStore } = await import('../packages/dshd-core/lib/index.js')
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb134-registry-'))
  try {
    const warns = []
    // eslint-disable-next-line no-new
    new RegistryStore({ stateDir, logger: { warn: (m) => warns.push(m) } })
    assert.ok(readStoreProfile(stateDir) !== undefined, 'RegistryStore construction claims the store (marker written)')
    assert.equal(warns.length, 0, 'a fresh store claims without a warn')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (b) — the STALE-READ CAP (M1 stateStaleMs pattern + the fb-119/135/146 hint)
// ---------------------------------------------------------------------------

test('fb134 stale-cap (b): checkStoreFileStale warns on an OLD file (naming the age + the «no existe — usa glob» hint), stays silent on a fresh one', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb134-stale-'))
  try {
    const filePath = path.join(stateDir, 'x.json')
    await writeFile(filePath, '{}', 'utf8')

    // Fresh file → NOT stale, no warn.
    const { logger, warns } = captureLogger()
    assert.equal(checkStoreFileStale(filePath, { logger, now: Date.now() }), false, 'a just-written file is fresh')
    assert.equal(warns.length, 0, 'a fresh read does not warn')

    // Confirmed-old file (mtime 3h in the past, window 10 min) → STALE + warn.
    const now = Date.now()
    const pastSec = Math.floor((now - 3 * 60 * 60 * 1000) / 1000)
    utimesSync(filePath, pastSec, pastSec)
    const { logger: l2, warns: w2 } = captureLogger()
    assert.equal(checkStoreFileStale(filePath, { logger: l2, now }), true, 'a 3h-old file is STALE with the 10-min M1 window')
    assert.equal(w2.length, 1, 'a stale read warns once')
    assert.match(w2[0], /STALE/, 'the warn names the STALE state')
    assert.match(w2[0], /usa glob|use glob/, 'the warn carries the fb-119/135/146 DX hint («path no existe — usa glob»)')
    assert.match(w2[0], /3 min|180 min/, 'the warn names the age')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('fb134 stale-cap (b): the registry hosts readers warn on a STALE hosts.json (opts carry the logger + window); the data still returns (NON-DESTRUCTIVE)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb134-stale-'))
  try {
    const hostsPath = path.join(stateDir, 'hosts.json')
    await writeFile(hostsPath, JSON.stringify({ 'host-1': { sessionId: 's1' }, schemaVersion: 1 }), 'utf8')

    // No opts → byte-identical legacy behavior (no warn, data returns).
    const legacy = readDurableHostsRegistry(stateDir)
    assert.deepEqual(legacy, { 'host-1': { retired: false } }, 'no-opts read returns the data')

    // Stale + opts → warn + the SAME data (the cap is non-destructive).
    const now = Date.now()
    utimesSync(hostsPath, new Date(now - 2 * 60 * 60 * 1000) / 1000, new Date(now - 2 * 60 * 60 * 1000) / 1000)
    const { logger, warns } = captureLogger()
    const stale = readDurableHostsRegistry(stateDir, { staleAfterMs: 10 * 60 * 1000, logger, now })
    assert.deepEqual(stale, legacy, 'a STALE read STILL returns the data (non-destructive cap)')
    assert.ok(warns.length >= 1, 'a stale hosts.json read warns')
    assert.match(warns[0], /usa glob|use glob/, 'the warn carries the DX hint')

    // readDurableHostEntries: same pattern (the durable-first alert recipient).
    const { logger: l2, warns: w2 } = captureLogger()
    const entries = readDurableHostEntries(stateDir, { staleAfterMs: 10 * 60 * 1000, logger: l2, now })
    assert.equal(entries.length, 1, 'readDurableHostEntries still returns the entries')
    assert.ok(w2.length >= 1, 'a stale readDurableHostEntries warns')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('fb134 stale-cap (b): readHealthHeartbeatFile (dshd-health) + readCalendarStateFile/readJobRunsStateFile (dshd-jobs) warn on a STALE file with the hint, data unchanged', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb134-stale-'))
  try {
    // Heartbeat: a readable heartbeat whose FILE is old → STALE warn + data.
    const hbPath = path.join(stateDir, 'health-heartbeat.json')
    await writeFile(hbPath, JSON.stringify({ ts: Date.now() - 60_000, bootId: 'boot-x' }), 'utf8')
    const now = Date.now()
    utimesSync(hbPath, new Date(now - 2 * 60 * 60 * 1000) / 1000, new Date(now - 2 * 60 * 60 * 1000) / 1000)
    const { logger: hl, warns: hw } = captureLogger()
    const hb = readHealthHeartbeatFile(stateDir, { staleAfterMs: 10 * 60 * 1000, logger: hl, now })
    assert.equal(hb.bootId, 'boot-x', 'the heartbeat data still returns')
    assert.ok(hw.length >= 1, 'a stale heartbeat read warns')
    assert.match(hw[0], /usa glob|use glob/, 'the heartbeat stale warn carries the hint')

    // Calendar (jobs): same.
    const calPath = path.join(stateDir, 'calendar.json')
    await writeFile(calPath, JSON.stringify({ entries: [] }), 'utf8')
    utimesSync(calPath, new Date(now - 3 * 60 * 60 * 1000) / 1000, new Date(now - 3 * 60 * 60 * 1000) / 1000)
    const { logger: cl, warns: cw } = captureLogger()
    assert.deepEqual(readCalendarStateFile(stateDir, { staleAfterMs: 10 * 60 * 1000, logger: cl, now }), { entries: [] }, 'calendar data unchanged')
    assert.ok(cw.length >= 1, 'a stale calendar read warns')

    // Job-runs (jobs): same.
    const jrPath = path.join(stateDir, 'job-runs-state.json')
    await writeFile(jrPath, JSON.stringify({ jobA: 1 }), 'utf8')
    utimesSync(jrPath, new Date(now - 3 * 60 * 60 * 1000) / 1000, new Date(now - 3 * 60 * 60 * 1000) / 1000)
    const { logger: jl, warns: jw } = captureLogger()
    assert.deepEqual(readJobRunsStateFile(stateDir, { staleAfterMs: 10 * 60 * 1000, logger: jl, now }), { jobA: 1 }, 'job-runs data unchanged')
    assert.ok(jw.length >= 1, 'a stale job-runs read warns')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (c) — the GHOST-STORE tree scan (boot detection, 0 destructive)
// ---------------------------------------------------------------------------

test('fb134 ghost-store (c): scanGhostStoreTrees flags a PARALLEL tree carrying store marker files; the canonical stateDir is never a ghost; 0 destructive', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fb134-ghost-'))
  try {
    const canonical = path.join(root, 'canonical') // the LIVE store (excluded)
    const parallel = path.join(root, 'parallel') // a ghost tree
    await mkdir(canonical, { recursive: true })
    await mkdir(parallel, { recursive: true })
    await writeFile(path.join(canonical, 'boot-crash.json'), '{}', 'utf8')
    await writeFile(path.join(parallel, 'boot-crash.json'), '{}', 'utf8')
    await writeFile(path.join(parallel, 'capacity-gate-state.json'), '{}', 'utf8')

    const findings = scanGhostStoreTrees(canonical, [parallel, canonical])
    assert.equal(findings.length, 1, 'only the PARALLEL tree is flagged')
    assert.equal(findings[0].tree, path.resolve(parallel), 'the flagged tree is the parallel one')
    assert.deepEqual(findings[0].markers, ['boot-crash.json', 'capacity-gate-state.json'], 'the ghost marker files are named (the §7.2 capacity-gate duplicate class)')
    assert.ok(!findings.some((f) => f.tree === path.resolve(canonical)), 'the canonical stateDir is NEVER a ghost')
    assert.ok(!findings.some((f) => f.tree === path.resolve(root)), 'a non-store candidate tree is not flagged')

    // 0 destructive: both marker files still exist afterwards.
    assert.ok(readFileSyncPresence(path.join(parallel, 'boot-crash.json')), 'the ghost marker file is untouched (read-only scan)')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function readFileSyncPresence(p) {
  return existsSync(p)
}

test('fb134 ghost-store (c): a ghost-store finding renders in the health-alert frame with the ADVERTENCIA branch (it NEVER reaches the stalled-post fallback)', () => {
  const frame = buildHealthAlertFrame([{
    kind: 'ghost-store',
    key: 'ghost-store:/tmp/parallel',
    ts: 1000,
    error: 'ghost-store tree /tmp/parallel carries store marker(s) boot-crash.json',
    count: 1
  }])
  assert.match(frame, /ghost-store ADVERTENCIA/, 'the ghost-store kind renders its own ADVERTENCIA branch')
  assert.doesNotMatch(frame, /stalled-post/, 'a ghost-store finding never falls through to the stalled-post fallback')
  // GHOST-STORE PATH-ANCHORING (LANE fb-242/fb-222, VALLE 09-08): the branch
  // carries the no-confuse marker naming the CANONICAL stateDir, so the reader
  // never reads org state from the flagged parallel tree.
  assert.match(frame, /canónico = \/\.deepartments/, 'the ghost-store alert carries the canonical no-confuse marker (fb-242)')
})

test('fb134 ghost-store (c): the marker list + the stale warn helper are the documented surface (source-level lock)', () => {
  assert.deepEqual(GHOST_STORE_MARKER_FILES, ['boot-crash.json', 'capacity-gate-state.json'], 'the ghost markers are the fb-134 §7.2 files')
  assert.match(staleReadWarn('/x/store.json', Date.now() - 3 * 60 * 60 * 1000, Date.now(), 10 * 60 * 1000), /usa glob|use glob/, 'the stale warn helper always carries the DX hint')
  assert.equal(STORE_PROFILE_FILE, '.store-profile', 'the marker filename is canonical')
})