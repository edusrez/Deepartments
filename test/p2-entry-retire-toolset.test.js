// dsh-deepartments — P2-ENTRY test (LANE P2-ENTRY, 2026-09-05): the RETIRE
// DURABLE ENTRY reflects the EFFECTIVE toolset — QD nudge #2 (m-1637 q-i-20),
// class fb-29 («el entry durable del retiro sub-registra dept_zstd_read»).
//
// Context: the retire durable entry — the posts-retired-archive.jsonl row
// `{postId, entry, prunedAt}` that markPostRetired appends (the O4
// RETIRE-ON-DELIVERY ledger) — snapshotted `entry.tools` = the DECLARED
// role-template list (13 for a builder; 12 for a quality-inspector — neither
// carries dept_zstd_read), while the toolset-audit `toolset-final` waypoint
// records the EFFECTIVE toolset (16 incl. dept_zstd_read + the calendar tools
// — the allowExec-gated own-layer dept_zstd_read that a role declaring
// dept_exec lands). The two durable records diverged (13 vs 16).
//
// THE FIX (tools.ts): the retire seam snapshots the EFFECTIVE toolset from the
// STILL-LIVE agent scope right before markPostRetired, using the SAME canonical
// enumeration as the toolset-audit `toolset-final` waypoint
// (EFFECTIVE_TOOLSET_CANDIDATES + enumerateEffectiveToolset — ONE shared
// definition, so the two records can never diverge again). The archive row AND
// the posts.json retired row both carry the effective list; a retire with no
// live-scope oracle (the boot-reconcile reap class) keeps the declared list
// (byte-compatible no-change).
//
// Cases:
//   (i)  a worker with dept_zstd_read in the audit → the retire durable entry
//        lists it (the effective count === the audit toolset-final count);
//   (ii) the seam/guard tools (dept_exec / dept_zstd_read) + the own-layer
//        calendar tools are in the snapshot;
//   (iii) CONTROL — byte-compatible: the row shape stays {postId, entry,
//        prunedAt} (entry.postId stripped); existing archive rows are NEVER
//        rewritten; a retire WITHOUT a live scope (direct RegistryStore — the
//        no-oracle class) keeps the DECLARED tools verbatim.
//
// Hermetic: temp stateDir; the r5-dx-guards / r9 smokeBoot composition (the
// REAL Loader — StubAgents RUNS the real postSetup/installHeadBoardTools on a
// real scoped child context, so the RESULT toolset is the REAL derivation); the
// toolset-audit channel is ENABLED for this file (the hermetic suite default is
// '0'; the audit rows are the same-source oracle the retire snapshot must match).
//
// NOTE (fb-95/r6-ladder-flat): this file does NOT self-register the
// ts-src-loader — the composition loads the BUILT packages through the Loader
// and the unit control imports the BUILT dshd-core registry (the lane-②
// src-native family is an EXPLICIT allow-list in r6-ladder-flat.test.js; a new
// loader self-registerer would trip the meta-guard). Plain `node --test` over
// lib, exactly the canonical ladder.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'

// The RegistryStore of the BUILT dshd-core (the no-live-scope control — the
// direct-store retire class has no agents service, so the snapshot cannot run).
const R = await import('../packages/dshd-core/lib/registry.js')
const { RegistryStore } = R

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const TOOLSET_AUDIT_FLAG_ENV = 'DEEPARTMENTS_TOOLSET_AUDIT'

// The same-source oracle (the toolset-audit rows) must be WRITTEN — enable the
// channel for this file (the hermetic suite default is '0').
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
 * RUNS the postSetup setup closure (the r5-dx-guards pattern). */
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

/** F10 stub for a harness global capability tool (the invoke.test.js pattern). */
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

