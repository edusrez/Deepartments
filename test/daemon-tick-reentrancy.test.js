// dsh-deepartments — DAEMON TICK RE-ENTRANCY (OVERLAP) lock.
//
// THE MEASURED CLASS (source: the research department's overlap diagnosis;
// re-verified against src/invoke.ts before this lock was written):
//   `wrapDaemonTick` was ONLY a try/catch — it had NO re-entrancy flag. The
//   three setInterval daemons call it FIRE-AND-FORGET (the bodies detach their
//   async work: `void jobsService.runSchedulerTick(...)` / `void daemon.tick()`
//   / `pending = healthService.runDaemonTick(...)`), so a tick that takes
//   LONGER than its interval lets the NEXT interval fire start while the
//   previous tick is STILL IN FLIGHT. Two concurrent ticks then read the SAME
//   state file, mutate independently, and write back — the LOST UPDATE class
//   (`parallel-monitors-state.json`: `lastFiredAt` / `seenEventIds` / `cursor`),
//   plus the DOUBLE-DISPATCH class (both ticks see an event as net-new before
//   either persists its `seenEventIds`).
//
// THIS LOCK pins the guard BEHAVIORALLY, through the REAL Loader composition
// (the smoke-boot / dispose-clean pattern) — NOT by importing the wrapper (it
// is module-private and the lib/invoke.js export count is FROZEN at 343 by
// test/export-parity.test.js; exporting it would break that lock).
//
// DETERMINISM (no timing races): the parallel-monitor daemon's FIRST outbound
// call (POST /v1/monitors) is held open on a promise WE control, so "the tick
// is still in flight" is an EXACT fact rather than a sleep. We then invoke the
// captured interval callback a SECOND time back-to-back:
//   - WITH the guard: the second call is SKIPPED (and LOGGED) → exactly ONE
//     outbound call was issued.
//   - WITHOUT the guard (the rever/HEAD state): the second call runs too →
//     TWO outbound calls overlap — the assertion below FAILS, which is the
//     revert-check that proves this test pinches the real defect.
//
// Hermetic: temp stateDir, stub webServer/webRuntime/connection, NO network
// (global fetch is replaced by a controlled stub), NO LLM. Runs against the
// COMPILED lib/ (pnpm build first — AGENTS.md rule 5).
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** Stub webServer: the RPC mount registers routes and expects a disposer. */
class StubWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = []
  }
  register(route) {
    this.routes.push(route)
    return () => {}
  }
}

class StubWebRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'webRuntime')
    this.trustedHosts = []
  }
}

class StubConnection extends Service {
  constructor(ctx) {
    super(ctx, 'connection')
    this.trustedHosts = []
  }
}

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

const RESEARCH_ORG = {
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

/** Boot the REAL dev-profile composition (smoke-boot.test.js:68-96 pattern) with
 * the parallel-monitor daemon ENABLED (an apiKey + one monitor) and a durable
 * research head seeded into posts.json so the daemon's LAZY per-tick target
 * resolution succeeds. The setInterval capture is installed BEFORE
 * `await loader.await()` so the daemon effect registration is observed and NO
 * real timer ever fires (every tick is driven explicitly by the test). */
async function bootWithParallelMonitor(stateDir, { logs } = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  if (logs !== undefined) {
    root.logger.exporter({ levels: { default: 5 }, export: (message) => { logs.push(`${message.type}: ${String(message.args[0] ?? '')}`) } })
  }
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  new StubWebServer(root)
  new StubWebRuntime(root)
  new StubConnection(root)
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org: RESEARCH_ORG } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({
    id: 'deepartments',
    name: '../lib/index.js',
    config: {
      stateDir,
      org: RESEARCH_ORG,
      // The parallel-monitor daemon is registered ONLY when an apiKey AND a
      // non-empty monitors array are present (invoke.ts:5056-5060).
      parallel: { apiKey: 'test-key-not-a-secret', monitors: [{ id: 'm1', query: 'overlap probe' }] }
    }
  })
  const setCalls = []
  const origSet = global.setInterval
  global.setInterval = (fn, delay, ...args) => { const handle = { fn, delay, args }; setCalls.push(handle); return handle }
  try {
    await loader.await()
  } finally {
    global.setInterval = origSet
  }
  return {
    root,
    loader,
    setCalls,
    pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx,
    dispose: () => loaderFiber.dispose()
  }
}

