// dsh-deepartments — drop-in re-export bridge (FASE 2.5 BATCH A): the ACL core
// module (pure messaging ACL) MOVED to the dshd-core package
// (packages/dshd-core/src/acl.ts). This module is now a pure RE-EXPORT BRIDGE
// so the existing compiled surface (lib/core/acl.js) stays a drop-in superset:
// tests and consumers import the same symbols from the same path, while the
// implementation is OWNED by the dshd-core package. The ACL semantics are
// unchanged (host → everyone; head → heads + own dept; worker → own dept;
// worker → host prohibited).
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-core'
