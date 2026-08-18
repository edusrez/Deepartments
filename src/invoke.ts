// dsh-deepartments — board AS A BUS (host-plane tools + wake relay + permanent
// department heads). The Asistente host talks DIRECTLY to department heads
// (resident posts) and to OTHER Asistente sessions through the shared board
// room — NO fork/clone intermediary. dept_invoke and the fork machinery are
// retired (Batch A).
//
// Batch B adds department HEADS: configured coordinators are materialized once
// as PERMANENT, MINIMAL-CONTEXT spawn posts (provider 'spawn', persona = role,
// lean `toolFilter: { allow: [] }`) — long-lived employees, not Asistente
// clones — with an official spatial-deployment context delivery and a minimal
// `dept_post_retire` cleanup affordance. The full nap/sleep lifecycle journal
// is Batch G and is NOT implemented here.
//
// Mechanics (per .dsh/reports/explore-deep/2026-08-19-host-board-channel.md,
// ...-lateral-assistant-addressing.md, ...-minimal-context-resident-posts.md):
//   - The host channel IS the global tool layer: `ctx.tools.register` on the
//     plugin's main-timeline ctx registers into the GLOBAL layer
//     (dsh-tools ScopedLayers.effect — unscoped ctx → global), visible to the
//     host Asistente AND every agent. We register the board tools
//     (dept_room_read/write/who/whereami) GLOBALLY so the host can read and
//     write the bus, AND we keep the registerContinuableSetup own-layer
//     install so a lean child (`toolFilter: { allow: [] }`) still sees them:
//     a restriction filters only inherited tools, never a scope's OWN layer
//     (dsh-tools view), so own-layer registration survives the allow-list.
//   - Hosts get a first-class, durable identity in `hosts.json`:
//     `host-<sessionId>` → { hostId, sessionId, roomId }. Registered LAZILY on
//     the host's first host-plane board tool call (ensureHost) — we never
//     fabricate a host session at boot. `dept_room_who` lists live hosts so
//     posts and sibling Asistente sessions can discover addresses.
//   - The wake relay wakes each addressed member:
//       * a registered POST  -> subagents.followup(parentAgent, childId, ...)
//                               through the live shared parent (UNCHANGED);
//       * a registered HOST  -> RAW `agents.get(SessionId(host.sessionId))
//                               .followup(createUserMessage(...))` — a host is
//                               NOT a continuable child, so subagents.followup
//                               is impossible (authorizeLineage rejects host
//                               targets); the raw Agent.followup is the correct,
//                               simpler wake (no parent hop, no lineage).
//     Self-wakes and echo loops are excluded; unknown members and non-live
//     hosts/parents are skipped with a warning.
//
// Batch C — wake-relay guards against confirmation ping-pong (the unbounded
// ack-echo loop the log audit found in seq 86-110): two residents replying
// "Confirmado… leído completo" to each other re-woke each other forever,
// because every ack is addressed back to its sender, each triggering a fresh
// wake. The relay now applies three guards BEFORE waking each addressed member
// (post branch AND host branch):
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
//   - `senderSession` resolves deterministically: a post sender via
//     byPost.get(from)?.childId, a host sender via hosts.get(from)?.sessionId.
//     The old `anyParentId()` fabrication is GONE.
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
//   - The wake relay needs the live shared parent for POST targets (rc.6
//     limitation): when ctx.agents.get(parentId) is undefined, the post wake
//     is SKIPPED with a warning. Host wakes are orthogonal — they target the
//     live host agent directly and need no parent hop.
//
// NO export default (pitfall 0001 — breaks `inject`).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { emitRoomRecord, roomSessionId, setBoardRecordListener } from './org.js'
import type { Config, CoordinatorConfig, RoomState } from './org.js'
import { loadRecords, resolveBoardPath } from './board-store.js'
import type { BoardRecord, MessagePayload } from './board-store.js'

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

// Batch C — ack-loop budget. A sender→target pair that has exchanged this many
// pure acks (payload.ack) within this window, with no intervening non-ack
// message, is treated as a confirmation loop: the relay stops waking it. Keep
// in sync with the relay header comment.
const ACK_LOOP_THRESHOLD = 3
const ACK_LOOP_WINDOW_MS = 120_000