function withTempStateDir(fn) {
  return (async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-reent-'))
    try {
      return await fn(stateDir)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })()
}

/** Settle the fire-and-forget daemon work: a couple of macrotask hops. */
function settle() {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => setTimeout(resolve, 30))))
}

test('daemon tick re-entrancy: the parallel-monitor interval SKIPS (and LOGS) a tick fired while the previous one is still in flight — exactly ONE outbound call overlaps; a later tick runs normally once the guard releases', async () => {
  await withTempStateDir(async (stateDir) => {
    // A durable research head so the daemon's LAZY per-tick target resolution
    // succeeds (no target → the tick returns early WITHOUT any outbound call,
    // which would make the probe meaningless). The head is injected into the
    // LIVE catalog at boot, which is exactly the seam the daemon documents: it
    // re-resolves its department/head target on EVERY tick
    // (createParallelMonitorDaemon — "the boot race where the byPost registry is
    // still empty ... must NOT permanently disable the daemon").
    await writeFile(path.join(stateDir, 'posts.json'), JSON.stringify({
      'research-head': { sessionId: 'head-research-head', roomId: 'board', agentPreset: 'deepartments-head' }
    }, null, 2), 'utf8')

    // The controlled fetch: the FIRST outbound call blocks on `release`, so
    // "the tick is in flight" is an exact fact (never a sleep race).
    const calls = []
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const origFetch = global.fetch
    global.fetch = async (url, opts) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      calls.push(`${method} ${String(url)}`)
      await gate
      // The create-monitor POST / the events GET — both minimal valid shapes.
      if (method === 'POST') return new Response(JSON.stringify({ monitor_id: 'monitor_probe' }), { status: 200 })
      return new Response(JSON.stringify({ events: [] }), { status: 200 })
    }

    const logs = []
    const boot = await bootWithParallelMonitor(stateDir, { logs })
    try {
      // Satisfy the daemon's per-tick LAZY target resolution.
      boot.pluginCtx().get('deepartments.catalog').byPost.set('research-head', {
        postId: 'research-head', sessionId: 'head-research-head', roomId: 'board', agentPreset: 'deepartments-head'
      })
      const monitors = boot.setCalls.filter((c) => c.delay === 20000)
      assert.equal(monitors.length, 1, 'the parallel-monitor daemon registered setInterval(20000)')

      // TICK 1 — starts and blocks on the held fetch: the tick is IN FLIGHT.
      monitors[0].fn()
      await settle()
      assert.equal(calls.length, 1, 'the first tick issued its outbound call and is now awaiting it')

      // TICK 2 — fired while tick 1 is STILL in flight (the exact overlap the
      // interval produces when a tick outlives its interval). The guard must
      // SKIP it, so NO second outbound call may be issued.
      monitors[0].fn()
      await settle()
      assert.equal(
        calls.length,
        1,
        `an overlapping tick must NOT issue a concurrent outbound call (got ${calls.length}: ${calls.join(', ')}) — two overlapping ticks read/write parallel-monitors-state.json concurrently (the LOST UPDATE + double-dispatch class)`
      )
      assert.ok(
        logs.some((line) => /parallel-monitor tick SKIPPED/.test(line)),
        'the skipped tick is LOGGED (a silent skip is exactly the invisible-fix class this guard must not be)'
      )

      // RELEASE: the in-flight tick settles → it finishes its own work (its GET
      // events poll) → and the guard frees up.
      release()
      await settle()
      assert.equal(
        calls.length,
        2,
        `the released tick completes its OWN work (POST create + GET events = 2 calls) — got ${calls.length}: ${calls.join(', ')}`
      )

      // TICK 3 — a normal later tick runs again (the guard does not wedge the
      // daemon): it issues its outbound call and the state file is written.
      monitors[0].fn()
      await settle()
      assert.equal(calls.length, 3, `after the in-flight tick settled, the next tick RUNS (the guard releases, the daemon is not wedged) — got ${calls.length} call(s): ${calls.join(', ')}`)

      const state = JSON.parse(await readFile(path.join(stateDir, 'parallel-monitors-state.json'), 'utf8'))
      assert.equal(state.monitors.m1.monitorId, 'monitor_probe', 'the completed tick persisted its monitor state (the daemon still does its work)')
    } finally {
      release()
      await boot.dispose()
      global.fetch = origFetch
    }
  })
})

