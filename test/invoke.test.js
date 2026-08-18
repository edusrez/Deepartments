// dsh-deepartments — board-as-bus tests (host-plane tools + wake relay + host
// identity registry). dept_invoke/fork is retired (Batch A).
//
// Rule 5 (AGENTS.md): tests go through the REAL Cordis Loader with the REAL
// dsh services (sessions, sessionProjections, systemPrompt, tools) AND the
// REAL SubagentRuntime continuation manager, with STUB subagent providers
// (prepareContinuable → {seed: []}) and stub agents/persistence services —
// the continuation seam's boundary. Hermetic: temp stateDirs, no network,
// no live DSH_HOME, no LLM. Tests run against the compiled lib/
// (pnpm build first).
//
// Post-plane tests seed posts.json BEFORE boot (posts are now durable
// residents loaded from disk — Batch A removed the runtime post-creation
// seam), then exercise the REAL wake relay that cold-resumes the dormant post
// via StubAgents.resume — the faithful production path for bringing a
// registered resident back.
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

/**
 * Shared adoption map: durable child session id → its direct parent session id,
 * and whether the parent is live. Used by the stub persistence (to author the
 * resumed child's header) and the stub agents (to set header.parentSession on
 * a cold resume). Seeded by tests that register durable post residents.
 */
const postAdoption = new Map()

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

/** Materialize one (fresh or resumed) agent with the requested identity. */
function materializeStubAgent(agents, sessionId, options) {
  const callerSignal = options.signal
  let callerSignalAborted = false
  callerSignal?.addEventListener('abort', () => {
    callerSignalAborted = true
  }, { once: true })
  const parentSession = options.parentSession ?? options.meta?.parentSession
  const agent = {
    id: sessionId,
    options: options.agentOptions ?? {},
    status: 'idle',
    session: {
      header: {
        id: sessionId,
        parentSession,
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
    // Never settles: the Activation stays resident for the whole test (the
    // settlement watcher just waits on whenIdle forever, which is fine).
    whenIdle() {
      return new Promise(() => {})
    }
  }
  // The child context must be a REAL scoped cordis context (createScope — the
  // mechanism the real agent factory uses), anchored under the tools entry's
  // fiber ctx so the upward service walk resolves childCtx.tools as traced.
  const childKey = Symbol('stub-child-scope')
  const scope = createScope(agents.scopeAnchor, childKey)
  const childCtx = scope.ctx.extend({ agent })
  agent.ctx = childCtx
  agents.childContexts.push({ ctx: childCtx, key: childKey })
  agents.childAgents.push(agent)
  const provision = options.setup?.(childCtx)
  provision?.commit?.()
  agents.store.set(sessionId, agent)
  return {
    agent,
    dispose: async () => {
      agents.store.delete(sessionId)
    }
  }
}

/**
 * Stub agents service: satisfies the REAL SubagentContinuationManager's
 * materialization + cold-resume contract. Child contexts are REAL scoped
 * cordis contexts, so registerContinuableSetup registrations land in the
 * child's own tool layer.
 */
class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.createCalls = []
    this.resumeCalls = []
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
    return materializeStubAgent(this, options.sessionId, options)
  }

  async resume(options) {
    this.resumeCalls.push(options)
    // Cold resume: restore a dormant resident under its DURABLE id (the seeded
    // childId), with header.parentSession from the adoption map, applying the
    // setup closure (board tools install on cold resume exactly like fresh).
    return materializeStubAgent(this, options.resumeSessionId, {
      ...options,
      parentSession: postAdoption.get(options.resumeSessionId)
    })
  }
}

/** Stub persistence: author enough of a resolved session to cold-resume. */
class StubPersistence extends Service {
  constructor(ctx) {
    super(ctx, 'sessionPersistence')
  }

  async inspect(childId) {
    const parentSession = postAdoption.get(childId)
    if (parentSession === undefined) {
      throw new Error('stub persistence: no stored session for this child')
    }
    return {
      meta: { parentSession, seedLength: 0 },
      events: [{
        type: 'subagent/descriptor',
        data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'board-post' }
      }]
    }
  }
}

