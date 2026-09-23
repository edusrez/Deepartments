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
// ─── [fb-467 INSTRUMENTATION — changeset A2, READ-ONLY] ───────────────────────
// The version stamp of the fb-467 observability lines: EVERY instrumentation
// line below carries it, so a decision can be traced to the build that took it
// (the lane's «sello de versión por decisión»). This changeset is DELIBERATELY
// separate from the fix and is behavior-neutral BY CONSTRUCTION: it only calls
// the logger. It adds no read, no write, no gate, no route — a delivery cannot
// observe it (verified: the ledger signature of the fixture is byte-identical
// with and without it).
const FB467_INSTRUMENTATION_STAMP = 'fb467-i1'
// ─── [end fb-467 INSTRUMENTATION header] ──────────────────────────────────────
// ─── GATE LEDGER (2026-09-17, run token 5f015e56) ─────────────────────────────
// THE SINK the fb-467 gate-decision / gate-verdict families never had. The trace
// (`reports/explore-deep/2026-09-17-gate-fifo-sin-despertador-479e9953.md` §4B)
// measured that BOTH lines are `deps.logger.info` and land in NO ledger: the 21
// hits of the two families in `/.deepartments/` are agent TRANSCRIPTIONS quoting
// the source, and `grep appendFile|writeFileSync` over THIS file returned 0.
// Every family that really lands does so through an EXPLICIT appendFile
// (`retire-dice` ← registry.ts:1744, `deliveries` ← messages.ts:701).
//
// ⇒ NO READER WAS MISSING — A SINK WAS. This const is that sink: one append-only
// JSONL beside the other stateDir ledgers, written by `appendGateLedgerRow`.
// BOTH families land (routing only one would leave the ledger counting half),
// and the row carries the RESOLVED discriminator, so a legitimate
// `headNoWake=false` (correct crash-class retention, fb-117) is finally
// DISTINGUISHABLE from a silent-failure `undefined` (ENOENT / read error / dep
// absent — a LOST WAKER), which the legacy ledger wrote identically.
const GATE_DECISION_LEDGER_FILE = 'gate-decisions.jsonl'
// ─── [end GATE LEDGER header] ─────────────────────────────────────────────────
// ─── GATE WAKE (2026-09-17, run token 5f015e56) ───────────────────────────────
// THE PROGRAMMED WAKE. The hold branch used to retain the row and RETURN —
// programming NOTHING. The only real waker of a retained queue is `onDelivered`
// (:763), which fires ONLY on a landed delivery: i.e. when ANOTHER message lands
// at that recipient. An IDLE recipient never gets that event, so the release
// depended on third-party traffic or on the 10-min prepared-stuck clock
// (messages.ts:1185/:2208). Measured over the 233 retained pairs: median 162,2 s
// and 215/233 released BEFORE the 600 s clock ⇒ the release was an EXTERNAL
// EVENT, never a scheduled wake (explore-deep-123 §4C).
//
// The delay: ONE sweep cadence (RE_DELIVERY_SWEEP_DEFAULT_INTERVAL_MS = 60 s).
// It is deliberately WELL BELOW the 600 s prepared-stuck clock (so the release
// stops depending on it), and ABOVE the +37 s reroute window of the DRENAJE
// terminalization (so the armed drain never races the orphan closure and
// duplicates a reroute's content). The timer is `unref()`d — the repo's own
// pattern (tools.ts:3981/:6784) — so it can never hold the process open.
const GATE_WAKE_DEFAULT_DELAY_MS = 60_000
/** GATE WAKE — the FIFO bound of the armed-head set (the once-per-head guard).
 * A process-lifetime engine never forgets an armed head, so the set is capped;
 * evicting the oldest can at worst re-arm a wake for a very long-pending head —
 * the bounded and CORRECT direction (it re-arms a genuinely stuck queue). */
const GATE_WAKE_ARMED_CAP = 1024
// ─── [end GATE WAKE header] ───────────────────────────────────────────────────

/** THE GATE LEDGER SINK (2026-09-17, run token 5f015e56): append ONE row to
 * `<stateDir>/gate-decisions.jsonl`. NON-FATAL BY CONSTRUCTION — a ledger that
 * cannot be written must NEVER break a delivery (the same fail-soft discipline
 * as every other observation seam of this module): any error only warns. */
async function appendGateLedgerRow(deps: DeliveryEngineDeps, row: Record<string, unknown>): Promise<void> {
  try {
    const filePath = path.join(deps.stateDir, GATE_DECISION_LEDGER_FILE)
    await mkdir(path.dirname(filePath), { recursive: true })
    await appendFile(filePath, `${JSON.stringify(row)}\n`, 'utf8')
  } catch (error: unknown) {
    deps.logger.warn(`[deepartments] gate-decision ledger append failed (non-fatal — the delivery is unaffected): ${error instanceof Error ? error.message : String(error)}`)
  }
}
// DRENAJE (2026-09-10): the reroute terminalization reads the SUCCESSOR's pair
// status before closing the retired id's pair (never close what did not land).
// fb-467 (2026-09-10): the ORPHAN-HEAD discriminator of the FIFO gate reads the
// SAME sidecar seam (the parsed rows) — the engine has no store, so the gate's
// row view comes from here (read-only, fail-soft). `parseDeliveryRows` /
// `resolveDeliveriesPath` / `deliveryStatus` are PRE-EXISTING exports: the
// fb-467 rescue deliberately adds NO new export to this package (the frozen
// `export-parity` pin of the `lib/invoke.js` superset must not grow).
import { deliveryStatus, parseDeliveryRows, resolveDeliveriesPath } from './messages.js'
import type { DeliveryRow } from './messages.js'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
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
  /** FB-198 (T1, 2026-09-07) — TRANSPORT ground observer threaded from
   * `deliverOrQueue` into the ALWAYS-WAKE primitives: the wake primitives
   * (`deps.deliverPost` / `deps.deliverHost` — whose NEVER-throw contract maps
   * a materialization/wake failure to a returned 'failed') fire the FAILURE
   * GROUND they classified here, so the caller (send_message) can name the
   * class in its per-recipient result instead of the bare 'failed' false
   * negative (fb-198: a durable record whose wake failed under pool pressure
   * was reported 'failed', indistinguishable from a lost send). Absent →
   * no-op (the primitives' 'failed' returns keep their byte-identical legacy
   * shape — the observer is purely observational). */
  failedGround?: (ground: BusDeliveryFailedGround) => void
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
  /** VALLE 09-07 (BATCH-DRAIN) + 2026-09-21 (DEFAULT-FLIP, run token d46d84b7) —
   * the batch-eligibility OPT-OUT, three-valued:
   *   - `true`  → eligible (send_message's ALWAYS-WAKE no-interrupt default).
   *   - `false` → EXPLICIT 1:1 opt-out: this delivery keeps the pre-batch
   *     behavior byte-identical (the fb-117 FIFO gate applies and the wake
   *     primitive splices it 1:1 into the running recipient's inbox). Every
   *     caller that NEEDS the old absent-default semantics asks for them
   *     explicitly (`send_message` already sets `false` on its noWake/interrupt
   *     branches).
   *   - ABSENT  → ELIGIBLE (the flipped default, MEASURED — not assumed):
   *     every ALWAYS-WAKE bus delivery (no `noWake`, no `interrupt`) is
   *     batch-eligible. PRE-FLIP the flag was set by the `send_message` path
   *     ALONE, so the daemon/system-notice notices, the agenda notices, the
   *     post-error notices and the boot/sweep RE-DRIVE — all of them
   *     ALWAYS-WAKE, no-interrupt, i.e. structurally identical to the
   *     send_message default — delivered 1:1 to a RUNNING recipient. MEASURED
   *     on the live host session (session-bb5b8d5b…, 84 bus frames carried by
   *     43 inbox items): the eligible class coalesced at 0.349 turns/message
   *     (63 messages / 22 items) while the unflagged class paid 1.000 (21
   *     messages / 21 items) — the SAME transport, the FLAG its only
   *     difference. The read is gated by the live-liveness probe
   *     (`recipientRunningLive`), so an idle/dormant recipient NEVER batches:
   *     the first message wakes it exactly as before (no starvation by
   *     construction), and a `noWake`/`interrupt` order is never eligible
   *     (their branches keep byte-identical wake-seam semantics). When
   *     eligible AND the recipient's live handle is CURRENTLY RUNNING, the
   *     engine SKIPS the fb-117 FIFO gate AND the batch surface accumulates
   *     the record for a drain-on-settle delta (ONE followup at the settle
   *     with ALL pending messages in seq order — the completion-order
   *     inversion the gate protects is structurally impossible for a batched
   *     delivery). */
  batchEligible?: boolean
  /** P1 (fb-131 — WAKE-SEAM lane) — OPTIONAL queue-class observer
   * (observability ONLY, never a behavior gate): invoked exactly when the
   * outcome degrades to 'prepared' WITHOUT a wake, with the queue CLASS —
   * 'fifo' (the fb-117 gate: an earlier seq is still pending; `bySeq` = the
   * EARLIEST gating seq when known — the 'tras m-<seq>' detail) or 'noWake'
   * (the WIRED no-wake branch). Absent → byte-identical (the observer is the
   * send_message tool-result enrichment seam). */
  gateReason?: (reason: 'fifo' | 'noWake', bySeq?: number) => void
  /** CONTEXT-ADMISSION GATE (2026-09-16, run token 7cf42c47) — OPTIONAL observer
   * (observability ONLY, never a behavior gate): invoked exactly when the
   * delivery was DEFERRED because the recipient's LIVE session is the very
   * session the health actuator marked as having crossed its context window
   * (`<stateDir>/context-action.json`), with the marker's own frame. A SEPARATE
   * seam on purpose: `gateReason`'s union is consumed by the send_message tool
   * result (`tools.ts` assigns it to a `'fifo' | 'noWake' | undefined` local),
   * so widening it would be a COMPILE break outside this lane; this additive
   * optional observer keeps every existing caller byte-identical (absent → no
   * call at all). Absent → no-op, exactly like `gateReason`/`failedGround`. */
  contextDeferred?: (info: { recipientId: string; sessionId: string; action: string; phase: string; pct: number }) => void
  /** FB-198 (T1, 2026-09-07) — OPTIONAL failure-ground observer
   * (observability ONLY, never a behavior gate): invoked exactly when the
   * per-recipient delivery outcome resolves to 'failed', with the GROUND the
   * engine/the wake primitives classified. A TERMINAL ground (unknown /
   * retired / acl / reroute / child — the address can never receive the
   * record) and a WAKE ground (session-not-found / materialization-failed /
   * pool — the address is valid, the materialize/wake failed, the durable
   * record stays re-driveable by the sweep) split the bare 'failed' the
   * send_message result used to show for a PERSISTED record (the fb-198 false
   * negative: 'failed' meant both «lost» and «queued»). Absent → byte-identical
   * (the observer is the send_message tool-result enrichment seam, the same
   * pattern as `gateReason`). */
  failedGround?: (ground: BusDeliveryFailedGround) => void
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

