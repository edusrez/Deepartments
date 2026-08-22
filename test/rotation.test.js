// dsh-deepartments — U2: HOST SESSION ROTATION at dept_sleep (pure helper +
// orchestration unit tests). Spec: docs/specs/002-host-session-rotation.md
// §3.2/§3.3/§3.5/§3.6. Pure unit tests over lib/session-rotation.js: seed
// shape + contiguity + cold-boot (T1), re-key (D3/T3), hosts.json rotation
// entries + schemaVersion validation (D4), the archive wrapper, the S2.7 copy,
// and the crash windows (§3.6: create fails → {rotated:false} (the legacy
// fallback trigger); archive fails → non-fatal; rotation commits before it
// resolves — concludeTurn ordering is invoke-side). The retired-skip WAKE GATE
// itself is one invoke.ts line; its behavior is covered by the integration
// pre-step tests in invoke.test.js (where the real Loader lives).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { encodeSegment } from '../lib/session-cleanup.js'
import { buildSleepJournalMessage } from '../lib/invoke.js'
import {
  ROTATION_SCHEMA_VERSION,
  buildRotationSeed,
  buildRotationSeedMessage,
  rekeyJournal,
  hostsRotationRecords,
  validateHostsRotationFile,
  archiveOldSession,
  copyOldArtifactToArchive,
  runHostRotation
} from '../lib/session-rotation.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'deepartments-rotation-'))
  try {
    return await fn(dir)
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }))
  }
}

/** A typical pre-sleep host journal (as dept_memo_write + the S1.5 bump leave
 * it): frontmatter with the OLD host author + wake_counter 2 (bumped). */
function sampleBumpedJournal(oldHostId, summary = 'HOST-ROTATION-MEMORY: carried forward into the rotated session.') {
  return [
    '---',
    `author: ${oldHostId}`,
    'timestamp: 2026-08-22T10:00:00.000Z',
    'wake_counter: 2',
    'board_cursor: none',
    'decisions: []',
    'constraints: []',
    'open_items: []',
    '---',
    '',
    summary,
    ''
  ].join('\n')
}

const logger = () => {
  const calls = { error: [], warn: [] }
  return {
    calls,
    error: (m) => calls.error.push(m),
    warn: (m) => calls.warn.push(m)
  }
}

test('U2 T1: buildRotationSeed produces the contiguous minimal-artifact event list (setup + re-keyed journal), cold-boots via Session.fromRestore', async () => {
  const oldHostId = 'host-session-old'
  const newHostId = 'host-session-new'
  const reKeyed = sampleBumpedJournal(oldHostId).replace(/^author: .*$/m, `author: ${newHostId}`)
  const seed = buildRotationSeed(reKeyed, { now: 1787000000000 })

  // Exact event types, contiguous seq 0..k (the Session ctor contract).
  assert.deepEqual(seed.map((ev) => ev.type), ['permission/preset', 'sandbox/mode', 'approval/policy', 'user/message'])
  seed.forEach((ev, i) => assert.equal(ev.seq, i, `seq ${ev.seq} contiguous at index ${i}`))
  assert.ok(seed.every((ev) => ev.time === 1787000000000), 'seed times pinned by the clock seam')

  // The journal node: plugin/notice framing, byte-identical journal text
  // modulo re-key (compare the model-visible content + source shape against
  // buildSleepJournalMessage — see spec T1).
  const journalEvent = seed[3]
  assert.equal(journalEvent.surfaceOp, 'append', 'journal node stays append-origin')
  const data = journalEvent.data
  assert.equal(data.role, 'user')
  assert.equal(data.content[0].type, 'text')
  assert.equal(data.content[0].text, reKeyed, 'seed journal text is the re-keyed journal (author: host-<newId>)')
  assert.equal(data.source.kind, 'plugin')
  assert.equal(data.source.plugin, 'deepartments')
  assert.equal(data.source.form, 'notice')
  assert.ok(typeof data.id === 'string' && data.id.length > 0, 'message carries an identity')
  const legacy = buildSleepJournalMessage(reKeyed)
  assert.equal(data.role, legacy.role, 'same framing as buildSleepJournalMessage')
  assert.equal(data.source.kind, legacy.source.kind)
  assert.equal(data.source.plugin, legacy.source.plugin)
  assert.equal(data.source.form, legacy.source.form)

  // T1 cold-boot proof (the resume ctor): Session.fromRestore accepts the
  // exact list and the surface folds to the single journal node.
  const restored = Session.fromRestore(SessionId('session-rot-t1'), seed, {
    version: 0,
    id: 'session-rot-t1',
    createdAt: 1787000000000,
    cwd: '/root'
  })
  assert.equal(restored.seq, seed.length + 1, 'fresh session continues appending after the seed (+ end-seed marker)')
  assert.equal(restored.surface.nodes.length, 1, 'the journal node is the only surface node')
  const derived = restored.deriveMessages()
  assert.equal(derived.length, 1)
  assert.equal(derived[0].content[0].text, reKeyed, 'the wake surface node is the re-keyed journal')
  assert.ok(!restored.events.some((ev) => ev.type === 'turn/start'), 'seeded session stays blank (no turn/start)')
})

