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
  /**
   * E2 — OPTIONAL one-line description of WHAT the department does (used by the
   * wake-pack `## Departments directory` section + its SKILL.md mirror: how any
   * agent knows each department's purpose). Absent/empty → the department
   * contributes NO directory line (a legacy config without the new fields
   * composes untouched and the pack omits the section, R6).
   */
  purpose?: string
  /**
   * E2 — OPTIONAL how-to-request line for the department's services (the
   * RESEARCH/PROGRAMMING/QUALITY REQUEST format + the send_message target head).
   * Used by the wake-pack `## Departments directory` section + its SKILL.md
   * mirror. Absent/empty → no directory line (R6).
   */
  services?: string
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
  /** LANE 2 (fb-27, QD ALTO/mejora) — when explicitly false, a FRESH turn/end
   * error in a live post's session log is NOT notified to the post's OWN head
   * (no head turn-error notification; INDEPENDENT of `turnErrorCaptureEnabled` —
   * the head is alarmed even when the capture into post-errors.jsonl is off).
   * Absent → enabled (default true). */
  turnEndErrorNotifyEnabled?: boolean
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
  /** DISPATCH-HARDENING (QH «429-primer-call», 2026-08-28) — the DISPATCH
   * pre-check gate (default ON; an explicit `false` restores the
   * pre-check-less dispatch). When ON, the worker/head dispatch seams
   * (dept_worker_spawn / dept_job_run / dept_post_create / the bus-wake
   * materialization) reject LOUDLY and EARLY when the pooler snapshot
   * certifies that NO workspace can serve the spawn's first call (zero usable
   * keys, every usable key at/above `highPercent`, or a last 429 usage-limit
   * rotation to no key). Reads the SAME `<DSH_HOME>/keyPooler-state.json`
   * SOLO-LECTURA; absent/stale → passthrough (the pre-check is a warning,
   * never a blocker — unknown ≠ exhausted). */
  poolerDispatchEnabled?: boolean
  /** HARDENING-401 (fb-39, 2026-09-01) — the CAPACITY GATE monitor gate
   * (default ON; an explicit `false` restores the gate-less daemon). When ON,
   * the system-health daemon's capacity-gate TRANSITION monitor pauses new
   * host→dept dispatches the moment the pool reaches capacity CRÍTICO (the
   * billing/credits class — 401 CreditsError / Insufficient balance — or the
   * CERTAIN usable=0 / 429-rotation prelude) and resumes on recovery — the
   * «pausa de nuevos despachos» mirror of the franja PEAK pause, with a
   * durable notice on every state flip (never silent; 0 change with a healthy
   * pool — the verdict stays OK, no notice). */
  poolerGateEnabled?: boolean
  /** M1 (spec 09-04, owner 2026-09-04 — «warning si solo una key; bien si
   * ≥2») — ≤ this many USABLE keys (the pooler's own eligibility:
   * !invalid && blockedUntil<=now && cooldownUntil<=now) → a
   * `pooler-capacity:warning` finding (default 1). The count NEVER produces
   * critical anymore — the 0-usable outage is a FIXED exception (no knob). */
  warningUsableKeys?: number
  /** M1 (spec 09-04) — ≥ this many USABLE keys → the count grades OK (default
   * 2, «bien si ≥2»). A host may widen the warning band by raising this. */
  okUsableKeys?: number
  /** M1 (spec 09-04) — the GLOBAL quota: the pool AGGREGATE weekly remaining
   * percent below this → `pooler-capacity:critical` (default 20, «quede <20%
   * global»). Remaining = 100 − mean(usageWeekly.percent over ALL the USABLE
   * keys); computed only when every usable key carries weekly data (a partial
   * view is UNKNOWN, never critical). */
  criticalGlobalRemainingPercent?: number
  /** M1 (spec 09-04) — the WEEKLY quota on the LAST usable key: its weekly
   * remaining below this → `pooler-capacity:critical` (default 10, «quede
   * <10% semanal de la última key»). Remaining = 100 − usageWeekly.percent. */
  criticalWeeklyRemainingPercent?: number
  /** M1 — ≥ this many currently blocked/cooldown keys → a
   * `pooler-capacity:warning` finding (default 3). */
  blockedKeysInWindow?: number
  /** DISPATCH pre-check criterion (unchanged — the M1 scan's old daily-hot
   * WARNING is RETIRED by spec 09-04): a usable key whose upstream usage
   * percent is ≥ this → the pre-check blocks when EVERY usable key is at/above
   * it (default 90 — the pooler's own highPercent). */
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
  /** M4 — the system-idle watchdog gate (default ON; explicit `false` disables
   * the global-quiet scan). Absent → on (code default). */
  systemIdleEnabled?: boolean
  /** M4 — the GLOBAL-quiet window in ms (default 900000 = 15 min): zero
   * catalog agents running while SOME post still has pending work →
   * `system-idle` finding + host ALERT. Absent/invalid → the code default. */
  idleWindowMs?: number
  /** M-A — the context-threshold watchdog gate (default ON; explicit `false`
   * disables the context-pressure monitor). Absent → on. */
  contextThresholdEnabled?: boolean
  /** M-A — the window-usage fraction that alerts (default 0.5 = 50%): a post
   * or the host using more than this of its context window →
   * `context-threshold` finding + host ALERT. In (0,1); absent/invalid → 0.5. */
  contextThreshold?: number
  /** M-A — the context-threshold scan cadence in ms (default 60000 = 1 min).
   * Absent/invalid → the code default. */
  contextThresholdPollMs?: number
  /** M-A — the completion RESERVE (fb-50, 2026-09-02): the model's max OUTPUT
   * tokens (e.g. 262144 for deepseek-v4-flash) added to the projected numerator
   * so the monitor does not under-report pressure under completion projection.
   * Absent/invalid → 0 = LEGACY (projected/window, byte-identical). */
  contextCompletionReserve?: number
  /** M-5 — the MISSION-STALLED watchdog gate (default ON; explicit `false`
   * disables the delivered-but-unstarted-mission scan). Absent → on. */
  missionStallEnabled?: boolean
  /** M-5 — the mission-stall window in ms (default 600000 = 10 min): a HEAD
   * post with a host→head mission DELIVERY at least this old and NO
   * turn/session write after the delivery ts → `mission-stalled` finding +
   * host ALERT («misión entregada a un head pero NO INICIADA» — the owner's
   * gap). Absent/invalid → the code default. */
  missionStallMs?: number
  /** M-6 — the MAIN-RED watchdog gate (default ON; explicit `false` disables
   * the post-commit re-verification scan). Absent → on. */
  mainRedEnabled?: boolean
  /** M-6 — the main-red HEAD POLL cadence in ms (default 300000 = 5 min): a
   * NEW commit at the dev repo HEAD is detected within minutes — the FASE 4
   * lane-1 promise. Absent/invalid → the code default. */
  mainRedPollMs?: number
  /** M-6 — the FAST locks the post-commit re-verification runs (repo-relative
   * paths). Absent → the 8-lock default (boot-factory + the 4 orchestration
   * factories + the surface locks). An explicit non-empty array overrides. */
  mainRedLocks?: string[]
  /** M-6 — the repo root whose git HEAD the watchdog reads (default: the
   * bundled REPO_ROOT — the dev repo the host commits; override for a packaged
   * deployment where the repo lives elsewhere, and for the SMOKE fixture).
   * Absent → REPO_ROOT. */
  mainRedRepoRoot?: string
  /** M-7 — the MISSION-QUEUE watchdog gate (default ON; explicit `false`
   * disables the head mission-backlog scan). Absent → on. */
  missionQueueEnabled?: boolean
  /** M-7 — the pendingCount THRESHOLD (default 5): a non-retired HEAD post
   * whose PENDING (undrained) addressed messages — the buildPostSnapshot
   * pendingCount — are >= this count → `mission-queue` finding + host ALERT
   * («cola de misiones <postId>: <n> pendientes sin drenar — posible
   * backlog»). Absent/invalid → the 5 code default. */
  missionQueueLimit?: number
  /** M-7 — the anti-transient PERSISTENCE window in ms (default 60000 = one
   * poll tick at the default 60 s interval): the over-limit queue must HOLD
   * for >= this long before it alerts (a transient spike never does).
   * Absent/invalid → the 60000 code default. */
  missionQueuePersistMs?: number
  /** fb-30 — the BOOT CATCH-UP gate (default ON; explicit `false` disables the
   * boot catch-up pass — the daemon boot never re-scans the old durable
   * windows). Runs ONLY on the FIRST tick of a NEW daemon process. Absent → on. */
  catchupEnabled?: boolean
  /** fb-30 — the bounded BOOT catch-up look-back window in ms (default
   * 86400000 = 24 h): durable post-error / delivery-failed rows OLDER than the
   * live 2 h anomaly window but within this look-back are caught up ONCE at
   * boot (their own CATCH-UP frame); rows beyond the look-back stay silent by
   * design. Absent/invalid → the 24 h code default. */
  catchupWindowMs?: number
  /** LANE 5 (fb-46, QUALITY REQUEST QH 2026-09-01) — the work-register-idle
   * watchdog gate (default ON; explicit `false` disables the docs-level
   * WORK-REGISTER stall scan). The WORK-REGISTER is the org's SINGLE pending
   * queue; the watchdog alerts the host (never dispatches) when franja VALLE ∧
   * the register holds NON-gated pending items ∧ 0 agents running ∧ quiet ≥
   * `workRegisterIdleQuietMs`. Absent → on. */
  workRegisterIdleEnabled?: boolean
  /** LANE 5 (fb-46) — the WORK-REGISTER-idle VALLE-quiet window in ms (default
   * 900000 = 15 min): the stall condition must hold for >= this long before
   * the `work-register-idle` finding + host ALERT (own ledger
   * work-register-idle-state.json firstQuietTs — the M4 sustained-condition
   * precedent). Absent/invalid → the 15-min code default. */
  workRegisterIdleQuietMs?: number
  /** LANE 5 (fb-46) — the absolute path of the WORK-REGISTER (docs/WORK-REGISTER.md)
   * the work-register-idle watchdog READS (SOLO-LECTURA — IPD/host own every
   * write); absent → the repo default. Override for a packaged deployment or a
   * hermetic/smoke fixture (the poolerStateFilePath pattern). */
  workRegisterPath?: string
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
 * B5-GHOST (dispatch-hardening, QH «429-primer-call» AFTER-half, 2026-08-28) —
 * the live-post-without-usable-session reconcile knobs. Optional; defaults are
 * CODE-level (enabled true, warnAfterTicks 2, retireAfterTicks 8 — CONSERVATIVE:
 * the FIRST observation of a sessionless live post NEVER auto-retires; a
 * `ghost-suspect` MARKER appears only after `warnAfterTicks` CONSECUTIVE boot
 * censuses without a usable session, and the auto-retire fires only once the
 * marker PERSISTS > `retireAfterTicks` more censuses). An ABSENT section (or
 * absent key) falls through to the code defaults — the `health`/`quality`
 * compose-untouched contract. An explicit `enabled: false` disables the pass.
 * A post whose session becomes usable again at any census is CLEARED (an
 * intermittent session never accumulates) — zero false positives by design.
 */
