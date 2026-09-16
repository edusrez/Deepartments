// monitorredo1 — the storm-guard CONSUMPTION gap (monitor re-materialization).
//
// SYMPTOM (measured by the RD, reproduced by this deployment): the monitor
// RE-DETECTS material it already fired on and re-materializes worker plazas with
// NO new facts. Clusters measured from the raw sessions: the SAME event body
// materialized x4 (deepseek-dsh-news-24/25/26/27), x3 (ai-industry-news-47/48/49),
// plus 13 x2 pairs.
//
// ROOT CAUSE (adjudicated in the report): the tick documents that the events
// SKIPPED by the storm guard (`break` when `live >= maxConsecutiveSpawns`) are
// "consumed rather than re-fetched" — but that consumption is asserted to happen
// via the CURSOR advance, and the LIVE endpoint does NOT return `next_cursor`
// (it is a PAGINATION token, absent when the page is the last — `limit=50` with
// 1–2 events/day). So `entry.cursor` stays undefined/frozen forever, and the
// local seen-set never records the skipped events (`seen.add` sits AFTER the
// `break`). When the live-worker cap frees, the SAME events are re-fetched and
// re-spawned.
//
// ORACLE (fb-512, declared): this file boots the bundle from SOURCE
// (`src/index.ts`? no — the tick half from `src/invoke.ts`) through the repo's
// self-registered `ts-src-loader` hook, so the assertion targets the CURRENT
// source tree, NOT the built `lib/`. A green suite of the lib-based tests does
// NOT acredit this artifact.
import { register } from 'node:module'

register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// NOTE: the tick half of the bundle is imported DYNAMICALLY (below), AFTER the
// ts-src-loader hook is registered — a STATIC import would be linked before
// `register()` runs and the `.js`→`.ts` rewrite would never apply.
const { readParallelMonitorsState, runParallelMonitorTick, writeParallelMonitorsState } =
  await import('../src/invoke.ts')

const MAX_SPAWNS = 2

/** A fresh (≤48h) event — so the FIRST-RUN freshness gate never masks the result. */
function freshEvent(id, content = `item ${id}`) {
  return { event_id: id, event_date: new Date().toISOString(), output: { content } }
}

/** Drive ONE tick of the real `runParallelMonitorTick` against a temp stateDir. */
async function tick(stateDir, { page, live, nextCursor, maxConsecutiveSpawns = MAX_SPAWNS }) {
  const spawns = []
  const warns = []
  await runParallelMonitorTick({
    now: () => Date.now(),
    stateDir,
    monitors: [{ id: 'm1', query: 'q', processor: 'base', frequency: '1d' }],
    apiKey: 'k',
    baseUrl: 'x',
    maxConsecutiveSpawns,
    createMonitor: async () => ({ monitorId: 'monitor_1' }),
    fetchEvents: async () => ({ events: page, ...(nextCursor !== undefined ? { nextCursor } : {}) }),
    spawnResearcher: async (monitor, event) => { spawns.push(event.event_id); return { workerId: `w-${event.event_id}` } },
    notifyHead: async () => {},
    liveWorkerCount: () => live,
    logger: { warn: (x) => warns.push(x) }
  })
  return { spawns, warns, state: readParallelMonitorsState(stateDir).monitors.m1 }
}

async function withStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'monitorredo1-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

test('monitorredo1 (RED→GREEN): an event SKIPPED by the storm guard is CONSUMED — when the live cap frees it must NOT re-spawn (no cursor from the API)', async () => {
  await withStateDir(async (stateDir) => {
    // The monitor already created, no cursor (the LIVE shape: the endpoint returns
    // no `next_cursor`), and the live-worker cap is FULL.
    await writeParallelMonitorsState(stateDir, { monitors: { m1: { monitorId: 'monitor_1' } } })

    const page = [freshEvent('mevt_a'), freshEvent('mevt_b'), freshEvent('mevt_c')]

    // (1) cap FULL → the storm guard breaks immediately: nothing spawns.
    const first = await tick(stateDir, { page, live: MAX_SPAWNS })
    assert.deepEqual(first.spawns, [], 'the storm guard spawns nothing while the cap is full')
    assert.match(first.warns.join(' '), /storm guard/, 'the storm-guard skip is warned')

    // (2) the cap FREES (the workers retired) — the very next tick, same page.
    const second = await tick(stateDir, { page, live: 0 })
    assert.deepEqual(
      second.spawns,
      [],
      'an event SKIPPED by the storm guard is CONSUMED, not re-fetched: with the cap freed the SAME page must NOT re-materialize worker plazas'
    )
    assert.equal(second.state.lastEventCount, page.length, 'the poll still reports the page size')
  })
})

test('monitorredo1 POSITIVE CONTROL: a GENUINELY NEW event (never seen, not skipped) DOES materialize', async () => {
  await withStateDir(async (stateDir) => {
    await writeParallelMonitorsState(stateDir, { monitors: { m1: { monitorId: 'monitor_1' } } })

    // (1) one event fires normally (cap free).
    const first = await tick(stateDir, { page: [freshEvent('mevt_known')], live: 0 })
    assert.deepEqual(first.spawns, ['mevt_known'], 'a fresh, not-skipped event materializes exactly once')

    // (2) a DIFFERENT, genuinely new event arrives → it MUST fire.
    const second = await tick(stateDir, { page: [freshEvent('mevt_new'), freshEvent('mevt_known')], live: 0 })
    assert.deepEqual(second.spawns, ['mevt_new'], 'a genuinely NEW event still materializes (the fix must not turn the monitor off)')
  })
})
