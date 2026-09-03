// dshd-orchestration — org-config structural MIRRORS (LANE 0.2.2, gap 2).
// The moved factories' deps interfaces reference the bundle-local org config
// TYPES (Config / CoordinatorConfig / DepartmentConfig / PostsRetentionConfig
// / ParallelConfig / ParallelMonitorConfig — src/org.ts) at TYPE level only
// (erased at compile): the package CANNOT import them from the bundle (a
// require cycle — dsh-deepartments depends on this package), so they are
// re-declared here as STRUCTURAL SUBSET MIRRORS of the exact fields the
// factories READ (the established "doble-mirror" pattern — dshd-core already
// mirrors OrgConfigSurface/PacingConfigLike the same way; gap 3/R4 of 0.2.3
// unifies the config types in dshd-core). The bundle's REAL config objects are
// structurally assignable to these mirrors (the real types are SUPERSETS), so
// the holders' `register({ config, org, ... })` calls from the bundle stay
// type-checked, and the factories' internal reads (config.health?.x,
// org.departments, org.execRoots, org.pacing …) compile against the subset.
//
// NO export default (pitfall 0001 — breaks `inject`).

/** Mirror of src/org.ts CoordinatorConfig (subset: the fields the factories
 * read — postId/role/title/sessionTitle/provider/agentOptions). */
export interface CoordinatorConfig {
  postId: string
  role: string
  title?: string
  sessionTitle?: string
  provider?: string
  agentOptions?: { provider?: string; model?: string; maxTokens?: number; reasoningEffort?: 'max' | 'high' | 'medium' | 'low' }
}

/** Mirror of src/org.ts DepartmentConfig (subset: id/name/workspacePath/jobDir/
 * purpose/services/coordinator). */
export interface DepartmentConfig {
  id: string
  name: string
  workspacePath?: string
  jobDir?: string
  purpose?: string
  services?: string
  coordinator?: CoordinatorConfig
}

/** Mirror of the org pacing window shape (structurally compatible with the
 * bundle's PacingWindowHoursConfig AND dshd-core's PacingConfigLike). */
export interface PacingWindowHoursConfig {
  weekday?: number[]
  hours?: number[]
}

/** Mirror of the org pacing shape (structurally compatible with the bundle's
 * PacingConfig AND dshd-core's PacingConfigLike). */
export interface PacingConfig {
  enabled?: boolean
  peakWindows?: PacingWindowHoursConfig
  peakBufferMs?: number
}

/** Mirror of src/org.ts PostsRetentionConfig (A3/C2). */
export interface PostsRetentionConfig {
  maxRetiredKept?: number
  archiveFile?: string
  enabled?: boolean
}

/** Mirror of src/org.ts ParallelConfig (W3b). */
export interface ParallelConfig {
  apiKey?: string
  baseUrl?: string
  maxConsecutiveSpawns?: number
  monitors?: ParallelMonitorConfig[]
}

/** Mirror of src/org.ts ParallelMonitorConfig (W3b). */
export interface ParallelMonitorConfig {
  id: string
  query: string
  processor?: 'lite' | 'base'
  frequency?: string
  outputSchema?: Record<string, unknown>
  sourcePolicy?: string[]
  includeBackfill?: boolean
}

/** Mirror of src/org.ts GhostSuspectConfig (B5-GHOST — the subset the tools
 * factory reads: enabled/warnAfterTicks/retireAfterTicks). */
export interface GhostSuspectConfig {
  enabled?: boolean
  warnAfterTicks?: number
  retireAfterTicks?: number
}

/** fb-78 A1 — the F3-stale residue knob (`org.retiredResidue`): the boot
 * retired-worker-residue pass also archives top-level /ungrouped durable
 * sessions with NO post and NO live host once they are STALE (age >= minAgeMs).
 * Defaults are CODE-level (enabled true, minAgeMs 48h); an ABSENT section (or
 * absent key) keeps the code defaults — the health/quality compose-untouched
 * contract; an explicit `enabled: false` restores the pre-fb-78 behavior (only
 * the retired-worker residue sweep, F3-stale out). Mirrors src/org.ts. */
export interface RetiredResidueConfig {
  /** When explicitly false, the F3-stale phase of the boot residue pass does
   * NOT run (a no-post stale session is left visible). Absent → enabled
   * (default true — the owner decision: every top-level /ungrouped no-post
   * stale session is archived). */
  enabled?: boolean
  /** The minimum session age (ms) before a no-post/no-host/no-live session is
   * archived. Default 48h (172800000). A session whose age cannot be
   * determined is conservatively NOT archived. */
  minAgeMs?: number
}

/** fb-78 A2 — the offline-worker reap knob (`org.offlineReap`): the boot
 * census that reaps NON-retired workers whose session has NO live handle and
 * NO sleepEpoch for a wall-clock window (the fb-56 orphaned class — durable
 * session present, daemon-killed mid-mission). Defaults are CODE-level
 * (enabled FALSE — conservative, m-228 respected; maxOfflineMs 72h). Absent
 * section/key → the pass does NOT run (the daemon-of-health exclusion stays);
 * an explicit `enabled: true` opts into the reap. Mirrors src/org.ts. */
