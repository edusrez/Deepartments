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

/** Write a pooler snapshot. `keys` maps keyId → PoolerKeyStateLike. */
async function writeSnapshot(stateDir, name, { nowMs, keys, updatedAtOffsetMs = 60_000, lastRotation = null }) {
  const p = path.join(stateDir, `${name}.json`)
  await writeFile(p, JSON.stringify({
    updatedAt: new Date(nowMs - updatedAtOffsetMs).toISOString(),
    keys,
    lastRotation
  }), 'utf8')
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