// fb-2112 (QD, MEDIO) — `dept_feedback_update` WITH ONLY `id`: the tool ACCEPTED
// a call carrying NO update field, applied NO transition and ANSWERED SUCCESS.
// The measured defect (QD, class filed 4 days before this lane — ARCHIVED; the
// evidence row records a `feedback fb-1395 → abierto` reply, i.e. a "transition"
// to the estado the record ALREADY had) drove the caller to THREE CONSECUTIVE
// attempts on the same record, convinced the failure was transient.
//
// ⚠️ THE TRACE IS REAL AND MISLEADING — NOT A NO-OP (head correction, verified
// in source and MEASURED against the real store): `FeedbackStore.update`
// (packages/dshd-feedback/src/index.ts:879-880
// `const next = { ...current, updatedAt: Date.now(), estado: nextEstado }` +
// :894 `await appendFeedbackRecord(this.filePath, next)`) writes
// UNCONDITIONALLY. MEASURED EVIDENCE (a direct `store.update(id, {}, {})`
// against the compiled store, the exact empty input the tool used to build):
//   store tails: 1 -> 2 · returned {"id":"fb-0","estado":"abierto"}
//   FIELDS THAT DIFFER between the two tails: ["updatedAt"]
//      updatedAt : 1790094988316 -> 1790094988321
// So the defective call APPENDED A SPURIOUS TAIL whose ONLY change was
// `updatedAt` (the estado did NOT change — :864 `input.estado ?? current.estado`).
// The correct phrasing is: the tool does not only confirm what it did NOT do —
// it leaves a trace that LOOKS LIKE AN EDIT.
// ⇒ AND THAT TRACE IS NOT INERT: `updatedAt` is the SECOND SORT KEY of the
// duplicate-candidate block (same file:432 `score desc → updatedAt desc → id
// desc`), so an empty call can REORDER the very suggestions fb-1874 exists to
// improve. That damage vector is ASSERTED below (section 3), not described.
//
// THIS IS THE SURVIVOR OF THE fb-775 CURE. fb-775 (builder-314) closed the door
// "an UNDECLARED key" — `notes_qh` for `notas_qh` travelled untouched into the
// whitelist reads and the terminal close applied anyway — by adding the
// CLOSED-SET org validator (`feedbackUpdateArgsViolations`: every key NOT in
// FEEDBACK_UPDATE_EXPECTED_FIELDS is a violation). That check is
// `!(expected.includes(key))`: `id` IS expected, so `{ id }` PASSES it. The
// SYMMETRIC twin — "NO key at all" — stayed open: `const input = {}` +
// `if (args.X !== undefined)` reads ⇒ an EMPTY input ⇒ `store.update(id, {})`
// appended the spurious tail and answered normal. BOTH doors end in the same
// sentence: the tool CONFIRMS WHAT IT DID NOT DO.
//
// THE FIX (two anchors, ONE message — the same family as the existing validator):
//   (1) `feedbackUpdateArgsViolations` gains the second door: with ZERO
//       undeclared keys, a call that declares NONE of the WRITE fields
//       (every expected field except `id`) is a violation. It is decidable from
//       `args` ALONE and it keeps the fb-775 ORDERING (the contract is reported
//       BEFORE any authority check, transition computation or store read — never
//       the `duplicado requires duplicate_of` gate).
//   (2) `Object.keys(input).length === 0` immediately before `store.update` —
//       the anchor on the ARTIFACT ABOUT TO BE WRITTEN, not on the args: an
//       empty write can never reach the store again even if a future field
//       arrives through a path the args-level test cannot see.
// The error NAMES THE EXIT (the declared write fields) plus the shared
// expected-fields trailer, so the caller corrects in the SAME cycle.
//
// WHY REJECT AND NOT WARN (the head's ruling, adopted): the spurious write
// happens BEFORE any notice could be emitted, so a warning would arrive AFTER
// the damage; and "skip the write when `next` ≡ `current` except `updatedAt`"
// is more expensive — it demands whole-record equality over arrays and optionals
// to protect a case with NO legitimate use.
//
// THE HOUSE LAW this lane derives (head, and the reason the effect is asserted by
// CONTENT below): `updatedAt` (or any mtime/ts) proves THAT a write happened,
// never WHAT was written. The content is proven with the CONTENT — so every
// assertion here cites the literal JSONL tail, never a file date.
//
// SEMANTICS PRESERVED (explicitly asserted below, not assumed): the anchor is an
// ENUMERABLE OWN-key count, so FALSY LEGITIMATE VALUES are NOT "no field" —
// `escalado: false`, `frozen: false`, `related: []` and `notas_qh: ''` all COUNT
// as declared and keep the pre-fix behaviour byte-for-byte (the constructor
// keeps its `!== undefined` distinction untouched).
//
// Hermetic: temp stateDir; the boots the REAL Loader composition (the
// fb775-feedback-update-unknown-keys harness, itself the tools-factory smokeBoot
// pattern) and drives the REAL quality-head own-layer `dept_feedback` /
// `dept_feedback_update` (the terminal-transition authority of spec §4).
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createScope } from '@deepseek-ai/dsh-scope'

