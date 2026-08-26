// dsh-deepartments — the bus DELIVERY ENGINE + the `deliverOrQueue` gate
// (spec 003 §4, FASE 2 STEP c).
//
// THIS module OWNS the ACTIVE delivery engine carved out of the invoke.ts
// monolith. It is the SINGLE delivery seam of the bus: every outbound bus
// message (send_message, the dept_job_run / dept_worker_spawn / dept_post_create
// first-message deliveries, and the boot re-delivery driver) funnels through
// `deliverOrQueue`. The daemon notify hooks (QD directive, agenda scheduler,
// parallel-monitor, system-health) keep their existing direct call into the
// always-wake primitives (busDeliverToPost / busDeliverToHost) so their behavior
// stays byte-identical — the seam is the single point for the CATALOG delivery
// orchestration.
//
// The engine owns:
//   - `deliverOrQueue(postId, msg, { noWake })`: the GATE + the per-recipient
//     delivery unit. CONTRACT (spec 004 / step-c):
//       (1) resolve the recipient against the registry — a RETIRED member
//           resolves to a clean `failed` (marked, never erased, never woken);
//       (2) persist the write-ahead `markDelivery` 'prepared' record;
//       (3) `noWake:false` (DEFAULT) → the current ALWAYS-WAKE path
//           (`materializePost` / `busDeliverToPost`), byte-identical to the
//           pre-step (c) delivery;
//       (4) `noWake:true` → persist the record but DO NOT materialize/wake
//           (queue for the recipient's next real wake). WIRED (B2/B3): the
//           explicit send_message `noWake` tool param + the B3 dormant-ack
//           gate (a QD ack to a just-slept head is no-waked) SET it — it is no
//           longer an inert branch.
//   - the `markDelivery` 'prepared'→final write-ahead orchestration;
//   - the DEFENSIVE messaging ACL gate application for the recipient (the ACL
//     predicate is the PURE ./acl.js `aclDenyGround` — FASE 2 STEP (d) extracted
//     it out of invoke.ts; the catalog-bound `busProfileFor` is injected here so
//     the delivery path is never the one to bypass the rules on a boot
//     re-delivery of a pre-ACL record);
//   - the catalog route resolution (posts.json ∪ non-retired hosts.json + the
//     host-family re-route) via the injected resolver.
//
// The CLOSURE-BOUND low-level wake primitives (materializePost, busDeliverToPost,
// busDeliverToHost, the subagent child route) stay in invoke.ts (FASE 2 STEP (c)
// wrap): they are deeply coupled to the plugin fiber (agents / sessions /
// subagents / config setup), so they are INJECTED here as deps rather than
// physically relocated. The seam is the single point of entry; a later step may
// move the primitives wholesale once the service injection is fully decoupled.
//
// Per-apply construction (AGENTS.md rule 4 — NO module-global mutable state):
// `applyInvoke` builds ONE `DeliveryEngine` on the plugin fiber with
// `createDeliveryEngine(deps)` and injects the resolved harness services
// (registry store, messages store, child-route / catalog resolver, the ACL gate,
// the wake primitives).
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { DeliveryStatus, MessageRecord } from './messages.js'
import type { PostEntry, HostEntry } from './registry.js'
// FASE 2 step (d): the messaging ACL is a PURE module (./acl.js — busProfileFor /
// aclDenyGround / canSend / aclDenyReason). The delivery engine imports the pure
// `aclDenyGround` for its defensive gate (instead of an injected closure-bound
// predicate) and re-exports the ACL surface (value + type) so lib/delivery.js
// stays a drop-in superset of the pre-step-(d) module.
import { aclDenyGround } from './acl.js'
import type { BusMemberProfile } from './acl.js'
export { busProfileFor, aclDenyGround, aclDenyReason, canSend } from './acl.js'
export type { BusMemberProfile, BusCatalogLens } from './acl.js'

// ---------------------------------------------------------------------------
// Types (spec 003 §4.1 / W9-b / step-c).
// ---------------------------------------------------------------------------

/** W9-b — one bus-delivery option. `interrupt: true` preempts a busy recipient
 * (aborts the CURRENT turn, reason 'interrupted', keepInbox preserved) so the
 * delivered message is the FIRST item of the recipient's NEXT turn; `false`/
 * absent (the DEFAULT) keeps the QUEUE semantics (zero regression). */
