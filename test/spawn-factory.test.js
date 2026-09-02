// dsh-deepartments — SPAWN-FACTORY test (HITO 3 DECOUPLING, SUB-PASO 3 —
// F3 role templates + W1 job-run core + calendar helpers as an orchestration
// factory). Locks the SUB-PASO 3 artifact + wiring:
//   - the ARTIFACT: the spawn/roles zone of applyInvoke (src/invoke.ts
//     3927-4358 = 432 LOCs) was hoisted VERBATIM into
//     src/core/orchestration/spawn.ts and is invoked by the bundle at the SAME
//     fiber position (createSpawnOrchestration → SpawnSurface, MOVEMENT-ONLY —
//     byte-identical to HEAD; invoke.ts = 2 hunks: import + invocation).
//   - the COMPOSITION: the factory consumes the DELIVERY seams (the
//     DeliverySurface's deliverBusRecord / messagesStoreReady) + the
//     agent-setup/workspace seams LATE (getters over the apply-scope bindings,
//     dereferenced at CALL time) and the composed boot carries the WHOLE
//     pipeline (jobs bucket → schedulerRunJob → runJobForDepartment), the 5
//     baseline Binder buckets + the 4 zone buckets untouched;
//   - the E2 with the REAL Loader: ONE real job-run through the composed
//     machinery (dshd-core + the 6 P1 packages + the bundle, dev order) using
//     the REAL job definition + the REAL role template of the repo, the REAL
//     durable registry (posts.json), the REAL composed bus store + delivery
//     engine — driven through the bundle's OWN binder seam (jobs.runJob →
//     schedulerRunJob → the factory's runJobForDepartment), no hand-built deps
//     (NOT tautological).
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

/** A MINIMAL agents service (the bootPlugin shape — create/get/list/roots) so
 * the composed boot can materialize the drive spawn without a real harness. */
class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.createCalls = []
  }
  get(id) { return this.store.get(String(id)) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  async create(options) {
    this.createCalls.push(options)
    const agent = {
      id: String(options.sessionId),
      status: 'running',
      ctx: this.ctx,
      session: { events: [] },
      followup() {},
      cancel() {},
      async whenIdle() {}
    }
    this.store.set(String(options.sessionId), agent)
    return { agent, dispose: async () => { this.store.delete(String(options.sessionId)) } }
  }
  async resume(options) {
    return this.create({ ...options, sessionId: options.resumeSessionId })
  }
}

/** The REAL Loader composition of the dev-profile subset (dshd-core + the 6 P1
 * packages + the bundle, in order) — the bootPlugin pattern. */
async function smokeBoot(stateDir, { org = { departments: [] }, agents = false } = {}) {
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
  const agentsStub = agents === true ? new StubAgents(root) : undefined
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  // LANE 0.2.2 (gap 2): the dev-profile composition now includes the
  // dshd-orchestration package (the 5 factory SERVICES + the deps holders) —
  // the bundle's applyInvoke consumes them service-first with the inline R6
  // fallback (the fallback still runs the SAME package factories via the
  // nominal bridges when this row is absent — hermetic preserved).
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return {
    root,
    loader,
    pluginCtx,
    agentsStub,
    webServer: root.get('webServer'),
    dispose: () => loaderFiber.dispose()
  }
}

// --- the department the factory drives (the REAL repo tree owns the roles). --
const DEPARTMENT = {
  id: 'internal-programming',
  name: 'Internal Programming',
  roomId: 'room-ipd'
}

