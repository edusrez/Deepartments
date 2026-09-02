/**
 * Deepartments — DECOUPLING SUB-PASO 3: the SPAWN ORCHESTRATION FACTORY
 * (HITO 3 DECOUPLING, brief step 4 — F3 role templates + W1 job-run core +
 * calendar helpers, ~433 LOCs of `applyInvoke`, src/invoke.ts 3927-4358).
 *
 * MOVEMENT-ONLY. The spawn/roles zone of `applyInvoke` (the F3 role-template
 * resolver + the W1 job-run engine (runJobForDepartment /
 * spawnWorkerForDepartment — the SHARED dept_worker_spawn/dept_job_run
 * machinery) + the calendar helpers (readCalendar / writeCalendarBestEffort /
 * departmentJobExists)) is hoisted VERBATIM into this factory, and
 * `applyInvoke` invokes it via `createSpawnOrchestration` AT THE SAME FIBER
 * POSITION — the same closures, the same order, the same semantics (0 behavior
 * change). The state these closures read/mutate is the SAME by-reference
 * maps/registries passed in `deps`.
 *
 * Pattern (the PASO 1 / sub-paso 2 proof): closures hoisted → the DELIVERY
 * seam (+ the agent-setup/workspace seams) this zone consumes is LATE-BOUND:
 * the factory is invoked at the fiber position where the zone was CREATED
 * (3927), but the DeliverySurface (built at the delivery factory position,
 * later in the same apply) and the workerSetup/workspace closures (built in
 * the agent zone) do NOT exist there yet — they are passed as `deps.late`
 * GETTERS over the apply-scope bindings, and the zone closures dereference
 * them AT CALL TIME (a spawn/job fires post-boot, long after both seams are
 * initialized — the exact binding semantics the inline zone had, TDZ-legal).
 * The bundle stays a PURE SERVICE CONSUMER: this factory performs NO
 * ctx.provide (the P1 "the bundle consumes, never provides" invariant + the
 * smoke-boot service set stay untouched) — the `deepartments.spawn` service
 * surface the brief planned via ctx.provide is deferred to the hito-4 package
 * migration; the seams it would expose are already the returned SpawnSurface
 * members.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// LANE 0.2.2 (gap 2) — the bundle bridges resolve to the owning packages
// directly (registry/messages/wakepack → dshd-core, jobs → dshd-jobs, pooler →
// dshd-pooler, health → dshd-health); the org config types come from the local
// org-types.js mirror.
import { mintWorkerSessionId, workerSessionId } from 'dshd-core'
import type { PostEntry } from 'dshd-core'
import { readJobDefinitionFile, jobDirFor, readCalendarStateFile, writeCalendarStateFile } from 'dshd-jobs'
import type { CalendarState } from 'dshd-jobs'
import { readLlmPiAiProviderSettings, resolveReasoningContentPreflight } from 'dshd-pooler'
import {
  POOLER_STATE_FILE,
  resolvePoolerDispatchBlock,
  POOLER_CAPACITY_DEFAULT_HIGH_PERCENT,
  POOLER_CAPACITY_DEFAULT_STATE_STALE_MS,
  resolvePositiveKnob
} from 'dshd-health'
import { sanitizePromptLiterals } from 'dshd-core'
import type { CoordinatorConfig, DepartmentConfig, Config } from './org-types.js'
import type { MessagesStore } from 'dshd-core'
import type { DeliverySurface } from './delivery.js'

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

/** The apply-scope bindings the spawn zone captures (src/invoke.ts closures +
 * the shared mutable state), passed BY REFERENCE — the factory reads and
 * mutates the SAME maps/registries the rest of applyInvoke uses (AGENTS.md
 * rule 4 — no module-global mutable state; the instance lives on the apply
 * fiber). `late` carriers the seams that do NOT exist at the invocation
 * position (3927): indirect GETTERS over the apply-scope bindings the zone
 * dereferences at CALL time (post-boot). */
export interface SpawnFactoryDeps {
  /** The org stateDir (the calendar store `<stateDir>/calendar.json`). */
  stateDir: string
  /** The repo root (role-template tree `presets/departments/<id>/<role>.md`). */
  repoRoot: string
  /** The plugin Config (the pooler-dispatch + fb-9 knobs). */
  config: Config
  /** The live agents service (optional — absent in minimal compositions). */
  agents: AgentsLike | undefined
  /** The live durable post catalog (BY REFERENCE — job idempotency + slug dedup). */
  byPost: Map<string, PostEntry>
  /** The live head-handle map (byHeadHandle — worker sessions keyed here). */
  byHeadHandle: Map<string, AgentHandleLike>
  /** The registry closure — register a (re)materialized entry (by reference). */
  registerEntry: (entry: PostEntry) => void
  /** The config coordinator resolver for a worker postId (slug shadows guard). */
  coordinatorForPost: (postId: string) => CoordinatorConfig | undefined
  /** The realpath'd DSH_HOME (the pooler-state path fallback). */
  dshHome: () => string
  /** The head session-title pin (module-scope pure helper, passed by ref). */
  pinSessionTitle: (session: Session, title: string) => 'pinned' | 'already-titled' | 'failed'
  /** The bundle's worker template constants. */
  WORKER_PRESET_ID: string
  WORKER_AGENT_OPTIONS: AgentOptionsLike
  /** The LATE-BOUND seams the zone consumes at CALL time (constructed LATER on
   * this apply fiber — the DeliverySurface at the delivery factory position,
   * the agent-setup/workspace closures in the agent zone; the getters capture
   * the apply-scope bindings and are only dereferenced when a spawn/job fires,
   * so the TDZ is never entered at construction). */
  late: {
    /** The agent own-layer setup builder (from the agent zone). */
    workerSetup: (postId: string, roomId: string, role: string, extra?: { persona?: string; taskText?: string; tools?: string[]; department?: DepartmentConfig; reportRunToken?: string }) => (agentCtx: Context) => unknown
    /** F5: the fresh incarnation's department workspace cwd. */
    resolveDepartmentWorkspaceCwd: (department: DepartmentConfig | undefined) => Promise<string>
    /** The shared workspace root fallback cwd. */
    resolveWorkspaceRootPath: () => Promise<string>
    /** The DeliverySurface's deliverBusRecord wrapper (deliver + sidecar). */
    deliverBusRecord: DeliverySurface['deliverBusRecord']
    /** The DeliverySurface's boot-opened message store promise. */
    messagesStoreReady: DeliverySurface['messagesStoreReady']
  }
}

