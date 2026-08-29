// dsh-deepartments — DELIVERY-FACTORY test (HITO 3 DECOUPLING, SUB-PASO 2 —
// delivery/ACL/QD/lifecycle/engine as an orchestration factory). Locks the
// SUB-PASO 2 artifact + wiring:
//   - the ARTIFACT: the delivery zone of applyInvoke (src/invoke.ts 7164-8252
//     = ~1089 LOCs) was hoisted VERBATIM into src/core/orchestration/delivery.ts
//     and is invoked by the bundle at the SAME fiber position (the factory
//     builds the same closures in the same order — MOVEMENT-ONLY). The lock
//     asserts the factory module exists with its typed surface and that
//     invoke.ts no longer defines the zone closures inline;
//   - the BUCKETS: the composed boot carries the 5 baseline Binder buckets
//     (bus/deliver/wakepack/lifecycle/redeliver) with the FACTORY-PRODUCED
//     closures (deliver: deliverPost/deliverHost/resolveCatalogRoute/
//     busProfileFor/child route; lifecycle: the sleep/wake/rotate deps +
//     maybeEmitQualityInspectDirective + enqueueHostWake) — the sub-paso 2
//     bucket-fill contract (fields ⊆ the package interfaces, binder-contract);
//   - the SERVICES: the bundle consumes the REGISTERED dshd-core services
//     (deepartments.bus / .deliver / .lifecycle / .acl) at the same positions —
//     a REAL Loader boot (the bootPlugin pattern of invoke.test.js:801) drives
//     ONE delivery through the composed deepartments.deliver engine (the
//     write-ahead sidecar + the unknown-recipient settlement 'failed') and the
//     composed bus store.
// Hermetic: temp stateDir; dispose clears effects.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

/** Stub webServer/webRuntime/connection so the bundle's RPC mount effect runs
 * (the smoke-boot pattern — the client-graph server half). */
class StubWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = []
  }
  register(route) { this.routes.push(route); return () => {} }
}
class StubWebRuntime extends Service {
  constructor(ctx) { super(ctx, 'webRuntime'); this.trustedHosts = [] }
}
class StubConnection extends Service {
  constructor(ctx) { super(ctx, 'connection'); this.trustedHosts = [] }
}

/** The REAL Loader composition of the dev-profile subset (dshd-core + the 6 P1
 * packages + the bundle, in order) — the bootPlugin pattern. */
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

test('delivery-factory: the DELIVERY ZONE was hoisted VERBATIM into the orchestration factory (the artifact + the movement lock)', () => {
  const factory = readFileSync(path.join(REPO_ROOT, 'src', 'core', 'orchestration', 'delivery.ts'), 'utf8')
  const invoke = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
  // The artifact: the factory module exports the typed orchestration surface.
  assert.ok(factory.includes('export function createDeliveryOrchestration('), 'factory exports createDeliveryOrchestration')
  assert.ok(factory.includes('export interface DeliveryFactoryDeps'), 'factory exports DeliveryFactoryDeps')
  assert.ok(factory.includes('export interface DeliverySurface'), 'factory exports DeliverySurface')
  // The movement: the bundle imports the factory ...
  assert.ok(invoke.includes("from './core/orchestration/delivery.js'"), 'invoke.ts imports the factory')
  // ... and NO LONGER defines the zone closures inline (they live in the factory).
  assert.ok(!/const busDeliverToPost = async/.test(invoke), 'busDeliverToPost is no longer inline in invoke.ts')
  assert.ok(!/const busDeliverToHost = async/.test(invoke), 'busDeliverToHost is no longer inline in invoke.ts')
  assert.ok(!/const maybeEmitQualityInspectDirective = async/.test(invoke), 'the QD emitter is no longer inline in invoke.ts')
  assert.ok(/const busDeliverToPost = async/.test(factory), 'busDeliverToPost moved verbatim into the factory')
  assert.ok(/const maybeEmitQualityInspectDirective = async/.test(factory), 'the QD emitter moved verbatim into the factory')
  // The compiled bundle still exports the SAME superset (no new top-level export
  // leaked from the factory — the export-parity lock stays intact by construction).
  const lib = readFileSync(path.join(REPO_ROOT, 'lib', 'core', 'orchestration', 'delivery.js'), 'utf8')
  assert.ok(lib.includes('createDeliveryOrchestration'), 'the compiled factory exists in lib/')
})

