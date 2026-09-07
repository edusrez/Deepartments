// dsh-deepartments — FB-132 2nd-half DELTA (2026-09-06, run token e9ac4720):
// the RETIRED-FLAVOR fix of the reviewers addendum
// (2026-09-06-fb132-target-retired-flavor-d93d46a3.md — GAP MENOR): a target
// RETIRED BEFORE DELIVERY whose entry still carries a stale `sleepEpoch` must
// NOT be considered DORMANT by the B3 re-drive park. The datapoint
// (/.deepartments/deliveries.jsonl:1786 — m-1900/m-2098 → host-session-
// 0bb84189, retired ~93 s before the attempt, entry `sleepEpoch` preserved):
// `recipientCatalogAlive` (F-3-alive, tools.ts:5580-5592 — a retired host with
// a LIVE rotation successor resolves ALIVE) makes the drivePair dead-settle
// (messages.ts:1294) NOT fire; `isDormantRecipient` (delivery.ts:1839) saw the
// STALE sleepEpoch → B3 (messages.ts:1315) parked the pair 'prepared' FOREVER:
// the engine re-route (resolveBusCatalogRoute → followRotationChainToLive →
// the m-424/425/429 re-route) was UNREACHABLE. Fix (variant 1 — aligned with
// the F-3 "re-routing rotatedTo" design): isDormantRecipient returns FALSE for
// an entry with `retired: true` — its sleepEpoch is stale metadata; «drains at
// its next real wake» is a dead end under its own retired id.
//
//   EXPECTED EFFECTS (from the reviewers verdict):
//       post retired        → no change (the dead-settle at drivePair :1294
//                             already ran BEFORE B3 :1315);
//       host retired + live successor → B3 does NOT park → drivePair reaches
//                             the deliver → the engine re-routes → 'delivered'
//                             keyed to the OLD id + the message lands on the
//                             LIVE successor (restores the m-424/425/429 scope);
//       host retired no successor → no change ('terminal' by the dead-settle).
//   ORDER the tests verify (the REAL drivePair):
//       :1294 dead-settle < :1315 B3 < :1328 P2 < :1360 gate < :1374 deliver.
//   TESTS (1+ per the verdict — the flavor the lane family missed: the existing
//   lane tests NEVER mention 'retired'):
//       r1 — the FIX predicate itself (the REAL `isDormantRecipient` from the
//            REAL delivery factory): a retired post/host with a sleepEpoch is
//            NOT dormant; a live post/host with a sleepEpoch IS.
//       r2 — the F-3-alive flavor (a): a 'prepared' pair to a RETIRED host
//            whose rotation chain resolves a LIVE successor — the sweep does
//            NOT park it (B3 sees dormant=false post-fix) → the deliver seam
//            is reached → 'delivered' keyed to the OLD id + the successor
//            receives the message; 0 terminal.
//       r3 — the dead-end flavor (b): a RETIRED host WITHOUT a successor →
//            'terminal' (the dead-settle at :1294 — BEFORE B3 could park).
//       r4 — the W7-A regression (c): a RETIRED post → 'terminal' intact.
//       r5 — the ORDER control: a DEAD recipient that ALSO looks dormant
//            (stale sleepEpoch) settles terminal — the dead-settle :1294 is
//            BEFORE B3 :1315, so it wins even against a dormant-looking row.
// All src-native (0 builds, 0 real APIs; temp stateDir + stub deps; the
// delivery-factory construction for r1 is the dual-surface stub pattern).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  DeliveryRedeliverer,
  markDelivery,
  parseDeliveryRows,
  resolveDeliveriesPath,
  resolveMessagesPath,
  deliveryStatus
} from '../packages/dshd-core/src/messages.ts'
import { createDeliveryOrchestration } from '../packages/dshd-orchestration/src/delivery.ts'

// ---------------------------------------------------------------------------
// Shared helpers: temp stateDir + the lane2-style redeliverer stub harness.
// ---------------------------------------------------------------------------
async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb132-retired-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

