// dsh-deepartments — lane fb-1PROC (2026-09-15, run token 52a2298b): the
// post-error record classifies by PROCEDENCIA + EFECTO, never by a word.
//
// THE DEFECT (measured 2026-09-15): the abort-reason classifier applied
// `/killed|terminated|stopped by|process was stopped|restart/` to the WHOLE
// message, with NO position and NO provenance, so an artefact that merely NAMED
// a `restart-…` path/command was classified 'churn' — and today's live
// post-errors.jsonl carried the false 'churn' family built exactly that way
// (four rows, all of them about artefacts whose NAME contains `restart`). The
// other face is the same defect: a REAL in-flight abort — whose harness message
// is the bare «tool call aborted» / «tool call aborted before dispatch»
// (dsh-tools/lib/index.js:3552-3584, codes TOOL_ABORTED /
// TOOL_ABORTED_BEFORE_DISPATCH) — was NOT churn at all, because the EFFECT
// (a kill actually reached the call) was never consulted.
//
// THE FIX UNDER TEST (packages/dshd-orchestration/src/tool-intents.ts +
// tools.ts, both OUTSIDE the frozen CUT-4 zone tools.ts:5649-7386):
//   - `ToolAbortSignal` + `toolAbortSignalFrom` (tool-intents.ts): the
//     STRUCTURED kill effect — the harness abort CODES or the explicit
//     `aborted` flag, read from the result/exec object;
//   - `classifyToolAbortReason(message, tool, signal?)`: 'churn' now requires
//     the structured kill signal AND the kill vocabulary (the vocabulary names
//     WHAT the kill ended); with no signal the word decides NOTHING;
//   - `toolAbortSignal` (tools.ts, module-private): the settle point and the
//     nudge gate thread the SAME structured effect, so both keep ONE
//     definition of a life-abort.
//
// COMPOSITION OF EACH TEST (house law — a test names its own composition):
//   (1) COMPOSITION = the PURE classifier `classifyToolAbortReason` from
//       tool-intents.ts + the two real message shapes (harness abort text, a
//       path-naming body error). NO harness, NO fs.
//   (2) COMPOSITION = the REAL registry pipeline: the hermetic Loader boot of
//       src/index.ts (StubAgents/StubPersistence/StubWorkspaceRegistry), a
//       defineTool fixture registered on `root.tools`, dispatched through
//       `root.tools.execute`, settled by the LIVE `tools/post-execute`
//       listener writing <stateDir>/tool-intents.jsonl.
//   (3) same as (2) + a real AbortController (already-aborted and
//       aborted-mid-flight signals, the dsh-tools cancellation sources).
//   (4) COMPOSITION = the CENSUS over the store THIS RUN wrote: the SAME
//       hermetic real-Loader pipeline over a TEMP stateDir. NO live durable
//       store is read — the live census this arm used to take was NON-HERMETIC
//       and is replaced (the arm's own note records the measured reason).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLE_SRC = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href

const TI = await import('../packages/dshd-orchestration/src/tool-intents.ts')
const { classifyToolAbortReason, toolAbortSignalFrom, readToolIntents, TOOL_INTENTS_FILE } = TI

/** The measured live shapes (2026-09-15): the harness abort texts
 * (dsh-tools/lib/index.js:3552-3584) and the path-naming false-positive text. */
const HARNESS_ABORT = 'tool call aborted'
const HARNESS_ABORT_BEFORE_DISPATCH = 'tool call aborted before dispatch'
const FALSE_POSITIVE_RESTART = 'dept_exec failed: ENOENT no such file or directory, stat /root/.deepartments/departments/internal-programming/scratch/restart-window'
const FALSE_POSITIVE_NEUTRAL = 'dept_exec failed: ENOENT no such file or directory, stat /root/.deepartments/departments/internal-programming/scratch/window-guard'
/** A real kill whose message names WHAT the kill ended (the effect + the word). */
const REAL_KILL_WORDED = 'the process was stopped by a restart'

