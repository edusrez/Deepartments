// dsh-deepartments — BOOT-FACTORY test (HITO 3 DECOUPLING, ZONA 7 — the 5th and
// LAST orchestration factory; the HITO 3 closure). Locks the ZONA 7 artifacts +
// wiring:
//   - the ARTIFACT: the BOOT zone of applyInvoke (src/invoke.ts 2344-3021 =
//     678 LOCs region: the applyInvoke opener line 2344 stays in invoke.ts as
//     the coordinator-block opener — byte-identical, exactly like the presets
//     cut kept the B3-note seam; the 677 content LOCs 2345-3021 — the optional
//     continuation services + the SHARED CONFIG SOURCE + the durable catalog
//     registry + the per-head/host live maps + the C1/C3 catalog machinery +
//     the R1 lifecycle tool builders + the host registry surface + the
//     Feature-A presence state + the cold-load promises + the boot web-UI
//     cleanup + the host attach-repair hooks) were hoisted VERBATIM into
//     src/core/orchestration/boot.ts and are invoked by the bundle at the SAME
//     fiber position (createBootOrchestration → BootSurface, MOVEMENT-ONLY —
//     the embedded zone is byte-identical to HEAD 2345-3021, md5 stamp
//     82761e5d…; NO movement deviation D1 is needed — the boot zone carries no
//     module-position-dependent expression, unlike the presets repoRoot).
//   - the COMPOSITION: the factory consumes the invoke.ts module-scope pure
//     helpers BY REFERENCE (readPresenceStateFile / writePresenceStateFile /
//     askUserGuardReason / pinHostSessionTitle) + `config`; the three LATE
//     seams (coordinatorForPost from the presets factory, lifecycle from the
//     delivery factory, retirePost from the tools factory — all built AFTER
//     this factory) pass as TDZ-safe getters over the apply-scope bindings and
//     are rebound as delegating locals (the buildCatalogRows / memo+ sleepTool
//     + postRetireTool executes dereference them only at CALL time, post-boot);
//     the 5 baseline Binder buckets + the zone buckets untouched; the surface
//     rebinds the 40 members the rest of applyInvoke reads (presets/spawn/
//     tools/delivery factories + the daemons) at the SAME positions.
//   - the E2 with the REAL Loader: the composed boot wiring materializes the
//     REAL registry (deepartments.catalog service-first) + hosts + presence —
//     a REAL fabricated hosts.json/posts.json + presence.json under the temp
//     stateDir are loaded through the factory's cold-load promises and surface
//     in the bundle's buildCatalogRows (driven through the COMPOSED dept_who /
//     deploy echo machinery — NOT tautological).
// Hermetic: temp stateDir; dispose clears effects.
import { execFileSync } from 'node:child_process'
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createScope } from '@deepseek-ai/dsh-scope'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

/** The REAL Loader composition of the dev-profile subset (dshd-core + the 6 P1
 * packages + the bundle, in order) — the bootPlugin pattern (clone of the
 * presets-factory smokeBoot). */
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
      session: { events: [] },
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

// --- the department the boot wiring drives (the REAL repo tree owns roles). --
const DEPARTMENT = {
  id: 'internal-programming',
  name: 'Internal Programming',
  roomId: 'room-ipd',
  coordinator: { postId: 'internal-programming-head' }
}

