// dsh-deepartments — "clean the web GUI at host sleep" (Option A) tests.
//
// Verifies the plugin-side sleep cleanup (src/session-cleanup.ts + the
// invoke.ts boot hook + the dept_sleep pending marker):
//   1. truncateSessionArtifact: the host session.jsonl.zstd is rewritten to
//      header + permission/sandbox/approval + the LAST append-origin journal
//      node, renumbered 0..k, valid zstd (two checksummed frames like the
//      runtime backend), and the artifact COLD-BOOTS: Session.fromRestore
//      (the exact constructor dsh-agent-loop uses on resume) accepts it.
//   2. resetProjectionRows: the host row (and archived child rows) drop from
//      session_projcache.json atomically.
//   3. archiveAndDeleteSubagentChildren: direct children (header origin
//      'subagent' + parentSession = host — the exact subagent.list criteria)
//      are tar.gz'd under the derived state-home archive dir and their source
//      dirs deleted; non-children (heads/rooms/other parents) are never
//      touched; LIVE children are skipped.
//   4. Real-Loader boot integration: with webUiCleanupPending seeded in
//      hosts.json, the first boot performs the cleanup exactly once and
//      clears the flag; a second direct run is a no-op.
//   5. Real-Loader dept_sleep: the host sleep flow still completes and sets
//      the pending marker durably (the physical cleanup is deferred to the
//      next boot — see src/session-cleanup.ts header for the runtime proof).
//
// Rule 5 (AGENTS.md): the integration tests go through the REAL Cordis
// Loader with a temp stateDir; every artifact mutation happens in the TEST
// fixture tree — NEVER against a live service.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import {
  archiveAndDeleteSubagentChildren,
  compressZstdFrame,
  decodeZstdArtifact,
  encodeSegment,
  findSessionArtifact,
  parseSessionLog,
  planMinimalArtifact,
  resetProjectionRows,
  runSleepCleanup,
  truncateSessionArtifact
} from '../lib/session-cleanup.js'
import { shouldClearCleanupPending } from '../lib/invoke.js'

const TEST_ORG = {
  rooms: [
    { id: 'board', name: 'Board of directors', purpose: 'Coordination room', members: ['asistente', 'research-head'] },
    { id: 'research', name: 'Research department', purpose: 'Research department room', members: ['research-head'] }
  ],
  departments: [
    {
      id: 'research',
      name: 'Research',
      roomId: 'research',
      coordinator: {
        postId: 'research-head',
        role: 'Research department head',
        provider: 'deepseek-official',
        agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' }
      }
    }
  ]
}

const HOST_SESSION = 'session-cleanup-host-0000-0000-000000000000'
const HOST_ID = `host-${HOST_SESSION}`

async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-cleanup-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

// --- fixture authoring -------------------------------------------------------

/** Author one valid surface event line (user/message shape the runtime seed
 * validator requires: id + role + source.kind + content array). */
function userMessageSeq(seq, text, sourceKind, opts = {}) {
  const source = { kind: sourceKind, ...(opts.source ?? {}) }
  return JSON.stringify({
    type: 'user/message',
    seq,
    time: 1787000000000 + seq,
    data: {
      content: [{ type: 'text', text }],
      source,
      role: 'user',
      id: `msg-${seq}-${sourceKind}`
    },
    surfaceOp: 'append'
  })
}

/** Author the durable session artifact the fixture starts from: header frame +
 * one events frame (the runtime backend's physical layout), containing the
 * setup events + several ordinary events + the sleep journal node. */
async function authorArtifact(artifactPath, { journalText, extraEvents = 4, journalSeq = 3 + 4 - 1 } = {}) {
  const headerLine = JSON.stringify({
    type: 'session',
    version: 0,
    id: HOST_SESSION,
    createdAt: 1787000000000,
    cwd: '/root',
    delegationDepth: 0,
    agentPreset: 'deepartments'
  })
  const events = [
    JSON.stringify({ type: 'permission/preset', seq: 0, time: 1787000000001, data: { preset: 'danger-full-access' } }),
    JSON.stringify({ type: 'sandbox/mode', seq: 1, time: 1787000000002, data: { mode: 'danger-full-access' } }),
    JSON.stringify({ type: 'approval/policy', seq: 2, time: 1787000000003, data: { policy: 'never' } }),
    JSON.stringify({ type: 'turn/start', seq: 3, time: 1787000000004, data: { turn: 1 } }),
    JSON.stringify({ type: 'step/start', seq: 4, time: 1787000000005, data: { turn: 1, step: 0 } })
  ]
  const base = 5
  for (let i = 0; i < extraEvents; i++) {
    events.push(userMessageSeq(base + i, `ordinary turn ${i + 1}`, 'user'))
  }
  const journalIdx = base + extraEvents
  events.push(userMessageSeq(journalIdx, journalText, 'plugin', {
    source: {
      form: 'notice',
      summary: 'Reopened after sleep — in-place surface reset to your journal (long-term memory).'
    }
  }))
  // A couple of trailing non-surface events after the journal (like the
  // harness's own post-sleep appends in a real artifact).
  events.push(JSON.stringify({ type: 'step/end', seq: journalIdx + 1, time: 1787000001000, data: { turn: 1, step: 0 } }))
  events.push(JSON.stringify({ type: 'turn/end', seq: journalIdx + 2, time: 1787000001001, data: { turn: 1, reason: { kind: 'completed' } } }))
  await mkdir(path.dirname(artifactPath), { recursive: true })
  const headerFrame = await compressZstdFrame(`${headerLine}\n`)
  const eventFrame = await compressZstdFrame(`${events.join('\n')}\n`)
  await writeFile(artifactPath, Buffer.concat([headerFrame, eventFrame]))
  return { headerLine, events, journalLine: events[journalIdx], totalEvents: events.length }
}

