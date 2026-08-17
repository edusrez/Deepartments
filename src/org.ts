// dsh-deepartments — organization service (ROADMAP task 4, batches 1/1.5):
// the static board-of-directors architecture.
//
// Per owner decisions 11-12 (docs/concept.md): rooms are PART of the program's
// architecture, defined in the plugin configuration — never created by
// agents. A room is a passive board: an append-only ID-addressable message
// log + per-member read cursors + a structured agenda. This module:
//   1. declares the organization config schema (Schemastery),
//   2. declares the room-state session projection (zod v4) and registers it,
//   3. instantiates one live room session per configured room at boot,
//      seeds it from the room's board file (decision 17: the file is the
//      cold source of truth) and emits a `deepartments/room-ready` record
//      mirrored into the file,
//   4. exports the pure record fold for later batches (dept_* tools).
//
// Coordinator posts are NOT created at runtime yet (Batch 2: dept_invoke) —
// only their spec is declared in config.
//
// NO export default (pitfall 0001 — breaks `inject`).
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { appendRecord, boardEventType, loadRecords, resolveBoardPath } from './board-store.js'
import type { AgendaStatus, BoardRecord } from './board-store.js'
import type { WebFetchConfig } from './webfetch.js'
export type { AgendaStatus, BoardKind, BoardRecord } from './board-store.js'

// ---------------------------------------------------------------------------
// Config schema (Schemastery, same pattern as src/subagent.ts). The
// cordis.patch.yml `deepartments` row's `config` is validated against this
// schema at boot; required fields are `.required()`.
// ---------------------------------------------------------------------------

/** One configured room: a passive board with a stable session id. */
export interface RoomConfig {
  id: string
  name: string
  purpose: string
  members: string[]
}

/** The post spec of a department's coordinator (created in Batch 2). */
export interface CoordinatorConfig {
  postId: string
  role: string
  provider?: string
  agentOptions?: { provider?: string; model?: string; maxTokens?: number }
}

/** One department: a room + the spec of its coordinator post. */
export interface DepartmentConfig {
  id: string
  name: string
  roomId: string
  coordinator?: CoordinatorConfig
}

/** Plugin config: workspace state dir + the static organization structure. */
export interface Config {
  stateDir: string
  /**
   * Subagent provider name for the Asistente fork spawned by dept_invoke
   * (default 'fork' — the context-inheriting provider). The coordinator post
   * always uses 'spawn' (fresh child, no inherited context).
   */
  forkProvider?: string
  org: {
    rooms: RoomConfig[]
    departments: DepartmentConfig[]
  }
  /**
   * Custom `ctx.web` fetch provider config (blocking detection).
   * Optional; defaults are applied in src/webfetch.ts.
   */
  webfetch?: WebFetchConfig
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
    rooms: z.array(z.object({
      id: z.string().required(),
      name: z.string().default(''),
      purpose: z.string().default(''),
      members: z.array(z.string()).default([])
    })).default([]),
    departments: z.array(z.object({
      id: z.string().required(),
      name: z.string().default(''),
      roomId: z.string().required(),
      coordinator: z.object({
        postId: z.string().required(),
        role: z.string().default(''),
        provider: z.string(),
        agentOptions: z.object({
          provider: z.string(),
          model: z.string(),
          maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
        }).default(void 0 as unknown as { provider: string; model: string; maxTokens: number })
      }).default(void 0 as unknown as { postId: string; role: string; provider: string; agentOptions: { provider: string; model: string; maxTokens: number } })
    })).default([])
  }).required(),
  webfetch: z.object({
    enabled: z.boolean(),
    userAgent: z.string(),
    accept: z.string(),
    maxUrlLength: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    maxResponseBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    maxRedirects: z.number().step(1).min(0).max(100).default(5)
  }).default(void 0 as unknown as {
    enabled: boolean
    userAgent: string
    accept: string
    maxUrlLength: number
    timeoutMs: number
    maxResponseBytes: number
    maxRedirects: number
  })
})

// ---------------------------------------------------------------------------
// Room state: the projection wire types (`deepartments/room`).
// ---------------------------------------------------------------------------

/** One addressed envelope on the room's append-only log. */
export interface RoomMessage {
  id: string
  /** Epoch ms, folded from the carrying event's `time`. */
  ts: number
  from: string
  to: string[]
  cc: string[]
  threadId: string | null
  kind: string
  text: string
}

