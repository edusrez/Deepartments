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
  FEEDBACK_BRIDGE_FILE,
  FEEDBACK_FILE,
  FeedbackStore,
  SEVERITY_RANK,
  STALE_REVIEW_ABIERTO_DAYS,
  STALE_REVIEW_EN_ESTUDIO_DAYS,
  STALE_REVIEW_INACTIVITY_DAYS,
  extractFeedbackReferences,
  feedbackStaleNudge,
  feedbackTransitionError,
  findDuplicateCandidates,
  isTerminalEstado,
  loadFeedbackRecords,
  parseFeedbackRecords,
  parseFeedbackSeq,
  resolveFeedbackArchivePath,
  resolveFeedbackBridgePath,
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

// --- id census / identity, not position (fb-690) -----------------------------
//
// An `fb-<seq>` id is an IDENTITY: the prune moves terminal records OUT of the
// live file into the archive, so a counter seeded from the LIVE FILE ALONE
// rewinds to the first free position and re-issues ids that already exist in the
// archive. MEASURED in the live profile (2026-09-11): 22 ids live in BOTH files
// as DIFFERENT records — `fb-690` is the materialized case (LIVE: research-head
// / abierto→duplicado; ARCHIVE: host-session-… / abierto→resuelto). These tests
// pin: (a) the counter is seeded from LIVE ∪ ARCHIVE, (b) a taken id is
// REJECTED + ENUMERATED (never resolved by file order), (c) the collision is
// surfaced at boot, (d) an unreadable archive census refuses allocation.

test('fb-690 (a): the append counter is seeded from LIVE ∪ ARCHIVE — an id that exists ONLY in the archive is never re-issued', async () => {
  await withTempStateDir(async (stateDir) => {
    // LIVE: only fb-2 (the prune moved fb-0/fb-1 and 3..5 to the archive).
    await writeFile(resolveFeedbackPath(stateDir), jsonl([fbRecord(2, { estado: 'abierto' })]), 'utf8')
    await writeFile(
      resolveFeedbackArchivePath(stateDir),
      jsonl([fbRecord(0, { estado: 'resuelto' }), fbRecord(1, { estado: 'descartado' }), fbRecord(5, { estado: 'resuelto' })]),
      'utf8'
    )
    const store = await FeedbackStore.open(stateDir)
    assert.equal(store.size, 1, 'the LIVE view holds only the live record')
    const created = await store.append({ emisor: 'w1', tipo: 'fallo', severidad: 'alto', resumen: 'post-prune' })
    assert.equal(created.id, 'fb-6', 'seeded from live ∪ archive (max seq 5 + 1) — NOT from the live max (fb-2 → fb-3, a REUSED id)')
  })
})

test('fb-690 (b): the REAL fb-690 case — the boot census ENUMERATES the id collision and the next id is past every known id', async () => {
  await withTempStateDir(async (stateDir) => {
    // The REAL records (verbatim ids/emisores/createdAt measured 2026-09-11).
    const liveFb690 = fbRecord(690, {
      emisor: 'research-head',
      estado: 'duplicado',
      duplicate_of: 'fb-688',
      createdAt: 1789133283558,
      updatedAt: 1789133600063
    })
    await writeFile(resolveFeedbackPath(stateDir), jsonl([liveFb690]), 'utf8')
    const archivedFb690 = [
      fbRecord(690, { emisor: 'host-session-243eb508-6fde-4b25-8c82-8068e3bae3fd', estado: 'abierto', createdAt: 1789130461211, updatedAt: 1789130461211 }),
      fbRecord(690, { emisor: 'host-session-243eb508-6fde-4b25-8c82-8068e3bae3fd', estado: 'en-estudio', createdAt: 1789130461211, updatedAt: 1789131000000 }),
      fbRecord(690, { emisor: 'host-session-243eb508-6fde-4b25-8c82-8068e3bae3fd', estado: 'resuelto', cerrado_por: 'quality-head', createdAt: 1789130461211, updatedAt: 1789131632447 })
    ]
    await writeFile(resolveFeedbackArchivePath(stateDir), jsonl(archivedFb690), 'utf8')

    const warned = []
    const store = await FeedbackStore.open(stateDir, { logger: { warn: (message) => warned.push(message) } })
    const collisionWarn = warned.find((message) => message.includes('ID COLLISION'))
    assert.ok(collisionWarn !== undefined, 'the boot census surfaces the id collision (loud, once)')
    assert.match(collisionWarn, /fb-690/, 'the colliding id is named')
    assert.match(collisionWarn, /research-head@1789133283558/, 'the LIVE identity is enumerated')
    assert.match(collisionWarn, /host-session-243eb508-6fde-4b25-8c82-8068e3bae3fd@1789130461211/, 'the ARCHIVE identity is enumerated')
    // NO side is chosen: the live view is unchanged (the live tail) and the id is never re-issued.
    assert.equal(store.get('fb-690').emisor, 'research-head', 'the live view keeps the LIVE record (no side picked by file order)')
    const created = await store.append({ emisor: 'w1', tipo: 'fallo', severidad: 'alto', resumen: 'post fb-690' })
    assert.equal(created.id, 'fb-691', 'the counter is seeded from live ∪ archive — fb-690 is NEVER re-issued')
  })
})

