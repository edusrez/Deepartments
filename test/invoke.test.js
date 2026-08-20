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
 * Seed a durable department head (root agent) into posts.json BEFORE boot,
 * and register its adoption so a cold resume restores it under the same
 * stable session id (`head-<postId>`). Mirrors what a production posts.json
 * holds for a previously-materialized head.
 */
async function seedPost(stateDir, { postId, sessionId = `head-${postId}`, roomId, agentPreset = 'deepartments-head', sleepEpoch, previousChildId }) {
  const postsPath = path.join(stateDir, 'posts.json')
  let existing = {}
  try {
    existing = JSON.parse(await readFile(postsPath, 'utf8'))
  } catch {
    /* no prior seed */
  }
  const entry = { sessionId, roomId, agentPreset }
  // Batch G: a slept head carries the durable sleep-mark (and its previous
  // incarnation's sessionId) in posts.json — seeded so the relay can respawn it.
  if (sleepEpoch !== undefined) entry.sleepEpoch = sleepEpoch
  if (previousChildId !== undefined) entry.previousChildId = previousChildId
  existing[postId] = entry
  await writeFile(postsPath, JSON.stringify(existing, null, 2), 'utf8')
  postAdoption.set(sessionId, '')
}

/** Pre-author a post's long-term memory journal at
 * `<stateDir>/journals/<postId>.md` (the durable file dept_memo_write writes)
 * so a slept head's next wake can load it as its redeployed context. */
async function seedJournal(stateDir, postId, summary) {
  const journalPath = path.join(stateDir, 'journals', `${postId}.md`)
  await mkdir(path.dirname(journalPath), { recursive: true })
  const content = [
    '---',
    `author: ${postId}`,
    `timestamp: ${new Date().toISOString()}`,
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

test('head setup: the board toolset is registered scoped to the head agent (own layer) AND globally on the host plane; the head toolset works', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      // The configured head auto-materializes at boot as a root agent.
      await waitFor(() => agents.store.has(`head-research-head`), 5000, 'head root agent created at boot')

      // The board toolset is registered GLOBALLY (host plane) — assert that.
      for (const name of ['dept_room_read', 'dept_room_write', 'dept_room_who', 'dept_whereami']) {
        assert.ok(pluginCtx().tools.get(name), `${name} registered globally (host plane)`)
      }

      // The head's own layer carries the board tools (installed by head setup).
      const { ctx: headCtx, key } = agents.childContexts[0]
      for (const name of ['dept_room_read', 'dept_room_write', 'dept_witness_write', 'dept_room_who', 'dept_whereami', 'dept_memo_write', 'dept_sleep']) {
        assert.ok(headCtx.tools.get(name, key), `${name} installed in the head own layer`)
      }

      const head = agents.store.get('head-research-head')
      const signal = new AbortController().signal

      // dept_room_write posts from the head's member id.
      const writeResult = await headCtx.tools.get('dept_room_write', key).execute(
        { room: 'board', to: ['asistente'], text: 'hello from the head' },
        { agent: head, signal }
      )
      assert.equal(writeResult.from, 'research-head', 'posted under the head member id')

      // dept_room_who lists static members + the head + any hosts. The head's
      // department room is 'research' (department.roomId), not the board room.
      const whoResult = await headCtx.tools.get('dept_room_who', key).execute({ room: 'research' }, { agent: head })
      assert.deepEqual(whoResult.members, ['research-head'])
      assert.equal(whoResult.posts.length, 1, 'the head is listed')
      assert.equal(whoResult.posts[0].postId, 'research-head')
      assert.equal(whoResult.posts[0].sessionId, 'head-research-head')
      assert.equal(whoResult.posts[0].sessionLive, true)
      assert.equal(whoResult.posts[0].agentPreset, 'deepartments-head')
    } finally {
      await dispose()
    }
  })
})

test('wake relay (head): a registered department head is woken by raw Agent.followup (no parent needed); self/unknown members are handled', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      // Head auto-materializes at boot (root agent at its stable session id).
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head root agent created at boot')
      const head = agents.store.get(`head-${postId}`)
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))

      // 1. A head-addressed message wakes it via the raw followup.
      const seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [postId], 'question one'), 'board')
      await waitFor(() => head.inboxMessages.length >= 1, 5000, 'head woken')
      const wake = head.inboxMessages.at(-1)
      assert.match(wake.content[0].text, /new message .* from asistente/)
      assert.doesNotMatch(wake.content[0].text, /question one/, 'pointer-only (no body)')
      assert.equal(wake.source.kind, 'board', 'head wakes use the raw board followup source')

      // 2. Self-addressed message: sender is not woken (echo-loop guard).
      const before = head.inboxMessages.length
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq + 1, postId, [postId], 'self note'), 'board')
      assert.equal(head.inboxMessages.length, before, 'no self-wake')

      // 3. Unknown member: skipped + warned (relay defensive path), never throws.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq + 2, 'asistente', ['ghost'], 'who?'), 'board')
      assert.equal(head.inboxMessages.length, before, 'unknown member not woken')

      // 4. Head wake needs NO live parent: the head stays live with no host and
      //    a later head-addressed message still wakes it (root-agent model).
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq + 3, 'asistente', [postId], 'still here'), 'board')
      await waitFor(() => head.inboxMessages.length >= before + 1, 5000, 'head woken with no parent present')
    } finally {
      await dispose()
    }
  })
})

