// dsh-deepartments — FOLD-IN TRAMO 3A (2026-09-04, zona DELIVERY/ARCHIVE — the
// QD queue items O4-ESCALADO / m-707 / fb-117 candidate 2):
//   (1) O4 RETIRE-ON-DELIVERY (m-952 + D-Q2 c4739f3d): a REAL retire
//       (markPostRetired — the ONE shared retire seam behind dept_post_retire /
//       dept_worker_retire / the auto-retire-on-delivery / the boot reap)
//       appends the post's audit row to posts-retired-archive.jsonl —
//       {postId, entry, prunedAt} with the REAL retire ts — closing the
//       archive-log GAP (frozen with 0 rows for 09-04 despite several retires:
//       the archive grew ONLY at boot prunes beyond `retiredKeep`, never at
//       runtime retires). A REPLACEMENT without a real retire appends NOTHING.
//   (2) m-707 WATCHDOG NO-WAKE FILTER: a noWake:true delivery marks BOTH its
//       sidecar rows `noWake`, and the health watchdog's inbox reader
//       (computeInboxTsByPost) EXCLUDES them — a recipient receiving only
//       no-wakes stays idle for the watchdog (never flips the stale-live /
//       stall detectors to 'active'); an always-wake delivery still counts.
//   (3) fb-117 (fix candidate 2 of the triage) RE-DRIVE ORDERED BY SEQ:
//       sweepDue drives the DUE batch in (recipientId, seq) order — the
//       re-drives of ONE recipient enter in delivery-queue sequence despite an
//       out-of-seq FILE order (complements the batch-A FIFO gate, which closes
//       the inversion at the fresh-splice root; the sort orders the SWEEP
//       batch). The pairDue criterion (prepared>10min / failed-backoff) is
//       UNCHANGED.
// Method (LANE ② / TRAMO 3A src-native): register the ts-src-loader + import
// the SOURCE directly; 0 builds, 0 real APIs (temp stateDir + stub deps only).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// The src modules with workspace/relative value imports load DYNAMIC (top-level
// await) AFTER the register() call — the ts-src-loader hook targets repo-.ts
// importers.
const M = await import('../packages/dshd-core/src/messages.ts')
const { DeliveryRedeliverer, markDelivery, parseDeliveryRows, resolveDeliveriesPath, resolveMessagesPath, deliveryStatus } = M
const R = await import('../packages/dshd-core/src/registry.ts')
const { RegistryStore } = R
const D = await import('../packages/dshd-core/src/delivery.ts')
const { createDeliveryEngine } = D
const H = await import('../packages/dshd-health/src/index.ts')
const { computeInboxTsByPost, buildPostSnapshot } = H

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'foldins-tramo3A-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

const T0 = 1_700_000_000_000

function row(messageId, recipientId, status, ts) {
  return { messageId, recipientId, status, ts }
}

function workerEntry(postId, sessionId) {
  return { postId, sessionId, roomId: 'board', agentPreset: 'deepartments-worker', provider: 'worker', role: 'builder', departmentId: 'ipd', managerId: 'ipd-head' }
}

function archiveLines(stateDir) {
  return readFile(path.join(stateDir, 'posts-retired-archive.jsonl'), 'utf8')
    .then((text) => text.trim().split('\n').filter((l) => l.length > 0))
}

// ---------------------------------------------------------------------------
// (1) O4 — RETIRE-ON-DELIVERY (the retired-archive gap; m-952 + D-Q2 c4739f3d).
// ---------------------------------------------------------------------------
test('tramo 3A (O4): a REAL retire appends the archive row {postId, entry, prunedAt} with the REAL retire ts — closing the archive-log gap (the log previously grew ONLY at boot prunes beyond retiredKeep, never at runtime retires)', async () => {
  await withTempStateDir(async (stateDir) => {
    const warns = []
    const store = new RegistryStore({ stateDir, logger: { warn: (m) => warns.push(m), info() {} } })
    store.registerEntry(workerEntry('w1', 's1'))
    const before = Date.now()
    await store.markPostRetired('w1')
    const after = Date.now()
    // The archive EXISTS with EXACTLY ONE row (the retire appended it).
    const lines = await archiveLines(stateDir)
    assert.equal(lines.length, 1, 'the real retire appended EXACTLY ONE archive row')
    const archived = JSON.parse(lines[0])
    assert.equal(archived.postId, 'w1', 'the row inventories the retired post')
    assert.ok(
      typeof archived.prunedAt === 'number' && archived.prunedAt >= before && archived.prunedAt <= after,
      'prunedAt is present and is the REAL retire ts (not a boot-prune ts)'
    )
    assert.equal(archived.entry.sessionId, 's1', 'the archived entry is the FULL durable entry')
    assert.equal(archived.entry.retired, true, 'the archived entry carries the retire mark')
    assert.equal(archived.entry.postId, undefined, 'the archived entry is the durable shape (postId stripped — the row key carries it, same as the boot-prune rows)')
    // The retire mark also persisted (the F1 mark is the durable part).
    const persisted = JSON.parse(await readFile(path.join(stateDir, 'posts.json'), 'utf8'))
    assert.equal(persisted['w1'].retired, true, 'posts.json carries the retire mark (the registry is the durable writer)')
    assert.equal(warns.length, 0, 'a successful append warns nothing')
  })
})

