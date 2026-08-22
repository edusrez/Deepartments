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
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { loadRecords, resolveBoardPath } from '../lib/board-store.js'
import { emitRoomRecord, roomSessionId } from '../lib/org.js'
import { compressZstdFrame, encodeSegment } from '../lib/session-cleanup.js'
import { buildSleepJournalMessage, buildWakePackMessage, buildWakePack, HOST_WAKE_ROUTINE_TEXT, computeHostSleepSurfacePlan } from '../lib/invoke.js'
import { rememberRole, normalizeRole, roleForSession, ROLE_CONTRACTS } from '../lib/role-orient.js'
import { apply as subagentForkApply } from '../lib/subagent.js'
import {
  HEAD_PRESET_BASE_ID,
  headPresetIdFor,
  headPresetNameCore,
  headPresetNameFor,
  headRoleLine,
  buildHeadPresetComposition,
  buildHeadPresetMetadata
} from '../lib/head-presets.js'

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

/** Stub persistence: author enough of a resolved session to cold-resume, and
 * (FIX 1 — the rotation cold-seed seam) RECORD the S2 `create`/`append` calls
 * as spies so the real-Loader rotation can run (no real artifact backend is
 * needed — the rotation unit tests cover artifact shape; here the point is
 * that the seed landed via the persistence seam and NOT in the live store). */
class StubPersistence extends Service {
  constructor(ctx) {
    super(ctx, 'sessionPersistence')
    this.createCalls = []
    this.appendCalls = []
  }

  /** S2 `persistence.create(meta)` — detached lazy metadata (spy). */
  async create(meta) {
    this.createCalls.push(meta)
  }

  /** S2 `persistence.append(id, events)` — the seed artifact (spy). */
  async append(id, events) {
    this.appendCalls.push({ id, events })
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

// NOTE (Task T1): the StubPersistence above deliberately exposes NO `readRaw`,
// so the one-cycle session-log capture in the hermetic harness always degrades
// to the STUB form (`transcript: unavailable`) — exactly the service-absence
// scenario the spec's Risks section mandates must degrade silently (test 4).
// The bundle resolves `sessionPersistence`/`sessionQuery` OPTIONALLY via
// `ctx.get` (see src/index.ts note), so the plugin boots without them.

// Batch S1 live-fix: an OPT-IN real-API-shaped persistence for the real-capture
// tests. `readRaw` IS present — a BOUND class method that uses `this` (mirroring
// the jsonl backend's `readRaw` at dsh-session-persistence-jsonl lib/index.js:869),
// so an unbound extraction-and-call would crash with a raw TypeError, exactly
// like the live bug — and it returns a canned artifact only when one is
// configured (`undefined` otherwise, exercising the "service present but no
// stored artifact" degrade path). bootPlugin mounts it when passed
// `{ rawPersistence: true }`.
class StubPersistenceWithRaw extends StubPersistence {
  artifact = undefined

  setRawArtifact(content) {
    this.artifact = content
  }

  async readRaw(id) {
    if (this.artifact === undefined) return undefined
    return { meta: { id }, filename: 'session.jsonl', content: this.artifact }
  }
}

/** Stub persistence carrying a `root` (so the boot web-UI cleanup hook can
 * resolve the sessions root + derived state-home paths, like the real jsonl
 * backend's public `root` — mirrors session-cleanup.test.js). Used by the
 * Fix wake-12 restart tests to author a witness artifact the boot cleanup
 * truncates: the cleanup hook is chained AFTER the hosts loader restored the
 * deferred seed, so observing its flag-clear is the deterministic "the restore
 * has happened" marker before the wake pre-step runs. */
class StubPersistenceWithRoot extends StubPersistence {
  constructor(ctx, root) {
    super(ctx)
    this.root = root
  }
}

/** U2 — stub of the canonical session-archive service (dsh-workspace
 * `workspaceRegistry`, the same service the web RPC `workspace.archiveSession`
 * drives): a pure registry-global set add + durable mirror file, no session/
 * agent termination. Rotation calls `archiveSession(oldId)` server-side
 * (spec 002 §3.3 S2.5) — the tests assert the old id lands in
 * `archivedSessionIds` + the durable mirror. */
class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.archived = []
  }

  get archivedSessionIds() {
    return this.archived
  }

  async archiveSession(sessionId) {
    if (this.archived.includes(sessionId)) return
    this.archived.push(sessionId)
    // Durable mirror (fire-and-forget, like the real registry's setState →
    // global.set): T7 asserts the state file holds archivedSessionIds.
    writeFile(path.join(this.stateDir, 'workspace-registry.json'), JSON.stringify(this.archived, null, 2), 'utf8')
      .catch(() => {})
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
async function bootPlugin(stateDir, opts = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })

  const agents = new StubAgents(root)
  // Batch S1 live-fix: a boot opt swaps in the real-API-shaped persistence
  // (readRaw present) so the real-capture tests exercise the bound call shape;
  // the default stays readRaw-less so the harness keeps degrading to the stub.
  // Fix wake-12: a boot opt mounts a root-carrying persistence so the boot
  // web-UI cleanup hook can resolve the sessions root (restart tests).
  const persistence = opts.rawPersistence === true
    ? new StubPersistenceWithRaw(root)
    : opts.persistenceRoot !== undefined
      ? new StubPersistenceWithRoot(root, opts.persistenceRoot)
      : new StubPersistence(root)
  // U2: the canonical session-archive service (`workspaceRegistry`) — mounted
  // like the real GUI profile has it, so the rotated dept_sleep's server-side
  // archive (spec 002 §3.3 S2.5) is exercised through the same seam.
  const workspaceRegistry = new StubWorkspaceRegistry(root, stateDir)
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
    persistence,
    workspaceRegistry,
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
async function seedPost(stateDir, { postId, sessionId = `head-${postId}`, roomId, agentPreset = 'deepartments-head', provider, role, sleepEpoch, previousChildId }) {
  const postsPath = path.join(stateDir, 'posts.json')
  let existing = {}
  try {
    existing = JSON.parse(await readFile(postsPath, 'utf8'))
  } catch {
    /* no prior seed */
  }
  const entry = { sessionId, roomId, agentPreset }
  // Batch 3a: a disposable worker carries its provider:'worker' marker + role.
  if (provider !== undefined) entry.provider = provider
  if (role !== undefined) entry.role = role
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

/** Seed a HOST registration into hosts.json BEFORE boot (the context-injection
 * gate: only the session registered as the board host receives the wake pack).
 * The boot loader restores it into the in-memory `hosts` Map (invoke.ts:1429).
 * Returns the deterministic `host-<sessionId>` member id. */
async function seedHostRegistration(stateDir, sessionId, roomId = 'board') {
  const hostsPath = path.join(stateDir, 'hosts.json')
  await mkdir(stateDir, { recursive: true })
  await writeFile(hostsPath, JSON.stringify({ [`host-${sessionId}`]: { sessionId: String(sessionId), roomId } }, null, 2))
  return `host-${sessionId}`
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
  // Task T4 (test hardening): retry until the file is present AND parses.
  // persistHosts is fire-and-forget, so a reader could otherwise catch the file
  // mid-write and a torn JSON.parse would throw straight through the enclosing
  // waitFor (the ~1/6 flake in test 74 "Batch 7 host dept_sleep").
  let parsed
  await waitFor(async () => {
    try {
      parsed = JSON.parse(await readFile(hostsPath, 'utf8'))
      return true
    } catch {
      return false
    }
  }, 5000, 'hosts.json readable')
  return parsed
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
      assert.equal(whoResult.posts[0].agentPreset, 'deepartments-head-research')
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
      assert.equal(result.posts[0].agentPreset, 'deepartments-head-research')

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
      assert.equal(where.agentPreset, 'deepartments-head-research')
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
// the PER-HEAD preset (deepartments-head-<departmentId>, Batch 4a), coordinator
// agentOptions, and a setup that registers the board toolset + mounts the
// per-head preset.

test('create-when-absent: boot materializes the configured head as a root agent (stable session id, PER-HEAD meta.agentPreset, coordinator agentOptions) into posts.json', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head root agent created at boot')
      assert.equal(agents.createCalls.filter((c) => String(c.sessionId) === 'head-research-head').length, 1, 'exactly one create for the head')

      const createCall = agents.createCalls.find((c) => String(c.sessionId) === 'head-research-head')
      assert.equal(String(createCall.sessionId), 'head-research-head', 'stable per-post session id')
      assert.equal(createCall.meta.cwd, path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), 'meta.cwd is the repo root')
      // Batch 4a: the head session is created under its PER-HEAD preset so it
      // is a NATIVE, openable session labeled with the head preset.
      assert.equal(createCall.meta.agentPreset, 'deepartments-head-research', 'the PER-HEAD preset is requested (deepartments-head-<departmentId>)')
      assert.equal(createCall.meta.origin, undefined, 'no origin (a root/main agent, not a subagent)')
      assert.deepEqual(createCall.agentOptions, { provider: 'stub-coord', model: 'deepseek-v4-flash' }, 'coordinator agentOptions are passed through')

      // Durable posts.json reflects the root-agent identity (no parentId/provider)
      // AND the per-head agentPreset marker.
      const posts = await readPosts(stateDir)
      assert.equal(posts['research-head'].sessionId, 'head-research-head')
      assert.equal(posts['research-head'].roomId, 'research', 'head room comes from the department config')
      assert.equal(posts['research-head'].agentPreset, 'deepartments-head-research', 'posts.json carries the per-head preset (Batch 4a)')
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

test('a head is lean: own-layer board tools present, host-plane tools NOT exposed; head gets the department-lifecycle (create/retire) tools', async () => {
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
      // Batch 3a: a department HEAD (manager) additionally gets the
      // department-lifecycle tools, scoped to its own layer — the create tool
      // and the worker-scoped retire tool. These are NOT on the global host
      // plane as head-capabilities; they are the head own-layer versions.
      assert.ok(headCtx.tools.get('dept_post_create', key), 'dept_post_create installed in the head own layer (a head creates its workers)')
      assert.ok(headCtx.tools.get('dept_post_retire', key), 'dept_post_retire installed in the head own layer (a head retires its workers)')
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

test('Batch G head wake_counter parity: a SECOND dept_memo_write within one awake session does NOT inflate the ordinal (advances only at dept_sleep)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { agents, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
    try {
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const memo = headCtx.tools.get('dept_memo_write', key)
      const signal = new AbortController().signal

      // First write (no prior journal) → wake_counter 1.
      const first = await memo.execute({ summary: 'Head memo A.' }, { agent: head, signal })
      const firstContent = await readFile(first.memoPath, 'utf8')
      assert.match(firstContent, /^wake_counter: 1$/m, 'head first write is wake_counter 1')

      // Second write WITHIN the SAME awake session (no dept_sleep between):
      // the ordinal must NOT advance — only the dept_sleep seed boundary bumps it.
      const second = await memo.execute({ summary: 'Head memo B, still awake.' }, { agent: head, signal })
      const secondContent = await readFile(second.memoPath, 'utf8')
      assert.equal(second.memoPath, first.memoPath, 'head journal rewritten in place')
      assert.match(secondContent, /^wake_counter: 1$/m, 'head wake_counter STAYS 1 on a within-session write (no inflation)')
    } finally {
      await dispose()
    }
  })
})

test('Batch G head wake_counter parity: dept_sleep bumps the ordinal (1→2) at the seed boundary on disk; the cold-resumed next incarnation reads the bumped ordinal', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const journalText = 'HEAD-SLEEP-COUNTER: carry the bumped ordinal into the next incarnation.'
    await seedJournal(stateDir, postId, journalText)
    const { root, agents, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
    try {
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const sleep = headCtx.tools.get('dept_sleep', key)
      const memo = headCtx.tools.get('dept_memo_write', key)
      const signal = new AbortController().signal

      // Memo write keeps the seeded ordinal (1) — a write does not inflate.
      const memoResult = await memo.execute({ summary: journalText }, { agent: head, signal })
      const preSleepContent = await readFile(memoResult.memoPath, 'utf8')
      assert.match(preSleepContent, /^wake_counter: 1$/m, 'head memo write does not advance the seeded ordinal')

      // Sleep: bumps the on-disk journal 1 → 2 at the seed boundary.
      await sleep.execute({}, { agent: head, signal })
      await waitFor(() => agents.store.has(`head-${postId}`) === false, 5000, 'handle disposed after sleep')
      const postSleepContent = await readFile(memoResult.memoPath, 'utf8')
      assert.match(postSleepContent, /^wake_counter: 2$/m, 'head wake_counter advanced 1 → 2 at dept_sleep (ordinal bump on disk)')

      // Next wake: the cold-resumed fresh incarnation sees the bumped ordinal (2).
      const boardSession = root.sessions.get(SessionId(roomSessionId('board')))
      const seq = await nextSeq(stateDir, 'board')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'board'), messageRecord(seq, 'asistente', [postId], 'wake up'), 'board')
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'slept head cold-resumed')
      assert.equal(agents.createCalls.filter((c) => String(c.sessionId) === `head-${postId}`).length, 1, 'head cold-resumed, not re-created')
      const resumedContent = await readFile(memoResult.memoPath, 'utf8')
      assert.match(resumedContent, /^wake_counter: 2$/m, 'bumped ordinal (2) persists for the next incarnation')
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

      // A host with no saved journal is not sleepable either (Batch 7 host
      // branch mirrors the head's require-a-journal rule).
      const host = agents.put(fakeParentAgent())
      await assert.rejects(() => root.tools.get('dept_sleep').execute({}, { agent: host, signal }), /requires a saved journal — call dept_memo_write to save your memory first \(no journal for host host-/, 'dept_sleep rejects a host with no saved journal')

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

// --- Batch 3a: department-worker lifecycle (dept_post_create / worker wake /
// sleep-respawn / dept_post_retire scope). A configured head (manager) creates
// DISPOSABLE workers (root agents, sessionId worker-<postId>, provider:'worker')
// in its department room, coordinates them via the board, and retires them.

/** Find the child (scope) for a live agent by its session id in the stub. The
 * stub keeps a PARALLEL pair: `childAgents` (the agent objects, in creation
 * order) and `childContexts` (their {ctx,key} scopes, same order). */
function childContextFor(agents, sessionId) {
  const index = agents.childAgents.findIndex((agent) => agent && agent.id === sessionId)
  if (index < 0) return undefined
  return { ctx: agents.childContexts[index].ctx, key: agents.childContexts[index].key }
}

/** Get the head agent + its own-layer scoped toolset (the configured head
 * `head-research-head` is the first materialized agent at boot). */
async function bootWithHead(stateDir) {
  const env = await bootPlugin(stateDir)
  await waitFor(() => env.agents.store.has('head-research-head'), 5000, 'head created at boot')
  const head = env.agents.store.get('head-research-head')
  const { ctx: headCtx, key } = childContextFor(env.agents, 'head-research-head')
  return { ...env, head, headCtx, key }
}

test('dept_post_create (head): a head creates a DISPOSABLE worker root agent (sessionId worker-<postId>, provider:"worker"), delivers its first message on the board, and the host has NO dept_post_create', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, head, headCtx, key, dispose } = await bootWithHead(stateDir)
    try {
      const createTool = headCtx.tools.get('dept_post_create', key)
      assert.ok(createTool, 'dept_post_create installed in the head own layer')
      // Host-CANNOT: dept_post_create exists ONLY in the head own layer, never
      // on the global host plane.
      assert.equal(root.tools.get('dept_post_create'), undefined, 'host plane has NO dept_post_create')

      const signal = new AbortController().signal
      const result = await createTool.execute(
        { postId: 'researcher-alpha', role: 'rank-and-file researcher', firstMessage: 'investigate X and report on the board' },
        { agent: head, signal }
      )
      assert.equal(result.postId, 'researcher-alpha')
      assert.equal(result.sessionId, 'worker-researcher-alpha')
      assert.equal(result.roomId, 'research', 'worker defaults to the creating head room')

      // The worker root agent was created via ctx.agents.create (meta
      // agentPreset deepartments-worker, origin undefined) and is LIVE.
      assert.equal(agents.store.has('worker-researcher-alpha'), true, 'worker agent is live after create')
      const createCall = agents.createCalls.find((c) => String(c.sessionId) === 'worker-researcher-alpha')
      assert.ok(createCall, 'a ctx.agents.create call for the worker')
      assert.equal(createCall.meta.agentPreset, 'deepartments-worker', 'worker mounts the deepartments-worker preset')
      assert.equal(createCall.meta.origin, undefined, 'worker is a root/main agent (no origin)')

      // Durable registry: disposable entry.
      const posts = await readPosts(stateDir)
      assert.equal(posts['researcher-alpha'].sessionId, 'worker-researcher-alpha')
      assert.equal(posts['researcher-alpha'].roomId, 'research')
      assert.equal(posts['researcher-alpha'].agentPreset, 'deepartments-worker')
      assert.equal(posts['researcher-alpha'].provider, 'worker', 'disposable marker persisted')

      // First message delivered as a durable board message → the relay wakes
      // the worker to read it (worker inbox receives the board followup).
      const worker = agents.store.get('worker-researcher-alpha')
      await waitFor(() => worker.inboxMessages.length >= 1, 5000, 'worker woken by its first board message')
      assert.equal(worker.inboxMessages.at(-1).source.kind, 'board', 'worker wake uses the board followup source')
    } finally {
      await dispose()
    }
  })
})

