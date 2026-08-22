// dsh-deepartments — `/deepartments` RPC channel tests (server half).
//
// Cover the PURE extraction of the channel (the rc.8 transport fix): the
// endpoint dispatcher (dispatchDeepartmentsEndpoint), the client-request
// envelope validator (parseClientEnvelope), and the request-authority trust
// fence (isTrustedHostFact + its loopback/authority primitives). All of these
// are exported from src/invoke.ts with no node:http imports, so they are
// directly unit-testable — the same pattern as agents-status.test.js testing
// buildAgentRows.
//
// U1 (custom-sidebar removal): the `ui/config` (+`set`) endpoints and their
// tests were removed with the sidebar; the dispatcher now serves `agents`/`list`
// (the kept client roster heartbeat) plus `host/status` (U3 — the client
// lifecycle watcher's rotation signal, spec 002 §6.1).
//
// Tests run against the compiled lib/ (pnpm build first), same as the other
// suite files.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dispatchDeepartmentsEndpoint,
  isLoopbackHostname,
  isTrustedAuthority,
  isTrustedHostFact,
  parseAuthority,
  parseClientEnvelope
} from '../lib/invoke.js'

// --- department configs (two configured heads, mirroring cordis.patch.yml) ---

const RESEARCH = {
  id: 'research',
  name: 'Research',
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
  name: 'Internal Programming',
  roomId: 'programming',
  coordinator: {
    postId: 'programming-head',
    title: 'Head of Internal Programming',
    role: 'Internal Programming department head',
    provider: 'opencode-go',
    agentOptions: { provider: 'opencode-go', model: 'deepseek-v4-flash' }
  }
}

const DEPARTMENTS = [RESEARCH, PROGRAMMING]

// --- in-memory deps (mirrors what applyInvoke wires to the live registries) --
function makeDeps(overrides = {}) {
  return {
    departments: DEPARTMENTS,
    byPost: new Map(),
    hosts: [],
    memberCursors: new Map(),
    sessionLive: () => false,
    sessionRunning: () => false,
    loadBoardRecords: async () => undefined,
    ...overrides
  }
}

// --- dispatchDeepartmentsEndpoint -------------------------------------------

test('dispatchDeepartmentsEndpoint: agents builds one row per configured head', async () => {
  const byPost = new Map([
    ['research-head', { postId: 'research-head', sessionId: 'head-research-head', roomId: 'research' }]
  ])
  const deps = makeDeps({ byPost, sessionLive: (sid) => sid === 'head-research-head' })
  const result = await dispatchDeepartmentsEndpoint('agents', { sessionId: 'host-x' }, deps)
  assert.equal(result.ok, true)
  const value = result.ok ? result.value : null
  assert.equal(value.host.id, 'asistente')
  assert.equal(value.agents.length, 2) // one per configured department
  const ids = value.agents.map((row) => row.id)
  assert.deepEqual(ids, ['research-head', 'programming-head'])
  // Batch 4a: every row exposes the head's OPENABLE session id — the live head
  // from its registry entry, a never-spawned configured head deterministically
  // (`head-<postId>`). id stays the postId, name the title.
  const sessionIds = Object.fromEntries(value.agents.map((row) => [row.id, row.sessionId]))
  assert.equal(sessionIds['research-head'], 'head-research-head')
  assert.equal(sessionIds['programming-head'], 'head-programming-head')
  const research = value.agents.find((row) => row.id === 'research-head')
  assert.equal(research.name, 'Head of Research')
  assert.equal(research.id, 'research-head')
  // A configured head that has never been spawned stays idle.
  const programming = value.agents.find((row) => row.id === 'programming-head')
  assert.equal(programming.status, 'idle')
  assert.equal(programming.sessionLive, false)
})

test('dispatchDeepartmentsEndpoint: list is an alias of agents', async () => {
  const deps = makeDeps()
  const [agents, list] = await Promise.all([
    dispatchDeepartmentsEndpoint('agents', {}, deps),
    dispatchDeepartmentsEndpoint('list', {}, deps)
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(list)), JSON.parse(JSON.stringify(agents)))
})

test('dispatchDeepartmentsEndpoint: unknown endpoint is a bad-request', async () => {
  const deps = makeDeps()
  const result = await dispatchDeepartmentsEndpoint('nope', {}, deps)
  assert.equal(result.ok, false)
  assert.equal(result.ok || result.error.code, 'bad-request')
  assert.match(result.ok ? '' : result.error.message, /unknown endpoint: nope/)
})

