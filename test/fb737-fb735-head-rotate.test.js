// dsh-deepartments — fb-737 + fb-735 lane test (`dept_head_rotate`, run token
// 58ac0588). Own file BY design: test/invoke.test.js is edited by another live
// lane (the fb-20 writer-conflict class) — this lane never writes there.
//
// ITEM A — fb-737: the THREE surfaces that contradicted the CURRENT norm
// `fb-190` (ROTACIÓN EN SILENCIO, docs/VERIFICATION-LADDER.md:169-186) and the
// reason the fix is a SUBSTITUTION, not an append:
//   1. the tool DESCRIPTION (what the host reads FIRST),
//   2. the RUNNING-rejection ERROR text,
//   3. the COMMENT above it (the SOURCE of the doctrine — fix only the string
//      and the next editor regenerates the defect from the comment).
// The old prescription conditioned a retry on «the head declared ready» — a
// signal NO instrument exposes (`headRotateRunningDiagnostics` returns only
// runningSinceMs / lastWakeMs / tailPastBound, and nothing else reports such a
// declaration). A prescription asking the reader to evaluate an `if` whose
// signal it cannot observe is not guidance, it is a LOOP INSTRUCTION — the
// class this lane names «condición de reintento NO OBSERVABLE ⇒ instrucción de
// bucle» (measured cost: 2 failed rotations for the host).
//
// ITEM B — fb-735: the bounded wait of the REAL turn (the R8 settle-wait at
// tools.ts only covers the FINALIZATION TAIL, DEEPARTMENTS_HEAD_ROTATE_SETTLE_MS,
// default 5s). `wait: true` + `waitMaxMs` DEFER instead of refusing, with the
// smart_restart semantics copied (dsh-smart-restart src/boot.ts `waitForIdle`:
// bounded by a declared default, waitedMs = the wall-clock REALLY spent, a
// spent budget refuses stating what it observed). The refusal must DECLARE what
// it saw (runningSince + lastWake + waitedMs) — a mute refusal lets the host
// re-enter the loop through another door and B buys nothing.
//
// EFFECT, NOT PRESENCE (fb-729): every runtime assertion below EXECUTES a real
// rotation through the REAL registered tool against a REAL boot composition
// (the r8-liveness-race harness, reused — not reinvented). The ONLY textual
// check is the COMMENT (surface 3), which has no runtime effect, and it is
// DECLARED as textual below.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { SessionId } from '@deepseek-ai/dsh-session'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createScope } from '@deepseek-ai/dsh-scope'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

/** The stale doctrine that fb-737 removes. Named ONCE so every assertion below
 *  checks the SAME string (and so a future reader sees exactly what was
 *  retired). */
const STALE_DOCTRINE = 'immediate retry is legitimate'

// ---------------------------------------------------------------------------
// E2 HARNESS — the REAL Loader composition (the r8-liveness-race smokeBoot
// shape, reused verbatim in spirit: the bundle driven through the real
// packages, dept_who / dept_head_rotate being the REAL registered tools).
// ---------------------------------------------------------------------------

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

/** Agents service that MATERIALIZES a REAL scoped cordis child context and RUNS
 * the postSetup setup closure. `status` is the mutable stub field the tests flip
 * ('idle' ⇄ 'running') — the SAME live signal the tools read. */
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
      status: 'idle',
      options: options.agentOptions ?? {},
      ctx: undefined,
      session: {
        header: { id: sessionId, parentSession: options.parentSession },
        events: [...(Array.isArray(options.seed) ? options.seed : [])],
        get seq() { return this.events.length },
        snapshotEvents() { return this.events },
        requestHeader() { return undefined }
      },
      inboxMessages: [],
      followup(message) { this.inboxMessages.push(message) },
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
    webServer: root.get('webServer'),
    dispose: () => loaderFiber.dispose()
  }
}

const DEPARTMENT = {
  id: 'internal-programming',
  name: 'Internal Programming',
  roomId: 'room-ipd',
  coordinator: {
    postId: 'internal-programming-head',
    role: 'Internal Programming department head',
    provider: 'deepseek-official',
    agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' }
  }
}

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** The host caller (a non-registered session — the HOST plane the rotate accepts). */
function fakeHostAgent(id = `host-${cryptoRandom()}`) {
  return {
    id,
    status: 'idle',
    ctx: { get: () => undefined },
    session: { header: { id }, events: [], get seq() { return this.events.length }, snapshotEvents() { return this.events }, requestHeader() { return undefined } },
    followup() {},
    cancel() {},
    async whenIdle() {}
  }
}

