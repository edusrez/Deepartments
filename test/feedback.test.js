// dsh-deepartments — dshd-feedback package unit tests (m-371 feedback store).
//
// The FeedbackStore is a standalone fs module (no cordis services), so these
// are hermetic unit tests against the compiled lib/ — the same direct-test shape
// as test/messages-store.test.js: temp stateDirs, no network, no live DSH_HOME.
// (pnpm build first.)
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_LIVE_CAP,
  FEEDBACK_ARCHIVE_FILE,
  FEEDBACK_FILE,
  FeedbackStore,
  SEVERITY_RANK,
  feedbackTransitionError,
  isTerminalEstado,
  loadFeedbackRecords,
  parseFeedbackRecords,
  parseFeedbackSeq,
  resolveFeedbackArchivePath,
  resolveFeedbackPath
} from '../lib/feedback.js'

function fbRecord(seq, overrides = {}) {
  const ts = 1700000000000 + seq
  return {
    id: `fb-${seq}`,
    createdAt: ts,
    updatedAt: ts,
    emisor: 'worker-1',
    source: 'dshd-feedback',
    tipo: 'fallo',
    severidad: 'medio',
    estado: 'abierto',
    resumen: `resumen-${seq}`,
    ...overrides
  }
}

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-fb-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

// --- pure machine helpers ----------------------------------------------------

test('isTerminalEstado: resuelto/descartado are terminal, abierto/en-estudio open', () => {
  assert.equal(isTerminalEstado('resuelto'), true)
  assert.equal(isTerminalEstado('descartado'), true)
  assert.equal(isTerminalEstado('abierto'), false)
  assert.equal(isTerminalEstado('en-estudio'), false)
})

test('feedbackTransitionError: terminal never transitions; reopen only from en-estudio; same-state no-op', () => {
  // terminal → anything is blocked (incl. reopen).
  assert.ok(feedbackTransitionError('resuelto', 'abierto') !== undefined)
  assert.ok(feedbackTransitionError('descartado', 'en-estudio') !== undefined)
  // reopen to abierto requires the current estado to be en-estudio.
  assert.ok(feedbackTransitionError('abierto', 'abierto') === undefined, 'same-state no-op allowed')
  assert.ok(feedbackTransitionError('abierto', 'en-estudio') === undefined)
  assert.ok(feedbackTransitionError('abierto', 'resuelto') === undefined)
  assert.ok(feedbackTransitionError('en-estudio', 'abierto') === undefined, 'reopen from en-estudio allowed')
  assert.ok(feedbackTransitionError('en-estudio', 'resuelto') === undefined)
  assert.ok(feedbackTransitionError('abierto', 'descartado') === undefined)
})

test('parseFeedbackSeq: parses fb-<seq>; unknown/negative → -1', () => {
  assert.equal(parseFeedbackSeq('fb-0'), 0)
  assert.equal(parseFeedbackSeq('fb-42'), 42)
  assert.equal(parseFeedbackSeq('nope'), -1)
})

// --- append ------------------------------------------------------------------

test('append: assigns id fb-<seq> + contiguous seq, flushes JSONL, updates live-by-id', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    assert.equal(store.size, 0)

    const first = await store.append({ emisor: 'worker-1', tipo: 'fallo', severidad: 'critico', resumen: 'breakage', evidencia: 'trace-1', archivo_linea: 'src/invoke.ts:100' })
    assert.equal(first.id, 'fb-0')
    assert.equal(first.emisor, 'worker-1')
    assert.equal(first.source, 'dshd-feedback', 'default source is dshd-feedback')
    assert.equal(first.tipo, 'fallo')
    assert.equal(first.severidad, 'critico')
    assert.equal(first.estado, 'abierto', 'default estado is abierto')
    assert.equal(first.evidencia, 'trace-1')
    assert.equal(first.archivo_linea, 'src/invoke.ts:100')
    assert.equal(typeof first.createdAt, 'number')
    assert.equal(typeof first.updatedAt, 'number')

    const second = await store.append({ emisor: 'quality-head', tipo: 'mejora', severidad: 'bajo', resumen: 'suggestion' })
    assert.equal(second.id, 'fb-1')
    assert.equal(second.seq === undefined, true, 'no seq field on the record')

    assert.equal(store.size, 2)
    assert.equal(store.get('fb-0').resumen, 'breakage')
    assert.equal(store.get('fb-1').estado, 'abierto')

    const lines = (await readFile(resolveFeedbackPath(stateDir), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 2)
    assert.deepEqual(JSON.parse(lines[0]), first)
  })
})

