// dsh-deepartments — LANE ② (incident-delivery 2026-09-03) CUT 5 + ADDENDUM:
// the O1 RETIRE-GRACE (the auto-retire-on-delivery AbortError race — 3 samples
// 34→16→3ms — the dispose now deferring so the in-flight tool call completes),
// the REQUIRED fb-79 test («worker→own-head con head IDLE»: the deliver fails
// NOT for ACL/tamaño — the class was a retry storm WITHOUT backoff; the
// delivery here is one-shot), the ADDENDUM ZOMBIE stop (a host rotation must
// dispose the retiring session so it never consumes queued turns in parallel
// with the successor) and the ADDENDUM m-440 boundary (an in-flight prepared
// to a REROUTABLE retired host is NOT settled terminal at the rotation).
//
// The bundle is booted from the SOURCE (src/index.ts) via the self-registered
// ts-src-loader hook + a file-URL plugin name — 0 builds (Node type-stripping).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { deliveryStatus, parseDeliveryRows, resolveDeliveriesPath, resolveMessagesPath } from '../lib/messages-store.js'
import { readFileSync } from 'node:fs'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLE_SRC = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href

process.env.DEEPARTMENTS_QUALITY_INSPECT = '1' // the worker-retire QD dice stays DETERMINISTIC (a directive may emit)

const ORG = {
  departments: [
    {
      id: 'research',
      name: 'Research',
      coordinator: { postId: 'research-head', role: 'Research department head', provider: 'deepseek-official', agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' } }
    }
  ]
}

// --- the hermetic harness (the rotate-settle shape, booting the bundle FROM SRC) ---
const postAdoption = new Map()

function stubProvider(name) {
  const provider = {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: name === 'fork',
    prepareCalls: [],
    async start() { throw new Error(`stub provider "${name}": one-shot start is not used in these tests`) },
    async prepareContinuable(request) { provider.prepareCalls.push(request); return { seed: [] } }
  }
  return provider
}

async function materializeStubAgent(agents, sessionId, options) {
  const callerSignal = options.signal
  let callerSignalAborted = false
  callerSignal?.addEventListener('abort', () => { callerSignalAborted = true }, { once: true })
  const parentSession = options.parentSession ?? options.meta?.parentSession
  const agent = {
    id: sessionId,
    options: options.agentOptions ?? {},
    status: 'idle',
    session: {
      header: { id: sessionId, parentSession, delegationDepth: options.meta?.delegationDepth },
      events: [],
      get seq() { return this.events.length },
      snapshotEvents() { return this.events },
      requestHeader() { return undefined }
    },
    inboxMessages: [],
    ctx: undefined,
    callerSignalAborted: () => callerSignalAborted,
    followup(message) { this.inboxMessages.push(message) },
    steer() {}, inject() {}, send() {},
    cancelCalls: [],
    cancel(cause, options) { this.cancelCalls.push({ cause, options }) },
    whenIdle() { return new Promise(() => {}) }
  }
  const childKey = Symbol('stub-child-scope')
  const scope = createScope(agents.scopeAnchor, childKey)
  const childCtx = scope.ctx.extend({ agent })
  agent.ctx = childCtx
  agents.childContexts.push({ ctx: childCtx, key: childKey })
  agents.childAgents.push(agent)
  const provision = await options.setup?.(childCtx)
  provision?.commit?.()
  agents.store.set(sessionId, agent)
  return { agent, dispose: async () => {
    agents.disposeCalls.set(sessionId, (agents.disposeCalls.get(sessionId) ?? 0) + 1)
    const gate = agents.disposeGates.get(sessionId)
    if (gate !== undefined) await gate
    agents.store.delete(sessionId)
  } }
}

class StubAgents extends Service {
  constructor(ctx, sessionCwds) {
    super(ctx, 'agents')
    this.store = new Map()
    this.createCalls = []
    this.resumeCalls = []
    this.childContexts = []
    this.childAgents = []
    this.scopeAnchor = ctx
    this.sessionCwds = sessionCwds
    this.resumeRejects = new Set()
    this.createRejects = new Set()
    this.disposeGates = new Map()
    this.disposeCalls = new Map()
  }
  get(id) { return this.store.get(id) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  put(agent) { this.store.set(agent.id, agent); return agent }
  ensureStoreSession(sessionId) {
    const id = SessionId(sessionId)
    const store = this.ctx.get('sessions')
    if (store === undefined || typeof store.get !== 'function') return undefined
    const existing = store.get(id)
    if (existing !== undefined) return existing
    try { return store.create(id, {}) ?? store.get(id) } catch { return store.get(id) }
  }
  async create(options) {
    this.createCalls.push(options)
    if (this.createRejects.has(String(options.sessionId))) throw new Error('stub: forced create failure')
    this.sessionCwds?.set(String(options.sessionId), options.meta?.cwd)
    this.ensureStoreSession(options.sessionId)
    return materializeStubAgent(this, options.sessionId, options)
  }
  async resume(options) {
    this.resumeCalls.push(options)
    if (this.resumeRejects.has(options.resumeSessionId)) throw new Error('stub: forced resume failure')
    this.sessionCwds?.set(String(options.resumeSessionId), options.meta?.cwd)
    this.ensureStoreSession(options.resumeSessionId)
    return materializeStubAgent(this, options.resumeSessionId, { ...options, parentSession: postAdoption.get(options.resumeSessionId) })
  }
}

class StubPersistence extends Service {
  constructor(ctx) { super(ctx, 'sessionPersistence'); this.createCalls = []; this.appendCalls = [] }
  async create(meta) { this.createCalls.push(meta) }
  async append(id, events) { this.appendCalls.push({ id, events }) }
  async inspect(childId) {
    const parentSession = postAdoption.get(childId)
    if (parentSession === undefined) throw new Error('stub persistence: no stored session')
    return { meta: { parentSession, seedLength: 0 }, events: [{ type: 'subagent/descriptor', data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'board-post' } }] }
  }
  async list() { return [] }
}

class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir, sessionCwds) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.archived = []
    this.attachCalls = []
    this.sessionCwds = sessionCwds
    this.entitySessions = []
    this.entities = [{
      path: stateDir, title: 'root', sessionIds: this.entitySessions,
      attachSession: async (sessionId) => {
        this.attachCalls.push(sessionId)
        if (!this.entitySessions.includes(sessionId)) this.entitySessions.push(sessionId)
      }
    }]
  }
  get archivedSessionIds() { return this.archived }
  list() { return Promise.resolve(this.entities) }
  async create(path, title) {
    const existing = this.entities.find((e) => e.path === path)
    if (existing !== undefined) return existing
    const entity = { path, title, sessionIds: [], attachSession: async (sessionId) => { this.attachCalls.push(sessionId); if (!entity.sessionIds.includes(sessionId)) entity.sessionIds.push(sessionId) } }
    this.entities.push(entity)
    return entity
  }
  async resolveByPath(path) { const canonical = await realpath(path); return this.entities.find((e) => e.path === canonical) }
  async archiveSession(sessionId) { if (!this.archived.includes(sessionId)) this.archived.push(sessionId) }
}