const ORG = {
  departments: [
    {
      id: 'research',
      name: 'Research',
      coordinator: { postId: 'research-head', role: 'Research department head', provider: 'deepseek-official', agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' } }
    }
  ]
}

// --- the hermetic real-Loader harness (the fb957-settle-cause shape) --------
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
    cancel() {},
    whenIdle() { return new Promise(() => {}) }
  }
  const childKey = Symbol('fb1proc-child-scope')
  const scope = createScope(agents.scopeAnchor, childKey)
  const childCtx = scope.ctx.extend({ agent })
  agent.ctx = childCtx
  agents.childContexts.push({ ctx: childCtx, key: childKey })
  agents.childAgents.push(agent)
  const provision = await options.setup?.(childCtx)
  provision?.commit?.()
  agents.store.set(sessionId, agent)
  return { agent }
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
    this.entities = [{ path: stateDir, title: 'root', sessionIds: [], attachSession: async () => {} }]
  }
  get archivedSessionIds() { return this.archived }
  list() { return Promise.resolve(this.entities) }
  async create(p, title) { return { path: p, title, sessionIds: [], attachSession: async () => {} } }
  async resolveByPath(p) { return this.entities.find((e) => e.path === p) }
  async archiveSession(sessionId) { if (!this.archived.includes(sessionId)) this.archived.push(sessionId) }
}

/** A caller-side agent the registry accepts as `agent` (an id is all the
 * tool-intent seam needs). */
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
  new StubPersistence(root)
  new StubWorkspaceRegistry(root, stateDir)
  await root.plugin(SubagentRuntime)
  root.subagents.registerProvider(stubProvider('spawn'))
  root.subagents.registerProvider(stubProvider('fork'))
  loader.create({ id: 'deepartments', name: BUNDLE_SRC, config: { stateDir, org: ORG } })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return { root, agents, dispose: () => loaderFiber.dispose() }}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb1proc-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

/** One fixture tool the REAL registry pipeline dispatches: `body` runs inside a
 * dispatched call and may throw with the message under test (and, for the kill
 * arms, the harness AbortError shape). */
function fixtureTool(name, body) {
  return defineTool({
    name,
    description: `fb-1PROC fixture (${name})`,
    parameters: { target: { type: 'string', required: true, description: 'the artefact this call names' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'fixture ok' }]
    },
    async execute(args) { return body(args) }
  })
}

/** The REAL dispatch through the registry (pre-execute → guards → body →
 * post-execute → result): the settle row is written by the LIVE listener. */
async function dispatch(root, agent, name, args, callId, signal) {
  return root.tools.execute({ name, agent, signal: signal ?? new AbortController().signal, arguments: args, callId })
}

function settleOf(rows, callId) {
  return rows.find((row) => row.kind === 'settle' && row.id === callId)
}

function intentOf(rows, callId) {
  return rows.find((row) => row.kind === 'intent' && row.id === callId)
}

/** The CLASS an abort reason belongs to (the closed taxonomy + the raw-excerpt
 * fallback) — so 'excerpt naming A' and 'excerpt naming B' compare as the SAME
 * classification while the excerpt text itself stays observable. */
const ABORT_CLASSES = ['interruption', 'cancel', 'churn', 'read-only abort', 'abort', 'aborted']
function reasonClass(reason) {
  return ABORT_CLASSES.includes(reason) ? reason : '(raw excerpt)'
}

