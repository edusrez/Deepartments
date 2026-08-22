// dsh-deepartments — client lifecycle watcher decision logic (U3, spec 002 §6).
//
// The watcher lives in src/client/index.tsx, which compiles ONLY through the
// browser bundle pipeline (tsdown → client/client.js, wrapped in the
// `window.__ModuleLoader__.load` envelope by scripts/normalize-client-banner.mjs)
// — it is not part of the server lib/ the other suites import. This test
// evaluates the REAL compiled envelope (client/client.js; regenerate with
// `pnpm build:client` after touching src/client) with a stubbed loader,
// reaches the exported pure decision functions (`shouldOpenHostSession`,
// `shouldRefreshForHost`) and drives the real `apply`/poll pipeline with a
// mocked ctx for the rotation open flow — no browser, no test framework
// beyond node:test.
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BUNDLE_PATH = fileURLToPath(new URL('../client/client.js', import.meta.url))

/** The vm sandbox window of the MOST RECENT loadClientBundle() call.
 *
 * apply()'s closure resolves `window`/`document` in the vm sandbox global —
 * NOT in node's globalThis — so the flow tests fire the poll through the
 * listeners captured on this object (module-level, latest-load pairing: each
 * test loads the bundle exactly once and reads this immediately after). */
let sandboxWindow = null

/** Evaluate the normalized client bundle and return its module exports. */
function loadClientBundle() {
  const code = readFileSync(BUNDLE_PATH, 'utf8')
  let loaded = null
  // Browser surface apply()'s effect touches (5s timer + focus/visibility
  // listeners). The real cadence never fires: setInterval is inert and the
  // focus handler is captured so a test can trigger a poll on demand. There is
  // no `document` guard around document.addEventListener in the effect, so the
  // sandbox MUST provide it.
  const listeners = {}
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (opts) => { loaded = opts } },
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: (event, fn) => { listeners[event] = fn },
      removeEventListener: () => {}
    },
    document: {
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {}
    },
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
  assert.equal(typeof exports.shouldRefreshForHost, 'function')
  sandboxWindow = { listeners, window: sandbox.window, document: sandbox.document }
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

test('client watcher: shouldRefreshForHost decision matrix', () => {
  const { shouldRefreshForHost } = loadClientBundle()
  // No rotation transition → never force a refresh (seed / same-id / unregistered).
  assert.equal(shouldRefreshForHost(null, 'sess-a', false), false)
  assert.equal(shouldRefreshForHost('sess-a', 'sess-a', false), false)
  assert.equal(shouldRefreshForHost('sess-a', null, false), false)
  // Rotation + the new host is ALREADY in the store → open directly, no refresh.
  assert.equal(shouldRefreshForHost('sess-a', 'sess-b', true), false)
  // Rotation + ABSENT from the store → the COLD rotated session needs the
  // forced api.sessions.list pull (no session-added frame will ever reveal it).
  assert.equal(shouldRefreshForHost('sess-a', 'sess-b', false), true)
})

// ---------------------------------------------------------------------------
// Rotation open-flow tests: drive the REAL apply()/poll() pipeline with a
// mocked root ctx. Polls are triggered through the sandbox window's captured
// focus listener (the source 5s cadence + visibility gating are untouched).
// ---------------------------------------------------------------------------

/** Let the poll's promise chain (rpc call + refresh) settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Mock root ctx: rpc reports `firstHost` on the seeding poll and `nextHost`
 * thereafter; `storeIds` is the mutable local session-store snapshot (the
 * refresh mock may reveal the rotated host by mutating it). */
function mockCtx({ firstHost, nextHost, storeIds, onRefresh }) {
  const openCalls = []
  const refreshCalls = []
  let rpcCalls = 0
  let effectFn = null
  const ctx = {
    effect: (fn) => { effectFn = fn },
    sessions: {
      list: { getSnapshot: () => ({ ids: storeIds }) },
      open: (id) => { openCalls.push(id) },
      refresh: async () => {
        refreshCalls.push('refresh')
        onRefresh?.()
      }
    },
    connection: {
      rpc: {
        call: async () => {
          rpcCalls += 1
          return {
            ok: true,
            value: { hostSessionId: rpcCalls === 1 ? firstHost : nextHost }
          }
        }
      }
    }
  }
  return { ctx, openCalls, refreshCalls, getEffectFn: () => effectFn }
}

test('client watcher: rotated host absent → refresh → present → open', async () => {
  const { apply } = loadClientBundle()
  const storeIds = ['old-host'] // rotated host NOT in the local store yet
  const { ctx, openCalls, refreshCalls, getEffectFn } = mockCtx({
    firstHost: 'old-host',
    nextHost: 'new-host',
    storeIds,
    // The api.sessions.list pull finally reveals the rotated host.
    onRefresh: () => { storeIds.push('new-host') }
  })
  apply(ctx)
  const cleanup = getEffectFn()()
  await flush() // poll #1: seeds the baseline 'old-host' — no refresh, no open
  assert.deepEqual(openCalls, [])
  assert.deepEqual(refreshCalls, [])
  sandboxWindow.listeners.focus() // poll #2: rotation seen → absent → refresh → open
  await flush()
  assert.deepEqual(refreshCalls, ['refresh'])
  assert.deepEqual(openCalls, ['new-host'])
  cleanup()
})

test('client watcher: rotated host already present → open directly, no refresh', async () => {
  const { apply } = loadClientBundle()
  const storeIds = ['old-host', 'new-host'] // store already knows the rotated host
  const { ctx, openCalls, refreshCalls, getEffectFn } = mockCtx({
    firstHost: 'old-host',
    nextHost: 'new-host',
    storeIds
  })
  apply(ctx)
  const cleanup = getEffectFn()()
  await flush() // poll #1: seeds the baseline 'old-host'
  sandboxWindow.listeners.focus() // poll #2: rotation seen → present → open, NO refresh
  await flush()
  assert.deepEqual(refreshCalls, [])
  assert.deepEqual(openCalls, ['new-host'])
  cleanup()
})

test('client watcher: host still absent after refresh → warn + re-poll, no open', async () => {
  const { apply } = loadClientBundle()
  const originalWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args)
  try {
    const storeIds = ['old-host'] // the refresh never reveals the rotated host
    const { ctx, openCalls, refreshCalls, getEffectFn } = mockCtx({
      firstHost: 'old-host',
      nextHost: 'new-host',
      storeIds
    })
    apply(ctx)
    const cleanup = getEffectFn()()
    await flush() // poll #1: seeds the baseline 'old-host'
    sandboxWindow.listeners.focus() // poll #2: rotation, absent → refresh → still absent → warn
    await flush()
    assert.deepEqual(openCalls, [])
    assert.equal(refreshCalls.length, 1)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0][0], /not in the local session store/)
    sandboxWindow.listeners.focus() // next poll re-attempts the refresh (baseline kept)
    await flush()
    assert.equal(refreshCalls.length, 2)
    assert.deepEqual(openCalls, [])
    cleanup()
  } finally {
    console.warn = originalWarn
  }
})

test('client watcher: bundle surface stays the canonical module face', () => {
  const mod = loadClientBundle()
  assert.equal(mod.name, 'deepartments-client')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
})