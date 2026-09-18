// dsh-deepartments — LANE «D1: LA DEFERRAL DE CONTEXTO NO SE ARMA CON
// `phase === 'advisory'`» (2026-09-18, run token 1b1ca54c).
//
// THE DEFECT THIS PROVES CLOSED (measured by the IPH, not re-derived here): on
// 2026-09-18 the post `internal-programming-head` held 19 message pairs for
// 2 h 48 min 49,036 s WITH THE HEAD ALIVE. Chain: the health actuator wrote
// `<stateDir>/context-action.json` at 01:10:28.883Z with `phase:'advisory'` and
// `action:'rotate-before-death'` (band b9); the CONTEXT-ADMISSION GATE
// (`packages/dshd-core/src/delivery.ts`, the branch that calls
// `contextAdmissionProbe` and sets `routeOut.deferred = true`) compared the
// marker's `sessionId` against the live session (MATCHED), DEFERRED and SEALED
// `noWake` (`:1043`); the seal made the FIFO gate read the head as `noWake`
// (`skip-nowake-head`) so NO wake was ever armed; and the re-drive sweep SKIPS
// every sealed pair whose recipient is not running (`messages.ts:1983`) — so
// nobody could release them. They drained only when a later UNSEALED landing
// fired the drain, after the head rotated.
//
// WHY THE PHASE IS THE RIGHT DISCRIMINATOR (verified against the actuator's own
// published contract, `packages/dshd-health/src/index.ts:5701-5711`, VERBATIM):
//   - `'advisory'` (band b9, `effective ≥ 90%` while NOT beyond): «the next
//     request STILL FITS but the runway is thin … This is the ONLY tier whose act
//     can still save the session».  ⇒ «already impossible» is FALSE.
//   - `'beyond-usable-window'` (band b10, `effective > contextWindow`): «the
//     next request is ALREADY REJECTED».                    ⇒ it is TRUE.
// The deferral's whole premise is «the next request ALREADY does not fit», so an
// `advisory` deferral is premise-FALSE FROM THE INSTANT IT IS WRITTEN. That is
// why the fix is a PHASE GATE and not a re-evaluation/expiry: no later
// re-evaluation could ever make that premise true.
//
// WHAT THIS FILE ASSERTS — BOTH FACES, so the fix can never be «the legitimate
// class was switched off» (which would be a context-policy failure, not a
// success):
//   (a) `phase:'advisory'`    + MATCHED sessionId ⇒ the delivery PROCEEDS (route
//       reached, 'delivered') and the SIDECAR row does NOT carry `noWake` — the
//       EFFECT control the mission asked for, not the branch;
//   (b) `phase:'beyond-usable-window'` + MATCHED sessionId ⇒ it STILL DEFERS and
//       STILL SEALS (route never reached, 'prepared', sidecar `noWake:true`);
//   (c) THE TWO-TREE PROOF: the SAME record, the SAME catalog, the SAME engine —
//       the marker's PHASE is the ONLY difference between the two outcomes;
//   (d) THE REVERT-CHECK (falsifiable BOTH ways): a TEXTUAL copy of `delivery.ts`
//       with the phase condition neutralized (the PRE-FIX, phase-blind door) is
//       loaded from a TEMP dir — ZERO writes inside the repo — and face (a) MUST
//       THROW there while passing on the real module, while face (b) keeps
//       passing on that same reverted copy (the legitimate class was never the
//       thing being reverted).
//
// EVIDENCE NOTE (measured, given): the ledger `<stateDir>/gate-decisions.jsonl`
// does NOT record this class — `appendGateLedgerRow` is only called on the FIFO
// gate branch. THE EVIDENCE OF THIS FIX IS THE SIDECAR (`deliveries.jsonl`), and
// the sidecar is NOT overwritten on delivery (`markDelivery` = appendFile), so a
// row can be re-measured after the fact. This file asserts on the SIDECAR and
// never on the ledger.
//
// FIXTURE: deterministic fixture ids (never live ids); the REAL
// `createDeliveryEngine` over a TEMP `stateDir` per test (`mkdtemp`) with stub
// deps only — 0 builds, 0 real APIs, and NEVER the daemon's `/.deepartments`.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { deliveryStatus, gatingHeadIsNoWake, markDelivery, parseDeliveryRows, resolveDeliveriesPath } from '../packages/dshd-core/src/messages.ts'
// The engine is imported DYNAMICALLY: the module hook must be registered first
// (a static import is hoisted above it and the src graph fails to link).
const PROD = await import('../packages/dshd-core/src/delivery.ts')