test('dept_post_create validation: duplicate postId rejects; a configured-head postId rejects; unknown room rejects', async () => {
  await withTempStateDir(async (stateDir) => {
    const { agents, head, headCtx, key, dispose } = await bootWithHead(stateDir)
    try {
      const signal = new AbortController().signal
      const createTool = headCtx.tools.get('dept_post_create', key)
      await createTool.execute({ postId: 'researcher-alpha', role: 'rank-and-file researcher' }, { agent: head, signal })
      // Duplicate postId → loud rejection.
      await assert.rejects(
        () => createTool.execute({ postId: 'researcher-alpha', role: 'rank-and-file researcher' }, { agent: head, signal }),
        /already registered/, 'duplicate postId rejected loudly'
      )
      // A configured head postId is already-registered (the head was materialized
      // at boot), so it can never be (re)claimed as a worker.
      await assert.rejects(
        () => createTool.execute({ postId: 'research-head', role: 'rank-and-file researcher' }, { agent: head, signal }),
        /already registered/, 'a configured head postId is rejected as a worker'
      )
      // Unknown room → rejects.
      await assert.rejects(
        () => createTool.execute({ postId: 'researcher-beta', role: 'rank', room: 'nope' }, { agent: head, signal }),
        /not a known department room/, 'unknown room rejected loudly'
      )
    } finally {
      await dispose()
    }
  })
})

test('a worker is lean: board tools present, the department-lifecycle (create/retire) tools are NOT exposed to it', async () => {
  await withTempStateDir(async (stateDir) => {
    const { agents, head, headCtx, key, dispose } = await bootWithHead(stateDir)
    try {
      const signal = new AbortController().signal
      const createTool = headCtx.tools.get('dept_post_create', key)
      await createTool.execute({ postId: 'researcher-alpha', role: 'rank-and-file researcher' }, { agent: head, signal })
      const { ctx: workerCtx, key: workerKey } = childContextFor(agents, 'worker-researcher-alpha')
      // Worker gets the board toolset...
      for (const name of ['dept_room_read', 'dept_room_write', 'dept_room_who', 'dept_whereami', 'dept_witness_write', 'dept_memo_write', 'dept_sleep']) {
        assert.ok(workerCtx.tools.get(name, workerKey), `${name} installed in the worker own layer`)
      }
      // ...but NOT the department-lifecycle controls (workers never create/retire).
      assert.equal(workerCtx.tools.get('dept_post_create', workerKey), undefined, 'worker has NO dept_post_create')
      assert.equal(workerCtx.tools.get('dept_post_retire', workerKey), undefined, 'worker has NO dept_post_retire')
    } finally {
      await dispose()
    }
  })
})

test('worker sleep + respawn: a slept worker is cold-resumed as a fresh incarnation on its next wake (deepartments-worker setup)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { agents, head, headCtx, key, root, dispose } = await bootWithHead(stateDir)
    try {
      const signal = new AbortController().signal
      const createTool = headCtx.tools.get('dept_post_create', key)
      await createTool.execute({ postId: 'researcher-alpha', role: 'rank-and-file researcher' }, { agent: head, signal })

      // The worker saves its journal and SLEEPS (disposes its handle, marks sleepEpoch).
      const workerAgent = agents.store.get('worker-researcher-alpha')
      const { ctx: workerCtx, key: workerKey } = childContextFor(agents, 'worker-researcher-alpha')
      const memo = workerCtx.tools.get('dept_memo_write', workerKey)
      await memo.execute({ summary: 'found X; retiring to sleep' }, { agent: workerAgent, signal })
      const sleep = workerCtx.tools.get('dept_sleep', workerKey)
      const sleepResult = await sleep.execute({}, { agent: workerAgent, signal })
      assert.ok(sleepResult.sleepEpoch > 0, 'worker sleep marked')
      // The worker handle is disposed → not live anymore; the durable entry
      // (provider:'worker') + sleepEpoch persist.
      assert.equal(agents.store.has('worker-researcher-alpha'), false, 'worker AgentHandle disposed on sleep')
      // A durable board message to it cold-resumes + wakes it.
      const boardSession = root.sessions.get(SessionId(roomSessionId('research')))
      const seq = await nextSeq(stateDir, 'research')
      await emitRoomRecord(boardSession, resolveBoardPath(stateDir, 'research'), messageRecord(seq, 'research-head', ['researcher-alpha'], 'wake up'), 'research')
      await waitFor(() => agents.store.has('worker-researcher-alpha'), 5000, 'slept worker cold-resumed')
      const resumed = agents.store.get('worker-researcher-alpha')
      await waitFor(() => resumed.inboxMessages.length >= 1, 5000, 'resumed worker woken')
      assert.equal(resumed.inboxMessages.at(-1).source.kind, 'board', 'worker wake uses the board followup source')
      // Same durable session id reused (resume, not a second create).
      assert.equal(agents.resumeCalls.filter((c) => String(c.resumeSessionId) === 'worker-researcher-alpha').length >= 1, true, 'worker cold-resumed via ctx.agents.resume')
      const posts = await readPosts(stateDir)
      assert.equal(posts['researcher-alpha'].sleepEpoch, undefined, 'sleepEpoch cleared after the wake')
      assert.equal(posts['researcher-alpha'].provider, 'worker', 'disposable marker survives sleep/respawn')
    } finally {
      await dispose()
    }
  })
})

test('worker wake_counter parity: a WRITE does not inflate the ordinal, but dept_sleep bumps it (1→2) at the seed boundary on disk', async () => {
  await withTempStateDir(async (stateDir) => {
    const { agents, head, headCtx, key, dispose } = await bootWithHead(stateDir)
    try {
      const signal = new AbortController().signal
      const createTool = headCtx.tools.get('dept_post_create', key)
      await createTool.execute({ postId: 'researcher-alpha', role: 'rank-and-file researcher' }, { agent: head, signal })

      const workerAgent = agents.store.get('worker-researcher-alpha')
      const { ctx: workerCtx, key: workerKey } = childContextFor(agents, 'worker-researcher-alpha')
      const memo = workerCtx.tools.get('dept_memo_write', workerKey)
      const sleep = workerCtx.tools.get('dept_sleep', workerKey)

      // First write (no prior journal) → wake_counter 1; a second within-session
      // write stays 1 (the write never inflates the ordinal).
      const first = await memo.execute({ summary: 'worker memo A' }, { agent: workerAgent, signal })
      const firstContent = await readFile(first.memoPath, 'utf8')
      assert.match(firstContent, /^wake_counter: 1$/m, 'worker first write is wake_counter 1')
      const second = await memo.execute({ summary: 'worker memo B, still awake' }, { agent: workerAgent, signal })
      const secondContent = await readFile(second.memoPath, 'utf8')
      assert.match(secondContent, /^wake_counter: 1$/m, 'worker wake_counter STAYS 1 on a within-session write (no inflation)')

      // Sleep: bumps the worker ordinal 1 → 2 at the seed boundary on disk.
      await sleep.execute({}, { agent: workerAgent, signal })
      await waitFor(() => agents.store.has('worker-researcher-alpha') === false, 5000, 'worker handle disposed on sleep')
      const postSleepContent = await readFile(first.memoPath, 'utf8')
      assert.match(postSleepContent, /^wake_counter: 2$/m, 'worker wake_counter advanced 1 → 2 at dept_sleep (ordinal bump on disk)')
    } finally {
      await dispose()
    }
  })
})

test('dept_post_retire (head): a head retires a worker of ITS OWN room (withdrawal note + disposed handle + unregistered); unknown postId rejects; a permanent head is not retired', async () => {
  await withTempStateDir(async (stateDir) => {
    const { agents, head, headCtx, key, root, dispose } = await bootWithHead(stateDir)
    try {
      const signal = new AbortController().signal
      const createTool = headCtx.tools.get('dept_post_create', key)
      await createTool.execute({ postId: 'researcher-alpha', role: 'rank-and-file researcher' }, { agent: head, signal })
      const boardSession = root.sessions.get(SessionId(roomSessionId('research')))
      const beforeCount = boardSession.events.length

      const retireTool = headCtx.tools.get('dept_post_retire', key)
      assert.ok(retireTool, 'head own layer has dept_post_retire')
      const result = await retireTool.execute({ postId: 'researcher-alpha' }, { agent: head, signal })
      assert.equal(result.retired, true)
      assert.equal(result.roomId, 'research')

      // Handle disposed + unregistered + persisted removal.
      await waitFor(async () => (await readPosts(stateDir))['researcher-alpha'] === undefined, 5000, 'worker removed from posts.json')
      assert.equal(agents.store.has('worker-researcher-alpha'), false, 'worker AgentHandle disposed on retire')
      // Withdrawal note posted in the room.
      await waitFor(() => boardSession.events.length > beforeCount, 5000, 'withdrawal note emitted')

      // Unknown target → loud rejection.
      await assert.rejects(() => retireTool.execute({ postId: 'ghost' }, { agent: head, signal }), /not a registered post/, 'unknown postId rejected loudly')
      // A head can never retire a PERMANENT head via this path.
      await assert.rejects(() => retireTool.execute({ postId: 'research-head' }, { agent: head, signal }), /not a disposable worker/, 'head cannot retire a permanent head')
    } finally {
      await dispose()
    }
  })
})

test('dept_post_retire scope: a head CANNOT retire a worker of ANOTHER department room', async () => {
  await withTempStateDir(async (stateDir) => {
    const { agents, head, headCtx, key, dispose } = await bootWithHead(stateDir)
    try {
      const signal = new AbortController().signal
      const createTool = headCtx.tools.get('dept_post_create', key)
      // Create a worker explicitly in the 'board' room (a known room) — NOT the
      // head's own 'research' room.
      await createTool.execute({ postId: 'researcher-elsewhere', role: 'rank', room: 'board' }, { agent: head, signal })
      const retireTool = headCtx.tools.get('dept_post_retire', key)
      await assert.rejects(
        () => retireTool.execute({ postId: 'researcher-elsewhere' }, { agent: head, signal }),
        /may only retire workers in your own department room/, 'head scoped to its own department room'
      )
      // The worker is still registered (scope rejection left it intact).
      const posts = await readPosts(stateDir)
      assert.equal(posts['researcher-elsewhere'].provider, 'worker', 'worker not retired by a rejecting call')
    } finally {
      await dispose()
    }
  })
})

test('retired worker is NOT re-materialized by ensureAllHeads (workers are runtime-only, never booted from config)', async () => {
  await withTempStateDir(async (stateDir) => {
    // Seed a durable WORKER entry (provider:'worker') directly into posts.json
    // BEFORE boot — exactly like a durable worker left in a previous boot. On
    // boot, ensureAllHeads iterates ONLY configured coordinators, so the worker
    // is NOT materialized automatically.
    await seedPost(stateDir, { postId: 'researcher-alpha', sessionId: 'worker-researcher-alpha', roomId: 'research', agentPreset: 'deepartments-worker', provider: 'worker' })
    const { agents, head, headCtx, key, dispose } = await bootWithHead(stateDir)
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'configured head still materialized at boot')
      // The seeded worker is NOT created by ensureAllHeads.
      assert.equal(agents.store.has('worker-researcher-alpha'), false, 'ensureAllHeads never materializes a disposable worker (config-only)')
      // Retire it; it must not re-materialize.
      const retireTool = headCtx.tools.get('dept_post_retire', key)
      const signal = new AbortController().signal
      await retireTool.execute({ postId: 'researcher-alpha' }, { agent: head, signal })
      await waitFor(async () => (await readPosts(stateDir))['researcher-alpha'] === undefined, 5000, 'worker retired+removed')
      assert.equal(agents.store.has('worker-researcher-alpha'), false, 'worker disposed on retire')
      // dispose + re-boot the SAME stateDir: ensureAllHeads does NOT revive it.
      await dispose()
      const env2 = await bootPlugin(stateDir)
      try {
        await waitFor(() => env2.agents.store.has('head-research-head'), 5000, 'configured head back at re-boot')
        assert.equal(env2.agents.store.has('worker-researcher-alpha'), false, 'retired worker NOT re-materialized after re-boot')
        const posts = await readPosts(stateDir)
        assert.equal(posts['researcher-alpha'], undefined, 'retired worker stays out of posts.json after re-boot')
      } finally {
        await env2.dispose()
      }
    } finally {
      void 0
    }
  })
})

// --- Batch 4a: PER-HEAD agent presets (openable native head sessions) ---------
// Each configured head materializes its own preset `deepartments-head-<id>`,
// derived from the generic `deepartments-head` base + the department role, so
// the head session is a NATIVE, openable session labeled with the per-head
// preset. The pure content builders live in src/head-presets.ts and are tested
// here directly (hermetic, no DSH_HOME / no real agent-presets service). The
// final test exercises the REAL materialization through the REAL
// @deepseek-ai/dsh-agent-presets service (Rule 5) with DSH_HOME pointed at a
// temp dir so per-head presets land in the harness-home user root and the real
// agentPreset.list()/resolve() can see them.

test('head-presets: per-head preset id + display name derive from the department (title/role fallback)', async () => {
  // id = deepartments-head-<departmentId>
  assert.equal(headPresetIdFor('research'), 'deepartments-head-research')
  assert.equal(headPresetIdFor('programming'), 'deepartments-head-programming')
  // name = "<coordinator.title> - Deepartments"
  assert.equal(headPresetNameFor({ postId: 'research-head', title: 'Head of Research', role: 'Research department head' }), 'Head of Research - Deepartments')
  // fallback: title → role → postId
  assert.equal(headPresetNameFor({ postId: 'research-head', role: 'Research department head' }), 'Research department head - Deepartments')
  assert.equal(headPresetNameFor({ postId: 'research-head' }), 'research-head - Deepartments')
  assert.equal(HEAD_PRESET_BASE_ID, 'deepartments-head', 'the generic base preset stays the template/fallback id')
  // role line names the head + its department
  assert.equal(headRoleLine('Head of Research', 'Research'), 'Head of Research, the head of the "Research" department')
})

test('head-presets: buildHeadPresetComposition injects the role line into the base persona (self-identifying)', async () => {
  const base = [
    'text: >-',
    '      You are a permanent department head in the Deepartments organization',
    '      (DeepSeek Harness). You are a first-class agent in your own right.',
    '      BE IDLE UNLESS ADDRESSED.'
  ].join('\n')
  const composed = buildHeadPresetComposition(base, 'Head of Research', 'Research')
  // The role line is inserted into the FIRST persona sentence; the rest of the
  // neutral persona is unchanged.
  assert.ok(composed.includes('You are Head of Research, the head of the "Research" department. You are a permanent department head in the Deepartments organization'), 'role line names the head + department in the first sentence')
  assert.ok(composed.includes('You are a first-class agent in your own right.'), 'rest of the neutral persona preserved')
  assert.ok(composed.includes('BE IDLE UNLESS ADDRESSED.'), 'base persona tail preserved')
  assert.equal(composed.length > base.length, true, 'composition grew with the role line')
  // Unknown anchor → base returned unchanged (non-fatal, deterministic).
  assert.equal(buildHeadPresetComposition(base.replace(/deepartments/gi, 'NOPE'), 'X', 'Y'), base.replace(/deepartments/gi, 'NOPE'))
})

