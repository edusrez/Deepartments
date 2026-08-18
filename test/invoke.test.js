// dsh-deepartments — dept_invoke / board toolset / wake relay tests.
//
// Rule 5 (AGENTS.md): tests go through the REAL Cordis Loader with the REAL
// dsh services (sessions, sessionProjections, systemPrompt, tools) AND the
// REAL SubagentRuntime continuation manager, with STUB subagent providers
// (prepareContinuable → {seed: []}) and stub agents/persistence services —
// the continuation seam's boundary. Hermetic: temp stateDirs, no network,
// no live DSH_HOME, no LLM. Tests run against the compiled lib/
// (pnpm build first).
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { loadRecords, resolveBoardPath } from '../lib/board-store.js'
import { emitRoomRecord, roomSessionId } from '../lib/org.js'

// --- test organization (mirrors cordis.patch.yml, with a stub LLM route) -----

const TEST_ORG = {
  rooms: [
    { id: 'board', name: 'Board of directors', purpose: 'Coordination room', members: ['asistente', 'research-head'] },
    { id: 'research', name: 'Research department', purpose: 'Research department room', members: ['research-head'] }
  ],
  departments: [
    {
      id: 'research',
      name: 'Research',
      roomId: 'research',
      coordinator: {
        postId: 'research-head',
        role: 'Research department head',
        provider: 'deepseek-official',
        agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' }
      }
    }
  ]
}

// --- stubs --------------------------------------------------------------------

/** Subagent provider stub: continuable-capable, records prepare calls. */
function stubProvider(name) {
  const provider = {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: name === 'fork',
    prepareCalls: [],
    async start() {
      throw new Error(`stub provider "${name}": one-shot start is not used in these tests`)
    },
    async prepareContinuable(request) {
      provider.prepareCalls.push(request)
      return { seed: [] }
    }
  }
  return provider
}

/**
 * Stub agents service: satisfies the REAL SubagentContinuationManager's
 * materialization contract (create → setup(childCtx) → commit → resident
 * handle). Child contexts are REAL scoped cordis contexts (createScope — the
 * same mechanism the real agent factory uses), so registrations from
 * registerContinuableSetup land in the child's own tool layer.
 */
class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.createCalls = []
    this.childContexts = []
    this.childAgents = []
    this.scopeAnchor = ctx
  }

  get(id) {
    return this.store.get(id)
  }

  list() {
    return [...this.store.values()]
  }

  roots() {
    return [...this.store.values()]
  }

  put(agent) {
    this.store.set(agent.id, agent)
    return agent
  }

  async create(options) {
    this.createCalls.push(options)
    // Replicate the REAL agent factory's caller-signal wiring (dsh-agent-loop
    // prepare(): callerSignal.addEventListener("abort", onCallerAbort) →
    // creation-scoped abort). If dept_invoke passed exec.signal, the child
    // would see this listener fire when the tool execution ends.
    let callerSignalAborted = false
    options.signal?.addEventListener('abort', () => {
      callerSignalAborted = true
    }, { once: true })
    const agent = {
      id: options.sessionId,
      options: options.agentOptions ?? {},
      status: 'idle',
      session: {
        header: {
          id: options.sessionId,
          parentSession: options.meta?.parentSession,
          delegationDepth: options.meta?.delegationDepth
        },
        events: []
      },
      inboxMessages: [],
      ctx: undefined,
      callerSignalAborted: () => callerSignalAborted,
      followup(message) {
        this.inboxMessages.push(message)
      },
      steer() {},
      inject() {},
      send() {},
      cancel() {},
      // Never settles: the Activation stays resident for the whole test.
      whenIdle() {
        return new Promise(() => {})
      }
    }
    // The child context must be a REAL scoped cordis context (createScope —
    // the mechanism the real agent factory uses), anchored under the tools
    // entry's fiber ctx: that fiber's store holds both `tools` and
    // `systemPrompt` (own provision + inject snapshot), so the upward service
    // walk resolves childCtx.tools/systemPrompt as traced, scope-aware
    // services (own-property shadowing would bypass the traceable machinery
    // and register sections/tools into the GLOBAL layers).
    const childKey = Symbol('stub-child-scope')
    const scope = createScope(this.scopeAnchor, childKey)
    const childCtx = scope.ctx.extend({ agent })
    agent.ctx = childCtx
    this.childContexts.push({ ctx: childCtx, key: childKey })
    this.childAgents.push(agent)
    const provision = options.setup?.(childCtx)
    provision?.commit?.()
    this.store.set(agent.id, agent)
    return {
      agent,
      dispose: async () => {
        this.store.delete(agent.id)
      }
    }
  }

  async resume() {
    throw new Error('stub agents: resume is not supported in these tests')
  }
}

