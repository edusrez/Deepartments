// dsh-deepartments — fb-1879 (lane: the `dept_feedback` OUTPUT SCHEMA vs the
// fb-1874 candidate emission; run token 38362679).
//
// THE MEASURED DEFECT (host, 2026-09-17): `dept_feedback` fails ONLY when the
// duplicate search finds ≥1 candidate, and it fails at the OUTPUT, never at the
// write — the record IS durable (`fb-1884` line 3261 and `fb-1885` line 3263 of
// /.deepartments/feedback.jsonl exist) while the tool answers
//   tool "dept_feedback" returned invalid output: "value.candidates[0].admissible"
//   is not a declared property (additionalProperties: false)
// With 0 candidates the array is empty and validates; with ≥1 the harness output
// validator (dsh-tools createSuccessResult → validateJsonSchemaValue(tool.output
// .schema, detached, 'value')) rejects a value the tool ALREADY wrote. The real
// damage: every emitter that finds a duplicate believes its record was lost,
// exactly when it needs the answer.
//
// THE CAUSE (three sites): the orchestrator declares
// `feedbackDedupeCandidateSchema` with SIX properties + `additionalProperties:
// false` (packages/dshd-orchestration/src/tools.ts), while
// `findDuplicateCandidates` of the (uncommitted) dshd-feedback emission produces
// SIX MORE — `admissible`, `relation`, `relation_because`, `destination`,
// `linked_from`, `resolved_from` — the exact field set the
// `FeedbackDedupeCandidate` docstring of packages/dshd-feedback/src/index.ts
// declares.
//
// THE ACCEPTANCE (BOTH branches, measured in ONE hermetic run):
//   (1) WITHOUT candidates — the empty array still validates AND the real
//       registry answers a SUCCESS (the branch that was already green: the
//       negative control that keeps this file from passing for a wrong reason);
//   (2) WITH candidates — the value the tool returns passes the DECLARED output
//       schema and the real registry answers a SUCCESS (never `returned invalid
//       output`), with ≥1 candidate actually present (non-vacuous);
//   (3) ADDITIVE — the 6 pre-existing properties stay declared exactly as they
//       were (required string/number), so an emitter reading
//       `fb-id`/`resumen`/`score` keeps reading them;
//   (4) SCHEMA-LEVEL + LIBRARY-LEVEL — the schema the tool DECLARES is validated
//       against the candidate array the LIBRARY emits (the harness's OWN
//       validator, the same call and the same `'value'` path the registry uses).
// Hermetic: temp stateDir; every test boots the REAL Loader composition (the
// tools-factory / fb775 smokeBoot pattern) and dispatches through the REAL
// `tools.execute` registry (pre-execute → guards → body → OUTPUT VALIDATION →
// post-execute), so the failure surfaced is the SAME one the daemon surfaces.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { findDuplicateCandidates } from '../lib/feedback.js'

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
 * of test/tools-factory.test.js and test/fb775-*.test.js (hermetic temp
 * stateDir). */
async function smokeBoot(stateDir, { org = { departments: [] } } = {}) {
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
  new StubAgents(root)
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const agentsStub = root.get('agents')
  agentsStub.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return { root, loader, agentsStub, dispose: () => loaderFiber.dispose() }
}

/** The departments the boot materializes: the IPD (the reporting head) + the
 * QUALITY department whose coordinator `quality-head` receives the severity-gated
 * notification (the emit path's delivery leg — exercised, never mocked away). */
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
const ORG = { departments: [DEPARTMENT, QUALITY_DEPARTMENT] }

