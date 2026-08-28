// dsh-deepartments — messaging store tests (spec 003 §3).
//
// The store is a standalone fs module (no cordis services), so these are
// hermetic unit tests against the compiled lib/ — the same direct-test shape
// the board-store tests use for its store functions (test/board-store.test.js):
// temp stateDirs, no network, no live DSH_HOME. (pnpm build first.)
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  COMPACTION_BYTE_THRESHOLD,
  COMPACTION_LINE_THRESHOLD,
  MessagesStore,
  compactionIdMap,
  compactDeliveryRows,
  compactMessages,
  deliveryStatus,
  loadMemberIds,
  loadMessageRecords,
  markDelivery,
  needsRedelivery,
  parseDeliveryRows,
  parseMessageRecords,
  remapDeliveryRows,
  resolveDeliveriesPath,
  resolveMessagesPath,
  shouldCompact
} from '../lib/messages-store.js'

const SENDER = 'research-head'
const RECIPIENT = 'asistente'

/** Wire-format record for pre-seeded files (the shape append() produces). */
function wireRecord(seq, overrides = {}) {
  return {
    id: `m-${seq}`,
    seq,
    ts: 1700000000000 + seq,
    from: SENDER,
    to: [RECIPIENT],
    text: `text-${seq}`,
    kind: 'agent',
    ...overrides
  }
}

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-msg-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

// --- append + index ----------------------------------------------------------

test('append: assigns id m-<seq> + contiguous global seq + ts, flushes JSONL, updates the per-recipient index', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await MessagesStore.open(stateDir)
    assert.equal(store.size, 0)

    const first = await store.append({ from: 'research-head', to: ['asistente', 'programming-head'], text: 'hello' })
    assert.equal(first.id, 'm-0')
    assert.equal(first.seq, 0)
    assert.equal(first.kind, 'agent', 'default kind is agent')
    assert.equal(typeof first.ts, 'number')
    assert.deepEqual(first.to, ['asistente', 'programming-head'])

    const second = await store.append({ from: 'asistente', to: ['research-head'], text: 'hi', kind: 'ack', sensitive: true, threadId: 'm-0' })
    assert.equal(second.id, 'm-1')
    assert.equal(second.seq, 1, 'global seq is contiguous')
    assert.equal(second.kind, 'ack')
    assert.equal(second.sensitive, true)
    assert.equal(second.threadId, 'm-0')

    await store.append({ from: 'ghost', to: ['research-head'], text: 'third' })

    assert.equal(store.size, 3)
    assert.deepEqual(store.seqsFor('research-head'), [1, 2], 'one entry per record with the recipient in to[]')
    assert.deepEqual(store.seqsFor('asistente'), [0])
    assert.deepEqual(store.seqsFor('programming-head'), [0])
    assert.deepEqual(store.seqsFor('nobody'), [])

    // The record is on disk BEFORE append returns (persist-before-deliver).
    const lines = (await readFile(resolveMessagesPath(stateDir), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 3)
    assert.deepEqual(JSON.parse(lines[0]), first)
    assert.deepEqual(JSON.parse(lines[1]), second)
  })
})

test('append validation: empty to[], empty from, non-string text, unknown kind throw loud', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await MessagesStore.open(stateDir)
    await assert.rejects(() => store.append({ from: 'x', to: [], text: 'hi' }), TypeError)
    await assert.rejects(() => store.append({ from: '', to: ['a'], text: 'hi' }), TypeError)
    await assert.rejects(() => store.append({ from: 'x', to: ['a'], text: 42 }), TypeError)
    await assert.rejects(() => store.append({ from: 'x', to: ['a'], text: 'hi', kind: 'bogus' }), TypeError)
    assert.equal(store.size, 0, 'a rejected append leaves no record behind')
  })
})

// --- paging ------------------------------------------------------------------

