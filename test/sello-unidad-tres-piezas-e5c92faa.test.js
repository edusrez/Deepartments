// LANE sello-unidad-tres-piezas (builder-322, run token e5c92faa) — the three
// pieces of the `reason-datum` seal, tested by VIOLATING each invariante (the
// QD technique: para un guard, la prueba es violarlo).
//
// METHOD (the repo's own "LANE ② src-native" pattern — register the ts-src
// loader + exercise the SOURCE; the built `lib/` may be out of sync, and this
// lane runs NO build):
//   - the loader is registered at the TOP (before the .ts imports below), so the
//     .js → .ts sibling rewrite + the workspace-package → src mapping are active.
//   - the plugin is booted FROM SOURCE (`src/index.ts` + every dshd-* row pointed
//     at its src/index.ts), so the gateway, the tools factory, the seal wrapper
//     AND the health producer under test are the CURRENT sources.
//   - the seal ROW is driven through the REAL wiring: the bundle fills the
//     `deepartments.toolsDeps` holder with the SEALED verifier (invoke.ts wraps
//     the module helper with `observeReasonSealDatum`), and this test calls that
//     holder member with a seeded mirror + a declared provenance — the exact
//     function the `dept_head_rotate` tool calls, no stubs of the code under test.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const srcUrl = (relative) => pathToFileURL(path.join(REPO_ROOT, relative)).href

// AFTER the register() call: the src-native imports (the loader rewrites them).
const { Context, Service } = await import('@deepseek-ai/cordis')
const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
// The health PRODUCER under test (PIECE 3) — imported from SOURCE.
const H = await import('../packages/dshd-health/src/index.ts')

/** Stub webServer (the mount target of the GUI channel). */
class StubWebServer extends Service {
  constructor(ctx) { super(ctx, 'webServer'); this.routes = [] }
  register(route) { this.routes.push(route); return () => {} }
}
class StubWebRuntime extends Service { constructor(ctx) { super(ctx, 'webRuntime'); this.trustedHosts = [] } }
class StubConnection extends Service { constructor(ctx) { super(ctx, 'connection'); this.trustedHosts = [] } }

/** Boot the bundle + every dshd-* package FROM SOURCE (no lib/ involved). */
async function bootSrc(stateDir) {
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
  loader.create({ id: 'dshd-core', name: srcUrl('packages/dshd-core/src/index.ts'), config: { stateDir, org: { departments: [] } } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: srcUrl(`packages/${id}/src/index.ts`), config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: srcUrl('packages/dshd-orchestration/src/index.ts'), config: {} })
  loader.create({ id: 'deepartments', name: srcUrl('src/index.ts'), config: { stateDir, org: { departments: [] } } })
  await loader.await()
  const ctx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return { root, loader, ctx, dispose: () => loaderFiber.dispose() }
}

/** One projcache session row: the monitor's projected formula operands. */
const projRow = (projected, seq, contextWindow = 1_048_576) => ({
  rows: { contextPressure: { seq, val: { pressureTokens: projected, surfaceTokens: 0, sampledSurfaceTokens: 0, contextWindow } } }
})

/** Seed the durable mirror the seal reads + return its path. */
async function seedMirror(stateDir, sessions) {
  const sessionsRoot = path.join(stateDir, 'sessions')
  const projCachePath = path.join(path.dirname(sessionsRoot), 'storages', 'session_projcache.json')
  await mkdir(path.dirname(projCachePath), { recursive: true })
  await writeFile(projCachePath, JSON.stringify({ tables: { sessions } }), 'utf8')
  return projCachePath
}

/** Capture the seal LOG line (the wrapper reads logger.info at CALL time). */
function captureLogger(logger) {
  const lines = []
  const original = logger.info
  logger.info = function (...args) { lines.push(args.map(String).join(' ')); return original.apply(this, args) }
  return { lines, restore: () => { logger.info = original } }
}

const readSealRows = async (projCachePath) => {
  const ledger = await readFile(`${projCachePath}.seals.jsonl`, 'utf8')
  return ledger.trim().split('\n').map((line) => JSON.parse(line))
}

