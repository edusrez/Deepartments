// dsh-deepartments — LANE R10 (2026-09-05, run token a92f055b): «clobber
// hide-set sidebar (workspace.json)» — fb-82 (medio): the daemon REPUBLISHES
// the durable workspace domain file (`<stateHome>/storages/workspace.json`)
// FROM MEMORY on every domain mutation (dsh-storage-json JsonKvUnit.publish —
// a whole-file atomic rewrite that never re-reads the file: no watcher, no
// merge), so a DIRECT EDIT of the sidebar hide-set (`global.archivedSessionIds`)
// is clobbered by the next mutation. The builder-36 case: 4 smoke ids added by
// direct file edit were REVERTED by the archiveSession of his own auto-retire —
// the archive's republish carried the boot-time memory (without the 4 ids).
//
// The fix (R10, dshd-core session-rotation.ts + the two dshd-orchestration
// archive wrappers + the bundle path resolver): EVERY deepartments archive
// seam is now HIDE-SET-SAFE — before calling `registry.archiveSession`, the
// DURABLE archivedSessionIds (direct edits included) are RE-ABSORBED into the
// registry's in-memory state VIA THE CANONICAL API
// (`reconcileWorkspaceHideSet` → `archiveSession` per disk id — idempotent at
// the service: an already-archived id early-returns BEFORE any write,
// dsh-workspace lib/index.js:422-432). The next republish then carries the
// MERGED set: a later archive NEVER loses a hide-set entry. The daemon never
// edits the file directly (fb-78 design note). Design = option (a) of the
// lane: MERGE with the disk state, additive + never-throw (the R4
// recordToolAbortInterruptDetail pattern: read-before-write, tool-intents.ts).
// Option (b) compare-and-skip is ALREADY the service's own no-op discipline
// (the already-archived early return + the entity.mutate unchangedSentinel) —
// the guard's skip-absorb (only disk ids missing from memory are re-archived)
// rests on it, and the no-write-if-unchanged test (iii) asserts the stable
// mtime/content of a repeat archive.
//
// Test layout (the R4/lane2 src-native pattern — self-registered ts-src-loader,
// helpers unit-tested against the PACKAGE SRC, the wiring through the REAL
// Loader with the bundle from src):
//   (i)   direct edit preserved after a session mutation (the merge is real) +
//         the CLOBBER CONTROL (an UNGUARDED archive loses the edit — fb-82);
//   (ii)  archivedSessionIds ACCUMULATIVE (2+ archives, none lost; an
//         interleaved direct edit between archives also survives);
//   (iii) no-write when nothing changed (already-archived id + nothing to
//         reconcile → writes counter 0, file mtime/content stable);
//   (iv)  idempotence of the merge (double-run absorbs 0, content identical);
//   +     readWorkspaceArchivedIds robustness (absent/malformed → []);
//   +     archiveOldSession 4-arg hide-set-safe / 3-arg legacy zero-regression;
//   +     E2E through the REAL Loader: a direct edit seeded at the RESOLVED
//         workspace.json precedes a dept_worker_retire — the retire archives
//         the worker AND the direct edit survives (the fb-82 class end-to-end).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLE_SRC = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href

// The R10 PURE half — imported directly from the dshd-core package SRC
// (ts-src-loader): the hide-set merge guard + the workspace.json path resolver.
const SR = await import('../packages/dshd-core/src/session-rotation.ts')
const {
  workspaceStatePathForSessionsRoot,
  readWorkspaceArchivedIds,
  reconcileWorkspaceHideSet,
  archiveSessionPreservingHideSet,
  archiveOldSession
} = SR

// The retire QD dice stays deterministic (a retire may emit a directive).
process.env.DEEPARTMENTS_QUALITY_INSPECT = '1'

