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
 * absent (the DEFAULT) keeps the QUEUE semantics (zero regression).
 * O1-EXT P4 — `sourceKey` (optional): the interrupt TRIGGER's identity (the
 * health-daemon frame/alert key the composite notifyHost passes as metadata).
 * It flows to `safeInterrupt`, which records it in the interrupt-state.json
 * detail entry — pure observability, never a behavior gate. */
export interface DeliveryInterruptOptions {
  interrupt?: boolean
  /** O1-EXT P4 — the interrupt trigger's identity (a daemon frame/alert key),
   * recorded in the interrupt-state.json detail entry when known. Absent →
   * byte-identical legacy behavior. */
  sourceKey?: string
  /** VALLE 09-07 (BATCH-DRAIN) — TRANSPORT flag threaded from `deliverOrQueue`
   * into the ALWAYS-WAKE primitives (`deps.deliverPost` / `deps.deliverHost`):
   * the caller's send is batch-eligible (the send_message ALWAYS-WAKE default).
   * The batch surface (dshd-orchestration) uses it to ACCUMULATE the record for
   * a drain-on-settle delta instead of splicing the inbox 1:1 while the
   * recipient is running. NEVER set for noWake/interrupt/ack/fifo-gated sends
   * (those branches keep their pre-batch semantics; the batch accumulator is
   * only ever reached by the ALWAYS-WAKE no-interrupt route). Absent/false →
   * byte-identical legacy behavior. */
  batchEligible?: boolean
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
  /** W9-b: preempt a busy recipient (abort the current turn). Default false.
   * P1 (fb-131 — WAKE-SEAM lane): `interrupt:true` ALSO BYPASSES the fb-117
   * FIFO gate — an explicit interrupt is the sender's preemption order, so it
   * is NEVER degraded to the no-wake queue by an earlier pending pair (the
   * diagnosis: the gate ran BEFORE the route, so the interrupt never reached
   * `busDeliverToPost`; the inbox order is preserved because the interrupt's
   * splice still goes first-item of the next turn — the preemption is the
   * documented intent of `interrupt`, not an inversion). */
  interrupt?: boolean
  /** VALLE 09-07 (BATCH-DRAIN) — OPTIONAL opt-in: the caller's send is
   * batch-eligible (send_message sets it ONLY on its ALWAYS-WAKE no-interrupt
   * default; noWake, ack-dormant, interrupt and every internal/internal-driver
   * delivery leave it ABSENT — the safe default false, zero regression for the
   * re-drive/boot/sweep/daemon/emergency paths). When true AND the recipient's
   * live handle is CURRENTLY RUNNING, the engine SKIPS the fb-117 FIFO gate
   * AND the batch surface accumulates the record for a drain-on-settle delta
   * (one followup at the settle with all pending messages in seq order — the
   * completion-order inversion this gate protects is structurally impossible
   * for a batched delivery). A non-running (idle/dormant) recipient is NOT
   * affected: the delivery proceeds to the plain ALWAYS-WAKE followup exactly
   * as today (the first message wakes the recipient; the batch never delays a
   * settle — no starvation by construction). */
  batchEligible?: boolean
  /** P1 (fb-131 — WAKE-SEAM lane) — OPTIONAL queue-class observer
   * (observability ONLY, never a behavior gate): invoked exactly when the
   * outcome degrades to 'prepared' WITHOUT a wake, with the queue CLASS —
   * 'fifo' (the fb-117 gate: an earlier seq is still pending; `bySeq` = the
   * EARLIEST gating seq when known — the 'tras m-<seq>' detail) or 'noWake'
   * (the WIRED no-wake branch). Absent → byte-identical (the observer is the
   * send_message tool-result enrichment seam). */
  gateReason?: (reason: 'fifo' | 'noWake', bySeq?: number) => void
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
  /** The write-ahead sidecar 'prepared' mark (persist-before-deliver, D4).
   * `opts.noWake: true` (m-707) marks the row no-wake — the WIRED `noWake`
   * branch sets it so the health watchdog excludes the send from its activity
   * input (a recipient receiving only no-wakes stays idle). */
  markPrepared(record: MessageRecord, recipientId: string, opts?: { noWake?: boolean }): Promise<unknown>
  /** The write-ahead sidecar FINAL status mark (settled — spec §4.4).
   * `opts.noWake: true` (m-707) marks the final row no-wake (see above). */
  markFinal(record: MessageRecord, recipientId: string, status: DeliveryStatus, opts?: { noWake?: boolean }): Promise<unknown>
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
  /** fb-117 (fold-in batch A) — the FIFO-GATE predicate per recipient: whether
   * `recipientId` has an EARLIER seq (strictly < `record.seq`) whose delivery
   * pair is still NON-FINAL ('prepared' pending — the write-ahead crash class
   * the sweep re-drives only after `preparedStuckMs`). When it returns true,
   * `deliverOrQueue` does NOT splice the inbox ahead (the durable queue is FIFO
   * by seq — only the inbox splice inverts): it degrades this delivery to the
   * no-wake queue behind ('prepared' pending, no materialize/wake) so the
   * recipient's `agent/inbox/spliced` stream stays in seq order. OPTIONAL: a
   * composition without it keeps the pre-fix behavior byte-identical (never a
   * gate). Implementations MUST be fail-soft-friendly (a throw degrades to
   * ungated at the engine — the ordering fix must never break a delivery). */
  pendingEarlierSeq?: (recipientId: string, seq: number) => Promise<boolean>
  /** P1 (fb-131 — WAKE-SEAM lane) — OPTIONAL: resolve the gating seq of the
   * FIFO gate (`pendingEarlierSeq` === true) — WHICH strictly-earlier seq's
   * pair is still 'prepared' — for the send_message tool-result observability
   * ('prepared (fifo-gated tras m-<seq>)'). Runs after the gate fired, best-
   * effort (a throw/ENOENT degrades to `undefined` — the tool then reports a
   * bare 'fifo-gated'). Absent → the tool reports the class without the seq.
   * NEVER a behavior gate — the boolean `pendingEarlierSeq` stays the decision
   * seam. */
  pendingEarlierSeqDetail?: (recipientId: string, seq: number) => Promise<number | undefined>
  /** P1 (2026-09-06 — WAKE-SEAM mitigation, fix opción-a VARIANTE (i)) —
   * OPTIONAL: whether the CATALOG recipient is CURRENTLY MATERIALIZED (LIVE —
   * its `agents.get(SessionId(sessionId))` handle exists in-process). When it
   * returns `true`, the fb-117 FIFO gate applies exactly as today (the only
   * case where the completion-order inbox splice can invert the presentational
   * order — the ordering guarantee fb-117 protects). When it returns `false`
   * (the recipient is DORMANT — no live handle), the gate is SKIPPED for this
   * delivery: `busDeliverToPost` → `materializePost` wakes the recipient, and
   * the inbox is rebuilt from the durable messages.jsonl queue in seq order —
   * the earlier pending head lands in the SAME wake, in order («el FIFO drena
   * en orden», m-2415 — never an inversion by construction). ABSENT
   * (`undefined`) → the gate applies unconditionally (the pre-fix behavior —
   * the safe default for a composition that cannot resolve liveness). A THROW
   * inside the dep degrades to the gate APPLIED (conservative — liveness is
   * never assumed on an error). */
  recipientMaterialized?: (recipientId: string) => boolean | undefined
  /** VALLE 09-07 (BATCH-DRAIN) — OPTIONAL: whether the CATALOG recipient's
   * live handle is CURRENTLY RUNNING (its in-process agent is mid-turn — the
   * same `agents.get(...)?.status === 'running'` probe the batch surface uses
   * internally; resolves posts (byPost → session) AND host entries (hosts →
   * session); a RETIRED member → false (never running); an unknown/child id
   * → `undefined` (no liveness knowledge). When it resolves `true` AND the
   * delivery carries `batchEligible`, the engine SKIPS the fb-117 FIFO gate
   * for this delivery: the batch surface accumulates the record and presents
   * it in ONE followup at the settle in seq order — the completion-order
   * splice inversion the gate protects cannot occur for a batched delivery
   * (nothing is spliced until the flush), so the ordering guarantee is
   * preserved BY CONSTRUCTION instead of by gating. ABSENT (`undefined` dep
   * or result) → the gate applies unconditionally (the safe default — a
   * composition that cannot resolve running-liveness keeps the pre-batch gate
   * behavior byte-identical). A THROW inside the dep degrades to the gate
   * APPLIED (conservative — running-status is never assumed on an error). */
  recipientRunningLive?: (recipientId: string) => boolean | undefined
  /** P1-EXT-EXT (2026-09-06 — WAKE-SEAM mitigation, m-2415 no-wake-head
   * DISCRIMINATOR) — OPTIONAL: whether the GATING HEAD of the FIFO gate (the
   * EARLIEST strictly-earlier seq whose delivery pair is still 'prepared' —
   * the pair `pendingEarlierSeq` fired on) is a NO-WAKE row (`noWake: true`).
   * When it resolves `true`, the gate does NOT retain the ALWAYS-WAKE behind
   * it: a noWake head is a DELIBERATE no-wake-until-wake send, never a
   * crash-class pending pair — the ALWAYS-WAKE IS the real wake and the head
   * drains WITH it, in seq order (m-2415 «la cabeza no-wake drena CON el wake,
   * nunca lo bloquea»). This is the P0 fix for the LIVE-recipient freeze (the
   * 2026-09-06 host datapoint: 36 ALWAYS-WAKEs frozen 'prepared (fifo-gated
   * tras m-2375)' behind a noWake head — the P2 sweep guard (messages.ts:1283)
   * never re-drives a noWake row into a non-running recipient, so the queue
   * froze forever). `false` (a crash-class head) → the gate applies exactly as
   * today (fb-117 ordering intact). ABSENT (`undefined`) or a THROW → the gate
   * applies (the safe default — the discriminator is opt-in via the dep; a
   * composition without it keeps the pre-extension behavior). */
  earlierHeadIsNoWake?: (recipientId: string, seq: number) => Promise<boolean | undefined>
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
      // m-707: a WIRED no-wake delivery marks BOTH its sidecar rows no-wake
      // (the write-ahead here + the final mark below) so the health watchdog's
      // inbox reader excludes the send from its activity computation.
      await deps.markPrepared(record, recipientId, opts.noWake === true ? { noWake: true } : undefined)
      // fb-117 (fold-in batch A — the ROOT of the inverted-order triage): the
      // FIFO GATE per recipient. BEFORE any inbox splice, ask the wiring
      // whether the recipient has an EARLIER seq still pending NON-FINAL
      // ('prepared' — e.g. a write-ahead crash-class pair the sweep re-drives
      // only after preparedStuckMs). If so, this record is NOT spliced ahead of
      // it: it degrades to the no-wake queue behind ('prepared' pending — the
      // same state the WIRED noWake branch returns) so `agent/inbox/spliced`
      // receives in seq order (the durable messages.jsonl queue is FIFO; only
      // the completion-order splice inverts — triage fb-117 §2.3). The
      // self-addressed hold ('self') is never gated (it never splices the
      // inbox — the ack-loop guard). The check itself is fail-soft: a gate
      // error only warns and proceeds ungated (the ordering fix must never
      // break a delivery).
      // P1 (fb-131 — WAKE-SEAM lane): `opts.interrupt === true` BYPASSES the
      // gate entirely (short-circuit — not even the sidecar read). The
      // candidate-A fix of the diagnosis: the FIFO gate ran BEFORE the route,
      // so the sender's `interrupt:true` NEVER reached `busDeliverToPost` (the
      // m-1107 WAKE-NUDGE class — interrupt swallowed by the gate). An explicit
      // interrupt is the preemption ORDER: the delivery must not degrade to the
      // no-wake queue behind an earlier pending pair; the recipient's inbox
      // stays in seq order because the interrupt's splice goes FIRST-ITEM of
      // the next turn (the documented preemption — never an inversion).
      // P1-EXT (2026-09-06 — WAKE-SEAM mitigation, fix opción-a VARIANTE (i),
      // m-2415): the gate applies ONLY when the recipient is CURRENTLY
      // MATERIALIZED (live). A DORMANT recipient's inbox is rebuilt at wake
      // from the durable queue in seq order — never spliced — so gating an
      // ALWAYS-WAKE to it is the wake-seam bug (the wake never happened; the
      // q-i worker auto-retire stayed unreachable). Skipping the gate for a
      // dormant recipient lets materializePost run; the earlier prepared head
      // lands in the SAME wake, in seq order (never an inversion by
      // construction). `undefined` (absent dep, OR the dep returned undefined)
      // → the gate applies (the safe default — a composition that cannot
      // resolve liveness falls back to the pre-fix behavior).
      if (recipientId !== record.from && opts.interrupt !== true && deps.pendingEarlierSeq !== void 0) {
        // VALLE 09-07 (BATCH-DRAIN) — the FIFO-gate SKIP for a batch-eligible
        // delivery to a CURRENTLY RUNNING recipient. The drain-on-settle batch
        // accumulates the record (dshd-orchestration's busDeliverToPost/Host —
        // the ALWAYS-WAKE route) and presents ALL pending messages in ONE
        // followup at the settle, in seq order by construction — nothing is
        // spliced into the live inbox until the flush, so the completion-order
        // inversion the fb-117 gate protects is STRUCTURALLY IMPOSSIBLE for a
        // batched delivery and the gate would only retain it behind an earlier
        // pair for no ordering benefit (the batch must not park a running
        // recipient's queue behind a crash-class head — it would un-batch the
        // delivery AND stall the drain). The skip is narrow: batchEligible
        // comes ONLY from send_message's ALWAYS-WAKE no-interrupt default, so
        // the fifo-gate stays intact for noWake/ack/interrupt/re-drive/boot/
        // daemon/emergency deliveries and for every non-running recipient
        // (idle/dormant keep the exact pre-batch gate — including the
        // dormancy-aware variant (i) and the no-wake-head discriminator).
        let batchRunning: boolean | undefined
        try {
          batchRunning = deps.recipientRunningLive?.(recipientId)
        } catch (error: unknown) {
          batchRunning = undefined // conservative — the gate applies
          deps.logger.warn(`[deepartments] bus delivery running-liveness probe failed for ${record.id} → ${recipientId} (the FIFO gate applies — safe default): ${error instanceof Error ? error.message : String(error)}`)
        }
        if (opts.batchEligible === true && batchRunning === true) {
          deps.logger.info(`[deepartments] bus delivery FIFO gate SKIPPED for ${record.id} → ${recipientId}: batch-eligible ALWAYS-WAKE to a RUNNING recipient — the record accumulates for the drain-on-settle batch (seq order preserved by construction, fb-117 inapplicable)`)
        } else {
        // VARIANTE (i) — DORMANCY-AWARE GATE. Resolve liveness FIRST (fail-soft
        // to undefined = apply the gate): a recipient CURRENTLY MATERIALIZED
        // (live handle) keeps the gate; a DORMANT recipient (no live handle) is
        // NOT gated — the ALWAYS-WAKE proceeds to `catalogRoute` →
        // `busDeliverToPost` → `materializePost`, which re-materializes the
        // recipient and rebuilds its inbox from the durable queue in seq order.
        // This is the wake-seam fix (m-2415, opción-a VARIANTE (i) — the
        // explore-deep-38 root cause): the FIFO gate used to retain the
        // ALWAYS-WAKE behind an earlier 'prepared' head EVEN when the recipient
        // was DORMANT — so the wake never occurred and the worker's auto-retire
        // (Fix B, inside busDeliverToPost) was unreachable → q-i workers stuck
        // idle never retired. Skipping the gate for a dormant recipient lets the
        // wake happen; the earlier head drena in the same wake, in order.
        let materialized: boolean | undefined
        try {
          materialized = deps.recipientMaterialized?.(recipientId)
        } catch (error: unknown) {
          materialized = undefined // conservative — gate applies
        }
        if (materialized !== false) {
          let gated = false
          try {
            gated = await deps.pendingEarlierSeq(recipientId, record.seq)
          } catch (error: unknown) {
            deps.logger.warn(`[deepartments] bus delivery FIFO-gate check failed for ${record.id} → ${recipientId} (delivery proceeds ungated): ${error instanceof Error ? error.message : String(error)}`)
          }
          if (gated) {
            // P1-EXT-EXT (2026-09-06 — WAKE-SEAM mitigation, m-2415 no-wake-head
            // DISCRIMINATOR): BEFORE the gate fires, ask whether the GATING
            // HEAD (the earliest strictly-earlier seq whose pair is still
            // 'prepared' — the pair `pendingEarlierSeq` just fired on) is a
            // NO-WAKE row. A noWake head is a DELIBERATE no-wake-until-wake
            // send — NEVER a crash-class pending pair — so it must NOT retain
            // an ALWAYS-WAKE behind it: the ALWAYS-WAKE IS the real wake and
            // the no-wake head drains WITH it, in seq order (m-2415). This is
            // the P0 fix for the LIVE-recipient freeze (2026-09-06, host: 36
            // ALWAYS-WAKEs frozen 'prepared (fifo-gated tras m-2375)' behind a
            // noWake m-2375 — the variant-(i) dormancy probe cannot see a
            // HOST-family recipient and the P2 sweep guard (messages.ts:1283)
            // never re-drives a noWake row into a non-running recipient → the
            // queue froze forever). `true` → SKIP the gate for this
            // ALWAYS-WAKE (proceed to the route — wake → delivery; the durable
            // no-wake head stays and drains with the wake in order). `false`
            // (a crash-class head) → the gate applies exactly as today
            // (fb-117). `undefined` (dep absent / throw) → the gate applies
            // (the safe default — the discriminator is opt-in via the dep).
            let headNoWake: boolean | undefined
            try {
              headNoWake = await deps.earlierHeadIsNoWake?.(recipientId, record.seq)
            } catch (error: unknown) {
              deps.logger.warn(`[deepartments] bus delivery no-wake-head discriminator failed for ${record.id} → ${recipientId} (the FIFO gate applies — safe default): ${error instanceof Error ? error.message : String(error)}`)
            }
            if (headNoWake === true) {
              deps.logger.info(`[deepartments] bus delivery FIFO gate SKIPPED for ${record.id} → ${recipientId}: the gating head is a NO-WAKE row (noWake:true) — the ALWAYS-WAKE is the real wake and the no-wake head drains with it in seq order (m-2415 — it never blocks)`)
            } else {
              // P1 (fb-131 — Candidate B observability): resolve the gating seq
              // best-effort (the 'tras m-<seq>' detail of the tool result) + fire
              // the queue-class observer. The observer NEVER gates.
              let bySeq: number | undefined
              try {
                if (deps.pendingEarlierSeqDetail !== void 0) bySeq = await deps.pendingEarlierSeqDetail(recipientId, record.seq)
              } catch (error: unknown) {
                deps.logger.warn(`[deepartments] bus delivery FIFO-gate seq detail failed for ${record.id} → ${recipientId} (observability only): ${error instanceof Error ? error.message : String(error)}`)
              }
              opts.gateReason?.('fifo', bySeq)
              deps.logger.info(`[deepartments] bus delivery FIFO gate: ${record.id} → ${recipientId} has an EARLIER non-final (prepared) seq${bySeq !== undefined ? ` (m-${bySeq})` : ''} — queued BEHIND (no-wake 'prepared'), the inbox splice stays in seq order (fb-117)`)
              await deps.markFinal(record, recipientId, 'prepared')
              return 'prepared'
            }
          }
        }
        }
      }
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
        await deps.markFinal(record, recipientId, status, opts.noWake === true ? { noWake: true } : undefined)
        return status
      } catch (error: unknown) {
        // fb-117 (fold-in batch A — triage candidate 3): a delivery that dies
        // between markPrepared and markFinal is the write-ahead CRASH class —
        // left as a 'prepared' orphan it would sit invisible until the 10-min
        // sweep (the prepared-stuck x2 rows of the triage). Mark the pair
        // 'failed' (durable, VISIBLE in the ledger, re-driveable with backoff)
        // instead. The caller's retry semantics are UNCHANGED — the rethrow
        // below stays; the 'failed' row is the LEDGER side (durability the
        // recipient can see), never the in-memory flow. The mark itself is
        // guarded: if the sidecar is down the original error still propagates.
        try {
          await deps.markFinal(record, recipientId, 'failed')
        } catch (markError: unknown) {
          deps.logger.warn(`[deepartments] bus delivery 'failed' mark for ${record.id} → ${recipientId} could not be persisted (the sidecar write itself failed): ${markError instanceof Error ? markError.message : String(markError)}`)
        }
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
    // P1 (fb-131 — Candidate B observability): the WIRED no-wake branch is the
    // SECOND 'prepared'-without-wake queue class — the observer distinguishes
    // it from the FIFO gate so the send_message tool result can name it.
    opts.gateReason?.('noWake')
    // C2 (m-2523, VALLE 09-07 — the noWake→retired frozen-'prepared' class):
    // a WIRED no-wake delivery whose CATALOG ROUTE is 'reroute' (a RETIRED
    // host-family address — `host-session-<uuid>` of a rotated host — resolved
    // to its LIVE successor, the m-331 role intent) is NEVER returned
    // 'prepared': the ADDRESSED recipient is terminal and can never wake, so a
    // 'prepared' row keyed to it would freeze forever — the B3 dormancy guard
    // (sleepEpoch preserved on the retired entry) AND the P2 no-wake running
    // guard both hold a noWake row for a recipient that is never live again
    // (no re-drive, no drain, no boot settle: the keep-forever class). The
    // m-331 re-route preserves the ALWAYS-WAKE delivery (it delivers TO the
    // successor); a NO-WAKE ORDER to a dead address has no wake to coalesce
    // with, so it FAILS to the sender ('failed' — visible in the ledger, the
    // record stays durable in messages.jsonl, and the noWake flag keeps the
    // P2 guard from re-driving it into a retry storm). The sender re-addresses
    // to the live successor (named by the host-rotation notice — O3).
    if (route.kind === 'reroute') {
      deps.logger.warn(`[deepartments] bus delivery noWake to RETIRED host "${recipientId}" FAILED (record ${record.id}): the address is terminal (re-route target is the live host "${route.entry.hostId}") — re-address the send to the live successor; the record stays durable (C2: a noWake to a never-live recipient never parks 'prepared')`)
      return 'failed'
    }
    return 'prepared'
  }
  // ALWAYS-WAKE (DEFAULT — the pre-step (c) behavior EXACTLY).
  // VALLE 09-07 (BATCH-DRAIN): the batch-eligibility TRANSPORT flag is threaded
  // from `deliverOrQueue` into the ALWAYS-WAKE primitives so the batch surface
  // (dshd-orchestration) can accumulate a running recipient's record instead of
  // splicing the inbox 1:1 (absent → the byte-identical pre-batch opts).
  const interrupt: DeliveryInterruptOptions = {
    ...(opts.interrupt === true ? { interrupt: true } : {}),
    ...(opts.batchEligible === true ? { batchEligible: true } : {})
  }
  if (route.kind === 'post') {
    return deps.deliverPost(route.entry, framed, record, opts.senderSessionId, interrupt)
  }
  return deps.deliverHost(route.entry, framed, record, opts.senderSessionId, interrupt)
}
