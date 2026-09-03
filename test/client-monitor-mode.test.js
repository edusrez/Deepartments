// dsh-deepartments — GUI monitor mode: the composer is hidden GLOBALLY while
// the owner is ABSENT (presence.json present:false) and shown again when
// PRESENT (owner decision, job docs/departments/internal-programming/jobs/
// gui-monitor-mode.md).
//
// The monitor mode lives in packages/dshd-gui/src/client/index.tsx (the
// existing deepartments-client), which compiles ONLY through the browser
// bundle pipeline (dshd-gui's own `pnpm --filter dshd-gui run build:client`:
// package tsdown → packages/dshd-gui/client/client.js, wrapped in the
// `window.__ModuleLoader__.load` envelope by scripts/normalize-client-banner.mjs,
// then mirrored byte-identical to the root ./client/client.js by
// scripts/mirror-client.mjs) — same pattern as test/client-watcher.test.js.
// This test evaluates the REAL compiled envelope (client/client.js; regenerate
// with `pnpm build:client` after touching the client source) with a stubbed
// loader, unit-tests the pure rule (`shouldApplyMonitorMode`) and drives the
// REAL apply()/presence-poll pipeline with a mocked rpc. The vm sandbox
// document provides the DOM surface the bundle consumes — head.appendChild/
// removeChild and body.classList — the TEST defines the sandbox, not the
// bundle. No browser, no test framework beyond node:test.
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BUNDLE_PATH = fileURLToPath(new URL('../client/client.js', import.meta.url))

/** Let a poll's promise chain (rpc call → class toggle) settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Minimal DOMTokenList facade over a Set: add/remove/contains + the
 * force-form of toggle the bundle's applyMonitorPresence() calls. */
function makeClassList() {
  const classes = new Set()
  return {
    classes,
    add: (c) => { classes.add(c) },
    remove: (c) => { classes.delete(c) },
    contains: (c) => classes.has(c),
    toggle: (c, force) => {
      if (force === undefined) {
        if (classes.has(c)) { classes.delete(c); return false }
        classes.add(c)
        return true
      }
      if (force) classes.add(c)
      else classes.delete(c)
      return force
    }
  }
}

/** Evaluate the normalized client bundle once and return its exports plus the
 * sandbox surfaces the flow tests drive (captured window listeners, injected
 * <style> children, the <body> classList). Each call builds a FRESH sandbox. */
function loadClientBundle() {
  const code = readFileSync(BUNDLE_PATH, 'utf8')
  let loaded = null
  const listeners = {}
  const headChildren = []
  const classList = makeClassList()
  // The sandbox document the bundle consumes: visibility for the poll gating,
  // addEventListener/removeEventListener no-ops, createElement for the injected
  // <style>, head.appendChild/removeChild and body.classList for the toggle.
  const document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: (tag) => ({ tagName: tag, id: '', textContent: '', parentNode: null }),
    head: {
      appendChild: (el) => { el.parentNode = document.head; headChildren.push(el) },
      removeChild: (el) => {
        const index = headChildren.indexOf(el)
        if (index >= 0) headChildren.splice(index, 1)
      }
    },
    body: { classList }
  }
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (opts) => { loaded = opts } },
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: (event, fn) => { listeners[event] = fn },
      removeEventListener: () => {}
    },
    document,
    console
  }
  runInContext(code, createContext(sandbox))
  assert.ok(loaded, 'client bundle did not call window.__ModuleLoader__.load')
  // The client bundle imports nothing at factory scope; a require inside the
  // factory would be a build-time externals drift and must fail loudly.
  const exports = loaded.factory(() => {
    throw new Error('client bundle unexpectedly requires a module')
  })
  assert.equal(typeof exports.shouldApplyMonitorMode, 'function')
  return { exports, listeners, headChildren, classList, document }
}

/** Mock root ctx for apply(): collects effect fns by label and serves a
 * presence/get rpc over the mutable `present` cell (the poll reads it). */
function mockCtx(presentRef) {
  const effectFns = []
  const ctx = {
    effect: (fn, label) => { effectFns.push({ fn, label }) },
    // The W4 client UI (presence toggle + agenda view) injects into `locale`
    // and `slots`; the flow tests never render the components, so minimal
    // no-op inject faces are enough.
    locale: {
      register: () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, register) => register(),
      register: () => {},
    },
    sessions: {
      list: { getSnapshot: () => ({ ids: [] }) },
      open: () => {},
      refresh: async () => {},
    },
    connection: {
      rpc: {
        call: async (_channel, endpoint) =>
          endpoint === 'presence/get'
            ? { ok: true, value: { present: presentRef.value } }
            : { ok: false, error: 'unexpected endpoint ' + endpoint }
      }
    }
  }
  const byLabel = (sub) => effectFns.find((e) => (e.label || '').includes(sub))
  return { ctx, byLabel }
}

