// dshd-core — the Deepartments CORE state machinery, extracted from the
// dsh-deepartments bundle into a standalone library package (Fase-1 modular
// Cordis split). FASE 2.5 BATCH A: dshd-core is a LIBRARY — a barrel that
// re-exports the core surface verbatim; the plugin apply/inject/services wiring
// is BATCH B (not present yet).
//
// Behavior-neutral + migration-compatible: the bundle keeps constructing/using
// the core exactly as before, only importing it from this package through
// drop-in re-export bridges (bundle src/core/X.ts -> `export * from
// 'dshd-core'` so lib/core/X.js stays a drop-in superset). The on-disk state
// formats (messages.jsonl, deliveries.jsonl, hosts registry, rotation/cleanup
// archives) are byte-identical — R6.
//
// No `apply`/`inject`/`name` plugin exports here (Batch B only).
//
// NO export default (pitfall 0001 — breaks `inject`).

// acl.js defines `busProfileFor`/`aclDenyGround`/`aclDenyReason`/`canSend` (+
// types `BusMemberProfile`/`BusCatalogLens`); delivery.js RE-EXPORTS the same
// four functions and two types for consumer convenience. Under a plain
// `export *` a name re-exported from two modules is AMBIGUOUS and silently
// dropped, so acl's surface is re-exported EXPLICITLY here (a non-star export
// takes precedence over any star export), which resolves the collision to one
// binding. Everything else flows through star exports.
export { busProfileFor, aclDenyGround, aclDenyReason, canSend } from './acl.js'
export type { BusMemberProfile, BusCatalogLens } from './acl.js'

export * from './registry.js'
export * from './messages.js'
export * from './delivery.js'
export * from './wakepack.js'
export * from './lifecycle.js'
export * from './session-rotation.js'
export * from './session-cleanup.js'
