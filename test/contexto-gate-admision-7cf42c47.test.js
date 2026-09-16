// dsh-deepartments — LANE ③ (2026-09-16, run token 7cf42c47): «EL GATE DE
// ADMISIÓN DEL CONTEXTO» — the production READER of the durable marker that the
// health actuator writes and NOBODY read.
//
// THE BREACH THIS CLOSES (measured): `packages/dshd-health/src/index.ts` writes
// `<stateDir>/context-action.json` = `{ [agentId]: { sessionId, at, action,
// phase, pct, … } }` when a session crosses its context window, and escalates to
// the manager. `grep 'context-action'` over the repo returned ONLY the actuator's
// own src/test/doc/reports — ZERO consumers. The delivery seam therefore went on
// MATERIALIZING turns into a session whose next request is already impossible
// (`effective = projected + reserve > contextWindow` ⇒ 400 ⇒ Turn-error ⇒ the
// self-fed loop the rotation does not drain).
//
// THE PIECE (declared by the actuator's own author, §3 of
// docs/departments/internal-programming/ACTUADOR-CONTEXTO.md, VERBATIM):
//   «En `deliverOrQueue` (o en el gate de `materializePost`), antes de
//    materializar un turno para un `postId`: leer `<stateDir>/context-action.json`
//    y, si `ledger[postId].sessionId` COINCIDE CON LA SESIÓN VIVA que se va a
//    materializar, DIFERIR la materialización (encolar el turno) en vez de
//    despertar la sesión que ya no puede hacer el request. La comparación
//    `sessionId` es lo que evita el falso positivo de un post que YA rotó.»
//
// WHAT IS PROVEN HERE, by OBSERVABLE EFFECT (never by a log line):
//   (i)   a WORKER (with a manager) whose live session crossed the wall is
//         DEFERRED — the turn is queued ('prepared'), the route is NEVER reached;
//   (ii)  🔴 a HEAD **WITHOUT** a manager is DEFERRED THE SAME WAY — the gate
//         NEVER consults the manager. MEASURED basis: of 80 posts in
//         `/.deepartments/posts.json`, 77 carry a `managerId` and the THREE heads
//         (`quality-head`/`research-head`/`internal-programming-head`) do NOT —
//         the real flagged post of the incident (3 082 turn-errors, 15 dead
//         generations) is a HEAD. A gate that only covered manager-bearing posts
//         would leave the measured victim with NO actor;
//   (iii) 🔴 a MARKER WHOSE `sessionId` DOES NOT MATCH the live session (the post
//         ALREADY ROTATED) is **NOT** deferred — the successor is a fresh, sane
//         session and MUST be woken. This is the case that would break the org
//         (the marker is agentId-keyed and survives 24 h): the session
//         comparison is the ONLY thing separating «defer the dying one» from
//         «block a live one»;
//   (iv)  an ABSENT / MALFORMED / `sessionId`-less / stale marker is FAIL-OPEN:
//         the delivery proceeds UNCHANGED and NOTHING throws.
//
// THE ACCEPTANCE IS THE TWO-TREE PROOF: the SAME record, the SAME catalog, the
// SAME engine — one tree WITH the marker (deferred, route not reached) and one
// WITHOUT it (materialized, route reached). Plus the REVERT-CHECK DEMONSTRATED:
// a textual copy of the module with the gate's door neutralized to `if (false)`
// — loaded from a TEMP dir, ZERO writes inside the repo — must make the
// acceptance THROW there and PASS here.
//
// FIXTURE: deterministic — the addresses are FIXTURE ids, never live ids; the
// REAL seam `createDeliveryEngine` (delivery.ts) runs over temp stateDirs with
// stub deps only (0 builds, 0 real APIs — the lane discipline).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { deliveryStatus, markDelivery, parseDeliveryRows, resolveDeliveriesPath } from '../packages/dshd-core/src/messages.ts'
// The delivery engine is imported DYNAMICALLY: the module hook must be
// registered first (a static import is hoisted above it).
const { createDeliveryEngine } = await import('../packages/dshd-core/src/delivery.ts')