test('U2 T1: buildRotationSeedMessage frames the journal as a plugin/notice context (never a user-typed message)', () => {
  const msg = buildRotationSeedMessage('A') 
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'plugin')
  assert.equal(msg.source.plugin, 'deepartments')
  assert.equal(msg.source.form, 'notice')
  assert.ok(typeof msg.source.summary === 'string' && msg.source.summary.length > 0)
})

test('U2 T3: rekeyJournal rewrites ONLY the frontmatter author (room + every other byte untouched) and throws without an author line', () => {
  const oldHostId = 'host-session-old'
  const newHostId = 'host-session-new'
  const before = [
    '---',
    `author: ${oldHostId}`,
    'room: board',
    'wake_counter: 2',
    '---',
    '',
    'body line',
    ''
  ].join('\n')
  const after = rekeyJournal(before, newHostId)
  assert.match(after, new RegExp(`^author: ${newHostId}$`, 'm'), 'author rewritten to the new member')
  assert.match(after, /^room: board$/m, 'room unchanged (D3)')
  assert.match(after, /^wake_counter: 2$/m, 'wake ordinal untouched')
  assert.ok(after.includes('body line'), 'body untouched')
  assert.throws(() => rekeyJournal('no author here\n', newHostId), /no "author:" frontmatter line/, 'loud throw on a malformed journal')
})

test('U2 D4: hostsRotationRecords builds the old retired entry + the new live entry (schemaVersion shape)', () => {
  const oldHostId = 'host-session-old'
  const oldSessionId = 'session-old'
  const newHostId = 'host-session-new'
  const newSessionId = 'session-new'
  const records = hostsRotationRecords(
    { hostId: oldHostId, sessionId: oldSessionId, roomId: 'board', sleepEpoch: 90, boundarySeq: 40 },
    newSessionId,
    { newHostId, roomId: 'board', sleepEpoch: 100, boundarySeq: 42, retiredAt: 101 }
  )
  // Old entry: spread of the old persisted fields + retired markers; never
  // webUiCleanupPending/deferredJournalSeed (S4/S5).
  assert.equal(records.oldEntry.sessionId, oldSessionId)
  assert.equal(records.oldEntry.roomId, 'board')
  assert.equal(records.oldEntry.sleepEpoch, 90, 'old sleepEpoch preserved')
  assert.equal(records.oldEntry.boundarySeq, 40, 'old boundarySeq preserved')
  assert.equal(records.oldEntry.retired, true)
  assert.equal(records.oldEntry.retiredAt, 101)
  assert.equal(records.oldEntry.rotatedTo, newHostId)
  assert.equal(records.oldEntry.webUiCleanupPending, undefined, 'S4: rotation never sets webUiCleanupPending')
  assert.equal(records.oldEntry.deferredJournalSeed, undefined, 'S5: rotation never sets deferredJournalSeed')
  assert.equal(records.oldEntry.previousSessionId, undefined, 'old entry never carries previousSessionId')
  // New entry: rotation fields; boundarySeq optional.
  assert.deepEqual(records.newEntry, {
    sessionId: newSessionId,
    roomId: 'board',
    sleepEpoch: 100,
    boundarySeq: 42,
    previousSessionId: oldSessionId
  })
  // boundarySeq absent when not supplied.
  const noSeq = hostsRotationRecords(
    { hostId: oldHostId, sessionId: oldSessionId, roomId: 'board' },
    newSessionId,
    { newHostId, roomId: 'board', sleepEpoch: 100, retiredAt: 101 }
  )
  assert.equal(noSeq.newEntry.boundarySeq, undefined, 'boundarySeq optional')
  assert.equal(ROTATION_SCHEMA_VERSION, 2, 'schemaVersion marker constant is 2')
})