export interface OfflineReapConfig {
  /** When explicitly true the boot offline-reap census runs. Absent → OFF
    * (the m-228 conservative default — the health daemon never retires a
    * non-retired worker without a live handle; the reap is the opt-in boot
    * pass that does). */
  enabled?: boolean
  /** How long (ms) a worker must be continuously offline (no live handle, no
   * sleepEpoch) before it becomes a retire candidate. Default 72h
   * (259200000). */
  maxOfflineMs?: number
}

/** Mirror of src/org.ts HealthConfig (the W6 knobs the factories read —
 * structural subset: the dispatch/preset/worker-register gates + the paths).
 * THE REST of the health knobs are resolver-internal to dshd-health (this
 * package never reads them). */
export interface HealthConfig {
  enabled?: boolean
  intervalMs?: number
  turnErrorCaptureEnabled?: boolean
  presetsAuditEnabled?: boolean
  presetAuditEnabled?: boolean
  heartbeatEnabled?: boolean
  waitThresholdMs?: number
  poolerDispatchEnabled?: boolean
  poolerGateEnabled?: boolean
  highPercent?: number
  stateStaleMs?: number
  /** LANE ② R1 — the freshness window of the 429→null `lastRotation` signal
   * (default 15 min): the dispatch pre-check blocks ONLY on a FRESH rotation;
   * a STALE 429→null rotation never re-arms the gate. */
  rotationStaleMs?: number
  poolerCapacityEnabled?: boolean
  poolerStateFilePath?: string
  workRegisterPath?: string
  workRegisterIdleEnabled?: boolean
  workRegisterIdleQuietMs?: number
  mainRedRepoRoot?: string
  staleLiveWatchdogEnabled?: boolean
  staleLiveMinutes?: number
  turnEndErrorNotifyEnabled?: boolean
  missionStallEnabled?: boolean
  missionQueueEnabled?: boolean
  catchupEnabled?: boolean
  /** LANE ② — the NON-BOOT redelivery SWEEP cadence (ms; default 60000): how
   * often the re-drive sweep re-runs the due prepared/failed pairs (per-pair
   * backoff + max-attempts; a gate clean-up reaches the pending pairs with NO
   * restart). */
  redeliverySweepIntervalMs?: number
}

/** Mirror of src/org.ts Config — the SUBSET the factories read: stateDir +
 * org (departments/execRoots/missionExecRoots/poolerBaseURL/postsRetention/
 * ghostSuspect/pacing) + health + parallel/quality (optional, not read here).
 * Structurally assignable FROM the bundle's real Config (a superset). */
export interface Config {
  stateDir: string
  forkProvider?: string
  org: {
    departments: DepartmentConfig[]
    execRoots?: string[]
    missionExecRoots?: string[]
    poolerBaseURL?: string
    postsRetention?: PostsRetentionConfig
    ghostSuspect?: GhostSuspectConfig
    retiredResidue?: RetiredResidueConfig
    offlineReap?: OfflineReapConfig
    pacing?: PacingConfig
    // R4 (LANE 0.2.3 — providers → org config): the org-declared default
    // worker/host model routes the presets surface resolves org-driven (the
    // code literals remain the fallback).
    workerAgentOptions?: { provider?: string; model?: string; reasoningEffort?: 'max' | 'high' | 'medium' | 'low' }
    hostAgentOptions?: { provider?: string; model?: string; reasoningEffort?: 'max' | 'high' | 'medium' | 'low' }
  }
  parallel?: ParallelConfig
  health?: HealthConfig
  quality?: { workerInspectProbability?: number }
}

/** Mirror of src/agents.ts DeptWhoState (the C1/C3 aggregate state union). */
export type DeptWhoState = 'running' | 'idle' | 'sleeping' | 'offline'

// LANE 0.2.2 (gap 2) — the same dsh-llm MessageSourceMap augmentation the
// bundle declares at src/invoke.ts:638-660 (the deepartments bus `agent/send`
// source must be part of the union for the delivery factory's
// createUserMessage/jsonSafeMessageSource payloads to type-check). Moved
// VERBATIM with the delivery factory.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Agent→agent bus delivery (send_message, spec 003 §4.3). The GUI renders
     * non-`user` sources as collapsed context rows with label = kind and never
     * renders `to[]`, so sender + recipients MUST be framed in the text. */
    agent: AgentMessageSource
  }
}

/** Message source for a bus deliver (send_message) — the deepartments analogue
 * of the harness's `coordinator/relay` source, merge-extensible like the board
 * source above. `form: 'send'` labels the row; `summary` is the human-visible
 * one-liner chrome. */
export interface AgentMessageSource {
  kind: 'agent'
  form: 'send'
  plugin: 'deepartments'
  summary: string
  to?: string[]
  messageId?: string
  from?: string
  senderSessionId?: import('@deepseek-ai/dsh-session').SessionId
}