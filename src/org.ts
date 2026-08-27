// dsh-deepartments — organization configuration (spec 003, Batch B3 cutover):
// the static board-of-directors architecture is RETIRED (§7.1) — no rooms,
// no board files, no projections, no emit site. What remains is
// CONFIGURATION: the department (agent) catalog — one head per department,
// whose coordinator is materialized as a permanent root agent by
// src/invoke.ts — plus the plugin configuration (stateDir, parallel, health,
// quality).
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
  agentOptions?: { provider?: string; model?: string; maxTokens?: number; reasoningEffort?: 'max' | 'high' | 'medium' | 'low' }
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

/** System-health monitoring config (spec W6, owner request 2026-08-23:
 * "monitorizar que todo va bien"). Optional; defaults are CODE-level:
 * `enabled` defaults to true, `intervalMs` defaults to 60000. An ABSENT section
 * (or absent `enabled`) keeps monitoring ON; an explicit
 * `health: { enabled: false }` disables the daemon (no heartbeat, no alerts).
 *
 * W8-c SAFEGUARDS PACKAGE (owner "tenemos que crear salvaguardas", 2026-08-24):
 * each individual safeguard is default-on and individually disable-able:
 * `turnErrorCaptureEnabled`, `staleLiveWatchdogEnabled` (+ `staleLiveMinutes`)
 * and `presetAuditEnabled`. Absent → all on (code defaults); an explicit
 * `false` disables THAT safeguard (and its alert class is never emitted).
 */
