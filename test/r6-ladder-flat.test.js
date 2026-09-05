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
  ])
  for (const f of registerers) {
    assert.ok(laneFamily.has(f), `unexpected self-registerer ${f} — only the lane-②/src-native family may self-register the hook`)
  }
})