test('U2 D4: validateHostsRotationFile accepts legacy (v1) files, rejects malformed NEW fields loudly, and validates the previousSessionId reference', () => {
  const oldHostId = 'host-session-old'
  const oldSessionId = 'session-old'
  const newHostId = 'host-session-new'
  const newSessionId = 'session-new'
  const v2 = {
    schemaVersion: 2,
    [newHostId]: { sessionId: newSessionId, roomId: 'board', sleepEpoch: 100, boundarySeq: 42, previousSessionId: oldSessionId },
    [oldHostId]: { sessionId: oldSessionId, roomId: 'board', sleepEpoch: 90, boundarySeq: 40, retired: true, retiredAt: 101, rotatedTo: newHostId }
  }
  assert.doesNotThrow(() => validateHostsRotationFile(v2), 'valid v2 file loads')
  // Legacy v1 (absent retired/schemaVersion) — pre-rotation behavior preserved.
  assert.doesNotThrow(() => validateHostsRotationFile({ [oldHostId]: { sessionId: oldSessionId, roomId: 'board', sleepEpoch: 90, boundarySeq: 40 } }), 'legacy v1 file loads')
  assert.doesNotThrow(() => validateHostsRotationFile({ [oldHostId]: { sessionId: oldSessionId, roomId: 'board' } }), 'never-slept legacy entry loads')
  // Malformed NEW fields fail loud (never silently dropped).
  assert.throws(() => validateHostsRotationFile({ [oldHostId]: { sessionId: oldSessionId, roomId: 'board', retired: true, rotatedTo: newHostId } }), /must carry a numeric retiredAt/, 'retired entry missing retiredAt')
  assert.throws(() => validateHostsRotationFile({ [oldHostId]: { sessionId: oldSessionId, roomId: 'board', retired: true, retiredAt: 1 } }), /must carry a non-empty rotatedTo/, 'retired entry missing rotatedTo')
  assert.throws(() => validateHostsRotationFile({ [oldHostId]: { sessionId: oldSessionId, roomId: 'board', retired: true, retiredAt: 1, rotatedTo: 42 } }), /non-string rotatedTo/, 'rotatedTo must be a string')
  assert.throws(() => validateHostsRotationFile({ [oldHostId]: { sessionId: oldSessionId, roomId: 'board', retired: 'yes' } }), /non-boolean retired marker/, 'retired must be boolean')
  assert.throws(
    () => validateHostsRotationFile({ [newHostId]: { sessionId: newSessionId, roomId: 'board', previousSessionId: oldSessionId } }),
    /must carry a numeric sleepEpoch/,
    'rotated live entry must carry sleepEpoch'
  )
  // Relational: previousSessionId must reference a RETIRED entry in the same file.
  assert.throws(
    () => validateHostsRotationFile({
      [newHostId]: { sessionId: newSessionId, roomId: 'board', sleepEpoch: 100, previousSessionId: oldSessionId },
      [oldHostId]: { sessionId: oldSessionId, roomId: 'board' }
    }),
    /references previousSessionId .* not a retired entry/,
    'previousSessionId must reference a retired entry'
  )
  assert.throws(
    () => validateHostsRotationFile({ [newHostId]: { sessionId: newSessionId, roomId: 'board', sleepEpoch: 100, previousSessionId: 'session-ghost' } }),
    /not a retired entry in the same file/,
    'unknown previousSessionId rejected'
  )
})

