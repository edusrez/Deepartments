// dsh-deepartments — FOLD-IN BATCH A (2026-09-04, triage fb-116/fb-117,
// explore-deep-5 db8fedeb): the WRITE-AHEAD/DELIVERY/SWEEP family fixes:
//   (1) fb-117 FIFO GATE per recipient (deliverOrQueue): an incoming delivery
//       whose recipient has an EARLIER seq still 'prepared' (non-final) is
//       NOT spliced ahead — it degrades to the no-wake queue behind, so
//       `agent/inbox/spliced` receives in seq order (the durable queue is FIFO;
//       only the completion-order splice inverts);
//   (2) fb-116 BOUNDARY PUSH for reroutable pairs (settleRetiredHostDeliveries):
//       with the delivery seam injected, an in-flight pair to a REROUTABLE
//       retired host is re-driven IMMEDIATELY at the rotation (prepared →
//       delivered in seconds via deliverOrQueue) instead of waiting ~10 min for
//       the prepared-stuck sweep; the NON-reroutable raw-session pair still
//       terminal-settles at the boundary;
//   (3) markFinal 'failed' in the deliverOrQueue catch: a delivery that dies
//       between markPrepared and markFinal leaves a 'failed' ledger row
//       (visible, re-driveable with backoff) — never a 'prepared' orphan; the
//       caller's rethrow semantics are unchanged.
// Method (LANE ② src-native): register the ts-src-loader + import the SOURCE
// directly; 0 builds, 0 real APIs (temp stateDir + stub deps only).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// The src modules with WORKSPACE value imports load DYNAMIC (top-level await)
// AFTER the register() call — the ts-src-loader hook targets repo-.ts importers.
const D = await import('../packages/dshd-core/src/delivery.ts')
const { createDeliveryEngine } = D
const M = await import('../packages/dshd-core/src/messages.ts')
const { hasEarlierPendingPair, deliveryStatus, resolveDeliveriesPath, resolveMessagesPath, MessagesStore, markDelivery } = M
const L = await import('../packages/dshd-core/src/lifecycle.ts')
const { settleRetiredHostDeliveries } = L

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'foldins-batchA-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

const T0 = 1_700_000_000_000

/** ONE delivery-engine stub: every dep injected, 0 real APIs; the delivered
 *  side is a COUNTER (never a splice). `pendingEarlierSeq` is optional — absent
 *  = the pre-fix (no-gate) composition. */
function buildEngine({ pendingEarlierSeq, deliverHostImpl, loggerSink = [] } = {}) {
  const calls = { deliverHost: 0, finals: [] }
  const engine = createDeliveryEngine({
    stateDir: '/tmp/foldins-batchA-unused',
    logger: {
      info: (m) => loggerSink.push('info: ' + m),
      warn: (m) => loggerSink.push('warn: ' + m)
    },
    markPrepared: async () => {},
    markFinal: async (record, recipientId, status) => calls.finals.push({ id: record.id, recipientId, status }),
    resolveChild: async () => false,
    deliverChild: async () => 'delivered',
    resolveCatalogRoute: (id) => ({ kind: 'host', entry: { hostId: id, sessionId: 's-' + id, roomId: 'board' } }),
    // A HOST sender clears the defensive ACL gate (host → everyone).
    busProfileFor: () => ({ kind: 'host', memberId: 'the-host' }),
    deliverPost: async () => { calls.deliverHost++; return 'delivered' },
    deliverHost: async () => {
      calls.deliverHost++
      if (deliverHostImpl !== undefined) return deliverHostImpl()
      return 'delivered'
    },
    ...(pendingEarlierSeq === undefined ? {} : { pendingEarlierSeq })
  })
  return { engine, calls }
}

function record(id, seq, to) {
  return { id, seq, ts: T0, from: 'the-host', to, text: 'foldin probe', kind: 'agent' }
}