export interface HealthConfig {
  /** When explicitly false the system-health daemon is NOT registered (no
   * heartbeat write, no alerts). Absent → enabled (default true). */
  enabled?: boolean
  /** The daemon tick interval in ms (default 60000). */
  intervalMs?: number
  /** W8-c PART 1 — when explicitly false, a live post session whose turn ends in
   * an error is NOT recorded into post-errors.jsonl (no turn-error alert class).
   * Absent → enabled (default true). */
  turnErrorCaptureEnabled?: boolean
  /** W8-c PART 2 — when explicitly false, the stale-live watchdog is NOT run (a
   * catalog-live post with pending addressed messages and no session writes for
   * `staleLiveMinutes` is NOT flagged/alerts). Absent → enabled (default true). */
  staleLiveWatchdogEnabled?: boolean
  /** W8-c PART 2 — the staleness threshold in minutes (default 10): a post is
   * "stalled" when its session log has NO writes for at least this long while it
   * holds pending addressed messages. Must be a positive number; invalid/absent
   * → the code default (10). */
  staleLiveMinutes?: number
  /** W8-c PART 3 — when explicitly false, the boot preset audit is NOT run (no
   * config-preset finding/alert for a preset text holding an unbound template
   * reference). Absent → enabled (default true). */
  presetAuditEnabled?: boolean
  /** W8-d PART C — the system heartbeat to the Asistente (CONTEXT INJECTION +
   * CONDITIONAL WAKE, no standalone hourly message; owner idea 2026-08-24
   * "que el asistente reciba un latido cada hora con la última entrada de
   * actividad propia y de los agentes activos"). When explicitly false, the
   * host wake-pack `## System heartbeat:` section is OMITTED and the daemon does
   * NOT evaluate the conditional system-wait wake (both are off together).
   * Absent → enabled (default true — the section + the conditional wake are on,
   * but the daemon still only wakes on the WAIT condition: zero noise
   * otherwise). */
  heartbeatEnabled?: boolean
  /** W8-d PART C — the quiet-expectation threshold in ms (default
   * 30*60*1000 = 30 min): the WAIT condition holds when the host sent a message
   * to a post that produced NO reply AND NO session activity for at least this
   * long, waking the host once per window via a `system-wait:` bus message.
   * Must be a positive number; invalid/absent → the code default (30 min). */
  waitThresholdMs?: number
  /** M1 (owner decision, anti-hang) — the POOLER-CAPACITY watchdog gate
   * (default ON; an explicit `false` disables the scan): the system-health
   * daemon alerts the host BEFORE the pooler paralyzes when the usable-key
   * count drops, blocks accumulate, an usage percent runs hot, the state file
   * goes stale (the dead-man's switch), or the last rotation was a 429 to NO
   * key (the 503 prelude). The scan READS the pooler's own
   * `<DSH_HOME>/keyPooler-state.json` SOLO-LECTURA (the pooler owns every
   * write; the watchdog never writes it). All numeric knobs are optional —
   * absent/invalid → the code defaults below. */
  poolerCapacityEnabled?: boolean
  /** M1 — ≤ this many USABLE keys (the pooler's own eligibility:
   * !invalid && blockedUntil<=now && cooldownUntil<=now) → a
   * `pooler-capacity:warning` finding (default 2). */
  warningUsableKeys?: number
  /** M1 — ≤ this many USABLE keys → a `pooler-capacity:critical` finding — the
   * mission's "alert BEFORE paralysis" threshold (default 1). */
  criticalUsableKeys?: number
  /** M1 — ≥ this many currently blocked/cooldown keys → a
   * `pooler-capacity:warning` finding (default 3). */
  blockedKeysInWindow?: number
  /** M1 — a usable key whose upstream usage percent is ≥ this → a
   * `pooler-capacity:warning` finding (default 90 — the pooler's own highPercent). */
  highPercent?: number
  /** M1 — the dead-man's switch: when `now − updatedAt` of the pooler state
   * file exceeds this (default 600000 = 10 min) the state is STALE →
   * `pooler-capacity:critical` (the pooler writes the file only on health
   * changes, so a silent pooler is a suspect pooler). */
  stateStaleMs?: number
  /** M1 — the absolute path of the pooler state file the watchdog READS;
   * absent → the derived default `join(DSH_HOME||~/.dsh, 'keyPooler-state.json')`. */
  poolerStateFilePath?: string
  /** M1 — the QI-SILENCE watchdog gate (default ON; an explicit `false`
   * disables the scan): the daemon guarantees the worker-retire quality-inspect
   * TRIGGER — it alerts the host when worker retirements accumulate inside the
   * window with ZERO emitted directives, using a RATE-AWARE threshold so the
   * 25% dice's normal per-retirement silence never screams. */
  qiSilenceEnabled?: boolean
  /** M1 — the qi-silence window in minutes (default 120): retirements
   * (ledger firstSeen) and directives (messages.jsonl ts) are counted inside it. */
  qiSilenceWindowMinutes?: number
  /** M1 — the minimum worker retirements in the window with ZERO directives
   * that alerts; absent → the RATE-AWARE default: ceil(ln(0.05)/ln(1-p)) with p
   * = the shared worker-inspect dice (`quality.workerInspectProbability`;
   * p=0.25 → 11, p=1 → 1, p≤0 → never alerts). An explicit value overrides. */
  qiSilenceMinRetiresInWindow?: number
}

/**
 * Quality Department (QD) config (spec 007 §4.1, D-Q2). Optional; the ONLY knob
 * is the worker-archive dice probability. Defaults are CODE-level:
 * `workerInspectProbability` defaults to 0.25 so an ABSENT section (or an absent
 * key) keeps the 25% worker sample — the config composes untouched. An
 * invalid / out-of-[0,1] value falls back to 0.25 (the
 * `health.staleLiveMinutes` fallback pattern). The head+host 100% mandate
 * (D-Q3) is NOT a knob — it is structural in `qualityInspectDecision`
 * (kind 'head'/'host' always true, never a die).
 */
export interface QualityConfig {
  /** The worker-retire dice probability (default 0.25): when a disposable
   * WORKER session is archived (`dept_worker_retire`), wake a QD inspection with
   * this probability. Must be in [0,1]; invalid/absent → the code default
   * 0.25. The head/host 100% mandate (D-Q3) is never gated by this knob. */
  workerInspectProbability?: number
}