// ---------------------------------------------------------------------------
// The fixture addresses (deterministic, never live ids):
//   W    — a WORKER post (carries a managerId: 'ip-head').
//   QH   — a HEAD post WITHOUT a managerId (the MEASURED class of the incident:
//          the three heads carry no manager).
//   ROT  — a post whose live session ROTATED (the marker names the OLD one).
// ---------------------------------------------------------------------------
const W = 'fixture-worker'
const QH = 'fixture-head-sin-manager'
const ROT = 'fixture-rotated-post'
const SENDER = 'sender-head'
const MARKER = 'context-action.json'
const W_SESSION = 'sess-worker-LIVE'
const QH_SESSION = 'sess-head-LIVE'
const ROT_OLD = 'sess-rotated-OLD'
const ROT_NEW = 'sess-rotated-NEW'
const NOW = Date.now()

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ctxgate-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

function record(id, seq, to, from = SENDER) {
  return { id, seq, ts: 1_000, from, to, text: `msg ${id}`, kind: 'agent' }
}

/** The production-shaped catalog: W is a worker, QH a head with NO managerId,
 * ROT a post whose LIVE session is ROT_NEW (its marker names ROT_OLD). */
function catalogRoute(recipientId) {
  if (recipientId === W) return { kind: 'post', entry: { postId: W, sessionId: W_SESSION, retired: false, provider: 'worker', managerId: 'ip-head' } }
  if (recipientId === QH) return { kind: 'post', entry: { postId: QH, sessionId: QH_SESSION, retired: false, provider: 'head' } }
  if (recipientId === ROT) return { kind: 'post', entry: { postId: ROT, sessionId: ROT_NEW, retired: false, provider: 'head' } }
  return { kind: 'unknown' }
}

/** The REAL delivery engine wired like the production bundle (index.ts): the two
 * sidecar marks on the temp stateDir, and the wake primitives replaced by stubs
 * that RECORD the route they actually reached (the observable of «materialized
 * vs deferred»). No gate/wake dep beyond the marker file is needed: the gate
 * resolves the live session from the ROUTE entry, exactly as production does. */
function makeEngine(stateDir, calls) {
  return createDeliveryEngine({
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
    deliverHost: async (entry, framed, rec) => {
      calls.routes.push({ id: rec.id, target: entry.hostId })
      await markDelivery(stateDir, rec.id, entry.hostId, 'delivered')
      return 'delivered'
    }
  })
}

/** ONE full delivery run over a FRESH tree. `marker` (raw string) is written to
 * `<stateDir>/context-action.json` FIRST when provided (the actuator's write). */
async function runOnce({ recipientId, marker }) {
  return await withTempStateDir(async (stateDir) => {
    if (marker !== undefined) await writeFile(path.join(stateDir, MARKER), marker, 'utf8')
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, calls)
    const rec = record('m-500', 500, [recipientId])
    const status = await engine.deliverOrQueue(recipientId, rec, {})
    return { status, calls, stateDir, recipientId, rec, rows: await readRowsOrEmpty(stateDir) }
  })
}

