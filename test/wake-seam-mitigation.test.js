// dsh-deepartments — WAKE-SEAM MITIGATION pre-ceremony (2026-09-06, mission P1,
// run token 4f3a7fdf): the TWO pre-ceremony candidates of the explore-deep-38
// root-cause report (2026-09-06-wake-seam-rootcause-q-i82-41a11a40.md) — the
// q-i idle-hold class (3rd instance today: q-i-82: an ALWAYS-WAKE to a head
// with an earlier non-wake head is retained by the fb-117 FIFO gate → the wake
// never materializes → the worker's auto-retire (Fix B) never runs).
//
//   (A) ENGINE FIX opción-a VARIANTE (i) — the DORMANCY-AWARE FIFO gate
//       (packages/dshd-core/src/delivery.ts): the gate applies ONLY when the
//       recipient is CURRENTLY MATERIALIZED (live — `recipientMaterialized`).
//       A DORMANT recipient is NOT gated: the ALWAYS-WAKE proceeds to
//       `materializePost` (the wake) and the earlier 'prepared' head lands in
//       the SAME wake, in seq order (m-2415 «el FIFO drena en orden»). Zero
//       regression of the live case (the gate stays for a materialized
//       recipient — the fb-117 ordering guarantee) + the WIRED noWake contract
//       intact (an explicit no-wake order is never woken, even to a dormant).
//   (B) ETAPA 1 DETECTOR — scanGatedManagerDeliveryStuck (dshd-health): a
//       QUIESCENT worker (idle, no pending) whose final ALWAYS-WAKE to its
//       manager is stuck 'prepared' > 10 min (fifo-gated) — or 'terminal'
//       (the fb-132 gated-settle masked the failed wake, never delivered) — →
//       ONE finding per worker per tick (key `manager-delivery-stuck:<workerId>`,
//       the shared health-alerts ledger dedupes to ≤1 alert per window).
//
// Method (LANE ② src-native): register the ts-src-loader + import the SOURCE
// directly; 0 builds, 0 real APIs (temp stateDir + stub deps only). The
// composed tool-level harness (stub agents + the real bundle from src) is the
// wakeseam-lane pattern.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

// The src modules (ts-src-loader — the ts-loader hook targets repo-.ts importers).
const D = await import('../packages/dshd-core/src/delivery.ts')
const { createDeliveryEngine } = D
const C = await import('../packages/dshd-core/src/messages.ts')
const { resolveDeliveriesPath, resolveMessagesPath, parseDeliveryRows } = C
const H = await import('../packages/dshd-health/src/index.ts')
const { scanGatedManagerDeliveryStuck, readDeliveryRowsFull, buildHealthAlertFrame, runHealthDaemonTick, readHealthHeartbeatFile, readHealthAlertsState } = H

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUNDLE_SRC = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.ts')).href

process.env.DEEPARTMENTS_QUALITY_INSPECT = '1' // the worker-retire QD dice stays DETERMINISTIC

const T0 = 1_700_000_000_000
const OLD = T0 - 11 * 60_000 // > RE_DELIVERY_PREPARED_STUCK_MS (10 min)

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'wake-seam-mit-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

