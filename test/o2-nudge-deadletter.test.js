// B3-P2 — O2 QD NUDGE DEAD-LETTER (tools.ts post-execute; lane pequeña, 0 deps).
// IPH dispatch 2026-09-06. The feedback-nudge dead-letter close (O2 — main
// 562d994 already carries the O2 suppressions from the fold-ins tramo 3):
//   (1) a LIFE-ABORT errored result is NEVER nudged — the post cannot act on
//       its own abort. The abort markers (B3-P2 verification):
//         (i)  an explicit `aborted: true` marker on the EXEC or the RESULT
//              (the defensive flag path of isNudgeLifeAbort); and
//         (ii) the error-message word-family aligned with the canonical R4
//              taxonomy (`classifyToolAbortReason`): interrupt · abort · kill
//              · cancel — «tool call aborted (before dispatch)» (dsh-tools
//              TOOL_ABORTED / TOOL_ABORTED_BEFORE_DISPATCH), «The tool call
//              was interrupted after it was recorded» (W9-b cancel close),
//              «approval for tool "<name>" was cancelled» (dsh-tools approval
//              cancel — class 'cancel'), «the user cancelled <tool>».
//   (2) a RETIRED post is NEVER nudged AND nothing is spliced into its
//       context: the handler returns the downstream decision VERBATIM (0
//       nudge contexts, downstream additionalContexts untouched).
// The nudge CONTRACT stays intact for genuine non-abort tool errors (1 nudge
// plugin/notice per error, PREPENDED, dedupe 1b: an error whose message
// already carries the inline line is skipped; the SAME (postId, turn,
// error-class) is nudged once).
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

/** Temp stateDir harness (the withTempStateDir pattern of invoke.test.js). */
async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-o2nudge-'))
  try {
    await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Seed a durable post into <stateDir>/posts.json BEFORE boot (the registry
 * the nudge handler's `byPost` reads — a retired worker post keeps its entry
 * with `retired: true`, the canonical source of the dead-letter check). The
 * loadPosts registration gate requires sessionId + roomId + agentPreset
 * (dshd-core registry.ts loadPosts). */
async function seedPost(stateDir, { postId, sessionId, roomId = 'board', agentPreset = 'deepartments-worker', provider = 'worker', role, managerId, retired }) {
  const postsPath = path.join(stateDir, 'posts.json')
  let existing = {}
  try {
    existing = JSON.parse(await readFile(postsPath, 'utf8'))
  } catch {
    /* no prior seed */
  }
  const entry = { sessionId, roomId, agentPreset, provider, role, managerId }
  if (retired === true) entry.retired = true
  existing[postId] = entry
  await writeFile(postsPath, JSON.stringify(existing, null, 2), 'utf8')
}

/** Poll-wait for a predicate (the repo de-flake pattern — the durable
 * registry cold load at boot.ts:820 is fire-and-forget, so a seeded retired
 * entry must be awaited before the waterfall reads it). */
async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** The department the composed bundle drives (the tools-factory shape). */
const DEPARTMENT = {
  id: 'internal-programming',
  name: 'Internal Programming',
  roomId: 'room-ipd',
  coordinator: { postId: 'internal-programming-head' }
}

/** The exact nudge line (byte-identical to FEEDBACK_NUDGE_LINE in
 * packages/dshd-orchestration/src/tools.ts). */
const FEEDBACK_NUDGE_LINE = '¿Error de tool o propuesta de mejora? Repórtala con dept_feedback al QD'

/** A minimal ToolExecution the real `tools/post-execute` waterfall accepts. */
function nudgeExec(name = 'probe_tool', agent = { id: 'probe-agent' }) {
  return { name, arguments: {}, agent }
}

/** An errored ToolExecutionResult (the shape a thrown/denied tool yields). */
function nudgeErrorResult(message = 'boom') {
  return { isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] }
}

/** The nudge additionalContexts among a decision's contexts. */
function nudgeContexts(contexts) {
  return (contexts ?? []).filter((c) => {
    const text = Array.isArray(c?.content) ? c.content.map((b) => b?.text ?? '').join('') : ''
    return c?.source?.kind === 'plugin' && text.includes(FEEDBACK_NUDGE_LINE)
  })
}

