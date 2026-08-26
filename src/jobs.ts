// dsh-deepartments — agenda/jobs engine (dshd-jobs phase): the pure cron
// scheduler, job-definition reader, calendar/job-runs store helpers and scheduler
// tick.
//
// dshd-jobs phase: the implementation has MOVED to `./core/jobs.js` (the drop-in
// bridge -> `export * from 'dshd-jobs'`). This module is now a pure RE-EXPORT
// BRIDGE so the existing compiled surface (`lib/jobs.js`) stays a drop-in
// superset: tests (and every other consumer) import the same symbols from the
// same path they always have, while the engine is OWNED by the dshd-jobs
// package.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from './core/jobs.js'