/** Stub persistence: present (continuable children require it), no sessions. */
class StubPersistence extends Service {
  constructor(ctx) {
    super(ctx, 'sessionPersistence')
  }

  async inspect() {
    throw new Error('stub persistence: no stored sessions')
  }
}

/** A live parent agent as the registry would hold it (exact identity). */
function fakeParentAgent() {
  const id = SessionId(randomUUID())
  return {
    id,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    status: 'idle',
    session: { header: { id }, events: [] },
    ctx: { get: () => undefined },
    inboxMessages: [],
    injectedMessages: [],
    followup(message) {
      this.inboxMessages.push(message)
    },
    steer() {},
    inject(message) {
      this.injectedMessages.push(message)
    },
    send() {},
    cancel() {},
    whenIdle() {
      return new Promise(() => {})
    }
  }
}

// --- boot harness --------------------------------------------------------------

/**
 * Boot the REAL Loader with the REAL dsh services, the REAL SubagentRuntime,
 * stub agents/persistence services, two stub subagent providers, and the
 * dsh-deepartments bundle itself (resolved as a module by the loader).
 */
async function bootPlugin(stateDir) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })

  const agents = new StubAgents(root)
  const persistence = new StubPersistence(root)
  await root.plugin(SubagentRuntime)

  const spawnStub = stubProvider('spawn')
  const forkStub = stubProvider('fork')
  root.subagents.registerProvider(spawnStub)
  root.subagents.registerProvider(forkStub)

  loader.create({
    id: 'deepartments',
    name: '../lib/index.js',
    config: {
      stateDir,
      org: TEST_ORG
    }
  })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return {
    root,
    agents,
    spawnStub,
    forkStub,
    pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx,
    dispose: () => loaderFiber.dispose()
  }
}

async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-invoke-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

async function waitForRooms(root) {
  await waitFor(() => root.sessions.get(SessionId(roomSessionId('board'))) !== undefined && root.sessions.get(SessionId(roomSessionId('research'))) !== undefined, 5000, 'room sessions live')
}

async function nextSeq(stateDir, roomId) {
  const records = await loadRecords(resolveBoardPath(stateDir, roomId))
  return records.length === 0 ? 0 : records[records.length - 1].seq + 1
}

function messageRecord(seq, from, to, text) {
  return {
    id: `t-${seq}-${from}`,
    seq,
    ts: 1700000000000 + seq,
    from,
    to,
    cc: [],
    threadId: null,
    kind: 'message',
    payload: { kind: 'note', text }
  }
}

async function readPosts(stateDir) {
  const postsPath = path.join(stateDir, 'posts.json')
  await waitFor(async () => {
    try {
      await access(postsPath)
      return true
    } catch {
      return false
    }
  }, 5000, 'posts.json written')
  return JSON.parse(await readFile(postsPath, 'utf8'))
}

function executeDeptInvoke(pluginCtx, parent, args = { room: 'board' }) {
  const tool = pluginCtx.tools.get('dept_invoke')
  assert.ok(tool, 'dept_invoke registered on the plugin scope')
  return tool.execute(
    { ...args },
    { agent: parent, signal: new AbortController().signal }
  )
}

// --- tests ---------------------------------------------------------------------