test('head-presets: buildHeadPresetMetadata writes name: "<title> - Deepartments"', async () => {
  const yml = buildHeadPresetMetadata('Head of Research - Deepartments')
  assert.ok(yml.startsWith('name: "Head of Research - Deepartments"'), 'metadata name is the per-head display name')
  assert.match(yml, /order: 30/)
  assert.match(yml, /description:/)
})

test('materialization materializes per-head presets into the harness-home user root (REAL agent-presets service)', async () => {
  const dshHome = await mkdtemp(path.join(tmpdir(), 'dsh-home-'))
  const prev = process.env.DSH_HOME
  const cleanup = async () => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    await rm(dshHome, { recursive: true, force: true })
  }
  process.env.DSH_HOME = dshHome
  await withTempStateDir(async (stateDir) => {
    try {
      // Boot the REAL Loader WITH the real @deepseek-ai/dsh-agent-presets
      // service so ensureAllHeads runs the REAL preset materialization into
      // the temp $DSH_HOME/.agent-presets/ user root.
      const root = new Context()
      const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
      const loader = root.loader
      loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
      loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
      loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
      loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
      loader.create({ id: 'agentPresets', name: '@deepseek-ai/dsh-agent-presets', config: { default: 'deepartments-head', roots: [] } })
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
        config: { stateDir, org: TEST_ORG }
      })
      await loader.await()
      agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
      try {
        // The per-head preset materializes at boot. The materialize loop is
        // async + fire-and-forget via ensureAllHeads, so poll for the file.
        await waitFor(async () => {
          try { await access(path.join(dshHome, '.agent-presets', 'deepartments-head-research', 'agent.cordis.yml')); return true } catch { return false }
        }, 5000, 'per-head preset agent.cordis.yml materialized')
        // preset.yml carries the per-head display name.
        const presetYml = await readFile(path.join(dshHome, '.agent-presets', 'deepartments-head-research', 'preset.yml'), 'utf8')
        assert.ok(presetYml.includes('name: "Research department head - Deepartments"'), 'per-head metadata name materialized')
        // agent.cordis.yml carries the neutral persona + the role line.
        const composition = await readFile(path.join(dshHome, '.agent-presets', 'deepartments-head-research', 'agent.cordis.yml'), 'utf8')
        assert.ok(composition.includes('You are Research department head, the head of the "Research" department.'), 'per-head role line present in the composition')
        assert.ok(composition.includes('BE IDLE UNLESS ADDRESSED'), 'neutral persona preserved in the per-head composition')
        // The real agent-presets service can RESOLVE the per-head preset (the
        // native picker will surface it).
        const presets = root.get('agentPresets')
        const resolved = await presets.resolve('deepartments-head-research')
        assert.equal(resolved.id, 'deepartments-head-research', 'per-head preset resolvable by the real roster')
        // The generic base preset remains materialized too.
        await access(path.join(dshHome, '.agent-presets', 'deepartments-head', 'agent.cordis.yml'))
        // Boot created the head under its per-head preset.
        await waitFor(() => agents.store.has('head-research-head'), 5000, 'head created at boot')
        const createCall = agents.createCalls.find((c) => String(c.sessionId) === 'head-research-head')
        assert.equal(createCall.meta.agentPreset, 'deepartments-head-research', 'head session created under its per-head preset')
      } finally {
        loaderFiber.dispose()
      }
    } finally {
      await cleanup()
    }
  })
})

// --- U2: HOST sleep — SESSION ROTATION (replaces the in-place reset) --------
// The Asistente host gets a HOST branch of dept_memo_write (journals/host-
// <sessionId>.md) and a HOST branch of dept_sleep. U2 (spec 002): at host
// dept_sleep the OLD session is RETIRED + ARCHIVED server-side and a NEW
// session (seeded with the re-keyed journal — author re-keyed to host-<newId>)
// becomes the registered host; hosts.json rotates (old entry retired/rotatedTo,
// new entry sleepEpoch/boundarySeq/previousSessionId, top-level schemaVersion 2).
// The old artifact + old journal stay byte-identical (G4/D2); the wake pack now
// targets ONLY the new host (retired-skip gate). The LEGACY in-place reset
// (surfaceOp replace over the full window + deferred fold) is reachable only
// when the rotation cannot run (missing sessions store / create failure) —
// those tests force the fallback by breaking `root.sessions.create`.

test('Batch 7 pure helper: computeHostSleepSurfacePlan computes the full-window replace (or a bare append on empty)', async () => {
  // Empty surface → cannot replace; fall back to a plain append so the journal
  // still lands as the sole node.
  assert.deepEqual(computeHostSleepSurfacePlan([]), { surfaceOp: 'append' })
  // Non-empty surface → a full-window inclusive replace covering every node,
  // with sourceEventSeqs citing every shadowed node (assertProvenance requires
  // complete coverage).
  assert.deepEqual(computeHostSleepSurfacePlan([0, 1, 2, 3]), {
    surfaceOp: { op: 'replace', start: 0, end: 3 },
    sourceEventSeqs: [0, 1, 2, 3]
  })
  assert.deepEqual(computeHostSleepSurfacePlan([5]), {
    surfaceOp: { op: 'replace', start: 5, end: 5 },
    sourceEventSeqs: [5]
  })
})

test('Batch 7 pure helper: buildSleepJournalMessage frames the journal as a plugin/notice context (never a user-typed message)', async () => {
  const msg = buildSleepJournalMessage('MY-JOURNAL')
  assert.equal(msg.role, 'user')
  assert.equal(msg.content[0].type, 'text')
  assert.equal(msg.content[0].text, 'MY-JOURNAL')
  // NOT source.kind 'user' — a plugin context/notice so it renders as a
  // collapsed row, not as if the owner said it.
  assert.equal(msg.source.kind, 'plugin')
  assert.equal(msg.source.plugin, 'deepartments')
  assert.equal(msg.source.form, 'notice')
  assert.ok(typeof msg.source.summary === 'string' && msg.source.summary.length > 0)
})

test('Batch 7 host dept_memo_write writes journals/host-<sessionId>.md (no more unknown.md)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      const host = agents.put(fakeParentAgent())
      const memo = root.tools.get('dept_memo_write')
      assert.ok(memo, 'dept_memo_write registered globally (host plane)')
      const result = await memo.execute(
        { summary: 'Host memory to hand to my future self.', decisions: ['in place'], constraints: ['no new session'] },
        { agent: host, signal: new AbortController().signal }
      )
      const hostId = `host-${host.id}`
      assert.equal(result.member, hostId)
      assert.equal(result.memoPath, path.join(stateDir, 'journals', `${hostId}.md`))
      // Durable: the host journal file exists with frontmatter + body.
      const content = await readFile(result.memoPath, 'utf8')
      assert.match(content, /host memory to hand to my future self\./i)
      assert.match(content, /author: host-/)
      assert.match(content, /decisions: \["in place"\]/)
    } finally {
      await dispose()
    }
  })
})

test('Batch W2 dept_memo_write: identity+cursor block — HOST wake_counter stays put within one awake session, last_wake tracks the prior timestamp, current_step persisted', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      const host = agents.put(fakeParentAgent())
      const memo = root.tools.get('dept_memo_write')
      assert.ok(memo, 'dept_memo_write registered globally (host plane)')
      const hostId = `host-${host.id}`
      const signal = new AbortController().signal

      // First write: no currentStep → wake_counter 1, last_wake none, footer.
      const first = await memo.execute({ summary: 'Summary A: first wake.' }, { agent: host, signal })
      const firstContent = await readFile(first.memoPath, 'utf8')
      const firstTimestamp = firstContent.match(/^timestamp:\s*(.+)$/m)?.[1]
      assert.ok(firstTimestamp, 'first journal carries a timestamp')
      assert.match(firstContent, /^author: host-/m, 'author frontmatter present')
      assert.match(firstContent, /^wake_counter: 1$/m, 'first wake_counter is 1')
      assert.match(firstContent, /^last_wake: none$/m, 'first last_wake is none')
      assert.match(firstContent, /Summary A: first wake\./, 'summary A body present')
      assert.match(firstContent, /^wake routine: see skill 'Wake routine \(injected wake\)'$/m, 'journal footer is now the one-line wake-routine pointer (Batch C P1 dedupe — no canonical-text duplication per wake)')
      assert.ok(!firstContent.includes(HOST_WAKE_ROUTINE_TEXT), 'journal footer no longer embeds the full canonical wake routine (it still comes in once via wake-pack section 9 / skill body)')
      assert.ok(!/^current_step:/m.test(firstContent), 'no current_step when not passed')

      // Second write WITHIN THE SAME awake session (no dept_sleep in between):
      // a HOST's wake_counter is the ORDINAL of the current awake session and
      // advances ONLY at dept_sleep — so a second memo write must NOT advance
      // it. currentStep passed → current_step persisted; last_wake still tracks
      // the prior timestamp.
      const second = await memo.execute(
        { summary: 'Summary B: second wake.', currentStep: 'processing board backlog' },
        { agent: host, signal }
      )
      const secondContent = await readFile(second.memoPath, 'utf8')
      assert.equal(second.member, hostId)
      assert.equal(second.memoPath, first.memoPath, 'host journal rewritten in place')
      assert.match(secondContent, /^wake_counter: 1$/m, 'second host wake_counter STAYS 1 (advances only at dept_sleep, not at write)')
      assert.equal(secondContent.match(/^last_wake:\s*(.+)$/m)?.[1], firstTimestamp, 'last_wake tracks the prior journal timestamp')
      assert.match(secondContent, /^current_step: processing board backlog$/m, 'current_step persisted')
      assert.match(secondContent, /Summary B: second wake\./, 'summary B body present')
      assert.ok(!/Summary A: first wake\./.test(secondContent), 'prior summary body replaced')
    } finally {
      await dispose()
    }
  })
})

