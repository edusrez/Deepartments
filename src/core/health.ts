// dsh-deepartments — drop-in re-export bridge (dshd-health phase): the
// system-health DOMAIN (post-error capture + unusable-session markers, the
// heartbeat/alerts ledger + audit, W8-i error class, M3 back-off/quarantine,
// the W8-c safeguards, the W8-d system heartbeat, the W8-h interrupted-post
// reconciliation, and the C6 delivery tail-reader factory + scans + the pure
// health daemon tick) MOVED to the dshd-health package
// (packages/dshd-health/src/index.ts). This module is now a pure RE-EXPORT
// BRIDGE so the existing compiled surface (lib/core/health.js) stays a drop-in
// superset: tests and consumers import the same symbols from the same path,
// while the implementation is OWNED by the dshd-health package. The daemon
// WIRING (setInterval + the ONE per-daemon createDeliveryRowsTailReader call +
// the notifyHost closure that delivers the ALERT) STAYS in the bundle (its
// apply-fiber wiring); the helper/tick semantics are unchanged (behavior
// byte-identical). NO cordis plugin / NO patch row — MODO LIB.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-health'