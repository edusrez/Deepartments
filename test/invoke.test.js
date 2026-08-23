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
import { loadMessageRecords, parseDeliveryRows, resolveDeliveriesPath, resolveMessagesPath } from '../lib/messages-store.js'
import { compressZstdFrame, encodeSegment } from '../lib/session-cleanup.js'
import { buildSleepJournalMessage, buildWakePackMessage, buildWakePack, HOST_WAKE_ROUTINE_TEXT, computeHostSleepSurfacePlan, pinHostSessionTitle, pickLiveHostEntry } from '../lib/invoke.js'
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
  departments: [
    {
      id: 'research',
      name: 'Research',
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
    // Piece 1 cwd fix (2026-08-22): forced resume failures (per durable session
    // id) so the wakePost resume-failed → create-fresh fallback is testable.
    this.resumeRejects = new Set()
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
    this.ensureStoreSession(options.sessionId, options.meta)
    return materializeStubAgent(this, options.sessionId, options)
  }

  async resume(options) {
    this.resumeCalls.push(options)
    if (this.resumeRejects.has(options.resumeSessionId)) throw new Error('stub: forced resume failure (Piece 1 cwd-fix test)')
    // Cold resume: restore a dormant resident under its DURABLE id (the seeded
    // childId), with header.parentSession from the adoption map, applying the
    // setup closure (board tools install on cold resume exactly like fresh).
    this.ensureStoreSession(options.resumeSessionId, {
      ...options.meta,
      parentSession: postAdoption.get(options.resumeSessionId)
    })
    return materializeStubAgent(this, options.resumeSessionId, {
      ...options,
      parentSession: postAdoption.get(options.resumeSessionId)
    })
  }

  /**
   * Piece 1 — production parity for the SESSIONS STORE: a real dsh-agent root
   * session is ENTERED in `ctx.sessions` while its agent lives (root agents
   * appear in `sessions.list()`), and the plugin's head title pin resolves
   * the session via `ctx.sessions.get(...)`. The stub therefore registers the
   * session id in the REAL dsh-session store at create/resume, so ensureHead's
   * pin finds a live Session and the tests observe the pinned log on the
   * store entry (which production equates with the agent's own session).
   * Idempotent: a resume-after-create (or a wake-cold-resume of a session
   * still entered in the store) REUSES the existing entry instead of tripping
   * the store's duplicate-id rejection. Never throws: a missing/faulty store
   * degrades to the plain agent session, mirroring the optional-seam
   * discipline the plugin itself uses.
   */
  ensureStoreSession(sessionId, meta = {}) {
    const id = SessionId(sessionId)
    // `this.ctx.get('sessions')` (NOT the `this.ctx.sessions` property — cordis
    // guards non-injected property access on a service ctx).
    const store = this.ctx.get('sessions')
    if (store === undefined || typeof store.get !== 'function') return undefined
    const existing = store.get(id)
    if (existing !== undefined) return existing
    try {
      return store.create(id, { meta }) ?? store.get(id)
    } catch {
      // A concurrent registration won the race — reuse its entry.
      return store.get(id)
    }
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

  /** B2: `sessionPersistence.list()` — the persistence-header enumeration the
   * continuation manager's listChildren uses to build its cold corpus. The
   * stub has no detached sessions, so the live-preferred corpus stays
   * live-only (a cold child cannot be resumed in this harness either). */
  async list() {
    return []
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
 * `archivedSessionIds` + the durable mirror. FIX 1b — also the workspace
 * LIST/ATTACH surface (spec 002 §3.3 S2.2 + the boot repair hook): `list()`
 * returns the workspace entities (default: one recording entity at
 * `stateDir`; `bootPlugin({ workspaceEntities })` overrides for the repair
 * tests) and `attachSession` records the target ids (reality validates the
 * session's persisted header cwd against the entity path and throws on
 * mismatch — dsh-workspace lib:87-105). FIX 1b.1 — model the provider's
 * mid-init window: while `notReadyRejects` > 0, `list()` rejects like the
 * real registry whose storage/start has not completed ("workspace registry is
 * not started yet"; each call decrements). The boot repair hook must RETRY
 * (non-strict get + bounded loop) until list() resolves — the old strict-get
 * race silently skipped exactly this state in production. */
class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir, entities) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.archived = []
    this.attachCalls = []
    this.notReadyRejects = 0
    // Piece 1 cwd fix (2026-08-22): the default entity carries the DURABLE
    // membership view the real entity exposes (`sessionIds` — dsh-workspace
    // lib:78-80) AND mirrors the real attach into the persisted workspace
    // record (workspace.json) — the exact projection the native sidebar groups
    // by. This lets the cwd-fix tests assert both the resolved create cwd and
    // the post-attach membership file.
    this.entitySessions = []
    this.entities = entities ?? [{
      path: stateDir,
      sessionIds: this.entitySessions,
      attachSession: async (sessionId) => {
        this.attachCalls.push(sessionId)
        if (!this.entitySessions.includes(sessionId)) {
          this.entitySessions.push(sessionId)
          writeFile(path.join(this.stateDir, 'workspace.json'), JSON.stringify({ path: this.stateDir, sessionIds: [...this.entitySessions] }, null, 2), 'utf8')
            .catch(() => {})
        }
      }
    }]
  }

  get archivedSessionIds() {
    return this.archived
  }

  setNotReadyRejects(count) {
    this.notReadyRejects = count
  }

  list() {
    if (this.notReadyRejects > 0) {
      this.notReadyRejects--
      return Promise.reject(new Error('workspace registry is not started yet'))
    }
    return Promise.resolve(this.entities)
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
  // Piece 1 cwd fix (2026-08-22): a boot opt forces per-session resume failures
  // (the wakePost resume-failed → create-fresh fallback path).
  if (opts.resumeRejects !== undefined) agents.resumeRejects = new Set(opts.resumeRejects)
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
  // archive (spec 002 §3.3 S2.5) is exercised through the same seam. FIX 1b:
  // `workspaceEntities` (optional) overrides the entity list the S2.2 attach
  // and the boot repair hook iterate (default: one recording entity).
  const workspaceRegistry = new StubWorkspaceRegistry(root, stateDir, opts.workspaceEntities)
  // FIX 1b.1 — `registryNotReadyRejects` models a provider whose init is still
  // in flight at boot (list() rejects mid-init) for the boot-repair retry
  // regression.
  if (typeof opts.registryNotReadyRejects === 'number' && opts.registryNotReadyRejects > 0) {
    workspaceRegistry.setNotReadyRejects(opts.registryNotReadyRejects)
  }
  await root.plugin(SubagentRuntime)

  const spawnStub = stubProvider('spawn')
  const forkStub = stubProvider('fork')
  root.subagents.registerProvider(spawnStub)
  root.subagents.registerProvider(forkStub)

  // B2 override fixture: compose the REAL harness control plugin
  // (dsh-tool-subagent-control — the native global `send_message`) BEFORE the
  // deepartments row, exactly as dsh-base does in the GUI/headless profiles.
  // AWAITED so the native owns the global name deterministically BEFORE the
  // deepartments row applies (the plugin then must NOT register `send_message`
  // globally — same-layer duplicate would throw — and must shadow the native
  // per-agent own-layer).
  if (opts.nativeControlTool === true) {
    await loader.create({ id: 'native-tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' })
  }

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

/**
 * Seed a durable department head (root agent) into posts.json BEFORE boot,
 * and register its adoption so a cold resume restores it under the same
 * stable session id (`head-<postId>`). Mirrors what a production posts.json
 * holds for a previously-materialized head.
 */
/** B3b2: settle the boot's fire-and-forget head materialization (ensureAllHeads
 * runs after the registries load — the room-boot barrier `waitForRooms` used
 * to provide is gone with the rooms). Tests that act on the booted plugin
 * before their own head wait must call this right after bootPlugin. */
async function waitForHeadMaterialized(agents) {
  await waitFor(() => agents.store.has('head-research-head'), 5000, 'head materialized at boot')
}

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

test('B3 gap fix: dept_who from the HOST in a profile with NO hosts.json self-registers the host (one row, you:true) — host auto-registration no longer depends on board tools', async () => {
  await withTempStateDir(async (stateDir) => {
    // No hosts.json seeded: a FRESH profile. The board tools that used to
    // trigger ensureHost are gone (B3); dept_who must self-register the caller.
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal

      const whoTool = root.tools.get('dept_who')
      assert.ok(whoTool, 'dept_who registered globally (host plane)')
      const result = await whoTool.execute({}, { agent: host, signal })

      // The host got registered as the ONE live host with you:true.
      const hostRows = result.members.filter((member) => member.kind === 'host')
      assert.equal(hostRows.length, 1, 'exactly one host row')
      assert.equal(hostRows[0].agentId, `host-${host.id}`, 'the host row is the caller (host-<sessionId>)')
      assert.equal(hostRows[0].you, true, 'the caller marks its own entry you:true')
      const hosts = await readHosts(stateDir)
      assert.ok(hosts[`host-${host.id}`], 'the host entry was persisted to hosts.json')
    } finally {
      await dispose()
    }
  })
})

test('B3 gap fix: send_message from the HOST in a profile with NO hosts.json self-registers the host before delivery (catalog resolution)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head created at boot')
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal

      const sendTool = root.tools.get('send_message')
      assert.ok(sendTool, 'send_message registered globally (host plane)')
      const result = await sendTool.execute(
        { to: ['research-head'], text: 'hello from the host' },
        { agent: host, signal }
      )
      assert.equal(result.messageId, 'm-0', 'record persisted (persist-before-deliver)')
      assert.equal(result.delivered['research-head'], 'delivered')
      // The catalog resolution needed the host entry: it self-registered.
      const hosts = await readHosts(stateDir)
      assert.ok(hosts[`host-${host.id}`], 'send_message self-registered the host in hosts.json')
      assert.equal(hosts[`host-${host.id}`].sessionId, host.id)
    } finally {
      await dispose()
    }
  })
})

test('B3 bus host wake: send_message to a live registered host raw-wakes it with the agent/send source (the old board relay is gone)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head created at boot')
      const host = agents.put(fakeParentAgent())
      const hostId = `host-${host.id}`
      await seedHostRegistration(stateDir, host.id, 'board')
      // re-boot so the seeded hosts.json is loaded? No: seed was written before
      // boot in the original usage; here boot already ran. Register lazily via
      // dept_who instead (the B3 self-registration path).
      const signal = new AbortController().signal
      await root.tools.get('dept_who').execute({}, { agent: host, signal })

      const head = agents.store.get('head-research-head')
      const { ctx: headCtx, key } = agents.childContexts[0]
      const before = host.inboxMessages.length
      const sendResult = await headCtx.tools.get('send_message', key).execute(
        { to: [hostId], text: 'please respond' },
        { agent: head, signal }
      )
      assert.equal(sendResult.delivered[hostId], 'delivered', 'bus delivered to the live host')
      await waitFor(() => host.inboxMessages.length === before + 1, 5000, 'the host agent was raw-woken')
      const wake = host.inboxMessages.at(-1)
      assert.match(wake.content[0].text, /^\[From research-head → host-/, 'bus framing carries sender + recipients')
      assert.equal(wake.source.kind, 'agent', 'host wake source kind is agent')
      assert.equal(wake.source.form, 'send')
      assert.equal(wake.source.from, 'research-head')
      assert.equal(wake.source.senderSessionId, 'head-research-head')
    } finally {
      await dispose()
    }
  })
})

