// GUI-MAILBOX (drain lane) — RED→GREEN evidence for the OWNER prompt drain.
//
// WHAT IS UNDER TEST (declared, fb-512): the drain lane in
// `packages/dshd-orchestration/src/delivery.ts` — the listener and the flush that
// take an OWNER prompt (`source.kind === 'user'`, the GUI route) out of the
// harness' one-turn queue and park it in the EXISTING batch mailbox, so N prompts
// cost ONE turn instead of N.
//
// THE SUBJECT IS THE REAL FACTORY, driven through a STUB context whose `on()`
// records the registrations and whose agent carries a REAL inbox shape
// (`nextTurn`/`nextStep` + `remove()`), so the listener's actual contract (the
// projection read + `inbox.remove`) is EXERCISED, not mocked away. This is the
// fb132-retired-flavor pattern (the repo's established way to drive this factory
// without a Loader boot).
//
// WHY THE ASSERTION IS ABOUT THE EFFECT AND NOT THE LOG: the flush's own
// observability is `ctx.logger.info`, and the bundle's exporter admits `error`
// only (src/index.ts `levels: { default: 0 }`) — so the log cannot witness the
// drain. The effect used here is what the owner actually sees: HOW MANY followups
// the session receives for N prompts (1 batch delta vs N), plus the durable
// `drainedAt` row the lane publishes.
//
// THE NEGATIVE CONTROL IS THE POINT OF THIS LANE (the head's criterion): the
// SECOND case drives the SAME factory WITHOUT the feeder registered, so the same
// N prompts stay N one-turn items. A green here therefore cannot come from the
// unchanged path — the two arms differ only by the wire.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createDeliveryOrchestration } from '../packages/dshd-orchestration/src/delivery.ts'

// ── the stub agent: a REAL inbox shape (the listener reads it and mutates it) ──
function makeAgent(sessionId) {
  const nextTurn = []
  const nextStep = []
  return {
    id: sessionId,
    status: 'idle',
    session: { seq: 0, snapshotEvents: () => [], header: { id: sessionId } },
    // What the SESSION was actually presented with (the owner-visible effect).
    inboxMessages: [],
    inbox: {
      get nextTurn() { return nextTurn },
      get nextStep() { return nextStep },
      remove(id) {
        for (const list of [nextTurn, nextStep]) {
          const i = list.findIndex((m) => m.id === id)
          if (i >= 0) { list.splice(i, 1); return true }
        }
        return false
      },
      clear() { nextTurn.length = 0; nextStep.length = 0 }
    },
    followup(message) { this.inboxMessages.push(message) },
    steer(message) { this.inboxMessages.push(message) },
    inject() {},
    send() {},
    cancel() {},
    async whenIdle() {}
  }
}

/**
 * Build the REAL delivery factory over a temp stateDir with the stub ctx/deps.
 * `withListener:false` builds the SAME factory but drops the mailbox feeder from
 * the recorded registrations — the negative control (the two arms differ ONLY by
 * the wire).
 */
