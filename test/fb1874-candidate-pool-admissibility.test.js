// dsh-deepartments — fb-1874 / laneI: the FASE 1 candidate pool must never
// offer an INADMISSIBLE id without declaring WHY, and must never offer the SAME
// id twice.
//
// REPRODUCES the measured mechanism on BOTH LEDGERS (live + archive):
//  A — STATE ASYMMETRY: the live half filtered `duplicado`, the archive half did
//      not, so an archived `duplicado` could be offered as a legal destination.
//  B — GRAIN ASYMMETRY: the live half is indexed BY ID (latest tail wins) while
//      the archive was loaded PER LINE, so the SAME id could occupy two of the
//      ≤3 slots AND exhibit a SUPERSEDED `estado`.
//
// POSITIVE CONTROL: a fixture built to trigger A and B ⇒ the offers carry
// `admissible:false` + the declared relation, the re-offer is GONE, and the
// exhibited `estado` is the TAIL's. NEGATIVE CONTROL: the archive-only record
// that declares nothing is STILL OFFERED (the detector is never narrowed — a
// false destination must not be traded for an untraceable false negative), and
// an admissible offer is never dropped.
//
// Hermetic: temp stateDir, no network, no live DSH_HOME.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  FeedbackStore,
  feedbackUnitDivergence,
  findDuplicateCandidates,
  isTerminalEstado,
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
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-fb-1874-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

// The shared subject: 4 significant tokens, so a ≥2-token overlap is a match.
const SUBJECT = 'alpha bravo charlie delta'
const query = { resumen: 'alpha bravo charlie delta echo', tipo: 'fallo', severidad: 'medio' }

test('fb-1874 (A) STATE ASYMMETRY: an ARCHIVED duplicado is offered ONLY with admissible:false + its declared relation — never as a legal destination', async () => {
  await withTempStateDir(async (stateDir) => {
    const filePath = resolveFeedbackPath(stateDir)
    const archivePath = resolveFeedbackArchivePath(stateDir)
    // The LIVE canonical: a legal destination.
    await writeFile(filePath, jsonl([fbRecord(0, { resumen: SUBJECT, estado: 'abierto' })]), 'utf8')
    // The ARCHIVED annex: terminal `duplicado` declaring fb-0 (its destination
    // IS live ⇒ the offer RESOLVES to it instead of being merely inadmissible).
    await writeFile(archivePath, jsonl([fbRecord(9, { resumen: SUBJECT, estado: 'duplicado', duplicate_of: 'fb-0', related: ['fb-0'] })]), 'utf8')
    const store = await FeedbackStore.open(stateDir)
    const offers = await store.dedupeCandidates(query)
    const annex = offers.find((c) => c['fb-id'] === 'fb-9')
    const canonical = offers.find((c) => c['fb-id'] === 'fb-0')
    // POSITIVE CONTROL: the archived `duplicado` is DECLARED, not silently legal.
    assert.ok(annex !== undefined, 'the archived annex stays in the pool (the detector is never narrowed)')
    assert.equal(annex.admissible, false, 'an archived record is NEVER a legal duplicate_of destination')
    assert.equal(annex.relation, 'twin', 'declared as a twin (it declares its own destination)')
    assert.deepEqual(annex.destination, { 'fb-id': 'fb-0', estado: 'abierto', live: true, tail: true }, 'the destination is DECLARED with its tail estado and its liveness')
    // The invariant, asserted exactly: admissible ⇔ canonical relation.
    assert.equal(annex.admissible, annex.relation === 'canonical' || annex.relation === 'canonical-shared')
    // The LIVE half is the legal destination, and it is the twin's resolution.
    assert.ok(canonical !== undefined, 'the live canonical is offered')
    assert.equal(canonical.admissible, true)
    assert.equal(canonical.relation, 'canonical-shared', 'another record declares it as its destination (the consumer canonical)')
    assert.equal(canonical.linked_from, 'fb-9')
    assert.equal(canonical.resolved_from, 'fb-9', 'the LIVE destination IS the inadmissible offer\'s resolution')
    assert.equal(canonical.estado, 'abierto')
    // CONSISTENCY with the create path: the declared destination resolves.
    assert.ok(store.get(annex.destination['fb-id']) !== undefined, 'offer.destination["fb-id"] is exactly what `duplicate_of` accepts')
    assert.equal(isTerminalEstado(annex.estado), true, '`duplicado` IS terminal (read at isTerminalEstado) — terminal is NOT the same as inadmissible')
  })
})

