// dsh-deepartments — dispose-clean LOCK test (LANE 0.2.1, gap 1 — the binder →
// Service disposability/reversibility work, P6). TDD: RED over HEAD (the bundle
// unmount leaves the binder holding the apply-muerto closures + the lazy shells
// keep caching them), GREEN after the 1A/1B fixes (clear-on-unload + epoch
// invalidation + the per-package deps holders).
//
// Pattern (explore-deep design §3): the smokeBoot composition of
// smoke-boot.test.js:68-96 (real Loader, dev-profile row order: the dsh service
// rows + dshd-core + the 6 P1 packages + the bundle, temp stateDir, stub
// webServer/webRuntime/connection) + the setInterval/clearInterval capture of
// smoke-boot.test.js:220-270. The flow: MOUNT → HYDRATE (drive the captured
// agenda + health daemon ticks, a gui.dispatch, and the lazy business shells so
// every service CACHE exists before the dispose) → SNAPSHOT (root.events._hooks,
// the stateDir file inventory) → `await dispose()` (loaderFiber.dispose — the
// ordered health DRAIN resolves only with the in-flight tick closed) → ASSERT
// QUIESCENCE:
//   - 0 timers: every captured setInterval handle was clearInterval'ed,
//   - 0 residual listeners: no root.events._hooks entry carries the bundle ctx,
//   - 0 reachable services: binder.get() is empty; the captured shell/zone
//     service accesses FAIL LOUD (R1) — never stale closure execution,
//   - 0 post-dispose activity: driving the captured daemon ticks writes nothing
//     to the stateDir (byte-stable inventory) and the teardown rm() succeeds
//     without ENOTEMPTY (the W6 flake class the ordered drain closes).
//
// NOTE on post-dispose reachability: after loaderFiber.dispose(), `ctx.get`
// returns undefined (verified empirically against HEAD) — the assertions hold
// CAPTURED references (the binder object, the lazy shell wrappers, the zone
// service objects) taken before the dispose, exactly like a stale consumer that
// resolved them pre-unmount.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** Stub webServer: records the exact routes the bundle's RPC mount registers
 * (the /deepartments/* channel) — a real webServer-like `register` returns a
 * disposer. */
class StubWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = []
  }
  register(route) {
    this.routes.push(route)
    return () => {}
  }
}

/** Stub webRuntime: carries the deployment's trustedHosts (empty here →
 * the channel trusts loopback only). */
class StubWebRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'webRuntime')
    this.trustedHosts = []
  }
}

/** Stub connection (dsh-client-connection's HostConnectionService shape). */
class StubConnection extends Service {
  constructor(ctx) {
    super(ctx, 'connection')
    this.trustedHosts = []
  }
}

/** bootPlugin MINIMAL (the smoke-boot.test.js:68-96 pattern): the REAL Loader
 * composes the REAL dsh service rows + dshd-core + the 6 P1 packages + the
 * bundle in the dev-profile order, with agents/sessions/persistence-style STUB
 * services + stub webServer/webRuntime/connection so the RPC mount runs. The
 * interval capture is installed BEFORE `await loader.await()` so the daemon
 * effect registrations are observed. */
async function disposeBoot(stateDir) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  new StubWebServer(root)
  new StubWebRuntime(root)
  new StubConnection(root)
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org: { departments: [] } } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org: { departments: [] } } })
  const setCalls = []
  const clearCalls = []
  const origSet = global.setInterval
  const origClear = global.clearInterval
  global.setInterval = (fn, delay, ...args) => { const handle = { fn, delay, args }; setCalls.push(handle); return handle }
  global.clearInterval = (handle) => { clearCalls.push(handle) }
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return {
    root,
    loader,
    pluginCtx,
    setCalls,
    clearCalls,
    dispose: async () => {
      try {
        await loaderFiber.dispose()
      } finally {
        global.setInterval = origSet
        global.clearInterval = origClear
      }
    },
    disposeRaw: () => Promise.resolve(loaderFiber.dispose()),
    restoreGlobals: () => {
      global.setInterval = origSet
      global.clearInterval = origClear
    },
    rmStateDir: (dir) => rm(dir, { recursive: true, force: true })
  }
}

/** The drain-settle helper (smoke-boot.test.js:244-245 pattern): two macrotask
 * hops (immediates) + a small timeout so a fire-and-forget daemon tick that
 * already STARTED finishes its (file-only) work before a snapshot/assert. */
function settle() {
  return new Promise((resolve) => {
    setImmediate(() => setImmediate(() => setTimeout(resolve, 60)))
  })
}