async function writeDeliveries(stateDir, rows) {
  await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

function row(messageId, recipientId, status, ts, noWake) {
  return noWake === true ? { messageId, recipientId, status, ts, noWake } : { messageId, recipientId, status, ts }
}

// ---------------------------------------------------------------------------
// (A) ENGINE-LEVEL — the DORMANCY-AWARE FIFO gate (deterministic, no harness).
// ---------------------------------------------------------------------------

/** ONE delivery-engine stub with an ALWAYS-gating earlier pair
 * (`pendingEarlierSeq` resolves true — the wake-seam condition) and the
 * dormancy probe + the no-wake-head discriminator injectable per case. */
function buildEngine({ recipientMaterialized, deliverPostImpl, earlierHeadIsNoWake } = {}) {
  const calls = { deliverPost: 0, finals: [], reasons: [] }
  const engine = createDeliveryEngine({
    stateDir: '/tmp/wake-seam-mit-unused',
    logger: { info() {}, warn() {} },
    markPrepared: async () => {},
    markFinal: async (record, recipientId, status) => calls.finals.push({ id: record.id, recipientId, status }),
    resolveChild: async () => false,
    deliverChild: async () => 'delivered',
    resolveCatalogRoute: () => ({ kind: 'post', entry: { postId: 'rx', sessionId: 's-rx', roomId: 'r' } }),
    busProfileFor: () => ({ kind: 'host', memberId: 'the-host' }),
    deliverPost: async () => {
      calls.deliverPost++
      if (deliverPostImpl !== undefined) return deliverPostImpl()
      return 'resumed'
    },
    deliverHost: async () => { calls.deliverPost++; return 'resumed' },
    pendingEarlierSeq: async () => true, // an earlier 'prepared' head pair EXISTS (the q-i-82 condition)
    ...(recipientMaterialized !== undefined ? { recipientMaterialized } : {}),
    ...(earlierHeadIsNoWake !== undefined ? { earlierHeadIsNoWake } : {})
  })
  return { engine, calls }
}

function record(id, seq) {
  return { id, seq, ts: T0, from: 'the-host', to: ['rx'], text: 'wake-seam probe', kind: 'agent' }
}

test('P1-EXT (A): an ALWAYS-WAKE to a DORMANT recipient (recipientMaterialized=false) behind an earlier \'prepared\' head is NOT retained — the gate is skipped and the wake materializes (\'resumed\') (the q-i-82 wake-seam fix)', async () => {
  // The FIX: a dormant recipient is NOT gated — deliverPost (the wake) runs.
  const a = buildEngine({ recipientMaterialized: () => false })
  const statusA = await a.engine.deliverOrQueue('rx', record('m-2', 2), { callerAgentId: 'the-host', senderSessionId: 'the-host' })
  assert.equal(statusA, 'resumed', 'A: the dormant recipient is WOKEN (resumed) — the dormancy-aware gate does not retain the ALWAYS-WAKE behind the earlier head')
  assert.equal(a.calls.deliverPost, 1, 'A: the wake primitive (materializePost) fires exactly once')
  assert.deepEqual(a.calls.finals, [{ id: 'm-2', recipientId: 'rx', status: 'resumed' }], 'A: the pair finalizes ONE resumed row (the wake) — never the \'prepared (fifo-gated)\' retention')
})

test('P1-EXT (A): the LIVE case is ZERO REGRESSION — a materialized recipient (recipientMaterialized=true) is STILL gated behind the earlier \'prepared\' head (fb-117 order intact); the ABSENT dep keeps the pre-fix behavior (default safe)', async () => {
  // (a) materialized → gate applies (the fb-117 ordering guarantee unchanged).
  const live = buildEngine({ recipientMaterialized: () => true })
  const statusLive = await live.engine.deliverOrQueue('rx', record('m-2', 2), { callerAgentId: 'the-host', senderSessionId: 'the-host' })
  assert.equal(statusLive, 'prepared', 'A-live: a MATERIALIZED recipient is still degraded to the no-wake queue behind the earlier prepared head (fb-117 intact)')
  assert.equal(live.calls.deliverPost, 0, 'A-live: the wake primitive is NEVER called for the live gated case')
  // (b) dep ABSENT → the same gate behavior (the safe default — zero regression).
  const absent = buildEngine({})
  const statusAbsent = await absent.engine.deliverOrQueue('rx', record('m-3', 3), { callerAgentId: 'the-host', senderSessionId: 'the-host' })
  assert.equal(statusAbsent, 'prepared', 'A-absent: a composition WITHOUT the recipientMaterialized dep keeps the pre-fix gate behavior (default safe)')
  assert.equal(absent.calls.deliverPost, 0, 'A-absent: the wake primitive is NEVER called (pre-fix)')
  // (c) a THROWING probe degrades to GATED (fail-soft conservative — liveness
  // is never assumed on an error; the ordering guarantee must never break).
  const throwing = buildEngine({ recipientMaterialized: () => { throw new Error('liveness read failed') } })
  const statusThrowing = await throwing.engine.deliverOrQueue('rx', record('m-4', 4), { callerAgentId: 'the-host', senderSessionId: 'the-host' })
  assert.equal(statusThrowing, 'prepared', 'A-throw: a throwing dormancy probe degrades to the gate APPLIED (conservative — never a broken ordering guarantee)')
  assert.equal(throwing.calls.deliverPost, 0, 'A-throw: the wake primitive is NEVER called (the gate stayed)')
})

test('P1-EXT (A): AFTER the fix the WIRED noWake contract is intact — an explicit noWake send to a DORMANT recipient behind an earlier \'prepared\' head STILL reports \'prepared (noWake)\' (never woken, never fifo-gated)', async () => {
  // The dormancy probe says false (dormant — the fix would skip the gate), yet
  // the WIRED noWake ORDER must win: the record persists 'prepared' and the
  // recipient is NOT materialized (the no-wake-until-wake semantics, m-707).
  const { engine, calls } = buildEngine({ recipientMaterialized: () => false })
  let reason
  const status = await engine.deliverOrQueue('rx', record('m-5', 5), {
    callerAgentId: 'the-host',
    senderSessionId: 'the-host',
    noWake: true,
    gateReason: (r) => { reason = r }
  })
  assert.equal(status, 'prepared', 'A-noWake: the WIRED noWake send returns prepared (the explicit no-wake order never wakes)')
  assert.equal(reason, 'noWake', 'A-noWake: the queue-class observer reports the noWake class (the tool envelope \'prepared (noWake)\')')
  assert.equal(calls.deliverPost, 0, 'A-noWake: the wake primitive is NEVER called — a dormant recipient with an explicit noWake order stays dormant')
})

test('P1-EXT-EXT (m-2415 discriminator, a): an ALWAYS-WAKE to a LIVE recipient behind a NO-WAKE head is NOT gated — it DELIVERS (\'resumed\') and the wake primitive fires (the P0 host-freeze fix: the no-wake head never blocks the real wake)', async () => {
  // The P0 datapoint (2026-09-06): a LIVE (materialized) recipient whose gating
  // head is a noWake row — the variant-(i) dormancy probe cannot help (the host
  // family resolves `undefined` → gate applies) and the P2 sweep guard never
  // re-drives the noWake head into a non-running recipient → the queue froze
  // forever. The DISCRIMINATOR: `earlierHeadIsNoWake === true` → the gate is
  // SKIPPED for the ALWAYS-WAKE (the real wake — m-2415 «la cabeza no-wake
  // drena CON el wake, nunca lo bloquea»).
  const a = buildEngine({ recipientMaterialized: () => true, earlierHeadIsNoWake: async () => true })
  const statusA = await a.engine.deliverOrQueue('rx', record('m-7', 7), { callerAgentId: 'the-host', senderSessionId: 'the-host' })
  assert.equal(statusA, 'resumed', 'A-live-nowake: the ALWAYS-WAKE to the LIVE recipient behind the NO-WAKE head DELIVERS (resumed) — never the \'prepared (fifo-gated)\' freeze')
  assert.equal(a.calls.deliverPost, 1, 'A-live-nowake: the wake primitive (materializePost/busDeliverToHost) fires exactly once')
  assert.deepEqual(a.calls.finals, [{ id: 'm-7', recipientId: 'rx', status: 'resumed' }], 'A-live-nowake: the pair finalizes ONE resumed row — the durable no-wake head stays (it drains with this wake, in seq order)')
})

test('P1-EXT-EXT (m-2415 discriminator, c): a LIVE recipient behind a CRASH-CLASS (non-noWake) prepared head is STILL gated — \'prepared\' + the fifo queue class (fb-117 live ordering intact)', async () => {
  // fb-117 CONTROL: the discriminator resolves `false` (the head is a
  // crash-class non-noWake prepared row) → the gate applies EXACTLY as before
  // the extension — the completion-order splice can still invert, so the
  // ordering guarantee stays.
  const a = buildEngine({ recipientMaterialized: () => true, earlierHeadIsNoWake: async () => false })
  let reason
  const statusA = await a.engine.deliverOrQueue('rx', record('m-8', 8), { callerAgentId: 'the-host', senderSessionId: 'the-host', gateReason: (r) => { reason = r } })
  assert.equal(statusA, 'prepared', 'A-live-crash: a crash-class head keeps the gate (fb-117 — the live splice order never breaks)')
  assert.equal(reason, 'fifo', 'A-live-crash: the queue-class observer reports the fifo class (the tool envelope \'prepared (fifo-gated)\')')
  assert.equal(a.calls.deliverPost, 0, 'A-live-crash: the wake primitive is NEVER called (the crash-class gate stays)')
})

test('P1-EXT-EXT (m-2415 discriminator, d): the WIRED noWake contract is intact under the discriminator — a WIRED noWake send to a LIVE recipient behind a NO-WAKE head still reports \'prepared (noWake)\' with ZERO wake (the discriminator never turns a no-wake ORDER into a wake)', async () => {
  // The discriminator un-gates the ALWAYS-WAKE path, but a WIRED noWake:true
  // ORDER still owns the outcome: the catalogRoute noWake branch returns
  // 'prepared' + the noWake queue class — the recipient is never woken (m-707).
  const { engine, calls } = buildEngine({ recipientMaterialized: () => true, earlierHeadIsNoWake: async () => true })
  let reason
  const status = await engine.deliverOrQueue('rx', record('m-9', 9), {
    callerAgentId: 'the-host',
    senderSessionId: 'the-host',
    noWake: true,
    gateReason: (r) => { reason = r }
  })
  assert.equal(status, 'prepared', 'A-d: the WIRED noWake send returns prepared (the no-wake-until-wake order never wakes)')
  assert.equal(reason, 'noWake', 'A-d: the queue-class observer reports the noWake class (the WIRED branch owns the classification — never the fifo class)')
  assert.equal(calls.deliverPost, 0, 'A-d: the wake primitive is NEVER called — the discriminator un-gates but never wakes a WIRED noWake order')
})

test('P1-EXT-EXT (m-2415 discriminator, e): the discriminator dep is OPT-IN — absent OR throwing degrades to the gate APPLIED (the safe default; the fb-117 live case never breaks)', async () => {
  // (a) dep ABSENT → the pre-extension live gate behavior (zero regression).
  const absent = buildEngine({ recipientMaterialized: () => true })
  const statusAbsent = await absent.engine.deliverOrQueue('rx', record('m-10', 10), { callerAgentId: 'the-host', senderSessionId: 'the-host' })
  assert.equal(statusAbsent, 'prepared', 'A-e-absent: WITHOUT the earlierHeadIsNoWake dep the LIVE case keeps the pre-extension gate (the safe default — the discriminator is opt-in via the dep)')
  assert.equal(absent.calls.deliverPost, 0, 'A-e-absent: the wake primitive is NEVER called (pre-extension)')
  // (b) THROWING probe → the gate applies (conservative — liveness/head knowledge
  // is never assumed on an error; the ordering guarantee must never break).
  const throwing = buildEngine({ recipientMaterialized: () => true, earlierHeadIsNoWake: async () => { throw new Error('head read failed') } })
  const statusThrowing = await throwing.engine.deliverOrQueue('rx', record('m-11', 11), { callerAgentId: 'the-host', senderSessionId: 'the-host' })
  assert.equal(statusThrowing, 'prepared', 'A-e-throw: a throwing discriminator degrades to the gate APPLIED (conservative)')
  assert.equal(throwing.calls.deliverPost, 0, 'A-e-throw: the wake primitive is NEVER called (the gate stayed)')
  // (c) `undefined` RESULT (the dep exists but resolves undefined — no head
  // knowledge) → the gate applies the same way.
  const undefinedResult = buildEngine({ recipientMaterialized: () => true, earlierHeadIsNoWake: async () => undefined })
  const statusUnd = await undefinedResult.engine.deliverOrQueue('rx', record('m-12', 12), { callerAgentId: 'the-host', senderSessionId: 'the-host' })
  assert.equal(statusUnd, 'prepared', 'A-e-undefined: a discriminator resolving undefined keeps the gate (the safe default)')
  assert.equal(undefinedResult.calls.deliverPost, 0, 'A-e-undefined: the wake primitive is NEVER called (the gate stayed)')
})

// ---------------------------------------------------------------------------
// (B) ETAPA 1 — the manager-delivery-stuck detector (PURE; scanStalledPosts-style).
// ---------------------------------------------------------------------------

function quiescentWorker(over = {}) {
  return {
    postId: 'w-1',
    provider: 'worker',
    retired: false,
    running: false,
    managerId: 'quality-head',
    events: [],
    inboxTs: [],
    ...over
  }
}

function headPost(postId = 'quality-head') {
  return { postId, provider: undefined, retired: false, running: false, events: [], inboxTs: [] }
}

test('P1-EXT (B): scanGatedManagerDeliveryStuck FIRES for a QUIESCENT worker with a stuck prepared par (> 10 min, non-noWake) to its LIVE manager — ONE finding keyed manager-delivery-stuck:<workerId>; the alert frame renders the class', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeDeliveries(stateDir, [row('m-9', 'quality-head', 'prepared', OLD)])
    const posts = [quiescentWorker(), headPost()]
    const findings = scanGatedManagerDeliveryStuck(posts, stateDir, T0)
    assert.equal(findings.length, 1, 'B-fires: exactly ONE finding (one worker, one stuck par)')
    assert.equal(findings[0].kind, 'manager-delivery-stuck', 'B-fires: the finding kind is manager-delivery-stuck')
    assert.equal(findings[0].key, 'manager-delivery-stuck:w-1', 'B-fires: the dedupe key is per-worker (the shared ledger \u22641 alert per window)')
    assert.equal(findings[0].postId, 'w-1', 'B-fires: the finding names the stuck worker')
    assert.equal(findings[0].messageId, 'm-9', 'B-fires: the finding names the stuck pair')
    assert.equal(findings[0].ts, OLD, 'B-fires: the finding ts is the stuck attempt ts')
    assert.match(findings[0].error, /fifo-gated/, 'B-fires: the error explains the wake-seam retention')
    const frame = buildHealthAlertFrame(findings)
    assert.match(frame, /manager-delivery-stuck: worker "w-1"/, 'B-fires: the alert frame renders the dedicated branch (never the stalled-post fallback)')
  })
})