test('dept_invoke: starts only the fork (never a coordinator), delivers the spatial deployment context, injects the parent notice, and returns the continuable id', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, spawnStub, forkStub, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())

      const result = await executeDeptInvoke(pluginCtx(), parent)

      // Returns the continuable shape immediately (no board messageId now: the
      // spatial deployment context rides the followup, not the board file).
      assert.equal(result.kind, 'continuable')
      assert.ok(typeof result.subagentId === 'string' && result.subagentId.length > 0)
      assert.equal(result.roomId, 'board')

      // ONLY the fork is materialized — never a coordinator, on any path.
      assert.equal(agents.createCalls.length, 1, 'only the fork is materialized')
      assert.equal(spawnStub.prepareCalls.length, 0, 'no coordinator is ever created (spawn provider unused)')
      assert.equal(forkStub.prepareCalls.length, 1, 'fork created on the fork provider')
      assert.equal(forkStub.prepareCalls[0].parent, parent, 'fork parent is the calling agent')
      assert.equal(agents.createCalls[0].meta.parentSession, parent.id)

      // The fork is the returned subagent; the registry persists only that post.
      const forkChildId = agents.createCalls[0].sessionId
      assert.equal(result.subagentId, forkChildId)
      const posts = await readPosts(stateDir)
      assert.equal(Object.keys(posts).length, 1, 'registry holds only the fork post')
      assert.equal(Object.hasOwn(posts, 'research-head'), false, 'no coordinator post registered')
      const forkPostId = Object.keys(posts)[0]
      assert.equal(forkPostId, `asistente-fork-${forkChildId}`)
      assert.equal(posts[forkPostId].childId, forkChildId)
      assert.equal(posts[forkPostId].roomId, 'board')

      // The deployment context is NOT written to the board file (Fix B):
      // dept_invoke emits nothing to the board — the context is delivered as
      // official followup to the fork instead. (Only the boot-time 'room-ready'
      // control record exists, and no record carries the deployment text.)
      const boardRecords = await loadRecords(resolveBoardPath(stateDir, 'board'))
      assert.equal(boardRecords.some((record) => (record.payload?.text ?? '').includes('deployment')), false, 'no board record carries the deployment context (rides followup only)')
      assert.equal(boardRecords.some((record) => record.kind === 'message'), false, 'dept_invoke emits no board message')

      // The fork (the only child) received the neutral prompt + the spatial
      // deployment followup.
      const fork = agents.childAgents[0]
      assert.equal(fork.inboxMessages.length, 2, 'fork received the neutral prompt + the spatial deployment followup')
      const promptText = fork.inboxMessages[0].content[0].text
      assert.match(promptText, /You are the Asistente/, 'start prompt is the minimal identity framing')
      assert.match(promptText, /A deployment context will follow/, 'start prompt announces the deployment context')
      assert.doesNotMatch(promptText, /Official context from the deployment|Spatial identity/, 'no deployment context body in the start prompt')
      assert.doesNotMatch(promptText, /board room|"board"|research-head/, 'no room/addressee baked into the start prompt')

      // The spatial deployment context arrives as an OFFICIAL followup with the
      // distinguished coordinator/relay source (the same channel as settlement
      // /report notices) — spatial only, NO mission text.
      const deploy = fork.inboxMessages[1]
      assert.equal(deploy.source.kind, 'coordinator')
      assert.equal(deploy.source.form, 'relay')
      assert.equal(deploy.source.senderSessionId, parent.id)
      const deployText = deploy.content[0].text
      assert.match(deployText, /^Official context from the deployment/, 'deployment text opens with the official-context prefix')
      assert.match(deployText, /room "board"/)
      assert.match(deployText, new RegExp(forkPostId), 'deployment context names the fork post')
      assert.match(deployText, /Spatial identity: kind 'post'/, 'deployment context carries the spatial identity')
      assert.match(deployText, /static members: asistente, research-head/, 'deployment context includes the room presence snapshot')
      assert.match(deployText, /The other copy of you remains in the owner's office/, 'deployment context tells the fork about its sibling copy')
      assert.match(deployText, /dept_whereami/, 'deployment context points at dept_whereami')
      assert.doesNotMatch(deployText, /mission|assignment|ping the research coordinator/, 'deployment context carries NO mission/assignment text')

      // The parent copy (the Asistente that stays with the owner) received a
      // NON-waking injected context notice from the same deployment.
      assert.equal(parent.injectedMessages.length, 1, 'parent copy received one injected context notice')
      const injected = parent.injectedMessages[0]
      assert.notEqual(injected.source.kind, 'user', 'parent-injected source is non-user (renders as CONTEXT)')
      assert.match(injected.content[0].text, /^Official context from the deployment/, 'parent notice opens with the official-context prefix')
      assert.match(injected.content[0].text, new RegExp(forkPostId), 'parent notice names the fork post')
      assert.match(injected.content[0].text, /"board"/, 'parent notice names the board room')

      // Error path: no calling agent.
      const tool = pluginCtx().tools.get('dept_invoke')
      await assert.rejects(
        () => tool.execute({ room: 'board' }, { signal: new AbortController().signal }),
        /requires a calling agent/
      )
    } finally {
      await dispose()
    }
  })
})

test('dept_invoke: injects a non-waking context notice into the parent copy that stays with the owner', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())

      await executeDeptInvoke(pluginCtx(), parent)

      // The parent (the Asistente copy that stays with the owner) received the
      // context notice via Agent.inject — non-waking (no new turn) and recorded
      // by the stub into injectedMessages.
      const posts = await readPosts(stateDir)
      const forkPostId = Object.keys(posts).find((key) => key.startsWith('asistente-fork-'))
      assert.equal(parent.injectedMessages.length, 1, 'the parent copy received exactly one injected context notice')
      const injected = parent.injectedMessages[0]

      // Non-user source so it renders as CONTEXT in the UI (never a user turn).
      assert.notEqual(injected.source.kind, 'user', 'injected source.kind is not user (renders as CONTEXT)')
      assert.equal(injected.source.kind, 'plugin', 'injected source is a plugin/notice so it cannot collide with real subagent sources')

      // Model-visible: the official-context prefix + the spatial identity of
      // the fork being deployed.
      const text = injected.content[0].text
      assert.match(text, /^Official context from the deployment/, 'parent notice opens with the official-context prefix')
      assert.match(text, new RegExp(forkPostId), 'parent notice names the deployed fork post')
      assert.match(text, /"board"/, 'parent notice names the board room')
      assert.match(text, /remained in the owner's office/, 'parent notice frames the parent as the copy that stays')

      // The fork's own inbox is untouched by the parent injection (the injection
      // is only the live parent's concern, not a followup to the fork).
      const fork = agents.childAgents[0]
      assert.equal(fork.inboxMessages.length, 2, 'fork still has only its neutral prompt + deployment followup')
    } finally {
      await dispose()
    }
  })
})

