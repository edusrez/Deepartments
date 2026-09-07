// dsh-deepartments — drop-in re-export bridge (FASE 2.5 BATCH A pattern, R6):
// the ROTATION BASELINE assertion module (O6 — VALLE 09-07, the automated
// D-Q3 hygiene invariants for host/head rotation) MOVED to the dshd-core
// package (packages/dshd-core/src/rotation-baseline.ts). This module is a pure
// RE-EXPORT BRIDGE so the existing compiled surface stays a drop-in superset:
// tests and consumers import the same symbols from the same path, while the
// implementation is OWNED by the dshd-core package. R6 — the bridge carries
// the same pattern as session-rotation.ts: `export * from 'dshd-core'`.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'