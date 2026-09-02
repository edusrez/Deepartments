// dshd-quality — the Deepartments Quality-Department (QD, spec 007) probability
// gate (the dshd-quality phase of the modular Cordis split). A PURE LIBRARY
// package (NO cordis plugin, NO tool, NO patch — the owner-confirmed MODO LIB,
// precedent 0f792cd / packages/dshd-pooler — superseded for the PLUGIN surface
// by P1, 2026-08-29: the bottom of this file adds a thin name/inject/apply +
// the `deepartments.quality` service; the pure gate stays MODO LIB, the
// directive EMITTER effect is now ALSO exposed with binder-injected deps): it
// owns the QD gate machinery extracted VERBATIM from the bundle (src/invoke.ts,
// extraction map 2026-08-27-health-quality-extraction-map.md §2):
//   - QUALITY_WORKER_INSPECT_DEFAULT_PROBABILITY (the D-Q2 worker-retire dice
//     default 0.25) + the QUALITY_INSPECT_ENV_VAR env override (a numeric
//     [0,1] string — overrides ONLY the probability path: the worker dice and
//     the QH's own-sleep dice; never the structural non-QH head/host mandate),
//   - qualityInspectDecision — the PURE gate (kind + injectable deps in,
//     boolean out): 'host' → structural-true (D-Q3), 'head' → structural-true
//     for ANY head EXCEPT the QD's OWN 'quality-head' (owner m-178/m-182
//     anti-loop exclusion — the QH's own sleep is sampled by the SAME worker
//     dice so the "QH sleeps each round → q-i → QH wakes → QH sleeps again"
//     feedback cannot recur), 'worker' → `(rng ?? Math.random)() <
//     clamp(workerInspectProbability ?? 0.25, 0, 1)` (D-Q2 dice),
//   - resolveQualityWorkerInspectProbability — the PURE config-resolution
//     helper (spec 007 §4.1): reads `quality?.workerInspectProbability`,
//     validated to [0,1]; invalid/absent → the code default 0.25,
//   - QualityInspectDirectiveSurface + qualityInspectDirectiveText — the
//     QUALITY INSPECT directive frame (one variant per archive/post-error
//     event; the human-readable text is PURE — testable).
//
// SPLIT BOUNDARY (what MOVED vs what STAYED in the bundle):
//   - MOVED: the public surface below (2 constants + 3 values + 3 types) and
//     the two package-private helpers parseQualityInspectEnvOverride + clamp01
//     (internal — the bundle never needs them; they travel so the gate is
//     self-contained).
//   - STAYED in src/invoke.ts (the EFFECT, not the predicate): the
//     maybeEmitQualityInspectDirective EMITTER closure (the store.append +
//     busDeliverToPost of the directive to quality-head — the QD anti-loop gate
//     for 'head-slept' lives INSIDE the emitter), the per-apply
//     qualityWorkerInspectProbability config resolution
//     (resolveQualityWorkerInspectProbability(config) in the apply fiber), the
//     resolveQualityHeadEntry helper, and the four gate call-sites
//     (worker-retire :6411, busDeliverToPost post-error catch :8241,
//     busDeliverToHost post-error catch :8438, and the 'head-slept' check
//     inside the emitter :8512 — current line numbers in the post-Lote-H
//     file). The emitter is the bundle's SINGLE directive writer — the package
//     has NO effect surface, so C6/twin-safe is N/A (no daemon; the ONE
//     emitter in the bundle guarantees no double directive).
//
// DEPENDENCIES: NONE (leaf package — the gate is pure: Math + process.env
// only; no dshd-core type is required by any symbol below).
//
// NO export default (pitfall 0001 — breaks `inject`).