// ===========================================================================
// (1) PURE — the classifier is decided by the EFFECT, not by the word.
// COMPOSITION: classifyToolAbortReason (tool-intents.ts) + the two measured
// message shapes. No harness, no fs, no stateDir.
// ===========================================================================
test('fb-1PROC PURE (arm i — POSITIVO / the NAME no longer decides): the SAME object with the path NEUTRALIZED (`window-guard` instead of `restart-window`) classifies EXACTLY like its real twin, and neither is churn — the kill word in a path is not a kill', () => {
  const withRestart = classifyToolAbortReason(FALSE_POSITIVE_RESTART, 'dept_exec')
  const neutralized = classifyToolAbortReason(FALSE_POSITIVE_NEUTRAL, 'dept_exec')
  assert.equal(reasonClass(neutralized), reasonClass(withRestart), 'the neutralized twin classifies in the SAME class as the real one (the path word decides NOTHING)')
  assert.equal(neutralized.replace('window-guard', '<ARTEFACTO>'), withRestart.replace('restart-window', '<ARTEFACTO>'), 'the two readings are the SAME reading of the SAME effect once the named artefact is normalized (only the name differs)')
  assert.notEqual(withRestart, 'churn', 'a body error that merely NAMES a restart artefact is NOT churn (the false-positive family)')
  assert.equal(withRestart, FALSE_POSITIVE_RESTART, 'it degrades to the raw message excerpt (the honest reading of an unclassifiable error)')
  // The kill VOCABULARY alone can never produce the class, on any tool — not
  // even with a NON-kill structured code present (an error that is not a kill):
  for (const tool of ['dept_exec', 'edit', 'read', 'send_message']) {
    assert.notEqual(classifyToolAbortReason(REAL_KILL_WORDED, tool), 'churn', `without the structured kill signal "${tool}" does not classify churn from words`)
  }
  assert.notEqual(classifyToolAbortReason(REAL_KILL_WORDED, 'dept_exec', { code: 'INVALID_ARGS' }), 'churn', 'a non-kill structured code never yields churn (the tool errored, nothing was killed)')
  // and the structured kill signal is what flips it (the shape, stated):
  assert.equal(toolAbortSignalFrom({ code: 'ABORTED' }), true, 'the harness ABORTED code IS the kill signal (the body was running)')
  assert.equal(toolAbortSignalFrom({ topLevelCode: 'ABORTED_BEFORE_DISPATCH' }), true, 'the top-level code arm is read too (and the pre-dispatch code is a kill signal as well)')
  assert.equal(toolAbortSignalFrom({ aborted: true }), true, 'the explicit flag is the kill signal')
  assert.equal(toolAbortSignalFrom({ code: 'INVALID_ARGS' }), false, 'a non-abort structured code is NOT a kill (the tool errored, nothing was killed)')
  assert.equal(toolAbortSignalFrom(undefined), false, 'an absent signal is no kill evidence')
  assert.equal(classifyToolAbortReason(REAL_KILL_WORDED, 'dept_exec', { code: 'ABORTED' }), 'churn', 'the SAME worded text WITH the real kill code IS churn (the effect is the discriminator, not the word)')
})

