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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { resolvePoolerDispatchBlock, poolerServingChannels, scanPoolerCapacity } from '../lib/invoke.js'

// fb-635 (QH/q-i-241, 2026-09-11): THE SECOND CONSUMER. `scanPoolerCapacity` is
// the ALERT producer — the surface an operator (or a post-mortem) reads. It used
// to decide Go-ONLY while the dispatch gate counted channels, so after the fb-630
// fix the gate lifted the HALT and THIS kept announcing «HALT (m-2333)»: one
// datum, two verdicts. The convergence tests at the end of this file lock the two
// surfaces to the SAME verdict — the unification the QH demanded (the predicate
// is not re-implemented: both call `poolerServingChannels`).
const SCAN_KNOBS = {
  stateStaleMs: 3_600_000,
  haltWeeklyAvailablePercent: 20,
  haltMonthlyAvailablePercent: 10,
  warningUsableKeys: 1,
  okUsableKeys: 2,
  blockedKeysInWindow: 3,
  criticalGlobalRemainingPercent: 20,
  criticalWeeklyRemainingPercent: 10
}

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

// ---------------------------------------------------------------------------
// fb-635 — THE TWO CONSUMERS MUST AGREE. The gate (`resolvePoolerDispatchBlock`)
// decides whether work can START; the alert producer (`scanPoolerCapacity`) tells
// a HUMAN what the pool is doing. Both must read the SAME capacity predicate:
// a divergence means the dispatch resumes while the alert keeps announcing a pause
// (or, worse, a post-mortem concludes from the alert that the org was down when it
// was serving). Each case asserts the pair, not one of them.
// ---------------------------------------------------------------------------

/** Assert the gate verdict and the alert presence agree for one snapshot. */
async function assertConvergent(stateDir, { keys, channels, expectBlocked, label }) {
  const file = await snapshot(stateDir, { keys, channels })
  const gate = resolvePoolerDispatchBlock(file, NOW, KNOBS)
  const alerts = scanPoolerCapacity(file, NOW, SCAN_KNOBS)
  const gateBlocked = gate !== undefined
  assert.equal(
    gateBlocked,
    expectBlocked,
    `${label}: gate expected ${expectBlocked ? 'BLOCKED' : 'OPEN'}, got ${gateBlocked ? `blocked (${gate.reason})` : 'open'}`
  )
  assert.equal(
    alerts.length > 0,
    expectBlocked,
    `${label}: the ALERT must ${expectBlocked ? 'fire' : 'stay silent'} — the two consumers must not diverge (fb-635)`
  )
}

test('fb-635 (1): a SERVING channel ⇒ the gate is OPEN *and* the alert is SILENT (the live case after the fix)', async () => {
  await withStateDir(async (stateDir) => {
    await assertConvergent(stateDir, { keys: { 'oc-15': thinKey() }, channels: [channel()], expectBlocked: false, label: 'thin Go + healthy channel' })
  })
})

test('fb-635 (2): a DRY channel ⇒ gate BLOCKS *and* the alert FIRES (fail-stop intact on BOTH surfaces)', async () => {
  await withStateDir(async (stateDir) => {
    await assertConvergent(stateDir, { keys: { 'oc-15': thinKey() }, channels: [channel({ halted: true })], expectBlocked: true, label: 'thin Go + dry channel' })
  })
})

test('fb-635 (3): no declared channels ⇒ both surfaces are the PRE-FIX Go-only verdict', async () => {
  await withStateDir(async (stateDir) => {
    await assertConvergent(stateDir, { keys: { 'oc-15': thinKey() }, expectBlocked: true, label: 'thin Go, no channels' })
  })
})

test('fb-635 (4): ZERO usable Go + a serving channel ⇒ both surfaces say «not blocked» (the outage needs NO serving source)', async () => {
  await withStateDir(async (stateDir) => {
    await assertConvergent(stateDir, { keys: { 'oc-15': blockedKey() }, channels: [channel()], expectBlocked: false, label: 'no usable Go + healthy channel' })
  })
})

test('fb-635 (5): ZERO usable Go + a DRY channel ⇒ both surfaces BLOCK (the «todas-secas» class is untouched)', async () => {
  await withStateDir(async (stateDir) => {
    await assertConvergent(stateDir, { keys: { 'oc-15': blockedKey() }, channels: [channel({ halted: true })], expectBlocked: true, label: 'no usable Go + dry channel' })
  })
})

