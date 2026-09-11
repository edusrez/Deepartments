// dsh-deepartments — fb-831 OBSERVABILITY RENDERS test (LANE fb-831, run token
// c5ee5274). The QD measured BY EFFECT (2026-09-11): the TEXT RENDER of the
// head's four observability tools publishes a SUBSET of what each tool's output
// schema DECLARES and its description PROMISES —
//   (a) dept_who — `sessionId` is REQUIRED in the schema (and `departmentId`/
//       `role`/`jobId` are declared): the render emitted NONE of them, so the
//       head could not classify the roster nor attribute a worker to its
//       manager, and the render LIED about its own declared shape;
//   (b) dept_monitor_list — `query` is REQUIRED (+ lastFiredAt/lastPolledAt/
//       cursor/lastEventCount): the render emitted only id + monitorId;
//   (c) dept_job_list — `schedule` (+ description/owner/outbox) was omitted, and
//       `schedule` is EXACTLY what decides whether a job AUTO-FIRES.
// The discriminator is a CONTRACT, not style: omitting a VALUE that is ZERO is
// correct; omitting a FIELD always breaks the question the tool says it
// answers. dept_repo_state's ahead/behind zero-suffix is the CORRECT
// counterexample and is deliberately NOT touched (case 4 below locks that it
// stays correct).
//
// Method (0 builds — the built lib/ is stale by design until the owner's build):
// the factory SOURCE is imported through Node's native type stripping plus a
// LOCAL synchronous resolve hook (relative `.js` -> sibling `.ts` — the ONLY
// rewrite the src graph needs), and the REAL registered tool definitions'
// `output.render` are driven with hand-built values. The render is EXERCISED,
// never grepped. This test self-registers its OWN hook (the fb-95 rule: the
// shared lane-② loader file is allow-listed to that family by the r6-ladder
// guard, so a NEW src-native test must not reference or repurpose it).
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test, after } from 'node:test'
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

// ---------------------------------------------------------------------------
// The src-native factory harness (the sweep-observability stub pattern): a stub
// ctx sufficient for the factory CONSTRUCTION seams (get/on/effect/tools/logger)
// plus the dep object the factory destructures. `installHeadBoardTools` is then
// driven with a COLLECTOR agentCtx so the REAL registered definitions (and
// therefore the REAL `output.render` functions) are reachable.
// ---------------------------------------------------------------------------
const factoryDisposers = []
after(() => {
  for (const dispose of factoryDisposers.splice(0)) {
    try { dispose() } catch { /* the stub effect disposers are inert */ }
  }
})

const neverResolve = () => new Promise(() => {})

function stubFactoryCtx() {
  const logger = { warn() {}, info() {}, error() {}, debug() {}, success() {} }
  return {
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
    effect: (fn) => { factoryDisposers.push(fn) },
    on: () => () => {},
    sessions: { get: () => undefined }
  }
}

function emptyTool() {
  return { name: 'stub', description: 'stub', parameters: {}, output: { schema: {}, render: () => [] } }
}

/** Build ONE tools factory over stub deps (temp stateDir) and return the
 * collected definitions of ONE head own-layer registration. */
function collectHeadTools(stateDir) {
  const ctx = stubFactoryCtx()
  const posts = new Map()
  const hosts = new Map()
  const surface = createToolsOrchestration(ctx, {
    config: { health: {} },
    org: { departments: [] },
    stateDir,
    repoRoot: REPO_ROOT,
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
    // A VALID array schema (the real dep is the activeMembers shape; the
    // schema compiler validates it at defineTool time for dept_post_create).
    activeMembersSchema: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentId: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          title: { type: 'string', required: true },
          state: { type: 'string', required: true }
        }
      }
    },
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
    dshHome: () => path.join(stateDir, 'dsh-home'),
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
      messagesStoreReady: Promise.resolve({ get: async () => undefined }),
      deliverBusRecord: async () => 'queued',
      isDormantRecipient: () => false
    }
  })
  const collected = new Map()
  const collectorCtx = { tools: { register: (def) => { collected.set(def.name, def); return () => {} } } }
  // manager:true = the HEAD own-layer (job tools + monitor tool are head-only).
  surface.installHeadBoardTools(collectorCtx, true, { allowExec: false })
  return { collected, surface }
}