/** A live parent agent as the registry would hold it (exact identity). */
function fakeParentAgent(id = SessionId(randomUUID())) {
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
 * dsh-deepartments bundle itself.
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

/**
 * Seed a durable post resident into posts.json BEFORE boot, and register its
 * adoption so a cold resume restores it under the same child id. Mirrors what
 * a production posts.json holds for a previously-registered resident post.
 */
async function seedPost(stateDir, { postId, childId, parentId, roomId, provider = 'spawn' }) {
  const postsPath = path.join(stateDir, 'posts.json')
  const existing = {}
  try {
    existing[postId] = JSON.parse(await readFile(postsPath, 'utf8'))
  } catch {
    /* no prior seed */
  }
  existing[postId] = { childId, parentId, roomId, provider }
  await writeFile(postsPath, JSON.stringify(existing, null, 2), 'utf8')
  postAdoption.set(childId, parentId)
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

async function readHosts(stateDir) {
  const hostsPath = path.join(stateDir, 'hosts.json')
  await waitFor(async () => {
    try {
      await access(hostsPath)
      return true
    } catch {
      return false
    }
  }, 5000, 'hosts.json written')
  return JSON.parse(await readFile(hostsPath, 'utf8'))
}

// --- tests ---------------------------------------------------------------------

test('host registration: a non-post agent calling a host-plane board tool resolves host-<sessionId> and the reverse map; dept_whereami returns kind host', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal

      // The HOST plane tools are registered globally on the plugin ctx (the
      // host channel) — a live host agent can call them.
      const writeTool = pluginCtx().tools.get('dept_room_write')
      assert.ok(writeTool, 'dept_room_write registered globally (host plane)')
      const writeResult = await writeTool.execute(
        { room: 'board', to: ['research-head'], text: 'hello from host' },
        { agent: host, signal }
      )
      // The host is lazily registered on its first tool call, from=host-<sessionId>.
      assert.equal(writeResult.from, `host-${host.id}`)
      const hosts = await readHosts(stateDir)
      assert.deepEqual(hosts[`host-${host.id}`], { sessionId: host.id, roomId: 'board' })

      // dept_whereami on the registered host returns kind host with its address.
      const whereamiTool = pluginCtx().tools.get('dept_whereami')
      assert.ok(whereamiTool, 'dept_whereami registered globally (host plane)')
      const where = await whereamiTool.execute({}, { agent: host, signal })
      assert.equal(where.kind, 'host')
      assert.equal(where.hostId, `host-${host.id}`)
      assert.equal(where.sessionId, host.id)
      assert.equal(where.hostRoomId, 'board')
    } finally {
      await dispose()
    }
  })
})

test('host wake: a board message addressed to host-<sessionId> raw-wakes the host agent with a kind board source', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const hostId = `host-${host.id}`

      // Register the host by having it post first.
      const signal = new AbortController().signal
      await root.tools.get('dept_room_write').execute(
        { room: 'board', to: ['research-head'], text: 'register me' },
        { agent: host, signal }
      )

      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      const before = host.inboxMessages.length
      // research-head (a static member) addresses the host.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'research-head', [hostId], 'please respond'), 'board')
      assert.equal(host.inboxMessages.length, before + 1, 'the host agent was raw-woken')
      const wake = host.inboxMessages.at(-1)
      assert.match(wake.content[0].text, /Board delta in board/)
      assert.match(wake.content[0].text, new RegExp(`new message \\S+ from research-head`))
      assert.doesNotMatch(wake.content[0].text, /please respond/, 'pointer-only wake (no body)')
      assert.equal(wake.source.kind, 'board', 'host wake source kind is board')
      assert.equal(wake.source.form, 'notice')
      assert.equal(wake.source.from, 'research-head')
      assert.equal(wake.source.senderSessionId, 'research-head')
    } finally {
      await dispose()
    }
  })
})

test('sender attribution: a host-posted message records from=host-<sessionId> and the relay resolves the sender session to that host (no anyParentId)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const hostA = agents.put(fakeParentAgent())
      const hostB = agents.put(fakeParentAgent())
      const hostBId = `host-${hostB.id}`
      const signal = new AbortController().signal

      // Both hosts register by posting (lazy ensureHost on their own tool call).
      await root.tools.get('dept_room_write').execute({ room: 'board', to: ['research-head'], text: 'A registers' }, { agent: hostA, signal })
      await root.tools.get('dept_room_write').execute({ room: 'board', to: ['research-head'], text: 'B registers' }, { agent: hostB, signal })
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      // Host B is addressed by the (registered) static member research-head.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'research-head', [hostBId], 'note for B'), 'board')
      assert.equal(hostB.inboxMessages.length, 1, 'host B was woken once')
      const wake = hostB.inboxMessages.at(-1)
      assert.equal(wake.source.kind, 'board')
      assert.equal(wake.source.senderSessionId, 'research-head', 'post sender resolves to its own id (no anyParentId fabrication)')

      // A host posting records from=<hostId>; the relay attributes the wake's
      // senderSession to that host's SESSION (via hosts.get(from).sessionId).
      await root.tools.get('dept_room_write').execute({ room: 'board', to: [hostBId], text: 'A to B' }, { agent: hostA, signal })
      await waitFor(() => hostB.inboxMessages.length === 2, 5000, 'host B received the host-to-host wake')
      const hostWake = hostB.inboxMessages.at(-1)
      assert.equal(hostWake.source.kind, 'board')
      assert.equal(hostWake.source.from, `host-${hostA.id}`, 'host sender recorded under its hostId')
      assert.equal(hostWake.source.senderSessionId, hostA.id, 'relay resolves the host sender to its session (no anyParentId)')
    } finally {
      await dispose()
    }
  })
})