function fakeParentAgent(id = SessionId(randomUUID())) {
  return {
    id, options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, status: 'idle',
    session: { header: { id }, events: [], get seq() { return this.events.length }, snapshotEvents() { return this.events }, requestHeader() { return undefined } },
    ctx: { get: () => undefined }, inboxMessages: [], injectedMessages: [],
    followup(message) { this.inboxMessages.push(message) }, steer() {}, inject(message) { this.injectedMessages.push(message) }, send() {},
    cancelCalls: [], cancel(cause, options) { this.cancelCalls.push({ cause, options }) },
    whenIdle() { return new Promise(() => {}) }
  }
}

async function bootPluginFromSrc(stateDir, opts = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  const agents = new StubAgents(root, new Map())
  const persistence = new StubPersistence(root)
  const workspaceRegistry = new StubWorkspaceRegistry(root, stateDir, agents.sessionCwds)
  await root.plugin(SubagentRuntime)
  const spawnStub = stubProvider('spawn')
  const forkStub = stubProvider('fork')
  root.subagents.registerProvider(spawnStub)
  root.subagents.registerProvider(forkStub)
  loader.create({ id: 'deepartments', name: BUNDLE_SRC, config: { stateDir, org: opts.org ?? ORG } })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return { root, agents, persistence, workspaceRegistry, spawnStub, forkStub, pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx, dispose: () => loaderFiber.dispose() }
}

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'lane2-vertical-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

/** The own-layer scoped ctx + scope key of a materialized agent (the F3
 * spawn-tool invocation shape — the tool-set is looked up per own layer). */
function childContextFor(agents, sessionId) {
  const index = agents.childAgents.findIndex((agent) => agent && agent.id === sessionId)
  if (index < 0) return undefined
  return { ctx: agents.childContexts[index].ctx, key: agents.childContexts[index].key }
}