/** Author a subagent child artifact with a subagent/parent header (the exact
 * header pair subagent.list uses to filter children). */
async function authorSubagentArtifact(artifactPath, { id, parentSession, journalText }) {
  await mkdir(path.dirname(artifactPath), { recursive: true })
  const headerLine = JSON.stringify({
    type: 'session', version: 0, id, createdAt: 1787000000000, cwd: '/root',
    parentSession, origin: 'subagent', delegationDepth: 1, agentPreset: 'deepartments'
  })
  const events = [
    JSON.stringify({ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } }),
    userMessageSeq(1, journalText, 'plugin', { source: { form: 'notice' } }),
    JSON.stringify({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1 } })
  ]
  const headerFrame = await compressZstdFrame(`${headerLine}\n`)
  const eventFrame = await compressZstdFrame(`${events.join('\n')}\n`)
  await writeFile(artifactPath, Buffer.concat([headerFrame, eventFrame]))
}

const JOURNAL_TEXT = [  '---',
  `author: ${HOST_ID}`,
  'room: board',
  `timestamp: 2026-08-21T13:50:21.001Z`,
  'wake_counter: 2',
  'board_cursor: none',
  'decisions: []',
  'constraints: []',
  'open_items: []',
  '---',
  '',
  'HOST-SLEEP-MEMORY: the cleanup fixture journal.',
  ''
].join('\n')

/** Build the full fixture tree: sessions root with the host artifact, several
 * child subagent dirs (some direct children, one other parent, one live), one
 * head/room dir, a projcache with the host row + an unrelated row, and a
 * hosts.json with the pending flag. Returns every derived path. */
async function buildFixtureTree(stateDir, { pending = true, childCount = 2 } = {}) {
  const sessionsRoot = path.join(stateDir, 'sessions')
  const hostDir = path.join(sessionsRoot, '--root--', encodeSegment(HOST_SESSION))
  const hostArtifact = path.join(hostDir, 'session.jsonl.zstd')
  const authored = await authorArtifact(hostArtifact, { journalText: JOURNAL_TEXT })
  // Direct child subagent dirs (origin=subagent, parentSession=host).
  const childIds = []
  for (let i = 0; i < childCount; i++) {
    const id = `session-cleanup-child-0000-0000-00000000000${i}`
    childIds.push(id)
    await authorSubagentArtifact(path.join(sessionsRoot, '--root--', id, 'session.jsonl.zstd'), {
      id,
      parentSession: HOST_SESSION,
      journalText: `---\nauthor: ${id}\nwake_counter: 1\n---\n\nchild ${i}`
    })
  }
  // A child of ANOTHER parent (must NOT be archived).
  const otherChild = 'session-cleanup-child-other'
  await authorSubagentArtifact(path.join(sessionsRoot, '--root--', otherChild, 'session.jsonl.zstd'), {
    id: otherChild,
    parentSession: 'session-some-other-parent',
    journalText: 'other'
  })
  // A registered head dir (origin absent — must NEVER be archived/deleted).
  const headId = 'head-research-head'
  await authorArtifact(path.join(sessionsRoot, '--root--', headId, 'session.jsonl.zstd'), { journalText: 'head', extraEvents: 0 })
  // A board room dir (no artifact at all — must not crash the scan).
  await mkdir(path.join(sessionsRoot, '--root--', 'deepartments-room-board'), { recursive: true })
  // Projcache with the host row + archived children + an unrelated row.
  const projCachePath = path.join(stateDir, 'storages', 'session_projcache.json')
  await mkdir(path.dirname(projCachePath), { recursive: true })
  const sessions = {}
  sessions[HOST_SESSION] = {
    identity: { createdAt: 1787000000000, cwd: '/root' },
    rows: { sessionStats: { ver: 1, seq: 351690, val: { turns: 184, steps: 742, llmMs: 16491685, toolMs: 7347760 } } }
  }
  for (const id of childIds) {
    sessions[id] = { identity: { createdAt: 1787000000000, cwd: '/root' }, rows: { sessionStats: { ver: 1, seq: 10, val: { turns: 1, steps: 2 } } } }
  }
  sessions['session-unrelated-kept'] = {
    identity: { createdAt: 1787000000000, cwd: '/root' },
    rows: { sessionStats: { ver: 1, seq: 5, val: { turns: 0, steps: 0 } } }
  }
  await writeFile(projCachePath, JSON.stringify({ unit: { name: 'session_projcache', version: 3 }, global: { initialized: true }, tables: { sessions } }, null, 2))
  // hosts.json with the pending flag.
  const hostsPath = path.join(stateDir, 'hosts.json')
  const hostEntry = { sessionId: HOST_SESSION, roomId: 'board', sleepEpoch: 1787261780000, boundarySeq: 323056 }
  if (pending) hostEntry.webUiCleanupPending = true
  await writeFile(hostsPath, JSON.stringify({ [HOST_ID]: hostEntry }, null, 2))
  return {
    sessionsRoot, hostArtifact, projCachePath, hostsPath, childIds, otherChild, headId,
    authored, hostDir
  }
}

/** Decode an artifact on disk back to its JSONL text. */
async function readArtifactText(artifactPath) {
  const buffer = await readFile(artifactPath)
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 4247762216) return decodeZstdArtifact(buffer)
  return buffer.toString('utf8')
}

// --- unit-level tests (pure helpers over the fixture tree) -------------------

