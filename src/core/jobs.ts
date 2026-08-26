// dsh-deepartments — drop-in re-export bridge (dshd-jobs phase): the pure
// agenda/jobs engine (cron + job-def reader + calendar/job-runs store helpers +
// the scheduler tick) MOVED to the dshd-jobs package
// (packages/dshd-jobs/src/index.ts). This module is now a pure RE-EXPORT BRIDGE
// so the existing compiled surface (lib/core/jobs.js) stays a drop-in superset:
// tests and consumers import the same symbols from the same path, while the
// implementation is OWNED by the dshd-jobs package. The jobs semantics are
// unchanged (behavior byte-identical).
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-jobs'
