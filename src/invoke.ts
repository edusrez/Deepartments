// dsh-deepartments — board AS A BUS (host-plane tools + wake relay). The
// Asistente host talks DIRECTLY to department heads (resident posts) and to
// OTHER Asistente sessions through the shared board room — NO fork/clone
// intermediary. dept_invoke and the fork machinery are retired (Batch A).
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
//   - Per-member read cursors are an IN-MEMORY map keyed by member id (no
//     'cursor' board record kind: BoardKind is closed by board-store.ts).
//     Cursors are therefore lost on process restart — the member re-reads
//     addressed messages it already saw (idempotent).
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
import type { Config, RoomState } from './org.js'
import { loadRecords, resolveBoardPath } from './board-store.js'
import type { BoardRecord } from './board-store.js'

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
  return `- ${message.id} | ${message.from} → ${message.to.join(', ') || '(all)'} | ${preview}`
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
  const roomQueues = new Map<string, Promise<unknown>>()
  const postsPath = path.join(config.stateDir, 'posts.json')

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
      for (const [postId, entry] of Object.entries(parsed)) {
        if (typeof entry.childId === 'string' && typeof entry.parentId === 'string') {
          registerEntry({ postId, ...entry })
        }
      }
      ctx.logger.info(`[deepartments] loaded ${byPost.size} post registry entries from posts.json`)
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
   * + file mirror + listener), assigning the next board file seq.
   */
  const emitBoardMessage = (roomId: string, from: string, to: string[], text: string, threadId: string | null = null): Promise<{ record: BoardRecord; session: Session }> =>
    serialize(roomId, async () => {
      const session = ctx.sessions.get(SessionId(roomSessionId(roomId)))
      if (session === void 0) throw new Error(`[deepartments] room "${roomId}" is not live (no session) — is the room configured?`)
      const filePath = resolveBoardPath(config.stateDir, roomId)
      const records = await loadRecords(filePath)
      const seq = records.length === 0 ? 0 : records[records.length - 1].seq + 1
      const record: BoardRecord = {
        id: `m-${roomId}-${seq}`,
        seq,
        ts: Date.now(),
        from,
        to: [...to],
        cc: [],
        threadId,
        kind: 'message',
        payload: { kind: 'note', text }
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
   * The signal handed to startContinuable for post wakes. DETACHED (never
   * aborted): the ContinuableStartSpec contract is that the signal owns the
   * operation ONLY until inbox acceptance — a continuable child must outlive
   * the waking event.
   */
  const detachedSignal = (): AbortSignal => new AbortController().signal

  const relay = (record: BoardRecord, roomId: string) => {
    if (record.kind !== 'message' || agents === void 0 || subagents === void 0) return
    for (const member of record.to) {
      if (member === record.from) continue

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
        const delta = `Full text of ${message.id} (from ${message.from} → ${message.to.join(', ') || '(all)'}):\n${message.text}`
        return { room: args.room, member: memberId, delta }
      }

      // TOC mode: compact table of contents of new addressed messages since
      // the last read, paged by limit/offset, plus agenda updates.
      const cursor = memberCursors.get(memberId) ?? { lastMessageId: undefined, lastAgendaSeq: -1 }
      const start = cursor.lastMessageId === void 0 ? 0 : state.messages.findIndex((message) => message.id === cursor.lastMessageId) + 1
      const candidates = state.messages
        .slice(Math.max(start, 0))
        .filter((message) => message.to.includes(memberId) || message.from === memberId)
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
      if (page.length > 0) cursor.lastMessageId = page[page.length - 1].id
      let maxAgendaSeq = -1
      for (const item of agenda) if (item.cursorOfLastTouch > maxAgendaSeq) maxAgendaSeq = item.cursorOfLastTouch
      if (maxAgendaSeq >= 0) cursor.lastAgendaSeq = maxAgendaSeq
      memberCursors.set(memberId, cursor)
      const delta = lines.length === 0 ? 'No board messages addressed to you.' : `Board delta (room ${args.room}) for ${memberId}:\n${lines.join('\n')}`
      return { room: args.room, member: memberId, delta }
    }
  }))

  const globalWrite = ctx.tools.register(defineTool({
    name: 'dept_room_write',
    description: 'Post an addressed message to one board room. The message is recorded from your board member id; addressed recipients are woken to read it. Addressees must be a registered post, a registered host (host-<sessionId>), or a static member — unknown addressees are rejected.',
    parameters: {
      room: { type: 'string', required: true, description: 'Room id to post to (e.g. "board").' },
      to: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Board member ids this message is addressed to (e.g. ["research-head"]).'
      },
      text: { type: 'string', required: true, description: 'The message text.' }
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
      const { record } = await emitBoardMessage(args.room, memberId, [...args.to], args.text)
      return { room: args.room, from: memberId, to: [...args.to], messageId: record.id }
    }
  }))

  const globalWho = ctx.tools.register(defineTool({
    name: 'dept_room_who',
    description: 'Enumerate who is present in a board room from the live registries: the room\'s static members plus every registered post in that room (with whether its parent is live) and every live host (host-<sessionId>) that has joined it. Use this for the authoritative roster instead of inferring presence from stale board history.',
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
                roomId: { type: 'string', required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        const memberLine = value.members.length === 0 ? '  (none configured)' : value.members.map((member) => `  - ${member}`).join('\n')
        const postLines = value.posts.map((post) => `  - ${post.postId}${post.parentLive ? ' (live)' : ' (parent offline)'}`)
        const postBlock = postLines.length === 0 ? '  (no registered posts)' : postLines.join('\n')
        const hostLines = value.hosts.map((host) => `  - ${host.hostId} (session ${host.sessionId})`)
        const hostBlock = hostLines.length === 0 ? '  (no live hosts)' : hostLines.join('\n')
        return [{
          type: 'text',
          text: `Room ${value.room} roster:\nStatic members:\n${memberLine}\nRegistered posts:\n${postBlock}\nLive hosts:\n${hostBlock}`
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
        hostsInRoom.push({ hostId: entry.hostId, sessionId: entry.sessionId, roomId: entry.roomId })
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
        const hostId = hostForSession.get(agent.id as string)
        if (hostId !== undefined && hosts.has(hostId)) {
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

  ctx.effect(() => () => {
    globalRead()
    globalWrite()
    globalWho()
    globalWhereami()
  }, 'deepartments: host-plane board tools')

  // --- child toolset (installed into EVERY continuable child — own layer, so
  // a lean toolFilter allow-list does not strip them; the same tool bodies as
  // the global host plane) ----------------------------------------------------

  if (subagents !== void 0) {
    subagents.registerContinuableSetup((childCtx) => {
      const disposeWrite = childCtx.tools.register(defineTool({
        name: 'dept_room_write',
        description: 'Post an addressed message to one board room. The message is recorded from your board member id; addressed recipients are woken to read it. Addressees must be a registered post, a registered host (host-<sessionId>), or a static member — unknown addressees are rejected.',
        parameters: {
          room: { type: 'string', required: true, description: 'Room id to post to (e.g. "board").' },
          to: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Board member ids this message is addressed to (e.g. ["research-head"]).'
          },
          text: { type: 'string', required: true, description: 'The message text.' }
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
          const { record } = await emitBoardMessage(args.room, memberId, [...args.to], args.text)
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
            const delta = `Full text of ${message.id} (from ${message.from} → ${message.to.join(', ') || '(all)'}):\n${message.text}`
            return { room: args.room, member: memberId, delta }
          }
          const cursor = memberCursors.get(memberId) ?? { lastMessageId: undefined, lastAgendaSeq: -1 }
          const start = cursor.lastMessageId === void 0 ? 0 : state.messages.findIndex((message) => message.id === cursor.lastMessageId) + 1
          const candidates = state.messages
            .slice(Math.max(start, 0))
            .filter((message) => message.to.includes(memberId) || message.from === memberId)
          const limit = Math.max(args.limit ?? 20, 1)
          const offset = Math.max(args.offset ?? 0, 0)
          const page = candidates.slice(offset, offset + limit)
          const remaining = Math.max(candidates.length - (offset + limit), 0)
          const lines: string[] = []
          for (const message of page) lines.push(formatTocMessage(message))
          if (remaining > 0) lines.push(`- … (${remaining} more messages; read again or page with offset)`)
          const agenda = state.agenda.filter((item) => item.cursorOfLastTouch > cursor.lastAgendaSeq)
          for (const item of agenda) lines.push(formatDeltaAgenda(item))
          if (page.length > 0) cursor.lastMessageId = page[page.length - 1].id
          let maxAgendaSeq = -1
          for (const item of agenda) if (item.cursorOfLastTouch > maxAgendaSeq) maxAgendaSeq = item.cursorOfLastTouch
          if (maxAgendaSeq >= 0) cursor.lastAgendaSeq = maxAgendaSeq
          memberCursors.set(memberId, cursor)
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
        description: 'Enumerate who is present in a board room from the live registries: the room\'s static members plus every registered post in that room (with whether its parent is live) and every live host (host-<sessionId>) that has joined it. Use this for the authoritative roster instead of inferring presence from stale board history.',
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
                    roomId: { type: 'string', required: true }
                  }
                }
              }
            }
          },
          render: (_args, value) => {
            const memberLine = value.members.length === 0 ? '  (none configured)' : value.members.map((member) => `  - ${member}`).join('\n')
            const postLines = value.posts.map((post) => `  - ${post.postId}${post.parentLive ? ' (live)' : ' (parent offline)'}`)
            const postBlock = postLines.length === 0 ? '  (no registered posts)' : postLines.join('\n')
            const hostLines = value.hosts.map((host) => `  - ${host.hostId} (session ${host.sessionId})`)
            const hostBlock = hostLines.length === 0 ? '  (no live hosts)' : hostLines.join('\n')
            return [{
              type: 'text',
              text: `Room ${value.room} roster:\nStatic members:\n${memberLine}\nRegistered posts:\n${postBlock}\nLive hosts:\n${hostBlock}`
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
            hostsInRoom.push({ hostId: entry.hostId, sessionId: entry.sessionId, roomId: entry.roomId })
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
            const hostId = hostForSession.get(agent.id as string)
            if (hostId !== undefined && hosts.has(hostId)) {
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