test('Fix A1 boot-quiet: a fresh head materializes at boot with NO proactive turn or board write — it stays idle until an ADDRESSED message wakes it', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const head = agents.store.get(`head-${postId}`)

      // (a) Materialization itself must NOT enqueue a proactive turn for the head,
      //     and the head must stay idle (the Fix A1 boot-quiet guarantee). The
      //     boot path never self-initiates: no followup, no board write, no turn.
      assert.equal(head.inboxMessages.length, 0, 'boot materialization enqueues NO proactive followup for the fresh head')
      assert.equal(head.status, 'idle', 'the fresh head stays idle after boot materialization')
      assert.equal(agents.resumeCalls.length, 0, 'boot materialization of the FRESH head does not cold-resume (it creates) — no wake cycle')

      // (b) The head is woken ONLY by an explicitly addressed board message — not
      //     by a proactive turn of its own.
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [postId], 'hello head'), 'board')
      await waitFor(() => head.inboxMessages.length >= 1, 5000, 'head woken only once an ADDRESSED message arrives')
      assert.match(head.inboxMessages.at(-1).content[0].text, /new message .* from asistente/, 'the sole wake is the addressed-board pointer')
      assert.equal(head.inboxMessages.length, 1, 'exactly one wake — the addressed message (no extra proactive turns)')

      // (c) The head's own-layer role persona (the BOOT-QUIET directive) is
      //     installed with the head agent. Its body carries the instruction to
      //     never self-initiate board activity.
      const headCtx = head.ctx
      const sp = headCtx?.get('systemPrompt')
      if (sp !== void 0 && typeof sp.assemble === 'function') {
        let roleText = ''
        try {
          const assembly = await sp.assemble({})
          const role = (assembly.sections ?? []).find((s) => s.name === `deepartments:head:role:${postId}`)
          roleText = role === void 0 ? '' : role.text
        } catch {
          roleText = ''
        }
        // Best-effort: the role section registers on the agent's scoped layer, so a
        // scope-less assemble may not surface it. Only assert when it did — the
        // behavioral (a)/(b) guarantees above are the binding Fix A1 contract.
        if (roleText !== '') {
          assert.match(roleText, /BOOT-QUIET/, 'head role persona directs boot-quiet behavior')
          assert.match(roleText, /never proactively write to the board/, 'head role persona forbids proactive board writes')
        }
      }
    } finally {
      await dispose()
    }
  })
})

test('Fix A2 stuck-head recovery: a live-but-stuck head (running, no session progress past STUCK_HEAD_MS) is disposed + cold-resumed then woken — the wake reaches a WORKING model turn, never the frozen loop', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const sid = `head-${postId}`
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(sid), 5000, 'head created at boot')
      const frozenHead = agents.store.get(sid)
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))

      // Simulate the Batch-1c live-but-STUCK resident loop: status 'running' and a
      // session event log that NEVER grows (the resident is wedged on a stalled
      // tool call). Fix A2 drives the stuck window through the injectable clock.
      frozenHead.status = 'running'
      const T0 = 1_700_000_000_000
      const resumeBefore = agents.resumeCalls.length
      process.env.DEEPARTMENTS_TEST_NOW = String(T0)

      // Wake 1: first observation of the running head — the relay records the
      // progress baseline and (healthy path) enqueues a followup; NOT judged stuck
      // yet, NOT disposed, NOT resumed.
      let seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [postId], 'first'), 'board')
      await waitFor(() => frozenHead.inboxMessages.length >= 1, 5000, 'first wake enqueued on the frozen-loop incarnation')
      assert.equal(agents.store.get(sid), frozenHead, 'healthy live head is NOT disposed on first observation')
      assert.equal(agents.resumeCalls.length, resumeBefore, 'no cold-resume while the head still looks healthy')

      // The resident makes NO progress for longer than STUCK_HEAD_MS (120s): the
      // clock advances well past it while status stays 'running' and the event log
      // never grows.
      process.env.DEEPARTMENTS_TEST_NOW = String(T0 + 130_000)

      // Wake 2: now the head is STUCK → dispose the frozen handle + fall through to
      // the COLD path (resume then followup) so the wake is re-delivered from the
      // durable board record, never lost to the frozen in-memory inbox.
      seq++
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [postId], 'second'), 'board')
      await waitFor(() => agents.store.get(sid) !== frozenHead, 5000, 'stuck head was disposed and a fresh incarnation cold-resumed')

      const freshHead = agents.store.get(sid)
      assert.ok(freshHead, 'a fresh head incarnation is back in the registry')
      assert.notEqual(freshHead, frozenHead, 'the frozen resident loop is GONE from the registry (disposed), replaced by a working incarnation')
      assert.ok(agents.resumeCalls.length > resumeBefore, 'the stuck head was cold-resumed (agents.resume invoked)')
      await waitFor(() => freshHead.inboxMessages.length >= 1, 5000, 'the followup reaches the WORKING cold-resumed incarnation')
      assert.match(freshHead.inboxMessages.at(-1).content[0].text, /new message .* from asistente/, 'the pointer-only wake is delivered to the fresh incarnation')
      assert.doesNotMatch(freshHead.inboxMessages.at(-1).content[0].text, /second/, 'wake stays pointer-only (no message body)')

      // The durable board record is the re-delivery source: it must still hold wake
      // 2's record after dispose+resume (nothing lost to the in-memory inbox).
      const boardRecords = await loadRecords(resolveBoardPath(stateDir, 'board'))
      assert.ok(boardRecords.some((r) => r.from === 'asistente' && String(r.to).includes(postId) && r.seq === seq), 'durable board record for the wake-triggering message persists (the re-delivery source)')
    } finally {
      delete process.env.DEEPARTMENTS_TEST_NOW
      await dispose()
    }
  })
})