test('boot-factory: the BOOT ZONE (config source + registry + catalog + lifecycle tools + presence + boot hooks) was hoisted VERBATIM into the orchestration factory (the artifact + the movement lock)', () => {
  const factory = readFileSync(path.join(REPO_ROOT, 'src', 'core', 'orchestration', 'boot.ts'), 'utf8')
  const invoke = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
  // The artifact: the factory module exports the typed orchestration surface.
  assert.ok(factory.includes('export function createBootOrchestration('), 'factory exports createBootOrchestration')
  assert.ok(factory.includes('export interface BootFactoryDeps'), 'factory exports BootFactoryDeps')
  assert.ok(factory.includes('export interface BootSurface'), 'factory exports BootSurface')
  // The movement: the bundle imports the factory ...
  assert.ok(invoke.includes("from './core/orchestration/boot.js'"), 'invoke.ts imports the factory')
  // ... and NO LONGER defines the boot-zone closures inline (they live in the
  // factory) — the config-source/registry closures:
  for (const pat of [
    "const coreOrg = ctx.get('deepartments.org')",
    'const registry = (ctx.get(\'deepartments.catalog\')',
    'const resolveQualityWorkerInspectProbability = resolveQualityWorkerInspectProbability(config)',
    'const byHeadHandle = new Map<string, AgentHandleLike>()',
    'const serializeHeadRecovery = <T>',
    'const wakePackInjected = new Set<string>()',
    'const deferredSleepReplace = new Map<string, string>()',
    'const repairHostWorkspaceAttach = async',
    'const runPendingWebUiCleanups = async',
    'const buildCatalogRows = (): CatalogRow[]',
    'const memoWriteTool = (hostPlane: boolean) => defineTool(',
    'const postRetireTool = defineTool(',
    'const presenceCache: PresenceState = readPresenceStateFile(stateDir)',
    'const notifyHostPresence = (present: boolean): void',
    'const registryLoaded = registry.loadPosts()',
    'const hostsLoaded = registry.loadHosts'
  ]) {
    assert.ok(!invoke.includes(pat), `boot-zone closure no longer inline in invoke.ts: ${pat}`)
  }
  // ... and the closure bodies moved verbatim into the factory:
  for (const pat of [
    'const repairHostWorkspaceAttach = async',
    'const runPendingWebUiCleanups = async',
    'const buildCatalogRows = (): CatalogRow[]',
    'const memoWriteTool = (hostPlane: boolean) => defineTool(',
    'const savePresence = async (state: PresenceState)',
    'const notifyHostPresence = (present: boolean): void'
  ]) {
    assert.ok(factory.includes(pat), `boot-zone closure moved verbatim into the factory: ${pat}`)
  }
  // MOVEMENT-ONLY byte-identity: the embedded zone (from the first content line
  // `  // --- optional continuation services...` through the B3 cutover note
  // `  // (messages-store.ts + deliverBusRecord) is the only emit/delivery
  // path.`) equals HEAD applyInvoke 2345-3021 byte-identical (NO D1 — the boot
  // zone has no module-position-dependent expression; md5 stamp 82761e5d…).
  {
    const first = factory.indexOf('  // --- optional continuation services')
    const last = factory.indexOf('  // (messages-store.ts + deliverBusRecord) is the only emit/delivery path.')
    assert.ok(first !== -1 && last !== -1 && last > first, 'the factory embeds the boot zone (continuation services → B3 cutover note)')
    const zoneText = factory.slice(first, last + '  // (messages-store.ts + deliverBusRecord) is the only emit/delivery path.'.length) + '\n'
    assert.equal(zoneText.split('\n').length - 1, 677, 'the embedded boot zone is exactly 677 content LOCs (of the 678-LOC region 2344-3021 — the applyInvoke opener line 2344 stays in invoke.ts as the coordinator-block opener)')
    const md5 = createHash('md5').update(zoneText, 'utf8').digest('hex')
    assert.equal(md5, '82761e5d46541d675185ed6d2b27a6a3', 'the embedded boot zone is byte-identical to HEAD applyInvoke 2345-3021 (md5 82761e5d… — no D1)')
    // The md5 stamp above is the movement identity: md5 of applyInvoke 2345-3021
    // of HEAD b9e51c2 (pre-cut, 3913-line blob; the opener line 2344 stays in
    // invoke.ts as the coordinator-block opener). The 2344-3021 region no longer
    // exists in HEAD f28c719+ (post-cut, 3324 lines) — provenance is held by the
    // FIXED stamp (presets-factory pattern), never by a live git region anchor.
  }
  // The invocation is at the SAME fiber position with the inline R6 fallback
  // (service-first 'deepartments.boot' → the factory), the 5 direct deps by
  // reference (config + 4 invoke.ts module-scope pure helpers) and the THREE
  // late-seam getters:
  assert.ok(/ctx\.get\('deepartments\.boot'\) as BootSurface \| undefined\) \?\? createBootOrchestration\(/.test(invoke), 'the bundle invokes the boot service service-first with the inline R6 fallback')
  for (const dep of ['config,', 'readPresenceStateFile,', 'writePresenceStateFile,', 'askUserGuardReason,', 'pinHostSessionTitle,']) {
    assert.ok(invoke.includes(dep), `the invocation passes ${dep.replace(',', '')} by reference`)
  }
  assert.ok(/get coordinatorForPost\(\) \{ return coordinatorForPost \}/.test(invoke), 'the invocation passes the coordinatorForPost LATE getter (over the apply-scope presets-surface binding)')
  assert.ok(/get lifecycle\(\) \{ return lifecycle \}/.test(invoke), 'the invocation passes the lifecycle LATE getter (over the apply-scope delivery-surface binding)')
  assert.ok(/get retirePost\(\) \{ return retirePost \}/.test(invoke), 'the invocation passes the retirePost LATE getter (over the apply-scope tools-surface binding)')
  // The bundle destructures the full BootSurface at the same fiber position
  // (40 members — the presets/spawn/tools/delivery factories + the daemons
  // read the SAME bindings):
  assert.ok(/const \{[\s\S]*?subagents,[\s\S]*?agents,[\s\S]*?agentPresets,[\s\S]*?stateDir,[\s\S]*?org,[\s\S]*?registry,[\s\S]*?byPost,[\s\S]*?qualityWorkerInspectProbability,[\s\S]*?byChild,[\s\S]*?byHeadHandle,[\s\S]*?disposingHeads,[\s\S]*?headProgress,[\s\S]*?serializeHeadRecovery,[\s\S]*?wakePackInjected,[\s\S]*?deferredSleepReplace,[\s\S]*?hosts,[\s\S]*?hostForSession,[\s\S]*?buildCatalogRows,[\s\S]*?activeCatalogMembers,[\s\S]*?activeMembersSchema,[\s\S]*?renderActiveRoster,[\s\S]*?memoWriteTool,[\s\S]*?sleepTool,[\s\S]*?postRetireTool,[\s\S]*?persistHosts,[\s\S]*?ensureHost,[\s\S]*?hostIdForSession,[\s\S]*?persistPosts,[\s\S]*?registerEntry,[\s\S]*?postIdForChild,[\s\S]*?presenceCache,[\s\S]*?refreshPresence,[\s\S]*?savePresence,[\s\S]*?notifyHostPresence,[\s\S]*?registryLoaded,[\s\S]*?hostsLoaded,[\s\S]*?HOST_ATTACH_REPAIR_RETRY_MS,[\s\S]*?HOST_ATTACH_REPAIR_TIMEOUT_MS,[\s\S]*?repairHostWorkspaceAttach[\s\S]*?\} = bootSurface/.test(invoke), 'the bundle destructures the full BootSurface at the same fiber position (40 members)')
  // The compiled bundle still exports the SAME superset; the factory compiled
  // into lib/ contains the zone closures (ZONA 7).
  const lib = readFileSync(path.join(REPO_ROOT, 'lib', 'core', 'orchestration', 'boot.js'), 'utf8')
  assert.ok(lib.includes('createBootOrchestration'), 'the compiled factory exists in lib/')
  assert.ok(lib.includes('const repairHostWorkspaceAttach'), 'the compiled factory carries the host attach-repair closure')
  assert.ok(lib.includes('const buildCatalogRows'), 'the compiled factory carries the C1/C3 catalog builder')
  assert.ok(lib.includes('const memoWriteTool'), 'the compiled factory carries the R1 memo tool builder')
  assert.ok(lib.includes('const presenceCache'), 'the compiled factory carries the presence cache')
})

