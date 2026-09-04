// dshd-core — the Deepartments CORE state machinery, now a real Cordis PLUGIN
// that exposes the core as Cordis SERVICES (FASE 2.5 BATCH B). The bundle
// (dsh-deepartments) consumes them via `ctx.get('deepartments.*')`; when
// dshd-core is NOT composed (a minimal composition), the bundle degrades to a
// behavior-neutral in-bundle fallback (stub + warn).
//
// Behavior-neutral + migration-compatible: the bundle keeps constructing/using
// the core exactly as before, only importing it from this package through
// drop-in re-export bridges (bundle src/core/X.ts -> `export * from
// 'dshd-core'` so lib/core/X.js stays a drop-in superset). The on-disk state
// formats (messages.jsonl, deliveries.jsonl, hosts registry, rotation/cleanup
// archives) are byte-identical — R6.
//
// NO export default (pitfall 0001 — breaks `inject`).

import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { RegistryStore } from './registry.js'
import { busProfileFor, aclDenyGround, aclDenyReason, canSend } from './acl.js'
import type { BusCatalogLens, BusMemberProfile } from './acl.js'
import { createLifecycleService, buildSleepJournalMessage, journalPathFor } from './lifecycle.js'
import type { LifecycleCtx, LifecycleService } from './lifecycle.js'
import { createWakePackService } from './wakepack.js'
import type { WakePackDeps, WakePackService } from './wakepack.js'
import { runHostRotation } from './session-rotation.js'
import { createDeliveryEngine } from './delivery.js'
import type { DeliveryEngine, DeliveryEngineDeps } from './delivery.js'
import { DeliveryRedeliverer, MessagesStore, markDelivery, parseDeliveryRows, resolveDeliveriesPath, hasEarlierPendingPair } from './messages.js'
import type { DeliveryRedelivererDeps, DeliveryRow, DeliveryStatus } from './messages.js'
// D3 (subagent/gui/pooler phase): the dispatch-time transient-subagent role
// registry promoted to a core SERVICE (`deepartments.subagentRoles`) — ONE
// per-process store shared by the bundle writer (subagent.ts) and reader
// (wakepack pre-step); the module also exports the drop-in compat functions the
// bundle bridge re-exports for R6.
import { createSubagentRolesService } from './role-orient.js'
import type { SubagentRolesService } from './role-orient.js'
// R3 (WORK-REGISTER post-cierre 2026-09-04): the bundle-layer patch staleness
// watchdog — installed at apply; its exports flow through the barrel below.
import { installBundlePatchWatchdog } from './bundle-patches.js'

// acl.js defines `busProfileFor`/`aclDenyGround`/`aclDenyReason`/`canSend` (+
// types `BusMemberProfile`/`BusCatalogLens`); delivery.js RE-EXPORTS the same
// four functions and two types for consumer convenience. Under a plain
// `export *` a name re-exported from two modules is AMBIGUOUS and silently
// dropped, so acl's surface is re-exported EXPLICITLY here (a non-star export
// takes precedence over any star export), which resolves the collision to one
// binding. Everything else flows through star exports.
export { busProfileFor, aclDenyGround, aclDenyReason, canSend } from './acl.js'
export type { BusMemberProfile, BusCatalogLens } from './acl.js'

export * from './registry.js'
export * from './messages.js'
export * from './delivery.js'
export * from './wakepack.js'
export * from './lifecycle.js'
export * from './session-rotation.js'
export * from './session-cleanup.js'
export * from './role-orient.js'
// PACING (owner m-PACING, 2026-08-28): the peak/valley FRANJA domain — the
// pure UTC window machinery (isPeakAt / pacingStateAt / formatFranjaLine) +
// the structural PacingConfigLike mirror. Consumed by the wake-pack assembly
// (this package), the system-health daemon (dshd-health) and the bundle.
export * from './pacing.js'
import type { PacingWindowOptions, PacingState } from './pacing.js'
// SESSION SURFACE (post-incidente 2026-09-04, crash-loop 609 restarts): the
// ONE shared dual session-log read (getSessionEvents) + the surface detector
// (detectSessionSurface — the heartbeat `{ts, bootId, surface}` datum). The 8
// runtime call sites of the migrable session surface (invoke/tools/presets)
// route through it; a new direct `session.snapshotEvents(` call elsewhere is
// the regression this export makes greppable.
export * from './session-surface.js'
// R3 (WORK-REGISTER post-cierre 2026-09-04, QD finding 09-04): the
// BUNDLE-LAYER PATCH STALENESS WATCHDOG — the launcher HMR watcher covers only
// the profile + home user layers, so a knob committed in a bundle layer stays
// inactive until a daemon restart; the watchdog snapshot/resolve/check/seam
// exports (parseProfileNameFromArgv, resolveBundlePatchPaths,
// snapshotBundlePatchMtimes, findChangedBundlePatches, the sidecar readers,
// installBundlePatchWatchdog) are the durable + noisy mitigation.
export * from './bundle-patches.js'

// ---------------------------------------------------------------------------
// FASE 2.5 BATCH B — the dshd-core Cordis plugin surface.
// ---------------------------------------------------------------------------

export const name = 'dshd-core'
// Resolve harness services via `ctx.get` at use (inject is EMPTY) so this plugin
// stays loadable in minimal compositions: it never hard-requires a harness
// service to boot, and every harness dependency is resolved optionally inside
// `apply` (a missing harness service degrades that service, never the plugin).
export const inject: string[] = []

