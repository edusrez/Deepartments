// dsh-deepartments — fb-957 (LANE «el settle de tool NO guarda CAUSA ⇒ la tasa
// de fallos por causa es INMEDIBLE», run token e242fbf9). ORIGEN: el HOST,
// traída por la QD.
//
// THE GAP THIS FILE PINS (RED-FIRST — measured on the LIVE store, 2026-09-14):
//   /.deepartments/tool-intents.jsonl:7027/:7028 and :7444/:7445 — a REAL
//   `settle` row of a FAILURE carries NO cause…
//      {"kind":"settle","id":"call_00_2w2xmkl1a2dnXIapL1yz6951","tool":"dept_exec",
//       "agent":"worker-builder-334-…","status":"error","ts":1789423282300}
//   …and its SIBLING `intent` row of the SAME `id` carries the capped `args`
//   (the join the QD measured):
//      {"kind":"intent","id":"call_00_2w2xmkl1a2dnXIapL1yz6951","tool":"dept_exec",
//       "agent":"…","memberId":"builder-334","target":"builder-334","args":"{…}","ts":…}
//   Store census at the 22:24Z cut: 1 335 settled / 82 error / 3 aborted rows
//   (the sidecar had since been TRIMMED to its 2 000-row window), 3 rows
//   carrying a reason and **0 settles carrying a cause**. So the failure rate BY
//   CAUSE was not measurable from the durable rows, while the long form was
//   reachable only by joining `intent`↔`settle` on `id`.
//
// THE FIX (option (a) — a DERIVABLE, closed enum; NOT an invented taxonomy):
//   an `error` settle now records `cause` ∈ TOOL_ERROR_CAUSES, derived at the
//   write point from (1) the structured `error.info.code` the harness/plugins
//   own, (2) our own byte-locked guard-deny prefix, else (3) 'other'. The
//   contract split (tool-intents.ts header + the settle writer comment):
//   `reason` = the ABORT taxonomy ONLY, `cause` = the ERROR enum ONLY, and a
//   SUCCESSFUL settle carries NEITHER (the noise-guard contract is unchanged).
//
// THE REFUTED CLASSES (declared, not invented — see classifyToolErrorCause):
//   `provider` / `network` leave NO tool-layer marker (the cloud-4xx class is
//   classified at the JOB layer: packages/dshd-jobs/src/index.ts:530) and a
//   FAILED SHELL/BUILD COMMAND IS NOT AN ERROR ROW AT ALL — a non-zero exit is
//   a RESULT (dsh-tool-bash/lib/index.js:36-43 «Non-zero exits are reported,
//   not errored … only infrastructure failures (spawn errors, aborts) surface
//   as isError results»; dept_exec mirrors it: packages/dshd-orchestration/src/
//   tools.ts:2103-2109 returns the failed run as `{ok:false,…}`). So those
//   families cannot be a cause of an `error` settle and are NOT in the enum.
//
// Hermetic: temp stateDir; the E2 boots the REAL Loader composition (the same
// harness shape as test/r4-abort-intents.test.js and the invoke.test.js
// `root.tools.execute` dispatches) and drives the REAL registry pipeline, so
// the settle row is written by the REAL `tools/post-execute` listener.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

// The LIVE guard function of the dept_exec scope guard (the r5-dx-guards
// convention: the built bridge, the same one the tool body calls).
import { deptExecDenyReason } from '../lib/invoke.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLE_SRC = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href

const TI = await import('../packages/dshd-orchestration/src/tool-intents.ts')
const {
  classifyToolErrorCause,
  causeFromToolErrorCode,
  parseToolIntentRows,
  readToolIntents,
  GUARD_DENY_REASON_PREFIX,
  TOOL_ERROR_CAUSES,
  TOOL_INTENTS_FILE
} = TI