async function readRowsOrEmpty(stateDir) {
  try { return parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8')) }
  catch { return [] }
}

/** The actuator's own on-disk shape, verbatim: `{ [agentId]: mark }`. */
function markerFor(agentId, sessionId, at = NOW - 60_000, extra = {}) {
  return JSON.stringify({
    [agentId]: { sessionId, at, action: 'compact-or-rotate', phase: 'beyond-usable-window', pct: 1.0002, effectiveTokens: 1_048_577, contextWindow: 1_048_576, ...extra }
  }, null, 2)
}

/** THE ACCEPTANCE, stated once and reused by the revert-check both ways: given a
 * module, prove that the marker DEFERS the materialization (route NEVER reached,
 * pair 'prepared', record durable) for the head-without-manager case. */
async function acceptanceDeferHeadWithoutManager(mod) {
  await withTempStateDir(async (stateDir) => {
    await writeFile(path.join(stateDir, MARKER), markerFor(QH, QH_SESSION), 'utf8')
    const calls = { informs: [], warns: [], routes: [] }
    const engine = mod.createDeliveryEngine({
      stateDir,
      logger: { info: () => {}, warn: () => {} },
      markPrepared: (rec, rid, opts) => markDelivery(stateDir, rec.id, rid, 'prepared', Date.now(), opts?.noWake === true),
      markFinal: (rec, rid, status, opts) => markDelivery(stateDir, rec.id, rid, status, Date.now(), opts?.noWake === true),
      resolveChild: async () => false,
      deliverChild: async () => 'delivered',
      resolveCatalogRoute: catalogRoute,
      busProfileFor: () => ({ kind: 'head', memberId: SENDER, departmentId: 'dept' }),
      deliverPost: async (entry, framed, rec) => {
        calls.routes.push({ id: rec.id, target: entry.postId })
        await markDelivery(stateDir, rec.id, entry.postId, 'delivered')
        return 'delivered'
      },
      deliverHost: async () => 'delivered'
    })
    const rec = record('m-900', 900, [QH])
    const status = await engine.deliverOrQueue(QH, rec, {})
    assert.equal(status, 'prepared', 'acceptance: the turn is QUEUED, not materialized')
    assert.deepEqual(calls.routes, [], 'acceptance: the route (the materialization) was NEVER reached')
    assert.equal(await deliveryStatus(stateDir, 'm-900', QH), 'prepared', 'acceptance: the pair stays durable \'prepared\' (drains at the next real wake)')
  })
}

// ---------------------------------------------------------------------------
// (i) WORKER WITH A MANAGER crosses the wall → DEFERRED.
// ---------------------------------------------------------------------------
test('CONTEXT-GATE (i): a WORKER whose LIVE session crossed the window is DEFERRED — the turn is queued and the route (the materialization) is never reached', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(path.join(stateDir, MARKER), markerFor(W, W_SESSION), 'utf8')
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, calls)
    const rec = record('m-100', 100, [W])
    const status = await engine.deliverOrQueue(W, rec, {})

    assert.equal(status, 'prepared', 'the turn is QUEUED (\'prepared\') — the same shape as the wired noWake branch')
    assert.deepEqual(calls.routes, [], 'THE MATERIALIZATION IS DEFERRED: the route was never reached')
    assert.equal(await deliveryStatus(stateDir, 'm-100', W), 'prepared', 'the record stays durable \'prepared\' (it drains at the next real wake)')
    assert.equal(await deliveryStatus(stateDir, 'm-100', W), 'prepared', 'no landed row is invented for the deferred pair')
    assert.ok(calls.warns.some((l) => /context-admission gate: DEFERRING materialization/.test(l)), 'the defer is traceable in the log (observability — NOT the acceptance)')
    assert.ok(calls.warns.some((l) => new RegExp(W_SESSION).test(l)), 'the log names the LIVE session the marker anchored')
  })
})

// ---------------------------------------------------------------------------
// (ii) 🔴 HEAD **WITHOUT** A MANAGER → DEFERRED THE SAME WAY (the case that
//   measured the incident; the gate never consults the manager).
// ---------------------------------------------------------------------------
test('CONTEXT-GATE (ii): a HEAD with NO managerId is DEFERRED EXACTLY the same — the gate NEVER depends on «notify the manager» (MEASURED: the flagged post of the incident is a head)', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(path.join(stateDir, MARKER), markerFor(QH, QH_SESSION), 'utf8')
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, calls)
    const rec = record('m-200', 200, [QH])
    const status = await engine.deliverOrQueue(QH, rec, {})

    assert.equal(calls.routes.length, 0, 'THE MATERIALIZATION IS DEFERRED for a head WITHOUT a manager')
    assert.equal(status, 'prepared', 'the head\'s turn is queued — the defer does NOT depend on manager resolution')
    assert.equal(await deliveryStatus(stateDir, 'm-200', QH), 'prepared', 'the pair is durable and drains at the next real wake')
    // The PROOF that no manager was needed: the fixture entry genuinely has NO
    // managerId (the measured class), and the defer still happened.
    const entry = catalogRoute(QH).entry
    assert.equal(entry.managerId, undefined, 'the fixture head carries NO managerId (the MEASURED shape of quality-head / research-head / internal-programming-head)')
    assert.equal(entry.provider, 'head', 'and it is a configured head')
  })
})