/** One durable post registry entry. */
interface PostEntry {
  postId: string
  childId: string
  parentId: string
  roomId: string
  provider: string
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

/** One post row in dept_room_who / dept_whereami outputs. */
interface PostRow {
  postId: string
  childId: string
  parentId: string
  parentLive: boolean
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
      childId: string
      parentId: string
      provider: string
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
  const agents = ctx.get('agents')

  // --- mutable state (all owned by this invocation's closure; reversible) ---
  const byPost = new Map<string, PostEntry>()
  const byChild = new Map<string, string>()
  const memberCursors = new Map<string, CursorState>()
  // Batch C: per sender→target pair ack budget. Key `${from}|${to}` → how many
  // consecutive pure acks (payload.ack) that pair has exchanged and when the
  // last one landed. Any non-ack message between the pair resets it (delete).
  const ackCounters = new Map<string, { count: number; lastTs: number }>()
  const roomQueues = new Map<string, Promise<unknown>>()
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
    // A live host just joined: this is the lazy trigger for boot-deferred head
    // materialization (a head needs a live registered parent; see above).
    materializeHeads()
    return hostId
  }

  // Fire-and-forget persistence of the post registry (callers never await it).
  const persistPosts = (): void => {
    const data: Record<string, Omit<PostEntry, 'postId'>> = {}
    for (const entry of byPost.values()) data[entry.postId] = { childId: entry.childId, parentId: entry.parentId, roomId: entry.roomId, provider: entry.provider }
    writeFile(postsPath, JSON.stringify(data, null, 2), 'utf8').catch(
      (error: unknown) => { ctx.logger.warn(`[deepartments] posts.json write failed: ${error instanceof Error ? error.message : String(error)}`) }
    )
  }