function buildFactory(stateDir, { agent, withListener = true } = {}) {
  const logs = { info: [], warn: [] }
  const handlers = new Map()
  const ctx = {
    logger: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      error() {}, debug() {}, success() {}
    },
    get: () => undefined,
    // The factory registers its hooks here: the drain-on-settle hook
    // (`agent/status`) AND the mailbox feeder (`agent/inbox/inserted`).
    on: (name, handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
    }
  }
  const surface = createDeliveryOrchestration(ctx, {
    stateDir,
    agents: agent === undefined ? undefined : { get: (id) => (id === agent.id ? agent : undefined), list: () => [agent], roots: () => [] },
    byPost: new Map(),
    hosts: new Map(),
    byChild: new Map(),
    byHeadHandle: new Map(),
    headProgress: new Map(),
    wakePackInjected: new Set(),
    deferredSleepReplace: new Map(),
    registerEntry: () => {},
    coordinatorForPost: () => undefined,
    departmentForEntry: () => undefined,
    departmentForPost: () => undefined,
    headSetup: () => () => {},
    workerSetup: () => () => {},
    resolveRoleTemplate: async () => undefined,
    resolveMaterializeAgentOptions: (o) => o ?? {},
    resolveDepartmentWorkspaceCwd: async () => '',
    resolveWorkspaceRootPath: async () => '',
    rotateArchivedHeadSessionId: async () => undefined,
    retirePost: async () => ({ postId: '', retired: true }),
    pinSessionTitle: () => 'pinned',
    disposeHeadHandleOnce: async () => {},
    disposeJoinTimeoutMs: () => 10_000,
    joinHeadDisposeOnce: async () => true,
    serializeHeadRecovery: async (_s, task) => task(),
    isHeadStuck: () => false,
    disposeHeadHandle: async () => {},
    markHeadProgress: () => {},
    attachHeadSession: async () => {},
    workerReasoningContentPreflightError: () => undefined,
    workerPoolerDispatchBlockError: () => undefined,
    ensureHost: () => '',
    persistPosts: async () => {},
    persistHosts: () => {},
    journalPathFor: () => '',
    writeJournal: async () => '',
    readJournal: async () => undefined,
    bumpHostSleepCounter: async () => '',
    bumpPostSleepCounter: async () => '',
    archivePostSessionOnSleep: async () => true,
    hostForSession: new Map(),
    hostIdForSession: (sid) => `host-${sid}`,
    postIdForChild: (sid) => (agent !== undefined && sid === agent.id ? `post-${sid}` : undefined),
    repairHostWorkspaceAttach: async () => {},
    qualityWorkerInspectProbability: 0.25,
    PRESET_ID: 'deepartments-head',
    WORKER_PRESET_ID: 'deepartments-worker',
    WORKER_AGENT_OPTIONS: { provider: 'opencode-zen', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    HOST_AGENT_OPTIONS: { provider: 'opencode-zen', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    HEAD_DEFAULT_SESSION_TITLE: 'Research Head',
    STUCK_HEAD_MS: 60_000
  })
  // The negative control: the SAME factory, with the mailbox feeder removed. The
  // feeder is the LAST registration on this event (the settle hook is on
  // `agent/status`), so dropping the final handler drops exactly the wire.
  if (!withListener) {
    const kept = (handlers.get('agent/inbox/inserted') ?? []).slice(0, -1)
    handlers.set('agent/inbox/inserted', kept)
  }
  const emit = (name, payload) => { for (const h of handlers.get(name) ?? []) h(payload) }
  const listenerCount = () => (handlers.get('agent/inbox/inserted') ?? []).length
  return { surface, logs, handlers, emit, listenerCount, registrations: [...handlers.keys()] }
}

async function withEnv(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'gui-mailbox-'))
  try { return await fn(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}

const N = 4

/** Deliver ONE owner prompt the way the harness does: the message is IN the
 * inbox projection, then `agent/inbox/inserted` fires (measured order:
 * dsh-agent-loop :206 append, :208 emit — the listener's window). */
function deliverOwnerPrompt(env, agent, n, rpcId = `rpc-gui-${n}`) {
  const message = {
    id: `gui-${n}-${Math.random().toString(36).slice(2, 8)}`,
    content: [{ type: 'text', text: `owner prompt ${n}` }],
    source: { kind: 'user', rpcId }
  }
  agent.inbox.nextTurn.push(message)
  env.emit('agent/inbox/inserted', { agent, message })
  return message
}

const drainedRows = async (stateDir) => {
  try {
    const text = await readFile(path.join(stateDir, 'registry-anomalies.jsonl'), 'utf8')
    return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === 'mailbox-drained')
  } catch { return [] }
}