export interface DeliveryInterruptOptions {
  interrupt?: boolean
}

/** The `deliverOrQueue` gate options. `noWake: false` (the DEFAULT) is the
 * behavior-neutral always-wake path; `noWake: true` is the no-wake-until-wake
 * queue branch (WIRED — B2/B3: the explicit send_message `noWake` param + the
 * B3 dormant-ack gate set it). The remaining fields are the delivery TRANSPORT
 * context threaded through from the caller (the caller agent id + sender
 * session id for the child route / source, the abort signal, and the W9-b
 * interrupt option). */
export interface DeliverOrQueueOptions {
  /** Default false → the ALWAYS-WAKE path (byte-identical to pre-step (c)).
   * true → persist the record but DO NOT materialize/wake (queue for the
   * recipient's next real wake). WIRED (B2/B3) — the no-wake-until-wake
   * semantics the dormant-ack gate + the explicit send_message `noWake` use. */
  noWake?: boolean
  /** W9-b: preempt a busy recipient (abort the current turn). Default false. */
  interrupt?: boolean
  /** The caller's agent id — used by the child route (listChildren /
   * followup) only; the catalog route ignores it. */
  callerAgentId?: string
  /** The caller's durable session id — projected into the delivered source
   * (senderSessionId). May be undefined (a daemon/system sender). */
  senderSessionId?: string
  /** The abort signal for the native child route (exec.signal in production). */
  signal?: AbortSignal
}

/** One catalog delivery target resolved from the registry, WITHOUT the ACL /
 * retired gates applied (the engine owns those). `{ kind: 'unknown' }` = no
 * catalog member (and not re-routable to a live host). */
export type CatalogRoute =
  | { kind: 'post'; entry: PostEntry }
  | { kind: 'host'; entry: HostEntry }
  | { kind: 'reroute'; entry: HostEntry }
  | { kind: 'unknown' }

// NOTE: `BusMemberProfile` is defined in ./acl.js (the pure ACL — FASE 2 step d)
// and RE-EXPORTED here so the engine's deps can name the ACL predicate without
// importing invoke.ts, and the delivery engine keeps its exported type surface.

/** Per-recipient send result: a settled DeliveryStatus, or an ACL denial
 * (`failed:acl:<ground>`) which NEVER touches the record nor the delivery
 * sidecar — it exists only in the tool result so the sender knows the message
 * must be channeled via the recipient's department head. */
export type BusSendResult = DeliveryStatus | `failed:acl:${string}`

/** The deps a `DeliveryEngine` needs from the apply fiber (or a test harness).
 * Injected so the engine stays free of any module-global state and free of the
 * invoke.ts closure, while the CLOSURE-BOUND primitives (the wake functions, the
 * child route, the catalog resolver, the ACL gate predicate) are provided as
 * injected callbacks. */
export interface DeliveryEngineDeps {
  /** The org stateDir hosting `<stateDir>/deliveries.jsonl`. */
  stateDir: string
  /** A warn/info-capable logger (the cordis `ctx.logger` shape). */
  logger: { info(message: string): void; warn(message: string): void }
  /** The write-ahead sidecar 'prepared' mark (persist-before-deliver, D4). */
  markPrepared(record: MessageRecord, recipientId: string): Promise<unknown>
  /** The write-ahead sidecar FINAL status mark (settled — spec §4.4). */
  markFinal(record: MessageRecord, recipientId: string, status: DeliveryStatus): Promise<unknown>
  /** The subagent continuation service (optional — absent in minimal
   * compositions, disabling the child route). */
  subagents?: unknown
  /** Resolve whether `recipientId` is the caller's direct CONTUNABLE child
   * (delivered natively, never catalog-validated). Never throws. */
  resolveChild(recipientId: string, callerAgentId: string, signal?: AbortSignal): Promise<boolean>
  /** Deliver ONE bus message to a continuable child (native followup). Returns
   * 'delivered' or 'failed' (never throws). */
  deliverChild(
    callerAgentId: string,
    recipientId: string,
    record: MessageRecord,
    framed: string,
    senderSessionId: string | undefined,
    signal?: AbortSignal
  ): Promise<DeliveryStatus>
  /** Resolve a recipient against the durable catalog (posts.json ∪ non-retired
   * hosts.json + the host-family re-route) WITHOUT applying the ACL / retired
   * gates (the engine applies those — the DEFENSIVE gate). */
  resolveCatalogRoute(recipientId: string): CatalogRoute
  /** The messaging-ACL profile classifier (spec 004 §5.6). Injected because it
   * needs the apply-catalog closure (the durable posts/hosts registries + the
   * config department resolver); the PURE classifier lives in ./acl.js
   * (`busProfileFor(memberId, catalog)`) and invoke.ts binds its catalog here.
   */
  busProfileFor(memberId: string): BusMemberProfile
  /** The ALWAYS-WAKE post delivery (materializePost + followup + stuck recovery;
   * closure-bound in invoke.ts). Never throws (returns 'failed' on error). */
  deliverPost(
    entry: PostEntry,
    framed: string,
    record: MessageRecord,
    senderSessionId: string | undefined,
    opts: DeliveryInterruptOptions
  ): Promise<DeliveryStatus>
  /** The ALWAYS-WAKE host delivery (resume + followup + W8-i retry; closure-bound
   * in invoke.ts). Never throws (returns 'failed' on error). */
  deliverHost(
    hostEntry: HostEntry,
    framed: string,
    record: MessageRecord,
    senderSessionId: string | undefined,
    opts: DeliveryInterruptOptions
  ): Promise<DeliveryStatus>
}