test('P1-EXT (B): the anti-false-positive matrix — NEVER fires for running / inbox-pending / noWake row / dead manager / fresh row / non-worker', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeDeliveries(stateDir, [row('m-9', 'quality-head', 'prepared', OLD)])
    const base = [quiescentWorker(), headPost()]
    // (a) RUNNING worker — an in-flight turn is work in progress.
    assert.equal(scanGatedManagerDeliveryStuck([quiescentWorker({ running: true }), headPost()], stateDir, T0).length, 0, 'B-fp: a RUNNING worker is never flagged')
    // (b) PENDING inbox — the worker is awaiting instructions, not quiescent.
    assert.equal(scanGatedManagerDeliveryStuck([quiescentWorker({ inboxTs: [T0 - 60_000] }), headPost()], stateDir, T0).length, 0, 'B-fp: a worker with pending inbox work is never flagged')
    // (c) noWake row — the explicit no-wake-until-wake ORDER is never an alarm.
    await writeDeliveries(stateDir, [row('m-9', 'quality-head', 'prepared', OLD, true)])
    assert.equal(scanGatedManagerDeliveryStuck(base, stateDir, T0).length, 0, 'B-fp: a noWake marked par is NEVER flagged (m-707 intent)')
    // (d) DEAD/UNKNOWN manager — the settle owns it, never this detector.
    await writeDeliveries(stateDir, [row('m-9', 'quality-head', 'prepared', OLD)])
    assert.equal(scanGatedManagerDeliveryStuck([quiescentWorker(), headPost({ postId: 'quality-head', retired: true })], stateDir, T0).length, 0, 'B-fp: a RETIRED manager is never flagged (dead-recipient exclusion)')
    assert.equal(scanGatedManagerDeliveryStuck([quiescentWorker({ managerId: 'ghost-head' }), headPost()], stateDir, T0).length, 0, 'B-fp: an UNKNOWN manager (no catalog post) is never flagged')
    // (e) RETIRED worker — a retired worker is not an idle-hold subject.
    assert.equal(scanGatedManagerDeliveryStuck([quiescentWorker({ retired: true }), headPost()], stateDir, T0).length, 0, 'B-fp: a RETIRED worker is never flagged')
    // (f) FRESH row (< 10 min) — a live write-ahead, never a stuck par.
    await writeDeliveries(stateDir, [row('m-9', 'quality-head', 'prepared', T0 - 60_000)])
    assert.equal(scanGatedManagerDeliveryStuck(base, stateDir, T0).length, 0, 'B-fp: a FRESH prepared row (< 10 min) is never flagged (the fb-58 age window)')
    // (g) NON-worker provider — a configured head is never a worker-retire subject.
    await writeDeliveries(stateDir, [row('m-9', 'quality-head', 'prepared', OLD)])
    assert.equal(scanGatedManagerDeliveryStuck([headPost('w-1'), headPost()], stateDir, T0).length, 0, 'B-fp: a non-worker post is never flagged')
    // (h) NO managerId — a post without the retire contract is not a subject.
    assert.equal(scanGatedManagerDeliveryStuck([quiescentWorker({ managerId: undefined }), headPost()], stateDir, T0).length, 0, 'B-fp: a worker without a managerId is never flagged')
    // (i) DELIVERED par — a settled pair is never a stuck par.
    await writeDeliveries(stateDir, [row('m-9', 'quality-head', 'prepared', OLD), row('m-9', 'quality-head', 'delivered', OLD + 1000)])
    assert.equal(scanGatedManagerDeliveryStuck(base, stateDir, T0).length, 0, 'B-fp: a pair the recipient was WOKEN for (delivered) is never flagged')
  })
})