/** One structured agenda item (owner, lifecycle state, cursor-of-last-touch). */
export interface AgendaItem {
  id: string
  title: string
  owner: string
  status: AgendaStatus
  /** Seq of the last event that touched this item. */
  cursorOfLastTouch: number
}

/** Whole current room state — the `deepartments/room` projection value. */
export interface RoomState {
  messages: RoomMessage[]
  /** Per-member read cursor: memberId → last message id the member has seen. */
  cursors: Record<string, string>
  agenda: AgendaItem[]
}

// ---------------------------------------------------------------------------
// Session event types (log-only, never surface events — no surface opts).
// The payload of every deepartments/* event is the BOARD RECORD it mirrors
// into the board file — one wire shape, one fold (decision 17).
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'deepartments/room-message': BoardRecord
    'deepartments/agenda-update': BoardRecord
    'deepartments/room-ready': BoardRecord
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Whole current room state (messages, cursors, agenda). */
    'deepartments/room': RoomState
  }
}

// ---------------------------------------------------------------------------
// Projection unit: pure, synchronous, deterministic. Same state reference
// for uninterested events (the registry's zero-work contract).
// ---------------------------------------------------------------------------

export const ROOM_PROJECTION_KEY = 'deepartments/room'

/**
 * Bump on any serialized-state/fold-semantics change. Batch 1.5: records now
 * carry their own seq/ts and the fold derives everything from the record
 * (cursorOfLastTouch references the FILE seq — board-store.ts).
 */
export const ROOM_PROJECTION_STATE_VERSION = 2

const agendaStatusSchema = zod.enum(['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'])

const roomMessageSchema = zod.object({
  id: zod.string(),
  ts: zod.number().int().nonnegative(),
  from: zod.string(),
  to: zod.array(zod.string()),
  cc: zod.array(zod.string()),
  threadId: zod.string().nullable(),
  kind: zod.string(),
  text: zod.string()
}).strict()

const agendaItemSchema = zod.object({
  id: zod.string(),
  title: zod.string(),
  owner: zod.string(),
  status: agendaStatusSchema,
  cursorOfLastTouch: zod.number().int().nonnegative()
}).strict()

/** Validates the wire payload before it leaves the projection registry. */
export const ROOM_PROJECTION_SCHEMA: zod.ZodType<RoomState> = zod.object({
  messages: zod.array(roomMessageSchema),
  cursors: zod.record(zod.string(), zod.string()),
  agenda: zod.array(agendaItemSchema)
}).strict()

/** State for the empty log. */
export function initRoomState(): RoomState {
  return { messages: [], cursors: {}, agenda: [] }
}

/**
 * THE pure transition — ONE function shared by the board-file initialization
 * and the live session events (decision 17). Deterministic: message
 * timestamps fold from `record.ts`, agenda touch cursors from `record.seq`
 * (the FILE seq — never the session envelope seq, see board-store.ts). The
 * writer's own cursor advances when it posts a message (recipient cursors
 * advance when THEY read — Batch 2 read tools). Uninterested input (ready
 * markers, unknown kinds) returns the SAME state reference.
 */
export function foldRoomRecord(state: RoomState, record: BoardRecord): RoomState {
  if (record.kind === 'message') {
    const payload = record.payload
    const message: RoomMessage = {
      id: record.id,
      ts: record.ts,
      from: record.from,
      to: [...record.to],
      cc: [...record.cc],
      threadId: record.threadId,
      kind: payload.kind,
      text: payload.text
    }
    return {
      messages: [...state.messages, message],
      cursors: { ...state.cursors, [record.from]: record.id },
      agenda: state.agenda
    }
  }
  if (record.kind === 'agenda') {
    const payload = record.payload
    const item: AgendaItem = {
      id: record.id,
      title: payload.title,
      owner: payload.owner,
      status: payload.status,
      cursorOfLastTouch: record.seq
    }
    const index = state.agenda.findIndex((candidate) => candidate.id === record.id)
    const agenda = index < 0
      ? [...state.agenda, item]
      : state.agenda.map((candidate, i) => i === index ? item : candidate)
    return { ...state, agenda }
  }
  // `ready` and anything else: no state change. Returning the SAME reference
  // produces zero downstream work (the registry's zero-work contract).
  return state
}

