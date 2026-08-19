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
import type { Config, CoordinatorConfig, RoomState } from './org.js'
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

// Batch C — ack-loop budget. A sender→target pair that has exchanged this many
// pure acks (payload.ack) within this window, with no intervening non-ack
// message, is treated as a confirmation loop: the relay stops waking it. Keep
// in sync with the relay header comment.
const ACK_LOOP_THRESHOLD = 3
const ACK_LOOP_WINDOW_MS = 120_000

/** One durable post registry entry — a FIRST-CLASS ROOT-AGENT department head
 * (Batch 1a). Keyed by postId; the durable root-agent session id is `sessionId`
 * (= `head-<postId>`). Drops the old continuable-subagent `parentId`/`provider`
 * continuation fields from the persisted JSON — a root head has no parent. The
 * `agentPreset: 'deepartments-head'` field is the marker that this is a
 * CONFIGURED permanent head (vs a future disposable worker). */
interface PostEntry {
  postId: string
  /** Stable root-agent session id (`head-<postId>`), shared by the agent
   * registry and its persisted session; the wake/dispose/resume identity. */
  sessionId: string
  roomId: string
  /** The head preset id this root agent mounts (marker: configured permanent head). */
  agentPreset: string
  /** Batch G: set when the head SLEPT (memoized + marked). On the next wake the
   * relay cold-resumes the SAME durable session (context reset + journal reload)
   * instead of waking a live incarnation; cleared once the respawn lands.
   * Absent/undefined = never slept. */
  sleepEpoch?: number
  /** Batch G: the sessionId of the PREVIOUS incarnation (recording where a slept
   * head's old live session went), kept so trace stays honest. Absent = first. */
  previousChildId?: string
  /** Legacy-compat view read by src/agents.ts `PostEntryLike` (frozen in Batch
   * 1b): `childId` mirrors `sessionId`, `parentId` is '' for a root head (no
   * parent), `provider` is the 'head' marker. NOT persisted. */
  childId: string
  parentId: string
  provider: string
}

/** The DURABLE shape persisted to posts.json (the legacy-compat
 * childId/parentId/provider are derived, never stored). */
