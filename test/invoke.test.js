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
    followup(message) {
      this.inboxMessages.push(message)
    },
    steer() {},
    inject() {},
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

function executeDeptInvoke(pluginCtx, parent, args = { room: 'board', assignment: 'ping the research coordinator' }) {
  const tool = pluginCtx.tools.get('dept_invoke')
  assert.ok(tool, 'dept_invoke registered on the plugin scope')
  return tool.execute(
    { ...args },
    { agent: parent, signal: new AbortController().signal }
  )
}

// --- tests ---------------------------------------------------------------------

test('dept_invoke: ensures the coordinator, forks, posts the assignment, and returns the continuable id', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, spawnStub, forkStub, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())

      const result = await executeDeptInvoke(pluginCtx(), parent)

      // Returns the continuable shape immediately.
      assert.equal(result.kind, 'continuable')
      assert.ok(typeof result.subagentId === 'string' && result.subagentId.length > 0)
      assert.equal(result.roomId, 'board')
      assert.ok(typeof result.messageId === 'string' && result.messageId.length > 0)

      // Coordinator ensured (create #0) + fork started (create #1), through
      // the REAL continuation manager and the stub providers.
      assert.equal(agents.createCalls.length, 2, 'coordinator + fork materialized')
      assert.equal(spawnStub.prepareCalls.length, 1, 'coordinator created on the spawn provider')
      assert.equal(forkStub.prepareCalls.length, 1, 'fork created on the fork provider')
      assert.equal(spawnStub.prepareCalls[0].parent, parent, 'coordinator parent is the calling agent')
      assert.equal(forkStub.prepareCalls[0].parent, parent, 'fork parent is the calling agent')

      // Coordinator carries the LLM route from agentOptions and the durable lineage.
      assert.equal(agents.createCalls[0].agentOptions.provider, 'stub-coord')
      assert.equal(agents.createCalls[0].agentOptions.model, 'deepseek-v4-flash')
      assert.equal(agents.createCalls[0].meta.parentSession, parent.id)
      assert.equal(agents.createCalls[1].meta.parentSession, parent.id)

      // The fork is the returned subagent; the registry persisted both posts.
      const forkChildId = agents.createCalls[1].sessionId
      assert.equal(result.subagentId, forkChildId)
      const posts = await readPosts(stateDir)
      assert.equal(posts['research-head'].childId, agents.createCalls[0].sessionId)
      assert.equal(posts['research-head'].parentId, parent.id)
      assert.equal(posts['research-head'].roomId, 'research')
      const forkPostId = Object.keys(posts).find((key) => key.startsWith('asistente-fork-'))
      assert.equal(forkPostId, `asistente-fork-${forkChildId}`)
      assert.equal(posts[forkPostId].childId, forkChildId)
      assert.equal(posts[forkPostId].roomId, 'board')

      // The assignment rides the board file with the expected addressing.
      const records = await loadRecords(resolveBoardPath(stateDir, 'board'))
      const assignment = records.find((record) => record.kind === 'message')
      assert.ok(assignment, 'assignment record in board.jsonl')
      assert.equal(assignment.from, 'asistente')
      assert.deepEqual(assignment.to, ['research-head'])
      assert.equal(assignment.payload.text, 'ping the research coordinator')
      assert.equal(result.messageId, assignment.id)

      // The wake relay woke the coordinator (the board delta lands in its inbox).
      const coordinator = agents.childAgents[0]
      assert.ok(coordinator.inboxMessages.length >= 1, 'coordinator received the wake')
      const wake = coordinator.inboxMessages.at(-1)
      assert.match(wake.content[0].text, /Board delta in board/)
      assert.match(wake.content[0].text, /new message \S+ from asistente/)
      assert.doesNotMatch(wake.content[0].text, /ping the research coordinator/, 'relay does not embed the message body (pointer-only)')
      assert.equal(wake.source.kind, 'coordinator')

      // Error path: no calling agent.
      const tool = pluginCtx().tools.get('dept_invoke')
      await assert.rejects(
        () => tool.execute({ room: 'board', assignment: 'x' }, { signal: new AbortController().signal }),
        /requires a calling agent/
      )
    } finally {
      await dispose()
    }
  })
})