/** FB-198 (T1, 2026-09-07) — the delivery-failure GROUND fed to the
 * `failedGround` observer when a per-recipient delivery resolves to 'failed'.
 * The classes split the ONE opaque status into the two honest families the
 * sender must distinguish (the characterization §3.1/§4.1 — never a bare
 * 'failed' for a PERSISTED record):
 *   - TERMINAL (the ADDRESS can never receive the record — the delivery is
 *     final, the sidecar row settles 'failed' and the sweep eventually
 *     'terminal'): 'unknown' (no catalog member), 'retired' (F1 — marked,
 *     never woken), 'acl' (the defensive engine gate — the send_message
 *     pre-filter already reports `failed:acl:<ground>` before any persistence),
 *     'reroute' (C2 — a WIRED noWake to a RETIRED host-family address with a
 *     live successor: the addressed recipient can never wake), 'child' (the
 *     caller's direct continuable child could not be delivered).
 *   - WAKE (the ADDRESS is valid; the materialize/wake failed; the record is
 *     DURABLE and re-driveable by the sweep/backoff — the fb-198 episode
 *     class): 'session-not-found' (the W8-i resilient-retry exhausted),
 *     'materialization-failed' (dual resume+create failure / preflight /
 *     quarantine — a broken-but-addressed recipient), 'pool' (the pooler
 *     capacity gate: no workspace can serve the wake — the original fb-198
 *     allBlocked/429 trigger). */
export type BusDeliveryFailedGround = 'unknown' | 'retired' | 'acl' | 'reroute' | 'child' | 'session-not-found' | 'materialization-failed' | 'pool'

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
   * `opts.noWake: true` (m-707) marks the final row no-wake (see above).
   * `opts.reason` (fb-2160, 2026-09-21) is the ADDITIVE CAUSE COLUMN of a
   * 'failed' row — the ground this engine classified (`BusDeliveryFailedGround`)
   * so the ledger stops hiding why a delivery failed. Optional and only ever
   * written for a 'failed' status: an absent value keeps every other row
   * byte-identical (R6). */
  markFinal(record: MessageRecord, recipientId: string, status: DeliveryStatus, opts?: { noWake?: boolean; reason?: string }): Promise<unknown>
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
  /** CONTEXT-ADMISSION GATE (2026-09-16, run token 7cf42c47) — OPTIONAL: the
   * durable session id of the recipient's LIVE, CATALOG-RESOLVED incarnation —
   * the EXACT identity the engine is about to materialize. This is THE
   * DISCRIMINATOR of the context-admission gate below: the actuator's marker is
   * keyed by `agentId` and SURVIVES 24 h, while a post ROTATES to a fresh, sane
   * session — so a gate that read the marker WITHOUT comparing the session would
   * DEFER THE SUCCESSOR (blocking a healthy session for a whole day) instead of
   * only the dying one. `ledger[recipientId].sessionId === liveSessionId` is the
   * ONLY thing separating «defer the one that is dying» from «block the whole
   * org».
   *
   * ABSENT (`undefined` dep, or the dep returning undefined) → the gate is INERT
   * (FAIL-OPEN, never defer): the identity cannot be established, and a defer
   * without proof of identity is exactly the successor-blocking failure this
   * gate must never cause. A THROW inside the dep is the SAME fail-open path
   * (deferring on a probe error would trade a bounded 400 for an unbounded
   * block). NEVER assumed on an error. */
  liveSessionId?: (recipientId: string) => string | undefined
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
  /** FB-132 (wake-on-delivered 2026-09-06 — the 2nd-half drain-on-wake lane):
   * OPTIONAL — fired ONCE per delivery that LANDED ('delivered' | 'resumed')
   * and AFTER the final sidecar mark: the recipient was just materialized/
   * woken — the REAL wake the drain-on-wake lane fires `drainRecipientQueue`
   * from. Placement is the SEAM: AFTER markFinal, the just-delivered pair is
   * already settled, so the drain (which re-drives pair-latest 'prepared'
   * rows) can never duplicate the current delivery — firing from inside the
   * wake primitives would see the write-ahead 'prepared' of the CURRENT
   * delivery still pending and re-drive it (a duplicate splice; the observed
   * c1 race). The VALLE 09-07 BATCH-DRAIN accumulates the RUNNING recipient's
   * batch-eligible sends AT the primitives (their landing is 'prepared' — a
   * batch item — so this hook never fires for an item the settle flushes);
   * for every LANDED (non-batch) delivery the hook drains the 'prepared'
   * residue FIFO head-first. The bundle wires it to the same fire-and-forget
   * dispatcher the wake primitives use; absent → a NO-OP (the drain-on-wake
   * contract stays merely documentary in a minimal composition). */
  onDelivered?: (recipientId: string) => void
  /** DRENAJE (2026-09-10 — the ORPHAN class, host decision: OBLIGATORIO) —
   * OPTIONAL: the REROUTE TERMINALIZATION seam. Fired ONCE after a delivery to
   * a RETIRED host-family address was RE-ROUTED to the live successor and the
   * successor's pair reached a LANDED final status ('delivered' | 'resumed').
   * @param retiredRecipientId the RETIRED host id the record was addressed to
   *   (whose write-ahead 'prepared' row the reroute leaves behind);
   * @param successorId the live successor entry that ACTUALLY received it.
   *
   * WHY THIS EXISTS: `resolveCatalogRoute` re-routes a retired host-family
   * address to the live successor (fb-58 F-3 / m-331 — the Asistente ROLE), and
   * the engine's `reroute` branch then delivers the record TO THE SUCCESSOR —
   * but BOTH its sidecar marks (the write-ahead `markPrepared` and the final
   * `markFinal`) are keyed to `recipientId`, i.e. the RETIRED id: the FIRST
   * ('prepared') and the FINAL ('delivered'|'resumed') land on DIFFERENT pairs.
   * The retired id's pair therefore keeps a 'prepared' row FOREVER
   * (`needsRedelivery` — the permanent-orphan class: measured 2026-09-10,
   * m-4028 ≈ 24 h / m-4763 / m-4769, each with its record CORRECTLY delivered
   * to the live successor and its old-id pair never closed), which re-arms the
   * ~10-min prepared-stuck sweep and the health watchdog on a message that was
   * in fact DELIVERED. This hook is the closure: the wiring settles the retired
   * id's pair 'terminal' (a pure status flip — the CONTENT is already
   * delivered; NEVER a re-delivery, which would duplicate it).
   *
   * The CLASS is general and ORIGIN-INDEPENDENT: the ENGINE owns the flip and
   * performs it for EVERY landed reroute (any caller — send_message, the boot
   * re-drive, the sweep, the drain — no per-caller wiring and no per-variant
   * patch), so a future variant of a "retired address with a live successor"
   * cannot reopen the orphan class. This dep is only the OBSERVER seam for the
   * shell (an optional piggyback — no shell-side settlement is required for the
   * closure to hold). Fail-soft both ways: the flip is already done when this
   * fires; an absent dep or a THROW → warn only. */
  onRerouted?: (retiredRecipientId: string, successorId: string) => void
  /** GATE WAKE (2026-09-17, run token 5f015e56) — OPTIONAL: the DELAY of the
   * wake the FIFO-gate hold PROGRAMS for itself. The hold branch retains the
   * pair and returns; before this, that return programmed NOTHING, so the
   * retained ALWAYS-WAKE waited for a LANDED delivery to the same recipient
   * (`onDelivered`, fired only on delivered/resumed) or for the 10-min
   * prepared-stuck clock. An IDLE recipient receives neither: the release
   * depended on third-party traffic (measured: median 162,2 s over 233 retained
   * pairs, 215/233 released before the 600 s clock — an EXTERNAL EVENT).
   *
   * When set, the hold branch arms ONE `setTimeout(delay)` that re-drives the
   * recipient through `onDelivered` — the SAME production drain transport
   * (`fireQueueDrain` → `drainRecipientQueue`), so the release is the drain the
   * contract already names, merely SCHEDULED instead of merely hoped for. The
   * timer is `unref()`d (it never holds the process) and is ONCE per gating
   * head: a second retention behind the same head does not re-arm (no 60 s
   * retry storm — the fb-150 spool class stays closed).
   *
   * ABSENT → the timer seam is INERT: the hold keeps its pre-fix behavior
   * byte-identically (a minimal composition — e.g. a test harness with no drain
   * transport — is unaffected). The DEFAULT is `GATE_WAKE_DEFAULT_DELAY_MS`
   * (60 s = one sweep cadence) at the production wiring. */
  gateWakeDelayMs?: number
  /** GATE WAKE (2026-09-17, run token 5f015e56) — OPTIONAL: the PROGRAMMED WAKE
   * itself. Fired ONCE per gating head when a hold armed its timer: the
   * recipient's retained queue is re-driven NOW instead of waiting for
   * third-party traffic. The production wiring passes the SAME transport
   * `onDelivered` fires (`fireQueueDrain` → `drainRecipientQueue`), so the
   * programmed release and the landed-delivery release are the SAME drain, not
   * a second, parallel one. ABSENT → the hold still arms NOTHING and warns ONCE
   * (a composition that asked for a wake it cannot deliver is a LOUD
   * misconfiguration, never a silent no-op) — and the ledger records
   * `wakeArmed:false` with the reason. */
  gateWake?: (recipientId: string, gatingHeadMessageId: string) => void
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