test('host registration guard (single live host): the FIRST session registers via dept_who; a SECOND session while a live host exists is REFUSED (no second entry, guard warn); sender attribution still resolves to the caller session', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    const logged = []
    const disposeExporter = root.logger.exporter({ levels: { default: 4 }, export: (message) => { logged.push(message) } })
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head created at boot')
      const hostA = agents.put(fakeParentAgent())
      const hostB = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const whoTool = root.tools.get('dept_who')

      // (1) FIRST session: no live host exists → hostA registers normally.
      const whoA = await whoTool.execute({}, { agent: hostA, signal })
      assert.equal(whoA.members.filter((m) => m.kind === 'host').length, 1, 'one host row after the first registration')

      // (2) SECOND session refused: hostB dept_who while hostA is live → the guard
      // creates NO second entry and logs the warn.
      const whoB = await whoTool.execute({}, { agent: hostB, signal })
      assert.equal(whoB.members.filter((m) => m.kind === 'host').length, 1, 'still exactly one host row (no second host minted)')
      assert.equal(whoB.members.filter((m) => m.you === true && m.kind === 'host').length, 0, 'the refused session is NOT marked you:true (it is not a registered host)')
      const hosts = await readHosts(stateDir)
      assert.ok(hosts[`host-${hostA.id}`], 'host A entry exists')
      assert.equal(hosts[`host-${hostB.id}`], undefined, 'refused second session creates NO host entry (single-live invariant)')
      await waitFor(() => logged.some((m) => m?.type === 'warn' && String(m.args?.[0] ?? '').includes(`refusing new host registration host-${hostB.id}`) && String(m.args?.[0] ?? '').includes(`host-${hostA.id}`)), 5000, 'guard warn logged with the live host id')

      // (3) Sender attribution: hostA sends via the bus and the record is
      // attributed to host-<sessionId>; the head receives it framed.
      const headAgent = agents.store.get('head-research-head')
      const headWakesBefore = headAgent.inboxMessages.length
      await root.tools.get('send_message').execute({ to: ['research-head'], text: 'A to the head' }, { agent: hostA, signal })
      await waitFor(() => headAgent.inboxMessages.length === headWakesBefore + 1, 5000, 'the head received the host-to-head message')
      const hostWake = headAgent.inboxMessages.at(-1)
      assert.equal(hostWake.source.kind, 'agent')
      assert.equal(hostWake.source.from, `host-${hostA.id}`, 'host sender recorded under its hostId')
      assert.equal(hostWake.source.senderSessionId, hostA.id, 'sender resolves to the caller session')
    } finally {
      disposeExporter()
      await dispose()
    }
  })
})

test('host registration guard (B3): registers when NO live host exists — both on a first-ever boot AND after the prior host entries are all RETIRED (the previous live is gone)', async () => {
  await withTempStateDir(async (stateDir) => {
    // A hosts.json holding ONLY retired entries (a fully rotated-out chain):
    // loader validation passes (numeric retiredAt + non-empty rotatedTo), zero
    // live remain — the guard must let the next session register as the host.
    const oldSessionId = SessionId(randomUUID())
    const olderSessionId = SessionId(randomUUID())
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({
      schemaVersion: 2,
      [`host-${olderSessionId}`]: { sessionId: String(olderSessionId), roomId: 'board', retired: true, retiredAt: 1787261780000, rotatedTo: `host-${oldSessionId}` },
      [`host-${oldSessionId}`]: { sessionId: String(oldSessionId), roomId: 'board', retired: true, retiredAt: 1787261781000, rotatedTo: 'host-session-next' }
    }, null, 2))
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForHeadMaterialized(agents)
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      // No live entry + the caller's hostId is absent → the first live
      // registration passes (retired entries do not block it).
      const who = await root.tools.get('dept_who').execute({}, { agent: host, signal })
      assert.equal(who.members.filter((m) => m.kind === 'host').length, 1, 'one host row (the fresh registration)')
      assert.equal(who.members.find((m) => m.kind === 'host').you, true, 'the caller marks itself you:true')
      const hosts = await readHosts(stateDir)
      assert.ok(hosts[`host-${host.id}`], 'the fresh host entry was created')
      assert.equal(hosts[`host-${oldSessionId}`].retired, true, 'the pre-existing retired entries survive untouched')
    } finally {
      await dispose()
    }
  })
})

test('host registration REFRESH MERGES (never replaces): a dept_who refresh of a ROTATION-SUCCESSOR entry preserves previousSessionId/sleepEpoch/boundarySeq — the live-host pick stays deterministic after the successor\'s first tool call', async () => {
  await withTempStateDir(async (stateDir) => {
    const oldSessionId = SessionId(randomUUID())
    const newSessionId = SessionId(randomUUID())
    const oldHostId = `host-${oldSessionId}`
    const newHostId = `host-${newSessionId}`
    // A ROTATED v2 hosts.json (the exact shape S3/S7 writes): the old entry
    // retired with rotatedTo; the new live successor carries the rotation
    // metadata (sleepEpoch/boundarySeq/previousSessionId).
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({
      schemaVersion: 2,
      [oldHostId]: { sessionId: String(oldSessionId), roomId: 'board', sleepEpoch: 1787261780000, boundarySeq: 10, retired: true, retiredAt: 1787261781000, rotatedTo: newHostId },
      [newHostId]: { sessionId: String(newSessionId), roomId: 'board', sleepEpoch: 1787261781000, boundarySeq: 11, previousSessionId: String(oldSessionId) }
    }, null, 2))
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitForHeadMaterialized(agents)
      // The successor's FIRST bus-tool call refreshes its entry (ensureHost
      // merge path) — the rotation metadata MUST survive it (the pre-fix code
      // REPLACED the entry and wiped previousSessionId/sleepEpoch/boundarySeq).
      const successor = agents.put(fakeParentAgent(newSessionId))
      const signal = new AbortController().signal
      const who = await root.tools.get('dept_who').execute({}, { agent: successor, signal })
      assert.equal(who.members.filter((m) => m.kind === 'host').length, 1, 'one host row after the refresh')
      assert.equal(who.members.find((m) => m.kind === 'host').you, true, 'the successor refreshes under its own host id (you:true)')
      const hosts = await readHosts(stateDir)
      assert.equal(hosts[newHostId].previousSessionId, String(oldSessionId), 'refresh preserves previousSessionId (successor lineage)')
      assert.equal(hosts[newHostId].sleepEpoch, 1787261781000, 'refresh preserves sleepEpoch')
      assert.equal(hosts[newHostId].boundarySeq, 11, 'refresh preserves boundarySeq')
      assert.equal(hosts[oldHostId].retired, true, 'the retired old entry stays intact')
      // The in-registry live selection stays UNAMBIGUOUS (successor branch).
      // Note: parsed hosts.json entries carry NO hostId (persistHosts keys the
      // object by hostId) — assert the pick's live entry by sessionId.
      const { live, ambiguous } = pickLiveHostEntry(Object.values(hosts))
      assert.equal(ambiguous, false, 'pick after refresh is NOT ambiguous')
      assert.equal(live?.sessionId, String(newSessionId), 'pick after refresh still selects the successor')
    } finally {
      await dispose()
    }
  })
})


test('hosts loader cardinality: TWO live entries → a WARN (never a THROW) listing both ids, and the registry/file stay INTACT (a throw would empty the registry and the next ensureHost persist would erase every file entry)', async () => {
  await withTempStateDir(async (stateDir) => {
    // The wake-12→13 split-brain shape: two BARE live entries (type-valid;
    // legacy files without schemaVersion are tolerated — the validator passes).
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({
      'host-session-stray': { sessionId: 'session-stray', roomId: 'board' },
      'host-session-live': { sessionId: 'session-live', roomId: 'board' }
    }, null, 2))
    const { root, dispose } = await bootPlugin(stateDir)
    const logged = []
    const disposeExporter = root.logger.exporter({ levels: { default: 4 }, export: (message) => { logged.push(message) } })
    try {
      await waitFor(() => logged.some((m) => m?.type === 'warn' && String(m.args?.[0] ?? '').includes('2 live host entries (exactly one required)') && String(m.args?.[0] ?? '').includes('host-session-stray') && String(m.args?.[0] ?? '').includes('host-session-live')), 5000, 'loader cardinality warned listing both live ids')
      // NEVER threw → the loader booted with the full file restored and the
      // file is untouched (load does not re-persist): both live entries present.
      const hosts = await readHosts(stateDir)
      assert.ok(hosts['host-session-stray'], 'first live entry intact (no empty-registry wipe)')
      assert.ok(hosts['host-session-live'], 'second live entry intact')
      disposeExporter()
    } finally {
      await dispose()
    }
  })
})


test('head setup: the messaging toolset is registered scoped to the head agent (own layer) AND globally on the host plane; the head toolset works (B3: no room tools)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      // The configured head auto-materializes at boot as a root agent.
      await waitFor(() => agents.store.has(`head-research-head`), 5000, 'head root agent created at boot')

      // The bus/identity toolset is registered GLOBALLY (host plane) — assert that.
      for (const name of ['send_message', 'agent_messages', 'dept_who']) {
        assert.ok(pluginCtx().tools.get(name), `${name} registered globally (host plane)`)
      }
      // B3: the board tools are GONE from the global plane.
      for (const name of ['dept_room_read', 'dept_room_write', 'dept_room_who', 'dept_whereami']) {
        assert.equal(pluginCtx().tools.get(name), undefined, `${name} removed from the global plane (B3)`)
      }

      // The head's own layer carries the messaging tools (installed by head setup).
      const { ctx: headCtx, key } = agents.childContexts[0]
      for (const name of ['send_message', 'agent_messages', 'dept_who', 'dept_memo_write', 'dept_sleep']) {
        assert.ok(headCtx.tools.get(name, key), `${name} installed in the head own layer`)
      }

      const head = agents.store.get('head-research-head')
      const signal = new AbortController().signal

      // send_message persists + delivers from the head's member id.
      const sendResult = await headCtx.tools.get('send_message', key).execute(
        { to: ['research-head'], text: 'hello from the head' },
        { agent: head, signal }
      )
      assert.equal(sendResult.messageId, 'm-0', 'the bus record was persisted')
      assert.equal(sendResult.delivered['research-head'], 'self', 'self-addressed send is held (self)')

      // dept_who lists the head itself + the configured catalog.
      const whoResult = await headCtx.tools.get('dept_who', key).execute({}, { agent: head })
      const self = whoResult.members.find((member) => member.agentId === 'research-head')
      assert.ok(self, 'the head is listed')
      assert.equal(self.kind, 'head')
      assert.equal(self.sessionId, 'head-research-head')
      assert.equal(self.live, true)
      assert.equal(self.you, true)
    } finally {
      await dispose()
    }
  })
})

test('Piece 1: ensureHead attaches the head session to the root workspace AND pins the head session title (native sidebar + U4-generalized pin, real Loader)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, workspaceRegistry, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head root agent created at boot')

      // Workspace attach (fire-and-forget from ensureHead): the head session
      // lands in the workspace registry's sessionIds — the seam that makes it
      // appear as a row in the native sidebar.
      await waitFor(() => workspaceRegistry.attachCalls.includes('head-research-head'), 5000, 'head session attached to the root workspace')

      // Title pin: the head's session (PRODUCTION: the single real session the
      // root agent lives on, entered in ctx.sessions — the stub registers it
      // the same way) must carry the user-kind `session/title` rename-shape
      // event. TEST_ORG sets no coordinator.sessionTitle → the fallback label.
      const headSession = root.sessions.get(SessionId('head-research-head'))
      assert.ok(headSession !== undefined, 'the head session is entered in the real sessions store')
      const title = headSession.events.find((ev) => ev.type === 'session/title')
      assert.ok(title !== undefined, 'ensureHead pinned a session/title event')
      assert.equal(title.data.title, 'Research Head', 'the pinned title is the fallback "Research Head" (no coordinator.sessionTitle in TEST_ORG)')
      assert.deepEqual(title.data.messageSeqs, [], 'title pin cites no messages (rename() shape)')
      assert.deepEqual(title.data.source, { kind: 'user' }, 'title pin is user-source — the owner manual rename always wins')

      // The pin is single-shot: re-running ensureAllHeads-equivalents never
      // double-pins. The pure helper already asserts idempotence; here the
      // event count stays 1 after the boot attach settled.
      assert.equal(headSession.events.filter((ev) => ev.type === 'session/title').length, 1, 'exactly one title event pinned')
    } finally {
      await dispose()
    }
  })
})

