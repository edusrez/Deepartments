// fb-775 (QD, ALTO) — `dept_feedback_update` IGNORED UNKNOWN KEYS and answered
// SUCCESS. With the typo `notes_qh` (the declared key is `notas_qh`) the tool
// applied the TERMINAL transition to `duplicado` and LOST the note; with
// `notas_qh` it wrote it — the ONLY difference is the parameter NAME. It
// happened in the SAME call that ran an IRREVERSIBLE terminal close: a record
// was shut without its justification. Worst class: a FALSE SUCCESS over an
// irreversible act — not "it lies when reporting" but "it confirms what it did
// not do".
//
// ROOT CAUSE: `dept_feedback_update` reads its args as a WHITELIST (`args.
// notas_qh`, `args.escalado`, …) and never inspected the REST of the object;
// the harness parameter schema is implicitly OPEN —
// `parameterSchemaSpecToJsonSchema` (dsh-tools) emits `{type:'object',
// properties, required}` with NO `additionalProperties:false`, so an undeclared
// key travels UNTOUCHED into `execute` and `store.update` ran anyway.
//
// THE FIX reuses the PROVEN canonical pattern of the SAME package — the
// `dept_memo_write` org validator (packages/dshd-orchestration/src/boot.ts:612
// `MEMO_WRITE_EXPECTED_FIELDS`, :623 `memoWriteArgsViolations` — its :639 emits
// exactly `"<key>" is not a declared property (additionalProperties: false)` —
// :648 the expected-fields trailer, wired at :680): the ORG validator throws ONE
// error that NAMES the offending key AND LISTS the valid ones, BEFORE any
// transition is computed or applied.
//
// THIS TEST IS THE EFFECT ACCEPTANCE (never the message alone): it measures the
// store file BYTES + LINE COUNT + the record's TAIL estado BEFORE/AFTER the
// unknown-key call. PRE-FIX it FAILS, with the measured effect printed (tail
// estado `duplicado`, `notas_qh` lost, the file grown) — the false success is
// DEMONSTRATED, not assumed. POST-FIX the call rejects and NOTHING moves
// (byte-identical store file).
//
// Hermetic: temp stateDir; the E2 boots the REAL Loader composition (the
// tools-factory smokeBoot pattern) and drives the REAL head own-layer
// `dept_feedback` / `dept_feedback_update` of a REAL materialized quality-head
// (the terminal-transition authority of spec §4).
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

