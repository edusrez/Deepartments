// ACTUADOR DEL CONTEXTO — LA ESCALADA QUE SE PERDÍA PARA SIEMPRE (BUG C),
// fb-14717 RE, run token 9f7699e9.
//
// THE DEFECT, MEASURED IN TWO LAYERS (the second one is the one that was still
// OPEN, and it is NOT the one the intra-tick retry closed):
//
//   LAYER 1 (closed by the predecessor lane): the marker persisted the ANCHOR
//   before anyone attempted delivery, and the same-session gate then skipped the
//   act forever ⇒ a throwing `notifyPost` lost the escalation for that whole
//   incarnation. Fixed by `escalation: 'pending'` + a bounded retry.
//
//   LAYER 2 (THIS LANE — the retry existed on paper and was UNREACHABLE): that
//   retry lives INSIDE the findings loop, and `scanContextThreshold` is
//   HYSTERETIC PER (agent, BAND) — the fb-50 calibration, «a repeat of the same
//   level is not a new anomaly» — so a member PERSISTING in its latched band
//   produces NO finding. And the act fires at the band's CEILING: a session past
//   its window accepts NO NEW TURN, so its projected pressure FREEZES and the
//   band can never rise again. ⇒ On exactly the ticks that must retry,
//   `contextFindings` is EMPTY ⇒ the retry was reachable ONLY on an UPWARD
//   re-crossing, which a blown session structurally cannot produce.
//
// MEASURED BEFORE THE FIX (same session, seam back UP, frozen band, 31-min
// ticks): 4 consecutive ticks, `escalationAttempts` frozen at 1, ZERO
// deliveries. MEASURED AFTER: the SAME probe delivers on the FIRST retry tick.
// The counter-experiment proves the retry was STARVED, not broken: with an
// UPWARD re-crossing the PRE-FIX code delivered immediately.
//
// METHOD (the house src-native pattern — the predecessor
// `oom-actuador-contexto-25953dc6.test.js` precedent): `dshd-health/src` has ZERO
// relative imports, so Node's native type-stripping loads it DIRECTLY: the
// CURRENT SOURCE, NO BUILD, and `packages/dshd-health/lib/` is untouched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const H = await import('../packages/dshd-health/src/index.ts')

const WINDOW = 1_048_576
const RESERVE = 262_144
const T0 = new Date(2026, 8, 16, 10, 0, 0).getTime()
const MARKER = 'context-action.json'
/** One tick's spacing, chosen ABOVE `CONTEXT_ACTION_ESCALATION_RETRY_MS` (30
 * min) so every step is a legitimately-due retry, and above the scan's own
 * `contextThresholdPollMs` bucket (60 s) so the poll gate never confuses the
 * measurement. */
const STEP_MS = 31 * 60 * 1000
/** effective = projected + RESERVE > WINDOW ⇒ beyondUsableWindow TRUE (b11). */
const BEYOND = 900_000
/** effective = 702546 + 262144 = 964690 → 92% → the ADVISORY rung (b9). */
const ADVISORY = 702_546

async function tick(stateDir, { nowMs, rows, posts, notifyPost, warn }) {
  await H.runHealthDaemonTick({
    now: () => nowMs,
    stateDir,
    bootId: 'bugc-boot',
    hosts: [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }],
    ...(posts !== undefined ? { posts } : {}),
    sessionContexts: rows,
    config: { health: { contextCompletionReserve: RESERVE } },
    notifyHost: async () => {},
    ...(notifyPost !== undefined ? { notifyPost } : {}),
    logger: { warn: warn ?? (() => {}), info: () => {} }
  })
}

