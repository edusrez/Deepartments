// dsh-deepartments — fb-2160 / punto (4') (2026-09-21, run token 20e12981).
//
// THE TWO DELIVERABLES, both from the head's third/fourth/fifth briefs:
//
// (4'.1) EL INTERRUPT DE `delivery-failed` ACOTADO POR OBJETO — «un objeto muerto
//        NO puede armar N veces el mismo marcador». MEASURED groundwork: that
//        class is delivered with `interrupt: true` (the health seam's `notifyHost`
//        sends it on BOTH branches, no `kind` gate) AND its identity embedded the
//        ATTEMPT's ts, so one corpse re-armed a different interrupt per retry
//        (`fb-2149`'s class, flag ARMED). The identity is now the failure RUN;
//        this predicate is the bound, and BOTH DIRECTIONS are asserted here
//        (`fb-1478`: over-suppressing is as wrong as under-suppressing).
//
// (4'.2) EL GATILLO EN UN ARTEFACTO DURABLE — `interrupt-state.json` PRUNES (the
//        head's and the host's two independent observations: the head READ rows
//        that the host could no longer find, evicted by the head's own interrupt).
//        The `interrupt-detail:` entry is the ONLY place an abort is tied to its
//        trigger (`fb-2011`: literally ZERO `sourceKey` elsewhere), so the
//        attribution dies with the next interrupt. `interrupts.jsonl` is the
//        append-only history; this file proves it SURVIVES the pruning.
//
// METHOD (the repo's "src-native" pattern WITHOUT the resolution hook): the
// package `dshd-health/src/index.ts` has ZERO relative imports, so Node's native
// type-stripping loads it DIRECTLY.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const H = await import('../packages/dshd-health/src/index.ts')

const MIN = 60_000
const T0 = new Date(2026, 8, 21, 13, 9, 0).getTime()

test('fb-2160 (4\'.1) EL ACOTADO — el MISMO objeto arma el marcador UNA vez, y las DOS direcciones están medidas', () => {
  const corpse = { kind: 'delivery-failed', deliveryPairKey: 'delivery-failed:m-17488#quality-head#1789993209780' }
  // A1 — the SAME object identity: the second re-emission does NOT re-arm.
  assert.equal(H.shouldArmDeliveryInterrupt(corpse, undefined), true, 'the first observation arms the interrupt')
  assert.equal(
    H.shouldArmDeliveryInterrupt(corpse, new Set([corpse.deliveryPairKey])),
    false,
    'THE FIX: the same dead object cannot arm the same marker again (it could, once per attempt, before)'
  )
  // A2 — DIRECTION «not too little»: a NEW RUN of the same pair (the predecessor
  // DRAINED) mints a NEW key ⇒ the legitimate alert is NEVER swallowed.
  const newRun = { kind: 'delivery-failed', deliveryPairKey: 'delivery-failed:m-17488#quality-head#1789995999000' }
  assert.equal(
    H.shouldArmDeliveryInterrupt(newRun, new Set([corpse.deliveryPairKey])),
    true,
    'a NEW failure run of the same pair re-arms — a legitimate alert is never lost (fb-1478 direction)'
  )
  // A3 — DIRECTION «not too much»: another object (a different pair) always arms.
  const otherPair = { kind: 'delivery-failed', deliveryPairKey: 'delivery-failed:m-17466#quality-head#1789719051257' }
  assert.equal(H.shouldArmDeliveryInterrupt(otherPair, new Set([corpse.deliveryPairKey])), true, 'a different object has its own identity')
  // A4 — SCOPE: every OTHER finding class is untouched (so this bound can never
  // silence a class it was not aimed at), and a `delivery-failed` without a
  // stable identity is NEVER silently suppressed.
  const armed = new Set([corpse.deliveryPairKey])
  assert.equal(H.shouldArmDeliveryInterrupt({ kind: 'context-threshold', deliveryPairKey: corpse.deliveryPairKey }, armed), true, 'context-threshold is outside the bound')
  assert.equal(H.shouldArmDeliveryInterrupt({ kind: 'delivery-storm' }, armed), true, 'delivery-storm is outside the bound')
  assert.equal(H.shouldArmDeliveryInterrupt({ kind: 'delivery-failed' }, armed), true, 'no stable identity → arm (never suppress on a missing field)')
})

test('fb-2160 (4\'.2) EL GATILLO DURABLE — el artefacto append-only sobrevive al pruning que borró la entrada viva', async () => {
  await withTempStateDir(async (stateDir) => {
    // The MEASURED trigger: the alert key that armed the interrupt of the then
    // live host (verbatim from the live ledger).
    const sourceKey = 'delivery-failed:m-17488#quality-head#1789994631509'
    await H.appendInterruptTriggerRow(stateDir, { ts: T0, recipientId: 'host-session-b9b3c256', reason: 'interrupted', sourceKey })
    // (1) THE PRUNING THAT MOTIVATED THIS: the live ledger is rewritten by the
    // NEXT interrupt and its entries older than the 5-min cooldown are dropped —
    // simulate exactly that, then prove the durable row is still there.
    const livePath = path.join(stateDir, H.INTERRUPT_COOLDOWN_FILE)
    await (await import('node:fs/promises')).writeFile(livePath, JSON.stringify({ 'interrupt:someone-else': T0 + 4 * MIN }), 'utf8')
    const durable = (await readFile(path.join(stateDir, H.INTERRUPTS_LEDGER_FILE), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(durable.length, 1, 'the durable row survived the live ledger\'s rewrite')
    assert.equal(durable[0].sourceKey, sourceKey, 'THE ANSWER fb-2011 LACKED: «which trigger aborted seat X at T» is still readable')
    assert.equal(durable[0].recipientId, 'host-session-b9b3c256', 'the row names the aborted SEAT')
    assert.equal(durable[0].reason, 'interrupted', 'and the semantic reason on the wire')
    // (2) APPEND-ONLY: a second interrupt ADDS a row, never rewrites one.
    await H.appendInterruptTriggerRow(stateDir, { ts: T0 + MIN, recipientId: 'quality-head', reason: 'interrupted', sourceKey: 'context-threshold:quality-head:b7' })
    const after = (await readFile(path.join(stateDir, H.INTERRUPTS_LEDGER_FILE), 'utf8')).trim().split('\n')
    assert.equal(after.length, 2, 'the sink appends — the earlier attribution stays byte-identical evidence')
    assert.equal(JSON.parse(after[0]).sourceKey, sourceKey, 'the first row is untouched by the second append')
  })
})

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb2160-interrupts-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}
