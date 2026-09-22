// dsh-deepartments — LANE `dead-reader-usage` (2026-09-22). Run token: 08ec4bac.
//
// THE DEFECT THIS FILE PINS (measured, not inferred). `deriveTurnErrorAttribution`
// read the request usage from an event type the harness STOPPED EMITTING:
//     event.type === 'assistant/chunk' && data.chunk.type === 'usage'
//
// MEASUREMENTS (each one states its PATTERN and its SCOPE):
//   · Pattern `"type":"assistant/chunk"`, scope = every `*.jsonl.zstd` under
//     /opt/dsh/.dsh-dev/sessions + sessions-cold, 60 largest-first files: the
//     v3 logs carry 0 `assistant/chunk` events and 4,016
//     `assistant/message.data.usage`; 55 legacy logs carry 20,555 chunk-usage
//     events (the retired vocabulary really did exist — the reader was correct
//     once and became a dead reader when the vocabulary moved).
//   · Pattern `assistant/message` with `data.usage`, scope = same 60 files:
//     15,114 / 15,126 assistant/message events carry `data.usage`; 15,114 /
//     15,114 of those carry inputTokens>0 AND outputTokens>0; cacheReadTokens in
//     15,039 (sample {inputTokens:709,outputTokens:397,cacheReadTokens:9728}).
//   · Pattern `assistant/attempt.data.stream[].chunk.usage`, scope = same 60
//     files: 152 occurrences, ALL of them usage(0,0) — the FAILED attempt's own
//     stream (dsh-agent-loop lib/index.js:1083-1087 appends it on the error
//     path). Deliberately NOT read: it would restore the useless zero.
//   · The host's own transcript: assistant/message 1376 · assistant/attempt 149
//     · assistant/chunk 0.
//
// THE FAILURE MODE IS SILENCE: the reader returned no `lastUsage` and the
// silence read as "there is no usage to measure" — exactly the class this lane
// removes.
//
// WHAT THIS TEST MEASURES (the EFFECT, end to end, not "it reads a field"): the
// REAL `runHealthDaemonTick` on a stateDir fixture runs `scanTurnErrorCaptures`
// → `appendPostError` and WRITES `post-errors.jsonl`. The assertion reads the
// FILE BACK with the real `readPostErrorsFile` and demands a row carrying
// `lastUsage` whose VALUES are the ones the live carrier held. The A/B is the
// same test against the pre-fix source:
//   PRE :  HEALTH_SRC=file:///<ruta FUERA DEL ÁRBOL>/pre/index.ts node --test <this file>  ⇒ MUST FAIL
//   POST:  node --test <this file>                                                         ⇒ MUST PASS
// ⚠️ THE PRE IMAGE IS GENERATED ON DEMAND, NEVER STORED IN THE TREE (commit trap — the
// host measured one such leftover at 664.770 B): `git show
// HEAD:packages/dshd-health/src/index.ts` IS the pre-image byte for byte (md5
// 944b1d76c6a1a1964da551f26cf7e767), so the A/B needs no backup file. Write it to a
// temp dir OUTSIDE the repo (this lane used the department workspace scratch dir) and
// delete it — a copy under packages/dshd-health/test/ would enter the commit forever.
// The default path below is the repo source, so the POST run needs no env var at all.
//
// WHAT THIS TEST DOES NOT MEASURE (declared, not papered over): the real
// `/.deepartments/post-errors.jsonl` row appearing in production needs a LIVE
// turn to FAIL — no unit test can provoke that. So: this test proves the reader
// CONSUMES the live type and the row is WRITTEN with the datum; the production
// effect will be verified when the next live turn-error happens (and the host's
// `smart_restart` is what makes the compiled lib/ carry this source). See the
// lane report.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The module under test: the package's src by default, or the PRE copy via env
// (the same PRE/POST seam the sibling lane test recipient-starvation-c0e965db
// uses, so the A/B needs no edit of this file).
const HEALTH_SRC = process.env.HEALTH_SRC ?? new URL('../src/index.ts', import.meta.url).href
const H = await import(HEALTH_SRC)
const { runHealthDaemonTick, readPostErrorsFile } = H

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0)
const MIN = 60_000

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dead-reader-usage-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** ONE live-vocabulary session log: a session cwd, a request/header, the
 * `assistant/message` usage events the harness ACTUALLY writes today
 * (dsh-session types:309-317 / dsh-agent-loop lib/index.js:1108-1114) and a
 * fatal error turn/end — NO `assistant/chunk` anywhere, because the harness no
 * longer emits it (measured: 0 in the v3 corpus). */
