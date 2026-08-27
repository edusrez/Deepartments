// dsh-deepartments — drop-in re-export bridge (dshd-gui phase): the PURE
// `/deepartments` RPC channel (endpoint dispatcher + envelope validator +
// authority/trust fence + the thin node:http route handler + the channel
// types) MOVED to the dshd-gui package (packages/dshd-gui/src/index.ts). This
// module is now a pure RE-EXPORT BRIDGE so the existing compiled surface
// (lib/core/gui.js) stays a drop-in superset: tests and consumers import the
// same symbols from the same path, while the implementation is OWNED by the
// dshd-gui package. The webServer mount effect + the endpointDeps wiring
// closure STAY in the bundle (they bind the live apply-fiber registries and
// inject the bundle-owned pure deps buildAgentRows/pickLiveHostEntry); the
// dispatcher semantics are unchanged (behavior byte-identical).
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-gui'