// dsh-deepartments — agent messaging (spec 003): the host Asistente talks to
// department heads (posts), workers and transient children through the
// direct agent→agent BUS (send_message/agent_messages/dept_who) — NO board
// rooms, NO wake relay (Batch B3 cutover: the board is gone; the bus is the
// only delivery path, spec 003 §7.1). dept_invoke, the fork machinery and all
// board/room pieces are retired (Batch A / Batch B3).
//
// Batch 1a pivots department HEADS from CONTINUABLE SUBAGENTS to FIRST-CLASS
// ROOT AGENTS (per explore-deep/2026-08-20-main-agent-own-head.md and
// ...-permanent-agents-lifecycle.md, owner decision 2026-08-20). A configured
// coordinator is materialized as its OWN main agent via
// `ctx.agents.create`/`resume` from the plugin's ROOT service context (so it
// lands in agents.roots(), with no origin === 'subagent', and the GUI/sidebar
// renders it as a main-agent row exactly like "Assistant"):
//   - stable session id `SessionId(\`head-<postId>\`)`, `meta: { cwd: <workspace
//     root path — resolveWorkspaceRootPath>, origin: undefined,
//     agentPreset: 'deepartments-head' }`, `agentOptions`
//     from the coordinator config, and a `setup(agentCtx)` that mounts the
//     dedicated `deepartments-head` preset AND registers the head's `dept_*`
//     tools (send_message, agent_messages, dept_who, dept_memo_write,
//     dept_sleep) scoped to that agent — no host/builder/delegation tools.
//   - Wake = raw `Agent.followup(createUserMessage(...))` (the SAME simpler
//     wake the host branch has always used). This REMOVES the rc.6 "parent
//     must be live" limitation: a head is woken directly by its own agent id.
//   - Sleep/respawn = `dept_sleep` writes the journal then marks the registry
//     (`sleepEpoch`), DISPOSES the head's AgentHandle, and (F8, spec 002 head
//     rotation) ARCHIVES the head's durable session server-side. The next wake
//     RECREATES the head FRESH (mints a NEW session id — the archive old one is
//     never resumed) and follows up with the pointer-only message delta. A
//     disposable WORKER keeps the legacy cold-resume of the SAME durable
//     session. The durable session survives `dispose()` (dispose tears the LIVE
//     agent+session out of the in-memory registry, not the sessionPersistence
//     backend — rc.8 dsh-agent-loop prepare() dispose at index.js:1132-1152
//     detaches `agents.enter`/`sessions.enter` registrations only).
//
// Mechanics (per .dsh/reports/explore-deep/2026-08-19-host-board-channel.md,
// ...-lateral-assistant-addressing.md, ...-minimal-context-resident-posts.md):
//   - The host channel IS the global tool layer: `ctx.tools.register` on the
//     plugin's main-timeline ctx registers into the GLOBAL layer
//     (dsh-tools ScopedLayers.effect — unscoped ctx → global), visible to the
//     host Asistente AND every agent. We register the bus tools
//     (send_message/agent_messages/dept_who) GLOBALLY so the host can read and
//     write the bus. Heads get their OWN scoped copies instead: `setup()`
//     registers the same tool bodies on the head's `agentCtx` (a scope's OWN
//     layer always survives, so no `toolFilter` is needed for a root agent).
//   - Hosts get a first-class, durable identity in `hosts.json`:
//     `host-<sessionId>` → { hostId, sessionId, roomId }. Registered LAZILY on
//     the host's first bus-tool call (ensureHost — dept_who/send_message
//     self-register via the B3 gap fix; the board tools that used to trigger it
//     are gone). we never fabricate a host session at boot. Heads are
//     registered in `posts.json`, keyed by postId → { sessionId, roomId,
//     agentPreset, sleepEpoch?, previousChildId? } — the durable recipient
//     catalog. `roomId` survives as an INERT registry field (hosts.json/
//     posts.json schema stability, session-rotation.ts reads it): no board
//     tool takes or derives a room anymore.
//   - Delivery is the BUS (spec 003 §4.3-4.4): send_message persists to
//     messages.jsonl and delivers per recipient via the wakePost seam
//     (materializePost — always-wake incl. stuck-head recovery, serialized,
//     self held).
//
// NO export default (pitfall 0001 — breaks `inject`).
import { mkdir, readFile, writeFile, readdir, copyFile, stat, rename, unlink, appendFile, realpath } from 'node:fs/promises'
// F10 (spec 004 §9.1): the department-architecture prompt section reads the
// department's ARCHITECTURE.md SYNCHRONOUSLY — the post setup path is
// synchronous (a root agent's systemPrompt sections are composed at
// materialization, before the agent can be awaited; there is no await seam).
// readFileSync keeps that contract; ENOENT = the department has no
// architecture (omit the section, never an error).
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCb, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { findSessionArtifact, runSleepCleanup, type SleepCleanupReport } from './core/session-cleanup.js'
// POST-INCIDENTE 2026-09-04 (crash-loop 609 restarts / exit 7): the ONE shared
// dual session-log read (getSessionEvents) + the surface detector
// (detectSessionSurface — the heartbeat `{ts, bootId, surface}` drift gate).
import { getSessionEvents, detectSessionSurface } from './core/session-surface.js'
import type { SessionLogLike } from './core/session-surface.js'

/** Module-level promisified execFile (dept_exec's runDeptExec/runDeptZstdRead
 * use it; the apply-scope `execFileP` below is the same binding for legacy
 * code). */
const execFileP = promisify(execFileCb)

/** INVARIANTE DE TICKS (post-incidente 2026-09-04, crash-loop 609 restarts /
 * exit 7): the STANDARD wrapper for the BODY of every daemon interval callback.
 * The incident class was a SYNCHRONOUS throw in the builder phase of the W6
 * health tick (invoke.ts:3457-3465 at the time — buildHealthPosts + 6 builders
 * ran OUTSIDE the internal tick's try/catch) that escaped the setInterval →
 * uncaught exception → exit 7 → 609 restarts. The invariant: the interval
 * callback is NOEXCEPT — the body's throw is logged and the daemon lives for
 * the next tick. Applies to ALL 4 daemon intervals (health / agenda scheduler /
 * parallel-monitor here; the redelivery sweep wraps inline in the tools
 * factory — the same pattern, same comment anchor). */
function wrapDaemonTick(logger: { warn(message: string): void }, label: string, fn: () => void): () => void {
  return () => {
    try {
      fn()
    } catch (error: unknown) {
      logger.warn(`[deepartments] ${label} tick failed: ${error instanceof Error ? error.message : String(error)} (wrapped — the daemon lives)`)
    }
  }
}

/** POST-INCIDENTE 2026-09-04 — read the systemd NRestarts counter for the
 * deployment unit ONCE per boot (the code-layer crash-loop breaker, decision
 * 4): read-only `systemctl show <unit> -p NRestarts` — the SAME source the
 * host used to attribute the 609-restart incident. Best-effort: an absent unit
 * name, an unavailable systemctl or a parse failure → undefined (the tick
 * omits nRestarts and the health report reads the counter host-side). Never
 * throws. The unit name is the DEEPARTMENTS_SYSTEMD_UNIT env (deployment-
 * specific — dev/stable differ). */
async function resolveSystemdNRestarts(unitName: string): Promise<number | undefined> {
  if (unitName === undefined || unitName.trim() === '') return undefined
  try {
    const { stdout } = await execFileP('systemctl', ['show', unitName, '-p', 'NRestarts'], {
      cwd: process.cwd(),
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: process.env
    })
    const match = /^NRestarts=(\d+)$/m.exec(stdout.trim())
    if (match === null) return undefined
    const n = Number(match[1])
    return Number.isFinite(n) ? n : undefined
  } catch {
    return undefined
  }
}
import { runHostRotation, ASISTENTE_SESSION_TITLE, isArchivedSession, buildHeadRotationSeed } from './core/session-rotation.js'
import type { RotationPersistenceLike, WorkspaceRegistryLike } from './core/session-rotation.js'
import { createLifecycleService, buildSleepJournalMessage, shouldClearCleanupPending } from './core/lifecycle.js'
import type { LifecycleService } from './core/lifecycle.js'
import type { Config, CoordinatorConfig, DepartmentConfig, ParallelConfig, ParallelMonitorConfig, PostsRetentionConfig } from './org.js'
import {
  MessagesStore,
  markDelivery,
  parseDeliveryRows,
  parseMessageRecords,
  loadMessageRecords,
  resolveDeliveriesPath,
  resolveMessagesPath,
  DeliveryRedeliverer,
  needsRedelivery
} from './core/messages.js'
import type { DeliveryRow, DeliveryStatus, MessageRecord, DeliveryRedelivererDeps } from './core/messages.js'
// Re-export the message-store + redelivery-guard public surface (value + type)
// so the compiled lib/invoke.js stays a drop-in superset of the pre-extraction
// module (same pattern as step (a) — the registry).
export {
  MESSAGE_FILE,
  DELIVERIES_FILE,
  resolveMessagesPath,
  resolveDeliveriesPath,
  parseMessageRecords,
  loadMessageRecords,
  appendMessageRecord,
  COMPACTION_LINE_THRESHOLD,
  COMPACTION_BYTE_THRESHOLD,
  shouldCompact,
  compactMessages,
  loadMemberIds,
  compactMessagesFile,
  MessagesStore,
  parseDeliveryRows,
  markDelivery,
  deliveryStatus,
  needsRedelivery,
  compactDeliveryRows,
  DeliveryRedeliverer
} from './core/messages.js'
export type {
  MessageKind,
  MessageRecord,
  MessageInput,
  DeliveryRow,
  DeliveryStatus,
  PageOptions,
  PageResult,
  DeliveryRedelivererDeps
} from './core/messages.js'
import { buildAgentRows, computeDeptWhoState } from './agents.js'
import type { DeptWhoState } from './agents.js'
import {
  HEAD_PRESET_BASE_ID,
  headPresetIdFor,
  headPresetNameCore,
  headPresetNameFor,
  buildHeadPresetComposition,
  buildHeadPresetMetadata
} from './head-presets.js'
import { roleForSession, buildSubagentOrientation } from './role-orient.js'
// D3 (subagent/gui/pooler phase): the `deepartments.subagentRoles` core service
// type — the dispatch-time transient-subagent role registry, promoted from the
// bundle module-global Map into dshd-core (see the wake-pack wiring below).
import type { SubagentRolesService } from './role-orient.js'
// M2.3 (own-scope secretary): the SHARED secretary factory + deployment
// contract — the ONE source of person/toolFilter/wording the head OWN-LAYER
// registration uses; the preset row's apply() consumes the SAME factory, so
// the host standing row and the head own layer can never diverge.
import { createSecretaryTool, secretaryConfig } from './subagent.js'
// M2.3: the guaranteed toolset-derivation diagnostics channel
// (`<stateDir>/toolset-audit.jsonl` — the deepartments warns never reach the
// harness stdout, the M2.2 finding).
import { appendToolsetAudit } from './toolset-audit.js'
// FASE 2 step (a): the durable registry store (hosts/posts catalog) is carved
// out of this monolith into ./core/registry.js — the SINGLE source of the
// catalog. Everything registry-related below (mintWorkerSessionId, the durable
// read/reconcile helpers, ensureHost/registerEntry/persist + the pure live-host
// pick) is imported from there and re-exported so the lib/invoke.js public
// surface stays drop-in for existing consumers (and the bus tests).
import {
  RegistryStore,
  HOST_ID_PREFIX,
  HEAD_SESSION_PREFIX,
  WORKER_SESSION_PREFIX,
  headSessionId,
  workerSessionId,
  mintWorkerSessionId,
  readDurableHostsRegistry,
  isHostRetiredOnDisk,
  readDurableRetiredHostIds,
  readDurableHostEntries,
  findRotationTerminal,
  hasRotatedToCycle,
  analyzeDurableHostRegistry,
  reconcileDurableHostRegistry,
  analyzeDurablePostsRegistry,
  reconcileDurablePostsRegistry,
  listActiveMembers,
  pickLiveHostEntry,
  GHOST_SUSPECT_STATE_FILE,
  readGhostSuspectLedger,
  writeGhostSuspectLedger,
  stepGhostSuspectCensus
} from './core/registry.js'
import type {
  PostEntry,
  HostEntry,
  HostEntryLike
} from './core/registry.js'
// Re-export the registry's public surface (value + type) so the compiled
// lib/invoke.js stays a drop-in superset of the pre-extraction module.
export {
  RegistryStore,
  HOST_ID_PREFIX,
  HEAD_SESSION_PREFIX,
  WORKER_SESSION_PREFIX,
  headSessionId,
  workerSessionId,
  mintWorkerSessionId,
  readDurableHostsRegistry,
  isHostRetiredOnDisk,
  readDurableRetiredHostIds,
  readDurableHostEntries,
  findRotationTerminal,
  hasRotatedToCycle,
  analyzeDurableHostRegistry,
  reconcileDurableHostRegistry,
  analyzeDurablePostsRegistry,
  reconcileDurablePostsRegistry,
  listActiveMembers,
  pickLiveHostEntry,
  GHOST_SUSPECT_STATE_FILE,
  readGhostSuspectLedger,
  writeGhostSuspectLedger,
  stepGhostSuspectCensus
} from './core/registry.js'
export type {
  PostEntry,
  PostEntryPersisted,
  HostEntry,
  HostEntryLike,
  PickLiveHostResult,
  DurableHostReconcileIssue,
  DurableHostRepair,
  DurableHostReconcileResult,
  DurablePostReconcileLike,
  DurablePostsReconcileResult,
  ReconcileDurableHostOpts,
  ReconcileDurablePostsOpts
} from './core/registry.js'
// FASE 2 step (c): the bus DELIVERY ENGINE + the `deliverOrQueue` gate is carved
// out of this monolith into ./core/delivery.js — the SINGLE delivery seam of the
// bus. The engine orchestrates the per-recipient delivery (write-ahead
// 'prepared' → route → final), the catalog route, the defensive ACL application,
// and the `noWake` gate; the CLOSURE-BOUND wake primitives (busDeliverToPost /
// busDeliverToHost / materializePost) stay here and are INJECTED as deps.
import {
  createDeliveryEngine
} from './core/delivery.js'
import type {
  DeliveryInterruptOptions,
  DeliverOrQueueOptions,
  BusMemberProfile,
  BusSendResult,
  DeliveryEngine,
  CatalogRoute,
  AclSurface,
  BusSurface
} from './core/delivery.js'
// dshd-feedback phase: the universal feedback store + state machine +
// record types live in the dshd-feedback package, consumed via the drop-in
// bridge (./core/feedback.js -> `export * from 'dshd-feedback'`).
import { FeedbackStore, isTerminalEstado } from './core/feedback.js'
import type {
  FeedbackEstado,
  FeedbackInput,
  FeedbackListOptions,
  FeedbackListResult,
  FeedbackRecord,
  FeedbackSeveridad,
  FeedbackTipo,
  FeedbackUpdateInput
} from './core/feedback.js'
// dshd-jobs phase: the pure agenda/jobs engine (cron + job-def reader +
// calendar/job-runs state helpers + the scheduler tick + its deps type) lives in
// the dshd-jobs package (packages/dshd-jobs/src/index.ts), consumed via the
// drop-in bridge (./core/jobs.js -> `export * from 'dshd-jobs'`). invoke.ts
// imports the helpers the bundle wires (the dept_calendar_*/dept_job_list tools +
// the agenda scheduler daemon) and RE-EXPORTS the whole surface so the compiled
// lib/invoke.js stays a drop-in superset of the pre-extraction module (the
// existing tests import these symbols from lib/invoke.js).
import {
  parseCronSchedule,
  cronMatches,
  nextCronFire,
  cronIsDue,
  CRON_DESYNC_WINDOW_MIN,
  unwrapQuotedScalar,
  parseJobDefFrontmatter,
  jobDirFor,
  readJobDefinitionFile,
  readAgendaJobs,
  readCalendarStateFile,
  writeCalendarStateFile,
  readJobRunsStateFile,
  writeJobRunsStateFile,
  runAgendaSchedulerTick,
  normalizeSchedulerAutoRunReason,
  schedulerAutoRunKey
} from './core/jobs.js'
import type { CalendarEntry, CalendarState } from './core/jobs.js'
import type { SchedulerAutoRunFinding } from './core/jobs.js'
export {
  parseCronSchedule,
  cronMatches,
  nextCronFire,
  cronIsDue,
  CRON_DESYNC_WINDOW_MIN,
  unwrapQuotedScalar,
  parseJobDefFrontmatter,
  jobDirFor,
  readJobDefinitionFile,
  readAgendaJobs,
  readCalendarStateFile,
  writeCalendarStateFile,
  readJobRunsStateFile,
  writeJobRunsStateFile,
  runAgendaSchedulerTick,
  normalizeSchedulerAutoRunReason,
  schedulerAutoRunKey
} from './core/jobs.js'
export type {
  CronSchedule,
  JobDefParsed,
  AgendaJobItem,
  CalendarEntry,
  CalendarState,
  AgendaSchedulerDeps,
  SchedulerAutoRunFinding,
  JobsDepartment
} from './core/jobs.js'
// dshd-pooler phase: the PURE provider-adapter boot-check helpers (endpoint
// drift + the boot-findings resolver + the settings.yaml reader/parser + the
// retry constants + the synthetic finding postId) live in the dshd-pooler
// package (packages/dshd-pooler/src/index.ts), consumed via the drop-in bridge
// (./core/pooler.js -> `export * from 'dshd-pooler'`). invoke.ts imports the
// helpers the boot check (runProviderAdapterBootCheck) wires and RE-EXPORTS the
// whole surface so the compiled lib/invoke.js stays a drop-in superset of the
// pre-extraction module (the existing tests import these symbols from
// lib/invoke.js). The boot check closure itself STAYS in the bundle. fb-9: the
// same reader now also resolves the reasoning surface + the
// resolveReasoningContentPreflight guard (the DISPATCH pre-flight the two
// spawn engines run BEFORE any agents.create).
import {
  PROVIDER_ADAPTER_RETRY_WINDOW_MS,
  PROVIDER_ADAPTER_RETRY_MS,
  readLlmPiAiProviderSettings,
  resolveProviderAdapterBootFindings,
  resolveReasoningContentPreflight,
  REASONING_CONTENT_PREFLIGHT_POST_ID
} from './core/pooler.js'
import type {
  ProviderAdapterBootFinding,
  ProviderAdapterBootInput,
  ProviderAdapterEndpointDriftDeps,
  LlmPiAiProviderSettings
} from './core/pooler.js'
export {
  PROVIDER_ADAPTER_CHECK_POST_ID,
  PROVIDER_ADAPTER_RETRY_WINDOW_MS,
  PROVIDER_ADAPTER_RETRY_MS,
  providerAdapterEndpointDrift,
  resolveProviderAdapterBootFindings,
  parseLlmPiAiProviderSettings,
  readLlmPiAiProviderSettings,
  resolveReasoningContentPreflight,
  REASONING_CONTENT_PREFLIGHT_POST_ID
} from './core/pooler.js'
export type {
  ProviderAdapterBootFinding,
  ProviderAdapterBootInput,
  ProviderAdapterEndpointDriftDeps,
  LlmPiAiProviderSettings
} from './core/pooler.js'
// dshd-health phase: the system-health DOMAIN (post-error capture +
// unusable-session markers, heartbeat/alerts ledger + audit, W8-i error class,
// M3 interrupt back-off + materialization quarantine, the W8-c safeguards, the
// W8-d system heartbeat, the W8-h interrupted-post reconciliation, and the C6
// delivery-row tail-reader FACTORY + scans + the PURE health daemon tick)
// live in the dshd-health package (packages/dshd-health/src/index.ts),
// consumed via the drop-in bridge (./core/health.js -> `export * from
// 'dshd-health'`). invoke.ts imports the helpers the bundle wires (the daemon
// wiring, assembleHeartbeat, the W8-h boot reconciliation, the scheduler/
// retire captures, the bus-delivery catches, the B5 markers, the preset audit)
// AND RE-EXPORTS the whole surface (`export *`) so the compiled lib/invoke.js
// stays a drop-in superset of the pre-extraction module (the existing tests
// import these symbols from lib/invoke.js). The daemon WIRING itself STAYS in
// the bundle (setInterval + the ONE per-daemon createDeliveryRowsTailReader +
// the notifyHost ALERT closure — C8).
import {
  runHealthDaemonTick,
  createDeliveryRowsTailReader,
  readInboxByPost,
  readDeliveryRowsFull,
  HEALTH_ERROR_WINDOW_MS,
  HEALTH_DEDUPE_WINDOW_MS,
  buildPostSnapshot,
  scanHostWaits,
  resolveSystemWaitMs,
  buildHeartbeatSection,
  scanInterruptedTurn,
  reconcileInterruptedPosts,
  scanTurnErrorCaptures,
  TURN_ERROR_FRESH_WINDOW_MS,
  readTurnErrorsState,
  writeTurnErrorsState,
  appendPostError,
  readPostErrorsFile,
  readHealthAlertsState,
  writeHealthAlertsState,
  safeInterrupt,
  postErrorClass,
  appendPostErrorDeduped,
  POST_ERROR_RECORD_KEY_PREFIX,
  resetHostMaterializeFailures,
  isSessionNotFoundError,
  readMaterializeState,
  markHostMaterializeFailure,
  writeMaterializeState,
  MATERIALIZE_QUARANTINE_N,
  MATERIALIZE_QUARANTINE_MS,
  readUnusableSessionsMark,
  markUnusableWorkerSession,
  clearUnusableWorkerSession,
  auditPresetText,
  appendConfigPresetMarker,
  readHealthHeartbeatFile,
  // POST-INCIDENTE 2026-09-04 — the boot-crash sidecar (the code-layer
  // crash-loop breaker): the apply-start stamp + the sync streak resolver.
  stampBootCrash,
  resolveBootCrashStreak,
  POOLER_STATE_FILE,
  resolvePoolerDispatchBlock,
  POOLER_CAPACITY_DEFAULT_HIGH_PERCENT,
  POOLER_CAPACITY_DEFAULT_STATE_STALE_MS,
  resolvePositiveKnob
} from './core/health.js'
import type {
  PostActivityInput,
  HealthSessionEvent,
  HostWaitPostInput,
  HeartbeatRow,
  InterruptedPostInput,
  PostErrorEntry,
  SessionContextInput,
  MissionActivityInput,
  MainRedRuntime,
  MainRedLockResult,
  MissionQueueInput
} from './core/health.js'
// P1 (MODULARIZACIÓN, 2026-08-29): the six plugin packages now export their
// Cordis plugin surface (name/inject/apply) from their MAIN entries (the
// dshd-core/dshd-webfetch pattern). The drop-in superset star-exports below
// (lib/invoke.js stays a drop-in superset for tests/consumers) would therefore
// collide on those THREE names — TS2308 — so they are re-exported EXPLICITLY
// here (an explicit declaration takes precedence over every star export and
// resolves the ambiguity). These exports are PLUGIN-METADATA NOISE: the bundle
// plugin identity comes from src/index.ts (name='deepartments', apply =
// applyInvoke wrapper); nothing imports name/inject/apply from lib/invoke.js
// (verified). This is a MODULE-SCOPE superset fix — applyInvoke is untouched
// (the DECOUPLING hito owns the rewire).
export { name, inject, apply } from './core/health.js'
export * from './core/health.js'
// dshd-quality phase: the QD (spec 007) probability gate + config-resolution +
// QUALITY INSPECT directive text live in the dshd-quality package
// (packages/dshd-quality/src/index.ts), consumed via the drop-in bridge
// (./core/quality.js -> `export * from 'dshd-quality'`). invoke.ts imports the
// symbols the bundle WIRES (the per-apply qualityWorkerInspectProbability
// resolution, the two gate calls inside the maybeEmitQualityInspectDirective
// emitter, the worker-retire call-site) AND RE-EXPORTS the whole surface
// (`export *`) so the compiled lib/invoke.js stays a drop-in superset of the
// pre-extraction module (the existing tests import these symbols from
// lib/invoke.js). The EMITTER itself (the store.append + busDeliverToPost of
// the directive to quality-head — the ONE directive writer in the bundle) and
// every gate call-site STAY in the bundle and call the gate via the bridge.
import {
  qualityInspectDecision,
  resolveQualityWorkerInspectProbability,
  qualityInspectDirectiveText,
  QUALITY_INSPECT_ENV_VAR
} from './core/quality.js'
import type { QualityInspectDirectiveSurface } from './core/quality.js'
export * from './core/quality.js'
// dshd-gui phase: the PURE `/deepartments` RPC channel (endpoint dispatcher +
// client-request envelope + authority/trust fence + the thin node:http route
// handler + the channel types) lives in the dshd-gui package
// (packages/dshd-gui/src/index.ts), consumed via the drop-in bridge
// (./core/gui.js -> `export * from 'dshd-gui'`). invoke.ts keeps the webServer
// MOUNT EFFECT + the endpointDeps WIRING CLOSURE (they bind the LIVE
// apply-fiber registries AND inject the bundle-owned pure deps
// buildAgentRows/pickLiveHostEntry — the agents/list + host/status branches) +
// the presence persistence helpers, and RE-EXPORTS the moved public surface so
// the compiled lib/invoke.js stays a drop-in superset of the pre-extraction
// module (the existing tests import these symbols from lib/invoke.js).
import { dispatchDeepartmentsEndpoint, handleDeepartmentsRequest } from './core/gui.js'
import type {
  DeepartmentsDispatchResult,
  DeepartmentsEndpointDeps,
  EndpointPostEntryLike,
  HostStatusPayload,
  PresenceState
} from './core/gui.js'
// The envelope/trust primitives are imported for the RE-EXPORT below only (the
// route handler that used them moved to the package); explicit here so the
// drop-in surface is declared next to the other moved-export blocks.
export {
  dispatchDeepartmentsEndpoint,
  isLoopbackHostname,
  parseAuthority,
  isTrustedAuthority,
  isTrustedHostFact,
  parseClientEnvelope,
  handleDeepartmentsRequest
} from './core/gui.js'
export type {
  DeepartmentsDispatchResult,
  DeepartmentsEndpointDeps,
  HostStatusPayload,
  PresenceState,
  WebServerRouteLike,
  WebServerLike,
  HostTrustFacts,
  ClientEnvelope,
  ParseClientEnvelopeResult,
  EndpointPostEntryLike
} from './core/gui.js'
// Re-export the delivery engine's public surface (value + type) so the compiled
// lib/invoke.js stays a drop-in superset of the pre-extraction module.
export { createDeliveryEngine, frameBusRecord } from './core/delivery.js'
export type {
  DeliveryInterruptOptions,
  DeliverOrQueueOptions,
  BusMemberProfile,
  BusSendResult,
  DeliveryEngine,
  DeliveryEngineDeps,
  CatalogRoute
} from './core/delivery.js'
// FASE 2 step (d): the pure messaging ACL is extracted into ./core/acl.js (the
// busProfileFor / aclDenyGround semantics + canSend / aclDenyReason). invoke.ts
// consumes the pure functions here — binding the apply catalog onto
// `busProfileFor` and using `aclDenyGround` directly — and re-exports the ACL
// surface so lib/invoke.js keeps them addressable (a drop-in superset: no
// existing export is removed). `BusMemberProfile` is already re-exported above
// (via delivery.js, which itself re-exports it from acl.js).
import {
  busProfileFor as aclBusProfileFor,
  aclDenyGround as aclDenyGroundImpl
} from './core/acl.js'
import type { BusCatalogLens } from './core/acl.js'
export { busProfileFor, aclDenyGround, aclDenyReason, canSend } from './core/acl.js'
export type { BusCatalogLens } from './core/acl.js'
// FASE 2 step (e): the WAKE CONTEXT PACK + ROSTER (the host wake injection) is
// carved out of this monolith into ./core/wakepack.js. It owns the pure pack
// builders (buildWakePack / buildWakePackMessage), the condensed roster
// (buildCondensedRoster), the assembly (assembleWakePack / assembleWakeSnapshot)
// and the `agent/pre-step` injector (Batch C). The apply fiber builds ONE
// WakePackService per-apply and injects the closure-bound deps, mirroring the
// registry/delivery pattern. We RE-EXPORT the moved pure symbols so lib/invoke.js
// stays a drop-in superset for existing consumers (and the tests).
import {
  createWakePackService,
  buildWakePack,
  buildWakePackMessage,
  buildPresenceMessage,
  presenceGuidance,
  formatMessageDeltaLine,
  buildDepartmentsDirectory,
  DIRECTORY_ACL_NOTE,
  toJsonSafe,
  jsonSafeMessageSource,
  sanitizePromptLiterals,
  buildSubagentOrientationMessage,
  HOST_WAKE_ROUTINE_TEXT,
  HOST_WAKE_NEXT_STEP,
  BOUND_TEMPLATE_VARS
} from './core/wakepack.js'
import type {
  WakePackService,
  WakePackDeps,
  WakePackParts,
  WakePreStepArgs,
  HostSleepSurfacePlan,
  DirectoryDepartment
} from './core/wakepack.js'
export {
  createWakePackService,
  buildWakePack,
  buildWakePackMessage,
  buildPresenceMessage,
  presenceGuidance,
  formatMessageDeltaLine,
  buildDepartmentsDirectory,
  DIRECTORY_ACL_NOTE,
  toJsonSafe,
  jsonSafeMessageSource,
  sanitizePromptLiterals,
  buildSubagentOrientationMessage,
  HOST_WAKE_ROUTINE_TEXT,
  HOST_WAKE_NEXT_STEP
} from './core/wakepack.js'
export type {
  WakePackService,
  WakePackDeps,
  WakePackParts,
  WakePreStepArgs,
  WakePreStepDecision,
  WakeMessageStoreLike,
  HostSleepSurfacePlan,
  DirectoryDepartment
} from './core/wakepack.js'

