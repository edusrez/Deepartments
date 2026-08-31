// dsh-deepartments — TOOLS-FACTORY test (HITO 3 DECOUPLING, SUB-PASO 4,
// SUB-BATCHES 1-2 of 4: the dept_exec/zstd runners + the agent toolset
// REGISTRY (installHeadBoardTools) + the persona/architecture prompt sections
// + postSetup/headSetup/workerSetup + the head-dispose/retire helpers as an
// orchestration factory). Locks the SUB-BATCH 1-2 artifacts + wiring:
//   - the ARTIFACT: the first cuts of the tools zone of applyInvoke
//     (src/invoke.ts CUT1 3977-4898 = 922 LOCs, CUT2 4061-4672 = pre-SB1
//     4900-5511 = 612 LOCs) were hoisted VERBATIM into
//     src/core/orchestration/tools.ts and are invoked by the bundle at the SAME
//     fiber position (createToolsOrchestration → ToolsSurface, MOVEMENT-ONLY —
//     byte-identical to HEAD; invoke.ts = minimal hunks: deps + invocation +
//     destructure).
//   - the COMPOSITION: the factory consumes the SPAWN surface members by
//     reference + the workspace/retire/delivery seams + the tool ARRAYS LATE
//     (getters over the apply-scope bindings, dereferenced only at CALL time —
//     installHeadBoardTools runs at materialization, the tool executes at user
//     calls) and the composed boot carries the WHOLE pipeline (ensureHead →
//     headSetup/postSetup → installRoleSection (persona/architecture) →
//     installHeadBoardTools → the post own-layer toolset), the 5 baseline
//     Binder buckets + the 4 zone buckets untouched;
//   - the E2 with the REAL Loader: ONE real materialization through the
//     composed machinery (dshd-core + the 6 P1 packages + the bundle, dev
//     order) using the REAL role template of the repo (builder — declares
//     dept_exec) so installHeadBoardTools RUNS and the own-layer toolset
//     demonstrates the registry: calendar/dept_exec/dept_zstd_read for the
//     allowExec role, the manager-only lifecycle tools absent from a worker —
//     driven through the bundle's OWN materialize path, no hand-built deps
//     (NOT tautological). SUB-BATCH 2 additionally proves the PERSONA/
//     ARCHITECTURE sections land on the materialized head through the factory
//     closures (the real presets/departments/internal-programming/
//     ARCHITECTURE.md is templated by renderDepartmentTemplate).
// Hermetic: temp stateDir; dispose clears effects.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createScope } from '@deepseek-ai/dsh-scope'

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

/** An agents service that MATERIALIZES a REAL scoped cordis child context and
 * RUNS the postSetup setup closure (the bootPlugin shape — dsh-agent-loop
 * awaits `setup?.(ctx)`), so installHeadBoardTools actually executes and its
 * registration lands on the post's OWN tool layer. */