/** Read one text page out of a REAL registered definition's render. */
function renderText(def, args, value) {
  const blocks = def.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${def.name} renders a non-empty content array`)
  assert.equal(blocks[0].type, 'text', `${def.name} renders a text block`)
  return blocks[0].text
}

const HEAD_TOOLS = collectHeadTools(path.join(REPO_ROOT, '.fb831-renders-state'))

/** The pre-fix render of `dept_who` published NONE of the schema-declared
 * identity fields. Every assertion here fails on the reverted render. */
test('fb-831 (a) dept_who: the render publishes the schema-declared sessionId (REQUIRED) + departmentId/role/jobId — a value present, an ABSENT optional field DECLARED as `-`, never hidden', () => {
  const def = HEAD_TOOLS.collected.get('dept_who')
  assert.ok(def, 'dept_who registered (the bus-tools array)')

  // The CONTRACT (the render must publish what THIS schema declares): the
  // per-member item properties come from the real registered definition. The
  // compiled schema carries requiredness as the object-level `required` array.
  const itemSchema = def.output.schema.properties.members.items
  const itemProps = itemSchema.properties
  for (const field of ['sessionId', 'departmentId', 'role', 'jobId']) {
    assert.ok(itemProps[field] !== undefined, `dept_who's schema declares \`${field}\``)
  }
  assert.ok(itemSchema.required.includes('sessionId'), 'sessionId is a REQUIRED schema field (the render must never omit it)')

  const text = renderText(def, {}, {
    members: [
      { agentId: 'internal-programming-head', kind: 'head', title: 'Internal Programming Head', live: true, sleeping: false, state: 'idle', liveStatus: 'idle', sessionId: 'head-internal-programming-head', you: true },
      { agentId: 'builder-325', kind: 'worker', title: 'Builder: fb-831 renders', live: true, sleeping: false, state: 'running', liveStatus: 'running', sessionId: 'worker-builder-325-c5ee5274', you: false, departmentId: 'internal-programming', role: 'builder', jobId: 'fb-831-observability-renders' }
    ],
    retiredCount: 0,
    inactiveHiddenCount: 0
  })

  // The pre-existing header prefix stays byte-identical (the ADDITIVE rule).
  assert.ok(text.startsWith('Deepartments catalog (2 member(s), 0 retired, 0 sleeping/offline hidden):\n'), 'the C1 header prefix is unchanged (additive tail only)')

  const headLine = text.split('\n').find((l) => l.includes('internal-programming-head'))
  const workerLine = text.split('\n').find((l) => l.includes('builder-325'))
  assert.ok(headLine && workerLine, 'both member lines render')

  // (1) REQUIRED sessionId: emitted for EVERY row (today it is emitted for none).
  assert.match(headLine, /sessionId:head-internal-programming-head/, 'the head row publishes its REQUIRED sessionId')
  assert.match(workerLine, /sessionId:worker-builder-325-c5ee5274/, 'the worker row publishes its REQUIRED sessionId')

  // (2) The declared WORKER coordinates ride the row VERBATIM (the head's
  // roster classification + the worker→manager attribution were impossible).
  assert.match(workerLine, /departmentId:internal-programming/, 'the worker departmentId is published')
  assert.match(workerLine, /role:builder/, 'the worker role is published')
  assert.match(workerLine, /jobId:fb-831-observability-renders/, 'the worker jobId is published')

  // (3) An ABSENT optional field is DECLARED, never hidden (the golden rule).
  assert.match(headLine, /departmentId:-/, 'the host/head row declares the ABSENT departmentId')
  assert.match(headLine, /role:-/, 'the host/head row declares the ABSENT role')
  assert.match(headLine, /jobId:-/, 'the host/head row declares the ABSENT jobId')

  // (4) The pre-existing tokens/lock semantics are preserved (m-64/m-228).
  assert.match(text, /  - internal-programming-head \(head, "Internal Programming Head", idle/, 'the m-64 state token + row prefix are unchanged')
  assert.match(headLine, /, YOU/, 'the you:true marker is unchanged')
  assert.match(workerLine, /, running/, 'the m-64 running token is unchanged')
  assert.match(workerLine, /, handle:running/, 'the R8 live-handle suffix is unchanged')
})