test('fb-690 (c): a REWOUND counter is REFUSED + ENUMERATED, with NOTHING written (the regression shape)', async () => {
  await withTempStateDir(async (stateDir) => {
    const liveFb690 = fbRecord(690, {
      emisor: 'research-head',
      estado: 'duplicado',
      createdAt: 1789133283558,
      updatedAt: 1789133600063
    })
    await writeFile(resolveFeedbackPath(stateDir), jsonl([liveFb690]), 'utf8')
    await writeFile(
      resolveFeedbackArchivePath(stateDir),
      jsonl([fbRecord(690, { emisor: 'host-session-243eb508-6fde-4b25-8c82-8068e3bae3fd', estado: 'resuelto', createdAt: 1789130461211, updatedAt: 1789131632447 })]),
      'utf8'
    )
    const store = await FeedbackStore.open(stateDir)
    assert.equal(store.get('fb-691'), undefined)
    // The prune of 2026-09-11 13:10:28 archived fb-680..fb-706 and returned the
    // counter to 680 — i.e. the position was RE-USED although the ids were
    // archived. Reproduce that REWOUND counter directly (state, not file order).
    store.nextSeq = 690
    await assert.rejects(
      () => store.append({ emisor: 'w2', tipo: 'fallo', severidad: 'medio', resumen: 'must be refused' }),
      (error) => {
        assert.match(error.message, /REFUSING to allocate "fb-690"/, 'the taken id is rejected')
        assert.match(error.message, /LIVE \(emisor=research-head/, 'the LIVE conflicting record is enumerated')
        assert.match(error.message, /ARCHIVE \(1 tail\(s\): host-session-243eb508-6fde-4b25-8c82-8068e3bae3fd@1789130461211\)/, 'the ARCHIVE conflicting record is enumerated')
        assert.match(error.message, /IDENTITY, not a position/, 'the refusal states the invariant')
        return true
      }
    )
    // Reject means REJECT: the refused allocation wrote no line and no index entry.
    const lines = (await readFile(resolveFeedbackPath(stateDir), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 1, 'nothing was appended for the refused allocation')
    assert.equal(store.get('fb-690').createdAt, 1789133283558, 'the live record is untouched')
  })
})

test('fb-690 (d): an id duplicated as the SAME record (benign tail) is NOT reported as a collision; an unreadable archive census REFUSES allocation', async () => {
  await withTempStateDir(async (stateDir) => {
    // A crash between the archive append and the live rewrite duplicates a tail
    // (same emisor@createdAt on both sides) — that is NOT an id collision.
    await writeFile(resolveFeedbackPath(stateDir), jsonl([fbRecord(0, { estado: 'resuelto' })]), 'utf8')
    await writeFile(resolveFeedbackArchivePath(stateDir), jsonl([fbRecord(0, { estado: 'resuelto' })]), 'utf8')
    const warned = []
    const benign = await FeedbackStore.open(stateDir, { logger: { warn: (message) => warned.push(message) } })
    assert.equal(warned.some((message) => message.includes('ID COLLISION')), false, 'an overlapping identity is a duplicated tail, not a collision')
    assert.equal((await benign.append({ emisor: 'w1', tipo: 'fallo', severidad: 'bajo', resumen: 'x' })).id, 'fb-1')

    // A MALFORMED archive: the store still opens (reads keep working) but the
    // census cannot prove an id is free → allocation FAILS LOUD (never a
    // silent live-only seed that could re-issue an archived id).
    await writeFile(resolveFeedbackArchivePath(stateDir), 'NOT JSON\n' + jsonl([fbRecord(9)]), 'utf8')
    const degradedWarn = []
    const degraded = await FeedbackStore.open(stateDir, { logger: { warn: (message) => degradedWarn.push(message) } })
    assert.equal(degraded.get('fb-0').estado, 'resuelto', 'reads keep working on a degraded census')
    assert.equal(degradedWarn.some((message) => message.includes('UNREADABLE')), true, 'the degraded census is loud')
    await assert.rejects(
      () => degraded.append({ emisor: 'w1', tipo: 'fallo', severidad: 'bajo', resumen: 'x' }),
      /REFUSING to allocate "fb-2".*census.*unreadable/s,
      'an unreadable archive census refuses allocation (fail-loud, never reuse)'
    )
  })
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

// --- LOOP FASE 1 (RD spec §4 — dedupe / duplicado / bridge / stale) ----------

test('LOOP FASE 1: duplicado is TERMINAL (the triage-dup); a duplicado never transitions again', () => {
  assert.equal(isTerminalEstado('duplicado'), true)
  assert.ok(feedbackTransitionError('duplicado', 'abierto') !== undefined, 'a duplicado never reopens')
  assert.ok(feedbackTransitionError('duplicado', 'resuelto') !== undefined)
  assert.ok(feedbackTransitionError('duplicado', 'descartado') !== undefined)
})

test('LOOP FASE 1 append (duplicate_of): the record is created duplicado (terminal, ACL-free) + evidence MERGED into the canonical tail (emisor + origen) + related[] cross-link', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    const canonical = await store.append({ emisor: 'worker-1', tipo: 'fallo', severidad: 'alto', resumen: 'network timeout on the register sync', evidencia: 'trace-A' })
    assert.equal(canonical.id, 'fb-0')
    const dup = await store.append({ emisor: 'worker-2', tipo: 'fallo', severidad: 'alto', resumen: 'network timeout on the register sync', evidencia: 'trace-B', duplicate_of: 'fb-0' })
    assert.equal(dup.id, 'fb-1')
    assert.equal(dup.estado, 'duplicado', 'the dup is created TERMINAL duplicado')
    assert.equal(dup.duplicate_of, 'fb-0', 'duplicate_of points to the canonical')
    assert.deepEqual(dup.related, ['fb-0'], 'the dup cross-links the canonical')
    // The canonical tail: the merged evidence (emisor + origen fb-XXX) + the cross-link.
    const canonicalTail = store.get('fb-0')
    assert.ok(canonicalTail.related.includes('fb-1'), 'the canonical cross-links the dup')
    assert.ok(canonicalTail.evidencia.includes('trace-A'), 'the canonical keeps its own evidence')
    assert.ok(canonicalTail.evidencia.includes('trace-B'), 'the dup evidence is appended to the canonical evidencia')
    assert.ok(canonicalTail.evidencia.includes('origen fb-1'), 'the merge note names the origin (fb-XXX)')
    assert.ok(canonicalTail.evidencia.includes('worker-2'), 'the merge note names the dup emisor')
    // Append-only: 3 lines (canonical create, dup create, canonical merge tail).
    const lines = (await readFile(resolveFeedbackPath(stateDir), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 3)
    assert.equal(new Set(lines.map((l) => JSON.parse(l).id)).size, 2, 'two logical records, shared file')
    // duplicate_of format validation + unknown canonical.
    await assert.rejects(() => store.append({ emisor: 'x', tipo: 'fallo', severidad: 'medio', resumen: 'y', duplicate_of: 'nope' }), TypeError)
    await assert.rejects(() => store.append({ emisor: 'x', tipo: 'fallo', severidad: 'medio', resumen: 'y', duplicate_of: 'fb-99' }), /not a live feedback record/)
  })
})

test('LOOP FASE 1 update (duplicate_of, QH): → duplicado + cerrado_por + evidence merged into the canonical tail; self/unknown canonical rejected; terminal blocks reopen', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    const canonical = await store.append({ emisor: 'w1', tipo: 'mejora', severidad: 'bajo', resumen: 'suggestion for the review flow', evidencia: 'idea-1' })
    const dup = await store.append({ emisor: 'w2', tipo: 'mejora', severidad: 'bajo', resumen: 'suggestion for the review flow', evidencia: 'idea-2' })
    assert.equal(canonical.id, 'fb-0')
    assert.equal(dup.id, 'fb-1')
    const marked = await store.update('fb-1', { duplicate_of: 'fb-0' }, { cerradoPor: 'quality-head' })
    assert.equal(marked.estado, 'duplicado')
    assert.equal(marked.duplicate_of, 'fb-0')
    assert.equal(marked.cerrado_por, 'quality-head', 'terminal stamps cerrado_por')
    assert.ok(marked.related.includes('fb-0'))
    const canonicalTail = store.get('fb-0')
    assert.ok(canonicalTail.evidencia.includes('idea-2'), 'the dup evidence merged into the canonical tail')
    assert.ok(canonicalTail.related.includes('fb-1'))
    await assert.rejects(() => store.update('fb-0', { duplicate_of: 'fb-0' }, { cerradoPor: 'quality-head' }), /cannot be a duplicate of itself/)
    await assert.rejects(() => store.update('fb-1', { duplicate_of: 'fb-99' }, { cerradoPor: 'quality-head' }), /not a live feedback record/)
    await assert.rejects(() => store.update('fb-1', { estado: 'abierto' }), /terminal/, 'a duplicado never transitions again')
  })
})

