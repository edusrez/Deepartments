// dsh-deepartments — LANE ②-bis (G2 — the LEGACY 'prepared' residue; host
// decision 2026-09-03: NO manual drain — the runtime settle covers the batch).
// CUTS: (1) TERMINAL NO-WAKE settle of the legacy/dead-end 'prepared' rows
// (never materialize/wake the recipient, never deliver, no grace/backoff);
// (2) the MISSION-QUEUE DRAIN SEED: a bounded per-cycle drain (N rows/cycle —
// G2_DRAIN_SEED_DEFAULT_LIMIT = 250) so 843+ legacy rows settle in bounded
// time without a storm, respecting the backoff/max-attempts machinery and the
// §7.5 thresholds; (3) OBSERVABILITY: the settle counters (legacy settled vs
// re-driven + the prepared-stuck residue) for the QD closure criterion "0
// prepared-stuck > 10 min". Convivencia con m-440: a 'prepared' row in flight
// to a REROUTABLE retired host is NEVER terminal (the re-drive re-routes it).
//
// LANE ② DISCIPLINE: 0 builds — the tests exercise the SOURCE via Node's
// type-stripping + the self-registered ts-src-loader hook; 0 real APIs (the
// only fs is a temp stateDir; the delivery seam is an injected stub).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  DeliveryRedeliverer,
  classifyG2LegacyRows,
  G2_DRAIN_SEED_DEFAULT_LIMIT,
  resolveDeliveriesPath,
  resolveMessagesPath,
  parseDeliveryRows
} from '../packages/dshd-core/src/messages.ts'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'lane2bis-g2-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

function row(messageId, recipientId, status, ts) {
  return { messageId, recipientId, status, ts }
}