// ===========================================================================
// (2) REAL PIPELINE (arm iii — the case of today): a call whose TEXT names
// `restart-window` (message AND persisted args) WITHOUT being an abort is
// classified by its PROCEDENCIA/EFFECT — never by the word.
// COMPOSITION: hermetic Loader boot of src/index.ts + defineTool fixture +
// root.tools.execute + the LIVE tools/post-execute settle listener writing
// tool-intents.jsonl.
// ===========================================================================
test('fb-1PROC (arm iii — el caso de hoy, through the REAL registry): a call whose TEXT names `restart-window` and whose ARGS carry restart tokens, with NO kill effect, settles by its EFFECT (status error, no abort reason, the structured cause) while the PROCEDENCIA rides the rows (tool on the settle, memberId + target + args on the intent) — the word classifies NOTHING', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      env.root.tools.register(fixtureTool('restart-window-guard', (args) => { throw new Error(`stat failed: no such file or directory, stat /root/.deepartments/departments/internal-programming/scratch/${args.target}`) }))
      const agent = env.agents.put(probeAgent('worker-builder-1proc-iii'))
      const restartCall = `call-fb1proc-restart-${randomUUID()}`
      const neutralCall = `call-fb1proc-neutral-${randomUUID()}`
      const restartResult = await dispatch(env.root, agent, 'restart-window-guard', { target: 'restart-window' }, restartCall)
      const neutralResult = await dispatch(env.root, agent, 'restart-window-guard', { target: 'window-guard' }, neutralCall)
      assert.equal(restartResult.isError, true, 'the fixture errored (a plain body error, nothing was killed)')
      assert.equal(restartResult.error?.info, undefined, 'THE EFFECT: the harness attached NO abort code — no kill reached this call')
      const rows = await readToolIntents(stateDir)
      const restartSettle = settleOf(rows, restartCall)
      const neutralSettle = settleOf(rows, neutralCall)
      assert.ok(restartSettle !== undefined && neutralSettle !== undefined, 'both calls settled (the live listener wrote both rows)')
      // THE EFFECT DECIDES: an errored (not aborted) call carries NO abort
      // reason — the restart-NAMING call is not churn, and is classified
      // EXACTLY like its neutralized twin.
      assert.equal(restartSettle.status, 'error', 'a plain body error settles ERROR (no kill reached it)')
      assert.equal(neutralSettle.status, 'error', 'the neutralized twin settles ERROR identically')
      assert.equal(restartSettle.reason, undefined, 'NO abort reason on an errored row (the reason rides ONLY an aborted settle — the fb-957 split)')
      assert.notEqual(restartSettle.reason, 'churn', 'the restart-NAMING call is NOT churn (the word did not decide)')
      assert.deepEqual([restartSettle.status, restartSettle.reason, restartSettle.cause], [neutralSettle.status, neutralSettle.reason, neutralSettle.cause], 'the twin rows are IDENTICAL in classification (only the named artefact differs)')
      // PROCEDENCIA on the durable rows: the settle names the tool; the sibling
      // intent row names the member, the target and the raw args.
      assert.equal(restartSettle.tool, 'restart-window-guard', 'the settle row carries the TOOL (procedencia)')
      const intent = intentOf(rows, restartCall)
      assert.ok(intent !== undefined, 'the write-ahead intent row exists for the same callId (the provenance join)')
      assert.equal(intent.memberId, 'worker-builder-1proc-iii', 'the intent row carries the MEMBER (who emitted the event)')
      assert.equal(intent.target, 'worker-builder-1proc-iii', 'the intent row carries the TARGET')
      assert.ok(intent.args.includes('restart-window'), 'the intent row still carries the raw args (the word is EVIDENCE, not a classifier)')
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// (2b) REAL PIPELINE (arm iii, the ABORTED variant of today's case): the same
// restart-NAMING call, this time REALLY killed in flight, is classified by the
// EFFECT (status aborted) with the reason READ FROM the structured kill — the
// provenance explains the row, and the artefact name is not the classifier.
// COMPOSITION: hermetic Loader boot of src/index.ts + defineTool fixture +
// root.tools.execute driven by a REAL AbortController (a mid-flight kill) +
// the LIVE tools/post-execute settle listener.
// ===========================================================================
test('fb-1PROC (arm iii-b — the SAME restart-naming artefact, REALLY killed): a mid-flight abort of a call that names `restart-window` settles ABORTED with the reason read from the STRUCTURED kill — the row text names the tool + member, the intent row the target, so the reading is reproducible from the store and not from a word', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      let releaseBody
      const bodyGate = new Promise((resolve) => { releaseBody = resolve })
      let bodyStarted
      const bodyStartedPromise = new Promise((resolve) => { bodyStarted = resolve })
      env.root.tools.register(fixtureTool('restart-window-guard', async () => { bodyStarted(); await bodyGate; return { ok: true } }))
      const agent = env.agents.put(probeAgent('worker-builder-1proc-iiib'))
      const callId = `call-fb1proc-killed-${randomUUID()}`
      const controller = new AbortController()
      const promise = dispatch(env.root, agent, 'restart-window-guard', { target: 'restart-window' }, callId, controller.signal)
      await bodyStartedPromise
      controller.abort('the turn was stopped by a restart')
      releaseBody()
      const result = await promise
      assert.equal(result.error?.info?.code, 'ABORTED', 'THE EFFECT: the in-flight kill carries the harness code (never a word)')
      const rows = await readToolIntents(stateDir)
      const settle = settleOf(rows, callId)
      assert.equal(settle?.status, 'aborted', 'a really-killed call settles ABORTED — the effect, not the path name')
      assert.equal(settle?.reason, 'abort', 'the caller-recorded kill reason never reaches the classifier: only the harness message and the structured code do, so the reason is the bare abort class — the PATH NAME did not make it churn')
      assert.equal(settle?.tool, 'restart-window-guard', 'the row names the tool it was emitted by (procedencia)')
      assert.equal(intentOf(rows, callId)?.target, 'worker-builder-1proc-iiib', 'the intent row names the caller (procedencia)')
      assert.ok(intentOf(rows, callId)?.args.includes('restart-window'), 'the intent row carries the artefact name the call spoke about (the provenance that explains the reading)')
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// (3) REAL PIPELINE (arm ii — NEGATIVE AND MANDATORY): a REAL in-flight abort
// STILL classifies churn when the kill names a turn end, and never when it does
// not — the detector is not switched off by removing the word rule.
// COMPOSITION: hermetic Loader boot of src/index.ts + defineTool fixture +
// root.tools.execute driven by a REAL AbortController (the dsh-tools
// cancellation sources: ABORTED_BEFORE_DISPATCH before the body, ABORTED after
// it), settled by the LIVE tools/post-execute listener.
// ===========================================================================
test('fb-1PROC (arm ii — NEGATIVO Y OBLIGATORIO): a REAL abort in flight settles ABORTED — still CHURN when the harness kill carries the turn-end wording, and the bare harness abort (no turn-end word) stays its own class; the killed-mid-call shape (ABORTED after the body started) is churn too', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      // (k1) KILLED MID-CALL — the body starts, THEN the caller aborts, and the
      // registry answers with the canonical ABORTED result (dsh-tools :3552-3564).
      let releaseBody
      const bodyGate = new Promise((resolve) => { releaseBody = resolve })
      let bodyStarted
      const bodyStartedPromise = new Promise((resolve) => { bodyStarted = resolve })
      env.root.tools.register(fixtureTool('fb1proc-midcall', async () => { bodyStarted(); await bodyGate; return { ok: true } }))
      // (k2) ABORTED BEFORE DISPATCH — the signal is already aborted when the
      // call is prepared (dsh-tools :3076-3080 / :3094-3100).
      env.root.tools.register(fixtureTool('fb1proc-predispatch', () => ({ ok: true })))
      const agent = env.agents.put(probeAgent('worker-builder-1proc-ii'))

      // (k1) mid-call abort.
      const midCall = `call-fb1proc-mid-${randomUUID()}`
      const controller = new AbortController()
      const midPromise = dispatch(env.root, agent, 'fb1proc-midcall', { target: 'midcall' }, midCall, controller.signal)
      await bodyStartedPromise
      controller.abort('fb-1PROC acceptance probe: the turn was stopped by a restart')
      releaseBody()
      const midResult = await midPromise
      assert.equal(midResult.isError, true, 'the aborted mid-flight call is an error result')
      assert.equal(midResult.error?.info?.code, 'ABORTED', 'THE EFFECT: the harness marked the in-flight kill with its own code (never a word)')

      // (k2) pre-dispatch abort: the harness never dispatches the body, so the
      // write-ahead intent does not exist for it (measured in this composition)
      // — the EFFECT is still fully readable from the result, which is the exact
      // input the classifier receives.
      const preCall = `call-fb1proc-pre-${randomUUID()}`
      const preController = new AbortController()
      preController.abort('fb-1PROC acceptance probe: turn stopped by a restart')
      const preResult = await dispatch(env.root, agent, 'fb1proc-predispatch', { target: 'predispatch' }, preCall, preController.signal)
      assert.equal(preResult.error?.info?.code, 'ABORTED_BEFORE_DISPATCH', 'THE EFFECT: a pre-dispatch kill carries its own code too (never a word)')
      assert.equal(classifyToolAbortReason(String(preResult.error?.message ?? ''), 'fb1proc-predispatch', { code: String(preResult.error?.info?.code ?? '') }), 'abort', 'THE CONTROL: a real pre-dispatch kill with the bare harness message stays its own class — never churn by effect alone')

      // (k3) the SAME mid-flight kill, read through the CLASSIFIER with the
      // harness code the caller-named kill really carries: the structured signal
      // is what elects churn, and only then does the wording matter.
      const killedMessage = String(midResult.error?.message ?? '')
      const killedCode = String(midResult.error?.info?.code ?? '')
      assert.equal(classifyToolAbortReason(killedMessage, 'fb1proc-midcall', { code: killedCode }), 'abort', `the real harness kill message («${killedMessage}») carries NO turn-end wording, so it classifies as its own class — never churn by effect alone`)
      assert.equal(classifyToolAbortReason(REAL_KILL_WORDED, 'fb1proc-midcall', { code: killedCode }), 'churn', 'THE MANDATORY NEGATIVE ARM: the SAME structured kill code with a message that names the turn end IS churn — the family is not vacated')
      assert.equal(classifyToolAbortReason(REAL_KILL_WORDED, 'fb1proc-midcall', { aborted: true }), 'churn', 'and the explicit kill flag carries it identically (the flag path)')

      const rows = await readToolIntents(stateDir)
      const midSettle = settleOf(rows, midCall)
      const preSettle = settleOf(rows, preCall)
      assert.equal(midSettle?.status, 'aborted', 'the mid-call kill settles ABORTED (a REAL kill reached the call)')
      assert.equal(preSettle, undefined, 'the never-dispatched call leaves no settle row (the write-ahead intent belongs to the dispatch stage — a measured property of this composition)')
      // The false-positive family is disjoint from these: NOTHING that reached
      // churn here lacked the structured kill code.
      assert.equal(midSettle?.cause, undefined, `an abort row carries NO cause (${midSettle?.id}) — the two diagnostics never mix`)
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// (4) THE CENSUS OF THE STORE THIS RUN WROTE — what the fix changes in the
// world and what it must NOT change, measured on the SIDEcar + the post-error
// surface THIS RUN's pipeline wrote.
// COMPOSITION: the SAME hermetic real-Loader pipeline as (2)/(3) over a TEMP
// stateDir (mkdtemp) — the durable <stateDir>/tool-intents.jsonl + the
// post-errors surface that pipeline writes. NO live durable store is read.
//
// WHY THIS ARM WAS REPLACED (measured 2026-09-15T17:32Z, run token 65937867):
// the previous arm censused the LIVE /.deepartments/tool-intents.jsonl with a
// «today» cut. That file is CAPPED (TOOL_INTENTS_MAX_LINES = 2000,
// tool-intents.ts:56): measured at 17:32Z it held 2 893 rows spanning
// 16:25:25.458Z-17:32:57.145Z — i.e. ~67 minutes — so the cap had ALREADY
// rotated ~800 of the day's rows away and NOT ONE of the two aborted settles
// left in the window was churn (both were 'abort'). The arm therefore did not
// measure «today», it measured «the last ~2000 rows»: GREEN while the day's
// churn rows were still inside the window, RED the moment the writer's own
// volume pushed them out (builder-371 measured it green at 17:07Z and 5/6 at
// 17:15Z; the reviewer's runs measured 5/6 · 30/31 · 49/50). The red was
// PROGRESSIVE and MONOTONE — a census of a bounded live buffer, not a flake.
// The defect this lane fixes IS REAL and stays measured: what is replaced is
// the SUBJECT (a live mutable store) and the cut («today»), never the claim.
// The arrow says so: the store is APPEND-ONLY, so the same assertions hold
// IDENTICALLY over the store this run wrote — and hold for the store's whole
// life, at 0 / 2 000 / 100 000 rows. The live-store finding (the cap, and the
// fact that neither surviving aborted settle is churn) is REPORTED to the head
// as an ALTERNATION declared here, not silently dropped.
// ===========================================================================
test('fb-1PROC (the census, hermetic): in the store THIS RUN wrote, the churn class is taken ONLY by a call whose structured kill evidence is on the row AND whose text names the turn end — the false-positive family (the artefact NAME) never reaches it, and the post-error surface names the tool + the member', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      // The TWO shapes of the defect, dispatched through the REAL registry:
      //   · a call that NAMES the restart artefact and was NOT killed (the
      //     false-positive family the fix removes — its persisted args carry
      //     the kill word, its effect carries nothing);
      //   · a call that WAS killed in flight and whose kill names a turn end
      //     (the family the fix must NOT vacate — the harness kill CODE + the
      //     wording).
      env.root.tools.register(fixtureTool('fb1proc-census-named', () => { throw new Error('stat failed: no such file or directory, stat /root/.deepartments/departments/internal-programming/scratch/restart-window') }))
      env.root.tools.register(fixtureTool('fb1proc-census-churn', () => { throw new HarnessError(REAL_KILL_WORDED, 'ABORTED') }))
      const agent = env.agents.put(probeAgent('worker-builder-1proc-census'))
      const namedCall = `call-fb1proc-census-named-${randomUUID()}`
      const churnCall = `call-fb1proc-census-churn-${randomUUID()}`
      assert.equal((await dispatch(env.root, agent, 'fb1proc-census-named', { target: 'restart-window' }, namedCall)).isError, true, 'the artefact-naming call errored (nothing was killed)')
      assert.equal((await dispatch(env.root, agent, 'fb1proc-census-churn', { target: 'restart-window' }, churnCall)).isError, true, 'the killed call errored (the kill reached it)')

      // THE CENSUS — over the store THIS RUN wrote, with NO «today» cut: the
      // rows the run wrote are the subject, whatever their ts (so the count is
      // the same at 0 / 2 000 / 100 000 rows of history).
      const rows = await readToolIntents(stateDir)
      const intents = new Map()
      for (const row of rows) if (row.kind === 'intent') intents.set(row.id, row)
      const aborts = rows.filter((r) => r.kind === 'settle' && r.status === 'aborted')
      assert.ok(aborts.length > 0, 'the store this run wrote holds the abort settles (the measurement has a subject)')
      const churnRows = aborts.filter((r) => r.reason === 'churn')
      // (ii) THE ASSERTION IS NOT WEAKENED: the case is asserted, not a count.
      // The churn class is taken by EXACTLY the killed-worded call and by
      // nothing else — a count would be satisfied by any churn row; this is not.
      assert.deepEqual(churnRows.map((r) => r.id), [churnCall], 'the churn class is elected by THE CASE — the killed, turn-end-worded call — and by no other row')
      // The false-positive call never even reaches the abort FAMILY: nothing
      // was killed, so it is an ERROR settle with NO reason (the fb-957 split).
      const namedSettle = settleOf(rows, namedCall)
      assert.equal(namedSettle?.status, 'error', 'the artefact-NAMING call that nothing killed settles ERROR (the kill word decided nothing)')
      assert.equal(namedSettle?.reason, undefined, 'and carries NO abort reason at all — it cannot enter the churn class by any path')
      // The DISSOCIATION the live census used to state, stated over this store:
      // the kill word is present in the persisted ARGS of BOTH calls, so the
      // args can never be the discriminator — the structured effect is.
      const namedIntent = intents.get(namedCall)
      assert.ok(namedIntent?.args.includes('restart-window'), 'the false-positive call REALLY carried the kill word in its persisted args (the evidence the old rule classified on)')
      assert.ok(intents.get(churnCall)?.args.includes('restart-window'), 'and so did the killed call — the same word, the opposite class: the text does not decide')
      for (const row of churnRows) {
        assert.equal(row.cause, undefined, 'a churn settle carries no structured cause (the two diagnostics never mix)')
      }
      // The PROVENANCE was ALREADY on the rows and was never consulted: the
      // settle names the tool, the sibling intent the target + the raw args.
      assert.equal(settleOf(rows, churnCall)?.tool, 'fb1proc-census-churn', 'the settle row names the TOOL it was emitted by (procedencia)')
      assert.equal(namedIntent?.target, 'worker-builder-1proc-census', 'the intent row names the TARGET (procedencia) — present before the classification ever saw it')
      assert.equal(namedIntent?.memberId, 'worker-builder-1proc-census', 'and the MEMBER (who emitted the event)')

      // The PRODUCTION SURFACE the host reads: the post-error rows THIS RUN
      // wrote name the TOOL + the MEMBER — the classification ignored them.
      const postErrors = readFileSync(path.join(stateDir, 'post-errors.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const abortRows = postErrors.filter((r) => r.postId === 'tool-abort-intent')
      assert.ok(abortRows.length > 0, 'the abort family reached the post-error surface (the rows the host reads)')
      for (const row of abortRows) {
        assert.match(row.error, /^tool call aborted — \S+ \([\w-]+\): /, 'the row text already names the TOOL + the MEMBER (procedencia) — the classification ignored it')
      }
    } finally {
      await env.dispose()
    }
  })
})

// The exported surface of the package is untouched (the export-parity lock).
test('fb-1PROC (surface): the lane adds NO export name to tool-intents.ts beyond the two it declares (ToolAbortSignal + toolAbortSignalFrom) and never removes one', () => {
  const declared = new Set(Object.keys(TI))
  for (const name of ['classifyToolAbortReason', 'isReadOnlyTool', 'causeFromToolErrorCode', 'classifyToolErrorCause', 'readToolIntents', 'appendToolIntent', 'scanAbortedToolIntents', 'toolAbortSignalFrom', 'TOOL_INTENTS_FILE', 'TOOL_ABORT_POST_ID', 'TOOL_ABORT_DEDUPE_KEY_PREFIX', 'TOOL_ERROR_CAUSES']) {
    assert.ok(declared.has(name), `the pre-existing export ${name} is still published`)
  }
  assert.ok(declared.has('toolAbortSignalFrom'), 'the new pure kill-signal reader is published (the settle point and the tests consume it)')
})