test('P1-EXT (B refinement): the fb-132 gated-SETTLE class — a pair converted to \'terminal\' NEVER delivered (the settle masked the failed wake) IS flagged when the worker\'s final turn ended AFTER the original attempt (the anchor); a delivered/resumed pair is NOT', async () => {
  await withTempStateDir(async (stateDir) => {
    // The settled par: m-9 was retained 'prepared' (T0 − 25 min — inside the
    // worker's FINAL turn: prevEnd T0 − 30 min < attempt <= lastEnd T0 − 9 min)
    // and the fb-132 gated-settle converted it to 'terminal' (~10 min later)
    // WITHOUT ever delivering/waking the recipient.
    const worker = quiescentWorker({
      events: [
        { type: 'turn/end', time: T0 - 30 * 60_000 },
        { type: 'turn/end', time: T0 - 9 * 60_000 }
      ]
    })
    await writeDeliveries(stateDir, [
      row('m-9', 'quality-head', 'prepared', T0 - 25 * 60_000),
      row('m-9', 'quality-head', 'terminal', T0 - 9 * 60_000)
    ])
    const posts = [worker, headPost()]
    const findings = scanGatedManagerDeliveryStuck(posts, stateDir, T0)
    assert.equal(findings.length, 1, 'B-settle: the settle-masked pair IS flagged (the wake never happened — the q-i hold persists behind the terminal)')
    assert.equal(findings[0].messageId, 'm-9', 'B-settle: the finding names the settled pair')
    // CONTROL: the pair WAS delivered at some point → never the stuck class.
    await writeDeliveries(stateDir, [
      row('m-9', 'quality-head', 'prepared', T0 - 25 * 60_000),
      row('m-9', 'quality-head', 'resumed', T0 - 20 * 60_000),
      row('m-9', 'quality-head', 'terminal', T0 - 9 * 60_000)
    ])
    assert.equal(scanGatedManagerDeliveryStuck(posts, stateDir, T0).length, 0, 'B-settle-control: a pair the recipient WAS woken for (resumed) is never flagged, even if a later terminal row exists')
    // RE-ANCHOR control: an attempt OUTSIDE the worker\'s final turn (an older
    // other-sender row the anchor must NOT count) → not flagged.
    await writeDeliveries(stateDir, [
      row('m-9', 'quality-head', 'prepared', T0 - 45 * 60_000),
      row('m-9', 'quality-head', 'terminal', T0 - 9 * 60_000)
    ])
    assert.equal(scanGatedManagerDeliveryStuck(posts, stateDir, T0).length, 0, 'B-settle-anchor: an attempt OLDER than the worker\'s previous turn/end (not its own final report) is not counted (the final-turn anchor)')
  })
})

