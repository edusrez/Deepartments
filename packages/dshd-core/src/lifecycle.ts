// dsh-deepartments — the LIFECYCLE service (FASE 2 STEP f, the LAST carve):
// the dept_sleep / dept_memo_write SEMANTICS, the sleepEpoch marking policy, the
// host-rotation decision (delegating to ./session-rotation.js) and the journal /
// archive handling — extracted out of the invoke.ts monolith into a core module.
//
// The MODEL-FACING contract is UNCHANGED: the `dept_sleep` / `dept_memo_write`
// TOOLS are still registered in invoke.ts, but now DELEGATE to the single
// per-apply lifecycle service created via `createLifecycleService(ctx)`.
// AGENTS.md rule 4: NO module-global mutable state — all state is the injected
// `LifecycleCtx` (built once per apply inside invoke.ts) and the pure helpers.
//
// Behavior-neutral + MIGRATION-COMPATIBLE (R6): the posts.json/hosts.json
// `sleepEpoch` field, the journals format (`author:`/`room:`/`timestamp:`/
// `wake_counter:`/`last_wake:`/`board_cursor:` frontmatter + the summary body
// with the wake-routine footer) and the archive layout are byte-identical to
// the pre-carve code. NO zstd compression is added here (C1/dec4 deferred).
//
// NO export default (pitfall 0001 — breaks `inject`).
import path from 'node:path'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { PostEntry, HostEntry } from './registry.js'
import type {
  RotationPersistenceLike,
  WorkspaceRegistryLike,
  HostRotationOutcome,
  RotationDeps
} from './session-rotation.js'

/**
 * Build the single landing node for a host surface reset: the agent's journal
 * as a `user/message` whose `source` is `kind:'plugin' / form:'notice'` (NOT
 * `kind:'user'`) so it renders as a collapsed context/notice row in the GUI,
 * not as if the owner said it (the KEY property: `deriveMessages()` folds the
 * node's content verbatim on the next turn). The frame is bound via
 * `boundContextSummary` per the dsh-llm notice contract.
 *
 * MOVED VERBATIM from invoke.ts (was exported at the monolith's module scope).
 */
export function buildSleepJournalMessage(journalText: string) {
  return createUserMessage({
    content: [{ type: 'text', text: journalText }],
    source: {
      kind: 'plugin',
      plugin: 'deepartments',
      form: 'notice',
      summary: boundContextSummary('Reopened after sleep — in-place surface reset to your journal (long-term memory).')
    }
  })
}

/**
 * Whether the `webUiCleanupPending` marker may be CLEARED after a boot-time
 * cleanup run. The marker is cleared ONLY when the cleanup actually RAN AND the
 * GUI-critical truncation succeeded. A skipped report (host session live —
 * `skippedL:true, skipReason:'session-live'`) or a failed/absent truncate
 * (`truncateError` set / `truncate` undefined) KEEPS the flag so the NEXT boot
 * retries.
 *
 * MOVED VERBATIM from invoke.ts (was exported at the monolith's module scope).
 */
export function shouldClearCleanupPending(report: Pick<SleepCleanupReportLike, 'skipped' | 'truncate' | 'truncateError'>): boolean {
  return report.skipped !== true && report.truncate !== undefined && report.truncateError === undefined
}

/** The minimal structural report `shouldClearCleanupPending` inspects. */
export interface SleepCleanupReportLike {
  skipped?: boolean
  truncate?: unknown
  truncateError?: string
}

/** Durable path of one member's long-term memory journal (MOVED from invoke.ts's
 * `journalPathFor` closure, which bound `config.stateDir`; this pure form takes
 * the state dir explicitly so the core module owns the path policy). */
export function journalPathFor(stateDir: string, memberId: string): string {
  return path.join(stateDir, 'journals', `${memberId}.md`)
}

/** The QUALITY INSPECT directive surface the lifecycle passes to
 * `maybeEmitQualityInspectDirective` (structurally identical to invoke.ts's
 * `QualityInspectDirectiveSurface`; kept here so the core module needs no import
 * edge back into invoke.ts). */
