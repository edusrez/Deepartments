// dsh-deepartments — LANE R4 (2026-09-05, run token e4fd3eb0): «aborts sin
// detalle + clase O1» — the WRITE-AHEAD TOOL-INTENT + DURABLE ABORT-REASON lane
// (fb-69/70/81/83/110/111/126/133). The tools factory registers TWO harness
// tool-dispatch listeners:
//   - `tools/pre-execute`: the INTENT (tool, arguments, target, ts) is
//     persisted to <stateDir>/tool-intents.jsonl BEFORE the real dispatch — a
//     pre-dispatch abort leaves the intent row WITHOUT a settle (the
//     recoverable record);
//   - `tools/post-execute`: the intent is SETTLED ('settled'|'error'|'aborted'
//     with the classified REASON on a life-abort); an abort ALSO writes the
//     reason into the interrupt-state.json detail ledger (the O1-EXT P4 m-1311
//     connect) AND surfaces a deduped post-error row (the W6 health report).
//
//   R4-1 (fb-69/70/81/126/133): a PRE-DISPATCH abort — the intent persisted
//       before dispatch, then NO settle (the dispatch died) — leaves the
//       recoverable row the abort family lacked (no more manual rebuild).
//   R4-2 (fb-110/111/O1): a READ-ONLY abort carries the durable reason
//       ('read-only abort') in the settle row + the interrupt detail ledger +
//       the post-error health surface (nothing flat without a trace).
//   R4-3: the RE-DRIVE after an interruption — the write-ahead row's args are
//       the content that survived; the scan surfaces it as 'unsettled' and the
//       re-issued call settles clean.
// Pure helpers (classifier / scanner) are unit-tested against the package
// SRC; the listener wiring is tested through the REAL Loader (the bundle from
// src, temp stateDir, stub deps).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

// The health-surface reader from the dshd-health SOURCE (the ts-src-loader
// maps the workspace package to src — the 0-build discipline like the o1ext
// lane's `safeInterrupt` import).
const H = await import('../packages/dshd-health/src/index.ts')
const { readPostErrorsFile } = H

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLE_SRC = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href

// The R4 PURE half imported directly from the package SOURCE (ts-src-loader).
const TI = await import('../packages/dshd-orchestration/src/tool-intents.ts')
const {
  appendToolIntent,
  classifyToolAbortReason,
  isReadOnlyTool,
  parseToolIntentRows,
  projectToolIntentArgs,
  readToolIntents,
  recordToolAbortInterruptDetail,
  scanAbortedToolIntents,
  latestToolIntentRows,
  TOOL_ABORT_POST_ID,
  TOOL_INTENT_ARGS_MAX_CHARS,
  TOOL_INTENTS_FILE,
  toolIntentTarget
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

// --- the hermetic real-Loader harness (the o1ext-lane shape: bundle from SRC,
// temp stateDir + stub deps only — 0 builds, 0 real APIs) --------------------
const postAdoption = new Map()

function stubProvider(name) {
  const provider = {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: name === 'fork',
    prepareCalls: [],
    async start() { throw new Error(`stub provider "${name}": one-shot start is not used in these tests`) },
    async prepareContinuable(request) { provider.prepareCalls.push(request); return { seed: [] } }
  }
  return provider
}

async function materializeStubAgent(agents, sessionId, options) {
  const callerSignal = options.signal
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
    cancel(cause, options) { this.cancelCalls.push({ cause, options }) },
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
  return { agent, dispose: async () => {
    agents.disposeCalls.set(sessionId, (agents.disposeCalls.get(sessionId) ?? 0) + 1)
    agents.store.delete(sessionId)
  } }
}

class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.createCalls = []
    this.resumeCalls = []
    this.childContexts = []
    this.childAgents = []
    this.scopeAnchor = ctx
    this.disposeCalls = new Map()
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
  async create(options) {
    this.createCalls.push(options)
    this.ensureStoreSession(options.sessionId)
    return materializeStubAgent(this, options.sessionId, options)
  }
  async resume(options) {
    this.resumeCalls.push(options)
    this.ensureStoreSession(options.resumeSessionId)
    return materializeStubAgent(this, options.resumeSessionId, { ...options, parentSession: postAdoption.get(options.resumeSessionId) })
  }
}