test('daemon tick re-entrancy [watchdog cap]: a tick that NEVER settles is force-released after the cap — the NEXT tick ENTERS (auto-repair, LOUD) — and the timed-out tick\'s LATE settlement does NOT clear the guard a newer tick owns', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(path.join(stateDir, 'posts.json'), JSON.stringify({
      'research-head': { sessionId: 'head-research-head', roomId: 'board', agentPreset: 'deepartments-head' }
    }, null, 2), 'utf8')

    // PER-CALL gates: every outbound call blocks on its OWN promise, so the test
    // can release ONE tick's calls (settling THAT tick late) while a later tick
    // stays in flight. `gates[i]` releases `calls[i]`.
    const calls = []
    const gates = []
    const origFetch = global.fetch
    global.fetch = async (url, opts) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      calls.push(`${method} ${String(url)}`)
      await new Promise((resolve) => { gates.push(resolve) })
      if (method === 'POST') return new Response(JSON.stringify({ monitor_id: 'monitor_probe' }), { status: 200 })
      return new Response(JSON.stringify({ events: [] }), { status: 200 })
    }

    // The daemon-tick WATCHDOG timer is a `setTimeout` armed with the cap, so it
    // is captured HERE (not waited out): firing it manually makes "the cap
    // elapsed" an EXACT event instead of a 2-minute sleep. Every OTHER timeout
    // (including settle()) delegates to the real one.
    const WATCHDOG_MS = 120000
    const watchdogTimers = []
    const origSetTimeout = global.setTimeout
    global.setTimeout = (fn, delay, ...args) => {
      if (delay === WATCHDOG_MS) {
        const handle = { fn, delay, args, unref() {} }
        watchdogTimers.push(handle)
        return handle
      }
      return origSetTimeout(fn, delay, ...args)
    }

    const logs = []
    const boot = await bootWithParallelMonitor(stateDir, { logs })
    const releaseCall = async (i) => { gates[i](); await settle() }
    try {
      boot.pluginCtx().get('deepartments.catalog').byPost.set('research-head', {
        postId: 'research-head', sessionId: 'head-research-head', roomId: 'board', agentPreset: 'deepartments-head'
      })
      const monitors = boot.setCalls.filter((c) => c.delay === 20000)
      assert.equal(monitors.length, 1, 'the parallel-monitor daemon registered setInterval(20000)')

      // TICK 1 — hangs on its outbound call: it will NEVER settle on its own.
      monitors[0].fn()
      await settle()
      assert.equal(calls.length, 1, 'tick 1 issued its outbound call (POST) and is blocked on it')
      assert.equal(watchdogTimers.length, 1, 'the in-flight tick armed exactly ONE watchdog timer')
      assert.equal(watchdogTimers[0].delay, WATCHDOG_MS, `the watchdog cap is the declared ${WATCHDOG_MS} ms (N = 6 x the shortest daemon interval, PARALLEL_MONITOR_INTERVAL_MS = 20 s)`)

      // A tick fired while tick 1 hangs is SKIPPED (the overlap guard) — the
      // pre-cap regime, and the one the never-settling tick would keep forever.
      monitors[0].fn()
      await settle()
      assert.equal(calls.length, 1, 'before the cap elapses, an overlapping tick is still SKIPPED (the cap must NOT re-open the overlap in normal operation)')

      // THE CAP ELAPSES — the never-settling tick must be FORCE-RELEASED.
      watchdogTimers[0].fn()
      await settle()

      // TICK 2 — must ENTER (auto-repair: the guard was released), NOT be skipped.
      monitors[0].fn()
      await settle()
      assert.equal(
        calls.length,
        2,
        `after the cap the next tick ENTERS (auto-repair — no permanent silence) — got ${calls.length} call(s): ${calls.join(', ')}`
      )
      assert.equal(watchdogTimers.length, 2, 'the new in-flight tick armed its OWN watchdog timer')
      assert.ok(
        logs.some((line) => /parallel-monitor tick WATCHDOG/.test(line) && /FORCE-RELEASED/.test(line)),
        'the watchdog event is LOGGED — LOUD, never the permanent silence of the pre-cap regime'
      )

      // TICK 3 — tick 2 is in flight (its own promise): still SKIPPED.
      monitors[0].fn()
      await settle()
      assert.equal(calls.length, 2, 'an overlapping tick of the NEW in-flight window is still skipped')

      // LATE SETTLEMENT OF TICK 1 (the trap): release tick 1's POST → it resumes
      // and issues its events GET → release that → tick 1 runs to COMPLETION and
      // calls settled() — LATE. The guard now belongs to tick 2, so tick 1's
      // settlement MUST be inert.
      await releaseCall(0)
      assert.equal(calls.length, 3, "tick 1 resumed after its POST was released and issued its events GET (its own work completes)")
      await releaseCall(2)

      // TICK 4 — the decisive assertion: tick 2 is STILL in flight and tick 1's
      // late settlement MUST NOT have cleared the guard. A blind `settled()`
      // here would let tick 4 run → 2 concurrent ticks on the same state file.
      monitors[0].fn()
      await settle()
      assert.equal(
        calls.length,
        3,
        `a late settlement from the TIMED-OUT tick must NOT clear the guard a NEWER tick owns (it would re-open the overlap class) — got ${calls.length} call(s): ${calls.join(', ')}`
      )
      assert.ok(
        logs.some((line) => /tick settled LATE/.test(line) && /LEFT ALONE/.test(line)),
        "tick 1's LATE settlement is LOGGED as inert (never silent)"
      )

      // RELEASE TICK 2 — its own settlement (matching generation) frees the guard.
      await releaseCall(1)
      await releaseCall(3)
      monitors[0].fn()
      await settle()
      assert.equal(
        calls.length,
        5,
        `once the CURRENT owner settles, the guard frees normally and the daemon keeps ticking — got ${calls.length} call(s): ${calls.join(', ')}`
      )
    } finally {
      for (const release of gates) release()
      await boot.dispose()
      global.fetch = origFetch
      global.setTimeout = origSetTimeout
    }
  })
})

