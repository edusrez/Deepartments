// dsh-deepartments — m-2333 (owner 2026-09-06, «MÁXIMA MÁQUINA CON HALT»):
// the pool-governance protocol acceptance suite. The runtime runs at full
// machine BY DEFAULT (no pool-low warnings, no intermediate brakes, no
// spend-conscience gates); the ONLY total-pause condition (HALT) is:
// eligibleKeys == 1 AND (weekly available < 20 OR monthly available < 10),
// where «Disponible» = 100 − %consumido (usageWeekly.percent /
// usageMonthly.percent FROM THE POOLER STATEFILE — the seam DSH already
// reads; never the /__keypool/status `usage` block, lane A not deployed).
// Resume when ≥2 usable keys or new keys are added. Outside the HALT: CERO
// avisos de pool — the pooler-capacity alerts behave as info/no-bloqueo,
// NEVER as a gate.
//
// fb-95 (AGENTS.md): this is a BUILT-lib test (plain `node --test` over
// lib/invoke.js) — it does NOT self-register the ts-src-loader hook.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  resolvePoolerDispatchBlock,
  scanPoolerCapacity,
  POOLER_CAPACITY_KEY_CRITICAL
} from '../lib/invoke.js'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'pool-halt-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Write a pooler snapshot. `keys` maps keyId → PoolerKeyStateLike. O1: the
 * pool-wide durable records (`billingDown` fb-75 / `halted` P4) are written
 * ONLY when given — an explicit `null` writes null (the healthy pooler shape),
 * `undefined` leaves the field absent (the legacy shape). */
async function writeSnapshot(stateDir, name, { nowMs, keys, updatedAtOffsetMs = 60_000, lastRotation = null, billingDown, halted }) {
  const p = path.join(stateDir, `${name}.json`)
  const snapshot = {
    updatedAt: new Date(nowMs - updatedAtOffsetMs).toISOString(),
    keys,
    lastRotation
  }
  if (billingDown !== undefined) snapshot.billingDown = billingDown
  if (halted !== undefined) snapshot.halted = halted
  await writeFile(p, JSON.stringify(snapshot), 'utf8')
  return p
}

/** The m-2333 device-context key shapes (no literals of secret values; only
 * the state numbers the pooler exposes — the audit's oc-6/oc-13/oc-14 shape). */
const HALF_KEYS = {
  'oc-13': { id: 'oc-13', workspace: 'ws13', invalid: false, blockedUntil: 1_789_000_000_000, cooldownUntil: 0, usageWeekly: { status: 'rate-limited', percent: 100, resetsAt: new Date(1_789_000_000_000).toISOString() }, usageMonthly: { status: 'ok', percent: 50, resetsAt: new Date(1_790_000_000_000).toISOString() } },
  'oc-14': { id: 'oc-14', workspace: 'ws14', invalid: false, blockedUntil: 1_789_000_000_000, cooldownUntil: 0, usageWeekly: { status: 'rate-limited', percent: 100, resetsAt: new Date(1_789_000_000_000).toISOString() }, usageMonthly: { status: 'ok', percent: 50, resetsAt: new Date(1_790_000_000_000).toISOString() } }
}
const oc6 = (weeklyPct, monthlyPct) => ({ id: 'oc-6', workspace: 'ws6', invalid: false, blockedUntil: 0, cooldownUntil: 0, usageWeekly: { status: 'ok', percent: weeklyPct, resetsAt: new Date(1_789_000_000_000).toISOString() }, usageMonthly: { status: 'ok', percent: monthlyPct, resetsAt: new Date(1_790_000_000_000).toISOString() }, lastError: null, lastCheckedAt: 0 })

