// dsh-deepartments — organization configuration (spec 003, Batch B3 cutover):
// the static board-of-directors architecture is RETIRED (§7.1) — no rooms,
// no board files, no projections, no emit site. What remains is
// CONFIGURATION: the department (agent) catalog — one head per department,
// whose coordinator is materialized as a permanent root agent by
// src/invoke.ts — plus the plugin configuration (stateDir, webfetch).
// Durable membership lives in posts.json/hosts.json (src/invoke.ts); agent
// communication is the direct BUS (src/messages-store.ts + send_message).
// A config with `org: { departments: [...] }` and NO rooms is valid.
//
// Coordinator config is DECLARED here (postId/role/provider/agentOptions). The
// coordinator spec is the CONFIG for a permanent department head. Runtime head
// materialization lives in src/invoke.ts (Batch B): a configured coordinator is
// spawned ONCE as a permanent, minimal-context resident post (provider 'spawn',
// persona = role, lean `toolFilter: { allow: [] }`) with an official
// spatial-deployment context, or retired via `dept_post_retire`. The old
// dept_invoke fork path is retired (Batch A) and is NOT restored.
//
// NO export default (pitfall 0001 — breaks `inject`).
import z from '@deepseek-ai/schemastery'
import type { WebFetchConfig } from './webfetch.js'

/** The post spec of a department's coordinator (created in Batch 2). */
export interface CoordinatorConfig {
  postId: string
  role: string
  /** Optional display title (e.g. "Head of Research") for the client sidebar /
   * agent-row presentation. Falls back to `role`, then `postId`. */
  title?: string
  /** Optional native-sidebar SESSION title pinned on the head's live session
   * (Piece 1 — `session/title` user-kind pin; e.g. "Research Head"). Falls
   * back to the head default in invoke.ts when absent. */
  sessionTitle?: string
  provider?: string
  agentOptions?: { provider?: string; model?: string; maxTokens?: number }
}

/** One department: an agent of the catalog + the spec of its coordinator post. */
export interface DepartmentConfig {
  id: string
  name: string
  coordinator?: CoordinatorConfig
}

/** Plugin config: workspace state dir + the department (agent) catalog. */
export interface Config {
  stateDir: string
  /**
   * Optional subagent provider name retained for config compatibility with
   * legacy dept_invoke forks (the fork path is RETIRED in Batch A). Kept in
   * the schema because cordis.patch.yml may declare it; no runtime reference
   * remains after the fork machinery was removed.
   */
  forkProvider?: string
  org: {
    departments: DepartmentConfig[]
  }
  /**
   * Custom `ctx.web` fetch provider config (blocking detection).
   * Optional; defaults are applied in src/webfetch.ts.
   */
  webfetch?: WebFetchConfig
}

/**
 * Schemastery configuration for the organization architecture.
 * Annotated `z<any, any>`: arrays of object schemas make the inferred type
 * unnameable in the emitted .d.ts (TS2742, cosmokit `Dict` internals) — the
 * schema is a runtime validator; the compile-time shape is `Config` above.
 */
export const Config: z<any, any> = z.object({
  stateDir: z.string().default('.deepartments'),
  forkProvider: z.string(),
  org: z.object({
    departments: z.array(z.object({
      id: z.string().required(),
      name: z.string().default(''),
      coordinator: z.object({
        postId: z.string().required(),
        role: z.string().default(''),
        title: z.string().default(''),
        sessionTitle: z.string().default(''),
        provider: z.string(),
        agentOptions: z.object({
          provider: z.string(),
          model: z.string(),
          maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
        }).default(void 0 as unknown as { provider: string; model: string; maxTokens: number })
      }).default(void 0 as unknown as { postId: string; role: string; title: string; sessionTitle: string; provider: string; agentOptions: { provider: string; model: string; maxTokens: number } })
    })).default([])
  }).required(),
  webfetch: z.object({
    enabled: z.boolean(),
    userAgent: z.string(),
    accept: z.string(),
    maxUrlLength: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    maxResponseBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    maxRedirects: z.number().step(1).min(0).max(100).default(5)
  }).default(void 0 as unknown as {
    enabled: boolean
    userAgent: string
    accept: string
    maxUrlLength: number
    timeoutMs: number
    maxResponseBytes: number
    maxRedirects: number
  })
})
