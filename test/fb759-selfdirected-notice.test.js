// dsh-deepartments — fb-759 SELF-DIRECTED TURN-ERROR NOTICE test (LANE 3, run
// token 86a9e470).
//
// THE DEFECT (measured, QD report .dsh/reports/quality/2026-09-14-bucle-qh-y-host-mudo.md
// §3 + §5; class owners fb-759 / fb-847 / fb-854): the LANE 2 turn/end-error
// HEAD notification (fb-27) routes a turn/end error to the post's OWN HEAD. For
// a WORKER that head is the MANAGER (a DIFFERENT post) — a legitimate wake. For
// a HEAD whose `managerId` is absent and whose department coordinator IS itself,
// the resolution yields `headId === postId`: the notice is delivered ALWAYS-WAKE
// to the VERY POST WHOSE TURN JUST DIED ⇒ it starts a fresh turn. A loop is
// indistinguishable from a legitimate series to the dedupe ledger, because every
// iteration is a NEW `${postId}:${turn}` identity — so the dedupe is correct and
// bounds nothing (the QD's §5: the LAW of the dedupe is the obstacle, not its
// implementation). Instance EXTREME: ~820 turns / ~21 h on `quality-head`.
//
// THE FIX UNDER TEST (packages/dshd-orchestration/src/tools.ts, the
// `healthNotifyHead` closure): when — and ONLY when — the resolved head IS the
// post whose turn failed, the notice is delivered through the SAME single
// delivery seam send_message uses, with `noWake: true` (the durable record is
// kept; nothing is materialized; it drains at the post's next REAL wake — the
// fb-696 / m-707 no-wake semantics), so NO new turn is started for the post that
// just failed.
//
// THE HARD RULE THIS TEST LOCKS (losing it ships a regression): `noWake` ONLY
// for the self-directed case; the MANAGER notice stays ALWAYS-WAKE. That manager
// wake is the mechanism by which a head notices a dead worker and re-wakes it
// WITHOUT re-deploying it (it saved `builder-304`); a blanket noWake would have
// switched it off.
//
// Method (src-native, 0 builds; the fb-831 harness pattern): the factory source
// is imported through Node's native type stripping + a LOCAL synchronous resolve
// hook (relative `.js` → sibling `.ts`), and the REAL `healthNotifyHead` closure
// is driven through `createToolsOrchestration` with a stub `late` harness, so the
// assertions read the ARGUMENTS the closure actually delivers. The reverted
// code (a bare `busDeliverToPost`) fails every self-directed case below.
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parentURL = context.parentURL
    if (
      typeof parentURL === 'string' &&
      /\.ts$/.test(parentURL.startsWith('file:') ? fileURLToPath(parentURL) : '') &&
      specifier.endsWith('.js') &&
      (specifier.startsWith('./') || specifier.startsWith('../'))
    ) {
      const jsPath = path.resolve(path.dirname(fileURLToPath(parentURL)), specifier)
      const tsPath = jsPath.replace(/\.js$/, '.ts')
      if (!existsSync(jsPath) && existsSync(tsPath)) return { url: pathToFileURL(tsPath).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})

const T = await import('../packages/dshd-orchestration/src/tools.ts')
const { createToolsOrchestration } = T

const neverResolve = () => new Promise(() => {})

function stubFactoryCtx() {
  const logger = { warn() {}, info() {}, error() {}, debug() {}, success() {} }
  return {
    logger,
    get: () => undefined,
    tools: { get: () => undefined, register: () => ({}) },
    effect: () => () => {},
    on: () => () => {},
    sessions: { get: () => undefined }
  }
}

function emptyTool() {
  return { name: 'stub', description: 'stub', parameters: {}, output: { schema: {}, render: () => [] } }
}

/**
 * Build ONE tools factory whose `late` harness RECORDS what the closures deliver.
 * `late.delivery.deliverOrQueue` is the seam the fix must use for a self-directed
 * notice; `late.busDeliverToPost` is the always-wake primitive the MANAGER notice
 * must keep using. Either seam being called with the WRONG recipient is what the
 * hard rule forbids, so both are recorded (and never allowed to reach a real
 * materialization).
 */
