// dshd-orchestration — the apply-ORCHESTRATION layer (LANE 0.2.2, gap 2 of the
// NORTH total-modularity mission). The 5 orchestration FACTORIES that the
// bundle's applyInvoke USED to build inline (the closure zones of
// boot/presets/spawn/tools/delivery — ~9.7k LOCs of src/core/orchestration/*.ts)
// MOVED here (MOVEMENT-ONLY, the same closures, the same order) and are exposed
// as LAZY SERVICES: `deepartments.boot/.presets/.spawn/.tools/.delivery`. The
// bundle's applyInvoke is reduced to pure GLUE (service-first consumption +
// holder fills + the daemon effects) and the bundle remains a PURE CONSUMER +
// holder WRITER (P1: 0 ctx.provide in src). This package is the PROVIDER.
//
// DI (pattern 1B of 0.2.1 — dshd-gui/dshd-health/dshd-jobs holders): the
// factory deps come from the apply-scope of the BUNDLE (byPost/hosts/registry/
// coordinatorForPost/retirePost — live maps + closures only the bundle's apply
// possesses). They CANNOT be derived here, so each factory gets a per-package
// deps holder (`deepartments.<x>Deps` — provided HERE) that the BUNDLE WRITES
// via `register({...})` right after its apply state is ready. The holders carry
// an EPOCH counter (createDepsHolder): the lazy surface caches invalidate when
// the holder is CLEARED (the P6 unload effect of the bundle), so a post-dispose
// access REBUILDS and fails loud (R1) — never stale closure execution.
//
// LAZY surface contract (the dshd-gui/dshd-core shells): the service is NEVER
// built at apply time — the holder may still be empty (the bundle fills after
// its state is ready). Each surface member delegates to a `ensure()` that
// builds the factory ON FIRST USE and caches it per epoch. The surfaces are
// exposed THROUGH A PROXY: every member name the bundle destructures resolves
// through the same lazy `ensure()` (the factory surfaces are plain objects of
// closures + live maps — the proxy is read-only passthrough, no intercepted
// writes; members that don't exist read as undefined exactly like a missing
// property of the factory object).
//
// POLICY SERVICES (P4 — substitutable, §3 of the map): this package ALSO
// provides the two policy seams the factories/daemons consume service-first
// with inline fallbacks:
//   - `deepartments.pacing` — a thin wrapper over the PURE pacing module
//     (packages/dshd-core/src/pacing.ts): the same isPeakAt/pacingStateAt/
//     nextTransitionAt/formatFranjaLine/windowFromConfig functions. A policy
//     plugin can provide `deepartments.pacing` INSTEAD (the fixture of
//     test/policy-substitution.test.js does) — the consumers read the service
//     first and fall back to the pure module (R6, byte-identical).
//   - `deepartments.execRoots` — the dept_exec allowed-roots POSTURE policy.
//     Default: the same computation the tools factory does inline
//     (tools.ts:846-852 — fixed roots + repoRoot + stateDir + department
//     workspace + org.execRoots/missionExecRoots), bound to the tools
//     factory's OWN closure via a late `execRoots` export the tools factory
//     produces (reads its deps inside createToolsOrchestration). A policy
//     plugin can provide it INSTEAD (the P4 execRoots fixture returns an
//     EXTENDED root list).
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'

import { createBootOrchestration } from './boot.js'
import type { BootFactoryDeps, BootSurface } from './boot.js'
import { createPresetsOrchestration } from './presets.js'
import type { PresetsFactoryDeps, PresetsSurface } from './presets.js'
import { createSpawnOrchestration } from './spawn.js'
import type { SpawnFactoryDeps, SpawnSurface } from './spawn.js'
import { createToolsOrchestration } from './tools.js'
import type { ToolsFactoryDeps, ToolsSurface } from './tools.js'
import { createDeliveryOrchestration } from './delivery.js'
import type { DeliveryFactoryDeps, DeliverySurface } from './delivery.js'