test('cleanup: truncateSessionArtifact rewrites the log to header + setup + journal only, renumbered 0..k, preserving the journal node content byte-for-byte (modulo seq), and the result COLD-BOOTS via Session.fromRestore', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir)
    const beforeText = await readArtifactText(fixture.hostArtifact)
    const beforeEvents = parseSessionLog(beforeText).events.length
    assert.ok(beforeEvents >= 10, `fixture has several events (${beforeEvents})`)
    const journalLineBefore = parseSessionLog(beforeText).events
      .filter((ev) => ev.type === 'user/message')
      .find((ev) => /HOST-SLEEP-MEMORY/.test(ev.line))

    const result = await truncateSessionArtifact(fixture.hostArtifact)
    assert.equal(result.beforeEvents, beforeEvents)
    assert.ok(result.afterEvents < result.beforeEvents, 'events dropped')

    const afterText = await readArtifactText(fixture.hostArtifact)
    const { headerLine, events } = parseSessionLog(afterText)
    assert.ok(headerLine !== undefined && headerLine.includes(HOST_SESSION), 'header preserved')
    // Exactly the setup events + exactly one journal node; nothing else.
    const types = events.map((ev) => ev.type)
    assert.deepEqual(types, ['permission/preset', 'sandbox/mode', 'approval/policy', 'user/message'], `kept event types are setup + journal (${types.join(',')})`)
    for (let i = 0; i < events.length; i++) assert.equal(events[i].seq, i, `seq ${events[i].seq} contiguous at index ${i}`)
    // The journal node content survived byte-for-byte modulo the seq rewrite.
    assert.ok(events[3].line.includes('HOST-SLEEP-MEMORY: the cleanup fixture journal.'), 'journal text preserved')
    const parsedJournal = JSON.parse(events[3].line)
    assert.match(parsedJournal.data.content[0].text, /^---\nauthor: host-session-cleanup-host/m, 'journal frontmatter preserved')
    assert.match(parsedJournal.data.content[0].text, /\nwake_counter: 2$/m, 'journal wake_counter preserved')
    assert.deepEqual(parsedJournal.data, JSON.parse(journalLineBefore.line).data, 'journal node data byte-identical to the source node')
    assert.equal(parsedJournal.surfaceOp, 'append', 'journal node stays append-origin')

    // THE cold-boot proof: Session.fromRestore is exactly what dsh-agent-loop's
    // resume path uses (persistence.prepare → Session.prepare(seedSource) →
    // fromRestore). It must accept the truncated artifact's events.
    const header = JSON.parse(headerLine)
    const seed = events.map((ev) => JSON.parse(ev.line))
    assert.doesNotThrow(() => {
      const restored = Session.fromRestore(SessionId(HOST_SESSION), seed, {
        version: 0,
        id: HOST_SESSION,
        createdAt: header.createdAt,
        cwd: header.cwd,
        delegationDepth: header.delegationDepth
      })
      // fromRestore appends a session/end-seed marker when the seed does not
      // end in one, so the fresh session continues appending at seed.length+1.
      assert.equal(restored.seq, seed.length + 1, 'fresh session continues appending from the truncated length')
    }, 'Session.fromRestore accepts the truncated artifact (cold boot must not throw)')
  })
})

test('cleanup: planMinimalArtifact prefers the LAST append-origin journal node and ignores wake-pack / non-journal notices', async () => {
  const content = [
    JSON.stringify({ type: 'session', version: 0, id: 'x', createdAt: 1, delegationDepth: 0 }),
    JSON.stringify({ type: 'permission/preset', seq: 0, time: 1, data: {} }),
    userMessageSeq(1, '## Deepartments wake pack\npack-v1: present', 'plugin', { source: { form: 'notice' } }),
    userMessageSeq(2, `---\nauthor: host-x\nwake_counter: 1\n---\n\nfirst journal`, 'plugin', { source: { form: 'notice' } }),
    userMessageSeq(3, `---\nauthor: host-x\nwake_counter: 2\n---\n\nsecond journal`, 'plugin', { source: { form: 'notice' } })
  ].join('\n')
  const plan = planMinimalArtifact(content)
  assert.equal(plan.keptEventLines.length, 2, 'setup + exactly one journal kept')
  assert.ok(plan.keptEventLines[1].includes('second journal'), 'kept the LAST append-origin journal node, not the wake pack')
  assert.equal(plan.droppedEvents, 2, 'wake pack + first journal dropped')
})

test('cleanup: resetProjectionRows drops only the requested rows atomically', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: false })
    const removed = await resetProjectionRows(fixture.projCachePath, [HOST_SESSION, ...fixture.childIds])
    assert.equal(removed, 1 + fixture.childIds.length, 'host + children rows removed')
    const data = JSON.parse(await readFile(fixture.projCachePath, 'utf8'))
    assert.equal(data.tables.sessions[HOST_SESSION], undefined, 'host row gone')
    assert.ok(data.tables.sessions['session-unrelated-kept'] !== undefined, 'unrelated row untouched')
    assert.equal(data.unit.name, 'session_projcache', 'unit header intact')
    // Idempotent: a second pass removes nothing.
    assert.equal(await resetProjectionRows(fixture.projCachePath, [HOST_SESSION]), 0, 'second run removes nothing')
  })
})

test('cleanup: archiveAndDeleteSubagentChildren archives ONLY direct children (origin subagent + parentSession host), skips live ones, deletes the source dirs, and NEVER touches heads/rooms/other-parent dirs', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: false, childCount: 2 })
    const archiveDir = path.join(stateDir, 'archive')
    const isLive = (id) => id === fixture.childIds[1]
    const result = await archiveAndDeleteSubagentChildren(fixture.sessionsRoot, archiveDir, HOST_SESSION, { isLive })
    assert.deepEqual(result.archivedDirs, [`--root--/${fixture.childIds[0]}`], 'the NON-live direct child is archived')
    assert.deepEqual(result.skippedLive, [`--root--/${fixture.childIds[1]}`], 'the live child is skipped, not archived')
    assert.ok(result.archivePath !== undefined && result.archivePath.includes('archive'), `archive written under the state home (${result.archivePath})`)
    // Source dirs: the non-live child is gone; the live child STAYS.
    await assert.rejects(() => access(path.join(fixture.sessionsRoot, '--root--', fixture.childIds[0], 'session.jsonl.zstd')), 'non-live child artifact deleted')
    await access(path.join(fixture.sessionsRoot, '--root--', fixture.childIds[1], 'session.jsonl.zstd'))
    // Non-children untouched: other-parent child, head, room dir, host itself.
    await access(path.join(fixture.sessionsRoot, '--root--', fixture.otherChild, 'session.jsonl.zstd'))
    await access(path.join(fixture.sessionsRoot, '--root--', fixture.headId, 'session.jsonl.zstd'))
    await access(path.join(fixture.sessionsRoot, '--root--', 'deepartments-room-board'))
    await access(fixture.hostArtifact)
    // The archive itself is non-empty (tarball or fallback dir).
    const archiveEntries = await readdir(archiveDir)
    assert.ok(archiveEntries.length >= 1, `archive dir populated (${archiveEntries.join(',')})`)
  })
})