/** A configured department mirror (the bundle's `org.departments[]` shape used to
 * classify a configured head in the ACL lens). The SUFFICIENT head-classification
 * fields; the full bundle `DepartmentConfig` carries more (workspacePath, jobDir,
 * coordinator.role/provider/agentOptions) — those are conveyed verbatim via
 * `deepartments.org` (the shared config source), not re-declared here. */
export interface CoreDepartment {
  id?: string
  name?: string
  coordinator?: { postId?: string }
}

/** One department of the org config mirror (FASE 2.6 BATCH A) — structurally
 * compatible with the bundle's `DepartmentConfig` so `deepartments.org` can be
 * consumed verbatim by the bundle (the shared config source). */
export interface OrgDepartment {
  id?: string
  name?: string
  workspacePath?: string
  jobDir?: string
  /** E2 — optional one-line department purpose (the wake-pack `## Departments
   * directory` section + SKILL.md mirror). Absent/empty → the department
   * contributes NO directory line (R6). */
  purpose?: string
  /** E2 — optional how-to-request line (RESEARCH/PROGRAMMING/QUALITY REQUEST
   * format + send_message target). Absent/empty → no directory line (R6). */
  services?: string
  coordinator?: {
    postId?: string
    role?: string
    title?: string
    sessionTitle?: string
    provider?: string
    agentOptions?: { provider?: string; model?: string; maxTokens?: number; reasoningEffort?: 'max' | 'high' | 'medium' | 'low' }
  }
}

/** The org config mirror (FASE 2.6 BATCH A) — the SHARED CONFIG SOURCE the
 * bundle consumes via `ctx.get('deepartments.org')`. Mirrors the bundle's
 * `Config.org` shape so the relocation is behavior-neutral. */
export interface OrgConfig {
  departments?: OrgDepartment[]
  execRoots?: string[]
  missionExecRoots?: string[]
  poolerBaseURL?: string
  /** A3/C2 — durable posts.json RETIRED-entry retention (the prune/archive
   * policy). Optional; mirrors the bundle's `Config.org.postsRetention` shape
   * (maxRetiredKept defaults 50, archiveFile defaults
   * 'posts-retired-archive.jsonl', enabled defaults false — pruning OFF unless
   * explicitly true). Delivered VERBATIM via `deepartments.org` (the dshd-core
   * row carries it — see cordis.patch.yml), so the bundle reads the SHARED
   * source value at boot reconcile (not the post-FASE-2.6 bundle MIRROR which
   * no longer carries it). */
  postsRetention?: {
    maxRetiredKept?: number
    archiveFile?: string
    enabled?: boolean
  }
  /** PACING (owner m-PACING, 2026-08-28) — the peak/valley FRANJA monitor
   * config (`org.pacing.*`, mirrors the bundle's org.ts `PacingConfig`).
   * Optional — absent keys fall through to the CODE defaults (enabled on,
   * Mon-Fri hours {1,2,3,6,7,8,9} UTC, 30-min edge buffer), delivered VERBATIM
   * via `deepartments.org` so the dshd-core OWNED wake-pack assembly and the
   * bundle agree on the SAME shared source. */
  pacing?: {
    enabled?: boolean
    peakWindows?: { weekday?: number[]; hours?: number[] }
    peakBufferMs?: number
  }
  /** R4 (providers → org config, LANE 0.2.3) — the default WORKER model route
   * ({provider, model, reasoningEffort?}, the SAME shape as
   * coordinator.agentOptions). Delivered VERBATIM via `deepartments.org` so
   * the presets surface resolves it ORG-DRIVEN (the code literals as the
   * fallback). Absent → code defaults (opencode-zen / deepseek-v4-flash / max). */
  workerAgentOptions?: {
    provider?: string
    model?: string
    reasoningEffort?: 'max' | 'high' | 'medium' | 'low'
  }
  /** R4 — the default HOST model route (the D4 dormant-host resume
   * AgentOptions). Same shape as the worker route. Absent → code defaults
   * (opencode-zen / deepseek-v4-flash / max — the RUNTIME TRUTH aligned in
   * LANE 0.2.3; the pre-R4 vision-exp literal was stale, the config rows run
   * the host on flash). */
  hostAgentOptions?: {
    provider?: string
    model?: string
    reasoningEffort?: 'max' | 'high' | 'medium' | 'low'
  }
  /** R3 (WORK-REGISTER post-cierre 2026-09-04) — the BUNDLE-LAYER PATCH
   * STALENESS WATCHDOG switch: the launcher HMR watcher watches ONLY the
   * profile's own `cordis.patch.yml` + the home file, so a knob committed in a
   * bundle layer (a dshd-core row / dsh-deepartments row) stays INACTIVE until
   * a daemon restart. The watchdog (bundle-patches.ts) snapshots the resolved
   * bundle-layer patch mtimes at boot and warns loudly + durably on a change.
   * Absent/`true` → ON by default (a bundle knob committed today must never be
   * silently inactive); `false` opts out. The check is READ-ONLY: zero impact
   * on the knob-loading path, no automatic restart. */
  bundlePatchCheck?: boolean
  /** R3 — the watchdog interval override (ms); absent → the code default
   * (60 s, aligned with the health tick). */
  bundlePatchCheckIntervalMs?: number
}

/** The `deepartments.org` service surface (FASE 2.6 BATCH A) — the shared
 * config source: the org stateDir + org config. */
export interface OrgConfigSurface {
  /** The org stateDir (posts.json + hosts.json + messages.jsonl). */
  stateDir: string
  /** The org config (departments, execRoots, missionExecRoots, poolerBaseURL). */
  org: OrgConfig
}