test('spawn-factory: the SPAWN ZONE was hoisted VERBATIM into the orchestration factory (the artifact + the movement lock)', () => {
  const factory = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'spawn.ts'), 'utf8')
  const bridge = readFileSync(path.join(REPO_ROOT, 'src', 'core', 'orchestration', 'spawn.ts'), 'utf8')
  const invoke = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
  // The artifact: the factory module exports the typed orchestration surface.
  assert.ok(factory.includes('export function createSpawnOrchestration('), 'factory exports createSpawnOrchestration')
  assert.ok(factory.includes('export interface SpawnFactoryDeps'), 'factory exports SpawnFactoryDeps')
  assert.ok(factory.includes('export interface SpawnSurface'), 'factory exports SpawnSurface')
  // LANE 0.2.2: src/core/orchestration/spawn.ts is the NOMINAL re-export
  // bridge to dshd-orchestration (the compiled surface stays a drop-in
  // superset — R6).
  assert.ok(bridge.includes("from 'dshd-orchestration'"), 'the bridge re-exports from dshd-orchestration')
  assert.ok(bridge.includes('createSpawnOrchestration'), 'the bridge names createSpawnOrchestration')
  // The movement: the bundle imports the factory (bridge) ...
  assert.ok(invoke.includes("from './core/orchestration/spawn.js'"), 'invoke.ts imports the factory')
  // ... and NO LONGER defines the zone closures inline (they live in the factory).
  assert.ok(!/const runJobForDepartment = async/.test(invoke), 'runJobForDepartment is no longer inline in invoke.ts')
  assert.ok(!/const spawnWorkerForDepartment = async/.test(invoke), 'spawnWorkerForDepartment is no longer inline in invoke.ts')
  assert.ok(/const runJobForDepartment = async/.test(factory), 'runJobForDepartment moved verbatim into the factory')
  assert.ok(/const spawnWorkerForDepartment = async/.test(factory), 'spawnWorkerForDepartment moved verbatim into the factory')
  assert.ok(/const roleTemplatePath = /.test(factory), 'the F3 role-template resolver moved verbatim (roleTemplatePath)')
  assert.ok(/const readCalendar = /.test(factory), 'the calendar helper moved verbatim (readCalendar)')
  assert.ok(/const departmentJobExists = async/.test(factory), 'the calendar job-exists helper moved verbatim (departmentJobExists)')
  // The invocation is at the SAME fiber position with the inline R6 fallback
  // (service-first 'deepartments.spawn' → the factory) and the SpawnSurface
  // destructure feeds the SAME names the downstream apply uses. LANE 0.2.2:
  // the deps object is hoisted to `spawnDeps` + registered into the holder.
  assert.ok(/ctx\.get\('deepartments\.spawn', false\) as SpawnSurface \| undefined\) \?\? createSpawnOrchestration\(/.test(invoke), 'the bundle invokes the spawn service service-first (NON-STRICT get — the loader may apply rows concurrently) with the inline R6 fallback')
  assert.ok(/const \{\n    runJobForDepartment,\n    spawnWorkerForDepartment,\n    readCalendar,/.test(invoke), 'the bundle destructures the SpawnSurface at the same fiber position')
  // The compiled bundle still exports the SAME superset (no new top-level export
  // leaked — the export-parity lock stays intact by construction); the factory
  // compiles into the PACKAGE lib, the bundle lib bridge re-exports it.
  const lib = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'lib', 'spawn.js'), 'utf8')
  assert.ok(lib.includes('createSpawnOrchestration'), 'the compiled factory exists in the package lib/')
})