  const registerEntry = (entry: PostEntry) => {
    byPost.set(entry.postId, entry)
    byChild.set(entry.childId, entry.postId)
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

  /**
   * Short "who is in the room" snapshot for a post's deployment context, read
   * from the CURRENT registries at deploy time (static members + each live
   * post in the room with its parent-liveness) — the same data path as
   * dept_room_who.
   */
  const formatPresence = (roomId: string): string => {
    const room = config.org.rooms.find((candidate) => candidate.id === roomId)
    const members = room === void 0 ? [] : [...room.members]
    const staticLine = members.length === 0 ? 'none configured' : members.join(', ')
    const postLines: string[] = []
    for (const entry of byPost.values()) {
      if (entry.roomId !== roomId) continue
      const parentLive = agents !== void 0 && agents.get(SessionId(entry.parentId)) !== undefined
      postLines.push(`${entry.postId}${parentLive ? ' (parent live)' : ' (parent offline)'}`)
    }
    const postLine = postLines.length === 0 ? 'none registered' : postLines.join(', ')
    const hostLines: string[] = []
    for (const entry of hosts.values()) {
      if (entry.roomId !== roomId) continue
      hostLines.push(entry.hostId)
    }
    const hostLine = hostLines.length === 0 ? 'none registered' : hostLines.join(', ')
    return `static members: ${staticLine}; registered posts: ${postLine}; live hosts: ${hostLine}`
  }

  // Best-effort cold load of the post registry (resident posts that already
  // existed; entries whose parent session is not live stay dormant until that
  // parent resumes — documented).
  const registryLoaded = readFile(postsPath, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text) as Record<string, Omit<PostEntry, 'postId'>>
      // Batch D: one-time data sweep for the RETIRED fork provider. The old
      // pre-Batch-A `asistente-fork-*` clones carry `provider: 'fork'` and are
      // ABANDONED ghosts (they consumed ~77M tokens doing nothing). Permanent
      // department heads are `provider: 'spawn'` and are NEVER touched — even
      // when their parent session is inactive (a head must re-materialize per
      // Batch B). We therefore delete ONLY fork-provider leftovers here.
      let sweptForks = 0
      for (const [postId, entry] of Object.entries(parsed)) {
        if (entry?.provider === 'fork') {
          // Orphaned fork ghost: never register it, remove its reverse map if
          // somehow present, and count it for the boot summary.
          byChild.delete(entry.childId)
          sweptForks++
          continue
        }
        if (typeof entry.childId === 'string' && typeof entry.parentId === 'string') {
          registerEntry({ postId, ...entry })
        }
      }
      // Persist after the sweep so the fork ghosts disappear from posts.json
      // too (they are only in memory until the write lands).
      if (sweptForks > 0) persistPosts()
      ctx.logger.info(`[deepartments] loaded ${byPost.size} post registry entries from posts.json${sweptForks > 0 ? `; swept ${sweptForks} retired fork-provider ghost(s)` : ''}`)
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
      const records = await loadRecords(filePath)
      const seq = records.length === 0 ? 0 : records[records.length - 1].seq + 1
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

  /**
   * The signal handed to startContinuable for post wakes. DETACHED (never
   * aborted): the ContinuableStartSpec contract is that the signal owns the
   * operation ONLY until inbox acceptance — a continuable child must outlive
   * the waking event.
   */
  const detachedSignal = (): AbortSignal => new AbortController().signal

  // --- department HEADS: permanent spawn posts (Batch B) ----------------------
  // Configured department coordinators are materialized ONCE as PERMANENT,
  // MINIMAL-CONTEXT resident posts: provider 'spawn' (fresh, empty seed — no
  // inherited Asistente conversation), persona = the coordinator's role, and a
  // lean `toolFilter: { allow: [] }` that strips the inherited host/preset
  // surface (bash/write/subagent/edit/web_fetch/...) while the own-layer board
  // tools (dept_room_*) survive — a restriction never filters a scope's OWN
  // layer (dsh-tools view). A head is registered once and REUSED: materialization
  // is idempotent by postId (already-present → skip). The full nap/sleep
  // lifecycle journal is Batch G and is NOT implemented here — a head simply
  // concludes turns as an inactive-but-resumable resident.
  //
  // Documented parent choice: a spawn child needs a LIVE parent so it can
  // settle/report (the subagent-settled notice travels to the parent), so a
  // head is NEVER created without one. We pick the FIRST registered live host
  // session (any host-<sessionId> whose agent is resident). At boot there is
  // typically no live host yet, so materialization DEFERS: it runs once on
  // boot (after the hosts registry cold-load) and again lazily on the first
  // live board-tool call (ensureHost). A head whose parent later goes offline
  // stays durable in the registry; the relay already SKIPS+WARNS on non-live
  // parents (existing behavior) — we never delete a head on boot.
  const materializing = new Set<string>()

  const pickLiveParent = () => {
    if (agents === void 0) return undefined
    for (const entry of hosts.values()) {
      const live = agents.get(SessionId(entry.sessionId))
      if (live !== void 0) return live
    }
    return undefined
  }
  type LiveAgent = NonNullable<ReturnType<typeof pickLiveParent>>

  /** Minimal identity framing for a permanent head — NO mission (missions
   * arrive later as addressed board messages). */
  const headPrompt = (postId: string): string =>
    `You are "${postId}", a permanent department head acting on your role. The board is your channel: read addressed messages with dept_room_read and reply with dept_room_write. Verify your identity and roster with dept_whereami and dept_room_who.`

  /** Official spatial-deployment context (no mission) for a freshly spawned head. */
  const deploymentContext = (parent: LiveAgent, postId: string, roomId: string): string => {
    const hostId = hostForSession.get(parent.id)
    const presence = formatPresence(roomId)
    return `Spatial deployment (official context — who and where you are): you are department head "${postId}" in room "${roomId}". The board is your channel. Address the Asistente host as "${hostId ?? 'host-<sessionId>'}" and other posts by postId. Verify with dept_whereami / dept_room_who. Room presence: ${presence}.`
  }

  const spawnHead = async (coordinator: CoordinatorConfig, roomId: string, parent: LiveAgent): Promise<void> => {
    const postId = coordinator.postId
    if (materializing.has(postId)) return
    materializing.add(postId)
    try {
      const spawned = await subagents!.startContinuable({
        provider: 'spawn', // permanent resident spawn provider (fresh, empty seed)
        label: postId,
        request: {
          prompt: [{ type: 'text', text: headPrompt(postId) }] as const,
          parent,
          persona: coordinator.role,
          toolFilter: { allow: [] },
          ...(coordinator.agentOptions !== void 0 ? { agentOptions: coordinator.agentOptions } : {})
        },
        signal: detachedSignal()
      })
      const childId = spawned.childId as string
      // Idempotency guard: a concurrent materialization may have landed first.
      if (byPost.has(postId)) return
      registerEntry({ postId, childId, parentId: parent.id, roomId, provider: 'spawn' })
      // Official spatial deployment (no mission), via the reusable official-
      // context followup channel (Batch A / 45233da).
      const source = { kind: 'coordinator', form: 'relay', senderSessionId: SessionId(parent.id) } as const
      subagents!.followup(parent, SessionId(childId), [{ type: 'text', text: deploymentContext(parent, postId, roomId) } as const], { source, signal: detachedSignal() })
        .catch((error: unknown) => {
          ctx.logger.warn(`[deepartments] head "${postId}" deployment followup failed: ${error instanceof Error ? error.message : String(error)}`)
        })
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] head "${postId}" materialization failed (deferred; a later live host parent will retry): ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      materializing.delete(postId)
    }
  }