test('page: newest-first paging over 25 own records — 10 / 11-20 / 21-30, before exclusive', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await MessagesStore.open(stateDir)
    // Global noise FIRST (other recipients), then 25 own records: own seqs are
    // a sparse subset (5..29) of the global log (0..29.
    for (let i = 0; i < 5; i++) await store.append({ from: 'ghost', to: ['nobody'], text: `noise-${i}` })
    for (let i = 0; i < 25; i++) await store.append({ from: SENDER, to: [RECIPIENT], text: `own-${i}` })
    assert.equal(store.size, 30)
    assert.deepEqual(store.seqsFor(RECIPIENT), Array.from({ length: 25 }, (_, i) => 5 + i))

    // Page 1: the 10 newest owned records, newest-first.
    const page1 = store.page(RECIPIENT, { limit: 10 })
    assert.equal(page1.total, 25)
    assert.deepEqual(page1.messages.map((m) => m.id), Array.from({ length: 10 }, (_, i) => `m-${29 - i}`))
    assert.equal(page1.messages[0].text, 'own-24', 'newest record first')
    assert.equal(page1.remaining, 15, '15 older owned records')

    // Page 2 (before = page 1 oldest, exclusive): the next 10.
    const page2 = store.page(RECIPIENT, { limit: 10, before: page1.messages[9].id })
    assert.deepEqual(page2.messages.map((m) => m.id), Array.from({ length: 10 }, (_, i) => `m-${19 - i}`))
    assert.equal(page2.remaining, 5)

    // Page 3: the last 5 (limit 10 over 5 remaining).
    const page3 = store.page(RECIPIENT, { limit: 10, before: page2.messages[9].id })
    assert.deepEqual(page3.messages.map((m) => m.id), Array.from({ length: 5 }, (_, i) => `m-${9 - i}`))
    assert.equal(page3.remaining, 0)

    // Full traversal: the three pages partition the 25 owned records exactly once.
    const seen = [...page1.messages, ...page2.messages, ...page3.messages].map((m) => m.id)
    assert.equal(new Set(seen).size, 25)

    // Mutating a returned message must not corrupt the store's index.
    page1.messages[0].to.push('tampered')
    page1.messages[0].text = 'tampered'
    assert.deepEqual(store.get('m-29').to, [RECIPIENT])
    assert.equal(store.get('m-29').text, 'own-24')
  })
})

test('page: remaining is the exact older-own count for a sparse subset (never a naive seq formula)', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await MessagesStore.open(stateDir)
    // 'sparse' owns ONLY global seqs [3, 8, 13, 18, 23] (interleaved noise).
    for (let seq = 0; seq < 24; seq++) {
      const recipient = seq % 5 === 3 ? 'sparse' : 'other'
      await store.append({ from: SENDER, to: [recipient], text: `t-${seq}` })
    }
    assert.deepEqual(store.seqsFor('sparse'), [3, 8, 13, 18, 23])

    const page1 = store.page('sparse', { limit: 2 })
    assert.equal(page1.total, 5)
    assert.deepEqual(page1.messages.map((m) => m.id), ['m-23', 'm-18'])
    assert.equal(page1.remaining, 3, '3 older owned records (the naive total - (seqLo + pageLen) would be negative)')

    const page2 = store.page('sparse', { limit: 2, before: 'm-18' })
    assert.deepEqual(page2.messages.map((m) => m.id), ['m-13', 'm-8'])
    assert.equal(page2.remaining, 1)

    const page3 = store.page('sparse', { limit: 2, before: 'm-8' })
    assert.deepEqual(page3.messages.map((m) => m.id), ['m-3'])
    assert.equal(page3.remaining, 0)

    // A before cursor pointing at a seq NOT owned by the recipient still
    // resolves as an exclusive seq boundary (deterministic, no error).
    const boundary = store.page('sparse', { limit: 2, before: 'm-20' })
    assert.deepEqual(boundary.messages.map((m) => m.id), ['m-18', 'm-13'])
    assert.equal(boundary.remaining, 2, '2 owned records older than the page (seqs 3 and 8)')
  })
})

test('page: a before id missing from the store (renumbered by compaction) clamps to the newest record', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await MessagesStore.open(stateDir)
    for (let i = 0; i < 7; i++) await store.append({ from: SENDER, to: [RECIPIENT], text: `t-${i}` })

    // m-99 never existed (or was renumbered away): clamp (§3.2) — the cursor
    // resolves to the newest record (m-6, EXCLUSIVE), never an error.
    const page = store.page(RECIPIENT, { limit: 4, before: 'm-99' })
    assert.deepEqual(page.messages.map((m) => m.id), ['m-5', 'm-4', 'm-3', 'm-2'])
    assert.equal(page.remaining, 2, 'records m-0, m-1 are older than the page')
  })
})