/**
 * A3/C2 — durable posts.json RETIRED-entry retention policy (the prune/archive
 * knob). Optional. Defaults are CODE-level: `maxRetiredKept` defaults to 50,
 * `archiveFile` defaults to `posts-retired-archive.jsonl`, `enabled` defaults to
 * false (pruning OFF unless explicitly true). Mirrors the `health`/`quality` pattern: an ABSENT section
 * (or an absent key) falls through to the code defaults, so the config composes
 * untouched.
 *
 * > PRODUCTION GATE: enabling pruning in production requires owner confirmation
 * > of the retention policy (the default N retiradas conservadas = 50 is PENDING
 * > confirmation) before the prune runs on the live registry.
 */
export interface PostsRetentionConfig {
  /** Max RETIRED entries to KEEP in posts.json when pruning runs. Absent →
   * code default 50. When the durable posts.json holds MORE retired entries
   * than this, the OLDEST retired entries beyond the newest `maxRetiredKept`
   * are moved to the retired archive (never erased). */
  maxRetiredKept?: number
  /** The archive filename to append pruned retired entries to, under stateDir.
   * Absent → code default `posts-retired-archive.jsonl`. */
  archiveFile?: string
  /** When explicitly false (or absent), retired-entry pruning is SKIPPED (the retire mark +
   * gone-worker logic still run). Absent → false (pruning OFF unless explicitly enabled). */
  enabled?: boolean
}

/**
 * One configured event_stream monitor of the deepartments plugin. The `query`
 * is the NL intent Parallel runs (settings.query); `processor`/`frequency`
 * mirror POST /v1/monitors (defaults `base`/`1d`). The whole array is read
 * from `parallel.monitors` in the plugin config; when the section is ABSENT the
 * CODE DEFAULT (DEFAULT_PARALLEL_MONITORS) is used, so the deployment works
 * without touching the config (or /opt).
 */
export interface ParallelMonitorConfig {
  /** Stable key for this monitor (its worker slug base + the state key). */
  id: string
  /** The natural-language query intent (settings.query). */
  query: string
  /** The Parallel processor: 'lite' ($3/1000 exec) or 'base' ($10/1000 exec,
   * more recall — the default for a broad topic like DeepSeek/AI news). */
  processor?: 'lite' | 'base'
  /** The Parallel frequency (e.g. '1d', '6h'; default '1d'). */
  frequency?: string
  /** Optional `settings.output_schema` JSON so each event comes back as
   * structured output (easier to parse for activation). */
  outputSchema?: Record<string, unknown>
  /** Optional `settings.advanced_settings.source_policy.include_domains`. */
  sourcePolicy?: string[]
  /** Optional `settings.include_backfill` (historical preview on the first run). */
  includeBackfill?: boolean
}

/** The `parallel` plugin-config section (read via `config.parallel`). When
 * `monitors` is ABSENT the code default is used; an EXPLICIT `[]` disables
 * monitoring (nothing runs). */