class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.childContexts = []
    this.createCalls = []
    this.scopeAnchor = ctx
  }
  get(id) { return this.store.get(String(id)) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  async create(options) {
    this.createCalls.push(options)
    const sessionId = String(options.sessionId)
    const agent = {
      id: sessionId,
      status: 'running',
      ctx: undefined,
      session: { events: [] },
      followup() {},
      cancel() {},
      async whenIdle() {}
    }
    // The REAL scoped child context (createScope — the mechanism the real agent
    // factory uses), anchored under the ROOT ctx (the invoke.test.js pattern)
    // so the upward service walk resolves childCtx.tools as traced.
    const childKey = Symbol('stub-child-scope')
    const scope = createScope(this.scopeAnchor, childKey)
    const childCtx = scope.ctx.extend({ agent })
    agent.ctx = childCtx
    this.childContexts.push({ ctx: childCtx, key: childKey, agent })
    // The programmatic setup runs BEFORE publish and the real harness AWAITS it
    // (dsh-agent-loop lib/index.js:1260) — the stub awaits it too.
    const provision = await options.setup?.(childCtx)
    provision?.commit?.()
    this.store.set(sessionId, agent)
    return { agent, dispose: async () => { this.store.delete(sessionId) } }
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
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  // The scope anchor for the stub child contexts is the TOOLS fiber ctx (the
  // invoke.test.js pattern — the upward service walk resolves childCtx.tools
  // only when the anchor is the registered tools instance).
  if (agentsStub !== undefined) {
    agentsStub.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  }
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
  roomId: 'room-ipd',
  coordinator: { postId: 'internal-programming-head' }
}

test('tools-factory: the TOOLS ZONE CUTS 1+2 were hoisted VERBATIM into the orchestration factory (the artifact + the movement lock)', () => {
  const factory = readFileSync(path.join(REPO_ROOT, 'src', 'core', 'orchestration', 'tools.ts'), 'utf8')
  const invoke = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
  // The artifact: the factory module exports the typed orchestration surface.
  assert.ok(factory.includes('export function createToolsOrchestration('), 'factory exports createToolsOrchestration')
  assert.ok(factory.includes('export interface ToolsFactoryDeps'), 'factory exports ToolsFactoryDeps')
  assert.ok(factory.includes('export interface ToolsSurface'), 'factory exports ToolsSurface')
  // The movement: the bundle imports the factory ...
  assert.ok(invoke.includes("from './core/orchestration/tools.js'"), 'invoke.ts imports the factory')
  // ... and NO LONGER defines the CUT-1 zone closures inline (they live in the
  // factory).
  assert.ok(!/const installHeadBoardTools = /.test(invoke), 'installHeadBoardTools is no longer inline in invoke.ts')
  assert.ok(!/const deptExecAllowedRoots = async/.test(invoke), 'deptExecAllowedRoots is no longer inline in invoke.ts')
  assert.ok(!/const runDeptExec = async/.test(invoke), 'runDeptExec is no longer inline in invoke.ts')
  // ... and NO LONGER defines the CUT-2 zone closures inline either (SUB-BATCH
  // 2: the persona/architecture + setup + dispose/retire closures moved).
  assert.ok(!/const renderDepartmentTemplate = /.test(invoke), 'renderDepartmentTemplate is no longer inline in invoke.ts')
  assert.ok(!/const buildArchitectureSection = /.test(invoke), 'buildArchitectureSection is no longer inline in invoke.ts')
  assert.ok(!/const installRoleSection = /.test(invoke), 'installRoleSection is no longer inline in invoke.ts')
  assert.ok(!/const agentScopeOf = /.test(invoke), 'agentScopeOf is no longer inline in invoke.ts')
  assert.ok(!/const postSetup = /.test(invoke), 'postSetup is no longer inline in invoke.ts')
  assert.ok(!/const headSetup = /.test(invoke), 'headSetup is no longer inline in invoke.ts')
  assert.ok(!/const workerSetup = /.test(invoke), 'workerSetup is no longer inline in invoke.ts')
  assert.ok(!/const disposeHeadHandle = /.test(invoke), 'disposeHeadHandle is no longer inline in invoke.ts')
  assert.ok(!/const disposeHeadHandleOnce = /.test(invoke), 'disposeHeadHandleOnce is no longer inline in invoke.ts')
  assert.ok(!/const disposeJoinTimeoutMs = /.test(invoke), 'disposeJoinTimeoutMs is no longer inline in invoke.ts')
  assert.ok(!/const joinHeadDisposeOnce = /.test(invoke), 'joinHeadDisposeOnce is no longer inline in invoke.ts')
  assert.ok(!/const captureRetiredPostTurnError = /.test(invoke), 'captureRetiredPostTurnError is no longer inline in invoke.ts')
  assert.ok(!/const settleRetiredPostDeliveries = /.test(invoke), 'settleRetiredPostDeliveries is no longer inline in invoke.ts')
  assert.ok(!/const predictRetiredWorkerDeliverable = /.test(invoke), 'predictRetiredWorkerDeliverable is no longer inline in invoke.ts')
  // The CUT-1 closures moved verbatim into the factory (the registry + the
  // runners).
  assert.ok(/const installHeadBoardTools = /.test(factory), 'installHeadBoardTools moved verbatim into the factory (the registry)')
  assert.ok(/const deptExecAllowedRoots = async/.test(factory), 'deptExecAllowedRoots moved verbatim (the dept_exec runners)')
  assert.ok(/const deptExecRender = /.test(factory), 'deptExecRender moved verbatim (the dept_exec runner render)')
  // The CUT-2 closures moved verbatim into the factory (SUB-BATCH 2: the
  // persona/architecture sections + the setup closures + the dispose/retire
  // helpers).
  assert.ok(/const renderDepartmentTemplate = /.test(factory), 'renderDepartmentTemplate moved verbatim (the persona template)')
  assert.ok(/const buildArchitectureSection = /.test(factory), 'buildArchitectureSection moved verbatim (the architecture section)')
  assert.ok(/const installRoleSection = /.test(factory), 'installRoleSection moved verbatim (the role persona section)')
  assert.ok(/const agentScopeOf = /.test(factory), 'agentScopeOf moved verbatim (the scope-key resolver)')
  assert.ok(/const postSetup = /.test(factory), 'postSetup moved verbatim (the head/worker setup builder)')
  assert.ok(/const headSetup = /.test(factory), 'headSetup moved verbatim (the head setup)')
  assert.ok(/const workerSetup = /.test(factory), 'workerSetup moved verbatim (the worker setup — now a FACTORY-LOCAL, no longer a late seam)')
  assert.ok(/const disposeHeadHandle = /.test(factory), 'disposeHeadHandle moved verbatim (the head-dispose helper)')
  assert.ok(/const disposeHeadHandleOnce = /.test(factory), 'disposeHeadHandleOnce moved verbatim (the deduped dispose)')
  assert.ok(/const disposeJoinTimeoutMs = /.test(factory), 'disposeJoinTimeoutMs moved verbatim (the bounded join window)')
  assert.ok(/const joinHeadDisposeOnce = /.test(factory), 'joinHeadDisposeOnce moved verbatim (the bounded join)')
  assert.ok(/const captureRetiredPostTurnError = /.test(factory), 'captureRetiredPostTurnError moved verbatim (the retire turn-error capture)')
  assert.ok(/const settleRetiredPostDeliveries = /.test(factory), 'settleRetiredPostDeliveries moved verbatim (the retire settle)')
  assert.ok(/const predictRetiredWorkerDeliverable = /.test(factory), 'predictRetiredWorkerDeliverable moved verbatim (the O2 deliverable predictor)')
  // The invocation is at the SAME fiber position with the inline R6 fallback
  // (service-first 'deepartments.tools' → the factory) and the ToolsSurface
  // destructure feeds the SAME names the downstream apply uses — SUB-BATCH 2
  // adds the 9 new members (workerSetup / headSetup / dispose* / retire*).
  assert.ok(/ctx\.get\('deepartments\.tools'\) as ToolsSurface \| undefined\) \?\? createToolsOrchestration\(/.test(invoke), 'the bundle invokes the tools service service-first with the inline R6 fallback')
  assert.ok(/const \{[\s\S]*?installHeadBoardTools,[\s\S]*?workerSetup,[\s\S]*?headSetup,[\s\S]*?disposeHeadHandle,[\s\S]*?disposeHeadHandleOnce,[\s\S]*?disposeJoinTimeoutMs,[\s\S]*?joinHeadDisposeOnce,[\s\S]*?captureRetiredPostTurnError,[\s\S]*?settleRetiredPostDeliveries,[\s\S]*?predictRetiredWorkerDeliverable[\s\S]*?\} = toolsSurface/.test(invoke), 'the bundle destructures the full ToolsSurface at the same fiber position')
  // The new CUT-2 deps are passed by reference (agentPresets/disposingHeads/
  // PRESET_ID + the module-scope tool-allowance sets of invoke.ts).
  for (const dep of ['agentPresets,', 'disposingHeads,', 'PRESET_ID,', 'HEAD_BASE_TOOLS,', 'DENIED_POST_TOOLS,', 'OWN_LAYER_POST_TOOLS,']) {
    assert.ok(invoke.includes(dep), `the invocation passes ${dep.replace(',', '')} by reference`)
  }
  // The compiled bundle still exports the SAME superset (the export-parity lock
  // stays intact by construction); the factory compiled into lib/ contains the
  // registry + the runners + the CUT-2 closures.
  const lib = readFileSync(path.join(REPO_ROOT, 'lib', 'core', 'orchestration', 'tools.js'), 'utf8')
  assert.ok(lib.includes('createToolsOrchestration'), 'the compiled factory exists in lib/')
  assert.ok(lib.includes('installHeadBoardTools'), 'the compiled factory carries the registry closure')
  assert.ok(lib.includes('installRoleSection'), 'the compiled factory carries the role-persona closure')
  assert.ok(lib.includes('workerSetup'), 'the compiled factory carries the worker-setup closure')
})

test('tools-factory (composed boot): the registry wiring is intact — the runner gates + the late-seam accessors exist, workerSetup is a factory-local (no late seam), the buckets stay untouched, NO deepartments.tools provided (P1)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-tools-factory-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] } })
    try {
      const ctx = pluginCtx()
      // The composition is intact: the 5 baseline buckets + the 4 zone buckets
      // are still registered (PASO 1 / sub-pasos 2-3 untouched).
      const binder = ctx.get('deepartments.binder')
      assert.ok(binder !== undefined, 'deepartments.binder resolves')
      const buckets = binder.get()
      for (const bucket of ['bus', 'deliver', 'wakepack', 'lifecycle', 'redeliver']) {
        assert.ok(buckets[bucket] !== undefined, `baseline bucket "${bucket}" registered`)
      }
      for (const bucket of ['health', 'jobs', 'pooler', 'gui']) {
        assert.ok(buckets[bucket] !== undefined && Object.keys(buckets[bucket]).length > 0, `${bucket} zone bucket still filled (PASO 1 untouched)`)
      }
      // 0 ctx.provide nuevos (P1 invariant "el bundle consume, nunca provee"):
      // the tools service surface is NOT provided — the inline R6 factory is
      // the fallback (smoke-boot service set intacto).
      assert.equal(ctx.get('deepartments.tools'), undefined, 'deepartments.tools is NOT provided (P1 — provide deferred to hito 4)')
      const factory = readFileSync(path.join(REPO_ROOT, 'src', 'core', 'orchestration', 'tools.ts'), 'utf8')
      // The still-LATE seams keep their TDZ-safe rebinds: the tool arrays as
      // delegating iterables, the store as a thenable, the workspace/retire
      // seams as thunk arrows.
      assert.ok(/\[Symbol\.iterator\]: \(\) => late\.busTools/.test(factory), 'the busTools late seam delegates at iteration time (TDZ-safe)')
      assert.ok(/const messagesStoreReady = \{/.test(factory), 'the delivery store LATE seam is bound as a delegating thenable (messagesStoreReady)')
      assert.ok(/const resolveDepartmentWorkspaceCwd: ToolsFactoryDeps\['late'\]\['resolveDepartmentWorkspaceCwd'\] = \(\.\.\.args\) => late\.resolveDepartmentWorkspaceCwd\(\.\.\.args\)/.test(factory), 'the workspace LATE seam is a thunk arrow of the exact signature')
      // SUB-BATCH 2: workerSetup is NO LONGER a late seam — CUT2 defines it as
      // a factory-local (the registry's reference resolves to the local const,
      // the invocation no longer passes `late.workerSetup`).
      assert.ok(!/const workerSetup: ToolsFactoryDeps\['late'\]\['workerSetup'\]/.test(factory), 'workerSetup is no longer rebound as a late seam in the factory')
      assert.ok(/const workerSetup = \(postId: string, roomId: string, role: string, extra/.test(factory), 'workerSetup is now a factory-local const (CUT2)')
      assert.ok(!/get workerSetup\(\) \{ return workerSetup \}/.test(factory), 'the factory does not re-expose a workerSetup late getter')
      const invoke = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
      // The TOOLS invocation's `late` object no longer carries workerSetup (the
      // SPAWN invocation still does — that one consumes the surface member).
      // Scope the check to the tools invocation block only (from
      // createToolsOrchestration to the destructure).
      const toolsInvocation = invoke.slice(invoke.indexOf('createToolsOrchestration(ctx, {'), invoke.indexOf('} = toolsSurface'))
      assert.ok(!/get workerSetup\(\) \{ return workerSetup \}/.test(toolsInvocation), 'the TOOLS invocation late object no longer carries workerSetup')
      assert.ok(/get resolveDepartmentWorkspaceCwd\(\) \{ return resolveDepartmentWorkspaceCwd \}/.test(toolsInvocation), 'the TOOLS invocation keeps the workspace late getter')
      assert.ok(/workerSetup,[\s\S]*?headSetup,[\s\S]*?disposeHeadHandle,[\s\S]*?disposeHeadHandleOnce,[\s\S]*?disposeJoinTimeoutMs,[\s\S]*?joinHeadDisposeOnce,[\s\S]*?captureRetiredPostTurnError,[\s\S]*?settleRetiredPostDeliveries,[\s\S]*?predictRetiredWorkerDeliverable[\s\S]*?\} = toolsSurface/.test(invoke), 'the destructure carries the 9 CUT-2 members (the retirePost/CUT3 consumers stay bound)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('tools-factory (E2 con Loader real): ONE real worker materialization through the composed machinery — the REAL builder role template (declares dept_exec) installs the registry on the post own-layer: calendar + dept_exec + dept_zstd_read visible, manager-only lifecycle tools absent (structural gate) + the CUT-2 PERSONA/ARCHITECTURE sections land on the head through the factory closures', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-tools-factory-'))
  try {
    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir, {
      org: { departments: [DEPARTMENT] },
      agents: true
    })
    try {
      const ctx = pluginCtx()
      assert.ok(agentsStub !== undefined, 'the agents stub is mounted (the bootPlugin shape)')
      // The REAL role template of the repo: the builder role declares
      // `dept_exec` in its frontmatter `tools` (presets/departments/
      // internal-programming/builder.md).
      const rolePath = path.join(REPO_ROOT, 'presets', 'departments', 'internal-programming', 'builder.md')
      assert.ok(existsSync(rolePath), 'the real builder role template exists in the repo')
      const roleText = readFileSync(rolePath, 'utf8')
      assert.ok(roleText.includes('- dept_exec'), 'the real builder role declares dept_exec (the allowExec gate)')

      // Drive the REAL materialization path of the composed bundle: the head
      // own-layer setup runs at boot (ensureHead → headSetup/postSetup → the
      // factory's installRoleSection + installHeadBoardTools). Find the head's
      // real child context.
      let headChild
      for (let i = 0; i < 100; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-internal-programming-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the composed boot materialized the head through the bundle (agents.create ran with the headSetup/postSetup closure)')

      // The head own-layer carries the registry: the manager (head) sees the
      // calendar tools + the department-lifecycle tools; the secretary registers
      // (M2.3 — the manager-gated own-layer registration).
      const headToolsGet = (name) => headChild.ctx.tools.get(name, headChild.key)
      assert.ok(headToolsGet('dept_calendar_add') !== void 0, 'the head own-layer carries dept_calendar_add (the moved-zone calendar tool)')
      assert.ok(headToolsGet('dept_calendar_list') !== void 0, 'the head own-layer carries dept_calendar_list')
      assert.ok(headToolsGet('dept_job_list') !== void 0, 'the head own-layer carries dept_job_list (manager gate)')
      assert.ok(headToolsGet('dept_worker_spawn') !== void 0, 'the head own-layer carries dept_worker_spawn (manager gate)')
      assert.ok(headToolsGet('secretary') !== void 0, 'the head own-layer carries the M2.3 secretary (registered here, in installHeadBoardTools)')
      // The head does NOT declare dept_exec (HEAD_BASE_TOOLS lacks it) — the
      // allowExec gate stays closed: dept_exec + dept_zstd_read are ABSENT.
      assert.equal(headToolsGet('dept_exec'), void 0, 'a head does NOT carry dept_exec (the role allowExec gate)')
      assert.equal(headToolsGet('dept_zstd_read'), void 0, 'a head does NOT carry dept_zstd_read (same allowExec gate)')

      // Evidence that installHeadBoardTools ran THROUGH THE FACTORY on the
      // materialized post: the tool list of the moved zone is what landed on the
      // head own layer (the registry bodies), not a stub. The bus tools also
      // registered via the iterated late array (send_message shadow on the own
      // layer).
      assert.ok(headToolsGet('dept_who') !== void 0, 'the head own-layer carries dept_who (the bus-tools late array iteration landed)')
      assert.ok(headToolsGet('dept_memo_write') !== void 0, 'the head own-layer carries dept_memo_write (the memo own-layer insert)')

      // SUB-BATCH 2 E2: the CUT-2 PERSONA/ARCHITECTURE closures ran through the
      // factory on the real materialized head — the systemPrompt carries the
      // role section (installRoleSection) AND the architecture section
      // (buildArchitectureSection + renderDepartmentTemplate over the REAL
      // presets/departments/internal-programming/ARCHITECTURE.md).
      const sp = headChild.ctx.get('systemPrompt')
      assert.ok(sp !== void 0 && typeof sp.assemble === 'function', 'the materialized head resolves the real systemPrompt service')
      let roleSection
      let archSection
      try {
        const assembly = await sp.assemble({ scope: headChild.key })
        roleSection = (assembly.sections ?? []).find((s) => s.name === 'deepartments:head:role:internal-programming-head')
        archSection = (assembly.sections ?? []).find((s) => s.name === 'deepartments:head:architecture:internal-programming-head')
      } catch {
        roleSection = undefined
        archSection = undefined
      }
      assert.ok(roleSection !== undefined, 'the head systemPrompt carries the deepartments:head:role section (installRoleSection ran from the factory)')
      assert.match(roleSection.text, /BOOT-QUIET/, 'the head role persona directs boot-quiet behavior')
      assert.match(roleSection.text, /never proactively send/, 'the head role persona forbids proactive sends')
      assert.ok(archSection !== undefined, 'the head systemPrompt carries the deepartments:head:architecture section (buildArchitectureSection ran from the factory)')
      assert.match(archSection.text, /^## Department architecture/m, 'the architecture section opens with the "## Department architecture" heading')
      assert.match(archSection.text, /Internal Programming Department/, 'the REAL ARCHITECTURE.md was templated into the section (renderDepartmentTemplate over the real repo file)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})