test('detached signals: the coordinator and fork outlive the dept_invoke tool execution', async () => {
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
        { room: 'board', assignment: 'ping the research coordinator' },
        { agent: parent, signal: execAbort.signal }
      )
      assert.equal(result.kind, 'continuable')
      assert.equal(agents.createCalls.length, 2)

      // The signals handed to startContinuable are NOT the tool-execution
      // signal — they are detached (the regression this test guards).
      const coordinatorCreate = agents.createCalls[0]
      const forkCreate = agents.createCalls[1]
      assert.ok(coordinatorCreate.signal, 'a signal is provided (the manager requires one)')
      assert.notEqual(coordinatorCreate.signal, execAbort.signal)
      assert.notEqual(forkCreate.signal, execAbort.signal)

      // Simulate the tool execution ending / the parent turn being cancelled:
      // the children must not observe any abort and must keep working.
      execAbort.abort(new Error('tool execution ended'))
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(coordinatorCreate.signal.aborted, false, 'coordinator creation signal never aborted')
      assert.equal(forkCreate.signal.aborted, false, 'fork creation signal never aborted')
      assert.equal(agents.childAgents[0].callerSignalAborted(), false, 'coordinator saw no caller abort')
      assert.equal(agents.childAgents[1].callerSignalAborted(), false, 'fork saw no caller abort')

      // The children keep working after the tool return: the wake relay still
      // delivers a board message to the coordinator.
      const posts = await readPosts(stateDir)
      const forkPostId = Object.keys(posts).find((key) => key.startsWith('asistente-fork-'))
      const coordinator = agents.childAgents[0]
      const before = coordinator.inboxMessages.length
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, forkPostId, ['research-head'], 'still alive?'), 'board')
      assert.equal(coordinator.inboxMessages.length, before + 1, 'wake delivery works after the tool return')
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
      await executeDeptInvoke(pluginCtx(), parent)
      const posts = await readPosts(stateDir)
      const forkPostId = Object.keys(posts).find((key) => key.startsWith('asistente-fork-'))
      const coordinator = agents.childAgents[0]
      const fork = agents.childAgents[1]
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      assert.ok(boardSession)

      const coordBefore = coordinator.inboxMessages.length // 1: the assignment wake
      const forkBefore = fork.inboxMessages.length

      // 1. fork → coordinator: the coordinator is woken.
      let seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, forkPostId, ['research-head'], 'question one'), 'board')
      assert.equal(coordinator.inboxMessages.length, coordBefore + 1)
      const wake = coordinator.inboxMessages.at(-1)
      assert.match(wake.content[0].text, /Board delta in board/)
      assert.match(wake.content[0].text, new RegExp(`new message \\S+ from ${forkPostId}`))
      assert.doesNotMatch(wake.content[0].text, /question one/, 'relay does not embed the message body (pointer-only)')
      assert.equal(wake.source.kind, 'coordinator')
      assert.equal(wake.source.senderSessionId, fork.id, 'sender session is the fork child session')

      // 2. self-addressed message: sender is NOT woken (echo-loop guard).
      seq += 1
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'research-head', ['research-head'], 'self note'), 'board')
      assert.equal(coordinator.inboxMessages.length, coordBefore + 1, 'no self-wake')

      // 3. unknown member: skipped.
      seq += 1
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', ['ghost'], 'who?'), 'board')
      assert.equal(coordinator.inboxMessages.length, coordBefore + 1, 'unknown member not woken')
      assert.equal(fork.inboxMessages.length, forkBefore, 'fork not woken')

      // 4. coordinator reply → fork: the fork is woken.
      seq += 1
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'research-head', [forkPostId], 'answer one'), 'board')
      assert.equal(fork.inboxMessages.length, forkBefore + 1)
      assert.match(fork.inboxMessages.at(-1).content[0].text, /new message \S+ from research-head/)
      assert.doesNotMatch(fork.inboxMessages.at(-1).content[0].text, /answer one/, 'relay does not embed the message body (pointer-only)')

      // 5. parent not live: wake skipped (documented rc.6 limitation) — no crash.
      agents.store.delete(parent.id)
      seq += 1
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', ['research-head'], 'nobody home'), 'board')
      assert.equal(coordinator.inboxMessages.length, coordBefore + 1, 'no wake without a live parent')
      assert.equal(fork.inboxMessages.length, forkBefore + 1)
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
      const fork = agents.childAgents[1]

      // Both children (coordinator + fork) received the four tools.
      assert.equal(agents.childContexts.length, 2)
      for (const { ctx: childCtx, key } of agents.childContexts) {
        assert.ok(childCtx.tools.get('dept_room_read', key), 'dept_room_read installed')
        assert.ok(childCtx.tools.get('dept_room_write', key), 'dept_room_write installed')
        assert.ok(childCtx.tools.get('dept_witness_write', key), 'dept_witness_write installed')
        assert.ok(childCtx.tools.get('dept_room_who', key), 'dept_room_who installed')
      }
      // Scoped to the children — never global.
      assert.equal(root.tools.get('dept_room_read'), undefined)
      assert.equal(root.tools.get('dept_witness_write'), undefined)
      assert.equal(root.tools.get('dept_room_who'), undefined)

      const forkCtx = agents.childContexts[1].ctx
      const forkKey = agents.childContexts[1].key
      const signal = new AbortController().signal

      // dept_room_write posts from the fork's member id.
      const writeResult = await forkCtx.tools.get('dept_room_write', forkKey).execute(
        { room: 'board', to: ['research-head'], text: 'hello coordinator' },
        { agent: fork, signal }
      )
      assert.equal(writeResult.from, forkPostId, 'posted under the fork member id')
      assert.deepEqual(writeResult.to, ['research-head'])

      // A coordinator reply addressed to the fork arrives in its delta.
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