class StubPersistence extends Service {
  constructor(ctx) { super(ctx, 'sessionPersistence'); this.createCalls = []; this.appendCalls = [] }
  async create(meta) { this.createCalls.push(meta) }
  async append(id, events) { this.appendCalls.push({ id, events }) }
  async inspect(childId) {
    const parentSession = postAdoption.get(childId)
    if (parentSession === undefined) throw new Error('stub persistence: no stored session')
    return { meta: { parentSession, seedLength: 0 }, events: [{ type: 'subagent/descriptor', data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'board-post' } }] }
  }
  async list() { return [] }
}

class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.archived = []
    this.attachCalls = []
    this.entitySessions = []
    this.entities = [{
      path: stateDir, title: 'root', sessionIds: this.entitySessions,
      attachSession: async (sessionId) => { this.attachCalls.push(sessionId); if (!this.entitySessions.includes(sessionId)) this.entitySessions.push(sessionId) }
    }]
  }
  get archivedSessionIds() { return this.archived }
  list() { return Promise.resolve(this.entities) }
  async create(path, title) {
    const existing = this.entities.find((e) => e.path === path)
    if (existing !== undefined) return existing
    const entity = { path, title, sessionIds: [], attachSession: async (sessionId) => { this.attachCalls.push(sessionId); if (!entity.sessionIds.includes(sessionId)) entity.sessionIds.push(sessionId) } }
    this.entities.push(entity)
    return entity
  }
  async resolveByPath(path) { return this.entities.find((e) => e.path === path) }
  async archiveSession(sessionId) { if (!this.archived.includes(sessionId)) this.archived.push(sessionId) }
}

async function bootPluginFromSrc(stateDir, opts = {}) {
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
  const spawnStub = stubProvider('spawn')
  const forkStub = stubProvider('fork')
  root.subagents.registerProvider(spawnStub)
  root.subagents.registerProvider(forkStub)
  loader.create({ id: 'deepartments', name: BUNDLE_SRC, config: { stateDir, org: opts.org ?? ORG } })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return { root, agents, persistence, workspaceRegistry, spawnStub, forkStub, pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx, dispose: () => loaderFiber.dispose() }
}

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'r4-abort-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

/** A minimal ToolExecution the real harness waterfalls accept (name, parsed
 * arguments, calling agent, the required callId). */
function intentExec(name, args, agentId, callId = `call-${randomUUID()}`) {
  return { callId, rootCallId: callId, name, arguments: args, agent: { id: agentId }, signal: new AbortController().signal }
}

/** A minimal errored ToolExecutionResult in the life-abort family. */
function abortResult(message = 'tool call aborted') {
  return { isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] }
}

function successResult() {
  return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'ok' }] }
}

/** The intent rows file path (the R4 sidecar). */
function intentsPath(stateDir) {
  return path.join(stateDir, TOOL_INTENTS_FILE)
}