/** Snapshot the stateDir: relative path → `${size}:${mtimeMs}` for every FILE
 * (dirs excluded) — the byte-stability oracle for the quiescence assert. */
async function snapshotStateDir(stateDir) {
  const out = {}
  const rels = await readdir(stateDir, { recursive: true })
  for (const rel of rels) {
    const p = path.join(stateDir, rel)
    const s = await stat(p)
    if (s.isFile()) out[rel] = `${s.size}:${Math.trunc(s.mtimeMs)}`
  }
  return out
}

/** The bundle ctx + the key service references, captured PRE-dispose. */
function captureBundleReferences(boot) {
  const pluginCtx = boot.pluginCtx()
  return {
    pluginCtx,
    binder: pluginCtx.get('deepartments.binder'),
    lifecycle: pluginCtx.get('deepartments.lifecycle'),
    wakepack: pluginCtx.get('deepartments.wakepack'),
    bus: pluginCtx.get('deepartments.bus'),
    deliver: pluginCtx.get('deepartments.deliver'),
    jobs: pluginCtx.get('deepartments.jobs'),
    health: pluginCtx.get('deepartments.health'),
    gui: pluginCtx.get('deepartments.gui')
  }
}

/** HYDRATE: build every service cache the dispose must invalidate — the lazy
 * dshd-core shells (lifecycle/wakepack/deliver getters + the bus store), a
 * captured agenda + health daemon tick, a gui.dispatch + a jobs scheduler tick.
 * Returns the captured tick closures to drive post-dispose. */
async function hydrate(boot, refs) {
  const setCalls = boot.setCalls
  const agenda = setCalls.find((c) => c.delay === 30000)
  const health = setCalls.find((c) => c.delay === 60000)
  assert.ok(agenda !== undefined, 'the agenda scheduler daemon registered setInterval(30000)')
  assert.ok(health !== undefined, 'the system-health daemon registered setInterval(60000)')
  // The lazy shells: a getter access builds the real service (binder-closure
  // capture); the bus store await opens the message store.
  void refs.lifecycle.memoWrite
  void refs.wakepack.assembleWakePack
  void refs.deliver.deliverOrQueue
  await refs.bus.storeReady
  // The zone services + one captured tick of each daemon (E2 — the filled
  // buckets are consumed without fail-loud at hydration time).
  await refs.jobs.runSchedulerTick({ now: () => Date.now() })
  await refs.health.runDaemonTick({ now: () => Date.now(), hosts: [], posts: [], hostWaits: [], sessionContexts: [], hostRunning: false })
  const dispatch = await refs.gui.dispatch('agents', { sessionId: 'host-x' })
  assert.equal(dispatch.ok, true, 'gui dispatch ok at hydration (builder + cache live)')
  agenda.fn()
  health.fn()
  await settle()
  return { agenda, health }
}