test('page: unknown recipient → total 0, empty page, remaining 0 (even with a before cursor)', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await MessagesStore.open(stateDir)
    await store.append({ from: SENDER, to: [RECIPIENT], text: 'a' })
    assert.deepEqual(store.page('nobody-here', { limit: 5, before: 'm-0' }), { total: 0, messages: [], remaining: 0 })
  })
})

// --- boot / reload / parse ---------------------------------------------------

test('re-open: index, paging and the append counter are rebuilt from the file; append continues contiguously', async () => {
  await withTempStateDir(async (stateDir) => {
    const store = await MessagesStore.open(stateDir)
    await store.append({ from: SENDER, to: [RECIPIENT], text: 'a' })
    await store.append({ from: SENDER, to: ['other-head'], text: 'b' })
    await store.append({ from: 'asistente', to: [SENDER], text: 'c' })

    const reopened = await MessagesStore.open(stateDir)
    assert.equal(reopened.size, 3)
    assert.deepEqual(reopened.seqsFor(RECIPIENT), [0])
    assert.deepEqual(reopened.seqsFor(SENDER), [2])
    assert.deepEqual(reopened.page(RECIPIENT, { limit: 10 }).messages.map((m) => m.text), ['a'])

    const fourth = await reopened.append({ from: SENDER, to: [RECIPIENT], text: 'd' })
    assert.equal(fourth.id, 'm-3', 'counter seeded from the loaded file\'s last seq + 1 — no reuse, no gaps')
  })
})

test('parse: missing file → empty store; trailing partial line dropped; malformed non-final line throws loud', async () => {
  await withTempStateDir(async (stateDir) => {
    const empty = await MessagesStore.open(stateDir)
    assert.equal(empty.size, 0, 'missing file → empty store')

    const filePath = resolveMessagesPath(stateDir)
    await writeFile(filePath, jsonl([wireRecord(0), wireRecord(1)]) + '{"id": "m-2", "seq": 2, "trunca', 'utf8')
    const tolerant = await MessagesStore.open(stateDir)
    assert.equal(tolerant.size, 2, 'a crash mid-append leaves a trailing partial line — dropped')

    await writeFile(filePath, jsonl([wireRecord(0), wireRecord(1)]) + 'NOT JSON\n', 'utf8')
    await assert.rejects(() => MessagesStore.open(stateDir), /malformed record on line 3/, 'mid-file corruption fails loud')

    // Valid JSON but NOT a record shape: full-line corruption → fails loud too.
    await writeFile(filePath, jsonl([wireRecord(0)]) + '"just a string"\n', 'utf8')
    await assert.rejects(() => MessagesStore.open(stateDir), /malformed record on line 2/)
  })
})

// --- compaction --------------------------------------------------------------

test('compactMessages (pure): keep-rule filter, seq 0..N-1 renumber, m-<n> re-id, threadId old→new / trimmed→null', () => {
  const records = [
    wireRecord(0, { text: 'kept-a' }),                                               // kept (from live)
    wireRecord(1, { from: 'spook', to: ['ghost'], text: 'ghost-sender' }),           // dropped
    wireRecord(2, { to: ['asistente', 'ghost'], text: 'kept-b' }),                   // kept (to has a live member)
    wireRecord(3, { from: 'spook', to: ['ghost'], text: 'ghost-both' }),             // dropped
    wireRecord(4, { text: 'kept-c', threadId: 'm-2' }),                              // kept; thread target kept → remap
    wireRecord(5, { text: 'kept-d', threadId: 'm-3' }),                              // kept; thread target trimmed → null
    wireRecord(6, { text: 'kept-e', threadId: 'm-99' })                              // kept; thread target never existed → null
  ]
  const members = new Set(['asistente', 'research-head'])
  const keepFn = (r) => members.has(r.from) || r.to.some((entry) => members.has(entry))
  const compacted = compactMessages(records, keepFn)

  assert.deepEqual(compacted.map((r) => r.seq), [0, 1, 2, 3, 4], 'contiguous renumber 0..N-1 in original order')
  assert.deepEqual(compacted.map((r) => r.id), ['m-0', 'm-1', 'm-2', 'm-3', 'm-4'], 'ids re-derived from the new seq')
  assert.deepEqual(compacted.map((r) => r.text), ['kept-a', 'kept-b', 'kept-c', 'kept-d', 'kept-e'])
  assert.equal(compacted[2].threadId, 'm-1', 'kept→kept thread: old m-2 → NEW m-1')
  assert.equal(compacted[3].threadId, null, 'kept→trimmed thread: m-3 was dropped → null')
  assert.equal(compacted[4].threadId, null, 'kept→never-existed thread: m-99 → null')
  assert.ok(!compacted.some((r) => r.text.startsWith('ghost')), 'ghost records dropped')
})