/** The REAL Loader composition of the dev-profile subset (the r9 smokeBoot
 * pattern). `globalTools` = the harness capability names to register on the
 * root AFTER boot (a LATER materialization sees them in its restrict
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
  return {
    root,
    loader,
    agentsStub,
    dispose: () => loaderFiber.dispose()
  }
}

/** The department the boot materializes — the REAL quality department whose
 * worker role (quality-inspector) is the fb-29 case (12 declared tools incl.
 * dept_exec — the allowExec gate that ALSO lands dept_zstd_read). */
const DEPARTMENT = {
  id: 'quality',
  name: 'Quality',
  roomId: 'room-qd',
  coordinator: { postId: 'quality-head' }
}

/** The FULL harness capability set the quality-inspector role declares. */
const QUALITY_INSPECTOR_CAPABILITIES = ['read', 'write', 'glob', 'grep', 'web_search', 'web_fetch']

/** The quality-inspector template DECLARED tools (verbatim frontmatter —
 * read/write/glob/grep/web_search/web_fetch + the bus/own-layer names +
 * dept_exec + dept_feedback; NO dept_zstd_read, NO calendar tools). */
const DECLARED_QUALITY_INSPECTOR_TOOLS = [
  'read', 'write', 'glob', 'grep', 'web_search', 'web_fetch',
  'send_message', 'agent_messages', 'dept_who', 'dept_memo_write',
  'dept_exec', 'dept_feedback'
]

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function archiveRows(stateDir) {
  const text = readFileSync(path.join(stateDir, 'posts-retired-archive.jsonl'), 'utf8')
  return text.trim().split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l))
}

/** The LAST toolset-audit `toolset-final` row for a postId (the same-source
 * oracle: the effective toolset the audit recorded at spawn). */
function toolsetFinalRow(stateDir, postId) {
  const text = readFileSync(path.join(stateDir, 'toolset-audit.jsonl'), 'utf8')
  let last
  for (const line of text.trim().split('\n').filter((l) => l.length > 0)) {
    const row = JSON.parse(line)
    if (row.wp === 'toolset-final' && row.postId === postId) last = row
  }
  return last
}

