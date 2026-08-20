// dsh-deepartments — pure agent-row status computation for the "main agents
// sidebar" RPC channel (server half, src/invoke.ts). This module is PURE and
// side-effect free (no I/O, no imports that carry runtime side effects): it
// maps a department coordinator config + a post registry + injected live
// signals into one AgentRow per department, so the precedence rules are
// directly testable via node --test without booting DSH.
//
// The row status precedence (see computeHeadStatus):
//   sleeping (sleepEpoch set) → completed-notice (unread addressed-to-host
//   message > 0) → working (live session running) → idle (everything else,
//   including a not-live session — the safe fallback).
//
// New model (Batch 1b, after the root-agent pivot of Batch 1a): a department
// head is a FIRST-CLASS ROOT AGENT keyed by a STABLE session id
// `head-<postId>` (no parent/owner). So the registry view here drops the old
// continuable-subagent `childId`/`parentId` semantics entirely: a head is
// identified by `sessionId`, and the only live resolver a head needs is
// `sessionLive(sessionId)` (+ optional `sessionRunning`) — there is no parent
// to be live for. `completed-notice` is KEPT for heads: it is driven by
// `unreadFor(postId)` (board messages addressed to the caller host from this
// head), a host-facing signal that is independent of how the head is
// materialized, so the row still tells the owner "this head has something for
// you". It does not require a parent.
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { DepartmentConfig } from './org.js'

/** The coarse life-cycle status of one department-head agent row. */
export type HeadStatus = 'sleeping' | 'completed-notice' | 'working' | 'idle'

/**
 * Loose structural view of one durable post-registry entry (see PostEntry in
 * src/invoke.ts, which is NOT exported and carries runtime-heavy imports).
 * Defined locally so this module stays pure and import-light — only the fields
 * buildAgentRows needs are declared.
 *
 * Batch 1b: keyed by the head's STABLE root-agent `sessionId` (`head-<postId>`).
 * The legacy continuable-subagent `childId`/`parentId` are gone — a root head
 * has no parent. `provider` is dropped too (the 'head' marker lived only on
 * the legacy mirror; the registry marks configured heads via `agentPreset` in
 * invoke.ts, which this module does not need to read).
 */
export interface PostEntryLike {
  postId: string
  /** The head's stable root-agent session id (`head-<postId>`): the wake /
   * resume / dispose identity. */
  sessionId: string
  roomId: string
  /** Batch G: set when the head SLEPT (next wake cold-resumes a fresh
   * incarnation). Absent = never slept. */
  sleepEpoch?: number
  /** Batch G: the sessionId of the PREVIOUS incarnation (trace marker). */
  previousChildId?: string
}

/** One row in the client sidebar's "main agents" / department-heads list. */
export interface AgentRow {
  /** Post id (the durable board member id), e.g. 'research-head'. */
  id: string
  /** The head's STABLE root-agent session id (`head-<postId>`) — the OPENABLE
   * native session the client opens on click. Deterministic even when the head
   * has no registry entry yet (`head-<postId>`). Added in Batch 4a so the
   * sidebar click opens the session natively. */
  sessionId: string
  /** Display label: coordinator.title || coordinator.role || postId. */
  name: string
  /** Department display name (config.org.departments[].name). */
  department: string
  kind: 'post'
  /** Life-cycle status — see HeadStatus. */
  status: HeadStatus
  /** Count of unread board messages addressed to the caller host from this head. */
  unread: number
  /** Raw live signal: the head's agent session is live AND running. */
  running: boolean
  /** Durable marker: the head has a sleepEpoch set (slept → next wake is fresh). */
  sleeping: boolean
  /** Live signal: the head's agent session is currently present (agents.get
   * defined) in the registry. */
  sessionLive: boolean
}

/**
 * The precedence that turns raw signals into a display status. A not-live (or
 * missing) session has `running: false` and simply falls through to the safe
 * `idle` default — exactly like a live-but-idle head. Heads are root agents
 * with NO parent, so there is no parent-liveness input anymore.
 */
export function computeHeadStatus(input: {
  sleeping: boolean
  unread: number
  running: boolean
}): HeadStatus {
  if (input.sleeping) return 'sleeping'
  if (input.unread > 0) return 'completed-notice'
  if (input.running) return 'working'
  return 'idle'
}

/**
 * Build one AgentRow per configured department, in config order. Live signals
 * (sessionLive/sessionRunning/unread) are INJECTED as functions so this stays
 * pure and testable; the caller (src/invoke.ts RPC handler) wires them to the
 * live registries.
 *
 * A department whose coordinator post has never been spawned (no registry
 * entry) still gets a row — status 'idle', no activity signals — because the
 * head exists in config and the sidebar must show it.
 *
 * A head is identified by its STABLE `sessionId` (`head-<postId>`), not a
 * childId — it is its own root agent. `sessionRunning` is OPTIONAL: when
 * omitted, any live session counts as running; when provided it refines
 * `running` to only a live-and-running session (status 'running').
 */
export function buildAgentRows(args: {
  departments: DepartmentConfig[]
  posts: Map<string, PostEntryLike>
  /** Live signal: the head's session is present in the agents registry. */
  sessionLive: (sessionId: string) => boolean
  /** Optional refinement: the head's session is currently running (status). */
  sessionRunning?: (sessionId: string) => boolean
  unreadFor: (postId: string) => number
  sessionId?: string
}): AgentRow[] {
  const rows: AgentRow[] = []
  for (const department of args.departments) {
    const coordinator = department.coordinator
    // A department with no coordinator spec cannot yield an agent row (there is
    // no postId to identify the head); skip it. All configured departments in
    // cordis.patch.yml declare a coordinator.
    if (coordinator === undefined) continue
    const postId = coordinator.postId
    const name = coordinator.title || coordinator.role || postId
    const entry = args.posts.get(postId)
    if (entry === undefined) {
      // Configured head that has never been spawned/resumed this boot — no
      // live signals. The safe default is idle.
      rows.push({
        id: postId,
        sessionId: `head-${postId}`,
        name,
        department: department.name,
        kind: 'post',
        status: 'idle',
        unread: 0,
        running: false,
        sleeping: false,
        sessionLive: false
      })
      continue
    }
    const sessionLive = args.sessionLive(entry.sessionId)
    const running = args.sessionRunning !== undefined ? args.sessionRunning(entry.sessionId) : sessionLive
    const sleeping = entry.sleepEpoch !== undefined
    rows.push({
      id: postId,
      sessionId: entry.sessionId,
      name,
      department: department.name,
      kind: 'post',
      status: computeHeadStatus({ sleeping, unread: args.unreadFor(postId), running }),
      unread: args.unreadFor(postId),
      running,
      sleeping,
      sessionLive
    })
  }
  return rows
}