const ORG = {
  departments: [
    {
      id: 'research',
      name: 'Research',
      coordinator: { postId: 'research-head', role: 'Research department head', provider: 'deepseek-official', agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' } }
    }
  ]
}

// --- the faithful registry/sidebar stub --------------------------------------
// Models the REAL dsh-workspace registry + dsh-storage-json backend as fb-82
// documents them: the registry keeps the hide-set IN MEMORY; archiveSession
// early-returns on an already-archived id BEFORE any write (the service's own
// compare-and-skip, dsh-workspace lib:422-432); a NEW archive appends to
// memory and PUBLISHES the whole domain file FROM MEMORY (JsonKvUnit.publish —
// atomic, no re-read, no merge) in the EXACT runtime document shape
// ({unit, global:{initialized, workspaceIds, archivedSessionIds}, tables}).
class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir, stateFile) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.stateFile = stateFile
    this.archived = []          // the IN-MEMORY hide-set (boot-time state)
    this.writes = 0             // publish counter — the (iii) no-write probe
    this.lastWriteMs = 0
    this.attachCalls = []
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
  async create(path_, title) {
    const existing = this.entities.find((e) => e.path === path_)
    if (existing !== undefined) return existing
    const entity = { path: path_, title, sessionIds: [], attachSession: async (sessionId) => { this.attachCalls.push(sessionId); if (!entity.sessionIds.includes(sessionId)) entity.sessionIds.push(sessionId) } }
    this.entities.push(entity)
    return entity
  }
  async resolveByPath(path_) { return this.entities.find((e) => e.path === path_) }
  async archiveSession(sessionId) {
    // The service's OWN compare-and-skip: an already-archived id early-returns
    // BEFORE any write (dsh-workspace lib/index.js:422-432) — the (iii) basis.
    if (this.archived.includes(sessionId)) return
    this.archived.push(sessionId)
    await this.publish()
  }
  async publish() {
    // JsonKvUnit.publish — a WHOLE-FILE rewrite FROM MEMORY (fb-82): without
    // the R10 guard, a direct edit to the file is clobbered by this rewrite.
    this.writes++
    this.lastWriteMs = Date.now()
    const doc = {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [...this.archived] },
      tables: { workspaces: {} }
    }
    await writeFile(this.stateFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  }
}

function domainDoc(archivedSessionIds) {
  return JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds },
    tables: { workspaces: {} }
  }, null, 2) + '\n'
}

async function readHideSetFromFile(stateFile) {
  const doc = JSON.parse(await readFile(stateFile, 'utf8'))
  return doc.global.archivedSessionIds
}

const quietLogger = () => {
  const calls = { warn: [], error: [] }
  return {
    calls,
    warn: (m) => calls.warn.push(m),
    error: (m) => calls.error.push(m)
  }
}

/** A bare ctx for the PURE unit stubs (the cordis Service ctor only touches
 * `ctx.reflect.provide` — a plain no-op object is enough; no Loader needed). */
const bareCtx = () => ({ reflect: { provide: () => {} } })

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-r10-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

// --- R10 pure unit tests (over the package SRC — the rotation.test.js shape) ---

test('R10/0: workspaceStatePathForSessionsRoot resolves the durable workspace.json beside the projection mirror (the storages layout)', () => {
  assert.equal(workspaceStatePathForSessionsRoot('/state-home/sessions'), '/state-home/storages/workspace.json')
  assert.equal(workspaceStatePathForSessionsRoot('/tmp/x/sessions'), '/tmp/x/storages/workspace.json')
})