async function seed(stateDir, { records = [], rows = [] } = {}) {
  if (records.length > 0) await writeFile(resolveMessagesPath(stateDir), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  if (rows.length > 0) await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

function row(messageId, recipientId, status, ts, noWake) {
  return noWake === true ? { messageId, recipientId, status, ts, noWake } : { messageId, recipientId, status, ts }
}

function record(id, seq, to, from = 'sender') {
  return { id, seq, ts: 1_000, from, to, text: `msg ${id}`, kind: 'agent' }
}

async function readRows(stateDir) {
  return parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
}

/** Build the REAL delivery factory over a temp stateDir with stub ctx/deps
 * (the dual-surface stub pattern). Returns the REAL surface — `surface
 * .isDormantRecipient` is the FIX under test. The factory EAGERLY opens the
 * message + feedback stores at construction, so a real temp dir is required. */
function buildDeliveryFactory(stateDir, { byPost = new Map(), hosts = new Map() } = {}) {
  const logs = { info: [], warn: [] }
  const ctx = {
    logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)), error() {}, debug() {}, success() {} },
    get: () => undefined,
    // VALLE 09-07 (BATCH-DRAIN, a641964): the delivery factory registers its
    // drain-on-settle hook via `ctx.on('agent/status', …)` at construction —
    // the stub ctx must accept (and no-op) the registration (the composed
    // harness in the batch-drain test is the real Cordis ctx; here the hook is
    // irrelevant to the retired-flavor assertions).
    on: () => {}
  }
  const surface = createDeliveryOrchestration(ctx, {
    stateDir,
    byPost,
    hosts,
    byChild: new Map(),
    byHeadHandle: new Map(),
    headProgress: new Map(),
    wakePackInjected: new Set(),
    deferredSleepReplace: new Map(),
    registerEntry: () => {},
    coordinatorForPost: () => undefined,
    departmentForEntry: () => undefined,
    departmentForPost: () => undefined,
    headSetup: () => () => {},
    workerSetup: () => () => {},
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
    disposeHeadHandle: async () => {},
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
    STUCK_HEAD_MS: 60_000
  })
  surface.__logs = logs
  return surface
}

function hostEntry(hostId, sessionId, extra = {}) {
  return { hostId, sessionId, roomId: 'board', ...extra }
}

function postEntry(postId, sessionId, extra = {}) {
  return { postId, sessionId, roomId: 'board', agentPreset: 'deepartments-head', ...extra }
}

/** The recipientCatalogAlive wiring semantics END-TO-END (tools.ts:5580-5592,
 * mirrored exactly): post retired → dead; host live → alive; host retired →
 * alive IFF the rotation chain resolves a LIVE successor (F-3 — the
 * m-424/425/429 class); unknown → dead. */
function makeRecipientAlive(byPost, hosts) {
  return (recipientId) => {
    const post = byPost.get(recipientId)
    if (post !== void 0) return post.retired !== true
    const host = hosts.get(recipientId)
    if (host === void 0) return false
    if (host.retired !== true) return true
    return [...hosts.values()].some((h) => h.hostId === host.rotatedTo && h.retired !== true)
  }
}

/** The engine RE-ROUTE mimic (the deliver seam drivePair reaches): the engine's
 * `resolveBusCatalogRoute` on a retired host id returns {kind:'reroute'} →
 * deliverHost(LIVE successor) → markFinal keyed to the ORIGINAL recipient id +
 * the successor receives the message (deliverHost's followup). The stub records
 * the landing pair AND the successor forward — the observable contract of the
 * F-3 re-route. */
function rerouteDeliver(stateDir, calls, successorsByRetired) {
  return async (record, recipientId) => {
    calls.deliver.push({ messageId: record.id, recipientId })
    await markDelivery(stateDir, record.id, recipientId, 'delivered')
    const successor = successorsByRetired.get(recipientId)
    if (successor !== undefined) calls.forward.push({ messageId: record.id, from: recipientId, to: successor })
    return 'delivered'
  }
}

/** The lane2-style DeliveryRedeliverer over a temp stateDir (stub deps). */
function redeliverer(stateDir, { deliver = undefined, recipientAlive = () => true, recipientDormant = () => false, ...overrides } = {}) {
  const calls = { deliver: [], informs: [], warns: [], forward: [] }
  const recordsById = new Map()
  const deps = {
    stateDir,
    logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
    recipientAlive,
    recipientDormant,
    recipientRunning: () => false,
    getRecord: async (id) => (recordsById.get(id) ?? undefined),
    resolveCallerSessionId: (from) => from,
    deliver: deliver ?? (async (rec, recipientId) => {
      calls.deliver.push({ messageId: rec.id, recipientId })
      await markDelivery(stateDir, rec.id, recipientId, 'delivered')
      return 'delivered'
    }),
    ...overrides
  }
  const r = new DeliveryRedeliverer(deps, {
    baseDelayMs: 15_000, maxDelayMs: 600_000, maxAttempts: 12, stormWindowMs: 3600_000,
    preparedStuckMs: 600_000, g2DrainSeedLimit: 250, legacyAgeMs: 600_000
  })
  r.__calls = calls
  r.__records = (id, rec) => recordsById.set(id, rec)
  return r
}

