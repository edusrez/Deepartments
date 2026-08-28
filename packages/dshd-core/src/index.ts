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
import { DeliveryRedeliverer, MessagesStore, markDelivery } from './messages.js'
import type { DeliveryRedelivererDeps, DeliveryRow, DeliveryStatus } from './messages.js'
// D3 (subagent/gui/pooler phase): the dispatch-time transient-subagent role
// registry promoted to a core SERVICE (`deepartments.subagentRoles`) — ONE
// per-process store shared by the bundle writer (subagent.ts) and reader
// (wakepack pre-step); the module also exports the drop-in compat functions the
// bundle bridge re-exports for R6.
import { createSubagentRolesService } from './role-orient.js'
import type { SubagentRolesService } from './role-orient.js'

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
// FASE 2.6-B-1 — the LATE-BINDING seam: `deepartments.binder` + lazy service
// shells for `deepartments.lifecycle` / `deepartments.wakepack`.
// ---------------------------------------------------------------------------

/** Bucket-(c) deps for a FUTURE `deepartments.bus` service shell. The message
 * STORE (store + markDelivery) is bucket-(a) and is built internally by the
 * shell; the ONLY closure-bound piece is the boot re-delivery driver
 * (`DeliveryRedelivererDeps` — reads `byPost`/`hosts` and calls the live
 * `deliverBusRecord`). Declared structurally so the binder lives without a
 * `bus.ts`-owned contract until the shell is built. */
export interface BusBucketDeps {
  /** The closure-bound re-delivery deps (recipientAlive / getRecord /
   * resolveCallerSessionId / deliver — all read the live catalog + wake path). */
  redeliver?: Partial<DeliveryRedelivererDeps>
}

/** The mutable late-binding holder the BUNDLE fills with its closure-bound
 * bucket-(c) deps once `applyInvoke` state is ready. Each service takes only
 * the PARTIAL deps it needs; everything else (buckets a/b) resolves internally
 * via `ctx.get('deepartments.catalog')` / `ctx.get('deepartments.org')` / the
 * harness service keys. */
export interface BinderDeps {
  /** bucket-(c) for a future `deepartments.bus` shell (the re-delivery driver). */
  bus?: Partial<BusBucketDeps>
  /** bucket-(c) for `deepartments.deliver` (the engine + `deliverOrQueue` gate). */
  deliver?: Partial<DeliveryEngineDeps>
  /** bucket-(c) for `deepartments.wakepack` (the closure-bound wake helpers:
   * presence refresh, wake-relay maps, role/orientation, heartbeat, git/ROADMAP
   * repoRoot, live message store). */
  wakepack?: Partial<WakePackDeps>
  /** bucket-(c) for `deepartments.lifecycle` (the closure-bound journal I/O,
   * teardown + QD seams, ensureHost, the deferred sleep-replace intent). */
  lifecycle?: Partial<LifecycleCtx>
  /** bucket-(c) for the `deepartments.bus` re-delivery driver, as a top-level
   * partial (mirrors `bus.redeliver`; a convenience for a single register). */
  redeliver?: Partial<DeliveryRedelivererDeps>
}

/** The mutable late-binding seam (a Cordis SERVICE) the bundle fills after its
 * own state is ready. `register` MERGES per-bucket (partial deps accumulate, so
 * the bundle may fill one service at a time); `get` returns the accumulated
 * deps the lazy builders read. */
export interface Binder {
  register(deps: BinderDeps): void
  get(): BinderDeps
}

/** Mutable per-apply binder (AGENTS.md rule 4 — no module-global mutable state;
 * the instance lives on the apply fiber and is exposed as a service). */
class MutableBinder implements Binder {
  private deps: BinderDeps = {}
  register(deps: BinderDeps): void {
    this.deps = {
      bus: { ...this.deps.bus, ...deps.bus },
      deliver: { ...this.deps.deliver, ...deps.deliver },
      wakepack: { ...this.deps.wakepack, ...deps.wakepack },
      lifecycle: { ...this.deps.lifecycle, ...deps.lifecycle },
      redeliver: { ...this.deps.redeliver, ...deps.redeliver }
    }
  }
  get(): BinderDeps {
    return this.deps
  }
}

/** Wrap a lazy-built `LifecycleService` in an on-first-use facade: the real
 * service is constructed on the FIRST property access, never at apply time, so
 * the bundle can `binder.register(...)` its bucket-(c) deps before the first
 * lifecycle tool call. A build that throws (a missing bucket-(c) dep, R1)
 * propagates at the FIRST use and is retried on the next access once the binder
 * is populated. */
function lazyLifecycle(build: () => LifecycleService): LifecycleService {
  let cache: LifecycleService | undefined
  const ensure = (): LifecycleService => (cache ??= build())
  return {
    get memoWrite() { return ensure().memoWrite },
    get sleepMember() { return ensure().sleepMember },
    get sleepHost() { return ensure().sleepHost },
    get sleepAll() { return ensure().sleepAll }
  }
}

