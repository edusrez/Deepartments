// dsh-deepartments — TOOLS-FACTORY test (HITO 3 DECOUPLING, SUB-PASO 4,
// SUB-BATCHES 1-3 of 4: the dept_exec/zstd runners + the agent toolset
// REGISTRY (installHeadBoardTools) + the persona/architecture prompt sections
// + postSetup/headSetup/workerSetup + the head-dispose/retire helpers as an
// orchestration factory). Locks the SUB-BATCH 1-3 artifacts + wiring:
//   - the ARTIFACT: the cuts of the tools zone of applyInvoke
//     (src/invoke.ts CUT1 3977-4898 = 922 LOCs, CUT2 4061-4672 = pre-SB1
//     4900-5511 = 612 LOCs, CUT3 4099-5371 = 1273 LOCs incl. the BOOT
//     WIRING) were hoisted VERBATIM into src/core/orchestration/tools.ts and
//     are invoked by the bundle at the SAME fiber position
//     (createToolsOrchestration → ToolsSurface, MOVEMENT-ONLY — byte-identical
//     to HEAD; invoke.ts = minimal hunks: deps + invocation + destructure).
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
//     SUB-BATCH 3 additionally proves the CUT3 boot machinery (the embedded
//     BOOT WIRING drives ensureAllHeads → ensureHead + the CUT3 head-preset
//     materialization + the workspace-cwd resolution through the composed
//     bundle — the factory-local closures run on the REAL materialized head).
// Hermetic: temp stateDir; dispose clears effects.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
      session: { events: [], get seq() { return this.events.length }, snapshotEvents() { return this.events }, requestHeader() { return undefined } },
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
  // LANE 0.2.2 (gap 2): the dev-profile composition now includes the
  // dshd-orchestration package (the 5 factory SERVICES + the deps holders).
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
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

