// dsh-deepartments — P-LATCH RECONCILE test (fb-154/155/157 — QD escalation
// 2026-09-05, LANE P-LATCH).
//
// The scheduler's no-fire idempotency LATCH is the LIVE worker POST itself:
// `runningJobWorker` (packages/dshd-orchestration/src/spawn.ts) matches ANY
// NON-RETIRED worker post carrying the jobId — `job already running` until a
// dept_worker_retire. A job worker that CRASHED on its first turn (fb-154),
// went OFFLINE (fb-155), or left a stale entry while its durable row was
// retired/pruned (fb-157) keeps the latch for DAYS (the A2 offline-reap is
// 72h + warm-up; the b5-ghost census needs 8 boots) → the job silently
// no-fires every morning. The BOOT/DRAIN LATCH-RECONCILE
// (runSchedulerLatchReconcile) closes the class: a NON-RETIRED JOB worker
// whose session has NO live handle (and NO sleepEpoch) is RETIRED at boot (the
// sanctioned latch release) so the job is eligible again at the next tick; a
// LIVE worker is NEVER touched (the in-flight dedup stays intact).
//
// Covers (through the REAL Loader composition — the jobs-spawn-regression
// pattern):
//   (i)  a STALE (offline) job-worker post → the boot reconcile RETIRES it and
//        the job FIRES on the next tick (eligible again) + the durable alert
//        row (reason 'latch-reconcile');
//   (ii) a LIVE job worker → the boot reconcile does NOT touch it — the no-fire
//        dedup stays intact (a second run trips idempotency-skip, no duplicate
//        worker);
//   (iii) a RETIRED job-worker post → never touched by the reconcile and the
//        job is eligible (fires on the next tick);
//   (iv) CONTROL — no stale latch → normal dispatch fires exactly ONE worker,
//        zero reconcile events.
// Hermetic: temp stateDir; dispose clears effects. The dept tree is the REAL
// repo (job files + role templates are read from disk — same as production).
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

/** Stub webServer/webRuntime/connection (the smoke-boot pattern — the
 * client-graph server half; dshd-gui's mount registers the 6 routes). */
class StubWebServer extends Service {
  constructor(ctx) { super(ctx, 'webServer'); this.routes = [] }
  register(route) { this.routes.push(route); return () => {} }
}
class StubWebRuntime extends Service {
  constructor(ctx) { super(ctx, 'webRuntime'); this.trustedHosts = [] }
}
class StubConnection extends Service {
  constructor(ctx) { super(ctx, 'connection'); this.trustedHosts = [] }
}

/** A MINIMAL agents service (the bootPlugin shape — create/get/list/roots) so
 * the composed boot materializes heads/job workers without a real harness. */
class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.createCalls = []
  }
  get(id) { return this.store.get(String(id)) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  async create(options) {
    this.createCalls.push(options)
    const agent = {
      id: String(options.sessionId),
      status: 'running',
      ctx: this.ctx,
      session: { events: [], get seq() { return this.events.length }, snapshotEvents() { return this.events }, requestHeader() { return undefined } },
      followup() {},
      cancel() {},
      async whenIdle() {}
    }
    this.store.set(String(options.sessionId), agent)
    return { agent, dispose: async () => { this.store.delete(String(options.sessionId)) } }
  }
  async resume(options) {
    return this.create({ ...options, sessionId: options.resumeSessionId })
  }
}

/** A pre-materialized LIVE agent handle (the shape `agents.get` returns) for a
 * worker the caller wants to be LIVE at boot (case ii). */
function liveAgentHandle(sessionId) {
  return {
    id: String(sessionId),
    status: 'idle',
    session: { events: [], get seq() { return 0 }, snapshotEvents() { return [] }, requestHeader() { return undefined } },
    followup() {},
    cancel() {},
    async whenIdle() {}
  }
}

/** The REAL Loader composition of the dev-profile subset (dshd-core + the 6 P1
 * packages + dshd-orchestration + the bundle, in order). `posts` pre-seeds the
 * DURABLE registry BEFORE the boot; `liveWorkers` pre-mounts LIVE agent handles
 * for the given session ids (so the boot latch-reconcile sees them LIVE). */