test('P1-EXT (B): ONE finding per worker per tick even with MULTIPLE stuck pars (the per-worker dedupe by construction); MULTIPLE stuck workers → one finding each', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeDeliveries(stateDir, [
      row('m-9', 'quality-head', 'prepared', OLD),
      row('m-10', 'quality-head', 'prepared', OLD - 60_000)
    ])
    const posts = [quiescentWorker(), quiescentWorker({ postId: 'w-2' }), headPost()]
    const findings = scanGatedManagerDeliveryStuck(posts, stateDir, T0)
    assert.equal(findings.length, 2, 'B-dedupe: ONE finding per stuck worker (w-1 + w-2), never per-par')
    assert.deepEqual(findings.map((f) => f.key).sort(), ['manager-delivery-stuck:w-1', 'manager-delivery-stuck:w-2'], 'B-dedupe: the per-worker keys are the dedupe identity')
    assert.equal(findings.find((f) => f.key === 'manager-delivery-stuck:w-1').messageId, 'm-10', 'B-dedupe: the worker finding reports the OLDEST stuck par (m-10 older than m-9)')
  })
})

test('P1-EXT (B): the REAL tick integrates the detector — the finding ALERTS the host (the existing alert/dedupe path) AND the heartbeat sweep datum carries gatedIdleHeld = the stuck-worker count of the tick', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeDeliveries(stateDir, [row('m-9', 'quality-head', 'prepared', OLD)])
    const alerts = []
    const posts = [quiescentWorker(), quiescentWorker({ postId: 'w-2' }), headPost()]
    await runHealthDaemonTick({
      now: () => T0,
      stateDir,
      bootId: 'boot-wsm-1',
      config: { health: {} },
      hosts: [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }],
      posts,
      sweep: { armed: true, cycles: 2 },
      notifyHost: async (hostEntry, frame) => { alerts.push({ hostEntry, frame }) }
    })
    assert.equal(alerts.length, 1, 'B-tick: the real tick alerts through the existing host-alert path (ONE grouped frame per tick — the alert path groups all net-new findings)')
    const bullets = (alerts[0].frame.match(/manager-delivery-stuck: worker "/g) ?? [])
    assert.equal(bullets.length, 2, 'B-tick: the grouped frame carries BOTH stuck workers (w-1 + w-2 bullets)')
    assert.match(alerts[0].frame, /manager-delivery-stuck: worker "w-1"/, 'B-tick: the alert frame names the first stuck worker (the dedicated branch)')
    const hb = readHealthHeartbeatFile(stateDir)
    assert.deepEqual(hb.sweep.gatedIdleHeld, 2, 'B-tick: the heartbeat sweep datum carries gatedIdleHeld = the stuck-worker count of THIS tick (the class preparedStuckRemaining masks)')
    const ledger = readHealthAlertsState(stateDir)
    assert.ok(ledger['manager-delivery-stuck:w-1'] !== undefined && ledger['manager-delivery-stuck:w-2'] !== undefined, 'B-tick: the per-worker dedupe keys advanced in the SHARED health-alerts ledger (≤1 alert per worker per window)')
    // CONTROL: no stuck worker → the datum is 0 (a real value, never a stale positive).
    alerts.length = 0
    await runHealthDaemonTick({
      now: () => T0 + 60_000,
      stateDir,
      bootId: 'boot-wsm-1',
      config: { health: {} },
      hosts: [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }],
      posts: [headPost()],
      sweep: { armed: true, cycles: 3 },
      notifyHost: async (hostEntry, frame) => { alerts.push({ hostEntry, frame }) }
    })
    const hb2 = readHealthHeartbeatFile(stateDir)
    assert.equal(hb2.sweep.gatedIdleHeld, 0, 'B-tick-control: without stuck workers the datum is 0 (the value is per-tick, never a stale residue)')
  })
})