/** The delivery engine: the single bus delivery seam. */
export interface DeliveryEngine {
  /**
   * The SINGLE delivery seam of the bus. Delivers ONE addressed record to ONE
   * recipient (the write-ahead 'prepared' → route → final sidecar transition).
   * This is the idempotent re-delivery unit: the boot re-delivery driver re-runs
   * it for crash-pending pairs. Route order per recipient (spec §4.2): child
   * route FIRST (the caller's direct continuable children — never catalog-
   * validated), then the catalog (posts.json ∪ non-retired hosts.json); unknown
   * ids → 'failed'. `opts.noWake: true` (WIRED — B2/B3) persists the 'prepared'
   * record but does NOT materialize/wake — it queues for the recipient's next
   * real wake.
   *
   * CONTRACT (spec 004 / step-c): resolve-recipient → 'prepared' → ALWAYS-WAKE
   * (default) OR no-wake queue. The default (`noWake:false`) reproduces EXACTLY
   * the pre-step (c) always-wake delivery.
   */
  deliverOrQueue(
    recipientId: string,
    record: MessageRecord,
    opts?: DeliverOrQueueOptions
  ): Promise<DeliveryStatus>
}

/** The bus source framing for ONE delivered record (spec §4.3): `[From <from> →
   * <to>]: <text>`. */
export function frameBusRecord(record: MessageRecord): string {
  return `[From ${record.from} → ${record.to.join(', ')}]: ${record.text}`
}

/**
 * Create the delivery engine on the apply fiber (AGENTS.md rule 4 — NO
 * module-global mutable state). Injects the harness services + the closure-bound
 * primitives once, so the engine is a single reusable seam per apply.
 */