/** Wait (bounded) for the boot to materialize one scoped agent child. */
async function findChild(agentsStub, needle, label) {
  for (let i = 0; i < 160; i++) {
    const child = agentsStub.childContexts.find((c) => c.agent.id.includes(needle))
    if (child !== undefined) return child
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for the composed boot to materialize ${label}`)
}

/** One test's env: a temp stateDir + the booted composition + the materialized
 * post own-layer `dept_feedback` definition (via the REAL registry). */
async function withFeedbackEnv(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-fb1879-'))
  const feedbackFile = path.join(stateDir, 'feedback.jsonl')
  const env = await smokeBoot(stateDir, { org: ORG })
  try {
    const child = await findChild(env.agentsStub, 'head-quality-head', 'the quality-head post')
    const tool = child.ctx.tools.get('dept_feedback', child.key)
    assert.ok(tool !== undefined, 'the materialized post own-layer carries dept_feedback (every post)')
    return await fn({ stateDir, feedbackFile, root: env.root, agent: child.agent, tool })
  } finally {
    env.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** The REAL registry dispatch (pre-execute → guards → body → output validation
 * → post-execute) — the exact path the daemon uses for a model tool call. */
async function dispatchFeedback(root, agent, args, label) {
  return root.tools.execute({
    name: 'dept_feedback',
    agent,
    signal: new AbortController().signal,
    arguments: args,
    callId: `call-fb1879-${label}-${Math.random().toString(16).slice(2)}`
  })
}

/** The raw bytes of the live store file (the EFFECT instrument). */
function storeText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** The number of JSONL tails in the live store file. */
const tailCount = (contents) => contents.split('\n').filter((line) => line.trim() !== '').length

/** The 6 PRE-EXISTING properties of the candidate offer — the shape other
 * emitters already consume, which this fix must NOT touch (additive only). */
const LEGACY_CANDIDATE_PROPERTIES = {
  'fb-id': 'string',
  resumen: 'string',
  tipo: 'string',
  severidad: 'string',
  estado: 'string',
  score: 'number'
}

/** The 6 fb-1874 additions the dshd-feedback emission produces (the field set the
 * `FeedbackDedupeCandidate` docstring declares). */
const FB1874_CANDIDATE_PROPERTIES = ['admissible', 'relation', 'relation_because', 'destination', 'linked_from', 'resolved_from']

test('fb-1879 E2E (the DETERMINISTIC contrast): through the REAL registry, `dept_feedback` answers a SUCCESS with 0 candidates AND with ≥1 candidate — the record is durable in BOTH branches', async () => {
  await withFeedbackEnv(async ({ feedbackFile, root, agent }) => {
    // ---- BRANCH A: NO candidate (the store is empty — the input shares its
    // ≥2 significant tokens with nothing). This branch was ALREADY green.
    const beforeA = storeText(feedbackFile)
    const zero = await dispatchFeedback(root, agent, { tipo: 'fallo', severidad: 'medio', resumen: 'alpha bravo charlie delta' }, 'zero')
    const afterA = storeText(feedbackFile)
    assert.notEqual(zero.isError, true, `0 candidates must validate (the green branch): ${zero.error?.message ?? ''}`)
    assert.deepEqual(zero.value.candidates, [], 'the empty candidate array is returned')
    assert.ok(tailCount(afterA) > tailCount(beforeA), 'the record was written (the durable emit DID happen)')

    // ---- BRANCH B: ≥1 candidate (the SAME ≥2-token subject, so the just-written
    // record is a duplicate candidate by construction — deterministic, never a
    // hopeful fixture).
    const beforeB = storeText(feedbackFile)
    const many = await dispatchFeedback(root, agent, { tipo: 'fallo', severidad: 'medio', resumen: 'alpha bravo charlie delta echo' }, 'many')
    const afterB = storeText(feedbackFile)
    const candidates = many.isError === true ? undefined : many.value.candidates
    const evidence = `[fb1879 E2E] 0-candidate call: isError=${zero.isError === true} · ` +
      `≥1-candidate call: isError=${many.isError === true} candidates=${Array.isArray(candidates) ? candidates.length : '(no value)'} · ` +
      `store tails ${tailCount(beforeB)} → ${tailCount(afterB)} (the record is durable even when the OUTPUT is rejected) · ` +
      `store bytes ${beforeB.length} → ${afterB.length}` +
      (many.isError === true ? ` · verbatim error: ${many.error?.message ?? ''}` : '')
    // Printed UNCONDITIONALLY: PRE-FIX this line measures the damage class (the
    // record landed while the tool reported invalid output).
    console.log(evidence)

    assert.notEqual(many.isError, true, `${evidence} — a candidate-bearing emit MUST answer a success, never "returned invalid output"`)
    assert.ok(Array.isArray(candidates) && candidates.length >= 1, `${evidence} — the ≥1-candidate branch is actually exercised (non-vacuous)`)
    assert.ok(tailCount(afterB) > tailCount(beforeB), 'the second record was written too (the ≥1-candidate branch really emits)')

    // The offer travels with its fb-1874 declaration (the semantics the schema
    // must now declare, not merely tolerate).
    const offer = candidates[0]
    assert.equal(typeof offer.admissible, 'boolean', 'the offer declares its admissibility')
    assert.ok(['canonical', 'canonical-shared', 'twin', 'archived'].includes(offer.relation), `the offer declares its relation (${offer.relation})`)
    assert.equal(typeof offer.relation_because, 'string', 'the offer declares WHY the relation holds')
    assert.equal(offer.admissible, offer.relation === 'canonical' || offer.relation === 'canonical-shared', 'the documented invariant: admissible ⇔ canonical relation')
    // The legacy 6 stay readable on the SAME offer (additive, never replaced).
    for (const [key, type] of Object.entries(LEGACY_CANDIDATE_PROPERTIES)) {
      assert.equal(typeof offer[key], type, `the legacy candidate field \`${key}\` is still emitted as a ${type}`)
    }
  })
})