test('tramo 3A (O4): the GAP — a replacement WITHOUT a real retire appends NOTHING (re-register + unregister stay archive-silent); a re-retire is idempotent (never a second row)', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = new RegistryStore({ stateDir, logger: { warn() {}, info() {} } })
    store.registerEntry(workerEntry('w1', 's1'))
    await store.markPostRetired('w1')
    assert.equal((await archiveLines(stateDir)).length, 1, 'baseline: the w1 retire appended one row')
    // REPLACEMENT without a real retire: re-registering the SAME postId with a
    // NEW session (the worker-respawn / head-rotate replacement class) must
    // NOT append — the archive inventories REAL retires only.
    store.registerEntry(workerEntry('w2', 's2'))
    store.registerEntry({ ...workerEntry('w2', 's2-replaced') }) // replaced, never retired
    assert.equal((await archiveLines(stateDir)).length, 1, 'a REPLACED post (re-register, no retire) appends NO archive row')
    // A cosmetic unregister (no retire) also appends nothing.
    store.unregisterPost('w2')
    assert.equal((await archiveLines(stateDir)).length, 1, 'an unregistered post (no retire) appends NO archive row')
    // Idempotence: re-retiring an already-retired post never re-appends.
    await store.markPostRetired('w1')
    assert.equal((await archiveLines(stateDir)).length, 1, 'a re-retire is a no-op (idempotent — never a second row)')
  })
})

// ---------------------------------------------------------------------------
// (2) m-707 — the WATCHDOG NO-WAKE FILTER (a no-wake send must not count as a
//     wake in the watchdog / idle state).
// ---------------------------------------------------------------------------
test('tramo 3A (m-707): a noWake:true delivery marks BOTH sidecar rows `noWake` and the watchdog inbox reader EXCLUDES them — the recipient stays idle (pendingCount 0); an always-wake delivery of the same recipient STILL counts', async () => {
  await withTempStateDir(async (stateDir) => {
    // The delivery ENGINE over REAL sidecar marks (temp stateDir) — 0 real APIs.
    const engine = createDeliveryEngine({
      stateDir,
      logger: { info() {}, warn() {} },
      markPrepared: (record, recipientId, opts) => markDelivery(stateDir, record.id, recipientId, 'prepared', undefined, opts?.noWake),
      markFinal: (record, recipientId, status, opts) => markDelivery(stateDir, record.id, recipientId, status, undefined, opts?.noWake),
      resolveChild: async () => false,
      deliverChild: async () => 'delivered',
      resolveCatalogRoute: (id) => ({ kind: 'post', entry: { postId: id, sessionId: 's-' + id, roomId: 'board', agentPreset: 'deepartments-worker', provider: 'worker', departmentId: 'ipd', managerId: 'ipd-head' } }),
      // A HOST sender clears the defensive ACL gate (host → everyone).
      busProfileFor: () => ({ kind: 'host', memberId: 'the-host' }),
      deliverPost: async () => 'delivered',
      deliverHost: async () => 'delivered'
    })
    const msg = (id, seq) => ({ id, seq, ts: T0, from: 'ipd-head', to: ['rx'], text: 'qd probe', kind: 'agent' })
    // (a) a WIRED no-wake delivery (send_message noWake:true): the record is
    // persisted but the recipient is NOT materialized/woken.
    const status = await engine.deliverOrQueue('rx', msg('m-10', 10), { noWake: true })
    assert.equal(status, 'prepared', 'the WIRED noWake branch queues without materializing/waking')
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    assert.equal(rows.length, 2, 'the delivery wrote the write-ahead + the final row')
    assert.ok(rows.every((r) => r.noWake === true), 'BOTH sidecar rows of a no-wake delivery carry the noWake marker (the write-ahead AND the final)')
    // ... and the watchdog INBOX reader excludes them: the recipient has NO
    // addressed/wake traffic from the send.
    const msgTs = new Map([['m-10', T0]])
    const inbox = computeInboxTsByPost(msgTs, rows, T0, 3_600_000)
    assert.equal(inbox.has('rx'), false, 'the no-wake inbox input is EMPTY — the send is not addressed/wake traffic for the watchdog')
    assert.equal(buildPostSnapshot({ postId: 'rx', inboxTs: inbox.get('rx') ?? [] }).pendingCount, 0, 'buildPostSnapshot sees 0 pending — the recipient stays idle (m-707: the watchdog never flips "active" for no-wakes)')
    // (b) an ALWAYS-WAKE delivery of the SAME recipient still counts (the
    // default path is untouched — only the opt-in noWake rows are filtered).
    const status2 = await engine.deliverOrQueue('rx', msg('m-11', 11))
    assert.equal(status2, 'delivered', 'the default always-wake path delivers normally')
    const rows2 = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    assert.ok(rows2.some((r) => r.messageId === 'm-11' && r.noWake !== true), 'the always-wake delivery rows carry NO noWake marker')
    const msgTs2 = new Map([['m-10', T0], ['m-11', T0]])
    const inbox2 = computeInboxTsByPost(msgTs2, rows2, T0, 3_600_000)
    assert.ok(Array.isArray(inbox2.get('rx')) && inbox2.get('rx').includes(T0), 'the always-wake delivery IS watchdog inbox traffic — ONLY no-wake sends are filtered')
  })
})