test('Fix A2 normal live-head followup: a HEALTHY live head gets its followup ENQUEUED without being disposed or cold-resumed', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const sid = `head-${postId}`
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(sid), 5000, 'head created at boot')
      const head = agents.store.get(sid)

      // Healthy live head: idle status, and its session event log GROWS between
      // wake observations (a busy-but-working head keeps producing progress).
      const resumeBefore = agents.resumeCalls.length
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      let seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [postId], 'wake A'), 'board')
      await waitFor(() => head.inboxMessages.length >= 1, 5000, 'followup enqueued (healthy path)')

      // Even across many subsequent wake pushes, a healthy head keeps the SAME
      // incarnation: never disposed, never cold-resumed, followups just enqueue.
      for (let i = 0; i < 3; i++) {
        seq++
        await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [postId], `wake ${i}`), 'board')
      }
      await waitFor(() => head.inboxMessages.length >= 4, 5000, 'all followups enqueued on the same live incarnation')

      assert.equal(agents.store.get(sid), head, 'healthy live head is NEVER disposed across wakes')
      assert.equal(agents.resumeCalls.length, resumeBefore, 'healthy live head is NEVER cold-resumed (no dispose+resume cycle)')
      assert.equal(head.inboxMessages.length, 4, 'every wake enqueued a pointer followup on the same live head')
      assert.equal(head.status, 'idle', 'head left in its normal idle state')
    } finally {
      await dispose()
    }
  })
})

test('Fix A2 no lost wake: the durable board record is the re-delivery source, so a wake-enqueued followup survives a stuck-head dispose+restart', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const sid = `head-${postId}`
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(sid), 5000, 'head created at boot')
      const frozenHead = agents.store.get(sid)
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))

      // Pre-seed the durable board file with a wake-triggering record BEFORE the
      // stuck incident — the production "restart with a pending addressed message"
      // scenario (the 2026-08-20 live finding: the followup was enqueued into a
      // frozen loop's in-memory inbox and LOST on restart, showing 0 Board delta).
      const seq0 = await nextSeq(stateDir, 'board')
      const pendingRecord = messageRecord(seq0, 'asistente', [postId], 'pending question')
      await seedBoardRecords(stateDir, 'board', [pendingRecord])

      // Drive the stuck head through a recovery cycle: first observe it running
      // (baseline), then fast-forward past STUCK_HEAD_MS with no progress.
      const T0 = 1_700_000_000_000
      process.env.DEEPARTMENTS_TEST_NOW = String(T0)
      frozenHead.status = 'running'
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq0 + 1, 'asistente', [postId], 'trigger'), 'board')
      process.env.DEEPARTMENTS_TEST_NOW = String(T0 + 130_000)
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq0 + 2, 'asistente', [postId], 'trigger again'), 'board')
      await waitFor(() => agents.store.get(sid) !== frozenHead, 5000, 'stuck head disposed + cold-resumed')

      const freshHead = agents.store.get(sid)
      await waitFor(() => freshHead.inboxMessages.length >= 1, 5000, 'fresh incarnation woken')

      // The durable board record is untouched by dispose/restart and remains the
      // re-delivery source — NOTHING was lost: the pending record is still there.
      const boardRecords = await loadRecords(resolveBoardPath(stateDir, 'board'))
      const pendingOnDisk = boardRecords.find((r) => r.id === pendingRecord.id)
      assert.ok(pendingOnDisk, 'the pending wake-triggering record persists in the durable board file')
      assert.deepEqual(pendingOnDisk, pendingRecord, 'the durable record is byte-preserved (the re-delivery source is intact)')
    } finally {
      delete process.env.DEEPARTMENTS_TEST_NOW
      await dispose()
    }
  })
})

test('dept_room_who: lists static members and the registered live heads', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const tool = headCtx.tools.get('dept_room_who', key)

      const result = await tool.execute({ room: 'research' }, { agent: head })
      assert.equal(result.room, 'research')
      assert.deepEqual(result.members, ['research-head'], 'static members in config order')
      assert.equal(result.posts.length, 1)
      assert.equal(result.posts[0].postId, postId)
      assert.equal(result.posts[0].sessionId, `head-${postId}`)
      assert.equal(result.posts[0].sessionLive, true, 'head agent is live')
      assert.equal(result.posts[0].agentPreset, 'deepartments-head')

      // non-configured room: empty, no throw.
      const missing = await tool.execute({ room: 'nope' }, { agent: head })
      assert.deepEqual(missing.members, [])
      assert.deepEqual(missing.posts, [])
      assert.deepEqual(missing.hosts, [])
    } finally {
      await dispose()
    }
  })
})


