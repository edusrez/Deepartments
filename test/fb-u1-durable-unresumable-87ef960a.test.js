// dsh-deepartments — U1 (2026-09-21, run token 87ef960a): the DURABLE-BUT-NOT-
// RESUMABLE guard of the DELIVERY route (`materializePost`, the delivery
// factory) — the SECOND half of the «resistencia de arranque» fix whose FIRST
// half already lives in the tools factory (`ensureHead`, tools.ts:4439-4451
// via `isExistingSessionError`).
//
// THE CLASS. A durable session artifact EXISTS but the harness refuses to
// resume it (0.1.5 rejects migrating a v2 log: «format v2 surface before first
// step cannot acquire a system head without changing chronology»). The
// resume→create fallback then calls `agents.create` on the SAME id and the
// strict 0.1.5 create throws SessionAlreadyExistsError. In the tools route that
// error escalated to a FATAL LOAD FAILURE → exit 1 → the systemd restart loop
// (the host-amnesia incident). In the DELIVERY route the very same shape had
// NO guard: `materializePost` propagated it to its caller.
//
// WHAT THIS TEST PROVES (EXECUTED, never read):
//   r1 — the GUARD: resume fails (not resumable) AND the same-id create throws
//        the existing-session error ⇒ NO throw bubbles out; the materialization
//        RECOVERS by ROTATING to a FRESH id and creating THAT (its history
//        intact in the old artifact), and the wake still lands.
//   r2 — THE MANDATORY POSITIVE CONTROL: the SAME path with an UNRELATED error
//        (a generic Error) MUST PROPAGATE. A guard that swallowed everything
//        would have turned the alarm OFF instead of fixing it — r2 is the test
//        that fails if the guard is written as a bare `catch {}`.
//   r3 — the SPACE of the predicate itself: the harness error NAMES and the
//        message forms it must recognize, and the near-misses it must NOT.
//
// THE SEAM. `reassertPostToolset` (the boot-heal surface member) is the caller
// that reaches `materializePost` WITHOUT a try/catch — so it is the exact
// observable of "did the error escape the delivery route?". It is driven over
// the REAL delivery factory with stub deps (the dual-surface stub pattern of
// test/fb132-retired-flavor.test.js + test/toolset-reassert.test.js), a temp
// stateDir, and a stub agents service that models the persistence exactly:
// resume() rejects with the v2-migration error, create() rejects with the
// existing-session error for the OLD id (or the injected unrelated error).
//
// src-native (0 builds): this file self-registers the ts-src-loader hook and
// imports ONLY `src/` trees (the lane-② property of test/r6-ladder-flat.test.js).
import { register } from 'node:module'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createDeliveryOrchestration, isExistingSessionError } from '../packages/dshd-orchestration/src/delivery.ts'
import { appendToolsetAudit } from '../src/toolset-audit.ts'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb-u1-durable-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

// --- the REAL literals of the incident ------------------------------------
/** The migrator literal of the v2→v3 jump (the resume refusal). */
const V2_MIGRATION_ERROR = 'format v2 surface before first step cannot acquire a system head without changing chronology'
/** The strict-create refusal when the durable id already EXISTS. */
const createAlreadyExists = (sessionId) => new Error(`session "${sessionId}" already exists`)

const ARMED_ALL = ['send_message', 'agent_messages', 'dept_who', 'dept_memo_write', 'dept_feedback',
  'dept_calendar_add', 'dept_calendar_list', 'dept_calendar_remove',
  'dept_feedback_list', 'dept_feedback_update', 'dept_post_create', 'dept_post_retire',
  'dept_worker_spawn', 'dept_worker_retire', 'dept_job_list', 'dept_job_run', 'dept_monitor_list', 'secretary']

function makeStubAgent(id, { armed = [], status = 'idle' } = {}) {
  const agent = {
    id,
    status,
    session: { header: { id } },
    inboxMessages: [],
    followup(message) { this.inboxMessages.push(message) },
    steer() {}, cancel() {},
    whenIdle() { return new Promise(() => {}) }
  }
  agent.ctx = {
    agent,
    __armed: [...armed],
    tools: {
      get: (name) => (agent.ctx.__armed.includes(name) ? { name } : undefined),
      register: () => () => {},
      restrict: () => () => {}
    },
    get: () => undefined,
    on: () => {}
  }
  return agent
}