// ---------------------------------------------------------------------------
// (i)+(ii) — the RETIRE DURABLE ENTRY reflects the EFFECTIVE toolset: a worker
// whose audit records dept_zstd_read lands dept_zstd_read (AND the seam/guard
// dept_exec + the own-layer calendar tools) in the retire archive row, with the
// SAME count the toolset-final audit recorded (the canonical source).
// ---------------------------------------------------------------------------
test('P2-ENTRY (fb-29 — QD nudge #2): the retire durable entry lists the EFFECTIVE toolset — dept_zstd_read + the seam/guard dept_exec + the calendar tools, count === the toolset-final audit count (the same canonical source)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-p2-entry-'))
  try {
    const { agentsStub, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, globalTools: QUALITY_INSPECTOR_CAPABILITIES })
    try {
      let headChild
      for (let i = 0; i < 160; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-quality-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the boot materialized the quality head')
      const spawnTool = headChild.ctx.tools.get('dept_worker_spawn', headChild.key)
      assert.ok(spawnTool !== void 0, 'the head own-layer carries dept_worker_spawn')
      const res = await spawnTool.execute({ role: 'quality-inspector', task: 'P2-ENTRY e2e' }, { agent: headChild.agent })
      const workerId = res.workerId ?? res.postId
      const sessionId = res.sessionId
      let workerChild
      for (let i = 0; i < 100; i++) {
        workerChild = agentsStub.childContexts.find((c) => String(c.agent.id).includes(String(workerId)))
        if (workerChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(workerChild !== undefined, 'the full-env worker materialized')
      // The DURABLE entry at SPAWN carries the DECLARED list (the pre-fix
      // under-record: NO dept_zstd_read — the exact recorded divergence).
      const postsAfter = JSON.parse(readFileSync(path.join(stateDir, 'posts.json'), 'utf8'))
      const workerRow = Object.entries(postsAfter).find(([, e]) => e?.provider === 'worker' && e.sessionId === sessionId)
      assert.ok(workerRow !== undefined, 'the durable worker row exists')
      const [workerPostId, workerDurable] = workerRow
      assert.equal(workerPostId, workerId, 'the durable postId equals the returned workerId')
      assert.ok(Array.isArray(workerDurable.tools), 'the durable entry carries the tools field')
      assert.deepEqual([...workerDurable.tools].sort(), [...DECLARED_QUALITY_INSPECTOR_TOOLS].sort(), 'the SPAWN durable entry carries the DECLARED template list (12 — NO dept_zstd_read, NO calendar tools)')
      assert.ok(!workerDurable.tools.includes('dept_zstd_read'), 'the DECLARED list does NOT carry dept_zstd_read (the pre-fix under-record)')
      // The audit PROVES the effective toolset — the same-source oracle.
      const finalRow = toolsetFinalRow(stateDir, workerId)
      assert.ok(finalRow !== undefined, 'the toolset-audit toolset-final row exists for the worker')
      assert.ok(finalRow.names.split(',').includes('dept_zstd_read'), 'the audit records dept_zstd_read in the effective toolset (the oracle)')
      const auditCount = finalRow.count
      assert.ok(auditCount > workerDurable.tools.length, `the audit count (${auditCount}) exceeds the declared count (${workerDurable.tools.length}) — the own-layer additions`)
      // RETIRE the worker (the head's dept_worker_retire — the ONE shared
      // retire seam → retirePost → markPostRetired → the archive row).
      const retireTool = headChild.ctx.tools.get('dept_worker_retire', headChild.key)
      assert.ok(retireTool !== void 0, 'the head own-layer carries dept_worker_retire')
      await retireTool.execute({ workerId }, { agent: headChild.agent })
      // The RETIRE DURABLE ENTRY now reflects the EFFECTIVE toolset.
      const rows = archiveRows(stateDir)
      assert.ok(rows.length >= 1, 'the retire appended the archive row')
      const archived = rows[rows.length - 1]
      assert.equal(archived.postId, workerId, 'the retire durable entry inventories the retired worker')
      // (i) dept_zstd_read IS in the retire durable entry (the audit had it).
      assert.ok(Array.isArray(archived.entry.tools), 'the retire durable entry carries the tools field')
      assert.ok(archived.entry.tools.includes('dept_zstd_read'), '(i) dept_zstd_read IS in the retire durable entry — the effective toolset no longer under-records it')
      // (ii) the seam/guard tools + the own-layer calendar tools ride along.
      for (const name of ['dept_exec', 'dept_calendar_add', 'dept_calendar_list', 'dept_calendar_remove']) {
        assert.ok(archived.entry.tools.includes(name), `(ii) the retire durable entry carries the seam/guard tool "${name}"`)
      }
      // The DECLARED list is a SUBSET of the effective snapshot.
      for (const name of DECLARED_QUALITY_INSPECTOR_TOOLS) {
        assert.ok(archived.entry.tools.includes(name), `the effective snapshot is a SUPERSET of the declared tool "${name}"`)
      }
      // (i/final) the count MATCHES the toolset-final audit count — the retire
      // durable entry and the audit record the SAME canonical source.
      assert.equal(archived.entry.tools.length, auditCount, `the retire durable entry count (${archived.entry.tools.length}) === the toolset-final audit count (${auditCount}) — same source, never divergent again`)
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (iii) CONTROL — byte-compatible: the row shape stays {postId, entry,
// prunedAt} (entry.postId stripped, entry.retired true); existing archive rows
// are NEVER rewritten; a retire WITHOUT a live scope (the direct-store /
// boot-reconcile reap class) keeps the DECLARED tools verbatim.
// ---------------------------------------------------------------------------
test('P2-ENTRY CONTROL: the retire durable entry is byte-compatible — the row shape {postId, entry, prunedAt} is UNCHANGED (the fix adds no row fields) and the E2E retire writes nothing extra', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-p2-shape-'))
  try {
    const { agentsStub, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, globalTools: QUALITY_INSPECTOR_CAPABILITIES })
    try {
      let headChild
      for (let i = 0; i < 160; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-quality-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the boot materialized the quality head (shape control)')
      const spawnTool = headChild.ctx.tools.get('dept_worker_spawn', headChild.key)
      const res = await spawnTool.execute({ role: 'quality-inspector', task: 'P2-ENTRY shape' }, { agent: headChild.agent })
      const workerId = res.workerId ?? res.postId
      const retireTool = headChild.ctx.tools.get('dept_worker_retire', headChild.key)
      await retireTool.execute({ workerId }, { agent: headChild.agent })
      const rows = archiveRows(stateDir)
      assert.equal(rows.length, 1, 'the retire appended EXACTLY ONE archive row (the fix adds NO extra write)')
      const archived = rows[0]
      // The R6 durable shape — top-level {postId, entry, prunedAt} ONLY.
      assert.deepEqual(Object.keys(archived).sort(), ['entry', 'postId', 'prunedAt'], 'the row SHAPE is byte-compatible: {postId, entry, prunedAt} — the fix adds no row-level fields')
      assert.equal(archived.entry.postId, undefined, 'the archived entry is the durable shape (postId stripped — the row key carries it, R6)')
      assert.equal(archived.entry.retired, true, 'the archived entry carries the retire mark')
      assert.equal(archived.entry.sessionId, res.sessionId, 'the archived entry is the FULL durable entry')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('P2-ENTRY CONTROL: a retire WITHOUT a live scope (the direct RegistryStore class) keeps the DECLARED tools verbatim and NEVER rewrites existing archive rows', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-p2-nooracle-'))
  try {
    const store = new RegistryStore({ stateDir, logger: { warn() {}, info() {} } })
    // A PRE-EXISTING archive row (a prior retire of another worker).
    const priorRow = { postId: 'w0', entry: { sessionId: 's0', roomId: 'board', agentPreset: 'deepartments-worker', provider: 'worker', role: 'quality-inspector', tools: [...DECLARED_QUALITY_INSPECTOR_TOOLS] }, prunedAt: 1788523010205 }
    await writeFile(path.join(stateDir, 'posts-retired-archive.jsonl'), `${JSON.stringify(priorRow)}\n`, 'utf8')
    store.registerEntry({ postId: 'w1', sessionId: 's1', roomId: 'board', agentPreset: 'deepartments-worker', provider: 'worker', role: 'quality-inspector', departmentId: 'quality', managerId: 'quality-head', tools: [...DECLARED_QUALITY_INSPECTOR_TOOLS] })
    // No agents service here → no live-scope oracle → the retire keeps the
    // DECLARED tools (the byte-compatible no-change fallback — the snapshot
    // cannot run on the direct-store / boot-reconcile reap class).
    await store.markPostRetired('w1')
    const rows = archiveRows(stateDir)
    assert.equal(rows.length, 2, 'the new retire appended ONE row (the pre-existing row survived)')
    // The PRE-EXISTING row is byte-IDENTICAL (never re-written).
    assert.deepEqual(rows[0], priorRow, 'the pre-existing archive row is byte-identical — existing records are NEVER rewritten')
    // The NEW row keeps the DECLARED tools verbatim (no live scope → no
    // snapshot) and the same R6 shape.
    assert.deepEqual([...rows[1].entry.tools].sort(), [...DECLARED_QUALITY_INSPECTOR_TOOLS].sort(), 'a retire without a live-scope oracle keeps the DECLARED tools verbatim (byte-compatible no-change)')
    assert.deepEqual(Object.keys(rows[1]).sort(), ['entry', 'postId', 'prunedAt'], 'the no-oracle row shape is byte-compatible {postId, entry, prunedAt}')
    assert.equal(rows[1].entry.postId, undefined, 'the no-oracle archived entry is the durable shape (postId stripped)')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})
// NOTE: the audit-channel env stays '1' for this process (node --test runs each
// FILE in a separate process — the r9 pattern; the channel is a per-process
// fixture, it cannot leak into other files).