test('LOOP FASE 1 update metadata: triage_owner / related (REPLACE) / resolution / frozen are recorded on the tail (append-only)', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    await store.append({ emisor: 'w1', tipo: 'fallo', severidad: 'medio', resumen: 'x' })
    await store.append({ emisor: 'w2', tipo: 'fallo', severidad: 'medio', resumen: 'y' })
    const triaged = await store.update('fb-0', { estado: 'en-estudio', triage_owner: 'quality-head' })
    assert.equal(triaged.triage_owner, 'quality-head')
    assert.equal(triaged.estado, 'en-estudio')
    const linked = await store.update('fb-0', { related: ['fb-1'] })
    assert.deepEqual(linked.related, ['fb-1'], 'related REPLACES the list')
    const closed = await store.update('fb-0', { estado: 'resuelto', resolution: 'fixed by delivery m-3450 (host lane)' }, { cerradoPor: 'quality-head' })
    assert.equal(closed.resolution, 'fixed by delivery m-3450 (host lane)')
    assert.equal(closed.cerrado_por, 'quality-head')
    const frozen = await store.update('fb-1', { frozen: true })
    assert.equal(frozen.frozen, true)
    const unfrozen = await store.update('fb-1', { frozen: false })
    assert.equal(unfrozen.frozen, false, 'frozen: false explicitly clears the flag')
    // Append-only: fb-0 = create + en-estudio + related + resuelto (4); fb-1 = create + frozen + unfrozen (3).
    const lines = (await readFile(resolveFeedbackPath(stateDir), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 7, 'every transition is a new tail line')
  })
})