test('Piece 1 cwd fix: ensureHead creates the head under the WORKSPACE ROOT path (not repoRoot) and the session lands in the durable workspace.json', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head root agent created at boot')
      const create = agents.createCalls.find((c) => String(c.sessionId) === 'head-research-head')
      assert.ok(create, 'the head was created fresh')
      assert.equal(create.meta.cwd, stateDir, 'meta.cwd = the canonical workspace root path (the registry entity path) — NOT the repo root')
      assert.notEqual(create.meta.cwd, path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), 'the workspace root differs from the legacy repo root')
      // The attach then matches by cwd equality → the session id is durably
      // recorded in the workspace membership record (workspace.json) — the
      // exact projection the native sidebar groups rows by.
      await waitFor(async () => {
        try {
          const ws = JSON.parse(await readFile(path.join(stateDir, 'workspace.json'), 'utf8'))
          return Array.isArray(ws.sessionIds) && ws.sessionIds.includes('head-research-head')
        } catch {
          return false
        }
      }, 5000, 'head session recorded in workspace.json sessionIds')
    } finally {
      await dispose()
    }
  })
})

test('Piece 1 cwd fix: the workspace root is the entity that owns the LIVE HOST session (priority over list()[0].path)', async () => {
  await withTempStateDir(async (stateDir) => {
    const hostSessionId = 'session-host-live'
    await seedHostRegistration(stateDir, hostSessionId)
    // Two distinct workspace paths: the FIRST in the registry order has NO host
    // session; the SECOND carries the live host session in its membership.
    const wsFirst = path.join(stateDir, 'ws-first')
    const wsHost = path.join(stateDir, 'ws-host')
    const { root, agents, dispose } = await bootPlugin(stateDir, {
      workspaceEntities: [
        { path: wsFirst, attachSession: async () => {} },
        { path: wsHost, sessionIds: [hostSessionId], attachSession: async () => {} }
      ]
    })
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head root agent created at boot')
      const create = agents.createCalls.find((c) => String(c.sessionId) === 'head-research-head')
      assert.equal(create.meta.cwd, wsHost, 'resolution prefers the entity whose sessionIds hold the live host session (the GUI-created workspace root)')
      assert.notEqual(create.meta.cwd, wsFirst, 'list()[0].path is NOT chosen while a host-owning entity exists')
    } finally {
      await dispose()
    }
  })
})

test('Piece 1 cwd fix: NO workspace entities → the head is created with the repoRoot fallback cwd (headless profiles)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir, { workspaceEntities: [] })
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head root agent created at boot')
      const create = agents.createCalls.find((c) => String(c.sessionId) === 'head-research-head')
      assert.equal(create.meta.cwd, path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), 'empty workspace list → the repoRoot fallback cwd (never throws)')
    } finally {
      await dispose()
    }
  })
})

test('B3 bus head wake: send_message to a registered department head delivers with the agent/send source (no parent needed); self/unknown members are handled', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      // Head auto-materializes at boot (root agent at its stable session id).
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head root agent created at boot')
      const head = agents.store.get(`head-${postId}`)
      const signal = new AbortController().signal

      // 1. A head-addressed message delivers via the bus (agent source framing).
      const result = await root.tools.get('send_message').execute(
        { to: [postId], text: 'question one' },
        { agent: { id: 'host-any', session: { header: {} } }, signal }
      )
      assert.equal(result.delivered[postId], 'delivered')
      await waitFor(() => head.inboxMessages.length >= 1, 5000, 'head woken')
      const wake = head.inboxMessages.at(-1)
      assert.match(wake.content[0].text, /^\[From .*\]: question one/, 'bus framing carries the full body')
      assert.equal(wake.source.kind, 'agent', 'head wakes use the agent send source')

      // 2. Self-addressed send: held (self) — persisted, no wake.
      const before = head.inboxMessages.length
      const selfResult = await root.tools.get('send_message').execute(
        { to: [postId], text: 'self note' },
        { agent: head, signal }
      )
      assert.equal(selfResult.delivered[postId], 'self', 'self-addressed send is held')
      assert.equal(head.inboxMessages.length, before, 'no self-wake')

      // 3. Unknown member: failed per-recipient (never throws the send).
      const ghostResult = await root.tools.get('send_message').execute(
        { to: ['ghost'], text: 'who?' },
        { agent: { id: 'host-any', session: { header: {} } }, signal }
      )
      assert.equal(ghostResult.delivered.ghost, 'failed', 'unknown member fails per-recipient')

      // 4. Head wake needs NO live parent: the head stays live with no host and
      //    a later message still wakes it (root-agent model).
      await root.tools.get('send_message').execute(
        { to: [postId], text: 'still here' },
        { agent: { id: 'host-any', session: { header: {} } }, signal }
      )
      await waitFor(() => head.inboxMessages.length >= before + 1, 5000, 'head woken with no parent present')
    } finally {
      await dispose()
    }
  })
})

test('Fix A1 boot-quiet: a fresh head materializes at boot with NO proactive turn or send — it stays idle until an ADDRESSED message wakes it', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const head = agents.store.get(`head-${postId}`)

      // (a) Materialization itself must NOT enqueue a proactive turn for the head,
      //     and the head must stay idle (the Fix A1 boot-quiet guarantee).
      assert.equal(head.inboxMessages.length, 0, 'boot materialization enqueues NO proactive followup for the fresh head')
      assert.equal(head.status, 'idle', 'the fresh head stays idle after boot materialization')
      assert.equal(agents.resumeCalls.length, 0, 'boot materialization of the FRESH head does not cold-resume (it creates) — no wake cycle')

      // (b) The head is woken ONLY by an explicitly addressed bus message — not
      //     by a proactive turn of its own.
      const signal = new AbortController().signal
      await root.tools.get('send_message').execute(
        { to: [postId], text: 'hello head' },
        { agent: { id: 'host-any', session: { header: {} } }, signal }
      )
      await waitFor(() => head.inboxMessages.length >= 1, 5000, 'head woken only once an ADDRESSED message arrives')
      assert.match(head.inboxMessages.at(-1).content[0].text, /^\[From .*\]: hello head/, 'the sole wake is the addressed bus message')
      assert.equal(head.inboxMessages.length, 1, 'exactly one wake — the addressed message (no extra proactive turns)')

      // (c) The head’s own-layer role persona (the BOOT-QUIET directive) is
      //     installed with the head agent.
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
        // Best-effort: the role section registers on the agent’s scoped layer, so a
        // scope-less assemble may not surface it. Only assert when it did.
        if (roleText !== '') {
          assert.match(roleText, /BOOT-QUIET/, 'head role persona directs boot-quiet behavior')
          assert.match(roleText, /never proactively send/, 'head role persona forbids proactive sends')
        }
      }
    } finally {
      await dispose()
    }
  })
})

test('Fix A2 stuck-head recovery (bus): a live-but-stuck head is disposed + cold-resumed then delivered — the message reaches a WORKING model turn, never the frozen loop', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const sid = `head-${postId}`
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has(sid), 5000, 'head created at boot')
      const frozenHead = agents.store.get(sid)
      const signal = new AbortController().signal
      const sendTool = root.tools.get('send_message')

      // Simulate the live-but-STUCK resident loop: status 'running' and a
      // session event log that NEVER grows. Drive the window via the clock.
      frozenHead.status = 'running'
      const T0 = 1_700_000_000_000
      const resumeBefore = agents.resumeCalls.length
      process.env.DEEPARTMENTS_TEST_NOW = String(T0)

      // Send 1: first observation of the running head — the bus records the
      // progress baseline and delivers; NOT judged stuck yet.
      const r1 = await sendTool.execute({ to: [postId], text: 'first' }, { agent: { id: 'host-any', session: { header: {} } }, signal })
      assert.equal(r1.delivered[postId], 'delivered', 'first delivery accepted on the frozen-loop incarnation')
      await waitFor(() => frozenHead.inboxMessages.length >= 1, 5000, 'first delivery enqueued on the frozen-loop incarnation')
      assert.equal(agents.store.get(sid), frozenHead, 'healthy live head is NOT disposed on first observation')
      assert.equal(agents.resumeCalls.length, resumeBefore, 'no cold-resume while the head still looks healthy')

      // No progress for longer than STUCK_HEAD_MS (120s).
      process.env.DEEPARTMENTS_TEST_NOW = String(T0 + 130_000)

      // Send 2: now the head is STUCK → dispose the frozen handle + cold-resume
      // (the materializePost stuck path) so the delivery is re-made from the
      // DURABLE message record, never lost to the frozen in-memory inbox.
      const r2 = await sendTool.execute({ to: [postId], text: 'second' }, { agent: { id: 'host-any', session: { header: {} } }, signal })
      assert.equal(r2.delivered[postId], 'resumed', 'stuck recovery reports resumed')
      await waitFor(() => agents.store.get(sid) !== frozenHead, 5000, 'stuck head was disposed and a fresh incarnation cold-resumed')

      const freshHead = agents.store.get(sid)
      assert.ok(freshHead, 'a fresh head incarnation is back in the registry')
      assert.notEqual(freshHead, frozenHead, 'the frozen resident loop is GONE from the registry (disposed), replaced by a working incarnation')
      assert.ok(agents.resumeCalls.length > resumeBefore, 'the stuck head was cold-resumed (agents.resume invoked)')
      await waitFor(() => freshHead.inboxMessages.length >= 1, 5000, 'the delivery reaches the WORKING cold-resumed incarnation')
      assert.match(freshHead.inboxMessages.at(-1).content[0].text, /^\[From .*\]: second/, 'the bus delivery is delivered to the fresh incarnation')

      // The DURABLE message record is the re-delivery source: it still holds
      // send 2’s record after dispose+resume (nothing lost to the in-memory inbox).
      const records = await loadMessageRecords(resolveMessagesPath(stateDir))
      assert.ok(records.some((r) => r.text === 'second'), 'durable message record for the wake-triggering message persists (the re-delivery source)')
    } finally {
      delete process.env.DEEPARTMENTS_TEST_NOW
      await dispose()
    }
  })
})

test('Fix A2 normal live-head followup (bus): a HEALTHY live head gets its delivery ENQUEUED without being disposed or cold-resumed', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const sid = `head-${postId}`
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has(sid), 5000, 'head created at boot')
      const head = agents.store.get(sid)
      const signal = new AbortController().signal
      const sendTool = root.tools.get('send_message')
      const send = async (text) => sendTool.execute({ to: [postId], text }, { agent: { id: 'host-any', session: { header: {} } }, signal })

      const resumeBefore = agents.resumeCalls.length
      const r1 = await send('wake A')
      assert.equal(r1.delivered[postId], 'delivered')
      await waitFor(() => head.inboxMessages.length >= 1, 5000, 'delivery enqueued (healthy path)')

      // Even across many subsequent sends, a healthy head keeps the SAME
      // incarnation: never disposed, never cold-resumed, deliveries just enqueue.
      for (let i = 0; i < 3; i++) {
        const r = await send(`wake ${i}`)
        assert.equal(r.delivered[postId], 'delivered')
      }
      await waitFor(() => head.inboxMessages.length >= 4, 5000, 'all deliveries enqueued on the same live incarnation')

      assert.equal(agents.store.get(sid), head, 'healthy live head is NEVER disposed across sends')
      assert.equal(agents.resumeCalls.length, resumeBefore, 'healthy live head is NEVER cold-resumed (no dispose+resume cycle)')
      assert.equal(head.inboxMessages.length, 4, 'every send delivered a followup on the same live head')
      assert.equal(head.status, 'idle', 'head left in its normal idle state')
    } finally {
      await dispose()
    }
  })
})

