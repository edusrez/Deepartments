// dsh-deepartments — R6 LADDER-FLAT test (fb-95).
//
// fb-95 (2026-09-04): running the WHOLE suite with
// `node --loader ./test/ts-src-loader.mjs --test` produces FALSE FAILS in the
// composition/Loader family even on a clean tree. The canonical method (see
// AGENTS.md "Tests (SRC-NATIVE method, fb-95)" + docs/VERIFICATION-LADDER.md):
// the DEFAULT test command is PLAIN `node --test` over the BUILT lib; the
// `ts-src-loader.mjs` hook is used ONLY by tests that SELF-REGISTER it
// (`register(new URL('./ts-src-loader.mjs', import.meta.url), …)` — the
// lane-② src-native family), never as a whole-suite CLI default. These tests
// BLIND the ladder against the `--loader` default creeping back into the repo.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT } from '../scripts/r6-suite-guard.mjs'

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))

test('r6-ladder-flat (fb-95): the DEFAULT test command is plain `node --test` (never the --loader variant)', () => {
  assert.equal(pkg.scripts?.test, 'node --test', 'package.json "test" must stay the PLAIN flat runner over the built lib')
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    assert.ok(!script.includes('--loader'), `no package.json script may hard-code the --loader default (script "${name}" = ${script})`)
  }
})