async function readMarker(stateDir) {
  return JSON.parse(await readFile(path.join(stateDir, MARKER), 'utf8'))
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bugc-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The ONE shape this lane is about: a session that has ALREADY blown its
 * window. It accepts no new turn, so its pressure never moves again — the same
 * row, tick after tick. `sameSession` is what makes the band FREEZE. */
const blownRow = (agentId, sessionId, projected = BEYOND) => ({
  postId: agentId,
  sessionId,
  contextWindow: WINDOW,
  projectedTokens: projected
})

const workerPost = (postId, managerId) => [{ postId, sessionId: 's-w', managerId, retired: false }]

// ---------------------------------------------------------------------------
test('BUG C (1) — THE OBSERVABLE: after the seam FAILS once, the escalation IS DELIVERED on a LATER tick, with the band FROZEN (a blown session produces NO finding — the retry was unreachable exactly there)', async () => {
  await withTempDir(async (stateDir) => {
    const deliveries = []
    let seamUp = false
    const notifyPost = async (postId, frame, opts) => {
      if (!seamUp) throw new Error('SEAM DOWN')
      deliveries.push({ postId, frame, opts })
    }
    const rows = [blownRow('builder-x', 'SESS-1')]
    const posts = workerPost('builder-x', 'ip-head')

    // TICK 1 — the seam is DOWN. The act happens (marker + log), the DELIVERY
    // fails, and the failure is RECORDED instead of swallowed.
    await tick(stateDir, { nowMs: T0, rows, posts, notifyPost })
    assert.equal(deliveries.length, 0, 'tick 1: the seam is down → nothing delivered')
    let ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].escalation, 'pending', 'the FAILED delivery is RECORDED (layer 1 of the defect — never swallowed)')
    assert.equal(ledger['builder-x'].escalationAttempts, 1, 'the attempt is counted')
    assert.equal(ledger['builder-x'].lastAttemptAt, T0, 'the retry clock starts at the FAILED attempt')

    // TICK 2 — the seam is back UP, the SAME session, the band FROZEN (the
    // identical row: a session that blew its window accepts no new turn, so it
    // can NEVER re-cross upward). This is the tick that the pre-fix code could
    // not reach: `contextFindings` is EMPTY here.
    seamUp = true
    await tick(stateDir, { nowMs: T0 + STEP_MS, rows, posts, notifyPost })
    assert.equal(deliveries.length, 1, 'THE FIX: the escalation is DELIVERED on the next tick even though the frozen band published NO finding — before this it was lost for the whole incarnation')
    assert.equal(deliveries[0].postId, 'ip-head', 'it still goes to the MANAGER (the actor), never to the blowing session')
    assert.equal(deliveries[0].opts.sourceKey, 'context-action:builder-x:SESS-1', 'the sourceKey is unchanged — the SAME act, re-delivered')
    ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].escalation, 'delivered', 'the ledger now says delivered (auditable from the file alone)')
    assert.equal(ledger['builder-x'].escalatedTo, 'ip-head', 'and names WHERE it escalated')

    // TICK 3 — and it STOPS: a delivered escalation is never re-sent.
    await tick(stateDir, { nowMs: T0 + 2 * STEP_MS, rows, posts, notifyPost })
    assert.equal(deliveries.length, 1, 'no duplicate: `delivered` is SETTLED, so the resume pass never touches it again')
  })
})

// ---------------------------------------------------------------------------
test('BUG C (2) — THE ANCHOR NEVER MOVES: the resume re-delivers the SAME act (`at` is the FACT) and only the attempt clock advances; a NEW incarnation still acts on its own', async () => {
  await withTempDir(async (stateDir) => {
    const deliveries = []
    let seamUp = false
    const notifyPost = async (postId, frame, opts) => {
      if (!seamUp) throw new Error('SEAM DOWN')
      deliveries.push({ opts })
    }
    const posts = workerPost('builder-x', 'ip-head')
    await tick(stateDir, { nowMs: T0, rows: [blownRow('builder-x', 'SESS-1')], posts, notifyPost })
    seamUp = true
    await tick(stateDir, { nowMs: T0 + STEP_MS, rows: [blownRow('builder-x', 'SESS-1')], posts, notifyPost })
    const ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].at, T0, 'THE ANCHOR: `at` is when the act first ran — the event fact NEVER moves on a retry (only the attempt clock does)')
    assert.equal(ledger['builder-x'].sessionId, 'SESS-1', 'the anchor session is unchanged: one episode, one anchor')
    assert.equal(ledger['builder-x'].action, 'compact-or-rotate', 'the token is untouched by the retry (consumed verbatim from the instrument)')
    // A FRESH incarnation is a NEW event: the fb-1091 rule is untouched by this
    // lane. NOTE on the input: the scan's tier latch is keyed per AGENT (not per
    // session) so it must CLIMB to publish a finding — the pre-existing fb-50
    // calibration the predecessor test (a4) also documents. This lane does not
    // touch it; the row therefore climbs (b11 → b12).
    await tick(stateDir, { nowMs: T0 + 2 * STEP_MS, rows: [blownRow('builder-x', 'SESS-2', 1_050_000)], posts, notifyPost })
    assert.equal(deliveries.length, 2, 'a NEW session hitting the wall is a NEW fact and DOES act (the fb-1091 anchoring invariant is preserved)')
    assert.equal(deliveries[1].opts.sourceKey, 'context-action:builder-x:SESS-2', 'the new act carries the NEW session anchor')
  })
})