test('detached signals: the fork outlives the dept_invoke tool execution', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())
      const tool = pluginCtx().tools.get('dept_invoke')
      assert.ok(tool)

      // The tool execution's own signal (what exec.signal is in production).
      const execAbort = new AbortController()
      const result = await tool.execute(
        { room: 'board' },
        { agent: parent, signal: execAbort.signal }
      )
      assert.equal(result.kind, 'continuable')
      // Only the fork is materialized (never a coordinator).
      assert.equal(agents.createCalls.length, 1)

      // The signal handed to startContinuable is NOT the tool-execution signal
      // — it is detached (the regression this test guards).
      const forkCreate = agents.createCalls[0]
      assert.ok(forkCreate.signal, 'a signal is provided (the manager requires one)')
      assert.notEqual(forkCreate.signal, execAbort.signal)

      // Simulate the tool execution ending / the parent turn being cancelled:
      // the child must not observe any abort and must keep working.
      execAbort.abort(new Error('tool execution ended'))
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(forkCreate.signal.aborted, false, 'fork creation signal never aborted')
      assert.equal(agents.childAgents[0].callerSignalAborted(), false, 'fork saw no caller abort')

      // The children keep working after the tool return: the wake relay still
      // delivers a board message to a registered sibling fork. A second
      // dept_invoke registers a second fork post to act as the addressed target
      // (no department coordinator can exist to receive the relay anymore).
      await executeDeptInvoke(pluginCtx(), parent)
      const secondFork = agents.childAgents[1]
      const before = secondFork.inboxMessages.length
      const firstForkPostId = Object.keys(await readPosts(stateDir)).find((key) => key.startsWith('asistente-fork-') && key !== `asistente-fork-${agents.childAgents[1].id}`)
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, firstForkPostId, [`asistente-fork-${agents.childAgents[1].id}`], 'still alive?'), 'board')
      assert.equal(secondFork.inboxMessages.length, before + 1, 'wake delivery works after the tool return')
    } finally {
      await dispose()
    }
  })
})

test('wake relay: addressed members are woken through the live shared parent; sender, unknown members, and dead parents are skipped', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())
      // With the coordinator-ensure logic removed there is no department post to
      // receive the relay; two dept_invoke calls register two sibling fork posts
      // and the wake relay is exercised between them. (No coordinator can exist
      // on any path — spawnStub stays untouched.)
      await executeDeptInvoke(pluginCtx(), parent)
      await executeDeptInvoke(pluginCtx(), parent)
      const fork1 = agents.childAgents[0]
      const fork2 = agents.childAgents[1]
      const fork1PostId = `asistente-fork-${fork1.id}`
      const fork2PostId = `asistente-fork-${fork2.id}`
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      assert.ok(boardSession)

      // No initial deployment wake: dept_invoke does not post the deployment to
      // the board (it is delivered as followup context to the fork). Both forks
      // start with just their neutral prompt + the deployment-context followup.
      // All assertions below are relative deltas from these baselines.
      const fork1Before = fork1.inboxMessages.length // 2: prompt + deployment followup
      const fork2Before = fork2.inboxMessages.length // 2: prompt + deployment followup

      // 1. fork1 → fork2: the addressed fork2 is woken.
      let seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, fork1PostId, [fork2PostId], 'question one'), 'board')
      assert.equal(fork2.inboxMessages.length, fork2Before + 1)
      const wake = fork2.inboxMessages.at(-1)
      assert.match(wake.content[0].text, /Board delta in board/)
      assert.match(wake.content[0].text, new RegExp(`new message \\S+ from ${fork1PostId}`))
      assert.doesNotMatch(wake.content[0].text, /question one/, 'relay does not embed the message body (pointer-only)')
      assert.equal(wake.source.kind, 'coordinator')
      assert.equal(wake.source.senderSessionId, fork1.id, 'sender session is the sender fork child session')

      // 2. self-addressed message: sender is NOT woken (echo-loop guard).
      seq += 1
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, fork2PostId, [fork2PostId], 'self note'), 'board')
      assert.equal(fork2.inboxMessages.length, fork2Before + 1, 'no self-wake')

      // 3. unknown member: skipped.
      seq += 1
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', ['ghost'], 'who?'), 'board')
      assert.equal(fork2.inboxMessages.length, fork2Before + 1, 'unknown member not woken')
      assert.equal(fork1.inboxMessages.length, fork1Before, 'fork1 not woken')

      // 4. fork2 reply → fork1: the fork1 is woken.
      seq += 1
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, fork2PostId, [fork1PostId], 'answer one'), 'board')
      assert.equal(fork1.inboxMessages.length, fork1Before + 1)
      assert.match(fork1.inboxMessages.at(-1).content[0].text, new RegExp(`new message \\S+ from ${fork2PostId}`))
      assert.doesNotMatch(fork1.inboxMessages.at(-1).content[0].text, /answer one/, 'relay does not embed the message body (pointer-only)')

      // 5. parent not live: wake skipped (documented rc.6 limitation) — no crash.
      agents.store.delete(parent.id)
      seq += 1
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [fork2PostId], 'nobody home'), 'board')
      assert.equal(fork2.inboxMessages.length, fork2Before + 1, 'no wake without a live parent')
      assert.equal(fork1.inboxMessages.length, fork1Before + 1)
    } finally {
      await dispose()
    }
  })
})