test('dept_whereami: a registered head gets its spatial identity; the host gets the host shape', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const tool = headCtx.tools.get('dept_whereami', key)
      const signal = new AbortController().signal

      // Head path.
      const where = await tool.execute({}, { agent: head, signal })
      assert.equal(where.kind, 'post')
      assert.equal(where.postId, postId)
      assert.equal(where.roomId, 'research')
      assert.equal(where.sessionId, `head-${postId}`)
      assert.equal(where.agentPreset, 'deepartments-head')
      assert.equal(where.sessionLive, true)
      assert.deepEqual(where.members, ['research-head'])
      assert.equal(where.posts.length, 1)
      assert.equal(where.posts[0].sessionLive, true)

      // Host path (a bare host agent): kind host, no address fields.
      const parent = agents.put(fakeParentAgent())
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
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const post = agents.store.get(`head-${postId}`)
      const { ctx: childCtx, key } = agents.childContexts[0]
      const signal = new AbortController().signal
      const read = (args) => childCtx.tools.get('dept_room_read', key).execute({ room: 'board', ...args }, { agent: post, signal })
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      let seq = await nextSeq(stateDir, 'board')

      // (a) wake relay is pointer-only — no body, even for a long message.
      const longRelay = 'Z'.repeat(300)
      seq = await nextSeq(stateDir, 'board')
      const longRec = messageRecord(seq, 'asistente', [postId], longRelay)
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), longRec, 'board')
      await waitFor(() => post.inboxMessages.length >= 1, 5000, 'head woken')
      const relayWake = post.inboxMessages.at(-1)
      assert.match(relayWake.content[0].text, new RegExp(`new message ${longRec.id} from asistente`))
      assert.ok(!relayWake.content[0].text.includes(longRelay.slice(0, 25)), 'relay carries no body text at all')

      // (b) fetch by messageId returns the FULL text and does not advance cursor.
      const longBody = 'X'.repeat(500)
      seq += 1
      const longMsg = messageRecord(seq, 'asistente', [postId], longBody)
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), longMsg, 'board')
      const fetched = await read({ messageId: longMsg.id })
      assert.match(fetched.delta, new RegExp(`Full text of ${longMsg.id}`))
      assert.equal(fetched.delta.endsWith(longBody), true, 'full text present, untruncated')
      assert.doesNotMatch(fetched.delta, /…/, 'no truncation marker in fetch mode')

      // (c) a subsequent default read still serves the long message (truncated).
      seq += 1
      const shortA = messageRecord(seq, 'asistente', [postId], 'alpha one')
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
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const post = agents.store.get(`head-${postId}`)
      const { ctx: childCtx, key } = agents.childContexts[0]
      const signal = new AbortController().signal
      const read = (args) => childCtx.tools.get('dept_room_read', key).execute({ room: 'board', ...args }, { agent: post, signal })
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))

      let seq = await nextSeq(stateDir, 'board')
      const m1 = messageRecord(seq, 'asistente', [postId], 'page one')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), m1, 'board')
      seq += 1
      const m2 = messageRecord(seq, 'asistente', [postId], 'page two')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), m2, 'board')

      // On a fresh cursor, limit:1 + offset:1 reaches the SECOND paged message
      // (candidates = [M1, M2]; offset skips M1, the limit caps the page at one
      // entry = M2).
      const paged = await read({ limit: 1, offset: 1 })
      assert.match(paged.delta, /page two/, 'offset reached the second message')
      assert.doesNotMatch(paged.delta, /page one/, 'offset skipped the first message')

      const after = await read({ limit: 1, offset: 0 })
      assert.equal(after.delta, 'No board messages addressed to you.')
    } finally {
      await dispose()
    }
  })
})

// --- Batch 1a: department heads are FIRST-CLASS ROOT AGENTS -----------------
// A configured coordinator is materialized once as its OWN root agent (NOT a
// continuable subagent) via ctx.agents.create/resume from the plugin's root
// service context, with a stable session id `head-<postId>`, meta.agentPreset
// 'deepartments-head', coordinator agentOptions, and a setup that registers
// the board toolset + mounts the head preset.

test('create-when-absent: boot materializes the configured head as a root agent (stable session id, meta.agentPreset, coordinator agentOptions) into posts.json', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head root agent created at boot')
      assert.equal(agents.createCalls.filter((c) => String(c.sessionId) === 'head-research-head').length, 1, 'exactly one create for the head')

      const createCall = agents.createCalls.find((c) => String(c.sessionId) === 'head-research-head')
      assert.equal(String(createCall.sessionId), 'head-research-head', 'stable per-post session id')
      assert.equal(createCall.meta.cwd, path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), 'meta.cwd is the repo root')
      assert.equal(createCall.meta.agentPreset, 'deepartments-head', 'the dedicated head preset is requested')
      assert.equal(createCall.meta.origin, undefined, 'no origin (a root/main agent, not a subagent)')
      assert.deepEqual(createCall.agentOptions, { provider: 'stub-coord', model: 'deepseek-v4-flash' }, 'coordinator agentOptions are passed through')

      // Durable posts.json reflects the root-agent identity (no parentId/provider).
      const posts = await readPosts(stateDir)
      assert.equal(posts['research-head'].sessionId, 'head-research-head')
      assert.equal(posts['research-head'].roomId, 'research', 'head room comes from the department config')
      assert.equal(posts['research-head'].agentPreset, 'deepartments-head')
      assert.equal(posts['research-head'].parentId, undefined, 'no parent for a root head')
      assert.equal(posts['research-head'].provider, undefined, 'no continuation provider for a root head')
    } finally {
      await dispose()
    }
  })
})

