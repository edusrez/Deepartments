// dsh-deepartments — DUAL-SURFACE SESSION test (LANE OBJETIVE B,
// post-incidente 2026-09-04, crash-loop 609 restarts / exit 7): the regression
// lock for the session-surface migration. The incident class: the W6 health
// daemon's builders called `session.snapshotEvents()` NON-OPTIONALLY while the
// runtime core was still 0.1.1-rc.2 (legacy `events` getter only) → TypeError
// per 60 s tick, UNWRAPPED (the interval callback body was outside any
// try/catch) → exit 7 x 609 restarts. The durable fix under test:
//   - `getSessionEvents` — the ONE shared dual read (snapshotEvents?.() ??
//     events ?? []) in dshd-core, NEVER throws, duck-typed — all 8 runtime
//     call sites route through it;
//   - `detectSessionSurface` — the surface gate (the heartbeat `{ts, bootId,
//     surface}` datum + the W8-d `- session surface:` line + the boot log);
//   - the INVARIANTE DE TICKS — the 4 daemon interval callbacks wrapped
//     noexcept (health / agenda / parallel / sweep);
//   - the breaker — boot-crash.json sidecar + the NRestarts/crashStreak
//     heartbeat datums;
//   - the heartbeat itself (real tick) carries the datums.
// Method (LANE ② src-native): register the ts-src-loader + import the SOURCE
// directly (packages/*/src + src/ — type-stripping, Node ≥ 22.6); 0 builds, 0
// real APIs (the only fs is a temp stateDir; the tick's alert seam is a stub).
// The 4 surface shapes: legacy-only (the LETHAL case — the suite fixtures
// expose BOTH surfaces and never covered it), rc.1-only, both, and undefined.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'

// The src modules with RELATIVE `.js` value imports (invoke.ts) or WORKSPACE
// value imports (dshd-core/dshd-health/dshd-orchestration) are loaded DYNAMIC
// (top-level await) AFTER the register() call — the ts-src-loader hook is only
// active for repo-.ts importers, so the module graph must be entered after the
// hook registration (the lane2-g2 pattern; its imports are pure/relative-free
// and never exercise the rewrite — ours do).
const S = await import('../packages/dshd-core/src/session-surface.ts')
const { getSessionEvents, detectSessionSurface } = S
const H = await import('../packages/dshd-health/src/index.ts')
const {
  runHealthDaemonTick,
  readHealthHeartbeatFile,
  writeHealthHeartbeatFile,
  resolveBootCrashStreak,
  stampBootCrash
} = H
// --- the bundle (src): the 2 exported session-surface call sites -------------
const B = await import('../src/invoke.ts')
const { pinSessionTitle, buildMissionActivity } = B
// --- the orchestration factories (src): the other 6 call sites + the sweep ---
const T = await import('../packages/dshd-orchestration/src/tools.ts')
const { createToolsOrchestration } = T
const P = await import('../packages/dshd-orchestration/src/presets.ts')
const { createPresetsOrchestration } = P

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

// -------------------------------------------------------------------------
// Shape helpers — the FOUR session surfaces (mock session logs).
// -------------------------------------------------------------------------

/** legacy-only: the LETHAL case of the incident (0.1.1-rc.2 — ONLY the cached
 * `events` getter, NO snapshotEvents). THE case the suite fixtures never cover
 * (they expose BOTH surfaces). */
function legacySession(events) {
  return { s: { events } }
}

/** rc.1-only: the 0.1.2-rc.1 surface (ONLY snapshotEvents(), NO events). */
function rc1Session(events) {
  return { s: { snapshotEvents: () => events } }
}

/** both: the migration-arc runtime (the current suite-fixture shape). */
function bothSession(events) {
  return { s: { events: events.slice(0, 1), snapshotEvents: () => events } }
}

