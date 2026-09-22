// GHOST-GUARD (ghostguard1) — the test that ACREDITS THE FIX, not just the
// mechanism.
//
// WHY THIS FILE EXISTS (and why the sibling test in dsh-smart-restart is not
// enough): the smart_restart guard counts RETIRED agents because the harness
// only unregisters an agent AFTER `await machine.whenIdle()` resolves
// (dsh-agent-loop/lib/index.js:1138-1146: cancel -> await whenIdle ->
// detachAgent). The disposition fix lives HERE, in this repo, as the
// `finally { disposeHandle() }` of `retirePost`'s DEFERRED arm
// (packages/dshd-orchestration/src/tools.ts, the GHOST-GUARD block).
//
// A test that drives the guard's pure predicate against a simulated registry
// proves the MECHANISM but CANNOT credit that fix: delete the `finally` and it
// stays green, because nothing imports the real retire path. The `finally` is
// the EXCEPTION branch — so the evidence must be a test that makes a PREVIOUS
// STEP OF THE DEFERRED PATH REJECT and then asserts the dispose was DISPATCHED
// ANYWAY.
//
// THE DISCRIMINATOR (this is the whole point):
//   A worker is retired while its turn is IN FLIGHT, which selects the DEFERRED
//   arm (`deferDisposeMs = AUTO_RETIRE_DISPOSE_GRACE_MS`, tools.ts:3909-3912).
//   Its session log read is then poisoned so `getSessionEvents(liveRef?.session)`
//   — the FIRST step of `runDeferredDisposeAndSettle` — THROWS.
//     * WITHOUT the `finally`: the deferred runner rejects at its first step and
//       `disposeHandle()` is NEVER REACHED -> disposeCalls stays 0 -> this test
//       FAILS. (Verified red with the fix reverted; see the report.)
//     * WITH the `finally`: the rejection is caught, the dispose is dispatched
//       unconditionally -> disposeCalls >= 1 -> this test PASSES.
//
// CONTROL (from the same file, so "we fixed it" is never confused with "that
// case already worked"): an IDLE worker retires through the IMMEDIATE arm and is
// disposed. That case never had the hole (its `finally { disposeHandle() }` is
// the precedent the deferred arm now mirrors).
//
// ORACLE DECLARATION (fb-512): this file resolves the PLUGIN BUNDLE FROM SOURCE
// (`src/index.ts`) through the self-registered `ts-src-loader` hook — "0 builds",
// exactly like the `lane2-retire-grace-zombie` mold it is modelled on. It
// imports NO built artifact (no `../lib/...`): everything under test comes from
// `src`. So a green here means the CURRENT SOURCE dispatches the dispose — it is
// NOT a claim about a compiled `lib/`.
import { register } from 'node:module'

register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLE_SRC = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href

process.env.DEEPARTMENTS_QUALITY_INSPECT = '1' // the retire QD dice stays deterministic

const ORG = {
  departments: [
    {
      id: 'research',
      name: 'Research',
      coordinator: { postId: 'research-head', role: 'Research department head', provider: 'deepseek-official', agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' } }
    }
  ]
}

// --- the hermetic harness (the lane2-retire-grace-zombie shape, booting FROM SRC) ---
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
  const parentSession = options.parentSession ?? options.meta?.parentSession
  const agent = {
    id: sessionId,
    options: options.agentOptions ?? {},
    status: 'idle',
    session: {
      header: { id: sessionId, parentSession },
      events: [],
      get seq() { return this.events.length },
      snapshotEvents() { return this.events },
      requestHeader() { return undefined }
    },
    inboxMessages: [],
    ctx: undefined,
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
  return {
    agent,
    dispose: async () => {
      agents.disposeCalls.set(sessionId, (agents.disposeCalls.get(sessionId) ?? 0) + 1)
      const gate = agents.disposeGates.get(sessionId)
      if (gate !== undefined) await gate
      agents.store.delete(sessionId)
    }
  }
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
    this.disposeGates = new Map()
    this.disposeCalls = new Map()
  }
  get(id) { return this.store.get(id) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
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
    this.sessionCwds?.set(String(options.sessionId), options.meta?.cwd)
    this.ensureStoreSession(options.sessionId)
    return materializeStubAgent(this, options.sessionId, options)
  }
  async resume(options) {
    this.resumeCalls.push(options)
    this.sessionCwds?.set(String(options.resumeSessionId), options.meta?.cwd)
    this.ensureStoreSession(options.resumeSessionId)
    return materializeStubAgent(this, options.resumeSessionId, { ...options, parentSession: postAdoption.get(options.resumeSessionId) })
  }
}

class StubPersistence extends Service {
  constructor(ctx) { super(ctx, 'sessionPersistence'); this.createCalls = []; this.appendCalls = [] }
  async create(header) {
    this.createCalls.push(header)
    const id = header.id
    return {
      append: async (events) => { this.appendCalls.push({ id, events }) },
      flush: async () => {},
      close: async () => {}
    }
  }
  async inspect() { throw new Error('stub persistence: no stored session') }
  async list() { return [] }
}