async function latchReconcileBoot(stateDir, { org, posts, liveWorkers = [] } = {}) {
  if (posts !== undefined) {
    await writeFile(path.join(stateDir, 'posts.json'), JSON.stringify(posts, null, 2), 'utf8')
  }
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  new StubWebServer(root)
  new StubWebRuntime(root)
  new StubConnection(root)
  const agentsStub = new StubAgents(root)
  for (const sessionId of liveWorkers) {
    agentsStub.store.set(String(sessionId), liveAgentHandle(sessionId))
  }
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return { root, loader, pluginCtx, agentsStub, dispose: () => loaderFiber.dispose() }
}

// --- the department the tick fires under (the REAL repo tree owns the job
// files + the builder role template). ---
const DEPARTMENT = {
  id: 'internal-programming',
  name: 'Internal Programming',
  roomId: 'room-ipd',
  coordinator: { postId: 'internal-programming-head' }
}
const ORG = { departments: [DEPARTMENT] }

/** The durable head entry the scheduler resolves from the catalog byPost. */
const HEAD_POSTS = {
  'internal-programming-head': {
    sessionId: 'session-ipd-head-1',
    roomId: 'room-ipd',
    agentPreset: 'deepartments-head'
  }
}

/** A STALE JOB-WORKER latch: a NON-RETIRED worker post carrying the pulse-digest
 * jobId whose session is NOT mounted in the agents service (no live handle —
 * the fb-154 turn-1 crash-loop zombie / fb-155 offline class). */
const STALE_JOB_WORKER = {
  'pulse-digest': {
    sessionId: 'worker-pulse-digest-stale-1',
    roomId: 'room-ipd',
    agentPreset: 'deepartments-worker',
    provider: 'worker',
    role: 'builder',
    departmentId: 'internal-programming',
    managerId: 'internal-programming-head',
    jobId: 'pulse-digest'
  }
}

/** One due calendar entry (at in the past; the tick fires it at `now`). */
const dueCalendarEntry = (jobId) => ({
  entries: [{ id: `p-latch-${jobId}`, label: `p-latch ${jobId}`, at: '2026-08-31T00:00:00.000Z', jobId, fired: false }]
})

/** A tick clock FAR from any cron minute (12:00 — pulse-digest is 07:30,
 * system-health-report 07:00) so ONLY the calendar path fires. */
const TICK_NOW = () => Date.parse('2026-09-01T12:00:00Z')

/** Poll a predicate (the boot reconcile + persistPosts are ASYNC/fire-and-
 * forget; the durable registry loads async at boot) up to ~3s. */
