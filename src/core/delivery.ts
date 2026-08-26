// dsh-deepartments — drop-in re-export bridge (FASE 2.5 BATCH A): the delivery
// core module (bus delivery engine + deliverOrQueue gate) MOVED to the
// dshd-core package (packages/dshd-core/src/delivery.ts). This module is now a
// pure RE-EXPORT BRIDGE so the existing compiled surface (lib/core/delivery.js)
// stays a drop-in superset: tests and consumers import the same symbols from
// the same path, while the implementation is OWNED by the dshd-core package.
// The delivery + ACL semantics are unchanged.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'
