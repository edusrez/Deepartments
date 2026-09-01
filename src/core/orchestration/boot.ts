/**
 * Deepartments — DECOUPLING ZONA 7: BOOT ORCHESTRATION FACTORY (HITO 3
 * DECOUPLING closure — the 5th and LAST orchestration factory): the BOOT zone
 * of `applyInvoke` — the optional continuation services + the SHARED CONFIG
 * SOURCE resolution (deepartments.org service-first, cfg fallback), the DURABLE
 * REGISTRY (deepartments.catalog service-first, RegistryStore fallback) + the
 * QD dice + the per-head/host live maps (byHeadHandle / disposingHeads /
 * headProgress / headRecoveryQueues / wakePackInjected / deferredSleepReplace),
 * the C1/C3 catalog machinery (buildCatalogRows / activeCatalogMembers /
 * activeMembersSchema / renderActiveRoster), the R1 lifecycle tool builders
 * (memoWriteTool / sleepTool / postRetireTool), the host registry surface
 * (persistHosts / ensureHost / hostIdForSession / persistPosts / registerEntry
 * / postIdForChild), the Feature-A presence state + host-notify + ask_user
 * guard (presenceCache / refreshPresence / savePresence / notifyHostPresence),
 * the cold-load promises (registryLoaded / hostsLoaded), the ONE-TIME web-UI
 * sleep cleanup hook (runPendingWebUiCleanups) and the boot host-attach repair
 * hook (HOST_ATTACH_REPAIR_* / repairHostWorkspaceAttach) — 678 LOCs of
 * `applyInvoke`, src/invoke.ts 2344-3021 (the zone region INCLUDES the
 * applyInvoke opener line at 2344 — that single line stays in invoke.ts as the
 * coordinator-block opener, byte-identical, and the 677 content lines
 * 2345-3021 move here VERBATIM).
 *
 * MOVEMENT-ONLY. The zone is hoisted VERBATIM into this factory, and
 * `applyInvoke` invokes it via `createBootOrchestration` AT THE SAME FIBER
 * POSITION — the same closures, the same order, the same semantics (0 behavior
 * change). The state these closures read/mutate is the SAME by-reference
 * maps/registries passed in `deps`; the bindings the zone CREATES (subagents /
 * agents / agentPresets / stateDir / org / registry / byPost / byChild /
 * hosts / hostForSession / the lifecycle tool builders / the presence surface)
 * are new apply-fiber bindings returned as the BootSurface and rebound by the
 * apply-fiber destructure at the SAME position (the rest of applyInvoke — the
 * presets/spawn/tools/delivery factories + the daemons — reads the SAME
 * bindings).
 *
 * SEAM DECISIONS (documented, MOVEMENT-ONLY preserved):
 *  - the zone is 2344-3021 (678 LOCs per the region); the FIRST line (2344,
 *    `export function applyInvoke(...)`) is the apply function's OWN opener and
 *    CANNOT move — it stays in invoke.ts as the coordinator-block opener
 *    (byte-identical), exactly like the presets cut kept the B3-note seam
 *    (3019-3021) in invoke.ts. The MOVED content = 2345-3021 (677 LOCs),
 *    byte-identical md5 (the lock stamps this number + hash).
 *  - the zone's module-scope helpers of invoke.ts (readPresenceStateFile /
 *    writePresenceStateFile / askUserGuardReason / pinHostSessionTitle — pure,
 *    not importable without a require cycle) are passed BY REFERENCE in deps
 *    (the SB4 consumer pattern, like isUsableAgentOptions/writeJournal stayed).
 *  - 3 LATE seams (bindings declared LATER on the apply fiber, TDZ-safe
 *    getters — dereferenced ONLY at CALL time by post-boot closures): the
 *    PresetsSurface `coordinatorForPost` (buildCatalogRows dereferences it at
 *    execution time — the presets factory runs after this one), the
 *    DeliverySurface `lifecycle` (memoWriteTool/sleepTool executes), the
 *    ToolsSurface `retirePost` (postRetireTool execute). The factory rebinds
 *    all three as delegating LOCAL bindings over the `late` getters (the
 *    spawn.ts workerSetup pattern).
 * 0 ctx.provide (the P1 invariant, asserted by the lock).
 *
 * Pattern (the PASO 1 / sub-pasos 2-6 proof): closures hoisted → the late
 * seams passed as `late` GETTERS → rebound as delegating locals → the surface
 * returned at the SAME positions. The bundle stays a PURE SERVICE CONSUMER:
 * this factory performs NO ctx.provide (P1 — the `deepartments.boot` service
 * surface the brief planned via ctx.provide is deferred to the hito-4 package
 * migration; the seams are the returned BootSurface members).
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import path from 'node:path'
import { computeDeptWhoState } from '../../agents.js'
import type { DeptWhoState } from '../../agents.js'
import type { Config, CoordinatorConfig, DepartmentConfig, PostsRetentionConfig } from '../../org.js'
import { RegistryStore, pickLiveHostEntry } from '../registry.js'
import type { PostEntry, HostEntry } from '../registry.js'
import { findSessionArtifact, runSleepCleanup } from '../session-cleanup.js'
import { shouldClearCleanupPending } from '../lifecycle.js'
import type { LifecycleService } from '../lifecycle.js'
import { ASISTENTE_SESSION_TITLE } from '../session-rotation.js'
import type { WorkspaceRegistryLike } from '../session-rotation.js'
import { buildPresenceMessage } from '../wakepack.js'
import { resolveQualityWorkerInspectProbability } from '../quality.js'
import type { PresenceState } from '../gui.js'

// ---------------------------------------------------------------------------
// Local structural mirrors of the bundle-local harness views (src/invoke.ts
// declares these at module scope but does NOT export them — the export-parity
// lock freezes lib/invoke.js's export surface, so the factory re-declares the
// EXACT same structural shapes instead of importing from the bundle module
// (which would also create a require cycle). The FULL invoke.ts shapes (not a
// reduced read-subset) so the BootSurface members stay assignable to the
// spawn/tools/delivery factory deps the same way the apply-scope bindings are.
// ---------------------------------------------------------------------------

/** Structural view of a live `Agent` (the shape `ctx.agents.get(id)` returns).
 * Mirrors the bundle-local `AgentLike` of src/invoke.ts verbatim — the boot
 * zone reads `.status` / `.session?.events` / `.followup` (Fix A2 + the A3
 * presence notify). */
interface AgentLike {
  id: string
  status: string
  ctx: Context
  session?: { events: unknown[] }
  followup(message: { content: readonly { type: string; text: string }[]; source: Record<string, unknown> }): void
  cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
}

/** Agent-scoped creation options (the F7 worker route). Mirrors the
 * bundle-local `AgentOptionsLike` of src/invoke.ts. */
interface AgentOptionsLike {
  provider?: string
  model?: string
  maxTokens?: number
  reasoningEffort?: string
}