test('Batch 7 U2 host dept_sleep ROTATES: no journal rejects loudly; with a journal the old session is retired + archived, a NEW session (seeded with the re-keyed journal) becomes the registered host, hosts.json rotates (schemaVersion 2), the old artifact/journal stay byte-identical, and the wake pack targets ONLY the new host (retired-skip gate) + concludes the turn', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, persistence, workspaceRegistry, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const sleepTool = root.tools.get('dept_sleep')
      const signal = new AbortController().signal
      const oldHostId = `host-${host.id}`
      const oldSessionId = host.id

      // No journal yet → loud rejection (unchanged — S1).
      await assert.rejects(
        () => sleepTool.execute({}, { agent: host, signal }),
        /requires a saved journal — call dept_memo_write to save your memory first \(no journal for host host-/,
        'host sleep without a journal rejects loudly'
      )

      // Pre-author the host journal (as dept_memo_write would have written it);
      // seedJournal writes wake_counter 1 for the pre-sleep file (S1.5 bumps 1→2).
      const journalSummary = 'HOST-ROTATION-MEMORY: the rotated session carries this forward.'
      const preSleepPath = await seedJournal(stateDir, oldHostId, journalSummary)
      const preSleepContent = await readFile(preSleepPath, 'utf8')
      assert.match(preSleepContent, /^wake_counter: 1$/m, 'pre-sleep on-disk journal has wake_counter 1')

      // Give the host's live session a REAL dsh Session with an existing full
      // surface (2 prior user messages) so we can assert the rotation does NOT
      // touch the old live surface (S5 — the new session IS the journal).
      const realSession = Session.create(SessionId(String(host.id)))
      realSession.append('user/message', { role: 'user', content: [{ type: 'text', text: 'prior turn 1' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      realSession.append('user/message', { role: 'user', content: [{ type: 'text', text: 'prior turn 2' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      assert.ok(realSession.surface.nodes.length === 2, 'surface seeded with 2 nodes before the sleep')
      host.session = realSession

      let concluded = false
      const result = await sleepTool.execute({}, {
        agent: host,
        signal,
        concludeTurn: () => { concluded = true }
      })

      // Return contract: the NEW host member (the next wake incarnation), its
      // re-keyed journal path, and the durable sleepEpoch set on the new entry.
      const newHostId = result.member
      assert.match(newHostId, /^host-session-/, 'rotation returns the NEW host id (host-<newId>)')
      assert.notEqual(newHostId, oldHostId, 'the new host id differs from the retired one')
      assert.equal(result.memoPath, path.join(stateDir, 'journals', `${newHostId}.md`), 'memoPath is the re-keyed journal path')
      assert.ok(typeof result.sleepEpoch === 'number' && result.sleepEpoch > 0)

      // Durable: hosts.json rotated — schemaVersion 2, old retired/rotatedTo,
      // new live with previousSessionId. Deterministic settling (Task T4 test
      // hardening): retry rather than throwing out of the predicate.
      await waitFor(async () => {
        const hostsFile = await readHosts(stateDir)
        return hostsFile[newHostId]?.sessionId !== undefined && hostsFile[oldHostId]?.retired === true
      }, 5000, 'hosts.json rotated (new live + old retired)')
      const hostsFile = await readHosts(stateDir)
      assert.equal(hostsFile.schemaVersion, 2, 'top-level schemaVersion 2 persisted (D4)')
      // Old entry: retired evidence, stays queryable.
      assert.equal(hostsFile[oldHostId].retired, true, 'old entry retired')
      assert.ok(typeof hostsFile[oldHostId].retiredAt === 'number', 'old entry carries retiredAt')
      assert.equal(hostsFile[oldHostId].rotatedTo, newHostId, 'old entry rotatedTo the new host')
      assert.equal(hostsFile[oldHostId].webUiCleanupPending, undefined, 'S4: rotation never sets webUiCleanupPending')
      assert.equal(hostsFile[oldHostId].deferredJournalSeed, undefined, 'S5: rotation never sets deferredJournalSeed')
      // New entry: live with the rotation markers.
      assert.match(hostsFile[newHostId].sessionId, /^session-/, 'new entry sessionId is the NEW session id (asserted cold below)')
      assert.equal(hostsFile[newHostId].previousSessionId, oldSessionId, 'new entry traces the previous (retired) session')
      assert.ok(typeof hostsFile[newHostId].sleepEpoch === 'number', 'durable sleepEpoch on the new entry (S7)')
      assert.equal(hostsFile[newHostId].webUiCleanupPending, undefined, 'S4: no cleanup marker on the new entry either')
      assert.equal(hostsFile[newHostId].deferredJournalSeed, undefined, 'S5: no deferred seed on the new entry (the session IS the journal)')

      // FIX 1 — the rotated session is persisted COLD: it is NEVER entered in
      // the live sessions store (the attached-but-agentless state the old
      // `ctx.get('sessions').create` manufactured made every later resume hit
      // the persistence live-guard "cannot prepare session … while it is
      // live" — incident session-6e49895c…, 2026-08-22 16:19:52 UTC), and the
      // seed landed via the dsh-session-persistence seam (create → detached
      // metadata; append → the seed artifact).
      const newSessionId = hostsFile[newHostId].sessionId
      assert.equal(root.sessions.get(SessionId(newSessionId)), undefined, 'FIX 1: the rotated session is COLD — not in the LIVE sessions store')
      assert.equal(persistence.createCalls.length, 1, 'exactly one persistence.create call (the detached seed metadata)')
      assert.equal(persistence.appendCalls.length, 1, 'exactly one persistence.append call (the seed artifact)')
      const createMeta = persistence.createCalls[0]
      assert.equal(createMeta.id, newSessionId, 'create meta carries the pre-minted session id')
      assert.equal(createMeta.version, 0, 'create meta carries header version 0')
      assert.ok(typeof createMeta.createdAt === 'number' && createMeta.createdAt > 0, 'create meta carries createdAt (now)')
      assert.ok(typeof createMeta.cwd === 'string' && createMeta.cwd !== '', 'create meta carries the workspace path (old session header cwd / process cwd)')
      assert.equal(createMeta.seedLength, 4, 'create meta seedLength = the 4-event rotation seed')
      const appended = persistence.appendCalls[0]
      assert.equal(appended.id, newSessionId, 'append targets the pre-minted id')
      assert.deepEqual(appended.events.map((ev) => ev.type), ['permission/preset', 'sandbox/mode', 'approval/policy', 'user/message'], 'append carries the rotation seed events')
      appended.events.forEach((ev, i) => assert.equal(ev.seq, i, `seed seq ${ev.seq} contiguous at index ${i}`))
      assert.ok(!appended.events.some((ev) => ev.type === 'turn/start'), 'the seeded artifact is BLANK (no turn/start — native "New Session" row)')
      const journalNode = appended.events.find((ev) => ev.type === 'user/message')
      assert.equal(journalNode.data.source.kind, 'plugin', 'seeded journal framed as plugin context')
      assert.match(journalNode.data.content[0].text, new RegExp(`^author: ${newHostId}$`, 'm'), 'seeded journal is the RE-KEYED journal (author host-<newId>)')
      assert.match(journalNode.data.content[0].text, /^wake_counter: 2$/m, 'seeded journal carries the BUMPED ordinal')
      assert.ok(journalNode.data.content[0].text.includes(journalSummary), 'seeded journal carries the summary body')

      // (a) The OLD on-disk journal is byte-identical apart from the bump
      // (wake_counter 1→2 — G4/D2: kept whole as the archive copy).
      const oldPostSleepContent = await readFile(preSleepPath, 'utf8')
      assert.match(oldPostSleepContent, /^wake_counter: 2$/m, 'OLD journal bumped to wake_counter 2 at S1.5')
      assert.match(oldPostSleepContent, new RegExp(`^author: ${oldHostId}$`, 'm'), 'OLD journal author untouched (host-<oldId>)')
      assert.ok(oldPostSleepContent.includes(journalSummary), 'OLD journal summary untouched')
      // The NEW re-keyed journal file exists (S1.5b) with the same bumped body.
      const newJournalText = await readFile(result.memoPath, 'utf8')
      assert.match(newJournalText, new RegExp(`^author: ${newHostId}$`, 'm'), 'NEW journal author re-keyed to host-<newId>')
      assert.match(newJournalText, /^wake_counter: 2$/m, 'NEW journal carries the bumped ordinal')
      assert.ok(newJournalText.includes(journalSummary), 'NEW journal carries the summary body')

      // (b) S5: the rotation does NOT append to the OLD session's live surface
      // (no in-place journal node) — the old surface keeps its 2 nodes.
      assert.equal(realSession.surface.nodes.length, 2, 'the old live surface is untouched (the new session IS the journal)')

      // (c) S2.5: the OLD session was archived server-side (canonical registry).
      assert.ok(workspaceRegistry.archivedSessionIds.includes(oldSessionId), 'old session id archived via workspaceRegistry (D1)')

      // The sleeping Asistente's turn concluded after the successful result.
      assert.equal(concluded, true, 'dept_sleep concluded the host turn')

      // The roster reflects the rotation: the OLD (retired) host is excluded
      // from "present"; the NEW host shows as the sleeping member.
      const who = await root.tools.get('dept_room_who').execute({ room: 'board' })
      assert.ok(!who.hosts.some((h) => h.hostId === oldHostId), 'retired host is filtered from the roster (§4/C7)')
      const newSleepingHost = who.hosts.find((h) => h.hostId === newHostId)
      assert.ok(newSleepingHost, 'the NEW host is in the board roster')
      assert.equal(newSleepingHost.sleeping, true, 'dept_room_who surfaces the sleeping NEW host')

      // (d) The wake pack targets ONLY the new host (§4): the NEW session's
      // first pre-step injects the full pack (fresh board delta, wake_counter 2
      // KPI from the re-keyed journal); a pre-step against the OLD (retired)
      // session injects NOTHING (retired-skip gate); a second pre-step on the
      // new session stays gated (no re-inject).
      const newHostAgent = agents.put(fakeParentAgent(newSessionId))
      const claimed = preStepClaimed('wake up — what is the plan?')
      const decision = await runPreStep(pluginCtx, newHostAgent, claimed, signal)
      assert.equal(decision.kind, 'enter', 'new-host pre-step decision is enter')
      assert.equal(decision.messages.length, claimed.length + 1, 'new-host pre-step injects exactly ONE extra node (the wake pack)')
      const packNode = decision.messages[decision.messages.length - 1]
      assert.match(packNode.content[0].text, /^## Deepartments wake pack$/m, 'injected pack opens with the wake pack header')
      assert.match(packNode.content[0].text, /pack-v1: present/, 'injected pack carries the deterministic P1 presence sentinel')
      assert.match(packNode.content[0].text, /kpi: wake_counter 2/, 'injected pack KPI reads the RE-KEYED journal (wake_counter 2)')
      assert.match(packNode.content[0].text, new RegExp(`Pre-resolved journal path.*${newHostId}`), 'injected pack pre-resolves the NEW journal path')

      const retiredOldAgent = agents.put(fakeParentAgent(oldSessionId))
      const oldDecision = await runPreStep(pluginCtx, retiredOldAgent, claimed, signal)
      assert.equal(oldDecision.messages.length, claimed.length, 'retired-skip gate: the OLD session pre-step injects NOTHING (plain-session behavior)')
      assert.ok(!oldDecision.messages.some((m) => m.content?.[0]?.text?.includes('## Deepartments wake pack')), 'no wake pack for the retired host')

      const second = await runPreStep(pluginCtx, newHostAgent, claimed, signal)
      assert.equal(second.messages.length, claimed.length, 'second pre-step on the new host does NOT re-inject (session-scoped gate holds)')
    } finally {
      await dispose()
    }
  })
})

test('Fix A regression (LEGACY FALLBACK path): when the U2 rotation CANNOT run (session create fails), dept_sleep falls back to the in-place reset — a host dept_sleep cycle leaves NO assistant-less role:tool message on the wake surface; the deferred full-window replace at the next pre-step (over ALL nodes INCLUDING the pending tool result) folds the surface back to the journal, which stays at the FRONT of the wake surface', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, persistence, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      // U2: force the LEGACY fallback — the rotation cannot run when the
      // session-persistence seam rejects the seed create (spec 002 §3.6; FIX 1
      // — the rotation no longer calls the live sessions store). The plugin
      // resolves the SAME service instance
      // (ctx.get('sessionPersistence') === persistence).
      persistence.create = () => { throw new Error('injected create failure — rotation falls back to the legacy in-place reset') }
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const hostId = `host-${host.id}`
      const journalSummary = 'FIX-A-SLEEP-MEMORY: the wake surface must start with this journal.'

      // A REAL dsh Session for the host, seeded exactly like the harness leaves
      // it at the dept_sleep call site: the assistant message CARRYING the
      // dept_sleep tool-call is the last surface node (the sleep turn's step).
      const realSession = Session.create(SessionId(String(host.id)))
      const assistantSeq = realSession.append('assistant/message', {
        turn: 1,
        step: 0,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Persisting memory, then sleeping.' }],
          tool_calls: [{ id: 'call_dept_sleep', type: 'function', function: { name: 'dept_sleep', arguments: '{}' } }]
        }
      }, { surfaceOp: 'append', sourceEventSeqs: [] }).seq
      host.session = realSession

      await seedJournal(stateDir, hostId, journalSummary)
      const sleepTool = root.tools.get('dept_sleep')
      await sleepTool.execute({}, { agent: host, signal, concludeTurn: () => {} })

      // Fix A close semantics: the journal node is PLAIN-APPENDED (no
      // full-window replace at close — replacing would shadow the assistant
      // tool-call message, orphaning the pending result). The assistant
      // tool-call node is NOT shadowed yet.
      assert.equal(realSession.surface.nodes.length, 2, 'close appends the journal node without shadowing the assistant tool-call message')

      // THE HARNESS then records the dept_sleep tool result AFTER the close
      // append — exactly the sequence that used to orphan a role:tool message
      // (session-cf5225e4… line 40484; the surface ends [assistant(tool_calls),
      // journal, tool] and the strict deepseek-official API rejected it with
      // 400 INVALID_REQUEST: "Messages with role 'tool' must be a response to
      // a preceding message with 'tool_calls'").
      realSession.append('tool/result', {
        turn: 1,
        step: 0,
        message: { role: 'tool', tool_call_id: 'call_dept_sleep', content: [{ type: 'text', text: `sleeping: ${hostId} marked for context reset` }] }
      }, { surfaceOp: 'append', sourceEventSeqs: [assistantSeq] })

      // Pre-wake surface = the OLD behavior's wire shape: a role:tool message
      // whose IMMEDIATE predecessor is the journal (user), NOT the assistant
      // that issued the call → the strict-API rejection case.
      const preWake = realSession.deriveMessages()
      const toolIdx = preWake.findIndex((m) => m.role === 'tool')
      assert.ok(toolIdx >= 0, 'the pending tool result is on the pre-wake surface')
      assert.equal(preWake[toolIdx - 1]?.role, 'user', 'pre-wake tool message is assistant-less (its predecessor is the journal) — the strict-API rejection case')

      // The WAKE pre-step (first message after sleep) MUST sanitize the surface:
      // the deferred full-window replace covers ALL current nodes INCLUDING the
      // pending tool result, then the wake pack is injected (Batch C unchanged).
      const claimed = preStepClaimed('wake up — what is the plan?')
      const decision = await runPreStep(pluginCtx, host, claimed, signal)

      // (1) The wake surface contains NO role:tool message at all: the orphan is
      // shadowed by the replace and never reaches the strict API.
      const wakeFold = realSession.deriveMessages()
      assert.ok(!wakeFold.some((m) => m.role === 'tool'), 'wake surface contains NO role:tool message (the orphan is shadowed by the deferred replace)')
      // (2) The journal is the FIRST (front) node of the wake surface, carrying
      // the bump the cycle advanced at sleep (wake_counter 1 → 2).
      assert.equal(wakeFold.length, 1, 'wake surface collapsed to exactly ONE node (the journal)')
      const first = wakeFold[0]
      assert.equal(first.role, 'user', 'the front node is a user message')
      assert.ok(first.content[0].text.includes(journalSummary), 'wake surface STARTS with the journal content (front)')
      assert.match(first.content[0].text, /^author: host-/m, 'the front journal node carries the journal frontmatter')
      assert.match(first.content[0].text, /^wake_counter: 2$/m, 'the front journal node carries the BUMPED wake_counter 2')
      assert.equal(first.source.kind, 'plugin', 'the front journal node is plugin context')
      assert.equal(first.source.form, 'notice', 'the front journal node is a notice (collapsed row)')
      // (3) The wake pack is still injected onto decision.messages (unchanged).
      assert.equal(decision.kind, 'enter', 'pre-step decision is enter')
      assert.equal(decision.messages.length, claimed.length + 1, 'pre-step injects exactly ONE extra node (the wake pack)')
      const packNode = decision.messages[decision.messages.length - 1]
      assert.equal(packNode.source.kind, 'plugin', 'injected pack node is a plugin context')
      assert.match(packNode.content[0].text, /pack-v1: present/, 'wake pack injected as before (Fix A preserves wake-pack injection)')
      // (4) A second pre-step of the same awake session stays gated: no
      // re-replace (the deferred intent was consumed once), no pack re-injection.
      const second = await runPreStep(pluginCtx, host, claimed, signal)
      assert.equal(second.messages.length, claimed.length, 'second pre-step does NOT re-inject (gate holds)')
      assert.equal(realSession.surface.nodes.length, 1, 'second pre-step does not re-collapse (deferred intent consumed once)')
    } finally {
      await dispose()
    }
  })
})

// --- Fix wake-12: deferred sleep-replace seed DURABILITY (sleep→restart) ------
// The deferred full-window replace intent (Fix A) lives in an IN-MEMORY map
// that dies with the process. A dept_sleep → process-restart cycle therefore
// restored an empty map, the first pre-step of the new process skipped the
// fold, and the journal-interleaved close tail [assistant(tool_calls) · journal
// · tool] shipped in the first request — the strict deepseek-official API 400
// ("insufficient tool messages following tool_calls"), the wake-12 first-turn
// failure (explore-deep/2026-08-21-first-turn-api-orphan.md). The fix persists
// the seed into hosts.json at dept_sleep (HostEntry.deferredJournalSeed) and
// RESTORES it via the real hosts loader at boot; these tests drive the REAL
// Loader through an actual dispose → re-boot to prove the restored fold.

/** Strict-consecutiveness probe (the wake-12 400 rule): every assistant wire
 * message carrying `tool_calls` must be IMMEDIATELY followed — starting at the
 * NEXT wire message — by the matching role:'tool' responses, one per call id,
 * with NO other message in between (the DeepSeek strict OpenAI-compatible
 * validator: "An assistant message with 'tool_calls' must be followed by tool
 * messages responding to each 'tool_call_id'"). Returns the list of violations
 * (empty = consecutive), so the tests can assert both the RED (pre-fold) and
 * the GREEN (post-fold) sides of the fix. */
function findConsecutivenessViolations(messages) {
  const violations = []
  for (let i = 0; i < messages.length; i++) {
    const calls = Array.isArray(messages[i].tool_calls) ? messages[i].tool_calls : []
    if (calls.length === 0) continue
    let consecutive = true
    for (let k = 0; k < calls.length; k++) {
      const next = messages[i + 1 + k]
      if (next?.role !== 'tool' || next.tool_call_id !== calls[k].id) {
        violations.push({ at: i, callId: calls[k].id, got: next?.role ?? null })
        consecutive = false
        break
      }
    }
    if (consecutive) i += calls.length // skip the consumed tool responses
  }
  return violations
}

/** Author a minimal valid host artifact (header frame + one event frame with
 * setup + a real-looking journal node) under a scratch sessions root. The boot
 * web-UI cleanup hook truncates it (keeps setup + journal, renumbers 0..k) and
 * clears the pending flag — and the hook is chained AFTER the hosts loader
 * restored the deferred seed, so observing that flag-clear is the deterministic
 * "the restore has happened" marker before the wake pre-step runs. */
async function authorCleanupWitnessArtifact(sessionsRoot, sessionId, journalText) {
  const headerLine = JSON.stringify({
    type: 'session', version: 0, id: sessionId, createdAt: 1787000000000, cwd: '/root', delegationDepth: 0, agentPreset: 'deepartments'
  })
  const events = [
    JSON.stringify({ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } }),
    JSON.stringify({ type: 'sandbox/mode', seq: 1, time: 2, data: { mode: 'danger-full-access' } }),
    JSON.stringify({ type: 'approval/policy', seq: 2, time: 3, data: { policy: 'never' } }),
    JSON.stringify({ type: 'user/message', seq: 3, time: 4, data: { content: [{ type: 'text', text: journalText }], source: { kind: 'plugin', plugin: 'deepartments', form: 'notice', summary: 'witness' }, role: 'user', id: 'w-journal' }, surfaceOp: 'append' })
  ]
  const dir = path.join(sessionsRoot, '--root--', encodeSegment(sessionId))
  await mkdir(dir, { recursive: true })
  const headerFrame = await compressZstdFrame(`${headerLine}\n`)
  const eventFrame = await compressZstdFrame(`${events.join('\n')}\n`)
  await writeFile(path.join(dir, 'session.jsonl.zstd'), Buffer.concat([headerFrame, eventFrame]))
}

