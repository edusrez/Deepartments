// dsh-deepartments — board AS A BUS (host-plane tools + wake relay + permanent
// department heads). The Asistente host talks DIRECTLY to department heads
// (resident posts) and to OTHER Asistente sessions through the shared board
// room — NO fork/clone intermediary. dept_invoke and the fork machinery are
// retired (Batch A).
//
// Batch 1a pivots department HEADS from CONTINUABLE SUBAGENTS to FIRST-CLASS
// ROOT AGENTS (per explore-deep/2026-08-20-main-agent-own-head.md and
// ...-permanent-agents-lifecycle.md, owner decision 2026-08-20). A configured
// coordinator is materialized as its OWN main agent via
// `ctx.agents.create`/`resume` from the plugin's ROOT service context (so it
// lands in agents.roots(), with no origin === 'subagent', and the GUI/sidebar
// renders it as a main-agent row exactly like "Assistant"):
//   - stable session id `SessionId(\`head-<postId>\`)`, `meta: { cwd: repoRoot,
//     origin: undefined, agentPreset: 'deepartments-head' }`, `agentOptions`
//     from the coordinator config, and a `setup(agentCtx)` that mounts the
//     dedicated `deepartments-head` preset AND registers the head's `dept_*`
//     board tools (dept_room_read/write/who, dept_whereami, dept_memo_write,
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
//     host Asistente AND every agent. We register the board tools
//     (dept_room_read/write/who/whereami) GLOBALLY so the host can read and
//     write the bus. Heads get their OWN scoped copies instead: `setup()`
//     registers the same tool bodies on the head's `agentCtx` (a scope's OWN
//     layer always survives, so no `toolFilter` is needed for a root agent).
//   - Hosts get a first-class, durable identity in `hosts.json`:
//     `host-<sessionId>` → { hostId, sessionId, roomId }. Registered LAZILY on
//     the host's first host-plane board tool call (ensureHost) — we never
//     fabricate a host session at boot. Heads are registered in `posts.json`,
//     keyed by postId → { sessionId, roomId, agentPreset, sleepEpoch?,
//     previousChildId? } (no parentId/provider — see PostEntry below).
//   - The wake relay wakes each addressed member:
//       * a registered HEAD    -> RAW `agents.get(SessionId(entry.sessionId))
//                                 .followup(createUserMessage(...))` — like the
//                                 host branch; NO parent hop, NO lineage.
//       * a registered HOST    -> RAW `agents.get(SessionId(host.sessionId))
//                                 .followup(createUserMessage(...))`.
//     Self-wakes and echo loops are excluded; unknown members are skipped with
//     a warning.
//
// Batch C — wake-relay guards against confirmation ping-pong (the unbounded
// ack-echo loop the log audit found in seq 86-110): two residents replying
// "Confirmado… leído completo" to each other re-woke each other forever,
// because every ack is addressed back to its sender, each triggering a fresh
// wake. The relay now applies three guards BEFORE waking each addressed member
// (head branch AND host branch):
//   * Ack-loop suppression: a PURE acknowledgement (payload.ack === true) on a
//     sender→target pair that has already exchanged N≥3 acks within the last
//     T=120s WITHOUT an intervening non-ack message is a confirmation loop —
//     the relay logs a debug line and does NOT wake a further turn. Each pair
//     key is `${from}|${to}`; any non-ack message between the pair resets its
//     counter. Acks are detected ONLY by the explicit `ack` flag (a first-class
//     affordance on dept_room_write, Batch C); free-text ack detection is
//     deliberately NOT attempted (unreliable).
//   * No self-wake (unchanged): `member === record.from` → continue.
//   * Boot-noise guard (unchanged): `record.kind !== 'message'` → return
//     (ready/agenda records wake nobody).
//   * Empty-delta wake dedup: if the member's read cursor has already advanced
//     past record R (`memberCursors[member].lastMessageSeq >= record.seq`), a
//     wake would serve nothing new, so the relay skips it. If the cursor was
//     lost (in-memory, reset on restart), the member wakes anyway — the
//     idempotent re-read is then acceptable.
//   The exact numbers (N≥3, T=120s) are module constants ACK_LOOP_THRESHOLD and
//   ACK_LOOP_WINDOW_MS below; the header comment and the constants must stay in
//   sync if either is ever tuned.
//   - `senderSession` resolves deterministically: a head sender via
//     byPost.get(from)?.sessionId, a host sender via hosts.get(from)?.sessionId,
//     else the raw member id. The old `anyParentId()` fabrication is GONE.
//   - Address validation in dept_room_write rejects fully-unknown addressees
//     loudly (no silent no-op); the relay still defensively skips+warns for
//     addressees that race out of the registry.
//
// Documented choices:
//   - Host registry reconciliation (Batch A): on boot we load hosts.json
//     best-effort, but we do NOT drop entries whose session has no live agent.
//     A cold-restarted host session is non-resident until reopened, so dropping
//     it would erase a legitimate host's identity; instead we keep it and the
//     relay SKIPS+WARNS when the target session is not live. Only a real
//     join (lazy ensureHost on a live tool call) registers/refreshes a host.
//   - Per-member read cursors (Batch D): the in-memory map keyed by member id
//     is the FAST PATH (no 'cursor' board record kind: BoardKind is closed by
//     board-store.ts), and it is now MIRRORED to `<stateDir>/cursors.json`
//     (write-through fire-and-forget, last-write) so a restart restores it.
//     Because the board seq is monotonic and append-only, a persisted
//     `lastMessageSeq` is a correct durable HIGH-WATER MARK: dept_room_read
//     serves ONLY records with `seq > cursor.lastMessageSeq` (never "from
//     index 0"), so a resumed member does NOT replay its historical backlog
//     after a restart. Semantics: FRESH member (no persisted cursor) = full
//     history; RESUMED member (cursor present) = only-new.
//   - Heads are root agents and are NEVER re-materialized by config in a fight
//     with `dept_post_retire`: materialization is idempotent — it only CREATES
//     a head whose durable `sessionId` is absent from the registry, and a
//     retired head is simply absent (no re-spawn on a later host join the way
//     the old materializeHeads did). "Permanent" = configured coordinator; the
//     registry's `agentPreset: 'deepartments-head'` field is the marker.
//
// NO export default (pitfall 0001 — breaks `inject`).
import { mkdir, readFile, writeFile, readdir, copyFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { emitRoomRecord, roomSessionId, setBoardRecordListener, setRoomCompactionResetter } from './org.js'
import type { Config, CoordinatorConfig, DepartmentConfig, RoomState } from './org.js'
import { loadRecords, resolveBoardPath } from './board-store.js'
import type { BoardRecord, MessagePayload } from './board-store.js'
import { buildAgentRows } from './agents.js'
import type { PostEntryLike } from './agents.js'

/**
 * Message source for a board wake relayed to a HOST Asistente session. The
 * source kind is merge-extensible (dsh-llm MessageSourceMap is open); the
 * plugin augments it below, mirroring how dsh-subagent adds its own kinds.
 */
interface BoardMessageSource {
  kind: 'board'
  form: 'notice'
  /** One-line account of the board delta, shown without expanding the row. */
  summary: string
  roomId?: string
  messageId?: string
  from?: string
  /** Session id of the sender (a host session or a post's child session). */
  senderSessionId?: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    board: BoardMessageSource
  }
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
  /** Batch G: set when the head SLEPT (memoized + marked). On the next wake the
   * relay cold-resumes the SAME durable session (context reset + journal reload)
   * instead of waking a live incarnation; cleared once the respawn lands.
   * Absent/undefined = never slept. */
  sleepEpoch?: number
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
  sleepEpoch?: number
  previousChildId?: string
}

/** One durable host registry entry (hostId → host session in a room). */
interface HostEntry {
  hostId: string
  sessionId: string
  roomId: string
}

/** Compact per-member read cursors (in-memory — see header comment). */
interface CursorState {
  /** Last addressed message id the member has seen. */
  lastMessageId: string | undefined
  /** Last addressed message seq the member has seen (Batch C empty-delta dedup). */
  lastMessageSeq: number
  /** Last agenda touch seq (board FILE seq) the member has seen. */
  lastAgendaSeq: number
}

/** One head (root-agent post) row in dept_room_who / dept_whereami outputs. */
interface PostRow {
  postId: string
  /** The head's stable root-agent session id. */
  sessionId: string
  roomId: string
  /** The mounted head preset (marker: configured permanent head). */
  agentPreset: string
  /** Whether the head's agent session is LIVE right now (agents.get defined). */
  sessionLive: boolean
  /** Batch G: whether the head is currently SLEEPING (sleepEpoch set — its next
   * wake cold-resumes a fresh incarnation instead of waking the old one). */
  sleeping: boolean
}