const POST = 'fixture-d1-post'
const SESSION = 'sess-d1-LIVE'
const SENDER = 'sender-head'
const MARKER = 'context-action.json'
const NOW = Date.now()

/** The two tiers of the actuator's marker, verbatim from the house contract. */
const ADVISORY = 'advisory'
const BEYOND = 'beyond-usable-window'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'd1phase-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

function record(id, seq, to, from = SENDER) {
  return { id, seq, ts: 1_000, from, to, text: `msg ${id}`, kind: 'agent' }
}

/** The production-shaped catalog: POST is a live post whose LIVE session is
 * SESSION — the SAME value the marker anchors, i.e. THE MATCHED CASE (the
 * discriminator at `:1159` is `marker.sessionId === liveSessionId`). */
function catalogRoute(recipientId) {
  if (recipientId === POST) return { kind: 'post', entry: { postId: POST, sessionId: SESSION, retired: false, provider: 'head' } }
  return { kind: 'unknown' }
}

/** The actuator's own on-disk shape, verbatim: `{ [agentId]: mark }`. The
 * `action` token is the tier's OWN declared token — `advisory` publishes
 * `rotate-before-death`, `beyond-usable-window` publishes `compact-or-rotate`
 * (`dshd-health` index.ts:5691-5699) — so the fixture can never silently blend
 * the two tiers it exists to separate.
 *
 * `phase === undefined` builds a LEGACY/partial marker with the field ABSENT
 * (the conservative case, guard (b3)): it must behave as the PRE-FIX gate did. */
function markerFor(agentId, phase, sessionId = SESSION, at = NOW - 60_000) {
  const mark = {
    sessionId,
    at,
    action: phase === ADVISORY ? 'rotate-before-death' : 'compact-or-rotate',
    pct: phase === ADVISORY ? 0.92 : 1.0002,
    effectiveTokens: phase === ADVISORY ? 964_000 : 1_048_577,
    contextWindow: 1_048_576
  }
  if (phase !== undefined) mark.phase = phase
  return JSON.stringify({ [agentId]: mark }, null, 2)
}

/** The REAL delivery engine wired like the production bundle (index.ts): the two
 * sidecar marks on the TEMP stateDir, and the wake primitives replaced by stubs
 * that RECORD the route they actually reached (the observable of «materialized»
 * vs «deferred»).
 *
 * ⚠ THE `contextDeferred` SEAM IS AN **OPTS** FIELD, NOT A DEP (measured:
 * `delivery.ts:235` lives inside `DeliverOrQueueOptions`, and the call site is
 * `opts.contextDeferred?.(…)` at `:1434`) — so it is passed per-delivery by the
 * CALLER, never wired in the engine deps. Wiring it into the deps object would
 * silently never fire and would turn every «the observer did not fire»
 * assertion VACUOUS (a false green).
 *
 * `createEngine` is the MODULE's factory (`(deps) => engine`) so the SAME
 * fixture drives the real module and the reverted TEMP copy in (d): the identity
 * of the module is then the only variable of the revert-check. */
