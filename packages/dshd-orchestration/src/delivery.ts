/**
 * Deepartments — DECOUPLING SUB-PASO 2: the DELIVERY ORCHESTRATION FACTORY
 * (HITO 3 DECOUPLING, brief step 3 — delivery/ACL/QD/lifecycle/engine, ~1089
 * LOCs of `applyInvoke`).
 *
 * MOVEMENT-ONLY. The delivery zone of `applyInvoke` (src/invoke.ts 7164-8252:
 * the bus boot + post/host deliveries + QD hooks + fb-11 rotation wake + the
 * sleep/wake/rotate LIFECYCLE carve + the F2 messaging ACL + the catalog/child
 * routes + the DELIVERY ENGINE) is hoisted VERBATIM into this factory, and
 * `applyInvoke` invokes it via `createDeliveryOrchestration` AT THE SAME FIBER
 * POSITION — the same closures, the same order, the same semantics (0 behavior
 * change). The state these closures read/mutate is the SAME by-reference
 * maps/registries passed in `deps`.
 *
 * Pattern (the PASO 1 proof): closures hoisted → the bundle REGISTERS them in
 * the baseline Binder buckets (bus/deliver/wakepack/lifecycle/redeliver — the
 * register call in invoke.ts consumes the SAME closure names, now produced
 * here; the binder-contract lock is untouched) → the bundle invokes the
 * REGISTERED SERVICES (deepartments.bus / .deliver / .lifecycle / .acl) at the
 * same positions with the inline R6 fallbacks preserved when dshd-core is
 * absent (minimal/hermetic compositions — behavior-neutral).
 *
 * The bundle stays a PURE SERVICE CONSUMER: this factory performs NO
 * ctx.provide (the P1 "the bundle consumes, never provides" invariant + the
 * smoke-boot service set stay untouched). The `deepartments.delivery` service
 * surface the brief planned via ctx.provide is deferred to the hito-4 package
 * migration (see the sub-paso 2 report) — the seams it would expose are
 * already the returned DeliverySurface members.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

// LANE 0.2.2 (gap 2) — the bundle bridges resolve to the owning packages
// directly (registry/messages/delivery/acl/lifecycle/session-rotation/wakepack
// → dshd-core, feedback → dshd-feedback, health → dshd-health, quality →
// dshd-quality); the org config types come from the local org-types.js mirror.
import {
  HOST_ID_PREFIX,
  HEAD_SESSION_PREFIX,
  readDurableHostEntries,
  pickLiveHostEntry,
  isHostRetiredOnDisk,
  followRotationChainToLive
} from 'dshd-core'
import { mintFreshSessionIdNotArchived, mintWorkerSessionId } from 'dshd-core'
import { isArchivedSession } from 'dshd-core'
import type { WorkspaceRegistryLike } from 'dshd-core'
import type { PostEntry, HostEntry, HostEntryLike } from 'dshd-core'
import { MessagesStore, markDelivery, parseDeliveryRows, resolveDeliveriesPath, hasEarlierPendingPair, gatingHeadIsNoWake, deliveryStatus } from 'dshd-core'
import type { DeliveryRow } from 'dshd-core'
import type { DeliveryStatus, MessageRecord } from 'dshd-core'
import { createDeliveryEngine } from 'dshd-core'
import type {
  DeliveryEngine,
  DeliveryInterruptOptions,
  BusMemberProfile,
  CatalogRoute,
  AclSurface,
  BusSurface,
  BusDeliveryFailedGround
} from 'dshd-core'
import { busProfileFor as aclBusProfileFor, aclDenyGround as aclDenyGroundImpl } from 'dshd-core'
import type { BusCatalogLens } from 'dshd-core'
import { FeedbackStore } from 'dshd-feedback'
import type { FeedbackTipo, FeedbackSeveridad } from 'dshd-feedback'
import { createLifecycleService, buildSleepJournalMessage } from 'dshd-core'
import type { LifecycleService } from 'dshd-core'
import { runHostRotation } from 'dshd-core'
import {
  safeInterrupt,
  postErrorClass,
  appendPostErrorDeduped,
  POST_ERROR_RECORD_KEY_PREFIX,
  resetHostMaterializeFailures,
  isSessionNotFoundError,
  readMaterializeState,
  markHostMaterializeFailure,
  writeMaterializeState,
  MATERIALIZE_QUARANTINE_N,
  MATERIALIZE_QUARANTINE_MS,
  markUnusableWorkerSession,
  clearUnusableWorkerSession
} from 'dshd-health'
import type { PostErrorEntry } from 'dshd-health'
import { qualityInspectDecision, qualityInspectDirectiveText } from 'dshd-quality'
import type { QualityInspectDirectiveSurface } from 'dshd-quality'
import { jsonSafeMessageSource, sanitizePromptLiterals } from 'dshd-core'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { DepartmentConfig, CoordinatorConfig } from './org-types.js'

// MPC-PREFLIGHT (P5/fb-332): the durable session-artifact readers used to
// resolve the PER-SESSION pinned route (the last request/header) — the ONLY
// correct subject of the stale-handle check (never the sessionId birth date).
// The EXTRACTION is PURE and lives in ./model-pins.ts (the guard's core); the
// load is LAZY (dynamic import — the idiom this codebase already uses for
// optional services) because a STATIC relative `.js` sibling pulled into THIS
// module's static graph is not rewritten by the src-native test loader.
import { findSessionArtifact, decodeZstdArtifact } from 'dshd-core'
import { stat } from 'node:fs/promises'

/** LOADING SEAM (duplicated from presets.ts, same reasoning): a STATIC relative
 * `.js` sibling in THIS module's static graph is not rewritten by the src-native
 * test loader (`test/ts-src-loader.mjs` hooks the DYNAMIC graph), and a plain
 * `createRequire` resolves only the COMPILED sibling — so the guard core is
 * resolved lazily through BOTH forms with the `.ts` fallback (the «.js or .ts»
 * seam dshd-core/session-cleanup.ts uses). Resolution happens ONCE. */
type ModelPinsCore = {
  resolvedRoutePinFromSessionLog: (text: string) => { provider: string; model: string } | undefined
}
let modelPinsCore: ModelPinsCore | undefined
const loadModelPinsCore = (): ModelPinsCore => {
  if (modelPinsCore !== undefined) return modelPinsCore
  const req = createRequire(fileURLToPath(import.meta.url))
  try {
    modelPinsCore = req('./model-pins.js') as ModelPinsCore
  } catch {
    modelPinsCore = req('./model-pins.ts') as ModelPinsCore
  }
  return modelPinsCore
}

// ---------------------------------------------------------------------------
// fb-118 (verify id+ts BEFORE citing a message in a directive): the QD
// directive generator embeds the caller-supplied `reason` VERBATIM into the
// head-rotated mirror (`qualityInspectDirectiveText` → `, reason ${reason}`),
// and a rotation reason typically CITES message ids ("memo escrita y
// confirmada (m-901)"). The fb-118 drift class (45 backlog): the cited id
// resolves to a DIFFERENT message than the role the reason claims — m-903
// (2026-09-04, IPH rotation 6048df6b → 380e8941) cited "memo … confirmada
// (m-901)" when m-901 was the system-health main-red alert relay (escalación
// 30 min) and the REAL memo confirmation was m-902; the QH itself drifted
// twice the same day (fb-45: briefs citing m-1624/m-1699-1700 when the real
// ids were m-1627/m-1698). The helpers below verify every cited id against
// the message store BEFORE it enters the directive: an id that does not
// exist (renumbered by compaction / stale), an id that resolves to a
// SYSTEM-ORIGIN record (a daemon alert can never be the head's memo
// confirmation), an id that is NOT the newest same-window record in a
// confirmation-claim context (the off-by-N drift signature), or an id whose
// ts contradicts the time cited next to it → the citation is MARKED in the
// directive (never silently attributed to the wrong message). PURE and
// NEVER throwing; a verification failure just leaves the reason verbatim.
// Module-scope (NOT exported — the lib/invoke.js export-parity lock at 324
// forbids growing the surface; the helpers are exercised through the
// directive emitter in the tests).
// ---------------------------------------------------------------------------

/** One store-record probe a citation lookup returns (the fields the
 * verification rules read; `seq` is the message id's numeric suffix). */
interface StoredMessageCiteProbe {
  id: string
  seq: number
  ts: number
  from: string
}

/** The verdict attached to one cited id: 'missing' (no such record),
 * 'system-origin' (a daemon record — never an agent action), 'stale-confirmation'
 * (a confirmation-context citation that is not the newest record — the fb-45
 * off-by-N drift signature), 'ts-mismatch' (the time cited next to the id does
 * not match the record's ts). */
type CiteVerdict = 'missing' | 'system-origin' | 'stale-confirmation' | 'ts-mismatch'

/** A `m-<digits>` citation token (a range endpoint `m-1699-1700` yields TWO
 * tokens — the fb-45 range-citation form). `index`/`end` are the token's
 * [start, end) offsets in the reason text (end = position after the LAST
 * captured digit), so the sanitizer can replace exactly the failing span. */
interface CitedIdToken {
  id: string
  index: number
  end: number
}

/** The citation token pattern: `m-<1..7 digits>` at a word boundary, with an
 * OPTIONAL range endpoint (`m-1699-1700` — the fb-45 form; the endpoint is a
 * SECOND citation token). The word-boundary discipline mirrors
 * isMessageIdPrefixed (invoke.ts REASON_TOKEN_FIGURE_RE): a plain number
 * ("354223", "a -1056") is NEVER a citation. */
const CITED_MESSAGE_ID_RE = /\bm-(\d{1,7})(?:-(\d{1,7}))?\b/gi

/** The confirmation-claim family (the role a reason attributes to a cited id —
 * "memo … confirmada", "ack", "escrita/enviada", "lista para rotar"). A
 * citation adjacent to one of these claims is a CONFIRMATION citation: the
 * drift class is precisely "the memo/ack confirmation cited with the id of an
 * OLDER sibling (or of the alert that preceded it)". */
const CONFIRMATION_CLAIM_RE = /(?:memo|confirm|ack|escrit|enviad|listo|firmad|preparad)/i

/** Extract every cited `m-<digits>` id token from a reason text (a token's
 * `id` is the FULL store id — `m-<digits>` — the exact key the message store
 * resolves). A range form (`m-1699-1700`) yields BOTH endpoints as separate
 * tokens. A token's `index`/`end` delimit the DIGIT span (after the `m-`
 * prefix — the span the sanitizer replaces), so `confirmClaimBefore`/
 * `citedTimeAfter` anchor on the digits. */
function extractCitedMessageIds(text: string): CitedIdToken[] {
  const tokens: CitedIdToken[] = []
  for (const match of text.matchAll(CITED_MESSAGE_ID_RE)) {
    const digits = match[1]
    const firstIndex = match.index + 2 // digits start right after the `m-`
    tokens.push({ id: `m-${digits}`, index: firstIndex, end: firstIndex + digits.length })
    if (match[2] !== undefined) {
      // The range endpoint — a SECOND citation token (`m-1699-1700`).
      const second = match[2]
      const secondIndex = firstIndex + digits.length + 1 // right after the '-'
      tokens.push({ id: `m-${second}`, index: secondIndex, end: secondIndex + second.length })
    }
  }
  return tokens
}

/** Whether a confirmation-claim word sits within the `window` chars before
 * `beforeIndex` (the fb-118/fb-45 citation shape: "confirmada (m-901)",
 * "memo … confirmación m-1624"). Local-context only — a claim far away does
 * not bless an id. */
function confirmClaimBefore(text: string, beforeIndex: number, window = 32): boolean {
  const start = Math.max(0, beforeIndex - window)
  return CONFIRMATION_CLAIM_RE.test(text.slice(start, beforeIndex))
}

/** Parse a UTC time token adjacent to a citation — the `HH:MM[:SS](Z|UTC)`
 * form the reasons cite next to an id ("(m-902, 11:05:43Z)"). Scans up to
 * `window` chars after `fromIndex`, stopping at a `)`, a newline or the next
 * `m-<digits>` citation. Returns {h, m, s} or undefined. */
function citedTimeAfter(text: string, fromIndex: number, window = 40): { h: number; m: number; s: number } | undefined {
  const tail = text.slice(fromIndex, fromIndex + window)
  const cut = tail.search(/[)\n]|m-\d/)
  const scope = cut === -1 ? tail : tail.slice(0, cut)
  const match = scope.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:Z|UTC|z)\b/)
  if (match === null) return undefined
  const h = Number(match[1])
  const m = Number(match[2])
  const s = match[3] === undefined ? 0 : Number(match[3])
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 && s >= 0 && s <= 59 ? { h, m, s } : undefined
}

/** Resolve the NEWEST record of the message store (the definitive last record
 * at directive-emit time — the reference for the confirmation-staleness rule).
 * Backward scan from `size - 1` so a burned seq gap (fb-68: a flush-throw
 * burns a seq) never misreads the newest (undefined → the R3 rule degrades to
 * a no-op, never a false mark). */
function newestStoreRecordAt(store: { get(id: string): { seq: number } | undefined; size: number }): { seq: number } | undefined {
  for (let s = store.size - 1; s >= 0; s--) {
    const record = store.get(`m-${s}`)
    if (record !== undefined) return record
  }
  return undefined
}

/** Verify every cited id in a rotation-directive reason against the message
 * store. PURE — never throws; a verdict map ENTRY only for a FAILING id (an
 * empty map = every citation verified → the reason stays verbatim). Rules
 * (deterministic, testable — the 4 datapoint fixtures of fb-118/fb-45):
 *   R1 'missing' — the id resolves to no record (renumbered by a compaction,
 *      stale, or fabricated — the fb-45 m-1699/1700 form);
 *   R2 'system-origin' — the id resolves to a daemon record (from
 *      'deepartments': health-alert relays, daemon notices). A system record
 *      can never be the agent action ("memo confirmada") the reason claims —
 *      the fb-118 incident (m-901 = the main-red alert vs m-902 = the memo);
 *   R3 'stale-confirmation' — the citation sits in a confirmation-claim
 *      context AND the id is NOT the newest store record (a NEWER record
 *      exists): the off-by-N drift signature of fb-45 (m-1624 vs the real
 *      m-1627 — the real confirmation is the newest record of its window);
 *   R4 'ts-mismatch' — the citation carries an adjacent UTC time token and the
 *      record's ts diverges (|delta| > 2 s — the exact-second resolution of
 *      the stored epoch) — the "id + ts divergente" datapoint.
 * `opts.now` (default Date.now()) selects the UTC day a bare HH:MM[:SS] time
 * token resolves onto. */
function verifyDirectiveReasonCites(
  reason: string,
  lookup: (id: string) => StoredMessageCiteProbe | undefined,
  opts: { newestSeq?: number; now?: number } = {}
): Map<string, CiteVerdict> {
  const verdicts = new Map<string, CiteVerdict>()
  const now = opts.now ?? Date.now()
  for (const token of extractCitedMessageIds(reason)) {
    const record = lookup(token.id)
    if (record === undefined) {
      verdicts.set(token.id, 'missing')
      continue
    }
    // R2 — a daemon-origin record is never the agent-authored confirmation.
    if (record.from === 'deepartments') {
      verdicts.set(token.id, 'system-origin')
      continue
    }
    // R3 — a confirmation-context citation must be the NEWEST store record.
    if (opts.newestSeq !== undefined && record.seq < opts.newestSeq && confirmClaimBefore(reason, token.index)) {
      verdicts.set(token.id, 'stale-confirmation')
      continue
    }
    // R4 — an adjacent cited time must match the record's ts (±2 s).
    const cited = citedTimeAfter(reason, token.end)
    if (cited !== undefined) {
      const date = new Date(now)
      const citedEpoch = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), cited.h, cited.m, cited.s)
      if (Math.abs(citedEpoch - record.ts) > 2000) {
        verdicts.set(token.id, 'ts-mismatch')
        continue
      }
    }
  }
  return verdicts
}

/** The human-readable mark label per verdict (inserted right after the failing
 * `m-<id>` in the directive reason — the format of the surrounding frame stays
 * byte-identical; only the unverifiable citation is annotated). */
const CITE_VERDICT_LABELS: Record<CiteVerdict, string> = {
  missing: 'not in store',
  'system-origin': 'system record',
  'stale-confirmation': 'not latest',
  'ts-mismatch': 'ts mismatch'
}

/** Rewrite a reason so EVERY FAILING citation carries its verdict label
 * (`m-<id>` → `m-<id> [<label>]`); VERIFIED ids stay byte-identical (the
 * output format is preserved). The replaced span is the DIGITS ONLY (after the
 * `m-` prefix, which stays in the text — no double `m-m-`); replaces from the
 * END to the START so the offsets never shift mid-pass. Never throws. */
function sanitizeDirectiveReasonCites(reason: string, verdicts: Map<string, CiteVerdict>): string {
  const replacements: Array<{ start: number; end: number; text: string }> = []
  for (const token of extractCitedMessageIds(reason)) {
    const verdict = verdicts.get(token.id)
    if (verdict === undefined) continue // verified — untouched
    replacements.push({
      start: token.index,
      end: token.end,
      text: `${token.id.slice(2)} [${CITE_VERDICT_LABELS[verdict]}]`
    })
  }
  if (replacements.length === 0) return reason
  replacements.sort((a, b) => b.start - a.start)
  let out = reason
  for (const replacement of replacements) {
    out = `${out.slice(0, replacement.start)}${replacement.text}${out.slice(replacement.end)}`
  }
  return out
}
// ---------------------------------------------------------------------------
// Local structural mirrors of the bundle-local harness views (src/invoke.ts
// declares these at module scope but does NOT export them — the export-parity
// lock freezes lib/invoke.js's export surface at 259 symbols, so the factory
// re-declares the EXACT same structural shapes instead of importing from the
// bundle module (which would also create a require cycle).
// ---------------------------------------------------------------------------

/** Loose structural view of a live `Agent` (the shape `ctx.agents.get(id)`
 * returns). Mirrors the bundle-local `AgentLike` of src/invoke.ts. The session
 * member is the rc.1+ surface (`seq` = log length, `snapshotEvents()` = full
 * log — the `events` getter is gone from 0.1.2-rc.1 on). */
interface AgentLike {
  id: string
  status: string
  ctx: Context
  session?: {
    seq: number
    snapshotEvents(): readonly unknown[]
    append?: (type: string, data: unknown, opts?: { surfaceOp?: string }) => unknown
    header?: unknown
  }
  followup(message: UserMessage): void
  cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
}

/** Structural view of the `AgentHandle` returned by `ctx.agents.create/resume`
 * (mirrors the bundle-local `AgentHandleLike`). */
interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

/** Agent-scoped creation options (mirrors the bundle-local `AgentOptionsLike`). */
interface AgentOptionsLike {
  provider?: string
  model?: string
  maxTokens?: number
  reasoningEffort?: string
}

/** Structural view of the `agents` service surface (mirrors the bundle-local
 * `AgentsLike`). */
interface AgentsLike {
  get(id: string): AgentLike | undefined
  list(): AgentLike[]
  roots(): AgentLike[]
  create(options: {
    sessionId: string
    seed?: readonly unknown[]
    meta?: Record<string, unknown>
    agentOptions?: AgentOptionsLike
    setup?: (agentCtx: Context) => unknown
    signal?: AbortSignal
  }): Promise<AgentHandleLike>
  resume(options: {
    resumeSessionId: string
    agentOptions?: AgentOptionsLike
    setup?: (agentCtx: Context) => unknown
    signal?: AbortSignal
  }): Promise<AgentHandleLike>
}

// ---------------------------------------------------------------------------
// fb-300/fb-301 (VALLE 09-09 — rematerialización de toolset post-smart_restart;
// clase fb-18 contrato): the RESUME-SEAM toolset-assertion contract — the
// MODULE-PRIVATE constants + PURE kernel the materializePost resume guard AND
// the boot heal share. The own-layer names installHeadBoardTools registers on
// EVERY post own layer (bus + feedback-emit + calendar + memo — tools.ts:2869-
// 3058) are the SETUP SIGNAL: a session the harness restored into the agent
// registry WITHOUT the deepartments setup (the smart-restart "AGENT REGISTRY
// ONLY" resume shape — boot.ts:943-944) shows the preset/global capability
// tools but NONE of the own-layer names — so the own-layer probes are the
// DISCRIMINATOR (the globals are visible on both, the restrict mask only ever
// REMOVES visibility). Head adds the manager-gated owns; the allowExec-gated
// seam pair is derived (P2-ENTRY: a role that declares dept_exec also gets
// dept_zstd_read). 0 new module exports — the bundle export-parity lock
// (lib/invoke.js at 327) and the frozen CUT-4 zone stay untouched; the pure
// kernel is exercised THROUGH the factory surface in the tests. Placement:
// AFTER the structural mirrors block (never above it — the followup-contract
// lock anchors delivery.ts:334).
// ---------------------------------------------------------------------------
const RESUME_UNIVERSAL_OWN_LAYER_PROBES: readonly string[] = [
  'send_message', 'agent_messages', 'dept_who', 'dept_memo_write',
  'dept_feedback', 'dept_calendar_add', 'dept_calendar_list', 'dept_calendar_remove'
]
/** The manager (head) own-layer additions: the feedbackHeadTools pair + the
 * batch-3a department-lifecycle tools + the M2.3 secretary. */
const RESUME_HEAD_OWN_LAYER_PROBES: readonly string[] = [
  'dept_feedback_list', 'dept_feedback_update', 'dept_post_create', 'dept_post_retire',
  'dept_worker_spawn', 'dept_worker_retire', 'dept_job_list', 'dept_job_run', 'dept_monitor_list', 'secretary'
]
/** The allowExec-gated seam pair (installHeadBoardTools opens the SAME gate for
 * dept_exec and dept_zstd_read when the role allow-list declares dept_exec). */
const RESUME_EXEC_GATE_PAIR: readonly string[] = ['dept_exec', 'dept_zstd_read']

/** PURE — the missing-expected-tools verdict (the assertWorkerToolsetResult
 * shape, spawn.ts:1231): `visible === undefined` (no live-scope oracle — a
 * capability-less composition without a scope key) degrades to `[]` (never a
 * false-positive heal / guard). Never throws. */
function missingPostTools(expected: readonly string[], visible: readonly string[] | undefined): string[] {
  if (visible === undefined) return []
  return expected.filter((name) => !visible.includes(name))
}

/** Structural view of the `agentPresets` service surface (mirrors the
 * bundle-local `AgentPresetsLike`). */
