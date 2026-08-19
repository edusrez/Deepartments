// dsh-deepartments — pure agent-row status computation for the "main agents
// sidebar" RPC channel (server half, src/invoke.ts). This module is PURE and
// side-effect free (no I/O, no imports that carry runtime side effects): it
// maps a department coordinator config + a post registry + injected live
// signals into one AgentRow per department, so the precedence rules are
// directly testable via node --test without booting DSH.
//
// The row status precedence (see computeHeadStatus):
//   sleeping (sleepEpoch set) → completed-notice (unread addressed-to-host
//   message > 0) → working (live agent running) → napping (everything else,
//   including a missing/not-live parent — the safe fallback).
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { DepartmentConfig } from './org.js'

/** The coarse life-cycle status of one department-head agent row. */
export type HeadStatus = 'sleeping' | 'completed-notice' | 'working' | 'napping'

/**
 * Loose structural view of one durable post-registry entry (see PostEntry in
 * src/invoke.ts, which is NOT exported and carries runtime-heavy imports).
 * Defined locally so this module stays pure and import-light — only the fields
 * buildAgentRows needs are declared.
 */
export interface PostEntryLike {
  postId: string
  childId: string
  parentId: string
  roomId: string
  provider: string
  sleepEpoch?: number
  previousChildId?: string
}

/** One row in the client sidebar's "main agents" / department-heads list. */
export interface AgentRow {
  /** Post id (the durable board member id), e.g. 'research-head'. */
  id: string
  /** Display label: coordinator.title || coordinator.role || postId. */
  name: string
  /** Department display name (config.org.departments[].name). */
  department: string
  kind: 'post'
  /** Life-cycle status — see HeadStatus. */
  status: HeadStatus
  /** Count of unread board messages addressed to the caller host from this head. */
  unread: number
  /** Raw live signal: the head's agent session is currently running. */
  running: boolean
  /** Durable marker: the head has a sleepEpoch set (slept → next wake is fresh). */
  sleeping: boolean
  /** Live signal: the head's parent session is currently live. */
  parentLive: boolean
}

/**
 * The precedence that turns raw signals into a display status. `parentLive` is
 * accepted for signature symmetry with buildAgentRows but does not change the
 * outcome directly — a not-live (or missing) parent simply falls through to
 * the safe `napping` default, exactly like a live-but-idle head.
 */
export function computeHeadStatus(input: {
  sleeping: boolean
  unread: number
  running: boolean
  parentLive: boolean
}): HeadStatus {
  if (input.sleeping) return 'sleeping'
  if (input.unread > 0) return 'completed-notice'
  if (input.running) return 'working'
  return 'napping'
}

/**
 * Build one AgentRow per configured department, in config order. Live signals
 * (running/parentLive/unread) are INJECTED as functions so this stays pure and
 * testable; the caller (src/invoke.ts RPC handler) wires them to the live
 * registries.
 *
 * A department whose coordinator post has never been spawned (no registry
 * entry) still gets a row — status 'napping', no activity signals — because the
 * head exists in config and the sidebar must show it.
 */
export function buildAgentRows(args: {
  departments: DepartmentConfig[]
  posts: Map<string, PostEntryLike>
  agentRunning: (sessionId: string) => boolean
  parentLive: (sessionId: string) => boolean
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
      // live signals. The safe default is napping.
      rows.push({
        id: postId,
        name,
        department: department.name,
        kind: 'post',
        status: 'napping',
        unread: 0,
        running: false,
        sleeping: false,
        parentLive: false
      })
      continue
    }
    const running = args.agentRunning(entry.childId)
    const sleeping = entry.sleepEpoch !== undefined
    const parentLive = args.parentLive(entry.parentId)
    rows.push({
      id: postId,
      name,
      department: department.name,
      kind: 'post',
      status: computeHeadStatus({ sleeping, unread: args.unreadFor(postId), running, parentLive }),
      unread: args.unreadFor(postId),
      running,
      sleeping,
      parentLive
    })
  }
  return rows
}