test('append validation: bad tipo/severidad/emisor/resumen/source throw loud, nothing persisted', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    await assert.rejects(() => store.append({ emisor: 'x', tipo: 'bogus', severidad: 'medio', resumen: 'hi' }), TypeError)
    await assert.rejects(() => store.append({ emisor: 'x', tipo: 'fallo', severidad: 'urgente', resumen: 'hi' }), TypeError)
    await assert.rejects(() => store.append({ emisor: '', tipo: 'fallo', severidad: 'medio', resumen: 'hi' }), TypeError)
    await assert.rejects(() => store.append({ emisor: 'x', tipo: 'fallo', severidad: 'medio', resumen: '' }), TypeError)
    await assert.rejects(() => store.append({ emisor: 'x', tipo: 'fallo', severidad: 'medio', resumen: 'hi', source: 'ghost' }), TypeError)
    assert.equal(store.size, 0, 'a rejected append leaves no record behind')
  })
})

// --- update (append-only state machine) --------------------------------------

test('update: appends a new tail (same id, bumped updatedAt, new estado); cerrado_por stamped on terminal', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    const created = await store.append({ emisor: 'worker-1', tipo: 'fallo', severidad: 'alto', resumen: 'leak' })
    assert.equal(created.id, 'fb-0')
    assert.equal(created.estado, 'abierto')

    const inStudy = await store.update('fb-0', { estado: 'en-estudio', notas_qh: 'looking into it' })
    assert.equal(inStudy.id, 'fb-0')
    assert.equal(inStudy.estado, 'en-estudio')
    assert.equal(inStudy.notas_qh, 'looking into it')
    assert.equal(inStudy.createdAt, created.createdAt, 'createdAt preserved')
    assert.ok(inStudy.updatedAt >= created.updatedAt, 'updatedAt bumped')

    const closed = await store.update('fb-0', { estado: 'resuelto' }, { cerradoPor: 'quality-head' })
    assert.equal(closed.estado, 'resuelto')
    assert.equal(closed.cerrado_por, 'quality-head', 'terminal stamps cerrado_por')
    assert.equal(closed.notas_qh, 'looking into it', 'earlier metadata carried into the tail')

    // The live view = the latest tail; the record is append-only (3 lines, same id).
    assert.equal(store.get('fb-0').estado, 'resuelto')
    const lines = (await readFile(resolveFeedbackPath(stateDir), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 3)
    assert.equal(new Set(lines.map((l) => JSON.parse(l).id)).size, 1, 'all 3 tails share the SAME id')
    assert.deepEqual(JSON.parse(lines[2]), closed)
  })
})

test('update: terminal state blocks further transitions; reopen only from en-estudio', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    const created = await store.append({ emisor: 'worker-1', tipo: 'fallo', severidad: 'medio', resumen: 'x' })
    await store.update('fb-0', { estado: 'descartado' }, { cerradoPor: 'quality-head' })
    // A terminal record can never transition again (reopen is NEVER allowed).
    await assert.rejects(() => store.update('fb-0', { estado: 'abierto' }), /terminal/)
    await assert.rejects(() => store.update('fb-0', { estado: 'en-estudio' }), /terminal/)

    // A reopen is fine only from en-estudio → abierto (new evidence).
    const created2 = await store.append({ emisor: 'worker-2', tipo: 'mejora', severidad: 'bajo', resumen: 'y' })
    await store.update('fb-1', { estado: 'en-estudio' })
    const reopened = await store.update('fb-1', { estado: 'abierto', notas_qh: 'new evidence surfaced' })
    assert.equal(reopened.estado, 'abierto')
    assert.equal(reopened.notas_qh, 'new evidence surfaced')
    assert.equal(created2.estado, 'abierto')
  })
})

test('update: unknown id throws loud', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    await assert.rejects(() => store.update('fb-99', { estado: 'en-estudio' }), /no record with id "fb-99"/)
  })
})

// --- list (surfacing) --------------------------------------------------------

