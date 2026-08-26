// dsh-deepartments — drop-in re-export bridge (FASE 2.5 BATCH A): the lifecycle
// core module (dept_sleep / dept_memo_write semantics, sleepEpoch marking,
// host-rotation decision, journal/archive handling) MOVED to the dshd-core
// package (packages/dshd-core/src/lifecycle.ts). This module is now a pure
// RE-EXPORT BRIDGE so the existing compiled surface (lib/core/lifecycle.js)
// stays a drop-in superset: tests and consumers import the same symbols from
// the same path, while the implementation is OWNED by the dshd-core package.
// Behavior + journal/archive format byte-identical — R6.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'