// --- QD (spec 007 Quality Department) RUNTIME — the probability gate + config --
// The Quality Department inspects the org's OWN runtime: every department HEAD
// archive (dept_sleep) and every HOST session rotation is inspected at 100%
// (D-Q3, the mandate), while a disposable WORKER retire is SAMPLED at 0.25 by
// default (D-Q2). The gate below is PURE (kind + deps in, boolean out, no side
// effects beyond reading the deterministic env/seed seam) so a test drives it
// offline through the real Loader. It is an INTERNAL helper — there is NO
// public `dept_quality_*` tool; the hooks are the bus-directive emitters in
// applyInvoke (maybeEmitQualityInspectDirective, bundle).
/** The code default for the worker-retire dice (D-Q2). */
export const QUALITY_WORKER_INSPECT_DEFAULT_PROBABILITY = 0.25

/** The DIRECTIVE text prefix of the worker-retired variant of the QUALITY
 * INSPECT directive (`qualityInspectDirectiveText`, kind 'worker-retired').
 * EXPORTED as the single literal source of truth: the dshd-health qi-silence
 * watchdog matches messages.jsonl records by this prefix (M1), so a reword of
 * the frame never silently drifts the watchdog (one literal, no drift). The
 * directive text builds on this prefix; every record written by
 * maybeEmitQualityInspectDirective for a retired worker STARTS WITH it. */
export const QUALITY_INSPECT_WORKER_RETIRED_PREFIX = 'Quality inspect: worker retired'

/** The deterministic env override for the worker probability path (a numeric
 * [0,1] string). Overrides ONLY the worker dice; the head/host mandate is never
 * a dice and is never overridden. Invalid/absent → undefined (code default). */
export const QUALITY_INSPECT_ENV_VAR = 'DEEPARTMENTS_QUALITY_INSPECT'

export type QualityInspectKind = 'worker' | 'head' | 'host'

/** The probability-gate inputs (PURE — injectable rng + injectable probability). */
export interface QualityInspectDecisionDeps {
  /** An injected [0,1) random source (default Math.random). */
  rng?: () => number
  /** The worker dice probability (default 0.25), clamped to [0,1]. */
  workerInspectProbability?: number
  /** The caller head's postId (a 'head' kind). The 100% head-inspect mandate
   * (D-Q3) EXCLUDES the QD's OWN head — 'quality-head' (owner m-178/m-182): the
   * QH's OWN sleep is sampled by the SAME worker dice (D-Q2, default 0.25) so
   * the "QH sleeps each round → q-i → QH wakes → QH sleeps again" feedback
   * cannot recur. Any OTHER head (research-head, internal-programming-head, …)
   * stays structural-true (100%). Absent → structural-true (a plain/legacy
   * head call). */
  headPostId?: string
}

/** Parse `DEEPARTMENTS_QUALITY_INSPECT` (a numeric [0,1] string); invalid/absent
 * → undefined. Overrides ONLY the worker path. Package-private (travels with
 * the gate; the bundle never calls it directly). */
