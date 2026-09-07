// dsh-deepartments — O6 (VALLE 09-07): the ROTATION BASELINE assertion suite.
//
// Automates the D-Q3 hygiene invariants the Quality Department checks BY HAND
// in every host-rotation inspection (retained == archive + N / no turn post-
// sleep / write-ahead memo < sleep). Design contract:
// reports/explore-deep/2026-09-07-o6-rotation-baseline-design-7c8d90c1.md.
//
// Blocks (design §4.2):
//   A — PURE fixtures (ZERO fs — injected readers): I1a/b/c (good deltas 0/3/4,
//       bad +66/151 → exact `post-rotation-turn`), I2a-d, I3a-d, I4a-d, I5a-c,
//       I6a-c (with ONE ALTO-1/m-728 guard row to verify the exclusion),
//       missing-artifact, artifact-too-large, the inline logger warn, and the
//       boundarySeq semantics (== the seq of the dept_sleep tool/RESULT).
//   B — INTEGRATION T1: the REAL Loader + the REAL dept_sleep → sleepHost →
//       runHostRotation on a temp stateDir (rule no-live spec 002 §8: the real
//       rotation runs ONLY here, NEVER on the DEV live); waits for the
//       dispose/finalize settle (the m-423 snapshot-anchor, pattern
//       p2-snapshot-anchor); then verifyRotationBaseline → {ok:true}. AA: the
//       chain rotada 2 VECES — the 2nd assertion uses the 2nd pair's ids (no
//       contamination), and the 1st pair still verifies.
//   C — INTEGRATION T2: dept_head_rotate vía el tool real hermético (pattern
//       invoke.test.js:21792) with the REDUCED 'head' mode (no hosts.json, no
//       re-key, no snapshot, BOOT-QUIET).
//   D — DISCRIMINADOR T4: restart (same ids → skip; marker.json lastBootAt sin
//       retiredAt → skip) + the artifact solo CRECE contiguo (no false positive).
//
// Rule 5 (AGENTS.md): tests go through the REAL Cordis Loader with the REAL
// dsh services and stub subagent providers / stub agents / stub persistence /
// stub workspace-registry — the same hermetic harness shape as
// test/rotate-wake.test.js (self-contained copy). Temp stateDirs, no network,
// no live DSH_HOME, no LLM. Tests run against the compiled lib (pnpm build).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { loadMessageRecords, parseDeliveryRows, resolveDeliveriesPath, resolveMessagesPath, deliveryStatus } from '../lib/messages-store.js'
import { encodeSegment } from '../lib/session-cleanup.js'
import {
  verifyRotationBaseline,
  ACCEPTED_SNAPSHOT_DELTAS,
  HARD_ZOMBIE_DELTA,
  DEFAULT_SETTLE_WINDOW_MS
} from '../lib/rotation-baseline.js'
import { TOOLSET_AUDIT_FLAG_ENV } from '../lib/toolset-audit.js'

// M2.3: the hermetic suite runs with the toolset-audit channel DISABLED (same
// as invoke.test.js / rotate-wake.test.js).
process.env[TOOLSET_AUDIT_FLAG_ENV] = '0'

// The QD org (research + quality heads) so the host-rotation QUALITY INSPECT
// directive has quality-head to be addressed to (the 100% mandate, no dice).
const QD_ORG = {
  departments: [
    {
      id: 'research',
      name: 'Research',
      coordinator: {
        postId: 'research-head',
        role: 'Research department head',
        provider: 'deepseek-official',
        agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' }
      }
    },
    {
      id: 'quality',
      name: 'Quality',
      coordinator: {
        postId: 'quality-head',
        role: 'Quality department head',
        provider: 'deepseek-official',
        agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' }
      }
    }
  ]
}

// ===========================================================================
// Block A — pure fixture machinery (ZERO fs: injected file/artifact maps).
// ===========================================================================

const T0 = 1787000000000

/** One event object in the persisted artifact envelope ({type, seq, time, data}). */
function ev(type, seq, time, data = {}) {
  return { type, seq, time, data }
}

function headerLine(id) {
  return JSON.stringify({ type: 'session', id, version: 0 })
}