async function seedPost(stateDir, post) {
  const postsPath = path.join(stateDir, 'posts.json')
  await mkdir(stateDir, { recursive: true })
  let existing = {}
  try { existing = JSON.parse(await readFile(postsPath, 'utf8')) } catch { /* fresh */ }
  existing[post.postId] = post
  await writeFile(postsPath, JSON.stringify(existing, null, 2), 'utf8')
}

async function seedMessageRecords(stateDir, records) {
  await writeFile(resolveMessagesPath(stateDir), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

async function seedDeliveryRows(stateDir, rows) {
  await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

async function seedJournal(stateDir, memberId, summary) {
  const journalPath = path.join(stateDir, 'journals', `${memberId}.md`)
  await mkdir(path.dirname(journalPath), { recursive: true })
  await writeFile(journalPath, ['---', `author: ${memberId}`, 'timestamp: 2026-09-03T00:00:00.000Z', 'wake_counter: 1', 'board_cursor: none', 'decisions: []', 'constraints: []', 'open_items: []', '---', '', summary, ''].join('\n'), 'utf8')
}

test('LANE ② fb-79 (the REQUIRED case — worker→own-head with the head IDLE): a REAL spawned worker delivers its report to its OWN manager head (the delivery is one-shot — never ACL/tamaño-delayed, never a retry storm), the AUTO-RETIRE marks it retired immediately, and the O1 GRACE defers the handle dispose — the in-flight tool call completes before the tear-down', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const head = env.agents.store.get('head-research-head')
      const headCtx = childContextFor(env.agents, 'head-research-head')
      assert.ok(headCtx, 'the head own-layer context resolves')
      assert.ok(headCtx.ctx.tools !== undefined, `the head ctx exposes the tools service (ctx keys: ${Object.keys(headCtx.ctx).slice(0, 20).join(',')})`)
      // The REAL spawn: the head creates a disposable worker of its department
      // (the class the incident's worker→own-head deliveries used).
      const signal = new AbortController().signal
      const spawn = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'check tracker and report' }, { agent: head, signal })
      assert.ok(spawn.workerId, `the worker spawned (${spawn.workerId})`)
      await waitFor(() => env.agents.store.has(spawn.sessionId), 8000, 'the worker is live')
      const worker = env.agents.store.get(spawn.sessionId)
      const workerCtx = childContextFor(env.agents, spawn.sessionId)
      assert.ok(workerCtx, 'the worker own-layer context resolves')
      // The WORKER sends its final report to its own IDLE head.
      const sendResult = await workerCtx.ctx.tools.get('send_message', workerCtx.key).execute({ to: ['research-head'], text: 'final report — deliverable done' }, { agent: worker, signal })
      assert.equal(sendResult.delivered['research-head'], 'delivered', 'the worker→own-head delivery is DELIVERED (one-shot — the class is NOT an ACL/tamaño failure)')
      // The auto-retire MARK is immediate…
      const posts = JSON.parse(await readFile(path.join(stateDir, 'posts.json'), 'utf8'))
      assert.equal(posts[spawn.workerId]?.retired, true, 'the worker is marked retired at the delivery (auto-retire)')
      // …with EXACTLY ONE attempt row (no storm).
      const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
      const pairRows = rows.filter((r) => r.recipientId === 'research-head' && (r.status === 'prepared' || r.status === 'failed'))
      assert.ok(pairRows.length <= 2, `the worker→head report carries ONE attempt + its final status (${pairRows.length} prepared/failed rows — the fb-79 storm is impossible)`)
      // O1 GRACE: the worker handle is STILL LIVE right after the delivery
      // (its send_message tool call completes before the tear-down — the
      // 34→16→3ms AbortError race window is gone)…
      assert.equal(env.agents.disposeCalls.get(spawn.sessionId) ?? 0, 0, `O1 GRACE: the handle is NOT disposed immediately after the delivery (disposeCalls=0 — the in-flight tool call completes first)`)
      // …and the deferred dispose lands within the grace window.
      await waitFor(() => (env.agents.disposeCalls.get(spawn.sessionId) ?? 0) >= 1, 8000, 'the deferred dispose runs within the grace')
      assert.ok(!env.agents.store.has(spawn.sessionId), 'the deferred dispose eventually tears the handle down')
    } finally {
      await env.dispose()
    }
  })
})