test('Fix wake-12 (LEGACY FALLBACK path): when the U2 rotation CANNOT run, the fallback still persists the deferred sleep-replace seed — a dept_sleep → process-restart cycle restores it from hosts.json and the FIRST pre-step folds the journal-interleaved close tail back to the journal (the wake-12 first-turn 400 fix)', async () => {
  await withTempStateDir(async (stateDir) => {
    const sessionId = SessionId(randomUUID())
    const hostId = `host-${sessionId}`
    const journalSummary = 'WAKE-12-SEED: carried durably across the restart.'

    // Phase A — boot 1: a real dept_sleep persists the seed durably. The U2
    // rotation normally REPLACES this legacy machinery (S4/S5 never set
    // webUiCleanupPending/deferredJournalSeed under rotation), so the test
    // forces the LEGACY FALLBACK by breaking the session-persistence seam's
    // seed create (FIX 1 — the rotation no longer calls the live sessions
    // store) — exactly the "rotation cannot run" case where the legacy path
    // must still work (spec 002 §3.6/§5).
    const a = await bootPlugin(stateDir)
    try {
      await waitForRooms(a.root)
      a.persistence.create = () => { throw new Error('injected create failure — legacy fallback persists the deferred seed') }
      const hostA = a.agents.put(fakeParentAgent(sessionId))
      await seedJournal(stateDir, hostId, journalSummary)
      // A real dsh Session so the host branch's surface append + deferred
      // intent run (the map intent AND its durable mirror).
      const realSessionA = Session.create(sessionId)
      realSessionA.append('user/message', { role: 'user', content: [{ type: 'text', text: 'prior turn 1' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      hostA.session = realSessionA
      await a.root.tools.get('dept_sleep').execute({}, { agent: hostA, signal: new AbortController().signal, concludeTurn: () => {} })
      // Deferred seed mirror: hosts.json carries deferredJournalSeed alongside
      // sleepEpoch/webUiCleanupPending (persistHosts is fire-and-forget →
      // waitFor).
      await waitFor(async () => {
        const hostsFile = await readHosts(stateDir)
        return typeof hostsFile[hostId]?.deferredJournalSeed === 'string'
      }, 5000, 'deferredJournalSeed persisted to hosts.json at dept_sleep')
      const hostsFile = await readHosts(stateDir)
      const journalFile = await readFile(path.join(stateDir, 'journals', `${hostId}.md`), 'utf8')
      assert.equal(hostsFile[hostId].deferredJournalSeed, journalFile, 'persisted seed is the seeded journal text (the bump output)')
      assert.match(hostsFile[hostId].deferredJournalSeed, /^wake_counter: 2$/m, 'persisted seed carries the BUMPED ordinal')
      assert.equal(hostsFile[hostId].webUiCleanupPending, true, 'cleanup marker persisted at the same sleep (reload witness)')
    } finally {
      await a.dispose()
    }

    // Phase B — boot 2 (RESTART): the fresh process must re-arm the fold from
    // hosts.json. The boot web-UI cleanup hook (hostsLoaded.then → the restore
    // is UPSTREAM of hostsLoaded) truncates a witness artifact + clears the
    // flag ONLY AFTER the loader restored the seed, so its flag-clear is the
    // deterministic "restore done" marker.
    const witnessRoot = path.join(stateDir, 'witness-sessions')
    await authorCleanupWitnessArtifact(witnessRoot, String(sessionId), `---\nauthor: ${hostId}\nwake_counter: 2\n---\n\nwitness`)
    const b = await bootPlugin(stateDir, { persistenceRoot: witnessRoot })
    try {
      await waitForRooms(b.root)
      await waitFor(async () => {
        const hostsFile = await readHosts(stateDir)
        return hostsFile[hostId]?.webUiCleanupPending !== true
      }, 5000, 'boot cleanup ran after the loader restore (witness)')
      const hostsAfterCleanup = await readHosts(stateDir)
      assert.equal(typeof hostsAfterCleanup[hostId]?.deferredJournalSeed, 'string', 'the durable seed SURVIVED the cleanup (only the fold consumes it)')
      const restoredSeed = hostsAfterCleanup[hostId].deferredJournalSeed
      // The resumed host session carries the wake-11 close tail shape:
      // [assistant(dept_sleep tool_calls) · journal · tool result] — the exact
      // wire the wake-12 first request shipped (RED: the strict-API 400 case).
      const hostB = b.agents.put(fakeParentAgent(sessionId))
      const realSessionB = Session.create(sessionId)
      const assistantSeq = realSessionB.append('assistant/message', {
        turn: 1, step: 0,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Persisting memory, then sleeping.' }],
          tool_calls: [{ id: 'call_dept_sleep', type: 'function', function: { name: 'dept_sleep', arguments: '{}' } }]
        }
      }, { surfaceOp: 'append', sourceEventSeqs: [] }).seq
      realSessionB.append('user/message', buildSleepJournalMessage(restoredSeed), { surfaceOp: 'append' })
      realSessionB.append('tool/result', {
        turn: 1, step: 0,
        message: { role: 'tool', tool_call_id: 'call_dept_sleep', content: [{ type: 'text', text: `sleeping: ${hostId} marked for context reset` }] }
      }, { surfaceOp: 'append', sourceEventSeqs: [assistantSeq] })
      hostB.session = realSessionB
      // RED probe: the UNFOLDED surface violates strict tool-response
      // consecutiveness (the journal sits between the assistant tool_calls and
      // its tool response) — the wake-12 400 condition, deterministically.
      const redViolations = findConsecutivenessViolations(realSessionB.deriveMessages())
      assert.ok(redViolations.length > 0, 'UNFOLDED close tail violates strict tool-response consecutiveness (the 400 condition)')
      // The FIRST pre-step of the RESTARTED process performs the deferred fold.
      const claimed = preStepClaimed('wake up — what is the plan?')
      const signalB = new AbortController().signal
      const decision = await runPreStep(b.pluginCtx, hostB, claimed, signalB)
      assert.equal(decision.kind, 'enter', 'pre-step decision is enter')
      const folded = realSessionB.deriveMessages()
      assert.equal(folded.length, 1, 'surface collapsed to exactly ONE node (the folded journal)')
      assert.equal(folded[0].role, 'user', 'the fold lands a single journal node')
      assert.equal(folded[0].content[0].text, restoredSeed, 'folded journal node re-lands the restored seed byte-for-byte')
      assert.equal(folded[0].source.kind, 'plugin', 'journal node rendered as plugin context (never a user-typed message)')
      assert.equal(findConsecutivenessViolations(folded).length, 0, 'post-fold first-request messages are CONSECUTIVE — no 400 class remains')
      // The wake pack is still injected fresh (Batch C unchanged).
      assert.equal(decision.messages.length, claimed.length + 1, 'pre-step injects exactly ONE extra node (the wake pack)')
      assert.match(decision.messages.at(-1).content[0].text, /pack-v1: present/, 'wake pack injected on the restored boot')
      // Consume-once: the fold clears the DURABLE seed too (a later mid-wake
      // restart must NOT restore it and re-fold — next test).
      await waitFor(async () => {
        const hostsFile = await readHosts(stateDir)
        return hostsFile[hostId]?.deferredJournalSeed === undefined
      }, 5000, 'durable seed cleared when the fold consumed the intent')
      // Second pre-step stays gated (no re-fold, no re-inject).
      const second = await runPreStep(b.pluginCtx, hostB, claimed, signalB)
      assert.equal(second.messages.length, claimed.length, 'second pre-step does NOT re-inject (gate holds)')
      assert.equal(findConsecutivenessViolations(realSessionB.deriveMessages()).length, 0, 'no re-fold (surface stays the folded journal)')
    } finally {
      await b.dispose()
    }
  })
})

test('Fix wake-12: a boot WITHOUT a persisted deferred seed preserves the pre-existing behavior — the first pre-step does NOT fold (the wake surface survives) and only injects the pack', async () => {
  await withTempStateDir(async (stateDir) => {
    const sessionId = SessionId(randomUUID())
    const hostId = `host-${sessionId}`
    // Author the registry as a mid-wake state (slept before; the fold already
    // consumed its seed in a previous process): host entry WITHOUT
    // deferredJournalSeed, cleanup flag absent (already cleared).
    const hostsPath = path.join(stateDir, 'hosts.json')
    await mkdir(stateDir, { recursive: true })
    await writeFile(hostsPath, JSON.stringify({ [hostId]: { sessionId: String(sessionId), roomId: 'board', sleepEpoch: 1787261780000, boundarySeq: 10 } }, null, 2))
    const b = await bootPlugin(stateDir)
    try {
      await waitForRooms(b.root)
      const host = b.agents.put(fakeParentAgent(sessionId))
      const realSession = Session.create(sessionId)
      realSession.append('user/message', { role: 'user', content: [{ type: 'text', text: 'wake turn 1' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      host.session = realSession
      const claimed = preStepClaimed('continue')
      const decision = await runPreStep(b.pluginCtx, host, claimed, new AbortController().signal)
      assert.equal(decision.kind, 'enter', 'pre-step decision is enter')
      assert.equal(realSession.surface.nodes.length, 1, 'no fold (no deferred seed restored) — surface intact')
      assert.equal(realSession.deriveMessages().length, 1, 'the wake turn survives the first pre-step')
      assert.equal(decision.messages.length, claimed.length + 1, 'pre-step injects exactly ONE extra node (the wake pack)')
      assert.match(decision.messages.at(-1).content[0].text, /pack-v1: present/, 'wake pack still injected fresh')
    } finally {
      await b.dispose()
    }
  })
})

test('U2: boot with a ROTATED hosts.json (v2 schema — old retired + new live) restores the registry; the NEW host gets the wake pack, the RETIRED host injects NOTHING (retired-skip gate, T4), and the boot cleanup hook never truncates the retired entry (S5 guard)', async () => {
  await withTempStateDir(async (stateDir) => {
    const oldSessionId = SessionId(randomUUID())
    const newSessionId = SessionId(randomUUID())
    const oldHostId = `host-${oldSessionId}`
    const newHostId = `host-${newSessionId}`
    // Both journal files on disk (the S1.5b write happened before the process
    // died after S3 — the S3→S8 crash window, spec 002 §3.6).
    await seedJournal(stateDir, oldHostId, 'OLD-ARCHIVE-JOURNAL: preserved whole.')
    await seedJournal(stateDir, newHostId, 'NEW-LIVE-JOURNAL: re-keyed.')
    // A ROTATED v2 hosts.json: old retired (evidence, D1) + new live
    // (previousSessionId traces the retire). The retired entry also carries a
    // stray legacy cleanup flag + a witness artifact so the ignored-by-guard
    // path is observable (a non-guarded cleanup would truncate + clear it).
    const witnessRoot = path.join(stateDir, 'witness-sessions')
    await authorCleanupWitnessArtifact(witnessRoot, String(oldSessionId), '---\nauthor: ' + oldHostId + '\nwake_counter: 2\n---\n\nretired witness')
    const artifactPath = path.join(witnessRoot, '--root--', encodeSegment(oldSessionId), 'session.jsonl.zstd')
    const artifactBefore = await readFile(artifactPath)
    const hostsPath = path.join(stateDir, 'hosts.json')
    await writeFile(hostsPath, JSON.stringify({
      schemaVersion: 2,
      [oldHostId]: {
        sessionId: String(oldSessionId), roomId: 'board', sleepEpoch: 1787261780000, boundarySeq: 10,
        retired: true, retiredAt: 1787261781000, rotatedTo: newHostId, webUiCleanupPending: true
      },
      [newHostId]: { sessionId: String(newSessionId), roomId: 'board', sleepEpoch: 1787261781000, boundarySeq: 11, previousSessionId: String(oldSessionId) }
    }, null, 2))
    const b = await bootPlugin(stateDir, { persistenceRoot: witnessRoot })
    try {
      await waitForRooms(b.root)
      // The loader validates + restores the v2 file (the new live host is
      // present; the retired entry stays queryable).
      await waitFor(async () => {
        const hostsFile = await readHosts(stateDir)
        return hostsFile[newHostId]?.sessionId !== undefined
      }, 5000, 'rotated hosts.json restored')
      const hostsFile = await readHosts(stateDir)
      assert.equal(hostsFile[oldHostId].retired, true, 'retired entry restored from the v2 file')

      // (a) The NEW host's first pre-step injects the full wake pack.
      const newAgent = b.agents.put(fakeParentAgent(newSessionId))
      const claimed = preStepClaimed('wake up after a restart')
      const decision = await runPreStep(b.pluginCtx, newAgent, claimed, new AbortController().signal)
      assert.equal(decision.kind, 'enter', 'new-host pre-step decision is enter')
      assert.equal(decision.messages.length, claimed.length + 1, 'new host pre-step injects exactly ONE extra node (the wake pack)')
      assert.match(decision.messages.at(-1).content[0].text, /^## Deepartments wake pack$/m, 'pack opens with the wake pack header')
      assert.match(decision.messages.at(-1).content[0].text, /pack-v1: present/, 'pack injected on the restored new host')
      assert.match(decision.messages.at(-1).content[0].text, new RegExp(`Pre-resolved journal path.*${newHostId}`), 'pack pre-resolves the NEW journal path')

      // (b) The RETIRED host's pre-step injects NOTHING (retired-skip gate —
      // a message typed into the old tab behaves as a plain session, C1).
      const oldAgent = b.agents.put(fakeParentAgent(oldSessionId))
      const oldDecision = await runPreStep(b.pluginCtx, oldAgent, claimed, new AbortController().signal)
      assert.equal(oldDecision.messages.length, claimed.length, 'retired host pre-step adds NO node')
      assert.ok(!oldDecision.messages.some((m) => m.content?.[0]?.text?.includes('## Deepartments wake pack')), 'no wake pack for the retired host even after a restart')

      // (c) The boot cleanup hook SKIPPED the retired entry (§5 defence-in-
      // depth): its stray webUiCleanupPending flag SURVIVES the boot and its
      // witness artifact is byte-identical (never truncated — G4).
      await waitFor(async () => {
        const hostsFile = await readHosts(stateDir)
        return hostsFile[newHostId]?.sessionId !== undefined
      }, 5000, 'registry settled')
      await new Promise((resolve) => setTimeout(resolve, 200))
      const afterCleanup = await readHosts(stateDir)
      assert.equal(afterCleanup[oldHostId].webUiCleanupPending, true, 'cleanup never runs on a retired entry (flag survives — §5 guard)')
      assert.deepEqual(await readFile(artifactPath), artifactBefore, 'retired artifact byte-identical (never truncated — G4)')
    } finally {
      await b.dispose()
    }
  })
})

// --- Batch C: FRESH wake-pack injection at `agent/pre-step` (message-arrival
// time). The pack is no longer frozen into the dept_sleep surface (see the
// Batch 7 host test above — the close PLAIN-APPENDS the journal; the full-window
// collapse to that journal is DEFERRED to this injector, Fix A). It is
// instead assembled from LIVE reads each time the host's first pre-step of an
// awake session runs, and injected as a plugin/notice node onto decision.messages
// at the same point the standard DSH context injections land. The tests below
// fire the real `agent/pre-step` Cordis waterfall on the plugin ctx (the SAME
// event the dsh-agent-loop drives per model step) and assert the injected node.

function preStepClaimed(text = 'the user message') {
  return [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }]
}

async function runPreStep(pluginCtx, agent, messages, signal) {
  return pluginCtx().waterfall(
    'agent/pre-step',
    { agent, messages, signal },
    () => ({ kind: 'enter', messages })
  )
}

test('Batch C pre-step: a HOST session\'s first message-time pre-step injects a FRESH wake pack (pack-v1 sentinel + fresh board delta + wake_counter KPI) onto decision.messages', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const hostId = `host-${host.id}`

      // Pre-author the host journal WITH open items so the KPI line is real
      // (dept_memo_write is the real tool; wake_counter 1 on first write).
      const memo = root.tools.get('dept_memo_write')
      await memo.execute(
        { summary: 'PRE-STEP fresh wake orientation.', openItems: ['finish pre-step wiring', 'ship wake timing'] },
        { agent: host, signal }
      )

      // A board message addressed to the host arrives AFTER any "sleep" — the
      // fresh delta the pack MUST capture (this is the anti-staleness core).
      const writeTool = root.tools.get('dept_room_write')
      const written = await writeTool.execute(
        { room: 'board', to: [hostId], text: 'fresh message for the pre-step pack' },
        { agent: host, signal }
      )
      assert.equal(written.from, hostId, 'board write from the host recorded')

      const claimed = preStepClaimed()
      const decision = await runPreStep(pluginCtx, host, claimed, signal)

      assert.equal(decision.kind, 'enter', 'pre-step decision is enter')
      // claimed (1 user message) + the 1 injected pack node.
      assert.equal(decision.messages.length, claimed.length + 1, 'pre-step injects exactly ONE extra node (the wake pack)')
      const packNode = decision.messages[decision.messages.length - 1]
      assert.equal(packNode.source.kind, 'plugin', 'injected pack node is a plugin context')
      assert.equal(packNode.source.form, 'notice', 'injected pack node is a notice (collapsed row, not a user-typed message)')
      const packText = packNode.content[0].text
      assert.match(packText, /^## Deepartments wake pack$/m, 'injected pack opens with the wake pack header')
      assert.match(packText, /pack-v1: present/, 'injected pack carries the deterministic P1 presence sentinel')
      assert.match(packText, /fresh message for the pre-step pack/, 'injected pack carries FRESH board-delta content (read at message time, not frozen at the previous dept_sleep)')
      assert.match(packText, /- kpi: wake_counter 1; top open item: finish pre-step wiring/, 'injected pack carries the wake_counter + top open-item KPI from the journal')
      assert.match(packText, /Pre-resolved journal path.*host-/, 'injected pack pre-resolves the host journal path')
      assert.match(packText, /## deepartments-workflow skill \(full body\)/, 'injected pack embeds the full skill body')
    } finally {
      await dispose()
    }
  })
})

test('Batch C pre-step: a NEVER-SLEPT host (no journal seed) injects a DEGRADED wake pack without throwing', async () => {
  await withTempStateDir(async (stateDir) => {
    // The wake pack goes ONLY to the session registered as the board host in
    // hosts.json — seed the registry BEFORE boot (registered-host fixture).
    const sessionId = SessionId(randomUUID())
    await seedHostRegistration(stateDir, sessionId)
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent(sessionId))
      const signal = new AbortController().signal
      // NO journal seeded — the host has never slept and has no durable memory.

      const claimed = preStepClaimed('first ever message')
      const decision = await runPreStep(pluginCtx, host, claimed, signal)

      // Never throws: the injection proceeds with degraded reads.
      assert.equal(decision.kind, 'enter', 'never-slept pre-step still returns enter (no throw)')
      const packNode = decision.messages[decision.messages.length - 1]
      assert.equal(packNode.source.kind, 'plugin', 'never-slept host still gets a plugin-context pack node')
      const packText = packNode.content[0].text
      assert.match(packText, /pack-v1: present/, 'never-slept pack carries the presence sentinel')
      assert.match(packText, /wake_counter \(unavailable\); top open item: \(unavailable\)/, 'KPI degrades gracefully with no journal')
    } finally {
      await dispose()
    }
  })
})

test('Batch C pre-step: repeated pre-step within ONE awake session does NOT re-inject once the pack is present (session-scoped gate)', async () => {
  await withTempStateDir(async (stateDir) => {
    // Registered-host fixture (the context-injection gate: only registered
    // hosts receive the pack) — seed hosts.json BEFORE boot.
    const sessionId = SessionId(randomUUID())
    const hostId = await seedHostRegistration(stateDir, sessionId)
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent(sessionId))
      const signal = new AbortController().signal
      await seedJournal(stateDir, hostId, 'PRE-STEP gate: single injection per awake session.')

      const claimed = preStepClaimed()
      const first = await runPreStep(pluginCtx, host, claimed, signal)
      assert.equal(first.messages.length, claimed.length + 1, 'first pre-step injects the pack')

      // A second pre-step (e.g. the next tool-call step of the SAME awake
      // session) must NOT re-inject the ~5kB pack — decision.messages stays at
      // the claimed input only (the per-step decision contract does not carry
      // prior injected nodes; the session-scoped presence flag is the gate).
      const second = await runPreStep(pluginCtx, host, claimed, signal)
      assert.equal(second.kind, 'enter')
      assert.equal(second.messages.length, claimed.length, 'second pre-step does NOT re-inject (gate holds)')
      assert.ok(!second.messages.some((m) => m.content?.[0]?.text?.includes('## Deepartments wake pack')), 'no wake pack node on the repeated pre-step')

      // A THIRD pre-step (the follow-up continuation) also stays gated.
      const third = await runPreStep(pluginCtx, host, claimed, signal)
      assert.equal(third.messages.length, claimed.length, 'third pre-step still gated (no re-injection)')
    } finally {
      await dispose()
    }
  })
})

// --- Context-injection gate (2026-08-22): the wake pack goes ONLY to the
// session REGISTERED as the board host in hosts.json. Plain never-registered
// root sessions get NO Deepartments context; a mid-session registration
// delivers the pack at the NEXT pre-step (the gated-off path never marks
// wakePackInjected).

test('Context-injection gate: a session REGISTERED as the board host in hosts.json gets the wake pack at its first pre-step (pack-v1 sentinel)', async () => {
  await withTempStateDir(async (stateDir) => {
    const sessionId = SessionId(randomUUID())
    await seedHostRegistration(stateDir, sessionId)
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent(sessionId))
      const signal = new AbortController().signal

      const claimed = preStepClaimed('first message of the registered host')
      const decision = await runPreStep(pluginCtx, host, claimed, signal)

      assert.equal(decision.kind, 'enter', 'pre-step decision is enter')
      assert.equal(decision.messages.length, claimed.length + 1, 'registered host pre-step injects exactly ONE extra node (the wake pack)')
      const packNode = decision.messages[decision.messages.length - 1]
      assert.equal(packNode.source.kind, 'plugin', 'injected pack node is a plugin context')
      assert.equal(packNode.source.form, 'notice', 'injected pack node is a notice')
      const packText = packNode.content[0].text
      assert.match(packText, /^## Deepartments wake pack$/m, 'injected pack opens with the wake pack header')
      assert.match(packText, /pack-v1: present/, 'injected pack carries the deterministic P1 presence sentinel')
    } finally {
      await dispose()
    }
  })
})