test('R10/1 (i): a DIRECT EDIT of archivedSessionIds SURVIVES a subsequent session mutation (the guarded archive MERGES before writing) — and the CLOBBER CONTROL proves an UNGUARDED archive loses it (the fb-82 builder-36 class)', async () => {
  await withTempStateDir(async (stateDir) => {
    const stateFile = path.join(stateDir, 'storages', 'workspace.json')
    await mkdir(path.dirname(stateFile), { recursive: true })
    const registry = new StubWorkspaceRegistry(bareCtx(), stateDir, stateFile)
    // The direct edit (builder-36: 4 smoke ids added by hand AFTER the daemon
    // booted — the daemon's in-memory hide-set does NOT contain them).
    await writeFile(stateFile, domainDoc(['session-smoke-1', 'session-smoke-2', 'session-smoke-3', 'session-smoke-4']), 'utf8')
    assert.deepEqual(registry.archived, [], 'the daemon memory does NOT know the direct edit (it booted before the edit)')

    // CLOBBER CONTROL — the UNGUARDED path (the pre-R10 behavior): a plain
    // archiveSession republishes FROM MEMORY and the 4 direct-edit ids vanish.
    await registry.archiveSession('session-worker-x')
    assert.deepEqual(await readHideSetFromFile(stateFile), ['session-worker-x'], 'CLOBBER CONTROL: an unguarded archive wipes the direct edit (fb-82)')

    // The FIXED path: seed the edit again, run the GUARDED archive.
    await writeFile(stateFile, domainDoc(['session-smoke-1', 'session-smoke-2', 'session-smoke-3', 'session-smoke-4']), 'utf8')
    registry.archived.length = 0
    registry.writes = 0
    const logger = quietLogger()
    const ok = await archiveSessionPreservingHideSet(registry, 'session-worker-x', stateFile, logger)
    assert.equal(ok, true, 'the guarded archive resolves true')
    // The merge: the 4 direct-edit ids are re-absorbed VIA THE API (they now
    // live in the registry memory) and the archive's own republish carries the
    // MERGED set — the direct edit is preserved.
    const after = await readHideSetFromFile(stateFile)
    assert.deepEqual(after, ['session-smoke-1', 'session-smoke-2', 'session-smoke-3', 'session-smoke-4', 'session-worker-x'], '(i) the direct edit SURVIVES the mutation (merge real)')
    assert.deepEqual([...registry.archived], after, 'the merged state went through the canonical API (memory == file)')
    assert.ok(logger.calls.warn.some((m) => /absorbed 4 direct-edit archived session id/.test(m)), 'the merge reports what it absorbed')
  })
})

test('R10/2 (ii): archivedSessionIds is ACCUMULATIVE — 2+ archives, none lost, and an interleaved direct edit between archives also survives', async () => {
  await withTempStateDir(async (stateDir) => {
    const stateFile = path.join(stateDir, 'storages', 'workspace.json')
    await mkdir(path.dirname(stateFile), { recursive: true })
    const registry = new StubWorkspaceRegistry(bareCtx(), stateDir, stateFile)
    await writeFile(stateFile, domainDoc(['session-direct-a']), 'utf8')

    assert.equal(await archiveSessionPreservingHideSet(registry, 'session-worker-1', stateFile), true)
    assert.equal(await archiveSessionPreservingHideSet(registry, 'session-worker-2', stateFile), true)
    let set = await readHideSetFromFile(stateFile)
    assert.deepEqual(set, ['session-direct-a', 'session-worker-1', 'session-worker-2'], '(ii) 2 archives + the initial direct edit — nothing lost')

    // An ANOTHER direct edit between archives (the builder-36 recurring class).
    await writeFile(stateFile, domainDoc([...set, 'session-direct-b']), 'utf8')
    assert.equal(await archiveSessionPreservingHideSet(registry, 'session-worker-3', stateFile), true)
    set = await readHideSetFromFile(stateFile)
    assert.deepEqual(set, ['session-direct-a', 'session-worker-1', 'session-worker-2', 'session-direct-b', 'session-worker-3'], '(ii) an interleaved direct edit also survives the next archive')
    assert.deepEqual([...registry.archived], set, 'memory and file agree (API-only mutations)')
  })
})

test('R10/3 (iii): NO-WRITE when nothing changed — a repeat archive of an already-archived id with nothing to reconcile performs ZERO publishes (mtime/content stable)', async () => {
  await withTempStateDir(async (stateDir) => {
    const stateFile = path.join(stateDir, 'storages', 'workspace.json')
    await mkdir(path.dirname(stateFile), { recursive: true })
    const registry = new StubWorkspaceRegistry(bareCtx(), stateDir, stateFile)
    await writeFile(stateFile, domainDoc(['session-a', 'session-b']), 'utf8')
    assert.equal(await archiveSessionPreservingHideSet(registry, 'session-c', stateFile), true)
    const mtimeAfterFirst = (await stat(stateFile)).mtimeMs
    const contentAfterFirst = await readFile(stateFile, 'utf8')
    // Fully merged: memory == disk == [a,b,c]. Re-archive 'session-c' — the
    // reconcile absorbs NOTHING (every disk id is already in memory; no
    // redundant call) and the archive itself early-returns (already archived)
    // → the service performs ZERO writes → mtime/content stable.
    const writesBefore = registry.writes
    assert.equal(await archiveSessionPreservingHideSet(registry, 'session-c', stateFile), true)
    assert.equal(registry.writes, writesBefore, '(iii) the repeat archive performed NO publish (already archived + nothing to reconcile)')
    assert.equal((await stat(stateFile)).mtimeMs, mtimeAfterFirst, '(iii) file mtime is stable')
    assert.equal(await readFile(stateFile, 'utf8'), contentAfterFirst, '(iii) file content is stable')
  })
})