export function createDeliveryEngine(deps: DeliveryEngineDeps): DeliveryEngine {
  return {
    async deliverOrQueue(recipientId, record, opts = {}): Promise<DeliveryStatus> {
      const framed = frameBusRecord(record)
      // Persist-before-deliver (D4): the write-ahead 'prepared' row is on disk
      // BEFORE any route/wake, so a crash mid-fan-out re-delivers idempotently.
      await deps.markPrepared(record, recipientId)
      try {
        let status: DeliveryStatus
        if (recipientId === record.from) {
          // Ack-loop guard: a self-addressed send is held — persisted, no wake,
          // never re-enters the caller's own turn.
          status = 'self'
        } else if (deps.subagents !== void 0) {
          // Route (1) — the caller's direct continuable child? Resolve BEFORE any
          // catalog validation (a transient child id can never be 'unknown').
          const isChild = await deps.resolveChild(recipientId, opts.callerAgentId ?? '', opts.signal)
          if (isChild) {
            status = await deps.deliverChild(opts.callerAgentId ?? '', recipientId, record, framed, opts.senderSessionId, opts.signal)
          } else {
            status = await catalogRoute(deps, recipientId, record, framed, opts)
          }
        } else {
          status = await catalogRoute(deps, recipientId, record, framed, opts)
        }
        await deps.markFinal(record, recipientId, status)
        return status
      } catch (error: unknown) {
        // The sidecar write failed (fs): the record is durable, the delivery is
        // NOT recorded — fail loud to the caller (never silently lose a send).
        deps.logger.warn(`[deepartments] bus delivery sidecar write failed for ${record.id} → ${recipientId}: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }
  }
}

/** The CATALOG route of the delivery engine (spec §4.2 route 2 + §4.3): posts.json
 * (head/worker) then non-retired hosts.json; unknown → 'failed'. F1: a RETIRED
 * worker entry STAYS in the registry (marked, not erased) but is filtered from
 * the LIVE catalog — addressing it fails like an unknown one. F2: the messaging
 * ACL (spec §4.2 route 2 + §5.6) runs HERE, BEFORE any wake/materialization — the
 * DEFENSIVE enforcement seam (a boot re-delivery of a pre-ACL record can never
 * bypass the rules). A denial / retired / unknown resolves to 'failed'
 * (sidecar-compatible). The `noWake` gate (WIRED — B2/B3) returns 'prepared' —
 * the record is persisted but the recipient is NOT materialized/woken. */
async function catalogRoute(
  deps: DeliveryEngineDeps,
  recipientId: string,
  record: MessageRecord,
  framed: string,
  opts: DeliverOrQueueOptions
): Promise<DeliveryStatus> {
  const route = deps.resolveCatalogRoute(recipientId)
  if (route.kind === 'unknown') {
    deps.logger.warn(`[deepartments] bus delivery to unknown member "${recipientId}" (record ${record.id})`)
    return 'failed'
  }
  // F2 — the defensive ACL gate (spec §4.2 route 2 + §5.6), BEFORE any wake. The
  // send_message persist filter already keeps denied recipients out of a record's
  // to[], so this is the reinforcement seam; a denial returns 'failed'
  // (sidecar-compatible; the richer `failed:acl:<ground>` lives in the tool result).
  // The predicate is the PURE ./acl.js `aclDenyGround` (step (d)).
  const sender = deps.busProfileFor(record.from)
  if (route.kind === 'reroute') {
    if (aclDenyGround(sender, { kind: 'host', memberId: route.entry.hostId }) !== undefined) {
      deps.logger.warn(`[deepartments] bus delivery re-route to the live host "${route.entry.hostId}" DENIED by the messaging ACL (record ${record.id}, sender ${record.from}) — a worker never writes to the Asistente (spec 004 §5.6/D6)`)
      return 'failed'
    }
  } else if (aclDenyGround(sender, deps.busProfileFor(recipientId)) !== undefined) {
    if (route.kind === 'host') {
      deps.logger.warn(`[deepartments] bus delivery to the host "${recipientId}" DENIED by the messaging ACL (record ${record.id}, sender ${record.from}) — a worker never writes to the Asistente (spec 004 §5.6/D6)`)
    } else {
      deps.logger.warn(`[deepartments] bus delivery to "${recipientId}" DENIED by the messaging ACL (record ${record.id}, sender ${record.from}) — skipped; it goes via the recipient's department head (spec 004 §5.6)`)
    }
    return 'failed'
  }
  // F1 — a RETIRED member is never woken/attempted (marked, never erased).
  if (route.kind === 'post' && route.entry.retired === true) {
    deps.logger.warn(`[deepartments] bus delivery to RETIRED member "${recipientId}" skipped (record ${record.id})`)
    return 'failed'
  }
  // noWake gate (WIRED — B2/B3: the explicit send_message `noWake` param + the
  // B3 dormant-ack gate set it). The 'prepared' record was persisted above; this
  // branch does NOT materialize/wake, so the message waits for the recipient's
  // next real wake (the no-wake-until-wake semantics).
  if (opts.noWake === true) {
    return 'prepared'
  }
  // ALWAYS-WAKE (DEFAULT — the pre-step (c) behavior EXACTLY).
  const interrupt: DeliveryInterruptOptions = opts.interrupt === true ? { interrupt: true } : {}
  if (route.kind === 'post') {
    return deps.deliverPost(route.entry, framed, record, opts.senderSessionId, interrupt)
  }
  return deps.deliverHost(route.entry, framed, record, opts.senderSessionId, interrupt)
}