export type LifecycleQualityInspectSurface =
  | { kind: 'worker-retired'; workerPostId: string; sessionId: string; archived: boolean }
  | { kind: 'head-slept'; headPostId: string; sessionId: string; sleepEpoch: number }
  | { kind: 'host-rotated'; oldSessionId: string; newSessionId: string; oldHostId: string; newHostId: string; sleepEpoch: number; archiveOk?: boolean }
  | { kind: 'post-error'; postId: string; messageId: string; error: string }

/** The DSH session-header positional origin shape the sleep guard inspects
 * (mirrors invoke.ts's private `SessionHeaderWithOrigin`). */
interface SessionHeaderWithOrigin {
  origin?: unknown
  parentSession?: unknown
  delegationDepth?: unknown
  meta?: { origin?: unknown; parentSession?: unknown; delegationDepth?: unknown }
}

/** The minimal tool run context the lifecycle service consumes. `agent.session`
 * is intentionally loose so the core module need not hard-depend on dsh-session
 * types; the callers cast the same way invoke.ts did. */
export interface LifecycleExecLike {
  agent?: {
    id?: unknown
    session?: {
      header?: unknown
      seq?: unknown
      append?: (type: string, data: unknown, opts?: { surfaceOp?: string }) => unknown
    }
  }
  concludeTurn?: () => void
}

/** The injected dependency surface of ONE lifecycle service. Built once per
 * apply inside invoke.ts from that closure's live state (registry maps, journal
 * I/O, teardown helpers, rotation seam) and passed to `createLifecycleService` —
 * never module-global (AGENTS.md rule 4). */
export interface LifecycleCtx {
  // Registry + resolvers.
  byPost: Map<string, PostEntry>
  hosts: Map<string, HostEntry>
  hostForSession: Map<string, string>
  postIdForChild: (id: string) => string | undefined
  hostIdForSession: (id: string) => string
  ensureHost: (sessionId: string, roomId: string) => string
  persistPosts: () => Promise<void>
  persistHosts: () => void
  // Journal I/O (the session-memory-archive machinery stays in invoke.ts; the
  // lifecycle service owns the sleep/memo SEMANTICS and delegates I/O in).
  journalPath: (memberId: string) => string
  writeJournal: (
    memberId: string,
    roomId: string,
    summary: string,
    decisions: string[],
    constraints: string[],
    openItems: string[],
    currentStep: string | undefined,
    archive?: { sessionId?: string; wakeCounter?: number; archiveSeq?: string; lastWakeMs?: number; boundarySeq?: number }
  ) => Promise<string>
  readJournal: (memberId: string) => Promise<string | undefined>
  bumpHostSleepCounter: (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }) => Promise<string>
  bumpPostSleepCounter: (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }) => Promise<string>
  // Teardown + directive seams.
  archivePostSessionOnSleep: (sessionId: string) => Promise<boolean>
  disposeHeadHandleOnce: (sessionId: string) => Promise<void>
  maybeEmitQualityInspectDirective: (surface: LifecycleQualityInspectSurface) => Promise<void>
  // Host-rotation + deferred wake-surface seams.
  runHostRotation: (deps: RotationDeps) => Promise<HostRotationOutcome>
  deptGet: (key: string) => unknown
  stateDir: string
  deferredSleepReplace: Map<string, string>
  wakePackInjected: Set<string>
  buildSleepJournalMessage: (journalText: string) => unknown
  logger: { warn: (msg: string) => void; error: (msg: string) => void; info?: (msg: string) => void }
}

/** The lifecycle service — ONE per apply, constructed with its deps injected
 * (the `LifecycleCtx` is built once per apply by invoke.ts and closes the
 * service over it — AGENTS.md rule 4, no module-global mutable state). Exposes
 * the dept_memo_write / dept_sleep semantics the tools delegate to. All methods
 * are behavior-identical to the pre-carve invoke.ts tool bodies. */
