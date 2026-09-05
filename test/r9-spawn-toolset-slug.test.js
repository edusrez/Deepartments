// dsh-deepartments — R9 SPAWN-TOOLSET-SLUG test (LANE R9: «spawn NO degrada
// toolset silenciosamente + slugs retirados»). Reproduces + locks the round's
// fixes on the REAL Loader composition (the r5-dx-guards smokeBoot pattern —
// StubAgents RUNS the real postSetup/installHeadBoardTools on a real scoped
// child context, so the RESULT toolset is the REAL derivation):
//
//   - fb-29/fb-35 — a spawn whose materialization DEGRADES its toolset (a
//     declared capability tool ABSENT from the RESULT while the environment
//     serves it) is now REFUSED LOUDLY at the spawn seam (spawn.ts
//     assertWorkerToolsetResult, R9): the created agent is disposed, nothing
//     is registered/delivered — a worker is NEVER spawned silently-mutilated /
//     messaging-only (the builder-7 double-mount + q-i-6 empty-toolset
//     incidents). Hermetic fixture: the audit channel ON + the harness
//     capability tools registered as globals (the r5/invoke stubGlobalTool
//     pattern) → with the FULL declared set the spawn lands the complete
//     toolset (file tools PRESENTES on the live scope); with a PARTIAL env
//     (a declared tool NOT registered) the RESULT != declared → the guard
//     throws and nothing durable is written.
//   - fb-121 — the worker slug dedup ALSO counts the DURABLE RETIRED ARCHIVE
//     (`posts-retired-archive.jsonl` — the never-erased ledger the A3/C2 prune
//     + O4 retire annex rows feed): a slug retired (even pruned from
//     posts.json/byPost) is NEVER returned — «a registered (even retired) slug
//     is never reused» (the doc convention is the law; the q-i-4/q-i-5/
//     reviewer-2 reused-slug incidents).
//
// Cases: (i) spawn interrumpido → fail-loud o toolset completo (nunca mutilado
// silencioso); (ii) el toolset real del worker == el declarado del preset
// (quality-inspector: file tools PRESENTES); (iii) slug retirado → spawn
// devuelve -2 (nunca el slug base reutilizado); (iv) slug live → base sin
// dedup; (v) un ANALYZE-type misión con file tools ejecutable (durable entry
// carries the declared tools).
//
// Hermetic: temp stateDir; the smokeBoot composition of r5-dx-guards; the
// toolset-audit channel is ENABLED for this file (the RESULT oracle the R9
// guard reads); dispose clears effects.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const TOOLSET_AUDIT_FLAG_ENV = 'DEEPARTMENTS_TOOLSET_AUDIT'

// The R9 guard reads the toolset-audit RESULT oracle — ENABLE the channel for
// this file (the hermetic suite default is '0'; this fixture restores the
// r5-dx-guards style real derivation).
const toolsetAuditPrior = process.env[TOOLSET_AUDIT_FLAG_ENV]
process.env[TOOLSET_AUDIT_FLAG_ENV] = '1'

/** Stub webServer/webRuntime/connection so the bundle's RPC mount effect runs
 * (the r5-dx-guards pattern). */
class StubWebServer extends Service {
  constructor(ctx) { super(ctx, 'webServer'); this.routes = [] }
  register(route) { this.routes.push(route); return () => {} }
}
class StubWebRuntime extends Service {
  constructor(ctx) { super(ctx, 'webRuntime'); this.trustedHosts = [] }
}
class StubConnection extends Service {
  constructor(ctx) { super(ctx, 'connection'); this.trustedHosts = [] }
}

/** An agents service that MATERIALIZES a REAL scoped cordis child context and
 * RUNS the postSetup setup closure (the r5-dx-guards pattern) — so
 * installHeadBoardTools + the F10 restrict ACTUALLY execute and the worker /
 * head own-layer registrations land. */
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

/** F10 stub for a harness global capability tool (the invoke.test.js pattern):
 * a declared tool a hermetic composition must inherit registers here BEFORE the
 * restricted spawn so postSetup's probe sees it. */
function stubGlobalTool(name) {
  return defineTool({
    name,
    description: `F10 stub for global tool "${name}"`,
    parameters: { input: { type: 'string', description: 'stub input' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `${name}: ok` }]
    },
    async execute() { return {} }
  })
}