/**
 * Task T4 — session header AS OBSERVED AT RUNTIME: dsh-session FLATTENS the
 * creation-meta whitelist into TOP-LEVEL header keys (SessionService.prepare:
 * `header.origin = meta.origin`, `header.parentSession`, … —
 * dsh-session/lib/index.js:1657-1668); a nested `header.meta` key NEVER exists
 * at runtime (verified against persisted session records, which carry flat
 * `{"origin":"subagent","delegationDepth":1,parentSession,…}`). Transient
 * dispatched subagents carry flat `origin === 'subagent'` (dsh-subagent
 * childSessionMeta); registered hosts/heads/workers carry `origin: undefined`.
 * We cast through this shape for subagent-origin detection (injector +
 * dept_sleep guard). The nested `meta` member is kept ONLY as a defensive
 * fallback for stale/mocked headers — it is never the discriminator.
 */
interface SessionHeaderWithOrigin {
  origin?: unknown
  parentSession?: unknown
  delegationDepth?: unknown
  /** Nested creation-meta record — the PRE-flatten shape some mocks/stale
   *  headers still carry; absent at runtime, read only as a fallback. */
  meta?: {
    origin?: unknown
    parentSession?: unknown
    delegationDepth?: unknown
  }
}

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
interface AgentMessageSource {
  kind: 'agent'
  form: 'send'
  plugin: 'deepartments'
  summary: string
  to?: string[]
  messageId?: string
  from?: string
  senderSessionId?: SessionId
}

// Batch C — ack-loop budget. A sender→target pair that has exchanged this many
// pure acks (payload.ack) within this window, with no intervening non-ack
// message, is treated as a confirmation loop: the relay stops waking it. Keep
// in sync with the relay header comment.
const ACK_LOOP_THRESHOLD = 3
const ACK_LOOP_WINDOW_MS = 120_000

// Fix A2 — stuck-head wake resilience. A live head whose resident loop has made
// NO observable session progress within this window is treated as STUCK (Batch
// 1c: a head's boot turn wedged on an empty-arguments tool call and froze
// resident-but-stuck; the wake relay would otherwise enqueue a followup into
// the frozen loop's in-memory inbox and LOSE it on restart). When stuck, the
// relay disposes the frozen handle and cold-resumes the durable session, so the
// wake is re-delivered from the DURABLE board record, never lost.
const STUCK_HEAD_MS = 120_000

/** Fix A2 — injectable clock for the stuck-head window. Production reads the
 * REAL wall clock (env unset → `Date.now()`), so a healthy head is judged
 * against true elapsed time. Hermetic Loader tests (Rule 5) set
 * `DEEPARTMENTS_TEST_NOW` to a fixed epoch and advance it between wake pushes,
 * so the STUCK_HEAD_MS stall can elapse deterministically WITHOUT sleeping 120s
 * in a test. IMPORTANT: the progress baseline stamp (`markHeadProgress.at`) and
 * the stall comparator (`isHeadStuck`) MUST read the SAME clock or elapsed is
 * internally inconsistent; both go through this helper. */
const stuckNow = (): number => {
  const raw = process.env.DEEPARTMENTS_TEST_NOW
  if (raw === undefined) return Date.now()
  const override = Number(raw)
  return Number.isFinite(override) ? override : Date.now()
}

// ---------------------------------------------------------------------------
// W9-b — delivery interrupt/queue semantics (owner decision 2026-08-24).
//
// Opt-in `interrupt: true` on a bus send / delivery PREEMPTS a busy recipient:
//
//   - recipient DORMANT  → wake + process IMMEDIATELY (unchanged behavior).
//   - recipient LIVE mid-turn → the delivery seam ABORTS the recipient's
//     CURRENT turn (reason 'interrupted') and the message is the first item of
//     the recipient's NEXT turn.
//
// DEFAULT (no `interrupt`, or `interrupt: false`) = the CURRENT QUEUE
// semantics: the message is enqueued behind whatever the recipient is doing —
// ZERO regression for normal flows.
//
// HARNESS ABORT/STOP API (the GUI stop): `Agent.cancel(cause, options?)`
// (dsh-agent rAgent.cancel — dsh-agent-loop lib/index.js:405). It clears the
// inbox UNLESS `options.keepInbox` is set, then aborts the active turn/task via
// `this.phase.abort.abort(cause)`. The `AgentCancelCause` union is
// { user | parent | hook(reason) | disposed } — there is NO literal
// 'interrupted' kind, so the semantic reason is carried as a `hook` cause whose
// `reason` string is 'interrupted' (type-valid, and the durable `turn/end`
// reason records `{ kind: 'hook', reason: 'interrupted' }`). `keepInbox: true`
// preserves any already-pending/steering inbox items, so an interrupt NEVER
// loses an earlier queued message (only the ACTIVE turn is aborted). The abort
// is graceful MID-TOOL: dsh-agent-loop records the partial assistant content
// via `assembler.interruptedBlocks()` as an `assistant/message` (interrupted:
// true) before rethrowing, and the session records the turn as ended-aborted —
// the partial state is preserved, no data loss. The session context (the
// durable session log) is untouched, so the NEXT turn continues from the
// preserved state.
// ---------------------------------------------------------------------------



/** Loose structural view of a live `Agent` (the shape `ctx.agents.get(id)`
 * returns; rc.8 dsh-agent runtime-types.d.ts:60-133). Declared structurally so
 * the plugin never hard-depends on `@deepseek-ai/dsh-agent` — it resolves the
 * `agents` service optionall  y via `ctx.get('agents')` (the existing seam in
 * this file). Only the surface the head lifecycle needs is declared. */
interface AgentLike {
  id: string
  status: string
  ctx: Context
  /** The agent's durable session event log (rc.1+ session surface: the
   * `events` getter is GONE — read via `snapshotEvents()` / `seq`, the
   * `seq = log.length` contract). Its length is the Fix A2 stuck-head progress
   * signature (every appended step/turn/assistant event is observable
   * lifecycle progress). Declared structurally; absent/undefined → treated as
   * no signal (never misclassified as progression). */
  session?: {
    /** The log length (rc.1 `seq = log.length` — the old `events.length`). */
    seq: number
    /** The full immutable log snapshot (rc.1 — the old `events` array). */
    snapshotEvents(): readonly unknown[]
    /** Legacy dual fallback: the pre-rc.1 core line still exposes the cached
     * `events` getter (runtime core 0.1.1-rc.2). Keep optional for the
     * 0.1.2-rc.1 surface where it is gone. */
    events?: readonly unknown[]
    /** The append seam (rc.1 keeps `append` — optional for read-only views). */
    append?: (type: string, data: unknown, opts?: { surfaceOp?: string }) => unknown
    header?: unknown
  }
  followup(message: { content: readonly { type: string; text: string }[]; source: Record<string, unknown> }): void
  /** The harness ABORT/STOP API (the GUI stop — dsh-agent Agent.cancel). W9-b
   * delivery-interrupt uses it with a `hook`/reason 'interrupted' cause and
   * `{ keepInbox: true }` (preserve pending work) to preempt a busy recipient.
   * Never throws. */
  cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
}

/** M-A — structural view of the harness `sessionProjections` service surface
 * the context-monitor wiring reads (dsh-session-projection
 * `SessionProjectionRegistry.snapshot(session)` — the eager-driven per-session
 * projection read: one consistent cut over every client-visible unit, O(1)
 * fold over the in-memory log, zero I/O/LLM/red; the data the token-meter
 * already folded). The bundle reads the SNAPSHOT WIRE VIEW (the COMMON API
 * across dsh-session-projection versions — the older 0.1.0-rc.7 has
 * `snapshot` but no `stateOf`; the harness 0.1.1-rc.2 has both), whose
 * `values.contextPressure` already carries the token-meter wire view
 * `{ contextWindow?, pressureTokens?, projectedTokens? }` (projectedTokens =
 * max(0, pressureTokens + surfaceTokens − sampledSurfaceTokens) — the scan
 * accepts it directly, falling back to the raw-state formula). The service is
 * resolved OPTIONALLY via `ctx.get('sessionProjections')` (absent in
 * minimal/hermetic compositions → `buildSessionContexts` returns undefined →
 * the context-threshold scan is a no-op, the hostRunning-absent pattern). */
interface SessionProjectionsLike {
  snapshot(session: unknown): { asOfSeq?: number; values?: Record<string, unknown> }
}

/** Structural view of the `AgentHandle` returned by `ctx.agents.create/resume`
 * (rc.8 dsh-agent types/index.d.ts:155-158). `dispose()` is the sleep teardown
 * capability; it is held ONLY by the plugin owner, never by the head agent. */
interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

/** Agent-scoped creation options the department machinery passes at
 * create/resume. Shape = the dsh core `AgentOptions`
 * (`{ provider?, model?, maxTokens? }` — dsh-agent runtime-types.d.ts:21)
 * PLUS the repo's coordinator convention `reasoningEffort` (the coordinator
 * block in cordis.patch.yml carries `reasoningEffort: max`). The core runtime
 * tolerates the extra key (assertAgentOptions validates only maxTokens —
 * dsh-agent-loop index.js), so declaring it keeps the F7 worker surface
 * type-honest with the config pattern. */
interface AgentOptionsLike {
  provider?: string
  model?: string
  maxTokens?: number
  reasoningEffort?: string
}

/** fb-6 (QH — the resume/re-materialization "has no provider/model" class):
 * whether AgentOptions carry a USABLE provider/model route (provider AND model
 * are non-empty strings). PURE. The materializePost seam falls back to
 * WORKER_AGENT_OPTIONS when this is false: a department-less/legacy worker —
 * or a config-less head — whose durable session survived an interrupted spawn
 * resolves `coordinator?.agentOptions` to undefined, and the empty waterfall
 * threw `agent "session-<uuid>" has no provider/model` at resume/create. */
export function isUsableAgentOptions(agentOptions: AgentOptionsLike | undefined): boolean {
  return (
    agentOptions !== undefined &&
    typeof agentOptions.provider === 'string' &&
    agentOptions.provider.length > 0 &&
    typeof agentOptions.model === 'string' &&
    agentOptions.model.length > 0
  )
}

/** Structural view of the `agents` service surface the head lifecycle touches
 * (rc.8 dsh-agent types/index.d.ts:288-370). */
interface AgentsLike {
  get(id: string): AgentLike | undefined
  list(): AgentLike[]
  roots(): AgentLike[]
  create(options: {
    sessionId: string
    /** M-A: the optional initial replay/fork history (the harness
     * `CreateAgentOptions.seed` — dsh-agent types/index.d.ts:94) passed to
     * `sessions.prepare(id, { seed, meta })`. A HEAD-ROTATION fresh-mint seeds
     * the head's journal this way (buildHeadRotationSeed); the legacy
     * F8 slept-head wake passes none (session stays empty — zero regression). */
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

/** Structural view of the `agentPresets` service surface the head setup needs
 * (rc.8 dsh-agent-presets types/index.d.ts:115,159). Resolved optionally via
 * `ctx.get('agentPresets')`; when absent (e.g. minimal/hermetic compositions)
 * the head setup mounts nothing but still registers its board tools. */
interface AgentPresetsLike {
  resolve(id: string): Promise<unknown>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** YAML-ish flow list rendering for witness frontmatter arrays. */
function yamlList(items: readonly string[]): string {
  return `[${items.map((item) => JSON.stringify(item)).join(', ')}]`
}

// ---------------------------------------------------------------------------
// Batch 7 — HOST sleep helpers (PURE, exported, unit-tested).
//
// U2 (spec 002): the host branch of dept_sleep now ROTATES the host session
// (old retired + archived, new seeded with the re-keyed journal — see
// src/session-rotation.ts). These helpers now serve the LEGACY FALLBACK path
// ONLY (a rotation that cannot run falls back to the old in-place reset): the
// ENTIRE model-visible surface of the live session is eventually collapsed
// down to ONE node — the agent's own journal — using the SAME surface
// primitive dsh-compaction drives (explore-deep/2026-08-20-compaction-reset.md
// §4): a `user/message` append with
// `surfaceOp:{op:'replace', start:firstNode, end:lastNode}` +
// `sourceEventSeqs: allNodes`. `Session.append` (dsh-session index.d.ts:1444)
// validates + splices the current surface (`foldSurface`/`applySurfacePlan`,
// surface.js) so after the append `deriveMessages()` returns exactly the
// journal node. These two helpers compute the inputs purely so they are
// directly testable; the live dept_sleep wiring is thin.
//
// Fix A (2026-08-21 — the wake-7 tool-role 400 root cause, explore-deep/
// 2026-08-21-failedmessages-tool-role-error.md): the replace itself is
// DEFERRED. The close branch only plain-appends the journal node (durability)
// and records the intent; the NEXT `agent/pre-step` (the Batch C injector)
// performs the full-window replace over ALL current nodes INCLUDING the still
// pending dept_sleep tool result — so the assistant tool-call message and its
// result stay a legal sequence and an orphaned role:'tool' node never reaches
// the strict opencode-go API.
// ---------------------------------------------------------------------------

/** Compute the surface-intent for an in-place reset from the CURRENT live
 * surface nodes. Replicates the dsh-compaction shape exactly: `start`/`end`
 * are the first/last current node seqs (inclusive) and `sourceEventSeqs` cites
 * every shadowed node (assertProvenance requires complete coverage). An empty
 * surface (no nodes) cannot be replaced — fall back to a plain append so the
 * journal still lands as the sole node. */
export function computeHostSleepSurfacePlan(nodes: readonly number[]): HostSleepSurfacePlan {
  if (nodes.length === 0) {
    return { surfaceOp: 'append' }
  }
  return {
    surfaceOp: { op: 'replace', start: nodes[0], end: nodes[nodes.length - 1] },
    sourceEventSeqs: [...nodes]
  }
}

// ---------------------------------------------------------------------------
// FASE 2 STEP f (lifecycle carve): the `buildSleepJournalMessage` host surface
// reset node and `shouldClearCleanupPending` cleanup gate moved to
// ./core/lifecycle.js. Re-exported here so lib/invoke.js stays a drop-in
// superset for the rotation/session-cleanup tests that import them.
// ---------------------------------------------------------------------------
export { buildSleepJournalMessage, shouldClearCleanupPending } from './core/lifecycle.js'

// ---------------------------------------------------------------------------
// Batch W4 — WAKE CONTEXT PACK (owner doctrine: inject, don't let the model
// re-derive). The freshly-woken host MUST receive ALL orientation info + the
// full workflow skill body sealed into its initial surface, the same way DSH
// injects skill-catalog and dsh-system-prompt — NOT pushed to on-demand/lazy.
// The pack is assembled by a NON-pure closure in applyInvoke (live git/board/
// ROADMAP/skill reads) but rendered by the PURE, exported `buildWakePack`
// helper (now in ./core/wakepack.js) so it is directly unit-testable.
// `dept_wake_snapshot` reuses the SAME pure builder for on-demand freshness
// mid-session (P1 fusion).
//
// Deep rule (stale-liveness): the pack NEVER statically embeds true live
// session liveness (`sessionLive`) — a stale false claim is worse than one
// on-demand `dept_who`. Roster carries only durable registry flags
// (sleeping), listing flags that are live-registry reads never baked in.
// The pure builders, `WakePackParts`, the canonical routine text and the
// assembly now live in ./core/wakepack.js (FASE 2 STEP e).
// ---------------------------------------------------------------------------

// (the `/deepartments` channel server-half — the types
// WebServerRouteLike/WebServerLike/PresenceState/DeepartmentsEndpointDeps/
// HostStatusPayload + the PURE builders buildHostStatusPayload + the
// dispatcher/envelope/trust + the route handler — MOVED to packages/dshd-gui;
// see the dshd-gui phase note above: they are now imported + re-exported
// from ./core/gui.js, and the mount effect below wires the live deps.)

// ---- Feature A — owner-presence persistence + guard predicate (PURE) -------

/** Read `<stateDir>/presence.json`. Absent, unreadable or malformed → default
 * present:true (the owner is considered present until toggled). PURE (node:fs
 * readFileSync), never throws. Exported so the dispatch tests exercise the SAME
 * persistence helper the production wiring uses — no drift between the tested
 * path and the live path. */
export function readPresenceStateFile(stateDir: string): PresenceState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, 'presence.json'), 'utf8')) as { present?: unknown; updatedAt?: unknown }
    return {
      present: typeof parsed.present === 'boolean' ? parsed.present : true,
      ...(typeof parsed.updatedAt === 'number' ? { updatedAt: parsed.updatedAt } : {})
    }
  } catch {
    return { present: true }
  }
}

/** Write `<stateDir>/presence.json` (mkdir -p the dir, then write the state
 * JSON). Returns the state written. Exported for the same reason as
 * [`readPresenceStateFile`]. Throws on an fs failure — the production wrapper
 * (`savePresence`) folds that into a warn so an RPC never fails on a persist
 * error, while a test can assert the write directly. */
export async function writePresenceStateFile(stateDir: string, state: PresenceState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, 'presence.json')), { recursive: true })
  await writeFile(path.join(stateDir, 'presence.json'), JSON.stringify(state), 'utf8')
}

// ---------------------------------------------------------------------------
// M-A — `dept_head_rotate` journal-status helper (PURE).
// ---------------------------------------------------------------------------
// The host-plane HEAD-ROTATION tool (the active context-refresh of a
// configured department head — micro-decision owner 2026-08-28, map
// reports/explore-deep/2026-08-28-ma-context-monitor-map.md §3) ALWAYS seeds
// the fresh session with the head's LAST DURABLE JOURNAL and NEVER delays the
// rotation for a fresh memo (the critical-unblock rule: a context-over-threshold
// head — e.g. the QH — may not be able to run dept_memo_write at all, so a
// rotation that waited on a memo could never unblock it). The host's workflow
// asks for `dept_memo_write` BEFORE rotating when the head is operative and the
// window permits; the STALE marker below tells the host when the seeded journal
// predates the freshness window, so it can request a refresh at the first
// opportunity without blocking the unblock.
/** The freshness window for a rotation journal: `timestamp:` older than this →
 * `headRotationJournalStatus` reports `stale:true` (a "memo no actualizado —
 * journal previo" notice rides the tool result + the QD mirror). */
export const HEAD_ROTATE_JOURNAL_STALE_MS = 30 * 60 * 1000

/** M-A — the rotation journal status (PURE, exported for direct tests): parse
 * the journal's frontmatter `timestamp:` line (the dept_memo_write convention)
 * and compute the stale marker against `nowMs`. Returns `timestamp` (the raw
 * frontmatter value) when parseable; ABSENT/unparseable → `stale:true`
 * (a journal with no verifiable timestamp is conservatively "previous"). */
export function headRotationJournalStatus(journalText: string, nowMs: number): { timestamp?: string; stale: boolean } {
  const match = journalText.match(/^timestamp:\s*(.+?)\s*$/m)
  const raw = match?.[1]
  if (raw === undefined || raw === '') return { stale: true }
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) return { stale: true }
  return { timestamp: raw, stale: nowMs - parsed > HEAD_ROTATE_JOURNAL_STALE_MS }
}

