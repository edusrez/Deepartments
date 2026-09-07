// dsh-deepartments — re-export bridge (additive-only) for the ROTATION
// BASELINE assertion module, moved into ./core/rotation-baseline.js (O6 —
// VALLE 09-07; the R6 pattern of session-rotation.ts). Keeping this module at
// src/ root preserves the compiled lib/rotation-baseline.js as a drop-in
// superset for existing consumers/tests that import from it, so no test or
// consumer needs an edit for the carve.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from './core/rotation-baseline.js'