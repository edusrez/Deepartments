/**
 * Deepartments — DECOUPLING SUB-PASO 4: TOOLS ORCHESTRATION FACTORY
 * (HITO 3 DECOUPLING, brief step 5 — SUB-BATCH 4 of 4 — THE LAST: the
 * bus/feedback TOOL DEFINITIONS + the host own-layer/global registrations +
 * the redeliver driver + guiEndpointDeps + the Binder buckets + the W1
 * scheduler/health builder closures (feedbackTool / feedbackListTool /
 * feedbackUpdateTool / sendMessageTool / agentMessagesTool / deptWhoTool /
 * feedbackEmitTools / feedbackHeadTools / busTools / recipientCatalogAlive /
 * deliverBusRecordForRedeliver / redeliverPendingDeliveries / guiEndpointDeps /
 * schedulerHeadForDepartment / schedulerRunJob / schedulerOnAutoRunSkip /
 * schedulerNotifyHead / schedulerDepartmentForEntry / schedulerDepartmentForJob
 * / buildHealthPosts / buildHostRunning / buildSessionContexts /
 * buildHostWaits / healthNotifyHost / healthPoolerStatePath / healthBootId +
 * the late-binding register buckets (DEAD since LANE DI-BY-SERVICES — the
 * closure sets flow into the deps holders) + the 9 GLOBAL host-plane tool
 * registrations
 * [globalWakeSnapshot / globalRetire / globalMemo / globalSleep /
 * globalSleepAll / globalHeadRotate / globalFeedback / globalFeedbackList /
 * globalFeedbackUpdate] + the host-plane tools disposal ctx.effect), 1231 LOCs
 * of `applyInvoke`, src/invoke.ts 4246-5476; SUB-BATCH 3 was the workspace +
 * ensureHead + retire/archive + boot-check/reconcile closures + the BOOT
 * WIRING, 1273 LOCs, src/invoke.ts 4099-5371; SUB-BATCH 2 was the
 * role/persona + architecture prompt sections + the post setup closures
 * (postSetup / headSetup / workerSetup) + the head-dispose + retire-helper
 * closures, 612 LOCs, src/invoke.ts 4061-4672 — pre-SB1 4900-5511; SUB-BATCH
 * 1 was the dept_exec/zstd runners + the agent toolset REGISTRY
 * (installHeadBoardTools), 922 LOCs, src/invoke.ts 3977-4898).
 *
 * MOVEMENT-ONLY. The FOURTH (final) cut of the tools zone of `applyInvoke` is
 * hoisted VERBATIM into this factory, and `applyInvoke` invokes it via
 * `createToolsOrchestration` AT THE SAME FIBER POSITION — the same closures,
 * the same order, the same semantics (0 behavior change). The state these
 * closures read/mutate is the SAME by-reference maps/registries passed in
 * `deps`. The file is CUMULATIVE: sub-batch 4 completes the tools zone
 * (bus/feedback defs + the Binder buckets + the host-plane globals).
 *
 * SUB-BATCH 4 (this batch) removes FOUR late seams the same way: the tool
 * ARRAYS (busTools / feedbackEmitTools / feedbackHeadTools) and the boot
 * re-delivery driver (redeliverPendingDeliveries) were late seams for CUT1/
 * CUT3 (the registry iterated the arrays, the BOOT WIRING ran the driver), but
 * CUT4 now DEFINES them inside this factory — the earlier references resolve
 * to the factory-local consts at CALL time (installHeadBoardTools runs at
 * agent materialization, the boot wiring fires post-load — post-boot, same
 * binding semantics). The delivery surface members this cut consumes are NEW
 * late seams (18: the bus/ACL/catalog/delivery/feedback/mint/wake seams the
 * tool executes + the binder buckets dereference — all built at the delivery
 * factory position, AFTER this factory, dereferenced only at CALL time). The
 * CUT4 zone also defines 14 NEW ToolsSurface members — the scheduler/health
 * builder closures + guiEndpointDeps — that the apply-fiber daemons (the W1
 * agenda scheduler + the W6 health daemon + the webServer mount, all staying
 * in invoke.ts) consume at their SAME positions.
 *
 * SUB-BATCH 4 SEAM DEVIATIONS (documented, MOVEMENT-ONLY preserved):
 *  - the CUT4 zone is 4246-5476, NOT 4246-5464: the ctx.effect that disposes
 *    the 9 GLOBAL host-plane tools (5466-5476) is part of the movement — its
 *    only references are the 9 globals (CUT4 factory-locals), so it closes the
 *    zone cleanly inside the factory (+12 lines from the brief coordinate).
 *  - `messageStoreDir` (the delivery surface member the redeliver driver's
 *    `redeliverDeps` derefs at BUILD time) is provided as a factory-local
 *    `const messageStoreDir = stateDir` — the delivery factory defines it
 *    EXACTLY as `const messageStoreDir = stateDir` (delivery.ts line 408), so
 *    the VALUE is identical and no late seam can serve a build-time deref.
 *  - the W1 agenda scheduler daemon (the interval effect) STAYS in invoke.ts
 *    (the daemon already lives in dshd-jobs; the bundle keeps the R6
 *    fallback) — the scheduler builder closures it feeds are surfaced.
 * 0 ctx.provide (the P1 invariant, asserted by the lock).
 *
 * Pattern (the PASO 1 / sub-paso 2 / sub-paso 3 / sub-batch 1 proof): closures
 * hoisted → the seams this cut consumes that DO NOT EXIST at the invocation
 * position (3997) are LATE-BOUND: the delivery seams
 * (maybeEmitQualityInspectDirective — the worker-retire QD directive emitter
 * retirePost uses at retire time — + redeliverPendingDeliveries — the boot
 * wiring's re-delivery driver — + messagesStoreReady / deliverBusRecord — the
 * DeliverySurface built at the delivery factory position), and the tool ARRAYS
 * the registry iterates (busTools / feedbackEmitTools / feedbackHeadTools —
 * built in the bus/feedback defs zone) are passed as `deps.late` GETTERS over
 * the apply-scope bindings, and rebound here as thunk arrows of EXACT
 * signature (call seams) + a delegating THENABLE (messagesStoreReady, awaited
 * as a value) + delegating ITERABLES (the for..of tool arrays) — all
 * dereferenced at CALL time (installHeadBoardTools runs at agent
 * materialization, the tool executes fire at user calls, retirePost runs at
 * retire time, the boot wiring fires post-load — all post-boot, long after
 * every seam is initialized; the apply-scope TDZ of those late consts is never
 * entered: the same binding semantics the inline zone had).
 * SUB-BATCH 2 removes ONE late seam: `workerSetup` was a late seam for the
 * sub-batch-1 registry (CUT1's installHeadBoardTools consumed it), but CUT2
 * now DEFINES workerSetup inside this factory — the registry's reference
 * resolves to the factory-local const (same function, same semantics), so the
 * `late.workerSetup` getter is gone from the invocation AND from the
 * ToolsFactoryDeps.late type.
 * SUB-BATCH 3 removes FOUR late seams the same way: `retirePost` /
 * `archiveWorkerSession` / `resolveDepartmentWorkspaceCwd` /
 * `resolveWorkspaceRootPath` were late seams for CUT1/CUT2 (the runners, the
 * worker setup, the retire tool consumed them through the getters), but CUT3
 * now DEFINES them inside this factory — the earlier references resolve to the
 * factory-local consts at CALL time (post-boot, same binding semantics). The
 * CUT2 retire helpers (captureRetiredPostTurnError / settleRetiredPostDeliveries
 * / predictRetiredWorkerDeliverable) become FACTORY-INTERNAL: the factory-local
 * retirePost consumes them directly, so they LEAVE the surface + the
 * destructure (no external consumer remains). The 15 new CUT3 direct deps
 * (registry / qualityWorkerInspectProbability / headProgress / hosts /
 * HOST_ATTACH_REPAIR_TIMEOUT_MS / HOST_ATTACH_REPAIR_RETRY_MS /
 * HOST_AGENT_OPTIONS / materializePreset / materializeHeadPreset / dshHome /
 * registryLoaded / hostsLoaded / stuckNow / STUCK_HEAD_MS /
 * HEAD_DEFAULT_SESSION_TITLE) are all defined BEFORE the factory position or
 * module-scope of invoke.ts — passed by reference, never late.
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
import { scopeOf } from '@deepseek-ai/dsh-scope'
// LANE FEEDBACK-NUDGE — `createUserMessage` builds the nudge as an injected
// plugin/notice context (the wake-pack shape); `boundContextSummary` bounds its
// notice summary (the wake-pack pattern).
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { readFile, readdir, realpath, mkdir, stat } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// LANE 0.2.2 (gap 2) — the bundle bridges resolve to the owning packages
// directly; the bundle-local VALUES (appendToolsetAudit / headPresetIdFor /
// createSecretaryTool / secretaryConfig / buildAgentRows) become DEPS passed
// by reference (the "functions, never imports" rule); role-orient resolves
// from dshd-core; the org config types come from the local org-types.js.
import {
  loadMessageRecords,
  resolveMessagesPath,
  resolveDeliveriesPath,
  parseDeliveryRows,
  parseMessageRecords,
  needsRedelivery,
  markDelivery,
  DeliveryRedeliverer,
  RE_DELIVERY_SWEEP_DEFAULT_INTERVAL_MS
} from 'dshd-core'
import type { DeliveryRow, MessageRecord, DeliveryStatus, DeliveryRedelivererDeps } from 'dshd-core'
import {
  scanTurnErrorCaptures,
  TURN_ERROR_FRESH_WINDOW_MS,
  readTurnErrorsState,
  writeTurnErrorsState,
  appendPostError,
  readPostErrorsFile,
  HEALTH_ERROR_WINDOW_MS,
  readUnusableSessionsMark,
  auditPresetText,
  appendConfigPresetMarker,
  readHealthHeartbeatFile,
  reconcileInterruptedPosts,
  readInboxByPost,
  POOLER_STATE_FILE
} from 'dshd-health'
import type { HealthSessionEvent, InterruptedPostInput, PostActivityInput, HostWaitPostInput, SessionContextInput } from 'dshd-health'
import {
  PROVIDER_ADAPTER_RETRY_WINDOW_MS,
  PROVIDER_ADAPTER_RETRY_MS,
  readLlmPiAiProviderSettings,
  resolveProviderAdapterBootFindings,
  resolveReasoningContentPreflight,
  REASONING_CONTENT_PREFLIGHT_POST_ID
} from 'dshd-pooler'
import { qualityInspectDecision, QUALITY_INSPECT_ENV_VAR } from 'dshd-quality'
import type { QualityInspectDirectiveSurface } from 'dshd-quality'

import { isArchivedSession, buildHeadRotationSeed, mintFreshSessionIdNotArchived } from 'dshd-core'
import type { WorkspaceRegistryLike } from 'dshd-core'
import {
  mintWorkerSessionId,
  HEAD_SESSION_PREFIX,
  headSessionId,
  reconcileDurableHostRegistry,
  reconcileDurablePostsRegistry,
  readGhostSuspectLedger,
  writeGhostSuspectLedger,
  stepGhostSuspectCensus,
  readOfflineReapLedger,
  writeOfflineReapLedger,
  stepOfflineReapCensus,
  pickLiveHostEntry
} from 'dshd-core'
import type { PostEntry, RegistryStore, HostEntry, HostEntryLike } from 'dshd-core'
import { parseJobDefFrontmatter, jobDirFor } from 'dshd-jobs'
import type { CalendarEntry, SchedulerAutoRunFinding } from 'dshd-jobs'
import type {
  Config,
  CoordinatorConfig,
  DepartmentConfig,
  ParallelConfig,
  ParallelMonitorConfig,
  PostsRetentionConfig,
  RetiredResidueConfig,
  OfflineReapConfig,
  DeptWhoState
} from './org-types.js'
import { buildSubagentOrientation } from 'dshd-core'
import type { SubagentRole } from 'dshd-core'
import type { MessagesStore } from 'dshd-core'
import type { DeliverySurface } from './delivery.js'
import type { HeadToolDisposers, SpawnSurface } from './spawn.js'
// dshd-feedback (SUB-BATCH 4 — the feedback tools zone): the store + the
// terminal-estado predicate + the record/option types the 3 feedback tool
// bodies use (dshd-feedback — no cycle).
import { FeedbackStore, isTerminalEstado } from 'dshd-feedback'
import type { FeedbackEstado, FeedbackInput, FeedbackListOptions, FeedbackListResult, FeedbackRecord, FeedbackSeveridad, FeedbackTipo, FeedbackUpdateInput } from 'dshd-feedback'
// The core delivery module (SUB-BATCH 4 — the bus/ACL/catalog/delivery seams
// the bus-feedback tools + the Binder buckets dereference): the types of the
// delivery-surface members the CUT4 zone consumes late.
import type { DeliveryEngine, BusMemberProfile, BusSendResult, CatalogRoute, DeliveryInterruptOptions, BusSurface } from 'dshd-core'
// The dshd-gui channel deps (SUB-BATCH 4 — guiEndpointDeps: the endpointDeps
// wiring object the CUT4 zone builds and the webServer mount consumes).
import type { DeepartmentsEndpointDeps, EndpointPostEntryLike, PresenceState } from 'dshd-gui'
import type { WakePackService, HostSleepSurfacePlan } from 'dshd-core'
/** LANE 0.2.2 — the guiEndpointDeps' buildAgentRows contract: the injected dep
 * is typed EXACTLY as DeepartmentsEndpointDeps declares it (the bundle's real
 * function is assignable to it; the factory passes it into guiEndpointDeps). */
type GuiBuildAgentRows = DeepartmentsEndpointDeps['buildAgentRows']

// ---------------------------------------------------------------------------
// Local structural mirrors of the bundle-local harness views (src/invoke.ts
// declares these at module scope but does NOT export them — the export-parity
// lock freezes lib/invoke.js's export surface at 259 symbols, so the factory
// re-declares the EXACT same structural shapes instead of importing from the
// bundle module (which would also create a require cycle).
// ---------------------------------------------------------------------------

/** Loose structural view of a live `Agent` (the shape `ctx.agents.get(id)`
 * returns). Mirrors the bundle-local `AgentLike` of src/invoke.ts. The session
 * member is the rc.1+ surface (`seq` = log length, `snapshotEvents()` = full
 * log — the `events` getter is gone from 0.1.2-rc.1 on). */
interface AgentLike {
  id: string
  status: string
  ctx: Context
  session?: {
    seq: number
    snapshotEvents(): readonly unknown[]
    /** Legacy dual fallback: the pre-rc.1 core line still exposes the cached
     * `events` getter (runtime core 0.1.1-rc.2). Optional for the
     * 0.1.2-rc.1 surface where it is gone. */
    events?: readonly unknown[]
    append?: (type: string, data: unknown, opts?: { surfaceOp?: string }) => unknown
    header?: unknown
  }
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

/** Structural view of the `agentPresets` service surface the head setup needs
 * (rc.8 dsh-agent-presets types/index.d.ts:115,159 — mirrors the bundle-local
 * `AgentPresetsLike` of src/invoke.ts, which is not exported). Resolved
 * optionally via `ctx.get('agentPresets')`; when absent (e.g. minimal/hermetic
 * compositions) the post setup mounts nothing but still registers its board
 * tools. */
interface AgentPresetsLike {
  resolve(id: string): Promise<unknown>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** Structural view of ONE workspace entity as the workspace-root resolver reads
 * it (the dsh-workspace entity = path + the read-only sessionIds membership
 * view — mirrors the bundle-local `WorkspaceEntityMembershipLike` of
 * src/invoke.ts, which is not exported). */
/** Mirror of the bundle-local `SessionProjectionsLike` (src/invoke.ts — the
 * health daemon's session-context projections handle, passed via
 * `ctx.get('sessionProjections')`; not importable without a cycle). */
interface SessionProjectionsLike {
  snapshot(session: unknown): { asOfSeq?: number; values?: Record<string, unknown> }
}

/** Mirror of the bundle-local `SessionHeaderWithOrigin` (src/invoke.ts — the
 * subagent-origin header shape the busEnsureHostForCaller seam reads; not
 * importable without a cycle). */
interface SessionHeaderWithOrigin {
  origin?: unknown
  parentSession?: unknown
  delegationDepth?: unknown
  meta?: {
    origin?: unknown
    parentSession?: unknown
    delegationDepth?: unknown
  }
}

/** Mirror of the bundle-local `ReasonVerificationStamp` (src/invoke.ts — the
 * fb-25 reason cross-check stamp of the head-rotation QD mirror; a module-scope
 * alias that is not importable without a cycle). */
type ReasonVerificationStamp = 'verified' | 'unverified' | 'unavailable'

/** Mirror of the bundle-local `CatalogRow` (src/invoke.ts — the dept_who /
 * roster row builder's row shape; a module-scope local alias that is not
 * importable without a cycle). */
interface CatalogRow {
  agentId: string
  kind: 'head' | 'worker' | 'host'
  title: string
  live: boolean
  sleeping: boolean
  state: DeptWhoState
  sessionId: string
  retired: boolean
  departmentId?: string
  role?: string
  jobId?: string
}

interface WorkspaceEntityMembershipLike {
  path: string
  sessionIds?: readonly string[]
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
  /** The optional agentPresets service (the postSetup preset mount — absent in
   * minimal compositions). */
  agentPresets: AgentPresetsLike | undefined
  /** The in-flight head-dispose dedupe map (BY REFERENCE — the dispose helpers
   * CUT2 consumes, defined in the boot zone before the factory position). */
  disposingHeads: Map<string, Promise<void>>
  /** The head preset id (headSetup's default presetId). */
  PRESET_ID: string
  /** The bundle's post tool-allowance sets (module-scope consts of invoke.ts —
   * not importable without a cycle, passed by reference). */
  HEAD_BASE_TOOLS: readonly string[]
  DENIED_POST_TOOLS: ReadonlySet<string>
  OWN_LAYER_POST_TOOLS: ReadonlySet<string>
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
  /** LANE 0.2.2 (gap 2) — the bundle-local pure VALUES the CUT1-4 zones call
   * (src/toolset-audit.ts appendToolsetAudit, src/head-presets.ts
   * headPresetIdFor, src/subagent.ts createSecretaryTool/secretaryConfig,
   * src/agents.ts buildAgentRows — injected by reference, the "functions,
   * never imports" rule; the package cannot import them without a cycle).
   * The structural types mirror the bundle-local modules' signatures. */
  appendToolsetAudit: (stateDir: string | undefined, entry: Record<string, unknown>) => void
  headPresetIdFor: (departmentId: string) => string
  createSecretaryTool: (agentCtx: Context, config: { provider: string; toolName?: string; persona?: string; toolFilter?: { allow?: string[]; deny?: string[] }; maxDepth?: number | 'provider-managed' }) => ReturnType<typeof defineTool>
  secretaryConfig: () => { provider: string; toolName?: string; persona?: string; toolFilter?: { allow?: string[]; deny?: string[] }; maxDepth?: number | 'provider-managed' }
  buildAgentRows: GuiBuildAgentRows
  /** LANE 0.2.2 — the guiEndpointDeps' buildAgentRows row shape. */
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
  /** THE durable post/host catalog store (BY REFERENCE — the registry the
   * retire/archive + the durable-registry reconcile closures consume:
   * markPostRetired/unregisterPost/removePosts). Defined in the boot zone
   * before the factory position. */
  registry: RegistryStore
  /** The resolved worker-archive dice probability (QD, spec 007 §4.1). */
  qualityWorkerInspectProbability: number
  /** The live head-progress map (markHeadProgress/isHeadStuck entries — BY
   * REFERENCE; the delivery factory consumes the same map). */
  headProgress: Map<string, { at: number; eventCount: number }>
  /** The live host-registry map (the workspace-root resolver iterates the
   * non-retired host session ids). */
  hosts: Map<string, HostEntry>
  /** The host-attach bounded-retry window (workspace ensure/attach). */
  HOST_ATTACH_REPAIR_TIMEOUT_MS: number
  HOST_ATTACH_REPAIR_RETRY_MS: number
  /** The bundle's host AgentOptions (the provider-adapter boot check). */
  HOST_AGENT_OPTIONS: AgentOptionsLike
  /** The agentPresets materialization closures (ensureAllHeads) — apply-scope,
   * defined before the factory position, passed by reference. */
  materializePreset: (presetId: string) => Promise<void>
  materializeHeadPreset: (department: DepartmentConfig) => Promise<void>
  dshHome: () => string
  /** The durable registries' cold-load promises (the embedded boot wiring
   * awaits both before driving ensureAllHeads + the boot checks). */
  registryLoaded: Promise<unknown>
  hostsLoaded: Promise<unknown>
  /** The injectable stuck-head clock (module-scope of invoke.ts, by ref). */
  stuckNow: () => number
  STUCK_HEAD_MS: number
  /** The default head session title pin (module-scope const of invoke.ts). */
  HEAD_DEFAULT_SESSION_TITLE: string
  /** SUB-BATCH 4 direct deps — all defined BEFORE the factory position or
   * module-scope of invoke.ts — passed by reference, never late: the host-plane
   * tool builders (sleepTool), the bus/wakepack/registry closures the
   * bus-feedback tools + the Binder buckets + the daemon builder closures
   * consume (subagents / wakePackService / hostIdForSession / readJournal /
   * journalPathFor / refreshPresence / savePresence / notifyHostPresence /
   * presenceCache / assembleHeartbeat / roleForSessionLive), and the
   * module-scope pure helpers of invoke.ts (headRotationJournalStatus /
   * verifyRotateReason / resolveSessionProjCachePath / deliverDaemonNotice /
   * captureSchedulerAutoRunFailure). */
  /** The host-plane dept_sleep tool builder (module-scope of invoke.ts). */
  sleepTool: (hostPlane: boolean) => ReturnType<typeof defineTool>
  /** The optional subagents service (absent in minimal compositions — the CUT4
   * bus-tool install warn). */
  subagents: unknown
  /** The per-apply WakePackService (the dept_wake_snapshot snapshot builder). */
  wakePackService: WakePackService
  /** The live session → hostId resolver (the wake-snapshot identity). */
  hostIdForSession: (sessionId: string) => string
  /** The durable journal reader (dept_head_rotate's continuity check). */
  readJournal: (memberId: string) => Promise<string | undefined>
  /** The durable journal path resolver (module-scope of invoke.ts). */
  journalPathFor: (memberId: string) => string
  /** The presence persistence closures (module-scope of invoke.ts — the
   * guiEndpointDeps presence hooks). */
  refreshPresence: () => void
  savePresence: (state: PresenceState) => Promise<void>
  notifyHostPresence: (present: boolean) => void
  presenceCache: PresenceState
  /** The live host heartbeat assembler (the gui presence + health wiring). */
  assembleHeartbeat: (hostId: string) => string | undefined
  /** The live session → role resolver (the wakepack binder bucket). */
  roleForSessionLive: (sessionId: string) => SubagentRole
  /** The rotation journal-status stamp (module-scope pure helper of invoke.ts). */
  headRotationJournalStatus: (journalText: string, nowMs: number) => { timestamp?: string; stale: boolean }
  /** The fb-25 rotation-reason cross-check (module-scope pure helper). */
  verifyRotateReason: (reason: unknown, oldSessionId: string, projCachePath?: string) => ReasonVerificationStamp
  /** The session-projcache path resolver (module-scope pure helper). */
  resolveSessionProjCachePath: (stateDir: string, persistenceRoot?: string) => string
  /** The daemon notice delivery (module-scope async helper of invoke.ts — the
   * scheduler's agenda-notice delivery, queues a dormant head). */
  deliverDaemonNotice: (targetEntry: { postId: string; sleepEpoch?: number | undefined }, record: MessageRecord, framed: string, deliver: (entry: PostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined) => Promise<DeliveryStatus>) => Promise<'queued' | 'woken'>
  /** The scheduler auto-run failure capture (module-scope async helper). */
  captureSchedulerAutoRunFailure: (opts: { stateDir: string; now(): number; jobId: string; reason: string; error?: string; logger?: { warn(message: string): void } }) => Promise<boolean>
  /** The dept_who roster-row builder + the service sets/maps the wakepack +
   * lifecycle binder buckets pass by reference (all apply-scope, defined
   * BEFORE the factory position). */
  buildCatalogRows: () => CatalogRow[]
  wakePackInjected: Set<string>
  deferredSleepReplace: Map<string, string>
  /** The module-scope pure helpers the wakepack bucket binds (module-scope of
   * invoke.ts — not importable without a cycle, passed by reference). */
  computeHostSleepSurfacePlan: (nodes: readonly number[]) => HostSleepSurfacePlan
  readPresenceStateFile: (stateDir: string) => PresenceState
  /** The lifecycle seams the lifecycle binder bucket binds (apply-scope, defined
   * BEFORE the factory position — the same closures the delivery factory
   * consumes). */
  ensureHost: (sessionId: string, roomId: string) => string
  writeJournal: (memberId: string, roomId: string, summary: string, decisions: string[], constraints: string[], openItems: string[], currentStep?: string, archive?: { sessionId?: string; wakeCounter?: number; archiveSeq?: string; lastWakeMs?: number; boundarySeq?: number }) => Promise<string>
  bumpHostSleepCounter: (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }) => Promise<string>
  bumpPostSleepCounter: (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }) => Promise<string>
  /** The LATE-BOUND seams the zone consumes at CALL time (constructed LATER on
   * this apply fiber — the agent-setup/workspace closures in the agent zone,
   * the retire/archive seams in the agent zone, the DeliverySurface at the
   * delivery factory position, the tool arrays in the bus/feedback defs zone;
   * the getters capture the apply-scope bindings and are only dereferenced
   * when a registration/tool execute fires, so the TDZ is never entered at
   * construction). */
  late: {
    /** The DeliverySurface's maybeEmitQualityInspectDirective wrapper (the
     * worker-retire QD directive emitter retirePost + the head-rotate mirror
     * consume at retire/rotate time — built at the DELIVERY factory position,
     * AFTER this factory). */
    maybeEmitQualityInspectDirective: (surface: QualityInspectDirectiveSurface) => Promise<void>
    /** The DeliverySurface's deliverBusRecord wrapper (deliver + sidecar). */
    deliverBusRecord: DeliverySurface['deliverBusRecord']
    /** The DeliverySurface's boot-opened message store promise. */
    messagesStoreReady: DeliverySurface['messagesStoreReady']
    /** SUB-BATCH 4 — the 18 delivery-surface members the CUT4 zone consumes at
     * CALL time (the tool executes, the binder buckets' lazy readers, the boot
     * re-delivery driver's `deliver` seam, the head-rotate mint/mirror — all
     * post-boot; built at the delivery factory position, AFTER this factory,
     * so the TDZ of the apply-scope `deliverySurface` binding is never
     * entered). The SB1 tool ARRAYS (busTools / feedbackEmitTools /
     * feedbackHeadTools) + the SB3 boot driver (redeliverPendingDeliveries)
     * LEAVE the late set — CUT4 now DEFINES them as factory-locals. */
    busMemberIdFor: DeliverySurface['busMemberIdFor']
    feedbackStoreReady: DeliverySurface['feedbackStoreReady']
    resolveQualityHeadEntry: DeliverySurface['resolveQualityHeadEntry']
    feedbackForwarderFor: DeliverySurface['feedbackForwarderFor']
    feedbackDeliveryOptions: DeliverySurface['feedbackDeliveryOptions']
    busProfileFor: DeliverySurface['busProfileFor']
    aclDenyGround: DeliverySurface['aclDenyGround']
    resolveBusCatalogRoute: DeliverySurface['resolveBusCatalogRoute']
    delivery: DeliverySurface['delivery']
    isDormantRecipient: DeliverySurface['isDormantRecipient']
    busEnsureHostForCaller: DeliverySurface['busEnsureHostForCaller']
    assertBusFanOut: DeliverySurface['assertBusFanOut']
    busDeliverToPost: DeliverySurface['busDeliverToPost']
    busDeliverToHost: DeliverySurface['busDeliverToHost']
    resolveBusChild: DeliverySurface['resolveBusChild']
    deliverBusChild: DeliverySurface['deliverBusChild']
    freshMintHead: DeliverySurface['freshMintHead']
    enqueueHostWake: DeliverySurface['enqueueHostWake']
  }
}

/** The tools surface the rest of applyInvoke consumes at the SAME positions as
 * before the extraction (postSetup's own-layer wiring + every downstream
 * reference is unchanged). SUB-BATCH 1: the registry; SUB-BATCH 2: the
 * role/persona + setup + dispose members (workerSetup / headSetup /
 * disposeHeadHandle*); SUB-BATCH 3: the workspace + ensureHead + retire +
 * boot-check members (the delivery factory consumes retirePost /
 * resolveDepartmentWorkspaceCwd / resolveWorkspaceRootPath /
 * rotateArchivedHeadSessionId / isHeadStuck / markHeadProgress /
 * attachHeadSession / archivePostSessionOnSleep — the CUT3 retire helpers
 * captureRetiredPostTurnError / settleRetiredPostDeliveries /
 * predictRetiredWorkerDeliverable are now FACTORY-INTERNAL: the factory-local
 * retirePost consumes them directly, no external consumer remains). */
export interface ToolsSurface {
  /** Install the post's messaging toolset scoped to `agentCtx` (the post's OWN
   * layer). The same tool bodies the host plane registers, reused for any
   * resident post; `manager: true` additionally registers the department
   * lifecycle/worker/job/monitor tools (+ the M2.3 secretary). */
  installHeadBoardTools: (agentCtx: Context, manager?: boolean, opts?: { allowExec?: boolean }) => HeadToolDisposers
  /** The setup for a DISPOSABLE department WORKER (no create/retire) — the
   * closure the spawn factory consumes (late seam → surface member in SB2). */
  workerSetup: (postId: string, roomId: string, role: string, extra?: { persona?: string; taskText?: string; tools?: string[]; department?: DepartmentConfig }) => (agentCtx: Context) => unknown
  /** The setup for a PERMANENT department head (manager — can create/retire
   * workers). Consumed by ensureHead + the delivery factory. */
  headSetup: (postId: string, roomId: string, role: string, presetId?: string, department?: DepartmentConfig) => (agentCtx: Context) => unknown
  /** Dispose one head's live AgentHandle (its only teardown capability;
   * idempotent; the durable session survives for a later resume). */
  disposeHeadHandle: (sessionId: string) => Promise<void>
  /** disposeHeadHandle with the in-flight dedupe of `disposingHeads`. */
  disposeHeadHandleOnce: (sessionId: string) => Promise<void>
  /** The bounded detach-join window for the sleep respawn (env knob). */
  disposeJoinTimeoutMs: () => number
  /** The BOUNDED `disposeHeadHandleOnce` join for the sleep respawn. */
  joinHeadDisposeOnce: (sessionId: string) => Promise<boolean>
  /** F5: the fresh incarnation's department workspace cwd (the delivery
   * factory consumes it at the same position). */
  resolveDepartmentWorkspaceCwd: (department: DepartmentConfig | undefined) => Promise<string>
  /** The shared workspace root fallback cwd (the delivery factory consumes
   * it at the same position). */
  resolveWorkspaceRootPath: () => Promise<string>
  /** THE VISIBILITY FIX SEAM: rotate an ARCHIVED head session id to a fresh
   * one (the delivery factory consumes it at the same position). */
  rotateArchivedHeadSessionId: (postId: string, sessionId: string) => Promise<string | undefined>
  /** The F1 shared retire seam (mark + dispose + QD dice + archive). */
  retirePost: (postId: string, callerAgentId: string) => Promise<{ postId: string; retired: true }>
  /** Fix A2 — is `live` a wedged resident head? (the delivery factory
   * consumes it at the same position). */
  isHeadStuck: (sessionId: string, live: AgentLike) => boolean
  /** Fix A2 — record that we just observed `live` making progress. */
  markHeadProgress: (sessionId: string, live: AgentLike) => void
  /** Piece 1 — durably attach a head/worker session to its sidebar workspace
   * (the delivery factory consumes it at the same position). */
  attachHeadSession: (sessionId: string, source: string) => Promise<void>
  /** F8 — non-fatal server-side archive of a SLEPT head's durable session
   * (the delivery factory + the lifecycle bucket consume it). */
  archivePostSessionOnSleep: (sessionId: string) => Promise<boolean>
  /** SUB-BATCH 4 members — the apply-fiber daemons that STAY in invoke.ts (the
   * W1 agenda scheduler daemon, the W6 system-health daemon, the webServer
   * mount) consume these at their SAME positions; the embedded CUT4 zone
   * defines them as factory-locals. */
  /** The W1 scheduler's head resolver (`runAgendaSchedulerTick` dep). */
  schedulerHeadForDepartment: (department: DepartmentConfig) => string | undefined
  /** The W1 scheduler's job runner (`runAgendaSchedulerTick` dep — runs a cron
   * job for a department head by id; idempotency-skip on already-running). */
  schedulerRunJob: (department: DepartmentConfig, headPostId: string, jobId: string) => Promise<boolean>
  /** The W1 scheduler's auto-run skip handler (failure capture). */
  schedulerOnAutoRunSkip: (finding: SchedulerAutoRunFinding) => Promise<void>
  /** The W1 scheduler's agenda-notice delivery (`runAgendaSchedulerTick` dep). */
  schedulerNotifyHead: (headPostId: string, message: string) => Promise<void>
  /** The W1 scheduler's calendar-entry owner resolver. */
  schedulerDepartmentForEntry: (entry: { createdBy?: string }) => DepartmentConfig | undefined
  /** The W1 scheduler's job→department resolver. */
  schedulerDepartmentForJob: (jobId: string) => DepartmentConfig | undefined
  /** The W6 health daemon's per-tick live inputs (posts / hostRunning /
   * sessionContexts / hostWaits builders) + the ALERT delivery closure + the
   * static per-process health deps (pooler state path / boot id). */
  buildHealthPosts: () => PostActivityInput[]
  buildHostRunning: () => boolean | undefined
  buildSessionContexts: () => SessionContextInput[] | undefined
  buildHostWaits: () => HostWaitPostInput[]
  healthNotifyHost: (hostEntry: HostEntryLike, alertFrame: string) => Promise<void>
  /** LANE 2 (fb-27) — the turn/end-error HEAD NOTIFICATION closure (the daemon
   * tick's `notifyHead` dep): deliver the framed `[From deepartments] Turn-error
   * <cls> …` to the post's OWN head (store.append + busDeliverToPost). */
  healthNotifyHead: (postId: string, frame: string) => Promise<void>
  healthPoolerStatePath: string
  healthBootId: string
  /** The DEEPARTMENTS RPC-channel endpoint deps (the webServer mount's
   * fallback handler consumes them at the same position — the composed dshd-gui
   * service reads the same object from the `gui` Binder bucket). */
  guiEndpointDeps: DeepartmentsEndpointDeps
  /** HOTFIX 0.2.2-1 (P4) — the dept_exec allowed-roots member: the PURE inline
   * computation (deps-bound, NO service read) exported so the dshd-
   * orchestration `deepartments.execRoots` DEFAULT binds the SAME computation
   * the tools run — an ACYCLIC default (the member never re-enters the
   * execRoots service). The service-first consumption (the substituted-policy
   * path) lives in the wrapper the dept_exec/dept_zstd_read guards run, NOT in
   * this export. */
  execRoots: (department: DepartmentConfig | undefined) => Promise<string[]>
}