test('m-2333 (a) — the oc-6 ACTUAL state (2026-09-06 15:05Z): 1 usable key oc-6 with usageWeekly 0% consumed (→ 100% available) and usageMonthly 50% (→ 50% available), oc-13/oc-14 blocked until the 09-07 00:00Z reset → NO HALT: the scan emits NO finding and the dispatch pre-check passes (the runtime runs at FULL MACHINE)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_788_000_000_000
    const knobs = { stateStaleMs: 600000, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 }
    const scanKnobs = { ...knobs, warningUsableKeys: 1, okUsableKeys: 2, blockedKeysInWindow: 3, criticalGlobalRemainingPercent: 20, criticalWeeklyRemainingPercent: 10 }
    const p = await writeSnapshot(stateDir, 'live', { nowMs: T0, keys: { 'oc-6': oc6(0, 50), ...HALF_KEYS }, lastRotation: { from: 'oc-14', to: 'oc-6', reason: '429 usage-limit', at: new Date(T0 - 60_000).toISOString(), resetsAt: new Date(1_789_000_000_000).toISOString(), message: 'key rotada oc-14 → oc-6 por error 429 (usage limit)' } })
    assert.deepEqual(scanPoolerCapacity(p, T0, scanKnobs), [], 'oc-6 actual: 100% weekly available / 50% monthly available → NO finding (NO HALT; cero avisos outside the pause state)')
    assert.equal(resolvePoolerDispatchBlock(p, T0, knobs), undefined, 'oc-6 actual: the dispatch pre-check passes (runs at full machine — the degraded weekly 0% reads 100% available)')
  })
})

test('m-2333 (b) — the HALT boundary: 1 usable key with monthly available < 10% → HALT (dispatch blocked + critical finding); 1 usable key with weekly available < 20% → HALT', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_788_000_000_000
    const knobs = { stateStaleMs: 600000, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 }
    const scanKnobs = { ...knobs, warningUsableKeys: 1, okUsableKeys: 2, blockedKeysInWindow: 3, criticalGlobalRemainingPercent: 20, criticalWeeklyRemainingPercent: 10 }
    // (b1) monthly: oc-6 at 95% monthly consumed → 5% monthly available < 10%.
    const monthlyLow = await writeSnapshot(stateDir, 'monthly', { nowMs: T0, keys: { 'oc-6': oc6(10, 95), ...HALF_KEYS } })
    const mBlock = resolvePoolerDispatchBlock(monthlyLow, T0, knobs)
    assert.notEqual(mBlock, undefined, '1 usable with monthly available < 10% → dispatch BLOCKED (HALT)')
    assert.match(mBlock.reason, /^pool: HALT — 1 usable key oc-6 \(weekly available 90% < 20% or monthly available 5% < 10%\) — NO new dispatches until ≥2 usable keys or new keys are added$/, 'the monthly-leg HALT reason names the key + the 5% monthly available + the threshold')
    const mScan = scanPoolerCapacity(monthlyLow, T0, scanKnobs)
    assert.equal(mScan.length, 1, '1 finding')
    assert.equal(mScan[0].key, POOLER_CAPACITY_KEY_CRITICAL, 'the monthly-leg HALT grades critical (the capacity gate pauses new dispatches)')
    assert.match(mScan[0].error, /monthly available 5% \(< 10%\)/, 'the critical finding names the monthly leg')
    // (b2) weekly: oc-6 at 85% weekly consumed → 15% weekly available < 20%.
    const weeklyLow = await writeSnapshot(stateDir, 'weekly', { nowMs: T0, keys: { 'oc-6': oc6(85, 20), ...HALF_KEYS } })
    const wBlock = resolvePoolerDispatchBlock(weeklyLow, T0, knobs)
    assert.notEqual(wBlock, undefined, '1 usable with weekly available < 20% → dispatch BLOCKED (HALT)')
    assert.match(wBlock.reason, /^pool: HALT — 1 usable key oc-6 \(weekly available 15% < 20% or monthly available 80% < 10%\) — NO new dispatches until ≥2 usable keys or new keys are added$/, 'the weekly-leg HALT reason names the key + the 15% weekly available + the threshold')
    const wScan = scanPoolerCapacity(weeklyLow, T0, scanKnobs)
    assert.equal(wScan.length, 1, '1 finding')
    assert.equal(wScan[0].key, POOLER_CAPACITY_KEY_CRITICAL, 'the weekly-leg HALT grades critical')
    assert.match(wScan[0].error, /weekly available 15% \(< 20%\)/, 'the critical finding names the weekly leg')
  })
})