test('list: filters + sorts severity desc then createdAt asc, paged with an exclusive cursor', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    await store.append({ emisor: 'w1', tipo: 'fallo', severidad: 'bajo', resumen: 'low' })
    await store.append({ emisor: 'w2', tipo: 'fallo', severidad: 'critico', resumen: 'crit' })
    await store.append({ emisor: 'w1', tipo: 'mejora', severidad: 'alto', resumen: 'high-mejora' })
    await store.append({ emisor: 'w3', tipo: 'fallo', severidad: 'medio', resumen: 'mid' })
    const full = store.list()
    assert.equal(full.total, 4)
    assert.equal(full.remaining, 0)
    assert.deepEqual(full.items.map((r) => r.resumen), ['crit', 'high-mejora', 'mid', 'low'], 'severity desc, then createdAt asc')

    // Filter by estado.
    await store.update('fb-0', { estado: 'resuelto' }, { cerradoPor: 'quality-head' })
    const open = store.list({ estado: 'abierto' })
    assert.equal(open.total, 3)

    // Filter by severity.
    const crit = store.list({ severidad: 'critico' })
    assert.equal(crit.total, 1)
    assert.equal(crit.items[0].resumen, 'crit')

    // Filter by emisor.
    const byW1 = store.list({ emisor: 'w1' })
    assert.equal(byW1.total, 2)

    // Cursor paging (exclusive): page 1 = first 1 (most severe), then next.
    const page1 = store.list({ limit: 1 })
    assert.equal(page1.total, 4)
    assert.deepEqual(page1.items.map((r) => r.resumen), ['crit'])
    assert.equal(page1.remaining, 3)
    assert.equal(page1.cursor, 'fb-1')
    const page2 = store.list({ limit: 1, cursor: page1.cursor })
    assert.deepEqual(page2.items.map((r) => r.resumen), ['high-mejora'])
    assert.equal(page2.remaining, 2)

    // A cursor missing from the list clamps to the start (defensive).
    const clamped = store.list({ limit: 2, cursor: 'fb-999' })
    assert.deepEqual(clamped.items.map((r) => r.resumen), ['crit', 'high-mejora'])

    // An empty list: no cursor.
    const none = store.list({ severidad: 'critico', estado: 'descartado' })
    assert.equal(none.total, 0)
    assert.equal(none.cursor, undefined)
  })
})

// --- re-open / parse ---------------------------------------------------------

test('re-open: index + append counter rebuilt; append continues contiguously (no seq reuse)', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    await store.append({ emisor: 'w1', tipo: 'fallo', severidad: 'medio', resumen: 'a' })
    await store.append({ emisor: 'w2', tipo: 'mejora', severidad: 'bajo', resumen: 'b' })

    const reopened = await FeedbackStore.open(stateDir)
    assert.equal(reopened.size, 2)
    assert.equal(reopened.get('fb-0').resumen, 'a')
    assert.equal(reopened.get('fb-1').resumen, 'b')

    const third = await reopened.append({ emisor: 'w3', tipo: 'fallo', severidad: 'alto', resumen: 'c' })
    assert.equal(third.id, 'fb-2', 'counter seeded from max seq + 1 — no reuse, no gaps')
  })
})

test('parse: missing file → empty; trailing partial line dropped; malformed non-final throws loud', async () => {
  await withTempStateDir(async (stateDir) => {
    assert.equal((await FeedbackStore.open(stateDir)).size, 0, 'missing file → empty store')

    const filePath = resolveFeedbackPath(stateDir)
    await writeFile(filePath, jsonl([fbRecord(0), fbRecord(1)]) + '{"id": "fb-2", "createdAt": 1, "trunca', 'utf8')
    const tolerant = await FeedbackStore.open(stateDir)
    assert.equal(tolerant.size, 2, 'a crash mid-append leaves a trailing partial line — dropped')

    await writeFile(filePath, jsonl([fbRecord(0), fbRecord(1)]) + 'NOT JSON\n', 'utf8')
    await assert.rejects(() => FeedbackStore.open(stateDir), /malformed record on line 3/, 'mid-file corruption fails loud')
  })
})

// --- boot prune-to-cap (R6, non-destructive) --------------------------------