/** The dshd-core plugin config. `stateDir` is required; the optional `org` (the
 * relocated org config) is the SHARED CONFIG SOURCE; the legacy top-level
 * `departments` is retained as a backward-compatible ACL mirror (used only when
 * `org.departments` is absent). */
export interface CoreConfig {
  /** The org stateDir (posts.json + hosts.json + messages.jsonl). */
  stateDir: string
  /** The relocated org config (FASE 2.6 BATCH A) — the shared config source. */
  org?: OrgConfig
  /** The configured departments (optional, for the ACL lens; backwards
   * compatible mirror of `org.departments`). */
  departments?: CoreDepartment[]
}

/** The `deepartments.acl` service surface — the pure messaging ACL bound onto
 * the live catalog lens. */
export interface AclSurface {
  busProfileFor(memberId: string): BusMemberProfile
  aclDenyGround(sender: BusMemberProfile, recipient: BusMemberProfile): string | undefined
  aclDenyReason(from: string, to: string): string | undefined
  canSend(from: string, to: string): boolean
  lens: BusCatalogLens
}

/** The `deepartments.postState` service surface — the delivery post-state holder
 * (the B6 post-state enum is a LATER phase; this is the placeholder surface so
 * the service key composes without a breaking change). */
export interface PostStateSurface {
  stateDir: string
}

/** Build the `deepartments.acl` service from a live catalog + config departments
 * (pure; no side effects). */
export function buildAclSurface(catalog: RegistryStore, departments: CoreDepartment[] | undefined): AclSurface {
  const departmentForPost = (postId: string): { id?: string } | undefined => {
    if (departments === undefined) return undefined
    for (const department of departments) {
      if (department.coordinator?.postId === postId) return { id: department.id }
    }
    return undefined
  }
  const lens: BusCatalogLens = { byPost: catalog.byPost, hosts: catalog.hosts, departmentForPost }
  return {
    busProfileFor: (memberId) => busProfileFor(memberId, lens),
    aclDenyGround,
    aclDenyReason: (from, to) => aclDenyReason(from, to, lens),
    canSend: (from, to) => canSend(from, to, lens),
    lens
  }
}

// ---------------------------------------------------------------------------
// DI-by-services (LANE DI-BY-SERVICES, FASE 1 — the additive seam): the four
// BASELINE deps holders (`deepartments.lifecycleDeps` / `wakepackDeps` /
// `busDeps` / `deliverDeps`) — the binder-free per-shell DI surface the bundle
// fills with the SAME closure set it registers into the binder (the register
// dies in FASE 2). Pattern 1B (LANE 0.2.1, the zone holders): a minimal
// per-apply mutable holder (register/get/clear + an EPOCH counter for cache
// invalidation). The lazy service shells below read holder-first (FASE 1:
// content-aware dual-read — an EMPTY holder falls back to the binder, so the
// F1 suite stays byte-identical; FASE 2: holder-only, the binder dies).
// ---------------------------------------------------------------------------

/** The minimal per-apply mutable deps holder contract (the `DepsHolder` of
 * dshd-health/dshd-orchestration — LANE 0.2.1 pattern 1B). */
export interface DepsHolder<T> {
  register(deps: Partial<T>): void
  get(): T
  clear(): void
  getEpoch(): number
}

/** Create a per-apply mutable deps holder (register/get/clear + epoch). */
export function createDepsHolder<T>(): DepsHolder<T> {
  let deps = {} as T
  let epoch = 0
  return {
    register(partial) { deps = { ...deps, ...partial } },
    get() { return deps },
    clear() { deps = {} as T; epoch++ },
    getEpoch() { return epoch }
  }
}

/** Bucket-(c) deps for the `deepartments.bus` service shell. The message
 * STORE (store + markDelivery) is bucket-(a) and is built internally by the
 * shell; the ONLY closure-bound piece is the boot re-delivery driver
 * (`DeliveryRedelivererDeps` — reads `byPost`/`hosts` and calls the live
 * `deliverBusRecord`). Declared structurally so the holder lives without a
 * `bus.ts`-owned contract until the shell is built. */
export interface BusBucketDeps {
  /** The closure-bound re-delivery deps (recipientAlive / getRecord /
   * resolveCallerSessionId / deliver — all read the live catalog + wake path). */
  redeliver?: Partial<DeliveryRedelivererDeps>
}

/** Wrap a lazy-built `LifecycleService` in an on-first-use facade: the real
 * service is constructed on the FIRST property access, never at apply time, so
 * the bundle can fill its DI-by-services deps holder before the first
 * lifecycle tool call. A build that throws (a missing bucket-(c) dep, R1)
 * propagates at the FIRST use and is retried on the next access once the holder
 * is populated. LANE 0.2.1 (P6 disposability): the facade caches the built
 * service together with the holder EPOCH it was built under — when the holder
 * is cleared (the bundle unload effect), the next access REBUILDS instead of
 * serving the cached service (whose closures belong to the dead apply): the
 * rebuild over the emptied holder FAILS LOUD (R1) — never stale execution. */
function lazyLifecycle(holder: DepsHolder<Partial<LifecycleCtx>>, build: () => LifecycleService): LifecycleService {
  let cache: LifecycleService | undefined
  let cacheEpoch = -1
  const ensure = (): LifecycleService => {
    const epoch = holder.getEpoch()
    if (cache === undefined || cacheEpoch !== epoch) {
      cache = build()
      cacheEpoch = epoch
    }
    return cache
  }
  return {
    get memoWrite() { return ensure().memoWrite },
    get sleepMember() { return ensure().sleepMember },
    get sleepHost() { return ensure().sleepHost },
    get sleepAll() { return ensure().sleepAll }
  }
}

