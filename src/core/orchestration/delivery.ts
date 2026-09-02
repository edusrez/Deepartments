// dsh-deepartments — drop-in re-export BRIDGE (LANE 0.2.2, gap 2): the
// DELIVERY ORCHESTRATION FACTORY MOVED to the dshd-orchestration package
// (packages/dshd-orchestration/src/delivery.ts) with its deps-holder DI. This
// module is now a NOMINAL re-export bridge so the existing compiled surface
// (invoke.ts's `import ... from './core/orchestration/delivery.js'` —
// byte-identical) stays a drop-in superset, while the factory code is OWNED by
// the package. Behavior + surfaces unchanged — R6. The nominal form NAMES the
// exported symbols so the factory locks (createDeliveryOrchestration /
// DeliveryFactoryDeps / DeliverySurface in src AND lib) stay green.
//
// NO export default (pitfall 0001 — breaks `inject`).
export {
  createDeliveryOrchestration,
  type DeliveryFactoryDeps,
  type DeliverySurface
} from 'dshd-orchestration'