/** Stub webServer/webRuntime/connection so the bundle's RPC mount effect runs
 * (the smoke-boot pattern — the client-graph server half). */
class StubWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = []
  }
  register(route) { this.routes.push(route); return () => {} }
}
class StubWebRuntime extends Service {
  constructor(ctx) { super(ctx, 'webRuntime'); this.trustedHosts = [] }
}
class StubConnection extends Service {
  constructor(ctx) { super(ctx, 'connection'); this.trustedHosts = [] }
}

/** An agents service that MATERIALIZES a REAL scoped cordis child context and
 * RUNS the postSetup setup closure, so installHeadBoardTools actually executes
 * and its registration lands on the post's OWN tool layer. */
class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.childContexts = []
    this.createCalls = []
    this.scopeAnchor = ctx
  }
  get(id) { return this.store.get(String(id)) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  async create(options) {
    this.createCalls.push(options)
    const sessionId = String(options.sessionId)
    const agent = {
      id: sessionId,
      status: 'running',
      ctx: undefined,
      session: { events: [], get seq() { return this.events.length }, snapshotEvents() { return this.events }, requestHeader() { return undefined } },
      followup() {},
      cancel() {},
      async whenIdle() {}
    }
    const childKey = Symbol('stub-child-scope')
    const scope = createScope(this.scopeAnchor, childKey)
    const childCtx = scope.ctx.extend({ agent })
    agent.ctx = childCtx
    this.childContexts.push({ ctx: childCtx, key: childKey, agent })
    const provision = await options.setup?.(childCtx)
    provision?.commit?.()
    this.store.set(sessionId, agent)
    return { agent, dispose: async () => { this.store.delete(sessionId) } }
  }
  async resume(options) {
    return this.create({ ...options, sessionId: options.resumeSessionId })
  }
}

/** The REAL Loader composition of the dev-profile subset (dshd-core + the 6 P1
 * packages + dshd-orchestration + the bundle, in order) — the smokeBoot pattern
 * of the tools-factory test (hermetic temp stateDir). */
async function smokeBoot(stateDir, { org = { departments: [] }, agents = false } = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  new StubWebServer(root)
  new StubWebRuntime(root)
  new StubConnection(root)
  if (agents === true) new StubAgents(root)
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const agentsStub = root.get('agents')
  if (agentsStub !== undefined) {
    agentsStub.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  }
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return {
    root,
    loader,
    pluginCtx,
    agentsStub,
    dispose: () => loaderFiber.dispose()
  }
}

/** The departments the boot materializes: the IPD (the reporting head) + the
 * QUALITY department whose coordinator `quality-head` owns the terminal
 * transition authority (`busMemberIdFor(agent.id) === 'quality-head'`). */