/** Wrap a lazy-built `WakePackService` in an on-first-use facade (same lazy
 * contract as `lazyLifecycle`, incl. the epoch invalidation of the cache). */
function lazyWakePack(holder: DepsHolder<Partial<WakePackDeps>>, build: () => WakePackService): WakePackService {
  let cache: WakePackService | undefined
  let cacheEpoch = -1
  const ensure = (): WakePackService => {
    const epoch = holder.getEpoch()
    if (cache === undefined || cacheEpoch !== epoch) {
      cache = build()
      cacheEpoch = epoch
    }
    return cache
  }
  return {
    get assembleWakePack() { return ensure().assembleWakePack },
    get assembleWakeSnapshot() { return ensure().assembleWakeSnapshot },
    get buildCondensedRoster() { return ensure().buildCondensedRoster },
    get preStepHandler() { return ensure().preStepHandler }
  }
}

/** Build the `deepartments.lifecycle` service ON FIRST USE. Resolves buckets
 * (a)/(b) internally (catalog maps, org stateDir, harness via `deptGet`) and
 * takes bucket-(c) from the DI-by-services HOLDER (`deepartments.lifecycleDeps`
 * — FASE 2, holder-only). A required bucket-(c) dep missing at build time
 * FAILS LOUD (R1) — never a silently-unbound service. */
function buildLifecycleLazy(ctx: Context, lifecycleDeps: DepsHolder<Partial<LifecycleCtx>>): LifecycleService {
  const catalog = ctx.get('deepartments.catalog') as RegistryStore | undefined
  if (catalog === undefined) {
    throw new Error('[deepartments] lifecycle lazy build: ctx.get("deepartments.catalog") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.catalog)')
  }
  const org = ctx.get('deepartments.org') as OrgConfigSurface | undefined
  if (org === undefined) {
    throw new Error('[deepartments] lifecycle lazy build: ctx.get("deepartments.org") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.org)')
  }
  const stateDir = org.stateDir
  const bound = lifecycleDeps.get()
  // The closure-bound bucket-(c) deps the bundle passes by reference (the rest
  // — catalog maps, stateDir, buildSleepJournalMessage, runHostRotation,
  // deptGet, logger — resolve internally from a/b).
  const required: (keyof LifecycleCtx)[] = [
    'writeJournal', 'readJournal', 'bumpHostSleepCounter', 'bumpPostSleepCounter',
    'archivePostSessionOnSleep', 'disposeHeadHandleOnce', 'maybeEmitQualityInspectDirective',
    'ensureHost', 'deferredSleepReplace', 'wakePackInjected'
  ]
  const missing = required.filter((key) => bound[key] === undefined)
  if (missing.length > 0) {
    throw new Error(`[deepartments] lifecycle lazy build: required bucket-(c) dep(s) missing from deepartments.lifecycleDeps.get(): ${missing.join(', ')} — the bundle must call ctx.get('deepartments.lifecycleDeps').register({ lifecycle: { ... } }) after its applyInvoke state is ready`)
  }
  return createLifecycleService({
    byPost: catalog.byPost,
    hosts: catalog.hosts,
    hostForSession: catalog.hostForSession,
    postIdForChild: (id) => catalog.postIdForChild(id),
    hostIdForSession: (id) => catalog.hostIdForSession(id),
    ensureHost: bound.ensureHost!,
    persistPosts: () => catalog.persistPosts(),
    persistHosts: () => catalog.persistHosts(),
    journalPath: (memberId) => journalPathFor(stateDir, memberId),
    writeJournal: bound.writeJournal!,
    readJournal: bound.readJournal!,
    bumpHostSleepCounter: bound.bumpHostSleepCounter!,
    bumpPostSleepCounter: bound.bumpPostSleepCounter!,
    archivePostSessionOnSleep: bound.archivePostSessionOnSleep!,
    disposeHeadHandleOnce: bound.disposeHeadHandleOnce!,
    maybeEmitQualityInspectDirective: bound.maybeEmitQualityInspectDirective!,
    // fb-11 — the ROTATION-SUCCESSOR AUTO-WAKE callback (OPTIONAL like the
    // caller-provided hooks above but NOT in `required`: a bundle that omits
    // it keeps the pre-fb-11 behavior — the rotation commits and the new host
    // waits for the first external wake; the bundle in this repo ALWAYS
    // provides it (invoke.ts), so the composed org gets the auto-wake).
    enqueueHostWake: bound.enqueueHostWake,
    runHostRotation,
    deptGet: (key) => ctx.get(key),
    stateDir,
    deferredSleepReplace: bound.deferredSleepReplace!,
    wakePackInjected: bound.wakePackInjected!,
    buildSleepJournalMessage,
    logger: ctx.logger
  })
}

/** Build the `deepartments.wakepack` service ON FIRST USE (same late-binding
 * contract as `buildLifecycleLazy`; the DI-by-services holder, FASE 2 —
 * holder-only). */