// ---------------------------------------------------------------------------
// fb-25 (a) — the REASON CROSS-CHECK (QD ALTO, map
// reports/explore-deep/2026-08-28-fb25-head-rotated-reason-map.md): the reason
// a head rotation carries to the QD mirror is the CALLER's free text (copied
// VERBATIM, never recalculated from the archive — map §1) and once a FALSE
// figure propagates it is internalized by the QH/inspectors AND the host's
// greeting to the fresh head (map §4 — the m-1110/m-1111 case: ~789k cited for
// a session that ended COMPLETED at ≈190k). The emit now contrasts the figure
// the reason cites against the OLD session's REAL usage — the durable
// `session_projcache.json` row (the token-meter's cross-process mirror, the
// SAME data the context-threshold monitor reads live) — and stamps the mirror
// `reasonVerified`. NEVER BLOCKS: any failure/absence → 'unavailable' and the
// rotation proceeds (the critical-unblock rule; the archive is cosmetic).
// ---------------------------------------------------------------------------

/** The verification stamp of a rotation reason: 'verified' (the cited figure
 * matches the old session's projected/used tokens within tolerance),
 * 'unverified' (a figure EXISTS but does NOT match — the reason cites another
 * session's numbers or an impossible state), 'unavailable' (no datum: reason
 * without a figure, absent/unreadable mirror, session not projected, a
 * degenerate row — conservatively nothing to verify). */
export type ReasonVerificationStamp = 'verified' | 'unverified' | 'unavailable'

/** The relative tolerance for a 'verified' verdict (the reason figure vs the
 * old session's real usage — mission guidance: ±10-15%). */
export const REASON_VERIFY_TOLERANCE = 0.15

/** The tolerantly-parseable token figure of a rotation reason: an optional
 * `~`, a 1-7 digit number (thousands separators `.`/`,` accepted), an optional
 * `k`/`K` suffix ("~789k", "789,959", "1.048.576"). Sub-thousand matches
 * (turn counts, percentages, MB sizes) are noise and filtered out. */
const REASON_TOKEN_FIGURE_RE = /~?\s*(\d{1,3}(?:[.,]\d{3})+|\d+)\s*([kK])?/g

/** Extract the FIRST token-scale figure (≥1000 after a `k` normalization) a
 * rotation reason cites — the leading claimed usage figure. Returns undefined
 * when the reason carries no token-scale number. */
function extractRotateReasonTokenFigure(reason: string): number | undefined {
  for (const match of reason.matchAll(REASON_TOKEN_FIGURE_RE)) {
    const raw = match[1].replace(/[.,]/g, '')
    let value = Number(raw)
    if (!Number.isFinite(value)) continue
    if (match[2] !== undefined) value *= 1000
    if (value < 1000) continue
    return value
  }
  return undefined
}

/** The projected/used tokens of one session row in the parsed projcache —
 * PRIMARY: the monitor's own projected formula on the FINAL `contextPressure`
 * (max(0, pressureTokens + surfaceTokens − sampledSurfaceTokens) — the number
 * a context-threshold finding would cite; evidence fb-25 map §6:
 * 7ab757b3 190,213 = max(0,190180+137931−137898); 6686fc52 ≈ 217,140);
 * FALLBACK: the token-meter's LAST-turn `cacheReadTokens`
 * (tokenUsage.last.buckets) — the raw usage mirror; for a completed turn it
 * converges with the projection (189,952 ≈ 190,213 / 216,832 ≈ 217,140), and
 * it covers a row whose projection fields are absent. Degenerate (≤0 / absent)
 * → undefined ('unavailable' — the final row of an ERROR-ended session has the
 * pressure reset, so no corroborating datum exists). */
