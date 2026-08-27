// dsh-deepartments — drop-in re-export bridge (dshd-pooler phase): the PURE
// provider-adapter boot-check helpers (endpoint drift + boot-findings resolver +
// the settings.yaml reader/parser + the retry constants + the synthetic finding
// postId) MOVED to the dshd-pooler package
// (packages/dshd-pooler/src/index.ts). This module is now a pure RE-EXPORT
// BRIDGE so the existing compiled surface (lib/core/pooler.js) stays a drop-in
// superset: tests and consumers import the same symbols from the same path,
// while the implementation is OWNED by the dshd-pooler package. The boot check
// closure (runProviderAdapterBootCheck) itself STAYS in the bundle (its apply
// fiber wiring); the helper semantics are unchanged (behavior byte-identical).
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-pooler'