// The package ROOT re-exports the moved factories + their types (the bundle's
// nominal bridges src/core/orchestration/<x>.ts re-export from HERE — the
// drop-in superset: same symbols, same surfaces, byte-identical import lines).
export {
  createBootOrchestration,
  type BootFactoryDeps,
  type BootSurface
} from './boot.js'
export {
  createPresetsOrchestration,
  type PresetsFactoryDeps,
  type PresetsSurface
} from './presets.js'
export {
  createSpawnOrchestration,
  type SpawnFactoryDeps,
  type SpawnSurface,
  type HeadToolDisposers
} from './spawn.js'
export {
  createToolsOrchestration,
  type ToolsFactoryDeps,
  type ToolsSurface
} from './tools.js'
export {
  createDeliveryOrchestration,
  type DeliveryFactoryDeps,
  type DeliverySurface
} from './delivery.js'

import {
  isPeakAt,
  nextTransitionAt,
  pacingStateAt,
  formatFranjaLine,
  pacingWindowFromConfig
} from 'dshd-core'
import type { PacingWindowOptions, PacingState } from 'dshd-core'

export const name = 'dshd-orchestration'
// The factories' zones access the HARNESS services by property (ctx.tools.
// register/guard, ctx.sessions.get — the SAME injects the bundle declares,
// src/index.ts:28 ['tools', 'sessions']), so this package declares them too:
// a composition that rows this plugin (the dev profile) always mounts the
// harness first. The policy services still resolve everything else via
// ctx.get at USE.
export const inject = ['tools', 'sessions']

/** LANE 0.2.1 (1B) — the minimal per-apply mutable deps holder (register/get/
 * clear + an EPOCH counter for cache invalidation) — the dshd-gui pattern. The
 * bundle FILLS it via `register`; the P6 unload effect RELEASES it via `clear`
 * (epoch++ → the lazy surface caches invalidate → post-dispose rebuild fails
 * loud R1). AGENTS.md rule 4: per-apply instance provided as a service. */
export interface DepsHolder<T> {
  register(deps: Partial<T>): void
  get(): T
  clear(): void
  getEpoch(): number
}

/** Create a per-apply mutable deps holder (see `DepsHolder`). */
export function createDepsHolder<T>(): DepsHolder<T> {
  let deps = {} as T
  let epoch = 0
  return {
    register(partial) { deps = { ...deps, ...partial } },
    get() { return deps },
    clear() { deps = {} as T; epoch++ },
    getEpoch() { return epoch }
  }
}

/** The `deepartments.pacing` policy surface (P4) — a thin wrapper over the
 * pure pacing module. A substituted plugin provides the SAME shape. */
export interface PacingPolicySurface {
  isPeakAt(date: Date, options?: PacingWindowOptions): boolean
  pacingStateAt(date: Date, options?: PacingWindowOptions): PacingState
  nextTransitionAt(date: Date, options?: PacingWindowOptions): number
  formatFranjaLine(state: PacingState): string
  /** The config → options resolver (the parameter the pure functions take). */
  windowFromConfig(config?: { enabled?: boolean; peakWindows?: { weekday?: number[]; hours?: number[] }; peakBufferMs?: number }): PacingWindowOptions
}

/** The `deepartments.execRoots` policy surface (P4) — the dept_exec allowed
 * roots for one department. The default impl delegates to the tools factory's
 * OWN closure (a late export of the ToolsSurface); a substituted plugin
 * provides the SAME shape. */
export interface ExecRootsPolicySurface {
  /** Resolve the allowed roots for a department (the union the dept_exec tool
   * gates against). Never throws. */
  resolveAllowedRoots(department: { id?: string } | undefined): Promise<string[]>
}

/** The dshd-orchestration plugin config (minimal — the services are factory-
 * wrapped; the rows supply nothing). */
export interface OrchestrationConfig {
  /** Optional pacing-policy override injected directly (a caller may provide
   * the surface here instead of a separate plugin row). */
  pacing?: PacingPolicySurface
  /** Optional execRoots-policy override injected directly. */
  execRoots?: ExecRootsPolicySurface
}