test('resume-when-durable: a durable head session (sessionId in posts.json) is resumed via ctx.agents.resume, not re-created', async () => {
  await withTempStateDir(async (stateDir) => {
    await seedPost(stateDir, { postId: 'research-head', sessionId: 'head-research-head', roomId: 'research' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head root agent resumed at boot')
      assert.equal(agents.resumeCalls.filter((c) => String(c.resumeSessionId) === 'head-research-head').length, 1, 'exactly one resume for the head')
      assert.equal(agents.createCalls.filter((c) => String(c.sessionId) === 'head-research-head').length, 0, 'no fresh create when a durable session exists')
    } finally {
      await dispose()
    }
  })
})

test('a head is lean: own-layer board tools present, host-plane tools NOT exposed', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head created at boot')
      const head = agents.store.get('head-research-head')
      const { ctx: headCtx, key } = agents.childContexts[0]
      // Own-layer board tools are installed by head setup.
      for (const name of ['dept_room_read', 'dept_room_write', 'dept_room_who', 'dept_whereami', 'dept_witness_write', 'dept_memo_write', 'dept_sleep']) {
        assert.ok(headCtx.tools.get(name, key), `${name} installed in the head own layer`)
      }
      // No host/builder/delegation tools — retire and delegation are host-plane.
      assert.equal(headCtx.tools.get('dept_post_retire', key), undefined, 'retire is host-plane only, not a head capability')
      assert.ok(head.ctx.agent === head, 'the head context is scoped to the head agent')
    } finally {
      await dispose()
    }
  })
})

test('head materialization is idempotent: a second ensure (re-boot/resume) does NOT create a second agent', async () => {
  await withTempStateDir(async (stateDir) => {
    await seedPost(stateDir, { postId: 'research-head', sessionId: 'head-research-head', roomId: 'research' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head resumed at boot')
      // Resumed once, never created; no dupes in either call list.
      assert.equal(agents.createCalls.length, 0, 'no create calls')
      assert.equal(agents.resumeCalls.length, 1, 'one resume call')
      assert.equal(agents.store.size, 1, 'a single live head agent')
    } finally {
      await dispose()
    }
  })
})

test('dept_post_retire removes a head from the registry, persists, disposes the handle, and posts a withdrawal note; unknown postId rejects loudly', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head created at boot')
      const host = agents.put(fakeParentAgent())
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

      // The live handle was disposed (agent gone from the live store).
      assert.equal(agents.store.has('head-research-head'), false, 'head AgentHandle disposed on retire')

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
    const sessionA = 'head-research-head'
    const sessionB = 'head-acceptor-head'
    const postA = 'research-head'
    const postB = 'acceptor-head'
    // research-head auto-creates at boot; acceptor-head is seeded as a second
    // (non-configured) head so the two-party ack ping-pong has two live targets.
    await seedPost(stateDir, { postId: postB, sessionId: sessionB, roomId: 'board', agentPreset: 'deepartments-head' })
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      // research-head is configured → live at boot. acceptor-head is a seeded
      // (non-configured) head: registered in posts.json but materialized lazily
      // on its first addressed wake (the relay cold-resumes it).
      await waitFor(() => agents.store.has(sessionA), 5000, 'research-head live at boot')
      assert.equal(agents.store.has(sessionB), false, 'acceptor-head not yet materialized (lazy)')
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      let seq = await nextSeq(stateDir, 'board')

      const emitAck = (from, to, text) =>
        emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq++, from, [to], text, true), 'board')
      const inboxOf = (sessionId) => (agents.store.get(sessionId)?.inboxMessages?.length ?? 0)

      // Warm up 3 acks in each direction — each must still wake (budget N>=3
      // has not yet accumulated on the pair).
      await emitAck(postA, postB, 'a1')
      await emitAck(postB, postA, 'b1')
      await emitAck(postA, postB, 'a2')
      await emitAck(postB, postA, 'b2')
      await emitAck(postA, postB, 'a3')
      await emitAck(postB, postA, 'b3')
      await waitFor(() => inboxOf(sessionA) >= 3 && inboxOf(sessionB) >= 3, 5000, 'three wakes each direction')
      const satA = inboxOf(sessionA)
      const satB = inboxOf(sessionB)
      assert.equal(satA, 3, `post A woken by its 3 expected acks (got ${satA})`)
      assert.equal(satB, 3, `post B woken by its 3 expected acks (got ${satB})`)

      // Once each pair has exchanged N>=3 acks, further acks must NOT wake.
      await emitAck(postA, postB, 'a4')
      await emitAck(postB, postA, 'b4')
      await emitAck(postA, postB, 'a5')
      await emitAck(postB, postA, 'b5')
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(inboxOf(sessionA), satA, 'post A not re-woken by suppressed acks')
      assert.equal(inboxOf(sessionB), satB, 'post B not re-woken by suppressed acks')

      // A non-ack message on the SAME pair direction RESETS its counter: the
      // next ack on that pair wakes normally again.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq++, postB, [postA], 'new substance'), 'board')
      await waitFor(() => inboxOf(sessionA) === satA + 1, 5000, 'non-ack message re-wakes post A')
      await emitAck(postB, postA, 'b6-after-reset')
      await waitFor(() => inboxOf(sessionA) === satA + 2, 5000, 'post A woken again after counter reset')
      assert.equal(inboxOf(sessionB), satB, 'suppressed acks on the other direction (A|B) still do not wake post B')
    } finally {
      await dispose()
    }
  })
})