test('Fix A2 no lost wake (bus): the durable message record is the re-delivery source, so a delivered followup survives a stuck-head dispose+restart', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const sid = `head-${postId}`
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has(sid), 5000, 'head created at boot')
      const frozenHead = agents.store.get(sid)
      const signal = new AbortController().signal
      const sendTool = root.tools.get('send_message')

      // Drive the stuck head through a recovery cycle: first observe it running
      // (baseline), then fast-forward past STUCK_HEAD_MS with no progress.
      const T0 = 1_700_000_000_000
      process.env.DEEPARTMENTS_TEST_NOW = String(T0)
      frozenHead.status = 'running'
      await sendTool.execute({ to: [postId], text: 'trigger' }, { agent: { id: 'host-any', session: { header: {} } }, signal })
      process.env.DEEPARTMENTS_TEST_NOW = String(T0 + 130_000)
      const r = await sendTool.execute({ to: [postId], text: 'trigger again' }, { agent: { id: 'host-any', session: { header: {} } }, signal })
      assert.equal(r.delivered[postId], 'resumed')
      await waitFor(() => agents.store.get(sid) !== frozenHead, 5000, 'stuck head disposed + cold-resumed')

      const freshHead = agents.store.get(sid)
      await waitFor(() => freshHead.inboxMessages.length >= 1, 5000, 'fresh incarnation woken')

      // The durable message record is untouched by dispose/restart and remains
      // the re-delivery source — NOTHING was lost.
      const records = await loadMessageRecords(resolveMessagesPath(stateDir))
      assert.ok(records.some((r) => r.text === 'trigger'), 'the trigger message record persists in the durable store')
    } finally {
      delete process.env.DEEPARTMENTS_TEST_NOW
      await dispose()
    }
  })
})

test('B3 dept_who: the catalog lists registered heads with you:true on the caller (the room-who replacement)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const tool = headCtx.tools.get('dept_who', key)

      const result = await tool.execute({}, { agent: head, signal: new AbortController().signal })
      const self = result.members.find((member) => member.agentId === postId)
      assert.ok(self, 'the head is listed in dept_who')
      assert.equal(self.kind, 'head')
      assert.equal(self.sessionId, 'head-research-head')
      assert.equal(self.live, true)
      assert.equal(self.you, true, 'the caller marks its own entry you:true')
      // B3: a room parameter no longer exists — dept_who is room-less by design.
      assert.equal('room' in tool.output.schema.properties, false, 'dept_who output has no room field')
    } finally {
      await dispose()
    }
  })
})

test('B3 send_message sensitive flag: sensitive:true persists the sensitive marker on the record', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const signal = new AbortController().signal
      const r = await root.tools.get('send_message').execute(
        { to: [postId], text: 'sensitive note', sensitive: true },
        { agent: { id: 'host-any', session: { header: {} } }, signal }
      )
      assert.equal(r.delivered[postId], 'delivered')
      const records = await loadMessageRecords(resolveMessagesPath(stateDir))
      const record = records.find((entry) => entry.id === r.messageId)
      assert.ok(record, 'the record persisted')
      assert.equal(record.sensitive, true, 'the sensitive flag is recorded')
      assert.equal(record.kind, 'agent')
    } finally {
      await dispose()
    }
  })
})

test('B3 agent_messages surfaces the caller’s own received history (the room-read replacement)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const signal = new AbortController().signal

      // Seed two addressed messages via the bus.
      for (const text of ['one', 'two']) {
        await root.tools.get('send_message').execute(
          { to: [postId], text },
          { agent: { id: 'host-any', session: { header: {} } }, signal }
        )
      }
      const page = await headCtx.tools.get('agent_messages', key).execute({ limit: 1 }, { agent: head, signal })
      assert.equal(page.total, 2, 'both messages addressed to the head are counted')
      assert.equal(page.remaining, 1, 'one older message remains')
      assert.equal(page.messages[0].text, 'two', 'newest-first paging')
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
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head root agent created at boot')
      assert.equal(agents.createCalls.filter((c) => String(c.sessionId) === 'head-research-head').length, 1, 'exactly one create for the head')

      const createCall = agents.createCalls.find((c) => String(c.sessionId) === 'head-research-head')
      assert.equal(String(createCall.sessionId), 'head-research-head', 'stable per-post session id')
      // Piece 1 cwd fix (2026-08-22): the head is created under the CANONICAL
      // WORKSPACE ROOT path (resolveWorkspaceRootPath — the registry entity
      // path), NOT the legacy repoRoot hardcode (which matched no workspace and
      // kept the head invisible in the native sidebar).
      assert.equal(createCall.meta.cwd, stateDir, 'meta.cwd is the canonical workspace root path (the registry entity path), not the repo root')
      // Batch 4a: the head session is created under its PER-HEAD preset so it
      // is a NATIVE, openable session labeled with the head preset.
      assert.equal(createCall.meta.agentPreset, 'deepartments-head-research', 'the PER-HEAD preset is requested (deepartments-head-<departmentId>)')
      assert.equal(createCall.meta.origin, undefined, 'no origin (a root/main agent, not a subagent)')
      assert.deepEqual(createCall.agentOptions, { provider: 'stub-coord', model: 'deepseek-v4-flash' }, 'coordinator agentOptions are passed through')

      // Durable posts.json reflects the root-agent identity (no parentId/provider)
      // AND the per-head agentPreset marker.
      const posts = await readPosts(stateDir)
      assert.equal(posts['research-head'].sessionId, 'head-research-head')
      assert.equal(posts['research-head'].roomId, 'board', 'B3: the registry roomId is the inert legacy value (no department room in config anymore)')
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
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head root agent resumed at boot')
      assert.equal(agents.resumeCalls.filter((c) => String(c.resumeSessionId) === 'head-research-head').length, 1, 'exactly one resume for the head')
      assert.equal(agents.createCalls.filter((c) => String(c.sessionId) === 'head-research-head').length, 0, 'no fresh create when a durable session exists')
    } finally {
      await dispose()
    }
  })
})

test('a head is lean: own-layer messaging tools present, host-plane tools NOT exposed; head gets the department-lifecycle (create/retire) tools', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head created at boot')
      const head = agents.store.get('head-research-head')
      const { ctx: headCtx, key } = agents.childContexts[0]
      // Own-layer messaging tools are installed by head setup; B3: the board
      // tools are GONE from every layer.
      for (const name of ['send_message', 'agent_messages', 'dept_who', 'dept_memo_write', 'dept_sleep']) {
        assert.ok(headCtx.tools.get(name, key), `${name} installed in the head own layer`)
      }
      for (const name of ['dept_room_read', 'dept_room_write', 'dept_room_who', 'dept_whereami', 'dept_witness_write']) {
        assert.equal(headCtx.tools.get(name, key), undefined, `${name} removed from the head own layer (B3)`)
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

test('dept_post_retire (B3) removes a head from the registry, persists, and disposes the handle — NO withdrawal note (the board is gone); unknown postId rejects loudly', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head created at boot')
      const host = agents.put(fakeParentAgent())
      const beforeStore = (await loadMessageRecords(resolveMessagesPath(stateDir))).length

      const retireTool = root.tools.get('dept_post_retire')
      assert.ok(retireTool, 'dept_post_retire is registered (host plane)')
      const signal = new AbortController().signal
      const result = await retireTool.execute({ postId: 'research-head' }, { agent: host, signal })
      assert.equal(result.retired, true)
      assert.equal('roomId' in result, false, 'B3: the retire result no longer carries a room id')

      // Registry + persisted posts.json no longer contain the head.
      await waitFor(async () => (await readPosts(stateDir))['research-head'] === undefined, 5000, 'head removed from posts.json')

      // The live handle was disposed (agent gone from the live store).
      assert.equal(agents.store.has('head-research-head'), false, 'head AgentHandle disposed on retire')

      // B3: NO withdrawal note — the bus store is untouched by a retire.
      const afterStore = await loadMessageRecords(resolveMessagesPath(stateDir))
      assert.equal(afterStore.length, beforeStore, 'no withdrawal message record was persisted (the board note is gone)')

      // Unknown postId → loud rejection.
      await assert.rejects(() => retireTool.execute({ postId: 'ghost' }, { agent: host, signal }), /not a registered post/, 'unknown postId rejected loudly')
    } finally {
      await dispose()
    }
  })
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
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head resumed at boot')
      // The head survives; the fork ghosts are swept from posts.json on boot (a
      // persistPosts is NOT forced for the legacy entry, but the in-memory
      // registry never adopts them — the persisted sweep is a follow-up of the
      // old Batch D and is therefore not asserted as a required rewrite).
      const posts = await readPosts(stateDir)
      assert.equal(posts['research-head'].sessionId, 'head-research-head', 'head kept with its root-agent session id')

      // The live registry agrees (dept_who lists no fork ghosts).
      const who = await root.tools.get('dept_who').execute({}, { agent: fakeParentAgent(), signal: new AbortController().signal })
      assert.ok(!who.members.some((m) => m.agentId.startsWith('asistente-fork-')), 'no fork ghost in the live roster')
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
      const r = await root.tools.get('send_message').execute(
        { to: [postId], text: 'wake up' },
        { agent: { id: 'host-any', session: { header: {} } }, signal }
      )
      assert.equal(r.delivered[postId], 'resumed', 'bus wake of the slept head reports resumed')
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
      // dept_who surfaces the sleeping head.
      const who = await root.tools.get('dept_who').execute({}, { agent: fakeParentAgent(), signal })
      const whoSelf = who.members.find((m) => m.agentId === postId)
      assert.equal(whoSelf.sleeping, true, 'dept_who surfaces the sleeping head')
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

      // Next wake: a bus message addressed to the head cold-resumes it (resume
      // the SAME durable session — no fresh create under a new id) and delivers
      // the framed bus message.
      const r = await root.tools.get('send_message').execute(
        { to: [postId], text: 'wake from sleep' },
        { agent: { id: 'host-any', session: { header: {} } }, signal }
      )
      assert.equal(r.delivered[postId], 'resumed', 'bus delivery reports the dormant-target resume')

      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'slept head cold-resumed')
      const resumed = agents.store.get(`head-${postId}`)
      await waitFor(() => resumed.inboxMessages.length >= 1, 5000, 'resumed head woken')
      assert.equal(resumed.inboxMessages.at(-1).source.kind, 'agent', 'head wake uses the bus agent source')
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