function liveVocabEvents() {
  return [
    { type: 'session', time: T0 - 300_000, cwd: '/root/.deepartments/departments/internal-programming' },
    { type: 'request/header', time: T0 - 290_000, data: { header: { config: { provider: 'opencode-zen', model: 'deepseek-v4-flash' } } } },
    // the FIRST assembled message of the turn, usage WITH cacheReadTokens
    { type: 'assistant/message', time: T0 - 60_000, data: { turn: 7, step: 1, usage: { inputTokens: 709, outputTokens: 397, cacheReadTokens: 9728 } } },
    // the LAST one before the failure — the pair the row must carry
    { type: 'assistant/message', time: T0 - 30_000, data: { turn: 7, step: 2, usage: { inputTokens: 15234, outputTokens: 811, cacheReadTokens: 98304 } } },
    // the failed attempt's OWN stream: measured ALL-ZERO — a trap, must NOT win
    { type: 'assistant/attempt', time: T0 - 1_000, data: { turn: 7, step: 3, stream: [{ type: 'chunk', time: T0 - 1_000, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }] } },
    { type: 'turn/end', time: T0, data: { turn: 7, reason: { kind: 'error', error: { message: '400 status code (no body)', code: 'CONTEXT_WINDOW_EXCEEDED' } } } }
  ]
}

function tickDeps({ stateDir, nowMs, posts }) {
  return {
    now: () => nowMs,
    stateDir,
    bootId: 'boot-dead-reader-usage-08ec4bac',
    hosts: [{ hostId: 'host-asst', sessionId: 's-live' }],
    posts,
    notifyHost: async () => {},
    logger: { warn: () => {} }
  }
}

const readRaw = async (stateDir) => {
  const { readFile } = await import('node:fs/promises')
  return readFile(path.join(stateDir, 'post-errors.jsonl'), 'utf8')
}

// ---------------------------------------------------------------------------
// (1) THE ACCEPTANCE — BY EFFECT: the real tick WRITES a post-errors row that
//     carries `lastUsage` with the values of the LIVE carrier.
//     PRE (HEAD source): the reader finds nothing (0 rows with lastUsage) ⇒ RED.
//     POST: the row lands with the datum ⇒ GREEN.
// ---------------------------------------------------------------------------
test('LANE dead-reader-usage: el tick REAL escribe una fila de post-errors.jsonl CON lastUsage leído del tipo VIVO (assistant/message) — ANTES del cambio esta prueba FALLA (0 filas con lastUsage)', async () => {
  await withTempStateDir(async (stateDir) => {
    const posts = [{ postId: 'builder-x', sessionId: 'session-x', retired: false, events: liveVocabEvents() }]
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0 + 1000, posts }))

    // THE EFFECT, read from the FILE the reader writes — the same file the host
    // pointed at (/.deepartments/post-errors.jsonl = 3 rows, 0 with lastUsage).
    const rows = readPostErrorsFile(stateDir)
    assert.equal(rows.length, 1, 'POST: el tick REAL registra UNA fila de post-error (el turn/end de error)')
    assert.equal(rows[0].postId, 'builder-x', 'POST: la fila es del post que falló')
    assert.equal(rows[0].turn, 7, 'POST: la fila lleva el turn que falló')
    assert.equal(rows[0].route, 'opencode-zen/deepseek-v4-flash', 'POST: la atribución de ruta sigue intacta (fb-235, no regresión)')
    assert.equal(rows[0].workspace, '/root/.deepartments/departments/internal-programming', 'POST: la atribución de workspace sigue intacta (fb-235, no regresión)')

    // ★ THE LANE'S DATUM: the row carries lastUsage AT ALL.
    assert.notEqual(rows[0].lastUsage, undefined, '★★ POST: la fila lleva lastUsage — el lector CONSUME el tipo vivo (PRE: undefined, la fila se escribía sin uso)')
    // …and it carries the values of the LAST live carrier, not the all-zero
    // attempt stream and not the first message.
    assert.deepEqual(rows[0].lastUsage, { inputTokens: 15234, cacheReadTokens: 98304 }, '★★ POST: lastUsage = el ÚLTIMO assistant/message antes del fallo (inputTokens 15234 + cacheReadTokens 98304); NO el usage(0,0) del attempt fallido')
    // The raw file agrees with the parsed row (the datum really is ON DISK).
    const raw = await readRaw(stateDir)
    assert.match(raw, /"lastUsage":\{"inputTokens":15234,"cacheReadTokens":98304\}/, 'POST: el dato está EN EL FICHERO (post-errors.jsonl), no solo en memoria')
    assert.doesNotMatch(raw, /"turn\/end"|assistant\/chunk/, 'POST: la fila NO arrastra vocabulario retirado')
  })
})