/** 2026-09-21 (DEFAULT-FLIP — run token d46d84b7) — whether THIS delivery is
 * batch-eligible (the single decision seam the FIFO-gate skip, the gate ledger
 * and the ALWAYS-WAKE transport all read). The explicit `batchEligible` WINS
 * (`false` = the caller's 1:1 opt-out, `true` = the caller's opt-in — that is
 * `send_message`'s declared default). ABSENT = ELIGIBLE: the pre-flip read
 * (`=== true`) made the `send_message` path the ONLY eligible one, so every
 * other ALWAYS-WAKE producer (health/system notices, agenda notices, the
 * re-drive/sweep) delivered 1:1 into a running recipient even though its
 * transport is byte-identical to `send_message`'s; the MEASURED split on the
 * live host session was 0.349 vs 1.000 turns per message for the two classes.
 * A `noWake` (queue-until-wake) or an `interrupt` (preemption) order is NEVER
 * eligible — their branches are cut before the ALWAYS-WAKE transport and their
 * wake-seam semantics stay byte-identical (noWake/ack/interrupt unchanged).
 * PURE, never throws (the read is a pure field test — it can never take a
 * delivery down). */
export function isBatchEligible(opts: { batchEligible?: boolean | undefined; noWake?: boolean | undefined; interrupt?: boolean | undefined }): boolean {
  if (opts.batchEligible !== undefined) return opts.batchEligible === true
  return opts.noWake !== true && opts.interrupt !== true
}

/**
 * Create the delivery engine on the apply fiber (AGENTS.md rule 4 — NO
 * module-global mutable state). Injects the harness services + the closure-bound
 * primitives once, so the engine is a single reusable seam per apply.
 */
