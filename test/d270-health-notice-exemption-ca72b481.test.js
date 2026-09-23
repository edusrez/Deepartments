// dsh-deepartments — D270 (2026-09-23, builder-486 / run token ca72b481):
// THE HEALTH-NOTICE SYSTEM EXEMPTION — and the proof that it is NARROW.
//
// THE DECISION (host, D270 — TAKEN, not re-opened): `from = 'deepartments'` (the
// SYNTHETIC daemon origin that the bundle's health/quality seams append with) is
// ADMITTED **ONLY** for a HEALTH NOTICE that concerns the RECIPIENT'S OWN post
// (`Turn-error` / `Quality inspect` / `post-error` about THAT SAME post id).
// **NEVER for content.** The ACL exists to stop leakage BETWEEN DEPARTMENTS; a
// health notice about a post, addressed to that post, discloses nothing the
// recipient does not already own — and without it the head cannot self-repair
// (it never learns that its own session is erroring).
//
// THE SEAM (MEASURED, cited by `archivo:linea` with the LITERAL — never by
// number). THERE ARE TWO FILES NAMED `delivery.ts`, and they play DIFFERENT
// roles in the denial:
//   - the PREDICATE lives in `packages/dshd-core/src/acl.ts`:
//     `export function aclDenyGround(sender: BusMemberProfile, recipient: BusMemberProfile): string | undefined`
//     — its conservative final branch is `return 'unclassified-sender'`. It takes
//     TWO MEMBER PROFILES and therefore CANNOT SEE THE MESSAGE: an exemption
//     conditioned on the notice's content is NOT expressible in its signature
//     without changing it (and it has 4 consumers).
//   - the seam that EXECUTES the denial is `catalogRoute` in
//     `packages/dshd-core/src/delivery.ts` (`async function catalogRoute(` — it
//     takes `record: MessageRecord`), whose ACL branch computes
//     `aclDenyGround(sender, deps.busProfileFor(recipientId))` and denies with
//     `opts.failedGround?.('acl')` + `return 'failed'`.
//   - `packages/dshd-orchestration/src/delivery.ts` only IMPORTS
//     (`import { busProfileFor as aclBusProfileFor, aclDenyGround as aclDenyGroundImpl, isMutedHostSender } from 'dshd-core'`)
//     and BINDS it (`const aclDenyGround = aclService?.aclDenyGround ?? aclDenyGroundImpl`)
//     — it does not execute `catalogRoute` (which is module-private to dshd-core).
// ⇒ THE EXEMPTION LIVES IN `catalogRoute` (dshd-core), because that is where the
// RECORD is visible AND where the denial is executed.
//
// METHOD (the repo's LANE ② src-native convention, fb-95 / r6-ladder-flat): the
// hook is SELF-REGISTERED and the imports reach `src/`, never the built lib. The
// engine harness is the `fb2160-engine-failed-cause-20e12981.test.js` shape (the
// real `createDeliveryEngine` over a temp stateDir with the REAL `markDelivery`
// sidecar — so the assertions read the ACTUAL ledger rows, not a stub's echo).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

const { createDeliveryEngine } = await import('../packages/dshd-core/src/delivery.ts')
const { aclDenyGround } = await import('../packages/dshd-core/src/acl.ts')
const { markDelivery, parseDeliveryRows, resolveDeliveriesPath } = await import('../packages/dshd-core/src/messages.ts')

const T0 = 1_790_017_160_100 // the lane's anchored instant
const HEAD = 'internal-programming-head'
const OTHER_POST = 'quality-head'

/** The engine harness: the REAL engine + the REAL sidecar writer. `busProfileFor`
 * reproduces the MEASURED classification (`deepartments` → `unclassified`, the
 * catalog members → their kind), so the ACL branch under test is the production
 * one. The route resolver returns a CATALOG POST for the two known ids. */
function engineOver(stateDir, overrides = {}) {
  const marks = []
  const warns = []
  const infos = []
  const engine = createDeliveryEngine({
    stateDir,
    logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
    markPrepared: (record, recipientId, opts) => markDelivery(stateDir, record.id, recipientId, 'prepared', undefined, opts?.noWake),
    markFinal: (record, recipientId, status, opts) => {
      marks.push({ id: record.id, status, opts })
      return markDelivery(stateDir, record.id, recipientId, status, undefined, opts?.noWake, opts?.reason)
    },
    resolveChild: async () => false,
    deliverChild: async () => 'delivered',
    resolveCatalogRoute: (id) => ({ kind: 'post', entry: { postId: id, sessionId: `session-${id}`, provider: 'head' } }),
    // The MEASURED classification of the live catalog.
    busProfileFor: (memberId) => (memberId === 'deepartments'
      ? { kind: 'unclassified', memberId }
      : { kind: 'head', memberId, departmentId: 'internal-programming' }),
    deliverPost: async () => 'delivered',
    deliverHost: async () => 'delivered',
    ...overrides
  })
  return { engine, marks, warns, infos }
}