test('fb-1874 (A-negative) the create-path INVARIANT holds both ways: an archive-only id with no declaration fails, a LIVE duplicado destination succeeds', async () => {
  await withTempStateDir(async (stateDir) => {
    const filePath = resolveFeedbackPath(stateDir)
    const archivePath = resolveFeedbackArchivePath(stateDir)
    await writeFile(filePath, jsonl([
      fbRecord(0, { resumen: SUBJECT, estado: 'abierto' }),
      // A LIVE `duplicado`: excluded from the OFFERS, still a LEGAL destination.
      fbRecord(1, { resumen: 'zeta eta theta iota', estado: 'duplicado', duplicate_of: 'fb-0' }),
      // An ordinary live record with the SAME resumen as fb-1, so the pool is
      // provably NOT empty when fb-1 is absent from it.
      fbRecord(6, { resumen: 'zeta eta theta iota six', estado: 'abierto' })
    ]), 'utf8')
    // An archive-only record that declares NOTHING: never a legal destination.
    await writeFile(archivePath, jsonl([fbRecord(8, { resumen: 'kappa lambda alpha bravo', estado: 'resuelto' })]), 'utf8')
    const store = await FeedbackStore.open(stateDir)
    // NEGATIVE CONTROL (no narrowing): the archive-only record is STILL OFFERED.
    const offers = await store.dedupeCandidates(query)
    const orphan = offers.find((c) => c['fb-id'] === 'fb-8')
    assert.ok(orphan !== undefined, 'an archive-only record is STILL OFFERED with its estado declared')
    assert.equal(orphan.admissible, false)
    assert.equal(orphan.relation, 'archived', 'no declaration ⇒ the relation is a plain archive-only record')
    assert.equal(orphan.destination, undefined)
    // NEGATIVE CONTROL (the create path): offering it does NOT make it usable.
    await assert.rejects(
      store.append({ emisor: 'w2', tipo: 'fallo', severidad: 'medio', resumen: 'x', duplicate_of: 'fb-8' }),
      /is not a live feedback record/,
      'the declare-and-refuse asymmetry is what admissible:false now ANNOUNCES in advance'
    )
    // NEGATIVE CONTROL (the filter that ALREADY EXISTED still works): a LIVE
    // `duplicado` is not OFFERED while its lexically-identical live sibling IS.
    const liveOffers = await store.dedupeCandidates({ resumen: 'zeta eta theta iota', tipo: 'fallo', severidad: 'medio' })
    assert.ok(liveOffers.some((c) => c['fb-id'] === 'fb-6'), 'the pool is NOT empty: fb-6 is offered')
    assert.equal(liveOffers.some((c) => c['fb-id'] === 'fb-1'), false, 'a LIVE duplicado is never an OFFER')
    // ...and it IS a legal destination (the create path validates by ID PRESENCE),
    // so `admissible` must NOT be keyed on the estado.
    const merged = await store.append({ emisor: 'w3', tipo: 'fallo', severidad: 'medio', resumen: 'y', duplicate_of: 'fb-1' })
    assert.equal(merged.estado, 'duplicado')
    assert.equal(merged.duplicate_of, 'fb-1')
  })
})