/** Wrap a lazy-built `WakePackService` in an on-first-use facade (same lazy
 * contract as `lazyLifecycle`). */
function lazyWakePack(build: () => WakePackService): WakePackService {
  let cache: WakePackService | undefined
  const ensure = (): WakePackService => (cache ??= build())
  return {
    get assembleWakePack() { return ensure().assembleWakePack },
    get assembleWakeSnapshot() { return ensure().assembleWakeSnapshot },
    get buildCondensedRoster() { return ensure().buildCondensedRoster },
    get preStepHandler() { return ensure().preStepHandler }
  }
}

/** Build the `deepartments.lifecycle` service ON FIRST USE. Resolves buckets
 * (a)/(b) internally (catalog maps, org stateDir, harness via `deptGet`) and
 * takes bucket-(c) from `binder.get().lifecycle`. A required bucket-(c) dep
 * missing at build time FAILS LOUD (R1) — never a silently-unbound service. */
function buildLifecycleLazy(ctx: Context, binder: Binder): LifecycleService {
  const catalog = ctx.get('deepartments.catalog') as RegistryStore | undefined
  if (catalog === undefined) {
    throw new Error('[deepartments] lifecycle lazy build: ctx.get("deepartments.catalog") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.catalog)')
  }
  const org = ctx.get('deepartments.org') as OrgConfigSurface | undefined
  if (org === undefined) {
    throw new Error('[deepartments] lifecycle lazy build: ctx.get("deepartments.org") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.org)')
  }
  const stateDir = org.stateDir
  const bound = binder.get().lifecycle ?? {}
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
    throw new Error(`[deepartments] lifecycle lazy build: required bucket-(c) dep(s) missing from binder.get().lifecycle: ${missing.join(', ')} — the bundle must call ctx.get('deepartments.binder').register({ lifecycle: { ... } }) after its applyInvoke state is ready`)
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
 * contract as `buildLifecycleLazy`). */
function buildWakePackLazy(ctx: Context, binder: Binder): WakePackService {
  const catalog = ctx.get('deepartments.catalog') as RegistryStore | undefined
  if (catalog === undefined) {
    throw new Error('[deepartments] wakepack lazy build: ctx.get("deepartments.catalog") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.catalog)')
  }
  const org = ctx.get('deepartments.org') as OrgConfigSurface | undefined
  if (org === undefined) {
    throw new Error('[deepartments] wakepack lazy build: ctx.get("deepartments.org") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.org)')
  }
  const stateDir = org.stateDir
  const bound = binder.get().wakepack ?? {}
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
    throw new Error(`[deepartments] wakepack lazy build: required bucket-(c) dep(s) missing from binder.get().wakepack: ${missing.join(', ')} — the bundle must call ctx.get('deepartments.binder').register({ wakepack: { ... } }) after its applyInvoke state is ready`)
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
    // E2 — the DIRECTORIO section is assembled from the SHARED CONFIG SOURCE
    // (`deepartments.org` → the dshd-core org.departments row): the pack never
    // hardcodes the org chart; add/remove a department = edit the config. The
    // departments slice carries name + coordinator.postId + purpose/services
    // (the two E2 descriptor fields, optional — a legacy config composes and
    // the directory section renders only what carries purpose/services, R6).
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
    pacing: org.org.pacing,
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
 * as `lazyLifecycle`). The store + markDelivery need only bucket-(a); the
 * bucket-(c) check for `redeliver` runs inside the returned function (on use). */
function lazyBus(build: () => BusSurface): BusSurface {
  let cache: BusSurface | undefined
  const ensure = (): BusSurface => (cache ??= build())
  return {
    get storeReady() { return ensure().storeReady },
    get markDelivery() { return ensure().markDelivery },
    get redeliver() { return ensure().redeliver }
  }
}

/** Build the `deepartments.bus` service ON FIRST USE. Opens the message store
 * (bucket a) + binds the sidecar marks internally; the re-delivery driver reads
 * its closure-bound bucket-(c) deps from the binder (or the explicit `deps`
 * argument) and FAILS LOUD (R1) if a required one is missing at use. */
function buildBusLazy(ctx: Context, binder: Binder): BusSurface {
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
    // The closure-bound bucket-(c) deps: the bundle injects them via the binder
    // (top-level `redeliver` or `bus.redeliver`); an explicit `deps` argument
    // overrides/completes them. The internal bucket-(a) deps (stateDir, logger,
    // getRecord over the opened store) are always provided by the shell.
    const binderRedeliver = { ...(binder.get().redeliver ?? {}), ...(binder.get().bus?.redeliver ?? {}) }
    const merged: Partial<DeliveryRedelivererDeps> = { ...binderRedeliver, ...depsInput }
    const required: (keyof DeliveryRedelivererDeps)[] = ['recipientAlive', 'resolveCallerSessionId', 'deliver']
    const missing = required.filter((key) => merged[key] === undefined)
    if (missing.length > 0) {
      throw new Error(`[deepartments] bus redeliver build: required bucket-(c) dep(s) missing: ${missing.join(', ')} — the bundle must call ctx.get('deepartments.binder').register({ redeliver: { ... } }) (or pass them to bus.redeliver({ ... })) after its applyInvoke state is ready`)
    }
    return new DeliveryRedeliverer({
      stateDir,
      logger,
      recipientAlive: merged.recipientAlive!,
      getRecord: async (messageId) => (await storeReady).get(messageId),
      resolveCallerSessionId: merged.resolveCallerSessionId!,
      deliver: merged.deliver!
    })
  }
  return { storeReady, markDelivery: mark, redeliver }
}