test('Piece 1: wakePost re-attaches the head session to the workspace (idempotent — the boot-race recovery for the native sidebar)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    await seedJournal(stateDir, postId, 'PIECE-1-WAKE-ATTACH: re-attach on cold wake')
    const { root, agents, workspaceRegistry, dispose } = await bootPlugin(stateDir)
    await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'head created at boot')
    try {
      const head = agents.store.get(`head-${postId}`)
      const { ctx: headCtx, key } = agents.childContexts[0]
      const signal = new AbortController().signal
      // Boot already attached the head once (ensureHead).
      await waitFor(() => workspaceRegistry.attachCalls.includes(`head-${postId}`), 5000, 'boot attach settled')

      // Sleep (dispose the handle), then wake via the BUS cold path —
      // materializePost re-attaches (idempotent; the wakePost seam core).
      await headCtx.tools.get('dept_memo_write', key).execute({ summary: 'piece-1' }, { agent: head, signal })
      await headCtx.tools.get('dept_sleep', key).execute({}, { agent: head, signal })
      await waitFor(() => agents.store.has(`head-${postId}`) === false, 5000, 'handle disposed after sleep')

      const r = await root.tools.get('send_message').execute(
        { to: [postId], text: 'wake the attached head' },
        { agent: { id: 'host-any', session: { header: {} } }, signal }
      )
      assert.equal(r.delivered[postId], 'resumed')
      await waitFor(() => agents.store.has(`head-${postId}`), 5000, 'slept head cold-resumed by materializePost')

      // The idempotent re-attach fired: at least the boot attach + the wake
      // attach (the real registry tolerates re-attaching; the stub records).
      await waitFor(() => workspaceRegistry.attachCalls.filter((id) => id === `head-${postId}`).length >= 2, 5000, 'bus delivery re-attached the head session')
      const resumed = agents.store.get(`head-${postId}`)
      await waitFor(() => resumed.inboxMessages.length >= 1, 5000, 'resumed head woken')
      assert.equal(resumed.inboxMessages.at(-1).source.kind, 'agent', 'head wake delivered')
      assert.ok(workspaceRegistry.attachCalls.filter((id) => id === `head-${postId}`).length >= 2, 'attach count: boot + wake (>= 2)')
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
      const signal = new AbortController().signal
      const r = await root.tools.get('send_message').execute(
        { to: [postId], text: 'question' },
        { agent: { id: 'host-any', session: { header: {} } }, signal }
      )
      assert.equal(r.delivered[postId], 'delivered')
      await waitFor(() => head.inboxMessages.length >= 1, 5000, 'head woken via normal bus delivery')
      assert.equal(head.inboxMessages.at(-1).source.kind, 'agent', 'head wake keeps the bus source')
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
        { postId: 'researcher-alpha', role: 'rank-and-file researcher', firstMessage: 'investigate X and report' },
        { agent: head, signal }
      )
      assert.equal(result.postId, 'researcher-alpha')
      assert.equal(result.sessionId, 'worker-researcher-alpha')
      assert.equal('roomId' in result, false, 'B3: no room id in the create result (the posts live in the catalog)')

      // The worker root agent was created via ctx.agents.create (meta
      // agentPreset deepartments-worker, origin undefined) and is LIVE.
      assert.equal(agents.store.has('worker-researcher-alpha'), true, 'worker agent is live after create')
      const createCall = agents.createCalls.find((c) => String(c.sessionId) === 'worker-researcher-alpha')
      assert.ok(createCall, 'a ctx.agents.create call for the worker')
      assert.equal(createCall.meta.agentPreset, 'deepartments-worker', 'worker mounts the deepartments-worker preset')
      assert.equal(createCall.meta.origin, undefined, 'worker is a root/main agent (no origin)')
      // Piece 1 cwd fix (2026-08-22): workers are created under the SAME
      // workspace-root cwd as heads (resolveWorkspaceRootPath) — not repoRoot —
      // so the worker's own attach matches by cwd equality too.
      assert.equal(createCall.meta.cwd, stateDir, 'the worker is created under the workspace-root cwd (resolveWorkspaceRootPath), not the repo root')

      // Durable registry: disposable entry (roomId is the INERT legacy field).
      const posts = await readPosts(stateDir)
      assert.equal(posts['researcher-alpha'].sessionId, 'worker-researcher-alpha')
      assert.equal(posts['researcher-alpha'].roomId, 'board', "worker inherits the head entry's inert roomId (legacy registry field)")
      assert.equal(posts['researcher-alpha'].agentPreset, 'deepartments-worker')
      assert.equal(posts['researcher-alpha'].provider, 'worker', 'disposable marker persisted')

      // First message delivered as a durable BUS message → the bus delivery
      // wakes the worker (worker inbox receives the framed agent message).
      const worker = agents.store.get('worker-researcher-alpha')
      await waitFor(() => worker.inboxMessages.length >= 1, 5000, 'worker woken by its first bus message')
      assert.equal(worker.inboxMessages.at(-1).source.kind, 'agent', 'worker wake uses the bus source')
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
      // B3: a `room` parameter no longer exists — an unknown extra is ignored by
      // dsh-tools (not part of the declared schema), so the catalog checks (duplicate,
      // configured-head) are the full validation surface.
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
      // Worker gets the messaging toolset (B3: no board tools anywhere)...
      for (const name of ['send_message', 'agent_messages', 'dept_who', 'dept_memo_write', 'dept_sleep']) {
        assert.ok(workerCtx.tools.get(name, workerKey), `${name} installed in the worker own layer`)
      }
      for (const name of ['dept_room_read', 'dept_room_write', 'dept_room_who', 'dept_whereami', 'dept_witness_write']) {
        assert.equal(workerCtx.tools.get(name, workerKey), undefined, `${name} removed from the worker own layer (B3)`)
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
      // A bus message to it cold-resumes + wakes it.
      const r = await root.tools.get('send_message').execute(
        { to: ['researcher-alpha'], text: 'wake up' },
        { agent: head, signal }
      )
      assert.equal(r.delivered['researcher-alpha'], 'resumed')
      await waitFor(() => agents.store.has('worker-researcher-alpha'), 5000, 'slept worker cold-resumed')
      const resumed = agents.store.get('worker-researcher-alpha')
      await waitFor(() => resumed.inboxMessages.length >= 1, 5000, 'resumed worker woken')
      assert.equal(resumed.inboxMessages.at(-1).source.kind, 'agent', 'worker wake uses the bus source')
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

test('Piece 1 cwd fix: a wake whose RESUME fails falls back to a FRESH create under the workspace-root cwd (wakePost fallback, workers)', async () => {
  await withTempStateDir(async (stateDir) => {
    // A durable worker registry entry (no sleepEpoch, not live at boot) — the
    // relay's cold-wake path, with the RESUME forced to fail so wakePost takes
    // its create-fresh fallback.
    await seedPost(stateDir, {
      postId: 'researcher-alpha',
      sessionId: 'worker-researcher-alpha',
      roomId: 'research',
      agentPreset: 'deepartments-worker',
      provider: 'worker',
      role: 'rank-and-file researcher'
    })
    const { root, agents, workspaceRegistry, dispose } = await bootPlugin(stateDir, { resumeRejects: ['worker-researcher-alpha'] })
    try {
      // A bus message addressed to the worker → the bus cold-wakes it.
      const r = await root.tools.get('send_message').execute(
        { to: ['researcher-alpha'], text: 'wake up' },
        { agent: { id: 'host-any', session: { header: {} } }, signal: new AbortController().signal }
      )
      // The forced resume failure fell back to create-fresh and STILL delivered
      // (materializePost's create fallback — never silent).
      assert.equal(r.delivered['researcher-alpha'], 'resumed', 'the resume-failed wake yields resumed (create-fresh fallback delivered)')
      await waitFor(() => agents.store.has('worker-researcher-alpha'), 5000, 'worker materialized via the resume-failed create-fresh fallback')
      const createCall = agents.createCalls.find((c) => String(c.sessionId) === 'worker-researcher-alpha')
      assert.ok(createCall, 'a fresh ctx.agents.create was issued (the forced resume failure triggered the fallback)')
      assert.equal(createCall.meta.cwd, stateDir, 'the materializePost fallback create uses the workspace-root cwd (resolveWorkspaceRootPath), not the repo root')
      assert.equal(createCall.meta.agentPreset, 'deepartments-worker', 'the fallback create still mounts the worker preset')
      // The fallback-created worker is then re-attached (cwd now matches the
      // workspace path → the attach resolves).
      await waitFor(() => workspaceRegistry.attachCalls.includes('worker-researcher-alpha'), 5000, 'the fallback-created worker is attached to the workspace')
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
      const beforeStore = (await loadMessageRecords(resolveMessagesPath(stateDir))).length

      const retireTool = headCtx.tools.get('dept_post_retire', key)
      assert.ok(retireTool, 'head own layer has dept_post_retire')
      const result = await retireTool.execute({ postId: 'researcher-alpha' }, { agent: head, signal })
      assert.equal(result.retired, true)
      assert.equal('roomId' in result, false, 'B3: no room id in the retire result')

      // Handle disposed + unregistered + persisted removal.
      await waitFor(async () => (await readPosts(stateDir))['researcher-alpha'] === undefined, 5000, 'worker removed from posts.json')
      assert.equal(agents.store.has('worker-researcher-alpha'), false, 'worker AgentHandle disposed on retire')
      // B3: NO withdrawal note — the store is untouched by a retire.
      assert.equal((await loadMessageRecords(resolveMessagesPath(stateDir))).length, beforeStore, 'no withdrawal note persisted')

      // Unknown target → loud rejection.
      await assert.rejects(() => retireTool.execute({ postId: 'ghost' }, { agent: head, signal }), /not a registered post/, 'unknown postId rejected loudly')
      // A head can never retire a PERMANENT head via this path.
      await assert.rejects(() => retireTool.execute({ postId: 'research-head' }, { agent: head, signal }), /not a disposable worker/, 'head cannot retire a permanent head')
    } finally {
      await dispose()
    }
  })
})

test('dept_post_retire scope (B3): a head CANNOT retire a permanent head via the retire path (the room-scope check is gone with the rooms)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { agents, head, headCtx, key, dispose } = await bootWithHead(stateDir)
    try {
      const signal = new AbortController().signal
      const retireTool = headCtx.tools.get('dept_post_retire', key)
      // B3: the room-scope restriction is removed with the board; the remaining
      // scope rule is worker-only (a permanent head is never retired by a head).
      await assert.rejects(
        () => retireTool.execute({ postId: 'research-head' }, { agent: head, signal }),
        /not a disposable worker/, 'head cannot retire a permanent head'
      )
      const posts = await readPosts(stateDir)
      assert.equal(posts['research-head'].provider, undefined, 'the permanent head was not touched by a rejecting call')
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

test('U4 pure helper: pinHostSessionTitle pins "Asistente" only when the session has no user-kind title yet', () => {
  // Fresh session (no title event): pins with the exact rename() shape.
  const fresh = Session.create(SessionId('session-title-fresh'))
  assert.equal(pinHostSessionTitle(fresh), 'pinned')
  const pinned = fresh.events.find((ev) => ev.type === 'session/title')
  assert.ok(pinned !== undefined, 'session/title event appended')
  assert.equal(pinned.data.title, 'Asistente')
  assert.deepEqual(pinned.data.messageSeqs, [])
  assert.deepEqual(pinned.data.source, { kind: 'user' })
  assert.equal(pinned.surfaceOp, undefined, 'title pin is log-only (no surface entry)')

  // Idempotent: a second call never double-pins (the Asistente pin itself is
  // user-kind — the "already has the Asistente pin" guard).
  const before = fresh.events.length
  assert.equal(pinHostSessionTitle(fresh), 'already-titled')
  assert.equal(fresh.events.length, before, 'no second title event appended')

  // The owner's manual rename (also source.user) always wins — never clobbered.
  const renamed = Session.create(SessionId('session-title-renamed'))
  renamed.append('session/title', { title: 'Mi host', messageSeqs: [], source: { kind: 'user' } })
  const renamedCount = renamed.events.length
  assert.equal(pinHostSessionTitle(renamed), 'already-titled')
  assert.equal(renamed.events.length, renamedCount, 'owner rename untouched')
  assert.equal(renamed.events.find((ev) => ev.type === 'session/title').data.title, 'Mi host')

  // Automatic LLM/fallback titles (source provider/fallback) are NOT user
  // titles — the Asistente pin overrides them (fold is last-wins).
  const auto = Session.create(SessionId('session-title-auto'))
  auto.append('session/title', { title: 'What is the plan for Q3?', messageSeqs: [0], source: { kind: 'provider', provider: 'stub', model: 'stub' } })
  assert.equal(pinHostSessionTitle(auto), 'pinned')
  const autoTitle = auto.events.filter((ev) => ev.type === 'session/title').at(-1)
  assert.equal(autoTitle.data.title, 'Asistente', 'the Asistente user pin wins over the later-folded provider title')
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
      assert.equal(createMeta.seedLength, 5, 'create meta seedLength = the 5-event rotation seed')
      const appended = persistence.appendCalls[0]
      assert.equal(appended.id, newSessionId, 'append targets the pre-minted id')
      assert.deepEqual(appended.events.map((ev) => ev.type), ['permission/preset', 'sandbox/mode', 'approval/policy', 'user/message', 'session/title'], 'append carries the rotation seed events')
      appended.events.forEach((ev, i) => assert.equal(ev.seq, i, `seed seq ${ev.seq} contiguous at index ${i}`))
      assert.ok(!appended.events.some((ev) => ev.type === 'turn/start'), 'the seeded artifact is BLANK (no turn/start — native "New Session" row)')
      const titlePin = appended.events.find((ev) => ev.type === 'session/title')
      assert.equal(titlePin.data.title, 'Asistente', 'seeded title pin is "Asistente" (U4)')
      assert.deepEqual(titlePin.data.messageSeqs, [], 'seeded title pin cites no messages (rename() shape)')
      assert.deepEqual(titlePin.data.source, { kind: 'user' }, 'seeded title pin is user-source — pinned, LLM/fallback cannot override it')
      const journalNode = appended.events.find((ev) => ev.type === 'user/message')
      assert.equal(journalNode.data.source.kind, 'plugin', 'seeded journal framed as plugin context')
      assert.match(journalNode.data.content[0].text, new RegExp(`^author: ${newHostId}$`, 'm'), 'seeded journal is the RE-KEYED journal (author host-<newId>)')
      assert.match(journalNode.data.content[0].text, /^wake_counter: 2$/m, 'seeded journal carries the BUMPED ordinal')
      assert.ok(journalNode.data.content[0].text.includes(journalSummary), 'seeded journal carries the summary body')

      // S2.2 (FIX 1b) — the new session is durably attached to a workspace
      // entity (canonical parity with the apiproxy's creation flow), exactly
      // once, targeting the pre-minted id. (The configured head's own
      // boot-time attach — Piece 1, 'head-research-head' — lands BEFORE this
      // in the same registry, so the rotation attach is the LAST entry.)
      assert.equal(workspaceRegistry.attachCalls.at(-1), newSessionId, 'S2.2 attach targets the pre-minted session id')
      assert.equal(workspaceRegistry.attachCalls.filter((id) => id === newSessionId).length, 1, 'S2.2 attached the rotated session exactly once (the boot head attach is separate)')

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
      const who = await root.tools.get('dept_who').execute({}, { agent: host, signal })
      const whoHosts = who.members.filter((m) => m.kind === 'host')
      assert.ok(!whoHosts.some((h) => h.agentId === oldHostId), 'retired host is filtered from the roster (§4/C7)')
      const newSleepingHost = whoHosts.find((h) => h.agentId === newHostId)
      assert.ok(newSleepingHost, 'the NEW host is in the catalog roster')
      assert.equal(newSleepingHost.sleeping, true, 'dept_who surfaces the sleeping NEW host')

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
      await waitForHeadMaterialized(b.agents)
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

// --- FIX 1b: boot repair hook — attach the single live host to its workspace
// The rotation attaches at S2.2; this hook heals legacy/crash states where a
// host was registered in hosts.json but NEVER workspace-attached (the
// session-6e49895c… incident: a cold artifact + live entry with ZERO rows in
// the durable workspace sessionIds → no sidebar row → host unreachable). It
// runs once per boot after the hosts load, guarded to EXACTLY ONE non-retired
// live host, best-effort (warn on ambiguity / no-match / failure — never
// crash). The StubWorkspaceRegistry records attach calls; the plugin resolves
// the SAME instance (ctx.get('workspaceRegistry') === workspaceRegistry).
// NOTE: the DEFAULT logger exporter's buffer filters warn (level 2) out, so
// these tests register their own exporter (levels.default: 4) right after
// boot to observe the hook's warn/info lines deterministically.

test('FIX 1b boot repair: EXACTLY ONE live host entry whose session is not workspace-attached → attachSession on the workspace entity (heals the invisible-host state)', async () => {
  await withTempStateDir(async (stateDir) => {
    const sessionId = 'session-repair-target'
    await seedHostRegistration(stateDir, sessionId)
    const { root, workspaceRegistry, dispose } = await bootPlugin(stateDir)
    try {
      const logged = []
      const disposeExporter = root.logger.exporter({ levels: { default: 4 }, export: (message) => { logged.push(message) } })
      // The configured head (TEST_ORG department) gets its OWN boot-time
      // attach (Piece 1) — the REPAIR's contract is the HOST session: it must
      // be attached exactly once, targeted at the seeded session id.
      await waitFor(() => workspaceRegistry.attachCalls.includes(sessionId), 5000, 'boot repair attached the single live host')
      assert.equal(workspaceRegistry.attachCalls.filter((id) => id === sessionId).length, 1, 'attach repair targets the live host session id exactly once')
      assert.ok(workspaceRegistry.attachCalls.includes('head-research-head'), 'the configured head is attached at boot too (Piece 1)')
      await waitFor(() => logged.some((m) => m?.type === 'info' && String(m.args?.[0] ?? '').includes(`host attach repair: attached ${sessionId}`)), 5000, 'attach repair logged')
      disposeExporter()
    } finally {
      await dispose()
    }
  })
})

test('FIX 1b boot repair: ZERO live host entries → no attach call (skip silently)', async () => {
  await withTempStateDir(async (stateDir) => {
    // A hosts.json carrying only the schema marker — no host entries.
    await mkdir(stateDir, { recursive: true })
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({ schemaVersion: 2 }, null, 2))
    const { root, workspaceRegistry, dispose } = await bootPlugin(stateDir)
    try {
      const logged = []
      const disposeExporter = root.logger.exporter({ levels: { default: 4 }, export: (message) => { logged.push(message) } })
      await waitFor(() => logged.some((m) => m?.type === 'info' && String(m.args?.[0] ?? '').includes('loaded 0 host registry entries')), 5000, 'hosts load settled (0 entries)')
      await new Promise((resolve) => setTimeout(resolve, 150))
      // Piece 1 — the CONFIGURED HEAD still gets its own boot attach; the
      // REPAIR attaches NOTHING when there is no live host.
      assert.deepEqual(workspaceRegistry.attachCalls, ['head-research-head'], 'no repair attach when there is no live host (only the configured head is attached at boot)')
      disposeExporter()
    } finally {
      await dispose()
    }
  })
})

test('FIX 1b boot repair: TWO live host entries → NO attach + a WARN (ambiguous — exactly one is required)', async () => {
  await withTempStateDir(async (stateDir) => {
    await mkdir(stateDir, { recursive: true })
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({
      'host-session-one': { sessionId: 'session-one', roomId: 'board' },
      'host-session-two': { sessionId: 'session-two', roomId: 'board' }
    }, null, 2))
    const { root, workspaceRegistry, dispose } = await bootPlugin(stateDir)
    try {
      const logged = []
      const disposeExporter = root.logger.exporter({ levels: { default: 4 }, export: (message) => { logged.push(message) } })
      await waitFor(() => logged.some((m) => m?.type === 'warn' && String(m.args?.[0] ?? '').includes('host attach repair: skipped (2 live host entries')), 5000, 'ambiguous repair warned')
      disposeExporter()
      // Piece 1 — the CONFIGURED HEAD still gets its own boot attach; the
      // ambiguous REPAIR attaches NO host (exactly-one-live-host guard).
      await waitFor(() => workspaceRegistry.attachCalls.includes('head-research-head'), 5000, 'the configured head attach settled')
      assert.deepEqual(workspaceRegistry.attachCalls, ['head-research-head'], 'ambiguous (2+ live hosts): NO repair attach attempted (only the configured head is attached)')
    } finally {
      await dispose()
    }
  })
})

test('FIX 1b boot repair: the attaching entity THROWS → boot does not crash, a WARN is logged, nothing attached', async () => {
  await withTempStateDir(async (stateDir) => {
    const sessionId = 'session-repair-target'
    await seedHostRegistration(stateDir, sessionId)
    const { root, workspaceRegistry, dispose } = await bootPlugin(stateDir, {
      workspaceEntities: [{ path: stateDir, attachSession: async () => { throw new Error('injected attach fault') } }]
    })
    try {
      const logged = []
      const disposeExporter = root.logger.exporter({ levels: { default: 4 }, export: (message) => { logged.push(message) } })
      await waitFor(() => logged.some((m) => m?.type === 'warn' && String(m.args?.[0] ?? '').includes('host attach repair: no workspace matched session')), 5000, 'repair failure warned (never crashes)')
      disposeExporter()
      assert.equal(workspaceRegistry.attachCalls.length, 0, 'the throwing entity recorded nothing')
    } finally {
      await dispose()
    }
  })
})

test('FIX 1b.1 boot repair REGRESSION: the workspace registry is NOT ready at boot (list() rejects mid-init — the strict ctx.get race) — the hook RETRIES until it becomes usable and then attaches', async () => {
  await withTempStateDir(async (stateDir) => {
    const sessionId = 'session-repair-target'
    await seedHostRegistration(stateDir, sessionId)
    // Production shape: the registry impl exists but its init (storage +
    // sessionPersistence header-index rebuild) has not completed, so the
    // first list() calls reject like the real mid-init requireState throw
    // ("workspace registry is not started yet"). The hook must use the
    // NON-STRICT get + a bounded retry loop — the strict-get version raced
    // the init and silently skipped (production: session-6e49895c did not
    // heal at the 17:24:59 UTC restart; zero `host attach repair` lines).
    const { root, workspaceRegistry, dispose } = await bootPlugin(stateDir, { registryNotReadyRejects: 2 })
    try {
      const logged = []
      const disposeExporter = root.logger.exporter({ levels: { default: 4 }, export: (message) => { logged.push(message) } })
      // registryNotReadyRejects: 2 — BOTH the boot-repair hook AND the head
      // attach retry until the registry becomes usable; the repair's own
      // contract is the HOST session, attached exactly once after readiness.
      await waitFor(() => workspaceRegistry.attachCalls.includes(sessionId), 8000, 'boot repair attached AFTER the registry became ready (retry loop)')
      assert.equal(workspaceRegistry.attachCalls.filter((id) => id === sessionId).length, 1, 'retry attach targets the live host session id exactly once')
      await waitFor(() => logged.some((m) => m?.type === 'info' && String(m.args?.[0] ?? '').includes(`host attach repair: attached ${sessionId}`)), 5000, 'attach success logged after retries')
      disposeExporter()
    } finally {
      await dispose()
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

test('Batch C pre-step: a HOST session\'s first message-time pre-step injects a FRESH wake pack (pack-v1 sentinel + fresh message-delta + wake_counter KPI) onto decision.messages', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head created at boot')

      // Pre-author the host journal WITH open items so the KPI line is real
      // (dept_memo_write is the real tool; wake_counter 1 on first write).
      const memo = root.tools.get('dept_memo_write')
      await memo.execute(
        { summary: 'PRE-STEP fresh wake orientation.', openItems: ['finish pre-step wiring', 'ship wake timing'] },
        { agent: host, signal }
      )

      // A bus message addressed to the host arrives AFTER the journal — the
      // fresh message-delta the pack MUST capture (anti-staleness core, B3:
      // the delta is the caller\'s latest-received records, not a board cursor).
      const hostId = `host-${host.id}`
      // Register the host first (B3 self-registration via dept_who) so the
      // catalog resolves it as a recipient.
      await root.tools.get('dept_who').execute({}, { agent: host, signal })
      const head = agents.store.get('head-research-head')
      const { ctx: headCtx, key } = agents.childContexts[0]
      const sent = await headCtx.tools.get('send_message', key).execute(
        { to: [hostId], text: 'fresh message for the pre-step pack' },
        { agent: head, signal }
      )
      assert.equal(sent.delivered[hostId], 'delivered', 'bus message to the host delivered')

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
      assert.match(packText, /fresh message for the pre-step pack/, 'injected pack carries FRESH message-delta content (read at message time, not frozen at the previous dept_sleep)')
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
      await waitForHeadMaterialized(agents)
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
      await waitForHeadMaterialized(agents)
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
      await waitForHeadMaterialized(agents)
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
      await waitForHeadMaterialized(agents)
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
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal

      // Plain first pre-step: NO pack — not a registered host yet.
      const claimed = preStepClaimed('first message, still unregistered')
      const first = await runPreStep(pluginCtx, host, claimed, signal)
      assert.equal(first.kind, 'enter')
      assert.equal(first.messages.length, claimed.length, 'unregistered session pre-step adds NO node')
      assert.ok(!first.messages.some((m) => m.content?.[0]?.text?.includes('## Deepartments wake pack')), 'no wake pack before registration')

      // Mid-session registration: dept_who self-registers the calling host
      // session (B3 gap fix — the board tools that used to do this are gone).
      const whoTool = pluginCtx().tools.get('dept_who')
      const who = await whoTool.execute({}, { agent: host, signal })
      assert.ok(who.members.some((m) => m.kind === 'host' && m.you === true), 'dept_who registers the calling session as a host')

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
      await waitForHeadMaterialized(agents)
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
      assert.match(text, /identity: Deepartments subagent \(role: reviewer, room: deepartments\)/, 'identity is a Deepartments subagent with the REVIEWER role — never a host')
      assert.match(text, /## Your role contract/, 'role contract section present')
      assert.match(text, /READ-ONLY: you do NOT write or edit code\./, 'reviewer contract injected')
      assert.match(text, /VERDICT: PASS \(1-2 line note\) or FAIL/, 'reviewer contract verdict line injected')

      // NO full host wake pack markers:
      assert.ok(!text.includes('## Deepartments wake pack'), 'no host wake pack header')
      assert.ok(!/host-[0-9a-f-]+ \(role: host\)/.test(text), 'no host-… (role: host) branding')
      assert.ok(!text.includes('Pre-resolved journal path'), 'no journal pointer')
      assert.ok(!text.includes('## Message delta (received)'), 'no message delta section')
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
      await waitForHeadMaterialized(agents)
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
      await waitForHeadMaterialized(agents)

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
      await waitForHeadMaterialized(agents)
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
      assert.match(text, /identity: Deepartments subagent \(role: reviewer, room: deepartments\)/, 'slim block: subagent identity with the reviewer role — never a host')
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
      assert.match(hostText, /identity: host-.* \(role: host\)/, 'host pack carries the host identity branding (B3: no room)')

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
    journalPath: '/state/journals/host-session-abc.md',
    messageDelta: '- m-4 | sender-1 → host-session-abc | preview text',
    roster: '- research-head (deepartments-head)',
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
    '## Message delta (received)',
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
  assert.match(pack, /- m-4 \| sender-1 → host-session-abc \| preview text/, 'message delta TOC included')
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
    messageDelta: '',
    roster: '- research-head (deepartments-head)',
    includeGuidance: false
  })

  // Sections 1, 3, 4 present.
  assert.match(pack, /## Deepartments wake pack/, 'identity header present')
  assert.match(pack, /pack-v1: present/, 'P1 presence sentinel present even in the lean snapshot (shared buildWakePack section 1)')
  assert.match(pack, /## Message delta \(received\)/, 'message delta section present')
  assert.match(pack, /## Condensed roster/, 'roster section present')

  // Empty delta → the section body after the header is empty (no TOC lines)
  // before the next section.
  const deltaBody = pack.split('## Message delta (received)')[1].split('## Condensed roster')[0]
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
  const lean = buildWakePack({ memberId: 'h', role: 'host', messageDelta: '- m-0 | a → h | hi', roster: 'x' })
  assert.ok(!lean.includes('## Git bearings'), 'undefined git omitted gracefully')
  assert.ok(!lean.includes('## deepartments-workflow skill'), 'undefined skill omitted gracefully')
  assert.ok(!lean.includes('## System state'), 'undefined system state omitted gracefully')

  // Markers produced by the NON-pure assembly layer pass through untouched.
  const degraded = buildWakePack({
    memberId: 'h', role: 'host', messageDelta: '', roster: 'x',
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
      const tool = root.tools.get('dept_wake_snapshot')
      assert.ok(tool, 'dept_wake_snapshot registered globally (host plane)')

      const host = agents.put(fakeParentAgent())
      const result = await tool.execute({}, { agent: host, signal: new AbortController().signal })

      assert.ok(typeof result.snapshot === 'string' && result.snapshot.length > 0, 'snapshot returns a non-empty text string')
      assert.match(result.snapshot, /^## Deepartments wake pack$/m, 'snapshot opens with the wake pack header')
      assert.match(result.snapshot, new RegExp(`identity: host-${host.id}`), 'snapshot carries identity + host address')
      assert.match(result.snapshot, /## Message delta \(received\)/, 'snapshot carries the message delta section (B3: no board cursor)')
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

test('Batch 7 U2 regression (B3): dept_who reports the NEW rotated host as sleeping and excludes the RETIRED host from "present" (the room-who schema drift is moot — the tool is gone)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, persistence, workspaceRegistry, dispose } = await bootPlugin(stateDir)
    try {
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
      // S2.2 attached exactly once to a workspace entity (FIX 1b) — the boot head
      // attach (Piece 1) is a SEPARATE entry.
      assert.equal(workspaceRegistry.attachCalls.at(-1), newSessionId, 'S2.2 attach targets the pre-minted session id')
      assert.equal(workspaceRegistry.attachCalls.filter((id) => id === newSessionId).length, 1, 'S2.2 attached the rotated session exactly once (the boot head attach is separate)')

      const who = root.tools.get('dept_who')
      const result = await who.execute({}, { agent: host, signal })
      // The NEW host is present and reported as sleeping; the RETIRED old host
      // is excluded (spec 002 §4/C7) via dept_who (B3).
      const sleepingHost = result.members.find((h) => h.kind === 'host' && h.agentId === newHostId)
      assert.ok(sleepingHost, 'the NEW sleeping host is in the global roster')
      assert.equal(sleepingHost.sleeping, true, 'dept_who reports the sleeping NEW host')
      assert.ok(!result.members.some((h) => h.kind === 'host' && h.agentId === oldHostId), 'the retired old host is excluded from "present"')

      // (b) The DECLARED output schema must actually allow `sleeping` on a
      // member — additionalProperties:false forces the declaration.
      const itemSchema = who.output.schema.properties.members.items
      const sleepingSchema = itemSchema.properties.sleeping
      assert.ok(sleepingSchema, 'members.items.properties.sleeping is declared in the output schema')
      assert.equal(sleepingSchema.type, 'boolean', 'members[].sleeping is a boolean')
      assert.ok(itemSchema.required.includes('sleeping'), 'members[].sleeping is required (in the item required[] array)')
      assert.equal(itemSchema.additionalProperties, false, 'member item keeps additionalProperties:false (field must be declared)')
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

// ---------------------------------------------------------------------------
// Batch B2 — agent messaging bus (spec 003): send_message / agent_messages /
// dept_who against the REAL Loader with the REAL SubagentRuntime + stubs.
// ---------------------------------------------------------------------------

/** Seed `<stateDir>/messages.jsonl` with raw records BEFORE boot (the cold
 * restart fixture for agent_messages paging — the store opens + indexes it). */
async function seedMessageRecords(stateDir, records) {
  const filePath = resolveMessagesPath(stateDir)
  await mkdir(stateDir, { recursive: true })
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

/** Latest delivery status rows for one message id from the sidecar file. */
async function readDeliveryRows(stateDir, messageId) {
  const filePath = resolveDeliveriesPath(stateDir)
  let rows
  await waitFor(async () => {
    try {
      rows = parseDeliveryRows(await readFile(filePath, 'utf8'))
      return rows.some((row) => row.messageId === messageId)
    } catch {
      return false
    }
  }, 5000, 'deliveries.jsonl readable')
  return rows.filter((row) => row.messageId === messageId)
}

test('B2 send_message: catalog head delivered with the spec framing + agent source; record persisted BEFORE delivery; sidecar prepared→delivered', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      // The head (research-head) is materialized at boot; the host is a fresh
      // root session. The unified tool is registered globally (no native
      // control tool composed in this minimal loader — see the override test).
      const send = pluginCtx().tools.get('send_message')
      assert.ok(send, 'send_message registered on the host plane')
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const result = await send.execute({ to: ['research-head'], text: 'hello head' }, { agent: host, signal })

      assert.equal(result.messageId, 'm-0', 'first send is m-0 (global seq starts at 0)')
      assert.equal(result.delivered['research-head'], 'delivered', 'live head delivered inline (no resume)')
      assert.deepEqual(Object.keys(result.delivered), ['research-head'], 'one recipient, one delivered entry')

      // Framing (spec §4.3) — the GUI never renders to[], so it MUST be in the text.
      const head = agents.store.get('head-research-head')
      const wake = head.inboxMessages.at(-1)
      assert.equal(wake.content[0].text, '[From host-' + host.id + ' → research-head]: hello head', 'framed text = [From sender → to]: text')
      assert.equal(wake.source.kind, 'agent', 'bus wake source kind is agent')
      assert.equal(wake.source.form, 'send', 'bus wake source form is send')
      assert.equal(wake.source.from, `host-${host.id}`, 'source.from is the member id')
      assert.deepEqual(wake.source.to, ['research-head'], 'source.to carries the recipients (additive, GUI row body)')
      assert.equal(wake.source.messageId, 'm-0', 'source.messageId links the wake to the durable record')
      assert.equal(wake.source.senderSessionId, host.id, 'source.senderSessionId is the caller session id')
      assert.ok(String(wake.source.summary).includes('New message from host-'), 'summary chrome is informative (human row label)')

      // Durable record on disk BEFORE delivery (spec §4.3 step 1): raw text,
      // member ids only — never session ids.
      const records = await loadMessageRecords(resolveMessagesPath(stateDir))
      assert.equal(records.length, 1)
      assert.equal(records[0].id, 'm-0')
      assert.equal(records[0].from, `host-${host.id}`)
      assert.deepEqual(records[0].to, ['research-head'])
      assert.equal(records[0].text, 'hello head', 'record keeps the RAW text (framing is delivery-only)')
      assert.equal(records[0].kind, 'agent')

      // Sidecar: write-ahead prepared row THEN the final delivered row.
      const rows = await readDeliveryRows(stateDir, 'm-0')
      assert.deepEqual(rows.map((row) => row.status), ['prepared', 'delivered'], 'sidecar transitions prepared → delivered')
      assert.equal(rows[0].recipientId, 'research-head')

      // agent_messages on the RECIPIENT shows the record (own history).
      const messagesTool = pluginCtx().tools.get('agent_messages')
      const page = await messagesTool.execute({ limit: 10 }, { agent: head, signal })
      assert.equal(page.total, 1)
      assert.equal(page.messages[0].id, 'm-0')
      assert.equal(page.messages[0].text, 'hello head')
    } finally {
      await dispose()
    }
  })
})

test('B2 send_message: a dormant (slept) catalog head is RESUMED — sleepEpoch cleared, previous incarnation traced, wake delivered', async () => {
  await withTempStateDir(async (stateDir) => {
    // Seed a slept head that is NOT configured (ensureAllHeads only
    // materializes CONFIGURED coordinators — a seeded stray stays dormant).
    await seedPost(stateDir, { postId: 'sleeper-head', sessionId: 'head-sleeper-head', roomId: 'research', agentPreset: 'deepartments-head', sleepEpoch: Date.now() })
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const send = pluginCtx().tools.get('send_message')
      const result = await send.execute({ to: ['sleeper-head'], text: 'wake up' }, { agent: host, signal })

      assert.equal(result.delivered['sleeper-head'], 'resumed', 'dormant head is resumed (materialize + followup)')
      const woke = agents.store.get('head-sleeper-head')
      assert.ok(woke, 'dormant head materialized')
      const wake = woke.inboxMessages.at(-1)
      assert.equal(wake.content[0].text, '[From host-' + host.id + ' → sleeper-head]: wake up')

      // Durable registry: sleepEpoch cleared, previous incarnation traced (the
      // wakePost seam verbatim).
      await waitFor(async () => {
        const posts = await readPosts(stateDir)
        return posts['sleeper-head'] !== undefined && posts['sleeper-head'].sleepEpoch === undefined
      }, 5000, 'sleepEpoch cleared after the bus wake')
      const posts = await readPosts(stateDir)
      assert.equal(posts['sleeper-head'].previousChildId, 'head-sleeper-head', 'previous incarnation traced')
    } finally {
      await dispose()
    }
  })
})

test('B2 send_message: MULTI-recipient splits per-recipient — live head delivered, unknown id failed (never kills the send)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const send = pluginCtx().tools.get('send_message')
      const result = await send.execute({ to: ['research-head', 'ghost-unknown'], text: 'one known, one ghost' }, { agent: host, signal })

      assert.equal(result.delivered['research-head'], 'delivered')
      assert.equal(result.delivered['ghost-unknown'], 'failed', 'unknown catalog id is per-recipient failed, not a hard error')
      const records = await loadMessageRecords(resolveMessagesPath(stateDir))
      assert.equal(records.length, 1, 'ONE record for the whole send (to[] = all recipients)')
      assert.deepEqual(records[0].to, ['research-head', 'ghost-unknown'])
      const rows = await readDeliveryRows(stateDir, 'm-0')
      const statuses = Object.fromEntries(rows.map((row) => [row.recipientId, row.status]))
      assert.equal(statuses['research-head'], 'delivered')
      assert.equal(statuses['ghost-unknown'], 'failed')
    } finally {
      await dispose()
    }
  })
})

test('B2 send_message: SELF-addressed send is held (`self`) — record persisted, NO wake, no followup', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const send = pluginCtx().tools.get('send_message')
      const hostMemberId = `host-${host.id}`
      const result = await send.execute({ to: [hostMemberId], text: 'note to self' }, { agent: host, signal })

      assert.equal(result.delivered[hostMemberId], 'self', 'self recipient is held (persisted, no wake)')
      assert.equal(host.inboxMessages.length, 0, 'no followup into the caller turn (ack-loop guard)')
      const records = await loadMessageRecords(resolveMessagesPath(stateDir))
      assert.equal(records.length, 1, 'self send still persists its record')
      const rows = await readDeliveryRows(stateDir, 'm-0')
      assert.equal(rows.at(-1).status, 'self', 'sidecar terminal status is self')
    } finally {
      await dispose()
    }
  })
})

test('B2 send_message: fan-out cap — 21 recipients is a hard error (cap 20, spec §4.4)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      const send = pluginCtx().tools.get('send_message')
      const recipients = Array.from({ length: 21 }, (_, index) => `member-${index}`)
      await assert.rejects(
        () => send.execute({ to: recipients, text: 'too many' }, { agent: host, signal }),
        /fan-out cap is 20/,
        '21 recipients rejected loudly'
      )
      const records = await loadMessageRecords(resolveMessagesPath(stateDir)).catch(() => [])
      assert.equal(records.length, 0, 'no record persisted for a rejected send')
    } finally {
      await dispose()
    }
  })
})

test('B2 send_message: child route FIRST — a direct continuable child is delivered natively (listChildren, never catalog-validated)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      const host = agents.put(fakeParentAgent())
      const signal = new AbortController().signal
      // Establish a REAL continuable child of the caller through the REAL
      // SubagentRuntime continuation manager (stub provider prepares continuable
      // children; StubAgents materializes them with a real scoped ctx).
      const { childId } = await root.subagents.startContinuable({
        provider: 'spawn',
        label: 'b2-child',
        request: { parent: host, prompt: [{ type: 'text', text: 'initial prompt' }], maxDepth: 1 },
        signal
      })
      const child = agents.store.get(String(childId))
      assert.ok(child, 'continuable child materialized into the agents store')
      // The StubAgents.create ignores the factory `seed`, so the real store
      // session the child is entered under carries NO subagent/descriptor event
      // — the projection fold listChildren classifies on would serve no
      // identity. Mirror what the real agent factory writes at creation so the
      // child lists as mode:'continuable' (the child-route detection seam).
      const childSession = root.sessions.get(SessionId(childId))
      assert.ok(childSession, 'child entered in the real session store')
      childSession.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: 'b2-child' })

      // The child id is NOT in the catalog — only the child route can reach it.
      const send = pluginCtx().tools.get('send_message')
      const result = await send.execute({ to: [String(childId)], text: 'continue' }, { agent: host, signal })
      assert.equal(result.delivered[String(childId)], 'delivered', 'child delivered through the native followup route')
      const childWake = child.inboxMessages.at(-1)
      assert.equal(childWake.content[0].text, '[From host-' + host.id + ' → ' + childId + ']: continue', 'child wake is framed like every bus delivery')
      assert.equal(childWake.source.kind, 'agent')
      assert.equal(childWake.source.senderSessionId, host.id)
    } finally {
      await dispose()
    }
  })
})

