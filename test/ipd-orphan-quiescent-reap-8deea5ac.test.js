// dsh-deepartments — WORKER-LIFECYCLE HYGIENE (IPD lane M2 / builder-266,
// 2026-09-10): the CLOSED-ROUND predicate of the `org.offlineReap` boot census
// (the fast lane inside runOfflineWorkerReapReconcile).
//
// MEASURED DEFECT (host-plane measurement, corrected by the previous lane): a
// worker whose round DIES (restart-killed / crashed / drained mid-directive)
// and whose every delivery is TERMINAL is left NON-RETIRED forever in the LIVE
// catalog: it is not archived (the archive is applied by the retire path —
// packages/dshd-orchestration/src/tools.ts:3538), its sidebar row stays visible
// and it is still addressable, while its directives never drain. The existing
// boot census (runOfflineWorkerReapReconcile, tools.ts:4739) DOES stamp it
// offline, but only reaps after the wall-clock `maxOfflineMs` window (72h by
// default) — so the leak compounds (~6 QD inspectors/hour measured).
//
// THE PREDICATE (lane M2 — the B1 REMEDY). The FIRST form of the fast lane
// retired every NON-RETIRED worker with NO live handle, NO sleepEpoch and NO
// delivery row still needing a re-drive (needsRedelivery), asserting «the bus
// delivery is the ONLY wake seam ⇒ a clean queue PROVES death». The QD refuted
// it and this file carries the two columns of the refutation:
//   - a post WITHOUT a live handle is, BY CONTRACT, a DORMANT recipient that a
//     FUTURE delivery RE-MATERIALIZES (delivery.ts:1938-1939 + :1954); the
//     census reads rows of the PRESENT while the wake seam is a row of the
//     FUTURE. MEASURED counterexample: quality-inspector-199 carried
//     `delivered m-4831` @16:46:22Z and was woken by `resumed m-4840`
//     @16:52:03Z — the 16:51:28Z census would have RETIRED it (a durable mark)
//     and that real wake would have died on the DEAD-recipient path
//     (tools.ts:6154-6156);
//   - the NEW predicate demands POSITIVE PROOF OF ABANDONMENT: the round
//     CLOSED at the seam where a round actually closes — the worker's OWN
//     outbound delivery to its MANAGER head (the code's own round-close/retire
//     trigger, delivery.ts:1988-1996 «the delivery itself is the retire
//     trigger») — and NOTHING re-opened the round afterwards. A post with the
//     proof is one the system ALREADY decided to retire and failed to (a
//     missed auto-retire); a mere DORMANT is left to the 72h wall-clock window.
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

process.env.DEEPARTMENTS_QUALITY_INSPECT = '0' // the worker-retire QD dice stays DETERMINISTIC (a directive may emit)

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
  // B2: the forced-failure sets must be armed BEFORE the boot (the boot
  // redelivery pass runs INSIDE loader.await) — the alternative "the redelivery
  // materializes it and the LIVENESS re-check saves it" path is closed.
  // BOTH sets are required: `materializePost` falls back to `agents.create`
  // when the resume throws (delivery.ts:1618-1646), so rejecting only the
  // resume leaves the materialization path OPEN (measured: the row ended
  // 'resumed' with the worker live ⇒ the test proved nothing).
  for (const sessionId of opts.resumeRejects ?? []) agents.resumeRejects.add(sessionId)
  for (const sessionId of opts.createRejects ?? []) agents.createRejects.add(sessionId)
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

/**
 * Q6 (the verdict's non-determinism finding): the previous lane's teardown
 * (`rm(stateDir, {recursive:true, force:true})`) raced a background writer that
 * recreates files in the stateDir and failed with ENOTEMPTY on 1 of 2 runs —
 * read as a fix regression the next day. Fixed on BOTH axes: the deferred
 * writers get a bounded drain window AFTER the caller disposed the plugin, and
 * `rm` retries the transient ENOTEMPTY/EBUSY classes (Node's own maxRetries
 * semantics) instead of surfacing it as a test failure.
 */