const DEPARTMENT = {
  id: 'internal-programming',
  name: 'Internal Programming',
  roomId: 'room-ipd',
  coordinator: { postId: 'internal-programming-head' }
}
const QUALITY_DEPARTMENT = {
  id: 'quality',
  name: 'Quality Department',
  roomId: 'room-qd',
  coordinator: { postId: 'quality-head' }
}

/** Wait (bounded) for the boot to materialize one scoped agent child. */
async function findChild(agentsStub, needle, label) {
  for (let i = 0; i < 160; i++) {
    const child = agentsStub.childContexts.find((c) => c.agent.id.includes(needle))
    if (child !== undefined) return child
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for the composed boot to materialize ${label}`)
}

/** The raw bytes of the live store file (the EFFECT instrument). */
function readFeedbackFile(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** The number of JSONL tails in the live store file (the QUEUE LINE count). */
function tailCount(contents) {
  return contents.split('\n').filter((line) => line.trim() !== '').length
}

/** The LAST tail (append-only record state) of one id, parsed from the file —
 * independent of any tool return value. */
function tailFor(contents, id) {
  let tail
  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record?.id === id) tail = record
  }
  return tail
}

/** The declared WRITE fields the fix requires (every expected field BUT `id`) —
 * the list the rejection message must name so the caller sees the exit. */
const WRITE_FIELDS = ['estado', 'notas_qh', 'escalado', 'escalado_a', 'duplicate_of', 'related', 'triage_owner', 'resolution', 'frozen']

test('fb-2112 (real Loader): dept_feedback_update with ONLY `id` REJECTS with a message that NAMES the exit and appends NO spurious tail — the pre-fix write (a tail whose only change is `updatedAt`) is measured, never assumed', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-fb2112-'))
  const feedbackFile = path.join(stateDir, 'feedback.jsonl')
  try {
    const { agentsStub, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT, QUALITY_DEPARTMENT] }, agents: true })
    try {
      const qhChild = await findChild(agentsStub, 'head-quality-head', 'the quality-head post')
      const emitTool = qhChild.ctx.tools.get('dept_feedback', qhChild.key)
      const updateTool = qhChild.ctx.tools.get('dept_feedback_update', qhChild.key)
      assert.ok(emitTool !== void 0, 'the quality-head own-layer carries dept_feedback (every post)')
      assert.ok(updateTool !== void 0, 'the quality-head own-layer carries dept_feedback_update (the head manager gate)')
      const agent = qhChild.agent

      // (0) SEED a REAL record through the REAL store.
      const target = await emitTool.execute({ tipo: 'mejora', severidad: 'bajo', resumen: 'fb2112 record whose id-only update must never be confirmed' }, { agent })
      assert.ok(typeof target.id === 'string', 'the record exists in the durable store')

      // (1) THE DEFECT SHAPE: `{ id }` ALONE. Effect instruments BEFORE the call.
      const before = readFeedbackFile(feedbackFile)
      const beforeTails = tailCount(before)
      const beforeTail = tailFor(before, target.id)
      assert.equal(beforeTail.estado, 'abierto', 'the target starts ABIERTO (the state the pre-fix reply echoed back as a "transition")')
      let error
      let result
      try {
        result = await updateTool.execute({ id: target.id }, { agent })
      } catch (thrown) {
        error = thrown
      }
      const after = readFeedbackFile(feedbackFile)
      const afterTails = tailCount(after)
      const afterTail = tailFor(after, target.id)
      // NOTE the phrasing: PRE-FIX the defect is NOT "nothing happened" — it is a
      // SPURIOUS TAIL (only `updatedAt` moved) plus a success answer. The
      // observable is the tail count and the literal tail, never a file date.
      const effectLine = `[fb2112 EFFECT] id-only update → ` +
        `error=${error === undefined ? 'NONE (the false success)' : 'REJECTED'} · ` +
        `returned=${result === undefined ? '(nothing)' : JSON.stringify({ id: result.id, estado: result.estado })} · ` +
        `tail estado ${beforeTail.estado} → ${afterTail.estado} · ` +
        `spurious tail appended=${afterTails > beforeTails} · ` +
        `store tails ${beforeTails} → ${afterTails} · store bytes ${before.length} → ${after.length}` +
        (error === undefined ? '' : ` · verbatim error: ${String(error.message ?? error)}`)
      // Printed UNCONDITIONALLY: PRE-FIX this line demonstrates the measured
      // defect (a normal return, `→ abierto`, and ONE extra tail whose only
      // change is `updatedAt`).
      console.log(effectLine)

      // (2) THE CONTRACT: reject, and the message NAMES THE EXIT.
      assert.ok(error !== undefined, `${effectLine} — an id-only update MUST reject (never a success)`)
      const msg = String(error?.message ?? error)
      assert.match(msg, /\[deepartments\] dept_feedback_update: invalid arguments/, 'the rejection is the tool\'s invalid-arguments error')
      assert.match(msg, /no update field applied: the call would apply ZERO transition/, 'the violation states WHY (zero transition)')
      for (const field of WRITE_FIELDS) {
        assert.ok(msg.includes(field), `the rejection NAMES the exit field \`${field}\` (the caller corrects in the same cycle)`)
      }
      assert.match(msg, /expected fields: id, estado, notas_qh, escalado, escalado_a, duplicate_of, related, triage_owner, resolution, frozen/, 'the shared expected-fields trailer still travels in the SAME message (one contract, two doors)')

      // (3) THE EFFECT — asserted by CONTENT, never by a file date (`updatedAt`
      // proves THAT a write happened, never WHAT was written): with the cure,
      // `appendFeedbackRecord` never runs, so NO new tail exists at all. PRE-FIX
      // the SAME three assertions are RED — and that is the measured defect: the
      // call APPENDED a tail (not a no-op) whose estado is unchanged and whose
      // only difference from the previous tail is `updatedAt`/`ts`.
      assert.equal(after, before, 'the store file is BYTE-IDENTICAL after the rejected call (zero side effects — the validator runs BEFORE any store read)')
      assert.equal(afterTails, beforeTails, 'NO spurious tail was appended (the pre-fix `appendFeedbackRecord` is never reached)')
      assert.equal(afterTail.estado, 'abierto', 'the record did NOT move')
      assert.equal(afterTail.updatedAt, beforeTail.updatedAt, '`updatedAt` did NOT bump (no phantom edit was recorded — the trace that LOOKS like an edit is gone)')

      // (3b) THE DAMAGE VECTOR the head measured — `updatedAt` is the SECOND SORT
      // KEY of the duplicate-candidate block (dshd-feedback src/index.ts:432
      // `score desc → updatedAt desc → id desc`), so a spurious `updatedAt` bump
      // can REORDER the very suggestions fb-1874 exists to improve. Proven here
      // against the REAL sorter with two mirror records of IDENTICAL score: the
      // ONLY difference between the two orderings is `updatedAt`.
      const { findDuplicateCandidates } = await import('../packages/dshd-feedback/lib/index.js')
      const probe = { resumen: 'fb2112 reorder probe canonical record tokens', tipo: 'mejora', severidad: 'bajo' }
      const older = { ...beforeTail, id: 'fb-9001', updatedAt: 1000, estado: 'abierto' }
      const newer = { ...beforeTail, id: 'fb-9002', updatedAt: 2000, estado: 'abierto' }
      const order = (a, b) => findDuplicateCandidates([a, b], probe, { max: 2 }).map((c) => c['fb-id']).join(',')
      const tiedOrder = order(older, newer)
      assert.equal(tiedOrder, 'fb-9002,fb-9001', 'the tie between two IDENTICAL scores is broken by `updatedAt` desc — the sort key a spurious empty update moves')
      const bumped = order({ ...older, updatedAt: 3000 }, newer)
      assert.equal(bumped, 'fb-9001,fb-9002', 'a bare `updatedAt` bump (which is the WHOLE effect of the pre-fix empty update) FLIPS the candidate ORDER without any content change — the measured damage vector, not a description')

      // (4) ORDERING (fb-775 preserved): the empty-update violation is reported
      // BEFORE the transition path — with `duplicado` absent there is no
      // `requires duplicate_of` error to report instead.
      assert.doesNotMatch(msg, /requires `duplicate_of`/, 'the transition-path error is NOT reached (the closed-set check runs BEFORE the transition is computed)')

      // (5) THE DOC IS PART OF THE CONTRACT (the fb-775 pattern): the description
      // declares the required write field, so a model can correct WITHOUT a retry.
      assert.match(updateTool.description, /An update field is REQUIRED/, 'the description declares the required write field (doc + validator travel together)')

      // (6) POSITIVE CONTROL — the SAME call + ONE legitimately FALSY declared
      // field still PASSES and applies the transition (no over-blocking; the
      // `undefined` vs `false`/`[]`/`''` distinction is NOT touched).
      const falsy = await updateTool.execute({ id: target.id, escalado: false }, { agent })
      assert.equal(falsy.escalado, false, '`escalado: false` is a DECLARED field (a legitimate falsy value is not "no field") and still applies')
      assert.ok(tailCount(readFeedbackFile(feedbackFile)) > beforeTails, 'the legitimate falsy-field update DID append its tail (the instrument detects a real transition)')

      // (6b) the other falsy shapes travel the SAME way (each one a real update).
      const asArray = await updateTool.execute({ id: target.id, related: [] }, { agent })
      assert.deepEqual(asArray.related, [], '`related: []` is a DECLARED field and REPLACES the cross-links (not a no-op)')
      const emptyNote = await updateTool.execute({ id: target.id, notas_qh: '' }, { agent })
      assert.equal(emptyNote.notas_qh, '', '`notas_qh: \'\'` is a DECLARED field (the empty string is written, never read as absent)')

      // (7) THE CONTROL OF THE CLASS: a NORMAL update still works exactly as
      // before (id + a real transition + its note).
      const closed = await updateTool.execute({ id: target.id, estado: 'resuelto', resolution: 'fixed by the fb-2112 lane (id-only update now rejects)' }, { agent })
      assert.equal(closed.estado, 'resuelto', 'a fully-valid terminal transition still applies (no regression)')
      assert.equal(closed.cerrado_por, 'quality-head', 'the terminal close still stamps cerrado_por = the QH caller')
      assert.equal(closed.resolution, 'fixed by the fb-2112 lane (id-only update now rejects)', 'the justification travels WITH the close')

      // (8) THE SECOND DOOR IS NOT DEAD CODE — AND IT IS REACHABLE, which is the
      // point: door 1 is decided on the ARGS and cannot see this shape. A declared
      // key with an EMPTY SLOT (`estado: ''`) HAS a write field, so door 1 passes
      // it; the constructor's own `!== ''` guard drops it, leaving `input` EMPTY
      // — the SECOND door is what refuses it. Both doors emit the SAME message
      // (one reject template for one contract), so a caller cannot tell which one
      // caught it and reads ONE contract.
      const slotBefore = readFeedbackFile(feedbackFile)
      let second
      try {
        await updateTool.execute({ id: target.id, estado: '' }, { agent })
      } catch (thrown) {
        second = thrown
      }
      const secondMsg = String(second?.message ?? second)
      console.log(`[fb2112 EFFECT] empty-slot update (estado: '') → error=${second === undefined ? 'NONE (the false success — a spurious tail would be appended)' : 'REJECTED'} · store bytes identical=${readFeedbackFile(feedbackFile) === slotBefore}` + (second === undefined ? '' : ` · verbatim error: ${secondMsg}`))
      assert.ok(second !== undefined, 'a declared key with an EMPTY SLOT still applies ZERO transition ⇒ it MUST reject (door 1 cannot see it; the input anchor does)')
      assert.equal(secondMsg, msg, 'the two doors emit the SAME message (one reject template for one contract)')
      assert.equal(readFeedbackFile(feedbackFile), slotBefore, 'the empty-slot call appended NO spurious tail (the anchor runs before store.update)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})