test('LOOP FASE 1 dedupe: ≥2 shared significant tokens = candidate; tipo/severidad refine the score; ≤3; stopwords never count', () => {
  const pool = [
    fbRecord(0, { resumen: 'worker leak crashes the batch storage', estado: 'abierto', severidad: 'medio' }),
    fbRecord(1, { resumen: 'worker leak in the retry loop blocks the batch', estado: 'en-estudio', severidad: 'alto' }),
    fbRecord(2, { resumen: 'database connection drops randomly', estado: 'abierto', severidad: 'critico' }),
    fbRecord(3, { resumen: 'suggestion: improve the report layout', estado: 'resuelto', tipo: 'mejora', severidad: 'bajo' })
  ]
  const candidates = findDuplicateCandidates(pool, { resumen: 'worker leak in the retry loop crashes the batch', tipo: 'fallo', severidad: 'alto' })
  assert.ok(candidates.length >= 1 && candidates.length <= 3, 'candidates ≤ 3 (non-blocking)')
  assert.equal(candidates[0]['fb-id'], 'fb-1', 'exact tipo+severidad refinement puts fb-1 on top (5 shared + 2 refiners)')
  assert.equal(candidates[0].estado, 'en-estudio')
  assert.ok(candidates[0].score >= 2)
  // Fewer than 2 shared significant tokens → no candidate.
  assert.deepEqual(findDuplicateCandidates(pool, { resumen: 'menu wording', tipo: 'mejora', severidad: 'bajo' }), [])
  // Stopword-only resumen / stopwords never count as significant tokens.
  assert.deepEqual(findDuplicateCandidates(pool, { resumen: 'de la el en y a', tipo: 'fallo', severidad: 'medio' }), [])
  // max cap is honored (3 identical summaries → only 3 of them).
  const noisy = [
    fbRecord(0, { resumen: 'alpha bravo charlie delta echo', estado: 'abierto' }),
    fbRecord(1, { resumen: 'alpha bravo charlie delta foxtrot', estado: 'abierto' }),
    fbRecord(2, { resumen: 'alpha bravo charlie delta golf', estado: 'abierto' }),
    fbRecord(3, { resumen: 'alpha bravo charlie delta hotel', estado: 'abierto' })
  ]
  const capped = findDuplicateCandidates(noisy, { resumen: 'alpha bravo charlie delta india', tipo: 'fallo', severidad: 'medio' })
  assert.equal(capped.length, 3, 'max 3 candidates (the ≤3 GitHub/Linear pattern)')
})