export interface LifecycleService {
  /** dept_memo_write core. `hostAware` selects the two member-resolution shapes
   * (a post own-layer tool uses the `'unknown'` fallback; the host-plane tool
   * falls back to `hostIdForSession`). */
  memoWrite(args: { summary: string; decisions?: string[]; constraints?: string[]; openItems?: string[]; currentStep?: string }, exec: LifecycleExecLike, hostAware: boolean): Promise<{ room: string; member: string; memoPath: string }>
  /** dept_sleep core for a registered post (head or worker) — the head own-layer
   * tool body. */
  sleepMember(_args: Record<string, never>, exec: LifecycleExecLike): Promise<{ room: string; member: string; memoPath: string; sleepEpoch: number }>
  /** dept_sleep core on the host plane — the subagent guard + HOST ROTATION
   * branch + legacy-in-place fallback + (preserved) head-path fallback. */
  sleepHost(_args: Record<string, never>, exec: LifecycleExecLike): Promise<{ room: string; member: string; memoPath: string; sleepEpoch: number }>
  /** dept_sleep_all core (B1) — the org-wide quiet-sleep orchestration the
   * Asistente owns. For every CONFIGURED department head entry (root permanent
   * head, never a disposable worker), EXCLUDING `quality-head` (stays live as
   * the QD inspector — the D-Q7 anti-loop) and excluding already-slept no-ops,
   * it mimics the `sleepMember` marking: set `entry.sleepEpoch = Date.now()`,
   * record the head's in-flight worker ledger, `await persistPosts()` ONCE for
   * the whole batch, and dispose each live AgentHandle fire-and-forget (the
   * injected `disposeHeadHandleOnce` seam). It does NOT emit per-head QD
   * `head-slept` directives (a batch must not re-wake QH once per head) —
   * callers wanting the single-agent QD behavior use `sleepMember`. Never
   * throws; idempotent on an already-slept head (no-op). Returns the summary:
   * `slept` = heads newly marked, `skipped` = already-slept heads (no-op). */
  sleepAll(_args: Record<string, never>, exec: LifecycleExecLike): Promise<{ slept: number; skipped: number }>
}

/** Build the single per-apply lifecycle service (FASE 2 STEP f), closing over
 * the injected `LifecycleCtx`. */