test('shouldCompact: line threshold (2000) and byte threshold (256 KiB) — the board-store thresholds', () => {
  const small = [wireRecord(0), wireRecord(1)]
  assert.equal(shouldCompact(small, jsonl(small)), false)

  const many = Array.from({ length: COMPACTION_LINE_THRESHOLD + 1 }, (_, i) => wireRecord(i))
  assert.equal(shouldCompact(many, jsonl(many)), true, `> ${COMPACTION_LINE_THRESHOLD} records triggers`)

  const big = [wireRecord(0, { text: 'x'.repeat(COMPACTION_BYTE_THRESHOLD + 100) })]
  assert.equal(shouldCompact(big, jsonl(big)), true, 'raw bytes over the threshold trigger')
})

test('boot compaction: keep-rule from the durable registries, renumber + re-index, threadId re-map, one .bak backup', async () => {
  await withTempStateDir(async (stateDir) => {
    // Registries: live members + a RETIRED host entry (excluded from the set).
    await writeFile(path.join(stateDir, 'posts.json'), JSON.stringify({ 'research-head': {}, 'programming-head': {} }), 'utf8')
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({
      host: { hostId: 'host', sessionId: 'host-1' },
      'host-old': { hostId: 'host-old', sessionId: 'host-old-1', retired: true }
    }), 'utf8')

    const filePath = resolveMessagesPath(stateDir)
    const bigText = 'x'.repeat(4000) // 90 records × ~4.1 KB ≈ 370 KiB > 256 KiB → byte threshold
    const records = []
    for (let i = 0; i < 90; i++) {
      if (i % 10 === 7) {
        records.push(wireRecord(i, { from: 'spook', to: ['other-spook'], text: `ghost-${i}` }))
      } else {
        records.push(wireRecord(i, { text: `${bigText}-${i}` }))
      }
    }
    records[4] = { ...records[4], threadId: 'm-0' } // kept→kept thread (old m-0 kept at new index 0)
    records[8] = { ...records[8], threadId: 'm-7' } // kept→trimmed thread (m-7 is a ghost record)
    await writeFile(filePath, jsonl(records), 'utf8')

    const store = await MessagesStore.open(stateDir)

    assert.equal(store.size, 81, '9 ghost records dropped, 81 kept')
    assert.deepEqual(store.seqsFor(RECIPIENT), Array.from({ length: 81 }, (_, i) => i), 'index rebuilt from the renumbered file')

    const after = await loadMessageRecords(filePath)
    assert.equal(after.length, 81)
    after.forEach((record, index) => {
      assert.equal(record.seq, index, `contiguous seq at position ${index}`)
      assert.equal(record.id, `m-${index}`, `m-<newSeq> id at position ${index}`)
    })
    assert.equal(after[4].threadId, 'm-0', 'kept→kept thread re-mapped through the old→new id map')
    assert.equal(after[7].threadId, null, 'kept→trimmed thread becomes null')
    assert.ok(after[7].text.startsWith('xxxx'), 'old record 8 (after ghost record 7 was dropped) survives at new index 7')

    // Pre-compaction backup: the original 90 records are preserved as evidence.
    const bakRecords = parseMessageRecords(await readFile(`${filePath}.bak`, 'utf8'))
    assert.equal(bakRecords.length, 90, 'messages.jsonl.bak holds the pre-compaction file')

    // Paging works on the rebuilt index.
    const page = store.page(RECIPIENT, { limit: 10 })
    assert.equal(page.total, 81)
    assert.equal(page.remaining, 71)
    assert.equal(page.messages[0].id, 'm-80')
  })
})

