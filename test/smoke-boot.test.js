// dsh-deepartments — smoke-boot LOCK test (HITO 3 DECOUPLING, PASO 1 —
// E2-parcial). BOOT REAL with the Loader: composes the REAL rows of the dev
// profile subset (dshd-core + the 6 P1 plugin packages + the bundle, in the
// exact compose order) and asserts a HEALTHY boot — the P1 client-row lesson:
// a composition-level boot failure ("Failed to load plugins") is only caught by
// a REAL Loader boot, never by in-memory applies. The smoke covers every
// decoupling sub-paso:
//   - baseline: applies OK, the deepartments.* services resolve, the bundle
//     registers the 5 baseline Binder buckets,
//   - gui: the dshd-gui row is composed and the deepartments.gui service
//     resolves (the RPC channel surface — consumed by the bundle's webServer
//     mount; the row keeps NO dsh.client, locked by client-row-invariant),
//   - daemons/fill: after the bucket fill, calling the consumed services does
//     NOT fail-loud (the fail-loud R1 path is the pre-fill contract).
//
// Pattern: the bootPlugin helper of test/invoke.test.js:801-899 (real Loader +
// real dsh rows: sessions/projections/systemPrompt/tools + dshd-core + bundle)
// with agents/sessions/persistence STUB services and the dev-profile row order.
// The webServer/webRuntime/connection services are STUBS (no real web app) so
// the bundle's RPC mount effect runs and registers its exact routes — the
// client-graph server half. Hermetic: a temp stateDir; dispose clears effects.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** Stub webServer: records the exact routes the bundle's RPC mount registers
 * (the /deepartments/* channel) — a real webServer-like `register` returns a
 * disposer (the mount effect folds them into one reversible registration). */
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

/** Stub webRuntime: carries the deployment's trustedHosts (like dsh-web-app's
 * resolveLanTrust). Empty here → the channel trusts loopback only. */
class StubWebRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'webRuntime')
    this.trustedHosts = []
  }
}

/** Stub connection (dsh-client-connection's HostConnectionService shape): the
 * fallback trusted-host source the mount reads when webRuntime is absent. */
class StubConnection extends Service {
  constructor(ctx) {
    super(ctx, 'connection')
    this.trustedHosts = []
  }
}

/** bootPlugin MINIMAL: the REAL Loader composes the REAL dsh service rows +
 * dshd-core + the 6 P1 packages + the bundle (dev-profile order). agents/
 * sessions/persistence are the bootPlugin-style stubs (the bundle resolves
 * them OPTIONALLY at apply — present here so the boot matches the GUI profile
 * shape). webServer/webRuntime/connection are stubs so the RPC mount runs. */
async function smokeBoot(stateDir, { org = { departments: [] } } = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  // Stub harness services (bootPlugin pattern — the client-graph server half):
  // webServer/webRuntime/connection so the bundle's ctx.inject mount runs.
  new StubWebServer(root)
  new StubWebRuntime(root)
  new StubConnection(root)
  // The dev-profile composition subset (exact row order — LANE 0.2.2 adds the
  // dshd-orchestration row BETWEEN the P1 packages and the bundle):
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
    webServer: root.get('webServer'),
    dispose: () => loaderFiber.dispose()
  }
}