/** (b) dept_monitor_list: `query` is REQUIRED in the schema and the whole
 * runtime monitor state was invisible in the render. */
test('fb-831 (b) dept_monitor_list: the render publishes the REQUIRED query + lastFiredAt/lastPolledAt/cursor/lastEventCount (absent ones declared, a ZERO VALUE kept)', () => {
  const def = HEAD_TOOLS.collected.get('dept_monitor_list')
  assert.ok(def, 'dept_monitor_list registered (head own-layer)')
  const itemSchema = def.output.schema.properties.monitors.items
  const itemProps = itemSchema.properties
  for (const field of ['query', 'lastFiredAt', 'lastPolledAt', 'cursor', 'lastEventCount']) {
    assert.ok(itemProps[field] !== undefined, `dept_monitor_list's schema declares \`${field}\``)
  }
  assert.ok(itemSchema.required.includes('query'), 'query is a REQUIRED schema field')

  const text = renderText(def, {}, {
    monitors: [
      { id: 'ai-industry-news', query: 'AI industry news', monitorId: 'monitor_ai', lastFiredAt: 2, lastPolledAt: 1, cursor: 'c1', lastEventCount: 5 },
      { id: 'deepseek-dsh-news', query: 'DeepSeek DSH news' },
      { id: 'zero-count', query: 'zero-valued monitor', lastEventCount: 0 }
    ]
  })

  // The pre-existing header prefix + list stay byte-identical (the declared
  // surface is an ADDITIVE tail on the NEXT lines).
  const headLine = text.split('\n')[0]
  assert.equal(headLine, '3 parallel monitor(s): ai-industry-news (monitor_ai), deepseek-dsh-news, zero-count', 'the pre-existing monitor header/list prefix is byte-identical')
  const detailLines = text.split('\n').filter((l) => l.startsWith('  - '))
  assert.equal(detailLines.length, 3, 'one declared-surface detail line per monitor')
  const detailOf = (id) => detailLines.find((l) => l.startsWith(`  - ${id} {`))

  const first = detailOf('ai-industry-news')
  assert.ok(first, 'the ai-industry-news detail line renders in the declared `  - <id> {...}` shape')
  assert.match(first, /query:AI industry news/, 'the REQUIRED query is published')
  assert.match(first, /monitorId:monitor_ai/, 'the persisted monitorId is still published')
  assert.match(first, /lastFiredAt:2/, 'lastFiredAt is published')
  assert.match(first, /lastPolledAt:1/, 'lastPolledAt is published')
  assert.match(first, /cursor:c1/, 'the last cursor is published')
  assert.match(first, /lastEventCount:5/, 'the last event count is published')

  // The absent optional fields are DECLARED on the un-created monitor.
  const second = detailOf('deepseek-dsh-news')
  assert.ok(second, 'the deepseek-dsh-news detail line renders')
  assert.match(second, /monitorId:-/, 'an absent monitorId is declared')
  assert.match(second, /lastFiredAt:-/, 'an absent lastFiredAt is declared')
  assert.match(second, /lastPolledAt:-/, 'an absent lastPolledAt is declared')
  assert.match(second, /cursor:-/, 'an absent cursor is declared')
  assert.match(second, /lastEventCount:-/, 'an absent lastEventCount is declared')
  assert.match(second, /query:DeepSeek DSH news/, 'the REQUIRED query is published even with no runtime state')

  // THE DISCRIMINATOR: a ZERO is a VALUE — it must be printed, never dropped.
  const third = detailOf('zero-count')
  assert.ok(third, 'the zero-count detail line renders')
  assert.match(third, /lastEventCount:0/, 'a ZERO lastEventCount is published as 0 (omitting a zero VALUE would be wrong the other way)')
})