// ---------------------------------------------------------------------------
// LANE FEEDBACK-NUDGE (owner backlog 2026-09-01 — ROADMAP.md:661; RD verdict
// ROADMAP.md:663 — OPCIÓN B, el default elegido): when an agent sees a tool
// error (or an "unknown tool"), a SHORT message invites it to consider using
// dept_feedback to report the error or request a change/improvement to the
// Quality Department. Three ADDITIVE surfaces, all sharing the line below:
//   (1)  the `tools/post-execute` waterfall (registered in the factory): EVERY
//        errored tool result — a thrown dept_* error, a guard denial, a
//        harness "unknown tool: <name>" — gets the nudge as an ADDITIONAL
//        CONTEXT (an injected plugin/notice), never a content replacement
//        (opción A discarded: the error contract is never altered);
//   (1b) OUR OWN guard-denial wrapper texts (dept_exec / dept_zstd_read —
//        tools the text of whose denies is fully ours) carry the SAME line
//        INLINE, so a denial read as plain text (a log, a replay) still nudges;
//        the waterfall SKIPS those errors (dedup — exactly one nudge per
//        error);
//   (1c) the harness "unknown tool" text is NOT ours to edit → the matching
//        guidance lives in the persona presets (agent.cordis.yml worker/head).
// ---------------------------------------------------------------------------

/** The single feedback-nudge line (the owner wording, ROADMAP.md:661). */
const FEEDBACK_NUDGE_LINE = '¿Error de tool o propuesta de mejora? Repórtala con dept_feedback al QD'

/** Build the nudge as an injected plugin/notice context message — the
 * wake-pack shape (kind:'plugin' / form:'notice' → a collapsed notice row in
 * the derived history, never a user-typed message). */