test('m-2333 (c) — RESUMPTION: from a HALT state (1 usable oc-6 low), the pool recovers to ≥2 usable keys (oc-13 auto-releases at its 09-07 00:00Z blockedUntil reset / the owner adds a key) → the HALT clears: scan emits NO finding and the dispatch pre-check passes again', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_788_000_000_000
    const knobs = { stateStaleMs: 600000, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 }
    const scanKnobs = { ...knobs, warningUsableKeys: 1, okUsableKeys: 2, blockedKeysInWindow: 3, criticalGlobalRemainingPercent: 20, criticalWeeklyRemainingPercent: 10 }
    // HALT first: 1 usable oc-6 with monthly 95% consumed → 5% available.
    const keys = { 'oc-6': oc6(10, 95), 'oc-13': { ...HALF_KEYS['oc-13'], blockedUntil: 1_789_000_000_000 }, 'oc-14': { ...HALF_KEYS['oc-14'], blockedUntil: 1_789_000_000_000 } }
    const p = await writeSnapshot(stateDir, 'halt', { nowMs: T0, keys })
    assert.notEqual(resolvePoolerDispatchBlock(p, T0, knobs), undefined, 'before the reset: HALT blocks the dispatch')
    // oc-13 auto-releases (its blockedUntil passes — e.g. the 09-07T00:00Z
    // reset): 2 usable → the HALT clears (≥2 usable keys).
    keys['oc-13'] = { ...HALF_KEYS['oc-13'], blockedUntil: 0 }
    await writeFile(p, JSON.stringify({ updatedAt: new Date(T0 - 60_000).toISOString(), keys, lastRotation: null }), 'utf8')
    assert.equal(resolvePoolerDispatchBlock(p, T0, knobs), undefined, 'oc-13 auto-release → 2 usable → dispatch passes again (the HALT clears on ≥2 usable)')
    assert.deepEqual(scanPoolerCapacity(p, T0, scanKnobs), [], '2 usable → NO finding (resume; cero avisos)')
    // The owner ADDS a key (a fresh oc-20 appears): from the 1-usable HALT
    // state, the added key makes 2 usable → the HALT clears.
    const keys2 = { 'oc-6': oc6(10, 95), 'oc-13': { ...HALF_KEYS['oc-13'], blockedUntil: 1_789_000_000_000 }, 'oc-14': { ...HALF_KEYS['oc-14'], blockedUntil: 1_789_000_000_000 }, 'oc-20': { id: 'oc-20', workspace: 'ws20', invalid: false, blockedUntil: 0, cooldownUntil: 0, usageWeekly: { status: 'ok', percent: 0, resetsAt: new Date(1_789_000_000_000).toISOString() }, usageMonthly: { status: 'ok', percent: 0, resetsAt: new Date(1_790_000_000_000).toISOString() } } }
    const p2 = await writeSnapshot(stateDir, 'added', { nowMs: T0, keys: keys2 })
    assert.equal(resolvePoolerDispatchBlock(p2, T0, knobs), undefined, 'owner adds a key → 2 usable → dispatch passes (the HALT clears on new keys)')
    assert.deepEqual(scanPoolerCapacity(p2, T0, scanKnobs), [], 'added-key recovery → NO finding')
  })
})

test('m-2333 (d) — OUTSIDE the HALT, the pooler alerts are info/no-bloqueo, NEVER a gate: a snapshot that the OLD spec would have WARNED «solo una key» (1 usable + 2 blocked) with healthy availability → NO finding and NO dispatch block; 2 usable with the last rotation a fresh 429→null → NO finding and NO dispatch block (the rotation is retired)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_788_000_000_000
    const knobs = { stateStaleMs: 600000, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 }
    const scanKnobs = { ...knobs, warningUsableKeys: 1, okUsableKeys: 2, blockedKeysInWindow: 3, criticalGlobalRemainingPercent: 20, criticalWeeklyRemainingPercent: 10 }
    // (d1) 1 usable + 2 blocked (the old «solo una key» shape) with healthy
    // availability → no finding, no block (maxima maquina — run free).
    const single = await writeSnapshot(stateDir, 'single', { nowMs: T0, keys: { 'oc-6': oc6(10, 20), 'oc-13': HALF_KEYS['oc-13'], 'oc-14': HALF_KEYS['oc-14'] } })
    assert.deepEqual(scanPoolerCapacity(single, T0, scanKnobs), [], '1 usable + 2 blocked with healthy availability → NO finding (the «solo una key» WARNING is RETIRED)')
    assert.equal(resolvePoolerDispatchBlock(single, T0, knobs), undefined, 'the old «solo una key» shape → dispatch passes (no block)')
    // (d2) 2 usable with a FRESH 429→null lastRotation → no finding, no block
    // (the rotation prelude is retired; alerts never gate).
    const rotated = await writeSnapshot(stateDir, 'rotated', { nowMs: T0, keys: { 'oc-6': oc6(10, 20), 'oc-20': { id: 'oc-20', workspace: 'ws20', invalid: false, blockedUntil: 0, cooldownUntil: 0, usageWeekly: { status: 'ok', percent: 0, resetsAt: new Date(1_789_000_000_000).toISOString() }, usageMonthly: { status: 'ok', percent: 0, resetsAt: new Date(1_790_000_000_000).toISOString() } } }, lastRotation: { from: 'oc-6', to: null, reason: '429 usage-limit', at: new Date(T0 - 60_000).toISOString() } })
    assert.deepEqual(scanPoolerCapacity(rotated, T0, scanKnobs), [], '2 usable + fresh 429→null rotation → NO finding (rotations are retired)')
    assert.equal(resolvePoolerDispatchBlock(rotated, T0, knobs), undefined, '2 usable + fresh 429→null rotation → dispatch passes (the rotation is not a gate)')
  })
})