function cryptoRandom() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function seedJournal(stateDir, postId, summary) {
  const journalPath = path.join(stateDir, 'journals', `${postId}.md`)
  await mkdir(path.dirname(journalPath), { recursive: true })
  const content = [
    '---',
    `author: ${postId}`,
    `timestamp: ${new Date().toISOString()}`,
    'wake_counter: 1',
    'board_cursor: none',
    'decisions: []',
    'constraints: []',
    'open_items: []',
    '---',
    '',
    summary,
    ''
  ].join('\n')
  await writeFile(journalPath, content, 'utf8')
  return journalPath
}

async function readPosts(stateDir) {
  const postsPath = path.join(stateDir, 'posts.json')
  let parsed
  await waitFor(async () => {
    try {
      parsed = JSON.parse(await readFile(postsPath, 'utf8'))
      return true
    } catch {
      return false
    }
  }, 5000, 'posts.json readable')
  return parsed
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-fb737-'))
  try {
    return await fn(stateDir)
  } finally {
    const deadline = Date.now() + 2000
    for (;;) {
      try {
        await rm(stateDir, { recursive: true, force: true })
        break
      } catch {
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, 25))
      }
    }
  }
}

/** Set a hermetic R8 settle bound for ONE rotate call and restore after (the env
 * knob is read at call time → a per-call override is deterministic). */
async function withSettleMs(ms, fn) {
  const prev = process.env.DEEPARTMENTS_HEAD_ROTATE_SETTLE_MS
  if (ms === undefined) delete process.env.DEEPARTMENTS_HEAD_ROTATE_SETTLE_MS
  else process.env.DEEPARTMENTS_HEAD_ROTATE_SETTLE_MS = String(ms)
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.DEEPARTMENTS_HEAD_ROTATE_SETTLE_MS
    else process.env.DEEPARTMENTS_HEAD_ROTATE_SETTLE_MS = prev
  }
}

/** Boot a hermetic composition with the configured head materialized. */
async function bootWithHead(stateDir, postId) {
  await seedJournal(stateDir, postId, 'fb-737/fb-735 SEED: carried into the fresh session.')
  const env = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, agents: true })
  await waitFor(() => env.agentsStub.store.has(`head-${postId}`), 8000, 'head materialized at boot')
  return env
}

// ---------------------------------------------------------------------------
// ITEM A — fb-737 (EFFECT): the REAL rejection text + the description the host
// actually reads. Executed against a REAL 'running' head with the REAL tool.
// ---------------------------------------------------------------------------
test('fb-737 (A, EFFECT): the REAL RUNNING rejection of dept_head_rotate cites the fb-190 norm (ROTACIÓN EN SILENCIO) + names ONE action on an OBSERVABLE signal, and the stale «immediate retry is legitimate» prescription is GONE', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'internal-programming-head'
    const env = await bootWithHead(stateDir, postId)
    try {
      const signal = new AbortController().signal
      const head = env.agentsStub.store.get(`head-${postId}`)
      // A REAL turn in flight: the handle stays 'running' through the whole
      // bound (never rotated — fb-115 preserved).
      const pushNow = Date.now()
      const turnStart = pushNow - 60_000
      const lastWake = pushNow - 59_000
      head.session.events.push(
        { type: 'turn/start', seq: head.session.events.length, time: turnStart, data: { turn: 1 } },
        { type: 'agent/inbox/spliced', seq: head.session.events.length, time: lastWake, data: {} }
      )
      head.status = 'running'
      let captured
      await withSettleMs(50, () =>
        assert.rejects(
          env.root.tools.get('dept_head_rotate').execute({ postId, reason: 'fb-737: real turn in flight' }, { agent: fakeHostAgent(), signal }),
          (error) => {
            captured = String(error instanceof Error ? error.message : error)
            return true
          },
          'a REAL running turn is still rejected'
        )
      )
      // (1) the CURRENT norm rides the text: fb-190 + its qualifier + fb-115.
      assert.match(captured, /fb-190/, 'the rejection cites fb-190 (the current norm)')
      assert.match(captured, /ROTACIÓN EN SILENCIO/, 'the rejection names the norm, not just its id')
      assert.match(captured, /VERIFICATION-LADDER\.md:169-186/, 'the rejection LOCATES the norm (the citation the host can check)')
      assert.match(captured, /fb-115/, 'the re-check-before-rotating practice (fb-115) stays cited')
      assert.match(captured, /announce the rotation to the outgoing head in its own turn/, 'the self-induced race is stated (why the announcement is harmful)')
      // (2) ONE action, on an OBSERVABLE signal — never an un-evaluable `if`.
      assert.match(captured, /re-consult dept_who and rotate only on a row whose liveStatus is idle/, 'the prescription names ONE action on an observable signal (dept_who liveStatus)')
      // The UNOBSERVABLE condition must not be a PRESCRIPTION. («a head that
      // just declared ready CAN STILL BE RUNNING ITS TAIL» is the fb-190
      // qualifier — the norm REQUIRES it, so only the conditional-retry forms
      // are forbidden.)
      assert.doesNotMatch(captured, /if the head declared ready/, 'no retry is conditioned on «the head declared ready» (the UNOBSERVABLE condition — fb-737 core)')
      assert.doesNotMatch(captured, /declared ready, an immediate retry/, 'the un-evaluable retry prescription is absent')
      // (3) the stale doctrine is GONE from the runtime text.
      assert.ok(!captured.includes(STALE_DOCTRINE), `the stale prescription («${STALE_DOCTRINE}») is NOT in the emitted error`)
      assert.ok(!captured.includes('immediate retry'), 'no «immediate retry» instruction survives in the emitted error')
      // (4) the OBSERVABILITY of fb-220 survives (the new text never drops it).
      assert.ok(captured.includes(new Date(turnStart).toISOString()), 'running-since still rides the rejection (fb-220 intact)')
      assert.ok(captured.includes(new Date(lastWake).toISOString()), 'last-wake still rides the rejection (fb-220 intact)')
      head.status = 'idle'
    } finally {
      await env.dispose()
    }
  })
})