// ===========================================================================
// R4 PURE half — classifier / scanner / projection / target / parse.
// ===========================================================================
test('R4 PURE (abort-reason classifier): the durable REASON classes — interruption / cancel / churn / read-only abort / abort / raw excerpt — map from the harness abort messages; a READ-ONLY tool yields the read-only class (fb-111), an interruption yields interruption, a cancel yields cancel', () => {
  assert.equal(classifyToolAbortReason('The tool call was interrupted after it was recorded', 'send_message'), 'interruption', 'an interrupted call is classified interruption')
  assert.equal(classifyToolAbortReason('the user cancelled ask_user_question', 'ask_user_question'), 'cancel', 'an explicit user cancel is classified cancel')
  assert.equal(classifyToolAbortReason('the process was stopped', 'dept_exec'), 'churn', 'a stopped/killed turn is classified churn')
  assert.equal(classifyToolAbortReason('tool call aborted before dispatch', 'read'), 'read-only abort', 'a READ-ONLY tool abort is its own class (fb-111 pure-read)')
  assert.equal(classifyToolAbortReason('tool call aborted before dispatch', 'send_message'), 'abort', 'a generic aborted call is classified abort')
  assert.equal(classifyToolAbortReason('', 'dept_who'), 'aborted', 'an EMPTY message degrades to a stable class (never a flat empty reason)')
  assert.equal(isReadOnlyTool('read'), true, 'read is read-only')
  assert.equal(isReadOnlyTool('grep'), true, 'grep is read-only')
  assert.equal(isReadOnlyTool('dept_zstd_read'), true, 'dept_zstd_read is read-only')
  assert.equal(isReadOnlyTool('send_message'), false, 'send_message is NOT read-only')
})

test('R4 PURE (intent projection + target): the args survive lossless up to the cap with a truncation marker; the target resolves the recipients for send_message, the cwd for dept_exec, the path for reads, else the member id', () => {
  const args = { to: ['research-head', 'quality-head'], text: 'final report — deliverable done' }
  const projected = projectToolIntentArgs(args)
  assert.ok(projected.includes('"final report — deliverable done"'), 'the send_message CONTENT survives in the projection (the re-drive content)')
  assert.equal(toolIntentTarget('send_message', args, 'worker-1'), 'research-head,quality-head', 'send_message target = the recipients')
  assert.equal(toolIntentTarget('dept_exec', { command: 'pwd', cwd: '/srv/dept-ws' }, 'worker-1'), '/srv/dept-ws', 'dept_exec target = the cwd')
  assert.equal(toolIntentTarget('read', { path: '/keyPooler-state.json' }, 'worker-1'), '/keyPooler-state.json', 'a read target = the path')
  assert.equal(toolIntentTarget('dept_who', {}, 'worker-1'), 'worker-1', 'a generic tool target = the member id')
  const huge = projectToolIntentArgs({ text: 'x'.repeat(TOOL_INTENT_ARGS_MAX_CHARS + 100) })
  assert.ok(huge.length <= TOOL_INTENT_ARGS_MAX_CHARS + 64, 'a huge argument is CAPPED (the sidecar rows stay bounded)')
  assert.ok(huge.includes('\u2026[truncated]'), 'a capped projection carries the truncation marker')
})

test('R4 PURE (interrupt-detail connect — the m-1311 ledger): recordToolAbortInterruptDetail writes the ADDITIVE interrupt-detail:<memberId> entry into interrupt-state.json while PRESERVING pre-existing entries (the safeInterrupt ledger contract — the abort reason rides the SAME datapoint the O1-EXT P4 observability reads)', async () => {
  await withTempStateDir(async (stateDir) => {
    // Seed a pre-existing gate + detail entry (what safeInterrupt would leave).
    await writeFile(path.join(stateDir, 'interrupt-state.json'), JSON.stringify({
      'interrupt:host-asst': 50_000,
      'interrupt-detail:host-asst': { reason: 'interrupted', sourceKey: 'pacing-transition', ts: 50_000 }
    }), 'utf8')
    await recordToolAbortInterruptDetail(stateDir, 'worker-2', { reason: 'read-only abort', sourceKey: 'read', ts: 60_000 })
    const raw = JSON.parse(await readFile(path.join(stateDir, 'interrupt-state.json'), 'utf8'))
    assert.deepEqual(raw['interrupt-detail:worker-2'], { reason: 'read-only abort', sourceKey: 'read', ts: 60_000 }, 'the new abort detail is recorded')
    assert.deepEqual(raw['interrupt-detail:host-asst'], { reason: 'interrupted', sourceKey: 'pacing-transition', ts: 50_000 }, 'a PRE-EXISTING detail entry is PRESERVED (the merge never clobbers)')
    assert.equal(raw['interrupt:host-asst'], 50_000, 'the numeric cooldown gate is preserved')
  })
})