test('open: when the live file exceeds liveCap, OLDEST TERMINAL records move to the archive (no destructive delete)', async () => {
  await withTempStateDir(async (stateDir) => {
    const filePath = resolveFeedbackPath(stateDir)
    // 6 records: fb-0..fb-5. Terminal: fb-0 (resuelto), fb-1 (descartado), fb-5 (resuelto).
    // Open: keep 2 terminal + en-estudio. Live cap = 4 → evict the 2 oldest terminal (fb-0, fb-5?) 
    // Note: eviction is by FINAL updatedAt oldest-first. Let's make fb-0 / fb-1 the oldest terminals.
    const records = [
      fbRecord(0, { estado: 'resuelto', cerrado_por: 'quality-head', updatedAt: 1700000000100 }),
      fbRecord(1, { estado: 'descartado', cerrado_por: 'quality-head', updatedAt: 1700000000200 }),
      fbRecord(2, { estado: 'en-estudio', updatedAt: 1700000000300 }),
      fbRecord(3, { estado: 'abierto', updatedAt: 1700000000400 }),
      fbRecord(4, { estado: 'abierto', updatedAt: 1700000000500 }),
      fbRecord(5, { estado: 'resuelto', cerrado_por: 'quality-head', updatedAt: 1700000000600 })
    ]
    await writeFile(filePath, jsonl(records), 'utf8')

    const store = await FeedbackStore.open(stateDir, { liveCap: 4 })
    // 6 lines > 4 cap → evict the 2 oldest TERMINAL logical records (fb-0, fb-1).
    // The 2 non-terminal (fb-2 en-estudio, fb-3/fb-4 abierto) + terminal fb-5 stay.
    assert.equal(store.size, 4, 'live file reduced to the cap (4 lines)')
    assert.equal(store.get('fb-0'), undefined, 'oldest terminal record evicted from the live view')
    assert.equal(store.get('fb-1'), undefined)
    assert.equal(store.get('fb-5').estado, 'resuelto', 'newest terminal stays (within cap)')
    assert.equal(store.get('fb-2').estado, 'en-estudio', 'non-terminal never pruned')
    assert.equal(store.get('fb-3').estado, 'abierto')

    // The evicted lines are preserved in the archive (append-only, never deleted).
    const archive = (await readFile(resolveFeedbackArchivePath(stateDir), 'utf8')).split('\n').filter(Boolean)
    assert.equal(archive.length, 2)
    assert.equal(JSON.parse(archive[0]).id, 'fb-0')
    assert.equal(JSON.parse(archive[1]).id, 'fb-1')
    assert.equal(JSON.parse(archive[0]).cerrado_por, 'quality-head', 'the full evicted record is preserved')

    // The live file was rewritten atomically (tmp+rename) + a prune backup exists.
    const after = await loadFeedbackRecords(filePath)
    assert.deepEqual(after.map((r) => r.id), ['fb-2', 'fb-3', 'fb-4', 'fb-5'])
    const bakExists = await readFile(`${filePath}.bak-${Date.now()}-prune`, 'utf8').then(() => true).catch(() => false)
    // The backup name embeds the timestamp — any feedback.jsonl.bak-<ts>-prune is valid.
    const { readdir } = await import('node:fs/promises')
    const baks = (await readdir(stateDir)).filter((name) => /^feedback\.jsonl\.bak-.*-prune$/.test(name))
    assert.equal(baks.length, 1, 'one prune backup exists')
    void bakExists
  })
})

test('open: when the live file is within cap (or all non-terminal), nothing is pruned', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    // 4 records, all non-terminal.
    await store.append({ emisor: 'w1', tipo: 'fallo', severidad: 'bajo', resumen: 'a' })
    await store.append({ emisor: 'w2', tipo: 'mejora', severidad: 'alto', resumen: 'b' })
    await store.append({ emisor: 'w1', tipo: 'fallo', severidad: 'medio', resumen: 'c' })
    await store.append({ emisor: 'w3', tipo: 'fallo', severidad: 'critico', resumen: 'd' })

    const reopened = await FeedbackStore.open(stateDir, { liveCap: 4 })
    assert.equal(reopened.size, 4, 'within cap → no prune')
    const fileText = await readFile(resolveFeedbackPath(stateDir), 'utf8')
    assert.equal(fileText.split('\n').filter(Boolean).length, 4, 'live file unchanged')
  })
})

test('open: default live cap is DEFAULT_LIVE_CAP (200)', () => {
  assert.equal(DEFAULT_LIVE_CAP, 200)
})

test('parseFeedbackRecords: tolerates a trailing partial line (crash mid-append)', () => {
  const parsed = parseFeedbackRecords(jsonl([fbRecord(0)]) + '{"id": "fb-1", "trunca')
  assert.equal(parsed.length, 1)
})

test('resolveFeedbackPath / resolveFeedbackArchivePath', async () => {
  await withTempStateDir(async (stateDir) => {
    assert.equal(resolveFeedbackPath(stateDir), path.join(stateDir, FEEDBACK_FILE))
    assert.equal(resolveFeedbackArchivePath(stateDir), path.join(stateDir, FEEDBACK_ARCHIVE_FILE))
  })
})

test('SEVERITY_RANK orders critico > alto > medio > bajo', () => {
  assert.ok(SEVERITY_RANK.critico > SEVERITY_RANK.alto)
  assert.ok(SEVERITY_RANK.alto > SEVERITY_RANK.medio)
  assert.ok(SEVERITY_RANK.medio > SEVERITY_RANK.bajo)
})
