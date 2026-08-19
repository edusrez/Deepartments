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
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
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

function messageRecord(seq, from, to, text, ack = false) {
  return {
    id: `t-${seq}-${from}`,
    seq,
    ts: 1700000000000 + seq,
    from,
    to,
    cc: [],
    threadId: null,
    kind: 'message',
    payload: ack ? { kind: 'note', text, ack: true } : { kind: 'note', text }
  }
}

/** Pre-seed a room's board file with raw records BEFORE boot (a prior
 * session's cold truth) — the restart scenario for the cursor test. */
async function seedBoardRecords(stateDir, roomId, records) {
  const filePath = resolveBoardPath(stateDir, roomId)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

/** Read the persisted per-member cursor file (created on boot/advance). Retries
 * until the file is present AND parses as JSON (the write is fire-and-forget). */
async function readCursors(stateDir) {
  const cursorsPath = path.join(stateDir, 'cursors.json')
  let parsed
  await waitFor(async () => {
    try {
      parsed = JSON.parse(await readFile(cursorsPath, 'utf8'))
      return true
    } catch {
      return false
    }
  }, 5000, 'cursors.json readable')
  return parsed
}

/**
 * Seed a durable post resident into posts.json BEFORE boot, and register its
 * adoption so a cold resume restores it under the same child id. Mirrors what
 * a production posts.json holds for a previously-registered resident post.
 */
async function seedPost(stateDir, { postId, childId, parentId, roomId, provider = 'spawn' }) {
  const postsPath = path.join(stateDir, 'posts.json')
  let existing = {}
  try {
    existing = JSON.parse(await readFile(postsPath, 'utf8'))
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
      // 'asistente' (a static member that is NOT materialized as a post — the
      // configured head research-head is a registered post now) addresses the host.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [hostId], 'please respond'), 'board')
      assert.equal(host.inboxMessages.length, before + 1, 'the host agent was raw-woken')
      const wake = host.inboxMessages.at(-1)
      assert.match(wake.content[0].text, /Board delta in board/)
      assert.match(wake.content[0].text, new RegExp(`new message \\S+ from asistente`))
      assert.doesNotMatch(wake.content[0].text, /please respond/, 'pointer-only wake (no body)')
      assert.equal(wake.source.kind, 'board', 'host wake source kind is board')
      assert.equal(wake.source.form, 'notice')
      assert.equal(wake.source.from, 'asistente')
      assert.equal(wake.source.senderSessionId, 'asistente')
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
      // 'asistente' (a static member that is NOT a materialized post) addresses
      // host B; its sender session falls back to its own id (no anyParentId).
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [hostBId], 'note for B'), 'board')
      assert.equal(hostB.inboxMessages.length, 1, 'host B was woken once')
      const wake = hostB.inboxMessages.at(-1)
      assert.equal(wake.source.kind, 'board')
      assert.equal(wake.source.senderSessionId, 'asistente', 'non-post sender resolves to its own id (no anyParentId fabrication)')

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

// --- Batch B: permanent department heads (spawn + lean toolFilter + deploy) --

/**
 * Trigger lazy head materialization by having a live host register on the
 * board (its first host-plane board tool call → ensureHost → materializeHeads).
 * Returns the materialized head's childId once it exists.
 */
async function materializeConfiguredHead(stateDir, root, agents, host) {
  const signal = new AbortController().signal
  await root.tools.get('dept_room_write').execute({ room: 'board', to: ['asistente'], text: 'join' }, { agent: host, signal })
  const posts = await readPosts(stateDir)
  assert.ok(posts['research-head'], 'the configured head was materialized into posts.json')
  const childId = posts['research-head'].childId
  await waitFor(() => agents.store.has(childId), 5000, 'head child agent materialized')
  return childId
}

test('boot materializes the configured department head as a permanent spawn post (provider spawn, persona role, lean toolFilter, no-mission prompt)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const childId = await materializeConfiguredHead(stateDir, root, agents, host)

      const posts = await readPosts(stateDir)
      assert.equal(posts['research-head'].provider, 'spawn', 'provider is spawn')
      assert.equal(posts['research-head'].parentId, host.id, 'parent is the live host')
      assert.equal(posts['research-head'].roomId, 'research', 'head room comes from the department config')

      // startContinuable used provider 'spawn' with a lean allow-list + persona.
      const createCall = agents.createCalls.find((c) => c.seed?.some?.((e) => e.type === 'subagent/descriptor' && e.data?.label === 'research-head'))
      assert.ok(createCall, 'a continuable head was created via agents.create')
      const desc = createCall.seed.find((e) => e.type === 'subagent/descriptor').data
      assert.equal(desc.provider, 'spawn')
      assert.equal(desc.persona, 'Research department head', 'persona is the coordinator role')
      assert.deepEqual(desc.toolFilter, { allow: [] }, 'toolFilter imposes the lean allow-list')

      // Initial prompt is minimal identity framing, NO mission payload.
      await waitFor(() => agents.store.get(childId).inboxMessages.length >= 1, 5000, 'head received its initial prompt')
      const head = agents.store.get(childId)
      const prompt = head.inboxMessages[0].content[0].text
      assert.match(prompt, /permanent department head/)
      assert.match(prompt, /research-head/)
      assert.doesNotMatch(prompt, /mission/i, 'no mission in the initial prompt')
    } finally {
      await dispose()
    }
  })
})