// ---------------------------------------------------------------------------
// (A) TOOL-LEVEL — the composed bundle (stub agents + the real src): the
// dormant-recipient wake lands + the durable queue stays in seq order + the
// LIVE-case gate regression intact.
// ---------------------------------------------------------------------------
const ORG = {
  departments: [
    {
      id: 'research',
      name: 'Research',
      coordinator: { postId: 'research-head', role: 'Research department head', provider: 'deepseek-official', agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' } }
    }
  ]
}

const postAdoption = new Map()

function stubProvider(name) {
  return {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: name === 'fork',
    async start() { throw new Error('stub provider: one-shot start is not used') },
    async prepareContinuable() { return { seed: [] } }
  }
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
  const childKey = Symbol('wake-seam-mit-stub-child-scope')
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
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.childContexts = []
    this.childAgents = []
    this.scopeAnchor = ctx
    this.disposeCalls = new Map()
    this.createCalls = []
    this.resumeCalls = []
  }
  get(id) { return this.store.get(id) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  async create(options) {
    this.createCalls.push(options)
    return materializeStubAgent(this, options.sessionId, options)
  }
  async resume(options) {
    this.resumeCalls.push(options)
    return materializeStubAgent(this, options.resumeSessionId, { ...options, parentSession: postAdoption.get(options.resumeSessionId) })
  }
}

class StubPersistence extends Service {
  constructor(ctx) { super(ctx, 'sessionPersistence') }
  async readRaw() { return undefined }
}

class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.archived = []
  }
  get archivedSessionIds() { return this.archived }
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
  const agents = new StubAgents(root)
  const persistence = new StubPersistence(root)
  const workspaceRegistry = new StubWorkspaceRegistry(root, stateDir)
  await root.plugin(SubagentRuntime)
  root.subagents.registerProvider(stubProvider('spawn'))
  root.subagents.registerProvider(stubProvider('fork'))
  loader.create({ id: 'deepartments', name: BUNDLE_SRC, config: { stateDir, org: opts.org ?? ORG } })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return { root, agents, persistence, workspaceRegistry, pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx, dispose: () => loaderFiber.dispose() }
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

