// dsh-deepartments — PRESETS-FACTORY test (HITO 3 DECOUPLING, SUB-PASO 6: the
// LAST zone before boot — the presets/journal/wake-pack zone as an orchestration
// factory). Locks the SUB-PASO 6 artifacts + wiring:
//   - the ARTIFACT: the presets zone of applyInvoke (src/invoke.ts 3022-3919 =
//     898 LOCs: per-head preset materialization Batch 1a/4a + journal/archive
//     Task T1 + the coordinator/department resolvers + the W8-d wake-pack
//     assembly) was hoisted VERBATIM into src/core/orchestration/presets.ts and
//     is invoked by the bundle at the SAME fiber position
//     (createPresetsOrchestration → PresetsSurface, MOVEMENT-ONLY — the
//     embedded zone is byte-identical to HEAD with the ONE documented movement
//     deviation D1: the `repoRoot` initializer is module-position-dependent
//     (the factory compiles to lib/core/orchestration/, THREE levels under the
//     repo root — the same identically-valued expression with three '..');
//     invoke.ts = minimal hunks: import + invocation + destructure).
//   - the COMPOSITION: the factory consumes the boot-zone closures BY
//     REFERENCE (config/stateDir/org/agents/byPost/hosts + the module-scope
//     helpers) + the DeliverySurface `messagesStoreReady` LATE (a getter over
//     the apply-scope binding, dereferenced only at CALL time post-boot — the
//     factory rebinds it as a delegating THENABLE); the 5 baseline Binder
//     buckets + the 4 zone buckets untouched; the surface rebinds the 20
//     members the rest of applyInvoke reads (spawn/tools/delivery factories,
//     the daemons, the agent/pre-step registration) at the SAME positions.
//   - the E2 with the REAL Loader: journal T1 (a REAL dept_memo_write lands a
//     REAL journal file + T1 archive), a REAL W8-d wake-pack assembly (the
//     binder wakepack bucket's assembleHeartbeat executes against the LIVE
//     composed machinery), and the REAL per-head preset materialization (the
//     CUT3 boot wiring drives materializeHeadPreset for the configured
//     department → the REAL preset files exist under the harness-home user root
//     of the temp DSH_HOME) — driven through the bundle's OWN materialize path,
//     no hand-built deps (NOT tautological).
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
 * awaits `setup?.(ctx)`), so the CUT3 ensureHead/headSetup and the CUT1
 * installHeadBoardTools actually execute on the post's OWN tool layer. */
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
    const childKey = Symbol('stub-child-scope')
    const scope = createScope(this.scopeAnchor, childKey)
    const childCtx = scope.ctx.extend({ agent })
    agent.ctx = childCtx
    this.childContexts.push({ ctx: childCtx, key: childKey, agent })
    const provision = await options.setup?.(childCtx)
    provision?.commit?.()
    this.store.set(sessionId, agent)
    return { agent, dispose: async () => { this.store.delete(sessionId) } }
  }
  async resume(options) {
    return this.create({ ...options, sessionId: options.resumeSessionId })
  }
}

/** Minimal agentPresets stub (resolve/mount) — the PRESENCE of the service in
 * the composition lets the CUT3 BOOT WIRING run the REAL materializePreset /
 * materializeHeadPreset closures (writes under the temp DSH_HOME user root). */