test('dispatchDeepartmentsEndpoint: unreadFor counts addressed unread non-ack messages', async () => {
  const byPost = new Map([
    ['research-head', { postId: 'research-head', sessionId: 'head-research-head', roomId: 'research' }]
  ])
  const boardRecords = [
    // seq 1 from research-head to the caller host, not ack, unread (cursor -1)
    { seq: 1, from: 'research-head', to: ['host-x'], kind: 'message', payload: { kind: 'note', text: 'hi' } },
    // seq 2 ack — skipped
    { seq: 2, from: 'research-head', to: ['host-x'], kind: 'message', payload: { kind: 'note', text: 'ok', ack: true } },
    // seq 3 addressed to a DIFFERENT member — skipped
    { seq: 3, from: 'research-head', to: ['host-y'], kind: 'message', payload: { kind: 'note', text: 'no' } },
    // seq 4 kind not message — skipped
    { seq: 4, from: 'research-head', to: ['host-x'], kind: 'ready', payload: { title: 'x' } }
  ]
  const deps = makeDeps({
    byPost,
    hosts: [{ hostId: 'host-x', sessionId: 'sess-x', roomId: 'board' }],
    loadBoardRecords: async () => boardRecords,
    sessionLive: (sid) => sid === 'head-research-head'
  })
  const result = await dispatchDeepartmentsEndpoint('agents', { sessionId: 'sess-x' }, deps)
  assert.equal(result.ok, true)
  const row = result.ok ? result.value.agents.find((r) => r.id === 'research-head') : null
  assert.equal(row.unread, 1)
  assert.equal(row.status, 'completed-notice')
})

test('dispatchDeepartmentsEndpoint: unknown caller session gets zero unread', async () => {
  const byPost = new Map([
    ['research-head', { postId: 'research-head', sessionId: 'head-research-head', roomId: 'research' }]
  ])
  const records = [
    { seq: 1, from: 'research-head', to: ['host-x'], kind: 'message', payload: { kind: 'note', text: 'hi' } }
  ]
  // Caller session "nope" is not in hosts → hostMemberId undefined → unread 0.
  const deps = makeDeps({
    byPost,
    hosts: [{ hostId: 'host-x', sessionId: 'sess-x', roomId: 'board' }],
    loadBoardRecords: async () => records
  })
  const result = await dispatchDeepartmentsEndpoint('agents', { sessionId: 'nope' }, deps)
  assert.equal(result.ok, true)
  const row = result.ok ? result.value.agents.find((r) => r.id === 'research-head') : null
  assert.equal(row.unread, 0)
})

// --- host/status (U3 client lifecycle watcher RPC, spec 002 §6.1) ------------

test('dispatchDeepartmentsEndpoint: host/status reports the live host + retired entries', async () => {
  const deps = makeDeps({
    // Post-rotation hosts.json shape (U2, D4): old entry retired (stays in the
    // file as evidence), new live entry carries previousSessionId.
    hosts: [
      { hostId: 'host-sess-old', sessionId: 'sess-old', roomId: 'board', retired: true, retiredAt: 1787337794152, rotatedTo: 'host-sess-new' },
      { hostId: 'host-sess-new', sessionId: 'sess-new', roomId: 'board', previousSessionId: 'sess-old' }
    ],
    loadHostWakeCounter: async () => 7
  })
  const result = await dispatchDeepartmentsEndpoint('host/status', {}, deps)
  assert.equal(result.ok, true)
  const value = result.ok ? result.value : null
  assert.equal(value.hostSessionId, 'sess-new')
  assert.equal(value.previousSessionId, 'sess-old')
  assert.deepEqual(value.retired, [{ sessionId: 'sess-old', retiredAt: 1787337794152 }])
  assert.equal(value.wakeCounter, 7)
})

test('dispatchDeepartmentsEndpoint: host/status with no registered host → null live + empty retired', async () => {
  const result = await dispatchDeepartmentsEndpoint('host/status', {}, makeDeps())
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok ? result.value : null, { hostSessionId: null, previousSessionId: null, retired: [] })
})

test('dispatchDeepartmentsEndpoint: host/status omits wakeCounter when the dep is absent or fails', async () => {
  // No loadHostWakeCounter dep → the field is absent (payload minimal/stable).
  const noDep = await dispatchDeepartmentsEndpoint('host/status', {}, makeDeps({
    hosts: [{ hostId: 'host-x', sessionId: 'sess-x', roomId: 'board' }]
  }))
  assert.equal(noDep.ok, true)
  assert.equal(noDep.ok ? noDep.value.hostSessionId : null, 'sess-x')
  assert.equal('wakeCounter' in (noDep.ok ? noDep.value : {}), false)
  // A failing read → field absent, dispatcher NEVER throws.
  const failing = await dispatchDeepartmentsEndpoint('host/status', {}, makeDeps({
    hosts: [{ hostId: 'host-x', sessionId: 'sess-x', roomId: 'board' }],
    loadHostWakeCounter: async () => { throw new Error('no journal') }
  }))
  assert.equal(failing.ok, true)
  assert.equal('wakeCounter' in (failing.ok ? failing.value : {}), false)
})