test('U2 D1: archiveOldSession wraps archiveSession without throwing (registry missing / failure / success)', async () => {
  // Missing registry → non-fatal result + loud log.
  const missLog = logger()
  const missed = await archiveOldSession(undefined, 'session-old', missLog)
  assert.equal(missed.ok, false)
  assert.match(missed.reason, /workspaceRegistry unavailable/)
  assert.equal(missLog.calls.error.length, 1, 'missing registry logged loudly')
  // Successful archive.
  const archived = []
  const ok = await archiveOldSession({ archiveSession: async (id) => { archived.push(id) } }, 'session-old')
  assert.equal(ok.ok, true)
  assert.deepEqual(archived, ['session-old'])
  // Failing archive → non-fatal + logged, never throws.
  const failLog = logger()
  const failed = await archiveOldSession({ archiveSession: async () => { throw new Error('registry blown') } }, 'session-old', failLog)
  assert.equal(failed.ok, false)
  assert.match(failed.reason, /registry blown/)
  assert.equal(failLog.calls.error.length, 1, 'archive failure logged loudly')
})

test('U2 D2: copyOldArtifactToArchive copies (never moves) the old artifact under a pre-rotation name; degrades gracefully', async () => {
  await withTempDir(async (dir) => {
    const oldSessionId = 'session-old'
    const sessionsRoot = path.join(dir, 'sessions')
    const archiveDir = path.join(dir, 'archive')
    // Fake stored artifact exactly where findSessionArtifact looks.
    const stored = path.join(sessionsRoot, '--root--', encodeSegment(oldSessionId), 'session.jsonl.zstd')
    await mkdir(path.dirname(stored), { recursive: true })
    const payload = Buffer.from('FAKE-ZSTD-FRAME-BYTES')
    await writeFile(stored, payload)

    const result = await copyOldArtifactToArchive({ sessionsRoot, oldSessionId, archiveDir, now: 1787000000000 })
    assert.equal(result.ok, true, 'copy succeeded')
    const names = await readdir(archiveDir)
    assert.equal(names.length, 1)
    assert.match(names[0], /^session-session-old-pre-rotation-\d{8}-\d{6}\.jsonl\.zstd$/, 'evidence copy named with the pre-rotation convention')
    assert.deepEqual(await readFile(path.join(archiveDir, names[0])), payload, 'byte-identical copy')
    assert.deepEqual(await readFile(stored), payload, 'the LIVE artifact stays in place (copy, never move)')

    // Missing artifact → graceful failure, never throws.
    const gone = await copyOldArtifactToArchive({ sessionsRoot, oldSessionId: 'session-ghost', archiveDir })
    assert.equal(gone.ok, false)
    assert.match(gone.reason, /no stored artifact/)
  })
})

// --- runHostRotation: the S1.5b→S7 orchestration + crash windows (§3.6) ------

function rotationHarness(dir, overrides = {}) {
  const oldSessionId = 'session-old'
  const oldHostId = `host-${oldSessionId}`
  const hosts = new Map([[oldHostId, { hostId: oldHostId, sessionId: oldSessionId, roomId: 'board' }]])
  const hostForSession = new Map([[oldSessionId, oldHostId]])
  const log = logger()
  const state = {
    created: [],
    persisted: 0,
    hosts,
    hostForSession,
    log
  }
  const deps = {
    oldSessionId,
    oldHostId,
    roomId: 'board',
    seededJournal: sampleBumpedJournal(oldHostId),
    journalsDir: path.join(dir, 'journals'),
    workspacePath: '/root',
    boundarySeq: 42,
    sessions: {
      create(id, options) { state.created.push({ id, options }); return { id } }
    },
    workspaceRegistry: { archiveSession: async () => undefined },
    sessionsRoot: path.join(dir, 'sessions'),
    archiveDir: path.join(dir, 'archive'),
    hosts,
    hostForSession,
    persistHosts: () => { state.persisted++ },
    logger: log,
    now: () => 1787000000000,
    ...overrides
  }
  return { deps, state }
}

