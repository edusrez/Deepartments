// dsh-deepartments — universal feedback store (dshd-feedback phase): the
// durable append-only feedback backlog + state machine.
//
// dshd-feedback phase: the implementation has MOVED to `./core/feedback.js`
// (the drop-in bridge -> `export * from 'dshd-feedback'`). This module is now a
// pure RE-EXPORT BRIDGE so the existing compiled surface (`lib/feedback.js`)
// stays a drop-in superset: tests (and every other consumer) import the same
// symbols from the same path they always have, while the store + machine are
// OWNED by the dshd-feedback package.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from './core/feedback.js'