/** The REAL Loader composition of the dev-profile subset (dshd-core + the 6 P1
 * packages + dshd-orchestration + the bundle, in order) — the r5-dx-guards
 * smokeBoot pattern. `globalTools` = the harness capability names to register
 * on the root AFTER boot (a LATER materialization sees them in its restrict
 * allow-list — exactly the live harness). */
async function smokeBoot(stateDir, { org = { departments: [] }, globalTools = [] } = {}) {
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
  new StubAgents(root)
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const agentsStub = root.get('agents')
  agentsStub.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  for (const name of globalTools) {
    if (root.tools.get(name) === undefined) root.tools.register(stubGlobalTool(name))
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

/** The department the boot materializes — the REAL quality department whose
 * role template is the R9 quality-inspector case. */
const DEPARTMENT = {
  id: 'quality',
  name: 'Quality',
  roomId: 'room-qd',
  coordinator: { postId: 'quality-head' }
}

/** The FULL harness capability set the quality-inspector role declares
 * (read/write/glob/grep/web_search/web_fetch — the inherited plane; the
 * own-layer board tools are always registered by installHeadBoardTools). */
const QUALITY_INSPECTOR_CAPABILITIES = ['read', 'write', 'glob', 'grep', 'web_search', 'web_fetch']

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('R9 (fb-29/35, real Loader): un spawn cuyo RESULT != lo declarado se RECHAZA en voz alta — el env parcial (una tool declarada NO registrada) dispara el guard y nada durable se escribe; el env completo (toolset completo) materializa con file tools PRESENTES', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-r9-toolset-'))
  try {
    // PARTIAL env: register every declared capability EXCEPT `edit` (builder
    // declares edit — the dropped tool must trigger the R9 RESULT guard).
    const partial = QUALITY_INSPECTOR_CAPABILITIES.filter((n) => n !== 'grep')
    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, globalTools: partial })
    try {
      let headChild
      for (let i = 0; i < 160; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-quality-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the boot materialized the quality head (the E2 requires the real installHeadBoardTools)')
      const spawnTool = headChild.ctx.tools.get('dept_worker_spawn', headChild.key)
      assert.ok(spawnTool !== void 0, 'the head own-layer carries dept_worker_spawn')
      // The RESULT guard fires: the template declares [read,write,glob,grep,...
      // web_search,web_fetch] and the audit proves the env serves capability
      // tools (the head probe has allowCount>0) BUT grep is missing from the
      // RESULT allow-list → the materialized worker is REFUSED loudly; the
      // created agent is disposed; nothing durable is written.
      await assert.rejects(
        () => spawnTool.execute({ role: 'quality-inspector', task: 'R9 partial-env e2' }, { agent: headChild.agent }),
        /DEGRADED toolset/,
        'the partial-env spawn rejects loudly (RESULT != declared — the R9 guard, fb-29/35: never a silently-mutilated worker)'
      )
      // NO durable worker row (the guard ran BEFORE registerEntry).
      await new Promise((r) => setTimeout(r, 100))
      const postsText = existsSync(path.join(stateDir, 'posts.json')) ? readFileSync(path.join(stateDir, 'posts.json'), 'utf8') : ''
      assert.ok(!/provider.*worker/.test(postsText), 'the refused spawn registered NO durable worker (nothing is delivered)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
  // FULL env → the toolset completo branch: every declared capability lands.
  const stateDir2 = await mkdtemp(path.join(tmpdir(), 'deepartments-r9-toolset-'))
  try {
    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir2, { org: { departments: [DEPARTMENT] }, globalTools: QUALITY_INSPECTOR_CAPABILITIES })
    try {
      let headChild
      for (let i = 0; i < 160; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-quality-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the boot materialized the quality head (full-env fixture)')
      const spawnTool = headChild.ctx.tools.get('dept_worker_spawn', headChild.key)
      const res = await spawnTool.execute({ role: 'quality-inspector', task: 'R9 full-env e2' }, { agent: headChild.agent })
      const workerId = res.workerId ?? res.postId
      let workerChild
      for (let i = 0; i < 100; i++) {
        workerChild = agentsStub.childContexts.find((c) => String(c.agent.id).includes(String(workerId)))
        if (workerChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(workerChild !== undefined, 'the full-env worker materialized')
      // (ii) — the REAL toolset == the DECLARED preset tools: the worker scope
      // carries the file tools (read/write/glob/grep/web_search/web_fetch —
      // PRESENTES on the live scope, exactly the fb-35 requirement).
      for (const name of QUALITY_INSPECTOR_CAPABILITIES) {
        assert.ok(workerChild.ctx.tools.get(name, workerChild.key) !== void 0, `the spawned worker scope carries "${name}" (file tools PRESENTES — toolset real == declarado)`)
      }
      // (v) — the durable entry carries the DECLARED tools (the cold
      // re-materialization fast-path): the ANALYZE-type mission is executable.
      const postsAfter = JSON.parse(readFileSync(path.join(stateDir2, 'posts.json'), 'utf8'))
      const workerEntry = Object.values(postsAfter).find((e) => e?.provider === 'worker' && String(e.sessionId).includes(workerId.split('-').slice(0, 2).join('-')) || (e?.sessionId ?? '') === res.sessionId)
      const workerRow = Object.entries(postsAfter).find(([, e]) => e?.provider === 'worker' && (e.sessionId === res.sessionId))
      assert.ok(workerRow !== undefined, 'the durable worker row exists')
      const [workerPostId, workerDurable] = workerRow
      assert.equal(workerPostId, workerId, 'the durable postId equals the returned workerId')
      assert.ok(Array.isArray(workerDurable.tools), 'the durable entry carries the tools field (VALLE-B fast-path)')
      for (const name of QUALITY_INSPECTOR_CAPABILITIES) {
        assert.ok(workerDurable.tools.includes(name), `the durable entry carries the declared tool "${name}"`)
      }
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir2, { recursive: true, force: true })
  }
})

test('R9 (fb-121, real Loader): un slug RETIRADO (en el archive durable — incluso pruned de posts.json) NUNCA es reutilizado — spawn devuelve -2; un slug libre devuelve la base sin dedup', async () => {
  // (iii) — a RETIRED slug: the durable retired archive holds the base slug
  // (`posts-retired-archive.jsonl` — NO byPost entry: the A3/C2-pruned class
  // the fb-121 incidents showed). The R9 dedup reads the archive → the base is
  // taken → the spawn returns `quality-inspector-2` (never the base reused).
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-r9-slug-'))
  try {
    await writeFile(
      path.join(stateDir, 'posts-retired-archive.jsonl'),
      `${JSON.stringify({ postId: 'quality-inspector', entry: { sessionId: 'worker-quality-inspector-old', roomId: 'room-qd', agentPreset: 'deepartments-worker', provider: 'worker', role: 'quality-inspector', departmentId: 'quality' }, prunedAt: 1788523010205 })}\n`,
      'utf8'
    )
    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, globalTools: QUALITY_INSPECTOR_CAPABILITIES })
    try {
      let headChild
      for (let i = 0; i < 160; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-quality-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the boot materialized the quality head (retired-slug fixture)')
      const spawnTool = headChild.ctx.tools.get('dept_worker_spawn', headChild.key)
      const res = await spawnTool.execute({ role: 'quality-inspector', task: 'R9 retired-slug e2' }, { agent: headChild.agent })
      assert.equal(res.workerId ?? res.postId, 'quality-inspector-2', 'the retired base slug is NEVER reused — the spawn returns -2 (fb-121: «a registered (even retired) slug is never reused»)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
  // (iv) — NO retired/no live: the base slug is returned WITHOUT dedup.
  const stateDir2 = await mkdtemp(path.join(tmpdir(), 'deepartments-r9-slug-'))
  try {
    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir2, { org: { departments: [DEPARTMENT] }, globalTools: QUALITY_INSPECTOR_CAPABILITIES })
    try {
      let headChild
      for (let i = 0; i < 160; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-quality-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the boot materialized the quality head (free-slug fixture)')
      const spawnTool = headChild.ctx.tools.get('dept_worker_spawn', headChild.key)
      const res = await spawnTool.execute({ role: 'quality-inspector', task: 'R9 free-slug e2' }, { agent: headChild.agent })
      assert.equal(res.workerId ?? res.postId, 'quality-inspector', 'a FREE base slug is returned as-is (no dedup suffix)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir2, { recursive: true, force: true })
  }
})