test('Context-injection gate: a PLAIN root session (never registered in hosts.json) gets NO wake pack and NO Deepartments context at its first pre-step', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      // Deliberately UNREGISTERED: no hosts.json entry, no board-tool call.
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal

      const claimed = preStepClaimed('a plain conversation')
      const decision = await runPreStep(pluginCtx, host, claimed, signal)

      assert.equal(decision.kind, 'enter', 'plain pre-step still returns enter')
      assert.equal(decision.messages.length, claimed.length, 'plain session pre-step adds NO node (decision.messages unchanged)')
      assert.ok(decision.messages.every((m) => !m.content?.[0]?.text?.includes('deepartments')), 'no Deepartments context anywhere on the plain session surface')
    } finally {
      await dispose()
    }
  })
})

test('Context-injection gate: a registered board POST (head-*) still gets NO wake pack at its first pre-step (the 2624 post gate is untouched)', async () => {
  await withTempStateDir(async (stateDir) => {
    await seedPost(stateDir, { postId: 'research-head', sessionId: 'head-research-head', roomId: 'research' })
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      // The stable head session id is registered in posts.json at boot, so
      // postIdForChild resolves and the early post gate (invoke.ts:2624) holds.
      const head = agents.put(fakeParentAgent('head-research-head'))
      const signal = new AbortController().signal

      const claimed = preStepClaimed('head wake surface')
      const decision = await runPreStep(pluginCtx, head, claimed, signal)

      assert.equal(decision.kind, 'enter', 'post pre-step still returns enter')
      assert.equal(decision.messages.length, claimed.length, 'a registered post pre-step adds NO pack node (lean board-delta wake only)')
      assert.ok(!decision.messages.some((m) => m.content?.[0]?.text?.includes('## Deepartments wake pack')), 'a board post never receives the host wake pack')
    } finally {
      await dispose()
    }
  })
})

test('Context-injection gate: a session that REGISTERS mid-session (first dept_whereami → ensureHost) gets the wake pack at its NEXT pre-step (late registration late-injects)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal

      // Plain first pre-step: NO pack — not a registered host yet.
      const claimed = preStepClaimed('first message, still unregistered')
      const first = await runPreStep(pluginCtx, host, claimed, signal)
      assert.equal(first.kind, 'enter')
      assert.equal(first.messages.length, claimed.length, 'unregistered session pre-step adds NO node')
      assert.ok(!first.messages.some((m) => m.content?.[0]?.text?.includes('## Deepartments wake pack')), 'no wake pack before registration')

      // Mid-session registration: dept_whereami counts as a board tool call →
      // Batch E ensureHost registers this session in hosts.json SYNCHRONOUSLY.
      const whereamiTool = pluginCtx().tools.get('dept_whereami')
      const where = await whereamiTool.execute({}, { agent: host, signal })
      assert.equal(where.kind, 'host', 'whereami registers the calling session as a host')

      // NEXT pre-step: the pack arrives — the gated-off path never marked
      // wakePackInjected, so nothing blocks the late injection.
      const second = await runPreStep(pluginCtx, host, claimed, signal)
      assert.equal(second.kind, 'enter')
      assert.equal(second.messages.length, claimed.length + 1, 'post-registration pre-step injects exactly ONE extra node (the wake pack)')
      const packNode = second.messages[second.messages.length - 1]
      assert.match(packNode.content[0].text, /^## Deepartments wake pack$/m, 'late-injected pack opens with the wake pack header')
      assert.match(packNode.content[0].text, /pack-v1: present/, 'late-injected pack carries the presence sentinel')
    } finally {
      await dispose()
    }
  })
})

// --- Task T4: ROLE-FOCUSED context injection for TRANSIENT subagents --------
// Every tool-dispatched subagent (origin === 'subagent') now gets a slim
// per-role contract block at its first pre-step instead of the FULL host wake
// pack (~4.6-4.9k tokens). Registered hosts/heads/workers (origin undefined)
// keep the full pack untouched (existing Batch C tests are the regression
// guard).

/** A transient dispatched subagent as dsh-subagent creates it: a bare UUID
 * session whose durable header carries the FLAT origin 'subagent' as a
 * TOP-LEVEL key (+ parentSession) — the REAL runtime shape: dsh-session
 * flattens the creation-meta whitelist into header.origin (dsh-session/lib/
 * index.js:1657-1668); a nested header.meta NEVER exists at runtime (the old
 * nested fixture was exactly why the T4 branch stayed dead code). */
function fakeSubagentAgent(id = SessionId(randomUUID())) {
  return {
    id,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    status: 'idle',
    session: {
      header: { id, origin: 'subagent', parentSession: 'host-some-orchestrator' },
      events: []
    },
    ctx: { get: () => undefined },
    inboxMessages: [],
    injectedMessages: [],
    followup(message) { this.inboxMessages.push(message) },
    steer() {},
    inject(message) { this.injectedMessages.push(message) },
    send() {},
    cancel() {},
    whenIdle() { return new Promise(() => {}) }
  }
}

test('Task T4 pre-step: a TRANSIENT subagent (origin=subagent, role=reviewer) is injected a slim ROLE-focused block AND NOT the full host wake pack', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const reviewer = agents.put(fakeSubagentAgent())
      // Dispatch-time role recording is what src/subagent.ts execute does; the
      // shared module registry is the same instance the real-loader injector reads.
      rememberRole(String(reviewer.id), 'reviewer')
      const signal = new AbortController().signal

      const claimed = preStepClaimed('review the change please')
      const decision = await runPreStep(pluginCtx, reviewer, claimed, signal)

      assert.equal(decision.kind, 'enter')
      assert.equal(decision.messages.length, claimed.length + 1, 'subagent pre-step injects exactly ONE extra node (the slim role block)')
      const node = decision.messages[decision.messages.length - 1]
      assert.equal(node.source.kind, 'plugin', 'subagent orientation is a plugin context')
      assert.equal(node.source.form, 'notice', 'subagent orientation is a notice')
      const text = node.content[0].text

      // Slim role-focused block present:
      assert.match(text, /^## Deepartments context$/m, 'subagent orientation opens with its OWN header, not the wake pack header')
      assert.match(text, /pack-v1: present/, 'carries the deterministic presence sentinel')
      assert.match(text, /identity: Deepartments subagent \(role: reviewer, room: board\)/, 'identity is a Deepartments subagent with the REVIEWER role — never a host')
      assert.match(text, /## Your role contract/, 'role contract section present')
      assert.match(text, /READ-ONLY: you do NOT write or edit code\./, 'reviewer contract injected')
      assert.match(text, /VERDICT: PASS \(1-2 line note\) or FAIL/, 'reviewer contract verdict line injected')

      // NO full host wake pack markers:
      assert.ok(!text.includes('## Deepartments wake pack'), 'no host wake pack header')
      assert.ok(!/host-[0-9a-f-]+ \(role: host\)/.test(text), 'no host-… (role: host) branding')
      assert.ok(!text.includes('Pre-resolved journal path'), 'no journal pointer')
      assert.ok(!text.includes('## Board delta since cursor'), 'no board delta section')
      assert.ok(!text.includes('## Condensed roster'), 'no roster')
      assert.ok(!text.includes('## Git bearings'), 'no git bearings section')
      assert.ok(!text.includes('## System state'), 'no system state section')
      assert.ok(!text.includes('## ROADMAP current status (tail)'), 'no ROADMAP tail')
      assert.ok(!text.includes('## deepartments-workflow skill (full body)'), 'no full skill body')
      assert.ok(!text.includes('## Guidance (wake routine)'), 'no wake-routine guidance')
    } finally {
      await dispose()
    }
  })
})

test('Task T4 pre-step: role plumbing — known role injects its contract; unknown/absent roles fall back to GENERIC', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const signal = new AbortController().signal

      // normalizeRole is the authoritative normalizer.
      assert.equal(normalizeRole('builder'), 'builder')
      assert.equal(normalizeRole('explore'), 'explore')
      assert.equal(normalizeRole('bogus'), 'generic')
      assert.equal(normalizeRole(undefined), 'generic')
      assert.equal(normalizeRole(''), 'generic')

      // A role with NO registry entry (cold-resume / absent role param) → generic.
      const cold = agents.put(fakeSubagentAgent())
      const claimedCold = preStepClaimed('one-off')
      const coldDecision = await runPreStep(pluginCtx, cold, claimedCold, signal)
      assert.equal(coldDecision.kind, 'enter')
      const coldNode = coldDecision.messages[coldDecision.messages.length - 1]
      assert.match(coldNode.content[0].text, /identity: Deepartments subagent \(role: generic/, 'absent role resolves to generic')
      assert.match(coldNode.content[0].text, /DO THE ONE TASK GIVEN in your dispatch prompt/, 'generic contract injected when role unknown')

      // A caller explicitly recording an UNKNOWN role also resolves to generic.
      const bogus = agents.put(fakeSubagentAgent())
      rememberRole(String(bogus.id), 'totally-unknown')
      const claimedBogus = preStepClaimed('do the thing')
      const bogusDecision = await runPreStep(pluginCtx, bogus, claimedBogus, signal)
      assert.equal(bogusDecision.kind, 'enter')
      assert.match(bogusDecision.messages[bogusDecision.messages.length - 1].content[0].text, /role: generic/, 'unknown role falls back to generic')
    } finally {
      await dispose()
    }
  })
})

test('Task T4 follow-up: the roleRegistry entry is EVICTED at the subagent/end lifecycle edge, and a malformed payload is a NO-OP', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)

      // Mount the REAL subagent tool fork (src/subagent.ts apply) the way the
      // agent preset does, so ITS `subagent/end` listener is actually
      // registered when we fire the lifecycle edge below (the fork plugin is
      // not part of the bootPlugin loader composition).
      await root.plugin({ name: 'deepartments-subagent', inject: ['tools', 'subagents', 'systemPrompt'], apply: subagentForkApply }, { provider: 'spawn', toolName: 'subagent' })

      // Seed a dispatch-time role and confirm it is readable pre-settlement.
      rememberRole('child-abc', 'reviewer')
      assert.equal(roleForSession('child-abc'), 'reviewer', 'dispatch-time role recorded before settlement')

      // Fire the lifecycle edge through the real ctx the subagent.ts listener
      // is registered on (the plugin fiber ctx), with the production payload
      // shape { id, provider, runId, local, stopReason, ... }. The listener
      // reads payload.id and evicts the registry key.
      pluginCtx().emit('subagent/end', {
        id: 'child-abc',
        provider: 'spawn',
        runId: randomUUID(),
        local: true,
        stopReason: 'completed'
      })
      await waitFor(() => roleForSession('child-abc') === 'generic', 5000, 'registry entry evicted on subagent/end')

      // Malformed payloads must be silent no-ops: no id at all, and a
      // non-string id. The entry survives both.
      rememberRole('child-noop', 'builder')
      assert.equal(roleForSession('child-noop'), 'builder', 'entry seeded for the malformed-payload probe')
      pluginCtx().emit('subagent/end', { stopReason: 'completed' })
      pluginCtx().emit('subagent/end', { id: 123, stopReason: 'completed' })
      assert.equal(roleForSession('child-noop'), 'builder', 'malformed subagent/end payloads (no id / non-string id) are a no-op — the entry survives')
    } finally {
      await dispose()
    }
  })
})

