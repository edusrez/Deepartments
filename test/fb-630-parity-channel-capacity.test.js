// dsh-deepartments — fb-630 (host, 2026-09-11): THE SECOND SOURCE OF CAPACITY.
//
// WHY THIS SUITE EXISTS (and why it is not redundant with the m-2333 suite):
// `test/pool-halt-max-machine.test.js` locks the m-2333 HALT over the GO pool
// only — every snapshot it writes has NO `channels` array, so the whole parity
// branch added by fb-630 was UNCOVERED (finding of the IPH, session 59: the
// helper is exported and had zero references under test/). A branch that no
// test exercises is a branch that can silently rot, and this one GATES EVERY
// DISPATCH of the org (its failure mode is the org-wide autobloqueo measured on
// 2026-09-11: the verdict blocked the very action that would have repaired it).
//
// THE CONTRACT UNDER TEST. The dispatch gate counts, as serving capacity:
//   · every USABLE Go key (unchanged, m-2333), PLUS
//   · every DECLARED emergency channel that can serve RIGHT NOW — i.e.
//     `enabled === true` AND `halted !== true` AND past its `cooldownUntil`.
// Note `peer` is NOT required: capability is read from the channel's own state,
// never from its rotation role.
//
// THE FAIL-STOP SEMANTICS ARE THE POINT — the tests below assert BOTH directions:
//   · a channel that is OFF, DRY or COOLING DOWN counts for NOTHING;
//   · with ZERO serving sources (0 Go + 0 channels) the gate STILL blocks;
//   · with NO `channels` field at all (older pooler / Go-only composition) the
//     verdict is byte-identical to the pre-fix one.
//
// fb-95 (AGENTS.md): BUILT-lib test (plain `node --test` over lib/invoke.js) —
// it does NOT self-register the ts-src-loader hook.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { resolvePoolerDispatchBlock, poolerServingChannels } from '../lib/invoke.js'

// A fixed instant: every scenario builds its snapshot relative to it, so the
// cooldown boundary below is exact rather than clock-dependent.
const NOW = 1_789_124_000_000

const KNOBS = { stateStaleMs: 3_600_000, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 }

/** A Go key at the HALT edge: weekly 82% consumed ⇒ 18% available (< 20). */
const thinKey = (overrides = {}) => ({
  id: 'oc-15',
  invalid: false,
  blockedUntil: 0,
  cooldownUntil: 0,
  usageWeekly: { percent: 82 },
  usageMonthly: { percent: 83 },
  ...overrides
})

/** A Go key with NO availability left (blocked) — makes `usable.length === 0`. */
const blockedKey = (overrides = {}) => thinKey({ blockedUntil: NOW + 999_999_999, ...overrides })

/** One declared channel; `commandcode`-shaped by default. */
const channel = (overrides = {}) => ({
  id: 'commandcode',
  enabled: true,
  peer: true,
  halted: false,
  cooldownUntil: 0,
  ...overrides
})

/** Write a pooler snapshot and return its path. `channels: undefined` leaves the
 * field ABSENT (the legacy/Go-only shape — distinct from an empty list on
 * purpose: both must behave the same, and the suite proves it). */
async function snapshot(stateDir, { keys, channels, updatedAtOffsetMs = 60_000 }) {
  const file = path.join(stateDir, 'keyPooler-state.json')
  const body = {
    updatedAt: new Date(NOW - updatedAtOffsetMs).toISOString(),
    keys,
    billingDown: null
  }
  if (channels !== undefined) body.channels = channels
  await writeFile(file, JSON.stringify(body))
  return file
}

async function withStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb630-parity-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

const verdict = (file) => resolvePoolerDispatchBlock(file, NOW, KNOBS)

test('fb-630 (1): NO `channels` field ⇒ the verdict is the PRE-FIX one — HALT on a thin single Go key', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, { keys: { 'oc-15': thinKey() } })
    const r = verdict(file)
    assert.notEqual(r, undefined, 'a thin single key with no declared channels must still HALT')
    assert.match(r.reason, /^pool: HALT — 1 usable key oc-15/)
  })
})

test('fb-630 (2): an empty `channels` LIST behaves exactly like an ABSENT field (no declared channels ⇒ Go-only)', async () => {
  await withStateDir(async (stateDir) => {
    const absent = verdict(await snapshot(stateDir, { keys: { 'oc-15': thinKey() } }))
    const empty = verdict(await snapshot(stateDir, { keys: { 'oc-15': thinKey() }, channels: [] }))
    assert.notEqual(empty, undefined, 'an empty channel list must not lift the HALT')
    assert.deepEqual(empty, absent, 'empty list and absent field must produce the identical verdict')
  })
})

test('fb-630 (3): a SERVING channel is serving capacity ⇒ the HALT is LIFTED (the 2026-09-11 case)', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, {
      keys: { 'oc-15': thinKey() },
      channels: [channel(), channel({ id: 'ds-official', enabled: false, peer: false })]
    })
    assert.equal(verdict(file), undefined, 'a thin Go key PLUS a healthy channel must NOT halt')
  })
})

test('fb-630 (4): the channel counts WITHOUT `peer` — capability comes from its own state, not its rotation role', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, {
      keys: { 'oc-15': thinKey() },
      channels: [channel({ peer: false })]
    })
    assert.equal(verdict(file), undefined, 'an enabled, healthy channel counts even when it is not a declared peer')
  })
})