test('cleanup: runSleepCleanup end-to-end performs truncate + projcache reset + child archive; a second run is an exact no-op', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: false, childCount: 2 })
    const archiveDir = path.join(stateDir, 'archive')
    const first = await runSleepCleanup(HOST_SESSION, {
      artifactPath: fixture.hostArtifact,
      projCachePath: fixture.projCachePath,
      sessionsRoot: fixture.sessionsRoot,
      archiveDir,
      isLive: () => false
    })
    assert.equal(first.truncate.beforeEvents, fixture.authored.totalEvents, 'truncated from the full fixture')
    assert.equal(first.truncate.afterEvents, 4, 'truncated to header + setup(3) + journal(1)')
    assert.equal(first.projCacheRemoved, 1 + fixture.childIds.length, 'host + child projcache rows dropped')
    assert.equal(first.archive.archivedDirs.length, 2, 'children archived')
    // Second run: nothing left to do, no crash.
    const second = await runSleepCleanup(HOST_SESSION, {
      artifactPath: fixture.hostArtifact,
      projCachePath: fixture.projCachePath,
      sessionsRoot: fixture.sessionsRoot,
      archiveDir,
      isLive: () => false
    })
    assert.equal(second.truncate.beforeEvents, 4, 'second truncate sees the already-minimal artifact')
    assert.equal(second.truncate.afterEvents, 4)
    assert.equal(second.projCacheRemoved, 0, 'no rows left to drop')
    assert.equal(second.archive.archivedDirs.length, 0, 'no children left to archive')
  })
})

// --- crash-safe pre-truncation backup ----------------------------------------
// Owner requirement: the session log with all its data must remain saved; only
// the GUI is cleaned. So BEFORE the truncation rewrite, the ORIGINAL artifact
// is copied (byte-identical, md5+size verified) into the state-home archive as
// `session-<id>-pre-cleanup-<YYYYMMDD-HHmmss>.jsonl.zstd`. Ordering is
// backup→truncate and a FAILED backup aborts the truncation (flag kept).

test('cleanup: the first run writes a byte-identical pre-truncation backup of the ORIGINAL artifact into the archive', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: false, childCount: 1 })
    const archiveDir = path.join(stateDir, 'archive')
    // Capture the ORIGINAL full bytes BEFORE any truncation rewrites it.
    const originalBytes = await readFile(fixture.hostArtifact)

    const first = await runSleepCleanup(HOST_SESSION, {
      artifactPath: fixture.hostArtifact,
      projCachePath: fixture.projCachePath,
      sessionsRoot: fixture.sessionsRoot,
      archiveDir,
      isLive: () => false
    })

    // A NEW backup was written and reported.
    assert.equal(first.truncate.backupCreated, true, 'a new backup was written on the first (non-no-op) run')
    assert.ok(first.truncate.backupPath !== undefined, 'backup path reported')
    // The backup lives under the state-home archive dir with the expected name.
    assert.ok(first.truncate.backupPath.startsWith(archiveDir), `backup under the archive dir (${first.truncate.backupPath})`)
    assert.match(path.basename(first.truncate.backupPath), /^session-.+-pre-cleanup-\d{8}-\d{6}\.jsonl\.zstd$/, 'backup filename conventions')
    // Byte-identical to the ORIGINAL full artifact (md5 + size).
    const backupBytes = await readFile(first.truncate.backupPath)
    assert.equal(backupBytes.length, originalBytes.length, 'backup size equals original')
    assert.equal(
      createHash('md5').update(backupBytes).digest('hex'),
      createHash('md5').update(originalBytes).digest('hex'),
      'backup is byte-identical to the ORIGINAL full artifact'
    )
    // And it decodes to the SAME full event set as the pre-truncation log
    // (decoded event count matches the original), i.e. nothing was dropped.
    const backupText = await readArtifactText(first.truncate.backupPath)
    assert.equal(parseSessionLog(backupText).events.length, fixture.authored.totalEvents, 'backup decodes to the full pre-truncation event set')
    // The on-disk artifact HAS been truncated (events dropped) — but the
    // backup captured what was dropped.
    const afterBytes = await readFile(fixture.hostArtifact)
    assert.notDeepEqual(afterBytes, originalBytes, 'artifact truncated on disk')
    assert.equal(first.truncate.afterEvents, 4, 'truncated to setup(3) + journal(1)')
  })
})