async function authorFakeArtifact(sessionsRoot, sessionId) {
  const stored = path.join(sessionsRoot, '--root--', encodeSegment(sessionId), 'session.jsonl.zstd')
  await mkdir(path.dirname(stored), { recursive: true })
  await writeFile(stored, Buffer.from('FAKE-ARTIFACT'))
}

test('U2 §3.6 crash window: create failure → {rotated:false} + no hosts.json mutation (the LEGACY FALLBACK trigger)', async () => {
  await withTempDir(async (dir) => {
    const { deps, state } = rotationHarness(dir, {
      sessions: { create() { throw new Error('injected store failure') } }
    })
    const outcome = await runHostRotation(deps)
    assert.equal(outcome.rotated, false)
    assert.match(outcome.reason, /session create failed: injected store failure/)
    assert.equal(state.hosts.size, 1, 'hosts map untouched (old entry only)')
    assert.equal(state.hosts.get(deps.oldHostId).retired, undefined, 'old entry NOT retired')
    assert.equal(state.persisted, 0, 'persistHosts never called on the failure path')
  })
})

test('U2 §3.6 crash window: missing sessions store → {rotated:false} (fallback), and a re-key failure is also a clean fallback', async () => {
  await withTempDir(async (dir) => {
    const missing = await runHostRotation(rotationHarness(dir, { sessions: undefined }).deps)
    assert.equal(missing.rotated, false)
    assert.match(missing.reason, /sessions store unavailable/)
    const badJournal = rotationHarness(dir, { seededJournal: 'no frontmatter here\n' })
    const bad = await runHostRotation(badJournal.deps)
    assert.equal(bad.rotated, false)
    assert.match(bad.reason, /journal re-key failed/)
    assert.equal(badJournal.state.persisted, 0, 'no persist on the re-key failure path')
  })
})

test('U2 D1 §3.6: ARCHIVE failure is NON-FATAL — the rotation still commits (new live entry + old retired + persisted), with a loud log', async () => {
  await withTempDir(async (dir) => {
    await authorFakeArtifact(path.join(dir, 'sessions'), 'session-old')
    const { deps, state } = rotationHarness(dir, {
      workspaceRegistry: { archiveSession: async () => { throw new Error('registry down') } }
    })
    const outcome = await runHostRotation(deps)
    assert.equal(outcome.rotated, true, 'rotation commits despite the archive failure')
    assert.equal(outcome.archive.ok, false)
    assert.match(outcome.archive.reason, /registry down/)
    assert.equal(state.log.calls.error.length, 1, 'archive failure logged loudly')
    // S2 still created the new session; S3/S7 rotated hosts.
    const newHostId = outcome.newHostId
    assert.equal(state.hosts.get(newHostId).sessionId, outcome.newSessionId, 'new live entry registered')
    assert.equal(state.hosts.get(newHostId).sleepEpoch, 1787000000000, 'durable sleepEpoch on the new entry (S7)')
    assert.equal(state.hosts.get(deps.oldHostId).retired, true, 'old entry retired')
    assert.equal(state.hosts.get(deps.oldHostId).rotatedTo, newHostId, 'retired entry points at the new host')
    assert.equal(state.hostForSession.get(outcome.newSessionId), newHostId, 'reverse map updated')
    assert.ok(state.persisted >= 1, 'hosts.json persisted')
  })
})

test('U2 D1: a MISSING workspace registry is non-fatal (headless degrade) — rotation commits the hosts.json retire', async () => {
  await withTempDir(async (dir) => {
    const { deps, state } = rotationHarness(dir, { workspaceRegistry: undefined })
    const outcome = await runHostRotation(deps)
    assert.equal(outcome.rotated, true)
    assert.equal(outcome.archive.ok, false)
    assert.match(outcome.archive.reason, /workspaceRegistry unavailable/)
    assert.equal(state.hosts.get(deps.oldHostId).retired, true, 'hosts.json retire still commits without the GUI service')
    assert.equal(state.log.calls.error.length, 1, 'missing registry logged loudly')
  })
})

