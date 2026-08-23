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
  parseClientEnvelope,
  pickLiveHostEntry
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
    provider: 'opencode-zen',
    agentOptions: { provider: 'opencode-zen', model: 'deepseek-v4-flash-vision-exp' }
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
    provider: 'opencode-zen',
    agentOptions: { provider: 'opencode-zen', model: 'deepseek-v4-flash-vision-exp' }
  }
}

const DEPARTMENTS = [RESEARCH, PROGRAMMING]

// --- in-memory deps (mirrors what applyInvoke wires to the live registries) --
function makeDeps(overrides = {}) {
  return {
    departments: DEPARTMENTS,
    byPost: new Map(),
    hosts: [],
    sessionLive: () => false,
    sessionRunning: () => false,
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

test('dispatchDeepartmentsEndpoint (B3): unread derivation is KILLED — rows carry unread 0 (no board cursor; no read/seen marks in the messaging phase, spec 003 §5)', async () => {
  const byPost = new Map([
    ['research-head', { postId: 'research-head', sessionId: 'head-research-head', roomId: 'research' }]
  ])
  const deps = makeDeps({
    byPost,
    hosts: [{ hostId: 'host-x', sessionId: 'sess-x', roomId: 'board' }],
    sessionLive: (sid) => sid === 'head-research-head'
  })
  const result = await dispatchDeepartmentsEndpoint('agents', { sessionId: 'sess-x' }, deps)
  assert.equal(result.ok, true)
  const row = result.ok ? result.value.agents.find((r) => r.id === 'research-head') : null
  assert.equal(row.unread, 0, 'B3: unread is a stable 0 (no board derivation)')
  assert.notEqual(row.status, 'completed-notice', 'B3: the completed-notice status branch never fires (no unread)')
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

// --- deterministic live-host selection (U3 fix, post-mortem finding #2) ------
//
// The pre-fix buildHostStatusPayload picked the FIRST non-retired host entry
// in Map iteration order; after a rotation that returned a STALE live entry
// (the dead bare `host-1a4af1ea`) instead of the rotation successor
// (`1122cd45`, the entry carrying `previousSessionId`) — the wake-12→13
// incident. pickLiveHostEntry makes the selection deterministic: successsor →
// single-live → (ambiguity fallback) first-in-order + warn.

test('pickLiveHostEntry + host/status: the rotation successor (previousSessionId) wins over a stale bare entry', async () => {
  // The incident's hosts.json live-entry shape (post-rotation Map order):
  // retired cf5225e4 first, then the STALE bare 1a4af1ea, then 1122cd45 with
  // previousSessionId. The OLD pick returned 1a4af1ea; the fix MUST report
  // 1122cd45.
  const hosts = [
    { hostId: 'host-session-cf5225e4', sessionId: 'session-cf5225e4', roomId: 'board', retired: true, retiredAt: 1787410322000, rotatedTo: 'host-1122cd45' },
    { hostId: 'host-1a4af1ea-5363-4cbd-b0ea-7c2b1812d662', sessionId: '1a4af1ea-5363-4cbd-b0ea-7c2b1812d662', roomId: 'board' },
    { hostId: 'host-1122cd45', sessionId: 'session-1122cd45', roomId: 'board', previousSessionId: 'session-cf5225e4' }
  ]
  const picked = pickLiveHostEntry(hosts)
  assert.equal(picked.live?.sessionId, 'session-1122cd45')
  assert.equal(picked.ambiguous, false, 'successor branch is not ambiguous')
  let warns = 0
  const deps = makeDeps({
    hosts,
    logger: { warn: () => { warns += 1 } },
    loadHostWakeCounter: async () => 13
  })
  const result = await dispatchDeepartmentsEndpoint('host/status', {}, deps)
  assert.equal(result.ok, true)
  const value = result.ok ? result.value : null
  assert.equal(value.hostSessionId, 'session-1122cd45') // NOT 1a4af1ea
  assert.equal(value.previousSessionId, 'session-cf5225e4')
  assert.deepEqual(value.retired, [{ sessionId: 'session-cf5225e4', retiredAt: 1787410322000 }])
  assert.equal(value.wakeCounter, 13)
  assert.equal(warns, 0, 'successor selection fires NO ambiguity warn')
})

test('pickLiveHostEntry + host/status: a single live entry is picked WITHOUT an ambiguity warn', async () => {
  const hosts = [{ hostId: 'host-x', sessionId: 'sess-x', roomId: 'board' }]
  const picked = pickLiveHostEntry(hosts)
  assert.equal(picked.live?.sessionId, 'sess-x')
  assert.equal(picked.ambiguous, false)
  let warned = false
  const deps = makeDeps({
    hosts,
    logger: { warn: () => { warned = true } }
  })
  const result = await dispatchDeepartmentsEndpoint('host/status', {}, deps)
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.value.hostSessionId : null, 'sess-x')
  // Regression (d): the single-live branch must NOT fire the ambiguity warn.
  assert.equal(warned, false)
})

test('pickLiveHostEntry: all entries retired → no live entry (payload covered by the all-retired dispatcher test above)', () => {
  const picked = pickLiveHostEntry([
    { hostId: 'host-sess-a', sessionId: 'sess-a', roomId: 'board', retired: true, retiredAt: 1, rotatedTo: 'host-sess-b' },
    { hostId: 'host-sess-b', sessionId: 'sess-b', roomId: 'board', retired: true, retiredAt: 2, rotatedTo: 'host-sess-c' }
  ])
  assert.equal(picked.live, undefined)
  assert.equal(picked.ambiguous, false)
})

test('pickLiveHostEntry + host/status: multiple BARE live entries → first in order + ambiguity warn listing the candidates', async () => {
  // Drift shape (post-mortem #2): two live entries, NEITHER a rotation
  // successor. Deterministic fallback = first in insertion order; the payload
  // must ALSO warn with the ambiguous candidates (owner cleans the live state).
  const hosts = [
    { hostId: 'host-a', sessionId: 'sess-a', roomId: 'board' },
    { hostId: 'host-b', sessionId: 'sess-b', roomId: 'board' }
  ]
  const picked = pickLiveHostEntry(hosts)
  assert.equal(picked.live?.sessionId, 'sess-a')
  assert.equal(picked.ambiguous, true, 'two bare live entries are ambiguous')
  const messages = []
  const deps = makeDeps({
    hosts,
    logger: { warn: (message) => { messages.push(message) } }
  })
  const result = await dispatchDeepartmentsEndpoint('host/status', {}, deps)
  assert.equal(result.ok, true)
  const value = result.ok ? result.value : null
  assert.equal(value.hostSessionId, 'sess-a')
  assert.equal(value.previousSessionId, null)
  assert.equal(messages.length, 1)
  assert.match(messages[0], /host-a \(sessionId=sess-a\)/)
  assert.match(messages[0], /host-b \(sessionId=sess-b\)/)
})

// --- production wiring regression: a Map .values() iterator is SINGLE-USE ----
//
// Production wires `deps.hosts` as ONE shared `hosts.values()` (applyInvoke,
// endpointDeps — reviewer FAIL 2026-08-22): a Map iterator is one-shot, so the
// new buildHostStatusPayload's up-to-3× iteration (pick → candidates spread →
// retired loop) plus the agents/list host resolution starve it — the FIRST
// call degraded `retired` to [], and from the SECOND call onward
// hostSessionId was null (the client watcher's rotation signal died after the
// first 5s poll). Every test above wires plain ARRAYS (re-iterable), so none
// can see it. This test wires the REAL production shape — a live Map
// `.values()` iterator — and asserts the wire (now a fresh-iterator-per-
// `[Symbol.iterator]` view) stays re-iterable across repeated host/status +
// agents/list calls.

test('dispatchDeepartmentsEndpoint: a real Map .values() wire stays re-iterable across repeated host/status + agents/list calls', async () => {
  // Production host registry shape (Map<string, HostEntry>, applyInvoke:1377):
  // after a rotation the OLD entry stays retired (evidence) and the LIVE entry
  // carries previousSessionId.
  const hosts = new Map([
    ['host-sess-old', { hostId: 'host-sess-old', sessionId: 'sess-old', roomId: 'board', retired: true, retiredAt: 1787337794152, rotatedTo: 'host-sess-new' }],
    ['host-sess-new', { hostId: 'host-sess-new', sessionId: 'sess-new', roomId: 'board', previousSessionId: 'sess-old' }]
  ])
  let warns = 0
  const deps = makeDeps({
    // The FIXED production wire (verbatim src/invoke.ts:4701): a wrapper whose
    // `[Symbol.iterator]` hands out a FRESH MapIterator per call over the SAME
    // live Map — NOT an array (arrays are trivially re-iterable, which is why
    // the all-array suite could not catch the bug). Wiring the raw one-shot
    // `hosts.values()` here would reproduce the reviewer's FAIL (CALL1 retired
    // degraded to []), not pin the fix.
    hosts: { [Symbol.iterator]: () => hosts.values() },
    byPost: new Map([
      ['research-head', { postId: 'research-head', sessionId: 'head-research-head', roomId: 'research' }]
    ]),
    logger: { warn: () => { warns += 1 } }
  })
  // CALL 1 — host/status must see the FULL registry: retired is NOT degraded
  // to [] and the live successor is picked (no ambiguity warn).
  const call1 = await dispatchDeepartmentsEndpoint('host/status', {}, deps)
  assert.equal(call1.ok, true)
  assert.equal(call1.ok ? call1.value.hostSessionId : null, 'sess-new')
  assert.equal(call1.ok ? call1.value.previousSessionId : null, 'sess-old')
  assert.deepEqual(call1.ok ? call1.value.retired : null, [{ sessionId: 'sess-old', retiredAt: 1787337794152 }])
  assert.equal(warns, 0, 'successor selection fires NO ambiguity warn')
  // CALL 2 — hostSessionId must SURVIVE (pre-fix regression: the shared
  // iterator was exhausted by CALL 1 → null → watcher rotation signal dies).
  const call2 = await dispatchDeepartmentsEndpoint('host/status', {}, deps)
  assert.equal(call2.ok, true)
  assert.equal(call2.ok ? call2.value.hostSessionId : null, 'sess-new')
  assert.equal(call2.ok ? call2.value.previousSessionId : null, 'sess-old')
  assert.deepEqual(call2.ok ? call2.value.retired : null, [{ sessionId: 'sess-old', retiredAt: 1787337794152 }])
  // CALL 3+ — agents/list-like consumers still resolve the caller host member
  // id and the wire stays re-iterable (B3: unread is a stable 0 — the board
  // derivation is killed; the row still resolves).
  const call3 = await dispatchDeepartmentsEndpoint('agents', { sessionId: 'sess-new' }, deps)
  assert.equal(call3.ok, true)
  const row3 = call3.ok ? call3.value.agents.find((r) => r.id === 'research-head') : null
  assert.equal(row3.unread, 0, 'B3: unread is a stable 0 (no board derivation)')
  const call4 = await dispatchDeepartmentsEndpoint('list', { sessionId: 'sess-new' }, deps)
  assert.equal(call4.ok, true)
  const row4 = call4.ok ? call4.value.agents.find((r) => r.id === 'research-head') : null
  assert.equal(row4.unread, 0, 'B3: unread is a stable 0 (no board derivation)')
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
