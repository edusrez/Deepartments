// dsh-deepartments — m-2333 (owner 2026-09-06, «MÁXIMA MÁQUINA CON HALT»):
// pool-governance rewrite of `resolvePoolerDispatchBlock` / `scanPoolerCapacity`.
// SUPERSEDES the LANE ② (incident-delivery 2026-09-03) R1 rotation age-check:
// the 429→null `lastRotation` signal is NO LONGER a gate (the ONLY runtime
// gate is the HALT condition + the CERTAIN 0-usable outage; the pooler-capacity
// alerts behave as info/no-bloqueo, NEVER as a gate).
//
// LANE ② DISCIPLINE: 0 builds — these tests exercise the SOURCE directly via
// Node's native type-stripping (node --test over src). The file REGISTERS the
// repo's ts-src-loader hook (node:module register — the hook rewrites the
// NodeNext `.js` specifiers to their `.ts` siblings for repo-.ts importers)
// BEFORE importing the modules, so the plain `node --test` suite run is
// unaffected (each test file runs in its own process).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  resolvePoolerDispatchBlock,
  scanPoolerCapacity,
  POOLER_CAPACITY_KEY_CRITICAL
} from '../packages/dshd-health/src/index.ts'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'lane2-gate-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Write a pooler snapshot with the given keys + a lastRotation (the m-2333
 * policy IGNORES the rotation — the fixtures keep it to prove it never gates). */
async function writeSnapshot(stateDir, name, { nowMs, keys = [{ id: 'k1', invalid: false, blockedUntil: 0, cooldownUntil: 0 }], updatedAtOffsetMs = 60_000, rotation = undefined }) {
  const p = path.join(stateDir, `${name}.json`)
  const keysObj = {}
  for (const k of keys) keysObj[k.id] = k
  await writeFile(p, JSON.stringify({
    updatedAt: new Date(nowMs - updatedAtOffsetMs).toISOString(),
    keys: keysObj,
    lastRotation: rotation
  }), 'utf8')
  return p
}

test('m-2333 dispatch gate (pure): the 429→null LAST ROTATION is NO LONGER a gate — a FRESH 429→null rotation with usable keys does NOT block the dispatch (the R1 branch-3 class is REMOVED; the ONLY availability gate is the HALT condition); a STALE 429→null rotation does NOT block either (no warn needed — the rotation signal is completely retired from the gate); the CERTAIN 0-usable outage still blocks', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_234_567_890_000
    const knobs = { stateStaleMs: 600000, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 }
    const rotation429Null = { from: 'k-old', to: null, reason: '429 usage-limit', at: new Date(T0 - 60_000).toISOString(), resetsAt: new Date(T0 + 7 * 86400_000).toISOString(), message: 'rot' }
    // FRESH rotation + 2 usable keys → NOT blocked (m-2333: run at full machine).
    const freshPath = await writeSnapshot(stateDir, 'fresh', { nowMs: T0, rotation: rotation429Null, keys: [
      { id: 'k1', invalid: false, blockedUntil: 0, cooldownUntil: 0, usageWeekly: { status: 'ok', percent: 30, resetsAt: new Date(T0 + 7 * 86400_000).toISOString() }, usageMonthly: { status: 'ok', percent: 40, resetsAt: new Date(T0 + 30 * 86400_000).toISOString() } },
      { id: 'k2', invalid: false, blockedUntil: 0, cooldownUntil: 0, usageWeekly: { status: 'ok', percent: 10, resetsAt: new Date(T0 + 7 * 86400_000).toISOString() }, usageMonthly: { status: 'ok', percent: 20, resetsAt: new Date(T0 + 30 * 86400_000).toISOString() } }
    ] })
    assert.equal(resolvePoolerDispatchBlock(freshPath, T0, knobs), undefined, 'a FRESH 429→null rotation with usable keys does NOT block (m-2333: rotation is not a gate)')
    // STALE rotation (60 min old) + usable keys → NOT blocked.
    const stalePath = await writeSnapshot(stateDir, 'stale', { nowMs: T0, rotation: { ...rotation429Null, at: new Date(T0 - 60 * 60_000).toISOString() }, keys: [
      { id: 'k1', invalid: false, blockedUntil: 0, cooldownUntil: 0 }
    ] })
    const warns = []
    assert.equal(resolvePoolerDispatchBlock(stalePath, T0, knobs, { warn: (m) => warns.push(m) }), undefined, 'a STALE 429→null rotation does NOT block (the R1 stale-signal class is gone)')
    // NO other keys usable → the CERTAIN branch (1) blocks REGARDLESS of the
    // rotation (the no-service outage is untouched).
    const zeroPath = await writeSnapshot(stateDir, 'zero', { nowMs: T0, rotation: rotation429Null, keys: [{ id: 'k1', invalid: false, blockedUntil: T0 + 3600_000, cooldownUntil: 0 }] })
    const zero = resolvePoolerDispatchBlock(zeroPath, T0, knobs)
    assert.notEqual(zero, undefined, 'zero usable keys still block (the CERTAIN no-service outage — m-2333 keeps it)')
    assert.match(zero.reason, /0 usable keys/, 'the zero-usable reason is unchanged')
  })
})

