// dshd-core-min — the MINIMAL-COMPOSITION org-fallback plugin (LANE 0.2.3,
// gap 3 TOTAL MODULARITY — single-source of the org config).
//
// WHY THIS PACKAGE: the bundle's `deepartments` row used to MIRROR the org
// config (dshd-core is the ONE source of truth in the full composition) so a
// minimal/hermetic composition WITHOUT dshd-core still resolved the org from
// the in-bundle fallback. That double mirror is dismantled here: the bundle
// row no longer carries the shared org keys, and THIS package is the DECLARED
// FALLBACK for compositions where dshd-core is absent (bundle-alone — the
// headless twin / hermetic tests that need the org). It provides
// `deepartments.org` with the SAME signature/semantics as dshd-core
// (index.ts:692-696 — `{ stateDir, org: config.org }`), so the boot factory's
// shared-first read (`coreOrg?.org ?? cfg.org`, dshd-orchestration
// boot.ts:350-359) is behavior-neutral.
//
// SCOPE CONTRACT: this plugin provides ONLY `deepartments.org`. It does NOT
// register the core services (catalog/acl/bus/deliver/…) — a minimal
// composition that needs those composes the FULL dshd-core instead. The row
// carries EXACTLY the shared org keys (stateDir, org.departments,
// org.poolerBaseURL, org.workerAgentOptions, org.hostAgentOptions) and NO
// postsRetention (pruning stays OFF in a minimal composition — the
// conservative one-sided contract) and NO pacing/quality (bundle-only knobs).
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'

/** The org config mirror this plugin carries (the SHARED keys only — a
 * structural subset of the bundle's `Config.org` AND of dshd-core's
 * `OrgConfig`, so the surface is consumed verbatim by the same readers). */
export interface OrgConfigMin {
  departments?: {
    id?: string
    name?: string
    workspacePath?: string
    jobDir?: string
    purpose?: string
    services?: string
    coordinator?: {
      postId?: string
      role?: string
      title?: string
      sessionTitle?: string
      provider?: string
      agentOptions?: { provider?: string; model?: string; maxTokens?: number; reasoningEffort?: 'max' | 'high' | 'medium' | 'low' }
    }
  }[]
  poolerBaseURL?: string
  /** R4 (providers → org config): the default worker/host model route —
   * resolved org-driven by dshd-orchestration's presets factory. */
  workerAgentOptions?: { provider?: string; model?: string; reasoningEffort?: 'max' | 'high' | 'medium' | 'low' }
  hostAgentOptions?: { provider?: string; model?: string; reasoningEffort?: 'max' | 'high' | 'medium' | 'low' }
}

/** The dshd-core-min plugin config. */
export interface ConfigMin {
  /** The org stateDir (posts.json + hosts.json + messages.jsonl). */
  stateDir: string
  /** The shared org config (departments + poolerBaseURL + agent options). */
  org?: OrgConfigMin
}

export const name = 'dshd-core-min'
// Resolve nothing at apply time (the bundle reads `deepartments.org` at its
// own apply — provided SYNCHRONOUSLY here, the cordis-plugin-loader shape).
export const inject: string[] = []

export function apply(ctx: Context, config: ConfigMin) {
  const stateDir = config.stateDir
  // The SAME surface shape + resolution as dshd-core/src/index.ts:692-696
  // (FASE 2.6 BATCH A): `{ stateDir, org }` provided verbatim so the bundle
  // and this fallback always agree on the same org.
  const orgSurface: { stateDir: string; org: OrgConfigMin } = {
    stateDir,
    org: config.org ?? { departments: [] }
  }
  ctx.provide('deepartments.org', orgSurface)
  ctx.logger.info('[dshd-core-min] online — the minimal-composition org fallback provides deepartments.org')
}