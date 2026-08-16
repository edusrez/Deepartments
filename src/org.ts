// dsh-deepartments — organization service (ROADMAP task 4, batch 1): the
// static board-of-directors architecture.
//
// Per owner decisions 11-12 (docs/concept.md): rooms are PART of the program's
// architecture, defined in the plugin configuration — never created by
// agents. A room is a passive board: an append-only ID-addressable message
// log + per-member read cursors + a structured agenda. This module:
//   1. declares the organization config schema (Schemastery),
//   2. declares the room-state session projection (zod v4) and registers it,
//   3. instantiates one live room session per configured room at boot and
//      emits a `deepartments/room-ready` event per room,
//   4. exports the pure projection fold for later batches (dept_* tools).
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
  org: {
    rooms: RoomConfig[]
    departments: DepartmentConfig[]
  }
}

/**
 * Schemastery configuration for the organization architecture.
 * Annotated `z<any, any>`: arrays of object schemas make the inferred type
 * unnameable in the emitted .d.ts (TS2742, cosmokit `Dict` internals) — the
 * schema is a runtime validator; the compile-time shape is `Config` above.
 */
export const Config: z<any, any> = z.object({
  stateDir: z.string().default('.deepartments'),
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
  }).required()
})

// ---------------------------------------------------------------------------
// Room state: the projection wire types (`deepartments/room`).
// ---------------------------------------------------------------------------

/** Lifecycle states of an agenda item (decision 12). */
export type AgendaStatus = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled'

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
// ---------------------------------------------------------------------------

/** Payload of `deepartments/room-message` (append to the room log). */
export interface RoomMessageEventData {
  id: string
  from: string
  to: string[]
  cc: string[]
  threadId?: string
  kind: string
  text: string
}

/** Payload of `deepartments/agenda-update` (upsert one agenda item). */
export interface AgendaUpdateEventData {
  id: string
  title: string
  owner: string
  status: AgendaStatus
}

/** Payload of `deepartments/room-ready` (boot marker; informational). */
export interface RoomReadyEventData {
  room: {
    id: string
    name: string
    purpose: string
    members: string[]
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'deepartments/room-message': RoomMessageEventData
    'deepartments/agenda-update': AgendaUpdateEventData
    'deepartments/room-ready': RoomReadyEventData
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

/** Bump on any serialized-state/fold-semantics change. */
export const ROOM_PROJECTION_STATE_VERSION = 1

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
 * Pure transition over one committed session event. Deterministic: message
 * timestamps fold from `event.time`, agenda touch cursors from `event.seq`.
 * The writer's own cursor advances when it posts a message (recipient
 * cursors advance when THEY read — Batch 2 read tools).
 */
export function applyRoomEvent(state: RoomState, event: SessionEvent): RoomState {
  if (event.type === 'deepartments/room-message') {
    const data = event.data
    const message: RoomMessage = {
      id: data.id,
      ts: event.time,
      from: data.from,
      to: [...data.to],
      cc: [...data.cc],
      threadId: data.threadId ?? null,
      kind: data.kind,
      text: data.text
    }
    return {
      messages: [...state.messages, message],
      cursors: { ...state.cursors, [data.from]: data.id },
      agenda: state.agenda
    }
  }
  if (event.type === 'deepartments/agenda-update') {
    const data = event.data
    const item: AgendaItem = {
      id: data.id,
      title: data.title,
      owner: data.owner,
      status: data.status,
      cursorOfLastTouch: event.seq
    }
    const index = state.agenda.findIndex((candidate) => candidate.id === data.id)
    const agenda = index < 0
      ? [...state.agenda, item]
      : state.agenda.map((candidate, i) => i === index ? item : candidate)
    return { ...state, agenda }
  }
  // `deepartments/room-ready` and every other event type: no state change.
  // Returning the SAME reference produces zero downstream work.
  return state
}

/** State → wire value. The internal state IS the wire shape. */
export function viewRoomState(state: RoomState): RoomState {
  return state
}

/**
 * Pure fold from an empty log over a list of events — the read helper for
 * later batches (dept_* tools can fold a persisted log without a live
 * session). In-process live reads go through the registry instead:
 * `ctx.sessionProjections.snapshot(session).values['deepartments/room']`.
 */
export function foldRoomState(events: readonly SessionEvent[]): RoomState {
  let state = initRoomState()
  for (const event of events) state = applyRoomEvent(state, event)
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
 *    session seed so the room log survives restarts (decision 10: the
 *    structure persists across sessions).
 * 3. Otherwise (first boot, absent, or unreadable) → fresh empty log.
 *
 * Known rc.6 limitation: the persistence READ path refuses event types
 * outside the harness's build-time catalog unless the writer marks them
 * `ignorable`, and `session.append` exposes no way to set that marker for
 * log-only custom events. The room events therefore persist (write path is
 * open) but a later cold re-read may refuse the log, in which case branch 3
 * starts fresh — the in-process room state stays fully functional.
 */
async function resolveRoomSession(ctx: Context, roomId: string): Promise<Session> {
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
      ctx.logger.info(`[deepartments] room ${roomId}: no readable persisted log (${error instanceof Error ? error.message : String(error)}) — starting a fresh room log`)
    }
  }
  return ctx.sessions.create(id, { meta: { cwd: process.cwd() } })
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
      const session = await resolveRoomSession(ctx, room.id)
      session.append('deepartments/room-ready', {
        room: {
          id: room.id,
          name: room.name,
          purpose: room.purpose,
          members: [...room.members]
        }
      })
      // The cordis logger is exporter-based and never reaches stdout;
      // journald only sees raw stdout (same convention as dsh-smooth-stream
      // and src/index.ts).
      console.log(`[deepartments] room ready: ${room.id}`)
      ctx.logger.info(`[deepartments] room ready: ${room.id}`)
    }
    return () => {}
  }, 'deepartments: room boot')
}
