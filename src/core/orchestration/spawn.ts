// dsh-deepartments — drop-in re-export BRIDGE (LANE 0.2.2, gap 2): the SPAWN
// ORCHESTRATION FACTORY MOVED to the dshd-orchestration package (packages/
// dshd-orchestration/src/spawn.ts) with its deps-holder DI. This module is now
// a NOMINAL re-export bridge so the existing compiled surface (invoke.ts's
// `import ... from './core/orchestration/spawn.js'` — byte-identical) stays a
// drop-in superset: the same-symbol imports resolve to the package exports,
// while the factory code itself is OWNED by the package. Behavior + surfaces
// unchanged — R6. The nominal (non-star) form NAMES the exported symbols so
// the factory locks that assert the literals ('createSpawnOrchestration' /
// SpawnFactoryDeps / SpawnSurface / HeadToolDisposers in src AND lib) stay
// green.
//
// NO export default (pitfall 0001 — breaks `inject`).
export {
  createSpawnOrchestration,
  type SpawnFactoryDeps,
  type SpawnSurface,
  type HeadToolDisposers
} from 'dshd-orchestration'