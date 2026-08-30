/**
 * Deepartments — DECOUPLING SUB-PASO 4: TOOLS ORCHESTRATION FACTORY
 * (HITO 3 DECOUPLING, brief step 5 — SUB-BATCH 1 of 4: the dept_exec/zstd
 * runners + the agent toolset REGISTRY (installHeadBoardTools), 922 LOCs of
 * `applyInvoke`, src/invoke.ts 3977-4898).
 *
 * MOVEMENT-ONLY. The first cut of the tools zone of `applyInvoke` (the
 * dept_exec runners — deptExecAllowedRoots / runDeptExec / deptExecRender —
 * plus `installHeadBoardTools`, the post own-layer tool registry: calendar x3,
 * dept_exec, dept_zstd_read, dept_post_create, dept_job_list / dept_job_run,
 * dept_worker_spawn / dept_worker_retire, dept_monitor_list, the M2.3
 * secretary, the bus/feedback own-layer inserts + memo / dept_post_retire) is
 * hoisted VERBATIM into this factory, and `applyInvoke` invokes it via
 * `createToolsOrchestration` AT THE SAME FIBER POSITION — the same closures,
 * the same order, the same semantics (0 behavior change). The state these
 * closures read/mutate is the SAME by-reference maps/registries passed in
 * `deps`. The file is CUMULATIVE: sub-batches 2-4 of the tools zone
 * (role/persona sections + postSetup/workerSetup/retire paths, workspace +
 * ensureHead + ghost/pooler-check, bus/feedback defs + globals) grow this
 * factory and its surface.
 *
 * Pattern (the PASO 1 / sub-paso 2 / sub-paso 3 proof): closures hoisted →
 * the seams this cut consumes that DO NOT EXIST at the invocation position
 * (3977) are LATE-BOUND: the agent-setup/workspace closures (workerSetup,
 * resolveDepartmentWorkspaceCwd, resolveWorkspaceRootPath — built in the
 * agent zone), the retire/archive seams (retirePost, archiveWorkerSession),
 * the delivery seams (messagesStoreReady / deliverBusRecord — the
 * DeliverySurface built at the delivery factory position), and the tool ARRAYS
 * the registry iterates (busTools / feedbackEmitTools / feedbackHeadTools —
 * built in the bus/feedback defs zone) are passed as `deps.late` GETTERS over
 * the apply-scope bindings, and rebound here as thunk arrows of EXACT
 * signature (call seams) + a delegating THENABLE (messagesStoreReady, awaited
 * as a value) + delegating ITERABLES (the for..of tool arrays) — all
 * dereferenced at CALL time (installHeadBoardTools runs at agent
 * materialization, the tool executes fire at user calls — both post-boot,
 * long after every seam is initialized; the apply-scope TDZ of those late
 * consts is never entered: the same binding semantics the inline zone had).
 * The bundle stays a PURE SERVICE CONSUMER: this factory performs NO
 * ctx.provide (the P1 "the bundle consumes, never provides" invariant + the
 * smoke-boot service set stay untouched) — the `deepartments.tools` service
 * surface the brief planned via ctx.provide is deferred to the hito-4 package
 * migration; the seams it would expose are already the returned ToolsSurface
 * members.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { mintWorkerSessionId } from '../registry.js'
import type { PostEntry } from '../registry.js'
import { parseJobDefFrontmatter, jobDirFor } from '../jobs.js'
import type { CalendarEntry } from '../jobs.js'
import { createSecretaryTool, secretaryConfig } from '../../subagent.js'
import type {
  Config,
  CoordinatorConfig,
  DepartmentConfig,
  ParallelConfig,
  ParallelMonitorConfig
} from '../../org.js'
import type { DeptWhoState } from '../../agents.js'
import type { MessagesStore } from '../messages.js'
import type { DeliverySurface } from './delivery.js'
import type { HeadToolDisposers, SpawnSurface } from './spawn.js'

// ---------------------------------------------------------------------------
// Local structural mirrors of the bundle-local harness views (src/invoke.ts
// declares these at module scope but does NOT export them — the export-parity
// lock freezes lib/invoke.js's export surface at 259 symbols, so the factory
// re-declares the EXACT same structural shapes instead of importing from the
// bundle module (which would also create a require cycle).
// ---------------------------------------------------------------------------

/** Loose structural view of a live `Agent` (the shape `ctx.agents.get(id)`
 * returns). Mirrors the bundle-local `AgentLike` of src/invoke.ts. */
interface AgentLike {
  id: string
  status: string
  ctx: Context
  session?: { events: unknown[] }
  followup(message: { content: readonly { type: string; text: string }[]; source: Record<string, unknown> }): void
  cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
}

/** Structural view of the `AgentHandle` returned by `ctx.agents.create/resume`
 * (mirrors the bundle-local `AgentHandleLike`). */
interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

/** Agent-scoped creation options (mirrors the bundle-local `AgentOptionsLike`). */
interface AgentOptionsLike {
  provider?: string
  model?: string
  maxTokens?: number
  reasoningEffort?: string
}

/** Structural view of the `agents` service surface (mirrors the bundle-local
 * `AgentsLike`). */
interface AgentsLike {
  get(id: string): AgentLike | undefined
  list(): AgentLike[]
  roots(): AgentLike[]
  create(options: {
    sessionId: string
    seed?: readonly unknown[]
    meta?: Record<string, unknown>
    agentOptions?: AgentOptionsLike
    setup?: (agentCtx: Context) => unknown
    signal?: AbortSignal
  }): Promise<AgentHandleLike>
  resume(options: {
    resumeSessionId: string
    agentOptions?: AgentOptionsLike
    setup?: (agentCtx: Context) => unknown
    signal?: AbortSignal
  }): Promise<AgentHandleLike>
}

/** The runtime parallel-monitors snapshot file shape (mirrors the bundle-local
 * `ParallelMonitorsState` of src/invoke.ts — the reader is module-scope and not
 * importable from here without a cycle). */
interface ParallelMonitorsState {
  monitors: Record<string, {
    monitorId?: string
    lastFiredAt?: number
    lastPolledAt?: number
    cursor?: string
    lastEventCount?: number
  }>
}

/** The apply-scope bindings the tools cut-1 zone captures (src/invoke.ts
 * closures + the shared mutable state), passed BY REFERENCE — the factory
 * reads and mutates the SAME maps/registries the rest of applyInvoke uses
 * (AGENTS.md rule 4 — no module-global mutable state; the instance lives on
 * the apply fiber). `late` carries the seams that do NOT exist at the
 * invocation position (3977): indirect GETTERS over the apply-scope bindings
 * the zone dereferences at CALL time (post-boot). */