interface AgentPresetsLike {
  resolve(id: string): Promise<unknown>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** The session header the host-self-registration reads (mirrors the
 * bundle-local `SessionHeaderWithOrigin`; the nested `meta` fallback is kept
 * only for stale/mocked headers). */
interface SessionHeaderWithOrigin {
  origin?: unknown
  parentSession?: unknown
  delegationDepth?: unknown
  meta?: {
    origin?: unknown
    parentSession?: unknown
    delegationDepth?: unknown
  }
}

/** The apply-scope bindings the delivery zone captures (src/invoke.ts closures
 * + the shared mutable state), passed BY REFERENCE — the factory reads and
 * mutates the SAME maps/registries the rest of applyInvoke uses (AGENTS.md
 * rule 4 — no module-global mutable state; the instance lives on the apply
 * fiber). */
export interface DeliveryFactoryDeps {
  /** The org stateDir (<stateDir>/messages.jsonl, deliveries.jsonl, ...). */
  stateDir: string
  /** The live agents service (optional — absent in minimal compositions). */
  agents?: AgentsLike
  /** The subagent continuation service (optional — typed as the REAL harness
   * runtime so the injection site is exact). */
  subagents?: SubagentRuntime
  /** The agent-presets service (optional — the D4 host resume mount). */
  agentPresets?: AgentPresetsLike
  /** The live durable catalog registries (BY REFERENCE). */
  byPost: Map<string, PostEntry>
  hosts: Map<string, HostEntry>
  byChild: Map<string, string>
  /** The live head-handle map (byHeadHandle). */
  byHeadHandle: Map<string, AgentHandleLike>
  /** The stuck-head progress map (headProgress). */
  headProgress: Map<string, { at: number; eventCount: number }>
  /** The wake-relay intent sets the lifecycle carve bridges. */
  wakePackInjected: Set<string>
  deferredSleepReplace: Map<string, string>
  /** The registry closure — register a (re)materialized entry (by reference). */
  registerEntry: (entry: PostEntry) => void
  /** The config coordinator resolver for a head postId. */
  coordinatorForPost: (postId: string) => CoordinatorConfig | undefined
  /** The config department resolver for a durable post entry. */
  departmentForEntry: (entry: PostEntry) => DepartmentConfig | undefined
  /** The config department resolver for a postId. */
  departmentForPost: (postId: string) => DepartmentConfig | undefined
  /** The head own-layer setup builder (F8/F10 materialization). */
  headSetup: (postId: string, roomId: string, role: string, presetId?: string, department?: DepartmentConfig) => (agentCtx: Context) => unknown
  /** The worker own-layer setup builder (materialization). */
  workerSetup: (postId: string, roomId: string, role: string, extra?: { persona?: string; taskText?: string; tools?: string[]; department?: DepartmentConfig }) => (agentCtx: Context) => unknown
  /** VALLE lane B (fb-29 structural fix) — the COLD re-materialization tools
   * reader (exposed by the spawn orchestration surface, resolveRoleTemplate):
   * re-resolves a worker's role-template tools at the materialize seam so a
   * restarted worker is NEVER re-created with an empty tool-scope (the original
   * fb-29 bug). Returns the template (with its `tools`) when the role has a
   * template FILE (a role-template worker); undefined when NO template file
   * exists (a LEGACY dept_post_create free-form-role worker — board-only by
   * design, never failed). */
  resolveRoleTemplate: (departmentId: string, role: string) => Promise<{ id: string; title: string; tools?: string[]; persona: string; path: string } | undefined>
  /** fb-300/fb-301 — the toolset-audit channel (src/toolset-audit.ts module-scope
   * appendToolsetAudit, passed by reference — the SAME channel the postSetup
   * waypoints write): the resume-seam 'unarmed'/'heal' waypoint rows. The
   * audit covers the healed post so the fb-300 class is observable (the pre-fix
   * evidence gap: 0 audit rows post-restart). */
  appendToolsetAudit: (stateDir: string | undefined, entry: Record<string, unknown>) => void
  /** Resolve the duplicate-safe materialization AgentOptions (coordinator →
   * WORKER_AGENT_OPTIONS fallback). */
  resolveMaterializeAgentOptions: (candidate: AgentOptionsLike | undefined) => AgentOptionsLike
  /** F5: the fresh incarnation's department workspace cwd. */
  resolveDepartmentWorkspaceCwd: (department: DepartmentConfig | undefined) => Promise<string>
  /** The shared workspace root fallback cwd. */
  resolveWorkspaceRootPath: () => Promise<string>
  /** The archive-leak head-session rotation (a non-archived resume stays). */
  rotateArchivedHeadSessionId: (postId: string, sessionId: string) => Promise<string | undefined>
  /** The durable worker retire (the delivery auto-retire seam). O1 (LANE ②): an
   * optional `opts.deferDisposeMs` defers the caller-handle DISPOSE by a grace
   * so an in-flight tool call completes before the retire disposes it (the
   * auto-retire-on-delivery race — see the retirePost implementation). */
  retirePost: (postId: string, callerAgentId: string, opts?: { deferDisposeMs?: number }) => Promise<{ postId: string; retired: true }>
  /** The head session-title pin (module-scope pure helper, passed by ref to
   * keep the factory import-free of the bundle module). */
  pinSessionTitle: (session: Session, title: string) => 'pinned' | 'already-titled' | 'failed'
  /** The once-per-session handle dispose (the sleep detach). */
  disposeHeadHandleOnce: (sessionId: string) => Promise<void>
  /** The bounded detach-join timeout (the sleep respawn deadlock fix). */
  disposeJoinTimeoutMs: () => number
  /** The bounded detach join (sleep respawn serialization). */
  joinHeadDisposeOnce: (sessionId: string) => Promise<boolean>
  /** The per-head recovery serialization (stuck-head dispose + cold-resume). */
  serializeHeadRecovery: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** The stuck-head comparator (no progress for STUCK_HEAD_MS). */
  isHeadStuck: (sessionId: string, live: AgentLike) => boolean
  /** Dispose a live head handle (the stuck recovery + sleep). */
  disposeHeadHandle: (sessionId: string) => Promise<void>
  /** The fresh progress baseline stamp (the stuck check). */
  markHeadProgress: (sessionId: string, live: AgentLike) => void
  /** Fire-and-forget the session workspace attach for a bus-woken session. */
  attachHeadSession: (sessionId: string, source: string) => Promise<void>
  /** The fb-9 resume-class preflight (reasoning-content compatibility). */
  workerReasoningContentPreflightError: () => string | undefined
  /** The DISPATCH-HARDENING pooler-capacity block on the resume seam. */
  workerPoolerDispatchBlockError: () => string | undefined
  /** The host self-registration (B3 gap fix — board tools are gone). */
  ensureHost: (sessionId: string, roomId: string) => string
  /** Durable registry persistence (closures the lifecycle carve bridges). */
  persistPosts: () => Promise<void>
  persistHosts: () => void
  /** The journal path resolver (T1). */
  journalPathFor: (memberId: string) => string
  /** The journal write closure (lifecycle carve — journal/archive policy). */
  writeJournal: (memberId: string, roomId: string, summary: string, decisions: string[], constraints: string[], openItems: string[], currentStep?: string, archive?: { sessionId?: string; wakeCounter?: number; archiveSeq?: string; lastWakeMs?: number; boundarySeq?: number }) => Promise<string>
  /** The journal read closure. */
  readJournal: (memberId: string) => Promise<string | undefined>
  /** fb-308 — the session-log FINALIZE closure (the in-bundle lifecycle
   * fallback construction needs it — re-capture the just-ended cycle
   * post-dispose: exact header + normalized reason + zstd pointer). */
  finalizeSessionLog: (memberId: string, roomId: string, sessionId: string) => Promise<string | undefined>
  /** The sleep-counter journal bumps (lifecycle carve). */
  bumpHostSleepCounter: (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }) => Promise<string>
  bumpPostSleepCounter: (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }) => Promise<string>
  /** The sleep session archive (lifecycle carve). */
  archivePostSessionOnSleep: (sessionId: string) => Promise<boolean>
  /** Live identity resolvers (session → member id). NOTE: `hostForSession` is
   * the LIVE DURABLE MAP (registry.hostForSession — sessionId → hostId); the
   * `hostIdForSession` closure wraps it for host-family callers. */
  hostForSession: Map<string, string>
  hostIdForSession: (sessionId: string) => string
  postIdForChild: (childId: string) => string | undefined
  /** The host workspace-attach repair seam (W8-i retry). */
  repairHostWorkspaceAttach: () => Promise<void>
  /** The QD workerInspectProbability (the directive dice — a value). */
  qualityWorkerInspectProbability: number
  /** The bundle's agent-template + daemon constants. */
  PRESET_ID: string
  WORKER_PRESET_ID: string
  WORKER_AGENT_OPTIONS: AgentOptionsLike
  HOST_AGENT_OPTIONS: AgentOptionsLike
  /** The default pinned head session title (fresh mint + rotation). */
  HEAD_DEFAULT_SESSION_TITLE: string
  /** The stuck-head window (Fix A2 — no progress for STUCK_HEAD_MS is wedged). */
  STUCK_HEAD_MS: number
  /** FB-132 (wake-on-delivered 2026-09-06 — the 2nd-half drain-on-wake lane):
   * the LATE-BOUND DRAIN hook the REAL-wake primitives FIRE (fire-and-forget):
   * drain the recipient's 'prepared' queue FIFO head-first at its real wake
   * (the m-1933 family — a no-wake/queued durable delivery finally lands at the
   * recipient's next real wake). OPTIONAL + non-fatal: absent → the fire is a
   * NO-OP (the documented «drains at its next real wake» contract stays merely
   * documentary in a minimal composition that wires no redeliverer); a throw →
   * warn only. The invoke.ts deliveryDeps wires it to the tools surface's
   * `redeliverDrainQueue` (the SAME DeliveryRedeliverer the sweep drives),
   * resolved at CALL time (the tools factory builds the redeliverer AFTER this
   * factory — never dereference the hook at construction). CO-EXISTS with the
   * batch-drain lane (a641964): the batch covers the RUNNING recipient's new
   * sends (accumulate + flush), this drain covers the 'prepared' residue of a
   * LATEST LANDED delivery (a batch item's landing is 'prepared' — the engine
   * `onDelivered` hook fires only for delivered/resumed). */
  drainRecipientQueue?: (recipientId: string) => Promise<number> | number
}

/** The delivery surface the rest of applyInvoke consumes at the SAME positions
 * as before the extraction (the tools, the daemons, the redeliver driver, the
 * bind register — every downstream reference is unchanged). */
export interface DeliverySurface {
  /** The boot-opened store directory (the redeliver driver's `stateDir`). */
  messageStoreDir: string
  /** The boot-opened message store (the bus service first, inline fallback
   * R6 — the SAME store in both compositions). */
  messagesStoreReady: Promise<MessagesStore>
  /** The boot-opened feedback store (dshd-feedback is a pure lib — always
   * opened in-bundle from the shared org stateDir). */
  feedbackStoreReady: Promise<FeedbackStore>
  /** The SINGLE fresh-mint point for a department HEAD (F8 + the M-A rotation). */
  freshMintHead: (entry: PostEntry, dept: DepartmentConfig | undefined, opts?: { seed?: readonly unknown[]; source?: string }) => Promise<AgentLike>
  /** The shared post DELIVERY (wakePost seam + stuck recovery; never throws). */
  busDeliverToPost: (entry: PostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined, opts?: DeliveryInterruptOptions) => Promise<DeliveryStatus>
  /** The shared HOST delivery (D4 — always wake, W8-i retry; never throws). */
  busDeliverToHost: (hostEntry: HostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined, opts?: DeliveryInterruptOptions) => Promise<DeliveryStatus>
  /** The configured `quality-head` post resolver (QD hooks + feedback notify). */
  resolveQualityHeadEntry: () => PostEntry | undefined
  /** The ACL-legal notification forwarder (dshd-feedback R7). */
  feedbackForwarderFor: (emisor: string) => string | undefined
  /** The severity-gated delivery options (critico → interrupt; alto → wake;
   * medio/bajo/mejora → no-wake). */
  feedbackDeliveryOptions: (tipo: FeedbackTipo, severidad: FeedbackSeveridad) => { noWake: boolean; interrupt?: boolean }
  /** The QD (spec 007 §6.4 D-Q4a) ADDRESSED QUALITY INSPECT directive emitter. */
  maybeEmitQualityInspectDirective: (surface: QualityInspectDirectiveSurface) => Promise<void>
  /** fb-11 — the ROTATION-SUCCESSOR AUTO-WAKE transport (durable record +
   * D4 host delivery; never throws). */
  enqueueHostWake: (wake: { newHostId: string; newSessionId: string; sleepEpoch: number }) => Promise<void>
  /** The sleep/wake/rotate lifecycle SERVICE (deepartments.lifecycle first, the
   * in-bundle createLifecycleService fallback R6). */
  lifecycle: LifecycleService
  /** The messaging-ACL profile classifier (deepartments.acl first, the
   * in-bundle aclBusProfileFor bind fallback R6). */
  busProfileFor: (memberId: string) => BusMemberProfile
  /** The pure ACL denial ground (same predicate the delivery engine re-checks
   * defensively). */
  aclDenyGround: (sender: BusMemberProfile, recipient: BusMemberProfile) => string | undefined
  /** The bus catalog-route resolver (spec §4.2 route 2 + the m-331 re-route). */
  resolveBusCatalogRoute: (recipientId: string) => CatalogRoute
  /** The thin deliverBusRecord wrapper (delivery.deliverOrQueue + sidecar). */
  deliverBusRecord: (record: MessageRecord, recipientId: string, callerAgentId: string, senderSessionId: string | undefined, signal?: AbortSignal, opts?: DeliveryInterruptOptions & { noWake?: boolean }) => Promise<DeliveryStatus>
  /** The caller's BUS member id (postId else the deterministic host id). */
  busMemberIdFor: (agentId: string) => string
  /** The child-route resolver (the caller's direct continuable children). */
  resolveBusChild: (recipientId: string, callerAgentId: string, signal?: AbortSignal) => Promise<boolean>
  /** The native child-route delivery (subagents.followup; never throws). */
  deliverBusChild: (callerAgentId: string, recipientId: string, record: MessageRecord, framed: string, senderSessionId: string | undefined, signal?: AbortSignal) => Promise<DeliveryStatus>
  /** The DELIVERY ENGINE (deepartments.deliver first, the in-bundle
   * createDeliveryEngine fallback R6). */
  delivery: DeliveryEngine
  /** B3 (m-361): whether a CATALOG recipient is DORMANT (sleepEpoch marked). */
  isDormantRecipient: (recipientId: string) => boolean
  /** P1-EXT (2026-09-06 — WAKE-SEAM mitigation, fix opción-a VARIANTE (i)):
   * whether a CATALOG recipient is CURRENTLY MATERIALIZED (its post entry's
   * live agent handle exists — `agents.get(SessionId(entry.sessionId))`). The
   * delivery engine's optional `recipientMaterialized` dep: false (dormant) →
   * the fb-117 FIFO gate is SKIPPED so the ALWAYS-WAKE proceeds to
   * `materializePost` (the wake); true/undefined → the gate applies (the
   * pre-fix behavior). A non-post recipient (host family / unknown) → undefined
   * (default safe — the gate stays). Never throws. */
  recipientMaterialized?: (recipientId: string) => boolean | undefined
  /** VALLE 09-07 (BATCH-DRAIN): whether a CATALOG recipient's live handle is
   * CURRENTLY RUNNING (mid-turn — the `agents.get(...)?.status === 'running'`
   * probe; posts by byPost → session, hosts by hosts → session; retired →
   * false; unknown/child → undefined). The delivery engine's optional
   * `recipientRunningLive` dep: `true` + `batchEligible` → the fb-117 FIFO
   * gate is SKIPPED (the batch presents the record at the settle in seq order
   * — the inversion the gate protects is impossible for a batched delivery);
   * false/undefined → the gate applies (the pre-batch behavior). */
  recipientRunningLive?: (recipientId: string) => boolean | undefined
  /** VALLE 09-07 (BATCH-DRAIN): queue ONE batch-eligible record for a RUNNING
   * session (only the ALWAYS-WAKE no-interrupt send ever calls it — via
   * busDeliverToPost/Host). Returns whether the record was queued (a defensive
   * record.id dedupe rejects a double-queue). */
  queueBatchFor: (sessionId: string, item: { record: MessageRecord; framed: string; senderSessionId?: string }) => boolean
  /** VALLE 09-07 (BATCH-DRAIN): FLUSH the pending batch of ONE session in a
   * single followup (`withFirst` = the W9-b interruptor, presented first). The
   * settle hook (ctx.on('agent/status') running→idle) + the interrupt drain
   * call it; a test may call it directly. Returns the number of records
   * presented (0 = no-op / handle-gone / all-already-settled). NEVER throws. */
  flushBatchFor: (sessionId: string, opts?: { withFirst?: { record: MessageRecord; framed: string; senderSessionId?: string } }) => Promise<number>
  /** VALLE 09-07 (BATCH-DRAIN): the sessions with a PENDING batch (test probe
   * + observability — the batch is in-memory/apply-scoped, nothing durable
   * lives here beyond the 'prepared' rows). */
  batchState: () => string[]
  /** B3 gap fix: the host self-registration (send_message/dept_who callers). */
  busEnsureHostForCaller: (callerAgent: { id: string; session?: { header?: SessionHeaderWithOrigin } }) => string
  /** The 1..20 fan-out guard (spec §4.4). */
  assertBusFanOut: (to: readonly string[]) => number
  /** fb-300/fb-301 (VALLE 09-09 — rematerialización de toolset post-smart_restart):
   * the TOOLSET REASSERTION action shared by the materializePost resume guard
   * and the boot heal (`runToolsetReassertion`, tools.ts). Verifies a POST's
   * live session against the fb-18 role-toolset contract — the expected names
   * are the OWN-LAYER probes installHeadBoardTools registers (the setup seam's
   * fingerprint: the awaited postSetup closure runs mount → probe → restrict →
   * own-layer in ONE body, so the own-layer landing proves the whole derivation
   * ran; the ENV-DEPENDENT preset globals are deliberately NOT checked — a
   * harness-restored session shows them too, the fb-300 evidence: read/grep/
   * glob OK; the worker DECLARED allow-list still resolves through
   * resolveMaterializeWorkerTools — the B durable `entry.tools` fast-path
   * FIRST and never bypassed — for the allowExec-gated pair derivation) and
   * heals a session the setup-derivation seam never ran on (the harness-
   * restored "AGENT REGISTRY ONLY" shape):
   *   - 'armed' — the expected toolset is present (exact no-op — the fast-path
   *     B of durable custom tools stands);
   *   - 'dispose-cold' — an IDLE unarmed session whose handle the bundle owns
   *     (byHeadHandle) was DISPOSED and COLD re-materialized (the full setup
   *     re-derivation + audit — the same proven cold path);
   *   - 'rearm-inplace' — a registry-only restored session (no bundle handle —
   *     the AgentRegistry exposes no per-agent detach) was re-armed IN PLACE
   *     with the same setup derivation on its live ctx (the apply-standing
   *     precedent; safe: an unarmed scope was never restricted/own-layer-
   *     registered — no double mask);
   *   - 'running-deferred' — a RUNNING target is NEVER disarmed (fb-301 — a
   *     mid-turn agent is left for its next idle wake; the wake continues on
   *     the degraded toolset instead of interrupting a real turn);
   *   - 'not-live' — no live session (no-op).
   * `missing` = the missing expected names (never empty on a heal). NEVER
   * throws; `opts.now` fixes the audit timestamp (tests). */
  reassertPostToolset: (entry: PostEntry, opts?: { now?: () => number }) => Promise<{ outcome: 'not-live' | 'armed' | 'dispose-cold' | 'rearm-inplace' | 'running-deferred'; missing: string[] }>
}

/** O1 (LANE ② — the auto-retire-on-delivery race, 3 samples today 34→16→3ms):
 * the dispose-GRACE the delivery auto-retire passes to retirePost — seconds
 * for the caller's in-flight send_message tool call to complete before the
 * retire disposes its handle (a 5 s grace is 3 orders of magnitude above the
 * observed 3–34 ms race window and below the delivery-sweep cadence). */
export const AUTO_RETIRE_DISPOSE_GRACE_MS = 5_000

/** R2 (fb-42/25 — the glm-5.3-flash rotation class, feedback fb-42): the
 * ROTATION-MODEL PROBE surface — the minimal `ctx.get('llm')` slice the mint
 * probe reads: the registered provider routes + the per-provider configured
 * model catalog (the real dsh-llm LlmService exposes both via listProviders /
 * listModels; an ABSENT slice is the headless/hermetic-profile signature →
 * the probe degrades, never blocks). */
type LlmModelProbeSurface = {
  listProviders?: () => Array<{ id?: string }>
  listModels?: (provider: string) => Promise<Array<string | { id?: string }>>
}

/** R2 — the mint probe verdict (module-private): 'ok' = the candidate model
 * is verified (or the probe was impossible — warn-degrade); 'retrofitted' =
 * the candidate model is NOT in the live provider's catalog but the known
 * seed model IS → the mint re-targets the same provider to the seed model;
 * 'unknown-model' = a phantom model that must NEVER be minted (the caller
 * converts it into the fail-loud error). */
type RotationModelMintProbe =
  | { kind: 'ok'; options: AgentOptionsLike }
  | { kind: 'retrofitted'; options: AgentOptionsLike; from: string; to: string }
  | { kind: 'unknown-model'; provider: string; model: string; fallbackModel: string }

/** R2 (fb-42/25, family fb-25) — the ROTATION-MODEL PROBE: verify that the
 * RESOLVED model is CONFIGURED in the destination adapter/provider BEFORE the
 * fresh head/worker is materialized. The fb-42 outage (2026-09-01, 2 samples):
 * heads rotated in the cleanup wave were minted on the fleet model
 * glm-5.3-flash (commits 4e86492/4cf9e38) while the pi-ai adapter had not
 * configured it yet → the fresh's FIRST TURN failed with `pi-ai opencode-zen
 * has no configured model glm-5.3-flash` (t3-recovered, ~1h45m delay). Class
 * boundary vs fb-6 (CLOSED): fb-6 = provider+model ABSENT from the
 * AgentOptions (the upstream resolveMaterializeAgentOptions fallback owns
 * that class); THIS probe = the provider is LIVE/registered but the model is
 * missing from its catalog. NEVER a phantom mint: when NEITHER the candidate
 * NOR the known seed model is configured the probe reports 'unknown-model'
 * (the mint FAILS LOUD with a clear reason — a fresh head whose first turn is
 * guaranteed to fail must not be minted). Degrades to 'ok' (warn + proceed
 * unprobed) when the probe is impossible: no llm surface (headless/hermetic
 * profile), listProviders/listModels absent or failing, or the provider NOT
 * registered (the NO_ADAPTER class the boot FIX-2 check owns with its bounded
 * retry window — an unregistered provider carries no model catalog to probe).
 * PURE structure — never throws itself; the caller maps 'unknown-model' to
 * the abort. EXPORTED (package-internal): the dept_head_rotate tool (tools.ts)
 * runs the SAME probe BEFORE the destructive dispose/archive steps, so a
 * fail-loud leaves the old head untouched. */