async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'lane2-vertical-'))
  try { return await fn(stateDir) } finally {
    await new Promise((resolve) => setTimeout(resolve, 250)) // drain the fire-and-forget writers
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
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

/** Read the durable posts registry (the retire mark is what this lane proves). */
async function readPosts(stateDir) {
  try { return JSON.parse(await readFile(path.join(stateDir, 'posts.json'), 'utf8')) } catch { return {} }
}

/** Read the offline-reap ledger (the 72h window's durable stamp). */
async function readReapLedger(stateDir) {
  try { return JSON.parse(await readFile(path.join(stateDir, 'offline-reap-state.json'), 'utf8')) } catch { return undefined }
}

/** Read the append-only retire-dice ledger (ONE row per retirePost that passes
 * its idempotence guard — the durable per-retire trace: no per-post dedupe). */
function readRetireDice(stateDir) {
  try {
    return readFileSync(path.join(stateDir, 'retire-dice.jsonl'), 'utf8').split('\n').flatMap((line) => {
      if (line.trim() === '') return []
      try { return [JSON.parse(line)] } catch { return [] }
    })
  } catch { return [] }
}

function workerPost(postId, sessionId, extra = {}) {
  return { postId, sessionId, roomId: 'board', agentPreset: 'deepartments-worker', provider: 'worker', role: 'researcher', managerId: 'research-head', departmentId: 'research', ...extra }
}

// ---------------------------------------------------------------------------
// M2 (B1) — THE DISCRIMINATOR: the SAME fixture, the two columns.
//
// ONE boot / ONE stateDir / THREE worker posts, differing ONLY in the shape of
// their delivery history:
//   a. `dormant-199-form` — the MEASURED counterexample shape: its only rows are
//      the INBOUND directives addressed to it (terminal), no handle, no
//      sleepEpoch, clean queue. It is a DORMANT: the next directive wakes it
//      (quality-inspector-199, `resumed m-4840` after `delivered m-4831`).
//      ⇒ MUST NOT be retired (the 72h window owns it).
//   b. `reopened-round-worker` — the ADDENDUM shape: it DID deliver its report
//      to its manager, and THEN a LATER directive was delivered to it (the round
//      re-opened). ⇒ MUST NOT be retired (the proof is invalidated).
//   c. `closed-round-worker` — it delivered its report to its manager and
//      NOTHING happened to it afterwards (the missed auto-retire: measured on
//      quality-inspector-195, whose outbound report `delivered m-4788`
//      @16:34:20Z never turned into a retire). ⇒ MUST be retired at the FIRST
//      census (the lane's original purpose survives).
//
// COLUMN "RED" (the previous predicate, measured literally by reverting the M2
// hunks — see the lane report): (a) is retired at the first census and (b) too
// (the old predicate only asked for a clean queue) ⇒ assertions (a)/(b) FAIL.
// COLUMN "GREEN" (this predicate): (a)/(b) survive, (c) is retired.
// ---------------------------------------------------------------------------
test('M2 (B1 discriminator — the SAME fixture, two columns): the DORMANT 199-form (`delivered` directives only, no handle, clean queue) and the RE-OPENED round (report delivered, then a LATER directive) are NEVER retired — they stay with the 72h window — while a CLOSED-ROUND worker (its own report reached its manager and nothing re-opened it) IS retired at the FIRST census by the SAME shared retirePost seam', async () => {
  await withTempStateDir(async (stateDir) => {
    const now = Date.now()
    const t0 = now - 600_000
    await seedPost(stateDir, workerPost('dormant-199-form', 'worker-dormant-199-form-aaaaaaaa'))
    await seedPost(stateDir, workerPost('reopened-round-worker', 'worker-reopened-round-worker-bbbbbbbb'))
    await seedPost(stateDir, workerPost('closed-round-worker', 'worker-closed-round-worker-cccccccc'))
    await seedMessageRecords(stateDir, [
      // (a) the only event of the dormant: an INBOUND directive, delivered (terminal).
      { id: 'm-dir-a', seq: 0, ts: t0, from: 'research-head', to: ['dormant-199-form'], text: 'directive that died with the restart', kind: 'agent' },
      // (b) the round closed (report to the manager) and was THEN re-opened by a later directive.
      { id: 'm-report-b', seq: 1, ts: t0 + 1000, from: 'reopened-round-worker', to: ['research-head'], text: 'report (round 1)', kind: 'agent' },
      { id: 'm-dir-b', seq: 2, ts: t0 + 2000, from: 'research-head', to: ['reopened-round-worker'], text: 'ADDENDUM directive (round re-opened)', kind: 'agent' },
      // (c) the round closed and NOTHING re-opened it (the missed auto-retire).
      { id: 'm-report-c', seq: 3, ts: t0 + 3000, from: 'closed-round-worker', to: ['research-head'], text: 'report (round closed, retire missed)', kind: 'agent' }
    ])
    await seedDeliveryRows(stateDir, [
      { messageId: 'm-dir-a', recipientId: 'dormant-199-form', status: 'delivered', ts: t0 },
      { messageId: 'm-report-b', recipientId: 'research-head', status: 'delivered', ts: t0 + 1000 },
      { messageId: 'm-dir-b', recipientId: 'reopened-round-worker', status: 'delivered', ts: t0 + 2000 },
      { messageId: 'm-report-c', recipientId: 'research-head', status: 'delivered', ts: t0 + 3000 }
    ])
    // NO pre-seeded ledger (no elapsed offline time at all) — the lane reaps on
    // the ROUND-CLOSE PROOF, never on elapsed wall-clock.
    const { dispose } = await bootPluginFromSrc(stateDir, { org: { ...ORG, offlineReap: { enabled: true } } })
    try {
      await waitFor(async () => (await readPosts(stateDir))['closed-round-worker']?.retired === true, 5000, 'the closed-round worker is auto-reaped at the first census')
      const posts = await readPosts(stateDir)
      // THE TWO COLUMNS IN ONE LITERAL OBSERVATION (so a RED run reports ALL
      // three verdicts, never just the first failing assertion):
      //   RED (the previous predicate «clean queue ⇒ proof of death»):
      //     { dormant: true,  reopened: true,  closed: true }
      //   GREEN (this predicate):
      //     { dormant: false, reopened: false, closed: true }
      const observed = {
        dormant: posts['dormant-199-form']?.retired === true,   // (a) the 199 form MUST survive
        reopened: posts['reopened-round-worker']?.retired === true, // (b) a re-opened round MUST survive
        closed: posts['closed-round-worker']?.retired === true  // (c) the closed round MUST be reaped
      }
      assert.deepEqual(observed, { dormant: false, reopened: false, closed: true }, 'GREEN: (a) the DORMANT 199-form is NOT retired — a future directive can still wake it (quality-inspector-199: `resumed m-4840` after `delivered m-4831`); (b) a round re-opened by a LATER directive (the ADDENDUM shape) is NOT retired; (c) the CLOSED round (its own report reached its manager and nothing re-opened it) IS retired at the FIRST census — mark, never erase')
      assert.equal(posts['closed-round-worker'].sessionId, 'worker-closed-round-worker-cccccccc', 'the registry entry (postId + sessionId) is PRESERVED by the retire mark')
      assert.equal(posts['closed-round-worker'].provider, 'worker', 'the retire never rewrites the entry shape')
      // The dormant forms are LEFT TO THE 72h WALL-CLOCK WINDOW: the census
      // STAMPS them offline (offlineSince) and retires nothing (no elapsed window).
      const ledger = await readReapLedger(stateDir)
      assert.ok(ledger !== undefined && ledger['dormant-199-form'] !== undefined, 'the dormant 199-form IS stamped offline (the 72h window owns it — no proof, no retire)')
      assert.equal(ledger['closed-round-worker'], undefined, 'the retired post is PRUNED from the census ledger (it is no longer a census subject)')
    } finally {
      await dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// M2 (B2) — the PENDING-WAKE branch, with the ALTERNATIVE PATH CLOSED.
//
// The previous lane's control #2 (`:314-332`) did NOT discriminate: the boot
// redelivery could materialize the worker itself, so the post was saved by the
// LIVENESS re-check (:4847) instead of by the pending-row guard (:4844) — the
// assertion held for a reason other than the one it declared.
// Here the resume is FORCED TO FAIL (`StubAgents.resumeRejects`, :141-145), so
// nothing can be materialized and no live handle can ever save the post: the
// pending row is the ONLY thing in its way. The paired post differs ONLY by
// that row (same proof, same absence of a handle) — the pair is the
// discriminator for the pending-wake branch.
// NOTE (the proof's time shape): the pending row is OLDER than the report
// delivery, so it does NOT re-open the round (a NEWER inbound row would, per
// the fixture above) — a realistic shape: a parked noWake/FIFO row, then the
// worker delivered its report and the auto-retire was missed.
// ---------------------------------------------------------------------------
test('M2 (B2 — the pending-wake branch, alternative path CLOSED): with the proof identical and the resume FORCED TO FAIL (no materialization can save it), the worker holding a pending wake row is NEVER fast-laned, while its twin without that row IS retired — the pending row is the ONLY acting guard', async () => {
  await withTempStateDir(async (stateDir) => {
    const now = Date.now()
    const t0 = now - 600_000
    await seedPost(stateDir, workerPost('proof-no-pending', 'worker-proof-no-pending-dddddddd'))
    await seedPost(stateDir, workerPost('proof-pending-wake', 'worker-proof-pending-wake-eeeeeeee'))
    await seedMessageRecords(stateDir, [
      { id: 'm-report-1', seq: 0, ts: t0 + 1000, from: 'proof-no-pending', to: ['research-head'], text: 'report (round closed)', kind: 'agent' },
      { id: 'm-parked', seq: 1, ts: t0, from: 'research-head', to: ['proof-pending-wake'], text: 'PARKED directive (still owes a re-drive)', kind: 'agent' },
      { id: 'm-report-2', seq: 2, ts: t0 + 1000, from: 'proof-pending-wake', to: ['research-head'], text: 'report (round closed)', kind: 'agent' }
    ])
    await seedDeliveryRows(stateDir, [
      { messageId: 'm-report-1', recipientId: 'research-head', status: 'delivered', ts: t0 + 1000 },
      { messageId: 'm-parked', recipientId: 'proof-pending-wake', status: 'prepared', ts: t0 },
      { messageId: 'm-report-2', recipientId: 'research-head', status: 'delivered', ts: t0 + 1000 }
    ])
    const { agents, dispose } = await bootPluginFromSrc(stateDir, {
      org: { ...ORG, offlineReap: { enabled: true } },
      // BOTH the resume AND its create-fallback are rejected (materializePost
      // falls back to agents.create, delivery.ts:1618-1646) ⇒ NOTHING can be
      // materialized and no live handle can ever save the post.
      resumeRejects: ['worker-proof-pending-wake-eeeeeeee'],
      createRejects: ['worker-proof-pending-wake-eeeeeeee']
    })
    try {
      await waitFor(async () => (await readPosts(stateDir))['proof-no-pending']?.retired === true, 5000, 'the twin without a pending row is reaped at the first census')
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const posts = await readPosts(stateDir)
      assert.equal(posts['proof-no-pending']?.retired, true, 'DISCRIMINANT (half 1): the CLOSED-ROUND worker WITHOUT a pending row IS retired (the fast lane is alive — not a no-op fix)')
      assert.notEqual(posts['proof-pending-wake']?.retired, true, 'DISCRIMINANT (half 2): the SAME proof + a pending wake row is NEVER fast-laned (a wake is still owed — the window class owns it)')
      // The alternative path is CLOSED, literally: the redelivery FAILED, so no
      // handle exists for that session and the liveness re-check could not have
      // saved the post.
      const status = await deliveryStatus(stateDir, 'm-parked', 'proof-pending-wake')
      assert.ok(status === 'prepared' || status === 'failed', `DISCRIMINANT: the pending row STILL needs a re-drive (${status} — the forced resume failure keeps it pending; no materialization happened)`)
      assert.equal(agents.store.has('worker-proof-pending-wake-eeeeeeee'), false, 'DISCRIMINANT: the forced resume failure really left the session with NO live handle (the liveness re-check was NOT the guard that saved it)')
    } finally {
      await dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// The OWNER KNOB (the previous lane's control #3, STRENGTHENED): with
// `org.offlineReap.enabled !== true` the WHOLE pass (census + fast lane) does
// not run — and the ledger is NOT rewritten. The fixture now carries a
// WOULD-BE-RETIRED post (a CLOSED ROUND: the exact subject the lane retires
// with the knob ON), so the knob is proven to gate a REAL retire, and the
// pre-seeded ledger sentinel proves `offline-reap-state.json` is byte-identical
// afterwards (the pass never even ran).
// ---------------------------------------------------------------------------
test('M2 (the owner knob, STRENGTHENED): `org.offlineReap.enabled !== true` keeps the WHOLE pass OFF — the WOULD-BE-RETIRED closed-round worker is untouched AND the pre-seeded `offline-reap-state.json` is byte-identical (the pass never ran)', async () => {
  await withTempStateDir(async (stateDir) => {
    const now = Date.now()
    const t0 = now - 600_000
    await seedPost(stateDir, workerPost('knob-off-closed-round', 'worker-knob-off-closed-round-ffffffff'))
    await seedMessageRecords(stateDir, [
      { id: 'm-report-k', seq: 0, ts: t0 + 1000, from: 'knob-off-closed-round', to: ['research-head'], text: 'report (round closed)', kind: 'agent' }
    ])
    await seedDeliveryRows(stateDir, [
      { messageId: 'm-report-k', recipientId: 'research-head', status: 'delivered', ts: t0 + 1000 }
    ])
    const sentinel = JSON.stringify({ 'knob-off-closed-round': { offlineSince: t0, lastSeenOfflineAt: t0 } })
    await writeFile(path.join(stateDir, 'offline-reap-state.json'), sentinel, 'utf8')
    const { dispose } = await bootPluginFromSrc(stateDir, { org: { ...ORG, offlineReap: { enabled: false } } })
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const posts = await readPosts(stateDir)
      assert.notEqual(posts['knob-off-closed-round']?.retired, true, 'the pass is knob-gated: enabled !== true → even a CLOSED-ROUND subject is never fast-laned')
      assert.equal(await readFile(path.join(stateDir, 'offline-reap-state.json'), 'utf8'), sentinel, 'enabled !== true ⇒ the pass did not run AT ALL: offline-reap-state.json is byte-identical (never rewritten)')
    } finally {
      await dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// M2 (B3) — the CONCURRENT double-retire, closed INSIDE retirePost.
//
// retirePost's idempotent guard (`entry.retired === true`, tools.ts:3472) is
// separated from the durable mark (:3507) by an `await`
// (captureRetiredPostTurnError, :3479) ⇒ two CONCURRENT calls for the SAME post
// both pass the guard and both run the worker branch: mark/archive/settle are
// idempotent, but the retire-dice ledger row (:3584) and the `worker-retired`
// QD directive (:3592) have NO per-post dedupe. The boot wiring makes the
// window reachable every boot (`void runOfflineWorkerReapReconcile(); void
// runSchedulerLatchReconcile()`, :5295 — a dead QUIESCENT job worker is a
// subject of BOTH passes); this test drives the same window through the PUBLIC
// tool seam with two concurrent `dept_worker_retire` calls (same tick, same
// awaits before retirePost ⇒ both are inside the window). The fix re-checks
// `entry.retired` AFTER the await (registry.markPostRetired sets the flag
// SYNCHRONOUSLY on the shared entry, registry.ts:1598).
// The durable trace counted is `retire-dice.jsonl`: ONE row per retirePost that
// passes the guard (the QD directive is disabled in this run —
// DEEPARTMENTS_QUALITY_INSPECT=0 — so the dice row is the write-per-retire
// trace; NOT measured: the directive count).
// ---------------------------------------------------------------------------
test('M2 (B3 — the concurrent double-retire): two concurrent `dept_worker_retire` calls for the SAME worker complete idempotently and leave EXACTLY ONE retire-dice row (the re-check after the await closes the guard→mark window)', async () => {
  await withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const head = env.agents.store.get('head-research-head')
      const headCtx = childContextFor(env.agents, 'head-research-head')
      assert.ok(headCtx, 'the head own-layer context resolves')
      const signal = new AbortController().signal
      const spawn = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'b3 concurrency fixture' }, { agent: head, signal })
      assert.ok(spawn.workerId, `the worker spawned (${spawn.workerId})`)
      await waitFor(() => env.agents.store.has(spawn.sessionId), 8000, 'the worker is live')
      const retireTool = headCtx.ctx.tools.get('dept_worker_retire', headCtx.key)
      const [first, second] = await Promise.all([
        retireTool.execute({ workerId: spawn.workerId }, { agent: head, signal }),
        retireTool.execute({ workerId: spawn.workerId }, { agent: head, signal })
      ])
      assert.equal(first.retired, true, 'the first concurrent retire reports retired:true (the idempotent contract is preserved)')
      assert.equal(second.retired, true, 'the second concurrent retire reports retired:true (no-op, NOT an error — the idempotent contract is preserved)')
      const diceForWorker = readRetireDice(stateDir).filter((row) => row.postId === spawn.workerId)
      assert.equal(diceForWorker.length, 1, `EXACTLY ONE retire-dice row for the worker (${diceForWorker.length}) — a double retire would append two (no per-post dedupe on the dice/directive)`)
      const posts = JSON.parse(await readFile(path.join(stateDir, 'posts.json'), 'utf8'))
      assert.equal(posts[spawn.workerId]?.retired, true, 'the worker is marked retired (mark, never erase)')
    } finally {
      await env.dispose()
    }
  })
})