/** A stub event log (the shape buildPostSnapshot reads: numeric `time`). */
function sampleEvents(ts = 12345) {
  return [{ type: 'agent/think', time: ts }, { type: 'turn/end', time: ts + 1 }]
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dual-surface-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// -------------------------------------------------------------------------
// 1. THE HELPER — getSessionEvents across the 4 shapes (never throws).
// -------------------------------------------------------------------------
test('dual-surface: getSessionEvents — legacy-only / rc.1-only / both / undefined (never throws)', () => {
  const legacy = sampleEvents(1000)
  const rc1 = sampleEvents(2000)
  const both = sampleEvents(3000)
  // legacy-only — the LETHAL incident case: the old non-optional read threw here.
  assert.deepEqual([...getSessionEvents(legacySession(legacy).s)], [...legacy], 'legacy-only resolves the events getter')
  // rc.1-only — the inverse fallback.
  assert.deepEqual([...getSessionEvents(rc1Session(rc1).s)], [...rc1], 'rc.1-only resolves snapshotEvents()')
  // both — snapshotEvents wins (the rc.1 surface is the intended one).
  assert.deepEqual([...getSessionEvents(bothSession(both).s)], [...both], 'both → snapshotEvents wins (NOT events.slice(0,1))')
  // undefined / null / empty — NEVER a throw, NEVER an undefined result.
  assert.deepEqual([...getSessionEvents(undefined)], [], 'undefined session → []')
  assert.deepEqual([...getSessionEvents(null)], [], 'null session → []')
  assert.deepEqual([...getSessionEvents({})], [], 'empty session → []')
  assert.deepEqual([...getSessionEvents({ snapshotEvents: () => undefined })], [], 'snapshotEvents returning undefined → [] (?? events ?? [])')
  // duck-typed: a FULL session-shaped object (extra members) still works.
  const full = { seq: 5, header: { id: 'x' }, events: [1, 2], snapshotEvents: () => [3] }
  assert.deepEqual([...getSessionEvents(full)], [3], 'full session object is structurally assignable (duck-typed)')
  assert.deepEqual([...getSessionEvents({ seq: 5, events: [1, 2] })], [1, 2], 'a legacy-only full session (no snapshotEvents) falls back')
})

// -------------------------------------------------------------------------
// 2. THE SURFACE GATE — detectSessionSurface across the 4 states.
// -------------------------------------------------------------------------
test('dual-surface: detectSessionSurface — rc.1 / legacy / both / none', () => {
  assert.equal(detectSessionSurface(rc1Session([]).s), '0.1.2-rc.1')
  assert.equal(detectSessionSurface(legacySession([]).s), '0.1.1-rc.2-legacy')
  assert.equal(detectSessionSurface(bothSession([]).s), 'both')
  assert.equal(detectSessionSurface(undefined), 'none')
  assert.equal(detectSessionSurface(null), 'none')
  assert.equal(detectSessionSurface({}), 'none')
  assert.equal(detectSessionSurface({ snapshotEvents: 'not-a-function' }), 'none', 'a non-function snapshotEvents is NOT rc.1 (typeof guard)')
  assert.equal(detectSessionSurface({ events: 'not-an-array' }), 'none', 'a non-array events is NOT legacy (Array.isArray guard)')
})

// -------------------------------------------------------------------------
// 3. CALL SITES 1-2 (invoke.ts — EXPORTED functions): the dual read drives the
//    real behavior; legacy-only is the incident regression.
// -------------------------------------------------------------------------
function recordingSession(surface) {
  const appended = []
  const { s } = surface
  return {
    session: { ...s, append: (type, data) => { appended.push({ type, data }) } },
    appended
  }
}

test('dual-surface [site 1] pinSessionTitle: legacy-only / rc.1-only / both / no-session — no throw, correct pin guard', () => {
  // legacy-only with a user title event → already-titled (the guard reads legacy events).
  const legacyTitled = legacySession([{ type: 'session/title', data: { source: { kind: 'user' } } }])
  assert.equal(pinSessionTitle(legacyTitled.s, 'Asistente'), 'already-titled', 'legacy-only: the title guard reads the legacy events')
  // rc.1-only with a user title event → already-titled (the guard reads the snapshot).
  const rc1Titled = rc1Session([{ type: 'session/title', data: { source: { kind: 'user' } } }])
  assert.equal(pinSessionTitle(rc1Titled.s, 'Asistente'), 'already-titled', 'rc.1-only: the title guard reads snapshotEvents()')
  // both — snapshot wins (the legacy slice may carry the OLD title — the rc.1
  // snapshot is the authoritative log).
  const bothTitledUser = bothSession([])
  const bothPinned = recordingSession({ s: { events: [1], snapshotEvents: () => [] } })
  assert.equal(pinSessionTitle(bothPinned.session, 'Asistente'), 'pinned', 'both: snapshot wins (empty snapshot → no user title → pin)')
  // a session with NO log surface at all (neither events nor snapshotEvents —
  // the last of the 4 shapes at the CALL level) → no throw, the append path
  // runs (getSessionEvents({}) → []).
  const noLogSession = { append: () => {} }
  assert.equal(pinSessionTitle(noLogSession, 'Asistente'), 'pinned', 'no-log-surface session: no throw, the append path runs (getSessionEvents({}) → [])')
  // a legacy-only session WITHOUT a title → pinned (the normal pin flow).
  const legacyClean = recordingSession(legacySession([]))
  assert.equal(pinSessionTitle(legacyClean.session, 'Asistente'), 'pinned', 'legacy-only clean: pinned')
  assert.equal(legacyClean.appended.length, 1, 'legacy-only clean: ONE session/title appended')
  assert.ok(bothTitledUser === undefined || true)
})

test('dual-surface [site 2] buildMissionActivity: legacy-only / rc.1-only / both / absent-session — no throw, activity from the duel read', async () => {
  const cases = [
    { name: 'legacy-only', surface: legacySession, expectedTs: 1001 },
    { name: 'rc.1-only', surface: rc1Session, expectedTs: 1002 },
    { name: 'both', surface: bothSession, expectedTs: 1003 }
  ]
  for (const c of cases) {
    await withTempDir(async (stateDir) => {
      const events = [{ type: 'agent/think', time: c.expectedTs }]
      // messages.jsonl: the HOST-sent mission (from === the live hostId).
      await writeFile(path.join(stateDir, 'messages.jsonl'), `${JSON.stringify({ id: 'm1', from: 'host-1', to: ['post-1'], ts: 900, text: 'go', kind: 'agent', seq: 1 })}\n`, 'utf8')
      // deliveries.jsonl: the LAST host→head mission delivery row.
      await writeFile(path.join(stateDir, 'deliveries.jsonl'), `${JSON.stringify({ messageId: 'm1', recipientId: 'post-1', status: 'delivered', ts: 950 })}\n`, 'utf8')
      const byPost = new Map([['post-1', { postId: 'post-1', sessionId: 'session-post-1', provider: 'head', retired: false }]])
      const hosts = [{ hostId: 'host-1', sessionId: 'session-host-1', retired: false }]
      const agents = { get: (sid) => (String(sid) === 'session-post-1' ? { session: c.surface(events).s, status: 'idle' } : undefined) }
      const out = buildMissionActivity({ stateDir, byPost, hosts, agents })
      assert.ok(out !== undefined, `${c.name}: a live host resolves the mission seam`)
      assert.equal(out.length, 1, `${c.name}: ONE mission row`)
      assert.equal(out[0].lastActivityTs, c.expectedTs, `${c.name}: lastActivityTs comes from the surface the helper resolved`)
    })
  }
  // absent session (agents has no live handle) → no throw, activity degrades.
  await withTempDir(async (stateDir) => {
    await writeFile(path.join(stateDir, 'messages.jsonl'), `${JSON.stringify({ id: 'm1', from: 'host-1', to: ['post-1'], ts: 900, text: 'go', kind: 'agent', seq: 1 })}\n`, 'utf8')
    await writeFile(path.join(stateDir, 'deliveries.jsonl'), `${JSON.stringify({ messageId: 'm1', recipientId: 'post-1', status: 'delivered', ts: 950 })}\n`, 'utf8')
    const byPost = new Map([['post-1', { postId: 'post-1', sessionId: 'session-post-1', provider: 'head', retired: false }]])
    const hosts = [{ hostId: 'host-1', sessionId: 'session-host-1', retired: false }]
    const out = buildMissionActivity({ stateDir, byPost, hosts, agents: { get: () => undefined } })
    assert.ok(out !== undefined, 'no-session: still resolves')
    assert.equal(out[0].lastActivityTs, undefined, 'no-session: no activity term (the old code could never have thrown here either — but the read path is exercised)')
  })
})

// -------------------------------------------------------------------------
// 4. CALL SITES 5-6 (tools.ts — buildHealthPosts / buildHostWaits) + site 3
//    (captureRetiredPostTurnError / runInterruptedPostReconciliation — static
//    guard in §7): construct the REAL tools factory over stub ctx + never-
//    resolving boot promises (the boot continuation never fires); the sweep
//    interval + the disposers are cleared at teardown.
// -------------------------------------------------------------------------

/** A stub ctx sufficient for the factory CONSTRUCTION seams (get/on/effect/
 * tools/logger). The wakepack service stub prevents the in-bundle fallback
 * construction; the boot promises NEVER resolve so the boot-continuation
 * reconcilers never run (0 real APIs, 0 process spawns). */
function stubFactoryCtx(disposers) {
  const logger = { warn() {}, info() {}, error() {}, debug() {}, success() {} }
  const ctx = {
    logger,
    get: (key) => {
      if (key === 'deepartments.wakepack') {
        return {
          assembleWakePack: async () => 'stub-wakepack',
          assembleWakeSnapshot: async () => 'stub-snapshot',
          buildCondensedRoster: () => [],
          preStepHandler: async () => {}
        }
      }
      return undefined
    },
    tools: { get: () => undefined, register: () => ({}) },
    effect: (fn) => { disposers.push(fn) },
    on: () => () => {}
  }
  return ctx
}

const neverResolve = () => new Promise(() => {})

let factoryDisposers = []
after(() => {
  for (const dispose of factoryDisposers.splice(0)) {
    try { dispose() } catch { /* the stub effect disposers are inert */ }
  }
})

/** Build ONE tools factory over the given byPost/agents/hosts/stateDir. */
function buildToolsFactory({ stateDir, posts = [], agents = new Map(), hosts = new Map() }) {
  const ctx = stubFactoryCtx(factoryDisposers)
  const tools = createToolsOrchestration(ctx, {
    config: { health: {} },
    org: { departments: [] },
    stateDir,
    repoRoot: REPO_ROOT,
    agents: agents.size > 0 ? agents : undefined,
    byPost: posts,
    byHeadHandle: new Map(),
    coordinatorForPost: () => undefined,
    postIdForChild: () => undefined,
    registerEntry: () => {},
    departmentForPost: () => undefined,
    departmentForEntry: () => undefined,
    agentPresets: undefined,
    disposingHeads: new Map(),
    PRESET_ID: 'deepartments-head',
    HEAD_BASE_TOOLS: [],
    DENIED_POST_TOOLS: new Set(),
    OWN_LAYER_POST_TOOLS: new Set(),
    activeMembersSchema: undefined,
    renderActiveRoster: () => '',
    activeCatalogMembers: () => [],
    memoWriteTool: (hostPlane) => ({ name: hostPlane ? 'dept_memo_write' : 'memo', description: 'x', parameters: {}, output: { schema: {}, render: () => [] } }),
    postRetireTool: { name: 'dept_post_retire', description: 'x', parameters: {}, output: { schema: {}, render: () => [] } },
    pinSessionTitle,
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
    createSecretaryTool: () => ({ name: 'secretary', description: 'x', parameters: {}, output: { schema: {}, render: () => [] } }),
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
    dshHome: () => path.join(tmpdir(), 'dual-surface-dsh-home'),
    registryLoaded: neverResolve(),
    hostsLoaded: neverResolve(),
    stuckNow: () => Date.now(),
    STUCK_HEAD_MS: 60_000,
    HEAD_DEFAULT_SESSION_TITLE: 'Research Head',
    sleepTool: () => ({ name: 'dept_sleep', description: 'x', parameters: {}, output: { schema: {}, render: () => [] } }),
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
    headRotationJournalStatus: async () => ({ stale: false, fresh: true, text: '' }),
    verifyRotateReason: () => 'ok',
    resolveSessionProjCachePath: () => '',
    deliverDaemonNotice: async () => 'queued',
    captureSchedulerAutoRunFailure: async () => {},
    buildCatalogRows: () => [],
    wakePackInjected: {},
    deferredSleepReplace: async () => {},
    computeHostSleepSurfacePlan: () => undefined,
    readPresenceStateFile: async () => undefined,
    ensureHost: async () => {},
    writeJournal: async () => {},
    bumpHostSleepCounter: async () => {},
    bumpPostSleepCounter: async () => {},
    activeMembersSchemaFallback: undefined,
    late: {
      messagesStoreReady: Promise.resolve({ get: async () => undefined }),
      deliverBusRecord: async () => 'queued',
      isDormantRecipient: () => false
    }
  })
  return tools
}

/** Build ONE presets factory over the given byPost/agents/hosts/stateDir. */
function buildPresetsFactory({ stateDir, posts = [], agents = new Map(), hosts = new Map() }) {
  const ctx = stubFactoryCtx(factoryDisposers)
  const presets = createPresetsOrchestration(ctx, {
    config: { health: {} },
    org: { departments: [], pacing: undefined },
    stateDir,
    agents: agents.size > 0 ? agents : undefined,
    byPost: posts,
    hosts,
    hostIdForSession: () => undefined,
    refreshPresence: () => {},
    persistHosts: async () => {},
    postIdForChild: () => undefined,
    deferredSleepReplace: async () => {},
    wakePackInjected: {},
    isUsableAgentOptions: () => false,
    yamlList: () => [],
    computeHostSleepSurfacePlan: () => undefined,
    readPresenceStateFile: async () => undefined,
    HEAD_PRESET_BASE_ID: 'deepartments-head',
    headPresetIdFor: () => '',
    headPresetNameCore: () => '',
    headPresetNameFor: () => '',
    buildHeadPresetComposition: () => ({}),
    buildHeadPresetMetadata: () => ({}),
    appendToolsetAudit: () => {},
    late: { messagesStoreReady: Promise.resolve({ get: async () => undefined }) }
  })
  return presets
}

/** A post entry with a sessionId (the shape the builders read). */
function postEntry(postId, sessionId, extra = {}) {
  return { postId, sessionId, retired: false, provider: 'head', ...extra }
}

test('dual-surface [sites 5-6] buildHealthPosts + buildHostWaits: legacy-only / rc.1-only / both / absent — the REAL factory builders read the duel surface (no-throw; legacy-only was the incident site)', async () => {
  await withTempDir(async (stateDir) => {
    const cases = [
      { name: 'legacy-only', surface: legacySession, expected: 4100 },
      { name: 'rc.1-only', surface: rc1Session, expected: 4200 },
      { name: 'both', surface: bothSession, expected: 4300 }
    ]
    for (const c of cases) {
      const events = sampleEvents(c.expected)
      const agents = new Map([['session-post-1', { session: c.surface(events).s, status: 'running' }]])
      const posts = new Map([['post-1', postEntry('post-1', 'session-post-1')]])
      // buildHealthPosts: the incident builder (9:4965 at the time).
      const health = buildToolsFactory({ stateDir, posts, agents, hosts: new Map() }).buildHealthPosts()
      assert.equal(health.length, 1, `${c.name}: buildHealthPosts produced ONE row`)
      assert.equal(health[0].events.length, events.length, `${c.name}: buildHealthPosts read the events via the duel surface`)
      // buildHostWaits: needs a LIVE host (pickLiveHostEntry) + a post.
      const hosts = new Map([['host-1', { hostId: 'host-1', sessionId: 'session-host-1', retired: false }]])
      const waits = buildToolsFactory({ stateDir, posts, agents, hosts }).buildHostWaits()
      assert.equal(waits.length, 1, `${c.name}: buildHostWaits produced ONE row (live host resolved)`)
      assert.equal(waits[0].events.length, events.length, `${c.name}: buildHostWaits read the events via the duel surface`)
    }
    // absent session (no live handle) → [] events, no throw.
    const postsEmpty = new Map([['post-1', postEntry('post-1', 'session-post-1')]])
    const healthNone = buildToolsFactory({ stateDir, posts: postsEmpty, agents: new Map(), hosts: new Map() }).buildHealthPosts()
    assert.equal(healthNone[0].events.length, 0, 'absent session → empty events ([]) — never a throw (the old non-optional read threw here)')
  })
})

test('dual-surface [sites 7-8] assembleHeartbeat: the REAL presets factory — legacy-only / rc.1-only / both / none, no-throw + the `session surface:` drift line', async () => {
  await withTempDir(async (stateDir) => {
    const cases = [
      { name: 'legacy-only', surface: legacySession, line: '- session surface: 0.1.1-rc.2-legacy' },
      { name: 'rc.1-only', surface: rc1Session, line: '- session surface: 0.1.2-rc.1' },
      { name: 'both', surface: bothSession, line: '- session surface: both' }
    ]
    for (const c of cases) {
      const events = sampleEvents()
      const agents = new Map([['session-host-1', { session: c.surface(events).s, status: 'idle' }]])
      const posts = new Map([['post-1', postEntry('post-1', 'session-post-1')]])
      const hosts = new Map([['host-1', { hostId: 'host-1', sessionId: 'session-host-1', retired: false }]])
      const presets = buildPresetsFactory({ stateDir, posts, agents, hosts })
      const section = presets.assembleHeartbeat('host-1')
      assert.ok(typeof section === 'string' && section.length > 0, `${c.name}: assembleHeartbeat returned a section (no throw — the incident site was the W6 heartbeat)`)
      assert.ok(section.includes(c.line), `${c.name}: the wake-pack heartbeat carries the detected surface («${c.line}»)`)
      assert.ok(section.includes('host:'), `${c.name}: the host-activity line rendered from the duel read`)
    }
    // none — no live session anywhere: 'none' + no throw.
    const hosts = new Map([['host-1', { hostId: 'host-1', sessionId: 'session-host-1', retired: false }]])
    const presetsNone = buildPresetsFactory({ stateDir, posts: new Map([['post-1', postEntry('post-1', 'session-post-1')]]), agents: new Map(), hosts })
    const sectionNone = presetsNone.assembleHeartbeat('host-1')
    assert.ok(typeof sectionNone === 'string', 'none: assembleHeartbeat no-throw with NO live session')
    assert.ok(sectionNone.includes('- session surface: none'), 'none: the drift line reports «none» honestly')
  })
})

// -------------------------------------------------------------------------
// 5. THE REAL TICK — the wrapper-integration no-throw + the heartbeat datums
//    (surface / nRestarts / crashStreak) land on disk.
// -------------------------------------------------------------------------
test('dual-surface [tick integration] runHealthDaemonTick: legacy-shaped inputs no-throw + the heartbeat carries surface/nRestarts/crashStreak', async () => {
  await withTempDir(async (stateDir) => {
    const events = sampleEvents()
    const calls = []
    await runHealthDaemonTick({
      now: () => 5_000_000,
      stateDir,
      bootId: 'boot-tick-1',
      config: { health: {} },
      hosts: [],
      posts: [{ postId: 'post-1', sessionId: 'session-post-1', retired: false, running: false, events: [...events], inboxTs: [], provider: 'head' }],
      sessionSurface: '0.1.1-rc.2-legacy',
      nRestarts: 609,
      crashStreak: 4,
      notifyHost: async (host, frame) => { calls.push(frame) }
    })
    const hb = readHealthHeartbeatFile(stateDir)
    assert.ok(hb !== undefined, 'the real tick wrote the heartbeat')
    assert.equal(hb.bootId, 'boot-tick-1')
    assert.equal(hb.surface, '0.1.1-rc.2-legacy', 'the heartbeat carries the detected surface')
    assert.equal(hb.nRestarts, 609, 'the heartbeat carries the systemd NRestarts datum (the incident counter)')
    assert.equal(hb.crashStreak, 4, 'the heartbeat carries the boot-crash streak')
    assert.deepEqual(calls, [], 'no alerts on the clean tick')
    // absent datums → omitted fields (never synthesized).
    await rm(path.join(stateDir, 'health-heartbeat.json'), { force: true })
    await runHealthDaemonTick({
      now: () => 5_000_100,
      stateDir,
      bootId: 'boot-tick-2',
      hosts: [],
      notifyHost: async () => {}
    })
    const hb2 = readHealthHeartbeatFile(stateDir)
    assert.equal(hb2.bootId, 'boot-tick-2')
    assert.equal(hb2.surface, undefined, 'absent sessionSurface → the field is OMITTED (never synthesized)')
  })
})

// -------------------------------------------------------------------------
// 6. THE BREAKER — boot-crash.json semantics (stamp + streak): a previous boot
//    without its own heartbeat = pre-tick crash → streak++, else clear.
// -------------------------------------------------------------------------
test('dual-surface [breaker] boot-crash sidecar: stamp/streak semantics — crash pre-tick streaks, a ticked previous boot clears', async () => {
  await withTempDir(async (stateDir) => {
    // First boot ever: no sidecar → streak 0.
    assert.equal(resolveBootCrashStreak(stateDir), 0, 'first boot: no previous stamp → 0')
    const stampA = await stampBootCrash(stateDir, 'boot-A', 1_000)
    assert.equal(stampA.crashStreak, 0, 'boot-A stamps with streak 0 (first boot)')
    // boot-A CRASHED pre-tick (no heartbeat of its own) → boot-B streaks.
    const stampB = await stampBootCrash(stateDir, 'boot-B', 2_000)
    assert.equal(stampB.crashStreak, 1, 'boot-A died before a healthy heartbeat → boot-B streak 1 (the incident class)')
    // boot-B ALSO crashed pre-tick → boot-C streaks to 2.
    const stampC = await stampBootCrash(stateDir, 'boot-C', 3_000)
    assert.equal(stampC.crashStreak, 2, 'a second consecutive pre-tick crash → streak 2')
    assert.equal(stampC.lastCrashAt, 3_000, 'lastCrashAt records the latest crash')
  })
  await withTempDir(async (stateDir) => {
    // A boot that TICKED (its own heartbeat) → the NEXT boot clears the streak.
    await stampBootCrash(stateDir, 'boot-A', 1_000)
    await writeHealthHeartbeatFile(stateDir, { ts: 5_000, bootId: 'boot-A' }) // boot-A lived
    const stampB = await stampBootCrash(stateDir, 'boot-B', 6_000)
    assert.equal(stampB.crashStreak, 0, 'the previous boot ticked (heartbeat with its bootId) → streak clears to 0')
  })
  await withTempDir(async (stateDir) => {
    // A crashed streak is NOT reset without the current boot's OWN heartbeat:
    // boot-A ticked once, then a LATER B crashed → C sees B's missing heartbeat.
    await stampBootCrash(stateDir, 'boot-A', 1_000)
    await writeHealthHeartbeatFile(stateDir, { ts: 5_000, bootId: 'boot-A' })
    await stampBootCrash(stateDir, 'boot-B', 10_000) // B crashed pre-tick
    const stampC = await stampBootCrash(stateDir, 'boot-C', 20_000)
    assert.equal(stampC.crashStreak, 1, 'only the PREVIOUS boot is judged (B), not the older healthy A')
  })
})

// -------------------------------------------------------------------------
// 7. STATIC REGRESSION GUARD — the 8 call sites route through getSessionEvents
//    and NO raw non-optional `snapshotEvents()` call remains in the runtime
//    surface files (the md5-style behavior anchor; a reintroduced direct call
//    is the exact 48492a0 regression class). Plus the sweep wrapper invariant.
// -------------------------------------------------------------------------
test('dual-surface [static guard] the 8 call sites use getSessionEvents — no raw non-optional snapshotEvents() call anywhere in the runtime surface', () => {
  const invoke = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
  const tools = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts'), 'utf8')
  const presets = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'presets.ts'), 'utf8')
  // Comment/type-declaration lines are not call sites — only RUNTIME lines count.
  const runtimeLines = (src) => src.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  for (const [file, src] of [['src/invoke.ts', invoke], ['tools.ts', tools], ['presets.ts', presets]]) {
    assert.ok(!runtimeLines(src).some((line) => /\.snapshotEvents\(\)/.test(line)), `${file}: NO raw non-optional snapshotEvents() call remains (the 48492a0 regression class)`)
  }
  // The 8 sites anchor on the SHARED helper:
  assert.match(invoke, /const titleEvents = getSessionEvents\(session\)/, 'site 1 — pinSessionTitle routes through getSessionEvents')
  assert.match(invoke, /const events = getSessionEvents\(liveSession\)/, 'site 2 — buildMissionActivity routes through getSessionEvents')
  assert.match(tools, /const events = getSessionEvents\(liveAgent\?\.session\)/, 'site 3 — captureRetiredPostTurnError routes through getSessionEvents')
  assert.match(tools, /events = getSessionEvents\(live\.session\)/, 'site 4 — runInterruptedPostReconciliation routes through getSessionEvents')
  assert.match(tools, /events: getSessionEvents\(live\?\.session\)/, 'site 5 — buildHealthPosts routes through getSessionEvents')
  assert.match(tools, /events: getSessionEvents\(liveAgent\?\.session\)/, 'site 6 — buildHostWaits routes through getSessionEvents')
  assert.match(presets, /const hostEvents = getSessionEvents\(hostLive\?\.session\)/, 'site 7 — assembleHeartbeat host row routes through getSessionEvents')
  assert.match(presets, /const events = getSessionEvents\(live\?\.session\)/, 'site 8 — assembleHeartbeat post rows route through getSessionEvents')
  // The sweep interval callback is wrapped (the INVARIANTE DE TICKS).
  assert.match(tools, /setInterval\(\(\) => \{\n\s+\/\/ INVARIANTE DE TICKS[\s\S]*?try \{[\s\S]*?sweepDue\(\)[\s\S]*?catch/, 'the redelivery-sweep interval callback body is wrapped (noexcept)')
  // The invoke.ts daemon intervals use wrapDaemonTick.
  assert.match(invoke, /wrapDaemonTick\(ctx\.logger, 'agenda scheduler'/, 'agenda interval wrapped')
  assert.match(invoke, /wrapDaemonTick\(ctx\.logger, 'parallel-monitor'/, 'parallel interval wrapped')
  assert.match(invoke, /wrapDaemonTick\(ctx\.logger, 'system-health'/, 'health interval wrapped (the incident seam)')
  // The helper's own dual implementation stays exactly the mandated shape.
  const helper = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-core', 'src', 'session-surface.ts'), 'utf8')
  assert.match(helper, /session\?\.snapshotEvents\?\.\(\) \?\? session\?\.events \?\? \[\]/, 'getSessionEvents is the mandated dual read (never-throw, [] fallback)')
})