export interface GhostSuspectConfig {
  /** When explicitly false, the boot ghost-suspect census pass does NOT run
   * (a sessionless live post is left alone — the pre-b5-ghost behavior).
   * Absent → enabled (default true). */
  enabled?: boolean
  /** N = the marker threshold: consecutive census misses BEFORE the
   * `ghost-suspect` marker appears (default 2 — a single miss is never a
   * marker: the first observation could be a between-materializations
   * transient). Must be a positive number; invalid/absent → 2. */
  warnAfterTicks?: number
  /** M = the retire threshold: how MANY MORE consecutive misses (beyond the
   * marker) before the auto-retire — the marker must PERSIST > M ticks
   * (default 8 — conservative: a ghost lingers as a WARN for 8+ census ticks
   * first). Must be a positive number; invalid/absent → 8. */
  retireAfterTicks?: number
}

/**
 * fb-78 A1 — the F3-stale residue knob (`org.retiredResidue`, owner decision
 * 2026-09-03): the boot retired-worker-residue pass additionally archives
 * top-level /ungrouped durable sessions with NO post and NO live host once
 * they are STALE (age >= minAgeMs). Optional; defaults are CODE-level (enabled
 * true — the owner decision "todas las /ungrouped sin post son archivables" —
 * and minAgeMs 48h). An ABSENT section (or absent key) falls through to the
 * code defaults (the health/quality compose-untouched contract); an explicit
 * `enabled: false` restores the pre-fb-78 behavior (F3-stale out — the
 * researcher-2 class stays visible). Mirrors the dshd-orchestration
 * RetiredResidueConfig.
 */
