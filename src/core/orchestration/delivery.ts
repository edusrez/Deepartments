/**
 * Deepartments — DECOUPLING SUB-PASO 2: the DELIVERY ORCHESTRATION FACTORY
 * (HITO 3 DECOUPLING, brief step 3 — delivery/ACL/QD/lifecycle/engine, ~1089
 * LOCs of `applyInvoke`).
 *
 * MOVEMENT-ONLY. The delivery zone of `applyInvoke` (src/invoke.ts 7164-8252:
 * the bus boot + post/host deliveries + QD hooks + fb-11 rotation wake + the
 * sleep/wake/rotate LIFECYCLE carve + the F2 messaging ACL + the catalog/child
 * routes + the DELIVERY ENGINE) is hoisted VERBATIM into this factory, and
 * `applyInvoke` invokes it via `createDeliveryOrchestration` AT THE SAME FIBER
 * POSITION — the same closures, the same order, the same semantics (0 behavior
 * change). The state these closures read/mutate is the SAME by-reference
 * maps/registries passed in `deps`.
 *
 * Pattern (the PASO 1 proof): closures hoisted → the bundle REGISTERS them in
 * the baseline Binder buckets (bus/deliver/wakepack/lifecycle/redeliver — the
 * register call in invoke.ts consumes the SAME closure names, now produced
 * here; the binder-contract lock is untouched) → the bundle invokes the
 * REGISTERED SERVICES (deepartments.bus / .deliver / .lifecycle / .acl) at the
 * same positions with the inline R6 fallbacks preserved when dshd-core is
 * absent (minimal/hermetic compositions — behavior-neutral).
 *
 * The bundle stays a PURE SERVICE CONSUMER: this factory performs NO
 * ctx.provide (the P1 "the bundle consumes, never provides" invariant + the
 * smoke-boot service set stay untouched). The `deepartments.delivery` service
 * surface the brief planned via ctx.provide is deferred to the hito-4 package
 * migration (see the sub-paso 2 report) — the seams it would expose are
 * already the returned DeliverySurface members.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'

import {
  HOST_ID_PREFIX,
  HEAD_SESSION_PREFIX,
  readDurableHostEntries,
  pickLiveHostEntry,
  isHostRetiredOnDisk
} from '../registry.js'
import type { PostEntry, HostEntry, HostEntryLike } from '../registry.js'
import { MessagesStore, markDelivery } from '../messages.js'
import type { DeliveryStatus, MessageRecord } from '../messages.js'
import { createDeliveryEngine } from '../delivery.js'
import type {
  DeliveryEngine,
  DeliveryInterruptOptions,
  BusMemberProfile,
  CatalogRoute,
  AclSurface,
  BusSurface
} from '../delivery.js'
import { busProfileFor as aclBusProfileFor, aclDenyGround as aclDenyGroundImpl } from '../acl.js'
import type { BusCatalogLens } from '../acl.js'
import { FeedbackStore } from '../feedback.js'
import type { FeedbackTipo, FeedbackSeveridad } from '../feedback.js'
import { createLifecycleService, buildSleepJournalMessage } from '../lifecycle.js'
import type { LifecycleService } from '../lifecycle.js'
import { runHostRotation } from '../session-rotation.js'
import {
  safeInterrupt,
  postErrorClass,
  appendPostErrorDeduped,
  POST_ERROR_RECORD_KEY_PREFIX,
  resetHostMaterializeFailures,
  isSessionNotFoundError,
  readMaterializeState,
  markHostMaterializeFailure,
  writeMaterializeState,
  MATERIALIZE_QUARANTINE_N,
  MATERIALIZE_QUARANTINE_MS,
  markUnusableWorkerSession,
  clearUnusableWorkerSession
} from '../health.js'
import type { PostErrorEntry } from '../health.js'
import { qualityInspectDecision, qualityInspectDirectiveText } from '../quality.js'
import type { QualityInspectDirectiveSurface } from '../quality.js'
import { jsonSafeMessageSource, sanitizePromptLiterals } from '../wakepack.js'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { DepartmentConfig, CoordinatorConfig } from '../../org.js'

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

/** Structural view of the `agentPresets` service surface (mirrors the
 * bundle-local `AgentPresetsLike`). */
interface AgentPresetsLike {
  resolve(id: string): Promise<unknown>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** The session header the host-self-registration reads (mirrors the
 * bundle-local `SessionHeaderWithOrigin`; the nested `meta` fallback is kept
 * only for stale/mocked headers). */
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

/** The apply-scope bindings the delivery zone captures (src/invoke.ts closures
 * + the shared mutable state), passed BY REFERENCE — the factory reads and
 * mutates the SAME maps/registries the rest of applyInvoke uses (AGENTS.md
 * rule 4 — no module-global mutable state; the instance lives on the apply
 * fiber). */
export interface DeliveryFactoryDeps {
  /** The org stateDir (<stateDir>/messages.jsonl, deliveries.jsonl, ...). */
  stateDir: string
  /** The live agents service (optional — absent in minimal compositions). */
  agents?: AgentsLike
  /** The subagent continuation service (optional — typed as the REAL harness
   * runtime so the injection site is exact). */
  subagents?: SubagentRuntime
  /** The agent-presets service (optional — the D4 host resume mount). */
  agentPresets?: AgentPresetsLike
  /** The live durable catalog registries (BY REFERENCE). */
  byPost: Map<string, PostEntry>
  hosts: Map<string, HostEntry>
  byChild: Map<string, string>
  /** The live head-handle map (byHeadHandle). */
  byHeadHandle: Map<string, AgentHandleLike>
  /** The stuck-head progress map (headProgress). */
  headProgress: Map<string, { at: number; eventCount: number }>
  /** The wake-relay intent sets the lifecycle carve bridges. */
  wakePackInjected: Set<string>
  deferredSleepReplace: Map<string, string>
  /** The registry closure — register a (re)materialized entry (by reference). */
  registerEntry: (entry: PostEntry) => void
  /** The config coordinator resolver for a head postId. */
  coordinatorForPost: (postId: string) => CoordinatorConfig | undefined
  /** The config department resolver for a durable post entry. */
  departmentForEntry: (entry: PostEntry) => DepartmentConfig | undefined
  /** The config department resolver for a postId. */
  departmentForPost: (postId: string) => DepartmentConfig | undefined
  /** The head own-layer setup builder (F8/F10 materialization). */
  headSetup: (postId: string, roomId: string, role: string, presetId?: string, department?: DepartmentConfig) => (agentCtx: Context) => unknown
  /** The worker own-layer setup builder (materialization). */
  workerSetup: (postId: string, roomId: string, role: string, extra?: { persona?: string; taskText?: string; tools?: string[]; department?: DepartmentConfig }) => (agentCtx: Context) => unknown
  /** VALLE lane B (fb-29 structural fix) — the COLD re-materialization tools
   * reader (exposed by the spawn orchestration surface, resolveRoleTemplate):
   * re-resolves a worker's role-template tools at the materialize seam so a
   * restarted worker is NEVER re-created with an empty tool-scope (the original
   * fb-29 bug). Returns the template (with its `tools`) when the role has a
   * template FILE (a role-template worker); undefined when NO template file
   * exists (a LEGACY dept_post_create free-form-role worker — board-only by
   * design, never failed). */
  resolveRoleTemplate: (departmentId: string, role: string) => Promise<{ id: string; title: string; tools?: string[]; persona: string; path: string } | undefined>
  /** Resolve the duplicate-safe materialization AgentOptions (coordinator →
   * WORKER_AGENT_OPTIONS fallback). */
  resolveMaterializeAgentOptions: (candidate: AgentOptionsLike | undefined) => AgentOptionsLike
  /** F5: the fresh incarnation's department workspace cwd. */
  resolveDepartmentWorkspaceCwd: (department: DepartmentConfig | undefined) => Promise<string>
  /** The shared workspace root fallback cwd. */
  resolveWorkspaceRootPath: () => Promise<string>
  /** The archive-leak head-session rotation (a non-archived resume stays). */
  rotateArchivedHeadSessionId: (postId: string, sessionId: string) => Promise<string | undefined>
  /** The durable worker retire (the delivery auto-retire seam). */
  retirePost: (postId: string, callerAgentId: string) => Promise<{ postId: string; retired: true }>
  /** The head session-title pin (module-scope pure helper, passed by ref to
   * keep the factory import-free of the bundle module). */
  pinSessionTitle: (session: Session, title: string) => 'pinned' | 'already-titled' | 'failed'
  /** The once-per-session handle dispose (the sleep detach). */
  disposeHeadHandleOnce: (sessionId: string) => Promise<void>
  /** The bounded detach-join timeout (the sleep respawn deadlock fix). */
  disposeJoinTimeoutMs: () => number
  /** The bounded detach join (sleep respawn serialization). */
  joinHeadDisposeOnce: (sessionId: string) => Promise<boolean>
  /** The per-head recovery serialization (stuck-head dispose + cold-resume). */
  serializeHeadRecovery: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** The stuck-head comparator (no progress for STUCK_HEAD_MS). */
  isHeadStuck: (sessionId: string, live: AgentLike) => boolean
  /** Dispose a live head handle (the stuck recovery + sleep). */
  disposeHeadHandle: (sessionId: string) => Promise<void>
  /** The fresh progress baseline stamp (the stuck check). */
  markHeadProgress: (sessionId: string, live: AgentLike) => void
  /** Fire-and-forget the session workspace attach for a bus-woken session. */
  attachHeadSession: (sessionId: string, source: string) => Promise<void>
  /** The fb-9 resume-class preflight (reasoning-content compatibility). */
  workerReasoningContentPreflightError: () => string | undefined
  /** The DISPATCH-HARDENING pooler-capacity block on the resume seam. */
  workerPoolerDispatchBlockError: () => string | undefined
  /** The host self-registration (B3 gap fix — board tools are gone). */
  ensureHost: (sessionId: string, roomId: string) => string
  /** Durable registry persistence (closures the lifecycle carve bridges). */
  persistPosts: () => Promise<void>
  persistHosts: () => void
  /** The journal path resolver (T1). */
  journalPathFor: (memberId: string) => string
  /** The journal write closure (lifecycle carve — journal/archive policy). */
  writeJournal: (memberId: string, roomId: string, summary: string, decisions: string[], constraints: string[], openItems: string[], currentStep?: string, archive?: { sessionId?: string; wakeCounter?: number; archiveSeq?: string; lastWakeMs?: number; boundarySeq?: number }) => Promise<string>
  /** The journal read closure. */
  readJournal: (memberId: string) => Promise<string | undefined>
  /** The sleep-counter journal bumps (lifecycle carve). */
  bumpHostSleepCounter: (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }) => Promise<string>
  bumpPostSleepCounter: (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }) => Promise<string>
  /** The sleep session archive (lifecycle carve). */
  archivePostSessionOnSleep: (sessionId: string) => Promise<boolean>
  /** Live identity resolvers (session → member id). NOTE: `hostForSession` is
   * the LIVE DURABLE MAP (registry.hostForSession — sessionId → hostId); the
   * `hostIdForSession` closure wraps it for host-family callers. */
  hostForSession: Map<string, string>
  hostIdForSession: (sessionId: string) => string
  postIdForChild: (childId: string) => string | undefined
  /** The host workspace-attach repair seam (W8-i retry). */
  repairHostWorkspaceAttach: () => Promise<void>
  /** The QD workerInspectProbability (the directive dice — a value). */
  qualityWorkerInspectProbability: number
  /** The bundle's agent-template + daemon constants. */
  PRESET_ID: string
  WORKER_PRESET_ID: string
  WORKER_AGENT_OPTIONS: AgentOptionsLike
  HOST_AGENT_OPTIONS: AgentOptionsLike
  /** The default pinned head session title (fresh mint + rotation). */
  HEAD_DEFAULT_SESSION_TITLE: string
  /** The stuck-head window (Fix A2 — no progress for STUCK_HEAD_MS is wedged). */
  STUCK_HEAD_MS: number
}

