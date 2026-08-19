// dsh-deepartments — pure agent-row status tests for the "main agents sidebar"
// server half. Covers the pure computation module src/agents.ts (compiled to
// lib/agents.js): the status precedence and row-building fallbacks. These are
// PURE unit tests — no Loader, no DSH services, no I/O — because buildAgentRows
// / computeHeadStatus have no side effects and receive live signals injected
// as functions.
//
// Tests run against the compiled lib/ (pnpm build first), same as the other
// suite files.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAgentRows, computeHeadStatus } from '../lib/agents.js'

// --- department configs mirroring cordis.patch.yml ---------------------------

const RESEARCH = {
  id: 'research',
  name: 'Research Department',
  roomId: 'research',
  coordinator: {
    postId: 'research-head',
    title: 'Head of Research',
    role: 'Research department head',
    provider: 'opencode-go',
    agentOptions: { provider: 'opencode-go', model: 'deepseek-v4-flash' }
  }
}

const PROGRAMMING = {
  id: 'programming',
  name: 'Internal Programming Department',
  roomId: 'programming',
  coordinator: {
    postId: 'programming-head',
    title: 'Head of Internal Programming',
    role: 'Internal Programming department head',
    provider: 'opencode-go',
    agentOptions: { provider: 'opencode-go', model: 'deepseek-v4-flash' }
  }
}

// A coordinator with no display title and no role (must fall back to postId).
const NO_TITLE = {
  id: 'plain',
  name: 'Plain department',
  roomId: 'plain',
  coordinator: { postId: 'plain-head', role: 'Plain department head', provider: 'opencode-go' }
}

/** Minimal PostEntry-like fixture for lib/agents.js' PostEntryLike shape. */
function post(overrides = {}) {
  return {
    postId: 'research-head',
    childId: 'child-research',
    parentId: 'parent-research',
    roomId: 'research',
    provider: 'opencode-go',
    ...overrides
  }
}

// --- computeHeadStatus: full precedence --------------------------------------

test('computeHeadStatus: sleeping wins over all', () => {
  assert.equal(computeHeadStatus({ sleeping: true, unread: 5, running: true, parentLive: true }), 'sleeping')
  assert.equal(computeHeadStatus({ sleeping: true, unread: 0, running: false, parentLive: false }), 'sleeping')
})

test('computeHeadStatus: unread (completed-notice) beats running', () => {
  assert.equal(computeHeadStatus({ sleeping: false, unread: 1, running: true, parentLive: true }), 'completed-notice')
  assert.equal(computeHeadStatus({ sleeping: false, unread: 2, running: false, parentLive: true }), 'completed-notice')
})

test('computeHeadStatus: running (working) beats idle nap', () => {
  assert.equal(computeHeadStatus({ sleeping: false, unread: 0, running: true, parentLive: true }), 'working')
})

test('computeHeadStatus: parent-not-live falls back to napping', () => {
  assert.equal(computeHeadStatus({ sleeping: false, unread: 0, running: false, parentLive: false }), 'napping')
})

test('computeHeadStatus: live idle head with no unread is napping', () => {
  assert.equal(computeHeadStatus({ sleeping: false, unread: 0, running: false, parentLive: true }), 'napping')
})

// --- buildAgentRows: missing post entry --------------------------------------

test('buildAgentRows: missing post entry emits napping row with no signals', () => {
  const rows = buildAgentRows({
    departments: [RESEARCH],
    posts: new Map(),
    agentRunning: () => false,
    parentLive: () => false,
    unreadFor: () => 0
  })
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    id: 'research-head',
    name: 'Head of Research',
    department: 'Research Department',
    kind: 'post',
    status: 'napping',
    unread: 0,
    running: false,
    sleeping: false,
    parentLive: false
  })
})

// --- buildAgentRows: display-name fallback -----------------------------------

test('buildAgentRows: name falls back title → role → postId', () => {
  // Title wins.
  const byTitle = buildAgentRows({
    departments: [RESEARCH],
    posts: new Map(),
    agentRunning: () => false,
    parentLive: () => false,
    unreadFor: () => 0
  })
  assert.equal(byTitle[0].name, 'Head of Research')

  // Role (no title) wins next.
  const byRole = buildAgentRows({
    departments: [{ ...NO_TITLE, coordinator: { ...NO_TITLE.coordinator, title: undefined } }],
    posts: new Map([[NO_TITLE.coordinator.postId, post({ postId: NO_TITLE.coordinator.postId })]]),
    agentRunning: () => false,
    parentLive: () => false,
    unreadFor: () => 0
  })
  assert.equal(byRole[0].name, 'Plain department head')

  // Neither title nor role → fall back to postId.
  const byPostId = buildAgentRows({
    departments: [{ ...NO_TITLE, coordinator: { postId: 'plain-head', role: undefined, provider: 'opencode-go' } }],
    posts: new Map(),
    agentRunning: () => false,
    parentLive: () => false,
    unreadFor: () => 0
  })
  assert.equal(byPostId[0].name, 'plain-head')
})

test('buildAgentRows: department with no coordinator is skipped', () => {
  const rows = buildAgentRows({
    departments: [RESEARCH, { id: 'ghost', name: 'Ghost', roomId: 'ghost', coordinator: undefined }],
    posts: new Map(),
    agentRunning: () => false,
    parentLive: () => false,
    unreadFor: () => 0
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'research-head')
})

// --- buildAgentRows: live running head, unread/status mapping ----------------

test('buildAgentRows: live running head maps running + parentLive + unread', () => {
  const rows = buildAgentRows({
    departments: [RESEARCH],
    posts: new Map([[RESEARCH.coordinator.postId, post()]]),
    agentRunning: (childId) => childId === 'child-research',
    parentLive: (parentId) => parentId === 'parent-research',
    unreadFor: (postId) => (postId === 'research-head' ? 3 : 0)
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].running, true)
  assert.equal(rows[0].parentLive, true)
  assert.equal(rows[0].unread, 3)
  assert.equal(rows[0].status, 'completed-notice') // unread > 0 beats running
})

test('buildAgentRows: running with zero unread is working', () => {
  const rows = buildAgentRows({
    departments: [RESEARCH],
    posts: new Map([[RESEARCH.coordinator.postId, post()]]),
    agentRunning: () => true,
    parentLive: () => true,
    unreadFor: () => 0
  })
  assert.equal(rows[0].status, 'working')
})

test('buildAgentRows: sleeping head (sleepEpoch set) is sleeping regardless of signals', () => {
  const rows = buildAgentRows({
    departments: [RESEARCH],
    posts: new Map([[RESEARCH.coordinator.postId, post({ sleepEpoch: 123, previousChildId: 'old-child' })]]),
    agentRunning: () => true,
    parentLive: () => true,
    unreadFor: () => 5
  })
  assert.equal(rows[0].sleeping, true)
  assert.equal(rows[0].status, 'sleeping')
})

test('buildAgentRows: order follows department config order', () => {
  const rows = buildAgentRows({
    departments: [PROGRAMMING, RESEARCH],
    posts: new Map(),
    agentRunning: () => false,
    parentLive: () => false,
    unreadFor: () => 0
  })
  assert.deepEqual(rows.map((row) => row.id), ['programming-head', 'research-head'])
  assert.equal(rows[0].department, 'Internal Programming Department')
})