async function poll(predicate, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

/** Read the durable posts.json post row for `postId` (or undefined). */
function durablePost(stateDir, postId) {
  if (!existsSync(path.join(stateDir, 'posts.json'))) return undefined
  try {
    return JSON.parse(readFileSync(path.join(stateDir, 'posts.json'), 'utf8'))[postId]
  } catch {
    return undefined
  }
}

/** The post-errors rows mentioning a jobId (the scheduler post-error ledger —
 * the durable alert seam captureSchedulerAutoRunFailure writes). */
function schedulerErrorRows(stateDir, jobId) {
  if (!existsSync(path.join(stateDir, 'post-errors.jsonl'))) return []
  return readFileSync(path.join(stateDir, 'post-errors.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && line.includes(jobId))
}

test('p-latch-reconcile (i): a STALE (offline) job-worker post is RETIRED by the boot reconcile and the job FIRES on the next tick (eligible again) + the durable latch-reconcile alert row', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-p-latch-i-'))
  try {
    const boot = await latchReconcileBoot(stateDir, { org: ORG, posts: { ...HEAD_POSTS, ...STALE_JOB_WORKER } })
    try {
      // The boot reconcile (fired post-redelivery) must RETIRE the stale worker
      // (markPostRetired → durable retired:true + the O4 archive row).
      const retired = await poll(() => durablePost(stateDir, 'pulse-digest')?.retired === true)
      assert.ok(retired, 'the boot latch-reconcile retired the STALE (offline) pulse-digest worker (the latch cleared)')
      const retiredRow = durablePost(stateDir, 'pulse-digest')
      assert.ok(retiredRow !== undefined && retiredRow.retired === true, 'the durable posts.json carries the retired mark')
      assert.ok(retiredRow.sessionId === 'worker-pulse-digest-stale-1', 'the retired row is the SAME stale worker (postId pulse-digest)')
      // The durable ALERT: the scheduler sink recorded the cleared latch once
      // (reason 'latch-reconcile' — the «reconcile latches» visibility class).
      const alertSeen = await poll(() => schedulerErrorRows(stateDir, 'pulse-digest').some((line) => line.includes('latch-reconcile')))
      assert.ok(alertSeen, 'post-errors.jsonl carries the latch-reconcile alert row (jobId pulse-digest)')

      // The job is ELIGIBLE again: a due calendar entry fires it on the next
      // tick (fresh worker materialized — slug-deduped 'pulse-digest-2', the
      // retired 'pulse-digest' still occupies its slug).
      await writeFile(path.join(stateDir, 'calendar.json'), JSON.stringify(dueCalendarEntry('pulse-digest'), null, 2), 'utf8')
      await boot.pluginCtx().get('deepartments.jobs').runSchedulerTick({ now: TICK_NOW })

      const fired = await poll(() => {
        if (!existsSync(path.join(stateDir, 'calendar.json'))) return false
        const cal = JSON.parse(readFileSync(path.join(stateDir, 'calendar.json'), 'utf8'))
        return (cal.entries ?? []).some((e) => e.id === 'p-latch-pulse-digest' && e.fired === true)
      })
      assert.ok(fired, 'the calendar entry marked fired:true (the job RAN on the tick after the reconcile)')
      const freshCreate = await poll(() => boot.agentsStub.createCalls.some((c) => String(c.sessionId).includes('pulse-digest')))
      assert.ok(freshCreate, 'a FRESH pulse-digest worker materialized (the stale latch no longer blocks the job)')
      const freshPost = await poll(() => {
        const row = durablePost(stateDir, 'pulse-digest-2') ?? durablePost(stateDir, 'pulse-digest')
        return row !== undefined && row.retired !== true && row.sessionId !== 'worker-pulse-digest-stale-1'
      })
      assert.ok(freshPost, 'a NEW non-retired durable worker post exists (the re-fires landed)')
    } finally {
      boot.dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('p-latch-reconcile (ii): a LIVE job worker is NOT touched by the boot reconcile — the no-fire dedup stays intact (a second run trips idempotency-skip, no duplicate worker)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-p-latch-ii-'))
  try {
    // Same stale-shaped post BUT its session is pre-mounted LIVE in the agents
    // service → the boot reconcile must see it as IN FLIGHT and keep the latch.
    const boot = await latchReconcileBoot(stateDir, { org: ORG, posts: { ...HEAD_POSTS, ...STALE_JOB_WORKER }, liveWorkers: ['worker-pulse-digest-stale-1'] })
    try {
      // Let the boot sequence (ensureAllHeads + redelivery + the reconciles)
      // settle, then verify the worker was NOT retired.
      await poll(() => boot.agentsStub.createCalls.length > 0, 120) // the head materialized → boot wiring ran
      await new Promise((resolve) => setTimeout(resolve, 300)) // the reconcile window
      const row = durablePost(stateDir, 'pulse-digest')
      assert.ok(row !== undefined && row.retired !== true, 'the LIVE pulse-digest worker was NOT retired by the boot reconcile (the latch is kept)')
      assert.equal(schedulerErrorRows(stateDir, 'pulse-digest').some((line) => line.includes('latch-reconcile')), false, 'NO latch-reconcile alert for the LIVE worker')

      // The no-fire dedup still acts as today: a due calendar entry for the
      // same job TRIPS `job already running` (runningJobWorker finds the LIVE
      // post) → idempotency-skip post-error row, NO duplicate worker.
      await writeFile(path.join(stateDir, 'calendar.json'), JSON.stringify(dueCalendarEntry('pulse-digest'), null, 2), 'utf8')
      await boot.pluginCtx().get('deepartments.jobs').runSchedulerTick({ now: TICK_NOW })

      const tripped = await poll(() => schedulerErrorRows(stateDir, 'pulse-digest').some((line) => line.includes('idempotency-skip')))
      assert.ok(tripped, 'the second run TRIPPED idempotency-skip (the in-flight dedup intact — "job already running")')
      const duplicates = boot.agentsStub.createCalls.filter((c) => String(c.sessionId).includes('pulse-digest'))
      assert.equal(duplicates.length, 0, 'NO duplicate pulse-digest worker materialized (the LIVE latch held)')
      const stillLive = durablePost(stateDir, 'pulse-digest')
      assert.ok(stillLive !== undefined && stillLive.retired !== true, 'the LIVE worker post stays non-retired after the tripped run')
    } finally {
      boot.dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('p-latch-reconcile (iii): a RETIRED job-worker post is never touched by the boot reconcile and the job stays eligible (fires on the next tick)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-p-latch-iii-'))
  try {
    const boot = await latchReconcileBoot(stateDir, {
      org: ORG,
      posts: { ...HEAD_POSTS, 'pulse-digest': { ...STALE_JOB_WORKER['pulse-digest'], retired: true } }
    })
    try {
      // The reconcile scan skips `retired === true` — the post is never
      // touched (no un-retire, no duplicate alert).
      await poll(() => boot.agentsStub.createCalls.length > 0, 120)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const row = durablePost(stateDir, 'pulse-digest')
      assert.ok(row !== undefined && row.retired === true, 'the RETIRED pulse-digest post stays retired (never touched by the reconcile)')
      assert.equal(schedulerErrorRows(stateDir, 'pulse-digest').some((line) => line.includes('latch-reconcile')), false, 'NO latch-reconcile alert for an already-retired post')

      // The job is ELIGIBLE (a retired post holds no latch — runningJobWorker
      // filters retired): a due calendar entry fires a FRESH worker.
      await writeFile(path.join(stateDir, 'calendar.json'), JSON.stringify(dueCalendarEntry('pulse-digest'), null, 2), 'utf8')
      await boot.pluginCtx().get('deepartments.jobs').runSchedulerTick({ now: TICK_NOW })

      const fired = await poll(() => boot.agentsStub.createCalls.some((c) => String(c.sessionId).includes('pulse-digest')))
      assert.ok(fired, 'the job FIRED despite the retired post (the latch was never held by a retired post)')
      const stillRetired = durablePost(stateDir, 'pulse-digest')
      assert.ok(stillRetired !== undefined && stillRetired.retired === true, 'the retired post is STILL retired after the job fired (nothing un-retired it)')
    } finally {
      boot.dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('p-latch-reconcile (iv) CONTROL: no stale latch → normal dispatch fires exactly ONE worker, zero reconcile events', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-p-latch-iv-'))
  try {
    // A clean boot: NO job-worker post at all — the reconcile has nothing to
    // clear (the dispatch/idempotency machinery is unchanged).
    const boot = await latchReconcileBoot(stateDir, { org: ORG, posts: HEAD_POSTS })
    try {
      await poll(() => boot.agentsStub.createCalls.length > 0, 120)
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(durablePost(stateDir, 'pulse-digest'), undefined, 'no pulse-digest post before the run (clean state)')
      assert.equal(schedulerErrorRows(stateDir, 'pulse-digest').some((line) => line.includes('latch-reconcile')), false, 'NO latch-reconcile alert in a clean boot')

      // A NORMAL calendar fire: exactly ONE worker materializes (no dedup trip,
      // no post-error row, the worker stays live).
      await writeFile(path.join(stateDir, 'calendar.json'), JSON.stringify(dueCalendarEntry('pulse-digest'), null, 2), 'utf8')
      await boot.pluginCtx().get('deepartments.jobs').runSchedulerTick({ now: TICK_NOW })

      const created = await poll(() => boot.agentsStub.createCalls.some((c) => String(c.sessionId).includes('pulse-digest')))
      assert.ok(created, 'the normal dispatch materialized the pulse-digest worker')
      const workerCreates = boot.agentsStub.createCalls.filter((c) => String(c.sessionId).includes('pulse-digest'))
      assert.equal(workerCreates.length, 1, 'EXACTLY ONE worker materialized (normal dispatch, no duplicate)')
      const fresh = durablePost(stateDir, 'pulse-digest')
      assert.ok(fresh !== undefined && fresh.retired !== true, 'the fresh worker post is non-retired')
      assert.equal(schedulerErrorRows(stateDir, 'pulse-digest').length, 0, 'NO post-error row on a successful fire (the normal path is untouched)')
      const cal = JSON.parse(readFileSync(path.join(stateDir, 'calendar.json'), 'utf8'))
      assert.equal((cal.entries ?? []).find((e) => e.id === 'p-latch-pulse-digest')?.fired, true, 'the calendar entry marked fired:true')
    } finally {
      boot.dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})