// ---------------------------------------------------------------------------
// (1) fb-117 — the FIFO GATE per recipient.
// ---------------------------------------------------------------------------
test('foldin batchA (fb-117): with an EARLIER prepared seq for the recipient the 2nd delivery is NOT spliced ahead — it queues behind (no-wake \'prepared\') and the wake primitive is NEVER called', async () => {
  await withTempStateDir(async () => {
    const sink = []
    const { engine, calls } = buildEngine({
      pendingEarlierSeq: async (recipientId, seq) => recipientId === 'rx' && seq === 2,
      loggerSink: sink
    })
    const status = await engine.deliverOrQueue('rx', record('m-2', 2, ['rx']), { callerAgentId: 'the-host', senderSessionId: 'the-host' })
    assert.equal(status, 'prepared', 'the gated delivery degrades to the no-wake \'prepared\' queue (BEHIND the earlier pending pair)')
    assert.equal(calls.deliverHost, 0, 'the gated delivery NEVER reaches the wake/splice primitive (no splice ahead)')
    assert.deepEqual(calls.finals, [{ id: 'm-2', recipientId: 'rx', status: 'prepared' }], 'the pair is finalized \'prepared\' (the queue-behind mark — same as the WIRED noWake branch)')
    assert.ok(sink.some((l) => /FIFO gate: m-2 → rx has an EARLIER non-final \(prepared\) seq/.test(l)), 'the gate logs the decision explicitly')
  })
})

test('foldin batchA (fb-117): WITHOUT an earlier pending seq the delivery is NORMAL (wake + \'delivered\') — and a composition WITHOUT the gate dep is byte-identical to the pre-fix path', async () => {
  await withTempStateDir(async () => {
    // (a) gate dep present but false → normal splice.
    const a = buildEngine({ pendingEarlierSeq: async () => false })
    const statusA = await a.engine.deliverOrQueue('rx', record('m-3', 3, ['rx']))
    assert.equal(statusA, 'delivered', 'no earlier pending → the delivery completes normally')
    assert.equal(a.calls.deliverHost, 1, 'the ALWAYS-WAKE primitive fires exactly once')
    assert.deepEqual(a.calls.finals, [{ id: 'm-3', recipientId: 'rx', status: 'delivered' }], 'the pair finalizes \'delivered\'')
    // (b) gate dep ABSENT → the pre-fix path (zero regression).
    const b = buildEngine({})
    const statusB = await b.engine.deliverOrQueue('rx', record('m-4', 4, ['rx']))
    assert.equal(statusB, 'delivered', 'a composition without pendingEarlierSeq keeps the pre-fix behavior')
    assert.equal(b.calls.deliverHost, 1, 'the wake primitive fires (pre-fix)')
  })
})

test('foldin batchA (fb-117): the fifo gate is FAIL-SOFT — a throwing gate check only warns and proceeds ungated (the ordering fix never breaks a delivery)', async () => {
  await withTempStateDir(async () => {
    const sink = []
    const { engine, calls } = buildEngine({
      pendingEarlierSeq: async () => { throw new Error('gate read failed') },
      loggerSink: sink
    })
    const status = await engine.deliverOrQueue('rx', record('m-5', 5, ['rx']))
    assert.equal(status, 'delivered', 'a throwing gate → the delivery proceeds ungated')
    assert.equal(calls.deliverHost, 1, 'the wake primitive still fires')
    assert.ok(sink.some((l) => /FIFO-gate check failed/.test(l)), 'the gate failure is logged (warn)')
  })
})