// ---------------------------------------------------------------------------
// (2) THE LEGACY SHAPE SURVIVES (R6): a session log carrying ONLY the retired
//     `assistant/chunk` chunk-usage of the v2 corpus still yields lastUsage.
//     This is what keeps the fb-235 contract whole while the source is widened.
// ---------------------------------------------------------------------------
test('LANE dead-reader-usage R6: un log con SOLO el vocabulario retirado (assistant/chunk + chunk.type=usage, el corpus v2) sigue produciendo lastUsage — la ampliación es aditiva, no un reemplazo', async () => {
  await withTempStateDir(async (stateDir) => {
    const posts = [{
      postId: 'legacy-post',
      sessionId: 'session-legacy',
      retired: false,
      events: [
        { type: 'session', time: T0 - 300_000, cwd: '/root/.deepartments/departments/quality' },
        { type: 'assistant/chunk', time: T0 - 30_000, data: { turn: 4, step: 1, chunk: { type: 'usage', usage: { inputTokens: 11184, outputTokens: 2087 } } } },
        { type: 'turn/end', time: T0, data: { turn: 4, reason: { kind: 'error', message: 'no provider' } } }
      ]
    }]
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0 + 1000, posts }))
    const rows = readPostErrorsFile(stateDir)
    assert.equal(rows.length, 1, 'R6: el turn de error se sigue capturando')
    assert.deepEqual(rows[0].lastUsage, { inputTokens: 11184 }, 'R6: el vocabulario retirado sigue rindiendo lastUsage (cacheReadTokens ausente ⇒ omitido, aditivo)')
  })
})

// ---------------------------------------------------------------------------
// (3) NO FABRICATION (R6): a log with NO usage carrier at all writes the row
//     with NO lastUsage key — the fix widens the source, it does not invent a
//     datum (and the fb-251 usage(0,0) of a rejected request is still a real
//     value when the carrier holds it, not a substitute for a missing one).
// ---------------------------------------------------------------------------
test('LANE dead-reader-usage R6: sin ningún carrier de usage la fila se escribe SIN lastUsage (el arreglo no fabrica el dato)', async () => {
  await withTempStateDir(async (stateDir) => {
    const posts = [{
      postId: 'no-usage-post',
      sessionId: 'session-nousage',
      retired: false,
      events: [
        { type: 'request/header', time: T0 - 10_000, data: { header: { config: { provider: 'opencode-zen', model: 'deepseek-v4-flash' } } } },
        { type: 'turn/end', time: T0, data: { turn: 2, reason: { kind: 'error', message: 'no provider' } } }
      ]
    }]
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0 + 1000, posts }))
    const rows = readPostErrorsFile(stateDir)
    assert.equal(rows.length, 1, 'R6: la fila se escribe (la captura no depende del usage)')
    assert.equal(rows[0].lastUsage, undefined, 'R6: sin carrier ⇒ SIN lastUsage (ni 0 ni inventado)')
    assert.equal(rows[0].route, 'opencode-zen/deepseek-v4-flash', 'R6: el resto de la atribución sigue viva')
  })
})