test('registerContinuableSetup: the board toolset is installed into every continuable child and works', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())
      await executeDeptInvoke(pluginCtx(), parent)
      const posts = await readPosts(stateDir)
      const forkPostId = Object.keys(posts).find((key) => key.startsWith('asistente-fork-'))
      const fork = agents.childAgents[0]

      // The single child (the fork) received the five tools.
      assert.equal(agents.childContexts.length, 1)
      for (const { ctx: childCtx, key } of agents.childContexts) {
        assert.ok(childCtx.tools.get('dept_room_read', key), 'dept_room_read installed')
        assert.ok(childCtx.tools.get('dept_room_write', key), 'dept_room_write installed')
        assert.ok(childCtx.tools.get('dept_witness_write', key), 'dept_witness_write installed')
        assert.ok(childCtx.tools.get('dept_room_who', key), 'dept_room_who installed')
        assert.ok(childCtx.tools.get('dept_whereami', key), 'dept_whereami installed')
      }
      // Scoped to the children — never global.
      assert.equal(root.tools.get('dept_room_read'), undefined)
      assert.equal(root.tools.get('dept_witness_write'), undefined)
      assert.equal(root.tools.get('dept_room_who'), undefined)
      assert.equal(root.tools.get('dept_whereami'), undefined)

      const forkCtx = agents.childContexts[0].ctx
      const forkKey = agents.childContexts[0].key
      const signal = new AbortController().signal

      // dept_room_write posts from the fork's member id.
      const writeResult = await forkCtx.tools.get('dept_room_write', forkKey).execute(
        { room: 'board', to: ['research-head'], text: 'hello coordinator' },
        { agent: fork, signal }
      )
      assert.equal(writeResult.from, forkPostId, 'posted under the fork member id')
      assert.deepEqual(writeResult.to, ['research-head'])

      // A board reply addressed to the fork arrives in its delta.
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'research-head', [forkPostId], 'hello fork'), 'board')

      const readResult = await forkCtx.tools.get('dept_room_read', forkKey).execute({ room: 'board' }, { agent: fork, signal })
      assert.match(readResult.delta, /hello coordinator/, 'own message in the delta')
      assert.match(readResult.delta, /hello fork/, 'addressed reply in the delta')
      assert.equal(readResult.member, forkPostId)

      // The cursor advanced: a second read serves nothing new.
      const readAgain = await forkCtx.tools.get('dept_room_read', forkKey).execute({ room: 'board' }, { agent: fork, signal })
      assert.equal(readAgain.delta, 'No board messages addressed to you.')

      // dept_witness_write writes the schema-constrained witness file.
      const witnessResult = await forkCtx.tools.get('dept_witness_write', forkKey).execute(
        { summary: 'assignment satisfied', decisions: ['ship it'], openItems: ['review witness'], constraints: ['keep it concise'] },
        { agent: fork, signal }
      )
      assert.equal(witnessResult.member, forkPostId)
      assert.equal(witnessResult.room, 'board')
      const witnessText = await readFile(witnessResult.witnessPath, 'utf8')
      assert.match(witnessText, new RegExp(`author: ${forkPostId}`))
      assert.match(witnessText, /decisions: \["ship it"\]/)
      assert.match(witnessText, /open_items: \["review witness"\]/)
      assert.match(witnessText, /constraints: \["keep it concise"\]/)
      assert.match(witnessText, /assignment satisfied/)
    } finally {
      await dispose()
    }
  })
})