test('cleanup: backup order — a FAILED backup aborts the truncation (artifact byte-unchanged, truncateError set, no truncate result)', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: false, childCount: 1 })
    // Make the archive dir path impossible to mkdir (it is a plain FILE): the
    // backup's `mkdir(recursive)` then throws → the truncation MUST abort.
    const archiveDir = path.join(stateDir, 'archive')
    await writeFile(archiveDir, 'not a directory')

    const originalBytes = await readFile(fixture.hostArtifact)
    const report = await runSleepCleanup(HOST_SESSION, {
      artifactPath: fixture.hostArtifact,
      projCachePath: fixture.projCachePath,
      sessionsRoot: fixture.sessionsRoot,
      archiveDir,
      isLive: () => false
    })

    // The truncation was ABORTED: no truncate result, an error reported, and
    // the artifact is byte-UNCHANGED (the rewrite never ran).
    assert.equal(report.truncate, undefined, 'no truncate result when the backup failed')
    assert.ok(report.truncateError !== undefined, `truncateError set (${report.truncateError})`)
    const afterBytes = await readFile(fixture.hostArtifact)
    assert.deepEqual(afterBytes, originalBytes, 'artifact byte-unchanged: never truncate without a verified backup')
    // The pending flag (invoke.ts) keys off `truncate !== undefined && no
    // truncateError` → it stays set and the NEXT boot retries. That contract
    // is expressed in invoke.ts: "flag kept for the next boot when the
    // truncate failed". This test asserts the reporting the flag logic reads.
  })
})

test('cleanup: a retry reuses an existing byte-identical backup — no duplicate is created', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: false, childCount: 1 })
    const archiveDir = path.join(stateDir, 'archive')
    await mkdir(archiveDir, { recursive: true })
    // Simulate the "partial failure" state: the artifact is STILL the full
    // original, and a pre-cleanup backup for it already exists in the archive
    // (e.g. the previous run wrote the backup but crashed before truncating).
    const originalBytes = await readFile(fixture.hostArtifact)
    const seededBackup = path.join(archiveDir, `session-${HOST_SESSION}-pre-cleanup-20260821-120000.jsonl.zstd`)
    await writeFile(seededBackup, originalBytes)

    const report = await runSleepCleanup(HOST_SESSION, {
      artifactPath: fixture.hostArtifact,
      projCachePath: fixture.projCachePath,
      sessionsRoot: fixture.sessionsRoot,
      archiveDir,
      isLive: () => false
    })

    // The existing byte-identical backup was REUSED, not duplicated.
    assert.equal(report.truncate.backupCreated, false, 'existing matching backup reused (no duplicate)')
    assert.equal(report.truncate.backupPath, seededBackup, 'reports the reused backup path')
    // And the truncation still proceeded on the full artifact.
    assert.equal(report.truncate.afterEvents, 4, 'artifact truncated to minimal')
    // Exactly ONE pre-cleanup backup remains in the archive (no second copy).
    const backups = (await readdir(archiveDir)).filter((n) => n.endsWith('.jsonl.zstd'))
    assert.deepEqual(backups, [path.basename(seededBackup)], 'exactly one (non-duplicated) backup in the archive')
  })
})

test('cleanup: no backup is created on the idempotent second run (already-minimal no-op path)', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: false, childCount: 1 })
    const archiveDir = path.join(stateDir, 'archive')
    // First run: truncates + writes one backup.
    await runSleepCleanup(HOST_SESSION, {
      artifactPath: fixture.hostArtifact,
      projCachePath: fixture.projCachePath,
      sessionsRoot: fixture.sessionsRoot,
      archiveDir,
      isLive: () => false
    })
    const backupsAfterFirst = (await readdir(archiveDir)).filter((n) => n.includes('-pre-cleanup-'))
    assert.equal(backupsAfterFirst.length, 1, 'one backup after the first run')

    // Second run: the artifact is already minimal → no-op path → NO new backup.
    const second = await runSleepCleanup(HOST_SESSION, {
      artifactPath: fixture.hostArtifact,
      projCachePath: fixture.projCachePath,
      sessionsRoot: fixture.sessionsRoot,
      archiveDir,
      isLive: () => false
    })
    assert.equal(second.truncate.backupPath, undefined, 'no backup attempted on the idempotent (minimal) second run')
    const backupsAfterSecond = (await readdir(archiveDir)).filter((n) => n.includes('-pre-cleanup-'))
    assert.deepEqual(backupsAfterSecond, backupsAfterFirst, 'no duplicate backup on the second run')
    assert.equal(second.truncate.beforeEvents, 4, 'second run sees the already-minimal artifact')
  })
})

// --- live-session guard (wake-11 mid-log-seam corruption fix) ---------------
// Root cause (explore-deep/2026-08-21-corrupt-session-log-diagnosis.md): the
// boot-time cleanup truncated the host artifact UNCONDITIONALLY, even while the
// host session was ALREADY materialized — the live session kept appending at
// its ORIGINAL seqs onto the truncated file → a mid-log seq seam the reader
// rejects. The fix: runSleepCleanup skips the ENTIRE cleanup when the host is
// live (mirroring the archive step's per-child guard) and reports it
// `skipped: true, skipReason: 'session-live'`; the invoke.ts hook then KEEPS
// the pending flag so the next boot retries.