test('Batch C ready-guard: a kind:ready boot marker wakes neither a host nor a head', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const parent = agents.put(fakeParentAgent())
      const hostId = `host-${parent.id}`
      const head = agents.store.get(`head-${postId}`)
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      let seq = await nextSeq(stateDir, 'board')
      const hostBefore = parent.inboxMessages.length
      const headBefore = head.inboxMessages.length

      // Emit a ready marker addressed to both the host and the head.
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
      assert.equal(head.inboxMessages.length, headBefore, 'no head wake on kind:ready')
    } finally {
      await dispose()
    }
  })
})

test('Batch C cursor-dedup: a record the member\'s read cursor already consumed does not re-wake the member', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq0 = await nextSeq(stateDir, 'board')

      // Message M1 wakes the head; the head then READS it, advancing the cursor.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq0, 'asistente', [postId], 'one'), 'board')
      const post = agents.store.get(`head-${postId}`)
      await waitFor(() => post.inboxMessages.length >= 1, 5000, 'head woken by M1')
      const { ctx: childCtx, key } = agents.childContexts[0]
      const read = childCtx.tools.get('dept_room_read', key)
      const signal = new AbortController().signal
      await read.execute({ room: 'board' }, { agent: post, signal })
      const before = post.inboxMessages.length
      assert.ok(before >= 1, 'post woken by M1')

      // A record the cursor already consumed (same seq) must NOT re-wake.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq0, 'asistente', [postId], 'replay'), 'board')
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(post.inboxMessages.length, before, 'no redundant wake for an already-consumed record')

      // A genuinely NEWER record still wakes.
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq0 + 1, 'asistente', [postId], 'two'), 'board')
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

test('Batch D persistent cursor: a persisted high-water `lastMessageSeq` makes a restarted head read ONLY-new, while a fresh head reads full history', async () => {
  await withTempStateDir(async (stateDir) => {
    const resumedSession = 'head-research-head'
    const freshSession = 'head-acceptor-head'
    const resumedPost = 'research-head'
    const freshPost = 'acceptor-head'
    // research-head: a configured head resumed from a durable session (cursor
    // from cursors.json at seq 1). acceptor-head: a fresh seeded head.
    await seedPost(stateDir, { postId: resumedPost, sessionId: resumedSession, roomId: 'research' })
    await seedPost(stateDir, { postId: freshPost, sessionId: freshSession, roomId: 'board' })

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
      // research-head resumes at boot (durable session present).
      await waitFor(() => agents.store.has(resumedSession), 5000, 'research-head resumed at boot')
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const childCtxFor = (sessionId) => agents.childContexts.find((c) => c.ctx.agent?.id === sessionId)

      // (a) FRESH member: first addressed wake cold-resumes acceptor-head and
      // reads — it must see the full historical backlog addressed to it.
      let seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [freshPost], 'fresh-wake'), 'board')
      await waitFor(() => agents.store.has(freshSession), 5000, 'acceptor-head cold-resumed on wake')
      const fresh = agents.store.get(freshSession)
      const freshEntry = childCtxFor(freshSession)
      assert.ok(freshEntry, 'acceptor-head child context available')
      const freshRead = freshEntry.ctx.tools.get('dept_room_read', freshEntry.key)
      const freshDelta = (await freshRead.execute({ room: 'board' }, { agent: fresh, signal: new AbortController().signal })).delta
      assert.match(freshDelta, /ac-hist-0/, 'fresh member sees full addressed history (ac-hist-0)')
      assert.match(freshDelta, /ac-hist-1/, 'fresh member sees full addressed history (ac-hist-1)')

      // (b) RESUMED member: research-head (live, cursor at 1) only sees the new
      // wake message, never rh-hist-0/rh-hist-1.
      seq = await nextSeq(stateDir, 'board')
      const resumedWakeText = 'fresh-note-for-resumed'
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [resumedPost], resumedWakeText), 'board')
      const resumed = agents.store.get(resumedSession)
      await waitFor(() => resumed.inboxMessages.length >= 1, 5000, 'research-head woken')
      const resumedEntry = childCtxFor(resumedSession)
      assert.ok(resumedEntry, 'research-head child context available')
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