test('LANE ② ADDENDUM (QD D-Q3 — the ZOMBIE stop + the m-440 rotation boundary): the host ROTATION now disposes the retiring session (a zombie can NO LONGER consume queued turns in parallel with the successor — the m-437/438 double-consumption class), and an IN-FLIGHT prepared row to the REROUTABLE retired host id is NOT settled terminal (the F-3 re-drive re-routes it to the live successor)', async () => {
  await withTempStateDir(async (stateDir) => {
    const now = Date.now()
    const host = fakeParentAgent()
    const oldHostId = `host-${host.id}`
    // m-437/438: pre-rotation deliveries that would wake + D4-materialize the
    // OLD host (its handle is tracked in byHeadHandle — the LANE ② fix, so the
    // post-retirement zombie CAN be torn down). m-440: the ONLY in-flight
    // prepared AT the boundary (the addendum case, seeded IN-SESSION after the
    // boot pass drained, exactly like the m-440 evidence).
    await seedMessageRecords(stateDir, [
      { id: 'm-437', seq: 0, ts: now, from: 'research-head', to: [oldHostId], text: 'zombie-1', kind: 'agent' },
      { id: 'm-438', seq: 1, ts: now, from: 'research-head', to: [oldHostId], text: 'zombie-2', kind: 'agent' }
    ])
    await seedDeliveryRows(stateDir, [
      { messageId: 'm-437', recipientId: oldHostId, status: 'prepared', ts: now },
      { messageId: 'm-438', recipientId: oldHostId, status: 'prepared', ts: now }
    ])
    // The OLD HOST is registered LIVE pre-boot (a durable hosts.json entry)
    // so the boot re-delivery D4-resumes its session.
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({ [`host-${host.id}`]: { sessionId: String(host.id), roomId: 'board' } }), 'utf8')
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      // The boot re-delivery D4-resumes the OLD host (handle tracked) and
      // delivers m-437/438 INTO its inbox.
      await waitFor(async () => (await deliveryStatus(stateDir, 'm-437', oldHostId)) !== 'prepared', 8000, 'the old host received the pre-rotation deliveries')
      const oldStoreAgent = env.agents.store.get(String(host.id))
      assert.ok(oldStoreAgent !== undefined, 'the old host session is the live store agent (the boot re-delivery D4-resumed it)')
      // The m-440 in-flight prepared is seeded IN-SESSION (post boot-pass) —
      // the exact rotation-boundary shape of the addendum.
      await seedMessageRecords(stateDir, [
        { id: 'm-440', seq: 2, ts: now, from: 'internal-programming-head', to: [oldHostId], text: 'in-flight at boundary', kind: 'agent' }
      ])
      await seedDeliveryRows(stateDir, [
        { messageId: 'm-440', recipientId: oldHostId, status: 'prepared', ts: now }
      ])
      await seedJournal(stateDir, oldHostId, 'ZOMBIE-ROTATION-MEMORY')
      const realSession = Session.create(SessionId(String(host.id)))
      realSession.append('user/message', { role: 'user', content: [{ type: 'text', text: 'prior turn' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      host.session = realSession
      let concluded = false
      const signal = new AbortController().signal
      const result = await env.root.tools.get('dept_sleep').execute({}, { agent: host, signal, concludeTurn: () => { concluded = true } })
      assert.ok(concluded, 'the host turn concluded')
      assert.match(result.member, /^host-session-/, 'the rotation returned the new host id')
      // THE ZOMBIE STOP: the retiring session is DISPOSED at the boundary.
      assert.ok((env.agents.disposeCalls.get(String(host.id)) ?? 0) >= 1, 'the ROTATION dispatches the retiring session dispose (the zombie can no longer consume post-retirement turns)')
      assert.ok(!env.agents.store.has(String(host.id)), 'the retiring host handle is TORN DOWN — it cannot process a single post-retirement turn (the m-437/438 double-consumption race is structurally stopped)')
      // F-3 m-440: the in-flight prepared to the REROUTABLE host id is NOT
      // terminal-settled by the rotation — it stays PENDING for the re-drive
      // (which re-routes it to the live successor; m-424/425/429-class fixed).
      assert.equal(await deliveryStatus(stateDir, 'm-440', oldHostId), 'prepared', 'the m-440 in-flight prepared is NOT settled terminal at the rotation boundary (fb-58 F-3 — the re-drive re-routes it to the session viva)')
      // The successor got its own wake (the handoff), untouched by the old rows.
      const newEntry = JSON.parse(await readFile(path.join(stateDir, 'hosts.json'), 'utf8'))[result.member]
      assert.equal(newEntry.retired, undefined, 'the successor is the ONE live host')
    } finally {
      await env.dispose()
    }
  })
})