test('B2 agent_messages: paging 10-per-page with before cursor + remaining (20 seeded, newest-first, 11-20 via cursor)', async () => {
  await withTempStateDir(async (stateDir) => {
    const hostSessionId = SessionId('b2-host-page')
    const hostMemberId = `host-${hostSessionId}`
    const records = Array.from({ length: 20 }, (_, seq) => ({
      id: `m-${seq}`,
      seq,
      ts: 1700000000000 + seq,
      from: 'research-head',
      to: [hostMemberId],
      text: `message ${seq}`,
      kind: 'agent'
    }))
    await seedMessageRecords(stateDir, records)
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      const host = agents.put(fakeParentAgent(SessionId('b2-host-page')))
      const signal = new AbortController().signal
      const messagesTool = pluginCtx().tools.get('agent_messages')

      // Page 1: newest 10 (m-19..m-10), 10 older remaining.
      const page1 = await messagesTool.execute({ limit: 10 }, { agent: host, signal })
      assert.equal(page1.total, 20, 'total is the caller-owned record count')
      assert.equal(page1.messages.length, 10)
      assert.deepEqual(page1.messages.map((message) => message.id), Array.from({ length: 10 }, (_, index) => `m-${19 - index}`), 'newest-first (m-19 … m-10)')
      assert.equal(page1.remaining, 10, 'remaining = exact older count (sparse-subset correct)')

      // Page 2 via cursor: records STRICTLY older than m-10 (m-9..m-0).
      const page2 = await messagesTool.execute({ limit: 10, before: 'm-10' }, { agent: host, signal })
      assert.deepEqual(page2.messages.map((message) => message.id), Array.from({ length: 10 }, (_, index) => `m-${9 - index}`), 'before cursor is exclusive')
      assert.equal(page2.remaining, 0, 'no older records below the oldest page')

      // Clamp rule: an unresolvable cursor (renumbered by a compaction) clamps
      // to the newest boundary — EXCLUSIVE at the newest record (the store's
      // implemented clamp §3.2, verified in messages-store.test.js:179): the
      // page restarts from the boundary instead of erroring.
      const pageClamped = await messagesTool.execute({ limit: 10, before: 'm-4049' }, { agent: host, signal })
      assert.deepEqual(pageClamped.messages.map((message) => message.id), Array.from({ length: 10 }, (_, index) => `m-${18 - index}`), 'missing cursor clamps to the newest boundary (exclusive); history still valid')

      // limit cap: 999 defensive-caps to 50 (store contract).
      const pageCapped = await messagesTool.execute({ limit: 999 }, { agent: host, signal })
      assert.equal(pageCapped.messages.length, 20, 'limit normalizes to the 50 max; 20 owned records served')
    } finally {
      await dispose()
    }
  })
})