test('fb-1879 SCHEMA-LEVEL: the tool\'s DECLARED output schema accepts the candidate array the LIBRARY emits — the harness\'s own validator, the same call and path the registry uses', async () => {
  await withFeedbackEnv(async ({ tool }) => {
    const itemSchema = tool.output.schema.properties.candidates.items

    // (1) The DECLARED property set: the 6 legacy + the 6 fb-1874 additions.
    const declared = Object.keys(itemSchema.properties)
    for (const key of Object.keys(LEGACY_CANDIDATE_PROPERTIES)) {
      assert.ok(declared.includes(key), `the legacy candidate property \`${key}\` stays declared (ADDITIVE fix)`)
      assert.equal(itemSchema.properties[key].type, LEGACY_CANDIDATE_PROPERTIES[key], `\`${key}\` keeps its declared type ${LEGACY_CANDIDATE_PROPERTIES[key]}`)
    }
    assert.deepEqual([...declared].sort(), [...Object.keys(LEGACY_CANDIDATE_PROPERTIES), ...FB1874_CANDIDATE_PROPERTIES].sort(),
      `the candidate schema declares EXACTLY the 12 emitted fields (declared=${JSON.stringify([...declared].sort())})`)
    assert.equal(itemSchema.additionalProperties, false, 'the candidate object stays CLOSED (no silent extra field)')
    // The 3 always-emitted additions + the 3 conditional ones (docstring: absent
    // when the record declares no destination / none declares it / none is
    // inadmissible).
    for (const key of ['admissible', 'relation', 'relation_because']) {
      assert.ok(itemSchema.required.includes(key), `\`${key}\` is REQUIRED (the emission always carries it)`)
    }
    for (const key of ['destination', 'linked_from', 'resolved_from']) {
      assert.equal(itemSchema.required.includes(key), false, `\`${key}\` is OPTIONAL (the emission omits it when it does not apply)`)
    }

    // (2) The LIBRARY emission, validated against the DECLARED schema — the
    // harness's own validator, the same literal `'value'` path the registry uses.
    // The pool covers the WHOLE declaration surface the schema must now accept:
    // a LIVE canonical declared by two ARCHIVED twins (so the offer carries
    // `linked_from` + `resolved_from` + `relation: 'canonical-shared'`), a twin
    // whose declared destination IS live (`destination.live: true`), and a twin
    // whose declared destination is NOT in the ledgers read — the `estado: null`
    // branch of the declaration.
    function fb(id, resumen, extra = {}) {
      return { id, createdAt: id.length, updatedAt: id.length, emisor: 'w', source: 'dshd-feedback', tipo: 'fallo', severidad: 'medio', estado: 'abierto', resumen, ...extra }
    }
    const pool = [
      fb('fb-1', 'alpha bravo charlie delta'),
      { record: fb('fb-2', 'alpha bravo charlie echo', { estado: 'duplicado', duplicate_of: 'fb-1' }), ledger: 'archive' },
      { record: fb('fb-3', 'alpha bravo delta zulu', { estado: 'duplicado', duplicate_of: 'fb-99' }), ledger: 'archive' }
    ]
    const emitted = findDuplicateCandidates(pool, { resumen: 'alpha bravo charlie delta echo zulu', tipo: 'fallo', severidad: 'medio' }, { max: 3 })
    assert.equal(emitted.length, 3, 'the library offers all three records (non-vacuous)')
    const canonical = emitted.find((c) => c['fb-id'] === 'fb-1')
    const twinLive = emitted.find((c) => c['fb-id'] === 'fb-2')
    const twinAbsent = emitted.find((c) => c['fb-id'] === 'fb-3')
    assert.ok(canonical !== undefined && twinLive !== undefined && twinAbsent !== undefined, 'every pool record is offered')
    // The LIVE canonical: a legal destination, declared by two archived twins.
    assert.equal(canonical.admissible, true)
    assert.equal(canonical.relation, 'canonical-shared', 'two archived records declare it as their destination')
    assert.match(canonical.relation_because, /also declared as the destination by fb-2/, 'the WHY travels with the relation')
    assert.equal(canonical.linked_from, 'fb-2', 'the "consumer canonical" is named')
    assert.equal(canonical.resolved_from, 'fb-2', 'the inadmissible record this offer is the RESOLUTION OF is named')
    assert.equal(canonical.destination, undefined, 'a canonical declares no destination of its own')
    // The ARCHIVED twin declaring a LIVE destination: inadmissible, yet it RESOLVES to it.
    assert.equal(twinLive.admissible, false)
    assert.equal(twinLive.relation, 'twin')
    assert.deepEqual(twinLive.destination, { 'fb-id': 'fb-1', estado: 'abierto', live: true, tail: true }, 'the declaration is DECLARED with its destination tail estado')
    assert.equal(twinLive.linked_from, undefined, 'nothing declares the twin as a destination')
    // The ARCHIVED twin declaring a destination ABSENT from the ledgers read:
    // `estado: null` — the nullable branch of the declaration.
    assert.equal(twinAbsent.relation, 'twin')
    assert.deepEqual(twinAbsent.destination, { 'fb-id': 'fb-99', estado: null, live: false, tail: true }, 'an unresolvable declared destination is exhibited as estado:null, never hidden')
    // The exact shape the registry validates — record + candidates, path 'value'.
    const value = { ...fb('fb-4', 'alpha bravo charlie delta echo zulu'), candidates: emitted }
    const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
    assert.deepEqual(violations, [], `the emitted candidate array validates against the DECLARED schema (violations=${JSON.stringify(violations)})`)

    // NEGATIVE CONTROLS of the instrument (a green above must never be a
    // validator that validates nothing):
    //  (a) the OPTIONAL additions really are optional — an offer carrying the 6
    //      legacy fields + the 3 always-emitted additions (and NONE of the 3
    //      conditional ones, exactly the shape the docstring declares for a
    //      record that declares no destination and is declared by nobody)
    //      validates: the legacy 6 are still declared, with their types, and the
    //      ADDITIVE extension is a tail, never a replacement;
    //  (b) the PRE-fix candidate shape (the bare spec §4a 6) is now named for
    //      what it is MISSING — the declaration is the EMISSION's shape, so the
    //      defect class stays reproducible and its 3 required fields stay named;
    //  (c) an UNKNOWN field still fires the closed-object rule.
    const legacyOnly = ['fb-id', 'resumen', 'tipo', 'severidad', 'estado', 'score']
    const addOptional = (candidate) => Object.fromEntries(Object.entries(candidate).filter(([key]) => !['destination', 'linked_from', 'resolved_from'].includes(key)))
    const coreOnly = validateJsonSchemaValue(tool.output.schema, { ...value, candidates: emitted.map(addOptional) }, 'value')
    assert.deepEqual(coreOnly, [], 'an offer with the 6 legacy fields + the 3 always-emitted additions validates (the 3 conditional additions are genuinely optional)')
    const preFixShape = emitted.map((candidate) => Object.fromEntries(Object.entries(candidate).filter(([key]) => legacyOnly.includes(key))))
    const preFixViolations = validateJsonSchemaValue(tool.output.schema, { ...value, candidates: preFixShape }, 'value')
    assert.ok(preFixViolations.every((violation) => violation.includes('missing required property')), `the bare §4a 6-field offer is named as MISSING the 3 always-emitted additions (${JSON.stringify(preFixViolations.slice(0, 3))})`)
    for (const key of ['admissible', 'relation', 'relation_because']) {
      assert.ok(preFixViolations.some((violation) => violation.includes(`.${key}"`)), `\`${key}\` is NAMED as the missing required property (the DECLARED shape is the emission's)`)
    }
    const unknown = validateJsonSchemaValue(tool.output.schema, { ...value, candidates: [{ ...emitted[0], invented_field: 1 }] }, 'value')
    assert.ok(unknown.some((violation) => violation.includes('invented_field')), 'the closed-object control still fires for an UNKNOWN field (the validator is doing real work)')
    //  (d) the two NEW constrained nodes are ENFORCED, not merely tolerated: the
    //      `relation` enum and the nullable `destination.estado`.
    const badRelation = validateJsonSchemaValue(tool.output.schema, { ...value, candidates: [{ ...emitted[0], relation: 'invented-relation' }] }, 'value')
    assert.ok(badRelation.some((violation) => violation.includes('relation') && violation.includes('must be one of')), `an out-of-enum \`relation\` is rejected (${JSON.stringify(badRelation.slice(0, 1))})`)
    const nullableOk = validateJsonSchemaValue(tool.output.schema, { ...value, candidates: [{ ...emitted[0], destination: { 'fb-id': 'fb-99', estado: null, live: false, tail: true } }] }, 'value')
    assert.deepEqual(nullableOk, [], 'the `null` declared-destination estado validates (the docstring branch)')
    const nullableBad = validateJsonSchemaValue(tool.output.schema, { ...value, candidates: [{ ...emitted[0], destination: { 'fb-id': 'fb-99', estado: 5, live: false, tail: true } }] }, 'value')
    assert.ok(nullableBad.some((violation) => violation.includes('exactly one oneOf branch')), `an out-of-union estado is rejected (${JSON.stringify(nullableBad.slice(0, 1))})`)
  })
})