const ORG = {
  departments: [
    {
      id: 'research',
      name: 'Research',
      coordinator: { postId: 'research-head', role: 'Research department head', provider: 'deepseek-official', agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' } }
    }
  ]
}

// --- the hermetic real-Loader harness (the r4-abort-intents shape) ----------
function stubProvider(name) {
  return {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: name === 'fork',
    async start() { throw new Error(`stub provider "${name}": one-shot start is not used in these tests`) },
    async prepareContinuable() { return { seed: [] } }
  }
}

async function materializeStubAgent(agents, sessionId, options) {
  const agent = {
    id: sessionId,
    options: options.agentOptions ?? {},
    status: 'idle',
    session: {
      header: { id: sessionId, parentSession: options.meta?.parentSession, delegationDepth: options.meta?.delegationDepth },
      events: [],
      get seq() { return this.events.length },
      snapshotEvents() { return this.events },
      requestHeader() { return undefined }
    },
    inboxMessages: [],
    ctx: undefined,
    followup(message) { this.inboxMessages.push(message) },
    steer() {}, inject() {}, send() {},
    cancelCalls: [],
    cancel(cause, options2) { this.cancelCalls.push({ cause, options: options2 }) },
    whenIdle() { return new Promise(() => {}) }
  }
  const childKey = Symbol('stub-child-scope')
  const scope = createScope(agents.scopeAnchor, childKey)
  const childCtx = scope.ctx.extend({ agent })
  agent.ctx = childCtx
  agents.childContexts.push({ ctx: childCtx, key: childKey })
  agents.childAgents.push(agent)
  const provision = await options.setup?.(childCtx)
  provision?.commit?.()
  agents.store.set(sessionId, agent)
  return { agent, dispose: async () => { agents.store.delete(sessionId) } }
}

class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.childContexts = []
    this.childAgents = []
    this.scopeAnchor = ctx
  }
  get(id) { return this.store.get(id) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  put(agent) { this.store.set(agent.id, agent); return agent }
  ensureStoreSession(sessionId) {
    const id = SessionId(sessionId)
    const store = this.ctx.get('sessions')
    if (store === undefined || typeof store.get !== 'function') return undefined
    const existing = store.get(id)
    if (existing !== undefined) return existing
    try { return store.create(id, {}) ?? store.get(id) } catch { return store.get(id) }
  }
  async create(options) { this.ensureStoreSession(options.sessionId); return materializeStubAgent(this, options.sessionId, options) }
  async resume(options) { this.ensureStoreSession(options.resumeSessionId); return materializeStubAgent(this, options.resumeSessionId, options) }
}

class StubPersistence extends Service {
  constructor(ctx) { super(ctx, 'sessionPersistence') }
  async create() {}
  async append() {}
  async inspect() { throw new Error('stub persistence: no stored session') }
  async list() { return [] }
}

class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.archived = []
    this.attachCalls = []
    this.entities = [{ path: stateDir, title: 'root', sessionIds: [], attachSession: async () => {} }]
  }
  get archivedSessionIds() { return this.archived }
  list() { return Promise.resolve(this.entities) }
  async create(p, title) { return { path: p, title, sessionIds: [], attachSession: async () => {} } }
  async resolveByPath(p) { return this.entities.find((e) => e.path === p) }
  async archiveSession(sessionId) { if (!this.archived.includes(sessionId)) this.archived.push(sessionId) }
}

/** A caller-side agent the registry accepts as `agent` (the invoke.test.js
 * fakeParentAgent shape — an id is all the tool-intent seam needs). */
function probeAgent(id) {
  return {
    id,
    options: {},
    status: 'idle',
    session: { header: { id }, events: [], get seq() { return 0 }, snapshotEvents() { return [] }, requestHeader() { return undefined } },
    inboxMessages: [],
    followup() {}, steer() {}, inject() {}, send() {},
    cancel() {},
    whenIdle() { return new Promise(() => {}) }
  }
}

async function bootPluginFromSrc(stateDir) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  const agents = new StubAgents(root)
  const persistence = new StubPersistence(root)
  const workspaceRegistry = new StubWorkspaceRegistry(root, stateDir)
  await root.plugin(SubagentRuntime)
  root.subagents.registerProvider(stubProvider('spawn'))
  root.subagents.registerProvider(stubProvider('fork'))
  loader.create({ id: 'deepartments', name: BUNDLE_SRC, config: { stateDir, org: ORG } })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return { root, agents, persistence, workspaceRegistry, dispose: () => loaderFiber.dispose() }
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb957-cause-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

/** One fixture tool the REAL registry pipeline dispatches (the r5-dx-guards
 * `ctx.tools.register` convention). `body` is the tool's own execute. */
function fixtureTool(name, body, parameters = {}) {
  return defineTool({
    name,
    description: `fb-957 fixture (${name})`,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'fixture ok' }]
    },
    async execute(args) { return body(args) }
  })
}

/** The REAL dispatch through the registry (pre-execute → guards → body →
 * post-execute → result) — the settle row is written by the live listener. */
async function dispatch(root, agent, name, args, callId, signal) {
  return root.tools.execute({ name, agent, signal: signal ?? new AbortController().signal, arguments: args, callId })
}