test('cleanup: a LIVE host session skips the whole cleanup — artifact byte-identical, no children archived, no projcache reset, report skipped-live', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: false, childCount: 2 })
    const archiveDir = path.join(stateDir, 'archive')
    // Capture the FULL original bytes BEFORE the call (the live guard must not
    // write anything — no truncation, no backup, no archive, no projcache).
    const originalBytes = await readFile(fixture.hostArtifact)
    const originalCache = await readFile(fixture.projCachePath, 'utf8')

    const report = await runSleepCleanup(HOST_SESSION, {
      artifactPath: fixture.hostArtifact,
      projCachePath: fixture.projCachePath,
      sessionsRoot: fixture.sessionsRoot,
      archiveDir,
      isLive: () => true
    })

    // The report marks the skip explicitly with its machine-readable reason,
    // and every mutation slot stays untouched (undefined / 0) so the invoke.ts
    // flag gate (`shouldClearCleanupPending`) provably keeps the flag.
    assert.equal(report.skipped, true, 'report marks the cleanup as skipped')
    assert.equal(report.skipReason, 'session-live', 'skip reason is session-live')
    assert.equal(report.truncate, undefined, 'no truncate result on a live session')
    assert.equal(report.truncateError, undefined, 'skip is not an error')
    assert.equal(report.archive, undefined, 'no child archiving on a live session')
    assert.equal(report.archiveError, undefined)
    assert.equal(report.projCacheRemoved, 0, 'no projcache rows dropped')
    assert.equal(report.projCacheError, undefined)

    // Byte-identical artifact: nothing was even read-rewritten.
    const afterBytes = await readFile(fixture.hostArtifact)
    assert.deepEqual(afterBytes, originalBytes, 'artifact byte-identical (no truncation written)')
    // Children still on disk, and no archive dir was ever created.
    await access(path.join(fixture.sessionsRoot, '--root--', fixture.childIds[0], 'session.jsonl.zstd'))
    await access(path.join(fixture.sessionsRoot, '--root--', fixture.childIds[1], 'session.jsonl.zstd'))
    await assert.rejects(() => readdir(archiveDir), 'no archive directory created for a skipped cleanup')
    // Projcache untouched: host row + both child rows still projected.
    assert.equal(await readFile(fixture.projCachePath, 'utf8'), originalCache, 'projcache byte-unchanged')
    // The pending flag contract (invoke.ts keys off the skipped report):
    assert.equal(report.truncate === undefined && report.skipped === true, true, 'flag gate: skipped-live keeps the pending flag for the next boot')
  })
})

test('cleanup: truncateSessionArtifact refuses a LIVE session at the direct-call site (defensive guard) and truncates normally when not live', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: false, childCount: 1 })
    const originalBytes = await readFile(fixture.hostArtifact)
    const archiveDir = path.join(stateDir, 'archive')

    // Direct call with a live probe → REFUSED, artifact untouched.
    await assert.rejects(
      () => truncateSessionArtifact(fixture.hostArtifact, { sessionId: HOST_SESSION, isLive: () => true }),
      /session-live/,
      'the truncate step itself refuses a live session'
    )
    const afterRefusal = await readFile(fixture.hostArtifact)
    assert.deepEqual(afterRefusal, originalBytes, 'artifact byte-identical after the refusal')

    // Without a live probe / with a false probe → the pre-existing behavior is
    // unchanged (normal truncate with the crash-safe backup).
    const result = await truncateSessionArtifact(fixture.hostArtifact, {
      archiveDir,
      sessionId: HOST_SESSION,
      isLive: () => false
    })
    assert.equal(result.afterEvents, 4, 'non-live truncation proceeds exactly as before')
    assert.equal(result.backupCreated, true, 'backup written on the non-live path')
    const afterTruncate = await readFile(fixture.hostArtifact)
    assert.notDeepEqual(afterTruncate, originalBytes, 'non-live path really truncates')
  })
})

test('cleanup: shouldClearCleanupPending clears the pending flag ONLY when the cleanup ran and the truncation succeeded — skipped-live (and failed-truncate) reports keep it for the next boot', async () => {
  const ran = {
    hostSessionId: 'x',
    skipped: undefined,
    truncate: { beforeEvents: 10, afterEvents: 4, journalLine: undefined, artifactPath: '/x' },
    truncateError: undefined
  }
  const skipped = { ...ran, skipped: true, skipReason: 'session-live', truncate: undefined }
  const failedTruncate = { ...ran, truncate: undefined, truncateError: 'backup failed' }
  const noTruncate = { ...ran, truncate: undefined }

  assert.equal(shouldClearCleanupPending(ran), true, 'ran + truncate succeeded → flag cleared (one cleanup per sleep cycle)')
  assert.equal(shouldClearCleanupPending(skipped), false, 'skipped-live → flag KEPT (the next boot retries when the session is not materialized)')
  assert.equal(shouldClearCleanupPending(failedTruncate), false, 'failed truncate → flag KEPT (idempotent retry)')
  assert.equal(shouldClearCleanupPending(noTruncate), false, 'no truncate result → flag KEPT')
  // Belt and suspenders: even a skipped report that somehow still carried a
  // truncate result must NOT clear — the skip dominates.
  assert.equal(shouldClearCleanupPending({ ...skipped, truncate: ran.truncate }), false, 'a skipped report never clears the flag')
})

test('cleanup: TOCTOU re-check — runSleepCleanup skips safely (nothing mutated, flag kept) when the host session becomes live AFTER the entry guard but BEFORE the truncate', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: false, childCount: 1 })
    const originalArtifact = await readFile(fixture.hostArtifact)
    const originalCache = await readFile(fixture.projCachePath, 'utf8')
    const archiveDir = path.join(stateDir, 'archive')
    // Simulate the race (wake-12's smart-restart resume): the probe reports
    // NOT live at the entry guard (call #1) but LIVE at the immediate
    // pre-truncate re-check (call #2) — the session was materialized (e.g. via
    // the agent registry) while the boot awaited its file reads.
    let calls = 0
    const isLive = () => { calls += 1; return calls >= 2 }
    const report = await runSleepCleanup(HOST_SESSION, {
      artifactPath: fixture.hostArtifact,
      projCachePath: fixture.projCachePath,
      sessionsRoot: fixture.sessionsRoot,
      archiveDir,
      isLive,
      log: { warn: () => {} }
    })
    assert.equal(calls, 2, 'liveness re-probed immediately before the truncate')
    assert.equal(report.skipped, true, 'mid-cleanup liveness skips the whole cleanup')
    assert.equal(report.skipReason, 'session-live', 'skip reason is session-live')
    assert.equal(report.truncate, undefined, 'no truncate result')
    assert.equal(report.truncateError, undefined, 'no truncate error (skipped, not failed)')
    assert.equal(report.projCacheRemoved, 0, 'no projcache mutation')
    assert.equal(report.archive, undefined, 'no child archiving (the whole cleanup is skipped)')
    assert.equal(shouldClearCleanupPending(report), false, 'flag gate: skipped-live keeps the pending flag for the next boot')
    assert.deepEqual(await readFile(fixture.hostArtifact), originalArtifact, 'artifact byte-identical (the truncate was never attempted on the live session)')
    assert.equal(await readFile(fixture.projCachePath, 'utf8'), originalCache, 'projcache byte-unchanged')
    await assert.rejects(() => readdir(archiveDir), 'no archive dir created')
  })
})