class StubAgentPresets extends Service {
  constructor(ctx) {
    super(ctx, 'agentPresets')
    this.mounts = []
  }
  async resolve(id) { return { id } }
  async mount(agentCtx, id) { this.mounts.push(id); return () => {} }
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
  new StubAgentPresets(root)
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
  if (agentsStub !== undefined) {
    agentsStub.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  }
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return {
    root,
    loader,
    pluginCtx,
    agentsStub,
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

test('presets-factory: the PRESETS ZONE (per-head presets + journal T1 + wake-pack W8-d) was hoisted VERBATIM into the orchestration factory (the artifact + the movement lock)', () => {
  const factory = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'presets.ts'), 'utf8')
  const bridge = readFileSync(path.join(REPO_ROOT, 'src', 'core', 'orchestration', 'presets.ts'), 'utf8')
  const invoke = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
  // The artifact: the factory module exports the typed orchestration surface.
  assert.ok(factory.includes('export function createPresetsOrchestration('), 'factory exports createPresetsOrchestration')
  assert.ok(factory.includes('export interface PresetsFactoryDeps'), 'factory exports PresetsFactoryDeps')
  assert.ok(factory.includes('export interface PresetsSurface'), 'factory exports PresetsSurface')
  // LANE 0.2.2: src/core/orchestration/presets.ts is the NOMINAL re-export
  // bridge to dshd-orchestration (R6 drop-in superset).
  assert.ok(bridge.includes("from 'dshd-orchestration'"), 'the bridge re-exports from dshd-orchestration')
  assert.ok(bridge.includes('createPresetsOrchestration'), 'the bridge names createPresetsOrchestration')
  // The movement: the bundle imports the factory ...
  assert.ok(invoke.includes("from './core/orchestration/presets.js'"), 'invoke.ts imports the factory')
  // ... and NO LONGER defines the zone closures inline (they live in the
  // factory) — the per-head preset materialization closures:
  for (const pat of [
    'const PRESET_ID = HEAD_PRESET_BASE_ID',
    'const WORKER_PRESET_ID =',
    'const HOST_AGENT_OPTIONS: AgentOptionsLike',
    'const WORKER_AGENT_OPTIONS: AgentOptionsLike',
    'const repoRoot = path.resolve',
    'const dshHome = (): string',
    'const materializePreset = async',
    'const writePresetFile = async',
    'const materializeHeadPreset = async'
  ]) {
    assert.ok(!invoke.includes(pat), `presets materialization closure no longer inline in invoke.ts: ${pat}`)
  }
  // ... and NO LONGER defines the journal/archive Task T1 closures inline:
  for (const pat of [
    'const journalPathFor = (memberId',
    'const writeJournal = async',
    'const bumpHostSleepCounter = async',
    'const bumpPostSleepCounter = async',
    'const readJournal = async',
    'const captureSessionLog = async',
    'const archiveJournalEntry = async',
    'const truncateText = (text',
    'const deriveIndexEntry = (memberId'
  ]) {
    assert.ok(!invoke.includes(pat), `journal T1 closure no longer inline in invoke.ts: ${pat}`)
  }
  // ... and NO LONGER defines the resolvers + W8-d wake-pack assembly inline:
  for (const pat of [
    'const coordinatorForPost = (postId',
    'const departmentForPost = (postId',
    'const departmentForEntry = (entry',
    'const assembleHeartbeat = (hostId',
    'const wakePackService = (ctx.get',
    'const roleForSessionLive = subagentRoles === undefined'
  ]) {
    assert.ok(!invoke.includes(pat), `resolver/W8-d closure no longer inline in invoke.ts: ${pat}`)
  }
  // THE zone closures moved verbatim into the factory:
  assert.ok(/const materializePreset = async/.test(factory), 'materializePreset moved verbatim into the factory')
  assert.ok(/const materializeHeadPreset = async/.test(factory), 'materializeHeadPreset moved verbatim')
  assert.ok(/const writeJournal = async/.test(factory), 'writeJournal moved verbatim (Task T1)')
  assert.ok(/const readJournal = async/.test(factory), 'readJournal moved verbatim')
  assert.ok(/const wakePackService = \(ctx\.get\('deepartments\.wakepack'\)/.test(factory), 'wakePackService moved verbatim (the W8-d fallback construction)')
  assert.ok(/const assembleHeartbeat = \(hostId: string\): string \| undefined =>/.test(factory), 'assembleHeartbeat moved verbatim (W8-d PART A)')
  assert.ok(/const coordinatorForPost = \(postId: string\): CoordinatorConfig \| undefined =>/.test(factory), 'coordinatorForPost moved verbatim (the F1 resolver)')
  // MOVEMENT-ONLY byte-identity: the embedded zone (banner → wakePackService
  // construction close `})()`) equals HEAD applyInvoke 3022-3919 with the ONE
  // documented movement deviation D1 (`repoRoot` initializer: the factory
  // compiles to lib/core/orchestration/presets.js — THREE levels under the
  // repo root — so the identically-valued expression carries three '..').
  // md5 stamp cd9ce710… = md5(HEAD 3022-3919 with line 3089 replaced).
  // LANE 0.2.3 R4 RE-FREEZE (R2, evidence: the zone diff vs HEAD is EXACTLY
  // ONE line — presets.ts:321 `HOST_AGENT_OPTIONS.model` aligned from
  // 'deepseek-v4-flash-vision-exp' to 'deepseek-v4-flash', the RUNTIME TRUTH
  // verified via the dev --dump-config [the host rows + agent-default-model
  // run flash; the vision-exp literal was stale dead weight]). md5 stamp
  // b624be3c… = md5(HEAD zone with that single literal replaced). The R4
  // org-driven resolution lives OUTSIDE this zone (before the surface
  // return) — no other zone byte changed.
  // Zone md5 RE-FROZE R5 (incident 2026-09-04 — dev :8445 crash-loop):
  // assembleHeartbeat read `session.snapshotEvents()` NON-OPTIONALLY while
  // the host core is still 0.1.1-rc.2 (rc.2 exposes the legacy `events`
  // getter, NOT snapshotEvents) → the W6 heartbeat threw in-tick and killed
  // the dev profile (restart counter 609). The 2 in-span session-log reads
  // are now the DUAL read (`snapshotEvents?.() ?? events`) — md5 8da034dc…
  // → c52556ba3d88a80d5dcb1fda1190ef32 (same span, only the read style).
  // Zone md5 RE-FROZE R7 (LANE OBJETIVE B, 2026-09-04 — the session-surface
  // hardening after the 609-restarts incident): the 2 in-span session-log
  // reads COLLAPSED to the shared dshd-core helper (`getSessionEvents(...)`
  // — the ONE implementation of the dual read) + assembleHeartbeat now ALSO
  // computes the SESSION-SURFACE probe (detectSessionSurface, the decision-2
  // drift gate) and passes it into the heartbeat snapshot (`surface:` — the
  // wake-pack renders the `- session surface:` line). md5 c52556ba… →
  // fdc87116c7ca4f29d9d684ff15574c3d (same span, additive datums).
  {
    const first = factory.indexOf('  // --- department HEADS: FIRST-CLASS ROOT AGENTS (Batch 1a)')
    const last = factory.indexOf("      logger: ctx.logger\n    })\n  })()")
    assert.ok(first !== -1 && last !== -1 && last > first, 'the factory embeds the presets zone (banner → wakePackService construction close)')
    const zoneText = factory.slice(first, last + "      logger: ctx.logger\n    })\n  })()".length) + '\n'
    const md5 = createHash('md5').update(zoneText, 'utf8').digest('hex')
    assert.equal(md5, 'fdc87116c7ca4f29d9d684ff15574c3d', 'the embedded presets zone is byte-identical to HEAD applyInvoke 3022-3919 with the D1 repoRoot deviation, the LANE 0.2.3 R4 one-line HOST literal alignment, the R5 DUAL-read session-surface AND the R7 getSessionEvents-collapse + surface-probe re-freeze (md5 fdc87116…)')
    // The D1 deviation is present and documented: the factory's repoRoot
    // initializer carries THREE '..' (module-position-dependent, identical
    // value — the factory lives 3 levels under the repo root).
    assert.ok(zoneText.includes("new URL('.', import.meta.url)), '..', '..', '..')"), 'the repoRoot initializer carries the D1 three-ups form (identical value at the factory module position)')
    assert.ok(factory.includes('MOVEMENT DEVIATION D1'), 'the factory header documents the D1 movement deviation')
  }
  // The invocation is at the SAME fiber position with the inline R6 fallback
  // (service-first 'deepartments.presets' → the factory) and the 16 direct
  // deps by reference + the ONE late seam getter:
  assert.ok(/ctx\.get\('deepartments\.presets', false\) as PresetsSurface \| undefined\) \?\? createPresetsOrchestration\(/.test(invoke), 'the bundle invokes the presets service service-first (NON-STRICT get — the loader may apply rows concurrently) with the inline R6 fallback')
  for (const dep of ['config,', 'stateDir,', 'org,', 'agents,', 'byPost,', 'hosts,', 'hostIdForSession,', 'refreshPresence,', 'persistHosts,', 'postIdForChild,', 'deferredSleepReplace,', 'wakePackInjected,', 'isUsableAgentOptions,', 'yamlList,', 'computeHostSleepSurfacePlan,', 'readPresenceStateFile,']) {
    assert.ok(invoke.includes(dep), `the invocation passes ${dep.replace(',', '')} by reference`)
  }
  assert.ok(/get messagesStoreReady\(\) \{ return deliverySurface\.messagesStoreReady \}/.test(invoke), 'the invocation passes the messagesStoreReady LATE getter (over the apply-scope deliverySurface binding)')
  // The bundle destructures the full PresetsSurface at the same fiber position
  // (20 members — the spawn/tools/delivery factories + the daemons + the
  // agent/pre-step registration read the SAME bindings):
  assert.ok(/const \{[\s\S]*?HOST_AGENT_OPTIONS,[\s\S]*?PRESET_ID,[\s\S]*?WORKER_AGENT_OPTIONS,[\s\S]*?WORKER_PRESET_ID,[\s\S]*?resolveMaterializeAgentOptions,[\s\S]*?repoRoot,[\s\S]*?dshHome,[\s\S]*?materializePreset,[\s\S]*?materializeHeadPreset,[\s\S]*?journalPathFor,[\s\S]*?writeJournal,[\s\S]*?bumpHostSleepCounter,[\s\S]*?bumpPostSleepCounter,[\s\S]*?readJournal,[\s\S]*?coordinatorForPost,[\s\S]*?departmentForPost,[\s\S]*?departmentForEntry,[\s\S]*?assembleHeartbeat,[\s\S]*?roleForSessionLive,[\s\S]*?wakePackService[\s\S]*?\} = presetsSurface/.test(invoke), 'the bundle destructures the full PresetsSurface at the same fiber position (20 members)')
  // The compiled bundle still exports the SAME superset; the factory compiled
  // into the PACKAGE lib contains the zone closures (SUB-PASO 6).
  const lib = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'lib', 'presets.js'), 'utf8')
  assert.ok(lib.includes('createPresetsOrchestration'), 'the compiled factory exists in the package lib/')
  assert.ok(lib.includes('materializeHeadPreset'), 'the compiled factory carries the per-head preset materialization closure')
  assert.ok(lib.includes('const writeJournal = async'), 'the compiled factory carries the journal T1 closure')
  assert.ok(lib.includes('const wakePackService ='), 'the compiled factory carries the wake-pack construction')
  assert.ok(lib.includes('const assembleHeartbeat ='), 'the compiled factory carries the W8-d heartbeat assembly')
})