test('a spawned head is lean: own-layer board tools present, inherited host-plane tools stripped by the allow-list', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      // Register a host-plane-only tool GLOBALLY that the lean head must NOT inherit.
      const probeDispose = root.tools.register(defineTool({
        name: 'host_insider_tool',
        description: 'host-plane only (probe)',
        parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
        async execute() { return {} }
      }))
      const host = agents.put(fakeParentAgent())
      const childId = await materializeConfiguredHead(stateDir, root, agents, host)

      const childCtxEntry = agents.childContexts.find((c) => c.ctx.agent?.id === childId)
      assert.ok(childCtxEntry, 'head child context is available')
      const { ctx: childCtx, key } = childCtxEntry
      // Own-layer board tools survive the allow-list.
      for (const name of ['dept_room_read', 'dept_room_write', 'dept_room_who', 'dept_whereami', 'dept_witness_write']) {
        assert.ok(childCtx.tools.get(name, key), `${name} installed in the head own layer`)
      }
      // The inherited global host-plane tool is stripped by toolFilter { allow: [] }.
      assert.equal(childCtx.tools.get('host_insider_tool', key), undefined, 'the restrict filter strips inherited (global) tools')
      // Retire is an admin/host-plane tool, not a head capability.
      assert.equal(childCtx.tools.get('dept_post_retire', key), undefined, 'retire is host-plane only')
      probeDispose?.()
    } finally {
      await dispose()
    }
  })
})

test('head materialization is idempotent: a second live-host join does NOT respawn an existing head', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const hostA = agents.put(fakeParentAgent())
      const childId = await materializeConfiguredHead(stateDir, root, agents, hostA)

      const countHeadSpawns = () => agents.createCalls.filter((c) => c.seed?.some?.((e) => e.type === 'subagent/descriptor' && e.data?.label === 'research-head')).length
      assert.equal(countHeadSpawns(), 1, 'exactly one spawn after the first join')

      // A second live host joins → materializeHeads runs again but skips byPost.
      const hostB = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      await root.tools.get('dept_room_write').execute({ room: 'board', to: ['asistente'], text: 'B joins' }, { agent: hostB, signal })
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.equal(countHeadSpawns(), 1, 'no second spawn after a second join (idempotent)')
      const posts = await readPosts(stateDir)
      assert.equal(posts['research-head'].childId, childId, 'the durable child id is unchanged')
    } finally {
      await dispose()
    }
  })
})

test('head deployment delivers official spatial context (source coordinator/relay, room + postId + presence, no mission)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const childId = await materializeConfiguredHead(stateDir, root, agents, host)
      const head = agents.store.get(childId)
      // prompt (0) then official spatial deployment (1).
      await waitFor(() => head.inboxMessages.length >= 2, 5000, 'spatial deployment delivered via followup')
      const deploy = head.inboxMessages[1]
      assert.equal(deploy.source.kind, 'coordinator')
      assert.equal(deploy.source.form, 'relay')
      assert.equal(deploy.source.senderSessionId, host.id)
      const text = deploy.content[0].text
      assert.match(text, /Spatial deployment/)
      assert.match(text, /department head "research-head"/)
      assert.match(text, /room "research"/)
      assert.match(text, /dept_whereami/)
      assert.match(text, /Room presence: static members: research-head/)
      assert.match(text, new RegExp(`host-${host.id}`))
      assert.doesNotMatch(text, /mission/i, 'no mission payload in the deployment context')
    } finally {
      await dispose()
    }
  })
})

test('dept_post_retire removes a head from the registry, persists, and posts a withdrawal note; unknown postId rejects loudly', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const childId = await materializeConfiguredHead(stateDir, root, agents, host)
      const boardSession = root.sessions.get(SessionId(roomSessionId('research')))
      const beforeCount = boardSession.events.length

      const retireTool = root.tools.get('dept_post_retire')
      assert.ok(retireTool, 'dept_post_retire is registered (host plane)')
      const signal = new AbortController().signal
      const result = await retireTool.execute({ postId: 'research-head' }, { agent: host, signal })
      assert.equal(result.retired, true)
      assert.equal(result.roomId, 'research')

      // Registry + persisted posts.json no longer contain the head.
      await waitFor(async () => (await readPosts(stateDir))['research-head'] === undefined, 5000, 'head removed from posts.json')

      // A withdrawal note was posted in the head's room.
      await waitFor(() => boardSession.events.length > beforeCount, 5000, 'withdrawal note emitted')

      // Unknown postId → loud rejection.
      await assert.rejects(() => retireTool.execute({ postId: 'ghost' }, { agent: host, signal }), /not a registered post/, 'unknown postId rejected loudly')
    } finally {
      await dispose()
    }
  })
})

// --- Batch C: wake-relay guards against acknowledgment ping-pong --------------
// The log audit found an unbounded ack-echo loop (board seq 86-110) where two
// residents replying "Confirmado… leído completo" re-woke each other forever.
// The relay now (a) tags pure acks via dept_room_write `ack:true` →
// payload.ack, (b) suppresses ack wakes past a per-pair budget (N≥3 within
// T=120s with no intervening non-ack message), (c) dedups empty-delta wakes
// when the member's read cursor already consumed the record, and (d) still
// never wakes on kind 'ready'. Tests below exercise each guard against the
// REAL relay (setBoardRecordListener → emitRoomRecord).

