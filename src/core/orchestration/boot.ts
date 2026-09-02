// dsh-deepartments — drop-in re-export BRIDGE (LANE 0.2.2, gap 2): the BOOT
// ORCHESTRATION FACTORY MOVED to the dshd-orchestration package (packages/
// dshd-orchestration/src/boot.ts) with its deps-holder DI. This module is now
// a NOMINAL re-export bridge so the existing compiled surface (invoke.ts's
// `import ... from './core/orchestration/boot.js'` — byte-identical) stays a
// drop-in superset, while the factory code is OWNED by the package. Behavior +
// surfaces unchanged — R6. The nominal form NAMES the exported symbols so the
// factory locks (createBootOrchestration / BootFactoryDeps / BootSurface in
// src AND lib) stay green.
//
// NO export default (pitfall 0001 — breaks `inject`).
export {
  createBootOrchestration,
  type BootFactoryDeps,
  type BootSurface
} from 'dshd-orchestration'