function rowsOf(stateDir) {
  return readToolIntents(stateDir)
}

/** The digest recipe the QD needs: group the ERROR settles of the sidecar by
 * their cause, joining each to its sibling intent row on `id` (the canonical
 * diagnostic path — the long form lives there). */
function errorCauses(rows) {
  const intents = new Map()
  for (const row of rows) if (row.kind === 'intent') intents.set(row.id, row)
  const byCause = new Map()
  let unpaired = 0
  for (const row of rows) {
    if (row.kind !== 'settle' || row.status !== 'error') continue
    const intent = intents.get(row.id)
    if (intent === undefined) { unpaired++; continue }
    const cause = row.cause ?? '(none)'
    const bucket = byCause.get(cause) ?? { tool: row.tool, n: 0, ids: [], args: [] }
    bucket.n++
    bucket.ids.push(row.id)
    bucket.args.push(intent.args)
    byCause.set(cause, bucket)
  }
  return { byCause, unpaired }
}

// ===========================================================================
// PURE half — the closed enum + the derivation rules.
// ===========================================================================
test('fb-957 PURE (closed enum): TOOL_ERROR_CAUSES is the CLOSED cause set and the classifier NEVER returns a value outside it (no free text, no raw code echo)', () => {
  assert.deepEqual(
    [...TOOL_ERROR_CAUSES],
    ['guard-denied', 'tool-unknown', 'schema-invalid', 'output-invalid', 'timeout', 'path-not-found', 'other'],
    'the enum is the declared closed set (the measurement contract)'
  )
  const samples = [
    undefined,
    null,
    {},
    { message: '' },
    { message: 'boom: something arbitrary the tool felt like saying, '.repeat(40) },
    { info: { name: 'HarnessError', code: 'SOME_FUTURE_CODE' } },
    { info: { name: 'X', code: 'FS_IO_ERROR' } },
    { info: { name: 'X', code: 'UNKNOWN_TOOL' } },
    { message: `[deepartments] dept_exec: ${GUARD_DENY_REASON_PREFIX} — x` }
  ]
  for (const sample of samples) {
    const cause = classifyToolErrorCause(sample)
    assert.ok(TOOL_ERROR_CAUSES.includes(cause), `cause "${cause}" is a member of the closed enum`)
    assert.ok(cause.length <= 20, 'the cause is a SHORT enum key (never the long free-text form the sibling intent row already carries)')
  }
})

test('fb-957 PURE (structured codes): the harness/plugin codes the settle point actually holds map to the enum; an unknown code degrades to other (never the raw code)', () => {
  assert.equal(causeFromToolErrorCode('UNKNOWN_TOOL'), 'tool-unknown', 'dsh-tools ToolNotFoundError → tool-unknown')
  assert.equal(causeFromToolErrorCode('INVALID_ARGS'), 'schema-invalid', 'dsh-tools ToolArgsError → schema-invalid')
  assert.equal(causeFromToolErrorCode('INVALID_TOOL_OUTPUT'), 'output-invalid', 'dsh-tools ToolOutputError → output-invalid')
  assert.equal(causeFromToolErrorCode('TOOL_TIMEOUT'), 'timeout', 'the timeout plugin code → timeout')
  assert.equal(causeFromToolErrorCode('FS_NOT_FOUND'), 'path-not-found', 'FsErrorCode FS_NOT_FOUND → path-not-found')
  assert.equal(causeFromToolErrorCode('FS_EDIT_NOT_FOUND'), 'path-not-found', 'FsErrorCode FS_EDIT_NOT_FOUND → path-not-found')
  assert.equal(causeFromToolErrorCode('FS_NOT_DIRECTORY'), 'path-not-found', 'FsErrorCode FS_NOT_DIRECTORY → path-not-found')
  assert.equal(causeFromToolErrorCode('SEARCH_PATH_NOT_FOUND'), 'path-not-found', 'SearchError → path-not-found')
  assert.equal(causeFromToolErrorCode('FS_SANDBOX_DENIED'), 'guard-denied', 'FsErrorCode FS_SANDBOX_DENIED → guard-denied (a STRUCTURED denial)')
  assert.equal(causeFromToolErrorCode('FS_PERMISSION_DENIED'), 'guard-denied', 'FsErrorCode FS_PERMISSION_DENIED → guard-denied')
  assert.equal(causeFromToolErrorCode('FS_STALE_VERSION'), 'other', 'a code with no class in the enum degrades to other')
  assert.equal(causeFromToolErrorCode('ABORTED'), 'other', 'the abort codes never reach an error row (they settle aborted) — and are not guessed into a cause')
  // error.info.code is the primary signal; the top-level `code` arm covers a
  // body that throws a HarnessError-shaped value.
  assert.equal(classifyToolErrorCause({ message: 'invalid arguments: x', info: { name: 'ToolArgsError', code: 'INVALID_ARGS' } }), 'schema-invalid', 'error.info.code drives the cause')
  assert.equal(classifyToolErrorCause({ message: 'unknown tool "nope"', code: 'UNKNOWN_TOOL' }), 'tool-unknown', 'a top-level code is honoured (the HarnessError-shaped throw)')
})