/** The delivery surface the rest of applyInvoke consumes at the SAME positions
 * as before the extraction (the tools, the daemons, the redeliver driver, the
 * bind register — every downstream reference is unchanged). */
export interface DeliverySurface {
  /** The boot-opened store directory (the redeliver driver's `stateDir`). */
  messageStoreDir: string
  /** The boot-opened message store (the bus service first, inline fallback
   * R6 — the SAME store in both compositions). */
  messagesStoreReady: Promise<MessagesStore>
  /** The boot-opened feedback store (dshd-feedback is a pure lib — always
   * opened in-bundle from the shared org stateDir). */
  feedbackStoreReady: Promise<FeedbackStore>
  /** The SINGLE fresh-mint point for a department HEAD (F8 + the M-A rotation). */
  freshMintHead: (entry: PostEntry, dept: DepartmentConfig | undefined, opts?: { seed?: readonly unknown[]; source?: string }) => Promise<AgentLike>
  /** The shared post DELIVERY (wakePost seam + stuck recovery; never throws). */
  busDeliverToPost: (entry: PostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined, opts?: DeliveryInterruptOptions) => Promise<DeliveryStatus>
  /** The shared HOST delivery (D4 — always wake, W8-i retry; never throws). */
  busDeliverToHost: (hostEntry: HostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined, opts?: DeliveryInterruptOptions) => Promise<DeliveryStatus>
  /** The configured `quality-head` post resolver (QD hooks + feedback notify). */
  resolveQualityHeadEntry: () => PostEntry | undefined
  /** The ACL-legal notification forwarder (dshd-feedback R7). */
  feedbackForwarderFor: (emisor: string) => string | undefined
  /** The severity-gated delivery options (critico → interrupt; alto → wake;
   * medio/bajo/mejora → no-wake). */
  feedbackDeliveryOptions: (tipo: FeedbackTipo, severidad: FeedbackSeveridad) => { noWake: boolean; interrupt?: boolean }
  /** The QD (spec 007 §6.4 D-Q4a) ADDRESSED QUALITY INSPECT directive emitter. */
  maybeEmitQualityInspectDirective: (surface: QualityInspectDirectiveSurface) => Promise<void>
  /** fb-11 — the ROTATION-SUCCESSOR AUTO-WAKE transport (durable record +
   * D4 host delivery; never throws). */
  enqueueHostWake: (wake: { newHostId: string; newSessionId: string; sleepEpoch: number }) => Promise<void>
  /** The sleep/wake/rotate lifecycle SERVICE (deepartments.lifecycle first, the
   * in-bundle createLifecycleService fallback R6). */
  lifecycle: LifecycleService
  /** The messaging-ACL profile classifier (deepartments.acl first, the
   * in-bundle aclBusProfileFor bind fallback R6). */
  busProfileFor: (memberId: string) => BusMemberProfile
  /** The pure ACL denial ground (same predicate the delivery engine re-checks
   * defensively). */
  aclDenyGround: (sender: BusMemberProfile, recipient: BusMemberProfile) => string | undefined
  /** The bus catalog-route resolver (spec §4.2 route 2 + the m-331 re-route). */
  resolveBusCatalogRoute: (recipientId: string) => CatalogRoute
  /** The thin deliverBusRecord wrapper (delivery.deliverOrQueue + sidecar). */
  deliverBusRecord: (record: MessageRecord, recipientId: string, callerAgentId: string, senderSessionId: string | undefined, signal?: AbortSignal, opts?: DeliveryInterruptOptions & { noWake?: boolean }) => Promise<DeliveryStatus>
  /** The caller's BUS member id (postId else the deterministic host id). */
  busMemberIdFor: (agentId: string) => string
  /** The child-route resolver (the caller's direct continuable children). */
  resolveBusChild: (recipientId: string, callerAgentId: string, signal?: AbortSignal) => Promise<boolean>
  /** The native child-route delivery (subagents.followup; never throws). */
  deliverBusChild: (callerAgentId: string, recipientId: string, record: MessageRecord, framed: string, senderSessionId: string | undefined, signal?: AbortSignal) => Promise<DeliveryStatus>
  /** The DELIVERY ENGINE (deepartments.deliver first, the in-bundle
   * createDeliveryEngine fallback R6). */
  delivery: DeliveryEngine
  /** B3 (m-361): whether a CATALOG recipient is DORMANT (sleepEpoch marked). */
  isDormantRecipient: (recipientId: string) => boolean
  /** B3 gap fix: the host self-registration (send_message/dept_who callers). */
  busEnsureHostForCaller: (callerAgent: { id: string; session?: { header?: SessionHeaderWithOrigin } }) => string
  /** The 1..20 fan-out guard (spec §4.4). */
  assertBusFanOut: (to: readonly string[]) => number
}

/**
 * Build the DELIVERY ORCHESTRATION surface on the apply fiber (AGENTS.md rule 4
 * — no module-global mutable state; invoked by applyInvoke at the SAME fiber
 * position where the hoisted zone used to live). The closures below are the
 * ORIGINAL zone closures, moved VERBATIM — the diff is movement-only.
 */