// ===========================================================================
// r1 — the FIX PREDICATE (the REAL `isDormantRecipient` of the REAL delivery
// factory): a RETIRED entry whose entry still carries a `sleepEpoch` is NOT
// dormant — a LIVE entry with a `sleepEpoch` IS.
// ===========================================================================
test('fb132-retired (r1): isDormantRecipient returns FALSE for a RETIRED post/host EVEN with a stale sleepEpoch (the fix — the retired entry never wakes under its own id), and TRUE for a LIVE post/host with a sleepEpoch (the m-361 dormancy intact)', async () => {
  await withTempStateDir(async (stateDir) => {
    const byPost = new Map([
      ['live-head', postEntry('live-head', 's-live', { sleepEpoch: 100 })],
      ['retired-head', postEntry('retired-head', 's-ret', { retired: true, sleepEpoch: 200 })]
    ])
    const hosts = new Map([
      ['host-live', hostEntry('host-live', 's-host-live', { sleepEpoch: 300 })],
      ['host-retired', hostEntry('host-retired', 's-host-ret', { retired: true, retiredAt: 400, rotatedTo: 'host-live', sleepEpoch: 500 })],
      ['host-dead-end', hostEntry('host-dead-end', 's-host-dead', { retired: true, sleepEpoch: 600 })]
    ])
    const surface = buildDeliveryFactory(stateDir, { byPost, hosts })
    assert.equal(surface.isDormantRecipient('live-head'), true, 'a LIVE head with a sleepEpoch is dormant (m-361 unchanged — a just-slept head is never woken by B3)')
    assert.equal(surface.isDormantRecipient('retired-head'), false, 'a RETIRED head with a sleepEpoch is NOT dormant (the fix — its sleepEpoch is stale metadata; drains at its next real wake is a dead end under its own id)')
    assert.equal(surface.isDormantRecipient('host-live'), true, 'a LIVE host with a sleepEpoch is dormant (unchanged)')
    assert.equal(surface.isDormantRecipient('host-retired'), false, 'a RETIRED host WITH a live rotation successor is NOT dormant (the fix — the F-3-alive re-route must be reachable)')
    assert.equal(surface.isDormantRecipient('host-dead-end'), false, 'a RETIRED host WITHOUT a successor is NOT dormant either (the fix — dead-settle owns it before B3)')
    assert.equal(surface.isDormantRecipient('unknown-id'), false, 'a recipient with NO catalog entry is never dormant (the B3 rule unchanged)')
    assert.equal(surface.isDormantRecipient('no-sleep'), false, 'a recipient WITHOUT a sleepEpoch is not dormant (no sleep mark; the no-entry case above covers the absent id)')
  })
})

// ===========================================================================
// r2 — flavor (a): the F-3-alive re-route. A 'prepared' pair to a RETIRED host
// whose rotation chain resolves a LIVE successor: the sweep does NOT park it
// (dormant=false post-fix) → the deliver seam is reached → 'delivered' keyed to
// the OLD id + the successor receives. Order: dead-settle :1294 misses (alive
// by F-3) < B3 :1315 no park (the fix) < gate :1360 (no earlier pending) <
// deliver :1374 (the re-route).
// ===========================================================================
test('fb132-retired (r2): a \'prepared\' pair to a RETIRED host WITH a live rotation successor RE-ROUTES at the sweep — B3 does not park it post-fix (dormant=false), the deliver seam is reached, the pair settles \'delivered\' KEYED TO THE OLD id and the LIVE successor receives the message (0 terminal — the m-424/425/429 scope restored)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const oldHostId = 'host-session-0bb84189'
    const liveHostId = 'host-session-9438bcad'
    // The REAL catalog maps the factory + the redeliverer read BY REFERENCE:
    const byHosts = new Map([
      [oldHostId, hostEntry(oldHostId, 's-old', { retired: true, retiredAt: T0 - 90_000, rotatedTo: liveHostId, sleepEpoch: T0 - 3600_000 })],
      [liveHostId, hostEntry(liveHostId, 's-live')]
    ])
    const byPost = new Map()
    const surface = buildDeliveryFactory(stateDir, { byPost, hosts: byHosts })
    await seed(stateDir, {
      records: [record('m-1900', 1900, [oldHostId])],
      rows: [row('m-1900', oldHostId, 'prepared', T0 - 40 * 60_000)]
    })
    // The tools wiring semantics (tools.ts:5614/5617/6231): recipientAlive =
    // recipientCatalogAlive (F-3), recipientDormant = the REAL isDormantRecipient.
    const calls = { deliver: [], informs: [], warns: [], forward: [] }
    const successorsByRetired = new Map([[oldHostId, liveHostId]])
    const r = redeliverer(stateDir, {
      recipientAlive: makeRecipientAlive(byPost, byHosts),
      recipientDormant: (id) => surface.isDormantRecipient(id),
      deliver: rerouteDeliver(stateDir, calls, successorsByRetired)
    })
    r.__records('m-1900', record('m-1900', 1900, [oldHostId]))

    await r.sweepDue(T0)
    assert.deepEqual(calls.deliver.map((d) => d.messageId), ['m-1900'], 'the pair was NOT parked at B3 — the deliver seam was reached (dormant=false for the retired entry with a live successor)')
    assert.deepEqual(calls.forward, [{ messageId: 'm-1900', from: oldHostId, to: liveHostId }], 'the LIVE successor received the message (the engine re-route — the deliverHost followup)')
    assert.equal(await deliveryStatus(stateDir, 'm-1900', oldHostId), 'delivered', 'the pair settles DELIVERED keyed to the OLD (retired) id — the engine marks the re-routed delivery under the original recipient')
    const rows = await readRows(stateDir)
    const terminals = rows.filter((x) => x.status === 'terminal')
    assert.equal(terminals.length, 1, 'the ONLY terminal row is the G2 in-place wash of the AGED seed row (ts preserved at T0-40min — the designed spool cleanup behind a final, NOT a settle)')
    assert.equal(terminals[0].ts, T0 - 40 * 60_000, 'the washed row keeps its ORIGINAL ts (an in-place wash — proof the sweep NEVER settled the F-3-alive pair)')
    assert.ok(!r.__calls.informs.some((l) => /held gatedHeld|is dead\/unknown/.test(l)), 'no hold/settle log fired (the pair was driven, not held)')
  })
})

