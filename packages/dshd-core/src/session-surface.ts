// dshd-core — SESSION SURFACE access (post-incidente 2026-09-04, crash-loop
// 609 restarts / exit 7): the ONE shared implementation of the dual session-log
// read. The runtime core migrated from the legacy cached `events` getter
// (0.1.1-rc.2) to `snapshotEvents()` (0.1.2-rc.1) while the CODE was pinned to
// the rc.1 tree — a non-optional `session.snapshotEvents()` call inside a
// daemon tick builder (buildHealthPosts, tools.ts:4965 at the time) threw a
// TypeError that escaped the setInterval wrapper (invoke.ts:3457-3465) and
// killed the dev profile 609 times (exit 7). The durable fix: every session-log
// read in the runtime goes through `getSessionEvents` — feature-detection
// per-call, NEVER a throw — and the detected SURFACE is exposed as a health
// datum (heartbeat `{ts, bootId, surface}`) so a future code-vs-runtime drift
// is visible in the first boot instead of after a night of churn.
//
// Semantics (frozen/cached identical on both seams): `snapshotEvents()` and the
// legacy `events` getter both yield the SAME immutable snapshot of the session
// log, so which one resolves is irrelevant for read isolation — the helper
// prefers the rc.1 method (the intended surface) with the legacy fallback, and
// `[]` when neither is present (empty session / absent session). This module is
// PURE (no I/O, no cordis): unit-testable and safe to import from every
// package (dshd-orchestration / dshd-health / the bundle via the drop-in
// bridge src/core/session-surface.ts).
//
// NO export default (pitfall 0001 — breaks `inject`).

/** A duck-typed session log: either the rc.1 `snapshotEvents()` method or the
 * legacy `events` getter (or both during the migration arc — the runtime core
 * provides both, or only one, depending on its version). ALL members optional:
 * any object (a full `Session`, a mock, a partial) is structurally assignable —
 * the helper never assumes the caller holds a complete session. */
export interface SessionLogLike {
  /** The 0.1.2-rc.1+ session-log snapshot method (frozen/cached read). */
  snapshotEvents?: () => readonly unknown[]
  /** The pre-rc.1 cached `events` getter (0.1.1-rc.2 and earlier). */
  events?: readonly unknown[]
}

/** The detected session surface of a live session (the health datum). Four
 * mutually exclusive states: only the rc.1 method, only the legacy getter, both
 * (the migration arc), or none (an absent/foreign session object). Reported
 * verbatim by the heartbeat + the W8-d wake-pack section so the caller can see
 * the CODE-vs-RUNTIME drift at the first boot. */
export type SessionSurface = '0.1.2-rc.1' | '0.1.1-rc.2-legacy' | 'both' | 'none'

/** The ONE dual session-log read (post-incidente 2026-09-04): resolve the
 * session's event log via `snapshotEvents()` when the rc.1 method exists, else
 * the legacy `events` getter, else `[]`. NEVER throws (a session-shaped object
 * that is null/undefined/foreign degrades to `[]`); the caller casts the
 * `readonly unknown[]` to its event type (HealthSessionEvent[] etc.). All 8
 * runtime call sites of the migrable session surface (invoke.ts:2309/:2510,
 * tools.ts:2400/:3339/:4965/:5029, presets.ts:1074/:1087) route through this
 * helper — a new direct `session.snapshotEvents(` call anywhere else is the
 * regression this module exists to make greppable. */
export function getSessionEvents(session: SessionLogLike | null | undefined): readonly unknown[] {
  return session?.snapshotEvents?.() ?? session?.events ?? []
}

/** Detect the session surface of a live session (the health datum of decision
 * 2): `'both'` → the rc.1 method AND the legacy getter are present (the
 * migration arc runtime); `'0.1.2-rc.1'` → only `snapshotEvents()`; 
 * `'0.1.1-rc.2-legacy'` → only `events`; `'none'` → neither (absent/foreign).
 * Never throws; a null/undefined session is `'none'`. */
export function detectSessionSurface(session: SessionLogLike | null | undefined): SessionSurface {
  const hasSnapshot = typeof session?.snapshotEvents === 'function'
  const hasEvents = Array.isArray(session?.events)
  if (hasSnapshot && hasEvents) return 'both'
  if (hasSnapshot) return '0.1.2-rc.1'
  if (hasEvents) return '0.1.1-rc.2-legacy'
  return 'none'
}