test('dispatchDeepartmentsEndpoint: host/status with only retired entries → null live + retired list', async () => {
  const result = await dispatchDeepartmentsEndpoint('host/status', {}, makeDeps({
    hosts: [
      { hostId: 'host-sess-a', sessionId: 'sess-a', roomId: 'board', retired: true, retiredAt: 1, rotatedTo: 'host-sess-b' },
      { hostId: 'host-sess-b', sessionId: 'sess-b', roomId: 'board', retired: true, retiredAt: 2, rotatedTo: 'host-sess-c' }
    ]
  }))
  assert.equal(result.ok, true)
  const value = result.ok ? result.value : null
  assert.equal(value.hostSessionId, null)
  assert.equal(value.previousSessionId, null)
  assert.deepEqual(value.retired, [
    { sessionId: 'sess-a', retiredAt: 1 },
    { sessionId: 'sess-b', retiredAt: 2 }
  ])
})

// --- parseClientEnvelope -----------------------------------------------------

test('parseClientEnvelope: accepts a well-formed client-request', () => {
  const parsed = parseClientEnvelope({ type: 'client-request', rpcId: 'abc', method: 'agents', payload: { sessionId: 'x' } })
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.message.rpcId, 'abc')
    assert.equal(parsed.message.method, 'agents')
    assert.deepEqual(parsed.message.payload, { sessionId: 'x' })
  }
})

test('parseClientEnvelope: rejects missing type / rpcId / method', () => {
  for (const body of [
    null,
    { rpcId: 'abc', method: 'agents' }, // no type
    { type: 'client-request', method: 'agents' }, // no rpcId
    { type: 'client-request', rpcId: 'abc' }, // no method
    { type: 'server-response', rpcId: 'abc', method: 'agents' } // wrong type
  ]) {
    const parsed = parseClientEnvelope(body)
    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.ok(parsed.issues.length > 0)
  }
})

// --- authority / trust fence -------------------------------------------------

test('isLoopbackHostname classifies loopback forms', () => {
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('127.255.0.7'), true)
  assert.equal(isLoopbackHostname('128.0.0.1'), false)
  assert.equal(isLoopbackHostname('laagencia.taildb5a7a.ts.net'), false)
  assert.equal(isLoopbackHostname('example.com'), false)
})

test('parseAuthority + isTrustedAuthority match exact host:port', () => {
  const trusted = ['laagencia.taildb5a7a.ts.net:8445']
  const url = parseAuthority('laagencia.taildb5a7a.ts.net:8445')
  assert.ok(url)
  assert.equal(isTrustedAuthority(url, trusted), true)
  // Different port does NOT match an exact port entry.
  assert.equal(isTrustedAuthority(parseAuthority('laagencia.taildb5a7a.ts.net:9999'), trusted), false)
  // A port-less trusted entry matches the hostname on any port.
  assert.equal(isTrustedAuthority(parseAuthority('harness.internal:8080'), ['harness.internal']), true)
})

test('isTrustedHostFact: loopback always accepted (unless cross-site/origin)', () => {
  assert.equal(isTrustedHostFact({ host: '127.0.0.1:3090' }, []), true)
  assert.equal(isTrustedHostFact({ host: 'localhost:3090' }, []), true)
  // A cross-site fetch to loopback is refused (DNS-rebinding defense).
  assert.equal(isTrustedHostFact({ host: '127.0.0.1:3090', secFetchSite: 'cross-site' }, []), false)
  // A cross-origin page is refused.
  assert.equal(isTrustedHostFact({ host: '127.0.0.1:3090', origin: 'https://evil.example' }, []), false)
  // Same-origin is fine.
  assert.equal(isTrustedHostFact({ host: '127.0.0.1:3090', origin: 'http://127.0.0.1:3090' }, []), true)
})

test('isTrustedHostFact: non-loopback denied without a trusted host', () => {
  assert.equal(isTrustedHostFact({ host: 'laagencia.taildb5a7a.ts.net:8445' }, []), false)
  assert.equal(isTrustedHostFact({ host: 'laagencia.taildb5a7a.ts.net:8445' }, ['laagencia.taildb5a7a.ts.net:8445']), true)
  // Wrong port against an exact entry.
  assert.equal(isTrustedHostFact({ host: 'laagencia.taildb5a7a.ts.net:8444' }, ['laagencia.taildb5a7a.ts.net:8445']), false)
  // Missing host header is refused.
  assert.equal(isTrustedHostFact({}, ['laagencia.taildb5a7a.ts.net:8445']), false)
})