test('Batch C ack-loop: a content-free confirmation ping-pong saturates and terminates (no wake past the per-pair budget); a non-ack resets the counter and wakes normally', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-ackloop')
    const childA = SessionId('session-post-ackA')
    const childB = SessionId('session-post-ackB')
    const postA = 'research-head'
    const postB = 'acceptor-head'
    await seedPost(stateDir, { postId: postA, childId: childA, parentId, roomId: 'board', provider: 'spawn' })
    await seedPost(stateDir, { postId: postB, childId: childB, parentId, roomId: 'board', provider: 'spawn' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      agents.put(fakeParentAgent(parentId))
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      let seq = await nextSeq(stateDir, 'board')

      const emitAck = (from, to, text) =>
        emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq++, from, [to], text, true), 'board')
      const inboxOf = (childId) => (agents.store.get(childId)?.inboxMessages?.length ?? 0)

      // Warm up 3 acks in each direction — each must still wake (budget N>=3
      // has not yet accumulated on the pair).
      await emitAck(postA, postB, 'a1')
      await waitFor(() => agents.store.has(childB), 5000, 'post B cold-resumed')
      await emitAck(postB, postA, 'b1')
      await waitFor(() => agents.store.has(childA), 5000, 'post A cold-resumed')
      await emitAck(postA, postB, 'a2')
      await emitAck(postB, postA, 'b2')
      await emitAck(postA, postB, 'a3')
      await emitAck(postB, postA, 'b3')
      await waitFor(() => inboxOf(childA) >= 3 && inboxOf(childB) >= 3, 5000, 'three wakes each direction')
      const satA = inboxOf(childA)
      const satB = inboxOf(childB)
      assert.equal(satA, 3, `post A woken by its 3 expected acks (got ${satA})`)
      assert.equal(satB, 3, `post B woken by its 3 expected acks (got ${satB})`)

      // Once each pair has exchanged N>=3 acks, further acks must NOT wake.
      await emitAck(postA, postB, 'a4')
      await emitAck(postB, postA, 'b4')
      await emitAck(postA, postB, 'a5')
      await emitAck(postB, postA, 'b5')
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(inboxOf(childA), satA, 'post A not re-woken by suppressed acks')
      assert.equal(inboxOf(childB), satB, 'post B not re-woken by suppressed acks')

      // A non-ack message on the SAME pair direction RESETS its counter: the
      // next ack on that pair wakes normally again.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq++, postB, [postA], 'new substance'), 'board')
      await waitFor(() => inboxOf(childA) === satA + 1, 5000, 'non-ack message re-wakes post A')
      await emitAck(postB, postA, 'b6-after-reset')
      await waitFor(() => inboxOf(childA) === satA + 2, 5000, 'post A woken again after counter reset')
      assert.equal(inboxOf(childB), satB, 'suppressed acks on the other direction (A|B) still do not wake post B')
    } finally {
      await dispose()
    }
  })
})

test('Batch C ready-guard: a kind:ready boot marker wakes neither a host nor a registered post', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-readyguard')
    const childId = SessionId('session-post-readyguard')
    const postId = 'research-head'
    await seedPost(stateDir, { postId, childId, parentId, roomId: 'board', provider: 'spawn' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent(parentId))
      const hostId = `host-${parent.id}`
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      let seq = await nextSeq(stateDir, 'board')
      // A real host joins so it is a known wake target (and the post resumes).
      const signal = new AbortController().signal
      await root.tools.get('dept_room_write').execute({ room: 'board', to: [postId], text: 'join' }, { agent: parent, signal })
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq++, `host-${parent.id}`, [postId], 'resume'), 'board')
      await waitFor(() => agents.store.has(childId), 5000, 'post cold-resumed')
      const post = agents.store.get(childId)
      const hostBefore = parent.inboxMessages.length
      const postBefore = post.inboxMessages.length

      // Emit a ready marker addressed to both the host and the post.
      const readyRec = {
        id: `ready-board-${seq}`,
        seq: seq++,
        ts: Date.now(),
        from: 'system',
        to: [hostId, postId],
        cc: [],
        threadId: null,
        kind: 'ready',
        payload: { room: { id: 'board', name: 'Board', purpose: '', members: [] } }
      }
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), readyRec, 'board')
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(parent.inboxMessages.length, hostBefore, 'no host wake on kind:ready')
      assert.equal(post.inboxMessages.length, postBefore, 'no post wake on kind:ready')
    } finally {
      await dispose()
    }
  })
})

test('Batch C cursor-dedup: a record the member\'s read cursor already consumed does not re-wake the member', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-dedup')
    const childId = SessionId('session-post-dedup')
    const postId = 'research-head'
    await seedPost(stateDir, { postId, childId, parentId, roomId: 'board', provider: 'spawn' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent(parentId))
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq0 = await nextSeq(stateDir, 'board')

      // Message M1 wakes the post; the post then READS it, advancing the cursor.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq0, `host-${parent.id}`, [postId], 'one'), 'board')
      await waitFor(() => agents.store.has(childId), 5000, 'post cold-resumed')
      const post = agents.store.get(childId)
      const { ctx: childCtx, key } = agents.childContexts[0]
      const read = childCtx.tools.get('dept_room_read', key)
      const signal = new AbortController().signal
      await read.execute({ room: 'board' }, { agent: post, signal })
      const before = post.inboxMessages.length
      assert.ok(before >= 1, 'post woken by M1')

      // A record the cursor already consumed (same seq) must NOT re-wake.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq0, `host-${parent.id}`, [postId], 'replay'), 'board')
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(post.inboxMessages.length, before, 'no redundant wake for an already-consumed record')

      // A genuinely NEWER record still wakes.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq0 + 1, `host-${parent.id}`, [postId], 'two'), 'board')
      await waitFor(() => post.inboxMessages.length === before + 1, 5000, 'newer record re-wakes')
    } finally {
      await dispose()
    }
  })
})