// ---------------------------------------------------------------------------
// (iii) 🔴 THE MARKER WHOSE `sessionId` DOES NOT MATCH (the post ALREADY
//   ROTATED) → **NOT** DEFERRED. The successor is a fresh, sane session.
// ---------------------------------------------------------------------------
test('CONTEXT-GATE (iii): a marker naming a PREVIOUS session (the post ALREADY ROTATED) does NOT defer — the SUCCESSOR is woken and the delivery lands', async () => {
  await withTempStateDir(async (stateDir) => {
    // The marker is the SURVIVING 24 h episode of the ROTATED incarnation.
    await writeFile(path.join(stateDir, MARKER), markerFor(ROT, ROT_OLD), 'utf8')
    const calls = { informs: [], warns: [], routes: [] }
    const engine = makeEngine(stateDir, calls)
    const rec = record('m-300', 300, [ROT])
    const status = await engine.deliverOrQueue(ROT, rec, {})

    assert.deepEqual(calls.routes, [{ id: 'm-300', target: ROT }], 'THE SUCCESSOR IS MATERIALIZED: the route IS reached (the live session is NOT the flagged one)')
    assert.equal(status, 'delivered', 'the rotated post\'s successor receives the turn normally')
    assert.equal(await deliveryStatus(stateDir, 'm-300', ROT), 'delivered', 'the pair lands — the whole point: a stale agentId-keyed marker never blocks a live session')
    assert.ok(!calls.warns.some((l) => /context-admission gate: DEFERRING/.test(l)), 'NO defer was logged for the successor')
  })
})

// ---------------------------------------------------------------------------
// (iv) FAIL-OPEN: absent / malformed / sessionId-less / stale marker → the
//   delivery proceeds UNCHANGED and NOTHING throws.
// ---------------------------------------------------------------------------
test('CONTEXT-GATE (iv): an ABSENT / MALFORMED / sessionId-less / STALE marker is FAIL-OPEN — the delivery proceeds unchanged and nothing throws', async () => {
  const cases = [
    ['absent file', undefined],
    ['malformed JSON', '{ this is not json'],
    ['a JSON array (wrong shape)', '[]'],
    ['an entry without sessionId', JSON.stringify({ [W]: { at: NOW - 1000, action: 'compact-or-rotate', phase: 'beyond-usable-window', pct: 1 } })],
    ['an entry with an EMPTY sessionId', JSON.stringify({ [W]: { sessionId: '', at: NOW - 1000 } })],
    ['an entry with a non-finite `at`', JSON.stringify({ [W]: { sessionId: W_SESSION, at: 'yesterday' } })],
    ['a STALE marker (older than the actuator\'s 24 h retention)', markerFor(W, W_SESSION, NOW - 25 * 60 * 60 * 1000)],
    ['no entry for THIS recipient', markerFor('some-other-post', 'sess-other')],
    ['a null entry', JSON.stringify({ [W]: null })]
  ]
  for (const [label, marker] of cases) {
    const r = await runOnce({ recipientId: W, marker })
    assert.deepEqual(r.calls.routes, [{ id: 'm-500', target: W }], `FAIL-OPEN (${label}): the route IS reached (no defer)`)
    assert.equal(r.status, 'delivered', `FAIL-OPEN (${label}): the delivery resolves 'delivered' exactly as with no marker at all`)
    assert.ok(!r.calls.warns.some((l) => /context-admission gate: DEFERRING/.test(l)), `FAIL-OPEN (${label}): no defer was logged`)
  }
})

// ---------------------------------------------------------------------------
// (iii-b) the REROUTE safety: a retired host-family address re-routes to its
//   LIVE SUCCESSOR — the marker of the RETIRED addressed id must never park it
//   (the real target is a different, healthy session).
// ---------------------------------------------------------------------------
test('CONTEXT-GATE (iii-b): a REROUTE (retired host → live successor) is NEVER deferred by the marker of the retired addressed id', async () => {
  const RETIRED = 'host-session-fixture-retired'
  const SUCCESSOR = 'host-session-fixture-successor'
  await withTempStateDir(async (stateDir) => {
    await writeFile(path.join(stateDir, MARKER), markerFor(RETIRED, 'sess-of-the-retired-id'), 'utf8')
    const calls = { informs: [], warns: [], routes: [] }
    const engine = createDeliveryEngine({
      stateDir,
      logger: { info: () => {}, warn: () => {} },
      markPrepared: (rec, rid, opts) => markDelivery(stateDir, rec.id, rid, 'prepared', Date.now(), opts?.noWake === true),
      markFinal: (rec, rid, status, opts) => markDelivery(stateDir, rec.id, rid, status, Date.now(), opts?.noWake === true),
      resolveChild: async () => false,
      deliverChild: async () => 'delivered',
      resolveCatalogRoute: () => ({ kind: 'reroute', entry: { hostId: SUCCESSOR, sessionId: 'sess-of-the-LIVE-successor', roomId: 'board', retired: false } }),
      busProfileFor: () => ({ kind: 'head', memberId: SENDER, departmentId: 'dept' }),
      deliverPost: async () => 'delivered',
      deliverHost: async (entry, framed, rec) => {
        calls.routes.push({ id: rec.id, target: entry.hostId })
        await markDelivery(stateDir, rec.id, entry.hostId, 'delivered')
        return 'delivered'
      }
    })
    const rec = record('m-700', 700, [RETIRED])
    const status = await engine.deliverOrQueue(RETIRED, rec, {})
    assert.deepEqual(calls.routes, [{ id: 'm-700', target: SUCCESSOR }], 'the re-route reaches the LIVE SUCCESSOR (the retired id\'s marker never parks a healthy target)')
    assert.equal(status, 'delivered', 'the delivery lands at the successor')
  })
})