test('GREEN: N owner prompts while RUNNING → the settle presents them as ONE followup (the batch delta), not N', async () => {
  await withEnv(async (stateDir) => {
    const agent = makeAgent('s-worker')
    agent.status = 'running' // the mailbox accumulates mid-turn (the design condition)
    const env = buildFactory(stateDir, { agent })
    assert.ok(env.listenerCount() > 0, 'PRECONDITION: the mailbox feeder is registered')

    const baseline = agent.inboxMessages.length
    for (let i = 1; i <= N; i += 1) deliverOwnerPrompt(env, agent, i)

    // The feeder took them out of the one-turn queue: nothing left to drip 1:1.
    assert.equal(agent.inbox.nextTurn.length, 0,
      `the feeder must park all ${N} owner prompts (an empty next-turn is what disarms the drip)`)

    // The SETTLE — the harness' running→idle transition.
    agent.status = 'idle'
    env.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 250))

    const presented = agent.inboxMessages.length - baseline
    assert.equal(presented, 1,
      `N=${N} owner prompts must be presented as ONE followup (the batch delta) — the criterion «los N en UNA operación»; got ${presented}`)
    const delta = agent.inboxMessages[agent.inboxMessages.length - 1]
    const text = delta.content.map((b) => b.text).join('')
    for (let i = 1; i <= N; i += 1) {
      assert.ok(text.includes(`owner prompt ${i}`), `the ONE delta must carry prompt ${i} (all N frames together)`)
    }
    assert.equal(delta.source.batch, true, 'the delta source carries the batch marker')
    assert.deepEqual(delta.source.rpcIds, ['rpc-gui-1', 'rpc-gui-2', 'rpc-gui-3', 'rpc-gui-4'],
      'the delta carries the OWNER identities (rpcId) — never bus record ids (an owner prompt has none)')

    // The durable trace the owner asked for: ONE row, with {cuándo, cuántos}.
    const rows = await drainedRows(stateDir)
    assert.equal(rows.length, 1, 'exactly ONE drainedAt row per drain')
    assert.match(String(rows[0].detail), new RegExp(`^${N} item`),
      `the drainedAt row must carry the count («cuántos»); got ${rows[0].detail}`)
    assert.equal(typeof rows[0].ts, 'number', 'the drainedAt row must carry the moment (Date.now())')
    assert.equal(rows[0].kind, 'mailbox-drained', 'the row rides the org channel (registry-anomalies.jsonl)')
  })
})

test('CONTROL (must differ): WITHOUT the feeder the SAME N prompts stay N one-turn items — the measured drip', async () => {
  await withEnv(async (stateDir) => {
    const agent = makeAgent('s-worker')
    agent.status = 'running'
    const env = buildFactory(stateDir, { agent, withListener: false })
    assert.equal(env.listenerCount(), 0, 'CONTROL PRECONDITION: the feeder is absent (the two arms differ ONLY by the wire)')

    const baseline = agent.inboxMessages.length
    for (let i = 1; i <= N; i += 1) deliverOwnerPrompt(env, agent, i)

    assert.equal(agent.inbox.nextTurn.length, N,
      `the control must leave all ${N} prompts queued one-per-turn (else this lane is not discriminating)`)

    agent.status = 'idle'
    env.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 250))

    assert.equal(agent.inboxMessages.length - baseline, 0,
      'the control presents NOTHING at the settle — the N queued prompts are consumed one per turn (the defect this lane fixes)')
    const rows = await drainedRows(stateDir)
    assert.equal(rows.length, 0, 'the control publishes NO drainedAt row (nothing drained)')
  })
})

test('NO SELF-FEEDING: the batch delta itself is never re-parked (the plugin tag closes the loop)', async () => {
  // The delta the flush delivers goes through `followup` => it re-fires
  // `agent/inbox/inserted`. If the delta were tagged `kind:'user'` the feeder would
  // re-ingest its own output. This asserts the delivered batch lands in the inbox
  // as a plugin-sourced message, i.e. the feeder's discriminator rejects it.
  await withEnv(async (stateDir) => {
    const agent = makeAgent('s-worker')
    agent.status = 'running'
    const env = buildFactory(stateDir, { agent })
    deliverOwnerPrompt(env, agent, 1)
    agent.status = 'idle'
    env.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(agent.inboxMessages.length, 1, 'ONE delta presented')
    const delta = agent.inboxMessages[0]
    // The delta must NOT be re-ingestible by the feeder's user-only discriminator.
    assert.notEqual(delta.source.kind, 'user',
      'the batch delta must NOT be tagged kind:user (else the feeder re-parks its own output — a self-feeding loop)')
    // And drive the loop explicitly: insert the delta the way the harness would.
    agent.status = 'running'
    agent.inbox.nextTurn.push({ id: delta.id, content: delta.content, source: delta.source })
    env.emit('agent/inbox/inserted', { agent, message: { id: delta.id, content: delta.content, source: delta.source } })
    assert.equal(agent.inbox.nextTurn.length, 1,
      'the delta must survive the feeder untouched (it stays on the normal route)')
    assert.equal(env.listenerCount() > 0, true, 'the feeder was active during this check (so the survival is MEANINGFUL, not an absent listener)')
  })
})