/** Serialize events (+ the header first line) into artifact text. */
function artifactText(id, events) {
  return [headerLine(id), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n'
}

/** The pre-sleep host journal shape (as dept_memo_write + the S1.5 bump leave it). */
function hostJournal(author, wakeCounter, summary = 'ROTATION-BASELINE-MEMORY: carried forward.') {
  return [
    '---',
    `author: ${author}`,
    'timestamp: 2026-09-07T10:00:00.000Z',
    `wake_counter: ${wakeCounter}`,
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

/** The canonical healthy OLD host artifact events. The dept_sleep tool/result
 * lands at seq 9 — the FIXED I5c semantics (boundarySeq == tool/result seq). */
function healthyOldEvents(now = T0) {
  const turn = 1
  return [
    ev('permission/preset', 0, now + 0, { preset: 'danger-full-access' }),
    ev('sandbox/mode', 1, now + 1, { mode: 'danger-full-access' }),
    ev('approval/policy', 2, now + 2, { policy: 'never' }),
    ev('user/message', 3, now + 3, { role: 'user', content: [{ type: 'text', text: 'prior context' }], source: { kind: 'user' } }),
    ev('turn/start', 4, now + 4, { turn }),
    ev('user/message', 5, now + 5, { role: 'user', content: [{ type: 'text', text: 'turn input' }], source: { kind: 'user' } }),
    ev('tool/call', 6, now + 6, { turn, step: 1, callId: 'c-memo-1', name: 'dept_memo_write', arguments: '{}' }),
    ev('tool/result', 7, now + 7, { turn, step: 1, callId: 'c-memo-1', message: { role: 'user', content: [{ type: 'tool-result', text: 'memo written' }], isError: false, source: { kind: 'tool', callId: 'c-memo-1' } } }),
    ev('tool/call', 8, now + 8, { turn, step: 1, callId: 'c-sleep-1', name: 'dept_sleep', arguments: '{}' }),
    ev('tool/result', 9, now + 9, { turn, step: 1, callId: 'c-sleep-1', message: { role: 'user', content: [{ type: 'tool-result', text: 'sleeping: host-session-new (rotation complete)' }], isError: false, source: { kind: 'tool', callId: 'c-sleep-1' } } }),
    ev('turn/end', 10, now + 10, { turn, reason: { kind: 'completed' } })
  ]
}

/** The canonical healthy NEW host artifact events: the balanced 5-event seed +
 * exactly one end-seed + exactly ONE handoff notice + a first turn AFTER the
 * handoff. With opts.parked the successor stays BOOT-QUIET (seed + end-seed). */
function healthyNewEvents(journalText, now, handoffTs, opts = {}) {
  const events = [
    ev('permission/preset', 0, now + 0, { preset: 'danger-full-access' }),
    ev('sandbox/mode', 1, now + 1, { mode: 'danger-full-access' }),
    ev('approval/policy', 2, now + 2, { policy: 'never' }),
    ev('user/message', 3, now + 3, { role: 'user', content: [{ type: 'text', text: journalText }], source: { kind: 'plugin', plugin: 'deepartments', form: 'notice' } }),
    ev('session/title', 4, now + 4, { title: 'Asistente', messageSeqs: [], source: { kind: 'user' } }),
    ev('session/end-seed', 5, now + 5, {}),
    ev('user/message', 6, now + 6, { role: 'user', content: [{ type: 'text', text: '[From deepartments → host-session-new]: host session rotation complete (spec 002) — this is the rotation\'s OWN successor handoff.' }], source: { kind: 'system' } })
  ]
  if (opts.parked !== true) {
    events.push(
      ev('turn/start', 7, handoffTs + 1, { turn: 1 }),
      ev('user/message', 8, handoffTs + 2, { role: 'user', content: [{ type: 'text', text: 'wake input' }], source: { kind: 'user' } }),
      ev('turn/end', 9, handoffTs + 3, { turn: 1, reason: { kind: 'completed' } })
    )
  }
  return events
}

/** hosts.json fixture for one healthy rotation. */
function hostsFixture(oldHostId, oldSessionId, newHostId, newSessionId, opts = {}) {
  const retiredAt = opts.retiredAt ?? T0 + 1000
  return {
    schemaVersion: 2,
    [oldHostId]: {
      sessionId: oldSessionId,
      roomId: 'board',
      sleepEpoch: retiredAt - 2000,
      boundarySeq: 40,
      retired: true,
      retiredAt,
      rotatedTo: newHostId,
      ...(opts.oldOverrides ?? {})
    },
    [newHostId]: {
      sessionId: newSessionId,
      roomId: 'board',
      sleepEpoch: retiredAt,
      boundarySeq: opts.boundarySeq ?? 9,
      previousSessionId: oldSessionId,
      ...(opts.newOverrides ?? {})
    }
  }
}

function messagesText(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

function deliveriesText(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

/** The rotation-wake handoff record (the real enqueueHostWake frame). */
function handoffRecord(newHostId, ts) {
  return {
    id: 'm-handoff',
    seq: 0,
    ts,
    from: 'deepartments',
    to: [newHostId],
    text: '[deepartments] host session rotation complete (spec 002): session session-new is now the registered host; this is the rotation\'s OWN successor handoff — no external traffic.',
    kind: 'notice'
  }
}

/** The archive stamp (YYYYMMDD-HHmmss, local components — the formatBackupStamp
 * convention of session-rotation.ts) for an epoch. */
function stampOf(epoch) {
  const d = new Date(epoch)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function snapName(oldSessionId, stamp) {
  return `session-${oldSessionId}-pre-rotation-${stamp}.jsonl.zstd`
}

function codesOf(result) {
  return result.violations.map((v) => v.code)
}

/** Build the pure-fixture deps: files is a Map<absolute-pseudo-path, text>;
 * artifactMap resolves session id → artifact pseudo-path. NO fs touched. */
function pureDeps({ files, artifactMap, snapPath, oldId = 'session-old', newId = 'session-new', oldHost = 'host-session-old', newHost = 'host-session-new', mode = 'host', hosts, hjOld, hjNew, records, rows, marker, maxArtifactLines, logger }) {
  if (hosts !== undefined) files.set('/f/hosts.json', JSON.stringify(hosts, null, 2))
  if (hjOld !== undefined) files.set('/f/journals/old.md', hjOld)
  if (hjNew !== undefined) files.set('/f/journals/new.md', hjNew)
  if (records !== undefined) files.set('/f/messages.jsonl', messagesText(records))
  if (rows !== undefined) files.set('/f/deliveries.jsonl', deliveriesText(rows))
  if (marker !== undefined) files.set('/f/marker.json', JSON.stringify(marker))
  const deps = {
    mode,
    stateDir: '/f',
    sessionsRoot: '/f/sessions',
    archiveDir: '/f/archive',
    oldSessionId: oldId,
    newSessionId: newId,
    hostIdOld: oldHost,
    hostIdNew: newHost,
    decodeArtifact: async (p) => {
      const content = files.get(p)
      return content === undefined
        ? { lines: [], byteOk: false }
        : { lines: content.split('\n'), byteOk: true }
    },
    readFileText: async (p) => files.get(p),
    findArtifact: async (_root, id) => artifactMap.get(id),
    snapshotPath: snapPath,
    settleWindowMs: DEFAULT_SETTLE_WINDOW_MS,
    ...(marker !== undefined ? { markerPath: '/f/marker.json' } : {}),
    ...(maxArtifactLines !== undefined ? { maxArtifactLines } : {}),
    ...(logger !== undefined ? { logger } : {})
  }
  return deps
}

/** A complete healthy host-mode fixture (the base for most Block A tests).
 * `delta` selects the SNAP cut: 0 = finalized (SNAP == OLD), 3/4 = pre-finalize. */
function healthyHostFixture(delta = 0, opts = {}) {
  assert.ok(ACCEPTED_SNAPSHOT_DELTAS.includes(delta), 'delta must be one of {0,3,4}')
  const oldId = opts.oldId ?? 'session-old'
  const newId = opts.newId ?? 'session-new'
  const oldHost = `host-${oldId}`
  const newHost = `host-${newId}`
  const retiredAt = T0 + 1000
  const hjOld = hostJournal(oldHost, 2)
  const hjNew = hjOld.replace(/^author: .*$/m, `author: ${newHost}`)
  const oldEvents = opts.oldEvents ?? healthyOldEvents(T0)
  const oldText = artifactText(oldId, oldEvents)
  const oldLines = oldText.split('\n').filter((l) => l !== '') // drop the trailing empty element
  const snapTexts = {
    0: oldText,
    3: oldLines.slice(0, oldLines.length - 3).join('\n') + '\n',
    4: oldLines.slice(0, oldLines.length - 4).join('\n') + '\n'
  }
  const snapText = snapTexts[delta]
  const snapPath = `/f/archive/${snapName(oldId, stampOf(retiredAt))}`
  const newText = artifactText(newId, healthyNewEvents(hjNew, T0 + 2000, retiredAt, opts))
  const files = new Map()
  files.set(snapPath, snapText)
  files.set('/f/sessions/old.jsonl', oldText)
  files.set('/f/sessions/new.jsonl', newText)
  // Journals under the module's DERIVED names (stateDir/journals/<memberId>.md).
  files.set(path.join('/f/journals', `${oldHost}.md`), hjOld)
  files.set(path.join('/f/journals', `${newHost}.md`), hjNew)
  const records = opts.records ?? [handoffRecord(newHost, retiredAt)]
  const rows = opts.rows ?? [
    { messageId: 'm-boot', recipientId: oldHost, status: 'prepared', ts: retiredAt - 500 },
    { messageId: 'm-boot', recipientId: oldHost, status: 'terminal', ts: retiredAt + 100 }
  ]
  const deps = pureDeps({
    files,
    artifactMap: new Map([
      [oldId, '/f/sessions/old.jsonl'],
      [newId, '/f/sessions/new.jsonl']
    ]),
    oldId,
    newId,
    oldHost,
    newHost,
    hosts: hostsFixture(oldHost, oldId, newHost, newId, {
      retiredAt,
      boundarySeq: opts.boundarySeq,
      oldOverrides: opts.oldOverrides,
      newOverrides: opts.newOverrides
    }),
    hjOld,
    hjNew,
    records,
    rows,
    snapPath,
    ...(opts.maxArtifactLines !== undefined ? { maxArtifactLines: opts.maxArtifactLines } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {})
  })
  return { deps, files, oldText, newText, snapPath, oldId, newId, oldHost, newHost, hjOld, hjNew, retiredAt }
}

// ===========================================================================
// Block A — pure fixtures.
// ===========================================================================

test('A-I1: healthy retained==archive — deltas 0/3/4 with SNAP as prefix of OLD → ok:true (the m-423 finalize {0} and the pre-finalize {3,4} tolerances)', async () => {
  for (const delta of [0, 3, 4]) {
    const { deps } = healthyHostFixture(delta)
    const result = await verifyRotationBaseline(deps)
    assert.deepEqual(result.violations, [], `delta ${delta}: no violations`)
    assert.equal(result.ok, true, `delta ${delta}: ok`)
    assert.equal(result.skipped, undefined)
  }
})

test('A-I1c: the +66 zombie fixture (live = archive + 66 lines, orphan turn after the sleep turn) → EXACT `post-rotation-turn` (the LOCK — m-437/m-438 class)', async () => {
  const zombie = [
    ev('turn/start', 11, T0 + 11, { turn: 2 }),
    ...Array.from({ length: 63 }, (_, i) => ev('user/message', 12 + i, T0 + 12 + i, { role: 'user', content: [{ type: 'text', text: `zombie-${i}` }], source: { kind: 'user' } })),
    ev('turn/end', 75, T0 + 75, { turn: 2, reason: { kind: 'completed' } })
  ]
  const fixture = healthyHostFixture(0)
  const oldText = artifactText('session-old', [...healthyOldEvents(T0), ...zombie])
  const snapText = artifactText('session-old', healthyOldEvents(T0)) // the healthy 12-line prefix
  const result = await verifyRotationBaseline({
    ...fixture.deps,
    decodeArtifact: async (p) => {
      if (p === '/f/sessions/old.jsonl') return { lines: oldText.split('\n'), byteOk: true }
      if (p === fixture.snapPath) return { lines: snapText.split('\n'), byteOk: true }
      return fixture.deps.decodeArtifact(p)
    }
  })
  const lines = oldText.split('\n').length - snapText.split('\n').length
  assert.ok(lines >= HARD_ZOMBIE_DELTA, `fixture delta ${lines} must be >= ${HARD_ZOMBIE_DELTA}`)
  const codes = codesOf(result)
  assert.ok(codes.includes('post-rotation-turn'), `expected post-rotation-turn, got ${JSON.stringify(codes)}`)
  assert.equal(result.ok, false)
})

test('A-I1c: the turn-151 fixture (a turn/start at seq 151 AFTER the dept_sleep turn close, delta stays in tolerance) → EXACT `post-rotation-turn` via the ORDER rule (zombie lock)', async () => {
  const oldEvents = [...healthyOldEvents(T0), ev('turn/start', 151, T0 + 151, { turn: 7 })]
  const { deps } = healthyHostFixture(4, { oldEvents })
  const result = await verifyRotationBaseline(deps)
  const codes = codesOf(result)
  assert.ok(codes.includes('post-rotation-turn'), `expected post-rotation-turn, got ${JSON.stringify(codes)}`)
  assert.ok(!codes.includes('snapshot-delta'), 'the delta stays in tolerance — this is the ORDER rule, not the delta rule')
})

test('A-I2a: the OLD artifact must end inside a closed turn — a trailing assistant/message → `final-event`; a duplicated turn/start → `post-rotation-turn`', async () => {
  const trailing = healthyOldEvents(T0).slice(0, -1)
  trailing.push(ev('assistant/message', 11, T0 + 11, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'orphan' }] } }))
  const t1 = await verifyRotationBaseline(healthyHostFixture(0, { oldEvents: trailing }).deps)
  assert.ok(codesOf(t1).includes('final-event'), `expected final-event, got ${JSON.stringify(codesOf(t1))}`)

  const dup = healthyOldEvents(T0)
  dup.push(ev('turn/start', 11, T0 + 11, { turn: 2 }))
  dup.push(ev('turn/start', 12, T0 + 12, { turn: 2 }))
  const t2 = await verifyRotationBaseline(healthyHostFixture(0, { oldEvents: dup }).deps)
  assert.ok(codesOf(t2).includes('post-rotation-turn'), `expected post-rotation-turn for the duplicated turn/start, got ${JSON.stringify(codesOf(t2))}`)
})

test('A-I2b: a dept_sleep call WITHOUT its immediate clean result → `sleep-tool-shape` (the tool/result must follow directly, isError:false)', async () => {
  const broken = healthyOldEvents(T0).filter((e) => !(e.type === 'tool/result' && e.data.callId === 'c-sleep-1'))
  const r1 = await verifyRotationBaseline(healthyHostFixture(0, { oldEvents: broken }).deps)
  assert.ok(codesOf(r1).includes('sleep-tool-shape'), `expected sleep-tool-shape, got ${JSON.stringify(codesOf(r1))}`)

  const errored = healthyOldEvents(T0)
  const idx = errored.findIndex((e) => e.type === 'tool/result' && e.data.callId === 'c-sleep-1')
  errored[idx] = { ...errored[idx], data: { ...errored[idx].data, error: { name: 'Error', code: 'SLEEP_REFUSED' } } }
  const r2 = await verifyRotationBaseline(healthyHostFixture(0, { oldEvents: errored }).deps)
  assert.ok(codesOf(r2).includes('sleep-tool-shape'), `expected sleep-tool-shape for the errored result, got ${JSON.stringify(codesOf(r2))}`)
})

test('A-I2c: NEW pre-turn block — a non-seed event in the block → `seed-unbalanced`; a second turn/start after the first turn/end → `orphan-turn-start`', async () => {
  const fixture = healthyHostFixture(0)

  // Foreign event inside the pre-turn block (a contiguous seq-5 non-seed event —
  // the parser sorts by seq, so an out-of-band seq would land after the turn).
  const foreignResult = await verifyRotationBaseline({
    ...fixture.deps,
    decodeArtifact: async (p) => {
      if (p === '/f/sessions/new.jsonl') {
        const parsed = fixture.newText.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
        parsed.splice(5, 0, ev('request/header', 5, T0 + 2999, { reason: 'change', header: {} }))
        for (let i = 5; i < parsed.length; i++) parsed[i].seq = i
        return { lines: parsed.map((e) => JSON.stringify(e)), byteOk: true }
      }
      return fixture.deps.decodeArtifact(p)
    }
  })
  assert.ok(codesOf(foreignResult).includes('seed-unbalanced'), `expected seed-unbalanced, got ${JSON.stringify(codesOf(foreignResult))}`)

  // Orphan: a second turn/start after the first turn/end.
  const parsed = fixture.newText.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
  parsed.push(ev('turn/start', 10, T0 + 3000, { turn: 2 }))
  const orphanResult = await verifyRotationBaseline({
    ...fixture.deps,
    decodeArtifact: async (p) => {
      if (p === '/f/sessions/new.jsonl') return { lines: parsed.map((e) => JSON.stringify(e)), byteOk: true }
      return fixture.deps.decodeArtifact(p)
    }
  })
  assert.ok(codesOf(orphanResult).includes('orphan-turn-start'), `expected orphan-turn-start, got ${JSON.stringify(codesOf(orphanResult))}`)
})

test('A-I2d: NEW replays an OLD event (identical type/time/data — the old queue leaked into the successor) → `seq-replay`', async () => {
  const fixture = healthyHostFixture(0)
  const oldEvents = healthyOldEvents(T0)
  const replayed = [
    ...healthyNewEvents(fixture.hjNew, T0 + 2000, T0 + 1000).slice(0, 5),
    ev('user/message', 5, T0 + 5, oldEvents[5].data), // the OLD turn-1 input copied verbatim
    ev('session/end-seed', 6, T0 + 5, {}),
    ev('turn/start', 7, T0 + 1001, { turn: 1 }),
    ev('turn/end', 8, T0 + 1002, { turn: 1, reason: { kind: 'completed' } })
  ]
  const result = await verifyRotationBaseline({
    ...fixture.deps,
    decodeArtifact: async (p) => {
      if (p === '/f/sessions/new.jsonl') return { lines: replayed.map((e) => JSON.stringify(e)), byteOk: true }
      return fixture.deps.decodeArtifact(p)
    }
  })
  assert.ok(codesOf(result).includes('seq-replay'), `expected seq-replay, got ${JSON.stringify(codesOf(result))}`)
})

test('A-I3a: write-ahead — a dept_memo_write tool/result AFTER the dept_sleep tool/call → `memo-after-sleep`', async () => {
  const clean = [
    ev('permission/preset', 0, T0, { preset: 'x' }),
    ev('sandbox/mode', 1, T0 + 1, { mode: 'x' }),
    ev('approval/policy', 2, T0 + 2, { policy: 'x' }),
    ev('user/message', 3, T0 + 3, { role: 'user', content: [{ type: 'text', text: 'prior' }], source: { kind: 'user' } }),
    ev('turn/start', 4, T0 + 4, { turn: 1 }),
    ev('user/message', 5, T0 + 5, { role: 'user', content: [{ type: 'text', text: 'in' }], source: { kind: 'user' } }),
    ev('tool/call', 6, T0 + 6, { turn: 1, step: 1, callId: 'c-sleep-1', name: 'dept_sleep', arguments: '{}' }),
    ev('tool/result', 7, T0 + 7, { turn: 1, step: 1, callId: 'c-sleep-1', message: { role: 'user', content: [{ type: 'tool-result', text: 'sleeping' }], isError: false, source: { kind: 'tool', callId: 'c-sleep-1' } } }),
    ev('tool/call', 8, T0 + 8, { turn: 1, step: 1, callId: 'c-memo-1', name: 'dept_memo_write', arguments: '{}' }),
    ev('tool/result', 9, T0 + 9, { turn: 1, step: 1, callId: 'c-memo-1', message: { role: 'user', content: [{ type: 'tool-result', text: 'memo LATE' }], isError: false, source: { kind: 'tool', callId: 'c-memo-1' } } }),
    ev('turn/end', 10, T0 + 10, { turn: 1, reason: { kind: 'completed' } })
  ]
  const { deps } = healthyHostFixture(0, { oldEvents: clean, boundarySeq: 7 })
  const result = await verifyRotationBaseline(deps)
  assert.ok(codesOf(result).includes('memo-after-sleep'), `expected memo-after-sleep, got ${JSON.stringify(codesOf(result))}`)
})

test('A-I3b/I3c/I3d: the journal pair + the seed node — re-key mismatch → `journal-rekey-mismatch`; truncated seed journal → `seed-journal-truncated`; a tampered old journal → `journal-tampered`', async () => {
  // I3b — the NEW journal is not rekeyJournal(HJ_old).
  const b = healthyHostFixture(0)
  const r1 = await verifyRotationBaseline({
    ...b.deps,
    readFileText: async (p) => {
      if (p === '/f/journals/host-session-new.md') return b.hjNew + '\nEXTRA LINE NOT IN THE RE-KEY'
      return b.deps.readFileText(p)
    }
  })
  assert.ok(codesOf(r1).includes('journal-rekey-mismatch'), `expected journal-rekey-mismatch, got ${JSON.stringify(codesOf(r1))}`)

  // I3c — the seed journal node truncates the re-keyed journal.
  const truncated = b.hjNew.slice(0, 40)
  const r2 = await verifyRotationBaseline({
    ...b.deps,
    decodeArtifact: async (p) => {
      if (p === '/f/sessions/new.jsonl') {
        const parsed = b.newText.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
        const node = parsed.find((e) => e.type === 'user/message' && e.seq === 3)
        node.data.content[0].text = truncated
        return { lines: parsed.map((e) => JSON.stringify(e)), byteOk: true }
      }
      return b.deps.decodeArtifact(p)
    }
  })
  assert.ok(codesOf(r2).includes('seed-journal-truncated'), `expected seed-journal-truncated, got ${JSON.stringify(codesOf(r2))}`)

  // I3d — the OLD journal mutated beyond the author (its wake_counter reset).
  const tamperedOld = b.hjOld.replace(/^wake_counter: 2$/m, 'wake_counter: 1')
  const r3 = await verifyRotationBaseline({
    ...b.deps,
    readFileText: async (p) => {
      if (p === '/f/journals/host-session-old.md') return tamperedOld
      return b.deps.readFileText(p)
    }
  })
  assert.ok(codesOf(r3).includes('journal-tampered'), `expected journal-tampered, got ${JSON.stringify(codesOf(r3))}`)
})

test('A-I4: hosts.json ledger — two live → `hosts-live-count`; broken rotatedTo/previousSessionId → `hosts-chain-mismatch`; a cycle → `hosts-chain-cycle`', async () => {
  // I4b — two non-retired hosts.
  const twoLive = hostsFixture('host-session-old', 'session-old', 'host-session-new', 'session-new')
  twoLive['host-session-extra'] = { sessionId: 'session-extra', roomId: 'board', sleepEpoch: T0 }
  const b2 = healthyHostFixture(0)
  const r2 = await verifyRotationBaseline({
    ...b2.deps,
    readFileText: async (p) => {
      if (p === '/f/hosts.json') return JSON.stringify(twoLive, null, 2)
      return b2.deps.readFileText(p)
    }
  })
  assert.ok(codesOf(r2).includes('hosts-live-count'), `expected hosts-live-count, got ${JSON.stringify(codesOf(r2))}`)

  // I4c — the old entry rotates somewhere else.
  const broken = hostsFixture('host-session-old', 'session-old', 'host-session-new', 'session-new')
  broken['host-session-old'].rotatedTo = 'host-session-elsewhere'
  const b3 = healthyHostFixture(0)
  const r3 = await verifyRotationBaseline({
    ...b3.deps,
    readFileText: async (p) => {
      if (p === '/f/hosts.json') return JSON.stringify(broken, null, 2)
      return b3.deps.readFileText(p)
    }
  })
  assert.ok(codesOf(r3).includes('hosts-chain-mismatch'), `expected hosts-chain-mismatch, got ${JSON.stringify(codesOf(r3))}`)

  // I4d — a previousSessionId cycle among retired entries. The loader's rules
  // allow a retired chain (sleepEpoch present — the previousSessionId-bearing
  // entries carry it), so validate passes and the CHAIN WALK detects the revisit.
  const cycle = {
    schemaVersion: 2,
    'host-session-new': { sessionId: 'session-new', roomId: 'board', sleepEpoch: T0, boundarySeq: 9, previousSessionId: 'session-b' },
    'host-session-b': { sessionId: 'session-b', roomId: 'board', sleepEpoch: T0 - 150, retired: true, retiredAt: T0 - 100, rotatedTo: 'host-session-new', previousSessionId: 'session-a' },
    'host-session-a': { sessionId: 'session-a', roomId: 'board', sleepEpoch: T0 - 250, retired: true, retiredAt: T0 - 200, rotatedTo: 'host-session-b', previousSessionId: 'session-b' }
  }
  const b4 = healthyHostFixture(0)
  const r4 = await verifyRotationBaseline({
    ...b4.deps,
    readFileText: async (p) => {
      if (p === '/f/hosts.json') return JSON.stringify(cycle, null, 2)
      return b4.deps.readFileText(p)
    }
  })
  assert.ok(codesOf(r4).includes('hosts-chain-cycle'), `expected hosts-chain-cycle, got ${JSON.stringify(codesOf(r4))}`)
})

test('A-I5: boundary + snapshot stamp — boundarySeq != tool/result seq → `boundary-seq-mismatch` (the FIXED result-vs-call semantics); a stamp 30 min off → `snapshot-stamp`; an undecodable snapshot → `artifact-undecodable`', async () => {
  // I5c — a boundarySeq pinned to the tool/CALL seq (the WRONG semantics).
  const wrong = healthyHostFixture(0, { boundarySeq: 8 })
  const rWrong = await verifyRotationBaseline(wrong.deps)
  assert.ok(codesOf(rWrong).includes('boundary-seq-mismatch'), `expected boundary-seq-mismatch for boundarySeq=8 (the tool/call seq), got ${JSON.stringify(codesOf(rWrong))}`)
  // The healthy control: boundarySeq=9 == the tool/RESULT seq → clean.
  const ok = await verifyRotationBaseline(healthyHostFixture(0).deps)
  assert.equal(ok.ok, true, 'boundarySeq=9 (the tool/RESULT seq) is the FIXED semantics — the healthy control passes')

  // I5a — a stamp 30 minutes in the past (the snapshot content is unchanged).
  const badStampName = snapName('session-old', stampOf(T0 - 30 * 60_000))
  const b = healthyHostFixture(0)
  const rSnap = await verifyRotationBaseline({
    ...b.deps,
    snapshotPath: `/f/archive/${badStampName}`,
    decodeArtifact: async (p) => {
      if (p === `/f/archive/${badStampName}`) return { lines: b.snapPath ? (await b.deps.readFileText(b.snapPath)).split('\n') : [], byteOk: true }
      return b.deps.decodeArtifact(p)
    }
  })
  assert.ok(codesOf(rSnap).includes('snapshot-stamp'), `expected snapshot-stamp, got ${JSON.stringify(codesOf(rSnap))}`)

  // I5b — an undecodable snapshot.
  const b3 = healthyHostFixture(0)
  const r3 = await verifyRotationBaseline({
    ...b3.deps,
    decodeArtifact: async (p) => (p === b3.snapPath ? { lines: [], byteOk: false } : b3.deps.decodeArtifact(p))
  })
  assert.ok(codesOf(r3).includes('artifact-undecodable'), `expected artifact-undecodable for the snapshot, got ${JSON.stringify(codesOf(r3))}`)
})

test('A-I5a: a MISSING snapshot → `missing-artifact` (paths faltantes = violación missing-artifact)', async () => {
  // No explicit snapshotPath → the module scans archiveDir (absent in the pure
  // fixture) → the missing snapshot is a missing-artifact violation.
  const b = healthyHostFixture(0)
  const r = await verifyRotationBaseline({ ...b.deps, snapshotPath: undefined })
  assert.ok(codesOf(r).includes('missing-artifact'), `expected missing-artifact, got ${JSON.stringify(codesOf(r))}`)
})

test('A-I6: handoff + settle — 2 handoff records → `handoff-count`; first turn BEFORE the handoff → `handoff-order`; a pending pair without terminal → `delivery-unsettled`', async () => {
  // I6a — a duplicate handoff record.
  const b1 = healthyHostFixture(0)
  const dupRecords = [handoffRecord('host-session-new', T0 + 1000), { ...handoffRecord('host-session-new', T0 + 1000), id: 'm-handoff-2', seq: 1 }]
  const r1 = await verifyRotationBaseline({
    ...b1.deps,
    readFileText: async (p) => {
      if (p === '/f/messages.jsonl') return messagesText(dupRecords)
      return b1.deps.readFileText(p)
    }
  })
  assert.ok(codesOf(r1).includes('handoff-count'), `expected handoff-count, got ${JSON.stringify(codesOf(r1))}`)

  // I6b — the NEW first turn/start time precedes the handoff ts.
  const b2 = healthyHostFixture(0)
  const earlyTurn = healthyNewEvents(b2.hjNew, T0 + 2000, T0 + 1000)
  earlyTurn[7] = { ...earlyTurn[7], time: T0 + 900 }
  const r2 = await verifyRotationBaseline({
    ...b2.deps,
    decodeArtifact: async (p) => {
      if (p === '/f/sessions/new.jsonl') return { lines: earlyTurn.map((e) => JSON.stringify(e)), byteOk: true }
      return b2.deps.decodeArtifact(p)
    }
  })
  assert.ok(codesOf(r2).includes('handoff-order'), `expected handoff-order, got ${JSON.stringify(codesOf(r2))}`)

  // I6c — a pending pair addressed to the RAW retired SESSION id (not
  // reroutable — the settle terminalizes those) with NO terminal row.
  const b3 = healthyHostFixture(0)
  const r3 = await verifyRotationBaseline({
    ...b3.deps,
    readFileText: async (p) => {
      if (p === '/f/deliveries.jsonl') return deliveriesText([{ messageId: 'm-1', recipientId: 'session-old', status: 'prepared', ts: T0 }])
      if (p === '/f/messages.jsonl') {
        const records = await b3.deps.readFileText(p)
        const parsed = records.split('\n').filter(Boolean).map((l) => JSON.parse(l))
        parsed.push({ id: 'm-1', seq: 99, ts: T0 - 1000, from: 'research-head', to: ['session-old'], text: 'queued while sleeping', kind: 'agent' })
        return parsed.map((r) => JSON.stringify(r)).join('\n') + '\n'
      }
      return b3.deps.readFileText(p)
    }
  })
  assert.ok(codesOf(r3).includes('delivery-unsettled'), `expected delivery-unsettled, got ${JSON.stringify(codesOf(r3))}`)

  // LANE ② (m-440 / fb-58 F-3): a pending pair addressed to the host MEMBER
  // id whose chain resolves a live successor is RE-DRIVEN, never terminal-
  // settled — the assertion EXCLUDES it (no delivery-unsettled without a terminal).
  const b4 = healthyHostFixture(0)
  const r4 = await verifyRotationBaseline({
    ...b4.deps,
    readFileText: async (p) => {
      if (p === '/f/deliveries.jsonl') return deliveriesText([{ messageId: 'm-2', recipientId: 'host-session-old', status: 'prepared', ts: T0 }])
      if (p === '/f/messages.jsonl') {
        const records = await b4.deps.readFileText(p)
        const parsed = records.split('\n').filter(Boolean).map((l) => JSON.parse(l))
        parsed.push({ id: 'm-2', seq: 99, ts: T0 - 1000, from: 'research-head', to: ['host-session-old'], text: 'in-flight ack to the rotated host', kind: 'agent' })
        return parsed.map((r) => JSON.stringify(r)).join('\n') + '\n'
      }
      return b4.deps.readFileText(p)
    }
  })
  assert.deepEqual(codesOf(r4).filter((c) => c === 'delivery-unsettled'), [], 'the reroutable host-member pair is EXCLUDED from the settle obligation')
  assert.equal(r4.ok, true, 'the reroutable-pair fixture is healthy')
})

test('A-I6c ALTO-1/m-728 guard: a pending pair whose record does NOT address the recipient is EXCLUDED — the fixture passes (only the guard row exists)', async () => {
  const b = healthyHostFixture(0)
  const guardRows = [
    { messageId: 'm-guard', recipientId: 'host-session-old', status: 'prepared', ts: T0 },
    { messageId: 'm-guard', recipientId: 'host-session-old', status: 'failed', ts: T0 }
  ]
  const r = await verifyRotationBaseline({
    ...b.deps,
    readFileText: async (p) => {
      if (p === '/f/deliveries.jsonl') return deliveriesText(guardRows)
      if (p === '/f/messages.jsonl') {
        const records = await b.deps.readFileText(p)
        const parsed = records.split('\n').filter(Boolean).map((l) => JSON.parse(l))
        parsed.push({ id: 'm-guard', seq: 99, ts: T0 - 1000, from: 'research-head', to: ['someone-else'], text: 'guard row', kind: 'agent' })
        return parsed.map((r) => JSON.stringify(r)).join('\n') + '\n'
      }
      return b.deps.readFileText(p)
    }
  })
  assert.deepEqual(codesOf(r).filter((c) => c === 'delivery-unsettled'), [], 'the guard row is excluded — no delivery-unsettled')
  assert.equal(r.ok, true, 'the ALTO-1 guard fixture is healthy')
})

test('A: missing OLD artifact → `missing-artifact`; an oversized artifact → `artifact-too-large` (jamás hang, jamás throw)', async () => {
  const b = healthyHostFixture(0)
  const r1 = await verifyRotationBaseline({
    ...b.deps,
    findArtifact: async (_root, id) => (id === 'session-old' ? undefined : '/f/sessions/new.jsonl')
  })
  assert.ok(codesOf(r1).includes('missing-artifact'), `expected missing-artifact, got ${JSON.stringify(codesOf(r1))}`)

  const huge = 'x'.repeat(200)
  const r2 = await verifyRotationBaseline({
    ...b.deps,
    maxArtifactLines: 100,
    decodeArtifact: async () => ({ lines: Array.from({ length: 150 }, () => huge), byteOk: true })
  })
  assert.ok(codesOf(r2).includes('artifact-too-large'), `expected artifact-too-large, got ${JSON.stringify(codesOf(r2))}`)
})

test('A: severity — an inline logger.warn fires ONCE when violations exist (no dept_feedback from the module)', async () => {
  const warns = []
  const b = healthyHostFixture(4, { oldEvents: [...healthyOldEvents(T0), ev('turn/start', 151, T0 + 151, { turn: 7 })] })
  const r = await verifyRotationBaseline({ ...b.deps, logger: { warn: (m) => warns.push(m) } })
  assert.equal(r.ok, false)
  assert.ok(codesOf(r).includes('post-rotation-turn'))
  assert.equal(warns.length, 1, 'exactly ONE warn log line')
  assert.match(warns[0], /ROTATION BASELINE VIOLATION/)
  assert.match(warns[0], /post-rotation-turn/)
})

// ===========================================================================
// Block B — T1 integration: the REAL rotation on a temp stateDir, then the
// assertion on the REAL artifacts. AA: rotate the chain 2x.
// ===========================================================================

/** Shared adoption map: durable child session id → its direct parent session id. */
const postAdoption = new Map()

/** Subagent provider stub: continuable-capable, records prepare calls. */
function stubProvider(name) {
  const provider = {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: name === 'fork',
    prepareCalls: [],
    async start() {
      throw new Error(`stub provider "${name}": one-shot start is not used in these tests`)
    },
    async prepareContinuable(request) {
      provider.prepareCalls.push(request)
      return { seed: [] }
    }
  }
  return provider
}

/** Materialize one (fresh or resumed) agent with the requested identity. */
async function materializeStubAgent(agents, sessionId, options) {
  const callerSignal = options.signal
  let callerSignalAborted = false
  callerSignal?.addEventListener('abort', () => {
    callerSignalAborted = true
  }, { once: true })
  const parentSession = options.parentSession ?? options.meta?.parentSession
  const agent = {
    id: sessionId,
    options: options.agentOptions ?? {},
    status: 'idle',
    session: {
      header: { id: sessionId, parentSession, delegationDepth: options.meta?.delegationDepth },
      events: [],
      get seq() { return this.events.length },
      snapshotEvents() { return this.events },
      requestHeader() { return undefined }
    },
    inboxMessages: [],
    ctx: undefined,
    callerSignalAborted: () => callerSignalAborted,
    followup(message) { this.inboxMessages.push(message) },
    steer() {},
    inject() {},
    send() {},
    cancelCalls: [],
    cancel(cause, options) { this.cancelCalls.push({ cause, options }) },
    whenIdle() { return new Promise(() => {}) }
  }
  const childKey = Symbol('stub-child-scope')
  const scope = createScope(agents.scopeAnchor, childKey)
  const childCtx = scope.ctx.extend({ agent })
  agent.ctx = childCtx
  agents.childContexts.push({ ctx: childCtx, key: childKey })
  agents.childAgents.push(agent)
  const provision = await options.setup?.(childCtx)
  provision?.commit?.()
  agents.store.set(sessionId, agent)
  return {
    agent,
    dispose: async () => {
      agents.disposeCalls.set(sessionId, (agents.disposeCalls.get(sessionId) ?? 0) + 1)
      const gate = agents.disposeGates.get(sessionId)
      if (gate !== undefined) await gate
      agents.store.delete(sessionId)
    }
  }
}

/** Stub agents service: satisfies the REAL SubagentContinuationManager. */
class StubAgents extends Service {
  constructor(ctx, sessionCwds) {
    super(ctx, 'agents')
    this.store = new Map()
    this.createCalls = []
    this.resumeCalls = []
    this.childContexts = []
    this.childAgents = []
    this.scopeAnchor = ctx
    this.sessionCwds = sessionCwds
    this.resumeRejects = new Set()
    this.createRejects = new Set()
    this.disposeGates = new Map()
    this.disposeCalls = new Map()
    this.scopeParentKey = undefined
    this.scopeKeyAsAgent = false
    this.scopeCreate = undefined
  }

  get(id) { return this.store.get(id) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  put(agent) { this.store.set(agent.id, agent); return agent }

  ensureStoreSession(sessionId) {
    const id = SessionId(sessionId)
    const store = this.ctx.get('sessions')
    if (store === undefined || typeof store.get !== 'function') return undefined
    const existing = store.get(id)
    if (existing !== undefined) return existing
    try {
      return store.create(id, {}) ?? store.get(id)
    } catch {
      return store.get(id)
    }
  }

  async create(options) {
    this.createCalls.push(options)
    if (this.createRejects.has(String(options.sessionId))) throw new Error('stub: forced create failure')
    this.sessionCwds?.set(String(options.sessionId), options.meta?.cwd)
    this.ensureStoreSession(options.sessionId)
    return materializeStubAgent(this, options.sessionId, options)
  }

  async resume(options) {
    this.resumeCalls.push(options)
    if (this.resumeRejects.has(options.resumeSessionId)) throw new Error('stub: forced resume failure')
    this.sessionCwds?.set(String(options.resumeSessionId), options.meta?.cwd)
    this.ensureStoreSession(options.resumeSessionId)
    return materializeStubAgent(this, options.resumeSessionId, {
      ...options,
      parentSession: postAdoption.get(options.resumeSessionId)
    })
  }
}

/** Stub persistence: records the rotation S2 create/append calls as spies. */
class StubPersistence extends Service {
  constructor(ctx) {
    super(ctx, 'sessionPersistence')
    this.createCalls = []
    this.appendCalls = []
  }

  async create(meta) { this.createCalls.push(meta) }
  async append(id, events) { this.appendCalls.push({ id, events }) }

  async inspect(childId) {
    const parentSession = postAdoption.get(childId)
    if (parentSession === undefined) throw new Error('stub persistence: no stored session for this child')
    return { meta: { parentSession, seedLength: 0 }, events: [{ type: 'subagent/descriptor', data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'board-post' } }] }
  }

  async list() { return [] }
}

/** Stub workspace registry (the canonical archive/attach service seam). */
class StubWorkspaceRegistry extends Service {
  constructor(ctx, stateDir, sessionCwds) {
    super(ctx, 'workspaceRegistry')
    this.stateDir = stateDir
    this.archived = []
    this.attachCalls = []
    this.sessionCwds = sessionCwds
    this.entitySessions = []
    this.createCalls = []
    const defaultEntity = {
      path: stateDir,
      title: 'root',
      sessionIds: this.entitySessions,
      attachSession: async (sessionId) => {
        this.attachCalls.push(sessionId)
        const cwd = this.sessionCwds?.get(String(sessionId))
        if (cwd !== undefined && cwd !== stateDir) throw new Error(`stub: cwd mismatch for ${sessionId} (${cwd} != ${stateDir})`)
        if (!this.entitySessions.includes(sessionId)) {
          this.entitySessions.push(sessionId)
          writeFile(path.join(this.stateDir, 'workspace.json'), JSON.stringify({ path: this.stateDir, sessionIds: [...this.entitySessions] }, null, 2), 'utf8').catch(() => {})
        }
      }
    }
    this.entities = [defaultEntity]
  }

  get archivedSessionIds() { return this.archived }
  list() { return Promise.resolve(this.entities) }
  async create(path, title) {
    this.createCalls = [...(this.createCalls ?? []), { path, title }]
    const existing = this.entities.find((e) => e.path === path)
    if (existing !== undefined) return existing
    const sessions = []
    const entity = {
      path, title, sessionIds: sessions,
      attachSession: async (sessionId) => {
        this.attachCalls.push(sessionId)
        if (!sessions.includes(sessionId)) sessions.push(sessionId)
      }
    }
    this.entities.push(entity)
    return entity
  }
  async resolveByPath(p) {
    const canonical = await realpath(p)
    return this.entities.find((e) => e.path === canonical)
  }
  async archiveSession(sessionId) {
    if (this.archived.includes(sessionId)) return
    this.archived.push(sessionId)
    writeFile(path.join(this.stateDir, 'workspace-registry.json'), JSON.stringify(this.archived, null, 2), 'utf8').catch(() => {})
  }
}

/** A live parent agent as the registry would hold it (exact identity). */
function fakeParentAgent(id = SessionId(randomUUID())) {
  return {
    id,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    status: 'idle',
    session: { header: { id }, events: [], get seq() { return this.events.length }, snapshotEvents() { return this.events }, requestHeader() { return undefined } },
    ctx: { get: () => undefined },
    inboxMessages: [],
    injectedMessages: [],
    followup(message) { this.inboxMessages.push(message) },
    steer() {},
    inject(message) { this.injectedMessages.push(message) },
    send() {},
    cancelCalls: [],
    cancel(cause, options) { this.cancelCalls.push({ cause, options }) },
    whenIdle() { return new Promise(() => {}) }
  }
}

/** Boot the real Loader with the real dsh services + the deepartments bundle. */
async function bootPlugin(stateDir, opts = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })

  const agents = new StubAgents(root, new Map())
  const persistence = new StubPersistence(root)
  const workspaceRegistry = new StubWorkspaceRegistry(root, stateDir, agents.sessionCwds)
  await root.plugin(SubagentRuntime)

  const spawnStub = stubProvider('spawn')
  const forkStub = stubProvider('fork')
  root.subagents.registerProvider(spawnStub)
  root.subagents.registerProvider(forkStub)

  loader.create({
    id: 'deepartments',
    name: '../lib/index.js',
    config: {
      stateDir,
      org: opts.org ?? QD_ORG
    }
  })
  await loader.await()
  agents.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  return {
    root,
    agents,
    persistence,
    workspaceRegistry,
    spawnStub,
    forkStub,
    pluginCtx: () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx,
    dispose: () => loaderFiber.dispose()
  }
}

