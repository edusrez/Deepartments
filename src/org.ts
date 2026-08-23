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
import type { ParallelConfig } from './invoke.js'

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
  /**
   * Optional real workspace directory of the department (spec 004 §3.1/§6.2):
   * the department's own sidebar folder. F5 creates the workspace entity at
   * this path and every head/worker of the department is created with
   * `meta.cwd` = this path. OPTIONAL this phase (F1): absent/empty = the
   * department keeps the shared workspace root (pre-F1 behavior).
   */
  workspacePath?: string
  /**
   * Optional repo-relative directory holding the department's versioned job
   * definitions (spec 004 §3.3 — `dept_job_run` reads them, F4). OPTIONAL this
   * phase (F1): absent/empty = no jobs declared yet.
   */
  jobDir?: string
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
    /**
     * Optional extra filesystem roots a department post's `dept_exec` may
     * operate under, in ADDITION to the fixed/derived defaults (the repo root,
     * the department workspace, the runtime stateDir and the fixed project
     * roots). Empty by default — an absent key keeps the default behavior of
     * every other org field. `dept_exec` accepts only commands/cwd under the
     * union of these roots + the defaults; anything else is out of scope.
     */
    execRoots?: string[]
  }
  /**
   * Custom `ctx.web` fetch provider config (blocking detection).
   * Optional; defaults are applied in src/webfetch.ts.
   */
  webfetch?: WebFetchConfig
  /**
   * Parallel Web Systems event_stream monitor config (W3b parallel-monitor).
   * Optional; when `monitors` is ABSENT the CODE default
   * (DEFAULT_PARALLEL_MONITORS) is used, an explicit `[]` disables monitoring.
   * Mirrors the runtime shape declared in src/invoke.ts (ParallelConfig), so
   * the schema and the typed cast in invoke.ts always agree.
   */
  parallel?: ParallelConfig
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
      // F1 (spec 004 §3.1): OPTIONAL department fields, empty by default —
      // a config without them (the pre-F1 shape) keeps composing untouched.
      workspacePath: z.string().default(''),
      jobDir: z.string().default(''),
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
    })).default([]),
    // B2 (spec W5): extra scoped roots for dept_exec — optional, empty default.
    // Mirrors Config.org.execRoots. An absent key (pre-B2 config) defaults to
    // [] so the existing behavior is byte-compatible.
    execRoots: z.array(z.string()).default([])
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
  }),
  // W3b parallel-monitor (Parallel event_stream). Mirrors the runtime
  // ParallelConfig/ParallelMonitorConfig in src/invoke.ts: `monitors` defaults
  // to `void 0` (= undefined) so an ABSENT section or absent `monitors` key both
  // fall through to the CODE default (DEFAULT_PARALLEL_MONITORS), while an
  // explicit `[]` still disables monitoring — exactly the resolver's contract.
  parallel: z.object({
    apiKey: z.string(),
    baseUrl: z.string(),
    maxConsecutiveSpawns: z.number().step(1).min(0),
    monitors: z.array(z.object({
      id: z.string().required(),
      query: z.string().required(),
      processor: z.union([z.const('lite'), z.const('base')]),
      frequency: z.string(),
      outputSchema: z.dict(z.any()).default(void 0 as unknown as any),
      sourcePolicy: z.array(z.string()).default(void 0 as unknown as any),
      includeBackfill: z.boolean()
    })).default(void 0 as unknown as any)
  }).default(void 0 as unknown as {
    apiKey: string
    baseUrl: string
    maxConsecutiveSpawns: number
    monitors: {
      id: string
      query: string
      processor: 'lite' | 'base'
      frequency: string
      outputSchema: Record<string, unknown>
      sourcePolicy: string[]
      includeBackfill: boolean
    }[]
  })
})