test('fb-957 PURE (guard anchor): the LIVE dept_exec guard function produces denials that classify guard-denied — the anchor is the guard contract itself, not a copied string', async () => {
  const roots = ['/home/esuarez/projects', '/root/.deepartments']
  const cwd = '/root/.deepartments'
  const denials = [
    deptExecDenyReason('sudo rm -rf /', cwd, roots),
    deptExecDenyReason('cat /etc/passwd', cwd, roots),
    deptExecDenyReason('ls', '/etc', roots),
    deptExecDenyReason('systemctl restart dsh', cwd, roots)
  ]
  for (const deny of denials) {
    assert.ok(deny !== undefined && deny !== '', 'the guard denies the probe command')
    assert.ok(deny.startsWith(GUARD_DENY_REASON_PREFIX), `the deny carries the byte-locked prefix (${deny})`)
    // The EXACT shape the tool body throws (tools.ts:2096 — prefix + nudge line).
    const cause = classifyToolErrorCause({ message: `[deepartments] dept_exec: ${deny}\n¿Error de tool o propuesta de mejora?` })
    assert.equal(cause, 'guard-denied', 'a guard denial classifies guard-denied')
  }
  // The guard's own phrasing is a FROZEN contract in the repo (the r5 lock
  // asserts it byte-identically) — read the source too, so the anchor is
  // verified on BOTH sides (the live function AND the file that owns it).
  const invokeSrc = await readFile(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
  assert.ok(invokeSrc.includes(`'${GUARD_DENY_REASON_PREFIX}`), 'src/invoke.ts builds the deny reasons from the SAME frozen prefix')
  const r5 = await readFile(path.join(REPO_ROOT, 'test', 'r5-dx-guards.test.js'), 'utf8')
  assert.ok(r5.includes(GUARD_DENY_REASON_PREFIX), 'the deny phrase is byte-locked by an existing test (r5-dx-guards) — the anchor cannot drift silently')
})

test('fb-957 PURE (refuted classes — what is NOT derivable stays other): a provider/network message, a harness-level deny without our prefix, and an arbitrary tool error are all other; a failed shell command is not even an error row', () => {
  assert.equal(classifyToolErrorCause({ message: '400: {"message":"Error from provider (Console Go): Upstream request failed"}' }), 'other', 'the provider-400 family has no tool-layer marker → other (it is classified at the JOB layer)')
  assert.equal(classifyToolErrorCause({ message: 'fetch failed' }), 'other', 'a network failure → other (no structured code, no contract phrase)')
  assert.equal(classifyToolErrorCause({ message: 'the user rejected tool "x"' }), 'other', 'a harness-level deny is NOT our guard phrase → other (dsh-tools attaches no info to a denial)')
  assert.equal(classifyToolErrorCause({ message: 'test failed' }), 'other', 'a failed shell/test command is a RESULT, not an error row (dsh-tool-bash renders non-zero exits as content) — never guessed into a cause')
  assert.equal(classifyToolErrorCause({ message: 'x'.repeat(500) }), 'other', 'an arbitrary long message is never echoed into the cause field')
})

// ===========================================================================
// E2 — the REAL registry pipeline: the settle row is written by the REAL
// post-execute listener. RED before the change (no `cause`), GREEN after.
// ===========================================================================
test('fb-957 E2 (guard-denied through the REAL registry): a dispatched call whose body throws the guard denial settles status error WITH cause guard-denied, and its sibling intent row of the SAME id carries the args', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      const roots = ['/home/esuarez/projects', '/root/.deepartments']
      const deny = deptExecDenyReason('cat /etc/passwd', '/root/.deepartments', roots)
      env.root.tools.register(fixtureTool('fb957-fixture-guard', () => {
        throw new Error(`[deepartments] dept_exec: ${deny}\n¿Error de tool o propuesta de mejora?`)
      }))
      const agent = env.agents.put(probeAgent('worker-builder-fb957-guard'))
      const callId = `call-fb957-${randomUUID()}`
      const result = await dispatch(env.root, agent, 'fb957-fixture-guard', { command: 'cat /etc/passwd' }, callId)
      assert.equal(result.isError, true, 'the dispatched call failed (the guard denial surfaced as an errored result)')
      const rows = await rowsOf(stateDir)
      const settle = rows.find((row) => row.kind === 'settle' && row.id === callId)
      const intent = rows.find((row) => row.kind === 'intent' && row.id === callId)
      assert.ok(settle, 'the REAL post-execute listener settled the intent')
      assert.ok(intent, 'the REAL pre-execute listener persisted the intent BEFORE the dispatch')
      assert.equal(settle.status, 'error', 'the failure settles ERROR')
      assert.equal(settle.cause, 'guard-denied', 'THE FIX: the error row carries its DERIVABLE cause')
      assert.equal(settle.reason, undefined, 'the abort taxonomy stays off an error row (the reason/cause split)')
      assert.ok(intent.args.includes('cat /etc/passwd'), 'the sibling intent row of the SAME id carries the capped args (the join path)')
      assert.equal(intent.memberId, 'worker-builder-fb957-guard', 'the intent row attributes the caller')
      // The row shape stays parseable by the R4 parser (the additive field).
      const repo = parseToolIntentRows(`${JSON.stringify(settle)}\n`)
      assert.equal(repo.length, 1, 'a settle row carrying a cause still parses (the additive field never breaks the R4 parser)')
      assert.equal(repo[0].cause, 'guard-denied', 'the parsed settle carries the cause')
    } finally {
      await env.dispose()
    }
  })
})