test('boot compaction with NO registries: keep-rule falls back to keep-all — compaction never wipes history', async () => {
  await withTempStateDir(async (stateDir) => {
    const filePath = resolveMessagesPath(stateDir)
    const records = Array.from({ length: 40 }, (_, i) => wireRecord(i, { text: 'y'.repeat(7000) })) // ≈ 280 KiB > threshold
    await writeFile(filePath, jsonl(records), 'utf8')

    const store = await MessagesStore.open(stateDir) // no posts.json / hosts.json exist
    assert.equal(store.size, 40, 'empty member set keeps everything (defensive keep-rule)')
    const after = await loadMessageRecords(filePath)
    assert.deepEqual(after.map((r) => r.seq), Array.from({ length: 40 }, (_, i) => i))
  })
})

// --- durable member ids (keep-rule input) -------------------------------------

test('loadMemberIds: posts.json keys + NON-retired hosts.json keys; missing/malformed registries → empty set', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(path.join(stateDir, 'posts.json'), JSON.stringify({ 'research-head': {}, 'worker-1': {} }), 'utf8')
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({
      host: { hostId: 'host' },
      'host-old': { hostId: 'host-old', retired: true }
    }), 'utf8')

    const ids = await loadMemberIds(stateDir)
    assert.ok(ids.has('research-head'))
    assert.ok(ids.has('worker-1'))
    assert.ok(ids.has('host'))
    assert.ok(!ids.has('host-old'), 'retired host entries are not durable members')

    assert.equal((await loadMemberIds(path.join(stateDir, 'no-such-dir'))).size, 0, 'missing registries → empty (best-effort)')
  })
})

// --- delivery sidecar (write-ahead, spec §4.4) --------------------------------