test('R10/4 (iv): the merge is IDEMPOTENT — a double-run absorbs 0 on the second pass and the file content is identical', async () => {
  await withTempStateDir(async (stateDir) => {
    const stateFile = path.join(stateDir, 'storages', 'workspace.json')
    await mkdir(path.dirname(stateFile), { recursive: true })
    const registry = new StubWorkspaceRegistry(bareCtx(), stateDir, stateFile)
    await writeFile(stateFile, domainDoc(['session-x', 'session-y']), 'utf8')
    await reconcileWorkspaceHideSet(registry, stateFile)
    const first = await readHideSetFromFile(stateFile)
    assert.deepEqual(first, ['session-x', 'session-y'], 'first merge absorbed the direct edit into memory')
    // Second pass: every disk id is already in memory → 0 absorbs, 0 writes.
    const writesBefore = registry.writes
    const absorbedSecond = await reconcileWorkspaceHideSet(registry, stateFile)
    assert.deepEqual(absorbedSecond, ['session-x', 'session-y'], '(iv) the second pass still reports the disk set (the read is stable)')
    assert.equal(registry.writes, writesBefore, '(iv) the second pass performed NO publish')
    assert.deepEqual(await readHideSetFromFile(stateFile), first, '(iv) file content identical after the second pass')
    assert.deepEqual([...registry.archived], ['session-x', 'session-y'], '(iv) memory unchanged')
  })
})

test('R10/5: readWorkspaceArchivedIds is robust — absent/malformed/unexpected-shape files degrade to [] (the reconcile then no-ops)', async () => {
  await withTempStateDir(async (stateDir) => {
    assert.deepEqual(await readWorkspaceArchivedIds(path.join(stateDir, 'nope.json')), [], 'absent file → []')
    const malformed = path.join(stateDir, 'malformed.json')
    await writeFile(malformed, 'not json{', 'utf8')
    assert.deepEqual(await readWorkspaceArchivedIds(malformed), [], 'malformed JSON → []')
    const wrongShape = path.join(stateDir, 'wrong-shape.json')
    await writeFile(wrongShape, JSON.stringify({ global: { archivedSessionIds: 'nope' } }), 'utf8')
    assert.deepEqual(await readWorkspaceArchivedIds(wrongShape), [], 'non-array archivedSessionIds → []')
    const empty = path.join(stateDir, 'empty.json')
    await writeFile(empty, domainDoc([]), 'utf8')
    assert.deepEqual(await readWorkspaceArchivedIds(empty), [], 'a real doc with an empty set → []')
  })
})

test('R10/6: a missing registry or a failing archive degrades silently (false + warn — the non-fatal discipline), and the reconcile never throws', async () => {
  await withTempStateDir(async (stateDir) => {
    const stateFile = path.join(stateDir, 'storages', 'workspace.json')
    await mkdir(path.dirname(stateFile), { recursive: true })
    await writeFile(stateFile, domainDoc(['session-a']), 'utf8')
    const logger = quietLogger()
    assert.equal(await archiveSessionPreservingHideSet(undefined, 'session-z', stateFile, logger), false, 'no registry → false')
    assert.ok(logger.calls.warn.some((m) => /workspaceRegistry unavailable/.test(m)), 'the miss is warned')
    // A registry whose archiveSession rejects: the guard returns false + error.
    const failing = { archiveSession: async () => { throw new Error('boom') } }
    const logger2 = quietLogger()
    assert.equal(await archiveSessionPreservingHideSet(failing, 'session-z', stateFile, logger2), false, 'a failing call → false')
    assert.ok(logger2.calls.error.some((m) => /archiveSession\(session-z\) failed/.test(m)), 'the failure is logged non-fatally')
    // reconcileWorkspaceHideSet with a MISSING registry: degrades (warn, no throw).
    const logger3 = quietLogger()
    const found = await reconcileWorkspaceHideSet(undefined, stateFile, logger3)
    assert.deepEqual(found, ['session-a'], 'the disk set is still reported')
    assert.ok(logger3.calls.warn.some((m) => /hide-set reconcile skipped/.test(m)), 'the unavailable registry is warned')
  })
})