function makeEngineWith(stateDir, calls, createEngine) {
  return createEngine({
    stateDir,
    logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
    markPrepared: (rec, recipientId, opts) => markDelivery(stateDir, rec.id, recipientId, 'prepared', Date.now(), opts?.noWake === true),
    markFinal: (rec, recipientId, status, opts) => markDelivery(stateDir, rec.id, recipientId, status, Date.now(), opts?.noWake === true),
    resolveChild: async () => false,
    deliverChild: async () => 'delivered',
    resolveCatalogRoute: catalogRoute,
    busProfileFor: (memberId) => (memberId === SENDER ? { kind: 'head', memberId, departmentId: 'dept' } : { kind: 'unclassified', memberId }),
    // THE MATERIALIZATION OBSERVABLE: reaching the route IS the wake.
    deliverPost: async (entry, framed, rec) => {
      calls.routes.push({ id: rec.id, target: entry.postId })
      await markDelivery(stateDir, rec.id, entry.postId, 'delivered')
      return 'delivered'
    },
    deliverHost: async () => 'failed'
  })
}

/** The SIDECAR row every consumer actually reads: the pair-LATEST of
 * (messageId, recipientId) — the `latestPerKey` view the sweep's P2 guard, the
 * drain and health all read. The seal lives there, never on the write-ahead row. */
function pairLatest(rows, messageId, recipientId) {
  const pair = rows.filter((r) => r.messageId === messageId && r.recipientId === recipientId)
  assert.ok(pair.length >= 2, `the write-ahead + the final mark both landed for ${messageId} → ${recipientId}`)
  return pair.at(-1)
}

/**
 * ONE full delivery run over a FRESH temp tree. `phase` decides the marker's
 * tier and NOTHING else differs between runs: same record, same catalog, same
 * engine. Returns the status, the observed calls, the raw sidecar rows, the
 * pair-LATEST row, and the status re-read through the REAL `deliveryStatus`
 * reader while the tree is still alive (the durability the drain depends on).
 *
 * `createEngine` defaults to the REAL module; (d) passes the reverted copy.
 */