// ---------------------------------------------------------------------------
// THE TWO-TREE ACCEPTANCE: the SAME record, catalog and engine — the marker is
// the ONLY difference. Without it the turn IS materialized; with it, it is NOT.
// ---------------------------------------------------------------------------
test('CONTEXT-GATE (ACCEPTANCE, two trees): the SAME delivery WITHOUT the marker is MATERIALIZED and WITH the marker is NOT — the marker is the only difference', async () => {
  const without = await runOnce({ recipientId: W })
  const withMarker = await runOnce({ recipientId: W, marker: markerFor(W, W_SESSION) })

  // Without the marker: the ALWAYS-WAKE path, byte-identical to today.
  assert.deepEqual(without.calls.routes, [{ id: 'm-500', target: W }], 'WITHOUT the marker the route IS reached (the turn materializes — today\'s behavior)')
  assert.equal(without.status, 'delivered', 'WITHOUT the marker the delivery lands')

  // With the marker: deferred.
  assert.deepEqual(withMarker.calls.routes, [], 'WITH the marker the route is NEVER reached (the turn is DEFERRED)')
  assert.equal(withMarker.status, 'prepared', 'WITH the marker the outcome is the queue (\'prepared\')')
  const landed = withMarker.rows.filter((r) => r.messageId === 'm-500' && r.recipientId === W && r.status === 'delivered')
  assert.equal(landed.length, 0, 'WITH the marker NO landed row exists (nothing was materialized)')
})

// ---------------------------------------------------------------------------
// (v) THE INTENT SEAL — the deferral must NOT be crash-class. A bare 'prepared'
//   row is what the ~10-min prepared-stuck sweep re-drives (the measured fb-150
//   spool: 28 'prepared' rows / 0 terminals in ~2.4h): the sweep would wake the
//   SAME dead session every pass. The defer seals its row exactly like the wired
//   noWake branch (the m-707 vocabulary: «a DELIBERATE no-wake-until-wake,
//   never a crash»), so the P2 guard recognizes the intent.
// ---------------------------------------------------------------------------
test('CONTEXT-GATE (v): the deferred row carries the NO-WAKE intent seal (never crash-class) — the ~10-min sweep cannot re-drive it into the dead session every pass', async () => {
  const r = await runOnce({ recipientId: W, marker: markerFor(W, W_SESSION) })
  const pair = r.rows.filter((row) => row.messageId === 'm-500' && row.recipientId === W)
  assert.ok(pair.length >= 2, 'the write-ahead + the final mark both landed (the persist-before-deliver contract)')
  const latest = pair.at(-1)
  assert.equal(latest.status, 'prepared', 'the pair-latest is \'prepared\' (queued, not materialized)')
  assert.equal(latest.noWake, true, 'THE SEAL: the pair-latest carries the no-wake intent — without it the sweep treats the row as CRASH-CLASS and re-drives it into the same dead session forever (the fb-150 spool class)')
  // The PAIR-LATEST is the row the consumers read (`latestPerKey` in the sweep's
  // P2 guard + `summarizePreparedState`), so the seal is where it must be. The
  // write-ahead row is NOT sealed — and that is structural, not an oversight: the
  // deferral is decided AFTER the route (the identity comparison needs the route
  // entry) while `markPrepared` runs before it. A wired noWake send can seal both
  // because its intent is known up-front; a deferral cannot, and does not need to.
  assert.equal(pair[0].noWake, undefined, 'the write-ahead row is NOT sealed (the defer is decided after the route — the pair-LATEST is what every consumer reads)')

  // The CONTROL: without the gate (no marker) the landed row is NOT sealed —
  // the seal is the deferral's mark, not a global change to the row shape.
  const without = await runOnce({ recipientId: W })
  const landed = without.rows.filter((row) => row.messageId === 'm-500' && row.recipientId === W).at(-1)
  assert.equal(landed.status, 'delivered', 'the control delivery landed')
  assert.equal(landed.noWake, undefined, 'the control\'s row is unsealed — the seal is specific to the deferral (no global row-shape change)')
})

