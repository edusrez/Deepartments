// dsh-deepartments — client lifecycle watcher decision logic (U3, spec 002 §6).
//
// The watcher lives in src/client/index.tsx, which compiles ONLY through the
// browser bundle pipeline (tsdown → client/client.js, wrapped in the
// `window.__ModuleLoader__.load` envelope by scripts/normalize-client-banner.mjs)
// — it is not part of the server lib/ the other suites import. This test
// evaluates the REAL compiled envelope (client/client.js; regenerate with
// `pnpm build:client` after touching src/client) with a stubbed loader and
// reaches the exported `shouldOpenHostSession` pure decision function — no
// browser, no test framework beyond node:test.
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BUNDLE_PATH = fileURLToPath(new URL('../client/client.js', import.meta.url))

/** Evaluate the normalized client bundle and return its module exports. */
function loadClientBundle() {
  const code = readFileSync(BUNDLE_PATH, 'utf8')
  let loaded = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (opts) => { loaded = opts } } },
    console
  }
  runInContext(code, createContext(sandbox))
  assert.ok(loaded, 'client bundle did not call window.__ModuleLoader__.load')
  // The watcher bundle imports nothing; a require inside the factory would be
  // a build-time externals drift and must fail the test loudly.
  const exports = loaded.factory(() => {
    throw new Error('client bundle unexpectedly requires a module')
  })
  assert.equal(typeof exports.shouldOpenHostSession, 'function')
  return exports
}

test('client watcher: shouldOpenHostSession decision matrix', () => {
  const { shouldOpenHostSession } = loadClientBundle()
  // null→null — nothing registered, never open.
  assert.equal(shouldOpenHostSession(null, null), false)
  // null→id — FIRST observation SEEDS the baseline WITHOUT opening (the boot
  // may already be inside the host session; never steal the active tab).
  assert.equal(shouldOpenHostSession(null, 'sess-a'), false)
  // id→same id — no-op (idempotency: never re-open in a loop).
  assert.equal(shouldOpenHostSession('sess-a', 'sess-a'), false)
  // id→NEW id — rotation happened (old retired + new created server-side) → OPEN.
  assert.equal(shouldOpenHostSession('sess-a', 'sess-b'), true)
  // id→null — host unregistered; keep the baseline, never open.
  assert.equal(shouldOpenHostSession('sess-a', null), false)
})

test('client watcher: bundle surface stays the canonical module face', () => {
  const mod = loadClientBundle()
  assert.equal(mod.name, 'deepartments-client')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
})