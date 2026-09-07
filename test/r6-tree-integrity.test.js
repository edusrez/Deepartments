// dsh-deepartments — R6 TREE-INTEGRITY test (fb-91).
//
// The fb-91 incident (2026-09-04): the suite AUTO-MUTATED the CUT-4 factory
// packages/dshd-orchestration/src/tools.ts ±1B mid-run and the tree was
// restored before the end — no before/after-only check could see it. This test
// is the STANDALONE hygiene layer of the detector (the authoritative one is
// the wrapper `scripts/r6-suite-guard.mjs`, wired as `pnpm test:guarded`,
// which snapshots BEFORE, polls DURING and verifies AFTER the whole suite):
//
//   1. the guard helper exists and is wired (the suite HAS the detector);
//   2. the guarded file matches git HEAD — a tree LEFT mutated by a previous
//      run fails loudly (the net that was missing); gracefully skips when the
//      tree is INTENTIONALLY dirty (shared-tree lane WIP) or git is absent;
//   3. hermetic: the guard's snapshot/zone logic actually detects a ±1B
//      mid-run rewrite (a temp fixture, never the repo);
//   4. the CUT-4 zone span is still sliceable in the source (the frozen
//      tools-factory.test.js md5 lock keeps its prey).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REPO_ROOT,
  GUARDED_FILE_REL,
  GUARDED_FILE,
  zoneMd5,
  zoneMd5WithMarkers,
  fileSnapshot,
  diffSnapshots,
  gitHeadText,
  ZONE_BANNER,
  ZONE_CLOSE,
  loadZoneManifest,
  ZONE_MANIFEST_FILE,
  diffManifestZones,
} from '../scripts/r6-suite-guard.mjs'

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))

test('r6-tree-integrity (fb-91): the suite HAS the detector — the guard helper exists and `test:guarded` wires it', () => {
  const guardRel = 'scripts/r6-suite-guard.mjs'
  const guardPath = path.join(REPO_ROOT, guardRel)
  const guardSrc = readFileSync(guardPath, 'utf8')
  assert.match(guardSrc, /R6 SUITE-INTEGRITY GUARD \(fb-91\)/, 'the helper documents the fb-91 purpose')
  assert.match(guardSrc, /ZONE_BANNER/, 'the helper extracts the CUT-4 zone with the SAME markers as the frozen tools-factory.test.js')
  assert.equal(typeof pkg.scripts?.['test:guarded'], 'string', 'package.json has a test:guarded script')
  assert.match(pkg.scripts['test:guarded'], new RegExp(`node ${guardRel.replaceAll('.', '\\.')}(\\s|$)`), 'test:guarded runs the guard helper')
})

test('r6-tree-integrity (fb-91): the guarded factory matches git HEAD (a tree LEFT mutated by a prior run fails) — skips on intentional shared-tree WIP / no git', (t) => {
  const start = fileSnapshot(readFileSync(GUARDED_FILE, 'utf8'))
  const headText = gitHeadText(GUARDED_FILE_REL)
  if (headText === undefined) {
    t.skip('git is unavailable in this checkout — the git-HEAD comparison cannot run (the guard wrapper is the authoritative detector)')
    return
  }
  const headSnap = fileSnapshot(headText)
  const deltas = diffSnapshots(headSnap, start)
  if (deltas.length > 0 && process.env.R6_GUARD_SKIP_START === '1') {
    t.skip('R6_GUARD_SKIP_START=1 — shared-tree lane WIP on the guarded file; run on a quiet tree for the authoritative verdict')
    return
  }
  assert.deepEqual(deltas, [], `the guarded file must equal git HEAD at suite time (a pre-existing mutation = the fb-91 window); deltas: ${deltas.join('; ')}`)
})