test('address validation: dept_room_write to an unknown addressee throws; registered posts and hosts post', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const writeTool = root.tools.get('dept_room_write')

      // Fully-unknown addressee → loud rejection (audit C4 fix).
      await assert.rejects(
        () => writeTool.execute({ room: 'board', to: ['nobody'], text: 'nope' }, { agent: host, signal }),
        /unknown addressee\(s\) nobody/,
        'unknown addressee rejected loudly'
      )

      // A registered host addressee posts (the host registers itself lazily).
      const result = await writeTool.execute({ room: 'board', to: [`host-${host.id}`], text: 'self-note' }, { agent: host, signal })
      assert.ok(result.messageId.length > 0)

      // A static member (registered in config) posts too.
      const toStatic = await writeTool.execute({ room: 'board', to: ['research-head'], text: 'to the post member' }, { agent: host, signal })
      assert.ok(toStatic.messageId.length > 0)
    } finally {
      await dispose()
    }
  })
})

test('non-live host: a hostId whose agent is absent is skipped with a warning, not thrown', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      // Register a host, then remove its live agent (session closed).
      await root.tools.get('dept_room_write').execute({ room: 'board', to: ['research-head'], text: 'register' }, { agent: host, signal })
      agents.store.delete(host.id)

      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      // Emitting a message addressed to the dead host must NOT throw; the relay
      // skips + warns.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'research-head', [`host-${host.id}`], 'nobody'), 'board')
      // No crash; the relay handled it defensively.
      assert.ok(true)
    } finally {
      await dispose()
    }
  })
})

test('registerContinuableSetup: the board toolset is installed into every continuable child (own layer) AND globally on the host plane; the child toolset works', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-toolset')
    const childId = SessionId('session-post-toolset')
    const postId = 'research-head'
    await seedPost(stateDir, { postId, childId, parentId, roomId: 'board', provider: 'spawn' })
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent(parentId))

      // The board toolset is registered GLOBALLY (host plane) — assert that.
      for (const name of ['dept_room_read', 'dept_room_write', 'dept_room_who', 'dept_whereami']) {
        assert.ok(pluginCtx().tools.get(name), `${name} registered globally (host plane)`)
      }
      // dept_witness_write stays child-only (posts only).
      assert.equal(pluginCtx().tools.get('dept_witness_write'), undefined, 'dept_witness_write is NOT a host-plane tool')

      // Wake the dormant resident ONCE so it cold-resumes with the board tools,
      // then assert the child owns them in its own layer.
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, `host-${parent.id}`, [postId], 'wake the post'), 'board')
      await waitFor(() => agents.store.has(childId), 5000, 'post cold-resumed')
      const post = agents.store.get(childId)
      // The resumed child saw the relay wake.
      assert.equal(post.inboxMessages.length, 1, 'resumed post received the relay wake')

      const { ctx: childCtx, key } = agents.childContexts[0]
      for (const name of ['dept_room_read', 'dept_room_write', 'dept_witness_write', 'dept_room_who', 'dept_whereami']) {
        assert.ok(childCtx.tools.get(name, key), `${name} installed in the child own layer`)
      }

      // dept_room_write posts from the post's member id.
      const writeResult = await childCtx.tools.get('dept_room_write', key).execute(
        { room: 'board', to: ['asistente'], text: 'hello from the post' },
        { agent: post, signal: new AbortController().signal }
      )
      assert.equal(writeResult.from, postId, 'posted under the post member id')

      // dept_room_who lists static members + the post + any hosts.
      const whoResult = await childCtx.tools.get('dept_room_who', key).execute({ room: 'board' }, { agent: post })
      assert.deepEqual(whoResult.members, ['asistente', 'research-head'])
      assert.equal(whoResult.posts.length, 1, 'the post is listed')
      assert.equal(whoResult.posts[0].postId, postId)
      assert.equal(whoResult.posts[0].parentLive, true)
    } finally {
      await dispose()
    }
  })
})