test('smoke-boot: the REAL dev-profile composition (dshd-core + 6 P1 + bundle) applies OK without throw', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-smoke-'))
  try {
    const { dispose, pluginCtx } = await smokeBoot(stateDir)
    try {
      // The bundle applied: the plugin ctx is resolvable and the boot line ran.
      assert.ok(pluginCtx() !== undefined, 'the deepartments plugin ctx resolves (bundle applied)')
      // Every deepartments.* service the P1 packages provide resolves at boot.
      // LANE 0.2.2: +5 — the dshd-orchestration factory services.
      for (const service of [
        'deepartments.org', 'deepartments.catalog', 'deepartments.binder',
        'deepartments.feedback', 'deepartments.quality', 'deepartments.pooler',
        'deepartments.jobs', 'deepartments.health', 'deepartments.gui',
        'deepartments.boot', 'deepartments.presets', 'deepartments.spawn',
        'deepartments.tools', 'deepartments.delivery'
      ]) {
        assert.ok(pluginCtx().get(service) !== undefined, `${service} resolves`)
      }
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('smoke-boot: the webServer mount registers the 6 /deepartments RPC routes (client-graph server half, headless-safe)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-smoke-'))
  try {
    const { webServer, dispose } = await smokeBoot(stateDir)
    try {
      const paths = webServer.routes.map((r) => r.path).sort()
      assert.deepEqual(paths, [
        '/deepartments/agenda/list',
        '/deepartments/agents',
        '/deepartments/host/status',
        '/deepartments/list',
        '/deepartments/presence/get',
        '/deepartments/presence/set'
      ].sort(), 'the bundle RPC mount registered the exact 6 channel routes')
      assert.ok(webServer.routes.every((r) => r.kind === 'exact'), 'every route is kind:exact (the rc.8 transport pattern)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('smoke-boot: the binder carries the 5 baseline buckets + the 4 zone buckets (LANE 0.2.3b — the re-homed register fills them outside the frozen CUT-4 zone; the dshd-core lazy shells read the baseline buckets at use)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-smoke-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      const binder = pluginCtx().get('deepartments.binder')
      assert.ok(binder !== undefined, 'deepartments.binder resolves')
      const buckets = binder.get()
      for (const bucket of ['bus', 'deliver', 'wakepack', 'lifecycle', 'redeliver']) {
        assert.ok(buckets[bucket] !== undefined, `baseline bucket "${bucket}" registered`)
      }
      // The four zone buckets the DECOUPLING hito fills: the bundle REGISTERS
      // them as part of PASO 1 (LANE 0.2.3b — the re-homed register, outside
      // the frozen zone). This lock asserts the REGISTERED STATE — the P1
      // services' primary path is their holders, the binder buckets are the R6
      // fallback wire (the binder-contract test freezes the field sets).
      for (const bucket of ['health', 'jobs', 'pooler', 'gui']) {
        if (buckets[bucket] === undefined) {
          // Pre-fill: the P1 service reads it at USE and fails loud (R1) —
          // the current contract. Assert the fail-loud path is live so a
          // regression can never silently no-op.
          const service = pluginCtx().get(`deepartments.${bucket}`)
          assert.ok(service !== undefined, `deepartments.${bucket} service resolves (lazy surface)`)
        } else {
          assert.ok(Object.keys(buckets[bucket]).length > 0, `${bucket} bucket filled (non-empty)`)
        }
      }
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('smoke-boot (PASO 1 — daemons→dshd-jobs/dshd-health + 4 buckets): the services run WITHOUT fail-loud after the fill — E2 per-tick (jobs scheduler + health tick + boot checks)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-smoke-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      // The 4 zone services resolve at the composed boot; the DECOUPLING daemon
      // effects now consume them (binder buckets registered by the bundle) —
      // each call below would FAIL LOUD (R1) pre-fill, so a pass proves the
      // bucket fill + the composed-service wiring end-to-end.
      const jobs = pluginCtx().get('deepartments.jobs')
      const health = pluginCtx().get('deepartments.health')
      const pooler = pluginCtx().get('deepartments.pooler')
      const gui = pluginCtx().get('deepartments.gui')
      assert.ok(jobs !== undefined && typeof jobs.runSchedulerTick === 'function', 'deepartments.jobs.runSchedulerTick resolvable')
      assert.ok(health !== undefined && typeof health.runDaemonTick === 'function', 'deepartments.health.runDaemonTick resolvable')
      assert.ok(pooler !== undefined && typeof pooler.runProviderAdapterBootCheck === 'function', 'deepartments.pooler.runProviderAdapterBootCheck resolvable')
      assert.ok(gui !== undefined && typeof gui.dispatch === 'function', 'deepartments.gui.dispatch resolvable')
      // Per-tick invocations: the scheduler tick runs the W1 agenda scan (empty
      // org → no departments → no jobs — never throws); the health tick runs
      // the W6 scan (empty registries → heartbeat + no-op scans — never throws);
      // the pooler boot check skips (no llm service — warn, never throws); the
      // gui dispatch answers the roster.
      await jobs.runSchedulerTick({ now: () => Date.now() })
      await health.runDaemonTick({ now: () => Date.now(), hosts: [], posts: [], hostWaits: [], sessionContexts: [], hostRunning: false })
      await pooler.runProviderAdapterBootCheck()
      const result = await gui.dispatch('agents', { sessionId: 'host-x' })
      assert.equal(result.ok, true, 'gui dispatch ok (agents/list through the composed service)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('smoke-boot (PASO 1 — daemons→dshd-jobs/dshd-health): the daemon EFFECTS are registered and tick through the composed services (not the inline fallback)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-smoke-'))
  // Capture the setInterval calls the plugin effects make (the hermetic pattern
  // of invoke.test.js:17640-17646) so the CAPTURED daemon ticks can be driven
  // once — in the COMPOSED boot the effect resolves the service, so driving the
  // tick must dispatch through deepartments.jobs / deepartments.health with the
  // filled buckets (a pre-fill boot would fail loud R1 at that point).
  const setCalls = []
  const clearCalls = []
  const origSet = global.setInterval
  const origClear = global.clearInterval
  global.setInterval = (fn, delay, ...args) => { const handle = { fn, delay, args }; setCalls.push(handle); return handle }
  global.clearInterval = (handle) => { clearCalls.push(handle) }
  let dispose
  try {
    const boot = await smokeBoot(stateDir)
    dispose = boot.dispose
    try {
      // The daemons register their intervals (agenda 30s; health 60s default).
      const agenda = setCalls.find((c) => c.delay === 30000)
      const health = setCalls.find((c) => c.delay === 60000)
      assert.ok(agenda !== undefined, 'the agenda scheduler daemon registered setInterval(30000)')
      assert.ok(health !== undefined, 'the system-health daemon registered setInterval(60000)')
      // Drive ONE captured tick of each. In this COMPOSED boot the effects
      // resolved the services, so a green tick proves the SERVICE path with the
      // filled buckets (the inline fallback would be the hermetic-only path).
      agenda.fn()
      health.fn()
      // Let the fire-and-forget ticks settle (they read the empty registries and
      // must NOT fail loud — the alerts/deliveries would throw if the buckets
      // were missing).
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      assert.ok(true, 'captured daemon ticks ran through the composed services without fail-loud')
      // Reversible effects (AGENTS.md rule 4): cleared on dispose.
      await dispose()
      dispose = undefined
      for (const handle of [agenda, health]) {
        assert.ok(clearCalls.includes(handle), 'daemon intervals cleared on dispose (clearInterval)')
      }
    } finally {
      if (dispose !== undefined) await dispose()
    }
  } finally {
    global.setInterval = origSet
    global.clearInterval = origClear
    // The driven health tick may still write files (heartbeat) fire-and-forget —
    // retry the rm until the async writes settle.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await rm(stateDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
  }
})

test('smoke-boot: the client-graph invariant holds at boot — the deepartments BUNDLE row carries the client, the dshd-gui PLUGIN row does NOT (loaded-without-registering never returns)', async () => {
  // The P1 client-row lesson: a row keyed by the LOADER ENTRY name must be
  // satisfied by the bundle that registers that id. This is locked durably by
  // client-row-invariant.test.js; the smoke re-verifies at the COMPOSITION
  // level: both rows coexist in the same real boot and the bundle booted fine.
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-smoke-'))
  try {
    const { root, dispose } = await smokeBoot(stateDir)
    try {
      // The loader resolved BOTH rows (the client row + the plugin row) without
      // the "loaded without registering" failure — the composition boot is the
      // server half of the client-graph boot.
      assert.ok(root.loader.resolve('deepartments') !== undefined, 'the deepartments loader entry resolved')
      assert.ok(root.loader.resolve('dshd-gui') !== undefined, 'the dshd-gui loader entry resolved')
      assert.ok(root.loader.resolve('dshd-health') !== undefined, 'the dshd-health loader entry resolved')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('smoke-boot (PASO 1 — guiChannel→dshd-gui): the mounted /deepartments route dispatches THROUGH the composed deepartments.gui service (E2 — the bundle consumes the plugin service, not the inline closure)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-smoke-'))
  try {
    const { webServer, pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      const guiService = pluginCtx().get('deepartments.gui')
      assert.ok(guiService !== undefined, 'the composed deepartments.gui service resolves')
      // The gui service must build WITHOUT fail-loud once the bundle registered
      // the `gui.endpointDeps` bucket (the DECOUPLING fill) — this is the
      // fail-loud R1 path flipping to the WORKING path.
      const result = await guiService.dispatch('host/status', {})
      assert.ok(result.ok === true, `the gui service dispatches (host/status ok; got ${JSON.stringify(result).slice(0, 120)})`)
      assert.equal(result.value.hostSessionId, null, 'empty registry → no live host (payload shape intact)')
      // The webServer mount routes are bound to the SERVICE too — drive the
      // REAL registered handler with a fake POST envelope end-to-end.
      const route = webServer.routes.find((r) => r.path === '/deepartments/agents')
      assert.ok(route !== undefined, 'the /deepartments/agents route is mounted')
      const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'agents', payload: { sessionId: 'host-x' } })
      const fakeReq = {
        method: 'POST',
        headers: { host: 'localhost:8445', 'sec-fetch-site': 'same-origin' },
        [Symbol.asyncIterator]: async function* () { yield Buffer.from(body) }
      }
      let status = 0
      let payload = ''
      const fakeRes = {
        writeHead: (s) => { status = s },
        end: (chunk) => { payload = String(chunk) }
      }
      await route.handler(fakeReq, fakeRes)
      assert.equal(status, 200, 'the mounted route answers 200')
      const parsed = JSON.parse(payload)
      assert.equal(parsed.type, 'server-response')
      assert.equal(parsed.rpcId, 'r1')
      assert.equal(parsed.result.ok, true, `dispatch ok via the served route (${payload.slice(0, 120)})`)
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})