test('fb-630 (5): FAIL-STOP INTACT — a DRY (`halted`) channel counts for NOTHING ⇒ HALT returns', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, {
      keys: { 'oc-15': thinKey() },
      channels: [channel({ halted: true })]
    })
    const r = verdict(file)
    assert.notEqual(r, undefined, 'a dry channel must NOT be counted as capacity')
    assert.match(r.reason, /^pool: HALT/)
  })
})

test('fb-630 (6): FAIL-STOP INTACT — a channel INSIDE ITS COOLDOWN counts for NOTHING ⇒ HALT returns', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, {
      keys: { 'oc-15': thinKey() },
      channels: [channel({ cooldownUntil: NOW + 1 })]
    })
    assert.notEqual(verdict(file), undefined, 'a cooling-down channel must NOT be counted as capacity')
  })
})

test('fb-630 (7): FAIL-STOP INTACT — a DISABLED channel counts for NOTHING ⇒ HALT returns', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, {
      keys: { 'oc-15': thinKey() },
      channels: [channel({ enabled: false })]
    })
    assert.notEqual(verdict(file), undefined, 'a declared-but-switched-off channel must NOT count')
  })
})

test('fb-630 (8): the cooldown deadline is INCLUSIVE at the boundary (a channel is serving from `cooldownUntil` onwards)', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, {
      keys: { 'oc-15': thinKey() },
      channels: [channel({ cooldownUntil: NOW })]
    })
    assert.equal(verdict(file), undefined, 'cooldownUntil === now is past the cooldown, not inside it')
  })
})

test('fb-630 (9): ZERO Go keys + 0 channels ⇒ STILL blocked (the «todas-secas» outage is untouched)', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, { keys: { 'oc-15': blockedKey() }, channels: [channel({ halted: true })] })
    const r = verdict(file)
    assert.notEqual(r, undefined, 'no serving source at all must still block')
    assert.match(r.reason, /0 usable keys — all blocked\/cooldown\/invalid/)
  })
})

test('fb-630 (10): ZERO Go keys + a SERVING channel ⇒ PASSES, and emits NO halt text (finding of the IPH, adjudicated)', async () => {
  // The IPH reported that with Go=0 and a serving channel the gate «pasa pero
  // devuelve el texto HALT — falso y alarmante». MEASURED: it does not. With no
  // usable Go key the m-2333 branch is not even reachable (`usable.length === 1`
  // is required to enter it), so the verdict is `undefined` — a silent pass with
  // NO diagnostic text at all. This test locks that behaviour so the claim
  // cannot silently become true later.
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, { keys: { 'oc-15': blockedKey() }, channels: [channel()] })
    assert.equal(verdict(file), undefined, 'a serving channel must carry the org with zero usable Go keys')
  })
})

test('fb-630 (11): the HALT reason names ONLY the arm(s) that actually hold (fb-632 regression lock)', async () => {
  await withStateDir(async (stateDir) => {
    // weekly 18% < 20% HOLDS; monthly 17% < 10% does NOT. The old literal joined
    // both with «or», asserting a false comparison verbatim — and the reports of
    // several agents quoted it. Only the true arm may appear now.
    const file = await snapshot(stateDir, {
      keys: { 'oc-15': thinKey({ usageMonthly: { percent: 83 } }) }
    })
    const r = verdict(file)
    assert.match(r.reason, /weekly available 18% < 20%/, 'the arm that holds must be named')
    assert.doesNotMatch(r.reason, /monthly available 17% < 10%/, 'the arm that does NOT hold must not be asserted')
    // fb-632 is specifically the «or» JOINING THE TWO COMPARISONS (the closing
    // clause «…or new keys are added» is the protocol's own wording and stays).
    assert.doesNotMatch(r.reason, / or monthly available /, 'the arms are no longer joined by a misleading «or»')
  })
})

test('fb-630 (12): BOTH arms holding are BOTH named (joined by «and», never by a falsifying «or»)', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, {
      keys: { 'oc-15': thinKey({ usageWeekly: { percent: 95 }, usageMonthly: { percent: 95 } }) }
    })
    const r = verdict(file)
    assert.match(r.reason, /weekly available 5% < 20% and monthly available 5% < 10%/)
  })
})

test('fb-630 (13): poolerServingChannels is the gate’s ONLY capability predicate — unit-level locks', () => {
  const state = (channels) => ({ channels })
  assert.deepEqual(poolerServingChannels(state([channel()]), NOW).length, 1)
  assert.deepEqual(poolerServingChannels(undefined, NOW), [], 'an absent snapshot serves nothing')
  assert.deepEqual(poolerServingChannels({}, NOW), [], 'a snapshot without `channels` serves nothing')
  assert.deepEqual(poolerServingChannels({ channels: 'nonsense' }, NOW), [], 'a malformed field is not capacity')
  assert.deepEqual(
    poolerServingChannels(state([
      channel({ id: 'a' }),
      channel({ id: 'b', halted: true }),
      channel({ id: 'c', enabled: false }),
      channel({ id: 'd', cooldownUntil: NOW + 1 }),
      channel({ id: 'e', cooldownUntil: NOW })
    ]), NOW).map((c) => c.id),
    ['a', 'e'],
    'only enabled + not-halted + past-cooldown channels are serving'
  )
})