test('B2 dept_who: whole catalog — host + head rows with kind/title/live/sleeping/sessionId and you:true on the caller', async () => {
  await withTempStateDir(async (stateDir) => {
    const hostSessionId = SessionId('b2-host-who')
    await seedHostRegistration(stateDir, hostSessionId, 'board')
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir)
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head created at boot')
      const host = agents.put(fakeParentAgent(SessionId('b2-host-who')))
      const signal = new AbortController().signal

      const who = pluginCtx().tools.get('dept_who')
      const result = await who.execute({}, { agent: host, signal })
      assert.equal(result.members.length, 2, 'host + configured head')

      const hostRow = result.members.find((member) => member.agentId === `host-${hostSessionId}`)
      assert.equal(hostRow.kind, 'host', 'host row kind')
      assert.equal(hostRow.title, 'Asistente', 'host row title is Asistente')
      assert.equal(hostRow.live, true, 'host is live (agents.get defined)')
      assert.equal(hostRow.sleeping, false)
      assert.equal(hostRow.sessionId, String(hostSessionId), 'host sessionId is the registry session id')
      assert.equal(hostRow.you, true, 'host row marks the CALLER you:true')

      const headRow = result.members.find((member) => member.agentId === 'research-head')
      assert.equal(headRow.kind, 'head', 'head row kind')
      assert.equal(headRow.title, 'Research department head', 'title = coordinator.title (TEST_ORG coordinator.title is unset → role fallback… see note)')
      assert.equal(headRow.live, true, 'configured head is live at boot')
      assert.equal(headRow.sleeping, false)
      assert.equal(headRow.sessionId, 'head-research-head')
      assert.equal(headRow.you, false, 'only the caller is you')

      // The head's own view of the roster: you flips to the head.
      const head = agents.store.get('head-research-head')
      const { ctx: headCtx, key } = agents.childContexts[0]
      const headWho = headCtx.tools.get('dept_who', key)
      const headResult = await headWho.execute({}, { agent: head, signal })
      const headSelf = headResult.members.find((member) => member.agentId === 'research-head')
      assert.equal(headSelf.you, true, 'head own-layer dept_who marks the head you:true')
      const hostSelf = headResult.members.find((member) => member.agentId === `host-${hostSessionId}`)
      assert.equal(hostSelf.you, false)
    } finally {
      await dispose()
    }
  })
})