async function bootWithQD(stateDir) {
  const env = await bootPlugin(stateDir)
  await waitFor(() => env.agents.store.has('head-research-head'), 5000, 'research head materialized at boot')
  await waitFor(() => env.agents.store.has('head-quality-head'), 5000, 'quality head materialized at boot')
  return env
}

async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-rotation-baseline-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Pre-author a post's long-term memory journal (dept_sleep REQUIRES it). */
async function seedJournal(stateDir, postId, summary) {
  const journalPath = path.join(stateDir, 'journals', `${postId}.md`)
  await mkdir(path.dirname(journalPath), { recursive: true })
  const content = [
    '---',
    `author: ${postId}`,
    `timestamp: ${new Date().toISOString()}`,
    'wake_counter: 1',
    'board_cursor: none',
    'decisions: []',
    'constraints: []',
    'open_items: []',
    '---',
    '',
    summary,
    ''
  ].join('\n')
  await writeFile(journalPath, content, 'utf8')
  return journalPath
}

async function readHosts(stateDir) {
  const hostsPath = path.join(stateDir, 'hosts.json')
  let parsed
  await waitFor(async () => {
    try {
      parsed = JSON.parse(await readFile(hostsPath, 'utf8'))
      return true
    } catch {
      return false
    }
  }, 5000, 'hosts.json readable')
  return parsed
}