/** The spawn surface the rest of applyInvoke consumes at the SAME positions as
 * before the extraction (the tools, the scheduler daemon, the parallel monitor
 * — every downstream reference is unchanged). */
export interface SpawnSurface {
  /** Run ONE department job — the shared dept_worker_spawn contract engine. */
  runJobForDepartment: (
    department: DepartmentConfig,
    headEntry: PostEntry,
    jobId: string,
    opts?: { callerSessionId?: string; signal?: AbortSignal }
  ) => Promise<{ workerId: string; sessionId: string; title: string; jobId: string; role: string; jobPath: string }>
  /** Spawn a DISPOSABLE department worker — the shared dept_worker_spawn engine. */
  spawnWorkerForDepartment: (
    department: DepartmentConfig,
    headEntry: PostEntry,
    opts: { role: string; task?: string; title?: string; jobId?: string; callerAgentId?: string; senderSessionId?: string; signal?: AbortSignal }
  ) => Promise<{ workerId: string; sessionId: string; title: string }>
  /** The runtime calendar state (always `{entries:[...]}`, never throws). */
  readCalendar: () => CalendarState
  /** Persist the runtime calendar, folding an fs failure to a warn. */
  writeCalendarBestEffort: (state: CalendarState) => Promise<void>
  /** Whether the department owns a job definition `<jobId>.md`. */
  departmentJobExists: (department: DepartmentConfig, jobId: string) => Promise<boolean>
  /** The default sidebar title of a deployed worker (`<RoleDisplay>: <mission>`). */
  defaultWorkerTitle: (role: string, task: string | undefined, jobId: string | undefined, postId: string) => string
  /** The fb-9 reasoning-content preflight (dispatch loud-early guard). */
  workerReasoningContentPreflightError: () => string | undefined
  /** The pooler-capacity dispatch pre-check (429-primer-call guard). */
  workerPoolerDispatchBlockError: () => string | undefined
  /** VALLE lane B (fb-29 structural fix) — the COLD re-materialization tools
   * reader: re-resolves a worker's role-template tools at the materialize seam
   * (returns the template with its `tools` when the role has a template FILE;
   * undefined for a legacy free-form role with NO template — board-only by
   * design). Consumed by the delivery factory (materializePost) so a restarted
   * role-template worker is never silently messaging-only. */
  resolveRoleTemplate: (departmentId: string, role: string) => Promise<{ id: string; title: string; tools?: string[]; persona: string; path: string } | undefined>
}

/** Disposer closure per tool the head own-layer registers. The moved zone
 * declares this AT MODULE SCOPE (a `type HeadToolDisposers` line lives inside
 * the hoisted body too — the two declarations are structurally identical, the
 * inner one shadows for the zone's own closures); exported at module level so
 * invoke.ts's installHeadBoardTools return type still resolves after the move
 * (the export-parity surface of lib/invoke.js stays 259 — a type-only export
 * never emits to the compiled lib). */
export type HeadToolDisposers = { dispose: () => void }

/**
 * Build the SPAWN ORCHESTRATION surface on the apply fiber (AGENTS.md rule 4
 * — no module-global mutable state; invoked by applyInvoke at the SAME fiber
 * position where the hoisted zone used to live). The closures below are the
 * ORIGINAL zone closures, moved VERBATIM — the diff is movement-only.
 */
