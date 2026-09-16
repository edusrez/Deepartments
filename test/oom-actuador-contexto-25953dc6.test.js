// ACTUADOR DEL CONTEXTO (2026-09-16, run token 25953dc6) — THE CONSUMER of the
// instruction the scan ALREADY published.
//
// THE MEASURED BREACH (fb-967 class: «the instrument measures X and the text
// names Y»): `scanContextThreshold` ALREADY names the action — at the last rung
// it publishes `beyondUsableWindow = true` + `contextAction = 'compact-or-rotate'`
// — and the finding ALREADY rides the findings→dedupe→notifyHost ALERT path.
// What did NOT exist was ANYONE TO EXECUTE IT: the token travelled in the audit
// row and died there. This lane adds that consumer.
//
// THE ANCHORING TRAP THIS TEST ENFORCES (MEASURED, fb-1091): the `bN` SERIES of
// `contextThresholdKey(agentId, band)` RESTARTS PER INCARNATION (a `b6` row can
// carry the LIVE session's id) and the ledger LOSES FRANJAS (0 rows across a
// restart with rows before and after) ⇒ a `bN` series reconstructed by a later
// read is NOT reliable (the inherited corroboration citing
// `quality-head:b8 = 00:15:08.733Z` was FALSE: that row was 23:35:08.733Z, i.e.
// BEFORE b7). And `contextThresholdKey` is a per-(member, band) DEDUPE key with
// band hysteresis: useful to NOT repeat alerts, NEVER as an event identity.
// ⇒ The act is anchored to the MEASURED FACT OF THE LIVE SESSION — `sessionId`
// — and the four tests below are exactly those semantics: NO session ⇒ NO act;
// SAME session ⇒ NO re-act; NEW incarnation ⇒ NEW act.
//
// METHOD (the repo's src-native pattern WITHOUT the resolution hook — the
// `test/context-threshold-usable-window.test.js` precedent): `dshd-health/src`
// has ZERO relative imports (only node: builtins + bare workspace packages,
// which resolve through node_modules symlinks), so Node's native type-stripping
// loads it DIRECTLY. This test therefore exercises the CURRENT SOURCE with NO
// BUILD and NO hook registration, and leaves `packages/dshd-health/lib/`
// untouched (published artifacts keep their pre-lane mtimes).
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

/** ONE hermetic daemon tick against a temp stateDir (the same dep surface the
 * existing M-A tick tests drive). */