// ===========================================================================
// O1 (VALLE 09-07 — the pool-health gate pre-dispatch, fb-39/fb-75/P4; spec
// 2026-09-07-o1-pool-health-gate-spec.md): the POOL-WIDE DURABLE records the
// pooler already persists on the SAME keyPooler-state.json snapshot —
// `billingDown` (fb-75, «sin crédito/saldo») and `halted` (P4, the
// ds-official insufficient-balance mirror) — were NOT consulted by the gate
// (the PoolerSnapshotLike mirror did not include them). Branch C =
// billingDown durable → BLOCK; branch D = halted durable → BLOCK; BOTH with
// the STALE-DURABLE exception (a durable verdict does not age — the pooler
// clears it ONLY on real recovery, never by time), checked BEFORE the stale
// early-return. The pooler record shapes below mirror dsh-key-pooler exactly
// (BillingDownRecord pool.ts:214-238 / PoolHalt pool.ts:187-192).
// ===========================================================================

const O1_BILLING_DOWN = {
  at: '2026-09-07T06:00:00.000Z',
  cause: 'official-insufficient-balance',
  message: 'billing gate: NO eligible key — the pool is dry by billing/no-credit cause (oc-6(billingBlocked)) — recovery: manual top-up (no automatic reset)',
  recovery: 'none'
}
const O1_HALTED = { at: '2026-09-07T06:00:00.000Z', reason: 'ds-official-insufficient-balance' }

test('O1 (e) — branch C (fb-75): a snapshot carrying the pool-wide `billingDown` record BLOCKS the dispatch with the stable «pool: billingDown — cause: message» reason even while a key is still ELIGIBLE (the verdict is pool-wide, not per-key); the STALE-DURABLE exception holds: the SAME record on a snapshot whose updatedAt is beyond stateStaleMs STILL blocks (the record does not age — and NO stale warn fires, the durable branch precedes the stale early-return)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_788_000_000_000
    const knobs = { stateStaleMs: 600000, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 }
    // (e1) FRESH snapshot + 1 eligible key (oc-6 healthy) + billingDown → BLOCK.
    const fresh = await writeSnapshot(stateDir, 'bd-fresh', { nowMs: T0, keys: { 'oc-6': oc6(10, 50), ...HALF_KEYS }, billingDown: O1_BILLING_DOWN })
    const freshBlock = resolvePoolerDispatchBlock(fresh, T0, knobs)
    assert.notEqual(freshBlock, undefined, 'billingDown present → dispatch BLOCKED (branch C)')
    assert.equal(freshBlock.reason, 'pool: billingDown — official-insufficient-balance: billing gate: NO eligible key — the pool is dry by billing/no-credit cause (oc-6(billingBlocked)) — recovery: manual top-up (no automatic reset)', 'the C reason = the stable «pool: billingDown — cause: message» prefix + the pooler record verbatim (the recovery horizon rides the message for the host digest)')
    // (e2) STALE snapshot (updatedAt 60 min old > stateStaleMs 10 min) + the
    // same durable record → STILL BLOCKED + no stale warn.
    const stale = await writeSnapshot(stateDir, 'bd-stale', { nowMs: T0, keys: { 'oc-6': oc6(10, 50), ...HALF_KEYS }, billingDown: O1_BILLING_DOWN, updatedAtOffsetMs: 60 * 60_000 })
    const warns = []
    const staleBlock = resolvePoolerDispatchBlock(stale, T0, knobs, { warn: (m) => warns.push(m) })
    assert.notEqual(staleBlock, undefined, 'a STALE snapshot that carries billingDown STILL blocks (the stale-durable exception — the record does not age by design)')
    assert.equal(staleBlock.reason, freshBlock.reason, 'the stale-durable block is the SAME branch-C reason')
    assert.deepEqual(warns, [], 'no stale warn (the durable branch runs BEFORE the stale early-return — a quiet-but-dry grid is not UNKNOWN)')
  })
})