test("fb-1874 (B) GRAIN ASYMMETRY: the pool is projected BY TAIL — the same id never takes two slots, and the exhibited estado is the TAIL's", async () => {
  await withTempStateDir(async (stateDir) => {
    const filePath = resolveFeedbackPath(stateDir)
    const archivePath = resolveFeedbackArchivePath(stateDir)
    await writeFile(filePath, jsonl([
      fbRecord(0, { resumen: SUBJECT, estado: 'abierto' }),
      fbRecord(1, { resumen: 'alpha bravo charlie delta one', estado: 'abierto' }),
      // fb-3 is LIVE (tail `abierto`) and ALSO archived: the prune left a copy in
      // both files (the documented id-collision class: the id is an IDENTITY).
      fbRecord(3, { resumen: 'alpha bravo charlie delta three', estado: 'abierto', updatedAt: 1700000000900 })
    ]), 'utf8')
    await writeFile(archivePath, jsonl([
      // fb-3: the archived copy of an id that is LIVE — superseded, never an offer.
      fbRecord(3, { resumen: 'alpha bravo charlie delta three', estado: 'abierto', updatedAt: 1700000000300 }),
      // fb-4: TWO archived lines, the EARLIER exhibiting `abierto` while the TAIL
      // is `duplicado` — the exhibited-estado bug + the re-offer, in one id.
      fbRecord(4, { resumen: 'alpha bravo charlie delta four', estado: 'abierto', updatedAt: 1700000000400 }),
      fbRecord(4, { resumen: 'alpha bravo charlie delta four', estado: 'duplicado', duplicate_of: 'fb-0', updatedAt: 1700000000500, related: ['fb-0'] }),
      // fb-5: the DECLARATION survives only on a SUPERSEDED line (the tail, the
      // emitter's re-emission, is `abierto` and carries no field).
      fbRecord(5, { resumen: 'alpha bravo charlie delta five', estado: 'duplicado', duplicate_of: 'fb-1', updatedAt: 1700000000600, related: ['fb-1'] }),
      fbRecord(5, { resumen: 'alpha bravo charlie delta five', estado: 'abierto', updatedAt: 1700000000700 })
    ]), 'utf8')
    const store = await FeedbackStore.open(stateDir, { liveCap: 1000 })
    const offers = await store.dedupeCandidates(query, { max: 10 })
    const ids = offers.map((c) => c['fb-id'])
    // (B) ONE offer per id, whatever the line count and the ledgers.
    assert.deepEqual([...ids].sort(), [...new Set(ids)].sort(), `no id is offered twice: ${JSON.stringify(ids)}`)
    assert.equal(ids.filter((id) => id === 'fb-3').length, 1, 'the id living in BOTH ledgers is offered ONCE (the LIVE copy wins)')
    assert.equal(ids.filter((id) => id === 'fb-4').length, 1, 'the id with 2 archived lines is offered ONCE (no re-offer)')
    // The LIVE copy wins for an id in both ledgers.
    const three = offers.find((c) => c['fb-id'] === 'fb-3')
    assert.equal(three.admissible, true, 'the LIVE copy wins: the id IS a legal destination')
    assert.equal(three.relation, 'canonical')
    assert.equal(three.estado, 'abierto')
    // The exhibited estado is the TAIL's, never the superseded `abierto` line's.
    const four = offers.find((c) => c['fb-id'] === 'fb-4')
    assert.equal(four.estado, 'duplicado', 'the TAIL estado is exhibited (never the earlier `abierto` line)')
    assert.equal(four.admissible, false)
    assert.equal(four.relation, 'twin')
    assert.deepEqual(four.destination, { 'fb-id': 'fb-0', estado: 'abierto', live: true, tail: true })
    // A declaration that survives ONLY on a superseded line is STILL DECLARED
    // (and the id is archive-only: the exhibit is `abierto`, the tail's, while
    // the declaration comes from a line the tail superseded).
    const five = offers.find((c) => c['fb-id'] === 'fb-5')
    assert.equal(five.estado, 'abierto', 'the exhibition is the TAIL estado (not the superseded `duplicado`)')
    assert.equal(five.admissible, false, 'archive-only ⇒ not a legal destination (the LIVE ledger is what `duplicate_of` validates)')
    assert.equal(five.relation, 'twin', 'it declares its own destination ⇒ a declared twin')
    assert.deepEqual(five.destination, { 'fb-id': 'fb-1', estado: 'abierto', live: true, tail: false }, 'the declaration survives on a SUPERSEDED line: declared, marked tail:false, and its destination IS live ⇒ the offer RESOLVES to it')
    // The projection lives in the SCORER, so even a raw multi-line pool (the
    // shape the PRE pool had: bare records, the archive loaded per line) is
    // projected: ONE offer per id, and a superseded line can never exhibit.
    const rawPool = [
      fbRecord(0, { resumen: SUBJECT, estado: 'abierto' }),
      fbRecord(4, { resumen: 'alpha bravo charlie delta four', estado: 'abierto', updatedAt: 1700000000400 }),
      fbRecord(4, { resumen: 'alpha bravo charlie delta four', estado: 'duplicado', duplicate_of: 'fb-0', updatedAt: 1700000000500, related: ['fb-0'] })
    ]
    const rawOffers = findDuplicateCandidates(rawPool, { resumen: 'alpha bravo charlie delta four', tipo: 'fallo', severidad: 'medio' }, { max: 3 })
    assert.equal(rawOffers.filter((c) => c['fb-id'] === 'fb-4').length, 1, 'even a raw multi-line pool is projected: ONE offer per id (the PRE shape took TWO of the ≤3 slots)')
    assert.equal(rawOffers.filter((c) => c['fb-id'] === 'fb-4')[0].estado, 'duplicado', 'and the superseded `abierto` line is NEVER exhibited')
  })
})