test('wake relay (post): a dormant registered post is cold-resumed and woken through the live parent; sender, unknown members are handled', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-relay')
    const childId = SessionId('session-post-relay')
    const postId = 'research-head'
    // Seed BEFORE boot so the plugin loads the registry entry.
    await seedPost(stateDir, { postId, childId, parentId, roomId: 'board', provider: 'spawn' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent(parentId))
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))

      // 1. A post-addressed message cold-resumes + wakes the dormant resident.
      let seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, `host-${parent.id}`, [postId], 'question one'), 'board')
      await waitFor(() => agents.store.has(childId), 5000, 'post cold-resumed')
      const post = agents.store.get(childId)
      assert.equal(post.inboxMessages.length, 1, 'post woken once')
      const wake = post.inboxMessages.at(-1)
      assert.match(wake.content[0].text, new RegExp(`new message \\S+ from host-${parent.id}`))
      assert.doesNotMatch(wake.content[0].text, /question one/, 'pointer-only (no body)')
      assert.equal(wake.source.kind, 'coordinator', 'POST wakes keep the coordinator/relay source')

      // 2. Self-addressed message: sender is not woken (echo-loop guard).
      seq += 1
      const before = post.inboxMessages.length
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, postId, [postId], 'self note'), 'board')
      assert.equal(post.inboxMessages.length, before, 'no self-wake')

      // 3. Unknown member: skipped + warned (relay defensive path).
      seq += 1
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', ['ghost'], 'who?'), 'board')
      assert.equal(post.inboxMessages.length, before, 'unknown member not woken')

      // 4. Parent not live: post wake skipped (documented rc.6 limitation).
      agents.store.delete(parentId)
      seq += 1
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [postId], 'nobody home'), 'board')
      assert.equal(post.inboxMessages.length, before, 'no wake without a live parent')
    } finally {
      await dispose()
    }
  })
})

test('dept_room_who: lists static members and the registered live posts', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-who')
    const childId = SessionId('session-post-who')
    const postId = 'research-head'
    await seedPost(stateDir, { postId, childId, parentId, roomId: 'board', provider: 'spawn' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent(parentId))
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      // Cold-resume the post so it has the tool.
      const seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, `host-${parent.id}`, [postId], 'wake'), 'board')
      await waitFor(() => agents.store.has(childId), 5000, 'post cold-resumed')
      const post = agents.store.get(childId)
      const { ctx: childCtx, key } = agents.childContexts[0]
      const tool = childCtx.tools.get('dept_room_who', key)

      const result = await tool.execute({ room: 'board' }, { agent: post })
      assert.equal(result.room, 'board')
      assert.deepEqual(result.members, ['asistente', 'research-head'], 'static members in config order')
      assert.equal(result.posts.length, 1)
      assert.equal(result.posts[0].postId, postId)
      assert.equal(result.posts[0].parentId, parent.id)
      assert.equal(result.posts[0].parentLive, true, 'parent is live')

      // non-configured room: empty, no throw.
      const missing = await tool.execute({ room: 'nope' }, { agent: post })
      assert.deepEqual(missing.members, [])
      assert.deepEqual(missing.posts, [])
      assert.deepEqual(missing.hosts, [])
    } finally {
      await dispose()
    }
  })
})

test('dept_whereami: a registered post gets its spatial identity; the host gets the host shape', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-where')
    const childId = SessionId('session-post-where')
    const postId = 'research-head'
    await seedPost(stateDir, { postId, childId, parentId, roomId: 'board', provider: 'spawn' })
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent(parentId))
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, `host-${parent.id}`, [postId], 'wake'), 'board')
      await waitFor(() => agents.store.has(childId), 5000, 'post cold-resumed')
      const post = agents.store.get(childId)
      const { ctx: childCtx, key } = agents.childContexts[0]
      const tool = childCtx.tools.get('dept_whereami', key)
      const signal = new AbortController().signal

      // Post path.
      const where = await tool.execute({}, { agent: post, signal })
      assert.equal(where.kind, 'post')
      assert.equal(where.postId, postId)
      assert.equal(where.roomId, 'board')
      assert.equal(where.childId, childId)
      assert.equal(where.parentId, parent.id)
      assert.equal(where.provider, 'spawn')
      assert.deepEqual(where.members, ['asistente', 'research-head'])
      assert.equal(where.posts.length, 1)
      assert.equal(where.posts[0].parentLive, true)

      // Host path (unregistered host): kind host, no address fields.
      const hostWhere = await pluginCtx().tools.get('dept_whereami').execute({}, { agent: parent, signal })
      assert.equal(hostWhere.kind, 'host')
      assert.equal(hostWhere.postId, null)
      assert.equal(hostWhere.roomId, null)
    } finally {
      await dispose()
    }
  })
})