// ---------------------------------------------------------------------------
// INVARIANTE 1 — LA MISMA CIFRA + EL MISMO DATO ⇒ EL MISMO VEREDICTO, antes y
// después de la rotación. The retry history can never choose the answer: the
// verdict is a PURE function of (citation, the datum of the audited session).
// VIOLATION ATTEMPT: replay the same citation before/after a rotation and after
// repeated calls, and demand the answer never drifts (no memo of a previous
// verdict survives a rotation, and none is fabricated for a session the mirror
// does not project).
// ---------------------------------------------------------------------------
test('sello (1): la MISMA cifra + el MISMO dato ⇒ el MISMO veredicto antes y después de la rotación (el historial de reintentos no elige la respuesta)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'sello-1-'))
  try {
    const { ctx, dispose } = await bootSrc(stateDir)
    try {
      // TWO incarnations of one post: the incumbent (R = 200000) and the FRESH
      // session the rotation mints (also projected at 200000 — the same datum).
      const projCachePath = await seedMirror(stateDir, {
        S_before: projRow(200_000, 11),
        S_after: projRow(200_000, 12),
        S_unprojected: { rows: {} }
      })
      const verify = ctx().get('deepartments.toolsDeps', false).get().verifyRotateReason
      const reason = 'la cifra del frame fue 200000'

      // BEFORE the rotation (the incumbent) — repeated: the verdict is stable.
      const before1 = verify(reason, 'S_before', projCachePath)
      const before2 = verify(reason, 'S_before', projCachePath)
      const before3 = verify(reason, 'S_before', projCachePath)
      assert.equal(before1, 'verified', 'the citation matches the incumbent datum → verified')
      assert.equal(before2, before1, 'the SAME citation + the SAME datum answers the SAME verdict (call #2)')
      assert.equal(before3, before1, 'the SAME citation + the SAME datum answers the SAME verdict (call #3 — no state, no memo)')

      // AFTER the rotation the audited subject is the FRESH session. With the
      // SAME datum the SAME citation must read the SAME verdict.
      const after = verify(reason, 'S_after', projCachePath)
      assert.equal(after, before1, 'after the rotation, the SAME citation + the SAME datum ⇒ the SAME verdict')

      // And a rotation to a session the mirror does NOT project has NOTHING to
      // verify: the previous `verified` must NOT be replayed (the retry history
      // cannot choose the answer).
      const unprojected = verify(reason, 'S_unprojected', projCachePath)
      assert.equal(unprojected, 'unavailable', 'an unprojected incumbment has nothing to verify — a previous verified is NEVER replayed')

      // A DIFFERENT datum ⇒ a different verdict, decided by the datum alone.
      const differentDatum = verify('la cifra del frame fue 520000', 'S_before', projCachePath)
      assert.equal(differentDatum, 'unverified', 'the datum decides: 520k against R 200000 → unverified')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// INVARIANTE 2 — EL DISCRIMINADOR ES «¿EL ORIGEN DECLARADO DIFIERE?», NUNCA
// «¿SE DECLARÓ?» (el acceptance adjudicado por el QD). Violation attempts:
// (a) declare the incumbent (redundant) → must stay a NORMAL verified, with no
//     token and no scope key in the row;
// (b) declare a DIFFERENT incarnation of the same post → its OWN token
//     (`verified-against-declared-origin`) + `referenceScope` IN THE ROW
//     (mandatory: a row sealing the incumbent's sessionId with a reference
//     projected against another session, and nothing saying so, is impossible to
//     re-verify);
// (c) declare a session that is NOT an incarnation of the post → NO token at all
//     (otherwise the own token is a refrendo with another name).
// ---------------------------------------------------------------------------
test('sello (2): declared === incumbente ⇒ verified NORMAL · declared ≠ incumbente (misma post) ⇒ token propio + referenceScope EN LA FILA · declared no-encarnación ⇒ NI token', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'sello-2-'))
  try {
    const { root, ctx, dispose } = await bootSrc(stateDir)
    try {
      // The fb-810 MEASURED shape: the audited row 38681 (ratio 17.03 against a
      // citation of 710689) and the sibling incarnation that DOES carry 710689.
      const projCachePath = await seedMirror(stateDir, {
        S_incumbent: projRow(38_681, 3),
        S_sibling: projRow(710_689, 7)
      })
      const ctxValue = ctx()
      const verify = ctxValue.get('deepartments.toolsDeps', false).get().verifyRotateReason
      const capture = captureLogger(ctxValue.logger)

      // (a) DECLARED === INCUMBENT: the declaration is REDUNDANT — the route and
      // the answer must be the normal one, with NO token and NO scope.
      // (Same arithmetic verdict reached WITHOUT declaring: proven identical.)
      const equalNoDecl = verify('la cifra del frame fue 38681', 'S_incumbent', projCachePath)
      const equalDecl = verify('la cifra del frame fue 38681', 'S_incumbent', projCachePath, undefined, { sessionId: 'S_incumbent' })
      assert.equal(equalNoDecl, 'verified', 'the citation closes against the audited incumbent')
      assert.equal(equalDecl, equalNoDecl, 'declaring the INCUMBENT changes NOTHING (the declaration is redundant — treating it differently would be noise)')

      // (b) DECLARED ≠ INCUMBENT, an incarnation of the same post: the figure is
      // ITS OWN, correct and verbatim — the row must carry the OWN TOKEN (never a
      // bare `verified`, which would certify the incumbent) while the STAMP stays
      // the AUDIT's decision.
      const siblingVerdict = verify('la cifra del frame fue 710689', 'S_incumbent', projCachePath, undefined, { sessionId: 'S_sibling' })
      assert.equal(siblingVerdict, 'unverified', 'the STAMP is the AUDITED decision: the cited 710689 MISSES the incumbent 38681 by 17.03 — it is NEVER `verified` (audited is the only scope that can produce verified)')

      // (c) DECLARED ≠ INCUMBENT, NOT an incarnation of the post: NO token.
      const alienVerdict = verify('la cifra del frame fue 710689', 'S_incumbent', projCachePath, undefined, { sessionId: 'S_not_this_post' })
      assert.equal(alienVerdict, 'unverified', 'a declaration that is not an incarnation of the post earns NO token: the field decision is the audited unverified and the cause says so')

      capture.restore()

      // THE ROWS (the certification surface): assert what the ledger sealed.
      const rows = await readSealRows(projCachePath)
      assert.equal(rows.length, 4, 'one sealed row per verification call')
      const [rowEqualNoDecl, rowEqualDecl, rowSibling, rowAlien] = rows

      assert.equal(rowEqualNoDecl.referenceScope, undefined, '(a) an audited verdict writes NO scope key (legacy row shape)')
      assert.equal(rowEqualNoDecl.reasonVerifiedToken, undefined, '(a) an audited verdict writes NO token')
      assert.equal(rowEqualDecl.referenceScope, undefined, '(a) declaring the INCUMBENT writes NO scope key (redundant declaration ⇒ the legacy row, byte-identical)')
      assert.equal(rowEqualDecl.reasonVerifiedToken, undefined, '(a) declaring the INCUMBENT writes NO token')

      assert.equal(rowSibling.referenceScope, 'declared-origin', '(b) referenceScope is MANDATORY in the row when the declared origin differs')
      assert.equal(rowSibling.reasonVerifiedToken, 'verified-against-declared-origin', '(b) the own token is sealed')
      assert.equal(rowSibling.declaredReferenceSessionId, 'S_sibling', '(b) the row NAMES the incarnation that carries the figure')
      assert.equal(rowSibling.declaredReference, 710_689, '(b) R′ — the declared origin projection the verdict compared')
      assert.equal(rowSibling.sessionId, 'S_incumbent', '(b) the row still names the AUDITED incumbent it was rotating')
      assert.match(rowSibling.cause, /^figure-provenance-mismatch/, '(b) the cause is the provenance one')
      assert.match(rowSibling.cause, /NOT wrong: it is CORRECT and verbatim from ITS OWN alert/, '(b) the cause AFFIRMS the figure was not wrong (the false-transport class closed)')
      assert.match(rowSibling.cause, /S_sibling/, '(b) the cause names the incarnation')
      assert.equal(rowSibling.executedRatio, (710_689 - 38_681) / 38_681, '(b) executedRatio is the ratio the STAMP rests on: the citation against the AUDITED reference (17.03)')
      assert.equal(rowSibling.declaredRatio, 0, '(b) declaredRatio is the DECLARED origin\'s own ratio (710689 against R′ 710689) — the magnitude the token rests on')

      assert.equal(rowAlien.reasonVerifiedToken, undefined, '(c) a non-incarnation declaration earns NO token')
      assert.equal(rowAlien.declaredOriginUnresolved, true, '(c) the row flags the unresolvable declaration')
      assert.match(rowAlien.cause, /^figure-provenance-mismatch/, '(c) the cause is the provenance one')
      assert.match(rowAlien.cause, /does NOT resolve to an incarnation of this post/, '(c) the cause says the declaration did not resolve')

      // (4) THE LOG PRINTS IT — the operator-facing line names the scope, the
      // declared origin and the token (piece 4 of the four).
      const logged = capture.lines
      assert.equal(logged.length, 4, 'one log line per seal')
      assert.match(logged[0], /scope audited .*declaredOrigin n\/a .*token n\/a/, 'the audited seal logs the audited scope')
      assert.match(logged[2], /scope declared-origin .*declaredOrigin S_sibling .*declaredR 710689 .*token verified-against-declared-origin/, 'the declared-origin seal LOGS the scope + declared origin + token')

      // PIECE 2 — (3) THE CALL-SITE DECLARES IT: the tool's own compiled JSON
      // Schema carries `reasonProvenance` (the producer whose absence made the
      // previous attempt revert: the consumer existed and the contract did not).
      const tool = root.tools.get('dept_head_rotate')
      const schema = tool.parameters.properties.reasonProvenance
      assert.ok(schema !== undefined, 'dept_head_rotate DECLARES reasonProvenance in its parameters (the producer of the provenance)')
      assert.deepEqual(Object.keys(schema.properties).sort(), ['rowSeq', 'sessionId', 'ts'], 'the declared shape is {sessionId, rowSeq?, ts?}')
      assert.deepEqual(schema.required, ['sessionId'], 'the sessionId is the REQUIRED member (the figure\'s origin)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// CONDICIÓN DURA — EL DIAGNÓSTICO DE ENCARNACIÓN **NO TOCA EL STAMP**.
// Violation attempt (the MEASURED one, fb-810): use the LINEAGE as the base of
// verification and the audited TRUE POSITIVE (row 8: reference 38681, ratio
// 17.03) is converted into a FALSE NEGATIVE via the sibling 710689 (ratio
// 0.0186). `audited` must stay the ONLY scope that can produce `verified`, and
// the incarnation diagnosis must never appear as a bare `verified`.
// ---------------------------------------------------------------------------
test('sello (DURO): el linaje NUNCA certifica — la fila 8 (reference 38681, ratio 17,03) NO se convierte en verified por su hermana 710689 (audited es el ÚNICO scope que produce verified)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'sello-duro-'))
  try {
    const { ctx, dispose } = await bootSrc(stateDir)
    try {
      const projCachePath = await seedMirror(stateDir, {
        S_row8: projRow(38_681, 3),
        S_sibling: projRow(710_689, 7)
      })
      const ctxValue = ctx()
      const verify = ctxValue.get('deepartments.toolsDeps', false).get().verifyRotateReason
      // The measured magnitudes: |710689 − 38681| / 38681 = 17.03 (the true
      // positive) and |710689 − 710689| / 710689 = 0 (the sibling's closure).
      assert.equal((710_689 - 38_681) / 38_681 > 17, true, 'the audited ratio is the 17.03 magnitude (arithmetic of the measured case)')

      // WITHOUT a declared provenance: the true positive is PRESERVED (this is
      // the assertion the previous attempt would have broken).
      const auditedVerdict = verify('la cifra del frame fue 710689', 'S_row8', projCachePath)
      assert.equal(auditedVerdict, 'unverified', 'the audited citation of 710689 against row 8 MISSES by 17.03 → unverified — the TRUE POSITIVE is preserved (never laundered into verified)')

      // WITH the sibling declared: the DIAGNOSIS is reported, and the STAMP stays
      // the audit's.
      const declaredVerdict = verify('la cifra del frame fue 710689', 'S_row8', projCachePath, undefined, { sessionId: 'S_sibling' })
      assert.equal(declaredVerdict, 'unverified', 'even with the incarnation declared, the audited session is NOT certified verified — the lineage NEVER certifies')
      const [row] = await readSealRows(projCachePath).then((rows) => rows.slice(-1))
      assert.equal(row.stamp, 'unverified', 'the sealed STAMP is the audited decision of the AUDITED session, not a certification')
      assert.equal(row.referenceScope, 'declared-origin', 'the row says which scope the DIAGNOSIS came from')
      assert.equal(row.reasonVerifiedToken, 'verified-against-declared-origin', 'the own token is the diagnosis, carried as a TOKEN — NOT as the stamp')
      assert.notEqual(row.stamp, row.reasonVerifiedToken, 'the DIAGNOSIS and the STAMP are two different fields: the token can never be read as the stamp')
      assert.equal(row.declaredRatio, 0, 'the token rests on the DECLARED origin ratio (0), reported separately')

      // The mirror image: when the AUDITED session really carries the figure, the
      // scope is `audited` — the ONLY scope that produces `verified`.
      const auditedOk = verify('la cifra del frame fue 38681', 'S_row8', projCachePath)
      assert.equal(auditedOk, 'verified', 'the audited scope produces verified')
      const rows = await readSealRows(projCachePath)
      assert.equal(rows.at(-1).referenceScope, undefined, 'the verified verdict is an AUDITED one (no declared scope)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// INVARIANTE 3 — LA FILA DE ALERTA LLEVA LA SESIÓN (PIECE 3, el productor).
// Violation attempt: WITHOUT the session the alert's figure has NO FRAME — the
// `error` names the AGENT, never the session — so nobody could declare the
// provenance of a figure quoted verbatim from that alert. The change must be
// ADDITIVE: the frozen literals (asserted by SUBSTRING across the suite) stay
// byte-identical.
// ---------------------------------------------------------------------------
test('sello (3): la fila context-threshold PUBLICA la sesión que produjo la cifra — y el literal congelado sigue byte-identico', () => {
  const T0 = new Date(2026, 8, 11, 14, 37, 1).getTime()
  // The MEASURED alert shape: the row carries kind/key/postId/ts/error — the
  // `error` names the AGENT. Now it also carries the SESSION.
  const scan = H.scanContextThreshold({
    rows: [{ postId: 'quality-head', sessionId: 'sess-57bed534', contextWindow: 1_048_576, projectedTokens: 734_990 }],
    threshold: 0.85,
    completionReserve: 262_144,
    nowMs: T0
  })
  assert.equal(scan.findings.length, 1, 'the above-threshold row alerts')
  const finding = scan.findings[0]
  assert.equal(finding.kind, 'context-threshold')
  assert.equal(finding.key, 'context-threshold:quality-head:b9', 'the per-(member,tier) key is untouched')
  assert.equal(finding.postId, 'quality-head', 'the postId is untouched')
  assert.equal(finding.ts, T0, 'the ts is untouched')
  // ⭐ PIECE 3: the SESSION travels WITH the figure — the provenance is now
  // OBTAINABLE by a caller that quotes the alert verbatim.
  assert.equal(finding.sessionId, 'sess-57bed534', 'the alert row PUBLISHES the session that produced the figure (without it the provenance is derivable by NOBODY)')
  assert.equal(finding.error, 'quality-head 95% (734990+262144/1048576) — cruce b9', 'the error line is UNCHANGED (additive change: never reorder nor drop a token)')
  // THE FROZEN LITERALS (asserted by SUBSTRING in the suite — test/invoke.test.js
  // asserts `research-head 95% (734990+262144/1048576) — cruce b9` at :13314 and
  // the frame bullet `- context-threshold: research-head 52% (520000/1000000) —
  // cruce b5` at :13346): reproduce the SUITE'S OWN scenarios against the SOURCE
  // and demand those strings BYTE-IDENTICAL.
  const suiteCalibrated = H.scanContextThreshold({
    rows: [{ postId: 'research-head', contextWindow: 1_048_576, projectedTokens: 734_990 }],
    threshold: 0.85,
    completionReserve: 262_144,
    nowMs: T0
  })
  assert.equal(suiteCalibrated.findings[0].error, 'research-head 95% (734990+262144/1048576) — cruce b9', 'the FROZEN error literal of invoke.test.js:13314 is byte-identical from the source')
  const suiteFrame = H.buildHealthAlertFrame([{
    kind: 'context-threshold',
    key: 'context-threshold:research-head:b5',
    postId: 'research-head',
    ts: T0,
    error: 'research-head 52% (520000/1000000) — cruce b5'
  }])
  assert.match(suiteFrame, /- context-threshold: research-head 52% \(520000\/1000000\) — cruce b5/, 'the FROZEN frame bullet of invoke.test.js:13346 still matches (the branch is untouched)')
  assert.match(suiteFrame, /^\[From deepartments\] System-health ALERT:/, 'the frame head is untouched')

  // A host row publishes its session too (the host is the other context-pressure
  // subject — its alert must be as re-verifiable as a post row's).
  const hostScan = H.scanContextThreshold({
    rows: [{ hostId: 'host-asst', sessionId: 'sess-host-1', contextWindow: 1_048_576, projectedTokens: 860_000 }],
    threshold: 0.5,
    nowMs: T0
  })
  assert.equal(hostScan.findings[0].hostId, 'host-asst')
  assert.equal(hostScan.findings[0].sessionId, 'sess-host-1', 'the host row publishes its session as well')

  // BACK-COMPAT (the additive rule): a wiring that does NOT publish a session
  // (an older row producer) leaves the field ABSENT — exactly as before.
  const legacy = H.scanContextThreshold({
    rows: [{ postId: 'research-head', contextWindow: 1_000_000, pressureTokens: 520_000 }],
    threshold: 0.5,
    nowMs: T0
  })
  assert.equal(legacy.findings[0].sessionId, undefined, 'no session published ⇒ the key is ABSENT (never a fabricated value)')
  assert.equal(legacy.findings[0].error, 'research-head 52% (520000/1000000) — cruce b5', 'the legacy error line is byte-identical')

  // THE TWO CASES `findings.push` SERVES (fb-825: «UPWARD crossing OR FIRST
  // observation») are still DISTINGUISHED by the latch, without touching the
  // shared literal: a FIRST observation (no latch) and a LATER upward crossing
  // both alert, and the SAME band does not re-alert (the hysteresis).
  const first = H.scanContextThreshold({ rows: [{ postId: 'p', contextWindow: 1000, projectedTokens: 600 }], threshold: 0.5, nowMs: T0 })
  assert.deepEqual(Object.keys(first.latches), ['p'], 'FIRST observation → alerts + latches')
  const sameBand = H.scanContextThreshold({ rows: [{ postId: 'p', contextWindow: 1000, projectedTokens: 620 }], threshold: 0.5, tierLatches: first.latches, nowMs: T0 })
  assert.equal(sameBand.findings.length, 0, 'the SAME band only TRACKS (persisting in a tier is silent — fb-50 RE calibration)')
  assert.equal(sameBand.changed, false, 'a same-band persistence is not a change')
  const crossing = H.scanContextThreshold({ rows: [{ postId: 'p', contextWindow: 1000, projectedTokens: 820 }], threshold: 0.5, tierLatches: sameBand.latches, nowMs: T0 })
  assert.equal(crossing.findings.length, 1, 'the UPWARD crossing alerts (the other case of the shared push)')
  assert.equal(crossing.findings[0].key, 'context-threshold:p:b8', 'the crossing key names the NEW band')
})

// ---------------------------------------------------------------------------
// «LA PROCEDENCIA COMPLETA» = LOS CUATRO (así se rompió antes: se construyó el
// consumidor sin el productor). This test is a WIRING assertion over the frozen
// sources (the repo's own binder-contract/delivery-factory practice): the two
// runtime halves are proven above (the ROW by execution, the LOG by capture);
// here the two COMPILE-TIME halves are pinned so a future edit cannot silently
// drop one of the four and re-open the revert's root cause.
// ---------------------------------------------------------------------------
test('sello (LOS CUATRO): (1) el tipo de la FILA declara el campo · (2) el tipo de la FUNCIÓN lo declara · (3) el CALL-SITE lo enhebra · (4) el LOG lo imprime — si falta uno, la procedencia no viaja', async () => {
  const invokeSrc = await readFile(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
  const toolsSrc = await readFile(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts'), 'utf8')

  // (1) THE ROW TYPE declares the provenance fields.
  for (const field of ['referenceScope?: ReasonReferenceScope', 'reasonVerifiedToken?: ReasonVerifiedToken', 'declaredReferenceSessionId?: string', 'declaredRatio?: number']) {
    assert.ok(invokeSrc.includes(field), `(1) the ROW type (ReasonDatumSealRow) declares \`${field}\``)
  }
  // (2) THE FUNCTION TYPE declares the provenance PARAMETER.
  assert.match(invokeSrc, /export function verifyRotateReason\(reason: unknown, oldSessionId: string, projCachePath\?: string, completionReserve\?: number, reasonProvenance\?: ReasonDatumProvenance\): ReasonVerificationOutcome/, '(2) verifyRotateReason declares `reasonProvenance` in its signature')
  // (3) THE CALL-SITE THREADS IT — two halves: the tool DECLARES the parameter
  // (the producer, whose absence caused the revert) and the tool PASSES it into
  // the verifier (the actual transport).
  assert.match(toolsSrc, /reasonProvenance: \{\s*\n\s*type: 'object',/, '(3a) dept_head_rotate DECLARES reasonProvenance in `parameters` (the producer)')
  assert.match(toolsSrc, /verifyRotateReason\(args\.reason, sessionId, projCachePath, \([^)]*\)\?\.contextCompletionReserve, args\.reasonProvenance\)/, '(3b) the call site threads `args.reasonProvenance` INTO the verifier')
  // The wrapper that observes the call (invoke.ts) forwards the 5th argument to
  // the verifier and wraps the RAW helper (never the stamp-reduced dep value —
  // MEASURED: wrapping the dep value dropped the provenance and sealed `scope
  // audited` for a declared citation).
  assert.match(invokeSrc, /observeReasonSealDatum\(ctx\.logger, verifyRotateReason\)/, 'the seam wraps the RAW verifier (the outcome-producing helper) — wrapping the stamp-reduced dep value drops the provenance')
  assert.match(invokeSrc, /const outcome: ReasonVerificationOutcome = typeof verdict === 'string' \? \{ stamp: verdict \} : verdict/, 'the wrapper normalizes the dep shape ONCE (and keeps the outcome)')
  // (4) THE LOG PRINTS IT.
  assert.match(invokeSrc, /scope \$\{row\.referenceScope \?\? 'audited'\} · declaredOrigin \$\{row\.declaredReferenceSessionId \?\? 'n\/a'\} · declaredR \$\{row\.declaredReference \?\? 'n\/a'\} · token \$\{row\.reasonVerifiedToken \?\? 'n\/a'\}/, '(4) the seal LOG line prints the scope, the declared origin, R′ and the token')
})

// ---------------------------------------------------------------------------
// EL CUARTO ESLABÓN, de punta a punta: la fila que el emisor sella es la que un
// re-verificador puede reproducir (las mismas cifras, la MISMA sesión de
// referencia dicha en la fila).
// ---------------------------------------------------------------------------
test('sello (4): la procedencia llega COMPLETA — la fila sellada dice QUÉ sesión decidió, con qué R y con qué ratio (el re-verificador puede reproducirla)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'sello-4-'))
  try {
    const { ctx, dispose } = await bootSrc(stateDir)
    try {
      const projCachePath = await seedMirror(stateDir, {
        S_incumbent: projRow(200_000, 11),
        S_declared: projRow(204_000, 5)
      })
      const ctxValue = ctx()
      const verify = ctxValue.get('deepartments.toolsDeps', false).get().verifyRotateReason
      const capture = captureLogger(ctxValue.logger)
      const verdict = verify('la cifra del frame fue 204000', 'S_incumbent', projCachePath, undefined, { sessionId: 'S_declared' })
      capture.restore()
      assert.equal(verdict, 'verified', 'the STAMP is the AUDITED decision: 204000 against R 200000 is ratio 0.02 ≤ 0.15 → verified (and it is the AUDIT that said so)')
      const [row] = await readSealRows(projCachePath)
      // THE FOUR (1) row type (2) function type (3) call-site (4) log — here (1),
      // (2) and (4) are asserted on the REAL row/log; (3) is asserted in the
      // `sello (2)` test through the tool's declared schema + this same call path.
      assert.equal(row.seal, 'reason-datum')
      assert.equal(row.sessionId, 'S_incumbent', '(row) the AUDITED subject')
      assert.equal(row.reference, 200_000, '(row) R — the audited projection')
      assert.equal(row.referenceScope, 'declared-origin', '(row) the scope the DIAGNOSIS came from (a declaration that differed)')
      assert.equal(row.declaredReferenceSessionId, 'S_declared', '(row) the declared origin')
      assert.equal(row.declaredReference, 204_000, "(row) R′ — the declared origin's projection")
      assert.equal(row.executedRatio, 0.02, '(row) the ratio the STAMP rests on (against the AUDITED R)')
      assert.equal(row.declaredRatio, 0, '(row) the declared origin ratio, reported separately')
      assert.match(capture.lines[0], /scope declared-origin .*declaredOrigin S_declared .*declaredR 204000/, '(log) the line prints the provenance')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})
