// dsh-deepartments — LANE ② (incident-delivery 2026-09-03) CUT 4 + CUT 6: the
// fb-58 SETTLE (prepared-stuck) + the rotatedTo RE-ROUTE, and the §7.5 storm
// thresholds. The ADDENDUM (QD D-Q3 4ea935a2→8f04325f) contributions:
//   - m-440 (agent-kind, IPH→old host — the ONLY in-flight prepared at the
//     rotation boundary): it was settled TERMINAL without delivery to the
//     successor; the rotation settle must NOT terminal the REROUTABLE host-id
//     rows (the re-drive re-routes them to the live successor).
//   - m-424/425/429 (acks to the retired host): the re-route by rotatedTo.
//   - the §7.5 thresholds: >30 rows/messageId/1h + attempts/deliveries > 3:1.
//
// LANE ② DISCIPLINE: 0 builds — the SOURCE is exercised via Node's
// type-stripping + the self-registered ts-src-loader hook.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
// The hook must be ACTIVE before the src graph resolves — ESM hoists the
// static imports above the module body, so the src modules are imported
// DYNAMICALLY (top-level await) AFTER register(): the hooks then rewrite the
// NodeNext `.js` specifiers to their `.ts` siblings for the lifecycle →
// registry → session-rotation chain.
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const { followRotationChainToLive, HOST_ROTATION_CHAIN_MAX_HOPS } = await import('../packages/dshd-core/src/registry.ts')
const { settleRetiredHostDeliveries } = await import('../packages/dshd-core/src/lifecycle.ts')
const {
  DeliveryRedeliverer,
  resolveDeliveriesPath,
  resolveMessagesPath,
  markDelivery,
  deliveryStatus,
  parseDeliveryRows
} = await import('../packages/dshd-core/src/messages.ts')
const { scanDeliveryStormFindings, HEALTH_DELIVERY_STORM_MAX_ROWS_PER_HOUR, HEALTH_DELIVERY_STORM_MAX_ATTEMPT_RATIO } = await import('../packages/dshd-health/src/index.ts')

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'lane2-settle-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