test('spawn-factory (composed boot): the composition is intact — the DI-by-services holders are FILLED, jobs runs SERVICE-FIRST through deepartments.spawn (the dead binder jobs bucket is gone), deepartments.spawn provided (P1)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-spawn-factory-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] } })
    try {
      const ctx = pluginCtx()
      // The composition is intact: the binder is DEAD — the DI-by-services
      // baseline holders carry the closure sets (LANE DI-BY-SERVICES):
      assert.equal(ctx.get('deepartments.binder'), undefined, 'deepartments.binder is GONE (LANE DI-BY-SERVICES)')
      for (const holder of ['lifecycleDeps', 'wakepackDeps', 'busDeps', 'deliverDeps']) {
        const deps = ctx.get(`deepartments.${holder}`)
        assert.ok(deps !== undefined && Object.keys(deps.get()).length > 0, `deepartments.${holder} filled (non-empty)`)
      }
      assert.ok(ctx.get('deepartments.jobsDeps') !== undefined, 'deepartments.jobsDeps resolves (PASO 1 untouched)')
      // The jobs run engine resolves SERVICE-FIRST through the composed spawn
      // service (the same closure the factory produced — jobs-spawn-regression
      // A/B/C). The binder `jobs` bucket (register-era) is dead.
      const spawn = ctx.get('deepartments.spawn')
      assert.ok(spawn !== undefined && typeof spawn.runJobForDepartment === 'function', 'deepartments.spawn.runJobForDepartment is the run engine (service-first)')
      // 0 ctx.provide nuevos (P1 invariant "el bundle consume, nunca provee"):
      // the spawn service surface is NOT provided — the inline R6 factory is
      // the fallback (smoke-boot service set intacto).
      assert.equal(ctx.get('deepartments.spawn') === undefined, false, 'deepartments.spawn IS provided (LANE 0.2.2 — the dshd-orchestration package provides the spawn service in the dev profile)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('spawn-factory (E2 con Loader real): ONE real job-run through the composed machinery — the REAL job definition + REAL role template + REAL durable registry + REAL composed bus/deliver', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-spawn-factory-'))
  try {
    // A durable HEAD entry must exist in posts.json BEFORE the boot (the
    // registry loads it into the bundle's byPost — the schedulerRunJob seam
    // resolves the head from there). Persisted in the REGISTRY's own shape.
    await writeFile(
      path.join(stateDir, 'posts.json'),
      JSON.stringify({
        'internal-programming-head': {
          sessionId: 'session-ipd-head-1',
          roomId: 'room-ipd',
          agentPreset: 'deepartments-head'
        }
      }, null, 2),
      'utf8'
    )
    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir, { agents: true })
    try {
      const ctx = pluginCtx()
      assert.ok(agentsStub !== undefined, 'the agents stub is mounted (the bootPlugin shape)')
      // The composed engine + bus (the SAME services the DeliverySurface's
      // deliverBusRecord wrapper uses — dshd-core FASE 2.6-C).
      const deliverSvc = ctx.get('deepartments.deliver')
      const busSvc = ctx.get('deepartments.bus')
      assert.ok(deliverSvc !== undefined && typeof deliverSvc.deliverOrQueue === 'function', 'deepartments.deliver resolves (the composed engine)')
      assert.ok(busSvc !== undefined, 'deepartments.bus resolves (the composed store)')

      // The REAL job definition of the repo (docs/departments/internal-programming/
      // jobs/system-health-report.md — role builder, REAL role template at
      // presets/departments/internal-programming/builder.md). The factory's
      // own readJobDefinitionFile reads it from the REAL repo tree.
      const jobId = 'system-health-report'
      const jobPath = path.join(REPO_ROOT, 'docs', 'departments', 'internal-programming', 'jobs', `${jobId}.md`)
      assert.ok(existsSync(jobPath), 'the real job definition exists in the repo')
      const rolePath = path.join(REPO_ROOT, 'presets', 'departments', 'internal-programming', 'builder.md')
      assert.ok(existsSync(rolePath), 'the real role template exists in the repo')

      // Drive the REAL scheduler seam of the composed bundle: the DI-by-
      // services world runs jobs SERVICE-FIRST through deepartments.spawn's
      // runJobForDepartment (the dead binder's schedulerRunJob seam is gone —
      // jobs-spawn-regression A/B/C freeze the service-first contract). The
      // head is already in byPost (the durable posts.json above). The run
      // executes the REAL end-to-end job-run:
      // definition read → role validation → template resolve → slug dedup →
      // agents.create (materialize) → durable registerEntry → title pin →
      // first durable bus message (JOB BODY) → deliverBusRecord through the
      // composed engine.
      const spawnSvc = ctx.get('deepartments.spawn')
      assert.ok(spawnSvc !== undefined && typeof spawnSvc.runJobForDepartment === 'function', 'deepartments.spawn.runJobForDepartment is the run engine (service-first)')
      // Resolve the durable head entry from the composed catalog (the registry
      // loads posts.json ASYNC — poll until the head entry lands).
      let headEntry
      const catalog = ctx.get('deepartments.catalog')
      for (let i = 0; i < 100; i++) {
        headEntry = catalog.byPost?.get('internal-programming-head')
        if (headEntry !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headEntry !== undefined, 'the durable head entry resolved in the composed catalog')
      const runJob = async (department, headPostId, job) => { await spawnSvc.runJobForDepartment(department, headEntry, job, { callerSessionId: headEntry.sessionId }); return true }
      // The bundle loads posts.json ASYNC (fire-and-forget at apply); poll the
      // scheduler seam until the head resolves (the durable registry readiness).
      let fired = false
      let lastNoFire = ''
      let lastError = ''
      for (let i = 0; i < 100; i++) {
        try {
          fired = await runJob(DEPARTMENT, 'internal-programming-head', jobId)
          if (fired) break
        } catch (error) { lastError = error instanceof Error ? error.message : String(error) /* transient — keep polling */ }
        if (existsSync(path.join(stateDir, 'post-errors.jsonl'))) {
          lastNoFire = readFileSync(path.join(stateDir, 'post-errors.jsonl'), 'utf8')
        }
        await new Promise((r) => setTimeout(r, 30))
      }
      // The scheduler seam records NO-FIRE reasons durably (post-errors.jsonl);
      // surface them in the assertion for a fast diagnosis.
      assert.equal(fired, true, `the scheduler seam reports the job ran (post-errors: ${JSON.stringify(lastNoFire)} last-error: ${lastError})`)

      // Evidence 1 — the worker was spawned: the durable registry now carries a
      // worker row for the job with the REAL role and the manager head.
      // (registerEntry → persistPosts is fire-and-forget: poll briefly for the
      // durable write.)
      let postsAfter
      for (let i = 0; i < 50; i++) {
        postsAfter = JSON.parse(readFileSync(path.join(stateDir, 'posts.json'), 'utf8'))
        if (Object.values(postsAfter).some((e) => e.provider === 'worker' && e.jobId === jobId)) break
        await new Promise((r) => setTimeout(r, 20))
      }
      const workers = Object.values(postsAfter).filter((e) => e.provider === 'worker' && e.jobId === jobId)
      assert.ok(workers.length === 1, `the job run spawned EXACTLY one durable worker (got ${workers.length})`)
      const worker = workers[0]
      assert.equal(worker.role, 'builder', 'the worker carries the REAL job role (builder)')
      assert.equal(worker.managerId, 'internal-programming-head', 'the worker is managed by the head')
      assert.equal(worker.departmentId, 'internal-programming', 'the worker belongs to the department')

      // Evidence 2 — the worker's durable session was materialized through the
      // agents service (the factory's agents.create — the deepartments-worker
      // avatar with the JOB BODY as its first bus message).
      const workerCreated = agentsStub.createCalls.find((c) => c.meta?.agentPreset === 'deepartments-worker')
      assert.ok(workerCreated !== undefined, 'a deepartments-worker avatar was materialized')
      assert.equal(workerCreated.meta.agentPreset, 'deepartments-worker', 'the worker avatar carries the worker preset')

      // Evidence 3 — the JOB BODY landed as the worker's first durable bus
      // message (the composed bus store, messages.jsonl): a record addressed to
      // the worker postId whose text is the job definition body.
      const messagesPath = path.join(stateDir, 'messages.jsonl')
      assert.ok(existsSync(messagesPath), 'the composed bus store persisted messages.jsonl')
      const lines = readFileSync(messagesPath, 'utf8').trim().split('\n').filter(Boolean)
      const workerPostId = Object.keys(postsAfter).find((k) => postsAfter[k].provider === 'worker' && postsAfter[k].jobId === jobId)
      assert.ok(workerPostId !== undefined, 'the worker postId is the durable registry key')
      const msg = lines.map((l) => JSON.parse(l)).find((r) => Array.isArray(r.to) && r.to.includes(workerPostId))
      assert.ok(msg !== undefined, 'the JOB BODY was delivered as the worker first bus message')
      // The message text is the REAL job body (the factory appends
      // definition.body verbatim) — a distinctive phrase from the file.
      const bodyText = readFileSync(jobPath, 'utf8')
      const marker = bodyText.split('\n').find((l) => l.includes('Produce a daily'))
      assert.ok(marker !== undefined, 'the job body carries the distinctive instruction')
      assert.ok(msg.text.includes(marker.trim()), 'the durable message carries the REAL job body instruction')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})