function record(id, from, to, text) {
  return { id, seq: Number(id.slice(2)), ts: T0, from, to, text, kind: 'agent' }
}

/** The exact frames the production seams append (cited in the header comment of
 * the delivery.ts exemption block) — built with the REAL builders where the
 * package allows, so the test cannot drift from the emitted literal. */
const TURN_ERROR_FRAME = '[From deepartments] Turn-error 429: post internal-programming-head session sess-x turn 7 (13:53Z) — 429 too many requests'
const QUALITY_INSPECT_FRAME = 'Quality inspect: post-error (post internal-programming-head, message m-900, error ECONNRESET)'
const POST_ERROR_FRAME = '[deepartments] health alert (1 finding)\n- CATCH-UP post-error: internal-programming-head (3 in window): 429'

/** The pure predicate, asserted directly: it does NOT see the message, and the
 * daemon origin is refused for EVERY recipient — the ground the exemption
 * narrows. This is the PIN that keeps the exemption in `catalogRoute` and out of
 * the predicate (a future "fix" that moved it into `acl.ts` would have to change
 * this signature and would fail here). */
test('D270 (§0): the PURE predicate cannot see the message — `aclDenyGround(sender, recipient)` denies the daemon origin for EVERY recipient (why the exemption lives in `catalogRoute`, not in `acl.ts`)', () => {
  const sender = { kind: 'unclassified', memberId: 'deepartments' }
  assert.equal(aclDenyGround(sender, { kind: 'head', memberId: HEAD }), 'unclassified-sender', 'the daemon origin is refused by the conservative branch')
  assert.equal(aclDenyGround(sender, { kind: 'worker', memberId: 'builder-486', departmentId: 'internal-programming' }), 'unclassified-sender', '…for a worker too')
  // The signature has NO message parameter — the exemption is therefore NOT
  // expressible here. Asserted by arity: a content-aware predicate needs a third
  // argument, and this call is the proof it has none.
  assert.equal(aclDenyGround.length, 2, 'aclDenyGround takes EXACTLY (sender, recipient) — no message, hence no content-conditioned rule')
})

test('D270 CASE 1 — ADMITTED: a health notice of `deepartments` about the RECIPIENT\'S OWN post reaches it (the three measured forms: Turn-error / Quality inspect / post-error)', async () => {
  for (const [cls, frame] of [['Turn-error', TURN_ERROR_FRAME], ['Quality inspect', QUALITY_INSPECT_FRAME], ['post-error', POST_ERROR_FRAME]]) {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'd270-case1-'))
    try {
      const { engine, marks, infos } = engineOver(stateDir)
      const status = await engine.deliverOrQueue(HEAD, record('m-700', 'deepartments', [HEAD], frame), { callerAgentId: 'deepartments' })
      assert.equal(status, 'delivered', `${cls}: the notice about the recipient's OWN post is ADMITTED (no longer 'failed')`)
      assert.equal(marks.at(-1).status, 'delivered', `${cls}: the pair settles 'delivered' — the head's session is really woken`)
      assert.equal(marks.at(-1).opts?.reason, undefined, `${cls}: NO 'failed' cause is written (nothing was refused)`)
      const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
      assert.equal(rows.filter((r) => r.status === 'failed').length, 0, `${cls}: the ledger carries ZERO 'failed' rows — the pre-D270 churn is gone`)
      assert.ok(infos.some((m) => m.includes('ADMITTED by the D270 health-notice exemption') && m.includes(HEAD)), `${cls}: the admission is AUDITABLE (one info line naming the record + recipient)`)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  }
})