/** The stub agents service modelling the persistence contract under test:
 * `resume` ALWAYS rejects (the durable artifact is not resumable — the
 * incident shape), and `create` rejects with `createErrorFor(id)` when set. */
function stuckAgents(registry, { createErrorFor = undefined, resumeError = undefined } = {}) {
  const calls = { create: [], resume: [] }
  return {
    calls,
    get: (id) => registry.get(id),
    list: () => [...registry.values()],
    roots: () => [...registry.values()],
    async resume(options) {
      calls.resume.push(options.resumeSessionId)
      throw resumeError ?? new Error(V2_MIGRATION_ERROR)
    },
    async create(options) {
      calls.create.push(options.sessionId)
      const rejection = createErrorFor?.(options.sessionId)
      if (rejection !== undefined) throw rejection
      const agent = makeStubAgent(options.sessionId, { armed: [], status: 'idle' })
      await options.setup?.(agent.ctx)
      registry.set(options.sessionId, agent)
      return { agent, dispose: async () => { registry.delete(options.sessionId) } }
    }
  }
}

function buildDelivery(stateDir, { agents, byPost, registry }) {
  const logs = { info: [], warn: [] }
  const ctx = {
    logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)), error() {}, debug() {}, success() {} },
    get: () => undefined,
    on: () => {}
  }
  // The bundle-owned handles: `disposeHeadHandle` releases the registry entry
  // (the real AgentHandle teardown), which is what makes the reassertion guard
  // return 'disposed' → the wake FALLS THROUGH to the cold `materializePost`
  // (the route under test). A no-op dispose would take the 'rearmed' path and
  // never reach it.
  const byHeadHandle = new Map()
  const disposeHeadHandle = async (sessionId) => {
    const handle = byHeadHandle.get(sessionId)
    if (handle === void 0) return
    byHeadHandle.delete(sessionId)
    try { await handle.dispose() } catch { /* idempotent */ }
  }
  const surface = createDeliveryOrchestration(ctx, {
    stateDir,
    agents,
    byPost,
    hosts: new Map(),
    byChild: new Map(),
    byHeadHandle,
    headProgress: new Map(),
    wakePackInjected: new Set(),
    deferredSleepReplace: new Map(),
    registerEntry: () => {},
    coordinatorForPost: () => undefined,
    departmentForEntry: () => undefined,
    departmentForPost: () => undefined,
    headSetup: () => async () => {},
    workerSetup: () => async () => {},
    resolveRoleTemplate: async () => undefined,
    resolveMaterializeAgentOptions: (o) => o ?? {},
    resolveDepartmentWorkspaceCwd: async () => '',
    resolveWorkspaceRootPath: async () => '',
    rotateArchivedHeadSessionId: async () => undefined,
    retirePost: async () => ({ postId: '', retired: true }),
    pinSessionTitle: () => 'pinned',
    disposeHeadHandleOnce: async () => {},
    disposeJoinTimeoutMs: () => 10_000,
    joinHeadDisposeOnce: async () => true,
    serializeHeadRecovery: async (_s, task) => task(),
    isHeadStuck: () => false,
    disposeHeadHandle,
    markHeadProgress: () => {},
    attachHeadSession: async () => {},
    workerReasoningContentPreflightError: () => undefined,
    workerPoolerDispatchBlockError: () => undefined,
    ensureHost: () => '',
    persistPosts: async () => {},
    persistHosts: () => {},
    journalPathFor: () => '',
    writeJournal: async () => '',
    readJournal: async () => undefined,
    bumpHostSleepCounter: async () => '',
    bumpPostSleepCounter: async () => '',
    archivePostSessionOnSleep: async () => true,
    hostForSession: new Map(),
    hostIdForSession: () => '',
    postIdForChild: () => undefined,
    repairHostWorkspaceAttach: async () => {},
    qualityWorkerInspectProbability: 0.25,
    PRESET_ID: 'deepartments-head',
    WORKER_PRESET_ID: 'deepartments-worker',
    WORKER_AGENT_OPTIONS: { provider: 'opencode-zen', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    HOST_AGENT_OPTIONS: { provider: 'opencode-zen', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    HEAD_DEFAULT_SESSION_TITLE: 'Research Head',
    STUCK_HEAD_MS: 60_000,
    appendToolsetAudit
  })
  surface.__logs = logs
  surface.__byHeadHandle = byHeadHandle
  return surface
}

/** The incident entry: a DURABLE head whose session cannot be resumed.
 * An UNARMED live handle makes `reassertPostToolset` dispose it and fall
 * through to the COLD `materializePost` — the exact route under test. */
function durableHead(postId, sessionId) {
  return { postId, sessionId, roomId: 'board', agentPreset: 'deepartments-head' }
}

// ===========================================================================
// r1 — THE GUARD: durable-but-not-resumable does NOT abort. The materialization
// RECOVERS by rotating to a FRESH id; the wake lands; nothing is thrown.
// ===========================================================================
test('fb-u1 (r1) GUARD: a DURABLE session that EXISTS but is NOT resumable does NOT abort the materialization — the delivery route ROTATES to a fresh id (the old artifact untouched) and the wake lands (busDeliverToPost → delivered, never a throw)', async () => {
  await withTempStateDir(async (stateDir) => {
    const OLD = 'head-research-head'
    const byPost = new Map()
    const registry = new Map()
    const entry = durableHead('research-head', OLD)
    byPost.set(entry.postId, entry)
    // The live-but-UNARMED handle: the reassertion guard disposes it and the
    // wake falls through to the cold materialization (resume → create).
    const unarmed = makeStubAgent(OLD, { armed: [] })
    registry.set(unarmed.id, unarmed)
    // The persistence: resume refuses (v2 migration); create on the OLD id throws
    // the existing-session error. A FRESH id creates fine.
    const agents = stuckAgents(registry, { createErrorFor: (id) => (id === OLD ? createAlreadyExists(id) : undefined) })
    const surface = buildDelivery(stateDir, { agents, byPost, registry })
    // The bundle OWNS the live handle (byHeadHandle) — its dispose releases the
    // registry entry, so the reassertion guard returns 'disposed' and the wake
    // falls through to the COLD materialization (the route under test).
    surface.__byHeadHandle.set(OLD, { agent: unarmed, dispose: async () => { registry.delete(OLD) } })
    const record = { id: 'm-u1', seq: 1, ts: 1_000, from: 'host-sender', to: ['research-head'], text: 'msg m-u1', kind: 'agent' }

    const status = await surface.busDeliverToPost(entry, '[From host → research-head]: wake', record, 'host-session-1')

    assert.equal(status, 'resumed', 'the delivery SUCCEEDED (resumed — the cold materialization re-created it) and NOT failed; a `failed` here is the pre-fix abort')
    assert.notEqual(status, 'failed', 'the wake did NOT fail — the acceptance of U1: creating over a durable-but-unresumable artifact is not a fatal failure')
    // The rotation really happened: resume on the OLD id, create on the OLD id
    // (rejected), then a create on a DIFFERENT (fresh) id that succeeded.
    assert.deepEqual(agents.calls.resume, [OLD], 'exactly ONE resume, on the OLD durable id')
    assert.equal(agents.calls.create[0], OLD, 'the create fallback FIRST tries the SAME id (the pre-existing resume→create shape, unchanged)')
    const fresh = agents.calls.create[1]
    assert.ok(fresh !== undefined && fresh !== OLD, `a FRESH id was created after the existing-session error (got ${String(fresh)})`)
    assert.match(fresh, /^head-research-head-[0-9a-f-]{36}$/, 'the fresh id is the head fresh-mint shape head-<postId>-<uuid> (the tools.ts:4441 mirror)')
    const target = registry.get(fresh)
    assert.ok(target !== undefined, 'the FRESH session is LIVE (the rotation materialized it)')
    assert.equal(target.inboxMessages.length, 1, 'the wake message LANDED on the fresh incarnation (the delivery completed — the boot did not abort)')
    assert.ok(surface.__logs.warn.some((m) => /EXISTS but is NOT resumable/.test(m) && m.includes(fresh)), 'the rotation is LOUD: the warning names the old artifact, the reason and the fresh id')
    // The ORIGINAL durable artifact is NOT clobbered (history intact): the old
    // id's session was never created over — only resumed (and refused).
    assert.ok(!agents.calls.create.includes(OLD) || agents.calls.create.filter((id) => id === OLD).length === 1, 'the OLD id was attempted exactly once and never successfully created over')
  })
})

// ===========================================================================
// r2 — THE MANDATORY POSITIVE CONTROL: an UNRELATED error on the SAME path MUST
// PROPAGATE. This is what fails if the guard is a bare `catch {}`.
// ===========================================================================
test('fb-u1 (r2) CONTROL POSITIVO: the SAME path with an UNRELATED error (a generic Error, NOT an existing-session error) DOES propagate out of the delivery route — the guard must not swallow the alarm', async () => {
  await withTempStateDir(async (stateDir) => {
    const OLD = 'head-research-head'
    const byPost = new Map()
    const registry = new Map()
    const entry = durableHead('research-head', OLD)
    byPost.set(entry.postId, entry)
    const unarmed = makeStubAgent(OLD, { armed: [] })
    registry.set(unarmed.id, unarmed)
    // The UNRELATED failure: e.g. a permission/persistence/IO class — nothing
    // to do with the session already existing.
    const unrelated = new Error('[deepartments] boom: the persistence store is unwritable (EACCES)')
    const agents = stuckAgents(registry, { createErrorFor: (id) => (id === OLD ? unrelated : undefined) })
    const surface = buildDelivery(stateDir, { agents, byPost, registry })
    surface.__byHeadHandle.set(OLD, { agent: unarmed, dispose: async () => { registry.delete(OLD) } })

    // The seam that reaches materializePost WITHOUT a catch — the exact
    // observable of "did the error escape the delivery route?".
    await assert.rejects(
      () => surface.reassertPostToolset(entry, { now: () => 1_784_000_000_000 }),
      (error) => {
        assert.equal(error, unrelated, 'the UNRELATED error is rethrown BY IDENTITY (not wrapped, not replaced)')
        return true
      },
      'an unrelated error MUST propagate — if this assertion fails, the guard swallowed everything and the alarm is OFF (the anti-fix this control exists to catch)'
    )
    // And NO rotation happened on the unrelated path: no second create.
    assert.deepEqual(agents.calls.create, [OLD], 'no fresh-id rotation for an unrelated error (the rotation is reserved for the existing-session class)')
    assert.ok(!surface.__logs.warn.some((m) => /NOT resumable/.test(m)), 'the rotation warning NEVER fired (the unrelated error was not misclassified as durable-unresumable)')
  })
})

// ===========================================================================
// r3 — the PREDICATE itself: the harness forms it must recognize and the
// near-misses it must NOT (the space the two routes share via ONE definition).
// ===========================================================================
test('fb-u1 (r3) the SHARED predicate recognizes the existing-session forms (error NAME and message) and rejects the near-misses — the single definition both routes consume', () => {
  // (a) the error NAME forms the harness uses.
  const named = new Error('anything')
  named.name = 'SessionAlreadyExistsError'
  assert.equal(isExistingSessionError(named), true, 'the SessionAlreadyExistsError NAME is recognized')
  const owned = new Error('anything')
  owned.name = 'SessionAlreadyOwnedError'
  assert.equal(isExistingSessionError(owned), true, 'the SessionAlreadyOwnedError NAME is recognized')
  // (b) the MESSAGE form the real persistence emits (dsh-session:1613/1655 —
  // `session "<id>" already exists`), including the non-Error (string) throw.
  assert.equal(isExistingSessionError(new Error('session "head-x" already exists')), true, 'the real persistence message (already exists) is recognized')
  assert.equal(isExistingSessionError('session "head-x" already exists'), true, 'a non-Error throw carrying the message is recognized (the String() arm)')
  assert.equal(isExistingSessionError(new Error('the surface is already owned by another head')), true, 'the already-owned message form is recognized')
  // (c) the NEAR-MISSES — the control of the predicate: these must NEVER rotate.
  assert.equal(isExistingSessionError(new Error(V2_MIGRATION_ERROR)), false, 'the v2-migration RESUME error alone is NOT an existing-session error (it is the CAUSE of the resume failure, not the create refusal)')
  assert.equal(isExistingSessionError(new Error('has no provider/model')), false, 'the fb-6 no-provider/model class is NOT an existing-session error (its own B5 forensics branch stays first)')
  assert.equal(isExistingSessionError(new Error('session "head-x" not found')), false, 'the W8-i session-not-found class is NOT an existing-session error')
  assert.equal(isExistingSessionError(new Error('boom: the persistence store is unwritable (EACCES)')), false, 'an unrelated IO error is NOT an existing-session error')
  assert.equal(isExistingSessionError(undefined), false, 'a non-thrown value is not an existing-session error (never throws itself)')
})