  const materializeHeads = (): void => {
    if (subagents === void 0 || agents === void 0) return
    const parent = pickLiveParent()
    if (parent === void 0) return // no live host yet — defer until one joins
    for (const department of config.org.departments) {
      const coordinator = department.coordinator
      if (coordinator === void 0 || byPost.has(coordinator.postId)) continue
      void spawnHead(coordinator, department.roomId, parent)
    }
  }

  // Best-effort boot attempt (usually defers: no live host at boot). The
  // primary trigger is the lazy ensureHost join (below).
  void hostsLoaded.then(() => { materializeHeads() })

  const relay = (record: BoardRecord, roomId: string) => {
    if (record.kind !== 'message' || agents === void 0 || subagents === void 0) return
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

      // --- post branch: wake the registered post through the live shared
      // parent (UNCHANGED from the pre-Batch-A relay). ---
      const entry = byPost.get(member)
      if (entry !== void 0) {
        const parentAgent = agents.get(SessionId(entry.parentId))
        if (parentAgent === void 0) {
          ctx.logger.warn(`[deepartments] wake skipped for "${member}": parent session "${entry.parentId}" is not live (the relay needs the live shared parent — rc.6 limitation)`)
          continue
        }
        const senderSession = byPost.get(record.from)?.childId ?? hosts.get(record.from)?.sessionId ?? record.from
        // Pointer-only wake: NEVER embed the message body here (a silently
        // truncated relay caused two forks to accuse each other of fabricating
        // text). Identify the message by id + sender and point to the tools.
        const content = [{
          type: 'text',
          text: `Board delta in ${roomId}: new message ${record.id} from ${record.from} addressed to you. Read it with dept_room_read (room "${roomId}") and reply with dept_room_write addressed to the sender of the latest message you read.`
        } as const]
        const source = {
          kind: 'coordinator',
          form: 'relay',
          senderSessionId: SessionId(senderSession)
        } as const
        subagents.followup(parentAgent, SessionId(entry.childId), content, {
          source,
          signal: detachedSignal()
        }).catch((error: unknown) => {
          ctx.logger.warn(`[deepartments] wake relay to "${member}" failed: ${error instanceof Error ? error.message : String(error)}`)
        })
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
        const senderSession = byPost.get(record.from)?.childId ?? hosts.get(record.from)?.sessionId ?? record.from
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
                childId: { type: 'string', required: true },
                parentId: { type: 'string', required: true },
                parentLive: { type: 'boolean', required: true }
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
        const postLines = value.posts.map((post) => `  - ${post.postId}${post.parentLive ? ' (live)' : ' (parent offline)'}`)
        const postBlock = postLines.length === 0 ? '  (no registered posts)' : postLines.join('\n')
        const hostLines = value.hosts.map((host) => `  - ${host.hostId} (session ${host.sessionId}, ${host.sessionLive ? 'live' : 'not live'})`)
        const hostBlock = hostLines.length === 0 ? '  (no registered hosts)' : hostLines.join('\n')
        return [{
          type: 'text',
          text: `Room ${value.room} roster:\nStatic members:\n${memberLine}\nRegistered posts:\n${postBlock}\nRegistered hosts:\n${hostBlock}`
        } as const]
      }
    },
    async execute(args): Promise<{ room: string; members: string[]; posts: PostRow[]; hosts: HostRow[] }> {
      const room = config.org.rooms.find((candidate) => candidate.id === args.room)
      const members = room === void 0 ? [] : [...room.members]
      const posts: PostRow[] = []
      for (const entry of byPost.values()) {
        if (entry.roomId !== args.room) continue
        const parentLive = agents !== void 0 && agents.get(SessionId(entry.parentId)) !== undefined
        posts.push({
          postId: entry.postId,
          childId: entry.childId,
          parentId: entry.parentId,
          parentLive
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
              childId: { type: 'string', required: true },
              parentId: { type: 'string', required: true },
              provider: { type: 'string', required: true },
              members: { type: 'array', items: { type: 'string' }, required: true },
              posts: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    postId: { type: 'string', required: true },
                    childId: { type: 'string', required: true },
                    parentId: { type: 'string', required: true },
                    parentLive: { type: 'boolean', required: true }
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
          ? `you are post ${value.postId} in room ${value.roomId} (members: ${value.members.join(', ') || 'none'})`
          : value.hostId
            ? `you are the Asistente host (address ${value.hostId}, room "${value.hostRoomId ?? 'unregistered'}")`
            : 'you are the Asistente host (not a board post)'
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
        const parentLive = agents !== void 0 && agents.get(SessionId(candidate.parentId)) !== undefined
        posts.push({
          postId: candidate.postId,
          childId: candidate.childId,
          parentId: candidate.parentId,
          parentLive
        })
      }
      return {
        kind: 'post',
        postId,
        roomId: entry.roomId,
        childId: entry.childId,
        parentId: entry.parentId,
        provider: entry.provider,
        members,
        posts
      }
    }
  }))

  const globalRetire = ctx.tools.register(defineTool({
    name: 'dept_post_retire',
    description: 'Retire a registered board post cleanly: post a withdrawal note in its room (addressed to the post), then unregister it from the post/child registries and persist. Minimal retirement for department heads — no lifecycle journal (Batch G). Unknown postIds are rejected loudly.',
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
      await emitBoardMessage(entry.roomId, memberIdFor(agent.id as string, entry.roomId), [args.postId], `[withdrawal] post "${args.postId}" is retired and unregistered from the board.`)
      byPost.delete(args.postId)
      byChild.delete(entry.childId)
      persistPosts()
      return { postId: args.postId, roomId: entry.roomId, retired: true }
    }
  }))

  ctx.effect(() => () => {
    globalRead()
    globalWrite()
    globalWho()
    globalWhereami()
    globalRetire()
  }, 'deepartments: host-plane board tools')

  // --- child toolset (installed into EVERY continuable child — own layer, so
  // a lean toolFilter allow-list does not strip them; the same tool bodies as
  // the global host plane) ----------------------------------------------------

  if (subagents !== void 0) {
    subagents.registerContinuableSetup((childCtx) => {
      const disposeWrite = childCtx.tools.register(defineTool({
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
          const unknown = args.to.filter((addressee) => !isKnownAddressee(addressee))
          if (unknown.length > 0) {
            throw new Error(`[deepartments] dept_room_write: unknown addressee(s) ${unknown.join(', ')} — use dept_room_who for the roster`)
          }
          const { record } = await emitBoardMessage(args.room, memberId, [...args.to], args.text, null, args.ack === true, args.sensitive === true)
          return { room: args.room, from: memberId, to: [...args.to], messageId: record.id }
        }
      }))
      const disposeRead = childCtx.tools.register(defineTool({
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
          // Seq high-water slicing (Batch D): serve ONLY records with `seq`
          // above the member's durable `lastMessageSeq`. `state.messages` is
          // seq-ordered; a persisted cursor skips the historical backlog after
          // a restart, while a fresh member (cursor at -1) sees full history.
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
          // Batch D: mirror the advanced cursor to disk (write-through fire-and-forget).
          persistCursors(args.room, memberId, cursor)
          const delta = lines.length === 0 ? 'No board messages addressed to you.' : `Board delta (room ${args.room}) for ${memberId}:\n${lines.join('\n')}`
          return { room: args.room, member: memberId, delta }
        }
      }))

      const disposeWitness = childCtx.tools.register(defineTool({
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
      }))

      const disposeWho = childCtx.tools.register(defineTool({
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
                    childId: { type: 'string', required: true },
                    parentId: { type: 'string', required: true },
                    parentLive: { type: 'boolean', required: true }
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
            const postLines = value.posts.map((post) => `  - ${post.postId}${post.parentLive ? ' (live)' : ' (parent offline)'}`)
            const postBlock = postLines.length === 0 ? '  (no registered posts)' : postLines.join('\n')
            const hostLines = value.hosts.map((host) => `  - ${host.hostId} (session ${host.sessionId}, ${host.sessionLive ? 'live' : 'not live'})`)
            const hostBlock = hostLines.length === 0 ? '  (no registered hosts)' : hostLines.join('\n')
            return [{
              type: 'text',
              text: `Room ${value.room} roster:\nStatic members:\n${memberLine}\nRegistered posts:\n${postBlock}\nRegistered hosts:\n${hostBlock}`
            } as const]
          }
        },
        async execute(args): Promise<{ room: string; members: string[]; posts: PostRow[]; hosts: HostRow[] }> {
          const room = config.org.rooms.find((candidate) => candidate.id === args.room)
          const members = room === void 0 ? [] : [...room.members]
          const posts: PostRow[] = []
          for (const entry of byPost.values()) {
            if (entry.roomId !== args.room) continue
            const parentLive = agents !== void 0 && agents.get(SessionId(entry.parentId)) !== undefined
            posts.push({
              postId: entry.postId,
              childId: entry.childId,
              parentId: entry.parentId,
              parentLive
            })
          }
          const hostsInRoom: HostRow[] = []
          for (const entry of hosts.values()) {
            if (entry.roomId !== args.room) continue
            // Batch E liveness: report the host's REAL session liveness.
            const sessionLive = agents !== void 0 && agents.get(SessionId(entry.sessionId)) !== undefined
            hostsInRoom.push({ hostId: entry.hostId, sessionId: entry.sessionId, roomId: entry.roomId, sessionLive })
          }
          return { room: args.room, members, posts, hosts: hostsInRoom }
        }
      }))

      const disposeWhereami = childCtx.tools.register(defineTool({
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
                  childId: { type: 'string', required: true },
                  parentId: { type: 'string', required: true },
                  provider: { type: 'string', required: true },
                  members: { type: 'array', items: { type: 'string' }, required: true },
                  posts: {
                    type: 'array',
                    required: true,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        postId: { type: 'string', required: true },
                        childId: { type: 'string', required: true },
                        parentId: { type: 'string', required: true },
                        parentLive: { type: 'boolean', required: true }
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
              ? `you are post ${value.postId} in room ${value.roomId} (members: ${value.members.join(', ') || 'none'})`
              : value.hostId
                ? `you are the Asistente host (address ${value.hostId}, room "${value.hostRoomId ?? 'unregistered'}")`
                : 'you are the Asistente host (not a board post)'
          } as const]
        },
        async execute(_args, exec): Promise<WhereAmI> {
          const agent = exec.agent
          if (!agent) throw new Error('dept_whereami requires a calling agent (exec.agent was undefined)')
          const postId = postIdForChild(agent.id as string)
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
            return { kind: 'host', postId: null, roomId: null, message: 'You are the Asistente in your private room with the owner; you are NOT a board post.' }
          }
          const room = config.org.rooms.find((candidate) => candidate.id === entry.roomId)
          const members = room === void 0 ? [] : [...room.members]
          const posts: PostRow[] = []
          for (const candidate of byPost.values()) {
            if (candidate.roomId !== entry.roomId) continue
            const parentLive = agents !== void 0 && agents.get(SessionId(candidate.parentId)) !== undefined
            posts.push({
              postId: candidate.postId,
              childId: candidate.childId,
              parentId: candidate.parentId,
              parentLive
            })
          }
          return {
            kind: 'post',
            postId,
            roomId: entry.roomId,
            childId: entry.childId,
            parentId: entry.parentId,
            provider: entry.provider,
            members,
            posts
          }
        }
      }))

      return () => {
        disposeRead()
        disposeWrite()
        disposeWitness()
        disposeWho()
        disposeWhereami()
      }
    })
  }
}