test('Batch C dept_room_write ack:true tags a pure acknowledgement (payload.ack) without changing the output schema; ack omitted stays untagged', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const writeTool = root.tools.get('dept_room_write')

      const ackResult = await writeTool.execute({ room: 'board', to: ['research-head'], text: 'confirm read in full', ack: true }, { agent: host, signal })
      assert.deepEqual(Object.keys(ackResult).sort(), ['from', 'messageId', 'room', 'to'], 'output schema unchanged when ack:true')
      assert.equal(ackResult.from, `host-${host.id}`)
      assert.deepEqual(ackResult.to, ['research-head'])

      const plainResult = await writeTool.execute({ room: 'board', to: ['research-head'], text: 'real content' }, { agent: host, signal })

      const records = await loadRecords(resolveBoardPath(stateDir, 'board'))
      const messages = records.filter((r) => r.kind === 'message' && r.from === `host-${host.id}`)
      assert.equal(messages.length, 2)
      const tagged = messages.find((m) => m.id === ackResult.messageId)
      const plain = messages.find((m) => m.id === plainResult.messageId)
      assert.equal(tagged.payload.ack, true, 'ack:true records payload.ack=true')
      assert.equal(tagged.payload.kind, 'note', 'ack keeps kind note')
      assert.equal(plain.payload.ack, undefined, 'plain write carries payload.ack undefined')
    } finally {
      await dispose()
    }
  })
})

// --- Batch D: persistent read cursors + ready single-once + fork-ghost sweep ---
// The log audit (2026-08-19) found: (1) per-member read cursors were IN-MEMORY
// only, so a resident replayed its ENTIRE addressed backlog after a service
// restart (wasted tokens, dropped missions); (2) the board file accumulated a
// `kind:'ready'` boot record on EVERY service start (~41%/46-of-111 records of
// pure noise); (3) retired `asistente-fork-*` ghosts were never garbage
// collected from posts.json (~77M tokens doing nothing).
//
// Batch D fixes: cursors persist to `<stateDir>/cursors.json` and dept_room_read
// serves ONLY `seq > lastMessageSeq` (a durable high-water mark), so a restarted
// member reads only-new while a fresh member reads full history; `ready` is
// emitted ONCE per room across boots; the retired fork provider's leftovers are
// swept on boot while spawn heads are never touched.

test('Batch D persistent cursor: a persisted high-water `lastMessageSeq` makes a restarted member read ONLY-new, while a fresh member reads full history', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-cursor')
    const resumedChild = SessionId('session-child-resumed')
    const freshChild = SessionId('session-child-fresh')
    const resumedPost = 'research-head'
    const freshPost = 'acceptor-head'
    await seedPost(stateDir, { postId: resumedPost, childId: resumedChild, parentId, roomId: 'board', provider: 'spawn' })
    await seedPost(stateDir, { postId: freshPost, childId: freshChild, parentId, roomId: 'board', provider: 'spawn' })

    // Historical backlog (a prior session's board file): research-head already
    // consumed seq 0,1 (its persisted cursor is at lastMessageSeq 1); the fresh
    // acceptor-head has no cursor entry and must see its full history.
    await seedBoardRecords(stateDir, 'board', [
      messageRecord(0, 'asistente', [resumedPost], 'rh-hist-0'),
      messageRecord(1, 'asistente', [resumedPost], 'rh-hist-1'),
      messageRecord(2, 'asistente', [freshPost], 'ac-hist-0'),
      messageRecord(3, 'asistente', [freshPost], 'ac-hist-1')
    ])
    // Persisted cursor artifact from the prior session (the "restart" state).
    await writeFile(path.join(stateDir, 'cursors.json'),
      JSON.stringify({ 'board:research-head': { lastMessageId: null, lastMessageSeq: 1, lastAgendaSeq: -1 } }, null, 2),
      'utf8')

    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent(parentId))
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))

      // (a) FRESH member: cold-resume the fresh post and read — it must see the
      // full historical backlog addressed to it (ac-hist-0, ac-hist-1).
      let seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, `host-${parent.id}`, [freshPost], 'fresh-wake'), 'board')
      await waitFor(() => agents.store.has(freshChild), 5000, 'fresh post cold-resumed')
      const fresh = agents.store.get(freshChild)
      const freshEntry = agents.childContexts.find((c) => c.ctx.agent?.id === freshChild)
      assert.ok(freshEntry, 'fresh post child context available')
      const freshRead = freshEntry.ctx.tools.get('dept_room_read', freshEntry.key)
      const freshDelta = (await freshRead.execute({ room: 'board' }, { agent: fresh, signal: new AbortController().signal })).delta
      assert.match(freshDelta, /ac-hist-0/, 'fresh member sees full addressed history (ac-hist-0)')
      assert.match(freshDelta, /ac-hist-1/, 'fresh member sees full addressed history (ac-hist-1)')

      // (b) RESUMED member: cold-resume and read — its persisted cursor
      // (lastMessageSeq 1) must suppress the historical backlog; only the new
      // wake message shows, never rh-hist-0/rh-hist-1.
      seq = await nextSeq(stateDir, 'board')
      const resumedWakeText = 'fresh-note-for-resumed'
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, `host-${parent.id}`, [resumedPost], resumedWakeText), 'board')
      await waitFor(() => agents.store.has(resumedChild), 5000, 'resumed post cold-resumed')
      const resumed = agents.store.get(resumedChild)
      const resumedEntry = agents.childContexts.find((c) => c.ctx.agent?.id === resumedChild)
      assert.ok(resumedEntry, 'resumed post child context available')
      const resumedRead = resumedEntry.ctx.tools.get('dept_room_read', resumedEntry.key)
      const resumedDelta = (await resumedRead.execute({ room: 'board' }, { agent: resumed, signal: new AbortController().signal })).delta
      assert.match(resumedDelta, new RegExp(resumedWakeText), 'resumed member gets the only-new message')
      assert.doesNotMatch(resumedDelta, /rh-hist-0/, 'resumed member does NOT replay its historical backlog (rh-hist-0)')
      assert.doesNotMatch(resumedDelta, /rh-hist-1/, 'resumed member does NOT replay its historical backlog (rh-hist-1)')

      // The high-water mark was mirrored to disk on the read.
      await waitFor(async () => {
        const cursors = await readCursors(stateDir)
        const resumedCursor = cursors['board:research-head']
        return resumedCursor !== undefined && resumedCursor.lastMessageSeq >= seq
      }, 5000, 'advanced cursor persisted to cursors.json')
    } finally {
      await dispose()
    }
  })
})

