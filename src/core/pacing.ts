// dsh-deepartments — drop-in re-export bridge (PACING phase, owner m-PACING
// 2026-08-28): the peak/valley FRANJA domain (the pure UTC window machinery
// isPeakAt / pacingStateAt / nextTransitionAt / formatFranjaLine +
// countPendingWorkRegister + the structural PacingConfigLike mirror) MOVED to
// the dshd-core package (packages/dshd-core/src/pacing.ts). This module is a
// pure RE-EXPORT BRIDGE so the compiled surface (lib/core/pacing.js) is a
// drop-in superset: consumers import the same symbols from the same path,
// while the implementation is OWNED by the dshd-core package. The wake-pack
// assembly (dshd-core wakepack.ts, same package) and the system-health daemon
// (dshd-health) consume it directly; this bridge keeps the bundle path valid.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'