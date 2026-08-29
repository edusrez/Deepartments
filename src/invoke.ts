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
import { execFile as execFileCb, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { findSessionArtifact, runSleepCleanup, type SleepCleanupReport } from './core/session-cleanup.js'

/** Module-level promisified execFile (dept_exec's runDeptExec/runDeptZstdRead
 * use it; the apply-scope `execFileP` below is the same binding for legacy
 * code). */
const execFileP = promisify(execFileCb)
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
  Binder,
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
  SessionContextInput
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
  PresenceState,
  WebServerRouteLike,
  WebServerLike
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



/**
 * Loose structural view of `ctx.connection` — the optional Host Connection
 * service provided by the SEPARATE dsh-client-connection plugin (NOT present
 * in headless profiles). Mirroring the existing `PersistenceLike` pattern in
 * src/org.ts: we avoid a hard (peer) dependency on the client-connection
 * package by declaring only the one surface the sidebar RPC registration needs.
 */
interface ConnectionLike {
  rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
      options: { authority: 'loopback' | 'trusted-host' }
    ): () => Promise<void>
  }
  /** The deployment's trusted authorities this connection channel vets every
   * request against (dsh-client-connection HostConnectionService.trustedHosts,
   * seeded by `--trusted-host ...` on the systemd unit). Read here as the
   * authoritative trusted-hosts source for the self-mounted `/deepartments`
   * routes (see the RPC effect below). */
  trustedHosts?: string[]
}

/** Loose structural view of a live `Agent` (the shape `ctx.agents.get(id)`
 * returns; rc.8 dsh-agent runtime-types.d.ts:60-133). Declared structurally so
 * the plugin never hard-depends on `@deepseek-ai/dsh-agent` — it resolves the
 * `agents` service optionall  y via `ctx.get('agents')` (the existing seam in
 * this file). Only the surface the head lifecycle needs is declared. */
interface AgentLike {
  id: string
  status: string
  ctx: Context
  /** The agent's durable session event log. Present on the real loop Agent
   * (`this.session.events`) and on the test stub. Its length is the Fix A2
   * stuck-head progress signature (every appended step/turn/assistant event
   * is observable lifecycle progress). Declared structurally; absent/undefined
   * → treated as no signal (never misclassified as progression). */
  session?: { events: unknown[] }
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
 * mask/…) is still denied there. */
export const DEPT_EXEC_DENYLIST: readonly string[] = [
  'reboot', 'shutdown', 'poweroff', 'halt', 'init 0',
  'sudo', 'su -', 'mkfs', 'fdisk', 'parted', 'dd if=', 'rm -rf /',
  'nsenter', ':(){'
]

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
 * Multi-segment and letter-bearing absolute words are STILL path words and are
 * checked EXACTLY as before. */
function deptExecIsPathWord(token: string): boolean {
  const rest = token.replace(/^\/+/, '')
  if (rest === '') return false
  return !/^[0-9]+$/.test(rest)
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
 * paths); real letter-bearing/multi-segment absolute words are checked exactly
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
  return 'owner absent (presence flag)'
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
  const titleEvents = session.events as readonly { type: string; data?: { source?: { kind?: string } } }[]
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

export function applyInvoke(ctx: Context, config: Config) {
  // --- optional continuation services (resolved, not injected: the plugin
  // must load in minimal compositions — the board core keeps working, the
  // invoke/relay features fail loud at use when the services are absent) ---
  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents') as AgentsLike | undefined
  // The agentPresets service is also resolved OPTIONALLY (absent in minimal /
  // hermetic compositions): the head setup mounts the 'deepartments-head'
  // preset when present, and ALWAYS registers its board tools regardless.
  const agentPresets = ctx.get('agentPresets') as AgentPresetsLike | undefined

  // FASE 2.6 BATCH A (config relocation): the org config + stateDir are relocated
  // to dshd-core, which exposes them as `deepartments.org` — the SHARED CONFIG
  // SOURCE. The bundle reads THAT source first and falls back to its own patch
  // config (config.stateDir / config.org) in a minimal/hermetic composition (e.g.
  // the hermetic real-Loader tests, where dshd-core is NOT composed).
  // BEHAVIOR-NEUTRAL: the fallback resolves to EXACTLY config.stateDir /
  // config.org, and when dshd-core is composed the values are the SAME (the
  // dshd-core row carries the org). `stateDir`/`org` are the ONLY local bindings
  // every consumer below reads (they replace the direct config.* reads).
  const coreOrg = ctx.get('deepartments.org') as
    | { stateDir?: string; org?: { departments?: DepartmentConfig[]; execRoots?: string[]; missionExecRoots?: string[]; poolerBaseURL?: string; postsRetention?: PostsRetentionConfig } }
    | undefined
  // `cfg` alias: the fallback reads the bundle's OWN patch config without the
  // `config.stateDir` / `config.org` TOKENS that the body-wide replacement below
  // rewrites into `stateDir` / `org` — a naive match would make the initializer
  // self-referencing (const stateDir = ... ?? stateDir, a TDZ error).
  const cfg = config
  const stateDir = coreOrg?.stateDir ?? cfg.stateDir
  const org = (coreOrg?.org ?? cfg.org) as Config['org']

  // --- mutable state (all owned by this invocation's closure; reversible) ---
  // FASE 2 step (a): the DURABLE REGISTRY (the single source of the hosts/posts
  // catalog) is constructed here on the plugin fiber — AGENTS.md rule 4 (no
  // module-global mutable state). It owns the in-memory catalog maps + the
  // durable read/persist + registerEntry/ensureHost/markRetired. The consts
  // below are references to its maps so EVERY existing consumer reads/writes
  // the SAME live catalog (behavior-neutral, R6 byte-compatible on disk).
  // FASE 2.5 BATCH B: the catalog is now a dshd-core SERVICE
  // (`ctx.get('deepartments.catalog')`). In the FULL composition dshd-core
  // applied first and provided it; in a MINIMAL composition (dshd-core absent)
  // we fall back to a behavior-neutral in-bundle construction + a warn.
  const registry = (ctx.get('deepartments.catalog') as RegistryStore | undefined) ?? ((): RegistryStore => {
    ctx.logger.warn('[deepartments] dshd-core is not composed — the catalog is constructed in-bundle (behavior-neutral fallback).')
    return new RegistryStore({ stateDir: stateDir, logger: ctx.logger })
  })()
  const byPost = registry.byPost
  // QD (spec 007 §4.1): the resolved worker-archive dice probability from the
  // `quality` config block (absent/invalid → code default 0.25). Consumed by
  // the worker-retire hook; the head+host 100% mandate is NOT resolved here.
  const qualityWorkerInspectProbability = resolveQualityWorkerInspectProbability(config)
  const byChild = registry.byChild
  // Batch 1a: the live AgentHandle of each materialized head keyed by its
  // session id. create/resume return the handle (the ONLY disposer — a bare
  // `agents.get(id)` returns no dispose; rc.8 dsh-agent index.d.ts:349 vs
  // 155-158), so `dept_sleep` can tear a head down. Held by the plugin owner,
  // never by the head agent itself. Cleared when a head sleeps.
  const byHeadHandle = new Map<string, AgentHandleLike>()
  // Fix sleep-self-deadlock (2026-08-23 — explore-deep/2026-08-23-head-sleep-hang.md
  // §5a): the in-flight per-session dispose promises. `dept_sleep` fires the
  // calling agent's OWN handle dispose fire-and-forget (it may not await it
  // from its own turn — the harness dispose() sends machine.cancel + awaits
  // machine.whenIdle(), the very driver that is executing the tool), so a
  // CONCURRENT disposer of the same session (a bus wake respawn, a double
  // dept_sleep) must JOIN the same detach promise instead of racing a second
  // dispose over the not-yet-detached machine. Each entry is dropped in
  // `finally` once settled — a lingering settled entry would otherwise dedupe
  // the NEXT dispose of a RE-materialized handle.
  const disposingHeads = new Map<string, Promise<void>>()
  // Fix A2 — per-head wake progress tracker: headSessionId → { at, eventCount }.
  // `at` = when we last observed this head, `eventCount` = the watermark of its
  // session event log (AgentLike.session.events.length) at that time. The relay
  // uses it to tell a HEALTHY live-but-busy head (event log still growing —
  // its turn/step/assistant events keep appending) from a STUCK one (status
  // 'running' with NO new event for STUCK_HEAD_MS — the resident loop is wedged).
  // Purely in-memory and intentionally NOT durable: the durable board record is
  // the re-delivery source, so an in-memory reset is always safe.
  const headProgress = new Map<string, { at: number; eventCount: number }>()
  // Fix A2 — serialize the DISPOSE-then-cold-resume stuck-recovery per head
  // session. The relay is synchronous and a stuck path must dispose its frozen
  // handle BEFORE wakePost cold-resumes it (otherwise wakePost would find the
  // stale live handle and followup the wedged loop again). A per-session tail
  // promise makes concurrent wake pushes to the SAME head run the recovery one
  // at a time — the "never double-resume" guard stays true across bursts.
  const headRecoveryQueues = new Map<string, Promise<unknown>>()
  const serializeHeadRecovery = <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
    const previous = headRecoveryQueues.get(sessionId) ?? Promise.resolve()
    const run = previous.then(task, task)
    headRecoveryQueues.set(sessionId, run.then(() => void 0, () => void 0))
    return run
  }
  // Batch C — which LIVE agent sessions have already had the (freshly-injected)
  // Deepartments wake pack placed in their context THIS awake session. The pack
  // is now injected at `agent/pre-step` message-arrival time (NOT frozen at
  // dept_sleep), so this set stops the per-turn injector from re-injecting the
  // ~5kB pack on every model step of a long session. Keyed by the agent SESSION
  // id (`agent.id`), because the pre-step decision.messages only carries the
  // per-step claimed input and does NOT retain prior injected nodes (the
  // `pack-v1: present` sentinel is NOT visible across steps), so a durable
  // session-scoped flag is the reliable presence gate. Cleared in the host
  // dept_sleep branch so a post-sleep wake re-injects a FRESH pack.
  const wakePackInjected = new Set<string>()
  // Fix A — deferred in-place surface reset intent for the host dept_sleep
  // branch (see the Batch 7 helper comment + dept_sleep Step 3): the close
  // branch PLAIN-APPENDS the journal node and records sessionId → the
  // seeded/bumped journal text here; the NEXT `agent/pre-step` (the injector
  // below) performs the full-window replace over ALL current nodes INCLUDING
  // the still-pending dept_sleep tool result, so the assistant tool-call
  // message and its result remain a legal sequence and no orphaned role:'tool'
  // node ever reaches the strict opencode-go API (wake-7 400
  // INVALID_REQUEST root cause — explore-deep/2026-08-21-failedmessages-tool-
  // role-error.md). The seeded text is carried (NOT re-read) so the wake
  // replace re-lands a byte-identical journal node and still works if the file
  // vanished meanwhile. Consumed once at the first post-sleep pre-step.
  // Fix wake-12: this map is IN-MEMORY ONLY — it dies with the process — so
  // the same seed is mirrored durably into HostEntry.deferredJournalSeed
  // (hosts.json) at dept_sleep and RESTORED into this map by the hosts loader
  // at boot; a sleep→restart cycle therefore still folds at the first pre-step
  // of the new process (see the loader + the pre-step consume below).
  const deferredSleepReplace = new Map<string, string>()
  // B3 cutover: room read-cursors are GONE (no board, no read-delta). A legacy
  // `<stateDir>/cursors.json` may still exist on upgraded stateDirs — it is
  // deliberately LEFT INERT (no readers, no writers; the file itself is not
  // deleted here — state migration is the B3 migration step).

  // --- host registry (hostId → entry, plus sessionId → hostId reverse) ------
  // (owned by the RegistryStore above; referenced here so every consumer — the
  // bus delivery, the roster, the health daemon — reads the SAME live host
  // catalog the store persists.)
  const hosts = registry.hosts
  const hostForSession = registry.hostForSession

  /** C1/C3 (m-264) — the SINGLE shared catalog row builder. One source of truth
   * for a dept_who-like row {agentId, kind:'head'|'worker'|'host', title, state}
   * plus every other data field the `dept_who` output carries: BOTH the
   * `dept_who` execute (scope filtering) AND the deploy/retire `activeMembers`
   * echo consume THIS builder, so the echo and the default view can never
   * diverge. State via the shared `computeDeptWhoState` (live/running = agents
   * registry presence/status); title = coordinator.title → coordinator.role →
   * entry.role → entry.postId; kind derived 'worker' (provider:'worker') vs
   * 'head'. Order: hosts first, then posts (the dept_who catalog order — kept
   * for BOTH consumers). NOTE: references `coordinatorForPost` (declared LATER
   * in this closure) — legal because the builder only ever RUNS inside async
   * executes, after apply() has fully initialized the scope (the const
   * declaration order is not blocking for invocation). */
  type CatalogRow = {
    agentId: string
    kind: 'head' | 'worker' | 'host'
    title: string
    live: boolean
    sleeping: boolean
    state: DeptWhoState
    sessionId: string
    retired: boolean
    departmentId?: string
    role?: string
    jobId?: string
  }
  const buildCatalogRows = (): CatalogRow[] => {
    const rows: CatalogRow[] = []
    for (const entry of hosts.values()) {
      // m-64: the coherent single-state resolution. `live` is registry
      // PRESENCE (AgentHandle present); `running` refines it to a turn IN
      // FLIGHT (agents.get(sid).status === 'running'); `state` collapses
      // live/sleeping/retired into one contradiction-free enum token.
      const hostAgent = agents !== void 0 ? agents.get(SessionId(entry.sessionId)) : undefined
      rows.push({
        agentId: entry.hostId,
        kind: 'host',
        title: 'Asistente',
        live: hostAgent !== undefined,
        sleeping: entry.sleepEpoch !== void 0,
        state: computeDeptWhoState({
          retired: entry.retired === true,
          sleeping: entry.sleepEpoch !== void 0,
          live: hostAgent !== undefined,
          running: hostAgent?.status === 'running'
        }),
        sessionId: entry.sessionId,
        retired: entry.retired === true
      })
    }
    for (const entry of byPost.values()) {
      const coordinator = coordinatorForPost(entry.postId)
      const isWorker = entry.provider === 'worker'
      // m-64/m-228: a retired post is NEVER live, even when its AgentHandle
      // lingers in the registry (the deploy-restart case) — the data field
      // stays live:false so any consumer (and the render) reads a consistent
      // 'offline, retired', never the contradictory 'live, retired'.
      const postAgent = agents !== void 0 ? agents.get(SessionId(entry.sessionId)) : undefined
      const postLive = entry.retired !== true && postAgent !== undefined
      rows.push({
        agentId: entry.postId,
        // F1: kind derived — a disposable worker is 'worker'; every other
        // post (configured head) is 'head' (pre-F1 hardcode).
        kind: isWorker ? 'worker' : 'head',
        // Spec §6: coordinator.title for department heads; PostEntry.role
        // fallback for worker posts. Fallback chain follows head-presets.ts
        // (`headRoleLine`, the established convention): title → role → postId.
        title: coordinator?.title || coordinator?.role || entry.role || entry.postId,
        live: postLive,
        sleeping: entry.sleepEpoch !== void 0,
        state: computeDeptWhoState({
          retired: entry.retired === true,
          sleeping: entry.sleepEpoch !== void 0,
          live: postLive,
          running: postAgent?.status === 'running'
        }),
        sessionId: entry.sessionId,
        retired: entry.retired === true,
        // F3 (§5.1): worker rows carry the department template/department
        // link + job link (conditioned — never undefined, F9 lossless).
        ...(isWorker && entry.departmentId !== void 0 ? { departmentId: entry.departmentId } : {}),
        ...(isWorker && entry.role !== void 0 ? { role: entry.role } : {}),
        ...(isWorker && entry.jobId !== void 0 ? { jobId: entry.jobId } : {})
      })
    }
    return rows
  }

  /** C3 (m-264) — the compact, JSON-lossless ACTIVE member echo returned by the
   * deploy/retire tools AFTER a mutation so a caller sees the updated live
   * catalog immediately. The SAME shared builder the dept_who default view uses,
   * filtered to non-retired rows whose state is {idle, running} — NO
   * sleeping/offline/retired member ever shows in the echo. */
  const activeCatalogMembers = (): Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }> =>
    buildCatalogRows()
      .filter((row) => row.retired !== true && (row.state === 'idle' || row.state === 'running'))
      .map((row) => ({ agentId: row.agentId, kind: row.kind, title: row.title, state: row.state }))

  /** A4/C3 — the shared `activeMembers` output-schema fragment (a compact,
   * JSON-lossless active member list: `{ agentId, kind, title, state }`). */
  const activeMembersSchema = {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agentId: { type: 'string', required: true },
        kind: { type: 'string', enum: ['head', 'worker', 'host'], required: true },
        title: { type: 'string', required: true },
        state: { type: 'string', enum: ['running', 'idle', 'sleeping', 'offline'], required: true }
      }
    }
  } as const

  /** C3 — the compact ONE-LINE active-roster suffix shared by the 5
   * deploy/retire renders (m-264): `active roster: id (kind, "title"), …`
   * — one line, so the post-mutation echo reads the roster, not a count. */
  const renderActiveRoster = (members: ReadonlyArray<{ agentId: string; kind: string; title: string }>): string =>
    `active roster: ${members.map((m) => `${m.agentId} (${m.kind}, "${m.title}")`).join(', ')}`

  /** R1 (m-264): ONE shared definition per lifecycle tool — dept_memo_write,
   * dept_sleep and dept_post_retire were each defineTool'd TWICE (post own-layer
   * in installHeadBoardTools + the global host plane) with duplicated
   * describe/parameters/schema/render. These factories single-source the full
   * specification; the two registration sites stay EXACTLY where they were and
   * differ ONLY in the lifecycle `execute` branch (post own-layer → head/worker
   * path; global host plane → host path). Behavior is unchanged; for
   * dept_post_retire the executes were already identical, so it is ONE shared
   * ToolDefinition registered in both planes. */
  const memoWriteTool = (hostPlane: boolean) => defineTool({
    name: 'dept_memo_write',
    description: 'Write this department member\'s long-term memory to its journal (a department head or worker; from the host plane, the HOST Asistente): a durable, schema-constrained markdown memo at <stateDir>/journals/<memberId>.md (frontmatter author/room/timestamp/wake_counter/last_wake/board_cursor + decisions/constraints/openItems (+ optional current_step) + a free-form summary with a wake-routine footer). A registered head writes journals/<postId>.md; a HOST (no registered post) writes journals/host-<sessionId>.md. Use it BEFORE sleeping to hand your memory to your future (re-materialized) self. Returns the durable memo path.',
    parameters: {
      summary: { type: 'string', required: true, description: 'The memo body: a summary of your state, conclusions, and what your next incarnation must know.' },
      decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions taken (optional).' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints your future self must respect (optional).' },
      openItems: { type: 'array', items: { type: 'string' }, description: 'Open items for your future self (optional).' },
      currentStep: { type: 'string', description: 'Where you currently are (explicit durable state): a short status line the next wake can verify against (current_step in the journal). Optional.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          room: { type: 'string', required: true },
          member: { type: 'string', required: true },
          memoPath: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `journal written: ${value.memoPath}` } as const]
    },
    async execute(args, exec): Promise<{ room: string; member: string; memoPath: string }> {
      return lifecycle.memoWrite(args, exec as Parameters<typeof lifecycle.memoWrite>[1], hostPlane)
    }
  })

  const sleepTool = (hostPlane: boolean) => defineTool({
    name: 'dept_sleep',
    description: 'Sleep (dormir): persist your memory to your journal (dept_memo_write MUST be called first — this is enforced) and mark yourself for a context RESET. Conclude the turn after calling this; on your NEXT wake you are recreated as a FRESH incarnation. For a department HEAD (F8): your live AgentHandle is disposed, your durable session is ARCHIVED server-side (the sidebar row disappears, the journal + messages stay), and your next wake creates a NEW session — you keep your identity but get a fresh context. A disposable WORKER keeps the legacy cold-resume of the same session (worker retire is the separate archive path). For the HOST Asistente (host plane) it ROTATES the host session (spec 002): the old session is retired + archived server-side and a NEW session seeded with the re-keyed journal becomes the registered host (durable host sleepEpoch set on the new entry), then the turn concludes (falls back to the legacy in-place reset when the rotation cannot run). Rejects loudly if no journal has been saved.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          room: { type: 'string', required: true },
          member: { type: 'string', required: true },
          memoPath: { type: 'string', required: true },
          sleepEpoch: { type: 'number', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `sleeping: ${value.member} marked for context reset (epoch ${value.sleepEpoch}); journal: ${value.memoPath}` } as const]
    },
    async execute(_args, exec): Promise<{ room: string; member: string; memoPath: string; sleepEpoch: number }> {
      if (hostPlane) return lifecycle.sleepHost(_args, exec as Parameters<typeof lifecycle.sleepHost>[1])
      return lifecycle.sleepMember(_args, exec as Parameters<typeof lifecycle.sleepMember>[1])
    }
  })

  const postRetireTool = defineTool({
    name: 'dept_post_retire',
    description: 'Retire a registered post (spec 004 §4.3 — retirement is MARKED, never erased): for a DISPOSABLE WORKER it marks the entry `retired: true` (the post stays in the registry and its history stays queryable; every live-catalog consumer — busDeliverCatalog addressing, dept_who, the wake-pack roster — filters it) and disposes its live AgentHandle; a permanent CONFIGURED head keeps today\'s semantics (registry entry removed, re-materialized by config at boot). Scope: a HEAD caller may retire ONLY the DISPOSABLE WORKERS of its own department (the workers it created — managerId match — or the workers of its own config department; a worker of another head/department and a permanent department head are rejected loudly); a HOST caller may retire any registered post. Unknown postIds are rejected loudly.',
    parameters: {
      postId: { type: 'string', required: true, description: 'The post id to retire (e.g. "research-head").' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          postId: { type: 'string', required: true },
          retired: { type: 'boolean', required: true },
          activeMembers: activeMembersSchema
        }
      },
      render: (_args, value) => [{ type: 'text', text: `retired ${value.postId} (${renderActiveRoster(value.activeMembers)})` } as const]
    },
    async execute(args, exec): Promise<{ postId: string; retired: boolean; activeMembers: Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }> }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_post_retire requires a calling agent (exec.agent was undefined)')
      // Delegate to the shared retirement path (Batch 3a): a HOST caller (no
      // registered post) may retire any post; a head caller is scoped by
      // retirePost's F1 checks (own workers only — today's semantics preserved).
      const result = await retirePost(args.postId, agent.id as string)
      return { ...result, activeMembers: activeCatalogMembers() }
    }
  })

  // Fire-and-forget persistence of the host registry (callers never await it).
  // (The durable write + `.bak` backup live in the RegistryStore.)
  const persistHosts = (): void => { registry.persistHosts() }

  // U1 REMOVED (custom-sidebar removal): the persistent UI config
  // (`uiConfig`/`persistUiConfig`/`ui.json` — the `sidebarEnabled` toggle) is
  // gone with the removed sidebar; `/.deepartments/ui.json` is deleted as the
  // separate migration step. Nothing reads or writes it anymore.

  /**
   * Lazy host registration: called from the host-plane tools when the calling
   * agent has no post entry (it may be a HOST Asistente session). Records the
   * deterministic `host-<sessionId>` address and refreshes the durable
   * identity (hostId/sessionId). CONTRACT (postmortem nº5 + relay-fix,
   * 2026-08-22 + host-roomId latch fix, 2026-08-22; B3: roomId is now an INERT
   * registry field — the caller passes the registry default `'board'` since no
   * board tool carries a room anymore):
   *   - NEW registration (hostId absent): allowed ONLY when no other live
   *     (non-retired) host entry exists — the FIRST host registers; any
   *     further session is REFUSED (warn + NO entry; the session stays a
   *     plain session, spec 002 §4/C1) and the EXISTING live host's id is
   *     returned so bus member resolution keeps a valid member id.
   *   - REFRESH (hostId present, non-retired): always allowed, and MERGES —
   *     it preserves every field ensureHost does not own (rotation-successor
   *     metadata: previousSessionId/sleepEpoch/boundarySeq, retire evidence)
   *     instead of replacing the whole entry, and KEEPS `existing.roomId`
   *     VERBATIM (roomId is never re-derived anywhere anymore).
   *   - RETIRED re-registration: refused (unchanged).
   * Never fabricates a host at boot — only a live tool call registers one
   * (dept_who / send_message self-register through the B3 gap fix).
   */
  const ensureHost = (sessionId: string, roomId: string): string =>
    registry.ensureHost(sessionId, roomId, {
      // U4 — pin the durable "Asistente" title (the ctx-dependent side effect
      // the store injects via this hook at the exact post-guard point the
      // pre-extraction ensureHost pinned it).
      pinHostTitle: (sid) => {
        const titleSession = ctx.sessions.get(SessionId(sid))
        if (titleSession !== void 0) {
          const titlePin = pinHostSessionTitle(titleSession)
          if (titlePin === 'pinned') {
            ctx.logger.info(`[deepartments] ensureHost: pinned host session title "${ASISTENTE_SESSION_TITLE}" (${sid})`)
          } else if (titlePin === 'failed') {
            ctx.logger.warn(`[deepartments] ensureHost: host session title pin failed for ${sid} (non-fatal — host registration continues)`)
          }
        }
      }
    })

  /** Deterministic durable member id for a HOST session (Batch 7): the same
   * `host-<sessionId>` address used for the journal path and hosts.json. */
  const hostIdForSession = (sessionId: string): string => registry.hostIdForSession(sessionId)

  // Persistence of the post registry. Callers MAY await it (returns the write
  // promise) so a durability-critical step (the dept_sleep sleepEpoch mark) can
  // be gated on the write completing; all other callers keep the fire-and-forget
  // shape (`persistPosts()` as a statement ignores the returned promise). The
  // promise ALWAYS settles — a failed write resolves (the error is logged), never
  // rejects — so an awaiting caller can never be thrown on a disk hiccup.
  const persistPosts = (): Promise<void> => registry.persistPosts()

  const registerEntry = (entry: PostEntry) => registry.registerEntry(entry)

  const postIdForChild = (childId: string): string | undefined => registry.postIdForChild(childId)

  // --- Feature A — owner-presence state + host notify + ask_user guard ------
  // `<stateDir>/presence.json` is the durable source; the in-memory `presenceCache`
  // is the SYNCHRONOUS view the guard + the A3 `ask_user_question` guard read (a
  // guard runs at tool-call time, before any await, so it cannot await a disk
  // read). Seeded at apply time (readFileSync — a tiny one-off), refreshed at
  // every host pre-step (so the guard's synchronous view stays current even if
  // the file is edited outside the RPC), and updated atomically on every
  // `presence/set`. Per-apply closure only (AGENTS.md rule 4 — no
  // module-global mutable state). Default present:true (owner is here until
  // toggled absent — the guard is never over-eager at boot). A4 dedup
  // (2026-08-23): the pre-step no longer injects a presence TRANSITION node —
  // the only transition channel is the bus notify (`notifyHostPresence`); the
  // current state is baked into every host wake pack via buildWakePack.
  const presenceCache: PresenceState = readPresenceStateFile(stateDir)
  const refreshPresence = (): void => {
    const next = readPresenceStateFile(stateDir)
    presenceCache.present = next.present
    if (next.updatedAt !== undefined) presenceCache.updatedAt = next.updatedAt
  }
  const savePresence = async (state: PresenceState): Promise<void> => {
    // Cache FIRST (the guard + pre-step injector read the cache directly on the
    // next model step), then persist best-effort — an RPC never fails on a
    // write error (folded to a warn).
    presenceCache.present = state.present
    presenceCache.updatedAt = state.updatedAt
    try {
      await writePresenceStateFile(stateDir, state)
    } catch (error) {
      ctx.logger.warn(`[deepartments] presence.json write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // A3 — fire-and-forget HOST notification on a presence CHANGE, reusing the
  // SAME live-host followup seam the bus delivery uses (busDeliverToHost's live
  // branch — a resident host picks the change up on its next turn even while
  // idle). With A4 dedup (2026-08-23) this is now the ONLY transition channel:
  // a dormant host is never woken here — the current state is baked into every
  // host wake pack via buildWakePack. Never awaits, never throws.
  const notifyHostPresence = (present: boolean): void => {
    try {
      const { live } = pickLiveHostEntry(hosts.values())
      if (live === undefined) return
      const sessionId = String(SessionId(live.sessionId))
      const target = agents?.get(sessionId)
      if (target === undefined) return
      target.followup(buildPresenceMessage(present))
    } catch (error) {
      ctx.logger.warn(`[deepartments] presence change notify to host failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // A3 — gate the HOST's `ask_user_question`: when the owner is ABSENT the host
  // must not block on a question only the owner can answer (the model fails
  // loud and picks another path instead of hanging). Plain-context → GLOBAL
  // guard (the plugin owns no scoped host ctx — explore report A3); the denial
  // is NARROW (owner-absent + exactly `ask_user_question` + registered-host
  // caller) so presence absence can never break any other tool and never gates
  // a post/worker/subagent. Reversible effect (AGENTS.md rule 4).
  ctx.effect(() => {
    const dispose = ctx.tools.guard((exec) => askUserGuardReason(exec, {
      present: () => presenceCache.present !== false,
      isHostAgent: (sessionId) => {
        if (postIdForChild(sessionId) !== undefined) return false
        const entry = hosts.get(hostIdForSession(sessionId))
        return entry !== undefined && entry.retired !== true
      }
    }))
    return () => { dispose() }
  }, 'deepartments: owner-presence ask_user gate')

  // Best-effort cold load of the post registry. Batch 1a: entries carry the
  // root-agent `sessionId` (head-<postId>). Legacy entries from the previous
  // continuable-subagent model carry childId/parentId WITHOUT a sessionId —
  // they referenced a subagent continuation that no longer exists, so they are
  // NOT registered (kept out of the in-memory registry only; posts.json is
  // untouched until a later persistPosts overwrites it — reversible). The
  // configured coordinator is then re-created fresh as a root agent by
  // ensureHeads on boot; the old durable subagent session is never woken.
  const registryLoaded = registry.loadPosts().catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.logger.warn(`[deepartments] posts.json load failed (starting with an empty registry): ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // Best-effort cold load of the host registry. Reconciliation choice (Batch
  // A): we do NOT drop entries whose session has no live agent — a
  // cold-restarted host session is non-resident until reopened, and dropping
  // it would erase a legitimate host's identity. We keep it; the relay
  // SKIPS+WARNS when the target session is not live. Only a real join (lazy
  // ensureHost on a live tool call) registers/refreshes a host.
  const hostsLoaded = registry.loadHosts({ deferredSleepReplace }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.logger.warn(`[deepartments] hosts.json load failed (starting with an empty registry): ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // --- Web-UI sleep cleanup at boot (Option A; src/session-cleanup.ts) -------
  // After a REAL host dept_sleep set `webUiCleanupPending`, the FIRST boot
  // performs the GUI cleanup exactly once — truncate the host session artifact
  // to header + permission + the last append-origin journal node (renumbered
  // 0..k so the next resume accepts it), reset its projection-cache row, and
  // archive+delete the direct child subagent dirs — then clears the flag so
  // mid-wake restarts are exact no-ops (one cleanup per sleep cycle). The
  // physical truncation CANNOT run inside dept_sleep (the harness appends the
  // tool result AFTER the tool returns at LIVE in-memory seqs and the Session
  // constructor demands contiguous-from-0 events — see the module header), so
  // this boot-time hook is the race-free point: it runs before the GUI can
  // materialize/open the host session. Best-effort: each piece warns on
  // failure; the flag stays for the next boot when the truncate failed
  // (idempotent retry), and is cleared once the truncate succeeded.
  // LIVE-SESSION RETRY (the wake-11 corruption fix — see the diagnosis report
  // .dsh/reports/explore-deep/2026-08-21-corrupt-session-log-diagnosis.md): a
  // boot where the host session is ALREADY materialized (a resident agent
  // holds it) must NOT truncate — runSleepCleanup then reports the cleanup as
  // SKIPPED (`skipped: true, skipReason: 'session-live'`) and this hook KEEPS
  // the pending flag, so the SAME cleanup is retried at the next boot, when
  // the session is verifiably not materialized. The clear decision is the
  // pure `shouldClearCleanupPending` gate below (unit-tested).
  const runPendingWebUiCleanups = async (): Promise<void> => {
    const pending: Array<{ hostId: string; sessionId: string }> = []
    for (const hostEntry of hosts.values()) {
      // U2 (§5 defence-in-depth): never truncate a RETIRED entry's artifact —
      // rotation preserves the old session whole (G4/D2); the boot cleanup is
      // the LEGACY path for in-place sleeps only.
      if (hostEntry.webUiCleanupPending === true && hostEntry.retired !== true) pending.push({ hostId: hostEntry.hostId, sessionId: hostEntry.sessionId })
    }
    if (pending.length === 0) return
    ctx.logger.info(`[deepartments] web-ui sleep cleanup pending for ${pending.length} host(s)`)
    // Resolve the runtime seams the cleanup needs (OPTIONALLY — the cleanup
    // degrades gracefully when the persistence backend is absent, e.g. in
    // minimal compositions / hermetic harnesses).
    const persistence = ctx.get('sessionPersistence') as { root?: string } | undefined
    const sessionsRoot = typeof persistence?.root === 'string' && persistence.root !== ''
      ? persistence.root
      : path.join(stateDir, '..', 'sessions')
    const stateHome = path.dirname(sessionsRoot)
    const projCachePath = path.join(stateHome, 'storages', 'session_projcache.json')
    const archiveDir = path.join(stateHome, 'archive')
    const sessions = ctx.get('sessions') as { get?: (id: unknown) => unknown } | undefined
    // Fix wake-12 (race-2): the session-store check ALONE misses a host session
    // resumed via the AGENT REGISTRY — dsh-smart-restart's boot resume delivers
    // through `agent.followup(...)` (dsh-smart-restart/src/index.ts:262-280),
    // which attaches the session to `ctx.agents` while it is not yet in the
    // `sessions` store map. With the store-only probe the boot cleanup once
    // truncated a resumed host artifact (mid-log seq seam — the wake-11
    // corruption class, see explore-deep/2026-08-21-first-turn-api-orphan.md
    // §1.2). A host is LIVE when EITHER service holds it; `agents` is resolved
    // OPTIONALLY (absent in minimal/hermetic compositions → the probe degrades
    // to the pre-existing store-only behavior).
    const agents = ctx.get('agents') as AgentsLike | undefined
    const isLive = (sessionId: string): boolean =>
      sessions?.get?.(sessionId) !== undefined ||
      (agents !== void 0 && agents.get(SessionId(sessionId)) !== undefined)
    for (const { hostId, sessionId } of pending) {
      const entry = hosts.get(hostId)
      if (entry === void 0 || entry.sessionId !== sessionId) continue
      try {
        const artifactPath = await findSessionArtifact(sessionsRoot, sessionId)
        if (artifactPath === undefined) {
          ctx.logger.warn(`[deepartments] web-ui sleep cleanup: no stored artifact for ${sessionId} — skipping truncate`)
        }
        const report = await runSleepCleanup(sessionId, {
          artifactPath,
          projCachePath,
          sessionsRoot,
          archiveDir,
          isLive,
          log: ctx.logger
        })
        ctx.logger.info(
          `[deepartments] web-ui sleep cleanup for ${sessionId}: truncate ${report.truncate?.beforeEvents ?? 'n/a'}→${report.truncate?.afterEvents ?? 'n/a'} events` +
          `, projcache rows dropped ${report.projCacheRemoved}, subagent children archived ${report.archive?.archivedDirs.length ?? 0}`
        )
        // RETRY SEMANTICS — the flag is cleared ONLY when the cleanup actually
        // RAN and the GUI-critical piece (the artifact truncation) succeeded
        // (pure `shouldClearCleanupPending` gate, unit-tested):
        //   * SKIPPED (host session live — `report.skipped === true`, reason
        //     'session-live') → flag KEPT: the session was materialized while
        //     the boot ran the cleanup, so truncation would corrupt its
        //     artifact (mid-log seq seam); the NEXT boot retries when the
        //     session is verifiably not materialized.
        //   * truncate FAILED/absent (`truncateError` set or `truncate`
        //     undefined) → flag KEPT: idempotent next-boot retry.
        //   * ran + truncate SUCCEEDED → flag CLEARED: one cleanup per sleep
        //     cycle; mid-wake restarts are exact no-ops.
        if (shouldClearCleanupPending(report)) {
          entry.webUiCleanupPending = undefined
          persistHosts()
        } else if (report.skipped === true) {
          ctx.logger.info(`[deepartments] web-ui sleep cleanup for ${sessionId} SKIPPED (${report.skipReason ?? 'unknown'}): host session live — pending flag KEPT, the next boot retries`)
        }
      } catch (error) {
        ctx.logger.warn(`[deepartments] web-ui sleep cleanup failed for ${sessionId} (flag kept for the next boot): ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  hostsLoaded.then(() => { void runPendingWebUiCleanups() }, () => { void runPendingWebUiCleanups() })

  // --- Boot repair hook: attach the single live host to its workspace (FIX 1b)
  // A rotated host that was registered in hosts.json but never workspace-
  // attached (e.g. the session-6e49895c… incident — a cold artifact + live
  // hosts.json entry with ZERO rows in the durable workspace sessionIds) is
  // INVISIBLE in the GUI sidebar: the native sidebar groups sessions by
  // workspace membership and the U3 watcher's membership check
  // (packages/dshd-gui/src/client/index.tsx) never passes → the host is unreachable. The
  // rotation now attaches at S2.2 (src/session-rotation.ts), and this hook
  // HEALS legacy/crash states at boot: when hosts.json holds EXACTLY ONE
  // non-retired live host entry, attach its session to the workspace whose
  // path matches its persisted header cwd (the same iterate-and-try pattern
  // as S2.2 — dsh-workspace `attachSession` validates cwd vs path and throws
  // on mismatch, so mismatches fall through). Best-effort: skip silently on
  // zero or ambiguous (2+) live hosts (warn on the ambiguous case); on
  // no-match/all-throw log a WARN and never crash. Runs only when the
  // workspaceRegistry service is available (optional seam).
  // FIX 1b.1 (2026-08-22): the strict `ctx.get('workspaceRegistry')` returns
  // UNDEFINED until the provider's fiber reaches state 2 (cordis
  // lib/index.js:762-771 — `_getImpl` bails when `strict && impl.fiber.state
  // !== 2`). The workspaceRegistry provider's init awaits storage + a
  // sessionPersistence header-index rebuild, so at the moment this boot hook
  // runs (hostsLoaded.then — microseconds after plugin boot) the strict get
  // races the init and silently skipped (production: session-6e49895c did
  // not heal at the 17:24:59 UTC restart; zero `host attach repair` lines).
  // Fix: NON-STRICT get + a bounded retry loop around `list()` — retry while
  // the impl is absent or list() rejects (mid-init, e.g. "workspace registry
  // is not started yet"), attach on the first resolved list; after the cap
  // log a WARN and give up (never crash).
  const HOST_ATTACH_REPAIR_RETRY_MS = 250
  const HOST_ATTACH_REPAIR_TIMEOUT_MS = 10_000
  const repairHostWorkspaceAttach = async (): Promise<void> => {
    const live: HostEntry[] = []
    for (const entry of hosts.values()) if (entry.retired !== true) live.push(entry)
    if (live.length !== 1) {
      if (live.length > 1) ctx.logger.warn(`[deepartments] host attach repair: skipped (${live.length} live host entries — exactly one required)`)
      return
    }
    const sessionId = live[0].sessionId
    const deadline = Date.now() + HOST_ATTACH_REPAIR_TIMEOUT_MS
    let lastFailure: unknown = undefined
    for (;;) {
      const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
      if (registry?.list !== void 0) {
        try {
          const workspaceList = await registry.list()
          for (const workspace of workspaceList) {
            if (typeof workspace?.attachSession !== 'function') continue
            try {
              await workspace.attachSession(sessionId)
              ctx.logger.info(`[deepartments] host attach repair: attached ${sessionId}`)
              return
            } catch {
              // cwd mismatch / unvalidatable header / attach fault — try the next entity.
            }
          }
          // list() RESOLVED but no entity matched: a definitive (non-readiness)
          // failure — warn once and give up.
          ctx.logger.warn(`[deepartments] host attach repair: no workspace matched session ${sessionId} (its header cwd has no owning workspace) — the host stays invisible in the sidebar`)
          return
        } catch (error) {
          // list() rejected → the registry is still initializing — retry.
          lastFailure = error
        }
      }
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, HOST_ATTACH_REPAIR_RETRY_MS))
    }
    const detail = lastFailure instanceof Error ? lastFailure.message : String(lastFailure ?? 'registry impl never became available')
    ctx.logger.warn(`[deepartments] host attach repair failed: ${detail} — the host stays invisible in the sidebar (retried ${HOST_ATTACH_REPAIR_TIMEOUT_MS}ms)`)
  }
  hostsLoaded.then(() => { void repairHostWorkspaceAttach() }, () => { void repairHostWorkspaceAttach() })

  // B3 cutover: the per-room board-emit machinery (read cursors, seq
  // counters, room queues, the board message emitter, room-write address
  // validation, sender-verified trust flags) is DELETED — the BUS
  // (messages-store.ts + deliverBusRecord) is the only emit/delivery path.

  // --- department HEADS: FIRST-CLASS ROOT AGENTS (Batch 1a) ------------------
  // A configured coordinator is materialized as its OWN root agent (NOT a
  // continuable subagent): created/resumed via ctx.agents.create/resume from
  // the plugin's ROOT service context (so it lands in agents.roots(), with no
  // origin === 'subagent', and the GUI/sidebar renders it as a main-agent row
  // exactly like "Assistant"). Batch 4a: each head materializes a PER-HEAD
  // preset (`deepartments-head-<departmentId>`, derived from the generic base +
  // the department role) so the head is a NATIVE, openable session. PRESET_ID
  // (the generic `deepartments-head` base) remains as the TEMPLATE and as the
  // FALLBACK for a head whose department cannot be resolved.
  const PRESET_ID = HEAD_PRESET_BASE_ID
  /** Batch 3a: the dedicated DISPOSABLE-worker preset (mirrors the head preset
   * but framed as a temporary rank-and-file researcher). Materialized into the
   * harness-home user preset root alongside the head preset. */
  const WORKER_PRESET_ID = 'deepartments-worker'
  /** F7 (owner decision 2026-08-23 — provider migration to opencode-zen): the
   * runtime-materialized department workers run the SAME provider/model route
   * as the coordinator (cordis.patch.yml — opencode-zen /
   * deepseek-v4-flash, reasoningEffort max). ONE source shared by
   * the three spawn paths (dept_post_create, dept_job_run, dept_worker_spawn)
   * so the worker route cannot drift from the config again. */
  const WORKER_AGENT_OPTIONS: AgentOptionsLike = {
    provider: 'opencode-zen',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'max'
  }
  /** VARIANT-2 (2026-08-24) — post-restart host AgentOptions intermittently
   * empty: the plugin's OWN D4 dormant-host bus delivery (busDeliverToHost)
   * resumes the host with `agents.resume({ resumeSessionId, setup })` and NO
   * agentOptions → `agent.options = {}` → the dsh-agent-loop request waterfall
   * throws `agent "session-<uuid>" has no provider/model` at the first
   * post-boot materialization. The D4 setup only mounts the 'deepartments'
   * preset and does NOT installSelection, so `agent.options` MUST be the
   * carrier — mirror heads/workers (WORKER_AGENT_OPTIONS /
   * coordinator.agentOptions) to make the HOST symmetric: pass the FULL
   * constant (provider/model/reasoningEffort) at the D4 resume (invoke.ts:8760)
   * so `this.options` is non-empty at EVERY host materialization → the
   * request waterfall returns it → no `no provider/model`. NOTE:
   * defaultModelSelection().agentOptions() (dsh-host-apiproxy) DROPS
   * reasoningEffort — pass the FULL constant, not a provider/model-only
   * partial. ONE source shared by the D4 host resume so the host route cannot
   * drift from the config again (mirrors the F7 WORKER_AGENT_OPTIONS). */
  const HOST_AGENT_OPTIONS: AgentOptionsLike = {
    provider: 'opencode-zen',
    model: 'deepseek-v4-flash-vision-exp',
    reasoningEffort: 'max'
  }
  /** fb-6 (QH — the resume/re-materialization "has no provider/model" class):
   * the ONE materializePost AgentOptions resolution point — the configured
   * `coordinator?.agentOptions` when it carries a USABLE provider/model, else
   * the WORKER_AGENT_OPTIONS fallback. An interrupted SPAWN leaves the post
   * registered with its durable session PRESENT but with NO usable
   * AgentOptions (a department-less/legacy worker — or a config-less head —
   * has no coordinator row) → the pre-fix waterfall threw
   * `agent "session-<uuid>" has no provider/model` at the resume AND at the
   * create-fresh fallback. Workers AND heads both run the flash route today,
   * so the fallback is the SAME constant for both; the HOST never passes
   * through here — busDeliverToHost passes the FULL HOST_AGENT_OPTIONS at its
   * own D4 resume (untouched). ZERO regression: a usable candidate is returned
   * unchanged, so normal spawns/materializations pass through byte-identical. */
  const resolveMaterializeAgentOptions = (candidate: AgentOptionsLike | undefined): AgentOptionsLike =>
    isUsableAgentOptions(candidate) ? (candidate as AgentOptionsLike) : WORKER_AGENT_OPTIONS
  /** Repo root, used as the preset source AND as the FINAL fallback cwd for
   * head/worker sessions (the canonical cwd is the workspace root path — see
   * `resolveWorkspaceRootPath`). `new URL('.', import.meta.url)` already yields
   * the compiled `lib/` directory (of lib/invoke.js in dev), so one `'..'` up
   * is the repo root. */
  const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
  // the plugin's ROOT service context — so it is owned by no live parent,
  // lands in agents.roots(), carries no `origin: 'subagent'`, and the
  // GUI/sidebar renders it as a main-agent row exactly like "Assistant".
  //   * stable id `SessionId(\`head-<postId>\`)`
  //   * `meta: { cwd: <workspace root path>, origin: undefined, agentPreset: 'deepartments-head' }`
  //   * `agentOptions` from the coordinator config
  //   * a `setup(agentCtx)` that mounts the dedicated 'deepartments-head'
  //     preset AND registers the head's dept_* board tools scoped to it.
  //
  // Root creation semantics: ensureHead is idempotent — live → reuse; a
  // durable session → resume; else → create. Permanent = configured; there is
  // no re-materialization fight because root agents are not re-spawned by
  // config the way materializeHeads re-spawned subagents (a head only gets
  // CREATED here when its durable sessionId is absent from the registry).
  //
  // Preset availability (design decision — see report): dsh-agent-presets
  // Config.roots is STATIC (there is no runtime root-registration API; rc.8
  // dsh-agent-presets types/index.d.ts:115-159, preset.d.ts:47-57), so Batch
  // 1a uses the FALLBACK: at apply() we idempotently materialize
  // `presets/deepartments-head/` into the harness-home user-preset root
  // `<DSH_HOME>/.agent-presets/` — the root the roster scans under
  // includeUserRoot (discovery.d.ts:32 USER_PRESET_DIR='.agent-presets',
  // index.js:852), so agentPresets.resolve('deepartments-head') finds it.

  /** Harness home: `$DSH_HOME` if set, else `~/.dsh` (mirrors
   * resolveDshHome() in dsh-home-paths without a hard dependency). */
  const dshHome = (): string => {
    const env = process.env.DSH_HOME
    if (env !== undefined && env.trim() !== '') return env.trim()
    return path.join(os.homedir(), '.dsh')
  }

  /** Resolve the plugin's own directory containing `presets/<presetId>/`
   * (the plugin's own repo root, under presets/). */
  const presetSourceDir = (presetId: string): string =>
    path.join(repoRoot, 'presets', presetId)

  /** Idempotently materialize `presets/<presetId>/` into the harness home's
   * `.agent-presets/` user root so the given preset is resolvable. Used for the
   * head preset AND the disposable-worker preset (Batch 3a). The copy is
   * skipped when the destination already has the same file. Non-fatal: a failed
   * materialization just means the matching setup mounts nothing (board tools
   * are always installed regardless). */
  const materializePreset = async (presetId: string): Promise<void> => {
    const srcDir = presetSourceDir(presetId)
    const dstDir = path.join(dshHome(), '.agent-presets', presetId)
    try {
      await mkdir(dstDir, { recursive: true })
      const files = await readdir(srcDir)
      for (const file of files) {
        const src = path.join(srcDir, file)
        const dst = path.join(dstDir, file)
        const isFile = (await stat(src)).isFile()
        if (!isFile) continue
        // Skip when the same file already exists (idempotent materialization).
        try {
          const existing = await readFile(dst, 'utf8')
          const incoming = await readFile(src, 'utf8')
          if (existing === incoming) continue
        } catch {
          /* destination absent/corrupt → (re)write */
        }
        await copyFile(src, dst)
      }
      ctx.logger.info(`[deepartments] preset "${presetId}" materialized at ${dstDir}`)
    } catch (error: unknown) {
      // Non-fatal: if the preset cannot be materialized (e.g. source absent), the
      // matching setup simply mounts nothing and still gets its board tools.
      ctx.logger.warn(`[deepartments] preset "${presetId}" materialization skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Write one generated preset file to a destination, skipping when the same
   * content is already present (idempotent materialization — mirrors the
   * skip-on-identical check in `materializePreset`). */
  const writePresetFile = async (dst: string, content: string, presetId: string): Promise<void> => {
    try {
      const existing = await readFile(dst, 'utf8')
      if (existing === content) return
    } catch {
      /* destination absent/corrupt → (re)write */
    }
    await writeFile(dst, content, 'utf8')
    ctx.logger.info(`[deepartments] preset "${presetId}" file ${dst} written`)
  }

  /** Idempotently generate + materialize ONE PER-HEAD preset
   * (`deepartments-head-<departmentId>`) into the harness home's `.agent-presets/`
   * user root (Batch 4a). The composition is derived from the generic
   * `deepartments-head` base template + the department role line; the metadata
   * is `name: "<head title> - Deepartments"`. Non-fatal: a failed materialization
   * just means the head's setup mounts the generic fallback (board tools are
   * always installed regardless). */
  const materializeHeadPreset = async (department: DepartmentConfig): Promise<void> => {
    const coordinator = department.coordinator
    if (coordinator === undefined) return
    const presetId = headPresetIdFor(department.id)
    const dstDir = path.join(dshHome(), '.agent-presets', presetId)
    try {
      await mkdir(dstDir, { recursive: true })
      const headName = headPresetNameCore(coordinator)
      const baseComposition = await readFile(path.join(repoRoot, 'presets', PRESET_ID, 'agent.cordis.yml'), 'utf8')
      const composition = buildHeadPresetComposition(baseComposition, headName, department.name)
      await writePresetFile(path.join(dstDir, 'agent.cordis.yml'), composition, presetId)
      await writePresetFile(path.join(dstDir, 'preset.yml'), buildHeadPresetMetadata(headPresetNameFor(coordinator)), presetId)
      // M2.3 WP1a (preset-materialize waypoint): did the per-head preset FILE
      // carry the tool-secretary row? Reports the standing's contribution
      // source — a head equipped by the OWN layer (M2.3) is intentionally
      // row-independent, so this line only diagnoses the STANDING side of the
      // chain. Written to the guaranteed audit channel (the deepartments warns
      // never reach the harness stdout).
      appendToolsetAudit(stateDir, {
        wp: 'preset-materialize',
        presetId,
        toolSecretary: composition.includes('- id: tool-secretary') ? 'yes' : 'no'
      })
      ctx.logger.info(`[deepartments] per-head preset "${presetId}" materialized at ${dstDir}`)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] per-head preset "${presetId}" materialization skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- Batch G: the journal (long-term memory) + sleep lifecycle ---------------
  // A permanent head CHOOSES to persist its memory before sleeping: it writes an
  // explicit agent-authored memo to `<stateDir>/journals/<memberId>.md`
  // (dept_memo_write), then calls dept_sleep to mark the post and DISPOSE its
  // AgentHandle (context reset). On the next wake the relay cold-resumes the
  // SAME durable session (ctx.agents.resume) and wakes it. This is a dedicated
  // affordance and deliberately does NOT reuse dept_witness_write (the owner's
  // "guardado de memoria en un status o log del diario" is a head-authored
  // handoff note, not the relevo witness).

  /** Durable path of a post's long-term memory journal. */
  const journalPathFor = (memberId: string): string => path.join(stateDir, 'journals', `${memberId}.md`)

  // --- Task T1: SESSION MEMORY ARCHIVE (append-only history + one-cycle session
  // log + searchable index). Best-effort/non-fatal everywhere: a failure here
  // must NEVER fail the memo write or the sleep. The injected wake pack reads
  // ONLY the single checkpoint (journalPathFor via readWakeJournalKpi), so these
  // artifacts living under journals/archive|sessions|index.json are structurally
  // invisible to the lean wake surface (spec §Goal 1, test 5 locks this).
  //
  // Bounded serializer constants (scribe spec §4 — keep in sync with the doc).
  const MAX_TOOL_ARGS = 800
  const MAX_TOOL_RESULT = 2000
  const MAX_TEXT = 2000
  const MAX_FILE_BYTES = 512 * 1024

  /** Path of one member's append-only archive. */
  const archivePathFor = (memberId: string): string => path.join(stateDir, 'journals', 'archive', `${memberId}.md`)
  /** Path of the per-member search index. */
  const indexPathFor = (): string => path.join(stateDir, 'journals', 'index.json')
  /** Path of one member+ordinal one-cycle session log. */
  const sessionLogPathFor = (memberId: string, wakeCounter: number): string => path.join(stateDir, 'journals', 'sessions', `${memberId}-${wakeCounter}.md`)

  /** Deterministic per-write UNIQUE archive marker so interleaved appends across
   * the shared stateDir stay parseable (spec §Artifacts (a) — each
   * `=== ENTRY … ===` block stays intact even if blocks interleave). */
  const archiveUniqueSeq = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  /** Truncate a string to `max` chars, eliding the tail with `… [truncated]`. */
  const truncateText = (text: string, max: number): string =>
    text.length <= max ? text : `${text.slice(0, max)}… [truncated]`

  /** Best-effort heuristic extraction of top keyword tokens from the journal
   * summary (spec §Index schema — best-effort; absent → []). */
  const extractKeywords = (summary: string): string[] => {
    const words = (summary.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? [])
      .filter((w) => !/^(the|and|for|with|this|that|from|into|were|has|had|our|their|when|what|will|been|were|over|under|about|after|before)$/i.test(w))
    return [...new Set(words)].slice(0, 12)
  }

  /** Best-effort heuristic extraction of file paths / report paths from the
   * journal summary (spec §Index schema — best-effort; absent → []). */
  const extractPaths = (summary: string): string[] => {
    const paths = [...summary.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((p) => /[/.]/.test(p))
    return [...new Set(paths)].slice(0, 12)
  }

  /** Best-effort heuristic extraction of commit-style lines from the summary
   * (spec §Index schema — best-effort; absent → []). */
  const extractCommits = (summary: string): string[] => {
    return (summary.match(/^[-*]\s*(?:feat|fix|docs|refactor|chore)\([^)]*\)[^:\n]*:.*$/gm) ?? []).slice(0, 12)
  }

  /** Reduce a DSH content block array to a single bounded text string
   * (keeps attachmentId references, never bytes / data: URIs). */
  const contentToText = (content: unknown, max: number): string => {
    if (!Array.isArray(content)) return truncateText(String(content ?? ''), max)
    const parts: string[] = []
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b.type === 'image' && typeof b.attachment === 'object' && b.attachment !== null) {
        const ref = b.attachment as Record<string, unknown>
        if (ref.attachmentId !== undefined) parts.push(`[image:${String(ref.attachmentId)}]`)
      } else if (Array.isArray(b.content)) parts.push(contentToText(b.content, Number.POSITIVE_INFINITY) as string)
    }
    return truncateText(parts.join(' '), max)
  }

  /** Bounded markdown line for one session event (spec §Artifacts (b) body). */
  const serializeSessionEvent = (type: string, data: Record<string, unknown> | undefined): string | undefined => {
    if (data === undefined || typeof data !== 'object') return undefined
    switch (type) {
      case 'user/message':
        return `- **user:** ${contentToText(data.message !== undefined ? (data.message as Record<string, unknown>).content : data.content, MAX_TEXT)}`
      case 'assistant/message': {
        const message = data.message as Record<string, unknown> | undefined
        return `- **assistant:** ${contentToText(message?.content ?? data.content, MAX_TEXT)}`
      }
      case 'tool/call':
        return `- **tool** \`${truncateText(String(data.name ?? '?'), 120)}\` → *called*: ${truncateText(String(data.arguments ?? '{}'), MAX_TOOL_ARGS)}`
      case 'tool/result': {
        const ok = data.error === undefined
        const message = data.message as Record<string, unknown> | undefined
        const resultText = ok
          ? truncateText(typeof message?.content === 'string' ? message.content : JSON.stringify(data.meta ?? data.result ?? message?.content ?? ''), MAX_TOOL_RESULT)
          : `failed (${String((data.error as Record<string, unknown>)?.name ?? 'error')})`
        return `- **toolresult** → *${ok ? 'ok' : 'failed'}*: ${resultText}`
      }
      case 'turn/start':
        return `- **turn** ${String(data.turn)} start`
      case 'turn/end':
        return `- **turn** ${String(data.turn)} end (${String((data as Record<string, unknown>).reason ?? '')})`
      case 'step/start':
        return `- **step** ${String(data.turn)}.${String(data.step)} start`
      case 'step/end':
        return `- **step** ${String(data.turn)}.${String(data.step)} end`
      default:
        return undefined
    }
  }

  /** Build the bounded markdown body from a sliced event list (spec §Artifacts
   * (b) §4). Bounded by MAX_FILE_BYTES — on overflow drop chunk/step noise first,
   * then truncate the oldest tool lines, then stop. */
  const serializeSessionLog = (memberId: string, roomId: string, sessionId: string, wakeCounter: number, events: Array<{ type: string; seq: number; time: number; data: unknown }>, boundarySeq: number | undefined): string => {
    const first = events[0]
    const last = events[events.length - 1]
    const startSeq = boundarySeq !== undefined ? boundarySeq + 1 : first?.seq ?? 0
    const lines: string[] = [
      '---',
      `member: ${memberId}`,
      `room: ${roomId}`,
      `session_id: ${sessionId}`,
      `wake_counter: ${wakeCounter}`,
      `start_seq: ${startSeq}`,
      `end_seq: ${last?.seq ?? startSeq}`,
      `start_time: ${first !== undefined ? new Date(first.time).toISOString() : ''}`,
      `end_time: ${last !== undefined ? new Date(last.time).toISOString() : ''}`,
      `journal: journals/${memberId}.md`,
      '---',
      '## cycle'
    ]
    for (const event of events) {
      const line = serializeSessionEvent(event.type, (event.data ?? {}) as Record<string, unknown>)
      if (line === undefined) continue // skip assistant/chunk and unknown noise
      // Hard byte cap: drop the line rather than grow an unbounded file.
      if (lines.join('\n').length + line.length + 1 > MAX_FILE_BYTES) break
      lines.push(line)
    }
    return lines.join('\n')
  }

  /** Stub form when the transcript cannot be captured (spec §Capture flow 6):
   * frontmatter + `transcript: unavailable` + reason + pointer to the checkpoint.
   * Never throws; used so the memo write / dept_sleep still succeeds. */
  const buildSessionLogStub = (memberId: string, roomId: string, sessionId: string, wakeCounter: number, reason: string): string =>
    [
      '---',
      `member: ${memberId}`,
      `room: ${roomId}`,
      `session_id: ${sessionId}`,
      `wake_counter: ${wakeCounter}`,
      'transcript: unavailable',
      `reason: ${reason}`,
      `journal: journals/${memberId}.md`,
      '---',
      '## cycle',
      `No DSH transcript captured for this cycle (reason: ${reason}). Journal checkpoint follows at journals/${memberId}.md.`
    ].join('\n')

  /** Best-effort heuristic population of the mutable search index fields from
   * the checkpoint text/summary (spec §Index schema — best-effort; absent → []).
   * The AUTHORITATIVE fields (timestamp/wake_counter/session_log_path/archive_seq)
   * are always set. */
  const deriveIndexEntry = (memberId: string, content: string, wakeCounter: number, archiveSeq: string): {
    timestamp: string; wake_counter: number; current_step?: string; keywords: string[];
    files_touched: string[]; commits: string[]; open_items: string[]; report_paths: string[];
    session_log_path: string; archive_seq: string
  } => {
    const tsMatch = content.match(/^timestamp:\s*(.+)$/m)
    const stepMatch = content.match(/^current_step:\s*(.+)$/m)
    const openMatch = content.match(/^open_items:\s*(\[.*\])$/m)
    let openItems: string[] = []
    if (openMatch !== null) {
      try {
        const parsed = JSON.parse(openMatch[1]) as unknown
        if (Array.isArray(parsed)) openItems = parsed.filter((x): x is string => typeof x === 'string')
      } catch { /* keep [] */ }
    }
    const summary = content.replace(/^---$[\s\S]*?^---$/m, '').replace(/^wake routine:.*$/m, '').trim()
    const filesTouched = extractPaths(summary)
    const reportPaths = filesTouched.filter((p) => p.includes('.dsh/reports/') || p.startsWith('.dsh/'))
    const entry: {
      timestamp: string; wake_counter: number; current_step?: string; keywords: string[];
      files_touched: string[]; commits: string[]; open_items: string[]; report_paths: string[];
      session_log_path: string; archive_seq: string
    } = {
      timestamp: tsMatch !== null ? tsMatch[1].trim() : new Date().toISOString(),
      wake_counter: wakeCounter,
      keywords: extractKeywords(summary),
      files_touched: filesTouched,
      commits: extractCommits(summary),
      open_items: openItems,
      report_paths: reportPaths,
      // Durable, machine-readable citation (relative to the stateDir).
      session_log_path: `journals/sessions/${memberId}-${wakeCounter}.md`,
      archive_seq: archiveSeq
    }
    if (stepMatch !== null) entry.current_step = stepMatch[1].trim()
    return entry
  }

  /** Local-time marker fragment for the archive delimiter (`ts=`). */
  const archiveLocalTs = (): string => {
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  /** Task T1 — capture the ONE-CYCLE session log (WAKE→memo) for a member's
   * current cycle and write it bounded to `journals/sessions/<memberId>-<wake_counter>.md`
   * (atomic tmp+rename). Slices by exact event `seq > boundarySeq` (the seq
   * persisted at the previous dept_sleep), falling back to `event.time > lastWakeMs`
   * (from the prior journal's `last_wake`) for the first-ever cycle. BEST-EFFORT:
   * on ANY failure writes the STUB form and warns — never throws into the memo
   * write or sleep. Returns the session-log path (real or stub). */
  const captureSessionLog = async (memberId: string, roomId: string, sessionId: string, wakeCounter: number, boundarySeq: number | undefined): Promise<string> => {
    const logPath = sessionLogPathFor(memberId, wakeCounter)
    const journalPath = journalPathFor(memberId)
    try {
      // 1. Flush the live session's in-memory tail so readRaw reflects it
      //    (mirrors flushLiveSessionLog, session-export.js:95-101). Invoke the
      //    real service methods as BOUND method calls — `this` must survive:
      //    dsh-session's `flush(session)` reads `this.liveEntryFor(session)`
      //    (dsh-session lib/index.js:1792, rc.8) and the jsonl backend's
      //    `readRaw(id)` reads `this.findLog(...)` (dsh-session-persistence-jsonl
      //    lib/index.js:869). The earlier extraction-then-call form
      //    (`const f = sessions.flush; await f(live)`) lost `this` and crashed
      //    live captures with `Cannot read properties of undefined (reading
      //    'liveEntryFor')` — every live session log degraded to the stub
      //    (Batch S1 in-the-wild fix; spec §Capture flow 2 documents the bound
      //    `ctx.get('sessions').flush(session)` shape).
      const sessions = ctx.get('sessions') as { get?: (id: string) => unknown; flush?: (session: unknown) => Promise<unknown> } | undefined
      if (sessions !== undefined && sessionId !== undefined) {
        const live = sessions.get?.(SessionId(sessionId))
        if (live !== undefined && typeof sessions.flush === 'function') await sessions.flush(live)
      }
      // 2. In-process read of the durable JSONL artifact (readRaw).
      const persistence = ctx.get('sessionPersistence') as { readRaw?: (id: SessionId, signal?: AbortSignal) => Promise<{ content: string } | undefined> } | undefined
      if (persistence === undefined || typeof persistence.readRaw !== 'function') {
        throw new Error('sessionPersistence unavailable (no readRaw)')
      }
      const raw = await persistence.readRaw(SessionId(sessionId))
      if (raw === undefined || typeof raw.content !== 'string' || raw.content === '') {
        throw new Error('no stored session artifact (readRaw returned nothing)')
      }
      // 3. Parse the JSONL events (skipping malformed/noise lines defensively).
      const events: Array<{ type: string; seq: number; time: number; data: unknown }> = []
      for (const line of raw.content.split('\n')) {
        if (line.trim() === '') continue
        try {
          const ev = JSON.parse(line) as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
          if (ev !== null && typeof ev === 'object' && typeof ev.type === 'string' && typeof ev.seq === 'number' && typeof ev.time === 'number') {
            events.push({ type: ev.type, seq: ev.seq, time: ev.time, data: ev.data })
          }
        } catch { /* skip malformed line */ }
      }
      // 4. Slice one cycle: exact by seq, else by time from the prior journal.
      let lastWakeMs: number | undefined
      if (boundarySeq === undefined) {
        try {
          const prior = await readFile(journalPath, 'utf8')
          const m = prior.match(/^last_wake:\s*(.+)$/m)
          if (m !== null) { const t = Date.parse(m[1].trim()); if (!Number.isNaN(t)) lastWakeMs = t }
        } catch { /* no prior journal → include whole log */ }
      }
      const sliced = events.filter((ev) =>
        boundarySeq !== undefined ? ev.seq > boundarySeq
          : lastWakeMs !== undefined ? ev.time > lastWakeMs
            : true)
      const markdown = serializeSessionLog(memberId, roomId, sessionId, wakeCounter, sliced, boundarySeq)
      // 5. Atomic write (tmp+rename).
      const tmpPath = `${logPath}.tmp`
      await mkdir(path.dirname(logPath), { recursive: true })
      await writeFile(tmpPath, markdown, 'utf8')
      await rename(tmpPath, logPath)
      return logPath
    } catch (error) {
      // 6. Best-effort: stub form + warn; never throw.
      const reason = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn(`[deepartments] session log capture skipped: ${reason}`)
      const markdown = buildSessionLogStub(memberId, roomId, sessionId, wakeCounter, reason)
      try {
        const tmpPath = `${logPath}.tmp`
        await mkdir(path.dirname(logPath), { recursive: true })
        await writeFile(tmpPath, markdown, 'utf8')
        await rename(tmpPath, logPath)
      } catch { /* give up silently on the stub write — never throw */ }
      return logPath
    }
  }

  /** Task T1 — append a member's full journal entry to the append-only archive
   * `journals/archive/<memberId>.md` (per-write unique delimiter so interleaved
   * appends across the shared stateDir stay parseable) and rewrite the mutable
   * `journals/index.json` atomically (last-write-wins, documented acceptable).
   * BEST-EFFORT/NON-FATAL: a throw here must not fail the memo write or sleep.
   * Returns the archive marker line. `exec` is accepted for signature stability
   * (the spec's helper contract) but is not consumed. */
  const archiveJournalEntry = async (memberId: string, roomId: string, _ctx: unknown, _exec: unknown, opts: { checkpointText: string; wakeCounter: number; lastWakeMs?: number; boundarySeq?: number; archiveSeq?: string }): Promise<string> => {
    const marker = opts.archiveSeq ?? `=== ENTRY ts=${archiveLocalTs()} wake_counter=${opts.wakeCounter} seq=${archiveUniqueSeq()} ===`
    const block = [marker, opts.checkpointText, '=== END ENTRY ===', ''].join('\n')
    const archivePath = archivePathFor(memberId)
    await mkdir(path.dirname(archivePath), { recursive: true })
    await appendFile(archivePath, block, 'utf8')
    // Rewrite the per-member search index atomically (last-write-wins).
    const entry = deriveIndexEntry(memberId, opts.checkpointText, opts.wakeCounter, marker)
    const indexPath = indexPathFor()
    let existing: unknown
    try { existing = JSON.parse(await readFile(indexPath, 'utf8')) } catch { existing = undefined }
    const index: { version: number; members: Record<string, { entries: unknown[] }> } =
      existing !== undefined && typeof existing === 'object' && (existing as { version?: unknown }).version === 1
        ? existing as { version: number; members: Record<string, { entries: unknown[] }> }
        : { version: 1, members: {} }
    if (index.members === undefined || index.members === null || typeof index.members !== 'object') index.members = {}
    if (index.members[memberId] === undefined) index.members[memberId] = { entries: [] }
    index.members[memberId].entries.push(entry)
    const tmpPath = `${indexPath}.tmp`
    await mkdir(path.dirname(indexPath), { recursive: true })
    await writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf8')
    await rename(tmpPath, indexPath)
    return marker
  }

  /** Task T1 — the SHARED best-effort checkpoint hook: capture the one-cycle
   * session log (when a live session id is known) and archive the entry, invoked
   * from writeJournal and the bump* siblings after their atomic commit. The
   * capture and the archive are INDEPENDENTLY best-effort — a failure in either
   * must NEVER fail the memo write or sleep, and a capture failure must not
   * skip the archive (spec §Capture flow — "always let writeJournal's memo
   * commit proceed"). Warns on failure; never throws. */
  const archiveCycle = async (memberId: string, roomId: string, sessionId: string | undefined, wakeCounter: number, checkpointText: string, boundarySeq: number | undefined, lastWakeMs: number | undefined, archiveSeq?: string): Promise<void> => {
    if (sessionId !== undefined) {
      try {
        await captureSessionLog(memberId, roomId, sessionId, wakeCounter, boundarySeq)
      } catch (error) {
        ctx.logger?.warn(`[deepartments] session log capture failed despite fallback: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      await archiveJournalEntry(memberId, roomId, undefined, undefined, { checkpointText, wakeCounter, lastWakeMs, boundarySeq, ...(archiveSeq !== undefined ? { archiveSeq } : {}) })
    } catch (error) {
      ctx.logger?.warn(`[deepartments] journal archive skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Write the journal file (author/room/timestamp/wake_counter/last_wake/
   * board_cursor frontmatter + runs of decisions/constraints/openItems +
   * optional current_step + the free-form summary body, closing with a short
   * wake-routine footer). Returns the durable memo path.
   *
   * wake_counter semantics — now UNIFORM across hosts and registered posts
   * (heads + workers, 2026-08-20 parity): the counter is the ORDINAL of the
   * current awake session and ADVANCES ONLY AT dept_sleep (see
   * bumpHostSleepCounter / bumpPostSleepCounter), never at write — so a second
   * dept_memo_write within one awake session keeps the SAME ordinal (first-ever
   * → 1, later → the current value). The +1 at the seed boundary happens in the
   * sleep layer, giving hosts, heads and workers identical ordinal semantics. */
  const writeJournal = async (memberId: string, roomId: string, summary: string, decisions: string[], constraints: string[], openItems: string[], currentStep?: string, archive?: { sessionId?: string; wakeCounter?: number; archiveSeq?: string; lastWakeMs?: number; boundarySeq?: number }): Promise<string> => {
    // Batch W2 identity + cursor block: derive the counter and the boundary the
    // previous incarnation left at from the PRIOR journal so a re-materialized
    // head/Asistente can verify its state on wake (lost-cursor / stale
    // detection). ENOENT-tolerant: a first-ever write has no prior journal →
    // wake_counter 1, last_wake none. The counter is NEVER advanced by the
    // write itself (for hosts, heads AND workers indistinguishably — parity):
    // the ordinal increments only at the dept_sleep seed boundary via
    // bumpHostSleepCounter / bumpPostSleepCounter.
    let prevCounter = 0
    let prevTimestamp: string | undefined
    try {
      const prior = await readFile(journalPathFor(memberId), 'utf8')
      const counterMatch = prior.match(/^wake_counter:\s*(\d+)/m)
      if (counterMatch !== null) prevCounter = Number(counterMatch[1])
      const tsMatch = prior.match(/^timestamp:\s*(.+)$/m)
      if (tsMatch !== null) prevTimestamp = tsMatch[1].trim()
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const wakeCounter = archive?.wakeCounter ?? Math.max(prevCounter, 1)
    // Task T1 — the journal entry cites BOTH archive artifacts (additive
    // frontmatter lines after `open_items:`/before the closing `---`; the KPI
    // regex anchors `^wake_counter:` and `^open_items:` per-line, so extra later
    // lines are safe — spec §Journal-body citation). The archive marker is
    // precomputed here so the checkpoint can cite the exact fence that the
    // post-commit append will write.
    const archiveFence = archive?.archiveSeq ?? `=== ENTRY ts=${archiveLocalTs()} wake_counter=${wakeCounter} seq=${archiveUniqueSeq()} ===`
    const sessionLogCite = `journals/sessions/${memberId}-${wakeCounter}.md`
    const content = [
      '---',
      `author: ${memberId}`,
      `room: ${roomId}`,
      `timestamp: ${new Date().toISOString()}`,
      `wake_counter: ${wakeCounter}`,
      `last_wake: ${prevTimestamp ?? 'none'}`,
      ...(currentStep !== undefined ? [`current_step: ${currentStep}`] : []),
      // B3 cutover: board read-cursors are gone — the informational frontmatter
      // line stays for journal-schema stability, pinned to 'none'.
      'board_cursor: none',
      `decisions: ${yamlList(decisions)}`,
      `constraints: ${yamlList(constraints)}`,
      `open_items: ${yamlList(openItems)}`,
      `archive_seq: ${archiveFence}`,
      `session_log: ${sessionLogCite}`,
      '---',
      '',
      summary,
      '',
      // Batch C — P1 routine-footer dedupe: the journal footer is now a ONE-LINE
      // pointer to the canonical wake routine instead of embedding the full
      // HOST_WAKE_ROUTINE_TEXT (~620 bytes). The canonical text still comes in
      // ONCE per wake via wake-pack section 9 (buildWakePack, ~651) and via the
      // full skill body the pack embeds — so dropping it from the footer here
      // kills ~1/3 of the per-wake routine redundancy without touching the const,
      // the skill file, or the pack's §9.
      'wake routine: see skill \'Wake routine (injected wake)\''
    ].join('\n')
    const memoPath = journalPathFor(memberId)
    await mkdir(path.dirname(memoPath), { recursive: true })
    // Atomic write: write to a sibling temp path on the same filesystem, then
    // rename over the target. A crash mid-write must never leave a truncated
    // journal, because the journal is the next wake's ONLY durable surface.
    const tmpPath = `${memoPath}.tmp`
    try {
      await writeFile(tmpPath, content, 'utf8')
      await rename(tmpPath, memoPath)
    } catch (error: unknown) {
      // Best-effort cleanup of the temp file; ignore cleanup errors.
      try { await unlink(tmpPath) } catch { /* ignore */ }
      throw error
    }
    // Task T1 — AFTER the checkpoint commit, archive this entry + capture the
    // one-cycle session log (best-effort/non-fatal; a failure must NOT fail the
    // memo write). Runs only when a live session id is supplied (the memo tool
    // passes the calling agent's durable id).
    if (archive?.sessionId !== undefined) {
      const boundarySeq = archive.boundarySeq ?? hosts.get(memberId)?.boundarySeq ?? byPost.get(memberId)?.boundarySeq
      const lastWakeMs = archive.lastWakeMs ?? (prevTimestamp !== undefined ? Date.parse(prevTimestamp) : undefined)
      await archiveCycle(memberId, roomId, archive.sessionId, wakeCounter, content, boundarySeq, lastWakeMs, archiveFence)
    }
    return memoPath
  }

  /** Advance a HOST journal's `wake_counter` by exactly 1 at the dept_sleep
   * boundary and persist atomically to `<stateDir>/journals/<memberId>.md`
   * (same tmp+rename pattern as writeJournal) — a PURE counter bump: the base
   * author/room/timestamp/last_wake/current_step/board_cursor frontmatter and
   * the body are left UNTOUCHED. Returns the NEW full content string (the
   * dept_sleep host path seeds the live surface's reset from this), so the
   * next wake's fresh context already reflects the incremented ordinal before
   * the just-completed sleep. Throws loudly if the journal has no
   * `wake_counter:` frontmatter line (malformed journal). */
  const bumpHostSleepCounter = async (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }): Promise<string> => {
    const counterLine = content.match(/^wake_counter:\s*(\d+)$/m)
    if (counterLine === null) {
      throw new Error(`[deepartments] bumpHostSleepCounter: journal for ${memberId} has no "wake_counter:" frontmatter line — cannot advance the wake ordinal`)
    }
    const bumpedWake = Number(counterLine[1]) + 1
    const bumped = content.replace(/^wake_counter:\s*\d+$/m, `wake_counter: ${bumpedWake}`)
    const memoPath = journalPathFor(memberId)
    const tmpPath = `${memoPath}.tmp`
    try {
      await writeFile(tmpPath, bumped, 'utf8')
      await rename(tmpPath, memoPath)
    } catch (error: unknown) {
      // Best-effort cleanup of the temp file; ignore cleanup errors.
      try { await unlink(tmpPath) } catch { /* ignore */ }
      throw error
    }
    // Task T1 — AFTER the sleep-boundary commit, archive the bumped entry +
    // capture the just-ended cycle's session log (best-effort/non-fatal).
    if (archive?.sessionId !== undefined) {
      const boundarySeq = archive.boundarySeq ?? hosts.get(memberId)?.boundarySeq
      let lastWakeMs: number | undefined
      const lw = bumped.match(/^last_wake:\s*(.+)$/m)
      if (lw !== null) { const t = Date.parse(lw[1].trim()); if (!Number.isNaN(t)) lastWakeMs = t }
      await archiveCycle(memberId, archive.roomId ?? 'board', archive.sessionId, bumpedWake, bumped, boundarySeq, lastWakeMs)
    }
    return bumped
  }

  /** Advance a REGISTERED POST's (head OR worker) journal `wake_counter` by
   * exactly 1 at the dept_sleep seed boundary and persist atomically — the
   * post/worker analogue of bumpHostSleepCounter, giving heads + workers the
   * SAME ordinal semantics as the host (the counter advances ONLY here at
   * sleep, never on a plain write; see writeJournal). Pure counter bump: the
   * base author/room/timestamp/last_wake/current_step/board_cursor frontmatter
   * and the body are left UNTOUCHED. Returns the NEW full content string.
   * Throws loudly if the journal has no `wake_counter:` frontmatter line. */
  const bumpPostSleepCounter = async (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }): Promise<string> => {
    const counterLine = content.match(/^wake_counter:\s*(\d+)$/m)
    if (counterLine === null) {
      throw new Error(`[deepartments] bumpPostSleepCounter: journal for ${memberId} has no "wake_counter:" frontmatter line — cannot advance the wake ordinal`)
    }
    const bumpedWake = Number(counterLine[1]) + 1
    const bumped = content.replace(/^wake_counter:\s*\d+$/m, `wake_counter: ${bumpedWake}`)
    const memoPath = journalPathFor(memberId)
    const tmpPath = `${memoPath}.tmp`
    try {
      await writeFile(tmpPath, bumped, 'utf8')
      await rename(tmpPath, memoPath)
    } catch (error: unknown) {
      // Best-effort cleanup of the temp file; ignore cleanup errors.
      try { await unlink(tmpPath) } catch { /* ignore */ }
      throw error
    }
    // Task T1 — AFTER the sleep-boundary commit, archive the bumped entry +
    // capture the just-ended cycle's session log (best-effort/non-fatal).
    if (archive?.sessionId !== undefined) {
      const boundarySeq = archive.boundarySeq ?? byPost.get(memberId)?.boundarySeq
      let lastWakeMs: number | undefined
      const lw = bumped.match(/^last_wake:\s*(.+)$/m)
      if (lw !== null) { const t = Date.parse(lw[1].trim()); if (!Number.isNaN(t)) lastWakeMs = t }
      await archiveCycle(memberId, archive.roomId ?? 'board', archive.sessionId, bumpedWake, bumped, boundarySeq, lastWakeMs)
    }
    return bumped
  }

  /** Read a post's journal (undefined when absent). */
  const readJournal = async (memberId: string): Promise<string | undefined> => {
    try {
      return await readFile(journalPathFor(memberId), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** The configured coordinator (for persona/agentOptions) of a postId, if any.
   * Not every resident post maps to a configured department (a postId is usually
   * a coordinator, but the lifecycle should not hard-depend on one). */
  const coordinatorForPost = (postId: string): CoordinatorConfig | undefined => {
    for (const department of org.departments) {
      if (department.coordinator?.postId === postId) return department.coordinator
    }
    return undefined
  }

  /** The CONFIG DEPARTMENT of a registered post, if its coordinator matches
   * (F1). A configured HEAD derives its department here; a WORKER carries the
   * link durably in its own entry (recorded at create from the creating head's
   * department — `departmentForPost(creatorId)`) and has no config row.
   * Undefined = not a configured head (a worker, or a legacy/non-config post). */
  const departmentForPost = (postId: string): DepartmentConfig | undefined => {
    for (const department of org.departments) {
      if (department.coordinator?.postId === postId) return department
    }
    return undefined
  }

  /** The CONFIG DEPARTMENT of a catalog entry (F5, spec 004 §6.2): a worker
   * carries its link durably (`entry.departmentId` — recorded at create from
   * the creating head's department); a configured head derives it from config
   * (`departmentForPost`). A worker whose departmentId no longer exists in
   * config (a removed department), OR a legacy pre-F1 worker (no departmentId),
   * yields undefined → the caller falls back to the shared workspace root
   * (compat — the session keeps its cwd; a fresh create uses the root). */
  const departmentForEntry = (entry: PostEntry): DepartmentConfig | undefined => {
    if (entry.departmentId !== void 0) {
      const byId = org.departments.find((d) => d.id === entry.departmentId)
      if (byId !== void 0) return byId
    }
    return departmentForPost(entry.postId)
  }

  // FASE 2 step (e): the NON-pure wake-pack assembly (git bearings, ROADMAP
  // tail, skill body, message delta, condensed roster, system state) + the
  // `agent/pre-step` injector now live in ./core/wakepack.js (the WAKE CONTEXT
  // PACK + ROSTER module). The apply fiber builds ONE WakePackService below and
  // injects the closure-bound deps (the catalog maps + identity resolvers + the
  // deferred sleep surface replace + the W8-d heartbeat assembly). Only the
  // W8-d heartbeat assembly (the health section) remains here — it is injected
  // into the service as a closure-bound dep.

  /** W8-d PART A — compute the `## System heartbeat:` snapshot at assembly time
   * (live reads; buildHeartbeatSection is the pure renderer). Reads the SAME
   * session event logs + inbox the W8-c watchdog uses (buildPostSnapshot /
   * readInboxByPost / scanHostWaits), so the ages are NEVER reimplemented.
   * Gated by `health.heartbeatEnabled` (default on): an explicit false → the
   * snapshot is undefined (the section is OMITTED, never a throw). ANY read
   * failure degrades to undefined (omitted section). */
  const assembleHeartbeat = (hostId: string): string | undefined => {
    const health = config.health
    if (health?.heartbeatEnabled === false) return undefined
    try {
      const nowMs = Date.now()
      const waitThresholdMs = resolveSystemWaitMs(health)
      const { inboxTsByPost, hostRowsByPost } = readInboxByPost(stateDir, hostId, nowMs, HEALTH_ERROR_WINDOW_MS)
      // HOST last-activity (the Asistente session's last logged event) — reuse
      // the same snapshot primitive with an empty inbox (only activity matters).
      const hostEntry = [...hosts.values()].find((entry) => entry.hostId === hostId)
      const hostLive = hostEntry !== undefined ? agents?.get(SessionId(hostEntry.sessionId)) : undefined
      const hostEvents = (hostLive?.session?.events ?? []) as HealthSessionEvent[]
      const hostSnap = buildPostSnapshot({ postId: hostId, events: hostEvents, inboxTs: [] })
      // Per ACTIVE (and dormant) catalog post rows + the WAIT scan inputs +
      // the W8-h INTERRUPTED (stopped) postIds.
      const rows: HeartbeatRow[] = []
      const hostWaitPosts: HostWaitPostInput[] = []
      const interruptedPostIds: string[] = []
      for (const [postId, entry] of byPost) {
        if (entry.retired === true) continue
        const live = agents?.get(SessionId(entry.sessionId))
        const events = (live?.session?.events ?? []) as HealthSessionEvent[]
        const snap = buildPostSnapshot({ postId, events, inboxTs: inboxTsByPost.get(postId) ?? [] })
        rows.push({
          postId,
          sleeping: entry.sleepEpoch !== void 0,
          ...(snap.lastActivityTs !== undefined ? { lastActivityTs: snap.lastActivityTs } : {}),
          pendingCount: snap.pendingCount,
          ...(snap.oldestPendingTs !== undefined ? { oldestPendingTs: snap.oldestPendingTs } : {})
        })
        hostWaitPosts.push({ postId, retired: false, events, hostMessages: hostRowsByPost.get(postId) ?? [], sleeping: entry.sleepEpoch !== void 0 })
        // W8-h — a post is INTERRUPTED (stopped) when its session ends in an
        // interrupted turn AND it is NOT a LIVE-RUNNING agent (a live running
        // turn is healthy progress, never a stop). Reuses the SAME pure detector
        // the boot reconciliation uses.
        const capture = scanInterruptedTurn(events, entry.sessionId, postId)
        if (capture !== undefined && !(live !== undefined && live.status === 'running')) {
          interruptedPostIds.push(postId)
        }
      }
      const waits = scanHostWaits(hostWaitPosts, nowMs, waitThresholdMs)
      const waitReason = waits.length > 0
        ? `host waiting on ${waits.map((wait) => wait.postId).join(', ')}: ${waits[0].error ?? 'no reply or session activity'}`
        : undefined
      return buildHeartbeatSection(
        {
          hostLastActivityTs: hostSnap.lastActivityTs,
          rows,
          ...(waitReason !== undefined ? { waitReason } : {}),
          ...(interruptedPostIds.length > 0 ? { interruptedPostIds } : {})
        },
        nowMs
      )
    } catch {
      return undefined
    }
  }

  // D3 (subagent/gui/pooler phase): the dispatch-time transient-subagent role
  // registry is now a CORE SERVICE (`deepartments.subagentRoles` — ONE
  // per-process store in dshd-core; written by src/subagent.ts at dispatch).
  // The wake-pack `roleForSession` dep READS it here, in BOTH the in-bundle
  // fallback construction and the dshd-core binder registration below, so the
  // composed and the bundle-alone paths resolve the SAME role. When the service
  // is absent (a minimal composition), fall back to the drop-in compat function
  // the role-orient bridge re-exports — the SAME store (R6, behavior-neutral:
  // `get` with the `?? 'generic'` default is exactly `roleForSession`).
  const subagentRoles = ctx.get('deepartments.subagentRoles') as SubagentRolesService | undefined
  const roleForSessionLive = subagentRoles === undefined
    ? roleForSession
    : (sessionId: string) => subagentRoles.get(sessionId) ?? 'generic'

  // FASE 2 step (e): build the ONE per-apply WakePackService (the wake-pack
  // injector + roster). The service lives in ./core/wakepack.js and owns the
  // condensed roster (`buildCondensedRoster`, which derives the ACTIVE-ONLY
  // member list from the single-source `listActiveMembers`), the pack assembly
  // (`assembleWakePack` / `assembleWakeSnapshot`) and the `agent/pre-step`
  // injector. The deps below are the closure-bound catalog maps + identity
  // resolvers + the deferred sleep surface replace + the W8-d heartbeat
  // assembly (kept in invoke.ts — health concern), mirroring registry/delivery.
  // FASE 2.5 BATCH B: consume the wakepack SERVICE from dshd-core when composed;
  // fall back to a behavior-neutral in-bundle construction + warn in a minimal
  // composition (dshd-core absent).
  const wakePackService = (ctx.get('deepartments.wakepack') as WakePackService | undefined) ?? (() => {
    ctx.logger.warn('[deepartments] dshd-core is not composed — the wakepack service is constructed in-bundle (behavior-neutral fallback).')
    return createWakePackService({
      byPost,
      hosts,
      getHost: (hostId) => hosts.get(hostId),
      postIdForChild,
      hostIdForSession,
      refreshPresence,
      wakePackInjected,
      deferredSleepReplace,
      persistHosts,
      roleForSession: roleForSessionLive,
      buildSubagentOrientation,
      // E2 — the DIRECTORIO section is assembled from the bundle's own org
      // departments (the minimal-composition fallback of the SHARED CONFIG
      // SOURCE `deepartments.org` — the dshd-core row when composed): the pack
      // never hardcodes the org chart; add/remove a department = edit config.
      // Optional slice (name + coordinator.postId + purpose/services) — a
      // legacy config without the E2 fields composes and the directory section
      // renders only what carries purpose/services (R6).
      departments: org.departments,
      computeHostSleepSurfacePlan,
      buildSleepJournalMessage,
      assembleHeartbeat,
      readPresenceStateFile,
      journalPathFor,
      // Lazy getter: the message store is opened later in applyInvoke (single-
      // process open); resolved at assembly time, never at construction.
      messagesStoreReady: () => messagesStoreReady,
      stateDir: stateDir,
      repoRoot,
      // PACING (owner m-PACING, 2026-08-28): the org.pacing.* franja config for
      // the wake-pack `## Pacing (franja)` section (the minimal-composition
      // fallback of the SHARED CONFIG SOURCE — the dshd-core lazy service
      // reads org.org.pacing; here the bundle passes its own org.pacing).
      // Absent config → the code defaults (enabled ON); enabled:false → the
      // section is omitted (the pre-pacing pack).
      pacing: org.pacing,
      logger: ctx.logger
    })
  })()

  // The wake pack is registered on the SAME `agent/pre-step` Cordis waterfall
  // the runtime-context + skill-catalog use (no dsh-core change). The actual
  // injector logic (host-only, retired-gated, once-per-session) lives in
  // wakepack.js; invoke.ts merely registers the listener and delegates.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    return wakePackService.preStepHandler({ agent, signal }, next as () => Promise<unknown>) as unknown as Promise<Awaited<ReturnType<typeof next>>>
  })

  // --- F3 (spec 004 §3.2/§5.2/§7.4): ROLE TEMPLATES --------------------------
  // A role is a PERSONA TEMPLATE referenced by name, versioned in the repo at
  // `presets/departments/<dept-id>/<role>.md` (frontmatter `id`/`title`/`tools`
  // + persona body). Roles are NOT agent presets (no preset.yml /
  // agent.cordis.yml pair — see presets/departments/research/README.md): the
  // worker still mounts the neutral base `deepartments-worker` preset and the
  // ROLE DELTA is the persona, injected as a systemPrompt section at spawn
  // time (installRoleSection `extra`). The `tools` frontmatter is DOCUMENTED
  // ONLY in this phase: postSetup still masks every global with the lean
  // `restrict({allow: []})` and there is NO role-driven allow list binding
  // yet (spec §7.1/§9 — a later phase).

  /** One resolved role template (the persona delta + display title). */
  interface RoleTemplate {
    id: string
    title: string
    tools?: string[]
    persona: string
    path: string
  }

  /** The repo path of one department's role template file. */
  const roleTemplatePath = (departmentId: string, role: string): string =>
    path.join(repoRoot, 'presets', 'departments', departmentId, `${role}.md`)

  // --- W1 job-run core (shared by dept_job_run AND the scheduler daemon) -----
  // These two guards + `runJobForDepartment` are hoisted to the APPLY scope so
  // the scheduler (a plugin daemon with no calling agent) can fire a due job
  // through the EXACT engine dept_job_run uses — no tool-vs-scheduler drift.
  // The job reader is module-level (parseJobDefFrontmatter/jobDirFor/
  // readJobDefinitionFile), shared with the agenda/dispatch.

  /** Validate the job's `role` BEFORE the spawn (spec 005 §5.4): the role MUST
   * name an existing role template of the department
   * (`presets/departments/<dept-id>/<role>.md` — the same tree F3's
   * readRoleTemplate resolves); missing → job-scoped loud error. */
  const validateJobRole = async (departmentId: string, jobId: string, role: string): Promise<void> => {
    const filePath = roleTemplatePath(departmentId, role)
    try {
      await readFile(filePath, 'utf8')
    } catch {
      throw new Error(`[deepartments] dept_job_run: job "${jobId}" declares role "${role}" which has no template at ${filePath} — a role must be a file presets/departments/${departmentId}/<role>.md`)
    }
  }

  /** The LIVE (non-retired) worker already running the job in THIS department
   * (spec §5.4 idempotency): a second run of the same job must NOT spawn a
   * duplicate — the head finishes by retiring the worker explicitly. */
  const runningJobWorker = (jobId: string, departmentId: string): string | undefined => {
    for (const entry of byPost.values()) {
      if (entry.provider === 'worker' && entry.retired !== true && entry.departmentId === departmentId && entry.jobId === jobId) return entry.postId
    }
    return undefined
  }

  /** fb-9 (QH MEDIA — the class 400 `reasoning_content must be passed back`
   * that burned a whole mission: 570s/~55k tokens, 0 deliverable): the ACTIVE
   * worker route (WORKER_AGENT_OPTIONS.provider — 'opencode-zen', the route
   * every spawn/job worker materializes with) is PRE-FLIGHTED against the
   * <stateDir>/settings.yaml profile BEFORE any worker materialization. A
   * provider the profile positively declares reasoning-enabled whose profile
   * lacks `compat.requiresReasoningContentOnAssistantMessages: true` (the
   * schema-correct nested path the adapter reads — a provider-TOP-LEVEL flag
   * is the DEAD key that produced the m-603 GREEN FALSE and is NOT resolved
   * by the reader) → a CLEAR EARLY
   * error (the expensive 400 never happens mid-mission). CONSERVATIVE guard:
   * flag present / reasoning off / profile absent-or-unreadable → undefined
   * (passthrough — the pre-flight is a guard, never a blocker). The decision
   * is one read of the same settings.yaml the FIX-2 boot check already reads
   * (via the dshd-pooler reader — consumption only). */
  const workerReasoningContentPreflightError = (): string | undefined => {
    const provider = WORKER_AGENT_OPTIONS.provider
    if (typeof provider !== 'string' || provider === '') return undefined
    const settings = readLlmPiAiProviderSettings(stateDir)
    const verdict = resolveReasoningContentPreflight(provider, settings, stateDir)
    return verdict.ok ? undefined : verdict.reason
  }

  /** DISPATCH-HARDENING (QH — the «429-primer-call» class, 2026-08-28): the
   * POOLER-CAPACITY DISPATCH PRE-CHECK (the BEFORE half — the AFTER half is
   * the b5-ghost live-post guard). The SAME dispatch seam as fb-9 (the 3+1:
   * runJobForDepartment / spawnWorkerForDepartment / dept_post_create / the
   * materializePost resume seam) READS the pooler's own
   * `keyPooler-state.json` SOLO-LECTURA (the same reader the M1 watchdog uses;
   * the path is `health.poolerStateFilePath` when set, else
   * `<DSH_HOME>/keyPooler-state.json` — the M1 wiring) and, when the snapshot
   * CERTAINS that no workspace can serve the spawn's FIRST call (zero usable
   * keys, every usable key at/above `health.highPercent`, or a last 429
   * usage-limit rotation to no key — the 503 prelude), returns the CLEAR EARLY
   * error the dispatch seam throws BEFORE any materialization — the expensive
   * primer-call 429/503 (a freshly spawned worker dying on its very first LLM
   * turn) never happens. CONSERVATIVE — a warning, never a blocker: absent /
   * unreadable / STALE state → undefined (passthrough, unknown ≠ exhausted);
   * the `health.poolerDispatchEnabled: false` knob restores the pre-check-less
   * dispatch (the M1 poolerCapacityEnabled pattern). */
  const workerPoolerDispatchBlockError = (): string | undefined => {
    if (config.health?.poolerDispatchEnabled === false) return undefined
    const poolerStatePath = config.health?.poolerStateFilePath !== undefined && config.health.poolerStateFilePath.trim() !== ''
      ? config.health.poolerStateFilePath
      : path.join(dshHome(), POOLER_STATE_FILE)
    const block = resolvePoolerDispatchBlock(
      poolerStatePath,
      Date.now(),
      {
        highPercent: resolvePositiveKnob(config.health?.highPercent, POOLER_CAPACITY_DEFAULT_HIGH_PERCENT),
        stateStaleMs: resolvePositiveKnob(config.health?.stateStaleMs, POOLER_CAPACITY_DEFAULT_STATE_STALE_MS)
      },
      ctx.logger
    )
    return block === undefined ? undefined : block.reason
  }

  /** Run ONE department job — the dept_worker_spawn contract (dept_job_run's
   * body, minus the exec.agent derivation): read the definition, validate the
   * role, enforce the already-running idempotency, materialize the worker root
   * agent (departmentId/managerId/jobId), pin the HUMAN title, deliver the JOB
   * BODY as its first durable bus message. Shared by dept_job_run (the head's
   * manual run) and the W1 scheduler (an automatic run). `opts.callerSessionId`
   * is the sender for the delivery frame (dept_job_run passes the head's live
   * session; the scheduler passes the head's durable session id). */
  const runJobForDepartment = async (
    department: DepartmentConfig,
    headEntry: PostEntry,
    jobId: string,
    opts: { callerSessionId?: string; signal?: AbortSignal } = {}
  ): Promise<{ workerId: string; sessionId: string; title: string; jobId: string; role: string; jobPath: string }> => {
    if (agents === void 0) throw new Error('[deepartments] dept_job_run requires the agents service')
    // 0. fb-9 pre-flight (BEFORE anything — never a mid-mission 400): reject
    // the dispatch LOUDLY when the active worker route's profile has reasoning
    // enabled but lacks compat.requiresReasoningContentOnAssistantMessages=true
    // (the schema-correct nested path; a provider-level key is dead and is
    // detected as missing, never a green false).
    const preflightError = workerReasoningContentPreflightError()
    if (preflightError !== undefined) throw new Error(`[deepartments] ${preflightError}`)
    // 0b. DISPATCH-HARDENING (QH «429-primer-call»): the pooler-capacity
    // pre-check — reject LOUDLY and EARLY (BEFORE the definition read, the
    // role validation, the idempotency pass, ANY agents.create — nothing is
    // registered) when the pooler snapshot certifies no workspace can serve
    // the job worker's first call.
    const poolerDispatchBlock = workerPoolerDispatchBlockError()
    if (poolerDispatchBlock !== undefined) throw new Error(`[deepartments] ${poolerDispatchBlock}`)
    // 1. Read + parse the definition FIRST (loud: missing/broken → fail).
    const definition = await readJobDefinitionFile(repoRoot, department, jobId)
    // 2. Role validation against the department role template tree.
    await validateJobRole(department.id, jobId, definition.meta.role)
    // 3. Idempotency (spec §5.4): never duplicate a running job worker.
    const running = runningJobWorker(jobId, department.id)
    if (running !== void 0) {
      throw new Error(`[deepartments] dept_job_run: job already running: ${running} — retire it explicitly with dept_worker_retire to restart "${jobId}"`)
    }
    // 4. dept_worker_spawn contract replicated (shared helpers — the F3 spawn
    // engine is untouched): resolve the role template, slug-dedup, materialize,
    // pin the HUMAN title, deliver the JOB BODY as the first bus message.
    const template = await readRoleTemplate(department.id, definition.meta.role)
    const postId = dedupedWorkerSlug(jobId)
    const sessionId = SessionId(mintWorkerSessionId(postId))
    if (agents.get(String(SessionId(sessionId))) !== void 0) throw new Error(`[deepartments] dept_job_run: a live agent already exists for session "${sessionId}"`)
    const title = definition.meta.title.trim() !== '' ? definition.meta.title : defaultWorkerTitle(definition.meta.role, definition.body, jobId, postId)
    const setup = workerSetup(postId, headEntry.roomId, definition.meta.role, { persona: template.persona, taskText: sanitizePromptLiterals(definition.body), tools: template.tools, department })
    const deptCwd = await resolveDepartmentWorkspaceCwd(department)
    const handle = await agents.create({
      sessionId: String(SessionId(sessionId)),
      meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: WORKER_PRESET_ID },
      agentOptions: WORKER_AGENT_OPTIONS,
      setup
    })
    registerEntry({
      postId,
      sessionId: String(SessionId(sessionId)),
      roomId: headEntry.roomId,
      agentPreset: WORKER_PRESET_ID,
      provider: 'worker',
      role: definition.meta.role,
      managerId: headEntry.postId,
      departmentId: department.id,
      jobId
    })
    byHeadHandle.set(String(SessionId(sessionId)), handle)
    const titleSession = ctx.sessions.get(sessionId)
    if (titleSession !== void 0) {
      const titlePin = pinSessionTitle(titleSession, title)
      if (titlePin === 'pinned') {
        ctx.logger.info(`[deepartments] dept_job_run: pinned worker session title "${title}" (${sessionId})`)
      } else if (titlePin === 'failed') {
        ctx.logger.warn(`[deepartments] dept_job_run: worker session title pin failed for ${sessionId} (non-fatal — worker registration continues)`)
      }
    }
    const store = await messagesStoreReady
    const record = await store.append({
      from: headEntry.postId,
      to: [postId],
      text: definition.body,
      kind: 'agent'
    })
    await deliverBusRecord(record, postId, opts.callerSessionId ?? '', opts.callerSessionId, opts.signal)
    return { workerId: postId, sessionId: String(SessionId(sessionId)), title, jobId, role: definition.meta.role, jobPath: definition.path }
  }

  /** Spawn a DISPOSABLE department worker — the SHARED dept_worker_spawn engine.
   * Used by the head own-layer `dept_worker_spawn` tool AND the parallel-monitor
   * daemon (the monitor spawns a researcher through the SAME path a head would,
   * so the worker registers identically: root agent, provider:"worker", role,
   * managerId = the head, departmentId, jobId (when given), persona + task
   * injection, title pin, first bus message from the head). `opts.title` (when
   * non-empty) overrides the default "<RoleDisplay>: <mission>"; `opts.jobId`
   * is the slug base + the recorded jobId (the monitor uses its monitor id).
   * `opts.callerAgentId`/`opts.senderSessionId` default to the head's session id
   * (the daemon path); dept_worker_spawn passes the calling head's agent id.
   * Returns the worker post id + session id + the pinned title. */
  const spawnWorkerForDepartment = async (
    department: DepartmentConfig,
    headEntry: PostEntry,
    opts: { role: string; task?: string; title?: string; jobId?: string; callerAgentId?: string; senderSessionId?: string; signal?: AbortSignal }
  ): Promise<{ workerId: string; sessionId: string; title: string }> => {
    if (agents === void 0) throw new Error('[deepartments] dept_worker_spawn requires the agents service')
    // 0. fb-9 pre-flight (BEFORE any materialization — never a mid-mission 400):
    // the active worker route's profile must carry
    // compat.requiresReasoningContentOnAssistantMessages=true when reasoning is
    // enabled, else the dispatch is rejected with a CLEAR EARLY error (the
    // expensive 400 that burned the fb-9 mission can never happen again).
    const preflightError = workerReasoningContentPreflightError()
    if (preflightError !== undefined) throw new Error(`[deepartments] ${preflightError}`)
    // 0b. DISPATCH-HARDENING (QH «429-primer-call»): the pooler-capacity
    // pre-check — reject LOUDLY and EARLY (BEFORE the role read, the slug
    // dedup, ANY agents.create — nothing is registered) when the pooler
    // snapshot certifies no workspace can serve the worker's first call.
    const poolerDispatchBlock = workerPoolerDispatchBlockError()
    if (poolerDispatchBlock !== undefined) throw new Error(`[deepartments] ${poolerDispatchBlock}`)
    const role = String(opts.role ?? '').trim()
    if (role === '') throw new Error('[deepartments] dept_worker_spawn: `role` is required (a role template name, e.g. "researcher")')
    // Role template is resolved BEFORE any create: a missing/malformed role file
    // fails the spawn loudly (never a persona-less worker).
    const template = await readRoleTemplate(department.id, role)
    // Slug dedup (spec §5.2): base = jobId ?? role; -2/-3… on collision —
    // INCLUDING RETIRED slugs (F1 keeps retired entries in byPost).
    const postId = dedupedWorkerSlug(opts.jobId ?? role)
    const sessionId = SessionId(mintWorkerSessionId(postId))
    if (agents.get(String(SessionId(sessionId))) !== void 0) throw new Error(`[deepartments] dept_worker_spawn: a live agent already exists for session "${sessionId}"`)
    const title = (opts.title ?? '').trim() !== '' ? (opts.title as string) : defaultWorkerTitle(role, opts.task, opts.jobId, postId)
    const setup = workerSetup(postId, headEntry.roomId, role, { persona: template.persona, taskText: opts.task === undefined ? undefined : sanitizePromptLiterals(opts.task), tools: template.tools, department })
    // F5 (spec 004 §6.2 L1): the worker lands in its department workspace.
    const deptCwd = await resolveDepartmentWorkspaceCwd(department)
    const handle = await agents.create({
      sessionId: String(SessionId(sessionId)),
      meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: WORKER_PRESET_ID },
      agentOptions: WORKER_AGENT_OPTIONS,
      setup
    })
    registerEntry({
      postId,
      sessionId: String(SessionId(sessionId)),
      roomId: headEntry.roomId,
      agentPreset: WORKER_PRESET_ID,
      provider: 'worker',
      role,
      managerId: headEntry.postId,
      departmentId: department.id,
      ...(opts.jobId !== void 0 ? { jobId: opts.jobId } : {})
    })
    byHeadHandle.set(String(SessionId(sessionId)), handle)
    // F3 pin (spec §5.2): human-readable sidebar row — the owner's manual rename
    // always wins, a failed pin only logs (registration stands).
    const titleSession = ctx.sessions.get(sessionId)
    if (titleSession !== void 0) {
      const titlePin = pinSessionTitle(titleSession, title)
      if (titlePin === 'pinned') {
        ctx.logger.info(`[deepartments] dept_worker_spawn: pinned worker session title "${title}" (${sessionId})`)
      } else if (titlePin === 'failed') {
        ctx.logger.warn(`[deepartments] dept_worker_spawn: worker session title pin failed for ${sessionId} (non-fatal — worker registration continues)`)
      }
    }
    // Deliver the assignment (or a creation note) as a DURABLE bus message from
    // the head — the worker wakes on it. ACL (F2): head → own department worker.
    const text = (opts.task ?? '').trim() !== ''
      ? opts.task as string
      : `[created] worker "${postId}" (${role}) is registered. You are disposable — work your assigned task, then dept_memo_write and report to your head; your head retires you with dept_worker_retire when you are done.`
    const store = await messagesStoreReady
    const record = await store.append({
      from: headEntry.postId,
      to: [postId],
      text,
      kind: 'agent'
    })
    await deliverBusRecord(record, postId, opts.callerAgentId ?? headEntry.sessionId, opts.senderSessionId ?? headEntry.sessionId, opts.signal)
    return { workerId: postId, sessionId: String(SessionId(sessionId)), title }
  }


  /** Parse the LEAN frontmatter the role templates use (spec §3.2:
   * `---`-delimited YAML-lite — `key: value` scalars + `- item` lists for
   * `tools`). Returns the meta map + the persona body, or undefined when the
   * file has no well-formed frontmatter block. Deliberately NOT a YAML
   * dependency (the bundle adds none): the role format is a constrained
   * subset, and a malformed template must fail loud at spawn (spec §5.4
   * analogy), never silently spawn a persona-less worker. */
  const parseRoleTemplateFrontmatter = (text: string): { meta: Record<string, string | string[]>; body: string } | undefined => {
    const lines = text.split('\n')
    if (lines[0]?.trim() !== '---') return undefined
    let end = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        end = i
        break
      }
    }
    if (end < 0) return undefined
    const meta: Record<string, string | string[]> = {}
    let lastKey: string | undefined
    for (let i = 1; i < end; i++) {
      const line = lines[i]
      const scalar = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
      if (scalar !== null) {
        lastKey = scalar[1]
        const value = scalar[2].trim()
        // `tools:` with no inline value opens a list (the `- item` lines below).
        meta[lastKey] = value === '' ? [] : value
        continue
      }
      const item = /^\s*-\s+(.*)$/.exec(line)
      if (item !== null && lastKey !== undefined) {
        const current = meta[lastKey]
        if (Array.isArray(current)) current.push(item[1].trim())
        else meta[lastKey] = [item[1].trim()]
      }
    }
    const body = lines.slice(end + 1).join('\n').trim()
    if (body === '') return undefined
    return { meta, body }
  }

  /** Resolve + validate ONE role template (loud errors — a missing or
   * malformed role file must fail the spawn). The frontmatter `id` must match
   * the name it is referenced by (the file name IS the role id, §3.2); the
   * `title` is the display title fallback for the sidebar pin. */
  const readRoleTemplate = async (departmentId: string, role: string): Promise<RoleTemplate> => {
    const filePath = roleTemplatePath(departmentId, role)
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error: unknown) {
      throw new Error(`[deepartments] dept_worker_spawn: role "${role}" has no template at ${filePath} — a role must be a file presets/departments/${departmentId}/<role>.md (frontmatter id/title/tools + persona body)`)
    }
    const parsed = parseRoleTemplateFrontmatter(text)
    if (parsed === void 0) {
      throw new Error(`[deepartments] dept_worker_spawn: role template "${role}" (${filePath}) has no valid frontmatter — expected a '---' block (id/title/tools) plus a persona body`)
    }
    const declaredId = typeof parsed.meta.id === 'string' ? parsed.meta.id : void 0
    if (declaredId !== role) {
      throw new Error(`[deepartments] dept_worker_spawn: role template "${role}" (${filePath}) declares frontmatter id "${declaredId ?? '(none)'}" — the file name must match the role id it is referenced by`)
    }
    const title = typeof parsed.meta.title === 'string' && parsed.meta.title.trim() !== '' ? parsed.meta.title : role
    const toolsValue = parsed.meta.tools
    const tools = Array.isArray(toolsValue) ? toolsValue.filter((item): item is string => typeof item === 'string') : void 0
    return { id: declaredId, title, tools, persona: parsed.body, path: filePath }
  }

  /** The mission headline of a deployed worker's default sidebar title (owner
   * decision 2026-08-23 "siempre Rol: Misión"): the FIRST line of the task
   * text, cut to ~`MISSION_MAX` chars (a truncation ellipsis when it exceeds),
   * falling back to the job id / derived post id when there is no task text. */
  const MISSION_MAX = 70
  const workerMission = (task: string | undefined, jobId: string | undefined, postId: string): string => {
    const trimmed = (task ?? '').trim()
    const firstLine = trimmed === '' ? '' : trimmed.split('\n')[0].trim()
    if (firstLine === '') return jobId ?? postId
    if (firstLine.length > MISSION_MAX) return `${firstLine.slice(0, MISSION_MAX - 3).trimEnd()}...`
    return firstLine
  }

  /** The RoleDisplay of a deployed worker's default sidebar title: the role
   * capitalized (researcher→"Researcher", reviewer→"Reviewer",
   * analyst→"Analyst", organizer→"Organizer"; any other role → its first
   * letter capitalized). */
  const roleDisplay = (role: string): string =>
    role === '' ? role : role.charAt(0).toUpperCase() + role.slice(1)

  /** The default sidebar title of a deployed worker (owner decision 2026-08-23:
   * "siempre que se deployee un agente: Rol: Misión como nombre"):
   * `<RoleDisplay>: <mission>` — the role capitalized + the first line(s) of
   * the task (cut to ~70 chars with a truncation ellipsis), falling back to
   * the job id / derived post id when there is no task text. A caller-passed
   * `title` always wins (respected verbatim); dept_job_run uses its HUMAN
   * frontmatter title when present. */
  const defaultWorkerTitle = (role: string, task: string | undefined, jobId: string | undefined, postId: string): string =>
    `${roleDisplay(role)}: ${workerMission(task, jobId, postId)}`

  /** Dedup the worker POST id (spec §5.2): the base slug (jobId ?? role) is
   * suffixed `-2`, `-3`… while the candidate is already registered — INCLUDING
   * RETIRED (a retired worker's id is never reused; F1 keeps retired entries
   * in byPost, so the dedup sees them) — or shadows a configured head. The
   * live-session guard mirrors dept_post_create's (a legacy orphan session). */
  const dedupedWorkerSlug = (base: string): string => {
    const sanitized = String(base ?? '').trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'worker'
    let slug = sanitized
    for (let n = 2; byPost.has(slug) || coordinatorForPost(slug) !== void 0 || (agents !== void 0 && agents.get(String(SessionId(workerSessionId(slug)))) !== void 0); n++) {
      slug = `${sanitized}-${n}`
    }
    return slug
  }

  /** Disposer closure per tool the head own-layer registers. */
  type HeadToolDisposers = { dispose: () => void }

  // --- W1 calendar helpers (shared by the calendar tools + the scheduler) ---
  // `<stateDir>/calendar.json` is the runtime agenda store. The read helper is
  // the module-level PURE reader; the write helper folds an fs failure to a
  // warn so an RPC/tick never fails on a persist error (mirrors savePresence).

  /** The runtime calendar state (always `{entries:[...]}`, never throws). */
  const readCalendar = (): CalendarState => readCalendarStateFile(stateDir)

  /** Persist the runtime calendar, folding an fs failure to a warn. */
  const writeCalendarBestEffort = async (state: CalendarState): Promise<void> => {
    try {
      await writeCalendarStateFile(stateDir, state)
    } catch (error) {
      ctx.logger.warn(`[deepartments] calendar.json write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Whether the department owns a job definition `<jobId>.md` (validates the
   * optional `jobId` on dept_calendar_add: a calendar entry may only reference
   * a KNOWn job of the caller's department). */
  const departmentJobExists = async (department: DepartmentConfig, jobId: string): Promise<boolean> => {
    const jobDir = jobDirFor(repoRoot, department)
    try {
      await readFile(path.join(jobDir, `${jobId}.md`), 'utf8')
      return true
    } catch {
      return false
    }
  }

  // --- dept_exec helpers (spec W5-B2, SCOPED shell for department posts) ----
  // The pure guard + the allow-roots are the scope policy; these two helpers
  // build the realpath-resolved root set and run the execFile. The tool is
  // registered in installHeadBoardTools ONLY when the post's role declare-list
  // includes `dept_exec` (see postSetup's allowExec computation below).

  /** The realpath-resolved SET of allowed roots for a dept_exec call: the fixed
   * DEPT_EXEC_DEFAULT_ROOTS, the repo root, the runtime stateDir, the caller's
   * department workspace, any configured org.execRoots, AND any configured
   * org.missionExecRoots (an EXPLICIT, REVOCABLE, AUDITABLE mission-level owner
   * grant that may name an OWNER-PROTECTED surface such as the STABLE home
   * `/opt/dsh/.dsh` for the DURATION of an owner-authorized mission). Each root
   * is realpath'd when it resolves (a symlink root collapses to its target, so
   * the cwd/path comparisons stay strict); an unresolvable root is kept verbatim. */
  const deptExecAllowedRoots = async (department: DepartmentConfig | undefined): Promise<string[]> => {
    const raw = new Set<string>(DEPT_EXEC_DEFAULT_ROOTS)
    raw.add(repoRoot)
    if (typeof stateDir === 'string' && stateDir.trim() !== '') raw.add(stateDir)
    const deptCwd = await resolveDepartmentWorkspaceCwd(department)
    if (deptCwd !== '') raw.add(deptCwd)
    for (const entry of (org.execRoots ?? [])) {
      if (typeof entry === 'string' && entry.trim() !== '') raw.add(entry.trim())
    }
    // MISSION-LEVEL owner grant: an explicit org.missionExecRoots entry adds the
    // surface (e.g. the STABLE home /opt/dsh/.dsh) to the allowed roots for the
    // DURATION of an OWNER-AUTHORIZED mission. It is EXPLICIT (an absent key
    // keeps the default deny — the stable home stays protected), AUDITABLE
    // (config-recorded, never an env default) and REVOCABLE (remove the entry).
    for (const entry of (org.missionExecRoots ?? [])) {
      if (typeof entry === 'string' && entry.trim() !== '') raw.add(entry.trim())
    }
    const resolved: string[] = []
    for (const root of raw) {
      try {
        resolved.push(await realpath(root))
      } catch {
        resolved.push(root)
      }
    }
    return resolved
  }

  /** Run ONE scoped shell command through `bash -lc` with a MINIMAL sanitized
   * env (PATH/HOME/LANG only — nothing else is leaked to the child). Returns
   * {ok, exitCode, stdout, stderr}; a non-zero exit or a killed command is a
   * normal `ok:false` result, never a throw (the caller decides the surface). */
  const runDeptExec = async (command: string, cwd: string): Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }> => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/root',
      LANG: process.env.LANG ?? 'C'
    }
    try {
      const { stdout, stderr } = await execFileP('bash', ['-lc', command], {
        cwd,
        timeout: DEPT_EXEC_TIMEOUT_MS,
        maxBuffer: DEPT_EXEC_MAX_BUFFER,
        env
      })
      return { ok: true, exitCode: 0, stdout, stderr }
    } catch (error: unknown) {
      const e = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean }
      const exitCode = typeof e.code === 'number' ? e.code : null
      return {
        ok: false,
        exitCode,
        stdout: typeof e.stdout === 'string' ? e.stdout : '',
        stderr: typeof e.stderr === 'string' ? e.stderr : (e.killed === true ? 'command killed (timeout)' : String(error ?? ''))
      }
    }
  }

  /** markdown renderer for the dept_exec result: exit code + stdout/stderr in
   * fenced code blocks, each TRUNCATED to a cap with an explicit marker. */
  const deptExecRender = (_args: unknown, value: { ok: boolean; exitCode: number | null; stdout: string; stderr: string }): Array<{ type: 'text'; text: string }> => {
    const MAX = 8000
    const truncate = (s: string): string => {
      const trimmed = String(s ?? '')
      return trimmed.length > MAX ? `${trimmed.slice(0, MAX)}\n… [truncated ${trimmed.length} chars]` : trimmed
    }
    const parts: string[] = [`exit code ${value.exitCode}${value.ok ? '' : ' (FAILED)'}`]
    if (value.stdout !== '') parts.push(`stdout:\n\`\`\`\n${truncate(value.stdout)}\n\`\`\``)
    if (value.stderr !== '') parts.push(`stderr:\n\`\`\`\n${truncate(value.stderr)}\n\`\`\``)
    return [{ type: 'text', text: parts.join('\n') } as const]
  }

  /** Install the post's messaging toolset scoped to `agentCtx` (the post's OWN
   * layer — no toolFilter needed for a root agent). The same tool bodies the
   * host plane registers, reused for any resident post: send_message,
   * agent_messages, dept_who, dept_memo_write, dept_sleep. dept_sleep's head
   * version also disposes the post's AgentHandle (the plugin's byHeadHandle
   * map) after marking sleepEpoch.
   *
   * Batch 3a — `manager: true` (a department HEAD, not a worker) additionally
   * registers the department-lifecycle tools `dept_post_create`,
   * `dept_post_retire` (legacy) AND the F3 department-scoped worker tools
   * `dept_worker_spawn` / `dept_worker_retire`, so a head can create/retire
   * the WORKERS of its own department. A worker (`manager: false`) gets ONLY
   * the messaging tools — never the create/retire life-cycle controls. These
   * create/worker-spawn/worker-retire controls register ONLY in the head
   * own-layer here; the host plane never exposes them. (The one host-plane
   * exception is the global `dept_post_retire`, registered separately below.) */
  const installHeadBoardTools = (agentCtx: Context, manager = false, opts: { allowExec?: boolean } = {}): HeadToolDisposers => {
    const disposers: Array<() => void> = []

    // Batch B2 — the agent-messaging bus tools (send_message / agent_messages /
    // dept_who) registered on the post's OWN layer: the own-layer registration
    // SHADOWS the globally-registered harness native `send_message` for this
    // agent (the harness override seam — same-layer duplicates throw, scoped
    // registrations win), and postSetup's lean `restrict({allow:[]})` masks the
    // globals anyway so this own layer is the ONLY visible toolset.
    for (const tool of busTools) disposers.push(agentCtx.tools.register(tool))

    // dshd-feedback phase (universal, ACL-free write): the EMIT tool
    // (`dept_feedback`) registers on EVERY post's OWN layer (head AND worker —
    // any agent may emit feedback). fb-18 (QH backlog): `dept_feedback_list` +
    // `dept_feedback_update` register ONLY in a HEAD's own layer (manager:true)
    // — a worker NEVER sees them, so the worker-DENIED ACL becomes a STRUCTURAL
    // absence (the tool is simply not in the worker toolset) instead of a
    // runtime `execute` reject; the QH-authority checks stay in `execute` as
    // defense-in-depth for the host plane / any legacy registration. The host
    // plane registers all three globally (see below).
    for (const tool of feedbackEmitTools) disposers.push(agentCtx.tools.register(tool))
    if (manager) {
      for (const tool of feedbackHeadTools) disposers.push(agentCtx.tools.register(tool))
    }

    // --- W1 (spec 004 §5.7 + ROADMAP W1): calendar tools — dept_calendar_add /
    // dept_calendar_list / dept_calendar_remove. Registered on EVERY post's OWN
    // layer (head AND worker — the runtime agenda is department-scoped, not
    // head-only), right where the bus tools register. The runtime store is the
    // shared `<stateDir>/calendar.json` (dept_* tools and the agenda/list
    // dispatch read the same file). An ad-hoc entry fires ONCE (no recurrence);
    // `jobId?` links it to a department job so the scheduler runs that job when
    // the entry's `at` passes (instead of only notifying the head). ------------
    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_calendar_add',
      description: 'Add ONE ad-hoc calendar entry to the SHARED department agenda (spec 004 §5.7 — a single <stateDir>/calendar.json across every department, so the agenda is unified/global; the entry is stamped with `departmentId` = your department). `label` (non-empty) + `at` (a parseable ISO datetime) are REQUIRED; `jobId` (optional) links the entry to a KNOWN job of YOUR department, so the scheduler RUNS that job when `at` passes instead of only notifying your head. Entry: {id, label, at, jobId?, createdBy (your post id), createdAt, fired, departmentId}. Ad-hoc entries fire ONCE — no recurrence (a job\'s recurrence lives in its own `schedule`). Every post (head AND worker) of the department may add; the entry is owned by its creator.',
      parameters: {
        label: { type: 'string', required: true, description: 'The entry label (non-empty, e.g. "Review W4 batch").' },
        at: { type: 'string', required: true, description: 'The schedule time as a parseable ISO datetime (e.g. "2026-08-24T09:00:00.000Z").' },
        jobId: { type: 'string', description: 'Optional job id of YOUR department — when it passes, the scheduler runs the job.' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            label: { type: 'string', required: true },
            at: { type: 'string', required: true },
            jobId: { type: 'string' },
            createdBy: { type: 'string', required: true },
            createdAt: { type: 'number', required: true },
            fired: { type: 'boolean' },
            departmentId: { type: 'string' }
          }
        },
        render: (_args, value) => [{ type: 'text', text: `calendar added: "${value.label}" @ ${value.at} (id ${value.id}${value.departmentId !== void 0 ? `, ${value.departmentId}` : ''})` } as const]
      },
      async execute(args, exec): Promise<{ id: string; label: string; at: string; createdBy: string; createdAt: number; jobId?: string; fired?: boolean; departmentId?: string }> {
        const agent = exec.agent
        if (!agent) throw new Error('dept_calendar_add requires a calling agent (exec.agent was undefined)')
        const postId = postIdForChild(agent.id as string)
        if (postId === void 0) throw new Error('[deepartments] dept_calendar_add is for a department MEMBER (a registered head or worker), not the host')
        const label = String(args.label ?? '').trim()
        if (label === '') throw new Error('[deepartments] dept_calendar_add: `label` is required (non-empty)')
        const at = String(args.at ?? '').trim()
        if (at === '' || Number.isNaN(Date.parse(at))) throw new Error('[deepartments] dept_calendar_add: `at` must be a parseable ISO datetime')
        const callerEntry = byPost.get(postId)
        const department = callerEntry === void 0 ? undefined : departmentForEntry(callerEntry)
        const jobIdRaw = String(args.jobId ?? '').trim()
        if (jobIdRaw !== '') {
          if (department === void 0 || !(await departmentJobExists(department, jobIdRaw))) {
            throw new Error(`[deepartments] dept_calendar_add: jobId "${jobIdRaw}" is not a KNOWN job of your department — it must be a file <jobId>.md in the department jobDir`)
          }
        }
        const id = randomUUID()
        const entry: CalendarEntry = {
          id,
          label,
          at,
          createdBy: postId,
          createdAt: Date.now(),
          fired: false,
          ...(jobIdRaw !== '' ? { jobId: jobIdRaw } : {}),
          ...(department !== void 0 ? { departmentId: department.id } : {})
        }
        const state = readCalendar()
        state.entries.push(entry)
        await writeCalendarBestEffort(state)
        return { id, label, at, createdBy: postId, createdAt: entry.createdAt ?? Date.now(), fired: false, ...(jobIdRaw !== '' ? { jobId: jobIdRaw } : {}), ...(department !== void 0 ? { departmentId: department.id } : {}) }
      }
    })))

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_calendar_list',
      description: 'List the runtime calendar entries of the SHARED department agenda (spec 004 §5.7 — a single <stateDir>/calendar.json across every department; the agenda is unified/global). With NO filter it returns the FULL global agenda (every department\'s entries). Optionally filter an inclusive `from`/`to` window (ISO datetimes; entries with `at` in [from, to]) OR by `departmentId` (only entries of that department) — or both. Returns {count, entries}: each entry {id, label, at, jobId?, createdBy?, createdAt?, fired?, departmentId?}. Every post of the department may read the agenda.',
      parameters: {
        from: { type: 'string', description: 'Inclusive lower bound (ISO datetime); omit for open start.' },
        to: { type: 'string', description: 'Inclusive upper bound (ISO datetime); omit for open end.' },
        departmentId: { type: 'string', description: 'Optional: filter to entries stamped with ONE department id. Omit for the FULL shared (global) agenda. Entries without a departmentId are NOT matched by a filter.' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'number', required: true },
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  label: { type: 'string', required: true },
                  at: { type: 'string', required: true },
                  jobId: { type: 'string' },
                  createdBy: { type: 'string' },
                  createdAt: { type: 'number' },
                  fired: { type: 'boolean' },
                  departmentId: { type: 'string' }
                }
              }
            }
          }
        },
        render: (_args, value) => [{ type: 'text', text: `calendar (${value.count}):\n${value.entries.map((e) => `  - ${e.label} @ ${e.at}${e.departmentId !== void 0 ? ` [${e.departmentId}]` : ''}${e.jobId !== void 0 ? ` (job ${e.jobId})` : ''}${e.fired === true ? ' [fired]' : ''}`).join('\n')}` } as const]
      },
      async execute(args): Promise<{ count: number; entries: CalendarEntry[] }> {
        const state = readCalendar()
        const fromRaw = String(args.from ?? '').trim()
        const toRaw = String(args.to ?? '').trim()
        const departmentIdRaw = String(args.departmentId ?? '').trim()
        const departmentId = departmentIdRaw === '' ? undefined : departmentIdRaw
        const from = fromRaw === '' || Number.isNaN(Date.parse(fromRaw)) ? undefined : Date.parse(fromRaw)
        const to = toRaw === '' || Number.isNaN(Date.parse(toRaw)) ? undefined : Date.parse(toRaw)
        let entries = state.entries
        if (from !== undefined) entries = entries.filter((e) => Date.parse(e.at) >= from)
        if (to !== undefined) entries = entries.filter((e) => Date.parse(e.at) <= to)
        // B2 (spec W5): an optional department filter — only entries stamped with
        // that departmentId match; entries WITHOUT a departmentId are excluded by
        // a filter. Default (no filter) = the FULL shared (global) agenda.
        if (departmentId !== undefined) entries = entries.filter((e) => e.departmentId === departmentId)
        return { count: entries.length, entries }
      }
    })))

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_calendar_remove',
      description: 'Remove a runtime calendar entry of the SHARED department agenda by id (spec 004 §5.7 — the single <stateDir>/calendar.json). ACL: the entry CREATOR (its `createdBy`) OR the department HEAD may remove it; ANY other caller is DENIED (an entry is never deleted by a third member). Returns the removed entry; an unknown id is a loud error.',
      parameters: {
        id: { type: 'string', required: true, description: 'The entry id (from dept_calendar_add / dept_calendar_list).' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            label: { type: 'string', required: true },
            at: { type: 'string', required: true },
            jobId: { type: 'string' },
            createdBy: { type: 'string' },
            createdAt: { type: 'number' },
            fired: { type: 'boolean' },
            departmentId: { type: 'string' }
          }
        },
        render: (_args, value) => [{ type: 'text', text: `calendar removed: "${value.label}" @ ${value.at} (id ${value.id})` } as const]
      },
      async execute(args, exec): Promise<{ id: string; label: string; at: string; createdBy?: string; createdAt?: number; jobId?: string; fired?: boolean; departmentId?: string }> {
        const agent = exec.agent
        if (!agent) throw new Error('dept_calendar_remove requires a calling agent (exec.agent was undefined)')
        const postId = postIdForChild(agent.id as string)
        if (postId === void 0) throw new Error('[deepartments] dept_calendar_remove is for a department MEMBER (a registered head or worker), not the host')
        const id = String(args.id ?? '').trim()
        if (id === '') throw new Error('[deepartments] dept_calendar_remove: `id` is required')
        const state = readCalendar()
        const index = state.entries.findIndex((entry) => entry.id === id)
        if (index < 0) throw new Error(`[deepartments] dept_calendar_remove: no calendar entry with id "${id}"`)
        const entry = state.entries[index]
        // ACL: the creator OR the department head of the entry's department.
        const creatorEntry = byPost.get(entry.createdBy ?? '')
        const department = creatorEntry === void 0 ? undefined : departmentForEntry(creatorEntry)
        const isCreator = entry.createdBy === postId
        const isHead = department?.coordinator?.postId === postId
        if (!isCreator && !isHead) {
          throw new Error(`[deepartments] dept_calendar_remove: only the entry creator (${entry.createdBy ?? '(unknown)'}) or the department head may remove it — you are neither`)
        }
        state.entries.splice(index, 1)
        await writeCalendarBestEffort(state)
        return { id: entry.id, label: entry.label, at: entry.at, ...(entry.createdBy !== void 0 ? { createdBy: entry.createdBy } : {}), ...(entry.createdAt !== void 0 ? { createdAt: entry.createdAt } : {}), ...(entry.jobId !== void 0 ? { jobId: entry.jobId } : {}), ...(entry.fired !== void 0 ? { fired: entry.fired } : {}), ...(entry.departmentId !== void 0 ? { departmentId: entry.departmentId } : {}) }
      }
    })))

    // --- B2 (spec W5): dept_exec — the SCOPED shell tool for department posts.
    // Registered on the post's OWN layer (same place as dept_calendar_add), but
    // ONLY when the post's role allow-list declares `dept_exec` (postSetup
    // passes allowExec=true for a worker whose role template frontmatter `tools`
    // contains `dept_exec`). A post that does not declare it never sees the tool;
    // a config head (HEAD_BASE_TOOLS, no dept_exec) never registers it; the host
    // never gets it (this own-layer registration is descendants-only). The scope
    // guard runs BEFORE any execution — a denied command/cwd is a clean error
    // and the shell is never invoked.
    if (opts.allowExec === true) {
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_exec',
        description: 'Execute ONE shell command, scoped to your department (spec W5-B2). Runs `bash -lc <command>` with a sanitized env (PATH/HOME/LANG only) inside a scoped root. The command runs in your department workspace cwd by default; an explicit `cwd` must be inside a scoped root. Every command + cwd is guarded BEFORE execution: a denied token (reboot/sudo/…), a mutating `systemctl` form (only the read-only `systemctl is-active <unit>` is permitted), a reference to the protected stable profile (`/opt/dsh/.dsh`) or an absolute path outside a scoped root is DENIED (out of scope — escalate via the Asistente / owner approval). For an OWNER-AUTHORIZED mission, an explicit mission grant (`org.missionExecRoots`) may allow `/opt/dsh/.dsh`; otherwise escalate via the Asistente/owner (the Asistente-direct path is the alternative). For a department WORKER whose role template declares this tool; it is never exposed to the host or a config head. Prefer the native read/glob/grep tools for reading/searching FILES; use dept_exec only for zstd/git/shell tooling that the native tools cannot do. Output: {ok, exitCode, stdout, stderr} — a non-zero exit is ok:false, never a throw.',
        parameters: {
          command: { type: 'string', required: true, description: 'The shell command to run (non-empty). Guarded before execution.' },
          cwd: { type: 'string', description: 'Working directory; default = your department workspace cwd. Must be inside a scoped root.' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
              stdout: { type: 'string', required: true },
              stderr: { type: 'string', required: true }
            }
          },
          render: deptExecRender
        },
        async execute(args, exec): Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_exec requires a calling agent (exec.agent was undefined)')
          const postId = postIdForChild(agent.id as string)
          if (postId === void 0) throw new Error('[deepartments] dept_exec is for a department MEMBER (a registered head or worker), not the host')
          const command = String(args.command ?? '').trim()
          if (command === '') throw new Error('[deepartments] dept_exec: `command` is required (non-empty)')
          const callerEntry = byPost.get(postId)
          const department = callerEntry === void 0 ? undefined : departmentForEntry(callerEntry)
          const cwdRaw = String(args.cwd ?? '').trim()
          const deptCwd = await resolveDepartmentWorkspaceCwd(department)
          const defaultCwd = deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath()
          const cwd = cwdRaw !== '' ? cwdRaw : defaultCwd
          const allowedRoots = await deptExecAllowedRoots(department)
          const resolvedCwd = await realpath(cwd).catch(() => cwd)
          // The scope guard runs BEFORE any execution — a deny is a clean error.
          const deny = deptExecDenyReason(command, resolvedCwd, allowedRoots)
          if (deny !== void 0) throw new Error(`[deepartments] dept_exec: ${deny}`)
          return runDeptExec(command, resolvedCwd)
        }
      })))

      // --- E2 (QH 2026-08-28): dept_zstd_read — the READ-ONLY .zstd session
      // reader for department posts. Registered on the post's OWN layer in the
      // SAME `allowExec` gate as dept_exec (a role that declares `dept_exec`
      // also gets dept_zstd_read; a post that does not declare it never sees
      // either; the host / a config head never gets it). Decodes ONE
      // .zstd-compressed file via `zstd -dc` Node-side (child_process.spawn —
      // no user shell), SÓLO LECTURA, scoped to the SAME allowed roots as
      // dept_exec (a path outside the roots → DENIED before any decode), with
      // a BOUNDED + STREAMED output (fb-19: lines parsed on the fly — no
      // full-buffered decode, so a >4MB session streams fine; a 32 MB
      // decompressed budget aborts with a CLEAR error; a huge session never
      // hangs or buffers unbounded). Args {path, offset?, lines?}: offset =
      // the first line index (0-based) of the window, lines = the max lines to
      // return (default 100, cap 500).
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_zstd_read',
        description: 'Read a WINDOW of a .zstd-compressed file (e.g. a raw .jsonl.zstd session artifact) WITHOUT a shell: decodes the file via `zstd -dc` Node-side (child_process.spawn, no user shell), SÓLO LECTURA (never writes). Scoped to the SAME allowed roots as dept_exec (the resolved `path` must be inside a scoped root; the stable profile `/opt/dsh/.dsh` is protected unless a mission grant names it — a path outside the roots is DENIED before any decode). Args {path, offset?, lines?}: `offset` (default 0) is the 0-based first line of the window; `lines` (default 100, cap 500) is the max lines to return. Output is BOUNDED and STREAMED (fb-19): lines are parsed on the fly (no full-buffered decode), a 4000-char per-line cap + a 30 s decode timeout apply, and a session beyond the 32 MB decompressed budget is aborted with the CLEAR error «session exceeds the zstd-read budget — use dept_exec for full streaming» (never a raw maxBuffer exception). Returns {ok, lines, truncated, totalLines}: the decoded line window. For a department WORKER whose role template declares dept_exec (IPD builder/reviewer/explore-deep + quality-inspector); never exposed to the host or a config head.',
        parameters: {
          path: { type: 'string', required: true, description: 'The absolute path of the .zstd-compressed file to read (must resolve inside a scoped dept_exec root).' },
          offset: { type: 'number', description: 'The 0-based first line index of the window (default 0).' },
          lines: { type: 'number', description: 'The max lines to return (default 100, capped at 500).' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              lines: { type: 'array', required: true, items: { type: 'string' } },
              truncated: { type: 'boolean', required: true },
              totalLines: { type: 'number', required: true },
              error: { type: 'string' }
            }
          },
          render: (_args, value) => {
            if (value.ok === false) return [{ type: 'text', text: `dept_zstd_read failed: ${value.error ?? 'unknown error'}` } as const]
            const cap = 8000
            const joined = value.lines.join('\n')
            const body = joined.length > cap ? `${joined.slice(0, cap)}\n… [truncated ${joined.length} chars]` : joined
            return [{ type: 'text', text: `dept_zstd_read: ${value.lines.length} of ${value.totalLines} line(s)${value.truncated ? ' (window truncated)' : ''}\n\`\`\`\n${body}\n\`\`\`` } as const]
          }
        },
        async execute(args, exec): Promise<{ ok: boolean; lines: string[]; truncated: boolean; totalLines: number; error?: string }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_zstd_read requires a calling agent (exec.agent was undefined)')
          const postId = postIdForChild(agent.id as string)
          if (postId === void 0) throw new Error('[deepartments] dept_zstd_read is for a department MEMBER (a registered head or worker), not the host')
          const pathRaw = String(args.path ?? '').trim()
          if (pathRaw === '') throw new Error('[deepartments] dept_zstd_read: `path` is required')
          const offsetRaw = Number(args.offset ?? 0)
          const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.trunc(offsetRaw) : 0
          const linesRaw = Number(args.lines ?? 100)
          const lines = Math.min(Math.max(Number.isFinite(linesRaw) && linesRaw > 0 ? Math.trunc(linesRaw) : 100, 1), DEPT_ZSTD_READ_MAX_LINES)
          const callerEntry = byPost.get(postId)
          const department = callerEntry === void 0 ? undefined : departmentForEntry(callerEntry)
          const allowedRoots = await deptExecAllowedRoots(department)
          // The scope guard runs BEFORE any decode — a denied path is a clean
          // error and zstd is never invoked (realpath collapses `..`/symlinks
          // FIRST, exactly like dept_exec's canonicalization).
          const resolvedPath = await realpath(pathRaw).catch(() => pathRaw)
          const deny = deptZstdReadDenyReason(resolvedPath, allowedRoots)
          if (deny !== void 0) throw new Error(`[deepartments] dept_zstd_read: ${deny}`)
          return runDeptZstdRead(resolvedPath, offset, lines)
        }
      })))
    }


    disposers.push(agentCtx.tools.register(memoWriteTool(false)))

    // LOTE A (owner decision 2026-08-27 — head/worker sleep RETIRED): the
    // post own-layer dept_sleep is deliberately NOT registered here. Heads and
    // workers stay `idle|running`; only the HOST plane keeps dept_sleep
    // (spec 002 rotation). The unregistered `sleepMember`/`sleepAll` remain in
    // lifecycle.ts as dead code (R6 — never remove; a post entry carrying a
    // legacy `sleepEpoch` on disk still resurrects fresh on wake).
    // (sleepTool(false) removed — head/worker sleep is hosts-only.)

    // --- Batch 3a: department-lifecycle tools — HEAD (manager) only ------
    // A department HEAD creates and retires DISPOSABLE WORKERS. These register
    // ONLY here, in the head own-layer, so a worker (manager:false) and a HOST
    // (global plane) never see them — the "host-CANNOT" invariant is
    // structural (tool simply absent). B3 cutover: no room parameter — the
    // workers live in the agent CATALOG (posts.json); the first message is
    // delivered via the BUS (messages.jsonl + deliverBusRecord), not the board.
    if (manager) {
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_post_create',
        description: 'Create a DISPOSABLE department worker: spawn a fresh root agent (sessionId worker-<postId>-<uuid> — a UNIQUE session, never reused across a retired-and-respawned same-role worker), register it in posts.json as a disposable entry (provider:"worker"; F1: YOU are recorded as its manager — managerId — and your config department as its departmentId), and deliver its first message via the messaging bus. The worker works your assigned task and sleeps when done; you retire it later with dept_post_retire. The first message (firstMessage, or prompt) is persisted as a durable bus message addressed to the worker (the `deepartments/post-created` signal). DEPRECATED — use dept_worker_spawn (persona+tools+task) instead; kept registered for legacy compatibility (R6).',
        parameters: {
          postId: { type: 'string', required: true, description: 'Short slug for the worker, e.g. "researcher-alpha" (unique; not already registered).' },
          role: { type: 'string', required: true, description: 'The worker role, e.g. "rank-and-file researcher".' },
          prompt: { type: 'string', description: 'Initial assignment to the worker (alias of firstMessage).' },
          firstMessage: { type: 'string', description: 'The worker\'s initial assignment, delivered as a durable bus message addressed to it.' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              postId: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              activeMembers: activeMembersSchema
            }
          },
          render: (_args, value) => [{ type: 'text', text: `created worker ${value.postId} (session ${value.sessionId}; ${renderActiveRoster(value.activeMembers)})` } as const]
        },
        async execute(args, exec): Promise<{ postId: string; sessionId: string; activeMembers: Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }> }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_post_create requires a calling agent (exec.agent was undefined)')
          if (agents === void 0) throw new Error('[deepartments] dept_post_create requires the agents service')
          const headId = postIdForChild(agent.id as string)
          if (headId === void 0) throw new Error('[deepartments] dept_post_create is for a department HEAD (registered post), not the host')
          const headEntry = byPost.get(headId)
          if (headEntry === void 0) throw new Error(`[deepartments] dept_post_create: head "${headId}" is not registered`)
          // postId must be unique — reject an already-registered post AND a
          // configured head (a worker must never shadow a head's identity).
          if (byPost.has(args.postId)) throw new Error(`[deepartments] dept_post_create: postId "${args.postId}" is already registered`)
          if (coordinatorForPost(args.postId) !== void 0) throw new Error(`[deepartments] dept_post_create: postId "${args.postId}" is a configured department head, not a worker`)
          const sessionId = mintWorkerSessionId(args.postId)
          if (agents.get(String(SessionId(sessionId))) !== void 0) throw new Error(`[deepartments] dept_post_create: a live agent already exists for session "${sessionId}"`)
          const firstMessage = args.firstMessage ?? args.prompt
          // F10 (spec 004 §9.1): the legacy dept_post_create emits a department
          // worker with NO role template (no persona/tools) — it still gets the
          // department-aware setup (architecture section), and NO role tools
          // (pre-F10 behavior: board-only, `allow: []`).
          const department = departmentForPost(headId)
          const setup = workerSetup(args.postId, headEntry.roomId, args.role, { department })
          // F5 (spec 004 §6.2 L1): the worker of a department WITH a configured
          // workspacePath is created under that path (its OWN sidebar folder,
          // ensured first); otherwise the shared workspace root (the
          // resolveDepartmentWorkspaceCwd '' fallback — pre-F1 behavior).
          const deptCwd = await resolveDepartmentWorkspaceCwd(department)
          // fb-9: the legacy dept_post_create path shares the SAME DISPATCH
          // pre-flight as the two spawn engines — a reasoning-enabled provider
          // without compat.requiresReasoningContentOnAssistantMessages=true
          // rejects
          // HERE, BEFORE any agents.create (never a mid-mission 400; nothing
          // is registered).
          const preflightError = workerReasoningContentPreflightError()
          if (preflightError !== undefined) throw new Error(`[deepartments] ${preflightError}`)
          // DISPATCH-HARDENING (QH «429-primer-call»): the pooler-capacity
          // pre-check on the LEGACY seam too — the SAME early rejection, BEFORE
          // any agents.create (nothing is registered); an at-quota pool never
          // spawns a worker whose first call would 429/503.
          const poolerDispatchBlock = workerPoolerDispatchBlockError()
          if (poolerDispatchBlock !== undefined) throw new Error(`[deepartments] ${poolerDispatchBlock}`)
          const handle = await agents.create({
            sessionId: String(SessionId(sessionId)),
            meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: WORKER_PRESET_ID },
            agentOptions: WORKER_AGENT_OPTIONS,
            setup
          })
          // F1 (spec 004 §4.1/§4.2): RECORD THE CREATOR. The pre-F1 code copied
          // only the head's INERT roomId; the department link now lives in
          // `departmentId` (the config department of the creating head — the
          // worker is, structurally, a worker of THAT department) and the
          // creating head itself in `managerId` ("my workers" scope). roomId
          // stays as the inert legacy field (schema stability, spec §4.1
          // "unchanged"); a HEAD WITHOUT a config department gets no
          // departmentId (legacy-path compatibility — its workers are
          // department-less, host-retireable only).
          registerEntry({
            postId: args.postId,
            sessionId: String(SessionId(sessionId)),
            roomId: headEntry.roomId,
            agentPreset: WORKER_PRESET_ID,
            provider: 'worker',
            role: args.role,
            managerId: headId,
            ...(department !== void 0 ? { departmentId: department.id } : {})
          })
          byHeadHandle.set(String(SessionId(sessionId)), handle)
          // F3 pin (owner decision 2026-08-23): the legacy create path deploys a
          // worker too, so it pins the SAME "Rol: Misión" default sidebar title
          // (there is no title/firstMessage override — the role + the first
          // message are the mission source). Non-fatal: a failed pin only logs.
          const titleSession = ctx.sessions.get(SessionId(sessionId))
          if (titleSession !== void 0) {
            const title = defaultWorkerTitle(args.role, firstMessage, void 0, args.postId)
            const titlePin = pinSessionTitle(titleSession, title)
            if (titlePin === 'pinned') {
              ctx.logger.info(`[deepartments] dept_post_create: pinned worker session title "${title}" (${sessionId})`)
            } else if (titlePin === 'failed') {
              ctx.logger.warn(`[deepartments] dept_post_create: worker session title pin failed for ${sessionId} (non-fatal — worker registration continues)`)
            }
          }
          // Deliver the initial assignment (or a creation note) as a DURABLE
          // BUS message from the head addressed to the worker — this IS the
          // `deepartments/post-created` signal; the bus delivery wakes the
          // worker (always-wake, D4). No direct followup needed; the store is
          // durable.
          const text = firstMessage ?? `[created] worker "${args.postId}" (${args.role || 'department worker'}) is registered. You are disposable — work your assigned task, then dept_memo_write and report to your head; your head retires you when done.`
          const store = await messagesStoreReady
          const record = await store.append({
            from: headId,
            to: [args.postId],
            text,
            kind: 'agent'
          })
          await deliverBusRecord(record, args.postId, agent.id as string, agent.id as string, exec.signal)
          return { postId: args.postId, sessionId: String(SessionId(sessionId)), activeMembers: activeCatalogMembers() }
        }
      })))

      disposers.push(agentCtx.tools.register(postRetireTool))

      // --- F4 (spec 004 §5.4-§5.5, D7): JOB tools — dept_job_list /
      // dept_job_run (registered ONLY here, in the head own-layer: the RH
      // executes its department's VERSIONED jobs manually; the host plane
      // never sees them — D2 structural, dept_worker_spawn parity; a worker
      // (manager:false) never sees them either). The department is DERIVED
      // from the caller (a head can only list/run the jobs of ITS OWN
      // department — the jobDir is resolved from the caller's config
      // department, spec §5.4 "own department only" by construction). Job
      // definitions are plain repo files: `docs/departments/<dept-id>/jobs/
      // <slug>.md` (see docs/departments/research/README.md — the F4a job
      // files), read from the repo — the SAME repo tree the F3 role
      // templates come from (`repoRoot`, the plugin's bundle dir floor).
      // W1 — the scheduler IS real: `schedule` is a job's cadence (a 5-field
      // cron auto-fires via the scheduler daemon; a non-cron human schedule is
      // displayed but never triggers). A manual dept_job_run still works.
      // ---------------------------------------------------------------------
      // The job reader (parseJobDefFrontmatter / jobDirFor / readJobDefinitionFile
      // — module-level, shared with the agenda/dispatch + scheduler) and the job
      // idempotency/role guards (validateJobRole / runningJobWorker — apply-scope,
      // shared with the scheduler's runJobForDepartment) are hoisted: this head
      // own-layer uses the SAME readers as the REST of the plugin, so list/run
      // and the agenda never drift. `schedule` is parsed + displayed (and the
      // scheduler below now also fires cron-style schedules) — it is no longer
      // purely informational. -----------------------------------------------
      /** One listed job (spec 004 §5.5): the frontmatter fields, the
       * resolved repo path, `status: "manual-run"` (the field is a holdover —
       * a cron-scheduled job auto-fires regardless; see the scheduler daemon)
       * and an `error` carrying the reason when the definition's frontmatter
       * is invalid (per-entry — the list never fails as a whole). */
      interface JobListItem {
        id: string
        path: string
        status?: 'manual-run'
        title?: string
        role?: string
        description?: string
        schedule?: string
        owner?: string
        outbox?: string
        error?: string
      }

      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_job_list',
        description: 'List the versioned JOB definitions of YOUR department (spec 004 §5.5): scan the department jobDir (config org.departments[].jobDir — repo-relative or absolute; default <repoRoot>/docs/departments/<your-department-id>/jobs) and parse each *.md definition frontmatter (id/title/role/description/schedule?/owner/outbox?). Returns the resolved jobDir + the list {id, title, role, description, schedule, status:"manual-run", owner, path} per job; a definition with INVALID frontmatter is reported PER-ENTRY with an error (the whole list is never failed). `schedule` is the job cadence (W1): a 5-field cron (e.g. `0 9 * * *`) AUTO-FIRES via the plugin scheduler daemon; a non-cron (human) schedule never auto-fires — that job runs MANUALLY via dept_job_run. Registered ONLY in the head own-layer.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              jobDir: { type: 'string', required: true },
              jobs: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    path: { type: 'string', required: true },
                    status: { type: 'string' },
                    title: { type: 'string' },
                    role: { type: 'string' },
                    description: { type: 'string' },
                    schedule: { type: 'string' },
                    owner: { type: 'string' },
                    outbox: { type: 'string' },
                    error: { type: 'string' }
                  }
                }
              }
            }
          },
          render: (_args, value) => {
            const lines = value.jobs.map((job) => {
              if (job.error !== void 0) return `  - ${job.id} (${job.path}) — ERROR: ${job.error}`
              const meta = [job.status, job.role].filter(Boolean).join(', ')
              return `  - ${job.id} — "${job.title}" (${meta}) [${job.path}]`
            })
            return [{ type: 'text', text: `jobs (${value.jobs.length}) in ${value.jobDir}:\n${lines.join('\n')}` } as const]
          }
        },
        async execute(_args, exec): Promise<{ jobDir: string; jobs: JobListItem[] }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_job_list requires a calling agent (exec.agent was undefined)')
          const headId = postIdForChild(agent.id as string)
          if (headId === void 0) throw new Error('[deepartments] dept_job_list is for a department HEAD (registered post), not the host')
          const headEntry = byPost.get(headId)
          if (headEntry === void 0) throw new Error(`[deepartments] dept_job_list: head "${headId}" is not registered`)
          // A head WITHOUT a config department cannot list jobs (the jobDir is
          // resolved from ITS department — spec §5.4 own-department-only).
          const department = departmentForPost(headId)
          if (department === void 0) throw new Error(`[deepartments] dept_job_list: head "${headId}" has no CONFIGURED department — the job directory cannot be resolved`)
          const jobDir = jobDirFor(repoRoot, department)
          let files: string[]
          try {
            files = (await readdir(jobDir)).filter((name) => name.endsWith('.md')).sort()
          } catch (error: unknown) {
            // No jobs declared yet (missing default dir) → an EMPTY list, not
            // an error; any other failure (permissions, misconfig) is loud.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { jobDir, jobs: [] }
            throw error
          }
          const jobs: JobListItem[] = []
          for (const name of files) {
            const filePath = path.join(jobDir, name)
            let parsed: { meta: Record<string, string>; body: string } | undefined
            try {
              parsed = parseJobDefFrontmatter(await readFile(filePath, 'utf8'))
            } catch {
              parsed = void 0
            }
            if (parsed === void 0) {
              // Per-entry error: an invalid definition is REPORTED, the list
              // as a whole still returns (spec §5.5 list robustness).
              jobs.push({
                id: name.replace(/\.md$/, ''),
                path: filePath,
                error: 'invalid frontmatter (expected a `---` block with id/title/role/description/owner plus a non-empty body)'
              })
              continue
            }
            jobs.push({
              id: parsed.meta.id,
              title: parsed.meta.title,
              role: parsed.meta.role,
              description: parsed.meta.description,
              status: 'manual-run',
              owner: parsed.meta.owner,
              path: filePath,
              // JSON-lossless tool result: `schedule`/`outbox` are OPTIONAL
              // frontmatter keys — a definition that omits them must NOT emit a
              // property whose value is `undefined` (lossless-json rejects it).
              // Omit the key entirely when absent (the schema admits it).
              ...(parsed.meta.schedule !== undefined ? { schedule: parsed.meta.schedule } : {}),
              ...(parsed.meta.outbox !== undefined ? { outbox: parsed.meta.outbox } : {})
            })
          }
          return { jobDir, jobs }
        }
      })))

      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_job_run',
        description: 'Execute ONE versioned JOB of YOUR department (spec 004 §5.4 — manual execution; the W1 scheduler daemon uses the SAME engine for cron auto-fires): read the job definition <jobId>.md in the department jobDir (config org.departments[].jobDir; default <repoRoot>/docs/departments/<your-department-id>/jobs), validate its role against presets/departments/<your-department>/<role>.md, and materialize a WORKER exactly like dept_worker_spawn with role = the definition role, task = the JOB BODY (the full concrete assignment), jobId recorded, slug = the job id (deduped -2, -3… including retired), title = the HUMAN frontmatter title. Returns the worker id + session id + title + job id + the definition path. IDEMPOTENCY: a job already running (a LIVE, non-retired job worker of your department with that jobId) is NOT duplicated — it errors `job already running: <workerId>` (retire it explicitly with dept_worker_retire to restart). Missing job / broken frontmatter / unknown role → loud error (a versioned definition with a syntax error must fail the run, never spawn a task-less worker). `schedule` does NOT gate this run: a manual dept_job_run executes the job regardless of its `schedule`, and a cron-scheduled job auto-fires via the scheduler daemon. Registered ONLY in the head own-layer.',
        parameters: {
          jobId: { type: 'string', required: true, description: 'The job definition id (the file <jobId>.md in the department jobDir — e.g. "monitor-dsh-updates").' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workerId: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              title: { type: 'string', required: true },
              jobId: { type: 'string', required: true },
              role: { type: 'string', required: true },
              jobPath: { type: 'string', required: true }
            }
          },
          render: (_args, value) => [{ type: 'text', text: `ran job ${value.jobId}: worker ${value.workerId} (session ${value.sessionId}, role ${value.role}, title "${value.title}") — definition ${value.jobPath}` } as const]
        },
        async execute(args, exec): Promise<{ workerId: string; sessionId: string; title: string; jobId: string; role: string; jobPath: string }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_job_run requires a calling agent (exec.agent was undefined)')
          const headId = postIdForChild(agent.id as string)
          if (headId === void 0) throw new Error('[deepartments] dept_job_run is for a department HEAD (registered post), not the host')
          const headEntry = byPost.get(headId)
          if (headEntry === void 0) throw new Error(`[deepartments] dept_job_run: head "${headId}" is not registered`)
          const department = departmentForPost(headId)
          if (department === void 0) throw new Error(`[deepartments] dept_job_run: head "${headId}" has no CONFIGURED department — the job directory cannot be resolved`)
          const jobId = String(args.jobId ?? '').trim()
          if (jobId === '') throw new Error('[deepartments] dept_job_run: `jobId` is required')
          // The SHARED job-run engine — the SAME path the W1 scheduler uses for
          // an automatic fire (no drift between manual and auto execution).
          return runJobForDepartment(department, headEntry, jobId, { callerSessionId: agent.id as string, signal: exec.signal })
        }
      })))

      // --- F3 (spec 004 §5.2): dept_worker_spawn — the department-scoped
      // worker deployment tool (registered ONLY here, in the head own-layer:
      // D2 — the Asistente NEVER mints research workers; structural like
      // dept_post_create). The department is DERIVED from the caller (a head
      // can only deploy into its OWN department — spec §5.2 validation, the
      // cross-department spawn surface is absent by construction). -----------
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_worker_spawn',
        description: 'Spawn a WORKER of YOUR department (spec 004 §5.2): resolve the role template presets/departments/<your-department>/<role>.md (its persona + display title), materialize a fresh root agent worker (sessionId worker-<slug>-<uuid> — a UNIQUE session, its own session row; the worker NEVER collides with an archived session after a retire-and-respawn of the same role), register it in posts.json with provider:"worker", role, YOUR postId as managerId, your config department as departmentId and the jobId (when given), inject the role persona + your task into its system prompt, pin its sidebar title (title? overrides the default "<RoleDisplay>: <mission>"), and deliver the task as its first durable bus message (which wakes it). Worker slugs DEDUP with -2, -3… — a registered (even retired) slug is never reused. Returns the worker post id + session id + the pinned title. Registered ONLY in the head own-layer.',
        parameters: {
          role: { type: 'string', required: true, description: 'The role template name, e.g. "researcher" — must be a file presets/departments/<your-department>/<role>.md.' },
          task: { type: 'string', description: 'The one-off assignment: injected into the worker persona AND delivered as its first bus message.' },
          jobId: { type: 'string', description: 'Set when the worker runs a versioned job (F4); becomes the slug base and is recorded on the entry.' },
          title: { type: 'string', description: 'Sidebar row title (overrides the default "<RoleDisplay>: <mission>" — the role capitalized + the first line of the task, cut to ~70 chars).' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workerId: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              title: { type: 'string', required: true },
              activeMembers: activeMembersSchema
            }
          },
          render: (_args, value) => [{ type: 'text', text: `spawned worker ${value.workerId} (session ${value.sessionId}, title "${value.title}"; ${renderActiveRoster(value.activeMembers)})` } as const]
        },
        async execute(args, exec): Promise<{ workerId: string; sessionId: string; title: string; activeMembers: Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }> }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_worker_spawn requires a calling agent (exec.agent was undefined)')
          if (agents === void 0) throw new Error('[deepartments] dept_worker_spawn requires the agents service')
          const headId = postIdForChild(agent.id as string)
          if (headId === void 0) throw new Error('[deepartments] dept_worker_spawn is for a department HEAD (registered post), not the host')
          const headEntry = byPost.get(headId)
          if (headEntry === void 0) throw new Error(`[deepartments] dept_worker_spawn: head "${headId}" is not registered`)
          // A head WITHOUT a config department cannot spawn: the role template
          // tree (presets/departments/<dept-id>/) is keyed by the department.
          const department = departmentForPost(headId)
          if (department === void 0) throw new Error(`[deepartments] dept_worker_spawn: head "${headId}" has no CONFIGURED department — the role template tree (presets/departments/<department-id>/) cannot be resolved`)
          const role = String(args.role ?? '').trim()
          if (role === '') throw new Error('[deepartments] dept_worker_spawn: `role` is required (a role template name, e.g. "researcher")')
          // The SHARED worker-spawn engine — the EXACT path dept_job_run uses and
          // the parallel-monitor daemon uses for its researcher workers, so there
          // is no tool-vs-scheduler-vs-daemon drift on registration/pin/delivery.
          const result = await spawnWorkerForDepartment(department, headEntry, {
            role,
            task: args.task,
            ...(args.jobId !== void 0 ? { jobId: String(args.jobId) } : {}),
            ...(args.title !== void 0 ? { title: String(args.title) } : {}),
            callerAgentId: agent.id as string,
            senderSessionId: agent.id as string,
            signal: exec.signal
          })
          return { ...result, activeMembers: activeCatalogMembers() }
        }
      })))

      // --- F3 (spec 004 §5.3): dept_worker_retire — the department-scoped
      // retire tool: ONLY MY workers (managerId match or own config department
      // — the F1 retirePost scope) + mark (entry kept, retired:true) + archive
      // the durable session (the sidebar row disappears, D5). Idempotent; the
      // registry entry and message history are NEVER erased (D5). -----------
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_worker_retire',
        description: 'Retire ONE of YOUR department\'s workers (spec 004 §5.3): marks it retired (the posts.json entry STAYS with retired:true — the live catalog stops addressing it, dept_who still lists it with retired:true), disposes its live handle, AND archives its durable session (non-fatal — the sidebar row disappears, D5). Scope: only the workers YOU created (managerId) or a worker of YOUR config department — another head\'s/department\'s worker is rejected loudly; a permanent department head is never retired here; unknown workerIds reject. Idempotent: a second retire of the same worker succeeds as a no-op. The registry entry and the message history are NEVER erased (D5: keep the logs).',
        parameters: {
          workerId: { type: 'string', required: true, description: 'The worker post id to retire (e.g. "researcher-alpha" — the id dept_who lists).' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workerId: { type: 'string', required: true },
              retired: { type: 'boolean', required: true },
              archived: { type: 'boolean', required: true },
              activeMembers: activeMembersSchema
            }
          },
          render: (_args, value) => [{ type: 'text', text: `retired worker ${value.workerId} (${value.archived ? 'session archived' : 'session archive skipped (non-fatal)'}; ${renderActiveRoster(value.activeMembers)})` } as const]
        },
        async execute(args, exec): Promise<{ workerId: string; retired: boolean; archived: boolean; activeMembers: Array<{ agentId: string; kind: 'head' | 'worker' | 'host'; title: string; state: DeptWhoState }> }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_worker_retire requires a calling agent (exec.agent was undefined)')
          const workerId = String(args.workerId ?? '').trim()
          if (workerId === '') throw new Error('[deepartments] dept_worker_retire: `workerId` is required')
          const entry = byPost.get(workerId)
          if (entry === void 0) throw new Error(`[deepartments] dept_worker_retire: "${workerId}" is not a registered post`)
          if (entry.provider !== 'worker') throw new Error(`[deepartments] dept_worker_retire: "${workerId}" is not a disposable worker — a head may only retire workers, never a permanent head`)
          // Scope (manager/department match — "only MY workers") + mark + dispose
          // are the F1 shared path (retirePost); idempotent on an already-retired
          // worker (no-op success). The worker-retire QD dice lives INSIDE
          // retirePost (LOTE B, 2026-08-27) — the ONE shared retire seam covering
          // every real retire path — so this tool carries NO dice/emit of its own
          // (a re-retire no-op naturally never re-emits: retirePost's idempotent
          // early return happens before its dice).
          await retirePost(workerId, agent.id as string)
          // F3 (spec §5.3): archive the DURABLE session so the sidebar row
          // disappears — non-fatal (a failed archive only warns; the retire
          // mark is the durable part). Runs on every retire INCLUDING the
          // already-retired no-op: archiveSession is idempotent (retirePost's
          // dice-side archive — LOTE B — is a harmless double).
          const archived = await archiveWorkerSession(entry.sessionId)
          return { workerId, retired: true, archived, activeMembers: activeCatalogMembers() }
        }
      })))

      // --- W3b (spec W3 monitor → researcher): dept_monitor_list — the runtime
      // PARALLEL monitor state (read-only). Registered ONLY in the head own-layer
      // (the Asistente orchestrates/reads via tooling but never polls monitors
      // itself). Reads the SAME <stateDir>/parallel-monitors-state.json the
      // poller daemon writes. ------------------------------------------------
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_monitor_list',
        description: 'List the runtime PARALLEL monitor state (W3b): for each configured monitor (parallel.monitors, or the 2 code defaults), the Parallel monitor_id, the query, the last fire + last poll timestamps, the last cursor and the last event count. Read-only — the daemon, not a head, creates/polls the monitors. Registered ONLY in the head own-layer.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              monitors: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    query: { type: 'string', required: true },
                    monitorId: { type: 'string' },
                    lastFiredAt: { type: 'number' },
                    lastPolledAt: { type: 'number' },
                    cursor: { type: 'string' },
                    lastEventCount: { type: 'number' }
                  }
                }
              }
            }
          },
          render: (_args, value) => [{ type: 'text', text: `${(value.monitors ?? []).length} parallel monitor(s): ${(value.monitors ?? []).map((m) => `${m.id}${m.monitorId !== undefined ? ` (${m.monitorId})` : ''}`).join(', ')}` } as const]
        },
        async execute(): Promise<{ monitors: Array<{ id: string; query: string; monitorId?: string; lastFiredAt?: number; lastPolledAt?: number; cursor?: string; lastEventCount?: number }> }> {
          const monitors = resolveParallelMonitorConfig((config as unknown as { parallel?: ParallelConfig }).parallel)
          const state = readParallelMonitorsState(stateDir)
          return {
            monitors: monitors.map((m) => {
              const s = state.monitors[m.id]
              return {
                id: m.id,
                query: m.query,
                ...(s?.monitorId !== undefined ? { monitorId: s.monitorId } : {}),
                ...(s?.lastFiredAt !== undefined ? { lastFiredAt: s.lastFiredAt } : {}),
                ...(s?.lastPolledAt !== undefined ? { lastPolledAt: s.lastPolledAt } : {}),
                ...(s?.cursor !== undefined ? { cursor: s.cursor } : {}),
                ...(s?.lastEventCount !== undefined ? { lastEventCount: s.lastEventCount } : {})
              }
            })
          }
        }
      })))
      // M2.3: the head's personal SECRETARY registered on the OWN layer —
      // HERE, in installHeadBoardTools, which postSetup runs AFTER the restrict
      // (order: mount → probe → restrict → own-layer), so the registration is
      // IMMUNE to the standing mask (the M2.2 live anomaly: with M2.1+M2.2 and
      // the row PRESENT, the inherited derivation still failed to surface the
      // tool in the QH session — the own-layer registration makes the head's
      // visibility unconditional). Manager-gated: a WORKER never carries the
      // secretary (its own layer registers only the bus/lifecycle tools).
      // The body is the SHARED factory (src/subagent.ts `createSecretaryTool` —
      // the SAME body the preset row's `apply()` registers), so the host
      // standing row and the head own layer share ONE definition of
      // person/toolFilter/wording. Idempotent across materializations: every
      // create/COLD-resume has a FRESH agentCtx, the registration sits in this
      // agent's OWN layer (the standing row binds the STANDING ctx — another
      // layer, no same-layer duplicate), and the ctx.effect disposer in
      // postSetup unwinds it with the agent. The execute is the M2.2 lazy path
      // (ctx.get('subagents') at call time → the clear absent-service error in
      // a head chain).
      disposers.push(agentCtx.tools.register(createSecretaryTool(agentCtx, secretaryConfig())))
    }

    return { dispose: () => { for (const d of disposers) d() } }
  }

  /** The role of a post as a prompt section (persona = role, NOT a mission —
   * missions arrive as addressed messages on the bus). Registered on the post's
   * own systemPrompt layer when that service is composed. `isWorker` switches
   * the framing between a PERMANENT department head (manager) and a TEMPORARY
   * DISPOSABLE worker. Both are BOOT-QUIET (never act unaddressed). B3
   * cutover: rooms wording removed — the post lives in the agent catalog. */
  /** Length cap for a department-architecture prompt section (spec 004 §9.1):
   * over this the section is the START plus a reference to the full file. */
  const ARCHITECTURE_SECTION_MAX = 3500

  /** F10/role-persona template substitution (spec 004 §9.1 + the owner's
   * role-persona templating): replace the DEPARTMENT template variables —
   * `{{deptName}}`, `{{headPostId}}`, `{{workspacePath}}`,
   * `{{reportDir}}` (= <workspacePath>/reports) — in a prompt-section body
   * with the department's real values. Shared by the architecture section
   * (buildArchitectureSection) and the role persona (installRoleSection) so a
   * role template body can use the same variables and NEVER leaks a raw
   * uppercase `{{...}}` into the harness prompt expander (which only accepts
   * lowercase `[a-z][a-z0-9_]*` variable names). A missing workspacePath
   * empties `{{workspacePath}}`/`{{reportDir}}`; `{{cwd}}` (a legitimate
   * lowercase harness preset variable) is NEVER touched — this map only knows
   * the 4 department variables, so any other `{{...}}` passes through
   * untouched. */
  const renderDepartmentTemplate = (text: string, department: DepartmentConfig): string => {
    const workspacePath = department.workspacePath ?? ''
    const reportDir = workspacePath !== '' ? path.join(workspacePath, 'reports') : ''
    const headPostId = department.coordinator?.postId ?? ''
    return text
      .replace(/\{\{deptName\}\}/g, department.name)
      .replace(/\{\{headPostId\}\}/g, headPostId)
      .replace(/\{\{workspacePath\}\}/g, workspacePath)
      .replace(/\{\{reportDir\}\}/g, reportDir)
  }

  /** Read + template the department's ARCHITECTURE.md into a prompt section
   * body (undefined = omit the section cleanly). A department without an
   * ARCHITECTURE.md injects nothing and NEVER errors. Templating replaces
   * {{deptName}}, {{headPostId}}, {{workspacePath}}, {{reportDir}} with the
   * department's real values via renderDepartmentTemplate. Content >~3500
   * chars is truncated to its START plus a pointer to the full file.
   * SYNC (readFileSync): installRoleSection/postSetup must stay synchronous
   * (a root agent's systemPrompt sections are composed at materialization,
   * before the agent can be awaited — there is no await seam). */
  const buildArchitectureSection = (department: DepartmentConfig): string | undefined => {
    const archPath = path.join(repoRoot, 'presets', 'departments', department.id, 'ARCHITECTURE.md')
    let raw: string
    try {
      raw = readFileSync(archPath, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return void 0
      ctx.logger.warn(`[deepartments] architecture section for "${department.id}" could not be read (${error instanceof Error ? error.message : String(error)}) — section omitted`)
      return void 0
    }
    const rendered = renderDepartmentTemplate(raw, department).trim()
    if (rendered === '') return void 0
    if (rendered.length > ARCHITECTURE_SECTION_MAX) {
      return `## Department architecture\n\n${rendered.slice(0, ARCHITECTURE_SECTION_MAX)}\n\n… (truncated — full text at ${archPath})`
    }
    return `## Department architecture\n\n${rendered}`
  }

  const installRoleSection = (agentCtx: Context, role: string, postId: string, isWorker: boolean, extra?: { persona?: string; taskText?: string }, department?: DepartmentConfig): void => {
    const sp = agentCtx.get('systemPrompt')
    if (sp === void 0 || typeof (sp as { section?: unknown }).section !== 'function') return
    sp.section({
      name: `deepartments:${isWorker ? 'worker' : 'head'}:role:${postId}`,
      order: 1,
      text: isWorker
        ? `You are "${postId}", a ${role || 'rank-and-file researcher'} DISPOSABLE department worker of Deepartments (DeepSeek Harness). Your department HEAD created you as a temporary worker agent; you do not edit the repository, run builders, or spawn other agents. Read your messages with agent_messages, send with send_message, orient with dept_who, and persist your findings/memory with dept_memo_write. BOOT-QUIET: you never act on your own — on any materialization/resume/boot wake you stay idle and end your turn with NO action until an explicitly addressed message arrives. Work the task your department head assigns you; when you are DONE, write dept_memo_write to save your results, then report to your head and end your turn (head/worker sleep is retired — you never dept_sleep; only the Asistente/host rotates its own session, spec 002). You are DISPOSABLE: your head retires you with dept_worker_retire when you are finished.`
        : `You are "${postId}", the ${role || 'department head'}. You are a permanent, first-class agent: you do not edit the repository, run builders, or spawn other agents. Your world is the messaging bus — read with agent_messages, send with send_message, orient with dept_who, and persist memory with dept_memo_write. You are permanent: you stay idle|running (head sleep is retired — only the Asistente/host keeps dept_sleep session rotation, spec 002). You may create and retire DISPOSABLE WORKERS of your department with dept_worker_spawn and dept_worker_retire (the department-scoped worker tools — the legacy dept_post_create/dept_post_retire still exist as the raw machinery). BOOT-QUIET: you never act on your own — on any materialization/resume/boot wake you stay idle and end your turn with NO action until an explicitly addressed message arrives; you never proactively send.`
    })
    // F3 (spec §7.4): the ROLE PERSONA — the role template's body (+ the task)
    // as a second section when dept_worker_spawn resolved one. The worker
    // still mounts the base `deepartments-worker` preset; the role is the
    // persona DELTA (the person supports it: role = persona + tool allowance).
    if (extra !== void 0 && (extra.persona !== undefined || extra.taskText !== undefined)) {
      const personaText = extra.persona ?? ''
      const taskText = extra.taskText === undefined ? '' : `\n\n## Your current assignment\n\n${extra.taskText}`
      // F10 persona templating: a role persona body (e.g. presets/
      // departments/<dept>/<role>.md) may carry the same department template
      // variables as the architecture — substitute the real values BEFORE the
      // section is assembled so a raw uppercase {{headPostId}} never reaches
      // the harness prompt expander (which only accepts lowercase variable
      // names). A post without a config department (legacy/department-less)
      // leaves the persona untouched. {{cwd}} is never touched.
      const raw = `${personaText}${taskText}`
      const combined = (department !== void 0 ? renderDepartmentTemplate(raw, department) : raw).trim()
      if (combined !== '') {
        sp.section({
          name: `deepartments:${isWorker ? 'worker' : 'head'}:role-persona:${postId}`,
          order: 2,
          text: combined
        })
      }
    }
    // F10 (spec 004 §9.1): the DEPARTMENT ARCHITECTURE — a 3rd systemPrompt
    // section for EVERY post of the department (worker AND head), when the
    // department has an ARCHITECTURE.md. Omitted cleanly otherwise (a
    // department-less/legacy post or a department with no architecture file).
    if (department !== void 0) {
      const architecture = buildArchitectureSection(department)
      if (architecture !== void 0) {
        sp.section({
          name: `deepartments:${isWorker ? 'worker' : 'head'}:architecture:${postId}`,
          order: 3,
          text: architecture
        })
      }
    }
  }

  /** Build the `setup(agentCtx)` for one post (head OR worker): mount the post's
   * dedicated preset and register its board toolset + role, scoped to the post
   * agent. Runs pre-publication on the fresh agent's scoped context
   * (rc.8 CreateAgentOptions.setup, index.d.ts:117). The `manager` flag gates
   * the department-lifecycle tools (a head creates/retires; a worker cannot).
   * F10 adds `tools` (a worker's role-template frontmatter `tools`) and
   * `department` (its config department for the architecture section). */
  /** M2.4 (2026-08-28): resolve the POST agent's scope key for the audit
   * waypoints WITHOUT depending on which module instance of
   * `@deepseek-ai/dsh-scope` the plugin resolved. The live profile loads TWO
   * copies of the package (the harness bundle's at /usr/lib/…/dsh/node_modules
   * and the repo's own under node_modules/.pnpm/…), and `kScope` is a
   * module-local symbol — so the harness's `createScope` (dsh-agent-loop) tags
   * the agent ctx with ITS symbol while the plugin's `scopeOf(agentCtx)` reads
   * ITS OWN symbol → returns undefined in live (post-boot 01:26Z audit:
   * toolset-final `count:14` with secretary 'no' — the waypoints fell back to
   * the GLOBAL view: the same 14 host-plane names for heads AND workers, incl.
   * the manager-gated `dept_post_retire` for a WORKER, while NO own-layer name
   * (calendar/dept_exec/secretary) was visible, even though the own-layer
   * registration demonstrably landed — the live worker session carries the
   * calendar+dept_exec tools). THE KEY: the harness's scope key IS the agent
   * object itself (`ReactLoopAgent`: `createScope(loopCtx, this)` +
   * `ctx.extend({ agent: this })`), so `agentCtx.agent` is the real key
   * whenever `scopeOf` is shadow-unreadable. The fallback keeps the waypoints
   * on the agent's OWN layer in both worlds: hermetic (scopeOf resolves — one
   * instance) and live (scopeOf → undefined → `agentCtx.agent`). */
  const agentScopeOf = (agentCtx: Context): object | undefined => scopeOf(agentCtx) ?? (agentCtx as unknown as { agent?: object }).agent

  const postSetup = (postId: string, roomId: string, role: string, opts: { preset: string; manager: boolean; persona?: string; taskText?: string; tools?: string[]; department?: DepartmentConfig }): ((agentCtx: Context) => unknown) => {
    const presetId = opts.preset
    const kind = opts.manager ? 'head' : 'worker'
    // F10 (spec 004 §7.1): the role template's frontmatter `tools` (a worker)
    // OR the head's fixed base set (a head) become the REAL inherited-tool
    // allowance. Denied / unknown / scope-local names are DROPPED (with a
    // warning) so restrict() never throws on a template that names a tool the
    // agent scope cannot see. The own-layer board tools are exempt from the
    // mask (scoped registrations always stay visible) so they are NOT named.
    const declared: readonly string[] = opts.manager ? HEAD_BASE_TOOLS : (opts.tools ?? [])
    return async (agentCtx) => {
      // (a) AWAIT the dedicated preset mount FIRST, before the capability probe.
      //     read/write/glob/grep are PRESET-ONLY contributions (the web
      //     deepartments-dev profile disables the host-plane base
      //     tool-fs/tool-fs-search — dsh-web-app/cordis.patch.yml:333-337), so a
      //     probe that runs BEFORE the mount — the pre-fix fire-and-forget
      //     `void agentPresets.mount(...)` — sees only the host-global web tools,
      //     drops the fs tools from the allow-list, and restrict() then MASKS
      //     them (the F10 runtime symptom: web yes, fs no). The harness awaits
      //     setup (dsh-agent-loop lib/index.js:1260 `await raceAbort(setup?.(...))`),
      //     so the async mount fully installs its standing bind before publish.
      //     A failed mount degrades to board-only (pre-F10 behavior), never a
      //     failed spawn.
      if (agentPresets !== void 0) {
        try {
          await agentPresets.mount(agentCtx, presetId)
        } catch (error: unknown) {
          ctx.logger.warn(`[deepartments] ${kind} "${postId}" preset mount failed (board tools still installed): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // M2.3 WP1b (post-mount waypoint): did the standing leave the secretary
      // bound on the agent scope RIGHT AFTER the mount? Separates
      // row-absent from apply-failed — with the own-layer registration this is
      // the STANDING chain's contribution only (a head's visibility no longer
      // depends on it). Written to the guaranteed audit channel
      // `<stateDir>/toolset-audit.jsonl` — the deepartments warns never reach
      // the harness stdout (M2.2 finding).
      // M2.4: `scopeOf(agentCtx)` may be undefined in the LIVE profile (the
      // plugin resolves a DIFFERENT dsh-scope module instance than the harness
      // — see agentScopeOf) — the waypoint therefore reads via the resolved
      // key (scopeOf → `agentCtx.agent` fallback), never the broken global
      // view; `scopeKeySource` records which seam produced the key.
      appendToolsetAudit(stateDir, {
        wp: 'post-mount',
        postId,
        kind,
        presetId,
        ts: Date.now(),
        scopeKeySource: scopeOf(agentCtx) === void 0 ? (agentCtx as unknown as { agent?: unknown }).agent === void 0 ? 'unscoped' : 'ctx-agent' : 'scopeOf',
        secretary: agentCtx.tools.get('secretary', agentScopeOf(agentCtx)) === void 0 ? 'no' : 'yes'
      })
      // (0) Tool restriction: a root agent has no startContinuable toolFilter,
      // so we mask the GLOBAL host-plane tools to `allowList` (rc.8 dsh-tools
      // restrict — index.d.ts:611 "A restriction filters what a scope
      // inherits... a restricted-away global reads as absent"; it NEVER touches
      // the scope's OWN layer). The post therefore sees its own-layer board
      // tools + only the inherited capability tools in the allow list. A
      // template that still names a non-restrictable name degrades SAFELY to
      // `allow: []` (the pre-F10 behavior — board tools only; never a failed
      // spawn).
      //
      // F10 live-fix (2026-08-23): the allow-list MUST be built against the
      // AGENT's own scope, not the host global layer. In the live dsh
      // agent-preset layout the model-facing capability tools (read/write/glob/
      // grep/web_search/web_fetch) are an ANCESTOR contribution behind the base
      // preset's `isolate` realm — they are NOT on the host GLOBAL layer — so
      // the pre-fix probe `ctx.tools.get(name)` (the host GLOBAL view) resolved
      // every declared capability tool to undefined and degraded every post to
      // board-only (the F10 runtime symptom). `agentCtx.tools.get(name,
      // agentScope)` reads the agent's OWN view: it resolves the global +
      // ancestor (inherited) capability tools. Own-layer names (the bus /
      // lifecycle tools the role templates ALSO declare) are excluded FIRST via
      // OWN_LAYER_POST_TOOLS — naming a scope-local name in restrict() would
      // THROW and degrade to allow:[] again.
      // M2.1 (deploy fix, 2026-08-28): the 'secretary' name in HEAD_BASE_TOOLS
      // is now ALWAYS found here — the tool-secretary row of the head preset
      // registers its tool UNCONDITIONALLY at apply time (src/subagent.ts), so
      // a standing mount that applies the row while the 'spawn' provider is
      // still absent no longer leaves the tool missing at this probe (the M2.1
      // finding: a rematerialized head never saw its own secretary because the
      // pre-fix registration was gated on the provider and this drop-warn then
      // masked it permanently). The drop-warn stays the correct degradation for
      // a row that is genuinely ABSENT (a template bug): the probe is
      // deliberately NOT widened to allow declared-but-unseen names blindly —
      // restrict() validates inherited names loudly, so naming an unseen name
      // would throw and the allow:[] fallback would mask EVERY inherited tool
      // (strictly worse than dropping one name).
      const agentScope = agentScopeOf(agentCtx)
      const allowList: string[] = []
      for (const name of declared) {
        if (DENIED_POST_TOOLS.has(name)) {
          ctx.logger.warn(`[deepartments] ${kind} "${postId}" role tool "${name}" is security-denied (no subagent/wrapper machinery or run_code for department posts) — dropped`)
          continue
        }
        if (OWN_LAYER_POST_TOOLS.has(name)) continue
        if (agentCtx.tools.get(name, agentScope) === void 0) {
          ctx.logger.warn(`[deepartments] ${kind} "${postId}" role tool "${name}" is not visible to the agent scope (not an inherited global/ancestor tool) — dropped`)
          continue
        }
        allowList.push(name)
      }
      // M2.3 WP2 (probe waypoint): the consolidated probe line — the inherited
      // allow-list as BUILT + whether 'secretary' is in it. POST-MOVE the
      // secretary lives in OWN_LAYER_POST_TOOLS, so the probe skips it here and
      // the status is 'dropped(own-layer)' (by design — it is registered on the
      // own layer AFTER the restrict, see installHeadBoardTools); a
      // 'dropped(not-visible)' would mean a future reordering ran the own-layer
      // registration BEFORE the probe, and 'found' would mean the name leaked
      // back into HEAD_BASE_TOOLS (the M2.3 coherence condition).
      // M2.4: the probe MUST resolve the agent's own layer the same way the
      // tool registry does (`agentScopeOf` — scopeOf with the `agentCtx.agent`
      // fallback for the live dual-dsh-scope profile; the 01:26Z post-boot
      // audit showed `count:14` with the SAME 14 host-plane names for heads AND
      // workers — incl. the manager-gated dept_post_retire for a WORKER — i.e.
      // the waypoint had read the GLOBAL view because the plugin's `scopeOf`
      // module instance differs from the harness's: two copies of dsh-scope,
      // two `kScope` symbols). `scopeKeySource` + `allowCount` record what the
      // probe saw and through which seam, so the audit says WHY the toolset
      // landed (or not).
      appendToolsetAudit(stateDir, {
        wp: 'probe',
        postId,
        kind,
        allow: allowList.join(','),
        allowCount: allowList.length,
        scopeKeySource: scopeOf(agentCtx) === void 0 ? (agentCtx as unknown as { agent?: unknown }).agent === void 0 ? 'unscoped' : 'ctx-agent' : 'scopeOf',
        secretary: DENIED_POST_TOOLS.has('secretary')
          ? 'dropped(denied)'
          : OWN_LAYER_POST_TOOLS.has('secretary')
            ? 'dropped(own-layer)'
            : allowList.includes('secretary')
              ? 'found'
              : agentCtx.tools.get('secretary', agentScope) === void 0
                ? 'dropped(not-visible)'
                : 'found'
      })
      let restrictOwn: () => void
      try {
        restrictOwn = agentCtx.tools.restrict({ allow: allowList })
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] ${kind} "${postId}" tool restrict(${JSON.stringify(allowList)}) fell back to allow:[] — ${error instanceof Error ? error.message : String(error)}`)
        restrictOwn = agentCtx.tools.restrict({ allow: [] })
      }
      // (b) Register the board toolset scoped to this agent (manager gates the
      // department-lifecycle create/retire tools for heads). B2 (spec W5):
      // `dept_exec` is granted ONLY to a post whose allow-list DECLARES it —
      // for a worker, the role template's frontmatter `tools` (a config head
      // never declares it; HEAD_BASE_TOOLS does not carry it), so a post that
      // does not declare the tool never sees it and the host never gets it.
      const tools = installHeadBoardTools(agentCtx, opts.manager, { allowExec: declared.includes('dept_exec') })
      // M2.3 WP3 (toolset-final waypoint): enumerate the candidate toolset on
      // the AGENT scope AFTER the own-layer install (the proxy of the real
      // "attach" — the point the toolset derivation is fully done): how many
      // candidate names are visible + the key ones (secretary, send_message,
      // dept_who, dept_memo_write). `secretary=yes` here proves the OWN layer
      // carried it (post-restrict); `secretary=no` with the own-layer
      // registration present would expose a registration-order regression.
      // M2.4: `scopeKeySource` says WHICH seam produced the key the waypoint
      // read through — 'scopeOf' (hermetic: one module instance) or 'ctx-agent'
      // (live: the harness's own key object — the dual-dsh-scope fallback). A
      // line with scopeKeySource 'unscoped' would mean the audit re-fell to the
      // GLOBAL view (the pre-fix false 'no' of the 01:26Z post-boot audit).
      // `ownVisible` counts the own-layer candidate names that landed (proves
      // the registration, not just secretary alone).
      {
        const candidates = [...new Set([...HEAD_BASE_TOOLS, ...OWN_LAYER_POST_TOOLS, 'dept_calendar_add', 'dept_calendar_list', 'dept_calendar_remove', 'dept_feedback', 'dept_feedback_list', 'dept_feedback_update'])]
        const visible = candidates.filter((name) => agentCtx.tools.get(name, agentScope) !== void 0)
        const ownVisible = visible.filter((name) => OWN_LAYER_POST_TOOLS.has(name)).length
        appendToolsetAudit(stateDir, {
          wp: 'toolset-final',
          postId,
          kind,
          count: visible.length,
          ownVisible,
          scopeKeySource: scopeOf(agentCtx) === void 0 ? (agentCtx as unknown as { agent?: unknown }).agent === void 0 ? 'unscoped' : 'ctx-agent' : 'scopeOf',
          secretary: visible.includes('secretary') ? 'yes' : 'no',
          send_message: visible.includes('send_message') ? 'yes' : 'no',
          names: visible.join(',')
        })
      }
      // (c) Persona = the role (a head's role or a worker's role), NOT a mission.
      // F3: the ROLE PERSONA delta (+ the task) rides the same section seam.
      // F10: `department` feeds the architecture section (spec 004 §9.1).
      installRoleSection(agentCtx, role, postId, opts.manager === false, { persona: opts.persona, taskText: opts.taskText }, opts.department)
      // Ensure the agent-scoped registrations unwind with the agent.
      agentCtx.effect(() => () => { tools.dispose(); restrictOwn() }, `deepartments: ${kind} board tools (${postId})`)
    }
  }

  /** The setup for a PERMANENT department head (manager — can create/retire
   * workers). Mounts the 'deepartments-head' preset. F10: `department` feeds the
   * architecture section (spec 004 §9.1) for the head post. */
  const headSetup = (postId: string, roomId: string, role: string, presetId: string = PRESET_ID, department?: DepartmentConfig): ((agentCtx: Context) => unknown) =>
    postSetup(postId, roomId, role, { preset: presetId, manager: true, department })

  /** The setup for a DISPOSABLE department WORKER (no create/retire). Mounts
   * the 'deepartments-worker' preset. F3: `extra` carries the role template
   * persona + the spawned task (spec §7.4 — persona delta + assignment).
   * F10: `extra.tools` carries the role template's frontmatter `tools` (the
   * real inherited allow-list); `extra.department` feeds the architecture
   * section.
   * Absent (legacy dept_post_create) → the framing role section only, NO role
   * tools (pre-F10 behavior: board-only, `allow: []`). */
  const workerSetup = (postId: string, roomId: string, role: string, extra?: { persona?: string; taskText?: string; tools?: string[]; department?: DepartmentConfig }): ((agentCtx: Context) => unknown) =>
    postSetup(postId, roomId, role, { preset: WORKER_PRESET_ID, manager: false, persona: extra?.persona, taskText: extra?.taskText, tools: extra?.tools, department: extra?.department })

  /** Dispose one head's live AgentHandle (its only teardown capability; the
   * bare `agents.get(id)` returns no dispose — rc.8 index.d.ts:349 vs 155-158).
   * Idempotent. The durable session survives for a later resume. Shared by heads
   * and workers (both keyed in byHeadHandle by their session id). */
  const disposeHeadHandle = async (sessionId: string): Promise<void> => {
    const handle = byHeadHandle.get(sessionId)
    if (handle === void 0) return
    byHeadHandle.delete(sessionId)
    try {
      await handle.dispose()
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] head dispose for ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** disposeHeadHandle with the in-flight dedupe of `disposingHeads`: two
   * concurrent disposers of the SAME session (dept_sleep + a wake respawn, a
   * double dept_sleep, retirePost during a sleep) share ONE detach and proceed
   * only once it settles. Never rejects (disposeHeadHandle logs and swallows
   * handle errors), so a fire-and-forget caller (`void`) cannot produce an
   * unhandled rejection. Returns the shared promise so the fire-and-forget
   * caller and an awaiting caller (materializePost) agree on the same
   * completion; the map entry is dropped once settled (no leak, no stale
   * dedupe of a later dispose of a re-materialized handle). */
  const disposeHeadHandleOnce = (sessionId: string): Promise<void> => {
    const inFlight = disposingHeads.get(sessionId)
    if (inFlight !== void 0) return inFlight
    const run = disposeHeadHandle(sessionId).finally(() => {
      disposingHeads.delete(sessionId)
    })
    disposingHeads.set(sessionId, run)
    return run
  }

  // DEADLOCK FIX (incident 2026-08-26): the BOUNDED detach-join window for the
  // sleep respawn (materializePost). The real harness dispose() sends
  // machine.cancel + `await machine.whenIdle()`; when the machine's OWN turn is
  // still executing a TOOL (the QD-directive cascade of 2026-08-26 20:48Z/
  // 21:18Z), whenIdle NEVER settles and the detach becomes a zombie. A plain
  // `await disposeHeadHandleOnce` on that zombie pends forever — and every
  // awaited bus delivery to the slept head joins it (the send_message that
  // froze the host). Production default 10s — a NORMAL join settles in
  // milliseconds (the turn ends right after the fire-and-forget detach
  // dispatch), so the bound is a pure safety net. Hermetic tests override it.
  const disposeJoinTimeoutMs = (): number => {
    const raw = process.env.DEEPARTMENTS_DISPOSE_JOIN_TIMEOUT_MS
    const n = raw === undefined ? NaN : Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 10_000
  }

  /** DEADLOCK FIX (2026-08-26) — the BOUNDED `disposeHeadHandleOnce` join for
   * the sleep respawn. Returns true when the detach settled before the bound;
   * false on timeout. A timeout can NEVER corrupt the respawn: the fresh
   * incarnation mints a NEW session id (F8), so the zombie machine (still on
   * the OLD id, disposed in the background via the disposingHeads dedupe) can
   * never collide with it — the join exists only to avoid racing a *settling*
   * detach, and unbounded joining is strictly worse than proceeding. */
  const joinHeadDisposeOnce = async (sessionId: string): Promise<boolean> => {
    return Promise.race([
      disposeHeadHandleOnce(sessionId).then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), disposeJoinTimeoutMs())
      })
    ])
  }

  /** Retire a registered post cleanly — the SHARED retirement path used by the
   * global HOST-plane `dept_post_retire` AND the head own-layer `dept_post_retire`.
   *
   * Retirement = (a) dispose its live AgentHandle (if any), (b) unregister it
   * from byPost/byChild and persist. B3 cutover: NO withdrawal note (the board
   * is gone — the registry unregistration is the only signal). The persisted
   * durable session remains (no native delete — researcher M1), but the registry
   * stops addressing it, so it is never woken again; a retired CONFIGURED head is
   * simply re-materialized by ensureAllHeads as before (documented gap), whereas
   * a retired DISPOSABLE WORKER is never re-materialized (workers are runtime-only,
   * not config — see ensureAllHeads).
   *
   * F1 (spec 004 §4.3): a WORKER retire is MARKED, NOT ERASED — the entry stays
   * in posts.json (and in byPost) with `retired: true` (history queryable), and
   * every live-catalog consumer (busDeliverCatalog addressing, dept_who, the
   * wake-pack roster) filters it. A configured HEAD retire keeps today's
   * semantics (entry deleted, re-materialized by config at boot — cosmetic).
   *
   * Scope (F1, spec 004 §4.2 — restored to "ONLY MY workers"): a HOST caller
   * (`postIdForChild(callerId) === undefined`) may retire ANY post (today's
   * semantics). A HEAD caller is restricted to DISPOSABLE WORKERS **of its own
   * department**: the target must be a worker whose `managerId` is the caller's
   * postId OR whose `departmentId` equals the caller's config department —
   * replacing the pre-F1 generic "any worker" check. A legacy worker without
   * the F1 fields matches neither (backfill policy: an estate-owned orphan is
   * host-retireable only). A permanent head is never retired by a head. */
  /** FIX-1 (QD NO_ADAPTER alerting) — capture a FRESH turn/end ERROR (the
   * NO_ADAPTER / no-provider class) at the moment a WORKER is cleanly retired and
   * append ONE post-error row so the health daemon ALERTS the host even though the
   * post is about to be retired. The daemon's per-tick turn-error capture
   * (runHealthDaemonTick → scanTurnErrorCaptures) SKIPS retired posts
   * (`if (post.retired === true) continue`) AND the retire path disposes the handle
   * (disposeHeadHandleOnce below), so the live session events are GONE before the
   * ≤60s tick scans them — a no-op-die worker (NO_ADAPTER at its first model call)
   * would otherwise be indistinguishable from success. Reading the STILL-LIVE
   * handle's events HERE (before dispose) recovers the error turn.
   * Never throws (a capture/persist failure is a warn — non-fatal to the retire);
   * deduped via turn-errors-state so a turn the daemon ALREADY recorded (and is
   * still fresh) is NOT double-counted. */
  const captureRetiredPostTurnError = async (stateDir: string, sessionId: string, postId: string): Promise<void> => {
    try {
      const liveAgent = agents?.get(sessionId)
      const events = (liveAgent?.session?.events ?? []) as HealthSessionEvent[]
      if (events.length === 0) return
      const capture = scanTurnErrorCaptures(events, postId)
      if (capture === undefined) return
      const nowMs = Date.now()
      // Only a FRESH error (<= the turn-error window) is worth recording at retire —
      // a stale turn either was already captured by a prior daemon tick or is too
      // old to alert on.
      if (nowMs - capture.ts > TURN_ERROR_FRESH_WINDOW_MS) return
      // Dedupe: a turn the daemon ALREADY recorded (and is still fresh) is not
      // recorded twice (the retire-seam is a second chance, not a double-count).
      const captureState = readTurnErrorsState(stateDir)
      const lastCaptured = captureState[capture.key]
      if (lastCaptured !== undefined && nowMs - lastCaptured < TURN_ERROR_FRESH_WINDOW_MS) return
      await appendPostError(stateDir, { ts: capture.ts, postId: capture.postId, error: capture.error }, nowMs)
      await writeTurnErrorsState(stateDir, { ...captureState, [capture.key]: nowMs })
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] dept_worker_retire: turn-error capture failed (non-fatal to the retire): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** W7-A (in-session settlement of a retiring post's pending deliveries): the
   * dead-recipient `terminal`-una-vez settlement of the boot re-delivery driver
   * (DeliveryRedeliverer.run) runs ONLY at boot — a post RETIRED in-session
   * (dept_post_retire / dept_worker_retire / the auto-retire seams) left its
   * pending 'prepared'/'failed' write-ahead sidecar rows parked until the next
   * boot. This mirror settles them AT RETIRE TIME so a retired worker's stale
   * deliveries are 'terminal' BEFORE any boot; the boot pass keeps working as
   * the crash fallback (untouched — it re-settles idempotently after a crash).
   * Semantics are the boot driver's EXACTLY: iterate the LATEST row per
   * (messageId, recipientId) (a later 'delivered'/'resumed'/'self'/'terminal'
   * row shadows an earlier 'prepared'/'failed' one — the same latestPerKey
   * dedupe as DeliveryRedeliverer.run), settle the pairs of the ONE retiring
   * recipient whose latest status `needsRedelivery` by appending a SINGLE
   * 'terminal' row via the shared markDelivery utility, and NEVER emit a fresh
   * 'prepared'/'failed' row (the settle only appends 'terminal' → the W6 health
   * daemon never re-alerts for the retired post, and scanDeliveryFindings keeps
   * excluding a retired member — C6/Bug-A already covered). A pair ALREADY
   * settled (delivered/resumed/self/terminal) is untouched, and a LIVE
   * recipient's rows are untouched (scoped strictly to `retiredPostId`).
   * Non-fatal by design (mirrors captureRetiredPostTurnError): a sidecar
   * read/mark failure only warns — the retire still commits and the boot pass
   * re-settles on the next boot. */
  const settleRetiredPostDeliveries = async (retiredPostId: string): Promise<void> => {
    try {
      // ALTO-1 (m-728 rebind guard): the settle is keyed (messageId,
      // recipientId), but a PRE-fix sidecar may hold a STALE row whose id was
      // REBOUND by a newer compaction to a DIFFERENT record. Guard (the boot
      // driver's own rebind rule): settle ONLY a pair whose CURRENT record
      // exists AND actually addresses the recipient — anything else is a stale
      // row (its record trimmed, or the current record never sent to this
      // recipient) and is skipped, so the settle NEVER settles the wrong
      // record. An unreadable messages file → the empty map → nothing settles
      // (conservative; the boot pass re-evaluates).
      let recordsById = new Map<string, MessageRecord>()
      try {
        const records = await loadMessageRecords(resolveMessagesPath(stateDir))
        recordsById = new Map(records.map((record) => [record.id, record]))
      } catch {
        recordsById = new Map()
      }
      let text: string
      try {
        text = await readFile(resolveDeliveriesPath(stateDir), 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // nothing ever sent
        throw error
      }
      const latestPerKey = new Map<string, DeliveryRow>()
      for (const row of parseDeliveryRows(text)) latestPerKey.set(`${row.messageId}\u0000${row.recipientId}`, row)
      for (const row of latestPerKey.values()) {
        if (row.recipientId !== retiredPostId) continue
        if (!needsRedelivery(row.status)) continue
        const record = recordsById.get(row.messageId)
        if (record === void 0 || !record.to.includes(row.recipientId)) continue
        await markDelivery(stateDir, row.messageId, row.recipientId, 'terminal')
        ctx.logger.info(`[deepartments] retire settle: ${row.messageId} → ${row.recipientId} (was ${row.status}) → 'terminal' — post retired in-session, settled once (no boot needed)`)
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] retire settle for "${retiredPostId}" failed (non-fatal — the boot re-delivery pass re-settles): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** O2 (MICRO-BATCH O2, QD compromiso — ANALYZE m-598): predict whether a
   * RETIRED worker produced a DELIVERABLE, for the worker-retired q-i directive
   * (`deliverable: none|report`). CONSERVATIVE, DURABLE heuristic (decided with
   * the code; documented for the QD pipeline):
   *   'none'    ⇔ a RECENT turn-error row for this worker EXISTS in
   *              `<stateDir>/post-errors.jsonl` (inside HEALTH_ERROR_WINDOW_MS —
   *              2h, the SAME anomaly window the health daemon scans) AND the
   *              worker produced NO durable OUTBOUND in that anomaly window (no
   *              messages.jsonl record `from === workerPostId` with `ts >=
   *              latestErrorTs - HEALTH_ERROR_WINDOW_MS` — every send_message
   *              the worker ever made persists there; a WRITE-only worker counts
   *              as outbound-less in the error case because a report that was
   *              never SENT left no durable trace, and the conservative label
   *              is 'none').
   *   'report'  otherwise (DEFAULT — a clean retire, an error with ANY durable
   *              outbound in the window, or any read/parse failure: the
   *              existing flow never changes and the retire never breaks).
   * ORDER/DURABILITY (fb-8 verification — mission fix (a)): the outbound read
   * is read-after-write GUARANTEED. send_message appends the record durably
   * BEFORE any delivery ("durable first (persist-before-deliver)" —
   * MessagesStore.append awaits appendMessageRecord, which awaits appendFile,
   * BEFORE delivering — dshd-core messages.ts:419; the worker's send_message
   * appends at invoke.ts:7242), the delivery auto-retire (busDeliverToPost)
   * and any head retire therefore run AFTER the record is on disk, and this
   * predictor reads messages.jsonl
   * directly (a fresh readFile) AFTER settleRetiredPostDeliveries +
   * archiveWorkerSession — ordered AFTER the worker's own delivery path.
   * BIAS SKEW (fb-8 verification — mission fix (b)): the comparison is
   * `record.ts >= latestErrorTs - HEALTH_ERROR_WINDOW_MS`, NOT a strict
   * `ts > latestErrorTs`. A strict-after comparison mislabels the REAL
   * production shape: the worker's FINAL turn SENDS its report (durable record
   * ts = send time) and THEN the same turn ENDS in error — the error row's ts
   * is the turn/end EVENT time (scanTurnErrorCaptures uses event.time,
   * dshd-health index.ts:947), which lands AFTER the same-turn sends, so a
   * legitimately-published report read 'none'. With the skew (the SAME 2h
   * anomaly window the error itself must be inside), any durable outbound the
   * worker made within the window — BEFORE or AFTER the error row — proves
   * published content → 'report'; only an error with ZERO outbound in the
   * window is 'none'. The 3 O2 test cases are deterministic under this rule:
   * (a) error + 0 outbound → 'none'; (b) clean retire (no error) → 'report';
   * (c) error + a durable send (either in-turn order) → 'report'.
   * Rationale: a worker whose FINAL turn died (the 400 reasoning_content class:
   * a long silent turn, 0 outbound) leaves its error row FRESH at retire time
   * (captureRetiredPostTurnError appends it right before this predictor runs —
   * the retire seam at retirePost) and has no durable message in the window, so
   * 'none' lets the ANALYZE pipeline QUESTION the retire instead of citing a
   * conclusion that was never published. Never throws (a failure degrades to
   * 'report'). */
  const predictRetiredWorkerDeliverable = async (workerPostId: string): Promise<'none' | 'report'> => {
    try {
      const nowMs = Date.now()
      const errors = readPostErrorsFile(stateDir)
        .filter((row) => row.postId === workerPostId && nowMs - row.ts <= HEALTH_ERROR_WINDOW_MS)
      if (errors.length === 0) return 'report'
      const latestErrorTs = Math.max(...errors.map((row) => row.ts))
      let text: string
      try {
        text = await readFile(resolveMessagesPath(stateDir), 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') text = '' // no message ever persisted
        else throw error
      }
      // fb-8 bias skew: an outbound at-or-after `latestErrorTs - HEALTH_ERROR_WINDOW_MS`
      // (the SAME 2h anomaly window) counts — a durable send BEFORE or AFTER the
      // error proves the worker published content; only error + ZERO outbound in
      // the window is 'none'. (A strict `ts > latestErrorTs` mislabeled the
      // send-then-turn-error shape: the error row's ts is the turn/end EVENT
      // time, AFTER the same-final-turn sends.)
      const outboundInWindow = parseMessageRecords(text)
        .some((record) => record.from === workerPostId && record.ts >= latestErrorTs - HEALTH_ERROR_WINDOW_MS)
      return outboundInWindow ? 'report' : 'none'
    } catch {
      return 'report'
    }
  }

  const retirePost = async (postId: string, callerAgentId: string): Promise<{ postId: string; retired: true }> => {
    const entry = byPost.get(postId)
    if (entry === void 0) throw new Error(`[deepartments] dept_post_retire: "${postId}" is not a registered post`)
    // Scope check for HEAD callers (a caller that IS a registered post is a
    // department head; a caller with no post entry is a HOST).
    const callerId = postIdForChild(callerAgentId)
    if (callerId !== void 0) {
      const callerEntry = byPost.get(callerId)
      if (callerEntry === void 0) throw new Error(`[deepartments] dept_post_retire: caller "${callerId}" is not a registered post`)
      // A head may only retire DISPOSABLE WORKERS (the room-equality check was
      // board-specific and is removed with the rooms).
      if (entry.provider !== 'worker') throw new Error(`[deepartments] dept_post_retire: "${postId}" is not a disposable worker — a head may only retire workers, never a permanent head`)
      // F1: ONLY MY WORKERS — the caller must be the entry's manager (the head
      // that created it) or a head of the SAME config department (a manager
      // replacement/department-cluster head stays in scope).
      const callerDepartment = departmentForPost(callerId)
      const sameManager = entry.managerId !== void 0 && entry.managerId === callerId
      const sameDepartment = entry.departmentId !== void 0 && callerDepartment !== void 0 && entry.departmentId === callerDepartment.id
      if (!sameManager && !sameDepartment) {
        throw new Error(`[deepartments] dept_post_retire: "${postId}" is not a worker of YOUR department (manager ${entry.managerId ?? 'unset'}, department ${entry.departmentId ?? 'unset'}) — a head may only retire the workers it created or the workers of its own department`)
      }
    }
    // Idempotent (spec patterns): a second retire of an already-marked worker
    // succeeds as a no-op (the dispose is deduped via disposeHeadHandleOnce).
    if (entry.retired === true) return { postId, retired: true }
    if (entry.provider === 'worker') {
      // FIX-1 (QD NO_ADAPTER alerting): BEFORE the mark + dispose, capture a FRESH
      // turn/end error (e.g. NO_ADAPTER) on the STILL-LIVE handle's session events
      // so the health daemon ALERTS the host even though this post is about to be
      // retired (the daemon skips retired posts AND the dispose empties the events
      // — see captureRetiredPostTurnError). Never throws / non-fatal to the retire.
      await captureRetiredPostTurnError(stateDir, entry.sessionId, postId)
      // MARK, NOT ERASE (F1): the registry entry stays; the live catalog filters.
      // The store owns the durable MARK (retired:true + manager-ledger prune +
      // persist) — it never erases a post from the catalog.
      registry.markPostRetired(postId)
      // W7-A (in-session settlement): right after the durable mark commits,
      // settle the retiring worker's pending 'prepared'/'failed' delivery rows
      // to ONE 'terminal' row per messageId — in-session, so the stale rows are
      // terminal BEFORE any boot (the historical debt; the boot pass remains
      // the crash fallback). Non-fatal (a failure warns only — retirePost's
      // semantics are unchanged) and scoped to DISPOSABLE WORKERS: a configured
      // head retire unregisters and is re-materialized LIVE at boot — never
      // settled, exactly like the boot driver (it settles only DEAD recipients).
      await settleRetiredPostDeliveries(postId)
      // QD (spec 007 §6.1, D-Q2 — LOTE B, owner 2026-08-27): the worker-retire
      // dice lives HERE, on retirePost — the ONE shared retire seam that covers
      // every REAL retire path (dept_worker_retire, the host dept_post_retire,
      // the AUTO-RETIRE on delivery, and the boot-reconcile half-slept reap), so
      // a worker retired by ANY of them rolls the 25% sample. The idempotent
      // no-op (entry.retired === true) returned BEFORE this point ⇒ a re-retire
      // of an already-retired worker NEVER re-emits (R1). Non-fatal by design:
      // a directive failure only warns — the retire mark above already committed.
      // `archived` is the archive result of THIS retire (idempotent —
      // dept_worker_retire's own archive call stays as a harmless double; a
      // missing registry resolves false). The retire path NEVER breaks here.
      // Dx1 F1 (owner bug — the sidebar painted retired workers as 'idle'): the
      // DURABLE-SESSION ARCHIVE is UNCONDITIONAL on EVERY retire — the QD dice
      // below ONLY samples the inspect DIRECTIVE, never the archive. Before
      // this, the archive traveled INSIDE the 25% dice, so 75% of the
      // auto-retire seams (delivery auto-retire / half-slept reap) left the
      // workspace-registry hide-set unpopulated and the row stayed visible
      // forever. archiveWorkerSession is idempotent (a re-archive is a no-op
      // hide-set add — dept_worker_retire's own archive call stays a harmless
      // double) + non-fatal (a missing registry resolves false + a warn). The
      // retire path NEVER breaks here.
      const archived = await archiveWorkerSession(entry.sessionId)
      // QD DICE INSTRUMENTATION (QH [HIGH] 2026-08-28 — qi-silence
      // characterization): ONE INFO line per RETIRE with postId/roll/prob/emitted —
      // the ONLY runtime way to separate a dice RUN (the 15-retire/0-directive
      // event, P=1.34%, was a by-design true positive) from a TRANSIENT
      // degradation of the dice→emit path. PURE INFORMATION: the roll is drawn
      // ONCE and fed to the gate as its rng (the gate's single draw — bit-identical
      // dice semantics) and `retireProb` mirrors the gate's effective probability
      // resolution (env DEEPARTMENTS_QUALITY_INSPECT → config → code default
      // 0.25). The dice outcome and the emit are UNCHANGED. INFO, not warn (normal
      // cadence); no `isFirstRetire` guard exists on this seam.
      const retireRoll = Math.random()
      const qualityInspectEnvOverride = process.env[QUALITY_INSPECT_ENV_VAR]
      const qualityInspectEnvProb = qualityInspectEnvOverride === undefined || qualityInspectEnvOverride === '' ? undefined : Number(qualityInspectEnvOverride)
      const retireProb = qualityInspectEnvProb !== undefined && Number.isFinite(qualityInspectEnvProb) && qualityInspectEnvProb >= 0 && qualityInspectEnvProb <= 1
        ? qualityInspectEnvProb
        : qualityWorkerInspectProbability
      const retireEmitted = qualityInspectDecision('worker', { rng: () => retireRoll, workerInspectProbability: qualityWorkerInspectProbability })
      ctx.logger.info(`[deepartments] retirePost worker-retire QD dice: postId="${postId}" roll=${retireRoll} prob=${retireProb} emitted=${retireEmitted}`)
      try {
        if (retireEmitted) {
          // O2 (MICRO-BATCH O2, QD compromiso — ANALYZE m-598): label the
          // directive with the retire-time DELIVERABLE prediction ('none' =
          // turn-error + 0 outbound — the ANALYZE pipeline must QUESTION the
          // retire; 'report' = the normal flow, the default). Never throws.
          const deliverable = await predictRetiredWorkerDeliverable(postId)
          await maybeEmitQualityInspectDirective({ kind: 'worker-retired', workerPostId: postId, sessionId: entry.sessionId, archived, deliverable })
        }
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] retirePost worker-retired QD directive for "${postId}" failed (non-fatal — the retire already committed): ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      // Configured head / non-worker: today's semantics (unregister; the config
      // re-materializes it at boot — cosmetic retire). The store owns the
      // unregister + persist.
      registry.unregisterPost(postId)
    }
    // Also dispose any live handle (retiring a post should not leave it live) —
    // via the in-flight dedupe, so a concurrent dispose (e.g. the post's own
    // dept_sleep) is JOINED instead of raced into a double dispose.
    void disposeHeadHandleOnce(entry.sessionId)
    return { postId, retired: true }
  }

  /** F3 — archive a retired WORKER's durable session via the workspaceRegistry
   * seam (WorkspaceRegistryLike.archiveSession, the host-rotation precedent,
   * session-rotation.ts:283-291) so the SIDEBAR ROW disappears (spec §5.3/D5).
   * Non-fatal by design, exactly like the rotation archive: a missing registry
   * (headless/minimal profile) or a failing call resolves `false` + a warn —
   * the retire MARK (posts.json retired:true) is the durable part and always
   * commits. Called by dept_worker_retire (ONLY the new department-scoped
   * tool; the legacy dept_post_retire keeps today's no-archive behavior). */
  const archiveWorkerSession = async (sessionId: string): Promise<boolean> => {
    const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
    if (registry?.archiveSession === void 0) {
      ctx.logger.warn(`[deepartments] dept_worker_retire: archiveSession(${sessionId}) skipped — workspaceRegistry unavailable (the worker's sidebar row may remain until the registry service is present)`)
      return false
    }
    try {
      await registry.archiveSession(sessionId)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] dept_worker_retire: archiveSession(${sessionId}) failed (non-fatal — the retire mark still commits): ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** F8 (spec 002 head rotation) — non-fatal server-side archive of a SLEPT
   * HEAD's durable session via the workspaceRegistry seam (the S2.5 semantics:
   * a pure registry-set add + durable persist that HIDES the row; NOTHING
   * terminates the agent, the artifact and the journal/messages stay intact).
   * Mirrors archiveWorkerSession but for the dept_sleep HEAD path; never throws
   * (a missing registry or failing call resolves `false` + a warn) and the
   * sleep mark (posts.json sleepEpoch) is the durable part — the archive is
   * cosmetic row-hiding and must never block the sleep. */
  const archivePostSessionOnSleep = async (sessionId: string): Promise<boolean> => {
    const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
    if (registry?.archiveSession === void 0) {
      ctx.logger.warn(`[deepartments] dept_sleep: archiveSession(${sessionId}) skipped — workspaceRegistry unavailable (the head's sidebar row may remain until the registry service is present)`)
      return false
    }
    try {
      await registry.archiveSession(sessionId)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] dept_sleep: archiveSession(${sessionId}) failed (non-fatal — the sleep mark still commits): ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** F5 (spec 004 §6.2 L1) — the CONFIGURED WORKSPACE DIRECTORY of a
   * department, or `''` when the department has NONE (pre-F1 compat: the
   * department keeps the shared workspace root). `workspacePath` is optional in
   * config (F1 defaults it to `''`), so absent/blank/undefined all collapse to
   * `''` — the callers then fall through to `resolveWorkspaceRootPath`. */
  const departmentWorkspacePath = (department: DepartmentConfig | undefined): string => {
    const p = department?.workspacePath
    return typeof p === 'string' && p.trim() !== '' ? p.trim() : ''
  }

  /** F5 (spec 004 §6.2 L1) — ENSURE a department's REAL sidebar workspace
   * entity exists and return its canonical path (the cwd its head/worker
   * sessions attach to). The workspace SERVICE requires an existing directory
   * (it realpath-validates + stats), so mkdir -p first, then the registry
   * ensure. NEVER throws: every failure path WARNs and the configured path is
   * returned unchanged (the session is STILL created with that cwd — it just
   * won't be sidebar-attachable until the directory/entity exist, the honest
   * non-fatal WARN discipline of the attach hooks).
   * RACE (incident 2026-08-23): `registry.create(path, title)` is idempotent
   * ONLY AFTER the provider's durable state is loaded into memory — its
   * dedupe (dsh-workspace `createCanonical`) iterates the IN-MEMORY `entities`
   * map, which is EMPTY while the provider init is still in flight. The
   * deepartments boot hooks (hostsLoaded.then, ensureAllHeads) race that init
   * (the FIX 1b.1 window), so a naive create persisted a FRESH duplicate
   * record with a NEW id for the same canonical path on EVERY boot (observed
   * duplicates 7a9dbcbe / 8be7833e) → the NEXT boot's harness
   * `validateStoredState` rejected "workspace domain is inconsistent: path ...
   * is claimed by both workspace ... and ..." → the plugin tree load failed →
   * systemd crash loop → GUI down (production Tailscale 8445). FIX = the SAME
   * bounded-retry discipline as FIX 1b.1: retry until `registry.list()`
   * RESOLVES (list() throws while the state is missing, so resolution proves
   * the durable state is in memory), then resolveByPath-FIRST — the
   * NON-MUTATING canonical lookup that returns the entity an earlier boot or
   * the GUI already created — and `registry.create` ONLY as the fallback for
   * a genuinely unowned path. */
  const ensureDepartmentWorkspace = async (workspacePath: string, title: string): Promise<string> => {
    try {
      await mkdir(workspacePath, { recursive: true })
    } catch (error) {
      ctx.logger.warn(`[deepartments] department workspace dir "${workspacePath}" could not be created (${error instanceof Error ? error.message : String(error)}) — the department's sessions keep cwd "${workspacePath}" but are NOT sidebar-attachable until the directory exists`)
      return workspacePath
    }
    const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
    if (registry === void 0 || typeof registry.list !== 'function' || typeof registry.create !== 'function') {
      // NO usable registry service in this composition (headless/minimal
      // profile, or a harness without the workspace seams): a DEFINITIVE
      // absence — nothing can become available, so return immediately and
      // never block boot (the same fallback resolveWorkspaceRootPath uses).
      ctx.logger.warn(`[deepartments] department workspace create skipped (no workspaceRegistry.create seam in this composition) — the department's sessions keep cwd "${workspacePath}" but are not grouped in the sidebar`)
      return workspacePath
    }
    const deadline = Date.now() + HOST_ATTACH_REPAIR_TIMEOUT_MS
    let lastFailure: unknown = undefined
    for (;;) {
      try {
        await registry.list()
        // list() RESOLVED → the provider's durable state is now in memory:
        // create is idempotent again — but prefer the NON-MUTATING
        // resolveByPath first (an entity that already owns the canonical path
        // from an earlier boot or the GUI must NEVER be duplicated).
        break
      } catch (error) {
        // list() rejected → the registry is still initializing ("workspace
        // registry is not started yet") — sleep and retry.
        lastFailure = error
      }
      if (Date.now() >= deadline) {
        const detail = lastFailure instanceof Error ? lastFailure.message : String(lastFailure ?? 'workspace registry never became ready')
        ctx.logger.warn(`[deepartments] department workspace ensure timed out waiting for the workspace registry to become ready: ${detail} — the department's sessions keep cwd "${workspacePath}" but may not be grouped in the sidebar (retried ${HOST_ATTACH_REPAIR_TIMEOUT_MS}ms)`)
        return workspacePath
      }
      await new Promise((resolve) => setTimeout(resolve, HOST_ATTACH_REPAIR_RETRY_MS))
    }
    try {
      if (typeof registry.resolveByPath === 'function') {
        const existing = await registry.resolveByPath(workspacePath)
        if (existing !== undefined && typeof existing.path === 'string' && existing.path !== '') return existing.path
      }
      const entity = await registry.create(workspacePath, title)
      // Prefer the canonical path the SERVICE resolved (create realpath-
      // normalizes); the session cwd must equal it for the attach to match.
      if (entity !== undefined && typeof entity.path === 'string' && entity.path !== '') return entity.path
      return workspacePath
    } catch (error) {
      ctx.logger.warn(`[deepartments] department workspace create failed for "${workspacePath}" (${error instanceof Error ? error.message : String(error)}) — the department's sessions keep cwd "${workspacePath}" but the sidebar folder may not appear`)
      return workspacePath
    }
  }

  /** F5 (spec 004 §6.2 L1) — the department-aware CWD for a created head/worker
   * session: a department WITH a configured workspacePath ensures its workspace
   * (mkdir + registry ensure: resolveByPath-first, create only as the fallback
   * for an unowned path — title = dept name, set only on first create) and
   * returns the canonical workspace path (the department's own sidebar folder).
   * A department WITHOUT workspacePath returns `''` — the caller then falls back
   * to `resolveWorkspaceRootPath()` (the shared root, pre-F1 behavior, zero
   * regression). */
  const resolveDepartmentWorkspaceCwd = async (department: DepartmentConfig | undefined): Promise<string> => {
    const workspacePath = departmentWorkspacePath(department)
    if (workspacePath === '') return ''
    return ensureDepartmentWorkspace(workspacePath, department!.name || department!.id)
  }

  /** Piece 1 (2026-08-22) — the CANONICAL WORKSPACE ROOT PATH for created
   * head/worker sessions, replacing the legacy `repoRoot` hardcode. dsh-workspace
   * attaches a session to a workspace ONLY when its persisted header cwd equals
   * the entity's canonical path (dsh-workspace lib:98 — strict realpath
   * equality), and the native sidebar groups rows by workspace membership — so
   * a session created with `meta.cwd = repoRoot` matches NO workspace when the
   * GUI-created workspace root is elsewhere (production: workspace path
   * "/root", head cwd the repo) → the attach always throws → the session stays
   * INVISIBLE and every wake re-attach repeats the same failure
   * (explore-deep/2026-08-22-head-attach-cwd.md, fix (a)). Resolution order:
   *   1. the workspace entity whose `sessionIds` already contains the session
   *      id of a LIVE hosts.json host entry — the host session was created BY
   *      the GUI in a workspace, so its owning entity IS the canonical root
   *      (the entity path is exactly what the GUI uses as the host session's
   *      own cwd: `workspace.path`);
   *   2. `list()[0].path` — the registry's durable-first workspace, the same
   *      ordering attachHeadSession/repairHostWorkspaceAttach iterate;
   *   3. `repoRoot` — no registry or empty list (headless profiles): the
   *      legacy value, still a valid cwd.
   * Bounded wait with the SAME window as the boot-repair FIX 1b.1
   * (NON-STRICT `ctx.get('workspaceRegistry', false)` + retry 250ms ≤ 10s)
   * because at boot the provider may still be initializing and the strict get
   * races its state-2 init — but a composition with NO registry service at all
   * is a DEFINITIVE absence and falls back immediately. NEVER throws: a path
   * is ALWAYS returned (the repoRoot floor), so a head/worker create cannot
   * fail on workspace resolution.
   */
  const resolveWorkspaceRootPath = async (): Promise<string> => {
    const deadline = Date.now() + HOST_ATTACH_REPAIR_TIMEOUT_MS
    for (;;) {
      const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
      if (registry?.list === void 0) {
        // NO registry service in this composition (headless/minimal profile):
        // a DEFINITIVE absence — nothing can become available, so fall back to
        // the repoRoot floor immediately (never a head/worker create block).
        return repoRoot
      }
      try {
        const workspaceList = await registry.list()
        // 1. the entity whose membership already covers a live host session.
        const liveHostSessionIds = new Set<string>()
        for (const entry of hosts.values()) {
          if (entry.retired !== true) liveHostSessionIds.add(entry.sessionId)
        }
        for (const workspace of workspaceList) {
          const entity = workspace as WorkspaceEntityMembershipLike
          if (typeof entity.path !== 'string' || entity.path === '') continue
          if (entity.sessionIds !== void 0) {
            for (const sessionId of liveHostSessionIds) {
              if (entity.sessionIds.includes(sessionId)) return entity.path
            }
          }
        }
        // 2. the registry's durable-first workspace path — SKIPPING a
        // department's own workspace (F5, spec 004 §6.2 L1): the workspace
        // SERVICE prepends a newly created workspace to the registry order, so
        // a department workspace would otherwise become list()[0] and hijack
        // the shared-root resolution for a department WITHOUT workspacePath
        // (or a legacy head) in a host-less/headless profile. A department
        // workspace is never the shared root; fall through to the next one
        // (or the repoRoot floor when every workspace is a department's own).
        const departmentWorkspacePaths = new Set<string>()
        for (const department of org.departments) {
          const deptWs = departmentWorkspacePath(department)
          if (deptWs !== '') departmentWorkspacePaths.add(deptWs)
        }
        for (const workspace of workspaceList) {
          const path = (workspace as WorkspaceEntityMembershipLike).path
          if (typeof path === 'string' && path !== '' && !departmentWorkspacePaths.has(path)) return path
        }
        // 3. no workspace entities at all (or only department workspaces) —
        //    legacy repoRoot floor.
        return repoRoot
      } catch {
        // list() rejected → the registry is still initializing — retry.
      }
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, HOST_ATTACH_REPAIR_RETRY_MS))
    }
    // The bounded window elapsed without a resolved list: give up on the
    // registry and fall back to the repoRoot floor (a head/worker create must
    // never block on the optional workspace seam — the non-fatal discipline of
    // the attach hooks).
    return repoRoot
  }

  /** Piece 1 — durably attach a head/worker session to the workspace whose
   * path matches its persisted header cwd, so the session appears as a row in
   * the NATIVE sidebar (rows are grouped by workspace from workspace.json
   * sessionIds — a registered-but-unattached session is INVISIBLE there).
   * Reuses the canonical attach seam verbatim: `workspaceRegistry.list()` →
   * iterate the workspace entities → `attachSession` (dsh-workspace validates
   * cwd vs path and throws on mismatch, so mismatches fall through to the
   * next entity) — the same iterate-and-try pattern as the host boot-repair
   * hook above and the S2.2 rotation. Resolution follows the canonical
   * semantics: a missing/listing-failing registry, an EMPTY workspace list,
   * or an attach that no entity resolves is a DEFINITIVE (fatal-for-visibility)
   * failure → the legacy fallback of the boot-repair: log a WARN and give up
   * (the session stays invisible — a PERMANENT header-cwd mismatch is not
   * recovered by the wake re-attach; boot-fresh sessions now carry the
   * resolved workspace-root cwd, so they resolve by equality) —
   * a failed attach must NEVER break head materialization or a wake. Retries
   * are bounded with the SAME window as the boot-repair, because at boot
   * (ensureAllHeads) the workspaceRegistry provider may still be initializing
   * (FIX 1b.1: strict get races the provider's state-2 init). Idempotent:
   * re-attaching an already-attached session is a no-op for the real registry.
   */
  const attachHeadSession = async (sessionId: string, source: string): Promise<void> => {
    const deadline = Date.now() + HOST_ATTACH_REPAIR_TIMEOUT_MS
    let lastFailure: unknown = undefined
    for (;;) {
      const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
      if (registry?.list !== void 0) {
        try {
          const workspaceList = await registry.list()
          for (const workspace of workspaceList) {
            if (typeof workspace?.attachSession !== 'function') continue
            try {
              await workspace.attachSession(sessionId)
              ctx.logger.info(`[deepartments] head attach (${source}): attached ${sessionId}`)
              return
            } catch {
              // cwd mismatch / unvalidatable header / attach fault — try the next entity.
            }
          }
          // list() RESOLVED but no entity matched: a definitive (non-readiness)
          // failure — warn once and give up. A header cwd with no owning
          // workspace is PERMANENT (the wake re-attach only recovers the
          // boot-race, never a cwd mismatch).
          ctx.logger.warn(`[deepartments] head attach (${source}): no workspace matched session ${sessionId} — its header cwd has no owning workspace; the session stays invisible in the sidebar (a cwd mismatch is permanent — only a fresh create under the resolved workspace root fixes it)`)
          return
        } catch (error) {
          // list() rejected → the registry is still initializing — retry.
          lastFailure = error
        }
      }
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, HOST_ATTACH_REPAIR_RETRY_MS))
    }
    const detail = lastFailure instanceof Error ? lastFailure.message : String(lastFailure ?? 'registry impl never became available')
    ctx.logger.warn(`[deepartments] head attach (${source}) failed: ${detail} — the session stays invisible in the sidebar (retried ${HOST_ATTACH_REPAIR_TIMEOUT_MS}ms)`)
  }

  /** THE VISIBILITY FIX SEAM (2026-08-25 P2) — archive-leak rotation id
   * (HEAD-only). A head's durable session id in the workspace registry's
   * `archivedSessionIds` must NEVER be RESUMED: the GUI sidebar hides any
   * session whose id is archived (`dsh-client-ui-workspace` sessionVisible —
   * `!archived.has(id)`, client.js:100-101), so re-seeding a live head on an
   * archived id makes it live-but-invisible (the reported P2). Returns a FRESH
   * `head-<postId>-<uuid>` id when the durable id is archived (the F8 fresh-mint
   * shape materializePost uses for a slept head), or `undefined` when it is NOT
   * archived — the caller then proceeds with its NORMAL resume (zero regression).
   * A WORKER's resume is untouched (the caller invokes this only for a head,
   * provider !== 'worker'); the archive-leak is head-specific. */
  const rotateArchivedHeadSessionId = async (postId: string, sessionId: string): Promise<string | undefined> => {
    const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
    if (!isArchivedSession(registry, sessionId)) return undefined
    const fresh = String(SessionId(`${HEAD_SESSION_PREFIX}${postId}-${randomUUID()}`))
    ctx.logger.warn(`[deepartments] head "${postId}" durable session ${sessionId} is ARCHIVED — rotating to fresh ${fresh} instead of resuming the archived id (a live head's session is never archived)`)
    return fresh
  }

  /** Ensure ONE configured head is materialized as a live root agent.
   * Idempotent: live → reuse (record the handle if create/resume just ran);
   * durable session in the registry → resume; else → create. Mirrors the
   * restartable create/resume fallback, tolerating a resume that fails because
   * no durable session exists yet (then create). Always (re)records the
   * registry entry keyed by the stable session id. Piece 1: every branch also
   * fire-and-forgets the workspace attach + the session title pin (sidebar). */
  const ensureHead = async (department: DepartmentConfig, roomId: string): Promise<void> => {
    const coordinator = department.coordinator
    if (coordinator === void 0) return
    const postId = coordinator.postId
    // F8 (spec 002 head rotation) — a SLEPT head is DORMANT: its durable session
    // was ARCHIVED at dept_sleep, so materializing it at boot (resume the same
    // id) would revive the old artifact instead of the fresh rotation. Leave it
    // dormant until its next bus wake (materializePost mints a fresh session).
    // The journal + messages stay intact; the head simply is not live until
    // addressed. A never-slept head (no sleepEpoch) is unaffected.
    const durableEntry = byPost.get(postId)
    if (durableEntry?.sleepEpoch !== void 0) return
    // Batch 4a: the head uses its PER-HEAD preset (deepartments-head-<departmentId>)
    // so the session is NATIVE/openable and labeled with its head preset.
    const presetId = headPresetIdFor(department.id)
    // F8 rotation: track the ENTRY's session id (a head that was rotated to a
    // fresh session at its last wake carries that id here) — fall back to the
    // deterministic `head-<postId>` derivation ONLY when there is no durable
    // entry yet (first boot / fresh department).
    // `let` (not `const`): the archive-leak rotation below REPLACES a durable
    // head session id that the workspace registry has archived, and the attach/
    // title-pin tail must target the ROTATED (fresh) session id.
    let sessionId = SessionId(durableEntry?.sessionId ?? headSessionId(postId))
    if (agents === void 0) return
    // F5 (spec 004 §6.2 L1): a department WITH a configured workspacePath owns a
    // REAL sidebar folder — ensure the workspace (mkdir + registry ensure — the
    // race-fixed resolveByPath-first/create-fallback discipline, title=dept
    // name, set only on first create) and carry the canonical path as the cwd
    // for the fresh-create branches. A department WITHOUT workspacePath returns
    // '' (the shared workspace root via resolveWorkspaceRootPath — pre-F1). The
    // ensure runs on EVERY ensureHead (even when the head session is reused/
    // resumed) so the department folder exists for its workers' spawns.
    const departmentCwd = await resolveDepartmentWorkspaceCwd(department)
    let handle: AgentHandleLike | undefined
    const live = agents.get(String(sessionId))
    if (live !== void 0) {
      // Already live: reuse; record the registry entry (a head may be present
      // live without a registry entry if the harness pre-created it).
      const existing = byPost.get(postId)
      if (existing === void 0) {
        registerEntry(makeEntry(department, roomId, String(sessionId)))
      }
    } else {
      const coordinatorRole = coordinator.role || postId
      const setup = headSetup(postId, roomId, coordinatorRole, presetId, department)
      const agentOptions = coordinator.agentOptions
      const durableSession = durableEntry !== void 0
      if (durableSession) {
        // THE VISIBILITY FIX (2026-08-25 P2): a durable head session id in the
        // workspace registry's archived set must NEVER be RESUMED — a live head's
        // session is never archived, because the GUI sidebar hides any archived
        // session id. The re-seed resume of an archived id is the root cause of
        // the live-but-invisible head. Treat it like a slept head: rotate to a
        // FRESH id (the F8 fresh-mint shape) and CREATE, never resume. A
        // NON-archived head resume is byte-identical (zero regression); a
        // WORKER's resume never reaches here (worker resume is its own lifecycle).
        const rotatedSessionId = await rotateArchivedHeadSessionId(postId, String(sessionId))
        if (rotatedSessionId !== void 0) {
          sessionId = SessionId(rotatedSessionId)
          handle = await agents.create({
            sessionId: rotatedSessionId,
            meta: { cwd: departmentCwd !== '' ? departmentCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: presetId },
            agentOptions,
            setup
          })
          registerEntry(makeEntry(department, roomId, rotatedSessionId))
        } else {
          try {
            handle = await agents.resume({ resumeSessionId: String(sessionId), agentOptions, setup })
            registerEntry(makeEntry(department, roomId, String(sessionId)))
          } catch (error: unknown) {
            // Resume failed (e.g. no durable session in the persistence store after
            // a stateDir wipe): fall back to creating a fresh session.
            ctx.logger.warn(`[deepartments] head "${postId}" resume failed, creating fresh: ${error instanceof Error ? error.message : String(error)}`)
            handle = await agents.create({
              sessionId: String(sessionId),
              meta: { cwd: departmentCwd !== '' ? departmentCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: presetId },
              agentOptions,
              setup
            })
            registerEntry(makeEntry(department, roomId, String(sessionId)))
          }
        }
      } else {
        handle = await agents.create({
          sessionId: String(sessionId),
          meta: { cwd: departmentCwd !== '' ? departmentCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: presetId },
          agentOptions,
          setup
        })
        registerEntry(makeEntry(department, roomId, String(sessionId)))
      }
      if (handle !== void 0) byHeadHandle.set(String(sessionId), handle)
    }
    // Piece 1 — native sidebar: every branch (fresh create, resume, live-reuse)
    // fire-and-forgets the workspace attach (idempotent, never fatal) and pins
    // the head sidebar title on its LIVE session via the U4-generalized helper
    // (store-first, exactly like the host path — a root agent's session IS
    // entered in ctx.sessions while it lives). The owner's manual rename
    // (source.user) always wins; a session already holding the pin is never
    // double-pinned; a failed pin/attach only logs (head registration stands).
    void attachHeadSession(String(sessionId), 'ensureHead')
    const titleSession = ctx.sessions.get(sessionId)
    if (titleSession !== void 0) {
      const title = coordinator.sessionTitle || HEAD_DEFAULT_SESSION_TITLE
      const titlePin = pinSessionTitle(titleSession, title)
      if (titlePin === 'pinned') {
        ctx.logger.info(`[deepartments] ensureHead: pinned head session title "${title}" (${sessionId})`)
      } else if (titlePin === 'failed') {
        ctx.logger.warn(`[deepartments] ensureHead: head session title pin failed for ${sessionId} (non-fatal — head registration continues)`)
      }
    }
  }

  /** Build a PostEntry for a configured head (root-agent shape, Batch 1b). The
   * durable `agentPreset` is the PER-HEAD preset (Batch 4a) so a restart resumes
   * the head under the same per-head composition it was created with. */
  const makeEntry = (department: DepartmentConfig, roomId: string, sessionId: string): PostEntry => ({
    postId: department.coordinator!.postId,
    sessionId,
    roomId,
    agentPreset: headPresetIdFor(department.id)
  })

  /** Ensure EVERY configured department head is a live root agent (boot, after
   * the registries load; also safe to re-run — idempotent per head). */
  const ensureAllHeads = async (): Promise<void> => {
    if (agents === void 0) return
    // The generic head preset (template + fallback), the disposable-worker
    // preset, AND every PER-HEAD preset are materialized into the harness-home
    // user root. We re-read the agentPresets service HERE (not the apply-time
    // capture) because materialization runs asynchronously after the registries
    // load — by then the roster is composed, so this is deterministic regardless
    // of Loader ordering of the (optional) agentPresets service. Hermetic
    // compositions that never resolve presets write nothing outside the stateDir.
    const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
    if (presets !== void 0) {
      await materializePreset(PRESET_ID)
      await materializePreset(WORKER_PRESET_ID)
      for (const department of org.departments) {
        await materializeHeadPreset(department)
      }
    }
    // CRITICAL (Batch 3a guarantee): ensureAllHeads ONLY ever iterates the
    // CONFIGURED departments' coordinators (`org.departments`). Workers
    // are created at RUNTIME by dept_post_create and are NEVER present in this
    // config — so a retired worker (whose registry entry was removed) is never
    // re-materialized by a later boot. The "retired worker stays retired"
    // invariant holds structurally.
    for (const department of org.departments) {
      const coordinator = department.coordinator
      if (coordinator === void 0) continue
      // B3: the department config no longer carries a roomId (spec 003 §7 —
      // the room concept is gone); the registry `roomId` field is INERT for
      // schema stability, so keep the legacy 'board' value (the same inert
      // value ensureHost writes for hosts).
      await ensureHead(department, 'board')
    }
  }

  /** Fix A2 — the observable progress signature of a live head: the length of
   * its durable session event log. Every appended step/turn/assistant event is
   * lifecycle progress. Absent/session-less agents yield 0 (no progress signal
   * → never judged stuck on the basis of this). */
  const headEventCount = (live: AgentLike): number =>
    live.session === undefined ? 0 : (live.session.events?.length ?? 0)

  /** Fix A2 — record that we just observed `live` making progress: stamp `at`
   * and snapshot the current event watermark. Call whenever a wake successfully
   * reaches a functioning head (live followup, cold resume) so the next stuck
   * check starts from a fresh baseline and a healthy busy head is never misjudged. */
  const markHeadProgress = (sessionId: string, live: AgentLike): void => {
    headProgress.set(sessionId, { at: stuckNow(), eventCount: headEventCount(live) })
  }

  /** Fix A2 — is `live` a wedged resident head? True ONLY when it is status
   * 'running' (a phase is actually underway) AND its session event log has not
   * grown since the last observation AND that stall exceeds STUCK_HEAD_MS. An
   * idle head is always followup-able (a wake starts a fresh turn), and a head
   * whose event log is growing is progressing normally — neither is stuck. */
  const isHeadStuck = (sessionId: string, live: AgentLike): boolean => {
    if (live.status !== 'running') return false
    const prior = headProgress.get(sessionId)
    if (prior === void 0) {
      // First observation of a running head: record the baseline, do not judge
      // it stuck yet (a healthy turn needs time to produce its first event).
      markHeadProgress(sessionId, live)
      return false
    }
    if (headEventCount(live) > prior.eventCount) {
      markHeadProgress(sessionId, live)
      return false
    }
    return stuckNow() - prior.at > STUCK_HEAD_MS
  }

  /** W8-c PART 3 — boot PRESET AUDIT. After the configured heads are materialized
   * (and on every boot), scan the preset/persona text the plugin reads (COMMENTS
   * INCLUDED) for any UNBOUND double-brace template reference (a reference to a
   * variable that is NOT one of the KNOWN-BOUND persona vars cwd/headPostId/
   * workspacePath/reportDir/deptName). On an unbound reference, record a
   * CONFIG-HEALTH post-error-marker (`config-presets.jsonl`) that the health
   * daemon turns into a 'config-preset' ALERT to the host (deduped per
   * 'config-preset' per 30min). NEVER mutates a preset file — the audit is
   * read-only and writes only its own stateDir marker. Gated by
   * `health.presetAuditEnabled` (default on). Non-fatal (a read failure skips
   * that source). */
  const runPresetAudit = async (): Promise<void> => {
    if (config.health?.presetAuditEnabled === false) return
    const sources: { name: string; text: string }[] = []
    // The head + disposable-worker base presets (the preset text the plugin
    // materializes into the harness home's .agent-presets/).
    for (const presetId of [PRESET_ID, WORKER_PRESET_ID]) {
      try {
        sources.push({ name: `${presetId}/agent.cordis.yml`, text: await readFile(path.join(repoRoot, 'presets', presetId, 'agent.cordis.yml'), 'utf8') })
      } catch {
        /* source absent → skip (never a boot failure) */
      }
    }
    // Each department's ARCHITECTURE.md (the raw text, comments included, BEFORE
    // templating — so an unbound reference in any comment/style is caught).
    for (const department of org.departments) {
      const archPath = path.join(repoRoot, 'presets', 'departments', department.id, 'ARCHITECTURE.md')
      try {
        sources.push({ name: `departments/${department.id}/ARCHITECTURE.md`, text: await readFile(archPath, 'utf8') })
      } catch {
        /* no architecture file → skip */
      }
    }
    // The host preset ('deepartments') is OWNED by the GUI profile, not this repo;
    // scan its harness-home .agent-presets copy when present (it is not — this
    // repo defines no host preset — so the source is skipped cleanly).
    try {
      const hostPresetDir = path.join(dshHome(), '.agent-presets', 'deepartments')
      for (const file of ['agent.cordis.yml', 'preset.yml']) {
        sources.push({ name: `deepartments/${file}`, text: await readFile(path.join(hostPresetDir, file), 'utf8') })
      }
    } catch {
      /* host preset absent → skip */
    }
    const bad: { preset: string; unbound: string[] }[] = []
    for (const source of sources) {
      const unbound = auditPresetText(source.text)
      if (unbound.length > 0) bad.push({ preset: source.name, unbound })
    }
    if (bad.length === 0) return
    for (const finding of bad) {
      await appendConfigPresetMarker(stateDir, { ts: Date.now(), preset: finding.preset, unbound: finding.unbound })
    }
    try {
      ctx.logger.warn(`[deepartments] preset-audit: unbound template reference(s) in preset text: ${bad.map((b) => `${b.preset} (${b.unbound.join(', ')})`).join('; ')}`)
    } catch {
      /* a post-dispose logger warn must not surface as an unhandled rejection */
    }
  }

  /** W8-h boot INTERRUPTED-POST RECONCILIATION (owner-required 2026-08-24: the
   * DSH restart notice only lists the MAIN session; department posts interrupted
   * mid-turn are NOT reported to the Asistente — they must surface automatically,
   * never silently). After the post registry loads, reconcile EACH registered
   * post against its session's INTERRUPTED (open/stopped) turn and record it
   * into post-errors.jsonl (error class 'interrupted-post') so the W6 health
   * daemon ALERTS the host. Reads the DURABLE session for each post (a resumed
   * head's durable log carries the reload-repair marker; a NOT-resumed worker is
   * judged against its on-disk crash tail). Bounded by the previous boot's last
   * heartbeat ts (the restart timestamp window) when the heartbeat file exists;
   * deduped per post per 30min (health-alerts-state.json, key
   * 'interrupted-post:<postId>'). Gated by `health.enabled` (the whole health
   * daemon OFF → no reconcile; the W6 alert path would never fire). Non-fatal. */
  const runInterruptedPostReconciliation = async (): Promise<void> => {
    if (config.health?.enabled === false) return
    try {
      const persistence = ctx.get('sessionPersistence') as { readRaw?: (id: SessionId, signal?: AbortSignal) => Promise<{ content: string } | undefined> } | undefined
      // The previous boot's last heartbeat ts — the restart-window lower bound.
      // The CURRENT daemon has not ticked yet at reconciliation time, so
      // health-heartbeat.json still holds the PREVIOUS process's last tick.
      const prevHeartbeat = readHealthHeartbeatFile(stateDir)
      const postEvents: InterruptedPostInput[] = []
      for (const [postId, entry] of byPost) {
        if (entry.retired === true) continue
        let events: HealthSessionEvent[] = []
        // W8-h: a LIVE-RUNNING post (a phase is actually underway) is healthy
        // progress, never a stop — do NOT flag it (mirrors the heartbeat's
        // live-running exclusion, so a post that recovered and is actively
        // working after a restart is never a false positive). A genuinely
        // stopped post's agent is NOT 'running', so no real interruption is
        // masked.
        const live = agents?.get(SessionId(entry.sessionId))
        if (live !== undefined && live.status === 'running') continue
        // Prefer the LIVE agent's in-memory log (reflects the repaired/reloaded
        // session after a resume), else the DURABLE persistence readRaw (the true
        // on-disk crash tail for a NOT-resumed post).
        if (live?.session?.events?.length) {
          events = live.session.events as HealthSessionEvent[]
        } else if (persistence !== undefined && typeof persistence.readRaw === 'function') {
          try {
            const raw = await persistence.readRaw(SessionId(entry.sessionId))
            events = (raw?.content ?? '').split('\n').flatMap((line) => {
              if (line.trim() === '') return []
              try {
                const ev = JSON.parse(line) as { type?: unknown; time?: unknown; data?: unknown }
                if (ev !== null && typeof ev === 'object' && typeof ev.type === 'string' && typeof ev.time === 'number') {
                  return [{ type: ev.type, time: ev.time, data: ev.data }]
                }
              } catch { /* skip a malformed line */ }
              return []
            })
          } catch { /* durable read failed → events stays [] (degrades, never fatal) */ }
        }
        postEvents.push({ postId, sessionId: entry.sessionId, retired: false, events })
      }
      const result = await reconcileInterruptedPosts({
        now: () => Date.now(),
        stateDir: stateDir,
        postEvents,
        restartAfterTs: prevHeartbeat?.ts
      })
      if (result.interrupted.length > 0 || result.appended > 0) {
        ctx.logger.info(`[deepartments] interrupted-post reconciliation: ${result.interrupted.length} interrupted post(s), ${result.appended} appended to post-errors.jsonl`)
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] interrupted-post reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** FIX-2 (QD NO_ADAPTER alerting) — a BOOT provider-adapter-registration check
   * that fires a finding INDEPENDENT of any spawned agent (the QH acceptance "a
   * boot check that fires a finding independent of any spawned agent" / the
   * "from the break" trigger). It queries the LLM adapter registry
   * (`ctx.get('llm').listProviders()`), compares the configured provider route(s)
   * (the worker/head route pinned 'opencode-zen' in WORKER_AGENT_OPTIONS /
   * HOST_AGENT_OPTIONS + each coordinator) to the registry, AND (best-effort)
   * reads the pi-ai provider endpoint surface (llm-pi-ai.providers.<provider>
   * .baseURL / .maxRetries) to flag a drift (a local/proxy baseURL or a
   * `maxRetries: 0` profile — the QD config-hygiene signal). On a missing or
   * drifted provider it appends a post-error row so the health daemon ALERTS the
   * host EVEN WITH NO AGENT SPAWNED. Read-only + never-throws; a headless/minimal
   * profile with no `llm` service is skipped with a warn. Gated on
   * `health.enabled` (the WHOLE health daemon OFF → no alert path → skip).
   *
   * RACE-TOLERANT (the fix-2 false positive): the check is fired in the boot
   * `.then` block (microseconds after plugin boot) but `ctx.llm.registerAdapter`
   * (the dsh-llm-pi-ai apply) is ASYNC — so the naive FIRST read of
   * `listProviders()` can run BEFORE the adapter registers and FALSE-POSITIVE on
   * a healthy-but-still-registering boot. Instead of alerting immediately on a
   * missing/drifted provider, it polls within a BOUNDED window
   * (`health.providerAdapterRetryWindowMs` / `health.providerAdapterRetryMs`, default
   * `PROVIDER_ADAPTER_RETRY_WINDOW_MS`, mirroring the `HOST_ATTACH_REPAIR_*`
   * bounded-retry discipline): each poll re-reads `listProviders()` and re-reads
   * the settings surface. A provider that REGISTERS (or a drift that resolves)
   * WITHIN the window is a DELAYED-but-healthy boot → suppressed (NO alert). Only
   * a finding STILL PRESENT AFTER the window elapses is a GENUINE outage → the
   * HARD NO_ADAPTER/endpoint alert is appended. Never throws. */
  const runProviderAdapterBootCheck = async (): Promise<void> => {
    if (config.health?.enabled === false) return
    try {
      const llm = ctx.get('llm', false) as { listProviders?: () => Array<{ id: string; name: string }> } | undefined
      if (llm === undefined || typeof llm.listProviders !== 'function') {
        ctx.logger.warn('[deepartments] provider-adapter boot check skipped — the "llm" service is absent (headless/minimal profile)')
        return
      }
      const configuredProviders = new Set<string>()
      if (WORKER_AGENT_OPTIONS.provider) configuredProviders.add(WORKER_AGENT_OPTIONS.provider)
      if (HOST_AGENT_OPTIONS.provider) configuredProviders.add(HOST_AGENT_OPTIONS.provider)
      for (const department of org.departments ?? []) {
        const c = department.coordinator
        if (c?.agentOptions?.provider) configuredProviders.add(c.agentOptions.provider)
        else if (c?.provider) configuredProviders.add(c.provider)
      }
      const configuredProviderList = [...configuredProviders]
      if (configuredProviderList.length === 0) return

      // Bounded retry window (mirrors the HOST_ATTACH_REPAIR_* discipline): the
      // configured provider(s) may legitimately still be REGISTERING (the async
      // ctx.llm.registerAdapter) at the moment this boot check first runs — the
      // exact race that fired the false positive. Poll until the window elapses;
      // suppress a DELAYED registration, alert on a NEVER-registered provider.
      const retryHealthCfg = (config.health ?? {}) as unknown as {
        providerAdapterRetryWindowMs?: number
        providerAdapterRetryMs?: number
      }
      const retryWindowMs = typeof retryHealthCfg.providerAdapterRetryWindowMs === 'number' && retryHealthCfg.providerAdapterRetryWindowMs > 0
        ? retryHealthCfg.providerAdapterRetryWindowMs
        : PROVIDER_ADAPTER_RETRY_WINDOW_MS
      const retryMs = typeof retryHealthCfg.providerAdapterRetryMs === 'number' && retryHealthCfg.providerAdapterRetryMs > 0
        ? retryHealthCfg.providerAdapterRetryMs
        : PROVIDER_ADAPTER_RETRY_MS
      const deadline = Date.now() + retryWindowMs
      for (;;) {
        // Re-read BOTH the registry and the settings surface on every poll so a
        // transient registration/settings-loading race cannot false-alert.
        const registeredProviders = (llm.listProviders() ?? [])
        const providerSettings = readLlmPiAiProviderSettings(stateDir)
        const findings = resolveProviderAdapterBootFindings({
          configuredProviders: configuredProviderList,
          registeredProviders,
          providerSettings,
          poolerBaseURL: org.poolerBaseURL
        })
        // Provider registered (or the drift resolved) WITHIN the window → this is a
        // healthy-but-slow boot → NO finding, no alert.
        if (findings.length === 0) return
        if (Date.now() >= deadline) {
          // STILL missing/drifted AFTER the window elapses → a GENUINE outage →
          // the HARD NO_ADAPTER/endpoint alert (the ~49-min outage case).
          for (const finding of findings) {
            await appendPostError(stateDir, { ts: Date.now(), postId: finding.postId, error: finding.error })
          }
          ctx.logger.warn(`[deepartments] provider-adapter boot check: ${findings.length} finding(s) → ${findings.map((f) => f.error).join('; ')}`)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs))
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] provider-adapter boot check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** fb-9 boot-assert (LIGHT, non-fatal — drift detection even when nobody
   * dispatches): at boot, pre-flight the ACTIVE worker route
   * (WORKER_AGENT_OPTIONS.provider) against the stateDir settings.yaml. A
   * provider profile with reasoning enabled that lacks
   * compat.requiresReasoningContentOnAssistantMessages=true (the schema-correct
   * nested path — a provider-level flag is dead and is detected as missing)
   * → a warn + ONE drift
   * post-error row (the synthetic REASONING_CONTENT_PREFLIGHT_POST_ID post —
   * the W6 daemon surfaces it as a post-error finding, so the drift is visible
   * from the break, no spawn needed). Never throws; an absent/unreadable
   * settings.yaml or a healthy profile → silent no-op. The DISPATCH guard
   * itself (spawnWorkerForDepartment/runJobForDepartment) is the hard stop;
   * this is only the early visibility. */
  const runReasoningContentBootAssert = async (): Promise<void> => {
    try {
      const provider = WORKER_AGENT_OPTIONS.provider
      if (typeof provider !== 'string' || provider === '') return
      const settings = readLlmPiAiProviderSettings(stateDir)
      const verdict = resolveReasoningContentPreflight(provider, settings, stateDir)
      if (verdict.ok) return
      ctx.logger.warn(`[deepartments] ${verdict.reason} (boot drift — DISPATCH rejects until the flag is set; non-fatal)`)
      await appendPostError(stateDir, { ts: Date.now(), postId: REASONING_CONTENT_PREFLIGHT_POST_ID, error: verdict.reason })
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] reasoning-content boot assert failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** m-119 — DURABLE host/post registry VALIDATION at boot. After both
   * registries cold-load, VALIDATE the durable hosts.json invariant and the
   * durable posts.json retire-leak class and WARN on any degenerate state
   * (warn-on-degenerate, idempotent, non-throwing) so the durable registry
   * converges to the live reality WITHOUT manual intervention. The Boot hook is
   * deliberately READ-ONLY: it never auto-retires/rewrites a legitimate
   * multi-host or multi-live state (a fleet of dormant hosts, or a rotation in
   * progress, must stay resumable — see the VARIANT-2 dormant-host resume
   * regression). The WRITE repair is exposed on the exported helpers as an
   * explicit `write` / `retireGoneWorkers` opt-in (unit-tested) and is safe to
   * run when a degenerate state is confirmed. The Bug A durable-gate +
   * alert-recipient behavior (already correct) is unchanged. */
  const runDurableRegistryReconciliation = async (): Promise<void> => {
    try {
      // (1) durable HOSTS registry — validate + warn (read-only; no auto-write).
      await reconcileDurableHostRegistry(stateDir, { logger: ctx.logger, write: false })
      // (2) durable POSTS registry — flag + warn a gone WORKER session
      // (retire-if-safe is an explicit opt-in; a configured head is never
      // flagged). The session-gone resolver is CONSERVATIVE: only a positively
      // confirmed absent durable session counts as gone (unable to determine →
      // NOT gone → never flagged).
      const persistence = ctx.get('sessionPersistence') as { readRaw?: (id: SessionId, signal?: AbortSignal) => Promise<{ content: string } | undefined> } | undefined
      // A3/C2 — the durable posts.json RETIRED-entry retention policy knob.
      // Read SHARED-first from the resolved `org` binding (coreOrg?.org ?? cfg.org
      // — see :4222), NOT from the bundle row's own `config.org` (the FASE 2.6
      // MIRROR, which does NOT carry the relocated org values; the dshd-core row
      // is the SHARED CONFIG SOURCE and is where the knob actually lives). This
      // mirrors the shared-first consumption pattern of every other
      // deepartments.org consumer (e.g. :4213-4222). Only wired when the section
      // is present; an ABSENT section falls through to the code defaults in the
      // registrar, which are CONSERVATIVE: retired-entry pruning is OFF by
      // default and is enabled ONLY by an explicit
      // `org.postsRetention.enabled: true`. The shared-surface value is read via
      // an explicit typed cast for clarity; the dshd-core `OrgConfig` NOW
      // declares postsRetention (FASE 2.6 shared source devexpone postsRetention)
      // and the bundle's `Config['org']` (which `org` is typed as) exposes it
      // too, so the in-bundle fallback (`cfg.org`) stays behavior-neutral (same
      // nested config when dshd-core is not composed).
      const postsRetention = (org as { postsRetention?: PostsRetentionConfig }).postsRetention
      const reconcilePosts = await reconcileDurablePostsRegistry(stateDir, {
        logger: ctx.logger,
        retireGoneWorkers: false,
        ...(postsRetention !== void 0
          ? {
              retiredKeep: postsRetention.maxRetiredKept,
              retiredArchiveFile: postsRetention.archiveFile,
              enableRetiredPrune: postsRetention.enabled
            }
          : {}),
        isSessionGone: async (sessionId: string): Promise<boolean> => {
          if (persistence === undefined || typeof persistence.readRaw !== 'function') return false
          try {
            const raw = await persistence.readRaw(SessionId(sessionId))
            return raw === undefined
          } catch {
            return false
          }
        },
        // B5 — the conservative unusability classifier: ONLY a worker whose
        // materialization threw the "has no provider/model" error (recorded in
        // the durable unusable-agent-options.json marker) counts as unusable,
        // AND only when the marker's session id matches the CURRENT durable
        // session id (a worker that later got a fresh session is never
        // over-retired). Never throws — a marker read failure degrades to false.
        isSessionUnusable: async (sessionId: string, postId: string): Promise<boolean> => {
          const marks = readUnusableSessionsMark(stateDir)
          const mark = marks[postId]
          return mark !== undefined && mark.sessionId === sessionId
        }
      })
      // C2 partial-prune FIX: `reconcileDurablePostsRegistry` is FILE-based —
      // it rewrites posts.json (the pruned set) but does NOT touch the
      // in-memory catalog, which `loadPosts` populated with the FULL pre-prune
      // set. Without an in-memory sync, ANY later `persistPosts()` (a
      // registerEntry / markPostRetired / ensureHost) writes the FULL set back
      // to posts.json — undoing the prune (posts.json reverts to the pre-prune
      // count moments after the reconcile). Synchronize the catalog to the
      // PRUNED set so the next persist writes the pruned entries. This only
      // drops the OLDEST retired posts beyond `retiredKeep` — already archived
      // + backed up, never a live roster/wake target (R6 intact; the archive
      // and the pre-prune backup are NOT touched).
      if (reconcilePosts.prunedPostIds.length > 0) {
        const removed = registry.removePosts(reconcilePosts.prunedPostIds)
        ctx.logger.info(`[deepartments] durable-registry reconcile: dropped ${removed} pruned retired post(s) from the in-memory catalog to keep it consistent with the pruned posts.json (a later persist now writes the pruned set, not the full set)`)
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] durable-registry validation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** B5-GHOST (QH — dispatch-hardening, the AFTER half of the «429-primer-call»
   * class; 2026-08-28): the boot pass that classifies a catalog-LIVE post
   * WITHOUT a usable session (offline/muerto — e.g. the explore-deep-9 class: a
   * worker that burned its first call and whose session died with it) as a
   * RETIRE-CANDIDATE via the CENSUS LEDGER heuristic — NEVER on the first
   * observation (false-positive risk: a live post "solo entre
   * materializaciones" has a resumable durable session and is NOT a ghost).
   * Each BOOT is ONE census tick:
   *   - a post whose session is usable NOW (live in the agents registry, OR a
   *     durable session present AND not B5-unusable) is CLEARED — the ledger
   *     entry drops, the consecutive-miss chain breaks (an INTERMITTENT
   *     session never accumulates → never retired);
   *   - a post WITHOUT a usable session accumulates `misses`; after
   *     `org.ghostSuspect.warnAfterTicks` (default 2) CONSECUTIVE misses the
   *     `ghost-suspect` MARKER appears (WARN — the post is a retire-candidate,
   *     still NOT auto-retired: the first observations could be transients);
   *   - the AUTO-RETIRE fires ONLY when the marker persists > M ticks
   *     (`org.ghostSuspect.retireAfterTicks`, default 8 — conservative)
   *     — the retire-candidate class of the triage (explore-deep-9) is covered
   *     with ZERO false positives.
   * The ledger is durable (`<stateDir>/ghost-suspect-state.json`). NEVER
   * throws / never touches a configured head (only `provider:'worker'` posts) /
   * `org.ghostSuspect.enabled === false` → the pass is skipped (pre-b5-ghost
   * behavior). This is NOT the existing done-gone reconcile: it is a SEPARATE
   * pass with the marker heuristics, so the durable-registry reconcile's
   * conservative flag/warn-only semantics stay UNCHANGED. */
  const GHOST_SUSPECT_DEFAULT_WARN_TICKS = 2
  const GHOST_SUSPECT_DEFAULT_RETIRE_TICKS = 8
  const runGhostSuspectReconcile = async (): Promise<void> => {
    try {
      const ghostSuspectConfig = (org as { ghostSuspect?: { enabled?: boolean; warnAfterTicks?: number; retireAfterTicks?: number } }).ghostSuspect
      if (ghostSuspectConfig?.enabled === false) return
      const warnAfterTicks = ghostSuspectConfig?.warnAfterTicks !== undefined && Number.isFinite(ghostSuspectConfig.warnAfterTicks) && ghostSuspectConfig.warnAfterTicks > 0
        ? Math.trunc(ghostSuspectConfig.warnAfterTicks)
        : GHOST_SUSPECT_DEFAULT_WARN_TICKS
      const retireAfterTicks = ghostSuspectConfig?.retireAfterTicks !== undefined && Number.isFinite(ghostSuspectConfig.retireAfterTicks) && ghostSuspectConfig.retireAfterTicks > 0
        ? Math.trunc(ghostSuspectConfig.retireAfterTicks)
        : GHOST_SUSPECT_DEFAULT_RETIRE_TICKS
      const persistence = ctx.get('sessionPersistence') as { readRaw?: (id: SessionId, signal?: AbortSignal) => Promise<{ content: string } | undefined> } | undefined
      // The conservative session-presence resolver: ONLY a positively confirmed
      // absent durable session (readRaw → undefined) counts as lacking a
      // resumable session; unable-to-determine → present (usable).
      const durableSessionPresent = async (sessionId: string): Promise<boolean> => {
        if (persistence === undefined || typeof persistence.readRaw !== 'function') return true
        try {
          return (await persistence.readRaw(SessionId(sessionId))) !== undefined
        } catch {
          return true
        }
      }
      // The B5 VARIANT-2 ghost (a durable session present but with NO usable
      // AgentOptions — the builder-87 class): the unusable-options marker with
      // a session id matching the CURRENT durable session id.
      const isB5Unusable = (sessionId: string, postId: string): boolean => {
        const marks = readUnusableSessionsMark(stateDir)
        const mark = marks[postId]
        return mark !== undefined && mark.sessionId === sessionId
      }
      const previous = readGhostSuspectLedger(stateDir)
      const rows: Array<{ postId: string; sessionId: string; usable: boolean }> = []
      for (const [postId, entry] of byPost) {
        if (entry.provider !== 'worker' || entry.retired === true) continue
        const liveNow = agents !== void 0 && agents.get(String(SessionId(entry.sessionId))) !== undefined
        const durablePresent = await durableSessionPresent(entry.sessionId)
        const unusable = isB5Unusable(entry.sessionId, postId)
        rows.push({ postId, sessionId: entry.sessionId, usable: liveNow || (durablePresent && !unusable) })
      }
      const nowMs = Date.now()
      const verdict = stepGhostSuspectCensus(rows, previous, nowMs, { warnAfterTicks, retireAfterTicks })
      // WARN per newly-marked ghost-suspect (retire-candidate, NOT auto-retired
      // yet — the marker must persist > M ticks first).
      for (const postId of verdict.newlyMarked) {
        const entry = byPost.get(postId)
        ctx.logger.warn(`[deepartments] b5-ghost: post "${postId}" (${entry?.provider ?? 'worker'}) has had NO usable session for ${warnAfterTicks} consecutive census ticks — marked ghost-suspect; NOT auto-retired yet (conservative); will auto-retire after ${retireAfterTicks} more census ticks without a usable session`)
      }
      // AUTO-RETIRE the markers that persisted > N + M ticks — the ONLY
      // auto-retire branch of the heuristic. The caller id is the post's
      // manager head session (retirePost's "only my workers" scope passes: the
      // manager IS the worker's head), or a synthetic non-post id when the
      // manager is gone (a host-like caller — the retire is a system action).
      for (const postId of verdict.retireCandidates) {
        const entry = byPost.get(postId)
        if (entry === void 0 || entry.retired === true || entry.provider !== 'worker') continue
        try {
          await retirePost(postId, entry.managerId !== void 0 ? byPost.get(entry.managerId)?.sessionId ?? 'deepartments-b5-ghost' : 'deepartments-b5-ghost')
          ctx.logger.warn(`[deepartments] b5-ghost: auto-retired worker "${postId}" (ghost-suspect marker persisted > ${warnAfterTicks + retireAfterTicks} census ticks without a usable session)`)
          // The retired ghost's ledger entry is PRUNED from the NEXT ledger
          // (a retired post is no longer a census subject — the entry must not
          // linger for a future boot to re-read).
          delete verdict.ledger[postId]
        } catch (retireError: unknown) {
          ctx.logger.warn(`[deepartments] b5-ghost: auto-retire of "${postId}" failed (non-fatal): ${retireError instanceof Error ? retireError.message : String(retireError)}`)
        }
      }
      for (const postId of verdict.cleared) {
        if (byPost.get(postId)?.retired !== true) {
          ctx.logger.info(`[deepartments] b5-ghost: post "${postId}" has a usable session again — ghost-suspect marker cleared (intermittent session, never retired)`)
        }
      }
      await writeGhostSuspectLedger(stateDir, verdict.ledger)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] b5-ghost reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Fix (head-sleep idempotency/rotation-race) — (b) BOOT RECONCILE: a HEAD
   * whose post entry carries a SLEPT mark (sleepEpoch set) but whose session was
   * NEVER archived/closed — the "half-slept" dangling state left when a
   * host-session rotation / service restart landed DURING the dept_sleep
   * teardown (the pre-fix ordering put the awaited QD directive between the
   * archive and the dispose, so an abort on that await left the archive
   * un-sealed and the handle LIVE) — has an un-archived durable session that
   * nothing else reconciles (ensureHead skips a sleepEpoch-set head at boot, so
   * it is never touched). At boot, re-seal it: re-run the (idempotent)
   * archivePostSessionOnSleep for that sessionId so no dangling un-archived
   * session remains. NEVER throws and NEVER wakes/materializes the head — a
   * slept head stays dormant until its next bus wake (which mints a fresh
   * session), exactly as the F8 boot-dormancy invariant requires. */
  const runHalfSleptHeadReconcile = async (): Promise<void> => {
    try {
      const persistence = ctx.get('sessionPersistence') as { readRaw?: (id: SessionId, signal?: AbortSignal) => Promise<{ content: string } | undefined> } | undefined
      // Conservative session-gone resolver (mirrors reconcileDurablePostsRegistry):
      // only a positively confirmed absent durable session counts as gone.
      const isSessionGone = async (sessionId: string): Promise<boolean> => {
        if (persistence === undefined || typeof persistence.readRaw !== 'function') return false
        try {
          const raw = await persistence.readRaw(SessionId(sessionId))
          return raw === undefined
        } catch {
          return false
        }
      }
      for (const [postId, entry] of byPost) {
        if (entry.retired === true) continue
        if (entry.provider === 'worker') continue          // worker retire is its own path
        if (entry.sleepEpoch === void 0) continue          // only a SLEPT head
        // Re-seal the archive. Idempotent (registry.archiveSession is a no-op on
        // an already-archived id) + non-fatal (archivePostSessionOnSleep never
        // throws; a missing registry warns + returns false). The head is NEVER
        // woken — it stays dormant until its next bus delivery.
        await archivePostSessionOnSleep(entry.sessionId)
        // Fix (head-sleep worker drain): the slept head carries a durable
        // `inflightWorkers` ledger of the workers it slept with. Surface each
        // durably so a worker that finished mid-boundary is not orphaned and a
        // still-running worker is flagged. Only a worker whose durable session is
        // DEFINITIVELY gone is auto-retired (safe-reap); the rest are left live
        // (a delivered report cuts them, or the head reaps them on wake).
        if (Array.isArray(entry.inflightWorkers) && entry.inflightWorkers.length > 0) {
          for (const workerId of entry.inflightWorkers) {
            const worker = byPost.get(workerId)
            if (worker === void 0 || worker.retired === true) continue
            if (await isSessionGone(worker.sessionId)) {
              ctx.logger.warn(`[deepartments] half-slept reconcile: worker "${workerId}" (session ${worker.sessionId}) is in-flight for sleeping head "${postId}" but its durable session is gone — auto-retiring (it finished mid-boundary and was not cut clean)`)
              try {
                await retirePost(workerId, entry.sessionId)
              } catch (retireError: unknown) {
                ctx.logger.warn(`[deepartments] half-slept reconcile: auto-retire of worker "${workerId}" failed (non-fatal): ${retireError instanceof Error ? retireError.message : String(retireError)}`)
              }
            } else {
              ctx.logger.warn(`[deepartments] half-slept reconcile: worker "${workerId}" is still in flight for sleeping head "${postId}" — left live; a delivered report to "${postId}" retires it, or ${postId} reaps it on wake`)
            }
          }
        }
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] half-slept-head reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Dx1 F2 (owner bug — sidebar showed RETIRED workers as 'idle'): a boot
   * residue pass that populates the workspace-registry hide-set (spec §5.3,
   * D5) for the session residue NO retire seam ever archived. Before F1, the
   * archive traveled inside the 25% QD dice of retirePost, so most AUTO-
   * RETIRES (delivery auto-retire / half-slept reap) left the row visible
   * forever — and even the tool retires archived ONLY entry.sessionId, so an
   * OLDER/PARALLEL incarnation of the SAME slug (`worker-<slug>-<uuid>` #2)
   * stayed visible too. This pass (modeled on runHalfSleptHeadReconcile) runs
   * ONCE at boot and:
   *   (a) archives the CURRENT durable session (entry.sessionId) of EVERY
   *       RETIRED WORKER post — independent of the (optional) persistence
   *       enumeration below, so a headless/minimal persistence still seals it;
   *   (b) sweeps EVERY durable session the persistence knows
   *       (sessionPersistence.list() — the backend header ids; a bounded
   *       sessions-root dir scan as a best-effort fallback when the service is
   *       absent) and archives each id whose slug prefix `worker-<postId>-`
   *       matches a RETIRED worker post — the multi-session residue.
   * F3 (ORPHANS — a `worker-*` durable session with NO post at all) is
   * DELIBERATELY OUT of this pass: the session store is harness-shared and a
   * no-post sweep cannot safely distinguish an org-owned orphan from another
   * composition's registered worker (production sessions attach under
   * stateDir / repoRoot / a department workspacePath / the harness root —
   * resolveWorkspaceRootPath) — documented, deferred to a workspace-ownership
   * decision (the researcher-2 class stays visible).
   * Conservatism (ZERO-LOSS, R6/dec4): NOTHING is deleted or terminated —
   * archiveSession is a PURE hide-set add (the durable artifact stays; the
   * posts/hosts catalogs are untouched); a session that is CURRENTLY LIVE in
   * the stores is never archived; and a session whose prefix matches a LIVE
   * post is never archived (a live post's row must stay visible — the
   * slug-chain collision guard: `worker-builder-2-*` also starts with the
   * retired `worker-builder-` prefix). Idempotent: a second boot re-archives
   * nothing (an already-archived id is a registry no-op). Non-fatal by design:
   * a missing sessionPersistence / workspaceRegistry only DEGRADES the sweep
   * (warn, never a boot break), exactly like runHalfSleptHeadReconcile. */
  const runRetiredWorkerResidueReconcile = async (): Promise<void> => {
    try {
      // Slug-prefix indexes over the DURABLE catalog. Only WORKER posts mint
      // `worker-<slug>-` sessions (a retired head is unregistered, never here).
      const livePrefixes: string[] = []
      const retiredPrefixes: string[] = []
      for (const [postId, entry] of byPost) {
        if (entry.provider !== 'worker') continue
        const prefix = `worker-${postId}-`
        if (entry.retired === true) retiredPrefixes.push(prefix)
        else livePrefixes.push(prefix)
      }
      // (a) the CURRENT durable session of every retired worker — independent
      // of the (optional) enumeration below (idempotent; a no-op when already
      // in the hide-set).
      if (retiredPrefixes.length > 0) {
        for (const [, entry] of byPost) {
          if (entry.provider === 'worker' && entry.retired === true) {
            await archiveWorkerSession(entry.sessionId)
          }
        }
      }
      // (b) the slug-prefix sweep over the durability-known sessions.
      const persistence = ctx.get('sessionPersistence') as
        | { list?: (signal?: AbortSignal) => Promise<Array<{ id?: unknown } | null | undefined>>; root?: string }
        | undefined
      let durableSessionIds: string[] = []
      if (persistence !== void 0 && typeof persistence.list === 'function') {
        try {
          durableSessionIds = (await persistence.list())
            .map((header) => (header !== null && header !== void 0 && header.id !== void 0 ? String(header.id) : ''))
            .filter((id) => id !== '')
        } catch (error: unknown) {
          ctx.logger.warn(`[deepartments] retired-residue reconcile: sessionPersistence.list() failed — the slug-prefix sweep is skipped (the entry sessions above are still archived): ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        // Best-effort fallback (headless/minimal composition): the jsonl
        // session-store layout puts every session under
        // <root>/<project>/<encoded-id>/session.jsonl*; for the harness id
        // charset the ENCODED DIR NAME IS the session id (identity encoding —
        // dsh-session-persistence-jsonl format.js:129-141), so a bounded
        // two-level scan (stat-only, no full-log parse) collects the ids.
        const sessionsRoot = typeof persistence?.root === 'string' && persistence.root !== ''
          ? persistence.root
          : path.join(stateDir, '..', 'sessions')
        const sessionIds: string[] = []
        try {
          const projects = (await readdir(sessionsRoot, { withFileTypes: true }))
            .filter((e) => e.isDirectory()).map((e) => e.name)
          for (const project of projects) {
            const projectDir = path.join(sessionsRoot, project)
            let dirs: string[] = []
            try {
              dirs = (await readdir(projectDir, { withFileTypes: true }))
                .filter((e) => e.isDirectory()).map((e) => e.name)
            } catch {
              continue
            }
            for (const dir of dirs) {
              for (const suffix of ['session.jsonl.zstd', 'session.jsonl']) {
                try {
                  await stat(path.join(projectDir, dir, suffix))
                  sessionIds.push(dir)
                  break
                } catch { /* try the next suffix */ }
              }
            }
          }
        } catch {
          /* sessions root absent/unreadable — no fallback corpus (safe no-op) */
        }
        durableSessionIds = sessionIds
      }
      if (durableSessionIds.length === 0) return
      const sessions = ctx.get('sessions') as { get?: (id: unknown) => unknown } | undefined
      const isLive = (sessionId: string): boolean =>
        sessions?.get?.(sessionId) !== undefined ||
        (agents !== void 0 && agents.get(SessionId(sessionId)) !== undefined)
      for (const id of durableSessionIds) {
        if (!id.startsWith('worker-')) continue
        if (isLive(id)) continue // never hide a RUNNING session
        if (livePrefixes.some((prefix) => id.startsWith(prefix))) continue // a LIVE post's session stays visible (also the slug-chain collision guard)
        if (retiredPrefixes.some((prefix) => id.startsWith(prefix))) {
          await archiveWorkerSession(id)
        }
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] retired-residue reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Boot: materialize the head preset and every configured head once the
  // registries (posts/hosts) have cold-loaded — and re-drive any crash-pending
  // bus deliveries (see the re-delivery driver below). Head materialization no
  // longer needs a live parent (root agents) — it runs at boot unconditionally.
  void Promise.all([registryLoaded, hostsLoaded]).then(() => {
    void ensureAllHeads()
    void redeliverPendingDeliveries.run()
    void runPresetAudit()
    void runInterruptedPostReconciliation()
    void runProviderAdapterBootCheck()
    void runReasoningContentBootAssert()
    void runDurableRegistryReconciliation()
    void runHalfSleptHeadReconcile()
    void runRetiredWorkerResidueReconcile()
    void runGhostSuspectReconcile()
  })

  // ---------------------------------------------------------------------------
  // Batch B2 — AGENT MESSAGING BUS (spec 003). The delivery side is the
  // materializePost seam EXACTLY (catalog targets: materialize + always-wake;
  // D4) with the bus framing/source; the native-route side is
  // `subagents.followup` for continuable children. The board wakePost above is
  // gone (B3 cutover — the bus is the only delivery path).
  // ---------------------------------------------------------------------------

  /** The one record the bus persists per send (spec §3.1): the durable source
   * of truth, on disk BEFORE any delivery (persist-before-deliver, D4). */
  const messageStoreDir = stateDir

  /** The boot-opened message store (load + compact + per-recipient index).
   * Rejects loud on mid-file corruption (spec §3.2 — fail loud, never hide);
   * tools surface the rejection at use.
   * FASE 2.6-C: when the dshd-core bus service is composed, the store is the
   * CORE's (opened once on first use from the shared org stateDir); in a
   * minimal composition (dshd-core absent) we fall back to the in-bundle open
   * — the SAME store, behavior-neutral. */
  const messagesStoreReady = (ctx.get('deepartments.bus') as BusSurface | undefined)?.storeReady ?? MessagesStore.open(messageStoreDir)

  /** The boot-opened feedback store (load + prune-to-cap + live-by-id index).
   * The dshd-feedback package is a pure LIBRARY (no composed Cordis service),
   * so this is opened in-bundle from the shared org stateDir — the single
   * per-apply instance the `dept_feedback*` tools own (AGENTS.md rule 4).
   * Rejects loud on mid-file corruption (spec §3.2 — fail loud, never hide). */
  const feedbackStoreReady = FeedbackStore.open(messageStoreDir)

  /**
   * B5 — whether an agent materialization error is the harness "no
   * provider/model" signature (the VARIANT-2 / builder-87 ghost: a worker whose
   * durable session is PRESENT but whose AgentOptions carry no provider/model).
   * Conservative: only an EXACT signature match marks a worker unusable.
   */
  const isNoProviderModelError = (error: unknown): boolean => {
    const text = error instanceof Error ? error.message : String(error)
    return /has no provider\/model/.test(text)
  }

  /** fb-6 (B5 forensics): attach the RESOLVED (post-fallback) AgentOptions
   * VERBATIM (JSON) to a residual no-provider/model error's message, so BOTH
   * the durable post-error row AND the B5 marker carry diagnostic context
   * ("what options did the failed create actually receive?"). The original
   * message text is PRESERVED (the JSON is APPENDED), so the
   * isNoProviderModelError regex classification is unchanged; the original
   * error is also kept as `cause` (ES2023) and its stack is retained. */
  const withAgentOptionsContext = (error: unknown, agentOptions: AgentOptionsLike | undefined): Error => {
    const message = error instanceof Error ? error.message : String(error)
    const wrapped = new Error(`${message} agentOptions=${JSON.stringify(agentOptions ?? null)}`, error instanceof Error ? { cause: error } : undefined)
    if (error instanceof Error && error.stack !== undefined) wrapped.stack = error.stack
    return wrapped
  }

  /**
   * M-A (2026-08-28) — the SINGLE fresh-mint point for a department HEAD: the
   * F8 fresh-mint body of materializePost (extracted VERBATIM) + the journal
   * seed of the head-rotation path. One helper, three callers:
   *   - the F8 slept-head wake (materializePost — `seed` absent → the fresh
   *     session stays EMPTY, EXACTLY the pre-extraction behavior, zero
   *     regression);
   *   - the archived-session rotation of a live head (the archive-leak flip —
   *     same caller shape, see rotateArchivedHeadSessionId);
   *   - the M-A host-plane `dept_head_rotate` tool (`seed` = the head's LAST
   *     durable journal via buildHeadRotationSeed — the session is minted with
   *     the journal as its continuation context).
   * The head keeps its identity (postId); only the underlying session
   * (context) is fresh: this registers the new entry (new sessionId,
   * previousChildId = the old session, sleepEpoch cleared — a rotation is NOT
   * sleep —, `rotated: true` marker), CREATES the new durable session, records
   * the handle + progress baseline, fire-and-forgets the workspace attach and
   * pins the department sidebar title. Returns the LIVE fresh target (throws
   * when the head cannot be materialized — the caller maps it to 'failed').
   */
  const freshMintHead = async (
    entry: PostEntry,
    dept: DepartmentConfig | undefined,
    opts: { seed?: readonly unknown[]; source?: string } = {}
  ): Promise<AgentLike> => {
    if (agents === void 0) throw new Error('[deepartments] head fresh-mint requires the agents service')
    const previousSession = entry.sessionId
    const freshSessionId = String(SessionId(`${HEAD_SESSION_PREFIX}${entry.postId}-${randomUUID()}`))
    const coordinator = coordinatorForPost(entry.postId)
    // Drop the OLD session's reverse index BEFORE registering the fresh one
    // (registerEntry re-keys byChild by the new sessionId; without the delete
    // the old id would linger as a dead mapping).
    byChild.delete(previousSession)
    // Fix (head-sleep worker drain): the in-flight ledger is the sleep→boot
    // handoff; once the head is materialized (woken) its agent handles its own
    // workers, so clear the snapshot on the fresh incarnation. M-A: `rotated`
    // marks the rotation event (a rotation is NOT sleep — sleepEpoch stays
    // cleared).
    registerEntry({ ...entry, sessionId: freshSessionId, previousChildId: previousSession, sleepEpoch: undefined, inflightWorkers: undefined, rotated: true })
    const role = coordinator?.role ?? entry.role ?? 'department worker'
    const headPreset = entry.agentPreset ?? PRESET_ID
    // F10 (spec 004 §9.1): the materialized head carries its department's
    // architecture section (if any).
    const setup = headSetup(entry.postId, entry.roomId, role, headPreset, dept)
    const agentOptions = resolveMaterializeAgentOptions(coordinator?.agentOptions)
    // F5: the fresh incarnation lands in its department workspace (config
    // workspacePath); a department-less/legacy head falls back to the root.
    const deptCwd = await resolveDepartmentWorkspaceCwd(dept)
    const handle = await agents.create({
      sessionId: freshSessionId,
      // M-A: the seed is the OPTIONAL journal continuation of a head rotation
      // (buildHeadRotationSeed → the harness CreateAgentOptions.seed →
      // sessions.prepare(id, {seed, meta})); the F8 wake passes none (the
      // pre-extraction empty-session create, byte-identical).
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: headPreset },
      agentOptions,
      setup
    })
    if (handle !== void 0) byHeadHandle.set(freshSessionId, handle)
    const freshTarget = agents.get(freshSessionId)
    if (freshTarget === void 0) throw new Error(`[deepartments] head "${entry.postId}" could not be materialized (fresh rotation) for bus delivery`)
    markHeadProgress(freshSessionId, freshTarget)
    const source = opts.source ?? 'bus-deliver'
    void attachHeadSession(freshSessionId, source)
    // F8 (acceptance b): pin the head sidebar title on the FRESH session — the
    // old (archived) session is gone, so the fresh one MUST carry the pinned
    // department title or the row would fall back to the raw id. (A seeded
    // rotation already carries the title in the seed's `session/title` event —
    // pinSessionTitle's never-double-pin guard turns the runtime pin into a
    // no-op 'already-pinned'.)
    const titleSession = ctx.sessions.get(SessionId(freshSessionId))
    if (titleSession !== void 0) {
      const title = coordinator?.sessionTitle || HEAD_DEFAULT_SESSION_TITLE
      const titlePin = pinSessionTitle(titleSession, title)
      if (titlePin === 'pinned') {
        ctx.logger.info(`[deepartments] ${source}: pinned fresh head title "${title}" (${freshSessionId})`)
      } else if (titlePin === 'failed') {
        ctx.logger.warn(`[deepartments] ${source}: fresh head title pin failed for ${freshSessionId} (non-fatal — materialization continues)`)
      }
    }
    return freshTarget
  }

  /**
   * The SHARED post-materialization core of the wakePost seam (spec §4.3 step 2
   * — "EXACTLY wakePost"): respawn-from-sleep (dispose stale handle, clear
   * sleepEpoch, keep previousChildId), resume→create fallback with the post's
   * durable per-head preset + role, mark a fresh progress baseline, and
   * fire-and-forget the workspace attach. Returns the live target and whether
   * this call materialized it (the `resumed` delivery status). Throws when the
   * post cannot be materialized (the caller maps it to a `failed` delivery).
   */
  const materializePost = async (entry: PostEntry): Promise<{ target: AgentLike; resumed: boolean }> => {
    if (agents === void 0) throw new Error('[deepartments] bus delivery requires the agents service')
    // fb-9 RESUME SEAM (coverage-map §4-3): the SAME dispatch pre-flight as the
    // spawn engines, at the SINGLE choke point of the bus-wake materialization —
    // ONE call here covers EVERY agents.resume/agents.create below (the
    // sleep-respawn head create :6601, the archived-rotation head create :6666,
    // the shared cold-resume :6691 and its create-fallback :6694) with no
    // duplication. The mid-turn continuation 400 (the q-i-20 class) is NOT this
    // seam, but the RESUME class (fb-6: a cold-resumed worker re-plays the
    // tool-call history through the same openai-completions API) gets the same
    // fail-EARLY: a worker route whose profile has reasoning enabled but lacks
    // compat.requiresReasoningContentOnAssistantMessages=true never resumes into
    // its expensive first 400 — the wake fails loudly with the preflight error
    // instead (the delivery is mapped to 'failed' by busDeliverToPost).
    const preflightError = workerReasoningContentPreflightError()
    if (preflightError !== undefined) throw new Error(`[deepartments] ${preflightError}`)
    // DISPATCH-HARDENING (QH «429-primer-call»): the pooler-capacity
    // pre-check on the RESUME seam (the +1 of the fb-9 3+1) — a cold-resumed
    // / slept-respawned post wakes into ITS first call immediately; when the
    // pooler snapshot certifies no workspace can serve it, the wake fails
    // LOUDLY and EARLY (the delivery is mapped to 'failed' by busDeliverToPost,
    // exactly like the preflight error above) instead of burning the first
    // LLM turn on a 429/503.
    const poolerDispatchBlock = workerPoolerDispatchBlockError()
    if (poolerDispatchBlock !== undefined) throw new Error(`[deepartments] ${poolerDispatchBlock}`)
    const isWorker = entry.provider === 'worker'
    const coordinator = coordinatorForPost(entry.postId)
    let resumed = false
    if (entry.sleepEpoch !== void 0) {
      // Respawn from sleep: retire the live handle (if any), record the
      // previous incarnation, clear the flag. Joins any in-flight dept_sleep
      // detach (disposeHeadHandleOnce) so the incarnation below is guaranteed to
      // run only AFTER the machine is detached (no double-dispose race).
      // DEADLOCK FIX (2026-08-26): the join is BOUNDED — a zombie detach (a
      // slept machine whose turn can never settle, e.g. the QD-directive
      // cascade) would otherwise freeze THIS delivery forever, and every
      // awaited bus delivery to the slept head with it.
      if (!(await joinHeadDisposeOnce(entry.sessionId))) {
        ctx.logger.warn(`[deepartments] sleep respawn for "${entry.postId}": detach join timed out after ${disposeJoinTimeoutMs()}ms — proceeding with the fresh mint (zombie detach; the fresh incarnation uses a NEW session id, no collision)`)
      }
      byChild.delete(entry.sessionId)
      const previousSession = entry.sessionId
      // F8 (spec 002 head rotation) — a slept HEAD is recreated FRESH: mint a
      // new session id (the OLD one was ARCHIVED at dept_sleep) and CREATE a
      // brand-new durable session, never resume the archived old artifact. The
      // head keeps its identity (postId), journal and messages (archive ≠
      // delete); only the underlying session (context) is fresh. A disposable
      // WORKER keeps the legacy cold-resume of the SAME session — worker retire
      // is the separate archive path. M-A: the F8 fresh-mint body now lives in
      // the SHARED `freshMintHead` helper (the single fresh-mint point also
      // used by the host-plane dept_head_rotate tool); no seed is passed, so
      // the wake session stays EMPTY exactly like the pre-extraction create.
      if (!isWorker) {
        const freshTarget = await freshMintHead(entry, departmentForEntry(entry))
        return { target: freshTarget, resumed: true }
      }
      // Worker respawn: record the previous incarnation + clear the sleep flag,
      // then fall through to the shared cold-resume of the SAME session below.
      // A worker has no in-flight ledger of its own (only a head does), but clear
      // it for symmetry so a respawn never carries a stale snapshot.
      registerEntry({ ...entry, previousChildId: previousSession, sleepEpoch: undefined, inflightWorkers: undefined })
      resumed = true
    }
    const sessionId = SessionId(entry.sessionId)
    const live = agents.get(String(sessionId))
    if (live === void 0) {
      const role = coordinator?.role ?? entry.role ?? 'department worker'
      const headPreset = entry.agentPreset ?? PRESET_ID
      // F10 (spec 004 §9.1): the re-materialized post carries its department's
      // architecture section (a worker by its durable departmentId, a head by
      // config; a department-less/legacy entry → omitted cleanly).
      const dept = departmentForEntry(entry)
      const setup = isWorker
        ? workerSetup(entry.postId, entry.roomId, role, { department: dept })
        : headSetup(entry.postId, entry.roomId, role, headPreset, dept)
      const agentOptions = resolveMaterializeAgentOptions(coordinator?.agentOptions)
      const preset: string = isWorker ? WORKER_PRESET_ID : headPreset
      let handle: AgentHandleLike | undefined
      // F5 (spec 004 §6.2 L1): the FRESH-create fallback of a bus wake lands the
      // re-materialized session in ITS department workspace (a worker by its
      // durable departmentId, a head by config); a department-less/legacy entry
      // falls back to the shared workspace root (deptCwd ''). The resume path
      // above keeps the session's stored header cwd (immutable per session).
      const deptCwd = await resolveDepartmentWorkspaceCwd(departmentForEntry(entry))
      // THE VISIBILITY FIX (2026-08-25 P2): a NON-slept HEAD whose durable
      // session id is in the workspace registry's archived set must NEVER be
      // RESUMED — a live head's session is never archived, because the GUI
      // sidebar hides any archived session id (the re-seed resume of an archived
      // id is the root cause of the live-but-invisible head). Rotate to a FRESH
      // id (the F8 fresh-mint shape) and CREATE. A NON-archived head resume is
      // byte-identical (zero regression); a WORKER's resume is untouched here
      // (isWorker skips the rotation entirely).
      const rotatedSessionId = isWorker ? undefined : await rotateArchivedHeadSessionId(entry.postId, String(sessionId))
      if (rotatedSessionId !== void 0) {
        registerEntry({ ...entry, sessionId: rotatedSessionId, previousChildId: String(sessionId), sleepEpoch: undefined })
        handle = await agents.create({
          sessionId: rotatedSessionId,
          meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: headPreset },
          agentOptions,
          setup
        })
        if (handle !== void 0) byHeadHandle.set(rotatedSessionId, handle)
        const rotatedTarget = agents.get(rotatedSessionId)
        if (rotatedTarget === void 0) throw new Error(`[deepartments] head "${entry.postId}" could not be materialized (archived-session rotation) for bus delivery`)
        markHeadProgress(rotatedSessionId, rotatedTarget)
        void attachHeadSession(rotatedSessionId, 'bus-deliver')
        const titleSession = ctx.sessions.get(SessionId(rotatedSessionId))
        if (titleSession !== void 0) {
          const title = coordinator?.sessionTitle || HEAD_DEFAULT_SESSION_TITLE
          const titlePin = pinSessionTitle(titleSession, title)
          if (titlePin === 'pinned') {
            ctx.logger.info(`[deepartments] archive-leak rotation: pinned fresh head title "${title}" (${rotatedSessionId})`)
          } else if (titlePin === 'failed') {
            ctx.logger.warn(`[deepartments] archive-leak rotation: fresh head title pin failed for ${rotatedSessionId} (non-fatal — materialization continues)`)
          }
        }
        resumed = true
        return { target: rotatedTarget, resumed: true }
      }
      try {
        handle = await agents.resume({ resumeSessionId: String(sessionId), agentOptions, setup })
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" bus wake-resume failed, creating fresh: ${error instanceof Error ? error.message : String(error)}`)
        handle = await agents.create({
          sessionId: String(sessionId),
          meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: preset },
          agentOptions,
          setup
        }).catch((createError: unknown) => {
          // B5 — a WORKER whose create throws "has no provider/model" is the
          // VARIANT-2 / builder-87 ghost: a DURABLE session PRESENT but with NO
          // usable AgentOptions. The fb-6 fallback above has ALREADY resolved a
          // usable provider/model (WORKER_AGENT_OPTIONS) into `agentOptions`, so
          // this branch is the RESIDUAL case: the create fails even WITH
          // options. Record the durable marker so the boot reconcile's
          // `isSessionUnusable` classifies it as a retire-leak candidate (under
          // the existing retireGoneWorkers opt-in), and attach the RESOLVED
          // AgentOptions VERBATIM (JSON) to the error message (fb-6 forensics)
          // so BOTH the post-error row and the marker carry the exact options
          // the failed create received (the appended JSON never changes the
          // isNoProviderModelError classification — the original text is kept).
          // The marker is CLEARED on a successful materialization (see the
          // return below), so a worker that recovers is never over-retired.
          if (isWorker && isNoProviderModelError(createError)) {
            const forensic = withAgentOptionsContext(createError, agentOptions)
            void markUnusableWorkerSession(stateDir, entry.postId, entry.sessionId, forensic.message)
            throw forensic
          }
          throw createError
        })
      }
      if (handle !== void 0) byHeadHandle.set(String(sessionId), handle)
      resumed = true
    }
    const target = agents.get(String(sessionId))
    if (target === void 0) throw new Error(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" could not be materialized for bus delivery`)
    // Clear a B5 unusable mark: this worker materialized successfully, so its
    // session is usable again (never over-retire a recovered worker).
    if (isWorker) await clearUnusableWorkerSession(stateDir, entry.postId)
    // Fresh baseline for the (re)materialized incarnation so the stuck check
    // never misjudges a just-cold-resumed post.
    markHeadProgress(String(sessionId), target)
    void attachHeadSession(String(sessionId), 'bus-deliver')
    return { target, resumed }
  }

  /** The delivered user-message for ONE bus deliver (spec §4.3): the framed
   * text as content + the `agent/send` source. Built via createUserMessage with
   * a FRESH inline literal (mirroring wakePost's compile-clean call shape). */
  const busUserMessage = (record: MessageRecord, framed: string, senderSessionId: string | undefined) =>
    createUserMessage({
      // W8-b prompt-literal safety: the delivered bus message text (already
      // framed) is run through the brace sanitizer so an unbound double-brace
      // token in a message can never break the recipient session assembly.
      // Bound persona/preset vars are preserved.
      content: [{ type: 'text', text: sanitizePromptLiterals(framed) } as const],
      // W7-B: the source is projected to a PLAIN JSON-safe value BEFORE it is
      // inserted (the `agent/inbox/spliced` append boundary rejects
      // branded/class instances, a present `undefined` key, functions, etc.).
      // `senderSessionId: undefined` (no caller session) is OMITTED, never
      // emitted as a present-undefined key. A malformed value never throws.
      source: jsonSafeMessageSource({
        kind: 'agent',
        form: 'send',
        plugin: 'deepartments',
        summary: boundContextSummary(`New message from ${record.from} to ${record.to.length} recipient(s) (${record.kind}).`),
        to: [...record.to],
        messageId: record.id,
        from: record.from,
        senderSessionId: senderSessionId === undefined ? undefined : SessionId(senderSessionId)
      })
    })

  /** The shared post DELIVERY of one bus message: the wakePost seam including
   * the stuck-head recovery verbatim (relay guards §4.4). Never throws — the
   * error is logged AND returned as 'failed' (never silent). W9-b: when
   * `opts.interrupt` is true and the recipient is LIVE mid-turn, the CURRENT
   * turn is aborted (reason 'interrupted', keepInbox preserved) so the message
   * is the FIRST item of the recipient's next turn instead of queueing behind
   * it. Default (false) = QUEUE semantics, unchanged. */
  const busDeliverToPost = async (entry: PostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined, opts?: DeliveryInterruptOptions): Promise<DeliveryStatus> => {
    const sessionId = String(SessionId(entry.sessionId))
    const interrupt = opts?.interrupt === true
    try {
      const live = agents?.get(sessionId)
      // Fix A2 stuck-head resilience (verbatim): a live-but-running post with
      // NO session progress for STUCK_HEAD_MS is wedged; dispose + cold-resume
      // (serialized per head), re-delivering from the DURABLE message record —
      // never into the frozen loop's in-memory inbox.
      if (live !== void 0 && entry.sleepEpoch === void 0 && isHeadStuck(sessionId, live)) {
        ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}": live but stuck (no session progress for ${STUCK_HEAD_MS / 1000}s) — disposing + cold-resuming from the durable message record`)
        await serializeHeadRecovery(sessionId, async () => {
          await disposeHeadHandle(sessionId)
          headProgress.delete(sessionId)
          const { target } = await materializePost(entry)
          target.followup(busUserMessage(record, framed, senderSessionId))
        })
        return 'resumed'
      }
      // W9-b interrupt: a LIVE, currently-running recipient with `interrupt:
      // true` is preempted — abort its CURRENT turn (reason 'interrupted') and
      // preserve any already-pending inbox work (keepInbox), so the message
      // delivered below is the FIRST item of the recipient's next turn. A
      // DORMANT recipient (live === undefined) needs no abort — the followup
      // below wakes it immediately (unchanged).
      // M3 (spec §2.4): the abort is gated by the shared per-recipient interrupt
      // back-off (safeInterrupt) — at most ONE interrupt per recipient per
      // INTERRUPT_COOLDOWN_MS, regardless of identity/class count. A turn just
      // interrupted by the daemon is within the cooldown → it is NEVER
      // interrupted again (the re-entrancy guard); a delivery that falls inside
      // the cooldown races through to QUEUE semantics (no abort).
      if (interrupt && live !== void 0 && live.status === 'running') {
        const aborted = await safeInterrupt(live, entry.postId, Date.now(), stateDir)
        if (aborted) {
          ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}": interrupt=true — aborted the current turn (reason 'interrupted'); delivery is the first item of the next turn`)
        } else {
          ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}": interrupt=true but within the per-recipient cooldown — delivery queued (no abort)`)
        }
      }
      const { target, resumed } = await materializePost(entry)
      target.followup(busUserMessage(record, framed, senderSessionId))
      const status = resumed ? 'resumed' : 'delivered'
      // Fix B (head-sleep worker drain): a WORKER that has just delivered a
      // message to ITS OWN MANAGER HEAD is cut clean immediately — the delivery
      // itself is the retire trigger, so a worker that delivered its report to a
      // (possibly dormant) head is retired WITHOUT relying on the head remembering
      // an open item. The 'resumed' status is exactly the sleep-boundary signature
      // (the recipient was dormant at delivery time and was re-materialized). The
      // retire is a defensive no-op if the worker is already retired (idempotent).
      if (status === 'resumed' || status === 'delivered') {
        const senderEntry = byPost.get(record.from)
        if (senderEntry !== void 0 && senderEntry.provider === 'worker' && senderEntry.retired !== true && senderEntry.managerId === entry.postId) {
          try {
            await retirePost(record.from, String(SessionId(entry.sessionId)))
          } catch (error: unknown) {
            ctx.logger.warn(`[deepartments] auto-retire of worker "${record.from}" on delivery to "${entry.postId}" failed (non-fatal to the delivery): ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      return status
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      // W6 system-health: record the hard materialization/wake failure for the
      // health daemon (failures must reach the Asistente; post-errors.jsonl is
      // the durable anomaly source). A persist failure folds to a warn only.
      // Issue-1 (b) (owner m-331): use the RECORDING DEDUPE (appendPostErrorDeduped
      // in the shared health-alerts-state.json ledger) so a persistent failure of
      // a NON-host post is recorded at most once per (post + class) per
      // HEALTH_DEDUPE_WINDOW_MS — mirroring the host path — and the QD directive
      // below is gated on an actually-NEW append, NOT emitted per attempt.
      try {
        const errText = error instanceof Error ? error.message : String(error)
        const cls = postErrorClass(errText)
        const recordKey = `${POST_ERROR_RECORD_KEY_PREFIX}${entry.postId}:${cls ?? 'generic'}`
        const appended = await appendPostErrorDeduped(stateDir, {
          ts: Date.now(),
          postId: entry.postId,
          messageId: record.id,
          error: errText
        }, recordKey, Date.now())
        // QD (spec 007 §6.4, D-Q4a): a NEW post-error record (the spec-006 capture)
        // triggers an ADDRESSED QUALITY INSPECT directive to quality-head (with the
        // error record) — the event-driven, bus-ready analysis seam (additive to the
        // spec-006 host ALERT). Non-fatal (the helper wraps its own try/catch).
        // Issue-1 (b): `appended` is the recording-dedupe result — a dedupe-skip
        // means no new record, so do NOT re-signal (Bound the non-host cascade).
        // ECHO GUARD (reviewer gate): a failed QUALITY INSPECT directive delivery to
        // `quality-head` lands in THIS SAME catch — if we re-emitted a post-error
        // directive for it, the directive → busDeliverToPost(quality-head) → fail →
        // re-append → re-emit loop is unbounded. Gate the emit so the QD target's
        // OWN delivery failure is recorded (post-errors.jsonl) but is NEVER bubbled
        // back into another directive. (The host-delivery site gates on `appended`
        // instead; both bound the echo.)
        if (appended && entry.postId !== 'quality-head') {
          await maybeEmitQualityInspectDirective({
            kind: 'post-error',
            postId: entry.postId,
            messageId: record.id,
            error: errText
          })
        }
      } catch (appendError: unknown) {
        ctx.logger.warn(`[deepartments] post-error capture for "${entry.postId}" failed: ${appendError instanceof Error ? appendError.message : String(appendError)}`)
      }
      return 'failed'
    }
  }

  /** The shared HOST delivery (D4 — always wake, including a non-live host):
   * a live host is followed up inline; a non-live host session is resumed
   * exactly like a dormant head (the owner accepted the materialized host
   * turn). The host's own composition (the 'deepartments' preset) is re-mounted
   * best-effort when the agentPresets service is present; a bare resume is the
   * graceful fallback. Never throws — 'failed' is logged AND returned. W9-b:
   * when `opts.interrupt` is true and the host is LIVE mid-turn, the CURRENT
   * turn is aborted (reason 'interrupted', keepInbox preserved) so the message
   * is the FIRST item of the host's next turn. Default (false) = QUEUE. */
  const busDeliverToHost = async (hostEntry: HostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined, opts?: DeliveryInterruptOptions): Promise<DeliveryStatus> => {
    if (agents === void 0) return 'failed'
    // W7 terminal philosophy (Bug A, PRIMARY): a RETIRED host is terminal — it is
    // NEVER attempted and NEVER recorded (no resume, no materialization, no
    // post-error row). The only registered live host is the rotation successor.
    // Without this gate a stale in-memory Map (the rotation-commit window / a
    // second daemon twin) could still resolve the retired host as live and the
    // delivery catch would record its rows, re-alerting the CURRENT host about a
    // terminal entry forever.
    // Issue-1 HOST-FAMILY EXCEPTION (owner m-331, Option 1): W7 applies as the
    // TERMINAL rule for a NON-host-family address. A HOST-FAMILY recipient id
    // ('host-…') that resolves to a RETIRED / UNRESOLVABLE host entry is instead
    // re-resolved durable-first to the CURRENT LIVE host at the CATALOG seam
    // (busDeliverCatalog, pickLiveHostEntry from a fresh hosts.json read) and
    // delivered there — host-session-<uuid> means "the Asistente" (role), so the
    // re-route honors the sender's intent. This branch therefore only sees a
    // host entry that was ALREADY re-resolved to live, or a directly-addressed
    // NON-host-family retired/unresolvable id.
    if (hostEntry.retired === true) {
      ctx.logger.warn(`[deepartments] bus delivery to RETIRED host "${hostEntry.hostId}" skipped (terminal — a retired host is never attempted or recorded)`)
      return 'failed'
    }
    const sessionId = String(SessionId(hostEntry.sessionId))
    const interrupt = opts?.interrupt === true
    /** One host delivery attempt: an inline followup for a LIVE host, else the
     * D4 resume (with the best-effort 'deepartments' preset mount). Returns the
     * status plus the thrown error, so the W8-i retry below can classify a
     * transient 'session "<id>" not found' WITHOUT losing the message. */
    const attemptHostDelivery = async (): Promise<{ status: DeliveryStatus; error?: unknown }> => {
      try {
        const live = agents.get(sessionId)
        if (live !== void 0) {
          // W9-b interrupt: a LIVE, currently-running host with `interrupt:
          // true` is preempted — abort its CURRENT turn (reason 'interrupted')
          // and preserve any already-pending inbox work (keepInbox).
          // M3 (spec §2.4): the abort is gated by the shared per-recipient
          // interrupt back-off (safeInterrupt) — at most ONE interrupt per
          // recipient per INTERRUPT_COOLDOWN_MS, regardless of identity/class
          // count. A turn just interrupted by the daemon is within the cooldown
          // → it is NEVER interrupted again (the re-entrancy guard); a delivery
          // inside the cooldown races through to QUEUE semantics (no abort).
          if (interrupt && live.status === 'running') {
            const aborted = await safeInterrupt(live, hostEntry.hostId, Date.now(), stateDir)
            if (aborted) {
              ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}": interrupt=true — aborted the current turn (reason 'interrupted'); delivery is the first item of the next turn`)
            } else {
              ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}": interrupt=true but within the per-recipient cooldown — delivery queued (no abort)`)
            }
          }
          live.followup(busUserMessage(record, framed, senderSessionId))
          return { status: 'delivered' }
        }
        // D4 — a dormant host is ALWAYS woken: resume the durable host session.
        // The GUI owns the host composition ('deepartments'), so re-mount it
        // best-effort (mirroring the api-proxy's composeAgent-on-resume); the
        // session's own global-layer tools remain reachable regardless.
        const setup = agentPresets === void 0
          ? undefined
          : (agentCtx: Context): void => {
              void agentPresets.mount(agentCtx, 'deepartments').catch((error: unknown) => {
                ctx.logger.warn(`[deepartments] host resume preset mount failed (bare resume continues): ${error instanceof Error ? error.message : String(error)}`)
              })
            }
        // VARIANT-2 (2026-08-24): WITHOUT a host agentOptions the D4 resume
        // constructs a FRESH ReactLoopAgent with `agent.options = {}` → the
        // request waterfall throws `agent "session-<uuid>" has no provider/model`
        // at the first post-boot host materialization (the host AgentOptions were
        // intermittently empty — see HOST_AGENT_OPTIONS). The D4 setup does NOT
        // installSelection, so a non-empty `this.options` is the ONLY carrier.
        // Mirror WORKER_AGENT_OPTIONS (heads/workers) so the host is symmetric.
        await agents.resume({ resumeSessionId: sessionId, setup, agentOptions: HOST_AGENT_OPTIONS })
        const target = agents.get(sessionId)
        if (target === void 0) throw new Error(`[deepartments] host "${hostEntry.hostId}" could not be materialized for bus delivery`)
        target.followup(busUserMessage(record, framed, senderSessionId))
        return { status: 'resumed' }
      } catch (error: unknown) {
        return { status: 'failed', error }
      }
    }
    const first = await attemptHostDelivery()
    if (first.status !== 'failed') {
      // M3 cascade guard: a SUCCESSFUL materialization clears the host's
      // consecutive-failure counter (a recovered host must not be treated as a
      // threshold already met → an immediate re-quarantine).
      await resetHostMaterializeFailures(stateDir, hostEntry.hostId)
      return first.status
    }
    // W8-i: a SINGLE transient 'session "<id>" not found' first-attempt failure
    // (a host session registered in hosts.json whose durable session is not yet
    // workspace-attached — the harness session-persistence/query seam) must NOT
    // be recorded as a post-error: re-deliver THROUGH the existing host-attach
    // repair seam (await it) BEFORE recording, and record ONLY if the retry
    // ALSO fails — so a later-retried SUCCESSFUL delivery leaves NO trace. A
    // non-'not found' failure records today's row unchanged.
    let recordedError: unknown = first.error
    if (isSessionNotFoundError(first.error)) {
      try {
        await repairHostWorkspaceAttach()
      } catch (repairError: unknown) {
        ctx.logger.warn(`[deepartments] host attach repair (bus-deliver retry) failed for host "${hostEntry.hostId}": ${repairError instanceof Error ? repairError.message : String(repairError)}`)
      }
      const second = await attemptHostDelivery()
      if (second.status !== 'failed') {
        await resetHostMaterializeFailures(stateDir, hostEntry.hostId)
        return second.status
      }
      recordedError = second.error ?? first.error
    }
    ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}" failed: ${recordedError instanceof Error ? recordedError.message : String(recordedError)}`)
    // W6 system-health: record the host materialization/wake failure (the SAME
    // durable anomaly source as the post delivery; postId = the host id). M3
    // (spec §3.3): for EVERY host class the recording is now a PER-(host+class)
    // dedupe in the shared health-alerts-state.json ledger (reusing
    // appendPostErrorDeduped, the W8-i recording ledger) — a PERSISTENT failure
    // of a NON-retired-but-broken host is NEVER re-recorded/re-alerted inside
    // HEALTH_DEDUPE_WINDOW_MS (one per host+class per 30min, NOT per attempt).
    // This is the R1 generic-class write dedupe: a generic (non-session-not-found)
    // failure previously used the PLAIN append → a row EVERY attempt; now ≤1 per
    // (host,class) per window, and the QD directive emit below is gated on an
    // actually-NEW append (not "every attempt").
    try {
      // Bug A SOURCE GATE (the write, not the scan): a RETIRED host's session is
      // terminal (W7). Re-validate against the DURABLE hosts.json ON DISK — the
      // authoritative rotation record — NOT the possibly-stale in-memory `hosts`
      // Map / hostEntry. A long-lived process (a second daemon twin that booted
      // BEFORE a rotation, sharing the stateDir) keeps a STALE in-memory registry
      // that never marks the retired host retired; that stale registry would let
      // this catch append a new post-error ROW forever. Re-reading the on-disk
      // file here closes the stale-twin bypass: the scan gate only suppresses the
      // FINDING; this suppresses the ROW at the source, per the Asistente's
      // "ZERO new rows" acceptance.
      const durableRetiredOnDisk = isHostRetiredOnDisk(stateDir, hostEntry.hostId)
      // Belt-and-suspenders: the in-memory Map check is a FALLBACK for the window
      // where hosts.json is unreadable/malformed (durableRetiredOnDisk === undefined),
      // and never over-suppresses a DURABLY-LIVE host (durableRetiredOnDisk === false
      // is authoritative → the write proceeds).
      const inMemoryRetired = (hosts.get(hostEntry.hostId)?.retired ?? hostEntry.retired) === true
      const durableRetired = durableRetiredOnDisk === true || (durableRetiredOnDisk === undefined && inMemoryRetired)
      if (durableRetired) {
        ctx.logger.warn(`[deepartments] bus delivery to RETIRED host "${hostEntry.hostId}" — post-error ROW write skipped (terminal; durable source gate)`)
        return 'failed'
      }
      // M3 materialization-cascade guard (spec §3.3, R5 — the SAFEST subset of
      // R2/R3): a NON-retired-but-BROKEN host keeps failing materialization →
      // the daemon treats EACH attempt as a fresh anomaly. The per-host
      // consecutive-failure cooldown below NEVER skips the delivery attempt (the
      // durable-retry repair is kept) — it gates only the REPEATED post-error
      // RECORDING (and thus the QD directive) once a host has hit N consecutive
      // failures. The FULL delivery-side quarantine (skipping the attempt to
      // stop the tight-retry loop itself) is DEFERRED (too invasive for a clean
      // additive change; see the M3 report).
      const entry: PostErrorEntry = {
        ts: Date.now(),
        postId: hostEntry.hostId,
        messageId: record.id,
        error: recordedError instanceof Error ? recordedError.message : String(recordedError)
      }
      const matState = readMaterializeState(stateDir)
      const { next: nextMat, quarantined } = markHostMaterializeFailure(matState, hostEntry.hostId, entry.ts)
      await writeMaterializeState(stateDir, nextMat)
      if (quarantined) {
        ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}": ${MATERIALIZE_QUARANTINE_N} consecutive materialization failures — quarantined until ${new Date(entry.ts + MATERIALIZE_QUARANTINE_MS).toISOString()} (post-error recording + QD directive suppressed; the delivery attempt + durable repair are unchanged)`)
        return 'failed'
      }
      const cls = postErrorClass(entry.error)
      const recordKey = `${POST_ERROR_RECORD_KEY_PREFIX}${hostEntry.hostId}:${cls ?? 'generic'}`
      const appended = await appendPostErrorDeduped(stateDir, entry, recordKey, entry.ts)
      // QD (spec 007 §6.4, D-Q4a): after a NEW post-error record is actually
      // appended, trigger the ADDRESSED QUALITY INSPECT directive to quality-head
      // (a dedupe-skip means no new record — do not re-signal). M3: `appended`
      // is now a REAL recording-dedupe result for EVERY class (generic included),
      // so a REPEAT failure inside the window emits NO directive (the old generic
      // branch always returned true → a directive per retry). Non-fatal.
      if (appended) {
        await maybeEmitQualityInspectDirective({ kind: 'post-error', postId: entry.postId, messageId: entry.messageId ?? '', error: entry.error })
      }
    } catch (appendError: unknown) {
      ctx.logger.warn(`[deepartments] post-error capture for host "${hostEntry.hostId}" failed: ${appendError instanceof Error ? appendError.message : String(appendError)}`)
    }
    return 'failed'
  }

  // --- QD (spec 007 Quality Department) RUNTIME hooks — the directive emitter --
  // The QUALITY INSPECT directive: an ADDRESSED bus message to the configured
  // `quality-head`. The hook fires INSIDE plugin-internal functions (retirePost /
  // the head dept_sleep branch / runHostRotation / the bus-delivery catches),
  // NOT a hosted agent's send_message — so the catalog-route ACL would deny it.
  // It therefore delivers via the SAME daemon-not-a-catalog-member notify
  // pattern as the agenda scheduler `notifyHead`
  // (messagesStoreReady.append → busDeliverToPost, invoke.ts:~9781). NEVERTHROW
  // and NEVER-spawn: the whole emit is wrapped in its own try/catch → a failed
  // delivery degrades to ctx.logger.warn and the retire/sleep/rotation it hooks
  // still commits. The directive is the ONLY output — quality-head orchestrates
  // its own workers; the hook NEVER spawns a QD worker.
  /** Resolve the configured `quality-head` post (a registered head — the QD
   * coordinator materialized by `ensureAllHeads` at boot). */
  const resolveQualityHeadEntry = (): PostEntry | undefined => byPost.get('quality-head')

  /**
   * dshd-feedback R7 — the ACL-LEGAL NOTIFICATION FORWARDER: `record.from` for
   * the quality-head notification must be a sender the delivery-engine defensive
   * ACL allows (head→head / host→head allowed; worker→head DENIED). The real
   * `emisor` always travels in the feedback record + the notification body.
   *   - a HEAD (or the host) self-forwards: from = the emisor itself;
   *   - a WORKER forwards as its managerId (the creating head), else as the
   *     coordinator postId of its config department;
   *   - neither resolves → undefined → the caller falls back to the direct QD
   *     seam (`busDeliverToPost` with record.from='deepartments' — the
   *     QD-directive precedent, invoke.ts maybeEmitQualityInspectDirective).
   */
  const feedbackForwarderFor = (emisor: string): string | undefined => {
    const entry = byPost.get(emisor)
    if (entry === undefined) return hosts.has(emisor) ? emisor : undefined
    if (entry.provider !== 'worker') return emisor // a head: self (head→head is legal)
    const manager = entry.managerId
    if (manager !== undefined && byPost.has(manager)) return manager
    const coordinatorPostId = departmentForEntry(entry)?.coordinator?.postId
    if (coordinatorPostId !== undefined && byPost.has(coordinatorPostId)) return coordinatorPostId
    return undefined
  }

  /** dshd-feedback severity-gated delivery options (R7): critico → wake+interrupt;
   * alto → wake (no interrupt); medio/bajo/mejora → no-wake queue. */
  const feedbackDeliveryOptions = (tipo: FeedbackTipo, severidad: FeedbackSeveridad): { noWake: boolean; interrupt?: boolean } => {
    if (tipo === 'mejora') return { noWake: true }
    if (severidad === 'critico') return { noWake: false, interrupt: true }
    if (severidad === 'alto') return { noWake: false }
    return { noWake: true } // medio / bajo
  }

  const maybeEmitQualityInspectDirective = async (surface: QualityInspectDirectiveSurface): Promise<void> => {
    try {
      // QD anti-loop (owner m-178/m-182): the QH's OWN sleep is NOT part of the
      // 100% head-inspect mandate — a 'head-slept' surface whose headPostId is
      // 'quality-head' is gated by the SAME worker dice (D-Q2, default 0.25), so
      // the "QH sleeps each round → q-i → QH wakes → QH sleeps again" feedback
      // cannot recur. ANY OTHER head (and the host rotation, which is not the
      // QH) stays at 100% structural-true. The ENV override affects only the
      // probability path (the QH dice + worker dice), never a non-QH head
      // mandate. The directive gate lives HERE (the surface already carries
      // headPostId); a missed dice simply drops the directive — the dept_sleep
      // still commits.
      // B1 batch bypass: the org-wide `dept_sleep_all` orchestration calls
      // `lifecycle.sleepAll`, which NEVER invokes this emitter (it marks every
      // configured NON-QH head in ONE write and emits ZERO per-head directives)
      // — a batch that slept N heads must not re-wake the QD inspector once per
      // head (the D-Q7 anti-loop). The SINGLE-agent `dept_sleep` path
      // (`sleepMember`) STILL emits its per-head directive here — untouched.
      if (surface.kind === 'head-slept' && !qualityInspectDecision('head', { headPostId: surface.headPostId, rng: Math.random, workerInspectProbability: qualityWorkerInspectProbability })) {
        return
      }
      const qualityHead = resolveQualityHeadEntry()
      if (qualityHead === undefined) return
      const store = await messagesStoreReady
      const text = qualityInspectDirectiveText(surface)
      const record = await store.append({ from: 'deepartments', to: ['quality-head'], text, kind: 'agent' })
      await busDeliverToPost(qualityHead, `[From deepartments → quality-head]: ${text}`, record, void 0)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] quality-inspect directive to "quality-head" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- fb-11: the ROTATION-SUCCESSOR AUTO-WAKE (the host-rotation no-wake
  // defect, QH fb-11) ----------------------------------------------
  // After `runHostRotation` commits (S3/S7 — the NEW hosts.json live entry
  // exists), the new host session is COLD: registered + workspace-attached +
  // artifact-persisted, but NOTHING materializes it — it waits for the first
  // EXTERNAL wake, so an org at rest parks the host (and the governance)
  // indefinitely (evidence: 5c5fc173→024447d9, 2m47s of gap; structural in
  // the 3 prior rotations). This closure is the bundle-side TRANSPORT of the
  // lifecycle's `enqueueHostWake` seam (the lifecycle owns the SEMANTIC MOMENT
  // — the commit; this owns the HOW): it appends a DURABLE 'rotation-wake'
  // bus record from 'deepartments' to the NEW host id and delivers it via the
  // D4 host delivery — the SAME dormant-host resume seam external traffic
  // uses (`busDeliverToHost` → `agents.resume` + followup), so the new session
  // starts its first turn with the wake pack / the new sessionId identity and
  // NO external traffic; journal/handoff untouched (the rotation already
  // re-keyed).
  // Write-ahead + exactly-once (mission test 4): the record is flushed to
  // messages.jsonl BEFORE the delivery (durable-first, the store's own
  // persist-before-deliver contract), the delivery is attempted exactly ONCE
  // and NO delivery-sidecar row is written — deliberately mirroring the QD-
  // directive daemon-notify pattern (maybeEmitQualityInspectDirective above:
  // store.append + DIRECT busDeliverToPost). The delivery-engine route is NOT
  // usable here: `deliverOrQueue`'s defensive ACL gate would DENY a
  // 'deepartments'-from record (an unclassified sender — acl.ts
  // 'unclassified-sender', delivery.ts catalogRoute), and a sidecar
  // 'prepared' row would make the BOOT re-delivery pass re-drive it through
  // that same denied route → a 'failed' row the W6 health scan re-alerts on
  // every boot. With NO sidecar row there is no boot re-drive and no W6
  // anomaly: one record, one delivery, no double tuple. A delivery failure
  // only warns (the rotation already committed; a later external wake or boot
  // resumes the host — crash windows spec 002 §3.6). NEVER throws.
  const enqueueHostWake = async (wake: { newHostId: string; newSessionId: string; sleepEpoch: number }): Promise<void> => {
    if (agents === void 0) return
    try {
      const text = `[deepartments] host session rotation complete (spec 002): session ${wake.newSessionId} is now the registered host (sleepEpoch ${wake.sleepEpoch}); the rotation persisted your re-keyed journal and archived the previous session whole; this is the rotation's OWN successor handoff — no external traffic. Start your turn and run your wake routine.`
      // Durable FIRST (write-ahead): the record is on disk before any delivery
      // (MessagesStore.append flushes awaited — persist-before-deliver).
      const store = await messagesStoreReady
      const record = await store.append({ from: 'deepartments', to: [wake.newHostId], text, kind: 'notice' })
      const hostEntry = hosts.get(wake.newHostId)
      if (hostEntry === void 0) {
        ctx.logger.warn(`[deepartments] rotation wake: new host entry "${wake.newHostId}" not found in the in-memory registry (record ${record.id} stays durable)`)
        return
      }
      const framed = `[From deepartments → ${wake.newHostId}]: ${text}`
      await busDeliverToHost(hostEntry as HostEntry, framed, record, void 0)
      ctx.logger.info?.(`[deepartments] rotation wake: delivered to the new host ${wake.newHostId} (record ${record.id}; session ${wake.newSessionId} started its first turn)`)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] rotation wake failed (non-fatal — the rotation already committed; a later external wake or boot resumes the host): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- FASE 2 STEP f (lifecycle carve) ---------------------------------------
  // The dept_sleep / dept_memo_write SEMANTICS are owned by the core lifecycle
  // service (./core/lifecycle.js): the sleepEpoch marking policy + idempotent
  // re-issue no-op + journal requirement, the host-rotation decision (delegating
  // to ./core/session-rotation.js), and the journal/archive policy. The TOOLS
  // below still register here (their MODEL-FACING contract is unchanged) but now
  // DELEGATE to `lifecycle`. ONE service per apply, deps injected from these
  // closures (AGENTS.md rule 4 — no module-global mutable state). The service is
  // constructed AFTER every closure it consumes is defined (this point); the
  // tool `execute` handlers reference `lifecycle` lazily, so even the earlier
  // head own-layer registrations (installHeadBoardTools) bind it correctly at
  // tool-call time.
  // FASE 2.5 BATCH B: consume the lifecycle SERVICE from dshd-core when composed;
  // fall back to a behavior-neutral in-bundle construction + warn in a minimal
  // composition (dshd-core absent).
  const lifecycle = (ctx.get('deepartments.lifecycle') as LifecycleService | undefined) ?? (() => {
    ctx.logger.warn('[deepartments] dshd-core is not composed — the lifecycle service is constructed in-bundle (behavior-neutral fallback).')
    return createLifecycleService({
      byPost,
      hosts,
      hostForSession,
      postIdForChild,
      hostIdForSession,
      ensureHost,
      persistPosts,
      persistHosts,
      journalPath: (memberId) => journalPathFor(memberId),
      writeJournal,
      readJournal,
      bumpHostSleepCounter,
      bumpPostSleepCounter,
      archivePostSessionOnSleep,
      disposeHeadHandleOnce,
      maybeEmitQualityInspectDirective,
      runHostRotation,
      // fb-11 — the ROTATION-SUCCESSOR AUTO-WAKE seam (bundle transport).
      enqueueHostWake,
      deptGet: (key) => ctx.get(key),
      stateDir: stateDir,
      deferredSleepReplace,
      wakePackInjected,
      buildSleepJournalMessage,
      logger: ctx.logger
    })
  })()

  // --- F2 (spec 004 §5.6): messaging ACL by department — catalog route ONLY --
  // THE FRONTIER (documented, per spec §5.6): the ACL gates ONLY the catalog
  // route. The CHILD route (subagents.followup — the Asistente's transient
  // builders/reviewers) is OUTSIDE the ACL: children are never catalog
  // members (the router decides child-first precisely because the two id sets
  // are disjoint), so they can never reach a check below; department workers
  // are ROOT catalog agents (never children), so the ACL always applies to
  // them. 'self' is always allowed (held by the ack-loop guard, never woken).
  // The SAME pure predicate gates (1) the send_message persist filter — the
  // record's to[] is ONLY the ACL-allowed recipients (the denied never touch
  // the record or the delivery sidecar, per spec §5.6 the denied surface only
  // in the tool result) — and (2) the catalog delivery seam (defensively, so
  // a boot re-delivery of a PRE-ACL record can never bypass the gate).
  // NOTE: `BusMemberProfile` / `BusSendResult` are imported from ./core/delivery.js
  // (step c). The ACL SEMANTICS (busProfileFor / aclDenyGround) live in the PURE
  // ./core/acl.js (FASE 2 step d) — the catalog-route-only predicate is NOT
  // INLINE here anymore. invoke.ts binds the apply catalog (the durable
  // posts/hosts registries + the config department resolver) onto the pure
  // `busProfileFor` and consumes the pure `aclDenyGround` directly; the
  // delivery engine (delivery.ts) re-checks the SAME pure predicate defensively.
  // FASE 2.6-C: consume the dshd-core ACL SERVICE when composed — the core ACL
  // is fed the SAME departments mirror (relocated to the dshd-core config in
  // 2.6-A), so it is BEHAVIOR-IDENTICAL (same grounds 'host' /
  // 'other-department' / 'unclassified'; worker→host PROHIBIDO intact). The
  // bundle keeps its own busCatalogLens/busProfileFor ACL as the fallback in a
  // minimal composition (dshd-core absent).
  const aclService = ctx.get('deepartments.acl') as AclSurface | undefined
  const busCatalogLens: BusCatalogLens = { byPost, hosts, departmentForPost }
  const busProfileFor = aclService?.busProfileFor ?? ((memberId: string): BusMemberProfile => aclBusProfileFor(memberId, busCatalogLens))
  const aclDenyGround = aclService?.aclDenyGround ?? aclDenyGroundImpl

  /** The bus catalog-route resolver (spec §4.2 route 2): resolve a recipient
   * against the DURABLE catalog — posts.json (head/worker) then non-retired
   * hosts.json — PLUS the Issue-1 (owner m-331) host-family re-route: a
   * `host-…` address that resolves to a RETIRED / UNRESOLVABLE KNOWN host entry
   * is re-resolved DURABLE-FIRST to the CURRENT LIVE host
   * (pickLiveHostEntry from a FRESH hosts.json read) ONLY when the address is a
   * REAL host id in hosts.json. ALTO-2 (m-891): a `host-*` id ABSENT from
   * hosts.json — a typo / never-registered uuid — resolves UNKNOWN → the
   * delivery engine settles 'failed' per-recipient (the ghost-delivery fix);
   * `host-session-<uuid>` means "the Asistente" (role) ONLY for a genuinely
   * registered (live or retired) host id, so the m-331 re-route still honors
   * the sender's intent for real hosts; W7 (a retired host is terminal) is NOT
   * revoked, it stays for NON-host-family ids.
   * This resolver returns the candidate entry WITHOUT applying the ACL / retired
   * gates — the DELIVERY ENGINE (./core/delivery.js) owns those (the defensive
   * gate, step (c)). `{ kind: 'unknown' }` = no catalog member / not re-routable
   * (the message settles 'failed' as today — no retry loop).
   * TODO(owner): stable host alias. */
  const resolveBusCatalogRoute = (recipientId: string): CatalogRoute => {
    const entry = byPost.get(recipientId)
    if (entry !== void 0) return { kind: 'post', entry }
    const hostEntry = hosts.get(recipientId)
    if (hostEntry !== void 0 && hostEntry.retired !== true) return { kind: 'host', entry: hostEntry }
    if (recipientId.startsWith(HOST_ID_PREFIX)) {
      // ALTO-2 (m-891, QD audit 2026-08-28 F2 — ghost delivery): the Issue-1
      // host-family re-route fires ONLY for a `host-…` address that is a KNOWN
      // host id in the durable hosts.json — a LIVE entry matched above, or a
      // RETIRED real entry (the m-331 role-intent re-route: `host-session-<uuid>`
      // means "the Asistente", so a REAL formerly-valid host id is re-routed to
      // the current live host). A `host-*` id ABSENT from hosts.json — a typo /
      // never-registered uuid (m-891 sent to '…ea3232b' vs the real '…ea32b') —
      // is NOT the Asistente's address: it resolves UNKNOWN, so the delivery
      // engine settles 'failed' per-recipient exactly like an unknown post — NO
      // prepared→delivered ghost, no silent content loss. The m-380 thread (an
      // unknown non-host session id → failed) is the same 'unknown' path,
      // untouched.
      const durableHosts = readDurableHostEntries(stateDir)
      const registry = durableHosts ?? [...hosts.values()]
      const known = registry.some((host) => host.hostId === recipientId)
      if (known) {
        const { live } = pickLiveHostEntry(registry)
        if (live !== void 0) return { kind: 'reroute', entry: live as HostEntry }
      }
    }
    return { kind: 'unknown' }
  }

  /**
   * Deliver ONE addressed record to ONE recipient and record the sidecar
   * transition (write-ahead 'prepared' → final status; spec §4.4) — a THIN
   * wrapper over the DELIVERY ENGINE's single seam (`delivery.deliverOrQueue`,
   * FASE 2 step (c)). Kept with the legacy signature so the internal callers
   * (dept_job_run / dept_worker_spawn / dept_post_create first-message
   * deliveries + the boot re-delivery driver) route through the SAME gate; NEW
   * code should call `delivery.deliverOrQueue` directly. THIS is the idempotent
   * re-delivery unit: send_message calls it after persisting, and the boot
   * re-delivery driver re-runs it for crash-pending pairs. Route order per
   * recipient (spec §4.2): child route FIRST (the caller's direct continuable
   * children — never validated against the catalog), then the catalog
   * (posts.json ∪ non-retired hosts.json); unknown ids → failed. `opts.noWake`
   * (B2) is threaded through so an internal caller can set it, but the CURRENT
   * default (absent = always-wake) is unchanged — only threading the option.
   */
  const deliverBusRecord = async (
    record: MessageRecord,
    recipientId: string,
    callerAgentId: string,
    senderSessionId: string | undefined,
    signal?: AbortSignal,
    opts?: DeliveryInterruptOptions & { noWake?: boolean }
  ): Promise<DeliveryStatus> =>
    delivery.deliverOrQueue(recipientId, record, {
      callerAgentId,
      senderSessionId,
      signal,
      interrupt: opts?.interrupt,
      noWake: opts?.noWake
    })

  /** The live parent Agent for the native-route followup (the caller is the
   * direct parent, per the route resolution above). Resolved from the agents
   * registry — `exec.agent` is not retained past the tool execute frame. */
  const exec_agentFor = (sessionId: string): AgentLike => {
    const parent = agents?.get(sessionId)
    if (parent === void 0) throw new Error(`[deepartments] bus child route requires the live caller agent "${sessionId}"`)
    return parent
  }

  /** The caller's BUS member id (spec §3.1: durable member id, never a session
   * id): the postId for a registered head/worker, else the deterministic
   * `host-<sessionId>` id for a host/plain session. */
  const busMemberIdFor = (agentId: string): string => postIdForChild(agentId) ?? hostIdForSession(agentId)

  // --- FASE 2 step (c): the DELIVERY ENGINE (./core/delivery.js) -------------
  // The single bus delivery seam. The engine owns the `deliverOrQueue` gate +
  // the per-recipient delivery orchestration (write-ahead 'prepared' → route →
  // final), the catalog route, the defensive ACL application, and the `noWake`
  // gate (INERT today). The CLOSURE-BOUND primitives below are INJECTED as deps:
  // the child route (resolveBusChild / deliverBusChild), the catalog resolver
  // (resolveBusCatalogRoute), the ACL predicate (the pure busProfileFor /
  // aclDenyGround from ./core/acl.js — FASE 2 step (d); invoke.ts binds the
  // catalog lens onto `busProfileFor`), and the always-wake primitives
  // (busDeliverToPost / busDeliverToHost). Constructed ONCE per apply
  // (AGENTS.md rule 4).

  /** Resolve whether `recipientId` is the caller's direct CONTINUABLE child
   * (delivered natively, never catalog-validated). Never throws — a listing
   * failure (minimal composition) means "not a child", the catalog route next. */
  const resolveBusChild = async (recipientId: string, callerAgentId: string, signal?: AbortSignal): Promise<boolean> => {
    if (subagents === void 0) return false
    try {
      const children = await subagents.listChildren(SessionId(callerAgentId), signal ?? undefined)
      return children.some((child) => child.kind === 'child' && child.mode === 'continuable' && String(child.id) === recipientId)
    } catch {
      // listing unavailable (minimal composition): no child route — catalog next
      return false
    }
  }

  /** Deliver ONE bus message to a continuable child (native followup). Returns
   * 'delivered' or 'failed' (never throws). W9-b interrupt is NOT threaded into
   * the child route (a continuable child has no abort seam here — children are
   * always queue-delivered). */
  const deliverBusChild = async (callerAgentId: string, recipientId: string, record: MessageRecord, framed: string, senderSessionId: string | undefined, signal?: AbortSignal): Promise<DeliveryStatus> => {
    if (subagents === void 0) return 'failed'
    try {
      await subagents.followup(
        await exec_agentFor(callerAgentId) as unknown as Parameters<typeof subagents.followup>[0],
        SessionId(recipientId),
        // W8-b prompt-literal safety: the child-followup text (bus message
        // content injected into a continuable child) is run through the brace
        // sanitizer so an unbound double-brace token can never break the child
        // session assembly.
        [{ type: 'text', text: sanitizePromptLiterals(framed) } as const],
        {
          // W7-B: the SAME JSON-safe projection as `busUserMessage` — the
          // child-followup source is inserted into a durable session too, so a
          // present-undefined `senderSessionId` / branded value must never reach
          // the `agent/inbox/spliced` append boundary.
          source: jsonSafeMessageSource({
            kind: 'agent',
            form: 'send',
            plugin: 'deepartments',
            summary: boundContextSummary(`New message from ${record.from} to ${record.to.length} recipient(s) (${record.kind}).`),
            to: [...record.to],
            messageId: record.id,
            from: record.from,
            senderSessionId: senderSessionId === undefined ? undefined : SessionId(senderSessionId)
          }),
          // A bare { agent, signal } tool exec is the test surface; the
          // ABORT_SIGNAL default is never reached in production harness runs
          // (exec.signal is always present there).
          signal: signal ?? new AbortController().signal
        }
      )
      return 'delivered'
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] bus child-followup to "${recipientId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    }
  }

  /** The delivery engine: the SINGLE bus delivery seam (constructed once per
   * apply, deps injected — AGENTS.md rule 4, no module-global mutable state).
   * Consumed by send_message (directly) and by the `deliverBusRecord` wrapper
   * (dept_job_run / dept_worker_spawn / dept_post_create + the boot re-delivery
   * driver). FASE 2.5 BATCH B: consume the delivery SERVICE from dshd-core when
   * composed; fall back to a behavior-neutral in-bundle construction + warn in a
   * minimal composition (dshd-core absent). */
  const delivery = (ctx.get('deepartments.deliver') as DeliveryEngine | undefined) ?? (() => {
    ctx.logger.warn('[deepartments] dshd-core is not composed — the delivery engine is constructed in-bundle (behavior-neutral fallback).')
    return createDeliveryEngine({
      stateDir: messageStoreDir,
      logger: ctx.logger,
      markPrepared: (record, recipientId) => markDelivery(messageStoreDir, record.id, recipientId, 'prepared'),
      markFinal: (record, recipientId, status) => markDelivery(messageStoreDir, record.id, recipientId, status),
      subagents,
      resolveChild: resolveBusChild,
      deliverChild: deliverBusChild,
      resolveCatalogRoute: resolveBusCatalogRoute,
      busProfileFor,
      deliverPost: busDeliverToPost,
      deliverHost: busDeliverToHost
    })
  })()

  /** B3 (m-361): whether a CATALOG recipient is DORMANT — its durable entry
   * (posts.json `byPost` OR hosts.json `hosts`) carries a `sleepEpoch` mark
   * (deliberately asleep by a sleep directive; its pending queue drains at its
   * next real wake). A child-route / unknown recipient has NO catalog entry →
   * never dormant (a transient subagent or unknown id is never no-waked by B3).
   * Used by send_message to no-wake ONLY the ack to a just-slept head — the
   * m-361 regression where a QD ack re-woke a head that had just dept_slept. */
  const isDormantRecipient = (recipientId: string): boolean => {
    const post = byPost.get(recipientId)
    if (post !== void 0) return post.sleepEpoch !== void 0
    const host = hosts.get(recipientId)
    return host !== void 0 && host.sleepEpoch !== void 0
  }

  /** B3 gap fix (reviewer B2 note a): with the board gone, the host's
   * auto-registration must not depend on board tools. For every host-family
   * caller (no post entry; NOT a transient subagent) dept_who / send_message
   * run ensureHost(self) — idempotent: a first registration (no host in
   * hosts.json) registers the caller; a refresh of an existing live entry
   * MERGES (rotation metadata preserved); and the single-live-host guard
   * inside ensureHost means a second live host is NEVER minted (a refused
   * session stays a plain session, with the guard warn). Returns the
   * caller's member id. */
  const busEnsureHostForCaller = (callerAgent: { id: string; session?: { header?: SessionHeaderWithOrigin } }): string => {
    const agentId = callerAgent.id
    const postId = postIdForChild(agentId)
    if (postId !== undefined) return postId
    // A transient subagent is never a host session (origin subagent).
    const header = callerAgent.session?.header
    const origin = header?.origin ?? header?.meta?.origin
    if (origin !== 'subagent') {
      ensureHost(agentId, 'board')
    }
    return hostIdForSession(agentId)
  }

  /** Shared framing for every bus deliver (spec §4.3): the GUI never renders
   * `to[]`, so sender + recipients MUST be in the model-facing text. */
  const busFraming = (record: MessageRecord): string =>
    `[From ${record.from} → ${record.to.join(', ')}]: ${record.text}`

  /** The 1..20 fan-out guard (spec §4.4): the JSON schema subset cannot express
   * minItems/maxItems, so the cap is enforced here — a hard error above 20. */
  const assertBusFanOut = (to: readonly string[]): number => {
    if (!Array.isArray(to) || to.length === 0) throw new Error('[deepartments] send_message: `to` must list at least one recipient')
    if (to.length > 20) throw new Error(`[deepartments] send_message: fan-out cap is 20 recipients (got ${to.length})`)
    return to.length
  }

  // --- messaging bus TOOL DEFINITIONS (ONE body per tool; registered in the
  // post OWN layer + the host agent's own layer + (when the name is free) the
  // GLOBAL host plane — see the override note before the registrations).
  // ---------------------------------------------------------------------------

  // --- dshd-feedback TOOL DEFINITIONS (ONE body per tool; registered in the
  // post OWN layer (universal — ANY agent may emit feedback) + the GLOBAL host
  // plane. The QH-authority of `dept_feedback_update` is enforced in `execute`.
  // The store is the dshd-feedback library FeedbackStore (opened per-apply).
  // ---------------------------------------------------------------------------

  /** The FeedbackRecord output JSON schema (shared by the 3 feedback tools). */
  const feedbackRecordSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      createdAt: { type: 'number', required: true },
      updatedAt: { type: 'number', required: true },
      emisor: { type: 'string', required: true },
      source: { type: 'string', required: true },
      tipo: { type: 'string', required: true },
      severidad: { type: 'string', required: true },
      estado: { type: 'string', required: true },
      resumen: { type: 'string', required: true },
      archivo_linea: { type: 'string' },
      event: { type: 'string' },
      evidencia: { type: 'string' },
      notas_qh: { type: 'string' },
      report_path: { type: 'string' },
      escalado: { type: 'boolean' },
      escalado_a: { type: 'string' },
      cerrado_por: { type: 'string' }
    }
  } as const

  /** `dept_feedback` — the universal feedback emitter (R7): ANY agent (worker /
   * head / host) writes a durable feedback record to the FeedbackStore and
   * notifies quality-head severity-gated via `deliverOrQueue` (record.from is an
   * ACL-legal FORWARDER — head/host self, worker = its manager or dept
   * coordinator; the real emisor travels in the record + the body). */
  const feedbackTool = defineTool({
    name: 'dept_feedback',
    description: 'Emit a quality/feedback record to the durable feedback backlog (the quality-head backlog). ANY agent — a worker, a department head, or the host — may send; the record.write is ACL-free. `tipo` = the kind ("fallo" | "mejora"); `severidad` = priority ("critico" | "alto" | "medio" | "bajo"); `resumen` = the one-line summary (required); `evidencia`/`archivo_linea` = optional supporting detail. The record is written to <stateDir>/feedback.jsonl with estado "abierto" (emisor = YOU) and the quality-head is notified SEVERITY-GATED: critico → wake + interrupt; alto → wake; medio/bajo/mejora → no-wake queue. The notification is ACL-legal (a worker forwards via its head; the real emisor is in the record + body). Returns the created FeedbackRecord (id included).',
    parameters: {
      tipo: { type: 'string', required: true, description: 'The feedback type: "fallo" (defect) | "mejora" (improvement).' },
      severidad: { type: 'string', required: true, description: 'The priority: "critico" | "alto" | "medio" | "bajo".' },
      resumen: { type: 'string', required: true, description: 'The one-line summary (non-empty).' },
      evidencia: { type: 'string', description: 'Optional supporting evidence/snippet.' },
      archivo_linea: { type: 'string', description: 'Optional file:line reference (e.g. src/invoke.ts:1234).' }
    },
    output: { schema: feedbackRecordSchema, render: feedbackRecordRender },
    async execute(args, exec): Promise<FeedbackRecord> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_feedback requires a calling agent (exec.agent was undefined)')
      const emisor = busMemberIdFor(agent.id as string)
      const tipo = String(args.tipo).trim() as FeedbackTipo
      const severidad = String(args.severidad).trim() as FeedbackSeveridad
      const resumen = String(args.resumen).trim()
      const store = await feedbackStoreReady
      const input: FeedbackInput = { emisor, tipo, severidad, resumen }
      const evidencia = args.evidencia === undefined ? undefined : String(args.evidencia).trim()
      const archivo_linea = args.archivo_linea === undefined ? undefined : String(args.archivo_linea).trim()
      if (evidencia !== undefined && evidencia !== '') input.evidencia = evidencia
      if (archivo_linea !== undefined && archivo_linea !== '') input.archivo_linea = archivo_linea
      const record = await store.append(input)
      // R7 — notify quality-head severity-gated (fire-and-forget; the feedback
      // record is durable regardless of the notification outcome).
      const qualityHead = resolveQualityHeadEntry()
      if (qualityHead !== undefined) {
        const forwarder = feedbackForwarderFor(emisor)
        const text = `[dept_feedback ${severidad}/${tipo} from ${emisor}]: ${resumen}` +
          (evidencia !== undefined && evidencia !== '' ? `\nEvidencia: ${evidencia}` : '') +
          (archivo_linea !== undefined && archivo_linea !== '' ? `\n${archivo_linea}` : '')
        const deliverOpts = feedbackDeliveryOptions(tipo, severidad)
        try {
          const messageStore = await messagesStoreReady
          if (forwarder !== undefined) {
            const notifRecord = await messageStore.append({ from: forwarder, to: ['quality-head'], text, kind: 'agent' })
            const status = await delivery.deliverOrQueue('quality-head', notifRecord, {
              callerAgentId: agent.id as string,
              senderSessionId: agent.id as string,
              signal: exec.signal,
              ...deliverOpts
            })
            if (status === 'failed') ctx.logger.warn(`[deepartments] dept_feedback notification to quality-head failed (${status}) — feedback ${record.id} is durable`)
          } else {
            // No ACL-legal forwarder: fall back to the direct QD seam (the
            // QD-directive precedent — bypasses the delivery-engine ACL).
            const notifRecord = await messageStore.append({ from: 'deepartments', to: ['quality-head'], text, kind: 'agent' })
            await busDeliverToPost(qualityHead, `[From deepartments → quality-head]: ${text}`, notifRecord, void 0)
          }
        } catch (error: unknown) {
          ctx.logger.warn(`[deepartments] dept_feedback notification to quality-head failed (non-fatal — the feedback record is durable): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return record
    }
  })

  /** `dept_feedback_list` — surfacing (read-only). fb-18 (QH backlog): the tool
   * registers ONLY in a HEAD's own layer + the host plane — a WORKER never sees
   * it (structural absence); the execute-side worker reject below stays as
   * defense-in-depth (a legacy/hosted copy called with a worker agent). */
  const feedbackListTool = defineTool({
    name: 'dept_feedback_list',
    description: 'Surface the durable feedback backlog (read-only). Lists the LIVE feedback records (latest tail per id), optionally filtered by `estado`/`severidad`/`tipo`/`emisor`, sorted severity desc then createdAt asc, paged (default 20, cap 100) with an exclusive `cursor` id (the previous page\'s last id). Available to department heads (incl. quality-head) and the host — a WORKER never sees the tool (it is not in the worker toolset, fb-18). Returns {total, items, remaining, cursor?}.',
    parameters: {
      estado: { type: 'string', description: 'Filter by estado: "abierto" | "en-estudio" | "resuelto" | "descartado".' },
      severidad: { type: 'string', description: 'Filter by severidad: "critico" | "alto" | "medio" | "bajo".' },
      tipo: { type: 'string', description: 'Filter by tipo: "fallo" | "mejora".' },
      emisor: { type: 'string', description: 'Filter by the emitter member id.' },
      cursor: { type: 'string', description: 'Optional exclusive cursor: a feedback record id (the previous page\'s last id).' },
      limit: { type: 'number', description: 'Optional page size (default 20, cap 100).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          items: { type: 'array', required: true, items: feedbackRecordSchema },
          remaining: { type: 'number', required: true },
          cursor: { type: 'string' }
        }
      },
      render: (_args, value) => {
        const head = `feedback backlog (${value.total} total, showing ${value.items.length}${value.remaining > 0 ? `, ${value.remaining} more${value.cursor !== void 0 ? ` (cursor ${value.cursor})` : ''}` : ''}):`
        if (value.items.length === 0) return [{ type: 'text', text: `${head}\n  (no matching feedback records)` } as const]
        const lines = value.items.map((r) => `  - ${r.id} [${r.severidad}] ${r.tipo} ${r.estado} ${r.emisor}: ${r.resumen}`)
        return [{ type: 'text', text: `${head}\n${lines.join('\n')}` } as const]
      }
    },
    async execute(args, exec): Promise<FeedbackListResult> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_feedback_list requires a calling agent (exec.agent was undefined)')
      const postId = postIdForChild(agent.id as string)
      if (postId !== void 0 && byPost.get(postId)?.provider === 'worker') {
        throw new Error('[deepartments] dept_feedback_list is read-only for department HEADS (incl. quality-head) and the host, not a worker')
      }
      const store = await feedbackStoreReady
      const opts: FeedbackListOptions = {}
      const estado = String(args.estado ?? '').trim()
      const severidad = String(args.severidad ?? '').trim()
      const tipo = String(args.tipo ?? '').trim()
      const emisor = String(args.emisor ?? '').trim()
      const cursor = String(args.cursor ?? '').trim()
      if (estado !== '') opts.estado = estado as FeedbackEstado
      if (severidad !== '') opts.severidad = severidad as FeedbackSeveridad
      if (tipo !== '') opts.tipo = tipo as FeedbackTipo
      if (emisor !== '') opts.emisor = emisor
      if (cursor !== '') opts.cursor = cursor
      if (args.limit !== undefined) opts.limit = args.limit as number
      return store.list(opts)
    }
  })

  /** `dept_feedback_update` — append-only state transition (m-371). AUTHORITY:
   * only quality-head may move a record to a TERMINAL estado (resuelto |
   * descartado — stamping `cerrado_por` = the caller); a non-QH head may set
   * `en-estudio`; a reopen (estado → abierto) is only legal from `en-estudio`
   * and ONLY for quality-head, never from a terminal state. Each change is a NEW
   * tail line (same id, updatedAt, estado) — append-only, no in-place edit. */
  const feedbackUpdateTool = defineTool({
    name: 'dept_feedback_update',
    description: 'Transition the state of one durable feedback record (append-only): each change appends a NEW tail line with the SAME id, a bumped `updatedAt`, and the new `estado`. AUTHORITY (spec §4): only `quality-head` may pass a record to a TERMINAL estado (`resuelto` | `descartado` — it stamps `cerrado_por` = the caller); a department head (non-QH) may set `en-estudio`; a reopen (`estado` → `abierto`) is legal only from `en-estudio` (with new evidence) and ONLY for quality-head, and is NEVER allowed from a terminal state. `notas_qh`/`escalado`/`escalado_a` are metadata update fields. WORKER callers are rejected. Returns the updated FeedbackRecord.',
    parameters: {
      id: { type: 'string', required: true, description: 'The feedback record id (fb-<seq>).' },
      estado: { type: 'string', description: 'The target estado: "abierto" | "en-estudio" | "resuelto" | "descartado".' },
      notas_qh: { type: 'string', description: 'Quality-head notes on the record.' },
      escalado: { type: 'boolean', description: 'Mark the record as escalated.' },
      escalado_a: { type: 'string', description: 'Who/where the record was escalated to.' }
    },
    output: { schema: feedbackRecordSchema, render: feedbackUpdateRender },
    async execute(args, exec): Promise<FeedbackRecord> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_feedback_update requires a calling agent (exec.agent was undefined)')
      const postId = postIdForChild(agent.id as string)
      if (postId !== void 0 && byPost.get(postId)?.provider === 'worker') {
        throw new Error('[deepartments] dept_feedback_update is for department HEADS (incl. quality-head) and the host, not a worker')
      }
      const memberId = busMemberIdFor(agent.id as string)
      const isQh = memberId === 'quality-head'
      const store = await feedbackStoreReady
      const id = String(args.id ?? '').trim()
      if (id === '') throw new Error('[deepartments] dept_feedback_update: `id` is required')
      const current = store.get(id)
      if (current === undefined) throw new Error(`[deepartments] dept_feedback_update: no feedback record with id "${id}"`)
      const input: FeedbackUpdateInput = {}
      const estadoRaw = String(args.estado ?? '').trim()
      if (estadoRaw !== '') {
        const estado = estadoRaw as FeedbackEstado
        if (isTerminalEstado(estado)) {
          if (!isQh) throw new Error('[deepartments] dept_feedback_update: only quality-head may move feedback to a TERMINAL estado (resuelto | descartado)')
        } else if (estado === 'abierto') {
          if (!isQh) throw new Error('[deepartments] dept_feedback_update: only quality-head may reopen feedback (en-estudio → abierto, with new evidence)')
        }
        input.estado = estado
      }
      if (args.notas_qh !== undefined) input.notas_qh = String(args.notas_qh)
      if (args.escalado !== undefined) input.escalado = args.escalado === true
      if (args.escalado_a !== undefined) input.escalado_a = String(args.escalado_a)
      return store.update(id, input, isQh ? { cerradoPor: memberId } : {})
    }
  })

  const feedbackEmitTools: readonly ReturnType<typeof defineTool>[] = [feedbackTool]
  const feedbackHeadTools: readonly ReturnType<typeof defineTool>[] = [feedbackListTool, feedbackUpdateTool]

  /** Shared render for a single FeedbackRecord (create/update). */
  function feedbackRecordRender(_args: unknown, value: FeedbackRecord) {
    return [{ type: 'text', text: `feedback ${value.id} ${value.estado} (${value.severidad}/${value.tipo} from ${value.emisor}): ${value.resumen}${value.cerrado_por !== void 0 ? ` — closed by ${value.cerrado_por}` : ''}` } as const]
  }

  /** Shared render for the update tool (append-only transition result). */
  function feedbackUpdateRender(_args: unknown, value: FeedbackRecord) {
    return [{ type: 'text', text: `feedback ${value.id} → ${value.estado}${value.cerrado_por !== void 0 ? ` (closed by ${value.cerrado_por})` : ''}` } as const]
  }

  /** `send_message` — the unified plugin-owned tool (spec §4). NEVER registers
   * globally when the harness native owns the name (dsh-tool-subagent-control);
   * the own-layer registrations SHADOW the native for every deepartments agent
   * ("Scoped tools shadow globals" — the harness's supported override seam:
   * a same-layer duplicate throws, there is no replace). */
  const sendMessageTool = defineTool({
    name: 'send_message',
    description: 'Send a message to one or more background agents and/or organization members, delivering it as the recipient\'s next turn and ALWAYS waking the recipient (including a dormant/host target). Recipients are resolved per id: (1) your direct continuable background children are delivered natively (parent→child followup, never catalog-validated); (2) everything else is resolved against the organization catalog (department heads/workers + the Asistente host) and delivered through the durable message store — the record is persisted BEFORE any delivery and delivery state is tracked in a write-ahead sidecar, so a crash re-delivers idempotently. A `host-session-*` address is validated against hosts.json (non-retired); a typo/never-registered host id fails per-recipient like any unknown id. Unknown ids are reported per-recipient as failed (one typo does not kill a multi-recipient send). A self-addressed recipient (your own id) is held ("self" — persisted, never woken). W9-b `interrupt: true` (optional, default false): a recipient LIVE mid-turn has its CURRENT turn ABORTED (reason "interrupted", pending work preserved) and the message is the FIRST item of its next turn — the harness abort/stop API (Agent.cancel with keepInbox) is the seam; default false keeps QUEUE semantics (zero regression). DEPARTMENT MESSAGING ACL (spec 004 §5.6): the Asistente (host) may send to everyone; a department head may send to any head (incl. the Asistente) and to the agents of its OWN department; a WORKER may send ONLY to the agents of its own department (incl. its head) — a worker CANNOT write to the host, to other heads, or to other departments (everything goes via its own head). A forbidden recipient is reported per-recipient as `failed:acl:<ground>` and is NOT persisted/delivered (the message is not sent to it; route it via the recipient\'s department head). Max 20 recipients (fan-out cap).',
    parameters: {
      to: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Recipient agent ids: direct background children first, then catalog member ids (use dept_who for the roster). Max 20.'
      },
      text: { type: 'string', required: true, description: 'The message text.' },
      ack: { type: 'boolean', description: 'Set true when this is a pure acknowledgement/receipt (no new content) — recorded kind "ack".' },
      sensitive: { type: 'boolean', description: 'Mark this message as sensitive (trust semantics carried over from the board).' },
      threadId: { type: 'string', description: 'Optional: a message id to reply to (recorded as threadId).' },
      interrupt: { type: 'boolean', description: 'Optional, default false. When true, delivery PREEMPTS a busy recipient: a recipient LIVE mid-turn has its CURRENT turn aborted (reason "interrupted") and the message is the FIRST item of its next turn; a DORMANT recipient still wakes + processes immediately. Default false keeps the QUEUE semantics (enqueued behind the current work) — zero regression for normal flows.' },
      noWake: { type: 'boolean', description: 'Optional, default false (absent). When true, delivery to EVERY allowed recipient persists the message record but does NOT materialize/wake the recipient (the record drains at the recipient\'s next real wake — the no-wake-until-wake send). Default false (absent) = the ALWAYS-WAKE path (zero change to normal sends). NOTE: this is the explicit opt-in gate — the caller must never set it for a legitimate work delivery (a worker report to its manager that must auto-retire is always-wake).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // F2: 'none' when EVERY recipient is outside the sender's ACL —
          // then no record is persisted (the store's to[] cannot be empty)
          // and the delivered map carries only the ACL failures. Real records
          // are always `m-<seq>`, so the sentinel is unambiguous.
          messageId: { type: 'string', required: true },
          delivered: { type: 'object', additionalProperties: true, required: true }
        }
      },
      render: (_args, value) => {
        const lines = Object.entries(value.delivered as Record<string, string>)
        const head = value.messageId === 'none'
          ? 'send blocked by the messaging ACL (every recipient outside your scope; nothing sent or persisted)'
          : lines.length === 0
            ? `sent ${value.messageId}`
            : lines.length === 1
              ? `sent ${value.messageId} → ${lines[0][0]}: ${lines[0][1]}`
              : `sent ${value.messageId} to ${lines.length} recipient(s):`
        const text = lines.length === 0 || lines.length === 1
          ? head
          : `${head}\n${lines.map(([id, status]) => `  - ${id}: ${status}`).join('\n')}`
        return [{ type: 'text', text } as const]
      }
    },
    async execute(args, exec): Promise<{ messageId: string; delivered: Record<string, BusSendResult> }> {
      const agent = exec.agent
      if (!agent) throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      assertBusFanOut(args.to)
      // B3 gap fix: the caller host self-registers when hosts.json has no live
      // host — the catalog (host row, you:true, reply-ability) must stay
      // complete without board tools. Single-live guard respected.
      const from = busEnsureHostForCaller(agent as { id: string; session?: { header?: SessionHeaderWithOrigin } })
      const store = await messagesStoreReady
      // F2 (spec 004 §5.6): the ACL PRE-FILTER — ONLY catalog members are
      // gated (transient children AND unknown ids are not ACL subjects; they
      // keep their existing behavior: native child delivery / per-recipient
      // 'failed'). A denied recipient is reported with `failed:acl:<ground>`
      // and is NEITHER persisted NOR delivered — the record's to[] = ONLY the
      // allowed recipients (persist-before-deliver D4 kept: what is persisted
      // is exactly what will be delivered), so the denied surface exists only
      // in this tool result and the sender (e.g. a head) sees what must be
      // channeled. The catalog route re-checks the same predicate defensively
      // (boot re-delivery of pre-ACL records).
      const sender = busProfileFor(from)
      const allowed: string[] = []
      const delivered: Record<string, BusSendResult> = {}
      for (const recipient of args.to) {
        const ground = aclDenyGround(sender, busProfileFor(recipient))
        if (ground === undefined) {
          allowed.push(recipient)
        } else {
          delivered[recipient] = `failed:acl:${ground}`
          ctx.logger.warn(`[deepartments] send_message ACL denied ${from} → ${recipient} (${ground}) — recipient is outside the sender's messaging scope (spec 004 §5.6); route via its department head`)
        }
      }
      if (allowed.length === 0) {
        // Everything was denied: NOTHING is persisted (the store requires a
        // non-empty to[]) and nothing is delivered. The caller receives the
        // per-recipient ACL reasons under the 'none' sentinel messageId.
        return { messageId: 'none', delivered }
      }
      const record = await store.append({
        from,
        to: allowed,
        text: args.text,
        kind: args.ack === true ? 'ack' : 'agent',
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
        ...(args.sensitive === true ? { sensitive: true } : {})
      })
      // Per-message serialization: deliveries run one at a time (never parallel
      // resume of N dormant agents — quota + race safety, spec §4.4). The SINGLE
      // seam: send_message routes through `delivery.deliverOrQueue` (the bus
      // delivery gate, FASE 2 step c) — default noWake:false = ALWAYS-WAKE, the
      // behavior-neutral path.
      // B2 + B3 (m-361): the per-recipient noWake gate. The EXPLICIT
      // `noWake:true` tool param gates the WHOLE send; otherwise B3 no-wakes
      // ONLY the ack (record kind 'ack') to a DORMANT recipient — a QD ack must
      // never re-wake a just-slept head (the record persists 'prepared' and
      // drains at the recipient's next real wake). A non-ack send, an ack to a
      // non-dormant recipient, and the default (no param) stay ALWAYS-WAKE.
      for (const recipient of allowed) {
        const noWake = args.noWake === true || (args.ack === true && isDormantRecipient(recipient))
        delivered[recipient] = await delivery.deliverOrQueue(recipient, record, {
          callerAgentId: agent.id as string,
          senderSessionId: agent.id as string,
          signal: exec.signal,
          interrupt: args.interrupt === true,
          noWake
        })
      }
      return { messageId: record.id, delivered }
    }
  })

  /** `agent_messages` — the caller's OWN received history (spec §5): records
   * where the caller's member id ∈ to[], newest-first, cursor-paged. NO read/
   * seen marks in this phase (pure history pager — the §5 note). */
  const agentMessagesTool = defineTool({
    name: 'agent_messages',
    description: 'Page your OWN received message history (the durable agent-messaging log): records addressed to you (your member id is in to[]), newest first. Cursor pagination via `before` (a message id, exclusive); no read/seen marks exist in this phase — this is a pure history pager. After a compaction renumbers seqs an old cursor id may clamp to the newest record (the history is still valid, only the cursor was renumbered).',
    parameters: {
      limit: { type: 'number', description: 'Optional: page size (default 10, max 50).' },
      before: { type: 'string', description: 'Optional: exclusive cursor — a message id (m-<seq>); older-only page.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          remaining: { type: 'number', required: true },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                ts: { type: 'number', required: true },
                from: { type: 'string', required: true },
                to: { type: 'array', items: { type: 'string' }, required: true },
                text: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                threadId: { type: 'string' },
                sensitive: { type: 'boolean' }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        const lines = value.messages.map((message) => `- ${message.id} | ${message.from} → ${message.to.join(', ')} | ${message.text.length > 140 ? `${message.text.slice(0, 140)}…` : message.text}`)
        const head = `${value.total} total message(s) addressed to you; showing ${value.messages.length}`
        const tail = value.remaining > 0 ? `\n… (${value.remaining} older; page with before=${value.messages[value.messages.length - 1]?.id})` : ''
        return [{ type: 'text', text: lines.length === 0 ? `${head} — none.` : `${head}:\n${lines.join('\n')}${tail}` } as const]
      }
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('agent_messages requires a calling agent (exec.agent was undefined)')
      const store = await messagesStoreReady
      const memberId = busMemberIdFor(agent.id as string)
      const normalized = Math.min(Math.max(Math.trunc(args.limit ?? 10), 1), 50)
      const page = store.page(memberId, { limit: normalized, before: args.before })
      // Normalize the wire shape to the declared output schema and keep it
      // JSON-lossless (the harness serializes tool results with lossless-json,
      // which REJECTS a property whose value is `undefined`). `threadId: null`
      // is a store-internal absent marker; the tool surface exposes it as
      // ABSENT (the key is omitted entirely) — never `threadId: undefined`.
      // Same for `sensitive` (only present when a real boolean). No property
      // is ever emitted with an undefined/NaN/Infinity value.
      return {
        total: page.total,
        remaining: page.remaining,
        messages: page.messages.map((message) => {
          const item: { id: string; ts: number; from: string; to: string[]; text: string; kind: string; threadId?: string; sensitive?: boolean } = {
            id: message.id,
            ts: message.ts,
            from: message.from,
            to: message.to,
            text: message.text,
            kind: message.kind
          }
          if (typeof message.threadId === 'string') item.threadId = message.threadId
          if (typeof message.sensitive === 'boolean') item.sensitive = message.sensitive
          return item
        })
      }
    }
  })

  /** `dept_who` — the whole catalog in one call (spec §6): the B3 subtraction
   * of the board's room-who and whereami tools is LANDED (this tool is now
   * the sole roster+identity tool). `you: true` marks the caller's own entry.
   * F1 (§4.1/§5.1): the row `kind` is DERIVED — `'worker'` for a disposable
   * worker (provider:'worker'), `'head'` for a configured coordinator. F3
   * (§5.1): WORKER rows additionally carry `departmentId?`/`role?`/`jobId?`
   * (the head manages its workers by filtering departmentId), and RETIRED
   * workers stay LISTED with `retired: true` — the head's management view
   * (the LIVE catalog — busDeliverCatalog addressing — still filters them). */
  const deptWhoTool = defineTool({
    name: 'dept_who',
    description: 'List the whole Deepartments catalog — the Asistente host (kind "host", title "Asistente") and every registered department head/worker with its DERIVED kind (a configured department head is kind "head", a disposable worker is kind "worker"; title from the department configuration, PostEntry.role fallback) — each with a derived per-member life-cycle state (`running` = a turn IN FLIGHT, `idle` = resident with the turn finished, `sleeping` = sleepEpoch set, `offline` = no live session; a single coherent enum so no contradictory "live, sleeping"/"live, retired" render), the live/sleeping markers and session id, and your OWN entry marked you:true. Worker rows additionally carry departmentId/role/jobId (its department template and job link) and RETIRED workers are shown with retired:true (the head\'s management view; a retired worker is NOT addressed by the live catalog — sending to it fails per-recipient). This is the identity + roster tool: learn who exists and who you are in one call. No room parameter — the roster is the organization. The `scope` parameter selects the view: `active` (default) = non-retired rows whose state is {idle, running} PLUS your OWN (you:true) row ALWAYS (even when you are sleeping/offline/retired) — non-caller sleeping/offline rows are HIDDEN (reported via `inactiveHiddenCount`); `all` = the full superset (idle|running|sleeping|offline + retired with retired:true); `includeRetired` is the DEPRECATED COMPAT ALIAS of `all` (kept per R6 — never remove; existing callers/tests keep using it).',
    parameters: {
      scope: { type: 'string', enum: ['active', 'all', 'includeRetired'], default: 'active', description: 'Catalog scope: `active` (default) shows non-retired members whose state is idle|running plus the caller\'s own row (you:true) always; `all` shows the full roster (idle|running|sleeping|offline + retired with retired:true); `includeRetired` is the DEPRECATED COMPAT ALIAS of `all` (kept per R6 — never remove).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          members: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agentId: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                live: { type: 'boolean', required: true },
                sleeping: { type: 'boolean', required: true },
                state: { type: 'string', enum: ['running', 'idle', 'sleeping', 'offline'], required: true },
                sessionId: { type: 'string', required: true },
                you: { type: 'boolean', required: true },
                departmentId: { type: 'string' },
                role: { type: 'string' },
                jobId: { type: 'string' },
                retired: { type: 'boolean' }
              }
            }
          },
          retiredCount: { type: 'integer', required: true },
          inactiveHiddenCount: { type: 'integer', required: true }
        }
      },
      render: (_args, value) => {
        // m-64: ONE coherent per-member state token (running|idle|sleeping|offline)
        // replaces the flat `, live`/`, offline` + `, sleeping` combination, so a
        // member never renders the contradictory "live, sleeping" nor "live,
        // retired" (m-228) — `retired` and `YOU` stay as separate markers.
        const lines = value.members.map((member) =>
          `  - ${member.agentId} (${member.kind}, "${member.title}"${member.state === 'running' ? ', running' : member.state === 'idle' ? ', idle' : member.state === 'sleeping' ? ', sleeping' : ', offline'}${member.retired === true ? ', retired' : ''}${member.you ? ', YOU' : ''})`)
        const retiredCount = value.retiredCount ?? 0
        // C1 (m-264): the header adds the sleeping/offline-hidden count — the
        // NON-retired rows the DEFAULT active view hides (the caller's own
        // you:true row is always kept and never counted).
        const inactiveHiddenCount = value.inactiveHiddenCount ?? 0
        return [{ type: 'text', text: `Deepartments catalog (${value.members.length} member(s), ${retiredCount} retired, ${inactiveHiddenCount} sleeping/offline hidden):\n${lines.join('\n')}` } as const]
      }
    },
    async execute(args, exec): Promise<{ members: Array<{ agentId: string; kind: 'host' | 'head' | 'worker'; title: string; live: boolean; sleeping: boolean; state: DeptWhoState; sessionId: string; you: boolean; departmentId?: string; role?: string; jobId?: string; retired?: boolean }>; retiredCount: number; inactiveHiddenCount: number }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_who requires a calling agent (exec.agent was undefined)')
      // C1 (m-264) — the catalog scope: `active` (default) = non-retired rows
      // whose state is {idle, running} PLUS the caller's OWN row (you:true)
      // ALWAYS (even when it is sleeping/offline/retired); `all` = the full
      // superset (idle|running|sleeping|offline + retired with retired:true).
      // `includeRetired` is the DOCUMENTED COMPAT ALIAS of `all` (R6: never
      // remove — existing tests and callers keep using it).
      const scope = args.scope === 'all' || args.scope === 'includeRetired' ? 'all' : 'active'
      // B3 gap fix: caller host self-registers when no live host exists (board
      // tools are gone; the roster must show the host with you:true).
      const callerMemberId = busEnsureHostForCaller(agent as { id: string; session?: { header?: SessionHeaderWithOrigin } })
      const members: Array<{ agentId: string; kind: 'host' | 'head' | 'worker'; title: string; live: boolean; sleeping: boolean; state: DeptWhoState; sessionId: string; you: boolean; departmentId?: string; role?: string; jobId?: string; retired?: boolean }> = []
      // A5 — `retiredCount` = the retired rows the DEFAULT (active) view hides
      // (0 when scope=all/includeRetired — nothing is hidden).
      let retiredCount = 0
      // C1 — `inactiveHiddenCount` = the NON-retired rows the DEFAULT active
      // view hides because their state is sleeping/offline (the caller's own
      // you:true row is ALWAYS kept and NEVER counted).
      let inactiveHiddenCount = 0
      // C3 — ONE shared row builder for the roster AND the activeMembers echo,
      // so the echo and the default view can never diverge.
      for (const row of buildCatalogRows()) {
        const you = row.agentId === callerMemberId
        if (row.retired) {
          if (scope === 'active') {
            retiredCount++
            if (!you) continue
          }
          // all/includeRetired keeps the row (the retired:true marker is
          // conditioned below).
        } else if (scope === 'active' && (row.state === 'sleeping' || row.state === 'offline')) {
          // C1 FIX (reviewer-4 PR-A point 1): a NON-you sleeping/offline row is
          // counted AND hidden; the caller's OWN you:true row stays SHOWN but is
          // NEVER counted (the count must exclude it — see the header comment).
          if (!you) {
            inactiveHiddenCount++
            continue
          }
        }
        members.push({
          agentId: row.agentId,
          kind: row.kind,
          title: row.title,
          live: row.live,
          sleeping: row.sleeping,
          state: row.state,
          sessionId: row.sessionId,
          you,
          // F3 (§5.1) + F9: conditioned spreads — the worker extras and the
          // retired marker are never undefined; the render appends ', retired'
          // from the data field (the A-series host/worker parity).
          ...(row.departmentId !== void 0 ? { departmentId: row.departmentId } : {}),
          ...(row.role !== void 0 ? { role: row.role } : {}),
          ...(row.jobId !== void 0 ? { jobId: row.jobId } : {}),
          ...(row.retired ? { retired: true } : {})
        })
      }
      return { members, retiredCount, inactiveHiddenCount }
    }
  })

  /** The three bus tools as ONE tuple — registered in the own layer of every
   * post (installHeadBoardTools) and of host agents (agent/created hook). */
  const busTools: readonly ReturnType<typeof defineTool>[] = [sendMessageTool, agentMessagesTool, deptWhoTool]

  // --- OVERRIDE NOTE (the harness native `send_message`) ---------------------
  // `NamedEntries.insert` THROWS on a same-layer duplicate (no replace), but
  // SCOPED registrations SHADOW globals — "Scoped tools shadow globals." The
  // native (dsh-tool-subagent-control) occupies the GLOBAL name only when the
  // harness composes its row (GUI/headless profiles via dsh-base); the
  // hermetic Loader tests boot without it. Strategy:
  //   * own layer (posts via installHeadBoardTools + the host session via the
  //     agent/created hook) — ALWAYS: the harness's supported override seam;
  //     every deepartments agent sees the unified tool and the native is
  //     shadowed away (posts additionally mask globals with the lean
  //     `restrict({allow:[]})` of postSetup).
  //   * GLOBAL host plane — `send_message` ONLY when the name is free
  //     (`ctx.tools.get(...)` undefined = minimal/hermetic compositions, where
  //     ours is the only send_message; the unified body must be reachable for
  //     the host tests). `agent_messages` / `dept_who` have no native conflict
  //     and register globally ALWAYS (host plane).
  // ---------------------------------------------------------------------------
  if (ctx.tools.get('send_message') === undefined) {
    ctx.tools.register(sendMessageTool)
    ctx.logger.info('[deepartments] send_message: registered unified tool on the global host plane (no native control tool composed here)')
  } else {
    ctx.logger.info('[deepartments] send_message: native control tool owns the global name — the unified tool is delivered per-agent own-layer (scoped shadow)')
  }
  ctx.tools.register(agentMessagesTool)
  ctx.tools.register(deptWhoTool)

  // Host own layer (agent/created): register the bus tools on every host (root
  // non-post) agent so the shadow stands even where the native is global
  // ("Scoped tools shadow globals" — the harness's override seam). Transient
  // dispatched children (origin subagent) are deliberately NOT covered — they
  // stay on the native parent→child adapter the Asistente uses to steer them,
  // matching the spec's registration scope (host plane + head/worker layers).
  // Posts are skipped twice over: (1) by the origin-non-root check below and
  // (2) — defensively, for the announce-time race where byChild is not yet
  // populated — by the duplicate catch (installHeadBoardTools already
  // registered the SAME own-layer tools during setup, which runs BEFORE
  // publish/announce; a second insert of the same name in the same layer
  // throws, and that throw is exactly the already-installed signal).
  // Keyed by the AGENT OBJECT, not the session id: every announce is a fresh
  // AgentLoop incarnation with its OWN scope (incl. cold resumes), so the
  // registration must be re-established per incarnation — the previous
  // incarnation's registrations died with its scope.
  const hostBusToolsInstalled = new WeakSet<object>()
  ctx.on('agent/created', ({ agent: created }) => {
    const createdLike = created as unknown as AgentLike
    if (createdLike === void 0 || typeof createdLike.id !== 'string') return
    const header = (createdLike.session as { header?: SessionHeaderWithOrigin } | undefined)?.header
    const origin = header?.origin ?? header?.meta?.origin
    if (origin !== undefined) return // transient children keep the native adapter
    if (postIdForChild(createdLike.id) !== undefined) return // posts: own-layer from setup
    if (hostBusToolsInstalled.has(createdLike)) return
    const agentTools = (createdLike as { ctx?: { tools?: { register: (definition: ReturnType<typeof defineTool>) => unknown } } }).ctx?.tools
    if (agentTools === void 0 || typeof agentTools.register !== 'function') return // stub agents (no scoped tools) — nothing to shadow
    try {
      for (const tool of busTools) agentTools.register(tool)
      hostBusToolsInstalled.add(createdLike)
    } catch (error: unknown) {
      // Same-layer duplicate ("already registered in this scope") = the post
      // setup already installed the unified tools pre-announce — the shadow is
      // in place. Any other failure is a real registration problem: rethrow.
      if (error instanceof Error && error.message.includes('already registered')) return
      throw error
    }
  })

  // ---------------------------------------------------------------------------
  // Boot — one-time re-delivery driver for the write-ahead sidecar (spec §4.4):
  // after registries + store are up, re-run ONLY the pairs whose latest sidecar
  // status needs re-delivery (crash between persist and delivery / mid-fan-out:
  // 'prepared'; rejected delivery: 'failed'); 'delivered'/'resumed'/'self'/
  // 'terminal' are never re-run. Also compacts the sidecar at boot (keep only
  // the latest state per key) once it grows past the board compaction
  // threshold. W7-A: BEFORE re-attempting a pair, resolve the recipient against
  // the durable catalog — a DEAD/UNKNOWN recipient (removed/closed/retired
  // session) is settled as a single 'terminal' row and SKIPPED (no
  // deliverBusRecord call → no fresh 'failed'/'prepared' rows → the W6 health
  // daemon stops re-alerting every boot).
  // ---------------------------------------------------------------------------
  /** Resolve a bus recipient against the durable catalog: ALIVE if it exists as
   * a NON-RETIRED post (byPost / posts.json) OR a NON-RETIRED host
   * (hosts / hosts.json); DEAD/UNKNOWN if neither exists, or the recipient's
   * post/host is retired (a removed/closed session — e.g. a formerly-open
   * subagent whose session is gone). The boot re-delivery driver uses this to
   * settle dead recipients ONCE (W7-A). */
  const recipientCatalogAlive = (recipientId: string): boolean => {
    const post = byPost.get(recipientId)
    if (post !== void 0) return post.retired !== true
    const host = hosts.get(recipientId)
    if (host !== void 0) return host.retired !== true
    return false
  }
  const resolveCallerSessionIdForRedeliver = (from: string): string =>
    byPost.get(from)?.sessionId ?? hosts.get(from)?.sessionId ?? from
  const deliverBusRecordForRedeliver = (record: MessageRecord, recipientId: string, callerSessionId: string): Promise<DeliveryStatus> =>
    deliverBusRecord(record, recipientId, callerSessionId, callerSessionId)
  const redeliverDeps: DeliveryRedelivererDeps = {
    stateDir: messageStoreDir,
    logger: ctx.logger,
    recipientAlive: recipientCatalogAlive,
    getRecord: async (messageId: string): Promise<MessageRecord | undefined> =>
      (await messagesStoreReady).get(messageId),
    resolveCallerSessionId: resolveCallerSessionIdForRedeliver,
    deliver: deliverBusRecordForRedeliver
  }
  // FASE 2.6-C: consume the boot re-delivery driver from the dshd-core bus
  // service when composed (the store + getRecord are bound internally by the
  // shell); fall back to the in-bundle DeliveryRedeliverer in a minimal
  // composition (dshd-core absent) — behavior-neutral.
  const redeliverPendingDeliveries = (ctx.get('deepartments.bus') as BusSurface | undefined)?.redeliver({
    recipientAlive: recipientCatalogAlive,
    resolveCallerSessionId: resolveCallerSessionIdForRedeliver,
    deliver: deliverBusRecordForRedeliver
  }) ?? new DeliveryRedeliverer(redeliverDeps)

  // FASE 2.6-C: LATE-BIND the bundle's closure-bound bucket-(c) deps into the
  // dshd-core service shells. EVERY closure the lazy builders need is defined by
  // this point (the wake-relay maps, the framing/user-message helpers, the live
  // identity resolvers, the tool/daemon wiring). The deps are passed BY
  // REFERENCE (live closures) so the core service shells mutate the SAME maps /
  // sets / registries the tools and daemons read. Guarded: `binder` is
  // undefined in a minimal composition (dshd-core absent), making this a
  // behavior-neutral NO-OP for the bundle-alone suite.
  //
  // DECOUPLING PASO 1 (gui → dshd-gui): the RPC channel the bundle mounts
  // inline below now feeds the `gui` Binder buckET instead of the direct
  // closure: the endpointDeps wiring (the DEEPARTMENTS endpoint deps: the live
  // registries + the bundle-owned pure deps buildAgentRows/pickLiveHostEntry +
  // the presence/journal hooks) is REGISTERED here so the composed dshd-gui
  // plugin's `deepartments.gui` SERVICE (lazy, fail-loud R1 when the bucket is
  // absent) provides the channel surface; the bundle's webServer MOUNT effect
  // below consumes that service. The construction is closure-bound to the apply
  // fiber (byPost/hosts/agents/presence), exactly like the other buckets.
  const guiEndpointDeps: DeepartmentsEndpointDeps = {
    departments: org.departments,
    // dshd-gui phase: the deps interface is owned by the dshd-gui package (its
    // structural EndpointPostEntryLike mirror is the cast target — the live
    // registry type is the bundle's richer PostEntry).
    byPost: byPost as unknown as Map<string, EndpointPostEntryLike>,
    // U3 fix (reviewer 2026-08-22): `Map.values()` returns a SINGLE-USE
    // iterator, and the deps object is shared for the process lifetime. The
    // host/status builder iterates `deps.hosts` up to 3× (pick, candidates
    // spread, retired loop) and agents/list iterates it again, so a bare
    // `hosts.values()` was exhausted by the FIRST call (retired degraded to
    // []) and every later call saw zero hosts. Re-iterable wire: EVERY
    // `[Symbol.iterator]` call returns a FRESH iterator over the live content.
    hosts: { [Symbol.iterator]: (): Iterator<HostEntryLike> => hosts.values() as Iterator<HostEntryLike> },
    sessionLive: (sid) => agents !== void 0 && agents.get(SessionId(sid)) !== undefined,
    sessionRunning: (sid) => agents !== void 0 && agents.get(SessionId(sid))?.status === 'running',
    // dshd-gui phase: the two bundle-owned PURE deps the dispatcher's
    // agents/list + host/status branches need — injected here exactly like the
    // sessionLive/unread signals (the package has no bundle import).
    buildAgentRows,
    pickLiveHostEntry,
    // U3: the live host's journal wake_counter for the `host/status` payload.
    // Best-effort and NEVER throwing — an unreadable journal simply omits the
    // field (the payload contract stays minimal and stable).
    loadHostWakeCounter: async (hostId) => {
      try {
        const text = await readFile(journalPathFor(hostId), 'utf8')
        const counterMatch = text.match(/^wake_counter:\s*(\d+)/m)
        return counterMatch !== null ? Number(counterMatch[1]) : undefined
      } catch {
        return undefined
      }
    },
    // U3 fix: ambiguity warn for live-host selection (post-mortem finding #2).
    logger: ctx.logger,
    // Feature A — owner-presence read/write + host-change notify. The read
    // refreshes the synchronous cache (so a `presence/get` reflects the
    // current file AND keeps the guard/pre-step cache current); the write
    // persists atomically via the wrapping savePresence (never throws — an
    // RPC never fails on a persist error). The notify is the fire-and-forget
    // HOST followup (A3/A4), fired by the dispatch only on a real CHANGE.
    presenceState: async () => {
      refreshPresence()
      return { present: presenceCache.present, ...(presenceCache.updatedAt === undefined ? {} : { updatedAt: presenceCache.updatedAt }) }
    },
    savePresenceState: async (state) => savePresence(state),
    notifyPresenceChange: (present) => notifyHostPresence(present),
    // W1 — `agenda/list`: read the jobs from the repo tree (default jobDir
    // resolution via the apply scope repoRoot) and the runtime calendar from
    // the shared stateDir. The clock picks the live next-due snapshot.
    repoRoot,
    calendarStateDir: stateDir,
    now: () => Date.now()
  }

  // DECOUPLING PASO 1 (daemons → dshd-jobs / dshd-health): the scheduler +
  // system-health tick CLOSURES the daemon effects consume are HOISTED to the
  // apply scope so they can be registered in the `jobs`/`health` Binder
  // buckets (the composed services read them at use; fail-loud R1 when the
  // bucket is absent — the contract lock). The daemon effects below resolve
  // the composed SERVICE and call it per interval, falling back to the SAME
  // closures inline when the service is absent (minimal composition / bundle-
  // alone suite — R6 behavior-neutral). All deps these closures capture
  // (byPost, hosts, org, messagesStoreReady, busDeliverToPost/Host,
  // runJobForDepartment, captureSchedulerAutoRunFailure, deliverDaemonNotice,
  // the health builders) are defined by this point.
  const schedulerHeadForDepartment = (department: DepartmentConfig): string | undefined => department.coordinator?.postId
  const schedulerRunJob = async (department: DepartmentConfig, headPostId: string, jobId: string): Promise<boolean> => {
    const headEntry = byPost.get(headPostId)
    if (headEntry === void 0) {
      await captureSchedulerAutoRunFailure({ stateDir: stateDir, now: () => Date.now(), jobId, reason: 'no head', error: 'no head' })
      return false
    }
    try {
      await runJobForDepartment(department, headEntry, jobId, { callerSessionId: headEntry.sessionId })
      return true
    } catch (error: unknown) {
      const errorText = error instanceof Error ? error.message : String(error)
      const reason = /job already running/.test(errorText) ? 'idempotency-skip' : errorText
      await captureSchedulerAutoRunFailure({ stateDir: stateDir, now: () => Date.now(), jobId, reason, error: errorText })
      ctx.logger.warn(`[deepartments] scheduler: job "${jobId}" could not run (${errorText}) — skip`)
      return false
    }
  }
  const schedulerOnAutoRunSkip = async (finding: SchedulerAutoRunFinding): Promise<void> => {
    if (finding.reason !== 'no head') return
    await captureSchedulerAutoRunFailure({ stateDir: stateDir, now: () => Date.now(), jobId: finding.jobId, reason: 'no head', error: 'no head' })
  }
  const schedulerNotifyHead = async (headPostId: string, message: string): Promise<void> => {
    try {
      const headEntry = byPost.get(headPostId)
      if (headEntry === void 0) return
      const store = await messagesStoreReady
      const record = await store.append({ from: 'deepartments', to: [headPostId], text: `Agenda notice: ${message}`, kind: 'agent' })
      const outcome = await deliverDaemonNotice(headEntry, record, `[From deepartments → ${headPostId}]: Agenda notice: ${message}`, busDeliverToPost)
      if (outcome === 'queued') ctx.logger.info(`[deepartments] scheduler: agenda notice to "${headPostId}" queued (head is dormant — no wake)`)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] scheduler: agenda notice to "${headPostId}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const schedulerDepartmentForEntry = (entry: { createdBy?: string }): DepartmentConfig | undefined => {
    const creator = byPost.get(entry.createdBy ?? '')
    return creator === void 0 ? undefined : departmentForEntry(creator)
  }
  const schedulerDepartmentForJob = (jobId: string): DepartmentConfig | undefined => {
    for (const department of org.departments) {
      const jobDir = jobDirFor(repoRoot, department)
      if (existsSync(path.join(jobDir, `${jobId}.md`))) return department
    }
    return undefined
  }
  // W6 system-health: the per-tick LIVE input BUILDERS (catalog posts, host
  // running signal, session-context rows, host-wait rows) + the ALERT delivery
  // closure + the per-daemon C6 tail reader — hoisted so the `health` bucket
  // carries them (the composed dshd-health service runs the SAME tick with the
  // SAME inputs). The builders read the LIVE registries per call (fresh per
  // tick); the notifyHost is the C8 direct ALERT seam (store.append +
  // busDeliverToHost, interrupt:true — never a delivery-engine row).
  const buildHealthPosts = (): PostActivityInput[] => {
    const { inboxTsByPost } = readInboxByPost(stateDir, '', Date.now(), HEALTH_ERROR_WINDOW_MS)
    const out: PostActivityInput[] = []
    for (const [postId, entry] of byPost) {
      const live = agents?.get(entry.sessionId)
      out.push({
        postId,
        sessionId: entry.sessionId,
        retired: entry.retired === true,
        running: live !== undefined && live.status === 'running',
        events: (live?.session?.events ?? []) as HealthSessionEvent[],
        inboxTs: inboxTsByPost.get(postId) ?? [],
        sleeping: entry.sleepEpoch !== void 0,
        provider: entry.provider,
        ...(agents !== void 0 ? { hasLiveHandle: live !== undefined } : {})
      })
    }
    return out
  }
  const buildHostRunning = (): boolean | undefined => {
    if (agents === void 0) return undefined
    for (const entry of hosts.values()) {
      if (entry.retired === true) continue
      if (agents.get(SessionId(entry.sessionId))?.status === 'running') return true
    }
    return false
  }
  const healthSessionProjections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
  const buildSessionContexts = (): SessionContextInput[] | undefined => {
    if (healthSessionProjections === undefined) return undefined
    const rowOf = (session: unknown, id: { postId?: string; hostId?: string }): SessionContextInput | undefined => {
      const snap = healthSessionProjections.snapshot(session)
      const view = snap?.values?.contextPressure
      if (view === undefined || typeof view !== 'object') return undefined
      const v = view as { contextWindow?: unknown; pressureTokens?: unknown; projectedTokens?: unknown }
      return {
        ...id,
        ...(typeof v.contextWindow === 'number' && Number.isFinite(v.contextWindow) ? { contextWindow: v.contextWindow } : {}),
        ...(typeof v.pressureTokens === 'number' && Number.isFinite(v.pressureTokens) ? { pressureTokens: v.pressureTokens } : {}),
        ...(typeof v.projectedTokens === 'number' && Number.isFinite(v.projectedTokens) ? { projectedTokens: v.projectedTokens } : {})
      }
    }
    const out: SessionContextInput[] = []
    for (const [postId, entry] of byPost) {
      if (entry.retired === true) continue
      const live = agents?.get(entry.sessionId)
      if (live?.session === undefined) continue
      const row = rowOf(live.session, { postId })
      if (row !== undefined) out.push(row)
    }
    for (const entry of hosts.values()) {
      if (entry.retired === true) continue
      const live = agents?.get(entry.sessionId)
      if (live?.session === undefined) continue
      const row = rowOf(live.session, { hostId: entry.hostId })
      if (row !== undefined) out.push(row)
      break
    }
    return out
  }
  const buildHostWaits = (): HostWaitPostInput[] => {
    const { live } = pickLiveHostEntry(hosts.values())
    if (live === undefined) return []
    const nowMs = Date.now()
    const { hostRowsByPost } = readInboxByPost(stateDir, live.hostId, nowMs, HEALTH_ERROR_WINDOW_MS)
    const out: HostWaitPostInput[] = []
    for (const [postId, entry] of byPost) {
      const liveAgent = agents?.get(entry.sessionId)
      out.push({
        postId,
        retired: entry.retired === true,
        events: (liveAgent?.session?.events ?? []) as HealthSessionEvent[],
        hostMessages: hostRowsByPost.get(postId) ?? [],
        sleeping: entry.sleepEpoch !== void 0
      })
    }
    return out
  }
  const healthNotifyHost = async (hostEntry: HostEntryLike, alertFrame: string): Promise<void> => {
    try {
      const store = await messagesStoreReady
      const record = await store.append({ from: 'deepartments', to: [hostEntry.hostId], text: alertFrame, kind: 'agent' })
      await busDeliverToHost(hostEntry as HostEntry, alertFrame, record, void 0, { interrupt: true })
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] system-health: host alert delivery failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const healthPoolerStatePath = config.health?.poolerStateFilePath !== undefined && config.health.poolerStateFilePath.trim() !== ''
    ? config.health.poolerStateFilePath
    : path.join(dshHome(), POOLER_STATE_FILE)
  const healthBootId = randomUUID()

  const binder = ctx.get('deepartments.binder') as Binder | undefined
  binder?.register({
    bus: { redeliver: { recipientAlive: recipientCatalogAlive, resolveCallerSessionId: resolveCallerSessionIdForRedeliver, deliver: deliverBusRecordForRedeliver } },
    deliver: {
      resolveChild: resolveBusChild,
      deliverChild: deliverBusChild,
      resolveCatalogRoute: resolveBusCatalogRoute,
      busProfileFor,
      deliverPost: busDeliverToPost,
      deliverHost: busDeliverToHost
    },
    wakepack: {
      refreshPresence,
      wakePackInjected,
      deferredSleepReplace,
      roleForSession: roleForSessionLive,
      buildSubagentOrientation,
      computeHostSleepSurfacePlan,
      assembleHeartbeat,
      readPresenceStateFile,
      messagesStoreReady: () => messagesStoreReady,
      repoRoot
    },
    lifecycle: {
      ensureHost,
      writeJournal,
      readJournal,
      bumpHostSleepCounter,
      bumpPostSleepCounter,
      archivePostSessionOnSleep,
      disposeHeadHandleOnce,
      maybeEmitQualityInspectDirective,
      // fb-11 — the ROTATION-SUCCESSOR AUTO-WAKE seam (the dshd-core lazy
      // lifecycle reads it from this bucket; OPTIONAL there, provided here).
      enqueueHostWake,
      deferredSleepReplace,
      wakePackInjected
    },
    redeliver: { recipientAlive: recipientCatalogAlive, resolveCallerSessionId: resolveCallerSessionIdForRedeliver, deliver: deliverBusRecordForRedeliver },
    // DECOUPLING PASO 1 — the gui channel bucket: the composed dshd-gui plugin
    // (deepartments.gui service) reads this on FIRST use to dispatch the
    // /deepartments endpoints. Absent in a minimal composition (dshd-gui not
    // composed) → the bundle's webServer mount below falls back to the direct
    // in-bundle handler (R6, behavior-neutral).
    gui: { endpointDeps: guiEndpointDeps },
    // DECOUPLING PASO 1 — the pooler bucket: the composed dshd-pooler plugin
    // (deepartments.pooler service) reads the CONFIGURED provider set (the
    // worker/host agent-option routes are bundle constants the package cannot
    // derive) + the post-error append closure. The bundle's OWN inline boot
    // check (runProviderAdapterBootCheck, tools zone) is untouched (R6) — this
    // bucket only serves the composed SERVICE.
    pooler: {
      configuredProviders: [
        ...(WORKER_AGENT_OPTIONS.provider !== undefined ? [WORKER_AGENT_OPTIONS.provider] : []),
        ...(HOST_AGENT_OPTIONS.provider !== undefined ? [HOST_AGENT_OPTIONS.provider] : []),
        ...(org.departments ?? []).flatMap((department) => {
          const c = department.coordinator
          if (c?.agentOptions?.provider !== undefined) return [c.agentOptions.provider]
          return c?.provider !== undefined ? [c.provider] : []
        })
      ],
      appendPostError
    },
    // DECOUPLING PASO 1 — the jobs bucket: the composed dshd-jobs plugin
    // (deepartments.jobs service) reads the closure-bound scheduler deps on
    // runSchedulerTick (REQUIRED at use: runJob/notifyHead/departmentForEntry/
    // departmentForJob; onAutoRunSkip + repoRoot optional) — the SAME closures
    // the (hermetic) inline fallback uses, so the composed daemon behaves
    // identically. The dshd-jobs service derives org.departments + stateDir
    // from `deepartments.org` (the shared source — identical values).
    jobs: {
      runJob: schedulerRunJob,
      notifyHead: schedulerNotifyHead,
      departmentForEntry: schedulerDepartmentForEntry,
      departmentForJob: schedulerDepartmentForJob,
      onAutoRunSkip: schedulerOnAutoRunSkip,
      repoRoot
    },
    // DECOUPLING PASO 1 — the health bucket: the composed dshd-health plugin
    // (deepartments.health service) reads its STATIC per-process deps from here
    // (bootId/config/notifyHost/poolerStatePath/qiDirectiveRate/workRegisterPath)
    // and receives the PER-TICK live inputs (now/hosts/posts/hostWaits/
    // sessionContexts/hostRunning/deliveryRowsReader) EXPLICITLY per
    // runDaemonTick call — exactly the fields the inline daemon passed to
    // runHealthDaemonTick (verified by test/binder-contract.test.js).
    health: {
      bootId: healthBootId,
      // The plugin Config (the dshd-health service reads `.health` knobs from
      // it — HealthConfigLike-structural; the health bucket types it unknown).
      config,
      notifyHost: healthNotifyHost,
      poolerStatePath: healthPoolerStatePath,
      qiDirectiveRate: qualityWorkerInspectProbability,
      workRegisterPath: path.join(repoRoot, 'docs', 'WORK-REGISTER.md')
    }
  })


  // --- tool definitions (shared by the GLOBAL host plane and the child's OWN
  // layer so a lean toolFilter still exposes them to resident posts) ---------

  if (subagents === void 0) {
    ctx.logger.warn('[deepartments] subagents service absent: the messaging toolset will not be installed into continuable children (host-plane tools may still fail at use if the services are absent)')
  }

  // --- global (host-plane) tools: registered once on the plugin ctx so the
  // HOST Asistente (and every agent) sees them. Registered as a reversible
  // effect so HMR unloads them cleanly. ---

  // Batch W4 P1 — ON-DEMAND wake-context snapshot (host plane): the live-
  // freshness counterpart of the host wake injection. Returns identity, the
  // message delta (latest received) and the condensed roster in ONE call using
  // the SAME pure `buildWakePack` builder. B3 cutover: no rooms, no board
  // cursor — the snapshot is the messaging-delta + roster.
  const globalWakeSnapshot = ctx.tools.register(defineTool({
    name: 'dept_wake_snapshot',
    description: 'On-demand Deepartments wake-context snapshot (host plane): returns, in ONE call and as text, your identity, the message delta (your latest-received messages, capped N) and the condensed roster (registered posts/hosts with their durable registry sleeping flags). It NEVER embeds live session liveness — a stale liveness claim is worse than one dept_who, so liveness stays on-demand via dept_who. This is the live-freshness counterpart of the automatic host wake context pack; for LIVE needs the pack cannot cache (true session liveness, full message text), call dept_who / agent_messages. Does not advance anything.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          snapshot: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.snapshot } as const]
    },
    async execute(_args, exec): Promise<{ snapshot: string }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_wake_snapshot requires a calling agent (exec.agent was undefined)')
      const sessionId = agent.id as string
      const hostId = hostIdForSession(sessionId)
      const snapshot = await wakePackService.assembleWakeSnapshot(hostId)
      return { snapshot }
    }
  }))

  const globalRetire = ctx.tools.register(postRetireTool)

  // --- Batch G: memo (journal) and sleep (dormir) — host plane --------------
  // The owner's lifecycle model: department heads are PERMANENT agents that go
  // IDLE (wait, keeping their context; the default concluded state is already
  // an inactive-but-resumable continuable — the wake relay re-wakes them
  // regardless) or SLEEP (dormir — persist memory to a journal then reset the
  // context window; a fresh incarnation reloads the journal on the next wake).
  // dept_memo_write persists the head's long-term memory to its journal;
  // dept_sleep requires a prior memo, marks the post (sleepEpoch), and the
  // relay re-materializes it fresh.

  const globalMemo = ctx.tools.register(memoWriteTool(true))

  const globalSleep = ctx.tools.register(sleepTool(true))

  // --- B1: org-wide quiet-sleep orchestration (host plane) -------------------
  // LOTE A (owner decision 2026-08-27): head/worker sleep is RETIRED — heads
  // and workers stay `idle|running` permanently. `dept_sleep_all` remains
  // REGISTERED host-plane as a documented NO-OP (R6 — never remove; the harness
  // lifecycle service `sleepAll` stays as dead code in lifecycle.ts). It emits
  // a warn and returns `{slept: 0, skipped: 0}` — it never marks, never
  // persists, never disposes. The HOST's single-agent dept_sleep (spec 002
  // rotation) is UNTOUCHED.
  const globalSleepAll = ctx.tools.register(defineTool({
    name: 'dept_sleep_all',
    description: 'Retired orchestration tool (host plane) — a NO-OP since 2026-08-27 (LOTE A: head/worker sleep removed; heads and workers are permanent `idle|running`). Kept registered for R6 compatibility: calling it warns and returns {slept: 0, skipped: 0}. The single-agent host dept_sleep (spec 002 session rotation) is the only remaining sleep path.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slept: { type: 'number', required: true },
          skipped: { type: 'number', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `dept_sleep_all is a NO-OP since 2026-08-27 (head/worker sleep retired): ${value.slept} slept, ${value.skipped} skipped (nothing done — only the host dept_sleep rotation remains, spec 002)` } as const]
    },
    async execute(_args, exec): Promise<{ slept: number; skipped: number }> {
      // No-op with warn (R6): the batch orchestration is retired — heads stay
      // idle|running; sleepAll remains as dead code in lifecycle.ts.
      ctx.logger.warn('[deepartments] dept_sleep_all is a NO-OP since 2026-08-27 (LOTE A): head/worker sleep retired — heads and workers stay idle|running; only the host dept_sleep rotation remains (spec 002)')
      return { slept: 0, skipped: 0 }
    }
  }))

  // --- M-A: dept_head_rotate (HOST plane) — the ACTIVE CONTEXT REFRESH of a
  // configured department head -----------------------------------------------
  // The rotation = a session refresh WITH JOURNAL (micro-decision owner
  // 2026-08-28, map reports/explore-deep/2026-08-28-ma-context-monitor-map.md
  // §3): bounded-dispose the old live handle → server-side archive the old
  // session (S2.5) → FRESH-MINT a NEW session SEEDED with the head's LAST
  // DURABLE journal (buildHeadRotationSeed — NO re-key: the head's journal
  // author is its STABLE postId) + the department title pin → mirror the event
  // to the QD ('head-rotated', the host-rotated pattern — inspected at 100%;
  // the QH's own rotation is NOT excluded: the old 'head-slept' exclusion was
  // the SLEEP anti-loop, a one-shot instruction rotation cannot loop).
  // NOT sleep (no sleepEpoch is set) and NOT retire (the postId stays live):
  // a rotation only refreshes the underlying session/context. The fresh head
  // lands LIVE but BOOT-QUIET — NO immediate wake (deliberate: heads are
  // addressed-driven; the host greets the fresh head with its substantive
  // message right after, and that next message / the next daemon wake starts
  // its first turn with the journal already in the seed + the wake pack
  // injected at pre-step). Scope: host-only (a head cannot rotate), configured
  // heads only (a worker / unconfigured post rejects loudly), idle only (a
  // RUNNING head is rotated in a free window, never mid-turn).
  const globalHeadRotate = ctx.tools.register(defineTool({
    name: 'dept_head_rotate',
    description: 'Rotate a CONFIGURED department head (HOST plane, Asistente only): an ACTIVE context refresh — the head\'s durable session is fresh-minted (NEW session id) seeded with its LAST durable journal, the old session is archived server-side, and the department title stays pinned; the postId/identity, journal and messages are untouched (archive ≠ delete) and NO sleepEpoch is set (a rotation is NOT sleep). The fresh head lands LIVE but BOOT-QUIET: its first turn starts on the NEXT message/daemon wake (the journal is already in its context as the seed). Use it on CONTEXT-THRESHOLD crossing (>= 50% of the window, e.g. the QH) or on instruction; confirm the head is IDLE first (dept_who) — a running head is rejected loudly. The LAST durable journal is ALWAYS used and the rotation NEVER delays for a fresh memo (the critical-unblock rule — a context-blocked head may not run dept_memo_write): ask the head for dept_memo_write BEFORE rotating when it is operative and the window permits, and watch the returned `journal.stale` marker ("memo no actualizado — journal previo"). Emits a Quality-inspect directive to quality-head (100% mandate).',
    parameters: {
      postId: { type: 'string', required: true, description: 'The CONFIGURED department head postId to rotate (e.g. "quality-head", "internal-programming-head"). A worker or an unconfigured post is rejected loudly.' },
      reason: { type: 'string', description: 'Optional reason for the rotation (recorded in the log + the QD mirror).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          postId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          previousSessionId: { type: 'string', required: true },
          archived: { type: 'boolean', required: true },
          journal: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              timestamp: { type: 'string' },
              stale: { type: 'boolean', required: true }
            }
          },
          reason: { type: 'string' },
          // fb-25 (a): the reason CROSS-CHECK stamp ('verified' | 'unverified' |
          // 'unavailable') — the reason figure vs the OLD session's real usage.
          reasonVerified: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `rotated ${value.postId}: ${value.previousSessionId} → ${value.sessionId} (archived ${value.archived}); journal ${value.journal.path}${value.journal.stale ? ' STALE — memo no actualizado, journal previo' : ' (fresh)'}${value.reason !== undefined ? `; reason: ${value.reason}` : ''}${value.reasonVerified !== undefined ? `; reason verified: ${value.reasonVerified}` : ''}` } as const]
    },
    async execute(args, exec): Promise<{ postId: string; sessionId: string; previousSessionId: string; archived: boolean; journal: { path: string; timestamp?: string; stale: boolean }; reason?: string; reasonVerified: ReasonVerificationStamp }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_head_rotate requires a calling agent (exec.agent was undefined)')
      // ACL (map §3): HOST-plane — only the Asistente itself (no registered
      // post) rotates heads; a department head can never rotate (it routes the
      // need to its own head, which escalates to the host).
      if (postIdForChild(agent.id as string) !== undefined) {
        throw new Error('[deepartments] dept_head_rotate is HOST-plane (the Asistente only): a department head cannot rotate heads — ask the host via your head')
      }
      const entry = byPost.get(args.postId)
      if (entry === void 0) throw new Error(`[deepartments] dept_head_rotate: "${args.postId}" is not a registered post`)
      // Scope: a WORKER is never rotatable (its lifecycle is create → retire).
      if (entry.provider === 'worker') {
        throw new Error(`[deepartments] dept_head_rotate: "${args.postId}" is a WORKER, not a head — workers are NOT rotatable (retire them with dept_worker_retire / dept_post_retire)`)
      }
      // Scope: only CONFIGURED heads (a coordinator row). The QH is rotatable —
      // it is the FIRST to rotate in the critical unblock (the old QH exclusion
      // was the dept_sleep anti-loop; a one-shot instruction rotation cannot loop).
      const coordinator = coordinatorForPost(args.postId)
      if (coordinator === void 0) {
        throw new Error(`[deepartments] dept_head_rotate: "${args.postId}" is not a CONFIGURED department head (no coordinator row in the org config)`)
      }
      const sessionId = String(SessionId(entry.sessionId))
      // Free-window rule (map §3 step 2): a RUNNING head is never rotated
      // mid-turn — the host schedules the rotation when the head is idle.
      const live = agents?.get(sessionId)
      if (live !== undefined && live.status === 'running') {
        throw new Error(`[deepartments] dept_head_rotate: "${args.postId}" is RUNNING (state ${live.status}) — rotate only in a free window (head idle; re-check dept_who)`)
      }
      // Journal — CRITICAL-UNBLOCK RULE: always use the LAST durable journal,
      // never delay for a fresh memo (a context-over-threshold head — the QH
      // — may be unable to run dept_memo_write; the rotation must still go
      // through). A MISSING journal fails loud (the dept_sleep precedent:
      // a rotation without continuity would lose the head's memory).
      const journal = await readJournal(args.postId)
      if (journal === void 0 || journal.trim() === '') {
        throw new Error(`[deepartments] dept_head_rotate: no durable journal for "${args.postId}" (${journalPathFor(args.postId)}) — request a dept_memo_write first, then rotate`)
      }
      const journalStatus = headRotationJournalStatus(journal, Date.now())
      // Bounded dispose of the old live handle (a zombie detach self-heals; the
      // fresh mint uses a NEW session id, no collision).
      if (!(await joinHeadDisposeOnce(sessionId))) {
        ctx.logger.warn(`[deepartments] dept_head_rotate: dispose join for "${args.postId}" timed out after ${disposeJoinTimeoutMs()}ms — proceeding with the fresh mint (zombie detach; new session id, no collision)`)
      }
      // Server-side archive of the OLD session (S2.5 semantics — the sidebar
      // row hides; the journal + messages stay intact). Non-fatal.
      const archived = await archivePostSessionOnSleep(sessionId)
      // FRESH-MINT: NEW session + LAST journal as the seed + department title pin.
      const dept = departmentForEntry(entry)
      const title = coordinator.sessionTitle || HEAD_DEFAULT_SESSION_TITLE
      const seed = buildHeadRotationSeed(journal, { title, now: Date.now() })
      const fresh = await freshMintHead(entry, dept, { seed, source: 'dept_head_rotate' })
      // fb-25 (a): the reason CROSS-CHECK — the figure the caller's reason cites
      // is contrasted against the OLD session's REAL usage (the durable
      // session_projcache.json row of the token-meter, resolved like the web-UI
      // cleanup wiring). NEVER BLOCKS: any failure/absence → 'unavailable' and
      // the rotation proceeds (critical-unblock rule — the archive/mirror is
      // cosmetic and never a requirement); a missing reason → 'unavailable'
      // (nothing to verify). The stamp rides the mirror AND the tool result so
      // the QH/inspectors and the host see an unverified figure as such.
      const persistence = ctx.get('sessionPersistence') as { root?: string } | undefined
      const projCachePath = resolveSessionProjCachePath(stateDir, persistence?.root)
      const reasonVerified = verifyRotateReason(args.reason, sessionId, projCachePath)
      // QD mirror (spec 007 §6.3, D-Q3 — the host-rotated pattern): a head
      // rotation is inspected at 100%. Non-fatal (the emitter wraps itself).
      await maybeEmitQualityInspectDirective({
        kind: 'head-rotated',
        headPostId: args.postId,
        oldSessionId: sessionId,
        newSessionId: String(fresh.id),
        archiveOk: archived,
        reasonVerified,
        ...(args.reason !== undefined ? { reason: args.reason } : {})
      })
      ctx.logger.info(`[deepartments] dept_head_rotate: "${args.postId}" rotated ${sessionId} → ${String(fresh.id)} (${args.reason ?? 'no reason given'}, reason verified ${reasonVerified}); journal ${journalStatus.stale ? 'STALE — memo no actualizado, journal previo' : 'fresh'} seeded; fresh head live BOOT-QUIET (first turn on the next message/daemon wake)`)
      return {
        postId: args.postId,
        sessionId: String(fresh.id),
        previousSessionId: sessionId,
        archived,
        journal: { path: journalPathFor(args.postId), ...(journalStatus.timestamp !== undefined ? { timestamp: journalStatus.timestamp } : {}), stale: journalStatus.stale },
        reasonVerified,
        ...(args.reason !== undefined ? { reason: args.reason } : {})
      }
    }
  }))

  // --- dshd-feedback tools (host plane): the host may emit feedback + list +
  // update the backlog. Registered globally (the host is every agent's top of
  // the reporting chain — D6); the QH-authority is enforced in `execute`.
  const globalFeedback = ctx.tools.register(feedbackTool)
  const globalFeedbackList = ctx.tools.register(feedbackListTool)
  const globalFeedbackUpdate = ctx.tools.register(feedbackUpdateTool)

  ctx.effect(() => () => {
    globalFeedback()
    globalFeedbackList()
    globalFeedbackUpdate()
    globalWakeSnapshot()
    globalRetire()
    globalMemo()
    globalSleep()
    globalSleepAll()
    globalHeadRotate()
  }, 'deepartments: host-plane tools')

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
    const tick = (): void => {
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
    }
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
      const interval = setInterval(() => { void daemon.tick() }, PARALLEL_MONITOR_INTERVAL_MS)
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
          hostWaits?: Iterable<HostWaitPostInput>
          deliveryRowsReader?: unknown
        }): Promise<void> }
      | undefined
    ctx.effect(() => {
      // C6: ONE tail reader per daemon — its byte-offset cursor survives ticks
      // (created here, outside the per-tick deps object), so a 60 s tick parses
      // only the deliveries rows appended since the previous tick instead of
      // re-reading the whole (unbounded-between-boots) sidecar. The scanner's
      // filter pipeline is unchanged → same findings, same alerts.
      const deliveryRowsTailReader = createDeliveryRowsTailReader()
      const tick = (): void => {
        if (healthService !== undefined) {
          void healthService.runDaemonTick({
            now: () => Date.now(),
            // A FRESH single-use iterator per tick (Map.values() is single-use).
            hosts: hosts.values(),
            // W8-c: the catalog-post inputs (activity + inbox) for the turn-error
            // + stale-live safeguards — resolved lazily per tick.
            posts: buildHealthPosts(),
            // M4: the host's live running signal (absent agents registry →
            // undefined → the system-idle scan is a no-op).
            hostRunning: buildHostRunning(),
            // M-A: the context-pressure rows for the context-threshold watchdog
            // (absent sessionProjections service → undefined → the scan is a
            // no-op — unknown context pressure never fabricates an alert).
            sessionContexts: buildSessionContexts(),
            // W8-d: the host-sender-aware inputs for the conditional system-wait
            // scan — resolved lazily per tick.
            hostWaits: buildHostWaits(),
            // C6: the bounded tail reader (absent → the legacy full read).
            deliveryRowsReader: deliveryRowsTailReader
          })
        } else {
          void runHealthDaemonTick({
            now: () => Date.now(),
            stateDir: stateDir,
            bootId: healthBootId,
            config,
            // A FRESH single-use iterator per tick (Map.values() is single-use).
            hosts: hosts.values(),
            // W8-c: the catalog-post inputs (activity + inbox) for the turn-error
            // + stale-live safeguards — resolved lazily per tick.
            posts: buildHealthPosts(),
            // M4: the host's live running signal (absent agents registry →
            // undefined → the system-idle scan is a no-op).
            hostRunning: buildHostRunning(),
            // M-A: the context-pressure rows for the context-threshold watchdog
            // (absent sessionProjections service → undefined → the scan is a
            // no-op — unknown context pressure never fabricates an alert).
            sessionContexts: buildSessionContexts(),
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
            // PACING (owner m-PACING, 2026-08-28): the repo WORK-REGISTER path —
            // read at a VALLE transition for the «reanuda; despachos diferidos:
            // N» count (best-effort; unreadable → the notice omits the count).
            workRegisterPath: path.join(repoRoot, 'docs', 'WORK-REGISTER.md'),
            logger: ctx.logger
          })
        }
      }
      const interval = setInterval(tick, healthIntervalMs)
      return () => { clearInterval(interval) }
    }, 'deepartments: system-health daemon')
  }

  // --- agents/list + host/status RPC (server half, HTTP self-mount) --------
  // Serves the department-head roster rows (`agents`/`list`) and the U3
  // host-rotation lifecycle signal (`host/status`, spec 002 §6.1) to the client
  // over the `/deepartments` channel (trusted-host authority). The pure
  // computation lives in dispatchDeepartmentsEndpoint (exported, unit-tested
  // in test/rpc-channel.test.js); this effect wires it to the live registries
  // and mounts the HTTP routes. (U1: the persistent UI config surface the
  // channel once also served is removed with the sidebar.)
  // DECOUPLING PASO 1: the channel SURFACE is now consumed from the composed
  // dshd-gui plugin's `deepartments.gui` SERVICE (the `gui.endpointDeps`
  // binder bucket registered above) — the bundle no longer dispatches through
  // the inline closure; the mount only binds webServer + trustedHosts and calls
  // the service (fail-loud R1 when the bucket is missing; direct in-bundle
  // fallback when the plugin row is absent — R6, behavior-neutral).
  //
  // rc.8 TRANSPORT FIX: `ctx.connection.rpc.handle('/deepartments', ...)` did NOT
  // mount an HTTP route in rc.8 — dsh-client-connection registers ONLY the `/api`
  // prefix + its in-memory channel SERVICE via webServer; a channel registered on
  // `.rpc.handle` is NOT exposed as an HTTP endpoint. So a browser
  // `POST /deepartments/agents` never reached the old handler: the POST fell
  // through to the SPA fallback (405) and a GET returned the SPA HTML — the
  // sidebar heads were always empty. The CONFIRMED WORKING rc.8 pattern
  // (dshmarket) is to self-mount `kind:'exact'` routes on the live webServer
  // (dsh-web-app resolves ctx.get('webServer'); dsh-client-connection mounts /api
  // via ctx.webServer.register). We do the same, serving the SAME client wire
  // contract the client already speaks:
  //   request : POST ${origin}/deepartments/<endpoint>
  //             body { type:'client-request', rpcId, method:<endpoint>, payload }
  //   response: 200 JSON { type:'server-response', rpcId, result:{ok,value|error} }
  // Trust mirrors the connection channel (loopback always; otherwise the request
  // Host:port must be a declared trusted host). `webServer` is resolved by rule 7
  // (`ctx.get('webServer') ?? ctx.get('httpServer')`); when absent (headless /
  // host-less) the channel — a GUI feature — is skipped silently, exactly like
  // the old `connection !== void 0` gate (the client is the only consumer).
  //
  // rc.8 INJECT FIX: the bare `ctx.get('webServer')` / `ctx.get('connection')`
  // lookups did NOT resolve the live services in OUR plugin scope (the mount
  // silently skipped → the deployed routes returned HTTP 405 for HTTPS and
  // HTTP 403 for the Tailscale browser). The PROVEN pattern (dshmarket +
  // dsh-client-connection + dsh-web-app themselves) is to DECLARE the services
  // via `ctx.inject([...], (hostCtx) => ...)`: Cordis `inject` binds each named
  // service into the callback's scope, so `hostCtx.webServer` / the
  // `webRuntime` and `connection` bindings are guaranteed live here. We keep
  // rule 7's `httpServer` fallback, and skip silently (headless / host-less)
  // if webServer is absent — the channel is a GUI feature and the client is
  // the only consumer, exactly like the old `connection !== void 0` gate.
  ctx.inject(['webServer', 'webRuntime', 'connection'], (hostCtx) => {
    // Rule 7: prefer the injected webServer; fall back to the renamable
    // httpServer when webServer is undefined (headless host); skip if neither.
    // cordis' static Context type has no `webServer` property (services are
    // dynamically injected), so we widen the host context structurally — the
    // injected `webServer` is the live service bound into this callback scope.
    const host = hostCtx as Context & { webServer?: WebServerLike; webRuntime?: { trustedHosts?: string[] } }
    const webServer = (host.webServer ?? host.get('httpServer')) as WebServerLike | undefined
    if (webServer === void 0) return
    // Trusted authorities from the DEPLOYED web app: dsh-web-app's `webRuntime`
    // service (`resolveLanTrust` — dsh-web-app/lib/index.js:28,175) carries the
    // REAL populated list `{ ..., trustedHosts: [...lanAddresses, ...extra] }`
    // where `extra` is the `--trusted-host` list (e.g.
    // `laagencia.taildb5a7a.ts.net:8445` on the systemd unit). The deployment's
    // trusted hosts are configured on dsh-web-app, NOT dsh-client-connection, so
    // `connection.trustedHosts` is EMPTY at runtime and the real browser host is
    // denied (403) if we read only that — which is why we prefer `webRuntime`
    // FIRST. We fall back to `connection.trustedHosts` (the same list the rc.8
    // client-connection channel vets against) and to `[]` (loopback-only) when
    // both are absent.
    // NOTE: this Cordis build exposes NO `ctx.getConfig('...')` API (verified
    // absent from the cordis type surface and used by no dsh plugin), so the
    // trusted hosts are read from the live services' public, schema-backed
    // fields rather than the getConfig('web-app') / getConfig('client-connection')
    // fallbacks (documented deviation). Empty when the services are absent /
    // headless.
    // src/invoke.ts BINDS `connection` (the dsh-client-connection HostConnectionService)
    // into this callback via the inject declaration above, so it is read here
    // from the injected scope (`hostCtx.get('connection')`) rather than a bare
    // `ctx.get(...)` captured outside the inject — the bare lookup stayed
    // UNDEFINED in our scope, which is exactly why the Tailscale browser 403'd.
    const trustedHosts =
      (host.webRuntime as { trustedHosts?: string[] } | undefined)?.trustedHosts ??
      (hostCtx.get('connection') as ConnectionLike | undefined)?.trustedHosts ??
      []
    console.log(
      `[deepartments] /deepartments channel mounted; trustedHosts=${JSON.stringify(trustedHosts)}; routes: agents/list, host/status, presence/get, presence/set, agenda/list`
    )
    // DECOUPLING PASO 1 — the RPC channel surface is CONSUMED from the composed
    // dshd-gui plugin's `deepartments.gui` SERVICE (which dispatches with the
    // `gui.endpointDeps` binder bucket REGISTERED above — the same wiring this
    // effect used to build inline), instead of the direct in-bundle handler:
    //   - dshd-gui composed → the service provides the channel (fail-loud R1 at
    //     first use if the gui bucket is missing — the contract lock),
    //   - dshd-gui ABSENT (a minimal composition with webServer) → the bundle
    //     keeps serving the channel directly with the SAME registered deps
    //     (R6, behavior-neutral — the dispatch semantics are unchanged).
    const guiService = ctx.get('deepartments.gui') as
      | { handleRequest(req: unknown, res: unknown, endpoint: string, trustedHosts: string[]): Promise<void> }
      | undefined
    // Register each client path as a `kind:'exact'` POST route. `webServer.register`
    // returns a disposer; the effect folds them into one reversible registration
    // (AGENTS.md: every registration is a reversible effect).
    const routes: WebServerRouteLike[] = [
      { path: '/deepartments/agents', endpoint: 'agents' },
      { path: '/deepartments/list', endpoint: 'list' },
      { path: '/deepartments/host/status', endpoint: 'host/status' },
      { path: '/deepartments/presence/get', endpoint: 'presence/get' },
      { path: '/deepartments/presence/set', endpoint: 'presence/set' },
      { path: '/deepartments/agenda/list', endpoint: 'agenda/list' }
    ].map(({ path, endpoint }) => ({
      kind: 'exact' as const,
      path,
      handler: (req: unknown, res: unknown) =>
        guiService !== undefined
          ? guiService.handleRequest(req, res, endpoint, trustedHosts)
          : handleDeepartmentsRequest(req, res, endpoint, trustedHosts, guiEndpointDeps)
    }))
    hostCtx.effect(() => {
      const disposers = routes.map((route) => webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'deepartments: agents/list + host/status + agenda/list RPC channel')
  })

}