export function probeRotationMintModel(
  postId: string,
  agentOptions: AgentOptionsLike,
  fallbackOptions: AgentOptionsLike,
  llm: LlmModelProbeSurface | undefined,
  logger: { warn: (message: string) => void; info: (message: string) => void }
): Promise<RotationModelMintProbe> {
  const provider = agentOptions.provider
  const model = agentOptions.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    // provider+model absent — the fb-6 CLOSED class (the upstream
    // resolveMaterializeAgentOptions fallback already replaced the options).
    return Promise.resolve({ kind: 'ok', options: agentOptions })
  }
  if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    logger.warn(`[deepartments] rotation mint probe "${postId}": the "llm" surface is absent (headless/hermetic profile) — model "${model}" (provider ${provider}) NOT verified, mint proceeds unprobed`)
    return Promise.resolve({ kind: 'ok', options: agentOptions })
  }
  let registered: Array<{ id?: string }> = []
  try {
    registered = llm.listProviders() ?? []
  } catch (error: unknown) {
    logger.warn(`[deepartments] rotation mint probe "${postId}": listProviders() failed (${error instanceof Error ? error.message : String(error)}) — proceeding unprobed`)
    return Promise.resolve({ kind: 'ok', options: agentOptions })
  }
  if (!registered.some((p) => p?.id === provider)) {
    logger.warn(`[deepartments] rotation mint probe "${postId}": provider "${provider}" is NOT registered (NO_ADAPTER class — the boot FIX-2 check owns the alert) — model "${model}" NOT verified, mint proceeds unprobed`)
    return Promise.resolve({ kind: 'ok', options: agentOptions })
  }
  return llm.listModels(provider)
    .then((configured) => {
      // Tolerant catalog read: the model ids may be plain strings OR
      // {id}-shaped descriptors (the dsh-llm LlmModelInfo shape) — NEVER a
      // phantom block over a shape difference. Ids compare case-insensitively.
      const ids = (configured ?? []).map((m) => (typeof m === 'string' ? m : m?.id)).filter((id): id is string => typeof id === 'string')
      const has = (candidate: string) => ids.some((id) => id.toLowerCase() === candidate.toLowerCase())
      if (has(model)) {
        logger.info(`[deepartments] rotation mint probe "${postId}": model "${model}" (provider ${provider}) IS configured — mint proceeds VERIFIED`)
        return { kind: 'ok', options: agentOptions } as const
      }
      const fallbackModel = fallbackOptions?.model
      if (typeof fallbackModel === 'string' && fallbackModel !== '' && has(fallbackModel)) {
        logger.warn(`[deepartments] rotation mint probe "${postId}": model "${model}" (provider ${provider}) is NOT in the adapter catalog → RETROFIT to the known seed model "${fallbackModel}" (the fresh head runs the fleet model — the phantom model is never minted)`)
        return { kind: 'retrofitted', options: { ...agentOptions, model: fallbackModel }, from: model, to: fallbackModel } as const
      }
      return { kind: 'unknown-model', provider, model, fallbackModel: fallbackModel ?? '' } as const
    })
    .catch((error: unknown) => {
      logger.warn(`[deepartments] rotation mint probe "${postId}": listModels("${provider}") failed (${error instanceof Error ? error.message : String(error)}) — model "${model}" NOT verified, mint proceeds unprobed`)
      return { kind: 'ok', options: agentOptions } as const
    })
}

/** MPC-PREFLIGHT (guard de coherencia pines↔catálogo, fb-42 subclase C1 —
 * incidente 09-10) — la puerta 4 del §4.2 en el punto de MATERIALIZACIÓN
 * create/resume de heads Y workers. Ese punto (materializePost, la rama COLD
 * que crea/resume) es EL hueco por el que pasó el incidente: hoy sólo hay probe
 * en el fresh-mint de head (:1023) y en dept_head_rotate (tools.ts:6758), y el
 * 09-10 golpeó turnos de agentes YA vivos + la re-materialización post-fix.
 *
 * Semántica (conserva R2 y añade el camino P5/fb-332):
 *  - el modelo del RESOLVED route está en el catálogo ⇒ 'ok' (materializa igual);
 *  - está AUSENTE pero el seed model está ⇒ se materializa con el seed model
 *    (retrofit + aviso), EXACTAMENTE la semántica R2;
 *  - el HANDLE PERSISTIDO trae un modelo ausente Y el pin actual SÍ está ⇒
 *    RE-RESUELVE al pin actual + aviso (mitiga fb-332/P5 SIN exigir un retire
 *    manual) — es el caso del builder-247, que falló a las 12:54:13Z CON el fix
 *    desplegado porque su handle pre-fix seguía pinneando el legacy;
 *  - ninguno de los dos existe ⇒ 'unknown-model' (el caller avisa fail-loud).
 *
 * El SUJETO es SIEMPRE el par (provider, model) que el handle va a pedir en su
 * próximo turno — NUNCA la fecha de nacimiento del sessionId (requisito duro
 * del §P5: los heads longevos reutilizan directorio de sesión y ese criterio
 * ingenuo produce 4 falsos positivos permanentes sobre heads vivos).
 *
 * PURE (nunca lanza); el caller decide el efecto. EXPORTED package-internal. */
export function resolvedModelHandleVerdict(
  postId: string,
  agentOptions: AgentOptionsLike,
  currentPin: AgentOptionsLike | undefined,
  handleOptions: AgentOptionsLike | undefined,
  llm: LlmModelProbeSurface | undefined,
  logger: { warn: (message: string) => void; info: (message: string) => void }
): Promise<{ kind: 'ok'; options: AgentOptionsLike } | { kind: 'retrofitted'; options: AgentOptionsLike; from: string; to: string; staleHandle: boolean } | { kind: 'unknown-model'; provider: string; model: string; fallbackModel: string }> {
  const provider = typeof agentOptions?.provider === 'string' ? agentOptions.provider : ''
  const model = typeof agentOptions?.model === 'string' ? agentOptions.model : ''
  const sameRoute = (a: string | undefined, b: string | undefined): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase()
  const handleProvider = typeof handleOptions?.provider === 'string' ? handleOptions.provider : ''
  const handleModel = typeof handleOptions?.model === 'string' ? handleOptions.model : ''
  const handleStaleCandidate = handleProvider !== '' && handleModel !== '' && !sameRoute(handleModel, model)
  return probeRotationMintModel(postId, agentOptions, currentPin ?? agentOptions, llm, logger).then((probe) => {
    if (probe.kind === 'retrofitted') {
      if (handleStaleCandidate) {
        logger.warn(`[deepartments] materialization pin guard "${postId}": STALE HANDLE (fb-332/P5) — the route this session last resolved (${handleProvider}/${handleModel}) is not servable; re-resolving the handle to the CURRENT pin (${probe.to}) at re-materialization (no manual retire needed)`)
        return { kind: 'retrofitted', options: probe.options, from: `${handleProvider}/${handleModel}`, to: probe.to, staleHandle: true } as const
      }
      logger.warn(`[deepartments] materialization pin guard "${postId}": the resolved route was stale — retrofit to the seed model "${probe.to}" applied (R2 semantics preserved)`)
      return { kind: 'retrofitted', options: probe.options, from: probe.from, to: probe.to, staleHandle: false } as const
    }
    if (probe.kind === 'unknown-model' && handleStaleCandidate) {
      // P5: el handle persistido lleva un route distinto del resolved actual y
      // NINGUNO de los dos es servible — el caller avisa fail-loud (el fix
      // global no cubre ese handle).
      return { kind: 'unknown-model', provider: handleProvider, model: handleModel, fallbackModel: probe.fallbackModel } as const
    }
    return probe
  })
}

/** MPC-PREFLIGHT (P5/fb-332) — el pin RESUELTO POR SESIÓN, leído de la fuente
 * durable: la ÚLTIMA línea `request/header` del artefacto de sesión (el
 * provider/model con el que el próximo turno construye su request). La
 * EXTRACCIÓN pura vive en ./model-pins.ts (`resolvedRoutePinFromSessionLog`).
 *
 * Dos vías, en orden: (1) `ctx.sessionPersistence.readRaw(sessionId)` (la vía
 * NATIVA del runtime, sin I/O de fichero — la misma que la tool list ya usa);
 * (2) el artefacto en disco (`sessionPersistence.root` + findSessionArtifact),
 * ACOTADO: sólo se decodifica si existe y pesa ≤ 64 MB (por encima, un warn y
 * `undefined`, jamás un throw ni una lectura sin cota).
 *
 * Devuelve `undefined` cuando no hay artefacto o no se puede leer: el guard lo
 * trata como «handle route desconocido» (aviso), nunca como «servible». */
export const MPC_SESSION_ARTIFACT_READ_LIMIT_BYTES = 64 * 1024 * 1024