async function runWithPhase(phase, { deliveryId = 'm-400', createEngine = PROD.createDeliveryEngine, sessionId = SESSION } = {}) {
  return await withTempStateDir(async (stateDir) => {
    await writeFile(path.join(stateDir, MARKER), markerFor(POST, phase, sessionId), 'utf8')
    const calls = { informs: [], warns: [], routes: [], deferredReport: [] }
    const engine = makeEngineWith(stateDir, calls, createEngine)
    const rec = record(deliveryId, 400, [POST])
    // `contextDeferred` is an OPTS field (delivery.ts:188/235) — the CALLER's
    // per-delivery observer, passed here exactly as the production send path
    // passes it. It is what makes the DECISION observable independently of the
    // log; the EFFECT is asserted on the sidecar row.
    const status = await engine.deliverOrQueue(POST, rec, { contextDeferred: (info) => { calls.deferredReport.push(info) } })
    let rows = []
    try { rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8')) } catch { rows = [] }
    return {
      status,
      calls,
      rows,
      latest: pairLatest(rows, deliveryId, POST),
      reread: await deliveryStatus(stateDir, deliveryId, POST),
      // The stateDir's own file list, read BEFORE teardown: the DECLARED-evidence
      // test (d2) asserts what the tree does and does NOT contain.
      files: await readdir(stateDir)
    }
  })
}

/** THE ACCEPTANCE, stated once and reused by the revert-check BOTH ways. */
async function faceAdvisory(options = {}) {
  const r = await runWithPhase(ADVISORY, { deliveryId: 'm-400', ...options })
  assert.equal(r.status, 'delivered', '(a) ADVISORY: the delivery PROCEEDS — the turn is materialized into a session that CAN still serve it')
  assert.deepEqual(r.calls.routes, [{ id: 'm-400', target: POST }], '(a) ADVISORY: the route (the materialization) WAS reached')
  assert.equal(r.latest.status, 'delivered', '(a) ADVISORY: the pair-latest landed')
  return r
}

async function faceBeyond(options = {}) {
  const r = await runWithPhase(BEYOND, { deliveryId: 'm-400', ...options })
  assert.equal(r.status, 'prepared', '(b) BEYOND-WINDOW: the turn is QUEUED — the legitimate deferral is NOT broken')
  assert.deepEqual(r.calls.routes, [], '(b) BEYOND-WINDOW: the route was NEVER reached (nothing was materialized into an impossible session)')
  return r
}

// ---------------------------------------------------------------------------
// (a) FACE ONE — `advisory` ⇒ PROCEEDS, and the SIDECAR row is NOT sealed.
//     This is the D1 incident class: the tier whose next request STILL FITS.
// ---------------------------------------------------------------------------
test('D1 FACE (a): `phase:\'advisory\'` + MATCHED marker session ⇒ the delivery PROCEEDS and the sidecar row does NOT carry `noWake` (the seal is what left 19 pairs with NO waker)', async () => {
  const r = await faceAdvisory()

  // THE EFFECT CONTROL (the mission's requested proof of EFFECT, not of branch):
  // the row the sweep/drain/health read must be UNSEALED. A sealed row here is
  // exactly the D1 class — it makes the FIFO gate read `noWake`
  // (`skip-nowake-head`, no wake armed) while the re-drive sweep skips every
  // sealed pair of a non-running recipient (`messages.ts:1983`).
  assert.equal(r.latest.noWake, undefined, '(a) THE EFFECT: the pair-latest carries NO `noWake` seal — the D1 waker-starvation class is structurally closed for this tier')
  const pair = r.rows.filter((row) => row.messageId === 'm-400' && row.recipientId === POST)
  assert.equal(pair[0].noWake, undefined, '(a) the write-ahead row is unsealed too (no seal anywhere on the pair)')
  assert.equal(r.reread, 'delivered', '(a) the pair reads back `delivered` through the REAL `deliveryStatus` reader (a landed pair, not a parked one)')
  // The DECISION seam did NOT fire: no defer was decided, so the send surface
  // never tells the sender its message was parked.
  assert.deepEqual(r.calls.deferredReport, [], '(a) the contextDeferred observer NEVER fired — no deferral was decided')
  assert.equal(r.calls.warns.some((l) => /context-admission gate: DEFERRING/.test(l)), false, '(a) NO deferral was logged')
  // The pass-through is OBSERVABLE in the log — the ledger does NOT record this
  // class (`appendGateLedgerRow` is FIFO-gate-only), so the log is where the
  // DECISION is traceable; the EFFECT is the sidecar row asserted above.
  assert.ok(r.calls.informs.some((l) => /context-admission gate: NOT DEFERRING/.test(l)), '(a) the pass-through is traceable in the log (observability — NOT the acceptance)')
  assert.ok(r.calls.informs.some((l) => /advisory/.test(l)), '(a) and the log names the tier that decided it')
})

// ---------------------------------------------------------------------------
// (a2) THE D1 EPISODE, REPLAYED END TO END — THE CAUSAL LINK IS MEASURED, not
//      narrated. The incident's chain was: the deferral seals `noWake`
//      (`delivery.ts:1043`) ⇒ the FIFO gate reads the retained pair as a noWake
//      HEAD (`gatingHeadIsNoWake`, `messages.ts:812`) ⇒ `skip-nowake-head` ⇒ NO
//      wake is armed ⇒ the sealed-pair sweep skip (`messages.ts:1983`) leaves
//      nobody to release it.
//
//      This test walks that seam with the REAL production predicate: after the
//      delivery of the pair, it asks the FIFO gate what it would read about that
//      pair as the GATING HEAD of a later message. The two tiers must give the
//      two DIFFERENT answers the incident's chain requires.
// ---------------------------------------------------------------------------
test('D1 REPLAY (a2): THE CAUSAL LINK — under `advisory` the pair is not even a `noWake` gating head (the waker-starvation class cannot form); under `beyond-usable-window` it IS one (the skip class, measured with the REAL FIFO predicate)', async () => {
  // The REAL predicate the gate calls (messages.ts:812) — never a re-implementation.
  /** What the FIFO gate reads about the pair of seq 400 when a LATER message
   * (seq 401) for the same recipient arrives: the exact call site that decided
   * `skip-nowake-head` in the incident. `undefined` = there is no pending gating
   * head at all (nothing to skip past); `true` = a noWake head (NO wake armed). */
  const asGatingHead = (rows) => gatingHeadIsNoWake(rows, () => [400], POST, 401)

  const advisory = await faceAdvisory()
  const beyond = await faceBeyond()

  // The D1 EPISODE CANNOT FORM ANY MORE: under `advisory` the pair LANDED, so it
  // is not a pending head at all — the gate has nothing to skip and the waker
  // starvation chain (seal ⇒ skip ⇒ sweep-skip ⇒ no waker) has no first link.
  assert.equal(asGatingHead(advisory.rows), undefined, '(a2) ADVISORY: the pair is NOT a pending gating head (it landed) — the incident\'s `skip-nowake-head` can never form')
  assert.equal(advisory.latest.noWake, undefined, '(a2) ADVISORY: and no seal exists to be read as a noWake head')

  // THE LEGITIMATE CLASS KEEPS ITS MEASURED SHAPE: the beyond-window deferral IS
  // a noWake gating head — the exact row state the FIFO gate reads as
  // `skip-nowake-head`. This is the behavior the fix must NOT touch, asserted
  // through the production predicate rather than described.
  assert.equal(asGatingHead(beyond.rows), true, '(a2) BEYOND-WINDOW: the retained pair IS a noWake gating head (unchanged legitimate behavior — the skip class is intact where it is correct)')
  assert.equal(beyond.latest.noWake, true, '(a2) BEYOND-WINDOW: the seal that produces that reading is intact')
})

// ---------------------------------------------------------------------------
// (b) FACE TWO — `beyond-usable-window` ⇒ STILL DEFERS and STILL SEALS.
//     This face exists so the fix can never be «the legitimate class was turned
//     off»: that would be a CONTEXT-POLICY failure, not a success.
// ---------------------------------------------------------------------------
test('D1 FACE (b): `phase:\'beyond-usable-window\'` + MATCHED marker session ⇒ SÍ difiere y SÍ sella — the legitimate deferral and its `noWake` intent seal are INTACT', async () => {
  const r = await faceBeyond()

  assert.equal(r.latest.status, 'prepared', '(b) the pair-latest is the queued `prepared`')
  assert.equal(r.latest.noWake, true, '(b) THE EFFECT: the pair-latest carries the `noWake` intent seal — without it the ~10-min prepared-stuck sweep treats the row as CRASH-CLASS and re-drives it into the same impossible session every pass (the fb-150 spool class)')
  const pair = r.rows.filter((row) => row.messageId === 'm-400' && row.recipientId === POST)
  assert.equal(pair[0].noWake, undefined, '(b) the write-ahead row stays unsealed (the deferral is decided AFTER the route — the pair-LATEST is what every consumer reads)')
  assert.equal(r.reread, 'prepared', '(b) the pair stays durable and re-readable (`deliveryStatus` over the real sidecar) — it drains at the recipient\'s next real wake')
  assert.equal(r.calls.deferredReport.length, 1, '(b) the contextDeferred observer fired EXACTLY once (the sender still learns the message was parked)')
  assert.equal(r.calls.deferredReport[0].phase, BEYOND, '(b) and it reports the tier it acted on')
  assert.equal(r.calls.deferredReport[0].sessionId, SESSION, '(b) anchored to the LIVE session the marker named')
  assert.equal(r.calls.deferredReport[0].action, 'compact-or-rotate', '(b) carrying the beyond-window tier\'s own token')
  assert.ok(r.calls.warns.some((l) => /context-admission gate: DEFERRING materialization/.test(l)), '(b) the deferral is traceable in the log')
})

// ---------------------------------------------------------------------------
// (b2) THE SUCCESSOR CASE IS UNTOUCHED (the guard the fix must NOT weaken): a
//      marker naming a DIFFERENT session (`sessionId` comparison at `:1159`)
//      still does not defer — in EITHER tier. A phase gate must never grow into
//      a session-blind gate.
// ---------------------------------------------------------------------------
test('D1 GUARD (b2): a marker whose `sessionId` does NOT match the live session is NOT deferred in EITHER tier — the phase gate never replaces the session comparison', async () => {
  for (const phase of [ADVISORY, BEYOND]) {
    const r = await runWithPhase(phase, { deliveryId: 'm-420', sessionId: 'sess-ROTATED-OLD' })
    assert.equal(r.status, 'delivered', `${phase}: the ROTATED marker defers NOTHING — the live successor is woken`)
    assert.deepEqual(r.calls.routes, [{ id: 'm-420', target: POST }], `${phase}: the route WAS reached`)
    assert.equal(r.latest.noWake, undefined, `${phase}: and no seal was applied`)
    assert.deepEqual(r.calls.deferredReport, [], `${phase}: no defer was reported`)
  }
})

// ---------------------------------------------------------------------------
// (b3) THE CONSERVATIVE DIRECTION — a LEGACY/partial marker with NO `phase`
//      must keep the PRE-FIX behavior (DEFER). The probe grades an absent phase
//      as `beyond-usable-window` (`delivery.ts:1165`), so this fix can never
//      turn a «cannot serve» marker into a materialization into a dead session.
//      Measured, not assumed: the phase gate is read off the PROBE'S RETURN,
//      which is exactly where that defaulting happens.
// ---------------------------------------------------------------------------
test('D1 GUARD (b3): a LEGACY marker with NO `phase` field STILL DEFERS and STILL SEALS — the fail-open default keeps the pre-fix behavior (no «cannot serve» marker is ever downgraded to a materialization)', async () => {
  const r = await runWithPhase(undefined, { deliveryId: 'm-430' })
  assert.equal(r.status, 'prepared', 'a phase-less marker still defers (the probe defaults the tier to `beyond-usable-window`)')
  assert.deepEqual(r.calls.routes, [], 'the route was NEVER reached — the conservative direction is preserved')
  assert.equal(r.latest.noWake, true, 'and the `noWake` seal is intact (no crash-class row)')
  assert.equal(r.calls.deferredReport.length, 1, 'the defer was reported')
  assert.equal(r.calls.deferredReport[0].phase, BEYOND, 'and the reported tier is the probe\'s own conservative default')
})

// ---------------------------------------------------------------------------
// (c) THE TWO-TREE PROOF — the SAME record, the SAME catalog, the SAME engine:
//     the marker's PHASE is the ONLY difference between «materialized» and
//     «queued», and between «unsealed» and «sealed».
// ---------------------------------------------------------------------------
test('D1 TWO-TREE: the SAME delivery with the SAME matched session — ONLY the phase differs (`advisory` ⇒ materialized + unsealed, `beyond-usable-window` ⇒ queued + sealed)', async () => {
  const advisory = await runWithPhase(ADVISORY, { deliveryId: 'm-410' })
  const beyond = await runWithPhase(BEYOND, { deliveryId: 'm-410' })

  assert.equal(advisory.status, 'delivered', 'advisory: delivered')
  assert.equal(beyond.status, 'prepared', 'beyond-window: prepared')
  assert.deepEqual(advisory.calls.routes, [{ id: 'm-410', target: POST }], 'advisory: the route WAS reached')
  assert.deepEqual(beyond.calls.routes, [], 'beyond-window: the route was NEVER reached')
  assert.equal(advisory.latest.noWake, undefined, 'advisory: the sidecar row is UNSEALED')
  assert.equal(beyond.latest.noWake, true, 'beyond-window: the sidecar row IS sealed')
  assert.notEqual(advisory.status, beyond.status, 'the two trees DIVERGE on the phase alone — that divergence IS the fix')
})

// ---------------------------------------------------------------------------
// (d2) DECLARED EVIDENCE — the IPH's criterion message, encoded as EXECUTED
//      assertions instead of prose (criterion, not scope: the two faces above
//      are untouched).
//
//      (1) THE LEDGER DOES NOT SEE THIS CLASS. Measured by the QD's inspector:
//          of 21 pairs carrying a defer signature, only 12 have a row in
//          `<stateDir>/gate-decisions.jsonl` ⇒ 9 are INVISIBLE there. The
//          ledger records the class only BY COINCIDENCE (when the pair ALSO
//          crossed the FIFO gate). ⇒ THE PRIMARY EVIDENCE IS THE SIDECAR,
//          `deliveries.jsonl` (`markDelivery` = appendFile, so a row can be
//          re-measured after delivery). Asserted here: the ledger file is
//          ABSENT in this fixture's tree for BOTH faces, while the sidecar is
//          present and carries the outcome.
//
//      (2) NO TRUTHINESS ON THE LEDGER'S STRING-SERIALIZED FIELDS. In the FIFO
//          gate's ledger row, `materialized`/`runningLive` are written as
//          `String(…)` (`delivery.ts:751-752`) and `headNoWake` as a token
//          STRING (`:761`) — so `"false"` is TRUTHY and `if (row.materialized)`
//          reads it as TRUE. MEASURED here: the SIDECAR's `noWake` is NOT that
//          trap — it is a REAL JSON BOOLEAN (`typeof 'boolean'`), so the
//          literal comparisons used throughout this file (`=== true` /
//          `=== undefined`) are the correct ones. Asserting the TYPE pins it.
// ---------------------------------------------------------------------------
test('D1 DECLARED EVIDENCE (d2): the SIDECAR is the primary evidence (the ledger does NOT record this class) and the sidecar `noWake` is a REAL BOOLEAN — never the ledger\'s truthy `"false"` string', async () => {
  const advisory = await runWithPhase(ADVISORY, { deliveryId: 'm-440' })
  const beyond = await runWithPhase(BEYOND, { deliveryId: 'm-440' })

  // (1) THE SIDECAR IS THE EVIDENCE, AND THE LEDGER IS SILENT FOR THIS CLASS.
  for (const [label, r] of [['advisory', advisory], ['beyond-usable-window', beyond]]) {
    assert.ok(r.files.includes('deliveries.jsonl'), `(d2/${label}) the SIDECAR is present and is the evidence`)
    assert.equal(r.files.includes('gate-decisions.jsonl'), false, `(d2/${label}) the ledger <stateDir>/gate-decisions.jsonl is ABSENT — the class is INVISIBLE there unless the pair ALSO crossed the FIFO gate (never measured here)`)
  }

  // (2) THE TYPE PIN — the sidecar's seal is a real boolean, not a string.
  assert.equal(typeof beyond.latest.noWake, 'boolean', '(d2) the sidecar `noWake` of the deferred pair is a REAL JSON BOOLEAN (the ledger\'s String(…) trap at delivery.ts:751-752/:761 does NOT apply to the sidecar)')
  assert.equal(beyond.latest.noWake, true, '(d2) and it is `true` by strict equality — a `"true"` STRING would fail this assertion (assert/strict)')
  assert.equal(typeof advisory.latest.noWake, 'undefined', '(d2) the advisory pair has the field ABSENT (not false, not "undefined"): `undefined`, so the strict `=== undefined` comparison used in the faces above is the meaningful one')
  // The truthiness trap, demonstrated on the value this lane reads: it is NOT
  // the ledger's string, so truthiness happens to agree here — but the file
  // still compares literals, never truthiness, so the agreement is not relied on.
  assert.equal(Boolean(beyond.latest.noWake), true, '(d2) truthiness agrees for the sidecar BOOLEAN — yet this file still compares LITERALS, so correctness never rests on truthiness')
})
// ---------------------------------------------------------------------------
// (d) THE REVERT-CHECK — falsifiable in BOTH directions, DEMONSTRATED.
//     The phase condition is neutralized in a TEXTUAL copy of the module held in
//     a TEMP dir (ZERO writes inside the repo): `deferred.phase !== '…'` →
//     `false` restores the PRE-FIX, PHASE-BLIND door — the code that produced
//     the 19 stranded pairs. Face (a) MUST throw there while passing on the real
//     module; face (b) must keep passing on that SAME reverted copy, which is
//     what proves the revert removed the NEW gate and not the deferral itself.
// ---------------------------------------------------------------------------
test('D1 REVERT-CHECK: with the phase condition neutralized (the PRE-FIX phase-blind door) FACE (a) THROWS and FACE (b) still PASSES — while BOTH hold on the REAL module', async () => {
  const srcDir = path.join(import.meta.dirname, '..', 'packages', 'dshd-core', 'src')
  const source = await readFile(path.join(srcDir, 'delivery.ts'), 'utf8')

  const PHASE_DOOR = "deferred.phase !== 'beyond-usable-window'"
  const occurrences = source.split(PHASE_DOOR).length - 1
  assert.equal(occurrences, 1, 'the phase condition is found EXACTLY once (a revert that matches nothing proves nothing)')
  const reverted = source.replace(PHASE_DOOR, 'false')
  assert.notEqual(reverted, source, 'the revert actually changed the source (the door is back to the phase-blind `if (false)`)')

  await withTempStateDir(async (tmp) => {
    // The reverted copy lives in a TEMP dir; its relative sibling imports are
    // retargeted at the REPO src so ONLY the phase condition differs (the copy
    // links against the REAL modules — zero writes inside the repo).
    const specRe = new RegExp('(from\\s+[\'"])(\\.\\/[a-z-]+)(\\.js)([\'"])', 'g')
    const retargeted = reverted.replace(specRe, (_m, a, rel, _js, z) => `${a}${path.join(srcDir, rel.slice(2) + '.ts')}${z}`)
    assert.notEqual(retargeted, reverted, 'the relative sibling imports were retargeted to the repo src (the real modules)')
    const revertedPath = path.join(tmp, 'reverted-d1-delivery.ts')
    await writeFile(revertedPath, retargeted, 'utf8')
    const REV = await import(pathToFileURL(revertedPath).href)
    assert.equal(typeof REV.createDeliveryEngine, 'function', 'the reverted copy exposes the engine factory (a load failure here would make this revert-check vacuous)')

    // (1) The REAL module: BOTH faces hold.
    await faceAdvisory()
    await faceBeyond()

    // (2) The REVERTED (phase-blind) module: face (a) MUST fail — and fail on the
    //     D1 observable (the deferral is back for `advisory`), never on an
    //     unrelated load error.
    let caught
    try {
      await faceAdvisory({ createEngine: REV.createDeliveryEngine })
    } catch (error) {
      caught = error
    }
    assert.ok(caught !== undefined, 'REVERT PROOF: FACE (a) MUST fail on the phase-blind tree — it held, so the revert is not real and this test proves nothing')
    assert.equal(caught.code, 'ERR_ASSERTION', `REVERT PROOF: the failure is the ACCEPTANCE assertion (the deferral is back for advisory), not a load error — measured: ${caught.code ?? caught.message}`)

    // (3) ...and on that SAME reverted copy the legitimate class STILL defers:
    //     the revert removes the NEW phase gate, never the deferral mechanism —
    //     which is what makes face (b) a genuine control.
    await faceBeyond({ createEngine: REV.createDeliveryEngine })
  })
})