function projectedUsageForSession(projCache: unknown, sessionId: string): number | undefined {
  const tables = (projCache as { tables?: { sessions?: Record<string, unknown> } } | undefined)?.tables
  const sessions = tables?.sessions
  if (sessions === undefined || typeof sessions !== 'object') return undefined
  let row: unknown = (sessions as Record<string, unknown>)[sessionId]
  if (row === undefined) {
    // Tolerant fallback: a key CONTAINING the session id (a prefix/short form).
    for (const [key, value] of Object.entries(sessions)) {
      if (key.includes(sessionId)) {
        row = value
        break
      }
    }
  }
  if (row === undefined || typeof row !== 'object') return undefined
  const rows = (row as { rows?: Record<string, unknown> }).rows
  if (rows === undefined || typeof rows !== 'object') return undefined
  const cpVal = (rows.contextPressure as { val?: Record<string, unknown> } | undefined)?.val
  if (cpVal !== undefined && typeof cpVal === 'object') {
    const pressure = finiteNumber(cpVal.pressureTokens)
    const surface = finiteNumber(cpVal.surfaceTokens)
    const sampled = finiteNumber(cpVal.sampledSurfaceTokens)
    if (pressure !== undefined && surface !== undefined && sampled !== undefined) {
      return Math.max(0, pressure + surface - sampled)
    }
  }
  const buckets = (rows.tokenUsage as { val?: { last?: { buckets?: Record<string, unknown> } } } | undefined)?.val?.last?.buckets
  const cacheRead = buckets === undefined ? undefined : finiteNumber(buckets.cacheReadTokens)
  if (cacheRead !== undefined) return cacheRead
  return undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** fb-25 (a) — resolve the DURABLE session-projection mirror path
 * (`<stateHome>/storages/session_projcache.json`) the SAME way the web-UI
 * sleep-cleanup wiring resolves it (:2730 — persistence.root sessions root →
 * state home → storages). Exported so the tool wiring and the tests share ONE
 * resolution (no tested/production drift). */
export function resolveSessionProjCachePath(stateDir: string, persistenceRoot?: string): string {
  const sessionsRoot = typeof persistenceRoot === 'string' && persistenceRoot !== ''
    ? persistenceRoot
    : path.join(stateDir, '..', 'sessions')
  return path.join(path.dirname(sessionsRoot), 'storages', 'session_projcache.json')
}

/** fb-25 (a) — PURE cross-check of a rotation reason against the OLD session's
 * real usage (PURE = never throws; EVERY failure/absence degrades to
 * 'unavailable' — the rotate NEVER blocks on the stamp, map §1 critical-unblock
 * rule). A reason with NO figure, a missing/unreadable/malformed mirror
 * (`projCachePath` absent or unreadable), an unprojected session row, or a
 * degenerate (≤0) usage datum → 'unavailable'; a figure matching the old
 * session's projected/used tokens within ±REASON_VERIFY_TOLERANCE → 'verified';
 * any other figure (a different session's numbers, an impossible state) →
 * 'unverified'. */
export function verifyRotateReason(reason: unknown, oldSessionId: string, projCachePath?: string): ReasonVerificationStamp {
  if (typeof reason !== 'string' || reason.trim() === '') return 'unavailable'
  if (typeof oldSessionId !== 'string' || oldSessionId === '') return 'unavailable'
  if (typeof projCachePath !== 'string' || projCachePath === '') return 'unavailable'
  let reference: number | undefined
  try {
    const parsed = JSON.parse(readFileSync(projCachePath, 'utf8')) as unknown
    reference = projectedUsageForSession(parsed, oldSessionId)
  } catch {
    return 'unavailable'
  }
  if (!(reference !== undefined && reference > 0)) return 'unavailable'
  const figure = extractRotateReasonTokenFigure(reason)
  if (figure === undefined) return 'unavailable'
  const ratio = Math.abs(figure - reference) / reference
  return ratio <= REASON_VERIFY_TOLERANCE ? 'verified' : 'unverified'
}

// ---------------------------------------------------------------------------
// W1 (spec 004 §5.7 + ROADMAP W1 — "Runtime + jobs + UI panel"): the runtime
// calendar + scheduler. The PURE persistence + cron half is exported (like the
// presence helpers) so the dispatch/scheduler tests exercise the SAME helpers
// the production wiring uses — no tested/production drift. The runtime calendar
// is a single-file message board (`<stateDir>/calendar.json`), the job-fire
// idempotency ledger is `<stateDir>/job-runs-state.json`, and the cron parser is
// deliberately MINIMAL (`m h dom mon dow` with `*`/numbers/ranges/steps plus a
// few `@` aliases) — the deployment's job `schedule` fields are HUMAN text
// (e.g. `"daily 09:00 (reserved…)"`), so a non-cron schedule never auto-fires.
// No `@recurring`/`RRULE` support: an ad-hoc calendar entry fires ONCE.
// ---------------------------------------------------------------------------

/** REPO root, resolved from the compiled bundle dir (`lib/` → `..` = the repo).
 * Shared as the DEFAULT for the agenda/job readers so the dispatch and the
 * scheduler resolve the default department jobDir exactly like the live
 * `applyInvoke` `repoRoot` (same expression, same value). */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

// (calendar + job-runs state helpers MOVED to packages/dshd-jobs — see the
// dshd-jobs phase note above; the CalendarEntry/CalendarState types and the
// read/write helpers are now imported + re-exported from ./core/jobs.js.)

// (the W6 system-health DOMAIN — post-error capture, B5 unusable-session
// markers, heartbeat/alerts ledger + audit, W8-i error class, M3 back-off +
// quarantine, W8-c safeguards, W8-d system heartbeat, W8-h interrupted-post
// reconciliation, C6 tail reader + scans + the health daemon tick — MOVED to
// packages/dshd-health — see the dshd-health phase note above; every symbol is
// now imported + re-exported from ./core/health.js. The B4 deliverDaemonNotice
// gate below STAYS in the bundle — it is a SHARED scheduler/monitor gate, not
// health domain.)


// ---------------------------------------------------------------------------
// B4 — the daemon re-wake gate decision helper.
// ---------------------------------------------------------------------------
// A ROUTINE daemon notice (agenda scheduler calendar notice / parallel-monitor
// "a worker is working" notice) to a DORMANT head (sleepEpoch set — an owner-
// scheduled quiet-sleep) must NOT re-wake it. The notice is already appended
// durably by the caller, so this helper returns 'queued' (no delivery / no
// materialize) — the record drains at the head's next real wake. The ALWAYS-WAKE
// default is preserved for a non-dormant head. NEVER route the CRITICAL
// deliveries (health ALERT / system-wait / interrupt) through this helper —
// those MUST keep waking.
export type DaemonNoticeDelivery = 'queued' | 'woken'

export async function deliverDaemonNotice(
  targetEntry: { postId: string; sleepEpoch?: number | undefined },
  record: MessageRecord,
  framed: string,
  deliver: (entry: PostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined) => Promise<DeliveryStatus>
): Promise<DaemonNoticeDelivery> {
  if (targetEntry.sleepEpoch !== void 0) return 'queued'
  await deliver(targetEntry as PostEntry, framed, record, undefined)
  return 'woken'
}


// (the QD (spec 007 Quality Department) probability gate + config-resolution +
// directive text — the QUALITY_WORKER_INSPECT_DEFAULT_PROBABILITY constant, the
// QUALITY_INSPECT_ENV_VAR env override, the QualityInspectKind /
// QualityInspectDecisionDeps / QualityInspectDirectiveSurface types,
// qualityInspectDecision, resolveQualityWorkerInspectProbability and
// qualityInspectDirectiveText (plus the two package-private helpers
// parseQualityInspectEnvOverride + clamp01) — MOVED to packages/dshd-quality;
// see the dshd-quality phase note above: every symbol is now imported +
// re-exported from ./core/quality.js. The maybeEmitQualityInspectDirective
// emitter closure, the per-apply qualityWorkerInspectProbability resolution
// and the four gate call-sites (worker-retire, the two post-error catches, and
// the 'head-slept' check inside the emitter) stay in the bundle and use the
// gate via the bridge.)


// (provider-adapter pooler helpers MOVED to packages/dshd-pooler — see the
// dshd-pooler phase note above; the constants, the finding/input/drift types
// and providerAdapterEndpointDrift/resolveProviderAdapterBootFindings/
// parseLlmPiAiProviderSettings/readLlmPiAiProviderSettings are now imported +
// re-exported from ./core/pooler.js. runProviderAdapterBootCheck below keeps
// using them via the bridge.)

// (the W8-c SAFEGUARDS (turn-error capture, stale-live watchdog, preset audit),
// the W8-d SYSTEM HEARTBEAT (wait scan, inbox reader, heartbeat section) and
// the W8-h INTERRUPTED-POST reconciliation MOVED to packages/dshd-health — see
// the dshd-health phase note above; every symbol is now imported + re-exported
// from ./core/health.js. The preset-audit boot effect, assembleHeartbeat and
// the W8-h boot reconciliation below are the bundle call-sites that use them.)



// ---------------------------------------------------------------------------
// dept_exec (spec W5-B2): the SCOPED shell tool for department posts. A worker
// whose role template DECLARES `dept_exec` in its frontmatter `tools` inherits
// it (registered on the post's OWN layer inside installHeadBoardTools, gated by
// the role-tools allow-list); a post that does not declare it never sees it,
// and the host / config heads never get it. The ALLOW ROOTS + the deny guard
// are PURE module helpers so the scope policy is CENTRAL and unit-testable —
// the tool runs realpath/execFile around the same `deptExecDenyReason` the
// tests probe directly.
// ---------------------------------------------------------------------------

/** The fixed (non-config) allowed roots for dept_exec, in addition to the repo
 * root, the caller's department workspace and the runtime stateDir. */
export const DEPT_EXEC_DEFAULT_ROOTS: readonly string[] = [
  '/home/esuarez/projects',
  '/usr/lib/node_modules/@deepseek-ai/dsh',
  // The DEV-profile deployment home (DSH_HOME for deepartments-dev) — the
  // version-watch job builds/installs plugins there, and dept_exec MUST reach
  // it. `/opt/dsh/.dsh` (stable) is deliberately OUT of the allowed roots so the
  // cwd-in-root check + the protected token both deny it (spec §5.1/§5.2 I4).
  '/opt/dsh/.dsh-dev'
]

/** Case-insensitive substring denylist for dept_exec commands — a denied token
 * is an out-of-scope safety net; the caller escalates via the Asistente.
 * `systemctl` is deliberately NOT in this list: the single READ-ONLY
 * `systemctl is-active <unit>` form is permitted (non-mutating confirmation)
 * and is carved out in `deptExecDenyReason` via `isReadOnlySystemctl`; every
 * MUTATING systemctl form (start/stop/restart/enable/disable/daemon-reload/
 * mask/…) is still denied there. fb-62 (IPH — token-guard refinement): the
 * root-wipe «rm -rf /» is deliberately NOT a loose substring here EITHER — a
 * substring match over-blocks every SCOPED cleanup (`rm -rf /root/.deepartments/
 * …`, `rm -rf /home/esuarez/projects/…`), so the ONLY remaining deny form is
 * the COMPLETE-root destination handled by the dedicated `isRmRfRootWipe`
 * below (the real-path scope check in `deptExecDenyReason` governs scoped
 * targets: in-root allowed, out-of-root / stable protected-denied). */
export const DEPT_EXEC_DENYLIST: readonly string[] = [
  'reboot', 'shutdown', 'poweroff', 'halt', 'init 0',
  'sudo', 'su -', 'mkfs', 'fdisk', 'parted', 'dd if=',
  'nsenter', ':(){'
]

/** fb-62 (IPH — token-guard refinement): whether the command contains an `rm`
 * invocation whose DESTINATION is the COMPLETE filesystem root `/` — the ONLY
 * form the legacy loose denylist substring «rm -rf /» must still catch. The
 * destination is the root when a word-boundary `rm` + whitespace + `-rf` +
 * whitespace is followed by ONE-OR-MORE `/` whose word ENDS at end-of-command,
 * whitespace or a shell boundary (`;&|()<>` + quotes/backtick) — NEVER when
 * the `/` prefixes a longer real path (`rm -rf /etc/passwd`, `rm -rf /root/
 * .deepartments/…`, `rm -rf /home/esuarez/projects/…`): scoped destinations
 * are governed by the REAL-PATH scope check in `deptExecDenyReason` (an
 * in-root cleanup is ALLOWED — that is the fb-62 false positive being fixed —
 * while an out-of-root `/etc/passwd`/`/tmp/x`/`/var/…` target is still DENIED
 * there, and a `/opt/dsh/.dsh` target by the stable-protected check; a `/$VAR`
 * / `/*` / `/#` destination still reaches the path-token scan as a heuristic
 * raw token and is DENIED out-of-root). Case-insensitive. Module-private (NOT
 * exported — the frozen lib/invoke.js export count must not grow; the B2 tests
 * exercise the rule through the public `deptExecDenyReason`). */
function isRmRfRootWipe(command: string): boolean {
  const cmd = String(command ?? '')
  return /\brm\s+-rf\s+\/+(?=$|[\s;&|()<>'"`])/i.test(cmd)
}

/** Whether the command is the SINGLE READ-ONLY `systemctl is-active <unit>` form
 * (non-mutating confirmation). Matches EXACTLY the spec pattern
 * `systemctl` + whitespace + `is-active` (word-boundary) then ANY non-`;|&`
 * tail, ANCHORED to the whole (trimmed) command line, so there is NOTHING else
 * on the same line — no `;`/`|`/`&` chaining, no leading/other command, no
 * `systemctl status`/`restart`/`start`/`stop`/`enable`/`disable`/
 * `daemon-reload`/`mask`. An optional path prefix ending in `/` (e.g.
 * `/usr/bin/systemctl`) is tolerated; `sudo`/`reboot` etc. are caught by the
 * denylist BEFORE this carve-out, and the denylist itself is a substring check
 * so a mutating token elsewhere in the command is never smuggled past it. */
export function isReadOnlySystemctl(command: string): boolean {
  const cmd = String(command ?? '').trim()
  return /^(?:[A-Za-z0-9_./:=]*\/)?systemctl\s+is-active\b[^;|&]*$/i.test(cmd)
}

/** The stable-instance state-token — any reference DENIES with the explicit
 * "stable profile is protected" reason (requires owner approval). */
export const DEPT_EXEC_PROTECTED_TOKEN = '/opt/dsh/.dsh'

/** Boundary-aware stable-home check (spec §5.1 (c) / §9 ❓2 — the highest-risk
 * limit). `p` references the stable deployment home `/opt/dsh/.dsh` ONLY as a
 * whole path component: the literal must (a) be preceded by a start/in-shell
 * word boundary and (b) NOT be followed by a word/path-continuation char
 * (`-dev`, `_x`, `foo`). `/opt/dsh/.dsh-dev` (and everything under it) is the
 * DEV deployment home — NOT stable — so it is NOT denied. Used for BOTH the
 * command and the resolved cwd so `isStablePath('/opt/dsh/.dsh/…')` is denied
 * while `isStablePath('/opt/dsh/.dsh-dev/…')` is allowed. */
export function isStablePath(p: string): boolean {
  const s = String(p ?? '')
  const escaped = DEPT_EXEC_PROTECTED_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|[^A-Za-z0-9_/.-])${escaped}(?![A-Za-z0-9_-])`)
  return re.test(s)
}

/** Whether a MISSION-LEVEL owner grant (an allowed root) covers the STABLE home
 * `/opt/dsh/.dsh` — i.e. an explicit `org.missionExecRoots` (or `org.execRoots`)
 * entry NAMED the stable home (or a parent of it) as an allowed exec root. When
 * true the stable-token protection is bypassed ONLY for that granted root (the
 * command/cwd is then still subject to the normal cwd-in-root + absolute-path
 * containment checks, and to the denylist); for ANY mission WITHOUT such a grant
 * this stays false and the stable home remains protected-denied. The `/opt/dsh/
 * .dsh-dev` DEV home is NOT stable and NEVER grants the stable home here. */
export function isStableHomeGranted(allowedRoots: readonly string[]): boolean {
  const roots = allowedRoots.filter((r) => typeof r === 'string' && r !== '')
  return roots.some((root) => isPathInside(DEPT_EXEC_PROTECTED_TOKEN, root))
}

/** execFile timeout + maxBuffer for dept_exec (a runaway command is killed). */
export const DEPT_EXEC_TIMEOUT_MS = 120000
export const DEPT_EXEC_MAX_BUFFER = 8 * 1024 * 1024

/** Whether `candidate` is `root` or lexically INSIDE it. Both must already be
 * realpath-resolved by the caller (the comparison is pure string; a trailing
 * slash is normalized). `candidate === root` or `candidate` starts with
 * `root/` — never a sibling prefix like `/projects2`. */
export function isPathInside(candidate: string, root: string): boolean {
  const c = String(candidate ?? '').replace(/[/\\]+$/, '')
  const r = String(root ?? '').replace(/[/\\]+$/, '')
  if (r === '') return false
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/** fb-10 (QH): a `/`-leading token is a PATH WORD only when it carries a real
 * path NAME component. A token that is `/` followed ONLY by digits (a bare
 * `/3600000`, a `//3600000` after the leading separators collapse to the same
 * digit-only form) or that is all `/` with NO name at all (a `//` between two
 * numbers in a `5 // 2`-style expression) is ARITHMETIC/units (division), not
 * a filesystem path — real paths carry a name component (letters/guiones).
 * fb-52 (2026-09-02, QH filed as fb-53 — the guard arithmetic false positive):
 * a `/`-leading NUMERIC FRAGMENT WITH A SEPARATOR — `/1000,1` from a python
 * `round((dead-start)/1000,1)` heredoc, `/3.14`, `/1,000` — is ALSO arithmetic
 * (a division with a precision/rescale fragment, or a thousands-separated
 * number), NOT a path; it must not be tokenized into an out-of-scope DENIAL
 * (the QD series' first guard false positive: the real work was a python
 * heredoc, not an absolute-path reference). fb-53 (2026-09-02, QH — the SAME
 * family, residual shapes): the numeric fragment ALSO tolerates a TRAILING
 * separator (`/1000,` before a `)`/`;`/space — a python `round((x)/1000, 1)`
 * with a space after the comma tokenizes `/1000,`) and a trailing CLOSE-GLUE
 * `}`/`]` (awk/python `{…(a)/1000,1}`, a dict/f-string `{(a)/1000,1}`, a list
 * `[(a)/1000,1]` — the tokenizer's word class does not end at `}`/`]`), all
 * still ARITHMETIC inside heredocs/-c — NEVER a path. Multi-segment and
 * letter-bearing absolute words are STILL path words and are checked EXACTLY
 * as before. */
function deptExecIsPathWord(token: string): boolean {
  const rest = token.replace(/^\/+/, '')
  if (rest === '') return false
  // fb-10 (digits-only) + fb-52 (digits with a `.`/`,` separator fragment —
  // `1000`, `1000,1`, `1000.5`, `1,000`) + fb-53 (a TRAILING separator and/or
  // a closing `}`/`]` glued to the numeric fragment): pure numeric words are
  // arithmetic/units, never paths. A letter-bearing word is a real path
  // component (checked exactly as before).
  return !/^[0-9]+(?:[.,][0-9]+)*[.,]?[}\]]*$/.test(rest)
}

/** fb-10 (QH): mask the `$(( ... ))` arithmetic-expansion spans of a command
 * (balanced parens, incl. a NESTED `$((...))`) with spaces, so the path-word
 * scanner never reads the ARITHMETIC INTERNALS as absolute-path tokens (a
 * `/3600000` division or a `/ b` term inside `$((...))` is arithmetic, not a
 * path). Chars are replaced 1:1 with spaces — position-preserving — and a span
 * that never closes (an unterminated `$((` is NOT valid bash) is left
 * untouched, so a REAL `/`-word after a literal `$((` is NEVER hidden (a
 * `$((x))/etc/passwd` still yields a standalone path token for the scope
 * check). Masking with a WHITESPACE (the regex boundary class) is deliberate:
 * a real absolute path DIRECTLY after `))` keeps its own token boundary and
 * stays checked. */
function deptExecMaskArithmetic(command: string): string {
  const chars = String(command ?? '').split('')
  const n = chars.length
  let i = 0
  while (i < n - 2) {
    if (chars[i] === '$' && chars[i + 1] === '(' && chars[i + 2] === '(') {
      let depth = 2
      let j = i + 2
      let closed = false
      while (j < n) {
        const c = chars[j]
        if (c === '(') depth++
        else if (c === ')') {
          depth--
          if (depth === 0) {
            closed = true
            break
          }
        }
        j++
      }
      if (closed) {
        for (let k = i; k <= j; k++) chars[k] = ' '
        i = j + 1
      } else {
        i += 3
      }
    } else {
      i++
    }
  }
  return chars.join('')
}

/** The `/`-leading ABSOLUTE-path tokens in a command ("path words"): a token
 * beginning at `^` or a whitespace/metacharacter boundary, terminated by
 * whitespace or a shell metacharacter. `--opt=/a` is NOT matched (the `/` is
 * not at a word boundary) — only a word that STARTS with `/`. `>`/`<` count as
 * word boundaries so a redirect target with NO hyphen-space (`>/etc/foo`) and
 * an fd-redirect (`2>/etc/foo`) are BOTH scoped-path tokens — every
 * `>`/`<`-adjacent absolute path token is checked (the `/dev/null`-style sink
 * exemption is the explicit whitelist in `deptExecCanonicalToken`, NOT a
 * lexical digit-guard). The stable-profile token is handled by the dedicated
 * protected check. fb-10 (QH): the scan runs on the `$((...))`-MASKED command
 * (arithmetic internals are never path tokens) and a candidate word must pass
 * `deptExecIsPathWord` — `/`+digits-only and `//`-only words are DIVISIONS
 * (units), not paths, and are skipped; real letter-bearing/multi-segment
 * absolute words are extracted EXACTLY as before. */
function deptExecPathTokens(command: string): string[] {
  const tokens: string[] = []
  const cmd = deptExecMaskArithmetic(String(command ?? ''))
  const re = /(^|[\s|&;'`"()<>])(\/[^\s|&;'`"()<>]+)/g
  for (const match of cmd.matchAll(re)) {
    const boundary = match[1] as string
    const token = match[2]
    if (typeof token !== 'string' || token.length <= 1) continue
    // fb-10 (QH): a `/`+digits-only or `//`-only word (a division/units token,
    // e.g. `$((10-fails))/10`, `/3600000`, `//3600000`) is NOT a path.
    if (!deptExecIsPathWord(token)) continue
    tokens.push(token)
  }
  return tokens
}

/** The `/dev` device-sink tokens that are ALWAYS allowed by the abs-path scope
 * check — they are not paths under scope control (writing/reading `/dev/null`,
 * `/dev/stdout`, `/dev/stderr`, `/dev/zero`, `/dev/tty` is harmless and is the
 * common redirect target). Checked on the NORMALIZED literal, BEFORE any realpath
 * (realpath would collapse `/dev/stdout` → `/proc/…` and lose the match). */
const DEPT_EXEC_DEV_WHITELIST: ReadonlySet<string> = new Set([
  '/dev/null', '/dev/stdout', '/dev/stderr', '/dev/zero', '/dev/tty'
])

/** Shell metacharacters that make an absolute path token UNRESOLVABLE lexically
 * (an expansion, variable or glob: `$`, `*`, `?`, `[`, `{`, `~`, backtick,
 * quotes). Such a token cannot be normalized/realpath'd safely, so it STAYS
 * HEURISTIC (the raw token is used for the lexical containment check). */
const DEPT_EXEC_TOKEN_METACHAR = /[$*?\[{~`'"]/

/** The CANONICAL target an absolute path token contributes to the abs-path scope
 * check (spec §5.1 (d), token normalization): `path.posix.normalize(token)` and,
 * when the path EXISTS, `realpathSync` — so a `..`-escape or symlink cannot
 * smuggle an out-of-root or stable path past a lexical check. Returns the string
 * the scope checks run against:
 * - a token carrying a metachar/variable/glob → the RAW token (stays heuristic);
 * - a `/dev` sink in the whitelist → its NORMALIZED literal (always allowed,
 *   never realpath'd);
 * - otherwise the normalized path, upgraded to its realpath when it exists
 *   (tolerant: an unresolvable path falls back to the normalized form). */
function deptExecCanonicalToken(token: string): string {
  const t = String(token ?? '')
  // A token with a shell metachar/var/glob cannot be resolved → stay lexical.
  if (DEPT_EXEC_TOKEN_METACHAR.test(t)) return t
  const normalized = path.posix.normalize(t)
  // A whitelisted /dev sink is allowed verbatim (do NOT realpath it — the match
  // must be on the literal, not the `/proc/…` target it resolves to).
  if (DEPT_EXEC_DEV_WHITELIST.has(normalized)) return normalized
  if (existsSync(normalized)) {
    try {
      return realpathSync(normalized)
    } catch {
      return normalized
    }
  }
  return normalized
}

/** The PURE dept_exec scope guard. `cwd` and every entry of `allowedRoots`
 * must already be REALPATH-resolved (the tool resolves them before calling).
 * Returns an out-of-scope deny reason string when the command/cwd must NOT run,
 * or `undefined` when EVERY check passes (the command may execute). Checks, in
 * order: (1) the resolved cwd is inside an allowed root; (2) denylist
 * substring (case-insensitive, with `systemctl` removed to a dedicated
 * carve-out); (2b) `systemctl` — ONLY the single READ-ONLY
 * `systemctl is-active <unit>` form is permitted, every MUTATING systemctl
 * form (start/stop/restart/enable/disable/daemon-reload/mask/…) is DENIED;
 * (2c) the ROOT-WIPE `rm -rf /` — fb-62 (IPH — token-guard refinement): the
 * deny fires ONLY when the destination is the COMPLETE root `/` (end of
 * command / whitespace / shell boundary after the slashes — `isRmRfRootWipe`),
 * NEVER a scoped `rm -rf <path-under-a-root>` cleanup (the real-path scope
 * check (4) governs scoped targets: in-root ALLOWED, out-of-root DENIED);
 * (3) a boundary-aware `/opt/dsh/.dsh` token in command OR cwd → the stable
 * profile is protected (its `-dev` sibling is NOT denied), UNLESS a
 * MISSION-LEVEL owner grant (`org.missionExecRoots`/`org.execRoots`) named the
 * stable home as an allowed root (the stable token is bypassed ONLY for that
 * granted root — never silently, never for an ungranted reference);
 * (4) every `/`-leading absolute path token in the command is under an allowed
 * root — each token is FIRST canonicalized (`deptExecCanonicalToken`), and the
 * stable + containment checks run on the canonical target, so a
 * `..`-escape/symlink to an out-of-root or stable path is denied and a `/dev`
 * sink in the whitelist is always allowed. fb-10 (QH): the token scan masks
 * `$((...))` arithmetic internals and skips `/`+digits-only / `//`-only words
 * (division/units — e.g. `$((10-fails))/10`, `/3600000`, `//3600000` — are NOT
 * paths); fb-52/fb-53 (QH — the guard arithmetic false-positive family): a
 * `/`+NUMERIC word with a `.`/`,` separator fragment — `/1000,1`, `/3.14`,
 * `/1,000`, incl. a TRAILING separator `/1000,` and a close-glue `/1000,1}` /
 * `/1000}` / `/1000,1]` (heredoc/-c/awk arithmetic) — is ALSO NOT a path;
 * real letter-bearing/multi-segment absolute words are checked exactly
 * as before (access preserved, out-of-root paths still denied). */
export function deptExecDenyReason(command: string, cwd: string, allowedRoots: readonly string[]): string | undefined {
  const cmd = String(command ?? '').trim()
  const roots = allowedRoots.filter((r) => typeof r === 'string' && r !== '')
  // A MISSION-LEVEL owner grant (an allowed root NAMING the stable home) — the
  // stable-token protection is bypassed ONLY for a root this grant names.
  const stableHomeGranted = isStableHomeGranted(roots)
  // (1) the resolved cwd must be inside an allowed root (realpath equality).
  if (!roots.some((root) => isPathInside(cwd, root))) {
    return `OUT_OF_SCOPE / DENIED — cwd "${cwd}" is not inside a scoped dept_exec root (escalate via the Asistente / owner approval)`
  }
  // (2) denylist (case-insensitive substring). Runs BEFORE the systemctl
  // carve-out so a mutating token (sudo/reboot/…) is still denied even if the
  // command also contains a read-only `systemctl is-active`.
  const lower = cmd.toLowerCase()
  for (const bad of DEPT_EXEC_DENYLIST) {
    if (lower.includes(bad)) {
      return `OUT_OF_SCOPE / DENIED — command contains a denied token "${bad}" (escalate via the Asistente / owner approval)`
    }
  }
  // (2b) systemctl — ONLY the read-only `systemctl is-active <unit>` form is
  // permitted; every mutating systemctl form stays DENIED (the Asistente/owner
  // owns those). The denylist already ran, so a mutating token is caught above.
  if (lower.includes('systemctl') && !isReadOnlySystemctl(cmd)) {
    return 'OUT_OF_SCOPE / DENIED — command contains a denied systemctl form (only the read-only `systemctl is-active <unit>` is permitted; mutating forms are the Asistente/owner\'s)'
  }
  // (2c) fb-62 (IPH — token-guard refinement): the ROOT-WIPE `rm -rf /` — the
  // legacy loose denylist substring over-blocked every SCOPED cleanup (`rm -rf
  // /root/.deepartments/…`, `rm -rf /home/esuarez/projects/…` — in-root
  // targets, exactly the legitimate `rm -rf <tmp>/buga` hygiene class). The
  // deny now fires ONLY when the destination is the COMPLETE root `/` (end of
  // command / whitespace / shell boundary after the slashes); a `/`-prefixed
  // REAL path destination is NOT this token — it is governed by the real-path
  // scope check (4) below (in-root ALLOWED, out-of-root DENIED) and by the
  // stable-protected check (3) for `/opt/dsh/.dsh`.
  if (isRmRfRootWipe(cmd)) {
    return 'OUT_OF_SCOPE / DENIED — command contains a denied token "rm -rf /" (escalate via the Asistente / owner approval)'
  }
  // (3) the stable profile is protected — the boundary-aware token (a whole
  // path component; `/opt/dsh/.dsh-dev` is NOT stable) → explicit owner approval.
  // Bypassed ONLY when a mission-level owner grant named the stable home.
  if ((isStablePath(cmd) || isStablePath(cwd)) && !stableHomeGranted) {
    return 'OUT_OF_SCOPE / DENIED — the stable profile is protected — requires explicit owner approval via the Asistente'
  }
  // (4) every `/`-leading absolute path token must be under an allowed root.
  // Each token is FIRST canonicalized (normalize + realpath when it exists) so a
  // `..`-escape or symlink cannot smuggle an out-of-root/stable path past a
  // lexical check; a `/dev` sink in the whitelist is always allowed (not a path
  // under scope control); the stable and containment checks run on the target.
  for (const token of deptExecPathTokens(cmd)) {
    const target = deptExecCanonicalToken(token)
    // `/dev/null` & friends are always allowed — not paths under scope control.
    if (DEPT_EXEC_DEV_WHITELIST.has(target)) continue
    // The stable-profile token, applied to the CANONICAL target — a normalized
    // `..`-escape to `/opt/dsh/.dsh/…` must NOT slip past the boundary check.
    // Bypassed ONLY when a mission-level owner grant named the stable home.
    if (isStablePath(target) && !stableHomeGranted) {
      return 'OUT_OF_SCOPE / DENIED — the stable profile is protected — requires explicit owner approval via the Asistente'
    }
    if (!roots.some((root) => isPathInside(target, root))) {
      return `OUT_OF_SCOPE / DENIED — command references absolute path "${token}" outside a scoped dept_exec root (escalate via the Asistente / owner approval)`
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// dept_zstd_read (E2 — session .zstd reading without dept_exec, QH 2026-08-28):
// the READ-ONLY zstd-decode tool for department posts whose role DECLARES
// `dept_exec` (the same allowExec gate — the tool rides the dept_exec role
// allow-list registered on the post's OWN layer). It decodes ONE
// `.zstd`-compressed file (e.g. a raw `.jsonl.zstd` session artifact) via
// `zstd -dc` Node-side (child_process.execFile — NO user shell), SÓLO
// LECTURA, with the SAME scope policy as dept_exec: the resolved path must be
// inside the allowed roots, the `/dev` sinks + the stable profile protection
// apply, and the output is BOUNDED (a line cap + a chunk cap — never hangs on
// / buffers a huge session). The deny guard below is the PURE module helper
// (unit-testable like deptExecDenyReason); the tool runs realpath + the
// bZstdRead bounded decode around it. The tool exists because a .zstd session
// read via `dept_exec` burns a full shell command + a full bash exec per read
// (the QD/IPD dept_exec volume class); a scoped streaming decode covers
// 60-95% of those reads WITHOUT shell.
// ---------------------------------------------------------------------------

/** The dept_zstd_read line cap for a single call (bounded output — a session
 * log read is a WINDOW, never the whole artifact). */
export const DEPT_ZSTD_READ_MAX_LINES = 500
/** The per-line length cap (a single over-long JSONL line is truncated with a
 * marker — a corrupt/single-line giant artifact cannot blow the render). */
export const DEPT_ZSTD_READ_MAX_LINE_CHARS = 4000
/** Decode timeout for ONE zstd -dc run (a stuck/deadlocked zstd is killed —
 * never hangs the tool). */
export const DEPT_ZSTD_READ_TIMEOUT_MS = 30000
/** The decompressed-BYTES budget for one call (fb-19, QH backlog: a >4MB
 * session — the b29 archive itself was 4.54MB — previously blew the execFile
 * `maxBuffer` with a RAW 'stdout maxBuffer length exceeded' error). The decode
 * is now STREAMED (`zstd -dc` via spawn — no full-buffered decode): bytes are
 * counted on the fly and a session beyond this budget is aborted with a CLEAR
 * error («session exceeds the zstd-read budget — use dept_exec for full
 * streaming»), never a raw maxBuffer exception. 32MB covers the real session
 * class (~4-5MB) with headroom while keeping one call bounded. The name keeps
 * the legacy CHARS spelling (R6 — exported + imported by tests; it is a BYTE
 * budget). */
export const DEPT_ZSTD_READ_MAX_CHARS = 32 * 1024 * 1024

/** The PURE dept_zstd_read scope guard. `resolvedPath` must already be
 * realpath-resolved (the tool resolves it before calling) and `allowedRoots`
 * realpath-resolved (the same deptExecAllowedRoots set). Returns an
 * out-of-scope deny reason when the path must NOT be read, or `undefined` when
 * the read may proceed. Checks, mirroring dept_exec §5: (1) the resolved path
 * is inside an allowed root; (2) the stable profile is protected (a
 * `/opt/dsh/.dsh…` path → protected deny, UNLESS a MISSION-LEVEL owner grant
 * named the stable home). No command tokens exist here (a path is not a
 * command) — the path containment + stable checks are the full scope policy. */
export function deptZstdReadDenyReason(resolvedPath: string, allowedRoots: readonly string[]): string | undefined {
  const roots = allowedRoots.filter((r) => typeof r === 'string' && r !== '')
  const stableHomeGranted = isStableHomeGranted(roots)
  // (1) the stable profile is protected — the boundary-aware token (a whole
  // path component; `/opt/dsh/.dsh-dev` is NOT stable). Checked FIRST (before
  // containment — exactly like dept_exec's token loop, where the stable token
  // beats the containment reason for a stable path): a stable-home path is
  // DENIED with the explicit protected reason. Bypassed ONLY when a
  // MISSION-LEVEL owner grant named the stable home.
  if (isStablePath(resolvedPath) && !stableHomeGranted) {
    return 'OUT_OF_SCOPE / DENIED — the stable profile is protected — requires explicit owner approval via the Asistente'
  }
  // (2) the resolved path must be inside an allowed root (realpath equality —
  // a `..`-escape/symlink resolves to its target BEFORE the guard runs).
  if (!roots.some((root) => isPathInside(resolvedPath, root))) {
    return `OUT_OF_SCOPE / DENIED — path "${resolvedPath}" is not inside a scoped dept_exec root (escalate via the Asistente / owner approval)`
  }
  return undefined
}

/** Decode ONE zstd-compressed file through `zstd -dc` (Node-side
 * child_process.spawn — no user shell, sanitized env) with a STREAMED, bounded
 * output (fb-19): stdout chunks are parsed ON THE FLY — complete
 * newline-bounded lines are counted and only the requested line WINDOW
 * [offset, offset+lines) is retained in memory, each line truncated to
 * DEPT_ZSTD_READ_MAX_LINE_CHARS. ZERO full-decode buffering: the total decoded
 * bytes are counted as chunks arrive and a session beyond
 * DEPT_ZSTD_READ_MAX_CHARS is aborted (decode killed) with a CLEAR budget error
 * — a >4MB session (the b29 4.54MB class) streams fine, and a huge one never
 * surfaces the raw execFile 'stdout maxBuffer length exceeded' exception nor
 * buffers unbounded memory. The decode is killed on DEPT_ZSTD_READ_TIMEOUT_MS.
 * Returns {ok, lines, truncated, totalLines, error?} — a decode failure /
 * budget breach is a normal ok:false result, never a throw (the caller decides
 * the surface). */
export async function runDeptZstdRead(
  path: string,
  offset: number,
  lines: number
): Promise<{ ok: boolean; lines: string[]; truncated: boolean; totalLines: number; error?: string }> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/root',
    LANG: process.env.LANG ?? 'C'
  }
  return new Promise((resolve) => {
    const child = spawn('zstd', ['-dc', path], { env })
    // `carry` holds the INCOMPLETE tail of the current line (the bytes after
    // the last 0x0A) — the cut is BYTE-level, so a multi-byte UTF-8 codepoint
    // is never split across chunk boundaries and the tail decodes cleanly when
    // the next chunk (or the final carry) is parsed.
    let carry: Buffer = Buffer.alloc(0)
    let totalBytes = 0
    let lineCount = 0
    let stderrOut = ''
    let settled = false
    const wanted: string[] = []
    const windowEnd = offset + lines
    const settle = (result: { ok: boolean; lines: string[]; truncated: boolean; totalLines: number; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // never leave a decoding child behind (budget breach / timeout / failure)
      if (child.exitCode === null && !child.killed) child.kill()
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      settle({
        ok: false,
        lines: [],
        truncated: false,
        totalLines: 0,
        error: `zstd decode timed out after ${DEPT_ZSTD_READ_TIMEOUT_MS}ms`
      })
    }, DEPT_ZSTD_READ_TIMEOUT_MS)
    // Count one complete line; retain it only when it falls inside the window.
    const pushLine = (lineBytes: Buffer): void => {
      const idx = lineCount++
      if (idx >= offset && wanted.length < lines) {
        const line = lineBytes.toString('utf8')
        wanted.push(line.length > DEPT_ZSTD_READ_MAX_LINE_CHARS ? `${line.slice(0, DEPT_ZSTD_READ_MAX_LINE_CHARS)}… [line truncated]` : line)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buf.length
      // The budget is checked BEFORE any parse — an over-budget session is
      // aborted with the CLEAR error, never a raw maxBuffer exception.
      if (totalBytes > DEPT_ZSTD_READ_MAX_CHARS) {
        settle({
          ok: false,
          lines: [],
          truncated: false,
          totalLines: 0,
          error: `session exceeds the zstd-read budget (${DEPT_ZSTD_READ_MAX_CHARS} decompressed bytes) — use dept_exec for full streaming`
        })
        return
      }
      const merged = carry.length > 0 ? Buffer.concat([carry, buf]) : buf
      const lastNl = merged.lastIndexOf(0x0A)
      carry = lastNl === -1 ? merged : Buffer.from(merged.subarray(lastNl + 1))
      if (lastNl === -1) return
      const complete = merged.subarray(0, lastNl)
      let start = 0
      for (let i = 0; i <= complete.length; i++) {
        if (i === complete.length || complete[i] === 0x0A) {
          pushLine(complete.subarray(start, i))
          start = i + 1
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return
      stderrOut += chunk.toString('utf8')
    })
    child.on('error', (err: unknown) => {
      settle({
        ok: false,
        lines: [],
        truncated: false,
        totalLines: 0,
        error: `zstd -dc failed to start: ${err instanceof Error ? err.message : String(err)}`
      })
    })
    // 'close' fires after the stdio streams drained — the final, authoritative
    // completion point (settles AFTER the timeout/budget/error paths guard).
    child.on('close', (code: number | null) => {
      if (settled) return
      if (code !== 0) {
        const stderrDetail = stderrOut.trim()
        settle({
          ok: false,
          lines: [],
          truncated: false,
          totalLines: 0,
          error: stderrDetail !== '' ? stderrDetail : `zstd -dc exited with code ${code}`
        })
        return
      }
      // Success: a final line WITHOUT a trailing newline is a real line (a
      // session ending in 0x0A leaves an EMPTY carry → not counted, exactly
      // like the legacy split+pop of the artifact terminator).
      if (carry.length > 0) pushLine(carry)
      settle({ ok: true, lines: wanted, truncated: lineCount > windowEnd, totalLines: lineCount })
    })
  })
}

// (cron scheduler engine MOVED to packages/dshd-jobs — see the dshd-jobs phase
// note above; the CronSchedule type + parseCronSchedule/cronMatches/nextCronFire/
// cronIsDue/CRON_DESYNC_WINDOW_MIN are now imported + re-exported from
// ./core/jobs.js.)

// (job-definition reader MOVED to packages/dshd-jobs — see the dshd-jobs phase
// note above; unwrapQuotedScalar/parseJobDefFrontmatter/jobDirFor/
// readJobDefinitionFile/readAgendaJobs + JobDefParsed/AgendaJobItem are now
// imported + re-exported from ./core/jobs.js.)

// ---------------------------------------------------------------------------
// W8-c DISCRETE FOLLOW-UP (scheduler auto-run visibility) — the agenda-scheduler
// auto-run path's failures are INVISIBLE today (the pure tick folds a no-fire
// into a warn that is not visible in service logs). This SINK records a
// scheduler auto-run no-fire into post-errors.jsonl (postId 'scheduler',
// message = the jobId + the reason) so the W6 health daemon ALERTS the host,
// DEDUPED by health-alerts-state.json (key `scheduler:<jobId>:<reason>`) so a
// real no-fire is recorded ONCE per HEALTH_DEDUPE_WINDOW_MS (do NOT double-record
// the same no-fire on consecutive ticks — the point is that a real no-fire
// surfaces as an alert, not that it wins a race). Pure: `now()` is injectable so
// a tick test is deterministic.
// ---------------------------------------------------------------------------

// (SchedulerAutoRunFinding + normalizeSchedulerAutoRunReason +
// schedulerAutoRunKey MOVED to packages/dshd-jobs — the pure tick + W8-c
// scheduler-visibility helpers; the bundle imports the latter two for the
// captureSchedulerAutoRunFailure sink below, from ./core/jobs.js.)

/** Record ONE scheduler auto-run no-fire into post-errors.jsonl (postId
 * 'scheduler', the message = the jobId + the reason/cause) so the W6 health
 * daemon ALERTS the host. DEDUPED by health-alerts-state.json (key
 * `scheduler:<jobId>:<reason>`) so a real no-fire is recorded ONCE per
 * HEALTH_DEDUPE_WINDOW_MS and never spams consecutive ticks. Never throws (a
 * persist failure is a warn). Resolves TRUE when a new row was appended, FALSE
 * when it was deduped inside the window. */
export async function captureSchedulerAutoRunFailure(opts: {
  /** The stateDir holding post-errors.jsonl + health-alerts-state.json. */
  stateDir: string
  /** The clock (ms epoch) — injectable so a tick test is deterministic. */
  now(): number
  /** The job id that did not fire. */
  jobId: string
  /** The no-fire reason: 'no head' | 'idempotency-skip' | the thrown error text. */
  reason: string
  /** Optional extra detail (the thrown error text) folded into the recorded
   * message when it differs from `reason`. */
  error?: string
  /** Optional warn-capable logger. */
  logger?: { warn(message: string): void }
}): Promise<boolean> {
  const normalizedReason = normalizeSchedulerAutoRunReason(opts.reason)
  const key = schedulerAutoRunKey(opts.jobId, normalizedReason)
  try {
    const nowMs = opts.now()
    const state = readHealthAlertsState(opts.stateDir)
    const last = state[key]
    if (last !== undefined && nowMs - last < HEALTH_DEDUPE_WINDOW_MS) return false
    const errorText = `job "${opts.jobId}" scheduler auto-run no-fire: ${normalizedReason}${opts.error !== undefined && opts.error !== normalizedReason ? ` (${opts.error})` : ''}`
    // The recording clock is passed as the append's window clock (C9): the row
    // was just captured as fresh, so it can never be discarded at append.
    await appendPostError(opts.stateDir, {
      ts: nowMs,
      postId: 'scheduler',
      error: errorText,
      jobId: opts.jobId,
      reason: normalizedReason
    }, nowMs)
    state[key] = nowMs
    await writeHealthAlertsState(opts.stateDir, state)
    return true
  } catch (error: unknown) {
    opts.logger?.warn(`[deepartments] scheduler: auto-run capture for job "${opts.jobId}" failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

// (the W1 agenda scheduler tick + its deps type MOVED to packages/dshd-jobs —
// see the dshd-jobs phase note above; AgendaSchedulerDeps/runAgendaSchedulerTick
// are now imported + re-exported from ./core/jobs.js. The PRODUCTION daemon
// (below) binds the live registries onto the pure tick's deps.)


// ---- W3b parallel-monitor (Parallel Web Systems event_stream monitors) ------
// An event-AMBIENT monitor (Parallel) is polled by a plugin daemon (no public
// URL, no webhook — the researcher report 2026-08-23 recommends POLLING): each
// new net-new event spawns a RESEARCHER directly (through the SAME worker-spawn
// engine the head uses) and notifies the Research head (owner decision: "cada
// vez que se active un researcher también se tiene que activar su RH"). The
// pure half (config resolution + state helpers + the tick) is module-level so
// the tests exercise it deterministically with a fixed clock + stubbed hooks.

// The ParallelConfig/ParallelMonitorConfig types are declared in org.ts (the
// configuration module); invoke.ts imports them and keeps only the runtime
// resolver + the code defaults below.

/** The DEV default monitors (owner decision 2026-08-23: 2× `base`, `1d`). */
export const DEFAULT_PARALLEL_MONITORS: readonly ParallelMonitorConfig[] = [
  { id: 'ai-industry-news', query: 'AI industry news releases/announcements (new models, benchmarks, services, harness software)', processor: 'base', frequency: '1d' },
  { id: 'deepseek-dsh-news', query: 'DeepSeek or DSH (DeepSeek Harness) news/releases', processor: 'base', frequency: '1d' }
]

/** Resolve the effective monitors from the raw `parallel` config section:
 * an ABSENT section (or a missing `monitors` key) → the CODE DEFAULT (2);
 * an EXPLICIT empty array → [] (monitoring disabled); a non-empty array → the
 * configured monitors verbatim. */
export function resolveParallelMonitorConfig(parallel: ParallelConfig | undefined): ParallelMonitorConfig[] {
  if (parallel === undefined || parallel.monitors === undefined) return [...DEFAULT_PARALLEL_MONITORS]
  return parallel.monitors
}

/** One persisted monitor runtime state (`<stateDir>/parallel-monitors-state.json`). */
export interface ParallelMonitorState {
  monitorId?: string
  /** The last consumed `next_cursor` (newest-first poll cursor). */
  cursor?: string
  lastPolledAt?: number
  lastFiredAt?: number
  /** Events counted in the last poll (tracability for dept_monitor_list). */
  lastEventCount?: number
  /** Bounded seen-event-id list (dedup across a re-returned cursor boundary). */
  seenEventIds?: string[]
}

export interface ParallelMonitorsState {
  monitors: Record<string, ParallelMonitorState>
}

function parseParallelMonitorState(value: unknown): ParallelMonitorState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  const out: ParallelMonitorState = {}
  if (typeof entry.monitorId === 'string') out.monitorId = entry.monitorId
  if (typeof entry.cursor === 'string') out.cursor = entry.cursor
  if (typeof entry.lastPolledAt === 'number' && Number.isFinite(entry.lastPolledAt)) out.lastPolledAt = entry.lastPolledAt
  if (typeof entry.lastFiredAt === 'number' && Number.isFinite(entry.lastFiredAt)) out.lastFiredAt = entry.lastFiredAt
  if (typeof entry.lastEventCount === 'number' && Number.isFinite(entry.lastEventCount)) out.lastEventCount = entry.lastEventCount
  if (Array.isArray(entry.seenEventIds)) {
    out.seenEventIds = entry.seenEventIds.filter((id): id is string => typeof id === 'string').slice(-100)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Read `<stateDir>/parallel-monitors-state.json`. Absent, unreadable or
 * malformed → `{ monitors: {} }` (never throws — mirrors the other readers). */
export function readParallelMonitorsState(stateDir: string): ParallelMonitorsState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, 'parallel-monitors-state.json'), 'utf8')) as { monitors?: unknown }
    if (parsed !== null && typeof parsed === 'object' && parsed.monitors !== null && typeof parsed.monitors === 'object') {
      const monitors: Record<string, ParallelMonitorState> = {}
      for (const [key, value] of Object.entries(parsed.monitors as Record<string, unknown>)) {
        const state = parseParallelMonitorState(value)
        if (state !== undefined) monitors[key] = state
      }
      return { monitors }
    }
    return { monitors: {} }
  } catch {
    return { monitors: {} }
  }
}

/** Write `<stateDir>/parallel-monitors-state.json` (mkdir -p the dir, then the file). */
export async function writeParallelMonitorsState(stateDir: string, state: ParallelMonitorsState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, 'parallel-monitors-state.json')), { recursive: true })
  await writeFile(path.join(stateDir, 'parallel-monitors-state.json'), JSON.stringify(state), 'utf8')
}

/** A detected monitor event (GET /v1/monitors/{id}/events → events[]). */
export interface ParallelMonitorEvent {
  event_id: string
  event_group_id?: string
  event_date?: string
  event_type?: string
  output?: { type?: string; content?: string; basis?: unknown[] }
}

/** Freshness gate (the first-cursor design choice, see the builder report): an
 * event whose `event_date` is newer than this (from now) is "fresh" and IS fired
 * even on a monitor's FIRST poll (no cursor yet); older backfill is recorded
 * (the cursor advances) but NOT fired — the first run never spams. */
export const PARALLEL_FRESH_WINDOW_MS = 48 * 60 * 60 * 1000

function isParallelEventFresh(event: ParallelMonitorEvent, nowMs: number): boolean {
  const dateRaw = event.event_date
  if (typeof dateRaw !== 'string' || dateRaw === '') return true // can't judge → surface it
  const t = Date.parse(dateRaw)
  if (Number.isNaN(t)) return true
  return nowMs - t <= PARALLEL_FRESH_WINDOW_MS
}

/** Injected hooks + inputs one parallel-monitor tick reads. Mirrors
 * AgendaSchedulerDeps: the PRODUCTION wiring binds the live registries
 * (resolve department/head, spawn via spawnWorkerForDepartment, notify via the
 * bus seam); tests construct it with a FIXED clock + stubbed HTTP/spawn/notify. */
export interface ParallelMonitorDeps {
  /** The clock (ms epoch) — injectable so a tick test is deterministic. */
  now(): number
  /** The stateDir whose `parallel-monitors-state.json` the tick reads/writes. */
  stateDir: string
  /** Every configured monitor to poll (already resolved — defaults filled). */
  monitors: ParallelMonitorConfig[]
  /** The Parallel API key (`x-api-key`). */
  apiKey: string
  /** The Parallel base URL (default https://api.parallel.ai). */
  baseUrl: string
  /** Max LIVE worker-researchers per monitor (the storm guard). */
  maxConsecutiveSpawns: number
  /** POST /v1/monitors — create the monitor on Parallel (returns monitor_id). */
  createMonitor(monitor: ParallelMonitorConfig): Promise<{ monitorId: string }>
  /** GET /v1/monitors/{id}/events poll (cursor → only-new). */
  fetchEvents(monitorId: string, cursor: string | undefined): Promise<{ events: ParallelMonitorEvent[]; nextCursor?: string }>
  /** Spawn the worker-researcher for ONE detected event (never throws). */
  spawnResearcher(monitor: ParallelMonitorConfig, event: ParallelMonitorEvent): Promise<{ workerId: string }>
  /** Fire-and-forget "a worker is working" notice to the research head. */
  notifyHead(monitor: ParallelMonitorConfig, event: ParallelMonitorEvent, workerId: string): Promise<void>
  /** Live (non-retired) workers of this monitor — the storm-guard count. */
  liveWorkerCount(monitorId: string): number
  /** Optional warn-capable logger (absent dep → the warn is dropped). */
  logger?: { warn(message: string): void }
}

/** ONE parallel-monitor tick: for each configured monitor — (a) create it on
 * Parallel if it has no monitor_id yet (a POST failure → warn + skip); (b) poll
 * events (cursor → only-new; a fetch failure → warn + skip); (c) for each NEW
 * event, spawn a researcher (freshness-gated on the first run, storm-guarded by
 * the live worker count) and notify the head — each exactly ONCE; (d) advance
 * the cursor + persist. NEVER throws (every internal failure is a warn). */
export async function runParallelMonitorTick(deps: ParallelMonitorDeps): Promise<void> {
  try {
    const nowMs = deps.now()
    const state = readParallelMonitorsState(deps.stateDir)
    let changed = false
    for (const monitor of deps.monitors) {
      const key = monitor.id
      const entry = state.monitors[key] ?? (state.monitors[key] = {})
      // (a) ensure the monitor exists on Parallel (create once + persist the id).
      if (entry.monitorId === undefined) {
        try {
          const created = await deps.createMonitor(monitor)
          entry.monitorId = created.monitorId
          changed = true
        } catch (error: unknown) {
          deps.logger?.warn(`[deepartments] parallel-monitor: create monitor "${key}" failed: ${error instanceof Error ? error.message : String(error)} — skip`)
          continue
        }
      }
      // (b) poll events (cursor → only-new). A fetch error never throws.
      let events: ParallelMonitorEvent[] = []
      let nextCursor: string | undefined
      try {
        const fetched = await deps.fetchEvents(entry.monitorId, entry.cursor)
        events = fetched.events ?? []
        nextCursor = fetched.nextCursor
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] parallel-monitor: poll "${key}" failed: ${error instanceof Error ? error.message : String(error)} — skip`)
        continue
      }
      const seen = new Set(entry.seenEventIds ?? [])
      // `live` is the storm-guard count read once, then incremented after EACH
      // successful spawn so a single page of events can never blow past the cap
      // within one tick (the reviewer hardening). Only a CONFIRMED spawn (not a
      // failed one) advances it.
      let live = deps.liveWorkerCount(key)
      for (const event of events) {
        if (event == null || typeof event.event_id !== 'string' || event.event_id === '') continue
        if (seen.has(event.event_id)) continue // idempotent: an already-seen event → nothing
        // First-run freshness gate: on the monitor's FIRST poll (no cursor yet)
        // fire ONLY fresh (≤48h) events; older backfill is recorded, not fired.
        if (entry.cursor === undefined && !isParallelEventFresh(event, nowMs)) {
          seen.add(event.event_id)
          continue
        }
        // Storm guard: never exceed maxConsecutiveSpawns LIVE researchers. Once
        // `live` reaches the cap the remaining page events are SKIPPED (the
        // break) — but the cursor still advances (below), so they are consumed
        // rather than re-fetched (the documented storm-guarded-consumption
        // semantics).
        if (live >= deps.maxConsecutiveSpawns) {
          deps.logger?.warn(`[deepartments] parallel-monitor: monitor "${key}" already has ${live} live workers ≥ ${deps.maxConsecutiveSpawns} — skip (storm guard)`)
          break
        }
        try {
          const spawned = await deps.spawnResearcher(monitor, event)
          try {
            await deps.notifyHead(monitor, event, spawned.workerId)
          } catch (error: unknown) {
            deps.logger?.warn(`[deepartments] parallel-monitor: notify head for "${key}" event ${event.event_id} failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          entry.lastFiredAt = nowMs
          live += 1 // a successful spawn counts toward the live cap
        } catch (error: unknown) {
          deps.logger?.warn(`[deepartments] parallel-monitor: spawn for "${key}" event ${event.event_id} failed: ${error instanceof Error ? error.message : String(error)} — skip`)
        }
        seen.add(event.event_id)
      }
      if (nextCursor !== undefined) entry.cursor = nextCursor
      entry.lastPolledAt = nowMs
      entry.lastEventCount = events.length
      entry.seenEventIds = [...seen].slice(-100)
      changed = true
    }
    if (changed) await writeParallelMonitorsState(deps.stateDir, state)
  } catch (error: unknown) {
    deps.logger?.warn(`[deepartments] parallel-monitor tick failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The deps ONE parallel-monitor daemon tick needs, PLUS the LAZY
 * department/head resolution. Mirrors ParallelMonitorDeps (the pure tick) but
 * moves the department/head target OUT of the tick into a lazy accessor that is
 * RE-EVALUATED on every tick. The production wiring registers the daemon effect
 * unconditionally (once an API key + monitors are present) and re-resolves the
 * target per tick, so the boot race where the posts registry (`byPost`) is still
 * empty when the effect is registered can NEVER permanently disable the daemon. */
export interface ParallelMonitorDaemonDeps {
  /** The Parallel base URL (surfaced in the one-shot "enabled" log). */
  baseUrl: string
  /** Max LIVE worker-researchers per monitor (the storm guard). */
  maxConsecutiveSpawns: number
  /** Every configured monitor to poll (already resolved — defaults filled). */
  monitors: ParallelMonitorConfig[]
  /** The stateDir whose `parallel-monitors-state.json` the tick reads/writes. */
  stateDir: string
  /** The clock (ms epoch) — injectable so a tick test is deterministic. */
  now(): number
  /** The configured departments (from org.departments). */
  departments: DepartmentConfig[]
  /** The live post registry. Read LAZILY on each tick (the boot race — the
   * registry may still be empty when the daemon effect is registered). */
  byPost: Map<string, PostEntry>
  /** Per-tick logger: warn for a no-target skip / errors, info one-shot on the
   * first enabled tick. */
  logger: { warn(message: string): void; info(message: string): void }
  /** POST /v1/monitors — create the monitor on Parallel (returns monitor_id). */
  createMonitor(monitor: ParallelMonitorConfig): Promise<{ monitorId: string }>
  /** GET /v1/monitors/{id}/events poll (cursor → only-new). */
  fetchEvents(monitorId: string, cursor: string | undefined): Promise<{ events: ParallelMonitorEvent[]; nextCursor?: string }>
  /** Live (non-retired) workers of this monitor — the storm-guard count. */
  countWorkers(monitorId: string): number
  /** Spawn the researcher via the SAME worker-spawn engine a head uses (sets the
   * task/title/jobId; the target department/head flow in as the resolved ones). */
  spawnWorker(department: DepartmentConfig, head: PostEntry, opts: { role: string; task: string; title: string; jobId: string; callerAgentId: string; senderSessionId: string }): Promise<{ workerId: string }>
  /** Fire-and-forget "a worker is working" notice to the research head. */
  notifyHead(head: PostEntry, monitor: ParallelMonitorConfig, event: ParallelMonitorEvent, workerId: string): Promise<void>
}

/** Build the parallel-monitor daemon's per-tick runner with a LAZY
 * department/head target. Returns the `tick` so a test drives it directly (the
 * production wiring wraps it in setInterval under a reversible effect). On each
 * tick the target is RE-RESOLVED: while no research department/head is
 * registered yet the tick emits ONE discreet warn and SKIPS (the daemon is NOT
 * disabled — it retries on the next tick); once a target is available it emits
 * ONE "N monitor(s) enabled…" info and runs the normal create/poll/spawn/notify
 * flow (the pure runParallelMonitorTick). */
export function createParallelMonitorDaemon(deps: ParallelMonitorDaemonDeps): { tick(): Promise<void> } {
  const resolveTarget = (): { department: DepartmentConfig; headEntry: PostEntry } | void => {
    const department = deps.departments.find((d) => d.id === 'research')
      ?? deps.departments.find((d) => d.coordinator !== void 0)
    const headEntry = department?.coordinator !== void 0
      ? deps.byPost.get(department.coordinator.postId)
      : void 0
    if (department === void 0 || headEntry === void 0) return void 0
    return { department, headEntry }
  }
  const monitorQueryShort = (query: string): string => {
    const trimmed = query.trim()
    return trimmed.length > 40 ? `${trimmed.slice(0, 37).trimEnd()}...` : trimmed
  }
  const buildMonitorBrief = (monitor: ParallelMonitorConfig, event: ParallelMonitorEvent): string =>
    [
      `[parallel-monitor] A monitor event was detected (monitor "${monitor.id}", query "${monitor.query}").`,
      '',
      event.output?.content !== undefined ? event.output.content : JSON.stringify(event),
      '',
      'Verify and investigate this item, then report to your head with a concise memo and write the report to reports/researcher/ so the Research Department record stays durable.'
    ].join('\n')
  let warnedNoTarget = false
  let enabledLogged = false
  const tick = async (): Promise<void> => {
    const target = resolveTarget()
    if (target === void 0) {
      if (!warnedNoTarget) {
        warnedNoTarget = true
        deps.logger.warn('[deepartments] parallel-monitor: no research department / head to spawn monitor workers under — monitoring waiting (retries on the next tick)')
      }
      return
    }
    if (!enabledLogged) {
      enabledLogged = true
      deps.logger.info(`[deepartments] parallel-monitor: ${deps.monitors.length} monitor(s) enabled (department "${target.department.id}", head "${target.headEntry.postId}", baseUrl ${deps.baseUrl})`)
    }
    await runParallelMonitorTick({
      now: deps.now,
      stateDir: deps.stateDir,
      monitors: deps.monitors,
      apiKey: '',
      baseUrl: deps.baseUrl,
      maxConsecutiveSpawns: deps.maxConsecutiveSpawns,
      createMonitor: deps.createMonitor,
      fetchEvents: deps.fetchEvents,
      liveWorkerCount: deps.countWorkers,
      spawnResearcher: async (monitor, event) =>
        deps.spawnWorker(target.department, target.headEntry, {
          role: 'researcher',
          task: buildMonitorBrief(monitor, event),
          title: `Researcher: Monitor: ${monitorQueryShort(monitor.query)}`,
          jobId: monitor.id,
          callerAgentId: target.headEntry.sessionId,
          senderSessionId: target.headEntry.sessionId
        }),
      notifyHead: async (monitor, event, workerId) =>
        deps.notifyHead(target.headEntry, monitor, event, workerId),
      logger: deps.logger
    })
  }
  return { tick }
}

// (the W6 system-health TICK — HealthDaemonDeps, scanPostErrorFindings, the C6
// tail reader factory + scans, buildHealthAlertFrame, runHealthDaemonTick —
// MOVED to packages/dshd-health — see the dshd-health phase note above; every
// symbol is now imported + re-exported from ./core/health.js. The daemon
// WIRING — the setInterval + the ONE per-daemon createDeliveryRowsTailReader
// call + the notifyHost ALERT closure — stays in applyInvoke below.)


/** The live hooks the A3 guard needs (Feature A). Abstracted so the guard
 * predicate is PURE and directly unit-testable, and so the production wiring
 * provides the plugin's live registries (presence cache, host registry). */
export interface AskUserGuardHooks {
  /** True when the owner is present (the guard must NOT deny). */
  present(): boolean
  /** True when `sessionId` is the REGISTERED host session (the only caller the
   * guard may gate). Posts/workers/subagents return false. */
  isHostAgent(sessionId: string): boolean
}

/** The A3 `ask_user_question` denial reason, or undefined to allow the call.
 * A GLOBAL plain-context guard (the plugin owns no scoped host ctx), so the
 * denial is deliberately NARROW — it fires ONLY when (a) the owner is absent,
 * (b) the tool is exactly `ask_user_question`, AND (c) the caller is the
 * registered host. Presence absence can never break any other tool, and never
 * gates a post/worker/subagent (their ask_user, if ever reachable, fails the
 * host check and passes). Returns the string reason the host model reads. */
export function askUserGuardReason(
  exec: { name?: unknown; agent?: { id?: unknown } },
  hooks: AskUserGuardHooks
): string | undefined {
  if (hooks.present()) return undefined
  if (exec.name !== 'ask_user_question') return undefined
  const agentId = exec.agent?.id
  if (typeof agentId !== 'string') return undefined
  if (!hooks.isHostAgent(agentId)) return undefined
  // The `owner absent (presence flag)` prefix is a contract: the real-Loader A3
  // test and the boot wiring regex-match it. The suffix orients the DENIED host
  // (the only caller this guard can gate) to the org's correct channel for an
  // owner question — PENDIENTE-OWNER (WORK-REGISTER §3 / journal) — and states
  // the guard does NOT queue: the question is dropped unless the host parks it.
  return 'owner absent (presence flag) — the owner is away and cannot answer an interactive question now; the question was NOT queued. Record it in PENDIENTE-OWNER (WORK-REGISTER §3 / your journal) and present it when the owner is present.'
}

// (dispatchDeepartmentsEndpoint + the envelope/trust primitives +
// handleDeepartmentsRequest MOVED to packages/dshd-gui — see the dshd-gui
// phase note above; the mount effect below calls them via ./core/gui.js.)

// The `shouldClearCleanupPending` flag-clear decision for the boot web-UI
// cleanup moved to ./core/lifecycle.js (FASE 2 STEP f); re-exported above so
// lib/invoke.js stays a drop-in superset for the session-cleanup regression
// tests. The durable `webUiCleanupPending` marker is cleared ONLY when the
// cleanup actually RAN AND the GUI-critical truncation succeeded; a skipped
// report (host session live) or a failed/absent truncate KEEPS the flag so the
// NEXT boot retries.

/** Outcome of one host-session title pin (U4 — the "Asistente" sidebar
 * label). 'pinned' = the `session/title` user event was appended now;
 * 'already-titled' = the log already holds a user-kind title (the owner's
 * manual rename OR the Asistente pin itself) — never touched; 'failed' = the
 * append threw (the caller logs and continues — a title pin must never break
 * host registration). */
export type HostTitlePinResult = 'pinned' | 'already-titled' | 'failed'

/** Outcome of one session title pin (Piece 1 — the U4 pin generalized beyond
 * hosts, so configured department heads get a native-sidebar title too). Same
 * union and semantics as [`HostTitlePinResult`]; kept as an alias so callers
 * can name the general result without churning the U4 host API. */
export type TitlePinResult = HostTitlePinResult

/**
 * Piece 1 — pin a durable sidebar title on a LIVE session (any registered
 * session that owns a log: the host's, or a department head's). The sidebar
 * row label IS the session title projection, folded last-wins from
 * `session/title` log events, so appending a user-source title event (the
 * exact rename() shape — dsh-session-title lib/index.js ~242) makes the row
 * display `title` and supersedes automatic LLM (`source.provider`) and
 * deterministic fallback (`source.fallback`) titles. Guards, per the owner's
 * decision: only pin when the log has NO user-kind `session/title` event yet —
 * a manual owner rename is also `source.user` and always wins, and a session
 * that already holds the pin is never double-pinned.
 *
 * `session/title` is a plugin-merged, LOG-ONLY event type (persistence catalog
 * known-event-types.js — NOT a key of the core SessionEventMap), so the
 * `session.append` call deliberately widens the type; the live store accepts
 * the exact shape (session.rename appends it verbatim). Rotated host sessions
 * already carry the pin in their cold seed (buildRotationSeed) — this covers
 * the first UI-created host session and every resume via ensureHost; heads
 * receive the pin from ensureHead (coordinator.sessionTitle ?? fallback).
 */
export function pinSessionTitle(session: Session, title: string): TitlePinResult {
  // Dual session-log read via the SHARED helper (getSessionEvents — the
  // post-incidente 2026-09-04 ONE implementation of the `snapshotEvents?.() ??
  // events` dual read; the runtime core 0.1.1-rc.2 exposes the cached `events`
  // getter while the 0.1.2-rc.1 surface replaces it with `snapshotEvents()` —
  // same frozen/cached semantics on either seam, identical pin guard).
  const titleEvents = getSessionEvents(session) as readonly { type: string; data?: { source?: { kind?: string } } }[]
  if (titleEvents.some((ev) => ev.type === 'session/title' && ev.data?.source?.kind === 'user')) {
    return 'already-titled'
  }
  try {
    ;(session.append as unknown as (type: string, data: Record<string, unknown>) => void)('session/title', {
      title,
      messageSeqs: [],
      source: { kind: 'user' }
    })
    return 'pinned'
  } catch {
    return 'failed'
  }
}

/**
 * U4 — pin the durable "Asistente" title on a LIVE host session. Host
 * semantics unchanged: this is exactly `pinSessionTitle` with the Asistente
 * label (the shared helper keeps the owner-rename-wins guard and the
 * never-double-pin guard). Rotated host sessions already carry the pin in
 * their cold seed (buildRotationSeed) — this covers the first UI-created host
 * session and every resume via ensureHost.
 */
export function pinHostSessionTitle(session: Session): HostTitlePinResult {
  return pinSessionTitle(session, ASISTENTE_SESSION_TITLE)
}

/** Piece 1 — the native-sidebar title pinned on a configured head whose
 * coordinator config carries no explicit `sessionTitle` (the acceptance
 * label; the live config sets `coordinator.sessionTitle` explicitly). */
const HEAD_DEFAULT_SESSION_TITLE = 'Research Head'

/** Piece 1 (2026-08-22) — one workspace entity as the workspace-root resolver
 * reads it: the REAL dsh-workspace entity additionally exposes `sessionIds`
 * (the membership getter filtered through the session-path index — dsh-workspace
 * lib:78-80) on top of the rotation seam's `path`/`attachSession` pair. The
 * rotation's own [`WorkspaceEntityLike`] (src/session-rotation.ts) stays
 * untouched (it only needs the attach pair); this local narrowing adds the
 * read-only membership view without widening the seam. */
interface WorkspaceEntityMembershipLike {
  path: string
  sessionIds?: readonly string[]
}

// ---------------------------------------------------------------------------
// Service (called from src/index.ts).
// ---------------------------------------------------------------------------

/** The GLOBAL tools every department HEAD inherits from the host surface
 * (spec 004 §7.1 / F10): read, write, glob, grep + the research web tools.
 * M2.3 (owner decision 2026-08-28): `secretary` is DELIBERATELY NOT here
 * anymore — a head's personal NON-CODE READ-ONLY secretary (the
 * `tool-secretary` row of the deepartments-head preset for the HOST; the OWN
 * layer for a head) is registered SCOPED on the head's own layer by
 * `installHeadBoardTools` (AFTER the restrict — immune to the standing mask,
 * the M2.2 live anomaly), so the inherited allow-list must NOT carry the name:
 * naming a scope-local name in restrict() would THROW and fall back to the
 * all-masking `allow: []`. The probe therefore never looks for it; a head
 * chain WITHOUT a standing row still sees its own secretary by the own-layer
 * registration. The own-layer board + department-lifecycle tools
 * (send_message/agent_messages/dept_who/dept_memo_write +
 * dept_worker_spawn/retire, dept_post_create/retire, secretary) are all
 * SCOPED-registered and ALWAYS visible (exempt from the restrict mask), so
 * only these GLOBAL capability tools need naming in the allow list. */
export const HEAD_BASE_TOOLS: readonly string[] = ['read', 'write', 'glob', 'grep', 'web_search', 'web_fetch']
/** Security posture (spec 004 §7.1; OWNER DECISION 2026-08-23): `edit` is NOT
 * a hard deny — it flows through the role's allow-list like any other tool,
 * so only a role whose template DECLARES it inherits it (the organizer
 * template declares `edit` → it inherits it; researcher/reviewer templates do
 * not declare it → they never see it). What stays HARD-DENIED for every
 * department post is the Asistente's subagent coordination machinery
 * (`subagent`/`subagent_fork`/`workflow`/`ralph`) and the reserved `run_code`
 * transport — a post is a ROOT worker/coordinator and never spawns or
 * coordinates anyone else. A template that DECLARES a denied name is DROPPED
 * with a warning — never a hard failure (the deploy must not fail on a bad
 * frontmatter tool name). */
const DENIED_POST_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork', 'workflow', 'ralph', 'run_code'])
/** The post's OWN-LAYER board + department-lifecycle tools, registered SCOPED
 * to the post agent by `installHeadBoardTools`: send_message/agent_messages/
 * dept_who/dept_memo_write + the department-lifecycle create/retire/spawn/
 * retire/job tools + (M2.3) `secretary`. (LOTE A, 2026-08-27: dept_sleep is NO
 * LONGER in the own layer — head/worker sleep retired; it is hosts-only, spec
 * 002.)
 * The role templates ALSO DECLARE the bus tools (e.g. researcher.md declares
 * send_message/agent_messages/dept_who/dept_memo_write), so when the
 * allow-list is probed against the AGENT scope (see postSetup) these names are
 * "found" (own-layer is visible) — but naming a scope-local name in
 * restrict() THROWS (M2.3: exactly the reason `secretary` MOVED here from
 * HEAD_BASE_TOOLS). They are explicitly EXCLUDED here (they are exempt from
 * the restrict mask and never belong in the allow list). */
export const OWN_LAYER_POST_TOOLS: ReadonlySet<string> = new Set([
  'send_message', 'agent_messages', 'dept_who', 'dept_memo_write',
  'dept_post_create', 'dept_post_retire', 'dept_worker_spawn', 'dept_worker_retire',
  'dept_job_list', 'dept_job_run', 'dept_monitor_list', 'dept_exec', 'dept_zstd_read',
  'dept_feedback', 'dept_feedback_list', 'dept_feedback_update',
  'secretary'
])

// DECOUPLING SUB-PASO 2 — the DELIVERY ORCHESTRATION FACTORY (the hoisted
// delivery/ACL/QD/lifecycle/engine zone, invoked at the SAME fiber position).
import { createDeliveryOrchestration, type DeliverySurface, type DeliveryFactoryDeps } from './core/orchestration/delivery.js'
import { createSpawnOrchestration, type SpawnSurface, type HeadToolDisposers, type SpawnFactoryDeps } from './core/orchestration/spawn.js'
import { createToolsOrchestration, type ToolsSurface, type ToolsFactoryDeps } from './core/orchestration/tools.js'
import { createPresetsOrchestration, type PresetsSurface, type PresetsFactoryDeps } from './core/orchestration/presets.js'
import { createBootOrchestration, type BootSurface, type BootFactoryDeps } from './core/orchestration/boot.js'

// ---------------------------------------------------------------------------
// M-5 (FASE 4 kickoff 2026-08-31, owner gap «misión entregada a un head pero
// NO INICIADA») — buildMissionActivity: the BUNDLE-side builder of the
// `missionActivity` health-daemon dep (one row per non-retired HEAD post with
// a HOST→head mission delivery). The seam (d): the message store's DELIVERY
// state (deliveries.jsonl rows — the LAST host→head delivery row per post,
// statuses delivered/prepared/resumed/failed = the host hand-offs entrusted to
// the head's inbox; the missive's «delivered/prepared/pending/failed» maps onto
// the store's exact union — 'pending' is the 'prepared' write-ahead row, and
// 'resumed' counts as a delivered-equivalent re-delivery; 'self'/'terminal'
// NEVER count: self = the post addressed itself, terminal = a settled
// death-mark) + the messages.jsonl `from` attribution (the mission sender) +
// the CATALOG (non-retired posts; HEADS only — `provider === 'worker'` rows
// are disposable workers, never mission recipients) + the post's last SESSION
// activity (buildPostSnapshot lastActivityTs — the same no-I/O primitive the
// stall/wait scans use; "No procesada" = a host→head delivery row with NO
// turn/session-write AFTER the delivery ts). NOT resolvable (no live host / no
// message store / hermetic composition) → undefined → the tick no-ops the scan
// (the hostRunning/sessionContexts-absent pattern: unknown delivery state never
// fabricates a stalled-mission ALERT). PER-TICK cost: the bundle calls this
// once per daemon tick (like buildHealthPosts); the FULL store read is the
// readInboxByPost precedent (the C6 tail reader is owned by the delivery-failed
// scan inside the tick, never shared).
// ---------------------------------------------------------------------------

/** M-5 — the inputs `buildMissionActivity` needs (structural so a hermetic
 * test or a DECOUPLING caller drives it with fixtures). */
export interface MissionActivityBuildInput {
  stateDir: string
  /** The catalog posts (Map values — fresh per call; non-retired HEADS are the
   * mission recipients). */
  byPost: ReadonlyMap<string, PostEntry>
  /** The hosts registry (iterable — pickLiveHostEntry resolves the LIVE host,
   * the mission SENDER; absent live host → undefined → no-op). */
  hosts: Iterable<HostEntryLike>
  /** The agents registry (absent in a composition WITHOUT a live agents
   * service → the session-activity term degrades to undefined, never a
   * throw — the buildPostSnapshot empty-events contract). The session events
   * are structurally `readonly unknown[]` — read via the rc.1 surface
   * `snapshotEvents()` when present, with a legacy `events` fallback (the
   * pre-rc.1 line still exposes the getter) — cast to HealthSessionEvent[]
   * inside per the buildHealthPosts pattern. */
  agents?: { get(sessionId: string): { session?: { snapshotEvents?: () => readonly unknown[]; events?: readonly unknown[] } } | undefined } | undefined
}

/** M-5 — build the per-head-post mission-activity rows the mission-stalled
 * scan reads (see the block comment above for the seam/status mapping).
 * PURE-ISH: reads the message store from `stateDir` (never throws — a store
 * failure degrades to no missions, never a crash); returns undefined only when
 * the mission-sender seam is unresolvable (NO live host — a wiring without the
 * host can never attribute a host→head mission). */
export function buildMissionActivity(input: MissionActivityBuildInput): MissionActivityInput[] | undefined {
  // The mission SENDER is the LIVE host (the Asistente). No live host → no
  // host→head mission can be attributed → undefined → the scan no-ops.
  const { live } = pickLiveHostEntry(input.hosts)
  if (live === undefined) return undefined
  // deliveries.jsonl — the delivery-state seam (never throws: readDeliveryRowsFull
  // degrades an absent/unreadable sidecar to []).
  const deliveryRows = readDeliveryRowsFull(input.stateDir)
  // messages.jsonl — the `from` attribution (the mission SENDER must be the
  // live host). Unreadable → empty map → no mission matches → no rows (the
  // scan no-ops; never a fabricated alert).
  let messageFrom = new Map<string, string>()
  try {
    for (const record of parseMessageRecords(readFileSync(resolveMessagesPath(input.stateDir), 'utf8'))) {
      messageFrom.set(record.id, record.from)
    }
  } catch {
    messageFrom = new Map()
  }
  const out: MissionActivityInput[] = []
  for (const [postId, entry] of input.byPost) {
    if (entry.retired === true) continue
    // HEADS only — a disposable worker (`provider === 'worker'`) is never a
    // mission recipient (the catalog kind derivation).
    if (entry.provider === 'worker') continue
    // The LAST host→head mission delivery row (max ts): recipient = this post,
    // status in the mission-consummated set (prepared/delivered/resumed/failed
    // — the missive's «delivered/prepared/pending/failed»; 'pending' is the
    // 'prepared' write-ahead, 'resumed' the delivered-equivalent re-delivery;
    // self/terminal are never a mission), sender = the live host.
    let last: { messageId: string; ts: number } | undefined
    for (const row of deliveryRows) {
      if (row.recipientId !== postId) continue
      if (row.status !== 'prepared' && row.status !== 'delivered' && row.status !== 'resumed' && row.status !== 'failed') continue
      if (messageFrom.get(row.messageId) !== live.hostId) continue
      if (last === undefined || row.ts > last.ts) last = { messageId: row.messageId, ts: row.ts }
    }
    if (last === undefined) continue
    // The post's last session activity — buildPostSnapshot (the same no-I/O
    // primitive the stall/wait scans use; empty event log → undefined). The
    // dual rc.1/legacy read goes through the SHARED helper (getSessionEvents —
    // the post-incidente 2026-09-04 ONE implementation).
    const liveSession = input.agents?.get(entry.sessionId)?.session
    const events = getSessionEvents(liveSession) as readonly HealthSessionEvent[]
    const snap = buildPostSnapshot({ postId, events })
    out.push({
      postId,
      mission: last,
      ...(snap.lastActivityTs !== undefined ? { lastActivityTs: snap.lastActivityTs } : {})
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// M-6 (FASE 4 lane 1, VALLE, 2026-08-31, owner gap «main rojo post-commit») —
// buildMainRedState: the BUNDLE-side builder of the `mainRed` health-daemon dep
// (the post-commit re-verification watchdog). The seam (d): the dev repo root
// (knob `health.mainRedRepoRoot` ?? REPO_ROOT — the REAL repo the host commits
// daily) is turned into a { readHeadSha(), runLocks(paths) } runtime:
//   - readHeadSha(): `git rev-parse HEAD` over the repo root (child_process —
//     the light poll; the ONLY per-tick git cost, gated to mainRedPollMs),
//   - runLocks(paths): `node --test <lock>` PER lock (a SEPARATE invocation per
//     lock so the FAILED lock is named in the frame; result per file {file, ok};
//     ONE single execution per new sha — the tick gates it).
// COMPOSITION-NO-GIT (a packaged deployment whose root is NOT a git repo) →
// undefined → the tick no-ops the scan (the hostRunning/sessionContexts-absent
// pattern: unknown main state never fabricates a post-commit ALERT).
// NEVER throws: a git/node failure degrades to {ok:false} / undefined, never a
// crash. The I/O lives here (bundle-side), NEVER in the pure scan.
// ---------------------------------------------------------------------------

/** M-6 — the outcome of ONE lock invocation (the repo-relative lock path +
 * whether `node --test` exited 0 for it). Kept structural here (the pure scan
 * only reads `ok`). */
export interface MainRedLockRun {
  file: string
  ok: boolean
}

/** M-6 — the per-lock `node --test` hard timeout (a stuck/hung lock must never
 * wedge the whole fast-lock batch — 5 min headroom well above the ~seconds a
 * healthy fast lock takes). */
const MAIN_RED_LOCK_TIMEOUT_MS = 300000

/** M-6 — build the main-red runtime over a repo root (the git HEAD reader +
 * the fast-lock runner). Not a git repo (`.git` absent — a packaged
 * deployment) → undefined → the tick no-ops the scan. NEVER throws (a git or
 * node failure inside degrades, never throws). */
export function buildMainRedState(repoRoot: string): MainRedRuntime | undefined {
  let isGit = false
  try {
    isGit = existsSync(path.join(repoRoot, '.git'))
  } catch {
    isGit = false
  }
  if (!isGit) return undefined
  const readHeadSha = (): string | undefined => {
    try {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
    } catch {
      return undefined
    }
  }
  const runLocks = async (paths: readonly string[]): Promise<readonly MainRedLockResult[]> => {
    const results: MainRedLockResult[] = []
    // The spawned `node --test` must run WITHOUT the harness test-context
    // marker: NODE_TEST_CONTEXT is set by the node:test RUNNER in the parent
    // (a hermetic suite runs the bundle in-process) and a child that inherits
    // it is treated as a "recursive test run" — it SKIPS the file and exits 0,
    // which would report every lock as green. The pristine env (no marker)
    // makes the child a fresh test runner. Production has no marker → no-op.
    const lockEnv = { ...process.env }
    delete lockEnv.NODE_TEST_CONTEXT
    delete lockEnv.NODE_OPTIONS
    for (const lock of paths) {
      try {
        // node --test <lock> — ONE invocation per lock (the failed lock is
        // named in the frame). The absolute path joined against the repo root.
        execFileSync('node', ['--test', path.join(repoRoot, lock)], { cwd: repoRoot, timeout: MAIN_RED_LOCK_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], env: lockEnv })
        results.push({ file: lock, ok: true })
      } catch {
        results.push({ file: lock, ok: false })
      }
    }
    return results
  }
  return { readHeadSha, runLocks }
}

export function applyInvoke(ctx: Context, config: Config) {
  // ---------------------------------------------------------------------------
  // DECOUPLING ZONA 7 — BOOT ORCHESTRATION FACTORY (the BOOT zone, 678 LOCs of
  // this apply — src/invoke.ts 2344-3021): the optional continuation services
  // + the SHARED CONFIG SOURCE + the durable catalog REGISTRY + the per-head/
  // host live maps + the C1/C3 catalog machinery + the R1 lifecycle tool
  // builders + the host registry surface + the Feature-A presence state + the
  // cold-load promises + the boot web-UI cleanup + the host attach-repair
  // hooks were hoisted VERBATIM into src/core/orchestration/boot.ts and are
  // invoked HERE — at the SAME fiber position where they used to live. The
  // applyInvoke opener line (2344) stays as this block's first line; the 677
  // content LOCs (2345-3021) moved byte-identical. The factory consumes the
  // invoke.ts module-scope pure helpers BY REFERENCE (readPresenceStateFile /
  // writePresenceStateFile / askUserGuardReason / pinHostSessionTitle — not
  // importable without a cycle) and the PresetsSurface `coordinatorForPost` +
  // the DeliverySurface `lifecycle` + the ToolsSurface `retirePost` LATE
  // through `late` getters (resolved at CALL time — those bindings are
  // destructured later in this apply, so the apply-scope TDZ is never
  // entered); it returns the BootSurface the rest of this apply consumes at
  // the SAME positions (presets/spawn/tools/delivery factories + the daemons).
  // The 'deepartments.boot' service is consumed service-first with the inline
  // R6 fallback (the factory) — MOVEMENT-ONLY: the same closures, the same
  // order, 0 behavior change.
  // ---------------------------------------------------------------------------
  // LANE 0.2.2 (gap 2) — DI glue: the boot deps object is BUILT, REGISTERED
  // into the dshd-orchestration deps holder (deepartments.bootDeps — the
  // composed package rebuilds the SAME factory on first use) AND consumed
  // service-first with the inline R6 fallback (the SAME object, byte-identical
  // behavior in a minimal/hermetic composition without the package).
  const bootDeps: BootFactoryDeps = {
    config,
    // invoke.ts module-scope pure helpers (not importable without a cycle — by
    // reference).
    readPresenceStateFile,
    writePresenceStateFile,
    askUserGuardReason,
    pinHostSessionTitle,
    // LANE 0.2.2 (gap 2) — the bundle-local agent-state aggregate helper
    // (src/agents.js, injected by reference — the moved factory receives it as
    // a dep; "functions, never imports").
    computeDeptWhoState,
    late: {
      // The PresetsSurface `coordinatorForPost` (built at the presets factory
      // position, AFTER this factory — buildCatalogRows dereferences it only
      // at CALL time, post-boot): getter over the apply-scope binding.
      get coordinatorForPost() { return coordinatorForPost },
      // The DeliverySurface `lifecycle` (built at the delivery factory
      // position — the memoWriteTool/sleepTool executes dereference it only
      // at CALL time, post-boot): getter over the apply-scope binding.
      get lifecycle() { return lifecycle },
      // The ToolsSurface `retirePost` (built at the tools factory position —
      // the postRetireTool execute dereferences it only at CALL time,
      // post-boot): getter over the apply-scope binding.
      get retirePost() { return retirePost }
    }
  }
  // NON-STRICT get (ctx.get(name, false)): the loader applies rows
  // concurrently, and a strict get (provider fiber-state gate) can return
  // undefined for a SIBLING row mid-apply — the register must ALWAYS land into
  // the holder (composed) or no-op (hermetic), never silently skip.
  ctx.get('deepartments.bootDeps', false)?.register(bootDeps)
  const bootSurface: BootSurface = (ctx.get('deepartments.boot', false) as BootSurface | undefined) ?? createBootOrchestration(ctx, bootDeps)
  const {
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
  } = bootSurface

  // ---------------------------------------------------------------------------
  // DECOUPLING SUB-PASO 6 — PRESETS ORCHESTRATION FACTORY (preset materialization
  // per-head Batch 1a/4a + journal/archive Task T1 + the wake-pack W8-d assembly,
  // 898 LOCs): the presets/journal/wake-pack zone of this apply was hoisted
  // VERBATIM into src/core/orchestration/presets.ts and is invoked HERE — at the
  // SAME fiber position where it used to live. The factory consumes the boot-zone
  // bindings by reference (config/stateDir/org/agents/byPost/hosts + the
  // module-scope helpers isUsableAgentOptions/yamlList/computeHostSleepSurfacePlan/
  // readPresenceStateFile) and the DeliverySurface `messagesStoreReady` LATE
  // through a TDZ-safe getter (resolved at CALL time — the wake-pack assembly
  // dereferences it post-boot, so the apply-scope TDZ of deliverySurface is never
  // entered); it returns the PresetsSurface the rest of this apply consumes at
  // the SAME positions (the agent/pre-step registration below, spawn, tools,
  // delivery, the daemons). The 'deepartments.presets' service is consumed
  // service-first with the inline R6 fallback (the factory) — MOVEMENT-ONLY: the
  // same closures, the same order, 0 behavior change.
  // ---------------------------------------------------------------------------
  // LANE 0.2.2 (gap 2) — DI glue: the presets deps object is BUILT, REGISTERED
  // (deepartments.presetsDeps) AND consumed service-first with the inline R6
  // fallback (the same object — behavior-neutral in a minimal composition).
  const presetsDeps: PresetsFactoryDeps = {
    config,
    stateDir,
    org,
    agents,
    byPost,
    hosts,
    hostIdForSession,
    refreshPresence,
    persistHosts,
    postIdForChild,
    deferredSleepReplace,
    wakePackInjected,
    // invoke.ts module-scope pure helpers (not importable without a cycle — by
    // reference).
    isUsableAgentOptions,
    yamlList,
    computeHostSleepSurfacePlan,
    readPresenceStateFile,
    // LANE 0.2.2 (gap 2) — the bundle-local pure helpers (src/head-presets.ts
    // + src/toolset-audit.ts — injected by reference, "functions, never
    // imports").
    HEAD_PRESET_BASE_ID,
    headPresetIdFor,
    headPresetNameCore,
    headPresetNameFor,
    buildHeadPresetComposition,
    buildHeadPresetMetadata,
    appendToolsetAudit,
    late: {
      // The DeliverySurface's boot-opened message store promise (built at the
      // delivery factory position, AFTER this factory): getter over the
      // apply-scope binding, dereferenced only at wake-pack assembly (post-boot)
      // — the factory rebinds the zone's `messagesStoreReady` name as a
      // delegating THENABLE over this seam.
      get messagesStoreReady() { return deliverySurface.messagesStoreReady }
    }
  }
  ctx.get('deepartments.presetsDeps', false)?.register(presetsDeps)
  const presetsSurface: PresetsSurface = (ctx.get('deepartments.presets', false) as PresetsSurface | undefined) ?? createPresetsOrchestration(ctx, presetsDeps)
  const {
    HOST_AGENT_OPTIONS,
    PRESET_ID,
    WORKER_AGENT_OPTIONS,
    WORKER_PRESET_ID,
    resolveMaterializeAgentOptions,
    repoRoot,
    dshHome,
    materializePreset,
    materializeHeadPreset,
    journalPathFor,
    writeJournal,
    bumpHostSleepCounter,
    bumpPostSleepCounter,
    readJournal,
    coordinatorForPost,
    departmentForPost,
    departmentForEntry,
    assembleHeartbeat,
    roleForSessionLive,
    wakePackService
  } = presetsSurface

  // The wake pack is registered on the SAME `agent/pre-step` Cordis waterfall
  // the runtime-context + skill-catalog use (no dsh-core change). The actual
  // injector logic (host-only, retired-gated, once-per-session) lives in
  // wakepack.js; invoke.ts merely registers the listener and delegates.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    return wakePackService.preStepHandler({ agent, signal }, next as () => Promise<unknown>) as unknown as Promise<Awaited<ReturnType<typeof next>>>
  })
  // ---------------------------------------------------------------------------
  // DECOUPLING SUB-PASO 3 — SPAWN ORCHESTRATION FACTORY (F3 role templates +
  // W1 job-run core + calendar helpers, 432 LOCs): the spawn/roles zone of
  // this apply was hoisted VERBATIM into src/core/orchestration/spawn.ts and
  // is invoked HERE — at the SAME fiber position where it used to live. The
  // factory consumes the DELIVERY seams (deliverBusRecord/messagesStoreReady)
  // and the agent-setup/workspace seams LATE through `late` getters (resolved
  // at CALL time — those closures are built later in this apply); it returns
  // the SpawnSurface the rest of this apply consumes at the SAME positions
  // (tools, scheduler, parallel monitor, the delivery deps). The 'deepartments
  // .spawn' service is consumed service-first with the inline R6 fallback (the
  // factory) — MOVEMENT-ONLY: same closures, same order, 0 behavior change.
  // ---------------------------------------------------------------------------
  // LANE 0.2.2 (gap 2) — DI glue: the spawn deps object is BUILT, REGISTERED
  // (deepartments.spawnDeps) AND consumed service-first with the inline R6
  // fallback (the same object — behavior-neutral in a minimal composition).
  const spawnDeps: SpawnFactoryDeps = {
    stateDir,
    repoRoot,
    config,
    agents,
    byPost,
    byHeadHandle,
    registerEntry,
    coordinatorForPost,
    dshHome,
    pinSessionTitle,
    WORKER_PRESET_ID,
    WORKER_AGENT_OPTIONS,
    // LATE seams — the DeliverySurface (built at the delivery factory
    // position) + the agent-setup/workspace closures (built in the agent
    // zone); the getters capture the apply-scope bindings and are dereferenced
    // ONLY when a spawn/job closure fires (post-boot — never here, so the TDZ
    // of these later consts is never entered).
    late: {
      get workerSetup() { return workerSetup },
      get resolveDepartmentWorkspaceCwd() { return resolveDepartmentWorkspaceCwd },
      get resolveWorkspaceRootPath() { return resolveWorkspaceRootPath },
      get deliverBusRecord() { return deliverySurface.deliverBusRecord },
      get messagesStoreReady() { return deliverySurface.messagesStoreReady }
    }
  }
  ctx.get('deepartments.spawnDeps', false)?.register(spawnDeps)
  const spawnSurface: SpawnSurface = (ctx.get('deepartments.spawn', false) as SpawnSurface | undefined) ?? createSpawnOrchestration(ctx, spawnDeps)
  const {
    runJobForDepartment,
    spawnWorkerForDepartment,
    readCalendar,
    writeCalendarBestEffort,
    departmentJobExists,
    defaultWorkerTitle,
    workerReasoningContentPreflightError,
    workerPoolerDispatchBlockError,
    resolveRoleTemplate
  } = spawnSurface

  // ---------------------------------------------------------------------------
  // DECOUPLING SUB-PASO 4 — TOOLS ORCHESTRATION FACTORY (SUB-BATCH 1 of 4:
  // dept_exec/zstd runners + the agent toolset REGISTRY, 922 LOCs): the first
  // cut of the tools zone (the dept_exec runners deptExecAllowedRoots /
  // runDeptExec / deptExecRender + installHeadBoardTools — the post own-layer
  // tool registry: calendar x3, dept_exec, dept_zstd_read, dept_post_create,
  // dept_job_list/dept_job_run, dept_worker_spawn/dept_worker_retire,
  // dept_monitor_list, the M2.3 secretary + bus/feedback/memo/retire inserts)
  // was hoisted VERBATIM into src/core/orchestration/tools.ts and is invoked
  // HERE — at the SAME fiber position where it used to live. The factory
  // consumes the SPAWN surface members by reference and the agent-setup/
  // workspace/retire/archive/delivery seams + the tool ARRAYS LATE through
  // `late` getters (resolved at CALL time — those closures are built later in
  // this apply); it returns the ToolsSurface the rest of this apply consumes
  // at the SAME positions (postSetup's installHeadBoardTools wiring). The
  // 'deepartments.tools' service is consumed service-first with the inline R6
  // fallback (the factory) — MOVEMENT-ONLY: same closures, same order, 0
  // behavior change. The zone continues to grow in sub-batches 2-4.
  // ---------------------------------------------------------------------------
  // LANE 0.2.2 (gap 2) — DI glue: the tools deps object is BUILT, REGISTERED
  // (deepartments.toolsDeps) AND consumed service-first with the inline R6
  // fallback (the same object — behavior-neutral in a minimal composition).
  const toolsDeps: ToolsFactoryDeps = {
    config,
    org,
    stateDir,
    repoRoot,
    agents,
    byPost,
    byHeadHandle,
    coordinatorForPost,
    postIdForChild,
    registerEntry,
    departmentForPost,
    departmentForEntry,
    activeMembersSchema,
    renderActiveRoster,
    activeCatalogMembers,
    memoWriteTool,
    postRetireTool,
    pinSessionTitle,
    WORKER_PRESET_ID,
    WORKER_AGENT_OPTIONS,
    agentPresets,
    disposingHeads,
    PRESET_ID,
    HEAD_BASE_TOOLS,
    DENIED_POST_TOOLS,
    OWN_LAYER_POST_TOOLS,
    execFileP,
    DEPT_EXEC_DEFAULT_ROOTS,
    DEPT_EXEC_TIMEOUT_MS,
    DEPT_EXEC_MAX_BUFFER,
    deptExecDenyReason,
    DEPT_ZSTD_READ_MAX_LINES,
    runDeptZstdRead,
    deptZstdReadDenyReason,
    resolveParallelMonitorConfig,
    readParallelMonitorsState,
    // LANE 0.2.2 (gap 2) — the bundle-local pure VALUES the factory zones call
    // (injected by reference, "functions, never imports"):
    appendToolsetAudit,
    headPresetIdFor,
    createSecretaryTool,
    secretaryConfig,
    buildAgentRows,
    spawn: {
      runJobForDepartment,
      spawnWorkerForDepartment,
      readCalendar,
      writeCalendarBestEffort,
      departmentJobExists,
      defaultWorkerTitle,
      workerReasoningContentPreflightError,
      workerPoolerDispatchBlockError
    },
    // SUB-BATCH 3: 15 new DIRECT deps (all defined BEFORE this position — the
    // catalog registry, the QD dice probability, the live head-progress/host
    // maps, the workspace materialization closures, the cold-load promises):
    registry,
    qualityWorkerInspectProbability,
    headProgress,
    hosts,
    HOST_ATTACH_REPAIR_TIMEOUT_MS,
    HOST_ATTACH_REPAIR_RETRY_MS,
    HOST_AGENT_OPTIONS,
    materializePreset,
    materializeHeadPreset,
    dshHome,
    registryLoaded,
    hostsLoaded,
    stuckNow,
    STUCK_HEAD_MS,
    HEAD_DEFAULT_SESSION_TITLE,
    // SUB-BATCH 4: 27 new DIRECT deps (all defined BEFORE this position or
    // module-scope of invoke.ts — the host-plane tool builders + the
    // bus/wakepack/registry closures the CUT4 tools/buckets/daemon-builders
    // consume + the module-scope pure rotation/delivery helpers):
    sleepTool,
    subagents,
    wakePackService,
    hostIdForSession,
    readJournal,
    journalPathFor,
    refreshPresence,
    savePresence,
    notifyHostPresence,
    presenceCache,
    assembleHeartbeat,
    roleForSessionLive,
    headRotationJournalStatus,
    verifyRotateReason,
    resolveSessionProjCachePath,
    deliverDaemonNotice,
    captureSchedulerAutoRunFailure,
    buildCatalogRows,
    wakePackInjected,
    deferredSleepReplace,
    computeHostSleepSurfacePlan,
    readPresenceStateFile,
    ensureHost,
    writeJournal,
    bumpHostSleepCounter,
    bumpPostSleepCounter,
    // LATE seams — the DeliverySurface members (built at the delivery factory
    // position) do NOT exist at this position; the getters capture the
    // apply-scope bindings and are dereferenced ONLY when a registration / tool
    // execute / the boot wiring / the binder buckets' lazy readers fire
    // (post-boot — never here, so the TDZ of these later consts is never
    // entered). NOTE (SUB-BATCH 2): `workerSetup` is NOT a late seam anymore —
    // the CUT2 zone (installed in this factory) now DEFINES it. NOTE
    // (SUB-BATCH 3): `resolveDepartmentWorkspaceCwd` / `resolveWorkspaceRootPath`
    // / `retirePost` / `archiveWorkerSession` are NOT late seams anymore either
    // — the CUT3 zone (installed in this factory) now DEFINES them. NOTE
    // (SUB-BATCH 4): `busTools` / `feedbackEmitTools` / `feedbackHeadTools` /
    // `redeliverPendingDeliveries` are NOT late seams anymore either — the CUT4
    // zone (installed in this factory) now DEFINES them; the 18 NEW late seams
    // are the delivery factory's bus/ACL/catalog/delivery/feedback/mint/wake
    // members the CUT4 tool executes + the binder buckets dereference.
    late: {
      get maybeEmitQualityInspectDirective() { return maybeEmitQualityInspectDirective },
      get deliverBusRecord() { return deliverySurface.deliverBusRecord },
      get messagesStoreReady() { return deliverySurface.messagesStoreReady },
      get busMemberIdFor() { return deliverySurface.busMemberIdFor },
      get feedbackStoreReady() { return deliverySurface.feedbackStoreReady },
      get resolveQualityHeadEntry() { return deliverySurface.resolveQualityHeadEntry },
      get feedbackForwarderFor() { return deliverySurface.feedbackForwarderFor },
      get feedbackDeliveryOptions() { return deliverySurface.feedbackDeliveryOptions },
      get busProfileFor() { return deliverySurface.busProfileFor },
      get aclDenyGround() { return deliverySurface.aclDenyGround },
      get resolveBusCatalogRoute() { return deliverySurface.resolveBusCatalogRoute },
      get delivery() { return deliverySurface.delivery },
      get isDormantRecipient() { return deliverySurface.isDormantRecipient },
      get busEnsureHostForCaller() { return deliverySurface.busEnsureHostForCaller },
      get assertBusFanOut() { return deliverySurface.assertBusFanOut },
      get busDeliverToPost() { return deliverySurface.busDeliverToPost },
      get busDeliverToHost() { return deliverySurface.busDeliverToHost },
      get resolveBusChild() { return deliverySurface.resolveBusChild },
      get deliverBusChild() { return deliverySurface.deliverBusChild },
      get freshMintHead() { return deliverySurface.freshMintHead },
      get enqueueHostWake() { return deliverySurface.enqueueHostWake }
    }
  }
  ctx.get('deepartments.toolsDeps', false)?.register(toolsDeps)
  const toolsSurface: ToolsSurface = (ctx.get('deepartments.tools', false) as ToolsSurface | undefined) ?? createToolsOrchestration(ctx, toolsDeps)
  const {
    installHeadBoardTools,
    workerSetup,
    headSetup,
    disposeHeadHandle,
    disposeHeadHandleOnce,
    disposeJoinTimeoutMs,
    joinHeadDisposeOnce,
    resolveDepartmentWorkspaceCwd,
    resolveWorkspaceRootPath,
    rotateArchivedHeadSessionId,
    retirePost,
    isHeadStuck,
    markHeadProgress,
    attachHeadSession,
    archivePostSessionOnSleep,
    schedulerHeadForDepartment,
    schedulerRunJob,
    schedulerOnAutoRunSkip,
    schedulerNotifyHead,
    schedulerDepartmentForEntry,
    schedulerDepartmentForJob,
    buildHealthPosts,
    buildHostRunning,
    buildSessionContexts,
    buildHostWaits,
    healthNotifyHost,
    healthNotifyHead,
    healthPoolerStatePath,
    healthBootId,
    guiEndpointDeps
  } = toolsSurface

  // ---------------------------------------------------------------------------
  // DECOUPLING SUB-PASO 4 — TOOLS ORCHESTRATION FACTORY (SUB-BATCH 2 of 4:
  // the persona/architecture prompt sections + postSetup/workerSetup/headSetup
  // + the head-dispose + retire helpers, 612 LOCs): the second cut of the tools
  // zone (ARCHITECTURE_SECTION_MAX / renderDepartmentTemplate /
  // buildArchitectureSection / installRoleSection / agentScopeOf / postSetup /
  // headSetup / workerSetup / disposeHeadHandle* / captureRetiredPostTurnError
  // / settleRetiredPostDeliveries / predictRetiredWorkerDeliverable — the
  // agent setup + persona/architecture + retire-helper closures, pre-SB1
  // 4900-5511) was hoisted VERBATIM into src/core/orchestration/tools.ts and is
  // returned by the SAME factory invoked above (same fiber position). The
  // destructure above re-binds the apply-scope names at the SAME position the
  // zone used to live — the closures are the factory's, the consumers below
  // (retirePost/CUT3, ensureHead, the delivery factory) are byte-unchanged.
  // workerSetup is now a FACTORY-LOCAL (the sub-batch-1 registry consumes it
  // directly) and the `late.workerSetup` seam is GONE. MOVEMENT-ONLY: same
  // closures, same order, 0 behavior change. The zone continues to grow in
  // sub-batches 3-4.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // DECOUPLING SUB-PASO 4 — TOOLS ORCHESTRATION FACTORY (SUB-BATCH 3 of 4:
  // the workspace + ensureHead + retire/archive + boot-check/reconcile
  // closures, 1273 LOCs): the THIRD cut of the tools zone (retirePost /
  // archiveWorkerSession / archivePostSessionOnSleep / departmentWorkspacePath
  // / ensureDepartmentWorkspace / resolveDepartmentWorkspaceCwd /
  // resolveWorkspaceRootPath / attachHeadSession / rotateArchivedHeadSessionId
  // / ensureHead / makeEntry / ensureAllHeads / headEventCount /
  // markHeadProgress / isHeadStuck / runPresetAudit /
  // runInterruptedPostReconciliation / runProviderAdapterBootCheck /
  // runReasoningContentBootAssert / runDurableRegistryReconciliation /
  // GHOST_SUSPECT_DEFAULT_* / runGhostSuspectReconcile /
  // runHalfSleptHeadReconcile / runRetiredWorkerResidueReconcile + the BOOT
  // WIRING) was hoisted VERBATIM into src/core/orchestration/tools.ts and is
  // returned by the SAME factory invoked above (same fiber position). The
  // destructure above re-binds the apply-scope names at the SAME position the
  // zone used to live — the closures are the factory's, the consumers below
  // (the delivery factory, the lifecycle/rotate tools) are byte-unchanged.
  // retirePost / archiveWorkerSession / resolveDepartmentWorkspaceCwd /
  // resolveWorkspaceRootPath are now FACTORY-LOCALS (their 4 late seams are
  // GONE), captureRetiredPostTurnError / settleRetiredPostDeliveries /
  // predictRetiredWorkerDeliverable left the destructure (retirePost consumes
  // the factory-locals directly), 2 NEW late seams entered
  // (maybeEmitQualityInspectDirective — the delivery emitter retirePost uses at
  // retire time — + redeliverPendingDeliveries — the boot wiring), and 15 new
  // direct deps (registry/headProgress/hosts + the workspace materialization
  // closures + the boot promises). MOVEMENT-ONLY: same closures, same order, 0
  // behavior change. The zone completes in sub-batch 4.
  // ---------------------------------------------------------------------------
  // DECOUPLING SUB-PASO 2 — DELIVERY ORCHESTRATION FACTORY (delivery/ACL/QD/
  // lifecycle/engine, ~1089 LOCs): the bus/delivery closure zone of this apply
  // was hoisted VERBATIM into src/core/orchestration/delivery.ts and is
  // invoked HERE — at the SAME fiber position where it used to live. The
  // factory consumes the REGISTERED dshd-core SERVICES (deepartments.bus /
  // .deliver / .lifecycle / .acl) with the inline R6 fallbacks preserved (a
  // minimal composition falls back to the in-bundle builds — behavior-neutral),
  // produces the closure-bound baseline Binder buckets (bus/deliver/wakepack/
  // lifecycle/redeliver — registered below, binder-contract intact), and
  // returns the DeliverySurface the rest of this apply consumes at the SAME
  // positions (tools, daemons, redeliver driver, bind register). MOVEMENT-ONLY:
  // the same closures, the same order, 0 behavior change.
  // ---------------------------------------------------------------------------
  // LANE 0.2.2 (gap 2) — DI glue: the delivery deps object is BUILT,
  // REGISTERED (deepartments.deliveryDeps) AND consumed service-first with the
  // inline R6 fallback (the same object — behavior-neutral in a minimal
  // composition). DELIVERY gains the service-first form it lacked (0.2.1 left
  // it the only DIRECT factory call — gap 2 makes it uniform with the other 4).
  const deliveryDeps: DeliveryFactoryDeps = {
    stateDir,
    agents,
    subagents,
    agentPresets,
    byPost,
    hosts,
    byChild,
    byHeadHandle,
    headProgress,
    wakePackInjected,
    deferredSleepReplace,
    registerEntry,
    coordinatorForPost,
    departmentForEntry,
    departmentForPost,
    headSetup,
    workerSetup,
    resolveMaterializeAgentOptions,
    resolveRoleTemplate,
    resolveDepartmentWorkspaceCwd,
    resolveWorkspaceRootPath,
    rotateArchivedHeadSessionId,
    retirePost,
    pinSessionTitle,
    disposeHeadHandleOnce,
    disposeJoinTimeoutMs,
    joinHeadDisposeOnce,
    serializeHeadRecovery,
    isHeadStuck,
    disposeHeadHandle,
    markHeadProgress,
    attachHeadSession,
    workerReasoningContentPreflightError,
    workerPoolerDispatchBlockError,
    ensureHost,
    persistPosts,
    persistHosts,
    journalPathFor,
    writeJournal,
    readJournal,
    bumpHostSleepCounter,
    bumpPostSleepCounter,
    archivePostSessionOnSleep,
    hostForSession,
    hostIdForSession,
    postIdForChild,
    repairHostWorkspaceAttach,
    qualityWorkerInspectProbability,
    PRESET_ID,
    WORKER_PRESET_ID,
    WORKER_AGENT_OPTIONS,
    HOST_AGENT_OPTIONS,
    HEAD_DEFAULT_SESSION_TITLE,
    STUCK_HEAD_MS
  }
  ctx.get('deepartments.deliveryDeps', false)?.register(deliveryDeps)
  const deliverySurface = (ctx.get('deepartments.delivery', false) as DeliverySurface | undefined) ?? createDeliveryOrchestration(ctx, deliveryDeps)
  const {
    messageStoreDir,
    messagesStoreReady,
    feedbackStoreReady,
    freshMintHead,
    busDeliverToPost,
    busDeliverToHost,
    resolveQualityHeadEntry,
    feedbackForwarderFor,
    feedbackDeliveryOptions,
    maybeEmitQualityInspectDirective,
    enqueueHostWake,
    lifecycle,
    busProfileFor,
    aclDenyGround,
    resolveBusCatalogRoute,
    deliverBusRecord,
    busMemberIdFor,
    resolveBusChild,
    deliverBusChild,
    delivery,
    isDormantRecipient,
    busEnsureHostForCaller,
    assertBusFanOut
  } = deliverySurface

// ---------------------------------------------------------------------------
  // DECOUPLING SUB-PASO 4 — TOOLS ORCHESTRATION FACTORY (SUB-BATCH 4 of 4 —
  // THE LAST: the bus/feedback TOOL DEFINITIONS + the host own-layer/global
  // registrations + the redeliver driver + guiEndpointDeps + the Binder
  // buckets + the scheduler/health builders + the 9 GLOBAL host-plane tools,
  // 1231 LOCs): the FOURTH and FINAL cut of the tools zone (feedbackTool /
  // feedbackListTool / feedbackUpdateTool / sendMessageTool /
  // agentMessagesTool / deptWhoTool / feedbackEmitTools / feedbackHeadTools /
  // busTools / recipientCatalogAlive / deliverBusRecordForRedeliver /
  // redeliverPendingDeliveries / guiEndpointDeps / the late-binding register
  // buckets (DEAD since LANE DI-BY-SERVICES — the closure sets flow into the
  // deps holders) / the 6 W1 scheduler + 7 W6 health builder closures + the 9
  // global
  // host-plane tool registrations + the disposal ctx.effect) was hoisted
  // VERBATIM into src/core/orchestration/tools.ts and is returned by the SAME
  // factory invoked above (same fiber position). The destructure below
  // re-binds the apply-scope names at the SAME position the zone used to live
  // — the closures are the factory's, the consumers below (the W1 agenda
  // scheduler daemon, the W3b parallel monitor, the W6 health daemon, the
  // webServer mount, the RPC channel) are byte-unchanged. busTools /
  // feedbackEmitTools / feedbackHeadTools / redeliverPendingDeliveries are now
  // FACTORY-LOCALS (their 4 late seams are GONE), 18 NEW delivery-surface late
  // seams entered (the CUT4 tool executes + the binder buckets' lazy readers
  // dereference the delivery factory's members at CALL time — TDZ-safe), and
  // 27 new direct deps (sleepTool / subagents / wakePackService /
  // hostIdForSession / readJournal / journalPathFor / refreshPresence /
  // savePresence / notifyHostPresence / presenceCache / assembleHeartbeat /
  // roleForSessionLive / headRotationJournalStatus / verifyRotateReason /
  // resolveSessionProjCachePath / deliverDaemonNotice /
  // captureSchedulerAutoRunFailure) entered by reference. The destructure
  // grows to 29 members. MOVEMENT-ONLY: same closures, same order, 0 behavior
  // change. This COMPLETES the tools zone (CUT1 922 + CUT2 612 + CUT3 1273 +
  // CUT4 1231 = 4038 LOCs moved); the W1 agenda scheduler daemon + the W3b
  // parallel monitor + the W6 health daemon stay in the bundle untouched.
  // ---------------------------------------------------------------------------

  // --- W1 agenda scheduler daemon (spec 004 §5.7) ---------------------------
  // A plugin daemon (NOT an agent) that ticks every AGENDA_SCHEDULER_INTERVAL_MS:
  // (a) fires any cron-scheduled JOB whose next run is due within the desync
  // window and not already fired (job-runs-state.json ledger); (b) fires any
  // CALENDAR entry with `at ≤ now` and `fired:false` — a `jobId` entry runs the
  // job, a plain entry notifies the owning head with the label. Reversible
  // effect (AGENTS.md rule 4): the interval is cleared on dispose. NEVER throws
  // — the pure tick folds every internal failure to a warn.
  const AGENDA_SCHEDULER_INTERVAL_MS = 30 * 1000
  // DECOUPLING PASO 1 (daemons → dshd-jobs): the composed dshd-jobs plugin
  // provides `deepartments.jobs` — the bundle INVOKES THE SERVICE per tick
  // (the `jobs` binder bucket above carries the closure-bound deps the service
  // reads; a missing bucket at use fails loud R1 — the contract lock). In a
  // MINIMAL composition (dshd-jobs absent, e.g. the bundle-alone suite) the
  // bundle keeps the in-bundle tick with the SAME hoisted closures — R6
  // behavior-neutral (verified by the dshd-jobs daemon production closure test).
  const jobsService = ctx.get('deepartments.jobs') as
    | { runSchedulerTick(opts?: { now?: () => number }): Promise<void> }
    | undefined
  ctx.effect(() => {
    // INVARIANTE DE TICKS (post-incidente 2026-09-04): the interval callback
    // body is WRAPPED (wrapDaemonTick) — a synchronous throw never escapes the
    // setInterval (the daemon-liveness invariant, all 4 daemon intervals).
    const tick = wrapDaemonTick(ctx.logger, 'agenda scheduler', (): void => {
      if (jobsService !== undefined) {
        void jobsService.runSchedulerTick({ now: () => Date.now() })
      } else {
        void runAgendaSchedulerTick({
          now: () => Date.now(),
          departments: org.departments,
          repoRoot,
          calendarStateDir: stateDir,
          jobRunsStateDir: stateDir,
          headForDepartment: schedulerHeadForDepartment,
          runJob: schedulerRunJob,
          onAutoRunSkip: schedulerOnAutoRunSkip,
          notifyHead: schedulerNotifyHead,
          departmentForEntry: schedulerDepartmentForEntry,
          departmentForJob: schedulerDepartmentForJob,
          logger: ctx.logger
        })
      }
    })
    const interval = setInterval(tick, AGENDA_SCHEDULER_INTERVAL_MS)
    return () => { clearInterval(interval) }
  }, 'deepartments: agenda scheduler daemon')

  // --- W3b parallel-monitor daemon (Parallel event_stream monitors) --------
  // A plugin daemon (NOT an agent) that polls the configured Parallel monitors
  // and, on each NEW event, spawns a researcher DIRECTLY (through the SAME
  // worker-spawn engine a head uses — no tool-vs-daemon drift) and notifies the
  // research head (owner decision 2026-08-23: "cada vez que se active un
  // researcher también se tiene que activar su RH"). Reversible effect
  // (AGENTS.md rule 4): the interval is cleared on dispose. The monitors config
  // defaults live in DEFAULT_PARALLEL_MONITORS (code), so this runs on the dev
  // profile without touching the config (or /opt); a `parallel` config section
  // (apiKey/baseUrl/maxConsecutiveSpawns/monitors) overrides it when present.
  const PARALLEL_MONITOR_INTERVAL_MS = 20 * 1000
  const parallelConfig = (config as unknown as { parallel?: ParallelConfig }).parallel
  const parallelMonitors = resolveParallelMonitorConfig(parallelConfig)
  const parallelApiKey = parallelConfig?.apiKey ?? process.env.PARALLEL_API_KEY ?? ''
  const parallelBaseUrl = parallelConfig?.baseUrl ?? 'https://api.parallel.ai'
  const parallelMaxSpawns = parallelConfig?.maxConsecutiveSpawns ?? 2
  // The researcher worker lands under the research department; fall back to the
  // first CONFIGURED department with a coordinator when 'research' is absent.
  // NOTE: the department/head target is resolved LAZILY on EVERY tick (see
  // createParallelMonitorDaemon) — the boot race where the byPost registry is
  // still empty when this effect is registered must NOT permanently disable the
  // daemon (FIX: the old apply-time resolution read byPost before it was loaded,
  // so a boot-time empty registry left the daemon stuck disabled).
  if (parallelApiKey === '') {
    ctx.logger.warn('[deepartments] parallel-monitor: no PARALLEL_API_KEY / parallel.apiKey — monitoring daemon disabled (set an API key, or parallel.apiKey in the config, to enable)')
  } else if (parallelMonitors.length === 0) {
    ctx.logger.info('[deepartments] parallel-monitor: parallel.monitors is empty — monitoring disabled (explicit no-op)')
  } else {
    const parallelHeaders: Record<string, string> = { 'x-api-key': parallelApiKey, 'content-type': 'application/json' }
    // POST /v1/monitors — create the monitor on Parallel (runs immediately on
    // creation; the poller picks up its net-new events).
    const createMonitor = async (monitor: ParallelMonitorConfig): Promise<{ monitorId: string }> => {
      const body = {
        type: 'event_stream' as const,
        frequency: monitor.frequency ?? '1d',
        processor: monitor.processor ?? 'base',
        settings: {
          query: monitor.query,
          ...(monitor.outputSchema !== void 0 ? { output_schema: monitor.outputSchema } : {}),
          ...(monitor.includeBackfill === true ? { include_backfill: true } : {}),
          ...(monitor.sourcePolicy !== void 0 && monitor.sourcePolicy.length > 0
            ? { advanced_settings: { source_policy: { include_domains: monitor.sourcePolicy } } }
            : {})
        }
      }
      const res = await fetch(`${parallelBaseUrl}/v1/monitors`, { method: 'POST', headers: parallelHeaders, body: JSON.stringify(body) })
      if (!res.ok) throw new Error(`POST /v1/monitors ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
      const json = (await res.json()) as { monitor_id?: unknown }
      if (typeof json.monitor_id !== 'string' || json.monitor_id === '') throw new Error('POST /v1/monitors: response missing monitor_id')
      return { monitorId: json.monitor_id }
    }
    // GET /v1/monitors/{id}/events — cursor-paginated (newest first); GETs do
    // not consume rate limit (the poller). include_completions is LEFT OFF (we
    // only want the real detected events, not the no-change executions).
    const fetchEvents = async (monitorId: string, cursor: string | undefined): Promise<{ events: ParallelMonitorEvent[]; nextCursor?: string }> => {
      const url = new URL(`${parallelBaseUrl}/v1/monitors/${encodeURIComponent(monitorId)}/events`)
      url.searchParams.set('limit', '50')
      if (cursor !== void 0) url.searchParams.set('cursor', cursor)
      const res = await fetch(url.toString(), { headers: { 'x-api-key': parallelApiKey } })
      if (!res.ok) throw new Error(`GET /v1/monitors/${monitorId}/events ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
      const json = (await res.json()) as { events?: unknown; next_cursor?: unknown }
      const events = Array.isArray(json.events) ? (json.events as ParallelMonitorEvent[]) : []
      const nextCursor = typeof json.next_cursor === 'string' ? json.next_cursor : void 0
      return { events, ...(nextCursor !== void 0 ? { nextCursor } : {}) }
    }
    const daemon = createParallelMonitorDaemon({
      baseUrl: parallelBaseUrl,
      maxConsecutiveSpawns: parallelMaxSpawns,
      monitors: parallelMonitors,
      stateDir: stateDir,
      now: () => Date.now(),
      departments: org.departments,
      byPost,
      logger: ctx.logger,
      createMonitor,
      fetchEvents,
      countWorkers: (monitorId) => {
        let n = 0
        for (const entry of byPost.values()) {
          if (entry.provider === 'worker' && entry.retired !== true && entry.jobId === monitorId) n++
        }
        return n
      },
      spawnWorker: (department, head, opts) => spawnWorkerForDepartment(department, head, opts),
      // The daemon is NOT a catalog member, so the bus ACL would deny it —
      // deliver a fire-and-forget notice via the post-delivery seam (a
      // plugin-daemon system notice, framed `[From deepartments]`), exactly
      // like the agenda scheduler's notifyHead.
      notifyHead: async (head, monitor, event, workerId): Promise<void> => {
        try {
          const store = await messagesStoreReady
          const text = `A researcher is working (monitor ${monitor.id}): ${event.output?.content ?? '(no content)'}`
          const record = await store.append({ from: 'deepartments', to: [head.postId], text, kind: 'agent' })
          // B4 daemon re-wake gate: a DORMANT head (sleepEpoch set) is NOT re-woken
          // by this routine monitor notice — the record is already appended
          // durably (above), so deliverDaemonNotice returns 'queued' and the
          // notice drains at the head's next real wake. The deliberate worker
          // SPAWN (a separate path) is UNTOUCHED — a spawn must wake. The
          // ALWAYS-WAKE default is preserved for non-dormant heads.
          const outcome = await deliverDaemonNotice(head, record, `[From deepartments → ${head.postId}]: ${text}`, busDeliverToPost)
          if (outcome === 'queued') ctx.logger.info(`[deepartments] parallel-monitor: notice to "${head.postId}" queued (head is dormant — no wake)`)
        } catch (error: unknown) {
          ctx.logger.warn(`[deepartments] parallel-monitor: notify head failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
    ctx.effect(() => {
      // INVARIANTE DE TICKS (post-incidente 2026-09-04): the interval callback
      // body is WRAPPED (wrapDaemonTick) — a synchronous throw never escapes
      // the setInterval (the daemon-liveness invariant, all 4 daemon intervals).
      const interval = setInterval(wrapDaemonTick(ctx.logger, 'parallel-monitor', () => { void daemon.tick() }), PARALLEL_MONITOR_INTERVAL_MS)
      return () => { clearInterval(interval) }
    }, 'deepartments: parallel-monitor daemon')
  }

  // --- W6 system-health daemon (owner request 2026-08-23: "monitorizar que
  // todo va bien") -----------------------------------------------------------
  // A plugin daemon (NOT an agent) that every `health.intervalMs` (default
  // 60000) writes <stateDir>/health-heartbeat.json and scans post-errors.jsonl +
  // deliveries.jsonl for anomalies, alerting the HOST (the Asistente) by bus —
  // failures reach the Asistente. Reversible effect (AGENTS.md rule 4): the
  // interval is cleared on dispose. `health.enabled === false` → the daemon is
  // NOT registered (no heartbeat, no alerts) with a one-shot info log; absent
  // `health` → enabled (code default). The bootId is generated ONCE per plugin
  // apply (a per-process id stamped into the heartbeat; hoisted at the register
  // site — the `health` Binder bucket carries it).
  const healthConfig = config.health
  const healthEnabled = healthConfig?.enabled !== false
  const healthIntervalMs = healthConfig?.intervalMs ?? 60_000
  if (!healthEnabled) {
    ctx.logger.info('[deepartments] system-health: health.enabled === false — daemon disabled (no heartbeat, no alerts)')
  } else {
    // DECOUPLING PASO 1 (daemons → dshd-health): the composed dshd-health
    // plugin provides `deepartments.health` — the bundle INVOKES THE SERVICE
    // per tick, passing the PER-TICK live inputs EXPLICITLY (now/hosts/posts/
    // hostWaits/sessionContexts/hostRunning/deliveryRowsReader — the FRESH
    // per-tick computations the builders above produce) while the STATIC
    // per-process deps come from the `health` Binder bucket (bootId/config/
    // notifyHost/poolerStatePath/qiDirectiveRate/workRegisterPath — registered
    // at the register site above). The builders/notifyHost are HOISTED there,
    // so the SAME closures serve the (hermetic) inline fallback below — R6
    // behavior-neutral (the bundle-alone suite) and the composed service path
    // (the dev profile) run the IDENTICAL tick computation.
    const healthService = ctx.get('deepartments.health') as
      | { runDaemonTick(deps: {
          now?: () => number
          hosts?: Iterable<HostEntry>
          posts?: Iterable<PostActivityInput>
          hostRunning?: boolean
          sessionContexts?: Iterable<SessionContextInput>
          missionActivity?: Iterable<MissionActivityInput>
          mainRed?: MainRedRuntime
          missionQueue?: Iterable<MissionQueueInput>
          hostWaits?: Iterable<HostWaitPostInput>
          deliveryRowsReader?: unknown
          // LANE 0.2.1 (1C — health bucket ELIMINADO): the static per-process
          // paths the `health` Binder bucket used to carry now flow EXPLICITLY
          // per tick (the package derives the rest itself).
          poolerStatePath?: string
          workRegisterPath?: string
          // LANE 2 (fb-27): the turn/end-error HEAD notification closure
          // (widened cast — the `deliveryRowsReader` pattern; NOT added to
          // HealthBinderDeps, keeping the binder-contract intact).
          notifyHead?: unknown
          // POST-INCIDENTE 2026-09-04 (crash-loop 609 restarts / exit 7): the
          // heartbeat health datums — surface (the detected session surface),
          // nRestarts (the systemd NRestarts read once per boot) and
          // crashStreak (the boot-crash sidecar). Optional per-tick: ABSENT →
          // the field is omitted from the heartbeat.
          sessionSurface?: string
          nRestarts?: number
          crashStreak?: number
          // FINISHER (2026-09-04, addendum 4 — m-812, sweep observability): the
          // redelivery-sweep health datum — {armed, cycles, lastCycleTs?,
          // preparedStuckRemaining?} from the orchestration's redeliverySweepState
          // (the LANE ② non-boot re-drive sweep). Optional per-tick: ABSENT →
          // the sweep field is omitted from the heartbeat.
          sweep?: { armed: boolean; cycles: number; lastCycleTs?: number; preparedStuckRemaining?: number }
        }): Promise<void> }
      | undefined
    // POST-INCIDENTE 2026-09-04 — the CRASH-LOOP BREAKER setup (decision 4):
    // (a) the boot-crash sidecar stamp runs HERE — at APPLY START, BEFORE the
    // interval wiring — so a pre-tick crash (the incident class: a builder
    // throw in the un-wrapped interval callback phase) is recorded; the streak
    // is derived SYNCHRONOUSLY (read-only) so the tick reports a deterministic
    // value while the durable stamp write is fire-and-forget (best-effort,
    // never blocks apply — stampBootCrash re-derives the SAME value: its reads
    // happen before this boot's first heartbeat can exist).
    const healthCrashStreak = resolveBootCrashStreak(stateDir)
    void stampBootCrash(stateDir, healthBootId, Date.now())
    // (b) NRestarts — the systemd counter, read ONCE per boot (read-only
    // `systemctl show <unit> -p NRestarts`, best-effort); the unit name comes
    // from DEEPARTMENTS_SYSTEMD_UNIT (deployment-specific — absent → the tick
    // omits nRestarts and the health report reads it host-side).
    const systemdNRestartUnit = process.env.DEEPARTMENTS_SYSTEMD_UNIT
    let healthNRestarts: number | undefined = undefined
    if (systemdNRestartUnit !== undefined && systemdNRestartUnit.trim() !== '') {
      void resolveSystemdNRestarts(systemdNRestartUnit).then(
        (n) => { healthNRestarts = n },
        () => { /* best-effort — a read failure degrades to an omitted datum */ }
      )
    }
    // (c) the surface probe (decision 2): the detected session surface of the
    // LIVE probe session (the host first, then the first live post session —
    // the sessions the daemon's builders read). Fresh per tick (the runtime
    // surface cannot change mid-boot, but the probe is cheap and honest).
    const detectLiveSessionSurface = (): string => {
      for (const entry of hosts.values()) {
        if (entry.retired === true) continue
        const live = agents?.get(entry.sessionId)
        if (live?.session !== undefined) return detectSessionSurface(live.session as SessionLogLike)
      }
      for (const entry of byPost.values()) {
        if (entry.retired === true) continue
        const live = agents?.get(entry.sessionId)
        if (live?.session !== undefined) return detectSessionSurface(live.session as SessionLogLike)
      }
      return 'none'
    }
    // THE BOOT LOG (decision 2 — "log en boot"): the drift gate fires at
    // startup, BEFORE any churn — the surface + the breaker datums are visible
    // in the first boot's log (and later in the heartbeat / health report).
    ctx.logger.info(`[deepartments] system-health: boot ${healthBootId} started (crashStreak=${healthCrashStreak}, nRestarts=${healthNRestarts ?? 'n/a'}, session-surface=${detectLiveSessionSurface()})`)
    ctx.effect(() => {
      // C6: ONE tail reader per daemon — its byte-offset cursor survives ticks
      // (created here, outside the per-tick deps object), so a 60 s tick parses
      // only the deliveries rows appended since the previous tick instead of
      // re-reading the whole (unbounded-between-boots) sidecar. The scanner's
      // filter pipeline is unchanged → same findings, same alerts.
      const deliveryRowsTailReader = createDeliveryRowsTailReader()
      // W6-boot de-flake (LANE 4, 2026-09-01): the tick is fire-and-forget, so
      // clearInterval on dispose stops FUTURE ticks but an IN-FLIGHT async tick
      // keeps writing into stateDir AFTER dispose resolves — a consumer that
      // rm -rf's the stateDir right after `await dispose()` (the test teardown
      // harness) races that last write → ENOTEMPTY (the W6 boot / Bug A SOURCE
      // GATE / M-6 smoke flake class). The disposer now DRAINS every in-flight
      // tick before returning: disposing the daemon is an ORDERED shutdown —
      // no stateDir write can land after dispose resolves (the tick never
      // throws, so the drain is bounded and inert).
      let inFlight: Promise<void> | undefined
      // INVARIANTE DE TICKS (post-incidente 2026-09-04): the interval callback
      // BODY — the builder phase INCLUDED — is WRAPPED (wrapDaemonTick). THIS
      // was the incident's seam (invoke.ts:3457-3465 at the time): buildHealthPosts
      // + 6 builders ran OUTSIDE any try/catch BEFORE the internal tick-wrapped
      // body → a builder throw escaped the setInterval → exit 7 x 609 restarts.
      // The callback is now NOEXCEPT: the body's throw is logged and the daemon
      // lives for the next tick.
      const tick = wrapDaemonTick(ctx.logger, 'system-health', (): void => {
        // POST-INCIDENTE 2026-09-04 — the per-tick session-surface probe (the
        // heartbeat datum — decision 2). Computed per tick (cheap) so the
        // heartbeat always reports the CURRENT runtime surface.
        const sessionSurface = detectLiveSessionSurface()
        // M-7 — the mission-queue rows: the SAME catalog-post inputs the W8-c
        // safeguards scan (buildHealthPosts — the EXISTING per-tick source),
        // materialized ONCE per tick and filtered to non-retired HEADS (the
        // mission-queue watchdog thresholds buildPostSnapshot's pendingCount on
        // heads only — a worker's queue is never a mission backlog). The SAME
        // materialized array feeds BOTH `posts` and `missionQueue` (zero
        // double buildHealthPosts I/O per tick).
        const healthPosts = buildHealthPosts()
        const missionQueue = healthPosts.filter((p: PostActivityInput) => p.retired !== true && p.provider !== 'worker')
        let pending: Promise<unknown>
        if (healthService !== undefined) {
          pending = healthService.runDaemonTick({
            now: () => Date.now(),
            // POST-INCIDENTE 2026-09-04 — the heartbeat health datums (the
            // surface gate + the breaker: reported per tick, best-effort).
            sessionSurface,
            nRestarts: healthNRestarts,
            crashStreak: healthCrashStreak,
            // FINISHER (addendum 4 — m-812): the redelivery-sweep datum from
            // the orchestration (armed + the observed sweep counters).
            sweep: toolsSurface.redeliverySweepState(),
            // A FRESH single-use iterator per tick (Map.values() is single-use).
            hosts: hosts.values(),
            // W8-c: the catalog-post inputs (activity + inbox) for the turn-error
            // + stale-live safeguards — resolved lazily per tick.
            posts: healthPosts,
            // M4: the host's live running signal (absent agents registry →
            // undefined → the system-idle scan is a no-op).
            hostRunning: buildHostRunning(),
            // M-A: the context-pressure rows for the context-threshold watchdog
            // (absent sessionProjections service → undefined → the scan is a
            // no-op — unknown context pressure never fabricates an alert).
            sessionContexts: buildSessionContexts(),
            // M-5: the per-head-post mission-activity rows for the
            // mission-stalled watchdog (no live host / no message store →
            // undefined → the scan is a no-op — unknown delivery state never
            // fabricates an alert).
            missionActivity: buildMissionActivity({ stateDir, byPost, hosts: hosts.values(), agents }),
            missionQueue,
            // M-6: the main-red watchdog runtime (buildMainRedState over the
            // repo root — knob `mainRedRepoRoot` ?? REPO_ROOT; a non-git
            // composition → undefined → the scan is a no-op — unknown main
            // state never fabricates a post-commit alert).
            mainRed: buildMainRedState(healthConfig?.mainRedRepoRoot ?? repoRoot),
            // W8-d: the host-sender-aware inputs for the conditional system-wait
            // scan — resolved lazily per tick.
            hostWaits: buildHostWaits(),
            // C6: the bounded tail reader (absent → the legacy full read).
            deliveryRowsReader: deliveryRowsTailReader,
            // LANE 0.2.1 (1C — health bucket ELIMINADO): the STATIC per-process
            // paths + the bind that used to flow through the `health` Binder
            // bucket now pass EXPLICITLY like the inline fallback below (3409/
            // 3439-3441) — the package derives the REST itself (kbobs → its own
            // config row, notifyHost → the composed bus+deliver fallback,
            // bootId → its per-apply randomUUID; qiDirectiveRate → the
            // deepartments.healthDeps holder, untouched this lane).
            poolerStatePath: healthPoolerStatePath,
            workRegisterPath: healthConfig?.workRegisterPath !== undefined && healthConfig.workRegisterPath.trim() !== ''
              ? healthConfig.workRegisterPath
              : path.join(repoRoot, 'docs', 'WORK-REGISTER.md'),
            // LANE 2 (fb-27): the turn/end-error HEAD notification closure.
            notifyHead: healthNotifyHead
          })
        } else {
          pending = runHealthDaemonTick({
            now: () => Date.now(),
            stateDir: stateDir,
            bootId: healthBootId,
            // POST-INCIDENTE 2026-09-04 — the heartbeat health datums (the
            // surface gate + the breaker: reported per tick, best-effort).
            sessionSurface,
            nRestarts: healthNRestarts,
            crashStreak: healthCrashStreak,
            // FINISHER (addendum 4 — m-812): the redelivery-sweep datum from
            // the orchestration (armed + the observed sweep counters).
            sweep: toolsSurface.redeliverySweepState(),
            config,
            // A FRESH single-use iterator per tick (Map.values() is single-use).
            hosts: hosts.values(),
            // W8-c: the catalog-post inputs (activity + inbox) for the turn-error
            // + stale-live safeguards — resolved lazily per tick.
            posts: healthPosts,
            // M4: the host's live running signal (absent agents registry →
            // undefined → the system-idle scan is a no-op).
            hostRunning: buildHostRunning(),
            // M-A: the context-pressure rows for the context-threshold watchdog
            // (absent sessionProjections service → undefined → the scan is a
            // no-op — unknown context pressure never fabricates an alert).
            sessionContexts: buildSessionContexts(),
            // M-5: the per-head-post mission-activity rows for the
            // mission-stalled watchdog (no live host / no message store →
            // undefined → the scan is a no-op — unknown delivery state never
            // fabricates an alert).
            missionActivity: buildMissionActivity({ stateDir, byPost, hosts: hosts.values(), agents }),
            missionQueue,
            // M-6: the main-red watchdog runtime (buildMainRedState over the
            // repo root — knob `mainRedRepoRoot` ?? REPO_ROOT; a non-git
            // composition → undefined → the scan is a no-op — unknown main
            // state never fabricates a post-commit alert).
            mainRed: buildMainRedState(healthConfig?.mainRedRepoRoot ?? repoRoot),
            // W8-d: the host-sender-aware inputs for the conditional system-wait
            // scan — resolved lazily per tick.
            hostWaits: buildHostWaits(),
            // C6: the bounded tail reader (absent → the legacy full read).
            deliveryRowsReader: deliveryRowsTailReader,
            // M1 (a) — the pooler-capacity watchdog READS the pooler's OWN state
            // file (join(DSH_HOME||cwd,'keyPooler-state.json') — dshHome() at
            // :2542), SOLO-LECTURA (the pooler owns every write; the watchdog
            // never writes it). The `health.poolerStateFilePath` knob overrides
            // the path; absent dep → the scan is a no-op (hermetic tick tests).
            poolerStatePath: healthPoolerStatePath,
            // M1 (b) — the qi-silence watchdog shares the SAME worker-inspect dice
            // p as the directive EMITTER (single source of truth, resolved at
            // :1819) so its rate-aware minimum (P(0|p) ≤ 5% → ceil(ln(.05)/ln(1-p)))
            // tracks the real trigger probability; absent dep → 0.25 code default.
            qiDirectiveRate: qualityWorkerInspectProbability,
            // The daemon is NOT a catalog member, so the bus ACL would deny it —
            // deliver the alert via the HOST delivery seam directly, framing it
            // `[From deepartments] System-health ALERT:` (exactly like the other
            // daemons' notify hooks). The host entry is the LIVE Asistente entry
            // resolved per tick (setInterval re-evaluates, so the boot race where
            // the hosts registry is still empty cannot permanently disable it).
            // C8 (structural-loop invariant): the ALERT is delivered DIRECT here
            // (store.append + busDeliverToHost) — it NEVER goes through the
            // delivery engine, so NO 'prepared'/'failed' delivery row is ever
            // written for an ALERT → scanDeliveryFindings can never re-alert an
            // ALERT (the alert→delivery-failed→alert loop is impossible).
            notifyHost: healthNotifyHost,
            // LANE 2 (fb-27): the turn/end-error HEAD notification closure
            // (delivers `[From deepartments] Turn-error <cls> …` to the post's
            // own head via store.append + busDeliverToPost — the daemon→head
            // pattern, direct like the notifyHost ALERT).
            notifyHead: healthNotifyHead,
            // PACING (owner m-PACING, 2026-08-28): the repo WORK-REGISTER path —
            // read at a VALLE transition for the «reanuda; despachos diferidos:
            // N» count (best-effort; unreadable → the notice omits the count).
            // LANE 5 (fb-46): the work-register-idle watchdog reads the SAME
            // register — the `health.workRegisterPath` override (default the
            // repo docs/WORK-REGISTER.md; a packaged deployment or a hermetic/
            // smoke fixture points elsewhere — the poolerStateFilePath pattern).
            workRegisterPath: healthConfig?.workRegisterPath !== undefined && healthConfig.workRegisterPath.trim() !== ''
              ? healthConfig.workRegisterPath
              : path.join(repoRoot, 'docs', 'WORK-REGISTER.md'),
            logger: ctx.logger
          })
        }
        // Chain the in-flight run for the ordered dispose drain: an overlapping
        // tick (a slow run vs a fast interval) is ALSO awaited — allSettled
        // never rejects, so a tick failure can never wedge the shutdown.
        inFlight = Promise.allSettled(inFlight !== undefined ? [inFlight, pending] : [pending]).then(() => undefined)
      })
      const interval = setInterval(tick, healthIntervalMs)
      return async () => {
        clearInterval(interval)
        if (inFlight !== undefined) {
          try {
            await inFlight
          } catch {
            /* the tick contract never rejects — the drain is inert */
          }
        }
      }
    }, 'deepartments: system-health daemon')
  }

  // --- agents/list + host/status RPC (server half, HTTP self-mount) --------
  // LANE 0.2.3b (gui-split — TOTAL MODULARITY gap 3 cierre): THE MOUNT MOVED
  // INTO dshd-gui. The webServer MOUNT EFFECT (`ctx.inject(['webServer',
  // 'webRuntime', 'connection'], ...)` + the trust fence + the 6 exact routes
  // `/deepartments/agents|list|host/status|presence/get|presence/set|agenda/list`)
  // now lives in the PACKAGE's apply (packages/dshd-gui/src/index.ts — the
  // `deepartments.gui` service + the routes/trust-fence are package-internal);
  // the bundle no longer mounts the channel — it consumes what dshd-gui
  // provides (the `deepartments.guiDeps` holder fill in the tools factory +
  // this package's service). The HEADLESS loss is DOCUMENTED with the mount's
  // existing justification (moved with the effect):
  //   «when absent (headless / host-less) the channel — a GUI feature — is
  //   skipped silently, exactly like the old `connection !== void 0` gate (the
  //   client is the only consumer)» (was invoke.ts:3565-3567)
  //   «skip silently (headless / host-less) if webServer is absent — the
  //   channel is a GUI feature and the client is the only consumer, exactly
  //   like the old `connection !== void 0` gate» (was invoke.ts:3577-3579).
  // In a minimal composition WITHOUT dshd-gui the /deepartments channel no
  // longer exists (accepted design — R6; the bundle keeps no inline fallback).
  // Behavior preserved: the GUI/sidebar/routes are unchanged (the same 6
  // byte-identical paths registered by dshd-gui; the smoke-boot route lock +
  // the post-boot client-graph canary stay green).

}