test('Batch D ready single-once: a second boot into the same stateDir does NOT re-emit a ready record per room', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-ready-'))
  try {
    const readyCount = async (roomId) => (await loadRecords(resolveBoardPath(stateDir, roomId))).filter((r) => r.kind === 'ready').length

    const b1 = await bootPlugin(stateDir)
    await waitForRooms(b1.root)
    assert.equal(await readyCount('board'), 1, 'one ready record for board after first boot')
    assert.equal(await readyCount('research'), 1, 'one ready record for research after first boot')
    await b1.dispose()

    // Restart into the SAME stateDir: the ready record already persisted, so no
    // second ready record may be appended.
    const b2 = await bootPlugin(stateDir)
    await waitForRooms(b2.root)
    assert.equal(await readyCount('board'), 1, 'still one ready record for board after second boot')
    assert.equal(await readyCount('research'), 1, 'still one ready record for research after second boot')
    await b2.dispose()
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('Batch D fork-ghost sweep: retired fork-provider posts are removed from posts.json on boot while a spawn head remains', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-sweep')
    const headChild = SessionId('session-head-sweep')
    const ghostA = SessionId('session-ghost-a')
    const ghostB = SessionId('session-ghost-b')
    await seedPost(stateDir, { postId: 'research-head', childId: headChild, parentId, roomId: 'board', provider: 'spawn' })

    // Inject retired fork-provider ghosts directly into posts.json (the legacy
    // pre-Batch-A `asistente-fork-*` clones).
    const postsPath = path.join(stateDir, 'posts.json')
    const current = JSON.parse(await readFile(postsPath, 'utf8'))
    for (const [postId, childId] of [['asistente-fork-a', ghostA], ['asistente-fork-b', ghostB]]) {
      current[postId] = { childId, parentId, roomId: 'board', provider: 'fork' }
      postAdoption.set(childId, parentId)
    }
    await writeFile(postsPath, JSON.stringify(current, null, 2), 'utf8')

    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      // The spawn head survives; the fork ghosts are swept from BOTH memory and
      // the persisted posts.json.
      await waitFor(async () => {
        const posts = await readPosts(stateDir)
        return posts['asistente-fork-a'] === undefined && posts['asistente-fork-b'] === undefined && posts['research-head'] !== undefined
      }, 5000, 'fork ghosts swept while spawn head remains')
      const posts = await readPosts(stateDir)
      assert.equal(posts['research-head'].provider, 'spawn', 'spawn head kept with provider spawn')
      assert.equal(posts['asistente-fork-a'], undefined, 'fork ghost A removed')
      assert.equal(posts['asistente-fork-b'], undefined, 'fork ghost B removed')

      // The live registry agrees (dept_room_who lists no fork ghosts).
      const who = await root.tools.get('dept_room_who').execute({ room: 'board' })
      assert.ok(!who.posts.some((p) => p.postId.startsWith('asistente-fork-')), 'no fork ghost in the live roster')
    } finally {
      await dispose()
    }
  })
})

// --- Batch E: roster liveness, whereami ensureHost, sender-trust verification ---
// Closes Batch A reviewer notes 1-2 and the audit's self-asserted-identity
// finding: (1) dept_room_who now reports truthful host session liveness
// (sessionLive) — a cold-boot non-live host is no longer listed as "live";
// (2) dept_whereami now calls ensureHost on its host branch, so a host that
// only calls whereami is REGISTERED (addressable) instead of staying
// addressless; (3) dept_room_write gains a `sensitive` flag that records
// payload.sensitive + a senderVerified flag (registry-verified sender) as a
// PRAGMATIC sender-trust SIGNAL — surfaced in the read delta, not an
// enforcement block or a crypto signature.

test('Batch E dept_room_who: a non-live host lists with sessionLive:false, a live host with sessionLive:true; posts still report parentLive', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-whoE')
    const childId = SessionId('session-post-whoE')
    const postId = 'research-head'
    await seedPost(stateDir, { postId, childId, parentId, roomId: 'board', provider: 'spawn' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent(parentId))
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      let seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, `host-${parent.id}`, [postId], 'wake'), 'board')
      await waitFor(() => agents.store.has(childId), 5000, 'post cold-resumed')
      const post = agents.store.get(childId)
      const { ctx: childCtx, key } = agents.childContexts[0]
      const who = childCtx.tools.get('dept_room_who', key)
      const signal = new AbortController().signal

      // A live host joins (registering it in the room).
      const liveHost = agents.put(fakeParentAgent())
      await root.tools.get('dept_room_write').execute({ room: 'board', to: [postId], text: 'join' }, { agent: liveHost, signal })

      // Now kill that host's agent — it stays in the registry (Batch A
      // reconciliation) but is NOT live. It must list with sessionLive:false.
      agents.store.delete(liveHost.id)

      const result = await who.execute({ room: 'board' }, { agent: post })
      // The post's own liveness flag is unchanged.
      assert.equal(result.posts[0].postId, postId)
      assert.equal(result.posts[0].parentLive, true)
      // The dead host is still registered but truthfully NOT live.
      const dead = result.hosts.find((h) => h.hostId === `host-${liveHost.id}`)
      assert.ok(dead, 'the registered-but-dead host is still listed in the roster')
      assert.equal(dead.sessionLive, false, 'a cold-boot/non-live host reports sessionLive:false, never "live"')
      assert.equal(dead.sessionId, liveHost.id)
      assert.equal(dead.roomId, 'board')

      // A genuinely live host reports sessionLive:true.
      const liveAgain = agents.put(fakeParentAgent())
      await root.tools.get('dept_room_write').execute({ room: 'board', to: [postId], text: 'join again' }, { agent: liveAgain, signal })
      const result2 = await who.execute({ room: 'board' }, { agent: post })
      const alive = result2.hosts.find((h) => h.hostId === `host-${liveAgain.id}`)
      assert.ok(alive && alive.sessionLive === true, 'a live host reports sessionLive:true')
    } finally {
      await dispose()
    }
  })
})