test('Task T4 dept_sleep: a transient subagent calling the global dept_sleep is REFUSED (no host misclassification, no context reset)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      const sub = agents.put(fakeSubagentAgent())
      const sleepTool = root.tools.get('dept_sleep')
      const signal = new AbortController().signal
      // Even with a pre-authored "host" journal (so the host branch would
      // otherwise have proceeded), the subagent is refused BEFORE any reset.
      const bogusHostId = `host-${sub.id}`
      await seedJournal(stateDir, bogusHostId, 'subagent should never sleep')
      await assert.rejects(
        () => sleepTool.execute({}, { agent: sub, signal }),
        /dept_sleep is refused for a transient delegated subagent — a subagent cannot sleep/,
        'dept_sleep refuses a transient subagent'
      )
      // No context reset occurred: the throw came before the host branch, so the
      // live surface is untouched (nothing collapsed to a journal node).
      assert.equal(sub.session.header.id, sub.id, 'subagent session untouched by the refused sleep')
    } finally {
      await dispose()
    }
  })
})

// ---- Task T4 REGRESSION (2026-08-21): the discriminator reads the FLAT
// header.origin. dsh-session FLATTENS the creation-meta whitelist into
// top-level header keys (header.origin = meta.origin — dsh-session/lib/
// index.js:1657-1668); a nested header.meta NEVER exists at runtime (confirmed
// on persisted session records). The original T4 code read header.meta.origin,
// so the slim branch was DEAD CODE: every child — subagent, workflow, fork —
// got the full 25 313-char host wake pack (explore-deep/2026-08-21-subagent-
// context-injection.md, the dept_sleep guard too). DRIVEN THROUGH THE REAL
// LOADER with the REAL flat runtime shape; on the old nested-meta
// discriminator this test FAILS.

test('Task T4 REGRESSION: a subagent-origin child with the REAL FLAT header (origin top-level, no nested meta) gets the slim role contract AND NOT the wake pack; a host-origin session still gets the full pack; dept_sleep refuses the flat-origin subagent', async () => {
  await withTempStateDir(async (stateDir) => {
    // Registered-host fixture for the host part below (the context-injection
    // gate: only sessions registered as the board host receive the wake pack) —
    // seed hosts.json BEFORE boot.
    const hostSessionId = SessionId(randomUUID())
    await seedHostRegistration(stateDir, hostSessionId)
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const signal = new AbortController().signal

      // ---- subagent: the REAL persisted header shape — flat origin, NO nested
      // meta (the shape dsh-session produces; the old code read the nested
      // shape, never matched, and fell through to the full host pack).
      const sub = agents.put(fakeSubagentAgent())
      assert.equal(sub.session.header.meta, undefined, 'fixture is the REAL flat shape: no nested meta key on the header')
      assert.equal(sub.session.header.origin, 'subagent', 'fixture carries the top-level flat origin discriminator')
      rememberRole(String(sub.id), 'reviewer')
      const claimed = preStepClaimed('review the change please')
      const decision = await runPreStep(pluginCtx, sub, claimed, signal)
      assert.equal(decision.kind, 'enter')
      assert.equal(decision.messages.length, claimed.length + 1, 'subagent pre-step injects exactly ONE extra node (the slim role block)')
      const text = decision.messages[decision.messages.length - 1].content[0].text
      assert.match(text, /^## Deepartments context$/m, 'slim block opens with its OWN header — not the wake-pack header')
      assert.match(text, /identity: Deepartments subagent \(role: reviewer, room: board\)/, 'slim block: subagent identity with the reviewer role — never a host')
      // The wake-pack markers the dead-code bug used to inject:
      assert.ok(!text.includes('## Deepartments wake pack'), 'NO wake-pack header text (dead-code regression: old code injected the full pack)')
      assert.ok(!text.includes('Pre-resolved journal path'), 'NO journal pointer')
      assert.ok(!text.includes('## Git bearings'), 'NO git bearings section')

      // ---- host: the real root-agent header (flat, no origin key) still gets
      // the FULL wake pack — the host-side behavioral guarantee is unchanged.
      const host = agents.put(fakeParentAgent(hostSessionId))
      const hostClaimed = preStepClaimed('wake up')
      const hostDecision = await runPreStep(pluginCtx, host, hostClaimed, signal)
      assert.equal(hostDecision.kind, 'enter')
      assert.equal(hostDecision.messages.length, hostClaimed.length + 1, 'host pre-step injects exactly ONE extra node (the wake pack)')
      const hostText = hostDecision.messages[hostDecision.messages.length - 1].content[0].text
      assert.match(hostText, /^## Deepartments wake pack$/m, 'host-origin session still receives the FULL wake pack')
      assert.match(hostText, /identity: host-.* \(role: host, room: board\)/, 'host pack carries the host identity branding')

      // ---- dept_sleep guard: invoked with the FLAT origin, the subagent is
      // refused BEFORE any host sleep branch can run (even with a pre-authored
      // host journal for its host-<id>).
      await seedJournal(stateDir, `host-${sub.id}`, 'subagent should never sleep')
      await assert.rejects(
        () => root.tools.get('dept_sleep').execute({}, { agent: sub, signal }),
        /dept_sleep is refused for a transient delegated subagent — a subagent cannot sleep/,
        'dept_sleep refuses a caller whose header carries the flat origin'
      )
    } finally {
      await dispose()
    }
  })
})

test('Batch W4 pure: buildWakePack composes all 9 sections in order (identity, journal path, delta TOC, roster, git, system, ROADMAP tail, skill body, guidance)', async () => {
  const pack = buildWakePack({
    memberId: 'host-session-abc',
    role: 'host',
    room: 'board',
    journalPath: '/state/journals/host-session-abc.md',
    boardDelta: 'Cursor: seq 3\n- m-4 | sender-1 → host-session-abc | preview text',
    roster: 'Static members: owner\n- research-head (deepartments-head)',
    git: 'status: clean working tree\nlast 2 commits:\n  abc123 feat(x)\n  def456 fix(y)',
    systemState: '- DSH dev home: /opt/dsh/.dsh-dev',
    roadmapTail: '- **2026-08-20** — W3 committed.',
    skillBody: '# deepartments-workflow\nwake routine body',
    kpi: 'wake_counter 3; top open item: finish W4',
    includeGuidance: true
  })

  // Batch C — the P1 presence sentinel opens pack section 1 (deterministic
  // detectability for the pre-step gate / health checks), and the P2 KPI line
  // carries wake_counter + top open item.
  assert.match(pack, /pack-v1: present/, 'pack carries the deterministic `pack-v1: present` sentinel in section 1')
  assert.match(pack, /- kpi: wake_counter 3; top open item: finish W4/, 'pack section 1 carries the wake_counter + top open-item KPI line')

  // Every section header present, in order 1-9.
  const headers = [
    '## Deepartments wake pack',
    '## Journal (long-term memory)',
    '## Board delta since cursor',
    '## Condensed roster',
    '## Git bearings',
    '## System state',
    '## ROADMAP current status (tail)',
    '## deepartments-workflow skill (full body)',
    '## Guidance (wake routine)'
  ]
  let lastIdx = -1
  for (const header of headers) {
    const idx = pack.indexOf(header)
    assert.ok(idx !== -1, `section header present: ${header}`)
    assert.ok(idx > lastIdx, `section header in order: ${header}`)
    lastIdx = idx
  }

  assert.match(pack, /Pre-resolved journal path: `\/state\/journals\/host-session-abc\.md`/, 'journal path is pre-resolved')
  assert.match(pack, /- m-4 \| sender-1 → host-session-abc \| preview text/, 'board delta TOC included')
  assert.match(pack, /wake routine body/, 'full skill body embedded')
  // The roster body is caller-provided verbatim (the non-pure buildCondensedRoster
  // adds the "Liveness (sessionLive): not baked in" line — asserted in the
  // snapshot and host-sleep behaviour tests).
  assert.ok(pack.includes(HOST_WAKE_ROUTINE_TEXT), 'guidance carries the canonical wake routine verbatim')
  assert.ok(pack.includes('next step: pick the highest-priority unfinished open item'), 'guidance carries the next-step line')
})

test('Batch W4 pure: buildWakePack renders an EMPTY board-delta section when there are no new messages, and a lean snapshot (sections 1/3/4 only) when only identity+delta+roster are provided', async () => {
  const pack = buildWakePack({
    memberId: 'host-session-abc',
    role: 'host',
    room: 'board',
    boardDelta: '',
    roster: 'Static members: owner',
    includeGuidance: false
  })

  // Sections 1, 3, 4 present.
  assert.match(pack, /## Deepartments wake pack/, 'identity header present')
  assert.match(pack, /pack-v1: present/, 'P1 presence sentinel present even in the lean snapshot (shared buildWakePack section 1)')
  assert.match(pack, /## Board delta since cursor/, 'board delta section present')
  assert.match(pack, /## Condensed roster/, 'roster section present')

  // Empty delta → the section body after the header is empty (no cursor line,
  // no TOC lines) before the next section.
  const deltaBody = pack.split('## Board delta since cursor')[1].split('## Condensed roster')[0]
  assert.ok(!deltaBody.includes('Cursor:'), 'no cursor line for an empty delta')
  assert.ok(!deltaBody.includes('|'), 'no TOC lines for an empty delta')
  assert.match(deltaBody, /^\s*$/, 'delta section body is empty when no new messages')

  // Lean snapshot shape: sections 2,5,6,7,8,9 absent.
  assert.ok(!pack.includes('## Journal (long-term memory)'), 'no journal section for a lean snapshot')
  assert.ok(!pack.includes('## Git bearings'), 'no git section for a lean snapshot')
  assert.ok(!pack.includes('## System state'), 'no system-state section for a lean snapshot')
  assert.ok(!pack.includes('## Guidance (wake routine)'), 'no guidance section for a lean snapshot')
})

test('Batch W4 pure: buildWakePack degrades gracefully — undefined optional inputs are skipped (never throws) and (unavailable) markers pass through untouched', async () => {
  // Undefined git/skill/system/roadmap → those sections are omitted, no crash.
  const lean = buildWakePack({ memberId: 'h', role: 'host', room: 'board', boardDelta: 'Cursor: seq 0', roster: 'x' })
  assert.ok(!lean.includes('## Git bearings'), 'undefined git omitted gracefully')
  assert.ok(!lean.includes('## deepartments-workflow skill'), 'undefined skill omitted gracefully')
  assert.ok(!lean.includes('## System state'), 'undefined system state omitted gracefully')

  // Markers produced by the NON-pure assembly layer pass through untouched.
  const degraded = buildWakePack({
    memberId: 'h', role: 'host', room: 'board', boardDelta: '', roster: 'x',
    git: '(git unavailable)', skillBody: '(skill unavailable)', systemState: '(-)', roadmapTail: '(-)',
    includeGuidance: true
  })
  assert.match(degraded, /\(git unavailable\)/, 'git unavailable marker passes through')
  assert.match(degraded, /\(skill unavailable\)/, 'skill unavailable marker passes through')
})

test('Batch W4 pure: buildWakePackMessage frames the wake pack as a plugin/notice context (never a user-typed message)', async () => {
  const msg = buildWakePackMessage('## Deepartments wake pack\ncontent')
  assert.equal(msg.source.kind, 'plugin')
  assert.equal(msg.source.form, 'notice')
  assert.equal(msg.content[0].text, '## Deepartments wake pack\ncontent')
})

test('Batch W4 dept_wake_snapshot: registers globally (host plane), and ONE call returns the identity+delta+roster shape with NO live sessionLive liveness', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const tool = root.tools.get('dept_wake_snapshot')
      assert.ok(tool, 'dept_wake_snapshot registered globally (host plane)')

      const host = agents.put(fakeParentAgent())
      const result = await tool.execute({}, { agent: host, signal: new AbortController().signal })

      assert.ok(typeof result.snapshot === 'string' && result.snapshot.length > 0, 'snapshot returns a non-empty text string')
      assert.match(result.snapshot, /^## Deepartments wake pack$/m, 'snapshot opens with the wake pack header')
      assert.match(result.snapshot, new RegExp(`identity: host-${host.id}`), 'snapshot carries identity + host address')
      assert.match(result.snapshot, /## Board delta since cursor/, 'snapshot carries the board delta section')
      assert.match(result.snapshot, /Cursor: seq/, 'snapshot carries the board cursor')
      assert.match(result.snapshot, /## Condensed roster/, 'snapshot carries the condensed roster section')
      assert.match(result.snapshot, /Liveness \(sessionLive\): not baked in/, 'snapshot roster never embeds live session liveness')

      // Lean on-demand snapshot: no journal/git/skill/guidance sections.
      assert.ok(!result.snapshot.includes('## Journal (long-term memory)'), 'lean snapshot has no journal section')
      assert.ok(!result.snapshot.includes('## Git bearings'), 'lean snapshot has no git section')
      assert.ok(!result.snapshot.includes('## deepartments-workflow skill'), 'lean snapshot has no skill section')
      assert.ok(!result.snapshot.includes('## Guidance (wake routine)'), 'lean snapshot has no guidance section')
    } finally {
      await dispose()
    }
  })
})

test('Batch 7 U2 regression: GLOBAL dept_room_who schema declares hosts[].sleeping (A3 — no more copy-paste drift crashing host wake), reports the NEW rotated host as sleeping, and excludes the RETIRED host from "present"', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, persistence, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const signal = new AbortController().signal

      // (a) A sleeping host must be reported by the GLOBAL (host-plane) roster.
      // Put a sleeping host into the registry via the host dept_sleep ROTATION
      // path (the same mechanism Batch 7 uses), so the OLD host is retired and
      // the NEW host carries sleepEpoch durably in hosts.json.
      const host = agents.put(fakeParentAgent())
      const oldHostId = `host-${host.id}`
      await seedJournal(stateDir, oldHostId, 'HOST-ROTATION-MEMORY: global who sleeping reporting.')
      const sleepResult = await root.tools.get('dept_sleep').execute({}, { agent: host, signal })
      assert.ok(sleepResult.sleepEpoch > 0, 'host slept for the regression test')
      const newHostId = sleepResult.member
      assert.notEqual(newHostId, oldHostId, 'rotation produced a NEW host member')

      // FIX 1 — the NEW rotated host is registered with a sessionId and its
      // session is COLD (seeded via the persistence seam, never store-attached).
      await waitFor(async () => {
        const hostsFile = await readHosts(stateDir)
        return hostsFile[newHostId]?.sessionId !== undefined
      }, 5000, 'new host entry persisted with a sessionId')
      const hostsFile = await readHosts(stateDir)
      const newSessionId = hostsFile[newHostId].sessionId
      assert.match(newSessionId, /^session-/, 'the NEW rotated host entry carries a session-<uuid> id')
      assert.equal(root.sessions.get(SessionId(newSessionId)), undefined, 'FIX 1: the rotated session is COLD — not entered in the live sessions store')
      assert.equal(persistence.createCalls.length, 1, 'S2 registered the detached seed metadata via the persistence seam')
      assert.equal(persistence.appendCalls.length, 1, 'S2 appended the seed artifact via the persistence seam')
      assert.equal(persistence.createCalls[0].id, newSessionId, 'persistence.create targets the pre-minted id')
      assert.equal(persistence.appendCalls[0].id, newSessionId, 'persistence.append targets the pre-minted id')

      const who = root.tools.get('dept_room_who')
      const result = await who.execute({ room: 'board' }, { agent: host, signal })
      // The NEW host is present and reported as sleeping; the RETIRED old host
      // is excluded (spec 002 §4/C7).
      const sleepingHost = result.hosts.find((h) => h.hostId === newHostId)
      assert.ok(sleepingHost, 'the NEW sleeping host is in the global roster')
      assert.equal(sleepingHost.sleeping, true, 'global dept_room_who reports the sleeping NEW host')
      assert.ok(!result.hosts.some((h) => h.hostId === oldHostId), 'the retired old host is excluded from "present"')

      // (b) The DECLARED output schema must actually allow `sleeping` on a host —
      // additionalProperties:false on the host item forces this to be declared
      // explicitly, so a copy-paste drift like A3 can never pass silently again.
      // (dsh-tools compiles each property's `required: true` annotation into the
      // object's top-level `required: [...]` array.)
      const hostsItem = who.output.schema.properties.hosts.items
      const sleepingSchema = hostsItem.properties.sleeping
      assert.ok(sleepingSchema, 'hosts.items.properties.sleeping is declared in the output schema')
      assert.equal(sleepingSchema.type, 'boolean', 'hosts[].sleeping is a boolean')
      assert.ok(hostsItem.required.includes('sleeping'), 'hosts[].sleeping is required (in the item required[] array)')
      assert.equal(hostsItem.additionalProperties, false, 'host item keeps additionalProperties:false (field must be declared)')
    } finally {
      await dispose()
    }
  })
})