/** Build a LAZY delegating surface proxy over `ensure()` (the read-only
 * passthrough: every member get resolves through the cached factory build).
 * A member the factory does not produce reads as undefined (the destructure
 * tolerates it); writes are forwarded to the underlying surface object.
 * NOTE (traps): `get` is the ONLY build-triggering trap — the introspection
 * traps (ownKeys/has/getOwnPropertyDescriptor) must NOT eagerly build, because
 * Cordis's getTraceable probes the provided value (hasOwn/property-descriptor
 * walks) at capture time, when the holder may STILL BE EMPTY (the bundle fills
 * it right after its apply state is ready — a lazy build there would throw the
 * false-positive R1). The introspection traps therefore return the TARGET's
 * (empty) descriptors without touching ensure(). */
function lazySurface<T extends object>(ensure: () => T): T {
  const target = {} as T
  return new Proxy(target, {
    get(_t, prop, receiver) {
      // SYMBOL gets (the cordis getTraceable tracker probes) are answered from
      // the EMPTY target — never a build (capture-time probes must not throw).
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      const surface = ensure()
      return Reflect.get(surface, prop, receiver)
    },
    has(_t, prop) { return prop in target },
    ownKeys() { return Reflect.ownKeys(target) },
    getOwnPropertyDescriptor(_t, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop)
    }
  })
}