async function seedMessageRecords(stateDir, records) {
  const filePath = resolveMessagesPath(stateDir)
  await mkdir(stateDir, { recursive: true })
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

async function seedDeliveryRows(stateDir, rows) {
  const filePath = resolveDeliveriesPath(stateDir)
  await mkdir(stateDir, { recursive: true })
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

/** The event list an OLD host artifact holds for one recorded rotation (the
 * fixture side of the real rotation — the stub harness never writes the live
 * session's log to the sessions root, so the OLD artifact is authored with the
 * SAME seq layout the real driver would have produced: sleep tool/result at 9). */
function blockBOldEvents(now) {
  const turn = 1
  return [
    ev('permission/preset', 0, now + 0, { preset: 'danger-full-access' }),
    ev('sandbox/mode', 1, now + 1, { mode: 'danger-full-access' }),
    ev('approval/policy', 2, now + 2, { policy: 'never' }),
    ev('user/message', 3, now + 3, { role: 'user', content: [{ type: 'text', text: 'prior context' }], source: { kind: 'user' } }),
    ev('turn/start', 4, now + 4, { turn }),
    ev('user/message', 5, now + 5, { role: 'user', content: [{ type: 'text', text: 'turn input' }], source: { kind: 'user' } }),
    ev('tool/call', 6, now + 6, { turn, step: 1, callId: 'c-memo-1', name: 'dept_memo_write', arguments: '{}' }),
    ev('tool/result', 7, now + 7, { turn, step: 1, callId: 'c-memo-1', message: { role: 'user', content: [{ type: 'tool-result', text: 'memo written' }], isError: false, source: { kind: 'tool', callId: 'c-memo-1' } } }),
    ev('tool/call', 8, now + 8, { turn, step: 1, callId: 'c-sleep-1', name: 'dept_sleep', arguments: '{}' }),
    ev('tool/result', 9, now + 9, { turn, step: 1, callId: 'c-sleep-1', message: { role: 'user', content: [{ type: 'tool-result', text: 'sleeping: rotation complete' }], isError: false, source: { kind: 'tool', callId: 'c-sleep-1' } } }),
    ev('turn/end', 10, now + 10, { turn, reason: { kind: 'completed' } })
  ]
}

/** The seed the rotation actually persisted (via the StubPersistence). */
function recordedSeedFor(persistence, sessionId) {
  const entry = persistence.appendCalls.find((a) => String(a.id) === String(sessionId))
  return entry === undefined ? undefined : entry.events
}

/** A REAL dsh-session carrying exactly the events up to (and including) the
 * dept_sleep tool/call — agent.session.seq then lands on the tool/result seq
 * (the FIXED boundarySeq semantics: seq = log length at tool-call time). */
function realSessionUpToSleepCall(events, sessionId) {
  const session = Session.create(SessionId(sessionId))
  const sleepCallSeq = events.find((e) => e.type === 'tool/call' && e.data.name === 'dept_sleep').seq
  for (const event of events) {
    if (event.seq > sleepCallSeq) break
    // Surface-eligible events (user/message, tool/result, …) REQUIRE the
    // append-origin marker; log-only events (permission/preset, …) MUST NOT
    // carry it — adapt per event type.
    try {
      session.append(event.type, event.data, { surfaceOp: 'append' })
    } catch {
      session.append(event.type, event.data)
    }
  }
  return session
}

/** Write one artifact under the sessions root (findSessionArtifact's layout). */
async function authorArtifact(sessionsRoot, sessionId, events) {
  const dir = path.join(sessionsRoot, '--root--', encodeSegment(sessionId))
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, 'session.jsonl')
  await writeFile(filePath, artifactText(sessionId, events), 'utf8')
  return filePath
}

/** The successor artifact: the REAL recorded seed + end-seed + the handoff
 * notice + a post-handoff first turn. Returns {path, events}. */
async function authorSuccessorArtifact(sessionsRoot, sessionId, seedEvents, handoffTs) {
  const events = [
    ...seedEvents.map((e) => JSON.parse(JSON.stringify(e))),
    ev('session/end-seed', seedEvents.length, handoffTs - 1, {}),
    ev('user/message', seedEvents.length + 1, handoffTs, { role: 'user', content: [{ type: 'text', text: `[From deepartments → host-${sessionId}]: host session rotation complete (spec 002) — this is the rotation's OWN successor handoff.` }], source: { kind: 'system' } }),
    ev('turn/start', seedEvents.length + 2, handoffTs + 1, { turn: 1 }),
    ev('user/message', seedEvents.length + 3, handoffTs + 2, { role: 'user', content: [{ type: 'text', text: 'wake input' }], source: { kind: 'user' } }),
    ev('turn/end', seedEvents.length + 4, handoffTs + 3, { turn: 1, reason: { kind: 'completed' } })
  ]
  const filePath = await authorArtifact(sessionsRoot, sessionId, events)
  return { path: filePath, events }
}

/** The latest archive snapshot path for a session id. */
async function latestSnapshot(archiveDir, sessionId) {
  const names = await readdir(archiveDir)
  const hits = names.filter((n) => n.startsWith(`session-${sessionId}-pre-rotation-`))
  assert.ok(hits.length >= 1, `expected a snapshot for ${sessionId} in ${archiveDir}, found ${names.join(', ')}`)
  return path.join(archiveDir, hits.sort().at(-1))
}

/** The assertion deps for the integration blocks (real fs reads). */
function baselineDepsFor(stateDir, { oldId, newId, oldHost, newHost, snapPath, authorMap, mode = 'host', logger }) {
  const sessionsRoot = path.join(stateDir, '..', 'sessions')
  const archiveDir = path.join(stateDir, '..', 'archive')
  return {
    mode,
    stateDir,
    sessionsRoot,
    archiveDir,
    oldSessionId: oldId,
    newSessionId: newId,
    hostIdOld: oldHost,
    hostIdNew: newHost,
    decodeArtifact: async (p) => {
      const content = await readFile(p, 'utf8').catch(() => undefined)
      return content === undefined ? { lines: [], byteOk: false } : { lines: content.split('\n'), byteOk: true }
    },
    readFileText: async (p) => readFile(p, 'utf8').catch(() => undefined),
    findArtifact: authorMap === undefined
      ? undefined
      : async (_root, id) => authorMap.get(String(id)),
    snapshotPath: snapPath,
    ...(logger !== undefined ? { logger } : {})
  }
}

test('B-T1: the REAL rotation on a temp stateDir → wait for the dispose/finalize settle (m-423 snapshot-anchor) → verifyRotationBaseline {ok:true} with the real artifacts; the REAL PR-2 settle terminalizes the pending pair inside the window', async () => {
  await withTempStateDir(async (stateDir) => {
    const now = Date.now()
    const host = fakeParentAgent()
    const oldId = String(host.id)
    const oldHost = `host-${oldId}`
    await seedJournal(stateDir, oldHost, 'BLOCK-B-T1-MEMORY')

    // The OLD artifact (the fixture of the live session log — the stub harness
    // never writes it; the real rotation copies it at S2.7 + finalizes it).
    const sessionsRoot = path.join(stateDir, '..', 'sessions')
    const archiveDir = path.join(stateDir, '..', 'archive')
    const oldEvents = blockBOldEvents(now)
    const oldArtifactPath = await authorArtifact(sessionsRoot, oldId, oldEvents)

    // The pending pair (in-session, after the boot pass — rotate-settle
    // pattern) + its addressing message record. The row targets the RAW
    // retired SESSION id (not the host member id): the PR-2 settle
    // terminalizes raw-session rows, while host-member rows are REROUTED to
    // the successor (LANE ② m-440 — the assertion excludes those).
    await seedMessageRecords(stateDir, [
      { id: 'm-canary', seq: 0, ts: now, from: 'research-head', to: ['dead-canary'], text: 'pass-completion canary', kind: 'agent' },
      { id: 'm-1', seq: 1, ts: now, from: 'research-head', to: [oldId], text: 'crash mid-fan-out to host session', kind: 'agent' }
    ])
    await seedDeliveryRows(stateDir, [{ messageId: 'm-canary', recipientId: 'dead-canary', status: 'failed', ts: now }])

    const env = await bootWithQD(stateDir)
    try {
      // BARRIER: the boot re-delivery pass completed (the canary is terminal).
      await waitFor(async () => (await deliveryStatus(stateDir, 'm-canary', 'dead-canary')) === 'terminal', 5000, 'boot pass completed')
      // The pending row is seeded IN-SESSION (post-pass) — the PR-2 settle must
      // terminalize it AT ROTATION TIME.
      await seedDeliveryRows(stateDir, [{ messageId: 'm-1', recipientId: oldId, status: 'prepared', ts: now }])

      // The host agent carries a REAL dsh-session ending at the dept_sleep
      // tool/call → agent.session.seq == the tool/result seq (boundarySeq 9).
      env.agents.put(host)
      host.session = realSessionUpToSleepCall(oldEvents, oldId)
      let concluded = false
      const signal = new AbortController().signal
      const result = await env.root.tools.get('dept_sleep').execute({}, { agent: host, signal, concludeTurn: () => { concluded = true } })
      assert.ok(concluded, 'the host turn concluded')
      assert.match(result.member, /^host-session-/, 'the rotation returned the NEW host id')
      const newHostId = result.member
      const newId = newHostId.slice('host-'.length)

      // Wait for the snapshot-anchor settle: the m-423 finalize re-copied OLD
      // over SNAP after the old-handle dispose (best-effort bound — the S2.7
      // copy alone is already delta-0 here, so the assertion tolerates either).
      const snapPath = await latestSnapshot(archiveDir, oldId)
      await waitFor(async () => {
        const snap = await readFile(snapPath, 'utf8').catch(() => '')
        return snap === (await readFile(oldArtifactPath, 'utf8'))
      }, 5000, 'snapshot finalized onto the settled artifact (delta 0)')

      // The REAL chain state.
      const hosts = await readHosts(stateDir)
      assert.equal(hosts[oldHost].retired, true)
      assert.equal(hosts[oldHost].rotatedTo, newHostId)
      assert.equal(hosts[newHostId].sessionId, newId)
      assert.equal(hosts[newHostId].boundarySeq, 9, 'the real rotation recorded boundarySeq == the dept_sleep tool/result seq (agent.session.seq at tool time)')

      // The REAL successor artifact: the REAL recorded seed + end-seed + the
      // handoff notice (ts from the durable record) + a post-handoff turn.
      const seed = recordedSeedFor(env.persistence, newId)
      assert.ok(seed !== undefined && seed.length === 5, 'the rotation persisted the 5-event seed')
      const handoffRecords = await loadMessageRecords(resolveMessagesPath(stateDir))
      const wake = handoffRecords.find((r) => r.from === 'deepartments' && (r.to ?? []).includes(newHostId))
      assert.ok(wake !== undefined, 'the REAL rotation-wake handoff record is durable')
      const success = await authorSuccessorArtifact(sessionsRoot, newId, seed, wake.ts)
      const authorMap = new Map([
        [oldId, oldArtifactPath],
        [newId, success.path]
      ])

      const warns = []
      const verdict = await verifyRotationBaseline(baselineDepsFor(stateDir, {
        oldId,
        newId,
        oldHost,
        newHost: newHostId,
        snapPath,
        authorMap,
        logger: { warn: (m) => warns.push(m) }
      }))
      assert.deepEqual(verdict.violations, [], `T1 baseline must be clean on the REAL rotation: ${JSON.stringify(verdict.violations)}`)
      assert.equal(verdict.ok, true)
      assert.equal(warns.length, 0)

      // The REAL PR-2 settle: the pending pair became terminal AT ROTATION TIME.
      const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
      const terminal = rows.find((r) => r.messageId === 'm-1' && r.recipientId === oldId && r.status === 'terminal')
      assert.ok(terminal !== undefined, 'the PR-2 settle terminalized the pending pair in-session')
      assert.ok(terminal.ts >= hosts[oldHost].retiredAt && terminal.ts <= hosts[oldHost].retiredAt + DEFAULT_SETTLE_WINDOW_MS, 'the terminal row is inside the settle window')
    } finally {
      await env.dispose()
    }
  })
})

test('B-AA: rotate the chain 2x — the 2nd assertion uses the 2nd pair ids (no contamination) and the 1st pair still verifies {ok:true}', async () => {
  await withTempStateDir(async (stateDir) => {
    const base = Date.now()
    const host1 = fakeParentAgent()
    const oldId1 = String(host1.id)
    const oldHost1 = `host-${oldId1}`
    await seedJournal(stateDir, oldHost1, 'BLOCK-B-AA-MEMORY-1')
    const sessionsRoot = path.join(stateDir, '..', 'sessions')
    const archiveDir = path.join(stateDir, '..', 'archive')

    const env = await bootWithQD(stateDir)
    try {
      // ---- rotation 1 ----
      const events1 = blockBOldEvents(base)
      const oldPath1 = await authorArtifact(sessionsRoot, oldId1, events1)
      env.agents.put(host1)
      host1.session = realSessionUpToSleepCall(events1, oldId1)
      const signal = new AbortController().signal
      const r1 = await env.root.tools.get('dept_sleep').execute({}, { agent: host1, signal, concludeTurn: () => {} })
      assert.match(r1.member, /^host-session-/, 'rotation 1 returned the NEW host id')
      const newHostId1 = r1.member
      const newId1 = newHostId1.slice('host-'.length)
      const snapPath1 = await latestSnapshot(archiveDir, oldId1)
      await waitFor(async () => {
        const snap = await readFile(snapPath1, 'utf8').catch(() => '')
        return snap === (await readFile(oldPath1, 'utf8'))
      }, 5000, 'rotation-1 snapshot finalized')
      const handoffs1 = await loadMessageRecords(resolveMessagesPath(stateDir))
      const wake1 = handoffs1.find((r) => r.from === 'deepartments' && (r.to ?? []).includes(newHostId1))
      assert.ok(wake1 !== undefined, 'rotation-1 handoff durable')
      const seed1 = recordedSeedFor(env.persistence, newId1)
      const s1 = await authorSuccessorArtifact(sessionsRoot, newId1, seed1, wake1.ts)
      const authorMap1 = new Map([
        [oldId1, oldPath1],
        [newId1, s1.path]
      ])
      const v1 = await verifyRotationBaseline(baselineDepsFor(stateDir, { oldId: oldId1, newId: newId1, oldHost: oldHost1, newHost: newHostId1, snapPath: snapPath1, authorMap: authorMap1 }))
      assert.equal(v1.ok, true, `pair 1 clean: ${JSON.stringify(v1.violations)}`)
      // Snapshot pair-1's journal row AT PAIR-1 TIME: rotation 2 legitimately
      // bumps journals/host-<newId1>.md (its S1.5) when the successor sleeps
      // again, so the pair-1 re-verify must read the pair-1-time contents.
      const journalsDir = path.join(stateDir, 'journals')
      const pair1OldJournal = await readFile(path.join(journalsDir, `${oldHost1}.md`), 'utf8')
      const pair1NewJournal = await readFile(path.join(journalsDir, `${newHostId1}.md`), 'utf8')

      // ---- rotation 2 (the successor sleeps again) ----
      const host2 = env.agents.store.get(newId1)
      assert.ok(host2 !== undefined, 'the successor is materialized (rotation-1 wake)')
      // The successor's OWN artifact (OLD for rotation 2): the real seed1 +
      // end-seed + handoff node + a turn whose log carries the rotation-2 memo
      // + sleep pair (result at seq 12 — the real boundarySeq2).
      const now2 = base + 5000
      const events2 = [
        ...seed1.map((e) => JSON.parse(JSON.stringify(e))),
        ev('session/end-seed', 5, now2 - 4, {}),
        ev('user/message', 6, now2 - 3, { role: 'user', content: [{ type: 'text', text: '[From deepartments → host-session-…]: handoff' }], source: { kind: 'system' } }),
        ev('turn/start', 7, now2 - 2, { turn: 1 }),
        ev('user/message', 8, now2 - 1, { role: 'user', content: [{ type: 'text', text: 'wake input' }], source: { kind: 'user' } }),
        ev('tool/call', 9, now2, { turn: 1, step: 1, callId: 'c-memo-2', name: 'dept_memo_write', arguments: '{}' }),
        ev('tool/result', 10, now2 + 1, { turn: 1, step: 1, callId: 'c-memo-2', message: { role: 'user', content: [{ type: 'tool-result', text: 'memo 2' }], isError: false, source: { kind: 'tool', callId: 'c-memo-2' } } }),
        ev('tool/call', 11, now2 + 2, { turn: 1, step: 1, callId: 'c-sleep-2', name: 'dept_sleep', arguments: '{}' }),
        ev('tool/result', 12, now2 + 3, { turn: 1, step: 1, callId: 'c-sleep-2', message: { role: 'user', content: [{ type: 'tool-result', text: 'sleeping: rotation 2' }], isError: false, source: { kind: 'tool', callId: 'c-sleep-2' } } }),
        ev('turn/end', 13, now2 + 4, { turn: 1, reason: { kind: 'completed' } })
      ]
      const oldPath2 = await authorArtifact(sessionsRoot, newId1, events2)
      host2.session = realSessionUpToSleepCall(events2, newId1) // events 0..11 → seq 12 == the tool/result seq
      const r2 = await env.root.tools.get('dept_sleep').execute({}, { agent: host2, signal, concludeTurn: () => {} })
      assert.match(r2.member, /^host-session-/, 'rotation 2 returned the 2nd NEW host id')
      assert.notEqual(r2.member, newHostId1, 'rotation 2 really minted a NEW id')
      const newHostId2 = r2.member
      const newId2 = newHostId2.slice('host-'.length)
      const snapPath2 = await latestSnapshot(archiveDir, newId1)
      await waitFor(async () => {
        const snap = await readFile(snapPath2, 'utf8').catch(() => '')
        return snap === (await readFile(oldPath2, 'utf8'))
      }, 5000, 'rotation-2 snapshot finalized')
      const hosts = await readHosts(stateDir)
      assert.equal(hosts[newHostId2].boundarySeq, 12, 'rotation-2 boundarySeq == the 2nd rotation tool/result seq (12)')
      const handoffs2 = await loadMessageRecords(resolveMessagesPath(stateDir))
      const wake2 = handoffs2.find((r) => r.from === 'deepartments' && (r.to ?? []).includes(newHostId2))
      assert.ok(wake2 !== undefined, 'rotation-2 handoff durable')
      const seed2 = recordedSeedFor(env.persistence, newId2)
      assert.ok(seed2 !== undefined && seed2.length === 5, 'rotation-2 persisted its 5-event seed')
      const s2 = await authorSuccessorArtifact(sessionsRoot, newId2, seed2, wake2.ts)
      const authorMap2 = new Map([
        [newId1, oldPath2],
        [newId2, s2.path]
      ])
      const v2 = await verifyRotationBaseline(baselineDepsFor(stateDir, { oldId: newId1, newId: newId2, oldHost: newHostId1, newHost: newHostId2, snapPath: snapPath2, authorMap: authorMap2 }))
      assert.equal(v2.ok, true, `pair 2 clean: ${JSON.stringify(v2.violations)}`)

      // AA — the 2nd assertion used the 2nd pair's ids WITHOUT contaminating
      // the 1st pair: pair 1 still verifies + its artifacts are untouched
      // (the journal row read from the pair-1-time snapshot above).
      const v1again = await verifyRotationBaseline({
        ...baselineDepsFor(stateDir, { oldId: oldId1, newId: newId1, oldHost: oldHost1, newHost: newHostId1, snapPath: snapPath1, authorMap: authorMap1 }),
        oldJournalPath: path.join(journalsDir, `${oldHost1}.md`),
        newJournalPath: path.join(journalsDir, `${newHostId1}.md`),
        readFileText: async (p) => {
          if (p === path.join(journalsDir, `${oldHost1}.md`)) return pair1OldJournal
          if (p === path.join(journalsDir, `${newHostId1}.md`)) return pair1NewJournal
          return readFile(p, 'utf8').catch(() => undefined)
        }
      })
      assert.equal(v1again.ok, true, `pair 1 still clean after rotation 2: ${JSON.stringify(v1again.violations)}`)
      const snap1Bytes = await readFile(snapPath1, 'utf8')
      assert.equal(snap1Bytes, await readFile(oldPath1, 'utf8'), 'pair-1 snapshot untouched by rotation 2')
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// Block C — T2: dept_head_rotate (the real hermetic tool) + the REDUCED
// 'head' mode assertion (no hosts.json, no re-key, no snapshot, BOOT-QUIET).
// ===========================================================================

test('C-T2: dept_head_rotate vía el tool real (patrón invoke.test.js:21792) → the REDUCED head-mode assertion over the fresh-mint artifacts → {ok:true}; a pre-turn notice on the successor → seed-unbalanced (boot-quiet)', async () => {
  await withTempStateDir(async (stateDir) => {
    const postId = 'research-head'
    const oldSessionId = 'head-research-head'
    const journal = [
      '---',
      `author: ${postId}`,
      'timestamp: 2026-09-07T10:00:00.000Z',
      'wake_counter: 3',
      '---',
      '',
      'HEAD-ROTATE-SEED: carried verbatim into the fresh session.',
      ''
    ].join('\n')
    const journalPath = path.join(stateDir, 'journals', `${postId}.md`)
    await mkdir(path.dirname(journalPath), { recursive: true })
    await writeFile(journalPath, journal, 'utf8')

    // The OLD head artifact (pre-rotation).
    const sessionsRoot = path.join(stateDir, '..', 'sessions')
    const now = Date.now()
    const headOldEvents = [
      ev('permission/preset', 0, now + 0, { preset: 'danger-full-access' }),
      ev('sandbox/mode', 1, now + 1, { mode: 'danger-full-access' }),
      ev('approval/policy', 2, now + 2, { policy: 'never' }),
      ev('user/message', 3, now + 3, { role: 'user', content: [{ type: 'text', text: 'head context' }], source: { kind: 'user' } }),
      ev('turn/start', 4, now + 4, { turn: 1 }),
      ev('user/message', 5, now + 5, { role: 'user', content: [{ type: 'text', text: 'head turn input' }], source: { kind: 'user' } }),
      ev('turn/end', 6, now + 6, { turn: 1, reason: { kind: 'completed' } })
    ]
    const oldHeadPath = await authorArtifact(sessionsRoot, oldSessionId, headOldEvents)

    const env = await bootWithQD(stateDir)
    try {
      const host = fakeParentAgent()
      const signal = new AbortController().signal
      const result = await env.root.tools.get('dept_head_rotate').execute({ postId, reason: 'C-T2 hermetic test' }, { agent: host, signal })
      assert.equal(result.postId, postId)
      assert.notEqual(result.sessionId, oldSessionId)
      const freshId = result.sessionId

      // The fresh head's seed — from the REAL create (the stub agents service
      // records the mint options; the seed events ride the create call).
      const createCall = env.agents.createCalls.find((c) => String(c.sessionId) === freshId)
      assert.ok(createCall !== undefined, 'the fresh head was created with the seed')
      const seedEvents = createCall.seed ?? []
      assert.equal(seedEvents.length, 5, 'the fresh head seed is the balanced 5-event head seed')
      assert.deepEqual(seedEvents.map((e) => e.type), ['permission/preset', 'sandbox/mode', 'approval/policy', 'user/message', 'session/title'])
      const freshEvents = [
        ...seedEvents.map((e) => JSON.parse(JSON.stringify(e))),
        ev('session/end-seed', 5, now + 10, {})
      ]
      const freshPath = await authorArtifact(sessionsRoot, freshId, freshEvents)

      const authorMap = new Map([
        [oldSessionId, oldHeadPath],
        [freshId, freshPath]
      ])
      const verdict = await verifyRotationBaseline(baselineDepsFor(stateDir, {
        oldId: oldSessionId,
        newId: freshId,
        oldHost: postId,
        newHost: postId, // a head's member id is its stable postId (no host-<id>)
        snapPath: undefined,
        authorMap,
        mode: 'head'
      }))
      assert.deepEqual(verdict.violations, [], `T2 head-mode baseline must be clean: ${JSON.stringify(verdict.violations)}`)
      assert.equal(verdict.ok, true)

      // Negative: a pre-turn notice on the successor breaks the boot-quiet rule.
      const noisyId = freshId + '-noisy'
      const noisy = [
        ...seedEvents.map((e) => JSON.parse(JSON.stringify(e))),
        ev('session/end-seed', 5, now + 10, {}),
        ev('user/message', 6, now + 11, { role: 'user', content: [{ type: 'text', text: '[From deepartments → head-research-head]: unexpected wake' }], source: { kind: 'system' } })
      ]
      const noisyPath = await authorArtifact(sessionsRoot, noisyId, noisy)
      const noisyMap = new Map([
        [oldSessionId, oldHeadPath],
        [noisyId, noisyPath]
      ])
      const negative = await verifyRotationBaseline(baselineDepsFor(stateDir, {
        oldId: oldSessionId,
        newId: noisyId,
        oldHost: postId,
        newHost: postId,
        snapPath: undefined,
        authorMap: noisyMap,
        mode: 'head'
      }))
      assert.ok(codesOf(negative).includes('seed-unbalanced'), `head mode must catch the pre-turn notice: ${JSON.stringify(codesOf(negative))}`)
    } finally {
      await env.dispose()
    }
  })
})

// ===========================================================================
// Block D — T4 discriminator: restart ≠ rotation.
// ===========================================================================

test('D-T4: same session ids (a restart resume) → SKIP {ok:true, skipped}, never a false positive on an artifact that only GROWS contiguously', async () => {
  const { deps } = healthyHostFixture(0)
  const r = await verifyRotationBaseline({
    ...deps,
    oldSessionId: 'session-old',
    newSessionId: 'session-old',
    hostIdOld: 'host-session-old',
    hostIdNew: 'host-session-old'
  })
  assert.equal(r.ok, true)
  assert.equal(r.skipped, 'restart-same-ids')
  assert.deepEqual(r.violations, [])

  // The artifact only GROWED contiguously across the restart: the resumed log
  // continues at seq 11 with NO replay and NO orphan turn — and the assertion
  // STILL skips (no false positive on the growth).
  const grown = [...healthyOldEvents(T0), ev('user/message', 11, T0 + 11, { role: 'user', content: [{ type: 'text', text: 'resume input' }], source: { kind: 'user' } })]
  const b = healthyHostFixture(0)
  const grownDeps = {
    ...b.deps,
    oldSessionId: 'session-old',
    newSessionId: 'session-old',
    hostIdOld: 'host-session-old',
    hostIdNew: 'host-session-old',
    decodeArtifact: async (p) => {
      if (p === '/f/sessions/old.jsonl') return { lines: artifactText('session-old', grown).split('\n'), byteOk: true }
      return b.deps.decodeArtifact(p)
    }
  }
  const grownResult = await verifyRotationBaseline(grownDeps)
  assert.equal(grownResult.ok, true, 'the contiguous growth must not alarm the discriminator')
  assert.equal(grownResult.skipped, 'restart-same-ids')
  assert.ok(grown.every((e, i) => e.seq === i), 'the resumed log stays contiguous')
})

test('D-T4: marker.json lastBootAt AFTER the old retirement (or an old entry with NO retiredAt) → SKIP {ok:true, skipped: restart-after-boot}; a retirement AT/after the boot proceeds', async () => {
  // (a) old entry WITHOUT retiredAt + a marker → skip (restart).
  const b = healthyHostFixture(0)
  const noRetiredAt = hostsFixture('host-session-old', 'session-old', 'host-session-new', 'session-new')
  delete noRetiredAt['host-session-old'].retiredAt
  const r1 = await verifyRotationBaseline({
    ...b.deps,
    markerPath: '/f/marker.json',
    readFileText: async (p) => {
      if (p === '/f/marker.json') return JSON.stringify({ lastBootAt: T0 + 500 })
      if (p === '/f/hosts.json') return JSON.stringify(noRetiredAt, null, 2)
      return b.deps.readFileText(p)
    }
  })
  assert.equal(r1.ok, true)
  assert.equal(r1.skipped, 'restart-after-boot')

  // (b) retiredAt BEFORE the boot → skip.
  const b2 = healthyHostFixture(0)
  const r2 = await verifyRotationBaseline({
    ...b2.deps,
    markerPath: '/f/marker.json',
    readFileText: async (p) => {
      if (p === '/f/marker.json') return JSON.stringify({ lastBootAt: T0 + 3000 })
      return b2.deps.readFileText(p)
    }
  })
  assert.equal(r2.ok, true)
  assert.equal(r2.skipped, 'restart-after-boot')

  // (c) retiredAt AFTER the boot → the invocation PROCEEDS (a real rotation).
  const b3 = healthyHostFixture(0)
  const r3 = await verifyRotationBaseline({
    ...b3.deps,
    markerPath: '/f/marker.json',
    readFileText: async (p) => {
      if (p === '/f/marker.json') return JSON.stringify({ lastBootAt: T0 - 5000 })
      return b3.deps.readFileText(p)
    }
  })
  assert.equal(r3.skipped, undefined)
  assert.equal(r3.ok, true, 'the healthy fixture still passes when the marker says the boot preceded the retirement')
})