class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir, sessionCwds) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.archived = []
    this.attachCalls = []
    this.sessionCwds = sessionCwds
    this.entities = [{ path: stateDir, title: 'root', sessionIds: [], attachSession: async (sessionId) => { this.attachCalls.push(sessionId) } }]
  }
  get archivedSessionIds() { return this.archived }
  list() { return Promise.resolve(this.entities) }
  async create(p, title) {
    const existing = this.entities.find((e) => e.path === p)
    if (existing !== undefined) return existing
    const entity = { path: p, title, sessionIds: [], attachSession: async () => {} }
    this.entities.push(entity)
    return entity
  }
  async resolveByPath(p) { return this.entities.find((e) => e.path === p) }
  async archiveSession(sessionId) { if (!this.archived.includes(sessionId)) this.archived.push(sessionId) }
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
  root.subagents.registerProvider(stubProvider('spawn'))
  root.subagents.registerProvider(stubProvider('fork'))
  loader.create({ id: 'deepartments', name: BUNDLE_SRC, config: { stateDir, org: opts.org ?? ORG } })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return {
    root,
    agents,
    persistence,
    workspaceRegistry,
    dispose: () => loaderFiber.dispose()
  }
}

async function waitFor(predicate, timeoutMs = 12_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ghostguard-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

function childContextFor(agents, sessionId) {
  const index = agents.childAgents.findIndex((agent) => agent && agent.id === sessionId)
  if (index < 0) return undefined
  return { ctx: agents.childContexts[index].ctx, key: agents.childContexts[index].key }
}

/** Spawn a real worker through the REAL head tool (the real registration path:
 *  registerEntry + byHeadHandle.set), returning the handles the assertions need. */
async function spawnWorker(env) {
  await waitFor(() => env.agents.store.has('head-research-head'), 12_000, 'research head materialized')
  const head = env.agents.store.get('head-research-head')
  const headCtx = childContextFor(env.agents, 'head-research-head')
  assert.ok(headCtx, 'the head own-layer context resolves')
  const signal = new AbortController().signal
  const spawn = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'ghostguard probe' }, { agent: head, signal })
  await waitFor(() => env.agents.store.has(spawn.sessionId), 12_000, 'the worker is live')
  return { head, headCtx, spawn, worker: env.agents.store.get(spawn.sessionId), signal }
}

// ---------------------------------------------------------------------------
// THE ACCREDITING TEST — a previous step of the DEFERRED path REJECTS.
// ---------------------------------------------------------------------------
test('ghost-guard: retiring a MID-TURN worker still DISPATCHES the dispose when a previous step of the deferred path REJECTS (the `finally { disposeHandle() }` guarantee in tools.ts)', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      const { head, headCtx, spawn, worker, signal } = await spawnWorker(env)

      // (1) IN FLIGHT -> the DEFERRED arm (deferDisposeMs = AUTO_RETIRE_DISPOSE_GRACE_MS,
      //     tools.ts:3909-3912). This is the arm that carries the ghost-guard fix.
      worker.status = 'running'

      // (2) POISON the first step of `runDeferredDisposeAndSettle`:
      //     `getSessionEvents(liveRef?.session)` (the fb-130 drain's argument).
      //     A THROWING session-log read is the rejection this test injects.
      const poison = new Error('ghostguard: session log read rejected (injected)')
      worker.session.snapshotEvents = () => { throw poison }

      // (3) Retire through the REAL head tool (the real retire path).
      const retire = await headCtx.ctx.tools.get('dept_worker_retire', headCtx.key).execute({ workerId: spawn.workerId }, { agent: head, signal })
      assert.equal(retire.retired, true, 'the retire itself succeeds (the mark commits before the deferred work)')
      assert.equal(env.agents.disposeCalls.get(spawn.sessionId) ?? 0, 0, 'the DEFERRED arm does not dispose synchronously (the grace is armed)')

      // (4) THE ASSERTION: the dispose must be DISPATCHED even though the first
      //     step rejected. Without the `finally` this never happens and the test
      //     fails — the retire would silently never release the handle.
      await waitFor(
        () => (env.agents.disposeCalls.get(spawn.sessionId) ?? 0) >= 1,
        12_000,
        'the deferred dispose to be DISPATCHED despite the rejecting first step',
      )
      assert.ok(
        (env.agents.disposeCalls.get(spawn.sessionId) ?? 0) >= 1,
        'the dispose was dispatched unconditionally (the `finally` guarantee) — without it the handle would stay live forever and the smart_restart guard would keep counting this RETIRED worker',
      )
      // And the teardown really happened (the handle left the store).
      await waitFor(() => !env.agents.store.has(spawn.sessionId), 12_000, 'the handle torn down')
      assert.ok(!env.agents.store.has(spawn.sessionId), 'the retiring worker is gone from the live registry')
    } finally {
      await env.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// POSITIVE CONTROL — the IMMEDIATE arm (an IDLE worker); never had the hole.
// ---------------------------------------------------------------------------
test('ghost-guard CONTROL: retiring an IDLE worker (the IMMEDIATE arm) disposes it — this case already worked before any fix', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      const { head, headCtx, spawn, worker, signal } = await spawnWorker(env)
      assert.equal(worker.status, 'idle', 'the control worker is IDLE (deferDisposeMs = 0 -> the immediate arm)')

      await headCtx.ctx.tools.get('dept_worker_retire', headCtx.key).execute({ workerId: spawn.workerId }, { agent: head, signal })

      await waitFor(() => (env.agents.disposeCalls.get(spawn.sessionId) ?? 0) >= 1, 12_000, 'the immediate dispose to run')
      assert.ok((env.agents.disposeCalls.get(spawn.sessionId) ?? 0) >= 1, 'the IDLE retire disposes the handle (the immediate arm — the precedent the deferred arm mirrors)')
      await waitFor(() => !env.agents.store.has(spawn.sessionId), 12_000, 'the idle handle torn down')
      assert.ok(!env.agents.store.has(spawn.sessionId), 'the retired idle worker is gone from the live registry')
    } finally {
      await env.dispose()
    }
  })
})