test('daemon tick re-entrancy [mechanism]: the monitor-state file has NO concurrency control — two ticks that read the same snapshot and write back lose the earlier update (the class the overlap guard prevents)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { readParallelMonitorsState, writeParallelMonitorsState } = await import(path.join(REPO_ROOT, 'lib', 'invoke.js'))
    const stateFile = path.join(stateDir, 'parallel-monitors-state.json')
    // T0 — a monitor with a recorded lastFiredAt + seen ids.
    await writeFile(stateFile, JSON.stringify({
      monitors: { m1: { monitorId: 'monitor_1', lastFiredAt: 1000, seenEventIds: ['evt_a'] } }
    }), 'utf8')

    // Two "ticks" interleave: BOTH read the same snapshot...
    const tickA = readParallelMonitorsState(stateDir)
    const tickB = readParallelMonitorsState(stateDir)
    assert.equal(tickA.monitors.m1.lastFiredAt, 1000, 'tick A read the pre-state')
    assert.equal(tickB.monitors.m1.lastFiredAt, 1000, 'tick B read the SAME pre-state (nothing serialized them)')

    // ...each mutates ITS OWN snapshot...
    tickA.monitors.m1.lastFiredAt = 5000
    tickA.monitors.m1.seenEventIds = ['evt_a', 'evt_b']
    tickB.monitors.m1.lastFiredAt = 4000
    tickB.monitors.m1.seenEventIds = ['evt_a', 'evt_c']

    // ...and both write back: the LAST writer wins and SILENTLY discards the
    // other tick's work (the measured LOST UPDATE: lastFiredAt moves BACKWARDS).
    await writeParallelMonitorsState(stateDir, tickA)
    await writeParallelMonitorsState(stateDir, tickB)

    const final = readParallelMonitorsState(stateDir)
    assert.equal(final.monitors.m1.lastFiredAt, 4000, 'the second writer overwrote the first (last-write-wins — no lock, no merge, no compare-and-set)')
    assert.equal(final.monitors.m1.lastFiredAt < tickA.monitors.m1.lastFiredAt, true, 'lastFiredAt went BACKWARDS (5000 → 4000) — the measured lost-update signature')
    assert.deepEqual(final.monitors.m1.seenEventIds, ['evt_a', 'evt_c'], "tick A's seenEventIds ('evt_b') were LOST — the event it dispatched is no longer marked consumed")
  })
})
