// dsh-deepartments — dept_invoke + board toolset + wake relay (ROADMAP task 5,
// Batch 2): the Asistente's trip to the board room.
//
// Mechanics (per .dsh/reports/explore-deep/2026-08-16-continuation-mechanics.md,
// verified against @deepseek-ai/dsh-subagent@0.1.0-rc.6):
//   - dept_invoke is ALWAYS async (same shape as src/subagent.ts): it ensures
//     the coordinator post (a continuable child of the Asistente on the
//     'spawn' provider — a FRESH child, own persona, no inherited context),
//     starts a continuable FORK (provider 'fork', inherits the Asistente's
//     completed turns), emits the assignment as an addressed board message,
//     and returns the fork's durable id immediately.
//   - Sibling→sibling messaging does not exist in rc.6: followup() authority
//     is possession of the exact live direct-parent Agent. Both children's
//     durable parent is the Asistente, so the wake relay resolves the live
//     Asistente via ctx.agents.get() and relays every addressed board append
//     as a followup to the addressed child.
//   - registerContinuableSetup installs the board toolset (dept_room_read /
//     dept_room_write / dept_witness_write) into EVERY continuable child,
//     fresh creation AND cold resume (the harness's report-tool pattern).
//   - The settlement notice (subagent-settled) delivers the fork's closing
//     message to the Asistente automatically — the merge-back needs no code.
//
// Documented choices:
//   - Coordinator subagent provider = 'spawn' (constant): the handoff's
//     coordinator.agentOptions.provider ('deepseek-official') names an LLM
//     adapter route, NOT a registered subagent provider (dsh-base registers
//     only spawn/fork — see dsh-base/cordis.patch.yml). agentOptions rides
//     the request as the child's LLM route; spawn gives the department head
//     a fresh context, fork is reserved for the context-inheriting Asistente
//     representative.
//   - Per-member read cursors are an IN-MEMORY map keyed by member id (no
//     'cursor' board record kind: BoardKind is closed by board-store.ts and
//     the room projection fold; expanding it is out of Batch 2 scope).
//     Cursors are therefore lost on process restart — the child re-reads
//     addressed messages it already saw (idempotent).
//   - The wake relay needs the live shared parent (the Asistente): when
//     ctx.agents.get(parentId) is undefined (parent session dormant/ended),
//     the wake is SKIPPED with a warning (documented rc.6 limitation).
//
// NO export default (pitfall 0001 — breaks `inject`).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { emitRoomRecord, roomSessionId, setBoardRecordListener } from './org.js'
import type { Config, CoordinatorConfig, RoomState } from './org.js'
import { loadRecords, resolveBoardPath } from './board-store.js'
import type { BoardRecord } from './board-store.js'

/** Subagent provider for the coordinator post: the fresh-child provider. */
const COORDINATOR_SUBAGENT_PROVIDER = 'spawn'

/** Post id prefix of the Asistente fork registry entries. */
const FORK_POST_PREFIX = 'asistente-fork-'

/** One durable post registry entry. */
interface PostEntry {
  postId: string
  childId: string
  parentId: string
  roomId: string
  provider: string
}

/** Compact per-member read cursors (in-memory — see header comment). */
interface CursorState {
  /** Last addressed message id the member has seen. */
  lastMessageId: string | undefined
  /** Last agenda touch seq (board FILE seq) the member has seen. */
  lastAgendaSeq: number
}

/**
 * Format one addressed message for the model-facing delta (compact).
 */
function formatDeltaMessage(message: RoomState['messages'][number]): string {
  const text = message.text.length > 240 ? `${message.text.slice(0, 240)}…` : message.text
  return `- ${message.from} → ${message.to.join(', ') || '(all)'}: ${text}`
}

/**
 * Format one agenda item for the model-facing delta (compact).
 */
function formatDeltaAgenda(item: RoomState['agenda'][number]): string {
  return `- agenda "${item.title}" (${item.status}, owner ${item.owner})`
}