test('fb-1879 SCHEMA-INVALID control through the REAL registry: an OFF-SCHEMA candidate value is rejected with the measured `returned invalid output` class (the instrument that produced the defect is still armed)', async () => {
  await withFeedbackEnv(async ({ root, agent }) => {
    // A fixture tool whose body returns a value violating ITS OWN declared
    // output schema — the exact rejection class (ToolOutputError) the live
    // `dept_feedback` produced. This proves the RED instrument is real and that
    // the acceptance above is not a validator that can never fail.
    root.tools.register(defineTool({
      name: 'fb1879-fixture-invalid-output',
      description: 'fb-1879 control tool: returns a value its own output schema rejects',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { candidates: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { 'fb-id': { type: 'string', required: true } } } } }
        },
        render: () => [{ type: 'text', text: 'control' }]
      },
      async execute() { return { candidates: [{ 'fb-id': 'fb-1', admissible: true }] } }
    }))
    const result = await root.tools.execute({
      name: 'fb1879-fixture-invalid-output',
      agent,
      signal: new AbortController().signal,
      arguments: {},
      callId: 'call-fb1879-control'
    })
    assert.equal(result.isError, true, 'an off-schema output IS rejected (the defect class is reproducible on demand)')
    assert.match(String(result.error?.message ?? ''), /returned invalid output: "value\.candidates\[0\]\.admissible" is not a declared property/, 'the rejection names the SAME field path and wording the live defect measured')
  })
})