test('fb-635 (6): a channel in COOLDOWN ⇒ both surfaces BLOCK (a cooling channel is not capacity anywhere)', async () => {
  await withStateDir(async (stateDir) => {
    await assertConvergent(stateDir, { keys: { 'oc-15': thinKey() }, channels: [channel({ cooldownUntil: NOW + 1 })], expectBlocked: true, label: 'thin Go + cooling channel' })
  })
})

// ---------------------------------------------------------------------------
// 2026-09-22 (host-approved lane) — THE MEASURED INCIDENT OF THE CAPACITY GATE.
// The gate blocked a REAL dispatch to quality-head at 16:48Z and its text read
// «pool: workspaces (all) at quota (0 usable keys — …; 0/0 keys) — dispatch
// delayed; retry when a fresh key resolves» — while the pooler was serving HTTP
// 200 on `commandcode` at that moment. The VERDICT was RIGHT (the channel was
// inside its cooldown ⇒ in THAT instant no path could serve, so the predicate
// blocked) but the LABEL named the WRONG SUBJECT (the Go pool, which was empty,
// instead of the cooling channel) and gave the WRONG REMEDY (a fresh Go key that
// was not needed — waiting seconds for the cooldown was). These tests lock the
// three corrections: name the missing path(s) BY CAUSE, prescribe the cheapest
// remedy, and DECLARE the measurement basis.
// ---------------------------------------------------------------------------

test('2026-09-22 (1): the INCIDENT shape — Go 0/0 AND a declared channel enabled+not-halted but INSIDE its cooldown ⇒ STILL blocks (predicate untouched, that instant had no serving path) but the label names BOTH missing paths and the remedy is WAITING, never «a fresh key»', async () => {
  await withStateDir(async (stateDir) => {
    // The exact live shape: `keys: {}` (the Go pool declared NO key — 0/0) plus
    // `commandcode` enabled, NOT halted, cooling down for 383 s.
    const file = await snapshot(stateDir, { keys: {}, channels: [channel({ cooldownUntil: NOW + 383_000 })] })
    const r = verdict(file)
    assert.notEqual(r, undefined, 'the incident case still BLOCKS — the predicate is NOT touched (a cooling channel serves nothing, so in that instant there was no path)')
    assert.match(r.reason, /^pool: workspaces \(all\) at quota \(0 usable keys — all blocked\/cooldown\/invalid; 0\/0 keys\) —/, 'the delivered verdict text is preserved (the pre-fix head of the message)')
    // (i) NAME THE MISSING PATH BY CAUSE — BOTH of them, never one chosen.
    assert.match(r.reason, /missing: the Go pool declares NO key at all \(0\/0 keys\)/, 'the EMPTY Go pool is named as such (the case of the day)')
    assert.match(r.reason, /channel commandcode is in COOLDOWN \(~383s left — transient, auto-resolves\)/, 'the COOLING CHANNEL is named, with the time left derived from cooldownUntil − now')
    // (ii) THE REMEDY COMES FROM THE CAUSE — wait, do not look for a key.
    assert.match(r.reason, /remedy: wait ~383s for channel commandcode to leave its cooldown/, 'the remedy is to WAIT the cooldown out (transient, auto-resolves)')
    assert.doesNotMatch(r.reason, /retry when a fresh key resolves/, '«retry when a fresh key resolves» is NOT issued when a channel cooldown is the cause (the measured false remedy)')
    // (iii) DECLARE THE MEASUREMENT BASIS (class affinity: a pooler
    // re-architecture must not leave this counter measuring the void).
    assert.match(r.reason, /basis: Go keys \(usable = not invalid, not blocked, past cooldown\) \+ declared channels \(enabled && !halted && past cooldown\)/, 'the message states which serving paths it consulted')
    // The FORM CONSUMERS keep working: delivery.ts:1945 classifies on the triad.
    assert.match(r.reason, /pool:.*at quota.*dispatch delayed/, 'the triad pool: / at quota / dispatch delayed survives (delivery.ts:1945)')
  })
})

test('2026-09-22 (2): the CONTROL — Go 0/0 with NO channels declared is a REAL outage ⇒ blocks and names the empty Go pool as the missing path (plus the un-declared channels)', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, { keys: {} })
    const r = verdict(file)
    assert.notEqual(r, undefined, 'no usable path at all (0 Go, no channels) ⇒ STILL blocks — this case IS the outage')
    assert.match(r.reason, /missing: the Go pool declares NO key at all \(0\/0 keys\); no channels are declared/, 'both missing paths are enumerated (empty Go pool AND no declared channel)')
    assert.match(r.reason, /remedy: retry when a fresh key resolves \(the Go pool must gain a usable key\)$/, 'with no cheaper path available, the remedy IS a fresh Go key (the pre-fix guidance, correctly scoped)')
  })
})