function parseQualityInspectEnvOverride(): number | undefined {
  const raw = process.env[QUALITY_INSPECT_ENV_VAR]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return undefined
  return n
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/**
 * The QD probability gate (spec 007 §5.2, D-Q2/D-Q3) — PURE, injectable rng.
 *
 *   kind 'head' → structural-true for ANY head EXCEPT the QD's own
 *                  'quality-head' (owner m-178/m-182 — the anti-loop exclusion):
 *                  the QH's OWN sleep is sampled by the SAME worker dice so the
 *                  "QH sleeps each round → q-i → QH wakes → QH sleeps again"
 *                  feedback cannot recur; every OTHER configured head
 *                  (research-head, internal-programming-head, …) stays 100% (D-Q3)
 *   kind 'host'  → ALWAYS true (the host counts as "H", head-equivalent — D-Q3;
 *                  the host is NOT the QH, so it is never gated)
 *   kind 'worker' → `(rng ?? Math.random)() < clamp(workerInspectProbability ??
 *                                 0.25, 0, 1)`  (D-Q2 dice)
 *
 * The non-QH head/host branch is STRUCTURAL — no knob / env override can make it
 * false. The QH-head dice and the worker dice are the SAME probability path
 * (reusing `workerInspectProbability` — no dedicated knob). The
 * `DEEPARTMENTS_QUALITY_INSPECT` env override (a numeric [0,1] string)
 * overrides ONLY that probability path (the QH dice + the worker dice); it
 * never touches the structural non-QH head/host mandate.
 */
export function qualityInspectDecision(kind: QualityInspectKind, deps: QualityInspectDecisionDeps = {}): boolean {
  if (kind === 'host') return true
  if (kind === 'head') {
    // The 100% head-inspect mandate EXCLUDES the QD's OWN head ('quality-head')
    // — the anti-loop exclusion (owner m-178/m-182): the QH's own sleep is
    // sampled by the SAME worker dice (D-Q2), so the QH-sleep → q-i → QH-wake →
    // QH-sleep-again feedback cannot recur. Any OTHER head (and a plain/legacy
    // head call with no headPostId) stays structural-true (100%). The ENV
    // override affects only the probability path (the QH dice + worker dice),
    // never a non-QH head mandate.
    if (deps.headPostId === 'quality-head') {
      const rng = deps.rng ?? Math.random
      const envOverride = parseQualityInspectEnvOverride()
      const prob = clamp01(envOverride ?? deps.workerInspectProbability ?? QUALITY_WORKER_INSPECT_DEFAULT_PROBABILITY)
      return rng() < prob
    }
    return true
  }
  const rng = deps.rng ?? Math.random
  const envOverride = parseQualityInspectEnvOverride()
  const prob = clamp01(envOverride ?? deps.workerInspectProbability ?? QUALITY_WORKER_INSPECT_DEFAULT_PROBABILITY)
  return rng() < prob
}

/**
 * The QD config-resolution helper (spec 007 §4.1, D-Q2): read the `quality`
 * config block and return the effective worker dice probability.
 * `(config as unknown as { quality?: { workerInspectProbability?: number } })`
 * → `quality?.workerInspectProbability`, validated to [0,1]; invalid/absent →
 * the code default 0.25. Mirrors the `health.staleLiveMinutes` fallback
 * (org.ts:86-90). The head/host 100% mandate is NOT resolved here — it is
 * structural in `qualityInspectDecision`. PURE (config in, number out).
 */
export function resolveQualityWorkerInspectProbability(config: unknown): number {
  const quality = (config as { quality?: { workerInspectProbability?: unknown } } | undefined)?.quality
  const raw = quality?.workerInspectProbability
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw
  return QUALITY_WORKER_INSPECT_DEFAULT_PROBABILITY
}

/** The QUALITY INSPECT directive surface (the archive event details a hook
 * carries to `quality-head`). One variant per archive/post-error event.
 * O2 (MICRO-BATCH O2, QD compromiso — ANALYZE m-598): the worker-retired
 * variant OPTIONALLY carries `deliverable` — the retire-time prediction of
 * whether the retired session PRODUCED a deliverable: 'none' = the session
 * ended in a turn-error with 0 outbound (the ANALYZE pipeline must QUESTION
 * the retire instead of citing content that was never published); 'report' =
 * a normal retire. Absent (legacy/other emitters) → the text renders WITHOUT
 * the label (the existing flow never changes). */
export type QualityInspectDirectiveSurface =
  | { kind: 'worker-retired'; workerPostId: string; sessionId: string; archived: boolean; deliverable?: 'none' | 'report' }
  | { kind: 'head-slept'; headPostId: string; sessionId: string; sleepEpoch: number }
  | { kind: 'host-rotated'; oldSessionId: string; newSessionId: string; oldHostId: string; newHostId: string; sleepEpoch: number; archiveOk?: boolean }
  // M-A (2026-08-28): the HEAD-ROTATION mirror — `dept_head_rotate` (the
  // host-plane context-refresh tool) emits this on the `host-rotated` pattern
  // (spec 007 §6.3, D-Q3): an ACTIVE head session rotation is inspected at
  // 100%. The QH's OWN rotation is NOT excluded (the 'head-slept' anti-loop
  // exclusion is sleep-specific — a rotation is a one-shot instruction, it
  // cannot loop).
  | { kind: 'head-rotated'; headPostId: string; oldSessionId: string; newSessionId: string; archiveOk?: boolean; reason?: string; reasonVerified?: 'verified' | 'unverified' | 'unavailable' }
  | { kind: 'post-error'; postId: string; messageId: string; error: string }

/** The human-readable directive frame for a surface (pure — testable). */
export function qualityInspectDirectiveText(surface: QualityInspectDirectiveSurface): string {
  switch (surface.kind) {
    case 'worker-retired':
      // LOTE B (owner 2026-08-27): the worker-retired directive carries the
      // explicit ANALYZE mission for the inspector (R6 — the previous frame is
      // KEPT, the mission text is ADDED, never removed). The literal STARTS
      // WITH the exported QUALITY_INSPECT_WORKER_RETIRED_PREFIX (the qi-silence
      // watchdog matches on it — M1; never fork the literal here).
      // O2 (MICRO-BATCH O2, QD compromiso — ANALYZE m-598): when the retire
      // KNOWS the retired session produced no deliverable (turn-error, 0
      // outbound) the directive labels it `deliverable: none` and instructs
      // the inspector to QUESTION the retire instead of citing published
      // content — the ANALYZE pipeline must never assume a 0-outbound session
      // published a conclusion. 'report' (or absent) = the normal flow.
      // The label lives AFTER the parenthesized frame and BEFORE the mission,
      // so the prefix match (M1) and the mission-match asserts (LOTE B) are
      // both untouched.
      {
        const deliverableFrame = surface.deliverable === undefined ? ''
          : surface.deliverable === 'none'
            ? `deliverable: none. The worker produced NO deliverable (turn-error, 0 outbound) — do NOT cite published content; analyze the session for the failure cause instead. `
            : 'deliverable: report. '
        return `${QUALITY_INSPECT_WORKER_RETIRED_PREFIX} (post ${surface.workerPostId}, session ${surface.sessionId}, archived ${surface.archived}). ${deliverableFrame}ANALYZE the retired agent: its log/session, the tools it used, its flows, its failures, and optimization opportunities → write the report to .dsh/reports/quality/ and report to quality-head`
      }
    case 'head-slept':
      return `Quality inspect: head slept (post ${surface.headPostId}, session ${surface.sessionId}, sleepEpoch ${surface.sleepEpoch})`
    case 'host-rotated':
      return `Quality inspect: host rotated (old session ${surface.oldSessionId} → new session ${surface.newSessionId}, host ${surface.oldHostId} → ${surface.newHostId}, sleepEpoch ${surface.sleepEpoch}, archiveOk ${surface.archiveOk ?? false})`
    case 'head-rotated': {
      // fb-25 (a): the reason CROSS-CHECK stamp — `reasonVerified` (computed in
      // the emit against the old session's durable token-meter projection) is a
      // CLEAR appendix so the QH/inspector never takes an unverified figure for
      // the session's real usage. Absent (legacy surface/emitter) → NO appendix
      // (R6 — the existing frame never changes).
      const verifyLabel = surface.reasonVerified === undefined
        ? ''
        : surface.reasonVerified === 'verified'
          ? ' [reason verified]'
          : surface.reasonVerified === 'unverified'
            ? ' [reason unverified vs archive]'
            : ' [reason unverifiable]'
      return `Quality inspect: head rotated (post ${surface.headPostId}, old session ${surface.oldSessionId} → new session ${surface.newSessionId}, archiveOk ${surface.archiveOk ?? false}${surface.reason === undefined ? '' : `, reason ${surface.reason}`}${verifyLabel})`
    }
    case 'post-error':
      return `Quality inspect: post-error (post ${surface.postId}, message ${surface.messageId}, error ${surface.error})`
  }
}

// ---------------------------------------------------------------------------
// P1 (MODULARIZACIÓN, 2026-08-29) — the dshd-quality Cordis PLUGIN surface.
// Thin name/inject/apply (the dshd-core/dshd-webfetch pattern): the package
// now ALSO composes as a real plugin row (cordis.patch.yml) and provides
// `deepartments.quality` — the service the bundle wires INLINE today
// (maybeEmitQualityInspectDirective + the gate). The directive EMITTER is
// LAZY (built on FIRST use; an apply is side-effect free) and its deps are
// INJECTED via the FASE 2.6 seam, never imported from the bundle:
//   - the framed post delivery ← `deepartments.deliverDeps` holder
//     `deliver.deliverPost` (FILLED by the composed bundle — FASE 2.6-C /
//     DI-by-services) or the explicit `quality.deliverPost` bucket (DECOUPLING),
//   - the message store ← `deepartments.wakepackDeps` holder
//     `wakepack.messagesStoreReady` (filled today) or `deepartments.bus.storeReady`
//     or the explicit `quality` bucket,
//   - the target head entry ← `ctx.get('deepartments.catalog').byPost` (the
//     shared registry),
//   - the QH-self-sleep dice p ← `quality.workerInspectProbability` (bundle-only
//     knob, 0.25 in the dev row = the code default) with the env override.
// A required closure missing at USE FAILS LOUD (R1), never a silently-unbound
// emitter. The gate/text exports (the drop-in bridge superset) stay intact.
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'

/** A structurally-typed message-record append input (the MessagesStore surface
 * the emitter needs — the package never imports dshd-core for it). */
export interface QualityStoreAppendInput {
  from: string
  to: string[]
  text: string
  kind: string
}

/** A minimal structural view of the emitted record (id is all the framing
 * delivery touches). */
export interface QualityStoreAppendResult {
  id: string
}

/** A minimal structural view of the target post entry (the quality-head catalog
 * entry the framed delivery receives). */
export interface QualityPostEntryLike {
  postId?: string
  sessionId?: string
}

/** The FASE 2.6 deps-holder bucket for the quality emitter (STRUCTURAL — read
 * from `ctx.get('deepartments.deliverDeps')`/`wakepackDeps` widened; the
 * bucket is a convenience for DECOUPLING to pass the bundle's OWN literal
 * closures + the bundle-only probe probability knob). */
export interface QualityBinderDeps {
  /** The bundle's resolved worker dice probability (`quality.workerInspectProbability`,
   * bundle-only per the dump contract — the dev row 0.25 == the code default).
   * Absent → the code default / env override (resolveQualityWorkerInspectProbability). */
  workerInspectProbability?: number
  /** Explicit message-store closure (DECOUPLING). Absent → the EXISTING
   * `binder.wakepack.messagesStoreReady` bucket, then `deepartments.bus`. */
  messagesStoreReady?: () => Promise<{
    append(input: QualityStoreAppendInput): Promise<QualityStoreAppendResult>
  }>
  /** Explicit framed post delivery (DECOUPLING). Absent → the EXISTING
   * `binder.deliver.deliverPost` bucket. */
  deliverPost?: (post: QualityPostEntryLike, framed: string, record: QualityStoreAppendResult, callerSessionId?: string) => Promise<unknown>
}

/** The `deepartments.quality` service surface — the QD gate + directive EMITTER
 * the bundle wires inline today. */
export interface QualitySurface {
  /** The QD directive emitter (the effect): gate → resolve quality-head →
   * append the directive record → deliver it framed. NEVER throws (the
   * delivery failure is a warn, exactly like the bundle's inline emitter); a
   * MISSING INJECTED DEP at use FAILS LOUD (R1) BEFORE the guarded emit. */
  maybeEmitQualityInspectDirective(surface: QualityInspectDirectiveSurface): Promise<void>
  /** The pure decision gate (service completeness; kind in, boolean out). */
  decide(kind: QualityInspectKind, deps?: QualityInspectDecisionDeps): boolean
}

/** The dshd-quality plugin config (minimal — the bundle-only `quality` block is
 * NOT mirrored here per the dump contract; the probe probability resolves from
 * the binder bucket / code default / env). */
export interface QualityConfig {
  /** Optional explicit probe probability override (the plugin row usually
   * omits it — the bundle-only knob stays in the deepartments row). */
  workerInspectProbability?: number
}

export const name = 'dshd-quality'
// Resolve everything via `ctx.get` at USE (inject EMPTY) so the plugin stays
// loadable in minimal compositions (the dshd-core discipline).
export const inject: string[] = []

export function apply(ctx: Context, config: QualityConfig = {}) {
  // Lazy on-first-use facade (derived service contract: never built at apply).
  let cache: QualitySurface | undefined
  const build = (): QualitySurface => {
    // DI-by-services (FASE 2): read the framed-delivery + message-store closures
    // from the BASELINE deps HOLDERS (deliverDeps + wakepackDeps — the SAME
    // closures the bundle registers, holder-path; FAIL LOUD R1 before ANY emit
    // on a missing closure). The dead binder is gone (the old late-binding
    // fallback reader re-pointed, R6 byte-igual).
    const deliverDeps = (ctx.get('deepartments.deliverDeps') as { get(): unknown } | undefined)?.get() ?? {}
    const wakepackDeps = (ctx.get('deepartments.wakepackDeps') as { get(): unknown } | undefined)?.get() ?? {}
    const bound = {
      deliver: deliverDeps as { deliverPost?: QualityBinderDeps['deliverPost'] },
      wakepack: wakepackDeps as { messagesStoreReady?: QualityBinderDeps['messagesStoreReady'] }
    }
    const deliverPost = bound.deliver?.deliverPost
    if (deliverPost === undefined) {
      throw new Error('[deepartments] quality lazy build: no framed-delivery closure — the bundle must register ctx.get("deepartments.deliverDeps").register({ deliver: { deliverPost } }) (FASE 2.6-C, composed today)')
    }
    const messagesStoreReady = bound.wakepack?.messagesStoreReady ?? (() => {
      const bus = ctx.get('deepartments.bus') as { storeReady?: Promise<{ append(input: QualityStoreAppendInput): Promise<QualityStoreAppendResult> }> } | undefined
      if (bus?.storeReady === undefined) {
        throw new Error('[deepartments] quality lazy build: no message-store closure — the bundle must register ctx.get("deepartments.wakepackDeps").register({ wakepack: { messagesStoreReady } }) (composed today) or provide deepartments.bus')
      }
      return bus.storeReady
    })
    const workerInspectProbability = config.workerInspectProbability
    const catalog = ctx.get('deepartments.catalog') as { byPost?: Map<string, QualityPostEntryLike> } | undefined
    const resolveQualityHeadEntry = (): QualityPostEntryLike | undefined => catalog?.byPost?.get('quality-head')
    const emitter = async (surface: QualityInspectDirectiveSurface): Promise<void> => {
      try {
        // QD anti-loop (owner m-178/m-182): the QH's own sleep is gated by the
        // SAME worker dice — faithfully mirroring the bundle's inline emitter
        // (invoke.ts maybeEmitQualityInspectDirective). The ENV override applies
        // inside the pure gate (parseQualityInspectEnvOverride).
        if (surface.kind === 'head-slept' && !qualityInspectDecision('head', { headPostId: surface.headPostId, rng: Math.random, workerInspectProbability })) {
          return
        }
        const qualityHead = resolveQualityHeadEntry()
        if (qualityHead === undefined) return
        const text = qualityInspectDirectiveText(surface)
        const store = await messagesStoreReady()
        const record = await store.append({ from: 'deepartments', to: ['quality-head'], text, kind: 'agent' })
        await deliverPost(qualityHead, `[From deepartments → quality-head]: ${text}`, record, void 0)
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] quality-inspect directive to "quality-head" failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {
      maybeEmitQualityInspectDirective: emitter,
      decide: (kind, deps = {}) => qualityInspectDecision(kind, { ...deps, ...(workerInspectProbability !== undefined ? { workerInspectProbability } : {}) })
    }
  }
  ctx.provide('deepartments.quality', {
    maybeEmitQualityInspectDirective: (surface: QualityInspectDirectiveSurface): Promise<void> => (cache ??= build()).maybeEmitQualityInspectDirective(surface),
    decide: (kind: QualityInspectKind, deps?: QualityInspectDecisionDeps): boolean => (cache ??= build()).decide(kind, deps)
  })
}