test('R4 PURE (parse + scan): the tolerant parser drops a trailing partial row; the abort scan surfaces (a) an intent WITHOUT a settle within the window (the pre-dispatch/died class — with the recoverable args) and (b) an aborted settle with its durable reason; old rows age out of the window', async () => {
  const rows = parseToolIntentRows(`{"kind":"intent","id":"i1","tool":"send_message","agent":"worker-1","memberId":"worker-1","target":"research-head","args":"{\\"to\\":[\\"research-head\\"]}","ts":1000}\n{"kind":"settle","id":"i1","tool":"send_message","agent":"worker-1","status":"aborted","reason":"abort","ts":1100}\n{"kind":"intent","id":"i2","tool":"read","agent":"worker-2","memberId":"worker-2","target":"/x","args":"{\\"path\\":\\"/x\\"}","ts":1000}\n{"kind":"intent","id":"i3","tool":"grep","agent":"worker-1","memberId":"worker-1","target":"/y","args":"{}","ts":1000}\n{"kind":"settle","id":"i3","tool":"grep","agent":"worker-1","status":"settled","ts":1050}\n{"kind":"intent","id":"i4","tool":"read","agent":"worker-1","memberId":"worker-1","target":"/z","args":"{}","ts":1}`)
  assert.equal(rows.length, 6, 'the parser reads the valid rows')
  const tolerant = parseToolIntentRows('{"kind":"intent","id":"x","tool":"read","agent":"a","memberId":"a","target":"/","args":"{}","ts":1}\n{"partial')
  assert.equal(tolerant.length, 1, 'a trailing partial row is DROPPED (never a parse throw)')
  const findings = scanAbortedToolIntents(rows, 2000, 1000)
  const unsettled = findings.filter((f) => f.kind === 'unsettled')
  assert.equal(unsettled.length, 1, 'exactly ONE intent lacks a settle within the window (i2 — the pre-dispatch/died class)')
  assert.equal(unsettled[0].tool, 'read', 'the unsettled finding is the read call')
  assert.ok(unsettled[0].args !== undefined && unsettled[0].args.includes('/x'), 'the unsettled finding carries the recoverable intent args')
  const aborted = findings.filter((f) => f.kind === 'aborted')
  assert.equal(aborted.length, 1, 'exactly ONE settle is aborted within the window (i1)')
  assert.equal(aborted[0].reason, 'abort', 'the aborted finding carries the durable reason')
  assert.equal(aborted[0].memberId, 'worker-1', 'the aborted finding resolves the member from its intent start')
  assert.ok(!findings.some((f) => f.id === 'i4'), 'a row OUTSIDE the window ages out (never a finding)')
  assert.ok(!findings.some((f) => f.id === 'i3'), 'a SETTLED (ok) call is never a finding')
  const latest = latestToolIntentRows(rows)
  assert.equal(latest.get('i1').kind, 'settle', 'the latest row per id wins (append-ordered)')
})

