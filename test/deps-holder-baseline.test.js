// dsh-deepartments — deps-holder-baseline test (LANE DI-BY-SERVICES, FASE 1+2 —
// the DECISION (c) of the approved plan: the 4 BASELINE deps holders are the
// DI seam that REPLACED the late-binding binder (MutableBinder /
// deepartments.binder — DEAD). Locks the seam's CONTRACT at three levels:
//   - the holder object itself: register/get/clear/getEpoch (the createDepsHolder
//     pattern 1B of LANE 0.2.1 — the SAME contract the zone holders use),
//   - the COMPOSED boot: the 4 baseline holders resolve + are FILLED by the
//     bundle (the closure sets the register used to carry), and the lazy
//     dshd-core shells BUILD THROUGH them (holder-first — the F2 holder-only
//     read; a lifecycle.memoWrite / wakepack.assembleWakePack / deliver.deliverOrQueue
//     / bus.redeliver access resolves with the holder-appropriated closures).
//   - the R6 MINIMAL state: an UNFILLED holder (the pre-bundle state) makes the
//     shell rebuild FAIL LOUD (R1) with the deepartments.<x>Deps.get() text —
//     never a silently-unbound service, never stale closure execution.
// Hermetic boots through the REAL Loader (smokeBoot of smoke-boot.test.js).
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

/** Stub webServer: records the exact routes the bundle's RPC mount registers. */
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

/** Stub webRuntime: carries the deployment's trustedHosts (empty → loopback). */
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

/** bootPlugin MINIMAL (the smoke-boot.test.js pattern): the REAL Loader
 * composes the REAL dsh service rows + dshd-core + the 6 P1 packages + the
 * bundle in the dev-profile order. */
async function smokeBoot(stateDir, { org = { departments: [] } } = {}) {
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
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return {
    root,
    loader,
    pluginCtx,
    dispose: () => loaderFiber.dispose()
  }
}

test('deps-holder-baseline: the createDepsHolder contract resolves at the composed boot — register merges (partial accumulation), clear empties + bumps the epoch (getEpoch)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-holder-baseline-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      const ctx = pluginCtx()
      // The 4 baseline holders resolve as services (provided by dshd-core —
      // P1: the bundle never provides them).
      const lifecycleDeps = ctx.get('deepartments.lifecycleDeps')
      const wakepackDeps = ctx.get('deepartments.wakepackDeps')
      const busDeps = ctx.get('deepartments.busDeps')
      const deliverDeps = ctx.get('deepartments.deliverDeps')
      for (const holder of [lifecycleDeps, wakepackDeps, busDeps, deliverDeps]) {
        assert.ok(holder !== undefined, 'the holder service resolves')
        assert.equal(typeof holder.register, 'function', 'register is a function')
        assert.equal(typeof holder.get, 'function', 'get is a function')
        assert.equal(typeof holder.clear, 'function', 'clear is a function')
        assert.equal(typeof holder.getEpoch, 'function', 'getEpoch is a function')
      }
      // The FILLED state (the bundle registered the closure sets): get()
      // returns content + the epoch is 0 (no clear yet).
      assert.ok(Object.keys(lifecycleDeps.get()).length > 0, 'lifecycleDeps filled by the bundle')
      assert.equal(lifecycleDeps.getEpoch(), 0, 'epoch starts at 0 (never cleared at boot)')
      // register MERGES partials + clear resets to empty + bumps the epoch.
      // (Use THROWAWAY keys to avoid disturbing the composed seams.)
      const probe = ctx.get('deepartments.wakepackDeps')
      const before = Object.keys(probe.get()).length
      probe.register({ probeHolderKey: 'probe-key-value' })
      assert.equal(probe.get().probeHolderKey, 'probe-key-value', 'register merged the partial')
      assert.equal(Object.keys(probe.get()).length, before + 1, 'register accumulated (no replacement)')
      const epoch = probe.getEpoch()
      probe.clear()
      assert.deepEqual(Object.keys(probe.get()), [], 'clear emptied the holder')
      assert.equal(probe.getEpoch(), epoch + 1, 'clear bumped the epoch (cache invalidation signal)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('deps-holder-baseline: the dshd-core lazy shells BUILD THROUGH the holders in the composed boot (holder-first — memoWrite / assembleWakePack / deliverOrQueue / redeliver resolve with the holder closures)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-holder-baseline-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      const ctx = pluginCtx()
      // Access the 4 lazy shells — each resolves a member through its holder.
      const lifecycle = ctx.get('deepartments.lifecycle')
      const wakepack = ctx.get('deepartments.wakepack')
      const deliver = ctx.get('deepartments.deliver')
      const bus = ctx.get('deepartments.bus')
      assert.ok(lifecycle !== undefined && typeof lifecycle.memoWrite === 'function', 'lifecycle.memoWrite builds through lifecycleDeps')
      assert.ok(wakepack !== undefined && typeof wakepack.assembleWakePack === 'function', 'wakepack.assembleWakePack builds through wakepackDeps')
      assert.ok(deliver !== undefined && typeof deliver.deliverOrQueue === 'function', 'deliver.deliverOrQueue builds through deliverDeps')
      // The bus redeliver driver needs the R1-required deps → resolves through busDeps.
      const redeliverFn = bus.redeliver()
      assert.ok(redeliverFn !== undefined && typeof redeliverFn.run === 'function', 'bus.redeliver builds through busDeps (holder-appropriated — a runnable DeliveryRedeliverer)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('deps-holder-baseline: an UNFILLED holder makes the shell rebuild FAIL LOUD R1 with the deepartments.<x>Deps.get() text (never silently unbound)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-holder-baseline-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      const ctx = pluginCtx()
      // Capture + clear the lifecycle holder: the FIRST lifecycle access after
      // the clear REBUILDS (epoch bumped) over the emptied holder and fails
      // loud R1 naming the holder seam.
      const lifecycleDeps = ctx.get('deepartments.lifecycleDeps')
      void ctx.get('deepartments.lifecycle').memoWrite // hydrate the cache under the filled holder
      lifecycleDeps.clear()
      assert.throws(() => { void ctx.get('deepartments.lifecycle').memoWrite }, /required bucket-\(c\) dep\(s\) missing from deepartments\.lifecycleDeps\.get\(\)/, 'lifecycle rebuild over the emptied holder fails loud R1 (deepartments.lifecycleDeps.get())')
      // Same for the deliver holder.
      const deliverDeps = ctx.get('deepartments.deliverDeps')
      void ctx.get('deepartments.deliver').deliverOrQueue
      deliverDeps.clear()
      assert.throws(() => { void ctx.get('deepartments.deliver').deliverOrQueue }, /required bucket-\(c\) dep\(s\) missing from deepartments\.deliverDeps\.get\(\)/, 'deliver rebuild over the emptied holder fails loud R1 (deepartments.deliverDeps.get())')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})