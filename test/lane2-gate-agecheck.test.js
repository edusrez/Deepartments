// dsh-deepartments — LANE ② (incident-delivery 2026-09-03) CUT 1: the GATE
// AGE-CHECK (R1 — the blackout root cause). resolvePoolerDispatchBlock's
// branch 3 blocked on a STALE 429→null rotation (NO age-check): a 44-min-old
// lastRotation re-armed the dispatch gate with 6/6 usable keys (17:00:31Z
// post-error; 295 failed rows 13:54→17:02Z).
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
  POOLER_CAPACITY_KEY_CRITICAL,
  POOLER_CAPACITY_KEY_ROTATION_STALE,
  POOLER_CAPACITY_DEFAULT_ROTATION_STALE_MS
} from '../packages/dshd-health/src/index.ts'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'lane2-gate-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Write a pooler snapshot with the given lastRotation (the `at` is the
 * rotation's OWN ts — the field the R1 age-check reads, NEVER the state
 * `updatedAt`, which the pooler rewrites on every health change). */
async function writeSnapshot(stateDir, name, { nowMs, rotationAtMs, keys = [{ id: 'k1', invalid: false, blockedUntil: 0, cooldownUntil: 0 }], updatedAtOffsetMs = 60_000, rotationTo = null, rotationReason = '429 usage-limit' }) {
  const p = path.join(stateDir, `${name}.json`)
  const keysObj = {}
  for (const k of keys) keysObj[k.id] = k
  await writeFile(p, JSON.stringify({
    updatedAt: new Date(nowMs - updatedAtOffsetMs).toISOString(),
    keys: keysObj,
    lastRotation: rotationTo === undefined ? undefined : { from: 'k-old', to: rotationTo, reason: rotationReason, at: new Date(rotationAtMs).toISOString(), resetsAt: new Date(nowMs + 7 * 86400_000).toISOString(), message: 'rot' }
  }), 'utf8')
  return p
}

test('LANE ② R1 gate (pure): a FRESH 429→null rotation BLOCKS with the observability payload (at + stale-age in the reason — §7.4); a STALE one (older than the freshness window) does NOT block and warns naming at + age', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_234_567_890_000
    const knobs = { highPercent: 90, stateStaleMs: 600000, rotationStaleMs: POOLER_CAPACITY_DEFAULT_ROTATION_STALE_MS }
    // FRESH: the rotation happened 1 min ago (< 15 min) → the gate MUST block
    // (the 7f634ef hardening for a REAL 503-prelude is preserved).
    const freshPath = await writeSnapshot(stateDir, 'fresh', { nowMs: T0, rotationAtMs: T0 - 60_000 })
    const fresh = resolvePoolerDispatchBlock(freshPath, T0, knobs)
    assert.notEqual(fresh, undefined, 'a FRESH 429→null rotation blocks the dispatch')
    assert.match(fresh.reason, /FRESH signal/, 'the block reason names the freshness class')
    assert.match(fresh.reason, /429 usage-limit/, 'the block reason names the 429 rotation')
    assert.match(fresh.reason, /FRESH signal @ .*, 1 min old/, 'the block reason exposes the rotation `at` and the age (observability §7.4)')
    assert.match(fresh.reason, /1\/1 usable/, 'the block reason carries the usable/total counts')
    // STALE: the rotation happened 60 min ago (> 15 min) with a usable key →
    // the gate MUST NOT block (R1 — the blackout class: 6/6 usable still gated
    // for 47 min by a stale signal).
    const stalePath = await writeSnapshot(stateDir, 'stale', { nowMs: T0, rotationAtMs: T0 - 60 * 60_000 })
    const warns = []
    const stale = resolvePoolerDispatchBlock(stalePath, T0, knobs, { warn: (m) => warns.push(m) })
    assert.equal(stale, undefined, 'a STALE 429→null rotation does NOT block (the stale signal must not re-arm the gate)')
    assert.equal(warns.length, 1, 'the stale release warns (self-report)')
    assert.match(warns[0], /STALE \(at .*60 min > 15 min window/, 'the warn names the rotation at + the stale-age (§7.4)')
    assert.match(warns[0], /NOT blocking/, 'the warn states the release decision explicitly')
    // NO other keys usable → branch (1) blocks REGARDLESS of the rotation age
    // (the CERTAIN exhaustion branch is untouched — only the signal's OWN
    // staleness releases the 429→null branch).
    const zeroPath = await writeSnapshot(stateDir, 'zero', { nowMs: T0, rotationAtMs: T0 - 60 * 60_000, keys: [{ id: 'k1', invalid: false, blockedUntil: T0 + 3600_000, cooldownUntil: 0 }] })
    const zero = resolvePoolerDispatchBlock(zeroPath, T0, knobs)
    assert.notEqual(zero, undefined, 'zero usable keys still block (branch 1 — untouched)')
    assert.match(zero.reason, /0 usable keys/, 'the branch-1 reason is unchanged')
  })
})