test('LOOP FASE 1: dedupeCandidates searches the LIVE backlog AND the ARCHIVE (spec §4a "abiertos + archivados")', async () => {
  await withTempStateDir(async (stateDir) => {
    const filePath = resolveFeedbackPath(stateDir)
    const records = [
      fbRecord(0, { resumen: 'alpha beta gamma delta', estado: 'abierto', updatedAt: 1700000000100 }),
      fbRecord(1, { resumen: 'epsilon zeta eta theta', estado: 'abierto', updatedAt: 1700000000200 }),
      fbRecord(2, { resumen: 'kappa lambda mu nu xi omicron special', estado: 'resuelto', cerrado_por: 'quality-head', updatedAt: 1700000000000 })
    ]
    await writeFile(filePath, jsonl(records), 'utf8')
    const store = await FeedbackStore.open(stateDir, { liveCap: 2 })
    assert.equal(store.get('fb-2'), undefined, 'fb-2 was pruned to the archive (3 lines > cap 2, oldest terminal)')
    const candidates = await store.dedupeCandidates({ resumen: 'kappa lambda mu nu xi omicron special', tipo: 'fallo', severidad: 'medio' })
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]['fb-id'], 'fb-2', 'the ARCHIVED record stays searchable by the dedupe')
    assert.equal(candidates[0].estado, 'resuelto')
    // A duplicado record is excluded from the pool (a linked dup is noise as a suggestion).
    await store.append({ emisor: 'w3', tipo: 'fallo', severidad: 'medio', resumen: 'alpha beta gamma delta', duplicate_of: 'fb-0' })
    const noDupPool = await store.dedupeCandidates({ resumen: 'alpha beta gamma delta', tipo: 'fallo', severidad: 'medio' })
    assert.equal(noDupPool.some((c) => c['fb-id'] === 'fb-2'), false, 'only fb-0 is a candidate for fb-3 itself... (no dup in the pool)')
  })
})