/** (c) dept_job_list: `schedule` decides AUTO-FIRE and was invisible. */
test('fb-831 (c) dept_job_list: the render publishes schedule/description/owner/outbox (the cadence that decides AUTO-FIRE) with absent keys declared', () => {
  const def = HEAD_TOOLS.collected.get('dept_job_list')
  assert.ok(def, 'dept_job_list registered (head own-layer)')
  const itemProps = def.output.schema.properties.jobs.items.properties
  for (const field of ['schedule', 'description', 'owner', 'outbox']) {
    assert.ok(itemProps[field] !== undefined, `dept_job_list's schema declares \`${field}\``)
  }

  const text = renderText(def, {}, {
    jobDir: '/repo/docs/departments/internal-programming/jobs',
    jobs: [
      { id: 'auto-fire', path: '/repo/docs/departments/internal-programming/jobs/auto-fire.md', status: 'manual-run', title: 'Auto firing job', role: 'researcher', description: 'runs every morning', schedule: '0 9 * * *', owner: 'research-head', outbox: '.dsh/reports/researcher/<DATE>-auto.md' },
      { id: 'human', path: '/repo/docs/departments/internal-programming/jobs/human.md', status: 'manual-run', title: 'Human-scheduled job', role: 'organizer', description: 'the owner runs it by hand', owner: 'research-head' },
      { id: 'broken', path: '/repo/docs/departments/internal-programming/jobs/broken.md', error: 'invalid frontmatter (expected a `---` block with id/title/role/description/owner plus a non-empty body)' }
    ]
  })

  assert.ok(text.startsWith('jobs (3) in /repo/docs/departments/internal-programming/jobs:\n'), 'the jobs header prefix is unchanged')

  const cron = text.split('\n').find((l) => l.includes('auto-fire'))
  assert.ok(cron, 'the auto-fire job line renders')
  assert.match(cron, /schedule:0 9 \* \* \*/, 'THE CADENCE is published (a 5-field cron is exactly what decides AUTO-FIRE)')
  assert.match(cron, /owner:research-head/, 'owner is published')
  assert.match(cron, /outbox:\.dsh\/reports\/researcher\/<DATE>-auto\.md/, 'outbox is published')
  assert.match(cron, /description:runs every morning/, 'description is published (declared by the schema and promised by the tool description)')
  assert.match(cron, /"Auto firing job"/, 'the pre-existing title/status/role/path rendering is unchanged')

  const human = text.split('\n').find((l) => l.includes('human'))
  assert.ok(human, 'the human-scheduled job line renders')
  assert.match(human, /schedule:-/, 'a job WITHOUT a schedule DECLARES the omission (never silently hides the cadence question)')
  assert.match(human, /outbox:-/, 'an absent outbox is declared')

  // The per-entry error shape is byte-identical (the list never fails whole).
  const broken = text.split('\n').find((l) => l.includes('broken'))
  assert.match(broken, /^  - broken \(\/repo\/docs\/departments\/internal-programming\/jobs\/broken\.md\) — ERROR: invalid frontmatter/, 'the per-entry ERROR line shape is unchanged')
})

/** (d) the CONTRAEJEMPLO that must NOT be touched: dept_repo_state omits
 * ahead/behind ONLY when they are 0 — omitting a zero VALUE is correct. */
test('fb-831 (d) dept_repo_state (the CORRECT counterexample, UNTOUCHED): ahead/behind ride the suffix when non-zero and are omitted when both are 0', () => {
  const def = HEAD_TOOLS.collected.get('dept_repo_state')
  assert.ok(def, 'dept_repo_state registered (head own-layer)')
  const base = { repo: REPO_ROOT, branch: 'lane/fb831', upstream: 'origin/main', log: [], diffStats: [], worktrees: ['/repo'] }

  const zeroText = renderText(def, {}, { ...base, ahead: 0, behind: 0 })
  assert.match(zeroText, /  upstream: origin\/main$/m, 'both-zero omits the ahead/behind suffix (the CORRECT zero-value omission)')
  assert.doesNotMatch(zeroText, /ahead/, 'no ahead token when ahead is 0')

  const movedText = renderText(def, {}, { ...base, ahead: 2, behind: 1 })
  assert.match(movedText, /  upstream: origin\/main \(ahead 2, behind 1\)/, 'a non-zero ahead/behind still rides the suffix (untouched by this lane)')
})