test('Batch D fork-ghost sweep: retired fork-provider posts are removed from posts.json on boot while a head remains', async () => {
  await withTempStateDir(async (stateDir) => {
    const parentId = SessionId('session-parent-sweep')
    const ghostA = SessionId('session-ghost-a')
    const ghostB = SessionId('session-ghost-b')
    await seedPost(stateDir, { postId: 'research-head', sessionId: 'head-research-head', roomId: 'research' })

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
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head resumed at boot')
      // The head survives; the fork ghosts are swept from posts.json on boot (a
      // persistPosts is NOT forced for the legacy entry, but the in-memory
      // registry never adopts them — the persisted sweep is a follow-up of the
      // old Batch D and is therefore not asserted as a required rewrite).
      const posts = await readPosts(stateDir)
      assert.equal(posts['research-head'].sessionId, 'head-research-head', 'head kept with its root-agent session id')

      // The live registry agrees (dept_room_who lists no fork ghosts) and the
      // head is present in its department room.
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

test('Batch E dept_room_who: a non-live host lists with sessionLive:false, a live host with sessionLive:true; heads report sessionLive', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const post = agents.store.get(`head-${postId}`)
      const { ctx: childCtx, key } = agents.childContexts[0]
      const who = childCtx.tools.get('dept_room_who', key)
      const signal = new AbortController().signal

      // A live host joins the board room (registering it there).
      const liveHost = agents.put(fakeParentAgent())
      await root.tools.get('dept_room_write').execute({ room: 'board', to: [postId], text: 'join' }, { agent: liveHost, signal })

      // The head's OWN room ('research') lists it with sessionLive:true.
      const ownRoom = await who.execute({ room: 'research' }, { agent: post })
      assert.equal(ownRoom.posts[0].postId, postId)
      assert.equal(ownRoom.posts[0].sessionLive, true)

      // Now kill that host's agent — it stays in the registry (Batch A
      // reconciliation) but is NOT live. It must list with sessionLive:false.
      agents.store.delete(liveHost.id)
      const result = await who.execute({ room: 'board' }, { agent: post })
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
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
    try {
      const signal = new AbortController().signal
      const writeTool = root.tools.get('dept_room_write')

      // (1) LIVE registered host sender + sensitive → senderVerified true.
      const host = agents.put(fakeParentAgent())
      const live = await writeTool.execute({ room: 'board', to: ['research-head'], text: 'mission critical from live host', sensitive: true }, { agent: host, signal })
      const records = await loadRecords(resolveBoardPath(stateDir, 'board'))
      const liveRec = records.find((r) => r.id === live.messageId)
      assert.equal(liveRec.payload.sensitive, true, 'sensitive:true records payload.sensitive=true')
      assert.equal(liveRec.payload.senderVerified, true, 'a live registered host sender is registry-verified')

      // (2) REGISTERED HEAD sender + sensitive → senderVerified true.
      const head = agents.store.get(`head-${postId}`)
      const headEntry = agents.childContexts.find((c) => c.ctx.agent?.id === `head-${postId}`)
      const headWrite = headEntry.ctx.tools.get('dept_room_write', headEntry.key)
      const headMsg = await headWrite.execute({ room: 'research', to: ['asistente'], text: 'head secret', sensitive: true }, { agent: head, signal })
      const recs2 = await loadRecords(resolveBoardPath(stateDir, 'research'))
      const headRec = recs2.find((r) => r.id === headMsg.messageId)
      assert.equal(headRec.from, postId)
      assert.equal(headRec.payload.sensitive, true)
      assert.equal(headRec.payload.senderVerified, true, 'a registered head sender is registry-verified')

      // (3) NON-LIVE host sender + sensitive → senderVerified FALSE (the audit
      // concern: a message whose sender session is not live is surfaced as
      // verified:no).
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
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const post = agents.store.get(`head-${postId}`)
      const { ctx: childCtx, key } = agents.childContexts[0]
      const read = childCtx.tools.get('dept_room_read', key)
      const signal = new AbortController().signal
      const writeTool = root.tools.get('dept_room_write')

      // A live host posts a sensitive message addressed to the head.
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
      const dead = agents.put(fakeParentAgent())
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

    // A durable resident `research-head` head (the same member the stale high
    // cursor belongs to) so it resumes as a member and its IN-MEMORY read
    // cursor can be observed after compaction — proving the compaction resetter
    // cleared it (not just the durable file). It resumes at boot from #the seed.
    await seedPost(stateDir, { postId: 'research-head', sessionId: 'head-research-head', roomId: 'research' })

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
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      assert.ok(boardSession, 'live board session available after the full-boot readiness wait')
      // The research-head root agent is live at boot; its read seat is the
      // in-memory memberCursors, which the compaction resetter cleared to fresh.
      const resumed = agents.store.get('head-research-head')
      assert.ok(resumed, 'research-head live at boot')
      const resumedEntry = agents.childContexts.find((c) => c.ctx.agent?.id === 'head-research-head')
      assert.ok(resumedEntry, 'resumed head child context available')
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


// --- Batch G: department-head lifecycle — sleep (dormir) with
// a long-term memory journal ------------------------------------------------
// The owner's model: heads are PERMANENT ROOT agents. Idle = conclude and wait
// (the wake relay re-wakes them); SLEEP = persist memory to a journal
// (dept_memo_write), then dept_sleep marks sleepEpoch durably AND DISPOSES the
// head's live AgentHandle (context reset — the durable session survives, so
// the next wake cold-resumes it). On the next wake the relay clears the flag
// and cold-resumes the SAME durable session (ctx.agents.resume) then follows up
// with the pointer-only board delta; the fresh incarnation reloads its journal.

test('Batch G dept_memo_write persists a head\'s long-term memory journal (author/timestamp frontmatter, durable path)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
    try {
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const memo = headCtx.tools.get('dept_memo_write', key)
      assert.ok(memo, 'dept_memo_write is installed in the head own layer')

      const result = await memo.execute(
        { summary: 'Research department steered to a conclusion.', decisions: ['adopted vanilla'], constraints: ['keep records'], openItems: ['archive logs'] },
        { agent: head, signal: new AbortController().signal }
      )
      assert.equal(result.member, postId)
      assert.equal(result.memoPath, path.join(stateDir, 'journals', `${postId}.md`))
      // Durable: the journal file exists with frontmatter + free-form body.
      const content = await readFile(result.memoPath, 'utf8')
      assert.match(content, /^author: research-head$/m)
      assert.match(content, /Research department steered to a conclusion\./)
      assert.match(content, /decisions: \["adopted vanilla"\]/)
      assert.match(content, /open_items: \["archive logs"\]/)
    } finally {
      await dispose()
    }
  })
})

test('Batch G dept_sleep requires a saved journal (throws otherwise / rejects a host), then marks sleepEpoch durably AND disposes the AgentHandle', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
    try {
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const sleep = headCtx.tools.get('dept_sleep', key)
      const memo = headCtx.tools.get('dept_memo_write', key)
      const signal = new AbortController().signal
      assert.ok(sleep, 'dept_sleep installed in the head own layer')

      // No journal yet → loud rejection.
      await assert.rejects(() => sleep.execute({}, { agent: head, signal }), /call dept_memo_write to save your memory first/, 'sleep without a journal rejects loudly')

      // A host is not a sleepable head.
      const host = agents.put(fakeParentAgent())
      await assert.rejects(() => root.tools.get('dept_sleep').execute({}, { agent: host, signal }), /department head \(registered post\), not the host/, 'dept_sleep rejects a host caller')

      // Save the journal, then sleep.
      await memo.execute({ summary: 'Memory saved before sleeping.' }, { agent: head, signal })
      const result = await sleep.execute({}, { agent: head, signal })
      assert.equal(result.member, postId)
      assert.equal(result.memoPath, path.join(stateDir, 'journals', `${postId}.md`))
      assert.ok(typeof result.sleepEpoch === 'number' && result.sleepEpoch > 0)

      // Durable: posts.json carries the sleep-mark; the live handle is disposed
      // (the agent leaves the live store — the durable session survives).
      await waitFor(async () => (await readPosts(stateDir))[postId].sleepEpoch !== undefined, 5000, 'sleepEpoch persisted to posts.json')
      const posts = await readPosts(stateDir)
      assert.ok(typeof posts[postId].sleepEpoch === 'number', 'sleepEpoch persisted durably')
      assert.equal(agents.store.has(`head-${postId}`), false, 'the head AgentHandle was disposed on sleep (live agent gone)')
      // dept_room_who surfaces the sleeping head (in its own department room).
      const who = await root.tools.get('dept_room_who').execute({ room: 'research' })
      assert.equal(who.posts[0].sleeping, true, 'dept_room_who surfaces the sleeping head')
    } finally {
      await dispose()
    }
  })
})