test('tools-factory: the TOOLS ZONE CUTS 1+2+3 were hoisted VERBATIM into the orchestration factory (the artifact + the movement lock)', () => {
  const factory = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts'), 'utf8')
  const bridge = readFileSync(path.join(REPO_ROOT, 'src', 'core', 'orchestration', 'tools.ts'), 'utf8')
  const invoke = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
  // The artifact: the factory module exports the typed orchestration surface.
  assert.ok(factory.includes('export function createToolsOrchestration('), 'factory exports createToolsOrchestration')
  assert.ok(factory.includes('export interface ToolsFactoryDeps'), 'factory exports ToolsFactoryDeps')
  assert.ok(factory.includes('export interface ToolsSurface'), 'factory exports ToolsSurface')
  // LANE 0.2.2: src/core/orchestration/tools.ts is the NOMINAL re-export
  // bridge to dshd-orchestration (R6 drop-in superset).
  assert.ok(bridge.includes("from 'dshd-orchestration'"), 'the bridge re-exports from dshd-orchestration')
  assert.ok(bridge.includes('createToolsOrchestration'), 'the bridge names createToolsOrchestration')
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
  // ... and NO LONGER defines the CUT-3 zone closures inline either (SUB-BATCH
  // 3: the workspace/ensureHead/retire/boot-check closures + the BOOT WIRING
  // moved — including the ghost census machinery the B5-GHOST flake uses).
  for (const name of [
    'retirePost', 'archiveWorkerSession', 'archivePostSessionOnSleep', 'departmentWorkspacePath',
    'ensureDepartmentWorkspace', 'resolveDepartmentWorkspaceCwd', 'resolveWorkspaceRootPath',
    'attachHeadSession', 'rotateArchivedHeadSessionId', 'ensureHead', 'makeEntry', 'ensureAllHeads',
    'headEventCount', 'markHeadProgress', 'isHeadStuck', 'runPresetAudit',
    'runInterruptedPostReconciliation', 'runProviderAdapterBootCheck', 'runReasoningContentBootAssert',
    'runDurableRegistryReconciliation', 'runGhostSuspectReconcile', 'runHalfSleptHeadReconcile',
    'runRetiredWorkerResidueReconcile'
  ]) {
    assert.ok(!new RegExp(`const ${name} = `).test(invoke), `${name} is no longer inline in invoke.ts (CUT3 moved)`)
  }
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
  assert.ok(/const captureRetiredPostTurnError = /.test(factory), 'captureRetiredPostTurnError moved verbatim — now a FACTORY-INTERNAL helper (retirePost consumes the local directly, no surface member)')
  assert.ok(/const settleRetiredPostDeliveries = /.test(factory), 'settleRetiredPostDeliveries moved verbatim (the retire settle, factory-internal)')
  assert.ok(/const predictRetiredWorkerDeliverable = /.test(factory), 'predictRetiredWorkerDeliverable moved verbatim (the O2 deliverable predictor, factory-internal)')
  // The CUT-3 closures moved verbatim into the factory (SUB-BATCH 3: the
  // retire/archive + workspace/ensureHead + the boot checks/reconciles).
  assert.ok(/const retirePost = async \(postId: string, callerAgentId: string(?:, opts\?: \{ deferDisposeMs\?: number \})?\)/.test(factory), 'retirePost moved verbatim (the F1 retire seam — FACTORY-LOCAL now; LANE ② O1 added the optional dispose-grace opts)')
  assert.ok(/const archiveWorkerSession = async/.test(factory), 'archiveWorkerSession moved verbatim (the durable-session archiver)')
  assert.ok(/const archivePostSessionOnSleep = async/.test(factory), 'archivePostSessionOnSleep moved verbatim (the sleep-archive)')
  assert.ok(/const ensureDepartmentWorkspace = async/.test(factory), 'ensureDepartmentWorkspace moved verbatim (the workspace ensure)')
  assert.ok(/const resolveDepartmentWorkspaceCwd = async/.test(factory), 'resolveDepartmentWorkspaceCwd moved verbatim (the dept workspace cwd — FACTORY-LOCAL now)')
  assert.ok(/const resolveWorkspaceRootPath = async/.test(factory), 'resolveWorkspaceRootPath moved verbatim (the shared root — FACTORY-LOCAL now)')
  assert.ok(/const attachHeadSession = async/.test(factory), 'attachHeadSession moved verbatim (the sidebar attach)')
  assert.ok(/const rotateArchivedHeadSessionId = async/.test(factory), 'rotateArchivedHeadSessionId moved verbatim (the archive-leak rotation)')
  assert.ok(/const ensureHead = async \(department: DepartmentConfig, roomId: string\)/.test(factory), 'ensureHead moved verbatim (the head materialization)')
  assert.ok(/const ensureAllHeads = async/.test(factory), 'ensureAllHeads moved verbatim (the boot head-driving)')
  assert.ok(/const runGhostSuspectReconcile = async/.test(factory), 'runGhostSuspectReconcile moved verbatim (the B5-GHOST census)')
  assert.ok(/const runProviderAdapterBootCheck = async/.test(factory), 'runProviderAdapterBootCheck moved verbatim (the NO_ADAPTER boot check)')
  assert.ok(/const runRetiredWorkerResidueReconcile = async/.test(factory), 'runRetiredWorkerResidueReconcile moved verbatim (the Dx1 residue pass)')
  // ... and NO LONGER defines the CUT-4 zone closures inline either (SUB-BATCH
  // 4 — THE LAST: the bus/feedback TOOL DEFINITIONS + the host own-layer/
  // global registrations + the redeliver driver + guiEndpointDeps + the Binder
  // buckets + the scheduler/health builders + the 9 global host-plane tools
  // moved).
  for (const name of ['feedbackTool', 'feedbackListTool', 'feedbackUpdateTool', 'sendMessageTool', 'agentMessagesTool', 'deptWhoTool']) {
    assert.ok(!new RegExp(`const ${name} = `).test(invoke), `${name} is no longer inline in invoke.ts (CUT4 moved)`)
  }
  assert.ok(!/const feedbackEmitTools:/.test(invoke), 'feedbackEmitTools is no longer inline in invoke.ts (CUT4 moved)')
  assert.ok(!/const feedbackHeadTools:/.test(invoke), 'feedbackHeadTools is no longer inline in invoke.ts (CUT4 moved)')
  assert.ok(!/const busTools:/.test(invoke), 'busTools is no longer inline in invoke.ts (CUT4 moved)')
  assert.ok(!/const redeliverPendingDeliveries = /.test(invoke), 'redeliverPendingDeliveries is no longer inline in invoke.ts (CUT4 moved)')
  assert.ok(!/const guiEndpointDeps:/.test(invoke), 'guiEndpointDeps is no longer inline in invoke.ts (CUT4 moved)')
  assert.ok(!/const schedulerRunJob = /.test(invoke), 'the scheduler/health builders are no longer inline in invoke.ts (CUT4 moved)')
  assert.ok(!/const buildHealthPosts = /.test(invoke), 'buildHealthPosts is no longer inline in invoke.ts (CUT4 moved)')
  assert.ok(!/binder\?\.register\(/.test(invoke), 'the binder.register call is no longer inline in invoke.ts (CUT4 moved)')
  for (const name of ['globalWakeSnapshot', 'globalRetire', 'globalMemo', 'globalSleep', 'globalSleepAll', 'globalHeadRotate', 'globalFeedback', 'globalFeedbackList', 'globalFeedbackUpdate']) {
    assert.ok(!new RegExp(`const ${name} = `).test(invoke), `${name} is no longer inline in invoke.ts (CUT4 moved)`)
  }
  // The CUT-4 closures moved verbatim into the factory (SUB-BATCH 4: the
  // bus/feedback tools + the arrays + the driver + the buckets + the globals).
  assert.ok(/const feedbackTool = defineTool/.test(factory), 'feedbackTool moved verbatim into the factory (the universal feedback emitter)')
  assert.ok(/const sendMessageTool = defineTool/.test(factory), 'sendMessageTool moved verbatim (the bus send tool)')
  assert.ok(/const feedbackEmitTools: readonly ReturnType<typeof defineTool>\[\] = \[feedbackTool\]/.test(factory), 'feedbackEmitTools moved verbatim (the emit array — now a FACTORY-LOCAL const)')
  assert.ok(/const feedbackHeadTools: readonly ReturnType<typeof defineTool>\[\] = \[feedbackListTool, feedbackUpdateTool\]/.test(factory), 'feedbackHeadTools moved verbatim (the head array — FACTORY-LOCAL)')
  assert.ok(/const busTools: readonly ReturnType<typeof defineTool>\[\] = \[sendMessageTool, agentMessagesTool, deptWhoTool\]/.test(factory), 'busTools moved verbatim (the bus array — FACTORY-LOCAL)')
  assert.ok(/const redeliverPendingDeliveries =/.test(factory), 'redeliverPendingDeliveries moved verbatim (the boot re-delivery driver — FACTORY-LOCAL now)')
  assert.ok(/const guiEndpointDeps: DeepartmentsEndpointDeps = \{/.test(factory), 'guiEndpointDeps moved verbatim (the RPC endpoint deps)')
  assert.ok(!/binder\?\.register\(\{/.test(factory), 'the binder.register call is GONE from the factory (LANE DI-BY-SERVICES — the register died, the closure sets flow into the deps holders)')
  assert.ok(/depsBus\?\.register\(/.test(factory), 'the DI-by-services holder fills are in the factory (busDeps)')
  assert.ok(/depsDeliver\?\.register\(/.test(factory), 'the DI-by-services holder fills are in the factory (deliverDeps)')
  assert.ok(/depsLifecycle\?\.register\(/.test(factory), 'the DI-by-services holder fills are in the factory (lifecycleDeps)')
  assert.ok(/depsWakepack\?\.register\(/.test(factory), 'the DI-by-services holder fills are in the factory (wakepackDeps)')
  assert.ok(/const globalWakeSnapshot = ctx\.tools\.register/.test(factory), 'globalWakeSnapshot moved verbatim (the 9-global host-plane registration block)')
  assert.ok(/const globalHeadRotate = ctx\.tools\.register/.test(factory), 'globalHeadRotate moved verbatim (the head-rotation tool)')
  assert.ok(/, 'deepartments: host-plane tools'\)/.test(factory), 'the host-plane tools disposal ctx.effect moved verbatim (the CUT4 zone closing)')
  // The embedded zone is byte-identical to HEAD applyInvoke except the LANE
  // 0.2.3b REGISTER-LEGACY ELIMINATION — the delta IS the register block: the
  // `const binder = ctx.get('deepartments.binder')` + the `binder?.register`
  // 9-bucket call LEFT the frozen zone (re-homed verbatim right after the
  // zone close, outside the md5 span — see the binder-contract lock, which
  // keeps freezing the SAME bucket contract). Zone md5 RE-FROZE R2:
  // fe319e0f4f0c145081e1e46bf0e9d7b3 → 5b548545a2971a76a79fab0dbff8411d.
  {
    const first = factory.indexOf('  // --- messaging bus TOOL DEFINITIONS (ONE body per tool; registered in the')
    const last = factory.indexOf("  }, 'deepartments: host-plane tools')")
    assert.ok(first !== -1 && last !== -1 && last > first, 'the factory embeds the CUT4 zone (banner → host-plane effect close)')
    const zoneText = factory.slice(first, last + "  }, 'deepartments: host-plane tools')".length) + '\n'
    const md5 = createHash('md5').update(zoneText, 'utf8').digest('hex')
    // Zone md5 RE-FROZE R3 (LANE ②, incident-delivery 2026-09-03): the 4 INTENTIONAL in-span blocks — recipientCatalogAlive reroutable + recipientDormant: isDormantRecipient x2 (redeliverDeps + bus.redeliver) + startRedeliverySweep — re-freeze the hash (R2 fe319e0f… → 5b548545…; LANE ② → 7b5b1c91628b4e69d5ed171cb6d0a7e3; the O1 retirePost dispose-grace is OUTSIDE this span — a different lock).
    assert.equal(md5, '7b5b1c91628b4e69d5ed171cb6d0a7e3', 'the embedded CUT4 zone matches the LANE 0.2.3b re-freeze + the session-surface reads + the LANE ② sweep/O1 additions (md5 7b5b1c91…)')
  }
  // The invocation is at the SAME fiber position with the inline R6 fallback
  // (service-first 'deepartments.tools' → the factory) and the ToolsSurface
  // destructure feeds the SAME names the downstream apply uses — SUB-BATCH 2
  // adds the 9 new members (workerSetup / headSetup / dispose* / retire*);
  // SUB-BATCH 3 adds the 8 CUT3 members the delivery factory + lifecycle
  // consume (the retire helpers left the destructure — retirePost now consumes
  // the factory-locals internally).
  assert.ok(/ctx\.get\('deepartments\.tools', false\) as ToolsSurface \| undefined\) \?\? createToolsOrchestration\(/.test(invoke), 'the bundle invokes the tools service service-first (NON-STRICT get — the loader may apply rows concurrently) with the inline R6 fallback')
  assert.ok(/const \{[\s\S]*?installHeadBoardTools,[\s\S]*?workerSetup,[\s\S]*?headSetup,[\s\S]*?disposeHeadHandle,[\s\S]*?disposeHeadHandleOnce,[\s\S]*?disposeJoinTimeoutMs,[\s\S]*?joinHeadDisposeOnce,[\s\S]*?resolveDepartmentWorkspaceCwd,[\s\S]*?resolveWorkspaceRootPath,[\s\S]*?rotateArchivedHeadSessionId,[\s\S]*?retirePost,[\s\S]*?isHeadStuck,[\s\S]*?markHeadProgress,[\s\S]*?attachHeadSession,[\s\S]*?archivePostSessionOnSleep[\s\S]*?schedulerHeadForDepartment,[\s\S]*?schedulerRunJob,[\s\S]*?schedulerOnAutoRunSkip,[\s\S]*?schedulerNotifyHead,[\s\S]*?schedulerDepartmentForEntry,[\s\S]*?schedulerDepartmentForJob,[\s\S]*?buildHealthPosts,[\s\S]*?buildHostRunning,[\s\S]*?buildSessionContexts,[\s\S]*?buildHostWaits,[\s\S]*?healthNotifyHost,[\s\S]*?healthPoolerStatePath,[\s\S]*?healthBootId,[\s\S]*?guiEndpointDeps[\s\S]*?\} = toolsSurface/.test(invoke), 'the bundle destructures the full ToolsSurface at the same fiber position (29 members — the 15 CUT1-3 + the 14 CUT4: scheduler/health builders + guiEndpointDeps)')
  assert.ok(!/const \{[\s\S]*?captureRetiredPostTurnError,[\s\S]*?settleRetiredPostDeliveries,[\s\S]*?predictRetiredWorkerDeliverable[\s\S]*?\} = toolsSurface/.test(invoke), 'the retire helpers NO LONGER appear in the toolsSurface destructure (factory-internal now)')
  // The new CUT-2 deps are passed by reference (agentPresets/disposingHeads/
  // PRESET_ID + the module-scope tool-allowance sets of invoke.ts).
  for (const dep of ['agentPresets,', 'disposingHeads,', 'PRESET_ID,', 'HEAD_BASE_TOOLS,', 'DENIED_POST_TOOLS,', 'OWN_LAYER_POST_TOOLS,']) {
    assert.ok(invoke.includes(dep), `the invocation passes ${dep.replace(',', '')} by reference`)
  }
  // The CUT-3 deps are passed by reference (all defined BEFORE the factory
  // position or module-scope of invoke.ts — registry, hosts, the workspace
  // materialization closures, the boot promises).
  for (const dep of ['registry,', 'qualityWorkerInspectProbability,', 'headProgress,', 'hosts,', 'HOST_ATTACH_REPAIR_TIMEOUT_MS,', 'HOST_ATTACH_REPAIR_RETRY_MS,', 'HOST_AGENT_OPTIONS,', 'materializePreset,', 'materializeHeadPreset,', 'dshHome,', 'registryLoaded,', 'hostsLoaded,', 'stuckNow,', 'STUCK_HEAD_MS,', 'HEAD_DEFAULT_SESSION_TITLE,']) {
    assert.ok(invoke.includes(dep), `the invocation passes ${dep.replace(',', '')} by reference (CUT3 direct dep)`)
  }
  // The CUT-4 deps are passed by reference (SUB-BATCH 4 — the 27 new direct
  // deps, all defined BEFORE the factory position or module-scope of
  // invoke.ts: the host-plane tool builders + the bus/wakepack/registry/
  // lifecycle closures + the module-scope pure helpers).
  for (const dep of ['sleepTool,', 'subagents,', 'wakePackService,', 'hostIdForSession,', 'readJournal,', 'journalPathFor,', 'refreshPresence,', 'savePresence,', 'notifyHostPresence,', 'presenceCache,', 'assembleHeartbeat,', 'roleForSessionLive,', 'headRotationJournalStatus,', 'verifyRotateReason,', 'resolveSessionProjCachePath,', 'deliverDaemonNotice,', 'captureSchedulerAutoRunFailure,', 'buildCatalogRows,', 'wakePackInjected,', 'deferredSleepReplace,', 'computeHostSleepSurfacePlan,', 'readPresenceStateFile,', 'ensureHost,', 'writeJournal,', 'bumpHostSleepCounter,', 'bumpPostSleepCounter,']) {
    assert.ok(invoke.includes(dep), `the invocation passes ${dep.replace(',', '')} by reference (CUT4 direct dep)`)
  }
  // The compiled bundle still exports the SAME superset (the export-parity lock
  // stays intact by construction); the factory compiled into the PACKAGE lib
  // contains the registry + the runners + the CUT-2 closures + the CUT-3
  // closures + the CUT-4 closures (SUB-BATCH 4).
  const lib = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'lib', 'tools.js'), 'utf8')
  assert.ok(lib.includes('createToolsOrchestration'), 'the compiled factory exists in the package lib/')
  assert.ok(lib.includes('installHeadBoardTools'), 'the compiled factory carries the registry closure')
  assert.ok(lib.includes('installRoleSection'), 'the compiled factory carries the role-persona closure')
  assert.ok(lib.includes('workerSetup'), 'the compiled factory carries the worker-setup closure')
  assert.ok(lib.includes('const retirePost = async'), 'the compiled factory carries the retire closure')
  assert.ok(lib.includes('const ensureHead = async'), 'the compiled factory carries the ensureHead closure')
  assert.ok(lib.includes('const feedbackTool = defineTool'), 'the compiled factory carries the feedback tool (CUT4)')
  assert.ok(lib.includes('const sendMessageTool = defineTool'), 'the compiled factory carries the send_message tool (CUT4)')
  assert.ok(lib.includes('globalWakeSnapshot'), 'the compiled factory carries the 9-global host-plane registrations (CUT4)')
})

test('tools-factory (composed boot): the registry wiring is intact — the runner gates + the late-seam accessors exist, workerSetup + the CUT3 retire/workspace closures + the CUT4 tool arrays/driver are factory-locals (no late seams), the 4 BASELINE deps holders are FILLED by the factory (the dead binder is gone), NO deepartments.tools provided (P1)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-tools-factory-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] } })
    try {
      const ctx = pluginCtx()
      // The composition is intact: the DI-by-services holders carry the
      // factory's closure sets — the `binder?.register` call DIED in LANE
      // DI-BY-SERVICES; the closure sets flow into the 4 baseline holders
      // (the binder-contract lock verifies the ABSENCE).
      assert.equal(ctx.get('deepartments.binder'), undefined, 'deepartments.binder is GONE (LANE DI-BY-SERVICES)')
      for (const holder of ['lifecycleDeps', 'wakepackDeps', 'busDeps', 'deliverDeps']) {
        const deps = ctx.get(`deepartments.${holder}`)
        assert.ok(deps !== undefined, `deepartments.${holder} resolves`)
        assert.ok(Object.keys(deps.get()).length > 0, `deepartments.${holder} filled (non-empty)`)
      }
      for (const holder of ['healthDeps', 'jobsDeps', 'poolerDeps', 'guiDeps']) {
        const deps = ctx.get(`deepartments.${holder}`)
        assert.ok(deps !== undefined, `deepartments.${holder} resolves (PASO 1 untouched)`)
      }
      // 0 ctx.provide nuevos (P1 invariant "el bundle consume, nunca provee"):
      // the tools service surface is NOT provided — the inline R6 factory is
      // the fallback (smoke-boot service set intacto).
      assert.equal(ctx.get('deepartments.tools') === undefined, false, 'deepartments.tools IS provided (LANE 0.2.2 — dshd-orchestration provides the tools service)')
      const factory = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts'), 'utf8')
      // The still-LATE seams keep their TDZ-safe rebinds: the delivery
      // surface's bus/ACL/catalog/delivery/feedback/mint/wake members as thunk
      // arrows + delegating THENABLES (messagesStoreReady / feedbackStoreReady)
      // + a delegating `delivery` object; `messageStoreDir` is a non-late
      // factory-local == stateDir (the delivery factory defines it identically).
      assert.ok(/const messageStoreDir = stateDir/.test(factory), 'messageStoreDir is the factory-local == stateDir (the delivery factory defines it identically — the redeliverDeps build-time deref)')
      assert.ok(/const messagesStoreReady = \{/.test(factory), 'the delivery store LATE seam is bound as a delegating thenable (messagesStoreReady)')
      assert.ok(/const feedbackStoreReady: ToolsFactoryDeps\['late'\]\['feedbackStoreReady'\] = \{/.test(factory), 'the feedback store LATE seam is bound as a delegating thenable (feedbackStoreReady — CUT4)')
      assert.ok(/const delivery: ToolsFactoryDeps\['late'\]\['delivery'\] = \{[\s\S]*?deliverOrQueue: \(\.\.\.args\) => late\.delivery\.deliverOrQueue\(\.\.\.args\)/.test(factory), 'the delivery-engine LATE seam is a delegating object (deliverOrQueue — CUT4)')
      assert.ok(/const busMemberIdFor: ToolsFactoryDeps\['late'\]\['busMemberIdFor'\] = \(agentId\) => late\.busMemberIdFor\(agentId\)/.test(factory), 'the busMemberIdFor LATE seam is a thunk arrow of the exact signature (CUT4)')
      assert.ok(/const busDeliverToPost: ToolsFactoryDeps\['late'\]\['busDeliverToPost'\] = \(\.\.\.args\) => late\.busDeliverToPost\(\.\.\.args\)/.test(factory), 'the busDeliverToPost LATE seam is a thunk arrow (CUT4)')
      assert.ok(/const freshMintHead: ToolsFactoryDeps\['late'\]\['freshMintHead'\] = \(\.\.\.args\) => late\.freshMintHead\(\.\.\.args\)/.test(factory), 'the freshMintHead LATE seam is a thunk arrow (the head-rotate mint — CUT4)')
      assert.ok(/const maybeEmitQualityInspectDirective: ToolsFactoryDeps\['late'\]\['maybeEmitQualityInspectDirective'\] = \(surface\) => late\.maybeEmitQualityInspectDirective\(surface\)/.test(factory), 'the maybeEmitQualityInspectDirective LATE seam is a thunk arrow of the exact signature (the delivery emitter retirePost uses at retire time)')
      // SUB-BATCH 4: the tool arrays + the boot driver are NO LONGER late seams
      // — CUT4 defines them as factory-locals (the CUT1 registry's for..of
      // loops + the CUT3 boot wiring resolve the SAME local consts at call
      // time); the factory has NO iterable-rebind / driver-delegate for them.
      assert.ok(!/\[Symbol\.iterator\]: \(\) => late\.busTools/.test(factory), 'the busTools iterable rebind is GONE — busTools is now a CUT4 factory-local const')
      assert.ok(!/const redeliverPendingDeliveries: ToolsFactoryDeps\['late'\]/.test(factory), 'the redeliverPendingDeliveries late SEAM is GONE — the CUT4 zone defines the driver as a factory-local')
      // SUB-BATCH 2: workerSetup is NO LONGER a late seam — CUT2 defines it as
      // a factory-local (the registry's reference resolves to the local const,
      // the invocation no longer passes `late.workerSetup`).
      assert.ok(!/const workerSetup: ToolsFactoryDeps\['late'\]\['workerSetup'\]/.test(factory), 'workerSetup is no longer rebound as a late seam in the factory')
      assert.ok(/const workerSetup = \(postId: string, roomId: string, role: string, extra/.test(factory), 'workerSetup is now a factory-local const (CUT2)')
      assert.ok(!/get workerSetup\(\) \{ return workerSetup \}/.test(factory), 'the factory does not re-expose a workerSetup late getter')
      // SUB-BATCH 3: the workspace/retire/archive seams are NO LONGER late —
      // CUT3 defines them as factory-locals (resolveDepartmentWorkspaceCwd /
      // resolveWorkspaceRootPath / retirePost / archiveWorkerSession).
      assert.ok(!/const resolveDepartmentWorkspaceCwd: ToolsFactoryDeps\['late'\]/.test(factory), 'resolveDepartmentWorkspaceCwd is no longer rebound as a late seam in the factory')
      assert.ok(!/const resolveWorkspaceRootPath: ToolsFactoryDeps\['late'\]/.test(factory), 'resolveWorkspaceRootPath is no longer rebound as a late seam in the factory')
      assert.ok(!/const retirePost: ToolsFactoryDeps\['late'\]/.test(factory), 'retirePost is no longer rebound as a late seam in the factory')
      assert.ok(!/const archiveWorkerSession: ToolsFactoryDeps\['late'\]/.test(factory), 'archiveWorkerSession is no longer rebound as a late seam in the factory')
      assert.ok(/const resolveDepartmentWorkspaceCwd = async \(department: DepartmentConfig \| undefined\): Promise<string> =>/.test(factory), 'resolveDepartmentWorkspaceCwd is now a factory-local const (CUT3)')
      assert.ok(/const resolveWorkspaceRootPath = async \(\): Promise<string> =>/.test(factory), 'resolveWorkspaceRootPath is now a factory-local const (CUT3)')
      assert.ok(/const retirePost = async \(postId: string, callerAgentId: string(?:, opts\?: \{ deferDisposeMs\?: number \})?\): Promise<\{ postId: string; retired: true \}> =>/.test(factory), 'retirePost is now a factory-local const (CUT3) — LANE ② O1 extended the signature with the optional dispose-GRACE opts (the auto-retire-on-delivery race fix)')
      const invoke = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
      // The TOOLS invocation's `late` object no longer carries workerSetup or
      // the 4 CUT3 seams (the workspace/retire/archive getters are GONE), and
      // carries the 2 NEW delivery late seams.
      const toolsInvocation = invoke.slice(invoke.indexOf('const toolsDeps: ToolsFactoryDeps = {'), invoke.indexOf('} = toolsSurface'))
      assert.ok(!/get workerSetup\(\) \{ return workerSetup \}/.test(toolsInvocation), 'the TOOLS invocation late object no longer carries workerSetup')
      assert.ok(!/get resolveDepartmentWorkspaceCwd\(\) \{/.test(toolsInvocation), 'the TOOLS invocation late object no longer carries the resolveDepartmentWorkspaceCwd getter (CUT3 factory-local)')
      assert.ok(!/get resolveWorkspaceRootPath\(\) \{/.test(toolsInvocation), 'the TOOLS invocation late object no longer carries the resolveWorkspaceRootPath getter (CUT3 factory-local)')
      assert.ok(!/get retirePost\(\) \{ return retirePost \}/.test(toolsInvocation), 'the TOOLS invocation late object no longer carries the retirePost getter (CUT3 factory-local)')
      assert.ok(!/get archiveWorkerSession\(\) \{ return archiveWorkerSession \}/.test(toolsInvocation), 'the TOOLS invocation late object no longer carries the archiveWorkerSession getter (CUT3 factory-local)')
      assert.ok(/get maybeEmitQualityInspectDirective\(\) \{ return maybeEmitQualityInspectDirective \}/.test(toolsInvocation), 'the TOOLS invocation late object carries the maybeEmitQualityInspectDirective getter')
      assert.ok(!/get redeliverPendingDeliveries\(\) \{ return redeliverPendingDeliveries \}/.test(toolsInvocation), 'the TOOLS invocation late object NO LONGER carries the redeliverPendingDeliveries getter (CUT4 factory-local)')
      assert.ok(!/get busTools\(\)/.test(toolsInvocation), 'the TOOLS invocation late object NO LONGER carries the busTools getter (CUT4 factory-local)')
      assert.ok(!/get feedbackEmitTools\(\)/.test(toolsInvocation), 'the TOOLS invocation late object NO LONGER carries the feedbackEmitTools getter (CUT4 factory-local)')
      assert.ok(!/get feedbackHeadTools\(\)/.test(toolsInvocation), 'the TOOLS invocation late object NO LONGER carries the feedbackHeadTools getter (CUT4 factory-local)')
      for (const seam of ['busMemberIdFor', 'feedbackStoreReady', 'resolveQualityHeadEntry', 'feedbackForwarderFor', 'feedbackDeliveryOptions', 'busProfileFor', 'aclDenyGround', 'resolveBusCatalogRoute', 'delivery', 'isDormantRecipient', 'busEnsureHostForCaller', 'assertBusFanOut', 'busDeliverToPost', 'busDeliverToHost', 'resolveBusChild', 'deliverBusChild', 'freshMintHead', 'enqueueHostWake']) {
        assert.ok(new RegExp(`get ${seam}\\(\\) \\{ return deliverySurface\\.${seam} \\}`).test(toolsInvocation), `the TOOLS invocation late object carries the NEW ${seam} getter (CUT4 delivery-surface seam)`)
      }
      // The invocation late object carries EXACTLY the 21 TDZ-safe seams (the
      // 3 kept delivery seams + the 18 CUT4 delivery-surface seams — the 4
      // factory-local seams are gone).
      const lateStart = toolsInvocation.indexOf('late: {')
      let lateDepth = 1
      let k = lateStart + 'late: {'.length
      for (; k < toolsInvocation.length && lateDepth > 0; k++) {
        if (toolsInvocation[k] === '{') lateDepth++
        else if (toolsInvocation[k] === '}') lateDepth--
      }
      const lateBody = toolsInvocation.slice(lateStart, k)
      const getterCount = (lateBody.match(/get [A-Za-z_$][\w$]*\(\) \{ return/g) ?? []).length
      assert.equal(getterCount, 21, `the TOOLS invocation late object carries exactly 21 getters (found ${getterCount})`)
      assert.ok(/workerSetup,[\s\S]*?headSetup,[\s\S]*?disposeHeadHandle,[\s\S]*?disposeHeadHandleOnce,[\s\S]*?disposeJoinTimeoutMs,[\s\S]*?joinHeadDisposeOnce,[\s\S]*?resolveDepartmentWorkspaceCwd,[\s\S]*?resolveWorkspaceRootPath,[\s\S]*?rotateArchivedHeadSessionId,[\s\S]*?retirePost,[\s\S]*?isHeadStuck,[\s\S]*?markHeadProgress,[\s\S]*?attachHeadSession,[\s\S]*?archivePostSessionOnSleep[\s\S]*?schedulerHeadForDepartment,[\s\S]*?schedulerRunJob,[\s\S]*?buildHealthPosts,[\s\S]*?healthBootId,[\s\S]*?guiEndpointDeps[\s\S]*?\} = toolsSurface/.test(invoke), 'the destructure carries the 29 surface members (the 15 CUT1-3 + the 14 CUT4: scheduler/health builders + guiEndpointDeps)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('tools-factory (E2 con Loader real): ONE real worker materialization through the composed machinery — the REAL builder role template (declares dept_exec) installs the registry on the post own-layer: calendar + dept_exec + dept_zstd_read visible, manager-only lifecycle tools absent (structural gate) + the CUT-2 PERSONA/ARCHITECTURE sections land on the head through the factory closures + the CUT-3 workspace/ensureHead machinery (head preset + workspace-cwd resolution) runs through the composed bundle from the embedded BOOT WIRING', async () => {
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
      // own-layer setup runs at boot (the EMBEDDED BOOT WIRING — CUT3's
      // `Promise.all([registryLoaded, hostsLoaded]).then(ensureAllHeads → ensureHead)`
      // inside the factory — drives headSetup/postSetup → the factory's
      // installRoleSection + installHeadBoardTools). Find the head's real child
      // context.
      let headChild
      for (let i = 0; i < 100; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-internal-programming-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the embedded CUT3 boot wiring materialized the head through the bundle (agents.create ran with the ensureHead/headSetup/postSetup closure — the CUT3 machine)')

      // CUT-3 workspace/ensureHead machinery through the composed bundle: the
      // agents.create carried the per-head preset (headPresetIdFor → the
      // materializeHeadPreset'd per-head agentPreset) and the workspace CWD
      // (resolveDepartmentWorkspaceCwd → '' for a department without
      // workspacePath → resolveWorkspaceRootPath → the repoRoot floor, because
      // this composition has NO workspaceRegistry service).
      const headCreate = agentsStub.createCalls.find((c) => String(c.sessionId).includes('head-internal-programming-head'))
      assert.ok(headCreate !== undefined, 'the head create call was recorded')
      assert.equal(headCreate.meta?.agentPreset, 'deepartments-head-internal-programming', 'the head create carried the per-head preset id (headPresetIdFor — the CUT3 ensureHead machinery)')
      assert.equal(headCreate.meta?.cwd, REPO_ROOT, 'the head create carried the resolved workspace root cwd (resolveDepartmentWorkspaceCwd/resolveWorkspaceRootPath — the CUT3 machinery, repoRoot floor with no workspaceRegistry service)')

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

      // SUB-BATCH 4 E2 — the CUT4 machine runs through the composed bundle:
      // (1) the head own-layer carries the CUT4 feedback tool (the registry
      // iterates the FACTORY-LOCAL feedbackEmitTools array) AND a REAL execute
      // of the CUT4 `dept_who` closure runs through the bundle's own seams
      // (busEnsureHostForCaller + buildCatalogRows + the live stub agents —
      // each is the factory's real closure, NOT tautological);
      assert.ok(headToolsGet('dept_feedback') !== void 0, 'the head own-layer carries dept_feedback (the FACTORY-LOCAL feedbackEmitTools array iterated at materialization)')
      const whoTool = headChild.ctx.tools.get('dept_who', headChild.key)
      assert.ok(whoTool !== void 0, 'the head own-layer carries dept_who (the FACTORY-LOCAL busTools array iterated at materialization)')
      const whoResult = await whoTool.execute({}, { agent: headChild.agent })
      assert.ok(typeof whoResult === 'object' && whoResult !== null, 'dept_who executed through the composed bundle returns a payload')
      const whoText = whoResult.snapshot ?? (whoResult.text ?? JSON.stringify(whoResult))
      assert.match(String(whoText), /internal-programming-head/, 'the dept_who real execute resolves the head identity (busEnsureHostForCaller + buildCatalogRows from the factory)')
      // (2) a REAL `dept_feedback` execute appends a durable record to the
      // REAL FeedbackStore at <stateDir>/feedback.jsonl — the CUT4 emitter runs
      // through the composed bundle's late seams (feedbackStoreReady thenable →
      // the real opened store + busMemberIdFor/finalizer renders).
      const fbTool = headChild.ctx.tools.get('dept_feedback', headChild.key)
      const fbResult = await fbTool.execute(
        { tipo: 'mejora', severidad: 'bajo', resumen: 'tools-factory SB4 E2: CUT4 feedback real execute' },
        { agent: headChild.agent }
      )
      assert.ok(typeof fbResult === 'object' && fbResult !== null && typeof fbResult.id === 'string', 'dept_feedback executed through the composed bundle returns the created FeedbackRecord (id included)')
      const fbFile = path.join(stateDir, 'feedback.jsonl')
      assert.ok(existsSync(fbFile), 'the REAL FeedbackStore wrote <stateDir>/feedback.jsonl (feedbackStoreReady late thenable → the real opened store)')
      const fbContent = readFileSync(fbFile, 'utf8')
      assert.match(fbContent, /tools-factory SB4 E2: CUT4 feedback real execute/, 'the durable feedback record carries the real resumen')
      assert.match(fbContent, /internal-programming-head/, 'the durable feedback record carries the real emisor (busMemberIdFor resolved the head postId)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})
