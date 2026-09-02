// dsh-deepartments — JOBS→SPAWN REGRESSION test (LANE 0.2.3b, piece 3 — the
// COMMITTED equivalent of the disposable pulse-digest probe): freezes the REAL
// composed jobs→spawn path so the service-first scheduler wiring can never
// silently regress. Covers:
//   A) the tick RESOLVES `deepartments.spawn` (NOT the holder runJob — the
//      holder carries none since 0.2.3a), fires ONE REAL department job
//      (pulse-digest.md + the REAL builder role template) through
//      `runJobForDepartment`: durable worker materialized (agents.create +
//      registerEntry + persistPosts) + the calendar entry marked fired;
//   B) the W8-C POST-ERROR re-plumb: a runJobForDepartment EXCEPTION (the
//      idempotency trip — an ACTIVE durable worker for the same job) produces
//      its post-errors.jsonl row again through the SERVICE-FIRST path (the
//      captureAutoRunFailure adapter sink — the row the register-era
//      schedulerRunJob used to write), no double row, no worker materialized;
//   C) the bundle-alone fallback: WITHOUT the spawn service (no
//      dshd-orchestration row) the tick FAILS LOUD R1 (runJob required — both
//      sources named), and with a holder-registered runJob the R6 fallback
//      drives the tick to completion.
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
 * the composed boot materializes the job worker without a real harness. */
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
      session: { events: [] },
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

/** The REAL Loader composition of the dev-profile subset (dshd-core + the 6 P1
 * packages [+ dshd-orchestration] + the bundle, in order). `posts` (optional)
 * pre-seeds the DURABLE registry BEFORE the boot; `orchestration:false` boots
 * the bundle-alone path (the inline factory fallback — no spawn service). */