export interface ParallelConfig {
  apiKey?: string
  baseUrl?: string
  /** Max concurrent LIVE worker-researchers per monitor (the storm guard). */
  maxConsecutiveSpawns?: number
  monitors?: ParallelMonitorConfig[]
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
    /**
     * MISSION-LEVEL owner grant of ADDITIONAL scoped roots for `dept_exec` — an
     * EXPLICIT, REVOCABLE, AUDITABLE way to grant a worker shell access to an
     * OWNER-PROTECTED surface (e.g. the STABLE home `/opt/dsh/.dsh`) for the
     * DURATION of an owner-authorized mission. Populated by a mission-level
     * owner approval; the guard reads it as ADDITIONAL allowed roots, and the
     * stable-profile token is bypassed ONLY for a root this grant names (any
     * reference NOT named by the grant stays protected-denied). Empty by
     * default — an ABSENT key keeps the default deny (no silent widening);
     * remove the entries to REVOKE. The grant is config-recorded (auditable),
     * never an env default. The Asistente-direct path remains the alternative.
     */
    missionExecRoots?: string[]
    /**
     * P1 rewire-pooler: the pooler (dsh-key-pooler) baseURL — the LEGITIMATE
     * local/proxy LLM route (e.g. http://127.0.0.1:4097/v1) the opencode-zen
     * provider points at. An EXACT-MATCH exemption for the endpoint-drift rule:
     * `providerAdapterEndpointDrift` treats a baseURL EQUAL to this value as a
     * healthy route (NOT drift), so the boot provider-adapter check does not
     * false-alert on the pooler — while ANY OTHER local/proxy baseURL
     * (127.0.0.1 / localhost / 0.0.0.0 not equal to the pooler) STAYS a drift.
     * Absent (undefined) → NO exemption (every local/proxy baseURL is still
     * drift — no blind localhost hardcode). The `maxRetries: 0` stale-profile
     * signal is NEVER exempted by this field.
     */
    poolerBaseURL?: string
    /**
     * A3/C2 — durable posts.json RETIRED-entry retention (the prune/archive
     * policy). Optional; defaults are CODE-level (maxRetiredKept 50,
     * archiveFile 'posts-retired-archive.jsonl', enabled false (pruning OFF unless explicitly true)). An ABSENT section
     * (or absent key) falls through to the code defaults — the config composes
     * untouched. Mirrors the `health`/`quality` pattern.
     */
    postsRetention?: PostsRetentionConfig
  }
  /**
   * Parallel Web Systems event_stream monitor config (W3b parallel-monitor).
   * Optional; when `monitors` is ABSENT the CODE default
   * (DEFAULT_PARALLEL_MONITORS) is used, an explicit `[]` disables monitoring.
   * Declared here (org.ts) and consumed by the runtime in src/invoke.ts, so
   * the schema and the typed cast in invoke.ts always agree.
   */
  parallel?: ParallelConfig
  /**
   * System-health monitoring (spec W6). Optional — defaults are CODE-level
   * (enabled:true, intervalMs:60000); an explicit `{ enabled: false }`
   * disables the daemon. Mirrors the runtime shape declared in src/invoke.ts
   * (HealthConfig), so the schema and the typed config always agree.
   */
  health?: HealthConfig
  /**
   * Quality Department (QD) config (spec 007 §4.1, D-Q2). Optional — the sole
   * knob is `workerInspectProbability` (code default 0.25); an ABSENT section or
   * absent key composes untouched. Mirrors the runtime shape declared in
   * src/invoke.ts, so the schema and the typed cast in invoke.ts always agree.
   */
  quality?: QualityConfig
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
          maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
          // F7 model-flash (uniformity heads=workers): the coordinator carries
          // `reasoningEffort: max` (cordis.patch.yml) exactly like the worker
          // preset; DECLARING it here (a union of the model's accepted literals)
          // keeps it from being stripped by the schema on parse, so a head runs
          // with max too. Optional — absent config composes untouched.
          reasoningEffort: z.union([z.const('max'), z.const('high'), z.const('medium'), z.const('low')])
        }).default(void 0 as unknown as { provider: string; model: string; maxTokens: number; reasoningEffort: 'max' | 'high' | 'medium' | 'low' })
      }).default(void 0 as unknown as { postId: string; role: string; title: string; sessionTitle: string; provider: string; agentOptions: { provider: string; model: string; maxTokens: number; reasoningEffort: 'max' | 'high' | 'medium' | 'low' } })
    })).default([]),
    // B2 (spec W5): extra scoped roots for dept_exec — optional, empty default.
    // Mirrors Config.org.execRoots. An absent key (pre-B2 config) defaults to
    // [] so the existing behavior is byte-compatible.
    execRoots: z.array(z.string()).default([]),
    // MISSION-LEVEL owner grant of additional scoped roots (mirrors
    // Config.org.missionExecRoots). An ABSENT key (no mission grant) defaults
    // to [] so the protected stable profile stays DENIED without an explicit
    // grant — never a silent/env-default widening. Config-recorded + revocable.
    missionExecRoots: z.array(z.string()).default([]),
    // P1 rewire-pooler: the pooler baseURL is a LEGITIMATE local/proxy LLM route
    // (mirrors Config.org.poolerBaseURL). An ABSENT key → NO exemption (the
    // endpoint-drift rule stays valid for every other local/proxy baseURL); an
    // EXACT-MATCH of the configured value is never flagged as drift. The
    // maxRetries:0 stale-profile signal is NEVER relaxed by this field.
    poolerBaseURL: z.string(),
    // A3/C2 — durable posts.json RETIRED-entry retention (mirrors Config.org.
    // postsRetention). `default(void 0)` so an ABSENT section or absent key
    // falls through to the CODE defaults (maxRetiredKept 50, archiveFile
    // 'posts-retired-archive.jsonl', enabled false (pruning OFF unless explicitly
    // true)) — exactly the health/quality section's contract.
    postsRetention: z.object({
      maxRetiredKept: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
      archiveFile: z.string(),
      enabled: z.boolean()
    }).default(void 0 as unknown as { maxRetiredKept: number; archiveFile: string; enabled: boolean })
  }).required(),
  // W3b parallel-monitor (Parallel event_stream). Mirrors the runtime
  // ParallelConfig/ParallelMonitorConfig declared here in org.ts: `monitors` defaults
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
  }),
  // W6 system-health. Mirrors the runtime HealthConfig in src/invoke.ts:
  // `default(void 0)` so an ABSENT section or absent keys fall through to the
  // CODE defaults (enabled:true, intervalMs:60000), while an explicit
  // `health:{ enabled:false }` still disables the daemon — exactly the
  // parallel section's contract. W8-c adds the four per-safeguard knobs
  // (turnErrorCaptureEnabled / staleLiveWatchdogEnabled + staleLiveMinutes /
  // presetAuditEnabled), all `default(void 0)` so absent → code default-on.
  // W8-d adds the system-heartbeat knobs (heartbeatEnabled / waitThresholdMs),
  // likewise `default(void 0)` so absent → code defaults (on, 30 min).
  health: z.object({
    enabled: z.boolean(),
    intervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    turnErrorCaptureEnabled: z.boolean(),
    staleLiveWatchdogEnabled: z.boolean(),
    staleLiveMinutes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    presetAuditEnabled: z.boolean(),
    heartbeatEnabled: z.boolean(),
    waitThresholdMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    // M1 — the pooler-capacity + qi-silence watchdog knobs (all `default(void 0)`
    // → absent = code defaults, the existing health-section contract).
    poolerCapacityEnabled: z.boolean(),
    warningUsableKeys: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
    criticalUsableKeys: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
    blockedKeysInWindow: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
    highPercent: z.number().min(0).max(100),
    stateStaleMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    poolerStateFilePath: z.string(),
    qiSilenceEnabled: z.boolean(),
    qiSilenceWindowMinutes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    qiSilenceMinRetiresInWindow: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
  }).default(void 0 as unknown as {
    enabled: boolean
    intervalMs: number
    turnErrorCaptureEnabled: boolean
    staleLiveWatchdogEnabled: boolean
    staleLiveMinutes: number
    presetAuditEnabled: boolean
    heartbeatEnabled: boolean
    waitThresholdMs: number
    poolerCapacityEnabled: boolean
    warningUsableKeys: number
    criticalUsableKeys: number
    blockedKeysInWindow: number
    highPercent: number
    stateStaleMs: number
    poolerStateFilePath: string
    qiSilenceEnabled: boolean
    qiSilenceWindowMinutes: number
    qiSilenceMinRetiresInWindow: number
  }),
  // QD (spec 007 §4.1, D-Q2). Mirrors the runtime QualityConfig in src/invoke.ts:
  // `default(void 0)` so an ABSENT section or absent key falls through to the
  // CODE default (workerInspectProbability 0.25); a present invalid or
  // out-of-[0,1] value likewise falls back to 0.25 — exactly the health
  // section's contract. The head+host 100% mandate is NOT a knob (structural in
  // qualityInspectDecision, kind 'head'/'host' always true).
  quality: z.object({
    workerInspectProbability: z.number().min(0).max(1)
  }).default(void 0 as unknown as { workerInspectProbability: number })
})