// ---------------------------------------------------------------------------
test('BUG C (3) — THE RETRY IS BOUNDED: a permanently broken seam is retried `CONTEXT_ACTION_ESCALATION_MAX_ATTEMPTS` times and then STOPS (a retry that never ends is a storm, not a fix)', async () => {
  await withTempDir(async (stateDir) => {
    let calls = 0
    const notifyPost = async () => {
      calls += 1
      throw new Error('SEAM DOWN FOREVER')
    }
    const rows = [blownRow('builder-x', 'SESS-1')]
    const posts = workerPost('builder-x', 'ip-head')
    const WINDOWS = 8
    for (let i = 0; i < WINDOWS; i++) {
      await tick(stateDir, { nowMs: T0 + i * STEP_MS, rows, posts, notifyPost })
    }
    assert.equal(calls, H.CONTEXT_ACTION_ESCALATION_MAX_ATTEMPTS, `the seam is attempted exactly ${H.CONTEXT_ACTION_ESCALATION_MAX_ATTEMPTS} times over ${WINDOWS} eligible ticks — the budget is the honest bound`)
    const ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].escalationAttempts, H.CONTEXT_ACTION_ESCALATION_MAX_ATTEMPTS, 'the attempt count is capped at the declared budget')
    assert.equal(ledger['builder-x'].escalation, 'pending', 'and it stays HONESTLY `pending` — never claimed as delivered')
  })
})

// ---------------------------------------------------------------------------
test('BUG C (4) — THE TIER INVARIANT (b9 vs b10): an ADVISORY resume is delivered as the ADVISORY act it was — the latch CERTIFIES the mark\'s own tier, it never re-derives one', async () => {
  await withTempDir(async (stateDir) => {
    const frames = []
    let seamUp = false
    const notifyPost = async (postId, frame) => {
      if (!seamUp) throw new Error('SEAM DOWN')
      frames.push(frame)
    }
    const rows = [blownRow('builder-x', 'SESS-9', ADVISORY)]
    const posts = workerPost('builder-x', 'ip-head')
    await tick(stateDir, { nowMs: T0, rows, posts, notifyPost })
    let ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].phase, 'advisory', 'the act is the ADVISORY tier (b9 — the last rung whose request still fits)')
    assert.equal(ledger['builder-x'].action, 'rotate-before-death', 'and this consumer\'s OWN token, never a fabricated `compact-or-rotate`')
    seamUp = true
    await tick(stateDir, { nowMs: T0 + STEP_MS, rows, posts, notifyPost })
    assert.equal(frames.length, 1, 'the advisory escalation is resumed')
    assert.match(frames[0], /context-action \(advisory\)/, 'the resumed frame is the ADVISORY frame — the tier is re-emitted VERBATIM')
    assert.ok(!frames[0].includes('beyond-usable-window'), 'the resume NEVER escalates the tier: the session still fits, so claiming it does not would be a fabricated consequence (the fb-967 class)')
    ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].phase, 'advisory', 'the ledger keeps the advisory tier')
  })
})

// ---------------------------------------------------------------------------
test('BUG C (5) — the declared LIMIT is preserved and NOT "fixed" by widening the anti-self-feed: a HEAD (no `managerId`) gets its MARKER and ZERO delivery, recorded as `no-actor` — and is NEVER retried into the fb-759 self-loop', async () => {
  await withTempDir(async (stateDir) => {
    const deliveries = []
    // A HEAD carries no managerId (MEASURED in production); 'selfy' names ITSELF.
    const posts = [
      { postId: 'quality-head', sessionId: 's-h', retired: false },
      { postId: 'selfy', sessionId: 's-s', managerId: 'selfy', retired: false }
    ]
    const rows = [blownRow('quality-head', 'SESS-HEAD'), blownRow('selfy', 'SESS-SELF')]
    for (let i = 0; i < 5; i++) {
      await tick(stateDir, { nowMs: T0 + i * STEP_MS, rows, posts, notifyPost: async (postId) => deliveries.push(postId) })
    }
    assert.deepEqual(deliveries, [], 'NO delivery: neither the manager-less HEAD nor the self-referencing post is addressed — delivering to the flagged post IS the fb-759 loop')
    const ledger = await readMarker(stateDir)
    assert.equal(ledger['quality-head'].escalation, 'no-actor', 'the missing actor is recorded HONESTLY (the gap is never silent)')
    assert.equal(ledger['selfy'].escalation, 'no-actor', 'a self-referential manager is the same terminal case')
    assert.equal(Object.keys(ledger).length, 2, 'the ACT still happened for both — only the DELIVERY is impossible (the marker + the host ALERT carry the fact)')
    assert.equal(ledger['quality-head'].escalationAttempts, undefined, '`no-actor` is TERMINAL: it is never retried (a resume pass can never manufacture an actor)')
  })
})