function buildWakePackLazy(ctx: Context, wakepackDeps: DepsHolder<Partial<WakePackDeps>>): WakePackService {
  const catalog = ctx.get('deepartments.catalog') as RegistryStore | undefined
  if (catalog === undefined) {
    throw new Error('[deepartments] wakepack lazy build: ctx.get("deepartments.catalog") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.catalog)')
  }
  const org = ctx.get('deepartments.org') as OrgConfigSurface | undefined
  if (org === undefined) {
    throw new Error('[deepartments] wakepack lazy build: ctx.get("deepartments.org") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.org)')
  }
  const stateDir = org.stateDir
  const bound = wakepackDeps.get()
  // The closure-bound bucket-(c) deps the bundle passes by reference (the rest
  // — catalog maps, stateDir, buildSleepJournalMessage, journalPathFor, logger —
  // resolve internally from a/b).
  const required: (keyof WakePackDeps)[] = [
    'refreshPresence', 'wakePackInjected', 'deferredSleepReplace', 'roleForSession',
    'buildSubagentOrientation', 'computeHostSleepSurfacePlan', 'assembleHeartbeat',
    'readPresenceStateFile', 'messagesStoreReady', 'repoRoot'
  ]
  const missing = required.filter((key) => bound[key] === undefined)
  if (missing.length > 0) {
    throw new Error(`[deepartments] wakepack lazy build: required bucket-(c) dep(s) missing from deepartments.wakepackDeps.get(): ${missing.join(', ')} — the bundle must call ctx.get('deepartments.wakepackDeps').register({ wakepack: { ... } }) after its applyInvoke state is ready`)
  }
  return createWakePackService({
    byPost: catalog.byPost,
    hosts: catalog.hosts,
    getHost: (hostId) => catalog.getHost(hostId),
    postIdForChild: (id) => catalog.postIdForChild(id),
    hostIdForSession: (id) => catalog.hostIdForSession(id),
    refreshPresence: bound.refreshPresence!,
    wakePackInjected: bound.wakePackInjected!,
    deferredSleepReplace: bound.deferredSleepReplace!,
    persistHosts: () => catalog.persistHosts(),
    roleForSession: bound.roleForSession!,
    buildSubagentOrientation: bound.buildSubagentOrientation!,
    // E2 — the DIRECTORIO de departamentos: the config slice is passed to the
    // wake-pack service so the SKILL-MIRROR staleness validation has the
    // single source (fb-47 #4: the pack no longer renders a standalone 5b
    // section — the host receives the directory inside the embedded skill
    // body; the slice remains available for the byte-normalized mirror check).
    departments: org.org.departments,
    computeHostSleepSurfacePlan: bound.computeHostSleepSurfacePlan!,
    buildSleepJournalMessage,
    assembleHeartbeat: bound.assembleHeartbeat!,
    readPresenceStateFile: bound.readPresenceStateFile!,
    journalPathFor: (memberId) => journalPathFor(stateDir, memberId),
    messagesStoreReady: bound.messagesStoreReady!,
    stateDir,
    repoRoot: bound.repoRoot!,
    // PACING — the franja config from the SHARED CONFIG SOURCE (`deepartments.org`
    // → the dshd-core org.pacing row): the wake-pack assembly renders the ONE
    // `## Pacing (franja)` section from it (default ON; an explicit
    // `pacing.enabled === false` → the section is omitted, the pre-pacing pack).
    // Absent config → the code defaults (the same defaults the daemon uses).
    // LANE 0.2.2 (P4): the SUBSTITUTABLE pacing policy (deepartments.pacing —
    // the default wrapper over the pure pacing module; a policy plugin may
    // compose its own) flows into the wake-pack service: the franja resolves
    // service-first, the pure fallback stays R6.
    pacing: org.org.pacing,
    pacingService: ctx.get('deepartments.pacing') as
      | { isPeakAt(date: Date, options?: PacingWindowOptions): boolean; pacingStateAt(date: Date, options?: PacingWindowOptions): PacingState }
      | undefined,
    logger: ctx.logger
  })
}

// ---------------------------------------------------------------------------
// FASE 2.6-B-2 — `deepartments.bus` (message store + redeliver) +
// `deepartments.deliver` (delivery engine + deliverOrQueue gate) lazy shells.
// Continuing the late-binding/binder infrastructure from B-1: the bundle is
// UNCHANGED; these are NEW service keys built ON FIRST USE (never at apply),
// reading their closure-bound bucket-(c) deps from the binder. Buckets (a)/(b)
// resolve internally (org stateDir + sidecar marks + harness subagents); bucket
// (c) comes from `binder.get().bus` / `.redeliver` / `.deliver`.
// ---------------------------------------------------------------------------

/** The `deepartments.bus` service surface: the boot-opened message store + the
 * write-ahead sidecar marks + a factory for the boot re-delivery driver. The
 * STORE + markDelivery are bucket-(a) (built internally from org stateDir); the
 * `DeliveryRedeliverer` needs closure-bound bucket-(c) deps (recipientAlive /
 * resolveCallerSessionId / deliver) that the bundle injects via the binder (or
 * passes explicitly to `redeliver`). */
export interface BusSurface {
  /** The boot-opened MessagesStore (load + compact + per-recipient index).
   * Rejects loud on mid-file corruption (spec §3.2). */
  storeReady: Promise<MessagesStore>
  /** Mark the write-ahead delivery sidecar (§4.4) for ONE (messageId,
   * recipientId) pair at the given status. The stateDir closure is bound
   * internally (bucket a). */
  markDelivery(messageId: string, recipientId: string, status: DeliveryStatus): Promise<DeliveryRow>
  /** Build a DeliveryRedeliverer (the boot re-delivery driver), merging the
   * closure-bound deps from `deps` (explicit) with the binder's `redeliver`/
   * `bus.redeliver` buckets AND the internal bucket-(a) deps (stateDir, logger,
   * getRecord over the opened store). A required bucket-(c) dep missing after
   * the merge FAILS LOUD (R1). */
  redeliver(deps?: Partial<DeliveryRedelivererDeps>): DeliveryRedeliverer
}

