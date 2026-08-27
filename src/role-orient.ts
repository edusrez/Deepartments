// dsh-deepartments — drop-in re-export bridge (D3 of the subagent/gui/pooler
// phase): the role-orientation module (Task T4 per-role context contracts +
// the dispatch-time transient-subagent role registry) MOVED to the dshd-core
// package (packages/dshd-core/src/role-orient.ts) and PROMOTED from the
// bundle's module-global Map to the core SERVICE `deepartments.subagentRoles`.
// This module is now a pure RE-EXPORT BRIDGE so the existing compiled surface
// (lib/role-orient.js) stays a drop-in superset: tests and every other consumer
// import the same symbols from the same path, while the implementation is OWNED
// by the dshd-core package. The service facade and these compat re-exports
// (`rememberRole` / `forgetRole` / `roleForSession` / `normalizeRole` /
// `ROLE_CONTRACTS` / `buildSubagentOrientation` / the bare `roleRegistry`
// superset) ALL resolve to ONE per-process store (module-scoped in dshd-core),
// so the R6 fallback when dshd-core is not composed stays behavior-neutral.
// Behavior unchanged — R6.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'