/**
 * Projection transition over one committed session event. `apply` folds LIVE
 * session events only and is PURE — no file I/O (rule 4 hygiene: the emit
 * site mirrors into the board file, never the fold). The file history enters
 * the cell through the session's constructor seed (resolveRoomSession), which
 * the registry folds exactly once — never re-folded on load (anti-double-count).
 */
export function applyRoomEvent(state: RoomState, event: SessionEvent): RoomState {
  switch (event.type) {
    case 'deepartments/room-message':
    case 'deepartments/agenda-update':
    case 'deepartments/room-ready':
      return foldRoomRecord(state, event.data as unknown as BoardRecord)
    default:
      return state
  }
}

/** State → wire value. The internal state IS the wire shape. */
export function viewRoomState(state: RoomState): RoomState {
  return state
}

/**
 * Pure fold from an empty log over a list of session events — the read
 * helper for in-process reads of a session log without a live registry.
 */
export function foldRoomState(events: readonly SessionEvent[]): RoomState {
  let state = initRoomState()
  for (const event of events) state = applyRoomEvent(state, event)
  return state
}

/**
 * Pure fold from an empty log over board-file records — the cold-restart
 * read helper (decision 17: the file is the cold source of truth).
 */
export function foldRoomRecords(records: readonly BoardRecord[]): RoomState {
  let state = initRoomState()
  for (const record of records) state = foldRoomRecord(state, record)
  return state
}

/** The registered unit: pure mathematics, driven by the framework. */
export const roomProjection: ProjectionDefinition<'deepartments/room', RoomState> = {
  key: ROOM_PROJECTION_KEY,
  schema: ROOM_PROJECTION_SCHEMA,
  init: initRoomState,
  apply: applyRoomEvent,
  view: viewRoomState,
  stateVersion: ROOM_PROJECTION_STATE_VERSION
}

// ---------------------------------------------------------------------------
// Boot instantiation.
// ---------------------------------------------------------------------------

/** Stable session id for one configured room (single path segment). */
export function roomSessionId(roomId: string): string {
  return `deepartments-room-${roomId}`
}

/**
 * Loose structural view of `ctx.sessionPersistence` (optional service) —
 * avoids a hard devDependency on the persistence package for this one call.
 */
interface PersistenceLike {
  inspect(id: Session['id']): Promise<{ meta: { cwd?: string }; events: readonly SessionEvent[] }>
}

/**
 * Resolve the room's live session at boot.
 *
 * 1. Already live in this process → reuse it.
 * 2. A readable persisted log exists (previous boot) → replay it as the
 *    session seed (decision 10: the structure persists across sessions).
 * 3. Otherwise (first boot, absent, or unreadable) → fresh log SEEDED FROM
 *    THE BOARD FILE (decision 17: the file is the cold source of truth, and
 *    rc.6 refuses cold reads of the stored room log — see below).
 *
 * Anti-double-count: the seed comes from exactly ONE source per boot (the
 * stored log in branch 2, the board file in branch 3) — never both. The
 * projection cell folds the seed exactly once (constructor seeds do not
 * emit `session/event`), and live events fold on top in `apply`.
 *
 * Known rc.6 limitation: the persistence READ path refuses event types
 * outside the harness's build-time catalog unless the writer marks them
 * `ignorable`, and `session.append` exposes no way to set that marker for
 * log-only custom events. The room events therefore persist (write path is
 * open) but a later cold re-read may refuse the log, in which case branch 3
 * starts from the board file instead.
 */
async function resolveRoomSession(ctx: Context, roomId: string, records: readonly BoardRecord[]): Promise<Session> {
  const id = SessionId(roomSessionId(roomId))
  const live = ctx.sessions.get(id)
  if (live !== void 0) return live
  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
  if (persistence !== void 0) {
    try {
      const stored = await persistence.inspect(id)
      return ctx.sessions.create(id, {
        seed: stored.events,
        meta: stored.meta.cwd === void 0 ? {} : { cwd: stored.meta.cwd }
      })
    } catch (error) {
      ctx.logger.info(`[deepartments] room ${roomId}: no readable persisted log (${error instanceof Error ? error.message : String(error)}) — starting from the board file`)
    }
  }
  try {
    return ctx.sessions.create(id, {
      seed: recordsToSeedEvents(records),
      meta: { cwd: process.cwd() }
    })
  } catch (error) {
    // Malformed/renumbered seed (e.g. a hand-edited file): fail loud at boot
    // but keep the room functional in-memory; the file is still intact.
    ctx.logger.info(`[deepartments] room ${roomId}: board file replay failed (${error instanceof Error ? error.message : String(error)}) — starting an empty room log`)
    return ctx.sessions.create(id, { meta: { cwd: process.cwd() } })
  }
}