test('Batch E dept_whereami host branch: a host-only agent calling whereami is REGISTERED (addressable, hostForSession populated)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      // A host that NEVER called read/write — whereami is its first board tool call.
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const whereami = root.tools.get('dept_whereami')

      const where = await whereami.execute({}, { agent: host, signal })
      assert.equal(where.kind, 'host')
      assert.equal(where.postId, null)
      assert.equal(where.roomId, null)
      // ensureHost ran: the host is now registered AND addressable.
      assert.equal(where.hostId, `host-${host.id}`, 'a whereami-only host is registered and addressable')
      assert.equal(where.sessionId, host.id)
      assert.equal(where.hostRoomId, 'board', 'unregistered host joins the first configured room')

      // The reverse map is populated: hosts.json holds the host in room 'board'.
      const hosts = await readHosts(stateDir)
      assert.deepEqual(hosts[`host-${host.id}`], { sessionId: host.id, roomId: 'board' }, 'hostForSession/hosts.json populated by a whereami-only call')
    } finally {
      await dispose()
    }
  })
})

test('Batch E dept_room_write sensitive:true records payload.sensitive + senderVerified (true for a live registered sender, false for a non-live/unverified host sender)', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-writeE')
    const childId = SessionId('session-post-writeE')
    const postId = 'research-head'
    await seedPost(stateDir, { postId, childId, parentId, roomId: 'board', provider: 'spawn' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const parent = agents.put(fakeParentAgent(parentId))
      const signal = new AbortController().signal
      const writeTool = root.tools.get('dept_room_write')

      // (1) LIVE registered host sender + sensitive → senderVerified true.
      const host = agents.put(fakeParentAgent())
      const live = await writeTool.execute({ room: 'board', to: ['research-head'], text: 'mission critical from live host', sensitive: true }, { agent: host, signal })
      const records = await loadRecords(resolveBoardPath(stateDir, 'board'))
      const liveRec = records.find((r) => r.id === live.messageId)
      assert.equal(liveRec.payload.sensitive, true, 'sensitive:true records payload.sensitive=true')
      assert.equal(liveRec.payload.senderVerified, true, 'a live registered host sender is registry-verified')

      // (2) REGISTERED POST sender + sensitive → senderVerified true.
      // Cold-resume the post and use its own write tool.
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      let seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, `host-${host.id}`, [postId], 'resume'), 'board')
      await waitFor(() => agents.store.has(childId), 5000, 'post cold-resumed')
      const post = agents.store.get(childId)
      const { ctx: childCtx, key } = agents.childContexts[0]
      const postWrite = childCtx.tools.get('dept_room_write', key)
      const postMsg = await postWrite.execute({ room: 'board', to: ['asistente'], text: 'post secret', sensitive: true }, { agent: post, signal })
      const recs2 = await loadRecords(resolveBoardPath(stateDir, 'board'))
      const postRec = recs2.find((r) => r.id === postMsg.messageId)
      assert.equal(postRec.from, postId)
      assert.equal(postRec.payload.sensitive, true)
      assert.equal(postRec.payload.senderVerified, true, 'a registered post sender is registry-verified')

      // (3) NON-LIVE host sender + sensitive → senderVerified FALSE (the audit
      // concern: a message whose sender session is not live is surfaced as
      // verified:no). We delete the host's agent, then emit via that same host
      // object — exec.agent only needs the id; from resolves to the registered
      // hostId whose session is no longer live, so computeSenderVerified is false.
      agents.store.delete(host.id)
      const dead = await writeTool.execute({ room: 'board', to: ['research-head'], text: 'unverified secret', sensitive: true }, { agent: host, signal })
      const recs3 = await loadRecords(resolveBoardPath(stateDir, 'board'))
      const deadRec = recs3.find((r) => r.id === dead.messageId)
      assert.equal(deadRec.from, `host-${host.id}`)
      assert.equal(deadRec.payload.sensitive, true)
      assert.equal(deadRec.payload.senderVerified, false, 'a non-live host sender is NOT registry-verified (verified:no)')

      // (4) Plain (non-sensitive) write does NOT carry the flags.
      const plain = await writeTool.execute({ room: 'board', to: ['research-head'], text: 'ordinary note' }, { agent: agents.put(fakeParentAgent()), signal })
      const recs4 = await loadRecords(resolveBoardPath(stateDir, 'board'))
      const plainRec = recs4.find((r) => r.id === plain.messageId)
      assert.equal(plainRec.payload.sensitive, undefined, 'plain write carries payload.sensitive undefined')
      assert.equal(plainRec.payload.senderVerified, undefined, 'plain write carries payload.senderVerified undefined')
    } finally {
      await dispose()
    }
  })
})