function buildHarness(opts = {}) {
  const deliveries = []
  const alwaysWake = []
  const appended = []
  const posts = new Map()
  const hosts = new Map()
  const messagesStoreReady = Promise.resolve({
    append: async (input) => {
      appended.push({ ...input, to: [...input.to] })
      return { id: `m-${appended.length}`, seq: appended.length, ts: 1, threadId: undefined, ...input }
    }
  })
  const surface = createToolsOrchestration(stubFactoryCtx(), {
    config: { health: {} },
    org: { departments: [] },
    stateDir: path.join(REPO_ROOT, '.fb759-state'),
    repoRoot: REPO_ROOT,
    byPost: posts,
    byHeadHandle: new Map(),
    coordinatorForPost: () => undefined,
    postIdForChild: () => undefined,
    registerEntry: () => {},
    departmentForPost: () => undefined,
    // THE ROUTING AS PRODUCTION DOES IT (the defect's seat): a post with no
    // `managerId` falls back to its department COORDINATOR, and for a configured
    // HEAD that coordinator IS the head itself ⇒ `headId === postId`. The stub
    // reads the coordinator the fixture declares per post, so the self-directed
    // case (a) and the cross-head case (c) are decided by the FIXTURE, not by
    // the harness.
    departmentForEntry: (entry) => {
      const coordinatorPostId = posts.get(entry.postId)?.coordinatorPostId
      return coordinatorPostId === undefined ? undefined : { id: 'dept-x', coordinator: { postId: coordinatorPostId } }
    },
    agentPresets: undefined,
    disposingHeads: new Map(),
    PRESET_ID: 'deepartments-head',
    HEAD_BASE_TOOLS: [],
    DENIED_POST_TOOLS: new Set(),
    OWN_LAYER_POST_TOOLS: new Set(),
    activeMembersSchema: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { agentId: { type: 'string', required: true }, kind: { type: 'string', required: true }, title: { type: 'string', required: true }, state: { type: 'string', required: true } } } },
    renderActiveRoster: () => '',
    activeCatalogMembers: () => [],
    memoWriteTool: emptyTool,
    postRetireTool: { ...emptyTool(), name: 'dept_post_retire' },
    pinSessionTitle: async () => 'pinned',
    WORKER_PRESET_ID: 'deepartments-worker',
    WORKER_AGENT_OPTIONS: { provider: 'opencode-zen', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    execFileP: async () => ({ stdout: '', stderr: '' }),
    DEPT_EXEC_DEFAULT_ROOTS: [],
    DEPT_EXEC_TIMEOUT_MS: 1000,
    DEPT_EXEC_MAX_BUFFER: 1024,
    deptExecDenyReason: () => undefined,
    DEPT_ZSTD_READ_MAX_LINES: 100,
    runDeptZstdRead: async () => ({ ok: true, lines: [], truncated: false, totalLines: 0 }),
    deptZstdReadDenyReason: () => undefined,
    resolveParallelMonitorConfig: () => [],
    readParallelMonitorsState: () => ({ monitors: {}, recent: [], spawns: [] }),
    appendToolsetAudit: () => {},
    headPresetIdFor: () => '',
    createSecretaryTool: () => ({ ...emptyTool(), name: 'secretary' }),
    secretaryConfig: () => ({ provider: 'opencode-zen' }),
    buildAgentRows: () => [],
    spawn: {},
    registry: { byChild: new Map(), byPost: posts, hosts },
    qualityWorkerInspectProbability: 0.25,
    headProgress: new Map(),
    hosts,
    HOST_ATTACH_REPAIR_TIMEOUT_MS: 250,
    HOST_ATTACH_REPAIR_RETRY_MS: 50,
    HOST_AGENT_OPTIONS: { provider: 'opencode-zen', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    dshHome: () => path.join(REPO_ROOT, '.fb759-state', 'dsh-home'),
    registryLoaded: neverResolve(),
    hostsLoaded: neverResolve(),
    stuckNow: () => Date.now(),
    STUCK_HEAD_MS: 60_000,
    HEAD_DEFAULT_SESSION_TITLE: 'Head',
    sleepTool: () => ({ ...emptyTool(), name: 'dept_sleep' }),
    subagents: undefined,
    wakePackService: {},
    hostIdForSession: () => undefined,
    readJournal: async () => undefined,
    journalPathFor: () => '',
    refreshPresence: () => {},
    savePresence: async () => {},
    notifyHostPresence: () => {},
    presenceCache: {},
    assembleHeartbeat: () => undefined,
    roleForSessionLive: () => undefined,
    headRotationJournalStatus: async () => ({ stale: false, fresh: true, text: '' }),
    verifyRotateReason: () => 'ok',
    resolveSessionProjCachePath: () => '',
    resolveWorkspaceStatePath: () => '',
    deliverDaemonNotice: async () => 'queued',
    captureSchedulerAutoRunFailure: async () => {},
    buildCatalogRows: () => [],
    wakePackInjected: {},
    deferredSleepReplace: async () => {},
    computeHostSleepSurfacePlan: () => undefined,
    readPresenceStateFile: async () => undefined,
    ensureHost: async () => {},
    writeJournal: async () => {},
    bumpHostSleepCounter: () => {},
    bumpPostSleepCounter: () => {},
    materializePreset: async () => undefined,
    materializeHeadPreset: async () => undefined,
    finalizeSessionLog: () => {},
    late: {
      messagesStoreReady,
      deliverBusRecord: async () => 'queued',
      isDormantRecipient: () => false,
      delivery: {
        deliverOrQueue: async (recipientId, record, opts) => {
          deliveries.push({ recipientId, record, noWake: opts?.noWake === true, callerAgentId: opts?.callerAgentId })
          if (opts?.noWake === true) opts?.gateReason?.('noWake')
          return opts?.noWake === true ? 'prepared' : 'delivered'
        }
      },
      busDeliverToPost: async (entry, frame, record) => {
        alwaysWake.push({ recipientId: entry.postId, record, frame })
        return 'delivered'
      },
      busDeliverToHost: async () => 'delivered'
    }
  })
  return { surface, posts, deliveries, alwaysWake, appended }
}