// ---------------------------------------------------------------------------
// THE REVERT-CHECK (MANDATORY — «con el gate neutralizado, el test se pone
// ROJO», DEMONSTRATED, never asserted). The gate's door is neutralized in a
// TEXTUAL COPY of the module held in a TEMP dir (ZERO writes inside the repo),
// and the acceptance above is re-run against it: it must THROW there and PASS
// on the real module — falsifiable in BOTH directions.
// ---------------------------------------------------------------------------
test('CONTEXT-GATE REVERT-CHECK: with the gate\'s door neutralized to `if (false)` the acceptance THROWS (the materialization happens again) and it PASSES on the real module', async () => {
  const srcDir = path.join(import.meta.dirname, '..', 'packages', 'dshd-core', 'src')
  const source = await readFile(path.join(srcDir, 'delivery.ts'), 'utf8')

  // The MINIMAL mechanical revert: the gate's own door. `contextAdmissionProbe`
  // still runs (its read, its comparison, its logging — everything the
  // instrument does stays); ONLY the decision is gone. That is what makes the
  // revert HONEST: it disables the GATE, not the reading.
  const DOOR = 'if (deferred !== undefined) {'
  const occurrences = source.split(DOOR).length - 1
  assert.equal(occurrences, 1, 'the gate\'s door is found EXACTLY once (a revert that matches nothing proves nothing)')
  const reverted = source.replace(DOOR, 'if (false) {')
  assert.notEqual(reverted, source, 'the revert actually changed the source')

  const H = await import('../packages/dshd-core/src/delivery.ts') // the REAL module
  await withTempStateDir(async (tmp) => {
    // The reverted copy lives in a TEMP dir. Its relative sibling imports
    // (`./messages.js`, `./acl.js`, `./registry.js`) are rewritten to the REPO
    // src — the copy then links against the REAL modules, so ONLY the gate door
    // differs (zero writes inside the repo: this test file is the lane's only
    // new repo artifact).
    const specRe = new RegExp('(from\\s+[\'"])(\\.\\/[a-z-]+)(\\.js)([\'"])', 'g')
    const retargeted = reverted.replace(specRe, (_m, a, rel, _js, z) => `${a}${path.join(srcDir, rel.slice(2) + '.ts')}${z}`)
    assert.notEqual(retargeted, reverted, 'the relative sibling imports were retargeted to the repo src (the real modules)')
    const revertedPath = path.join(tmp, 'reverted-delivery.ts')
    await writeFile(revertedPath, retargeted, 'utf8')
    const R = await import(pathToFileURL(revertedPath).href)

    // The REAL module PASSES the acceptance (falsifiable in both directions).
    await acceptanceDeferHeadWithoutManager(H)

    // The REVERTED module must FAIL it — and the failure must be the DEFER
    // being gone (the route reached again), never an unrelated load error.
    let caught
    try {
      await acceptanceDeferHeadWithoutManager(R)
    } catch (error) {
      caught = error
    }
    assert.ok(caught !== undefined, 'REVERT PROOF: the acceptance MUST fail on the reverted tree — it held, so the revert is not real and this test proves nothing')
    assert.equal(caught.code, 'ERR_ASSERTION', `REVERT PROOF: the failure is the ACCEPTANCE assertion (the defer is gone), not a load error — measured: ${caught.code ?? caught.message}`)
    assert.match(caught.message, /never reached|QUEUED/, 'REVERT PROOF: and it failed on the materialization observable (the route was reached again)')
  })
})