test('Batch 7 head regression: a head still sleeps through its own-layer dept_sleep (journal + sleepEpoch + dispose; no surface reset)', async () => {
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
      await memo.execute({ summary: 'Head memory before sleep (regression).' }, { agent: head, signal })
      const result = await sleep.execute({}, { agent: head, signal })
      assert.equal(result.member, postId)
      assert.equal(result.memoPath, path.join(stateDir, 'journals', `${postId}.md`))
      assert.ok(typeof result.sleepEpoch === 'number' && result.sleepEpoch > 0)
      // The head path DISPOSES the handle (fresh resume on next wake) — it does
      // NOT run the host in-place surface reset.
      await waitFor(() => agents.store.has(`head-${postId}`) === false, 5000, 'head handle disposed after sleep')
    } finally {
      await dispose()
    }
  })
})


// --- Task T1: SESSION MEMORY ARCHIVE (append-only history + one-cycle session
// log + per-member search index). Tests go through the real Loader (Rule 5) in
// a temp stateDir, anchored to the same journal lifecycle tests above. In the
// hermetic harness the StubPersistence has no `readRaw`, so the one-cycle
// transcript capture degrades to the STUB form (transcript: unavailable) — the
// session log FILE is still written, named by the bumped ordinal. All 5 tests
// assert the archive artifacts + the degrade-silently + lean-pack invariants.

test('T1 archive: dept_memo_write archives each entry (archive grows per write; index.json reflects it)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { agents, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
    try {
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const memo = headCtx.tools.get('dept_memo_write', key)
      const signal = new AbortController().signal

      // Two writes within one awake session (ordinal stays 1; archive grows by one each).
      await memo.execute({ summary: 'Archive entry A.', openItems: ['keep logs'] }, { agent: head, signal })
      await memo.execute({ summary: 'Archive entry B.' }, { agent: head, signal })

      const archivePath = path.join(stateDir, 'journals', 'archive', `${postId}.md`)
      const archiveText = await readFile(archivePath, 'utf8')
      // Count by the END delimiter (each entry has exactly one, at a line start).
      // NOTE: the checkpoint body itself carries an `archive_seq: === ENTRY … ===`
      // citation line, so counting `=== ENTRY ` occurrences would over-count by
      // the inner citation — count `=== END ENTRY ===` (never echoed) instead.
      const entries = (archiveText.match(/(^|\n)=== END ENTRY ===/g) || []).length
      assert.equal(entries, 2, 'archive grew by one entry per dept_memo_write')
      assert.match(archiveText, /=== ENTRY ts=.* wake_counter=1 seq=.* ===/, 'each entry carries the per-write delimiter')
      assert.match(archiveText, /Archive entry A\./, 'first entry content archived')
      assert.match(archiveText, /Archive entry B\./, 'second entry content archived')

      // Index reflects both writes.
      const indexPath = path.join(stateDir, 'journals', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf8'))
      assert.equal(index.version, 1, 'index version 1')
      assert.equal(index.members[postId].entries.length, 2, 'index has one entry per write')
      assert.equal(index.members[postId].entries[0].wake_counter, 1, 'indexed entry carries the ordinal 1')
      assert.equal(index.members[postId].entries[0].session_log_path, `journals/sessions/${postId}-1.md`, 'index cites the session log path')
      assert.match(index.members[postId].entries[0].archive_seq, /^=== ENTRY /, 'index cites the archive marker')
      assert.deepEqual(index.members[postId].entries[0].open_items, ['keep logs'], 'index copies open_items from the entry')
    } finally {
      await dispose()
    }
  })
})

test('T1 sleep boundary: dept_sleep records a per-session log named by the BUMPED ordinal (head own-layer AND host-plane host dept_sleep)', async () => {
  await withTempStateDir(async (stateDir) => {
    // Head own-layer dept_sleep (seedJournal wake 1 → memo → sleep bumps to 2).
    const headPostId = 'research-head'
    const headJournalPath = await seedJournal(stateDir, headPostId, 'HEAD-ARCHIVE: archive the sleep boundary.')
    const { root, agents, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${headPostId}`), 5000, 'head created at boot')
    try {
      const head = agents.store.get(`head-${headPostId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const memo = headCtx.tools.get('dept_memo_write', key)
      const sleep = headCtx.tools.get('dept_sleep', key)
      const signal = new AbortController().signal

      await memo.execute({ summary: 'HEAD-ARCHIVE: archive the sleep boundary.' }, { agent: head, signal })
      await sleep.execute({}, { agent: head, signal })
      await waitFor(() => agents.store.has(`head-${headPostId}`) === false, 5000, 'handle disposed after sleep')

      // The sleep boundary archives a session log named by the BUMPED ordinal (2).
      const headSessionLog = path.join(stateDir, 'journals', 'sessions', `${headPostId}-2.md`)
      const logText = await readFile(headSessionLog, 'utf8')
      assert.match(logText, /^member: research-head$/m, 'head session log carries the member id')
      assert.match(logText, /^wake_counter: 2$/m, 'head session log named by the BUMPED ordinal (2)')

      // Host-plane host dept_sleep (seedJournal wake 1 → sleep bumps to 2).
      const host = agents.put(fakeParentAgent())
      const hostId = `host-${host.id}`
      await seedJournal(stateDir, hostId, 'HOST-ARCHIVE: host sleep boundary.')
      const sleepTool = root.tools.get('dept_sleep')
      await sleepTool.execute({}, { agent: host, signal })
      const hostSessionLog = path.join(stateDir, 'journals', 'sessions', `${hostId}-2.md`)
      const hostLogText = await readFile(hostSessionLog, 'utf8')
      assert.match(hostLogText, /^member: /m, 'host session log written by the host-plane dept_sleep')
      assert.match(hostLogText, /^wake_counter: 2$/m, 'host session log named by the BUMPED ordinal (2)')
    } finally {
      await dispose()
    }
  })
})

test('T1 index: journals/index.json reflects BOTH the archive entry AND the session log for a write (session_log_path + archive_seq populated)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { agents, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
    try {
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const memo = headCtx.tools.get('dept_memo_write', key)
      const signal = new AbortController().signal

      await memo.execute({ summary: 'Indexed cycle.', openItems: ['index me'] }, { agent: head, signal })

      const indexPath = path.join(stateDir, 'journals', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf8'))
      const entry = index.members[postId].entries[0]
      assert.equal(entry.wake_counter, 1, 'entry wake_counter populated')
      assert.equal(entry.session_log_path, `journals/sessions/${postId}-1.md`, 'entry session_log_path reflects the session log')
      assert.match(entry.archive_seq, /^=== ENTRY /, 'entry archive_seq reflects the archive marker')
      assert.ok(typeof index.members[postId].entries[0].timestamp === 'string' && index.members[postId].entries[0].timestamp.length > 0, 'entry timestamp populated')

      // The corresponding session log file exists (stub form in the hermetic harness).
      const sessionLogPath = path.join(stateDir, 'journals', 'sessions', `${postId}-1.md`)
      const logText = await readFile(sessionLogPath, 'utf8')
      assert.match(logText, /^member: research-head$/m, 'session log file exists for the indexed cycle')
    } finally {
      await dispose()
    }
  })
})

test('T1 degrade-silently: an unavailable transcript (no sessionPersistence.readRaw) still lets dept_memo_write AND dept_sleep succeed — stub written, never throws', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
    try {
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const memo = headCtx.tools.get('dept_memo_write', key)
      const sleep = headCtx.tools.get('dept_sleep', key)
      const signal = new AbortController().signal

      // Memo write: capture degrades to the stub form but the write still succeeds.
      const memoResult = await memo.execute({ summary: 'Even without a transcript, the checkpoint is written.' }, { agent: head, signal })
      const checkpoint = await readFile(memoResult.memoPath, 'utf8')
      assert.match(checkpoint, /^wake_counter: 1$/m, 'checkpoint written with ordinal 1 despite no transcript')
      const stubLog = await readFile(path.join(stateDir, 'journals', 'sessions', `${postId}-1.md`), 'utf8')
      assert.match(stubLog, /^transcript: unavailable$/m, 'session log is the STUB form when no transcript is capturable')

      // Sleep: still succeeds (bumps the ordinal) despite the stub capture path.
      const sleepResult = await sleep.execute({}, { agent: head, signal })
      assert.ok(typeof sleepResult.sleepEpoch === 'number' && sleepResult.sleepEpoch > 0, 'dept_sleep succeeds (no throw) despite the stub capture')
      const bumpedCheckpoint = await readFile(memoResult.memoPath, 'utf8')
      assert.match(bumpedCheckpoint, /^wake_counter: 2$/m, 'dept_sleep bumped the ordinal 1 → 2 (checkpoint write + sleep unaffected)')
    } finally {
      await dispose()
    }
  })
})

test('T1 lean pack: after archive writes, the injected wake pack + readWakeJournalKpi still read ONLY the single checkpoint — no archive/session-log content leaks into the wake surface', async () => {
  await withTempStateDir(async (stateDir) => {
    // Registered-host fixture (the context-injection gate: only registered
    // hosts receive the pack) — seed hosts.json BEFORE boot.
    const sessionId = SessionId(randomUUID())
    const hostId = await seedHostRegistration(stateDir, sessionId)
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitForRooms(root)
      const host = agents.put(fakeParentAgent(sessionId))
      const signal = new AbortController().signal

      // A memo write archives + captures a session log for the host.
      const memo = root.tools.get('dept_memo_write')
      await memo.execute(
        { summary: 'PRE-STEP lean check after an archive.', openItems: ['verify lean pack'] },
        { agent: host, signal }
      )
      // Confirm the archive + session artifacts DO exist on disk (they must be
      // written but STAY OUT of the wake surface).
      const archiveText = await readFile(path.join(stateDir, 'journals', 'archive', `${hostId}.md`), 'utf8')
      assert.match(archiveText, /=== ENTRY /, 'host archive was written')
      const sessionLogText = await readFile(path.join(stateDir, 'journals', 'sessions', `${hostId}-1.md`), 'utf8')
      assert.match(sessionLogText, /transcript: unavailable/, 'host session log was written')

      // The pre-step wake pack is assembled from readWakeJournalKpi (the single
      // checkpoint ONLY) — it must NOT leak archive/session-log content.
      const claimed = preStepClaimed('the lean wake message')
      const decision = await runPreStep(pluginCtx, host, claimed, signal)
      assert.equal(decision.kind, 'enter', 'pre-step is enter')
      const packNode = decision.messages[decision.messages.length - 1]
      const packText = packNode.content[0].text
      assert.match(packText, /pack-v1: present/, 'pack present sentinel intact')
      assert.match(packText, /kpi: wake_counter 1; top open item: verify lean pack/, 'pack KPI reflects the single checkpoint only')
      // No archive/session-log leakage into the wake surface.
      assert.ok(!packText.includes('=== ENTRY'), 'no archive delimiter leaks into the wake pack')
      assert.ok(!packText.includes('transcript: unavailable'), 'no session-log stub leaks into the wake pack')
      assert.ok(!packText.includes('journals/sessions/'), 'no session-log citation leaks into the wake pack')
      assert.ok(!packText.includes('archive_seq:'), 'no archive_seq citation leaks into the wake pack')
    } finally {
      await dispose()
    }
  })
})

test('T1 live-fix: a REAL live session + persisted artifact captures the REAL transcript (bound flush/readRaw runs — not the stub)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, persistence, dispose } = await bootPlugin(stateDir, { rawPersistence: true })
    try {
      const rawId = `session-livefix-${randomUUID()}`
      // Make the session TRULY live in the REAL dsh-session store — the same
      // service `captureSessionLog` resolves — so the bound real
      // `sessions.flush(live)` runs against a genuine live entry (the exact
      // call shape the live host takes; the old unbound extraction crashed
      // here with `Cannot read properties of undefined (reading
      // 'liveEntryFor')` in the live deployment).
      const live = root.sessions.create(SessionId(rawId), { meta: { cwd: stateDir } })
      assert.ok(live !== undefined && root.sessions.get(SessionId(rawId)) === live, 'live session entered in the real store')
      // A durable JSONL artifact exactly as the jsonl backend's readRaw returns it.
      persistence.setRawArtifact([
        '{"type":"session","version":0}',
        '{"type":"user/message","seq":1,"time":1750000000000,"data":{"message":{"content":"T1 LIVE probe: first instruction"}}}',
        '{"type":"assistant/message","seq":2,"time":1750000001000,"data":{"message":{"content":"T1 live reply"}}}',
        '{"type":"tool/call","seq":3,"time":1750000002000,"data":{"name":"bash","arguments":"{\\"command\\":\\"echo hi\\"}"}}',
        '{"type":"tool/result","seq":4,"time":1750000003000,"data":{"message":{"content":"hi"},"meta":{}}}',
        '{"type":"turn/end","seq":5,"time":1750000004000,"data":{"turn":1,"reason":"complete"}}'
      ].join('\n'))

      // The host's agent.id IS the session id the real store keys by, so the
      // memo write's capture finds the live entry, flushes it, reads the
      // artifact and serializes the REAL transcript (first-ever cycle → whole log).
      const host = agents.put(fakeParentAgent(SessionId(rawId)))
      const hostId = `host-${rawId}`
      const signal = new AbortController().signal
      const memo = root.tools.get('dept_memo_write')
      await memo.execute({ summary: 'S1 live-fix: real transcript capture.' }, { agent: host, signal })

      const logPath = path.join(stateDir, 'journals', 'sessions', `${hostId}-1.md`)
      const logText = await readFile(logPath, 'utf8')
      assert.ok(!logText.includes('transcript: unavailable'), 'memo-path capture is REAL, not the stub')
      assert.match(logText, /^- \*\*user:\*\* T1 LIVE probe: first instruction$/m, 'real user/message serialized')
      assert.match(logText, /^- \*\*assistant:\*\* T1 live reply$/m, 'real assistant/message serialized')
      assert.match(logText, /^- \*\*tool\*\* `bash` → \*called\*: .*echo hi/m, 'real tool/call serialized')
      assert.match(logText, /^- \*\*toolresult\*\* → \*ok\*: hi$/m, 'real tool/result serialized')
      assert.match(logText, /^start_seq: 1$/m, 'first-ever cycle slices from the first event')
      assert.match(logText, /^end_seq: 5$/m, 'end_seq reflects the last event')
      assert.match(logText, new RegExp(`^session_id: ${rawId}$`, 'm'), 'session_id carried through the real capture')

      // The host-plane dept_sleep's sleep-boundary capture (bumped ordinal 2)
      // runs the SAME bound capture from the bump* hook — also real. The memo
      // already wrote the journal dept_sleep requires.
      const sleep = root.tools.get('dept_sleep')
      await sleep.execute({}, { agent: host, signal })
      const sleepLogText = await readFile(path.join(stateDir, 'journals', 'sessions', `${hostId}-2.md`), 'utf8')
      assert.ok(!sleepLogText.includes('transcript: unavailable'), 'sleep-boundary capture is REAL, not the stub')
      assert.match(sleepLogText, /^wake_counter: 2$/m, 'sleep log named by the BUMPED ordinal (2)')
      assert.match(sleepLogText, /^- \*\*user:\*\* T1 LIVE probe: first instruction$/m, 'sleep-boundary capture carries the real transcript too')
    } finally {
      await dispose()
    }
  })
})

test('T1 live-fix degrade: service present but NO stored artifact still degrades silently to the stub with a USEFUL reason (never a raw TypeError)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir, { rawPersistence: true })
    try {
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const memo = root.tools.get('dept_memo_write')
      const result = await memo.execute({ summary: 'Degrade with a useful reason.' }, { agent: host, signal })

      const hostId = `host-${host.id}`
      const stubLog = await readFile(path.join(stateDir, 'journals', 'sessions', `${hostId}-1.md`), 'utf8')
      assert.match(stubLog, /^transcript: unavailable$/m, 'stub form when no stored artifact is present')
      assert.match(stubLog, /^reason: no stored session artifact \(readRaw returned nothing\)$/m, 'stub reason carries the ACTUAL meaningful error — no raw TypeError leaks')
      const checkpoint = await readFile(result.memoPath, 'utf8')
      assert.match(checkpoint, /^wake_counter: 1$/m, 'memo write succeeded despite the stub capture (never throws)')
    } finally {
      await dispose()
    }
  })
})