test('presets-factory (composed boot): the wiring is intact — the late-seam thenable rebind exists, the 16 deps pass by reference, the DI-by-services BASELINE holders are FILLED + the zone holders resolve (the 9-bucket binder register is DEAD — LANE DI-BY-SERVICES), deepartments.presets PROVIDED by dshd-orchestration (P1 — the package provides, the bundle consumes), the wake-pack/delivery consumers still resolve', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-presets-factory-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] } })
    try {
      const ctx = pluginCtx()
      // The composition is intact: the binder is DEAD — the DI-by-services
      // baseline holders carry the closure sets (LANE DI-BY-SERVICES — the
      // binder-contract lock stays green on the ABSENCE):
      assert.equal(ctx.get('deepartments.binder'), undefined, 'deepartments.binder is GONE (LANE DI-BY-SERVICES)')
      for (const holder of ['lifecycleDeps', 'wakepackDeps', 'busDeps', 'deliverDeps']) {
        const deps = ctx.get(`deepartments.${holder}`)
        assert.ok(deps !== undefined && Object.keys(deps.get()).length > 0, `deepartments.${holder} filled (non-empty)`)
      }
      for (const holder of ['healthDeps', 'jobsDeps', 'poolerDeps', 'guiDeps']) {
        assert.ok(ctx.get(`deepartments.${holder}`) !== undefined, `deepartments.${holder} resolves (PASO 1 untouched)`)
      }
      // 0 ctx.provide nuevos (P1 invariant "el bundle consume, nunca provee"):
      // LANE 0.2.2: the presets SERVICE surface IS provided by the
      // dshd-orchestration package in the dev profile.
      assert.equal(ctx.get('deepartments.presets') === undefined, false, 'deepartments.presets IS provided (LANE 0.2.2 — dshd-orchestration provides the presets service)')
      // The wake-pack deps holder carries assembleHeartbeat + repoRoot (the
      // presets surface members the tools factory registered) — the composed
      // dshd-core wakepack service reads them lazily at use (buildWakePackLazy).
      const wakepackDeps = ctx.get('deepartments.wakepackDeps').get()
      assert.equal(typeof wakepackDeps.assembleHeartbeat, 'function', 'the wakepackDeps holder carries assembleHeartbeat (the presets surface member)')
      assert.equal(typeof wakepackDeps.repoRoot, 'string', 'the wakepackDeps holder carries repoRoot')
      const factory = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'presets.ts'), 'utf8')
      // The LATE seam rebind: the factory binds the DeliverySurface store seam
      // as a delegating THENABLE over the `late` getter (the zone text awaits
      // `messagesStoreReady` as a value — the tools.ts:793 pattern).
      assert.ok(/const messagesStoreReady = \{[\s\S]*?then\(resolve: \(value: MessagesStore\) => unknown, reject: \(reason\?: unknown\) => unknown\) \{[\s\S]*?return late\.messagesStoreReady\.then\(resolve, reject\)[\s\S]*?\} as Promise<MessagesStore>/.test(factory), 'the factory rebinds the messagesStoreReady LATE seam as a delegating thenable over late.messagesStoreReady')
      const invoke = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
      // The invocation `late` carries EXACTLY 1 getter (messagesStoreReady —
      // the ONLY delivery seam the presets zone dereferences at call time).
      // LANE 0.2.2: the deps object lives in the hoisted `presetsDeps` const.
      const invocation = invoke.slice(invoke.indexOf('const presetsDeps: PresetsFactoryDeps = {'), invoke.indexOf('} = presetsSurface'))
      const lateStart = invocation.indexOf('late: {')
      let lateDepth = 1
      let k = lateStart + 'late: {'.length
      for (; k < invocation.length && lateDepth > 0; k++) {
        if (invocation[k] === '{') lateDepth++
        else if (invocation[k] === '}') lateDepth--
      }
      const lateBody = invocation.slice(lateStart, k)
      const getterCount = (lateBody.match(/get [A-Za-z_$][\w$]*\(\) \{ return/g) ?? []).length
      assert.equal(getterCount, 1, `the PRESETS invocation late object carries exactly 1 getter (messagesStoreReady — found ${getterCount})`)
      assert.ok(/get messagesStoreReady\(\) \{ return deliverySurface\.messagesStoreReady \}/.test(lateBody), 'the ONE late getter is messagesStoreReady (over deliverySurface)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('presets-factory (E2 con Loader real): journal Task T1 lands a REAL journal + T1 archive via dept_memo_write, the W8-d wake-pack assembly executes REAL through the binder bucket, and the per-head preset materialization writes REAL preset files under the temp harness-home user root (NOT tautological)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-presets-e2-'))
  const dshHome = path.join(stateDir, 'dsh-home')
  const prevDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir, {
      org: { departments: [DEPARTMENT] },
      agents: true
    })
    try {
      const ctx = pluginCtx()
      assert.ok(agentsStub !== undefined, 'the agents stub is mounted (the bootPlugin shape)')

      // (1) per-head preset materialization REAL: the CUT3 BOOT WIRING inside
      // the tools factory (ensureAllHeads → the agentPresets branch) drives the
      // presets-factory `materializePreset` / `materializeHeadPreset` closures
      // for the configured department — writes the REAL per-head preset files
      // (agent.cordis.yml + preset.yml) into <DSH_HOME>/.agent-presets/…
      let headChild
      for (let i = 0; i < 100; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-internal-programming-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the embedded CUT3 boot wiring materialized the head through the bundle (agents.create ran with the ensureHead/headSetup closure — the CUT3 machine)')
      const presetDir = path.join(dshHome, '.agent-presets', 'deepartments-head-internal-programming')
      assert.ok(existsSync(path.join(presetDir, 'agent.cordis.yml')), 'the REAL per-head preset agent.cordis.yml exists under the temp DSH_HOME user root (materializeHeadPreset ran from the presets factory through the boot wiring)')
      assert.ok(existsSync(path.join(presetDir, 'preset.yml')), 'the REAL per-head preset preset.yml exists (the per-head metadata was written)')
      const composition = readFileSync(path.join(presetDir, 'agent.cordis.yml'), 'utf8')
      assert.match(composition, /You are internal-programming-head, the head of the "Internal Programming" department/, 'the per-head composition carries the per-head role line (buildHeadPresetComposition over the REAL base template)')

      // (2) journal Task T1 REAL: dept_memo_write on the head own-layer
      // executes lifecycle.memoWrite → the presets-factory writeJournal — a
      // REAL journal file at <stateDir>/journals/<memberId>.md with the summary
      // + Task T1 archive/session-log artifacts.
      const memoTool = headChild.ctx.tools.get('dept_memo_write', headChild.key)
      assert.ok(memoTool !== void 0, 'the head own-layer carries dept_memo_write (the CUT1 registry instantiated it on this post)')
      const memoResult = await memoTool.execute(
        { summary: 'presets-factory E2: journal T1 real write through the composed bundle', decisions: ['d1'], constraints: [], openItems: [] },
        { agent: headChild.agent }
      )
      assert.ok(memoResult !== null && typeof memoResult === 'object' && typeof memoResult.memoPath === 'string', 'dept_memo_write returned a memoPath')
      const journalPath = path.join(stateDir, 'journals', 'internal-programming-head.md')
      assert.ok(existsSync(journalPath), 'the REAL journal file exists at <stateDir>/journals/<memberId>.md (writeJournal ran from the presets factory)')
      const journal = readFileSync(journalPath, 'utf8')
      assert.match(journal, /presets-factory E2: journal T1 real write through the composed bundle/, 'the REAL journal carries the summary')
      assert.match(journal, /^wake_counter: 1$/m, 'the REAL journal carries the first-ever wake_counter 1 (writeJournal ordinal semantics)')
      // Task T1 archive: the session archive + search index were appended
      // (best-effort — a stub sessions service makes captureSessionLog degrade
      // to the stub form, the archive append itself is real).
      const archivePath = path.join(stateDir, 'journals', 'archive', 'internal-programming-head.md')
      assert.ok(existsSync(archivePath), 'the REAL T1 archive file exists (<stateDir>/journals/archive/<memberId>.md — archiveJournalEntry ran)')
      const archive = readFileSync(archivePath, 'utf8')
      assert.match(archive, /=== ENTRY ts=/, 'the archive carries the ENTRY delimiter (archiveJournalEntry)')
      const indexPath = path.join(stateDir, 'journals', 'index.json')
      assert.ok(existsSync(indexPath), 'the REAL T1 search index exists (index.json — deriveIndexEntry ran)')

      // (3) wake-pack W8-d REAL: the binder wakepack bucket carries the presets
      // factory's assembleHeartbeat closure (registered by the tools factory) —
      // executing it runs the REAL W8-d PART A assembly against the LIVE
      // composed state (hosts/byPost/agents/stateDir).
      const wakepackDeps = ctx.get('deepartments.wakepackDeps')
      const heartbeat = wakepackDeps.get().assembleHeartbeat('host-presets-e2')
      assert.equal(typeof heartbeat, 'string', 'assembleHeartbeat executed through the composed bundle returns the REAL heartbeat section string (W8-d PART A)')
      assert.match(heartbeat, /\- host: /, 'the REAL heartbeat section carries the host line (buildHeartbeatSection ran)')
      assert.match(heartbeat, /\- interrupted: /, 'the REAL heartbeat section carries the interrupted line (W8-h scan ran)')

      // The wake-pack consumption chain is intact: the composed LISTENER is
      // registered (the bundle kept the agent/pre-step registration reading the
      // destructured wakePackService).
      const wakepackService = ctx.get('deepartments.wakepack')
      assert.ok(wakepackService !== undefined, 'the composed deepartments.wakepack service resolves (the bundle consumed it service-first — R6)')
    } finally {
      dispose()
    }
  } finally {
    if (prevDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHome
    await rm(stateDir, { recursive: true, force: true })
  }
})