export function createDeliveryEngine(deps: DeliveryEngineDeps): DeliveryEngine {
  /** GATE WAKE (2026-09-17, run token 5f015e56): the ARMED heads of this engine
   * — the gating-head ids whose programmed wake is already pending. ONCE per
   * head: a second retention behind the SAME head does NOT re-arm (the guard
   * that keeps the fix from becoming a 60 s retry storm — the fb-150 spool
   * class). An entry is released when the timer fires, and it is BOUNDED (a
   * fired head is removed; a long-lived engine cannot grow it without bound).
   * Per-apply state on the closure — AGENTS.md rule 4 (no module-global mutable
   * state). */
  const armedGateWakes = new Set<string>()
  return {
    async deliverOrQueue(recipientId, record, opts = {}): Promise<DeliveryStatus> {
      const framed = frameBusRecord(record)
      /** fb-2160 (2026-09-21) — THE CAUSE COLUMN. The engine already CLASSIFIES
       * every failure (`BusDeliveryFailedGround`, fb-198/T1) but only ever hands
       * the classification to the CALLER's observer — and the re-drive/boot/sweep
       * paths pass no observer, so the ground died with the call and the ledger
       * row stayed `{messageId, recipientId, status, ts}` ALONE. MEASURED
       * consequence: `m-17466`/`m-17488`/`m-17524`/`m-17836` → `quality-head`
       * wrote 9–11 `failed` rows each, with NO indication of why. The wrapper
       * below captures the ground INSIDE the engine and forwards it unchanged to
       * the caller's observer (semantics untouched, R6): the local copy is what
       * the 'failed' marks below persist. */
      let failedGroundOf: BusDeliveryFailedGround | undefined
      const callerFailedGround = opts.failedGround
      const optsWithGroundCapture: DeliverOrQueueOptions = {
        ...opts,
        failedGround: (ground: BusDeliveryFailedGround): void => {
          failedGroundOf = ground
          callerFailedGround?.(ground)
        }
      }
      /** The mark options of ONE sidecar final mark: the pair's no-wake seal
       * (unchanged, m-707) plus — ONLY for a 'failed' status — the captured
       * CAUSE. `markFinal` ignores `reason` for every other status, so the
       * non-failed marks stay byte-identical to the pre-fb-2160 row. */
      const finalMarkOpts = (status: DeliveryStatus, noWake: boolean, reason?: string): { noWake?: boolean; reason?: string } => ({
        ...(noWake ? { noWake: true } : {}),
        ...(reason !== undefined && status === 'failed' ? { reason } : {})
      })
      /** DRENAJE (2026-09-10 — the ORPHAN closure): the route KIND of THIS
       * delivery, reported by `catalogRoute` (undefined for the child route /
       * a minimal composition). The final-mark seam below keys the
       * reroute terminalization on it. */
      const routeOut: { kind?: string; successorId?: string; deferred?: boolean } = {}
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
        if (isBatchEligible(opts) && batchRunning === true) {
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
            // GATE LEDGER (2026-09-17, run token 5f015e56): WHY the discriminator
            // ended up undefined — the asymmetry the trace measured as invisible.
            // A resolved `false` is a CORRECT crash-class retention (fb-117); an
            // `undefined` is a SILENT FAILURE (a lost waker) and it matters WHICH:
            // a composition without the dep (`dep-absent`) is a wiring gap, while
            // a THROW is the concurrent-unreadable-sidecar class (the G2 settle
            // rewrites that same file with a NON-atomic `writeFileSync`,
            // messages.ts:2599, while this reader is an async `readFile`). The
            // ENGINE can separate exactly these: the dep's own absence, a caught
            // throw, and a resolved value.
            let headNoWakeSource: 'resolved' | 'dep-absent' | 'throw' = 'dep-absent'
            if (deps.earlierHeadIsNoWake !== void 0) {
              headNoWakeSource = 'resolved'
              try {
                headNoWake = await deps.earlierHeadIsNoWake(recipientId, record.seq)
              } catch (error: unknown) {
                headNoWakeSource = 'throw'
                deps.logger.warn(`[deepartments] bus delivery no-wake-head discriminator failed for ${record.id} → ${recipientId} (the FIFO gate applies — safe default): ${error instanceof Error ? error.message : String(error)}`)
              }
            }
            /** The RESOLVED discriminator as ONE traceable token — the field the
             * ledger needs to tell a legitimate retention from a lost waker. */
            const headNoWakeToken = headNoWakeSource === 'resolved' ? String(headNoWake) : headNoWakeSource
            // fb-467 — the ORPHAN-HEAD discriminator's resolved successor (the
            // address the gating head ALREADY landed at — undefined = no orphan
            // head: the gate applies exactly as today).
            let orphanHeadAt: string | undefined
            // [fb-467 INSTRUMENTATION — changeset A2, READ-ONLY] the gate decision
            // line: the ID + the recipient + the liveness probes the gate used
            // (host liveness) + the batch verdict, emitted ONCE per gated
            // delivery, before any branch (log-only — no delivery can observe it).
            deps.logger.info(`[deepartments] [${FB467_INSTRUMENTATION_STAMP}] gate-decision id=${record.id} recipient=${recipientId} seq=${record.seq} gated=true materialized=${String(materialized)} runningLive=${String(batchRunning)} batchEligible=${String(isBatchEligible(opts))} batchEligibleDeclared=${opts.batchEligible === undefined ? 'absent' : String(opts.batchEligible)} noWake=${String(opts.noWake === true)} interrupt=${String(opts.interrupt ?? false)}`)
            // GATE LEDGER (2026-09-17, run token 5f015e56): the SAME decision,
            // landed in a durable sink. `headNoWake` is the RESOLVED
            // discriminator, read from the RESOLUTION (never re-derived) — the
            // field that makes a legitimate `false` distinguishable from a
            // silent-failure `undefined`. AWAITED (not fire-and-forget): the sink
            // is an INSTRUMENT, and an instrument whose rows race the assertions
            // that read them measures nothing on demand. It is non-fatal by
            // construction (any write error only warns inside the helper), so
            // awaiting it can never fail a delivery — and the ledger is then
            // DETERMINISTIC at the retention instant: the row is on disk BEFORE
            // the return.
            await appendGateLedgerRow(deps, {
              kind: 'gate-decision',
              at: Date.now(),
              id: record.id,
              recipient: recipientId,
              seq: record.seq,
              gated: true,
              materialized: String(materialized),
              runningLive: String(batchRunning),
              batchEligible: isBatchEligible(opts),
              noWake: opts.noWake === true,
              // `?? false` form on purpose: at this point TS has already narrowed
              // `opts.interrupt` to `false | undefined` (the gate's own condition
              // above short-circuits on `interrupt !== true`), so `=== true` is a
              // TS2367 no-overlap error — and the narrowing is the very proof that
              // this branch is reached only with interrupt unset.
              interrupt: opts.interrupt ?? false,
              headNoWake: headNoWakeToken,
              awaited: true
            })
            if (headNoWake === true) {
              deps.logger.info(`[deepartments] bus delivery FIFO gate SKIPPED for ${record.id} → ${recipientId}: the gating head is a NO-WAKE row (noWake:true) — the ALWAYS-WAKE is the real wake and the no-wake head drains with it in seq order (m-2415 — it never blocks)`)
              // GATE LEDGER (2026-09-17, run token 5f015e56): the SKIP-THEN-WAKE
              // verdict lands too. m-2415's skip is a GATE DECISION like the other
              // two, and the ledger that recorded only the holds would report this
              // delivery as «never gated» — the half-counted ledger §3 forbids.
              await appendGateLedgerRow(deps, {
                kind: 'gate-verdict',
                at: Date.now(),
                id: record.id,
                recipient: recipientId,
                verdict: 'skip-nowake-head',
                materialized: String(materialized),
                runningLive: String(batchRunning),
                headNoWake: headNoWakeToken,
                awaited: true
              })
            } else if ((orphanHeadAt = await orphanHeadLandedAtSuccessor(deps, recipientId, record.seq)) !== undefined) {
              // fb-467 (2026-09-10 — the GATEADO-BEHIND-AN-ORPHAN lane, run token
              // f76ac64b): WHERE THE HEAD CLOSED. The gating head's pair at THIS
              // recipient is still 'prepared', but the head ALREADY LANDED at
              // `orphanHeadAt` — the LIVE SUCCESSOR this recipient's route
              // resolves (a RETIRED host-family address: `resolveCatalogRoute` →
              // kind 'reroute'). The head is therefore an ORPHAN RESIDUE: its
              // content reached the successor through the re-route while its
              // addressed pair never got its terminal (the DRENAJE
              // terminalization needs the successor's pair landed at the final
              // mark and the successor lands +37 s later — the measured window
              // overlap of fb-117/fb-137, «filas `prepared` sin terminal»). This
              // address can NEVER receive again (every attempt re-routes) and
              // NEVER wakes: retaining this delivery behind such a head would
              // park it FOREVER — the gate branch's `markFinal('prepared')` +
              // `return` is exactly the defect the lane measured («el gateado no
              // llega a la ruta»). The gate is SKIPPED: the delivery proceeds to
              // the route, lands at the live successor and its own pair closes
              // 'terminal' through the SAME DRENAJE closure below — the ordering
              // the fb-117 gate protects is moot (nothing can ever splice into a
              // dead address) and the SKIP is confined to the reroute class, so
              // every SANE delivery keeps the gate byte-identically.
              deps.logger.info(`[deepartments] bus delivery FIFO gate SKIPPED for ${record.id} → ${recipientId}: the gating head closed at the REROUTE SUCCESSOR "${orphanHeadAt}" (fb-467 — the head is an orphan residue of a retired host address, the addressed pair can never receive; this delivery reaches the route instead of parking behind it forever)`)
              // [fb-467 INSTRUMENTATION — changeset A2, READ-ONLY] the skip verdict
              // with the CATALOG route that produced it + the probes (log-only).
              deps.logger.info(`[deepartments] [${FB467_INSTRUMENTATION_STAMP}] gate-verdict id=${record.id} recipient=${recipientId} verdict=skip-orphan-head route=reroute successor=${orphanHeadAt} materialized=${String(materialized)} runningLive=${String(batchRunning)}`)
              // GATE LEDGER (2026-09-17, run token 5f015e56): the SKIP verdict
              // lands too — routing only the hold would leave the ledger
              // counting half the gate's decisions (the §3 criterion).
              await appendGateLedgerRow(deps, {
                kind: 'gate-verdict',
                at: Date.now(),
                id: record.id,
                recipient: recipientId,
                verdict: 'skip-orphan-head',
                route: 'reroute',
                successor: orphanHeadAt,
                materialized: String(materialized),
                runningLive: String(batchRunning),
                headNoWake: headNoWakeToken,
                awaited: true
              })
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
              // [fb-467 INSTRUMENTATION — changeset A2, READ-ONLY] the hold verdict
              // by ID: the gating seq + the probes + the catalog verdict that did
              // NOT fire (the head is NOT an orphan residue). Log-only AND
              // fail-soft: the extra catalog read is wrapped, so a probe error can
              // never reach the delivery.
              let fb467CatalogKind = 'unknown'
              try {
                fb467CatalogKind = (deps.resolveCatalogRoute(recipientId) as { kind?: string }).kind ?? 'unknown'
              } catch {
                fb467CatalogKind = 'probe-failed'
              }
              deps.logger.info(`[deepartments] [${FB467_INSTRUMENTATION_STAMP}] gate-verdict id=${record.id} recipient=${recipientId} verdict=hold-gated bySeq=${bySeq !== undefined ? `m-${bySeq}` : 'unknown'} route=${fb467CatalogKind} materialized=${String(materialized)} runningLive=${String(batchRunning)}`)
              // ─── THE FIX (2026-09-17, run token 5f015e56) ───────────────────
              // THE RETAINER PROGRAMS THE WAKE ITS RELEASE DEPENDS ON. Before
              // this, the branch retained the row and RETURNED, programming
              // NOTHING: the release waited for a LANDED delivery to the SAME
              // recipient (`onDelivered`, fired only on delivered/resumed) or for
              // the 10-min prepared-stuck clock. An IDLE recipient receives
              // neither — measured over 233 retained pairs: median 162,2 s with
              // 215/233 released BEFORE the 600 s clock, i.e. by an EXTERNAL
              // event, never by a scheduled wake (explore-deep-123 §4C).
              //
              // THE ORDERING IS UNTOUCHED — THIS IS NOT «STOP RETAINING». The
              // pair is still marked 'prepared' and still returns without
              // splicing: nothing is delivered ahead of the gating head (the
              // fb-117 guarantee, asserted by the guard half of the lane). What
              // changes is that the WAKE the head's own drain needs is now
              // SCHEDULED instead of merely hoped for: the timer fires the SAME
              // production drain transport `onDelivered` fires, which re-drives
              // the queue HEAD-FIRST — the head lands first, the followers then,
              // in seq order.
              //
              // NOT ARMED in three cases, each recorded in the ledger with its
              // reason (never a silent no-op):
              //   - a DELIBERATE no-wake send: its drain is the recipient's next
              //     REAL wake (the no-wake-until-wake contract) — arming it would
              //     silently convert a deliberate noWake into a wake;
              //   - already armed for this gating head: ONCE per head (no 60 s
              //     retry storm — the fb-150 spool class stays closed);
              //   - no transport configured (`gateWake` absent): the engine warns
              //     ONCE per head instead of pretending it programmed a wake.
              const gatingHeadKey = bySeq !== undefined ? `m-${bySeq}` : `seq<${record.seq}`
              const wakeDelayMs = deps.gateWakeDelayMs ?? GATE_WAKE_DEFAULT_DELAY_MS
              // THE TRANSPORT: the drain the contract already names. `gateWake`
              // is the explicit override; ABSENT it falls back to the ALREADY
              // WIRED `onDelivered` — the production drain transport
              // (`fireQueueDrain` → `drainRecipientQueue`, wired by the bundle
              // into this very engine). That fallback is what makes this fix
              // ZERO-WIRING: the transport the landed-delivery path already uses
              // is simply SCHEDULED instead of only awaited. Nothing new is
              // configured, and no composition that wired one of the two is
              // left without a wake.
              const wakeTransport: ((recipientId: string, gatingHeadMessageId: string) => void) | undefined =
                deps.gateWake ?? (deps.onDelivered !== void 0 ? (wakeRecipientId: string) => { deps.onDelivered?.(wakeRecipientId) } : undefined)
              let wakeArmed = false
              let wakeReason: string
              if (opts.noWake === true) {
                wakeReason = 'no-wake-send'
              } else if (armedGateWakes.has(gatingHeadKey)) {
                wakeReason = 'already-armed'
              } else if (wakeTransport === void 0) {
                wakeReason = 'no-transport'
                deps.logger.warn(`[deepartments] bus delivery FIFO gate armed NO wake for ${record.id} → ${recipientId} (gating head ${gatingHeadKey}): no drain transport is wired (neither gateWake nor onDelivered) — the retained pair keeps waiting for a landed delivery or the prepared-stuck clock (fb-117 hold unchanged)`)
              } else {
                wakeArmed = true
                wakeReason = 'armed'
                armedGateWakes.add(gatingHeadKey)
                // BOUNDED: the set is a process-lifetime memory, so it is capped
                // FIFO (a Set preserves insertion order). Evicting the OLDEST head
                // can at worst re-arm a wake for a head that has been pending for
                // a very long time — the bounded, correct direction (it re-arms a
                // genuinely stuck queue; it never grows without bound).
                if (armedGateWakes.size > GATE_WAKE_ARMED_CAP) {
                  const oldest = armedGateWakes.values().next().value
                  if (oldest !== undefined) armedGateWakes.delete(oldest)
                }
                const fireWake = wakeTransport
                const timer = setTimeout(() => {
                  // THE HEAD IS NOT RELEASED HERE — DELIBERATELY. Releasing it
                  // would let the drain's OWN re-drive re-arm behind the same
                  // still-pending head, and that is a SELF-FEEDING LOOP: the
                  // drain re-drives the follower head-first; the follower is
                  // re-gated behind the unresolved head and arms ANOTHER wake;
                  // that wake drains again… forever at the wake cadence. The
                  // guard is therefore ONCE PER GATING HEAD, PERIOD: a head that
                  // never lands keeps the pre-fix recovery (the 10-min
                  // prepared-stuck sweep) — the SAME bounded clock as before —
                  // and the fix only ever converts the TYPICAL case (the head
                  // lands once the drain reaches it) from «waits for third-party
                  // traffic» to «scheduled».
                  try {
                    fireWake(recipientId, gatingHeadKey)
                  } catch (error: unknown) {
                    deps.logger.warn(`[deepartments] programmed gate wake for ${recipientId} threw (non-fatal — the next wake/sweep re-evaluates): ${error instanceof Error ? error.message : String(error)}`)
                  }
                }, wakeDelayMs)
                // Never hold the process open (the repo's own pattern:
                // tools.ts:3981/:6784) — a daemon timer must not block exit.
                if (typeof (timer as { unref?: () => unknown }).unref === 'function') (timer as { unref: () => unknown }).unref()
                deps.logger.info(`[deepartments] bus delivery FIFO gate: ${record.id} → ${recipientId} retained 'prepared' AND the wake it depends on is PROGRAMMED (gating head ${gatingHeadKey}, in ${wakeDelayMs} ms — the drain re-drives head-first, fb-117 order preserved)`)
              }
              // GATE LEDGER (2026-09-17, run token 5f015e56): the HOLD verdict,
              // landed. `headNoWake` separates a legitimate crash-class retention
              // from a lost waker; `wakeArmed`/`wakeReason` say whether the
              // release was SCHEDULED — so the next retained pair is EXPLICABLE
              // from the ledger instead of inferred after the fact.
              await appendGateLedgerRow(deps, {
                kind: 'gate-verdict',
                at: Date.now(),
                id: record.id,
                recipient: recipientId,
                verdict: 'hold-gated',
                bySeq: bySeq !== undefined ? `m-${bySeq}` : 'unknown',
                route: fb467CatalogKind,
                materialized: String(materialized),
                runningLive: String(batchRunning),
                headNoWake: headNoWakeToken,
                wakeArmed,
                wakeReason,
                ...(wakeArmed ? { wakeDelayMs, wakeKey: gatingHeadKey } : {}),
                awaited: true
              })
              // DRENAJE (2026-09-10): the gate branch is the SECOND row of a
              // FIFO-gated delivery — the pair-LATEST the re-drive
              // discriminator reads (`latestPerPair` → hasEarlierPendingPair /
              // gatingHeadIsNoWake → `row.noWake === true`). Marking it WITHOUT
              // the intent made a DELIBERATE noWake indistinguishable from a
              // crash-class pending pair: the sweep no longer recognized the
              // intent (P2 guard bypassed → the ~10-min preparedStuck re-drive),
              // the health watchdog lost the exclusion, and the drain re-marked
              // the pair crash-class. Everything downstream keys off the ROW,
              // not off the caller — so the record of the intent must be
              // COMPLETE here. Passes `opts` exactly like the normal-branch
              // final mark below.
              await deps.markFinal(record, recipientId, 'prepared', opts.noWake === true ? { noWake: true } : undefined)
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
            // FB-198 (T1): a child-route 'failed' carries its terminal ground —
            // the caller's continuable child could not be delivered (the record
            // IS durable — persisted before the route). The observer never gates.
            if (status === 'failed') opts.failedGround?.('child')
          } else {
            status = await catalogRoute(deps, recipientId, record, framed, optsWithGroundCapture, routeOut)
          }
        } else {
          status = await catalogRoute(deps, recipientId, record, framed, optsWithGroundCapture, routeOut)
        }
        // DRENAJE (2026-09-10 — the ORPHAN closure, class-general). THIS is the
        // pair's real FINAL mark (the one that shadows every earlier row). A
        // delivery to a RETIRED host-family address is RE-ROUTED to the live
        // successor and lands THERE (the successor's own pair is marked
        // 'delivered' by the host primitive), so marking THIS pair with the
        // landed status would leave the RETIRED id's write-ahead 'prepared' row
        // as the pair-final of an id that can never receive — the measured
        // PERMANENT-ORPHAN class (m-4028 ≈ 24 h / m-4763 / m-4769, each with its
        // record correctly delivered to the successor). When that successor pair
        // REALLY landed, the retired pair's final word is 'terminal' (the
        // re-drive's own dead-settle policy; a pure STATUS FLIP — the content is
        // already delivered, NEVER re-delivered). Class, not symptom: this is
        // the SINGLE final-mark seam, so it holds for EVERY caller (send_message,
        // boot re-drive, sweep, drain) and for any future "dead address with a
        // live successor" variant. Gated on the LANDED class: a failed/prepared
        // reroute keeps the existing re-drive semantics untouched.
        // The route KIND comes from `catalogRoute`'s additive out-param — this
        // is the SINGLE final-mark seam, so the closure holds for every caller.
        let retiredReroute = false
        const successorId = routeOut.successorId
        if (routeOut.kind === 'reroute' && successorId !== undefined && (status === 'delivered' || status === 'resumed')) {
          let landed: DeliveryStatus | null = null
          try {
            landed = await deliveryStatus(deps.stateDir, record.id, successorId)
          } catch (error: unknown) {
            deps.logger.warn(`[deepartments] reroute terminalization: successor-status read for ${record.id} → "${successorId}" failed (pair kept with its own final — never close what did not land): ${error instanceof Error ? error.message : String(error)}`)
          }
          if (landed === 'delivered' || landed === 'resumed') {
            retiredReroute = true
            deps.logger.info(`[deepartments] reroute terminalization: ${record.id} → retired host "${recipientId}" settled 'terminal' — the record was DELIVERED to the live successor "${successorId}" (the retired-id pair was the permanent-'prepared' ORPHAN; pure status flip, NO re-delivery)`)
            if (deps.onRerouted !== void 0) {
              try {
                deps.onRerouted(recipientId, successorId)
              } catch (error: unknown) {
                deps.logger.warn(`[deepartments] onRerouted observer for the retired host "${recipientId}" threw (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          }
        }
        // CONTEXT-ADMISSION GATE (2026-09-16, run token 7cf42c47): a DEFERRED
        // delivery seals its 'prepared' row exactly like a wired noWake send —
        // the ROW is what the sweep/drain/health read, and an unsealed
        // 'prepared' is CRASH-CLASS (the ~10-min prepared-stuck re-drive into
        // the same dead session: the fb-150 spool class). The deferral IS a
        // deliberate no-wake-until-wake, so it carries the same `noWake` seal.
        const sealNoWake = opts.noWake === true || routeOut.deferred === true
        // fb-2160 (2026-09-21) — THE CAUSE COLUMN OF THE FINAL MARK. A `failed`
        // status here is the TERMINAL class the engine classified on the way in
        // ('unknown' / 'retired' / 'acl' / 'reroute' / 'child') and, for the
        // wake class, the ground the delivery primitive reported through the
        // `failedGround` observer the wrapper above captures. Until this change
        // the row persisted NONE of it. `unreported` is the honest value for a
        // 'failed' whose ground nobody classified — it is a DECLARED gap, never
        // a fabricated cause.
        await deps.markFinal(
          record,
          recipientId,
          retiredReroute ? 'terminal' : status,
          finalMarkOpts(retiredReroute ? 'terminal' : status, retiredReroute ? false : sealNoWake, status === 'failed' ? (failedGroundOf ?? 'unreported') : undefined)
        )
        // FB-132 (wake-on-delivered 2026-09-06): the landed-delivery wake hook —
        // AFTER the final mark (the current pair is settled, so the drain can
        // never re-drive it). Fire-and-forget + non-fatal: an absent hook → a
        // NO-OP; a throwing hook must never break the delivery (the fire is the
        // drain-on-wake transport the bundle wires — see `onDelivered`).
        if ((status === 'delivered' || status === 'resumed') && deps.onDelivered !== undefined) {
          try {
            deps.onDelivered(recipientId)
          } catch (error: unknown) {
            deps.logger.warn(`[deepartments] onDelivered drain fire for ${recipientId} threw (non-fatal — the next wake/sweep re-evaluates): ${error instanceof Error ? error.message : String(error)}`)
          }
        }
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
          // DRENAJE (2026-09-10): same call-site family as the gate branch —
          // the 'failed' row is the pair-LATEST, so it must carry the intent
          // too. Reachable with `opts.noWake === true` only on a THROW that
          // escapes before `catalogRoute`'s own noWake handling (the noWake-
          // reroute path returns 'failed' WITHOUT a row — see the noWake gate
          // in `catalogRoute`): a genuine sidecar/write failure. The row is
          // what the sweep/drain/health read; a bare row would silently
          // re-classify a deliberate no-wake as crash-class. Consistency is
          // also what R6 requires of the two marks.
          // fb-2160 (2026-09-21): this is the ONE 'failed' row the engine writes
          // for a THROW — the crash class. It is marked with the DECLARED ground
          // `unreported` (never a fabricated class): the primitive's ground, when
          // it named one before throwing, is preferred.
          await deps.markFinal(record, recipientId, 'failed', finalMarkOpts('failed', opts.noWake === true, failedGroundOf ?? 'unreported'))
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

/** CONTEXT-ADMISSION GATE (2026-09-16, run token 7cf42c47) — THE READER of the
 * health actuator's durable marker. Returns the marker's frame WHEN the
 * recipient's LIVE session is EXACTLY the session the actuator flagged;
 * `undefined` in every other case (→ the delivery proceeds UNCHANGED).
 *
 * `<stateDir>/context-action.json` = `{ [agentId]: { sessionId, at, action,
 * phase, pct, … } }` — the flat, agentId-keyed file the actuator designed for
 * this consumer (its `sessionId` field is the discriminator this gate needs).
 *
 * THE COMPARISON IS THE GATE. `marker.sessionId === liveSessionId` AND ONLY
 * THEN defer. The ledger is keyed by agentId and survives 24 h while a post
 * ROTATES — comparing sessions is what prevents deferring a healthy SUCCESSOR.
 *
 * FAIL-OPEN BY CONSTRUCTION (never throws, never defers on doubt):
 *   - absent file (ENOENT) / unreadable / malformed JSON → undefined;
 *   - an entry without a non-empty string `sessionId`, or without a finite `at`
 *     (the same bar the actuator's own reader applies) → undefined;
 *   - a marker older than the actuator's own 24 h retention → undefined (a stale
 *     episode cannot shadow a fresh incarnation; the actuator prunes by the same
 *     window, and re-reading a pruned entry must not resurrect it);
 *   - a `liveSessionId` that cannot be established (empty/undefined from the
 *     route entry) → undefined: NO identity, NO defer;
 *   - ANY throw → undefined (a delivery must never break on a state file).
 *
 * The actuator's retention is re-declared here as a literal rather than
 * imported: `dshd-health` is OUTSIDE this package's lane (and importing
 * `dshd-core` → `dshd-health` would invert the dependency direction). The two
 * values are the same 24 h window; should the actuator change it, this gate
 * only becomes MORE conservative (an older marker stops deferring).
 * MODULE-PRIVATE on purpose (no export-surface growth — the frozen export-parity
 * pin holds by construction). */
const CONTEXT_ACTION_STATE_FILE = 'context-action.json'
const CONTEXT_ACTION_RETENTION_MS = 24 * 60 * 60 * 1000

async function contextAdmissionProbe(
  deps: DeliveryEngineDeps,
  recipientId: string,
  liveSessionId: string | undefined
): Promise<{ sessionId: string; action: string; phase: string; pct: number } | undefined> {
  // THE DISCRIMINATOR, first: without a known live session there is nothing to
  // compare against — deferring here would be the successor-blocking failure.
  // The route entry's own `sessionId` is the identity the engine is about to
  // materialize; the optional `liveSessionId` dep overrides it when a wiring can
  // resolve the handle's identity more precisely (absent → the entry's value).
  let anchor: string | undefined
  try {
    anchor = deps.liveSessionId?.(recipientId) ?? liveSessionId
  } catch (error: unknown) {
    deps.logger.warn(`[deepartments] context-admission gate: live-session probe for "${recipientId}" failed (the delivery proceeds UNCHANGED — fail-open, never defer on a probe error): ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  if (typeof anchor !== 'string' || anchor === '') return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await readFile(path.join(deps.stateDir, CONTEXT_ACTION_STATE_FILE), 'utf8')) as Record<string, unknown>
  } catch (error: unknown) {
    // ENOENT is the ordinary case (the actuator has never crossed a window) —
    // silent, exactly like the sibling sidecar reads of this module.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      deps.logger.warn(`[deepartments] context-admission gate: the context-action marker of ${deps.stateDir} could not be read (the delivery proceeds UNCHANGED — fail-open): ${error instanceof Error ? error.message : String(error)}`)
    }
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const raw = parsed[recipientId]
  if (raw === null || typeof raw !== 'object') return undefined
  const mark = raw as Record<string, unknown>
  if (typeof mark.sessionId !== 'string' || mark.sessionId === '') return undefined
  if (mark.sessionId !== anchor) return undefined // ← the successor case: NOT deferred
  if (typeof mark.at !== 'number' || !Number.isFinite(mark.at)) return undefined
  if (Date.now() - mark.at > CONTEXT_ACTION_RETENTION_MS) return undefined // stale episode
  return {
    sessionId: mark.sessionId,
    action: typeof mark.action === 'string' && mark.action !== '' ? mark.action : 'compact-or-rotate',
    phase: typeof mark.phase === 'string' && mark.phase !== '' ? mark.phase : 'beyond-usable-window',
    pct: typeof mark.pct === 'number' && Number.isFinite(mark.pct) ? mark.pct : 0
  }
}

/** fb-467 — the delivery-queue seq of ONE sidecar row parsed STRICTLY from its
 * `m-<seq>` id (module-private, engine side). `undefined` for a non-parseable
 * legacy id: the orphan discriminator below is fail-soft BY CONSTRUCTION — a row
 * whose queue position cannot be derived simply never fires it, so a legacy id
 * keeps the pre-fix behavior (the gate applies). */
function fb467StrictRowSeq(row: DeliveryRow): number | undefined {
  const match = /^m-(\d+)$/.exec(row.messageId)
  if (match === null) return undefined
  return Number(match[1])
}

/** fb-467 — the pair-LATEST row of ONE (messageId, recipientId) pair (the same
 * `latestPerKey` view the gate predicates use). Module-private, read-only. */
function fb467PairLatestRow(rows: readonly DeliveryRow[], messageId: string, recipientId: string): DeliveryRow | undefined {
  let latest: DeliveryRow | undefined
  for (const row of rows) {
    if (row.messageId !== messageId || row.recipientId !== recipientId) continue
    latest = row
  }
  return latest
}

/** fb-467 (2026-09-10 — the GATEADO-BEHIND-AN-ORPHAN lane, run token f76ac64b):
 * WHERE THE HEAD CLOSED — the ORPHAN-HEAD discriminator of the FIFO gate.
 * Returns the address at which the GATING HEAD already landed — the LIVE
 * SUCCESSOR this recipient's catalog route resolves — when:
 *   1. the recipient's route is a REROUTE (`resolveCatalogRoute` → kind
 *      'reroute': a RETIRED host-family address whose rotation chain resolves a
 *      live successor — fb-58 F-3 / m-331; `entry.hostId` IS that successor), and
 *   2. the gating head (the EARLIEST strictly-earlier seq whose pair-LATEST row
 *      at `recipientId` is still 'prepared' — the exact pair the gate fired on)
 *      ALREADY has a LANDED pair ('delivered'|'resumed') at that successor.
 *
 * That combination is the permanent ORPHAN RESIDUE: the head's content reached
 * the live successor through the re-route while its ADDRESSED pair kept its
 * write-ahead 'prepared' row (the DRENAJE terminalization needs the successor's
 * pair landed at the final mark and the successor lands +37 s later — the
 * measured window overlap of fb-117/fb-137, «filas `prepared` sin terminal»).
 * The addressed address can never receive again and never wakes, so retaining a
 * later delivery behind it parks the delivery FOREVER; the caller SKIPS the gate
 * for it (and the delivery lands at the successor, closing 'terminal' through
 * the SAME DRENAJE closure). The engine resolves the head from the parsed
 * sidecar itself — it has no store — and reads only `entry.hostId` as the other
 * recipient, so a multi-recipient fan-out sibling can never be mistaken for the
 * re-route.
 *
 * CONFINED TO THE REROUTE CLASS BY CONSTRUCTION: a SANE recipient (a live post
 * or a live host — kind 'post'/'host') can never satisfy (1), so its gate stays
 * byte-identical (the host's CONTROL gate of the lane) and costs ZERO reads.
 * FAIL-SOFT: any route or sidecar read error returns `undefined` → the gate
 * applies exactly as before (the ordering fix must never break a delivery).
 * MODULE-PRIVATE on purpose (see the import note: no export-surface growth). */
async function orphanHeadLandedAtSuccessor(
  deps: DeliveryEngineDeps,
  recipientId: string,
  seq: number
): Promise<string | undefined> {
  let route: CatalogRoute
  try {
    route = deps.resolveCatalogRoute(recipientId)
  } catch (error: unknown) {
    deps.logger.warn(`[deepartments] orphan-head discriminator: catalog route of "${recipientId}" could not be resolved (the FIFO gate applies — safe default): ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  if (route.kind !== 'reroute') return undefined
  const successorId = route.entry.hostId
  if (successorId === undefined) return undefined
  try {
    const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(deps.stateDir), 'utf8'))
    const latest = new Map<string, DeliveryRow>()
    for (const row of rows) latest.set(`${row.messageId}\u0000${row.recipientId}`, row)
    let head: DeliveryRow | undefined
    for (const row of latest.values()) {
      if (row.recipientId !== recipientId || row.status !== 'prepared') continue
      const rowSeq = fb467StrictRowSeq(row)
      if (rowSeq === undefined || rowSeq >= seq) continue
      if (head === undefined || rowSeq < (fb467StrictRowSeq(head) ?? Number.MAX_SAFE_INTEGER)) head = row
    }
    if (head === undefined) return undefined
    const landedAt = fb467PairLatestRow(rows, head.messageId, successorId)
    if (landedAt === undefined) return undefined
    if (landedAt.status !== 'delivered' && landedAt.status !== 'resumed') return undefined
    return successorId
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined // nothing ever sent
    deps.logger.warn(`[deepartments] orphan-head discriminator: the delivery sidecar read for ${recipientId} failed (the FIFO gate applies — safe default): ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

// ─── D270 (2026-09-23) — THE HEALTH-NOTICE SYSTEM EXEMPTION ───────────────────
// Host decision D270, TAKEN. `from = 'deepartments'` (the SYNTHETIC daemon
// origin the bundle's health/quality seams append with — it is never a
// registered post, so `aclDenyGround` classifies it `unclassified` and its
// conservative final branch denies EVERY recipient) is admitted ONLY for a
// HEALTH NOTICE that concerns the RECIPIENT'S OWN post — never for content.
//
// WHY THE EXEMPTION LIVES HERE AND NOT IN THE PURE PREDICATE: `aclDenyGround(sender,
// recipient)` (./acl.ts) takes TWO MEMBER PROFILES and therefore CANNOT SEE THE
// MESSAGE: an exemption conditioned on the notice's CONTENT is not expressible
// in its signature without changing it. `catalogRoute` is the seam where the
// RECORD is in scope (`record: MessageRecord`, the parameter below), and it is
// the seam that EXECUTES the denial (`opts.failedGround?.('acl')` +
// `return 'failed'`).
//
// THE ACL'S PURPOSE IS PRESERVED, NOT WEAKENED: the ACL exists to stop leakage
// BETWEEN DEPARTMENTS. A health notice about a post, addressed to THAT SAME
// post, discloses nothing the recipient does not already own — and without it
// the head cannot self-repair (it never learns that its own session is
// erroring). Content, and any notice about ANOTHER post, stay DENIED.
//
// THE EXEMPTION IS A CONJUNCTION OF FOUR INDEPENDENT, SEPARATELY VERIFIABLE
// CONDITIONS — no one of them alone admits anything:
//   (1) `record.from === 'deepartments'` — the synthetic daemon origin. NO agent
//       can author with it (every agent send stamps the caller's own id), and
//       the exemption additionally requires the denial ground to be EXACTLY
//       `'unclassified-sender'` (the daemon origin's own conservative branch) —
//       so it can never lift a real department-scoping ground;
//   (2) the record's TEXT matches one of the MEASURED health-notice FORMS below
//       (a recognized shape, never free prose);
//   (3) the post id CITED BY the notice === `recipientId` (the notice is about
//       THIS post) — the whole point of the exemption;
//   (4) `route.kind === 'post'` — a CATALOG POST recipient (a head or a worker).
//       The HOST route and the `reroute` branch are NOT exempted: the host alert
//       path (`healthNotifyHost` → `busDeliverToHost`) never travels this seam.
// An unparseable frame admits NOTHING (the conservative direction), and every
// non-exempt denial keeps its byte-identical warn + `failedGround('acl')` +
// `'failed'` (R6).

/** The synthetic daemon origin (the health/quality append sites' `from`). */
const DAEMON_ORIGIN_ID = 'deepartments'

/** The MEASURED health-notice forms of the daemon origin, each paired with its
 * emit site and its post-id capture (LITERAL frames, cited by `archivo:linea`):
 *   - `Turn-error` — `dshd-health/src/index.ts` `buildTurnErrorNotifyFrame`
 *     (`[From deepartments] Turn-error ${cls}: post ${postId} session …`),
 *     appended by `dshd-orchestration/src/tools.ts` `healthNotifyHead`;
 *   - `Quality-inspect` — `dshd-quality/src/index.ts` `qualityInspectDirectiveText`
 *     (`Quality inspect: <kind> (post ${postId}, …`), appended by the same
 *     package's emitter;
 *   - `post-error` — `dshd-health/src/index.ts` `buildHealthAlertFrame`
 *     (`- post-error: ${postId} (N in window)…`), the alert BULLET.
 * The optional `[From deepartments → <to>]: ` prefix covers the framed form
 * (the delivery frame of the same record); the id charset is the post-id
 * alphabet, so an id the frame cannot parse admits nothing. */
const HEALTH_NOTICE_FORMS: ReadonlyArray<{ cls: string; re: RegExp }> = [
  { cls: 'Turn-error', re: /^(?:\[From deepartments(?: → [^\]]+)?\]: )?\[From deepartments\] Turn-error [^:\n]+: post ([A-Za-z0-9._-]+)/ },
  { cls: 'Quality-inspect', re: /^(?:\[From deepartments(?: → [^\]]+)?\]: )?Quality inspect: [^\n]*?\(post ([A-Za-z0-9._-]+)/ },
  { cls: 'post-error', re: /(?:^|\n)- (?:CATCH-UP )?post-error: ([A-Za-z0-9._-]+)/ }
]

/** PURE — the health-notice class + the post id it concerns, or `undefined` when
 * the record is not a recognized health notice of the daemon origin. Never
 * throws (a non-string text degrades to `undefined`). */
function healthNoticeOf(record: MessageRecord): { cls: string; postId: string } | undefined {
  if (record.from !== DAEMON_ORIGIN_ID) return undefined
  const text = typeof record.text === 'string' ? record.text : ''
  for (const form of HEALTH_NOTICE_FORMS) {
    const match = form.re.exec(text)
    if (match !== null && match[1] !== undefined) return { cls: form.cls, postId: match[1] }
  }
  return undefined
}

/** PURE — whether THIS denial is the D270 system exemption: the ground is the
 * daemon origin's own `'unclassified-sender'`, the route is a CATALOG POST, the
 * record is a recognized health notice (2) and the notice concerns the RECIPIENT'S
 * OWN post id (3). Returns the notice class for the audit log, or `undefined`
 * (⇒ the denial applies, byte-identically). Never throws. */
function exemptOwnPostHealthNotice(
  ground: string | undefined,
  route: CatalogRoute,
  record: MessageRecord,
  recipientId: string
): { cls: string } | undefined {
  if (ground !== 'unclassified-sender') return undefined
  if (route.kind !== 'post') return undefined
  const notice = healthNoticeOf(record)
  if (notice === undefined || notice.postId !== recipientId) return undefined
  return { cls: notice.cls }
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
  opts: DeliverOrQueueOptions,
  /** DRENAJE (2026-09-10): additive out-param — the resolved route KIND, read
   * by the caller's final-mark seam (the reroute terminalization). Absent → the
   * caller simply does not learn the kind (safe default: no terminalization). */
  routeOut?: { kind?: string; successorId?: string; deferred?: boolean }
): Promise<DeliveryStatus> {
  const route = deps.resolveCatalogRoute(recipientId)
  if (route.kind === 'unknown') {
    deps.logger.warn(`[deepartments] bus delivery to unknown member "${recipientId}" (record ${record.id})`)
    opts.failedGround?.('unknown')
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
      opts.failedGround?.('acl')
      return 'failed'
    }
  } else {
    // The ground is computed ONCE and reused by the D270 exemption below.
    const ground = aclDenyGround(sender, deps.busProfileFor(recipientId))
    // D270 (2026-09-23) — THE HEALTH-NOTICE SYSTEM EXEMPTION (the block above
    // `HEALTH_NOTICE_FORMS` carries the whole rationale and the 4 conditions).
    const exempt = exemptOwnPostHealthNotice(ground, route, record, recipientId)
    if (exempt !== undefined) {
      // The ADMISSION is auditable: one info line naming the settled class, the
      // record and the recipient. Nothing else changes — the delivery falls
      // through to the UNMODIFIED ALWAYS-WAKE route below.
      deps.logger.info(`[deepartments] bus delivery to "${recipientId}" ADMITTED by the D270 health-notice exemption (record ${record.id}, sender ${record.from}, class ${exempt.cls}) — a system notice about the recipient's OWN post (spec 004 §5.6)`)
    } else if (ground !== undefined) {
      // The byte-identical pre-D270 denial (warn split host/other, ground, status).
      if (route.kind === 'host') {
        deps.logger.warn(`[deepartments] bus delivery to the host "${recipientId}" DENIED by the messaging ACL (record ${record.id}, sender ${record.from}) — a worker never writes to the Asistente (spec 004 §5.6/D6)`)
      } else {
        deps.logger.warn(`[deepartments] bus delivery to "${recipientId}" DENIED by the messaging ACL (record ${record.id}, sender ${record.from}) — skipped; it goes via the recipient's department head (spec 004 §5.6)`)
      }
      opts.failedGround?.('acl')
      return 'failed'
    }
  }
  // F1 — a RETIRED member is never woken/attempted (marked, never erased).
  if (route.kind === 'post' && route.entry.retired === true) {
    deps.logger.warn(`[deepartments] bus delivery to RETIRED member "${recipientId}" skipped (record ${record.id})`)
    opts.failedGround?.('retired')
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
      opts.failedGround?.('reroute')
      return 'failed'
    }
    return 'prepared'
  }
  // ─── CONTEXT-ADMISSION GATE (2026-09-16, run token 7cf42c47) ────────────────
  // THE READER of the durable marker the health actuator writes. Until this
  // gate, `<stateDir>/context-action.json` had NO production consumer: the
  // actuator (dshd-health) recorded that a session crossed its context window
  // and escalated to the manager, and the delivery seam then went on
  // MATERIALIZING turns into that very session — which can no longer accept a
  // request (`effective = projected + reserve > contextWindow` ⇒ the endpoint
  // rejects it ⇒ Turn-error, the self-fed loop the actuator cannot drain).
  //
  // WHAT IT DOES: DEFER the materialization — persist the record, do NOT wake —
  // instead of waking a session that provably cannot serve the turn. It is the
  // SAME shape as the WIRED `noWake` branch directly above (persist + queue, no
  // materialize), so the caller's final-mark seam settles the pair 'prepared'
  // and the record stays durable for the recipient's next REAL wake.
  //
  // THE DISCRIMINATOR (the whole reason this gate is safe): `sessionId`. The
  // marker ledger is keyed by `agentId` and SURVIVES 24 h, while a post that hit
  // the wall is ROTATED to a fresh, sane session. A gate that read the marker
  // WITHOUT comparing the session would DEFER THE SUCCESSOR — a healthy session
  // blocked for a whole day, the org-wide failure class. The comparison is
  // therefore not a detail: it is what separates «defer the one that is dying»
  // from «block a live one».
  //
  // THE MANAGER IS NEVER CONSULTED. MEASURED: the flagged post of the incident
  // (the quality head, 3 082 turn-errors / 15 dead generations) has NO
  // `managerId` — a head carries none (only workers do). An implementation that
  // deferred only posts with a manager would leave the measured victim with no
  // actor: the defer happens REGARDLESS of manager resolution.
  //
  // FAIL-OPEN, BY DOCTRINE (symmetric with the actuator's own conservative
  // rule «a finding WITHOUT `sessionId` produces NO action»): absent file,
  // unreadable file, malformed JSON, an entry without a usable `sessionId`/`at`,
  // a marker older than the actuator's own 24 h retention, or ANY throw in the
  // probe → NO defer, NO throw. A state file that may not exist must never break
  // a delivery.
  //
  // SCOPE OF THE DEFER: the ADDRESSED catalog recipient classes 'post' and
  // 'host' ONLY. A 'reroute' is EXCLUDED by construction: its entry is the LIVE
  // SUCCESSOR (a different, sane session), so deferring on the marker of the
  // retired addressed id would park a delivery whose real target is healthy.
  //
  // ─── D1 (2026-09-18, run token 1b1ca54c): THE PHASE DISCRIMINATOR ──────────
  // THE DEFECT THIS CLOSES (measured: 19 pairs retained 2 h 48 min 49,036 s
  // with the head ALIVE). The deferral's PREMISE is «the next request ALREADY
  // does not fit» — and the actuator declares TWO tiers with DIFFERENT
  // consequences (`dshd-health`, `ContextActionMark.phase`, VERBATIM):
  //   - `'beyond-usable-window'` (band b10, `effective > contextWindow`): «the
  //     next request is ALREADY REJECTED» ⇒ the premise is TRUE ⇒ DEFER;
  //   - `'advisory'` (band b9, `effective ≥ 90%` while NOT beyond): «the next
  //     request STILL FITS but the runway is thin … This is the ONLY tier whose
  //     act can still save the session» ⇒ the premise is FALSE ⇒ the session
  //     CAN serve the turn ⇒ materialize it.
  // The gate used to read `phase` ONLY to log it: it deferred on BOTH tiers. The
  // measured incident is exactly that — the actuator wrote an `advisory` mark at
  // 01:10:28.883Z, the gate matched the session, deferred, and sealed `noWake`
  // (`:1043`); the FIFO gate then read the head as `noWake` ⇒ `skip-nowake-head`
  // ⇒ NO wake armed, and the re-drive sweep SKIPS every sealed pair whose
  // recipient is not running — `messages.ts` (2834-line file), the sealed-pair sweep's skip: `if (row.noWake === true && this.deps.recipientRunning?.(row.recipientId) !== true) return` ⇒ NOTHING could release them
  // (a 24 h-lived, never-re-evaluated deferral). They drained only when a later
  // UNSEALED landing happened to fire the drain, after the head rotated.
  //
  // WHY GATING ON `phase` IS THE RIGHT DISCRIMINATOR (and not a heuristic): the
  // premise that justifies parking a live session's turn is a statement about
  // the NEXT REQUEST, and `phase` is precisely the actuator's own declared
  // answer to that question. An `advisory` deferral is premise-FALSE FROM THE
  // INSTANT IT IS WRITTEN, so no amount of re-evaluation could ever make it
  // right — it can only delay a turn the session was still able to serve.
  //
  // WHAT IS NOT CHANGED: the probe (`contextAdmissionProbe`, the marker reader
  // with its documented fail-open contract), the `sessionId` comparison itself
  // (`:1159` — the successor protection), the `sealNoWake` seam (`:1043`), the
  // FIFO gate branch, and `messages.ts`. Only the DOOR is narrowed.
  //
  // FAIL-OPEN, still: an absent `phase` reads as `beyond-usable-window` in the
  // probe's return (`:1165`) — a legacy/partial marker keeps the PRE-FIX
  // behavior (defer), so this change can never turn a «cannot serve» marker
  // into a materialization into a dead session.
  if (route.kind === 'post' || route.kind === 'host') {
    const deferred = await contextAdmissionProbe(deps, recipientId, route.entry.sessionId)
    if (deferred !== undefined && deferred.phase !== 'beyond-usable-window') {
      // THE ADVISORY PASS-THROUGH (D1): the premise of a deferral is FALSE in
      // this tier (the next request STILL FITS). The marker is still READ and
      // still matched — the probe ran, the session comparison held — but the
      // turn is MATERIALIZED normally: no `routeOut.deferred`, hence no
      // `noWake` seal, hence no unsealed-waker class. This log is the lane's
      // observability (the ledger does NOT record this class —
      // `appendGateLedgerRow` is only called on the FIFO-gate branch); the
      // EFFECT evidence is the SIDECAR (`deliveries.jsonl`).
      deps.logger.info(`[deepartments] [${FB467_INSTRUMENTATION_STAMP}] context-admission gate: NOT DEFERRING ${record.id} → ${recipientId} — the LIVE session ${deferred.sessionId} matched the marker, but its phase=${deferred.phase} (=${Math.round(deferred.pct * 100)}%) is the tier whose NEXT REQUEST STILL FITS (advisory/b9): deferring here would arm a premise that is false from the instant it is written, and the existing noWake seal + the sealed-pair sweep skip would leave the pair with NO waker (the D1 class: 19 pairs / 2 h 48 min with the recipient ALIVE). The turn is materialized normally.`)
    } else if (deferred !== undefined) {
      opts.contextDeferred?.({
        recipientId,
        sessionId: deferred.sessionId,
        action: deferred.action,
        phase: deferred.phase,
        pct: deferred.pct
      })
      // [fb-467 instrumentation stamp reuse — the SAME traceable version tag the
      // neighboring decision lines carry, so this defer is identifiable in the
      // log by the build that took it.]
      deps.logger.warn(`[deepartments] [${FB467_INSTRUMENTATION_STAMP}] context-admission gate: DEFERRING materialization for ${record.id} → ${recipientId} — the LIVE session ${deferred.sessionId} is the one the context actuator flagged (phase=${deferred.phase}, action=${deferred.action}, ${Math.round(deferred.pct * 100)}%): the turn is QUEUED ('prepared', NO wake) instead of being materialized into a session whose next request is already impossible. The record stays durable and drains at the recipient's next real wake (or a rotated successor).`)
      // Persist-and-queue: EXACTLY the wired noWake branch's outcome. The
      // DEFER INTENT is reported through the caller's out-param so the SINGLE
      // final-mark seam settles the pair with the `noWake` seal (see there):
      // without the seal the pair is CRASH-CLASS and the ~10-min prepared-stuck
      // sweep re-drives it into the same dead session forever — the measured
      // fb-150 spool (28 'prepared' rows / 0 terminals in ~2.4h). The seal is
      // the established vocabulary for «this 'prepared' is a DELIBERATE
      // no-wake-until-wake, never a crash» (m-707), which is exactly what a
      // deferral is.
      if (routeOut !== undefined) routeOut.deferred = true
      return 'prepared'
    }
  }
  // ALWAYS-WAKE (DEFAULT — the pre-step (c) behavior EXACTLY).
  // VALLE 09-07 (BATCH-DRAIN): the batch-eligibility TRANSPORT flag is threaded
  // from `deliverOrQueue` into the ALWAYS-WAKE primitives so the batch surface
  // (dshd-orchestration) can accumulate a running recipient's record instead of
  // splicing the inbox 1:1. 2026-09-21 (DEFAULT-FLIP, run token d46d84b7): the
  // flag is now the DECISION seam `isBatchEligible(opts)` — an ABSENT flag is
  // ELIGIBLE (every ALWAYS-WAKE no-interrupt delivery), so the daemon/system
  // notices, the agenda notices and the boot/sweep re-drive coalesce exactly
  // like `send_message` does; only an explicit `batchEligible: false` (or a
  // noWake/interrupt order) keeps the byte-identical 1:1 pre-batch opts.
  const interrupt: DeliveryInterruptOptions = {
    ...(opts.interrupt === true ? { interrupt: true } : {}),
    ...(isBatchEligible(opts) ? { batchEligible: true } : {}),
    ...(opts.failedGround !== undefined ? { failedGround: opts.failedGround } : {})
  }
  if (route.kind === 'post') {
    return deps.deliverPost(route.entry, framed, record, opts.senderSessionId, interrupt)
  }
  // DRENAJE (2026-09-10 — cierre del lado CORE, fix-forward): aquí vivía un
  // segundo bloque `if (route.kind === 'post')` BYTE-IDÉNTICO al de arriba. Era
  // CÓDIGO MUERTO (el primer `if` ya retorna ⇒ TS2367 «'"host" | "reroute"' y
  // '"post"' no se solapan» + TS2339 sobre `never`), no una copia con intención
  // distinta: eliminarlo NO cambia una sola entrega — el camino SANO (post →
  // deliverPost; host/reroute → deliverHost) queda byte-idéntico.
  const hostStatus = await deps.deliverHost(route.entry, framed, record, opts.senderSessionId, interrupt)
  // DRENAJE (2026-09-10 — the ORPHAN closure): report the resolved route KIND
  // through the caller's out-param, so `deliverOrQueue`'s SINGLE final-mark
  // seam knows this was a REROUTE and does not overwrite the retired pair with
  // a landed status (see the terminalization there). The status value itself is
  // returned UNCHANGED (this is an additive report; no row, no shape, and no
  // byte of the delivery result changes).
  if (routeOut !== undefined) {
    routeOut.kind = route.kind
    if (route.kind === 'reroute') routeOut.successorId = route.entry.hostId
  }
  return hostStatus
}