// ===========================================================================
// r3 — flavor (b): a RETIRED host WITHOUT a live successor → 'terminal' (the
// dead-settle at :1294 — BEFORE B3 could park; unchanged by the fix).
// ===========================================================================
test('fb132-retired (r3): a \'prepared\' pair to a RETIRED host WITHOUT a live successor settles \'terminal\' ONCE via the dead-settle (:1294 — before B3 :1315) — the deliver seam is NEVER reached (W7 terminal rule for a host-family dead end)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const deadId = 'host-session-dead-end'
    const byHosts = new Map([
      [deadId, hostEntry(deadId, 's-dead', { retired: true, retiredAt: T0 - 90_000, sleepEpoch: T0 - 3600_000 })]
    ])
    const byPost = new Map()
    const surface = buildDeliveryFactory(stateDir, { byPost, hosts: byHosts })
    await seed(stateDir, {
      records: [record('m-425', 425, [deadId])],
      rows: [row('m-425', deadId, 'prepared', T0 - 40 * 60_000)]
    })
    const calls = { deliver: [], informs: [], warns: [], forward: [] }
    const r = redeliverer(stateDir, {
      recipientAlive: makeRecipientAlive(byPost, byHosts),
      recipientDormant: (id) => surface.isDormantRecipient(id),
      deliver: rerouteDeliver(stateDir, calls, new Map())
    })
    r.__records('m-425', record('m-425', 425, [deadId]))

    await r.sweepDue(T0)
    assert.equal(await deliveryStatus(stateDir, 'm-425', deadId), 'terminal', 'a retired host with NO successor settles ONE terminal (the dead-settle, W7 — the m-424/425/429 class without a successor)')
    assert.equal(calls.deliver.length, 0, 'the deliver seam was NEVER reached (the dead-settle at :1294 fired BEFORE B3 :1315 — the order the flavor depends on)')
    assert.ok(r.__calls.informs.some((l) => /is dead\/unknown/.test(l)), 'the dead-settle log named the recipient dead/unknown')
    const rows = await readRows(stateDir)
    const terminalRows = rows.filter((x) => x.status === 'terminal')
    assert.equal(terminalRows.length, 2, 'two terminal rows: the FRESH dead-settle mark (ts ≈ pass time) + the G2 IN-PLACE wash of the AGED seed dust (ts preserved at T0-40min — the designed spool cleanup, never an extra settle)')
    const freshSettle = terminalRows.filter((x) => x.ts >= T0 - 1000)
    const washes = terminalRows.filter((x) => x.ts === T0 - 40 * 60_000)
    assert.equal(freshSettle.length, 1, 'exactly ONE fresh settle mark at the pass time (the once-only dead-settle)')
    assert.equal(washes.length, 1, 'the aged seed dust was washed IN PLACE with its ORIGINAL ts (G2 — proof the settle ran exactly once)')
  })
})