test('Batch E dept_room_read surfaces the [sensitive — sender verified] flag in the rendered delta (TOC + fetch)', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-readE')
    const childId = SessionId('session-post-readE')
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
      const read = childCtx.tools.get('dept_room_read', key)
      const signal = new AbortController().signal
      const writeTool = root.tools.get('dept_room_write')

      // A live host posts a sensitive message addressed to the post.
      const host = agents.put(fakeParentAgent())
      const live = await writeTool.execute({ room: 'board', to: [postId], text: 'top-secret for the head', sensitive: true }, { agent: host, signal })

      // TOC mode surfaces the verified flag.
      const toc = await read.execute({ room: 'board' }, { agent: post, signal })
      assert.match(toc.delta, new RegExp(`${live.messageId}`), 'sensitive message is in the delta')
      assert.match(toc.delta, /\[sensitive — sender verified: yes\]/, 'TOC surfaces [sensitive — sender verified: yes] for a live registered host sender')

      // Fetch mode surfaces the flag too.
      const fetched = await read.execute({ room: 'board', messageId: live.messageId }, { agent: post, signal })
      assert.match(fetched.delta, /\[sensitive — sender verified: yes\]/, 'fetch surfaces the verified flag')
      assert.match(fetched.delta, /top-secret for the head/, 'fetch still returns the full body')

      // A non-live host sender surfaces verified:no in the delta.
      seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, `host-${host.id}`, [postId], 'resume read'), 'board')
      const dead = agents.put(fakeParentAgent())
      // Re-register `dead` under a stable identity by having it join first.
      await writeTool.execute({ room: 'board', to: [postId], text: 'dead join' }, { agent: dead, signal })
      agents.store.delete(dead.id)
      const unverified = await writeTool.execute({ room: 'board', to: [postId], text: 'shady secret', sensitive: true }, { agent: dead, signal })
      const toc2 = await read.execute({ room: 'board' }, { agent: post, signal })
      assert.match(toc2.delta, new RegExp(`${unverified.messageId}`))
      assert.match(toc2.delta, /\[sensitive — sender verified: no\]/, 'a non-live host sender surfaces verified:no')
    } finally {
      await dispose()
    }
  })
})

// --- Board F (Batch F): O(1) emit counter + boot-time compaction ---------------

