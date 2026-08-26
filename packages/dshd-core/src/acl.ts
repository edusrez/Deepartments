// dsh-deepartments — the pure MESSAGING ACL (spec 004 §5.6), FASE 2 STEP (d).
//
// The ACL semantics that lived INLINE in invoke.ts (`busProfileFor` /
// `aclDenyGround` + the defensive gate the delivery engine applies) are
// extracted HERE as a pure module: NO module-global mutable state, NO side
// effects — every function derives its result purely from its arguments. The
// catalog-dependent classification (`busProfileFor`) takes the registry maps +
// the config department resolver as an EXPLICIT `BusCatalogLens` argument; the
// per-pair denial (`aclDenyGround`) depends only on the two sender/recipient
// profiles. This is the SINGLE SOURCE of the bus messaging ACL semantics.
//
// The ACL (spec 004 §5.6): host → everyone; head → any head (incl. the host) +
// its own department's agents; worker → its own department's agents (incl. its
// head) + self; worker → host PROHIBIDO (D6 — it must go via its head). Orphan
// policy: a worker without a departmentId is reachable ONLY by the head that
// created it (managerId) — its "department" is its manager. A recipient the
// catalog does NOT know (a transient child id, an unknown id) is NOT an ACL
// subject: the child route and the unknown-per-recipient 'failed' path keep
// their own behavior.
//
// The delivery engine's DEFENSIVE gate (step c) and the send_message PRE-FILTER
// both consume these functions, so a boot re-delivery of a PRE-ACL record can
// never bypass the rules and the worker→host prohibition holds everywhere.
//
// NO export default (pitfall 0001 — breaks `inject`).

import type { PostEntry } from './registry.js'

/** The bus member profile the ACL classifies on (spec 004 §5.6). Defined here
 * so the pure ACL and the delivery engine share one type (delivery.ts /
 * invoke.ts re-export it to keep their public surface a drop-in superset). */
export interface BusMemberProfile {
  kind: 'host' | 'head' | 'worker' | 'unclassified'
  memberId: string
  departmentId?: string
  managerId?: string
}

/** The catalog views `busProfileFor` needs to classify a member — the durable
 * posts registry, the live hosts registry, and the config department resolver.
 * A pure function takes these as an EXPLICIT argument (never a module-global
 * mutable). `byPost` maps postId → PostEntry; `hosts` exposes only `.has()` (the
 * ACL only tests membership); `departmentForPost` resolves a configured head's
 * department from config (`DepartmentConfig` is a structural match). */
export interface BusCatalogLens {
  byPost: ReadonlyMap<string, PostEntry>
  hosts: { has(memberId: string): boolean }
  departmentForPost(postId: string): { id?: string } | undefined
}

/** Classify a catalog member into its bus profile (spec 004 §5.6). A worker's
 * department is its DURABLE link (recorded at create from the creating head's
 * config department); a configured head derives it from config
 * (`departmentForPost`). A legacy pre-F1 worker carries neither → an "orphan"
 * (only its manager reaches it — see `aclDenyGround`). */
export function busProfileFor(memberId: string, catalog: BusCatalogLens): BusMemberProfile {
  const entry = catalog.byPost.get(memberId)
  if (entry !== void 0) {
    return entry.provider === 'worker'
      ? { kind: 'worker', memberId, departmentId: entry.departmentId, managerId: entry.managerId }
      : { kind: 'head', memberId, departmentId: catalog.departmentForPost(memberId)?.id }
  }
  if (catalog.hosts.has(memberId)) return { kind: 'host', memberId }
  return { kind: 'unclassified', memberId }
}

/** One ACL DENIAL ground (undefined = allowed). Spec 004 §5.6 table:
 * host → everyone; head → any head (incl. the host) + its own department's
 * agents; worker → its own department's agents (incl. its head) + self;
 * worker → host PROHIBITED (D6 — it must go via its head). Orphan policy: a
 * worker without a departmentId is reachable ONLY by the head that created it
 * (managerId) — its "department" is its manager. A recipient the catalog does
 * NOT know (a transient child id, an unknown id) is NOT an ACL subject: the
 * child route and the unknown-per-recipient 'failed' path keep their own
 * behavior. */
export function aclDenyGround(sender: BusMemberProfile, recipient: BusMemberProfile): string | undefined {
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

/** Resolve the ACL denial ground between TWO CATALOG member ids (undefined =
 * allowed). A convenience over `busProfileFor` + `aclDenyGround`. */
export function aclDenyReason(from: string, to: string, catalog: BusCatalogLens): string | undefined {
  return aclDenyGround(busProfileFor(from, catalog), busProfileFor(to, catalog))
}

/** Whether `from` may send to `to` under the messaging ACL (true = allowed).
 * The boolean form of `aclDenyReason`. */
export function canSend(from: string, to: string, catalog: BusCatalogLens): boolean {
  return aclDenyReason(from, to, catalog) === undefined
}