// ===========================================================================
// r4 — flavor (c): the W7-A regression — a RETIRED POST settles 'terminal'
// via the dead-settle (:1294 — before B3) exactly as pre-lane (intact).
// ===========================================================================
test('fb132-retired (r4): a \'prepared\' pair to a RETIRED POST settles \'terminal\' ONCE via the dead-settle (the W7-A rule intact — the fix NEVER changes the retired-post class: dead-settle :1294 < B3 :1315)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const retiredPostId = 'retired-worker-7f3a2'
    const byPost = new Map([
      [retiredPostId, postEntry(retiredPostId, 's-w', { retired: true, sleepEpoch: T0 - 3600_000 })]
    ])
    const hosts = new Map()
    const surface = buildDeliveryFactory(stateDir, { byPost, hosts })
    await seed(stateDir, {
      records: [record('m-7', 7, [retiredPostId])],
      rows: [row('m-7', retiredPostId, 'prepared', T0 - 40 * 60_000)]
    })
    const calls = { deliver: [], informs: [], warns: [], forward: [] }
    const r = redeliverer(stateDir, {
      recipientAlive: makeRecipientAlive(byPost, hosts),
      recipientDormant: (id) => surface.isDormantRecipient(id),
      deliver: rerouteDeliver(stateDir, calls, new Map())
    })
    r.__records('m-7', record('m-7', 7, [retiredPostId]))

    await r.sweepDue(T0)
    assert.equal(await deliveryStatus(stateDir, 'm-7', retiredPostId), 'terminal', 'a RETIRED post settles ONE terminal (W7-A — the dead-settle :1294 fires BEFORE B3 :1315; the fix must not touch this class)')
    assert.equal(calls.deliver.length, 0, 'the deliver seam was NEVER reached (the dead-settle owns the retired-post class, pre-lane behavior intact)')
    assert.ok(r.__calls.informs.some((l) => /is dead\/unknown/.test(l)), 'the dead-settle log named the retired post recipient dead')
    const rows = await readRows(stateDir)
    const terminalRows = rows.filter((x) => x.status === 'terminal')
    const freshSettle = terminalRows.filter((x) => x.ts >= T0 - 1000)
    const washes = terminalRows.filter((x) => x.ts === T0 - 40 * 60_000)
    assert.equal(freshSettle.length, 1, 'exactly ONE fresh dead-settle mark at the pass time (the once-only settle)')
    assert.equal(washes.length, 1, 'the aged seed dust was washed IN PLACE with its ORIGINAL ts (G2 — the designed spool cleanup, never an extra settle)')
  })
})

// ===========================================================================
// r5 — the ORDER control: the dead-settle (:1294) RUNS BEFORE B3 (:1315), so a
// DEAD recipient that ALSO looks dormant (stale sleepEpoch) settles terminal —
// the dormant park can never mask a dead-end (and the fix does not change it).
// ===========================================================================
test('fb132-retired (r5): the drivePair ORDER — a DEAD recipient that ALSO looks dormant (stale sleepEpoch) settles \'terminal\': the dead-settle (:1294) runs BEFORE B3 (:1315), so the park cannot mask a dead-end (the r2/r3/r4 order the flavor verifies)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = Date.now()
    const byPost = new Map([
      ['retired-post-x', postEntry('retired-post-x', 's-x', { retired: true, sleepEpoch: T0 - 3600_000 })]
    ])
    const hosts = new Map()
    const surface = buildDeliveryFactory(stateDir, { byPost, hosts })
    await seed(stateDir, {
      records: [record('m-x', 1, ['retired-post-x'])],
      rows: [row('m-x', 'retired-post-x', 'prepared', T0 - 40 * 60_000)]
    })
    // The CONTROL scenario: the recipient looks dormant (stale sleepEpoch) AND
    // is dead (retired post) — the dead-settle must WIN (it is BEFORE B3).
    const calls = { deliver: [], informs: [], warns: [], forward: [] }
    const r = redeliverer(stateDir, {
      recipientAlive: makeRecipientAlive(byPost, hosts),
      recipientDormant: () => true, // the STALE look — a dormant-looking dead recipient
      deliver: rerouteDeliver(stateDir, calls, new Map())
    })
    r.__records('m-x', record('m-x', 1, ['retired-post-x']))
    await r.sweepDue(T0)
    assert.equal(await deliveryStatus(stateDir, 'm-x', 'retired-post-x'), 'terminal', 'a DEAD recipient that ALSO looks dormant settles terminal — the dead-settle :1294 runs FIRST (before B3 :1315 could park)')
    assert.equal(calls.deliver.length, 0, 'the deliver seam never ran (the dead-settle preempted the park)')
  })
})