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
//     (`sleepEpoch`) and DISPOSES the head's AgentHandle; the next wake
//     cold-resumes the SAME durable session via `ctx.agents.resume(...)` and
//     follows up with the pointer-only board delta. The durable session
//     survives `dispose()` (dispose tears the LIVE agent+session out of the
//     in-memory registry, not the sessionPersistence backend — rc.8
//     dsh-agent-loop prepare() dispose at index.js:1132-1152 detaches
//     `agents.enter`/`sessions.enter` registrations only), so resume restores
//     the same incarnation.
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
import { mkdir, readFile, writeFile, readdir, copyFile, stat, rename, unlink, appendFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { findSessionArtifact, runSleepCleanup, type SleepCleanupReport } from './session-cleanup.js'
import { runHostRotation, validateHostsRotationFile, ROTATION_SCHEMA_VERSION, ASISTENTE_SESSION_TITLE } from './session-rotation.js'
import type { RotationPersistenceLike, WorkspaceRegistryLike } from './session-rotation.js'
import type { Config, CoordinatorConfig, DepartmentConfig } from './org.js'
import {
  COMPACTION_LINE_THRESHOLD,
  MessagesStore,
  compactDeliveryRows,
  markDelivery,
  needsRedelivery,
  parseDeliveryRows,
  resolveDeliveriesPath
} from './messages-store.js'
import type { DeliveryStatus, MessageRecord } from './messages-store.js'
import { buildAgentRows } from './agents.js'
import type { PostEntryLike } from './agents.js'
import {
  HEAD_PRESET_BASE_ID,
  headPresetIdFor,
  headPresetNameCore,
  headPresetNameFor,
  buildHeadPresetComposition,
  buildHeadPresetMetadata
} from './head-presets.js'
import { roleForSession, buildSubagentOrientation } from './role-orient.js'
import type { SubagentRole } from './role-orient.js'

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

/** Prefix of a runtime host-address registry entry: `host-<sessionId>`. */
const HOST_ID_PREFIX = 'host-'

/** Prefix of a department head's STABLE root-agent session id: `head-<postId>`.
 * Deterministic and namespaced (never collides with host/room/parent sessions),
 * so a head's durable session is resolvable across boots and cold restarts. */
const HEAD_SESSION_PREFIX = 'head-'

/** The stable root-agent session id of a configured department head. */
function headSessionId(postId: string): string {
  return `${HEAD_SESSION_PREFIX}${postId}`
}

/** Prefix of a DISPOSABLE department WORKER's stable root-agent session id:
 * `worker-<postId>`. Namespaced so it NEVER collides with a configured head's
 * `head-<postId>` id, and — critically — **never re-materialized by
 * ensureAllHeads**, which ONLY ever iterates CONFIGURED coordinators
 * (`config.org.departments[].coordinator`). A worker is created at runtime by
 * `dept_post_create` (not config), so after `dept_post_retire` removes its
 * registry entry there is NO boot path that re-spawns it: the "retired worker
 * stays retired" guarantee holds trivially. */
const WORKER_SESSION_PREFIX = 'worker-'

/** The stable root-agent session id of a disposable department worker. */
function workerSessionId(postId: string): string {
  return `${WORKER_SESSION_PREFIX}${postId}`
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

/** B3 cutover (spec 003 §7.2): the wake-pack message-delta section carries the
 * caller's LATEST-RECEIVED messages, capped small — the pack is injected every
 * wake turn, so the section must stay lean. */
const WAKE_MESSAGE_DELTA_LIMIT = 5

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

/** One durable post registry entry — a FIRST-CLASS ROOT-AGENT department head
 * (Batch 1a). Keyed by postId; the durable root-agent session id is `sessionId`
 * (= `head-<postId>`). Drops the old continuable-subagent `parentId`/`provider`
 * continuation fields from the persisted JSON — a root head has no parent. The
 * `agentPreset: 'deepartments-head'` field is the marker that this is a
 * CONFIGURED permanent head (vs a future disposable worker). */
interface PostEntry {
  postId: string
  /** Stable root-agent session id (`head-<postId>` for a configured head,
   * `worker-<postId>` for a DISPOSABLE worker), shared by the agent registry
   * and its persisted session; the wake/dispose/resume identity. */
  sessionId: string
  roomId: string
  /** The root-agent preset id this post mounts. `'deepartments-head'` marks a
   * CONFIGURED permanent head; `'deepartments-worker'` marks a DISPOSABLE
   * worker created at runtime by dept_post_create. */
  agentPreset: string
  /** Batch 3a: disposable-worker marker. Only set (`'worker'`) for workers
   * created by `dept_post_create`. Absent/undefined = a configured permanent
   * head. This registry-level flag is what lets `dept_post_retire` (head path)
   * retire workers without ever touching permanent heads, and it is NOT read by
   * `ensureAllHeads` (which only iterates config coordinators). */
  provider?: 'worker'
  /** Batch 3a: the ROLE captured at create time (e.g. 'rank-and-file
   * researcher'). Used as the persona/role fallback when waking a worker —
   * `coordinatorForPost` is undefined for workers (they have no config), so the
   * durable entry carries the role the creating head supplied. */
  role?: string
  /** F1 (spec 004 §4.1): the durable department link of a WORKER — the config
   * department id of the creating head's department, recorded at create
   * (the pre-F1 code only copied the inert roomId). A configured department
   * head is derived from config instead (`departmentForPost`). Absent on
   * legacy workers (pre-F1 entries) and on heads (config-derived). */
  departmentId?: string
  /** F1 (spec 004 §4.1/§4.2): the postId of the HEAD that created this worker
   * ("my workers" — the per-owner retire scope). Absent on legacy workers.
   * Never set on heads (they come from config, not from a creator). */
  managerId?: string
  /** F1 (spec 004 §3.4/§5.4): set when the worker was spawned by a JOB run
   * (F4) — the versioned job definition id. Absent on plain ephemeral workers
   * (dept_post_create) and on heads. */
  jobId?: string
  /** F1 (spec 004 §4.3): RETIREMENT IS MARKED, NEVER ERASED. `dept_post_retire`
   * on a worker sets this flag and KEEPS the registry entry (byPost +
   * posts.json), so the history stays queryable; the LIVE catalog
   * (busDeliverCatalog addressing, dept_who, the wake-pack roster) filters
   * retired entries. Absent/false = live. Never set on configured heads
   * (a head retire stays cosmetic — the config re-materializes it). */
  retired?: boolean
  /** Batch G: set when the head SLEPT (memoized + marked). On the next wake the
   * relay cold-resumes the SAME durable session (context reset + journal reload)
   * instead of waking a live incarnation; cleared once the respawn lands.
   * Absent/undefined = never slept. */
  sleepEpoch?: number
  /** Task T1 (Session Memory Archive): the session event `seq` recorded at the
   * previous dept_sleep boundary (agent.session.seq immediately after the
   * boundary append). Stored so the next cycle's session-log capture can slice
   * events with `seq > boundarySeq` EXACTLY (clock-independent). Absent = first
   * ever cycle (falls back to the `time > lastWakeMs` timestamp slice). */
  boundarySeq?: number
  /** Batch G: the sessionId of the PREVIOUS incarnation (recording where a slept
   * head's old live session went), kept so trace stays honest. Absent = first. */
  previousChildId?: string
}

/** The DURABLE shape persisted to posts.json. */
interface PostEntryPersisted {
  sessionId: string
  roomId: string
  agentPreset: string
  provider?: 'worker'
  role?: string
  /** F1 — persisted only when set (absent = legacy/pre-F1 entry). */
  departmentId?: string
  managerId?: string
  jobId?: string
  retired?: boolean
  sleepEpoch?: number
  boundarySeq?: number
  previousChildId?: string
}

/** One durable host registry entry (hostId → host session in a room). */
interface HostEntry {
  hostId: string
  sessionId: string
  roomId: string
  /** Batch 7: set when the host SLEPT (dept_sleep, host branch — journal
   * persisted + surface reset to the journal). Durable marker: "the Asistente
   * slept at T". A host does NOT dispose its live AgentHandle (the web
   * api-proxy owns it — see explore-deep/2026-08-20-host-sleep.md), so unlike
   * a head it stays live after sleep; the marker records that a context reset
   * happened and the journal IS the current surface. Absent = never slept. */
  sleepEpoch?: number
  /** Task T1 (Session Memory Archive): the session-event `seq` recorded at the
   * previous dept_sleep boundary, for exact one-cycle session-log slicing. See
   * PostEntry.boundarySeq. Absent = first-ever cycle. */
  boundarySeq?: number
  /** Web-UI sleep cleanup (Option A): set at dept_sleep (host branch), cleared
   * by the FIRST boot that successfully truncates the host session artifact.
   * The truncation CANNOT run inside dept_sleep (the harness appends the tool
   * result + step/end + turn/end AFTER execute() returns at LIVE in-memory
   * seqs, and the Session constructor requires events contiguous from seq 0 —
   * see src/session-cleanup.ts header), so this durable marker makes the next
   * process's boot perform the cleanup exactly once per sleep cycle; mid-wake
   * restarts (flag cleared) are exact no-ops. Absent = no cleanup pending. */
  webUiCleanupPending?: boolean
  /** Fix wake-12 (explore-deep/2026-08-21-first-turn-api-orphan.md): the
   * DURABLE seed for Fix A's deferred sleep surface replace. dept_sleep (host
   * branch) records it alongside the in-memory `deferredSleepReplace` intent
   * (the seeded journal text the wake fold re-inserts); the boot hosts loader
   * restores it into that map so the FIRST pre-step of a RESTARTED process
   * still performs the full-window fold. Without the restore the in-memory map
   * (which dies with the process) is empty, the fold is skipped, and the
   * journal-interleaved close tail [assistant(tool_calls)·journal·tool] ships
   * in the first request — the strict opencode-go API 400s ("insufficient
   * tool messages following tool_calls"). Cleared when the fold consumes the
   * intent (a mid-wake restart must never re-fold the whole wake surface back
   * to the journal). Absent = no deferred replace pending. */
  deferredJournalSeed?: string
  /** U2 (spec 002 §3.5/D4): set on the RETIRED old entry after a host session
   * ROTATION at dept_sleep. The entry STAYS in hosts.json (queryable as
   * evidence, D1) but the wake gate skips it (retire = "no pack + no
   * registration", §4/C1) and the roster/cleanup treat it as retired. Absent
   * (or false) = live (pre-rotation behavior). */
  retired?: boolean
  /** U2 (D4): when this entry was retired (ms epoch); required on retired. */
  retiredAt?: number
  /** U2 (D4): the `host-<newId>` this retired entry rotated to; required on
   * retired. */
  rotatedTo?: string
  /** U2 (D4): on a LIVE entry that was created by a rotation — the sessionId
   * it rotated FROM (must reference a retired entry in the same file). */
  previousSessionId?: string
}

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
  cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
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

/** Structural view of the `agents` service surface the head lifecycle touches
 * (rc.8 dsh-agent types/index.d.ts:288-370). */
interface AgentsLike {
  get(id: string): AgentLike | undefined
  list(): AgentLike[]
  roots(): AgentLike[]
  create(options: {
    sessionId: string
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

/**
 * Format one message-store record as a compact TOC line for the model-facing
 * message delta (spec 003 §7.2 — the wake pack's message-delta section): the
 * record id + sender → recipients + a short preview. The preview is truncated
 * to 140 chars with an explicit '…' when longer — never silently shortened.
 */
function formatMessageDeltaLine(message: Pick<MessageRecord, 'id' | 'from' | 'to' | 'text' | 'kind'>): string {
  const preview = message.text.length > 140 ? `${message.text.slice(0, 140)}…` : message.text
  return `- ${message.id} | ${message.from} → ${message.to.join(', ') || '(all)'} | ${preview}`
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

/** The surface-op arguments (a full-window replace, or a bare append when the
 * surface is empty — a replace needs at least one existing node to shadow). */
export interface HostSleepSurfacePlan {
  surfaceOp: { op: 'replace'; start: number; end: number } | 'append'
  /** Present for the replace branch: every currently-shadowed surface node. */
  sourceEventSeqs?: number[]
}

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

/**
 * Build the single landing node for a host surface reset: the agent's journal
 * as a `user/message` whose `source` is `kind:'plugin' / form:'notice'` (NOT
 * `kind:'user'`) so it renders as a collapsed context/notice row in the GUI,
 * not as if the owner said it (the KEY property: `deriveMessages()` folds the
 * node's content verbatim on the next turn). The frame is bound via
 * `boundContextSummary` per the dsh-llm notice contract.
 */
export function buildSleepJournalMessage(journalText: string) {
  return createUserMessage({
    content: [{ type: 'text', text: journalText }],
    source: {
      kind: 'plugin',
      plugin: 'deepartments',
      form: 'notice',
      summary: boundContextSummary('Reopened after sleep — in-place surface reset to your journal (long-term memory).')
    }
  })
}

/**
 * Build the Deepartments wake context pack message, framed like the journal node
 * (`kind:'plugin' / form:'notice'` → collapsed notice row, NOT a user-typed
 * message, so `deriveMessages()` folds its content verbatim on the next turn).
 * Injected FRESH via `agent/pre-step` at message-arrival time by the host
 * pre-step injector (not frozen into the surface at dept_sleep), so its board
 * delta / git / roster / cursor are current when the user's message arrives.
 * Kept separate from `buildSleepJournalMessage` so the journal node stays
 * byte-identical; the pack gets its own notice summary.
 */
export function buildWakePackMessage(packText: string) {
  return createUserMessage({
    content: [{ type: 'text', text: packText }],
    source: {
      kind: 'plugin',
      plugin: 'deepartments',
      form: 'notice',
      summary: boundContextSummary('Deepartments wake context pack — injected orientation (identity, journal path, board delta, roster, git, system state, full deepartments-workflow skill).')
    }
  })
}

/**
 * Task T4 — the compact ROLE-focused orientation injected into a TRANSIENT
 * dispatched subagent (origin === 'subagent') at its first pre-step, in place
 * of the full ~4.6-4.9k-token host wake pack. One org line + the per-role
 * contract block (from src/role-orient.ts) + a reporting pointer. Same
 * plugin/notice surface as the host pack so it lands as a collapsed row.
 */
export function buildSubagentOrientationMessage(role: SubagentRole) {
  // role-orient.ts still takes a `roomId` parameter (out of B3a scope — its
  // identity line is being cleaned in the persona-wording phase); the B3
  // cutover passes the org label so the subagent identity never names a board
  // room.
  return createUserMessage({
    content: [{ type: 'text', text: buildSubagentOrientation(role, 'deepartments') }],
    source: {
      kind: 'plugin',
      plugin: 'deepartments',
      form: 'notice',
      summary: boundContextSummary('Deepartments · subagent — role-focused orientation (role contract injected; no host wake pack).')
    }
  })
}

// ---------------------------------------------------------------------------
// Batch W4 — WAKE CONTEXT PACK (owner doctrine: inject, don't let the model
// re-derive). The freshly-woken host MUST receive ALL orientation info + the
// full workflow skill body sealed into its initial surface, the same way DSH
// injects skill-catalog and dsh-system-prompt — NOT pushed to on-demand/lazy.
// The pack is assembled by a NON-pure closure in applyInvoke (live git/board/
// ROADMAP/skill reads) but rendered by this PURE, exported `buildWakePack`
// helper so it is directly unit-testable. `dept_wake_snapshot` reuses the SAME
// pure builder for on-demand freshness mid-session (P1 fusion).
//
// Deep rule (stale-liveness): the pack NEVER statically embeds true live
// session liveness (`sessionLive`) — a stale false claim is worse than one
// on-demand `dept_who`. Roster carries only durable registry flags
// (sleeping), listing flags that are live-registry reads never baked in.
// ---------------------------------------------------------------------------

/** Canonical host wake routine (verbatim — wake-pack section 9 guidance; the
 * skill's "Wake routine (injected wake)" section + checklist mirror it). The
 * journal footer is one-line pointer to the skill, so this text is NOT
 * duplicated in dept_sleep seeds (Batch C P1 dedupe, see ~2051). */
export const HOST_WAKE_ROUTINE_TEXT =
  'Start-of-session: your Deepartments context injection already carries identity, the pre-resolved journal path + journal body, the message delta (latest received), the condensed roster, git bearings, system state, and the full deepartments-workflow skill. Read it — do not re-fetch what the pack provides. Only call tools for LIVE needs the pack cannot cache: true session liveness (dept_who), full text of a message you must answer (agent_messages before- cursor), writes (send_message), or dept_sleep. REPLY FIRST: your first output of the wake turn is the owner-facing message — greeting + a <=5-line top-item plan + the explicit ask "what do you want this session?" — before ANY tool call (the only exception: the fail-loud health check when the pack itself is stale/ambiguous, which still surfaces the situation to the owner before working). The plan is PROPOSED, not authorized: do NOT dispatch subagents, explore the codebase, or start the item until the human answers; to ground the plan, at most 1–2 reads of a journal-referenced report and zero src/checkout exploration or bash before go-ahead. Then pick the highest-priority unfinished open item, present a concise plan, and WAIT for the owner\'s answer before working. Full sequence: skill deepartments-workflow ("Wake routine").'

/** The closing guidance line that follows the canonical routine in the pack. */
export const HOST_WAKE_NEXT_STEP =
  'next step: pick the highest-priority unfinished open item from the journal and present a concise plan — but reply FIRST: your first output of the wake turn is the owner-facing message (greeting + a <=5-line plan + "what do you want this session?") before ANY tool call, and the plan stays PROPOSED until the human answers: do NOT dispatch subagents, explore the codebase, or start the item, and keep grounding to at most 1–2 reads of a journal-referenced report with zero src/checkout bash before go-ahead.'

/**
 * The pre-rendered parts `buildWakePack` composes. Every field except
 * memberId/role/messageDelta/roster is OPTIONAL: the wake injection supplies
 * all of them (sections 1-9), while the on-demand `dept_wake_snapshot` supplies
 * only identity+messageDelta+roster (sections 1, 3, 4). A section is rendered
 * exactly when its content is present — so the SAME pure builder produces both
 * the full wake pack and the lean live snapshot.
 */
export interface WakePackParts {
  memberId: string
  role: string
  /** Deterministic presence sentinel line injected as the FIRST element of
   * section 1 (see `buildWakePack`) so the wake-pack node's presence is
   * detectable by health checks / the pre-step gate without parsing the JSON
   * identity. Present in EVERY pack via this shared builder (wake injection
   * and the on-demand snapshot). */
  /** wake_counter + top-1 open-item KPI line (wake injection only; section 1).
   * `assembleWakePack` computes it live from the journal, degrading gracefully
   * when the journal is absent — so a never-slept session still gets a KPI line. */
  kpi?: string
  /** Pre-resolved durable journal path (wake injection only; section 2). */
  journalPath?: string
  /** Message-delta TOC body (latest received, spec 003 §7.2). '' → empty
   * section (no messages yet). */
  messageDelta: string
  /** Condensed roster (registry flags only — NEVER live session liveness). */
  roster: string
  /** Git bearings (section 5; wake injection only). */
  git?: string
  /** System state (section 6; wake injection only). */
  systemState?: string
  /** ROADMAP "Current status" tail (section 7; wake injection only). */
  roadmapTail?: string
  /** Full deepartments-workflow skill body (section 8; wake injection only). */
  skillBody?: string
  /** Include the closing guidance (section 9)? Defaults true (wake injection). */
  includeGuidance?: boolean
}

/** Compose the Deepartments context pack as a string, sections 1-9 in order.
 * PURE: no I/O, no registry/live reads — every section body is provided by the
 * caller. Enforces the deep rule by construction: there is simply no channel to
 * inject live `sessionLive` liveness here. */
export function buildWakePack(parts: WakePackParts): string {
  const sections: string[] = []

  // 1 — header + identity (+ the P1 presence sentinel as the very first body
  // element, and the P2 wake_counter/top-open-item KPI line when supplied).
  const identityLines = [
    '## Deepartments wake pack',
    'pack-v1: present',
    `- identity: ${parts.memberId} (role: ${parts.role})`
  ]
  if (parts.kpi !== undefined && parts.kpi.trim() !== '') {
    identityLines.push(`- kpi: ${parts.kpi}`)
  }
  sections.push(identityLines.join('\n'))

  // 2 — journal pointer (wake injection only)
  if (parts.journalPath !== undefined && parts.journalPath.trim() !== '') {
    sections.push([
      '## Journal (long-term memory)',
      `Pre-resolved journal path: \`${parts.journalPath}\``,
      'The journal body is the adjacent injected node.'
    ].join('\n'))
  }

  // 3 — message delta TOC (latest received; always rendered; body may be empty)
  sections.push(
    parts.messageDelta.trim() === ''
      ? '## Message delta (received)'
      : `## Message delta (received)\n${parts.messageDelta}`
  )

  // 4 — condensed roster (always rendered)
  sections.push(`## Condensed roster\n${parts.roster}`)

  // 5 — git bearings
  if (parts.git !== undefined && parts.git.trim() !== '') {
    sections.push(`## Git bearings\n${parts.git}`)
  }

  // 6 — system state
  if (parts.systemState !== undefined && parts.systemState.trim() !== '') {
    sections.push(`## System state\n${parts.systemState}`)
  }

  // 7 — ROADMAP "Current status" tail
  if (parts.roadmapTail !== undefined && parts.roadmapTail.trim() !== '') {
    sections.push(`## ROADMAP current status (tail)\n${parts.roadmapTail}`)
  }

  // 8 — full skill body
  if (parts.skillBody !== undefined && parts.skillBody.trim() !== '') {
    sections.push(`## deepartments-workflow skill (full body)\n${parts.skillBody}`)
  }

  // 9 — guidance (canonical routine + next step; wake injection only)
  if (parts.includeGuidance !== false) {
    sections.push([
      '## Guidance (wake routine)',
      HOST_WAKE_ROUTINE_TEXT,
      HOST_WAKE_NEXT_STEP
    ].join('\n'))
  }

  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// `/deepartments` sidebar RPC channel — server half.
//
// rc.8 TRANSPORT FIX (see the effect below): the channel is served over
// self-mounted `kind:'exact'` POST routes on the live `webServer` (the pattern
// dshmarket + dsh-client-connection prove works in rc.8), NOT via
// `ctx.connection.rpc.handle(...)` (which rc.8 does not mount as an HTTP route,
// so a browser POST fell through to the SPA fallback → 405 and the sidebar was
// always empty). The client contract is unchanged and the extraction below is
// deliberately PURE + exportable so it is directly unit-testable without
// node:http (test/rpc-channel.test.js) — mirroring how buildAgentRows is tested.
// ---------------------------------------------------------------------------

/** Loose structural view of a `webServer`/`httpServer` HTTP route. */
export interface WebServerRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

/** Loose structural view of the renamable `webServer`/`httpServer` service
 * (AGENTS.md rule 7; resolved via `ctx.get('webServer') ?? ctx.get('httpServer')`). */
export interface WebServerLike {
  register(route: WebServerRouteLike): () => void
}

/** Loose structural view of one host-registry entry (hosts.json value). */
export interface HostEntryLike {
  hostId: string
  sessionId: string
  roomId?: string
  /** U2 (spec 002 §3.5/D4): rotation schema — set on RETIRED old entries (the
   * entry STAYS in hosts.json as evidence; the wake gate skips it). */
  retired?: boolean
  /** U2 (D4): when the entry was retired (ms epoch); required on retired. */
  retiredAt?: number
  /** U2 (D4): the `host-<newId>` this retired entry rotated to. */
  rotatedTo?: string
  /** U2 (D4): on a LIVE entry created by a rotation — the session id it
   * rotated FROM (references a retired entry in the same file). */
  previousSessionId?: string
}

/** Injected data/closure bundle the PURE endpoint dispatcher reads. The caller
 * (the route handler in applyInvoke) wires these to the live registries; tests
 * construct this directly. */
export interface DeepartmentsEndpointDeps {
  /** config.org.departments — one row built per (coordinator-bearing) department. */
  departments: DepartmentConfig[]
  /** The durable post registry (postId → entry). */
  byPost: Map<string, PostEntryLike>
  /** The host registry, iterated to resolve a caller host member id by sessionId. */
  hosts: Iterable<HostEntryLike>
  /** Live signal: the head's session is present in the agents registry. */
  sessionLive(sessionId: string): boolean
  /** Optional refinement: the head's session is currently running (status). */
  sessionRunning?: (sessionId: string) => boolean
  /** Optional (U3): read the live host's journal wake_counter (number) for the
   * `host/status` payload. Absent dep → the payload omits wakeCounter (the
   * payload must stay minimal and stable). Contract: never throws (a read
   * failure is an omission, never an RPC error). */
  loadHostWakeCounter?: (hostId: string) => Promise<number | undefined>
  /** Optional (U3 fix): a minimal warn-capable logger for AMBIGUOUS live-host
   * selection in `host/status` (the pickLiveHostEntry fallback — multiple live
   * entries with no rotation successor). Absent dep → the warn is skipped and
   * the fallback pick is still deterministic (never throws). */
  logger?: { warn: (message: string) => void }
}

/** The `/deepartments host/status` RPC payload (U3, spec 002 §6.1): the CURRENT
 * registered host session — the live (non-retired) hosts.json entry — plus the
 * RETIRED entries. Client contract (src/client/index.tsx mirrors it): the
 * watcher opens ONLY transitions to a DIFFERENT non-null `hostSessionId`;
 * `retired` is informative (the native sidebar already hides archived rows). */
export interface HostStatusPayload {
  /** The current registered host session id, or null when no host is
   * registered (and no live entry — e.g. only retired entries remain). */
  hostSessionId: string | null
  /** The live entry's rotation-source session id; null when absent (legacy
   * in-place host, or no live entry). */
  previousSessionId: string | null
  /** Retired host entries (sessionId + when they were retired), in hosts.json
   * order (oldest rotation first). */
  retired: Array<{ sessionId: string; retiredAt: number }>
  /** The live host's journal wake_counter, when readable; OMITTED otherwise
   * (the payload stays minimal and stable). */
  wakeCounter?: number
}

/** Result of the deterministic live-host selection (U3 fix, spec 002 §6.1). */
export interface PickLiveHostResult {
  /** The selected live entry, or undefined when NO live entry exists. */
  live: HostEntryLike | undefined
  /** True when the AMBIGUITY FALLBACK branch fired (multiple live entries,
   * none carrying `previousSessionId`): the caller should log a warn listing
   * the candidates. False for the successor / single-live / no-live branches. */
  ambiguous: boolean
}

/** PURE deterministic live-host selection for the `host/status` payload (U3
 * fix, spec 002 §6.1). Among the NON-RETIRED entries, prefer, in order:
 *   (a) the rotation-created SUCCESSOR — the entry carrying
 *       `previousSessionId` (the true current host after a rotation);
 *   (b) the ONLY live entry, when exactly one exists;
 *   (c) the first live entry in iteration (insertion) order, flagged
 *       `ambiguous: true` so the caller can warn.
 * Deterministic for every hosts.json shape: the previous first-non-retired
 * pick silently returned a STALE entry (e.g. a dead bare `host-1a4af1ea`)
 * instead of the rotated successor in the wake-12→13 incident (post-mortem
 * finding #2). No side effects — unit-testable without the invoke context. */
export function pickLiveHostEntry(entries: Iterable<HostEntryLike>): PickLiveHostResult {
  let successor: HostEntryLike | undefined
  const liveEntries: HostEntryLike[] = []
  for (const entry of entries) {
    if (entry.retired === true) continue
    liveEntries.push(entry)
    if (
      successor === undefined &&
      entry.previousSessionId !== undefined &&
      entry.previousSessionId !== ''
    ) {
      successor = entry
    }
  }
  if (successor !== undefined) return { live: successor, ambiguous: false }
  if (liveEntries.length === 1) return { live: liveEntries[0], ambiguous: false }
  if (liveEntries.length === 0) return { live: undefined, ambiguous: false }
  // Multiple live entries, none rotation-created → ambiguity fallback.
  return { live: liveEntries[0], ambiguous: true }
}

/** PURE builder of the `host/status` payload — derived from the in-memory host
 * registry only (no side effects; the only non-pure part is an optional
 * ambiguity `deps.logger.warn`). Empty hosts / no live entry →
 * `{ hostSessionId: null, previousSessionId: null, retired: [] }`. Live-host
 * selection is DETERMINISTIC via pickLiveHostEntry (U3 fix): prefer the
 * rotation successor (`previousSessionId`), then the single live entry, then
 * the first live entry with an ambiguity warn (post-mortem finding #2 — the
 * old first-non-retired pick returned a stale live entry after a rotation). */
async function buildHostStatusPayload(deps: DeepartmentsEndpointDeps): Promise<HostStatusPayload> {
  const { live, ambiguous } = pickLiveHostEntry(deps.hosts)
  if (ambiguous && deps.logger !== undefined) {
    // Multiple live entries with no rotation successor — the pre-fix selection
    // silently chose the FIRST one (a stale live entry, e.g. a dead bare
    // `host-1a4af1ea`). Warn with the candidates so the Asistente can clean
    // the drifted live state; the payload still picks deterministically.
    const candidates = [...deps.hosts]
      .filter((entry) => entry.retired !== true)
      .map((entry) => `${entry.hostId} (sessionId=${entry.sessionId}${entry.previousSessionId === undefined ? '' : `, previousSessionId=${entry.previousSessionId}`})`)
    deps.logger.warn(
      `[deepartments] host/status: ${candidates.length} live host entries with no rotation successor — picked ${live?.hostId ?? 'none'} deterministically; candidates: ${candidates.join(', ')}`
    )
  }
  const retired: Array<{ sessionId: string; retiredAt: number }> = []
  for (const entry of deps.hosts) {
    if (entry.retired === true) {
      // The loader validator guarantees retiredAt on retired entries (spec 002
      // §3.5); the defensive skip keeps the payload shape strict.
      if (typeof entry.retiredAt === 'number') {
        retired.push({ sessionId: entry.sessionId, retiredAt: entry.retiredAt })
      }
    }
  }
  const hostSessionId = live === undefined ? null : live.sessionId
  const previousSessionId = live?.previousSessionId ?? null
  let wakeCounter: number | undefined
  if (live !== undefined && deps.loadHostWakeCounter !== undefined) {
    try {
      const counter = await deps.loadHostWakeCounter(live.hostId)
      if (typeof counter === 'number' && Number.isFinite(counter)) wakeCounter = counter
    } catch {
      // Never throw from the dispatcher; the field is simply omitted.
    }
  }
  return {
    hostSessionId,
    previousSessionId,
    retired,
    ...(wakeCounter === undefined ? {} : { wakeCounter })
  }
}

/** The RpcResult-shaped value the client already understands
 * (serverResponseSchema.result: `{ok:true, value}` | `{ok:false, error}`). */
export type DeepartmentsDispatchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/**
 * PURE endpoint dispatcher for the `/deepartments` channel — the SAME endpoint
 * logic the legacy `ctx.connection.rpc.handle('/deepartments', ...)` served,
 * extracted into a testable function (no node:http imports). Handles
 * `agents`/`list` (department-head roster rows with per-host unread counts —
 * the client roster heartbeat; kept per U1, it is NOT part of the removed
 * sidebar) and `host/status` (U3 — the client lifecycle watcher's rotation
 * signal, spec 002 §6.1). Never throws for a normal call:
 * an unknown endpoint is a bad-request result, and internal failures are left
 * to the caller to fold (the route handler maps them to the `internal` branch).
 */
export async function dispatchDeepartmentsEndpoint(
  endpoint: string,
  payload: unknown,
  deps: DeepartmentsEndpointDeps
): Promise<DeepartmentsDispatchResult> {
  if (endpoint === 'host/status') {
    return { ok: true, value: await buildHostStatusPayload(deps) }
  }
  if (endpoint !== 'agents' && endpoint !== 'list') {
    return {
      ok: false,
      error: {
        code: 'bad-request',
        message: 'unknown endpoint: ' + endpoint,
        details: { issues: [] }
      }
    }
  }
  // Resolve the caller host member id (host-<sessionId>) from its sessionId.
  // If the caller host is not (yet) registered in `hosts`, nothing to count
  // against. B3 cutover: the board-based unread derivation is KILLED (spec
  // 003 §7.1 — no read/seen marks in the messaging phase, §5 note: repoint to
  // messages.jsonl counts or kill); the row's `unread` is a stable 0 and the
  // `completed-notice` status branch simply never fires.
  let sessionId: string | undefined
  if (typeof payload === 'object' && payload !== null) {
    const rawSession = (payload as { sessionId?: unknown }).sessionId
    if (typeof rawSession === 'string') sessionId = rawSession
  }
  const unreadFor = (_postId: string): number => 0
  const rows = buildAgentRows({
    departments: deps.departments,
    posts: deps.byPost as unknown as Map<string, PostEntryLike>,
    sessionLive: deps.sessionLive,
    sessionRunning: deps.sessionRunning,
    unreadFor,
    sessionId
  })
  return {
    ok: true,
    value: {
      host: { id: 'asistente', name: 'Asistente', department: "User's Office" },
      agents: rows
    }
  }
}

/** Whether a normalized URL hostname names the local loopback authority
 * (localhost, IPv6 `[::1]`, or any IPv4 address in 127/8). Pure — mirrors
 * dsh-client-connection isLoopbackHostname. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
export function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether the parsed request authority matches a `trustedHosts` entry (an
 * exact host:port, or a port-less host matching the hostname on any port).
 * Pure — mirrors dsh-client-connection isTrustedAuthority. */
export function isTrustedAuthority(hostUrl: URL, trustedHosts: string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
    const canonical = port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
    // An entry with no explicit port matches the hostname on ANY port; an entry
    // with an explicit port matches that exact host:port.
    return canonical === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** Plain request-header facts (no node:http / Headers dependency) the trust
 * fence reads; unit-testable directly. */
export interface HostTrustFacts {
  host?: unknown
  origin?: unknown
  secFetchSite?: unknown
}

/** Decide whether one request's headers may reach the channel: loopback hosts
 * always accepted; otherwise the Host:port must be a declared trusted host;
 * a `cross-site` fetch or a cross-origin page never passes. Pure — mirrors
 * dsh-client-connection isTrustedApiRequest without node/http types. */
export function isTrustedHostFact(facts: HostTrustFacts, trustedHosts: string[]): boolean {
  const host = typeof facts.host === 'string' ? facts.host : undefined
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (facts.secFetchSite === 'cross-site') return false
  if (facts.origin === undefined) return true
  try {
    return new URL(String(facts.origin)).host === hostUrl.host
  } catch {
    return false
  }
}

/** A validated `client-request` envelope (client-proxy schema). */
export interface ClientEnvelope {
  rpcId: string
  method: string
  payload: unknown
}

export type ParseClientEnvelopeResult =
  | { ok: true; message: ClientEnvelope }
  | { ok: false; issues: unknown[] }

/** Validate the client-request envelope `{type, rpcId, method, payload}`.
 * Pure — no deps, mirrors the reference clientRequestSchema constraints. */
export function parseClientEnvelope(body: unknown): ParseClientEnvelopeResult {
  if (typeof body !== 'object' || body === null) return { ok: false, issues: ['body is not an object'] }
  const raw = body as Record<string, unknown>
  const issues: unknown[] = []
  if (raw.type !== 'client-request') issues.push('type must be "client-request"')
  if (typeof raw.rpcId !== 'string') issues.push('rpcId must be a string')
  if (typeof raw.method !== 'string') issues.push('method must be a string')
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, message: { rpcId: raw.rpcId as string, method: raw.method as string, payload: raw.payload } }
}

// ---- thin node:http wiring (NOT pure; kept minimal — the logic lives above) --

/** Loose structural view of the node:http request the route handler receives. */
interface HttpRequestLike {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<Buffer>
}

/** Loose structural view of the node:http response the route handler owns. */
interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(chunk?: string): unknown
}

/** Carrier cap for channel bodies (tiny JSON; bound resident memory defensively). */
const MAX_REQUEST_BODY_BYTES = 160 * 1024 * 1024

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

async function readRequestBody(req: HttpRequestLike): Promise<string> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buf.byteLength
    if (received > MAX_REQUEST_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function respondJson(res: HttpResponseLike, rpcId: string, result: DeepartmentsDispatchResult): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/** Echo-token for an invalid envelope: the request's rpcId when readable, else
 * the dsh-reference sentinel `invalid-request`. */
function envelopeRpcId(body: unknown): string {
  const raw = body as { rpcId?: unknown } | null
  return typeof raw?.rpcId === 'string' ? raw.rpcId : 'invalid-request'
}

/** One exact `/deepartments/<endpoint>` POST route handler. Enforces the trust
 * fence (method + authority), decodes + validates the envelope, checks the
 * method↔endpoint match, then delegates to the PURE dispatch and answers the
 * standard `{type:'server-response', rpcId, result}` the client validates.
 * A dispatch THROW is folded into the `internal` error result — never crossed
 * the wire as a parse failure. */
async function handleDeepartmentsRequest(
  req: unknown,
  res: unknown,
  endpoint: string,
  trustedHosts: string[],
  deps: DeepartmentsEndpointDeps
): Promise<void> {
  const httpReq = req as HttpRequestLike
  const httpRes = res as HttpResponseLike
  // Only the channel's POST endpoints are served; any other method on these
  // EXACT paths returns 405 so the SPA fallback never leaks index.html for the
  // channel (the old rc.8 behavior handed those GETs the SPA HTML).
  if (httpReq.method !== 'POST') {
    httpRes.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    httpRes.end('method not allowed')
    return
  }
  // Trust fence: loopback always accepted; otherwise the request Host:port must
  // be in the deployment's trusted hosts (mirrors isTrustedApiRequest loopback
  // behavior + the connection channel's trusted-host authority).
  if (!isTrustedHostFact({
    host: headerValue(httpReq.headers?.['host']),
    origin: headerValue(httpReq.headers?.['origin']),
    secFetchSite: headerValue(httpReq.headers?.['sec-fetch-site'])
  }, trustedHosts)) {
    httpRes.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    httpRes.end('forbidden')
    return
  }
  let body: unknown
  try {
    body = JSON.parse(await readRequestBody(httpReq))
  } catch {
    httpRes.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    httpRes.end('body is not JSON')
    return
  }
  const parsed = parseClientEnvelope(body)
  if (!parsed.ok) {
    respondJson(httpRes, envelopeRpcId(body), {
      ok: false,
      error: { code: 'bad-request', message: 'invalid client-request message', details: { issues: parsed.issues } }
    })
    return
  }
  const { rpcId, method } = parsed.message
  if (method !== endpoint) {
    respondJson(httpRes, rpcId, {
      ok: false,
      error: {
        code: 'bad-request',
        message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: { issues: [] }
      }
    })
    return
  }
  try {
    const result = await dispatchDeepartmentsEndpoint(endpoint, parsed.message.payload, deps)
    respondJson(httpRes, rpcId, result)
  } catch (error) {
    respondJson(httpRes, rpcId, {
      ok: false,
      error: { code: 'internal', message: String(error), details: {} }
    })
  }
}

/** Flag-clear decision for the boot web-UI cleanup (PURE + exported so the
 * regression suite unit-tests the exact production rule): the durable
 * `webUiCleanupPending` marker is cleared ONLY when the cleanup actually RAN
 * AND the GUI-critical truncation succeeded. A skipped report (host session
 * live — `skipped: true, skipReason: 'session-live'`) or a failed/absent
 * truncate (`truncateError` set / `truncate` undefined) KEEPS the flag so the
 * NEXT boot retries — a live-skipped cleanup is retried at a boot where the
 * session is verifiably NOT materialized (see runSleepCleanup's live guard;
 * the wake-11 mid-log-seam corruption fix). */
export function shouldClearCleanupPending(report: Pick<SleepCleanupReport, 'skipped' | 'truncate' | 'truncateError'>): boolean {
  return report.skipped !== true && report.truncate !== undefined && report.truncateError === undefined
}

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

  // --- mutable state (all owned by this invocation's closure; reversible) ---
  const byPost = new Map<string, PostEntry>()
  const byChild = new Map<string, string>()
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
  const postsPath = path.join(config.stateDir, 'posts.json')
  // B3 cutover: room read-cursors are GONE (no board, no read-delta). A legacy
  // `<stateDir>/cursors.json` may still exist on upgraded stateDirs — it is
  // deliberately LEFT INERT (no readers, no writers; the file itself is not
  // deleted here — state migration is the B3 migration step).

  // --- host registry (hostId → entry, plus sessionId → hostId reverse) ------
  const hosts = new Map<string, HostEntry>()
  const hostForSession = new Map<string, string>()
  const hostsPath = path.join(config.stateDir, 'hosts.json')

  // Fire-and-forget persistence of the host registry (callers never await it).
  const persistHosts = (): void => {
    // U2 (D4): every persisted file carries the top-level schemaVersion marker;
    // loader validation tolerates legacy files without it.
    const data: Record<string, unknown> = { schemaVersion: ROTATION_SCHEMA_VERSION }
    for (const entry of hosts.values()) {
      data[entry.hostId] = {
        sessionId: entry.sessionId,
        roomId: entry.roomId,
        // Batch 7: persist the optional host sleep marker only when set (absent
        // = never slept).
        ...(entry.sleepEpoch !== void 0 ? { sleepEpoch: entry.sleepEpoch } : {}),
        // Task T1: persist the optional cycle-boundary seq only when set.
        ...(entry.boundarySeq !== void 0 ? { boundarySeq: entry.boundarySeq } : {}),
        // Web-UI sleep cleanup: persist the pending flag only when set.
        ...(entry.webUiCleanupPending === true ? { webUiCleanupPending: true } : {}),
        // Fix wake-12: persist the deferred sleep-replace seed only when set
        // (absent = no fold pending; see HostEntry.deferredJournalSeed).
        ...(entry.deferredJournalSeed !== void 0 ? { deferredJournalSeed: entry.deferredJournalSeed } : {}),
        // U2 (D4): rotation schema fields — retired/retiredAt/rotatedTo on the
        // retired old entry, previousSessionId on the new live entry. Persist
        // only when set (absent = legacy in-place host).
        ...(entry.retired === true ? { retired: true } : {}),
        ...(entry.retiredAt !== void 0 ? { retiredAt: entry.retiredAt } : {}),
        ...(entry.rotatedTo !== void 0 ? { rotatedTo: entry.rotatedTo } : {}),
        ...(entry.previousSessionId !== void 0 ? { previousSessionId: entry.previousSessionId } : {})
      }
    }
    writeFile(hostsPath, JSON.stringify(data, null, 2), 'utf8').catch(
      (error: unknown) => { ctx.logger.warn(`[deepartments] hosts.json write failed: ${error instanceof Error ? error.message : String(error)}`) }
    )
  }

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
  const ensureHost = (sessionId: string, roomId: string): string => {
    const hostId = `${HOST_ID_PREFIX}${sessionId}`
    // U2 (rotation, §4/C1): a RETIRED host entry must never be resurrected —
    // the old session's bus-tool calls after a rotation stay PLAIN sessions
    // ("no pack + no registration"). Refuse the re-registration, log loudly,
    // keep the entry retired (its rotatedTo stays the live host).
    const existing = hosts.get(hostId)
    if (existing?.retired === true) {
      ctx.logger.warn(`[deepartments] ensureHost: refusing to re-register retired host ${hostId} (rotated to ${existing.rotatedTo ?? 'unknown'}) — the session stays a plain session`)
      return hostId
    }
    // Postmortem nº5 fix — the SINGLE-LIVE-HOST guard: a NEW registration
    // (this hostId is absent from the registry) while ANOTHER non-retired host
    // entry exists must NOT mint a second live host (wake-12→13: a stray
    // dormant tab registered itself as a bare second host 92 s after the
    // rotation). Mirror the retired-refusal: warn + DO NOT register — the
    // session stays a plain session ("no pack + no registration", spec 002
    // §4/C1). Return the EXISTING live host's id so member resolution keeps
    // returning a valid member id and no tool of a plain session ever creates
    // an entry.
    if (existing === undefined) {
      for (const candidate of hosts.values()) {
        if (candidate.retired !== true && candidate.sessionId !== sessionId) {
          ctx.logger.warn(`[deepartments] ensureHost: refusing new host registration ${hostId} — live host already exists: ${candidate.hostId}; the session stays a plain session`)
          return candidate.hostId
        }
      }
    }
    // U4 — pin the durable "Asistente" title on the live host session (sidebar
    // label = the session title projection folded last-wins from session/title
    // log events). Rotated host sessions already carry the pin in their COLD
    // seed (buildRotationSeed); this covers the first UI-created host session
    // and every resume. Guards: only when the session has no user-kind title
    // YET (the owner's manual rename and the Asistente pin are both
    // source.user — the owner's rename always wins, the existing pin is never
    // double-pinned). A missing live session or a failed append is non-fatal;
    // registration continues regardless.
    const titleSession = ctx.sessions.get(SessionId(sessionId))
    if (titleSession !== void 0) {
      const titlePin = pinHostSessionTitle(titleSession)
      if (titlePin === 'pinned') {
        ctx.logger.info(`[deepartments] ensureHost: pinned host session title "${ASISTENTE_SESSION_TITLE}" (${sessionId})`)
      } else if (titlePin === 'failed') {
        ctx.logger.warn(`[deepartments] ensureHost: host session title pin failed for ${sessionId} (non-fatal — host registration continues)`)
      }
    }
    // Relay-fix (explore 2026-08-22): the OLD code REPLACED the whole entry on
    // every refresh, wiping the rotation-successor metadata (previousSessionId/
    // sleepEpoch/boundarySeq/deferredJournalSeed and any retire evidence) on
    // the successor's first tool call — the live-host pick then degraded
    // to the ambiguity branch. MERGE instead: preserve every field ensureHost
    // does not own and refresh only the durable identity (hostId/sessionId).
    // Host-roomId latch fix: a refresh KEEPS `existing.roomId` verbatim; roomId
    // is assigned ONLY at CREATE.
    hosts.set(hostId, existing === undefined
      ? { hostId, sessionId, roomId }
      : { ...existing, hostId, sessionId })
    hostForSession.set(sessionId, hostId)
    persistHosts()
    return hostId
  }

  /** Deterministic durable member id for a HOST session (Batch 7): the same
   * `host-<sessionId>` address used for the journal path and hosts.json. */
  const hostIdForSession = (sessionId: string): string => `${HOST_ID_PREFIX}${sessionId}`

  // Fire-and-forget persistence of the post registry (callers never await it).
  const persistPosts = (): void => {
    const data: Record<string, PostEntryPersisted> = {}
    for (const entry of byPost.values()) {
      data[entry.postId] = {
        // Batch 1a: persist the root-agent identity — no parentId/provider
        // (a root head has no parent). agentPreset is the permanent-head marker.
        sessionId: entry.sessionId,
        roomId: entry.roomId,
        agentPreset: entry.agentPreset,
        // Batch 3a: persist the disposable-worker marker + captured role only
        // for workers (absent for configured permanent heads).
        ...(entry.provider !== void 0 ? { provider: entry.provider } : {}),
        ...(entry.role !== void 0 ? { role: entry.role } : {}),
        // F1: persist the creator link + department + job link + retired marker
        // only when set — legacy entries (all absent) rewrite byte-compatible.
        ...(entry.departmentId !== void 0 ? { departmentId: entry.departmentId } : {}),
        ...(entry.managerId !== void 0 ? { managerId: entry.managerId } : {}),
        ...(entry.jobId !== void 0 ? { jobId: entry.jobId } : {}),
        ...(entry.retired === true ? { retired: true } : {}),
        // Batch G: persist the optional sleep lifecycle fields only when set
        // (absent = never slept / no previous incarnation).
        ...(entry.sleepEpoch !== void 0 ? { sleepEpoch: entry.sleepEpoch } : {}),
        ...(entry.boundarySeq !== void 0 ? { boundarySeq: entry.boundarySeq } : {}),
        ...(entry.previousChildId !== void 0 ? { previousChildId: entry.previousChildId } : {})
      }
    }
    writeFile(postsPath, JSON.stringify(data, null, 2), 'utf8').catch(
      (error: unknown) => { ctx.logger.warn(`[deepartments] posts.json write failed: ${error instanceof Error ? error.message : String(error)}`) }
    )
  }

  const registerEntry = (entry: PostEntry) => {
    byPost.set(entry.postId, entry)
    byChild.set(entry.sessionId, entry.postId)
    persistPosts()
  }

  const postIdForChild = (childId: string): string | undefined => byChild.get(childId)

  // Best-effort cold load of the post registry. Batch 1a: entries carry the
  // root-agent `sessionId` (head-<postId>). Legacy entries from the previous
  // continuable-subagent model carry childId/parentId WITHOUT a sessionId —
  // they referenced a subagent continuation that no longer exists, so they are
  // NOT registered (kept out of the in-memory registry only; posts.json is
  // untouched until a later persistPosts overwrites it — reversible). The
  // configured coordinator is then re-created fresh as a root agent by
  // ensureHeads on boot; the old durable subagent session is never woken.
  const registryLoaded = readFile(postsPath, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text) as Record<string, Record<string, unknown>>
      let sweptLegacy = 0
      for (const [postId, entry] of Object.entries(parsed)) {
        if (entry?.provider === 'fork') {
          // Orphaned fork ghost (retired pre-Batch-A): never register it and
          // count it for the boot summary.
          sweptLegacy++
          continue
        }
        const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId : undefined
        if (sessionId !== undefined && typeof entry?.roomId === 'string' && typeof entry?.agentPreset === 'string') {
          const sleepEpoch = typeof entry.sleepEpoch === 'number' ? entry.sleepEpoch : undefined
          const boundarySeq = typeof entry.boundarySeq === 'number' ? entry.boundarySeq : undefined
          const previousChildId = typeof entry.previousChildId === 'string' ? entry.previousChildId : undefined
          // Batch 3a: a disposable worker is cold-loaded like any post, carrying
          // its durable `provider: 'worker'` marker + captured role. It is NOT
          // re-materialized by ensureAllHeads (config-only), so a retired worker
          // whose entry was removed stays gone across restarts.
          const provider = entry.provider === 'worker' ? 'worker' as const : undefined
          const role = typeof entry.role === 'string' ? entry.role : undefined
          // F1: read the new optional fields with type guards — a legacy
          // pre-F1 entry (all absent) loads EXACTLY as before (undefined, no
          // error); a retired worker entry is registered AS retired (kept
          // queryable, filtered by every live-catalog consumer).
          const departmentId = typeof entry.departmentId === 'string' ? entry.departmentId : undefined
          const managerId = typeof entry.managerId === 'string' ? entry.managerId : undefined
          const jobId = typeof entry.jobId === 'string' ? entry.jobId : undefined
          const retired = entry.retired === true
          registerEntry({
            postId,
            sessionId,
            roomId: entry.roomId,
            agentPreset: entry.agentPreset,
            ...(provider !== void 0 ? { provider } : {}),
            ...(role !== void 0 ? { role } : {}),
            ...(departmentId !== void 0 ? { departmentId } : {}),
            ...(managerId !== void 0 ? { managerId } : {}),
            ...(jobId !== void 0 ? { jobId } : {}),
            ...(retired ? { retired: true } : {}),
            ...(sleepEpoch !== void 0 ? { sleepEpoch } : {}),
            ...(boundarySeq !== void 0 ? { boundarySeq } : {}),
            ...(previousChildId !== void 0 ? { previousChildId } : {})
          })
        } else {
          // Legacy continuable-subagent entry (or a malformed one): leave out of
          // the in-memory registry; the head is re-created fresh (if configured).
          sweptLegacy++
        }
      }
      ctx.logger.info(`[deepartments] loaded ${byPost.size} head registry entries from posts.json${sweptLegacy > 0 ? `; skipped ${sweptLegacy} legacy/non-head entry/entries (head model)` : ''}`)
    })
    .catch((error: unknown) => {
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
  const hostsLoaded = readFile(hostsPath, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text) as Record<string, Omit<HostEntry, 'hostId'>>
      // U2 (spec 002 §3.5/D4): validate the rotation schema BEFORE restoring —
      // legacy files (no schemaVersion / no retired fields) keep exact
      // pre-rotation behavior (validated as a no-op), malformed NEW fields
      // reject the whole load LOUDLY (descriptive error → the catch below
      // logs it) instead of being silently dropped.
      validateHostsRotationFile(parsed)
      for (const [hostId, entry] of Object.entries(parsed)) {
        // U2 (D4): the top-level schemaVersion marker is not a host entry.
        if (hostId === 'schemaVersion') continue
        if (typeof entry.sessionId === 'string' && typeof entry.roomId === 'string' && hostId.startsWith(HOST_ID_PREFIX)) {
          const sessionId = hostId.slice(HOST_ID_PREFIX.length)
          if (sessionId === entry.sessionId) {
            // Batch 7: sanitize the optional sleep marker so a corrupt value
            // never survives into the in-memory registry.
            const sleepEpoch = typeof entry.sleepEpoch === 'number' ? entry.sleepEpoch : undefined
            const boundarySeq = typeof entry.boundarySeq === 'number' ? entry.boundarySeq : undefined
            // Fix wake-12: sanitize the deferred sleep-replace seed (a string;
            // a corrupt value must never survive into the registry).
            const deferredJournalSeed = typeof entry.deferredJournalSeed === 'string' ? entry.deferredJournalSeed : undefined
            // U2 (D4): sanitize the rotation fields (validator above already
            // threw on type violations — this pass guards in-memory purity).
            const retired = entry.retired === true
            const retiredAt = typeof entry.retiredAt === 'number' ? entry.retiredAt : undefined
            const rotatedTo = typeof entry.rotatedTo === 'string' ? entry.rotatedTo : undefined
            const previousSessionId = typeof entry.previousSessionId === 'string' ? entry.previousSessionId : undefined
            hosts.set(hostId, {
              hostId,
              sessionId: entry.sessionId,
              roomId: entry.roomId,
              ...(sleepEpoch !== void 0 ? { sleepEpoch } : {}),
              ...(boundarySeq !== void 0 ? { boundarySeq } : {}),
              ...(deferredJournalSeed !== void 0 ? { deferredJournalSeed } : {}),
              // Web-UI sleep cleanup: restore the pending marker (a real
              // dept_sleep set it; the first boot after clears it once the
              // artifact truncation succeeded).
              ...(entry.webUiCleanupPending === true ? { webUiCleanupPending: true } : {}),
              // U2: restore the rotation schema fields.
              ...(retired ? { retired: true } : {}),
              ...(retiredAt !== void 0 ? { retiredAt } : {}),
              ...(rotatedTo !== void 0 ? { rotatedTo } : {}),
              ...(previousSessionId !== void 0 ? { previousSessionId } : {})
            })
            hostForSession.set(entry.sessionId, hostId)
            // U2: a RETIRED entry must never re-arm the deferred fold (rotation
            // never sets deferredJournalSeed; the retire means "no wake pack,
            // plain session" — re-arming would fold an archived surface).
            if (retired) continue
            // Fix wake-12: re-arm the DEFERRED REPLACE intent for the first
            // pre-step of this restarted process. The in-memory
            // `deferredSleepReplace` map died with the previous process; only
            // hosts.json carried the folded-journal seed. Without this restore
            // the first pre-step skips the fold (invoke.ts:2620) and the
            // journal-interleaved close tail ships to the strict API → the
            // wake-12 first-turn 400. The fold consumes (deletes) the map
            // entry AND clears the durable field, so a later mid-wake restart
            // is a true no-op (never re-folds the wake surface).
            if (deferredJournalSeed !== void 0) deferredSleepReplace.set(entry.sessionId, deferredJournalSeed)
          }
        }
      }
      ctx.logger.info(`[deepartments] loaded ${hosts.size} host registry entries from hosts.json`)
      // Postmortem nº1 fix — the SINGLE-LIVE cardinality invariant, WARN ONLY
      // (never throw): a THROW here lands in the catch below and boots with an
      // EMPTY registry, and the next ensureHost→persistHosts re-persists ONLY
      // the fresh entry — silently erasing every file entry (retired rotation
      // evidence included). A warn keeps the registry alive so boot-repair and
      // host/status can still report; pickLiveHostEntry resolves
      // deterministically among the live candidates.
      const liveHostEntries = [...hosts.values()].filter((candidate) => candidate.retired !== true)
      if (liveHostEntries.length > 1) {
        ctx.logger.warn(`[deepartments] hosts.json: ${liveHostEntries.length} live host entries (exactly one required) — pickLiveHostEntry will choose deterministically among: ${liveHostEntries.map((candidate) => candidate.hostId).join(', ')}`)
      }
    })
    .catch((error: unknown) => {
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
      : path.join(config.stateDir, '..', 'sessions')
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
  // (src/client/index.tsx:115) never passes → the host is unreachable. The
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
   * deepseek-v4-flash-vision-exp, reasoningEffort max). ONE source shared by
   * the three spawn paths (dept_post_create, dept_job_run, dept_worker_spawn)
   * so the worker route cannot drift from the config again. */
  const WORKER_AGENT_OPTIONS: AgentOptionsLike = {
    provider: 'opencode-zen',
    model: 'deepseek-v4-flash-vision-exp',
    reasoningEffort: 'max'
  }
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
  const journalPathFor = (memberId: string): string => path.join(config.stateDir, 'journals', `${memberId}.md`)

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
  const archivePathFor = (memberId: string): string => path.join(config.stateDir, 'journals', 'archive', `${memberId}.md`)
  /** Path of the per-member search index. */
  const indexPathFor = (): string => path.join(config.stateDir, 'journals', 'index.json')
  /** Path of one member+ordinal one-cycle session log. */
  const sessionLogPathFor = (memberId: string, wakeCounter: number): string => path.join(config.stateDir, 'journals', 'sessions', `${memberId}-${wakeCounter}.md`)

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
    for (const department of config.org.departments) {
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
    for (const department of config.org.departments) {
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
      const byId = config.org.departments.find((d) => d.id === entry.departmentId)
      if (byId !== void 0) return byId
    }
    return departmentForPost(entry.postId)
  }

  // --- Batch W4: NON-pure wake-pack assembly (live reads; buildWakePack is pure).
  // These gather the fresh-ish inputs (git bearings, ROADMAP tail, skill body,
  // board delta, condensed roster, system state) and hand them to the pure
  // buildWakePack builder. Every read degrades gracefully — a pack section that
  // cannot be computed emits its "(… unavailable)" marker and the wake proceeds;
  // these helpers NEVER throw to the caller.
  const execFileP = promisify(execFileCb)

  /** git status (short) + last 8 `git log --oneline` lines for the repo,
   * computed at assembly time in the repo dir. Unreachable git/repo → static
   * `(git unavailable)` (degrade gracefully, never throw). */
  const readWakeGitBearings = async (): Promise<string> => {
    try {
      const status = await execFileP('git', ['status', '--short'], { cwd: repoRoot })
      const log = await execFileP('git', ['log', '--oneline', '-8'], { cwd: repoRoot })
      const statusLines = status.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')
      const logLines = log.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')
      const body: string[] = []
      body.push(`status: ${statusLines.length === 0 ? 'clean working tree' : statusLines.join('; ')}`)
      body.push(`last ${logLines.length} commits:`)
      body.push(...logLines.map((l) => `  ${l}`))
      return body.join('\n')
    } catch {
      return '(git unavailable)'
    }
  }

  /** The 2-3 NEWEST bullets from the ROADMAP "Current status" section (the
   * newest entries sit at its tail). Missing/unreadable ROADMAP → graceful
   * marker. */
  const readWakeRoadmapTail = async (count = 3): Promise<string> => {
    try {
      const text = await readFile(path.join(repoRoot, 'docs', 'ROADMAP.md'), 'utf8')
      const lines = text.split('\n')
      const start = lines.findIndex((l) => l.startsWith('## Current status'))
      if (start === -1) return '(ROADMAP "Current status" section not found)'
      const entries: string[][] = []
      let current: string[] | undefined
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i]
        if (line.startsWith('## ')) break
        if (/^\s*- /.test(line)) {
          current = [line]
          entries.push(current)
        } else if (current !== undefined && line.trim() !== '') {
          current.push(line)
        }
      }
      const newest = entries.slice(-count)
      if (newest.length === 0) return '(ROADMAP "Current status" has no bullets)'
      const folded = newest
        .map((entry) => `- ${entry.join(' ').replace(/\s+/g, ' ').trim().replace(/^-\s*/, '')}`)
        .join('\n')
      return folded
    } catch {
      return '(ROADMAP unavailable)'
    }
  }

  /** Full body of the `deepartments-workflow` skill, resolved via the PRESET
   * path (a symlink into the repo) with the repo-tracked copy as fallback.
   * Missing/unreadable → graceful `(skill unavailable)`. */
  const readWakeSkillBody = async (): Promise<string> => {
    const candidates = [
      '/opt/dsh/.dsh-dev/.agent-presets/deepartments/skills/deepartments-workflow/SKILL.md',
      path.join(repoRoot, '.dsh', 'skills', 'deepartments-workflow', 'SKILL.md')
    ]
    for (const candidate of candidates) {
      try {
        const body = await readFile(candidate, 'utf8')
        if (body.trim() !== '') return body
      } catch {
        /* try next */
      }
    }
    return '(skill unavailable)'
  }

  /** Condensed static system-state block (homes, ports, profiles, plugins,
   * live stateDir, repo root). Fully static at seed time. */
  const buildWakeSystemState = (): string => [
    '- DSH dev home: /opt/dsh/.dsh-dev (GUI profile "deepartments-dev", port 3090 / Tailscale 8445; headless twin "deepartments-dev-headless" for CLI smoke)',
    '- DSH stable home: /opt/dsh/.dsh (port 3080 / Tailscale 8444)',
    '- Plugins: dshmarket, dsh-smooth-stream, dsh-smart-restart',
    `- Live stateDir: ${config.stateDir}`,
    `- Repo root: ${repoRoot}`
  ].join('\n')

  /** Condensed roster of the WHOLE catalog (B3: no rooms): registered posts +
   * non-retired hosts with their durable REGISTRY sleeping flags. NEVER embeds
   * live `sessionLive` liveness (deep rule — a stale liveness claim is worse
   * than one on-demand `dept_who`); a pointer line keeps the on-demand escape
   * hatch explicit. */
  const buildCondensedRoster = (): string => {
    const lines: string[] = []
    for (const entry of byPost.values()) {
      // F1 (§4.3): a RETIRED worker is filtered from "present" (it stays in
      // posts.json — marked, not erased — but is no longer a live member).
      // Configuration heads are never retired-marked (cosmetic head retire
      // deletes the entry as before).
      if (entry.retired === true) continue
      lines.push(`- ${entry.postId}${entry.sleepEpoch !== void 0 ? ' (sleeping)' : ''} (${entry.agentPreset})`)
    }
    for (const entry of hosts.values()) {
      // U2 (§4/C7): a retired entry is filtered from "present" (still
      // queryable in hosts.json, but no longer a member of the live roster).
      if (entry.retired === true) continue
      lines.push(`- ${entry.hostId}${entry.sleepEpoch !== void 0 ? ' (sleeping)' : ''}`)
    }
    if (lines.length === 0) lines.push('(no registered posts/hosts)')
    lines.push('Liveness (sessionLive): not baked in — call dept_who on demand.')
    return lines.join('\n')
  }

  /** Message-delta TOC for the wake pack (spec 003 §7.2): the caller's
   * LATEST-RECEIVED messages from the messages.jsonl store (capped N,
   * newest-first; no unread/read state — D5). Missing/unreadable store →
   * an empty-cursor line (never throw). */
  const readWakeMessageDelta = async (memberId: string): Promise<string> => {
    const lines: string[] = []
    try {
      const store = await messagesStoreReady
      const page = store.page(memberId, { limit: WAKE_MESSAGE_DELTA_LIMIT })
      for (const message of page.messages) {
        lines.push(formatMessageDeltaLine(message))
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] wake message delta unavailable (${error instanceof Error ? error.message : String(error)})`)
    }
    if (lines.length === 0) lines.push('(no messages received yet)')
    return lines.join('\n')
  }

  /** KPI line for pack section 1 (P2): `wake_counter N; top open item: …`
   * computed live from the journal file (the same durable file dept_sleep
   * seeds), so the first turn after wake is confirm-and-go instead of
   * cross-reading the journal. Missing/unreadable journal → a clear degraded
   * line; NEVER throws. */
  const readWakeJournalKpi = async (journalPath: string): Promise<string> => {
    try {
      const text = await readFile(journalPath, 'utf8')
      const counterMatch = text.match(/^wake_counter:\s*(\d+)/m)
      const counter = counterMatch !== null ? counterMatch[1] : '?'
      let top = '(none)'
      const openMatch = text.match(/^open_items:\s*(\[.*\])/m)
      if (openMatch !== null) {
        try {
          const parsed = JSON.parse(openMatch[1]) as unknown
          if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') top = parsed[0]
        } catch { /* fallthrough to (none) */ }
      }
      return `wake_counter ${counter}; top open item: ${top}`
    } catch {
      return 'wake_counter (unavailable); top open item: (unavailable)'
    }
  }

  /** Assemble the FULL wake context pack (sections 1-9) for the host wake
   * injection: identity + KPI + pre-resolved journal path + live message delta +
   * roster + git + system state + ROADMAP tail + full skill body + guidance. */
  const assembleWakePack = async (memberId: string, journalPath: string): Promise<string> => {
    const [messageDelta, git, roadmapTail, skillBody, kpi] = await Promise.all([
      readWakeMessageDelta(memberId),
      readWakeGitBearings(),
      readWakeRoadmapTail(),
      readWakeSkillBody(),
      readWakeJournalKpi(journalPath)
    ])
    return buildWakePack({
      memberId,
      role: 'host',
      kpi,
      journalPath,
      messageDelta,
      roster: buildCondensedRoster(),
      git,
      systemState: buildWakeSystemState(),
      roadmapTail,
      skillBody,
      includeGuidance: true
    })
  }

  /** Assemble the LEAN on-demand wake snapshot (sections 1, 3, 4 only — identity,
   * message delta, condensed roster) via the SAME pure `buildWakePack`
   * builder. Used by `dept_wake_snapshot` for live freshness mid-session. */
  const assembleWakeSnapshot = async (memberId: string): Promise<string> => {
    const messageDelta = await readWakeMessageDelta(memberId)
    return buildWakePack({
      memberId,
      role: 'host',
      messageDelta,
      roster: buildCondensedRoster(),
      includeGuidance: false
    })
  }

  // ---------------------------------------------------------------------------
  // Batch C — FRESH wake-pack injection at message-arrival time (owner
  // directive: the pack must arrive AFTER the user's message, together with the
  // standard DSH context injections, so its board delta / git bearings / roster
  // / cursor are fresh at message arrival, NOT frozen at the previous
  // dept_sleep). Driven by the SAME `agent/pre-step` Cordis waterfall the
  // runtime-context + skill-catalog use (no dsh-core change — the canonical
  // pattern is dsh-tool-skill/lib/index.js:181). We REUSE assembleWakePack /
  // buildWakePackMessage — no new pack builder.
  //
  // GATE — inject ONCE per awake session, never per turn: `agent/pre-step` runs
  // before EVERY model step (not just the first message of a session), so a
  // naive listener would re-inject the ~5kB pack on every tool-call step. The
  // recommended `decision.messages` presence check does NOT work here: `claim()`
  // (dsh-agent/lib/index.js:56) returns ONLY the per-step pending input, so
  // `decision.messages` carries the previously-injected pack node NO ACROSS
  // steps (verified against the agent-loop preStep, lib/index.js:496-508). We
  // therefore gate on a SESSION-SCOPED presence flag (`wakePackInjected`, keyed
  // by the agent session id) that is cleared only at the host dept_sleep
  // boundary, so a post-sleep wake (or a fresh never-slept session) injects
  // exactly once. Never injects into a registered POST (head/worker) — those
  // keep their lean board-delta wake, not the host pack.
  // ---------------------------------------------------------------------------
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const sessionId = agent?.id
    if (typeof sessionId !== 'string') return decision
    // Host-only: a registered post (head/worker) already has its own lean wake
    // surface; the host wake pack is for HOST Asistente sessions only.
    if (postIdForChild(sessionId) !== undefined) return decision
    if (wakePackInjected.has(sessionId)) return decision
    // ---- Task T4: TRANSIENT dispatched subagent → slim ROLE-focused block, NOT
    // the full ~4.6-4.9k host pack. `origin === 'subagent'` is the robust
    // discriminator DSH sets ONLY on startContinuable children (dsh-subagent
    // childSessionMeta); a root host/head/worker carries origin undefined. A
    // one-shot atomic-task worker needs its role contract + a one-line org
    // identity, never journal/git/system/ROADMAP/roster/full-skill. The role
    // comes from the in-process dispatch-time registry (src/role-orient.ts),
    // defaulting to `generic` when unknown or after a cold resume.
    // Read the FLAT top-level origin — the real runtime shape (dsh-session
    // flattens the creation meta into header.origin; header.meta never exists
    // at runtime — dsh-session/lib/index.js:1657-1668). The nested
    // meta.origin fallback covers only stale/mocked headers and can never
    // shadow the flat value (`??` reads it ONLY when flat origin is absent).
    const sessionHeader = agent?.session?.header as SessionHeaderWithOrigin | undefined
    const sessionOrigin = sessionHeader?.origin ?? sessionHeader?.meta?.origin
    if (sessionOrigin === 'subagent') {
      signal?.throwIfAborted?.()
      const role = roleForSession(sessionId)
      wakePackInjected.add(sessionId)
      return {
        kind: 'enter',
        messages: [...decision.messages, buildSubagentOrientationMessage(role)]
      }
    }
    signal?.throwIfAborted?.()
    // Fix 2026-08-22 — context-injection gate: the host wake pack goes ONLY to
    // the session REGISTERED as the board host in hosts.json (the boot-loaded
    // `hosts` Map). A plain root session (never registered) now gets NO
    // Deepartments context. The gated-off path must NOT add to
    // `wakePackInjected`: a session that registers LATER mid-session (first
    // board-tool call → ensureHost) still receives the pack at its next
    // pre-step ("plain until it becomes the registered host"). Registered
    // posts are already gated above (2624) and transient subagents in the T4
    // branch above (2641) — both keep their behavior untouched.
    const hostId = hostIdForSession(sessionId)
    const hostEntry = hosts.get(hostId)
    // U2 (spec 002 §4): a RETIRED host entry never gets the wake pack — retire
    // means "no pack + no registration"; a message typed into the old tab after
    // a rotation behaves as a PLAIN session (deliberate). The off-path stays
    // free of `wakePackInjected` (a legacy mid-session registration still
    // works — see the comment above).
    if (hostEntry === undefined || hostEntry.retired === true) return decision
    // Fix A — deferred in-place surface reset (see the Batch 7 helper comment +
    // dept_sleep Step 3): the FIRST pre-step after a host dept_sleep performs
    // the full-window replace the close branch no longer runs. By this point
    // the harness has appended the dept_sleep tool result AFTER the close
    // journal append, so the live surface ends with a pending role:'tool' node
    // whose assistant tool-call parent sits BEFORE the journal node. Replacing
    // the ENTIRE window — start: first node → end: LAST node (the tool result
    // included; computeHostSleepSurfacePlan derives the plan from the CURRENT
    // surface so provenance covers every node exactly) — folds the surface back
    // to the journal BEFORE any request is built (the agent-loop requests
    // session.deriveMessages() AFTER the pre-step waterfall), so the strict
    // opencode-go API never sees the orphaned tool message. Degrades
    // silently when the session is a stub (no append) — same guard as close.
    const deferredJournal = deferredSleepReplace.get(sessionId)
    if (deferredJournal !== undefined) {
      deferredSleepReplace.delete(sessionId)
      // Fix wake-12: consuming the in-memory intent must ALSO clear the
      // DURABLE seed (HostEntry.deferredJournalSeed) — the same consume-once
      // contract. If the durable seed survived, a mid-wake restart would
      // restore it and the first pre-step would re-fold the WHOLE wake surface
      // (journal + every wake turn) back to the journal — silently losing the
      // wake conversation. Clearing here makes the restart after a fold a true
      // no-op. Fire-and-forget persist like every other hosts.json write.
      if (hostEntry !== undefined && hostEntry.deferredJournalSeed !== undefined) {
        hostEntry.deferredJournalSeed = undefined
        persistHosts()
      }
      const session = agent?.session
      if (session !== undefined && typeof session.append === 'function') {
        const nodes = (session.surface?.nodes as readonly number[] | undefined) ?? []
        const plan = computeHostSleepSurfacePlan(nodes)
        session.append('user/message', buildSleepJournalMessage(deferredJournal), {
          surfaceOp: plan.surfaceOp,
          ...(plan.sourceEventSeqs !== undefined ? { sourceEventSeqs: plan.sourceEventSeqs } : {})
        })
      }
    }
    // Deterministic journal path even for a never-slept host (no durable
    // journal yet): assembleWakePack's sections degrade to '(… unavailable)'
    // and readWakeJournalKpi returns a degraded KPI line — the injector never
    // throws for a missing journal/file, so a brand-new host still gets a pack.
    const pack = await assembleWakePack(hostId, journalPathFor(hostId))
    wakePackInjected.add(sessionId)
    return {
      kind: 'enter',
      messages: [...decision.messages, buildWakePackMessage(pack)]
    }
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

  /** The default sidebar title of a spawned worker (spec §5.2):
   * `<RoleTitle>: <task|job title|id>` — the role template's title, then the
   * task (or the job id / the derived post id), e.g. "Researcher: DSH
   * updates". The `title?` spawn parameter overrides it. */
  const defaultWorkerTitle = (roleTitle: string, task: string | undefined, jobId: string | undefined, postId: string): string =>
    `${roleTitle}: ${task ?? jobId ?? postId}`

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
  const installHeadBoardTools = (agentCtx: Context, manager = false): HeadToolDisposers => {
    const disposers: Array<() => void> = []

    // Batch B2 — the agent-messaging bus tools (send_message / agent_messages /
    // dept_who) registered on the post's OWN layer: the own-layer registration
    // SHADOWS the globally-registered harness native `send_message` for this
    // agent (the harness override seam — same-layer duplicates throw, scoped
    // registrations win), and postSetup's lean `restrict({allow:[]})` masks the
    // globals anyway so this own layer is the ONLY visible toolset.
    for (const tool of busTools) disposers.push(agentCtx.tools.register(tool))

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_memo_write',
      description: 'Write this department head\'s long-term memory to its journal: a durable, schema-constrained markdown memo at <stateDir>/journals/<memberId>.md (frontmatter author/room/timestamp/wake_counter/last_wake/board_cursor + decisions/constraints/openItems (+ optional current_step) + a free-form summary with a wake-routine footer). Use it BEFORE sleeping to hand your memory to your future (re-materialized) self. Returns the durable memo path.',
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
        const agent = exec.agent
        if (!agent) throw new Error('dept_memo_write requires a calling agent (exec.agent was undefined)')
        const memberId = postIdForChild(agent.id as string) ?? 'unknown'
        const entry = byPost.get(memberId)
        const roomId = entry?.roomId ?? 'unknown'
        const memoPath = await writeJournal(memberId, roomId, args.summary, args.decisions ?? [], args.constraints ?? [], args.openItems ?? [], args.currentStep, { sessionId: agent.id as string })
        return { room: roomId, member: memberId, memoPath }
      }
    })))

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_sleep',
      description: 'Sleep (dormir): persist your memory to your journal (dept_memo_write MUST be called first — this is enforced) and mark yourself for a context RESET. Conclude the turn after calling this; on your NEXT wake you will be cold-resumed as a fresh incarnation with your journal loaded as your long-term memory. Your live AgentHandle is disposed (the durable session survives, so resume restores you). Rejects loudly if no journal has been saved.',
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
        const agent = exec.agent
        if (!agent) throw new Error('dept_sleep requires a calling agent (exec.agent was undefined)')
        const memberId = postIdForChild(agent.id as string)
        if (memberId === undefined) throw new Error('[deepartments] dept_sleep is for a department head (registered post), not the host')
        const entry = byPost.get(memberId)
        if (entry === void 0) throw new Error(`[deepartments] dept_sleep: "${memberId}" is not a registered post`)
        const journal = await readJournal(memberId)
        if (journal === void 0 || journal.trim() === '') {
          throw new Error('[deepartments] dept_sleep requires a saved journal — call dept_memo_write to save your memory first')
        }
        // Head/worker wake_counter parity (owner decision: heads + workers, so
        // BOTH a manager head and a disposable worker route here through the
        // own-layer dept_sleep — the host never does, it is rejected above).
        // Bump the ordinal at this SAME seed boundary the host uses (see
        // bumpHostSleepCounter/bumpPostSleepCounter): the counter advances
        // exactly +1 on disk BEFORE the handle is disposed, so the next wake's
        // fresh materialization (cold resume from the journal) reads the
        // incremented ordinal — mirroring host semantics.
        await bumpPostSleepCounter(memberId, journal, { sessionId: agent.id as string, roomId: entry.roomId, boundarySeq: entry.boundarySeq })
        // Mark first (durable), then dispose the live AgentHandle. Dispose
        // tears the agent+session OUT of the in-memory registry (rc.8
        // dsh-agent-loop prepare() dispose, index.js:1132-1152 — it detaches
        // `agents.enter`/`sessions.enter` registrations only, NOT the
        // sessionPersistence backend), so the durable session survives and the
        // next wake resumes it. The registry keeps the head wakeable-while-
        // asleep via sleepEpoch.
        const sessionId = entry.sessionId
        entry.sleepEpoch = Date.now()
        // Task T1 — persist the session-event `seq` at this sleep boundary so
        // the NEXT cycle's session-log capture can slice EXACTLY by seq
        // (`seq > boundarySeq`), clock-independent. Absent (stub session) →
        // capture falls back to `time > lastWakeMs`.
        const boundarySeq = (agent.session as { seq?: number } | undefined)?.seq
        if (boundarySeq !== undefined) entry.boundarySeq = boundarySeq
        persistPosts()
        // Fix sleep-self-deadlock (2026-08-23): NEVER await our own handle's
        // dispose from our own turn — the harness dispose() sends
        // machine.cancel + `await machine.whenIdle()`, i.e. it waits for the
        // very driver that is currently executing this tool (invariant
        // self-deadlock — explore-deep/2026-08-23-head-sleep-hang.md §5a).
        // Fire it (the retirePost precedent) so the tool returns immediately,
        // the turn/end settles and the dispose's whenIdle then resolves; the
        // per-session `disposingHeads` dedupe lets a concurrent wake JOIN the
        // same detach instead of racing it.
        void disposeHeadHandleOnce(sessionId)
        return { room: entry.roomId, member: memberId, memoPath: journalPathFor(memberId), sleepEpoch: entry.sleepEpoch }
      }
    })))

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
        description: 'Create a DISPOSABLE department worker: spawn a fresh root agent (sessionId worker-<postId>), register it in posts.json as a disposable entry (provider:"worker"; F1: YOU are recorded as its manager — managerId — and your config department as its departmentId), and deliver its first message via the messaging bus. The worker works your assigned task and sleeps when done; you retire it later with dept_post_retire. The first message (firstMessage, or prompt) is persisted as a durable bus message addressed to the worker (the `deepartments/post-created` signal).',
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
              sessionId: { type: 'string', required: true }
            }
          },
          render: (_args, value) => [{ type: 'text', text: `created worker ${value.postId} (session ${value.sessionId})` } as const]
        },
        async execute(args, exec): Promise<{ postId: string; sessionId: string }> {
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
          const sessionId = workerSessionId(args.postId)
          if (agents.get(String(SessionId(sessionId))) !== void 0) throw new Error(`[deepartments] dept_post_create: a live agent already exists for session "${sessionId}"`)
          const firstMessage = args.firstMessage ?? args.prompt
          const setup = workerSetup(args.postId, headEntry.roomId, args.role)
          // F5 (spec 004 §6.2 L1): the worker of a department WITH a configured
          // workspacePath is created under that path (its OWN sidebar folder,
          // ensured first); otherwise the shared workspace root (the
          // resolveDepartmentWorkspaceCwd '' fallback — pre-F1 behavior).
          const department = departmentForPost(headId)
          const deptCwd = await resolveDepartmentWorkspaceCwd(department)
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
          // Deliver the initial assignment (or a creation note) as a DURABLE
          // BUS message from the head addressed to the worker — this IS the
          // `deepartments/post-created` signal; the bus delivery wakes the
          // worker (always-wake, D4). No direct followup needed; the store is
          // durable.
          const text = firstMessage ?? `[created] worker "${args.postId}" (${args.role || 'department worker'}) is registered. You are disposable — work your assigned task, then dept_memo_write and dept_sleep; your head retires you when done.`
          const store = await messagesStoreReady
          const record = await store.append({
            from: headId,
            to: [args.postId],
            text,
            kind: 'agent'
          })
          await deliverBusRecord(record, args.postId, agent.id as string, agent.id as string, exec.signal)
          return { postId: args.postId, sessionId: String(SessionId(sessionId)) }
        }
      })))

      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_post_retire',
        description: 'Retire a DISPOSABLE WORKER of YOUR department: mark it retired (the registry entry STAYS in posts.json with retired:true — the live catalog stops addressing it), dispose its live AgentHandle and persist. Scope (F1): you may only retire the workers YOU created (managerId match) or the workers of your OWN config department — a worker of another head/department is rejected loudly, and permanent department heads are NOT retired by this path. Unknown postIds are rejected loudly.',
        parameters: {
          postId: { type: 'string', required: true, description: 'The worker post id to retire (e.g. "researcher-alpha").' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              postId: { type: 'string', required: true },
              retired: { type: 'boolean', required: true }
            }
          },
          render: (_args, value) => [{ type: 'text', text: `retired worker ${value.postId}` } as const]
        },
        async execute(args, exec): Promise<{ postId: string; retired: boolean }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_post_retire requires a calling agent (exec.agent was undefined)')
          return retirePost(args.postId, agent.id as string)
        }
      })))

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
      // There is NO scheduler/calendar this phase (D7): `schedule` is parsed
      // and displayed, never triggered. -------------------------------------
      /** The department's job directory (spec 004 §3.1): the config
       * `org.departments[].jobDir` (F1 left it optional) — repo-relative OR
       * absolute; when absent/empty the DEFAULT is
       * `<repoRoot>/docs/departments/<dept-id>/jobs` (spec §3.3 layout —
       * the SAME repo-root mechanism the plugin already uses to resolve the
       * F3 role template tree, `repoRoot` + `readRoleTemplate`). */
      const jobDirFor = (department: DepartmentConfig): string => {
        const configured = (department.jobDir ?? '').trim()
        if (configured === '') return path.join(repoRoot, 'docs', 'departments', department.id, 'jobs')
        return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured)
      }

      /** Unwrap a QUOTED-YAML scalar (the F4a jobs convention quotes free-text
       * values like `schedule`: `"daily 09:00 (reserved — …)"`). The F3 role
       * mini-parser needs no quote handling (its values are unquoted); the job
       * parser normalizes them so list/run display the VALUES, not the quotes. */
      const unwrapQuotedScalar = (value: string): string => {
        if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
          return value.slice(1, -1)
        }
        return value
      }

      /** Parse a job definition frontmatter (spec 004 §5.4-§5.5 — the
       * `---`-delimited format the F4a jobs use: `key: value` one-line
       * scalars for id/title/role/description/schedule?/owner/outbox? plus a
       * NON-EMPTY task body). Same lean YAML-lite shape as the F3 role
       * parser (no YAML dep), equivalent and consistent — with these job
       * deltas: quoted scalar unwrapping, and REQUIRED key validation
       * (id/title/role/description/owner — missing/invalid → undefined so
       * the list reports per-entry and dept_job_run fails loud). */
      const parseJobFrontmatter = (text: string): { meta: Record<string, string>; body: string } | undefined => {
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
        const meta: Record<string, string> = {}
        for (let i = 1; i < end; i++) {
          const scalar = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i])
          // Non-key lines inside the block are ignored (F3-parser consistency).
          if (scalar !== null) meta[scalar[1]] = unwrapQuotedScalar(scalar[2].trim())
        }
        const body = lines.slice(end + 1).join('\n').trim()
        if (body === '') return undefined
        for (const key of ['id', 'title', 'role', 'description', 'owner']) {
          if (typeof meta[key] !== 'string' || meta[key].trim() === '') return undefined
        }
        return { meta, body }
      }

      /** Read + resolve ONE job definition (spec 004 §5.4): locate
       * `<jobId>.md` in the department's jobDir, parse the frontmatter and
       * validate the declared `id` matches the requested jobId. LOUD errors
       * — a versioned definition with broken syntax/keys must fail the run,
       * never spawn a task-less worker. */
      const readJobDefinition = async (department: DepartmentConfig, jobId: string): Promise<{ meta: Record<string, string>; body: string; path: string }> => {
        const jobDir = jobDirFor(department)
        const filePath = path.join(jobDir, `${jobId}.md`)
        let text: string
        try {
          text = await readFile(filePath, 'utf8')
        } catch {
          throw new Error(`[deepartments] dept_job_run: job not found: ${jobId} (searched ${jobDir})`)
        }
        const parsed = parseJobFrontmatter(text)
        if (parsed === void 0) {
          throw new Error(`[deepartments] dept_job_run: job "${jobId}" (${filePath}) has no valid frontmatter — expected a '---' block (id/title/role/description/owner required; schedule/outbox optional) plus a non-empty task body`)
        }
        if (parsed.meta.id !== jobId) {
          throw new Error(`[deepartments] dept_job_run: job "${jobId}" (${filePath}) declares frontmatter id "${parsed.meta.id}" — the file name must match the job id it is referenced by`)
        }
        return { meta: parsed.meta, body: parsed.body, path: filePath }
      }

      /** Validate the job's `role` BEFORE the spawn (spec 005 §5.4): the role
       * MUST name an existing role template of the department
       * (`presets/departments/<dept-id>/<role>.md` — the same tree F3's
       * readRoleTemplate resolves); missing → job-scoped loud error. The full
       * resolution (frontmatter id-match + persona body) is then left to F3's
       * readRoleTemplate, unchanged. */
      const validateJobRole = async (departmentId: string, jobId: string, role: string): Promise<void> => {
        const filePath = roleTemplatePath(departmentId, role)
        try {
          await readFile(filePath, 'utf8')
        } catch {
          throw new Error(`[deepartments] dept_job_run: job "${jobId}" declares role "${role}" which has no template at ${filePath} — a role must be a file presets/departments/${departmentId}/<role>.md`)
        }
      }

      /** The LIVE (non-retired) worker already running the job in THIS
       * department (spec §5.4 idempotency): a second dept_job_run of the same
       * job must NOT spawn a duplicate — the head finishes by retiring the
       * worker explicitly (dept_worker_retire), then re-runs. */
      const runningJobWorker = (jobId: string, departmentId: string): string | undefined => {
        for (const entry of byPost.values()) {
          if (entry.provider === 'worker' && entry.retired !== true && entry.departmentId === departmentId && entry.jobId === jobId) return entry.postId
        }
        return undefined
      }

      /** One listed job (spec 004 §5.5 + D7): the frontmatter fields, the
       * resolved repo path, `status: "manual-run"` (no calendar this phase)
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
        description: 'List the versioned JOB definitions of YOUR department (spec 004 §5.5): scan the department jobDir (config org.departments[].jobDir — repo-relative or absolute; default <repoRoot>/docs/departments/<your-department-id>/jobs) and parse each *.md definition frontmatter (id/title/role/description/schedule?/owner/outbox?). Returns the resolved jobDir + the list {id, title, role, description, schedule, status:"manual-run", owner, path} per job; a definition with INVALID frontmatter is reported PER-ENTRY with an error (the whole list is never failed). `schedule` is informational only (D7 — no calendar/scheduler this phase): every job runs MANUALLY via dept_job_run. Registered ONLY in the head own-layer.',
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
          const jobDir = jobDirFor(department)
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
              parsed = parseJobFrontmatter(await readFile(filePath, 'utf8'))
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
              schedule: parsed.meta.schedule,
              status: 'manual-run',
              owner: parsed.meta.owner,
              outbox: parsed.meta.outbox,
              path: filePath
            })
          }
          return { jobDir, jobs }
        }
      })))

      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_job_run',
        description: 'Execute ONE versioned JOB of YOUR department (spec 004 §5.4, D7 — manual execution; no calendar): read the job definition <jobId>.md in the department jobDir (config org.departments[].jobDir; default <repoRoot>/docs/departments/<your-department-id>/jobs), validate its role against presets/departments/<your-department>/<role>.md, and materialize a WORKER exactly like dept_worker_spawn with role = the definition role, task = the JOB BODY (the full concrete assignment), jobId recorded, slug = the job id (deduped -2, -3… including retired), title = the HUMAN frontmatter title. Returns the worker id + session id + title + job id + the definition path. IDEMPOTENCY: a job already running (a LIVE, non-retired job worker of your department with that jobId) is NOT duplicated — it errors `job already running: <workerId>` (retire it explicitly with dept_worker_retire to restart). Missing job / broken frontmatter / unknown role → loud error (a versioned definition with a syntax error must fail the run, never spawn a task-less worker). `schedule` is ignored (reserved, D7). Registered ONLY in the head own-layer.',
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
          if (agents === void 0) throw new Error('[deepartments] dept_job_run requires the agents service')
          const headId = postIdForChild(agent.id as string)
          if (headId === void 0) throw new Error('[deepartments] dept_job_run is for a department HEAD (registered post), not the host')
          const headEntry = byPost.get(headId)
          if (headEntry === void 0) throw new Error(`[deepartments] dept_job_run: head "${headId}" is not registered`)
          const department = departmentForPost(headId)
          if (department === void 0) throw new Error(`[deepartments] dept_job_run: head "${headId}" has no CONFIGURED department — the job directory cannot be resolved`)
          const jobId = String(args.jobId ?? '').trim()
          if (jobId === '') throw new Error('[deepartments] dept_job_run: `jobId` is required')
          // 1. Read + parse the definition FIRST (loud: missing/broken → fail).
          const definition = await readJobDefinition(department, jobId)
          // 2. Role validation against the department role template tree.
          await validateJobRole(department.id, jobId, definition.meta.role)
          // 3. Idempotency (spec §5.4): never duplicate a running job worker.
          const running = runningJobWorker(jobId, department.id)
          if (running !== void 0) {
            throw new Error(`[deepartments] dept_job_run: job already running: ${running} — retire it explicitly with dept_worker_retire to restart "${jobId}"`)
          }
          // 4. dept_worker_spawn contract replicated (shared helpers — the F3
          // spawn engine is untouched): resolve the role template (persona +
          // title), slug-dedup from the job id, materialize the worker root
          // agent with departmentId/managerId/jobId, pin the HUMAN job title,
          // then deliver the JOB BODY as the first durable bus message (the
          // task = the whole definition body, spec §3.3/§5.4).
          const template = await readRoleTemplate(department.id, definition.meta.role)
          const postId = dedupedWorkerSlug(jobId)
          const sessionId = SessionId(workerSessionId(postId))
          if (agents.get(String(SessionId(sessionId))) !== void 0) throw new Error(`[deepartments] dept_job_run: a live agent already exists for session "${sessionId}"`)
          const title = definition.meta.title
          const setup = workerSetup(postId, headEntry.roomId, definition.meta.role, { persona: template.persona, taskText: definition.body })
          // F5 (spec 004 §6.2 L1): job workers land in the department workspace.
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
            managerId: headId,
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
            from: headId,
            to: [postId],
            text: definition.body,
            kind: 'agent'
          })
          await deliverBusRecord(record, postId, agent.id as string, agent.id as string, exec.signal)
          return { workerId: postId, sessionId: String(SessionId(sessionId)), title, jobId, role: definition.meta.role, jobPath: definition.path }
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
        description: 'Spawn a WORKER of YOUR department (spec 004 §5.2): resolve the role template presets/departments/<your-department>/<role>.md (its persona + display title), materialize a fresh root agent worker (sessionId worker-<slug>, its own session row), register it in posts.json with provider:"worker", role, YOUR postId as managerId, your config department as departmentId and the jobId (when given), inject the role persona + your task into its system prompt, pin its sidebar title (title? overrides the default "<RoleTitle>: <task|jobId|slug>"), and deliver the task as its first durable bus message (which wakes it). Worker slugs DEDUP with -2, -3… — a registered (even retired) slug is never reused. Returns the worker post id + session id + the pinned title. Registered ONLY in the head own-layer.',
        parameters: {
          role: { type: 'string', required: true, description: 'The role template name, e.g. "researcher" — must be a file presets/departments/<your-department>/<role>.md.' },
          task: { type: 'string', description: 'The one-off assignment: injected into the worker persona AND delivered as its first bus message.' },
          jobId: { type: 'string', description: 'Set when the worker runs a versioned job (F4); becomes the slug base and is recorded on the entry.' },
          title: { type: 'string', description: 'Sidebar row title (overrides the default "<RoleTitle>: <task|jobId|slug>").' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workerId: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              title: { type: 'string', required: true }
            }
          },
          render: (_args, value) => [{ type: 'text', text: `spawned worker ${value.workerId} (session ${value.sessionId}, title "${value.title}")` } as const]
        },
        async execute(args, exec): Promise<{ workerId: string; sessionId: string; title: string }> {
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
          // Role template is resolved BEFORE any create: a missing/malformed
          // role file fails the spawn loudly (never a persona-less worker).
          const template = await readRoleTemplate(department.id, role)
          // Slug dedup (spec §5.2): base = jobId ?? role; -2/-3… on collision —
          // INCLUDING RETIRED slugs (F1 keeps retired entries in byPost).
          const postId = dedupedWorkerSlug(args.jobId ?? role)
          const sessionId = SessionId(workerSessionId(postId))
          if (agents.get(String(SessionId(sessionId))) !== void 0) throw new Error(`[deepartments] dept_worker_spawn: a live agent already exists for session "${sessionId}"`)
          const title = String(args.title ?? '').trim() !== '' ? String(args.title) : defaultWorkerTitle(template.title, args.task, args.jobId, postId)
          const setup = workerSetup(postId, headEntry.roomId, role, { persona: template.persona, taskText: args.task })
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
            managerId: headId,
            departmentId: department.id,
            ...(args.jobId !== void 0 ? { jobId: args.jobId } : {})
          })
          byHeadHandle.set(String(SessionId(sessionId)), handle)
          // F3 pin (spec §5.2): human-readable sidebar row — the owner's manual
          // rename always wins, a session already holding the pin is never
          // double-pinned, a failed pin only logs (registration stands).
          const titleSession = ctx.sessions.get(sessionId)
          if (titleSession !== void 0) {
            const titlePin = pinSessionTitle(titleSession, title)
            if (titlePin === 'pinned') {
              ctx.logger.info(`[deepartments] dept_worker_spawn: pinned worker session title "${title}" (${sessionId})`)
            } else if (titlePin === 'failed') {
              ctx.logger.warn(`[deepartments] dept_worker_spawn: worker session title pin failed for ${sessionId} (non-fatal — worker registration continues)`)
            }
          }
          // Deliver the assignment (or a creation note) as a DURABLE bus message
          // from the head — the `deepartments/post-created` signal; the bus
          // delivery wakes the worker (always-wake). ACL (F2): head → own
          // department worker, allowed.
          const text = args.task ?? `[created] worker "${postId}" (${role}) is registered. You are disposable — work your assigned task, then dept_memo_write and dept_sleep; your head retires you with dept_worker_retire when you are done.`
          const store = await messagesStoreReady
          const record = await store.append({
            from: headId,
            to: [postId],
            text,
            kind: 'agent'
          })
          await deliverBusRecord(record, postId, agent.id as string, agent.id as string, exec.signal)
          return { workerId: postId, sessionId: String(SessionId(sessionId)), title }
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
              archived: { type: 'boolean', required: true }
            }
          },
          render: (_args, value) => [{ type: 'text', text: `retired worker ${value.workerId} (${value.archived ? 'session archived' : 'session archive skipped (non-fatal)'})` } as const]
        },
        async execute(args, exec): Promise<{ workerId: string; retired: boolean; archived: boolean }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_worker_retire requires a calling agent (exec.agent was undefined)')
          const workerId = String(args.workerId ?? '').trim()
          if (workerId === '') throw new Error('[deepartments] dept_worker_retire: `workerId` is required')
          const entry = byPost.get(workerId)
          if (entry === void 0) throw new Error(`[deepartments] dept_worker_retire: "${workerId}" is not a registered post`)
          if (entry.provider !== 'worker') throw new Error(`[deepartments] dept_worker_retire: "${workerId}" is not a disposable worker — a head may only retire workers, never a permanent head`)
          // Scope (manager/department match — "only MY workers") + mark + dispose
          // are the F1 shared path (retirePost); idempotent on an already-retired
          // worker (no-op success).
          await retirePost(workerId, agent.id as string)
          // F3 (spec §5.3): archive the DURABLE session so the sidebar row
          // disappears — non-fatal (a failed archive only warns; the retire
          // mark is the durable part). Runs on every retire INCLUDING the
          // already-retired no-op: archiveSession is idempotent.
          const archived = await archiveWorkerSession(entry.sessionId)
          return { workerId, retired: true, archived }
        }
      })))
    }

    return { dispose: () => { for (const d of disposers) d() } }
  }

  /** The role of a post as a prompt section (persona = role, NOT a mission —
   * missions arrive as addressed messages on the bus). Registered on the post's
   * own systemPrompt layer when that service is composed. `isWorker` switches
   * the framing between a PERMANENT department head (manager) and a TEMPORARY
   * DISPOSABLE worker. Both are BOOT-QUIET (never act unaddressed). B3
   * cutover: rooms wording removed — the post lives in the agent catalog. */
  const installRoleSection = (agentCtx: Context, role: string, postId: string, isWorker: boolean, extra?: { persona?: string; taskText?: string }): void => {
    const sp = agentCtx.get('systemPrompt')
    if (sp === void 0 || typeof (sp as { section?: unknown }).section !== 'function') return
    sp.section({
      name: `deepartments:${isWorker ? 'worker' : 'head'}:role:${postId}`,
      order: 1,
      text: isWorker
        ? `You are "${postId}", a ${role || 'rank-and-file researcher'} DISPOSABLE department worker of Deepartments (DeepSeek Harness). Your department HEAD created you as a temporary worker agent; you do not edit the repository, run builders, or spawn other agents. Read your messages with agent_messages, send with send_message, orient with dept_who, and persist your findings/memory with dept_memo_write. BOOT-QUIET: you never act on your own — on any materialization/resume/boot wake you stay idle and end your turn with NO action until an explicitly addressed message arrives. Work the task your department head assigns you; when you are DONE, write dept_memo_write to save your results, then conclude with dept_sleep. You are DISPOSABLE: your head retires you with dept_worker_retire when you are finished.`
        : `You are "${postId}", the ${role || 'department head'}. You are a permanent, first-class agent: you do not edit the repository, run builders, or spawn other agents. Your world is the messaging bus — read with agent_messages, send with send_message, orient with dept_who, and persist memory with dept_memo_write before dept_sleep. You may create and retire DISPOSABLE WORKERS of your department with dept_worker_spawn and dept_worker_retire (the department-scoped worker tools — the legacy dept_post_create/dept_post_retire still exist as the raw machinery). BOOT-QUIET: you never act on your own — on any materialization/resume/boot wake you stay idle and end your turn with NO action until an explicitly addressed message arrives; you never proactively send.`
    })
    // F3 (spec §7.4): the ROLE PERSONA — the role template's body (+ the task)
    // as a second section when dept_worker_spawn resolved one. The worker
    // still mounts the base `deepartments-worker` preset; the role is the
    // persona DELTA (the person supports it: role = persona + tool allowance).
    if (extra !== void 0 && (extra.persona !== undefined || extra.taskText !== undefined)) {
      const personaText = extra.persona ?? ''
      const taskText = extra.taskText === undefined ? '' : `\n\n## Your current assignment\n\n${extra.taskText}`
      const combined = `${personaText}${taskText}`.trim()
      if (combined !== '') {
        sp.section({
          name: `deepartments:${isWorker ? 'worker' : 'head'}:role-persona:${postId}`,
          order: 2,
          text: combined
        })
      }
    }
  }

  /** Build the `setup(agentCtx)` for one post (head OR worker): mount the post's
   * dedicated preset and register its board toolset + role, scoped to the post
   * agent. Runs pre-publication on the fresh agent's scoped context
   * (rc.8 CreateAgentOptions.setup, index.d.ts:117). The `manager` flag gates
   * the department-lifecycle tools (a head creates/retires; a worker cannot). */
  const postSetup = (postId: string, roomId: string, role: string, opts: { preset: string; manager: boolean; persona?: string; taskText?: string }): ((agentCtx: Context) => void | { commit(): void }) => {
    const presetId = opts.preset
    const kind = opts.manager ? 'head' : 'worker'
    return (agentCtx) => {
      // (0) LEAN tool restriction: a root agent has no startContinuable
      // toolFilter, so we hide the GLOBAL host-plane tools from the post with an
      // `allow: []` mask on the inherited surface (rc.8 dsh-tools restrict —
      // index.d.ts:611 "A restriction filters what a scope inherits... a
      // restricted-away global reads as absent"; it never touches the scope's
      // OWN layer). The post therefore sees ONLY its own-layer board tools.
      const restrictOwn = agentCtx.tools.restrict({ allow: [] })
      // (a) Mount the dedicated preset if the service is present.
      if (agentPresets !== void 0) {
        void agentPresets.mount(agentCtx, presetId).catch((error: unknown) => {
          ctx.logger.warn(`[deepartments] ${kind} "${postId}" preset mount failed (board tools still installed): ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      // (b) Register the board toolset scoped to this agent (manager gates the
      // department-lifecycle create/retire tools for heads).
      const tools = installHeadBoardTools(agentCtx, opts.manager)
      // (c) Persona = the role (a head's role or a worker's role), NOT a mission.
      // F3: the ROLE PERSONA delta (+ the task) rides the same section seam.
      installRoleSection(agentCtx, role, postId, opts.manager === false, { persona: opts.persona, taskText: opts.taskText })
      // Ensure the agent-scoped registrations unwind with the agent.
      agentCtx.effect(() => () => { tools.dispose(); restrictOwn() }, `deepartments: ${kind} board tools (${postId})`)
    }
  }

  /** The setup for a PERMANENT department head (manager — can create/retire
   * workers). Mounts the 'deepartments-head' preset. */
  const headSetup = (postId: string, roomId: string, role: string, presetId: string = PRESET_ID): ((agentCtx: Context) => void | { commit(): void }) =>
    postSetup(postId, roomId, role, { preset: presetId, manager: true })

  /** The setup for a DISPOSABLE department WORKER (no create/retire). Mounts
   * the 'deepartments-worker' preset. F3: `extra` carries the role template
   * persona + the spawned task (spec §7.4 — persona delta + assignment).
   * Absent (legacy dept_post_create) → the framing role section only. */
  const workerSetup = (postId: string, roomId: string, role: string, extra?: { persona?: string; taskText?: string }): ((agentCtx: Context) => void | { commit(): void }) =>
    postSetup(postId, roomId, role, { preset: WORKER_PRESET_ID, manager: false, persona: extra?.persona, taskText: extra?.taskText })

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
      // MARK, NOT ERASE (F1): the registry entry stays; the live catalog filters.
      entry.retired = true
      persistPosts()
    } else {
      // Configured head / non-worker: today's semantics (unregister; the config
      // re-materializes it at boot — cosmetic retire).
      byPost.delete(postId)
      byChild.delete(entry.sessionId)
      persistPosts()
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
   * (it realpath-validates + stats), so mkdir -p first, then
   * `registry.create(path, title)` — IDEMPOTENT for an existing canonical path
   * (returns the existing entity, its title untouched — the title is set ONLY
   * on first create). NEVER throws: a mkdir/create failure WARNs and the
   * configured path is returned unchanged (the session is STILL created with
   * that cwd — it just won't be sidebar-attachable until the directory/entity
   * exist, the honest non-fatal WARN discipline of the attach hooks). */
  const ensureDepartmentWorkspace = async (workspacePath: string, title: string): Promise<string> => {
    try {
      await mkdir(workspacePath, { recursive: true })
    } catch (error) {
      ctx.logger.warn(`[deepartments] department workspace dir "${workspacePath}" could not be created (${error instanceof Error ? error.message : String(error)}) — the department's sessions keep cwd "${workspacePath}" but are NOT sidebar-attachable until the directory exists`)
      return workspacePath
    }
    const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
    if (registry?.create === void 0) {
      ctx.logger.warn(`[deepartments] department workspace create skipped (no workspaceRegistry.create seam in this composition) — the department's sessions keep cwd "${workspacePath}" but are not grouped in the sidebar`)
      return workspacePath
    }
    try {
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
   * (mkdir + `registry.create(title = dept name)`, idempotent) and returns the
   * canonical workspace path (the department's own sidebar folder). A
   * department WITHOUT workspacePath returns `''` — the caller then falls back
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
        for (const department of config.org.departments) {
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
    // Batch 4a: the head uses its PER-HEAD preset (deepartments-head-<departmentId>)
    // so the session is NATIVE/openable and labeled with its head preset.
    const presetId = headPresetIdFor(department.id)
    const sessionId = SessionId(headSessionId(postId))
    if (agents === void 0) return
    // F5 (spec 004 §6.2 L1): a department WITH a configured workspacePath owns a
    // REAL sidebar folder — ensure the workspace (mkdir + registry.create
    // title=dept name, idempotent) and carry the canonical path as the cwd for
    // the fresh-create branches. A department WITHOUT workspacePath returns ''
    // (the shared workspace root via resolveWorkspaceRootPath — pre-F1). The
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
      const setup = headSetup(postId, roomId, coordinatorRole, presetId)
      const agentOptions = coordinator.agentOptions
      const durableSession = byPost.get(postId) !== void 0
      if (durableSession) {
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
      for (const department of config.org.departments) {
        await materializeHeadPreset(department)
      }
    }
    // CRITICAL (Batch 3a guarantee): ensureAllHeads ONLY ever iterates the
    // CONFIGURED departments' coordinators (`config.org.departments`). Workers
    // are created at RUNTIME by dept_post_create and are NEVER present in this
    // config — so a retired worker (whose registry entry was removed) is never
    // re-materialized by a later boot. The "retired worker stays retired"
    // invariant holds structurally.
    for (const department of config.org.departments) {
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

  // Boot: materialize the head preset and every configured head once the
  // registries (posts/hosts) have cold-loaded — and re-drive any crash-pending
  // bus deliveries (see the re-delivery driver below). Head materialization no
  // longer needs a live parent (root agents) — it runs at boot unconditionally.
  void Promise.all([registryLoaded, hostsLoaded]).then(() => {
    void ensureAllHeads()
    void redeliverPendingDeliveries()
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
  const messageStoreDir = config.stateDir

  /** The boot-opened message store (load + compact + per-recipient index).
   * Rejects loud on mid-file corruption (spec §3.2 — fail loud, never hide);
   * tools surface the rejection at use. */
  const messagesStoreReady = MessagesStore.open(messageStoreDir)

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
    const isWorker = entry.provider === 'worker'
    const sessionId = SessionId(entry.sessionId)
    const coordinator = coordinatorForPost(entry.postId)
    let resumed = false
    if (entry.sleepEpoch !== void 0) {
      // Respawn from sleep: retire the live handle (if any), record the
      // previous incarnation, clear the flag, then resume below. Joins any
      // in-flight dept_sleep detach (disposeHeadHandleOnce) so the resume
      // below is guaranteed to run only AFTER the machine is detached.
      await disposeHeadHandleOnce(entry.sessionId)
      byChild.delete(entry.sessionId)
      const previousSession = entry.sessionId
      registerEntry({
        ...entry,
        previousChildId: previousSession,
        sleepEpoch: undefined
      })
      resumed = true
    }
    const live = agents.get(String(sessionId))
    if (live === void 0) {
      const role = coordinator?.role ?? entry.role ?? 'department worker'
      const headPreset = entry.agentPreset ?? PRESET_ID
      const setup = isWorker
        ? workerSetup(entry.postId, entry.roomId, role)
        : headSetup(entry.postId, entry.roomId, role, headPreset)
      const agentOptions = coordinator?.agentOptions
      const preset: string = isWorker ? WORKER_PRESET_ID : headPreset
      let handle: AgentHandleLike | undefined
      // F5 (spec 004 §6.2 L1): the FRESH-create fallback of a bus wake lands the
      // re-materialized session in ITS department workspace (a worker by its
      // durable departmentId, a head by config); a department-less/legacy entry
      // falls back to the shared workspace root (deptCwd ''). The resume path
      // above keeps the session's stored header cwd (immutable per session).
      const deptCwd = await resolveDepartmentWorkspaceCwd(departmentForEntry(entry))
      try {
        handle = await agents.resume({ resumeSessionId: String(sessionId), agentOptions, setup })
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" bus wake-resume failed, creating fresh: ${error instanceof Error ? error.message : String(error)}`)
        handle = await agents.create({
          sessionId: String(sessionId),
          meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: preset },
          agentOptions,
          setup
        })
      }
      if (handle !== void 0) byHeadHandle.set(String(sessionId), handle)
      resumed = true
    }
    const target = agents.get(String(sessionId))
    if (target === void 0) throw new Error(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" could not be materialized for bus delivery`)
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
      content: [{ type: 'text', text: framed } as const],
      source: {
        kind: 'agent',
        form: 'send',
        plugin: 'deepartments',
        summary: boundContextSummary(`New message from ${record.from} to ${record.to.length} recipient(s) (${record.kind}).`),
        to: [...record.to],
        messageId: record.id,
        from: record.from,
        senderSessionId: senderSessionId === undefined ? undefined : SessionId(senderSessionId)
      }
    })

  /** The shared post DELIVERY of one bus message: the wakePost seam including
   * the stuck-head recovery verbatim (relay guards §4.4). Never throws — the
   * error is logged AND returned as 'failed' (never silent). */
  const busDeliverToPost = async (entry: PostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined): Promise<DeliveryStatus> => {
    const sessionId = String(SessionId(entry.sessionId))
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
      const { target, resumed } = await materializePost(entry)
      target.followup(busUserMessage(record, framed, senderSessionId))
      return resumed ? 'resumed' : 'delivered'
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    }
  }

  /** The shared HOST delivery (D4 — always wake, including a non-live host):
   * a live host is followed up inline; a non-live host session is resumed
   * exactly like a dormant head (the owner accepted the materialized host
   * turn). The host's own composition (the 'deepartments' preset) is re-mounted
   * best-effort when the agentPresets service is present; a bare resume is the
   * graceful fallback. Never throws — 'failed' is logged AND returned. */
  const busDeliverToHost = async (hostEntry: HostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined): Promise<DeliveryStatus> => {
    if (agents === void 0) return 'failed'
    const sessionId = String(SessionId(hostEntry.sessionId))
    try {
      const live = agents.get(sessionId)
      if (live !== void 0) {
        live.followup(busUserMessage(record, framed, senderSessionId))
        return 'delivered'
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
      await agents.resume({ resumeSessionId: sessionId, setup })
      const target = agents.get(sessionId)
      if (target === void 0) throw new Error(`[deepartments] host "${hostEntry.hostId}" could not be materialized for bus delivery`)
      target.followup(busUserMessage(record, framed, senderSessionId))
      return 'resumed'
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    }
  }

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

  /** The bus member profile the ACL classifies on: kind + the durable
   * department link (workers carry it on their post entry; a configured head
   * derives it from config) + the creating-head link (workers only). */
  interface BusMemberProfile {
    kind: 'host' | 'head' | 'worker' | 'unclassified'
    memberId: string
    departmentId?: string
    managerId?: string
  }

  /** Per-recipient send result: a settled DeliveryStatus, or an ACL denial
   * (`failed:acl:<ground>`) which NEVER touches the record nor the delivery
   * sidecar — it exists only in the tool result so the sender (e.g. the head)
   * knows the message must be channeled via the recipient's department head. */
  type BusSendResult = DeliveryStatus | `failed:acl:${string}`

  const busProfileFor = (memberId: string): BusMemberProfile => {
    const entry = byPost.get(memberId)
    if (entry !== void 0) {
      // A worker's department is its DURABLE link (recorded at create from the
      // creating head's config department); a configured head derives it from
      // config (departmentForPost). A legacy pre-F1 worker carries neither →
      // an "orphan" (only its manager reaches it — see aclDenyGround).
      return entry.provider === 'worker'
        ? { kind: 'worker', memberId, departmentId: entry.departmentId, managerId: entry.managerId }
        : { kind: 'head', memberId, departmentId: departmentForPost(memberId)?.id }
    }
    if (hosts.has(memberId)) return { kind: 'host', memberId }
    return { kind: 'unclassified', memberId }
  }

  /** One ACL DENIAL ground (undefined = allowed). Spec 004 §5.6 table:
   * host → everyone; head → any head (incl. the host) + its own department's
   * agents; worker → its own department's agents (incl. its head) + self;
   * worker → host PROHIBITED (D6 — it must go via its head). Orphan policy
   * (builder-verified): a worker without a departmentId is reachable ONLY by
   * the head that created it (managerId) — its "department" is its manager.
   * A recipient the catalog does NOT know (a transient child id, an unknown
   * id) is NOT an ACL subject: the child route and the unknown-per-recipient
   * 'failed' path keep their own behavior (the front: children are never
   * catalog-validated; unknown ids already fail as unknown). */
  const aclDenyGround = (sender: BusMemberProfile, recipient: BusMemberProfile): string | undefined => {
    // 'self' is always allowed (autocopy/ack-loop guard; held, never woken).
    if (recipient.memberId === sender.memberId) return undefined
    // NOT a catalog member → not an ACL subject (child route / unknown path).
    if (recipient.kind === 'unclassified') return undefined
    // host: everything (D6 — the Asistente talks to everyone).
    if (sender.kind === 'host') return undefined
    if (sender.kind === 'head') {
      // any head, INCLUDING the host (the host is the top of the reporting
      // chain: "RH ↔ Asistente ↔ other heads", D6).
      if (recipient.kind === 'host' || recipient.kind === 'head') return undefined
      if (recipient.kind === 'worker') {
        // agents of its own department — by the durable departmentId OR (a
        // legacy worker the head itself created — "my workers", §4.2).
        if (recipient.departmentId !== undefined && recipient.departmentId === sender.departmentId) return undefined
        if (recipient.departmentId === undefined && recipient.managerId === sender.memberId) return undefined
        return 'other-department'
      }
      return 'unclassified-recipient'
    }
    if (sender.kind === 'worker') {
      // D6: a worker NEVER writes to the Asistente — everything via its head.
      if (recipient.kind === 'host') return 'host'
      if (recipient.kind === 'head') {
        // its own head: the manager link, OR (a manager head without the
        // durable link — legacy) the same config department.
        if (recipient.memberId === sender.managerId) return undefined
        if (sender.departmentId !== undefined && recipient.departmentId === sender.departmentId) return undefined
        return 'other-department'
      }
      if (recipient.kind === 'worker') {
        // a department peer (same durable departmentId). An ORPHAN worker
        // (no departmentId) is only its manager's (a head's) reach — a worker
        // sender never is one.
        if (recipient.departmentId !== undefined && recipient.departmentId === sender.departmentId) return undefined
        return 'other-department'
      }
      return 'unclassified-recipient'
    }
    // Unclassified sender (a session the catalog does not know — e.g. a
    // transient subagent that reached the plugin tool): conservative DENY.
    // Transient subagents are documented NOT to be ACL subjects (spec 003
    // D2: they keep the native tool and are not catalog members), so this
    // branch is a defensive guard for foreign callers only.
    return 'unclassified-sender'
  }

  /**
   * Deliver ONE addressed record to ONE recipient and record the sidecar
   * transition (write-ahead 'prepared' → final status; spec §4.4). THIS is the
   * idempotent re-delivery unit: send_message calls it after persisting, and
   * the boot re-delivery driver re-runs it for crash-pending pairs. Route order
   * per recipient (spec §4.2): child route FIRST (the caller's direct
   * continuable children — never validated against the catalog), then the
   * catalog (posts.json ∪ non-retired hosts.json); unknown ids → failed.
   */
  const deliverBusRecord = async (
    record: MessageRecord,
    recipientId: string,
    callerAgentId: string,
    senderSessionId: string | undefined,
    signal?: AbortSignal
  ): Promise<DeliveryStatus> => {
    const framed = `[From ${record.from} → ${record.to.join(', ')}]: ${record.text}`
    await markDelivery(messageStoreDir, record.id, recipientId, 'prepared')
    try {
      let status: DeliveryStatus
      if (recipientId === record.from) {
        // Ack-loop guard: a self-addressed send is held — persisted, no wake,
        // never re-enters the caller's own turn.
        status = 'self'
      } else if (subagents !== void 0) {
        // Route (1) — the caller's direct continuable child? Resolve BEFORE any
        // catalog validation (a transient child id can never be 'unknown').
        let isChild = false
        try {
          const children = await subagents.listChildren(SessionId(callerAgentId), signal ?? undefined)
          isChild = children.some((child) => child.kind === 'child' && child.mode === 'continuable' && String(child.id) === recipientId)
        } catch {
          // listing unavailable (minimal composition): no child route — catalog next
        }
        if (isChild) {
          try {
            await subagents.followup(
              await exec_agentFor(callerAgentId) as unknown as Parameters<typeof subagents.followup>[0],
              SessionId(recipientId),
              [{ type: 'text', text: framed } as const],
              {
                source: {
                  kind: 'agent',
                  form: 'send',
                  plugin: 'deepartments',
                  summary: boundContextSummary(`New message from ${record.from} to ${record.to.length} recipient(s) (${record.kind}).`),
                  to: [...record.to],
                  messageId: record.id,
                  from: record.from,
                  senderSessionId: senderSessionId === undefined ? undefined : SessionId(senderSessionId)
                },
                // A bare { agent, signal } tool exec is the test surface; the
                // ABORT_SIGNAL default is never reached in production harness
                // runs (exec.signal is always present there).
                signal: signal ?? new AbortController().signal
              }
            )
            status = 'delivered'
          } catch (error: unknown) {
            ctx.logger.warn(`[deepartments] bus child-followup to "${recipientId}" failed: ${error instanceof Error ? error.message : String(error)}`)
            status = 'failed'
          }
        } else {
          status = await busDeliverCatalog(record, recipientId, senderSessionId)
        }
      } else {
        status = await busDeliverCatalog(record, recipientId, senderSessionId)
      }
      await markDelivery(messageStoreDir, record.id, recipientId, status)
      return status
    } catch (error: unknown) {
      // The sidecar write failed (fs): the record is durable, the delivery is
      // NOT recorded — fail loud to the caller (never silently lose a send).
      ctx.logger.warn(`[deepartments] bus delivery sidecar write failed for ${record.id} → ${recipientId}: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /** Catalog route of the bus (spec §4.2 route 2 + §4.3 delivery): posts.json
   * (head/worker) then non-retired hosts.json; unknown → 'failed'. F1: a
   * RETIRED worker entry STAYS in byPost (marked, not erased) but is filtered
   * from the LIVE catalog — addressing a retired member fails per-recipient
   * like an unknown one. F2: the messaging ACL (spec §4.2 route 2 + §5.6)
   * runs HERE, BEFORE any wake/materialization: the send_message persist
   * filter already keeps denied recipients out of a record's to[], so this
   * gate is the DEFENSIVE enforcement seam — a boot re-delivery of a PRE-ACL
   * record (or any other delivery path) can never bypass the rules. A denial
   * returns 'failed' (sidecar-compatible; the richer `failed:acl:<ground>`
   * reason lives in the send_message tool result, NOT in the sidecar). */
  const busDeliverCatalog = async (record: MessageRecord, recipientId: string, senderSessionId: string | undefined): Promise<DeliveryStatus> => {
    const sender = busProfileFor(record.from)
    const entry = byPost.get(recipientId)
    if (entry !== void 0) {
      if (aclDenyGround(sender, busProfileFor(recipientId)) !== undefined) {
        ctx.logger.warn(`[deepartments] bus delivery to "${recipientId}" DENIED by the messaging ACL (record ${record.id}, sender ${record.from}) — skipped; it goes via the recipient's department head (spec 004 §5.6)`)
        return 'failed'
      }
      if (entry.retired === true) {
        ctx.logger.warn(`[deepartments] bus delivery to RETIRED member "${recipientId}" skipped (record ${record.id})`)
        return 'failed'
      }
      return busDeliverToPost(entry, `[From ${record.from} → ${record.to.join(', ')}]: ${record.text}`, record, senderSessionId)
    }
    const hostEntry = hosts.get(recipientId)
    if (hostEntry !== void 0 && hostEntry.retired !== true) {
      if (aclDenyGround(sender, busProfileFor(recipientId)) !== undefined) {
        // D6: a worker reaches the host ONLY via its department head.
        ctx.logger.warn(`[deepartments] bus delivery to the host "${recipientId}" DENIED by the messaging ACL (record ${record.id}, sender ${record.from}) — a worker never writes to the Asistente (spec 004 §5.6/D6)`)
        return 'failed'
      }
      return busDeliverToHost(hostEntry, `[From ${record.from} → ${record.to.join(', ')}]: ${record.text}`, record, senderSessionId)
    }
    ctx.logger.warn(`[deepartments] bus delivery to unknown member "${recipientId}" (record ${record.id})`)
    return 'failed'
  }

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

  /** `send_message` — the unified plugin-owned tool (spec §4). NEVER registers
   * globally when the harness native owns the name (dsh-tool-subagent-control);
   * the own-layer registrations SHADOW the native for every deepartments agent
   * ("Scoped tools shadow globals" — the harness's supported override seam:
   * a same-layer duplicate throws, there is no replace). */
  const sendMessageTool = defineTool({
    name: 'send_message',
    description: 'Send a message to one or more background agents and/or organization members, delivering it as the recipient\'s next turn and ALWAYS waking the recipient (including a dormant/host target). Recipients are resolved per id: (1) your direct continuable background children are delivered natively (parent→child followup, never catalog-validated); (2) everything else is resolved against the organization catalog (department heads/workers + the Asistente host) and delivered through the durable message store — the record is persisted BEFORE any delivery and delivery state is tracked in a write-ahead sidecar, so a crash re-delivers idempotently. Unknown ids are reported per-recipient as failed (one typo does not kill a multi-recipient send). A self-addressed recipient (your own id) is held ("self" — persisted, never woken). DEPARTMENT MESSAGING ACL (spec 004 §5.6): the Asistente (host) may send to everyone; a department head may send to any head (incl. the Asistente) and to the agents of its OWN department; a WORKER may send ONLY to the agents of its own department (incl. its head) — a worker CANNOT write to the host, to other heads, or to other departments (everything goes via its own head). A forbidden recipient is reported per-recipient as `failed:acl:<ground>` and is NOT persisted/delivered (the message is not sent to it; route it via the recipient\'s department head). Max 20 recipients (fan-out cap).',
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
      threadId: { type: 'string', description: 'Optional: a message id to reply to (recorded as threadId).' }
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
      // resume of N dormant agents — quota + race safety, spec §4.4).
      for (const recipient of allowed) {
        delivered[recipient] = await deliverBusRecord(record, recipient, agent.id as string, agent.id as string, exec.signal)
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
      // Normalize the wire shape to the declared output schema (threadId null
      // is a store-internal absent marker; the tool surface exposes it as
      // absent, never null).
      return {
        total: page.total,
        remaining: page.remaining,
        messages: page.messages.map((message) => ({
          ...message,
          threadId: message.threadId === null ? undefined : message.threadId
        }))
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
    description: 'List the whole Deepartments catalog — the Asistente host (kind "host", title "Asistente") and every registered department head/worker with its DERIVED kind (a configured department head is kind "head", a disposable worker is kind "worker"; title from the department configuration, PostEntry.role fallback) — each with live/sleeping state and session id, and your OWN entry marked you:true. Worker rows additionally carry departmentId/role/jobId (its department template and job link) and RETIRED workers are shown with retired:true (the head\'s management view; a retired worker is NOT addressed by the live catalog — sending to it fails per-recipient). This is the identity + roster tool: learn who exists and who you are in one call. No room parameter — the roster is the organization.',
    parameters: {},
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
                sessionId: { type: 'string', required: true },
                you: { type: 'boolean', required: true },
                departmentId: { type: 'string' },
                role: { type: 'string' },
                jobId: { type: 'string' },
                retired: { type: 'boolean' }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        const lines = value.members.map((member) =>
          `  - ${member.agentId} (${member.kind}, "${member.title}"${member.live ? ', live' : ', offline'}${member.sleeping ? ', sleeping' : ''}${member.retired === true ? ', retired' : ''}${member.you ? ', YOU' : ''})`)
        return [{ type: 'text', text: `Deepartments catalog (${value.members.length} member(s)):\n${lines.join('\n')}` } as const]
      }
    },
    async execute(_args, exec): Promise<{ members: Array<{ agentId: string; kind: 'host' | 'head' | 'worker'; title: string; live: boolean; sleeping: boolean; sessionId: string; you: boolean; departmentId?: string; role?: string; jobId?: string; retired?: boolean }> }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_who requires a calling agent (exec.agent was undefined)')
      // B3 gap fix: caller host self-registers when no live host exists (board
      // tools are gone; the roster must show the host with you:true).
      const callerMemberId = busEnsureHostForCaller(agent as { id: string; session?: { header?: SessionHeaderWithOrigin } })
      const members: Array<{ agentId: string; kind: 'host' | 'head' | 'worker'; title: string; live: boolean; sleeping: boolean; sessionId: string; you: boolean; departmentId?: string; role?: string; jobId?: string; retired?: boolean }> = []
      for (const entry of hosts.values()) {
        if (entry.retired === true) continue
        members.push({
          agentId: entry.hostId,
          kind: 'host',
          title: 'Asistente',
          live: agents !== void 0 && agents.get(SessionId(entry.sessionId)) !== undefined,
          sleeping: entry.sleepEpoch !== void 0,
          sessionId: entry.sessionId,
          you: entry.hostId === callerMemberId
        })
      }
      for (const entry of byPost.values()) {
        // F3 (§5.1): retired workers stay LISTED (the head-management view)
        // with `retired: true` — the LIVE catalog (busDeliverCatalog
        // addressing) keeps filtering them; the entry stays durable.
        const coordinator = coordinatorForPost(entry.postId)
        const isWorker = entry.provider === 'worker'
        members.push({
          agentId: entry.postId,
          // F1: kind derived — a disposable worker is 'worker'; every other
          // post (configured head) is 'head' (pre-F1 hardcode).
          kind: isWorker ? 'worker' : 'head',
          // Spec §6: coordinator.title for department heads; PostEntry.role
          // fallback for worker posts. Fallback chain follows head-presets.ts
          // (`headRoleLine`, the established convention): title → role → postId.
          title: coordinator?.title || coordinator?.role || entry.role || entry.postId,
          live: agents !== void 0 && agents.get(SessionId(entry.sessionId)) !== undefined,
          sleeping: entry.sleepEpoch !== void 0,
          sessionId: entry.sessionId,
          you: entry.postId === callerMemberId,
          // F3 (§5.1): worker rows carry the department template/department
          // link + job link (the head filters its workers by departmentId).
          ...(isWorker && entry.departmentId !== void 0 ? { departmentId: entry.departmentId } : {}),
          ...(isWorker && entry.role !== void 0 ? { role: entry.role } : {}),
          ...(isWorker && entry.jobId !== void 0 ? { jobId: entry.jobId } : {}),
          ...(isWorker && entry.retired === true ? { retired: true } : {})
        })
      }
      return { members }
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
  // 'prepared'; rejected delivery: 'failed'); 'delivered'/'resumed'/'self' are
  // never re-run. Also compacts the sidecar at boot (keep only the latest state
  // per key) once it grows past the board compaction threshold.
  // ---------------------------------------------------------------------------
  const redeliverPendingDeliveries = async (): Promise<void> => {
    try {
      const filePath = resolveDeliveriesPath(messageStoreDir)
      let text: string
      try {
        text = await readFile(filePath, 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // nothing ever sent
        throw error
      }
      let rows = parseDeliveryRows(text)
      if (rows.length > COMPACTION_LINE_THRESHOLD) {
        rows = compactDeliveryRows(rows)
        await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
        ctx.logger.info(`[deepartments] deliveries sidecar compacted to ${rows.length} latest-state rows (boot)`)
      }
      const latestPerKey = new Map<string, (typeof rows)[number]>()
      for (const row of rows) latestPerKey.set(`${row.messageId}\u0000${row.recipientId}`, row)
      const store = await messagesStoreReady
      for (const row of latestPerKey.values()) {
        if (!needsRedelivery(row.status)) continue
        const record = store.get(row.messageId)
        if (record === void 0) {
          // Record trimmed by the boot compaction: nothing durable remains to
          // re-deliver — the pair stays a settled no-op.
          continue
        }
        const callerSessionId = byPost.get(record.from)?.sessionId ?? hosts.get(record.from)?.sessionId ?? record.from
        try {
          const status = await deliverBusRecord(record, row.recipientId, callerSessionId, callerSessionId)
          ctx.logger.info(`[deepartments] boot re-delivery: ${record.id} → ${row.recipientId} (was ${row.status}) → ${status}`)
        } catch (error: unknown) {
          ctx.logger.warn(`[deepartments] boot re-delivery ${record.id} → ${row.recipientId} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] boot deliveries re-delivery pass failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
    }
  }


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
      const snapshot = await assembleWakeSnapshot(hostId)
      return { snapshot }
    }
  }))

  const globalRetire = ctx.tools.register(defineTool({
    name: 'dept_post_retire',
    description: 'Retire a registered post (spec 004 §4.3 — retirement is MARKED, never erased): for a DISPOSABLE WORKER it marks the entry `retired: true` (the post stays in the registry and its history stays queryable; every live-catalog consumer — busDeliverCatalog addressing, dept_who, the wake-pack roster — filters it) and disposes its live AgentHandle; a permanent CONFIGURED head keeps today\'s semantics (registry entry removed, re-materialized by config at boot). Scope: a HOST caller may retire any post; a HEAD caller only the workers of its own department. Unknown postIds are rejected loudly.',
    parameters: {
      postId: { type: 'string', required: true, description: 'The post id to retire (e.g. "research-head").' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          postId: { type: 'string', required: true },
          retired: { type: 'boolean', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `retired post ${value.postId}` } as const]
    },
    async execute(args, exec): Promise<{ postId: string; retired: boolean }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_post_retire requires a calling agent (exec.agent was undefined)')
      // Delegate to the shared retirement path (Batch 3a). From the HOST plane
      // the caller is not a registered post → a HOST, so any post may be retired
      // (today's semantics preserved).
      return retirePost(args.postId, agent.id as string)
    }
  }))

  // --- Batch G: memo (journal) and sleep (dormir) — host plane --------------
  // The owner's lifecycle model: department heads are PERMANENT agents that go
  // IDLE (wait, keeping their context; the default concluded state is already
  // an inactive-but-resumable continuable — the wake relay re-wakes them
  // regardless) or SLEEP (dormir — persist memory to a journal then reset the
  // context window; a fresh incarnation reloads the journal on the next wake).
  // dept_memo_write persists the head's long-term memory to its journal;
  // dept_sleep requires a prior memo, marks the post (sleepEpoch), and the
  // relay re-materializes it fresh.

  const globalMemo = ctx.tools.register(defineTool({
    name: 'dept_memo_write',
    description: 'Write this department head\'s — or, from the host plane, the HOST Asistente\'s — long-term memory to its journal: a durable, schema-constrained markdown memo at <stateDir>/journals/<memberId>.md (frontmatter author/room/timestamp/wake_counter/last_wake/board_cursor + decisions/constraints/openItems (+ optional current_step) + a free-form summary with a wake-routine footer). A registered head writes journals/<postId>.md; a HOST (no registered post) writes journals/host-<sessionId>.md. Use it BEFORE sleeping to hand your memory to your future (re-materialized) self. Returns the durable memo path.',
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
      const agent = exec.agent
      if (!agent) throw new Error('dept_memo_write requires a calling agent (exec.agent was undefined)')
      // Batch 7 host-aware member resolution: a registered HEAD writes under
      // its postId (unchanged); a HOST (no post entry) writes under the durable
      // `host-<sessionId>` member id instead of the old `'unknown'` fallback, so
      // its journal lives at journals/host-<sessionId>.md for the host sleep
      // branch to reload.
      const memberId = postIdForChild(agent.id as string) ?? hostIdForSession(agent.id as string)
      const entry = byPost.get(memberId)
      const hostEntry = hosts.get(memberId)
      const roomId = entry?.roomId ?? hostEntry?.roomId ?? 'board'
      const memoPath = await writeJournal(memberId, roomId, args.summary, args.decisions ?? [], args.constraints ?? [], args.openItems ?? [], args.currentStep, { sessionId: agent.id as string })
      return { room: roomId, member: memberId, memoPath }
    }
  }))

  const globalSleep = ctx.tools.register(defineTool({
    name: 'dept_sleep',
    description: 'Sleep (dormir): persist your memory to your journal (dept_memo_write MUST be called first — this is enforced) and mark yourself for a context RESET. For a department HEAD this marks the post + disposes its AgentHandle (fresh resume on next wake). For the HOST Asistente it ROTATES the host session (spec 002): the old session is retired + archived server-side and a NEW session seeded with the re-keyed journal becomes the registered host (durable host sleepEpoch set on the new entry), then the turn concludes. Falls back to the legacy in-place reset when the rotation cannot run. Rejects loudly if no journal has been saved.',
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
      const agent = exec.agent
      if (!agent) throw new Error('dept_sleep requires a calling agent (exec.agent was undefined)')
      // ---- Task T4: REFUSE a TRANSIENT SUBAGENT. A one-shot delegated worker
      // has no durable post identity and must NEVER enter the host sleep/reset
      // branch below — which would misclassify it as a HOST and bump a bogus
      // `host-<subagentUuid>` wake counter (and historically left headless
      // one-shots hanging after sleep). `origin === 'subagent'` is set only on
      // startContinuable children; registered members (host, head, worker) carry
      // origin undefined and are unaffected. Fail loud; no context reset.
      const deptSleepHeader = agent.session?.header as SessionHeaderWithOrigin | undefined
      const deptSleepOrigin = deptSleepHeader?.origin ?? deptSleepHeader?.meta?.origin
      if (deptSleepOrigin === 'subagent') {
        ctx.logger.warn(`[deepartments] dept_sleep refused for transient subagent ${agent.id as string}`)
        throw new Error('dept_sleep is refused for a transient delegated subagent — a subagent cannot sleep; its task ends with the settlement notice (role-scoped context reset is not supported).')
      }
      const memberId = postIdForChild(agent.id as string)

      // ---- U2: HOST branch (the sleeping Asistente) — SESSION ROTATION ------
      // The caller has no registered post entry → it is a HOST. Spec 002
      // (docs/specs/002-host-session-rotation.md): the OLD host session is
      // RETIRED + ARCHIVED server-side (D1) and a NEW session (seeded with the
      // re-keyed journal, D3) becomes the registered host, so the GUI's native
      // sidebar shows the fresh "New Session" row and hides the old one. The
      // old session's artifact + journal are preserved in FULL (G4/D2 — the
      // rotation never truncates, never deletes, never appends to the old live
      // surface). The web api-proxy owns the host's AgentHandle (we do NOT
      // dispose it — unlike a head): the old session stays live but INERT
      // (nothing targets host-<oldId> for wake anymore — gate §4). Heads never
      // reach this branch (a head calls its own-layer dept_sleep, which
      // dispose+resumes — unaffected).
      if (memberId === undefined) {
        const sessionId = agent.id as string
        const hostId = hostIdForSession(sessionId)
        const existing = hosts.get(hostId)
        const journal = await readJournal(hostId)
        if (journal === void 0 || journal.trim() === '') {
          throw new Error(`[deepartments] dept_sleep requires a saved journal — call dept_memo_write to save your memory first (no journal for host ${hostId})`)
        }
        // S1 — journal REQUIRED (dept_memo_write must have run first): the
        // journal is the ONLY durable surface the next wake resumes from.
        // S1.5 (unchanged) — advance the HOST's wake ordinal at the sleep
        // boundary, BEFORE the rotation, so the NEXT wake's fresh context
        // (seeded from the re-keyed journal) already shows the incremented
        // counter (wake K → sleep → the woken session is wake K+1).
        // bumpHostSleepCounter persists the bump atomically on the OLD file
        // (kept byte-identical as the archive copy, G4) and returns the
        // bumped content the rotation re-keys.
        const seeded = await bumpHostSleepCounter(hostId, journal, { sessionId, roomId: existing?.roomId ?? 'board', boundarySeq: hosts.get(hostId)?.boundarySeq })
        // U2 — perform the ROTATION (S1.5b re-keyed journal → S2 server-side
        // session creation → S2.5 server-side archive → S2.7 evidence copy →
        // S3/S7 hosts.json rotation with the durable markers). S6 (the old
        // session's wake-pack flag) + S8 (concludeTurn) stay HERE; the old
        // entry keeps its identity but is retired (evidence stays queryable).
        const boundarySeqAtSleep = (agent.session as { seq?: number } | undefined)?.seq ?? hosts.get(hostId)?.boundarySeq
        // Resolve the state-home sessions root + evidence archive dir exactly
        // like the boot cleanup hook (sessionPersistence.root ?? `../sessions`).
        // FIX 1: the SAME persistence service also feeds the rotation's S2
        // cold-seed seam (create/append — dsh-session-persistence), so the new
        // host session is written to disk WITHOUT ever being attached to
        // ctx.sessions (the attached-but-agentless poison state; the resume
        // live-guard). Optional — the rotation falls back when absent.
        const deptSleepPersistence = ctx.get('sessionPersistence') as (RotationPersistenceLike & { root?: string }) | undefined
        const deptSleepSessionsRoot = typeof deptSleepPersistence?.root === 'string' && deptSleepPersistence.root !== ''
          ? deptSleepPersistence.root
          : path.join(config.stateDir, '..', 'sessions')
        const rotation = await runHostRotation({
          oldSessionId: sessionId,
          oldHostId: hostId,
          roomId: existing?.roomId ?? 'board',
          seededJournal: seeded,
          journalsDir: path.join(config.stateDir, 'journals'),
          workspacePath: (agent.session?.header as { cwd?: string } | undefined)?.cwd ?? process.cwd(),
          boundarySeq: boundarySeqAtSleep,
          persistence: deptSleepPersistence,
          workspaceRegistry: ctx.get('workspaceRegistry'),
          sessionsRoot: deptSleepSessionsRoot,
          archiveDir: path.join(path.dirname(deptSleepSessionsRoot), 'archive'),
          hosts,
          hostForSession,
          persistHosts,
          logger: ctx.logger
        })
        if (rotation.rotated) {
          // S6 — retired identity: the OLD session never gets the wake pack
          // again (retired-skip gate §4); the NEW session's per-process set is
          // empty by definition, so its first pre-step injects the full pack.
          wakePackInjected.delete(sessionId)
          // S8 — conclude the sleeping Asistente's turn (the loop stops after
          // this successful tool result) — the host analog of a head ending
          // its turn. Guarded: dsh-tools ToolRunContext exposes concludeTurn();
          // a bare { agent, signal } test exec does not.
          if (typeof (exec as { concludeTurn?: unknown }).concludeTurn === 'function') {
            (exec as { concludeTurn: () => void }).concludeTurn()
          }
          return { room: existing?.roomId ?? 'board', member: rotation.newHostId, memoPath: rotation.newJournalPath, sleepEpoch: rotation.sleepEpoch }
        }
        // FALLBACK — the legacy IN-PLACE path, reachable ONLY when the rotation
        // cannot run (missing/partial persistence seam or a re-key / seed-
        // persist failure — spec §3.6 crash tolerance). Loud log + the pre-rotation
        // behavior (journal append + deferred fold + webUiCleanupPending) — the
        // machinery stays for hosts that slept under the old plugin (§5).
        ctx.logger.error(`[deepartments] dept_sleep: host session ROTATION could not run (${rotation.reason}); falling back to the legacy in-place reset (journal append + deferred fold + webUiCleanupPending)`)
        // Step 2 — register/refresh the durable host identity. ensureHost is
        // idempotent for an existing entry and refuses to change its roomId away
        // from what it has.
        ensureHost(sessionId, existing?.roomId ?? 'board')
        const hostEntry = hosts.get(hostId) as HostEntry
        // Step 3 — in-place surface reset, DEFERRED to the wake pre-step (Fix A,
        // root cause of the wake-7 tool-role 400s — explore-deep/2026-08-21-
        // failedmessages-tool-role-error.md): append the journal node NOW as a
        // PLAIN append (durability unchanged — the journal FILE is persisted by
        // bumpHostSleepCounter above and this node is recorded durably in the
        // session log), but DO NOT run the full-window replace here. Replacing
        // at close would shadow the assistant message carrying the dept_sleep
        // tool-call while the harness still appends the tool's own result AFTER
        // the replace — orphaning a role:'tool' node on the wake surface that
        // the strict opencode-go API rejects (400 INVALID_REQUEST). The
        // full-window replace is therefore DEFERRED: the intent (sessionId →
        // seeded journal text) is recorded in `deferredSleepReplace` and the
        // NEXT `agent/pre-step` (the Batch C injector below) performs it over
        // ALL current nodes INCLUDING the pending tool result — the assistant
        // tool-call and its result stay a legal sequence and the orphan never
        // reaches the API. Guarded so an agent-less / stub context (no real
        // Session surface) degrades safely (no append, no deferred intent).
        const session = agent.session
        if (session !== undefined && typeof session.append === 'function') {
          const message = buildSleepJournalMessage(seeded)
          session.append('user/message', message, { surfaceOp: 'append' })
          deferredSleepReplace.set(sessionId, seeded)
          // Fix wake-12: mirror the in-memory intent into the DURABLE host
          // entry so a process restart BETWEEN this dept_sleep and the wake
          // pre-step still folds the surface at the first pre-step of the new
          // process (the map does not survive the process; hosts.json does —
          // restored by the hosts loader at boot). persistHosts() below writes
          // it. Cleared when the fold consumes the intent.
          hostEntry.deferredJournalSeed = seeded
        }
        // Step 3.5 — web-UI sleep cleanup marker (Option A; src/session-
        // cleanup.ts): record the pending flag ONLY. The physical cleanup
        // (truncate the host session artifact, reset its projcache row,
        // archive+delete the child subagent dirs) must NOT run in this live
        // process — the harness appends the dept_sleep tool result + step/end
        // + turn/end AFTER execute() returns with the LIVE in-memory seqs, and
        // dsh-session's Session requires every persisted artifact to be
        // contiguous from seq 0 (else the next process's resume throws). The
        // next BOOT (which cold-boots from the truncated artifact by design)
        // performs the cleanup exactly once and clears this flag.
        hostEntry.webUiCleanupPending = true
        // Batch C — the wake context pack is NO LONGER frozen into the surface
        // at dept_sleep. It is now injected FRESH at the next `agent/pre-step`
        // (message-arrival time) by the host pre-step injector, so its board
        // delta / git / roster / cursor are current at the moment the user's
        // message arrives, not stale from the previous sleep. The reset surface
        // here is just the journal node (the durable memory). Clear the
        // wake-pack presence flag so the next wake's first pre-step re-injects.
        wakePackInjected.delete(sessionId)
        // Step 4 — ONLY AFTER the surface append is committed, set+persist the
        // durable sleep marker ("the Asistente slept at T"). This ordering closes
        // the crash window where sleepEpoch was durably persisted but the journal
        // had NOT been injected into the live surface yet (a stale resume while
        // marked slept).
        hostEntry.sleepEpoch = Date.now()
        // Task T1 — persist the session-event `seq` at this sleep boundary
        // (immediately after the boundary append) so the NEXT cycle's session-log
        // capture slices exactly by `seq > boundarySeq`, clock-independent.
        // Absent (stub session) → capture falls back to `time > lastWakeMs`.
        const hostBoundarySeq = (agent.session as { seq?: number } | undefined)?.seq
        if (hostBoundarySeq !== undefined) hostEntry.boundarySeq = hostBoundarySeq
        persistHosts()
        // Step 5 — conclude the sleeping Asistente's turn (the loop stops after
        // this successful tool result) — the host analog of a head ending its turn.
        // Guarded: dsh-tools ToolRunContext exposes concludeTurn(); a bare
        // { agent, signal } test exec does not.
        if (typeof (exec as { concludeTurn?: unknown }).concludeTurn === 'function') {
          (exec as { concludeTurn: () => void }).concludeTurn()
        }
        return { room: hostEntry.roomId, member: hostId, memoPath: journalPathFor(hostId), sleepEpoch: hostEntry.sleepEpoch }
      }

      // ---- head path (a registered post calling the host plane — preserved,
      // effectively a no-op today since heads call their own-layer tool). ----
      const entry = byPost.get(memberId)
      if (entry === void 0) throw new Error(`[deepartments] dept_sleep: "${memberId}" is not a registered post`)
      const journal = await readJournal(memberId)
      if (journal === void 0 || journal.trim() === '') {
        throw new Error('[deepartments] dept_sleep requires a saved journal — call dept_memo_write to save your memory first')
      }
      entry.sleepEpoch = Date.now()
      persistPosts()
      return { room: entry.roomId, member: memberId, memoPath: journalPathFor(memberId), sleepEpoch: entry.sleepEpoch }
    }
  }))

  ctx.effect(() => () => {
    globalWakeSnapshot()
    globalRetire()
    globalMemo()
    globalSleep()
  }, 'deepartments: host-plane tools')

  // --- agents/list + host/status RPC (server half, HTTP self-mount) --------
  // Serves the department-head roster rows (`agents`/`list`) and the U3
  // host-rotation lifecycle signal (`host/status`, spec 002 §6.1) to the client
  // over the `/deepartments` channel (trusted-host authority). The pure
  // computation lives in dispatchDeepartmentsEndpoint (exported, unit-tested
  // in test/rpc-channel.test.js); this effect only wires it to the live
  // registries + the board read model and mounts the HTTP routes. (U1: the
  // persistent UI config surface the channel once also served is removed with
  // the sidebar.)
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
      `[deepartments] /deepartments channel mounted; trustedHosts=${JSON.stringify(trustedHosts)}; routes: agents/list, host/status`
    )
    const endpointDeps: DeepartmentsEndpointDeps = {
      departments: config.org.departments,
      byPost: byPost as unknown as Map<string, PostEntryLike>,
      // U3 fix (reviewer 2026-08-22): `Map.values()` returns a SINGLE-USE
      // iterator, and `endpointDeps` is shared for the process lifetime. The
      // new buildHostStatusPayload iterates `deps.hosts` up to 3× (pick,
      // candidates spread, retired loop) and agents/list iterates it again, so
      // a bare `hosts.values()` was exhausted by the FIRST call (retired
      // degraded to []) and every later call saw zero hosts (hostSessionId →
      // null — the client watcher's rotation signal died after the first poll).
      // Re-iterable wire: EVERY `[Symbol.iterator]` call returns a FRESH
      // iterator over the live Map content. Fixing this inside
      // buildHostStatusPayload alone could not cure the cross-request
      // exhaustion of a shared one-shot iterator.
      hosts: { [Symbol.iterator]: (): Iterator<HostEntryLike> => hosts.values() as Iterator<HostEntryLike> },
      sessionLive: (sid) => agents !== void 0 && agents.get(SessionId(sid)) !== undefined,
      sessionRunning: (sid) => agents !== void 0 && agents.get(SessionId(sid))?.status === 'running',
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
      logger: ctx.logger
    }
    // Register each client path as a `kind:'exact'` POST route. `webServer.register`
    // returns a disposer; the effect folds them into one reversible registration
    // (AGENTS.md: every registration is a reversible effect).
    const routes: WebServerRouteLike[] = [
      { path: '/deepartments/agents', endpoint: 'agents' },
      { path: '/deepartments/list', endpoint: 'list' },
      { path: '/deepartments/host/status', endpoint: 'host/status' }
    ].map(({ path, endpoint }) => ({
      kind: 'exact' as const,
      path,
      handler: (req: unknown, res: unknown) => handleDeepartmentsRequest(req, res, endpoint, trustedHosts, endpointDeps)
    }))
    hostCtx.effect(() => {
      const disposers = routes.map((route) => webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'deepartments: agents/list + host/status RPC channel')
  })

}