const accept = () => Promise.resolve({ kind: 'accept' })

/** Stub webServer/webRuntime/connection so the bundle RPC mount effect runs. */
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

/** The REAL Loader composition of the dev-profile subset (dshd-core + the P1
 * packages + dshd-orchestration + the bundle, in order — the
 * wfd-franja-nudge smokeBoot pattern). An org WITHOUT `org.pacing` keeps the
 * pre-pacing legacy → the nudge ALWAYS dispatches (deterministic — the franja
 * gate can never defer a test nudge). */
async function smokeBoot(stateDir, { org = { departments: [DEPARTMENT] } } = {}) {
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
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return { pluginCtx, dispose: () => loaderFiber.dispose() }
}

// ---------------------------------------------------------------------------
// (a) LIFE-ABORT → NO nudge
// ---------------------------------------------------------------------------

test('O2 NUDGE DEAD-LETTER (a) life-abort → NO nudge: the real harness abort message family («tool call aborted» / «tool call aborted before dispatch» / «The tool call was interrupted…» / «…killed…» / «approval for tool X was cancelled» / «the user cancelled X») NEVER gets the nudge — a killed/cancelled turn cannot act on its own abort', async () => {
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      const exec = nudgeExec()
      // (i) the harness tool-runtime abort (dsh-tools TOOL_ABORTED).
      const aborted = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('tool call aborted'), accept)
      assert.equal(nudgeContexts(aborted.additionalContexts).length, 0, '«tool call aborted» (TOOL_ABORTED) is a life-abort — never nudged')
      // (ii) the pre-dispatch abort (ds-tools TOOL_ABORTED_BEFORE_DISPATCH, fb-69).
      const preDispatch = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('tool call aborted before dispatch'), accept)
      assert.equal(nudgeContexts(preDispatch.additionalContexts).length, 0, '«tool call aborted before dispatch» is a life-abort — never nudged')
      // (iii) the W9-b cancel close (the interrupted-tool-result closer).
      const interrupted = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('The tool call was interrupted after it was recorded, but no result was durably recorded.'), accept)
      assert.equal(nudgeContexts(interrupted.additionalContexts).length, 0, 'the W9-b interrupted-tool-result close is a life-abort — never nudged')
      // (iv) the churn/restart-kill class.
      const killed = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('the process was killed by restart'), accept)
      assert.equal(nudgeContexts(killed.additionalContexts).length, 0, 'a killed-by-restart turn is a life-abort — never nudged')
      // (v) the CANCEL class — the real dsh-tools approval shape (B3-P2 gap
      // closed: «approval for tool "<name>" was cancelled») + the R4 cancel
      // datum («the user cancelled <tool>»).
      const approvalCancel = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('approval for tool "dept_exec" was cancelled'), accept)
      assert.equal(nudgeContexts(approvalCancel.additionalContexts).length, 0, 'the «approval for tool X was cancelled» abort (class cancel) is NEVER nudged')
      const userCancel = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('the user cancelled ask_user_question'), accept)
      assert.equal(nudgeContexts(userCancel.additionalContexts).length, 0, '«the user cancelled <tool>» (class cancel) is NEVER nudged')
    } finally {
      dispose()
    }
  })
})