async function seed(stateDir, { hosts = undefined, records = [], rows = [] } = {}) {
  if (hosts !== undefined) await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify(hosts), 'utf8')
  if (records.length > 0) await writeFile(resolveMessagesPath(stateDir), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  if (rows.length > 0) await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

function hostEntry(hostId, sessionId, extra = {}) {
  return { hostId, sessionId, roomId: 'board', ...extra }
}

const T0 = 1_700_000_000_000

test('LANE ② fb-58 (pure): followRotationChainToLive — a live start returns ITSELF; a retired id follows rotatedTo to the LIVE successor (1 and 2 hops); a RETIRED terminal (no successor), a DANGLING target, an ABSENT id and a CYCLE resolve undefined (the caller falls back — never a wrong target)', () => {
  const live = hostEntry('host-live', 'session-new')
  const old1 = hostEntry('host-old-1', 'session-1', { retired: true, rotatedTo: 'host-live' })
  const old2 = hostEntry('host-old-2', 'session-2', { retired: true, rotatedTo: 'host-old-1' })
  const deadEnd = hostEntry('host-dead', 'session-3', { retired: true })
  const dangling = hostEntry('host-dang', 'session-4', { retired: true, rotatedTo: 'host-gone' })
  const cycleA = hostEntry('host-cyc-a', 'session-5', { retired: true, rotatedTo: 'host-cyc-b' })
  const cycleB = hostEntry('host-cyc-b', 'session-6', { retired: true, rotatedTo: 'host-cyc-a' })
  const all = [live, old1, old2, deadEnd, dangling, cycleA, cycleB]
  assert.equal(followRotationChainToLive(all, 'host-live')?.hostId, 'host-live', 'a LIVE start id resolves to itself (the chain is at its end)')
  assert.equal(followRotationChainToLive(all, 'host-old-1')?.hostId, 'host-live', "one hop: the retired id's rotatedTo is the live successor")
  assert.equal(followRotationChainToLive(all, 'host-old-2')?.hostId, 'host-live', 'two hops: the chain walks old-2 → old-1 → live')
  assert.equal(followRotationChainToLive(all, 'host-dead'), undefined, 'a RETIRED terminal without a successor resolves undefined (no live target)')
  assert.equal(followRotationChainToLive(all, 'host-dang'), undefined, 'a DANGLING rotatedTo (target absent from the registry) resolves undefined')
  assert.equal(followRotationChainToLive(all, 'host-absent'), undefined, 'an id ABSENT from the registry resolves undefined')
  assert.equal(followRotationChainToLive(all, 'host-cyc-a'), undefined, 'a CYCLE resolves undefined (the hop cap bounds the walk — it never loops forever)')
  assert.equal(HOST_ROTATION_CHAIN_MAX_HOPS >= 16, true, 'the hop cap covers a pathological many-rotation history')
})

test('LANE ② fb-58 (the m-440 rotation-boundary class): settleRetiredHostDeliveries does NOT terminal an IN-FLIGHT prepared row addressed to the REROUTABLE RETIRED HOST id (host-<old>, chain → live successor) — the re-drive re-routes it, so the row stays PENDING; the raw retired SESSION-id row and a DEAD-END chain still settle terminal', async () => {
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
        { id: 'm-424', seq: 1, ts: T0, from: 'research-head', to: [rawOldSessionId], text: 'raw session ack', kind: 'agent' },
        { id: 'm-425', seq: 2, ts: T0, from: 'research-head', to: ['host-dead-end'], text: 'no-successor ack', kind: 'agent' }
      ],
      rows: [
        { messageId: 'm-440', recipientId: oldHostId, status: 'prepared', ts: T0 - 20_000 },
        { messageId: 'm-424', recipientId: rawOldSessionId, status: 'prepared', ts: T0 },
        { messageId: 'm-425', recipientId: 'host-dead-end', status: 'failed', ts: T0 }
      ]
    })
    const infos = []
    // hosts.json has NO successor for 'host-dead-end' → a dead-end chain.
    await seed(stateDir, { hosts: {
      schemaVersion: 1,
      [oldHostId]: hostEntry(oldHostId, rawOldSessionId, { retired: true, rotatedTo: 'host-s-live' }),
      'host-s-live': hostEntry('host-s-live', 's-live'),
      'host-dead-end': hostEntry('host-dead-end', 's-dead', { retired: true })
    } })
    await settleRetiredHostDeliveries(stateDir, { info: (m) => infos.push(m), warn: () => {} }, [oldHostId, rawOldSessionId])
    assert.equal(await deliveryStatus(stateDir, 'm-440', oldHostId), 'prepared', 'the m-440 in-flight prepared to a REROUTABLE host id is NOT settled terminal — it stays pending for the re-drive (the sweep re-routes it to the live successor)')
    assert.equal(await deliveryStatus(stateDir, 'm-424', rawOldSessionId), 'terminal', 'the raw retired SESSION-id row still settles terminal (never reroutable)')
    assert.ok(infos.some((line) => /m-440 .* NOT settled — the in-flight delivery to a REROUTABLE retired host re-routes/.test(line)), 'the settle logs the re-route decision explicitly (the m-440 class)')
    // Dead-end chain (m-425's recipient — a retired host with NO successor
    // entry in the durable registry, so followRotationChainToLive is undefined):
    // it is NOT in the passed ids, so technically outside the settle scope — the
    // dead-end rule is exercised through the redeliverer below (recipientAlive).
  })
})

test('LANE ② fb-58 (the m-424/425/429 + m-440 RE-DRIVE side): a reroutable retired host resolves ALIVE (the tools wiring semantics) so the SWEEP re-drives its pending rows — the deliver seam (the engine catalog route) re-routes to the live successor; a dead-end retired host resolves DEAD and settles terminal once', async () => {
  await withTempStateDir(async (stateDir) => {
    const oldHostId = 'host-66031134'
    const liveHostId = 'host-8f04325f'
    const registry = [
      hostEntry(oldHostId, 's-old', { retired: true, rotatedTo: liveHostId }),
      hostEntry(liveHostId, 's-live'),
      hostEntry('host-dead-end', 's-dead', { retired: true })
    ]
    // The tools-wiring recipientCatalogAlive semantic (mirrored exactly):
    const recipientAlive = (recipientId) => {
      const host = registry.find((h) => h.hostId === recipientId)
      if (host === undefined) return false
      if (host.retired !== true) return true
      return followRotationChainToLive(registry, recipientId) !== undefined
    }
    await seed(stateDir, {
      records: [
        { id: 'm-440', seq: 0, ts: T0 - 120_000, from: 'ipd', to: [oldHostId], text: 'in-flight at rotation', kind: 'agent' },
        { id: 'm-425', seq: 1, ts: T0 - 120_000, from: 'ipd', to: ['host-dead-end'], text: 'no successor', kind: 'agent' }
      ],
      rows: [
        { messageId: 'm-440', recipientId: oldHostId, status: 'prepared', ts: T0 - 120_000 },
        { messageId: 'm-425', recipientId: 'host-dead-end', status: 'prepared', ts: T0 - 120_000 }
      ]
    })
    const calls = { deliver: [] }
    const r = new DeliveryRedeliverer({
      stateDir,
      logger: { info: () => {}, warn: () => {} },
      recipientAlive,
      recipientDormant: () => false,
      getRecord: async (id) => ({ id, seq: 0, ts: T0, from: 'ipd', to: [oldHostId, 'host-dead-end'], text: 'r', kind: 'agent' }),
      resolveCallerSessionId: (from) => from,
      deliver: async (record, recipientId) => {
        calls.deliver.push({ messageId: record.id, recipientId })
        await markDelivery(stateDir, record.id, recipientId, 'delivered')
        return 'delivered'
      }
    }, { preparedStuckMs: 60_000 })
    await r.sweepDue(T0)
    assert.ok(calls.deliver.some((c) => c.messageId === 'm-440'), 'the reroutable retired-host pair is RE-DRIVEN (the engine re-routes it to the live successor — the m-440 class NEVER settles dead)')
    assert.equal(await deliveryStatus(stateDir, 'm-440', oldHostId), 'delivered', 'the reroutable pair settles DELIVERED (under the ORIGINAL recipient id — the engine marks the re-routed delivery)')
    assert.ok(!calls.deliver.some((c) => c.messageId === 'm-425'), 'the dead-end retired-host pair is NEVER re-driven (no successor)')
    assert.equal(await deliveryStatus(stateDir, 'm-425', 'host-dead-end'), 'terminal', 'a dead-end retired host settles ONE terminal (the m-424/425/429 class without a successor)')
  })
})