test('r6-tree-integrity (fb-91): the detector itself works — a ±1B mid-run rewrite of the CUT-4 zone is caught and a restore is seen as clean (hermetic fixture)', () => {
  const zone =
    '  // --- messaging bus TOOL DEFINITIONS (ONE body per tool; registered in the\n' +
    '  const feedbackTool = defineTool({ name: "dept_feedback" })\n' +
    "  }, 'deepartments: host-plane tools')\n"
  const fixture = zone + '  // tail outside the CUT-4 zone\n'
  const snapA = fileSnapshot(fixture)
  // ±1B INSIDE the zone (a newline after the banner line): whole-file AND zone md5 change.
  const insidePlus1 = fixture.replace(
    'registered in the\n  const feedbackTool',
    'registered in the\n\n  const feedbackTool',
  )
  assert.ok(insidePlus1.length === fixture.length + 1, 'the inside-zone delta is exactly ±1B (byte length)')
  assert.notEqual(fileSnapshot(insidePlus1).md5, snapA.md5, 'a ±1B delta changes the whole-file md5')
  assert.notEqual(fileSnapshot(insidePlus1).zoneMd5, snapA.zoneMd5, 'a ±1B delta INSIDE the zone changes the CUT-4 zone md5')
  // Same-length change OUTSIDE the zone (a char swap in the tail): whole-file md5 changes, zone md5 untouched.
  const outsideShift = fixture.replace('tail outside', 'tali outside')
  assert.ok(outsideShift.length === fixture.length, 'the outside-zone mutation is same-length')
  assert.notEqual(fileSnapshot(outsideShift).md5, snapA.md5, 'a change OUTSIDE the zone still changes the whole-file md5')
  assert.equal(fileSnapshot(outsideShift).zoneMd5, snapA.zoneMd5, 'a change OUTSIDE the zone leaves the CUT-4 zone md5 untouched (the zone scoping the guard + the frozen test share)')
  // An append at EOF (the fb-91 trailing-byte class OUTSIDE the span) does not touch the zone md5.
  assert.equal(fileSnapshot(fixture + '\n').zoneMd5, snapA.zoneMd5, 'a trailing ±1B append outside the span keeps the zone md5 (the guard reports it via the whole-file/end checks)')
  assert.deepEqual(diffSnapshots(snapA, snapA), [], 'identical snapshots diff to []')
  assert.ok(diffSnapshots(snapA, fileSnapshot(insidePlus1)).length > 0, 'mutated snapshots diff non-empty')
})

test('r6-tree-integrity (fb-91): the CUT-4 zone span is sliceable in the current source (the frozen factory keeps its prey)', () => {
  const factory = readFileSync(GUARDED_FILE, 'utf8')
  const first = factory.indexOf(ZONE_BANNER)
  const last = factory.indexOf(ZONE_CLOSE)
  assert.ok(first !== -1, 'the zone banner is present in src tools.ts')
  assert.ok(last !== -1 && last > first, 'the zone close is present after the banner')
  const z = zoneMd5(factory)
  assert.ok(typeof z === 'string' && z.length === 32, 'the zone md5 computes (a non-null 32-hex hash)')
})

test('r6-tree-integrity (P2-HYGIENE): the per-zone md5 MANIFEST exists, carries the CUT-4 zone, and its frozen value matches BOTH the current source AND the freeze lock (commit-drift detection is armed)', () => {
  // (a) the manifest file exists and parses (NEVER throws → undefined when absent).
  const manifest = loadZoneManifest()
  assert.ok(manifest !== undefined && manifest.zones.length > 0, `the manifest loads (${ZONE_MANIFEST_FILE})`)
  // (b) the CUT-4 zone entry is present with the frozen md5.
  const cut4 = manifest.zones.find((z) => z.id === 'cut4-tools-zone')
  assert.ok(cut4 !== undefined, 'the manifest carries the cut4-tools-zone entry')
  assert.ok(/^[0-9a-f]{32}$/.test(cut4.md5), 'the frozen md5 is a 32-hex hash')
  // (c) the frozen manifest value equals the CURRENT source's zone md5 — the
  // guard's START assert stays green on a quiet tree.
  const current = zoneMd5WithMarkers(readFileSync(path.join(REPO_ROOT, cut4.file), 'utf8'), cut4.banner, cut4.close)
  assert.equal(current, cut4.md5, 'the manifest frozen md5 matches the CURRENT source zone md5 (no drift-to-commit today)')
  // (d) the manifest frozen value equals the FROZEN TEST literal — the freeze
  // lock (tools-factory.test.js:348) and the manifest must move in the SAME
  // commit (a re-freeze that forgets one of the two fails this test).
  const freezeTest = readFileSync(path.join(REPO_ROOT, 'test', 'tools-factory.test.js'), 'utf8')
  assert.match(freezeTest, new RegExp(`'${cut4.md5}'`), 'the manifest frozen md5 is the SAME value the freeze lock asserts (byte-synced re-freeze)')
  // (e) the drift detector itself works — a mid-span mutation changes the zone
  // md5 (the exact class a NEW HEAD zone change would produce). Diff the REAL
  // source text with a +1B INSIDE the span (the banner line gets one extra
  // space — same-length semantics as the hermetic ±1B test above, but on the
  // real file text, without touching disk); the manifest START/END assert keys
  // on this md5 delta.
  const realSource = readFileSync(path.join(REPO_ROOT, cut4.file), 'utf8')
  const inSpanPlus1 = realSource.replace(cut4.banner, cut4.banner + ' ')
  assert.equal(inSpanPlus1.length, realSource.length + 1, 'the in-span delta is exactly +1B')
  const mutatedMd5 = zoneMd5WithMarkers(inSpanPlus1, cut4.banner, cut4.close)
  assert.notEqual(mutatedMd5, cut4.md5, 'a +1B mutation INSIDE the span changes the zone md5 (the drift class the manifest detects)')
  assert.deepEqual(diffManifestZones(manifest), [], 'the REAL manifest file still matches the real source (the mutation probe above was in-memory — disk untouched)')
})