test('dispose-clean: binder buckets cleared on unload (1A clear-on-unload — post-dispose binder.get() is empty and the cached shells fail loud R1)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-dispose-'))
  try {
    const boot = await disposeBoot(stateDir)
    try {
      const refs = captureBundleReferences(boot)
      assert.ok(refs.binder !== undefined, 'deepartments.binder resolves')
      // Pre-dispose sanity: the register ran (the baseline bus bucket filled).
      assert.ok(refs.binder.get().bus !== undefined, 'pre-dispose: the bundle registered the bus bucket (sanity)')
      await hydrate(boot, refs)
      const preKeys = Object.keys(refs.binder.get()).sort()
      assert.ok(preKeys.includes('bus') && preKeys.includes('health'), 'pre-dispose: the 9 buckets present (sanity)')
      // The unload: the bundle's clear-on-unload effect releases the buckets.
      await boot.dispose()
      const post = refs.binder.get()
      assert.deepEqual(Object.keys(post), [], 'binder.get() is EMPTY after the bundle unload (clear-on-unload)')
      for (const bucket of ['bus', 'deliver', 'wakepack', 'lifecycle', 'redeliver', 'gui', 'jobs', 'health', 'pooler']) {
        assert.equal(post[bucket], undefined, `bucket "${bucket}" is undefined post-dispose`)
      }
      // The CACHED shells: the first post-dispose access REBUILDS (epoch
      // invalidated) and FAILS LOUD (R1) — never stale closure execution.
      assert.throws(() => { void refs.lifecycle.memoWrite }, /lazy build|missing|is undefined/, 'lifecycle post-dispose access fails loud (the rebuild reads the emptied binder)')
      assert.throws(() => { void refs.wakepack.assembleWakePack }, /lazy build|missing|is undefined/, 'wakepack post-dispose access fails loud')
      assert.throws(() => { void refs.deliver.deliverOrQueue }, /lazy build|missing|is undefined/, 'deliver post-dispose access fails loud')
    } finally {
      await boot.disposeRaw().catch(() => {})
      boot.restoreGlobals()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('dispose-clean: built lifecycle/wakepack service caches invalidated by the binder epoch (manual clear → the EXACT R1 message, no dispose needed)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-dispose-'))
  try {
    const boot = await disposeBoot(stateDir)
    try {
      const refs = captureBundleReferences(boot)
      await hydrate(boot, refs)
      // Isolate the EPOCH mechanism from the dead-ctx noise of a full dispose:
      // a manual `binder.clear()` is exactly what the unload effect runs — the
      // ctx is STILL ALIVE, so the rebuild reaches the required-deps check.
      refs.binder.clear()
      assert.throws(() => { void refs.lifecycle.memoWrite }, /required bucket-\(c\) dep\(s\) missing from binder\.get\(\)\.lifecycle/, 'lifecycle rebuild after clear fails loud with the EXACT R1 message')
      assert.throws(() => { void refs.wakepack.assembleWakePack }, /required bucket-\(c\) dep\(s\) missing from binder\.get\(\)\.wakepack/, 'wakepack rebuild after clear fails loud with the EXACT R1 message')
      assert.throws(() => { void refs.deliver.deliverOrQueue }, /required bucket-\(c\) dep\(s\) missing from binder\.get\(\)\.deliver/, 'deliver rebuild after clear fails loud with the EXACT R1 message')
      assert.throws(() => refs.bus.redeliver(), /required bucket-\(c\) dep\(s\) missing/, 'bus.redeliver after clear fails loud (the driver rebuilds from the emptied binder)')
      // And the access NEVER returns a stale closure: re-accessing stays a fail.
      assert.throws(() => { void refs.lifecycle.memoWrite }, /required bucket-\(c\) dep\(s\) missing/, 'a SECOND lifecycle access still fails loud (no stale cache re-population)')
    } finally {
      await boot.disposeRaw().catch(() => {})
      boot.restoreGlobals()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('dispose-clean: daemon intervals drained + cleared (0 live timers after dispose)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-dispose-'))
  try {
    const boot = await disposeBoot(stateDir)
    try {
      const refs = captureBundleReferences(boot)
      const { agenda, health } = await hydrate(boot, refs)
      assert.ok(boot.setCalls.length >= 2, `>=2 daemon intervals captured (got ${boot.setCalls.length})`)
      await boot.dispose()
      // EVERY captured handle must be cleared by the reversible effects — the
      // P6 zero-timers guarantee (an uncleared interval would fire post-dispose).
      for (const handle of boot.setCalls) {
        assert.ok(boot.clearCalls.includes(handle), `captured setInterval(handle@${handle.delay}ms) was clearInterval-ed on dispose`)
      }
      assert.ok(boot.clearCalls.includes(agenda), 'the agenda handle cleared')
      assert.ok(boot.clearCalls.includes(health), 'the health handle cleared')
    } finally {
      await boot.disposeRaw().catch(() => {})
      boot.restoreGlobals()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('dispose-clean: zone services fail loud post-dispose (jobs/health/gui — never stale execution of bundle closures)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-dispose-'))
  try {
    const boot = await disposeBoot(stateDir)
    try {
      const refs = captureBundleReferences(boot)
      assert.ok(refs.jobs !== undefined && typeof refs.jobs.runSchedulerTick === 'function', 'deepartments.jobs resolvable')
      assert.ok(refs.health !== undefined && typeof refs.health.runDaemonTick === 'function', 'deepartments.health resolvable')
      assert.ok(refs.gui !== undefined && typeof refs.gui.dispatch === 'function', 'deepartments.gui resolvable')
      // Hydrate: the gui service CACHE is built (the first dispatch) — the
      // residue-3 scenario a post-dispose dispatch must NOT serve from.
      await refs.jobs.runSchedulerTick({ now: () => Date.now() })
      await refs.health.runDaemonTick({ now: () => Date.now(), hosts: [], posts: [], hostWaits: [], sessionContexts: [], hostRunning: false })
      const pre = await refs.gui.dispatch('agents', { sessionId: 'host-x' })
      assert.equal(pre.ok, true, 'gui dispatch ok pre-dispose (the cache is live)')
      await boot.dispose()
      // Post-dispose: EVERY zone service access must FAIL LOUD (reject), never
      // answer with stale closures from the unmounted bundle. (The gui surface
      // wrapper is a SYNC arrow over the lazy build — a sync throw, so the
      // rejects thunk is async; the async service methods reject natively.)
      await assert.rejects(
        async () => refs.jobs.runSchedulerTick({ now: () => Date.now() }),
        /jobs scheduler tick|missing|is undefined/,
        'jobs.runSchedulerTick rejects post-dispose (fail loud, no stale scheduler run)'
      )
      await assert.rejects(
        async () => refs.health.runDaemonTick({ now: () => Date.now(), hosts: [], posts: [], hostWaits: [], sessionContexts: [], hostRunning: false }),
        /health daemon tick|missing|is undefined/,
        'health.runDaemonTick rejects post-dispose (no stale heartbeat/scan execution)'
      )
      await assert.rejects(
        async () => refs.gui.dispatch('agents', { sessionId: 'host-x' }),
        /gui lazy build|no endpointDeps|missing|is undefined/,
        'gui.dispatch rejects post-dispose (the cached surface is invalidated — never a stale roster answer)'
      )
    } finally {
      await boot.disposeRaw().catch(() => {})
      boot.restoreGlobals()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('dispose-clean: 0 residual event listeners with the bundle ctx after dispose', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-dispose-'))
  try {
    const boot = await disposeBoot(stateDir)
    try {
      const refs = captureBundleReferences(boot)
      await hydrate(boot, refs)
      const bundleCtx = refs.pluginCtx
      // Pre-dispose: the bundle IS present (its ctx object exists).
      assert.ok(bundleCtx !== undefined, 'the bundle plugin ctx resolves')
      await boot.dispose()
      // Every root event hook whose owning ctx is the bundle's plugin ctx must
      // be GONE (cordis disposes listeners with their fiber): the bundle left
      // 0 global listeners behind — no orphaned on(...)/watchers.
      let withBundleCtx = 0
      let total = 0
      for (const key of Object.keys(boot.root.events._hooks)) {
        const hooks = boot.root.events._hooks[key]
        if (!Array.isArray(hooks)) continue
        total += hooks.length
        for (const hook of hooks) {
          if (hook !== null && typeof hook === 'object' && hook.ctx === bundleCtx) withBundleCtx++
        }
      }
      assert.equal(withBundleCtx, 0, `0 residual event listeners carry the bundle ctx (total hooks left: ${total})`)
    } finally {
      await boot.disposeRaw().catch(() => {})
      boot.restoreGlobals()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('dispose-clean: stateDir quiescent after dispose (captured ticks write no heartbeat/deliveries; teardown rm() has no ENOTEMPTY)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-dispose-'))
  try {
    const boot = await disposeBoot(stateDir)
    try {
      const refs = captureBundleReferences(boot)
      await hydrate(boot, refs)
      // The hydration ticks (pre-dispose) WROTE the heartbeat — the snapshot
      // then is the post-hydration byte baseline.
      const before = await snapshotStateDir(stateDir)
      assert.ok('health-heartbeat.json' in before, 'the hydration health tick wrote health-heartbeat.json (baseline present)')
      await boot.dispose()
      // Drive the CAPTURED tick PAYLOADS post-dispose (the raw daemon closures
      // VOID their call — an expected post-dispose rejection the test runner
      // flags; the payload is the SAME service calls, driven here with an
      // explicit catch to prove their fail-loud refusal): the daemons are
      // stopped (intervals cleared) but a stale fire would STILL write —
      // quiescence = the stateDir bytes stay identical to the pre-dispose
      // baseline.
      await Promise.resolve(refs.jobs.runSchedulerTick({ now: () => Date.now() })).catch(() => {})
      await Promise.resolve(refs.health.runDaemonTick({ now: () => Date.now(), hosts: [], posts: [], hostWaits: [], sessionContexts: [], hostRunning: false })).catch(() => {})
      await settle()
      const after = await snapshotStateDir(stateDir)
      assert.deepEqual(after, before, 'stateDir byte-stable after dispose: NO heartbeat/delivery/staterow writes from post-dispose ticks')
      const rmOk = await boot.rmStateDir(stateDir).then(() => true, () => false)
      assert.equal(rmOk, true, 'teardown rm(stateDir, recursive) succeeds WITHOUT ENOTEMPTY (the ordered drain + quiescence close the W6 flake class)')
    } finally {
      await boot.disposeRaw().catch(() => {})
      boot.restoreGlobals()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})