async function tick(stateDir, { nowMs, rows, posts, notifyPost, warn }) {
  await H.runHealthDaemonTick({
    now: () => nowMs,
    stateDir,
    bootId: 'actuador-boot',
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
  const dir = await mkdtemp(path.join(tmpdir(), 'actuador-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('ACTUADOR (a) — the finding that NAMED its consequence is EXECUTED: a beyond-window row writes a DURABLE, SESSION-ANCHORED marker (the act is a fact, not a token in the audit row)', async () => {
  await withTempDir(async (stateDir) => {
    const warns = []
    // 900000 + 262144 = 1162144 > 1048576 ⇒ beyondUsableWindow TRUE.
    await tick(stateDir, {
      nowMs: T0,
      rows: [{ postId: 'quality-head', sessionId: 'head-quality-head-LIVE', contextWindow: WINDOW, projectedTokens: 900_000 }],
      warn: (m) => warns.push(m)
    })
    const ledger = await readMarker(stateDir)
    assert.equal(ledger['quality-head'].sessionId, 'head-quality-head-LIVE', 'THE ANCHOR is the LIVE session that produced the figure — never the band name')
    assert.equal(ledger['quality-head'].action, 'compact-or-rotate', 'the action token is CONSUMED from the finding, never re-invented here')
    assert.equal(ledger['quality-head'].phase, 'beyond-usable-window', 'the tier is declared structurally')
    assert.equal(ledger['quality-head'].at, T0, 'the act is stamped')
    assert.equal(ledger['quality-head'].contextWindow, WINDOW, 'the FRAME travels with the figure (the LANE HEALTH invariant)')
    assert.equal(ledger['quality-head'].effectiveTokens, 1_162_144, 'the numerator is the published frame (projected + reserve)')
    assert.ok(
      warns.some((m) => m.includes('context-action') && m.includes('head-quality-head-LIVE')),
      'the act is DECLARED in the log (the trace names the session, not just the agent)'
    )
  })
})

test('ACTUADOR (a2) — THE TWO TIERS: `contextAction` is published ONLY beyond the window (b10), so this consumer ALSO acts one rung EARLIER (b9, advisory) — the LAST rung whose request still fits; a b5/b8 row with plenty of runway is left alone', async () => {
  await withTempDir(async (stateDir) => {
    const deliveries = []
    const posts = [{ postId: 'builder-x', sessionId: 's-w', managerId: 'ip-head', retired: false }]
    // b8 (85%) → plenty of runway → NO act. b9 (92%) → the declared advisory
    // rung → ACT. b10 → the instrument's own tier → ACT.
    const at = (projected) => Math.round(projected) - RESERVE
    await tick(stateDir, {
      nowMs: T0,
      rows: [{ postId: 'builder-x', sessionId: 'sess-b8', contextWindow: WINDOW, projectedTokens: at(0.85 * WINDOW) }],
      posts, notifyPost: async (id, f, o) => deliveries.push({ id, o })
    })
    assert.equal(deliveries.length, 0, 'b8 (85%): the request fits with real runway — NO act (the advisory rung is b9, not «anything above the 50% alert threshold»)')
    await tick(stateDir, {
      nowMs: T0 + 60_000,
      rows: [{ postId: 'builder-x', sessionId: 'sess-b9', contextWindow: WINDOW, projectedTokens: at(0.92 * WINDOW) }],
      posts, notifyPost: async (id, f, o) => deliveries.push({ id, o })
    })
    assert.equal(deliveries.length, 1, 'b9 (92%): the ADVISORY tier fires — the last chance to save the session')
    let ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].phase, 'advisory', 'b9 is the advisory tier, declared structurally')
    assert.equal(ledger['builder-x'].action, 'rotate-before-death', 'at b9 the instrument named NOTHING — so this consumer declares its OWN token, never a fabricated `compact-or-rotate` (the fb-967 class: never name an action the instrument did not)')
    // b10 — the same session escalates to the instrument's own tier.
    await tick(stateDir, {
      nowMs: T0 + 120_000,
      rows: [{ postId: 'builder-x', sessionId: 'sess-b10', contextWindow: WINDOW, projectedTokens: WINDOW - RESERVE + 1 }],
      posts, notifyPost: async (id, f, o) => deliveries.push({ id, o })
    })
    assert.equal(deliveries.length, 2, 'b10: the beyond-window tier fires')
    ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].phase, 'beyond-usable-window', 'b10 is the beyond-window tier')
    assert.equal(ledger['builder-x'].action, 'compact-or-rotate', 'b10 consumes the instrument\'s OWN token verbatim')
  })
})

test('ACTUADOR (a3) — SESSION-INDEPENDENT (the head\'s question (a), answered by effect): the act fires even when the flagged session can accept NO NEW TURN — the marker is written by the DAEMON process and the escalation goes to a DIFFERENT post (the manager), never to the dying session', async () => {
  await withTempDir(async (stateDir) => {
    const deliveries = []
    // The flagged post's live handle is ABSENT from the agents registry (it is
    // modelled as dead: it can accept nothing). Only its last projection row
    // survives — exactly the state of a session that just blew the window.
    await tick(stateDir, {
      nowMs: T0,
      rows: [{ postId: 'builder-x', sessionId: 'sess-DEAD', contextWindow: WINDOW, projectedTokens: 788_856 }],
      posts: [{ postId: 'builder-x', sessionId: 's-dead', managerId: 'internal-programming-head', retired: false }],
      notifyPost: async (id, f, o) => deliveries.push(id)
    })
    assert.equal(deliveries.length, 1, 'the escalation is delivered even though the flagged session is dead')
    assert.equal(deliveries[0], 'internal-programming-head', 'it goes to the MANAGER — a different, healthy post — NEVER to the dying session')
    const ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].sessionId, 'sess-DEAD', 'the marker is anchored to the dead session (the daemon wrote it, not the session)')
  })
})