// ===========================================================================
// R4-1 (fb-69/70/81/126/133): a PRE-DISPATCH abort — the write-ahead intent is
// persisted BEFORE the dispatch; a settle-less intent is the recoverable
// record (aborted before dispatch, no result) the family lacked.
// ===========================================================================
test('R4-1 (abort pre-dispatch): the `tools/pre-execute` waterfall PERSISTS the tool intent (tool, arguments, memberId target, ts) to tool-intents.jsonl BEFORE the dispatch decision; an intent that NEVER settles (the dispatch died) is surfaced by the abort scan with its recoverable args — the content survives for re-drive instead of being rebuilt manually', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const exec = intentExec('send_message', { to: ['research-head'], text: 'R4-1 pre-dispatch content that must SURVIVE' }, 'worker-1')
      // The write-ahead: pre-execute persists BEFORE next() (the dispatch).
      const decision = await env.pluginCtx().waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
      assert.equal(decision.kind, 'allow', 'the downstream dispatch decision is preserved (the write-ahead never blocks)')
      const raw = JSON.parse(await readFile(intentsPath(stateDir), 'utf8'))
      assert.equal(raw.kind, 'intent', 'the pre-execute write is an INTENT row (kind intent)')
      assert.equal(raw.tool, 'send_message', 'the intent names the tool')
      assert.equal(raw.memberId, 'worker-1', 'the intent resolves the caller member id (the target)')
      assert.equal(raw.target, 'research-head', 'the intent carries the target (the send_message recipients)')
      assert.ok(raw.args.includes('R4-1 pre-dispatch content that must SURVIVE'), 'the intent carries the ARGUMENTS (the recoverable content — the write-ahead before dispatch)')
      assert.equal(typeof raw.ts, 'number', 'the intent carries the epoch ts')
      // The abort: the intent NEVER settles (the dispatch died pre-dispatch /
      // mid-call — no post-execute in this window).
      const rows = await readToolIntents(stateDir)
      const findings = scanAbortedToolIntents(rows, Date.now(), 60_000)
      const unsettled = findings.filter((f) => f.kind === 'unsettled' && f.tool === 'send_message')
      assert.equal(unsettled.length, 1, 'the settle-less intent is surfaced as the UNSETTLED (pre-dispatch abort) class')
      assert.ok(unsettled[0].args.includes('R4-1 pre-dispatch content'), 'the scan exposes the recoverable args (the content NO LONGER needs manual rebuild)')
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// R4-2 (fb-110/111/O1): a READ-ONLY abort carries the durable reason — the
// settle row status 'aborted' + the classified reason, the interrupt-state.json
// detail entry (the m-1311 connect) AND the post-error health surface (the W6
// scan input). Nothing flat without a trace.
// ===========================================================================
test('R4-2 (abort READ-ONLY with durable reason): a read-only tool abort settles the intent as ABORTED with reason «read-only abort», records the interrupt-detail ledger entry (m-1311 connect) AND surfaces the deduped post-error row the health report scans — the flat «tool call aborted» now leaves a durable trace', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const exec = intentExec('read', { path: '/keyPooler-state.json' }, 'worker-2')
      await env.pluginCtx().waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
      // The traceless abort the family observed — now it settles with a reason.
      const decision = await env.pluginCtx().waterfall('tools/post-execute', exec, abortResult('tool call aborted'), () => Promise.resolve({ kind: 'accept' }))
      assert.equal(decision.kind, 'accept', 'the downstream accept decision is preserved (the settle listener is additive)')
      const rows = await readToolIntents(stateDir)
      const settle = rows.find((r) => r.kind === 'settle' && r.tool === 'read')
      assert.ok(settle, 'the read intent settled')
      assert.equal(settle.status, 'aborted', 'a life-abort settles as ABORTED')
      assert.equal(settle.reason, 'read-only abort', 'the settle carries the classified DURABLE reason (the read-only class — fb-111)')
      assert.equal(settle.agent, 'worker-2', 'the settle attributes the aborting agent')
      // The interrupt-state.json connect (m-1311): the detail ledger safeInterrupt
      // writes now carries the tool-abort attribution with sourceKey = the tool.
      const interruptRaw = JSON.parse(await readFile(path.join(stateDir, 'interrupt-state.json'), 'utf8'))
      assert.deepEqual(interruptRaw['interrupt-detail:worker-2'], { reason: 'read-only abort', sourceKey: 'read', ts: settle.ts }, 'the abort reason rides the interrupt-detail ledger (the O1-EXT P4 datapoint — the m-1311 connect)')
      // The post-error health surface: the W6 daemon scans post-errors.jsonl and
      // the ROW the audit surfaces carries the reason (no more flat trace-less
      // «tool call aborted»).
      const postErrors = readPostErrorsFile(stateDir)
      assert.ok(postErrors.some((r) => r.postId === TOOL_ABORT_POST_ID), 'the abort surfaced as a post-error row (the health-report input)')
      assert.ok(postErrors.some((r) => r.error.includes('tool call aborted — read (worker-2): read-only abort')), 'the surfaced row carries the TOOL + MEMBER + REASON (the durable detail)')
      // The scan confirms the aborted finding with the reason.
      const findings = scanAbortedToolIntents(rows, Date.now(), 60_000)
      const aborted = findings.filter((f) => f.kind === 'aborted' && f.tool === 'read')
      assert.equal(aborted.length, 1, 'the aborted finding is surfaced')
      assert.equal(aborted[0].reason, 'read-only abort', 'the scan exposes the durable reason')
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// R4-3: the RE-DRIVE after an interruption — the write-ahead row is the
// recoverable intent; re-issuing the SAME tool call with the persisted args
// settles clean; an interruption between the two leaves the unsettled record.
// ===========================================================================
test('R4-3 (re-drive after interruption): the write-ahead intent row with its persisted args IS the re-driveable resource — a re-issued call with the SAME args (parsed from the row, NO manual rebuild) settles ITS intent SETTLED and closes the re-drive loop, while the ORIGINAL interrupted record stays as the durable surfaceable trace of the interruption (window-bounded)', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const args = { to: ['research-head'], text: 'R4-3 re-drive content' }
      const firstExec = intentExec('send_message', args, 'worker-3')
      await env.pluginCtx().waterfall('tools/pre-execute', firstExec, () => Promise.resolve({ kind: 'allow' }))
      // Interruption BEFORE the settle: the intent row is the recoverable intent.
      const rows = await readToolIntents(stateDir)
      const intentRow = rows.find((r) => r.kind === 'intent' && r.tool === 'send_message' && r.agent === 'worker-3')
      assert.ok(intentRow, 'the interrupted pre-dispatch leaves the durable intent row')
      let findings = scanAbortedToolIntents(rows, Date.now(), 60_000)
      assert.equal(findings.filter((f) => f.kind === 'unsettled' && f.tool === 'send_message').length, 1, 'the interrupted call is surfaced as unsettled (the re-drive candidate)')
      // RE-DRIVE: re-issue the SAME tool with the PERSISTED args (the row
      // carried them — no manual rebuild) — this time the call completes.
      const persistedArgs = JSON.parse(intentRow.args)
      assert.equal(persistedArgs.text, 'R4-3 re-drive content', 'the persisted row carries the EXACT content (the manual-rebuild of fb-69/70/81 is structurally gone)')
      const reExec = intentExec('send_message', persistedArgs, 'worker-3')
      await env.pluginCtx().waterfall('tools/pre-execute', reExec, () => Promise.resolve({ kind: 'allow' }))
      await env.pluginCtx().waterfall('tools/post-execute', reExec, successResult(), () => Promise.resolve({ kind: 'accept' }))
      const finalRows = await readToolIntents(stateDir)
      const reSettle = finalRows.find((r) => r.kind === 'settle' && r.id === reExec.callId)
      assert.ok(reSettle, 'the RE-DRIVEN call produced its own settle')
      assert.equal(reSettle.status, 'settled', 'the re-driven call settles SETTLED (the recovery worked)')
      // The interrupted ORIGINAL row stays as the durable interruption trace
      // (the class ask: nothing flat without a trace) — surfaced within the
      // window, aged out after it (the health window discipline).
      const afterFindings = scanAbortedToolIntents(finalRows, Date.now(), 60_000)
      assert.equal(afterFindings.filter((f) => f.kind === 'unsettled' && f.id === firstExec.callId).length, 1, 'the ORIGINAL interrupted record remains the surfaceable trace of the interruption (the trace never vanishes silently)')
      assert.equal(afterFindings.filter((f) => f.kind === 'unsettled' && f.id === reExec.callId).length, 0, 'the RE-DRIVEN intent is never surfaced as an abort (it settled)')
      // Window-bounded: outside the window the old interruption ages out.
      const agedFindings = scanAbortedToolIntents(finalRows, Date.now() + 120_000, 60_000)
      assert.equal(agedFindings.filter((f) => f.id === firstExec.callId).length, 0, 'the interruption record ages OUT of the scan window (bounded — the sidecar keeps it, the surface drops it)')
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// R4 noise guard: a SUCCESS path settles 'settled' (NO abort reason, NO
// interrupt detail, NO post-error row); the write-ahead stays additive.
// ===========================================================================
test('R4 (noise guard): a SUCCESSFUL tool call settles the intent as SETTLED — no abort reason, no interrupt-detail entry, no post-error health row; the write-ahead listeners never alter a downstream decision', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const exec = intentExec('dept_who', {}, 'worker-4')
      await env.pluginCtx().waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
      const decision = await env.pluginCtx().waterfall('tools/post-execute', exec, successResult(), () => Promise.resolve({ kind: 'accept' }))
      assert.equal(decision.kind, 'accept', 'a success decision is preserved')
      const rows = await readToolIntents(stateDir)
      const settle = rows.find((r) => r.kind === 'settle' && r.tool === 'dept_who')
      assert.ok(settle, 'the success intent settled')
      assert.equal(settle.status, 'settled', 'a success settles SETTLED')
      assert.equal(settle.reason, undefined, 'a success has NO abort reason')
      let interruptRaw = {}
      try { interruptRaw = JSON.parse(await readFile(path.join(stateDir, 'interrupt-state.json'), 'utf8')) } catch { /* absent */ }
      assert.ok(!('interrupt-detail:worker-4' in interruptRaw), 'a success writes NO interrupt-detail entry')
      let postErrors = []
      try { postErrors = readPostErrorsFile(stateDir) } catch { /* absent */ }
      assert.equal(postErrors.length, 0, 'a success surfaces NO post-error health row')
      assert.equal(scanAbortedToolIntents(rows, Date.now(), 60_000).length, 0, 'a fully-settled sidecar has ZERO abort findings')
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// R4-EXT (fb-126/133 correlation — the pre-dispatch abort in a post-restart
// window + the deduped health surface): a second same-class abort collapses to
// ONE post-error row (the W6 dedupe), and the reason survives the sidecar.
// ===========================================================================
test('R4-EXT (same-class abort dedupe + bounded sidecar): two same-class aborts surface exactly ONE post-error row (appendPostErrorDeduped); the bounded sidecar keeps the newest rows (the abort evidence survives); a generic tool call IDs by callId (the pipeline identity)', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      for (let i = 0; i < 2; i++) {
        const exec = intentExec('dept_exec', { command: 'pwd' }, 'worker-5')
        await env.pluginCtx().waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
        await env.pluginCtx().waterfall('tools/post-execute', exec, abortResult('tool call aborted'), () => Promise.resolve({ kind: 'accept' }))
      }
      const postErrors = readPostErrorsFile(stateDir)
      assert.equal(postErrors.length, 1, 'two SAME-CLASS aborts collapse to ONE surfaced post-error row (the W6 dedupe — no alert storm)')
      const rows = await readToolIntents(stateDir)
      assert.equal(rows.filter((r) => r.kind === 'settle' && r.status === 'aborted').length, 2, 'BOTH intents settle aborted (the durable per-call record is NOT deduped — only the surface is)')
      // The bounded sidecar: keep the newest rows, trim the oldest (the abort
      // evidence — recent rows — survives).
      const idA = intentExec('read', { path: '/a' }, 'worker-6').callId
      await appendToolIntent(stateDir, { kind: 'intent', id: idA, tool: 'read', agent: 'worker-6', memberId: 'worker-6', target: '/a', args: '{}', ts: 1 })
      const boundedRows = await readToolIntents(stateDir)
      assert.ok(boundedRows.length >= 1, 'the bounded sidecar still reads rows (the append helper is additive)')
      assert.ok(boundedRows.every((r) => typeof r.id === 'string' && r.id !== ''), 'every persisted row carries a non-empty id')
    } finally {
      await env.dispose()
    }
  })
})