test('fb-775 (real Loader): dept_feedback_update REJECTS an unknown key, NAMES it, LISTS the valid ones and applies ZERO transition (the store file stays byte-identical) — the pre-fix false success over an irreversible terminal close is measured, never assumed', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-fb775-'))
  const feedbackFile = path.join(stateDir, 'feedback.jsonl')
  try {
    const { agentsStub, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT, QUALITY_DEPARTMENT] }, agents: true })
    try {
      // The REAL quality-head (the terminal-transition authority) — its own
      // layer carries dept_feedback (every post) + dept_feedback_update (heads).
      const qhChild = await findChild(agentsStub, 'head-quality-head', 'the quality-head post')
      const emitTool = qhChild.ctx.tools.get('dept_feedback', qhChild.key)
      const updateTool = qhChild.ctx.tools.get('dept_feedback_update', qhChild.key)
      assert.ok(emitTool !== void 0, 'the quality-head own-layer carries dept_feedback (every post)')
      assert.ok(updateTool !== void 0, 'the quality-head own-layer carries dept_feedback_update (the head manager gate)')
      const agent = qhChild.agent

      // (0) SEED two REAL records through the REAL store: a canonical record
      // (the duplicate target) + the record to be closed.
      const canonical = await emitTool.execute({ tipo: 'mejora', severidad: 'bajo', resumen: 'fb775 canonical record used as the duplicate_of target' }, { agent })
      const target = await emitTool.execute({ tipo: 'mejora', severidad: 'bajo', resumen: 'fb775 record whose TERMINAL close must never lose its justification' }, { agent })
      assert.ok(typeof canonical.id === 'string' && typeof target.id === 'string', 'both records exist in the durable store')

      // (0b) LEGITIMATE CONTROL — the DECLARED key still works (no regression).
      const legit = await updateTool.execute({ id: canonical.id, estado: 'en-estudio', notas_qh: 'legit triage note (the declared key)' }, { agent })
      assert.equal(legit.estado, 'en-estudio', 'a legitimate transition still applies')
      assert.equal(legit.notas_qh, 'legit triage note (the declared key)', 'the DECLARED key `notas_qh` is written (the only difference in the recorded defect is the NAME)')

      // (1) THE DEFECT SHAPE: a TERMINAL transition whose payload is otherwise
      // COMPLETELY VALID (`duplicado` + the required `duplicate_of`) plus the
      // typo `notes_qh`. Effect instruments BEFORE the call.
      const before = readFeedbackFile(feedbackFile)
      const beforeTails = tailCount(before)
      const beforeTail = tailFor(before, target.id)
      assert.equal(beforeTail.estado, 'abierto', 'the target starts ABIERTO (the pre-transition state the acceptance measures)')
      let error
      let result
      try {
        result = await updateTool.execute({ id: target.id, estado: 'duplicado', duplicate_of: canonical.id, notes_qh: 'THE JUSTIFICATION THAT A TERMINAL CLOSE MUST NOT LOSE' }, { agent })
      } catch (thrown) {
        error = thrown
      }
      const after = readFeedbackFile(feedbackFile)
      const afterTails = tailCount(after)
      const afterTail = tailFor(after, target.id)
      const effectLine = `[fb775 EFFECT] unknown key "notes_qh" + a valid terminal payload → ` +
        `error=${error === undefined ? 'NONE (the false success)' : 'REJECTED'} · ` +
        `returned=${result === undefined ? '(nothing)' : JSON.stringify({ estado: result.estado, cerrado_por: result.cerrado_por, duplicate_of: result.duplicate_of, notas_qh: result.notas_qh })} · ` +
        `tail estado ${beforeTail.estado} → ${afterTail.estado} · ` +
        `tail notas_qh=${afterTail.notas_qh === undefined ? 'LOST/undefined' : JSON.stringify(afterTail.notas_qh)} · ` +
        `store tails ${beforeTails} → ${afterTails} · store bytes ${before.length} → ${after.length} · bytes identical=${after === before}` +
        (error === undefined ? '' : ` · verbatim error: ${String(error.message ?? error)}`)
      // Printed UNCONDITIONALLY: PRE-FIX this line demonstrates the measured
      // false success (estado `duplicado`, the note LOST, the file grown).
      console.log(effectLine)

      // (2) THE CONTRACT: reject, NAME the offending key, LIST the valid ones.
      assert.ok(error !== undefined, `${effectLine} — an UNKNOWN key MUST reject (never a success)`)
      const msg = String(error?.message ?? error)
      assert.match(msg, /\[deepartments\] dept_feedback_update: invalid arguments/, 'the rejection is the tool\'s invalid-arguments error')
      assert.match(msg, /"notes_qh" is not a declared property \(additionalProperties: false\)/, 'the OFFENDING key is NAMED (the canonical dept_memo_write phrasing)')
      assert.match(msg, /expected fields: id, estado, notas_qh, escalado, escalado_a, duplicate_of, related, triage_owner, resolution, frozen/, 'the error LISTS the valid keys in ONE message')

      // (3) THE EFFECT: ZERO transition. The store file is byte-identical —
      // no new tail line, no estado move, the note still unwritten.
      assert.equal(after, before, 'the store file is BYTE-IDENTICAL after the rejected call (zero side effects — the validator runs BEFORE the transition)')
      assert.equal(afterTails, beforeTails, 'NO tail line was appended (the queue is unchanged)')
      assert.equal(afterTail.estado, 'abierto', 'the record did NOT move to `duplicado` (no terminal close happened)')
      assert.equal(afterTail.cerrado_por, undefined, 'no `cerrado_por` was stamped (the record is NOT closed)')
      assert.equal(afterTail.duplicate_of, undefined, 'no `duplicate_of` was written')

      // (4) ORDERING: the rejection happens BEFORE the transition is computed —
      // an unknown key with `duplicado` but NO `duplicate_of` reports the KEY,
      // not the missing-field error of the transition path (tools.ts:5784).
      let orderingError
      try {
        await updateTool.execute({ id: target.id, estado: 'duplicado', notes_qh: 'typo again (no duplicate_of)' }, { agent })
      } catch (thrown) {
        orderingError = thrown
      }
      const orderingMsg = String(orderingError?.message ?? orderingError)
      assert.match(orderingMsg, /"notes_qh" is not a declared property \(additionalProperties: false\)/, 'the unknown key is reported FIRST (before the `duplicado requires duplicate_of` gate)')
      assert.doesNotMatch(orderingMsg, /requires `duplicate_of`/, 'the transition-path error is NOT reached (the closed-set check runs BEFORE the transition is computed)')
      assert.equal(readFeedbackFile(feedbackFile), before, 'still byte-identical after the second rejected call')

      // (5) THE DOC IS PART OF THE CONTRACT: the tool description says it (the
      // dept_memo_write wording), so the model can correct without a retry cycle.
      assert.match(updateTool.description, /Unknown keys are rejected/, 'the description declares the closed-set rule (doc + validator travel together)')

      // (6) NO OVER-BLOCKING: the SAME terminal payload with the CORRECT key
      // still applies (the validator is a closed-set check, not a veto).
      const closed = await updateTool.execute({ id: target.id, estado: 'duplicado', duplicate_of: canonical.id, notas_qh: 'the justification, now on the DECLARED key' }, { agent })
      assert.equal(closed.estado, 'duplicado', 'a fully-valid terminal transition still applies')
      assert.equal(closed.duplicate_of, canonical.id, 'duplicate_of is recorded')
      assert.equal(closed.cerrado_por, 'quality-head', 'the terminal close stamps cerrado_por = the QH caller')
      assert.equal(closed.notas_qh, 'the justification, now on the DECLARED key', 'the justification travels WITH the terminal close when the key is the declared one')
      assert.ok(tailCount(readFeedbackFile(feedbackFile)) > beforeTails, 'the LEGITIMATE terminal close DID append its tail (the control confirms the instrument detects a real transition)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})