test('ACTUADOR (b) — the OBSERVABLE is the durable marker AND the anchored escalation: the act names the session in the delivered frame and the sourceKey embeds it (so the delivery metadata can never collide across incarnations)', async () => {
  await withTempDir(async (stateDir) => {
    const deliveries = []
    await tick(stateDir, {
      nowMs: T0,
      rows: [{ postId: 'builder-x', sessionId: 'sess-WORKER-1', contextWindow: WINDOW, projectedTokens: 900_000 }],
      posts: [{ postId: 'builder-x', sessionId: 's-w', managerId: 'internal-programming-head', retired: false }],
      notifyPost: async (postId, frame, opts) => deliveries.push({ postId, frame, opts })
    })
    assert.equal(deliveries.length, 1, 'exactly ONE escalation for the one acting row')
    assert.equal(deliveries[0].postId, 'internal-programming-head', 'the recipient is the MANAGER (the actor), never the flagged post')
    assert.match(deliveries[0].frame, /sesión viva sess-WORKER-1/, 'the frame NAMES the session — the figure cannot be quoted without its anchor')
    assert.equal(deliveries[0].opts.sourceKey, 'context-action:builder-x:sess-WORKER-1', 'the sourceKey embeds the SESSION (the fb-1091 anchoring rule applied to the delivery metadata)')
    const ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].escalatedTo, 'internal-programming-head', 'the marker records WHERE it escalated — auditable from the file alone')
  })
})

test('ACTUADOR (c) — ANTI-SELF-FEED: the act NEVER addresses the flagged post itself (a manager-less post still gets its MARKER, but no delivery — the monitor never invents an actor)', async () => {
  await withTempDir(async (stateDir) => {
    const deliveries = []
    await tick(stateDir, {
      nowMs: T0,
      rows: [
        { postId: 'selfy', sessionId: 'sess-SELF', contextWindow: WINDOW, projectedTokens: 900_000 },
        { postId: 'orphan', sessionId: 'sess-ORPH', contextWindow: WINDOW, projectedTokens: 900_000 }
      ],
      // 'selfy' names ITSELF as manager (the self-feed shape); 'orphan' has none.
      posts: [{ postId: 'selfy', sessionId: 's', managerId: 'selfy' }, { postId: 'orphan', sessionId: 's2' }],
      notifyPost: async (postId) => deliveries.push(postId)
    })
    assert.deepEqual(deliveries, [], 'NO delivery: neither the self-referencing post nor the manager-less one is addressed (the fb-759 self-loop class, never re-created)')
    const ledger = await readMarker(stateDir)
    assert.deepEqual(Object.keys(ledger).sort(), ['orphan', 'selfy'], 'the ACT still happened — only the DELIVERY was withheld (the marker + the host ALERT carry the fact)')
  })
})

test('ACTUADOR (d) — THE ANCHOR SEMANTICS (the fb-1091 trap, by effect): a finding WITHOUT a session is NEVER acted on; a RE-CROSSING inside the SAME session does NOT re-act; a NEW incarnation DOES', async () => {
  await withTempDir(async (stateDir) => {
    const deliveries = []
    const posts = [{ postId: 'builder-x', sessionId: 's-w', managerId: 'ip-head', retired: false }]
    const run = (dt, sessionId, projected) => tick(stateDir, {
      nowMs: T0 + dt,
      rows: [sessionId === undefined
        ? { postId: 'builder-x', contextWindow: WINDOW, projectedTokens: projected }
        : { postId: 'builder-x', sessionId, contextWindow: WINDOW, projectedTokens: projected }],
      posts,
      notifyPost: async (postId, frame, opts) => deliveries.push({ postId, opts })
    })
    // NOTE ON THE STEPS: the scan's OWN tier latch is INDEPENDENT of this lane
    // (a persistent band is silent by the fb-50 calibration), so the pressure
    // rises MONOTONICALLY here — every step is a genuine UPWARD crossing, which
    // is the only situation where the two mechanisms (the latch and the anchor)
    // could be confused. That separation is the point: the latch decides WHETHER
    // A FINDING exists; the ANCHOR decides WHETHER AN ACT happens.
    // (i) NO sessionId (an older wiring) → the event has NO identity ⇒ NO act.
    await run(0, undefined, 900_000)
    assert.deepEqual(deliveries, [], '(i) a finding without sessionId NEVER acts — without the session the act cannot be anchored, and a mis-anchored act is worse than none')
    let ledger = await readMarker(stateDir).catch(() => ({}))
    assert.deepEqual(Object.keys(ledger), [], '(i) no marker either (the conservative gate)')
    // (ii) a session that produced the crossing → acts.
    await run(60_000, 'sess-WORKER-1', 1_100_000)
    assert.equal(deliveries.length, 1, '(ii) first crossing of the live session acts')
    // (iii) the SAME session, a HIGHER band (a genuine new finding) → the SAME
    // episode ⇒ NO re-act. Without the anchor this would act twice.
    await run(120_000, 'sess-WORKER-1', 1_300_000)
    assert.equal(deliveries.length, 1, '(iii) the same session is ONE episode — never re-acted, even on a fresh upward crossing')
    ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].sessionId, 'sess-WORKER-1', '(iii) the anchor is unchanged')
    // (iv) a FRESH incarnation hitting the wall is a NEW MEASURED FACT ⇒ acts.
    await run(180_000, 'sess-WORKER-2', 1_500_000)
    assert.equal(deliveries.length, 2, '(iv) a NEW incarnation RE-ACTS — rotating and hitting the wall again is TWO facts, not one')
    assert.equal(deliveries[1].opts.sourceKey, 'context-action:builder-x:sess-WORKER-2', '(iv) the new act carries the NEW session anchor')
  })
})