const HEAD = 'head-x'
const WORKER = 'worker-x'
const MANAGER = 'head-manager'

test('fb-759 (a) SELF-DIRECTED: a head whose turn FAILED is notified NO-WAKE — the notice is durable, nothing is materialized (the wake that used to start the next turn of the loop)', async () => {
  const { surface, posts, deliveries, alwaysWake, appended } = buildHarness()
  // The head IS its own coordinator (managerId absent + coordinator.postId === itself).
  posts.set(HEAD, { postId: HEAD, provider: 'head', sessionId: 's-head', coordinatorPostId: HEAD })
  const frame = `[From deepartments] Turn-error http-5xx: post ${HEAD} session s-head turn 72 (21:46Z) — 400: context window exceeded`
  await surface.healthNotifyHead(HEAD, frame)

  assert.equal(appended.length, 1, 'the notice RECORD is persisted (store.append) — traceability is never lost')
  assert.equal(appended[0].from, 'deepartments', 'the daemon is the sender')
  assert.deepEqual(appended[0].to, [HEAD], 'the notice addresses the post itself (the self-directed identity)')
  assert.equal(deliveries.length, 1, 'the self-directed notice goes through the SINGLE delivery seam (deliverOrQueue)')
  assert.equal(deliveries[0].recipientId, HEAD, 'the delivery recipient is the post whose turn failed')
  assert.equal(deliveries[0].noWake, true, 'noWake:true — the record persists, the recipient is NOT materialized/woken')
  assert.equal(alwaysWake.length, 0, 'the ALWAYS-WAKE primitive is NEVER used for a self-directed notice (that call WAS the loop)')
})

test('fb-759 (b) HARD RULE — the MANAGER notice stays ALWAYS-WAKE: a worker whose turn failed wakes its head, which is what lets the head re-wake a dead worker without re-deploying it', async () => {
  const { surface, posts, deliveries, alwaysWake } = buildHarness()
  // A worker's error resolves to its MANAGER — a DIFFERENT post.
  posts.set(WORKER, { postId: WORKER, provider: 'worker', sessionId: 's-w', managerId: MANAGER })
  posts.set(MANAGER, { postId: MANAGER, provider: 'head', sessionId: 's-m' })
  const frame = `[From deepartments] Turn-error http-5xx: post ${WORKER} session s-w turn 2 (21:46Z) — 400: boom`
  await surface.healthNotifyHead(WORKER, frame)

  assert.equal(deliveries.length, 0, 'a non-self-directed notice NEVER takes the no-wake seam')
  assert.equal(alwaysWake.length, 1, 'the MANAGER notice is delivered ALWAYS-WAKE (the builder-304 save path)')
  assert.equal(alwaysWake[0].recipientId, MANAGER, 'the wake lands on the MANAGER, never on the worker whose turn failed')
  assert.equal(alwaysWake[0].record.to[0], MANAGER, 'the durable record addresses the manager')
})

test('fb-759 (c) the self-directed test is the RECIPIENT identity, not the post class: a head notified about a DIFFERENT head stays ALWAYS-WAKE', async () => {
  const { surface, posts, deliveries, alwaysWake } = buildHarness()
  const other = 'head-other'
  posts.set(HEAD, { postId: HEAD, provider: 'head', sessionId: 's-head', managerId: other })
  posts.set(other, { postId: other, provider: 'head', sessionId: 's-other' })
  await surface.healthNotifyHead(HEAD, `[From deepartments] Turn-error provider: post ${HEAD} session s-head turn 9 (10:00Z) — provider refused`)

  assert.equal(deliveries.length, 0, 'a notice to ANOTHER head is not self-directed')
  assert.equal(alwaysWake.length, 1, 'it keeps the always-wake delivery')
  assert.equal(alwaysWake[0].recipientId, other, 'delivered to the resolved head')
})

test('fb-759 (d) an UNRESOLVED head is still a conservative no-op (neither seam fires — fb-27 preserved)', async () => {
  const { surface, posts, deliveries, alwaysWake, appended } = buildHarness()
  posts.set(WORKER, { postId: WORKER, provider: 'worker', sessionId: 's-w' })
  await surface.healthNotifyHead(WORKER, 'frame')
  assert.equal(appended.length, 0, 'no resolved head → NOTHING is persisted (never fabricated)')
  assert.equal(deliveries.length, 0, 'no delivery seam call')
  assert.equal(alwaysWake.length, 0, 'no always-wake call')
  await surface.healthNotifyHead('unknown-post', 'frame')
  assert.equal(appended.length, 0, 'an unknown postId is a no-op too')
})