test('fb-957 E2 (schema-invalid through the REAL registry): the harness args validation of a real dispatch settles error WITH cause schema-invalid (the structured code reaches the settle point)', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      env.root.tools.register(fixtureTool('fb957-fixture-schema', () => ({ ok: true }), {
        command: { type: 'string', required: true, description: 'a required parameter' }
      }))
      const agent = env.agents.put(probeAgent('worker-builder-fb957-schema'))
      const callId = `call-fb957-${randomUUID()}`
      // Dispatch with the required parameter MISSING → dsh-tools ToolArgsError.
      const result = await dispatch(env.root, agent, 'fb957-fixture-schema', {}, callId)
      assert.equal(result.isError, true, 'the harness rejects the call (invalid arguments)')
      assert.equal(result.error?.info?.code, 'INVALID_ARGS', 'the harness attached the STRUCTURED code (the derivation source)')
      const rows = await rowsOf(stateDir)
      const settle = rows.find((row) => row.kind === 'settle' && row.id === callId)
      assert.ok(settle, 'the rejected call still settles (the settle listener is additive to the pipeline)')
      assert.equal(settle.status, 'error', 'the harness rejection settles ERROR')
      assert.equal(settle.cause, 'schema-invalid', 'THE FIX: the structured code becomes the cause')
    } finally {
      await env.dispose()
    }
  })
})

