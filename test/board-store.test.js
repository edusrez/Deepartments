// dsh-deepartments — board-file persistence tests.
//
// Rule 5 (AGENTS.md): tests go through the REAL Cordis Loader with the REAL
// dsh services (the harness's own recipe: cordis-plugin-loader + the service
// packages the plugin injects — sessions, sessionProjections, tools[+its
// systemPrompt inject]). Hermetic: temp stateDirs, no network, no live
// DSH_HOME. Tests run against the compiled lib/ (pnpm build first).
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId } from '@deepseek-ai/dsh-session'
import { appendRecord, loadRecords, resolveBoardPath } from '../lib/board-store.js'
import {
  applyRoomEvent,
  foldRoomRecord,
  foldRoomRecords,
  initRoomState,
  roomSessionId
} from '../lib/org.js'

const TEST_ROOMS = [
  { id: 'board', name: 'Board of directors', purpose: 'Coordination room of department heads', members: ['asistente', 'research-head'] },
  { id: 'research', name: 'Research department', purpose: 'Research department room', members: ['research-head'] }
]

// --- record factories (the same wire shape the emit sites produce) ----------

function messageRecord(seq, text, overrides = {}) {
  return {
    id: `m-${seq}`,
    seq,
    ts: 1700000000000 + seq,
    from: 'research-head',
    to: ['asistente'],
    cc: [],
    threadId: null,
    kind: 'message',
    payload: { kind: 'note', text },
    ...overrides
  }
}

function agendaRecord(seq, title, overrides = {}) {
  return {
    id: `agenda-${seq}`,
    seq,
    ts: 1700000000000 + seq,
    from: 'asistente',
    to: [],
    cc: [],
    threadId: null,
    kind: 'agenda',
    payload: { title, owner: 'research-head', status: 'submitted', cursorOfLastTouch: seq },
    ...overrides
  }
}

function readyRecord(seq, roomId, overrides = {}) {
  const room = TEST_ROOMS.find((candidate) => candidate.id === roomId) ?? TEST_ROOMS[0]
  return {
    id: `ready-${roomId}-${seq}`,
    seq,
    ts: 1700000000000 + seq,
    from: 'system',
    to: [...room.members],
    cc: [],
    threadId: null,
    kind: 'ready',
    payload: { room: { id: room.id, name: room.name, purpose: room.purpose, members: [...room.members] } },
    ...overrides
  }
}

// --- real-Loader boot harness ------------------------------------------------

/**
 * Boot the REAL Cordis Loader with the REAL services the plugin injects
 * (sessions, sessionProjections, tools — tools injects systemPrompt) plus the
 * dsh-deepartments bundle itself, resolved as a module by the loader.
 */
async function bootPlugin(stateDir) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  loader.create({
    id: 'deepartments',
    name: '../lib/index.js',
    config: {
      stateDir,
      org: { rooms: TEST_ROOMS, departments: [] }
    }
  })
  await loader.await()
  return {
    root,
    // Disposing the Loader's fiber tears down the whole entry tree
    // (its child fibers) and unloads the plugin.
    dispose: () => loaderFiber.dispose()
  }
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
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-test-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

// --- tests -------------------------------------------------------------------

test('boot through the real Loader: rooms instantiated, board.jsonl created per room, room-ready record mirrored with the expected shape', async () => {
  await withTempStateDir(async (stateDir) => {
    const { root, dispose } = await bootPlugin(stateDir)
    try {
      // The room boot effect is async: poll until every room's board file
      // carries its room-ready record.
      await waitFor(async () => {
        for (const room of TEST_ROOMS) {
          const records = await loadRecords(resolveBoardPath(stateDir, room.id))
          if (records.length !== 1) return false
        }
        return true
      }, 5000, 'board files with one room-ready record each')

      for (const room of TEST_ROOMS) {
        const session = root.sessions.get(SessionId(roomSessionId(room.id)))
        assert.ok(session, `room session live for ${room.id}`)

        const [record] = await loadRecords(resolveBoardPath(stateDir, room.id))
        assert.equal(record.kind, 'ready')
        assert.equal(record.id, `ready-${room.id}-0`)
        assert.equal(record.seq, 0)
        assert.equal(typeof record.ts, 'number')
        assert.equal(record.from, 'system')
        assert.deepEqual(record.to, room.members)
        assert.deepEqual(record.cc, [])
        assert.equal(record.threadId, null)
        assert.deepEqual(record.payload, {
          room: { id: room.id, name: room.name, purpose: room.purpose, members: room.members }
        })

        // The mirror: the SAME record rides the live session log.
        const mirrored = session.events
          .filter((event) => event.type === 'deepartments/room-ready')
          .map((event) => event.data)
        assert.equal(mirrored.length, 1, `one room-ready event in the ${room.id} session log`)
        assert.deepEqual(mirrored[0], record)
      }
    } finally {
      await dispose()
    }
  })
})