test('ACTUADOR (a4) — THE TIER ESCALATION on ONE anchor: advisory (b9, the request still fits) → beyond-window (b10) on the SAME session re-acts, because a DIFFERENT CONSEQUENCE on the same anchor is a NEW fact (and the ledger keeps the escalated tier)', async () => {
  await withTempDir(async (stateDir) => {
    // NOTE: the scan's tier LATCH is keyed per-AGENT (not per-session), so a
    // sequence must climb MONOTONICALLY to produce findings at all — a fresh
    // session starting LOWER than the previous session's latched band is
    // SILENT by the fb-50 hysteresis. That is the scan's own calibration and
    // this lane does not touch it; the test therefore climbs.
    const deliveries = []
    const posts = [{ postId: 'builder-x', sessionId: 's-w', managerId: 'ip-head', retired: false }]
    const run = (dt, projected) => tick(stateDir, {
      nowMs: T0 + dt,
      rows: [{ postId: 'builder-x', sessionId: 'sess-ONE', contextWindow: WINDOW, projectedTokens: projected }],
      posts,
      notifyPost: async (postId, frame, opts) => deliveries.push({ postId, opts })
    })
    await run(0, 702_546) // effective 964690 → b9 → ADVISORY
    assert.equal(deliveries.length, 1, 'b9 acts on the advisory tier (the last rung whose request still fits)')
    let ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].phase, 'advisory', 'the tier is declared')
    assert.equal(ledger['builder-x'].action, 'rotate-before-death', 'this consumer\'s OWN token at b9')
    await run(60_000, 786_433) // effective 1048577 → b10 → BEYOND, SAME session
    assert.equal(deliveries.length, 2, 'the SAME session escalating advisory→beyond-window DOES re-act — the consequence changed')
    ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-x'].phase, 'beyond-usable-window', 'the ledger holds the escalated tier')
    assert.equal(ledger['builder-x'].action, 'compact-or-rotate', 'and now the INSTRUMENT\'s own token (it publishes only at this tier)')
    assert.equal(ledger['builder-x'].sessionId, 'sess-ONE', 'the ANCHOR never moved — one session, two tiers')
  })
})