export function createSpawnOrchestration(ctx: Context, deps: SpawnFactoryDeps): SpawnSurface {
  const {
    stateDir,
    repoRoot,
    config,
    agents,
    byPost,
    byHeadHandle,
    registerEntry,
    coordinatorForPost,
    dshHome,
    pinSessionTitle,
    WORKER_PRESET_ID,
    WORKER_AGENT_OPTIONS,
    late
  } = deps

  // The LATE seams — resolved AT CALL TIME through the accessor object (the
  // DeliverySurface + the agent-setup/workspace closures are built LATER on
  // this fiber; the zone closures dereference these only when a spawn/job
  // actually fires — post-boot — so the apply-scope TDZ is never entered).
  // The four CALL seams are thunk arrows with the exact signatures; the store
  // seam is a THENABLE delegating to the surface's boot-opened promise (the
  // zone awaits `messagesStoreReady` as a value, so it cannot be an arrow).
  const workerSetup: SpawnFactoryDeps['late']['workerSetup'] = (...args) => late.workerSetup(...args)
  const resolveDepartmentWorkspaceCwd: SpawnFactoryDeps['late']['resolveDepartmentWorkspaceCwd'] = (...args) => late.resolveDepartmentWorkspaceCwd(...args)
  const resolveWorkspaceRootPath: SpawnFactoryDeps['late']['resolveWorkspaceRootPath'] = (...args) => late.resolveWorkspaceRootPath(...args)
  const deliverBusRecord: SpawnFactoryDeps['late']['deliverBusRecord'] = (...args) => late.deliverBusRecord(...args)
  const messagesStoreReady = {
    then(resolve: (value: MessagesStore) => unknown, reject: (reason?: unknown) => unknown) {
      return late.messagesStoreReady.then(resolve, reject)
    }
  } as Promise<MessagesStore>

  // =========================================================================
  // SPAWN ZONE (hoisted VERBATIM from applyInvoke — the same closures, the
  // same order, the same semantics).
  // =========================================================================
  // --- F3 (spec 004 §3.2/§5.2/§7.4): ROLE TEMPLATES --------------------------
  // A role is a PERSONA TEMPLATE referenced by name, versioned in the repo at
  // `presets/departments/<dept-id>/<role>.md` (frontmatter `id`/`title`/`tools`
  // + persona body). Roles are NOT agent presets (no preset.yml /
  // agent.cordis.yml pair — see presets/departments/research/README.md): the
  // worker still mounts the neutral base `deepartments-worker` preset and the
  // ROLE DELTA is the persona, injected as a systemPrompt section at spawn
  // time (installRoleSection `extra`). The `tools` frontmatter is DOCUMENTED
  // ONLY in this phase: postSetup still masks every global with the lean
  // `restrict({allow: []})` and there is NO role-driven allow list binding
  // yet (spec §7.1/§9 — a later phase).

  /** One resolved role template (the persona delta + display title). */
  interface RoleTemplate {
    id: string
    title: string
    tools?: string[]
    persona: string
    path: string
  }

  /** The repo path of one department's role template file. */
  const roleTemplatePath = (departmentId: string, role: string): string =>
    path.join(repoRoot, 'presets', 'departments', departmentId, `${role}.md`)

  // --- W1 job-run core (shared by dept_job_run AND the scheduler daemon) -----
  // These two guards + `runJobForDepartment` are hoisted to the APPLY scope so
  // the scheduler (a plugin daemon with no calling agent) can fire a due job
  // through the EXACT engine dept_job_run uses — no tool-vs-scheduler drift.
  // The job reader is module-level (parseJobDefFrontmatter/jobDirFor/
  // readJobDefinitionFile), shared with the agenda/dispatch.

  /** Validate the job's `role` BEFORE the spawn (spec 005 §5.4): the role MUST
   * name an existing role template of the department
   * (`presets/departments/<dept-id>/<role>.md` — the same tree F3's
   * readRoleTemplate resolves); missing → job-scoped loud error. */
  const validateJobRole = async (departmentId: string, jobId: string, role: string): Promise<void> => {
    const filePath = roleTemplatePath(departmentId, role)
    try {
      await readFile(filePath, 'utf8')
    } catch {
      throw new Error(`[deepartments] dept_job_run: job "${jobId}" declares role "${role}" which has no template at ${filePath} — a role must be a file presets/departments/${departmentId}/<role>.md`)
    }
  }

  /** The LIVE (non-retired) worker already running the job in THIS department
   * (spec §5.4 idempotency): a second run of the same job must NOT spawn a
   * duplicate — the head finishes by retiring the worker explicitly. */
  const runningJobWorker = (jobId: string, departmentId: string): string | undefined => {
    for (const entry of byPost.values()) {
      if (entry.provider === 'worker' && entry.retired !== true && entry.departmentId === departmentId && entry.jobId === jobId) return entry.postId
    }
    return undefined
  }

  /** fb-9 (QH MEDIA — the class 400 `reasoning_content must be passed back`
   * that burned a whole mission: 570s/~55k tokens, 0 deliverable): the ACTIVE
   * worker route (WORKER_AGENT_OPTIONS.provider — 'opencode-zen', the route
   * every spawn/job worker materializes with) is PRE-FLIGHTED against the
   * <stateDir>/settings.yaml profile BEFORE any worker materialization. A
   * provider the profile positively declares reasoning-enabled whose profile
   * lacks `compat.requiresReasoningContentOnAssistantMessages: true` (the
   * schema-correct nested path the adapter reads — a provider-TOP-LEVEL flag
   * is the DEAD key that produced the m-603 GREEN FALSE and is NOT resolved
   * by the reader) → a CLEAR EARLY
   * error (the expensive 400 never happens mid-mission). CONSERVATIVE guard:
   * flag present / reasoning off / profile absent-or-unreadable → undefined
   * (passthrough — the pre-flight is a guard, never a blocker). The decision
   * is one read of the same settings.yaml the FIX-2 boot check already reads
   * (via the dshd-pooler reader — consumption only). */
  const workerReasoningContentPreflightError = (): string | undefined => {
    const provider = WORKER_AGENT_OPTIONS.provider
    if (typeof provider !== 'string' || provider === '') return undefined
    const settings = readLlmPiAiProviderSettings(stateDir)
    const verdict = resolveReasoningContentPreflight(provider, settings, stateDir)
    return verdict.ok ? undefined : verdict.reason
  }

  /** DISPATCH-HARDENING (QH — the «429-primer-call» class, 2026-08-28): the
   * POOLER-CAPACITY DISPATCH PRE-CHECK (the BEFORE half — the AFTER half is
   * the b5-ghost live-post guard). The SAME dispatch seam as fb-9 (the 3+1:
   * runJobForDepartment / spawnWorkerForDepartment / dept_post_create / the
   * materializePost resume seam) READS the pooler's own
   * `keyPooler-state.json` SOLO-LECTURA (the same reader the M1 watchdog uses;
   * the path is `health.poolerStateFilePath` when set, else
   * `<DSH_HOME>/keyPooler-state.json` — the M1 wiring) and, when the snapshot
   * CERTAINS that no workspace can serve the spawn's FIRST call (zero usable
   * keys, every usable key at/above `health.highPercent`, or a last 429
   * usage-limit rotation to no key — the 503 prelude), returns the CLEAR EARLY
   * error the dispatch seam throws BEFORE any materialization — the expensive
   * primer-call 429/503 (a freshly spawned worker dying on its very first LLM
   * turn) never happens. CONSERVATIVE — a warning, never a blocker: absent /
   * unreadable / STALE state → undefined (passthrough, unknown ≠ exhausted);
   * the `health.poolerDispatchEnabled: false` knob restores the pre-check-less
   * dispatch (the M1 poolerCapacityEnabled pattern). */
  const workerPoolerDispatchBlockError = (): string | undefined => {
    if (config.health?.poolerDispatchEnabled === false) return undefined
    const poolerStatePath = config.health?.poolerStateFilePath !== undefined && config.health.poolerStateFilePath.trim() !== ''
      ? config.health.poolerStateFilePath
      : path.join(dshHome(), POOLER_STATE_FILE)
    const block = resolvePoolerDispatchBlock(
      poolerStatePath,
      Date.now(),
      {
        highPercent: resolvePositiveKnob(config.health?.highPercent, POOLER_CAPACITY_DEFAULT_HIGH_PERCENT),
        stateStaleMs: resolvePositiveKnob(config.health?.stateStaleMs, POOLER_CAPACITY_DEFAULT_STATE_STALE_MS)
      },
      ctx.logger
    )
    return block === undefined ? undefined : block.reason
  }

  /** fb-29 (ARCHITECTURE HONESTY — the 2026-08-31 empty-scope incident): a
   * worker role MUST resolve a NON-EMPTY tool scope before ANY materialization.
   * The worker's allow-scope derives from the role template's frontmatter
   * `tools` (F10 — postSetup builds the restrict allow-list from it); a
   * template with `tools` ABSENT or EMPTY makes the spawned worker
   * messaging-only (own-layer board tools only: no read/write/edit/glob/grep,
   * no dept_exec) WITHOUT any loud error — the F10 path degrades silently to
   * `restrict({allow: []})`. An interrupted spawn then leaves a durable worker
   * entry that cannot do its role's work (and a later re-materialization
   * re-derives the same empty scope). REFUSING is the honest choice — retry is
   * POINTLESS here (the template is a static repo file; re-resolving it
   * returns the SAME empty scope, so a retry can never succeed without an
   * external template fix): the spawn fails LOUDLY naming the role, the
   * template path and the cause, BEFORE any agents.create / registerEntry /
   * delivery — nothing is registered, nothing is materialized, and the head
   * sees the exact file to fix. */
  const assertWorkerToolScope = (role: string, template: RoleTemplate): void => {
    if (template.tools !== void 0 && template.tools.length > 0) return
    const cause = template.tools === void 0 ? 'absent' : 'an empty list'
    throw new Error(
      `[deepartments] dept_worker_spawn: role "${role}" has an EMPTY tool scope — the template ${template.path} declares frontmatter \`tools\` ${cause}; a worker spawned from it would be messaging-only (no read/write/edit/glob/grep/dept_exec) and silently operate mermado. Fix the template's \`tools\` list — the worker does not materialize.`
    )
  }

  /** Run ONE department job — the dept_worker_spawn contract (dept_job_run's
   * body, minus the exec.agent derivation): read the definition, validate the
   * role, enforce the already-running idempotency, materialize the worker root
   * agent (departmentId/managerId/jobId), pin the HUMAN title, deliver the JOB
   * BODY as its first durable bus message. Shared by dept_job_run (the head's
   * manual run) and the W1 scheduler (an automatic run). `opts.callerSessionId`
   * is the sender for the delivery frame (dept_job_run passes the head's live
   * session; the scheduler passes the head's durable session id). */
  const runJobForDepartment = async (
    department: DepartmentConfig,
    headEntry: PostEntry,
    jobId: string,
    opts: { callerSessionId?: string; signal?: AbortSignal } = {}
  ): Promise<{ workerId: string; sessionId: string; title: string; jobId: string; role: string; jobPath: string }> => {
    if (agents === void 0) throw new Error('[deepartments] dept_job_run requires the agents service')
    // 0. fb-9 pre-flight (BEFORE anything — never a mid-mission 400): reject
    // the dispatch LOUDLY when the active worker route's profile has reasoning
    // enabled but lacks compat.requiresReasoningContentOnAssistantMessages=true
    // (the schema-correct nested path; a provider-level key is dead and is
    // detected as missing, never a green false).
    const preflightError = workerReasoningContentPreflightError()
    if (preflightError !== undefined) throw new Error(`[deepartments] ${preflightError}`)
    // 0b. DISPATCH-HARDENING (QH «429-primer-call»): the pooler-capacity
    // pre-check — reject LOUDLY and EARLY (BEFORE the definition read, the
    // role validation, the idempotency pass, ANY agents.create — nothing is
    // registered) when the pooler snapshot certifies no workspace can serve
    // the job worker's first call.
    const poolerDispatchBlock = workerPoolerDispatchBlockError()
    if (poolerDispatchBlock !== undefined) throw new Error(`[deepartments] ${poolerDispatchBlock}`)
    // 1. Read + parse the definition FIRST (loud: missing/broken → fail).
    const definition = await readJobDefinitionFile(repoRoot, department, jobId)
    // 2. Role validation against the department role template tree.
    await validateJobRole(department.id, jobId, definition.meta.role)
    // 3. Idempotency (spec §5.4): never duplicate a running job worker.
    const running = runningJobWorker(jobId, department.id)
    if (running !== void 0) {
      throw new Error(`[deepartments] dept_job_run: job already running: ${running} — retire it explicitly with dept_worker_retire to restart "${jobId}"`)
    }
    // 4. dept_worker_spawn contract replicated (shared helpers — the F3 spawn
    // engine is untouched): resolve the role template, slug-dedup, materialize,
    // pin the HUMAN title, deliver the JOB BODY as the first bus message.
    const template = await readRoleTemplate(department.id, definition.meta.role)
    // fb-29: a job role whose template resolves an EMPTY tool scope must never
    // materialize a messaging-only job worker — fail loudly BEFORE any create.
    assertWorkerToolScope(definition.meta.role, template)
    const postId = dedupedWorkerSlug(jobId)
    const sessionId = SessionId(mintWorkerSessionId(postId))
    if (agents.get(String(SessionId(sessionId))) !== void 0) throw new Error(`[deepartments] dept_job_run: a live agent already exists for session "${sessionId}"`)
    const title = definition.meta.title.trim() !== '' ? definition.meta.title : defaultWorkerTitle(definition.meta.role, definition.body, jobId, postId)
    // fb-28 (QD MEDIO — WORK-REGISTER §5): per-spawn REPORT RUN TOKEN. A worker
    // derives its report path from `{{reportDir}}/<role>/<date>-<slug>.md` — when
    // the same postId (slug) is reused across deployments (retire → respawn, a
    // re-materialized/resumed session, or a job worker round), the previous
    // deployment's report would be OVERWRITTEN on the same date. Every spawn
    // mints a UNIQUE token and injects it (via workerSetup → installRoleSection)
    // so the worker's report filename ALWAYS carries `<slug>-<token>` — paths are
    // disjoint between ANY two deployments of the same slug, closing fb-28 in
    // every reuse case without touching the report convention presets.
    const reportRunToken = randomUUID().slice(0, 8)
    const setup = workerSetup(postId, headEntry.roomId, definition.meta.role, { persona: template.persona, taskText: sanitizePromptLiterals(definition.body), tools: template.tools, department, reportRunToken })
    const deptCwd = await resolveDepartmentWorkspaceCwd(department)
    const handle = await agents.create({
      sessionId: String(SessionId(sessionId)),
      meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: WORKER_PRESET_ID },
      agentOptions: WORKER_AGENT_OPTIONS,
      setup
    })
    registerEntry({
      postId,
      sessionId: String(SessionId(sessionId)),
      roomId: headEntry.roomId,
      agentPreset: WORKER_PRESET_ID,
      provider: 'worker',
      role: definition.meta.role,
      managerId: headEntry.postId,
      departmentId: department.id,
      jobId,
      // VALLE lane B (fb-29 structural fix): thread the role template's tools
      // into the DURABLE entry (B — the cold re-materialization fast-path; the
      // A re-resolution at the seam covers legacy entries WITHOUT this field).
      ...(Array.isArray(template.tools) && template.tools.length > 0 ? { tools: template.tools } : {})
    })
    byHeadHandle.set(String(SessionId(sessionId)), handle)
    const titleSession = ctx.sessions.get(sessionId)
    if (titleSession !== void 0) {
      const titlePin = pinSessionTitle(titleSession, title)
      if (titlePin === 'pinned') {
        ctx.logger.info(`[deepartments] dept_job_run: pinned worker session title "${title}" (${sessionId})`)
      } else if (titlePin === 'failed') {
        ctx.logger.warn(`[deepartments] dept_job_run: worker session title pin failed for ${sessionId} (non-fatal — worker registration continues)`)
      }
    }
    const store = await messagesStoreReady
    const record = await store.append({
      from: headEntry.postId,
      to: [postId],
      text: definition.body,
      kind: 'agent'
    })
    await deliverBusRecord(record, postId, opts.callerSessionId ?? '', opts.callerSessionId, opts.signal)
    return { workerId: postId, sessionId: String(SessionId(sessionId)), title, jobId, role: definition.meta.role, jobPath: definition.path }
  }

  /** Spawn a DISPOSABLE department worker — the SHARED dept_worker_spawn engine.
   * Used by the head own-layer `dept_worker_spawn` tool AND the parallel-monitor
   * daemon (the monitor spawns a researcher through the SAME path a head would,
   * so the worker registers identically: root agent, provider:"worker", role,
   * managerId = the head, departmentId, jobId (when given), persona + task
   * injection, title pin, first bus message from the head). `opts.title` (when
   * non-empty) overrides the default "<RoleDisplay>: <mission>"; `opts.jobId`
   * is the slug base + the recorded jobId (the monitor uses its monitor id).
   * `opts.callerAgentId`/`opts.senderSessionId` default to the head's session id
   * (the daemon path); dept_worker_spawn passes the calling head's agent id.
   * Returns the worker post id + session id + the pinned title. */
  const spawnWorkerForDepartment = async (
    department: DepartmentConfig,
    headEntry: PostEntry,
    opts: { role: string; task?: string; title?: string; jobId?: string; callerAgentId?: string; senderSessionId?: string; signal?: AbortSignal }
  ): Promise<{ workerId: string; sessionId: string; title: string }> => {
    if (agents === void 0) throw new Error('[deepartments] dept_worker_spawn requires the agents service')
    // 0. fb-9 pre-flight (BEFORE any materialization — never a mid-mission 400):
    // the active worker route's profile must carry
    // compat.requiresReasoningContentOnAssistantMessages=true when reasoning is
    // enabled, else the dispatch is rejected with a CLEAR EARLY error (the
    // expensive 400 that burned the fb-9 mission can never happen again).
    const preflightError = workerReasoningContentPreflightError()
    if (preflightError !== undefined) throw new Error(`[deepartments] ${preflightError}`)
    // 0b. DISPATCH-HARDENING (QH «429-primer-call»): the pooler-capacity
    // pre-check — reject LOUDLY and EARLY (BEFORE the role read, the slug
    // dedup, ANY agents.create — nothing is registered) when the pooler
    // snapshot certifies no workspace can serve the worker's first call.
    const poolerDispatchBlock = workerPoolerDispatchBlockError()
    if (poolerDispatchBlock !== undefined) throw new Error(`[deepartments] ${poolerDispatchBlock}`)
    const role = String(opts.role ?? '').trim()
    if (role === '') throw new Error('[deepartments] dept_worker_spawn: `role` is required (a role template name, e.g. "researcher")')
    // Role template is resolved BEFORE any create: a missing/malformed role file
    // fails the spawn loudly (never a persona-less worker).
    const template = await readRoleTemplate(department.id, role)
    // fb-29 (ARCHITECTURE HONESTY): a role template that resolves an EMPTY tool
    // scope (frontmatter `tools` absent or as an empty list) would silently
    // spawn a messaging-only worker (no read/write/edit/glob/grep/dept_exec —
    // the F10 allow-list degrades to `allow: []` without any error). Refuse
    // LOUDLY here — BEFORE the slug dedup, the create, the registration, the
    // delivery — so nothing is ever materialized mermado (the interrupted-spawn
    // incident of 2026-08-31 materialized exactly such a worker and it could
    // not do its role's work). Retry is pointless: the template is a static
    // file, re-resolving it returns the SAME empty scope.
    assertWorkerToolScope(role, template)
    // Slug dedup (spec §5.2): base = jobId ?? role; -2/-3… on collision —
    // INCLUDING RETIRED slugs (F1 keeps retired entries in byPost).
    const postId = dedupedWorkerSlug(opts.jobId ?? role)
    const sessionId = SessionId(mintWorkerSessionId(postId))
    if (agents.get(String(SessionId(sessionId))) !== void 0) throw new Error(`[deepartments] dept_worker_spawn: a live agent already exists for session "${sessionId}"`)
    const title = (opts.title ?? '').trim() !== '' ? (opts.title as string) : defaultWorkerTitle(role, opts.task, opts.jobId, postId)
    // fb-28 (QD MEDIO — WORK-REGISTER §5): per-spawn REPORT RUN TOKEN (see the
    // SAME mint in runJobForDepartment). The token makes the worker's report
    // path `<date>-<slug>-<token>.md` — ALWAYS disjoint between deployments of
    // the same slug, so a retired-then-respawned postId can never overwrite the
    // previous deployment's report.
    const reportRunToken = randomUUID().slice(0, 8)
    const setup = workerSetup(postId, headEntry.roomId, role, { persona: template.persona, taskText: opts.task === undefined ? undefined : sanitizePromptLiterals(opts.task), tools: template.tools, department, reportRunToken })
    // F5 (spec 004 §6.2 L1): the worker lands in its department workspace.
    const deptCwd = await resolveDepartmentWorkspaceCwd(department)
    const handle = await agents.create({
      sessionId: String(SessionId(sessionId)),
      meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: WORKER_PRESET_ID },
      agentOptions: WORKER_AGENT_OPTIONS,
      setup
    })
    registerEntry({
      postId,
      sessionId: String(SessionId(sessionId)),
      roomId: headEntry.roomId,
      agentPreset: WORKER_PRESET_ID,
      provider: 'worker',
      role,
      managerId: headEntry.postId,
      departmentId: department.id,
      ...(opts.jobId !== void 0 ? { jobId: opts.jobId } : {}),
      // VALLE lane B (fb-29 structural fix): the durable entry carries the role
      // template's tools (B — the cold re-materialization fast-path; the A
      // re-resolution at the seam covers entry WITHOUT this field). Non-empty by
      // construction here (assertWorkerToolScope ran above).
      ...(Array.isArray(template.tools) && template.tools.length > 0 ? { tools: template.tools } : {})
    })
    byHeadHandle.set(String(SessionId(sessionId)), handle)
    // F3 pin (spec §5.2): human-readable sidebar row — the owner's manual rename
    // always wins, a failed pin only logs (registration stands).
    const titleSession = ctx.sessions.get(sessionId)
    if (titleSession !== void 0) {
      const titlePin = pinSessionTitle(titleSession, title)
      if (titlePin === 'pinned') {
        ctx.logger.info(`[deepartments] dept_worker_spawn: pinned worker session title "${title}" (${sessionId})`)
      } else if (titlePin === 'failed') {
        ctx.logger.warn(`[deepartments] dept_worker_spawn: worker session title pin failed for ${sessionId} (non-fatal — worker registration continues)`)
      }
    }
    // Deliver the assignment (or a creation note) as a DURABLE bus message from
    // the head — the worker wakes on it. ACL (F2): head → own department worker.
    const text = (opts.task ?? '').trim() !== ''
      ? opts.task as string
      : `[created] worker "${postId}" (${role}) is registered. You are disposable — work your assigned task, then dept_memo_write and report to your head; your head retires you with dept_worker_retire when you are done.`
    const store = await messagesStoreReady
    const record = await store.append({
      from: headEntry.postId,
      to: [postId],
      text,
      kind: 'agent'
    })
    await deliverBusRecord(record, postId, opts.callerAgentId ?? headEntry.sessionId, opts.senderSessionId ?? headEntry.sessionId, opts.signal)
    return { workerId: postId, sessionId: String(SessionId(sessionId)), title }
  }


  /** Parse the LEAN frontmatter the role templates use (spec §3.2:
   * `---`-delimited YAML-lite — `key: value` scalars + `- item` lists for
   * `tools`). Returns the meta map + the persona body, or undefined when the
   * file has no well-formed frontmatter block. Deliberately NOT a YAML
   * dependency (the bundle adds none): the role format is a constrained
   * subset, and a malformed template must fail loud at spawn (spec §5.4
   * analogy), never silently spawn a persona-less worker. */
  const parseRoleTemplateFrontmatter = (text: string): { meta: Record<string, string | string[]>; body: string } | undefined => {
    const lines = text.split('\n')
    if (lines[0]?.trim() !== '---') return undefined
    let end = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        end = i
        break
      }
    }
    if (end < 0) return undefined
    const meta: Record<string, string | string[]> = {}
    let lastKey: string | undefined
    for (let i = 1; i < end; i++) {
      const line = lines[i]
      const scalar = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
      if (scalar !== null) {
        lastKey = scalar[1]
        const value = scalar[2].trim()
        // `tools:` with no inline value opens a list (the `- item` lines below).
        meta[lastKey] = value === '' ? [] : value
        continue
      }
      const item = /^\s*-\s+(.*)$/.exec(line)
      if (item !== null && lastKey !== undefined) {
        const current = meta[lastKey]
        if (Array.isArray(current)) current.push(item[1].trim())
        else meta[lastKey] = [item[1].trim()]
      }
    }
    const body = lines.slice(end + 1).join('\n').trim()
    if (body === '') return undefined
    return { meta, body }
  }

  /** Resolve + validate ONE role template (loud errors — a missing or
   * malformed role file must fail the spawn). The frontmatter `id` must match
   * the name it is referenced by (the file name IS the role id, §3.2); the
   * `title` is the display title fallback for the sidebar pin. */
  const readRoleTemplate = async (departmentId: string, role: string): Promise<RoleTemplate> => {
    const filePath = roleTemplatePath(departmentId, role)
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error: unknown) {
      throw new Error(`[deepartments] dept_worker_spawn: role "${role}" has no template at ${filePath} — a role must be a file presets/departments/${departmentId}/<role>.md (frontmatter id/title/tools + persona body)`)
    }
    const parsed = parseRoleTemplateFrontmatter(text)
    if (parsed === void 0) {
      throw new Error(`[deepartments] dept_worker_spawn: role template "${role}" (${filePath}) has no valid frontmatter — expected a '---' block (id/title/tools) plus a persona body`)
    }
    const declaredId = typeof parsed.meta.id === 'string' ? parsed.meta.id : void 0
    if (declaredId !== role) {
      throw new Error(`[deepartments] dept_worker_spawn: role template "${role}" (${filePath}) declares frontmatter id "${declaredId ?? '(none)'}" — the file name must match the role id it is referenced by`)
    }
    const title = typeof parsed.meta.title === 'string' && parsed.meta.title.trim() !== '' ? parsed.meta.title : role
    const toolsValue = parsed.meta.tools
    const tools = Array.isArray(toolsValue) ? toolsValue.filter((item): item is string => typeof item === 'string') : void 0
    return { id: declaredId, title, tools, persona: parsed.body, path: filePath }
  }

  /** VALLE lane B (fb-29 structural fix) — the readRoleTemplate variant the
   * COLD re-materialization seam (materializePost) consumes: re-resolve a
   * worker's role-template tools WITHOUT throwing when the template FILE does
   * not exist. A role with a template file resolves to its full shape (the
   * delivery seam re-reads `tools` so a restarted worker is never
   * messaging-only); a role that is a LEGACY dept_post_create free-form role
   * (no template file — board-only/messaging-only BY DESIGN, tools.ts:1300)
   * returns `undefined`. A template that EXISTS but is malformed / id-mismatched
   * still throws loudly (a role-template worker is never silently demoted). The
   * cold seam distinguishes: template EXISTS with empty tools → the fb-29 guard
   * refuses (loud); no template → legacy class (no failure). */
  const resolveRoleTemplate = async (departmentId: string, role: string): Promise<RoleTemplate | undefined> => {
    try {
      return await readRoleTemplate(departmentId, role)
    } catch (error: unknown) {
      // A MISSING template file is the legacy free-form-role class (dept_post_create),
      // never an error — the role simply has no template to resolve tools from.
      if (error instanceof Error && error.message.includes('has no template at')) return undefined
      throw error
    }
  }

  /** The mission headline of a deployed worker's default sidebar title (owner
   * decision 2026-08-23 "siempre Rol: Misión"): the FIRST line of the task
   * text, cut to ~`MISSION_MAX` chars (a truncation ellipsis when it exceeds),
   * falling back to the job id / derived post id when there is no task text. */
  const MISSION_MAX = 70
  const workerMission = (task: string | undefined, jobId: string | undefined, postId: string): string => {
    const trimmed = (task ?? '').trim()
    const firstLine = trimmed === '' ? '' : trimmed.split('\n')[0].trim()
    if (firstLine === '') return jobId ?? postId
    if (firstLine.length > MISSION_MAX) return `${firstLine.slice(0, MISSION_MAX - 3).trimEnd()}...`
    return firstLine
  }

  /** The RoleDisplay of a deployed worker's default sidebar title: the role
   * capitalized (researcher→"Researcher", reviewer→"Reviewer",
   * analyst→"Analyst", organizer→"Organizer"; any other role → its first
   * letter capitalized). */
  const roleDisplay = (role: string): string =>
    role === '' ? role : role.charAt(0).toUpperCase() + role.slice(1)

  /** The default sidebar title of a deployed worker (owner decision 2026-08-23:
   * "siempre que se deployee un agente: Rol: Misión como nombre"):
   * `<RoleDisplay>: <mission>` — the role capitalized + the first line(s) of
   * the task (cut to ~70 chars with a truncation ellipsis), falling back to
   * the job id / derived post id when there is no task text. A caller-passed
   * `title` always wins (respected verbatim); dept_job_run uses its HUMAN
   * frontmatter title when present. */
  const defaultWorkerTitle = (role: string, task: string | undefined, jobId: string | undefined, postId: string): string =>
    `${roleDisplay(role)}: ${workerMission(task, jobId, postId)}`

  /** Dedup the worker POST id (spec §5.2): the base slug (jobId ?? role) is
   * suffixed `-2`, `-3`… while the candidate is already registered — INCLUDING
   * RETIRED (a retired worker's id is never reused; F1 keeps retired entries
   * in byPost, so the dedup sees them) — or shadows a configured head. The
   * live-session guard mirrors dept_post_create's (a legacy orphan session). */
  const dedupedWorkerSlug = (base: string): string => {
    const sanitized = String(base ?? '').trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'worker'
    let slug = sanitized
    for (let n = 2; byPost.has(slug) || coordinatorForPost(slug) !== void 0 || (agents !== void 0 && agents.get(String(SessionId(workerSessionId(slug)))) !== void 0); n++) {
      slug = `${sanitized}-${n}`
    }
    return slug
  }

  /** Disposer closure per tool the head own-layer registers. */
  type HeadToolDisposers = { dispose: () => void }

  // --- W1 calendar helpers (shared by the calendar tools + the scheduler) ---
  // `<stateDir>/calendar.json` is the runtime agenda store. The read helper is
  // the module-level PURE reader; the write helper folds an fs failure to a
  // warn so an RPC/tick never fails on a persist error (mirrors savePresence).

  /** The runtime calendar state (always `{entries:[...]}`, never throws). */
  const readCalendar = (): CalendarState => readCalendarStateFile(stateDir)

  /** Persist the runtime calendar, folding an fs failure to a warn. */
  const writeCalendarBestEffort = async (state: CalendarState): Promise<void> => {
    try {
      await writeCalendarStateFile(stateDir, state)
    } catch (error) {
      ctx.logger.warn(`[deepartments] calendar.json write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Whether the department owns a job definition `<jobId>.md` (validates the
   * optional `jobId` on dept_calendar_add: a calendar entry may only reference
   * a KNOWn job of the caller's department). */
  const departmentJobExists = async (department: DepartmentConfig, jobId: string): Promise<boolean> => {
    const jobDir = jobDirFor(repoRoot, department)
    try {
      await readFile(path.join(jobDir, `${jobId}.md`), 'utf8')
      return true
    } catch {
      return false
    }
  }
// ---------------------------------------------------------------------------
  // The spawn surface the rest of applyInvoke consumes (the SAME handles the
  // zone previously exposed at these positions in the fiber — the downstream
  // code is unchanged, only the origin moved).
  // ---------------------------------------------------------------------------
  return {
    runJobForDepartment,
    spawnWorkerForDepartment,
    readCalendar,
    writeCalendarBestEffort,
    departmentJobExists,
    defaultWorkerTitle,
    workerReasoningContentPreflightError,
    workerPoolerDispatchBlockError,
    resolveRoleTemplate
  }
}
