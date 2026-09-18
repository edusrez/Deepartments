// fb-1895 (run token fd49c834) — «QUE EL CRUCE DEL UMBRAL DE CONTEXTO DEL PROPIO
// HOST PRODUZCA EL AVISO».
//
// THE MEASURED HOLE (by execution over the real source, this lane's probe):
// a HOST-subject crossing DOES write the durable marker with the advisory token
// `rotate-before-death` — and NOTHING ELSE HAPPENS. The token has exactly ONE
// producer (`planContextActions`) and reaches a frame through exactly ONE call
// (`buildContextActionFrame`, invoked ONLY on the `notifyPost` escalation to the
// post's MANAGER). That escalation needs a manager, and `managerByPost` is built
// exclusively from `deps.posts` (`postId → managerId`). A subject with no
// `managerId` ALWAYS resolves `no-actor` ⇒ NO delivery. MEASURED subject classes
// that are manager-less: the HOST (a `{ hostId }` row — no postId), every HEAD,
// and a self-referential manager. The ONLY class that ever receives the
// escalation is a WORKER WITH A MANAGER.
// ⇒ For the host's own crossing the token lived in the marker file and in NO
// frame any actor read: the host received an ALERT bullet carrying the threshold
// figure and NOT the action. It had to decide BLIND — the reported symptom.
//
// THE FIX (fb-1895): the ACTOR is named in the frame that ACTUALLY REACHES IT.
// The host ALERT already addresses the live host on EVERY tick; the
// `context-threshold` bullet now APPENDS the actuator's action notice, derived
// from the SAME published frame and the SAME constants (never a second literal,
// never a re-derived tier).
//
// WHAT IS PROVEN HERE, BY OBSERVABLE EFFECT OF THE REAL TICK (never by reasoning):
//   (1) THE ACCEPTANCE — the HOST's own crossing at the ADVISORY rung produces a
//       frame the host RECEIVES that NAMES `rotate-before-death`;
//   (2) the beyond-window rung names the INSTRUMENT's own token verbatim;
//   (3) a row BELOW the acting rungs renders BYTE-IDENTICAL (additive, R6);
//   (4) the frozen `error` literal is untouched on every rung;
//   (5) a HEAD (also manager-less) is covered by the SAME channel;
//   (6) CONTROL: a WORKER WITH A MANAGER still gets its `notifyPost` escalation —
//       the fix adds a channel, it does not replace the working one.
//
// METHOD: `packages/dshd-health/src/index.ts` has ZERO relative imports, so Node's
// native type-stripping loads the CURRENT SOURCE directly — NO build, and
// `packages/dshd-health/lib/` is untouched. Every run is a hermetic temp stateDir
// (the LIVE store `/.deepartments` and the running service are NEVER touched).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const H = await import('../packages/dshd-health/src/index.ts')

const WINDOW = 1_048_576
const RESERVE = 262_144
const T0 = new Date(2026, 8, 17, 22, 0, 0).getTime()
const MARKER = 'context-action.json'

const HOST_ID = 'host-session-aaaaaaaa-1111-2222-3333-444444444444'
const HOST_SESSION = 'session-aaaaaaaa-1111-2222-3333-444444444444'

/** effective = projected + RESERVE; b9 = the advisory rung (the LAST one that
 * fits), b10 = `effective > WINDOW` (the next request is ALREADY rejected). */
const ADVISORY = Math.round(0.92 * WINDOW) - RESERVE // → 964690/1048576 = 92%
const BELOW = Math.round(0.85 * WINDOW) - RESERVE //    → 891290/1048576 = 85% (b8)
const BEYOND = WINDOW - RESERVE + 1 //                  → 1048577 > window (b10)

/** ONE hermetic tick whose SUBJECT is a host row (`hostId`, no postId — exactly
 * what `buildSessionContexts` publishes for a `hosts.json` entry). */