async function readResolvedSessionRoutePin(
  ctx: Context,
  sessionId: string
): Promise<{ provider: string; model: string } | undefined> {
  if (sessionId === '') return undefined
  const { resolvedRoutePinFromSessionLog } = loadModelPinsCore()
  const persistence = ctx.get('sessionPersistence', false) as
    | { root?: string; readRaw?: (id: SessionId, signal?: AbortSignal) => Promise<{ content: string } | undefined> }
    | undefined
  const raw = persistence?.readRaw
  if (typeof raw === 'function') {
    try {
      const read = await raw(SessionId(sessionId))
      if (typeof read?.content === 'string' && read.content !== '') {
        const pin = resolvedRoutePinFromSessionLog(read.content)
        if (pin !== undefined) return pin
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] session-pin guard: readRaw failed for ${sessionId} (${error instanceof Error ? error.message : String(error)}) — falling back to the on-disk artifact`)
    }
  }
  const sessionsRoot = typeof persistence?.root === 'string' && persistence.root !== '' ? persistence.root : undefined
  if (sessionsRoot === undefined) return undefined
  try {
    const artifactPath = await findSessionArtifact(sessionsRoot, sessionId)
    if (artifactPath === undefined) return undefined
    const info = await stat(artifactPath)
    if (info.size > MPC_SESSION_ARTIFACT_READ_LIMIT_BYTES) {
      ctx.logger.warn(`[deepartments] session-pin guard: artifact for ${sessionId} exceeds the ${MPC_SESSION_ARTIFACT_READ_LIMIT_BYTES}-byte guard budget — the resolved per-session route was NOT read (stale-handle detection skipped for this session)`)
      return undefined
    }
    return resolvedRoutePinFromSessionLog(await decodeZstdArtifact(await readFile(artifactPath)))
  } catch (error: unknown) {
    ctx.logger.warn(`[deepartments] session-pin guard: could not read the resolved route for ${sessionId} (${error instanceof Error ? error.message : String(error)}) — stale-handle detection skipped for this session`)
    return undefined
  }
}

/**
 * Build the DELIVERY ORCHESTRATION surface on the apply fiber (AGENTS.md rule 4
 * — no module-global mutable state; invoked by applyInvoke at the SAME fiber
 * position where the hoisted zone used to live). The closures below are the
 * ORIGINAL zone closures, moved VERBATIM — the diff is movement-only.
 */
export function createDeliveryOrchestration(ctx: Context, deps: DeliveryFactoryDeps): DeliverySurface {  const {
    stateDir,
    agents,
    subagents,
    agentPresets,
    byPost,
    hosts,
    byChild,
    byHeadHandle,
    headProgress,
    wakePackInjected,
    deferredSleepReplace,
    registerEntry,
    coordinatorForPost,
    departmentForEntry,
    departmentForPost,
    headSetup,
    workerSetup,
    resolveMaterializeAgentOptions,
    resolveRoleTemplate,
    appendToolsetAudit,
    resolveDepartmentWorkspaceCwd,
    resolveWorkspaceRootPath,
    rotateArchivedHeadSessionId,
    retirePost,
    pinSessionTitle,
    disposeHeadHandleOnce,
    disposeJoinTimeoutMs,
    joinHeadDisposeOnce,
    serializeHeadRecovery,
    isHeadStuck,
    disposeHeadHandle,
    markHeadProgress,
    attachHeadSession,
    workerReasoningContentPreflightError,
    workerPoolerDispatchBlockError,
    ensureHost,
    persistPosts,
    persistHosts,
    journalPathFor,
    writeJournal,
    readJournal,
    finalizeSessionLog,
    bumpHostSleepCounter,
    bumpPostSleepCounter,
    archivePostSessionOnSleep,
    hostForSession,
    hostIdForSession,
    postIdForChild,
    repairHostWorkspaceAttach,
    qualityWorkerInspectProbability,
    PRESET_ID,
    WORKER_PRESET_ID,
    WORKER_AGENT_OPTIONS,
    HOST_AGENT_OPTIONS,
    HEAD_DEFAULT_SESSION_TITLE,
    STUCK_HEAD_MS,
    drainRecipientQueue
  } = deps

  /** FB-132 (wake-on-delivered 2026-09-06 — the 2nd-half drain-on-wake lane):
   * the fire-and-forget DRAIN dispatcher the REAL-wake primitives call at
   * their SUCCESS seams: `void fireQueueDrain(recipientId)` — the recipient
   * JUST was materialized/woken, so its 'prepared' queue (a noWake / FIFO-gated
   * durable delivery) must drain FIFO head-first NOW (the m-1933 family — the
   * documented «drains at its next real wake» contract the wake enforces).
   * NON-FATAL + never awaited on the delivery path (the current delivery does
   * NOT wait for the drain); the drain itself is re-entrancy-guarded + bounded
   * + non-throwing (DeliveryRedeliverer.drainRecipientQueue), and THIS
   * dispatcher folds a synchronous hook error / async rejection to a warn (the
   * next wake/sweep re-evaluates). Absent hook → a pure NO-OP. The BATCH-DRAIN
   * lane co-exists: the engine's `onDelivered` fires this after markFinal only
   * for LANDED (delivered/resumed) deliveries — a batch-accumulated item lands
   * 'prepared' at the primitive and is flushed at the settle, never here. */
  const fireQueueDrain = (recipientId: string): void => {
    try {
      const drain = deps.drainRecipientQueue
      if (drain === undefined) return
      void Promise.resolve(drain(recipientId)).catch((error: unknown) => {
        ctx.logger.warn(`[deepartments] drainRecipientQueue fire for "${recipientId}" failed (non-fatal — the next wake/sweep re-evaluates): ${error instanceof Error ? error.message : String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] drainRecipientQueue fire for "${recipientId}" threw (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // =========================================================================
  // DELIVERY ZONE (hoisted VERBATIM from applyInvoke — the same closures, the
  // same order, the same semantics).
  // =========================================================================
  // ---------------------------------------------------------------------------
  // Batch B2 — AGENT MESSAGING BUS (spec 003). The delivery side is the
  // materializePost seam EXACTLY (catalog targets: materialize + always-wake;
  // D4) with the bus framing/source; the native-route side is
  // `subagents.followup` for continuable children. The board wakePost above is
  // gone (B3 cutover — the bus is the only delivery path).
  // ---------------------------------------------------------------------------

  /** The one record the bus persists per send (spec §3.1): the durable source
   * of truth, on disk BEFORE any delivery (persist-before-deliver, D4). */
  const messageStoreDir = stateDir

  /** The boot-opened message store (load + compact + per-recipient index).
   * Rejects loud on mid-file corruption (spec §3.2 — fail loud, never hide);
   * tools surface the rejection at use.
   * FASE 2.6-C: when the dshd-core bus service is composed, the store is the
   * CORE's (opened once on first use from the shared org stateDir); in a
   * minimal composition (dshd-core absent) we fall back to the in-bundle open
   * — the SAME store, behavior-neutral. */
  const messagesStoreReady = (ctx.get('deepartments.bus') as BusSurface | undefined)?.storeReady ?? MessagesStore.open(messageStoreDir)

  /** The boot-opened feedback store (load + prune-to-cap + live-by-id index).
   * The dshd-feedback package is a pure LIBRARY (no composed Cordis service),
   * so this is opened in-bundle from the shared org stateDir — the single
   * per-apply instance the `dept_feedback*` tools own (AGENTS.md rule 4).
   * Rejects loud on mid-file corruption (spec §3.2 — fail loud, never hide). */
  const feedbackStoreReady = FeedbackStore.open(messageStoreDir)

  /**
   * B5 — whether an agent materialization error is the harness "no
   * provider/model" signature (the VARIANT-2 / builder-87 ghost: a worker whose
   * durable session is PRESENT but whose AgentOptions carry no provider/model).
   * Conservative: only an EXACT signature match marks a worker unusable.
   */
  const isNoProviderModelError = (error: unknown): boolean => {
    const text = error instanceof Error ? error.message : String(error)
    return /has no provider\/model/.test(text)
  }

  /** fb-6 (B5 forensics): attach the RESOLVED (post-fallback) AgentOptions
   * VERBATIM (JSON) to a residual no-provider/model error's message, so BOTH
   * the durable post-error row AND the B5 marker carry diagnostic context
   * ("what options did the failed create actually receive?"). The original
   * message text is PRESERVED (the JSON is APPENDED), so the
   * isNoProviderModelError regex classification is unchanged; the original
   * error is also kept as `cause` (ES2023) and its stack is retained. */
  const withAgentOptionsContext = (error: unknown, agentOptions: AgentOptionsLike | undefined): Error => {
    const message = error instanceof Error ? error.message : String(error)
    const wrapped = new Error(`${message} agentOptions=${JSON.stringify(agentOptions ?? null)}`, error instanceof Error ? { cause: error } : undefined)
    if (error instanceof Error && error.stack !== undefined) wrapped.stack = error.stack
    return wrapped
  }

  /**
   * M-A (2026-08-28) — the SINGLE fresh-mint point for a department HEAD: the
   * F8 fresh-mint body of materializePost (extracted VERBATIM) + the journal
   * seed of the head-rotation path. One helper, three callers:
   *   - the F8 slept-head wake (materializePost — `seed` absent → the fresh
   *     session stays EMPTY, EXACTLY the pre-extraction behavior, zero
   *     regression);
   *   - the archived-session rotation of a live head (the archive-leak flip —
   *     same caller shape, see rotateArchivedHeadSessionId);
   *   - the M-A host-plane `dept_head_rotate` tool (`seed` = the head's LAST
   *     durable journal via buildHeadRotationSeed — the session is minted with
   *     the journal as its continuation context).
   * The head keeps its identity (postId); only the underlying session
   * (context) is fresh: this registers the new entry (new sessionId,
   * previousChildId = the old session, sleepEpoch cleared — a rotation is NOT
   * sleep —, `rotated: true` marker), CREATES the new durable session, records
   * the handle + progress baseline, fire-and-forgets the workspace attach and
   * pins the department sidebar title. Returns the LIVE fresh target (throws
   * when the head cannot be materialized — the caller maps it to 'failed').
   */
  const freshMintHead = async (
    entry: PostEntry,
    dept: DepartmentConfig | undefined,
    opts: { seed?: readonly unknown[]; source?: string } = {}
  ): Promise<AgentLike> => {
    if (agents === void 0) throw new Error('[deepartments] head fresh-mint requires the agents service')
    const previousSession = entry.sessionId
    // fb-78 A3 — the fresh-mint is guarded against the workspace-registry
    // archived set: a head minted on an archived session id would be
    // live-but-INVISIBLE in the sidebar (the hide-set is add-only). The
    // uuid mint never collides; the guard makes the invariant explicit
    // (synchronous — no await between mint and check, fb-68 atomicity).
    const freshSessionId = mintFreshSessionIdNotArchived(
      ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined,
      () => String(SessionId(`${HEAD_SESSION_PREFIX}${entry.postId}-${randomUUID()}`)),
      `head fresh-mint "${entry.postId}"`
    )
    const coordinator = coordinatorForPost(entry.postId)
    // Drop the OLD session's reverse index BEFORE registering the fresh one
    // (registerEntry re-keys byChild by the new sessionId; without the delete
    // the old id would linger as a dead mapping).
    byChild.delete(previousSession)
    // Fix (head-sleep worker drain): the in-flight ledger is the sleep→boot
    // handoff; once the head is materialized (woken) its agent handles its own
    // workers, so clear the snapshot on the fresh incarnation. M-A: `rotated`
    // marks the rotation event (a rotation is NOT sleep — sleepEpoch stays
    // cleared).
    registerEntry({ ...entry, sessionId: freshSessionId, previousChildId: previousSession, sleepEpoch: undefined, inflightWorkers: undefined, rotated: true })
    const role = coordinator?.role ?? entry.role ?? 'department worker'
    const headPreset = entry.agentPreset ?? PRESET_ID
    // F10 (spec 004 §9.1): the materialized head carries its department's
    // architecture section (if any).
    const setup = headSetup(entry.postId, entry.roomId, role, headPreset, dept)
    const agentOptions = resolveMaterializeAgentOptions(coordinator?.agentOptions)
    // R2 (fb-42/25 — the glm-5.3-flash rotation class): the ROTATION-MODEL
    // PROBE runs BEFORE the fresh mint — the resolved model must be
    // CONFIGURED in the destination adapter/provider (a phantom-model mint
    // aborts FAIL-LOUD; a missing candidate retrofits to the known seed model
    // so the fresh head NEVER starts on a model its provider cannot serve).
    const probe = await probeRotationMintModel(entry.postId, agentOptions, WORKER_AGENT_OPTIONS, ctx.get('llm', false), ctx.logger)
    if (probe.kind === 'unknown-model') {
      throw new Error(
        `[deepartments] rotation mint of "${entry.postId}" ABORTED (fb-42 class): provider "${probe.provider}" is registered but NEITHER model "${probe.model}" NOR the known seed model "${probe.fallbackModel}" is configured in the adapter catalog — configure the model in the provider settings BEFORE rotating (the fresh head's first turn would fail with 'pi-ai <provider> has no configured model')`
      )
    }
    const mintOptions = probe.options
    // F5: the fresh incarnation lands in its department workspace (config
    // workspacePath); a department-less/legacy head falls back to the root.
    const deptCwd = await resolveDepartmentWorkspaceCwd(dept)
    const handle = await agents.create({
      sessionId: freshSessionId,
      // M-A: the seed is the OPTIONAL journal continuation of a head rotation
      // (buildHeadRotationSeed → the harness CreateAgentOptions.seed →
      // sessions.prepare(id, {seed, meta})); the F8 wake passes none (the
      // pre-extraction empty-session create, byte-identical).
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: headPreset },
      agentOptions: mintOptions,
      setup
    })
    if (handle !== void 0) byHeadHandle.set(freshSessionId, handle)
    const freshTarget = agents.get(freshSessionId)
    if (freshTarget === void 0) throw new Error(`[deepartments] head "${entry.postId}" could not be materialized (fresh rotation) for bus delivery`)
    markHeadProgress(freshSessionId, freshTarget)
    const source = opts.source ?? 'bus-deliver'
    void attachHeadSession(freshSessionId, source)
    // F8 (acceptance b): pin the head sidebar title on the FRESH session — the
    // old (archived) session is gone, so the fresh one MUST carry the pinned
    // department title or the row would fall back to the raw id. (A seeded
    // rotation already carries the title in the seed's `session/title` event —
    // pinSessionTitle's never-double-pin guard turns the runtime pin into a
    // no-op 'already-pinned'.)
    const titleSession = ctx.sessions.get(SessionId(freshSessionId))
    if (titleSession !== void 0) {
      const title = coordinator?.sessionTitle || HEAD_DEFAULT_SESSION_TITLE
      const titlePin = pinSessionTitle(titleSession, title)
      if (titlePin === 'pinned') {
        ctx.logger.info(`[deepartments] ${source}: pinned fresh head title "${title}" (${freshSessionId})`)
      } else if (titlePin === 'failed') {
        ctx.logger.warn(`[deepartments] ${source}: fresh head title pin failed for ${freshSessionId} (non-fatal — materialization continues)`)
      }
    }
    return freshTarget
  }

  /** VALLE lane B (fb-29 structural fix) — resolve the toolset the COLD
   * re-materialization seam hands to workerSetup, so a restarted worker is
   * NEVER re-created with an empty tool-scope (the fb-29 bug: the COLD path
   * built the setup WITHOUT `tools`, unlike the warm spawn engines that pass
   * `template.tools`). Resolution order:
   *  (B) fast-path — the entry's own durable `tools` (the spawn wrote it; the
   *      belt-and-suspenders cache), else
   *  (A) primary — re-resolve the role template via the spawn-surface reader
   *      (covers LEGACY entries WITHOUT the durable field; single source of
   *      truth = the role template file, exactly like the warm path), then
   *  (fb-29 guard) a ROLE-TEMPLATE worker whose template EXISTS but resolves an
   *      EMPTY tool-scope FAILS LOUDLY — never materialize a messaging-only
   *      worker in silence (the original fb-29 invariant; a legacy
   *      dept_post_create free-form-role worker with NO template file is the
   *      board-only BY-DESIGN class and is returned unchanged, no tools).
   * Returns `string[]` (the non-empty allow-list to apply) or `undefined`
   * (legacy board-only class — no tools to restore). */
  const resolveMaterializeWorkerTools = async (entry: PostEntry, role: string, dept: DepartmentConfig | undefined): Promise<string[] | undefined> => {
    // (B) the durable fast-path — the entry itself carries an explicit allow-list.
    if (Array.isArray(entry.tools) && entry.tools.length > 0) return [...entry.tools]
    // (A) primary — re-resolve the role template (covers legacy without the field).
    if (dept !== void 0) {
      const template = await resolveRoleTemplate(dept.id, role)
      if (template !== void 0) {
        if (Array.isArray(template.tools) && template.tools.length > 0) return [...template.tools]
        // fb-29 guard — an EXISTING role template that resolves EMPTY tools.
        throw new Error(`[deepartments] cold re-materialization of worker "${entry.postId}" (role "${role}", dept "${dept.id}") refused: the role template presets/departments/${dept.id}/${role}.md resolves an EMPTY tool scope — refusing to materialize a messaging-only worker (fb-29 invariant). Fix the template \`tools\` allow-list or the entry's durable tools.`)
      }
      // template === undefined: a role with NO template FILE = the legacy
      // dept_post_create board-only class (messaging-only BY DESIGN — never
      // failed); fall through to the no-tools return.
    }
    // A department-less legacy worker (no resolvable template tree) or a
    // board-only dept_post_create worker → no role tools to restore.
    return undefined
  }

  // ---------------------------------------------------------------------------
  // fb-300/fb-301 — the RESUME-SEAM TOOLSET ASSERTION (the fb-18 contract
  // mirrored at the resume/live path — the shared kernel of the materializePost
  // resume guard AND the `reassertPostToolset` surface member the boot heal
  // (tools.ts runToolsetReassertion) drives). M2.4 dual-dsh-scope + the
  // capability-less degradation follow the spawn.ts:1204 agentScopeKey pattern:
  // a stub composition without a scope key degrades to `undefined` (no-oracle →
  // `missing: []` → the guard/heal become a no-op, 0 regressions).
  // ---------------------------------------------------------------------------
  /** The agent scope key read (mirrors tools.ts `agentScopeOf` :2843 — the M2.4
   * dual-dsh-scope fallback: `scopeOf(agentCtx)` in hermetic (one instance),
   * `agentCtx.agent` in the live profile (the harness's real scope key)).
   * DEFENSIVE (spawn.ts:1196-1216): a minimal stub composition (no dsh-scope,
   * no `agent` binding) degrades to `undefined`, never throws. */
  const agentScopeKeyOf = (agentCtx: Context): object | undefined => {
    try {
      const viaScope = scopeOf(agentCtx)
      if (viaScope !== void 0) return viaScope
    } catch {
      // scopeOf unavailable for this ctx → fall through
    }
    try {
      return (agentCtx as unknown as { agent?: object }).agent
    } catch {
      return undefined
    }
  }

  /** The fb-18 role-EXPECTED resume toolset for a post — the DERIVATION-SEAM
   * FINGERPRINT: the OWN-LAYER names installHeadBoardTools registers
   * (universal for every post + the manager-gated head additions + the
   * allowExec-gated pair when the role DECLARES dept_exec — a role that
   * declares it also gets dept_zstd_read, P2-ENTRY). The declared capability
   * names (HEAD_BASE_TOOLS / the role's read/write/…) are deliberately NOT in
   * the expected set: they are ENVIRONMENT-DEPENDENT preset contributions
   * (absent in hermetic compositions, masked/visible per restrict in live) and
   * therefore CANNOT discriminate the resumed-unarmed class (an unarmed
   * session shows the globals too — the fb-300 evidence: read/grep/glob OK —
   * while NONE of the own-layer names exist on it). The own-layer registration
   * is the setup seam's irrevocable fingerprint: the awaited postSetup closure
   * runs mount → probe → restrict → installHeadBoardTools in ONE body, so the
   * own-layer landing proves the whole derivation ran. The worker declared
   * LIST still resolves through resolveMaterializeWorkerTools (the B durable
   * `entry.tools` fast-path is NEVER bypassed) for the exec-gate derivation. */
  const expectedPostResumeTools = async (entry: PostEntry, role: string, dept: DepartmentConfig | undefined, isWorker: boolean): Promise<string[]> => {
    if (isWorker) {
      const declared = await resolveMaterializeWorkerTools(entry, role, dept)
      const execGate = declared !== undefined && declared.includes('dept_exec') ? RESUME_EXEC_GATE_PAIR : []
      return [...new Set([...RESUME_UNIVERSAL_OWN_LAYER_PROBES, ...execGate])]
    }
    return [...new Set([...RESUME_UNIVERSAL_OWN_LAYER_PROBES, ...RESUME_HEAD_OWN_LAYER_PROBES])]
  }

  /** The shared CHECK: expected-vs-lived knowns — { missing, expected } for one
   * LIVE post. `missing.length === 0` = the session passed the derivation seam
   * (armed); a non-empty list = the harness resumed it WITHOUT the deepartments
   * setup (the fb-300/301 class). No live-scope oracle → missing [] (no-op). */
  const reassertPostToolsetCore = async (entry: PostEntry, live: { ctx: Context }, isWorker: boolean): Promise<{ missing: string[]; expected: string[] }> => {
    const role = coordinatorForPost(entry.postId)?.role ?? entry.role ?? 'department worker'
    const expected = await expectedPostResumeTools(entry, role, departmentForEntry(entry), isWorker)
    const key = agentScopeKeyOf(live.ctx)
    if (key === void 0) return { missing: [], expected }
    const visible = expected.filter((name) => live.ctx.tools.get(name, key) !== undefined)
    return { missing: missingPostTools(expected, visible), expected }
  }

  /** The registry-only FALLBACK (a harness-restored session the bundle cannot
   * dispose — the AgentRegistry exposes no public per-agent detach and
   * resume/create reject an already-live id): RE-DERIVE IN PLACE — re-run the
   * SAME setup derivation (preset mount → restrict allow-list → own-layer
   * install → audit) on the session's LIVE ctx (the apply-standing precedent,
   * src/subagent.ts:295-338). SAFE: an unarmed scope was NEVER restricted nor
   * own-layer registered (no double mask, no duplicate insert — the design's
   * documented fear of re-applying restrict applies only to an ARMED scope,
   * which never reaches here). Best-effort: a throw (e.g. a partially-armed
   * mid-setup-kill session with a duplicate section) is warned; the session
   * stays degraded until the next boot heal / cold wake — the wake itself is
   * never broken. */
  const rearmLivePostInPlace = async (entry: PostEntry, live: { ctx: Context }, isWorker: boolean): Promise<void> => {
    const role = coordinatorForPost(entry.postId)?.role ?? entry.role ?? 'department worker'
    const dept = departmentForEntry(entry)
    const workerTools = isWorker ? await resolveMaterializeWorkerTools(entry, role, dept) : undefined
    const setup = isWorker
      ? workerSetup(entry.postId, entry.roomId, role, { department: dept, ...(workerTools !== undefined ? { tools: workerTools } : {}) })
      : headSetup(entry.postId, entry.roomId, role, entry.agentPreset ?? PRESET_ID, dept)
    try {
      await setup(live.ctx)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" IN-PLACE toolset re-arm on the restored session FAILED (fb-300/fb-301 — the session stays degraded until the next boot heal / cold wake): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** The SHARED reassertion CORE (the boot heal + the materializePost resume
   * guard share it): verify the live session's toolset against the fb-18
   * contract and heal an IDLE unarmed session:
   *   - 'armed' — the expected toolset is present (exact no-op — the fast-path
   *     B of durable custom tools stands);
   *   - 'running' — a RUNNING target is NEVER disarmed (fb-301 — a mid-turn
   *     agent is left for its next idle wake); warn + audit, no mutation;
   *   - 'disposed' — an unarmed session whose handle the bundle owns
   *     (byHeadHandle) was DISPOSED (the registry entry released → the caller
   *     falls to the COLD re-derivation);
   *   - 'rearmed' — a registry-only restored session (no bundle handle) was
   *     re-armed IN PLACE (the same setup derivation on its live ctx).
   * Writes the 'unarmed' audit row on a heal. `missing` is the non-empty list
   * on a heal / [] otherwise. NEVER throws. */
  const reassertLivePostCore = async (entry: PostEntry, live: { ctx: Context; status: string }, isWorker: boolean, nowMs: () => number): Promise<{ verdict: 'armed' | 'running' | 'disposed' | 'rearmed'; missing: string[] }> => {
    const kind = isWorker ? 'worker' : 'head'
    const sessionId = String(SessionId(entry.sessionId))
    if (live.status === 'running') {
      // fb-301 — never disarm an agent MID-TURN (a real turn in flight): warn +
      // audit and defer to the next idle wake (the running gate CONTRADICTS the
      // fb-301 rotation-cut class: a mid-turn target is never disposed).
      ctx.logger.warn(`[deepartments] ${kind} "${entry.postId}" resumed LIVE with a toolset the setup-derivation seam did not verify while its turn is RUNNING — NOT disarmed (fb-301); the heal re-arms it at the next idle wake`)
      appendToolsetAudit(stateDir, { wp: 'unarmed', postId: entry.postId, kind, ts: nowMs(), reason: 'running-deferred' })
      return { verdict: 'running', missing: [] }
    }
    const { missing, expected } = await reassertPostToolsetCore(entry, live, isWorker)
    if (missing.length === 0) return { verdict: 'armed', missing: [] }
    ctx.logger.warn(`[deepartments] ${kind} "${entry.postId}" resumed LIVE with a DEGRADED toolset — the deepartments setup never ran on this session (fb-300/fb-301); missing expected tool(s): [${missing.join(', ')}] (expected ${expected.length} name(s))`)
    await disposeHeadHandle(sessionId)
    if (agents === void 0 || agents.get(sessionId) === undefined) {
      // (1) the bundle owned the handle (byHeadHandle) → the dispose released the
      // registry entry → the caller falls to the COLD re-derivation (the full
      // setup re-run + audit — the proven cold path, delivery.ts:1113-1115).
      appendToolsetAudit(stateDir, { wp: 'unarmed', postId: entry.postId, kind, ts: nowMs(), reason: 'dispose-cold', missing: missing.join(',') })
      return { verdict: 'disposed', missing }
    }
    // (2) the harness-restored registry-only session (no bundle handle) → the
    // in-place re-arm (same derivation, live ctx).
    appendToolsetAudit(stateDir, { wp: 'unarmed', postId: entry.postId, kind, ts: nowMs(), reason: 'rearm-inplace', missing: missing.join(',') })
    await rearmLivePostInPlace(entry, live, isWorker)
    return { verdict: 'rearmed', missing }
  }

  /** The SHARED REASSERTION ACTION (the surface member the boot heal drives;
   * see the DeliverySurface member doc for the outcome semantics). 'disposed'
   * is completed here by re-materializing COLD through materializePost (the
   * re-derivation writes its own toolset-final audit); a rearmed/armed/running
   * live target is left in place. NEVER throws. */
  const reassertPostToolset = async (entry: PostEntry, opts: { now?: () => number } = {}): Promise<{ outcome: 'not-live' | 'armed' | 'dispose-cold' | 'rearm-inplace' | 'running-deferred'; missing: string[] }> => {
    const nowMs = opts.now ?? (() => Date.now())
    if (agents === void 0) return { outcome: 'not-live', missing: [] }
    const isWorker = entry.provider === 'worker'
    const live = agents.get(String(SessionId(entry.sessionId)))
    if (live === void 0) return { outcome: 'not-live', missing: [] }
    const { verdict, missing } = await reassertLivePostCore(entry, live, isWorker, nowMs)
    if (verdict === 'armed') return { outcome: 'armed', missing: [] }
    if (verdict === 'running') return { outcome: 'running-deferred', missing: [] }
    if (verdict === 'rearmed') return { outcome: 'rearm-inplace', missing }
    // 'disposed' → complete the heal with the COLD re-materialization.
    await materializePost(entry)
    return { outcome: 'dispose-cold', missing }
  }

  /**
   * The SHARED post-materialization core of the wakePost seam (spec §4.3 step 2
   * — "EXACTLY wakePost"): respawn-from-sleep (dispose stale handle, clear
   * sleepEpoch, keep previousChildId), resume→create fallback with the post's
   * durable per-head preset + role, mark a fresh progress baseline, and
   * fire-and-forget the workspace attach. Returns the live target and whether
   * this call materialized it (the `resumed` delivery status). Throws when the
   * post cannot be materialized (the caller maps it to a `failed` delivery).
   */
  const materializePost = async (entry: PostEntry): Promise<{ target: AgentLike; resumed: boolean }> => {
    if (agents === void 0) throw new Error('[deepartments] bus delivery requires the agents service')
    // fb-9 RESUME SEAM (coverage-map §4-3): the SAME dispatch pre-flight as the
    // spawn engines, at the SINGLE choke point of the bus-wake materialization —
    // ONE call here covers EVERY agents.resume/agents.create below (the
    // sleep-respawn head create :6601, the archived-rotation head create :6666,
    // the shared cold-resume :6691 and its create-fallback :6694) with no
    // duplication. The mid-turn continuation 400 (the q-i-20 class) is NOT this
    // seam, but the RESUME class (fb-6: a cold-resumed worker re-plays the
    // tool-call history through the same openai-completions API) gets the same
    // fail-EARLY: a worker route whose profile has reasoning enabled but lacks
    // compat.requiresReasoningContentOnAssistantMessages=true never resumes into
    // its expensive first 400 — the wake fails loudly with the preflight error
    // instead (the delivery is mapped to 'failed' by busDeliverToPost).
    const preflightError = workerReasoningContentPreflightError()
    if (preflightError !== undefined) throw new Error(`[deepartments] ${preflightError}`)
    // DISPATCH-HARDENING (QH «429-primer-call»): the pooler-capacity
    // pre-check on the RESUME seam (the +1 of the fb-9 3+1) — a cold-resumed
    // / slept-respawned post wakes into ITS first call immediately; when the
    // pooler snapshot certifies no workspace can serve it, the wake fails
    // LOUDLY and EARLY (the delivery is mapped to 'failed' by busDeliverToPost,
    // exactly like the preflight error above) instead of burning the first
    // LLM turn on a 429/503.
    const poolerDispatchBlock = workerPoolerDispatchBlockError()
    if (poolerDispatchBlock !== undefined) throw new Error(`[deepartments] ${poolerDispatchBlock}`)
    const isWorker = entry.provider === 'worker'
    const coordinator = coordinatorForPost(entry.postId)
    let resumed = false
    if (entry.sleepEpoch !== void 0) {
      // Respawn from sleep: retire the live handle (if any), record the
      // previous incarnation, clear the flag. Joins any in-flight dept_sleep
      // detach (disposeHeadHandleOnce) so the incarnation below is guaranteed to
      // run only AFTER the machine is detached (no double-dispose race).
      // DEADLOCK FIX (2026-08-26): the join is BOUNDED — a zombie detach (a
      // slept machine whose turn can never settle, e.g. the QD-directive
      // cascade) would otherwise freeze THIS delivery forever, and every
      // awaited bus delivery to the slept head with it.
      if (!(await joinHeadDisposeOnce(entry.sessionId))) {
        ctx.logger.warn(`[deepartments] sleep respawn for "${entry.postId}": detach join timed out after ${disposeJoinTimeoutMs()}ms — proceeding with the fresh mint (zombie detach; the fresh incarnation uses a NEW session id, no collision)`)
      }
      byChild.delete(entry.sessionId)
      const previousSession = entry.sessionId
      // F8 (spec 002 head rotation) — a slept HEAD is recreated FRESH: mint a
      // new session id (the OLD one was ARCHIVED at dept_sleep) and CREATE a
      // brand-new durable session, never resume the archived old artifact. The
      // head keeps its identity (postId), journal and messages (archive ≠
      // delete); only the underlying session (context) is fresh. A disposable
      // WORKER keeps the legacy cold-resume of the SAME session — worker retire
      // is the separate archive path. M-A: the F8 fresh-mint body now lives in
      // the SHARED `freshMintHead` helper (the single fresh-mint point also
      // used by the host-plane dept_head_rotate tool); no seed is passed, so
      // the wake session stays EMPTY exactly like the pre-extraction create.
      if (!isWorker) {
        const freshTarget = await freshMintHead(entry, departmentForEntry(entry))
        return { target: freshTarget, resumed: true }
      }
      // Worker respawn: record the previous incarnation + clear the sleep flag,
      // then fall through to the shared cold-resume of the SAME session below.
      // A worker has no in-flight ledger of its own (only a head does), but clear
      // it for symmetry so a respawn never carries a stale snapshot.
      registerEntry({ ...entry, previousChildId: previousSession, sleepEpoch: undefined, inflightWorkers: undefined })
      resumed = true
    }
    const sessionId = SessionId(entry.sessionId)
    // fb-300/fb-301 (VALLE 09-09 — rematerialización de toolset post-smart_restart;
    // clase fb-18 contrato): the GUARD at the LIVE resume branch. A session the
    // harness restored into the agent registry WITHOUT the deepartments setup
    // (the smart-restart "AGENT REGISTRY ONLY" resume shape — boot.ts:943-944)
    // must NEVER be accepted as-is: its toolset never passed through the
    // derivation seam (postSetup tools.ts:2869-3058 — the own-layer
    // dept_exec/dept_zstd_read/secretary + the restrict allow-list are absent →
    // the fb-300 "unknown tool dept_exec" class). When the expected role
    // toolset is MISSING from the live scope and the target is IDLE, the live
    // handle is disposed and the wake FALLS THROUGH to the COLD derivation
    // below (the re-resume re-runs the full setup + audit — delivery.ts:1113-
    // 1115). A RUNNING target is NEVER disarmed (fb-301 — a mid-turn agent is
    // left for the boot heal at its next idle wake; the wake continues on the
    // degraded toolset instead of interrupting a real turn). An ARMED live
    // target stays the fast-path (the durable custom-tools fast-path B, :1008,
    // is never bypassed: the expected set resolves through
    // resolveMaterializeWorkerTools, B belt-and-suspenders first). A
    // registry-only restored session (no bundle handle) is re-armed in place.
    let live = agents.get(String(sessionId))
    if (live !== void 0) {
      const guard = await reassertLivePostCore(entry, live, isWorker, () => Date.now())
      if (guard.verdict === 'disposed') {
        // the unarmed live handle was disposed (the registry entry released by
        // the handle's own teardown) → fall through to the COLD re-derivation
        live = undefined
      }
      // 'armed' (fast-path — the wake proceeds on the live target as before) /
      // 'rearmed' (the registry-only session was re-armed IN PLACE — the wake
      // proceeds on the SAME live target, now armed) / 'running' (deferred —
      // the wake continues on the live target) → keep the live target.
    }
    if (live === void 0) {
      const role = coordinator?.role ?? entry.role ?? 'department worker'
      const headPreset = entry.agentPreset ?? PRESET_ID
      // F10 (spec 004 §9.1): the re-materialized post carries its department's
      // architecture section (a worker by its durable departmentId, a head by
      // config; a department-less/legacy entry → omitted cleanly).
      const dept = departmentForEntry(entry)
      // VALLE lane B (fb-29 structural fix): the COLD re-spawn hands the worker
      // its role template's TOOLS (B durable fast-path → A re-resolution → the
      // fb-29 loud guard) — never a silently messaging-only re-materialization
      // (the original fb-29 bug: this seam built the setup WITHOUT tools, unlike
      // the warm spawn engines). A legacy board-only worker resolves `undefined`
      // → the pre-fix no-tools setup byte-identical.
      const workerTools = isWorker ? await resolveMaterializeWorkerTools(entry, role, dept) : undefined
      const setup = isWorker
        ? workerSetup(entry.postId, entry.roomId, role, { department: dept, ...(workerTools !== undefined ? { tools: workerTools } : {}) })
        : headSetup(entry.postId, entry.roomId, role, headPreset, dept)
      const agentOptions = resolveMaterializeAgentOptions(coordinator?.agentOptions)
      const preset: string = isWorker ? WORKER_PRESET_ID : headPreset
      // MPC-PREFLIGHT (puerta 4, §4.2) — EL HUECO POR EL QUE PASÓ EL INCIDENTE:
      // este punto de create/resume de heads Y workers NO tenía ningún probe (el
      // 09-10 golpeó turnos de agentes ya vivos y su re-materialización). El
      // guard resuelve el pin RESUELTO POR SESIÓN de la fuente durable (nunca
      // por la fecha del sessionId, §P5) y aplica la semántica R2 + el retrofit
      // del handle stale al pin actual (fb-332) — sin sustitución silenciosa.
      const handleRoutePin = await readResolvedSessionRoutePin(ctx, String(sessionId))
      const materializePinProbe = await resolvedModelHandleVerdict(entry.postId, agentOptions, agentOptions, handleRoutePin, ctx.get('llm', false), ctx.logger)
      if (materializePinProbe.kind === 'unknown-model') {
        ctx.logger.warn(
          `[deepartments] materialization pin guard "${entry.postId}": provider "${materializePinProbe.provider}" is registered but NEITHER the pinned model "${materializePinProbe.model}" NOR the seed model "${materializePinProbe.fallbackModel}" is in the live catalog — the session was STILL materialized (fb-42/C1: an unrepaired actor loses the ability to repair the org; the turn will fail with 'pi-ai <provider> has no configured model')` +
          ` — ADD the id to the live catalog (additive-first) or rotate the pin`
        )
      }
      const materializeOptions: AgentOptionsLike = materializePinProbe.kind === 'unknown-model' ? agentOptions : materializePinProbe.options
      let handle: AgentHandleLike | undefined
      // F5 (spec 004 §6.2 L1): the FRESH-create fallback of a bus wake lands the
      // re-materialized session in ITS department workspace (a worker by its
      // durable departmentId, a head by config); a department-less/legacy entry
      // falls back to the shared workspace root (deptCwd ''). The resume path
      // above keeps the session's stored header cwd (immutable per session).
      const deptCwd = await resolveDepartmentWorkspaceCwd(departmentForEntry(entry))
      // THE VISIBILITY FIX (2026-08-25 P2 + fb-78 A3): a NON-slept HEAD whose
      // durable session id is in the workspace registry's archived set must
      // NEVER be RESUMED — a live head's session is never archived, because the
      // GUI sidebar hides any archived session id (the re-seed resume of an
      // archived id is the root cause of the live-but-invisible head). Rotate
      // to a FRESH id (the F8 fresh-mint shape) and CREATE. fb-78 A3 extends
      // the SAME invariant to a WORKER whose durable session id is ARCHIVED
      // while its post is NOT retired (the transient archive-leak class the QD
      // observed — the hide-set is ADD-ONLY, no unarchive, so a cold-resume on
      // the archived id would leave the worker live-but-invisible FOREVER):
      // rotate to a FRESH worker-<postId>-<uuid> + register + CREATE (the
      // head-branch mirror). A NON-archived worker resume stays byte-identical
      // (zero regression on the legacy worker cold-resume).
      const workspaceRegistry = (): WorkspaceRegistryLike | undefined =>
        ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
      let rotatedSessionId: string | undefined
      if (!isWorker) {
        rotatedSessionId = await rotateArchivedHeadSessionId(entry.postId, String(sessionId))
      } else if (entry.retired !== true && isArchivedSession(workspaceRegistry(), String(sessionId))) {
        // fb-78 A3 — the worker-side rotation: a fresh worker-<postId>-<uuid>
        // mint (the mint itself is guarded against the archived set too).
        rotatedSessionId = mintFreshSessionIdNotArchived(workspaceRegistry(), () => mintWorkerSessionId(entry.postId), `worker cold-resume "${entry.postId}"`)
        ctx.logger.warn(`[deepartments] worker "${entry.postId}" durable session ${String(sessionId)} is ARCHIVED (post NOT retired — the transient archive-leak class) — rotating to fresh ${rotatedSessionId} instead of resuming the archived id (a live worker's session is never archived)`)
      }
      if (rotatedSessionId !== void 0) {
        registerEntry({ ...entry, sessionId: rotatedSessionId, previousChildId: String(sessionId), sleepEpoch: undefined })
        handle = await agents.create({
          sessionId: rotatedSessionId,
          meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: preset },
          agentOptions: materializeOptions,
          setup
        })
        if (handle !== void 0) byHeadHandle.set(rotatedSessionId, handle)
        const rotatedTarget = agents.get(rotatedSessionId)
        if (rotatedTarget === void 0) throw new Error(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" could not be materialized (archived-session rotation) for bus delivery`)
        markHeadProgress(rotatedSessionId, rotatedTarget)
        void attachHeadSession(rotatedSessionId, 'bus-deliver')
        if (!isWorker) {
          const titleSession = ctx.sessions.get(SessionId(rotatedSessionId))
          if (titleSession !== void 0) {
            const title = coordinator?.sessionTitle || HEAD_DEFAULT_SESSION_TITLE
            const titlePin = pinSessionTitle(titleSession, title)
            if (titlePin === 'pinned') {
              ctx.logger.info(`[deepartments] archive-leak rotation: pinned fresh head title "${title}" (${rotatedSessionId})`)
            } else if (titlePin === 'failed') {
              ctx.logger.warn(`[deepartments] archive-leak rotation: fresh head title pin failed for ${rotatedSessionId} (non-fatal — materialization continues)`)
            }
          }
        }
        resumed = true
        return { target: rotatedTarget, resumed: true }
      }
      try {
        handle = await agents.resume({ resumeSessionId: String(sessionId), agentOptions: materializeOptions, setup })
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" bus wake-resume failed, creating fresh: ${error instanceof Error ? error.message : String(error)}`)
        handle = await agents.create({
          sessionId: String(sessionId),
          meta: { cwd: deptCwd !== '' ? deptCwd : await resolveWorkspaceRootPath(), origin: undefined, agentPreset: preset },
          agentOptions: materializeOptions,
          setup
        }).catch((createError: unknown) => {
          // B5 — a WORKER whose create throws "has no provider/model" is the
          // VARIANT-2 / builder-87 ghost: a DURABLE session PRESENT but with NO
          // usable AgentOptions. The fb-6 fallback above has ALREADY resolved a
          // usable provider/model (WORKER_AGENT_OPTIONS) into `agentOptions`, so
          // this branch is the RESIDUAL case: the create fails even WITH
          // options. Record the durable marker so the boot reconcile's
          // `isSessionUnusable` classifies it as a retire-leak candidate (under
          // the existing retireGoneWorkers opt-in), and attach the RESOLVED
          // AgentOptions VERBATIM (JSON) to the error message (fb-6 forensics)
          // so BOTH the post-error row and the marker carry the exact options
          // the failed create received (the appended JSON never changes the
          // isNoProviderModelError classification — the original text is kept).
          // The marker is CLEARED on a successful materialization (see the
          // return below), so a worker that recovers is never over-retired.
          if (isWorker && isNoProviderModelError(createError)) {
            const forensic = withAgentOptionsContext(createError, agentOptions)
            void markUnusableWorkerSession(stateDir, entry.postId, entry.sessionId, forensic.message)
            throw forensic
          }
          throw createError
        })
      }
      if (handle !== void 0) byHeadHandle.set(String(sessionId), handle)
      resumed = true
    }
    const target = agents.get(String(sessionId))
    if (target === void 0) throw new Error(`[deepartments] ${isWorker ? 'worker' : 'head'} "${entry.postId}" could not be materialized for bus delivery`)
    // Clear a B5 unusable mark: this worker materialized successfully, so its
    // session is usable again (never over-retire a recovered worker).
    if (isWorker) await clearUnusableWorkerSession(stateDir, entry.postId)
    // Fresh baseline for the (re)materialized incarnation so the stuck check
    // never misjudges a just-cold-resumed post.
    markHeadProgress(String(sessionId), target)
    void attachHeadSession(String(sessionId), 'bus-deliver')
    return { target, resumed }
  }

  /** The delivered user-message for ONE bus deliver (spec §4.3): the framed
   * text as content + the `agent/send` source. Built via createUserMessage with
   * a FRESH inline literal (mirroring wakePost's compile-clean call shape). */
  const busUserMessage = (record: MessageRecord, framed: string, senderSessionId: string | undefined) =>
    createUserMessage({
      // W8-b prompt-literal safety: the delivered bus message text (already
      // framed) is run through the brace sanitizer so an unbound double-brace
      // token in a message can never break the recipient session assembly.
      // Bound persona/preset vars are preserved.
      content: [{ type: 'text', text: sanitizePromptLiterals(framed) } as const],
      // W7-B: the source is projected to a PLAIN JSON-safe value BEFORE it is
      // inserted (the `agent/inbox/spliced` append boundary rejects
      // branded/class instances, a present `undefined` key, functions, etc.).
      // `senderSessionId: undefined` (no caller session) is OMITTED, never
      // emitted as a present-undefined key. A malformed value never throws.
      source: jsonSafeMessageSource({
        kind: 'agent',
        form: 'send',
        plugin: 'deepartments',
        summary: boundContextSummary(`New message from ${record.from} to ${record.to.length} recipient(s) (${record.kind}).`),
        to: [...record.to],
        messageId: record.id,
        from: record.from,
        senderSessionId: senderSessionId === undefined ? undefined : SessionId(senderSessionId),
        // FB-258 (C3 — owner addendum m-3298): the createdAt/receivedAt PAIR
        // travels in the source (W7-B JSON-safe plain numbers, never a
        // present-undefined key). createdAt = the durable record ts (the
        // messages.jsonl append time); receivedAt = the moment THIS followup is
        // received by the destination session (the splice) — the Δ is the drain
        // latency, measurable where the source is projected (agent_messages /
        // the GUI row).
        createdAt: record.ts,
        receivedAt: Date.now()
      })
    })

  // ---------------------------------------------------------------------------
  // BATCH-DRAIN (VALLE 09-07 — PROGRAMMING REQUEST 1662eecf, drain-on-settle
  // PURO; spec explore-deep-47/b99b8ce6): the delivery to a RUNNING recipient
  // accumulates its queue; at the SETTLE (the `agent/status` running→idle
  // transition — setPhase, dsh-agent-loop) the wake successor receives ALL the
  // pending messages in ONE followup (delta multi-mensaje, seq order) instead
  // of 1 message → 1 turn. The batch resolves the 1:1 at the FIRST link (the
  // engine's per-record followup: busDeliverToPost :1009 / :1157 / :1190); the
  // harness Inbox (dsh-agent lib/types/inbox.js:53 — one next-turn claim per
  // turn) is untouched. ACCUMULATOR is apply-scoped (AGENTS.md rule 4 — no
  // module-global mutable state); the rows stay 'prepared' (write-ahead) until
  // the flush marks 'delivered' — a crash mid-batch is the same crash-safe
  // re-drive class of today (the boot re-delivery driver / sweep re-drive the
  // 'prepared' pairs 1:1, no loss). Only the ALWAYS-WAKE no-interrupt send
  // (batchEligible) ever accumulates: noWake/ack/interrupt/child/re-drive/
  // boot/daemon/emergencies bypass by construction (no flag).
  // ---------------------------------------------------------------------------
  /** ONE accumulated bus message to a running session (the batch's unit): the
   * durable record + its framed text + the sender's session id (for the delta
   * source projection). */
  interface BatchItem {
    record: MessageRecord
    framed: string
    senderSessionId?: string
  }

  /** The apply-scoped batch accumulator: sessionId (the LIVE handle's session
   * id) → the pending always-wake records in ARRIVAL (seq) order. */
  const batchDrain = new Map<string, BatchItem[]>()

  /** Queue one batch-eligible record for a RUNNING session. Defensive dedupe
   * by record.id (the sweep's re-drive of a >10-min 'prepared' batch row must
   * never double-queue a record — the flush additionally filters already-
   * settled rows, see flushBatchFor). */
  const queueBatchFor = (sessionId: string, item: BatchItem): boolean => {
    const existing = batchDrain.get(sessionId) ?? []
    if (existing.some((i) => i.record.id === item.record.id)) {
      ctx.logger.warn(`[deepartments] batch-drain queue dedupe: record ${item.record.id} already queued for session "${sessionId}" — skipped (defensive; the batch presents each record once)`)
      return false
    }
    batchDrain.set(sessionId, [...existing, item])
    ctx.logger.info(`[deepartments] batch-drain: record ${item.record.id} queued for running session "${sessionId}" (${existing.length + 1} pending — delivered in ONE followup at the settle)`)
    return true
  }

  /** The drain-on-settle DELTA for one session: the N pending frames in ONE
   * content (sanitizePromptLiterals per frame — W8-b) + a single `agent/send`
   * source carrying the batch marker (`batch: true` + messageIds, W7-B JSON-safe
   * projection). `withFirst` (the W9-b interruptor) comes FIRST — the preemption
   * order: the wake later brings [interruptor, ...pending in seq order].
   * GUI history-load identity fix (VALLE 09-08): the delta is built via
   * `createUserMessage` EXACTLY like the single-path `busUserMessage` below so
   * the materialized user/message carries a stable `data.id` (MessageId from a
   * fresh randomUUID). Pre-fix this builder returned a bare { content, source }
   * WITHOUT an id, so every batch-delivered user/message landed in the session
   * log with `data.id === undefined` and the conversation splitter's
   * messageDefinition identity `String(event.data.id)` collapsed ALL of them to
   * `"undefined"` (conversationContextKey `13:input-messageundefined`) — the 2nd+
   * start Match threw «received more than one start Match» on history load
   * (explore-deep-58/9620de90). */
  const busBatchUserMessage = (items: BatchItem[]): UserMessage => {
    const first = items[0]
    const frames = items.map((item) => sanitizePromptLiterals(item.framed)).join('\n')
    // The followup-boundary shape (the same { content, source } projection the
    // plain `busUserMessage` builds via createUserMessage — W8-b literal
    // sanitization per frame, W7-B JSON-safe source with the batch marker).
    return createUserMessage({
      content: [{ type: 'text', text: frames } as const],
      source: jsonSafeMessageSource({
        kind: 'agent',
        form: 'send',
        plugin: 'deepartments',
        summary: boundContextSummary(`${items.length} bus message(s) delivered together at the settle (drain-on-settle batch).`),
        to: [...first.record.to],
        messageId: first.record.id,
        messageIds: items.map((item) => item.record.id),
        batch: true,
        from: first.record.from,
        senderSessionId: first.senderSessionId === undefined ? undefined : SessionId(first.senderSessionId),
        // FB-258 (C3 — owner addendum m-3298): the PAIR for the delta —
        // createdAt = the FIRST frame's durable record ts (the earliest seq;
        // per-frame ts stay derivable via source.messageIds → messages.jsonl),
        // receivedAt = the flush/settle moment (honest: «cuándo lo recibió la
        // sesión destino» — the Date.now() of THIS followup splice).
        createdAt: first.record.ts,
        receivedAt: Date.now()
      })
    })
  }

  /** FLUSH the pending batch of ONE session in a single followup (the settle
   * hook + the W9-b interrupt drain). `opts.withFirst` = an additional item
   * presented FIRST (the interruptor — its record was delivered through the
   * normal route, never accumulated). Semantics:
   *   1. items (withFirst + pending, seq order preserved) → ONE delta followup
   *      into the LIVE handle (`agents.get(sessionId)`);
   *   2. per item: markDelivery 'delivered' (the row was 'prepared' — the
   *      write-ahead); items whose LATEST row is already final (the sweep's
   *      1:1 re-drive spliced them during a >10-min turn) are EXCLUDED from
   *      the delta and the marks (never a double presentation);
   *   3. `agents.get(sessionId) === undefined` (the handle died / rotated /
   *      disposed before the flush) → NO marks, rows stay 'prepared' → the
   *      boot re-drive delivers them 1:1 (the spec §5.1 degraded path — a
   *      mark without a splice would LOSE the message);
   *   4. `batchDrain.delete(sessionId)` — the flush is the drain.
   * Crash between the followup and the marks → rows stay 'prepared' → re-drive
   * 1:1 (the same write-ahead class of today; no loss). NEVER throws.
   * Returns the number of records presented (0 = no-op). */
  const flushBatchFor = async (sessionId: string, opts?: { withFirst?: BatchItem }): Promise<number> => {
    try {
      const pending = batchDrain.get(sessionId) ?? []
      const all = opts?.withFirst !== undefined ? [opts.withFirst, ...pending] : pending
      if (all.length === 0) return 0
      const memberId = postIdForChild(sessionId) ?? hostIdForSession(sessionId)
      if (memberId === undefined) {
        ctx.logger.warn(`[deepartments] batch-drain flush for session "${sessionId}": no catalog member id resolves (postIdForChild/hostIdForSession) — rows stay 'prepared' for the re-drive (no marks, no loss)`)
        batchDrain.delete(sessionId)
        return 0
      }
      // Re-drive guard: an item whose LATEST sidecar row is already FINAL was
      // delivered 1:1 by the sweep (a >10-min turn raced the batch) — exclude
      // it from the delta (never present the same message twice).
      const toPresent: BatchItem[] = []
      for (const item of all) {
        let st: DeliveryStatus | null = null
        try {
          st = await deliveryStatus(stateDir, item.record.id, memberId)
        } catch (error: unknown) {
          ctx.logger.warn(`[deepartments] batch-drain flush: delivery-status read failed for ${item.record.id} → ${memberId} (item included — fail-open: the read is a de-dupe guard only): ${error instanceof Error ? error.message : String(error)}`)
        }
        if (st !== null && st !== 'prepared') continue // already delivered/settled 1:1
        toPresent.push(item)
      }
      batchDrain.delete(sessionId)
      if (toPresent.length === 0) return 0
      const live = agents?.get(sessionId)
      if (live === void 0) {
        // The handle died before the flush — never mark 'delivered' without a
        // splice (spec §5.1: a mark without the delivery = message loss). The
        // rows stay 'prepared' → the boot re-drive / sweep delivers them 1:1.
        ctx.logger.warn(`[deepartments] batch-drain flush for session "${sessionId}": the live handle is GONE (retired/rotated/disposed) — ${toPresent.length} record(s) left 'prepared' for the 1:1 re-drive (no loss, degraded)`)
        return 0
      }
      const delta = busBatchUserMessage(toPresent)
      live.followup(delta)
      for (const item of toPresent) {
        try {
          await markDelivery(stateDir, item.record.id, memberId, 'delivered')
        } catch (markError: unknown) {
          ctx.logger.warn(`[deepartments] batch-drain flush: 'delivered' mark for ${item.record.id} → ${memberId} failed (non-fatal — the row stays 'prepared' for the re-drive): ${markError instanceof Error ? markError.message : String(markError)}`)
        }
      }
      ctx.logger.info(`[deepartments] batch-drain FLUSHED session "${sessionId}": ${toPresent.length} record(s) in ONE followup → 'delivered' (${opts?.withFirst !== undefined ? 'with the interruptor first' : 'drain-on-settle'})`)
      return toPresent.length
    } catch (error: unknown) {
      // Never throws: a flush failure leaves the rows 'prepared' (re-driveable).
      ctx.logger.warn(`[deepartments] batch-drain flush for session "${sessionId}" failed (rows stay 'prepared' — the re-drive recovers): ${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }

  /** BATCH-DRAIN SETTLE HOOK (drain-on-settle puro — sin ventanas): the
   * `agent/status` running→idle transition (setPhase, dsh-agent-loop lib
   * /index.js:384-388 + kick finally :480-490) IS the settle event. The plugin
   * already consumes agent events (agent/created tools.ts:5532 — the same bus);
   * the payload arrives FUSED as { status, agent } (agentEvents, dsh-agent).
   * The flush is fire-and-forget (void + .catch — NEVER throws onto the
   * driver's settle path). Idle-with-no-batch → no-op (the hook costs nothing
   * for the 99.9% non-batch flow). */
  ctx.on('agent/status', ({ agent, status }: { agent?: { id?: string }; status?: string }) => {
    if (status !== 'idle') return
    const sessionId = String(agent?.id ?? '')
    if (sessionId === '') return
    void flushBatchFor(sessionId).catch((error: unknown) => {
      ctx.logger.warn(`[deepartments] batch-drain settle flush for session "${sessionId}" rejected: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  /** FB-198 (T1, 2026-09-07) — classify a wake primitive's caught error into
   * its WAKE failure ground (the durable-re-driveable family; the ADDRESS is
   * valid, the materialize/wake failed). The 'session not found' class is the
   * harness session-persistence seam (the W8-i resilient-retry exhausted); the
   * 'pool' class is the pooler-capacity gate text (the fb-198 allBlocked/429
   * trigger — `pool: workspace … at quota … dispatch delayed`); everything else
   * is the generic materialization/wake failure. PURE, never throws. */
  function wakeFailureGround(error: unknown): BusDeliveryFailedGround {
    const message = error instanceof Error ? error.message : String(error)
    if (isSessionNotFoundError(message)) return 'session-not-found'
    if (/pool:|at quota|dispatch delayed/i.test(message)) return 'pool'
    return 'materialization-failed'
  }

  /** The shared post DELIVERY of one bus message: the wakePost seam including
   * the stuck-head recovery verbatim (relay guards §4.4). Never throws — the
   * error is logged AND returned as 'failed' (never silent). W9-b: when
   * `opts.interrupt` is true and the recipient is LIVE mid-turn, the CURRENT
   * turn is aborted (reason 'interrupted', keepInbox preserved) so the message
   * is the FIRST item of the recipient's next turn instead of queueing behind
   * it. Default (false) = QUEUE semantics, unchanged. */
  const busDeliverToPost = async (entry: PostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined, opts?: DeliveryInterruptOptions): Promise<DeliveryStatus> => {
    const sessionId = String(SessionId(entry.sessionId))
    const interrupt = opts?.interrupt === true
    try {
      const live = agents?.get(sessionId)
      // VALLE 09-07 (BATCH-DRAIN) — the ACCUMULATION seam (eslabón 1 of the
      // 1:1): a batch-eligible ALWAYS-WAKE (send_message default; NEVER on
      // noWake/ack/interrupt/child/re-drive/boot/daemon/emergencies) to a
      // CURRENTLY RUNNING recipient does NOT splice the inbox 1:1 — the record
      // (already 'prepared', write-ahead) is queued for the drain-on-settle
      // flush (ONE followup at the settle with ALL pending, seq order). The
      // engine's markFinal writes a second 'prepared' row — the SAME crash-safe
      // pattern as the fifo-gate/noWake classes; a crash mid-batch re-drives
      // 1:1 (no loss). The stuck-head case is EXCLUDED (a wedged session must
      // take the existing dispose+cold-resume recovery, never batch). Idle
      // (live undefined / status !== 'running') → NOT accumulated: the plain
      // followup below wakes the recipient as today (the first message wakes;
      // the batch NEVER delays a settle — no starvation by construction).
      if (opts?.batchEligible === true && live !== void 0 && live.status === 'running' && !(entry.sleepEpoch === void 0 && isHeadStuck(sessionId, live))) {
        queueBatchFor(sessionId, { record, framed, senderSessionId })
        return 'prepared'
      }
      // Fix A2 stuck-head resilience (verbatim): a live-but-running post with
      // NO session progress for STUCK_HEAD_MS is wedged; dispose + cold-resume
      // (serialized per head), re-delivering from the DURABLE message record —
      // never into the frozen loop's in-memory inbox.
      if (live !== void 0 && entry.sleepEpoch === void 0 && isHeadStuck(sessionId, live)) {
        ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}": live but stuck (no session progress for ${STUCK_HEAD_MS / 1000}s) — disposing + cold-resuming from the durable message record`)
        await serializeHeadRecovery(sessionId, async () => {
          await disposeHeadHandle(sessionId)
          headProgress.delete(sessionId)
          const { target } = await materializePost(entry)
          target.followup(busUserMessage(record, framed, senderSessionId))
        })
        return 'resumed'
      }
      // W9-b interrupt: a LIVE, currently-running recipient with `interrupt:
      // true` is preempted — abort its CURRENT turn (reason 'interrupted') and
      // preserve any already-pending inbox work (keepInbox), so the message
      // delivered below is the FIRST item of the recipient's next turn. A
      // DORMANT recipient (live === undefined) needs no abort — the followup
      // below wakes it immediately (unchanged).
      // M3 (spec §2.4): the abort is gated by the shared per-recipient interrupt
      // back-off (safeInterrupt) — at most ONE interrupt per recipient per
      // INTERRUPT_COOLDOWN_MS, regardless of identity/class count. A turn just
      // interrupted by the daemon is within the cooldown → it is NEVER
      // interrupted again (the re-entrancy guard); a delivery that falls inside
      // the cooldown races through to QUEUE semantics (no abort).
      if (interrupt && live !== void 0 && live.status === 'running') {
        const aborted = await safeInterrupt(live, entry.postId, Date.now(), stateDir, opts?.sourceKey)
        if (aborted) {
          ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}": interrupt=true — aborted the current turn (reason 'interrupted'); delivery is the first item of the next turn${opts?.sourceKey !== undefined ? ` (source: ${opts.sourceKey})` : ''}`)
        } else {
          ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}": interrupt=true but within the per-recipient cooldown — delivery queued (no abort)`)
        }
      }
      const { target, resumed } = await materializePost(entry)
      // VALLE 09-07 (BATCH-DRAIN) — the FLUSH seam: a delivery that reaches the
      // followup while this session has a PENDING batch (the W9-b INTERRUPT
      // drain — the interruptor is delivered through the normal route, NEVER
      // batch-eligible, and the wake must bring [interruptor, ...pendientes] in
      // ONE delta) splices the batch flush instead of the plain 1:1 followup.
      // No pending batch → the byte-identical plain followup (idle/dormant/non-
      // batch deliveries — the settle hook flushes the rest at running→idle).
      if (batchDrain.has(sessionId)) {
        await flushBatchFor(sessionId, { withFirst: { record, framed, senderSessionId } })
      } else {
        target.followup(busUserMessage(record, framed, senderSessionId))
      }
      const status = resumed ? 'resumed' : 'delivered'
      // FB-132 (wake-on-delivered 2026-09-06 — the 2nd-half drain lane): a
      // SUCCESSFUL post wake IS the recipient's REAL wake — its 'prepared'
      // queue (a noWake / FIFO-gated delivery waiting behind) must FINALLY
      // drain, FIFO head-first in seq order (the m-1933 family; the «drains at
      // its next real wake» contract). The drain does NOT fire HERE: at this
      // point the CURRENT delivery's write-ahead 'prepared' row is still
      // pending (the engine's final mark lands AFTER this primitive returns —
      // dshd-core delivery.ts:497) — a fire here would re-drive THE CURRENT
      // pair (the observed c1 duplicate). The engine fires the drain via its
      // `onDelivered` hook exactly AFTER markFinal (the delivery is settled —
      // the drain re-drives only what is still pending), fire-and-forget +
      // non-fatal + capped; the enqueueHostWake rotation path keeps a direct
      // `fireQueueDrain` (it bypasses the engine — no sidecar row of its own).
      // Fix B (head-sleep worker drain): a WORKER that has just delivered a
      // message to ITS OWN MANAGER HEAD is cut clean immediately — the delivery
      // itself is the retire trigger, so a worker that delivered its report to a
      // (possibly dormant) head is retired WITHOUT relying on the head remembering
      // an open item. The 'resumed' status is exactly the sleep-boundary signature
      // (the recipient was dormant at delivery time and was re-materialized). The
      // retire is a defensive no-op if the worker is already retired (idempotent).
      if (status === 'resumed' || status === 'delivered') {
        const senderEntry = byPost.get(record.from)
        if (senderEntry !== void 0 && senderEntry.provider === 'worker' && senderEntry.retired !== true && senderEntry.managerId === entry.postId) {
          try {
            // O1 (LANE ②): the retire passes the DISPOSE GRACE — the worker is
            // the CALLER of this send, still mid-tool-call; the deferred handle
            // dispose lets its send_message tool result complete before the
            // retire tears the handle down (the 34→16→3 ms AbortError race).
            await retirePost(record.from, String(SessionId(entry.sessionId)), { deferDisposeMs: AUTO_RETIRE_DISPOSE_GRACE_MS })
          } catch (error: unknown) {
            ctx.logger.warn(`[deepartments] auto-retire of worker "${record.from}" on delivery to "${entry.postId}" failed (non-fatal to the delivery): ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      return status
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      // W6 system-health: record the hard materialization/wake failure for the
      // health daemon (failures must reach the Asistente; post-errors.jsonl is
      // the durable anomaly source). A persist failure folds to a warn only.
      // Issue-1 (b) (owner m-331): use the RECORDING DEDUPE (appendPostErrorDeduped
      // in the shared health-alerts-state.json ledger) so a persistent failure of
      // a NON-host post is recorded at most once per (post + class) per
      // HEALTH_DEDUPE_WINDOW_MS — mirroring the host path — and the QD directive
      // below is gated on an actually-NEW append, NOT emitted per attempt.
      try {
        const errText = error instanceof Error ? error.message : String(error)
        const cls = postErrorClass(errText)
        const recordKey = `${POST_ERROR_RECORD_KEY_PREFIX}${entry.postId}:${cls ?? 'generic'}`
        const appended = await appendPostErrorDeduped(stateDir, {
          ts: Date.now(),
          postId: entry.postId,
          messageId: record.id,
          error: errText
        }, recordKey, Date.now())
        // QD (spec 007 §6.4, D-Q4a): a NEW post-error record (the spec-006 capture)
        // triggers an ADDRESSED QUALITY INSPECT directive to quality-head (with the
        // error record) — the event-driven, bus-ready analysis seam (additive to the
        // spec-006 host ALERT). Non-fatal (the helper wraps its own try/catch).
        // Issue-1 (b): `appended` is the recording-dedupe result — a dedupe-skip
        // means no new record, so do NOT re-signal (Bound the non-host cascade).
        // ECHO GUARD (reviewer gate): a failed QUALITY INSPECT directive delivery to
        // `quality-head` lands in THIS SAME catch — if we re-emitted a post-error
        // directive for it, the directive → busDeliverToPost(quality-head) → fail →
        // re-append → re-emit loop is unbounded. Gate the emit so the QD target's
        // OWN delivery failure is recorded (post-errors.jsonl) but is NEVER bubbled
        // back into another directive. (The host-delivery site gates on `appended`
        // instead; both bound the echo.)
        if (appended && entry.postId !== 'quality-head') {
          await maybeEmitQualityInspectDirective({
            kind: 'post-error',
            postId: entry.postId,
            messageId: record.id,
            error: errText
          })
        }
        // O1-EXT (P2 — the outbox-drain CLOSURE): a delivery to a post that got
        // RETIRED concurrently (its retire dispose-grace expired while THIS
        // delivery was in flight) must not leave its sidecar row 'prepared'/
        // 'failed' keyed to the now-terminal post — settle the row 'terminal'
        // defensively HERE (the retire's post-dispose settle is the same
        // treatment for the rows it can still see; this covers the row whose
        // delivery was mid-flight at the grace expiry, so a retired post's
        // rows are terminal within ONE cycle, never parked until boot). Gated
        // on `entry.retired === true` — a LIVE recipient's failed row is
        // untouched (the boot re-drive keeps its backoff semantics).
        if (entry.retired === true) {
          try {
            await markDelivery(stateDir, record.id, entry.postId, 'terminal')
            ctx.logger.info(`[deepartments] bus delivery to RETIRED "${entry.postId}" (in-flight at the retire): row ${record.id} settled 'terminal' defensively`)
          } catch (markError: unknown) {
            ctx.logger.warn(`[deepartments] defensive terminal settlement of ${record.id} → retired "${entry.postId}" failed (non-fatal; the post-dispose settle / boot pass re-settle): ${markError instanceof Error ? markError.message : String(markError)}`)
          }
        }
      } catch (appendError: unknown) {
        ctx.logger.warn(`[deepartments] post-error capture for "${entry.postId}" failed: ${appendError instanceof Error ? appendError.message : String(appendError)}`)
      }
      // FB-198 (T1): the WAKE failure ground reaches the sender's `failedGround`
      // observer (the durable record stays re-driveable by the sweep/backoff —
      // never reported to the caller as a bare, indistinguishable 'failed').
      opts?.failedGround?.(wakeFailureGround(error))
      return 'failed'
    }
  }

  /** The shared HOST delivery (D4 — always wake, including a non-live host):
   * a live host is followed up inline; a non-live host session is resumed
   * exactly like a dormant head (the owner accepted the materialized host
   * turn). The host's own composition (the 'deepartments' preset) is re-mounted
   * best-effort when the agentPresets service is present; a bare resume is the
   * graceful fallback. Never throws — 'failed' is logged AND returned. W9-b:
   * when `opts.interrupt` is true and the host is LIVE mid-turn, the CURRENT
   * turn is aborted (reason 'interrupted', keepInbox preserved) so the message
   * is the FIRST item of the host's next turn. Default (false) = QUEUE. */
  const busDeliverToHost = async (hostEntry: HostEntry, framed: string, record: MessageRecord, senderSessionId: string | undefined, opts?: DeliveryInterruptOptions): Promise<DeliveryStatus> => {
    if (agents === void 0) {
      // FB-198 (T1): the wake infra is absent — the address is valid, the wake
      // cannot happen (wake-class ground; the durable record stays re-driveable).
      opts?.failedGround?.('materialization-failed')
      return 'failed'
    }
    // W7 terminal philosophy (Bug A, PRIMARY): a RETIRED host is terminal — it is
    // NEVER attempted and NEVER recorded (no resume, no materialization, no
    // post-error row). The only registered live host is the rotation successor.
    // Without this gate a stale in-memory Map (the rotation-commit window / a
    // second daemon twin) could still resolve the retired host as live and the
    // delivery catch would record its rows, re-alerting the CURRENT host about a
    // terminal entry forever.
    // Issue-1 HOST-FAMILY EXCEPTION (owner m-331, Option 1): W7 applies as the
    // TERMINAL rule for a NON-host-family address. A HOST-FAMILY recipient id
    // ('host-…') that resolves to a RETIRED / UNRESOLVABLE host entry is instead
    // re-resolved durable-first to the CURRENT LIVE host at the CATALOG seam
    // (busDeliverCatalog, pickLiveHostEntry from a fresh hosts.json read) and
    // delivered there — host-session-<uuid> means "the Asistente" (role), so the
    // re-route honors the sender's intent. This branch therefore only sees a
    // host entry that was ALREADY re-resolved to live, or a directly-addressed
    // NON-host-family retired/unresolvable id.
    if (hostEntry.retired === true) {
      ctx.logger.warn(`[deepartments] bus delivery to RETIRED host "${hostEntry.hostId}" skipped (terminal — a retired host is never attempted or recorded)`)
      opts?.failedGround?.('retired')
      return 'failed'
    }
    const sessionId = String(SessionId(hostEntry.sessionId))
    const interrupt = opts?.interrupt === true
    /** One host delivery attempt: an inline followup for a LIVE host, else the
     * D4 resume (with the best-effort 'deepartments' preset mount). Returns the
     * status plus the thrown error, so the W8-i retry below can classify a
     * transient 'session "<id>" not found' WITHOUT losing the message. */
    const attemptHostDelivery = async (): Promise<{ status: DeliveryStatus; error?: unknown }> => {
      try {
        const live = agents.get(sessionId)
        if (live !== void 0) {
          // VALLE 09-07 (BATCH-DRAIN) — the ACCUMULATION seam (HOST side): a
          // batch-eligible ALWAYS-WAKE to a currently-RUNNING host is queued
          // for the drain-on-settle flush (returning 'prepared' keeps the
          // write-ahead — the engine's markFinal writes the same 'prepared'
          // row the fifo-gate/noWake classes use; the flush marks 'delivered'
          // at the settle with ALL pending in ONE followup). The host has NO
          // stuck-head recovery, so the accumulation condition is the plain
          // running check. Idle/dormant hosts are NOT affected (the followup
          // below wakes as today — D4 resume).
          if (opts?.batchEligible === true && live.status === 'running') {
            queueBatchFor(sessionId, { record, framed, senderSessionId })
            ctx.logger.info(`[deepartments] bus delivery to host "${hostEntry.hostId}": running + batch-eligible → record ${record.id} queued for the drain-on-settle batch`)
            return { status: 'prepared' }
          }
          // W9-b interrupt: a LIVE, currently-running host with `interrupt:
          // true` is preempted — abort its CURRENT turn (reason 'interrupted')
          // and preserve any already-pending inbox work (keepInbox).
          // M3 (spec §2.4): the abort is gated by the shared per-recipient
          // interrupt back-off (safeInterrupt) — at most ONE interrupt per
          // recipient per INTERRUPT_COOLDOWN_MS, regardless of identity/class
          // count. A turn just interrupted by the daemon is within the cooldown
          // → it is NEVER interrupted again (the re-entrancy guard); a delivery
          // inside the cooldown races through to QUEUE semantics (no abort).
          if (interrupt && live.status === 'running') {
            const aborted = await safeInterrupt(live, hostEntry.hostId, Date.now(), stateDir, opts?.sourceKey)
            if (aborted) {
              ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}": interrupt=true — aborted the current turn (reason 'interrupted'); delivery is the first item of the next turn${opts?.sourceKey !== undefined ? ` (source: ${opts.sourceKey})` : ''}`)
            } else {
              ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}": interrupt=true but within the per-recipient cooldown — delivery queued (no abort)`)
            }
          }
          // VALLE 09-07 (BATCH-DRAIN) — the FLUSH seam (HOST side, same as the
          // post path): a W9-b interrupt wake with a PENDING batch splices
          // [interruptor, ...pendientes] in ONE delta; no batch → the plain
          // followup (unchanged).
          if (batchDrain.has(sessionId)) {
            await flushBatchFor(sessionId, { withFirst: { record, framed, senderSessionId } })
          } else {
            live.followup(busUserMessage(record, framed, senderSessionId))
          }
          return { status: 'delivered' }
        }
        // D4 — a dormant host is ALWAYS woken: resume the durable host session.
        // The GUI owns the host composition ('deepartments'), so re-mount it
        // best-effort (mirroring the api-proxy's composeAgent-on-resume); the
        // session's own global-layer tools remain reachable regardless.
        const setup = agentPresets === void 0
          ? undefined
          : (agentCtx: Context): void => {
              void agentPresets.mount(agentCtx, 'deepartments').catch((error: unknown) => {
                ctx.logger.warn(`[deepartments] host resume preset mount failed (bare resume continues): ${error instanceof Error ? error.message : String(error)}`)
              })
            }
        // VARIANT-2 (2026-08-24): WITHOUT a host agentOptions the D4 resume
        // constructs a FRESH ReactLoopAgent with `agent.options = {}` → the
        // request waterfall throws `agent "session-<uuid>" has no provider/model`
        // at the first post-boot host materialization (the host AgentOptions were
        // intermittently empty — see HOST_AGENT_OPTIONS). The D4 setup does NOT
        // installSelection, so a non-empty `this.options` is the ONLY carrier.
        // Mirror WORKER_AGENT_OPTIONS (heads/workers) so the host is symmetric.
        //
        // MPC-PREFLIGHT (puerta 4, §4.2): el MISMO guard de materialización que
        // la rama head/worker — el host es un punto de materialización más, y su
        // handle stale (fb-332) se re-resuelve al pin actual en vez de exigir un
        // retire manual. El sujeto es el pin RESUELTO POR SESIÓN (§P5), nunca la
        // fecha del sessionId.
        const hostHandlePin = await readResolvedSessionRoutePin(ctx, sessionId)
        const hostPinProbe = await resolvedModelHandleVerdict(hostEntry.hostId, HOST_AGENT_OPTIONS, HOST_AGENT_OPTIONS, hostHandlePin, ctx.get('llm', false), ctx.logger)
        if (hostPinProbe.kind === 'unknown-model') {
          ctx.logger.warn(`[deepartments] materialization pin guard "${hostEntry.hostId}" (host D4 resume): provider "${hostPinProbe.provider}" is registered but NEITHER the pinned model "${hostPinProbe.model}" NOR the seed model "${hostPinProbe.fallbackModel}" is in the live catalog — the host is STILL resumed (never deny the repairing actor) but its next turn will fail with 'pi-ai <provider> has no configured model'; ADD the id to the live catalog (additive-first)`)
        }
        const hostResumeOptions: AgentOptionsLike = hostPinProbe.kind === 'unknown-model' ? HOST_AGENT_OPTIONS : hostPinProbe.options
        const resumed = await agents.resume({ resumeSessionId: sessionId, setup, agentOptions: hostResumeOptions })
        // LANE ② (addendum QD D-Q3 — the m-437/438 ZOMBIE class): the D4 path
        // previously DROPPED the resumed handle, so a HOST session's handle was
        // NEVER in byHeadHandle — the rotation's disposeHeadHandleOnce could
        // not tear the RETIRING host down and it kept consuming its queued
        // inbox turns in parallel with the successor (the double-writer race
        // LATENT). Track the host handle in the SHARED byHeadHandle (keyed by
        // session id, the head/worker key policy) so the rotation/retire
        // disposal reaches it like any other member handle.
        if (resumed !== void 0) byHeadHandle.set(sessionId, resumed)
        const target = agents.get(sessionId)
        if (target === void 0) throw new Error(`[deepartments] host "${hostEntry.hostId}" could not be materialized for bus delivery`)
        target.followup(busUserMessage(record, framed, senderSessionId))
        return { status: 'resumed' }
      } catch (error: unknown) {
        return { status: 'failed', error }
      }
    }
    const first = await attemptHostDelivery()
    if (first.status !== 'failed') {
      // M3 cascade guard: a SUCCESSFUL materialization clears the host's
      // consecutive-failure counter (a recovered host must not be treated as a
      // threshold already met → an immediate re-quarantine).
      await resetHostMaterializeFailures(stateDir, hostEntry.hostId)
      // FB-132 (wake-on-delivered 2026-09-06): a SUCCESSFUL host wake (live
      // followup OR the D4 resume — both land here) IS the host's REAL wake —
      // its 'prepared' queue (the m-1933 noWake / FIFO-gated family) drains
      // FIFO head-first NOW. The fire lives in the ENGINE's `onDelivered` hook
      // (strictly AFTER the final sidecar mark — a fire here would see the
      // current pair's write-ahead 'prepared' still pending and re-drive it, the
      // c1 duplicate). NOT awaited, non-fatal, capped.
      return first.status
    }
    // W8-i: a SINGLE transient 'session "<id>" not found' first-attempt failure
    // (a host session registered in hosts.json whose durable session is not yet
    // workspace-attached — the harness session-persistence/query seam) must NOT
    // be recorded as a post-error: re-deliver THROUGH the existing host-attach
    // repair seam (await it) BEFORE recording, and record ONLY if the retry
    // ALSO fails — so a later-retried SUCCESSFUL delivery leaves NO trace. A
    // non-'not found' failure records today's row unchanged.
    let recordedError: unknown = first.error
    if (isSessionNotFoundError(first.error)) {
      try {
        await repairHostWorkspaceAttach()
      } catch (repairError: unknown) {
        ctx.logger.warn(`[deepartments] host attach repair (bus-deliver retry) failed for host "${hostEntry.hostId}": ${repairError instanceof Error ? repairError.message : String(repairError)}`)
      }
      const second = await attemptHostDelivery()
      if (second.status !== 'failed') {
        await resetHostMaterializeFailures(stateDir, hostEntry.hostId)
        // FB-132 (wake-on-delivered): the SUCCESSFUL repair re-delivery is also
        // a REAL host wake — its queue drains via the engine's `onDelivered`
        // hook (after the final mark — never the current pair).
        return second.status
      }
      recordedError = second.error ?? first.error
    }
    ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}" failed: ${recordedError instanceof Error ? recordedError.message : String(recordedError)}`)
    // W6 system-health: record the host materialization/wake failure (the SAME
    // durable anomaly source as the post delivery; postId = the host id). M3
    // (spec §3.3): for EVERY host class the recording is now a PER-(host+class)
    // dedupe in the shared health-alerts-state.json ledger (reusing
    // appendPostErrorDeduped, the W8-i recording ledger) — a PERSISTENT failure
    // of a NON-retired-but-broken host is NEVER re-recorded/re-alerted inside
    // HEALTH_DEDUPE_WINDOW_MS (one per host+class per 30min, NOT per attempt).
    // This is the R1 generic-class write dedupe: a generic (non-session-not-found)
    // failure previously used the PLAIN append → a row EVERY attempt; now ≤1 per
    // (host,class) per window, and the QD directive emit below is gated on an
    // actually-NEW append (not "every attempt").
    try {
      // Bug A SOURCE GATE (the write, not the scan): a RETIRED host's session is
      // terminal (W7). Re-validate against the DURABLE hosts.json ON DISK — the
      // authoritative rotation record — NOT the possibly-stale in-memory `hosts`
      // Map / hostEntry. A long-lived process (a second daemon twin that booted
      // BEFORE a rotation, sharing the stateDir) keeps a STALE in-memory registry
      // that never marks the retired host retired; that stale registry would let
      // this catch append a new post-error ROW forever. Re-reading the on-disk
      // file here closes the stale-twin bypass: the scan gate only suppresses the
      // FINDING; this suppresses the ROW at the source, per the Asistente's
      // "ZERO new rows" acceptance.
      const durableRetiredOnDisk = isHostRetiredOnDisk(stateDir, hostEntry.hostId)
      // Belt-and-suspenders: the in-memory Map check is a FALLBACK for the window
      // where hosts.json is unreadable/malformed (durableRetiredOnDisk === undefined),
      // and never over-suppresses a DURABLY-LIVE host (durableRetiredOnDisk === false
      // is authoritative → the write proceeds).
      const inMemoryRetired = (hosts.get(hostEntry.hostId)?.retired ?? hostEntry.retired) === true
      const durableRetired = durableRetiredOnDisk === true || (durableRetiredOnDisk === undefined && inMemoryRetired)
      if (durableRetired) {
        ctx.logger.warn(`[deepartments] bus delivery to RETIRED host "${hostEntry.hostId}" — post-error ROW write skipped (terminal; durable source gate)`)
        // FB-198 (T1): the durable source gate re-classified the recipient as
        // terminal (retired) — the terminal ground reaches the sender.
        opts?.failedGround?.('retired')
        return 'failed'
      }
      // M3 materialization-cascade guard (spec §3.3, R5 — the SAFEST subset of
      // R2/R3): a NON-retired-but-BROKEN host keeps failing materialization →
      // the daemon treats EACH attempt as a fresh anomaly. The per-host
      // consecutive-failure cooldown below NEVER skips the delivery attempt (the
      // durable-retry repair is kept) — it gates only the REPEATED post-error
      // RECORDING (and thus the QD directive) once a host has hit N consecutive
      // failures. The FULL delivery-side quarantine (skipping the attempt to
      // stop the tight-retry loop itself) is DEFERRED (too invasive for a clean
      // additive change; see the M3 report).
      const entry: PostErrorEntry = {
        ts: Date.now(),
        postId: hostEntry.hostId,
        messageId: record.id,
        error: recordedError instanceof Error ? recordedError.message : String(recordedError)
      }
      const matState = readMaterializeState(stateDir)
      const { next: nextMat, quarantined } = markHostMaterializeFailure(matState, hostEntry.hostId, entry.ts)
      await writeMaterializeState(stateDir, nextMat)
      if (quarantined) {
        ctx.logger.warn(`[deepartments] bus delivery to host "${hostEntry.hostId}": ${MATERIALIZE_QUARANTINE_N} consecutive materialization failures — quarantined until ${new Date(entry.ts + MATERIALIZE_QUARANTINE_MS).toISOString()} (post-error recording + QD directive suppressed; the delivery attempt + durable repair are unchanged)`)
        // FB-198 (T1): a quarantined host is broken-but-addressed — the wake
        // class ground (the durable record stays re-driveable).
        opts?.failedGround?.('materialization-failed')
        return 'failed'
      }
      const cls = postErrorClass(entry.error)
      const recordKey = `${POST_ERROR_RECORD_KEY_PREFIX}${hostEntry.hostId}:${cls ?? 'generic'}`
      const appended = await appendPostErrorDeduped(stateDir, entry, recordKey, entry.ts)
      // QD (spec 007 §6.4, D-Q4a): after a NEW post-error record is actually
      // appended, trigger the ADDRESSED QUALITY INSPECT directive to quality-head
      // (a dedupe-skip means no new record — do not re-signal). M3: `appended`
      // is now a REAL recording-dedupe result for EVERY class (generic included),
      // so a REPEAT failure inside the window emits NO directive (the old generic
      // branch always returned true → a directive per retry). Non-fatal.
      if (appended) {
        await maybeEmitQualityInspectDirective({ kind: 'post-error', postId: entry.postId, messageId: entry.messageId ?? '', error: entry.error })
      }
    } catch (appendError: unknown) {
      ctx.logger.warn(`[deepartments] post-error capture for host "${hostEntry.hostId}" failed: ${appendError instanceof Error ? appendError.message : String(appendError)}`)
    }
    // FB-198 (T1): the WAKE failure ground (session-not-found after the W8-i
    // resilient retry / pool / materialization) reaches the sender's observer —
    // the durable record stays re-driveable by the sweep/backoff.
    opts?.failedGround?.(wakeFailureGround(recordedError))
    return 'failed'
  }

  // --- QD (spec 007 Quality Department) RUNTIME hooks — the directive emitter --
  // The QUALITY INSPECT directive: an ADDRESSED bus message to the configured
  // `quality-head`. The hook fires INSIDE plugin-internal functions (retirePost /
  // the head dept_sleep branch / runHostRotation / the bus-delivery catches),
  // NOT a hosted agent's send_message — so the catalog-route ACL would deny it.
  // It therefore delivers via the SAME daemon-not-a-catalog-member notify
  // pattern as the agenda scheduler `notifyHead`
  // (messagesStoreReady.append → busDeliverToPost, invoke.ts:~9781). NEVERTHROW
  // and NEVER-spawn: the whole emit is wrapped in its own try/catch → a failed
  // delivery degrades to ctx.logger.warn and the retire/sleep/rotation it hooks
  // still commits. The directive is the ONLY output — quality-head orchestrates
  // its own workers; the hook NEVER spawns a QD worker.
  /** Resolve the configured `quality-head` post (a registered head — the QD
   * coordinator materialized by `ensureAllHeads` at boot). */
  const resolveQualityHeadEntry = (): PostEntry | undefined => byPost.get('quality-head')

  /**
   * dshd-feedback R7 — the ACL-LEGAL NOTIFICATION FORWARDER: `record.from` for
   * the quality-head notification must be a sender the delivery-engine defensive
   * ACL allows (head→head / host→head allowed; worker→head DENIED). The real
   * `emisor` always travels in the feedback record + the notification body.
   *   - a HEAD (or the host) self-forwards: from = the emisor itself;
   *   - a WORKER forwards as its managerId (the creating head), else as the
   *     coordinator postId of its config department;
   *   - neither resolves → undefined → the caller falls back to the direct QD
   *     seam (`busDeliverToPost` with record.from='deepartments' — the
   *     QD-directive precedent, invoke.ts maybeEmitQualityInspectDirective).
   */
  const feedbackForwarderFor = (emisor: string): string | undefined => {
    const entry = byPost.get(emisor)
    if (entry === undefined) return hosts.has(emisor) ? emisor : undefined
    if (entry.provider !== 'worker') return emisor // a head: self (head→head is legal)
    const manager = entry.managerId
    if (manager !== undefined && byPost.has(manager)) return manager
    const coordinatorPostId = departmentForEntry(entry)?.coordinator?.postId
    if (coordinatorPostId !== undefined && byPost.has(coordinatorPostId)) return coordinatorPostId
    return undefined
  }

  /** dshd-feedback severity-gated delivery options (R7): critico → wake+interrupt;
   * alto → wake (no interrupt); medio/bajo/mejora → no-wake queue. */
  const feedbackDeliveryOptions = (tipo: FeedbackTipo, severidad: FeedbackSeveridad): { noWake: boolean; interrupt?: boolean } => {
    if (tipo === 'mejora') return { noWake: true }
    if (severidad === 'critico') return { noWake: false, interrupt: true }
    if (severidad === 'alto') return { noWake: false }
    return { noWake: true } // medio / bajo
  }

  const maybeEmitQualityInspectDirective = async (surface: QualityInspectDirectiveSurface): Promise<void> => {
    // MICRO-LANE O2 (deliveries-emitter-row, 2026-09-06): the delivery-sidecar
    // row the directive path writes needs the record id in BOTH the success
    // ('terminal') and the failure ('failed') branch → hoisted out of the try.
    let record: MessageRecord | undefined
    try {
      // QD anti-loop (owner m-178/m-182): the QH's OWN sleep is NOT part of the
      // 100% head-inspect mandate — a 'head-slept' surface whose headPostId is
      // 'quality-head' is gated by the SAME worker dice (D-Q2, default 0.25), so
      // the "QH sleeps each round → q-i → QH wakes → QH sleeps again" feedback
      // cannot recur. ANY OTHER head (and the host rotation, which is not the
      // QH) stays at 100% structural-true. The ENV override affects only the
      // probability path (the QH dice + worker dice), never a non-QH head
      // mandate. The directive gate lives HERE (the surface already carries
      // headPostId); a missed dice simply drops the directive — the dept_sleep
      // still commits.
      // B1 batch bypass: the org-wide `dept_sleep_all` orchestration calls
      // `lifecycle.sleepAll`, which NEVER invokes this emitter (it marks every
      // configured NON-QH head in ONE write and emits ZERO per-head directives)
      // — a batch that slept N heads must not re-wake the QD inspector once per
      // head (the D-Q7 anti-loop). The SINGLE-agent `dept_sleep` path
      // (`sleepMember`) STILL emits its per-head directive here — untouched.
      if (surface.kind === 'head-slept' && !qualityInspectDecision('head', { headPostId: surface.headPostId, rng: Math.random, workerInspectProbability: qualityWorkerInspectProbability })) {
        return
      }
      const qualityHead = resolveQualityHeadEntry()
      // VALLE 09-08 F1 (O5-flags — observability ONLY, 0 flow change): the
      // emitter's ONLY silent drop — a directive addressed to a 'quality-head'
      // that is NOT in byPost returned with NO warn and NO sidecar row (a
      // qi-silence audit would misread the drop as dice-skip or emit-fail).
      // ONE warn line with context (recipient/postId/kind), then the SAME
      // early-return — semantics unchanged.
      if (qualityHead === undefined) {
        const droppedPostId = surface.kind === 'worker-retired' ? surface.workerPostId
          : surface.kind === 'head-slept' || surface.kind === 'head-rotated' ? surface.headPostId
          : surface.kind === 'post-error' ? surface.postId
          : ''
        ctx.logger.warn(`[deepartments] quality-inspect directive DROPPED: recipient "quality-head" not in byPost (kind=${surface.kind}${droppedPostId === '' ? '' : ` postId=${droppedPostId}`}) — no directive emitted`)
        return
      }
      const store = await messagesStoreReady
// fb-118 (verify id+ts BEFORE citing — the drift class of fb-45): the
      // head-rotated mirror embeds the caller's reason VERBATIM, and a rotation
      // reason typically cites message ids ("memo escrita y confirmada (m-901)")
      // that can resolve to the WRONG message (m-903 cited m-901 — the alert —
      // as the memo confirmation; the real one was m-902). Before the reason
      // enters the directive, every cited m-<id> is verified against the store
      // (existence + author-kind + confirmation-window recency + cited-time ts)
      // and a FAILING citation is marked inline ([not in store] / [system
      // record] / [not latest] / [ts mismatch]) — never silently attributed to
      // an id that is something else. NON-BLOCKING and cosmetic: a lookup
      // failure or an empty verdict set leaves the reason byte-identical, and
      // the whole emit stays inside this try/catch (critical-unblock — a
      // verification must never stop the rotation mirror).
      let surfaceToFrame = surface
      if (surface.kind === 'head-rotated' && surface.reason !== undefined) {
        try {
          const newest = newestStoreRecordAt(store)
          const verdicts = verifyDirectiveReasonCites(
            surface.reason,
            (id) => {
              const record = store.get(id)
              return record === undefined ? undefined : { id: record.id, seq: record.seq, ts: record.ts, from: record.from }
            },
            { newestSeq: newest?.seq, now: Date.now() }
          )
          if (verdicts.size > 0) {
            surfaceToFrame = { ...surface, reason: sanitizeDirectiveReasonCites(surface.reason, verdicts) }
          }
        } catch {
          // a verification failure never blocks the directive — reason verbatim
        }
      }
      const text = qualityInspectDirectiveText(surfaceToFrame)
      // fb-118 re-derivation (wave-b, main @ a641964): the O2 MICRO-LANE
      // (ea48a67) hoisted the directive append into the OUTER `record` declared
      // above (line 1802) — the verify-cite block assigns to it instead of
      // declaring a shadowing const.
      record = await store.append({ from: 'deepartments', to: ['quality-head'], text, kind: 'agent' })
      await busDeliverToPost(qualityHead, `[From deepartments → quality-head]: ${text}`, record, void 0)
      // MICRO-LANE O2 (deliveries-emitter-row, 2026-09-06): the emitter
      // previously wrote NO delivery sidecar (0 deliveries.jsonl rows for the
      // made directives m-2282/2283/2355/2395 — the O2 observability gap), so a
      // qi-silence alert could not distinguish "the dice skipped" from "the
      // emitter failed". Write the directive's write-ahead row as 'terminal'
      // RIGHT AFTER the delivery (markDelivery — dshd-core messages.ts:688).
      // NEVER 'prepared': a prepared row would let the BOOT re-delivery driver
      // re-run the 'deepartments'-from route the ACL denies → a 'failed' row
      // the W6 scan re-alerts on every boot (the same no-sidecar rationale as
      // the enqueueHostWake closure further below — 'terminal' is the whitelist
      // the delivery scan never flags). Non-fatal by design: a sidecar failure
      // falls into the catch below → warn (the directive record itself stays
      // durable in messages.jsonl).
      await markDelivery(stateDir, record.id, 'quality-head', 'terminal')
    } catch (error: unknown) {
      // MICRO-LANE O2 (deliveries-emitter-row, 2026-09-06): best-effort
      // 'failed' row for the directive's record — an audit then reads
      // "delivery failed" (the record exists but never reached the QH), never
      // "emitter silent". Guarded so it NEVER throws (the warn below stays the
      // only journal trace); a record that never appended gets no row (the
      // emitter-failure class the durable dice ledger exposes instead).
      if (record !== undefined) {
        await markDelivery(stateDir, record.id, 'quality-head', 'failed').catch(() => undefined)
      }
      ctx.logger.warn(`[deepartments] quality-inspect directive to "quality-head" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- fb-11: the ROTATION-SUCCESSOR AUTO-WAKE (the host-rotation no-wake
  // defect, QH fb-11) ----------------------------------------------
  // After `runHostRotation` commits (S3/S7 — the NEW hosts.json live entry
  // exists), the new host session is COLD: registered + workspace-attached +
  // artifact-persisted, but NOTHING materializes it — it waits for the first
  // EXTERNAL wake, so an org at rest parks the host (and the governance)
  // indefinitely (evidence: 5c5fc173→024447d9, 2m47s of gap; structural in
  // the 3 prior rotations). This closure is the bundle-side TRANSPORT of the
  // lifecycle's `enqueueHostWake` seam (the lifecycle owns the SEMANTIC MOMENT
  // — the commit; this owns the HOW): it appends a DURABLE 'rotation-wake'
  // bus record from 'deepartments' to the NEW host id and delivers it via the
  // D4 host delivery — the SAME dormant-host resume seam external traffic
  // uses (`busDeliverToHost` → `agents.resume` + followup), so the new session
  // starts its first turn with the wake pack / the new sessionId identity and
  // NO external traffic; journal/handoff untouched (the rotation already
  // re-keyed).
  // Write-ahead + exactly-once (mission test 4): the record is flushed to
  // messages.jsonl BEFORE the delivery (durable-first, the store's own
  // persist-before-deliver contract), the delivery is attempted exactly ONCE
  // and NO delivery-sidecar row is written — deliberately mirroring the QD-
  // directive daemon-notify pattern (maybeEmitQualityInspectDirective above:
  // store.append + DIRECT busDeliverToPost). The delivery-engine route is NOT
  // usable here: `deliverOrQueue`'s defensive ACL gate would DENY a
  // 'deepartments'-from record (an unclassified sender — acl.ts
  // 'unclassified-sender', delivery.ts catalogRoute), and a sidecar
  // 'prepared' row would make the BOOT re-delivery pass re-drive it through
  // that same denied route → a 'failed' row the W6 health scan re-alerts on
  // every boot. With NO sidecar row there is no boot re-drive and no W6
  // anomaly: one record, one delivery, no double tuple. A delivery failure
  // only warns (the rotation already committed; a later external wake or boot
  // resumes the host — crash windows spec 002 §3.6). NEVER throws.
  const enqueueHostWake = async (wake: { newHostId: string; newSessionId: string; sleepEpoch: number }): Promise<void> => {
    if (agents === void 0) return
    try {
      const text = `[deepartments] host session rotation complete (spec 002): session ${wake.newSessionId} is now the registered host (sleepEpoch ${wake.sleepEpoch}); the rotation persisted your re-keyed journal and archived the previous session whole; this is the rotation's OWN successor handoff — no external traffic. Start your turn and run your wake routine.`
      // Durable FIRST (write-ahead): the record is on disk before any delivery
      // (MessagesStore.append flushes awaited — persist-before-deliver).
      const store = await messagesStoreReady
      const record = await store.append({ from: 'deepartments', to: [wake.newHostId], text, kind: 'notice' })
      const hostEntry = hosts.get(wake.newHostId)
      if (hostEntry === void 0) {
        ctx.logger.warn(`[deepartments] rotation wake: new host entry "${wake.newHostId}" not found in the in-memory registry (record ${record.id} stays durable)`)
        return
      }
      const framed = `[From deepartments → ${wake.newHostId}]: ${text}`
      await busDeliverToHost(hostEntry as HostEntry, framed, record, void 0)
      // FB-132 (wake-on-delivered 2026-09-06): the rotation wake delivered to
      // the SUCCESSOR host is a REAL wake of the new host — its 'prepared'
      // queue (any no-wake/FIFO-gated delivery parked while the rotation was in
      // flight) drains FIFO head-first. DEFENSIVE (the busDeliverToHost success
      // seam above already fires for the delivered handoff via the engine's
      // `onDelivered`; this covers the rotation-only path where the successor
      // had NO direct delivery through the engine — e.g. a handoff landed
      // before the engine wired the hook) + fire-and-forget + non-fatal (the
      // drain no-ops on an empty queue).
      fireQueueDrain(wake.newHostId)
      ctx.logger.info?.(`[deepartments] rotation wake: delivered to the new host ${wake.newHostId} (record ${record.id}; session ${wake.newSessionId} started its first turn)`)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] rotation wake failed (non-fatal — the rotation already committed; a later external wake or boot resumes the host): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- FASE 2 STEP f (lifecycle carve) ---------------------------------------
  // The dept_sleep / dept_memo_write SEMANTICS are owned by the core lifecycle
  // service (./core/lifecycle.js): the sleepEpoch marking policy + idempotent
  // re-issue no-op + journal requirement, the host-rotation decision (delegating
  // to ./core/session-rotation.js), and the journal/archive policy. The TOOLS
  // below still register here (their MODEL-FACING contract is unchanged) but now
  // DELEGATE to `lifecycle`. ONE service per apply, deps injected from these
  // closures (AGENTS.md rule 4 — no module-global mutable state). The service is
  // constructed AFTER every closure it consumes is defined (this point); the
  // tool `execute` handlers reference `lifecycle` lazily, so even the earlier
  // head own-layer registrations (installHeadBoardTools) bind it correctly at
  // tool-call time.
  // FASE 2.5 BATCH B: consume the lifecycle SERVICE from dshd-core when composed;
  // fall back to a behavior-neutral in-bundle construction + warn in a minimal
  // composition (dshd-core absent).
  const lifecycle = (ctx.get('deepartments.lifecycle') as LifecycleService | undefined) ?? (() => {
    ctx.logger.warn('[deepartments] dshd-core is not composed — the lifecycle service is constructed in-bundle (behavior-neutral fallback).')
    return createLifecycleService({
      byPost,
      hosts,
      hostForSession,
      postIdForChild,
      hostIdForSession,
      ensureHost,
      persistPosts,
      persistHosts,
      journalPath: (memberId) => journalPathFor(memberId),
      writeJournal,
      readJournal,
      finalizeSessionLog,
      bumpHostSleepCounter,
      bumpPostSleepCounter,
      archivePostSessionOnSleep,
      disposeHeadHandleOnce,
      maybeEmitQualityInspectDirective,
      runHostRotation,
      // fb-11 — the ROTATION-SUCCESSOR AUTO-WAKE seam (bundle transport).
      enqueueHostWake,
      deptGet: (key) => ctx.get(key),
      stateDir: stateDir,
      deferredSleepReplace,
      wakePackInjected,
      buildSleepJournalMessage,
      logger: ctx.logger
    })
  })()

  // --- F2 (spec 004 §5.6): messaging ACL by department — catalog route ONLY --
  // THE FRONTIER (documented, per spec §5.6): the ACL gates ONLY the catalog
  // route. The CHILD route (subagents.followup — the Asistente's transient
  // builders/reviewers) is OUTSIDE the ACL: children are never catalog
  // members (the router decides child-first precisely because the two id sets
  // are disjoint), so they can never reach a check below; department workers
  // are ROOT catalog agents (never children), so the ACL always applies to
  // them. 'self' is always allowed (held by the ack-loop guard, never woken).
  // The SAME pure predicate gates (1) the send_message persist filter — the
  // record's to[] is ONLY the ACL-allowed recipients (the denied never touch
  // the record or the delivery sidecar, per spec §5.6 the denied surface only
  // in the tool result) — and (2) the catalog delivery seam (defensively, so
  // a boot re-delivery of a PRE-ACL record can never bypass the gate).
  // NOTE: `BusMemberProfile` / `BusSendResult` are imported from ./core/delivery.js
  // (step c). The ACL SEMANTICS (busProfileFor / aclDenyGround) live in the PURE
  // ./core/acl.js (FASE 2 step d) — the catalog-route-only predicate is NOT
  // INLINE here anymore. invoke.ts binds the apply catalog (the durable
  // posts/hosts registries + the config department resolver) onto the pure
  // `busProfileFor` and consumes the pure `aclDenyGround` directly; the
  // delivery engine (delivery.ts) re-checks the SAME pure predicate defensively.
  // FASE 2.6-C: consume the dshd-core ACL SERVICE when composed — the core ACL
  // is fed the SAME departments mirror (relocated to the dshd-core config in
  // 2.6-A), so it is BEHAVIOR-IDENTICAL (same grounds 'host' /
  // 'other-department' / 'unclassified'; worker→host PROHIBIDO intact). The
  // bundle keeps its own busCatalogLens/busProfileFor ACL as the fallback in a
  // minimal composition (dshd-core absent).
  const aclService = ctx.get('deepartments.acl') as AclSurface | undefined
  const busCatalogLens: BusCatalogLens = { byPost, hosts, departmentForPost }
  const busProfileFor = aclService?.busProfileFor ?? ((memberId: string): BusMemberProfile => aclBusProfileFor(memberId, busCatalogLens))
  const aclDenyGround = aclService?.aclDenyGround ?? aclDenyGroundImpl

  /** The bus catalog-route resolver (spec §4.2 route 2): resolve a recipient
   * against the DURABLE catalog — posts.json (head/worker) then non-retired
   * hosts.json — PLUS the Issue-1 (owner m-331) host-family re-route: a
   * `host-…` address that resolves to a RETIRED / UNRESOLVABLE KNOWN host entry
   * is re-resolved DURABLE-FIRST to the CURRENT LIVE host
   * (pickLiveHostEntry from a FRESH hosts.json read) ONLY when the address is a
   * REAL host id in hosts.json. ALTO-2 (m-891): a `host-*` id ABSENT from
   * hosts.json — a typo / never-registered uuid — resolves UNKNOWN → the
   * delivery engine settles 'failed' per-recipient (the ghost-delivery fix);
   * `host-session-<uuid>` means "the Asistente" (role) ONLY for a genuinely
   * registered (live or retired) host id, so the m-331 re-route still honors
   * the sender's intent for real hosts; W7 (a retired host is terminal) is NOT
   * revoked, it stays for NON-host-family ids.
   * This resolver returns the candidate entry WITHOUT applying the ACL / retired
   * gates — the DELIVERY ENGINE (./core/delivery.js) owns those (the defensive
   * gate, step (c)). `{ kind: 'unknown' }` = no catalog member / not re-routable
   * (the message settles 'failed' as today — no retry loop).
   * TODO(owner): stable host alias. */
  const resolveBusCatalogRoute = (recipientId: string): CatalogRoute => {
    const entry = byPost.get(recipientId)
    if (entry !== void 0) return { kind: 'post', entry }
    const hostEntry = hosts.get(recipientId)
    if (hostEntry !== void 0 && hostEntry.retired !== true) return { kind: 'host', entry: hostEntry }
    if (recipientId.startsWith(HOST_ID_PREFIX)) {
      // ALTO-2 (m-891, QD audit 2026-08-28 F2 — ghost delivery): the Issue-1
      // host-family re-route fires ONLY for a `host-…` address that is a KNOWN
      // host id in the durable hosts.json — a LIVE entry matched above, or a
      // RETIRED real entry (the m-331 role-intent re-route: `host-session-<uuid>`
      // means "the Asistente", so a REAL formerly-valid host id is re-routed to
      // the current live host). A `host-*` id ABSENT from hosts.json — a typo /
      // never-registered uuid (m-891 sent to '…ea3232b' vs the real '…ea32b') —
      // is NOT the Asistente's address: it resolves UNKNOWN, so the delivery
      // engine settles 'failed' per-recipient exactly like an unknown post — NO
      // prepared→delivered ghost, no silent content loss. The m-380 thread (an
      // unknown non-host session id → failed) is the same 'unknown' path,
      // untouched.
      const durableHosts = readDurableHostEntries(stateDir)
      const registry = durableHosts ?? [...hosts.values()]
      const known = registry.some((host) => host.hostId === recipientId)
      if (known) {
        // LANE ② (fb-58 F-3 — the m-424/425/429 class): the re-route follows
        // the SPEC-002 ROTATION CHAIN explicitly (`rotatedTo` — the retired
        // entry names its live successor): a message addressed to a ROTATED
        // host session means "the Asistente" (role) and must land in the
        // SESSION VIVA, not settle dead/queued. The chain walk is bounded (a
        // corrupted hosts.json can never loop); a broken/dangling chain falls
        // back to the global single-live pick; NO live successor at all →
        // falls through to 'unknown' (the delivery engine settles the pair —
        // never a ghost, never a stuck 'prepared').
        const chained = followRotationChainToLive(registry, recipientId)
        const live = chained ?? pickLiveHostEntry(registry).live
        if (live !== void 0) {
          ctx.logger.warn(`[deepartments] bus delivery to RETIRED host "${recipientId}" re-routed ${chained !== void 0 ? `via rotatedTo → "${chained.hostId}"` : `to the live host "${live.hostId}" (pickLiveHostEntry fallback)`} (fb-58 F-3 — the Asistente's session is the live successor)`)
          return { kind: 'reroute', entry: live as HostEntry }
        }
      }
    }
    return { kind: 'unknown' }
  }

  /**
   * Deliver ONE addressed record to ONE recipient and record the sidecar
   * transition (write-ahead 'prepared' → final status; spec §4.4) — a THIN
   * wrapper over the DELIVERY ENGINE's single seam (`delivery.deliverOrQueue`,
   * FASE 2 step (c)). Kept with the legacy signature so the internal callers
   * (dept_job_run / dept_worker_spawn / dept_post_create first-message
   * deliveries + the boot re-delivery driver) route through the SAME gate; NEW
   * code should call `delivery.deliverOrQueue` directly. THIS is the idempotent
   * re-delivery unit: send_message calls it after persisting, and the boot
   * re-delivery driver re-runs it for crash-pending pairs. Route order per
   * recipient (spec §4.2): child route FIRST (the caller's direct continuable
   * children — never validated against the catalog), then the catalog
   * (posts.json ∪ non-retired hosts.json); unknown ids → failed. `opts.noWake`
   * (B2) is threaded through so an internal caller can set it, but the CURRENT
   * default (absent = always-wake) is unchanged — only threading the option.
   */
  const deliverBusRecord = async (
    record: MessageRecord,
    recipientId: string,
    callerAgentId: string,
    senderSessionId: string | undefined,
    signal?: AbortSignal,
    opts?: DeliveryInterruptOptions & { noWake?: boolean }
  ): Promise<DeliveryStatus> =>
    delivery.deliverOrQueue(recipientId, record, {
      callerAgentId,
      senderSessionId,
      signal,
      interrupt: opts?.interrupt,
      noWake: opts?.noWake
    })

  /** The live parent Agent for the native-route followup (the caller is the
   * direct parent, per the route resolution above). Resolved from the agents
   * registry — `exec.agent` is not retained past the tool execute frame. */
  const exec_agentFor = (sessionId: string): AgentLike => {
    const parent = agents?.get(sessionId)
    if (parent === void 0) throw new Error(`[deepartments] bus child route requires the live caller agent "${sessionId}"`)
    return parent
  }

  /** The caller's BUS member id (spec §3.1: durable member id, never a session
   * id): the postId for a registered head/worker, else the deterministic
   * `host-<sessionId>` id for a host/plain session. */
  const busMemberIdFor = (agentId: string): string => postIdForChild(agentId) ?? hostIdForSession(agentId)

  // --- FASE 2 step (c): the DELIVERY ENGINE (./core/delivery.js) -------------
  // The single bus delivery seam. The engine owns the `deliverOrQueue` gate +
  // the per-recipient delivery orchestration (write-ahead 'prepared' → route →
  // final), the catalog route, the defensive ACL application, and the `noWake`
  // gate (INERT today). The CLOSURE-BOUND primitives below are INJECTED as deps:
  // the child route (resolveBusChild / deliverBusChild), the catalog resolver
  // (resolveBusCatalogRoute), the ACL predicate (the pure busProfileFor /
  // aclDenyGround from ./core/acl.js — FASE 2 step (d); invoke.ts binds the
  // catalog lens onto `busProfileFor`), and the always-wake primitives
  // (busDeliverToPost / busDeliverToHost). Constructed ONCE per apply
  // (AGENTS.md rule 4).

  /** Resolve whether `recipientId` is the caller's direct CONTINUABLE child
   * (delivered natively, never catalog-validated). Never throws — a listing
   * failure (minimal composition) means "not a child", the catalog route next. */
  const resolveBusChild = async (recipientId: string, callerAgentId: string, signal?: AbortSignal): Promise<boolean> => {
    if (subagents === void 0) return false
    try {
      const children = await subagents.listChildren(SessionId(callerAgentId), signal ?? undefined)
      return children.some((child) => child.kind === 'child' && child.mode === 'continuable' && String(child.id) === recipientId)
    } catch {
      // listing unavailable (minimal composition): no child route — catalog next
      return false
    }
  }

  /** Deliver ONE bus message to a continuable child (native followup). Returns
   * 'delivered' or 'failed' (never throws). W9-b interrupt is NOT threaded into
   * the child route (a continuable child has no abort seam here — children are
   * always queue-delivered). */
  const deliverBusChild = async (callerAgentId: string, recipientId: string, record: MessageRecord, framed: string, senderSessionId: string | undefined, signal?: AbortSignal): Promise<DeliveryStatus> => {
    if (subagents === void 0) return 'failed'
    try {
      // rc.1 dsh-subagent drift (0.1.2-rc.1): `followup(parent, childId,
      // content, { source, signal })` was REPLACED by `sendMessage(sender,
      // targetId, content, { signal })` — the durable sender attribution is now
      // derived by the kernel from the exact live sender, so the explicit
      // `source` projection only exists on the ≤0.1.1 line. Structural dual:
      // call whichever surface the runtime exposes (the rc.1 typings provide
      // `sendMessage`; a pre-0.1.2 kernel keeps `followup`).
      const childDeliver = subagents as unknown as {
        followup?: (parent: unknown, childId: SessionId, content: readonly { type: string; text: string }[], options: { source?: unknown; signal?: AbortSignal }) => Promise<unknown>
        sendMessage?: (sender: unknown, targetId: SessionId, content: readonly { type: string; text: string }[], options: { signal: AbortSignal }) => Promise<unknown>
      }
      const parent = await exec_agentFor(callerAgentId)
      // W8-b prompt-literal safety: the child-followup text (bus message
      // content injected into a continuable child) is run through the brace
      // sanitizer so an unbound double-brace token can never break the child
      // session assembly.
      const content = [{ type: 'text', text: sanitizePromptLiterals(framed) } as const]
      if (childDeliver.sendMessage !== undefined) {
        // 0.1.2+ line: the rc.1 `SubagentSendMessageOptions` carries ONLY
        // `signal` — the kernel derives the durable source from the exact live
        // sender. The deepartments-supplied `source` projection below is not
        // accepted on this surface (verify the child-source record shape in the
        // rc.1 canary — the deepartments child-session attribution contract).
        await childDeliver.sendMessage(parent, SessionId(recipientId), content, {
          signal: signal ?? new AbortController().signal
        })
      } else if (childDeliver.followup !== undefined) {
        await childDeliver.followup(parent, SessionId(recipientId), content, {
          // W7-B: the SAME JSON-safe projection as `busUserMessage` — the
          // child-followup source is inserted into a durable session too, so a
          // present-undefined `senderSessionId` / branded value must never reach
          // the `agent/inbox/spliced` append boundary.
          source: jsonSafeMessageSource({
            kind: 'agent',
            form: 'send',
            plugin: 'deepartments',
            summary: boundContextSummary(`New message from ${record.from} to ${record.to.length} recipient(s) (${record.kind}).`),
            to: [...record.to],
            messageId: record.id,
            from: record.from,
            senderSessionId: senderSessionId === undefined ? undefined : SessionId(senderSessionId)
          }),
          // A bare { agent, signal } tool exec is the test surface; the
          // ABORT_SIGNAL default is never reached in production harness runs
          // (exec.signal is always present there).
          signal: signal ?? new AbortController().signal
        })
      } else {
        ctx.logger.warn(`[deepartments] bus child delivery to "${recipientId}" failed: the subagent runtime exposes neither sendMessage (0.1.2+) nor followup (≤0.1.1)`)
        return 'failed'
      }
      return 'delivered'
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] bus child-followup to "${recipientId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    }
  }

  /** P1-EXT (2026-09-06 — WAKE-SEAM mitigation, fix opción-a VARIANTE (i)):
   * whether a CATALOG POST recipient is CURRENTLY MATERIALIZED — its durable
   * post entry's live agent handle exists (`agents.get(SessionId(sessionId))` —
   * the SAME liveness probe busDeliverToPost (line ~964) uses). A DORMANT post
   * (no live handle — asleep / never materialized / disposed) returns false →
   * the engine SKIPS the fb-117 FIFO gate for it, so the ALWAYS-WAKE proceeds
   * to `materializePost` (the wake) and the earlier prepared head lands in the
   * same wake, in seq order (m-2415). A RETIRED post → undefined (today's
   * behavior — the route settles it, never a wake). A non-post recipient (host
   * family / unknown) → undefined (default safe — the gate stays). Never
   * throws (a missing `agents` service → undefined). */
  const recipientMaterializedForGate = (recipientId: string): boolean | undefined => {
    if (agents === void 0) return undefined
    const post = byPost.get(recipientId)
    if (post === void 0) return undefined // host family / unknown — gate unchanged
    if (post.retired === true) return undefined // retired — the route settles it
    return agents.get(String(SessionId(post.sessionId))) !== undefined
  }

  /** VALLE 09-07 (BATCH-DRAIN) — whether a CATALOG recipient's live handle is
   * CURRENTLY RUNNING (mid-turn): the `agents.get(...)?.status === 'running'`
   * probe — the SAME liveness the batch surface uses internally (posts by
   * byPost → session, hosts by hosts → session). Resolves `true` → the engine
   * SKIPS the fb-117 FIFO gate for a batch-eligible delivery (the batch
   * presents the record at the settle in seq order — the completion-order
   * inversion the gate protects is impossible for a batched delivery); `false`
   * (idle/dormant/retired) or `undefined` (unknown/child/absent agents) → the
   * gate applies (the safe default — pre-batch behavior). Never throws. */
  const recipientRunningLiveForGate = (recipientId: string): boolean | undefined => {
    if (agents === void 0) return undefined
    const post = byPost.get(recipientId)
    if (post !== void 0) {
      if (post.retired === true) return false // terminal — never running
      return agents.get(String(SessionId(post.sessionId)))?.status === 'running'
    }
    const host = hosts.get(recipientId)
    if (host !== void 0) {
      if (host.retired === true) return false // terminal — never running
      return agents.get(String(SessionId(host.sessionId)))?.status === 'running'
    }
    return undefined // child / unknown — no liveness knowledge (the gate stays)
  }

  /** The delivery engine: the SINGLE bus delivery seam (constructed once per
   * apply, deps injected — AGENTS.md rule 4, no module-global mutable state).
   * Consumed by send_message (directly) and by the `deliverBusRecord` wrapper
   * (dept_job_run / dept_worker_spawn / dept_post_create + the boot re-delivery
   * driver). FASE 2.5 BATCH B: consume the delivery SERVICE from dshd-core when
   * composed; fall back to a behavior-neutral in-bundle construction + warn in a
   * minimal composition (dshd-core absent). */
  const delivery = (ctx.get('deepartments.deliver') as DeliveryEngine | undefined) ?? (() => {
    ctx.logger.warn('[deepartments] dshd-core is not composed — the delivery engine is constructed in-bundle (behavior-neutral fallback).')
    return createDeliveryEngine({
      stateDir: messageStoreDir,
      logger: ctx.logger,
      markPrepared: (record, recipientId, opts) => markDelivery(messageStoreDir, record.id, recipientId, 'prepared', undefined, opts?.noWake),
      markFinal: (record, recipientId, status, opts) => markDelivery(messageStoreDir, record.id, recipientId, status, undefined, opts?.noWake),
      // fb-117 (fold-in batch A): the FIFO-gate predicate — SAME wiring as the
      // dshd-core lazy engine (the store's per-recipient seq index + the
      // sidecar's LATEST row per pair; fail-soft — a read error never breaks a
      // delivery).
      pendingEarlierSeq: async (recipientId, seq) => {
        const store = await messagesStoreReady
        try {
          const text = await readFile(resolveDeliveriesPath(messageStoreDir), 'utf8')
          return hasEarlierPendingPair(parseDeliveryRows(text), (recipient) => store.seqsFor(recipient), recipientId, seq)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false // nothing ever sent
          ctx.logger.warn(`[deepartments] bus delivery FIFO-gate check failed for ${recipientId} (delivery proceeds ungated): ${error instanceof Error ? error.message : String(error)}`)
          return false
        }
      },
      // P1 (fb-131 — WAKE-SEAM lane, Candidate B observability): the gating-seq
      // detail — the SAME wiring as the dshd-core lazy engine (the in-bundle
      // FALLBACK runs when dshd-core is not composed — the composed tests use
      // it, so the send_message 'prepared (fifo-gated tras m-<seq>)' detail must
      // work HERE too). The earliest strictly-earlier seq whose pair is still
      // 'prepared'; fail-soft to undefined (observability only — NEVER a gate).
      pendingEarlierSeqDetail: async (recipientId, seq) => {
        const store = await messagesStoreReady
        try {
          const text = await readFile(resolveDeliveriesPath(messageStoreDir), 'utf8')
          const rows = parseDeliveryRows(text)
          const own = store.seqsFor(recipientId)
          if (own.length === 0) return undefined
          const latest = new Map<string, DeliveryRow>()
          for (const row of rows) latest.set(`${row.messageId}\u0000${row.recipientId}`, row)
          for (const earlier of own) {
            if (earlier >= seq) break // ascending — strictly earlier seqs only
            const row = latest.get(`m-${earlier}\u0000${recipientId}`)
            if (row !== undefined && row.status === 'prepared') return earlier
          }
          return undefined
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined // nothing ever sent
          ctx.logger.warn(`[deepartments] bus delivery FIFO-gate seq detail failed for ${recipientId} (observability only): ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }
      },
      // P1-EXT-EXT (2026-09-06 — WAKE-SEAM mitigation, m-2415 no-wake-head
      // DISCRIMINATOR): whether the FIFO gate's GATING HEAD is a NO-WAKE row —
      // the SAME wiring as the dshd-core lazy engine (the in-bundle FALLBACK
      // runs when dshd-core is not composed — the composed tests use it, so
      // the no-wake-head gate-skip must work HERE too). `true` → the
      // ALWAYS-WAKE behind the noWake head is NOT gated (the head drains with
      // it, m-2415 — «nunca lo bloquea»); `false` → crash-class head (the gate
      // applies, fb-117); `undefined` (read error / nothing pending) → the gate
      // applies (the safe default).
      earlierHeadIsNoWake: async (recipientId, seq) => {
        const store = await messagesStoreReady
        try {
          const text = await readFile(resolveDeliveriesPath(messageStoreDir), 'utf8')
          return gatingHeadIsNoWake(parseDeliveryRows(text), (recipient) => store.seqsFor(recipient), recipientId, seq)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined // nothing ever sent
          ctx.logger.warn(`[deepartments] bus delivery no-wake-head discriminator failed for ${recipientId} (the FIFO gate applies — safe default): ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }
      },
      subagents,
      resolveChild: resolveBusChild,
      deliverChild: deliverBusChild,
      resolveCatalogRoute: resolveBusCatalogRoute,
      busProfileFor,
      deliverPost: busDeliverToPost,
      deliverHost: busDeliverToHost,
      // P1-EXT (2026-09-06 — WAKE-SEAM mitigation, fix opción-a VARIANTE (i)):
      // the dormancy probe in the in-bundle FALLBACK engine (R6 parity — the
      // composed dshd-core engine receives the same closure via the holder).
      recipientMaterialized: recipientMaterializedForGate,
      // VALLE 09-07 (BATCH-DRAIN): the running-liveness probe in the in-bundle
      // FALLBACK engine (R6 parity — the composed dshd-core engine receives
      // the same closure via the holder; ABSENT in a minimal register → the
      // pre-batch gate behavior, the safe default).
      recipientRunningLive: recipientRunningLiveForGate,
      // FB-132 (wake-on-delivered 2026-09-06): the landed-delivery wake hook —
      // the in-bundle FALLBACK engine fires it on a delivered/resumed delivery
      // AFTER the final sidecar mark (the composed dshd-core engine receives it
      // via the `deepartments.deliverDeps` holder — R6 parity); it drains the
      // recipient's 'prepared' queue fire-and-forget (non-fatal, capped).
      onDelivered: (recipientId: string) => fireQueueDrain(recipientId)
    })
  })()

  /** B3 (m-361): whether a CATALOG recipient is DORMANT — its durable entry
   * (posts.json `byPost` OR hosts.json `hosts`) carries a `sleepEpoch` mark
   * (deliberately asleep by a sleep directive; its pending queue drains at its
   * next real wake). A RETIRED entry is NEVER dormant: its `sleepEpoch` is STALE
   * metadata («drains at its next real wake» is a dead end under a retired id —
   * a retired post/host is never woken again), so the B3 re-drive park must not
   * hold a 'prepared' pair forever when the ENTRY'S OWN id is retired (the
   * retired-HOST re-route — F-3 — needs drivePair to reach the deliver seam).
   * A child-route / unknown recipient has NO catalog entry → never dormant (a
   * transient subagent or unknown id is never no-waked by B3). Used by
   * send_message to no-wake ONLY the ack to a just-slept head — the m-361
   * regression where a QD ack re-woke a head that had just dept_slept. */
  const isDormantRecipient = (recipientId: string): boolean => {
    const post = byPost.get(recipientId)
    if (post !== void 0) return post.retired !== true && post.sleepEpoch !== void 0
    const host = hosts.get(recipientId)
    return host !== void 0 && host.retired !== true && host.sleepEpoch !== void 0
  }

  /** B3 gap fix (reviewer B2 note a): with the board gone, the host's
   * auto-registration must not depend on board tools. For every host-family
   * caller (no post entry; NOT a transient subagent) dept_who / send_message
   * run ensureHost(self) — idempotent: a first registration (no host in
   * hosts.json) registers the caller; a refresh of an existing live entry
   * MERGES (rotation metadata preserved); and the single-live-host guard
   * inside ensureHost means a second live host is NEVER minted (a refused
   * session stays a plain session, with the guard warn). Returns the
   * caller's member id. */
  const busEnsureHostForCaller = (callerAgent: { id: string; session?: { header?: SessionHeaderWithOrigin } }): string => {
    const agentId = callerAgent.id
    const postId = postIdForChild(agentId)
    if (postId !== undefined) return postId
    // A transient subagent is never a host session (origin subagent).
    const header = callerAgent.session?.header
    const origin = header?.origin ?? header?.meta?.origin
    if (origin !== 'subagent') {
      ensureHost(agentId, 'board')
    }
    return hostIdForSession(agentId)
  }

  /** Shared framing for every bus deliver (spec §4.3): the GUI never renders
   * `to[]`, so sender + recipients MUST be in the model-facing text. */
  const busFraming = (record: MessageRecord): string =>
    `[From ${record.from} → ${record.to.join(', ')}]: ${record.text}`

  /** The 1..20 fan-out guard (spec §4.4): the JSON schema subset cannot express
   * minItems/maxItems, so the cap is enforced here — a hard error above 20. */
  const assertBusFanOut = (to: readonly string[]): number => {
    if (!Array.isArray(to) || to.length === 0) throw new Error('[deepartments] send_message: `to` must list at least one recipient')
    if (to.length > 20) throw new Error(`[deepartments] send_message: fan-out cap is 20 recipients (got ${to.length})`)
    return to.length
  }
// ---------------------------------------------------------------------------
  // The delivery surface the rest of applyInvoke consumes (the SAME handles the
  // zone previously exposed at these positions in the fiber — the downstream
  // code is unchanged, only the origin moved).
  // ---------------------------------------------------------------------------
  return {
    messageStoreDir,
    messagesStoreReady,
    feedbackStoreReady,
    freshMintHead,
    busDeliverToPost,
    busDeliverToHost,
    resolveQualityHeadEntry,
    feedbackForwarderFor,
    feedbackDeliveryOptions,
    maybeEmitQualityInspectDirective,
    enqueueHostWake,
    lifecycle,
    busProfileFor,
    aclDenyGround,
    resolveBusCatalogRoute,
    deliverBusRecord,
    busMemberIdFor,
    resolveBusChild,
    deliverBusChild,
    delivery,
    isDormantRecipient,
    recipientMaterialized: recipientMaterializedForGate,
    // VALLE 09-07 (BATCH-DRAIN): the surface's batch-drain members (the tools
    // factory forwards the probe into the composed engine's deliverDeps holder;
    // the queue/flush/state are the settle hook's + the tests' seams).
    recipientRunningLive: recipientRunningLiveForGate,
    queueBatchFor,
    flushBatchFor,
    batchState: () => [...batchDrain.keys()],
    busEnsureHostForCaller,
    assertBusFanOut,
    // fb-300/fb-301 (VALLE 09-09): the toolset-reassertion action the boot heal
    // (tools.ts runToolsetReassertion) drives — see the DeliverySurface doc.
    reassertPostToolset
  }
}