/** Structural view of the `AgentHandle` returned by ctx.agents.create/resume
 * (`dispose()` is the sleep teardown; held ONLY by the plugin owner). Mirrors
 * the bundle-local `AgentHandleLike` of src/invoke.ts verbatim. */
interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

/** Structural view of the `agents` service surface. Mirrors the bundle-local
 * `AgentsLike` of src/invoke.ts verbatim (get/list/roots/create/resume — the
 * full surface the downstream spawn/tools/delivery factories consume). */
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

/** Structural view of the `agentPresets` service surface (resolve/mount).
 * Mirrors the bundle-local `AgentPresetsLike` of src/invoke.ts verbatim. */
interface AgentPresetsLike {
  resolve(id: string): Promise<unknown>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** The A3 `ask_user_question` guard hooks (mirrors the bundle-local
 * `AskUserGuardHooks` of src/invoke.ts — exported there, mirrored here to
 * avoid a require cycle). */
interface AskUserGuardHooks {
  present(): boolean
  isHostAgent(sessionId: string): boolean
}

/** The host session-title pin result (mirrors the bundle-local
 * `HostTitlePinResult` of src/invoke.ts — same union, mirrored here). */
type HostTitlePinResult = 'pinned' | 'already-titled' | 'failed'

/** The shared C1/C3 catalog row shape (the dept_who-like row builder). The
 * bundle-local `CatalogRow` of src/invoke.ts is declared INSIDE the moved zone
 * verbatim (function-scope); this module-scope mirror types the BootSurface
 * member `buildCatalogRows` (structural identity, same shape). */
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

/** The apply-scope bindings the BOOT zone captures (src/invoke.ts bindings +
 * the invoke.ts module-scope pure helpers), passed BY REFERENCE — the factory
 * reads and mutates the SAME maps/registries the rest of applyInvoke uses
 * (AGENTS.md rule 4 — no module-global mutable state; the instance lives on
 * the apply fiber). `late` carries the seams that do NOT exist at the
 * invocation position (2344): GETTERS over the apply-scope bindings the zone
 * dereferences at CALL time (post-boot). */
export interface BootFactoryDeps {
  /** The apply config (resolveQualityWorkerInspectProbability + the
   * coreOrg/cfg shared-source fallback read it). */
  config: Config
  /** The presence-file reader (module-scope pure helper of invoke.ts — not
   * importable without a cycle, passed by reference). */
  readPresenceStateFile: (stateDir: string) => PresenceState
  /** The presence-file writer (module-scope pure helper of invoke.ts — by
   * reference). */
  writePresenceStateFile: (stateDir: string, state: PresenceState) => Promise<void>
  /** The A3 ask_user guard reason helper (module-scope pure helper of
   * invoke.ts — by reference). */
  askUserGuardReason: (exec: { name?: unknown; agent?: { id?: unknown } }, hooks: AskUserGuardHooks) => string | undefined
  /** The live-host session-title pin (module-scope pure helper of invoke.ts —
   * by reference). */
  pinHostSessionTitle: (session: Session) => HostTitlePinResult
  /** LATE seams — bindings built AFTER this factory position, dereferenced
   * ONLY at CALL time by the zone's post-boot closures (the apply-scope TDZ is
   * never entered): the PresetsSurface `coordinatorForPost` (buildCatalogRows
   * executes), the DeliverySurface `lifecycle` (memoWriteTool/sleepTool
   * executes) and the ToolsSurface `retirePost` (postRetireTool execute). */
  late: {
    /** The presets-surface coordinator resolver (presets factory position). */
    coordinatorForPost: (postId: string) => CoordinatorConfig | undefined
    /** The delivery-surface lifecycle service (delivery factory position). */
    lifecycle: LifecycleService
    /** The tools-surface worker-retire path (tools factory position). */
    retirePost: (postId: string, callerAgentId: string) => Promise<{ postId: string; retired: true }>
  }
}

/** The zone-declared members the rest of applyInvoke consumes at the SAME
 * positions (the presets/spawn/tools/delivery factories + the daemons + the
 * P1 composed services) — rebound by the apply-fiber destructure. `subagents`
 * through `repairHostWorkspaceAttach` are the 40 surface members; the zone's
 * internal bindings (coreOrg / cfg / headRecoveryQueues / CatalogRow /
 * runPendingWebUiCleanups) stay factory-local and are NOT returned. */
export interface BootSurface {
  subagents: SubagentRuntime | undefined
  agents: AgentsLike | undefined
  agentPresets: AgentPresetsLike | undefined
  stateDir: string
  org: Config['org']
  registry: RegistryStore
  byPost: Map<string, PostEntry>
  qualityWorkerInspectProbability: number
  byChild: Map<string, string>
  byHeadHandle: Map<string, AgentHandleLike>
  disposingHeads: Map<string, Promise<void>>
  headProgress: Map<string, { at: number; eventCount: number }>
  serializeHeadRecovery: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  wakePackInjected: Set<string>
  deferredSleepReplace: Map<string, string>
  hosts: Map<string, HostEntry>
  hostForSession: Map<string, string>
  buildCatalogRows: () => CatalogRow[]
  activeCatalogMembers: () => Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }>
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
  renderActiveRoster: (members: ReadonlyArray<{ agentId: string; kind: string; title: string }>) => string
  memoWriteTool: (hostPlane: boolean) => ReturnType<typeof defineTool>
  sleepTool: (hostPlane: boolean) => ReturnType<typeof defineTool>
  postRetireTool: ReturnType<typeof defineTool>
  persistHosts: () => void
  ensureHost: (sessionId: string, roomId: string) => string
  hostIdForSession: (sessionId: string) => string
  persistPosts: () => Promise<void>
  registerEntry: (entry: PostEntry) => void
  postIdForChild: (childId: string) => string | undefined
  presenceCache: PresenceState
  refreshPresence: () => void
  savePresence: (state: PresenceState) => Promise<void>
  notifyHostPresence: (present: boolean) => void
  registryLoaded: Promise<void>
  hostsLoaded: Promise<void>
  HOST_ATTACH_REPAIR_RETRY_MS: number
  HOST_ATTACH_REPAIR_TIMEOUT_MS: number
  repairHostWorkspaceAttach: () => Promise<void>
}

/**
 * Build the BOOT ORCHESTRATION surface on the apply fiber (AGENTS.md rule 4 —
 * no module-global mutable state; invoked by applyInvoke at the SAME fiber
 * position where the hoisted zone used to live). The closures below are the
 * ORIGINAL zone closures, moved VERBATIM — the diff is movement-only.
 */