test('D270 CASE 2 — STILL DENIED: a CONTENT message of `deepartments` is refused exactly as before (the exemption is NOT a sender-wide pardon)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'd270-case2-'))
  try {
    const { engine, marks, warns } = engineOver(stateDir)
    const text = 'Here is the content you asked for: the full analysis of the ACL seam, with all the details.'
    const status = await engine.deliverOrQueue(HEAD, record('m-701', 'deepartments', [HEAD], text), { callerAgentId: 'deepartments' })
    assert.equal(status, 'failed', 'a CONTENT message from the daemon origin is STILL DENIED — the exemption never covered content')
    assert.equal(marks.at(-1).status, 'failed', 'the pair settles failed')
    assert.equal(marks.at(-1).opts?.reason, 'acl', 'the cause column keeps the engine ground (fb-2160)')
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    assert.equal(rows.filter((r) => r.status === 'failed').at(-1).reason, 'acl', 'the ledger row carries reason: acl — byte-identical to the pre-D270 denial')
    assert.ok(warns.some((m) => m.includes('DENIED by the messaging ACL')), 'the pre-D270 warn is byte-identical')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('D270 CASE 3 — STILL DENIED: a health notice about ANOTHER post is refused (the exemption concerns THAT post, not the class)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'd270-case3-'))
  try {
    const { engine, marks } = engineOver(stateDir)
    // A REAL health notice — about a DIFFERENT post (OTHER_POST), delivered to HEAD.
    const frame = '[From deepartments] Turn-error 429: post quality-head session sess-y turn 3 (13:53Z) — 429 too many requests'
    const status = await engine.deliverOrQueue(HEAD, record('m-702', 'deepartments', [HEAD], frame), { callerAgentId: 'deepartments' })
    assert.equal(status, 'failed', 'a health notice about ANOTHER post is STILL DENIED — the recipient learns nothing about a peer')
    assert.equal(marks.at(-1).opts?.reason, 'acl', 'the cause column keeps the engine ground')
    // NEGATIVE CONTROL for the parse: the SAME text addressed to the post it
    // NAMES is admitted — so case 3 fails on the TARGET, never on the shape.
    const okStatus = await engine.deliverOrQueue(OTHER_POST, record('m-703', 'deepartments', [OTHER_POST], frame), { callerAgentId: 'deepartments' })
    assert.equal(okStatus, 'delivered', 'the SAME notice, addressed to the post it NAMES, is admitted — the discriminator is the target, not the regex')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('D270 case 4 (NARROWNESS, the guard) — every NON-exempt class keeps its byte-identical denial: an id mismatch, an unparseable notice, and a non-post route admit NOTHING', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'd270-case4-'))
  try {
    const hostRouteEngine = engineOver(stateDir, {
      resolveCatalogRoute: (id) => (id === 'host-session-x'
        ? { kind: 'host', entry: { hostId: 'host-session-x', sessionId: 'sess-h' } }
        : { kind: 'post', entry: { postId: id, sessionId: `session-${id}`, provider: 'head' } })
    })
    const { engine, marks } = engineOver(stateDir)
    // (a) a health-shaped notice whose cited id does NOT match the recipient.
    let s = await engine.deliverOrQueue(HEAD, record('m-710', 'deepartments', [HEAD], TURN_ERROR_FRAME.replace('post internal-programming-head', 'post some-other-post')), { callerAgentId: 'deepartments' })
    assert.equal(s, 'failed', '(a) a health notice naming a DIFFERENT post is denied')
    assert.equal(marks.at(-1).opts?.reason, 'acl', '(a) …with the acl cause column')
    // (b) an unparseable post-error bullet (no id charset match) admits NOTHING.
    s = await engine.deliverOrQueue(HEAD, record('m-712', 'deepartments', [HEAD], '- post-error: (NOT A POST ID)'), { callerAgentId: 'deepartments' })
    assert.equal(s, 'failed', '(b) an unparseable notice admits NOTHING (the conservative direction)')
    // (c) the HOST route is NOT exempted: a daemon-origin record to a host stays denied.
    s = await hostRouteEngine.engine.deliverOrQueue('host-session-x', record('m-713', 'deepartments', ['host-session-x'], TURN_ERROR_FRAME), { callerAgentId: 'deepartments' })
    assert.equal(s, 'failed', '(c) the exemption requires route.kind === \'post\' — a HOST route stays denied (the host alert path never travels this seam)')
    assert.equal(hostRouteEngine.marks.at(-1).opts?.reason, 'acl', '(c) …with the acl cause column')
    // (d) the REROUTE branch is untouched — its own gate is a DIFFERENT expression.
    const rerouteEngine = engineOver(stateDir, {
      resolveCatalogRoute: () => ({ kind: 'reroute', entry: { hostId: 'host-session-live', sessionId: 'sess-live' } })
    })
    s = await rerouteEngine.engine.deliverOrQueue(HEAD, record('m-714', 'deepartments', [HEAD], TURN_ERROR_FRAME), { callerAgentId: 'deepartments' })
    assert.equal(s, 'failed', '(d) the REROUTE branch keeps its own denial (never exempted)')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('D270 case 6 (THE PRODUCTION HOLE — the measured self-repair class) — the fb-759 SELF-DIRECTED notice (`headId === postId`) was settled `failed/acl`: D270 turns it back into the intended `prepared`/noWake, while the MANAGER path (a WORKER\'s post cited, delivered to its HEAD) stays DENIED by construction', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'd270-case6-'))
  try {
    const { engine, marks } = engineOver(stateDir)
    // (A) THE HEAD'S OWN POST: `turn-error` about HEAD, delivered to HEAD with the
    // fb-759 noWake intent (`tools.ts` healthNotifyHead selfDirected branch). The
    // exemption admits it, so the pre-D270 `failed/acl` is gone and the pair keeps
    // the caller's noWake seal — the head finally learns its own session errors.
    const own = `[From deepartments] Turn-error 429: post ${HEAD} session s turn 7 (13:53Z) — 429 too many requests`
    const a = await engine.deliverOrQueue(HEAD, record('m-800', 'deepartments', [HEAD], own), { callerAgentId: 'deepartments', noWake: true })
    assert.equal(a, 'prepared', '(A) the self-directed notice resolves the fb-759 intent (`prepared` + noWake), NOT the pre-D270 `failed/acl`')
    assert.deepEqual(marks.at(-1).opts, { noWake: true }, '(A) the noWake seal survives — the head is NOT re-woken into the loop its own turn died on')
    // (B) THE MANAGER PATH: the errored post is a WORKER, the delivery goes to its
    // HEAD ⇒ the cited id ≠ recipientId ⇒ DENIED. This is the DELIBERATE boundary:
    // D270 admits only the RECIPIENT'S OWN post, so a head is never handed a
    // notice about a peer's post through this exemption.
    const manager = `[From deepartments] Turn-error 429: post builder-486 session s turn 3 (13:53Z) — 429 too many requests`
    const b = await engine.deliverOrQueue(HEAD, record('m-801', 'deepartments', [HEAD], manager), { callerAgentId: 'deepartments' })
    assert.equal(b, 'failed', '(B) the MANAGER notice stays DENIED — the exemption is scoped to the recipient\'s OWN post, never to the notice class')
    assert.equal(marks.at(-1).opts?.reason, 'acl', '(B) …with the acl cause column (unchanged)')
    // (C) THE QUALITY-INSPECT DIRECTIVE: `qualityInspectDirectiveText` cites the
    // SUBJECT post, not the directive's addressee (`quality-head`) ⇒ DENIED. D270
    // deliberately does NOT cover the QD directive channel (see the report §5 —
    // raised as an open item for the head, NOT silently widened).
    const qi = 'Quality inspect: post-error (post m-17488, message m-17488, error ECONNRESET)'
    const c = await engine.deliverOrQueue(OTHER_POST, record('m-802', 'deepartments', [OTHER_POST], qi), { callerAgentId: 'deepartments' })
    assert.equal(c, 'failed', '(C) the QD directive (subject ≠ addressee) stays DENIED — outside D270\'s declared scope')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('D270 case 7 (SCOPE GUARD — the exemption lifts ONLY the daemon origin\'s own ground) — a REAL department-scoping denial (`other-department`, a worker writing to a peer) is NEVER admitted, even with a byte-identical health frame', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'd270-case7-'))
  try {
    // The sender is a WORKER of ANOTHER department targeting this head: the ground
    // is `other-department` (a REAL leak, the exact thing the ACL exists for), and
    // the frame is a byte-identical health notice about the recipient's own post.
    const { engine, marks } = engineOver(stateDir, {
      busProfileFor: (memberId) => (memberId === 'builder-486'
        ? { kind: 'worker', memberId, departmentId: 'other-department-id', managerId: 'other-head' }
        : { kind: 'head', memberId, departmentId: 'internal-programming' })
    })
    const spoof = record('m-803', 'builder-486', [HEAD], TURN_ERROR_FRAME)
    const status = await engine.deliverOrQueue(HEAD, spoof, { callerAgentId: 'builder-486' })
    assert.equal(status, 'failed', 'a cross-department sender is STILL DENIED with a health-shaped frame — the exemption is bound to the daemon origin AND to the unclassified-sender ground')
    assert.equal(marks.at(-1).opts?.reason, 'acl', '…with the acl cause column')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('D270 case 5 (NEGATIVE CONTROL — the fix is what admits it) — the SAME three notices are refused when the exemption cannot apply, so case 1 cannot pass vacuously', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'd270-case5-'))
  try {
    // The ONLY difference from case 1: the recipient the notice NAMES is not the
    // recipient of the delivery ⇒ every notice is denied. This is the proof that
    // case 1's 'delivered' comes from the exemption's own condition (3), not from
    // some other route change.
    const { engine } = engineOver(stateDir)
    for (const [i, frame] of [TURN_ERROR_FRAME, QUALITY_INSPECT_FRAME, POST_ERROR_FRAME].entries()) {
      const status = await engine.deliverOrQueue('research-head', record(`m-72${i}`, 'deepartments', ['research-head'], frame), { callerAgentId: 'deepartments' })
      assert.equal(status, 'failed', `notice ${i}: addressed to a post it does NOT name ⇒ DENIED`)
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})