test('O1 (f) — branch D (P4): a snapshot carrying the pooler `halted` mirror (reason ds-official-insufficient-balance) BLOCKS the dispatch with the stable «pool: ds-official HALTED (insufficient balance) — …» reason — ALSO under a STALE updatedAt (durable, same no-age treatment); a halted record WITHOUT the known reason still blocks with the raw reason verbatim (never a silent passthrough of a halt)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_788_000_000_000
    const knobs = { stateStaleMs: 600000, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 }
    // (f1) FRESH snapshot + halted → BLOCK (branch D).
    const fresh = await writeSnapshot(stateDir, 'halt-fresh', { nowMs: T0, keys: { 'oc-6': oc6(10, 50), ...HALF_KEYS }, halted: O1_HALTED })
    const freshBlock = resolvePoolerDispatchBlock(fresh, T0, knobs)
    assert.notEqual(freshBlock, undefined, 'halted present → dispatch BLOCKED (branch D)')
    assert.equal(freshBlock.reason, 'pool: ds-official HALTED (insufficient balance) — dispatch delayed; retry when the pooler lifts the halt (SIGHUP / POST /__keypool/revalidate after top-up)', 'the D reason = the stable «pool: ds-official HALTED (insufficient balance)» prefix + the dispatch-delay guidance (spec 4.4 triage prefix)')
    // (f2) STALE snapshot + the same record → STILL BLOCKED, no warn.
    const stale = await writeSnapshot(stateDir, 'halt-stale', { nowMs: T0, keys: { 'oc-6': oc6(10, 50), ...HALF_KEYS }, halted: O1_HALTED, updatedAtOffsetMs: 60 * 60_000 })
    const warns = []
    const staleBlock = resolvePoolerDispatchBlock(stale, T0, knobs, { warn: (m) => warns.push(m) })
    assert.notEqual(staleBlock, undefined, 'a STALE snapshot that carries halted STILL blocks (the durable mirror does not age)')
    assert.deepEqual(warns, [], 'no stale warn for the durable halt')
    // (f3) halted with an UNKNOWN reason → blocks with the raw reason verbatim.
    const unknown = await writeSnapshot(stateDir, 'halt-unknown', { nowMs: T0, keys: { 'oc-6': oc6(10, 50), ...HALF_KEYS }, halted: { at: '2026-09-07T06:00:00.000Z', reason: 'future-pooler-reason' } })
    const unknownBlock = resolvePoolerDispatchBlock(unknown, T0, knobs)
    assert.notEqual(unknownBlock, undefined, 'a halted record with an unknown reason STILL blocks (never a silent passthrough of a halt)')
    assert.equal(unknownBlock.reason, 'pool: ds-official HALTED (future-pooler-reason) — dispatch delayed; retry when the pooler lifts the halt (SIGHUP / POST /__keypool/revalidate after top-up)', 'an unknown halt reason is surfaced verbatim (never invented)')
  })
})