// ---------------------------------------------------------------------------
test('BUG C (6) — THE RETRY POLICY, PURE: the latch is a MEMBERSHIP test, never a tier source (below the mark\'s band → SILENT, never a fabricated down-tier)', async () => {
  const pendingMark = (phase) => ({
    sessionId: 'SESS-P', at: T0, action: phase === 'advisory' ? 'rotate-before-death' : 'compact-or-rotate',
    phase, pct: phase === 'advisory' ? 0.92 : 1.1, effectiveTokens: 0, contextWindow: WINDOW,
    escalation: 'pending', escalationAttempts: 1, lastAttemptAt: T0
  })
  const plan = (ledger, latches, nowMs) => H.planContextActions({ findings: [], nowMs, ledger, contextTierLatches: latches })

  // THE MEASURED CASE: a frozen band, a due retry, the latch still above the wall.
  let p = plan({ 'a': pendingMark('beyond-usable-window') }, { 'a': 11 }, T0 + STEP_MS)
  assert.equal(p.actions.length, 1, 'a `pending` mark + a present latch (+ a due window) RESUMES — and it does so with NO findings at all, which is exactly the tick the bug starved')
  assert.equal(p.actions[0].agentId, 'a', 'the resumed agent is named')
  assert.equal(p.actions[0].mark.lastAttemptAt, T0 + STEP_MS, 'the attempt clock advances (so the cadence cannot loop at one ts)')
  assert.equal(p.actions[0].mark.at, T0, 'and the ANCHOR does not move')
  assert.equal(p.actions[0].mark.phase, 'beyond-usable-window', 'the tier is re-emitted VERBATIM — the latch never re-derives it')

  assert.equal(plan({ 'a': pendingMark('beyond-usable-window') }, { 'a': 10 }, T0 + STEP_MS).actions.length, 1, 'b10 (the mark\'s own band) certifies it: b10 is the TOP band, so there is no higher tier to confuse it with')
  assert.equal(plan({ 'a': pendingMark('advisory') }, { 'a': 9 }, T0 + STEP_MS).actions.length, 1, 'b9 certifies the ADVISORY mark (the only rung that still fits)')
  assert.equal(plan({ 'a': pendingMark('advisory') }, { 'a': 10 }, T0 + STEP_MS).actions.length, 0, 'b9 mark + a latch now at b10 → SILENT: a DIFFERENT tier on the same anchor is a NEW fact owned by the findings pass, never a resume (the two passes can never both deliver one episode)')
  assert.equal(plan({ 'a': pendingMark('beyond-usable-window') }, { 'a': 8 }, T0 + STEP_MS).actions.length, 0, 'a latch BELOW the mark\'s band is «cannot certify» — NEVER a fabricated down-tier')
  assert.equal(plan({ 'a': pendingMark('beyond-usable-window') }, {}, T0 + STEP_MS).actions.length, 0, 'no latch (return to normal, or a wiring that cannot read it) → NO resume: the condition that justified the act is no longer certified')
  assert.equal(plan({ 'a': pendingMark('beyond-usable-window') }, { 'a': 11 }, T0).actions.length, 0, 'the retry WINDOW has not elapsed → silent (a per-tick retry is a storm)')
  assert.equal(plan({ 'a': { ...pendingMark('beyond-usable-window'), escalationAttempts: H.CONTEXT_ACTION_ESCALATION_MAX_ATTEMPTS } }, { 'a': 11 }, T0 + STEP_MS).actions.length, 0, 'the budget is spent → terminal')
  assert.equal(plan({ 'a': { ...pendingMark('beyond-usable-window'), escalation: 'delivered' } }, { 'a': 11 }, T0 + STEP_MS).actions.length, 0, '`delivered` is SETTLED (layer-1 semantics untouched)')
  assert.equal(plan({ 'a': { ...pendingMark('beyond-usable-window'), escalation: 'no-actor' } }, { 'a': 11 }, T0 + STEP_MS).actions.length, 0, '`no-actor` is TERMINAL — the declared HEAD limit is never retried')
})

