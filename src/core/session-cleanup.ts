// dsh-deepartments — drop-in re-export bridge (FASE 2.5 BATCH A): the web-UI
// sleep-cleanup core module MOVED to the dshd-core package
// (packages/dshd-core/src/session-cleanup.ts). This module is now a pure
// RE-EXPORT BRIDGE so the existing compiled surface (lib/core/session-cleanup.js)
// stays a drop-in superset: tests and consumers import the same symbols from
// the same path, while the implementation is OWNED by the dshd-core package.
// The cleanup archive/truncate format is unchanged.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'