export function createDeliveryOrchestration(ctx: Context, deps: DeliveryFactoryDeps): DeliverySurface {
  const {
    stateDir,
    agents,
    subagents,
    agentPresets,
    byPost,
    hosts,
    byChild,
    byHeadHandle,
    headProgress,
    wakePackInjected,
    deferredSleepReplace,
    registerEntry,
    coordinatorForPost,
    departmentForEntry,
    departmentForPost,
    headSetup,
    workerSetup,
    resolveMaterializeAgentOptions,
    resolveRoleTemplate,
    resolveDepartmentWorkspaceCwd,
    resolveWorkspaceRootPath,
    rotateArchivedHeadSessionId,
    retirePost,
    pinSessionTitle,
    disposeHeadHandleOnce,
    disposeJoinTimeoutMs,
    joinHeadDisposeOnce,
    serializeHeadRecovery,
    isHeadStuck,
    disposeHeadHandle,
    markHeadProgress,
    attachHeadSession,
    workerReasoningContentPreflightError,
    workerPoolerDispatchBlockError,
    ensureHost,
    persistPosts,
    persistHosts,
    journalPathFor,
    writeJournal,
    readJournal,
    bumpHostSleepCounter,
    bumpPostSleepCounter,
    archivePostSessionOnSleep,
    hostForSession,
    hostIdForSession,
    postIdForChild,
    repairHostWorkspaceAttach,
    qualityWorkerInspectProbability,
    PRESET_ID,
    WORKER_PRESET_ID,
    WORKER_AGENT_OPTIONS,
    HOST_AGENT_OPTIONS,
    HEAD_DEFAULT_SESSION_TITLE,
    STUCK_HEAD_MS
  } = deps

  // =========================================================================
  // DELIVERY ZONE (hoisted VERBATIM from applyInvoke — the same closures, the
  // same order, the same semantics).
  // =========================================================================
  // ---------------------------------------------------------------------------
  // Batch B2 — AGENT MESSAGING BUS (spec 003). The delivery side is the
  // materializePost seam EXACTLY (catalog targets: materialize + always-wake;
  // D4) with the bus framing/source; the native-route side is
  // `subagents.followup` for continuable children. The board wakePost above is
  // gone (B3 cutover — the bus is the only delivery path).
  // ---------------------------------------------------------------------------

  /** The one record the bus persists per send (spec §3.1): the durable source
   * of truth, on disk BEFORE any delivery (persist-before-deliver, D4). */
  const messageStoreDir = stateDir

  /** The boot-opened message store (load + compact + per-recipient index).
   * Rejects loud on mid-file corruption (spec §3.2 — fail loud, never hide);
   * tools surface the rejection at use.
   * FASE 2.6-C: when the dshd-core bus service is composed, the store is the
   * CORE's (opened once on first use from the shared org stateDir); in a
   * minimal composition (dshd-core absent) we fall back to the in-bundle open
   * — the SAME store, behavior-neutral. */
  const messagesStoreReady = (ctx.get('deepartments.bus') as BusSurface | undefined)?.storeReady ?? MessagesStore.open(messageStoreDir)

  /** The boot-opened feedback store (load + prune-to-cap + live-by-id index).
   * The dshd-feedback package is a pure LIBRARY (no composed Cordis service),
   * so this is opened in-bundle from the shared org stateDir — the single
   * per-apply instance the `dept_feedback*` tools own (AGENTS.md rule 4).
   * Rejects loud on mid-file corruption (spec §3.2 — fail loud, never hide). */
  const feedbackStoreReady = FeedbackStore.open(messageStoreDir)

  /**
   * B5 — whether an agent materialization error is the harness "no
   * provider/model" signature (the VARIANT-2 / builder-87 ghost: a worker whose
   * durable session is PRESENT but whose AgentOptions carry no provider/model).
   * Conservative: only an EXACT signature match marks a worker unusable.
   */
  const isNoProviderModelError = (error: unknown): boolean => {
    const text = error instanceof Error ? error.message : String(error)
    return /has no provider\/model/.test(text)
  }

  /** fb-6 (B5 forensics): attach the RESOLVED (post-fallback) AgentOptions
   * VERBATIM (JSON) to a residual no-provider/model error's message, so BOTH
   * the durable post-error row AND the B5 marker carry diagnostic context
   * ("what options did the failed create actually receive?"). The original
   * message text is PRESERVED (the JSON is APPENDED), so the
   * isNoProviderModelError regex classification is unchanged; the original
   * error is also kept as `cause` (ES2023) and its stack is retained. */
  const withAgentOptionsContext = (error: unknown, agentOptions: AgentOptionsLike | undefined): Error => {
    const message = error instanceof Error ? error.message : String(error)
    const wrapped = new Error(`${message} agentOptions=${JSON.stringify(agentOptions ?? null)}`, error instanceof Error ? { cause: error } : undefined)
    if (error instanceof Error && error.stack !== undefined) wrapped.stack = error.stack
    return wrapped
  }

  /**
   * M-A (2026-08-28) — the SINGLE fresh-mint point for a department HEAD: the
   * F8 fresh-mint body of materializePost (extracted VERBATIM) + the journal
   * seed of the head-rotation path. One helper, three callers:
   *   - the F8 slept-head wake (materializePost — `seed` absent → the fresh
   *     session stays EMPTY, EXACTLY the pre-extraction behavior, zero
   *     regression);
   *   - the archived-session rotation of a live head (the archive-leak flip —
   *     same caller shape, see rotateArchivedHeadSessionId);
   *   - the M-A host-plane `dept_head_rotate` tool (`seed` = the head's LAST
   *     durable journal via buildHeadRotationSeed — the session is minted with
   *     the journal as its continuation context).
   * The head keeps its identity (postId); only the underlying session
   * (context) is fresh: this registers the new entry (new sessionId,
   * previousChildId = the old session, sleepEpoch cleared — a rotation is NOT
   * sleep —, `rotated: true` marker), CREATES the new durable session, records
   * the handle + progress baseline, fire-and-forgets the workspace attach and
   * pins the department sidebar title. Returns the LIVE fresh target (throws
   * when the head cannot be materialized — the caller maps it to 'failed').
   */
  const freshMintHead = async (
    entry: PostEntry,
    dept: DepartmentConfig | undefined,
    opts: { seed?: readonly unknown[]; source?: string } = {}
  ): Promise<AgentLike> => {
    if (agents === void 0) throw new Error('[deepartments] head fresh-mint requires the agents service')
    const previousSession = entry.sessionId
    const freshSessionId = String(SessionId(`${HEAD_SESSION_PREFIX}${entry.postId}-${randomUUID()}`))
    const coordinator = coordinatorForPost(entry.postId)
    // Drop the OLD session's reverse index BEFORE registering the fresh one
    // (registerEntry re-keys byChild by the new sessionId; without the delete
    // the old id would linger as a dead mapping).
    byChild.delete(previousSession)
    // Fix (head-sleep worker drain): the in-flight ledger is the sleep→boot
    // handoff; once the head is materialized (woken) its agent handles its own
    // workers, so clear the snapshot on the fresh incarnation. M-A: `rotated`
    // marks the rotation event (a rotation is NOT sleep — sleepEpoch stays
    // cleared).
    registerEntry({ ...entry, sessionId: freshSessionId, previousChildId: previousSession, sleepEpoch: undefined, inflightWorkers: undefined, rotated: true })
    const role = coordinator?.role ?? entry.role ?? 'department worker'
    const headPreset = entry.agentPreset ?? PRESET_ID
    // F10 (spec 004 §9.1): the materialized head carries its department's
    // architecture section (if any).
    const setup = headSetup(entry.postId, entry.roomId, role, headPreset, dept)
    const agentOptions = resolveMaterializeAgentOptions(coordinator?.agentOptions)
    // F5: the fresh incarnation lands in its department workspace (config
    // workspacePath); a department-less/legacy head falls back to the root.
    const deptCwd = await resolveDepartmentWorkspaceCwd(dept)
    const handle = await agents.create({
      sessionId: freshSessionId,
      // M-A: the seed is the OPTIONAL journal continuation of a head rotation
      // (buildHeadRotationSeed → the harness CreateAgentOptions.seed →
      // sessions.prepare(id, {seed, meta})); the F8 wake passes none (the
      // pre-extraction empty-session create, byte-identical).
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: headPreset },
      agentOptions,
      setup
    })
    if (handle !== void 0) byHeadHandle.set(freshSessionId, handle)
    const freshTarget = agents.get(freshSessionId)
    if (freshTarget === void 0) throw new Error(`[deepartments] head "${entry.postId}" could not be materialized (fresh rotation) for bus delivery`)
    markHeadProgress(freshSessionId, freshTarget)
    const source = opts.source ?? 'bus-deliver'
    void attachHeadSession(freshSessionId, source)
    // F8 (acceptance b): pin the head sidebar title on the FRESH session — the
    // old (archived) session is gone, so the fresh one MUST carry the pinned
    // department title or the row would fall back to the raw id. (A seeded
    // rotation already carries the title in the seed's `session/title` event —
    // pinSessionTitle's never-double-pin guard turns the runtime pin into a
    // no-op 'already-pinned'.)
    const titleSession = ctx.sessions.get(SessionId(freshSessionId))
    if (titleSession !== void 0) {
      const title = coordinator?.sessionTitle || HEAD_DEFAULT_SESSION_TITLE
      const titlePin = pinSessionTitle(titleSession, title)
      if (titlePin === 'pinned') {
        ctx.logger.info(`[deepartments] ${source}: pinned fresh head title "${title}" (${freshSessionId})`)
      } else if (titlePin === 'failed') {
        ctx.logger.warn(`[deepartments] ${source}: fresh head title pin failed for ${freshSessionId} (non-fatal — materialization continues)`)
      }
    }
    return freshTarget
  }

  /** VALLE lane B (fb-29 structural fix) — resolve the toolset the COLD
   * re-materialization seam hands to workerSetup, so a restarted worker is
   * NEVER re-created with an empty tool-scope (the fb-29 bug: the COLD path
   * built the setup WITHOUT `tools`, unlike the warm spawn engines that pass
   * `template.tools`). Resolution order:
   *  (B) fast-path — the entry's own durable `tools` (the spawn wrote it; the
   *      belt-and-suspenders cache), else
   *  (A) primary — re-resolve the role template via the spawn-surface reader
   *      (covers LEGACY entries WITHOUT the durable field; single source of
   *      truth = the role template file, exactly like the warm path), then
   *  (fb-29 guard) a ROLE-TEMPLATE worker whose template EXISTS but resolves an
   *      EMPTY tool-scope FAILS LOUDLY — never materialize a messaging-only
   *      worker in silence (the original fb-29 invariant; a legacy
   *      dept_post_create free-form-role worker with NO template file is the
   *      board-only BY-DESIGN class and is returned unchanged, no tools).
   * Returns `string[]` (the non-empty allow-list to apply) or `undefined`
   * (legacy board-only class — no tools to restore). */
  const resolveMaterializeWorkerTools = async (entry: PostEntry, role: string, dept: DepartmentConfig | undefined): Promise<string[] | undefined> => {
    // (B) the durable fast-path — the entry itself carries an explicit allow-list.
    if (Array.isArray(entry.tools) && entry.tools.length > 0) return [...entry.tools]
    // (A) primary — re-resolve the role template (covers legacy without the field).
    if (dept !== void 0) {
      const template = await resolveRoleTemplate(dept.id, role)
      if (template !== void 0) {
        if (Array.isArray(template.tools) && template.tools.length > 0) return [...template.tools]
        // fb-29 guard — an EXISTING role template that resolves EMPTY tools.
        throw new Error(`[deepartments] cold re-materialization of worker "${entry.postId}" (role "${role}", dept "${dept.id}") refused: the role template presets/departments/${dept.id}/${role}.md resolves an EMPTY tool scope — refusing to materialize a messaging-only worker (fb-29 invariant). Fix the template \`tools\` allow-list or the entry's durable tools.`)
      }
      // template === undefined: a role with NO template FILE = the legacy
      // dept_post_create board-only class (messaging-only BY DESIGN — never
      // failed); fall through to the no-tools return.
    }
    // A department-less legacy worker (no resolvable template tree) or a
    // board-only dept_post_create worker → no role tools to restore.
    return undefined
  }

  /**
   * The SHARED post-materialization core of the wakePost seam (spec §4.3 step 2
   * — "EXACTLY wakePost"): respawn-from-sleep (dispose stale handle, clear
   * sleepEpoch, keep previousChildId), resume→create fallback with the post's
   * durable per-head preset + role, mark a fresh progress baseline, and
   * fire-and-forget the workspace attach. Returns the live target and whether
   * this call materialized it (the `resumed` delivery status). Throws when the
   * post cannot be materialized (the caller maps it to a `failed` delivery).
   */
  const materializePost = async (entry: PostEntry): Promise<{ target: AgentLike; resumed: boolean }> => {
    if (agents === void 0) throw new Error('[deepartments] bus delivery requires the agents service')
    // fb-9 RESUME SEAM (coverage-map §4-3): the SAME dispatch pre-flight as the
    // spawn engines, at the SINGLE choke point of the bus-wake materialization —
    // ONE call here covers EVERY agents.resume/agents.create below (the
    // sleep-respawn head create :6601, the archived-rotation head create :6666,
    // the shared cold-resume :6691 and its create-fallback :6694) with no
    // duplication. The mid-turn continuation 400 (the q-i-20 class) is NOT this
    // seam, but the RESUME class (fb-6: a cold-resumed worker re-plays the
    // tool-call history through the same openai-completions API) gets the same
    // fail-EARLY: a worker route whose profile has reasoning enabled but lacks
    // compat.requiresReasoningContentOnAssistantMessages=true never resumes into
    // its expensive first 400 — the wake fails loudly with the preflight error
    // instead (the delivery is mapped to 'failed' by busDeliverToPost).
    const preflightError = workerReasoningContentPreflightError()
    if (preflightError !== undefined) throw new Error(`[deepartments] ${preflightError}`)
    // DISPATCH-HARDENING (QH «429-primer-call»): the pooler-capacity
    // pre-check on the RESUME seam (the +1 of the fb-9 3+1) — a cold-resumed
    // / slept-respawned post wakes into ITS first call immediately; when the
    // pooler snapshot certifies no workspace can serve it, the wake fails
    // LOUDLY and EARLY (the delivery is mapped to 'failed' by busDeliverToPost,
    // exactly like the preflight error above) instead of burning the first
    // LLM turn on a 429/503.
    const poolerDispatchBlock = workerPoolerDispatchBlockError()
    if (poolerDispatchBlock !== undefined) throw new Error(`[deepartments] ${poolerDispatchBlock}`)
    const isWorker = entry.provider === 'worker'
    const coordinator = coordinatorForPost(entry.postId)
    let resumed = false
    if (entry.sleepEpoch !== void 0) {
      // Respawn from sleep: retire the live handle (if any), record the
      // previous incarnation, clear the flag. Joins any in-flight dept_sleep
      // detach (disposeHeadHandleOnce) so the incarnation below is guaranteed to
      // run only AFTER the machine is detached (no double-dispose race).
      // DEADLOCK FIX (2026-08-26): the join is BOUNDED — a zombie detach (a
      // slept machine whose turn can never settle, e.g. the QD-directive
      // cascade) would otherwise freeze THIS delivery forever, and every
      // awaited bus delivery to the slept head with it.
      if (!(await joinHeadDisposeOnce(entry.sessionId))) {
        ctx.logger.warn(`[deepartments] sleep respawn for "${entry.postId}": detach join timed out after ${disposeJoinTimeoutMs()}ms — proceeding with the fresh mint (zombie detach; the fresh incarnation uses a NEW session id, no collision)`)
      }
      byChild.delete(entry.sessionId)
      const previousSession = entry.sessionId
      // F8 (spec 002 head rotation) — a slept HEAD is recreated FRESH: mint a
      // new session id (the OLD one was ARCHIVED at dept_sleep) and CREATE a
      // brand-new durable session, never resume the archived old artifact. The
      // head keeps its identity (postId), journal and messages (archive ≠
      // delete); only the underlying session (context) is fresh. A disposable
      // WORKER keeps the legacy cold-resume of the SAME session — worker retire
      // is the separate archive path. M-A: the F8 fresh-mint body now lives in
      // the SHARED `freshMintHead` helper (the single fresh-mint point also
      // used by the host-plane dept_head_rotate tool); no seed is passed, so
      // the wake session stays EMPTY exactly like the pre-extraction create.
      if (!isWorker) {
        const freshTarget = await freshMintHead(entry, departmentForEntry(entry))
        return { target: freshTarget, resumed: true }
      }
      // Worker respawn: record the previous incarnation + clear the sleep flag,
      // then fall through to the shared cold-resume of the SAME session below.
      // A worker has no in-flight ledger of its own (only a head does), but clear
      // it for symmetry so a respawn never carries a stale snapshot.
      registerEntry({ ...entry, previousChildId: previousSession, sleepEpoch: undefined, inflightWorkers: undefined })
      resumed = true
    }
    const sessionId = SessionId(entry.sessionId)
    const live = agents.get(String(sessionId))
    if (live === void 0) {
      const role = coordinator?.role ?? entry.role ?? 'department worker'
      const headPreset = entry.agentPreset ?? PRESET_ID
      // F10 (spec 004 §9.1): the re-materialized post carries its department's
      // architecture section (a worker by its durable departmentId, a head by
      // config; a department-less/legacy entry → omitted cleanly).
      const dept = departmentForEntry(entry)
      // VALLE lane B (fb-29 structural fix): the COLD re-spawn hands the worker
      // its role template's TOOLS (B durable fast-path → A re-resolution → the
      // fb-29 loud guard) — never a silently messaging-only re-materialization
      // (the original fb-29 bug: this seam built the setup WITHOUT tools, unlike
      // the warm spawn engines). A legacy board-only worker resolves `undefined`
      // → the pre-fix no-tools setup byte-identical.
      const workerTools = isWorker ? await resolveMaterializeWorkerTools(entry, role, dept) : undefined
      const setup = isWorker
        ? workerSetup(entry.postId, entry.roomId, role, { department: dept, ...(workerTools !== undefined ? { tools: workerTools } : {}) })
        : headSetup(entry.postId, entry.roomId, role, headPreset, dept)
      const agentOptions = resolveMaterializeAgentOptions(coordinator?.agentOptions)
      const preset: string = isWorker ? WORKER_PRESET_ID : headPreset
      let handle: AgentHandleLike | undefined
      // F5 (spec 004 §6.2 L1): the FRESH-create fallback of a bus wake lands the
      // re-materialized session in ITS department workspace (a worker by its
      // durable departmentId, a head by config); a department-less/legacy entry
      // falls back to the shared workspace root (deptCwd ''). The resume path
      // above keeps the session's stored header cwd (immutable per session).
      const deptCwd = await resolveDepartmentWorkspaceCwd(departmentForEntry(entry))
      // THE VISIBILITY FIX (2026-08-25 P2): a NON-slept HEAD whose durable
      // session id is in the workspace registry's archived set must NEVER be
      // RESUMED — a live head's session is never archived, because the GUI
      // sidebar hides any archived session id (the re-seed resume of an archived
      // id is the root cause of the live-but-invisible head). Rotate to a FRESH
      // id (the F8 fresh-mint shape) and CREATE. A NON-archived head resume is
      // byte-identical (zero regression); a WORKER's resume is untouched here
      // (isWorker skips the rotation entirely).
      const rotatedSessionId = isWorker ? undefined : await rotateArchivedHeadSessionId(entry.postId, String(sessionId))
      if (rotatedSessionId !== void 0) {
        registerEntry({ ...entry, sessionId: rotatedSessionId, previousChildId: String(sessionId), sleepEpoch: undefined })
        handle = await agents.create({
          sessionId: rotatedSessionId,
          meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: headPreset },
          agentOptions,
          setup
        })
        if (handle !== void 0) byHeadHandle.set(rotatedSessionId, handle)
        const rotatedTarget = agents.get(rotatedSessionId)
        if (rotatedTarget === void 0) throw new Error(`[deepartments] head "${entry.postId}" could not be materialized (archived-session rotation) for bus delivery`)
        markHeadProgress(rotatedSessionId, rotatedTarget)
        void attachHeadSession(rotatedSessionId, 'bus-deliver')
        const titleSession = ctx.sessions.get(SessionId(rotatedSessionId))
        if (titleSession !== void 0) {
          const title = coordinator?.sessionTitle || HEAD_DEFAULT_SESSION_TITLE
          const titlePin = pinSessionTitle(titleSession, title)
          if (titlePin === 'pinned') {
            ctx.logger.info(`[deepartments] archive-leak rotation: pinned fresh head title "${title}" (${rotatedSessionId})`)
          } else if (titlePin === 'failed') {
            ctx.logger.warn(`[deepartments] archive-leak rotation: fresh head title pin failed for ${rotatedSessionId} (non-fatal — materialization continues)`)
          }
        }
        resumed = true
        return { target: rotatedTarget, resumed: true }
      }
      try {
        handle = await agents.resume({ resumeSessionId: String(sessionId), agentOptions, setup })
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" bus wake-resume failed, creating fresh: ${error instanceof Error ? error.message : String(error)}`)
        handle = await agents.create({
          sessionId: String(sessionId),
          meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: preset },
          agentOptions,
          setup
        }).catch((createError: unknown) => {
          // B5 — a WORKER whose create throws "has no provider/model" is the
          // VARIANT-2 / builder-87 ghost: a DURABLE session PRESENT but with NO
          // usable AgentOptions. The fb-6 fallback above has ALREADY resolved a
          // usable provider/model (WORKER_AGENT_OPTIONS) into `agentOptions`, so
          // this branch is the RESIDUAL case: the create fails even WITH
          // options. Record the durable marker so the boot reconcile's
          // `isSessionUnusable` classifies it as a retire-leak candidate (under
          // the existing retireGoneWorkers opt-in), and attach the RESOLVED
          // AgentOptions VERBATIM (JSON) to the error message (fb-6 forensics)
          // so BOTH the post-error row and the marker carry the exact options
          // the failed create received (the appended JSON never changes the
          // isNoProviderModelError classification — the original text is kept).
          // The marker is CLEARED on a successful materialization (see the
          // return below), so a worker that recovers is never over-retired.
          if (isWorker && isNoProviderModelError(createError)) {
            const forensic = withAgentOptionsContext(createError, agentOptions)
            void markUnusableWorkerSession(stateDir, entry.postId, entry.sessionId, forensic.message)
            throw forensic
          }
          throw createError
        })
      }
      if (handle !== void 0) byHeadHandle.set(String(sessionId), handle)
      resumed = true
    }
    const target = agents.get(String(sessionId))
    if (target === void 0) throw new Error(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" could not be materialized for bus delivery`)
    // Clear a B5 unusable mark: this worker materialized successfully, so its
    // session is usable again (never over-retire a recovered worker).
    if (isWorker) await clearUnusableWorkerSession(stateDir, entry.postId)
    // Fresh baseline for the (re)materialized incarnation so the stuck check
    // never misjudges a just-cold-resumed post.
    markHeadProgress(String(sessionId), target)
    void attachHeadSession(String(sessionId), 'bus-deliver')
    return { target, resumed }
  }

  /** The delivered user-message for ONE bus deliver (spec §4.3): the framed
   * text as content + the `agent/send` source. Built via createUserMessage with
   * a FRESH inline literal (mirroring wakePost's compile-clean call shape). */
  const busUserMessage = (record: MessageRecord, framed: string, senderSessionId: string | undefined) =>
    createUserMessage({
      // W8-b prompt-literal safety: the delivered bus message text (already
      // framed) is run through the brace sanitizer so an unbound double-brace
      // token in a message can never break the recipient session assembly.
      // Bound persona/preset vars are preserved.
      content: [{ type: 'text', text: sanitizePromptLiterals(framed) } as const],
      // W7-B: the source is projected to a PLAIN JSON-safe value BEFORE it is
      // inserted (the `agent/inbox/spliced` append boundary rejects
      // branded/class instances, a present `undefined` key, functions, etc.).
      // `senderSessionId: undefined` (no caller session) is OMITTED, never
      // emitted as a present-undefined key. A malformed value never throws.
      source: jsonSafeMessageSource({
        kind: 'agent',
        form: 'send',
        plugin: 'deepartments',
        summary: boundContextSummary(`New message from ${record.from} to ${record.to.length} recipient(s) (${record.kind}).`),
        to: [...record.to],
        messageId: record.id,
        from: record.from,
        senderSessionId: senderSessionId === undefined ? undefined : SessionId(senderSessionId)
      })
    })

  /** The shared post DELIVERY of one bus message: the wakePost seam including
   * the stuck-head recovery verbatim (relay guards §4.4). Never throws — the
   * error is logged AND returned as 'failed' (never silent). W9-b: when
   * `opts.interrupt` is true and the recipient is LIVE mid-turn, the CURRENT
   * turn is aborted (reason 'interrupted', keepInbox preserved) so the message
   * is the FIRST item of the recipient's next turn instead of queueing behind
   * it. Default (false) = QUEUE semantics, unchanged. */
  const busDeliverToPost = async (entry: PostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined, opts?: DeliveryInterruptOptions): Promise<DeliveryStatus> => {
    const sessionId = String(SessionId(entry.sessionId))
    const interrupt = opts?.interrupt === true
    try {
      const live = agents?.get(sessionId)
      // Fix A2 stuck-head resilience (verbatim): a live-but-running post with
      // NO session progress for STUCK_HEAD_MS is wedged; dispose + cold-resume
      // (serialized per head), re-delivering from the DURABLE message record —
      // never into the frozen loop's in-memory inbox.
      if (live !== void 0 && entry.sleepEpoch === void 0 && isHeadStuck(sessionId, live)) {
        ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}": live but stuck (no session progress for ${STUCK_HEAD_MS / 1000}s) — disposing + cold-resuming from the durable message record`)
        await serializeHeadRecovery(sessionId, async () => {
          await disposeHeadHandle(sessionId)
          headProgress.delete(sessionId)
          const { target } = await materializePost(entry)
          target.followup(busUserMessage(record, framed, senderSessionId))
        })
        return 'resumed'
      }
      // W9-b interrupt: a LIVE, currently-running recipient with `interrupt:
      // true` is preempted — abort its CURRENT turn (reason 'interrupted') and
      // preserve any already-pending inbox work (keepInbox), so the message
      // delivered below is the FIRST item of the recipient's next turn. A
      // DORMANT recipient (live === undefined) needs no abort — the followup
      // below wakes it immediately (unchanged).
      // M3 (spec §2.4): the abort is gated by the shared per-recipient interrupt
      // back-off (safeInterrupt) — at most ONE interrupt per recipient per
      // INTERRUPT_COOLDOWN_MS, regardless of identity/class count. A turn just
      // interrupted by the daemon is within the cooldown → it is NEVER
      // interrupted again (the re-entrancy guard); a delivery that falls inside
      // the cooldown races through to QUEUE semantics (no abort).
      if (interrupt && live !== void 0 && live.status === 'running') {
        const aborted = await safeInterrupt(live, entry.postId, Date.now(), stateDir)
        if (aborted) {
          ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}": interrupt=true — aborted the current turn (reason 'interrupted'); delivery is the first item of the next turn`)
        } else {
          ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}": interrupt=true but within the per-recipient cooldown — delivery queued (no abort)`)
        }
      }
      const { target, resumed } = await materializePost(entry)
      target.followup(busUserMessage(record, framed, senderSessionId))
      const status = resumed ? 'resumed' : 'delivered'
      // Fix B (head-sleep worker drain): a WORKER that has just delivered a
      // message to ITS OWN MANAGER HEAD is cut clean immediately — the delivery
      // itself is the retire trigger, so a worker that delivered its report to a
      // (possibly dormant) head is retired WITHOUT relying on the head remembering
      // an open item. The 'resumed' status is exactly the sleep-boundary signature
      // (the recipient was dormant at delivery time and was re-materialized). The
      // retire is a defensive no-op if the worker is already retired (idempotent).
      if (status === 'resumed' || status === 'delivered') {
        const senderEntry = byPost.get(record.from)
        if (senderEntry !== void 0 && senderEntry.provider === 'worker' && senderEntry.retired !== true && senderEntry.managerId === entry.postId) {
          try {
            await retirePost(record.from, String(SessionId(entry.sessionId)))
          } catch (error: unknown) {
            ctx.logger.warn(`[deepartments] auto-retire of worker "${record.from}" on delivery to "${entry.postId}" failed (non-fatal to the delivery): ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      return status
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      // W6 system-health: record the hard materialization/wake failure for the
      // health daemon (failures must reach the Asistente; post-errors.jsonl is
      // the durable anomaly source). A persist failure folds to a warn only.
      // Issue-1 (b) (owner m-331): use the RECORDING DEDUPE (appendPostErrorDeduped
      // in the shared health-alerts-state.json ledger) so a persistent failure of
      // a NON-host post is recorded at most once per (post + class) per
      // HEALTH_DEDUPE_WINDOW_MS — mirroring the host path — and the QD directive
      // below is gated on an actually-NEW append, NOT emitted per attempt.
      try {
        const errText = error instanceof Error ? error.message : String(error)
        const cls = postErrorClass(errText)
        const recordKey = `${POST_ERROR_RECORD_KEY_PREFIX}${entry.postId}:${cls ?? 'generic'}`
        const appended = await appendPostErrorDeduped(stateDir, {
          ts: Date.now(),
          postId: entry.postId,
          messageId: record.id,
          error: errText
        }, recordKey, Date.now())
        // QD (spec 007 §6.4, D-Q4a): a NEW post-error record (the spec-006 capture)
        // triggers an ADDRESSED QUALITY INSPECT directive to quality-head (with the
        // error record) — the event-driven, bus-ready analysis seam (additive to the
        // spec-006 host ALERT). Non-fatal (the helper wraps its own try/catch).
        // Issue-1 (b): `appended` is the recording-dedupe result — a dedupe-skip
        // means no new record, so do NOT re-signal (Bound the non-host cascade).
        // ECHO GUARD (reviewer gate): a failed QUALITY INSPECT directive delivery to
        // `quality-head` lands in THIS SAME catch — if we re-emitted a post-error
        // directive for it, the directive → busDeliverToPost(quality-head) → fail →
        // re-append → re-emit loop is unbounded. Gate the emit so the QD target's
        // OWN delivery failure is recorded (post-errors.jsonl) but is NEVER bubbled
        // back into another directive. (The host-delivery site gates on `appended`
        // instead; both bound the echo.)
        if (appended && entry.postId !== 'quality-head') {
          await maybeEmitQualityInspectDirective({
            kind: 'post-error',
            postId: entry.postId,
            messageId: record.id,
            error: errText
          })
        }
      } catch (appendError: unknown) {
        ctx.logger.warn(`[deepartments] post-error capture for "${entry.postId}" failed: ${appendError instanceof Error ? appendError.message : String(appendError)}`)
      }
      return 'failed'
    }
  }

  /** The shared HOST delivery (D4 — always wake, including a non-live host):
   * a live host is followed up inline; a non-live host session is resumed
   * exactly like a dormant head (the owner accepted the materialized host
   * turn). The host's own composition (the 'deepartments' preset) is re-mounted
   * best-effort when the agentPresets service is present; a bare resume is the
   * graceful fallback. Never throws — 'failed' is logged AND returned. W9-b:
   * when `opts.interrupt` is true and the host is LIVE mid-turn, the CURRENT
   * turn is aborted (reason 'interrupted', keepInbox preserved) so the message
   * is the FIRST item of the host's next turn. Default (false) = QUEUE. */
  const busDeliverToHost = async (hostEntry: HostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined, opts?: DeliveryInterruptOptions): Promise<DeliveryStatus> => {
    if (agents === void 0) return 'failed'
    // W7 terminal philosophy (Bug A, PRIMARY): a RETIRED host is terminal — it is
    // NEVER attempted and NEVER recorded (no resume, no materialization, no
    // post-error row). The only registered live host is the rotation successor.
    // Without this gate a stale in-memory Map (the rotation-commit window / a
    // second daemon twin) could still resolve the retired host as live and the
    // delivery catch would record its rows, re-alerting the CURRENT host about a
    // terminal entry forever.
    // Issue-1 HOST-FAMILY EXCEPTION (owner m-331, Option 1): W7 applies as the
    // TERMINAL rule for a NON-host-family address. A HOST-FAMILY recipient id
    // ('host-…') that resolves to a RETIRED / UNRESOLVABLE host entry is instead
    // re-resolved durable-first to the CURRENT LIVE host at the CATALOG seam
    // (busDeliverCatalog, pickLiveHostEntry from a fresh hosts.json read) and
    // delivered there — host-session-<uuid> means "the Asistente" (role), so the
    // re-route honors the sender's intent. This branch therefore only sees a
    // host entry that was ALREADY re-resolved to live, or a directly-addressed
    // NON-host-family retired/unresolvable id.
    if (hostEntry.retired === true) {
      ctx.logger.warn(`[deepartments] bus delivery to RETIRED host "${hostEntry.hostId}" skipped (terminal — a retired host is never attempted or recorded)`)
      return 'failed'
    }
    const sessionId = String(SessionId(hostEntry.sessionId))
    const interrupt = opts?.interrupt === true
    /** One host delivery attempt: an inline followup for a LIVE host, else the
     * D4 resume (with the best-effort 'deepartments' preset mount). Returns the
     * status plus the thrown error, so the W8-i retry below can classify a
     * transient 'session "<id>" not found' WITHOUT losing the message. */
    const attemptHostDelivery = async (): Promise<{ status: DeliveryStatus; error?: unknown }> => {
      try {
        const live = agents.get(sessionId)
        if (live !== void 0) {
          // W9-b interrupt: a LIVE, currently-running host with `interrupt:
          // true` is preempted — abort its CURRENT turn (reason 'interrupted')
          // and preserve any already-pending inbox work (keepInbox).
          // M3 (spec §2.4): the abort is gated by the shared per-recipient
          // interrupt back-off (safeInterrupt) — at most ONE interrupt per
          // recipient per INTERRUPT_COOLDOWN_MS, regardless of identity/class
          // count. A turn just interrupted by the daemon is within the cooldown
          // → it is NEVER interrupted again (the re-entrancy guard); a delivery
          // inside the cooldown races through to QUEUE semantics (no abort).
          if (interrupt && live.status === 'running') {
            const aborted = await safeInterrupt(live, hostEntry.hostId, Date.now(), stateDir)
            if (aborted) {
              ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}": interrupt=true — aborted the current turn (reason 'interrupted'); delivery is the first item of the next turn`)
            } else {
              ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}": interrupt=true but within the per-recipient cooldown — delivery queued (no abort)`)
            }
          }
          live.followup(busUserMessage(record, framed, senderSessionId))
          return { status: 'delivered' }
        }
        // D4 — a dormant host is ALWAYS woken: resume the durable host session.
        // The GUI owns the host composition ('deepartments'), so re-mount it
        // best-effort (mirroring the api-proxy's composeAgent-on-resume); the
        // session's own global-layer tools remain reachable regardless.
        const setup = agentPresets === void 0
          ? undefined
          : (agentCtx: Context): void => {
              void agentPresets.mount(agentCtx, 'deepartments').catch((error: unknown) => {
                ctx.logger.warn(`[deepartments] host resume preset mount failed (bare resume continues): ${error instanceof Error ? error.message : String(error)}`)
              })
            }
        // VARIANT-2 (2026-08-24): WITHOUT a host agentOptions the D4 resume
        // constructs a FRESH ReactLoopAgent with `agent.options = {}` → the
        // request waterfall throws `agent "session-<uuid>" has no provider/model`
        // at the first post-boot host materialization (the host AgentOptions were
        // intermittently empty — see HOST_AGENT_OPTIONS). The D4 setup does NOT
        // installSelection, so a non-empty `this.options` is the ONLY carrier.
        // Mirror WORKER_AGENT_OPTIONS (heads/workers) so the host is symmetric.
        await agents.resume({ resumeSessionId: sessionId, setup, agentOptions: HOST_AGENT_OPTIONS })
        const target = agents.get(sessionId)
        if (target === void 0) throw new Error(`[deepartments] host "${hostEntry.hostId}" could not be materialized for bus delivery`)
        target.followup(busUserMessage(record, framed, senderSessionId))
        return { status: 'resumed' }
      } catch (error: unknown) {
        return { status: 'failed', error }
      }
    }
    const first = await attemptHostDelivery()
    if (first.status !== 'failed') {
      // M3 cascade guard: a SUCCESSFUL materialization clears the host's
      // consecutive-failure counter (a recovered host must not be treated as a
      // threshold already met → an immediate re-quarantine).
      await resetHostMaterializeFailures(stateDir, hostEntry.hostId)
      return first.status
    }
    // W8-i: a SINGLE transient 'session "<id>" not found' first-attempt failure
    // (a host session registered in hosts.json whose durable session is not yet
    // workspace-attached — the harness session-persistence/query seam) must NOT
    // be recorded as a post-error: re-deliver THROUGH the existing host-attach
    // repair seam (await it) BEFORE recording, and record ONLY if the retry
    // ALSO fails — so a later-retried SUCCESSFUL delivery leaves NO trace. A
    // non-'not found' failure records today's row unchanged.
    let recordedError: unknown = first.error
    if (isSessionNotFoundError(first.error)) {
      try {
        await repairHostWorkspaceAttach()
      } catch (repairError: unknown) {
        ctx.logger.warn(`[deepartments] host attach repair (bus-deliver retry) failed for host "${hostEntry.hostId}": ${repairError instanceof Error ? repairError.message : String(repairError)}`)
      }
      const second = await attemptHostDelivery()
      if (second.status !== 'failed') {
        await resetHostMaterializeFailures(stateDir, hostEntry.hostId)
        return second.status
      }
      recordedError = second.error ?? first.error
    }
    ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}" failed: ${recordedError instanceof Error ? recordedError.message : String(recordedError)}`)
    // W6 system-health: record the host materialization/wake failure (the SAME
    // durable anomaly source as the post delivery; postId = the host id). M3
    // (spec §3.3): for EVERY host class the recording is now a PER-(host+class)
    // dedupe in the shared health-alerts-state.json ledger (reusing
    // appendPostErrorDeduped, the W8-i recording ledger) — a PERSISTENT failure
    // of a NON-retired-but-broken host is NEVER re-recorded/re-alerted inside
    // HEALTH_DEDUPE_WINDOW_MS (one per host+class per 30min, NOT per attempt).
    // This is the R1 generic-class write dedupe: a generic (non-session-not-found)
    // failure previously used the PLAIN append → a row EVERY attempt; now ≤1 per
    // (host,class) per window, and the QD directive emit below is gated on an
    // actually-NEW append (not "every attempt").
    try {
      // Bug A SOURCE GATE (the write, not the scan): a RETIRED host's session is
      // terminal (W7). Re-validate against the DURABLE hosts.json ON DISK — the
      // authoritative rotation record — NOT the possibly-stale in-memory `hosts`
      // Map / hostEntry. A long-lived process (a second daemon twin that booted
      // BEFORE a rotation, sharing the stateDir) keeps a STALE in-memory registry
      // that never marks the retired host retired; that stale registry would let
      // this catch append a new post-error ROW forever. Re-reading the on-disk
      // file here closes the stale-twin bypass: the scan gate only suppresses the
      // FINDING; this suppresses the ROW at the source, per the Asistente's
      // "ZERO new rows" acceptance.
      const durableRetiredOnDisk = isHostRetiredOnDisk(stateDir, hostEntry.hostId)
      // Belt-and-suspenders: the in-memory Map check is a FALLBACK for the window
      // where hosts.json is unreadable/malformed (durableRetiredOnDisk === undefined),
      // and never over-suppresses a DURABLY-LIVE host (durableRetiredOnDisk === false
      // is authoritative → the write proceeds).
      const inMemoryRetired = (hosts.get(hostEntry.hostId)?.retired ?? hostEntry.retired) === true
      const durableRetired = durableRetiredOnDisk === true || (durableRetiredOnDisk === undefined && inMemoryRetired)
      if (durableRetired) {
        ctx.logger.warn(`[deepartments] bus delivery to RETIRED host "${hostEntry.hostId}" — post-error ROW write skipped (terminal; durable source gate)`)
        return 'failed'
      }
      // M3 materialization-cascade guard (spec §3.3, R5 — the SAFEST subset of
      // R2/R3): a NON-retired-but-BROKEN host keeps failing materialization →
      // the daemon treats EACH attempt as a fresh anomaly. The per-host
      // consecutive-failure cooldown below NEVER skips the delivery attempt (the
      // durable-retry repair is kept) — it gates only the REPEATED post-error
      // RECORDING (and thus the QD directive) once a host has hit N consecutive
      // failures. The FULL delivery-side quarantine (skipping the attempt to
      // stop the tight-retry loop itself) is DEFERRED (too invasive for a clean
      // additive change; see the M3 report).
      const entry: PostErrorEntry = {
        ts: Date.now(),
        postId: hostEntry.hostId,
        messageId: record.id,
        error: recordedError instanceof Error ? recordedError.message : String(recordedError)
      }
      const matState = readMaterializeState(stateDir)
      const { next: nextMat, quarantined } = markHostMaterializeFailure(matState, hostEntry.hostId, entry.ts)
      await writeMaterializeState(stateDir, nextMat)
      if (quarantined) {
        ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}": ${MATERIALIZE_QUARANTINE_N} consecutive materialization failures — quarantined until ${new Date(entry.ts + MATERIALIZE_QUARANTINE_MS).toISOString()} (post-error recording + QD directive suppressed; the delivery attempt + durable repair are unchanged)`)
        return 'failed'
      }
      const cls = postErrorClass(entry.error)
      const recordKey = `${POST_ERROR_RECORD_KEY_PREFIX}${hostEntry.hostId}:${cls ?? 'generic'}`
      const appended = await appendPostErrorDeduped(stateDir, entry, recordKey, entry.ts)
      // QD (spec 007 §6.4, D-Q4a): after a NEW post-error record is actually
      // appended, trigger the ADDRESSED QUALITY INSPECT directive to quality-head
      // (a dedupe-skip means no new record — do not re-signal). M3: `appended`
      // is now a REAL recording-dedupe result for EVERY class (generic included),
      // so a REPEAT failure inside the window emits NO directive (the old generic
      // branch always returned true → a directive per retry). Non-fatal.
      if (appended) {
        await maybeEmitQualityInspectDirective({ kind: 'post-error', postId: entry.postId, messageId: entry.messageId ?? '', error: entry.error })
      }
    } catch (appendError: unknown) {
      ctx.logger.warn(`[deepartments] post-error capture for host "${hostEntry.hostId}" failed: ${appendError instanceof Error ? appendError.message : String(appendError)}`)
    }
    return 'failed'
  }

  // --- QD (spec 007 Quality Department) RUNTIME hooks — the directive emitter --
  // The QUALITY INSPECT directive: an ADDRESSED bus message to the configured
  // `quality-head`. The hook fires INSIDE plugin-internal functions (retirePost /
  // the head dept_sleep branch / runHostRotation / the bus-delivery catches),
  // NOT a hosted agent's send_message — so the catalog-route ACL would deny it.
  // It therefore delivers via the SAME daemon-not-a-catalog-member notify
  // pattern as the agenda scheduler `notifyHead`
  // (messagesStoreReady.append → busDeliverToPost, invoke.ts:~9781). NEVERTHROW
  // and NEVER-spawn: the whole emit is wrapped in its own try/catch → a failed
  // delivery degrades to ctx.logger.warn and the retire/sleep/rotation it hooks
  // still commits. The directive is the ONLY output — quality-head orchestrates
  // its own workers; the hook NEVER spawns a QD worker.
  /** Resolve the configured `quality-head` post (a registered head — the QD
   * coordinator materialized by `ensureAllHeads` at boot). */
  const resolveQualityHeadEntry = (): PostEntry | undefined => byPost.get('quality-head')

  /**
   * dshd-feedback R7 — the ACL-LEGAL NOTIFICATION FORWARDER: `record.from` for
   * the quality-head notification must be a sender the delivery-engine defensive
   * ACL allows (head→head / host→head allowed; worker→head DENIED). The real
   * `emisor` always travels in the feedback record + the notification body.
   *   - a HEAD (or the host) self-forwards: from = the emisor itself;
   *   - a WORKER forwards as its managerId (the creating head), else as the
   *     coordinator postId of its config department;
   *   - neither resolves → undefined → the caller falls back to the direct QD
   *     seam (`busDeliverToPost` with record.from='deepartments' — the
   *     QD-directive precedent, invoke.ts maybeEmitQualityInspectDirective).
   */
  const feedbackForwarderFor = (emisor: string): string | undefined => {
    const entry = byPost.get(emisor)
    if (entry === undefined) return hosts.has(emisor) ? emisor : undefined
    if (entry.provider !== 'worker') return emisor // a head: self (head→head is legal)
    const manager = entry.managerId
    if (manager !== undefined && byPost.has(manager)) return manager
    const coordinatorPostId = departmentForEntry(entry)?.coordinator?.postId
    if (coordinatorPostId !== undefined && byPost.has(coordinatorPostId)) return coordinatorPostId
    return undefined
  }

  /** dshd-feedback severity-gated delivery options (R7): critico → wake+interrupt;
   * alto → wake (no interrupt); medio/bajo/mejora → no-wake queue. */
  const feedbackDeliveryOptions = (tipo: FeedbackTipo, severidad: FeedbackSeveridad): { noWake: boolean; interrupt?: boolean } => {
    if (tipo === 'mejora') return { noWake: true }
    if (severidad === 'critico') return { noWake: false, interrupt: true }
    if (severidad === 'alto') return { noWake: false }
    return { noWake: true } // medio / bajo
  }

  const maybeEmitQualityInspectDirective = async (surface: QualityInspectDirectiveSurface): Promise<void> => {
    try {
      // QD anti-loop (owner m-178/m-182): the QH's OWN sleep is NOT part of the
      // 100% head-inspect mandate — a 'head-slept' surface whose headPostId is
      // 'quality-head' is gated by the SAME worker dice (D-Q2, default 0.25), so
      // the "QH sleeps each round → q-i → QH wakes → QH sleeps again" feedback
      // cannot recur. ANY OTHER head (and the host rotation, which is not the
      // QH) stays at 100% structural-true. The ENV override affects only the
      // probability path (the QH dice + worker dice), never a non-QH head
      // mandate. The directive gate lives HERE (the surface already carries
      // headPostId); a missed dice simply drops the directive — the dept_sleep
      // still commits.
      // B1 batch bypass: the org-wide `dept_sleep_all` orchestration calls
      // `lifecycle.sleepAll`, which NEVER invokes this emitter (it marks every
      // configured NON-QH head in ONE write and emits ZERO per-head directives)
      // — a batch that slept N heads must not re-wake the QD inspector once per
      // head (the D-Q7 anti-loop). The SINGLE-agent `dept_sleep` path
      // (`sleepMember`) STILL emits its per-head directive here — untouched.
      if (surface.kind === 'head-slept' && !qualityInspectDecision('head', { headPostId: surface.headPostId, rng: Math.random, workerInspectProbability: qualityWorkerInspectProbability })) {
        return
      }
      const qualityHead = resolveQualityHeadEntry()
      if (qualityHead === undefined) return
      const store = await messagesStoreReady
      const text = qualityInspectDirectiveText(surface)
      const record = await store.append({ from: 'deepartments', to: ['quality-head'], text, kind: 'agent' })
      await busDeliverToPost(qualityHead, `[From deepartments → quality-head]: ${text}`, record, void 0)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] quality-inspect directive to "quality-head" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- fb-11: the ROTATION-SUCCESSOR AUTO-WAKE (the host-rotation no-wake
  // defect, QH fb-11) ----------------------------------------------
  // After `runHostRotation` commits (S3/S7 — the NEW hosts.json live entry
  // exists), the new host session is COLD: registered + workspace-attached +
  // artifact-persisted, but NOTHING materializes it — it waits for the first
  // EXTERNAL wake, so an org at rest parks the host (and the governance)
  // indefinitely (evidence: 5c5fc173→024447d9, 2m47s of gap; structural in
  // the 3 prior rotations). This closure is the bundle-side TRANSPORT of the
  // lifecycle's `enqueueHostWake` seam (the lifecycle owns the SEMANTIC MOMENT
  // — the commit; this owns the HOW): it appends a DURABLE 'rotation-wake'
  // bus record from 'deepartments' to the NEW host id and delivers it via the
  // D4 host delivery — the SAME dormant-host resume seam external traffic
  // uses (`busDeliverToHost` → `agents.resume` + followup), so the new session
  // starts its first turn with the wake pack / the new sessionId identity and
  // NO external traffic; journal/handoff untouched (the rotation already
  // re-keyed).
  // Write-ahead + exactly-once (mission test 4): the record is flushed to
  // messages.jsonl BEFORE the delivery (durable-first, the store's own
  // persist-before-deliver contract), the delivery is attempted exactly ONCE
  // and NO delivery-sidecar row is written — deliberately mirroring the QD-
  // directive daemon-notify pattern (maybeEmitQualityInspectDirective above:
  // store.append + DIRECT busDeliverToPost). The delivery-engine route is NOT
  // usable here: `deliverOrQueue`'s defensive ACL gate would DENY a
  // 'deepartments'-from record (an unclassified sender — acl.ts
  // 'unclassified-sender', delivery.ts catalogRoute), and a sidecar
  // 'prepared' row would make the BOOT re-delivery pass re-drive it through
  // that same denied route → a 'failed' row the W6 health scan re-alerts on
  // every boot. With NO sidecar row there is no boot re-drive and no W6
  // anomaly: one record, one delivery, no double tuple. A delivery failure
  // only warns (the rotation already committed; a later external wake or boot
  // resumes the host — crash windows spec 002 §3.6). NEVER throws.
  const enqueueHostWake = async (wake: { newHostId: string; newSessionId: string; sleepEpoch: number }): Promise<void> => {
    if (agents === void 0) return
    try {
      const text = `[deepartments] host session rotation complete (spec 002): session ${wake.newSessionId} is now the registered host (sleepEpoch ${wake.sleepEpoch}); the rotation persisted your re-keyed journal and archived the previous session whole; this is the rotation's OWN successor handoff — no external traffic. Start your turn and run your wake routine.`
      // Durable FIRST (write-ahead): the record is on disk before any delivery
      // (MessagesStore.append flushes awaited — persist-before-deliver).
      const store = await messagesStoreReady
      const record = await store.append({ from: 'deepartments', to: [wake.newHostId], text, kind: 'notice' })
      const hostEntry = hosts.get(wake.newHostId)
      if (hostEntry === void 0) {
        ctx.logger.warn(`[deepartments] rotation wake: new host entry "${wake.newHostId}" not found in the in-memory registry (record ${record.id} stays durable)`)
        return
      }
      const framed = `[From deepartments → ${wake.newHostId}]: ${text}`
      await busDeliverToHost(hostEntry as HostEntry, framed, record, void 0)
      ctx.logger.info?.(`[deepartments] rotation wake: delivered to the new host ${wake.newHostId} (record ${record.id}; session ${wake.newSessionId} started its first turn)`)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] rotation wake failed (non-fatal — the rotation already committed; a later external wake or boot resumes the host): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- FASE 2 STEP f (lifecycle carve) ---------------------------------------
  // The dept_sleep / dept_memo_write SEMANTICS are owned by the core lifecycle
  // service (./core/lifecycle.js): the sleepEpoch marking policy + idempotent
  // re-issue no-op + journal requirement, the host-rotation decision (delegating
  // to ./core/session-rotation.js), and the journal/archive policy. The TOOLS
  // below still register here (their MODEL-FACING contract is unchanged) but now
  // DELEGATE to `lifecycle`. ONE service per apply, deps injected from these
  // closures (AGENTS.md rule 4 — no module-global mutable state). The service is
  // constructed AFTER every closure it consumes is defined (this point); the
  // tool `execute` handlers reference `lifecycle` lazily, so even the earlier
  // head own-layer registrations (installHeadBoardTools) bind it correctly at
  // tool-call time.
  // FASE 2.5 BATCH B: consume the lifecycle SERVICE from dshd-core when composed;
  // fall back to a behavior-neutral in-bundle construction + warn in a minimal
  // composition (dshd-core absent).
  const lifecycle = (ctx.get('deepartments.lifecycle') as LifecycleService | undefined) ?? (() => {
    ctx.logger.warn('[deepartments] dshd-core is not composed — the lifecycle service is constructed in-bundle (behavior-neutral fallback).')
    return createLifecycleService({
      byPost,
      hosts,
      hostForSession,
      postIdForChild,
      hostIdForSession,
      ensureHost,
      persistPosts,
      persistHosts,
      journalPath: (memberId) => journalPathFor(memberId),
      writeJournal,
      readJournal,
      bumpHostSleepCounter,
      bumpPostSleepCounter,
      archivePostSessionOnSleep,
      disposeHeadHandleOnce,
      maybeEmitQualityInspectDirective,
      runHostRotation,
      // fb-11 — the ROTATION-SUCCESSOR AUTO-WAKE seam (bundle transport).
      enqueueHostWake,
      deptGet: (key) => ctx.get(key),
      stateDir: stateDir,
      deferredSleepReplace,
      wakePackInjected,
      buildSleepJournalMessage,
      logger: ctx.logger
    })
  })()

  // --- F2 (spec 004 §5.6): messaging ACL by department — catalog route ONLY --
  // THE FRONTIER (documented, per spec §5.6): the ACL gates ONLY the catalog
  // route. The CHILD route (subagents.followup — the Asistente's transient
  // builders/reviewers) is OUTSIDE the ACL: children are never catalog
  // members (the router decides child-first precisely because the two id sets
  // are disjoint), so they can never reach a check below; department workers
  // are ROOT catalog agents (never children), so the ACL always applies to
  // them. 'self' is always allowed (held by the ack-loop guard, never woken).
  // The SAME pure predicate gates (1) the send_message persist filter — the
  // record's to[] is ONLY the ACL-allowed recipients (the denied never touch
  // the record or the delivery sidecar, per spec §5.6 the denied surface only
  // in the tool result) — and (2) the catalog delivery seam (defensively, so
  // a boot re-delivery of a PRE-ACL record can never bypass the gate).
  // NOTE: `BusMemberProfile` / `BusSendResult` are imported from ./core/delivery.js
  // (step c). The ACL SEMANTICS (busProfileFor / aclDenyGround) live in the PURE
  // ./core/acl.js (FASE 2 step d) — the catalog-route-only predicate is NOT
  // INLINE here anymore. invoke.ts binds the apply catalog (the durable
  // posts/hosts registries + the config department resolver) onto the pure
  // `busProfileFor` and consumes the pure `aclDenyGround` directly; the
  // delivery engine (delivery.ts) re-checks the SAME pure predicate defensively.
  // FASE 2.6-C: consume the dshd-core ACL SERVICE when composed — the core ACL
  // is fed the SAME departments mirror (relocated to the dshd-core config in
  // 2.6-A), so it is BEHAVIOR-IDENTICAL (same grounds 'host' /
  // 'other-department' / 'unclassified'; worker→host PROHIBIDO intact). The
  // bundle keeps its own busCatalogLens/busProfileFor ACL as the fallback in a
  // minimal composition (dshd-core absent).
  const aclService = ctx.get('deepartments.acl') as AclSurface | undefined
  const busCatalogLens: BusCatalogLens = { byPost, hosts, departmentForPost }
  const busProfileFor = aclService?.busProfileFor ?? ((memberId: string): BusMemberProfile => aclBusProfileFor(memberId, busCatalogLens))
  const aclDenyGround = aclService?.aclDenyGround ?? aclDenyGroundImpl

  /** The bus catalog-route resolver (spec §4.2 route 2): resolve a recipient
   * against the DURABLE catalog — posts.json (head/worker) then non-retired
   * hosts.json — PLUS the Issue-1 (owner m-331) host-family re-route: a
   * `host-…` address that resolves to a RETIRED / UNRESOLVABLE KNOWN host entry
   * is re-resolved DURABLE-FIRST to the CURRENT LIVE host
   * (pickLiveHostEntry from a FRESH hosts.json read) ONLY when the address is a
   * REAL host id in hosts.json. ALTO-2 (m-891): a `host-*` id ABSENT from
   * hosts.json — a typo / never-registered uuid — resolves UNKNOWN → the
   * delivery engine settles 'failed' per-recipient (the ghost-delivery fix);
   * `host-session-<uuid>` means "the Asistente" (role) ONLY for a genuinely
   * registered (live or retired) host id, so the m-331 re-route still honors
   * the sender's intent for real hosts; W7 (a retired host is terminal) is NOT
   * revoked, it stays for NON-host-family ids.
   * This resolver returns the candidate entry WITHOUT applying the ACL / retired
   * gates — the DELIVERY ENGINE (./core/delivery.js) owns those (the defensive
   * gate, step (c)). `{ kind: 'unknown' }` = no catalog member / not re-routable
   * (the message settles 'failed' as today — no retry loop).
   * TODO(owner): stable host alias. */
  const resolveBusCatalogRoute = (recipientId: string): CatalogRoute => {
    const entry = byPost.get(recipientId)
    if (entry !== void 0) return { kind: 'post', entry }
    const hostEntry = hosts.get(recipientId)
    if (hostEntry !== void 0 && hostEntry.retired !== true) return { kind: 'host', entry: hostEntry }
    if (recipientId.startsWith(HOST_ID_PREFIX)) {
      // ALTO-2 (m-891, QD audit 2026-08-28 F2 — ghost delivery): the Issue-1
      // host-family re-route fires ONLY for a `host-…` address that is a KNOWN
      // host id in the durable hosts.json — a LIVE entry matched above, or a
      // RETIRED real entry (the m-331 role-intent re-route: `host-session-<uuid>`
      // means "the Asistente", so a REAL formerly-valid host id is re-routed to
      // the current live host). A `host-*` id ABSENT from hosts.json — a typo /
      // never-registered uuid (m-891 sent to '…ea3232b' vs the real '…ea32b') —
      // is NOT the Asistente's address: it resolves UNKNOWN, so the delivery
      // engine settles 'failed' per-recipient exactly like an unknown post — NO
      // prepared→delivered ghost, no silent content loss. The m-380 thread (an
      // unknown non-host session id → failed) is the same 'unknown' path,
      // untouched.
      const durableHosts = readDurableHostEntries(stateDir)
      const registry = durableHosts ?? [...hosts.values()]
      const known = registry.some((host) => host.hostId === recipientId)
      if (known) {
        const { live } = pickLiveHostEntry(registry)
        if (live !== void 0) return { kind: 'reroute', entry: live as HostEntry }
      }
    }
    return { kind: 'unknown' }
  }

  /**
   * Deliver ONE addressed record to ONE recipient and record the sidecar
   * transition (write-ahead 'prepared' → final status; spec §4.4) — a THIN
   * wrapper over the DELIVERY ENGINE's single seam (`delivery.deliverOrQueue`,
   * FASE 2 step (c)). Kept with the legacy signature so the internal callers
   * (dept_job_run / dept_worker_spawn / dept_post_create first-message
   * deliveries + the boot re-delivery driver) route through the SAME gate; NEW
   * code should call `delivery.deliverOrQueue` directly. THIS is the idempotent
   * re-delivery unit: send_message calls it after persisting, and the boot
   * re-delivery driver re-runs it for crash-pending pairs. Route order per
   * recipient (spec §4.2): child route FIRST (the caller's direct continuable
   * children — never validated against the catalog), then the catalog
   * (posts.json ∪ non-retired hosts.json); unknown ids → failed. `opts.noWake`
   * (B2) is threaded through so an internal caller can set it, but the CURRENT
   * default (absent = always-wake) is unchanged — only threading the option.
   */
  const deliverBusRecord = async (
    record: MessageRecord,
    recipientId: string,
    callerAgentId: string,
    senderSessionId: string | undefined,
    signal?: AbortSignal,
    opts?: DeliveryInterruptOptions & { noWake?: boolean }
  ): Promise<DeliveryStatus> =>
    delivery.deliverOrQueue(recipientId, record, {
      callerAgentId,
      senderSessionId,
      signal,
      interrupt: opts?.interrupt,
      noWake: opts?.noWake
    })

  /** The live parent Agent for the native-route followup (the caller is the
   * direct parent, per the route resolution above). Resolved from the agents
   * registry — `exec.agent` is not retained past the tool execute frame. */
  const exec_agentFor = (sessionId: string): AgentLike => {
    const parent = agents?.get(sessionId)
    if (parent === void 0) throw new Error(`[deepartments] bus child route requires the live caller agent "${sessionId}"`)
    return parent
  }

  /** The caller's BUS member id (spec §3.1: durable member id, never a session
   * id): the postId for a registered head/worker, else the deterministic
   * `host-<sessionId>` id for a host/plain session. */
  const busMemberIdFor = (agentId: string): string => postIdForChild(agentId) ?? hostIdForSession(agentId)

  // --- FASE 2 step (c): the DELIVERY ENGINE (./core/delivery.js) -------------
  // The single bus delivery seam. The engine owns the `deliverOrQueue` gate +
  // the per-recipient delivery orchestration (write-ahead 'prepared' → route →
  // final), the catalog route, the defensive ACL application, and the `noWake`
  // gate (INERT today). The CLOSURE-BOUND primitives below are INJECTED as deps:
  // the child route (resolveBusChild / deliverBusChild), the catalog resolver
  // (resolveBusCatalogRoute), the ACL predicate (the pure busProfileFor /
  // aclDenyGround from ./core/acl.js — FASE 2 step (d); invoke.ts binds the
  // catalog lens onto `busProfileFor`), and the always-wake primitives
  // (busDeliverToPost / busDeliverToHost). Constructed ONCE per apply
  // (AGENTS.md rule 4).

  /** Resolve whether `recipientId` is the caller's direct CONTINUABLE child
   * (delivered natively, never catalog-validated). Never throws — a listing
   * failure (minimal composition) means "not a child", the catalog route next. */
  const resolveBusChild = async (recipientId: string, callerAgentId: string, signal?: AbortSignal): Promise<boolean> => {
    if (subagents === void 0) return false
    try {
      const children = await subagents.listChildren(SessionId(callerAgentId), signal ?? undefined)
      return children.some((child) => child.kind === 'child' && child.mode === 'continuable' && String(child.id) === recipientId)
    } catch {
      // listing unavailable (minimal composition): no child route — catalog next
      return false
    }
  }

  /** Deliver ONE bus message to a continuable child (native followup). Returns
   * 'delivered' or 'failed' (never throws). W9-b interrupt is NOT threaded into
   * the child route (a continuable child has no abort seam here — children are
   * always queue-delivered). */
  const deliverBusChild = async (callerAgentId: string, recipientId: string, record: MessageRecord, framed: string, senderSessionId: string | undefined, signal?: AbortSignal): Promise<DeliveryStatus> => {
    if (subagents === void 0) return 'failed'
    try {
      await subagents.followup(
        await exec_agentFor(callerAgentId) as unknown as Parameters<typeof subagents.followup>[0],
        SessionId(recipientId),
        // W8-b prompt-literal safety: the child-followup text (bus message
        // content injected into a continuable child) is run through the brace
        // sanitizer so an unbound double-brace token can never break the child
        // session assembly.
        [{ type: 'text', text: sanitizePromptLiterals(framed) } as const],
        {
          // W7-B: the SAME JSON-safe projection as `busUserMessage` — the
          // child-followup source is inserted into a durable session too, so a
          // present-undefined `senderSessionId` / branded value must never reach
          // the `agent/inbox/spliced` append boundary.
          source: jsonSafeMessageSource({
            kind: 'agent',
            form: 'send',
            plugin: 'deepartments',
            summary: boundContextSummary(`New message from ${record.from} to ${record.to.length} recipient(s) (${record.kind}).`),
            to: [...record.to],
            messageId: record.id,
            from: record.from,
            senderSessionId: senderSessionId === undefined ? undefined : SessionId(senderSessionId)
          }),
          // A bare { agent, signal } tool exec is the test surface; the
          // ABORT_SIGNAL default is never reached in production harness runs
          // (exec.signal is always present there).
          signal: signal ?? new AbortController().signal
        }
      )
      return 'delivered'
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] bus child-followup to "${recipientId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    }
  }

  /** The delivery engine: the SINGLE bus delivery seam (constructed once per
   * apply, deps injected — AGENTS.md rule 4, no module-global mutable state).
   * Consumed by send_message (directly) and by the `deliverBusRecord` wrapper
   * (dept_job_run / dept_worker_spawn / dept_post_create + the boot re-delivery
   * driver). FASE 2.5 BATCH B: consume the delivery SERVICE from dshd-core when
   * composed; fall back to a behavior-neutral in-bundle construction + warn in a
   * minimal composition (dshd-core absent). */
  const delivery = (ctx.get('deepartments.deliver') as DeliveryEngine | undefined) ?? (() => {
    ctx.logger.warn('[deepartments] dshd-core is not composed — the delivery engine is constructed in-bundle (behavior-neutral fallback).')
    return createDeliveryEngine({
      stateDir: messageStoreDir,
      logger: ctx.logger,
      markPrepared: (record, recipientId) => markDelivery(messageStoreDir, record.id, recipientId, 'prepared'),
      markFinal: (record, recipientId, status) => markDelivery(messageStoreDir, record.id, recipientId, status),
      subagents,
      resolveChild: resolveBusChild,
      deliverChild: deliverBusChild,
      resolveCatalogRoute: resolveBusCatalogRoute,
      busProfileFor,
      deliverPost: busDeliverToPost,
      deliverHost: busDeliverToHost
    })
  })()

  /** B3 (m-361): whether a CATALOG recipient is DORMANT — its durable entry
   * (posts.json `byPost` OR hosts.json `hosts`) carries a `sleepEpoch` mark
   * (deliberately asleep by a sleep directive; its pending queue drains at its
   * next real wake). A child-route / unknown recipient has NO catalog entry →
   * never dormant (a transient subagent or unknown id is never no-waked by B3).
   * Used by send_message to no-wake ONLY the ack to a just-slept head — the
   * m-361 regression where a QD ack re-woke a head that had just dept_slept. */
  const isDormantRecipient = (recipientId: string): boolean => {
    const post = byPost.get(recipientId)
    if (post !== void 0) return post.sleepEpoch !== void 0
    const host = hosts.get(recipientId)
    return host !== void 0 && host.sleepEpoch !== void 0
  }

  /** B3 gap fix (reviewer B2 note a): with the board gone, the host's
   * auto-registration must not depend on board tools. For every host-family
   * caller (no post entry; NOT a transient subagent) dept_who / send_message
   * run ensureHost(self) — idempotent: a first registration (no host in
   * hosts.json) registers the caller; a refresh of an existing live entry
   * MERGES (rotation metadata preserved); and the single-live-host guard
   * inside ensureHost means a second live host is NEVER minted (a refused
   * session stays a plain session, with the guard warn). Returns the
   * caller's member id. */
  const busEnsureHostForCaller = (callerAgent: { id: string; session?: { header?: SessionHeaderWithOrigin } }): string => {
    const agentId = callerAgent.id
    const postId = postIdForChild(agentId)
    if (postId !== undefined) return postId
    // A transient subagent is never a host session (origin subagent).
    const header = callerAgent.session?.header
    const origin = header?.origin ?? header?.meta?.origin
    if (origin !== 'subagent') {
      ensureHost(agentId, 'board')
    }
    return hostIdForSession(agentId)
  }

  /** Shared framing for every bus deliver (spec §4.3): the GUI never renders
   * `to[]`, so sender + recipients MUST be in the model-facing text. */
  const busFraming = (record: MessageRecord): string =>
    `[From ${record.from} → ${record.to.join(', ')}]: ${record.text}`

  /** The 1..20 fan-out guard (spec §4.4): the JSON schema subset cannot express
   * minItems/maxItems, so the cap is enforced here — a hard error above 20. */
  const assertBusFanOut = (to: readonly string[]): number => {
    if (!Array.isArray(to) || to.length === 0) throw new Error('[deepartments] send_message: `to` must list at least one recipient')
    if (to.length > 20) throw new Error(`[deepartments] send_message: fan-out cap is 20 recipients (got ${to.length})`)
    return to.length
  }
// ---------------------------------------------------------------------------
  // The delivery surface the rest of applyInvoke consumes (the SAME handles the
  // zone previously exposed at these positions in the fiber — the downstream
  // code is unchanged, only the origin moved).
  // ---------------------------------------------------------------------------
  return {
    messageStoreDir,
    messagesStoreReady,
    feedbackStoreReady,
    freshMintHead,
    busDeliverToPost,
    busDeliverToHost,
    resolveQualityHeadEntry,
    feedbackForwarderFor,
    feedbackDeliveryOptions,
    maybeEmitQualityInspectDirective,
    enqueueHostWake,
    lifecycle,
    busProfileFor,
    aclDenyGround,
    resolveBusCatalogRoute,
    deliverBusRecord,
    busMemberIdFor,
    resolveBusChild,
    deliverBusChild,
    delivery,
    isDormantRecipient,
    busEnsureHostForCaller,
    assertBusFanOut
  }
}