async function jobsSpawnBoot(stateDir, { org, posts, orchestration = true, agents = true } = {}) {
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
  const agentsStub = agents === true ? new StubAgents(root) : undefined
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  if (orchestration === true) {
    loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  }
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

/** One due calendar entry (at in the past; the tick fires it at `now`). */
const dueCalendarEntry = (jobId) => ({
  entries: [{ id: `regression-${jobId}`, label: `regression ${jobId}`, at: '2026-08-31T00:00:00.000Z', jobId, fired: false }]
})

/** A tick clock FAR from any cron minute (12:00 — pulse-digest is 07:30,
 * system-health-report 07:00) so ONLY the calendar path fires. */
const TICK_NOW = () => Date.parse('2026-09-01T12:00:00Z')

/** Poll a predicate (the durable registry loads ASYNC at boot; persistPosts is
 * fire-and-forget) up to ~3s. Returns true when it settles. */
async function poll(predicate, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

test('jobs→spawn (composed): the tick resolves deepartments.spawn (no holder runJob) and fires ONE real job — durable worker + calendar fired', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-jobs-spawn-'))
  try {
    const boot = await jobsSpawnBoot(stateDir, { org: ORG, posts: HEAD_POSTS })
    try {
      const ctx = boot.pluginCtx()
      // The service-first resolution: deepartments.spawn exists (dshd-
      // orchestration) and the JOBS HOLDER carries NO runJob (since 0.2.3a —
      // the tick MUST use the spawn service, not the holder's legacy seam).
      const spawnSvc = ctx.get('deepartments.spawn')
      assert.ok(spawnSvc !== undefined && typeof spawnSvc.runJobForDepartment === 'function', 'deepartments.spawn.runJobForDepartment resolves (the composed service)')
      const holder = ctx.get('deepartments.jobsDeps')
      assert.equal(holder.get().runJob, undefined, 'the jobs holder carries NO runJob (service-first — the fallback seam is empty by design)')
      // The W8-c re-plumb dep IS registered into the holder (the adapter
      // captures post-error rows through it):
      assert.equal(typeof holder.get().captureAutoRunFailure, 'function', 'the holder carries captureAutoRunFailure (LANE 0.2.3b W8-c re-plumb)')
      // Seed the due calendar entry for the REAL job pulse-digest.
      await writeFile(path.join(stateDir, 'calendar.json'), JSON.stringify(dueCalendarEntry('pulse-digest'), null, 2), 'utf8')

      await ctx.get('deepartments.jobs').runSchedulerTick({ now: TICK_NOW })

      // The durable worker materialized: the agents.create carried the job
      // worker session (worker-pulse-digest) + the durable registry persisted
      // the post (posts.json).
      const created = await poll(() => boot.agentsStub.createCalls.some((c) => String(c.sessionId).includes('pulse-digest')))
      assert.ok(created, 'the tick materialized the pulse-digest worker through the composed spawn service (agents.create ran)')
      const persisted = await poll(() => {
        if (!existsSync(path.join(stateDir, 'posts.json'))) return false
        const posts = JSON.parse(readFileSync(path.join(stateDir, 'posts.json'), 'utf8'))
        const row = posts['pulse-digest'] ?? posts['pulse-digest-2']
        return row !== undefined && (row.provider === 'worker' || row.sessionId !== undefined)
      })
      assert.ok(persisted, 'the durable posts.json carries the job worker post (registerEntry + persistPosts ran)')
      // The calendar entry marked fired.
      const fired = await poll(() => {
        if (!existsSync(path.join(stateDir, 'calendar.json'))) return false
        const cal = JSON.parse(readFileSync(path.join(stateDir, 'calendar.json'), 'utf8'))
        const entry = (cal.entries ?? []).find((e) => e.id === 'regression-pulse-digest')
        return entry?.fired === true
      })
      assert.ok(fired, 'the calendar entry was marked fired:true (the tick ran through the composed machine)')
      // The composed spawn path is the ONLY one used: no post-error row was
      // written (the fire succeeded — nothing to capture).
      assert.ok(!existsSync(path.join(stateDir, 'post-errors.jsonl')), 'no post-errors.jsonl on a successful fire')
    } finally {
      boot.dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('jobs→spawn (W8-c post-error re-plumb): a runJobForDepartment EXCEPTION produces its post-errors.jsonl row again (idempotency trip) — no second worker, no double row', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-jobs-spawn-'))
  try {
    const boot = await jobsSpawnBoot(stateDir, { org: ORG, posts: HEAD_POSTS })
    try {
      const ctx = boot.pluginCtx()
      // TWO due calendar entries for the SAME job: the FIRST fires (the durable
      // worker materializes + registerEntry lands in byPost synchronously); the
      // SECOND runJobForDepartment TRIPS the real idempotency guard ("job
      // already running" — spawn.ts runningJobWorker) and THROWS → the adapter
      // captures through the re-plumbed sink.
      await writeFile(path.join(stateDir, 'calendar.json'), JSON.stringify({
        entries: [
          { id: 'regression-tripped-1', label: 'trip a', at: '2026-08-31T00:00:00.000Z', jobId: 'pulse-digest', fired: false },
          { id: 'regression-tripped-2', label: 'trip b', at: '2026-08-31T00:00:00.000Z', jobId: 'pulse-digest', fired: false }
        ]
      }, null, 2), 'utf8')

      await ctx.get('deepartments.jobs').runSchedulerTick({ now: TICK_NOW })

      // The post-error row: post-errors.jsonl gains the scheduler row (postId
      // 'scheduler', the jobId, the NORMALIZED reason 'idempotency-skip' — the
      // same dedupe-key semantics the register-era schedulerRunJob produced).
      const rowWritten = await poll(() => {
        if (!existsSync(path.join(stateDir, 'post-errors.jsonl'))) return false
        return readFileSync(path.join(stateDir, 'post-errors.jsonl'), 'utf8').includes('pulse-digest')
      })
      assert.ok(rowWritten, 'post-errors.jsonl carries the scheduler post-error row (the W8-c re-plumbed capture — service-first)')
      const rows = readFileSync(path.join(stateDir, 'post-errors.jsonl'), 'utf8')
      assert.match(rows, /"postId":"scheduler"/, 'the row is a SCHEDULER row (postId "scheduler")')
      assert.match(rows, /idempotency-skip/, 'the normalized reason is idempotency-skip (the "already running" trip, dedupe-keyed the same way)')
      const rowCount = rows.trim().split('\n').filter((l) => l.includes('pulse-digest')).length
      assert.equal(rowCount, 1, 'EXACTLY ONE post-error row (the adapter captured; the tick-level idempotency finding is still filtered — no double row)')
      // EXACTLY ONE pulse-digest worker materialized (the FIRST entry fired it;
      // the SECOND trip happened before any agents.create) + both calendar
      // entries marked fired (the tick contract — a skip never wedges entries).
      const workerCreates = boot.agentsStub.createCalls.filter((c) => String(c.sessionId).includes('pulse-digest'))
      assert.equal(workerCreates.length, 1, 'exactly ONE pulse-digest worker materialized (the second run tripped before agents.create)')
      const cal = JSON.parse(readFileSync(path.join(stateDir, 'calendar.json'), 'utf8'))
      const firedEntries = (cal.entries ?? []).filter((e) => e.fired === true)
      assert.equal(firedEntries.length, 2, 'both calendar entries marked fired (a skip never wedges the entry)')
    } finally {
      boot.dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('jobs→spawn (bundle-alone fallback): WITHOUT the spawn service the tick FAILS LOUD R1 (both sources named) — and a holder-registered runJob drives the R6 fallback to completion', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-jobs-spawn-'))
  try {
    // Bundle-alone: NO dshd-orchestration row → no deepartments.spawn → the
    // holder (filled by the inline factory) has NO runJob → fail-loud R1.
    const boot = await jobsSpawnBoot(stateDir, { org: ORG, posts: HEAD_POSTS, orchestration: false })
    try {
      const ctx = boot.pluginCtx()
      assert.equal(ctx.get('deepartments.spawn'), undefined, 'bundle-alone: the spawn service is ABSENT (no dshd-orchestration row)')
      const holder = ctx.get('deepartments.jobsDeps')
      assert.equal(holder.get().runJob, undefined, 'bundle-alone: the holder runJob is absent (0.2.3a removed the registration)')
      await writeFile(path.join(stateDir, 'calendar.json'), JSON.stringify(dueCalendarEntry('pulse-digest'), null, 2), 'utf8')
      const jobs = ctx.get('deepartments.jobs')
      await assert.rejects(
        () => jobs.runSchedulerTick({ now: TICK_NOW }),
        /runJob/,
        'the tick FAILS LOUD R1 when neither source provides runJob (the spawn service absent AND the holder empty)'
      )
      // The R6 fallback WORKING: register a runJob into the holder (a minimal
      // composition or an external supplier CAN wire the legacy seam) → the
      // tick runs to completion through the holder closure.
      const runJobCalls = []
      holder.register({
        runJob: async (department, headPostId, jobId) => {
          runJobCalls.push({ department, headPostId, jobId })
          return true
        }
      })
      await jobs.runSchedulerTick({ now: TICK_NOW })
      assert.equal(runJobCalls.length, 1, 'the holder-registered runJob was called once (the R6 fallback path)')
      assert.equal(runJobCalls[0].headPostId, 'internal-programming-head', 'the fallback runJob received the resolved head postId')
      assert.equal(runJobCalls[0].jobId, 'pulse-digest', 'the fallback runJob received the calendar jobId')
      const cal = JSON.parse(readFileSync(path.join(stateDir, 'calendar.json'), 'utf8'))
      assert.equal((cal.entries ?? []).find((e) => e.id === 'regression-pulse-digest')?.fired, true, 'the tick completed through the holder fallback (calendar fired)')
    } finally {
      boot.dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})