test('m-2333 dispatch gate (pure): a rotation WITHOUT a parseable `at` does NOT block (rotation is retired from the gate); the HALT knobs extend/shrink the pause window; a rotation TO a key is never relevant', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_234_567_890_000
    const knobs = { stateStaleMs: 600000, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 }
    // No `at` at all on the rotation → no block (rotation is not a gate anymore).
    const noAtPath = await writeSnapshot(stateDir, 'noat', { nowMs: T0, rotation: { from: 'k-old', to: null, reason: '429 usage-limit', resetsAt: new Date(T0 + 7 * 86400_000).toISOString() }, keys: [
      { id: 'k1', invalid: false, blockedUntil: 0, cooldownUntil: 0 }
    ] })
    assert.equal(resolvePoolerDispatchBlock(noAtPath, T0, knobs), undefined, 'a rotation without a parseable at does NOT block')
    // A rotation TO a key is never relevant either.
    const toKeyPath = await writeSnapshot(stateDir, 'tokey', { nowMs: T0, rotation: { from: 'k-old', to: 'k1', reason: '429 usage-limit', at: new Date(T0 - 60_000).toISOString() }, keys: [
      { id: 'k1', invalid: false, blockedUntil: 0, cooldownUntil: 0 }
    ] })
    assert.equal(resolvePoolerDispatchBlock(toKeyPath, T0, knobs), undefined, 'a rotation TO a key is never a block')
  })
})

test('m-2333 watchdog (pure): scanPoolerCapacity — a 429→null rotation (FRESH or STALE) produces NO finding (the R1 rotation-stale WARNING + the 429-prelude CRITICAL are REMOVED); a STALE rotation with ZERO usable keys falls through to the outage CRITICAL (the real no-service shortage still alerts)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_234_567_890_000
    const knobs = { warningUsableKeys: 1, okUsableKeys: 2, blockedKeysInWindow: 3, criticalGlobalRemainingPercent: 20, criticalWeeklyRemainingPercent: 10, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10, stateStaleMs: 600000 }
    const usable = (id) => ({ id, workspace: `ws-${id}`, invalid: false, blockedUntil: 0, cooldownUntil: 0, lastUsage: { status: 'ok', percent: 5, resetsAt: new Date(T0 + 3600_000).toISOString() }, usageWeekly: { status: 'ok', percent: 10, resetsAt: new Date(T0 + 7 * 86400_000).toISOString() }, usageMonthly: { status: 'ok', percent: 20, resetsAt: new Date(T0 + 30 * 86400_000).toISOString() }, lastError: null, lastCheckedAt: T0 })
    const rotation429Null = { from: 'k-old', to: null, reason: '429 usage-limit', at: new Date(T0 - 60_000).toISOString(), resetsAt: new Date(T0 + 7 * 86400_000).toISOString(), message: 'rot' }
    // FRESH rotation + 2 usable → NO finding (rotation is not a class anymore).
    const freshPath = await writeSnapshot(stateDir, 'fresh', { nowMs: T0, rotation: rotation429Null, keys: [usable('k1'), usable('k2')], updatedAtOffsetMs: 60_000 })
    assert.deepEqual(scanPoolerCapacity(freshPath, T0, knobs), [], 'a FRESH 429→null rotation with usable keys → NO finding (cero avisos outside HALT)')
    // STALE rotation + usable>0 → NO finding (the rotation-stale WARNING is gone).
    const stalePath = await writeSnapshot(stateDir, 'stale', { nowMs: T0, rotation: { ...rotation429Null, at: new Date(T0 - 60 * 60_000).toISOString() }, keys: [usable('k1'), usable('k2')] })
    assert.deepEqual(scanPoolerCapacity(stalePath, T0, knobs), [], 'a STALE 429→null rotation with usable keys → NO finding')
    // STALE + ZERO usable → the outage CRITICAL still fires (the real shortage).
    const staleZeroPath = await writeSnapshot(stateDir, 'stalezero', { nowMs: T0, rotation: { ...rotation429Null, at: new Date(T0 - 60 * 60_000).toISOString() }, keys: [{ id: 'k1', invalid: false, blockedUntil: T0 + 3600_000, cooldownUntil: 0 }, { id: 'k2', invalid: true, blockedUntil: 0, cooldownUntil: 0 }] })
    const staleZero = scanPoolerCapacity(staleZeroPath, T0, knobs)
    assert.equal(staleZero.length, 1, 'one finding')
    assert.equal(staleZero[0].key, POOLER_CAPACITY_KEY_CRITICAL, 'a STALE rotation with ZERO usable keys is the outage CRITICAL (fall-through to the no-service branch)')
  })
})