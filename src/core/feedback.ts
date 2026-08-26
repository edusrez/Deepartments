// dsh-deepartments — drop-in re-export bridge (dshd-feedback phase): the
// universal feedback store + state machine + types MOVED to the dshd-feedback
// package (packages/dshd-feedback/src/index.ts). This module is now a pure
// RE-EXPORT BRIDGE so the existing compiled surface (lib/feedback.js) stays a
// drop-in superset: tests and consumers import the same symbols from the same
// path, while the implementation is OWNED by the dshd-feedback package.
// The feedback semantics are unchanged.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-feedback'