test('pure fold: deterministic, and same-reference no-op on irrelevant input', () => {
  const records = [messageRecord(0, 'first'), agendaRecord(1, 'plan the sprint'), readyRecord(2, 'board')]
  const stateA = foldRoomRecords(records)
  const stateB = foldRoomRecords(records)
  assert.deepEqual(stateA, stateB, 'folding the same records twice yields the same state')
  assert.notEqual(stateA, stateB, 'each fold returns a fresh state object')

  assert.equal(stateA.messages.length, 1)
  assert.deepEqual(stateA.messages[0], {
    id: 'm-0',
    seq: 0,
    ts: 1700000000000,
    from: 'research-head',
    to: ['asistente'],
    cc: [],
    threadId: null,
    kind: 'note',
    text: 'first'
  })
  assert.deepEqual(stateA.cursors, { 'research-head': 'm-0' }, 'writer cursor advances on message append')
  assert.equal(stateA.agenda.length, 1)
  assert.equal(stateA.agenda[0].cursorOfLastTouch, 1, 'cursorOfLastTouch references the FILE seq')

  // Same-ref no-op: ready records and unrelated input must not allocate.
  const base = initRoomState()
  assert.equal(foldRoomRecord(base, readyRecord(0, 'board')), base)
  assert.equal(foldRoomRecord(base, { ...messageRecord(0, 'x'), kind: 'not-a-kind' }), base)
  assert.equal(applyRoomEvent(base, { type: 'turn/end', seq: 9, time: 1, data: {} }), base)
  assert.equal(applyRoomEvent(base, { type: 'deepartments/room-ready', seq: 0, time: 1, data: readyRecord(0, 'board') }), base)
})

test('cold restart: a pre-seeded board file folds into the projection; new live events fold on top without duplication', async () => {
  await withTempStateDir(async (stateDir) => {
    const boardPath = resolveBoardPath(stateDir, 'board')
    // Simulate a previous boot's history through the store API.
    await appendRecord(boardPath, messageRecord(0, 'boot1-message'))
    await appendRecord(boardPath, agendaRecord(1, 'boot1-agenda'))
    await appendRecord(boardPath, readyRecord(2, 'board'))

    const { root, dispose } = await bootPlugin(stateDir)
    try {
      const sessionId = SessionId(roomSessionId('board'))
      await waitFor(() => root.sessions.get(sessionId) !== undefined, 5000, 'board session instantiated')
      const session = root.sessions.get(sessionId)
      const snapshot = () => root.sessionProjections.snapshot(session).values['deepartments/room']

      // The projection view is initialized from the FILE: previous boot's
      // records are present exactly once (anti-double-count).
      const state = snapshot()
      assert.equal(state.messages.length, 1, 'file folded once — no duplication')
      assert.equal(state.messages[0].text, 'boot1-message')
      assert.deepEqual(state.cursors, { 'research-head': 'm-0' })
      assert.equal(state.agenda.length, 1)
      assert.equal(state.agenda[0].title, 'boot1-agenda')
      assert.equal(state.agenda[0].cursorOfLastTouch, 1, 'cursor references the file seq of the touching record')

      // A new live event folds on top (apply path), without re-folding the file.
      session.append('deepartments/room-message', messageRecord(4, 'live-message'))
      const after = snapshot()
      assert.equal(after.messages.length, 2)
      assert.equal(after.messages[1].text, 'live-message')
      assert.deepEqual(after.cursors, { 'research-head': 'm-4' })

      // Batch D (ready single-once): the file ALREADY holds a ready record for
      // this room, so THIS boot appends NO new ready marker — the board file is
      // left at the pre-seeded 3 records (no ~41% ready boot noise accumulates).
      await waitFor(async () => (await loadRecords(boardPath)).length === 3, 5000, 'board file stays at 3 records after a cold restart')
      const records = await loadRecords(boardPath)
      assert.equal(records[0].kind, 'message')
      assert.equal(records[1].kind, 'agenda')
      assert.equal(records[2].kind, 'ready')
      assert.equal(records[2].seq, 2)
      assert.equal(records.length, 3, 'no second ready record re-emitted on a restarted room')
    } finally {
      await dispose()
    }
  })
})