test('truncation fix: pointer-only relay, full fetch by id without cursor advance, and explicit TOC preview truncation', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-trunc')
    const childId = SessionId('session-post-trunc')
    const postId = 'research-head'
    await seedPost(stateDir, { postId, childId, parentId, roomId: 'board', provider: 'spawn' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent(parentId))
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      // Cold-resume the post and grab its reader context.
      let seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, `host-${parent.id}`, [postId], 'first wake'), 'board')
      await waitFor(() => agents.store.has(childId), 5000, 'post cold-resumed')
      const post = agents.store.get(childId)
      const { ctx: childCtx, key } = agents.childContexts[0]
      const signal = new AbortController().signal
      const read = (args) => childCtx.tools.get('dept_room_read', key).execute({ room: 'board', ...args }, { agent: post, signal })

      // (a) wake relay is pointer-only — no body, even for a long message.
      const longRelay = 'Z'.repeat(300)
      seq = await nextSeq(stateDir, 'board')
      const longRec = messageRecord(seq, `host-${parent.id}`, [postId], longRelay)
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), longRec, 'board')
      const relayWake = post.inboxMessages.at(-1)
      assert.match(relayWake.content[0].text, new RegExp(`new message ${longRec.id} from host-${parent.id}`))
      assert.ok(!relayWake.content[0].text.includes(longRelay.slice(0, 25)), 'relay carries no body text at all')

      // (b) fetch by messageId returns the FULL text and does not advance cursor.
      const longBody = 'X'.repeat(500)
      seq += 1
      const longMsg = messageRecord(seq, `host-${parent.id}`, [postId], longBody)
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), longMsg, 'board')
      const fetched = await read({ messageId: longMsg.id })
      assert.match(fetched.delta, new RegExp(`Full text of ${longMsg.id}`))
      assert.equal(fetched.delta.endsWith(longBody), true, 'full text present, untruncated')
      assert.doesNotMatch(fetched.delta, /…/, 'no truncation marker in fetch mode')

      // (c) a subsequent default read still serves the long message (truncated).
      seq += 1
      const shortA = messageRecord(seq, `host-${parent.id}`, [postId], 'alpha one')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), shortA, 'board')
      const toc = await read({})
      assert.match(toc.delta, new RegExp(`${'X'.repeat(140)}…`), 'long preview truncated with the explicit … marker')
      assert.doesNotMatch(toc.delta, /X{200,}/, 'no unmarked long body leaked into the TOC')
      assert.match(toc.delta, /alpha one/)
    } finally {
      await dispose()
    }
  })
})

test('dept_room_read: limit + offset page through the delta (per-member cursor)', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-page')
    const childId = SessionId('session-post-page')
    const postId = 'research-head'
    await seedPost(stateDir, { postId, childId, parentId, roomId: 'board', provider: 'spawn' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent(parentId))
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      let seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, `host-${parent.id}`, [postId], 'first wake'), 'board')
      await waitFor(() => agents.store.has(childId), 5000, 'post cold-resumed')
      const post = agents.store.get(childId)
      const { ctx: childCtx, key } = agents.childContexts[0]
      const signal = new AbortController().signal
      const read = (args) => childCtx.tools.get('dept_room_read', key).execute({ room: 'board', ...args }, { agent: post, signal })

      seq = await nextSeq(stateDir, 'board')
      const m1 = messageRecord(seq, `host-${parent.id}`, [postId], 'page one')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), m1, 'board')
      seq += 1
      const m2 = messageRecord(seq, `host-${parent.id}`, [postId], 'page two')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), m2, 'board')

      // On a fresh cursor, limit:1 + offset:2 reaches the SECOND paged message
      // (candidates = [first-wake, M1, M2]; offset skips first-wake + M1, the
      // limit caps the page at one entry = M2).
      const paged = await read({ limit: 1, offset: 2 })
      assert.match(paged.delta, /page two/, 'offset reached the second message')
      assert.doesNotMatch(paged.delta, /page one/, 'offset skipped the first message')

      const after = await read({ limit: 1, offset: 0 })
      assert.equal(after.delta, 'No board messages addressed to you.')
    } finally {
      await dispose()
    }
  })
})