async function tick(stateDir, { nowMs, rows, posts, notifyPost, notifyHost, warn }) {
  await H.runHealthDaemonTick({
    now: () => nowMs,
    stateDir,
    bootId: 'fb1895-boot',
    hosts: [{ hostId: HOST_ID, sessionId: HOST_SESSION, roomId: 'board' }],
    ...(posts !== undefined ? { posts } : {}),
    sessionContexts: rows,
    config: { health: { contextCompletionReserve: RESERVE } },
    notifyHost: notifyHost ?? (async () => {}),
    ...(notifyPost !== undefined ? { notifyPost } : {}),
    logger: { warn: warn ?? (() => {}), info: () => {} }
  })
}

async function readMarker(stateDir) {
  return JSON.parse(await readFile(path.join(stateDir, MARKER), 'utf8'))
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb1895-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Run ONE tick for a host-subject row and return what the host RECEIVED.
 * `notifyPost` is wired BY DEFAULT (a recording no-op): the escalation block —
 * and therefore the `no-actor` BOOKKEEPING the marker records — only runs when
 * the seam is present, and the point of these tests is the SUBJECT (a host),
 * never an unwired composition. */
async function hostTickFor(stateDir, projected, { nowMs = T0, posts, notifyPost } = {}) {
  const alerts = []
  await tick(stateDir, {
    nowMs,
    rows: [{ hostId: HOST_ID, sessionId: HOST_SESSION, contextWindow: WINDOW, projectedTokens: projected }],
    // A manager-bearing post is present so `managerByPost` is NON-EMPTY: the
    // host's `no-actor` outcome is therefore NOT an artifact of an empty catalog.
    posts: posts ?? [{ postId: 'some-worker', sessionId: 's-w', managerId: 'some-head', retired: false }],
    notifyHost: async (live, frame, key) => alerts.push({ to: live?.hostId, frame, key }),
    notifyPost: notifyPost ?? (async () => {})
  })
  return alerts
}

// ---------------------------------------------------------------------------
// (1) THE ACCEPTANCE — the host's own advisory crossing produces the notice IT
//     receives. THIS is the mission's acceptance criterion, as an executable
//     check: the frame that reached the host NAMES `rotate-before-death`.
// ---------------------------------------------------------------------------
test('fb-1895 (1) ACCEPTANCE: the HOST\'s OWN context-threshold crossing produces the `rotate-before-death` notice in the frame the host RECEIVES (today it receives the figure and NO action)', async () => {
  await withTempDir(async (stateDir) => {
    const alerts = await hostTickFor(stateDir, ADVISORY)
    assert.equal(alerts.length, 1, 'the host receives exactly ONE ALERT frame for its own crossing')
    assert.equal(alerts[0].to, HOST_ID, 'and it is ADDRESSED to the host — its own row is the subject')
    assert.match(alerts[0].frame, /rotate-before-death/, 'THE ACCEPTANCE: the frame names the actuator\'s ADVISORY token — the host is no longer deciding blind')
    assert.equal(alerts[0].key, `context-threshold:${HOST_ID}:b9`, 'the trigger identity is the host row\'s own dedupe key (b9)')
    // The durable marker and the frame AGREE — two observables, one act.
    const ledger = await readMarker(stateDir)
    assert.equal(ledger[HOST_ID].action, 'rotate-before-death', 'the marker carries the same token')
    assert.equal(ledger[HOST_ID].phase, 'advisory', 'and the same tier')
    assert.equal(ledger[HOST_ID].escalation, 'no-actor', 'the marker still records HONESTLY that no manager resolved for a host subject')
  })
})

// ---------------------------------------------------------------------------
// (2) The beyond-window rung names the INSTRUMENT's own token, verbatim.
// ---------------------------------------------------------------------------
test('fb-1895 (2) the BEYOND-WINDOW rung: the frame names the INSTRUMENT\'s own token (`compact-or-rotate`) — consumed verbatim, never blended with the advisory one', async () => {
  await withTempDir(async (stateDir) => {
    // A FRESH agent, so the scan's per-agent tier latch cannot swallow the row.
    const alerts = []
    await tick(stateDir, {
      nowMs: T0,
      rows: [{ hostId: HOST_ID, sessionId: HOST_SESSION, contextWindow: WINDOW, projectedTokens: BEYOND }],
      notifyHost: async (live, frame, key) => alerts.push({ frame, key })
    })
    assert.equal(alerts.length, 1, 'one ALERT frame')
    assert.match(alerts[0].frame, /compact-or-rotate/, 'the beyond-window notice consumes the instrument\'s OWN token verbatim')
    assert.ok(!alerts[0].frame.includes('rotate-before-death'), 'the two tiers are NEVER blended: at b10 the request is already rejected, so claiming «still fits» would be the fb-967 class')
    const ledger = await readMarker(stateDir)
    assert.equal(ledger[HOST_ID].action, 'compact-or-rotate', 'and the marker agrees')
  })
})

// ---------------------------------------------------------------------------
// (3) ADDITIVE (R6): a row BELOW the acting rungs renders NO action notice —
//     its frozen `error` literal is intact and no ACCIÓN is fabricated.
//
//     ⚠️ AMENDED 2026-09-17 (builder-432 / cabf519f — ANCLA DE SESIÓN). This
//     assertion pinned the WHOLE bullet byte-identical, because at the time the
//     bullet's ONLY possible addition was the action notice. The session anchor
//     (`[session <id> (HH:MMZ)]`) is a SECOND, INDEPENDENT additive suffix that
//     applies to every rung — its purpose is provenance, not action — so the
//     whole-bullet equality had to move. The GATE THIS TEST EXISTS FOR is
//     PRESERVED EXACTLY and is still asserted twice: the frozen `error` literal
//     is a byte-intact PREFIX and `ACCIÓN` is absent below the acting rungs.
//     The precedent is fb-466 (commit 69e104a), which added the same class of
//     session anchor to `post-error` and amended the frozen frame assertions of
//     test/invoke.test.js in the SAME commit.
// ---------------------------------------------------------------------------
test('fb-1895 (3) ADDITIVE: a row with real runway (b8, below the advisory rung) renders NO action notice — the frozen `error` literal stays byte-intact and no ACCIÓN is fabricated (the session anchor is a SECOND, independent additive suffix)', async () => {
  await withTempDir(async (stateDir) => {
    const alerts = await hostTickFor(stateDir, BELOW)
    assert.equal(alerts.length, 1, 'the host still gets its ALERT (the monitor is untouched)')
    const bullet = alerts[0].frame.split('\n').find((l) => l.startsWith('- context-threshold:'))
    // THE FROZEN `error` LITERAL — byte-intact as a PREFIX (never reworded).
    const FROZEN_ERROR = `${HOST_ID} 85% (629146+262144/1048576) — cruce b8`
    assert.ok(
      bullet.startsWith(`- context-threshold: ${FROZEN_ERROR}`),
      'the frozen `error` literal is a byte-intact PREFIX of the bullet (the additions are suffixes only)'
    )
    assert.ok(!alerts[0].frame.includes('ACCIÓN'), 'and no action notice is fabricated for a rung that has runway')
    // The SESSION ANCHOR (builder-432) — the independent second suffix: the
    // alert now says WHICH incarnation the figure came from.
    assert.equal(
      bullet,
      `- context-threshold: ${FROZEN_ERROR} [session ${HOST_SESSION} (${new Date(T0).toISOString().slice(11, 16)}Z)]`,
      'and the bullet names the session that produced the figure (the ANCLA DE SESIÓN, additive)'
    )
  })
})

// ---------------------------------------------------------------------------
// (4) The frozen `error` literal is untouched on EVERY rung — the notice is an
//     appended suffix, never a reword (the fb-50/fb-967 rule).
// ---------------------------------------------------------------------------
test('fb-1895 (4) the frozen `error` literal is byte-identical on every rung — the notice is an APPENDED SUFFIX', async () => {
  const scan = (projected, hostId) => H.scanContextThreshold({
    rows: [{ hostId, sessionId: 'sess-x', contextWindow: WINDOW, projectedTokens: projected }],
    threshold: 0.5,
    completionReserve: RESERVE,
    nowMs: T0
  }).findings[0]

  const b8 = scan(BELOW, 'agent-b8')
  assert.equal(b8.error, 'agent-b8 85% (629146+262144/1048576) — cruce b8', 'the frozen literal, b8')
  const b9 = scan(ADVISORY, 'agent-b9')
  assert.equal(b9.error, 'agent-b9 92% (702546+262144/1048576) — cruce b9', 'the frozen literal, b9 — UNCHANGED by this lane')
  const b10 = scan(BEYOND, 'agent-b10')
  assert.equal(b10.error, 'agent-b10 100% (786433+262144/1048576) — cruce b10', 'the frozen literal, b10')

  // The suffix is what carries the action — and ONLY on an acting rung.
  const frameOf = (f) => H.buildHealthAlertFrame([f])
  assert.match(frameOf(b9), /— cruce b9 ⇒ ACCIÓN rotate-before-death/, 'the b9 bullet keeps the frozen literal AND appends the notice')
  assert.match(frameOf(b10), /— cruce b10 ⇒ ACCIÓN compact-or-rotate/, 'the b10 bullet keeps the frozen literal AND appends the instrument\'s token')
  assert.ok(!frameOf(b8).includes('⇒ ACCIÓN'), 'b8 has runway → no notice')
})

// ---------------------------------------------------------------------------
// (5) A HEAD — also manager-less — is covered by the SAME channel. The mission
//     assumed the notice «works for the heads»; by execution it does NOT (a head
//     resolves `no-actor` exactly like the host). The fix covers both.
// ---------------------------------------------------------------------------
test('fb-1895 (5) a HEAD (also manager-less, also `no-actor`) is covered by the SAME ALERT channel', async () => {
  await withTempDir(async (stateDir) => {
    const alerts = []
    await tick(stateDir, {
      nowMs: T0,
      rows: [{ postId: 'some-head', sessionId: 'head-sess-1', contextWindow: WINDOW, projectedTokens: ADVISORY }],
      posts: [{ postId: 'some-head', sessionId: 'head-sess-1', retired: false }], // NO managerId → a HEAD
      notifyHost: async (live, frame, key) => alerts.push({ frame, key }),
      notifyPost: async () => {}
    })
    assert.equal(alerts.length, 1, 'the head\'s crossing reaches the host ALERT (its own actor-less outcome is unchanged)')
    assert.match(alerts[0].frame, /rotate-before-death/, 'and the frame now names the action for the HEAD too')
    // The marker still tells the truth about the missing actor.
    const ledger = await readMarker(stateDir)
    assert.equal(ledger['some-head'].escalation, 'no-actor', 'a head resolves no manager — recorded honestly, as before')
  })
})

// ---------------------------------------------------------------------------
// (6) CONTROL — the WORKER WITH A MANAGER still receives its `notifyPost`
//     escalation. Without this control the suite could not tell «a new channel
//     was added» from «the working channel was replaced / broken».
// ---------------------------------------------------------------------------
test('fb-1895 (6) CONTROL: a WORKER WITH A MANAGER still gets its `notifyPost` escalation with the full context-action frame (the fix ADDS a channel, it never replaces the working one)', async () => {
  await withTempDir(async (stateDir) => {
    const deliveries = []
    await tick(stateDir, {
      nowMs: T0,
      rows: [{ postId: 'builder-control', sessionId: 'sess-control', contextWindow: WINDOW, projectedTokens: ADVISORY }],
      posts: [{ postId: 'builder-control', sessionId: 's-control', managerId: 'internal-programming-head', retired: false }],
      notifyHost: async () => {},
      notifyPost: async (id, frame, opts) => deliveries.push({ id, frame, opts })
    })
    assert.equal(deliveries.length, 1, 'the manager escalation is delivered exactly once — UNCHANGED by this lane')
    assert.equal(deliveries[0].id, 'internal-programming-head', 'to the MANAGER, never to the flagged post (the anti-self-feed rule intact)')
    assert.match(deliveries[0].frame, /context-action \(advisory\)/, 'and it is the full actuator frame (the tier is declared)')
    assert.match(deliveries[0].frame, /rotate-before-death/, 'carrying the advisory token')
    assert.equal(deliveries[0].opts.sourceKey, 'context-action:builder-control:sess-control', 'with the session-embedding sourceKey intact')
    const ledger = await readMarker(stateDir)
    assert.equal(ledger['builder-control'].escalation, 'delivered', 'and the marker records the delivered escalation')
  })
})

// ---------------------------------------------------------------------------
// (7) THE REVERT-CHECK (the house rule: a unit is closed by EXECUTION, and a
//     guard that cannot go red proves nothing). Neutralizing the notice — a
//     TEXTUAL revert in a TEMP dir, ZERO writes inside the repo — must make the
//     acceptance of (1) FAIL there and PASS here.
// ---------------------------------------------------------------------------
test('fb-1895 (7) REVERT-CHECK: with the notice neutralized the acceptance of (1) is RED — demonstrated, not asserted', async () => {
  const { symlink, writeFile } = await import('node:fs/promises')
  const srcPath = path.join(import.meta.dirname, '..', 'packages', 'dshd-health', 'src', 'index.ts')
  const source = await readFile(srcPath, 'utf8')
  // THE GATE OF THIS LANE: the notice's call site in the context-threshold bullet.
  const GATE = '${notice ?? \'\'}'
  const occurrences = source.split(GATE).length - 1
  assert.equal(occurrences, 1, 'the notice gate is found EXACTLY once (a revert that matches nothing proves nothing)')
  const reverted = source.replace(GATE, '')

  /** THE ACCEPTANCE, as a function of the module under test: the frame the host
   * receives for its OWN advisory crossing must name the action. */
  const acceptHostNotice = async (mod) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fb1895-rev-'))
    try {
      await symlink(path.join(import.meta.dirname, '..', 'node_modules'), path.join(dir, 'node_modules'), 'dir')
      const alerts = []
      await mod.runHealthDaemonTick({
        now: () => T0,
        stateDir: dir,
        bootId: 'rv',
        hosts: [{ hostId: HOST_ID, sessionId: HOST_SESSION, roomId: 'board' }],
        sessionContexts: [{ hostId: HOST_ID, sessionId: HOST_SESSION, contextWindow: WINDOW, projectedTokens: ADVISORY }],
        config: { health: { contextCompletionReserve: RESERVE } },
        notifyHost: async (live, frame, key) => alerts.push({ frame, key }),
        logger: { warn: () => {}, info: () => {} }
      })
      assert.equal(alerts.length, 1, 'acceptance: the host received its ALERT')
      assert.match(alerts[0].frame, /rotate-before-death/, 'acceptance: the received frame NAMES the action')
      return alerts[0].frame
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  // The reverted copy lives in a TEMP dir (ZERO writes inside the repo) and gets
  // a `node_modules` SYMLINK so the bare workspace imports resolve as they do in
  // the real tree.
  const tmpHome = await mkdtemp(path.join(tmpdir(), 'fb1895-revsrc-'))
  try {
    const revertedPath = path.join(tmpHome, 'reverted-index.ts')
    await writeFile(revertedPath, reverted, 'utf8')
    await symlink(path.join(import.meta.dirname, '..', 'node_modules'), path.join(tmpHome, 'node_modules'), 'dir')
    const R = await import(new URL(`file://${revertedPath}`).href)

    await assert.rejects(
      () => acceptHostNotice(R),
      /the received frame NAMES the action/,
      'REVERT PROOF (literal): on the REVERTED tree the acceptance THROWS — the frame names no action, which is exactly the pre-fb-1895 behavior'
    )
    await acceptHostNotice(H) // must NOT throw — the check is falsifiable in BOTH directions
  } finally {
    await rm(tmpHome, { recursive: true, force: true })
  }
})
