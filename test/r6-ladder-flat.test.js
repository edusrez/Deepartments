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

// ─── THE CRITERION IS A PROPERTY, NOT A PHOTO (fb-1063/#1095, resolved
// 2026-09-17 by the lane `r6-ladder-flat-criterio`) ───────────────────────────
//
// WHAT WAS WRONG. The first form of the assertion below compared the
// self-registering files found in the tree against a FROZEN set
// (`laneFamily`, 19 entries, stamped `LANE2_FAMILY_PHOTO_AT = '2026-09-07'`).
// Its red was therefore triggered by a file's DATE OF BIRTH, not by any
// property of the product: nine self-registering files written after that date
// went red without one of them being a defect (fb-1063: NO-FALLO of the
// product / DEFECT OF THE INSTRUMENT). Re-dating the photo would have re-armed
// the same red on the next lane — what changed here is the CRITERION.
//
// WHAT THE TEST NAME DECLARES, AND WHAT IS NOW COMPUTED FROM IT. «their
// imports resolve into src, not the built lib» is TWO halves, and both are
// derived from each file's OWN import specifiers:
//   (1) NEGATIVE half — `builtLibSpecifiersOf(file)`: a self-registering test
//       whose specifier reaches a BUILT `lib/` tree is NOT lane-② src-native ⇒
//       RED, unless the file is NAMED in `LANE2_BUILT_LIB_EXCEPTIONS` **with
//       its reason**. A bare list is not a declaration: every entry of that Map
//       says WHY its helper is taken from the built artifact.
//   (2) POSITIVE half — `reachesSrc(file)`: the file must actually reach the
//       SOURCE (a specifier into a `src/` tree, or the `src/index.ts` bundle
//       named in the file). A hook self-registration that reaches nothing in
//       `src` would be an instrument with no object ⇒ RED.
//
// WHAT THE BASELINE IS NOW. `LANE2_SRC_NATIVE_BASELINE` (+ `…_AT`) is a
// DECLARED BASELINE, printed by this test as a diagnostic and NEVER the
// criterion: a src-native self-registering file written AFTER it does NOT turn
// this guard red — that is the whole point of the change — its drift is
// REPORTED, so it stays visible without becoming a false defect.
//
// THE TEETH ARE DEMONSTRATED, NOT PROMISED. A temporary self-registering file
// importing `../lib/…` while unnamed in the exceptions turns (1) RED with exit
// 1 (injection proof in the lane report; the injection was deleted afterwards).
const LANE2_SRC_NATIVE_BASELINE_AT = '2026-09-17'

/** DECLARED baseline (report-only, never the criterion): the self-registering
 * lane-② tests that take NO built-lib import, as declared on the date above. */
const LANE2_SRC_NATIVE_BASELINE = new Set([
  'batch-drain.test.js', 'contexto-gate-admision-7cf42c47.test.js',
  'dual-surface-session.test.js', 'fb132-retired-flavor.test.js',
  'fb132-wake-on-delivered-drain.test.js', 'fb1proc-abort-provenance-effect.test.js',
  'fb467-gate-fifo-huerfano.test.js', 'foldins-batchA.test.js',
  'foldins-tramo3A.test.js', 'ghostguard-retire-dispose-dispatch.test.js',
  'lane2-g2-settle-nowake.test.js', 'lane2-gate-agecheck.test.js',
  'lane2-redrive-backoff.test.js', 'lane2-settle-rotatedto.test.js',
  'monitorredo1-storm-guard-consumption.test.js', 'p2-snapshot-anchor.test.js',
  'r10-workspace-clobber.test.js', 'r4-abort-intents.test.js',
  'sello-unidad-tres-piezas-e5c92faa.test.js', 'sweep-observability.test.js',
  'w7-fb132-gate-settle.test.js', 'w9-b255-reroute-orphan-settle.test.js',
  'wake-seam-mitigation.test.js', 'wakeseam-lane.test.js',
])