test('O1 (g) — C/D records ABSENT or NULL → 0 regression: the healthy pooler shapes (no billingDown/halted fields — legacy — OR explicit billingDown:null / halted:null — the current toState shape) pass through exactly like before; the m-2333 HALT and the CERTAIN 0-usable outage are untouched when no durable record rides the snapshot', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_788_000_000_000
    const knobs = { stateStaleMs: 600000, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 }
    // (g1) NO record fields at all (the pre-fb-75 legacy shape) + healthy pool → passthrough.
    const legacy = await writeSnapshot(stateDir, 'no-record', { nowMs: T0, keys: { 'oc-6': oc6(10, 20), ...HALF_KEYS } })
    assert.equal(resolvePoolerDispatchBlock(legacy, T0, knobs), undefined, 'a healthy snapshot WITHOUT billingDown/halted fields → passthrough (legacy shape, zero regression)')
    // (g2) EXPLICIT billingDown:null + halted:null (the CURRENT healthy pooler
    // write — toState always writes billingDown, poolSnapshotWithHalt deletes
    // halted) → passthrough (a null record is NOT a verdict).
    const healthyNull = await writeSnapshot(stateDir, 'null-records', { nowMs: T0, keys: { 'oc-6': oc6(10, 20), ...HALF_KEYS }, billingDown: null, halted: null })
    assert.equal(resolvePoolerDispatchBlock(healthyNull, T0, knobs), undefined, 'billingDown:null + halted:null → passthrough (null = not down, never a block)')
    // (g3) Without records, the m-2333 HALT (1 usable, weekly available < 20)
    // STILL blocks with its own reason (0 regression of the landed HALT).
    const haltPath = await writeSnapshot(stateDir, 'halt-again', { nowMs: T0, keys: { 'oc-6': oc6(85, 20), ...HALF_KEYS } })
    const haltBlock = resolvePoolerDispatchBlock(haltPath, T0, knobs)
    assert.notEqual(haltBlock, undefined, '1 usable with weekly available < 20% (no durable records) → the m-2333 HALT still blocks')
    assert.match(haltBlock.reason, /^pool: HALT — 1 usable key oc-6 \(weekly available 15% < 20% or monthly available 80% < 10%\) — NO new dispatches until ≥2 usable keys or new keys are added$/, 'the m-2333 HALT reason is byte-identical when no durable record rides the snapshot')
    // (g4) Without records, the CERTAIN 0-usable outage STILL blocks.
    const zeroPath = await writeSnapshot(stateDir, 'zero-again', { nowMs: T0, keys: HALF_KEYS })
    const zeroBlock = resolvePoolerDispatchBlock(zeroPath, T0, knobs)
    assert.notEqual(zeroBlock, undefined, '0 usable (no durable records) → the CERTAIN outage still blocks')
    assert.match(zeroBlock.reason, /0 usable keys — all blocked\/cooldown\/invalid/, 'the 0-usable outage reason is unchanged')
  })
})

test('O1 (h) — branch precedence: when BOTH durable records are present the C billing reason wins (the pool-wide billing verdict carries the richest triage — cause + recovery message); when a durable record AND the 0-usable outage coincide, the DURABLE record wins (it names the ROOT cause the per-key outage cannot see — the 08-31/09-02 lesson)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_788_000_000_000
    const knobs = { stateStaleMs: 600000, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 }
    // (h1) billingDown + halted both present → the C billingDown reason wins.
    const both = await writeSnapshot(stateDir, 'both', { nowMs: T0, keys: { 'oc-6': oc6(10, 50), ...HALF_KEYS }, billingDown: O1_BILLING_DOWN, halted: O1_HALTED })
    const bothBlock = resolvePoolerDispatchBlock(both, T0, knobs)
    assert.notEqual(bothBlock, undefined, 'both records present → BLOCK')
    assert.match(bothBlock.reason, /^pool: billingDown — official-insufficient-balance:/, 'the billingDown reason wins when both durables ride the snapshot (richest triage)')
    // (h2) billingDown + 0 usable keys (the real 09-02 outage shape — the pool
    // writes the record WHEN nothing is usable) → the DURABLE C reason wins
    // over the per-key outage reason (root cause over symptom).
    const dry = await writeSnapshot(stateDir, 'dry', { nowMs: T0, keys: HALF_KEYS, billingDown: O1_BILLING_DOWN })
    const dryBlock = resolvePoolerDispatchBlock(dry, T0, knobs)
    assert.notEqual(dryBlock, undefined, 'billingDown + 0 usable → BLOCK')
    assert.match(dryBlock.reason, /^pool: billingDown — official-insufficient-balance:/, 'the durable billing reason wins over the 0-usable outage reason (root cause first)')
    assert.doesNotMatch(dryBlock.reason, /0 usable keys — all blocked/, 'the per-key outage reason is NOT the one surfaced while the durable record rides')
  })
})