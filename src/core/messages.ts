// dsh-deepartments — drop-in re-export bridge (FASE 2.5 BATCH A): the messages
// core module (agent messaging store + redelivery guard) MOVED to the dshd-core
// package (packages/dshd-core/src/messages.ts). This module is now a pure
// RE-EXPORT BRIDGE so the existing compiled surface (lib/core/messages.js)
// stays a drop-in superset: tests and every consumer import the same symbols
// from the same path, while the implementation is OWNED by the dshd-core
// package. On-disk messages.jsonl/deliveries.jsonl format byte-identical — R6.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'