test('dept_invoke: never creates or coordinates a department post — the `to` path is gone, only the fork is ever materialized', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, spawnStub, forkStub, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())

      // Even though TEST_ORG defines a coordinator in config.org.departments,
      // dept_invoke must NOT create it: the old coordinator-ensure path is gone.
      // There is no `to` parameter anymore — the tool only carries `room`.
      const result = await executeDeptInvoke(pluginCtx(), parent, { room: 'board' })

      // Returns the continuable shape as usual.
      assert.equal(result.kind, 'continuable')
      assert.ok(typeof result.subagentId === 'string' && result.subagentId.length > 0)
      assert.equal(result.roomId, 'board')

      // ONLY the fork is materialized, on every path — the spawn provider is
      // never touched.
      assert.equal(agents.createCalls.length, 1, 'only the fork materialized')
      assert.equal(spawnStub.prepareCalls.length, 0, 'no coordinator is ever created (spawn provider never used)')
      assert.equal(forkStub.prepareCalls.length, 1, 'fork created on the fork provider')

      // The fork is the returned subagent, registered in posts.json with no
      // coordinator entry.
      const forkChildId = agents.createCalls[0].sessionId
      assert.equal(result.subagentId, forkChildId)
      const posts = await readPosts(stateDir)
      assert.equal(Object.keys(posts).length, 1, 'registry holds exactly one post (the fork)')
      assert.equal(Object.hasOwn(posts, 'research-head'), false, 'no coordinator post is registered')
      const forkPostId = Object.keys(posts)[0]
      assert.equal(forkPostId, `asistente-fork-${forkChildId}`)

      // The deployment context is NOT written to the board file: it is delivered
      // as official followup to the fork, spatial only, NO mission.
      const records = await loadRecords(resolveBoardPath(stateDir, 'board'))
      assert.equal(records.some((record) => (record.payload?.text ?? '').includes('deployment')), false, 'no board record carries the deployment context')
      assert.equal(records.some((record) => record.kind === 'message'), false, 'dept_invoke emits no board message')

      // The fork's start prompt is the MINIMAL NEUTRAL identity framing — no
      // mission, no addressee; the spatial deployment context arrives as the
      // official followup carrying the fork post id, the room, and no mission.
      const fork = agents.childAgents[0]
      assert.equal(fork.inboxMessages.length, 2, 'fork received the neutral prompt + the deployment-context followup')
      const forkPrompt = fork.inboxMessages[0].content[0].text
      assert.match(forkPrompt, /You are the Asistente/, 'start prompt is the minimal identity framing')
      assert.doesNotMatch(forkPrompt, /Official context from the deployment|Spatial identity/, 'no deployment context body in the start prompt')
      assert.doesNotMatch(forkPrompt, /research coordinator|research-head/, 'no addressee baked into the start prompt')

      const deploy = fork.inboxMessages[1]
      assert.equal(deploy.source.kind, 'coordinator')
      assert.equal(deploy.source.form, 'relay')
      const deployText = deploy.content[0].text
      assert.match(deployText, /^Official context from the deployment/, 'deployment text opens with the official-context prefix')
      assert.match(deployText, new RegExp(forkPostId), 'deployment context names the fork post')
      assert.match(deployText, /room "board"/)
      assert.doesNotMatch(deployText, /mission|assignment/, 'deployment context carries NO mission/assignment text')
    } finally {
      await dispose()
    }
  })
})

test('dept_room_who: lists static members and only the room\'s registered live posts', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())
      await executeDeptInvoke(pluginCtx(), parent)
      const posts = await readPosts(stateDir)
      const forkPostId = Object.keys(posts).find((key) => key.startsWith('asistente-fork-'))
      const fork = agents.childAgents[0]
      const forkCtx = agents.childContexts[0].ctx
      const forkKey = agents.childContexts[0].key
      const signal = new AbortController().signal
      const tool = forkCtx.tools.get('dept_room_who', forkKey)
      assert.ok(tool, 'dept_room_who available on the fork')

      // Board roster: static members in config order + the fork's post only.
      const result = await tool.execute({ room: 'board' }, { agent: fork, signal })
      assert.equal(result.room, 'board')
      assert.deepEqual(result.members, ['asistente', 'research-head'], 'static members in config order')
      assert.equal(result.posts.length, 1, 'only the fork post is registered in the board room')
      assert.equal(result.posts[0].postId, forkPostId)
      assert.equal(result.posts[0].childId, fork.id)
      assert.equal(result.posts[0].parentId, parent.id)
      assert.equal(result.posts[0].parentLive, true, 'fake parent is live in agents.store')

      // No coordinator post leaks in: with coordinator-ensure removed, no
      // department post exists anywhere in the registry.
      const allPosts = result.posts
      assert.equal(allPosts.some((post) => post.postId === 'research-head'), false, 'no coordinator post in the board roster')

      // Parent removed from agents.store → the post now reports parentLive false.
      agents.store.delete(parent.id)
      const relisted = await tool.execute({ room: 'board' }, { agent: fork, signal })
      assert.equal(relisted.posts.length, 1)
      assert.equal(relisted.posts[0].postId, forkPostId)
      assert.equal(relisted.posts[0].parentLive, false, 'parent offline flagged')

      // Non-configured room: empty members and posts, no throw.
      const missing = await tool.execute({ room: 'nope' }, { agent: fork, signal })
      assert.equal(missing.room, 'nope')
      assert.deepEqual(missing.members, [])
      assert.deepEqual(missing.posts, [])
    } finally {
      await dispose()
    }
  })
})