const buildFeedbackNudgeContext = () =>
  createUserMessage({
    content: [{ type: 'text', text: FEEDBACK_NUDGE_LINE }],
    source: {
      kind: 'plugin',
      plugin: 'deepartments',
      form: 'notice',
      summary: boundContextSummary('Deepartments tool-error feedback nudge (report it / propose an improvement via dept_feedback).')
    }
  })

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
    agentPresets,
    disposingHeads,
    PRESET_ID,
    HEAD_BASE_TOOLS,
    DENIED_POST_TOOLS,
    OWN_LAYER_POST_TOOLS,
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
    appendToolsetAudit,
    headPresetIdFor,
    createSecretaryTool,
    secretaryConfig,
    buildAgentRows,
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
    registry,
    qualityWorkerInspectProbability,
    headProgress,
    hosts,
    HOST_ATTACH_REPAIR_TIMEOUT_MS,
    HOST_ATTACH_REPAIR_RETRY_MS,
    HOST_AGENT_OPTIONS,
    materializePreset,
    materializeHeadPreset,
    dshHome,
    registryLoaded,
    hostsLoaded,
    stuckNow,
    STUCK_HEAD_MS,
    HEAD_DEFAULT_SESSION_TITLE,
    sleepTool,
    subagents,
    wakePackService,
    hostIdForSession,
    readJournal,
    journalPathFor,
    refreshPresence,
    savePresence,
    notifyHostPresence,
    presenceCache,
    assembleHeartbeat,
    roleForSessionLive,
    headRotationJournalStatus,
    verifyRotateReason,
    resolveSessionProjCachePath,
    deliverDaemonNotice,
    captureSchedulerAutoRunFailure,
    buildCatalogRows,
    wakePackInjected,
    deferredSleepReplace,
    computeHostSleepSurfacePlan,
    readPresenceStateFile,
    ensureHost,
    writeJournal,
    bumpHostSleepCounter,
    bumpPostSleepCounter,
    late
  } = deps

  // The LATE seams — resolved AT CALL TIME through the accessor object (the
  // DeliverySurface members + the tool arrays are built LATER on this fiber;
  // the zone closures dereference these only when a registration, a tool
  // execute, the retire seam, the boot wiring, or the binder buckets' lazy
  // readers actually fire — post-boot — so the apply-scope TDZ is never
  // entered). The CALL seams are thunk arrows of the exact signatures; the
  // store seams (messagesStoreReady / feedbackStoreReady) are THENABLES
  // delegating to the surface's boot-opened promises (the zone awaits them as
  // values); `delivery` is a delegating OBJECT (the tool executes call
  // deliverOrQueue). NOTE (SUB-BATCH 2): `workerSetup` is NO LONGER a late
  // seam — CUT2 defines it as a factory-local below (the sub-batch-1
  // registry's reference to it now resolves to the local const). NOTE
  // (SUB-BATCH 3): `resolveDepartmentWorkspaceCwd` / `resolveWorkspaceRootPath`
  // / `retirePost` / `archiveWorkerSession` are NO LONGER late seams either —
  // CUT3 defines them as factory-locals below (the CUT1 runners + the CUT2
  // workerSetup resolve the SAME local consts at call time). NOTE (SUB-BATCH
  // 4): `busTools` / `feedbackEmitTools` / `feedbackHeadTools` /
  // `redeliverPendingDeliveries` are NO LONGER late seams either — CUT4
  // defines them as factory-locals below (the CUT1 registry's for..of loops
  // + the CUT3 boot wiring resolve the SAME local consts at call time).
  // `messageStoreDir` is a non-late FACTORY-LOCAL = stateDir (the delivery
  // factory defines it EXACTLY as `const messageStoreDir = stateDir` — the
  // redeliver driver's build-time deref cannot be served by a late getter).
  const messageStoreDir = stateDir
  const maybeEmitQualityInspectDirective: ToolsFactoryDeps['late']['maybeEmitQualityInspectDirective'] = (surface) => late.maybeEmitQualityInspectDirective(surface)
  const deliverBusRecord: ToolsFactoryDeps['late']['deliverBusRecord'] = (...args) => late.deliverBusRecord(...args)
  const messagesStoreReady = {
    then(resolve: (value: MessagesStore) => unknown, reject: (reason?: unknown) => unknown) {
      return late.messagesStoreReady.then(resolve, reject)
    }
  } as Promise<MessagesStore>
  const feedbackStoreReady: ToolsFactoryDeps['late']['feedbackStoreReady'] = {
    then(resolve: (value: FeedbackStore) => unknown, reject: (reason?: unknown) => unknown) {
      return late.feedbackStoreReady.then(resolve, reject)
    }
  } as Promise<FeedbackStore>
  const delivery: ToolsFactoryDeps['late']['delivery'] = {
    deliverOrQueue: (...args) => late.delivery.deliverOrQueue(...args)
  }
  const busMemberIdFor: ToolsFactoryDeps['late']['busMemberIdFor'] = (agentId) => late.busMemberIdFor(agentId)
  const resolveQualityHeadEntry: ToolsFactoryDeps['late']['resolveQualityHeadEntry'] = () => late.resolveQualityHeadEntry()
  const feedbackForwarderFor: ToolsFactoryDeps['late']['feedbackForwarderFor'] = (emisor) => late.feedbackForwarderFor(emisor)
  const feedbackDeliveryOptions: ToolsFactoryDeps['late']['feedbackDeliveryOptions'] = (tipo, severidad) => late.feedbackDeliveryOptions(tipo, severidad)
  const busProfileFor: ToolsFactoryDeps['late']['busProfileFor'] = (memberId) => late.busProfileFor(memberId)
  const aclDenyGround: ToolsFactoryDeps['late']['aclDenyGround'] = (sender, recipient) => late.aclDenyGround(sender, recipient)
  const resolveBusCatalogRoute: ToolsFactoryDeps['late']['resolveBusCatalogRoute'] = (recipientId) => late.resolveBusCatalogRoute(recipientId)
  const isDormantRecipient: ToolsFactoryDeps['late']['isDormantRecipient'] = (recipientId) => late.isDormantRecipient(recipientId)
  const busEnsureHostForCaller: ToolsFactoryDeps['late']['busEnsureHostForCaller'] = (callerAgent) => late.busEnsureHostForCaller(callerAgent)
  const assertBusFanOut: ToolsFactoryDeps['late']['assertBusFanOut'] = (to) => late.assertBusFanOut(to)
  const busDeliverToPost: ToolsFactoryDeps['late']['busDeliverToPost'] = (...args) => late.busDeliverToPost(...args)
  const busDeliverToHost: ToolsFactoryDeps['late']['busDeliverToHost'] = (...args) => late.busDeliverToHost(...args)
  const resolveBusChild: ToolsFactoryDeps['late']['resolveBusChild'] = (...args) => late.resolveBusChild(...args)
  const deliverBusChild: ToolsFactoryDeps['late']['deliverBusChild'] = (...args) => late.deliverBusChild(...args)
  const freshMintHead: ToolsFactoryDeps['late']['freshMintHead'] = (...args) => late.freshMintHead(...args)
  const enqueueHostWake: ToolsFactoryDeps['late']['enqueueHostWake'] = (wake) => late.enqueueHostWake(wake)

  // --- LANE FEEDBACK-NUDGE (opción B — ROADMAP.md:663): the `tools/post-execute`
  // waterfall registration. SOLO cuando una tool LANZA error se anexa un
  // additionalContexts breve (el nudge); un resultado de ÉXITO nunca se toca y
  // el flujo normal no cambia (aditivo y no invasivo). El nudge viaja en las
  // additionalContexts de la decisión (un contexto plugin/notice que el loop
  // anexa DESPUÉS de los tool-results del paso) — el content del error y su
  // contrato quedan intactos (la opción A — accept{content}/reemplazo — está
  // descartada). Dedup (1b): un error cuya línea YA lleva el nudge inline (los
  // guard-denials de dept_exec/dept_zstd_read) se salta — una sola aparición
  // por error. El listener SIEMPRE delega vía next() y preserva la decisión
  // downstream (un accept/block/content de un listener posterior sigue siendo
  // autoritativo).
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (!result.isError) return downstream
    if (result.error.message.includes(FEEDBACK_NUDGE_LINE)) return downstream
    return {
      ...downstream,
      additionalContexts: [buildFeedbackNudgeContext(), ...(downstream.additionalContexts ?? [])]
    }
  })

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

  /** The REALPATH-RESOLVED SET of allowed roots for a dept_exec call: the fixed
   * DEPT_EXEC_DEFAULT_ROOTS, the repo root, the runtime stateDir, the caller's
   * department workspace, any configured org.execRoots, AND any configured
   * org.missionExecRoots (an EXPLICIT, REVOCABLE, AUDITABLE mission-level owner
   * grant that may name an OWNER-PROTECTED surface such as the STABLE home
   * `/opt/dsh/.dsh` for the DURATION of an owner-authorized mission). Each root
   * is realpath'd when it resolves (a symlink root collapses to its target, so
   * the cwd/path comparisons stay strict); an unresolvable root is kept verbatim.
   *
   * HOTFIX 0.2.2-1 (regresión runtime — profile live «execRoots.resolveAllowedRoots
   * is not a function» on EVERY dept_exec call): the computation is SPLIT in two.
   * `deptExecAllowedRootsInline` (below) is the PURE inline allowed-roots
   * computation (deps-bound, NO service read); it IS the exported ToolsSurface
   * `execRoots` member, so the dshd-orchestration `deepartments.execRoots`
   * DEFAULT binds the SAME computation the tools run. `deptExecAllowedRoots`
   * (the wrapper the dept_exec/dept_zstd_read guards actually run) consumes the
   * `deepartments.execRoots` POLICY service FIRST (a composable plugin may
   * substitute the allowed-roots posture — the policy-substitution fixture
   * does); when the service is ABSENT (the default / hermetic composition) it
   * falls back to `deptExecAllowedRootsInline` (R6, byte-identical). Exporting
   * the PURE computation (NOT the service-first wrapper) on the surface is what
   * keeps the default service's delegation ACYCLIC: the default →
   * surface.execRoots path can never re-enter the execRoots service (the
   * 0.2.2 shape mismatch that produced the live TypeError is gone BY
   * CONSTRUCTION — no runtime marker to keep in sync). */
  /** The PURE inline allowed-roots computation (HOTFIX 0.2.2-1 split): the
   * fixed DEPT_EXEC_DEFAULT_ROOTS + repoRoot + stateDir + the department
   * workspace + any configured org.execRoots/missionExecRoots, realpath'd —
   * the SAME set the dept_exec/dept_zstd_read guards gate against. NO service
   * read — this IS the default posture the `deepartments.execRoots` service
   * delegates to. */
  const deptExecAllowedRootsInline = async (department: DepartmentConfig | undefined): Promise<string[]> => {
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

  /** The service-first WRAPPER the dept_exec/dept_zstd_read guards run: the
   * composed `deepartments.execRoots` POLICY service wins when present
   * (substitution), else the PURE inline computation above (the default /
   * hermetic computation — R6). NOT the surface export (the surface carries
   * the PURE computation — the acyclic default). */
  const deptExecAllowedRoots = async (department: DepartmentConfig | undefined): Promise<string[]> => {
    const execRootsSvc = ctx.get('deepartments.execRoots') as
      | { resolveAllowedRoots(department: { id?: string } | undefined): Promise<string[]> }
      | undefined
    if (execRootsSvc !== undefined) {
      return execRootsSvc.resolveAllowedRoots(department as { id?: string } | undefined)
    }
    return deptExecAllowedRootsInline(department)
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
          // LANE FEEDBACK-NUDGE (1b): the guard-denial text is OURS → carries
          // the nudge inline (a plain-text read of the denial still nudges);
          // the waterfall dedups on the same line (one nudge per error).
          if (deny !== void 0) throw new Error(`[deepartments] dept_exec: ${deny}\n${FEEDBACK_NUDGE_LINE}`)
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
          // LANE FEEDBACK-NUDGE (1b): the guard-denial text is OURS → carries
          // the nudge inline (see the dept_exec wrapper above).
          if (deny !== void 0) throw new Error(`[deepartments] dept_zstd_read: ${deny}\n${FEEDBACK_NUDGE_LINE}`)
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
          // fb-78 A3: the mint is guarded against the workspace-registry
          // archived set (a worker spawned on an archived id would be
          // live-but-invisible). Synchronous re-mint on the ~0 collision.
          const sessionId = mintFreshSessionIdNotArchived(
            ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined,
            () => mintWorkerSessionId(args.postId),
            `dept_post_create "${args.postId}"`
          )
          if (agents.get(String(SessionId(sessionId))) !== void 0) throw new Error(`[deepartments] dept_post_create: a live agent already exists for session "${sessionId}"`)
          const firstMessage = args.firstMessage ?? args.prompt
          // F10 (spec 004 §9.1): the legacy dept_post_create emits a department
          // worker with NO role template (no persona/tools) — it still gets the
          // department-aware setup (architecture section), and NO role tools
          // (pre-F10 behavior: board-only, `allow: []`).
          const department = departmentForPost(headId)
          const setup = workerSetup(args.postId, headEntry.roomId, args.role, { department, reportRunToken: randomUUID().slice(0, 8) })
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
  // TOOLS ZONE — SUB-BATCH 2 of 4 (hoisted VERBATIM from applyInvoke
  // 4061-4672 = pre-SB1 4900-5511: the persona/architecture prompt sections
  // (ARCHITECTURE_SECTION_MAX + renderDepartmentTemplate +
  // buildArchitectureSection + installRoleSection + agentScopeOf) +
  // postSetup/headSetup/workerSetup (the head/worker setup closures) +
  // the head-dispose helpers (disposeHeadHandle / disposeHeadHandleOnce /
  // disposeJoinTimeoutMs / joinHeadDisposeOnce) + the retire helpers
  // (captureRetiredPostTurnError / settleRetiredPostDeliveries /
  // predictRetiredWorkerDeliverable — CUT3 retirePost consumes these).
  // =========================================================================
  /** The role of a post as a prompt section (persona = role, NOT a mission —
   * missions arrive as addressed messages on the bus). Registered on the post's
   * own systemPrompt layer when that service is composed. `isWorker` switches
   * the framing between a PERMANENT department head (manager) and a TEMPORARY
   * DISPOSABLE worker. Both are BOOT-QUIET (never act unaddressed). B3
   * cutover: rooms wording removed — the post lives in the agent catalog. */
  /** Length cap for a department-architecture prompt section (spec 004 §9.1):
   * over this the section is the START plus a reference to the full file. */
  const ARCHITECTURE_SECTION_MAX = 3500

  /** F10/role-persona template substitution (spec 004 §9.1 + the owner's
   * role-persona templating): replace the DEPARTMENT template variables —
   * `{{deptName}}`, `{{headPostId}}`, `{{workspacePath}}`,
   * `{{reportDir}}` (= <workspacePath>/reports) — in a prompt-section body
   * with the department's real values. Shared by the architecture section
   * (buildArchitectureSection) and the role persona (installRoleSection) so a
   * role template body can use the same variables and NEVER leaks a raw
   * uppercase `{{...}}` into the harness prompt expander (which only accepts
   * lowercase `[a-z][a-z0-9_]*` variable names). A missing workspacePath
   * empties `{{workspacePath}}`/`{{reportDir}}`; `{{cwd}}` (a legitimate
   * lowercase harness preset variable) is NEVER touched — this map only knows
   * the 4 department variables, so any other `{{...}}` passes through
   * untouched. */
  const renderDepartmentTemplate = (text: string, department: DepartmentConfig): string => {
    const workspacePath = department.workspacePath ?? ''
    const reportDir = workspacePath !== '' ? path.join(workspacePath, 'reports') : ''
    const headPostId = department.coordinator?.postId ?? ''
    return text
      .replace(/\{\{deptName\}\}/g, department.name)
      .replace(/\{\{headPostId\}\}/g, headPostId)
      .replace(/\{\{workspacePath\}\}/g, workspacePath)
      .replace(/\{\{reportDir\}\}/g, reportDir)
  }

  /** Read + template the department's ARCHITECTURE.md into a prompt section
   * body (undefined = omit the section cleanly). A department without an
   * ARCHITECTURE.md injects nothing and NEVER errors. Templating replaces
   * {{deptName}}, {{headPostId}}, {{workspacePath}}, {{reportDir}} with the
   * department's real values via renderDepartmentTemplate. Content >~3500
   * chars is truncated to its START plus a pointer to the full file.
   * SYNC (readFileSync): installRoleSection/postSetup must stay synchronous
   * (a root agent's systemPrompt sections are composed at materialization,
   * before the agent can be awaited — there is no await seam). */
  const buildArchitectureSection = (department: DepartmentConfig): string | undefined => {
    const archPath = path.join(repoRoot, 'presets', 'departments', department.id, 'ARCHITECTURE.md')
    let raw: string
    try {
      raw = readFileSync(archPath, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return void 0
      ctx.logger.warn(`[deepartments] architecture section for "${department.id}" could not be read (${error instanceof Error ? error.message : String(error)}) — section omitted`)
      return void 0
    }
    const rendered = renderDepartmentTemplate(raw, department).trim()
    if (rendered === '') return void 0
    if (rendered.length > ARCHITECTURE_SECTION_MAX) {
      return `## Department architecture\n\n${rendered.slice(0, ARCHITECTURE_SECTION_MAX)}\n\n… (truncated — full text at ${archPath})`
    }
    return `## Department architecture\n\n${rendered}`
  }

  const installRoleSection = (agentCtx: Context, role: string, postId: string, isWorker: boolean, extra?: { persona?: string; taskText?: string; reportRunToken?: string }, department?: DepartmentConfig): void => {
    const sp = agentCtx.get('systemPrompt')
    if (sp === void 0 || typeof (sp as { section?: unknown }).section !== 'function') return
    // fb-28 (QD MEDIO — WORK-REGISTER §5, naming D-Q6): a per-deployment REPORT
    // RUN TOKEN, minted uniquely by the spawn engines (spawn.ts) and injected
    // here so EVERY report path a worker writes is `<…>-<slug>-<token>.md` (the
    // DIRECT technical guarantee the path carries the unique token). A postId
    // reused across deployments (retire → respawn, a re-materialized/resumed
    // session, a job-worker round) then always produces DISJOINT report paths —
    // the previous deployment's report can never be overwritten. Code-only: the
    // report-convention presets (ARCHITECTURE.md / <role>.md) stay untouched
    // (their `<YYYY-MM-DD>-<slug>.md` remains the base; this directive makes the
    // token the authoritative suffix for every concrete report this worker
    // writes). Heads (permanent, same post) get no token.
    const reportRunToken = isWorker ? (extra?.reportRunToken ?? '') : ''
    sp.section({
      name: `deepartments:${isWorker ? 'worker' : 'head'}:role:${postId}`,
      order: 1,
      text: isWorker
        ? (`You are "${postId}", a ${role || 'rank-and-file researcher'} DISPOSABLE department worker of Deepartments (DeepSeek Harness). Your department HEAD created you as a temporary worker agent; you do not edit the repository, run builders, or spawn other agents. Read your messages with agent_messages, send with send_message, orient with dept_who, and persist your findings/memory with dept_memo_write. BOOT-QUIET: you never act on your own — on any materialization/resume/boot wake you stay idle and end your turn with NO action until an explicitly addressed message arrives. Work the task your department head assigns you; when you are DONE, write dept_memo_write to save your results, then report to your head and end your turn (head/worker sleep is retired — you never dept_sleep; only the Asistente/host rotates its own session, spec 002). You are DISPOSABLE: your head retires you with dept_worker_retire when you are finished. fb-29 TOOLSET HONESTY: verify your toolset at boot — read/write/glob/grep (plus dept_exec when your role declares it) must be present; if ANY of them is missing, report it to your head BEFORE fabricating anything (never operate with a silently reduced toolset).`
          + (reportRunToken === '' ? '' : ` REPORT-RUN TOKEN (fb-28): your unique run token is "${reportRunToken}". ALWAYS name your report file as \`<YYYY-MM-DD>-<slug>-${reportRunToken}.md\` (the token appended to the base \`<YYYY-MM-DD>-<slug>.md\` convention) — this guarantees your report can never overwrite a previous deployment's report of the same postId. Use the SAME token for any other per-run artifact you write.`))
        : `You are "${postId}", the ${role || 'department head'}. You are a permanent, first-class agent: you do not edit the repository, run builders, or spawn other agents. Your world is the messaging bus — read with agent_messages, send with send_message, orient with dept_who, and persist memory with dept_memo_write. You are permanent: you stay idle|running (head sleep is retired — only the Asistente/host keeps dept_sleep session rotation, spec 002). You may create and retire DISPOSABLE WORKERS of your department with dept_worker_spawn and dept_worker_retire (the department-scoped worker tools — the legacy dept_post_create/dept_post_retire still exist as the raw machinery). BOOT-QUIET: you never act on your own — on any materialization/resume/boot wake you stay idle and end your turn with NO action until an explicitly addressed message arrives; you never proactively send.`
    })
    // F3 (spec §7.4): the ROLE PERSONA — the role template's body (+ the task)
    // as a second section when dept_worker_spawn resolved one. The worker
    // still mounts the base `deepartments-worker` preset; the role is the
    // persona DELTA (the person supports it: role = persona + tool allowance).
    if (extra !== void 0 && (extra.persona !== undefined || extra.taskText !== undefined)) {
      const personaText = extra.persona ?? ''
      const taskText = extra.taskText === undefined ? '' : `\n\n## Your current assignment\n\n${extra.taskText}`
      // F10 persona templating: a role persona body (e.g. presets/
      // departments/<dept>/<role>.md) may carry the same department template
      // variables as the architecture — substitute the real values BEFORE the
      // section is assembled so a raw uppercase {{headPostId}} never reaches
      // the harness prompt expander (which only accepts lowercase variable
      // names). A post without a config department (legacy/department-less)
      // leaves the persona untouched. {{cwd}} is never touched.
      const raw = `${personaText}${taskText}`
      const combined = (department !== void 0 ? renderDepartmentTemplate(raw, department) : raw).trim()
      if (combined !== '') {
        sp.section({
          name: `deepartments:${isWorker ? 'worker' : 'head'}:role-persona:${postId}`,
          order: 2,
          text: combined
        })
      }
    }
    // F10 (spec 004 §9.1): the DEPARTMENT ARCHITECTURE — a 3rd systemPrompt
    // section for EVERY post of the department (worker AND head), when the
    // department has an ARCHITECTURE.md. Omitted cleanly otherwise (a
    // department-less/legacy post or a department with no architecture file).
    if (department !== void 0) {
      const architecture = buildArchitectureSection(department)
      if (architecture !== void 0) {
        sp.section({
          name: `deepartments:${isWorker ? 'worker' : 'head'}:architecture:${postId}`,
          order: 3,
          text: architecture
        })
      }
    }
  }

  /** Build the `setup(agentCtx)` for one post (head OR worker): mount the post's
   * dedicated preset and register its board toolset + role, scoped to the post
   * agent. Runs pre-publication on the fresh agent's scoped context
   * (rc.8 CreateAgentOptions.setup, index.d.ts:117). The `manager` flag gates
   * the department-lifecycle tools (a head creates/retires; a worker cannot).
   * F10 adds `tools` (a worker's role-template frontmatter `tools`) and
   * `department` (its config department for the architecture section). */
  /** M2.4 (2026-08-28): resolve the POST agent's scope key for the audit
   * waypoints WITHOUT depending on which module instance of
   * `@deepseek-ai/dsh-scope` the plugin resolved. The live profile loads TWO
   * copies of the package (the harness bundle's at /usr/lib/…/dsh/node_modules
   * and the repo's own under node_modules/.pnpm/…), and `kScope` is a
   * module-local symbol — so the harness's `createScope` (dsh-agent-loop) tags
   * the agent ctx with ITS symbol while the plugin's `scopeOf(agentCtx)` reads
   * ITS OWN symbol → returns undefined in live (post-boot 01:26Z audit:
   * toolset-final `count:14` with secretary 'no' — the waypoints fell back to
   * the GLOBAL view: the same 14 host-plane names for heads AND workers, incl.
   * the manager-gated `dept_post_retire` for a WORKER, while NO own-layer name
   * (calendar/dept_exec/secretary) was visible, even though the own-layer
   * registration demonstrably landed — the live worker session carries the
   * calendar+dept_exec tools). THE KEY: the harness's scope key IS the agent
   * object itself (`ReactLoopAgent`: `createScope(loopCtx, this)` +
   * `ctx.extend({ agent: this })`), so `agentCtx.agent` is the real key
   * whenever `scopeOf` is shadow-unreadable. The fallback keeps the waypoints
   * on the agent's OWN layer in both worlds: hermetic (scopeOf resolves — one
   * instance) and live (scopeOf → undefined → `agentCtx.agent`). */
  const agentScopeOf = (agentCtx: Context): object | undefined => scopeOf(agentCtx) ?? (agentCtx as unknown as { agent?: object }).agent

  const postSetup = (postId: string, roomId: string, role: string, opts: { preset: string; manager: boolean; persona?: string; taskText?: string; tools?: string[]; department?: DepartmentConfig; reportRunToken?: string }): ((agentCtx: Context) => unknown) => {
    const presetId = opts.preset
    const kind = opts.manager ? 'head' : 'worker'
    // F10 (spec 004 §7.1): the role template's frontmatter `tools` (a worker)
    // OR the head's fixed base set (a head) become the REAL inherited-tool
    // allowance. Denied / unknown / scope-local names are DROPPED (with a
    // warning) so restrict() never throws on a template that names a tool the
    // agent scope cannot see. The own-layer board tools are exempt from the
    // mask (scoped registrations always stay visible) so they are NOT named.
    const declared: readonly string[] = opts.manager ? HEAD_BASE_TOOLS : (opts.tools ?? [])
    return async (agentCtx) => {
      // (a) AWAIT the dedicated preset mount FIRST, before the capability probe.
      //     read/write/glob/grep are PRESET-ONLY contributions (the web
      //     deepartments-dev profile disables the host-plane base
      //     tool-fs/tool-fs-search — dsh-web-app/cordis.patch.yml:333-337), so a
      //     probe that runs BEFORE the mount — the pre-fix fire-and-forget
      //     `void agentPresets.mount(...)` — sees only the host-global web tools,
      //     drops the fs tools from the allow-list, and restrict() then MASKS
      //     them (the F10 runtime symptom: web yes, fs no). The harness awaits
      //     setup (dsh-agent-loop lib/index.js:1260 `await raceAbort(setup?.(...))`),
      //     so the async mount fully installs its standing bind before publish.
      //     A failed mount degrades to board-only (pre-F10 behavior), never a
      //     failed spawn.
      if (agentPresets !== void 0) {
        try {
          await agentPresets.mount(agentCtx, presetId)
        } catch (error: unknown) {
          ctx.logger.warn(`[deepartments] ${kind} "${postId}" preset mount failed (board tools still installed): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // M2.3 WP1b (post-mount waypoint): did the standing leave the secretary
      // bound on the agent scope RIGHT AFTER the mount? Separates
      // row-absent from apply-failed — with the own-layer registration this is
      // the STANDING chain's contribution only (a head's visibility no longer
      // depends on it). Written to the guaranteed audit channel
      // `<stateDir>/toolset-audit.jsonl` — the deepartments warns never reach
      // the harness stdout (M2.2 finding).
      // M2.4: `scopeOf(agentCtx)` may be undefined in the LIVE profile (the
      // plugin resolves a DIFFERENT dsh-scope module instance than the harness
      // — see agentScopeOf) — the waypoint therefore reads via the resolved
      // key (scopeOf → `agentCtx.agent` fallback), never the broken global
      // view; `scopeKeySource` records which seam produced the key.
      appendToolsetAudit(stateDir, {
        wp: 'post-mount',
        postId,
        kind,
        presetId,
        ts: Date.now(),
        scopeKeySource: scopeOf(agentCtx) === void 0 ? (agentCtx as unknown as { agent?: unknown }).agent === void 0 ? 'unscoped' : 'ctx-agent' : 'scopeOf',
        secretary: agentCtx.tools.get('secretary', agentScopeOf(agentCtx)) === void 0 ? 'no' : 'yes'
      })
      // (0) Tool restriction: a root agent has no startContinuable toolFilter,
      // so we mask the GLOBAL host-plane tools to `allowList` (rc.8 dsh-tools
      // restrict — index.d.ts:611 "A restriction filters what a scope
      // inherits... a restricted-away global reads as absent"; it NEVER touches
      // the scope's OWN layer). The post therefore sees its own-layer board
      // tools + only the inherited capability tools in the allow list. A
      // template that still names a non-restrictable name degrades SAFELY to
      // `allow: []` (the pre-F10 behavior — board tools only; never a failed
      // spawn).
      //
      // F10 live-fix (2026-08-23): the allow-list MUST be built against the
      // AGENT's own scope, not the host global layer. In the live dsh
      // agent-preset layout the model-facing capability tools (read/write/glob/
      // grep/web_search/web_fetch) are an ANCESTOR contribution behind the base
      // preset's `isolate` realm — they are NOT on the host GLOBAL layer — so
      // the pre-fix probe `ctx.tools.get(name)` (the host GLOBAL view) resolved
      // every declared capability tool to undefined and degraded every post to
      // board-only (the F10 runtime symptom). `agentCtx.tools.get(name,
      // agentScope)` reads the agent's OWN view: it resolves the global +
      // ancestor (inherited) capability tools. Own-layer names (the bus /
      // lifecycle tools the role templates ALSO declare) are excluded FIRST via
      // OWN_LAYER_POST_TOOLS — naming a scope-local name in restrict() would
      // THROW and degrade to allow:[] again.
      // M2.1 (deploy fix, 2026-08-28): the 'secretary' name in HEAD_BASE_TOOLS
      // is now ALWAYS found here — the tool-secretary row of the head preset
      // registers its tool UNCONDITIONALLY at apply time (src/subagent.ts), so
      // a standing mount that applies the row while the 'spawn' provider is
      // still absent no longer leaves the tool missing at this probe (the M2.1
      // finding: a rematerialized head never saw its own secretary because the
      // pre-fix registration was gated on the provider and this drop-warn then
      // masked it permanently). The drop-warn stays the correct degradation for
      // a row that is genuinely ABSENT (a template bug): the probe is
      // deliberately NOT widened to allow declared-but-unseen names blindly —
      // restrict() validates inherited names loudly, so naming an unseen name
      // would throw and the allow:[] fallback would mask EVERY inherited tool
      // (strictly worse than dropping one name).
      const agentScope = agentScopeOf(agentCtx)
      const allowList: string[] = []
      for (const name of declared) {
        if (DENIED_POST_TOOLS.has(name)) {
          ctx.logger.warn(`[deepartments] ${kind} "${postId}" role tool "${name}" is security-denied (no subagent/wrapper machinery or run_code for department posts) — dropped`)
          continue
        }
        if (OWN_LAYER_POST_TOOLS.has(name)) continue
        if (agentCtx.tools.get(name, agentScope) === void 0) {
          ctx.logger.warn(`[deepartments] ${kind} "${postId}" role tool "${name}" is not visible to the agent scope (not an inherited global/ancestor tool) — dropped`)
          continue
        }
        allowList.push(name)
      }
      // M2.3 WP2 (probe waypoint): the consolidated probe line — the inherited
      // allow-list as BUILT + whether 'secretary' is in it. POST-MOVE the
      // secretary lives in OWN_LAYER_POST_TOOLS, so the probe skips it here and
      // the status is 'dropped(own-layer)' (by design — it is registered on the
      // own layer AFTER the restrict, see installHeadBoardTools); a
      // 'dropped(not-visible)' would mean a future reordering ran the own-layer
      // registration BEFORE the probe, and 'found' would mean the name leaked
      // back into HEAD_BASE_TOOLS (the M2.3 coherence condition).
      // M2.4: the probe MUST resolve the agent's own layer the same way the
      // tool registry does (`agentScopeOf` — scopeOf with the `agentCtx.agent`
      // fallback for the live dual-dsh-scope profile; the 01:26Z post-boot
      // audit showed `count:14` with the SAME 14 host-plane names for heads AND
      // workers — incl. the manager-gated dept_post_retire for a WORKER — i.e.
      // the waypoint had read the GLOBAL view because the plugin's `scopeOf`
      // module instance differs from the harness's: two copies of dsh-scope,
      // two `kScope` symbols). `scopeKeySource` + `allowCount` record what the
      // probe saw and through which seam, so the audit says WHY the toolset
      // landed (or not).
      appendToolsetAudit(stateDir, {
        wp: 'probe',
        postId,
        kind,
        allow: allowList.join(','),
        allowCount: allowList.length,
        scopeKeySource: scopeOf(agentCtx) === void 0 ? (agentCtx as unknown as { agent?: unknown }).agent === void 0 ? 'unscoped' : 'ctx-agent' : 'scopeOf',
        secretary: DENIED_POST_TOOLS.has('secretary')
          ? 'dropped(denied)'
          : OWN_LAYER_POST_TOOLS.has('secretary')
            ? 'dropped(own-layer)'
            : allowList.includes('secretary')
              ? 'found'
              : agentCtx.tools.get('secretary', agentScope) === void 0
                ? 'dropped(not-visible)'
                : 'found'
      })
      let restrictOwn: () => void
      try {
        restrictOwn = agentCtx.tools.restrict({ allow: allowList })
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] ${kind} "${postId}" tool restrict(${JSON.stringify(allowList)}) fell back to allow:[] — ${error instanceof Error ? error.message : String(error)}`)
        restrictOwn = agentCtx.tools.restrict({ allow: [] })
      }
      // (b) Register the board toolset scoped to this agent (manager gates the
      // department-lifecycle create/retire tools for heads). B2 (spec W5):
      // `dept_exec` is granted ONLY to a post whose allow-list DECLARES it —
      // for a worker, the role template's frontmatter `tools` (a config head
      // never declares it; HEAD_BASE_TOOLS does not carry it), so a post that
      // does not declare the tool never sees it and the host never gets it.
      const tools = installHeadBoardTools(agentCtx, opts.manager, { allowExec: declared.includes('dept_exec') })
      // M2.3 WP3 (toolset-final waypoint): enumerate the candidate toolset on
      // the AGENT scope AFTER the own-layer install (the proxy of the real
      // "attach" — the point the toolset derivation is fully done): how many
      // candidate names are visible + the key ones (secretary, send_message,
      // dept_who, dept_memo_write). `secretary=yes` here proves the OWN layer
      // carried it (post-restrict); `secretary=no` with the own-layer
      // registration present would expose a registration-order regression.
      // M2.4: `scopeKeySource` says WHICH seam produced the key the waypoint
      // read through — 'scopeOf' (hermetic: one module instance) or 'ctx-agent'
      // (live: the harness's own key object — the dual-dsh-scope fallback). A
      // line with scopeKeySource 'unscoped' would mean the audit re-fell to the
      // GLOBAL view (the pre-fix false 'no' of the 01:26Z post-boot audit).
      // `ownVisible` counts the own-layer candidate names that landed (proves
      // the registration, not just secretary alone).
      {
        const candidates = [...new Set([...HEAD_BASE_TOOLS, ...OWN_LAYER_POST_TOOLS, 'dept_calendar_add', 'dept_calendar_list', 'dept_calendar_remove', 'dept_feedback', 'dept_feedback_list', 'dept_feedback_update'])]
        const visible = candidates.filter((name) => agentCtx.tools.get(name, agentScope) !== void 0)
        const ownVisible = visible.filter((name) => OWN_LAYER_POST_TOOLS.has(name)).length
        appendToolsetAudit(stateDir, {
          wp: 'toolset-final',
          postId,
          kind,
          count: visible.length,
          ownVisible,
          scopeKeySource: scopeOf(agentCtx) === void 0 ? (agentCtx as unknown as { agent?: unknown }).agent === void 0 ? 'unscoped' : 'ctx-agent' : 'scopeOf',
          secretary: visible.includes('secretary') ? 'yes' : 'no',
          send_message: visible.includes('send_message') ? 'yes' : 'no',
          names: visible.join(',')
        })
      }
      // (c) Persona = the role (a head's role or a worker's role), NOT a mission.
      // F3: the ROLE PERSONA delta (+ the task) rides the same section seam.
      // F10: `department` feeds the architecture section (spec 004 §9.1).
      installRoleSection(agentCtx, role, postId, opts.manager === false, { persona: opts.persona, taskText: opts.taskText, reportRunToken: opts.reportRunToken }, opts.department)
      // Ensure the agent-scoped registrations unwind with the agent.
      agentCtx.effect(() => () => { tools.dispose(); restrictOwn() }, `deepartments: ${kind} board tools (${postId})`)
    }
  }

  /** The setup for a PERMANENT department head (manager — can create/retire
   * workers). Mounts the 'deepartments-head' preset. F10: `department` feeds the
   * architecture section (spec 004 §9.1) for the head post. */
  const headSetup = (postId: string, roomId: string, role: string, presetId: string = PRESET_ID, department?: DepartmentConfig): ((agentCtx: Context) => unknown) =>
    postSetup(postId, roomId, role, { preset: presetId, manager: true, department })

  /** The setup for a DISPOSABLE department WORKER (no create/retire). Mounts
   * the 'deepartments-worker' preset. F3: `extra` carries the role template
   * persona + the spawned task (spec §7.4 — persona delta + assignment).
   * F10: `extra.tools` carries the role template's frontmatter `tools` (the
   * real inherited allow-list); `extra.department` feeds the architecture
   * section. fb-28: `extra.reportRunToken` (a per-spawn UNIQUE short token
   * minted by the spawn engines, spawn.ts) is threaded into the worker's role
   * section so its report filename ALWAYS carries `<slug>-<token>` — a reused
   * postId (retire → respawn, resumed session) can NEVER overwrite the previous
   * deployment's report (the report-path collision of WORK-REGISTER §5 / fb-28).
   * Absent (legacy dept_post_create) → the framing role section only, NO role
   * tools (pre-F10 behavior: board-only, `allow: []`). */
  const workerSetup = (postId: string, roomId: string, role: string, extra?: { persona?: string; taskText?: string; tools?: string[]; department?: DepartmentConfig; reportRunToken?: string }): ((agentCtx: Context) => unknown) =>
    postSetup(postId, roomId, role, { preset: WORKER_PRESET_ID, manager: false, persona: extra?.persona, taskText: extra?.taskText, tools: extra?.tools, department: extra?.department, reportRunToken: extra?.reportRunToken })

  /** Dispose one head's live AgentHandle (its only teardown capability; the
   * bare `agents.get(id)` returns no dispose — rc.8 index.d.ts:349 vs 155-158).
   * Idempotent. The durable session survives for a later resume. Shared by heads
   * and workers (both keyed in byHeadHandle by their session id). */
  const disposeHeadHandle = async (sessionId: string): Promise<void> => {
    const handle = byHeadHandle.get(sessionId)
    if (handle === void 0) return
    byHeadHandle.delete(sessionId)
    try {
      await handle.dispose()
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] head dispose for ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** disposeHeadHandle with the in-flight dedupe of `disposingHeads`: two
   * concurrent disposers of the SAME session (dept_sleep + a wake respawn, a
   * double dept_sleep, retirePost during a sleep) share ONE detach and proceed
   * only once it settles. Never rejects (disposeHeadHandle logs and swallows
   * handle errors), so a fire-and-forget caller (`void`) cannot produce an
   * unhandled rejection. Returns the shared promise so the fire-and-forget
   * caller and an awaiting caller (materializePost) agree on the same
   * completion; the map entry is dropped once settled (no leak, no stale
   * dedupe of a later dispose of a re-materialized handle). */
  const disposeHeadHandleOnce = (sessionId: string): Promise<void> => {
    const inFlight = disposingHeads.get(sessionId)
    if (inFlight !== void 0) return inFlight
    const run = disposeHeadHandle(sessionId).finally(() => {
      disposingHeads.delete(sessionId)
    })
    disposingHeads.set(sessionId, run)
    return run
  }

  // DEADLOCK FIX (incident 2026-08-26): the BOUNDED detach-join window for the
  // sleep respawn (materializePost). The real harness dispose() sends
  // machine.cancel + `await machine.whenIdle()`; when the machine's OWN turn is
  // still executing a TOOL (the QD-directive cascade of 2026-08-26 20:48Z/
  // 21:18Z), whenIdle NEVER settles and the detach becomes a zombie. A plain
  // `await disposeHeadHandleOnce` on that zombie pends forever — and every
  // awaited bus delivery to the slept head joins it (the send_message that
  // froze the host). Production default 10s — a NORMAL join settles in
  // milliseconds (the turn ends right after the fire-and-forget detach
  // dispatch), so the bound is a pure safety net. Hermetic tests override it.
  const disposeJoinTimeoutMs = (): number => {
    const raw = process.env.DEEPARTMENTS_DISPOSE_JOIN_TIMEOUT_MS
    const n = raw === undefined ? NaN : Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 10_000
  }

  /** DEADLOCK FIX (2026-08-26) — the BOUNDED `disposeHeadHandleOnce` join for
   * the sleep respawn. Returns true when the detach settled before the bound;
   * false on timeout. A timeout can NEVER corrupt the respawn: the fresh
   * incarnation mints a NEW session id (F8), so the zombie machine (still on
   * the OLD id, disposed in the background via the disposingHeads dedupe) can
   * never collide with it — the join exists only to avoid racing a *settling*
   * detach, and unbounded joining is strictly worse than proceeding. */
  const joinHeadDisposeOnce = async (sessionId: string): Promise<boolean> => {
    return Promise.race([
      disposeHeadHandleOnce(sessionId).then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), disposeJoinTimeoutMs())
      })
    ])
  }

  /** Retire a registered post cleanly — the SHARED retirement path used by the
   * global HOST-plane `dept_post_retire` AND the head own-layer `dept_post_retire`.
   *
   * Retirement = (a) dispose its live AgentHandle (if any), (b) unregister it
   * from byPost/byChild and persist. B3 cutover: NO withdrawal note (the board
   * is gone — the registry unregistration is the only signal). The persisted
   * durable session remains (no native delete — researcher M1), but the registry
   * stops addressing it, so it is never woken again; a retired CONFIGURED head is
   * simply re-materialized by ensureAllHeads as before (documented gap), whereas
   * a retired DISPOSABLE WORKER is never re-materialized (workers are runtime-only,
   * not config — see ensureAllHeads).
   *
   * F1 (spec 004 §4.3): a WORKER retire is MARKED, NOT ERASED — the entry stays
   * in posts.json (and in byPost) with `retired: true` (history queryable), and
   * every live-catalog consumer (busDeliverCatalog addressing, dept_who, the
   * wake-pack roster) filters it. A configured HEAD retire keeps today's
   * semantics (entry deleted, re-materialized by config at boot — cosmetic).
   *
   * Scope (F1, spec 004 §4.2 — restored to "ONLY MY workers"): a HOST caller
   * (`postIdForChild(callerId) === undefined`) may retire ANY post (today's
   * semantics). A HEAD caller is restricted to DISPOSABLE WORKERS **of its own
   * department**: the target must be a worker whose `managerId` is the caller's
   * postId OR whose `departmentId` equals the caller's config department —
   * replacing the pre-F1 generic "any worker" check. A legacy worker without
   * the F1 fields matches neither (backfill policy: an estate-owned orphan is
   * host-retireable only). A permanent head is never retired by a head. */
  /** FIX-1 (QD NO_ADAPTER alerting) — capture a FRESH turn/end ERROR (the
   * NO_ADAPTER / no-provider class) at the moment a WORKER is cleanly retired and
   * append ONE post-error row so the health daemon ALERTS the host even though the
   * post is about to be retired. The daemon's per-tick turn-error capture
   * (runHealthDaemonTick → scanTurnErrorCaptures) SKIPS retired posts
   * (`if (post.retired === true) continue`) AND the retire path disposes the handle
   * (disposeHeadHandleOnce below), so the live session events are GONE before the
   * ≤60s tick scans them — a no-op-die worker (NO_ADAPTER at its first model call)
   * would otherwise be indistinguishable from success. Reading the STILL-LIVE
   * handle's events HERE (before dispose) recovers the error turn.
   * Never throws (a capture/persist failure is a warn — non-fatal to the retire);
   * deduped via turn-errors-state so a turn the daemon ALREADY recorded (and is
   * still fresh) is NOT double-counted. */
  const captureRetiredPostTurnError = async (stateDir: string, sessionId: string, postId: string): Promise<void> => {
    try {
      const liveAgent = agents?.get(sessionId)
      // Dual session-log read: `snapshotEvents()` on the 0.1.2-rc.1 surface,
      // legacy cached `events` getter on the pre-rc.1 core (0.1.1-rc.2); absent
      // session → empty capture.
      const events = (liveAgent?.session?.snapshotEvents?.() ?? liveAgent?.session?.events ?? []) as HealthSessionEvent[]
      if (events.length === 0) return
      const capture = scanTurnErrorCaptures(events, postId)
      if (capture === undefined) return
      const nowMs = Date.now()
      // Only a FRESH error (<= the turn-error window) is worth recording at retire —
      // a stale turn either was already captured by a prior daemon tick or is too
      // old to alert on.
      if (nowMs - capture.ts > TURN_ERROR_FRESH_WINDOW_MS) return
      // Dedupe: a turn the daemon ALREADY recorded (and is still fresh) is not
      // recorded twice (the retire-seam is a second chance, not a double-count).
      const captureState = readTurnErrorsState(stateDir)
      const lastCaptured = captureState[capture.key]
      if (lastCaptured !== undefined && nowMs - lastCaptured < TURN_ERROR_FRESH_WINDOW_MS) return
      await appendPostError(stateDir, { ts: capture.ts, postId: capture.postId, error: capture.error }, nowMs)
      await writeTurnErrorsState(stateDir, { ...captureState, [capture.key]: nowMs })
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] dept_worker_retire: turn-error capture failed (non-fatal to the retire): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** W7-A (in-session settlement of a retiring post's pending deliveries): the
   * dead-recipient `terminal`-una-vez settlement of the boot re-delivery driver
   * (DeliveryRedeliverer.run) runs ONLY at boot — a post RETIRED in-session
   * (dept_post_retire / dept_worker_retire / the auto-retire seams) left its
   * pending 'prepared'/'failed' write-ahead sidecar rows parked until the next
   * boot. This mirror settles them AT RETIRE TIME so a retired worker's stale
   * deliveries are 'terminal' BEFORE any boot; the boot pass keeps working as
   * the crash fallback (untouched — it re-settles idempotently after a crash).
   * Semantics are the boot driver's EXACTLY: iterate the LATEST row per
   * (messageId, recipientId) (a later 'delivered'/'resumed'/'self'/'terminal'
   * row shadows an earlier 'prepared'/'failed' one — the same latestPerKey
   * dedupe as DeliveryRedeliverer.run), settle the pairs of the ONE retiring
   * recipient whose latest status `needsRedelivery` by appending a SINGLE
   * 'terminal' row via the shared markDelivery utility, and NEVER emit a fresh
   * 'prepared'/'failed' row (the settle only appends 'terminal' → the W6 health
   * daemon never re-alerts for the retired post, and scanDeliveryFindings keeps
   * excluding a retired member — C6/Bug-A already covered). A pair ALREADY
   * settled (delivered/resumed/self/terminal) is untouched, and a LIVE
   * recipient's rows are untouched (scoped strictly to `retiredPostId`).
   * Non-fatal by design (mirrors captureRetiredPostTurnError): a sidecar
   * read/mark failure only warns — the retire still commits and the boot pass
   * re-settles on the next boot. */
  const settleRetiredPostDeliveries = async (retiredPostId: string): Promise<void> => {
    try {
      // ALTO-1 (m-728 rebind guard): the settle is keyed (messageId,
      // recipientId), but a PRE-fix sidecar may hold a STALE row whose id was
      // REBOUND by a newer compaction to a DIFFERENT record. Guard (the boot
      // driver's own rebind rule): settle ONLY a pair whose CURRENT record
      // exists AND actually addresses the recipient — anything else is a stale
      // row (its record trimmed, or the current record never sent to this
      // recipient) and is skipped, so the settle NEVER settles the wrong
      // record. An unreadable messages file → the empty map → nothing settles
      // (conservative; the boot pass re-evaluates).
      let recordsById = new Map<string, MessageRecord>()
      try {
        const records = await loadMessageRecords(resolveMessagesPath(stateDir))
        recordsById = new Map(records.map((record) => [record.id, record]))
      } catch {
        recordsById = new Map()
      }
      let text: string
      try {
        text = await readFile(resolveDeliveriesPath(stateDir), 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // nothing ever sent
        throw error
      }
      const latestPerKey = new Map<string, DeliveryRow>()
      for (const row of parseDeliveryRows(text)) latestPerKey.set(`${row.messageId}\u0000${row.recipientId}`, row)
      for (const row of latestPerKey.values()) {
        if (row.recipientId !== retiredPostId) continue
        if (!needsRedelivery(row.status)) continue
        const record = recordsById.get(row.messageId)
        if (record === void 0 || !record.to.includes(row.recipientId)) continue
        await markDelivery(stateDir, row.messageId, row.recipientId, 'terminal')
        ctx.logger.info(`[deepartments] retire settle: ${row.messageId} → ${row.recipientId} (was ${row.status}) → 'terminal' — post retired in-session, settled once (no boot needed)`)
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] retire settle for "${retiredPostId}" failed (non-fatal — the boot re-delivery pass re-settles): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** O2 (MICRO-BATCH O2, QD compromiso — ANALYZE m-598): predict whether a
   * RETIRED worker produced a DELIVERABLE, for the worker-retired q-i directive
   * (`deliverable: none|report`). CONSERVATIVE, DURABLE heuristic (decided with
   * the code; documented for the QD pipeline):
   *   'none'    ⇔ a RECENT turn-error row for this worker EXISTS in
   *              `<stateDir>/post-errors.jsonl` (inside HEALTH_ERROR_WINDOW_MS —
   *              2h, the SAME anomaly window the health daemon scans) AND the
   *              worker produced NO durable OUTBOUND in that anomaly window (no
   *              messages.jsonl record `from === workerPostId` with `ts >=
   *              latestErrorTs - HEALTH_ERROR_WINDOW_MS` — every send_message
   *              the worker ever made persists there; a WRITE-only worker counts
   *              as outbound-less in the error case because a report that was
   *              never SENT left no durable trace, and the conservative label
   *              is 'none').
   *   'report'  otherwise (DEFAULT — a clean retire, an error with ANY durable
   *              outbound in the window, or any read/parse failure: the
   *              existing flow never changes and the retire never breaks).
   * ORDER/DURABILITY (fb-8 verification — mission fix (a)): the outbound read
   * is read-after-write GUARANTEED. send_message appends the record durably
   * BEFORE any delivery ("durable first (persist-before-deliver)" —
   * MessagesStore.append awaits appendMessageRecord, which awaits appendFile,
   * BEFORE delivering — dshd-core messages.ts:419; the worker's send_message
   * appends at invoke.ts:7242), the delivery auto-retire (busDeliverToPost)
   * and any head retire therefore run AFTER the record is on disk, and this
   * predictor reads messages.jsonl
   * directly (a fresh readFile) AFTER settleRetiredPostDeliveries +
   * archiveWorkerSession — ordered AFTER the worker's own delivery path.
   * BIAS SKEW (fb-8 verification — mission fix (b)): the comparison is
   * `record.ts >= latestErrorTs - HEALTH_ERROR_WINDOW_MS`, NOT a strict
   * `ts > latestErrorTs`. A strict-after comparison mislabels the REAL
   * production shape: the worker's FINAL turn SENDS its report (durable record
   * ts = send time) and THEN the same turn ENDS in error — the error row's ts
   * is the turn/end EVENT time (scanTurnErrorCaptures uses event.time,
   * dshd-health index.ts:947), which lands AFTER the same-turn sends, so a
   * legitimately-published report read 'none'. With the skew (the SAME 2h
   * anomaly window the error itself must be inside), any durable outbound the
   * worker made within the window — BEFORE or AFTER the error row — proves
   * published content → 'report'; only an error with ZERO outbound in the
   * window is 'none'. The 3 O2 test cases are deterministic under this rule:
   * (a) error + 0 outbound → 'none'; (b) clean retire (no error) → 'report';
   * (c) error + a durable send (either in-turn order) → 'report'.
   * Rationale: a worker whose FINAL turn died (the 400 reasoning_content class:
   * a long silent turn, 0 outbound) leaves its error row FRESH at retire time
   * (captureRetiredPostTurnError appends it right before this predictor runs —
   * the retire seam at retirePost) and has no durable message in the window, so
   * 'none' lets the ANALYZE pipeline QUESTION the retire instead of citing a
   * conclusion that was never published. Never throws (a failure degrades to
   * 'report'). */
  const predictRetiredWorkerDeliverable = async (workerPostId: string): Promise<'none' | 'report'> => {
    try {
      const nowMs = Date.now()
      const errors = readPostErrorsFile(stateDir)
        .filter((row) => row.postId === workerPostId && nowMs - row.ts <= HEALTH_ERROR_WINDOW_MS)
      if (errors.length === 0) return 'report'
      const latestErrorTs = Math.max(...errors.map((row) => row.ts))
      let text: string
      try {
        text = await readFile(resolveMessagesPath(stateDir), 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') text = '' // no message ever persisted
        else throw error
      }
      // fb-8 bias skew: an outbound at-or-after `latestErrorTs - HEALTH_ERROR_WINDOW_MS`
      // (the SAME 2h anomaly window) counts — a durable send BEFORE or AFTER the
      // error proves the worker published content; only error + ZERO outbound in
      // the window is 'none'. (A strict `ts > latestErrorTs` mislabeled the
      // send-then-turn-error shape: the error row's ts is the turn/end EVENT
      // time, AFTER the same-final-turn sends.)
      const outboundInWindow = parseMessageRecords(text)
        .some((record) => record.from === workerPostId && record.ts >= latestErrorTs - HEALTH_ERROR_WINDOW_MS)
      return outboundInWindow ? 'report' : 'none'
    } catch {
      return 'report'
    }
  }

  // =========================================================================
  // TOOLS ZONE — SUB-BATCH 3 of 4 (hoisted VERBATIM from applyInvoke 4099-5371:
  // the workspace + ensureHead + retire/archive + boot-check/reconcile closures
  // + the BOOT WIRING — the same closures, the same order, the same semantics).
  // CUT3 consumes what CUT2 already produces as factory-locals
  // (captureRetiredPostTurnError / settleRetiredPostDeliveries /
  // predictRetiredWorkerDeliverable / disposeHeadHandleOnce / headSetup) and
  // defines retirePost / archiveWorkerSession / resolveDepartmentWorkspaceCwd /
  // resolveWorkspaceRootPath as NEW factory-locals (their 4 late seams are
  // GONE — earlier references resolve at call time, post-boot, TDZ never
  // entered). The 2 NEW late seams (maybeEmitQualityInspectDirective +
  // redeliverPendingDeliveries — the delivery factory's members) are rebound
  // at the top of this factory and dereferenced only post-boot.
  // =========================================================================

  const retirePost = async (postId: string, callerAgentId: string, opts?: { deferDisposeMs?: number }): Promise<{ postId: string; retired: true }> => {
    const entry = byPost.get(postId)
    if (entry === void 0) throw new Error(`[deepartments] dept_post_retire: "${postId}" is not a registered post`)
    // Scope check for HEAD callers (a caller that IS a registered post is a
    // department head; a caller with no post entry is a HOST).
    const callerId = postIdForChild(callerAgentId)
    if (callerId !== void 0) {
      const callerEntry = byPost.get(callerId)
      if (callerEntry === void 0) throw new Error(`[deepartments] dept_post_retire: caller "${callerId}" is not a registered post`)
      // A head may only retire DISPOSABLE WORKERS (the room-equality check was
      // board-specific and is removed with the rooms).
      if (entry.provider !== 'worker') throw new Error(`[deepartments] dept_post_retire: "${postId}" is not a disposable worker — a head may only retire workers, never a permanent head`)
      // F1: ONLY MY WORKERS — the caller must be the entry's manager (the head
      // that created it) or a head of the SAME config department (a manager
      // replacement/department-cluster head stays in scope).
      const callerDepartment = departmentForPost(callerId)
      const sameManager = entry.managerId !== void 0 && entry.managerId === callerId
      const sameDepartment = entry.departmentId !== void 0 && callerDepartment !== void 0 && entry.departmentId === callerDepartment.id
      if (!sameManager && !sameDepartment) {
        throw new Error(`[deepartments] dept_post_retire: "${postId}" is not a worker of YOUR department (manager ${entry.managerId ?? 'unset'}, department ${entry.departmentId ?? 'unset'}) — a head may only retire the workers it created or the workers of its own department`)
      }
    }
    // Idempotent (spec patterns): a second retire of an already-marked worker
    // succeeds as a no-op (the dispose is deduped via disposeHeadHandleOnce).
    if (entry.retired === true) return { postId, retired: true }
    if (entry.provider === 'worker') {
      // FIX-1 (QD NO_ADAPTER alerting): BEFORE the mark + dispose, capture a FRESH
      // turn/end error (e.g. NO_ADAPTER) on the STILL-LIVE handle's session events
      // so the health daemon ALERTS the host even though this post is about to be
      // retired (the daemon skips retired posts AND the dispose empties the events
      // — see captureRetiredPostTurnError). Never throws / non-fatal to the retire.
      await captureRetiredPostTurnError(stateDir, entry.sessionId, postId)
      // MARK, NOT ERASE (F1): the registry entry stays; the live catalog filters.
      // The store owns the durable MARK (retired:true + manager-ledger prune +
      // persist) — it never erases a post from the catalog.
      registry.markPostRetired(postId)
      // W7-A (in-session settlement): right after the durable mark commits,
      // settle the retiring worker's pending 'prepared'/'failed' delivery rows
      // to ONE 'terminal' row per messageId — in-session, so the stale rows are
      // terminal BEFORE any boot (the historical debt; the boot pass remains
      // the crash fallback). Non-fatal (a failure warns only — retirePost's
      // semantics are unchanged) and scoped to DISPOSABLE WORKERS: a configured
      // head retire unregisters and is re-materialized LIVE at boot — never
      // settled, exactly like the boot driver (it settles only DEAD recipients).
      await settleRetiredPostDeliveries(postId)
      // QD (spec 007 §6.1, D-Q2 — LOTE B, owner 2026-08-27): the worker-retire
      // dice lives HERE, on retirePost — the ONE shared retire seam that covers
      // every REAL retire path (dept_worker_retire, the host dept_post_retire,
      // the AUTO-RETIRE on delivery, and the boot-reconcile half-slept reap), so
      // a worker retired by ANY of them rolls the 25% sample. The idempotent
      // no-op (entry.retired === true) returned BEFORE this point ⇒ a re-retire
      // of an already-retired worker NEVER re-emits (R1). Non-fatal by design:
      // a directive failure only warns — the retire mark above already committed.
      // `archived` is the archive result of THIS retire (idempotent —
      // dept_worker_retire's own archive call stays as a harmless double; a
      // missing registry resolves false). The retire path NEVER breaks here.
      // Dx1 F1 (owner bug — the sidebar painted retired workers as 'idle'): the
      // DURABLE-SESSION ARCHIVE is UNCONDITIONAL on EVERY retire — the QD dice
      // below ONLY samples the inspect DIRECTIVE, never the archive. Before
      // this, the archive traveled INSIDE the 25% dice, so 75% of the
      // auto-retire seams (delivery auto-retire / half-slept reap) left the
      // workspace-registry hide-set unpopulated and the row stayed visible
      // forever. archiveWorkerSession is idempotent (a re-archive is a no-op
      // hide-set add — dept_worker_retire's own archive call stays a harmless
      // double) + non-fatal (a missing registry resolves false + a warn). The
      // retire path NEVER breaks here.
      const archived = await archiveWorkerSession(entry.sessionId)
      // QD DICE INSTRUMENTATION (QH [HIGH] 2026-08-28 — qi-silence
      // characterization): ONE INFO line per RETIRE with postId/roll/prob/emitted —
      // the ONLY runtime way to separate a dice RUN (the 15-retire/0-directive
      // event, P=1.34%, was a by-design true positive) from a TRANSIENT
      // degradation of the dice→emit path. PURE INFORMATION: the roll is drawn
      // ONCE and fed to the gate as its rng (the gate's single draw — bit-identical
      // dice semantics) and `retireProb` mirrors the gate's effective probability
      // resolution (env DEEPARTMENTS_QUALITY_INSPECT → config → code default
      // 0.25). The dice outcome and the emit are UNCHANGED. INFO, not warn (normal
      // cadence); no `isFirstRetire` guard exists on this seam.
      const retireRoll = Math.random()
      const qualityInspectEnvOverride = process.env[QUALITY_INSPECT_ENV_VAR]
      const qualityInspectEnvProb = qualityInspectEnvOverride === undefined || qualityInspectEnvOverride === '' ? undefined : Number(qualityInspectEnvOverride)
      const retireProb = qualityInspectEnvProb !== undefined && Number.isFinite(qualityInspectEnvProb) && qualityInspectEnvProb >= 0 && qualityInspectEnvProb <= 1
        ? qualityInspectEnvProb
        : qualityWorkerInspectProbability
      // F6 (D-Q2 recursion anchor, m-2170): the QD does NOT sample its OWN
      // workers — a retire of a quality-head worker (inspector OR quality job
      // worker, managerId === 'quality-head') would roll the 25% dice → another
      // QD inspector → its retire rolls again (12-13-case chain in 2 days,
      // ~10-13 workers/turns/reports self-consumed, parallel forks at 2
      // inspectors/wave). Stateless exclusion = the quality-head anti-loop
      // precedent of the 'head' branch (dshd-quality): the recursive QD audit
      // remains available via EXPLICIT QH dispatch (cap-in-practice cases
      // 12/13). The roll is STILL drawn and the INFO dice line below still logs
      // emitted=false for the excluded retire (qi-silence forensics intact) —
      // only the directive is suppressed. Documented future option (YAGNI, NOT
      // part of this lane): a `quality.excludeQdWorkers` knob to re-enable.
      const retireEmitted = entry.managerId !== 'quality-head' && qualityInspectDecision('worker', { rng: () => retireRoll, workerInspectProbability: qualityWorkerInspectProbability })
      ctx.logger.info(`[deepartments] retirePost worker-retire QD dice: postId="${postId}" roll=${retireRoll} prob=${retireProb} emitted=${retireEmitted}`)
      try {
        if (retireEmitted) {
          // O2 (MICRO-BATCH O2, QD compromiso — ANALYZE m-598): label the
          // directive with the retire-time DELIVERABLE prediction ('none' =
          // turn-error + 0 outbound — the ANALYZE pipeline must QUESTION the
          // retire; 'report' = the normal flow, the default). Never throws.
          const deliverable = await predictRetiredWorkerDeliverable(postId)
          await maybeEmitQualityInspectDirective({ kind: 'worker-retired', workerPostId: postId, sessionId: entry.sessionId, archived, deliverable })
        }
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] retirePost worker-retired QD directive for "${postId}" failed (non-fatal — the retire already committed): ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      // Configured head / non-worker: today's semantics (unregister; the config
      // re-materializes it at boot — cosmetic retire). The store owns the
      // unregister + persist.
      registry.unregisterPost(postId)
    }
    // Also dispose any live handle (retiring a post should not leave it live) —
    // via the in-flight dedupe, so a concurrent dispose (e.g. the post's own
    // dept_sleep) is JOINED instead of raced into a double dispose.
    // O1 (LANE ② — the auto-retire-on-delivery race; 3 samples today 34→16→3ms):
    // the delivery seam retires a WORKER right after its report delivered to
    // its head — the retire disposes the CALLER's own handle while its
    // send_message tool call is STILL completing; an immediate dispose aborts
    // the in-flight tool result, and an auditor reads the AbortError as a LOST
    // delivery (it is NOT — the delivery already committed before the retire).
    // THE CHOSEN FIX (simplest + robust): the OPTIONAL DISPOSE GRACE — when
    // `opts.deferDisposeMs` is set (the delivery auto-retire seam passes it),
    // the handle dispose is deferred by a timer (unref'd, so it never holds
    // the process) for the in-flight tool call to complete FIRST; the retire
    // MARK / archive / QD / settle are ALL synchronous (unchanged), and the
    // retired worker's handle is catalog-invisible during the grace (a retired
    // post is never re-materialized — no wake race). Every OTHER retire path
    // (the head's dept_worker_retire / dept_post_retire — callers NOT
    // mid-send) keeps the immediate dispose (zero behavior change). The
    // archived-session alternative (a «last tool aborted but delivery
    // verified» marker) was NOT needed — the grace removes the abort window
    // itself (documented in the lane report).
    const disposeHandle = (): void => { void disposeHeadHandleOnce(entry.sessionId) }
    const deferDisposeMs = typeof opts?.deferDisposeMs === 'number' && Number.isFinite(opts.deferDisposeMs) && opts.deferDisposeMs > 0
      ? opts.deferDisposeMs
      : 0
    if (deferDisposeMs > 0) {
      const timer = setTimeout(disposeHandle, deferDisposeMs)
      if (typeof (timer as { unref?: () => unknown }).unref === 'function') (timer as { unref: () => unknown }).unref()
    } else {
      disposeHandle()
    }
    return { postId, retired: true }
  }

  /** F3 — archive a retired WORKER's durable session via the workspaceRegistry
   * seam (WorkspaceRegistryLike.archiveSession, the host-rotation precedent,
   * session-rotation.ts:283-291) so the SIDEBAR ROW disappears (spec §5.3/D5).
   * Non-fatal by design, exactly like the rotation archive: a missing registry
   * (headless/minimal profile) or a failing call resolves `false` + a warn —
   * the retire MARK (posts.json retired:true) is the durable part and always
   * commits. Called by dept_worker_retire (ONLY the new department-scoped
   * tool; the legacy dept_post_retire keeps today's no-archive behavior). */
  const archiveWorkerSession = async (sessionId: string): Promise<boolean> => {
    const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
    if (registry?.archiveSession === void 0) {
      ctx.logger.warn(`[deepartments] dept_worker_retire: archiveSession(${sessionId}) skipped — workspaceRegistry unavailable (the worker's sidebar row may remain until the registry service is present)`)
      return false
    }
    try {
      await registry.archiveSession(sessionId)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] dept_worker_retire: archiveSession(${sessionId}) failed (non-fatal — the retire mark still commits): ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** F8 (spec 002 head rotation) — non-fatal server-side archive of a SLEPT
   * HEAD's durable session via the workspaceRegistry seam (the S2.5 semantics:
   * a pure registry-set add + durable persist that HIDES the row; NOTHING
   * terminates the agent, the artifact and the journal/messages stay intact).
   * Mirrors archiveWorkerSession but for the dept_sleep HEAD path; never throws
   * (a missing registry or failing call resolves `false` + a warn) and the
   * sleep mark (posts.json sleepEpoch) is the durable part — the archive is
   * cosmetic row-hiding and must never block the sleep. */
  const archivePostSessionOnSleep = async (sessionId: string): Promise<boolean> => {
    const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
    if (registry?.archiveSession === void 0) {
      ctx.logger.warn(`[deepartments] dept_sleep: archiveSession(${sessionId}) skipped — workspaceRegistry unavailable (the head's sidebar row may remain until the registry service is present)`)
      return false
    }
    try {
      await registry.archiveSession(sessionId)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] dept_sleep: archiveSession(${sessionId}) failed (non-fatal — the sleep mark still commits): ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** F5 (spec 004 §6.2 L1) — the CONFIGURED WORKSPACE DIRECTORY of a
   * department, or `''` when the department has NONE (pre-F1 compat: the
   * department keeps the shared workspace root). `workspacePath` is optional in
   * config (F1 defaults it to `''`), so absent/blank/undefined all collapse to
   * `''` — the callers then fall through to `resolveWorkspaceRootPath`. */
  const departmentWorkspacePath = (department: DepartmentConfig | undefined): string => {
    const p = department?.workspacePath
    return typeof p === 'string' && p.trim() !== '' ? p.trim() : ''
  }

  /** F5 (spec 004 §6.2 L1) — ENSURE a department's REAL sidebar workspace
   * entity exists and return its canonical path (the cwd its head/worker
   * sessions attach to). The workspace SERVICE requires an existing directory
   * (it realpath-validates + stats), so mkdir -p first, then the registry
   * ensure. NEVER throws: every failure path WARNs and the configured path is
   * returned unchanged (the session is STILL created with that cwd — it just
   * won't be sidebar-attachable until the directory/entity exist, the honest
   * non-fatal WARN discipline of the attach hooks).
   * RACE (incident 2026-08-23): `registry.create(path, title)` is idempotent
   * ONLY AFTER the provider's durable state is loaded into memory — its
   * dedupe (dsh-workspace `createCanonical`) iterates the IN-MEMORY `entities`
   * map, which is EMPTY while the provider init is still in flight. The
   * deepartments boot hooks (hostsLoaded.then, ensureAllHeads) race that init
   * (the FIX 1b.1 window), so a naive create persisted a FRESH duplicate
   * record with a NEW id for the same canonical path on EVERY boot (observed
   * duplicates 7a9dbcbe / 8be7833e) → the NEXT boot's harness
   * `validateStoredState` rejected "workspace domain is inconsistent: path ...
   * is claimed by both workspace ... and ..." → the plugin tree load failed →
   * systemd crash loop → GUI down (production Tailscale 8445). FIX = the SAME
   * bounded-retry discipline as FIX 1b.1: retry until `registry.list()`
   * RESOLVES (list() throws while the state is missing, so resolution proves
   * the durable state is in memory), then resolveByPath-FIRST — the
   * NON-MUTATING canonical lookup that returns the entity an earlier boot or
   * the GUI already created — and `registry.create` ONLY as the fallback for
   * a genuinely unowned path. */
  const ensureDepartmentWorkspace = async (workspacePath: string, title: string): Promise<string> => {
    try {
      await mkdir(workspacePath, { recursive: true })
    } catch (error) {
      ctx.logger.warn(`[deepartments] department workspace dir "${workspacePath}" could not be created (${error instanceof Error ? error.message : String(error)}) — the department's sessions keep cwd "${workspacePath}" but are NOT sidebar-attachable until the directory exists`)
      return workspacePath
    }
    const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
    if (registry === void 0 || typeof registry.list !== 'function' || typeof registry.create !== 'function') {
      // NO usable registry service in this composition (headless/minimal
      // profile, or a harness without the workspace seams): a DEFINITIVE
      // absence — nothing can become available, so return immediately and
      // never block boot (the same fallback resolveWorkspaceRootPath uses).
      ctx.logger.warn(`[deepartments] department workspace create skipped (no workspaceRegistry.create seam in this composition) — the department's sessions keep cwd "${workspacePath}" but are not grouped in the sidebar`)
      return workspacePath
    }
    const deadline = Date.now() + HOST_ATTACH_REPAIR_TIMEOUT_MS
    let lastFailure: unknown = undefined
    for (;;) {
      try {
        await registry.list()
        // list() RESOLVED → the provider's durable state is now in memory:
        // create is idempotent again — but prefer the NON-MUTATING
        // resolveByPath first (an entity that already owns the canonical path
        // from an earlier boot or the GUI must NEVER be duplicated).
        break
      } catch (error) {
        // list() rejected → the registry is still initializing ("workspace
        // registry is not started yet") — sleep and retry.
        lastFailure = error
      }
      if (Date.now() >= deadline) {
        const detail = lastFailure instanceof Error ? lastFailure.message : String(lastFailure ?? 'workspace registry never became ready')
        ctx.logger.warn(`[deepartments] department workspace ensure timed out waiting for the workspace registry to become ready: ${detail} — the department's sessions keep cwd "${workspacePath}" but may not be grouped in the sidebar (retried ${HOST_ATTACH_REPAIR_TIMEOUT_MS}ms)`)
        return workspacePath
      }
      await new Promise((resolve) => setTimeout(resolve, HOST_ATTACH_REPAIR_RETRY_MS))
    }
    try {
      if (typeof registry.resolveByPath === 'function') {
        const existing = await registry.resolveByPath(workspacePath)
        if (existing !== undefined && typeof existing.path === 'string' && existing.path !== '') return existing.path
      }
      const entity = await registry.create(workspacePath, title)
      // Prefer the canonical path the SERVICE resolved (create realpath-
      // normalizes); the session cwd must equal it for the attach to match.
      if (entity !== undefined && typeof entity.path === 'string' && entity.path !== '') return entity.path
      return workspacePath
    } catch (error) {
      ctx.logger.warn(`[deepartments] department workspace create failed for "${workspacePath}" (${error instanceof Error ? error.message : String(error)}) — the department's sessions keep cwd "${workspacePath}" but the sidebar folder may not appear`)
      return workspacePath
    }
  }

  /** F5 (spec 004 §6.2 L1) — the department-aware CWD for a created head/worker
   * session: a department WITH a configured workspacePath ensures its workspace
   * (mkdir + registry ensure: resolveByPath-first, create only as the fallback
   * for an unowned path — title = dept name, set only on first create) and
   * returns the canonical workspace path (the department's own sidebar folder).
   * A department WITHOUT workspacePath returns `''` — the caller then falls back
   * to `resolveWorkspaceRootPath()` (the shared root, pre-F1 behavior, zero
   * regression). */
  const resolveDepartmentWorkspaceCwd = async (department: DepartmentConfig | undefined): Promise<string> => {
    const workspacePath = departmentWorkspacePath(department)
    if (workspacePath === '') return ''
    return ensureDepartmentWorkspace(workspacePath, department!.name || department!.id)
  }

  /** Piece 1 (2026-08-22) — the CANONICAL WORKSPACE ROOT PATH for created
   * head/worker sessions, replacing the legacy `repoRoot` hardcode. dsh-workspace
   * attaches a session to a workspace ONLY when its persisted header cwd equals
   * the entity's canonical path (dsh-workspace lib:98 — strict realpath
   * equality), and the native sidebar groups rows by workspace membership — so
   * a session created with `meta.cwd = repoRoot` matches NO workspace when the
   * GUI-created workspace root is elsewhere (production: workspace path
   * "/root", head cwd the repo) → the attach always throws → the session stays
   * INVISIBLE and every wake re-attach repeats the same failure
   * (explore-deep/2026-08-22-head-attach-cwd.md, fix (a)). Resolution order:
   *   1. the workspace entity whose `sessionIds` already contains the session
   *      id of a LIVE hosts.json host entry — the host session was created BY
   *      the GUI in a workspace, so its owning entity IS the canonical root
   *      (the entity path is exactly what the GUI uses as the host session's
   *      own cwd: `workspace.path`);
   *   2. `list()[0].path` — the registry's durable-first workspace, the same
   *      ordering attachHeadSession/repairHostWorkspaceAttach iterate;
   *   3. `repoRoot` — no registry or empty list (headless profiles): the
   *      legacy value, still a valid cwd.
   * Bounded wait with the SAME window as the boot-repair FIX 1b.1
   * (NON-STRICT `ctx.get('workspaceRegistry', false)` + retry 250ms ≤ 10s)
   * because at boot the provider may still be initializing and the strict get
   * races its state-2 init — but a composition with NO registry service at all
   * is a DEFINITIVE absence and falls back immediately. NEVER throws: a path
   * is ALWAYS returned (the repoRoot floor), so a head/worker create cannot
   * fail on workspace resolution.
   */
  const resolveWorkspaceRootPath = async (): Promise<string> => {
    const deadline = Date.now() + HOST_ATTACH_REPAIR_TIMEOUT_MS
    for (;;) {
      const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
      if (registry?.list === void 0) {
        // NO registry service in this composition (headless/minimal profile):
        // a DEFINITIVE absence — nothing can become available, so fall back to
        // the repoRoot floor immediately (never a head/worker create block).
        return repoRoot
      }
      try {
        const workspaceList = await registry.list()
        // 1. the entity whose membership already covers a live host session.
        const liveHostSessionIds = new Set<string>()
        for (const entry of hosts.values()) {
          if (entry.retired !== true) liveHostSessionIds.add(entry.sessionId)
        }
        for (const workspace of workspaceList) {
          const entity = workspace as WorkspaceEntityMembershipLike
          if (typeof entity.path !== 'string' || entity.path === '') continue
          if (entity.sessionIds !== void 0) {
            for (const sessionId of liveHostSessionIds) {
              if (entity.sessionIds.includes(sessionId)) return entity.path
            }
          }
        }
        // 2. the registry's durable-first workspace path — SKIPPING a
        // department's own workspace (F5, spec 004 §6.2 L1): the workspace
        // SERVICE prepends a newly created workspace to the registry order, so
        // a department workspace would otherwise become list()[0] and hijack
        // the shared-root resolution for a department WITHOUT workspacePath
        // (or a legacy head) in a host-less/headless profile. A department
        // workspace is never the shared root; fall through to the next one
        // (or the repoRoot floor when every workspace is a department's own).
        const departmentWorkspacePaths = new Set<string>()
        for (const department of org.departments) {
          const deptWs = departmentWorkspacePath(department)
          if (deptWs !== '') departmentWorkspacePaths.add(deptWs)
        }
        for (const workspace of workspaceList) {
          const path = (workspace as WorkspaceEntityMembershipLike).path
          if (typeof path === 'string' && path !== '' && !departmentWorkspacePaths.has(path)) return path
        }
        // 3. no workspace entities at all (or only department workspaces) —
        //    legacy repoRoot floor.
        return repoRoot
      } catch {
        // list() rejected → the registry is still initializing — retry.
      }
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, HOST_ATTACH_REPAIR_RETRY_MS))
    }
    // The bounded window elapsed without a resolved list: give up on the
    // registry and fall back to the repoRoot floor (a head/worker create must
    // never block on the optional workspace seam — the non-fatal discipline of
    // the attach hooks).
    return repoRoot
  }

  /** Piece 1 — durably attach a head/worker session to the workspace whose
   * path matches its persisted header cwd, so the session appears as a row in
   * the NATIVE sidebar (rows are grouped by workspace from workspace.json
   * sessionIds — a registered-but-unattached session is INVISIBLE there).
   * Reuses the canonical attach seam verbatim: `workspaceRegistry.list()` →
   * iterate the workspace entities → `attachSession` (dsh-workspace validates
   * cwd vs path and throws on mismatch, so mismatches fall through to the
   * next entity) — the same iterate-and-try pattern as the host boot-repair
   * hook above and the S2.2 rotation. Resolution follows the canonical
   * semantics: a missing/listing-failing registry, an EMPTY workspace list,
   * or an attach that no entity resolves is a DEFINITIVE (fatal-for-visibility)
   * failure → the legacy fallback of the boot-repair: log a WARN and give up
   * (the session stays invisible — a PERMANENT header-cwd mismatch is not
   * recovered by the wake re-attach; boot-fresh sessions now carry the
   * resolved workspace-root cwd, so they resolve by equality) —
   * a failed attach must NEVER break head materialization or a wake. Retries
   * are bounded with the SAME window as the boot-repair, because at boot
   * (ensureAllHeads) the workspaceRegistry provider may still be initializing
   * (FIX 1b.1: strict get races the provider's state-2 init). Idempotent:
   * re-attaching an already-attached session is a no-op for the real registry.
   */
  const attachHeadSession = async (sessionId: string, source: string): Promise<void> => {
    const deadline = Date.now() + HOST_ATTACH_REPAIR_TIMEOUT_MS
    let lastFailure: unknown = undefined
    for (;;) {
      const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
      if (registry?.list !== void 0) {
        try {
          const workspaceList = await registry.list()
          for (const workspace of workspaceList) {
            if (typeof workspace?.attachSession !== 'function') continue
            try {
              await workspace.attachSession(sessionId)
              ctx.logger.info(`[deepartments] head attach (${source}): attached ${sessionId}`)
              return
            } catch {
              // cwd mismatch / unvalidatable header / attach fault — try the next entity.
            }
          }
          // list() RESOLVED but no entity matched: a definitive (non-readiness)
          // failure — warn once and give up. A header cwd with no owning
          // workspace is PERMANENT (the wake re-attach only recovers the
          // boot-race, never a cwd mismatch).
          ctx.logger.warn(`[deepartments] head attach (${source}): no workspace matched session ${sessionId} — its header cwd has no owning workspace; the session stays invisible in the sidebar (a cwd mismatch is permanent — only a fresh create under the resolved workspace root fixes it)`)
          return
        } catch (error) {
          // list() rejected → the registry is still initializing — retry.
          lastFailure = error
        }
      }
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, HOST_ATTACH_REPAIR_RETRY_MS))
    }
    const detail = lastFailure instanceof Error ? lastFailure.message : String(lastFailure ?? 'registry impl never became available')
    ctx.logger.warn(`[deepartments] head attach (${source}) failed: ${detail} — the session stays invisible in the sidebar (retried ${HOST_ATTACH_REPAIR_TIMEOUT_MS}ms)`)
  }

  /** THE VISIBILITY FIX SEAM (2026-08-25 P2) — archive-leak rotation id
   * (HEAD-only). A head's durable session id in the workspace registry's
   * `archivedSessionIds` must NEVER be RESUMED: the GUI sidebar hides any
   * session whose id is archived (`dsh-client-ui-workspace` sessionVisible —
   * `!archived.has(id)`, client.js:100-101), so re-seeding a live head on an
   * archived id makes it live-but-invisible (the reported P2). Returns a FRESH
   * `head-<postId>-<uuid>` id when the durable id is archived (the F8 fresh-mint
   * shape materializePost uses for a slept head), or `undefined` when it is NOT
   * archived — the caller then proceeds with its NORMAL resume (zero regression).
   * A WORKER's resume is untouched (the caller invokes this only for a head,
   * provider !== 'worker'); the archive-leak is head-specific. */
  const rotateArchivedHeadSessionId = async (postId: string, sessionId: string): Promise<string | undefined> => {
    const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
    if (!isArchivedSession(registry, sessionId)) return undefined
    const fresh = String(SessionId(`${HEAD_SESSION_PREFIX}${postId}-${randomUUID()}`))
    ctx.logger.warn(`[deepartments] head "${postId}" durable session ${sessionId} is ARCHIVED — rotating to fresh ${fresh} instead of resuming the archived id (a live head's session is never archived)`)
    return fresh
  }

  /** Ensure ONE configured head is materialized as a live root agent.
   * Idempotent: live → reuse (record the handle if create/resume just ran);
   * durable session in the registry → resume; else → create. Mirrors the
   * restartable create/resume fallback, tolerating a resume that fails because
   * no durable session exists yet (then create). Always (re)records the
   * registry entry keyed by the stable session id. Piece 1: every branch also
   * fire-and-forgets the workspace attach + the session title pin (sidebar). */
  const ensureHead = async (department: DepartmentConfig, roomId: string): Promise<void> => {
    const coordinator = department.coordinator
    if (coordinator === void 0) return
    const postId = coordinator.postId
    // F8 (spec 002 head rotation) — a SLEPT head is DORMANT: its durable session
    // was ARCHIVED at dept_sleep, so materializing it at boot (resume the same
    // id) would revive the old artifact instead of the fresh rotation. Leave it
    // dormant until its next bus wake (materializePost mints a fresh session).
    // The journal + messages stay intact; the head simply is not live until
    // addressed. A never-slept head (no sleepEpoch) is unaffected.
    const durableEntry = byPost.get(postId)
    if (durableEntry?.sleepEpoch !== void 0) return
    // Batch 4a: the head uses its PER-HEAD preset (deepartments-head-<departmentId>)
    // so the session is NATIVE/openable and labeled with its head preset.
    const presetId = headPresetIdFor(department.id)
    // F8 rotation: track the ENTRY's session id (a head that was rotated to a
    // fresh session at its last wake carries that id here) — fall back to the
    // deterministic `head-<postId>` derivation ONLY when there is no durable
    // entry yet (first boot / fresh department).
    // `let` (not `const`): the archive-leak rotation below REPLACES a durable
    // head session id that the workspace registry has archived, and the attach/
    // title-pin tail must target the ROTATED (fresh) session id.
    let sessionId = SessionId(durableEntry?.sessionId ?? headSessionId(postId))
    if (agents === void 0) return
    // F5 (spec 004 §6.2 L1): a department WITH a configured workspacePath owns a
    // REAL sidebar folder — ensure the workspace (mkdir + registry ensure — the
    // race-fixed resolveByPath-first/create-fallback discipline, title=dept
    // name, set only on first create) and carry the canonical path as the cwd
    // for the fresh-create branches. A department WITHOUT workspacePath returns
    // '' (the shared workspace root via resolveWorkspaceRootPath — pre-F1). The
    // ensure runs on EVERY ensureHead (even when the head session is reused/
    // resumed) so the department folder exists for its workers' spawns.
    const departmentCwd = await resolveDepartmentWorkspaceCwd(department)
    let handle: AgentHandleLike | undefined
    const live = agents.get(String(sessionId))
    if (live !== void 0) {
      // Already live: reuse; record the registry entry (a head may be present
      // live without a registry entry if the harness pre-created it).
      const existing = byPost.get(postId)
      if (existing === void 0) {
        registerEntry(makeEntry(department, roomId, String(sessionId)))
      }
    } else {
      const coordinatorRole = coordinator.role || postId
      const setup = headSetup(postId, roomId, coordinatorRole, presetId, department)
      const agentOptions = coordinator.agentOptions
      const durableSession = durableEntry !== void 0
      if (durableSession) {
        // THE VISIBILITY FIX (2026-08-25 P2): a durable head session id in the
        // workspace registry's archived set must NEVER be RESUMED — a live head's
        // session is never archived, because the GUI sidebar hides any archived
        // session id. The re-seed resume of an archived id is the root cause of
        // the live-but-invisible head. Treat it like a slept head: rotate to a
        // FRESH id (the F8 fresh-mint shape) and CREATE, never resume. A
        // NON-archived head resume is byte-identical (zero regression); a
        // WORKER's resume never reaches here (worker resume is its own lifecycle).
        const rotatedSessionId = await rotateArchivedHeadSessionId(postId, String(sessionId))
        if (rotatedSessionId !== void 0) {
          sessionId = SessionId(rotatedSessionId)
          handle = await agents.create({
            sessionId: rotatedSessionId,
            meta: { cwd: departmentCwd !== '' ? departmentCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: presetId },
            agentOptions,
            setup
          })
          registerEntry(makeEntry(department, roomId, rotatedSessionId))
        } else {
          try {
            handle = await agents.resume({ resumeSessionId: String(sessionId), agentOptions, setup })
            registerEntry(makeEntry(department, roomId, String(sessionId)))
          } catch (error: unknown) {
            // Resume failed (e.g. no durable session in the persistence store after
            // a stateDir wipe): fall back to creating a fresh session.
            ctx.logger.warn(`[deepartments] head "${postId}" resume failed, creating fresh: ${error instanceof Error ? error.message : String(error)}`)
            handle = await agents.create({
              sessionId: String(sessionId),
              meta: { cwd: departmentCwd !== '' ? departmentCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: presetId },
              agentOptions,
              setup
            })
            registerEntry(makeEntry(department, roomId, String(sessionId)))
          }
        }
      } else {
        handle = await agents.create({
          sessionId: String(sessionId),
          meta: { cwd: departmentCwd !== '' ? departmentCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: presetId },
          agentOptions,
          setup
        })
        registerEntry(makeEntry(department, roomId, String(sessionId)))
      }
      if (handle !== void 0) byHeadHandle.set(String(sessionId), handle)
    }
    // Piece 1 — native sidebar: every branch (fresh create, resume, live-reuse)
    // fire-and-forgets the workspace attach (idempotent, never fatal) and pins
    // the head sidebar title on its LIVE session via the U4-generalized helper
    // (store-first, exactly like the host path — a root agent's session IS
    // entered in ctx.sessions while it lives). The owner's manual rename
    // (source.user) always wins; a session already holding the pin is never
    // double-pinned; a failed pin/attach only logs (head registration stands).
    void attachHeadSession(String(sessionId), 'ensureHead')
    const titleSession = ctx.sessions.get(sessionId)
    if (titleSession !== void 0) {
      const title = coordinator.sessionTitle || HEAD_DEFAULT_SESSION_TITLE
      const titlePin = pinSessionTitle(titleSession, title)
      if (titlePin === 'pinned') {
        ctx.logger.info(`[deepartments] ensureHead: pinned head session title "${title}" (${sessionId})`)
      } else if (titlePin === 'failed') {
        ctx.logger.warn(`[deepartments] ensureHead: head session title pin failed for ${sessionId} (non-fatal — head registration continues)`)
      }
    }
  }

  /** Build a PostEntry for a configured head (root-agent shape, Batch 1b). The
   * durable `agentPreset` is the PER-HEAD preset (Batch 4a) so a restart resumes
   * the head under the same per-head composition it was created with. */
  const makeEntry = (department: DepartmentConfig, roomId: string, sessionId: string): PostEntry => ({
    postId: department.coordinator!.postId,
    sessionId,
    roomId,
    agentPreset: headPresetIdFor(department.id)
  })

  /** Ensure EVERY configured department head is a live root agent (boot, after
   * the registries load; also safe to re-run — idempotent per head). */
  const ensureAllHeads = async (): Promise<void> => {
    if (agents === void 0) return
    // The generic head preset (template + fallback), the disposable-worker
    // preset, AND every PER-HEAD preset are materialized into the harness-home
    // user root. We re-read the agentPresets service HERE (not the apply-time
    // capture) because materialization runs asynchronously after the registries
    // load — by then the roster is composed, so this is deterministic regardless
    // of Loader ordering of the (optional) agentPresets service. Hermetic
    // compositions that never resolve presets write nothing outside the stateDir.
    const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
    if (presets !== void 0) {
      await materializePreset(PRESET_ID)
      await materializePreset(WORKER_PRESET_ID)
      for (const department of org.departments) {
        await materializeHeadPreset(department)
      }
    }
    // CRITICAL (Batch 3a guarantee): ensureAllHeads ONLY ever iterates the
    // CONFIGURED departments' coordinators (`org.departments`). Workers
    // are created at RUNTIME by dept_post_create and are NEVER present in this
    // config — so a retired worker (whose registry entry was removed) is never
    // re-materialized by a later boot. The "retired worker stays retired"
    // invariant holds structurally.
    for (const department of org.departments) {
      const coordinator = department.coordinator
      if (coordinator === void 0) continue
      // B3: the department config no longer carries a roomId (spec 003 §7 —
      // the room concept is gone); the registry `roomId` field is INERT for
      // schema stability, so keep the legacy 'board' value (the same inert
      // value ensureHost writes for hosts).
      await ensureHead(department, 'board')
    }
  }

  /** Fix A2 — the observable progress signature of a live head: the length of
   * its durable session event log. Every appended step/turn/assistant event is
   * lifecycle progress. Absent/session-less agents yield 0 (no progress signal
   * → never judged stuck on the basis of this). rc.1+ surface: the log length
   * is `session.seq` (the `seq = log.length` contract — the old
   * `events?.length` read). */
  const headEventCount = (live: AgentLike): number =>
    live.session === undefined ? 0 : live.session.seq

  /** Fix A2 — record that we just observed `live` making progress: stamp `at`
   * and snapshot the current event watermark. Call whenever a wake successfully
   * reaches a functioning head (live followup, cold resume) so the next stuck
   * check starts from a fresh baseline and a healthy busy head is never misjudged. */
  const markHeadProgress = (sessionId: string, live: AgentLike): void => {
    headProgress.set(sessionId, { at: stuckNow(), eventCount: headEventCount(live) })
  }

  /** Fix A2 — is `live` a wedged resident head? True ONLY when it is status
   * 'running' (a phase is actually underway) AND its session event log has not
   * grown since the last observation AND that stall exceeds STUCK_HEAD_MS. An
   * idle head is always followup-able (a wake starts a fresh turn), and a head
   * whose event log is growing is progressing normally — neither is stuck. */
  const isHeadStuck = (sessionId: string, live: AgentLike): boolean => {
    if (live.status !== 'running') return false
    const prior = headProgress.get(sessionId)
    if (prior === void 0) {
      // First observation of a running head: record the baseline, do not judge
      // it stuck yet (a healthy turn needs time to produce its first event).
      markHeadProgress(sessionId, live)
      return false
    }
    if (headEventCount(live) > prior.eventCount) {
      markHeadProgress(sessionId, live)
      return false
    }
    return stuckNow() - prior.at > STUCK_HEAD_MS
  }

  /** W8-c PART 3 — boot PRESET AUDIT. After the configured heads are materialized
   * (and on every boot), scan the preset/persona text the plugin reads (COMMENTS
   * INCLUDED) for any UNBOUND double-brace template reference (a reference to a
   * variable that is NOT one of the KNOWN-BOUND persona vars cwd/headPostId/
   * workspacePath/reportDir/deptName). On an unbound reference, record a
   * CONFIG-HEALTH post-error-marker (`config-presets.jsonl`) that the health
   * daemon turns into a 'config-preset' ALERT to the host (deduped per
   * 'config-preset' per 30min). NEVER mutates a preset file — the audit is
   * read-only and writes only its own stateDir marker. Gated by
   * `health.presetAuditEnabled` (default on). Non-fatal (a read failure skips
   * that source). */
  const runPresetAudit = async (): Promise<void> => {
    if (config.health?.presetAuditEnabled === false) return
    const sources: { name: string; text: string }[] = []
    // The head + disposable-worker base presets (the preset text the plugin
    // materializes into the harness home's .agent-presets/).
    for (const presetId of [PRESET_ID, WORKER_PRESET_ID]) {
      try {
        sources.push({ name: `${presetId}/agent.cordis.yml`, text: await readFile(path.join(repoRoot, 'presets', presetId, 'agent.cordis.yml'), 'utf8') })
      } catch {
        /* source absent → skip (never a boot failure) */
      }
    }
    // Each department's ARCHITECTURE.md (the raw text, comments included, BEFORE
    // templating — so an unbound reference in any comment/style is caught).
    for (const department of org.departments) {
      const archPath = path.join(repoRoot, 'presets', 'departments', department.id, 'ARCHITECTURE.md')
      try {
        sources.push({ name: `departments/${department.id}/ARCHITECTURE.md`, text: await readFile(archPath, 'utf8') })
      } catch {
        /* no architecture file → skip */
      }
    }
    // The host preset ('deepartments') is OWNED by the GUI profile, not this repo;
    // scan its harness-home .agent-presets copy when present (it is not — this
    // repo defines no host preset — so the source is skipped cleanly).
    try {
      const hostPresetDir = path.join(dshHome(), '.agent-presets', 'deepartments')
      for (const file of ['agent.cordis.yml', 'preset.yml']) {
        sources.push({ name: `deepartments/${file}`, text: await readFile(path.join(hostPresetDir, file), 'utf8') })
      }
    } catch {
      /* host preset absent → skip */
    }
    const bad: { preset: string; unbound: string[] }[] = []
    for (const source of sources) {
      const unbound = auditPresetText(source.text)
      if (unbound.length > 0) bad.push({ preset: source.name, unbound })
    }
    if (bad.length === 0) return
    for (const finding of bad) {
      await appendConfigPresetMarker(stateDir, { ts: Date.now(), preset: finding.preset, unbound: finding.unbound })
    }
    try {
      ctx.logger.warn(`[deepartments] preset-audit: unbound template reference(s) in preset text: ${bad.map((b) => `${b.preset} (${b.unbound.join(', ')})`).join('; ')}`)
    } catch {
      /* a post-dispose logger warn must not surface as an unhandled rejection */
    }
  }

  /** W8-h boot INTERRUPTED-POST RECONCILIATION (owner-required 2026-08-24: the
   * DSH restart notice only lists the MAIN session; department posts interrupted
   * mid-turn are NOT reported to the Asistente — they must surface automatically,
   * never silently). After the post registry loads, reconcile EACH registered
   * post against its session's INTERRUPTED (open/stopped) turn and record it
   * into post-errors.jsonl (error class 'interrupted-post') so the W6 health
   * daemon ALERTS the host. Reads the DURABLE session for each post (a resumed
   * head's durable log carries the reload-repair marker; a NOT-resumed worker is
   * judged against its on-disk crash tail). Bounded by the previous boot's last
   * heartbeat ts (the restart timestamp window) when the heartbeat file exists;
   * deduped per post per 30min (health-alerts-state.json, key
   * 'interrupted-post:<postId>'). Gated by `health.enabled` (the whole health
   * daemon OFF → no reconcile; the W6 alert path would never fire). Non-fatal. */
  const runInterruptedPostReconciliation = async (): Promise<void> => {
    if (config.health?.enabled === false) return
    try {
      const persistence = ctx.get('sessionPersistence') as { readRaw?: (id: SessionId, signal?: AbortSignal) => Promise<{ content: string } | undefined> } | undefined
      // The previous boot's last heartbeat ts — the restart-window lower bound.
      // The CURRENT daemon has not ticked yet at reconciliation time, so
      // health-heartbeat.json still holds the PREVIOUS process's last tick.
      const prevHeartbeat = readHealthHeartbeatFile(stateDir)
      const postEvents: InterruptedPostInput[] = []
      for (const [postId, entry] of byPost) {
        if (entry.retired === true) continue
        let events: HealthSessionEvent[] = []
        // W8-h: a LIVE-RUNNING post (a phase is actually underway) is healthy
        // progress, never a stop — do NOT flag it (mirrors the heartbeat's
        // live-running exclusion, so a post that recovered and is actively
        // working after a restart is never a false positive). A genuinely
        // stopped post's agent is NOT 'running', so no real interruption is
        // masked.
        const live = agents?.get(SessionId(entry.sessionId))
        if (live !== undefined && live.status === 'running') continue
        // Prefer the LIVE agent's in-memory log (reflects the repaired/reloaded
        // session after a resume), else the DURABLE persistence readRaw (the true
        // on-disk crash tail for a NOT-resumed post). rc.1+ surface: the live-log
        // non-empty guard is `seq > 0` and the full read is `snapshotEvents()`.
        if ((live?.session?.seq ?? 0) > 0 && live?.session !== undefined) {
          // Dual session-log read: `snapshotEvents()` on the 0.1.2-rc.1 surface,
          // legacy cached `events` getter on the pre-rc.1 core (0.1.1-rc.2).
          events = (live.session.snapshotEvents?.() ?? live.session.events ?? []) as HealthSessionEvent[]
        } else if (persistence !== undefined && typeof persistence.readRaw === 'function') {
          try {
            const raw = await persistence.readRaw(SessionId(entry.sessionId))
            events = (raw?.content ?? '').split('\n').flatMap((line) => {
              if (line.trim() === '') return []
              try {
                const ev = JSON.parse(line) as { type?: unknown; time?: unknown; data?: unknown }
                if (ev !== null && typeof ev === 'object' && typeof ev.type === 'string' && typeof ev.time === 'number') {
                  return [{ type: ev.type, time: ev.time, data: ev.data }]
                }
              } catch { /* skip a malformed line */ }
              return []
            })
          } catch { /* durable read failed → events stays [] (degrades, never fatal) */ }
        }
        postEvents.push({ postId, sessionId: entry.sessionId, retired: false, events })
      }
      const result = await reconcileInterruptedPosts({
        now: () => Date.now(),
        stateDir: stateDir,
        postEvents,
        restartAfterTs: prevHeartbeat?.ts
      })
      if (result.interrupted.length > 0 || result.appended > 0) {
        ctx.logger.info(`[deepartments] interrupted-post reconciliation: ${result.interrupted.length} interrupted post(s), ${result.appended} appended to post-errors.jsonl`)
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] interrupted-post reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** FIX-2 (QD NO_ADAPTER alerting) — a BOOT provider-adapter-registration check
   * that fires a finding INDEPENDENT of any spawned agent (the QH acceptance "a
   * boot check that fires a finding independent of any spawned agent" / the
   * "from the break" trigger). It queries the LLM adapter registry
   * (`ctx.get('llm').listProviders()`), compares the configured provider route(s)
   * (the worker/head route pinned 'opencode-zen' in WORKER_AGENT_OPTIONS /
   * HOST_AGENT_OPTIONS + each coordinator) to the registry, AND (best-effort)
   * reads the pi-ai provider endpoint surface (llm-pi-ai.providers.<provider>
   * .baseURL / .maxRetries) to flag a drift (a local/proxy baseURL or a
   * `maxRetries: 0` profile — the QD config-hygiene signal). On a missing or
   * drifted provider it appends a post-error row so the health daemon ALERTS the
   * host EVEN WITH NO AGENT SPAWNED. Read-only + never-throws; a headless/minimal
   * profile with no `llm` service is skipped with a warn. Gated on
   * `health.enabled` (the WHOLE health daemon OFF → no alert path → skip).
   *
   * RACE-TOLERANT (the fix-2 false positive): the check is fired in the boot
   * `.then` block (microseconds after plugin boot) but `ctx.llm.registerAdapter`
   * (the dsh-llm-pi-ai apply) is ASYNC — so the naive FIRST read of
   * `listProviders()` can run BEFORE the adapter registers and FALSE-POSITIVE on
   * a healthy-but-still-registering boot. Instead of alerting immediately on a
   * missing/drifted provider, it polls within a BOUNDED window
   * (`health.providerAdapterRetryWindowMs` / `health.providerAdapterRetryMs`, default
   * `PROVIDER_ADAPTER_RETRY_WINDOW_MS`, mirroring the `HOST_ATTACH_REPAIR_*`
   * bounded-retry discipline): each poll re-reads `listProviders()` and re-reads
   * the settings surface. A provider that REGISTERS (or a drift that resolves)
   * WITHIN the window is a DELAYED-but-healthy boot → suppressed (NO alert). Only
   * a finding STILL PRESENT AFTER the window elapses is a GENUINE outage → the
   * HARD NO_ADAPTER/endpoint alert is appended. Never throws. */
  const runProviderAdapterBootCheck = async (): Promise<void> => {
    if (config.health?.enabled === false) return
    try {
      const llm = ctx.get('llm', false) as { listProviders?: () => Array<{ id: string; name: string }> } | undefined
      if (llm === undefined || typeof llm.listProviders !== 'function') {
        ctx.logger.warn('[deepartments] provider-adapter boot check skipped — the "llm" service is absent (headless/minimal profile)')
        return
      }
      const configuredProviders = new Set<string>()
      if (WORKER_AGENT_OPTIONS.provider) configuredProviders.add(WORKER_AGENT_OPTIONS.provider)
      if (HOST_AGENT_OPTIONS.provider) configuredProviders.add(HOST_AGENT_OPTIONS.provider)
      for (const department of org.departments ?? []) {
        const c = department.coordinator
        if (c?.agentOptions?.provider) configuredProviders.add(c.agentOptions.provider)
        else if (c?.provider) configuredProviders.add(c.provider)
      }
      const configuredProviderList = [...configuredProviders]
      if (configuredProviderList.length === 0) return

      // Bounded retry window (mirrors the HOST_ATTACH_REPAIR_* discipline): the
      // configured provider(s) may legitimately still be REGISTERING (the async
      // ctx.llm.registerAdapter) at the moment this boot check first runs — the
      // exact race that fired the false positive. Poll until the window elapses;
      // suppress a DELAYED registration, alert on a NEVER-registered provider.
      const retryHealthCfg = (config.health ?? {}) as unknown as {
        providerAdapterRetryWindowMs?: number
        providerAdapterRetryMs?: number
      }
      const retryWindowMs = typeof retryHealthCfg.providerAdapterRetryWindowMs === 'number' && retryHealthCfg.providerAdapterRetryWindowMs > 0
        ? retryHealthCfg.providerAdapterRetryWindowMs
        : PROVIDER_ADAPTER_RETRY_WINDOW_MS
      const retryMs = typeof retryHealthCfg.providerAdapterRetryMs === 'number' && retryHealthCfg.providerAdapterRetryMs > 0
        ? retryHealthCfg.providerAdapterRetryMs
        : PROVIDER_ADAPTER_RETRY_MS
      const deadline = Date.now() + retryWindowMs
      for (;;) {
        // Re-read BOTH the registry and the settings surface on every poll so a
        // transient registration/settings-loading race cannot false-alert.
        const registeredProviders = (llm.listProviders() ?? [])
        const providerSettings = readLlmPiAiProviderSettings(stateDir)
        const findings = resolveProviderAdapterBootFindings({
          configuredProviders: configuredProviderList,
          registeredProviders,
          providerSettings,
          poolerBaseURL: org.poolerBaseURL
        })
        // Provider registered (or the drift resolved) WITHIN the window → this is a
        // healthy-but-slow boot → NO finding, no alert.
        if (findings.length === 0) return
        if (Date.now() >= deadline) {
          // STILL missing/drifted AFTER the window elapses → a GENUINE outage →
          // the HARD NO_ADAPTER/endpoint alert (the ~49-min outage case).
          for (const finding of findings) {
            await appendPostError(stateDir, { ts: Date.now(), postId: finding.postId, error: finding.error })
          }
          ctx.logger.warn(`[deepartments] provider-adapter boot check: ${findings.length} finding(s) → ${findings.map((f) => f.error).join('; ')}`)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs))
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] provider-adapter boot check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** fb-9 boot-assert (LIGHT, non-fatal — drift detection even when nobody
   * dispatches): at boot, pre-flight the ACTIVE worker route
   * (WORKER_AGENT_OPTIONS.provider) against the stateDir settings.yaml. A
   * provider profile with reasoning enabled that lacks
   * compat.requiresReasoningContentOnAssistantMessages=true (the schema-correct
   * nested path — a provider-level flag is dead and is detected as missing)
   * → a warn + ONE drift
   * post-error row (the synthetic REASONING_CONTENT_PREFLIGHT_POST_ID post —
   * the W6 daemon surfaces it as a post-error finding, so the drift is visible
   * from the break, no spawn needed). Never throws; an absent/unreadable
   * settings.yaml or a healthy profile → silent no-op. The DISPATCH guard
   * itself (spawnWorkerForDepartment/runJobForDepartment) is the hard stop;
   * this is only the early visibility. */
  const runReasoningContentBootAssert = async (): Promise<void> => {
    try {
      const provider = WORKER_AGENT_OPTIONS.provider
      if (typeof provider !== 'string' || provider === '') return
      const settings = readLlmPiAiProviderSettings(stateDir)
      const verdict = resolveReasoningContentPreflight(provider, settings, stateDir)
      if (verdict.ok) return
      ctx.logger.warn(`[deepartments] ${verdict.reason} (boot drift — DISPATCH rejects until the flag is set; non-fatal)`)
      await appendPostError(stateDir, { ts: Date.now(), postId: REASONING_CONTENT_PREFLIGHT_POST_ID, error: verdict.reason })
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] reasoning-content boot assert failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** m-119 — DURABLE host/post registry VALIDATION at boot. After both
   * registries cold-load, VALIDATE the durable hosts.json invariant and the
   * durable posts.json retire-leak class and WARN on any degenerate state
   * (warn-on-degenerate, idempotent, non-throwing) so the durable registry
   * converges to the live reality WITHOUT manual intervention. The Boot hook is
   * deliberately READ-ONLY: it never auto-retires/rewrites a legitimate
   * multi-host or multi-live state (a fleet of dormant hosts, or a rotation in
   * progress, must stay resumable — see the VARIANT-2 dormant-host resume
   * regression). The WRITE repair is exposed on the exported helpers as an
   * explicit `write` / `retireGoneWorkers` opt-in (unit-tested) and is safe to
   * run when a degenerate state is confirmed. The Bug A durable-gate +
   * alert-recipient behavior (already correct) is unchanged. */
  const runDurableRegistryReconciliation = async (): Promise<void> => {
    try {
      // (1) durable HOSTS registry — validate + warn (read-only; no auto-write).
      await reconcileDurableHostRegistry(stateDir, { logger: ctx.logger, write: false })
      // (2) durable POSTS registry — flag + warn a gone WORKER session
      // (retire-if-safe is an explicit opt-in; a configured head is never
      // flagged). The session-gone resolver is CONSERVATIVE: only a positively
      // confirmed absent durable session counts as gone (unable to determine →
      // NOT gone → never flagged).
      const persistence = ctx.get('sessionPersistence') as { readRaw?: (id: SessionId, signal?: AbortSignal) => Promise<{ content: string } | undefined> } | undefined
      // A3/C2 — the durable posts.json RETIRED-entry retention policy knob.
      // Read SHARED-first from the resolved `org` binding (coreOrg?.org ?? cfg.org
      // — see :4222), NOT from the bundle row's own `config.org` (the FASE 2.6
      // MIRROR, which does NOT carry the relocated org values; the dshd-core row
      // is the SHARED CONFIG SOURCE and is where the knob actually lives). This
      // mirrors the shared-first consumption pattern of every other
      // deepartments.org consumer (e.g. :4213-4222). Only wired when the section
      // is present; an ABSENT section falls through to the code defaults in the
      // registrar, which are CONSERVATIVE: retired-entry pruning is OFF by
      // default and is enabled ONLY by an explicit
      // `org.postsRetention.enabled: true`. The shared-surface value is read via
      // an explicit typed cast for clarity; the dshd-core `OrgConfig` NOW
      // declares postsRetention (FASE 2.6 shared source devexpone postsRetention)
      // and the bundle's `Config['org']` (which `org` is typed as) exposes it
      // too, so the in-bundle fallback (`cfg.org`) stays behavior-neutral (same
      // nested config when dshd-core is not composed).
      const postsRetention = (org as { postsRetention?: PostsRetentionConfig }).postsRetention
      const reconcilePosts = await reconcileDurablePostsRegistry(stateDir, {
        logger: ctx.logger,
        retireGoneWorkers: false,
        ...(postsRetention !== void 0
          ? {
              retiredKeep: postsRetention.maxRetiredKept,
              retiredArchiveFile: postsRetention.archiveFile,
              enableRetiredPrune: postsRetention.enabled
            }
          : {}),
        isSessionGone: async (sessionId: string): Promise<boolean> => {
          if (persistence === undefined || typeof persistence.readRaw !== 'function') return false
          try {
            const raw = await persistence.readRaw(SessionId(sessionId))
            return raw === undefined
          } catch {
            return false
          }
        },
        // B5 — the conservative unusability classifier: ONLY a worker whose
        // materialization threw the "has no provider/model" error (recorded in
        // the durable unusable-agent-options.json marker) counts as unusable,
        // AND only when the marker's session id matches the CURRENT durable
        // session id (a worker that later got a fresh session is never
        // over-retired). Never throws — a marker read failure degrades to false.
        isSessionUnusable: async (sessionId: string, postId: string): Promise<boolean> => {
          const marks = readUnusableSessionsMark(stateDir)
          const mark = marks[postId]
          return mark !== undefined && mark.sessionId === sessionId
        }
      })
      // C2 partial-prune FIX: `reconcileDurablePostsRegistry` is FILE-based —
      // it rewrites posts.json (the pruned set) but does NOT touch the
      // in-memory catalog, which `loadPosts` populated with the FULL pre-prune
      // set. Without an in-memory sync, ANY later `persistPosts()` (a
      // registerEntry / markPostRetired / ensureHost) writes the FULL set back
      // to posts.json — undoing the prune (posts.json reverts to the pre-prune
      // count moments after the reconcile). Synchronize the catalog to the
      // PRUNED set so the next persist writes the pruned entries. This only
      // drops the OLDEST retired posts beyond `retiredKeep` — already archived
      // + backed up, never a live roster/wake target (R6 intact; the archive
      // and the pre-prune backup are NOT touched).
      if (reconcilePosts.prunedPostIds.length > 0) {
        const removed = registry.removePosts(reconcilePosts.prunedPostIds)
        ctx.logger.info(`[deepartments] durable-registry reconcile: dropped ${removed} pruned retired post(s) from the in-memory catalog to keep it consistent with the pruned posts.json (a later persist now writes the pruned set, not the full set)`)
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] durable-registry validation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** B5-GHOST (QH — dispatch-hardening, the AFTER half of the «429-primer-call»
   * class; 2026-08-28): the boot pass that classifies a catalog-LIVE post
   * WITHOUT a usable session (offline/muerto — e.g. the explore-deep-9 class: a
   * worker that burned its first call and whose session died with it) as a
   * RETIRE-CANDIDATE via the CENSUS LEDGER heuristic — NEVER on the first
   * observation (false-positive risk: a live post "solo entre
   * materializaciones" has a resumable durable session and is NOT a ghost).
   * Each BOOT is ONE census tick:
   *   - a post whose session is usable NOW (live in the agents registry, OR a
   *     durable session present AND not B5-unusable) is CLEARED — the ledger
   *     entry drops, the consecutive-miss chain breaks (an INTERMITTENT
   *     session never accumulates → never retired);
   *   - a post WITHOUT a usable session accumulates `misses`; after
   *     `org.ghostSuspect.warnAfterTicks` (default 2) CONSECUTIVE misses the
   *     `ghost-suspect` MARKER appears (WARN — the post is a retire-candidate,
   *     still NOT auto-retired: the first observations could be transients);
   *   - the AUTO-RETIRE fires ONLY when the marker persists > M ticks
   *     (`org.ghostSuspect.retireAfterTicks`, default 8 — conservative)
   *     — the retire-candidate class of the triage (explore-deep-9) is covered
   *     with ZERO false positives.
   * The ledger is durable (`<stateDir>/ghost-suspect-state.json`). NEVER
   * throws / never touches a configured head (only `provider:'worker'` posts) /
   * `org.ghostSuspect.enabled === false` → the pass is skipped (pre-b5-ghost
   * behavior). This is NOT the existing done-gone reconcile: it is a SEPARATE
   * pass with the marker heuristics, so the durable-registry reconcile's
   * conservative flag/warn-only semantics stay UNCHANGED. */
  const GHOST_SUSPECT_DEFAULT_WARN_TICKS = 2
  const GHOST_SUSPECT_DEFAULT_RETIRE_TICKS = 8
  // fb-78 A1 F3-stale — the DEFAULT minimum age before a no-post/no-host/
  // no-live top-level durable session is archived (owner decision: >= 48h).
  const RETIRED_RESIDUE_DEFAULT_MIN_AGE_MS = 48 * 60 * 60 * 1000
  const runGhostSuspectReconcile = async (): Promise<void> => {
    try {
      const ghostSuspectConfig = (org as { ghostSuspect?: { enabled?: boolean; warnAfterTicks?: number; retireAfterTicks?: number } }).ghostSuspect
      if (ghostSuspectConfig?.enabled === false) return
      const warnAfterTicks = ghostSuspectConfig?.warnAfterTicks !== undefined && Number.isFinite(ghostSuspectConfig.warnAfterTicks) && ghostSuspectConfig.warnAfterTicks > 0
        ? Math.trunc(ghostSuspectConfig.warnAfterTicks)
        : GHOST_SUSPECT_DEFAULT_WARN_TICKS
      const retireAfterTicks = ghostSuspectConfig?.retireAfterTicks !== undefined && Number.isFinite(ghostSuspectConfig.retireAfterTicks) && ghostSuspectConfig.retireAfterTicks > 0
        ? Math.trunc(ghostSuspectConfig.retireAfterTicks)
        : GHOST_SUSPECT_DEFAULT_RETIRE_TICKS
      const persistence = ctx.get('sessionPersistence') as { readRaw?: (id: SessionId, signal?: AbortSignal) => Promise<{ content: string } | undefined> } | undefined
      // The conservative session-presence resolver: ONLY a positively confirmed
      // absent durable session (readRaw → undefined) counts as lacking a
      // resumable session; unable-to-determine → present (usable).
      const durableSessionPresent = async (sessionId: string): Promise<boolean> => {
        if (persistence === undefined || typeof persistence.readRaw !== 'function') return true
        try {
          return (await persistence.readRaw(SessionId(sessionId))) !== undefined
        } catch {
          return true
        }
      }
      // The B5 VARIANT-2 ghost (a durable session present but with NO usable
      // AgentOptions — the builder-87 class): the unusable-options marker with
      // a session id matching the CURRENT durable session id.
      const isB5Unusable = (sessionId: string, postId: string): boolean => {
        const marks = readUnusableSessionsMark(stateDir)
        const mark = marks[postId]
        return mark !== undefined && mark.sessionId === sessionId
      }
      const previous = readGhostSuspectLedger(stateDir)
      const rows: Array<{ postId: string; sessionId: string; usable: boolean }> = []
      for (const [postId, entry] of byPost) {
        if (entry.provider !== 'worker' || entry.retired === true) continue
        const liveNow = agents !== void 0 && agents.get(String(SessionId(entry.sessionId))) !== undefined
        const durablePresent = await durableSessionPresent(entry.sessionId)
        const unusable = isB5Unusable(entry.sessionId, postId)
        rows.push({ postId, sessionId: entry.sessionId, usable: liveNow || (durablePresent && !unusable) })
      }
      const nowMs = Date.now()
      const verdict = stepGhostSuspectCensus(rows, previous, nowMs, { warnAfterTicks, retireAfterTicks })
      // WARN per newly-marked ghost-suspect (retire-candidate, NOT auto-retired
      // yet — the marker must persist > M ticks first).
      for (const postId of verdict.newlyMarked) {
        const entry = byPost.get(postId)
        ctx.logger.warn(`[deepartments] b5-ghost: post "${postId}" (${entry?.provider ?? 'worker'}) has had NO usable session for ${warnAfterTicks} consecutive census ticks — marked ghost-suspect; NOT auto-retired yet (conservative); will auto-retire after ${retireAfterTicks} more census ticks without a usable session`)
      }
      // AUTO-RETIRE the markers that persisted > N + M ticks — the ONLY
      // auto-retire branch of the heuristic. The caller id is the post's
      // manager head session (retirePost's "only my workers" scope passes: the
      // manager IS the worker's head), or a synthetic non-post id when the
      // manager is gone (a host-like caller — the retire is a system action).
      for (const postId of verdict.retireCandidates) {
        const entry = byPost.get(postId)
        if (entry === void 0 || entry.retired === true || entry.provider !== 'worker') continue
        try {
          await retirePost(postId, entry.managerId !== void 0 ? byPost.get(entry.managerId)?.sessionId ?? 'deepartments-b5-ghost' : 'deepartments-b5-ghost')
          ctx.logger.warn(`[deepartments] b5-ghost: auto-retired worker "${postId}" (ghost-suspect marker persisted > ${warnAfterTicks + retireAfterTicks} census ticks without a usable session)`)
          // The retired ghost's ledger entry is PRUNED from the NEXT ledger
          // (a retired post is no longer a census subject — the entry must not
          // linger for a future boot to re-read).
          delete verdict.ledger[postId]
        } catch (retireError: unknown) {
          ctx.logger.warn(`[deepartments] b5-ghost: auto-retire of "${postId}" failed (non-fatal): ${retireError instanceof Error ? retireError.message : String(retireError)}`)
        }
      }
      for (const postId of verdict.cleared) {
        if (byPost.get(postId)?.retired !== true) {
          ctx.logger.info(`[deepartments] b5-ghost: post "${postId}" has a usable session again — ghost-suspect marker cleared (intermittent session, never retired)`)
        }
      }
      await writeGhostSuspectLedger(stateDir, verdict.ledger)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] b5-ghost reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** fb-78 A2 (owner decision 2026-09-03 — default OFF, conservative; m-228
   * respected) — the OFFLINE-WORKER REAP: the wall-clock census SIBLING of
   * runGhostSuspectReconcile (same boot-only family, same ledger pattern) for
   * the fb-56 ORPHANED class: a NON-RETIRED worker whose DURABLE session is
   * PRESENT but has NO LIVE HANDLE — and NO sleepEpoch — for a wall-clock
   * window (the mid-mission daemon-kill class; the daemon of health NEVER
   * retires this class deliberately, m-228). Where b5-ghost judges a live
   * post with a gone session (miss-ladder), A2 stamps OFFLINE-SINCE on the
   * first offline census and retires only when the offline window crosses
   * `org.offlineReap.maxOfflineMs` (default 72h — conservative):
   *   - census row: every post with provider 'worker' and NOT retired; offline
   *     = NO live agent handle (agents.get(sessionId) === undefined) AND NO
   *     sleepEpoch (a slept worker is dormant-by-design and is NEVER reaped —
   *     the computeDeptWhoState mirror, agents.ts:119-130, with the
   *     sleepEpoch exception of registry.ts:625-629);
   *   - ledger (`<stateDir>/offline-reap-state.json`): offlineSince ??= now on
   *     the FIRST observation (warm-up — the first census NEVER retires);
   *     live → entry dropped (intermittent never accumulates); only
   *     now − offlineSince > maxOfflineMs → retireCandidate;
   *   - reap: retirePost(postId, manager-session-or-synthetic) — the SHARED
   *     seam (markPostRetired :2591 + unconditional archive :2622 + QD dice);
   *     idempotent (early-return :2580); the ledger entry is pruned after.
   * RACE MITIGATION (the boot passes run PARALLEL with ensureAllHeads /
   * redeliverPendingDeliveries — the wiring below SEQUENCES this pass AFTER
   * the redelivery drains, and every retirePost is preceded by a SYNCHRONOUS
   * re-check of agents.get(sessionId) — no awaits between the re-check and
   * the retire call). NON-FATAL by design + knob-gated: `org.offlineReap.
   * enabled !== true` → the pass is skipped (m-228 default: the daemon of
   * health never retires this class; the reap is the explicit opt-in). */
  const OFFLINE_REAP_DEFAULT_MAX_OFFLINE_MS = 72 * 60 * 60 * 1000
  const runOfflineWorkerReapReconcile = async (): Promise<void> => {
    try {
      const offlineReapConfig = (org as { offlineReap?: OfflineReapConfig }).offlineReap
      if (offlineReapConfig?.enabled !== true) return
      const maxOfflineMs = offlineReapConfig?.maxOfflineMs !== undefined && Number.isFinite(offlineReapConfig.maxOfflineMs) && offlineReapConfig.maxOfflineMs > 0
        ? offlineReapConfig.maxOfflineMs
        : OFFLINE_REAP_DEFAULT_MAX_OFFLINE_MS
      const previous = readOfflineReapLedger(stateDir)
      const rows: Array<{ postId: string; sessionId: string; offline: boolean }> = []
      for (const [postId, entry] of byPost) {
        if (entry.provider !== 'worker' || entry.retired === true) continue
        const liveNow = agents !== void 0 && agents.get(String(SessionId(entry.sessionId))) !== undefined
        const slept = entry.sleepEpoch !== void 0
        rows.push({ postId, sessionId: entry.sessionId, offline: !liveNow && !slept })
      }
      const nowMs = Date.now()
      const verdict = stepOfflineReapCensus(rows, previous, nowMs, { maxOfflineMs })
      // WARN per NEWLY-stamped worker (the first offline observation — warm-up,
      // NOT retired yet: the offline window is 0).
      for (const row of rows) {
        const stamped = verdict.ledger[row.postId]
        if (stamped !== undefined && previous[row.postId] === undefined) {
          ctx.logger.warn(`[deepartments] offline-reap: worker "${row.postId}" (session ${row.sessionId}) observed OFFLINE (no live handle, no sleepEpoch) — offlineSince stamped; auto-retire after ${Math.round(maxOfflineMs / 3_600_000)}h offline (org.offlineReap, default OFF → pass gated)`)
        }
      }
      // The AUTO-RETIRE branch — ONLY the crossed-window candidates. Re-check
      // liveness SYNCHRONOUSLY immediately before each retirePost (the boot
      // passes run parallel with ensureAllHeads/redeliver — a worker that
      // materialized in the meantime is never reaped). The caller id is the
      // post's manager head session, or a synthetic non-post id (a system
      // action, like the b5-ghost caller).
      for (const postId of verdict.retireCandidates) {
        const entry = byPost.get(postId)
        if (entry === void 0 || entry.retired === true || entry.provider !== 'worker') continue
        // The re-check: still no live handle THIS INSTANT → reap. No await
        // between the check and retirePost (fb-68 discipline).
        if (agents !== void 0 && agents.get(String(SessionId(entry.sessionId))) !== undefined) {
          ctx.logger.warn(`[deepartments] offline-reap: worker "${postId}" came back LIVE right before the reap — skipped (no retire)`)
          delete verdict.ledger[postId]
          continue
        }
        try {
          await retirePost(postId, entry.managerId !== void 0 ? byPost.get(entry.managerId)?.sessionId ?? 'deepartments-offline-reap' : 'deepartments-offline-reap')
          ctx.logger.warn(`[deepartments] offline-reap: auto-retired worker "${postId}" (offline without a live handle for > ${Math.round(maxOfflineMs / 3_600_000)}h — the fb-56 orphaned class)`)
          // The reaped worker's ledger entry is PRUNED (a retired post is no
          // longer a census subject — the entry must not linger).
          delete verdict.ledger[postId]
        } catch (retireError: unknown) {
          ctx.logger.warn(`[deepartments] offline-reap: auto-retire of "${postId}" failed (non-fatal): ${retireError instanceof Error ? retireError.message : String(retireError)}`)
        }
      }
      for (const postId of verdict.cleared) {
        if (byPost.get(postId)?.retired !== true) {
          ctx.logger.info(`[deepartments] offline-reap: worker "${postId}" is LIVE again (or left the census) — offline stamp cleared (intermittent, never reaped)`)
        }
      }
      await writeOfflineReapLedger(stateDir, verdict.ledger)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] offline-reap reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Fix (head-sleep idempotency/rotation-race) — (b) BOOT RECONCILE: a HEAD
   * whose post entry carries a SLEPT mark (sleepEpoch set) but whose session was
   * NEVER archived/closed — the "half-slept" dangling state left when a
   * host-session rotation / service restart landed DURING the dept_sleep
   * teardown (the pre-fix ordering put the awaited QD directive between the
   * archive and the dispose, so an abort on that await left the archive
   * un-sealed and the handle LIVE) — has an un-archived durable session that
   * nothing else reconciles (ensureHead skips a sleepEpoch-set head at boot, so
   * it is never touched). At boot, re-seal it: re-run the (idempotent)
   * archivePostSessionOnSleep for that sessionId so no dangling un-archived
   * session remains. NEVER throws and NEVER wakes/materializes the head — a
   * slept head stays dormant until its next bus wake (which mints a fresh
   * session), exactly as the F8 boot-dormancy invariant requires. */
  const runHalfSleptHeadReconcile = async (): Promise<void> => {
    try {
      const persistence = ctx.get('sessionPersistence') as { readRaw?: (id: SessionId, signal?: AbortSignal) => Promise<{ content: string } | undefined> } | undefined
      // Conservative session-gone resolver (mirrors reconcileDurablePostsRegistry):
      // only a positively confirmed absent durable session counts as gone.
      const isSessionGone = async (sessionId: string): Promise<boolean> => {
        if (persistence === undefined || typeof persistence.readRaw !== 'function') return false
        try {
          const raw = await persistence.readRaw(SessionId(sessionId))
          return raw === undefined
        } catch {
          return false
        }
      }
      for (const [postId, entry] of byPost) {
        if (entry.retired === true) continue
        if (entry.provider === 'worker') continue          // worker retire is its own path
        if (entry.sleepEpoch === void 0) continue          // only a SLEPT head
        // Re-seal the archive. Idempotent (registry.archiveSession is a no-op on
        // an already-archived id) + non-fatal (archivePostSessionOnSleep never
        // throws; a missing registry warns + returns false). The head is NEVER
        // woken — it stays dormant until its next bus delivery.
        await archivePostSessionOnSleep(entry.sessionId)
        // Fix (head-sleep worker drain): the slept head carries a durable
        // `inflightWorkers` ledger of the workers it slept with. Surface each
        // durably so a worker that finished mid-boundary is not orphaned and a
        // still-running worker is flagged. Only a worker whose durable session is
        // DEFINITIVELY gone is auto-retired (safe-reap); the rest are left live
        // (a delivered report cuts them, or the head reaps them on wake).
        if (Array.isArray(entry.inflightWorkers) && entry.inflightWorkers.length > 0) {
          for (const workerId of entry.inflightWorkers) {
            const worker = byPost.get(workerId)
            if (worker === void 0 || worker.retired === true) continue
            if (await isSessionGone(worker.sessionId)) {
              ctx.logger.warn(`[deepartments] half-slept reconcile: worker "${workerId}" (session ${worker.sessionId}) is in-flight for sleeping head "${postId}" but its durable session is gone — auto-retiring (it finished mid-boundary and was not cut clean)`)
              try {
                await retirePost(workerId, entry.sessionId)
              } catch (retireError: unknown) {
                ctx.logger.warn(`[deepartments] half-slept reconcile: auto-retire of worker "${workerId}" failed (non-fatal): ${retireError instanceof Error ? retireError.message : String(retireError)}`)
              }
            } else {
              ctx.logger.warn(`[deepartments] half-slept reconcile: worker "${workerId}" is still in flight for sleeping head "${postId}" — left live; a delivered report to "${postId}" retires it, or ${postId} reaps it on wake`)
            }
          }
        }
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] half-slept-head reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Dx1 F2 (owner bug — sidebar showed RETIRED workers as 'idle') + fb-78 A1
   * F3-stale (owner decision 2026-09-03 — every top-level /ungrouped durable
   * session with NO post is archival once STALE): a boot residue pass that
   * populates the workspace-registry hide-set (spec §5.3, D5) for the session
   * residue NO retire seam ever archived. Before F1, the archive traveled
   * inside the 25% QD dice of retirePost, so most AUTO-RETIRES (delivery
   * auto-retire / half-slept reap) left the row visible forever — and even the
   * tool retires archived ONLY entry.sessionId, so an OLDER/PARALLEL
   * incarnation of the SAME slug (`worker-<slug>-<uuid>` #2) stayed visible
   * too. This pass (modeled on runHalfSleptHeadReconcile) runs ONCE at boot
   * and:
   *   (a) archives the CURRENT durable session (entry.sessionId) of EVERY
   *       RETIRED WORKER post — independent of the (optional) persistence
   *       enumeration below, so a headless/minimal persistence still seals it;
   *   (b) sweeps EVERY durable session the persistence knows
   *       (sessionPersistence.list() — the backend header ids; a bounded
   *       sessions-root dir scan as a best-effort fallback when the service is
   *       absent) and archives each id whose slug prefix `worker-<postId>-`
   *       matches a RETIRED worker post — the multi-session residue;
   *   (c) F3-STALE (fb-78 A1 — replaces the old "F3 deliberately out" doc):
   *       the ARCHIVAL of TOP-LEVEL /UNGROUPED durable sessions that belong to
   *       NO post and NO live host once they are OLD ENOUGH — the owner
   *       decision resolves the workspace-ownership question the old doc
   *       deferred (the researcher-2 class STOPS staying visible): the
   *       REGISTRY-BASED classifier (never a prefix filter) decides — an id is
   *       F3-eligible iff (1) NO-POST: it is not ANY post's current session
   *       (byPost entry.sessionId — heads + workers, live or retired — nor a
   *       byChild key), (2) NO-HOST: it is not the sessionId of a NON-RETIRED
   *       host (the hosts REGISTRY, never a `session-` prefix guess — the
   *       current sleeping host session-66031134… stays protected), (3)
   *       NO-LIVE: the isLive guard (sessions.get / agents.get — re-verified
   *       IMMEDIATELY before every archive), (4) NO LIVE-POST PREFIX: it does
   *       not start with a live post's worker-<postId>- prefix (the slug-chain
   *       collision guard), and (5) AGE: >= org.retiredResidue.minAgeMs
   *       (default 48h) proven by the durable header's createdAt or the
   *       artifact's mtime — a session whose age cannot be determined is
   *       conservatively NOT archived. The cwd-org-owned belt is DEFENSE, not
   *       a hard filter (owner decision: an out-of-org uuid-bare no-post
   *       session is archived too — the classifier above MANDA); documented
   *       here so a future reader never turns the belt into an exclusion.
   * Conservatism (ZERO-LOSS, R6/dec4): NOTHING is deleted or terminated —
   * archiveSession is a PURE hide-set add (the durable artifact stays; the
   * posts/hosts catalogs are untouched); a session that is CURRENTLY LIVE in
   * the stores is never archived; and a session whose prefix matches a LIVE
   * post is never archived (a live post's row must stay visible — the
   * slug-chain collision guard: `worker-builder-2-*` also starts with the
   * retired `worker-builder-` prefix). Idempotent: a second boot re-archives
   * nothing (an already-archived id is a registry no-op). Non-fatal by design:
   * a missing sessionPersistence / workspaceRegistry only DEGRADES the sweep
   * (warn, never a boot break), exactly like runHalfSleptHeadReconcile. */
  const runRetiredWorkerResidueReconcile = async (): Promise<void> => {
    try {
      // Slug-prefix indexes over the DURABLE catalog. Only WORKER posts mint
      // `worker-<slug>-` sessions (a retired head is unregistered, never here).
      const livePrefixes: string[] = []
      const retiredPrefixes: string[] = []
      for (const [postId, entry] of byPost) {
        if (entry.provider !== 'worker') continue
        const prefix = `worker-${postId}-`
        if (entry.retired === true) retiredPrefixes.push(prefix)
        else livePrefixes.push(prefix)
      }
      // (a) the CURRENT durable session of every retired worker — independent
      // of the (optional) enumeration below (idempotent; a no-op when already
      // in the hide-set).
      if (retiredPrefixes.length > 0) {
        for (const [, entry] of byPost) {
          if (entry.provider === 'worker' && entry.retired === true) {
            await archiveWorkerSession(entry.sessionId)
          }
        }
      }
      // (b)+(c) the sweep over the durability-known sessions. The corpus keeps
      // the durable header fields the F3-stale classifier needs (id + the age
      // provenance: the header's createdAt when the persistence service
      // enumerated it, else the artifact file's mtime from the dir scan; the
      // cwd for the documented (non-excluding) belt).
      const persistence = ctx.get('sessionPersistence') as
        | { list?: (signal?: AbortSignal) => Promise<Array<{ id?: unknown; createdAt?: unknown; cwd?: unknown } | null | undefined>>; root?: string }
        | undefined
      let durableSessions: Array<{ id: string; createdAt?: number; cwd?: string; mtimeMs?: number }> = []
      if (persistence !== void 0 && typeof persistence.list === 'function') {
        try {
          durableSessions = (await persistence.list())
            .filter((header): header is { id?: unknown; createdAt?: unknown; cwd?: unknown } =>
              header !== null && header !== void 0 && header.id !== void 0)
            .map((header) => {
              const createdAt = typeof header.createdAt === 'number' && Number.isFinite(header.createdAt)
                ? header.createdAt
                : typeof header.createdAt === 'string' && !Number.isNaN(Date.parse(header.createdAt))
                  ? Date.parse(header.createdAt)
                  : undefined
              return {
                id: String(header.id),
                createdAt,
                cwd: typeof header.cwd === 'string' ? header.cwd : undefined
              }
            })
        } catch (error: unknown) {
          ctx.logger.warn(`[deepartments] retired-residue reconcile: sessionPersistence.list() failed — the slug-prefix sweep is skipped (the entry sessions above are still archived): ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        // Best-effort fallback (headless/minimal composition): the jsonl
        // session-store layout puts every session under
        // <root>/<project>/<encoded-id>/session.jsonl*; for the harness id
        // charset the ENCODED DIR NAME IS the session id (identity encoding —
        // dsh-session-persistence-jsonl format.js:129-141), so a bounded
        // two-level scan (stat-only, no full-log parse) collects the ids + the
        // artifact mtime (the F3-stale age provenance in this path).
        const sessionsRoot = typeof persistence?.root === 'string' && persistence.root !== ''
          ? persistence.root
          : path.join(stateDir, '..', 'sessions')
        const sessionIds: Array<{ id: string; mtimeMs?: number }> = []
        try {
          const projects = (await readdir(sessionsRoot, { withFileTypes: true }))
            .filter((e) => e.isDirectory()).map((e) => e.name)
          for (const project of projects) {
            const projectDir = path.join(sessionsRoot, project)
            let dirs: string[] = []
            try {
              dirs = (await readdir(projectDir, { withFileTypes: true }))
                .filter((e) => e.isDirectory()).map((e) => e.name)
            } catch {
              continue
            }
            for (const dir of dirs) {
              for (const suffix of ['session.jsonl.zstd', 'session.jsonl']) {
                try {
                  const st = await stat(path.join(projectDir, dir, suffix))
                  sessionIds.push({ id: dir, mtimeMs: st.mtimeMs })
                  break
                } catch { /* try the next suffix */ }
              }
            }
          }
        } catch {
          /* sessions root absent/unreadable — no fallback corpus (safe no-op) */
        }
        durableSessions = sessionIds
      }
      if (durableSessions.length === 0) return
      const sessions = ctx.get('sessions') as { get?: (id: unknown) => unknown } | undefined
      const isLive = (sessionId: string): boolean =>
        sessions?.get?.(sessionId) !== undefined ||
        (agents !== void 0 && agents.get(SessionId(sessionId)) !== undefined)
      for (const { id } of durableSessions) {
        if (!id.startsWith('worker-')) continue
        if (isLive(id)) continue // never hide a RUNNING session
        if (livePrefixes.some((prefix) => id.startsWith(prefix))) continue // a LIVE post's session stays visible (also the slug-chain collision guard)
        if (retiredPrefixes.some((prefix) => id.startsWith(prefix))) {
          await archiveWorkerSession(id)
        }
      }
      // (c) fb-78 A1 F3-STALE — the registry-based archival of no-post /
      // no-host / no-live / old-enough durable sessions (the owner decision;
      // see the pass doc). Knob: org.retiredResidue {enabled, minAgeMs} —
      // default ON with 48h; `enabled: false` restores the pre-fb-78 behavior.
      const retiredResidueConfig = (org as { retiredResidue?: RetiredResidueConfig }).retiredResidue
      if (retiredResidueConfig?.enabled !== false) {
        const minAgeMs = retiredResidueConfig?.minAgeMs !== undefined && Number.isFinite(retiredResidueConfig.minAgeMs) && retiredResidueConfig.minAgeMs > 0
          ? retiredResidueConfig.minAgeMs
          : RETIRED_RESIDUE_DEFAULT_MIN_AGE_MS
        // The registry-based ownership views the classifier uses — built ONCE
        // per pass from the DURABLE catalogs (never a prefix guess):
        //  - postSessions: every post's CURRENT session (byPost entries —
        //    heads + workers, live or retired) + the byChild reverse index
        //    keys (a registered incarnation mapping);
        //  - liveHostSessions: the sessionIds of NON-RETIRED host entries
        //    (the hosts REGISTRY — the current sleeping host is protected
        //    here, never by a `session-` prefix filter).
        const postSessions = new Set<string>()
        for (const [, entry] of byPost) {
          postSessions.add(entry.sessionId)
        }
        for (const childSessionId of registry.byChild.keys()) {
          postSessions.add(childSessionId)
        }
        const liveHostSessions = new Set<string>()
        for (const [, hostEntry] of hosts) {
          if (hostEntry.retired !== true) liveHostSessions.add(hostEntry.sessionId)
        }
        // Config-coordinator belt: a CONFIGURED head's DETERMINISTIC session id
        // (head-<postId>) is never F3 — a never-registered configured head (no
        // durable posts.json entry yet) is materialized by the PARALLEL
        // ensureAllHeads at this same boot; without this guard the no-post
        // classifier could archive it mid-materialization (the isLive re-check
        // narrows the window but cannot close it — the materialization races
        // this pass). Config heads are permanent, never orphan residue.
        for (const department of org.departments) {
          const coordinator = department.coordinator
          if (coordinator?.postId !== void 0) liveHostSessions.add(headSessionId(coordinator.postId))
        }
        const nowMs = Date.now()
        for (const candidate of durableSessions) {
          if (candidate.id.startsWith('worker-') && retiredPrefixes.some((prefix) => candidate.id.startsWith(prefix))) continue // (b) already handled it
          if (postSessions.has(candidate.id)) continue // a post's CURRENT session — never F3 (a live/retired post owns it)
          if (liveHostSessions.has(candidate.id)) continue // a NON-RETIRED host's session — the registry protects it (a sleeping current host included)
          if (isLive(candidate.id)) continue // never hide a RUNNING session
          if (livePrefixes.some((prefix) => candidate.id.startsWith(prefix))) continue // a LIVE post's slug-family session stays visible (the slug-chain guard)
          // Age: createdAt (header) OR mtime (artifact). Age UNPROVEN →
          // conservative OUT (a boot cannot prove a session stale without an
          // age signal — never archive on doubt).
          const ageProvenAt = candidate.createdAt !== undefined ? candidate.createdAt
            : candidate.mtimeMs !== undefined ? candidate.mtimeMs
              : undefined
          if (ageProvenAt === undefined) continue
          const ageMs = nowMs - ageProvenAt
          if (ageMs < minAgeMs) continue
          // RACE mitigation (boot passes run parallel with ensureAllHeads /
          // redeliver): re-verify liveness immediately before the archive —
          // no await between the re-check and the hide-set add.
          if (isLive(candidate.id)) continue
          await archiveWorkerSession(candidate.id)
          ctx.logger.info(`[deepartments] fb-78 A1 F3-stale: archived top-level no-post session ${candidate.id} (age ${Math.round(ageMs / 3_600_000)}h >= ${Math.round(minAgeMs / 3_600_000)}h) — the sidebar row is hidden (D5; the artifact + catalogs stay intact)`)
        }
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] retired-residue reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Boot: materialize the head preset and every configured head once the
  // registries (posts/hosts) have cold-loaded — and re-drive any crash-pending
  // bus deliveries (see the re-delivery driver below). Head materialization no
  // longer needs a live parent (root agents) — it runs at boot unconditionally.
  void Promise.all([registryLoaded, hostsLoaded]).then(() => {
    void ensureAllHeads()
    // fb-78 A2: the offline-worker reap runs SEQUENCED AFTER the redelivery
    // drains — a worker with a pending 'prepared'/'failed' delivery is
    // re-materialized by the redelivery IN THE SAME BOOT (agents.get defined
    // again), so the reap must never judge it while the redelivery is still
    // in flight (it would stamp offlineSince on a worker about to be woken).
    void redeliverPendingDeliveries.run().then(
      () => { void runOfflineWorkerReapReconcile() },
      () => { void runOfflineWorkerReapReconcile() }
    )
    // LANE ② (item 2 — "re-drive no-boot-only"): the NON-BOOT redelivery
    // SWEEP is armed at factory build (startRedeliverySweep above — the
    // ctx.effect must register in-fiber); the pending failed/prepared pairs
    // re-drive on the SCHEDULE (backoff-gated), never waiting for a restart
    // again (the 09-03 gate-clean had to wait for the first boot post-restart
    // to re-deliver its 14 messages).
    void runPresetAudit()
    void runInterruptedPostReconciliation()
    void runProviderAdapterBootCheck()
    void runReasoningContentBootAssert()
    void runDurableRegistryReconciliation()
    void runHalfSleptHeadReconcile()
    void runRetiredWorkerResidueReconcile()
    void runGhostSuspectReconcile()
  })

// =========================================================================
  // TOOLS ZONE — SUB-BATCH 4 of 4 (hoisted VERBATIM from applyInvoke 4246-5476:
  // the bus/feedback TOOL DEFINITIONS (feedbackTool / feedbackListTool /
  // feedbackUpdateTool / sendMessageTool / agentMessagesTool / deptWhoTool +
  // the feedbackEmitTools / feedbackHeadTools / busTools arrays) + the host
  // own-layer registration + the OVERRIDE note + the host-plane registrations
  // + the boot re-delivery driver + guiEndpointDeps + (the late-binding
  // register buckets bus / deliver / wakepack / lifecycle / redeliver /
  // gui / pooler / jobs / health — DEAD since LANE DI-BY-SERVICES, the
  // closure sets now flow into the deps holders) + the W1 scheduler / W6
  // health builder closures + the 9 GLOBAL host-plane tool registrations +
  // the disposal ctx.effect — the same closures, the same order, the same
  // semantics).
  // =========================================================================
  // --- messaging bus TOOL DEFINITIONS (ONE body per tool; registered in the
  // post OWN layer + the host agent's own layer + (when the name is free) the
  // GLOBAL host plane — see the override note before the registrations).
  // ---------------------------------------------------------------------------

  // --- dshd-feedback TOOL DEFINITIONS (ONE body per tool; registered in the
  // post OWN layer (universal — ANY agent may emit feedback) + the GLOBAL host
  // plane. The QH-authority of `dept_feedback_update` is enforced in `execute`.
  // The store is the dshd-feedback library FeedbackStore (opened per-apply).
  // ---------------------------------------------------------------------------

  /** The FeedbackRecord output JSON schema (shared by the 3 feedback tools). */
  const feedbackRecordSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      createdAt: { type: 'number', required: true },
      updatedAt: { type: 'number', required: true },
      emisor: { type: 'string', required: true },
      source: { type: 'string', required: true },
      tipo: { type: 'string', required: true },
      severidad: { type: 'string', required: true },
      estado: { type: 'string', required: true },
      resumen: { type: 'string', required: true },
      archivo_linea: { type: 'string' },
      event: { type: 'string' },
      evidencia: { type: 'string' },
      notas_qh: { type: 'string' },
      report_path: { type: 'string' },
      escalado: { type: 'boolean' },
      escalado_a: { type: 'string' },
      cerrado_por: { type: 'string' }
    }
  } as const

  /** `dept_feedback` — the universal feedback emitter (R7): ANY agent (worker /
   * head / host) writes a durable feedback record to the FeedbackStore and
   * notifies quality-head severity-gated via `deliverOrQueue` (record.from is an
   * ACL-legal FORWARDER — head/host self, worker = its manager or dept
   * coordinator; the real emisor travels in the record + the body). */
  const feedbackTool = defineTool({
    name: 'dept_feedback',
    description: 'Emit a quality/feedback record to the durable feedback backlog (the quality-head backlog). ANY agent — a worker, a department head, or the host — may send; the record.write is ACL-free. `tipo` = the kind ("fallo" | "mejora"); `severidad` = priority ("critico" | "alto" | "medio" | "bajo"); `resumen` = the one-line summary (required); `evidencia`/`archivo_linea` = optional supporting detail. The record is written to <stateDir>/feedback.jsonl with estado "abierto" (emisor = YOU) and the quality-head is notified SEVERITY-GATED: critico → wake + interrupt; alto → wake; medio/bajo/mejora → no-wake queue. The notification is ACL-legal (a worker forwards via its head; the real emisor is in the record + body). Returns the created FeedbackRecord (id included).',
    parameters: {
      tipo: { type: 'string', required: true, description: 'The feedback type: "fallo" (defect) | "mejora" (improvement).' },
      severidad: { type: 'string', required: true, description: 'The priority: "critico" | "alto" | "medio" | "bajo".' },
      resumen: { type: 'string', required: true, description: 'The one-line summary (non-empty).' },
      evidencia: { type: 'string', description: 'Optional supporting evidence/snippet.' },
      archivo_linea: { type: 'string', description: 'Optional file:line reference (e.g. src/invoke.ts:1234).' }
    },
    output: { schema: feedbackRecordSchema, render: feedbackRecordRender },
    async execute(args, exec): Promise<FeedbackRecord> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_feedback requires a calling agent (exec.agent was undefined)')
      const emisor = busMemberIdFor(agent.id as string)
      const tipo = String(args.tipo).trim() as FeedbackTipo
      const severidad = String(args.severidad).trim() as FeedbackSeveridad
      const resumen = String(args.resumen).trim()
      const store = await feedbackStoreReady
      const input: FeedbackInput = { emisor, tipo, severidad, resumen }
      const evidencia = args.evidencia === undefined ? undefined : String(args.evidencia).trim()
      const archivo_linea = args.archivo_linea === undefined ? undefined : String(args.archivo_linea).trim()
      if (evidencia !== undefined && evidencia !== '') input.evidencia = evidencia
      if (archivo_linea !== undefined && archivo_linea !== '') input.archivo_linea = archivo_linea
      const record = await store.append(input)
      // R7 — notify quality-head severity-gated (fire-and-forget; the feedback
      // record is durable regardless of the notification outcome).
      const qualityHead = resolveQualityHeadEntry()
      if (qualityHead !== undefined) {
        const forwarder = feedbackForwarderFor(emisor)
        const text = `[dept_feedback ${severidad}/${tipo} from ${emisor}]: ${resumen}` +
          (evidencia !== undefined && evidencia !== '' ? `\nEvidencia: ${evidencia}` : '') +
          (archivo_linea !== undefined && archivo_linea !== '' ? `\n${archivo_linea}` : '')
        const deliverOpts = feedbackDeliveryOptions(tipo, severidad)
        try {
          const messageStore = await messagesStoreReady
          if (forwarder !== undefined) {
            const notifRecord = await messageStore.append({ from: forwarder, to: ['quality-head'], text, kind: 'agent' })
            const status = await delivery.deliverOrQueue('quality-head', notifRecord, {
              callerAgentId: agent.id as string,
              senderSessionId: agent.id as string,
              signal: exec.signal,
              ...deliverOpts
            })
            if (status === 'failed') ctx.logger.warn(`[deepartments] dept_feedback notification to quality-head failed (${status}) — feedback ${record.id} is durable`)
          } else {
            // No ACL-legal forwarder: fall back to the direct QD seam (the
            // QD-directive precedent — bypasses the delivery-engine ACL).
            const notifRecord = await messageStore.append({ from: 'deepartments', to: ['quality-head'], text, kind: 'agent' })
            await busDeliverToPost(qualityHead, `[From deepartments → quality-head]: ${text}`, notifRecord, void 0)
          }
        } catch (error: unknown) {
          ctx.logger.warn(`[deepartments] dept_feedback notification to quality-head failed (non-fatal — the feedback record is durable): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return record
    }
  })

  /** `dept_feedback_list` — surfacing (read-only). fb-18 (QH backlog): the tool
   * registers ONLY in a HEAD's own layer + the host plane — a WORKER never sees
   * it (structural absence); the execute-side worker reject below stays as
   * defense-in-depth (a legacy/hosted copy called with a worker agent). */
  const feedbackListTool = defineTool({
    name: 'dept_feedback_list',
    description: 'Surface the durable feedback backlog (read-only). Lists the LIVE feedback records (latest tail per id), optionally filtered by `estado`/`severidad`/`tipo`/`emisor`, sorted severity desc then createdAt asc, paged (default 20, cap 100) with an exclusive `cursor` id (the previous page\'s last id). Available to department heads (incl. quality-head) and the host — a WORKER never sees the tool (it is not in the worker toolset, fb-18). Returns {total, items, remaining, cursor?}.',
    parameters: {
      estado: { type: 'string', description: 'Filter by estado: "abierto" | "en-estudio" | "resuelto" | "descartado".' },
      severidad: { type: 'string', description: 'Filter by severidad: "critico" | "alto" | "medio" | "bajo".' },
      tipo: { type: 'string', description: 'Filter by tipo: "fallo" | "mejora".' },
      emisor: { type: 'string', description: 'Filter by the emitter member id.' },
      cursor: { type: 'string', description: 'Optional exclusive cursor: a feedback record id (the previous page\'s last id).' },
      limit: { type: 'number', description: 'Optional page size (default 20, cap 100).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          items: { type: 'array', required: true, items: feedbackRecordSchema },
          remaining: { type: 'number', required: true },
          cursor: { type: 'string' }
        }
      },
      render: (_args, value) => {
        const head = `feedback backlog (${value.total} total, showing ${value.items.length}${value.remaining > 0 ? `, ${value.remaining} more${value.cursor !== void 0 ? ` (cursor ${value.cursor})` : ''}` : ''}):`
        if (value.items.length === 0) return [{ type: 'text', text: `${head}\n  (no matching feedback records)` } as const]
        const lines = value.items.map((r) => `  - ${r.id} [${r.severidad}] ${r.tipo} ${r.estado} ${r.emisor}: ${r.resumen}`)
        return [{ type: 'text', text: `${head}\n${lines.join('\n')}` } as const]
      }
    },
    async execute(args, exec): Promise<FeedbackListResult> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_feedback_list requires a calling agent (exec.agent was undefined)')
      const postId = postIdForChild(agent.id as string)
      if (postId !== void 0 && byPost.get(postId)?.provider === 'worker') {
        throw new Error('[deepartments] dept_feedback_list is read-only for department HEADS (incl. quality-head) and the host, not a worker')
      }
      const store = await feedbackStoreReady
      const opts: FeedbackListOptions = {}
      const estado = String(args.estado ?? '').trim()
      const severidad = String(args.severidad ?? '').trim()
      const tipo = String(args.tipo ?? '').trim()
      const emisor = String(args.emisor ?? '').trim()
      const cursor = String(args.cursor ?? '').trim()
      if (estado !== '') opts.estado = estado as FeedbackEstado
      if (severidad !== '') opts.severidad = severidad as FeedbackSeveridad
      if (tipo !== '') opts.tipo = tipo as FeedbackTipo
      if (emisor !== '') opts.emisor = emisor
      if (cursor !== '') opts.cursor = cursor
      if (args.limit !== undefined) opts.limit = args.limit as number
      return store.list(opts)
    }
  })

  /** `dept_feedback_update` — append-only state transition (m-371). AUTHORITY:
   * only quality-head may move a record to a TERMINAL estado (resuelto |
   * descartado — stamping `cerrado_por` = the caller); a non-QH head may set
   * `en-estudio`; a reopen (estado → abierto) is only legal from `en-estudio`
   * and ONLY for quality-head, never from a terminal state. Each change is a NEW
   * tail line (same id, updatedAt, estado) — append-only, no in-place edit. */
  const feedbackUpdateTool = defineTool({
    name: 'dept_feedback_update',
    description: 'Transition the state of one durable feedback record (append-only): each change appends a NEW tail line with the SAME id, a bumped `updatedAt`, and the new `estado`. AUTHORITY (spec §4): only `quality-head` may pass a record to a TERMINAL estado (`resuelto` | `descartado` — it stamps `cerrado_por` = the caller); a department head (non-QH) may set `en-estudio`; a reopen (`estado` → `abierto`) is legal only from `en-estudio` (with new evidence) and ONLY for quality-head, and is NEVER allowed from a terminal state. `notas_qh`/`escalado`/`escalado_a` are metadata update fields. WORKER callers are rejected. Returns the updated FeedbackRecord.',
    parameters: {
      id: { type: 'string', required: true, description: 'The feedback record id (fb-<seq>).' },
      estado: { type: 'string', description: 'The target estado: "abierto" | "en-estudio" | "resuelto" | "descartado".' },
      notas_qh: { type: 'string', description: 'Quality-head notes on the record.' },
      escalado: { type: 'boolean', description: 'Mark the record as escalated.' },
      escalado_a: { type: 'string', description: 'Who/where the record was escalated to.' }
    },
    output: { schema: feedbackRecordSchema, render: feedbackUpdateRender },
    async execute(args, exec): Promise<FeedbackRecord> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_feedback_update requires a calling agent (exec.agent was undefined)')
      const postId = postIdForChild(agent.id as string)
      if (postId !== void 0 && byPost.get(postId)?.provider === 'worker') {
        throw new Error('[deepartments] dept_feedback_update is for department HEADS (incl. quality-head) and the host, not a worker')
      }
      const memberId = busMemberIdFor(agent.id as string)
      const isQh = memberId === 'quality-head'
      const store = await feedbackStoreReady
      const id = String(args.id ?? '').trim()
      if (id === '') throw new Error('[deepartments] dept_feedback_update: `id` is required')
      const current = store.get(id)
      if (current === undefined) throw new Error(`[deepartments] dept_feedback_update: no feedback record with id "${id}"`)
      const input: FeedbackUpdateInput = {}
      const estadoRaw = String(args.estado ?? '').trim()
      if (estadoRaw !== '') {
        const estado = estadoRaw as FeedbackEstado
        if (isTerminalEstado(estado)) {
          if (!isQh) throw new Error('[deepartments] dept_feedback_update: only quality-head may move feedback to a TERMINAL estado (resuelto | descartado)')
        } else if (estado === 'abierto') {
          if (!isQh) throw new Error('[deepartments] dept_feedback_update: only quality-head may reopen feedback (en-estudio → abierto, with new evidence)')
        }
        input.estado = estado
      }
      if (args.notas_qh !== undefined) input.notas_qh = String(args.notas_qh)
      if (args.escalado !== undefined) input.escalado = args.escalado === true
      if (args.escalado_a !== undefined) input.escalado_a = String(args.escalado_a)
      return store.update(id, input, isQh ? { cerradoPor: memberId } : {})
    }
  })

  const feedbackEmitTools: readonly ReturnType<typeof defineTool>[] = [feedbackTool]
  const feedbackHeadTools: readonly ReturnType<typeof defineTool>[] = [feedbackListTool, feedbackUpdateTool]

  /** Shared render for a single FeedbackRecord (create/update). */
  function feedbackRecordRender(_args: unknown, value: FeedbackRecord) {
    return [{ type: 'text', text: `feedback ${value.id} ${value.estado} (${value.severidad}/${value.tipo} from ${value.emisor}): ${value.resumen}${value.cerrado_por !== void 0 ? ` — closed by ${value.cerrado_por}` : ''}` } as const]
  }

  /** Shared render for the update tool (append-only transition result). */
  function feedbackUpdateRender(_args: unknown, value: FeedbackRecord) {
    return [{ type: 'text', text: `feedback ${value.id} → ${value.estado}${value.cerrado_por !== void 0 ? ` (closed by ${value.cerrado_por})` : ''}` } as const]
  }

  /** `send_message` — the unified plugin-owned tool (spec §4). NEVER registers
   * globally when the harness native owns the name (dsh-tool-subagent-control);
   * the own-layer registrations SHADOW the native for every deepartments agent
   * ("Scoped tools shadow globals" — the harness's supported override seam:
   * a same-layer duplicate throws, there is no replace). */
  const sendMessageTool = defineTool({
    name: 'send_message',
    description: 'Send a message to one or more background agents and/or organization members, delivering it as the recipient\'s next turn and ALWAYS waking the recipient (including a dormant/host target). Recipients are resolved per id: (1) your direct continuable background children are delivered natively (parent→child followup, never catalog-validated); (2) everything else is resolved against the organization catalog (department heads/workers + the Asistente host) and delivered through the durable message store — the record is persisted BEFORE any delivery and delivery state is tracked in a write-ahead sidecar, so a crash re-delivers idempotently. A `host-session-*` address is validated against hosts.json (non-retired); a typo/never-registered host id fails per-recipient like any unknown id. Unknown ids are reported per-recipient as failed (one typo does not kill a multi-recipient send). A self-addressed recipient (your own id) is held ("self" — persisted, never woken). W9-b `interrupt: true` (optional, default false): a recipient LIVE mid-turn has its CURRENT turn ABORTED (reason "interrupted", pending work preserved) and the message is the FIRST item of its next turn — the harness abort/stop API (Agent.cancel with keepInbox) is the seam; default false keeps QUEUE semantics (zero regression). DEPARTMENT MESSAGING ACL (spec 004 §5.6): the Asistente (host) may send to everyone; a department head may send to any head (incl. the Asistente) and to the agents of its OWN department; a WORKER may send ONLY to the agents of its own department (incl. its head) — a worker CANNOT write to the host, to other heads, or to other departments (everything goes via its own head). A forbidden recipient is reported per-recipient as `failed:acl:<ground>` and is NOT persisted/delivered (the message is not sent to it; route it via the recipient\'s department head). Max 20 recipients (fan-out cap).',
    parameters: {
      to: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Recipient agent ids: direct background children first, then catalog member ids (use dept_who for the roster). Max 20.'
      },
      text: { type: 'string', required: true, description: 'The message text.' },
      ack: { type: 'boolean', description: 'Set true when this is a pure acknowledgement/receipt (no new content) — recorded kind "ack".' },
      sensitive: { type: 'boolean', description: 'Mark this message as sensitive (trust semantics carried over from the board).' },
      threadId: { type: 'string', description: 'Optional: a message id to reply to (recorded as threadId).' },
      interrupt: { type: 'boolean', description: 'Optional, default false. When true, delivery PREEMPTS a busy recipient: a recipient LIVE mid-turn has its CURRENT turn aborted (reason "interrupted") and the message is the FIRST item of its next turn; a DORMANT recipient still wakes + processes immediately. Default false keeps the QUEUE semantics (enqueued behind the current work) — zero regression for normal flows.' },
      noWake: { type: 'boolean', description: 'Optional, default false (absent). When true, delivery to EVERY allowed recipient persists the message record but does NOT materialize/wake the recipient (the record drains at the recipient\'s next real wake — the no-wake-until-wake send). Default false (absent) = the ALWAYS-WAKE path (zero change to normal sends). NOTE: this is the explicit opt-in gate — the caller must never set it for a legitimate work delivery (a worker report to its manager that must auto-retire is always-wake).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // F2: 'none' when EVERY recipient is outside the sender's ACL —
          // then no record is persisted (the store's to[] cannot be empty)
          // and the delivered map carries only the ACL failures. Real records
          // are always `m-<seq>`, so the sentinel is unambiguous.
          messageId: { type: 'string', required: true },
          delivered: { type: 'object', additionalProperties: true, required: true }
        }
      },
      render: (_args, value) => {
        const lines = Object.entries(value.delivered as Record<string, string>)
        const head = value.messageId === 'none'
          ? 'send blocked by the messaging ACL (every recipient outside your scope; nothing sent or persisted)'
          : lines.length === 0
            ? `sent ${value.messageId}`
            : lines.length === 1
              ? `sent ${value.messageId} → ${lines[0][0]}: ${lines[0][1]}`
              : `sent ${value.messageId} to ${lines.length} recipient(s):`
        const text = lines.length === 0 || lines.length === 1
          ? head
          : `${head}\n${lines.map(([id, status]) => `  - ${id}: ${status}`).join('\n')}`
        return [{ type: 'text', text } as const]
      }
    },
    async execute(args, exec): Promise<{ messageId: string; delivered: Record<string, BusSendResult> }> {
      const agent = exec.agent
      if (!agent) throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      assertBusFanOut(args.to)
      // B3 gap fix: the caller host self-registers when hosts.json has no live
      // host — the catalog (host row, you:true, reply-ability) must stay
      // complete without board tools. Single-live guard respected.
      const from = busEnsureHostForCaller(agent as { id: string; session?: { header?: SessionHeaderWithOrigin } })
      const store = await messagesStoreReady
      // F2 (spec 004 §5.6): the ACL PRE-FILTER — ONLY catalog members are
      // gated (transient children AND unknown ids are not ACL subjects; they
      // keep their existing behavior: native child delivery / per-recipient
      // 'failed'). A denied recipient is reported with `failed:acl:<ground>`
      // and is NEITHER persisted NOR delivered — the record's to[] = ONLY the
      // allowed recipients (persist-before-deliver D4 kept: what is persisted
      // is exactly what will be delivered), so the denied surface exists only
      // in this tool result and the sender (e.g. a head) sees what must be
      // channeled. The catalog route re-checks the same predicate defensively
      // (boot re-delivery of pre-ACL records).
      const sender = busProfileFor(from)
      const allowed: string[] = []
      const delivered: Record<string, BusSendResult> = {}
      for (const recipient of args.to) {
        const ground = aclDenyGround(sender, busProfileFor(recipient))
        if (ground === undefined) {
          allowed.push(recipient)
        } else {
          delivered[recipient] = `failed:acl:${ground}`
          ctx.logger.warn(`[deepartments] send_message ACL denied ${from} → ${recipient} (${ground}) — recipient is outside the sender's messaging scope (spec 004 §5.6); route via its department head`)
        }
      }
      if (allowed.length === 0) {
        // Everything was denied: NOTHING is persisted (the store requires a
        // non-empty to[]) and nothing is delivered. The caller receives the
        // per-recipient ACL reasons under the 'none' sentinel messageId.
        return { messageId: 'none', delivered }
      }
      const record = await store.append({
        from,
        to: allowed,
        text: args.text,
        kind: args.ack === true ? 'ack' : 'agent',
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
        ...(args.sensitive === true ? { sensitive: true } : {})
      })
      // Per-message serialization: deliveries run one at a time (never parallel
      // resume of N dormant agents — quota + race safety, spec §4.4). The SINGLE
      // seam: send_message routes through `delivery.deliverOrQueue` (the bus
      // delivery gate, FASE 2 step c) — default noWake:false = ALWAYS-WAKE, the
      // behavior-neutral path.
      // B2 + B3 (m-361): the per-recipient noWake gate. The EXPLICIT
      // `noWake:true` tool param gates the WHOLE send; otherwise B3 no-wakes
      // ONLY the ack (record kind 'ack') to a DORMANT recipient — a QD ack must
      // never re-wake a just-slept head (the record persists 'prepared' and
      // drains at the recipient's next real wake). A non-ack send, an ack to a
      // non-dormant recipient, and the default (no param) stay ALWAYS-WAKE.
      for (const recipient of allowed) {
        const noWake = args.noWake === true || (args.ack === true && isDormantRecipient(recipient))
        delivered[recipient] = await delivery.deliverOrQueue(recipient, record, {
          callerAgentId: agent.id as string,
          senderSessionId: agent.id as string,
          signal: exec.signal,
          interrupt: args.interrupt === true,
          noWake
        })
      }
      return { messageId: record.id, delivered }
    }
  })

  /** `agent_messages` — the caller's OWN received history (spec §5): records
   * where the caller's member id ∈ to[], newest-first, cursor-paged. NO read/
   * seen marks in this phase (pure history pager — the §5 note). */
  const agentMessagesTool = defineTool({
    name: 'agent_messages',
    description: 'Page your OWN received message history (the durable agent-messaging log): records addressed to you (your member id is in to[]), newest first. Cursor pagination via `before` (a message id, exclusive); no read/seen marks exist in this phase — this is a pure history pager. After a compaction renumbers seqs an old cursor id may clamp to the newest record (the history is still valid, only the cursor was renumbered).',
    parameters: {
      limit: { type: 'number', description: 'Optional: page size (default 10, max 50).' },
      before: { type: 'string', description: 'Optional: exclusive cursor — a message id (m-<seq>); older-only page.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          remaining: { type: 'number', required: true },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                ts: { type: 'number', required: true },
                from: { type: 'string', required: true },
                to: { type: 'array', items: { type: 'string' }, required: true },
                text: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                threadId: { type: 'string' },
                sensitive: { type: 'boolean' }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        const lines = value.messages.map((message) => `- ${message.id} | ${message.from} → ${message.to.join(', ')} | ${message.text.length > 140 ? `${message.text.slice(0, 140)}…` : message.text}`)
        const head = `${value.total} total message(s) addressed to you; showing ${value.messages.length}`
        const tail = value.remaining > 0 ? `\n… (${value.remaining} older; page with before=${value.messages[value.messages.length - 1]?.id})` : ''
        return [{ type: 'text', text: lines.length === 0 ? `${head} — none.` : `${head}:\n${lines.join('\n')}${tail}` } as const]
      }
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('agent_messages requires a calling agent (exec.agent was undefined)')
      const store = await messagesStoreReady
      const memberId = busMemberIdFor(agent.id as string)
      const normalized = Math.min(Math.max(Math.trunc(args.limit ?? 10), 1), 50)
      const page = store.page(memberId, { limit: normalized, before: args.before })
      // Normalize the wire shape to the declared output schema and keep it
      // JSON-lossless (the harness serializes tool results with lossless-json,
      // which REJECTS a property whose value is `undefined`). `threadId: null`
      // is a store-internal absent marker; the tool surface exposes it as
      // ABSENT (the key is omitted entirely) — never `threadId: undefined`.
      // Same for `sensitive` (only present when a real boolean). No property
      // is ever emitted with an undefined/NaN/Infinity value.
      return {
        total: page.total,
        remaining: page.remaining,
        messages: page.messages.map((message) => {
          const item: { id: string; ts: number; from: string; to: string[]; text: string; kind: string; threadId?: string; sensitive?: boolean } = {
            id: message.id,
            ts: message.ts,
            from: message.from,
            to: message.to,
            text: message.text,
            kind: message.kind
          }
          if (typeof message.threadId === 'string') item.threadId = message.threadId
          if (typeof message.sensitive === 'boolean') item.sensitive = message.sensitive
          return item
        })
      }
    }
  })

  /** `dept_who` — the whole catalog in one call (spec §6): the B3 subtraction
   * of the board's room-who and whereami tools is LANDED (this tool is now
   * the sole roster+identity tool). `you: true` marks the caller's own entry.
   * F1 (§4.1/§5.1): the row `kind` is DERIVED — `'worker'` for a disposable
   * worker (provider:'worker'), `'head'` for a configured coordinator. F3
   * (§5.1): WORKER rows additionally carry `departmentId?`/`role?`/`jobId?`
   * (the head manages its workers by filtering departmentId), and RETIRED
   * workers stay LISTED with `retired: true` — the head's management view
   * (the LIVE catalog — busDeliverCatalog addressing — still filters them). */
  const deptWhoTool = defineTool({
    name: 'dept_who',
    description: 'List the whole Deepartments catalog — the Asistente host (kind "host", title "Asistente") and every registered department head/worker with its DERIVED kind (a configured department head is kind "head", a disposable worker is kind "worker"; title from the department configuration, PostEntry.role fallback) — each with a derived per-member life-cycle state (`running` = a turn IN FLIGHT, `idle` = resident with the turn finished, `sleeping` = sleepEpoch set, `offline` = no live session; a single coherent enum so no contradictory "live, sleeping"/"live, retired" render), the live/sleeping markers and session id, and your OWN entry marked you:true. Worker rows additionally carry departmentId/role/jobId (its department template and job link) and RETIRED workers are shown with retired:true (the head\'s management view; a retired worker is NOT addressed by the live catalog — sending to it fails per-recipient). This is the identity + roster tool: learn who exists and who you are in one call. No room parameter — the roster is the organization. The `scope` parameter selects the view: `active` (default) = non-retired rows whose state is {idle, running} PLUS your OWN (you:true) row ALWAYS (even when you are sleeping/offline/retired) — non-caller sleeping/offline rows are HIDDEN (reported via `inactiveHiddenCount`); `all` = the full superset (idle|running|sleeping|offline + retired with retired:true); `includeRetired` is the DEPRECATED COMPAT ALIAS of `all` (kept per R6 — never remove; existing callers/tests keep using it).',
    parameters: {
      scope: { type: 'string', enum: ['active', 'all', 'includeRetired'], default: 'active', description: 'Catalog scope: `active` (default) shows non-retired members whose state is idle|running plus the caller\'s own row (you:true) always; `all` shows the full roster (idle|running|sleeping|offline + retired with retired:true); `includeRetired` is the DEPRECATED COMPAT ALIAS of `all` (kept per R6 — never remove).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          members: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agentId: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                live: { type: 'boolean', required: true },
                sleeping: { type: 'boolean', required: true },
                state: { type: 'string', enum: ['running', 'idle', 'sleeping', 'offline'], required: true },
                sessionId: { type: 'string', required: true },
                you: { type: 'boolean', required: true },
                departmentId: { type: 'string' },
                role: { type: 'string' },
                jobId: { type: 'string' },
                retired: { type: 'boolean' }
              }
            }
          },
          retiredCount: { type: 'integer', required: true },
          inactiveHiddenCount: { type: 'integer', required: true }
        }
      },
      render: (_args, value) => {
        // m-64: ONE coherent per-member state token (running|idle|sleeping|offline)
        // replaces the flat `, live`/`, offline` + `, sleeping` combination, so a
        // member never renders the contradictory "live, sleeping" nor "live,
        // retired" (m-228) — `retired` and `YOU` stay as separate markers.
        const lines = value.members.map((member) =>
          `  - ${member.agentId} (${member.kind}, "${member.title}"${member.state === 'running' ? ', running' : member.state === 'idle' ? ', idle' : member.state === 'sleeping' ? ', sleeping' : ', offline'}${member.retired === true ? ', retired' : ''}${member.you ? ', YOU' : ''})`)
        const retiredCount = value.retiredCount ?? 0
        // C1 (m-264): the header adds the sleeping/offline-hidden count — the
        // NON-retired rows the DEFAULT active view hides (the caller's own
        // you:true row is always kept and never counted).
        const inactiveHiddenCount = value.inactiveHiddenCount ?? 0
        return [{ type: 'text', text: `Deepartments catalog (${value.members.length} member(s), ${retiredCount} retired, ${inactiveHiddenCount} sleeping/offline hidden):\n${lines.join('\n')}` } as const]
      }
    },
    async execute(args, exec): Promise<{ members: Array<{ agentId: string; kind: 'host' | 'head' | 'worker'; title: string; live: boolean; sleeping: boolean; state: DeptWhoState; sessionId: string; you: boolean; departmentId?: string; role?: string; jobId?: string; retired?: boolean }>; retiredCount: number; inactiveHiddenCount: number }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_who requires a calling agent (exec.agent was undefined)')
      // C1 (m-264) — the catalog scope: `active` (default) = non-retired rows
      // whose state is {idle, running} PLUS the caller's OWN row (you:true)
      // ALWAYS (even when it is sleeping/offline/retired); `all` = the full
      // superset (idle|running|sleeping|offline + retired with retired:true).
      // `includeRetired` is the DOCUMENTED COMPAT ALIAS of `all` (R6: never
      // remove — existing tests and callers keep using it).
      const scope = args.scope === 'all' || args.scope === 'includeRetired' ? 'all' : 'active'
      // B3 gap fix: caller host self-registers when no live host exists (board
      // tools are gone; the roster must show the host with you:true).
      const callerMemberId = busEnsureHostForCaller(agent as { id: string; session?: { header?: SessionHeaderWithOrigin } })
      const members: Array<{ agentId: string; kind: 'host' | 'head' | 'worker'; title: string; live: boolean; sleeping: boolean; state: DeptWhoState; sessionId: string; you: boolean; departmentId?: string; role?: string; jobId?: string; retired?: boolean }> = []
      // A5 — `retiredCount` = the retired rows the DEFAULT (active) view hides
      // (0 when scope=all/includeRetired — nothing is hidden).
      let retiredCount = 0
      // C1 — `inactiveHiddenCount` = the NON-retired rows the DEFAULT active
      // view hides because their state is sleeping/offline (the caller's own
      // you:true row is ALWAYS kept and NEVER counted).
      let inactiveHiddenCount = 0
      // C3 — ONE shared row builder for the roster AND the activeMembers echo,
      // so the echo and the default view can never diverge.
      for (const row of buildCatalogRows()) {
        const you = row.agentId === callerMemberId
        if (row.retired) {
          if (scope === 'active') {
            retiredCount++
            if (!you) continue
          }
          // all/includeRetired keeps the row (the retired:true marker is
          // conditioned below).
        } else if (scope === 'active' && (row.state === 'sleeping' || row.state === 'offline')) {
          // C1 FIX (reviewer-4 PR-A point 1): a NON-you sleeping/offline row is
          // counted AND hidden; the caller's OWN you:true row stays SHOWN but is
          // NEVER counted (the count must exclude it — see the header comment).
          if (!you) {
            inactiveHiddenCount++
            continue
          }
        }
        members.push({
          agentId: row.agentId,
          kind: row.kind,
          title: row.title,
          live: row.live,
          sleeping: row.sleeping,
          state: row.state,
          sessionId: row.sessionId,
          you,
          // F3 (§5.1) + F9: conditioned spreads — the worker extras and the
          // retired marker are never undefined; the render appends ', retired'
          // from the data field (the A-series host/worker parity).
          ...(row.departmentId !== void 0 ? { departmentId: row.departmentId } : {}),
          ...(row.role !== void 0 ? { role: row.role } : {}),
          ...(row.jobId !== void 0 ? { jobId: row.jobId } : {}),
          ...(row.retired ? { retired: true } : {})
        })
      }
      return { members, retiredCount, inactiveHiddenCount }
    }
  })

  /** The three bus tools as ONE tuple — registered in the own layer of every
   * post (installHeadBoardTools) and of host agents (agent/created hook). */
  const busTools: readonly ReturnType<typeof defineTool>[] = [sendMessageTool, agentMessagesTool, deptWhoTool]

  // --- OVERRIDE NOTE (the harness native `send_message`) ---------------------
  // `NamedEntries.insert` THROWS on a same-layer duplicate (no replace), but
  // SCOPED registrations SHADOW globals — "Scoped tools shadow globals." The
  // native (dsh-tool-subagent-control) occupies the GLOBAL name only when the
  // harness composes its row (GUI/headless profiles via dsh-base); the
  // hermetic Loader tests boot without it. Strategy:
  //   * own layer (posts via installHeadBoardTools + the host session via the
  //     agent/created hook) — ALWAYS: the harness's supported override seam;
  //     every deepartments agent sees the unified tool and the native is
  //     shadowed away (posts additionally mask globals with the lean
  //     `restrict({allow:[]})` of postSetup).
  //   * GLOBAL host plane — `send_message` ONLY when the name is free
  //     (`ctx.tools.get(...)` undefined = minimal/hermetic compositions, where
  //     ours is the only send_message; the unified body must be reachable for
  //     the host tests). `agent_messages` / `dept_who` have no native conflict
  //     and register globally ALWAYS (host plane).
  // ---------------------------------------------------------------------------
  if (ctx.tools.get('send_message') === undefined) {
    ctx.tools.register(sendMessageTool)
    ctx.logger.info('[deepartments] send_message: registered unified tool on the global host plane (no native control tool composed here)')
  } else {
    ctx.logger.info('[deepartments] send_message: native control tool owns the global name — the unified tool is delivered per-agent own-layer (scoped shadow)')
  }
  ctx.tools.register(agentMessagesTool)
  ctx.tools.register(deptWhoTool)

  // Host own layer (agent/created): register the bus tools on every host (root
  // non-post) agent so the shadow stands even where the native is global
  // ("Scoped tools shadow globals" — the harness's override seam). Transient
  // dispatched children (origin subagent) are deliberately NOT covered — they
  // stay on the native parent→child adapter the Asistente uses to steer them,
  // matching the spec's registration scope (host plane + head/worker layers).
  // Posts are skipped twice over: (1) by the origin-non-root check below and
  // (2) — defensively, for the announce-time race where byChild is not yet
  // populated — by the duplicate catch (installHeadBoardTools already
  // registered the SAME own-layer tools during setup, which runs BEFORE
  // publish/announce; a second insert of the same name in the same layer
  // throws, and that throw is exactly the already-installed signal).
  // Keyed by the AGENT OBJECT, not the session id: every announce is a fresh
  // AgentLoop incarnation with its OWN scope (incl. cold resumes), so the
  // registration must be re-established per incarnation — the previous
  // incarnation's registrations died with its scope.
  const hostBusToolsInstalled = new WeakSet<object>()
  ctx.on('agent/created', ({ agent: created }) => {
    const createdLike = created as unknown as AgentLike
    if (createdLike === void 0 || typeof createdLike.id !== 'string') return
    const header = (createdLike.session as { header?: SessionHeaderWithOrigin } | undefined)?.header
    const origin = header?.origin ?? header?.meta?.origin
    if (origin !== undefined) return // transient children keep the native adapter
    if (postIdForChild(createdLike.id) !== undefined) return // posts: own-layer from setup
    if (hostBusToolsInstalled.has(createdLike)) return
    const agentTools = (createdLike as { ctx?: { tools?: { register: (definition: ReturnType<typeof defineTool>) => unknown } } }).ctx?.tools
    if (agentTools === void 0 || typeof agentTools.register !== 'function') return // stub agents (no scoped tools) — nothing to shadow
    try {
      for (const tool of busTools) agentTools.register(tool)
      hostBusToolsInstalled.add(createdLike)
    } catch (error: unknown) {
      // Same-layer duplicate ("already registered in this scope") = the post
      // setup already installed the unified tools pre-announce — the shadow is
      // in place. Any other failure is a real registration problem: rethrow.
      if (error instanceof Error && error.message.includes('already registered')) return
      throw error
    }
  })

  // ---------------------------------------------------------------------------
  // Boot — one-time re-delivery driver for the write-ahead sidecar (spec §4.4):
  // after registries + store are up, re-run ONLY the pairs whose latest sidecar
  // status needs re-delivery (crash between persist and delivery / mid-fan-out:
  // 'prepared'; rejected delivery: 'failed'); 'delivered'/'resumed'/'self'/
  // 'terminal' are never re-run. Also compacts the sidecar at boot (keep only
  // the latest state per key) once it grows past the board compaction
  // threshold. W7-A: BEFORE re-attempting a pair, resolve the recipient against
  // the durable catalog — a DEAD/UNKNOWN recipient (removed/closed/retired
  // session) is settled as a single 'terminal' row and SKIPPED (no
  // deliverBusRecord call → no fresh 'failed'/'prepared' rows → the W6 health
  // daemon stops re-alerting every boot).
  // ---------------------------------------------------------------------------
  /** Resolve a bus recipient against the durable catalog: ALIVE if it exists as
   * a NON-RETIRED post (byPost / posts.json) OR a NON-RETIRED host
   * (hosts / hosts.json) — OR, LANE ② (fb-58 F-3), a RETIRED HOST whose
   * rotation chain still resolves a LIVE successor: the delivery engine's
   * catalog route (resolveBusCatalogRoute) re-routes the send to the live host,
   * so a pending pair to the retired id is RE-DRIVEN (re-routed to the session
   * viva) — never settled dead (the m-424/425/429 'prepared'-stuck class).
   * DEAD/UNKNOWN if neither exists, or the recipient's post/host is retired
   * with NO successor (a removed/closed session — e.g. a formerly-open
   * subagent whose session is gone). The boot re-delivery driver uses this to
   * settle dead recipients ONCE (W7-A). */
  const recipientCatalogAlive = (recipientId: string): boolean => {
    const post = byPost.get(recipientId)
    if (post !== void 0) return post.retired !== true
    const host = hosts.get(recipientId)
    if (host !== void 0) {
      if (host.retired !== true) return true
      // fb-58 F-3: a RETIRED host is reroutable while a live successor exists
      // (the spec-002 rotation chain — the same pickLiveHostEntry the engine's
      // host-family re-route uses).
      return pickLiveHostEntry(hosts.values()).live !== undefined
    }
    return false
  }
  const resolveCallerSessionIdForRedeliver = (from: string): string =>
    byPost.get(from)?.sessionId ?? hosts.get(from)?.sessionId ?? from
  const deliverBusRecordForRedeliver = (record: MessageRecord, recipientId: string, callerSessionId: string): Promise<DeliveryStatus> =>
    deliverBusRecord(record, recipientId, callerSessionId, callerSessionId)
  const redeliverDeps: DeliveryRedelivererDeps = {
    stateDir: messageStoreDir,
    logger: ctx.logger,
    recipientAlive: recipientCatalogAlive,
    // LANE ② (fb-58/B3): the re-drive machinery NEVER wakes a DORMANT
    // recipient's noWake/'prepared' queue (its intent is the next REAL wake).
    recipientDormant: isDormantRecipient,
    getRecord: async (messageId: string): Promise<MessageRecord | undefined> =>
      (await messagesStoreReady).get(messageId),
    resolveCallerSessionId: resolveCallerSessionIdForRedeliver,
    deliver: deliverBusRecordForRedeliver
  }
  // FASE 2.6-C: consume the boot re-delivery driver from the dshd-core bus
  // service when composed (the store + getRecord are bound internally by the
  // shell); fall back to the in-bundle DeliveryRedeliverer in a minimal
  // composition (dshd-core absent) — behavior-neutral.
  const redeliverPendingDeliveries = (ctx.get('deepartments.bus') as BusSurface | undefined)?.redeliver({
    recipientAlive: recipientCatalogAlive,
    recipientDormant: isDormantRecipient,
    resolveCallerSessionId: resolveCallerSessionIdForRedeliver,
    deliver: deliverBusRecordForRedeliver
  }) ?? new DeliveryRedeliverer(redeliverDeps)

  /** LANE ② (incident-delivery 2026-09-03, item 2+fb-79) — the NON-BOOT
   * re-delivery SWEEP timer: the failed/prepared pairs previously re-drove
   * ONLY at boot (the 14 lost messages of 09-03 re-entered on the first boot
   * post-restart; the gate-clean recovery depended on a restart). A bounded
   * `setInterval` (default 60 s — ONE sweep per health poll tick; unref'd +
   * disposed by the ctx.effect so it never holds the process, exactly the
   * daemon-wiring discipline) re-drives the DUE pairs — with the per-pair
   * exponential backoff + max-attempts stop inside `sweepDue` — so a gate
   * clean-up reaches the pending pairs with NO restart and NO storm. The
   * `health.redeliverySweepIntervalMs` knob (absent → the 60 s default). */
  const startRedeliverySweep = (): void => {
    const intervalMs =
      typeof config.health?.redeliverySweepIntervalMs === 'number' && Number.isFinite(config.health.redeliverySweepIntervalMs) && config.health.redeliverySweepIntervalMs > 0
        ? config.health.redeliverySweepIntervalMs
        : RE_DELIVERY_SWEEP_DEFAULT_INTERVAL_MS
    const handle = setInterval(() => {
      void redeliverPendingDeliveries.sweepDue()
    }, intervalMs)
    if (typeof (handle as { unref?: () => unknown }).unref === 'function') (handle as { unref: () => unknown }).unref()
    ctx.effect(() => () => clearInterval(handle), 'deepartments: redelivery sweep')
    ctx.logger.info(`[deepartments] redelivery sweep armed (every ${intervalMs} ms; non-boot re-drive of prepared/failed pairs with per-pair backoff + max-attempts)`)
  }
  // The sweep is armed RIGHT HERE, synchronously in the apply fiber (the
  // ctx.effect disposable requires the fiber — calling it from the async boot
  // continuation below would throw INACTIVE_EFFECT): the interval is unref'd
  // and its FIRST fire is one cadence away (default 60 s), which is always
  // after the registries/store have cold-loaded; an empty sidecar sweep is a
  // no-op. It re-drives the DUE failed/prepared pairs WITHOUT a restart.
  startRedeliverySweep()

  // FASE 2.6-C: LATE-BIND the bundle's closure-bound bucket-(c) deps into the
  // dshd-core service shells. EVERY closure the lazy builders need is defined by
  // this point (the wake-relay maps, the framing/user-message helpers, the live
  // identity resolvers, the tool/daemon wiring). The deps are passed BY
  // REFERENCE (live closures) so the core service shells mutate the SAME maps /
  // sets / registries the tools and daemons read. Guarded: `binder` is
  // undefined in a minimal composition (dshd-core absent), making this a
  // behavior-neutral NO-OP for the bundle-alone suite.
  //
  // DECOUPLING PASO 1 (gui → dshd-gui): the RPC channel the bundle mounts
  // inline below now feeds the `gui` Binder buckET instead of the direct
  // closure: the endpointDeps wiring (the DEEPARTMENTS endpoint deps: the live
  // registries + the bundle-owned pure deps buildAgentRows/pickLiveHostEntry +
  // the presence/journal hooks) is REGISTERED here so the composed dshd-gui
  // plugin's `deepartments.gui` SERVICE (lazy, fail-loud R1 when the bucket is
  // absent) provides the channel surface; the bundle's webServer MOUNT effect
  // below consumes that service. The construction is closure-bound to the apply
  // fiber (byPost/hosts/agents/presence), exactly like the other buckets.
  const guiEndpointDeps: DeepartmentsEndpointDeps = {
    departments: org.departments,
    // dshd-gui phase: the deps interface is owned by the dshd-gui package (its
    // structural EndpointPostEntryLike mirror is the cast target — the live
    // registry type is the bundle's richer PostEntry).
    byPost: byPost as unknown as Map<string, EndpointPostEntryLike>,
    // U3 fix (reviewer 2026-08-22): `Map.values()` returns a SINGLE-USE
    // iterator, and the deps object is shared for the process lifetime. The
    // host/status builder iterates `deps.hosts` up to 3× (pick, candidates
    // spread, retired loop) and agents/list iterates it again, so a bare
    // `hosts.values()` was exhausted by the FIRST call (retired degraded to
    // []) and every later call saw zero hosts. Re-iterable wire: EVERY
    // `[Symbol.iterator]` call returns a FRESH iterator over the live content.
    hosts: { [Symbol.iterator]: (): Iterator<HostEntryLike> => hosts.values() as Iterator<HostEntryLike> },
    sessionLive: (sid) => agents !== void 0 && agents.get(SessionId(sid)) !== undefined,
    sessionRunning: (sid) => agents !== void 0 && agents.get(SessionId(sid))?.status === 'running',
    // dshd-gui phase: the two bundle-owned PURE deps the dispatcher's
    // agents/list + host/status branches need — injected here exactly like the
    // sessionLive/unread signals (the package has no bundle import).
    buildAgentRows,
    pickLiveHostEntry,
    // U3: the live host's journal wake_counter for the `host/status` payload.
    // Best-effort and NEVER throwing — an unreadable journal simply omits the
    // field (the payload contract stays minimal and stable).
    loadHostWakeCounter: async (hostId) => {
      try {
        const text = await readFile(journalPathFor(hostId), 'utf8')
        const counterMatch = text.match(/^wake_counter:\s*(\d+)/m)
        return counterMatch !== null ? Number(counterMatch[1]) : undefined
      } catch {
        return undefined
      }
    },
    // U3 fix: ambiguity warn for live-host selection (post-mortem finding #2).
    logger: ctx.logger,
    // Feature A — owner-presence read/write + host-change notify. The read
    // refreshes the synchronous cache (so a `presence/get` reflects the
    // current file AND keeps the guard/pre-step cache current); the write
    // persists atomically via the wrapping savePresence (never throws — an
    // RPC never fails on a persist error). The notify is the fire-and-forget
    // HOST followup (A3/A4), fired by the dispatch only on a real CHANGE.
    presenceState: async () => {
      refreshPresence()
      return { present: presenceCache.present, ...(presenceCache.updatedAt === undefined ? {} : { updatedAt: presenceCache.updatedAt }) }
    },
    savePresenceState: async (state) => savePresence(state),
    notifyPresenceChange: (present) => notifyHostPresence(present),
    // W1 — `agenda/list`: read the jobs from the repo tree (default jobDir
    // resolution via the apply scope repoRoot) and the runtime calendar from
    // the shared stateDir. The clock picks the live next-due snapshot.
    repoRoot,
    calendarStateDir: stateDir,
    now: () => Date.now()
  }

  // DECOUPLING PASO 1 (daemons → dshd-jobs / dshd-health): the scheduler +
  // system-health tick CLOSURES the daemon effects consume are HOISTED to the
  // apply scope so they can be registered in the `jobs`/`health` Binder
  // buckets (the composed services read them at use; fail-loud R1 when the
  // bucket is absent — the contract lock). The daemon effects below resolve
  // the composed SERVICE and call it per interval, falling back to the SAME
  // closures inline when the service is absent (minimal composition / bundle-
  // alone suite — R6 behavior-neutral). All deps these closures capture
  // (byPost, hosts, org, messagesStoreReady, busDeliverToPost/Host,
  // runJobForDepartment, captureSchedulerAutoRunFailure, deliverDaemonNotice,
  // the health builders) are defined by this point.
  const schedulerHeadForDepartment = (department: DepartmentConfig): string | undefined => department.coordinator?.postId
  const schedulerRunJob = async (department: DepartmentConfig, headPostId: string, jobId: string): Promise<boolean> => {
    const headEntry = byPost.get(headPostId)
    if (headEntry === void 0) {
      await captureSchedulerAutoRunFailure({ stateDir: stateDir, now: () => Date.now(), jobId, reason: 'no head', error: 'no head' })
      return false
    }
    try {
      await runJobForDepartment(department, headEntry, jobId, { callerSessionId: headEntry.sessionId })
      return true
    } catch (error: unknown) {
      const errorText = error instanceof Error ? error.message : String(error)
      const reason = /job already running/.test(errorText) ? 'idempotency-skip' : errorText
      await captureSchedulerAutoRunFailure({ stateDir: stateDir, now: () => Date.now(), jobId, reason, error: errorText })
      ctx.logger.warn(`[deepartments] scheduler: job "${jobId}" could not run (${errorText}) — skip`)
      return false
    }
  }
  const schedulerOnAutoRunSkip = async (finding: SchedulerAutoRunFinding): Promise<void> => {
    if (finding.reason !== 'no head') return
    await captureSchedulerAutoRunFailure({ stateDir: stateDir, now: () => Date.now(), jobId: finding.jobId, reason: 'no head', error: 'no head' })
  }
  const schedulerNotifyHead = async (headPostId: string, message: string): Promise<void> => {
    try {
      const headEntry = byPost.get(headPostId)
      if (headEntry === void 0) return
      const store = await messagesStoreReady
      const record = await store.append({ from: 'deepartments', to: [headPostId], text: `Agenda notice: ${message}`, kind: 'agent' })
      const outcome = await deliverDaemonNotice(headEntry, record, `[From deepartments → ${headPostId}]: Agenda notice: ${message}`, busDeliverToPost)
      if (outcome === 'queued') ctx.logger.info(`[deepartments] scheduler: agenda notice to "${headPostId}" queued (head is dormant — no wake)`)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] scheduler: agenda notice to "${headPostId}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const schedulerDepartmentForEntry = (entry: { createdBy?: string }): DepartmentConfig | undefined => {
    const creator = byPost.get(entry.createdBy ?? '')
    return creator === void 0 ? undefined : departmentForEntry(creator)
  }
  const schedulerDepartmentForJob = (jobId: string): DepartmentConfig | undefined => {
    for (const department of org.departments) {
      const jobDir = jobDirFor(repoRoot, department)
      if (existsSync(path.join(jobDir, `${jobId}.md`))) return department
    }
    return undefined
  }
  // W6 system-health: the per-tick LIVE input BUILDERS (catalog posts, host
  // running signal, session-context rows, host-wait rows) + the ALERT delivery
  // closure + the per-daemon C6 tail reader — hoisted so the `health` bucket
  // carries them (the composed dshd-health service runs the SAME tick with the
  // SAME inputs). The builders read the LIVE registries per call (fresh per
  // tick); the notifyHost is the C8 direct ALERT seam (store.append +
  // busDeliverToHost, interrupt:true — never a delivery-engine row).
  const buildHealthPosts = (): PostActivityInput[] => {
    const { inboxTsByPost } = readInboxByPost(stateDir, '', Date.now(), HEALTH_ERROR_WINDOW_MS)
    const out: PostActivityInput[] = []
    for (const [postId, entry] of byPost) {
      const live = agents?.get(entry.sessionId)
      out.push({
        postId,
        sessionId: entry.sessionId,
        retired: entry.retired === true,
        running: live !== undefined && live.status === 'running',
        // rc.1+ surface: the full-log read is `snapshotEvents()` (the `events`
        // getter is gone from 0.1.2-rc.1 on; the envelope cast still holds).
        events: (live?.session?.snapshotEvents() ?? []) as HealthSessionEvent[],
        inboxTs: inboxTsByPost.get(postId) ?? [],
        sleeping: entry.sleepEpoch !== void 0,
        provider: entry.provider,
        ...(agents !== void 0 ? { hasLiveHandle: live !== undefined } : {})
      })
    }
    return out
  }
  const buildHostRunning = (): boolean | undefined => {
    if (agents === void 0) return undefined
    for (const entry of hosts.values()) {
      if (entry.retired === true) continue
      if (agents.get(SessionId(entry.sessionId))?.status === 'running') return true
    }
    return false
  }
  const healthSessionProjections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
  const buildSessionContexts = (): SessionContextInput[] | undefined => {
    if (healthSessionProjections === undefined) return undefined
    const rowOf = (session: unknown, id: { postId?: string; hostId?: string }): SessionContextInput | undefined => {
      const snap = healthSessionProjections.snapshot(session)
      const view = snap?.values?.contextPressure
      if (view === undefined || typeof view !== 'object') return undefined
      const v = view as { contextWindow?: unknown; pressureTokens?: unknown; projectedTokens?: unknown }
      return {
        ...id,
        ...(typeof v.contextWindow === 'number' && Number.isFinite(v.contextWindow) ? { contextWindow: v.contextWindow } : {}),
        ...(typeof v.pressureTokens === 'number' && Number.isFinite(v.pressureTokens) ? { pressureTokens: v.pressureTokens } : {}),
        ...(typeof v.projectedTokens === 'number' && Number.isFinite(v.projectedTokens) ? { projectedTokens: v.projectedTokens } : {})
      }
    }
    const out: SessionContextInput[] = []
    for (const [postId, entry] of byPost) {
      if (entry.retired === true) continue
      const live = agents?.get(entry.sessionId)
      if (live?.session === undefined) continue
      const row = rowOf(live.session, { postId })
      if (row !== undefined) out.push(row)
    }
    for (const entry of hosts.values()) {
      if (entry.retired === true) continue
      const live = agents?.get(entry.sessionId)
      if (live?.session === undefined) continue
      const row = rowOf(live.session, { hostId: entry.hostId })
      if (row !== undefined) out.push(row)
      break
    }
    return out
  }
  const buildHostWaits = (): HostWaitPostInput[] => {
    const { live } = pickLiveHostEntry(hosts.values())
    if (live === undefined) return []
    const nowMs = Date.now()
    const { hostRowsByPost } = readInboxByPost(stateDir, live.hostId, nowMs, HEALTH_ERROR_WINDOW_MS)
    const out: HostWaitPostInput[] = []
    for (const [postId, entry] of byPost) {
      const liveAgent = agents?.get(entry.sessionId)
      out.push({
        postId,
        retired: entry.retired === true,
        // rc.1+ surface: `snapshotEvents()` replaces the removed `events` getter.
        events: (liveAgent?.session?.snapshotEvents() ?? []) as HealthSessionEvent[],
        hostMessages: hostRowsByPost.get(postId) ?? [],
        sleeping: entry.sleepEpoch !== void 0
      })
    }
    return out
  }
  const healthNotifyHost = async (hostEntry: HostEntryLike, alertFrame: string): Promise<void> => {
    try {
      const store = await messagesStoreReady
      const record = await store.append({ from: 'deepartments', to: [hostEntry.hostId], text: alertFrame, kind: 'agent' })
      await busDeliverToHost(hostEntry as HostEntry, alertFrame, record, void 0, { interrupt: true })
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] system-health: host alert delivery failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const healthPoolerStatePath = config.health?.poolerStateFilePath !== undefined && config.health.poolerStateFilePath.trim() !== ''
    ? config.health.poolerStateFilePath
    : path.join(dshHome(), POOLER_STATE_FILE)
  const healthBootId = randomUUID()


  // --- tool definitions (shared by the GLOBAL host plane and the child's OWN
  // layer so a lean toolFilter still exposes them to resident posts) ---------

  if (subagents === void 0) {
    ctx.logger.warn('[deepartments] subagents service absent: the messaging toolset will not be installed into continuable children (host-plane tools may still fail at use if the services are absent)')
  }

  // --- global (host-plane) tools: registered once on the plugin ctx so the
  // HOST Asistente (and every agent) sees them. Registered as a reversible
  // effect so HMR unloads them cleanly. ---

  // Batch W4 P1 — ON-DEMAND wake-context snapshot (host plane): the live-
  // freshness counterpart of the host wake injection. Returns identity, the
  // message delta (latest received) and the condensed roster in ONE call using
  // the SAME pure `buildWakePack` builder. B3 cutover: no rooms, no board
  // cursor — the snapshot is the messaging-delta + roster.
  const globalWakeSnapshot = ctx.tools.register(defineTool({
    name: 'dept_wake_snapshot',
    description: 'On-demand Deepartments wake-context snapshot (host plane): returns, in ONE call and as text, your identity, the message delta (your latest-received messages, capped N) and the condensed roster (registered posts/hosts with their durable registry sleeping flags). It NEVER embeds live session liveness — a stale liveness claim is worse than one dept_who, so liveness stays on-demand via dept_who. This is the live-freshness counterpart of the automatic host wake context pack; for LIVE needs the pack cannot cache (true session liveness, full message text), call dept_who / agent_messages. Does not advance anything.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          snapshot: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.snapshot } as const]
    },
    async execute(_args, exec): Promise<{ snapshot: string }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_wake_snapshot requires a calling agent (exec.agent was undefined)')
      const sessionId = agent.id as string
      const hostId = hostIdForSession(sessionId)
      const snapshot = await wakePackService.assembleWakeSnapshot(hostId)
      return { snapshot }
    }
  }))

  const globalRetire = ctx.tools.register(postRetireTool)

  // --- Batch G: memo (journal) and sleep (dormir) — host plane --------------
  // The owner's lifecycle model: department heads are PERMANENT agents that go
  // IDLE (wait, keeping their context; the default concluded state is already
  // an inactive-but-resumable continuable — the wake relay re-wakes them
  // regardless) or SLEEP (dormir — persist memory to a journal then reset the
  // context window; a fresh incarnation reloads the journal on the next wake).
  // dept_memo_write persists the head's long-term memory to its journal;
  // dept_sleep requires a prior memo, marks the post (sleepEpoch), and the
  // relay re-materializes it fresh.

  const globalMemo = ctx.tools.register(memoWriteTool(true))

  const globalSleep = ctx.tools.register(sleepTool(true))

  // --- B1: org-wide quiet-sleep orchestration (host plane) -------------------
  // LOTE A (owner decision 2026-08-27): head/worker sleep is RETIRED — heads
  // and workers stay `idle|running` permanently. `dept_sleep_all` remains
  // REGISTERED host-plane as a documented NO-OP (R6 — never remove; the harness
  // lifecycle service `sleepAll` stays as dead code in lifecycle.ts). It emits
  // a warn and returns `{slept: 0, skipped: 0}` — it never marks, never
  // persists, never disposes. The HOST's single-agent dept_sleep (spec 002
  // rotation) is UNTOUCHED.
  const globalSleepAll = ctx.tools.register(defineTool({
    name: 'dept_sleep_all',
    description: 'Retired orchestration tool (host plane) — a NO-OP since 2026-08-27 (LOTE A: head/worker sleep removed; heads and workers are permanent `idle|running`). Kept registered for R6 compatibility: calling it warns and returns {slept: 0, skipped: 0}. The single-agent host dept_sleep (spec 002 session rotation) is the only remaining sleep path.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slept: { type: 'number', required: true },
          skipped: { type: 'number', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `dept_sleep_all is a NO-OP since 2026-08-27 (head/worker sleep retired): ${value.slept} slept, ${value.skipped} skipped (nothing done — only the host dept_sleep rotation remains, spec 002)` } as const]
    },
    async execute(_args, exec): Promise<{ slept: number; skipped: number }> {
      // No-op with warn (R6): the batch orchestration is retired — heads stay
      // idle|running; sleepAll remains as dead code in lifecycle.ts.
      ctx.logger.warn('[deepartments] dept_sleep_all is a NO-OP since 2026-08-27 (LOTE A): head/worker sleep retired — heads and workers stay idle|running; only the host dept_sleep rotation remains (spec 002)')
      return { slept: 0, skipped: 0 }
    }
  }))

  // --- M-A: dept_head_rotate (HOST plane) — the ACTIVE CONTEXT REFRESH of a
  // configured department head -----------------------------------------------
  // The rotation = a session refresh WITH JOURNAL (micro-decision owner
  // 2026-08-28, map reports/explore-deep/2026-08-28-ma-context-monitor-map.md
  // §3): bounded-dispose the old live handle → server-side archive the old
  // session (S2.5) → FRESH-MINT a NEW session SEEDED with the head's LAST
  // DURABLE journal (buildHeadRotationSeed — NO re-key: the head's journal
  // author is its STABLE postId) + the department title pin → mirror the event
  // to the QD ('head-rotated', the host-rotated pattern — inspected at 100%;
  // the QH's own rotation is NOT excluded: the old 'head-slept' exclusion was
  // the SLEEP anti-loop, a one-shot instruction rotation cannot loop).
  // NOT sleep (no sleepEpoch is set) and NOT retire (the postId stays live):
  // a rotation only refreshes the underlying session/context. The fresh head
  // lands LIVE but BOOT-QUIET — NO immediate wake (deliberate: heads are
  // addressed-driven; the host greets the fresh head with its substantive
  // message right after, and that next message / the next daemon wake starts
  // its first turn with the journal already in the seed + the wake pack
  // injected at pre-step). Scope: host-only (a head cannot rotate), configured
  // heads only (a worker / unconfigured post rejects loudly), idle only (a
  // RUNNING head is rotated in a free window, never mid-turn).
  const globalHeadRotate = ctx.tools.register(defineTool({
    name: 'dept_head_rotate',
    description: 'Rotate a CONFIGURED department head (HOST plane, Asistente only): an ACTIVE context refresh — the head\'s durable session is fresh-minted (NEW session id) seeded with its LAST durable journal, the old session is archived server-side, and the department title stays pinned; the postId/identity, journal and messages are untouched (archive ≠ delete) and NO sleepEpoch is set (a rotation is NOT sleep). The fresh head lands LIVE but BOOT-QUIET: its first turn starts on the NEXT message/daemon wake (the journal is already in its context as the seed). Use it on CONTEXT-THRESHOLD crossing (>= 50% of the window, e.g. the QH) or on instruction; confirm the head is IDLE first (dept_who) — a running head is rejected loudly. The LAST durable journal is ALWAYS used and the rotation NEVER delays for a fresh memo (the critical-unblock rule — a context-blocked head may not run dept_memo_write): ask the head for dept_memo_write BEFORE rotating when it is operative and the window permits, and watch the returned `journal.stale` marker ("memo no actualizado — journal previo"). Emits a Quality-inspect directive to quality-head (100% mandate).',
    parameters: {
      postId: { type: 'string', required: true, description: 'The CONFIGURED department head postId to rotate (e.g. "quality-head", "internal-programming-head"). A worker or an unconfigured post is rejected loudly.' },
      reason: { type: 'string', description: 'Optional reason for the rotation (recorded in the log + the QD mirror).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          postId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          previousSessionId: { type: 'string', required: true },
          archived: { type: 'boolean', required: true },
          journal: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              timestamp: { type: 'string' },
              stale: { type: 'boolean', required: true }
            }
          },
          reason: { type: 'string' },
          // fb-25 (a): the reason CROSS-CHECK stamp ('verified' | 'unverified' |
          // 'unavailable') — the reason figure vs the OLD session's real usage.
          reasonVerified: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `rotated ${value.postId}: ${value.previousSessionId} → ${value.sessionId} (archived ${value.archived}); journal ${value.journal.path}${value.journal.stale ? ' STALE — memo no actualizado, journal previo' : ' (fresh)'}${value.reason !== undefined ? `; reason: ${value.reason}` : ''}${value.reasonVerified !== undefined ? `; reason verified: ${value.reasonVerified}` : ''}` } as const]
    },
    async execute(args, exec): Promise<{ postId: string; sessionId: string; previousSessionId: string; archived: boolean; journal: { path: string; timestamp?: string; stale: boolean }; reason?: string; reasonVerified: ReasonVerificationStamp }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_head_rotate requires a calling agent (exec.agent was undefined)')
      // ACL (map §3): HOST-plane — only the Asistente itself (no registered
      // post) rotates heads; a department head can never rotate (it routes the
      // need to its own head, which escalates to the host).
      if (postIdForChild(agent.id as string) !== undefined) {
        throw new Error('[deepartments] dept_head_rotate is HOST-plane (the Asistente only): a department head cannot rotate heads — ask the host via your head')
      }
      const entry = byPost.get(args.postId)
      if (entry === void 0) throw new Error(`[deepartments] dept_head_rotate: "${args.postId}" is not a registered post`)
      // Scope: a WORKER is never rotatable (its lifecycle is create → retire).
      if (entry.provider === 'worker') {
        throw new Error(`[deepartments] dept_head_rotate: "${args.postId}" is a WORKER, not a head — workers are NOT rotatable (retire them with dept_worker_retire / dept_post_retire)`)
      }
      // Scope: only CONFIGURED heads (a coordinator row). The QH is rotatable —
      // it is the FIRST to rotate in the critical unblock (the old QH exclusion
      // was the dept_sleep anti-loop; a one-shot instruction rotation cannot loop).
      const coordinator = coordinatorForPost(args.postId)
      if (coordinator === void 0) {
        throw new Error(`[deepartments] dept_head_rotate: "${args.postId}" is not a CONFIGURED department head (no coordinator row in the org config)`)
      }
      const sessionId = String(SessionId(entry.sessionId))
      // Free-window rule (map §3 step 2): a RUNNING head is never rotated
      // mid-turn — the host schedules the rotation when the head is idle.
      const live = agents?.get(sessionId)
      if (live !== undefined && live.status === 'running') {
        throw new Error(`[deepartments] dept_head_rotate: "${args.postId}" is RUNNING (state ${live.status}) — rotate only in a free window (head idle; re-check dept_who)`)
      }
      // Journal — CRITICAL-UNBLOCK RULE: always use the LAST durable journal,
      // never delay for a fresh memo (a context-over-threshold head — the QH
      // — may be unable to run dept_memo_write; the rotation must still go
      // through). A MISSING journal fails loud (the dept_sleep precedent:
      // a rotation without continuity would lose the head's memory).
      const journal = await readJournal(args.postId)
      if (journal === void 0 || journal.trim() === '') {
        throw new Error(`[deepartments] dept_head_rotate: no durable journal for "${args.postId}" (${journalPathFor(args.postId)}) — request a dept_memo_write first, then rotate`)
      }
      const journalStatus = headRotationJournalStatus(journal, Date.now())
      // Bounded dispose of the old live handle (a zombie detach self-heals; the
      // fresh mint uses a NEW session id, no collision).
      if (!(await joinHeadDisposeOnce(sessionId))) {
        ctx.logger.warn(`[deepartments] dept_head_rotate: dispose join for "${args.postId}" timed out after ${disposeJoinTimeoutMs()}ms — proceeding with the fresh mint (zombie detach; new session id, no collision)`)
      }
      // Server-side archive of the OLD session (S2.5 semantics — the sidebar
      // row hides; the journal + messages stay intact). Non-fatal.
      const archived = await archivePostSessionOnSleep(sessionId)
      // FRESH-MINT: NEW session + LAST journal as the seed + department title pin.
      const dept = departmentForEntry(entry)
      const title = coordinator.sessionTitle || HEAD_DEFAULT_SESSION_TITLE
      const seed = buildHeadRotationSeed(journal, { title, now: Date.now() })
      const fresh = await freshMintHead(entry, dept, { seed, source: 'dept_head_rotate' })
      // fb-25 (a): the reason CROSS-CHECK — the figure the caller's reason cites
      // is contrasted against the OLD session's REAL usage (the durable
      // session_projcache.json row of the token-meter, resolved like the web-UI
      // cleanup wiring). NEVER BLOCKS: any failure/absence → 'unavailable' and
      // the rotation proceeds (critical-unblock rule — the archive/mirror is
      // cosmetic and never a requirement); a missing reason → 'unavailable'
      // (nothing to verify). The stamp rides the mirror AND the tool result so
      // the QH/inspectors and the host see an unverified figure as such.
      const persistence = ctx.get('sessionPersistence') as { root?: string } | undefined
      const projCachePath = resolveSessionProjCachePath(stateDir, persistence?.root)
      const reasonVerified = verifyRotateReason(args.reason, sessionId, projCachePath)
      // QD mirror (spec 007 §6.3, D-Q3 — the host-rotated pattern): a head
      // rotation is inspected at 100%. Non-fatal (the emitter wraps itself).
      await maybeEmitQualityInspectDirective({
        kind: 'head-rotated',
        headPostId: args.postId,
        oldSessionId: sessionId,
        newSessionId: String(fresh.id),
        archiveOk: archived,
        reasonVerified,
        ...(args.reason !== undefined ? { reason: args.reason } : {})
      })
      ctx.logger.info(`[deepartments] dept_head_rotate: "${args.postId}" rotated ${sessionId} → ${String(fresh.id)} (${args.reason ?? 'no reason given'}, reason verified ${reasonVerified}); journal ${journalStatus.stale ? 'STALE — memo no actualizado, journal previo' : 'fresh'} seeded; fresh head live BOOT-QUIET (first turn on the next message/daemon wake)`)
      return {
        postId: args.postId,
        sessionId: String(fresh.id),
        previousSessionId: sessionId,
        archived,
        journal: { path: journalPathFor(args.postId), ...(journalStatus.timestamp !== undefined ? { timestamp: journalStatus.timestamp } : {}), stale: journalStatus.stale },
        reasonVerified,
        ...(args.reason !== undefined ? { reason: args.reason } : {})
      }
    }
  }))

  // --- dshd-feedback tools (host plane): the host may emit feedback + list +
  // update the backlog. Registered globally (the host is every agent's top of
  // the reporting chain — D6); the QH-authority is enforced in `execute`.
  const globalFeedback = ctx.tools.register(feedbackTool)
  const globalFeedbackList = ctx.tools.register(feedbackListTool)
  const globalFeedbackUpdate = ctx.tools.register(feedbackUpdateTool)

  ctx.effect(() => () => {
    globalFeedback()
    globalFeedbackList()
    globalFeedbackUpdate()
    globalWakeSnapshot()
    globalRetire()
    globalMemo()
    globalSleep()
    globalSleepAll()
    globalHeadRotate()
  }, 'deepartments: host-plane tools')

  // =========================================================================
  // LANE DI-BY-SERVICES (FASE 2 — the DEATH of the binder REGISTER). The
  // legacy 9-bucket binder register call (the 5 baseline: bus /
  // deliver / wakepack / lifecycle / redeliver + the 4 zone: gui / jobs /
  // health / pooler) is DEAD — DELETED in this lane (it was RE-HOMED out of
  // the frozen CUT-4 zone in LANE 0.2.3b and is now gone). The 5 BASELINE
  // closure sets now flow into the DI-by-services deps HOLDERS that dshd-core
  // provides (`deepartments.lifecycleDeps` / `wakepackDeps` / `busDeps` /
  // `deliverDeps` — FASE 1 added them + the content-aware dual-read; the dshd-
  // core lazy shells read holder-first, FASE 2 holder-only): the SAME closures,
  // the SAME order, the SAME targets — 0 behavior change, P1 intact (the
  // bundle WRITES the holders, never provides them). The 4 ZONE buckets were
  // already dead weight (the P1 services read their own holders) + their R6
  // fallback readers re-apearon to the baseline holders in FASE 2, so nothing
  // reads the dead binder buckets anymore — MutableBinder / the late-binding
  // seam / BinderDeps die with this lane (mirror-hybrids-r4-map §4.2).
  const depsBus = ctx.get('deepartments.busDeps') as { register(deps: unknown): void; clear(): void } | undefined
  const depsDeliver = ctx.get('deepartments.deliverDeps') as { register(deps: unknown): void; clear(): void } | undefined
  const depsLifecycle = ctx.get('deepartments.lifecycleDeps') as { register(deps: unknown): void; clear(): void } | undefined
  const depsWakepack = ctx.get('deepartments.wakepackDeps') as { register(deps: unknown): void; clear(): void } | undefined
  depsBus?.register({ redeliver: { recipientAlive: recipientCatalogAlive, resolveCallerSessionId: resolveCallerSessionIdForRedeliver, deliver: deliverBusRecordForRedeliver } })
  depsDeliver?.register({
    resolveChild: resolveBusChild,
    deliverChild: deliverBusChild,
    resolveCatalogRoute: resolveBusCatalogRoute,
    busProfileFor,
    deliverPost: busDeliverToPost,
    deliverHost: busDeliverToHost
  })
  depsWakepack?.register({
    refreshPresence,
    wakePackInjected,
    deferredSleepReplace,
    roleForSession: roleForSessionLive,
    buildSubagentOrientation,
    computeHostSleepSurfacePlan,
    assembleHeartbeat,
    readPresenceStateFile,
    messagesStoreReady: () => messagesStoreReady,
    repoRoot
  })
  depsLifecycle?.register({
    ensureHost,
    writeJournal,
    readJournal,
    bumpHostSleepCounter,
    bumpPostSleepCounter,
    archivePostSessionOnSleep,
    disposeHeadHandleOnce,
    maybeEmitQualityInspectDirective,
    // fb-11 — the ROTATION-SUCCESSOR AUTO-WAKE seam (the dshd-core lazy
    // lifecycle reads it from this bucket; OPTIONAL there, provided here).
    enqueueHostWake,
    deferredSleepReplace,
    wakePackInjected
  })
  // =========================================================================

  // LANE 2 (fb-27, QD ALTO/mejora) — the turn/end-ERROR HEAD NOTIFICATION
  // closure the health daemon tick's `notifyHead` dep calls. Resolves the POST'S
  // OWN HEAD (a worker's creator `managerId`, or its department coordinator)
  // and delivers `[From deepartments] Turn-error <cls> …` to it via
  // store.append + busDeliverToPost — the daemon→head pattern (delivery.ts:1171),
  // NOT deliverDaemonNotice (which respects sleepEpoch='queued' and belongs to
  // the scheduler/parallel paths). An unresolved head → conservative no-op
  // (never fabricated). NEVER throws. (Defined OUTSIDE the frozen CUT-4 zone so
  // the tools-factory byte-identical md5 lock is untouched.)
  const healthNotifyHead = async (postId: string, frame: string): Promise<void> => {
    try {
      const entry = byPost.get(postId)
      if (entry === void 0) return
      let headId = entry.managerId
      if (headId === void 0 || headId === '' || !byPost.has(headId)) {
        const department = departmentForEntry(entry)
        headId = department?.coordinator?.postId
      }
      if (headId === void 0 || headId === '' || !byPost.has(headId)) return
      const headEntry = byPost.get(headId)
      if (headEntry === void 0) return
      const store = await messagesStoreReady
      const record = await store.append({ from: 'deepartments', to: [headId], text: frame, kind: 'agent' })
      await busDeliverToPost(headEntry, frame, record, void 0)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] system-health: turn-error head notification for "${postId}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // LANE 0.2.1 (1B/1C — binder → Service, P6 disposability, gap 1): the four
  // zone dep sets now flow into PER-PACKAGE deps holders — deepartments.healthDeps /
  // jobsDeps / poolerDeps / guiDeps, PROVIDED by dshd-health / dshd-jobs /
  // dshd-pooler / dshd-gui (the "one plugin provides its deps" pattern) and
  // FILLED here by the bundle via `register` (the bundle still fills, the
  // packages only expose the holder — 0 ctx.provide preserved, P1). 1C:
  //   - health binds ONLY qiDirectiveRate (the shared quality dice the lane
  //     does NOT touch; gap 2 makes it a policy service) — the rest is
  //     derivable: config → the package row, notifyHost → the composed
  //     bus+deliver fallback, bootId → the package randomUUID, the paths → the
  //     daemon wiring passes them explicitly (invoke.ts);
  //   - the pooler bind is FULLY ELIMINATED (configuredProviders is 100%
  //     org-derivable — the coordinators carry the SAME opencode-zen provider
  //     as the WORKER/HOST_AGENT_OPTIONS constants — + appendPostError is
  //     imported by the package directly from dshd-health) → poolerDeps stays
  //     unfilled (the holder is the uniform 1B surface; nothing to relocate).
  // The 4 ZONE holders (LANE 0.2.1 — the P1 services' PRIMARY path) stay as
  // they were: the bundle fills them via register, the unload effect clears
  // them. The FASE-2 register death left the ZONE baseline buckets to die with
  // MutableBinder — the P1 services read their holders (verified — the 4 zone
  // buckets were dead weight since 0.2.1/0.2.3, the R6 fallback readers were
  // re-pointed to the baseline holders in this lane). The DI-by-services
  // holders are filled above; this unload effect releases ALL of them (P6).
  const depsHealth = ctx.get('deepartments.healthDeps') as { register(deps: { qiDirectiveRate?: number }): void; clear(): void } | undefined
  const depsJobs = ctx.get('deepartments.jobsDeps') as {
    register(deps: { runJob?: unknown; notifyHead?: unknown; departmentForEntry?: unknown; departmentForJob?: unknown; onAutoRunSkip?: unknown; captureAutoRunFailure?: unknown; repoRoot?: string }): void
    clear(): void
  } | undefined
  const depsPooler = ctx.get('deepartments.poolerDeps') as { register(deps: unknown): void; clear(): void } | undefined
  const depsGui = ctx.get('deepartments.guiDeps') as { register(deps: { endpointDeps?: unknown }): void; clear(): void } | undefined
  // The fills (the re-homed register + these holders carry the SAME closures —
  // the packages read the IDENTICAL live values through their holders; the
  // compose-first rows make each holder resolvable exactly when the
  // closure-bound state is ready).
  depsHealth?.register({ qiDirectiveRate: qualityWorkerInspectProbability })
  depsJobs?.register({
    // LANE 0.2.3 (jobs→spawn-Service): `runJob` is NO LONGER registered into
    // the holder — the dshd-jobs scheduler tick resolves the run engine
    // SERVICE-FIRST via `ctx.get('deepartments.spawn')?.runJobForDepartment`
    // (this package provides the spawn service) and uses this holder's runJob
    // only as the R6 fallback in a composition where the spawn service is
    // absent. The binder `jobs` bucket still carries runJob (the re-homed
    // register above) for the same R6 fallback seam.
    notifyHead: schedulerNotifyHead,
    departmentForEntry: schedulerDepartmentForEntry,
    departmentForJob: schedulerDepartmentForJob,
    onAutoRunSkip: schedulerOnAutoRunSkip,
    repoRoot,
    // LANE 0.2.3b (W8-c re-plumb): the runJobForDepartment-EXCEPTION capture —
    // the post-error row the register-era schedulerRunJob produced is re-wired
    // to the SERVICE-FIRST path: the dshd-jobs tick adapter (deepartments.spawn
    // runJob adapter) calls this sink after a spawn exception — the SAME
    // captureSchedulerAutoRunFailure (post-errors.jsonl row, postId
    // 'scheduler', dedupe-keyed the same way), bundled with the bundle's
    // apply-fiber stateDir/now. Absent sink (minimal composition) → the adapter
    // stays warn-only (R6).
    captureAutoRunFailure: (finding: SchedulerAutoRunFinding) =>
      captureSchedulerAutoRunFailure({ stateDir, now: () => Date.now(), jobId: finding.jobId, reason: finding.reason, error: finding.error })
  })
  depsGui?.register({ endpointDeps: guiEndpointDeps })
  // depsPooler: INTENTIONALLY unfilled (1C — fully derivable, see above; the
  // holder still exists for the uniform 1B surface + is cleared on unload).
  //   P6 — the SAME unload effect RELEASES the deps holders (the 4 DI-by-
  //   services baseline holders + the 4 zone holders): Cordis runs the
  //   disposers in REVERSE registration order, and the daemon
  //   effects (agenda/parallel/health) register AFTER this factory returns, so
  //   they are disposed FIRST (intervals cleared + the health drain resolved)
  //   and the dep seams are released only after no in-flight tick can touch
  //   them. Post-unload, every zone reader + lazy shell (dshd-core epoch) REBUILDS
  //   over the emptied holders and FAILS LOUD (R1) — never stale closure
  //   execution of the unmounted apply. (Defined OUTSIDE the frozen CUT-4 zone so
  //   the tools-factory byte-identical md5 lock is untouched — the healthNotifyHead
  //   pattern of tools.ts:4934.)
  ctx.effect(() => () => {
    depsBus?.clear?.()
    depsDeliver?.clear?.()
    depsLifecycle?.clear?.()
    depsWakepack?.clear?.()
    depsHealth?.clear()
    depsJobs?.clear()
    depsPooler?.clear()
    depsGui?.clear()
  }, 'deepartments: deps holders released on unload (P6 — no stale closures post-unmount)')

// =========================================================================
  // SURFACE RETURN — the members the rest of applyInvoke consumes at the SAME
  // positions as before the extraction. SUB-BATCH 1 exposes the registry
  // (installHeadBoardTools); SUB-BATCH 2 adds the setup/role/dispose members;
  // SUB-BATCH 3 adds the workspace/ensureHead/retire/boot-check members (the
  // CUT3 retire helpers captureRetiredPostTurnError/settleRetiredPostDeliveries/
  // predictRetiredWorkerDeliverable are factory-INTERNAL now — the factory-local
  // retirePost consumes them directly, no external consumer remains).
  // =========================================================================
  return {
    installHeadBoardTools,
    workerSetup,
    headSetup,
    disposeHeadHandle,
    disposeHeadHandleOnce,
    disposeJoinTimeoutMs,
    joinHeadDisposeOnce,
    resolveDepartmentWorkspaceCwd,
    resolveWorkspaceRootPath,
    rotateArchivedHeadSessionId,
    retirePost,
    isHeadStuck,
    markHeadProgress,
    attachHeadSession,
    archivePostSessionOnSleep,
    schedulerHeadForDepartment,
    schedulerRunJob,
    schedulerOnAutoRunSkip,
    schedulerNotifyHead,
    schedulerDepartmentForEntry,
    schedulerDepartmentForJob,
    buildHealthPosts,
    buildHostRunning,
    buildSessionContexts,
    buildHostWaits,
    healthNotifyHost,
    healthNotifyHead,
    healthPoolerStatePath,
    healthBootId,
    guiEndpointDeps,
    // HOTFIX 0.2.2-1: the surface carries the PURE inline computation (NOT the
    // service-first wrapper) — the execRoots service DEFAULT delegates to it
    // WITHOUT a re-entry cycle (the 0.2.2 wrapper export broke the live
    // profile with «execRoots.resolveAllowedRoots is not a function»).
    execRoots: deptExecAllowedRootsInline
  }
}