export function createBootOrchestration(ctx: Context, deps: BootFactoryDeps): BootSurface {
  const {
    config,
    readPresenceStateFile,
    writePresenceStateFile,
    askUserGuardReason,
    pinHostSessionTitle,
    late
  } = deps

  // The LATE seams — resolved AT CALL TIME through the accessor object (the
  // PresetsSurface/DeliverySurface/ToolsSurface members are built LATER on
  // this fiber; the zone dereferences them only when the catalog rows are
  // built (dept_who executes) or a lifecycle/retire tool fires — post-boot —
  // so the apply-scope TDZ is never entered). Rebinding as delegating locals
  // (the spawn.ts workerSetup pattern) keeps the VERBATIM zone text
  // referencing the SAME names.
  const coordinatorForPost: BootFactoryDeps['late']['coordinatorForPost'] = (...args) => late.coordinatorForPost(...args)
  const lifecycle: BootFactoryDeps['late']['lifecycle'] = {
    memoWrite: (...args) => late.lifecycle.memoWrite(...args),
    sleepMember: (...args) => late.lifecycle.sleepMember(...args),
    sleepHost: (...args) => late.lifecycle.sleepHost(...args),
    sleepAll: (...args) => late.lifecycle.sleepAll(...args)
  }
  const retirePost: BootFactoryDeps['late']['retirePost'] = (...args) => late.retirePost(...args)

  // =========================================================================
  // BOOT ZONE (hoisted VERBATIM from applyInvoke 2345-3021 — 677 of the 678
  // region LOCs [2344-3021]: the applyInvoke opener at 2344 stays in invoke.ts
  // as the coordinator-block opener; this embedded text is byte-identical,
  // md5 stamp in the lock).
  // =========================================================================  // --- optional continuation services (resolved, not injected: the plugin
  // must load in minimal compositions — the board core keeps working, the
  // invoke/relay features fail loud at use when the services are absent) ---
  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents') as AgentsLike | undefined
  // The agentPresets service is also resolved OPTIONALLY (absent in minimal /
  // hermetic compositions): the head setup mounts the 'deepartments-head'
  // preset when present, and ALWAYS registers its board tools regardless.
  const agentPresets = ctx.get('agentPresets') as AgentPresetsLike | undefined

  // FASE 2.6 BATCH A (config relocation): the org config + stateDir are relocated
  // to dshd-core, which exposes them as `deepartments.org` — the SHARED CONFIG
  // SOURCE. The bundle reads THAT source first and falls back to its own patch
  // config (config.stateDir / config.org) in a minimal/hermetic composition (e.g.
  // the hermetic real-Loader tests, where dshd-core is NOT composed).
  // BEHAVIOR-NEUTRAL: the fallback resolves to EXACTLY config.stateDir /
  // config.org, and when dshd-core is composed the values are the SAME (the
  // dshd-core row carries the org). `stateDir`/`org` are the ONLY local bindings
  // every consumer below reads (they replace the direct config.* reads).
  const coreOrg = ctx.get('deepartments.org') as
    | { stateDir?: string; org?: { departments?: DepartmentConfig[]; execRoots?: string[]; missionExecRoots?: string[]; poolerBaseURL?: string; postsRetention?: PostsRetentionConfig } }
    | undefined
  // `cfg` alias: the fallback reads the bundle's OWN patch config without the
  // `config.stateDir` / `config.org` TOKENS that the body-wide replacement below
  // rewrites into `stateDir` / `org` — a naive match would make the initializer
  // self-referencing (const stateDir = ... ?? stateDir, a TDZ error).
  const cfg = config
  const stateDir = coreOrg?.stateDir ?? cfg.stateDir
  const org = (coreOrg?.org ?? cfg.org) as Config['org']

  // --- mutable state (all owned by this invocation's closure; reversible) ---
  // FASE 2 step (a): the DURABLE REGISTRY (the single source of the hosts/posts
  // catalog) is constructed here on the plugin fiber — AGENTS.md rule 4 (no
  // module-global mutable state). It owns the in-memory catalog maps + the
  // durable read/persist + registerEntry/ensureHost/markRetired. The consts
  // below are references to its maps so EVERY existing consumer reads/writes
  // the SAME live catalog (behavior-neutral, R6 byte-compatible on disk).
  // FASE 2.5 BATCH B: the catalog is now a dshd-core SERVICE
  // (`ctx.get('deepartments.catalog')`). In the FULL composition dshd-core
  // applied first and provided it; in a MINIMAL composition (dshd-core absent)
  // we fall back to a behavior-neutral in-bundle construction + a warn.
  const registry = (ctx.get('deepartments.catalog') as RegistryStore | undefined) ?? ((): RegistryStore => {
    ctx.logger.warn('[deepartments] dshd-core is not composed — the catalog is constructed in-bundle (behavior-neutral fallback).')
    return new RegistryStore({ stateDir: stateDir, logger: ctx.logger })
  })()
  const byPost = registry.byPost
  // QD (spec 007 §4.1): the resolved worker-archive dice probability from the
  // `quality` config block (absent/invalid → code default 0.25). Consumed by
  // the worker-retire hook; the head+host 100% mandate is NOT resolved here.
  const qualityWorkerInspectProbability = resolveQualityWorkerInspectProbability(config)
  const byChild = registry.byChild
  // Batch 1a: the live AgentHandle of each materialized head keyed by its
  // session id. create/resume return the handle (the ONLY disposer — a bare
  // `agents.get(id)` returns no dispose; rc.8 dsh-agent index.d.ts:349 vs
  // 155-158), so `dept_sleep` can tear a head down. Held by the plugin owner,
  // never by the head agent itself. Cleared when a head sleeps.
  const byHeadHandle = new Map<string, AgentHandleLike>()
  // Fix sleep-self-deadlock (2026-08-23 — explore-deep/2026-08-23-head-sleep-hang.md
  // §5a): the in-flight per-session dispose promises. `dept_sleep` fires the
  // calling agent's OWN handle dispose fire-and-forget (it may not await it
  // from its own turn — the harness dispose() sends machine.cancel + awaits
  // machine.whenIdle(), the very driver that is executing the tool), so a
  // CONCURRENT disposer of the same session (a bus wake respawn, a double
  // dept_sleep) must JOIN the same detach promise instead of racing a second
  // dispose over the not-yet-detached machine. Each entry is dropped in
  // `finally` once settled — a lingering settled entry would otherwise dedupe
  // the NEXT dispose of a RE-materialized handle.
  const disposingHeads = new Map<string, Promise<void>>()
  // Fix A2 — per-head wake progress tracker: headSessionId → { at, eventCount }.
  // `at` = when we last observed this head, `eventCount` = the watermark of its
  // session event log (AgentLike.session.events.length) at that time. The relay
  // uses it to tell a HEALTHY live-but-busy head (event log still growing —
  // its turn/step/assistant events keep appending) from a STUCK one (status
  // 'running' with NO new event for STUCK_HEAD_MS — the resident loop is wedged).
  // Purely in-memory and intentionally NOT durable: the durable board record is
  // the re-delivery source, so an in-memory reset is always safe.
  const headProgress = new Map<string, { at: number; eventCount: number }>()
  // Fix A2 — serialize the DISPOSE-then-cold-resume stuck-recovery per head
  // session. The relay is synchronous and a stuck path must dispose its frozen
  // handle BEFORE wakePost cold-resumes it (otherwise wakePost would find the
  // stale live handle and followup the wedged loop again). A per-session tail
  // promise makes concurrent wake pushes to the SAME head run the recovery one
  // at a time — the "never double-resume" guard stays true across bursts.
  const headRecoveryQueues = new Map<string, Promise<unknown>>()
  const serializeHeadRecovery = <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
    const previous = headRecoveryQueues.get(sessionId) ?? Promise.resolve()
    const run = previous.then(task, task)
    headRecoveryQueues.set(sessionId, run.then(() => void 0, () => void 0))
    return run
  }
  // Batch C — which LIVE agent sessions have already had the (freshly-injected)
  // Deepartments wake pack placed in their context THIS awake session. The pack
  // is now injected at `agent/pre-step` message-arrival time (NOT frozen at
  // dept_sleep), so this set stops the per-turn injector from re-injecting the
  // ~5kB pack on every model step of a long session. Keyed by the agent SESSION
  // id (`agent.id`), because the pre-step decision.messages only carries the
  // per-step claimed input and does NOT retain prior injected nodes (the
  // `pack-v1: present` sentinel is NOT visible across steps), so a durable
  // session-scoped flag is the reliable presence gate. Cleared in the host
  // dept_sleep branch so a post-sleep wake re-injects a FRESH pack.
  const wakePackInjected = new Set<string>()
  // Fix A — deferred in-place surface reset intent for the host dept_sleep
  // branch (see the Batch 7 helper comment + dept_sleep Step 3): the close
  // branch PLAIN-APPENDS the journal node and records sessionId → the
  // seeded/bumped journal text here; the NEXT `agent/pre-step` (the injector
  // below) performs the full-window replace over ALL current nodes INCLUDING
  // the still-pending dept_sleep tool result, so the assistant tool-call
  // message and its result remain a legal sequence and no orphaned role:'tool'
  // node ever reaches the strict opencode-go API (wake-7 400
  // INVALID_REQUEST root cause — explore-deep/2026-08-21-failedmessages-tool-
  // role-error.md). The seeded text is carried (NOT re-read) so the wake
  // replace re-lands a byte-identical journal node and still works if the file
  // vanished meanwhile. Consumed once at the first post-sleep pre-step.
  // Fix wake-12: this map is IN-MEMORY ONLY — it dies with the process — so
  // the same seed is mirrored durably into HostEntry.deferredJournalSeed
  // (hosts.json) at dept_sleep and RESTORED into this map by the hosts loader
  // at boot; a sleep→restart cycle therefore still folds at the first pre-step
  // of the new process (see the loader + the pre-step consume below).
  const deferredSleepReplace = new Map<string, string>()
  // B3 cutover: room read-cursors are GONE (no board, no read-delta). A legacy
  // `<stateDir>/cursors.json` may still exist on upgraded stateDirs — it is
  // deliberately LEFT INERT (no readers, no writers; the file itself is not
  // deleted here — state migration is the B3 migration step).

  // --- host registry (hostId → entry, plus sessionId → hostId reverse) ------
  // (owned by the RegistryStore above; referenced here so every consumer — the
  // bus delivery, the roster, the health daemon — reads the SAME live host
  // catalog the store persists.)
  const hosts = registry.hosts
  const hostForSession = registry.hostForSession

  /** C1/C3 (m-264) — the SINGLE shared catalog row builder. One source of truth
   * for a dept_who-like row {agentId, kind:'head'|'worker'|'host', title, state}
   * plus every other data field the `dept_who` output carries: BOTH the
   * `dept_who` execute (scope filtering) AND the deploy/retire `activeMembers`
   * echo consume THIS builder, so the echo and the default view can never
   * diverge. State via the shared `computeDeptWhoState` (live/running = agents
   * registry presence/status); title = coordinator.title → coordinator.role →
   * entry.role → entry.postId; kind derived 'worker' (provider:'worker') vs
   * 'head'. Order: hosts first, then posts (the dept_who catalog order — kept
   * for BOTH consumers). NOTE: references `coordinatorForPost` (declared LATER
   * in this closure) — legal because the builder only ever RUNS inside async
   * executes, after apply() has fully initialized the scope (the const
   * declaration order is not blocking for invocation). */
  type CatalogRow = {
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
  const buildCatalogRows = (): CatalogRow[] => {
    const rows: CatalogRow[] = []
    for (const entry of hosts.values()) {
      // m-64: the coherent single-state resolution. `live` is registry
      // PRESENCE (AgentHandle present); `running` refines it to a turn IN
      // FLIGHT (agents.get(sid).status === 'running'); `state` collapses
      // live/sleeping/retired into one contradiction-free enum token.
      const hostAgent = agents !== void 0 ? agents.get(SessionId(entry.sessionId)) : undefined
      rows.push({
        agentId: entry.hostId,
        kind: 'host',
        title: 'Asistente',
        live: hostAgent !== undefined,
        sleeping: entry.sleepEpoch !== void 0,
        state: computeDeptWhoState({
          retired: entry.retired === true,
          sleeping: entry.sleepEpoch !== void 0,
          live: hostAgent !== undefined,
          running: hostAgent?.status === 'running'
        }),
        sessionId: entry.sessionId,
        retired: entry.retired === true
      })
    }
    for (const entry of byPost.values()) {
      const coordinator = coordinatorForPost(entry.postId)
      const isWorker = entry.provider === 'worker'
      // m-64/m-228: a retired post is NEVER live, even when its AgentHandle
      // lingers in the registry (the deploy-restart case) — the data field
      // stays live:false so any consumer (and the render) reads a consistent
      // 'offline, retired', never the contradictory 'live, retired'.
      const postAgent = agents !== void 0 ? agents.get(SessionId(entry.sessionId)) : undefined
      const postLive = entry.retired !== true && postAgent !== undefined
      rows.push({
        agentId: entry.postId,
        // F1: kind derived — a disposable worker is 'worker'; every other
        // post (configured head) is 'head' (pre-F1 hardcode).
        kind: isWorker ? 'worker' : 'head',
        // Spec §6: coordinator.title for department heads; PostEntry.role
        // fallback for worker posts. Fallback chain follows head-presets.ts
        // (`headRoleLine`, the established convention): title → role → postId.
        title: coordinator?.title || coordinator?.role || entry.role || entry.postId,
        live: postLive,
        sleeping: entry.sleepEpoch !== void 0,
        state: computeDeptWhoState({
          retired: entry.retired === true,
          sleeping: entry.sleepEpoch !== void 0,
          live: postLive,
          running: postAgent?.status === 'running'
        }),
        sessionId: entry.sessionId,
        retired: entry.retired === true,
        // F3 (§5.1): worker rows carry the department template/department
        // link + job link (conditioned — never undefined, F9 lossless).
        ...(isWorker && entry.departmentId !== void 0 ? { departmentId: entry.departmentId } : {}),
        ...(isWorker && entry.role !== void 0 ? { role: entry.role } : {}),
        ...(isWorker && entry.jobId !== void 0 ? { jobId: entry.jobId } : {})
      })
    }
    return rows
  }

  /** C3 (m-264) — the compact, JSON-lossless ACTIVE member echo returned by the
   * deploy/retire tools AFTER a mutation so a caller sees the updated live
   * catalog immediately. The SAME shared builder the dept_who default view uses,
   * filtered to non-retired rows whose state is {idle, running} — NO
   * sleeping/offline/retired member ever shows in the echo. */
  const activeCatalogMembers = (): Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }> =>
    buildCatalogRows()
      .filter((row) => row.retired !== true && (row.state === 'idle' || row.state === 'running'))
      .map((row) => ({ agentId: row.agentId, kind: row.kind, title: row.title, state: row.state }))

  /** A4/C3 — the shared `activeMembers` output-schema fragment (a compact,
   * JSON-lossless active member list: `{ agentId, kind, title, state }`). */
  const activeMembersSchema = {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agentId: { type: 'string', required: true },
        kind: { type: 'string', enum: ['head', 'worker', 'host'], required: true },
        title: { type: 'string', required: true },
        state: { type: 'string', enum: ['running', 'idle', 'sleeping', 'offline'], required: true }
      }
    }
  } as const

  /** C3 — the compact ONE-LINE active-roster suffix shared by the 5
   * deploy/retire renders (m-264): `active roster: id (kind, "title"), …`
   * — one line, so the post-mutation echo reads the roster, not a count. */
  const renderActiveRoster = (members: ReadonlyArray<{ agentId: string; kind: string; title: string }>): string =>
    `active roster: ${members.map((m) => `${m.agentId} (${m.kind}, "${m.title}")`).join(', ')}`

  /** R1 (m-264): ONE shared definition per lifecycle tool — dept_memo_write,
   * dept_sleep and dept_post_retire were each defineTool'd TWICE (post own-layer
   * in installHeadBoardTools + the global host plane) with duplicated
   * describe/parameters/schema/render. These factories single-source the full
   * specification; the two registration sites stay EXACTLY where they were and
   * differ ONLY in the lifecycle `execute` branch (post own-layer → head/worker
   * path; global host plane → host path). Behavior is unchanged; for
   * dept_post_retire the executes were already identical, so it is ONE shared
   * ToolDefinition registered in both planes. */
  const memoWriteTool = (hostPlane: boolean) => defineTool({
    name: 'dept_memo_write',
    description: 'Write this department member\'s long-term memory to its journal (a department head or worker; from the host plane, the HOST Asistente): a durable, schema-constrained markdown memo at <stateDir>/journals/<memberId>.md (frontmatter author/room/timestamp/wake_counter/last_wake/board_cursor + decisions/constraints/openItems (+ optional current_step) + a free-form summary with a wake-routine footer). A registered head writes journals/<postId>.md; a HOST (no registered post) writes journals/host-<sessionId>.md. Use it BEFORE sleeping to hand your memory to your future (re-materialized) self. Returns the durable memo path.',
    parameters: {
      summary: { type: 'string', required: true, description: 'The memo body: a summary of your state, conclusions, and what your next incarnation must know.' },
      decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions taken (optional).' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints your future self must respect (optional).' },
      openItems: { type: 'array', items: { type: 'string' }, description: 'Open items for your future self (optional).' },
      currentStep: { type: 'string', description: 'Where you currently are (explicit durable state): a short status line the next wake can verify against (current_step in the journal). Optional.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          room: { type: 'string', required: true },
          member: { type: 'string', required: true },
          memoPath: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `journal written: ${value.memoPath}` } as const]
    },
    async execute(args, exec): Promise<{ room: string; member: string; memoPath: string }> {
      return lifecycle.memoWrite(args, exec as Parameters<typeof lifecycle.memoWrite>[1], hostPlane)
    }
  })

  const sleepTool = (hostPlane: boolean) => defineTool({
    name: 'dept_sleep',
    description: 'Sleep (dormir): persist your memory to your journal (dept_memo_write MUST be called first — this is enforced) and mark yourself for a context RESET. Conclude the turn after calling this; on your NEXT wake you are recreated as a FRESH incarnation. For a department HEAD (F8): your live AgentHandle is disposed, your durable session is ARCHIVED server-side (the sidebar row disappears, the journal + messages stay), and your next wake creates a NEW session — you keep your identity but get a fresh context. A disposable WORKER keeps the legacy cold-resume of the same session (worker retire is the separate archive path). For the HOST Asistente (host plane) it ROTATES the host session (spec 002): the old session is retired + archived server-side and a NEW session seeded with the re-keyed journal becomes the registered host (durable host sleepEpoch set on the new entry), then the turn concludes (falls back to the legacy in-place reset when the rotation cannot run). Rejects loudly if no journal has been saved.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          room: { type: 'string', required: true },
          member: { type: 'string', required: true },
          memoPath: { type: 'string', required: true },
          sleepEpoch: { type: 'number', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `sleeping: ${value.member} marked for context reset (epoch ${value.sleepEpoch}); journal: ${value.memoPath}` } as const]
    },
    async execute(_args, exec): Promise<{ room: string; member: string; memoPath: string; sleepEpoch: number }> {
      if (hostPlane) return lifecycle.sleepHost(_args, exec as Parameters<typeof lifecycle.sleepHost>[1])
      return lifecycle.sleepMember(_args, exec as Parameters<typeof lifecycle.sleepMember>[1])
    }
  })

  const postRetireTool = defineTool({
    name: 'dept_post_retire',
    description: 'Retire a registered post (spec 004 §4.3 — retirement is MARKED, never erased): for a DISPOSABLE WORKER it marks the entry `retired: true` (the post stays in the registry and its history stays queryable; every live-catalog consumer — busDeliverCatalog addressing, dept_who, the wake-pack roster — filters it) and disposes its live AgentHandle; a permanent CONFIGURED head keeps today\'s semantics (registry entry removed, re-materialized by config at boot). Scope: a HEAD caller may retire ONLY the DISPOSABLE WORKERS of its own department (the workers it created — managerId match — or the workers of its own config department; a worker of another head/department and a permanent department head are rejected loudly); a HOST caller may retire any registered post. Unknown postIds are rejected loudly.',
    parameters: {
      postId: { type: 'string', required: true, description: 'The post id to retire (e.g. "research-head").' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          postId: { type: 'string', required: true },
          retired: { type: 'boolean', required: true },
          activeMembers: activeMembersSchema
        }
      },
      render: (_args, value) => [{ type: 'text', text: `retired ${value.postId} (${renderActiveRoster(value.activeMembers)})` } as const]
    },
    async execute(args, exec): Promise<{ postId: string; retired: boolean; activeMembers: Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }> }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_post_retire requires a calling agent (exec.agent was undefined)')
      // Delegate to the shared retirement path (Batch 3a): a HOST caller (no
      // registered post) may retire any post; a head caller is scoped by
      // retirePost's F1 checks (own workers only — today's semantics preserved).
      const result = await retirePost(args.postId, agent.id as string)
      return { ...result, activeMembers: activeCatalogMembers() }
    }
  })

  // Fire-and-forget persistence of the host registry (callers never await it).
  // (The durable write + `.bak` backup live in the RegistryStore.)
  const persistHosts = (): void => { registry.persistHosts() }

  // U1 REMOVED (custom-sidebar removal): the persistent UI config
  // (`uiConfig`/`persistUiConfig`/`ui.json` — the `sidebarEnabled` toggle) is
  // gone with the removed sidebar; `/.deepartments/ui.json` is deleted as the
  // separate migration step. Nothing reads or writes it anymore.

  /**
   * Lazy host registration: called from the host-plane tools when the calling
   * agent has no post entry (it may be a HOST Asistente session). Records the
   * deterministic `host-<sessionId>` address and refreshes the durable
   * identity (hostId/sessionId). CONTRACT (postmortem nº5 + relay-fix,
   * 2026-08-22 + host-roomId latch fix, 2026-08-22; B3: roomId is now an INERT
   * registry field — the caller passes the registry default `'board'` since no
   * board tool carries a room anymore):
   *   - NEW registration (hostId absent): allowed ONLY when no other live
   *     (non-retired) host entry exists — the FIRST host registers; any
   *     further session is REFUSED (warn + NO entry; the session stays a
   *     plain session, spec 002 §4/C1) and the EXISTING live host's id is
   *     returned so bus member resolution keeps a valid member id.
   *   - REFRESH (hostId present, non-retired): always allowed, and MERGES —
   *     it preserves every field ensureHost does not own (rotation-successor
   *     metadata: previousSessionId/sleepEpoch/boundarySeq, retire evidence)
   *     instead of replacing the whole entry, and KEEPS `existing.roomId`
   *     VERBATIM (roomId is never re-derived anywhere anymore).
   *   - RETIRED re-registration: refused (unchanged).
   * Never fabricates a host at boot — only a live tool call registers one
   * (dept_who / send_message self-register through the B3 gap fix).
   */
  const ensureHost = (sessionId: string, roomId: string): string =>
    registry.ensureHost(sessionId, roomId, {
      // U4 — pin the durable "Asistente" title (the ctx-dependent side effect
      // the store injects via this hook at the exact post-guard point the
      // pre-extraction ensureHost pinned it).
      pinHostTitle: (sid) => {
        const titleSession = ctx.sessions.get(SessionId(sid))
        if (titleSession !== void 0) {
          const titlePin = pinHostSessionTitle(titleSession)
          if (titlePin === 'pinned') {
            ctx.logger.info(`[deepartments] ensureHost: pinned host session title "${ASISTENTE_SESSION_TITLE}" (${sid})`)
          } else if (titlePin === 'failed') {
            ctx.logger.warn(`[deepartments] ensureHost: host session title pin failed for ${sid} (non-fatal — host registration continues)`)
          }
        }
      }
    })

  /** Deterministic durable member id for a HOST session (Batch 7): the same
   * `host-<sessionId>` address used for the journal path and hosts.json. */
  const hostIdForSession = (sessionId: string): string => registry.hostIdForSession(sessionId)

  // Persistence of the post registry. Callers MAY await it (returns the write
  // promise) so a durability-critical step (the dept_sleep sleepEpoch mark) can
  // be gated on the write completing; all other callers keep the fire-and-forget
  // shape (`persistPosts()` as a statement ignores the returned promise). The
  // promise ALWAYS settles — a failed write resolves (the error is logged), never
  // rejects — so an awaiting caller can never be thrown on a disk hiccup.
  const persistPosts = (): Promise<void> => registry.persistPosts()

  const registerEntry = (entry: PostEntry) => registry.registerEntry(entry)

  const postIdForChild = (childId: string): string | undefined => registry.postIdForChild(childId)

  // --- Feature A — owner-presence state + host notify + ask_user guard ------
  // `<stateDir>/presence.json` is the durable source; the in-memory `presenceCache`
  // is the SYNCHRONOUS view the guard + the A3 `ask_user_question` guard read (a
  // guard runs at tool-call time, before any await, so it cannot await a disk
  // read). Seeded at apply time (readFileSync — a tiny one-off), refreshed at
  // every host pre-step (so the guard's synchronous view stays current even if
  // the file is edited outside the RPC), and updated atomically on every
  // `presence/set`. Per-apply closure only (AGENTS.md rule 4 — no
  // module-global mutable state). Default present:true (owner is here until
  // toggled absent — the guard is never over-eager at boot). A4 dedup
  // (2026-08-23): the pre-step no longer injects a presence TRANSITION node —
  // the only transition channel is the bus notify (`notifyHostPresence`); the
  // current state is baked into every host wake pack via buildWakePack.
  const presenceCache: PresenceState = readPresenceStateFile(stateDir)
  const refreshPresence = (): void => {
    const next = readPresenceStateFile(stateDir)
    presenceCache.present = next.present
    if (next.updatedAt !== undefined) presenceCache.updatedAt = next.updatedAt
  }
  const savePresence = async (state: PresenceState): Promise<void> => {
    // Cache FIRST (the guard + pre-step injector read the cache directly on the
    // next model step), then persist best-effort — an RPC never fails on a
    // write error (folded to a warn).
    presenceCache.present = state.present
    presenceCache.updatedAt = state.updatedAt
    try {
      await writePresenceStateFile(stateDir, state)
    } catch (error) {
      ctx.logger.warn(`[deepartments] presence.json write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // A3 — fire-and-forget HOST notification on a presence CHANGE, reusing the
  // SAME live-host followup seam the bus delivery uses (busDeliverToHost's live
  // branch — a resident host picks the change up on its next turn even while
  // idle). With A4 dedup (2026-08-23) this is now the ONLY transition channel:
  // a dormant host is never woken here — the current state is baked into every
  // host wake pack via buildWakePack. Never awaits, never throws.
  const notifyHostPresence = (present: boolean): void => {
    try {
      const { live } = pickLiveHostEntry(hosts.values())
      if (live === undefined) return
      const sessionId = String(SessionId(live.sessionId))
      const target = agents?.get(sessionId)
      if (target === undefined) return
      target.followup(buildPresenceMessage(present))
    } catch (error) {
      ctx.logger.warn(`[deepartments] presence change notify to host failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // A3 — gate the HOST's `ask_user_question`: when the owner is ABSENT the host
  // must not block on a question only the owner can answer (the model fails
  // loud and picks another path instead of hanging). Plain-context → GLOBAL
  // guard (the plugin owns no scoped host ctx — explore report A3); the denial
  // is NARROW (owner-absent + exactly `ask_user_question` + registered-host
  // caller) so presence absence can never break any other tool and never gates
  // a post/worker/subagent. Reversible effect (AGENTS.md rule 4).
  ctx.effect(() => {
    const dispose = ctx.tools.guard((exec) => askUserGuardReason(exec, {
      present: () => presenceCache.present !== false,
      isHostAgent: (sessionId) => {
        if (postIdForChild(sessionId) !== undefined) return false
        const entry = hosts.get(hostIdForSession(sessionId))
        return entry !== undefined && entry.retired !== true
      }
    }))
    return () => { dispose() }
  }, 'deepartments: owner-presence ask_user gate')

  // Best-effort cold load of the post registry. Batch 1a: entries carry the
  // root-agent `sessionId` (head-<postId>). Legacy entries from the previous
  // continuable-subagent model carry childId/parentId WITHOUT a sessionId —
  // they referenced a subagent continuation that no longer exists, so they are
  // NOT registered (kept out of the in-memory registry only; posts.json is
  // untouched until a later persistPosts overwrites it — reversible). The
  // configured coordinator is then re-created fresh as a root agent by
  // ensureHeads on boot; the old durable subagent session is never woken.
  const registryLoaded = registry.loadPosts().catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.logger.warn(`[deepartments] posts.json load failed (starting with an empty registry): ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // Best-effort cold load of the host registry. Reconciliation choice (Batch
  // A): we do NOT drop entries whose session has no live agent — a
  // cold-restarted host session is non-resident until reopened, and dropping
  // it would erase a legitimate host's identity. We keep it; the relay
  // SKIPS+WARNS when the target session is not live. Only a real join (lazy
  // ensureHost on a live tool call) registers/refreshes a host.
  const hostsLoaded = registry.loadHosts({ deferredSleepReplace }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.logger.warn(`[deepartments] hosts.json load failed (starting with an empty registry): ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // --- Web-UI sleep cleanup at boot (Option A; src/session-cleanup.ts) -------
  // After a REAL host dept_sleep set `webUiCleanupPending`, the FIRST boot
  // performs the GUI cleanup exactly once — truncate the host session artifact
  // to header + permission + the last append-origin journal node (renumbered
  // 0..k so the next resume accepts it), reset its projection-cache row, and
  // archive+delete the direct child subagent dirs — then clears the flag so
  // mid-wake restarts are exact no-ops (one cleanup per sleep cycle). The
  // physical truncation CANNOT run inside dept_sleep (the harness appends the
  // tool result AFTER the tool returns at LIVE in-memory seqs and the Session
  // constructor demands contiguous-from-0 events — see the module header), so
  // this boot-time hook is the race-free point: it runs before the GUI can
  // materialize/open the host session. Best-effort: each piece warns on
  // failure; the flag stays for the next boot when the truncate failed
  // (idempotent retry), and is cleared once the truncate succeeded.
  // LIVE-SESSION RETRY (the wake-11 corruption fix — see the diagnosis report
  // .dsh/reports/explore-deep/2026-08-21-corrupt-session-log-diagnosis.md): a
  // boot where the host session is ALREADY materialized (a resident agent
  // holds it) must NOT truncate — runSleepCleanup then reports the cleanup as
  // SKIPPED (`skipped: true, skipReason: 'session-live'`) and this hook KEEPS
  // the pending flag, so the SAME cleanup is retried at the next boot, when
  // the session is verifiably not materialized. The clear decision is the
  // pure `shouldClearCleanupPending` gate below (unit-tested).
  const runPendingWebUiCleanups = async (): Promise<void> => {
    const pending: Array<{ hostId: string; sessionId: string }> = []
    for (const hostEntry of hosts.values()) {
      // U2 (§5 defence-in-depth): never truncate a RETIRED entry's artifact —
      // rotation preserves the old session whole (G4/D2); the boot cleanup is
      // the LEGACY path for in-place sleeps only.
      if (hostEntry.webUiCleanupPending === true && hostEntry.retired !== true) pending.push({ hostId: hostEntry.hostId, sessionId: hostEntry.sessionId })
    }
    if (pending.length === 0) return
    ctx.logger.info(`[deepartments] web-ui sleep cleanup pending for ${pending.length} host(s)`)
    // Resolve the runtime seams the cleanup needs (OPTIONALLY — the cleanup
    // degrades gracefully when the persistence backend is absent, e.g. in
    // minimal compositions / hermetic harnesses).
    const persistence = ctx.get('sessionPersistence') as { root?: string } | undefined
    const sessionsRoot = typeof persistence?.root === 'string' && persistence.root !== ''
      ? persistence.root
      : path.join(stateDir, '..', 'sessions')
    const stateHome = path.dirname(sessionsRoot)
    const projCachePath = path.join(stateHome, 'storages', 'session_projcache.json')
    const archiveDir = path.join(stateHome, 'archive')
    const sessions = ctx.get('sessions') as { get?: (id: unknown) => unknown } | undefined
    // Fix wake-12 (race-2): the session-store check ALONE misses a host session
    // resumed via the AGENT REGISTRY — dsh-smart-restart's boot resume delivers
    // through `agent.followup(...)` (dsh-smart-restart/src/index.ts:262-280),
    // which attaches the session to `ctx.agents` while it is not yet in the
    // `sessions` store map. With the store-only probe the boot cleanup once
    // truncated a resumed host artifact (mid-log seq seam — the wake-11
    // corruption class, see explore-deep/2026-08-21-first-turn-api-orphan.md
    // §1.2). A host is LIVE when EITHER service holds it; `agents` is resolved
    // OPTIONALLY (absent in minimal/hermetic compositions → the probe degrades
    // to the pre-existing store-only behavior).
    const agents = ctx.get('agents') as AgentsLike | undefined
    const isLive = (sessionId: string): boolean =>
      sessions?.get?.(sessionId) !== undefined ||
      (agents !== void 0 && agents.get(SessionId(sessionId)) !== undefined)
    for (const { hostId, sessionId } of pending) {
      const entry = hosts.get(hostId)
      if (entry === void 0 || entry.sessionId !== sessionId) continue
      try {
        const artifactPath = await findSessionArtifact(sessionsRoot, sessionId)
        if (artifactPath === undefined) {
          ctx.logger.warn(`[deepartments] web-ui sleep cleanup: no stored artifact for ${sessionId} — skipping truncate`)
        }
        const report = await runSleepCleanup(sessionId, {
          artifactPath,
          projCachePath,
          sessionsRoot,
          archiveDir,
          isLive,
          log: ctx.logger
        })
        ctx.logger.info(
          `[deepartments] web-ui sleep cleanup for ${sessionId}: truncate ${report.truncate?.beforeEvents ?? 'n/a'}→${report.truncate?.afterEvents ?? 'n/a'} events` +
          `, projcache rows dropped ${report.projCacheRemoved}, subagent children archived ${report.archive?.archivedDirs.length ?? 0}`
        )
        // RETRY SEMANTICS — the flag is cleared ONLY when the cleanup actually
        // RAN and the GUI-critical piece (the artifact truncation) succeeded
        // (pure `shouldClearCleanupPending` gate, unit-tested):
        //   * SKIPPED (host session live — `report.skipped === true`, reason
        //     'session-live') → flag KEPT: the session was materialized while
        //     the boot ran the cleanup, so truncation would corrupt its
        //     artifact (mid-log seq seam); the NEXT boot retries when the
        //     session is verifiably not materialized.
        //   * truncate FAILED/absent (`truncateError` set or `truncate`
        //     undefined) → flag KEPT: idempotent next-boot retry.
        //   * ran + truncate SUCCEEDED → flag CLEARED: one cleanup per sleep
        //     cycle; mid-wake restarts are exact no-ops.
        if (shouldClearCleanupPending(report)) {
          entry.webUiCleanupPending = undefined
          persistHosts()
        } else if (report.skipped === true) {
          ctx.logger.info(`[deepartments] web-ui sleep cleanup for ${sessionId} SKIPPED (${report.skipReason ?? 'unknown'}): host session live — pending flag KEPT, the next boot retries`)
        }
      } catch (error) {
        ctx.logger.warn(`[deepartments] web-ui sleep cleanup failed for ${sessionId} (flag kept for the next boot): ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  hostsLoaded.then(() => { void runPendingWebUiCleanups() }, () => { void runPendingWebUiCleanups() })

  // --- Boot repair hook: attach the single live host to its workspace (FIX 1b)
  // A rotated host that was registered in hosts.json but never workspace-
  // attached (e.g. the session-6e49895c… incident — a cold artifact + live
  // hosts.json entry with ZERO rows in the durable workspace sessionIds) is
  // INVISIBLE in the GUI sidebar: the native sidebar groups sessions by
  // workspace membership and the U3 watcher's membership check
  // (packages/dshd-gui/src/client/index.tsx) never passes → the host is unreachable. The
  // rotation now attaches at S2.2 (src/session-rotation.ts), and this hook
  // HEALS legacy/crash states at boot: when hosts.json holds EXACTLY ONE
  // non-retired live host entry, attach its session to the workspace whose
  // path matches its persisted header cwd (the same iterate-and-try pattern
  // as S2.2 — dsh-workspace `attachSession` validates cwd vs path and throws
  // on mismatch, so mismatches fall through). Best-effort: skip silently on
  // zero or ambiguous (2+) live hosts (warn on the ambiguous case); on
  // no-match/all-throw log a WARN and never crash. Runs only when the
  // workspaceRegistry service is available (optional seam).
  // FIX 1b.1 (2026-08-22): the strict `ctx.get('workspaceRegistry')` returns
  // UNDEFINED until the provider's fiber reaches state 2 (cordis
  // lib/index.js:762-771 — `_getImpl` bails when `strict && impl.fiber.state
  // !== 2`). The workspaceRegistry provider's init awaits storage + a
  // sessionPersistence header-index rebuild, so at the moment this boot hook
  // runs (hostsLoaded.then — microseconds after plugin boot) the strict get
  // races the init and silently skipped (production: session-6e49895c did
  // not heal at the 17:24:59 UTC restart; zero `host attach repair` lines).
  // Fix: NON-STRICT get + a bounded retry loop around `list()` — retry while
  // the impl is absent or list() rejects (mid-init, e.g. "workspace registry
  // is not started yet"), attach on the first resolved list; after the cap
  // log a WARN and give up (never crash).
  const HOST_ATTACH_REPAIR_RETRY_MS = 250
  const HOST_ATTACH_REPAIR_TIMEOUT_MS = 10_000
  const repairHostWorkspaceAttach = async (): Promise<void> => {
    const live: HostEntry[] = []
    for (const entry of hosts.values()) if (entry.retired !== true) live.push(entry)
    if (live.length !== 1) {
      if (live.length > 1) ctx.logger.warn(`[deepartments] host attach repair: skipped (${live.length} live host entries — exactly one required)`)
      return
    }
    const sessionId = live[0].sessionId
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
              ctx.logger.info(`[deepartments] host attach repair: attached ${sessionId}`)
              return
            } catch {
              // cwd mismatch / unvalidatable header / attach fault — try the next entity.
            }
          }
          // list() RESOLVED but no entity matched: a definitive (non-readiness)
          // failure — warn once and give up.
          ctx.logger.warn(`[deepartments] host attach repair: no workspace matched session ${sessionId} (its header cwd has no owning workspace) — the host stays invisible in the sidebar`)
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
    ctx.logger.warn(`[deepartments] host attach repair failed: ${detail} — the host stays invisible in the sidebar (retried ${HOST_ATTACH_REPAIR_TIMEOUT_MS}ms)`)
  }
  hostsLoaded.then(() => { void repairHostWorkspaceAttach() }, () => { void repairHostWorkspaceAttach() })

  // B3 cutover: the per-room board-emit machinery (read cursors, seq
  // counters, room queues, the board message emitter, room-write address
  // validation, sender-verified trust flags) is DELETED — the BUS
  // (messages-store.ts + deliverBusRecord) is the only emit/delivery path.
  // =========================================================================
  // SURFACE RETURN — the members the rest of applyInvoke consumes at the SAME
  // positions as before the extraction: the optional continuation services +
  // the shared config-source/registry/organization bindings (subagents/agents/
  // agentPresets/stateDir/org/registry/byPost/byChild/hosts/hostForSession/
  // qualityWorkerInspectProbability) + the per-head/host live maps
  // (byHeadHandle/disposingHeads/headProgress/serializeHeadRecovery/
  // wakePackInjected/deferredSleepReplace) + the C1/C3 catalog machinery
  // (buildCatalogRows/activeCatalogMembers/activeMembersSchema/
  // renderActiveRoster) + the R1 lifecycle tool builders (memoWriteTool/
  // sleepTool/postRetireTool) + the host registry surface (persistHosts/
  // ensureHost/hostIdForSession/persistPosts/registerEntry/postIdForChild) +
  // the Feature-A presence surface (presenceCache/refreshPresence/savePresence/
  // notifyHostPresence) + the cold-load promises (registryLoaded/hostsLoaded)
  // + the boot repair hook (HOST_ATTACH_REPAIR_RETRY_MS/
  // HOST_ATTACH_REPAIR_TIMEOUT_MS/repairHostWorkspaceAttach). The apply-fiber
  // destructure re-binds them at the same position (presets/spawn/tools/
  // delivery factories + the daemons read the SAME bindings).
  // =========================================================================
  return {
    subagents,
    agents,
    agentPresets,
    stateDir,
    org,
    registry,
    byPost,
    qualityWorkerInspectProbability,
    byChild,
    byHeadHandle,
    disposingHeads,
    headProgress,
    serializeHeadRecovery,
    wakePackInjected,
    deferredSleepReplace,
    hosts,
    hostForSession,
    buildCatalogRows,
    activeCatalogMembers,
    activeMembersSchema,
    renderActiveRoster,
    memoWriteTool,
    sleepTool,
    postRetireTool,
    persistHosts,
    ensureHost,
    hostIdForSession,
    persistPosts,
    registerEntry,
    postIdForChild,
    presenceCache,
    refreshPresence,
    savePresence,
    notifyHostPresence,
    registryLoaded,
    hostsLoaded,
    HOST_ATTACH_REPAIR_RETRY_MS,
    HOST_ATTACH_REPAIR_TIMEOUT_MS,
    repairHostWorkspaceAttach
  }
}