test('dept_whereami: a registered post gets its spatial identity; the host gets the host shape', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())
      await executeDeptInvoke(pluginCtx(), parent)
      const posts = await readPosts(stateDir)
      const forkPostId = Object.keys(posts).find((key) => key.startsWith('asistente-fork-'))
      const fork = agents.childAgents[0]
      const forkCtx = agents.childContexts[0].ctx
      const forkKey = agents.childContexts[0].key
      const signal = new AbortController().signal
      const tool = forkCtx.tools.get('dept_whereami', forkKey)
      assert.ok(tool, 'dept_whereami available on the fork')

      // Post path: the fork is a registered board post in room 'board'.
      const post = await tool.execute({}, { agent: fork, signal })
      assert.equal(post.kind, 'post')
      assert.equal(post.postId, forkPostId)
      assert.equal(post.roomId, 'board')
      assert.equal(post.childId, fork.id)
      assert.equal(post.parentId, parent.id)
      assert.equal(post.provider, 'fork')
      assert.deepEqual(post.members, ['asistente', 'research-head'], 'static room members in config order')
      assert.equal(post.posts.length, 1, 'only the fork post is registered in the board room')
      assert.equal(post.posts[0].postId, forkPostId)
      assert.equal(post.posts[0].parentLive, true, 'fake parent is live')

      // Host path: the Asistente (fake parent) has NO post entry → host shape.
      const host = await tool.execute({}, { agent: parent, signal })
      assert.equal(host.kind, 'host')
      assert.equal(host.postId, null)
      assert.equal(host.roomId, null)
      assert.match(host.message, /NOT a board post/)

      // Parent removed from agents.store → the fork's post now reports parentLive false.
      agents.store.delete(parent.id)
      const relisted = await tool.execute({}, { agent: fork, signal })
      assert.equal(relisted.kind, 'post')
      assert.equal(relisted.posts[0].parentId, parent.id)
      assert.equal(relisted.posts[0].parentLive, false, 'parent offline flagged in the presence snapshot')

      // Error path: no calling agent.
      await assert.rejects(
        () => tool.execute({}, { signal: new AbortController().signal }),
        /dept_whereami requires a calling agent/
      )
    } finally {
      await dispose()
    }
  })
})

test('dept_invoke: a failed deployment-context followup rolls back the fork post and rejects (no silent orphan)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    // Simulate a delivery failure of the fork's deployment-context followup:
    // the spy passes everything through to the REAL runtime unless the message
    // is the mission-bearing deployment context, which it rejects. dept_invoke
    // must surface this (reject) and roll the just-registered fork post back.
    const realFollowup = root.subagents.followup.bind(root.subagents)
    root.subagents.followup = async (parent, childId, content, options) => {
      const text = content?.[0]?.text ?? ''
      if (/^Official context from the deployment/.test(text)) {
        throw new Error('simulated deployment delivery failure')
      }
      return realFollowup(parent, childId, content, options)
    }
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())

      // The caller learns deployment FAILED — no success result is returned.
      await assert.rejects(
        () => executeDeptInvoke(pluginCtx(), parent),
        /deployment-context delivery failed|rolled back/,
        'dept_invoke rejects when the fork deployment-context delivery fails'
      )

      // The fork existed before the rollback, but the registry no longer holds
      // the orphaned fork post. Only the fork was ever created (no coordinator).
      assert.equal(agents.createCalls.length, 1, 'only the fork was created before the rollback')
      assert.equal(agents.childAgents.length, 1)
      // The registry write is fire-and-forget (persistPosts), so a poll can
      // transiently observe a torn/interleaved write; skip parse errors and
      // re-poll until the rolled-back state settles.
      await waitFor(async () => {
        let posts
        try {
          posts = JSON.parse(await readFile(path.join(stateDir, 'posts.json'), 'utf8'))
        } catch {
          return false
        }
        return !Object.keys(posts).some((key) => key.startsWith('asistente-fork-'))
      }, 5000, 'fork post rolled back out of posts.json')
      const posts = await readPosts(stateDir)
      assert.equal(Object.keys(posts).some((key) => key.startsWith('asistente-fork-')), false, 'no orphaned fork post in the registry')
      assert.equal(Object.keys(posts).length, 0, 'no coordinator entry was ever registered either')
    } finally {
      await dispose()
    }
  })
})