test('O2 NUDGE DEAD-LETTER (a) life-abort explicit FLAG → NO nudge: an `aborted: true` marker on the EXEC or on the RESULT suppresses even a non-abort-worded message; `aborted: false` is NOT a marker (the flag must be strictly true — the genuine-error path stays intact)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      // (i) the exec carries the aborted flag (the harness cancel shape).
      const execFlagged = { ...nudgeExec(), aborted: true }
      const fromExec = await pluginCtx().waterfall('tools/post-execute', execFlagged, nudgeErrorResult('some tool exploded'), accept)
      assert.equal(nudgeContexts(fromExec.additionalContexts).length, 0, 'an EXEC with aborted:true is never nudged (the flag path)')

      // (ii) the RESULT carries the aborted flag.
      const flaggedResult = { ...nudgeErrorResult('some tool exploded'), aborted: true }
      const fromResult = await pluginCtx().waterfall('tools/post-execute', nudgeExec(), flaggedResult, accept)
      assert.equal(nudgeContexts(fromResult.additionalContexts).length, 0, 'a RESULT with aborted:true is never nudged (the flag path)')

      // (iii) CONTROL — aborted:false is NOT a marker → the genuine error NUDGES.
      const falseFlagged = { ...nudgeErrorResult('some tool exploded'), aborted: false }
      const control = await pluginCtx().waterfall('tools/post-execute', nudgeExec(), falseFlagged, accept)
      assert.equal(nudgeContexts(control.additionalContexts).length, 1, 'aborted:false is NOT a life-abort marker — the real error still gets its nudge')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// (b) RETIRED post → NO nudge / NO splice
// ---------------------------------------------------------------------------

test('O2 NUDGE DEAD-LETTER (b) a RETIRED post is NEVER nudged AND nothing is spliced: the waterfall fires with the RETIRED post as the executing agent → 0 nudge contexts and the downstream decision (its additionalContexts) returned VERBATIM — while a LIVE caller error in the SAME fixture still gets its nudge', async () => {
  await withTempStateDir(async (stateDir) => {
    const RETIRED_POST = 'worker-o2-dead-b156'
    await seedPost(stateDir, {
      postId: RETIRED_POST,
      sessionId: 'worker-o2-dead-b156-aaaaaaaa',
      role: 'builder',
      managerId: 'internal-programming-head',
      retired: true
    })
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      // (a) CONTROL — a LIVE caller (a post id unknown to the registry) error
      // still gets its nudge (fresh class — the dedupe set is per-factory).
      const liveDecision = await pluginCtx().waterfall('tools/post-execute', nudgeExec('dept_exec', { id: 'probe-agent' }), nudgeErrorResult('some live worker boom'), accept)
      assert.equal(nudgeContexts(liveDecision.additionalContexts).length, 1, 'a LIVE caller error still gets the nudge')

      // The durable cold load (boot.ts:820 loadPosts) is fire-and-forget —
      // await the seeded RETIRED entry landing in the catalog before firing
      // the retired waterfall (the real-path de-flake).
      const catalogOf = () => pluginCtx().get('deepartments.catalog')
      await waitFor(() => catalogOf()?.byPost.get(RETIRED_POST)?.retired === true, 5000, 'the seeded RETIRED post to land in the catalog')
      assert.equal(catalogOf()?.byPost.get(RETIRED_POST)?.retired, true, 'the seeded retired post is DURABLE in the catalog with retired:true')

      // (b) the RETIRED post error → NO nudge AND NO splice: the downstream
      // (a listener returning its own additionalContexts) is preserved
      // VERBATIM — the handler never touches the decision for a retired post.
      const downstreamContexts = [{ role: 'user', content: [{ type: 'text', text: 'downstream context' }], source: { kind: 'plugin', plugin: 'someone-else' } }]
      const downstream = () => Promise.resolve({ kind: 'accept', additionalContexts: downstreamContexts })
      const retiredExec = { name: 'dept_exec', arguments: { command: 'probe' }, agent: { id: RETIRED_POST } }
      const retiredDecision = await pluginCtx().waterfall('tools/post-execute', retiredExec, nudgeErrorResult('boom after retire'), downstream)
      assert.equal(retiredDecision.kind, 'accept', 'the downstream accept is preserved for a retired post')
      assert.equal(nudgeContexts(retiredDecision.additionalContexts).length, 0, 'a RETIRED post is NEVER nudged (dead-letter suppression — no dead-letter splice)')
      assert.deepEqual(retiredDecision.additionalContexts ?? [], downstreamContexts, 'NOTHING is spliced into a retired post\'s context — the downstream contexts are returned VERBATIM')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// (c) real (non-abort) tool error → nudge 1 (the contract intact)
// ---------------------------------------------------------------------------

test('O2 NUDGE DEAD-LETTER (c) a genuine non-abort tool error keeps the FULL nudge contract: exactly ONE nudge plugin/notice with the exact line, PREPENDED before the downstream contexts, accept preserved, a SUCCESS never nudged, a downstream block untouched', async () => {
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      const exec = nudgeExec()
      // (i) a genuine error → exactly ONE nudge, exact line, plugin/notice form.
      const errDecision = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('some tool exploded'), accept)
      assert.equal(errDecision.kind, 'accept', 'the downstream accept decision is preserved on an error')
      const errNudges = nudgeContexts(errDecision.additionalContexts)
      assert.equal(errNudges.length, 1, 'a genuine errored result gets exactly ONE nudge context')
      assert.equal(errNudges[0].source.form, 'notice', 'the nudge is a plugin/notice context (never a user-typed message)')
      assert.equal(errNudges[0].content[0].text, FEEDBACK_NUDGE_LINE, 'the context text is the exact nudge line')
      assert.ok(String(errNudges[0].source.summary ?? '').includes('dept_feedback'), 'the notice summary names the dept_feedback channel')

      // (ii) PREPEND: the nudge comes FIRST, the downstream contexts verbatim.
      const preExisting = [{ role: 'user', content: [{ type: 'text', text: 'downstream context' }], source: { kind: 'plugin', plugin: 'someone-else' } }]
      const preDecision = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('boom'), () => Promise.resolve({ kind: 'accept', additionalContexts: preExisting }))
      const preCtxs = preDecision.additionalContexts ?? []
      assert.equal(preCtxs.length, 2, 'the nudge joins the downstream contexts (nothing dropped)')
      assert.equal(preCtxs[0].content[0].text, FEEDBACK_NUDGE_LINE, 'the nudge is PREPENDED (repeat-tool-reminder convention)')
      assert.equal(preCtxs[1], preExisting[0], 'the downstream context is preserved verbatim')

      // (iii) SUCCESS → NO nudge (the normal flow is untouched).
      const okDecision = await pluginCtx().waterfall('tools/post-execute', exec, { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'ok' }] }, accept)
      assert.equal(nudgeContexts(okDecision.additionalContexts).length, 0, 'a SUCCESS never receives the nudge')

      // (iv) a downstream BLOCK is preserved with the nudge (opción A discarded).
      const blockFeedback = [{ type: 'text', text: 'blocked by a downstream policy' }]
      const blockDecision = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('boom again'), () => Promise.resolve({ kind: 'block', feedback: blockFeedback }))
      assert.equal(blockDecision.kind, 'block', 'a downstream block decision is preserved')
      assert.deepEqual(blockDecision.feedback, blockFeedback, 'the block feedback content is untouched')
      assert.equal(nudgeContexts(blockDecision.additionalContexts).length, 1, 'a block on an errored result still carries the nudge context')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// (d) dedupe 1b intact
// ---------------------------------------------------------------------------

test('O2 NUDGE DEAD-LETTER (d) dedupe 1b intact: an error whose message ALREADY carries the inline nudge line (the guard-denial wrappers) is NOT double-nudged, and the SAME (postId, turn, error-class) is nudged ONCE — a DIFFERENT class in the same turn still gets its own nudge', async () => {
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, dispose } = await smokeBoot(stateDir)
    try {
      const exec = nudgeExec()
      // (i) the inline-line dedup (1b — dept_exec / dept_zstd_read denials).
      const inlineDecision = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult(`[deepartments] dept_exec: OUT_OF_SCOPE / DENIED — x\n${FEEDBACK_NUDGE_LINE}`), accept)
      assert.equal(nudgeContexts(inlineDecision.additionalContexts).length, 0, 'an error that already carries the inline nudge line is NOT double-nudged (dedup 1b)')

      // (ii) per-turn (postId, turn, error-class) dedup: SAME class → 1 nudge.
      const first = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('boom'), accept)
      assert.equal(nudgeContexts(first.additionalContexts).length, 1, 'the FIRST same-class error of the turn gets the nudge')
      const second = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('boom'), accept)
      assert.equal(nudgeContexts(second.additionalContexts).length, 0, 'the SECOND same-class error of the same turn is NOT re-nudged (dedup by (postId, turn, error-class))')

      // (iii) a DIFFERENT error class in the same turn still gets its OWN nudge.
      const other = await pluginCtx().waterfall('tools/post-execute', exec, nudgeErrorResult('a different error class'), accept)
      assert.equal(nudgeContexts(other.additionalContexts).length, 1, 'a DIFFERENT class in the same turn still gets its own nudge')
    } finally {
      dispose()
    }
  })
})