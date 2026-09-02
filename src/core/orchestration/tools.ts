// dsh-deepartments — drop-in re-export BRIDGE (LANE 0.2.2, gap 2): the TOOLS
// ORCHESTRATION FACTORY MOVED to the dshd-orchestration package (packages/
// dshd-orchestration/src/tools.ts) with its deps-holder DI. This module is now
// a NOMINAL re-export bridge so the existing compiled surface (invoke.ts's
// `import ... from './core/orchestration/tools.js'` — byte-identical) stays a
// drop-in superset, while the factory code is OWNED by the package. Behavior +
// surfaces unchanged — R6. The nominal form NAMES the exported symbols so the
// factory locks (createToolsOrchestration / ToolsFactoryDeps / ToolsSurface in
// src AND lib) stay green.
//
// NO export default (pitfall 0001 — breaks `inject`).
export {
  createToolsOrchestration,
  type ToolsFactoryDeps,
  type ToolsSurface
} from 'dshd-orchestration'