/** One host row in dept_room_who output. */
interface HostRow {
  hostId: string
  sessionId: string
  roomId: string
  /** Batch E: whether the host's agent session is LIVE right now (agents.get
   * defined). A cold-boot non-live host is listed truthfully with false. */
  sessionLive: boolean
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

/** Structural view of the `agents` service surface the head lifecycle touches
 * (rc.8 dsh-agent types/index.d.ts:288-370). */
interface AgentsLike {
  get(id: string): AgentLike | undefined
  list(): AgentLike[]
  roots(): AgentLike[]
  create(options: {
    sessionId: string
    meta?: Record<string, unknown>
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
    setup?: (agentCtx: Context) => unknown
    signal?: AbortSignal
  }): Promise<AgentHandleLike>
  resume(options: {
    resumeSessionId: string
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
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

/** dept_whereami spatial-identity result. */
type WhereAmI =
  | {
      kind: 'host'
      postId: null
      roomId: null
      hostId?: string
      sessionId?: string
      hostRoomId?: string
      message: string
    }
  | {
      kind: 'post'
      postId: string
      roomId: string
      /** The head's stable root-agent session id. */
      sessionId: string
      /** The mounted head preset (marker: configured permanent head). */
      agentPreset: string
      /** Whether the head's own agent session is live right now. */
      sessionLive: boolean
      members: string[]
      posts: PostRow[]
    }

/**
 * Format one addressed message as a compact TOC line for the model-facing
 * delta: message id + sender → recipients + a short preview. The preview is
 * truncated to 140 chars with an explicit '…' when longer — never silently
 * shortened: the message id on the line lets the model fetch the FULL text
 * by id (dept_room_read with messageId).
 */
function formatTocMessage(message: RoomState['messages'][number]): string {
  const preview = message.text.length > 140 ? `${message.text.slice(0, 140)}…` : message.text
  // Batch E sender-trust: surface the sensitive flag + registry-verified
  // sender in the rendered delta so a recipient can decide how to act. This is
  // a MODEL-FACING trust signal, NOT a hard enforcement block.
  const flag = message.sensitive
    ? `[sensitive — sender verified: ${message.senderVerified === true ? 'yes' : 'no'}] `
    : ''
  return `- ${message.id} | ${message.from} → ${message.to.join(', ') || '(all)'} | ${flag}${preview}`
}

/**
 * Format one agenda item for the model-facing delta (compact).
 */
function formatDeltaAgenda(item: RoomState['agenda'][number]): string {
  return `- agenda "${item.title}" (${item.status}, owner ${item.owner})`
}

/** YAML-ish flow list rendering for witness frontmatter arrays. */
function yamlList(items: readonly string[]): string {
  return `[${items.map((item) => JSON.stringify(item)).join(', ')}]`
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
}

/** Injected data/closure bundle the PURE endpoint dispatcher reads. The caller
 * (the route handler in applyInvoke) wires these to the live registries; tests
 * construct this directly. */
export interface DeepartmentsEndpointDeps {
  /** The mutable UI config the client reads/writes (`sidebarEnabled`). */
  uiConfig: { sidebarEnabled: boolean }
  /** Fire-and-forget persistence of the UI config. */
  persistUiConfig(): void
  /** config.org.departments — one row built per (coordinator-bearing) department. */
  departments: DepartmentConfig[]
  /** The durable post registry (postId → entry). */
  byPost: Map<string, PostEntryLike>
  /** The host registry, iterated to resolve a caller host member id by sessionId. */
  hosts: Iterable<HostEntryLike>
  /** Per-host-member read cursors, keyed by hostMemberId (lastMessageSeq watermark). */
  memberCursors: ReadonlyMap<string, { lastMessageSeq: number }>
  /** Live signal: the head's session is present in the agents registry. */
  sessionLive(sessionId: string): boolean
  /** Optional refinement: the head's session is currently running (status). */
  sessionRunning?: (sessionId: string) => boolean
  /** Load the durable `board` room records ONCE (undefined when no board room).
   * The board FILE is the cold source of truth and carries MessagePayload.ack,
   * which the folded room projection omits. */
  loadBoardRecords(): Promise<BoardRecord[] | undefined>
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
 * `ui/config` (read), `ui/config/set` (write + persist), and `agents`/`list`
 * (sidebar rows with per-host unread counts). Never throws for a normal call:
 * an unknown endpoint is a bad-request result, and internal failures are left
 * to the caller to fold (the route handler maps them to the `internal` branch).
 */
export async function dispatchDeepartmentsEndpoint(
  endpoint: string,
  payload: unknown,
  deps: DeepartmentsEndpointDeps
): Promise<DeepartmentsDispatchResult> {
  if (endpoint === 'ui/config') {
    return { ok: true, value: { sidebarEnabled: deps.uiConfig.sidebarEnabled } }
  }
  if (endpoint === 'ui/config/set') {
    const raw = (typeof payload === 'object' && payload !== null ? payload : {}) as { sidebarEnabled?: unknown }
    if (typeof raw.sidebarEnabled !== 'boolean') {
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: 'sidebarEnabled must be a boolean',
          details: { issues: [] }
        }
      }
    }
    deps.uiConfig.sidebarEnabled = raw.sidebarEnabled
    deps.persistUiConfig()
    return { ok: true, value: { sidebarEnabled: deps.uiConfig.sidebarEnabled } }
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
  // If the caller host is not (yet) registered in `hosts`, unread counts as 0
  // for all heads (nothing to count against).
  let sessionId: string | undefined
  if (typeof payload === 'object' && payload !== null) {
    const rawSession = (payload as { sessionId?: unknown }).sessionId
    if (typeof rawSession === 'string') sessionId = rawSession
  }
  let hostMemberId: string | undefined
  if (sessionId !== undefined) {
    for (const entry of deps.hosts) {
      if (entry.sessionId === sessionId) { hostMemberId = entry.hostId; break }
    }
  }
  const boardRecords = await deps.loadBoardRecords()
  // Unread addressed-to-host messages per head: board message with
  // seq > cursor.lastMessageSeq AND from === postId AND (to is empty OR
  // includes the caller host member id) AND payload.ack !== true — mirroring
  // the TOC filter at dept_room_read.
  const unreadFor = (postId: string): number => {
    if (hostMemberId === undefined || boardRecords === undefined) return 0
    const cursor = deps.memberCursors.get(hostMemberId)
    const lastSeq = cursor === undefined ? -1 : cursor.lastMessageSeq
    let count = 0
    for (const record of boardRecords) {
      if (record.kind !== 'message') continue
      if (record.seq <= lastSeq) continue
      if (record.from !== postId) continue
      if ((record.payload as MessagePayload).ack === true) continue
      if (record.to.length > 0 && !record.to.includes(hostMemberId)) continue
      count++
    }
    return count
  }
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
  const memberCursors = new Map<string, CursorState>()
  // Batch C: per sender→target pair ack budget. Key `${from}|${to}` → how many
  // consecutive pure acks (payload.ack) that pair has exchanged and when the
  // last one landed. Any non-ack message between the pair resets it (delete).
  const ackCounters = new Map<string, { count: number; lastTs: number }>()
  const roomQueues = new Map<string, Promise<unknown>>()
  // Batch F (D6): per-room monotonic next-seq counter, seeded ONCE from the
  // board file (lazy-once on the first emit). Replaces the O(n) re-read +
  // reparse of the whole board file on every emit (audit H2 — total write cost
  // was O(n²)) with an O(1) counter increment. This counter is the per-process
  // monotonic sequence source; boot compaction (board-store.ts) renumbers the
  // file at boot BEFORE any emit seeds the counter, so the counter and the
  // file stay consistent (both originate from the same post-boot file).
  const nextSeq = new Map<string, number>()
  const postsPath = path.join(config.stateDir, 'posts.json')
  // Batch D: per-member read cursors persisted to `<stateDir>/cursors.json`,
  // keyed by `${roomId}:${memberId}` (last-write, fire-and-forget). The
  // in-memory `memberCursors` map is the fast path and is rebuilt from this
  // file at boot so a restart does NOT replay the historical backlog.
  const cursorsPath = path.join(config.stateDir, 'cursors.json')

  // --- host registry (hostId → entry, plus sessionId → hostId reverse) ------
  const hosts = new Map<string, HostEntry>()
  const hostForSession = new Map<string, string>()
  const hostsPath = path.join(config.stateDir, 'hosts.json')

  // Fire-and-forget persistence of the host registry (callers never await it).
  const persistHosts = (): void => {
    const data: Record<string, Omit<HostEntry, 'hostId'>> = {}
    for (const entry of hosts.values()) data[entry.hostId] = { sessionId: entry.sessionId, roomId: entry.roomId }
    writeFile(hostsPath, JSON.stringify(data, null, 2), 'utf8').catch(
      (error: unknown) => { ctx.logger.warn(`[deepartments] hosts.json write failed: ${error instanceof Error ? error.message : String(error)}`) }
    )
  }

  // --- persistent UI config (sidebars etc.), mirroring the hosts.json pattern.
  // Served/updated over the `/deepartments` RPC (`ui/config` / `ui/config/set`)
  // so the client toggle works from ANY origin (Tailscale + loopback). Persisted
  // to `<stateDir>/ui.json`; missing/corrupt file keeps the default. ---
  const uiConfig: { sidebarEnabled: boolean } = { sidebarEnabled: true }
  const uiConfigPath = path.join(config.stateDir, 'ui.json')

  // Fire-and-forget persistence of the UI config (callers never await it).
  const persistUiConfig = (): void => {
    writeFile(uiConfigPath, JSON.stringify(uiConfig, null, 2), 'utf8').catch(
      (error: unknown) => { ctx.logger.warn(`[deepartments] ui.json write failed: ${error instanceof Error ? error.message : String(error)}`) }
    )
  }

  /**
   * Lazy host registration: called from a host-plane board tool when the
   * calling agent has no post entry (it is a HOST Asistente session). Records
   * the deterministic `host-<sessionId>` address and refreshes the roomId.
   * Never fabricates a host at boot — only a live tool call registers one.
   */
  const ensureHost = (sessionId: string, roomId: string): string => {
    const hostId = `${HOST_ID_PREFIX}${sessionId}`
    hosts.set(hostId, { hostId, sessionId, roomId })
    hostForSession.set(sessionId, hostId)
    persistHosts()
    return hostId
  }

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
        // Batch G: persist the optional sleep lifecycle fields only when set
        // (absent = never slept / no previous incarnation).
        ...(entry.sleepEpoch !== void 0 ? { sleepEpoch: entry.sleepEpoch } : {}),
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

  // --- per-member read cursors: durable mirror (Batch D) ----------------------
  // Disk key is `${roomId}:${memberId}`; the in-memory fast path collapses a
  // multi-room member's entries to the highest high-water seq per member id.
  const persistedCursors = new Map<string, CursorState>()
  const cursorKey = (roomId: string, memberId: string): string => `${roomId}:${memberId}`

  // Fire-and-forget write-through of ONE advanced cursor (mirrors the posts/
  // hosts persist pattern; last-write wins). The stateDir may not exist yet
  // on a first boot, so mkdir -p first.
  const persistCursors = (roomId: string, memberId: string, cursor: CursorState): void => {
    persistedCursors.set(cursorKey(roomId, memberId), cursor)
    const data: Record<string, CursorState> = {}
    for (const [key, value] of persistedCursors) data[key] = value
    mkdir(path.dirname(cursorsPath), { recursive: true }).then(() =>
      writeFile(cursorsPath, JSON.stringify(data, null, 2), 'utf8')
    ).catch((error: unknown) => {
      ctx.logger.warn(`[deepartments] cursors.json write failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Resolve the board member id of a calling agent: a registered post first,
   * else a (lazily registered) host. A bare agent with no post IS a host.
   */
  const memberIdFor = (agentId: string | undefined, roomId: string): string => {
    if (agentId === undefined) throw new Error('[deepartments] a calling agent is required')
    return postIdForChild(agentId) ?? ensureHost(agentId, roomId)
  }

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
          const previousChildId = typeof entry.previousChildId === 'string' ? entry.previousChildId : undefined
          // Batch 3a: a disposable worker is cold-loaded like any post, carrying
          // its durable `provider: 'worker'` marker + captured role. It is NOT
          // re-materialized by ensureAllHeads (config-only), so a retired worker
          // whose entry was removed stays gone across restarts.
          const provider = entry.provider === 'worker' ? 'worker' as const : undefined
          const role = typeof entry.role === 'string' ? entry.role : undefined
          registerEntry({
            postId,
            sessionId,
            roomId: entry.roomId,
            agentPreset: entry.agentPreset,
            ...(provider !== void 0 ? { provider } : {}),
            ...(role !== void 0 ? { role } : {}),
            ...(sleepEpoch !== void 0 ? { sleepEpoch } : {}),
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
      for (const [hostId, entry] of Object.entries(parsed)) {
        if (typeof entry.sessionId === 'string' && typeof entry.roomId === 'string' && hostId.startsWith(HOST_ID_PREFIX)) {
          const sessionId = hostId.slice(HOST_ID_PREFIX.length)
          if (sessionId === entry.sessionId) {
            hosts.set(hostId, { hostId, ...entry })
            hostForSession.set(entry.sessionId, hostId)
          }
        }
      }
      ctx.logger.info(`[deepartments] loaded ${hosts.size} host registry entries from hosts.json`)
    })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        ctx.logger.warn(`[deepartments] hosts.json load failed (starting with an empty registry): ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  // Best-effort cold load of the persistent UI config. A fresh/missing file
  // (ENOENT) keeps the default; a corrupt file keeps the default too (we never
  // throw — the RPC/poll reconciles live on the client side regardless).
  const uiConfigLoaded = readFile(uiConfigPath, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text) as { sidebarEnabled?: unknown }
      if (typeof parsed?.sidebarEnabled === 'boolean') {
        uiConfig.sidebarEnabled = parsed.sidebarEnabled
      }
      ctx.logger.info(`[deepartments] loaded ui.json (sidebarEnabled=${uiConfig.sidebarEnabled})`)
    })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        ctx.logger.warn(`[deepartments] ui.json load failed (keeping default UI config): ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  // Best-effort cold load of the persisted per-member read cursors (Batch D).
  // A fresh/missing file (ENOENT) → empty map: every member starts as a FRESH
  // reader (full history). A present file restores the durable high-water
  // `lastMessageSeq` so a RESUMED member reads only-new after a restart.
  const cursorsLoaded = readFile(cursorsPath, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text) as Record<string, CursorState>
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value?.lastMessageSeq !== 'number' || typeof value?.lastAgendaSeq !== 'number') continue
        persistedCursors.set(key, value)
        // Collapse to the per-member fast path: keep the highest high-water seq
        // (a multi-room member's entries coexist on disk, last-write wins here).
        const memberId = key.slice(key.indexOf(':') + 1)
        const existing = memberCursors.get(memberId)
        if (existing === void 0 || value.lastMessageSeq > existing.lastMessageSeq) {
          memberCursors.set(memberId, {
            lastMessageId: value.lastMessageId ?? undefined,
            lastMessageSeq: value.lastMessageSeq,
            lastAgendaSeq: value.lastAgendaSeq
          })
        }
      }
      ctx.logger.info(`[deepartments] loaded ${memberCursors.size} member read cursors from cursors.json`)
    })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        ctx.logger.warn(`[deepartments] cursors.json load failed (starting with fresh per-member cursors): ${error instanceof Error ? error.message : String(error)}`)
      }
    })

  // Serialize every emit per room: seq assignment reads the file's last seq,
  // so concurrent emitters must not interleave (single-process assumption).
  const serialize = <T>(roomId: string, task: () => Promise<T>): Promise<T> => {
    const previous = roomQueues.get(roomId) ?? Promise.resolve()
    const run = previous.then(task, task)
    roomQueues.set(roomId, run.then(() => void 0, () => void 0))
    return run
  }

  /**
   * Batch F (D6): seed the per-room next-seq counter ONCE from the board file
   * (lazy-once on first emit). Reads the file exactly once, sets
   * `nextSeq[roomId]` to (last seq + 1, or 0 for an empty file), and returns
   * it. The first read happens AFTER boot, so it reflects any `ready` record
   * applyOrg appended during boot AND any boot compaction that renumbered the
   * file — keeping the counter and the file consistent.
   */
  const seedNextSeq = async (roomId: string): Promise<number> => {
    const filePath = resolveBoardPath(config.stateDir, roomId)
    const records = await loadRecords(filePath)
    const seq = records.length === 0 ? 0 : records[records.length - 1].seq + 1
    nextSeq.set(roomId, seq)
    return seq
  }

  /**
   * Emit one addressed board message through org's emit site (session append
   * + file mirror + listener), assigning the next board file seq. When `ack` is
   * true the message is a pure acknowledgement/receipt (no new substance) and
   * is tagged `payload.ack = true` so the relay's ack-loop guard can recognize
   * it and stop confirmation ping-pong.
   */
  const emitBoardMessage = (roomId: string, from: string, to: string[], text: string, threadId: string | null = null, ack = false, sensitive = false): Promise<{ record: BoardRecord; session: Session }> =>
    serialize(roomId, async () => {
      const session = ctx.sessions.get(SessionId(roomSessionId(roomId)))
      if (session === void 0) throw new Error(`[deepartments] room "${roomId}" is not live (no session) — is the room configured?`)
      const filePath = resolveBoardPath(config.stateDir, roomId)
      // Batch F (D6): O(1) seq from the per-room counter (lazy-once seed on the
      // first emit). Never re-reads the board file on subsequent emits.
      const seq = nextSeq.get(roomId) ?? await seedNextSeq(roomId)
      nextSeq.set(roomId, seq + 1)
      // Batch E sender-trust: a sensitive message records the sensitive flag
      // AND a senderVerified flag computed from the registry (registered post,
      // or a live registered host). Surface signal, not enforcement.
      const payload: MessagePayload = { kind: 'note', text }
      if (ack) payload.ack = true
      if (sensitive) {
        payload.sensitive = true
        payload.senderVerified = computeSenderVerified(from)
      }
      const record: BoardRecord = {
        id: `m-${roomId}-${seq}`,
        seq,
        ts: Date.now(),
        from,
        to: [...to],
        cc: [],
        threadId,
        kind: 'message',
        payload
      }
      await emitRoomRecord(session, filePath, record, roomId)
      return { record, session }
    })

  /**
   * Address validation for dept_room_write: an addressee is known if it is a
   * registered post, a registered host, or a static member of any configured
   * room. Fully-unknown addressees are rejected loudly (the audit C4 no-op).
   */
  const isKnownAddressee = (addressee: string): boolean =>
    byPost.has(addressee) || hosts.has(addressee) || config.org.rooms.some((room) => room.members.includes(addressee))

  /**
   * Batch E sender-trust: resolve whether a recorded board member id (`from`)
   * is REGISTRY-VERIFIED — a registered post, or a registered host whose agent
   * session is currently live. Returned as the `senderVerified` flag on a
   * sensitive message. HONEST TRUST BOUND: this proves only that the sender
   * is a registry-admitted board member at emit time — it is NOT a
   * cryptographic signature and does not authenticate the content's author
   * beyond that registry admission. It is a pragmatic signal the recipient
   * sees, not an enforcement block (the audit's own recommendation was to
   * surface the trust signal, not to hard-block).
   */
  const computeSenderVerified = (from: string): boolean => {
    if (byPost.has(from)) return true // a registered post is registry-verified
    const host = hosts.get(from)
    if (host !== void 0) {
      // A host is verified only when its agent session is actually live.
      return agents !== void 0 && agents.get(SessionId(host.sessionId)) !== undefined
    }
    return false
  }

  // --- department HEADS: FIRST-CLASS ROOT AGENTS (Batch 1a) ------------------
  // A configured coordinator is materialized as its OWN root agent (NOT a
  // continuable subagent): created/resumed via ctx.agents.create/resume from
  const PRESET_ID = 'deepartments-head'
  /** Batch 3a: the dedicated DISPOSABLE-worker preset (mirrors the head preset
   * but framed as a temporary rank-and-file researcher). Materialized into the
   * harness-home user preset root alongside the head preset. */
  const WORKER_PRESET_ID = 'deepartments-worker'
  /** Repo root, used as the head agent's stable `meta.cwd` and as the preset
   * source. `new URL('.', import.meta.url)` already yields the compiled `lib/`
   * directory (of lib/invoke.js in dev), so one `'..'` up is the repo root. */
  const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
  // the plugin's ROOT service context — so it is owned by no live parent,
  // lands in agents.roots(), carries no `origin: 'subagent'`, and the
  // GUI/sidebar renders it as a main-agent row exactly like "Assistant".
  //   * stable id `SessionId(\`head-<postId>\`)`
  //   * `meta: { cwd: repoRoot, origin: undefined, agentPreset: 'deepartments-head' }`
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

  /** Write the journal file (author/timestamp/board_cursor frontmatter + runs of
   * decisions/constraints/openItems + the free-form summary body). Returns the
   * durable memo path. */
  const writeJournal = async (memberId: string, roomId: string, summary: string, decisions: string[], constraints: string[], openItems: string[]): Promise<string> => {
    const cursor = memberCursors.get(memberId)
    const content = [
      '---',
      `author: ${memberId}`,
      `room: ${roomId}`,
      `timestamp: ${new Date().toISOString()}`,
      `board_cursor: ${cursor?.lastMessageId ?? 'none'}`,
      `decisions: ${yamlList(decisions)}`,
      `constraints: ${yamlList(constraints)}`,
      `open_items: ${yamlList(openItems)}`,
      '---',
      '',
      summary,
      ''
    ].join('\n')
    const memoPath = journalPathFor(memberId)
    await mkdir(path.dirname(memoPath), { recursive: true })
    await writeFile(memoPath, content, 'utf8')
    return memoPath
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

  /** Disposer closure per tool the head own-layer registers. */
  type HeadToolDisposers = { dispose: () => void }

  /** Install the post's board toolset scoped to `agentCtx` (the post's OWN
   * layer — no toolFilter needed for a root agent). The same tool bodies the
   * host plane registers, reused for any resident post: dept_room_read/write,
   * dept_witness_write, dept_room_who, dept_whereami, dept_memo_write,
   * dept_sleep. dept_sleep's head version also disposes the post's AgentHandle
   * (the plugin's byHeadHandle map) after marking sleepEpoch.
   *
   * Batch 3a — `manager: true` (a department HEAD, not a worker) additionally
   * registers the department-lifecycle tools `dept_post_create` and
   * `dept_post_retire`, so a head can create/retire the WORKERS of its own
   * department. A worker (`manager: false`) gets ONLY the read/write board
   * tools — never the create/retire life-cycle controls (and a HOST never gets
   * them either: these register ONLY in the head own-layer, never the global
   * host plane). */
  const installHeadBoardTools = (agentCtx: Context, manager = false): HeadToolDisposers => {
    const disposers: Array<() => void> = []

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_room_write',
      description: 'Post an addressed message to one board room. The message is recorded from your board member id; addressed recipients are woken to read it. Addressees must be a registered head, a registered host (host-<sessionId>), or a static member — unknown addressees are rejected. Set ack:true when this is a PURE acknowledgement/receipt (no new content) so the wake relay does not loop on a confirmation ping-pong. Mark sensitive:true to flag a sensitive/mission-critical message so recipients can see the sender is registry-verified.',
      parameters: {
        room: { type: 'string', required: true, description: 'Room id to post to (e.g. "board").' },
        to: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'Board member ids this message is addressed to (e.g. ["research-head"]).'
        },
        text: { type: 'string', required: true, description: 'The message text.' },
        ack: { type: 'boolean', description: 'Set true when this is a pure acknowledgement/receipt (no new content) so the relay does not loop on it.' },
        sensitive: { type: 'boolean', description: 'Mark this message as sensitive; recipients will see the sender is registry-verified and the message is flagged. A pragmatic trust signal, not a crypto signature.' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            room: { type: 'string', required: true },
            from: { type: 'string', required: true },
            to: { type: 'array', items: { type: 'string' }, required: true },
            messageId: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: `posted ${value.messageId} to ${value.room} (from ${value.from} → ${value.to.join(', ') || '(all)'})` } as const]
      },
      async execute(args, exec): Promise<{ room: string; from: string; to: string[]; messageId: string }> {
        const agent = exec.agent
        if (!agent) throw new Error('dept_room_write requires a calling agent (exec.agent was undefined)')
        const memberId = memberIdFor(agent.id as string, args.room)
        const unknown = args.to.filter((addressee) => !isKnownAddressee(addressee))
        if (unknown.length > 0) {
          throw new Error(`[deepartments] dept_room_write: unknown addressee(s) ${unknown.join(', ')} — use dept_room_who for the roster`)
        }
        const { record } = await emitBoardMessage(args.room, memberId, [...args.to], args.text, null, args.ack === true, args.sensitive === true)
        return { room: args.room, from: memberId, to: [...args.to], messageId: record.id }
      }
    })))

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_room_read',
      description: 'Read this agent\'s new board messages in one room: the delta of messages addressed to you (or sent by you) plus agenda updates since your last read. By default returns a compact table-of-contents of new addressed messages since your last read (message id + sender + short preview, with \'…\' when the preview is truncated). Pass messageId to fetch the FULL text of one message (never truncated); pass limit/offset to page through the delta. Pass the room id (e.g. "board").',
      parameters: {
        room: { type: 'string', required: true, description: 'Room id to read (e.g. "board").' },
        messageId: { type: 'string', description: 'Optional: fetch the FULL text of this one message by id (never truncated). Does not advance the read cursor.' },
        limit: { type: 'number', description: 'Optional: max TOC entries per read (default 20).' },
        offset: { type: 'number', description: 'Optional: skip that many candidate messages in TOC mode (default 0).' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            room: { type: 'string', required: true },
            member: { type: 'string', required: true },
            delta: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.delta } as const]
      },
      async execute(args, exec): Promise<{ room: string; member: string; delta: string }> {
        const agent = exec.agent
        if (!agent) throw new Error('dept_room_read requires a calling agent (exec.agent was undefined)')
        const memberId = memberIdFor(agent.id as string, args.room)
        const session = ctx.sessions.get(SessionId(roomSessionId(args.room)))
        if (session === void 0) throw new Error(`[deepartments] room "${args.room}" is not live (no session)`)
        const snapshot = ctx.sessionProjections.snapshot(session)
        const state = snapshot.values['deepartments/room'] as RoomState | undefined
        if (state === void 0) {
          return { room: args.room, member: memberId, delta: 'No board messages addressed to you.' }
        }
        if (args.messageId !== undefined) {
          const message = state.messages.find((candidate) => candidate.id === args.messageId)
          if (message === void 0) {
            return { room: args.room, member: memberId, delta: `No board message with id "${args.messageId}" was found in room "${args.room}".` }
          }
          const flag = message.sensitive
            ? `[sensitive — sender verified: ${message.senderVerified === true ? 'yes' : 'no'}] `
            : ''
          const delta = `Full text of ${message.id} (from ${message.from} → ${message.to.join(', ') || '(all)'}):\n${flag}${message.text}`
          return { room: args.room, member: memberId, delta }
        }
        const cursor = memberCursors.get(memberId) ?? { lastMessageId: undefined, lastMessageSeq: -1, lastAgendaSeq: -1 }
        const candidates = state.messages
          .filter((message) => message.seq > cursor.lastMessageSeq && (message.to.includes(memberId) || message.from === memberId))
        const limit = Math.max(args.limit ?? 20, 1)
        const offset = Math.max(args.offset ?? 0, 0)
        const page = candidates.slice(offset, offset + limit)
        const remaining = Math.max(candidates.length - (offset + limit), 0)
        const lines: string[] = []
        for (const message of page) lines.push(formatTocMessage(message))
        if (remaining > 0) lines.push(`- … (${remaining} more messages; read again or page with offset)`)
        const agenda = state.agenda.filter((item) => item.cursorOfLastTouch > cursor.lastAgendaSeq)
        for (const item of agenda) lines.push(formatDeltaAgenda(item))
        if (page.length > 0) { cursor.lastMessageId = page[page.length - 1].id; cursor.lastMessageSeq = page[page.length - 1].seq }
        let maxAgendaSeq = -1
        for (const item of agenda) if (item.cursorOfLastTouch > maxAgendaSeq) maxAgendaSeq = item.cursorOfLastTouch
        if (maxAgendaSeq >= 0) cursor.lastAgendaSeq = maxAgendaSeq
        memberCursors.set(memberId, cursor)
        persistCursors(args.room, memberId, cursor)
        const delta = lines.length === 0 ? 'No board messages addressed to you.' : `Board delta (room ${args.room}) for ${memberId}:\n${lines.join('\n')}`
        return { room: args.room, member: memberId, delta }
      }
    })))

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_witness_write',
      description: 'Write this agent\'s relevo witness: a schema-constrained YAML-frontmatter markdown file in the room\'s witnesses directory. Use it when handing work over (relevo) or concluding an assignment.',
      parameters: {
        summary: { type: 'string', required: true, description: 'The witness body: a short summary of what was done and handed over.' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions taken (optional).' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints the successor must respect (optional).' },
        openItems: { type: 'array', items: { type: 'string' }, description: 'Open items for the successor (optional).' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            room: { type: 'string', required: true },
            member: { type: 'string', required: true },
            witnessPath: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: `witness written: ${value.witnessPath}` } as const]
      },
      async execute(args, exec): Promise<{ room: string; member: string; witnessPath: string }> {
        const agent = exec.agent
        if (!agent) throw new Error('dept_witness_write requires a calling agent (exec.agent was undefined)')
        const memberId = postIdForChild(agent.id as string) ?? 'unknown'
        const entry = byPost.get(memberId)
        const roomId = entry?.roomId ?? 'unknown'
        const cursor = memberCursors.get(memberId)
        const content = [
          '---',
          `author: ${memberId}`,
          `timestamp: ${new Date().toISOString()}`,
          `board_cursor: ${cursor?.lastMessageId ?? 'none'}`,
          `decisions: ${yamlList(args.decisions ?? [])}`,
          `constraints: ${yamlList(args.constraints ?? [])}`,
          `open_items: ${yamlList(args.openItems ?? [])}`,
          '---',
          '',
          args.summary,
          ''
        ].join('\n')
        const witnessPath = path.join(config.stateDir, 'rooms', roomId, 'witnesses', `${memberId}.md`)
        await mkdir(path.dirname(witnessPath), { recursive: true })
        await writeFile(witnessPath, content, 'utf8')
        return { room: roomId, member: memberId, witnessPath }
      }
    })))

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_room_who',
      description: 'Enumerate who is present in a board room from the live registries: the room\'s static members plus every registered head in that room (with whether its agent session is live) and every registered host (host-<sessionId>) that has joined it, each with whether its agent session is currently live (sessionLive). Use this for the authoritative roster instead of inferring presence from stale board history.',
      parameters: {
        room: { type: 'string', required: true, description: 'Room id to list who is present in (e.g. "board").' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            room: { type: 'string', required: true },
            members: { type: 'array', items: { type: 'string' }, required: true },
            posts: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  postId: { type: 'string', required: true },
                  sessionId: { type: 'string', required: true },
                  roomId: { type: 'string', required: true },
                  agentPreset: { type: 'string', required: true },
                  sessionLive: { type: 'boolean', required: true },
                  sleeping: { type: 'boolean', required: true }
                }
              }
            },
            hosts: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  hostId: { type: 'string', required: true },
                  sessionId: { type: 'string', required: true },
                  roomId: { type: 'string', required: true },
                  sessionLive: { type: 'boolean', required: true }
                }
              }
            }
          }
        },
        render: (_args, value) => {
          const memberLine = value.members.length === 0 ? '  (none configured)' : value.members.map((member) => `  - ${member}`).join('\n')
          const postLines = value.posts.map((post) => `  - ${post.postId}${post.sessionLive ? ' (live)' : ' (offline)'}${post.sleeping ? ' (sleeping)' : ''}`)
          const postBlock = postLines.length === 0 ? '  (no registered heads)' : postLines.join('\n')
          const hostLines = value.hosts.map((host) => `  - ${host.hostId} (session ${host.sessionId}, ${host.sessionLive ? 'live' : 'not live'})`)
          const hostBlock = hostLines.length === 0 ? '  (no registered hosts)' : hostLines.join('\n')
          return [{
            type: 'text',
            text: `Room ${value.room} roster:\nStatic members:\n${memberLine}\nRegistered heads:\n${postBlock}\nRegistered hosts:\n${hostBlock}`
          } as const]
        }
      },
      async execute(args): Promise<{ room: string; members: string[]; posts: PostRow[]; hosts: HostRow[] }> {
        const room = config.org.rooms.find((candidate) => candidate.id === args.room)
        const members = room === void 0 ? [] : [...room.members]
        const posts: PostRow[] = []
        for (const entry of byPost.values()) {
          if (entry.roomId !== args.room) continue
          const sessionLive = agents !== void 0 && agents.get(SessionId(entry.sessionId)) !== undefined
          posts.push({
            postId: entry.postId,
            sessionId: entry.sessionId,
            roomId: entry.roomId,
            agentPreset: entry.agentPreset,
            sessionLive,
            sleeping: entry.sleepEpoch !== void 0
          })
        }
        const hostsInRoom: HostRow[] = []
        for (const entry of hosts.values()) {
          if (entry.roomId !== args.room) continue
          const sessionLive = agents !== void 0 && agents.get(SessionId(entry.sessionId)) !== undefined
          hostsInRoom.push({ hostId: entry.hostId, sessionId: entry.sessionId, roomId: entry.roomId, sessionLive })
        }
        return { room: args.room, members, posts, hosts: hostsInRoom }
      }
    })))

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_whereami',
      description: 'Spatial identity: are you a registered board head or the host? Returns a "post" shape (your post id, room id, the room\'s static members and registered heads with session-liveness) when you are a registered board head; returns a "host" shape (including your host-<sessionId> address when registered) when you are the Asistente host, not a board head.',
      parameters: {},
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'host' },
                postId: { type: 'null', required: true },
                roomId: { type: 'null', required: true },
                hostId: { type: 'string' },
                sessionId: { type: 'string' },
                hostRoomId: { type: 'string' },
                message: { type: 'string', required: true }
              }
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'post' },
                postId: { type: 'string', required: true },
                roomId: { type: 'string', required: true },
                sessionId: { type: 'string', required: true },
                agentPreset: { type: 'string', required: true },
                sessionLive: { type: 'boolean', required: true },
                members: { type: 'array', items: { type: 'string' }, required: true },
                posts: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      postId: { type: 'string', required: true },
                      sessionId: { type: 'string', required: true },
                      roomId: { type: 'string', required: true },
                      agentPreset: { type: 'string', required: true },
                      sessionLive: { type: 'boolean', required: true },
                      sleeping: { type: 'boolean', required: true }
                    }
                  }
                }
              }
            }
          ]
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'post'
            ? `you are head ${value.postId} in room ${value.roomId} (members: ${value.members.join(', ') || 'none'})`
            : value.hostId
              ? `you are the Asistente host (address ${value.hostId}, room "${value.hostRoomId ?? 'unregistered'}")`
              : 'you are the Asistente host (not a board head)'
        } as const]
      },
      async execute(_args, exec): Promise<WhereAmI> {
        const agent = exec.agent
        if (!agent) throw new Error('dept_whereami requires a calling agent (exec.agent was undefined)')
        const postId = postIdForChild(agent.id as string)
        if (postId === undefined) {
          const existingId = hostForSession.get(agent.id as string)
          const existing = existingId !== void 0 ? hosts.get(existingId) : undefined
          if (existing !== void 0) {
            ensureHost(agent.id as string, existing.roomId)
            return { kind: 'host', postId: null, roomId: null, hostId: existing.hostId, sessionId: existing.sessionId, hostRoomId: existing.roomId, message: 'You are the Asistente in your private room with the owner; you are a registered host on the board, not a head.' }
          }
          const joinRoom = config.org.rooms[0]?.id
          if (joinRoom !== void 0) {
            const hostId = ensureHost(agent.id as string, joinRoom)
            const entry = hosts.get(hostId) as HostEntry
            return { kind: 'host', postId: null, roomId: null, hostId, sessionId: entry.sessionId, hostRoomId: entry.roomId, message: 'You are the Asistente in your private room with the owner; you are a registered host on the board, not a head.' }
          }
          return { kind: 'host', postId: null, roomId: null, message: 'You are the Asistente in your private room with the owner; you are NOT a board head.' }
        }
        const entry = byPost.get(postId)
        if (entry === void 0) {
          return { kind: 'host', postId: null, roomId: null, message: 'You are the Asistente in your private room with the owner; you are NOT a board head.' }
        }
        const room = config.org.rooms.find((candidate) => candidate.id === entry.roomId)
        const members = room === void 0 ? [] : [...room.members]
        const posts: PostRow[] = []
        for (const candidate of byPost.values()) {
          if (candidate.roomId !== entry.roomId) continue
          const sessionLive = agents !== void 0 && agents.get(SessionId(candidate.sessionId)) !== undefined
          posts.push({
            postId: candidate.postId,
            sessionId: candidate.sessionId,
            roomId: candidate.roomId,
            agentPreset: candidate.agentPreset,
            sessionLive,
            sleeping: candidate.sleepEpoch !== void 0
          })
        }
        return {
          kind: 'post',
          postId,
          roomId: entry.roomId,
          sessionId: entry.sessionId,
          agentPreset: entry.agentPreset,
          sessionLive: agents !== void 0 && agents.get(SessionId(entry.sessionId)) !== undefined,
          members,
          posts
        }
      }
    })))

    disposers.push(agentCtx.tools.register(defineTool({
      name: 'dept_memo_write',
      description: 'Write this department head\'s long-term memory to its journal: a durable, schema-constrained markdown memo at <stateDir>/journals/<memberId>.md (author/timestamp/board_cursor frontmatter + decisions/constraints/openItems + a free-form summary). Use it BEFORE sleeping to hand your memory to your future (re-materialized) self. Returns the durable memo path.',
      parameters: {
        summary: { type: 'string', required: true, description: 'The memo body: a summary of your state, conclusions, and what your next incarnation must know.' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions taken (optional).' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints your future self must respect (optional).' },
        openItems: { type: 'array', items: { type: 'string' }, description: 'Open items for your future self (optional).' }
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
        const memoPath = await writeJournal(memberId, roomId, args.summary, args.decisions ?? [], args.constraints ?? [], args.openItems ?? [])
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
        // Mark first (durable), then dispose the live AgentHandle. Dispose
        // tears the agent+session OUT of the in-memory registry (rc.8
        // dsh-agent-loop prepare() dispose, index.js:1132-1152 — it detaches
        // `agents.enter`/`sessions.enter` registrations only, NOT the
        // sessionPersistence backend), so the durable session survives and the
        // next wake resumes it. The registry keeps the head wakeable-while-
        // asleep via sleepEpoch.
        const sessionId = entry.sessionId
        entry.sleepEpoch = Date.now()
        persistPosts()
        await disposeHeadHandle(sessionId)
        return { room: entry.roomId, member: memberId, memoPath: journalPathFor(memberId), sleepEpoch: entry.sleepEpoch }
      }
    })))

    // --- Batch 3a: department-lifecycle tools — HEAD (manager) only ------
    // A department HEAD creates and retires DISPOSABLE WORKERS in its own
    // department room. These register ONLY here, in the head own-layer, so a
    // worker (manager:false) and a HOST (global plane) never see them — the
    // "host-CANNOT" invariant is structural (tool simply absent).
    if (manager) {
      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_post_create',
        description: 'Create a DISPOSABLE department worker in YOUR department room: spawn a fresh root agent (sessionId worker-<postId>), register it in posts.json as a disposable entry (provider:"worker"), and deliver its first message on the board. The worker lives in the department room and sees the shared board; it works your assigned task and sleeps when done; you retire it later with dept_post_retire. The first message (firstMessage, or prompt) is posted as a durable board message addressed to the worker. Emits a `deepartments/post-created` board message as its signal.',
        parameters: {
          postId: { type: 'string', required: true, description: 'Short slug for the worker, e.g. "researcher-alpha" (unique; not already registered).' },
          role: { type: 'string', required: true, description: 'The worker role, e.g. "rank-and-file researcher".' },
          room: { type: 'string', description: 'Department room id for the worker. Defaults to your own department room.' },
          prompt: { type: 'string', description: 'Initial assignment to the worker (alias of firstMessage).' },
          firstMessage: { type: 'string', description: 'The worker\'s initial assignment, delivered as a durable board message addressed to it.' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              postId: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              roomId: { type: 'string', required: true }
            }
          },
          render: (_args, value) => [{ type: 'text', text: `created worker ${value.postId} (session ${value.sessionId}) in room ${value.roomId}` } as const]
        },
        async execute(args, exec): Promise<{ postId: string; sessionId: string; roomId: string }> {
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
          // Room: default to the creating head's own department room; must be a
          // known configured room.
          const roomId = args.room ?? headEntry.roomId
          const knownRoom = config.org.rooms.some((room) => room.id === roomId)
          if (!knownRoom) throw new Error(`[deepartments] dept_post_create: "${roomId}" is not a known department room`)
          const sessionId = workerSessionId(args.postId)
          if (agents.get(String(SessionId(sessionId))) !== void 0) throw new Error(`[deepartments] dept_post_create: a live agent already exists for session "${sessionId}"`)
          const firstMessage = args.firstMessage ?? args.prompt
          const setup = workerSetup(args.postId, roomId, args.role)
          const handle = await agents.create({
            sessionId: String(SessionId(sessionId)),
            meta: { cwd: repoRoot, origin: undefined, agentPreset: WORKER_PRESET_ID },
            agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            setup
          })
          registerEntry({
            postId: args.postId,
            sessionId: String(SessionId(sessionId)),
            roomId,
            agentPreset: WORKER_PRESET_ID,
            provider: 'worker',
            role: args.role
          })
          byHeadHandle.set(String(SessionId(sessionId)), handle)
          // Deliver the initial assignment (or a creation note) as a DURABLE
          // board message from the head addressed to the worker — this IS the
          // `deepartments/post-created` event, and the wake relay wakes the
          // worker to read it. No direct followup needed; the board is durable.
          const text = firstMessage ?? `[created] worker "${args.postId}" (${args.role || 'department worker'}) is registered in this room. You are disposable — work your assigned task, then dept_memo_write and dept_sleep; your head retires you when done.`
          await emitBoardMessage(roomId, headId, [args.postId], text)
          return { postId: args.postId, sessionId: String(SessionId(sessionId)), roomId }
        }
      })))

      disposers.push(agentCtx.tools.register(defineTool({
        name: 'dept_post_retire',
        description: 'Retire a DISPOSABLE WORKER of YOUR department: post a withdrawal note addressed to the worker, dispose its live AgentHandle, and unregister it from the registry (persisted). Scope: you may only retire workers in YOUR OWN department room, and only disposable workers (provider:"worker") — permanent department heads are NOT retired by this path. Unknown postIds are rejected loudly.',
        parameters: {
          postId: { type: 'string', required: true, description: 'The worker post id to retire (e.g. "researcher-alpha").' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              postId: { type: 'string', required: true },
              roomId: { type: 'string', required: true },
              retired: { type: 'boolean', required: true }
            }
          },
          render: (_args, value) => [{ type: 'text', text: `retired worker ${value.postId} (room ${value.roomId})` } as const]
        },
        async execute(args, exec): Promise<{ postId: string; roomId: string; retired: boolean }> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_post_retire requires a calling agent (exec.agent was undefined)')
          return retirePost(args.postId, agent.id as string)
        }
      })))
    }

    return { dispose: () => { for (const d of disposers) d() } }
  }

  /** The role of a post as a prompt section (persona = role, NOT a mission —
   * missions arrive as addressed board messages). Registered on the post's own
   * systemPrompt layer when that service is composed. `isWorker` switches the
   * framing between a PERMANENT department head (manager) and a TEMPORARY
   * DISPOSABLE worker. Both are BOOT-QUIET (never act unaddressed). */
  const installRoleSection = (agentCtx: Context, role: string, postId: string, roomId: string, isWorker: boolean): void => {
    const sp = agentCtx.get('systemPrompt')
    if (sp === void 0 || typeof (sp as { section?: unknown }).section !== 'function') return
    sp.section({
      name: `deepartments:${isWorker ? 'worker' : 'head'}:role:${postId}`,
      order: 1,
      text: isWorker
        ? `You are "${postId}", a ${role || 'rank-and-file researcher'} DISPOSABLE department worker in the "${roomId}" department room of Deepartments (DeepSeek Harness). Your department HEAD created you as a temporary worker agent; your whole world is the department board and the shared room you live in. You do not edit the repository, run builders, or spawn other agents. Read addressed messages with dept_room_read, reply in the room with dept_room_write, orient with dept_whereami/dept_room_who, and persist your findings/memory with dept_memo_write. BOOT-QUIET: you never act on your own — on any materialization/resume/boot wake you stay idle and end your turn with NO action until an explicitly addressed board message arrives. Work the task your department head assigns you; when you are DONE, write dept_memo_write to save your results, then conclude with dept_sleep. You are DISPOSABLE: your head retires you with dept_post_retire when you are finished.`
        : `You are "${postId}", the ${role || 'department head'} of the "${roomId}" department room. You are a permanent, first-class agent: you do not edit the repository, run builders, or spawn other agents. Your world is the board — read with dept_room_read, reply with dept_room_write, orient with dept_whereami/dept_room_who, and persist memory with dept_memo_write before dept_sleep. You may create and retire DISPOSABLE WORKERS of your department with dept_post_create and dept_post_retire. BOOT-QUIET: you never act on your own — on any materialization/resume/boot wake you stay idle and end your turn with NO action until an explicitly addressed board message arrives; you never proactively write to the board.`
    })
  }

  /** Build the `setup(agentCtx)` for one post (head OR worker): mount the post's
   * dedicated preset and register its board toolset + role, scoped to the post
   * agent. Runs pre-publication on the fresh agent's scoped context
   * (rc.8 CreateAgentOptions.setup, index.d.ts:117). The `manager` flag gates
   * the department-lifecycle tools (a head creates/retires; a worker cannot). */
  const postSetup = (postId: string, roomId: string, role: string, opts: { preset: string; manager: boolean }): ((agentCtx: Context) => void | { commit(): void }) => {
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
      installRoleSection(agentCtx, role, postId, roomId, opts.manager === false)
      // Ensure the agent-scoped registrations unwind with the agent.
      agentCtx.effect(() => () => { tools.dispose(); restrictOwn() }, `deepartments: ${kind} board tools (${postId})`)
    }
  }

  /** The setup for a PERMANENT department head (manager — can create/retire
   * workers). Mounts the 'deepartments-head' preset. */
  const headSetup = (postId: string, roomId: string, role: string): ((agentCtx: Context) => void | { commit(): void }) =>
    postSetup(postId, roomId, role, { preset: 'deepartments-head', manager: true })

  /** The setup for a DISPOSABLE department WORKER (no create/retire). Mounts
   * the 'deepartments-worker' preset. */
  const workerSetup = (postId: string, roomId: string, role: string): ((agentCtx: Context) => void | { commit(): void }) =>
    postSetup(postId, roomId, role, { preset: WORKER_PRESET_ID, manager: false })

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

  /** Retire a registered post cleanly — the SHARED retirement path used by the
   * global HOST-plane `dept_post_retire` AND the head own-layer `dept_post_retire`.
   *
   * Retirement = (a) post a withdrawal note addressed to the post WHILE it is
   * still registered (so the relay wakes it), (b) dispose its live AgentHandle
   * (if any), (c) unregister it from byPost/byChild and persist. The persisted
   * durable session remains (no native delete — researcher M1), but the registry
   * stops addressing it, so it is never woken again; a retired CONFIGURED head is
   * simply re-materialized by ensureAllHeads as before (documented gap), whereas
   * a retired DISPOSABLE WORKER is never re-materialized (workers are runtime-only,
   * not config — see ensureAllHeads).
   *
   * Scope: a HOST caller (`postIdForChild(callerId) === undefined`) may retire
   * ANY post (today's semantics). A HEAD caller is restricted to DISPOSABLE
   * WORKERS of ITS OWN department room — a head can never retire a permanent
   * head or a worker of another head's room via this path. */
  const retirePost = async (postId: string, callerAgentId: string): Promise<{ postId: string; roomId: string; retired: true }> => {
    const entry = byPost.get(postId)
    if (entry === void 0) throw new Error(`[deepartments] dept_post_retire: "${postId}" is not a registered post`)
    // Scope check for HEAD callers (a caller that IS a registered post is a
    // department head; a caller with no post entry is a HOST).
    const callerId = postIdForChild(callerAgentId)
    if (callerId !== void 0) {
      const callerEntry = byPost.get(callerId)
      if (callerEntry === void 0) throw new Error(`[deepartments] dept_post_retire: caller "${callerId}" is not a registered post`)
      // A head may only retire DISPOSABLE WORKERS...
      if (entry.provider !== 'worker') throw new Error(`[deepartments] dept_post_retire: "${postId}" is not a disposable worker — a head may only retire workers, never a permanent head`)
      // ...and only in ITS OWN department room.
      if (entry.roomId !== callerEntry.roomId) throw new Error(`[deepartments] dept_post_retire: "${postId}" lives in room "${entry.roomId}" but you are head "${callerId}" of room "${callerEntry.roomId}" — you may only retire workers in your own department room`)
    }
    // Withdrawal note FIRST (while the post is still registered, so the relay
    // still wakes the targeted post), then unregister + persist.
    await emitBoardMessage(entry.roomId, memberIdFor(callerAgentId, entry.roomId), [postId], `[withdrawal] post "${postId}" is retired and unregistered from the board.`)
    byPost.delete(postId)
    byChild.delete(entry.sessionId)
    // Also dispose any live handle (retiring a post should not leave it live).
    void disposeHeadHandle(entry.sessionId)
    persistPosts()
    return { postId, roomId: entry.roomId, retired: true }
  }

  /** Ensure ONE configured head is materialized as a live root agent.
   * Idempotent: live → reuse (record the handle if create/resume just ran);
   * durable session in the registry → resume; else → create. Mirrors the
   * restartable create/resume fallback, tolerating a resume that fails because
   * no durable session exists yet (then create). Always (re)records the
   * registry entry keyed by the stable session id. */
  const ensureHead = async (coordinator: CoordinatorConfig, roomId: string): Promise<void> => {
    const postId = coordinator.postId
    const sessionId = SessionId(headSessionId(postId))
    if (agents === void 0) return
    let handle: AgentHandleLike | undefined
    const live = agents.get(String(sessionId))
    if (live !== void 0) {
      // Already live: reuse; record the registry entry (a head may be present
      // live without a registry entry if the harness pre-created it).
      const existing = byPost.get(postId)
      if (existing === void 0) {
        registerEntry(makeEntry(coordinator, roomId, String(sessionId)))
      }
      return
    }
    const coordinatorRole = coordinator.role || postId
    const setup = headSetup(postId, roomId, coordinatorRole)
    const agentOptions = coordinator.agentOptions
    const durableSession = byPost.get(postId) !== void 0
    if (durableSession) {
      try {
        handle = await agents.resume({ resumeSessionId: String(sessionId), agentOptions, setup })
        registerEntry(makeEntry(coordinator, roomId, String(sessionId)))
      } catch (error: unknown) {
        // Resume failed (e.g. no durable session in the persistence store after
        // a stateDir wipe): fall back to creating a fresh session.
        ctx.logger.warn(`[deepartments] head "${postId}" resume failed, creating fresh: ${error instanceof Error ? error.message : String(error)}`)
        handle = await agents.create({
          sessionId: String(sessionId),
          meta: { cwd: repoRoot, origin: undefined, agentPreset: PRESET_ID },
          agentOptions,
          setup
        })
        registerEntry(makeEntry(coordinator, roomId, String(sessionId)))
      }
    } else {
      handle = await agents.create({
        sessionId: String(sessionId),
        meta: { cwd: repoRoot, origin: undefined, agentPreset: PRESET_ID },
        agentOptions,
        setup
      })
      registerEntry(makeEntry(coordinator, roomId, String(sessionId)))
    }
    if (handle !== void 0) byHeadHandle.set(String(sessionId), handle)
  }

  /** Build a PostEntry for a configured head (root-agent shape, Batch 1b). */
  const makeEntry = (coordinator: CoordinatorConfig, roomId: string, sessionId: string): PostEntry => ({
    postId: coordinator.postId,
    sessionId,
    roomId,
    agentPreset: PRESET_ID
  })

  /** Ensure EVERY configured department head is a live root agent (boot, after
   * the registries load; also safe to re-run — idempotent per head). */
  const ensureAllHeads = async (): Promise<void> => {
    if (agents === void 0) return
    // Only materialize the presets into the harness-home user root when the
    // agentPresets service is present (hermetic compositions that never resolve
    // presets should not write outside the stateDir). BOTH the head preset and
    // the disposable-worker preset are made resolvable here.
    if (agentPresets !== void 0) {
      await materializePreset('deepartments-head')
      await materializePreset(WORKER_PRESET_ID)
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
      await ensureHead(coordinator, department.roomId)
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

  /** Cold-resume (or respawn-from-sleep) + wake one post (head OR worker) with
   * the pointer-only board delta. Called by the relay when the post is not live
   * (cold boot or slept+disposed). On respawn-from-sleep we first dispose any
   * stale live handle, clear sleepEpoch, keep the previousChildId trace, then
   * resume. Batch 3a: a WORKER is woken through the SAME raw root-agent path as
   * a head — `coordinatorForPost` is undefined for workers, so the role falls
   * back to the entry's captured `role` ('department worker' default), and the
   * create/resume materializes the 'deepartments-worker' preset. Sleep/respawn
   * is post-agnostic (keyed by sessionId) and needs no worker-specific change. */
  const wakePost = async (entry: PostEntry, record: BoardRecord, roomId: string): Promise<void> => {
    if (agents === void 0) throw new Error('[deepartments] wakePost requires the agents service')
    const isWorker = entry.provider === 'worker'
    const sessionId = SessionId(entry.sessionId)
    const coordinator = coordinatorForPost(entry.postId)
    if (entry.sleepEpoch !== void 0) {
      // Respawn from sleep: retire the live handle (if any), record the
      // previous incarnation, clear the flag, then resume below.
      await disposeHeadHandle(entry.sessionId)
      byChild.delete(entry.sessionId)
      const previousSession = entry.sessionId
      registerEntry({
        ...entry,
        previousChildId: previousSession,
        sleepEpoch: undefined
      })
    }
    const live = agents.get(String(sessionId))
    if (live === void 0) {
      // Role fallback (Batch 3a): a worker has NO coordinator config, so fall
      // back to its durable captured role, else a neutral 'department worker'.
      const role = coordinator?.role ?? entry.role ?? 'department worker'
      const setup = isWorker
        ? workerSetup(entry.postId, entry.roomId, role)
        : headSetup(entry.postId, entry.roomId, role)
      const agentOptions = coordinator?.agentOptions
      const preset: string = isWorker ? WORKER_PRESET_ID : PRESET_ID
      let handle: AgentHandleLike | undefined
      try {
        handle = await agents.resume({ resumeSessionId: String(sessionId), agentOptions, setup })
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" wake-resume failed, creating fresh: ${error instanceof Error ? error.message : String(error)}`)
        handle = await agents.create({
          sessionId: String(sessionId),
          meta: { cwd: repoRoot, origin: undefined, agentPreset: preset },
          agentOptions,
          setup
        })
      }
      if (handle !== void 0) byHeadHandle.set(String(sessionId), handle)
    }
    const target = agents.get(String(sessionId))
    if (target === void 0) throw new Error(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" could not be materialized for wake`)
    // Fix A2 — fresh baseline for the (re)materialized incarnation so the relay
    // never misjudges a just-cold-resumed post as stuck before it can speak.
    markHeadProgress(String(sessionId), target)
    const senderSession = byPost.get(record.from)?.sessionId ?? hosts.get(record.from)?.sessionId ?? record.from
    target.followup(createUserMessage({
      content: [{
        type: 'text',
        text: `Board delta in ${roomId}: new message ${record.id} from ${record.from} addressed to you. Read it with dept_room_read (room "${roomId}") and reply with dept_room_write to the sender.`
      } as const],
      source: {
        kind: 'board',
        form: 'notice',
        plugin: 'deepartments',
        summary: boundContextSummary(`Board delta in ${roomId} from ${record.from}.`),
        roomId,
        messageId: record.id,
        from: record.from,
        senderSessionId: SessionId(senderSession)
      }
    }))
  }

  // Boot: materialize the head preset and every configured head once the
  // registries (posts/hosts/cursors) have cold-loaded. Head materialization no
  // longer needs a live parent (root agents) — it runs at boot unconditionally.
  void Promise.all([registryLoaded, hostsLoaded]).then(() => { void ensureAllHeads() })


  const relay = (record: BoardRecord, roomId: string) => {
    if (record.kind !== 'message' || agents === void 0) return
    for (const member of record.to) {
      if (member === record.from) continue

      // Guard (Batch C) — empty-delta wake dedup: if the member's read cursor
      // has ALREADY advanced past this record, a wake would serve nothing new
      // (the relay-vs-read cursor divergence, audit C2/H5). Compare by numeric
      // seq, never lexicographic ids. A lost cursor (in-memory, reset on
      // restart) misses the map → we wake anyway: the idempotent re-read is
      // acceptable then.
      const cursor = memberCursors.get(member)
      if (cursor !== void 0 && cursor.lastMessageSeq >= record.seq) {
        ctx.logger.debug(`[deepartments] empty-delta wake dedup: skip "${member}" (${record.id} already consumed by its read cursor at seq ${cursor.lastMessageSeq})`)
        continue
      }

      // Guard (Batch C) — ack-loop suppression: a pure ack (payload.ack) on a
      // pair that has already exchanged N≥3 acks within the last T=120s without
      // an intervening non-ack message is a confirmation loop; stop waking it.
      // Any non-ack message between the pair resets the counter. Detected ONLY
      // by the explicit `ack` flag (never free text).
      const isAck = (record.payload as { ack?: boolean }).ack === true
      const pairKey = `${record.from}|${member}`
      const now = Date.now()
      const priorPair = ackCounters.get(pairKey)
      const suppressAckLoop = isAck && priorPair !== void 0 && priorPair.count >= ACK_LOOP_THRESHOLD && (now - priorPair.lastTs) <= ACK_LOOP_WINDOW_MS
      if (isAck) ackCounters.set(pairKey, { count: (priorPair?.count ?? 0) + 1, lastTs: now })
      else ackCounters.delete(pairKey)
      if (suppressAckLoop) {
        ctx.logger.debug(`[deepartments] ack-loop suppressed: no wake to "${member}" (pair ${pairKey} exchanged ${priorPair!.count} acks within ${ACK_LOOP_WINDOW_MS / 1000}s)`)
        continue
      }

      // --- head branch (Batch 1a + Fix 2c-A): wake a registered department head
      // via the RAW root-agent path. A head is a first-class root agent (NOT a
      // continuable child), so the relay targets its own agent id directly —
      // `agents.get(SessionId(entry.sessionId)).followup(...)` — exactly like
      // the host branch below. This REMOVES the rc.6 "parent must be live"
      // limitation: no parent hop, no lineage. A head that is LIVE AND
      // PROGRESSING is woken inline; a cold/slept head (not live — disposed or
      // after a restart) is cold-resumed (or respawned from sleep) by wakePost
      // then woken; a live-but-STUCK head (running with no session progress past
      // STUCK_HEAD_MS — Batch 1c frozen-resident loop) is disposed and
      // cold-resumed so the wake is re-delivered from the durable board record.
      const entry = byPost.get(member)
      if (entry !== void 0) {
        const sessionId = SessionId(entry.sessionId)
        const live = agents.get(String(sessionId))
        if (live === void 0 || entry.sleepEpoch !== void 0) {
          // Not live (cold) or slept: materialize (resume/respawn) then wake.
          // Fire-and-forget from the relay's perspective (a detached board-write
          // side effect); failures are logged, and the durable registry state
          // (sleepEpoch etc.) is only mutated inside wakePost AFTER the resume
          // succeeds, so a later wake retries cleanly.
          void wakePost(entry, record, roomId).catch((error: unknown) => {
            ctx.logger.warn(`[deepartments] head wake to "${member}" failed: ${error instanceof Error ? error.message : String(error)}`)
          })
          continue
        }
        // Fix A2 — stuck-head wake resilience. A live-but-running head whose
        // resident loop has produced NO new session event for STUCK_HEAD_MS is a
        // wedged frozen agent (Batch 1c). Waking it inline would only enqueue a
        // followup into the frozen loop's in-memory inbox and LOSE it on restart
        // (the "Board delta" text never appears in the head session). Instead we
        // dispose the frozen handle and fall through to the COLD path: the
        // DURABLE board record is the re-delivery source, so the wake survives
        // even though the in-memory queue dies with the disposed handle. dispose
        // never throws (it catches internally), and the recovery is serialized
        // per head so the relay never double-resumes — it never throws.
        if (isHeadStuck(String(sessionId), live)) {
          ctx.logger.warn(`[deepartments] head "${member}" live but stuck (no session progress for ${STUCK_HEAD_MS / 1000}s) — disposing + cold-resuming from the durable board record`)
          const sid = String(sessionId)
          void serializeHeadRecovery(sid, async () => {
            // Dispose the frozen handle first; once gone, agents.get(sid) is
            // undefined again and wakePost takes the COLD resume path.
            await disposeHeadHandle(sid)
            // Reset progress baseline so the fresh incarnation is judged fresh.
            headProgress.delete(sid)
            try {
              await wakePost(entry, record, roomId)
            } catch (error: unknown) {
              ctx.logger.warn(`[deepartments] stuck-head wake to "${member}" failed after dispose: ${error instanceof Error ? error.message : String(error)}`)
            }
          })
          continue
        }
        // Healthy live head: enqueue after the current turn as today, and record
        // progress so the next stuck check measures from a fresh baseline.
        markHeadProgress(String(sessionId), live)
        const senderSession = byPost.get(record.from)?.sessionId ?? hosts.get(record.from)?.sessionId ?? record.from
        try {
          live.followup(createUserMessage({
            content: [{
              type: 'text',
              text: `Board delta in ${roomId}: new message ${record.id} from ${record.from} addressed to you. Read it with dept_room_read (room "${roomId}") and reply with dept_room_write to the sender.`
            } as const],
            source: {
              kind: 'board',
              form: 'notice',
              plugin: 'deepartments',
              summary: boundContextSummary(`Board delta in ${roomId} from ${record.from}.`),
              roomId,
              messageId: record.id,
              from: record.from,
              senderSessionId: SessionId(senderSession)
            }
          }))
        } catch (error: unknown) {
          ctx.logger.warn(`[deepartments] head wake to "${member}" failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        continue
      }

      // --- host branch (NEW, Batch A): wake the host via the RAW agent path.
      // A host is NOT a continuable child, so subagents.followup is impossible
      // (authorizeLineage rejects host targets). The raw Agent.followup opens a
      // new waking turn — the correct, simpler wake. ---
      const host = hosts.get(member)
      if (host !== void 0) {
        const target = agents.get(SessionId(host.sessionId))
        if (target === void 0) {
          ctx.logger.warn(`[deepartments] host wake skipped for "${member}": session "${host.sessionId}" is not live`)
          continue
        }
        const senderSession = byPost.get(record.from)?.sessionId ?? hosts.get(record.from)?.sessionId ?? record.from
        try {
          target.followup(createUserMessage({
            content: [{
              type: 'text',
              text: `Board delta in ${roomId}: new message ${record.id} from ${record.from} addressed to you. Read it with dept_room_read (room "${roomId}") and reply with dept_room_write to the sender.`
            } as const],
            source: {
              kind: 'board',
              form: 'notice',
              plugin: 'deepartments',
              summary: boundContextSummary(`Board delta in ${roomId} from ${record.from}.`),
              roomId,
              messageId: record.id,
              from: record.from,
              senderSessionId: SessionId(senderSession)
            }
          }))
        } catch (error: unknown) {
          ctx.logger.warn(`[deepartments] host wake to "${member}" failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        continue
      }

      // --- unknown member: skip + warn (defensive race window; dept_room_write
      // should have rejected it already, but the registry can change). ---
      ctx.logger.warn(`[deepartments] wake skipped for unknown member "${member}" in room "${roomId}"`)
    }
  }
  const removeListener = setBoardRecordListener(relay)
  ctx.effect(() => removeListener, 'deepartments: board record listener')

  // Batch F reviewer fix: clear the affected room's IN-MEMORY read cursors when
  // a boot compaction rewrites (renumbers) that room's board. The durable
  // cursors file is already reset by org's compactBoardFile; without this hook,
  // `memberCursors` cold-loaded the stale pre-reset high cursor and skips most
  // of the renumbered kept set — exactly the "resumed member skips unread kept
  // messages" hazard Batch D forbids. `memberCursors` is the collapsed per-member
  // fast path (highest high-water across rooms), so resetting the member to
  // FRESH is the correct in-memory mirror; the collapsed single-room design
  // already accepts member-global high-water. The member reset targets members
  // that hold a durable `${roomId}:<member>` cursor key — the same population
  // the durable reset affects.
  const removeCompactionResetter = setRoomCompactionResetter((roomId) => {
    for (const memberId of [...memberCursors.keys()]) {
      if (persistedCursors.has(`${roomId}:${memberId}`)) {
        memberCursors.set(memberId, { lastMessageId: undefined, lastMessageSeq: -1, lastAgendaSeq: -1 })
      }
    }
  })
  ctx.effect(() => removeCompactionResetter, 'deepartments: room compaction resetter')

  // --- tool definitions (shared by the GLOBAL host plane and the child's OWN
  // layer so a lean toolFilter still exposes them to resident posts) ---------

  if (subagents === void 0) {
    ctx.logger.warn('[deepartments] subagents service absent: the board toolset will not be installed into continuable children (host-plane tools may still fail at use if the services are absent)')
  }

  // --- global (host-plane) board tools: registered once on the plugin ctx so
  // the HOST Asistente (and every agent) sees them. Registered as a reversible
  // effect so HMR unloads them cleanly. ---
  const globalRead = ctx.tools.register(defineTool({
    name: 'dept_room_read',
    description: 'Read this agent\'s new board messages in one room: the delta of messages addressed to you (or sent by you) plus agenda updates since your last read. By default returns a compact table-of-contents of new addressed messages since your last read (message id + sender + short preview, with \'…\' when the preview is truncated). Pass messageId to fetch the FULL text of one message (never truncated); pass limit/offset to page through the delta. Pass the room id (e.g. "board").',
    parameters: {
      room: { type: 'string', required: true, description: 'Room id to read (e.g. "board").' },
      messageId: { type: 'string', description: 'Optional: fetch the FULL text of this one message by id (never truncated). Does not advance the read cursor.' },
      limit: { type: 'number', description: 'Optional: max TOC entries per read (default 20).' },
      offset: { type: 'number', description: 'Optional: skip that many candidate messages in TOC mode (default 0).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          room: { type: 'string', required: true },
          member: { type: 'string', required: true },
          delta: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.delta } as const]
    },
    async execute(args, exec): Promise<{ room: string; member: string; delta: string }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_room_read requires a calling agent (exec.agent was undefined)')
      const memberId = memberIdFor(agent.id as string, args.room)
      const session = ctx.sessions.get(SessionId(roomSessionId(args.room)))
      if (session === void 0) throw new Error(`[deepartments] room "${args.room}" is not live (no session)`)
      const snapshot = ctx.sessionProjections.snapshot(session)
      const state = snapshot.values['deepartments/room'] as RoomState | undefined
      if (state === void 0) {
        // Projection unit absent (should not happen): serve nothing.
        return { room: args.room, member: memberId, delta: 'No board messages addressed to you.' }
      }

      // Fetch mode: return the FULL, untruncated text of one message by id.
      // Never advances the cursor and never touches memberCursors, so a
      // subsequent default read still serves the message.
      if (args.messageId !== undefined) {
        const message = state.messages.find((candidate) => candidate.id === args.messageId)
        if (message === void 0) {
          return { room: args.room, member: memberId, delta: `No board message with id "${args.messageId}" was found in room "${args.room}".` }
        }
        const flag = message.sensitive
          ? `[sensitive — sender verified: ${message.senderVerified === true ? 'yes' : 'no'}] `
          : ''
        const delta = `Full text of ${message.id} (from ${message.from} → ${message.to.join(', ') || '(all)'}):\n${flag}${message.text}`
        return { room: args.room, member: memberId, delta }
      }

      // TOC mode: compact table of contents of new addressed messages since
      // the last read, paged by limit/offset, plus agenda updates.
      const cursor = memberCursors.get(memberId) ?? { lastMessageId: undefined, lastMessageSeq: -1, lastAgendaSeq: -1 }
      // Seq high-water slicing (Batch D): serve ONLY records with `seq` above
      // the member's durable `lastMessageSeq`. `state.messages` is seq-ordered;
      // a persisted cursor therefore skips the historical backlog after a
      // restart, while a fresh member (cursor at -1) sees full history.
      const candidates = state.messages
        .filter((message) => message.seq > cursor.lastMessageSeq && (message.to.includes(memberId) || message.from === memberId))
      const limit = Math.max(args.limit ?? 20, 1)
      const offset = Math.max(args.offset ?? 0, 0)
      const page = candidates.slice(offset, offset + limit)
      const remaining = Math.max(candidates.length - (offset + limit), 0)
      const lines: string[] = []
      for (const message of page) lines.push(formatTocMessage(message))
      if (remaining > 0) lines.push(`- … (${remaining} more messages; read again or page with offset)`)
      const agenda = state.agenda.filter((item) => item.cursorOfLastTouch > cursor.lastAgendaSeq)
      for (const item of agenda) lines.push(formatDeltaAgenda(item))
      // Advance the cursor to the last TOC entry shown so the next read
      // serves only newer messages.
      if (page.length > 0) { cursor.lastMessageId = page[page.length - 1].id; cursor.lastMessageSeq = page[page.length - 1].seq }
      let maxAgendaSeq = -1
      for (const item of agenda) if (item.cursorOfLastTouch > maxAgendaSeq) maxAgendaSeq = item.cursorOfLastTouch
      if (maxAgendaSeq >= 0) cursor.lastAgendaSeq = maxAgendaSeq
      memberCursors.set(memberId, cursor)
      // Batch D: mirror the advanced cursor to disk (write-through fire-and-forget)
      // so a restart restores the high-water mark instead of replaying history.
      persistCursors(args.room, memberId, cursor)
      const delta = lines.length === 0 ? 'No board messages addressed to you.' : `Board delta (room ${args.room}) for ${memberId}:\n${lines.join('\n')}`
      return { room: args.room, member: memberId, delta }
    }
  }))

  const globalWrite = ctx.tools.register(defineTool({
    name: 'dept_room_write',
    description: 'Post an addressed message to one board room. The message is recorded from your board member id; addressed recipients are woken to read it. Addressees must be a registered post, a registered host (host-<sessionId>), or a static member — unknown addressees are rejected. Set ack:true when this is a PURE acknowledgement/receipt (no new content) so the wake relay does not loop on a confirmation ping-pong. Mark sensitive:true to flag a sensitive/mission-critical message so recipients can see the sender is registry-verified.',
    parameters: {
      room: { type: 'string', required: true, description: 'Room id to post to (e.g. "board").' },
      to: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Board member ids this message is addressed to (e.g. ["research-head"]).'
      },
      text: { type: 'string', required: true, description: 'The message text.' },
      ack: { type: 'boolean', description: 'Set true when this is a pure acknowledgement/receipt (no new content) so the relay does not loop on it.' },
      sensitive: { type: 'boolean', description: 'Mark this message as sensitive; recipients will see the sender is registry-verified and the message is flagged. A pragmatic trust signal, not a crypto signature.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          room: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'array', items: { type: 'string' }, required: true },
          messageId: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `posted ${value.messageId} to ${value.room} (from ${value.from} → ${value.to.join(', ') || '(all)'})` } as const]
    },
    async execute(args, exec): Promise<{ room: string; from: string; to: string[]; messageId: string }> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_room_write requires a calling agent (exec.agent was undefined)')
      const memberId = memberIdFor(agent.id as string, args.room)
      // Loud address validation (audit C4 fix): reject fully-unknown addressees
      // instead of silently dropping them.
      const unknown = args.to.filter((addressee) => !isKnownAddressee(addressee))
      if (unknown.length > 0) {
        throw new Error(`[deepartments] dept_room_write: unknown addressee(s) ${unknown.join(', ')} — use dept_room_who for the roster`)
      }
      const { record } = await emitBoardMessage(args.room, memberId, [...args.to], args.text, null, args.ack === true, args.sensitive === true)
      return { room: args.room, from: memberId, to: [...args.to], messageId: record.id }
    }
  }))

  const globalWho = ctx.tools.register(defineTool({
    name: 'dept_room_who',
    description: 'Enumerate who is present in a board room from the live registries: the room\'s static members plus every registered post in that room (with whether its parent is live) and every registered host (host-<sessionId>) that has joined it, each with whether its agent session is currently live (sessionLive). Use this for the authoritative roster instead of inferring presence from stale board history.',
    parameters: {
      room: { type: 'string', required: true, description: 'Room id to list who is present in (e.g. "board").' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          room: { type: 'string', required: true },
          members: { type: 'array', items: { type: 'string' }, required: true },
          posts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                postId: { type: 'string', required: true },
                sessionId: { type: 'string', required: true },
                roomId: { type: 'string', required: true },
                agentPreset: { type: 'string', required: true },
                sessionLive: { type: 'boolean', required: true },
                sleeping: { type: 'boolean', required: true }
              }
            }
          },
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                hostId: { type: 'string', required: true },
                sessionId: { type: 'string', required: true },
                roomId: { type: 'string', required: true },
                sessionLive: { type: 'boolean', required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        const memberLine = value.members.length === 0 ? '  (none configured)' : value.members.map((member) => `  - ${member}`).join('\n')
        const postLines = value.posts.map((post) => `  - ${post.postId}${post.sessionLive ? ' (live)' : ' (offline)'}${post.sleeping ? ' (sleeping)' : ''}`)
        const postBlock = postLines.length === 0 ? '  (no registered heads)' : postLines.join('\n')
        const hostLines = value.hosts.map((host) => `  - ${host.hostId} (session ${host.sessionId}, ${host.sessionLive ? 'live' : 'not live'})`)
        const hostBlock = hostLines.length === 0 ? '  (no registered hosts)' : hostLines.join('\n')
        return [{
          type: 'text',
          text: `Room ${value.room} roster:\nStatic members:\n${memberLine}\nRegistered heads:\n${postBlock}\nRegistered hosts:\n${hostBlock}`
        } as const]
      }
    },
    async execute(args): Promise<{ room: string; members: string[]; posts: PostRow[]; hosts: HostRow[] }> {
      const room = config.org.rooms.find((candidate) => candidate.id === args.room)
      const members = room === void 0 ? [] : [...room.members]
      const posts: PostRow[] = []
      for (const entry of byPost.values()) {
        if (entry.roomId !== args.room) continue
        const sessionLive = agents !== void 0 && agents.get(SessionId(entry.sessionId)) !== undefined
        posts.push({
          postId: entry.postId,
          sessionId: entry.sessionId,
          roomId: entry.roomId,
          agentPreset: entry.agentPreset,
          sessionLive,
          sleeping: entry.sleepEpoch !== void 0
        })
      }
      const hostsInRoom: HostRow[] = []
      for (const entry of hosts.values()) {
        if (entry.roomId !== args.room) continue
        // Batch E liveness: report the host's REAL session liveness — a
        // cold-boot non-live host shows sessionLive:false, never "live".
        const sessionLive = agents !== void 0 && agents.get(SessionId(entry.sessionId)) !== undefined
        hostsInRoom.push({ hostId: entry.hostId, sessionId: entry.sessionId, roomId: entry.roomId, sessionLive })
      }
      return { room: args.room, members, posts, hosts: hostsInRoom }
    }
  }))

  const globalWhereami = ctx.tools.register(defineTool({
    name: 'dept_whereami',
    description: 'Spatial identity: are you a registered board post or the host? Returns a "post" shape (your post id, room id, the room\'s static members and registered posts with parent-liveness) when you are a registered board post; returns a "host" shape (including your host-<sessionId> address when registered) when you are the Asistente host, not a board post.',
    parameters: {},
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'host' },
              postId: { type: 'null', required: true },
              roomId: { type: 'null', required: true },
              hostId: { type: 'string' },
              sessionId: { type: 'string' },
              hostRoomId: { type: 'string' },
              message: { type: 'string', required: true }
            }
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'post' },
              postId: { type: 'string', required: true },
              roomId: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              agentPreset: { type: 'string', required: true },
              sessionLive: { type: 'boolean', required: true },
              members: { type: 'array', items: { type: 'string' }, required: true },
              posts: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    postId: { type: 'string', required: true },
                    sessionId: { type: 'string', required: true },
                    roomId: { type: 'string', required: true },
                    agentPreset: { type: 'string', required: true },
                    sessionLive: { type: 'boolean', required: true },
                    sleeping: { type: 'boolean', required: true }
                  }
                }
              }
            }
          }
        ]
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'post'
          ? `you are head ${value.postId} in room ${value.roomId} (members: ${value.members.join(', ') || 'none'})`
          : value.hostId
            ? `you are the Asistente host (address ${value.hostId}, room "${value.hostRoomId ?? 'unregistered'}")`
            : 'you are the Asistente host (not a board head)'
      } as const]
    },
    async execute(_args, exec): Promise<WhereAmI> {
      const agent = exec.agent
      if (!agent) throw new Error('dept_whereami requires a calling agent (exec.agent was undefined)')
      const postId = postIdForChild(agent.id as string)
      // The Asistente host (and any unregistered agent) has no post entry.
      if (postId === undefined) {
        // Batch E ensureHost (reviewer note 2): calling whereami counts as a
        // board tool call, so a host-only agent is REGISTERED here — it must
        // not stay addressless. Reuse its existing room when already
        // registered; an unregistered host joins the first configured room.
        const existingId = hostForSession.get(agent.id as string)
        const existing = existingId !== void 0 ? hosts.get(existingId) : undefined
        if (existing !== void 0) {
          ensureHost(agent.id as string, existing.roomId)
          return { kind: 'host', postId: null, roomId: null, hostId: existing.hostId, sessionId: existing.sessionId, hostRoomId: existing.roomId, message: 'You are the Asistente in your private room with the owner; you are a registered host on the board, not a post.' }
        }
        const joinRoom = config.org.rooms[0]?.id
        if (joinRoom !== void 0) {
          const hostId = ensureHost(agent.id as string, joinRoom)
          const entry = hosts.get(hostId) as HostEntry
          return { kind: 'host', postId: null, roomId: null, hostId, sessionId: entry.sessionId, hostRoomId: entry.roomId, message: 'You are the Asistente in your private room with the owner; you are a registered host on the board, not a post.' }
        }
        return { kind: 'host', postId: null, roomId: null, message: 'You are the Asistente in your private room with the owner; you are NOT a board post.' }
      }
      const entry = byPost.get(postId)
      if (entry === void 0) {
        // Registry race: postId came from byChild but is missing from byPost.
        // Treat as host to stay non-throwing and reversible.
        return { kind: 'host', postId: null, roomId: null, message: 'You are the Asistente in your private room with the owner; you are NOT a board post.' }
      }
      const room = config.org.rooms.find((candidate) => candidate.id === entry.roomId)
      const members = room === void 0 ? [] : [...room.members]
      const posts: PostRow[] = []
      for (const candidate of byPost.values()) {
        if (candidate.roomId !== entry.roomId) continue
        const sessionLive = agents !== void 0 && agents.get(SessionId(candidate.sessionId)) !== undefined
        posts.push({
          postId: candidate.postId,
          sessionId: candidate.sessionId,
          roomId: candidate.roomId,
          agentPreset: candidate.agentPreset,
          sessionLive,
          sleeping: candidate.sleepEpoch !== void 0
        })
      }
      return {
        kind: 'post',
        postId,
        roomId: entry.roomId,
        sessionId: entry.sessionId,
        agentPreset: entry.agentPreset,
        sessionLive: agents !== void 0 && agents.get(SessionId(entry.sessionId)) !== undefined,
        members,
        posts
      }
    }
  }))

  const globalRetire = ctx.tools.register(defineTool({
    name: 'dept_post_retire',
    description: 'Retire a registered board post cleanly: post a withdrawal note in its room (addressed to the post), then unregister it from the post/child registries and persist. A hard unregister for permanent posts (the lifecycle journal in Batch G covers the gentler sleep lifecycle path). Unknown postIds are rejected loudly.',
    parameters: {
      postId: { type: 'string', required: true, description: 'The post id to retire (e.g. "research-head").' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          postId: { type: 'string', required: true },
          roomId: { type: 'string', required: true },
          retired: { type: 'boolean', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `retired post ${value.postId} (room ${value.roomId})` } as const]
    },
    async execute(args, exec): Promise<{ postId: string; roomId: string; retired: boolean }> {
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
    description: 'Write this department head\'s long-term memory to its journal: a durable, schema-constrained markdown memo at <stateDir>/journals/<memberId>.md (author/timestamp/board_cursor frontmatter + decisions/constraints/openItems + a free-form summary). Use it BEFORE sleeping to hand your memory to your future (re-materialized) self. Returns the durable memo path.',
    parameters: {
      summary: { type: 'string', required: true, description: 'The memo body: a summary of your state, conclusions, and what your next incarnation must know.' },
      decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions taken (optional).' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints your future self must respect (optional).' },
      openItems: { type: 'array', items: { type: 'string' }, description: 'Open items for your future self (optional).' }
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
      const memoPath = await writeJournal(memberId, roomId, args.summary, args.decisions ?? [], args.constraints ?? [], args.openItems ?? [])
      return { room: roomId, member: memberId, memoPath }
    }
  }))

  const globalSleep = ctx.tools.register(defineTool({
    name: 'dept_sleep',
    description: 'Sleep (dormir): persist your memory to your journal (dept_memo_write MUST be called first — this is enforced) and mark yourself for a context RESET. Conclude the turn after calling this; on your NEXT wake you will be re-materialized as a fresh incarnation with your journal loaded as your long-term memory. Your previous session is retired from the active map (recorded as previousChildId) and never woken again. Rejects loudly if no journal has been saved.',
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
      entry.sleepEpoch = Date.now()
      persistPosts()
      return { room: entry.roomId, member: memberId, memoPath: journalPathFor(memberId), sleepEpoch: entry.sleepEpoch }
    }
  }))

  ctx.effect(() => () => {
    globalRead()
    globalWrite()
    globalWho()
    globalWhereami()
    globalRetire()
    globalMemo()
    globalSleep()
  }, 'deepartments: host-plane board tools')

  // --- main-agents sidebar RPC (server half, HTTP self-mount) ---------------
  // Serves agent-row status AND the persistent UI config to the client sidebar
  // over the `/deepartments` channel (trusted-host authority). The pure row + UI
  // computation lives in dispatchDeepartmentsEndpoint (exported, unit-tested in
  // test/rpc-channel.test.js); this effect only wires it to the live registries
  // + the board read model and mounts the HTTP routes.
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
  const connection = ctx.get('connection') as (ConnectionLike & { trustedHosts?: string[] }) | undefined
  const webServer = (ctx.get('webServer') ?? ctx.get('httpServer')) as WebServerLike | undefined
  if (webServer !== void 0) {
    // Trusted authorities from the DEPLOYED connection service: the same list the
    // rc.8 client-connection channel already vets every request against (seeded
    // by `--trusted-host laagencia.taildb5a7a.ts.net:8445` on the systemd unit).
    // NOTE: this Cordis build exposes NO `ctx.getConfig('...')` API (verified
    // absent from the cordis type surface and used by no dsh plugin), so the
    // trusted hosts are read from the live `connection.trustedHosts` field —
    // its public, schema-backed value — rather than the getConfig('web-app') /
    // getConfig('client-connection') fallbacks (documented deviation). Empty when
    // the service is absent / headless.
    const trustedHosts = connection?.trustedHosts ?? []
    const sidebarDeps: DeepartmentsEndpointDeps = {
      uiConfig,
      persistUiConfig,
      departments: config.org.departments,
      byPost: byPost as unknown as Map<string, PostEntryLike>,
      hosts: hosts.values() as Iterable<HostEntryLike>,
      memberCursors: memberCursors as unknown as ReadonlyMap<string, { lastMessageSeq: number }>,
      sessionLive: (sid) => agents !== void 0 && agents.get(SessionId(sid)) !== undefined,
      sessionRunning: (sid) => agents !== void 0 && agents.get(SessionId(sid))?.status === 'running',
      loadBoardRecords: async () => {
        // The board FILE is the cold source of truth and carries
        // MessagePayload.ack, which the folded room projection omits.
        const boardRoom = config.org.rooms.find((room) => room.id === 'board')
        return boardRoom === void 0 ? undefined : loadRecords(resolveBoardPath(config.stateDir, boardRoom.id))
      }
    }
    // Register each client path as a `kind:'exact'` POST route. `webServer.register`
    // returns a disposer; the effect folds them into one reversible registration
    // (AGENTS.md: every registration is a reversible effect).
    const routes: WebServerRouteLike[] = [
      { path: '/deepartments/agents', endpoint: 'agents' },
      { path: '/deepartments/list', endpoint: 'list' },
      { path: '/deepartments/ui/config', endpoint: 'ui/config' },
      { path: '/deepartments/ui/config/set', endpoint: 'ui/config/set' }
    ].map(({ path, endpoint }) => ({
      kind: 'exact' as const,
      path,
      handler: (req: unknown, res: unknown) => handleDeepartmentsRequest(req, res, endpoint, trustedHosts, sidebarDeps)
    }))
    ctx.effect(() => {
      const disposers = routes.map((route) => webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'deepartments: main-agents sidebar RPC channel')
  }

}