/** Wrap a lazy-built `BusSurface` in an on-first-use facade (same lazy contract
 * as `lazyLifecycle`, incl. the epoch invalidation of the cache). The store +
 * markDelivery need only bucket-(a); the bucket-(c) check for `redeliver` runs
 * inside the returned function (on use). */
function lazyBus(holder: DepsHolder<BusBucketDeps>, build: () => BusSurface): BusSurface {
  let cache: BusSurface | undefined
  let cacheEpoch = -1
  const ensure = (): BusSurface => {
    const epoch = holder.getEpoch()
    if (cache === undefined || cacheEpoch !== epoch) {
      cache = build()
      cacheEpoch = epoch
    }
    return cache
  }
  return {
    get storeReady() { return ensure().storeReady },
    get markDelivery() { return ensure().markDelivery },
    get redeliver() { return ensure().redeliver }
  }
}

/** Build the `deepartments.bus` service ON FIRST USE. Opens the message store
 * (bucket a) + binds the sidecar marks internally; the re-delivery driver reads
 * its closure-bound bucket-(c) deps from the DI-by-services HOLDER
 * (`deepartments.busDeps`, FASE 2 — holder-only) or the explicit `deps`
 * argument and FAILS LOUD (R1) if a required one is missing at use. */
function buildBusLazy(ctx: Context, busDeps: DepsHolder<BusBucketDeps>): BusSurface {
  const org = ctx.get('deepartments.org') as OrgConfigSurface | undefined
  if (org === undefined) {
    throw new Error('[deepartments] bus lazy build: ctx.get("deepartments.org") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.org)')
  }
  const stateDir = org.stateDir
  const logger = ctx.logger
  const storeReady = MessagesStore.open(stateDir)
  const mark = (messageId: string, recipientId: string, status: DeliveryStatus): Promise<DeliveryRow> =>
    markDelivery(stateDir, messageId, recipientId, status)
  const redeliver = (depsInput?: Partial<DeliveryRedelivererDeps>): DeliveryRedeliverer => {
    // The closure-bound bucket-(c) deps: the bundle injects them via the
    // DI-by-services HOLDER (`deepartments.busDeps`) — the FASE-2 sole seam
    // (the dead binder's `redeliver`/`bus.redeliver` are gone). An explicit
    // `deps` argument overrides/completes them. The internal bucket-(a) deps
    // (stateDir, logger, getRecord over the opened store) are always provided
    // by the shell.
    const merged: Partial<DeliveryRedelivererDeps> = { ...busDeps.get().redeliver, ...depsInput }
    const required: (keyof DeliveryRedelivererDeps)[] = ['recipientAlive', 'resolveCallerSessionId', 'deliver']
    const missing = required.filter((key) => merged[key] === undefined)
    if (missing.length > 0) {
      throw new Error(`[deepartments] bus redeliver build: required bucket-(c) dep(s) missing from deepartments.busDeps.get(): ${missing.join(', ')} — the bundle must call ctx.get('deepartments.busDeps').register({ redeliver: { ... } }) (or pass them to bus.redeliver({ ... })) after its applyInvoke state is ready`)
    }
    return new DeliveryRedeliverer({
      stateDir,
      logger,
      recipientAlive: merged.recipientAlive!,
      // P2 (fb-131 — WAKE-SEAM lane) — the OPTIONAL guards were previously
      // DROPPED here (the shell only forwarded the required bucket-(c) deps):
      // `recipientDormant` never reached the DeliveryRedeliverer in the
      // composed path (the B3 guard was silently inert) and `recipientRunning`
      // (the new P2 no-wake drain exception) must reach it the same way.
      ...(merged.recipientDormant !== undefined ? { recipientDormant: merged.recipientDormant } : {}),
      ...(merged.recipientRunning !== undefined ? { recipientRunning: merged.recipientRunning } : {}),
      getRecord: async (messageId) => (await storeReady).get(messageId),
      resolveCallerSessionId: merged.resolveCallerSessionId!,
      deliver: merged.deliver!
    })
  }
  return { storeReady, markDelivery: mark, redeliver }
}

/** Wrap a lazy-built `DeliveryEngine` in an on-first-use facade (same lazy
 * contract as `lazyLifecycle`, incl. the epoch invalidation of the cache; the
 * bundle consumes `deepartments.deliver` as a `DeliveryEngine`). */
function lazyDeliver(holder: DepsHolder<Partial<DeliveryEngineDeps>>, build: () => DeliveryEngine): DeliveryEngine {
  let cache: DeliveryEngine | undefined
  let cacheEpoch = -1
  const ensure = (): DeliveryEngine => {
    const epoch = holder.getEpoch()
    if (cache === undefined || cacheEpoch !== epoch) {
      cache = build()
      cacheEpoch = epoch
    }
    return cache
  }
  return {
    get deliverOrQueue() { return ensure().deliverOrQueue }
  }
}

/** Build the `deepartments.deliver` engine ON FIRST USE. Resolves buckets (a)
 * (org stateDir + logger + markPrepared/markFinal sidecar marks) and (b)
 * (`ctx.get('subagents')`, optional) internally; takes the closure-bound
 * bucket-(c) deps from the DI-by-services HOLDER (`deepartments.deliverDeps`,
 * FASE 2 — holder-only). A required bucket-(c) dep missing at build time FAILS
 * LOUD (R1) — never a silently-unbound engine. */