test('delivery-factory (composed boot): the 5 baseline buckets carry the FACTORY-PRODUCED delivery/lifecycle closures (the sub-paso 2 fill)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-delivery-factory-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      const binder = pluginCtx().get('deepartments.binder')
      assert.ok(binder !== undefined, 'deepartments.binder resolves')
      const buckets = binder.get()
      // The deliver bucket (the DELIVERY ENGINE deps — the factory closures).
      const deliver = buckets.deliver
      assert.ok(deliver !== undefined, 'deliver bucket registered')
      for (const field of ['resolveChild', 'deliverChild', 'resolveCatalogRoute', 'busProfileFor', 'deliverPost', 'deliverHost']) {
        assert.equal(typeof deliver[field], 'function', `deliver bucket carries ${field} (the factory closure)`)
      }
      // The lifecycle bucket (sleep/wake/rotate deps — the factory closures).
      const lifecycle = buckets.lifecycle
      assert.ok(lifecycle !== undefined, 'lifecycle bucket registered')
      for (const field of ['ensureHost', 'writeJournal', 'readJournal', 'bumpHostSleepCounter', 'bumpPostSleepCounter', 'archivePostSessionOnSleep', 'disposeHeadHandleOnce', 'maybeEmitQualityInspectDirective', 'enqueueHostWake']) {
        assert.equal(typeof lifecycle[field], 'function', `lifecycle bucket carries ${field} (the factory closure)`)
      }
      // The bus + redeliver buckets (the re-delivery driver deps).
      assert.equal(typeof buckets.bus?.redeliver, 'object', 'bus bucket carries the redeliver deps')
      assert.equal(typeof buckets.redeliver?.recipientAlive, 'function', 'redeliver bucket carries recipientAlive')
      // The zone buckets of PASO 1 stay untouched (still registered, non-empty).
      for (const bucket of ['health', 'jobs', 'pooler', 'gui']) {
        assert.ok(buckets[bucket] !== undefined && Object.keys(buckets[bucket]).length > 0, `${bucket} bucket still filled (PASO 1 untouched)`)
      }
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('delivery-factory (composed boot): ONE bus delivery through the composed deepartments.deliver engine + the composed bus store (the bundle consumes the REGISTERED services)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-delivery-factory-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      const deliverSvc = pluginCtx().get('deepartments.deliver')
      const busSvc = pluginCtx().get('deepartments.bus')
      assert.ok(deliverSvc !== undefined && typeof deliverSvc.deliverOrQueue === 'function', 'the composed deepartments.deliver engine resolves (deliverOrQueue)')
      assert.ok(busSvc !== undefined, 'the composed deepartments.bus service resolves')
      // The bundle's messagesStoreReady IS the core bus store in this composition
      // (the factory's service-first read — FASE 2.6-C): append a durable record
      // through it and deliver to an UNKNOWN recipient — the ALTO-2
      // ghost-delivery settlement: 'failed' per-recipient, no wake, and the
      // write-ahead level-1 sidecar row is written (deliveries.jsonl).
      const store = await busSvc.storeReady
      const record = await store.append({ from: 'builder-x', to: ['ghost-unknown-7f3a2'], text: 'delivery-factory E2 probe', kind: 'agent' })
      const status = await deliverSvc.deliverOrQueue('ghost-unknown-7f3a2', record, {
        callerAgentId: 'host-probe',
        senderSessionId: 'host-probe'
      })
      assert.ok(typeof status === 'string' && status.startsWith('failed'), `unknown recipient settles 'failed' through the composed engine (got ${status})`)
      // The sidecar: the pair (record.id, ghost-unknown-...) was settled (the
      // engine's markFinal wrote the durable row — the same seam the bundle's
      // own fallback engine uses).
      const deliveriesPath = path.join(stateDir, 'deliveries.jsonl')
      assert.ok(existsSync(deliveriesPath), 'the write-ahead sidecar file exists')
      const rows = readFileSync(deliveriesPath, 'utf8').trim().split('\n').filter(Boolean)
      const settled = rows.some((row) => row.includes(record.id) && row.includes('ghost-unknown-7f3a2'))
      assert.ok(settled, 'the pair (messageId, recipientId) was settled in the sidecar through the composed service')
      // The ACL + profile classifiers the send_message tool uses are also the
      // factory-produced closures (binder deliver bucket = the bundle bind).
      assert.equal(typeof binderGet(pluginCtx()).deliver.busProfileFor('host-probe'), 'object', 'busProfileFor resolves a profile for the host caller')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

function binderGet(pluginCtx) {
  const binder = pluginCtx.get('deepartments.binder')
  assert.ok(binder !== undefined, 'deepartments.binder resolves')
  return binder.get()
}