test('sidecar: prepared → final transitions (latest row wins), unknown → null, needsRedelivery predicate', async () => {
  await withTempStateDir(async (stateDir) => {
    assert.equal(await deliveryStatus(stateDir, 'm-0', 'research-head'), null, 'no rows yet')
    assert.equal(needsRedelivery(null), true, 'no row → deliver')

    await markDelivery(stateDir, 'm-0', 'research-head', 'prepared')
    assert.equal(await deliveryStatus(stateDir, 'm-0', 'research-head'), 'prepared')
    assert.equal(needsRedelivery('prepared'), true, 'crash between persist and delivery → re-run')

    await markDelivery(stateDir, 'm-0', 'research-head', 'delivered')
    assert.equal(await deliveryStatus(stateDir, 'm-0', 'research-head'), 'delivered', 'latest row wins')
    assert.equal(needsRedelivery('delivered'), false, 'delivered → skip (idempotent re-delivery)')

    await markDelivery(stateDir, 'm-0', 'programming-head', 'prepared')
    await markDelivery(stateDir, 'm-0', 'programming-head', 'resumed')
    assert.equal(await deliveryStatus(stateDir, 'm-0', 'programming-head'), 'resumed')
    assert.equal(needsRedelivery('resumed'), false, 'resumed → skip')

    await markDelivery(stateDir, 'm-1', 'research-head', 'prepared')
    await markDelivery(stateDir, 'm-1', 'research-head', 'failed')
    assert.equal(needsRedelivery('failed'), true, 'failed → retryable')

    await markDelivery(stateDir, 'm-2', 'asistente', 'self')
    assert.equal(needsRedelivery('self'), false, 'self-send is held by design, no wake')

    // One row per transition, append-only (never edited in place).
    const lines = (await readFile(resolveDeliveriesPath(stateDir), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 7)
    const first = JSON.parse(lines[0])
    assert.deepEqual(first, { messageId: 'm-0', recipientId: 'research-head', status: 'prepared', ts: first.ts })
    assert.equal(typeof first.ts, 'number')
  })
})

test('sidecar compaction (pure): keeps only the latest row per (messageId, recipientId)', () => {
  const rows = [
    { messageId: 'm-0', recipientId: 'a', status: 'prepared', ts: 1 },
    { messageId: 'm-0', recipientId: 'a', status: 'delivered', ts: 2 },
    { messageId: 'm-0', recipientId: 'b', status: 'prepared', ts: 3 },
    { messageId: 'm-0', recipientId: 'a', status: 'resumed', ts: 4 },
    { messageId: 'm-1', recipientId: 'a', status: 'failed', ts: 5 },
    { messageId: 'm-1', recipientId: 'a', status: 'prepared', ts: 6 }
  ]
  const compacted = compactDeliveryRows(rows)
  assert.deepEqual(
    compacted.map((r) => `${r.messageId}|${r.recipientId}|${r.status}|${r.ts}`),
    ['m-0|b|prepared|3', 'm-0|a|resumed|4', 'm-1|a|prepared|6'],
    'latest row per key, in original order'
  )
})

// --- ALTO-1 (QD audit 2026-08-28 F1): the id-STABLE sidecar contract -----------

test('ALTO-1 compactionIdMap + remapDeliveryRows (pure): surviving ids remapped through the old→new map, TRIMMED-records rows PRUNED, order preserved; a keep-all map prunes nothing', () => {
  const records = [
    wireRecord(0, { text: 'kept-a' }), // kept → m-0
    wireRecord(1, { from: 'spook', to: ['ghost'], text: 'ghost-a' }), // trimmed
    wireRecord(2, { to: ['asistente', 'ghost'], text: 'kept-b' }), // kept → m-1
    wireRecord(3, { from: 'spook', to: ['ghost'], text: 'ghost-b' }) // trimmed
  ]
  const members = new Set(['asistente', 'research-head'])
  const keepFn = (r) => members.has(r.from) || r.to.some((entry) => members.has(entry))
  const map = compactionIdMap(records, keepFn)
  assert.deepEqual([...map.entries()], [['m-0', 'm-0'], ['m-2', 'm-1']], 'the map covers ONLY the kept records, old id → new id')

  const rows = [
    { messageId: 'm-0', recipientId: 'a', status: 'prepared', ts: 1 },
    { messageId: 'm-1', recipientId: 'b', status: 'delivered', ts: 2 }, // trimmed → PRUNED
    { messageId: 'm-2', recipientId: 'c', status: 'failed', ts: 3 },
    { messageId: 'm-3', recipientId: 'd', status: 'prepared', ts: 4 }, // trimmed → PRUNED
    { messageId: 'm-0', recipientId: 'a', status: 'delivered', ts: 5 }
  ]
  const remapped = remapDeliveryRows(rows, map)
  assert.deepEqual(
    remapped.map((r) => `${r.messageId}|${r.recipientId}|${r.status}`),
    ['m-0|a|prepared', 'm-1|c|failed', 'm-0|a|delivered'],
    'surviving ids remapped (old m-2 → NEW m-1), trimmed-records rows pruned, original order preserved'
  )
  // Keep-all map (no registries — the defensive keep-rule): every id maps onto
  // itself → no row is pruned and ids are unchanged (compaction never wipes the trace).
  const keepAll = new Map([['m-0', 'm-0'], ['m-1', 'm-1'], ['m-2', 'm-2'], ['m-3', 'm-3']])
  assert.deepEqual(remapDeliveryRows(rows, keepAll), rows, 'keep-all: nothing pruned, ids unchanged')
  // An empty map (nothing kept) prunes everything.
  assert.deepEqual(remapDeliveryRows(rows, new Map()), [], 'an empty map prunes every row')
})

test('ALTO-1 boot compaction: the SAME pass remaps/prunes deliveries.jsonl — after the pass EVERY sidecar row references the CURRENT record that actually addressed the recipient (a recycled id NEVER collides with an old row), with a deliveries.jsonl.bak backup', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(path.join(stateDir, 'posts.json'), JSON.stringify({ 'research-head': {}, 'programming-head': {} }), 'utf8')
    await writeFile(path.join(stateDir, 'hosts.json'), JSON.stringify({
      host: { hostId: 'host', sessionId: 'host-1' }
    }), 'utf8')

    const filePath = resolveMessagesPath(stateDir)
    const bigText = 'x'.repeat(25000) // 12 records × ~25 KiB ≈ 300 KiB > 256 KiB → byte threshold
    const records = []
    for (let i = 0; i < 12; i++) {
      // The seq-7 record is a GHOST (trimmed): the old id m-7 is REBOUND to the
      // record that keeps index 7 (the old m-8) — the exact contamination shape
      // of the m-728 audit case (a stale row under m-7 would collide with the
      // CURRENT m-7, a different record).
      if (i === 7) records.push(wireRecord(i, { from: 'spook', to: ['ghost'], text: `ghost-${i}` }))
      else records.push(wireRecord(i, { text: `${bigText}-${i}` }))
    }
    await writeFile(filePath, jsonl(records), 'utf8')
    // Pre-compaction sidecar (the contaminated shape): a row for a KEPT record
    // under its OLD id (m-2 → remapped), a row for the TRIMMED record (m-7
    // ghost → must be PRUNED — the NEW m-7 addresses 'asistente', NOT the
    // ghost), and a row for a never-existed id (m-999 → pruned).
    await writeFile(resolveDeliveriesPath(stateDir), jsonl([
      { messageId: 'm-2', recipientId: RECIPIENT, status: 'prepared', ts: 1 },
      { messageId: 'm-7', recipientId: 'ghost', status: 'delivered', ts: 2 },
      { messageId: 'm-999', recipientId: RECIPIENT, status: 'prepared', ts: 3 }
    ]), 'utf8')

    const store = await MessagesStore.open(stateDir)
    assert.equal(store.size, 11, 'one ghost record trimmed (the 12th)')

    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    assert.deepEqual(
      rows.map((r) => `${r.messageId}|${r.recipientId}|${r.status}`),
      ['m-2|asistente|prepared'],
      'the SAME pass kept the surviving row (remapped to its NEW id) and PRUNED the trimmed + never-existed rows'
    )
    // THE INVARIANT (the rebind no longer contaminates): every surviving row's
    // messageId resolves to a CURRENT record AND that record really addressed
    // the row's recipient — no old row can collide under a recycled messageId
    // (the m-728-class correlation stays truthful for every consumer).
    for (const row of rows) {
      const record = store.get(row.messageId)
      assert.ok(record !== undefined, `row ${row.messageId} → ${row.recipientId} resolves to a CURRENT record`)
      assert.ok(record.to.includes(row.recipientId), `the current ${row.messageId} record really addressed ${row.recipientId} (no recycled-id collision)`)
    }
    // The pre-remap sidecar is backed up (evidence, like messages.jsonl.bak).
    const bakRows = parseDeliveryRows(await readFile(`${resolveDeliveriesPath(stateDir)}.bak`, 'utf8'))
    assert.equal(bakRows.length, 3, 'deliveries.jsonl.bak holds the pre-remap sidecar (all 3 contaminated rows)')
    // The boot driver semantics: a sidecar that needed NO change is left
    // untouched — a compaction whose keep-rule keeps everything (or whose rows
    // all survive with ids unchanged) performs NO sidecar rewrite.
    await withTempStateDir(async (stateDir2) => {
      await writeFile(path.join(stateDir2, 'posts.json'), JSON.stringify({ 'research-head': {} }), 'utf8')
      const small = [wireRecord(0, { text: 'y'.repeat(300000) })] // > 256 KiB → compacts; the single record is kept (from a live member)
      await writeFile(resolveMessagesPath(stateDir2), jsonl(small), 'utf8')
      const cleanRows = [{ messageId: 'm-0', recipientId: RECIPIENT, status: 'delivered', ts: 1 }]
      await writeFile(resolveDeliveriesPath(stateDir2), jsonl(cleanRows), 'utf8')
      await MessagesStore.open(stateDir2)
      const after = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir2), 'utf8'))
      assert.deepEqual(after, cleanRows, 'a sidecar that needs NO remap/prune is left byte-identical (no gratuitous rewrite)')
    })
  })
})