function buildDeliverLazy(ctx: Context, deliverDeps: DepsHolder<Partial<DeliveryEngineDeps>>): DeliveryEngine {
  const org = ctx.get('deepartments.org') as OrgConfigSurface | undefined
  if (org === undefined) {
    throw new Error('[deepartments] deliver lazy build: ctx.get("deepartments.org") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.org)')
  }
  const stateDir = org.stateDir
  const bound = deliverDeps.get()
  // The closure-bound bucket-(c) deps the bundle passes by reference (the rest —
  // stateDir, logger, markPrepared/markFinal sidecar marks, subagents — resolve
  // internally from a/b).
  const required: (keyof DeliveryEngineDeps)[] = ['resolveChild', 'deliverChild', 'resolveCatalogRoute', 'busProfileFor', 'deliverPost', 'deliverHost']
  const missing = required.filter((key) => bound[key] === undefined)
  if (missing.length > 0) {
    throw new Error(`[deepartments] deliver lazy build: required bucket-(c) dep(s) missing from deepartments.deliverDeps.get(): ${missing.join(', ')} — the bundle must call ctx.get('deepartments.deliverDeps').register({ deliver: { ... } }) after its applyInvoke state is ready`)
  }
  return createDeliveryEngine({
    stateDir,
    logger: ctx.logger,
    markPrepared: (record, recipientId, opts) => markDelivery(stateDir, record.id, recipientId, 'prepared', undefined, opts?.noWake),
    markFinal: (record, recipientId, status, opts) => markDelivery(stateDir, record.id, recipientId, status, undefined, opts?.noWake),
    // fb-117 (fold-in batch A — the FIFO-gate predicate): whether the recipient
    // has an EARLIER seq whose delivery pair is still 'prepared' (non-final).
    // Uses the store's per-recipient seq index (§3.3) + the sidecar's LATEST row
    // per (messageId, recipientId) — DELIVERIES.jsonl read per call (the same
    // full-read seam the sweep tick uses; fail-soft: a read error only warns and
    // returns false — the ordering gate must never break a delivery).
    pendingEarlierSeq: async (recipientId, seq) => {
      const bus = ctx.get('deepartments.bus') as BusSurface | undefined
      const store = await (bus?.storeReady ?? MessagesStore.open(stateDir))
      try {
        const text = await readFile(resolveDeliveriesPath(stateDir), 'utf8')
        return hasEarlierPendingPair(parseDeliveryRows(text), (recipient) => store.seqsFor(recipient), recipientId, seq)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false // nothing ever sent
        ctx.logger.warn(`[deepartments] bus delivery FIFO-gate check failed for ${recipientId} (delivery proceeds ungated): ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
    // P1 (fb-131 — WAKE-SEAM lane, Candidate B observability): the FIFO-gate
    // gating-seq detail — the EARLIEST strictly-earlier seq whose pair is still
    // 'prepared' (the tool result's 'prepared (fifo-gated tras m-<seq>)'). Runs
    // ONLY after the gate fired (a gated send is the minority — one extra
    // sidecar read, fail-soft to undefined). NEVER a behavior gate.
    pendingEarlierSeqDetail: async (recipientId, seq) => {
      const bus = ctx.get('deepartments.bus') as BusSurface | undefined
      const store = await (bus?.storeReady ?? MessagesStore.open(stateDir))
      try {
        // The gating-seq computation INLINE (no new export — the same
        // predicate loop as the exported `hasEarlierPendingPair`, resolving
        // the gating seq instead of a bare boolean).
        const text = await readFile(resolveDeliveriesPath(stateDir), 'utf8')
        const rows = parseDeliveryRows(text)
        const own = store.seqsFor(recipientId)
        if (own.length === 0) return undefined
        const latest = new Map<string, DeliveryRow>()
        for (const row of rows) latest.set(`${row.messageId}\u0000${row.recipientId}`, row)
        for (const earlier of own) {
          if (earlier >= seq) break // ascending — strictly earlier seqs only
          const row = latest.get(`m-${earlier}\u0000${recipientId}`)
          if (row !== undefined && row.status === 'prepared') return earlier
        }
        return undefined
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined // nothing ever sent
        ctx.logger.warn(`[deepartments] bus delivery FIFO-gate seq detail failed for ${recipientId} (observability only): ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    },
    subagents: ctx.get('subagents'),
    resolveChild: bound.resolveChild!,
    deliverChild: bound.deliverChild!,
    resolveCatalogRoute: bound.resolveCatalogRoute!,
    busProfileFor: bound.busProfileFor!,
    deliverPost: bound.deliverPost!,
    deliverHost: bound.deliverHost!
  })
}

export function apply(ctx: Context, config: CoreConfig) {
  const stateDir = config.stateDir
  const logger = ctx.logger
  // FASE 2.6 BATCH A (config relocation): the org config now lives in the
  // dshd-core row (`config.org`); the legacy top-level `departments` mirror is
  // the backward-compatible fallback used only when `org.departments` is absent.
  const departments = config.org?.departments ?? config.departments

  // --- deepartments.catalog: the durable RegistryStore (the single source of
  // the hosts/posts catalog). Constructed from config + the cordis logger; the
  // bundle consumes it via ctx.get and binds its catalog maps to it. ---
  const catalog = new RegistryStore({ stateDir, logger })
  // A reversible effect (AGENTS.md rule 4): the returned disposer unregisters
  // the service when the fiber unloads.
  ctx.provide('deepartments.catalog', catalog)

  // --- deepartments.acl: the pure messaging ACL bound onto the catalog lens. ---
  const acl = buildAclSurface(catalog, departments)
  ctx.provide('deepartments.acl', acl)

  // --- deepartments.postState: the delivery post-state holder (B6 placeholder). ---
  const postState: PostStateSurface = { stateDir }
  ctx.provide('deepartments.postState', postState)

  // --- deepartments.org (FASE 2.6 BATCH A): the SHARED CONFIG SOURCE. The org
  // config (departments, execRoots, missionExecRoots, poolerBaseURL) + stateDir
  // are relocated HERE; the bundle consumes them via ctx.get('deepartments.org')
  // (falling back to its own patch row in a minimal composition). Provided
  // verbatim so bundle and dshd-core always agree on the same org. ---
  const orgSurface: OrgConfigSurface = {
    stateDir,
    org: config.org ?? { departments: departments as OrgDepartment[] }
  }
  ctx.provide('deepartments.org', orgSurface)

  // --- deepartments.subagentRoles (subagent/gui/pooler phase — D3): the
  // dispatch-time TRANSIENT-SUBAGENT role registry, promoted from the bundle's
  // module-global Map into a CORE SERVICE. Provided EAGERLY (it is
  // self-contained — no binder/closure deps), so it is resolvable at the
  // bundle's own apply time like the other eager services. ONE store per
  // process (module-scoped in ./role-orient.js): the bundle's `subagent.ts`
  // WRITES here at dispatch and the wakepack pre-step READS here (via the
  // injected `roleForSession`), and they can never split across two registries.
  // In a minimal composition (this plugin absent) the bundle falls back to the
  // drop-in compat functions the role-orient bridge re-exports — the SAME
  // store, so R6 behavior-neutral. ---
  ctx.provide('deepartments.subagentRoles', createSubagentRolesService())

  // --- the mutable late-binding service seam (FASE 2.6-B-1): DIED in the DI-
  // by-services lane (FASE 2). The department deps now flow through the
  // per-shell deps holders directly (see below). ---

  // --- DI-by-services (FASE 1+2): the four BASELINE deps holders
  // (`deepartments.lifecycleDeps` / `wakepackDeps` / `busDeps` / `deliverDeps`),
  // the binder-free per-shell DI surface the bundle fills with the SAME closure
  // set it used to register into the binder (pattern 1B of LANE 0.2.1 — P1
  // intact: PROVIDED by dshd-core, the bundle only WRITES via register, never
  // provides). FASE 2: the register/binder are DEAD — the holders are the ONLY
  // seam the lazy shells read. ---
  const lifecycleDeps = createDepsHolder<Partial<LifecycleCtx>>()
  const wakepackDeps = createDepsHolder<Partial<WakePackDeps>>()
  const busDeps = createDepsHolder<BusBucketDeps>()
  const deliverDeps = createDepsHolder<Partial<DeliveryEngineDeps>>()
  ctx.provide('deepartments.lifecycleDeps', lifecycleDeps)
  ctx.provide('deepartments.wakepackDeps', wakepackDeps)
  ctx.provide('deepartments.busDeps', busDeps)
  ctx.provide('deepartments.deliverDeps', deliverDeps)

  // --- deepartments.lifecycle / deepartments.wakepack (FASE 2.6-B-1): LAZY
  // SERVICE SHELLS built ON FIRST USE (never at apply time), so the bundle can
  // fill its deps holder after its own state is ready. Buckets (a)/(b) resolve
  // internally (catalog maps + stateDir via deepartments.org + harness via
  // LifecycleCtx.deptGet); bucket (c) comes from the deps holder. A required
  // bucket-(c) dep missing at build time FAILS LOUD (R1 — never silently
  // unbound). ---
  ctx.provide('deepartments.lifecycle', lazyLifecycle(lifecycleDeps, () => buildLifecycleLazy(ctx, lifecycleDeps)))
  ctx.provide('deepartments.wakepack', lazyWakePack(wakepackDeps, () => buildWakePackLazy(ctx, wakepackDeps)))

  // --- deepartments.bus / deepartments.deliver (FASE 2.6-B-2): LAZY SERVICE
  // SHELLS built ON FIRST USE (never at apply time), so the bundle can fill
  // its deps holder after its own state is ready. Buckets (a)/(b) resolve
  // internally (org stateDir + sidecar marks + harness subagents); bucket (c)
  // comes from the deps holder. A required bucket-(c) dep missing at use FAILS
  // LOUD (R1 — never silently unbound). ---
  ctx.provide('deepartments.bus', lazyBus(busDeps, () => buildBusLazy(ctx, busDeps)))
  ctx.provide('deepartments.deliver', lazyDeliver(deliverDeps, () => buildDeliverLazy(ctx, deliverDeps)))

  // --- R3 (WORK-REGISTER post-cierre 2026-09-04) — the BUNDLE-LAYER PATCH
  // STALENESS WATCHDOG (bundle-patches.ts): the launcher HMR watcher covers
  // ONLY the profile's own cordis.patch.yml + the home file, so a knob
  // committed in a bundle layer (e.g. a dshd-core row) stays INACTIVE until a
  // daemon restart. The watchdog snapshots the resolved-at-boot mtimes of the
  // active profile's bundle-layer patch files and warns LOUDLY (each interval)
  // + DURABLY (the bundle-patch-alerts.json sidecar) when one changed. Design:
  // minimal + non-intrusive — READ-ONLY (stats/reads only), zero impact on the
  // knob-loading path, no automatic restart; a resolution failure warns ONCE
  // and disables the check (never a throw into apply). The returned disposer
  // clears the interval on plugin unload (AGENTS.md rule 4 — reversible). ---
  return installBundlePatchWatchdog(ctx, { stateDir, org: config.org })
}
