// dshd-quality — the Deepartments Quality-Department (QD, spec 007) probability
// gate (the dshd-quality phase of the modular Cordis split). A PURE LIBRARY
// package (NO cordis plugin, NO tool, NO patch — the owner-confirmed MODO LIB,
// precedent 0f792cd / packages/dshd-pooler): it owns the QD gate machinery
// extracted VERBATIM from the bundle (src/invoke.ts, extraction map
// 2026-08-27-health-quality-extraction-map.md §2):
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
 * carries to `quality-head`). One variant per archive/post-error event. */
export type QualityInspectDirectiveSurface =
  | { kind: 'worker-retired'; workerPostId: string; sessionId: string; archived: boolean }
  | { kind: 'head-slept'; headPostId: string; sessionId: string; sleepEpoch: number }
  | { kind: 'host-rotated'; oldSessionId: string; newSessionId: string; oldHostId: string; newHostId: string; sleepEpoch: number; archiveOk?: boolean }
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
      return `${QUALITY_INSPECT_WORKER_RETIRED_PREFIX} (post ${surface.workerPostId}, session ${surface.sessionId}, archived ${surface.archived}). ANALYZE the retired agent: its log/session, the tools it used, its flows, its failures, and optimization opportunities → write the report to .dsh/reports/quality/ and report to quality-head`
    case 'head-slept':
      return `Quality inspect: head slept (post ${surface.headPostId}, session ${surface.sessionId}, sleepEpoch ${surface.sleepEpoch})`
    case 'host-rotated':
      return `Quality inspect: host rotated (old session ${surface.oldSessionId} → new session ${surface.newSessionId}, host ${surface.oldHostId} → ${surface.newHostId}, sleepEpoch ${surface.sleepEpoch}, archiveOk ${surface.archiveOk ?? false})`
    case 'post-error':
      return `Quality inspect: post-error (post ${surface.postId}, message ${surface.messageId}, error ${surface.error})`
  }
}