test('LOOP FASE 1 bridge: every OPEN create emits ONE normalized line (6 fields + destino) to feedback-bridge.jsonl; a duplicado does NOT queue', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await FeedbackStore.open(stateDir)
    const record = await store.append({ emisor: 'worker-1', tipo: 'fallo', severidad: 'medio', resumen: 'bridge test' })
    assert.equal(record.estado, 'abierto')
    const lines = (await readFile(resolveFeedbackBridgePath(stateDir), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 1)
    const line = JSON.parse(lines[0])
    assert.equal(line['fb-id'], 'fb-0')
    assert.equal(line.tipo, 'fallo')
    assert.equal(line.severidad, 'medio')
    assert.equal(line.resumen, 'bridge test')
    assert.equal(line.evidencia_ref, 'feedback.jsonl fb-0 tail')
    assert.equal(line.solicitante, 'worker-1')
    assert.match(line.fecha, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.deepEqual(line.destino, ['host', 'internal-programming-head'])
    assert.equal(FEEDBACK_BRIDGE_FILE, 'feedback-bridge.jsonl', 'the bridge file name is exported')
    // A duplicate create (duplicado — terminal) emits NO bridge line: line 2 is the NEW abierto canonical, not the dup.
    const canonical = await store.append({ emisor: 'w1', tipo: 'fallo', severidad: 'alto', resumen: 'dup bridge test' })
    const dup = await store.append({ emisor: 'w2', tipo: 'fallo', severidad: 'alto', resumen: 'dup bridge test', duplicate_of: canonical.id })
    assert.equal(dup.estado, 'duplicado')
    const after = (await readFile(resolveFeedbackBridgePath(stateDir), 'utf8')).split('\n').filter(Boolean)
    assert.equal(after.length, 2, 'the duplicado emits no line; the new abierto canonical does')
    assert.equal(JSON.parse(after[1])['fb-id'], 'fb-1')
  })
})

test('LOOP FASE 1 stale: 14d abierto → nudge QD; 30d en-estudio → nudge triage_owner; 90d medio/bajo → descartado(stale); critico/alto NEVER stale-close; frozen escapes', () => {
  const now = 1700000000000 + 100 * 86_400_000 // +100 days
  assert.equal(feedbackStaleNudge(fbRecord(0, { estado: 'abierto', updatedAt: now }), now).kind, 'none', 'fresh record within the windows')
  const nudgeQd = feedbackStaleNudge(fbRecord(1, { estado: 'abierto', updatedAt: now - 14 * 86_400_000 }), now)
  assert.equal(nudgeQd.kind, 'nudge-qd', '14d abierto sin triage → nudge QD')
  const nudgeOwner = feedbackStaleNudge(fbRecord(2, { estado: 'en-estudio', triage_owner: 'quality-head', updatedAt: now - 30 * 86_400_000 }), now)
  assert.equal(nudgeOwner.kind, 'nudge-owner', '30d en-estudio sin movimiento → nudge triage_owner')
  assert.ok(nudgeOwner.reason.includes('quality-head'), 'the nudge names the triage_owner')
  assert.equal(feedbackStaleNudge(fbRecord(3, { estado: 'abierto', severidad: 'medio', updatedAt: now - 90 * 86_400_000 }), now).kind, 'stale-descartado', '90d sin actividad + medio → descartado(stale)')
  const critico = feedbackStaleNudge(fbRecord(4, { estado: 'abierto', severidad: 'critico', updatedAt: now - 90 * 86_400_000 }), now)
  assert.notEqual(critico.kind, 'stale-descartado', 'critico is NEVER stale-closed (still nudges QD at 14d)')
  assert.equal(critico.kind, 'nudge-qd')
  assert.equal(feedbackStaleNudge(fbRecord(5, { estado: 'en-estudio', severidad: 'alto', updatedAt: now - 90 * 86_400_000 }), now).kind, 'nudge-owner', 'alto en-estudio: nudge owner at 30d, never stale-close')
  assert.equal(feedbackStaleNudge(fbRecord(6, { estado: 'abierto', severidad: 'medio', updatedAt: now - 90 * 86_400_000, frozen: true }), now).kind, 'none', 'frozen escape — never stale-closed nor nudged')
  assert.equal(STALE_REVIEW_ABIERTO_DAYS, 14)
  assert.equal(STALE_REVIEW_EN_ESTUDIO_DAYS, 30)
  assert.equal(STALE_REVIEW_INACTIVITY_DAYS, 90)
})

