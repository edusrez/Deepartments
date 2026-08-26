// dsh-deepartments — drop-in re-export bridge (FASE 2.5 BATCH A): the wakepack
// core module (wake context pack + roster) MOVED to the dshd-core package
// (packages/dshd-core/src/wakepack.ts). This module is now a pure RE-EXPORT
// BRIDGE so the existing compiled surface (lib/core/wakepack.js) stays a
// drop-in superset: tests and consumers import the same symbols from the same
// path, while the implementation is OWNED by the dshd-core package. The wake
// pack + roster assembly behavior is unchanged.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'