test('fb-1874 (B) PROJECTION IS NOT NARROWING: every distinct id the PRE pool offers is still offered by the POST pool', async () => {
  await withTempStateDir(async (stateDir) => {
    const filePath = resolveFeedbackPath(stateDir)
    const archivePath = resolveFeedbackArchivePath(stateDir)
    const liveRecords = [
      fbRecord(0, { resumen: 'alpha bravo charlie delta one', estado: 'abierto' }),
      fbRecord(1, { resumen: 'alpha bravo charlie delta two', estado: 'en-estudio' }),
      fbRecord(2, { resumen: 'alpha bravo charlie delta three', estado: 'resuelto' })
    ]
    const archivedRecords = [
      fbRecord(2, { resumen: 'alpha bravo charlie delta three', estado: 'resuelto' }),
      fbRecord(3, { resumen: 'alpha bravo charlie delta four', estado: 'duplicado', duplicate_of: 'fb-1' }),
      fbRecord(5, { resumen: 'alpha bravo charlie delta five', estado: 'descartado' })
    ]
    await writeFile(filePath, jsonl(liveRecords), 'utf8')
    await writeFile(archivePath, jsonl(archivedRecords), 'utf8')
    const store = await FeedbackStore.open(stateDir, { liveCap: 1000 })
    const offers = await store.dedupeCandidates(query, { max: 10 })
    const ids = new Set(offers.map((c) => c['fb-id']))
    // The PRE shape: every line of both ledgers, NO projection.
    const preShape = findDuplicateCandidates([...liveRecords, ...archivedRecords], query, { max: 10 })
    for (const id of new Set(preShape.map((c) => c['fb-id']))) {
      assert.ok(ids.has(id), `no id disappears in the projection: ${id} (POST offers ${JSON.stringify([...ids])})`)
    }
    // The archive keeps nourishing the pool: an ARCHIVE-ONLY id is offered.
    assert.ok(ids.has('fb-5'), 'the archive still nourishes the pool (never excluded)')
    assert.ok(ids.has('fb-3'), 'the archived duplicado is still offered, with its estado declared')
    assert.equal(offers.find((c) => c['fb-id'] === 'fb-3').admissible, false)
    assert.equal(offers.find((c) => c['fb-id'] === 'fb-3').relation, 'twin')
    assert.deepEqual(offers.find((c) => c['fb-id'] === 'fb-3').destination, { 'fb-id': 'fb-1', estado: 'en-estudio', live: true, tail: true })
  })
})