// ---------------------------------------------------------------------------
// THE REVERT-CHECK (MANDATORY, and stated as a CHECK): with the resume pass
// neutralized, the acceptance of test (1) must go RED. The revert is TEXTUAL and
// lives in a TEMP dir — ZERO writes inside the repo (this test file is the
// lane's only new repo artifact, and the temp dir gets a `node_modules` SYMLINK
// so the copy resolves the bare workspace imports exactly like the real source).
// ---------------------------------------------------------------------------
test('BUG C REVERT-CHECK — with the RESUME PASS neutralized the escalation is LOST again (the acceptance THROWS there and PASSES on the real module)', async () => {
  const srcPath = path.join(import.meta.dirname, '..', 'packages', 'dshd-health', 'src', 'index.ts')
  const source = await readFile(srcPath, 'utf8')
  // THE GATE OF THIS LANE: the resume pass's call site. Neutralizing THAT ONE
  // STATEMENT is the minimal mechanical revert — the scan, the finding, the tier
  // latch, the marker and the (intra-tick) layer-1 retry all keep running; ONLY
  // the reachability of the retry is gone, which is precisely the defect.
  const GATE = 'await runContextActuator([])'
  const occurrences = source.split(GATE).length - 1
  assert.equal(occurrences, 1, 'the resume-pass gate is found EXACTLY once (a revert that matches nothing proves nothing)')
  const reverted = source.replace(GATE, 'if (false) await runContextActuator([])')

  /** THE ACCEPTANCE, as a function of the module under test: fail the seam once,
   * then bring it UP with the band FROZEN and require delivery. */
  const acceptResume = async (mod) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bugc-rv-'))
    try {
      await symlink(path.join(import.meta.dirname, '..', 'node_modules'), path.join(dir, 'node_modules'), 'dir')
      let seamUp = false
      const deliveries = []
      const notifyPost = async (postId) => {
        if (!seamUp) throw new Error('SEAM DOWN')
        deliveries.push(postId)
      }
      const rows = [blownRow('builder-x', 'SESS-1')]
      const posts = workerPost('builder-x', 'ip-head')
      await mod.runHealthDaemonTick({
        now: () => T0, stateDir: dir, bootId: 'rv',
        hosts: [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }],
        posts, sessionContexts: rows,
        config: { health: { contextCompletionReserve: RESERVE } },
        notifyHost: async () => {}, notifyPost,
        logger: { warn: () => {}, info: () => {} }
      })
      const marker = JSON.parse(await readFile(path.join(dir, MARKER), 'utf8'))
      assert.equal(marker['builder-x'].escalation, 'pending', 'step 1: the failed delivery is recorded (layer 1 intact in BOTH trees)')
      seamUp = true
      await mod.runHealthDaemonTick({
        now: () => T0 + STEP_MS, stateDir: dir, bootId: 'rv',
        hosts: [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }],
        posts, sessionContexts: rows,
        config: { health: { contextCompletionReserve: RESERVE } },
        notifyHost: async () => {}, notifyPost,
        logger: { warn: () => {}, info: () => {} }
      })
      assert.equal(deliveries.length, 1, 'ACCEPTANCE: with the seam back UP the escalation is DELIVERED on the next tick (the band is frozen: NO finding is published)')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  await withTempDir(async (tempDir) => {
    const revertedPath = path.join(tempDir, 'reverted-index.ts')
    await writeFile(revertedPath, reverted, 'utf8')
    await symlink(path.join(import.meta.dirname, '..', 'node_modules'), path.join(tempDir, 'node_modules'), 'dir')
    const R = await import(pathToFileUrl(revertedPath))

    // THE LITERAL FAILURE, DEMONSTRATED: the SAME acceptance must THROW on the
    // reverted tree…
    await acceptResume(R).then(
      () => assert.fail('REVERT-CHECK FALSE NEGATIVE: the acceptance held on the REVERTED tree — the revert is not real and this lane proves nothing'),
      (error) => assert.equal(error.code, 'ERR_ASSERTION', `REVERT PROOF (literal): with the resume pass neutralized the escalation is LOST again — the acceptance throws: ${error.code}`)
    )
    // …and PASS on the REAL one (the check is falsifiable in BOTH directions).
    await acceptResume(H).then(
      () => {},
      (error) => assert.fail(`the acceptance MUST hold on the REAL module — it threw: ${error.message}`)
    )
  })
})

// `pathToFileURL` is needed only by the revert-check's dynamic import; imported
// lazily so the file's top-level stays the plain src-native pattern.
function pathToFileUrl(p) {
  return new URL(`file://${p}`).href
}