test('R10/7: archiveOldSession is hide-set-safe in the 4-arg form (the rotation archive preserves direct edits) and keeps the exact 3-arg legacy behavior', async () => {
  await withTempStateDir(async (stateDir) => {
    const stateFile = path.join(stateDir, 'storages', 'workspace.json')
    await mkdir(path.dirname(stateFile), { recursive: true })
    const registry = new StubWorkspaceRegistry(bareCtx(), stateDir, stateFile)
    await writeFile(stateFile, domainDoc(['session-direct-rot']), 'utf8')
    const logger = quietLogger()
    // 4-arg (the rotation wiring passes the derived path): the direct edit
    // survives the rotation's OWN archive of the old host session.
    const result = await archiveOldSession(registry, 'session-old-host', logger, stateFile)
    assert.deepEqual(result, { ok: true })
    assert.deepEqual(await readHideSetFromFile(stateFile), ['session-direct-rot', 'session-old-host'], 'the rotation archive preserves the direct edit (hide-set safe)')
    // 3-arg legacy: EXACTLY the pre-R10 behavior (zero regression) — the call
    // archives WITHOUT any reconcile: the direct edit is NOT read/absorbed
    // (the republisher writes memory + the new id — the pre-R10 clobber class
    // stays intact for callers that pass no state file).
    const registry2 = new StubWorkspaceRegistry(bareCtx(), stateDir, stateFile)
    await writeFile(stateFile, domainDoc(['session-direct-legacy']), 'utf8')
    const legacy = await archiveOldSession(registry2, 'session-old-host-2', logger)
    assert.deepEqual(legacy, { ok: true })
    assert.deepEqual(registry2.archived, ['session-old-host-2'], '3-arg legacy archives the old id')
    assert.deepEqual(await readHideSetFromFile(stateFile), ['session-old-host-2'], '3-arg legacy performs NO reconcile (the direct edit is not read — the exact pre-R10 semantics)')
    // Missing registry → the exact pre-R10 { ok:false, reason }.
    const miss = await archiveOldSession(undefined, 'session-old-host-3', logger)
    assert.equal(miss.ok, false)
    assert.ok(/workspaceRegistry unavailable/.test(miss.reason ?? ''), 'the legacy miss reason is preserved')
  })
})

// --- the REAL-Loader E2E (the bundle from src — the fb-82 class end-to-end) ---

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

class StubPersistenceWithRoot extends Service {
  constructor(ctx, root) {
    super(ctx, 'sessionPersistence')
    this.root = root
    this.createCalls = []
    this.appendCalls = []
  }
  async create(meta) { this.createCalls.push(meta) }
  async append(id, events) { this.appendCalls.push({ id, events }) }
  async inspect(childId) {
    const parentSession = postAdoption.get(childId)
    if (parentSession === undefined) throw new Error('stub persistence: no stored session')
    return { meta: { parentSession, seedLength: 0 }, events: [{ type: 'subagent/descriptor', data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'board-post' } }] }
  }
  async list() { return [] }
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
  // R10: the persistence carries a REAL sessions ROOT inside the temp state dir,
  // so the bundle's resolveWorkspaceStatePath(stateDir, persistence.root)
  // resolves the EXACT file the test seeds (the storages layout).
  const rootDir = path.join(stateDir, 'sessions')
  const persistence = new StubPersistenceWithRoot(root, rootDir)
  const stateFile = workspaceStatePathForSessionsRoot(rootDir)
  const workspaceRegistry = new StubWorkspaceRegistry(root, stateDir, stateFile)
  await root.plugin(SubagentRuntime)
  const spawnStub = stubProvider('spawn')
  const forkStub = stubProvider('fork')
  root.subagents.registerProvider(spawnStub)
  root.subagents.registerProvider(forkStub)
  loader.create({ id: 'deepartments', name: BUNDLE_SRC, config: { stateDir, org: opts.org ?? ORG } })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return { root, agents, persistence, workspaceRegistry, stateFile, spawnStub, forkStub, pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx, dispose: () => loaderFiber.dispose() }
}

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function childContextFor(agents, sessionId) {
  const index = agents.childAgents.findIndex((agent) => agent && agent.id === sessionId)
  if (index < 0) return undefined
  return { ctx: agents.childContexts[index].ctx, key: agents.childContexts[index].key }
}