test('U2 §3.3/S8: the rotation COMMITS (journals + hosts.json) before it resolves — the concludeTurn ordering is invoke-side', async () => {
  await withTempDir(async (dir) => {
    await authorFakeArtifact(path.join(dir, 'sessions'), 'session-old')
    const { deps, state } = rotationHarness(dir, { boundarySeq: 42, now: () => 1787000000000 })
    // Simulate S1.5: the bump already persisted the OLD journal file (the
    // rotation reads nothing from it — the re-key source is `seededJournal` —
    // but the file must exist to assert G4 byte-identity afterwards).
    await mkdir(deps.journalsDir, { recursive: true })
    await writeFile(path.join(deps.journalsDir, `${deps.oldHostId}.md`), deps.seededJournal, 'utf8')
    const outcome = await runHostRotation(deps)
    assert.equal(outcome.rotated, true)
    const newHostId = outcome.newHostId
    const newSessionId = outcome.newSessionId
    assert.match(newHostId, new RegExp(`^host-session-`), 'new host id is host-<newId>')
    assert.match(newSessionId, /^session-/, 'new session id is session-<uuid>')

    // S1.5b — the re-keyed journal exists BEFORE anything else, atomic, named
    // host-<newId>, author re-keyed, wake ordinal preserved (bumped at S1.5 on
    // the OLD file — kept as the archive copy).
    const journalText = await readFile(outcome.newJournalPath, 'utf8')
    assert.match(journalText, new RegExp(`^author: ${newHostId}$`, 'm'), 'new journal author re-keyed to host-<newId>')
    assert.match(journalText, /^wake_counter: 2$/m, 'new journal carries the BUMPED ordinal')
    const oldJournal = await readFile(path.join(deps.journalsDir, `${deps.oldHostId}.md`), 'utf8')
    assert.equal(oldJournal, deps.seededJournal, 'OLD journal file byte-identical (bump only, archive copy — G4/D2)')

    // S2 — the new session was created with the contiguous seed + header meta.
    assert.equal(state.created.length, 1, 'exactly one session created')
    const [created] = state.created
    assert.equal(created.id, newSessionId, 'pre-minted id used')
    assert.equal(created.options.meta.cwd, '/root', 'workspace path attributed')
    assert.equal(created.options.meta.seedLength, created.options.seed.length)
    assert.deepEqual(created.options.seed.map((ev) => ev.type), ['permission/preset', 'sandbox/mode', 'approval/policy', 'user/message'])
    assert.equal(created.options.seed[3].data.content[0].text, journalText, 'seed journal node carries the re-keyed journal')

    // S3/S7 — hosts.json records committed BEFORE resolve (persist called).
    assert.ok(state.persisted >= 1, 'commit happens before the outcome resolves (concludeTurn ordering is invoke-side)')
    assert.equal(state.hosts.get(newHostId).previousSessionId, deps.oldSessionId, 'new entry traces the previous session')
    assert.equal(state.hosts.get(newHostId).boundarySeq, 42, 'boundary seq recorded on the new entry')
    assert.equal(state.hosts.get(deps.oldHostId).retired, true)
    assert.equal(state.hosts.get(deps.oldHostId).retiredAt, 1787000000000)
    assert.equal(state.hosts.get(deps.oldHostId).rotatedTo, newHostId)

    // S2.5/S2.7 — archive recorded + evidence copy landed (D1/D2).
    assert.equal(outcome.archive.ok, true, 'archive called and resolved')
    const names = await readdir(deps.archiveDir)
    assert.equal(names.length, 1)
    assert.match(names[0], /pre-rotation-/, 'evidence copy written')

    // Outcome contract for invoke.ts.
    assert.equal(outcome.newJournalPath, path.join(deps.journalsDir, `${newHostId}.md`))
    assert.equal(outcome.sleepEpoch, 1787000000000)
    assert.equal(outcome.reKeyedJournal, journalText)
  })
})