// --- real-Loader integration tests -------------------------------------------

/** Stub agents service holding sessions WITHOUT registering them in the dsh
 * sessions store — the smart-restart resume shape (dsh-smart-restart delivers
 * its boot notice via `agent.followup(...)` on a session attached to the AGENT
 * REGISTRY only; the sessions-store map gains it later). The boot cleanup's
 * `isLive` (invoke.ts) must count a registry-held session as LIVE, or the
 * truncate would open a mid-log seq seam (the wake-11 corruption class —
 * explore-deep/2026-08-21-first-turn-api-orphan.md §1.2). */
class StubAgentsRegistryOnly extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
  }

  get(id) {
    return this.store.get(id)
  }

  list() {
    return [...this.store.values()]
  }

  roots() {
    return [...this.store.values()]
  }
}

/** Stub persistence carrying a root (so the boot cleanup can resolve the
 * sessions root + the derived state-home paths, like the real jsonl
 * backend's public `root`). */
class StubPersistenceWithRoot extends Service {
  constructor(ctx, root) {
    super(ctx, 'sessionPersistence')
    this.root = root
  }

  async readRaw(id) {
    const artifactPath = await findSessionArtifact(this.root, String(id))
    if (artifactPath === undefined) return undefined
    return { meta: { id }, filename: 'session.jsonl', content: await readArtifactText(artifactPath) }
  }
}

/** Boot the REAL Loader + the bundle with a stub agents/persistence
 * (mirroring test/invoke.test.js's bootPlugin shape). */
async function bootPlugin(stateDir, { persistenceRoot } = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  await root.plugin(SubagentRuntime)
  await root.plugin(StubPersistenceWithRoot, persistenceRoot)
  loader.create({
    id: 'deepartments',
    name: '../lib/index.js',
    config: { stateDir, org: TEST_ORG }
  })
  await loader.await()
  return { root, dispose: () => loaderFiber.dispose() }
}

test('Real Loader: the FIRST boot with webUiCleanupPending performs the web-UI cleanup exactly once (artifact truncated, projcache row gone, children archived+deleted, flag cleared) and a later boot is a no-op', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: true, childCount: 2 })
    const boot1 = await bootPlugin(stateDir, { persistenceRoot: fixture.sessionsRoot })
    try {
      // The boot cleanup runs after hosts.json loads; observe the flag clearing.
      await waitFor(async () => {
        const hosts = JSON.parse(await readFile(fixture.hostsPath, 'utf8'))
        return hosts[HOST_ID]?.webUiCleanupPending !== true
      }, 5000, 'boot cleanup cleared the pending flag')
      // Artifact truncated on disk.
      const text = await readArtifactText(fixture.hostArtifact)
      const events = parseSessionLog(text).events
      assert.deepEqual(events.map((e) => e.type), ['permission/preset', 'sandbox/mode', 'approval/policy', 'user/message'])
      assert.ok(events[3].line.includes('HOST-SLEEP-MEMORY: the cleanup fixture journal.'), 'journal preserved by the boot cleanup')
      // Projcache rows gone.
      const cache = JSON.parse(await readFile(fixture.projCachePath, 'utf8'))
      assert.equal(cache.tables.sessions[HOST_SESSION], undefined, 'host projcache row dropped')
      assert.equal(cache.tables.sessions['session-unrelated-kept'] !== undefined, true, 'unrelated row kept')
      // Children archived + deleted (live-less boot: both gone).
      for (const id of fixture.childIds) {
        await assert.rejects(() => access(path.join(fixture.sessionsRoot, '--root--', id, 'session.jsonl.zstd')), `child ${id} deleted`)
      }
      await access(path.join(fixture.sessionsRoot, '--root--', fixture.otherChild, 'session.jsonl.zstd'))
      await access(path.join(fixture.sessionsRoot, '--root--', fixture.headId, 'session.jsonl.zstd'))
    } finally {
      await boot1.dispose()
    }
    // A SECOND boot into the same tree: the flag is cleared → exact no-op;
    // the artifact stays minimal (one journal node, same bytes).
    const beforeText = await readArtifactText(fixture.hostArtifact)
    const boot2 = await bootPlugin(stateDir, { persistenceRoot: fixture.sessionsRoot })
    try {
      await new Promise((resolve) => setTimeout(resolve, 400))
    } finally {
      await boot2.dispose()
    }
    const afterText = await readArtifactText(fixture.hostArtifact)
    assert.equal(afterText, beforeText, 'artifact unchanged by the second boot')
  })
})