async function withBootedOrg(fn) {
  return withTempStateDir(async (stateDir) => {
    const env = await bootPluginFromSrc(stateDir)
    try {
      await waitFor(() => env.agents.store.has('head-research-head'), 8000, 'research head materialized')
      const head = env.agents.store.get('head-research-head')
      const headCtx = childContextFor(env.agents, 'head-research-head')
      assert.ok(headCtx, 'the head own-layer context resolves')
      const signal = new AbortController().signal
      const spawn = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'wake-seam mitigation test worker' }, { agent: head, signal })
      assert.ok(spawn.workerId, 'the worker spawned')
      await waitFor(() => env.agents.store.has(spawn.sessionId), 8000, 'the worker is live')
      return await fn({ stateDir, env, head, headCtx, spawn, signal })
    } finally {
      await env.dispose()
    }
  })
}

test('P1-EXT-EXT (A tool-level): an ALWAYS-WAKE to a DORMANT worker behind an earlier \'prepared\' head MATERIALIZES it (\'resumed\') in seq order; the SAME worker LIVE behind the SAME NO-WAKE head is NO LONGER gated (\'resumed\' — the m-2415 no-wake-head discriminator: the ALWAYS-WAKE is the real wake, the no-wake head never blocks) AND the no-wake head STAYS durable; the CRASH-CLASS control (a LIVE worker behind a non-noWake prepared head) is STILL gated (\'prepared (fifo-gated)\' — fb-117 intact)', async () => {
  await withBootedOrg(async ({ stateDir, env, head, headCtx, spawn, signal }) => {
    const workerId = spawn.workerId
    const send = (extra) => headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: [workerId], text: `wake-seam probe ${JSON.stringify(extra)}`, ...extra }, { agent: head, signal })
    // (1) an explicit noWake send FIRST → the ROW that later gates (the P2-hold
    // head of the q-i-82 flavor) — the worker is NOT woken (dormant stays).
    const noWakeRes = await send({ noWake: true })
    assert.equal(noWakeRes.delivered[workerId], 'prepared (noWake)', 'A-tool(1): the WIRED noWake send reports the noWake class (contract intact after the fix)')
    // (2) make the worker DORMANT (dispose its live handle — the q-i post-
    // delivery hold state).
    env.agents.disposeCalls.set(spawn.sessionId, (env.agents.disposeCalls.get(spawn.sessionId) ?? 0) + 1)
    env.agents.store.delete(spawn.sessionId)
    assert.equal(env.agents.get(spawn.sessionId), undefined, 'A-tool(2): the worker handle is gone (dormant)')
    // (3) the DEFAULT always-wake send → the dormancy-aware gate SKIPS the
    // FIFO retention → the worker MATERIALIZES (resumed); the durable queue
    // keeps the earlier head BEFORE the wake message (seq order).
    const beforeResume = env.agents.resumeCalls.length
    const wake = await send({})
    assert.equal(wake.delivered[workerId], 'resumed', 'A-tool(3): the always-wake to the DORMANT worker behind the earlier prepared head WAKES it (resumed) — the wake-seam fix (regression 0 under the discriminator)')
    await waitFor(() => env.agents.resumeCalls.length > beforeResume, 8000, 'the worker session is re-materialized (resume called)')
    assert.ok(env.agents.resumeCalls.some((r) => r.resumeSessionId === spawn.sessionId), 'A-tool(3): the re-materialization resumed the worker\'s OWN durable session')
    assert.ok(env.agents.store.has(spawn.sessionId), 'A-tool(3): the worker is LIVE again after the wake')
    const durableText = await readFile(resolveMessagesPath(stateDir), 'utf8')
    const records = durableText.trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.to.includes(workerId))
    assert.equal(records[records.length - 2].seq < records[records.length - 1].seq, true, 'A-tool(3): the durable queue is FIFO — the earlier head (seq n) sits BEFORE the wake message (seq n+1) in the store')
    assert.equal(records[records.length - 1].to[0], workerId, 'A-tool(3): the wake message addresses the worker')
    // (4) P1-EXT-EXT (m-2415 discriminator) — the SAME worker now LIVE
    // (materialized again) behind the STILL-PENDING NO-WAKE head: a further
    // ALWAYS-WAKE is NOT gated — it DELIVERS ('delivered' — the splice into the
    // live inbox) because the gating head is a no-wake row (a deliberate
    // no-wake-until-wake send never blocks the real wake — the P0 host-freeze
    // fix); AND the no-wake head STAYS durable ('prepared' + noWake flag — the
    // discriminator never touches it).
    const liveWake = await send({})
    assert.equal(liveWake.delivered[workerId], 'delivered', `A-tool(4): the LIVE worker behind the NO-WAKE head is NOT gated — the ALWAYS-WAKE delivers (delivered — the live splice) (got "${liveWake.delivered[workerId]}") — the m-2415 no-wake-head discriminator`)
    await waitFor(() => (env.agents.get(spawn.sessionId)?.inboxMessages ?? []).length >= 2, 8000, 'the live wake spliced into the live inbox (the resume created a FRESH agent — its inbox holds the step-3 wake splice + the step-4 live-wake splice; the spawn-time baseline inbox was discarded at resume)')
    const deliveriesText = await readFile(resolveDeliveriesPath(stateDir), 'utf8')
    const deliveriesRows = parseDeliveryRows(deliveriesText)
    const headRows = deliveriesRows.filter((r) => r.recipientId === workerId && r.messageId === noWakeRes.messageId)
    assert.equal(headRows[headRows.length - 1].status, 'prepared', 'A-tool(4): the no-wake head STAYS durable (\'prepared\' — the discriminator never settles/consumes it; it drains with the wake in seq order)')
    assert.equal(headRows[headRows.length - 1].noWake, true, 'A-tool(4): the no-wake head STAYS marked no-wake (the m-707 flag is preserved)')
    // (5) CRASH-CLASS CONTROL (fb-117 intact) — a SECOND worker with a FRESH
    // queue: a LIVE recipient behind a CRASH-CLASS (non-noWake) prepared head is
    // STILL gated ('prepared (fifo-gated tras m-<seq>)' — the discriminator
    // resolves false and the ordering guarantee stays).
    const spawn2 = await headCtx.ctx.tools.get('dept_worker_spawn', headCtx.key).execute({ role: 'researcher', task: 'wake-seam crash-class control worker' }, { agent: head, signal })
    assert.ok(spawn2.workerId, 'A-tool(5): the control worker spawned')
    await waitFor(() => env.agents.store.has(spawn2.sessionId), 8000, 'the control worker is live')
    const crashWorkerId = spawn2.workerId
    const sendCrash = (extra) => headCtx.ctx.tools.get('send_message', headCtx.key).execute({ to: [crashWorkerId], text: `crash-class probe ${JSON.stringify(extra)}`, ...extra }, { agent: head, signal })
    const first = await sendCrash({})
    assert.equal(first.delivered[crashWorkerId], 'delivered', 'A-tool(5): the first always-wake to the LIVE control worker delivers (its own fresh head never blocks itself)')
    // Corrupt the pair INTO the crash class: append a NON-noWake 'prepared' row
    // for the delivered message — the LATEST row per pair wins → the pair is now
    // a write-ahead orphan (the crash class), the head the gate must still honor.
    const deliveriesBefore = await readFile(resolveDeliveriesPath(stateDir), 'utf8')
    await writeFile(resolveDeliveriesPath(stateDir), deliveriesBefore + JSON.stringify(row(first.messageId, crashWorkerId, 'prepared', T0)) + '\n', 'utf8')
    const gated = await sendCrash({})
    assert.match(gated.delivered[crashWorkerId], /^prepared \(fifo-gated/, `A-tool(5): the LIVE worker behind the CRASH-CLASS (non-noWake) prepared head is STILL gated (got "${gated.delivered[crashWorkerId]}") — fb-117 live ordering intact (the discriminator only un-gates NO-WAKE heads)`)
    const inbox2 = env.agents.get(spawn2.sessionId)?.inboxMessages ?? []
    assert.equal(inbox2.length, 2, 'A-tool(5): the gated crash-class send NEVER spliced into the live inbox (baseline spawn splice + the first delivered send — the gated send adds nothing)')
  })
})