// ---------------------------------------------------------------------------
// THE REVERT-CHECK (MANDATORY: «sin el actuador, el test FALLA» — DEMONSTRATED,
// never asserted). The check re-runs the SAME observable assertions against a
// tree where the actuator is DISABLED, and requires the test body to FAIL
// there. It is implemented WITHOUT touching the repo file: the daemon tick
// reads the actuator's marker, so pointing the marker path at an
// un-writable location is NOT a valid revert (the marker write would throw and
// the tick swallows it — a FALSE red). The honest revert is the SOURCE: the
// `notifyPost` + marker call-site is the actuator. So this test loads a COPY of
// the module source with the actuator's gate inverted OFF (a mechanical,
// declared textual revert in a TEMP file) and proves the observable is GONE.
// ---------------------------------------------------------------------------
test('ACTUADOR REVERT-CHECK — with the actuator DISABLED the observable DISAPPEARS (the marker is not written and no escalation is delivered), so the tests above are RED without it', async () => {
  const srcPath = path.join(import.meta.dirname, '..', 'packages', 'dshd-health', 'src', 'index.ts')
  const source = await readFile(srcPath, 'utf8')
  // The actuator's entry gate: `if (contextFindings.length > 0) {`. Neutralizing
  // it to `false` is the MINIMAL mechanical revert — the scan, the finding, the
  // host ALERT and the tier latch all keep running, ONLY the consumer is gone.
  const GATE = 'if (contextFindings.length > 0) {'
  const occurrences = source.split(GATE).length - 1
  assert.equal(occurrences, 1, 'the actuator gate is found EXACTLY once (a revert that matches nothing proves nothing)')
  const reverted = source.replace(GATE, 'if (false) {')

  await withTempDir(async (stateDir) => {
    // The reverted copy lives in a TEMP dir (ZERO writes inside the repo — this
    // test file is the lane's only new repo artifact). Node resolves the bare
    // workspace imports (`dshd-core`, `dshd-quality`) by walking UP from the
    // module's dir, so the temp dir gets a `node_modules` SYMLINK to the repo's
    // own tree — the copy then loads exactly like the real source does.
    const revertedPath = path.join(stateDir, 'reverted-index.ts')
    await writeFile(revertedPath, reverted, 'utf8')
    const repoNodeModules = path.join(import.meta.dirname, '..', 'node_modules')
    await symlink(repoNodeModules, path.join(stateDir, 'node_modules'), 'dir')
    const R = await import(pathToFileUrl(revertedPath))

    const deliveries = []
    await R.runHealthDaemonTick({
      now: () => T0,
      stateDir,
      bootId: 'revert-boot',
      hosts: [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }],
      posts: [{ postId: 'builder-x', sessionId: 's-w', managerId: 'ip-head', retired: false }],
      sessionContexts: [{ postId: 'builder-x', sessionId: 'sess-WORKER-1', contextWindow: WINDOW, projectedTokens: 900_000 }],
      config: { health: { contextCompletionReserve: RESERVE } },
      notifyHost: async () => {},
      notifyPost: async (postId, frame, opts) => deliveries.push({ postId, opts }),
      logger: { warn: () => {}, info: () => {} }
    })

    // The monitor still RUNS (the scan, the finding and the host ALERT are
    // untouched — this is what makes the revert HONEST: only the ACT is gone).
    const audit = (await readFile(path.join(stateDir, 'health-alerts.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const finding = audit.at(-1).findings.find((f) => f.kind === 'context-threshold')
    assert.equal(finding.beyondUsableWindow, true, 'the SCAN still publishes the consequence (the instrument is not what was reverted)')
    assert.equal(finding.contextAction, 'compact-or-rotate', 'the scan still NAMES the action')
    // …and the ACT is gone — which is exactly the breach this lane closes.
    assert.deepEqual(deliveries, [], 'REVERT PROOF: with the actuator disabled NOTHING is delivered — the escalation of test (b) is RED without it')
    const markerExists = await readFile(path.join(stateDir, MARKER), 'utf8').then(() => true).catch(() => false)
    assert.equal(markerExists, false, 'REVERT PROOF: with the actuator disabled NO durable marker exists — the observable of test (a) is RED without it')

    // THE LITERAL FAILURE (acceptance c: «sin el actuador, el test FALLA» —
    // DEMONSTRATED). The two assertions that form the acceptance are re-run
    // against the REVERTED module with the SAME inputs as tests (a) and (b):
    // each must THROW on the reverted tree and PASS on the real one. This is the
    // check stated as a check, not as a claim about the check above.
    const acceptA = async (mod) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'actuador-rv-'))
      try {
        await symlink(path.join(import.meta.dirname, '..', 'node_modules'), path.join(dir, 'node_modules'), 'dir')
        await mod.runHealthDaemonTick({
          now: () => T0, stateDir: dir, bootId: 'rv',
          hosts: [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }],
          sessionContexts: [{ postId: 'builder-x', sessionId: 'sess-WORKER-1', contextWindow: WINDOW, projectedTokens: 900_000 }],
          config: { health: { contextCompletionReserve: RESERVE } },
          notifyHost: async () => {}, notifyPost: async () => {},
          logger: { warn: () => {}, info: () => {} }
        })
        const led = JSON.parse(await readFile(path.join(dir, MARKER), 'utf8'))
        assert.equal(led['builder-x'].sessionId, 'sess-WORKER-1', 'acceptance (a): the durable marker names the LIVE SESSION')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    await acceptA(R).then(
      () => assert.fail('REVERT-CHECK FALSE NEGATIVE: the acceptance held on the REVERTED tree — the revert is not real and the test proves nothing'),
      (error) => assert.equal(error.code, 'ENOENT', `REVERT PROOF (literal): with the actuator disabled the acceptance throws (no marker file at all) — measured: ${error.code}`)
    )
    await acceptA(H).then(
      () => {},
      (error) => assert.fail(`the acceptance MUST hold on the REAL module (the check is falsifiable in both directions) — it threw: ${error.message}`)
    )
  })
})

// `pathToFileURL` is needed only by the revert-check's dynamic import; imported
// lazily so the file's top-level stays the plain src-native pattern.
function pathToFileUrl(p) {
  return new URL(`file://${p}`).href
}