test('2026-09-22 (3): a HALTED channel is named as such and its remedy is LIFTING THE HALT — never «a fresh key»', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, { keys: {}, channels: [channel({ halted: true, cooldownUntil: 0 })] })
    const r = verdict(file)
    assert.notEqual(r, undefined, 'a dry channel serves nothing ⇒ still blocks')
    assert.match(r.reason, /missing: the Go pool declares NO key at all \(0\/0 keys\); channel commandcode is HALTED/, 'the halted channel is named BY CAUSE')
    assert.match(r.reason, /remedy: lift the halt on channel commandcode/, 'the remedy is lifting the halt (the pooler owns the SIGHUP/revalidate path)')
    assert.doesNotMatch(r.reason, /retry when a fresh key resolves/, 'no fresh-key guidance for a halt cause')
  })
})

test('2026-09-22 (4): a DISABLED channel is named as such, and the fix is to enable it; the triad + the basis still ride along', async () => {
  await withStateDir(async (stateDir) => {
    const file = await snapshot(stateDir, { keys: {}, channels: [channel({ id: 'ds-official', enabled: false, peer: false, cooldownUntil: 0 })] })
    const r = verdict(file)
    assert.notEqual(r, undefined, 'a switched-off channel serves nothing ⇒ still blocks')
    assert.match(r.reason, /missing: the Go pool declares NO key at all \(0\/0 keys\); channel ds-official is DISABLED/, 'the disabled channel is named')
    assert.match(r.reason, /remedy: enable the declared channel ds-official$/, 'the cheapest remedy for that cause')
    assert.match(r.reason, /basis: Go keys .*declared channels/, 'the measurement basis is always declared')
    assert.match(r.reason, /pool:.*at quota.*dispatch delayed/, 'the form triad survives on every cause variant')
  })
})

// ---------------------------------------------------------------------------
// 2026-09-22 (host-approved lane, fb-2425 (A)) — THE OFFICIAL-API GUARD AS THE
// FOURTH FAIL-STOP OF THE CAPACITY GATE. THIS TEST LOCKS THE **DIRECTION**, NOT
// THE FIELD: the same snapshot WITH and WITHOUT `officialBlocked` must produce
// DIFFERENT verdicts, and the side WITH the field is the correct one.
//
// WHY IT IS NOT TAUTOLOGICAL. The pooler's guard NEVER removes a blocked entry
// from the list — it only denies it SERVICE (`isOfficialApiChannel`,
// dsh-key-pooler/src/proxy.ts:796-799; the entry stays visible in /status with
// `officialBlocked: true`, proxy.ts:2213). So a blocked entry keeps
// `enabled: true` / `halted: false` / `cooldownUntil: 0` — i.e. it satisfied
// EVERY conjunct of the pre-fb-2425 predicate except the one that did not exist.
//
// THE DIRECTION (MEASURED, not argued — see the report for the raw run):
//   · WITH the marker  ⇒ the gate BLOCKS (the blocked entry is NOT capacity);
//   · WITHOUT the marker ⇒ the gate OPENS (the entry reads as real capacity).
// The second half is the phantom: the dispatch is allowed through and the
// pooler's structural floor refuses it (503). The assertion below therefore
// compares the TWO verdicts of the SAME snapshot — if the old predicate were
// still in place, the two sides would be IDENTICAL and this test goes RED.
// ---------------------------------------------------------------------------

/** The blocked entry EXACTLY as the pooler publishes it: the marker is additive
 *  and the rest of the triad is UNTOUCHED (`enabled: true` survives in config). */
const blockedOfficialChannel = (extra = {}) => channel({ id: 'ds-official', peer: false, officialBlocked: true, ...extra })