test('fb-957 (noise guard + the reason/cause split): a SUCCESSFUL settle carries NEITHER cause NOR reason; a life-abort settle carries reason and NO cause', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      env.root.tools.register(fixtureTool('fb957-fixture-ok', () => ({ ok: true })))
      env.root.tools.register(fixtureTool('fb957-fixture-churn', () => { throw new Error('the process was stopped') }))
      const agent = env.agents.put(probeAgent('worker-builder-fb957-split'))
      const okId = `call-fb957-${randomUUID()}`
      const churnId = `call-fb957-${randomUUID()}`
      const okResult = await dispatch(env.root, agent, 'fb957-fixture-ok', {}, okId)
      assert.notEqual(okResult.isError, true, 'the fixture succeeds')
      const churnResult = await dispatch(env.root, agent, 'fb957-fixture-churn', {}, churnId)
      assert.equal(churnResult.isError, true, 'the churn fixture fails')
      const rows = await rowsOf(stateDir)
      const ok = rows.find((row) => row.kind === 'settle' && row.id === okId)
      const churn = rows.find((row) => row.kind === 'settle' && row.id === churnId)
      assert.ok(ok !== undefined && churn !== undefined, 'both settles were written')
      assert.equal(ok.status, 'settled', 'a success settles SETTLED')
      assert.equal(ok.cause, undefined, 'a SUCCESSFUL settle carries NO cause (the noise-guard contract is unchanged)')
      assert.equal(ok.reason, undefined, 'a SUCCESSFUL settle carries NO reason (unchanged)')
      assert.equal(churn.status, 'aborted', 'a killed/stopped turn settles ABORTED (the R4 life-abort family)')
      assert.equal(churn.reason, 'churn', 'the abort keeps its durable REASON')
      assert.equal(churn.cause, undefined, 'an abort row carries NO cause — the two diagnostics never mix')
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// The JOIN (the QD's canonical diagnostic path) — executable recipe.
// ===========================================================================
test('fb-957 (the join id↔id is the canonical diagnostic path): every ERROR row pairs with its sibling intent row on the SAME id, and grouping by cause yields the failure-rate-by-cause the lane needed — for a row the settle CANNOT derive (other) the args remain the only reading', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      const roots = ['/home/esuarez/projects', '/root/.deepartments']
      const deny = deptExecDenyReason('sudo ls', '/root/.deepartments', roots)
      env.root.tools.register(fixtureTool('fb957-fixture-guard', () => { throw new Error(`[deepartments] dept_exec: ${deny}\nN`) }))
      env.root.tools.register(fixtureTool('fb957-fixture-schema', () => ({ ok: true }), { command: { type: 'string', required: true } }))
      env.root.tools.register(fixtureTool('fb957-fixture-opaque', () => { throw new Error('something no rule can classify') }))
      env.root.tools.register(fixtureTool('fb957-fixture-ok', () => ({ ok: true })))
      const agent = env.agents.put(probeAgent('worker-builder-fb957-join'))
      const ids = []
      const send = async (name, args) => { const id = `call-fb957-${randomUUID()}`; ids.push({ name, id }); await dispatch(env.root, agent, name, args, id) }
      await send('fb957-fixture-guard', { command: 'sudo ls' })
      await send('fb957-fixture-schema', {})
      await send('fb957-fixture-opaque', { command: 'x' })
      await send('fb957-fixture-ok', {})
      const rows = await rowsOf(stateDir)
      const { byCause, unpaired } = errorCauses(rows)
      assert.equal(unpaired, 0, 'every error settle pairs with its intent row by id (the join never dangles)')
      assert.equal(byCause.get('guard-denied')?.n, 1, 'one guard-denied error in the window')
      assert.equal(byCause.get('schema-invalid')?.n, 1, 'one schema-invalid error in the window')
      assert.equal(byCause.get('other')?.n, 1, 'the underivable failure is counted as other — honestly, not guessed')
      assert.equal(byCause.get('settled'), undefined, 'the SUCCESSFUL call is not in the failure table (no cause on a success)')
      // The residual 'other' row is still diagnosable THROUGH THE JOIN: its
      // sibling intent row carries what the call was.
      const other = byCause.get('other')
      assert.equal(other.tool, 'fb957-fixture-opaque', 'the other bucket names the tool')
      assert.ok(other.args[0].includes('"command":"x"'), 'the other bucket exposes the sibling intent args (the canonical reading for an underivable cause)')
      const total = [...byCause.values()].reduce((sum, bucket) => sum + bucket.n, 0)
      assert.equal(total, 3, 'three failures, three buckets — the rate by cause is measurable from the durable rows')
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// The STORE contract: the file the live daemon writes is the same sidecar.
// ===========================================================================
test('fb-957 (store): the settle rows land in <stateDir>/tool-intents.jsonl — the SAME store the live runtime writes (the lane\'s RED evidence was read from it)', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      env.root.tools.register(fixtureTool('fb957-fixture-guard', () => { throw new Error(`[deepartments] x: ${GUARD_DENY_REASON_PREFIX} — y`) }))
      const agent = env.agents.put(probeAgent('worker-builder-fb957-store'))
      await dispatch(env.root, agent, 'fb957-fixture-guard', {}, `call-fb957-${randomUUID()}`)
      const raw = await readFile(path.join(stateDir, TOOL_INTENTS_FILE), 'utf8')
      const settles = raw.trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.kind === 'settle')
      assert.equal(settles.length, 1, 'one settle row in the sidecar named TOOL_INTENTS_FILE')
      assert.equal(settles[0].cause, 'guard-denied', 'the durable row carries the cause (what the LIVE /.deepartments/tool-intents.jsonl rows lack today)')
    } finally {
      await env.dispose()
    }
  })
})