test('boot-factory (composed boot): the wiring is intact — the 5 deps pass by reference, the 3 late-seam getters exist, the 9 Binder buckets register from the bundle, NO deepartments.boot provided (P1), the factory locals stay internal', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-boot-factory-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] } })
    try {
      const ctx = pluginCtx()
      // The composition is intact: the 5 baseline buckets + the 4 zone buckets
      // are still registered (the tools factory's binder.register untouched):
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
      // the boot service surface is NOT provided — the inline R6 factory is
      // the fallback (smoke-boot service set intacto).
      assert.equal(ctx.get('deepartments.boot'), undefined, 'deepartments.boot is NOT provided (P1 — provide deferred to hito 4)')
      // The factory-locals stay internal: the SURFACE RETURN block does NOT
      // leak coreOrg/cfg/headRecoveryQueues/CatalogRow/runPendingWebUiCleanups.
      const factory = readFileSync(path.join(REPO_ROOT, 'src', 'core', 'orchestration', 'boot.ts'), 'utf8')
      const surfaceReturn = factory.slice(factory.indexOf('SURFACE RETURN'))
      for (const local of ['coreOrg,', 'cfg,', 'headRecoveryQueues,', 'CatalogRow,', 'runPendingWebUiCleanups,']) {
        assert.ok(!surfaceReturn.includes(local), `factory-local ${local} is not a surface member`)
      }
      // The THREE late-seam delegating rebinds exist in the factory (the
      // spawn.ts workerSetup pattern), typed from the deps:
      assert.ok(/const coordinatorForPost: BootFactoryDeps\['late'\]\['coordinatorForPost'\] = \(\.\.\.args\) => late\.coordinatorForPost\(\.\.\.args\)/.test(factory), 'the factory rebinds coordinatorForPost as a delegating local over the late getter')
      assert.ok(/const retirePost: BootFactoryDeps\['late'\]\['retirePost'\] = \(\.\.\.args\) => late\.retirePost\(\.\.\.args\)/.test(factory), 'the factory rebinds retirePost as a delegating local over the late getter')
      assert.ok(/const lifecycle: BootFactoryDeps\['late'\]\['lifecycle'\] = \{[\s\S]*?memoWrite: \(\.\.\.args\) => late\.lifecycle\.memoWrite\(\.\.\.args\)/.test(factory), 'the factory rebinds lifecycle as a delegating local object over the late getter')
      const invoke = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
      // The invocation `late` carries EXACTLY 3 getters (the 3 boot-zone
      // call-time seams).
      const invocation = invoke.slice(invoke.indexOf('createBootOrchestration(ctx, {'), invoke.indexOf('} = bootSurface'))
      const lateStart = invocation.indexOf('late: {')
      let lateDepth = 1
      let k = lateStart + 'late: {'.length
      for (; k < invocation.length && lateDepth > 0; k++) {
        if (invocation[k] === '{') lateDepth++
        else if (invocation[k] === '}') lateDepth--
      }
      const lateBody = invocation.slice(lateStart, k)
      const getterCount = (lateBody.match(/get [A-Za-z_$][\w$]*\(\) \{ return/g) ?? []).length
      assert.equal(getterCount, 3, `the BOOT invocation late object carries exactly 3 getters (coordinatorForPost/lifecycle/retirePost — found ${getterCount})`)
      assert.ok(/get coordinatorForPost\(\) \{ return coordinatorForPost \}/.test(lateBody), 'getter 1 is coordinatorForPost (over the apply-scope presets-surface binding)')
      assert.ok(/get lifecycle\(\) \{ return lifecycle \}/.test(lateBody), 'getter 2 is lifecycle (over the apply-scope delivery-surface binding)')
      assert.ok(/get retirePost\(\) \{ return retirePost \}/.test(lateBody), 'getter 3 is retirePost (over the apply-scope tools-surface binding)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('boot-factory (E2 con Loader real): the composed boot wiring materializes the REAL registry + hosts + presence (fabricated durable files load through the factory cold-load promises and surface in the bundle catalog builder — NOT tautological)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-boot-e2-'))
  const dshHome = path.join(stateDir, 'dsh-home')
  const prevDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    // Fabricate the DURABLE registry + presence BEFORE boot: the factory's
    // cold-load promises (registry.loadHosts + readPresenceStateFile) must
    // materialize these into the bundle's live catalog. The RegistryStore
    // loadHosts only accepts DETERMINISTIC host ids (`host-<sessionId>`, the
    // derived-identity contract — a fabricated id that is NOT `host-<its own
    // sessionId>` is rejected by the loader's filter), so the entries follow
    // that exact shape. TWO live hosts so the boot repair hook
    // (repairHostWorkspaceAttach — exactly-one-required) short-circuits
    // instead of retrying its 10s attach loop; NO fabricated posts.json (a
    // fabricated post head would race a boot reconcile — the configured
    // department head materialization is exercised instead, the presets-factory
    // E2 shape).
    const fabricatedHost = {
      hostId: 'host-session-boot-e2-host',
      sessionId: 'session-boot-e2-host',
      roomId: 'board',
      retired: false,
      sleepEpoch: undefined
    }
    const fabricatedHost2 = {
      hostId: 'host-session-boot-e2-host-2',
      sessionId: 'session-boot-e2-host-2',
      roomId: 'board',
      retired: false,
      sleepEpoch: undefined
    }
    writeFileSync(path.join(stateDir, 'hosts.json'), JSON.stringify({ [fabricatedHost.hostId]: fabricatedHost, [fabricatedHost2.hostId]: fabricatedHost2 }, null, 2))
    writeFileSync(path.join(stateDir, 'presence.json'), JSON.stringify({ present: true, updatedAt: Date.now() }, null, 2))

    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir, {
      org: { departments: [DEPARTMENT] },
      agents: true
    })
    try {
      const ctx = pluginCtx()

      // (1) REGISTRY materialized REAL: the bundle consumed the dshd-core
      // catalog service service-first (deepartments.catalog) — NOT the in-
      // bundle fallback constructor — and the boot factory's cold-load
      // promises loaded the FABRICATED hosts.json into the SAME live registry
      // the downstream factories read.
      const catalog = ctx.get('deepartments.catalog')
      assert.ok(catalog !== undefined, 'deepartments.catalog resolves (dshd-core service — the boot factory consumed it service-first)')
      // The cold-load promise (registry.loadHosts) resolves asynchronously
      // after apply() — poll for the fabricated entries (bounded).
      let hostsLoaded = false
      for (let i = 0; i < 80; i++) {
        if (catalog.hosts.size === 2 && catalog.hosts.get('host-session-boot-e2-host')?.sessionId === 'session-boot-e2-host') { hostsLoaded = true; break }
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(hostsLoaded, 'the FABRICATED host entries materialized into the live catalog (registry.loadHosts ran through the boot factory)')
      assert.equal(catalog.hosts.size, 2, 'BOTH fabricated host entries loaded (the boot repair hook sees 2 → short-circuits)')

      // (2) the boot C1/C3 catalog machinery surfaces the SAME materialized
      // rows (driven through the composed machinery, NOT tautological): the
      // globally-registered dept_who tool executes the boot-surface
      // buildCatalogRows closure — the REAL C1/C3 builder ran over the LIVE
      // loaded hosts/byPost maps and the FABRICATED host rows appear in the
      // result (kind 'host', title 'Asistente' — the builder's host branch).
      const whoTool = ctx.tools.get('dept_who')
      assert.ok(whoTool !== undefined, 'dept_who registered globally (host plane — the tools factory registered it reading the destructured buildCatalogRows)')
      const whoAgent = { id: 'session-dept-who-caller', status: 'running', session: { events: [] }, followup() {}, cancel() {}, whenIdle: async () => {} }
      // `scope: 'all'` — the fabricated hosts have no live agent (offline
      // state) and the DEFAULT active view hides non-you offline rows; the all
      // view surfaces them so the built rows are observable.
      const who = await whoTool.execute({ scope: 'all' }, { agent: whoAgent, signal: new AbortController().signal })
      assert.equal(who.retiredCount, 0, 'dept_who executed (no retired rows)')
      const hostRows = who.members.filter((m) => m.kind === 'host')
      assert.ok(hostRows.some((m) => m.agentId === 'host-session-boot-e2-host') && hostRows.some((m) => m.agentId === 'host-session-boot-e2-host-2'), 'the FABRICATED host rows surface in the REAL dept_who execution (the C1/C3 buildCatalogRows ran over the loaded hosts map)')

      // (3) PRESENCE materialized REAL: the bundle's presence/set dispatch
      // (the composition carries the boot-factory savePresence closure through
      // the gui endpointDeps) persists a REAL presence.json on disk.
      const guiService = ctx.get('deepartments.gui')
      assert.ok(guiService !== undefined, 'the composed deepartments.gui service resolves')
      const set = await guiService.dispatch('presence/set', { present: false })
      assert.ok(set.ok === true, 'presence/set dispatches through the composed gui service (the boot-factory savePresence closure)')
      const onDisk = JSON.parse(readFileSync(path.join(stateDir, 'presence.json'), 'utf8'))
      assert.equal(onDisk.present, false, 'the REAL presence.json persisted the dispatched value (savePresence ran from the boot factory through the composition)')
      const get = await guiService.dispatch('presence/get', {})
      assert.ok(get.ok === true && get.value?.present === false, 'presence/get reads the persisted value (the boot-factory presenceCache/refreshPresence closure)')

      // (4) the head materialization STILL runs through the boot wiring (the
      // ensureHead/headSetup closures consume the boot-surface bindings —
      // agentPresets/disposingHeads/byHeadHandle): a REAL head child is
      // materialized with its own-layer tools.
      assert.ok(agentsStub !== undefined, 'the agents stub is mounted (the bootPlugin shape)')
      let headChild
      for (let i = 0; i < 100; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-internal-programming-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the embedded CUT3 boot wiring materialized the configured head through the bundle (agents.create ran with the ensureHead/headSetup closure)')
      // Wait for the head OWN-LAYER setup to COMPLETE (the board tools
      // registered) — this also waits out the ensureAllHeads tail (the
      // materializeHeadPreset fs writes + the agents.create await) so no async
      // boot activity outlives the test (the presets-factory E2 waits the same
      // way by executing the memo tool after finding the child).
      let headTools = false
      for (let i = 0; i < 100; i++) {
        try {
          if (headChild.ctx.tools.get('dept_memo_write', headChild.key) !== undefined) { headTools = true; break }
        } catch { /* not registered yet */ }
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headTools, 'the head own-layer carries dept_memo_write (installHeadBoardTools completed)')
      // (5) the R1 lifecycle tool builders execute REAL through the boot-
      // factory surface: dept_memo_write on the head own-layer runs the
      // boot-factory memoWriteTool → the LATE lifecycle seam (delivery) → a
      // REAL journal file (the boot wiring consumed seam-first, post-boot).
      const memoTool = headChild.ctx.tools.get('dept_memo_write', headChild.key)
      const memoResult = await memoTool.execute(
        { summary: 'boot-factory E2: memo write through the composed boot wiring', decisions: [], constraints: [], openItems: [] },
        { agent: headChild.agent }
      )
      assert.ok(memoResult !== null && typeof memoResult === 'object' && typeof memoResult.memoPath === 'string', 'dept_memo_write returned a memoPath (the boot-factory memoWriteTool executed)')
      assert.ok(existsSync(path.join(stateDir, 'journals', 'internal-programming-head.md')), 'the REAL journal file exists at <stateDir>/journals/<memberId>.md (the memoWriteTool → lifecycle late seam path)')
      // Quiesce the fire-and-forget boot chain (ensureAllHeads' tail + the
      // boot checks) BEFORE dispose: wait until no further head create lands
      // and a quiet window passes, so no async activity outlives the test.
      const creates = () => (agentsStub?.createCalls ?? []).length
      const createdBaseline = creates()
      await new Promise((r) => setTimeout(r, 400))
      assert.equal(creates(), createdBaseline, 'no further head create landed after the boot materialization (the boot chain quiesced)')
      // The OTHER fire-and-forget boot checks (redeliverPendingDeliveries,
      // runDurableRegistryReconciliation, the web-ui cleanup + attach-repair
      // hostsLoaded.then kicks) still run in the background — give them a
      // generous quiescence window too (the presets-factory E2's longer body
      // effectively did the same).
      await new Promise((r) => setTimeout(r, 800))
    } finally {
      dispose()
      await new Promise((r) => setTimeout(r, 150))
    }
  } finally {
    if (prevDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHome
    await rm(stateDir, { recursive: true, force: true })
  }
})