async function withTempStateDirForBoot(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-r10-boot-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

test('R10/8 (E2E, REAL Loader): a DIRECT EDIT of workspace.json archivedSessionIds seeded BEFORE a dept_worker_retire SURVIVES the retire archive — the daemon archives the worker AND the direct edit (the fb-82 builder-36 class end-to-end)', async () => {
  await withTempStateDirForBoot(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      // The head materializes at boot (the bundle ensureAllHeads).
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const head = env.agents.store.get('head-research-head')
      const { ctx: headCtx, key } = childContextFor(env.agents, 'head-research-head')
      const signal = new AbortController().signal

      // The head spawns a disposable worker (real tool through the own layer).
      const createTool = headCtx.tools.get('dept_post_create', key)
      assert.ok(createTool, 'dept_post_create installed in the head own layer')
      const created = await createTool.execute({ postId: 'r10-worker', role: 'rank-and-file researcher' }, { agent: head, signal })
      const sid = created.sessionId
      assert.match(sid, /^worker-r10-worker-/, 'the worker mints the unique worker-<postId>-<uuid> session id')
      assert.deepEqual(env.workspaceRegistry.archived, [], 'before the direct edit + retire the hide-set is empty in daemon memory')

      // THE DIRECT EDIT (builder-36 class): 4 smoke session ids added by hand
      // to the DURABLE file AFTER the daemon booted — the daemon memory does
      // not know them. The file is at the EXACT path the bundle resolves
      // (resolveWorkspaceStatePath(stateDir, persistence.root) — storages/).
      await mkdir(path.dirname(env.stateFile), { recursive: true })
      await writeFile(env.stateFile, domainDoc(['session-smoke-1', 'session-smoke-2', 'session-smoke-3', 'session-smoke-4']), 'utf8')

      // The RETIRE — the very mutation that reverted builder-36's edit (the
      // archiveSession of his own auto-retire). With R10 the archive seam is
      // hide-set-safe: the durable ids are re-absorbed via the canonical API
      // BEFORE the archive's write, so the republish carries the MERGED set.
      const retireTool = headCtx.tools.get('dept_worker_retire', key)
      assert.ok(retireTool, 'dept_worker_retire installed in the head own layer')
      const result = await retireTool.execute({ workerId: 'r10-worker' }, { agent: head, signal })
      assert.equal(result.retired, true)
      assert.equal(result.archived, true, 'the retire requested the durable session archive')

      await waitFor(async () => {
        try { return (await readHideSetFromFile(env.stateFile)).includes(sid) } catch { return false }
      }, 5000, 'the worker id lands in the durable hide-set')
      const set = await readHideSetFromFile(env.stateFile)
      // The 4 direct-edit ids SURVIVE + the worker id is ADDED (accumulative).
      for (const id of ['session-smoke-1', 'session-smoke-2', 'session-smoke-3', 'session-smoke-4', sid]) {
        assert.ok(set.includes(id), `hide-set keeps "${id}" (direct edits preserved, worker archived)`)
      }
      assert.deepEqual([...env.workspaceRegistry.archived], set, 'daemon memory and the durable file agree (API-only mutations)')

      // Idempotent + no-write: a SECOND retire of the already-archived worker
      // (nothing to reconcile, already archived) performs NO publish — the
      // file mtime/content stay stable.
      const mtimeBefore = (await stat(env.stateFile)).mtimeMs
      const contentBefore = await readFile(env.stateFile, 'utf8')
      const writesBefore = env.workspaceRegistry.writes
      const again = await retireTool.execute({ workerId: 'r10-worker' }, { agent: head, signal })
      assert.equal(again.retired, true)
      assert.equal(again.archived, true)
      assert.equal(env.workspaceRegistry.writes, writesBefore, 'the repeat retire performed NO publish (already archived + nothing to reconcile)')
      assert.equal((await stat(env.stateFile)).mtimeMs, mtimeBefore, 'the repeat retire left the file mtime stable')
      assert.equal(await readFile(env.stateFile, 'utf8'), contentBefore, 'the repeat retire left the file content stable')
    } finally {
      await env.dispose()
    }
  })
})