test('truncation fix: pointer-only relay, full fetch by id without cursor advance, and explicit TOC preview truncation', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())
      // Two forks: fork1 is the reader, fork2 is the addressed relay target (the
      // old coordinator/`research-head` relay path no longer has a post to wake,
      // so the relay is exercised against a sibling fork instead).
      await executeDeptInvoke(pluginCtx(), parent)
      await executeDeptInvoke(pluginCtx(), parent)
      const fork1 = agents.childAgents[0]
      const fork2 = agents.childAgents[1]
      const fork1PostId = `asistente-fork-${fork1.id}`
      const fork2PostId = `asistente-fork-${fork2.id}`
      const forkCtx = agents.childContexts[0].ctx
      const forkKey = agents.childContexts[0].key
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      assert.ok(boardSession)
      const signal = new AbortController().signal
      const read = (args) => forkCtx.tools.get('dept_room_read', forkKey).execute({ room: 'board', ...args }, { agent: fork1, signal })

      // (a) wake relay is pointer-only: it identifies the message by id + from
      // but NEVER embeds the body text, even for a long message.
      const longRelay = 'Z'.repeat(300)
      let seq = await nextSeq(stateDir, 'board')
      const longRec = messageRecord(seq, fork1PostId, [fork2PostId], longRelay)
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), longRec, 'board')
      const relayWake = fork2.inboxMessages.at(-1)
      assert.match(relayWake.content[0].text, new RegExp(`new message ${longRec.id} from ${fork1PostId}`))
      assert.ok(!relayWake.content[0].text.includes(longRelay.slice(0, 25)), 'relay carries no body text at all')

      // (b) fetch by messageId returns the FULL text of a message longer than
      // 240 chars, and does NOT advance the cursor (a default read still serves it).
      const longBody = 'X'.repeat(500)
      seq += 1
      const longMsg = messageRecord(seq, 'research-head', [fork1PostId], longBody)
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), longMsg, 'board')
      const fetched = await read({ messageId: longMsg.id })
      assert.match(fetched.delta, new RegExp(`Full text of ${longMsg.id}`))
      assert.equal(fetched.delta.endsWith(longBody), true, 'full text present, untruncated')
      assert.doesNotMatch(fetched.delta, /…/, 'no truncation marker in fetch mode')

      // Unknown message id: a clear not-found, no throw.
      const notFound = await read({ messageId: 'm-no-such' })
      assert.match(notFound.delta, /No board message with id "m-no-such" was found/)

      // (c) a subsequent default read still serves the long message (the fetch
      // did not advance the cursor); its TOC preview is truncated with '…'.
      seq += 1
      const shortA = messageRecord(seq, fork1PostId, [fork2PostId], 'alpha one')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), shortA, 'board')
      seq += 1
      const shortB = messageRecord(seq, 'research-head', [fork1PostId], 'beta two')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), shortB, 'board')

      const toc = await read({})
      assert.match(toc.delta, new RegExp(`${'X'.repeat(140)}…`), 'long preview truncated with the explicit … marker')
      assert.doesNotMatch(toc.delta, /X{200,}/, 'no unmarked long body leaked into the TOC')
      assert.match(toc.delta, /alpha one/)
      assert.match(toc.delta, /beta two/)
    } finally {
      await dispose()
    }
  })
})

test('dept_room_read: limit + offset page through the delta (per-member cursor)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())
      await executeDeptInvoke(pluginCtx(), parent)
      const posts = await readPosts(stateDir)
      const forkPostId = Object.keys(posts).find((key) => key.startsWith('asistente-fork-'))
      const fork = agents.childAgents[0]
      const forkCtx = agents.childContexts[0].ctx
      const forkKey = agents.childContexts[0].key
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      assert.ok(boardSession)
      const signal = new AbortController().signal
      const read = (args) => forkCtx.tools.get('dept_room_read', forkKey).execute({ room: 'board', ...args }, { agent: fork, signal })

      // Two candidates for the fork (both from /= the fork member id). Nothing
      // else is addressed to the fork, so the fork's candidate list is exactly
      // [M1, M2].
      let seq = await nextSeq(stateDir, 'board')
      const m1 = messageRecord(seq, forkPostId, ['research-head'], 'page one')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), m1, 'board')
      seq += 1
      const m2 = messageRecord(seq, forkPostId, ['research-head'], 'page two')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), m2, 'board')

      // On a fresh cursor, limit:1 + offset:1 reaches the SECOND message
      // (offset skips the first; limit caps the page at one entry).
      const paged = await read({ limit: 1, offset: 1 })
      assert.match(paged.delta, /page two/, 'offset reached the second message')
      assert.doesNotMatch(paged.delta, /page one/, 'offset skipped the first message')

      // Another offset:0 read from the advanced cursor pages forward one more
      // entry only (nothing new remains).
      const after = await read({ limit: 1, offset: 0 })
      assert.equal(after.delta, 'No board messages addressed to you.')
    } finally {
      await dispose()
    }
  })
})