test('fb-737 (A, EFFECT): the DESCRIPTION emitted by the tool registry (the text the host actually reads FIRST) carries the fb-190 qualifier + fb-735 `wait`, and the stale prescription is absent', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'internal-programming-head'
    // The FULL composition (head materialized + awaited): the description is
    // read from the SAME registry the runtime call above uses, and disposing
    // before the boot materialization settles would race the child setup.
    const env = await bootWithHead(stateDir, postId)
    try {
      // The REGISTRY entry — the same object the harness/agent reads.
      const tool = env.root.tools.get('dept_head_rotate')
      assert.equal(typeof tool.description, 'string', 'the registered tool exposes a description')
      const description = tool.description
      assert.match(description, /fb-190/, 'the description cites fb-190')
      assert.match(description, /ROTACIÓN EN SILENCIO/, 'the description names the norm')
      assert.match(description, /docs\/VERIFICATION-LADDER\.md:169-186/, 'the description locates the norm')
      assert.match(description, /fb-115/, 'the description keeps the fb-115 re-check')
      assert.match(description, /do NOT announce the rotation to the outgoing head in its own turn/, 'the description states the DO-NOT (the norm itself, not a pointer)')
      assert.match(description, /liveStatus idle/, 'the description names the OBSERVABLE idle signal')
      assert.match(description, /wait:true/, 'the description documents the fb-735 deferral')
      assert.match(description, /waitedMs/, 'the description documents the observed waitedMs')
      assert.ok(!description.includes(STALE_DOCTRINE), `the stale prescription («${STALE_DOCTRINE}») is NOT in the registered description`)
      assert.ok(!description.includes('immediate retry'), 'no «immediate retry» survives in the registered description')
      assert.doesNotMatch(description, /declared ready, an immediate retry/, 'the un-evaluable retry prescription is gone from the description')
      // The parameters the host reads too (`defineTool` compiles the declared
      // spec to a JSON Schema — properties, not flat keys).
      assert.equal(tool.parameters.properties.wait.type, 'boolean', 'the registry exposes `wait` (boolean)')
      assert.equal(tool.parameters.properties.waitMaxMs.type, 'number', 'the registry exposes `waitMaxMs` (number)')
      assert.ok(tool.output.schema.properties.waitedMs, 'the registry exposes `waitedMs` on the output schema')
    } finally {
      await env.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// ITEM A — surface 3 (the SOURCE comment): DECLARED TEXTUAL. A comment has NO
// runtime effect, so this is a conscious source check — the old doctrine must
// be ABSENT and the new norm PRESENT (otherwise the next editor regenerates the
// defect from the comment; that is exactly why the fix includes it).
// ---------------------------------------------------------------------------
test('fb-737 (A, TEXTUAL — declared as such): the SOURCE comment carries the new norm and NO occurrence of the stale doctrine survives anywhere in src/tools.ts', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts'), 'utf8')
  assert.ok(!source.includes(STALE_DOCTRINE), `the stale doctrine («${STALE_DOCTRINE}») is ABSENT from the whole sources (comment included — the SOURCE of the defect)`)
  assert.ok(!/declared ready[^\n]{0,40}immediate retry/i.test(source), 'no comment asserts the un-evaluable retry doctrine')
  // The new norm is IN the comment (not only in the string it generates).
  assert.match(source, /condición de reintento NO OBSERVABLE ⇒ instrucción de bucle/, 'the comment NAMES the defect class (so the next editor cannot re-derive the loop instruction)')
  assert.match(source, /fb-190 \(ROTACIÓN EN SILENCIO, docs\/VERIFICATION-LADDER\.md:169-186\) \+ fb-115/, 'the comment ties the rejection to the current norm + fb-115')
  assert.match(source, /SUBSTITUTION, never an[\s\S]{0,24}append/, 'the comment states the rule (substitute, never append a second prescription)')
})

// ---------------------------------------------------------------------------
// ITEM B — fb-735 (EFFECT, RUN 1 of 2): the turn CLOSES inside the budget ⇒
// the rotation PROCEDES in the same call and waitedMs > 0.
// ---------------------------------------------------------------------------
test('fb-735 (B-i, EFFECT): with wait:true the rotation PROCEEDS for a head whose real turn CLOSES inside waitMaxMs, and the result carries waitedMs > 0', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'internal-programming-head'
    const env = await bootWithHead(stateDir, postId)
    try {
      const oldSessionId = `head-${postId}`
      const head = env.agentsStub.store.get(oldSessionId)
      const signal = new AbortController().signal
      // The real turn is in flight and CLOSES 200ms in (the driver's turn-end
      // transition the wait polls for; the first poll lands at ~1000ms).
      head.status = 'running'
      const flipTimer = setTimeout(() => { head.status = 'idle' }, 200)
      try {
        const started = Date.now()
        const result = await env.root.tools.get('dept_head_rotate').execute({ postId, reason: 'fb-735 B-i: turn closes inside the budget', wait: true, waitMaxMs: 5000 }, { agent: fakeHostAgent(), signal })
        const elapsed = Date.now() - started
        assert.notEqual(result.sessionId, oldSessionId, 'the rotation PROCEEDED (a fresh session was minted) — the wait deferred instead of refusing')
        assert.equal(result.previousSessionId, oldSessionId, 'the old session is recorded as the previous incarnation')
        assert.equal(typeof result.waitedMs, 'number', 'the result carries waitedMs (the honest accounting)')
        assert.ok(result.waitedMs > 0, `waitedMs > 0 — the call really waited (got ${result.waitedMs}ms)`)
        assert.ok(result.waitedMs <= elapsed + 50, 'waitedMs is the wall-clock really spent, never beyond the call')
        assert.ok(elapsed < 5000, 'the call did NOT spend the whole budget (the turn closed early)')
        assert.ok(env.agentsStub.store.has(result.sessionId), 'the fresh head is live')
        const posts = await readPosts(stateDir)
        assert.equal(posts[postId].sessionId, result.sessionId, 'the durable entry points at the FRESH session (the rotation committed)')
      } finally {
        clearTimeout(flipTimer)
      }
    } finally {
      await env.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// ITEM B — fb-735 (EFFECT, RUN 2 of 2): the turn does NOT close ⇒ the budget is
// spent ⇒ EXPLICIT refusal that DECLARES WHAT IT OBSERVED (runningSince +
// lastWake + waitedMs). A mute refusal re-opens the host's loop.
// ---------------------------------------------------------------------------
test('fb-735 (B-ii, EFFECT): with wait:true and a turn that does NOT close, the spent budget refuses loudly DECLARING what it observed (running-since + last-wake + waitedMs) and no rotation happens', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'internal-programming-head'
    const env = await bootWithHead(stateDir, postId)
    try {
      const oldSessionId = `head-${postId}`
      const signal = new AbortController().signal
      const head = env.agentsStub.store.get(oldSessionId)
      const pushNow = Date.now()
      const turnStart = pushNow - 60_000
      const lastWake = pushNow - 59_000
      head.session.events.push(
        { type: 'turn/start', seq: head.session.events.length, time: turnStart, data: { turn: 1 } },
        { type: 'agent/inbox/spliced', seq: head.session.events.length, time: lastWake, data: {} }
      )
      head.status = 'running'
      let captured
      await assert.rejects(
        env.root.tools.get('dept_head_rotate').execute({ postId, reason: 'fb-735 B-ii: turn never closes', wait: true, waitMaxMs: 500 }, { agent: fakeHostAgent(), signal }),
        (error) => {
          captured = String(error instanceof Error ? error.message : error)
          return true
        },
        'the spent budget refuses EXPLICITLY (never a silent give-up)'
      )
      // WHAT IT OBSERVED — the three declared figures.
      assert.ok(captured.includes(new Date(turnStart).toISOString()), 'the refusal declares running-since (the turn/start event ISO time)')
      assert.ok(captured.includes(new Date(lastWake).toISOString()), 'the refusal declares last-wake (the agent/inbox/spliced ISO time)')
      assert.match(captured, /waitedMs \d+ms of the 500ms wait budget/, 'the refusal declares waitedMs against the budget it just spent')
      assert.match(captured, /the turn did NOT close inside it/, 'the refusal states the turn did not close inside the budget')
      // The norm + the ONE observable action still ride it (fb-737 not undone).
      assert.match(captured, /fb-190/, 'the spent-budget refusal cites fb-190 too')
      assert.match(captured, /re-consult dept_who and rotate only on a row whose liveStatus is idle/, 'the spent-budget refusal names ONE action on an observable signal')
      assert.ok(!captured.includes(STALE_DOCTRINE), 'the stale prescription is absent from the spent-budget refusal as well')
      assert.doesNotMatch(captured, /if the head declared ready/, 'no un-evaluable condition in the spent-budget refusal')
      assert.doesNotMatch(captured, /declared ready, an immediate retry/, 'no un-evaluable retry prescription in the spent-budget refusal')
      // NO rotation happened (the rejection is pre-dispose/pre-mint).
      assert.equal(env.agentsStub.createCalls.filter((c) => String(c.sessionId) !== oldSessionId).length, 0, 'no fresh mint on a spent-budget refusal')
      head.status = 'idle'
    } finally {
      await env.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// R6 CONTROL — without `wait` the behavior is the pre-fb-735 one, EXACTLY: the
// R8 settle-wait then the loud refusal, and NO waitedMs field on success.
// ---------------------------------------------------------------------------
test('fb-735 (R6 control): WITHOUT `wait` the R8 behavior is intact — the settle-wait proceeds for a closing tail, a real turn still refuses, and the successful result carries NO waitedMs field', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'internal-programming-head'
    const env = await bootWithHead(stateDir, postId)
    try {
      const oldSessionId = `head-${postId}`
      const head = env.agentsStub.store.get(oldSessionId)
      const signal = new AbortController().signal
      // (1) the finalization tail closes inside the R8 settle window → proceeds.
      head.status = 'running'
      const flipTimer = setTimeout(() => { head.status = 'idle' }, 150)
      let result
      try {
        result = await withSettleMs(3000, () =>
          env.root.tools.get('dept_head_rotate').execute({ postId, reason: 'fb-735 R6: settle-wait path untouched' }, { agent: fakeHostAgent(), signal })
        )
      } finally {
        clearTimeout(flipTimer)
      }
      assert.notEqual(result.sessionId, oldSessionId, 'the R8 settle-wait still proceeds for a tail that closes inside the bound')
      assert.equal('waitedMs' in result, false, 'without `wait` the result keeps the pre-fb-735 shape (no waitedMs — never a fabricated 0)')
      const rendered = env.root.tools.get('dept_head_rotate').output.render({ postId }, result)
      assert.ok(!String(rendered[0].text).includes('waited'), 'the render stays byte-identical without `wait`')
      // (2) a REAL turn in flight still refuses (fb-115 preserved) WITHOUT the
      // fb-735 budget sentence (that belongs to a spent `wait`).
      const freshHead = env.agentsStub.store.get(result.sessionId)
      freshHead.status = 'running'
      let captured
      await withSettleMs(50, () =>
        assert.rejects(
          env.root.tools.get('dept_head_rotate').execute({ postId, reason: 'fb-735 R6: real turn' }, { agent: fakeHostAgent(), signal }),
          (error) => {
            captured = String(error instanceof Error ? error.message : error)
            return true
          },
          'a real turn is still refused without `wait`'
        )
      )
      assert.match(captured, /is RUNNING \(state running\)/, 'the R8 refusal core is intact')
      assert.ok(!captured.includes('wait budget'), 'no fb-735 budget sentence without `wait` (zero regression)')
      freshHead.status = 'idle'
    } finally {
      await env.dispose()
    }
  })
})