export function createLifecycleService(ctx: LifecycleCtx): LifecycleService {
  return {
    async memoWrite(args, exec, hostAware) {
      const agent = exec.agent
      if (!agent) throw new Error('dept_memo_write requires a calling agent (exec.agent was undefined)')
      const memberId = hostAware
        ? (ctx.postIdForChild(agent.id as string) ?? ctx.hostIdForSession(agent.id as string))
        : (ctx.postIdForChild(agent.id as string) ?? 'unknown')
      const entry = ctx.byPost.get(memberId)
      const hostEntry = ctx.hosts.get(memberId)
      const roomId = hostAware
        ? (entry?.roomId ?? hostEntry?.roomId ?? 'board')
        : (entry?.roomId ?? 'unknown')
      const memoPath = await ctx.writeJournal(memberId, roomId, args.summary, args.decisions ?? [], args.constraints ?? [], args.openItems ?? [], args.currentStep, { sessionId: agent.id as string })
      return { room: roomId, member: memberId, memoPath }
    },

    async sleepMember(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('dept_sleep requires a calling agent (exec.agent was undefined)')
      const memberId = ctx.postIdForChild(agent.id as string)
      if (memberId === undefined) throw new Error('[deepartments] dept_sleep is for a department head (registered post), not the host')
      const entry = ctx.byPost.get(memberId)
      if (entry === void 0) throw new Error(`[deepartments] dept_sleep: "${memberId}" is not a registered post`)
      const journal = await ctx.readJournal(memberId)
      if (journal === void 0 || journal.trim() === '') {
        throw new Error('[deepartments] dept_sleep requires a saved journal — call dept_memo_write to save your memory first')
      }
      // Fix (head-sleep idempotency): an ALREADY-SLEPT head carries a durable
      // sleepEpoch mark. A RE-ISSUED dept_sleep directive on it is a NO-OP —
      // return the already-slept state WITHOUT re-running the teardown (no
      // re-mark, no re-persist, no re-archive, no re-dispose, no re-wake-counter
      // bump). The head stays slept; only its next bus wake mints a fresh session.
      if (entry.sleepEpoch !== void 0) {
        return { room: entry.roomId, member: memberId, memoPath: ctx.journalPath(memberId), sleepEpoch: entry.sleepEpoch }
      }
      // Head/worker wake_counter parity (owner decision: heads + workers, so
      // BOTH a manager head and a disposable worker route here through the
      // own-layer dept_sleep — the host never does, it is rejected above).
      // Bump the ordinal at this SAME seed boundary the host uses (see
      // bumpHostSleepCounter/bumpPostSleepCounter): the counter advances
      // exactly +1 on disk BEFORE the handle is disposed, so the next wake's
      // fresh materialization (cold resume from the journal) reads the
      // incremented ordinal — mirroring host semantics.
      await ctx.bumpPostSleepCounter(memberId, journal, { sessionId: agent.id as string, roomId: entry.roomId, boundarySeq: entry.boundarySeq })
      // Mark first (durable), then dispose the live AgentHandle. Dispose
      // tears the agent+session OUT of the in-memory registry (rc.8
      // dsh-agent-loop prepare() dispose: it detaches `agents.enter`/
      // `sessions.enter` registrations only, NOT the sessionPersistence
      // backend), so the durable session survives and the next wake resumes it.
      // The registry keeps the head wakeable-while-asleep via sleepEpoch.
      // F8 ghost-row fix (owner 2026-08-23): archive the session the head is
      // ACTUALLY running in (agent.id), NOT the registry's entry.sessionId. A
      // stale reload can leave entry.sessionId pointing at the PREVIOUS
      // (already-archived) incarnation while the head really runs in a FRESH
      // one — archiving the stale id hides nothing and leaves the CURRENT row
      // as a sidebar ghost. Converge the registry to the real session id
      // BEFORE the durable persist so the CURRENT session is archived and the
      // next wake traces the correct previous incarnation.
      const sessionId = String(agent.id)
      entry.sessionId = sessionId
      entry.sleepEpoch = Date.now()
      // Task T1 — persist the session-event `seq` at this sleep boundary so the
      // NEXT cycle's session-log capture can slice EXACTLY by seq (`seq >
      // boundarySeq`), clock-independent.
      const boundarySeq = (agent.session as { seq?: number } | undefined)?.seq
      if (boundarySeq !== undefined) entry.boundarySeq = boundarySeq
      // Fix (head-sleep worker drain): durably mark the head's IN-FLIGHT workers
      // (provider==='worker' && managerId===headId && retired!==true) on the
      // head entry BEFORE the sleepEpoch persist — so the sleep is handed off
      // through the SAME persistPosts write with a durable "n workers in flight"
      // ledger. The boot reconcile reads this to reap/flag any worker whose
      // manager is still dormant.
      const inflight: string[] = []
      for (const candidate of ctx.byPost.values()) {
        if (candidate.provider === 'worker' && candidate.managerId === memberId && candidate.retired !== true) inflight.push(candidate.postId)
      }
      if (inflight.length > 0) entry.inflightWorkers = inflight
      // Fix (head-sleep idempotency/rotation-race): AWAIT the durable persist so
      // the sleepEpoch mark is on-disk BEFORE any async teardown step that a
      // host-session rotation / service restart could abort. The mark is the
      // durable part; if the archive fails to seal (or a restart lands during
      // the archive), the boot reconcile re-seals.
      await ctx.persistPosts()
      // F8 (spec 002 head rotation) — ARCHIVE the slept head's durable session
      // server-side so the SIDEBAR ROW disappears (the journal + messages stay
      // intact — archive never deletes). HEAD-ONLY: a disposable WORKER is
      // retired via dept_worker_retire and keeps the legacy cold-resume — a
      // worker dept_sleep is NOT rotated. Non-fatal by design. AWAITED so the
      // row-hide SEALS before the dispose fires.
      if (entry.provider !== 'worker') {
        await ctx.archivePostSessionOnSleep(sessionId)
      }
      // Fix sleep-self-deadlock (2026-08-23): NEVER await our own handle's
      // dispose from our own turn — the harness dispose() sends machine.cancel
      // + `await machine.whenIdle()`, i.e. it waits for the very driver that is
      // currently executing this tool (invariant self-deadlock). Fire it (the
      // retirePost precedent) so the tool returns immediately, the turn/end
      // settles and the dispose's whenIdle then resolves. The dispose stays
      // NON-awaited (fire-and-forget) AND is dispatched BEFORE the (async) QD
      // directive below, so a host-session rotation landing on that directive
      // await can no longer abort the detach.
      void ctx.disposeHeadHandleOnce(sessionId)
      // QD (spec 007 §6.2, D-Q3): the HEAD-sleep MANDATE — a department head
      // archive is inspected at 100% for ANY head EXCEPT the QD's own
      // coordinator ('quality-head'). Emits an ADDRESSED QUALITY INSPECT
      // directive to quality-head. Non-fatal; Runs AFTER the dispose dispatch.
      //
      // DEADLOCK FIX (incident 2026-08-26 — the frozen-bus cascade): this
      // await is SAFE ONLY because materializePost's detach join is BOUNDED
      // (src/invoke.ts joinHeadDisposeOnce — the same commit). The emit
      // delivers via busDeliverToPost → materializePost; when the directive
      // TARGET is a just-slept head (the QH self-case — the QH's own
      // 'head-slept' directive in the D-Q2 dice path — or ANY head once the
      // target machine is slept), that materialization JOINS the in-flight
      // detach just dispatched above — the very detach whose whenIdle cannot
      // settle while THIS turn is still executing the tool (the self-deadlock
      // contract documented above). Pre-fix that join was UNBOUNDED: it froze
      // the sleep turn forever, its detach then never settled, and EVERY
      // subsequent bus delivery to the slept head joined the zombie detach
      // (the send_message that froze the host on 2026-08-26 21:18Z — the QH
      // self-sleep had frozen the bus an hour earlier at 20:48Z). With the
      // bounded join the delivery resolves within the bound (the zombie
      // detach self-heals: the sleep return ends the turn → whenIdle settles)
      // — the sleep may be delayed by at most the bound when a zombie exists,
      // it can never freeze.
      if (entry.provider !== 'worker') {
        await ctx.maybeEmitQualityInspectDirective({ kind: 'head-slept', headPostId: memberId, sessionId, sleepEpoch: entry.sleepEpoch })
      }
      return { room: entry.roomId, member: memberId, memoPath: ctx.journalPath(memberId), sleepEpoch: entry.sleepEpoch }
    },

    async sleepHost(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('dept_sleep requires a calling agent (exec.agent was undefined)')
      // ---- Task T4: REFUSE a TRANSIENT SUBAGENT. A one-shot delegated worker
      // has no durable post identity and must NEVER enter the host sleep/reset
      // branch below — which would misclassify it as a HOST and bump a bogus
      // `host-<subagentUuid>` wake counter. `origin === 'subagent'` is set only
      // on startContinuable children; registered members carry origin undefined
      // and are unaffected. Fail loud; no context reset.
      const deptSleepHeader = agent.session?.header as SessionHeaderWithOrigin | undefined
      const deptSleepOrigin = deptSleepHeader?.origin ?? deptSleepHeader?.meta?.origin
      if (deptSleepOrigin === 'subagent') {
        ctx.logger.warn(`[deepartments] dept_sleep refused for transient subagent ${agent.id as string}`)
        throw new Error('dept_sleep is refused for a transient delegated subagent — a subagent cannot sleep; its task ends with the settlement notice (role-scoped context reset is not supported).')
      }
      const memberId = ctx.postIdForChild(agent.id as string)

      // ---- U2: HOST branch (the sleeping Asistente) — SESSION ROTATION ------
      if (memberId === undefined) {
        const sessionId = agent.id as string
        const hostId = ctx.hostIdForSession(sessionId)
        const existing = ctx.hosts.get(hostId)
        const journal = await ctx.readJournal(hostId)
        if (journal === void 0 || journal.trim() === '') {
          throw new Error(`[deepartments] dept_sleep requires a saved journal — call dept_memo_write to save your memory first (no journal for host ${hostId})`)
        }
        // S1 — journal REQUIRED. S1.5 (unchanged) — advance the HOST's wake
        // ordinal at the sleep boundary, BEFORE the rotation, so the NEXT wake's
        // fresh context (seeded from the re-keyed journal) already shows the
        // incremented counter. bumpHostSleepCounter persists the bump atomically
        // on the OLD file and returns the bumped content the rotation re-keys.
        const seeded = await ctx.bumpHostSleepCounter(hostId, journal, { sessionId, roomId: existing?.roomId ?? 'board', boundarySeq: ctx.hosts.get(hostId)?.boundarySeq })
        // U2 — perform the ROTATION (S1.5b re-keyed journal → S2 server-side
        // session creation → S2.5 server-side archive → S2.7 evidence copy →
        // S3/S7 hosts.json rotation with the durable markers). S6 (the old
        // session's wake-pack flag) + S8 (concludeTurn) stay HERE.
        const boundarySeqAtSleep = (agent.session as { seq?: number } | undefined)?.seq ?? ctx.hosts.get(hostId)?.boundarySeq
        const deptSleepPersistence = ctx.deptGet('sessionPersistence') as (RotationPersistenceLike & { root?: string }) | undefined
        const deptSleepSessionsRoot = typeof deptSleepPersistence?.root === 'string' && deptSleepPersistence.root !== ''
          ? deptSleepPersistence.root
          : path.join(ctx.stateDir, '..', 'sessions')
        const rotation = await ctx.runHostRotation({
          oldSessionId: sessionId,
          oldHostId: hostId,
          roomId: existing?.roomId ?? 'board',
          seededJournal: seeded,
          journalsDir: path.join(ctx.stateDir, 'journals'),
          workspacePath: (agent.session?.header as { cwd?: string } | undefined)?.cwd ?? process.cwd(),
          boundarySeq: boundarySeqAtSleep,
          persistence: deptSleepPersistence,
          workspaceRegistry: ctx.deptGet('workspaceRegistry') as WorkspaceRegistryLike | undefined,
          sessionsRoot: deptSleepSessionsRoot,
          archiveDir: path.join(path.dirname(deptSleepSessionsRoot), 'archive'),
          hosts: ctx.hosts,
          hostForSession: ctx.hostForSession,
          persistHosts: ctx.persistHosts,
          logger: ctx.logger
        })
        if (rotation.rotated) {
          // S6 — retired identity: the OLD session never gets the wake pack
          // again; the NEW session's per-process set is empty by definition.
          ctx.wakePackInjected.delete(sessionId)
          // S8 — conclude the sleeping Asistente's turn.
          if (typeof (exec as { concludeTurn?: unknown }).concludeTurn === 'function') {
            (exec as { concludeTurn: () => void }).concludeTurn()
          }
          // QD (spec 007 §6.3, D-Q3): the HOST-rotation MANDATE — a host session
          // rotation is inspected at 100%. Emits an ADDRESSED QUALITY INSPECT
          // directive to quality-head. Non-fatal. Do NOT move this into
          // session-rotation.ts (bus-less). DEADLOCK FIX (2026-08-26): same
          // rationale as the head-sleep directive above — the await is safe
          // ONLY because materializePost's detach join is BOUNDED (the same
          // commit); a zombie target delays it by at most the bound, it can
          // never freeze the rotation.
          await ctx.maybeEmitQualityInspectDirective({
            kind: 'host-rotated',
            oldSessionId: sessionId,
            newSessionId: rotation.newSessionId,
            oldHostId: hostId,
            newHostId: rotation.newHostId,
            sleepEpoch: rotation.sleepEpoch,
            archiveOk: rotation.archive?.ok === true
          })
          return { room: existing?.roomId ?? 'board', member: rotation.newHostId, memoPath: rotation.newJournalPath, sleepEpoch: rotation.sleepEpoch }
        }
        // FALLBACK — the legacy IN-PLACE path, reachable ONLY when the rotation
        // cannot run (missing/partial persistence seam or a re-key / seed-
        // persist failure — spec §3.6 crash tolerance).
        ctx.logger.error(`[deepartments] dept_sleep: host session ROTATION could not run (${rotation.reason}); falling back to the legacy in-place reset (journal append + deferred fold + webUiCleanupPending)`)
        // Step 2 — register/refresh the durable host identity.
        ctx.ensureHost(sessionId, existing?.roomId ?? 'board')
        const hostEntry = ctx.hosts.get(hostId) as HostEntry
        // Step 3 — in-place surface reset, DEFERRED to the wake pre-step (Fix A):
        // append the journal node NOW as a PLAIN append, but DO NOT run the
        // full-window replace here. Replacing at close would shadow the
        // assistant message carrying the dept_sleep tool-call while the harness
        // still appends the tool's own result AFTER the replace — orphaning a
        // role:'tool' node. The full-window replace is DEFERRED: the intent is
        // recorded in `deferredSleepReplace` and the NEXT `agent/pre-step`
        // performs it over ALL current nodes INCLUDING the pending tool result.
        const session = agent.session
        if (session !== undefined && typeof session.append === 'function') {
          const message = ctx.buildSleepJournalMessage(seeded)
          session.append('user/message', message, { surfaceOp: 'append' })
          ctx.deferredSleepReplace.set(sessionId, seeded)
          // Fix wake-12: mirror the in-memory intent into the DURABLE host entry
          // so a process restart BETWEEN this dept_sleep and the wake pre-step
          // still folds the surface at the first pre-step of the new process.
          hostEntry.deferredJournalSeed = seeded
        }
        // Step 3.5 — web-UI sleep cleanup marker (Option A): record the pending
        // flag ONLY. The physical cleanup (truncate the host session artifact,
        // reset its projcache row, archive+delete the child subagent dirs) must
        // NOT run in this live process. The next BOOT performs it exactly once
        // and clears this flag.
        hostEntry.webUiCleanupPending = true
        // Batch C — the wake context pack is NO LONGER frozen into the surface
        // at dept_sleep. It is now injected FRESH at the next `agent/pre-step`.
        // Clear the wake-pack presence flag so the next wake's first pre-step
        // re-injects.
        ctx.wakePackInjected.delete(sessionId)
        // Step 4 — ONLY AFTER the surface append is committed, set+persist the
        // durable sleep marker ("the Asistente slept at T"). This ordering closes
        // the crash window where sleepEpoch was durably persisted but the journal
        // had NOT been injected into the live surface yet.
        hostEntry.sleepEpoch = Date.now()
        // Task T1 — persist the session-event `seq` at this sleep boundary
        // (immediately after the boundary append).
        const hostBoundarySeq = (agent.session as { seq?: number } | undefined)?.seq
        if (hostBoundarySeq !== undefined) hostEntry.boundarySeq = hostBoundarySeq
        ctx.persistHosts()
        // Step 5 — conclude the sleeping Asistente's turn.
        if (typeof (exec as { concludeTurn?: unknown }).concludeTurn === 'function') {
          (exec as { concludeTurn: () => void }).concludeTurn()
        }
        return { room: hostEntry.roomId, member: hostId, memoPath: ctx.journalPath(hostId), sleepEpoch: hostEntry.sleepEpoch }
      }

      // ---- head path (a registered post calling the host plane — preserved,
      // effectively a no-op today since heads call their own-layer tool). ----
      const entry = ctx.byPost.get(memberId)
      if (entry === void 0) throw new Error(`[deepartments] dept_sleep: "${memberId}" is not a registered post`)
      const journal = await ctx.readJournal(memberId)
      if (journal === void 0 || journal.trim() === '') {
        throw new Error('[deepartments] dept_sleep requires a saved journal — call dept_memo_write to save your memory first')
      }
      entry.sleepEpoch = Date.now()
      ctx.persistPosts()
      return { room: entry.roomId, member: memberId, memoPath: ctx.journalPath(memberId), sleepEpoch: entry.sleepEpoch }
    },

    async sleepAll(_args, _exec) {
      // B1 — org-wide quiet-sleep orchestration. Mirrors the `sleepMember`
      // marking (sleepEpoch + in-flight worker ledger) for EVERY configured
      // department head entry, but excludes `quality-head` (stays LIVE as the
      // QD inspector — the D-Q7 anti-loop) and emits NO per-head QD
      // `head-slept` directive (a batch must not re-wake QH once per head).
      // Non-fatal / never-throws; idempotent on an already-slept head (no-op).
      let slept = 0
      let skipped = 0
      const toDispose: string[] = []
      try {
        const now = Date.now()
        for (const entry of ctx.byPost.values()) {
          // Only a CONFIGURED permanent department head — the `provider !==
          // 'worker'` discriminator is exactly what `sleepMember` uses to select
          // the archive/dispose head path (a configured head has NO provider; a
          // disposable worker carries `provider: 'worker'` and is NEVER slept by
          // the org-wide batch). A retired entry is out of scope (a retired head
          // is re-materialized by config at boot, not slept here).
          if (entry.provider === 'worker') continue
          if (entry.retired === true) continue
          // quality-head EXCLUDED — the QD coordinator stays live as the
          // inspector (the anti-loop: a batch must never put the QH to sleep).
          if (entry.postId === 'quality-head') continue
          // Idempotent: an ALREADY-SLEPT head is a NO-OP (never re-mark, never
          // re-persist, never re-dispose) — it stays slept until its next bus
          // wake. Count it as skipped.
          if (entry.sleepEpoch !== void 0) { skipped += 1; continue }
          // Fix (head-sleep worker drain): durably record the head's IN-FLIGHT
          // workers (provider==='worker' && managerId===headId && !retired) on
          // the entry — the same ledger `sleepMember` writes — so the org-wide
          // sleep hands the batch off through the SAME persistPosts write.
          const inflight: string[] = []
          for (const candidate of ctx.byPost.values()) {
            if (candidate.provider === 'worker' && candidate.managerId === entry.postId && candidate.retired !== true) inflight.push(candidate.postId)
          }
          if (inflight.length > 0) entry.inflightWorkers = inflight
          entry.sleepEpoch = now
          toDispose.push(entry.sessionId)
          slept += 1
        }
        // ONE durable write for the whole batch (every sleepEpoch mark lands
        // together — the atomic sleep-all). A no-op batch (nothing new slept)
        // SKIPS the redundant write.
        if (slept > 0) await ctx.persistPosts()
        // Dispose each live AgentHandle fire-and-forget (reuse the injected
        // seam). The already-slept heads were skipped above, so only the
        // CURRENTLY-live handles are detached; a dispose failure is non-fatal to
        // the batch (the durable sleepEpoch mark is already committed).
        for (const sessionId of toDispose) {
          try { void ctx.disposeHeadHandleOnce(sessionId) } catch { /* non-fatal */ }
        }
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] dept_sleep_all: batch sleep failed (${slept} head(s) already marked in-memory; any on-disk write is best-effort): ${error instanceof Error ? error.message : String(error)}`)
      }
      return { slept, skipped }
    }
  }
}