async function seed(stateDir, { records = [], rows = [] } = {}) {
  if (records.length > 0) await writeFile(resolveMessagesPath(stateDir), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  if (rows.length > 0) await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

async function readRows(stateDir) {
  const text = await readFile(resolveDeliveriesPath(stateDir), 'utf8')
  return parseDeliveryRows(text)
}

/** A thin redeliverer over a temp stateDir with injected stubs; `alive` maps
 * recipientId → boolean (the recipientCatalogAlive semantic); the deliver
 * seam counts EVERY call (the "0 materializations / 0 wakes" probe). */
function redeliverer(stateDir, { alive = () => true, dormant = () => false, recordsById } = {}) {
  const calls = { deliver: [], warns: [], infos: [] }
  const records = recordsById ?? new Map()
  const deps = {
    stateDir,
    logger: { info: (m) => calls.infos.push(m), warn: (m) => calls.warns.push(m) },
    recipientAlive: alive,
    recipientDormant: dormant,
    getRecord: async (id) => records.get(id),
    resolveCallerSessionId: (from) => from,
    deliver: async (record, recipientId) => {
      calls.deliver.push({ messageId: record.id, recipientId })
      // Mirror the delivery ENGINE's write-ahead side: the seam records the
      // final status row — a real delivery WOULD wake/materialize the target;
      // here the call count IS the wake probe (must stay 0 for the no-wake
      // settle).
      await appendFile(resolveDeliveriesPath(stateDir), `${JSON.stringify({ messageId: record.id, recipientId, status: 'delivered', ts: Date.now() })}\n`, 'utf8')
      return 'delivered'
    }
  }
  const r = new DeliveryRedeliverer(deps, {
    baseDelayMs: 15_000,
    maxDelayMs: 600_000,
    maxAttempts: 12,
    stormWindowMs: 3600_000,
    preparedStuckMs: 600_000
  })
  r.__calls = calls
  r.__records = (id, record) => records.set(id, record)
  r.__alive = alive
  return r
}

const HOUR = 3600_000
// nowMs is fixed so tests are deterministic (T = a hypothetical settle time).
const T = 2_000_000_000_000

test('LANE ②-bis (pure): classifyG2LegacyRows — stale-dust (shadowed by a final row) and dead-end (shadowed rows of a dead pair) settle; the pair-latest (m-440 in-flight incl. reroutable) and fresh rows are kept', () => {
  const rows = [
    row('m-stale', 'alive', 'prepared', T - 2 * HOUR), // dust: shadowed by delivered
    row('m-stale', 'alive', 'delivered', T - 2 * HOUR + 1000),
    row('m-gone', 'dead', 'prepared', T - 3 * HOUR), // dead-end dust: shadowed by a later prepared
    row('m-gone', 'dead', 'prepared', T - 3 * HOUR + 1000), // pair-latest (drivePair settles it)
    row('m-440', 'retired-reroutable', 'prepared', T - HOUR), // in-flight to a REROUTABLE host — m-440
    row('m-flight', 'alive', 'prepared', T - HOUR), // in-flight to a live member (sweep re-drives)
    row('m-fresh', 'alive', 'prepared', T - 60_000), // fresh — live write-ahead
    row('m-ledger', 'alive', 'prepared', T - 2 * HOUR), // shadowed by a later prepared of an ALIVE pair
    row('m-ledger', 'alive', 'prepared', T - HOUR)
  ]
  const alive = (id) => id !== 'dead'
  const c = classifyG2LegacyRows(rows, T, 10 * 60_000, alive)
  assert.deepEqual(
    c.settleStaleDust.map((r) => r.messageId),
    ['m-stale'],
    'stale-dust = the prepared row shadowed by the pair’s final row (the 843-class: "prepared without delivered" at row level, delivery already resolved)'
  )
  assert.deepEqual(
    c.settleDeadEnd.map((r) => r.messageId),
    ['m-gone'],
    'dead-end = the shadowed prepared row of a pair whose recipient is dead (the pair-latest is drivePair’s domain)'
  )
  // 5 kept in-flight: the two pair-latests (m-440 + m-flight) + the pair-latest of m-gone (dead,
  // drivePair’s) + the shadowed row of the ALIVE retrying pair (m-ledger’s attempt ledger).
  assert.equal(c.keptInFlight, 5, 'in-flight kept: pair-latests (m-440 reroutable — NEVER terminal; m-flight; m-gone dead-latest) + the alive retrying pair’s shadowed ledger row')
  assert.equal(c.keptFresh, 1, 'fresh (< 10 min) kept — live write-ahead')
})

test('LANE ②-bis settle NO-WAKE: legacy stale-dust + dead-end → terminal IN PLACE; 0 deliver calls (0 materializations/0 wakes); in-flight (m-440 reroutable) rows untouched', async () => {
  await withTempStateDir(async (stateDir) => {
    const records = new Map([
      ['m-stale', { id: 'm-stale', from: 'from', to: ['alive'], text: 'x', kind: 'agent', ts: T - 2 * HOUR }],
      ['m-gone', { id: 'm-gone', from: 'from', to: ['dead'], text: 'x', kind: 'agent', ts: T - 3 * HOUR }],
      ['m-440', { id: 'm-440', from: 'from', to: ['retired-reroutable'], text: 'x', kind: 'agent', ts: T - HOUR }],
      ['m-flight', { id: 'm-flight', from: 'from', to: ['alive'], text: 'x', kind: 'agent', ts: T - HOUR }],
      ['m-fresh', { id: 'm-fresh', from: 'from', to: ['alive'], text: 'x', kind: 'agent', ts: T - 60_000 }]
    ])
    await seed(stateDir, { records: [...records.values()], rows: [
      row('m-stale', 'alive', 'prepared', T - 2 * HOUR),
      row('m-stale', 'alive', 'delivered', T - 2 * HOUR + 1000),
      row('m-gone', 'dead', 'prepared', T - 3 * HOUR),
      row('m-gone', 'dead', 'prepared', T - 3 * HOUR + 1000),
      row('m-440', 'retired-reroutable', 'prepared', T - HOUR),
      row('m-flight', 'alive', 'prepared', T - HOUR),
      row('m-fresh', 'alive', 'prepared', T - 60_000)
    ] })
    const r = redeliverer(stateDir, { alive: (id) => id !== 'dead', recordsById: records })
    const counts = await r.settleG2Batch(T, 250)
    assert.equal(counts.settled, 2, 'settled = 1 stale-dust + 1 dead-end dust')
    assert.equal(counts.settledStaleDust, 1)
    assert.equal(counts.settledDeadEnd, 1)
    assert.equal(counts.keptInFlight, 3, 'kept: m-440 (reroutable — m-440 NEVER terminal), m-flight (alive), m-gone pair-latest (dead — drivePair settles it)')
    assert.equal(counts.keptFresh, 1)
    assert.equal(counts.skippedRebind, 0)
    assert.equal(r.__calls.deliver.length, 0, 'NO-WAKE: the settle NEVER calls the delivery seam — 0 materializations, 0 wakes, 0 fresh notifications')
    const after = await readRows(stateDir)
    const byKey = new Map(after.map((x) => [`${x.messageId}|${x.recipientId}`, x]))
    const staleFlipped = after.filter((x) => x.messageId === 'm-stale' && x.status === 'terminal')
    assert.equal(staleFlipped.length, 1, 'the stale-dust row rewritten to terminal in place')
    assert.equal(staleFlipped[0].ts, T - 2 * HOUR, 'the rewrite preserves the ORIGINAL ts (the write-ahead record keeps its timestamp; the status resolves)')
    const staleDelivered = after.filter((x) => x.messageId === 'm-stale' && x.status === 'delivered')
    assert.equal(staleDelivered.length, 1, 'the DELIVERED evidence of the resolved pair is PRESERVED (the flip targets the exact dust row, never the pair’s final row)')
    const goneFlipped = after.filter((x) => x.messageId === 'm-gone' && x.status === 'terminal')
    assert.equal(goneFlipped.length, 1, 'the dead-end dust row rewritten to terminal')
    assert.equal(goneFlipped[0].ts, T - 3 * HOUR)
    assert.equal(byKey.get('m-440|retired-reroutable').status, 'prepared', 'm-440 in-flight to a REROUTABLE retired host: NOT terminal (the re-drive re-routes it)')
    assert.equal(byKey.get('m-flight|alive').status, 'prepared', 'in-flight to a live member: NOT terminal')
    assert.equal(byKey.get('m-fresh|alive').status, 'prepared', 'fresh row untouched')
    assert.equal(after.length, 7, 'the in-place rewrite keeps the row count (no appends, no drops)')
    // Idempotent: a second pass settles nothing.
    const second = await r.settleG2Batch(T, 250)
    assert.equal(second.settled, 0, 'idempotent — terminal rows are never candidates again')
  })
})

test('LANE ②-bis en-vuelo NO terminal (m-440 convivencia): a sweep re-drives the in-flight row to the reroutable host instead of settling it', async () => {
  await withTempStateDir(async (stateDir) => {
    const records = new Map([
      ['m-440', { id: 'm-440', from: 'from', to: ['retired-reroutable'], text: 'x', kind: 'agent', ts: T - HOUR }]
    ])
    await seed(stateDir, { records: [...records.values()], rows: [row('m-440', 'retired-reroutable', 'prepared', T - HOUR)] })
    const r = redeliverer(stateDir, { alive: (id) => id === 'retired-reroutable' || id === 'alive', recordsById: records }) // reroutable host = alive (lane-② catalog semantic)
    await r.sweepDue(T)
    assert.equal(r.__calls.deliver.length, 1, 'the in-flight prepared row is RE-DRIVEN (delivered to the reroutable host — the catalog route re-routes it), never settled terminal by G2')
    assert.deepEqual(r.__calls.deliver[0], { messageId: 'm-440', recipientId: 'retired-reroutable' })
    const after = await readRows(stateDir)
    const latest = after.filter((x) => x.messageId === 'm-440').at(-1)
    assert.equal(latest.status, 'delivered', 'the re-drive seam recorded the final status')
  })
})

test('LANE ②-bis DRAIN SEED bounded per cycle: N rows/cycle (default 250) → 600 legacy dust rows drain in exactly ⌈600/N⌉ cycles; the leftover stays prepared until its cycle', async () => {
  await withTempStateDir(async (stateDir) => {
    const N = 250
    const total = 600
    const records = new Map()
    const rows = []
    for (let i = 0; i < total; i++) {
      const id = `m-dust-${i}`
      records.set(id, { id, from: 'from', to: ['alive'], text: 'x', kind: 'agent', ts: T - 2 * HOUR })
      rows.push(row(id, 'alive', 'prepared', T - 2 * HOUR), row(id, 'alive', 'delivered', T - 2 * HOUR + 1000))
    }
    await seed(stateDir, { records: [...records.values()], rows })
    const r = redeliverer(stateDir, { recordsById: records })
    const first = await r.settleG2Batch(T, N)
    assert.equal(first.settled, N, `cycle 1 settles exactly the cap (${N} rows)`)
    assert.equal(first.settledStaleDust, N)
    let before = await readRows(stateDir)
    assert.equal(before.filter((x) => x.status === 'terminal').length, N, 'N terminal after cycle 1')
    assert.equal(before.filter((x) => x.status === 'prepared').length, total - N, 'the leftover dust stays prepared (drains in later cycles — bounded, no burst)')
    const second = await r.settleG2Batch(T, N)
    assert.equal(second.settled, N, 'cycle 2 settles the next N')
    const third = await r.settleG2Batch(T, N)
    assert.equal(third.settled, total - 2 * N, `cycle 3 settles the final ${total - 2 * N}`)
    const fourth = await r.settleG2Batch(T, N)
    assert.equal(fourth.settled, 0, 'cycle 4: nothing left')
    before = await readRows(stateDir)
    assert.equal(before.filter((x) => x.status === 'terminal').length, total, 'the whole 600-row backlog settled in ⌈600/250⌉ = 3 cycles, no manual drain')
    assert.equal(before.length, 2 * total, 'the in-place rewrite never grows/shrinks the ledger (row count stable)')
    assert.equal(G2_DRAIN_SEED_DEFAULT_LIMIT, 250, 'the documented default cap (843 rows → ~4 cycles ≈ 4 min at the 60 s sweep cadence)')
  })
})

test('LANE ②-bis convivencia con backoff: the sweep re-drives a DUE failed pair (backoff math intact) AND settles the legacy dust in the SAME cycle; the counters separate re-driven vs legacy-settled', async () => {
  await withTempStateDir(async (stateDir) => {
    const records = new Map([
      ['m-fail', { id: 'm-fail', from: 'from', to: ['alive'], text: 'x', kind: 'agent', ts: T - HOUR }],
      ['m-stale', { id: 'm-stale', from: 'from', to: ['alive'], text: 'x', kind: 'agent', ts: T - 2 * HOUR }]
    ])
    await seed(stateDir, { records: [...records.values()], rows: [
      row('m-fail', 'alive', 'failed', T - 60_000), // 1 prior attempt → due at ≥ 15 s (base); T is 60 s later → due
      row('m-stale', 'alive', 'prepared', T - 2 * HOUR),
      row('m-stale', 'alive', 'delivered', T - 2 * HOUR + 1000)
    ] })
    const r = redeliverer(stateDir, { recordsById: records })
    await r.sweepDue(T)
    assert.equal(r.__calls.deliver.length, 1, 'the DUE failed pair is re-driven (backoff respected: 1 attempt, ≥ base delay elapsed)')
    assert.deepEqual(r.__calls.deliver[0], { messageId: 'm-fail', recipientId: 'alive' }, 'the re-drive targets the failed pair — never the dust')
    const after = await readRows(stateDir)
    assert.equal(after.filter((x) => x.status === 'terminal' && x.messageId === 'm-stale').length, 1, 'the stale dust settled ' + 'to terminal in the same cycle')
    const sweepLog = r.__calls.infos.find((m) => m.includes('redelivery sweep cycle'))
    assert.ok(sweepLog, 'the sweep logs the cycle observability line')
    assert.match(sweepLog, /drove 1 pairs/, 'the re-driven half of the ledger')
    assert.match(sweepLog, /G2 legacy settle 1 \(1 stale-dust \+ 0 dead-end\)/, 'the legacy-settled half of the ledger (QD closure: legacy settled vs re-driven)')
    assert.match(sweepLog, /prepared-stuck>10min remaining \d+/, 'the prepared-stuck residue is reported (closure criterion)')
  })
})

test('LANE ②-bis observability + ALTO-1: skippedRebind counts candidates whose CURRENT record is trimmed/rebound (never settle the wrong pair); preparedStuckRemaining reports the closure residue', async () => {
  await withTempStateDir(async (stateDir) => {
    const records = new Map([
      ['m-stale', { id: 'm-stale', from: 'from', to: ['alive'], text: 'x', kind: 'agent', ts: T - 2 * HOUR }],
      // m-rebound has NO current record (trimmed) — the ALTO-1 skip class
      ['m-stuck', { id: 'm-stuck', from: 'from', to: ['alive'], text: 'x', kind: 'agent', ts: T - HOUR }]
    ])
    await seed(stateDir, { records: [...records.values()], rows: [
      row('m-stale', 'alive', 'prepared', T - 2 * HOUR),
      row('m-stale', 'alive', 'delivered', T - 2 * HOUR + 1000),
      row('m-rebound', 'alive', 'prepared', T - 2 * HOUR),
      row('m-rebound', 'alive', 'delivered', T - 2 * HOUR + 1000),
      row('m-stuck', 'alive', 'prepared', T - HOUR) // pair-latest prepared, old → the prepared-stuck residue (sweep re-drives it; G2 keeps it)
    ] })
    const r = redeliverer(stateDir, { recordsById: records })
    const counts = await r.settleG2Batch(T, 250)
    assert.equal(counts.skippedRebind, 1, 'the rebound/trimmed candidate is skipped (ALTO-1)')
    assert.equal(counts.settled, 1, 'only the record-verified dust settles')
    assert.equal(counts.preparedStuckRemaining, 1, 'the closure criterion: the in-flight old pair-latest remains (the sweep re-drives it — G2 never settles the pair-latest)')
    const after = await readRows(stateDir)
    const rebound = after.filter((x) => x.messageId === 'm-rebound')
    assert.ok(rebound.some((x) => x.status === 'prepared'), 'the skipped row keeps its prepared status (the wrong pair is never settled)')
    assert.ok(rebound.some((x) => x.status === 'delivered'), 'the skipped row keeps its delivered evidence')
  })
})

test('LANE ②-bis boot integration: run() settles the legacy dust after its re-drive pass (NO-WAKE) and leaves in-flight rows for the machinery', async () => {
  await withTempStateDir(async (stateDir) => {
    const NOW = Date.now() // run() uses real time (the boot pass contract) — seed in the past
    const records = new Map([
      ['m-gone', { id: 'm-gone', from: 'from', to: ['dead'], text: 'x', kind: 'agent', ts: NOW - 3 * HOUR }],
      ['m-stale', { id: 'm-stale', from: 'from', to: ['alive'], text: 'x', kind: 'agent', ts: NOW - 2 * HOUR }],
      ['m-flight', { id: 'm-flight', from: 'from', to: ['alive'], text: 'x', kind: 'agent', ts: NOW - HOUR }]
    ])
    await seed(stateDir, { records: [...records.values()], rows: [
      row('m-gone', 'dead', 'prepared', NOW - 3 * HOUR), // dead pair-latest: the boot pass settles terminal via drivePair
      row('m-stale', 'alive', 'prepared', NOW - 2 * HOUR), // dust: settles via the G2 boot drain
      row('m-stale', 'alive', 'delivered', NOW - 2 * HOUR + 1000),
      row('m-flight', 'alive', 'prepared', NOW - HOUR) // in-flight: the boot pass RE-DRIVES it (immediate semantics preserved)
    ] })
    const r = redeliverer(stateDir, { alive: (id) => id !== 'dead', recordsById: records })
    await r.run()
    assert.equal(r.__calls.deliver.length, 1, 'the boot pass re-drives ONLY the in-flight pair (the immediate boot semantics preserved); the dead pair + the dust get NO wake')
    assert.deepEqual(r.__calls.deliver[0], { messageId: 'm-flight', recipientId: 'alive' })
    const after = await readRows(stateDir)
    const status = new Map(after.map((x) => [`${x.messageId}|${x.recipientId}|${x.ts}`, x.status]))
    assert.equal([...after.filter((x) => x.messageId === 'm-gone')].at(-1).status, 'terminal', 'the boot pass settled the dead pair' + 's latest row terminal (drivePair)')
    assert.ok(after.some((x) => x.messageId === 'm-stale' && x.status === 'terminal'), 'the boot G2 drain settled the stale dust (no-wake)')
    assert.equal(after.filter((x) => x.messageId === 'm-stale' && x.status === 'prepared').length, 0, 'the dust prepared row is resolved — the 843-class settles at boot too, bounded')
    const bootLog = r.__calls.infos.find((m) => m.includes('boot G2 legacy settle'))
    assert.ok(bootLog, 'the boot drain logs the observability counts')
  })
})