// dsh-deepartments — drop-in re-export bridge (dshd-quality phase): the QD
// (spec 007) probability gate + config-resolution + QUALITY INSPECT directive
// text (QUALITY_WORKER_INSPECT_DEFAULT_PROBABILITY, QUALITY_INSPECT_ENV_VAR,
// QualityInspectKind, QualityInspectDecisionDeps, qualityInspectDecision,
// resolveQualityWorkerInspectProbability, QualityInspectDirectiveSurface,
// qualityInspectDirectiveText — the two private helpers
// parseQualityInspectEnvOverride + clamp01 travel package-internal) MOVED to the
// dshd-quality package (packages/dshd-quality/src/index.ts). This module is now
// a pure RE-EXPORT BRIDGE so the existing compiled surface (lib/core/quality.js)
// stays a drop-in superset: tests and consumers import the same symbols from the
// same paths, while the implementation is OWNED by the dshd-quality package. The
// directive EMITTER (maybeEmitQualityInspectDirective — the store.append +
// busDeliverToPost closure), the per-apply config resolution
// (qualityWorkerInspectProbability), resolveQualityHeadEntry and every gate
// call-site STAY in the bundle (its apply-fiber wiring) and call the gate
// through this bridge; the gate semantics are unchanged (behavior identical).
// NO cordis plugin / NO patch row — MODO LIB.
//
// NO export default (pitfall 0001 — breaks `inject`).
export * from 'dshd-quality'