export interface ToolsFactoryDeps {
  /** The plugin Config (the dept_monitor_list parallel knob). */
  config: Config
  /** The org config (dept_exec's execRoots / missionExecRoots). */
  org: Config['org']
  /** The org stateDir (the dept_exec allowed roots + monitor state path). */
  stateDir: string
  /** The repo root (the jobDir + dept_exec allowed roots). */
  repoRoot: string
  /** The live agents service (optional — absent in minimal compositions). */
  agents: AgentsLike | undefined
  /** The live durable post catalog (BY REFERENCE). */
  byPost: Map<string, PostEntry>
  /** The live head-handle map (byHeadHandle — worker sessions keyed here). */
  byHeadHandle: Map<string, AgentHandleLike>
  /** The config coordinator resolver for a postId (slug shadows guard). */
  coordinatorForPost: (postId: string) => CoordinatorConfig | undefined
  /** The durable catalog postId ↔ sessionId resolver (agent session → post). */
  postIdForChild: (childId: string) => string | undefined
  /** The registry closure — register a (re)materialized entry (by reference). */
  registerEntry: (entry: PostEntry) => void
  /** The config department for a postId (the deploy/list/run scoping). */
  departmentForPost: (postId: string) => DepartmentConfig | undefined
  /** The config department for a catalog ENTRY (dept_exec default cwd). */
  departmentForEntry: (entry: PostEntry) => DepartmentConfig | undefined
  /** The shared active-members output schema (deploy/retire renders). */
  activeMembersSchema: {
    readonly type: 'array'
    readonly required: true
    readonly items: {
      readonly type: 'object'
      readonly additionalProperties: false
      readonly properties: {
        readonly agentId: { readonly type: 'string'; readonly required: true }
        readonly kind: { readonly type: 'string'; readonly enum: readonly ['head', 'worker', 'host']; readonly required: true }
        readonly title: { readonly type: 'string'; readonly required: true }
        readonly state: { readonly type: 'string'; readonly enum: readonly ['running', 'idle', 'sleeping', 'offline']; readonly required: true }
      }
    }
  }
  /** The compact ONE-LINE active-roster suffix shared by deploy/retire renders. */
  renderActiveRoster: (members: ReadonlyArray<{ agentId: string; kind: string; title: string }>) => string
  /** The live active-catalog members builder (post-mutation roster echo). */
  activeCatalogMembers: () => Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }>
  /** The memo own-layer tool builder (registered on every post). */
  memoWriteTool: (hostPlane: boolean) => ReturnType<typeof defineTool>
  /** The legacy dept_post_retire tool object (head own-layer). */
  postRetireTool: ReturnType<typeof defineTool>
  /** The head session-title pin (module-scope pure helper, passed by ref). */
  pinSessionTitle: (session: Session, title: string) => 'pinned' | 'already-titled' | 'failed'
  /** The bundle's worker template constants. */
  WORKER_PRESET_ID: string
  WORKER_AGENT_OPTIONS: AgentOptionsLike
  /** The dept_exec module-scope runners (defined in invoke.ts module scope; not
   * importable without a cycle — passed by reference). */
  execFileP: (file: string, args: readonly string[], options: { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>
  DEPT_EXEC_DEFAULT_ROOTS: readonly string[]
  DEPT_EXEC_TIMEOUT_MS: number
  DEPT_EXEC_MAX_BUFFER: number
  deptExecDenyReason: (command: string, cwd: string, allowedRoots: readonly string[]) => string | undefined
  /** The dept_zstd_read module-scope helpers (invoke.ts module scope — by ref). */
  DEPT_ZSTD_READ_MAX_LINES: number
  runDeptZstdRead: (resolvedPath: string, offset: number, lines: number) => Promise<{ ok: boolean; lines: string[]; truncated: boolean; totalLines: number; error?: string }>
  deptZstdReadDenyReason: (resolvedPath: string, allowedRoots: readonly string[]) => string | undefined
  /** The parallel-monitor state readers (invoke.ts module scope — by ref). */
  resolveParallelMonitorConfig: (parallel: ParallelConfig | undefined) => ParallelMonitorConfig[]
  readParallelMonitorsState: (stateDir: string) => ParallelMonitorsState
  /** The SPAWN surface members this cut consumes (readCalendar/…/dispatch
   * guards — destructured from the SpawnSurface at the spawn factory position,
   * available here by reference). */
  spawn: Pick<SpawnSurface,
    | 'runJobForDepartment'
    | 'spawnWorkerForDepartment'
    | 'readCalendar'
    | 'writeCalendarBestEffort'
    | 'departmentJobExists'
    | 'defaultWorkerTitle'
    | 'workerReasoningContentPreflightError'
    | 'workerPoolerDispatchBlockError'
  >
  /** The LATE-BOUND seams the zone consumes at CALL time (constructed LATER on
   * this apply fiber — the agent-setup/workspace closures in the agent zone,
   * the retire/archive seams in the agent zone, the DeliverySurface at the
   * delivery factory position, the tool arrays in the bus/feedback defs zone;
   * the getters capture the apply-scope bindings and are only dereferenced
   * when a registration/tool execute fires, so the TDZ is never entered at
   * construction). */
  late: {
    /** The agent own-layer setup builder (from the agent zone). */
    workerSetup: (postId: string, roomId: string, role: string, extra?: { persona?: string; taskText?: string; tools?: string[]; department?: DepartmentConfig }) => (agentCtx: Context) => unknown
    /** F5: the fresh incarnation's department workspace cwd. */
    resolveDepartmentWorkspaceCwd: (department: DepartmentConfig | undefined) => Promise<string>
    /** The shared workspace root fallback cwd. */
    resolveWorkspaceRootPath: () => Promise<string>
    /** The F1 shared retire seam (mark + dispose + QD dice + archive). */
    retirePost: (postId: string, callerAgentId: string) => Promise<{ postId: string; retired: true }>
    /** The durable worker-session archiver (idempotent — sidebar row removal). */
    archiveWorkerSession: (sessionId: string) => Promise<boolean>
    /** The DeliverySurface's deliverBusRecord wrapper (deliver + sidecar). */
    deliverBusRecord: DeliverySurface['deliverBusRecord']
    /** The DeliverySurface's boot-opened message store promise. */
    messagesStoreReady: DeliverySurface['messagesStoreReady']
    /** The bus tool array the registry shadows onto every post own-layer. */
    busTools: readonly ReturnType<typeof defineTool>[]
    /** The feedback emit-tool array (universal own-layer). */
    feedbackEmitTools: readonly ReturnType<typeof defineTool>[]
    /** The feedback head-tool array (manager own-layer only). */
    feedbackHeadTools: readonly ReturnType<typeof defineTool>[]
  }
}

/** The tools surface the rest of applyInvoke consumes at the SAME positions as
 * before the extraction (postSetup's own-layer wiring + every downstream
 * reference is unchanged). SUB-BATCH 1: the registry; sub-batches 2-4 extend
 * this surface with the role/setup/workspace/ensureHead + bus/global members. */
export interface ToolsSurface {
  /** Install the post's messaging toolset scoped to `agentCtx` (the post's OWN
   * layer). The same tool bodies the host plane registers, reused for any
   * resident post; `manager: true` additionally registers the department
   * lifecycle/worker/job/monitor tools (+ the M2.3 secretary). */
  installHeadBoardTools: (agentCtx: Context, manager?: boolean, opts?: { allowExec?: boolean }) => HeadToolDisposers
}

/**
 * Build the TOOLS ORCHESTRATION surface on the apply fiber (AGENTS.md rule 4
 * — no module-global mutable state; invoked by applyInvoke at the SAME fiber
 * position where the hoisted zone used to live). The closures below are the
 * ORIGINAL zone closures, moved VERBATIM — the diff is movement-only.
 */
export function createToolsOrchestration(ctx: Context, deps: ToolsFactoryDeps): ToolsSurface {
  const {
    config,
    org,
    stateDir,
    repoRoot,
    agents,
    byPost,
    byHeadHandle,
    coordinatorForPost,
    postIdForChild,
    registerEntry,
    departmentForPost,
    departmentForEntry,
    activeMembersSchema,
    renderActiveRoster,
    activeCatalogMembers,
    memoWriteTool,
    postRetireTool,
    pinSessionTitle,
    WORKER_PRESET_ID,
    WORKER_AGENT_OPTIONS,
    execFileP,
    DEPT_EXEC_DEFAULT_ROOTS,
    DEPT_EXEC_TIMEOUT_MS,
    DEPT_EXEC_MAX_BUFFER,
    deptExecDenyReason,
    DEPT_ZSTD_READ_MAX_LINES,
    runDeptZstdRead,
    deptZstdReadDenyReason,
    resolveParallelMonitorConfig,
    readParallelMonitorsState,
    spawn: {
      runJobForDepartment,
      spawnWorkerForDepartment,
      readCalendar,
      writeCalendarBestEffort,
      departmentJobExists,
      defaultWorkerTitle,
      workerReasoningContentPreflightError,
      workerPoolerDispatchBlockError
    },
    late
  } = deps

  // The LATE seams — resolved AT CALL TIME through the accessor object (the
  // agent-setup/workspace closures, the retire/archive seams, the DeliverySurface,
  // and the tool arrays are built LATER on this fiber; the zone closures
  // dereference these only when a registration or a tool execute actually fires
  // — post-boot — so the apply-scope TDZ is never entered). The CALL seams are
  // thunk arrows of the exact signatures; the store seam is a THENABLE
  // delegating to the surface's boot-opened promise (the zone awaits
  // `messagesStoreReady` as a value); the three for..of tool arrays are
  // delegating ITERABLES (the zone only iterates them at registration time).
  const workerSetup: ToolsFactoryDeps['late']['workerSetup'] = (...args) => late.workerSetup(...args)
  const resolveDepartmentWorkspaceCwd: ToolsFactoryDeps['late']['resolveDepartmentWorkspaceCwd'] = (...args) => late.resolveDepartmentWorkspaceCwd(...args)
  const resolveWorkspaceRootPath: ToolsFactoryDeps['late']['resolveWorkspaceRootPath'] = (...args) => late.resolveWorkspaceRootPath(...args)
  const retirePost: ToolsFactoryDeps['late']['retirePost'] = (...args) => late.retirePost(...args)
  const archiveWorkerSession: ToolsFactoryDeps['late']['archiveWorkerSession'] = (...args) => late.archiveWorkerSession(...args)
  const deliverBusRecord: ToolsFactoryDeps['late']['deliverBusRecord'] = (...args) => late.deliverBusRecord(...args)
  const messagesStoreReady = {
    then(resolve: (value: MessagesStore) => unknown, reject: (reason?: unknown) => unknown) {
      return late.messagesStoreReady.then(resolve, reject)
    }
  } as Promise<MessagesStore>
  const busTools: readonly ReturnType<typeof defineTool>[] = {
    [Symbol.iterator]: () => late.busTools[Symbol.iterator]()
  } as readonly ReturnType<typeof defineTool>[]
  const feedbackEmitTools: readonly ReturnType<typeof defineTool>[] = {
    [Symbol.iterator]: () => late.feedbackEmitTools[Symbol.iterator]()
  } as readonly ReturnType<typeof defineTool>[]
  const feedbackHeadTools: readonly ReturnType<typeof defineTool>[] = {
    [Symbol.iterator]: () => late.feedbackHeadTools[Symbol.iterator]()
  } as readonly ReturnType<typeof defineTool>[]

  // =========================================================================
  // TOOLS ZONE — SUB-BATCH 1 of 4 (hoisted VERBATIM from applyInvoke 3977-4898:
  // the dept_exec runners + the agent toolset registry — the same closures, the
  // same order, the same semantics).
  // =========================================================================
  // --- dept_exec helpers (spec W5-B2, SCOPED shell for department posts) ----
  // The pure guard + the allow-roots are the scope policy; these two helpers
  // build the realpath-resolved root set and run the execFile. The tool is
  // registered in installHeadBoardTools ONLY when the post's role declare-list
  // includes `dept_exec` (see postSetup's allowExec computation below).

  /** The realpath-resolved SET of allowed roots for a dept_exec call: the fixed
   * DEPT_EXEC_DEFAULT_ROOTS, the repo root, the runtime stateDir, the caller's
   * department workspace, any configured org.execRoots, AND any configured
   * org.missionExecRoots (an EXPLICIT, REVOCABLE, AUDITABLE mission-level owner
   * grant that may name an OWNER-PROTECTED surface such as the STABLE home
   * `/opt/dsh/.dsh` for the DURATION of an owner-authorized mission). Each root
   * is realpath'd when it resolves (a symlink root collapses to its target, so
   * the cwd/path comparisons stay strict); an unresolvable root is kept verbatim. */
  const deptExecAllowedRoots = async (department: DepartmentConfig | undefined): Promise<string[]> => {
    const raw = new Set<string>(DEPT_EXEC_DEFAULT_ROOTS)
    raw.add(repoRoot)
    if (typeof stateDir === 'string' && stateDir.trim() !== '') raw.add(stateDir)
    const deptCwd = await resolveDepartmentWorkspaceCwd(department)
    if (deptCwd !== '') raw.add(deptCwd)
    for (const entry of (org.execRoots ?? [])) {
      if (typeof entry === 'string' && entry.trim() !== '') raw.add(entry.trim())
    }
    // MISSION-LEVEL owner grant: an explicit org.missionExecRoots entry adds the
    // surface (e.g. the STABLE home /opt/dsh/.dsh) to the allowed roots for the
    // DURATION of an OWNER-AUTHORIZED mission. It is EXPLICIT (an absent key
    // keeps the default deny — the stable home stays protected), AUDITABLE
    // (config-recorded, never an env default) and REVOCABLE (remove the entry).
    for (const entry of (org.missionExecRoots ?? [])) {
      if (typeof entry === 'string' && entry.trim() !== '') raw.add(entry.trim())
    }
    const resolved: string[] = []
    for (const root of raw) {
      try {
        resolved.push(await realpath(root))
      } catch {
        resolved.push(root)
      }
    }
    return resolved
  }

  /** Run ONE scoped shell command through `bash -lc` with a MINIMAL sanitized
   * env (PATH/HOME/LANG only — nothing else is leaked to the child). Returns
   * {ok, exitCode, stdout, stderr}; a non-zero exit or a killed command is a
   * normal `ok:false` result, never a throw (the caller decides the surface). */
  const runDeptExec = async (command: string, cwd: string): Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }> => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/root',
      LANG: process.env.LANG ?? 'C'
    }
    try {
      const { stdout, stderr } = await execFileP('bash', ['-lc', command], {
        cwd,
        timeout: DEPT_EXEC_TIMEOUT_MS,
        maxBuffer: DEPT_EXEC_MAX_BUFFER,
        env
      })
      return { ok: true, exitCode: 0, stdout, stderr }
    } catch (error: unknown) {
      const e = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean }
      const exitCode = typeof e.code === 'number' ? e.code : null
      return {
        ok: false,
        exitCode,
        stdout: typeof e.stdout === 'string' ? e.stdout : '',
        stderr: typeof e.stderr === 'string' ? e.stderr : (e.killed === true ? 'command killed (timeout)' : String(error ?? ''))
      }
    }
  }

  /** markdown renderer for the dept_exec result: exit code + stdout/stderr in
   * fenced code blocks, each TRUNCATED to a cap with an explicit marker. */
  const deptExecRender = (_args: unknown, value: { ok: boolean; exitCode: number | null; stdout: string; stderr: string }): Array<{ type: 'text'; text: string }> => {
    const MAX = 8000
    const truncate = (s: string): string => {
      const trimmed = String(s ?? '')
      return trimmed.length > MAX ? `${trimmed.slice(0, MAX)}\n… [truncated ${trimmed.length} chars]` : trimmed
    }
    const parts: string[] = [`exit code ${value.exitCode}${value.ok ? '' : ' (FAILED)'}`]
    if (value.stdout !== '') parts.push(`stdout:\n\`\`\`\n${truncate(value.stdout)}\n\`\`\``)
    if (value.stderr !== '') parts.push(`stderr:\n\`\`\`\n${truncate(value.stderr)}\n\`\`\``)
    return [{ type: 'text', text: parts.join('\n') } as const]
  }

  /** Install the post's messaging toolset scoped to `agentCtx` (the post's OWN
   * layer — no toolFilter needed for a root agent). The same tool bodies the
   * host plane registers, reused for any resident post: send_message,
   * agent_messages, dept_who, dept_memo_write, dept_sleep. dept_sleep's head
   * version also disposes the post's AgentHandle (the plugin's byHeadHandle
   * map) after marking sleepEpoch.
   *
   * Batch 3a — `manager: true` (a department HEAD, not a worker) additionally
   * registers the department-lifecycle tools `dept_post_create`,
   * `dept_post_retire` (legacy) AND the F3 department-scoped worker tools
   * `dept_worker_spawn` / `dept_worker_retire`, so a head can create/retire
   * the WORKERS of its own department. A worker (`manager: false`) gets ONLY
   * the messaging tools — never the create/retire life-cycle controls. These
   * create/worker-spawn/worker-retire controls register ONLY in the head
   * own-layer here; the host plane never exposes them. (The one host-plane
   * exception is the global `dept_post_retire`, registered separately below.) */
  const installHeadBoardTools = (agentCtx: Context, manager = false, opts: { allowExec?: boolean } = {}): HeadToolDisposers => {
    const disposers: Array<() => void> = []

    // Batch B2 — the agent-messaging bus tools (send_message / agent_messages /
    // dept_who) registered on the post's OWN layer: the own-layer registration
    // SHADOWS the globally-registered harness native `send_message` for this
    // agent (the harness override seam — same-layer duplicates throw, scoped
    // registrations win), and postSetup's lean `restrict({allow:[]})` masks the
    // globals anyway so this own layer is the ONLY visible toolset.
    for (const tool of busTools) disposers.push(agentCtx.tools.register(tool))

    // dshd-feedback phase (universal, ACL-free write): the EMIT tool
    // (`dept_feedback`) registers on EVERY post's OWN layer (head AND worker —
    // any agent may emit feedback). fb-18 (QH backlog): `dept_feedback_list` +
    // `dept_feedback_update` register ONLY in a HEAD's own layer (manager:true)
    // — a worker NEVER sees them, so the worker-DENIED ACL becomes a STRUCTURAL
    // absence (the tool is simply not in the worker toolset) instead of a
    // runtime `execute` reject; the QH-authority checks stay in `execute` as
    // defense-in-depth for the host plane / any legacy registration. The host
    // plane registers all three globally (see below).
    for (const tool of feedbackEmitTools) disposers.push(agentCtx.tools.register(tool))
    if (manager) {
      for (const tool of feedbackHeadTools) disposers.push(agentCtx.tools.register(tool))
    }

    // --- W1 (spec 004 §5.7 + ROADMAP W1): calendar tools — dept_calendar_add /
    // dept_calendar_list / dept_calendar_remove. Registered on EVERY post's OWN
    // layer (head AND worker — the runtime agenda is department-scoped, not
    // head-only), right where the bus tools register. The runtime store is the
    // shared `<stateDir>/calendar.json` (dept_* tools and the agenda/list
    // dispatch read the same file). An ad-hoc entry fires ONCE (no recurrence);
    // `jobId?` links it to a department job so the scheduler runs that job when
    // the entry's `at` passes (instead of only notifying the head). ------------
    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_calendar_add',
      description: 'Add ONE ad-hoc calendar entry to the SHARED department agenda (spec 004 §5.7 — a single <stateDir>/calendar.json across every department, so the agenda is unified/global; the entry is stamped with `departmentId` = your department). `label` (non-empty) + `at` (a parseable ISO datetime) are REQUIRED; `jobId` (optional) links the entry to a KNOWN job of YOUR department, so the scheduler RUNS that job when `at` passes instead of only notifying your head. Entry: {id, label, at, jobId?, createdBy (your post id), createdAt, fired, departmentId}. Ad-hoc entries fire ONCE — no recurrence (a job\'s recurrence lives in its own `schedule`). Every post (head AND worker) of the department may add; the entry is owned by its creator.',
      parameters: {
        label: { type: 'string', required: true, description: 'The entry label (non-empty, e.g. "Review W4 batch").' },
        at: { type: 'string', required: true, description: 'The schedule time as a parseable ISO datetime (e.g. "2026-08-24T09:00:00.000Z").' },
        jobId: { type: 'string', description: 'Optional job id of YOUR department — when it passes, the scheduler runs the job.' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            label: { type: 'string', required: true },
            at: { type: 'string', required: true },
            jobId: { type: 'string' },
            createdBy: { type: 'string', required: true },
            createdAt: { type: 'number', required: true },
            fired: { type: 'boolean' },
            departmentId: { type: 'string' }
          }
        },
        render: (_args, value) => [{ type: 'text', text: `calendar added: "${value.label}" @ ${value.at} (id ${value.id}${value.departmentId !== void 0 ? `, ${value.departmentId}` : ''})` } as const]
      },
      async execute(args, exec): Promise<{ id: string; label: string; at: string; createdBy: string; createdAt: number; jobId?: string; fired?: boolean; departmentId?: string }> {
        const agent = exec.agent
        if (!agent) throw new Error('dept_calendar_add requires a calling agent (exec.agent was undefined)')
        const postId = postIdForChild(agent.id as string)
        if (postId === void 0) throw new Error('[deepartments] dept_calendar_add is for a department MEMBER (a registered head or worker), not the host')
        const label = String(args.label ?? '').trim()
        if (label === '') throw new Error('[deepartments] dept_calendar_add: `label` is required (non-empty)')
        const at = String(args.at ?? '').trim()
        if (at === '' || Number.isNaN(Date.parse(at))) throw new Error('[deepartments] dept_calendar_add: `at` must be a parseable ISO datetime')
        const callerEntry = byPost.get(postId)
        const department = callerEntry === void 0 ? undefined : departmentForEntry(callerEntry)
        const jobIdRaw = String(args.jobId ?? '').trim()
        if (jobIdRaw !== '') {
          if (department === void 0 || !(await departmentJobExists(department, jobIdRaw))) {
            throw new Error(`[deepartments] dept_calendar_add: jobId "${jobIdRaw}" is not a KNOWN job of your department — it must be a file <jobId>.md in the department jobDir`)
          }
        }
        const id = randomUUID()
        const entry: CalendarEntry = {
          id,
          label,
          at,
          createdBy: postId,
          createdAt: Date.now(),
          fired: false,
          ...(jobIdRaw !== '' ? { jobId: jobIdRaw } : {}),
          ...(department !== void 0 ? { departmentId: department.id } : {})
        }
        const state = readCalendar()
        state.entries.push(entry)
        await writeCalendarBestEffort(state)
        return { id, label, at, createdBy: postId, createdAt: entry.createdAt ?? Date.now(), fired: false, ...(jobIdRaw !== '' ? { jobId: jobIdRaw } : {}), ...(department !== void 0 ? { departmentId: department.id } : {}) }
      }
    })))

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_calendar_list',
      description: 'List the runtime calendar entries of the SHARED department agenda (spec 004 §5.7 — a single <stateDir>/calendar.json across every department; the agenda is unified/global). With NO filter it returns the FULL global agenda (every department\'s entries). Optionally filter an inclusive `from`/`to` window (ISO datetimes; entries with `at` in [from, to]) OR by `departmentId` (only entries of that department) — or both. Returns {count, entries}: each entry {id, label, at, jobId?, createdBy?, createdAt?, fired?, departmentId?}. Every post of the department may read the agenda.',
      parameters: {
        from: { type: 'string', description: 'Inclusive lower bound (ISO datetime); omit for open start.' },
        to: { type: 'string', description: 'Inclusive upper bound (ISO datetime); omit for open end.' },
        departmentId: { type: 'string', description: 'Optional: filter to entries stamped with ONE department id. Omit for the FULL shared (global) agenda. Entries without a departmentId are NOT matched by a filter.' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'number', required: true },
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  label: { type: 'string', required: true },
                  at: { type: 'string', required: true },
                  jobId: { type: 'string' },
                  createdBy: { type: 'string' },
                  createdAt: { type: 'number' },
                  fired: { type: 'boolean' },
                  departmentId: { type: 'string' }
                }
              }
            }
          }
        },
        render: (_args, value) => [{ type: 'text', text: `calendar (${value.count}):\n${value.entries.map((e) => `  - ${e.label} @ ${e.at}${e.departmentId !== void 0 ? ` [${e.departmentId}]` : ''}${e.jobId !== void 0 ? ` (job ${e.jobId})` : ''}${e.fired === true ? ' [fired]' : ''}`).join('\n')}` } as const]
      },
      async execute(args): Promise<{ count: number; entries: CalendarEntry[] }> {
        const state = readCalendar()
        const fromRaw = String(args.from ?? '').trim()
        const toRaw = String(args.to ?? '').trim()
        const departmentIdRaw = String(args.departmentId ?? '').trim()
        const departmentId = departmentIdRaw === '' ? undefined : departmentIdRaw
        const from = fromRaw === '' || Number.isNaN(Date.parse(fromRaw)) ? undefined : Date.parse(fromRaw)
        const to = toRaw === '' || Number.isNaN(Date.parse(toRaw)) ? undefined : Date.parse(toRaw)
        let entries = state.entries
        if (from !== undefined) entries = entries.filter((e) => Date.parse(e.at) >= from)
        if (to !== undefined) entries = entries.filter((e) => Date.parse(e.at) <= to)
        // B2 (spec W5): an optional department filter — only entries stamped with
        // that departmentId match; entries WITHOUT a departmentId are excluded by
        // a filter. Default (no filter) = the FULL shared (global) agenda.
        if (departmentId !== undefined) entries = entries.filter((e) => e.departmentId === departmentId)
        return { count: entries.length, entries }
      }
    })))

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_calendar_remove',
      description: 'Remove a runtime calendar entry of the SHARED department agenda by id (spec 004 §5.7 — the single <stateDir>/calendar.json). ACL: the entry CREATOR (its `createdBy`) OR the department HEAD may remove it; ANY other caller is DENIED (an entry is never deleted by a third member). Returns the removed entry; an unknown id is a loud error.',
      parameters: {
        id: { type: 'string', required: true, description: 'The entry id (from dept_calendar_add / dept_calendar_list).' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            label: { type: 'string', required: true },
            at: { type: 'string', required: true },
            jobId: { type: 'string' },
            createdBy: { type: 'string' },
            createdAt: { type: 'number' },
            fired: { type: 'boolean' },
            departmentId: { type: 'string' }
          }
        },
        render: (_args, value) => [{ type: 'text', text: `calendar removed: "${value.label}" @ ${value.at} (id ${value.id})` } as const]
      },
      async execute(args, exec): Promise<{ id: string; label: string; at: string; createdBy?: string; createdAt?: number; jobId?: string; fired?: boolean; departmentId?: string }> {
        const agent = exec.agent
        if (!agent) throw new Error('dept_calendar_remove requires a calling agent (exec.agent was undefined)')
        const postId = postIdForChild(agent.id as string)
        if (postId === void 0) throw new Error('[deepartments] dept_calendar_remove is for a department MEMBER (a registered head or worker), not the host')
        const id = String(args.id ?? '').trim()
        if (id === '') throw new Error('[deepartments] dept_calendar_remove: `id` is required')
        const state = readCalendar()
        const index = state.entries.findIndex((entry) => entry.id === id)
        if (index < 0) throw new Error(`[deepartments] dept_calendar_remove: no calendar entry with id "${id}"`)
        const entry = state.entries[index]
        // ACL: the creator OR the department head of the entry's department.
        const creatorEntry = byPost.get(entry.createdBy ?? '')
        const department = creatorEntry === void 0 ? undefined : departmentForEntry(creatorEntry)
        const isCreator = entry.createdBy === postId
        const isHead = department?.coordinator?.postId === postId
        if (!isCreator && !isHead) {
          throw new Error(`[deepartments] dept_calendar_remove: only the entry creator (${entry.createdBy ?? '(unknown)'}) or the department head may remove it — you are neither`)
        }
        state.entries.splice(index, 1)
        await writeCalendarBestEffort(state)
        return { id: entry.id, label: entry.label, at: entry.at, ...(entry.createdBy !== void 0 ? { createdBy: entry.createdBy } : {}), ...(entry.createdAt !== void 0 ? { createdAt: entry.createdAt } : {}), ...(entry.jobId !== void 0 ? { jobId: entry.jobId } : {}), ...(entry.fired !== void 0 ? { fired: entry.fired } : {}), ...(entry.departmentId !== void 0 ? { departmentId: entry.departmentId } : {}) }
      }
    })))

    // --- B2 (spec W5): dept_exec — the SCOPED shell tool for department posts.
    // Registered on the post's OWN layer (same place as dept_calendar_add), but
    // ONLY when the post's role allow-list declares `dept_exec` (postSetup
    // passes allowExec=true for a worker whose role template frontmatter `tools`
    // contains `dept_exec`). A post that does not declare it never sees the tool;
    // a config head (HEAD_BASE_TOOLS, no dept_exec) never registers it; the host
    // never gets it (this own-layer registration is descendants-only). The scope
    // guard runs BEFORE any execution — a denied command/cwd is a clean error
    // and the shell is never invoked.
    if (opts.allowExec === true) {
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_exec',
        description: 'Execute ONE shell command, scoped to your department (spec W5-B2). Runs `bash -lc <command>` with a sanitized env (PATH/HOME/LANG only) inside a scoped root. The command runs in your department workspace cwd by default; an explicit `cwd` must be inside a scoped root. Every command + cwd is guarded BEFORE execution: a denied token (reboot/sudo/…), a mutating `systemctl` form (only the read-only `systemctl is-active <unit>` is permitted), a reference to the protected stable profile (`/opt/dsh/.dsh`) or an absolute path outside a scoped root is DENIED (out of scope — escalate via the Asistente / owner approval). For an OWNER-AUTHORIZED mission, an explicit mission grant (`org.missionExecRoots`) may allow `/opt/dsh/.dsh`; otherwise escalate via the Asistente/owner (the Asistente-direct path is the alternative). For a department WORKER whose role template declares this tool; it is never exposed to the host or a config head. Prefer the native read/glob/grep tools for reading/searching FILES; use dept_exec only for zstd/git/shell tooling that the native tools cannot do. Output: {ok, exitCode, stdout, stderr} — a non-zero exit is ok:false, never a throw.',
        parameters: {
          command: { type: 'string', required: true, description: 'The shell command to run (non-empty). Guarded before execution.' },
          cwd: { type: 'string', description: 'Working directory; default = your department workspace cwd. Must be inside a scoped root.' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
              stdout: { type: 'string', required: true },
              stderr: { type: 'string', required: true }
            }
          },
          render: deptExecRender
        },
        async execute(args, exec): Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_exec requires a calling agent (exec.agent was undefined)')
          const postId = postIdForChild(agent.id as string)
          if (postId === void 0) throw new Error('[deepartments] dept_exec is for a department MEMBER (a registered head or worker), not the host')
          const command = String(args.command ?? '').trim()
          if (command === '') throw new Error('[deepartments] dept_exec: `command` is required (non-empty)')
          const callerEntry = byPost.get(postId)
          const department = callerEntry === void 0 ? undefined : departmentForEntry(callerEntry)
          const cwdRaw = String(args.cwd ?? '').trim()
          const deptCwd = await resolveDepartmentWorkspaceCwd(department)
          const defaultCwd = deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath()
          const cwd = cwdRaw !== '' ? cwdRaw : defaultCwd
          const allowedRoots = await deptExecAllowedRoots(department)
          const resolvedCwd = await realpath(cwd).catch(() => cwd)
          // The scope guard runs BEFORE any execution — a deny is a clean error.
          const deny = deptExecDenyReason(command, resolvedCwd, allowedRoots)
          if (deny !== void 0) throw new Error(`[deepartments] dept_exec: ${deny}`)
          return runDeptExec(command, resolvedCwd)
        }
      })))

      // --- E2 (QH 2026-08-28): dept_zstd_read — the READ-ONLY .zstd session
      // reader for department posts. Registered on the post's OWN layer in the
      // SAME `allowExec` gate as dept_exec (a role that declares `dept_exec`
      // also gets dept_zstd_read; a post that does not declare it never sees
      // either; the host / a config head never gets it). Decodes ONE
      // .zstd-compressed file via `zstd -dc` Node-side (child_process.spawn —
      // no user shell), SÓLO LECTURA, scoped to the SAME allowed roots as
      // dept_exec (a path outside the roots → DENIED before any decode), with
      // a BOUNDED + STREAMED output (fb-19: lines parsed on the fly — no
      // full-buffered decode, so a >4MB session streams fine; a 32 MB
      // decompressed budget aborts with a CLEAR error; a huge session never
      // hangs or buffers unbounded). Args {path, offset?, lines?}: offset =
      // the first line index (0-based) of the window, lines = the max lines to
      // return (default 100, cap 500).
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_zstd_read',
        description: 'Read a WINDOW of a .zstd-compressed file (e.g. a raw .jsonl.zstd session artifact) WITHOUT a shell: decodes the file via `zstd -dc` Node-side (child_process.spawn, no user shell), SÓLO LECTURA (never writes). Scoped to the SAME allowed roots as dept_exec (the resolved `path` must be inside a scoped root; the stable profile `/opt/dsh/.dsh` is protected unless a mission grant names it — a path outside the roots is DENIED before any decode). Args {path, offset?, lines?}: `offset` (default 0) is the 0-based first line of the window; `lines` (default 100, cap 500) is the max lines to return. Output is BOUNDED and STREAMED (fb-19): lines are parsed on the fly (no full-buffered decode), a 4000-char per-line cap + a 30 s decode timeout apply, and a session beyond the 32 MB decompressed budget is aborted with the CLEAR error «session exceeds the zstd-read budget — use dept_exec for full streaming» (never a raw maxBuffer exception). Returns {ok, lines, truncated, totalLines}: the decoded line window. For a department WORKER whose role template declares dept_exec (IPD builder/reviewer/explore-deep + quality-inspector); never exposed to the host or a config head.',
        parameters: {
          path: { type: 'string', required: true, description: 'The absolute path of the .zstd-compressed file to read (must resolve inside a scoped dept_exec root).' },
          offset: { type: 'number', description: 'The 0-based first line index of the window (default 0).' },
          lines: { type: 'number', description: 'The max lines to return (default 100, capped at 500).' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              lines: { type: 'array', required: true, items: { type: 'string' } },
              truncated: { type: 'boolean', required: true },
              totalLines: { type: 'number', required: true },
              error: { type: 'string' }
            }
          },
          render: (_args, value) => {
            if (value.ok === false) return [{ type: 'text', text: `dept_zstd_read failed: ${value.error ?? 'unknown error'}` } as const]
            const cap = 8000
            const joined = value.lines.join('\n')
            const body = joined.length > cap ? `${joined.slice(0, cap)}\n… [truncated ${joined.length} chars]` : joined
            return [{ type: 'text', text: `dept_zstd_read: ${value.lines.length} of ${value.totalLines} line(s)${value.truncated ? ' (window truncated)' : ''}\n\`\`\`\n${body}\n\`\`\`` } as const]
          }
        },
        async execute(args, exec): Promise<{ ok: boolean; lines: string[]; truncated: boolean; totalLines: number; error?: string }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_zstd_read requires a calling agent (exec.agent was undefined)')
          const postId = postIdForChild(agent.id as string)
          if (postId === void 0) throw new Error('[deepartments] dept_zstd_read is for a department MEMBER (a registered head or worker), not the host')
          const pathRaw = String(args.path ?? '').trim()
          if (pathRaw === '') throw new Error('[deepartments] dept_zstd_read: `path` is required')
          const offsetRaw = Number(args.offset ?? 0)
          const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.trunc(offsetRaw) : 0
          const linesRaw = Number(args.lines ?? 100)
          const lines = Math.min(Math.max(Number.isFinite(linesRaw) && linesRaw > 0 ? Math.trunc(linesRaw) : 100, 1), DEPT_ZSTD_READ_MAX_LINES)
          const callerEntry = byPost.get(postId)
          const department = callerEntry === void 0 ? undefined : departmentForEntry(callerEntry)
          const allowedRoots = await deptExecAllowedRoots(department)
          // The scope guard runs BEFORE any decode — a denied path is a clean
          // error and zstd is never invoked (realpath collapses `..`/symlinks
          // FIRST, exactly like dept_exec's canonicalization).
          const resolvedPath = await realpath(pathRaw).catch(() => pathRaw)
          const deny = deptZstdReadDenyReason(resolvedPath, allowedRoots)
          if (deny !== void 0) throw new Error(`[deepartments] dept_zstd_read: ${deny}`)
          return runDeptZstdRead(resolvedPath, offset, lines)
        }
      })))
    }


    disposers.push(agentCtx.tools.register(memoWriteTool(false)))

    // LOTE A (owner decision 2026-08-27 — head/worker sleep RETIRED): the
    // post own-layer dept_sleep is deliberately NOT registered here. Heads and
    // workers stay `idle|running`; only the HOST plane keeps dept_sleep
    // (spec 002 rotation). The unregistered `sleepMember`/`sleepAll` remain in
    // lifecycle.ts as dead code (R6 — never remove; a post entry carrying a
    // legacy `sleepEpoch` on disk still resurrects fresh on wake).
    // (sleepTool(false) removed — head/worker sleep is hosts-only.)

    // --- Batch 3a: department-lifecycle tools — HEAD (manager) only ------
    // A department HEAD creates and retires DISPOSABLE WORKERS. These register
    // ONLY here, in the head own-layer, so a worker (manager:false) and a HOST
    // (global plane) never see them — the "host-CANNOT" invariant is
    // structural (tool simply absent). B3 cutover: no room parameter — the
    // workers live in the agent CATALOG (posts.json); the first message is
    // delivered via the BUS (messages.jsonl + deliverBusRecord), not the board.
    if (manager) {
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_post_create',
        description: 'Create a DISPOSABLE department worker: spawn a fresh root agent (sessionId worker-<postId>-<uuid> — a UNIQUE session, never reused across a retired-and-respawned same-role worker), register it in posts.json as a disposable entry (provider:"worker"; F1: YOU are recorded as its manager — managerId — and your config department as its departmentId), and deliver its first message via the messaging bus. The worker works your assigned task and sleeps when done; you retire it later with dept_post_retire. The first message (firstMessage, or prompt) is persisted as a durable bus message addressed to the worker (the `deepartments/post-created` signal). DEPRECATED — use dept_worker_spawn (persona+tools+task) instead; kept registered for legacy compatibility (R6).',
        parameters: {
          postId: { type: 'string', required: true, description: 'Short slug for the worker, e.g. "researcher-alpha" (unique; not already registered).' },
          role: { type: 'string', required: true, description: 'The worker role, e.g. "rank-and-file researcher".' },
          prompt: { type: 'string', description: 'Initial assignment to the worker (alias of firstMessage).' },
          firstMessage: { type: 'string', description: 'The worker\'s initial assignment, delivered as a durable bus message addressed to it.' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              postId: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              activeMembers: activeMembersSchema
            }
          },
          render: (_args, value) => [{ type: 'text', text: `created worker ${value.postId} (session ${value.sessionId}; ${renderActiveRoster(value.activeMembers)})` } as const]
        },
        async execute(args, exec): Promise<{ postId: string; sessionId: string; activeMembers: Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }> }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_post_create requires a calling agent (exec.agent was undefined)')
          if (agents === void 0) throw new Error('[deepartments] dept_post_create requires the agents service')
          const headId = postIdForChild(agent.id as string)
          if (headId === void 0) throw new Error('[deepartments] dept_post_create is for a department HEAD (registered post), not the host')
          const headEntry = byPost.get(headId)
          if (headEntry === void 0) throw new Error(`[deepartments] dept_post_create: head "${headId}" is not registered`)
          // postId must be unique — reject an already-registered post AND a
          // configured head (a worker must never shadow a head's identity).
          if (byPost.has(args.postId)) throw new Error(`[deepartments] dept_post_create: postId "${args.postId}" is already registered`)
          if (coordinatorForPost(args.postId) !== void 0) throw new Error(`[deepartments] dept_post_create: postId "${args.postId}" is a configured department head, not a worker`)
          const sessionId = mintWorkerSessionId(args.postId)
          if (agents.get(String(SessionId(sessionId))) !== void 0) throw new Error(`[deepartments] dept_post_create: a live agent already exists for session "${sessionId}"`)
          const firstMessage = args.firstMessage ?? args.prompt
          // F10 (spec 004 §9.1): the legacy dept_post_create emits a department
          // worker with NO role template (no persona/tools) — it still gets the
          // department-aware setup (architecture section), and NO role tools
          // (pre-F10 behavior: board-only, `allow: []`).
          const department = departmentForPost(headId)
          const setup = workerSetup(args.postId, headEntry.roomId, args.role, { department })
          // F5 (spec 004 §6.2 L1): the worker of a department WITH a configured
          // workspacePath is created under that path (its OWN sidebar folder,
          // ensured first); otherwise the shared workspace root (the
          // resolveDepartmentWorkspaceCwd '' fallback — pre-F1 behavior).
          const deptCwd = await resolveDepartmentWorkspaceCwd(department)
          // fb-9: the legacy dept_post_create path shares the SAME DISPATCH
          // pre-flight as the two spawn engines — a reasoning-enabled provider
          // without compat.requiresReasoningContentOnAssistantMessages=true
          // rejects
          // HERE, BEFORE any agents.create (never a mid-mission 400; nothing
          // is registered).
          const preflightError = workerReasoningContentPreflightError()
          if (preflightError !== undefined) throw new Error(`[deepartments] ${preflightError}`)
          // DISPATCH-HARDENING (QH «429-primer-call»): the pooler-capacity
          // pre-check on the LEGACY seam too — the SAME early rejection, BEFORE
          // any agents.create (nothing is registered); an at-quota pool never
          // spawns a worker whose first call would 429/503.
          const poolerDispatchBlock = workerPoolerDispatchBlockError()
          if (poolerDispatchBlock !== undefined) throw new Error(`[deepartments] ${poolerDispatchBlock}`)
          const handle = await agents.create({
            sessionId: String(SessionId(sessionId)),
            meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: WORKER_PRESET_ID },
            agentOptions: WORKER_AGENT_OPTIONS,
            setup
          })
          // F1 (spec 004 §4.1/§4.2): RECORD THE CREATOR. The pre-F1 code copied
          // only the head's INERT roomId; the department link now lives in
          // `departmentId` (the config department of the creating head — the
          // worker is, structurally, a worker of THAT department) and the
          // creating head itself in `managerId` ("my workers" scope). roomId
          // stays as the inert legacy field (schema stability, spec §4.1
          // "unchanged"); a HEAD WITHOUT a config department gets no
          // departmentId (legacy-path compatibility — its workers are
          // department-less, host-retireable only).
          registerEntry({
            postId: args.postId,
            sessionId: String(SessionId(sessionId)),
            roomId: headEntry.roomId,
            agentPreset: WORKER_PRESET_ID,
            provider: 'worker',
            role: args.role,
            managerId: headId,
            ...(department !== void 0 ? { departmentId: department.id } : {})
          })
          byHeadHandle.set(String(SessionId(sessionId)), handle)
          // F3 pin (owner decision 2026-08-23): the legacy create path deploys a
          // worker too, so it pins the SAME "Rol: Misión" default sidebar title
          // (there is no title/firstMessage override — the role + the first
          // message are the mission source). Non-fatal: a failed pin only logs.
          const titleSession = ctx.sessions.get(SessionId(sessionId))
          if (titleSession !== void 0) {
            const title = defaultWorkerTitle(args.role, firstMessage, void 0, args.postId)
            const titlePin = pinSessionTitle(titleSession, title)
            if (titlePin === 'pinned') {
              ctx.logger.info(`[deepartments] dept_post_create: pinned worker session title "${title}" (${sessionId})`)
            } else if (titlePin === 'failed') {
              ctx.logger.warn(`[deepartments] dept_post_create: worker session title pin failed for ${sessionId} (non-fatal — worker registration continues)`)
            }
          }
          // Deliver the initial assignment (or a creation note) as a DURABLE
          // BUS message from the head addressed to the worker — this IS the
          // `deepartments/post-created` signal; the bus delivery wakes the
          // worker (always-wake, D4). No direct followup needed; the store is
          // durable.
          const text = firstMessage ?? `[created] worker "${args.postId}" (${args.role || 'department worker'}) is registered. You are disposable — work your assigned task, then dept_memo_write and report to your head; your head retires you when done.`
          const store = await messagesStoreReady
          const record = await store.append({
            from: headId,
            to: [args.postId],
            text,
            kind: 'agent'
          })
          await deliverBusRecord(record, args.postId, agent.id as string, agent.id as string, exec.signal)
          return { postId: args.postId, sessionId: String(SessionId(sessionId)), activeMembers: activeCatalogMembers() }
        }
      })))

      disposers.push(agentCtx.tools.register(postRetireTool))

      // --- F4 (spec 004 §5.4-§5.5, D7): JOB tools — dept_job_list /
      // dept_job_run (registered ONLY here, in the head own-layer: the RH
      // executes its department's VERSIONED jobs manually; the host plane
      // never sees them — D2 structural, dept_worker_spawn parity; a worker
      // (manager:false) never sees them either). The department is DERIVED
      // from the caller (a head can only list/run the jobs of ITS OWN
      // department — the jobDir is resolved from the caller's config
      // department, spec §5.4 "own department only" by construction). Job
      // definitions are plain repo files: `docs/departments/<dept-id>/jobs/
      // <slug>.md` (see docs/departments/research/README.md — the F4a job
      // files), read from the repo — the SAME repo tree the F3 role
      // templates come from (`repoRoot`, the plugin's bundle dir floor).
      // W1 — the scheduler IS real: `schedule` is a job's cadence (a 5-field
      // cron auto-fires via the scheduler daemon; a non-cron human schedule is
      // displayed but never triggers). A manual dept_job_run still works.
      // ---------------------------------------------------------------------
      // The job reader (parseJobDefFrontmatter / jobDirFor / readJobDefinitionFile
      // — module-level, shared with the agenda/dispatch + scheduler) and the job
      // idempotency/role guards (validateJobRole / runningJobWorker — apply-scope,
      // shared with the scheduler's runJobForDepartment) are hoisted: this head
      // own-layer uses the SAME readers as the REST of the plugin, so list/run
      // and the agenda never drift. `schedule` is parsed + displayed (and the
      // scheduler below now also fires cron-style schedules) — it is no longer
      // purely informational. -----------------------------------------------
      /** One listed job (spec 004 §5.5): the frontmatter fields, the
       * resolved repo path, `status: "manual-run"` (the field is a holdover —
       * a cron-scheduled job auto-fires regardless; see the scheduler daemon)
       * and an `error` carrying the reason when the definition's frontmatter
       * is invalid (per-entry — the list never fails as a whole). */
      interface JobListItem {
        id: string
        path: string
        status?: 'manual-run'
        title?: string
        role?: string
        description?: string
        schedule?: string
        owner?: string
        outbox?: string
        error?: string
      }

      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_job_list',
        description: 'List the versioned JOB definitions of YOUR department (spec 004 §5.5): scan the department jobDir (config org.departments[].jobDir — repo-relative or absolute; default <repoRoot>/docs/departments/<your-department-id>/jobs) and parse each *.md definition frontmatter (id/title/role/description/schedule?/owner/outbox?). Returns the resolved jobDir + the list {id, title, role, description, schedule, status:"manual-run", owner, path} per job; a definition with INVALID frontmatter is reported PER-ENTRY with an error (the whole list is never failed). `schedule` is the job cadence (W1): a 5-field cron (e.g. `0 9 * * *`) AUTO-FIRES via the plugin scheduler daemon; a non-cron (human) schedule never auto-fires — that job runs MANUALLY via dept_job_run. Registered ONLY in the head own-layer.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              jobDir: { type: 'string', required: true },
              jobs: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    path: { type: 'string', required: true },
                    status: { type: 'string' },
                    title: { type: 'string' },
                    role: { type: 'string' },
                    description: { type: 'string' },
                    schedule: { type: 'string' },
                    owner: { type: 'string' },
                    outbox: { type: 'string' },
                    error: { type: 'string' }
                  }
                }
              }
            }
          },
          render: (_args, value) => {
            const lines = value.jobs.map((job) => {
              if (job.error !== void 0) return `  - ${job.id} (${job.path}) — ERROR: ${job.error}`
              const meta = [job.status, job.role].filter(Boolean).join(', ')
              return `  - ${job.id} — "${job.title}" (${meta}) [${job.path}]`
            })
            return [{ type: 'text', text: `jobs (${value.jobs.length}) in ${value.jobDir}:\n${lines.join('\n')}` } as const]
          }
        },
        async execute(_args, exec): Promise<{ jobDir: string; jobs: JobListItem[] }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_job_list requires a calling agent (exec.agent was undefined)')
          const headId = postIdForChild(agent.id as string)
          if (headId === void 0) throw new Error('[deepartments] dept_job_list is for a department HEAD (registered post), not the host')
          const headEntry = byPost.get(headId)
          if (headEntry === void 0) throw new Error(`[deepartments] dept_job_list: head "${headId}" is not registered`)
          // A head WITHOUT a config department cannot list jobs (the jobDir is
          // resolved from ITS department — spec §5.4 own-department-only).
          const department = departmentForPost(headId)
          if (department === void 0) throw new Error(`[deepartments] dept_job_list: head "${headId}" has no CONFIGURED department — the job directory cannot be resolved`)
          const jobDir = jobDirFor(repoRoot, department)
          let files: string[]
          try {
            files = (await readdir(jobDir)).filter((name) => name.endsWith('.md')).sort()
          } catch (error: unknown) {
            // No jobs declared yet (missing default dir) → an EMPTY list, not
            // an error; any other failure (permissions, misconfig) is loud.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { jobDir, jobs: [] }
            throw error
          }
          const jobs: JobListItem[] = []
          for (const name of files) {
            const filePath = path.join(jobDir, name)
            let parsed: { meta: Record<string, string>; body: string } | undefined
            try {
              parsed = parseJobDefFrontmatter(await readFile(filePath, 'utf8'))
            } catch {
              parsed = void 0
            }
            if (parsed === void 0) {
              // Per-entry error: an invalid definition is REPORTED, the list
              // as a whole still returns (spec §5.5 list robustness).
              jobs.push({
                id: name.replace(/\.md$/, ''),
                path: filePath,
                error: 'invalid frontmatter (expected a `---` block with id/title/role/description/owner plus a non-empty body)'
              })
              continue
            }
            jobs.push({
              id: parsed.meta.id,
              title: parsed.meta.title,
              role: parsed.meta.role,
              description: parsed.meta.description,
              status: 'manual-run',
              owner: parsed.meta.owner,
              path: filePath,
              // JSON-lossless tool result: `schedule`/`outbox` are OPTIONAL
              // frontmatter keys — a definition that omits them must NOT emit a
              // property whose value is `undefined` (lossless-json rejects it).
              // Omit the key entirely when absent (the schema admits it).
              ...(parsed.meta.schedule !== undefined ? { schedule: parsed.meta.schedule } : {}),
              ...(parsed.meta.outbox !== undefined ? { outbox: parsed.meta.outbox } : {})
            })
          }
          return { jobDir, jobs }
        }
      })))

      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_job_run',
        description: 'Execute ONE versioned JOB of YOUR department (spec 004 §5.4 — manual execution; the W1 scheduler daemon uses the SAME engine for cron auto-fires): read the job definition <jobId>.md in the department jobDir (config org.departments[].jobDir; default <repoRoot>/docs/departments/<your-department-id>/jobs), validate its role against presets/departments/<your-department>/<role>.md, and materialize a WORKER exactly like dept_worker_spawn with role = the definition role, task = the JOB BODY (the full concrete assignment), jobId recorded, slug = the job id (deduped -2, -3… including retired), title = the HUMAN frontmatter title. Returns the worker id + session id + title + job id + the definition path. IDEMPOTENCY: a job already running (a LIVE, non-retired job worker of your department with that jobId) is NOT duplicated — it errors `job already running: <workerId>` (retire it explicitly with dept_worker_retire to restart). Missing job / broken frontmatter / unknown role → loud error (a versioned definition with a syntax error must fail the run, never spawn a task-less worker). `schedule` does NOT gate this run: a manual dept_job_run executes the job regardless of its `schedule`, and a cron-scheduled job auto-fires via the scheduler daemon. Registered ONLY in the head own-layer.',
        parameters: {
          jobId: { type: 'string', required: true, description: 'The job definition id (the file <jobId>.md in the department jobDir — e.g. "monitor-dsh-updates").' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workerId: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              title: { type: 'string', required: true },
              jobId: { type: 'string', required: true },
              role: { type: 'string', required: true },
              jobPath: { type: 'string', required: true }
            }
          },
          render: (_args, value) => [{ type: 'text', text: `ran job ${value.jobId}: worker ${value.workerId} (session ${value.sessionId}, role ${value.role}, title "${value.title}") — definition ${value.jobPath}` } as const]
        },
        async execute(args, exec): Promise<{ workerId: string; sessionId: string; title: string; jobId: string; role: string; jobPath: string }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_job_run requires a calling agent (exec.agent was undefined)')
          const headId = postIdForChild(agent.id as string)
          if (headId === void 0) throw new Error('[deepartments] dept_job_run is for a department HEAD (registered post), not the host')
          const headEntry = byPost.get(headId)
          if (headEntry === void 0) throw new Error(`[deepartments] dept_job_run: head "${headId}" is not registered`)
          const department = departmentForPost(headId)
          if (department === void 0) throw new Error(`[deepartments] dept_job_run: head "${headId}" has no CONFIGURED department — the job directory cannot be resolved`)
          const jobId = String(args.jobId ?? '').trim()
          if (jobId === '') throw new Error('[deepartments] dept_job_run: `jobId` is required')
          // The SHARED job-run engine — the SAME path the W1 scheduler uses for
          // an automatic fire (no drift between manual and auto execution).
          return runJobForDepartment(department, headEntry, jobId, { callerSessionId: agent.id as string, signal: exec.signal })
        }
      })))

      // --- F3 (spec 004 §5.2): dept_worker_spawn — the department-scoped
      // worker deployment tool (registered ONLY here, in the head own-layer:
      // D2 — the Asistente NEVER mints research workers; structural like
      // dept_post_create). The department is DERIVED from the caller (a head
      // can only deploy into its OWN department — spec §5.2 validation, the
      // cross-department spawn surface is absent by construction). -----------
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_worker_spawn',
        description: 'Spawn a WORKER of YOUR department (spec 004 §5.2): resolve the role template presets/departments/<your-department>/<role>.md (its persona + display title), materialize a fresh root agent worker (sessionId worker-<slug>-<uuid> — a UNIQUE session, its own session row; the worker NEVER collides with an archived session after a retire-and-respawn of the same role), register it in posts.json with provider:"worker", role, YOUR postId as managerId, your config department as departmentId and the jobId (when given), inject the role persona + your task into its system prompt, pin its sidebar title (title? overrides the default "<RoleDisplay>: <mission>"), and deliver the task as its first durable bus message (which wakes it). Worker slugs DEDUP with -2, -3… — a registered (even retired) slug is never reused. Returns the worker post id + session id + the pinned title. Registered ONLY in the head own-layer.',
        parameters: {
          role: { type: 'string', required: true, description: 'The role template name, e.g. "researcher" — must be a file presets/departments/<your-department>/<role>.md.' },
          task: { type: 'string', description: 'The one-off assignment: injected into the worker persona AND delivered as its first bus message.' },
          jobId: { type: 'string', description: 'Set when the worker runs a versioned job (F4); becomes the slug base and is recorded on the entry.' },
          title: { type: 'string', description: 'Sidebar row title (overrides the default "<RoleDisplay>: <mission>" — the role capitalized + the first line of the task, cut to ~70 chars).' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workerId: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              title: { type: 'string', required: true },
              activeMembers: activeMembersSchema
            }
          },
          render: (_args, value) => [{ type: 'text', text: `spawned worker ${value.workerId} (session ${value.sessionId}, title "${value.title}"; ${renderActiveRoster(value.activeMembers)})` } as const]
        },
        async execute(args, exec): Promise<{ workerId: string; sessionId: string; title: string; activeMembers: Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }> }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_worker_spawn requires a calling agent (exec.agent was undefined)')
          if (agents === void 0) throw new Error('[deepartments] dept_worker_spawn requires the agents service')
          const headId = postIdForChild(agent.id as string)
          if (headId === void 0) throw new Error('[deepartments] dept_worker_spawn is for a department HEAD (registered post), not the host')
          const headEntry = byPost.get(headId)
          if (headEntry === void 0) throw new Error(`[deepartments] dept_worker_spawn: head "${headId}" is not registered`)
          // A head WITHOUT a config department cannot spawn: the role template
          // tree (presets/departments/<dept-id>/) is keyed by the department.
          const department = departmentForPost(headId)
          if (department === void 0) throw new Error(`[deepartments] dept_worker_spawn: head "${headId}" has no CONFIGURED department — the role template tree (presets/departments/<department-id>/) cannot be resolved`)
          const role = String(args.role ?? '').trim()
          if (role === '') throw new Error('[deepartments] dept_worker_spawn: `role` is required (a role template name, e.g. "researcher")')
          // The SHARED worker-spawn engine — the EXACT path dept_job_run uses and
          // the parallel-monitor daemon uses for its researcher workers, so there
          // is no tool-vs-scheduler-vs-daemon drift on registration/pin/delivery.
          const result = await spawnWorkerForDepartment(department, headEntry, {
            role,
            task: args.task,
            ...(args.jobId !== void 0 ? { jobId: String(args.jobId) } : {}),
            ...(args.title !== void 0 ? { title: String(args.title) } : {}),
            callerAgentId: agent.id as string,
            senderSessionId: agent.id as string,
            signal: exec.signal
          })
          return { ...result, activeMembers: activeCatalogMembers() }
        }
      })))

      // --- F3 (spec 004 §5.3): dept_worker_retire — the department-scoped
      // retire tool: ONLY MY workers (managerId match or own config department
      // — the F1 retirePost scope) + mark (entry kept, retired:true) + archive
      // the durable session (the sidebar row disappears, D5). Idempotent; the
      // registry entry and message history are NEVER erased (D5). -----------
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_worker_retire',
        description: 'Retire ONE of YOUR department\'s workers (spec 004 §5.3): marks it retired (the posts.json entry STAYS with retired:true — the live catalog stops addressing it, dept_who still lists it with retired:true), disposes its live handle, AND archives its durable session (non-fatal — the sidebar row disappears, D5). Scope: only the workers YOU created (managerId) or a worker of YOUR config department — another head\'s/department\'s worker is rejected loudly; a permanent department head is never retired here; unknown workerIds reject. Idempotent: a second retire of the same worker succeeds as a no-op. The registry entry and the message history are NEVER erased (D5: keep the logs).',
        parameters: {
          workerId: { type: 'string', required: true, description: 'The worker post id to retire (e.g. "researcher-alpha" — the id dept_who lists).' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workerId: { type: 'string', required: true },
              retired: { type: 'boolean', required: true },
              archived: { type: 'boolean', required: true },
              activeMembers: activeMembersSchema
            }
          },
          render: (_args, value) => [{ type: 'text', text: `retired worker ${value.workerId} (${value.archived ? 'session archived' : 'session archive skipped (non-fatal)'}; ${renderActiveRoster(value.activeMembers)})` } as const]
        },
        async execute(args, exec): Promise<{ workerId: string; retired: boolean; archived: boolean; activeMembers: Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }> }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_worker_retire requires a calling agent (exec.agent was undefined)')
          const workerId = String(args.workerId ?? '').trim()
          if (workerId === '') throw new Error('[deepartments] dept_worker_retire: `workerId` is required')
          const entry = byPost.get(workerId)
          if (entry === void 0) throw new Error(`[deepartments] dept_worker_retire: "${workerId}" is not a registered post`)
          if (entry.provider !== 'worker') throw new Error(`[deepartments] dept_worker_retire: "${workerId}" is not a disposable worker — a head may only retire workers, never a permanent head`)
          // Scope (manager/department match — "only MY workers") + mark + dispose
          // are the F1 shared path (retirePost); idempotent on an already-retired
          // worker (no-op success). The worker-retire QD dice lives INSIDE
          // retirePost (LOTE B, 2026-08-27) — the ONE shared retire seam covering
          // every real retire path — so this tool carries NO dice/emit of its own
          // (a re-retire no-op naturally never re-emits: retirePost's idempotent
          // early return happens before its dice).
          await retirePost(workerId, agent.id as string)
          // F3 (spec §5.3): archive the DURABLE session so the sidebar row
          // disappears — non-fatal (a failed archive only warns; the retire
          // mark is the durable part). Runs on every retire INCLUDING the
          // already-retired no-op: archiveSession is idempotent (retirePost's
          // dice-side archive — LOTE B — is a harmless double).
          const archived = await archiveWorkerSession(entry.sessionId)
          return { workerId, retired: true, archived, activeMembers: activeCatalogMembers() }
        }
      })))

      // --- W3b (spec W3 monitor → researcher): dept_monitor_list — the runtime
      // PARALLEL monitor state (read-only). Registered ONLY in the head own-layer
      // (the Asistente orchestrates/reads via tooling but never polls monitors
      // itself). Reads the SAME <stateDir>/parallel-monitors-state.json the
      // poller daemon writes. ------------------------------------------------
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_monitor_list',
        description: 'List the runtime PARALLEL monitor state (W3b): for each configured monitor (parallel.monitors, or the 2 code defaults), the Parallel monitor_id, the query, the last fire + last poll timestamps, the last cursor and the last event count. Read-only — the daemon, not a head, creates/polls the monitors. Registered ONLY in the head own-layer.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              monitors: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    query: { type: 'string', required: true },
                    monitorId: { type: 'string' },
                    lastFiredAt: { type: 'number' },
                    lastPolledAt: { type: 'number' },
                    cursor: { type: 'string' },
                    lastEventCount: { type: 'number' }
                  }
                }
              }
            }
          },
          render: (_args, value) => [{ type: 'text', text: `${(value.monitors ?? []).length} parallel monitor(s): ${(value.monitors ?? []).map((m) => `${m.id}${m.monitorId !== undefined ? ` (${m.monitorId})` : ''}`).join(', ')}` } as const]
        },
        async execute(): Promise<{ monitors: Array<{ id: string; query: string; monitorId?: string; lastFiredAt?: number; lastPolledAt?: number; cursor?: string; lastEventCount?: number }> }> {
          const monitors = resolveParallelMonitorConfig((config as unknown as { parallel?: ParallelConfig }).parallel)
          const state = readParallelMonitorsState(stateDir)
          return {
            monitors: monitors.map((m) => {
              const s = state.monitors[m.id]
              return {
                id: m.id,
                query: m.query,
                ...(s?.monitorId !== undefined ? { monitorId: s.monitorId } : {}),
                ...(s?.lastFiredAt !== undefined ? { lastFiredAt: s.lastFiredAt } : {}),
                ...(s?.lastPolledAt !== undefined ? { lastPolledAt: s.lastPolledAt } : {}),
                ...(s?.cursor !== undefined ? { cursor: s.cursor } : {}),
                ...(s?.lastEventCount !== undefined ? { lastEventCount: s.lastEventCount } : {})
              }
            })
          }
        }
      })))
      // M2.3: the head's personal SECRETARY registered on the OWN layer —
      // HERE, in installHeadBoardTools, which postSetup runs AFTER the restrict
      // (order: mount → probe → restrict → own-layer), so the registration is
      // IMMUNE to the standing mask (the M2.2 live anomaly: with M2.1+M2.2 and
      // the row PRESENT, the inherited derivation still failed to surface the
      // tool in the QH session — the own-layer registration makes the head's
      // visibility unconditional). Manager-gated: a WORKER never carries the
      // secretary (its own layer registers only the bus/lifecycle tools).
      // The body is the SHARED factory (src/subagent.ts `createSecretaryTool` —
      // the SAME body the preset row's `apply()` registers), so the host
      // standing row and the head own layer share ONE definition of
      // person/toolFilter/wording. Idempotent across materializations: every
      // create/COLD-resume has a FRESH agentCtx, the registration sits in this
      // agent's OWN layer (the standing row binds the STANDING ctx — another
      // layer, no same-layer duplicate), and the ctx.effect disposer in
      // postSetup unwinds it with the agent. The execute is the M2.2 lazy path
      // (ctx.get('subagents') at call time → the clear absent-service error in
      // a head chain).
      disposers.push(agentCtx.tools.register(createSecretaryTool(agentCtx, secretaryConfig())))
    }

    return { dispose: () => { for (const d of disposers) d() } }
  }
// =========================================================================
  // SURFACE RETURN — the members the rest of applyInvoke consumes at the SAME
  // positions as before the extraction. SUB-BATCH 1 exposes the registry
  // (installHeadBoardTools); sub-batches 2-4 extend this return with the
  // role/persona + setup/workspace/ensureHead + bus/global members.
  // =========================================================================
  return {
    installHeadBoardTools
  }
}