test('dept_invoke: explicit `to` addresses a sibling fork post and leaves the coordinator untouched', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, spawnStub, forkStub, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())

      const result = await executeDeptInvoke(pluginCtx(), parent, {
        room: 'board',
        assignment: 'a message for the other fork',
        to: ['asistente-fork-sibling']
      })

      // Returns the continuable shape as usual; the sibling fork is the subagent.
      assert.equal(result.kind, 'continuable')
      assert.ok(typeof result.subagentId === 'string' && result.subagentId.length > 0)
      assert.equal(result.roomId, 'board')

      // With an explicit `to`, the coordinator is NOT ensured/created: only the
      // fork is materialized.
      assert.equal(spawnStub.prepareCalls.length, 0, 'no coordinator creation with an explicit `to`')
      assert.equal(forkStub.prepareCalls.length, 1, 'fork created on the fork provider')
      assert.equal(agents.createCalls.length, 1, 'only the fork materialized')

      // The assignment board record addresses the sibling fork post.
      const records = await loadRecords(resolveBoardPath(stateDir, 'board'))
      const assignment = records.find((record) => record.kind === 'message')
      assert.ok(assignment, 'assignment record in board.jsonl')
      assert.equal(assignment.from, 'asistente')
      assert.deepEqual(assignment.to, ['asistente-fork-sibling'])
      assert.equal(assignment.payload.text, 'a message for the other fork')

      // The fork prompt (delivered as the fork's first inbox message) carries
      // the mission and the target member id, and is mission-driven rather than
      // a hardcoded coordinator-only script.
      const forkPrompt = agents.childAgents[0].inboxMessages[0].content[0].text
      assert.match(forkPrompt, /a message for the other fork/)
      assert.match(forkPrompt, /asistente-fork-sibling/)
      assert.match(forkPrompt, /The assignment is addressed to: asistente-fork-sibling/)
      assert.doesNotMatch(forkPrompt, /research coordinator/, 'no coordinator-only forced prompt with an explicit `to`')
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
      const fork = agents.childAgents[1]
      const forkCtx = agents.childContexts[1].ctx
      const forkKey = agents.childContexts[1].key
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

      // No coordinator post leaks in: it lives in room 'research'.
      const allPosts = result.posts
      assert.equal(allPosts.some((post) => post.postId === 'research-head'), false, 'coordinator post not in the board roster')

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

test('truncation fix: pointer-only relay, full fetch by id without cursor advance, and explicit TOC preview truncation', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent())
      await executeDeptInvoke(pluginCtx(), parent)
      const posts = await readPosts(stateDir)
      const forkPostId = Object.keys(posts).find((key) => key.startsWith('asistente-fork-'))
      const coordinator = agents.childAgents[0]
      const fork = agents.childAgents[1]
      const forkCtx = agents.childContexts[1].ctx
      const forkKey = agents.childContexts[1].key
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      assert.ok(boardSession)
      const signal = new AbortController().signal
      const read = (args) => forkCtx.tools.get('dept_room_read', forkKey).execute({ room: 'board', ...args }, { agent: fork, signal })

      // (a) wake relay is pointer-only: it identifies the message by id + from
      // but NEVER embeds the body text, even for a long message.
      const longRelay = 'Z'.repeat(300)
      let seq = await nextSeq(stateDir, 'board')
      const longRec = messageRecord(seq, forkPostId, ['research-head'], longRelay)
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), longRec, 'board')
      const relayWake = coordinator.inboxMessages.at(-1)
      assert.match(relayWake.content[0].text, new RegExp(`new message ${longRec.id} from ${forkPostId}`))
      assert.ok(!relayWake.content[0].text.includes(longRelay.slice(0, 25)), 'relay carries no body text at all')

      // (b) fetch by messageId returns the FULL text of a message longer than
      // 240 chars, and does NOT advance the cursor (a default read still serves it).
      const longBody = 'X'.repeat(500)
      seq += 1
      const longMsg = messageRecord(seq, 'research-head', [forkPostId], longBody)
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
      const shortA = messageRecord(seq, forkPostId, ['research-head'], 'alpha one')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), shortA, 'board')
      seq += 1
      const shortB = messageRecord(seq, 'research-head', [forkPostId], 'beta two')
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
      const fork = agents.childAgents[1]
      const forkCtx = agents.childContexts[1].ctx
      const forkKey = agents.childContexts[1].key
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      assert.ok(boardSession)
      const signal = new AbortController().signal
      const read = (args) => forkCtx.tools.get('dept_room_read', forkKey).execute({ room: 'board', ...args }, { agent: fork, signal })

      // Two candidates for the fork (both from /= the fork member id). The
      // coordinator assignment is not addressed to the fork, so the fork's
      // candidate list is exactly [M1, M2].
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