test('fb-1874 (d.ledgers) BOTH LEDGERS end-to-end: open() prunes a terminal record into the archive and the pool still sees it', async () => {
  await withTempStateDir(async (stateDir) => {
    const filePath = resolveFeedbackPath(stateDir)
    await writeFile(filePath, jsonl([
      fbRecord(0, { resumen: 'alpha bravo charlie delta one', estado: 'abierto', updatedAt: 1700000000100 }),
      fbRecord(1, { resumen: 'alpha bravo charlie delta two', estado: 'abierto', updatedAt: 1700000000200 }),
      fbRecord(2, { resumen: 'alpha bravo charlie delta three', estado: 'duplicado', duplicate_of: 'fb-0', updatedAt: 1700000000300 })
    ]), 'utf8')
    const store = await FeedbackStore.open(stateDir, { liveCap: 2 })
    assert.equal(store.get('fb-2'), undefined, 'fb-2 (terminal) was pruned to the archive')
    const archiveText = await readFile(resolveFeedbackArchivePath(stateDir), 'utf8')
    assert.ok(archiveText.includes('"id":"fb-2"'), 'the ARCHIVE ledger now holds fb-2')
    const offers = await store.dedupeCandidates(query, { max: 10 })
    const archivedOffer = offers.find((c) => c['fb-id'] === 'fb-2')
    assert.ok(archivedOffer !== undefined, 'the ARCHIVED half of the pool is exercised (the archive nourishes the pool)')
    assert.equal(archivedOffer.admissible, false, 'an archived record is not a legal destination — declared, not discovered')
    assert.equal(archivedOffer.relation, 'twin', 'it declares fb-0, which is live ⇒ the offer resolves to it')
    assert.equal(archivedOffer.destination.live, true)
    const canonical = offers.find((c) => c['fb-id'] === 'fb-0')
    assert.ok(canonical !== undefined)
    assert.equal(canonical.admissible, true)
    assert.equal(canonical.resolved_from, 'fb-2', 'the live destination is the resolution of the archived offer')
    // The live index still knows the canonical; the archived id is NOT offered as
    // a legal destination even though the pool holds it.
    assert.ok(store.get('fb-0') !== undefined)
  })
})

test('fb-1874 unit divergence: the live CAP counts LINES while the dedupe pool counts IDS — declared in one place', async () => {
  await withTempStateDir(async (stateDir) => {
    const filePath = resolveFeedbackPath(stateDir)
    // 2 ids, 3 lines: a same-id transition does NOT consume a second pool offer.
    await writeFile(filePath, jsonl([
      fbRecord(0, { resumen: 'alpha bravo charlie delta', estado: 'abierto' }),
      fbRecord(0, { resumen: 'alpha bravo charlie delta', estado: 'en-estudio' }),
      fbRecord(1, { resumen: 'alpha bravo charlie delta echo', estado: 'abierto' })
    ]), 'utf8')
    const store = await FeedbackStore.open(stateDir, { liveCap: 1000 })
    assert.equal(store.size, 3, 'the store size is a LINE count (3 lines, 2 ids)')
    const offers = await store.dedupeCandidates({ resumen: 'alpha bravo charlie delta', tipo: 'fallo', severidad: 'medio' }, { max: 10 })
    const ids = offers.map((c) => c['fb-id'])
    assert.equal(ids.length, new Set(ids).size, 'the pool is an ID count: one offer per id, never one offer per line')
    assert.deepEqual([...ids].sort(), ['fb-0', 'fb-1'], 'both ids are offered, each ONCE')
    const divergence = feedbackUnitDivergence()
    assert.match(divergence, /LINES/)
    assert.match(divergence, /IDS/)
  })
})