/** Truncate a delta to a bounded, model-friendly digest. */
function digestDelta(lines: string[], cap = 10): string {
  if (lines.length <= cap) return lines.join('\n')
  return `${lines.slice(0, cap).join('\n')}\n… (${lines.length - cap} more entries; read again to continue)`
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
  const coordinatorInFlight = new Map<string, Promise<string>>()
  const postsPath = path.join(config.stateDir, 'posts.json')

  const persistPosts = () => {
    const data: Record<string, Omit<PostEntry, 'postId'>> = {}
    for (const entry of byPost.values()) data[entry.postId] = { childId: entry.childId, parentId: entry.parentId, roomId: entry.roomId, provider: entry.provider }
    writeFile(postsPath, JSON.stringify(data, null, 2), 'utf8').catch((error: unknown) => {
      ctx.logger.warn(`[deepartments] posts.json write failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const registerEntry = (entry: PostEntry) => {
    byPost.set(entry.postId, entry)
    byChild.set(entry.childId, entry.postId)
    persistPosts()
  }

  const postIdForChild = (childId: string): string | undefined => byChild.get(childId)

  const anyParentId = (): string | undefined => {
    for (const entry of byPost.values()) return entry.parentId
    return undefined
  }

  // Best-effort cold load of the post registry (entries whose parent session
  // is not live stay dormant until that parent resumes — documented).
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
   * The wake relay (plugin-side): after every board append (the org hook),
   * wake each addressed member whose post has a known child — via the live
   * shared direct parent (the Asistente). Self-wakes and echo loops are
   * excluded (sender skipped); unknown members and non-live parents are
   * skipped (the latter with a warning — documented rc.6 limitation).
   */
  const relay = (record: BoardRecord, roomId: string) => {
    if (record.kind !== 'message' || agents === void 0 || subagents === void 0) return
    for (const member of record.to) {
      if (member === record.from) continue
      const entry = byPost.get(member)
      if (entry === void 0) continue
      const parentAgent = agents.get(SessionId(entry.parentId))
      if (parentAgent === void 0) {
        ctx.logger.warn(`[deepartments] wake skipped for "${member}": parent session "${entry.parentId}" is not live (the relay needs the live shared parent — rc.6 limitation)`)
        continue
      }
      const senderSession = byPost.get(record.from)?.childId ?? (record.from === 'asistente' ? anyParentId() : record.from) ?? record.from
      const content = [{
        type: 'text',
        text: `Board delta in ${roomId}: ${record.from} → you: "${record.payload.text.slice(0, 200)}". Read your new messages with dept_room_read and reply with dept_room_write addressed to the sender of the latest message.`
      } as const]
      const source = {
        kind: 'coordinator',
        form: 'relay',
        senderSessionId: SessionId(senderSession)
      } as const
      subagents.followup(parentAgent, SessionId(entry.childId), content, {
        source,
        signal: new AbortController().signal
      }).catch((error: unknown) => {
        ctx.logger.warn(`[deepartments] wake relay to "${member}" failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
  const removeListener = setBoardRecordListener(relay)
  ctx.effect(() => removeListener, 'deepartments: board record listener')

  // --- child toolset (installed into EVERY continuable child) -----------------

  if (subagents === void 0) {
    ctx.logger.warn('[deepartments] subagents service absent: the board toolset will not be installed into continuable children and dept_invoke will fail at call time')
  } else {
    subagents.registerContinuableSetup((childCtx) => {
    const disposeRead = childCtx.tools.register(defineTool({
      name: 'dept_room_read',
      description: 'Read this agent\'s new board messages in one room: the delta of messages addressed to you (or sent by you) plus agenda updates since your last read. Pass the room id (e.g. "board").',
      parameters: {
        room: { type: 'string', required: true, description: 'Room id to read (e.g. "board").' }
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
        const memberId = postIdForChild(agent.id as string) ?? 'unknown'
        const session = ctx.sessions.get(SessionId(roomSessionId(args.room)))
        if (session === void 0) throw new Error(`[deepartments] room "${args.room}" is not live (no session)`)
        const cursor = memberCursors.get(memberId) ?? { lastMessageId: undefined, lastAgendaSeq: -1 }
        const snapshot = ctx.sessionProjections.snapshot(session)
        const state = snapshot.values['deepartments/room'] as RoomState | undefined
        const lines: string[] = []
        if (state === void 0) {
          // Projection unit absent (should not happen): serve nothing.
          return { room: args.room, member: memberId, delta: 'No board messages addressed to you.' }
        }
        const start = cursor.lastMessageId === void 0 ? 0 : state.messages.findIndex((message) => message.id === cursor.lastMessageId) + 1
        const addressed = state.messages
          .slice(Math.max(start, 0))
          .filter((message) => message.to.includes(memberId) || message.from === memberId)
        const agenda = state.agenda.filter((item) => item.cursorOfLastTouch > cursor.lastAgendaSeq)
        for (const message of addressed) lines.push(formatDeltaMessage(message))
        for (const item of agenda) lines.push(formatDeltaAgenda(item))
        if (addressed.length > 0) cursor.lastMessageId = addressed[addressed.length - 1].id
        let maxAgendaSeq = -1
        for (const item of agenda) if (item.cursorOfLastTouch > maxAgendaSeq) maxAgendaSeq = item.cursorOfLastTouch
        if (maxAgendaSeq >= 0) cursor.lastAgendaSeq = maxAgendaSeq
        memberCursors.set(memberId, cursor)
        const delta = lines.length === 0 ? 'No board messages addressed to you.' : `Board delta (room ${args.room}) for ${memberId}:\n${digestDelta(lines)}`
        return { room: args.room, member: memberId, delta }
      }
    }))

    const disposeWrite = childCtx.tools.register(defineTool({
      name: 'dept_room_write',
      description: 'Post an addressed message to one board room. The message is recorded from your board member id; addressed recipients are woken to read it.',
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
        const memberId = postIdForChild(agent.id as string) ?? 'unknown'
        const { record } = await emitBoardMessage(args.room, memberId, [...args.to], args.text)
        return { room: args.room, from: memberId, to: [...args.to], messageId: record.id }
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

    return () => {
      disposeRead()
      disposeWrite()
      disposeWitness()
    }
  })
  }

  // --- dept_invoke tool (Asistente side; ALWAYS async) -------------------------

  ctx.tools.register(defineTool({
    name: 'dept_invoke',
    description: 'Send the Asistente to the board room: spawn a continuable representative (fork) that inherits this conversation, ensure the research coordinator post is awake, and post the assignment to the board. The fork converses with the coordinator through the board; when it settles, the runtime delivers its final report back to you automatically. Returns the fork\'s durable id immediately — never blocks.',
    parameters: {
      room: {
        type: 'string',
        required: true,
        description: 'Room id for the board conversation (use "board" for the board-of-directors room).'
      },
      assignment: {
        type: 'string',
        required: true,
        description: 'The assignment message for the research coordinator (what the owner wants answered).'
      },
      threadId: {
        type: 'string',
        description: 'Optional thread id grouping this assignment with related board messages.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'continuable' },
          subagentId: { type: 'string', required: true },
          roomId: { type: 'string', required: true },
          messageId: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `dept_invoke: fork ${value.subagentId} is on the board (${value.roomId}); assignment posted as ${value.messageId}. Its final report will reach you automatically.` } as const]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<{ kind: 'continuable'; subagentId: string; roomId: string; messageId: string }> {
      const parent = exec.agent
      if (!parent) throw new Error('dept_invoke requires a calling agent (exec.agent was undefined)')
      if (subagents === void 0) throw new Error('[deepartments] dept_invoke requires the subagents service (mount @deepseek-ai/dsh-subagent)')
      await registryLoaded
      const room = config.org.rooms.find((candidate) => candidate.id === args.room)
      if (room === void 0) throw new Error(`[deepartments] dept_invoke: room "${args.room}" is not configured — rooms: ${config.org.departments.map((department) => department.roomId).join(', ') || '(none)'}`)
      // The coordinator post spec: the department whose coordinator answers in
      // this room, else the first configured coordinator (MVP: one).
      const department = config.org.departments.find((candidate) => candidate.roomId === args.room && candidate.coordinator !== void 0)
        ?? config.org.departments.find((candidate) => candidate.coordinator !== void 0)
      const coordinator: CoordinatorConfig | undefined = department?.coordinator
      if (coordinator === void 0) throw new Error('[deepartments] dept_invoke: no coordinator post configured in org.departments')

      // 1. Ensure the coordinator post (create once per registry; reuse after).
      let coordinatorChildId = byPost.get(coordinator.postId)?.childId
      if (coordinatorChildId === void 0) {
        const inflight = coordinatorInFlight.get(coordinator.postId)
        if (inflight !== void 0) coordinatorChildId = await inflight
        else {
          const creation = (async (): Promise<string> => {
            const coordinatorRoomId = department?.roomId ?? args.room
            const llmProvider = coordinator.agentOptions?.provider ?? coordinator.provider
            const childId = (await subagents.startContinuable({
              provider: COORDINATOR_SUBAGENT_PROVIDER,
              label: coordinator.postId,
              request: {
                prompt: [{
                  type: 'text',
                  text: `You are the Research department head in the Deepartments organization. You receive assignments as board messages addressed to you and reply on the board. Use dept_room_read (room "${args.room}") to read your new board messages and dept_room_write (room "${args.room}") to post your replies, addressed to the sender of the latest message you received. If your board delta is empty, stop and wait — you will be woken when a message for you arrives. Be concise.`
                } as const],
                parent,
                ...coordinator.role !== void 0 ? { persona: coordinator.role } : {},
                ...coordinator.agentOptions !== void 0 ? { agentOptions: { ...coordinator.agentOptions, ...llmProvider !== void 0 ? { provider: llmProvider } : {} } } : {}
              },
              signal: exec.signal
            })).childId as string
            registerEntry({
              postId: coordinator.postId,
              childId,
              parentId: parent.id as string,
              roomId: coordinatorRoomId,
              provider: COORDINATOR_SUBAGENT_PROVIDER
            })
            ctx.logger.info(`[deepartments] coordinator post "${coordinator.postId}" established: child ${childId} (parent ${parent.id as string})`)
            return childId
          })()
          coordinatorInFlight.set(coordinator.postId, creation)
          try {
            coordinatorChildId = await creation
          } finally {
            coordinatorInFlight.delete(coordinator.postId)
          }
        }
      }

      // 2. Start the fork: the Asistente's continuable representative.
      const forkProvider = config.forkProvider ?? 'fork'
      const forkChildId = (await subagents.startContinuable({
        provider: forkProvider,
        label: 'asistente-fork',
        request: {
          prompt: [{
            type: 'text',
            text: `You are the Asistente's representative in the board-of-directors room "${args.room}". Read your board delta with dept_room_read. Drive the conversation with the research coordinator (board member "${coordinator.postId}") to answer the owner's assignment: ${args.assignment} Post addressed messages with dept_room_write (room "${args.room}", to ["${coordinator.postId}"]); wait for the coordinator's replies (you will be woken when they arrive). If you have no new delta, post your next question or the assignment itself to "${coordinator.postId}" rather than going silent. When the assignment is satisfied, write your relevo witness with dept_witness_write and CONCLUDE with the final merged report as your message.`
          } as const],
          parent
        },
        signal: exec.signal
      })).childId as string
      const forkPostId = `${FORK_POST_PREFIX}${forkChildId}`
      registerEntry({
        postId: forkPostId,
        childId: forkChildId,
        parentId: parent.id as string,
        roomId: args.room,
        provider: forkProvider
      })

      // 3. Emit the assignment to the board (the wake relay wakes the
      //    coordinator). Never block: the fork and coordinator run on their own.
      const { record } = await emitBoardMessage(args.room, 'asistente', [coordinator.postId], args.assignment, args.threadId ?? null)

      return { kind: 'continuable', subagentId: forkChildId, roomId: args.room, messageId: record.id }
    }
  }))
}
