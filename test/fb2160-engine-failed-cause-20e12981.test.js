// dsh-deepartments — fb-2160 (§ACCEPTANCE 2, the ENGINE seam — 2026-09-21, run
// token 20e12981).
//
// WHAT THIS LOCKS: the delivery engine CLASSIFIES every failure
// (`BusDeliveryFailedGround`, fb-198/T1) and hands it ONLY to a caller-supplied
// observer. The RE-DRIVE / BOOT / SWEEP paths pass NO observer, so on the
// measured churn the classification died with the call and the ledger row stayed
// `{messageId, recipientId, status, ts}` ALONE — an instrument hiding its own
// cause. THE FIX (fb-2160): the engine captures the ground ITSELF and persists
// it as the 'failed' row's CAUSE COLUMN (`DeliveryRow.reason`), while the
// caller's observer keeps receiving exactly what it received before.
//
// This is the engine-level proof of the MEASURED ground of the four live pairs:
// their record's sender is `deepartments` (the synthetic daemon origin the
// quality-inspect emitter appends with — `dshd-orchestration/src/delivery.ts`
// `store.append({ from: 'deepartments', … })`), which the messaging ACL
// classifies `unclassified` (`acl.ts busProfileFor`) so `catalogRoute` returns
// 'failed' with ground `unclassified-sender`. MEASURED against the live catalog:
// `sender deepartments -> {"kind":"unclassified"}; aclDenyGround -> unclassified-sender`.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

const { createDeliveryEngine } = await import('../packages/dshd-core/src/delivery.ts')
const { busProfileFor, aclDenyGround } = await import('../packages/dshd-core/src/acl.ts')
const { markDelivery, parseDeliveryRows, resolveDeliveriesPath } = await import('../packages/dshd-core/src/messages.ts')

const T0 = 1_789_993_209_780 // the measured m-17488 attempt instant

function engineOver(stateDir, overrides = {}) {
  const marks = []
  const engine = createDeliveryEngine({
    stateDir,
    logger: { info() {}, warn() {} },
    markPrepared: (record, recipientId, opts) => markDelivery(stateDir, record.id, recipientId, 'prepared', undefined, opts?.noWake),
    markFinal: (record, recipientId, status, opts) => {
      marks.push({ id: record.id, status, opts })
      return markDelivery(stateDir, record.id, recipientId, status, undefined, opts?.noWake, opts?.reason)
    },
    resolveChild: async () => false,
    deliverChild: async () => 'delivered',
    resolveCatalogRoute: (id) => ({ kind: 'post', entry: { postId: id, sessionId: `session-${id}`, provider: 'head' } }),
    // The MEASURED classification: the record's sender is the daemon origin.
    busProfileFor: (memberId) => (memberId === 'deepartments' ? { kind: 'unclassified', memberId } : { kind: 'head', memberId }),
    deliverPost: async () => 'delivered',
    deliverHost: async () => 'delivered',
    ...overrides
  })
  return { engine, marks }
}

test('fb-2160 (§2): the ACL-refused re-drive records `reason: unclassified-sender` — the MEASURED ground of the four quality-head pairs is no longer lost, and the caller\'s observer still receives it unchanged', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb2160-engine-'))
  try {
    // The LIVE row shape: a write-ahead 'prepared' the re-drive just made (no
    // noWake flag — the re-drive seam does not forward the intent), then the
    // engine's own final mark.
    await markDelivery(stateDir, 'm-17488', 'quality-head', 'prepared', T0 - 100)
    const observed = []
    const { engine, marks } = engineOver(stateDir, { failedGround: undefined })
    const status = await engine.deliverOrQueue('quality-head', {
      id: 'm-17488',
      seq: 17_488,
      ts: T0,
      from: 'deepartments',
      to: ['quality-head'],
      text: 'Quality inspect: post-error … (capacity-gate verdict: SUSTAINED)',
      kind: 'agent'
    }, { callerAgentId: 'deepartments', failedGround: (g) => observed.push(g) })
    assert.equal(status, 'failed', 'the ACL-refused delivery resolves failed — the measured status')
    // THE TWO VOCABULARIES, stated: the ENGINE's ground token is `acl` (the
    // `BusDeliveryFailedGround` closed set), whose ACL-level detail — the reason
    // `aclDenyGround` returned, `unclassified-sender` for the daemon origin — is
    // what the same call site logs (asserted separately by the pure case below).
    assert.equal(marks.at(-1).opts?.reason, 'acl', 'THE FIX: the row\'s mark carries the engine\'s classified ground')
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    const failedRow = rows.filter((r) => r.status === 'failed').at(-1)
    assert.equal(failedRow.reason, 'acl', '…and it is PERSISTED in the row (the ledger stops hiding its own cause)')
    assert.equal(failedRow.noWake, undefined, 'the measured churn row carries no no-wake flag — exactly the shape that defeated the P2 guard')
    // R6: the caller's observer is untouched (the capture is additive).
    assert.deepEqual(observed, ['acl'], 'the caller\'s failedGround observer receives the ground EXACTLY as before')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('fb-2160 (§2, additive): a delivery that NEVER fails writes no cause — the pre-fb-2160 row shape is byte-identical', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb2160-engine-ok-'))
  try {
    const { engine, marks } = engineOver(stateDir)
    const status = await engine.deliverOrQueue('quality-head', { id: 'm-2', seq: 2, ts: T0, from: 'host-x', to: ['quality-head'], text: 'ok', kind: 'agent' })
    assert.equal(status, 'delivered')
    assert.equal(marks.at(-1).opts?.reason, undefined, 'no cause on a landed delivery')
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    assert.equal(rows.at(-1).reason, undefined, 'the delivered row is byte-identical to the pre-fb-2160 shape')
    assert.equal(JSON.stringify(rows.at(-1)), JSON.stringify({ messageId: 'm-2', recipientId: 'quality-head', status: 'delivered', ts: rows.at(-1).ts }), 'the serialized row has no extra key')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('fb-2160 (§2, the PURE predicate): the live catalog classifies the daemon origin `unclassified` — the ACL ground is computed, not assumed', () => {
  const posts = new Map()
  const lens = { byPost: posts, hosts: { has: () => false }, departmentForPost: () => undefined }
  const sender = busProfileFor('deepartments', lens)
  const recipient = busProfileFor('quality-head', lens)
  // `busProfileFor` resolves the sender with no catalog entry (the daemon origin
  // is never a registered post) ⇒ `unclassified`; `aclDenyGround` then refuses it
  // for EVERY recipient — the conservative branch.
  assert.equal(sender.kind, 'unclassified', 'the daemon origin classifies unclassified')
  assert.equal(recipient.kind, 'unclassified', 'an unregistered recipient is likewise unclassified (the predicate is total)')
  assert.equal(aclDenyGround({ kind: 'unclassified', memberId: 'deepartments' }, { kind: 'head', memberId: 'quality-head' }), 'unclassified-sender', 'the ground the engine persists for the measured class')
})