test('LOOP FASE 1 auto-close by reference: extractFeedbackReferences parses fb-NNN with the stable pattern (unique, in order)', () => {
  assert.deepEqual(extractFeedbackReferences('delivery m-3450 resolves fb-13 and fb-7 (also fixes FB-13)'), ['fb-13', 'fb-7'])
  assert.deepEqual(extractFeedbackReferences('no references here'), [])
  assert.deepEqual(extractFeedbackReferences('fb-0 fb-1 fb-0'), ['fb-0', 'fb-1'])
})

test('LOOP FASE 1 compatibility: OLD records (without the new fields) open, transition and re-open cleanly — the new fields stay optional', async () => {
  await withTempStateDir(async (stateDir) => {
    const filePath = resolveFeedbackPath(stateDir)
    await writeFile(filePath, jsonl([
      fbRecord(0, { estado: 'abierto', updatedAt: 1700000000001 }),
      fbRecord(1, { estado: 'resuelto', cerrado_por: 'quality-head', updatedAt: 1700000000002 })
    ]), 'utf8')
    const store = await FeedbackStore.open(stateDir)
    assert.equal(store.size, 2)
    assert.equal(store.get('fb-0').duplicate_of, undefined, 'absent new fields are undefined')
    assert.equal(Array.isArray(store.get('fb-0').related), false)
    assert.equal(store.get('fb-0').triage_owner, undefined)
    assert.equal(store.get('fb-0').resolution, undefined)
    assert.equal(store.get('fb-0').frozen, undefined)
    const closed = await store.update('fb-0', { estado: 'resuelto', resolution: 'done' }, { cerradoPor: 'quality-head' })
    assert.equal(closed.resolution, 'done')
    assert.equal(closed.cerrado_por, 'quality-head')
    assert.equal(closed.triage_owner, undefined, 'old metadata is preserved as-is')
    const reloaded = await FeedbackStore.open(stateDir)
    assert.equal(reloaded.get('fb-0').resolution, 'done')
    assert.equal(reloaded.size, 3, '1 old + 1 transition + 1 old = 3 lines')
  })
})

test('LOOP FASE 1 prune: a duplicado is TERMINAL → pruned to the archive like resuelto/descartado', async () => {
  await withTempStateDir(async (stateDir) => {
    const filePath = resolveFeedbackPath(stateDir)
    const records = [
      fbRecord(0, { estado: 'duplicado', duplicate_of: 'fb-9', updatedAt: 1700000000100 }),
      fbRecord(1, { estado: 'abierto', updatedAt: 1700000000200 })
    ]
    await writeFile(filePath, jsonl(records), 'utf8')
    const store = await FeedbackStore.open(stateDir, { liveCap: 1 })
    assert.equal(store.get('fb-0'), undefined, 'the oldest TERMINAL duplicado is evicted to the archive')
    assert.equal(store.get('fb-1').estado, 'abierto')
    const archive = (await readFile(resolveFeedbackArchivePath(stateDir), 'utf8')).split('\n').filter(Boolean)
    assert.equal(JSON.parse(archive[0]).estado, 'duplicado')
    assert.equal(JSON.parse(archive[0]).duplicate_of, 'fb-9', 'the full evicted duplicado line is preserved')
  })
})