test('DISCRIMINATOR: a bus prompt (source.kind !== "user") is NEVER touched by the mailbox feeder', async () => {
  await withEnv(async (stateDir) => {
    const agent = makeAgent('s-worker')
    agent.status = 'running'
    const env = buildFactory(stateDir, { agent })
    const busMessage = {
      id: 'bus-msg-1',
      content: [{ type: 'text', text: 'a bus message from another agent' }],
      source: { kind: 'agent', plugin: 'deepartments', messageId: 'm-999' }
    }
    agent.inbox.nextTurn.push(busMessage)
    env.emit('agent/inbox/inserted', { agent, message: busMessage })
    assert.equal(agent.inbox.nextTurn.length, 1,
      'the bus message must STAY on its working route (the host requirement: intercept owner prompts only)')
  })
})

test('IDLE is unchanged: an owner prompt to an IDLE session is not parked (it opens its turn as today)', async () => {
  await withEnv(async (stateDir) => {
    const agent = makeAgent('s-worker')
    agent.status = 'idle'
    const env = buildFactory(stateDir, { agent })
    const message = {
      id: 'gui-idle-1',
      content: [{ type: 'text', text: 'owner prompt while idle' }],
      source: { kind: 'user', rpcId: 'rpc-idle-1' }
    }
    agent.inbox.nextTurn.push(message)
    env.emit('agent/inbox/inserted', { agent, message })
    assert.equal(agent.inbox.nextTurn.length, 1,
      'an idle session must keep the prompt queued (running is the batch precondition)')
  })
})

test('rpcId DEDUPE: a GUI retry with the SAME requestId never parks twice (the double-delivery guard)', async () => {
  await withEnv(async (stateDir) => {
    const agent = makeAgent('s-worker')
    agent.status = 'running'
    const env = buildFactory(stateDir, { agent })
    deliverOwnerPrompt(env, agent, 1, 'rpc-same-1')
    assert.equal(agent.inbox.nextTurn.length, 0, 'the first submission is parked')

    // The GUI retries the SAME requestId (a new message id, same rpcId). The
    // harness would re-admit it — because `hasPromptRequest` no longer sees the
    // parked copy — so the rpcId dedupe is the ONLY thing preventing a duplicate.
    deliverOwnerPrompt(env, agent, 2, 'rpc-same-1')
    // The retry must be SWALLOWED OUT of the inbox, not left queued: a queued copy
    // would open its own turn and deliver the prompt a SECOND time (once 1:1, once
    // in the batch delta). Exactly-once is the harness's own `hasPromptRequest`
    // semantic (api-session-controller:940-951: already admitted, never re-admits).
    assert.equal(agent.inbox.nextTurn.length, 0,
      'the redundant retry must be swallowed out of the inbox (leaving it queued would deliver the prompt twice)')

    agent.status = 'idle'
    env.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 250))
    const texts = agent.inboxMessages.map((m) => m.content.map((b) => b.text).join(''))
    const carrying = texts.filter((t) => t.includes('owner prompt 1'))
    assert.equal(carrying.length, 1, `the retried prompt must be delivered exactly ONCE; delivered ${carrying.length}`)
    const rows = await drainedRows(stateDir)
    assert.equal(rows.length, 1, 'ONE drain row (one presented item)')
    assert.match(String(rows[0].detail), /^1 item/, 'the drain carried exactly ONE item (the duplicate was never parked)')
  })
})
