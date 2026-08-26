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
  coordinator?: {
    postId?: string
    role?: string
    title?: string
    sessionTitle?: string
    provider?: string
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
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
}