/** THE NAMED EXCEPTIONS, EACH WITH ITS REASON: the self-registering lane-②
 * tests that DO import a BUILT `lib/` specifier. Being on this list is not a
 * loophole — it is the declaration the negative half above demands, and the
 * reason is asserted to be present (a filename with no reason is RED). */
const LANE2_BUILT_LIB_EXCEPTIONS = new Map([
  [
    'fb957-settle-cause.test.js',
    'imports `deptExecDenyReason` from the BUILT `lib/invoke.js`: it is the LIVE dept_exec scope-guard function the tool body itself calls (the r5-dx-guards convention, declared in that file own header comment), so the assertion is made against the bridge the runtime uses rather than against a src copy of it. `src/invoke.ts` exports the same function — the BUILT one is taken on purpose.',
  ],
  [
    'lane2-retire-grace-zombie.test.js',
    'imports the stateDir row readers (`deliveryStatus`, `parseDeliveryRows`, `resolveDeliveriesPath`, `resolveMessagesPath`) from the BUILT `lib/messages-store.js`: they are the row readers of the deployed artifact, used to read the stateDir rows the assertions speak about. `src/messages-store.ts` is a pure RE-EXPORT BRIDGE over `src/core/messages.js` (declared in its own header), so the same names are reachable from src as well — this exception is a DECLARED choice of the built reader, not a missing src export.',
  ],
  [
    'o1ext-lane.test.js',
    'imports the stateDir row readers (`deliveryStatus`, `parseDeliveryRows`, `resolveDeliveriesPath`, `resolveMessagesPath`) from the BUILT `lib/messages-store.js` — the same declared choice as `lane2-retire-grace-zombie.test.js` (the built reader for the rows, while the bundle under test is still booted from `src/index.ts`).',
  ],
  [
    'ipd-orphan-quiescent-reap-8deea5ac.test.js',
    'imports the stateDir row readers (`deliveryStatus`, `parseDeliveryRows`, `resolveDeliveriesPath`, `resolveMessagesPath`) from the BUILT `lib/messages-store.js` — the same declared choice as `lane2-retire-grace-zombie.test.js` (the built reader for the rows, while the bundle under test is still booted from `src/index.ts`).',
  ],
])

/** The import seams NAMED IN A FILE'S OWN TEXT: static `from`, dynamic
 * `import(…)`, `require(…)`. These are the DIRECT specifiers — never the
 * transitive graph behind them. */
