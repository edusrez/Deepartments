// dsh-deepartments — R8 LIVENESS-RACE test (LANE R8: «race de liveness dept_who
// vs dept_head_rotate», run token 39852b56). Reproduces + locks the round's
// fix for the 3-datapoint feedback family fb-143/144/145 (2026-09-04/05):
//
//   - THE RACE: dept_who reported a member 'idle' and dept_head_rotate (the
//     SAME window) rejected it as 'RUNNING' — 3/3 (IPH 23:55Z · QH 00:07Z ·
//     QH 00:17Z even with the head DECLARING «MEMO LISTO, ventana libre»).
//   - DIAGNOSIS (file:line): BOTH tools read the SAME live signal —
//     `agents.get(SessionId(sid))?.status === 'running'` — dept_who through
//     buildCatalogRows (packages/dshd-orchestration/src/boot.ts:527/544 →
//     computeDeptWhoState, src/agents.ts:119-130) and dept_head_rotate through
//     its free-window check (packages/dshd-orchestration/src/tools.ts: ~5810).
//     The registry (posts.json) is NOT the source of the state — the LIVE
//     handle is. The delta is TEMPORAL: between the dept_who read and the
//     rotate read a wake can land (fb-143/144: fifo-gate drain m-1335/m-1341/
//     m-1344, settlements) OR the head's OWN declaration turn is still
//     finalizing (fb-145: the send_message that delivered «MEMO LISTO» runs
//     INSIDE the live turn; the harness AgentStatus is binary 'idle'|'running'
//     — dsh-agent runtime-types.d.ts:45 — so the driver keeps 'running' until
//     the turn fully drains/closes; there IS no 'finalizing' status). The
//     rejection was correct-by-design (fb-115) but the signal was race-prone.
//   - THE FIX (both halves of the reinforced fb-145 proposal):
//     (a) dept_who exposes the VERBATIM live-handle status per row
//         (`liveStatus` — the raw driver signal, absent when offline) so the
//         «confirm idle via dept_who» guidance is verifiable.
//     (b) dept_head_rotate RE-VERIFIES with a BOUNDED AUTOMATIC SETTLE-WAIT
//         (DEEPARTMENTS_HEAD_ROTATE_SETTLE_MS, default 5s): a turn that closes
//         within the window (the finalization tail / a short wake turn)
//         proceeds in the SAME free window; a turn still running past the
//         bound rejects with the SAME loud reason (fb-115 preserved — never
//         rotate a REAL in-flight turn).
//
// Test layout (one case per datapoint + the controls, the r5/r6 self-contained
// pattern — the bundle is driven through the REAL Loader composition):
//   1. idle-declared vs running-real (fb-143/144 class) — a status 'running'
//      handle with a tiny settle bound → rotate REJECTS with the clear reason.
//   2. running-declared idle, finalizing tail (fb-145 class) — the handle is
//      'running' but flips to 'idle' within the settle window → rotate
//      SUCCEEDS in the same window (automatic retry; fresh session minted).
//   3. 'finalizando turno' VERIFIABILITY (fix (a)) — dept_who rows carry
//      liveStatus when the handle is live ('running' mid-turn) and omit it
//      when offline (F9 lossless), so the protocol guidance is verifiable.
//   4. DORMANT normal (control) — a head with NO live handle (slept/dormant)
//      rotates WITHOUT friction (no settle wait, no rejection).
//   + a pure diagnostic lock: BOTH tools read agents.get(sid).status (the same
//     expression) — the race is temporal, not registry-vs-live.
//
// Hermetic: temp stateDir; the E2 boots the REAL Loader composition (dshd-core
// + the 6 P1 packages + dshd-orchestration + the bundle — the r5 smokeBoot
// shape) and drives the REAL registered dept_who / dept_head_rotate through the
// composed bundle.
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

