// dsh-deepartments — drop-in re-export bridge (post-incidente 2026-09-04,
// crash-loop 609 restarts / exit 7): the SESSION SURFACE access —
// `getSessionEvents` (the ONE dual session-log read the 8 runtime call sites
// route through) + `detectSessionSurface` (the heartbeat `{ts, bootId,
// surface}` health datum) — lives in the dshd-core package
// (packages/dshd-core/src/session-surface.ts). This module is a pure RE-EXPORT
// BRIDGE (the messages/registry bridge pattern) so the compiled surface
// (lib/core/session-surface.js) stays a drop-in superset after the next build;
// the bundle imports the same symbols from the same path while the
// implementation is OWNED by dshd-core.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'