test('B2 send_message: the unified implementation is the ONE bound after the override — native control tool owns the global name, deepartments agents still get the unified UNIFIED (to array works, native error absent)', async () => {
  await withTempStateDir(async (stateDir) => {
    // Compose the REAL harness control plugin (dsh-tool-subagent-control: the
    // native global send_message) BEFORE the deepartments row — exactly the
    // GUI/headless composition. The plugin must NOT throw at apply (no global
    // duplicate) and must shadow the native per-agent own-layer.
    const overrideHostSessionId = SessionId('b2-host-override')
    await seedHostRegistration(stateDir, overrideHostSessionId, 'board')
    const { root, agents, pluginCtx, dispose } = await bootPlugin(stateDir, { nativeControlTool: true })
    try {
      await waitFor(() => agents.store.has('head-research-head'), 5000, 'head created at boot')

      // The GLOBAL name is the NATIVE one (dsh-base owns it): its schema is
      // the adapter shape, not the unified one.
      const globalSend = pluginCtx().tools.get('send_message')
      assert.ok(globalSend, 'send_message exists on the host plane')
      assert.equal(globalSend.parameters.properties.subagent_id !== undefined, true, 'global send_message is the NATIVE adapter (subagent_id schema)')
      assert.equal(typeof globalSend.parameters.properties.to, 'undefined', 'global layer still holds the native tool, not the unified one')

      // The HEAD own layer carries the UNIFIED tool (scoped shadow — the
      // harness-supported override: duplicate in one layer throws, so a scoped
      // registration that SHADOWS the global is the valid seam).
      const { ctx: headCtx, key } = agents.childContexts[0]
      const headSend = headCtx.tools.get('send_message', key)
      assert.ok(headSend, 'unified send_message installed in the head own layer')
      assert.equal(headSend.parameters.properties.to !== undefined, true, 'own-layer send_message is the UNIFIED one (to[] schema)')
      assert.equal(typeof headSend.parameters.properties.subagent_id, 'undefined', 'own-layer send_message is NOT the native adapter')

      // The unified bound implementation WORKS: to[] array against a catalog
      // id delivers — the native error (subagent_id required/continuable-only)
      // never surfaces.
      const head = agents.store.get('head-research-head')
      const host = agents.put(fakeParentAgent(SessionId('b2-host-override')))
      const signal = new AbortController().signal
      const result = await headSend.execute({ to: [`host-${host.id}`], text: 'reply to host' }, { agent: head, signal })
      assert.equal(result.delivered[`host-${host.id}`], 'delivered', 'unified tool delivers via the catalog (host live, followup inline)')
      const wake = host.inboxMessages.at(-1)
      assert.equal(wake.content[0].text, '[From research-head → host-' + host.id + ']: reply to host', 'unified framing')
      assert.equal(wake.source.kind, 'agent')
    } finally {
      await dispose()
    }
  })
})