// ---------------------------------------------------------------------------
// (3) fb-117 (fix candidate 2) — the SWEEP re-drive ORDERED BY SEQ.
// ---------------------------------------------------------------------------
test('tramo 3A (fb-117 candidate 2): sweepDue drives the DUE batch in (recipientId, seq) order — the re-drives of ONE recipient enter in seq order despite the out-of-seq FILE order; the pairDue criterion is unchanged', async () => {
  await withTempStateDir(async (stateDir) => {
    const records = [
      { id: 'm-5', seq: 5, ts: T0 - 60_000, from: 'ipd', to: ['a'], text: 'r5', kind: 'agent' },
      { id: 'm-3', seq: 3, ts: T0 - 60_000, from: 'ipd', to: ['a'], text: 'r3', kind: 'agent' },
      { id: 'm-4', seq: 4, ts: T0 - 60_000, from: 'ipd', to: ['b'], text: 'r4', kind: 'agent' },
      { id: 'm-2', seq: 2, ts: T0 - 60_000, from: 'ipd', to: ['b'], text: 'r2', kind: 'agent' }
    ]
    await writeFile(resolveMessagesPath(stateDir), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    // FILE order deliberately OUT of seq order (m-5 before m-3; m-4 before m-2).
    await writeFile(resolveDeliveriesPath(stateDir), `${[
      row('m-5', 'a', 'failed', T0 - 60_000),
      row('m-3', 'a', 'failed', T0 - 60_000),
      row('m-4', 'b', 'failed', T0 - 60_000),
      row('m-2', 'b', 'failed', T0 - 60_000)
    ].map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const calls = { deliver: [] }
    const recordsById = new Map(records.map((r) => [r.id, r]))
    const redeliverer = new DeliveryRedeliverer({
      stateDir,
      logger: { info() {}, warn() {} },
      recipientAlive: () => true,
      recipientDormant: () => false,
      getRecord: async (id) => recordsById.get(id),
      resolveCallerSessionId: (from) => from,
      deliver: async (record, recipientId) => {
        calls.deliver.push({ messageId: record.id, recipientId })
        // Mirror the delivery ENGINE's write-ahead side: the seam records the
        // final status row (deliverBusRecord → markFinal).
        await markDelivery(stateDir, record.id, recipientId, 'delivered')
        return 'delivered'
      }
    }, {
      baseDelayMs: 15_000,
      maxDelayMs: 600_000,
      maxAttempts: 12,
      stormWindowMs: 3600_000,
      preparedStuckMs: 600_000
    })
    // Every failed pair is DUE (1 prior attempt → the 15 s base backoff has
    // elapsed — the rows are 60 s old) — the sweep drives ALL FOUR.
    await redeliverer.sweepDue(T0)
    assert.deepEqual(calls.deliver, [
      { messageId: 'm-3', recipientId: 'a' },
      { messageId: 'm-5', recipientId: 'a' },
      { messageId: 'm-2', recipientId: 'b' },
      { messageId: 'm-4', recipientId: 'b' }
    ], 'the DUE batch is driven in (recipientId, seq) order — recipient-major, seq within a recipient — despite the out-of-seq FILE order (fb-117 candidate 2: the re-drives of ONE recipient enter in seq order)')
    for (const rec of records) {
      assert.equal(await deliveryStatus(stateDir, rec.id, rec.to[0]), 'delivered', `the driven pair ${rec.id} is settled 'delivered'`)
    }
  })
})