test('r6-ladder-flat (fb-95): every repo reference to ts-src-loader.mjs in test/ is a SELF-REGISTRATION — never a CLI --loader — and only lane-② src-native tests use it', () => {
  const testsDir = path.join(REPO_ROOT, 'test')
  const testFiles = readdirSync(testsDir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  // The R6 guard tests THEMSELVES discuss --loader (they enforce this rule);
  // the loader file defines the name. Every OTHER referencing file must be a
  // self-registering consumer.
  const guardTests = new Set(['r6-ladder-flat.test.js', 'r6-tree-integrity.test.js', 'ts-src-loader.mjs'])
  const referencing = testFiles.filter((f) => readFileSync(path.join(testsDir, f), 'utf8').includes('ts-src-loader.mjs'))
  const consumers = referencing.filter((f) => !guardTests.has(f))
  assert.ok(consumers.length >= 1, 'at least the self-registering lane-② tests reference the loader')
  for (const f of consumers) {
    const src = readFileSync(path.join(testsDir, f), 'utf8')
    assert.ok(!src.includes('--loader'), `${f} must not pass --loader on a child process (the hook is self-registered, never CLI-passed)`)
    assert.match(
      src,
      /register\(\s*new URL\('\.\/ts-src-loader\.mjs'/,
      `${f} must SELF-REGISTER the hook via register(new URL('./ts-src-loader.mjs', import.meta.url), …) — the fb-95 canonical pattern`,
    )
  }
})

// ⚠️ THE LIST BELOW IS A *PHOTO*, NOT A RULE (fb-1063, instance #1095 — the
// same class as fb-1053: a guard PHOTOGRAPHS a set and then compares it with a
// world that keeps MOVING ⇒ what it can honestly report is drift AGAINST A
// PHOTO, so it must name WHAT the set is, WHICH world it covers and WHEN the
// photo was taken). This family was last written on the date below: every
// self-registering test created AFTER it legitimately lands outside the photo,
// and that is not a defect of the product — it is the instrument comparing the
// present against a frozen past (fb-1063: NO-FALLO del producto / SÍ-DEFECTO
// DEL INSTRUMENTO). Substantiating command, from the repo root:
//   git log --reverse -S 'p2-snapshot-anchor.test.js' --format=%cs -- test/r6-ladder-flat.test.js | head -1
// The assertion below keeps its TEETH (it still fails) and declares the
// contract instead of pretending the world froze with the photo.
const LANE2_FAMILY_PHOTO_AT = '2026-09-07'

test('r6-ladder-flat (fb-95): the self-registering tests are lane-② src-native (their imports resolve into src, not the built lib)', () => {
  const testsDir = path.join(REPO_ROOT, 'test')
  const registerers = readdirSync(testsDir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => f !== 'r6-ladder-flat.test.js' && readFileSync(path.join(testsDir, f), 'utf8').includes("register(new URL('./ts-src-loader.mjs'"))
  assert.ok(registerers.length >= 4, 'the lane-② src-native family self-registers the hook (unexpectedly small set — the ladder convention drifted?)')
  const laneFamily = new Set([
    'lane2-g2-settle-nowake.test.js', 'lane2-gate-agecheck.test.js', 'lane2-redrive-backoff.test.js',
    'lane2-retire-grace-zombie.test.js', 'lane2-settle-rotatedto.test.js',
    'wakeseam-lane.test.js', 'dual-surface-session.test.js', 'foldins-tramo3A.test.js',
    'foldins-batchA.test.js', 'sweep-observability.test.js', 'o1ext-lane.test.js',
    // LANE R4 (2026-09-05): the abort-intents lane is src-native (the R4
    // write-ahead sidecar + listeners) and self-registers the hook — the same
    // lane-② family (the o1ext-lane pattern).
    'r4-abort-intents.test.js',
    // LANE R10 (2026-09-05): the workspace-clobber lane is src-native (the R10
    // hide-set merge guard + the real-Loader E2E) and self-registers the hook.
    'r10-workspace-clobber.test.js',
    // WAVE 7 LANE 4/4 (fb-132, 2026-09-05): the gate/wake-seam re-drive
    // settle lane is src-native (the DeliveryRedeliverer FIFO-gate settle over
    // the dshd-core src) and self-registers the hook (the lane2 pattern).
    'w7-fb132-gate-settle.test.js',
    // FB-132 WAKE-ON-DELIVERED (2026-09-06, the 2nd-half drain-on-wake lane):
    // the drainRecipientQueue primitive + the composed-wake fire test are
    // src-native (the DeliveryRedeliverer drain over the dshd-core src + the
    // bundle-src composed harness) — the same lane2 self-register pattern.
    'fb132-wake-on-delivered-drain.test.js',
    // FB-132 2nd-half DELTA (2026-09-06 — the reviewers addendum GAP MENOR):
    // the retired-target flavor (isDormantRecipient excludes retired entries)
    // is src-native (the REAL delivery factory predicate + the lane2-style
    // DeliveryRedeliverer sweep over the dshd-core src) — the same pattern.
    'fb132-retired-flavor.test.js',
// WAKE-SEAM mitigation suite (6fe390a, 2026-09-06): the engine-dormancy +
    // discriminador no-wake-head tests are src-native (the composed dshd-core
    // gate engine + the settle re-driver over the src) and self-register the
    // hook (the wakeseam-lane pattern).
    'wake-seam-mitigation.test.js',
    // VALLE 09-07 (BATCH-DRAIN, 2026-09-07): the drain-on-settle lane is
    // src-native (the composed bundle over the crate engine + the settle event)
    // and self-registers the hook (the wake-seam-mitigation pattern).
    'batch-drain.test.js',
    // P2 HYGIENE A (m-423 snapshot anchor, 2026-09-06): the pre-rotation
    // snapshot-anchor lane is src-native (the session-rotation graph) and
    // self-registers the hook (the lane2 pattern).
    'p2-snapshot-anchor.test.js',
  ])
  // ONE assertion, over the WHOLE difference, with the set shape declared: the
  // per-file `assert.ok(laneFamily.has(f))` loop this replaces failed on the
  // FIRST unexpected file and hid the rest (the radius was invisible).
  const unexpected = registerers.filter((f) => !laneFamily.has(f))
  assert.deepEqual(
    unexpected,
    [],
    `${unexpected.length} self-registering file(s) are NOT in the lane-② src-native family PHOTO of ${LANE2_FAMILY_PHOTO_AT} (${laneFamily.size} entries, last written that day) — the hook is self-registered by ${registerers.length} test files TODAY: what the set IS = the lane-② src-native tests that self-register the hook; what the contract IS = a self-registering file must be lane-②, and adding it to the laneFamily list IS the declaration (there is no other declaration site); what this RED does NOT mean = that the ladder convention drifted or that the product is broken (a file created AFTER the photo simply is not in it — fb-1063/#1095); next action = if the file(s) below are genuine lane-② src-native tests, add them to laneFamily and move the photo date to today, otherwise the assertion is doing its job. Rows: ${unexpected.join(', ')}`,
  )
})