/**
 * Board records → session constructor seed. The harness's seed contiguity
 * contract (envelope seq === index, 0-based) holds directly because the
 * board file seq IS the record index (board-store.ts). The harness then
 * appends its own `session/end-seed` marker, which is why the session's
 * envelope seqs drift +1 from file seqs on resumed boots — folds never read
 * the envelope seq; the record carries its own.
 */
function recordsToSeedEvents(records: readonly BoardRecord[]): SessionEvent[] {
  return records.map((record) => ({
    type: boardEventType(record.kind),
    seq: record.seq,
    time: record.ts,
    data: record
  }) as SessionEvent)
}

/**
 * Board-append listener (the wake relay of src/invoke.ts): called with the
 * appended record and the room id, AFTER the session append and the file
 * mirror. org.ts stays ignorant of followup logic — it only exposes the hook
 * (Batch 2 handoff). The listener set is module-level mutable state, a
 * deliberate exception to rule 4 prescribed by the handoff: listeners are
 * registered through `setBoardRecordListener`, which returns a disposer the
 * invoke service owns as a reversible effect.
 */
export type BoardRecordListener = (record: BoardRecord, roomId: string) => void

const boardRecordListeners = new Set<BoardRecordListener>()

/**
 * Register a listener for every appended board record. Returns the disposer
 * (reversible; call it to stop receiving notifications).
 */
export function setBoardRecordListener(listener: BoardRecordListener): () => void {
  boardRecordListeners.add(listener)
  return () => {
    boardRecordListeners.delete(listener)
  }
}

/**
 * THE emit site for every board record: append it to the live room session
 * (live signal) and mirror the SAME record into the board file (cold truth)
 * immediately after. The file is the durable copy on rc.6; the session
 * append carries the same bytes for live consumers and the projection.
 * Batch 2 message/agenda emitters MUST go through this helper.
 *
 * Listener order (Batch 2 handoff): session append → file append → board
 * record listeners (the wake relay must only fire once the durable mirror
 * exists).
 */
export async function emitRoomRecord(session: Session, filePath: string, record: BoardRecord, roomId: string): Promise<void> {
  session.append(boardEventType(record.kind), record)
  await appendRecord(filePath, record)
  for (const listener of boardRecordListeners) listener(record, roomId)
}

/**
 * Install the organization service: register the room projection and
 * instantiate every configured room at boot (reversible — the returned
 * effect's disposer is a no-op because the created sessions are owned by
 * the calling fiber, which removes them on unload).
 */
export function applyOrg(ctx: Context, config: Config) {
  ctx.sessionProjections.register(roomProjection)

  ctx.effect(async () => {
    for (const room of config.org.rooms) {
      const filePath = resolveBoardPath(config.stateDir, room.id)
      // Decision 17: the board file is the cold source of truth — load it
      // (empty/missing → empty history), seed the live session from it, then
      // mirror this boot's room-ready record into it. Seq = last file seq + 1
      // (0 for an empty file).
      const records = await loadRecords(filePath)
      const session = await resolveRoomSession(ctx, room.id, records)
      const seq = records.length === 0 ? 0 : records[records.length - 1].seq + 1
      const record: BoardRecord = {
        id: `ready-${room.id}-${seq}`,
        seq,
        ts: Date.now(),
        from: 'system',
        to: [...room.members],
        cc: [],
        threadId: null,
        kind: 'ready',
        payload: {
          room: {
            id: room.id,
            name: room.name,
            purpose: room.purpose,
            members: [...room.members]
          }
        }
      }
      await emitRoomRecord(session, filePath, record, room.id)
      // The cordis logger is exporter-based and never reaches stdout;
      // journald only sees raw stdout (same convention as dsh-smooth-stream
      // and src/index.ts).
      console.log(`[deepartments] room ready: ${room.id}`)
      ctx.logger.info(`[deepartments] room ready: ${room.id}`)
    }
    return () => {}
  }, 'deepartments: room boot')
}