test('foldin batchA (fb-117): hasEarlierPendingPair (the PURE gate predicate) — an EARLIER prepared row gates; delivered/failed/no-earlier/equal-seq do NOT', async () => {
  await withTempStateDir(async (stateDir) => {
    // Seed ONE real store: m-0 (seq 0) + m-1 (seq 1) addressed to rx.
    await writeFile(resolveMessagesPath(stateDir), `${JSON.stringify(record('m-0', 0, ['rx']))}\n${JSON.stringify(record('m-1', 1, ['rx']))}\n`, 'utf8')
    const store = await MessagesStore.open(stateDir)
    const seqsOf = (recipientId) => store.seqsFor(recipientId)
    // m-1 is EARLIER than m-2 — its pair is 'prepared' → gates.
    assert.equal(hasEarlierPendingPair([{ messageId: 'm-1', recipientId: 'rx', status: 'prepared', ts: T0 }], seqsOf, 'rx', 2), true, 'an EARLIER prepared pair gates the later delivery')
    // The pair DELIVERED → no gate anymore.
    assert.equal(hasEarlierPendingPair([{ messageId: 'm-1', recipientId: 'rx', status: 'delivered', ts: T0 }], seqsOf, 'rx', 2), false, 'an earlier DELIVERED pair does not gate')
    // An earlier FAILED pair → not gated (backoff re-drive, never a fresh splice inversion).
    assert.equal(hasEarlierPendingPair([{ messageId: 'm-1', recipientId: 'rx', status: 'failed', ts: T0 }], seqsOf, 'rx', 2), false, 'an earlier FAILED pair does not gate')
    // The checked record's OWN write-ahead prepared row (equal seq) is never
    // its own blocker — strictly earlier seqs only (check m-0 itself).
    assert.equal(hasEarlierPendingPair([{ messageId: 'm-0', recipientId: 'rx', status: 'prepared', ts: T0 }], seqsOf, 'rx', 0), false, 'the checked seq itself is never its own blocker (strictly earlier only)')
    // A pending pair for a DIFFERENT recipient is irrelevant.
    assert.equal(hasEarlierPendingPair([{ messageId: 'm-1', recipientId: 'other', status: 'prepared', ts: T0 }], seqsOf, 'rx', 2), false, 'a pending pair of ANOTHER recipient never gates')
    // Integration: the REAL seam — markDelivery writes the row, the predicate
    // sees it through the sidecar (the exact wiring the engines use).
    await markDelivery(stateDir, 'm-1', 'rx', 'prepared')
    const rows = M.parseDeliveryRows(await (await import('node:fs/promises')).readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    assert.equal(hasEarlierPendingPair(rows, seqsOf, 'rx', 2), true, 'the wired predicate reads the real sidecar (an earlier prepared row gates)')
  })
})

// ---------------------------------------------------------------------------
// (2) fb-116 — the BOUNDARY PUSH for reroutable pairs.
// ---------------------------------------------------------------------------
function hostEntry(hostId, sessionId, extra = {}) {
  return { hostId, sessionId, roomId: 'board', ...extra }
}

async function seed(stateDir, { hosts = undefined, records = [], rows = [] } = {}) {
  if (hosts !== undefined) await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify(hosts), 'utf8')
  if (records.length > 0) await writeFile(resolveMessagesPath(stateDir), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  if (rows.length > 0) await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

test('foldin batchA (fb-116): a rotation with a LIVE successor — the REROUTABLE pair is PUSHED at the boundary (prepared → delivered in seconds via the delivery seam); the NON-reroutable raw-session pair still terminal-settles', async () => {
  await withTempStateDir(async (stateDir) => {
    const oldHostId = 'host-s-retired'
    const rawOldSessionId = 's-retired'
    await seed(stateDir, {
      hosts: {
        schemaVersion: 1,
        [oldHostId]: hostEntry(oldHostId, rawOldSessionId, { retired: true, rotatedTo: 'host-s-live' }),
        'host-s-live': hostEntry('host-s-live', 's-live')
      },
      records: [
        { id: 'm-440', seq: 0, ts: T0 - 20_000, from: 'internal-programming-head', to: [oldHostId], text: 'in-flight at the boundary', kind: 'agent' },
        { id: 'm-424', seq: 1, ts: T0, from: 'research-head', to: [rawOldSessionId], text: 'raw session ack', kind: 'agent' }
      ],
      rows: [
        { messageId: 'm-440', recipientId: oldHostId, status: 'prepared', ts: T0 - 20_000 },
        { messageId: 'm-424', recipientId: rawOldSessionId, status: 'prepared', ts: T0 }
      ]
    })
    const infos = []
    const pushes = []
    // The seam the COMPOSED system injects (the sweep drivePair's own seam —
    // deliverBusRecord/deliverOrQueue): here a stub that records the call and
    // settles the pair 'delivered' — the "in seconds" transition happens INSIDE
    // the one settle call, no 10-min sweep wait.
    await settleRetiredHostDeliveries(stateDir, { info: (m) => infos.push(m), warn: () => {} }, [oldHostId, rawOldSessionId], {
      rerouteDrive: async (rec, recipientId) => {
        pushes.push({ messageId: rec.id, recipientId })
        await markDelivery(stateDir, rec.id, recipientId, 'delivered')
        return 'delivered'
      }
    })
    // The PUSH: the reroutable pair was re-driven AT THE BOUNDARY (seconds).
    assert.deepEqual(pushes, [{ messageId: 'm-440', recipientId: oldHostId }], 'the reroutable pair is re-driven IMMEDIATELY at the boundary (the delivery seam)')
    assert.equal(await deliveryStatus(stateDir, 'm-440', oldHostId), 'delivered', 'the reroutable pair passes prepared → delivered in SECONDS (no ~10-min prepared-stuck sweep)')
    assert.ok(infos.some((l) => /m-440 .* PUSHED at the boundary → delivered \(fb-116/.test(l)), 'the settle logs the boundary PUSH')
    // The NON-reroutable pair keeps the terminal settle (unchanged).
    assert.equal(await deliveryStatus(stateDir, 'm-424', rawOldSessionId), 'terminal', 'the raw retired SESSION-id pair still terminal-settles at the boundary (never reroutable)')
  })
})

test('foldin batchA (fb-116): a settle WITHOUT the seam keeps the pre-fix behavior — the reroutable pair stays pending for the sweep (zero regression for minimal compositions)', async () => {
  await withTempStateDir(async (stateDir) => {
    const oldHostId = 'host-s-retired'
    await seed(stateDir, {
      hosts: {
        schemaVersion: 1,
        [oldHostId]: hostEntry(oldHostId, 's-retired', { retired: true, rotatedTo: 'host-s-live' }),
        'host-s-live': hostEntry('host-s-live', 's-live')
      },
      records: [{ id: 'm-440', seq: 0, ts: T0 - 20_000, from: 'internal-programming-head', to: [oldHostId], text: 'in-flight', kind: 'agent' }],
      rows: [{ messageId: 'm-440', recipientId: oldHostId, status: 'prepared', ts: T0 - 20_000 }]
    })
    const infos = []
    await settleRetiredHostDeliveries(stateDir, { info: (m) => infos.push(m), warn: () => {} }, [oldHostId], {})
    assert.equal(await deliveryStatus(stateDir, 'm-440', oldHostId), 'prepared', 'no seam → the reroutable pair stays PENDING (the sweep re-drives it — the pre-fix behavior)')
    assert.ok(infos.some((l) => /m-440 .* NOT settled — the in-flight delivery to a REROUTABLE retired host re-routes/.test(l)), 'the pre-fix NOT-settled log is preserved when no seam is injected')
  })
})

// ---------------------------------------------------------------------------
// (3) markFinal 'failed' in the catch.
// ---------------------------------------------------------------------------
test('foldin batchA (fb-117 cand.3): a delivery that dies between prepare and final leaves a \'failed\' ledger row (never a prepared orphan) — and the caller STILL sees the error (rethrow unchanged)', async () => {
  await withTempStateDir(async () => {
    const sink = []
    const { engine, calls } = buildEngine({
      deliverHostImpl: () => { throw new Error('wake exploded') },
      loggerSink: sink
    })
    await assert.rejects(
      () => engine.deliverOrQueue('rx', record('m-9', 9, ['rx'])),
      /wake exploded/,
      'the caller retry semantics are UNCHANGED — the error still propagates (rethrow)'
    )
    assert.equal(calls.deliverHost, 1, 'the wake attempt happened once')
    assert.deepEqual(calls.finals, [{ id: 'm-9', recipientId: 'rx', status: 'failed' }], 'the pair is FINALIZED \'failed\' (durable ledger — visible, re-driveable with backoff) — no prepared orphan')
    assert.ok(sink.some((l) => /^warn: .*sidecar write failed/.test(l)), 'the original failure is still logged')
  })
})

test('foldin batchA (fb-117 cand.3): the \'failed\' mark itself is guarded — when the sidecar is DOWN the ORIGINAL error still propagates', async () => {
  await withTempStateDir(async () => {
    const sink = []
    const failMarks = []
    const engine = createDeliveryEngine({
      stateDir: '/tmp/foldins-batchA-unused',
      logger: { info: () => {}, warn: (m) => sink.push('warn: ' + m) },
      markPrepared: async () => {},
      markFinal: async (record, recipientId, status) => { failMarks.push(status); throw new Error('fs down') },
      resolveChild: async () => false,
      deliverChild: async () => 'delivered',
      resolveCatalogRoute: (id) => ({ kind: 'host', entry: { hostId: id, sessionId: 's', roomId: 'board' } }),
      busProfileFor: () => ({ kind: 'host', memberId: 'the-host' }),
      deliverPost: async () => 'delivered',
      deliverHost: async () => { throw new Error('wake exploded') }
    })
    await assert.rejects(
      () => engine.deliverOrQueue('rx', record('m-10', 10, ['rx'])),
      /wake exploded/,
      'the ORIGINAL error propagates (the guarded \'failed\' mark never swallows it)'
    )
    assert.deepEqual(failMarks, ['failed'], 'the catch ATTEMPTED the \'failed\' mark once (the fs failure is the secondary, guarded, logged)')
    assert.ok(sink.some((l) => /'failed' mark .* could not be persisted/.test(l)), 'the guarded mark failure is logged — never a throw-mask')
  })
})