test('monitor mode: shouldApplyMonitorMode decision matrix (pure)', () => {
  const { exports } = loadClientBundle()
  // present → visible: the monitor body class does NOT apply.
  assert.equal(exports.shouldApplyMonitorMode(true), false)
  // absent → hidden: the monitor body class applies.
  assert.equal(exports.shouldApplyMonitorMode(false), true)
})

test('monitor mode: exported constants carry the exact DOM/CSS contract', () => {
  const { exports } = loadClientBundle()
  assert.equal(exports.MONITOR_BODY_CLASS, 'dsw-deepartments-monitor')
  assert.equal(exports.MONITOR_STYLE_ID, 'dsw-deepartments-monitor-style')
  assert.equal(
    exports.MONITOR_CSS,
    '.dsw-deepartments-monitor [data-composer-seat] { display: none !important; }'
  )
})

test('monitor mode: absent hides the composer (body class added), present shows it (removed)', async () => {
  const { exports, listeners, headChildren, classList } = loadClientBundle()
  const present = { value: false } // mutable server presence the poll reads
  const { ctx, byLabel } = mockCtx(present)
  exports.apply(ctx)
  const styleEffect = byLabel('monitor-mode style')
  const pollEffect = byLabel('presence monitor poll')
  assert.ok(styleEffect, 'apply() registered the monitor style effect')
  assert.ok(pollEffect, 'apply() registered the presence monitor poll effect')

  const styleCleanup = styleEffect.fn()
  const pollCleanup = pollEffect.fn()
  await flush() // seed poll: presence/get → present:false → class ADDED

  // The <style> is injected once with the exact rule.
  assert.equal(headChildren.length, 1, 'exactly one <style> injected')
  assert.equal(headChildren[0].id, exports.MONITOR_STYLE_ID)
  assert.equal(headChildren[0].textContent, exports.MONITOR_CSS)
  // Absent → the monitor body class is set → [data-composer-seat] display:none.
  assert.equal(classList.contains(exports.MONITOR_BODY_CLASS), true, 'absent → composer hidden')

  // Another tab flips to PRESENT; this tab converges on the next focused poll.
  present.value = true
  listeners.focus()
  await flush()
  assert.equal(classList.contains(exports.MONITOR_BODY_CLASS), false, 'present → composer visible')

  // And back to absent on the following poll.
  present.value = false
  listeners.focus()
  await flush()
  assert.equal(classList.contains(exports.MONITOR_BODY_CLASS), true, 'absent again → composer hidden')

  // Cleanup: the poll is torn down and the injected <style> removed.
  pollCleanup()
  styleCleanup()
  assert.equal(headChildren.length, 0, 'cleanup removed the injected <style>')
})

test('monitor mode: presence poll is focus/visibility gated (hidden tab does not poll)', async () => {
  const { exports, listeners, classList, document } = loadClientBundle()
  let rpcCalls = 0
  const present = { value: false }
  const effectFns = []
  const ctx = {
    effect: (fn, label) => { effectFns.push({ fn, label }) },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: { inject: () => {}, register: () => {} },
    sessions: {
      list: { getSnapshot: () => ({ ids: [] }) },
      open: () => {},
      refresh: async () => {},
    },
    connection: {
      rpc: {
        call: async (_channel, endpoint) => {
          rpcCalls += 1
          return endpoint === 'presence/get'
            ? { ok: true, value: { present: present.value } }
            : { ok: false, error: 'unexpected endpoint ' + endpoint }
        }
      }
    }
  }
  exports.apply(ctx)
  const pollEffect = effectFns.find((e) => (e.label || '').includes('presence monitor poll'))
  assert.ok(pollEffect, 'apply() registered the presence monitor poll effect')

  // The tab is HIDDEN while the poll effect seeds: no RPC, no class toggle.
  document.visibilityState = 'hidden'
  const pollCleanup = pollEffect.fn()
  await flush()
  assert.equal(rpcCalls, 0, 'hidden tab must not poll presence')
  assert.equal(classList.contains(exports.MONITOR_BODY_CLASS), false)

  // Tab becomes visible again → the next focus poll applies the absent state.
  document.visibilityState = 'visible'
  listeners.focus()
  await flush()
  assert.equal(rpcCalls, 1)
  assert.equal(classList.contains(exports.MONITOR_BODY_CLASS), true)
  pollCleanup()
})

test('monitor mode: bundle surface stays the canonical module face', () => {
  const { exports } = loadClientBundle()
  assert.equal(exports.name, 'deepartments-client')
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
})