/** A genuine `m-board-<seq>`-style message (matches the re-id pattern). */
function boardFMsg(seq, from, to, text) {
  return {
    id: `m-board-${seq}`,
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

test('Board F O(1) emit: a 5000-record pre-seeded board seeds the counter once; the next emit gets seq 5000 (not 0)', async () => {
  await withTempStateDir(async (stateDir) => {
    // A full prior history: 5000 records — one ready seed followed by 4999
    // registered→registered messages (both endpoints are static members, so
    // the keep-rule preserves every one and boot renumber is a 0..4999 no-op).
    // The ready seed means this boot appends NO second ready, so the file's
    // last seq stays 4999 and the counter must seed from it (NOT from 0) —
    // otherwise the next emit seq would collide with a kept record.
    const seeded = [{ ...boardFMsg(0, 'system', ['asistente', 'research-head'], 'seed-ready'), id: 'ready-board-0', seq: 0, kind: 'ready', payload: { room: { id: 'board', name: 'Board', purpose: 'p', members: ['asistente', 'research-head'] } } }]
    for (let i = 1; i < 5000; i++) seeded.push(boardFMsg(i, 'asistente', ['research-head'], `pre-${i}`))
    await seedBoardRecords(stateDir, 'board', seeded)

    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal

      // One host-plane emit through the real tool (emitBoardMessage → counter).
      const writeTool = pluginCtx().tools.get('dept_room_write')
      const writeResult = await writeTool.execute(
        { room: 'board', to: ['asistente'], text: 'seq-after-5000' },
        { agent: host, signal }
      )

      // The counter was seeded from the file (last seq 4999 → next 5000), so
      // the new record continues at 5000 — not at 0.
      assert.equal(writeResult.messageId, 'm-board-5000', 'new record id embeds seq 5000 (counter seeded from file)')

      const after = await loadRecords(resolveBoardPath(stateDir, 'board'))
      assert.equal(after.length, 5001, 'board now has 5001 records (5000 seeded + 1 emitted)')
      assert.equal(after[after.length - 1].seq, 5000, 'last record seq is 5000')
      assert.equal(after[after.length - 1].id, 'm-board-5000')
    } finally {
      await dispose()
    }
  })
})

test('Board F boot compaction: an oversized board is rewritten keeping only registered messages + a single ready, renumbered below the threshold, with the room\'s cursors reset', async () => {
  await withTempStateDir(async (stateDir) => {
    // A HIGH persisted cursor for a board member from a prior (pre-compaction)
    // session — exactly the "resumed member would SKIP unread kept messages"
    // hazard the Batch D advisory flags. The research room is untouched.
    await writeFile(path.join(stateDir, 'cursors.json'), JSON.stringify({
      'board:research-head': { lastMessageId: 'm-board-1799', lastMessageSeq: 1799, lastAgendaSeq: 12 },
      'research:research-head': { lastMessageId: 'm-2', lastMessageSeq: 2, lastAgendaSeq: -1 }
    }, null, 2), 'utf8')

    // Oversized board (2052 records > COMPACTION_LINE_THRESHOLD): 1800 kept
    // registered→registered messages, 250 ghost-sender messages, one ready
    // seed and a duplicate ready.
    const records = []
    for (let i = 0; i < 1800; i++) records.push(boardFMsg(i, 'asistente', ['research-head'], `kept-${i}`))
    for (let i = 0; i < 250; i++) records.push({ ...boardFMsg(1800 + i, 'ghost', ['asistente'], `ghost-${i}`) })
    records.push({
      id: 'ready-board-a',
      seq: 2050,
      ts: 1700000000000 + 2050,
      from: 'system',
      to: ['asistente', 'research-head'],
      cc: [],
      threadId: null,
      kind: 'ready',
      payload: { room: { id: 'board', name: 'Board', purpose: 'p', members: ['asistente', 'research-head'] } }
    })
    records.push({
      id: 'ready-board-b',
      seq: 2051,
      ts: 1700000000000 + 2051,
      from: 'system',
      to: ['asistente', 'research-head'],
      cc: [],
      threadId: null,
      kind: 'ready',
      payload: { room: { id: 'board', name: 'Board', purpose: 'p', members: ['asistente', 'research-head'] } }
    })
    await seedBoardRecords(stateDir, 'board', records)

    // A durable resident `research-head` post (the same member the stale high
    // cursor belongs to) so it cold-resumes as a member and its IN-MEMORY read
    // cursor can be observed after compaction — proving the compaction resetter
    // cleared it (not just the durable file).
    const parentId = SessionId('session-parent-compaction')
    const childId = SessionId('session-child-compaction')
    await seedPost(stateDir, { postId: 'research-head', childId, parentId, roomId: 'board', provider: 'spawn' })

    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      // Full-boot readiness: org's room-boot effect compacts the board, resets
      // the durable cursors, fires the compaction resetter (in-memory), and
      // resolveRoomSession's the live board session — all asynchronously. Wait
      // for the ENTIRE state before any assertion so we never race mid-boot:
      //   (1) the compacted board file is below the line threshold,
      //   (2) the IN-MEMORY board session is live (resolveRoomSession done),
      //   (3) the durable `board:research-head` cursor is RESET to fresh
      //       (lastMessageSeq === -1) — reading cursors.json inside the
      //       predicate with a try/catch tolerates transient mid-reset parse
      //       errors / ENOENT until compaction's reset write has landed.
      // The durable reset occurs inside compactBoardFile, and org fires the
      // in-memory compaction resetter immediately after it returns, so once
      // (3) holds the resetter has already cleared memberCursors too.
      await waitFor(async () => {
        const current = await loadRecords(resolveBoardPath(stateDir, 'board'))
        if (!(current.length > 0 && current.length < 2000)) return false
        if (root.sessions.get(SessionId(roomSessionId('board'))) === undefined) return false
        let parsed
        try {
          parsed = JSON.parse(await readFile(path.join(stateDir, 'cursors.json'), 'utf8'))
        } catch {
          return false // cursors.json not yet readable (ENOENT / mid-reset parse)
        }
        const boardCursor = parsed['board:research-head']
        return typeof boardCursor?.lastMessageSeq === 'number' && boardCursor.lastMessageSeq === -1
      }, 5000, 'full boot readiness: board compacted, session live, board cursor reset')

      const compacted = await loadRecords(resolveBoardPath(stateDir, 'board'))
      // 1800 kept messages + exactly ONE ready seed = 1801 < 2000.
      assert.equal(compacted.length, 1801, 'board after compaction: 1801 records (< 2000 threshold)')
      const ghosts = compacted.filter((r) => r.from === 'ghost')
      assert.equal(ghosts.length, 0, 'ghost-sender messages dropped')
      const readies = compacted.filter((r) => r.kind === 'ready')
      assert.equal(readies.length, 1, 'exactly one ready seed kept (duplicate dropped)')
      // Contiguous renumbered seqs 0..N-1, ids re-derived from the new seq.
      compacted.forEach((r, index) => {
        assert.equal(r.seq, index, `seq renumbered contiguous at index ${index}`)
      })
      assert.equal(compacted[1800].id, 'ready-board-1800', 'the kept ready re-ids with the new seq')
      assert.equal(compacted[0].id, 'm-board-0', 'kept message re-ids with the new seq')

      // The room\'s cursors were RESET to fresh so NO member skips the kept set;
      // the other room\'s cursor is untouched.
      const cursors = JSON.parse(await readFile(path.join(stateDir, 'cursors.json'), 'utf8'))
      assert.deepEqual(cursors['board:research-head'], { lastMessageId: null, lastMessageSeq: -1, lastAgendaSeq: -1 })
      assert.deepEqual(cursors['research:research-head'], { lastMessageId: 'm-2', lastMessageSeq: 2, lastAgendaSeq: -1 })

      // --- Post-compaction IN-MEMORY read (Batch F reviewer fix): the resumed
      // research-head post's in-memory cursor (cold-loaded BEFORE compaction)
      // must have been CLEARED by the compaction resetter so it re-reads the
      // renumbered kept set instead of skipping it. Without the fix, the stale
      // high cursor (lastMessageSeq 1799) suppresses every kept message. ---
      const parent = agents.put(fakeParentAgent(parentId))
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      assert.ok(boardSession, 'live board session available after the full-boot readiness wait')
      // Wake the durable research-head post; its read seat is the in-memory
      // memberCursors, which the compaction resetter cleared to fresh.
      const wakeSeq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(wakeSeq, `host-${parent.id}`, ['research-head'], 'compaction-wake'), 'board')
      await waitFor(() => agents.store.has(childId), 5000, 'compacted research-head post cold-resumed')
      const resumed = agents.store.get(childId)
      const resumedEntry = agents.childContexts.find((c) => c.ctx.agent?.id === childId)
      assert.ok(resumedEntry, 'resumed post child context available')
      const resumedRead = resumedEntry.ctx.tools.get('dept_room_read', resumedEntry.key)
      const delta = (await resumedRead.execute({ room: 'board' }, { agent: resumed, signal: new AbortController().signal })).delta
      // `kept-0` is the definitive proof the stale high cursor did NOT suppress
      // the renumbered kept set: without the compaction resetter, every kept
      // message (seq 0..1799, all <= the stale lastMessageSeq 1799) would be
      // filtered out of the delta. The rendered TOC is page-limited, so we only
      // assert the first kept message is present, not the truncated tail.
      assert.match(delta, /kept-0/, 'resumed member re-reads the renumbered kept set (first kept message) after compaction')
      assert.match(delta, /more messages/, 'the delta exposes the full remaining kept set (still paged/available)')
    } finally {
      await dispose()
    }
  })
})