export function apply(ctx: Context, config: OrchestrationConfig = {}) {
  // --- the 5 deps holders (pattern 1B — the bundle WRITES them). ------------
  const bootDeps = createDepsHolder<BootFactoryDeps>()
  const presetsDeps = createDepsHolder<PresetsFactoryDeps>()
  const spawnDeps = createDepsHolder<SpawnFactoryDeps>()
  const toolsDeps = createDepsHolder<ToolsFactoryDeps>()
  const deliveryDeps = createDepsHolder<DeliveryFactoryDeps>()
  ctx.provide('deepartments.bootDeps', bootDeps)
  ctx.provide('deepartments.presetsDeps', presetsDeps)
  ctx.provide('deepartments.spawnDeps', spawnDeps)
  ctx.provide('deepartments.toolsDeps', toolsDeps)
  ctx.provide('deepartments.deliveryDeps', deliveryDeps)

  // --- the 5 LAZY services (built ON FIRST USE, cached per holder epoch). ---
  let bootCache: BootSurface | undefined
  let bootEpoch = -1
  const ensureBoot = (): BootSurface => {
    const epoch = bootDeps.getEpoch()
    if (bootCache === undefined || bootEpoch !== epoch) {
      const bound = bootDeps.get()
      if (Object.keys(bound).length === 0) {
        throw new Error('[deepartments] boot lazy build: the bootDeps holder is EMPTY — the bundle must call ctx.get("deepartments.bootDeps").register({...}) after its apply state is ready (post-dispose access would rebuild here and fail loud R1)')
      }
      bootCache = createBootOrchestration(ctx, bound)
      bootEpoch = epoch
    }
    return bootCache
  }
  let presetsCache: PresetsSurface | undefined
  let presetsEpoch = -1
  const ensurePresets = (): PresetsSurface => {
    const epoch = presetsDeps.getEpoch()
    if (presetsCache === undefined || presetsEpoch !== epoch) {
      const bound = presetsDeps.get()
      if (Object.keys(bound).length === 0) {
        throw new Error('[deepartments] presets lazy build: the presetsDeps holder is EMPTY — the bundle must register the presets deps after its apply state is ready')
      }
      presetsCache = createPresetsOrchestration(ctx, bound)
      presetsEpoch = epoch
    }
    return presetsCache
  }
  let spawnCache: SpawnSurface | undefined
  let spawnEpoch = -1
  const ensureSpawn = (): SpawnSurface => {
    const epoch = spawnDeps.getEpoch()
    if (spawnCache === undefined || spawnEpoch !== epoch) {
      const bound = spawnDeps.get()
      if (Object.keys(bound).length === 0) {
        throw new Error('[deepartments] spawn lazy build: the spawnDeps holder is EMPTY — the bundle must register the spawn deps after its apply state is ready')
      }
      spawnCache = createSpawnOrchestration(ctx, bound)
      spawnEpoch = epoch
    }
    return spawnCache
  }
  let toolsCache: ToolsSurface | undefined
  let toolsEpoch = -1
  const ensureTools = (): ToolsSurface => {
    const epoch = toolsDeps.getEpoch()
    if (toolsCache === undefined || toolsEpoch !== epoch) {
      const bound = toolsDeps.get()
      if (Object.keys(bound).length === 0) {
        throw new Error('[deepartments] tools lazy build: the toolsDeps holder is EMPTY — the bundle must register the tools deps after its apply state is ready')
      }
      toolsCache = createToolsOrchestration(ctx, bound)
      toolsEpoch = epoch
    }
    return toolsCache
  }
  let deliveryCache: DeliverySurface | undefined
  let deliveryEpoch = -1
  const ensureDelivery = (): DeliverySurface => {
    const epoch = deliveryDeps.getEpoch()
    if (deliveryCache === undefined || deliveryEpoch !== epoch) {
      const bound = deliveryDeps.get()
      if (Object.keys(bound).length === 0) {
        throw new Error('[deepartments] delivery lazy build: the deliveryDeps holder is EMPTY — the bundle must register the delivery deps after its apply state is ready')
      }
      deliveryCache = createDeliveryOrchestration(ctx, bound)
      deliveryEpoch = epoch
    }
    return deliveryCache
  }

  ctx.provide('deepartments.boot', lazySurface(ensureBoot))
  ctx.provide('deepartments.presets', lazySurface(ensurePresets))
  ctx.provide('deepartments.spawn', lazySurface(ensureSpawn))
  ctx.provide('deepartments.tools', lazySurface(ensureTools))
  ctx.provide('deepartments.delivery', lazySurface(ensureDelivery))

  // --- P4 POLICY SERVICES (substitutable seams; the factories/daemons consume
  // them service-first with the pure/inline fallbacks — §3 of the map). ------
  const pacing: PacingPolicySurface = {
    isPeakAt: (date, options) => isPeakAt(date, options),
    pacingStateAt: (date, options) => pacingStateAt(date, options),
    nextTransitionAt: (date, options) => nextTransitionAt(date, options),
    formatFranjaLine: (state) => formatFranjaLine(state),
    windowFromConfig: (cfg) => pacingWindowFromConfig(cfg)
  }
  ctx.provide('deepartments.pacing', config.pacing ?? pacing)
  ctx.provide('deepartments.execRoots', config.execRoots ?? {
    // The DEFAULT: delegate to the tools factory's OWN closure (a late
    // `execRoots` export of the ToolsSurface — the tools factory binds its
    // deps and produces the SAME computation it runs inline). The service
    // builds laily through ensureTools (the bundle fills toolsDeps first — a
    // missing bind FAILS LOUD R1, never a silently-empty root list).
    resolveAllowedRoots: async (department: { id?: string } | undefined) => {
      const surface = ensureTools()
      const execRoots = (surface as unknown as { execRoots?: ExecRootsPolicySurface }).execRoots
      if (execRoots === undefined) {
        throw new Error('[deepartments] execRoots resolution: the tools surface has no execRoots policy — the tools factory must export it (the default dept_exec root set)')
      }
      return execRoots.resolveAllowedRoots(department)
    }
  })

  // P6 — the unload releases the 5 holders (epoch++ → caches invalidate →
  // post-dispose lazy access REBUILDS over the emptied holder and FAILS LOUD
  // R1 — never stale closure execution of the unmounted bundle). Cordis runs
  // the disposers in REVERSE registration order; the bundle's daemon effects
  // register AFTER its apply, so they dispose FIRST and the dep seams are
  // released only after no in-flight tick can touch them.
  ctx.effect(() => () => {
    bootDeps.clear()
    presetsDeps.clear()
    spawnDeps.clear()
    toolsDeps.clear()
    deliveryDeps.clear()
  }, 'dshd-orchestration: the 5 deps holders released on unload (P6 — no stale closures post-unmount)')
}