/** Wrap a lazy-built `DeliveryEngine` in an on-first-use facade (same lazy
 * contract as `lazyLifecycle`; the bundle consumes `deepartments.deliver` as a
 * `DeliveryEngine`). */
function lazyDeliver(build: () => DeliveryEngine): DeliveryEngine {
  let cache: DeliveryEngine | undefined
  const ensure = (): DeliveryEngine => (cache ??= build())
  return {
    get deliverOrQueue() { return ensure().deliverOrQueue }
  }
}

/** Build the `deepartments.deliver` engine ON FIRST USE. Resolves buckets (a)
 * (org stateDir + logger + markPrepared/markFinal sidecar marks) and (b)
 * (`ctx.get('subagents')`, optional) internally; takes the closure-bound
 * bucket-(c) deps from `binder.get().deliver`. A required bucket-(c) dep
 * missing at build time FAILS LOUD (R1) — never a silently-unbound engine. */
function buildDeliverLazy(ctx: Context, binder: Binder): DeliveryEngine {
  const org = ctx.get('deepartments.org') as OrgConfigSurface | undefined
  if (org === undefined) {
    throw new Error('[deepartments] deliver lazy build: ctx.get("deepartments.org") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.org)')
  }
  const stateDir = org.stateDir
  const bound = binder.get().deliver ?? {}
  // The closure-bound bucket-(c) deps the bundle passes by reference (the rest —
  // stateDir, logger, markPrepared/markFinal sidecar marks, subagents — resolve
  // internally from a/b).
  const required: (keyof DeliveryEngineDeps)[] = ['resolveChild', 'deliverChild', 'resolveCatalogRoute', 'busProfileFor', 'deliverPost', 'deliverHost']
  const missing = required.filter((key) => bound[key] === undefined)
  if (missing.length > 0) {
    throw new Error(`[deepartments] deliver lazy build: required bucket-(c) dep(s) missing from binder.get().deliver: ${missing.join(', ')} — the bundle must call ctx.get('deepartments.binder').register({ deliver: { ... } }) after its applyInvoke state is ready`)
  }
  return createDeliveryEngine({
    stateDir,
    logger: ctx.logger,
    markPrepared: (record, recipientId) => markDelivery(stateDir, record.id, recipientId, 'prepared'),
    markFinal: (record, recipientId, status) => markDelivery(stateDir, record.id, recipientId, status),
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

  // --- deepartments.binder (FASE 2.6-B-1): the mutable LATE-BINDING seam. The
  // bundle (in the compose-first wiring) fills this with its closure-bound
  // bucket-(c) deps AFTER its applyInvoke state is ready; the lazy service
  // shells below read it on first use. ---
  const binder = new MutableBinder()
  ctx.provide('deepartments.binder', binder)

  // --- deepartments.lifecycle / deepartments.wakepack (FASE 2.6-B-1): LAZY
  // SERVICE SHELLS built ON FIRST USE (never at apply time), so the bundle can
  // binder.register(...) after its own state is ready. Buckets (a)/(b) resolve
  // internally (catalog maps + stateDir via deepartments.org + harness via
  // LifecycleCtx.deptGet); bucket (c) comes from binder.get(). A required
  // bucket-(c) dep missing at build time FAILS LOUD (R1 — never silently
  // unbound). ---
  ctx.provide('deepartments.lifecycle', lazyLifecycle(() => buildLifecycleLazy(ctx, binder)))
  ctx.provide('deepartments.wakepack', lazyWakePack(() => buildWakePackLazy(ctx, binder)))

  // --- deepartments.bus / deepartments.deliver (FASE 2.6-B-2): LAZY SERVICE
  // SHELLS built ON FIRST USE (never at apply time), so the bundle can
  // binder.register(...) after its own state is ready. Buckets (a)/(b) resolve
  // internally (org stateDir + sidecar marks + harness subagents); bucket (c)
  // comes from binder.get().bus / .redeliver / .deliver. A required bucket-(c)
  // dep missing at use FAILS LOUD (R1 — never silently unbound). ---
  ctx.provide('deepartments.bus', lazyBus(() => buildBusLazy(ctx, binder)))
  ctx.provide('deepartments.deliver', lazyDeliver(() => buildDeliverLazy(ctx, binder)))
}