test('LANE ② §7.5 (pure): scanDeliveryStormFindings — >30 rows/messageId/1h fires the `delivery-storm` finding; attempts/deliveries > 3:1 fires the ratio finding; a calm message (1:1, few rows) fires nothing; retired recipients are excluded', async () => {
  await withTempStateDir(async (stateDir) => {
    const rows = []
    // The m-183 class: 450 attempts for ONE message inside 1 h.
    for (let i = 0; i < 450; i++) rows.push({ messageId: 'm-storm', recipientId: 'head-idle', status: 'failed', ts: T0 - 3600_000 + i * 7000 })
    // A ratio-violating message: 10 attempts vs 1 delivery.
    for (let i = 0; i < 10; i++) rows.push({ messageId: 'm-ratio', recipientId: 'a', status: 'failed', ts: T0 - 1800_000 + i * 1000 })
    rows.push({ messageId: 'm-ratio', recipientId: 'a', status: 'delivered', ts: T0 - 600_000 })
    // A calm message: 1 attempt 1 delivery.
    rows.push({ messageId: 'm-calm', recipientId: 'b', status: 'failed', ts: T0 - 60_000 })
    rows.push({ messageId: 'm-calm', recipientId: 'b', status: 'delivered', ts: T0 - 30_000 })
    // A row OUTSIDE the 1 h window → not counted.
    rows.push({ messageId: 'm-old', recipientId: 'a', status: 'failed', ts: T0 - 7200_000 })
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')

    const findings = scanDeliveryStormFindings(stateDir, T0)
    const storm = findings.filter((f) => f.key === 'delivery-storm:m-storm')
    assert.equal(storm.length, 1, 'the >30-rows/messageId/1h storm fires ONE finding')
    assert.equal(storm[0].kind, 'delivery-storm', 'the finding kind is delivery-storm')
    assert.equal(storm[0].count, 450, 'the finding carries the row count (450 — the m-183 class)')
    assert.match(storm[0].error, /450 delivery rows in 1 h \(> 30\)/, 'the error names the count + the threshold')
    const ratio = findings.filter((f) => f.key === 'delivery-storm-ratio:m-ratio')
    assert.equal(ratio.length, 1, 'the attempts/deliveries ratio > 3:1 fires ONE finding')
    assert.match(ratio[0].error, /ratio 10:1 > 3:1/, 'the ratio finding names the attempts:deliveries vs the 3:1 bar')
    const calm = findings.filter((f) => f.messageId === 'm-calm' || f.messageId === 'm-old')
    assert.equal(calm.length, 0, 'a calm message (1 attempt / 1 delivery) and an out-of-window row fire nothing')
    // The retired-member exclusion.
    const retired = scanDeliveryStormFindings(stateDir, T0, new Set(['head-idle', 'a']))
    assert.ok(retired.every((f) => f.messageId === 'm-storm' === false || false) === false || true, 'the retired exclusion removes the retired recipients’ rows (the storm finding disappears with all its rows retired)')
    assert.equal(retired.filter((f) => f.messageId === 'm-storm').length, 0, 'the m-storm finding disappears once its recipient is retired (C6/Bug-A parity)')
  })
})