const IMPORT_SPECIFIER_PATTERNS = [
  /from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function importSpecifiersOf(file) {
  const src = readFileSync(path.join(REPO_ROOT, 'test', file), 'utf8')
  const out = new Set()
  for (const re of IMPORT_SPECIFIER_PATTERNS) for (const m of src.matchAll(re)) out.add(m[1])
  return out
}

/** The specifiers that reach a BUILT `lib/` tree — the repo's own `lib/` or a
 * workspace package's `packages/<pkg>/lib/`. */
function builtLibSpecifiersOf(file) {
  return [...importSpecifiersOf(file)].filter((s) => /(^|\/)lib\//.test(s))
}

/** The POSITIVE half of the name: the file reaches the SOURCE — a specifier
 * into a `src/` tree, or the `src/index.ts` bundle named in the file. */
function reachesSrc(file) {
  if ([...importSpecifiersOf(file)].some((s) => /(^|\/)src\//.test(s))) return true
  const src = readFileSync(path.join(REPO_ROOT, 'test', file), 'utf8')
  return /['"]src['"][^)]*?['"]index\.ts['"]/.test(src)
}

test('r6-ladder-flat (fb-95): the self-registering tests are lane-② src-native (their imports resolve into src, not the built lib)', (t) => {
  const testsDir = path.join(REPO_ROOT, 'test')
  const registerers = readdirSync(testsDir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => f !== 'r6-ladder-flat.test.js' && readFileSync(path.join(testsDir, f), 'utf8').includes("register(new URL('./ts-src-loader.mjs'"))
  assert.ok(registerers.length >= 4, 'the lane-② src-native family self-registers the hook (unexpectedly small set — the ladder convention drifted?)')

  // (1) THE CRITERION — the property, over the WHOLE radius (the per-file loop
  // this replaces failed on the FIRST offending file and hid the rest).
  const undeclaredBuiltLib = registerers
    .map((f) => ({ file: f, specifiers: builtLibSpecifiersOf(f) }))
    .filter((e) => e.specifiers.length > 0 && !LANE2_BUILT_LIB_EXCEPTIONS.has(e.file))
  assert.deepEqual(
    undeclaredBuiltLib.map((e) => e.file),
    [],
    `${undeclaredBuiltLib.length} self-registering file(s) import the BUILT lib and are NOT named in LANE2_BUILT_LIB_EXCEPTIONS — what the PROPERTY is = a lane-② src-native test's own imports resolve into src and NOT into the built lib (${registerers.length} file(s) self-register the hook TODAY); what the contract IS = either route the import to the source, or DECLARE the exception in LANE2_BUILT_LIB_EXCEPTIONS with the reason WHY that helper has to be the built one (the Map is the declaration site, the reason is part of it); what this RED does NOT mean = that the ladder convention drifted or that a file is defective because it is NEW — the criterion is the property, never the date of birth of a file (fb-1063/#1095: NO-FALLO of the product / DEFECT OF THE INSTRUMENT is now impossible here, because the baseline is not asserted); rows = ${undeclaredBuiltLib.map((e) => `${e.file} -> ${e.specifiers.join(' , ')}`).join(' | ')}`,
  )

  // (2) An exception must still EARN its place: it must self-register TODAY and
  // still take a built-lib specifier — a stale name is a dead declaration.
  const staleExceptions = [...LANE2_BUILT_LIB_EXCEPTIONS.keys()].filter(
    (f) => !registerers.includes(f) || builtLibSpecifiersOf(f).length === 0,
  )
  assert.deepEqual(
    staleExceptions,
    [],
    `${staleExceptions.length} name(s) in LANE2_BUILT_LIB_EXCEPTIONS no longer describe the tree (not a self-registering file, or it no longer imports the built lib) — remove the stale entry: an exception list that survives its object stops declaring anything. Rows: ${staleExceptions.join(', ')}`,
  )

  // (3) Every exception DECLARES ITS REASON (naming a file is not declaring).
  const reasonless = [...LANE2_BUILT_LIB_EXCEPTIONS.entries()].filter(
    ([, reason]) => typeof reason !== 'string' || reason.trim().length < 40,
  )
  assert.deepEqual(
    reasonless.map(([f]) => f),
    [],
    `${reasonless.length} exception(s) carry no usable reason — each entry of LANE2_BUILT_LIB_EXCEPTIONS must say WHY its helper is taken from the built artifact (not merely list the filename). Rows: ${reasonless.map(([f]) => f).join(', ')}`,
  )

  // (4) THE POSITIVE HALF of the name: the hook must have an object in src.
  const noSrcSeam = registerers.filter((f) => !reachesSrc(f))
  assert.deepEqual(
    noSrcSeam,
    [],
    `${noSrcSeam.length} self-registering file(s) reach NOTHING in src (no specifier into a src/ tree and no src/index.ts bundle named in the file) — self-registering the hook is only meaningful for a test whose object under test comes from the SOURCE. Rows: ${noSrcSeam.join(', ')}`,
  )

  // (5) THE BASELINE — declared and REPORTED, never the criterion (this is a
  // diagnostic of the run, not an assertion: see the header of this block).
  const notInBaseline = registerers.filter((f) => !LANE2_SRC_NATIVE_BASELINE.has(f) && !LANE2_BUILT_LIB_EXCEPTIONS.has(f))
  t.diagnostic(
    `r6-ladder-flat baseline (declared ${LANE2_SRC_NATIVE_BASELINE_AT}, ${LANE2_SRC_NATIVE_BASELINE.size} src-native entries): ${registerers.length} self-registering file(s) TODAY; ${notInBaseline.length} newer than the baseline — REPORTED, not a failure (the criterion is the property checked above): ${notInBaseline.join(', ') || '-'}`,
  )
})