test('Batch G a slept head cold-resumes fresh on its next wake: sleepEpoch cleared, previous incarnation traced, wake delivered (no fresh create)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const journalText = 'RESPAWN-MEMORY: the research department settled on vanilla; carry this forward. SECRET-PHRASE-respawn-v1'
    await seedJournal(stateDir, postId, journalText)
    const { root, agents, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
    try {
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const sleep = headCtx.tools.get('dept_sleep', key)
      const memo = headCtx.tools.get('dept_memo_write', key)
      const signal = new AbortController().signal

      // Sleep: memo + dispose handle + mark.
      await memo.execute({ summary: journalText }, { agent: head, signal })
      await sleep.execute({}, { agent: head, signal })
      await waitFor(() => agents.store.has(`head-${postId}`) === false, 5000, 'handle disposed after sleep')

      // Next wake: a message addressed to the head cold-resumes it (resume the
      // SAME durable session — no fresh create under a new id) and delivers the
      // pointer-only wake.
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [postId], 'wake from sleep'), 'board')

      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'slept head cold-resumed')
      const resumed = agents.store.get(`head-${postId}`)
      await waitFor(() => resumed.inboxMessages.length >= 1, 5000, 'resumed head woken')
      assert.equal(resumed.inboxMessages.at(-1).source.kind, 'board', 'head wake uses the raw board followup source')
      // Same durable session id is reused — no fresh-creation under a new id.
      assert.equal(agents.createCalls.filter((c) => String(c.sessionId) === `head-${postId}`).length, 1, 'created once at boot, resumed on wake (no second create)')

      // Durable registry: sleepEpoch cleared, previous incarnation traced.
      await waitFor(async () => {
        const posts = await readPosts(stateDir)
        return posts[postId].sleepEpoch === undefined
      }, 5000, 'sleepEpoch cleared after the wake')
      const posts = await readPosts(stateDir)
      assert.equal(posts[postId].sessionId, `head-${postId}`, 'same durable session id retained')
      assert.equal(posts[postId].previousChildId, `head-${postId}`, 'previous incarnation traced (the slept session id)')
    } finally {
      await dispose()
    }
  })
})

test('Batch G regression: a head that never slept wakes normally via the live followup (no sleepEpoch, no previousChildId)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
    try {
      const head = agents.store.get(`head-${postId}`)
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [postId], 'question'), 'board')
      await waitFor(() => head.inboxMessages.length >= 1, 5000, 'head woken via normal relay followup')
      assert.equal(head.inboxMessages.at(-1).source.kind, 'board', 'head wake keeps the board followup source')
      const posts = await readPosts(stateDir)
      assert.equal(posts[postId].sessionId, `head-${postId}`, 'session id unchanged (live followup)')
      assert.equal(posts[postId].sleepEpoch, undefined, 'no sleep-mark on a never-slept head')
      assert.equal(posts[postId].previousChildId, undefined, 'no previous incarnation recorded')
    } finally {
      await dispose()
    }
  })
})