test('LANE ② R1 gate (pure): a rotation WITHOUT a parseable `at` blocks conservatively (the 7f634ef hardening is NOT blind-reverted — unknown age = FRESH-like); the rotationStaleMs knob extends/shrinks the freshness window', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_234_567_890_000
    const knobs = { highPercent: 90, stateStaleMs: 600000, rotationStaleMs: POOLER_CAPACITY_DEFAULT_ROTATION_STALE_MS }
    // No `at` at all on the rotation → conservative FRESH (blocks).
    const noAtPath = await writeSnapshot(stateDir, 'noat', { nowMs: T0, rotationAtMs: T0 })
    const noAtText = JSON.parse(await (await import('node:fs/promises')).readFile(noAtPath, 'utf8'))
    delete noAtText.lastRotation.at
    await (await import('node:fs/promises')).writeFile(noAtPath, JSON.stringify(noAtText), 'utf8')
    const noAt = resolvePoolerDispatchBlock(noAtPath, T0, knobs)
    assert.notEqual(noAt, undefined, 'a 429→null rotation WITHOUT a parseable at still blocks (conservative — a pooler that does not stamp the ts keeps the hardening)')
    assert.match(noAt.reason, /at unknown/, 'the reason names the unknown at')
    // Knob: a rotation 20 min old with a 30 min window → FRESH → blocks.
    const knobPath = await writeSnapshot(stateDir, 'knob', { nowMs: T0, rotationAtMs: T0 - 20 * 60_000 })
    assert.notEqual(resolvePoolerDispatchBlock(knobPath, T0, { ...knobs, rotationStaleMs: 30 * 60_000 }), undefined, 'the rotationStaleMs knob extends the freshness window (20 min < 30 min → fresh → blocks)')
    // Knob: a rotation 20 min old with a 10 min window → STALE → releases.
    assert.equal(resolvePoolerDispatchBlock(knobPath, T0, { ...knobs, rotationStaleMs: 10 * 60_000 }), undefined, 'the rotationStaleMs knob shrinks the freshness window (20 min > 10 min → stale → releases)')
    // A rotation TO a key is NOT the prelude (unchanged).
    const toKeyPath = await writeSnapshot(stateDir, 'tokey', { nowMs: T0, rotationAtMs: T0 - 60_000, rotationTo: 'k2' })
    assert.equal(resolvePoolerDispatchBlock(toKeyPath, T0, knobs), undefined, 'a rotation TO a key is never the 429→null block')
  })
})

test('LANE ② R1 watchdog (pure): scanPoolerCapacity — a FRESH 429→null rotation stays CRITICAL; a STALE one WITH usable keys self-reports the `pooler-capacity:rotation-stale` WARNING (§7.4d — usable>0 && stale signal); a STALE one with ZERO usable keys falls through to the usable-count CRITICAL (the real shortage decides)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = 1_234_567_890_000
    const knobs = { warningUsableKeys: 2, criticalUsableKeys: 1, blockedKeysInWindow: 3, highPercent: 90, stateStaleMs: 600000, rotationStaleMs: POOLER_CAPACITY_DEFAULT_ROTATION_STALE_MS }
    const usable = (id) => ({ id, workspace: `ws-${id}`, invalid: false, blockedUntil: 0, cooldownUntil: 0, lastUsage: { status: 'ok', percent: 5, resetsAt: new Date(T0 + 3600_000).toISOString() }, lastError: null, lastCheckedAt: T0 })
    // FRESH → critical (the real 503-prelude).
    const freshPath = await writeSnapshot(stateDir, 'fresh', { nowMs: T0, rotationAtMs: T0 - 60_000, keys: [usable('k1'), usable('k2')], updatedAtOffsetMs: 60_000 })
    const fresh = scanPoolerCapacity(freshPath, T0, knobs)
    assert.equal(fresh.length, 1, 'one finding')
    assert.equal(fresh[0].key, POOLER_CAPACITY_KEY_CRITICAL, 'a FRESH 429→null rotation is still the CRITICAL prelude')
    // STALE + usable>0 → the R1 WARNING (the stale-signal self-report).
    const stalePath = await writeSnapshot(stateDir, 'stale', { nowMs: T0, rotationAtMs: T0 - 60 * 60_000, keys: [usable('k1'), usable('k2')] })
    const stale = scanPoolerCapacity(stalePath, T0, knobs)
    assert.equal(stale.length, 1, 'one finding')
    assert.equal(stale[0].key, POOLER_CAPACITY_KEY_ROTATION_STALE, 'a STALE 429→null rotation with usable keys self-reports under the DEDICATED key (never the critical key)')
    assert.match(stale[0].error, /STALE 429→null rotation at .* \(60 min > 15 min window\)/, 'the stale warning names at + stale-age')
    assert.match(stale[0].error, /2\/2 keys usable/, 'the stale warning names the usable count (the R1 «usable>0 && stale» condition)')
    // STALE + ZERO usable → the usable-count CRITICAL fires (the real shortage,
    // not the bygone signal).
    const staleZeroPath = await writeSnapshot(stateDir, 'stalezero', { nowMs: T0, rotationAtMs: T0 - 60 * 60_000, keys: [{ id: 'k1', invalid: false, blockedUntil: T0 + 3600_000, cooldownUntil: 0 }, { id: 'k2', invalid: true, blockedUntil: 0, cooldownUntil: 0 }] })
    const staleZero = scanPoolerCapacity(staleZeroPath, T0, knobs)
    assert.equal(staleZero.length, 1, 'one finding')
    assert.equal(staleZero[0].key, POOLER_CAPACITY_KEY_CRITICAL, 'a STALE rotation with ZERO usable keys is the CRITICAL shortage (fall-through to the usable-count branch)')
  })
})