test('Real Loader: the boot web-UI cleanup SKIPS when the host session is held by the AGENT REGISTRY only (smart-restart resume shape) — artifact byte-identical, no backup, flag kept; the same fixture without the registry guest truncates + clears (positive control)', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: true, childCount: 1 })
    const boot1 = await bootPlugin(stateDir, { persistenceRoot: fixture.sessionsRoot })
    try {
      // Simulate the smart-restart resume BEFORE the boot cleanup's liveness
      // probe runs: attach the host session to the AGENT REGISTRY only (the
      // dsh sessions store never sees it in this boot — isLive must count it
      // via ctx.get('agents')). The probe sits behind a file-read await in the
      // cleanup hook, so registering right after the boot is deterministically
      // earlier.
      const agentsSvc = new StubAgentsRegistryOnly(boot1.root)
      agentsSvc.store.set(HOST_SESSION, { id: HOST_SESSION, status: 'idle' })
      const originalBytes = await readFile(fixture.hostArtifact)
      // Let the boot cleanup hook evaluate the registry (house pattern: the
      // second-boot no-op test settles with a fixed wait).
      await new Promise((resolve) => setTimeout(resolve, 500))
      assert.deepEqual(await readFile(fixture.hostArtifact), originalBytes, 'artifact byte-identical (no truncation on the registry-live session)')
      const hosts1 = JSON.parse(await readFile(fixture.hostsPath, 'utf8'))
      assert.equal(hosts1[HOST_ID]?.webUiCleanupPending, true, 'pending flag KEPT (cleanup skipped — retried at a boot where the session is verifiably not materialized)')
      // No backup written (a truncation would have archived the original under
      // the state-home archive dir first).
      await assert.rejects(() => readdir(path.join(stateDir, 'archive')), 'no archive dir created (no truncation happened)')
    } finally {
      await boot1.dispose()
    }
    // Positive control: the SAME fixture booted WITHOUT the registry guest
    // truncates the artifact and clears the flag — proves the guard, not the
    // fixture, caused the boot-1 skip.
    const boot2 = await bootPlugin(stateDir, { persistenceRoot: fixture.sessionsRoot })
    try {
      await waitFor(async () => {
        const hosts = JSON.parse(await readFile(fixture.hostsPath, 'utf8'))
        return hosts[HOST_ID]?.webUiCleanupPending !== true
      }, 5000, 'positive control: the cleanup cleared the flag')
    } finally {
      await boot2.dispose()
    }
    const afterEvents = parseSessionLog(await readArtifactText(fixture.hostArtifact)).events
    assert.deepEqual(afterEvents.map((e) => e.type), ['permission/preset', 'sandbox/mode', 'approval/policy', 'user/message'], 'positive control really truncated (setup + journal only)')
    await access(path.join(stateDir, 'archive'))
  })
})

test('Real Loader: host dept_sleep LEGACY-FALLBACK path still completes (journal capture, wake bump, sleepEpoch) and sets the webUiCleanupPending marker durably — the physical truncation is NOT attempted inside the live process', async () => {
  await withTempStateDir(async (stateDir) => {
    const fixture = await buildFixtureTree(stateDir, { pending: false, childCount: 1 })
    const { root, dispose } = await bootPlugin(stateDir, { persistenceRoot: fixture.sessionsRoot })
    try {
      // U2 (spec 002): the host dept_sleep ROTATES by default (old retired +
      // new seeded session — webUiCleanupPending is NEVER set on a rotated
      // host, S4). This test proves the LEGACY cleanup machinery, so it forces
      // the legacy fallback: the rotation cannot run when the sessions store
      // rejects the create call (§3.6), and the fallback still sets the
      // durable cleanup marker.
      root.sessions.create = () => { throw new Error('injected — legacy fallback for the cleanup-marker test') }
      const { Session: DshSession, SessionId: Sid } = await import('@deepseek-ai/dsh-session')
      // Seed the host journal (as dept_memo_write would have) so dept_sleep
      // passes its require-a-journal gate.
      const hostId = HOST_ID
      const hostSessionId = HOST_SESSION
      const journalPath = path.join(stateDir, 'journals', `${hostId}.md`)
      await mkdir(path.dirname(journalPath), { recursive: true })
      await writeFile(journalPath, [
        '---',
        `author: ${hostId}`,
        `timestamp: ${new Date().toISOString()}`,
        'wake_counter: 1',
        'board_cursor: none',
        'decisions: []',
        'constraints: []',
        'open_items: []',
        '---',
        '',
        'HOST-SLEEP-CYCLE: marker test.',
        ''
      ].join('\n'), 'utf8')

      // A real dsh Session (detached, not registered) so the host branch's
      // surface append + the deferred-sleep intent run. Session.create is the
      // static `(id, seed, header)` signature (dsh-session rc.2).
      const realSession = DshSession.create(Sid(hostSessionId),
        [{ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } }],
        { version: 0, id: hostSessionId, createdAt: 1787000000000, cwd: '/root', delegationDepth: 0 })
      const host = {
        id: hostSessionId,
        options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        status: 'idle',
        session: realSession,
        followup() {}, steer() {}, inject() {}, send() {}, cancel() {},
        whenIdle() { return new Promise(() => {}) }
      }
      const signal = new AbortController().signal
      let concluded = false
      const sleepTool = root.tools.get('dept_sleep')
      const result = await sleepTool.execute({}, { agent: host, signal, concludeTurn: () => { concluded = true } })
      assert.equal(result.member, hostId)
      assert.equal(concluded, true, 'sleep concluded the turn')
      // The capture still ran (bumped ordinal session log name) and the
      // DURABLE marker is set in hosts.json (fire-and-forget → waitFor).
      await access(path.join(stateDir, 'journals', 'sessions', `${hostId}-2.md`))
      await waitFor(async () => {
        const hosts = JSON.parse(await readFile(fixture.hostsPath, 'utf8'))
        return hosts[hostId]?.webUiCleanupPending === true
      }, 5000, 'webUiCleanupPending marker persisted at sleep')
      assert.equal(typeof (JSON.parse(await readFile(fixture.hostsPath, 'utf8'))[hostId]).sleepEpoch, 'number', 'sleepEpoch persisted')
      // THE SAFETY PROPERTY: the live artifact is NOT truncated by the sleep
      // (the harness still appends after the tool returns; the truncation only
      // runs at the next boot — see src/session-cleanup.ts).
      const text = await readArtifactText(fixture.hostArtifact)
      assert.ok(parseSessionLog(text).events.length >= 10, 'artifact untouched by dept_sleep itself (lifecycle is boot-side)')
    } finally {
      await dispose()
    }
  })
})