test('fb-2425 (1): DIRECTION — a BLOCKED entry that keeps `enabled: true` is NOT capacity: the snapshot WITH the marker BLOCKS, the same snapshot WITHOUT it OPENS (the phantom) — the two verdicts MUST differ', async () => {
  // NOTE: each variant lives in its OWN stateDir ON PURPOSE — `snapshot()` writes
  // the fixed `keyPooler-state.json` name, so two variants in one dir would
  // overwrite each other and both reads would see the SECOND (the trap this test
  // hit in its first draft; the negative control is what exposed it).
  await withStateDir(async (blockedDir) => {
    await withStateDir(async (openDir) => {
      // The measured defect shape: the Go pool has NO usable key (0/0) and the ONLY
      // declared entry is the official API, blocked by the guard — still enabled.
      const blocked = await snapshot(blockedDir, { keys: {}, channels: [blockedOfficialChannel()] })
      const open = await snapshot(openDir, { keys: {}, channels: [blockedOfficialChannel({ officialBlocked: false })] })
      // (a) THE TWO VERDICTS DIFFER — this is the assertion the OLD predicate fails.
      assert.notEqual(
        verdict(blocked) === undefined,
        verdict(open) === undefined,
        'the marker MUST change the verdict: with `officialBlocked` the blocked entry is not capacity; without it the identical entry reads as real capacity'
      )
      // (b) …and the WITH-marker side is the CORRECT one: no serving source exists,
      //     so the gate blocks instead of letting a dispatch die at the pooler's floor.
      const r = verdict(blocked)
      assert.notEqual(r, undefined, 'a blocked official entry must NOT count as capacity — 0 Go + 0 real channels is the CERTAIN outage')
      assert.match(r.reason, /^pool: workspaces \(all\) at quota/, 'the CERTAIN-outage verdict is delivered (the class that was already honest)')
      // (c) THE PHANTOM, stated explicitly so the regression mode is legible: with
      //     the marker ignored the gate would PASS this dispatch.
      assert.equal(verdict(open), undefined, 'CONTROL: without the marker the entry satisfies enabled/!halted/past-cooldown ⇒ the gate OPENS (the phantom capacity this lane removes)')
    })
  })
})

test('fb-2425 (2): the SECOND branch too — the marker also denies the m-2333 HALT lift (one blocked entry must not satisfy the «≥2 usable sources» premise)', async () => {
  await withStateDir(async (blockedDir) => {
    await withStateDir(async (openDir) => {
      const blocked = await snapshot(blockedDir, { keys: { 'oc-15': thinKey() }, channels: [blockedOfficialChannel()] })
      const open = await snapshot(openDir, { keys: { 'oc-15': thinKey() }, channels: [blockedOfficialChannel({ officialBlocked: false })] })
      assert.notEqual(verdict(blocked), undefined, 'a thin Go key with only a BLOCKED entry left ⇒ the HALT stands (the blocked entry is not the 2nd source)')
      assert.match(verdict(blocked).reason, /^pool: HALT — 1 usable key oc-15/, 'the m-2333 HALT is the branch that must return')
      assert.equal(verdict(open), undefined, 'CONTROL: the identical entry WITHOUT the marker lifts the HALT — the exact phantom this lane removes')
    })
  })
})

test('fb-2425 (3): ADDITIVE + ONE PREDICATE — absent/false is byte-identical to the pre-fb-2425 world, and BOTH consumers read the same marker', async () => {
  await withStateDir(async (stateDir) => {
    // ABSENT (every pre-W1 snapshot and every legitimate channel) ⇒ unchanged.
    const absent = await snapshot(stateDir, { keys: { 'oc-15': thinKey() }, channels: [channel()] })
    const falsey = await snapshot(stateDir, { keys: { 'oc-15': thinKey() }, channels: [channel({ officialBlocked: false })] })
    assert.equal(verdict(absent), undefined, 'ABSENT `officialBlocked` ⇒ a healthy channel still counts (the additive contract)')
    assert.deepEqual(verdict(falsey), verdict(absent), '`false` reads EXACTLY like ABSENT')
    // The PREDICATE is the reader — the field is not re-interpreted per consumer.
    const read = await snapshot(stateDir, { keys: {}, channels: [blockedOfficialChannel()] })
    const parsed = JSON.parse(await readFile(read, 'utf8'))
    assert.deepEqual(poolerServingChannels(parsed, NOW), [], 'the single predicate excludes the blocked entry (both consumers count through it)')
    // fb-635 convergence HELD for the new class: gate BLOCKS *and* the alert FIRES.
    await assertConvergent(stateDir, { keys: { 'oc-15': thinKey() }, channels: [blockedOfficialChannel()], expectBlocked: true, label: 'thin Go + blocked official entry' })
    await assertConvergent(stateDir, { keys: { 'oc-15': thinKey() }, channels: [channel()], expectBlocked: false, label: 'thin Go + unmarked healthy channel' })
  })
})