export interface RetiredResidueConfig {
  /** When explicitly false, the F3-stale phase of the boot residue pass does
   * NOT run (a no-post stale session is left visible). Absent → enabled
   * (default true — the owner decision). */
  enabled?: boolean
  /** The minimum session age (ms) before a no-post/no-host/no-live session is
   * archived. Default 48h (172800000). A session whose age cannot be
   * determined is conservatively NOT archived. */
  minAgeMs?: number
}

/**
 * fb-78 A2 — the offline-worker reap knob (`org.offlineReap`, owner decision
 * 2026-09-03): the boot census that reaps NON-retired workers whose session
 * has NO live handle and NO sleepEpoch for a wall-clock window (the fb-56
 * orphaned class — durable session present, daemon-killed mid-mission).
 * Optional; defaults are CODE-level (enabled FALSE — conservative, m-228
 * respected — and maxOfflineMs 72h). An ABSENT section (or absent key) falls
 * through to the code defaults (the reap does NOT run); an explicit
 * `enabled: true` opts into the reap. Mirrors the dshd-orchestration
 * OfflineReapConfig.
 */
export interface OfflineReapConfig {
  /** When explicitly true the boot offline-reap census runs. Absent → OFF
    * (the m-228 conservative default). */
  enabled?: boolean
  /** How long (ms) a worker must be continuously offline (no live handle, no
   * sleepEpoch) before it becomes a retire candidate. Default 72h
   * (259200000). */
  maxOfflineMs?: number
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

/**
 * PACING (owner m-PACING, 2026-08-28 — pacing/coste, MEDIUM): the peak/valley
 * FRANJA monitor config. The org lives in BURST mode around the owner's
 * off-peak/peak pricing boundary; the goal is a GATE that reduces 429s and
 * cost (NEW host→department dispatches pause inside the peak). The PURE UTC
 * formula lives in dshd-core src/pacing.ts and MIRRORS the dsh-key-pooler
 * peak definition (SEPARATE repository, crossed by comment BOTH ways):
 * PEAK ⇔ weekday(UTC) ∈ Mon-Fri ∧ UTC hour ∈ {1,2,3,6,7,8,9}, with an edge
 * buffer (default 30 min) on BOTH boundaries (request start/finish bias).
 * Optional; defaults are CODE-LEVEL (`enabled` true, `weekday` [1..5],
 * `hours` {1,2,3,6,7,8,9}, `peakBufferMs` 1800000). An ABSENT section (or an
 * absent key) keeps the code defaults so the config composes untouched (the
 * health/quality section contract); an explicit `enabled:false` restores the
 * pre-pacing behavior (no franja section in the wake pack, no transition
 * notices to the host). UPCOMING CHANGES (documented): any retune of the
 * windows MUST be mirrored in dsh-key-pooler (`fallback.peakWindows` /
 * `peakBufferMs`) — the two repos declare the SAME boundary and must stay in
 * sync (the hourly model here is mathematically equivalent to the pooler's
 * day-ranges: {1,2,3,6,7,8,9} ≡ 01:00-04:00 ∪ 06:00-10:00 with the same
 * buffer).
 */
export interface PacingWindowHoursConfig {
  /** Weekdays in peak, 1=Monday .. 7=Sunday (UTC). Default [1,2,3,4,5]. */
  weekday?: number[]
  /** UTC hours in peak. Default [1,2,3,6,7,8,9]. */
  hours?: number[]
}

/** PACING — the `org.pacing.*` runtime shape (see the PacingWindowHoursConfig
 * comment): `enabled` + the peak window (weekdays × hours) + the edge buffer.
 * Mirrored structurally in dshd-core (PacingConfigLike — the wake-pack
 * assembly + the system-health daemon read it from the shared config source),
 * so the schema and the runtime shape always agree. */
export interface PacingConfig {
  /** When explicitly false the franja monitor is OFF — no `## Pacing (franja)`
   * section in the wake pack and NO transition notices to the host (the
   * pre-pacing / R6-legacy behavior). Absent → enabled (default true). */
  enabled?: boolean
  /** The peak window: weekdays × hours (UTC). Absent → the code defaults
   * ([1..5] × {1,2,3,6,7,8,9}). */
  peakWindows?: PacingWindowHoursConfig
  /** Edge buffer (ms) around BOTH window boundaries (request start/finish
   * bias). Default 1800000 = 30 min (the dsh-key-pooler peakBufferMs default).
   * Must be a non-negative number; invalid/absent → the code default. */
  peakBufferMs?: number
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
    /**
     * B5-GHOST (dispatch-hardening) — the live-post-without-usable-session
     * reconcile knobs (warnAfterTicks/retireAfterTicks/enabled). Optional;
     * defaults are CODE-level (enabled true, 2/8 — conservative). Mirrors the
     * postsRetention compose-untouched contract.
     */
    ghostSuspect?: GhostSuspectConfig
    /**
     * fb-78 A1 — the F3-stale residue knob (enabled/minAgeMs). Optional;
     * defaults are CODE-level (enabled true — the owner decision "todas las
     * /ungrouped sin post son archivables" — minAgeMs 48h). Mirrors the
     * health/quality compose-untouched contract.
     */
    retiredResidue?: RetiredResidueConfig
    /**
     * fb-78 A2 — the offline-worker reap knob (enabled/maxOfflineMs).
     * Optional; defaults are CODE-level (enabled FALSE — conservative, m-228
     * respected — maxOfflineMs 72h). Mirrors the compose-untouched contract.
     */
    offlineReap?: OfflineReapConfig
    /**
     * PACING (owner m-PACING, 2026-08-28) — the peak/valley FRANJA monitor
     * (see PacingConfig). Optional; defaults are CODE-LEVEL (enabled true,
     * weekday [1..5], hours {1,2,3,6,7,8,9} UTC, peakBufferMs 1800000) — an
     * ABSENT section or absent key composes untouched, exactly the
     * health/quality contract.
     */
    pacing?: PacingConfig
    /**
     * R4 (providers → org config, LANE 0.2.3) — the DEFAULT WORKER model route:
     * the AgentOptions EVERY materialized department worker uses when the
     * department does not override it (a future `departments[].workerAgentOptions`
     * for the dshd-<dept> owner). Shape IDENTICAL to `coordinator.agentOptions`
     * ({provider, model, reasoningEffort?}). Optional — ABSENT → the code
     * literals (WORKER_AGENT_OPTIONS in dshd-orchestration presets.ts:
     * opencode-zen / deepseek-v4-flash / max) remain the fallback. The presets
     * surface resolves it ORG-DRIVEN (single source declared here; movement-only
     * for consumers — spawn/tools/delivery keep reading the same constants).
     */
    workerAgentOptions?: { provider?: string; model?: string; reasoningEffort?: 'max' | 'high' | 'medium' | 'low' }
    /**
     * R4 (providers → org config, LANE 0.2.3) — the DEFAULT HOST model route
     * (the D4 dormant-host resume AgentOptions, delivery.ts:989). Same shape as
     * the worker route. Optional — ABSENT → the code literals (HOST_AGENT_OPTIONS
     * in presets.ts: opencode-zen / deepseek-v4-flash / max — the RUNTIME TRUTH:
     * the dev dump-config runs the host on flash via agent-default-model; the
     * pre-R4 vision-exp literal was stale, the runtime never used it).
     */
    hostAgentOptions?: { provider?: string; model?: string; reasoningEffort?: 'max' | 'high' | 'medium' | 'low' }
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
      // E2 — optional department directory info (wake-pack `## Departments
      // directory` section + skill mirror). `default('')` like the F1 fields:
      // a legacy config without them composes untouched (R6) and the pack
      // omits the section.
      purpose: z.string().default(''),
      services: z.string().default(''),
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
    }).default(void 0 as unknown as { maxRetiredKept: number; archiveFile: string; enabled: boolean }),
    // B5-GHOST (dispatch-hardening, QH 2026-08-28) — mirrors Config.org.
    // ghostSuspect. `default(void 0)` so an ABSENT section or absent key falls
    // through to the CODE defaults (enabled true, warnAfterTicks 2,
    // retireAfterTicks 8 — conservative) — exactly the health/quality
    // section's contract; an explicit `{ enabled: false }` disables the pass.
    ghostSuspect: z.object({
      enabled: z.boolean(),
      warnAfterTicks: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
      retireAfterTicks: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
    }).default(void 0 as unknown as { enabled: boolean; warnAfterTicks: number; retireAfterTicks: number }),
    // fb-78 A1 — mirrors Config.org.retiredResidue. `default(void 0)` so an
    // ABSENT section or absent key falls through to the CODE defaults (enabled
    // true — the owner decision "todas las /ungrouped sin post son
    // archivables" — minAgeMs 48h); an explicit `{ enabled: false }` disables
    // the F3-stale phase of the residue pass.
    retiredResidue: z.object({
      enabled: z.boolean(),
      minAgeMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER)
    }).default(void 0 as unknown as { enabled: boolean; minAgeMs: number }),
    // fb-78 A2 — mirrors Config.org.offlineReap. `default(void 0)` so an
    // ABSENT section or absent key falls through to the CODE defaults (enabled
    // FALSE — conservative, m-228 respected — maxOfflineMs 72h); the reap
    // runs only with an explicit `enabled: true`.
    offlineReap: z.object({
      enabled: z.boolean(),
      maxOfflineMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER)
    }).default(void 0 as unknown as { enabled: boolean; maxOfflineMs: number }),
    // R3 — the bundle-layer patch staleness watchdog mirror of Config.org.
    // bundlePatchCheck / bundlePatchCheckIntervalMs (OrgConfig,
    // packages/dshd-core/src/index.ts:189-192). `default(void 0)` → an ABSENT
    // key falls to the CODE defaults (check ON, interval 60 s), like
    // offlineReap/postsRetention; an explicit `false` opts out.
    bundlePatchCheck: z.boolean().default(void 0 as never),
    bundlePatchCheckIntervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(void 0 as never),
    // PACING (owner m-PACING, 2026-08-28) — mirrors Config.org.pacing.
    // `default(void 0)` so an ABSENT section or absent key falls through to the
    // CODE defaults (enabled true, weekday [1..5], hours {1,2,3,6,7,8,9} UTC,
    // peakBufferMs 1800000 = 30 min) — exactly the health/quality section's
    // contract; an explicit `{ enabled: false }` still disables the pacing.
    // The nested peakWindows/peakBufferMs get `default(void 0)` TOO so an
    // absent sub-key stays ABSENT (a `pacing: { enabled: false }` config
    // normalizes to exactly `{ enabled: false }` — the health/quality shape).
    pacing: z.object({
      enabled: z.boolean(),
      peakWindows: z.object({
        weekday: z.array(z.number().step(1).min(1).max(7)),
        hours: z.array(z.number().step(1).min(0).max(23))
      }).default(void 0 as unknown as { weekday: number[]; hours: number[] }),
      peakBufferMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(void 0 as never)
    }).default(void 0 as unknown as {
      enabled: boolean
      peakWindows: { weekday: number[]; hours: number[] }
      peakBufferMs: number
    }),
    // R4 (providers → org config, LANE 0.2.3) — mirrors Config.org.
    // workerAgentOptions / hostAgentOptions (the {provider, model,
    // reasoningEffort?} route shape, identical to coordinator.agentOptions).
    // `default(void 0)` so an ABSENT key falls through to the CODE defaults
    // (opencode-zen / deepseek-v4-flash / reasoningEffort max for both — the
    // runtime-verified host route, LANE 0.2.3 alignment) — the
    // compose-untouched contract of every org section.
    workerAgentOptions: z.object({
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.union([z.const('max'), z.const('high'), z.const('medium'), z.const('low')])
    }).default(void 0 as unknown as { provider: string; model: string; reasoningEffort: 'max' | 'high' | 'medium' | 'low' }),
    hostAgentOptions: z.object({
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.union([z.const('max'), z.const('high'), z.const('medium'), z.const('low')])
    }).default(void 0 as unknown as { provider: string; model: string; reasoningEffort: 'max' | 'high' | 'medium' | 'low' })
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
    // LANE 2 (fb-27) — the turn-end head-notify gate (default(void 0) → absent =
    // code default-on, the same section contract).
    turnEndErrorNotifyEnabled: z.boolean(),
    staleLiveWatchdogEnabled: z.boolean(),
    staleLiveMinutes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    presetAuditEnabled: z.boolean(),
    heartbeatEnabled: z.boolean(),
    waitThresholdMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    // M1 — the pooler-capacity + qi-silence watchdog knobs (all `default(void 0)`
    // → absent = code defaults, the existing health-section contract). Spec
    // 09-04 (owner 2026-09-04): the THREE-CLASS grading knobs — warning ≤
    // warningUsableKeys (1), ok ≥ okUsableKeys (2), critical ONLY by quota
    // (criticalGlobalRemainingPercent 20 / criticalWeeklyRemainingPercent 10)
    // + the fixed 0-usable outage exception. `criticalUsableKeys` is RETIRED
    // (the count no longer produces critical; an old config value is stripped
    // by the schema — unknown keys are never validated).
    poolerCapacityEnabled: z.boolean(),
    poolerDispatchEnabled: z.boolean(),
    poolerGateEnabled: z.boolean(),
    warningUsableKeys: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
    okUsableKeys: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
    criticalGlobalRemainingPercent: z.number().min(0).max(100),
    criticalWeeklyRemainingPercent: z.number().min(0).max(100),
    blockedKeysInWindow: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
    highPercent: z.number().min(0).max(100),
    stateStaleMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    poolerStateFilePath: z.string(),
    qiSilenceEnabled: z.boolean(),
    qiSilenceWindowMinutes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    qiSilenceMinRetiresInWindow: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    // M4 — the system-idle watchdog knobs (default(void 0) → absent = code
    // defaults: enabled on, idleWindowMs 900000 = 15 min — the section contract).
    systemIdleEnabled: z.boolean(),
    idleWindowMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    // M-A — the context-threshold watchdog knobs (default(void 0) → absent =
    // code defaults: enabled on, threshold 0.5 = 50%, poll 60000 = 1 min — the
    // section contract; the fraction is validated in (0,1) like highPercent).
    contextThresholdEnabled: z.boolean(),
    contextThreshold: z.number().min(0).max(1),
    contextThresholdPollMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    // M-A fb-50 — the completion-reserve knob (default(void 0) → absent = code
    // default 0 = LEGACY projected-only numerator; a finite non-negative wins).
    contextCompletionReserve: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
    // M-5 — the mission-stalled watchdog knobs (default(void 0) → absent =
    // code defaults: enabled on, missionStallMs 600000 = 10 min — the section
    // contract).
    missionStallEnabled: z.boolean(),
    missionStallMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    // M-6 — the main-red watchdog knobs (default(void 0) → absent = code
    // defaults: enabled on, mainRedPollMs 300000 = 5 min, mainRedLocks the
    // 8-lock default, mainRedRepoRoot REPO_ROOT — the section contract).
    mainRedEnabled: z.boolean(),
    mainRedPollMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    mainRedLocks: z.array(z.string()).default(void 0 as never),
    mainRedRepoRoot: z.string().default(void 0 as never),
    // M-7 — the mission-queue watchdog knobs (default(void 0) → absent = code
    // defaults: enabled on, missionQueueLimit 5, missionQueuePersistMs 60000
    // = one poll tick — the section contract).
    missionQueueEnabled: z.boolean(),
    missionQueueLimit: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    missionQueuePersistMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    // fb-30 — the BOOT CATCH-UP knobs (default(void 0) → absent = code
    // defaults: enabled on, catchupWindowMs 86400000 = 24 h — the section
    // contract).
    catchupEnabled: z.boolean(),
    catchupWindowMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    // LANE 5 (fb-46) — the work-register-idle watchdog knobs (default(void 0)
    // → absent = code defaults: enabled on, workRegisterIdleQuietMs 900000 =
    // 15 min — the section contract).
    workRegisterIdleEnabled: z.boolean(),
    workRegisterIdleQuietMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    // LANE 5 (fb-46) — the WORK-REGISTER path override (default(void 0) →
    // absent = the repo default docs/WORK-REGISTER.md).
    workRegisterPath: z.string().default(void 0 as never)
  }).default(void 0 as unknown as {
    enabled: boolean
    intervalMs: number
    turnErrorCaptureEnabled: boolean
    turnEndErrorNotifyEnabled: boolean
    staleLiveWatchdogEnabled: boolean
    staleLiveMinutes: number
    presetAuditEnabled: boolean
    heartbeatEnabled: boolean
    waitThresholdMs: number
    poolerCapacityEnabled: boolean
    poolerDispatchEnabled: boolean
    poolerGateEnabled: boolean
    warningUsableKeys: number
    okUsableKeys: number
    criticalGlobalRemainingPercent: number
    criticalWeeklyRemainingPercent: number
    blockedKeysInWindow: number
    highPercent: number
    stateStaleMs: number
    poolerStateFilePath: string
    qiSilenceEnabled: boolean
    qiSilenceWindowMinutes: number
    qiSilenceMinRetiresInWindow: number
    systemIdleEnabled: boolean
    idleWindowMs: number
    contextThresholdEnabled: boolean
    contextThreshold: number
    contextThresholdPollMs: number
    contextCompletionReserve: number
    missionStallEnabled: boolean
    missionStallMs: number
    mainRedEnabled: boolean
    mainRedPollMs: number
    mainRedLocks: string[]
    mainRedRepoRoot: string
    missionQueueEnabled: boolean
    missionQueueLimit: number
    missionQueuePersistMs: number
    catchupEnabled: boolean
    catchupWindowMs: number
    workRegisterIdleEnabled: boolean
    workRegisterIdleQuietMs: number
    workRegisterPath: string
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