// ---------------------------------------------------------------------------
// PURE DIAGNOSTIC LOCK — the race is TEMPORAL, not registry-vs-live: BOTH tools
// read the SAME live signal. The state COMPUTATION is pure (computeDeptWhoState
// in src/agents.ts:119-130): retired → offline, sleeping → sleeping,
// live && running → running, live → idle, else offline. The harness driver
// status is BINARY (dsh-agent runtime-types.d.ts:45: 'idle' | 'running') — the
// 'finalizing tail' of a turn is still 'running' (the driver drains/closes/
// checkpoints under that status), which is exactly the window fb-145 hit.
// ---------------------------------------------------------------------------
test('R8 (diagnostic): dept_who state and dept_head_rotate free-window check read the SAME live expression — agents.get(sid)?.status === "running" (the race is temporal, a wake/finalization landing between the two reads)', () => {
  // The dept_who row builder (boot.ts:527/544) and the rotate check both
  // derive 'running' from the LIVE handle status; the registry contributes
  // only the durable markers (retired/sleepEpoch). The delta is a TIME gap.
  const srcBoot = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'boot.ts'), 'utf8')
  const srcTools = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts'), 'utf8')
  // boot.ts buildCatalogRows: running = agents.get(sid)?.status === 'running'.
  assert.match(srcBoot, /postAgent\?\.status === 'running'/, 'buildCatalogRows derives running from the LIVE handle status (boot.ts)')
  assert.match(srcBoot, /hostAgent\?\.status === 'running'/, 'the host row uses the same live expression')
  // tools.ts dept_head_rotate: live = agents?.get(sessionId); reject when live.status === 'running'.
  assert.match(srcTools, /const live = agents\?\.get\(sessionId\)/, 'the rotate free-window check reads the SAME live handle')
  assert.match(srcTools, /live\.status === 'running'/, 'the rotate rejects on the SAME status signal')
  // The harness status is BINARY — 'finalizing' is not a driver state; the
  // declaration send runs inside the still-'running' turn (fb-145 mechanism).
  assert.match(srcTools, /AgentStatus is binary 'idle'\|'running'/, 'the settle-wait comment documents the binary-status mechanism (no fabricated finalizing state)')
})

// ---------------------------------------------------------------------------
// E2 HARNESS — the REAL Loader composition (the r5/boot-factory smokeBoot
// shape): the bundle driven through the real packages; dept_who /
// dept_head_rotate are the REAL registered tools of the composed factory.
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
 * the postSetup setup closure (installHeadBoardTools lands on the post's own
 * layer). Status is a mutable stub field the tests flip ('idle' ⇄ 'running') —
 * mirroring the harness AgentHandle.status the real driver manages. */
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

/** The REAL Loader composition of the dev-profile subset (dshd-core + the 6 P1
 * packages + dshd-orchestration + the bundle, in order) — the r5 smokeBoot
 * pattern (hermetic temp stateDir). */
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

/** The department the boot wiring drives (the coordinator the rotate targets). */
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

/** The host caller (a non-registered session — the HOST plane dept_head_rotate
 * accepts exactly this). */