interface PostEntryPersisted {
  sessionId: string
  roomId: string
  agentPreset: string
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
          registerEntry({
            postId,
            sessionId,
            roomId: entry.roomId,
            agentPreset: entry.agentPreset,
            ...(sleepEpoch !== void 0 ? { sleepEpoch } : {}),
            ...(previousChildId !== void 0 ? { previousChildId } : {}),
            // Legacy-compat view for agents.ts PostEntryLike (Batch 1b cleans up):
            childId: sessionId,
            parentId: '',
            provider: 'head'
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

  /** Idempotently materialize `presets/deepartments-head/` into the harness
   * home's `.agent-presets/` user root so the head preset is resolvable. The
   * copy is skipped when the destination already has the preset directory. */
  const materializeHeadPreset = async (): Promise<void> => {
    const presetId = 'deepartments-head'
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
      ctx.logger.info(`[deepartments] head preset materialized at ${dstDir}`)
    } catch (error: unknown) {
      // Non-fatal: if the preset cannot be materialized (e.g. source absent), the
      // head setup simply mounts nothing and still gets its board tools.
      ctx.logger.warn(`[deepartments] head preset materialization skipped: ${error instanceof Error ? error.message : String(error)}`)
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

  /** Install the head's board toolset scoped to `agentCtx` (the head's OWN
   * layer — no toolFilter needed for a root agent). The same tool bodies the
   * host plane registers, reused for a head: dept_room_read/write,
   * dept_witness_write, dept_room_who, dept_whereami, dept_memo_write,
   * dept_sleep. dept_sleep's HEAD version also disposes the head's
   * AgentHandle (the plugin's byHeadHandle map) after marking sleepEpoch. */
  const installHeadBoardTools = (agentCtx: Context): HeadToolDisposers => {
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

    return { dispose: () => { for (const d of disposers) d() } }
  }

  /** The agent's coordinator.role as a prompt section (persona = role, NOT a
   * mission — missions arrive as addressed board messages). Registered on the
   * head's own systemPrompt layer when that service is composed. */
  const installRoleSection = (agentCtx: Context, role: string, postId: string, roomId: string): void => {
    const sp = agentCtx.get('systemPrompt')
    if (sp === void 0 || typeof (sp as { section?: unknown }).section !== 'function') return
    sp.section({
      name: `deepartments:head:role:${postId}`,
      order: 1,
      text: `You are "${postId}", the ${role || 'department head'} of the "${roomId}" department room. You are a permanent, first-class agent: you do not edit the repository, run builders, or spawn other agents. Your world is the board — read with dept_room_read, reply with dept_room_write, orient with dept_whereami/dept_room_who, and persist memory with dept_memo_write before dept_sleep.`
    })
  }

  /** Build the `setup(agentCtx)` for one head: mount the 'deepartments-head'
   * preset and register the head's board toolset + coordinator role, scoped to
   * the head agent. Runs pre-publication on the fresh agent's scoped context
   * (rc.8 CreateAgentOptions.setup, index.d.ts:117). */
  const headSetup = (postId: string, roomId: string, role: string): ((agentCtx: Context) => void | { commit(): void }) => {
    return (agentCtx) => {
      // (0) LEAN tool restriction: a root agent has no startContinuable
      // toolFilter, so we hide the GLOBAL host-plane tools from the head with an
      // `allow: []` mask on the inherited surface (rc.8 dsh-tools restrict —
      // index.d.ts:611 "A restriction filters what a scope inherits... a
      // restricted-away global reads as absent"; it never touches the scope's
      // OWN layer). The head therefore sees ONLY its own-layer board tools.
      const restrictHead = agentCtx.tools.restrict({ allow: [] })
      // (a) Mount the dedicated head preset if the service is present.
      if (agentPresets !== void 0) {
        void agentPresets.mount(agentCtx, 'deepartments-head').catch((error: unknown) => {
          ctx.logger.warn(`[deepartments] head "${postId}" preset mount failed (board tools still installed): ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      // (b) Register the board toolset scoped to this agent.
      const tools = installHeadBoardTools(agentCtx)
      // (c) Persona = coordinator.role (not a mission).
      installRoleSection(agentCtx, role, postId, roomId)
      // Ensure the agent-scoped registrations unwind with the agent.
      agentCtx.effect(() => () => { tools.dispose(); restrictHead() }, `deepartments: head board tools (${postId})`)
    }
  }

  /** Dispose one head's live AgentHandle (its only teardown capability; the
   * bare `agents.get(id)` returns no dispose — rc.8 index.d.ts:349 vs 155-158).
   * Idempotent. The durable session survives for a later resume. */
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

  /** Build a PostEntry for a configured head (legacy-compat fields mirror). */
  const makeEntry = (coordinator: CoordinatorConfig, roomId: string, sessionId: string): PostEntry => ({
    postId: coordinator.postId,
    sessionId,
    roomId,
    agentPreset: PRESET_ID,
    childId: sessionId,
    parentId: '',
    provider: 'head'
  })

  /** Ensure EVERY configured department head is a live root agent (boot, after
   * the registries load; also safe to re-run — idempotent per head). */
  const ensureAllHeads = async (): Promise<void> => {
    if (agents === void 0) return
    // Only materialize the preset into the harness-home user root when the
    // agentPresets service is present (hermetic compositions that never resolve
    // presets should not write outside the stateDir).
    if (agentPresets !== void 0) await materializeHeadPreset()
    for (const department of config.org.departments) {
      const coordinator = department.coordinator
      if (coordinator === void 0) continue
      await ensureHead(coordinator, department.roomId)
    }
  }

  /** Cold-resume (or respawn-from-sleep) + wake one head with the pointer-only
   * board delta. Called by the relay when the head is not live (cold boot or
   * slept+disposed). On respawn-from-sleep we first dispose any stale live
   * handle, clear sleepEpoch, keep the previousChildId trace, then resume. */
  const wakeHead = async (entry: PostEntry, record: BoardRecord, roomId: string): Promise<void> => {
    if (agents === void 0) throw new Error('[deepartments] wakeHead requires the agents service')
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
        sleepEpoch: undefined,
        childId: entry.sessionId,
        parentId: '',
        provider: 'head'
      })
    }
    const live = agents.get(String(sessionId))
    if (live === void 0) {
      const role = coordinator?.role ?? entry.postId
      const setup = headSetup(entry.postId, entry.roomId, role)
      const agentOptions = coordinator?.agentOptions
      let handle: AgentHandleLike | undefined
      try {
        handle = await agents.resume({ resumeSessionId: String(sessionId), agentOptions, setup })
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] head "${entry.postId}" wake-resume failed, creating fresh: ${error instanceof Error ? error.message : String(error)}`)
        handle = await agents.create({
          sessionId: String(sessionId),
          meta: { cwd: repoRoot, origin: undefined, agentPreset: PRESET_ID },
          agentOptions,
          setup
        })
      }
      if (handle !== void 0) byHeadHandle.set(String(sessionId), handle)
    }
    const target = agents.get(String(sessionId))
    if (target === void 0) throw new Error(`[deepartments] head "${entry.postId}" could not be materialized for wake`)
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

      // --- head branch (Batch 1a): wake a registered department head via the
      // RAW root-agent path. A head is a first-class root agent (NOT a
      // continuable child), so the relay targets its own agent id directly —
      // `agents.get(SessionId(entry.sessionId)).followup(...)` — exactly like
      // the host branch below. This REMOVES the rc.6 "parent must be live"
      // limitation: no parent hop, no lineage. A head that is LIVE is woken
      // inline; a cold/slept head (not live — disposed or after a restart) is
      // cold-resumed (or respawned from sleep) by wakeHead then woken.
      const entry = byPost.get(member)
      if (entry !== void 0) {
        const sessionId = SessionId(entry.sessionId)
        const live = agents.get(String(sessionId))
        if (live === void 0 || entry.sleepEpoch !== void 0) {
          // Not live (cold) or slept: materialize (resume/respawn) then wake.
          // Fire-and-forget from the relay's perspective (a detached board-write
          // side effect); failures are logged, and the durable registry state
          // (sleepEpoch etc.) is only mutated inside wakeHead AFTER the resume
          // succeeds, so a later wake retries cleanly.
          void wakeHead(entry, record, roomId).catch((error: unknown) => {
            ctx.logger.warn(`[deepartments] head wake to "${member}" failed: ${error instanceof Error ? error.message : String(error)}`)
          })
          continue
        }
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
      const entry = byPost.get(args.postId)
      if (entry === void 0) throw new Error(`[deepartments] dept_post_retire: "${args.postId}" is not a registered post`)
      const agent = exec.agent
      if (!agent) throw new Error('dept_post_retire requires a calling agent (exec.agent was undefined)')
      // Withdrawal note FIRST (while the post is still registered, so the relay
      // still wakes the targeted post), then unregister + persist.
      await emitBoardMessage(entry.roomId, memberIdFor(agent.id as string, entry.roomId), [args.postId], `[withdrawal] head "${args.postId}" is retired and unregistered from the board.`)
      byPost.delete(args.postId)
      byChild.delete(entry.sessionId)
      // Also dispose any live handle (retiring a head should not leave it live).
      void disposeHeadHandle(entry.sessionId)
      persistPosts()
      return { postId: args.postId, roomId: entry.roomId, retired: true }
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

  // --- main-agents sidebar RPC (server half) ---------------------------------
  // Serves agent-row status AND the persistent UI config to the client sidebar
  // over the `/deepartments` channel (trusted-host authority — see below). The
  // pure row computation lives in src/agents.ts (buildAgentRows /
  // computeHeadStatus — directly testable); this effect only wires it to the
  // live registries + the board read model. `ctx.connection` comes from the
  // SEPARATE dsh-client-connection plugin and is NOT present in headless
  // profiles, so it is resolved OPTIONALLY via ctx.get('connection') — the same
  // optional-service pattern as the agents/subagents accessors above (never
  // added to inject, per the explore report seam).
  const connection = ctx.get('connection') as ConnectionLike | undefined
  if (connection !== void 0 && connection.rpc !== void 0) {
    const disposeRpc = connection.rpc.handle('/deepartments', async (endpoint, payload) => {
      try {
        // `ui/config` (read) and `ui/config/set` (write) serve the persistent
        // UI config (`sidebarEnabled`); `agents` + alias `list` serve the
        // sidebar rows. Anything else is a bad-request (the endpoint name is
        // surfaced in the message; the closed RpcErrorDetailsMap['bad-request']
        // type carries `issues`, so a contextual details object is not
        // representable — see the report).
        if (endpoint === 'ui/config') {
          return {
            ok: true,
            value: { sidebarEnabled: uiConfig.sidebarEnabled }
          } as const
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
            } as const
          }
          uiConfig.sidebarEnabled = raw.sidebarEnabled
          persistUiConfig()
          return {
            ok: true,
            value: { sidebarEnabled: uiConfig.sidebarEnabled }
          } as const
        }
        if (endpoint !== 'agents' && endpoint !== 'list') {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'unknown endpoint: ' + endpoint,
              details: { issues: [] }
            }
          } as const
        }
        // Resolve the caller host member id (host-<sessionId>) from its
        // sessionId. If the caller host is not (yet) registered in `hosts`,
        // unread counts as 0 for all heads (nothing to count against).
        let sessionId: string | undefined
        if (typeof payload === 'object' && payload !== null) {
          const raw = payload as { sessionId?: unknown }
          if (typeof raw.sessionId === 'string') sessionId = raw.sessionId
        }
        let hostMemberId: string | undefined
        if (sessionId !== undefined) {
          for (const entry of hosts.values()) {
            if (entry.sessionId === sessionId) { hostMemberId = entry.hostId; break }
          }
        }
        // Board room read model: load the durable board records ONCE (the FILE
        // is the cold source of truth and carries MessagePayload.ack, which the
        // folded room projection deliberately omits). `loadRecords` and
        // `resolveBoardPath` are the board-store accessors already in scope.
        const boardRoom = config.org.rooms.find((room) => room.id === 'board')
        const boardRecords = boardRoom === void 0 ? [] : await loadRecords(resolveBoardPath(config.stateDir, boardRoom.id))
        // Unread addressed-to-host messages per head: board message with
        // seq > cursor.lastMessageSeq AND from === postId AND (to is empty OR
        // includes the caller host member id) AND payload.ack !== true —
        // mirroring the TOC filter at dept_room_read (invoke.ts).
        const unreadFor = (postId: string): number => {
          if (hostMemberId === undefined || boardRoom === void 0) return 0
          const cursor = memberCursors.get(hostMemberId)
          const lastSeq = cursor === void 0 ? -1 : cursor.lastMessageSeq
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
          departments: config.org.departments,
          posts: byPost as unknown as Map<string, PostEntryLike>,
          agentRunning: (childId) => agents !== void 0 && agents.get(SessionId(childId))?.status === 'running',
          parentLive: (parentId) => agents !== void 0 && agents.get(SessionId(parentId)) !== undefined,
          unreadFor,
          sessionId
        })
        return {
          ok: true,
          value: {
            host: { id: 'asistente', name: 'Asistente', department: "User's Office" },
            agents: rows
          }
        } as const
      } catch (error) {
        // Never throw across the RPC boundary — fold any internal failure into
        // the `internal` error branch.
        return {
          ok: false,
          error: { code: 'internal', message: String(error), details: {} }
        } as const
      }
      // authority: 'trusted-host' — this deployment runs behind Tailscale and
      // the owner's GUI origin is a declared trusted host
      // (laagencia.taildb5a7a.ts.net:8445), which 'loopback' would reject. A
      // trusted-host channel also accepts loopback, so both the Tailscale board
      // and any localhost front-end keep working.
    }, { authority: 'trusted-host' })
    ctx.effect(() => () => { void disposeRpc() }, 'deepartments: main-agents sidebar RPC channel')
  }

}
