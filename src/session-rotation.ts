// dsh-deepartments — re-export bridge (additive-only) for the HOST SESSION
// ROTATION state machine, moved into ./core/session-rotation.js (FASE 2 STEP f).
// Keeping this module at src/ root preserves the compiled lib/session-rotation.js
// as a drop-in superset for existing consumers/tests that import from it, so no
// test or consumer needs an edit for the carve.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from './core/session-rotation.js'