function fakeHostAgent(id = `host-${SessionId(cryptoRandom())}`) {
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

/** crypto-strong random suffix without pulling node:crypto at module top. */
function cryptoRandom() {
  // node:test does not constrain the id shape; a timestamp+random suffix is
  // unique enough for the hermetic host registration (host-<id>).
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

async function seedPost(stateDir, { postId, sessionId = `head-${postId}`, roomId, agentPreset = 'deepartments-head', sleepEpoch, previousChildId }) {
  const postsPath = path.join(stateDir, 'posts.json')
  let existing = {}
  try {
    existing = JSON.parse(await readFile(postsPath, 'utf8'))
  } catch {
    /* no prior seed */
  }
  const entry = { sessionId, roomId, agentPreset }
  if (sleepEpoch !== undefined) entry.sleepEpoch = sleepEpoch
  if (previousChildId !== undefined) entry.previousChildId = previousChildId
  existing[postId] = entry
  await writeFile(postsPath, JSON.stringify(existing, null, 2), 'utf8')
}

/** Read the durable post entry (the fresh-mint registers a new sessionId). */
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
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-r8-'))
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

/** Set a hermetic settle bound for ONE rotate call and restore after (the env
 * knob is read at call time, so a per-call override is deterministic). */
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

// ---------------------------------------------------------------------------
// DATAPOINT TESTS
// ---------------------------------------------------------------------------

test('R8 fb-143/144 (idle-declarado vs running-real): dept_who reports the member state from the LIVE handle; a head whose handle is ' + "'running'" + ' (a REAL turn in flight) is REJECTED by dept_head_rotate with the clear free-window reason even after the settle window — fb-115 preserved (never rotate a real turn)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'internal-programming-head'
    await seedJournal(stateDir, postId, 'R8-SEED: carried into the fresh session.')
    const env = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, agents: true })
    try {
      // Boot wiring materializes the configured head through the bundle.
      await waitFor(() => env.agentsStub.store.has(`head-${postId}`), 8000, 'head materialized at boot')
      const signal = new AbortController().signal
      // dept_who (the protocol read): the head is resident; flip its handle to
      // 'running' (the wake landed between the dept_who read and the rotate —
      // the fb-143/144 class) and the SAME live handle is what the rotate reads.
      const whoTool = env.root.tools.get('dept_who')
      const head = env.agentsStub.store.get(`head-${postId}`)
      head.status = 'running'
      const who = await whoTool.execute({}, { agent: fakeHostAgent(), signal })
      const row = who.members.find((m) => m.agentId === postId)
      assert.equal(row.state, 'running', 'dept_who reflects the LIVE handle (a running head is running in the roster)')
      // The rotate with a TINY settle bound (the turn stays running forever —
      // a REAL turn in flight) MUST reject with the clear reason.
      await withSettleMs(50, () =>
        assert.rejects(
          env.root.tools.get('dept_head_rotate').execute({ postId, reason: 'R8 fb-143/144: real turn in flight' }, { agent: fakeHostAgent(), signal }),
          /is RUNNING \(state running\) — rotate only in a free window \(head idle; re-check dept_who\)/,
          'a REAL running turn is never rotated — the SAME loud rejection survives the settle window (fb-115)'
        )
      )
      // No fresh session was minted (the rejection is pre-dispose/pre-mint).
      assert.equal(env.agentsStub.createCalls.filter((c) => String(c.sessionId) !== `head-${postId}`).length, 0, 'no fresh mint on a rejected rotation')
      head.status = 'idle'
    } finally {
      await env.dispose()
    }
  })
})

