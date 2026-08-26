// dsh-deepartments — drop-in re-export bridge (FASE 2.5 BATCH A): the registry
// core module MOVED to the dshd-core package (packages/dshd-core/src/
// registry.ts). This module is now a pure RE-EXPORT BRIDGE so the existing
// compiled surface (lib/core/registry.js) stays a drop-in superset: tests and
// every other consumer import the same symbols from the same path, while the
// implementation is OWNED by the dshd-core package. Behavior + on-disk format
// (hosts registry, durable host/posts reconcile) unchanged — R6.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'
