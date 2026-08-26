// dsh-deepartments — drop-in re-export bridge (FASE 2.5 BATCH A): the host
// session-rotation core module (U2 rotation state machine) MOVED to the
// dshd-core package (packages/dshd-core/src/session-rotation.ts). This module
// is now a pure RE-EXPORT BRIDGE so the existing compiled surface
// (lib/core/session-rotation.js) stays a drop-in superset: tests and consumers
// import the same symbols from the same path, while the implementation is OWNED
// by the dshd-core package. Rotation hosts.json schema (D4) unchanged — R6.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'