test('R8 fb-145 (running-declared-idle / finalizing tail): a head whose handle is ' + "'running'" + ' but whose turn CLOSES within the settle window is rotated in the SAME free window — the automatic settle-wait re-verifies and proceeds (the rotation that rejected 3/3 now succeeds)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'internal-programming-head'
    await seedJournal(stateDir, postId, 'R8-SEED: the finalizing turn closes within the settle bound.')
    const env = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, agents: true })
    try {
      await waitFor(() => env.agentsStub.store.has(`head-${postId}`), 8000, 'head materialized at boot')
      const oldSessionId = `head-${postId}`
      const head = env.agentsStub.store.get(oldSessionId)
      const signal = new AbortController().signal
      // The head DECLARED «memo listo / ventana libre» — its handle is STILL
      // 'running' for the finalization tail (the fb-145 mechanism: the
      // declaration ran inside the live turn; the driver keeps 'running' until
      // the turn closes). The settle-wait must let the tail close and rotate.
      head.status = 'running'
      // The turn closes shortly after the rotate starts (a test-driven flip —
      // the driver's turn-end transition the fix waits for).
      const flipTimer = setTimeout(() => { head.status = 'idle' }, 250)
      try {
        const result = await withSettleMs(3000, () =>
          env.root.tools.get('dept_head_rotate').execute({ postId, reason: 'R8 fb-145: declared ready, tail finalizing' }, { agent: fakeHostAgent(), signal })
        )
        assert.notEqual(result.sessionId, oldSessionId, 'the SAME free window proceeds: a fresh session is minted when the finalizing turn closes inside the settle bound')
        assert.equal(result.previousSessionId, oldSessionId, 'the old session is recorded as the previous incarnation')
        assert.equal(result.postId, postId)
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

test('R8 fix (a): dept_who exposes the VERBATIM live-handle status (liveStatus) — a live turning head carries liveStatus "running" (the verifiable finalization-tail window), an idle head "idle", and an OFFLINE head omits the field (F9 lossless)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'internal-programming-head'
    await seedJournal(stateDir, postId, 'R8-SEED: dept_who liveStatus exposure.')
    const env = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, agents: true })
    try {
      await waitFor(() => env.agentsStub.store.has(`head-${postId}`), 8000, 'head materialized at boot')
      const signal = new AbortController().signal
      const whoTool = env.root.tools.get('dept_who')
      const head = env.agentsStub.store.get(`head-${postId}`)
      const host = fakeHostAgent()
      // (1) Idle handle → liveStatus 'idle' (the raw driver token).
      head.status = 'idle'
      let who = await whoTool.execute({}, { agent: host, signal })
      let row = who.members.find((m) => m.agentId === postId)
      assert.equal(row.live, true, 'the head handle is live')
      assert.equal(row.liveStatus, 'idle', 'the VERBATIM live-handle status rides the row (idle)')
      assert.equal(row.state, 'idle', 'the collapsed state agrees')
      // (2) Running handle → liveStatus 'running' (a turn in flight — incl.
      // the finalization tail fb-145 hit; the protocol reader sees the RAW
      // signal the rotate re-verifies).
      head.status = 'running'
      who = await whoTool.execute({}, { agent: host, signal })
      row = who.members.find((m) => m.agentId === postId)
      assert.equal(row.liveStatus, 'running', 'the verbatim live-handle status is ' + "'running'" + ' while the turn is in flight')
      assert.equal(row.state, 'running', 'the collapsed state agrees')
      // (3) Handle gone (offline) → liveStatus ABSENT (F9 lossless — never
      // undefined; the row keeps its pre-R8 shape for offline).
      head.status = 'idle'
      env.agentsStub.store.delete(`head-${postId}`)
      who = await whoTool.execute({ scope: 'all' }, { agent: host, signal })
      row = who.members.find((m) => m.agentId === postId)
      assert.equal(row.live, false, 'no live handle')
      assert.equal(row.liveStatus, undefined, 'liveStatus is ABSENT when the handle is offline (F9-conditioned spread)')
      assert.equal('liveStatus' in row, false, 'the key itself is not emitted for an offline row')
      // (4) The render carries the live-handle suffix for live rows (the
      // roster text mirrors the verifiable signal).
      const liveRendered = env.root.tools.get('dept_who').output.render({}, { members: [{ ...row, live: true, liveStatus: 'running', state: 'running' }], retiredCount: 0, inactiveHiddenCount: 0 })
      assert.match(liveRendered[0].text, /, handle:running/, 'the roster render shows the verbatim live-handle status')
    } finally {
      await env.dispose()
    }
  })
})

test('R8 DORMANT normal (control): a head with NO live handle (the durable entry exists, the handle is absent — the offline/dormant state) rotates WITHOUT friction — no settle wait, no rejection, fresh session minted', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'internal-programming-head'
    const oldSessionId = `head-${postId}`
    await seedJournal(stateDir, postId, 'R8-SEED: dormant-head rotation.')
    // A durable entry (the head exists in the registry) but NO live handle —
    // the offline/dormant state the rotate must accept without friction.
    await seedPost(stateDir, { postId, sessionId: oldSessionId, agentPreset: 'deepartments-head' })
    const env = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, agents: true })
    try {
      await waitFor(() => env.agentsStub.store.has(oldSessionId), 8000, 'head materialized at boot')
      // Make it DORMANT: drop the live handle (the durable entry stays). The
      // free-window check reads agents.get(sid) === undefined → free window.
      env.agentsStub.store.delete(oldSessionId)
      const signal = new AbortController().signal
      const result = await withSettleMs(undefined, () =>
        env.root.tools.get('dept_head_rotate').execute({ postId, reason: 'R8 dormant control' }, { agent: fakeHostAgent(), signal })
      )
      assert.notEqual(result.sessionId, oldSessionId, 'the dormant head rotates without friction (fresh session minted)')
      assert.equal(result.previousSessionId, oldSessionId, 'previous = the dormant old session')
      assert.equal(result.archived, false, 'no live handle → the archive degrades (workspace registry absent in this composition) — non-fatal')
      const posts = await readPosts(stateDir)
      assert.equal(posts[postId].sessionId, result.sessionId, 'the durable entry moved to the fresh session')
      assert.equal(posts[postId].sleepEpoch, undefined, 'a rotation is NOT sleep — no sleep mark on the fresh mint')
      assert.equal(env.agentsStub.store.has(result.sessionId), true, 'the fresh head is live')
    } finally {
      await env.dispose()
    }
  })
})