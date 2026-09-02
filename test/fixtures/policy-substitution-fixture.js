// dsh-deepartments — P4 policy-substitution FIXTURE (LANE 0.2.2): a test
// plugin that PROVES the substitutable-policy contract by REPLACING the two
// policy services the consumers resolve service-first:
//   - `deepartments.pacing` — ALWAYS-VALLE (isPeakAt → false regardless of
//     the real UTC hour; pacingStateAt → a VALLE state) — the health daemon's
//     work-register-idle watchdog + the wake-pack franja line read it;
//   - `deepartments.execRoots` — the dept_exec allowed-roots posture widened
//     with the probe root `/tmp/probe-root` (DEPT_EXEC_DEFAULT_ROOTS + the
//     probe) — the dept_exec gate reads it.
// Composed BETWEEN the P1 packages and the bundle in policy-substitution.test.js
// (the fixture is the SOLE provider of the two names in that composition —
// Cordis: one provider per service name; the default wrappers would collide).
//
// NO export default (pitfall 0001 — breaks `inject`).
import { DEPT_EXEC_DEFAULT_ROOTS } from '../../lib/invoke.js'

export const name = 'deepartments-policy-fixture'
export const inject = []

export function apply(ctx) {
  ctx.provide('deepartments.pacing', {
    isPeakAt: () => false, // SIEMPRE VALLE — sea cual sea la hora UTC real
    pacingStateAt: () => ({ peak: false, untilMs: 0, untilHhMm: '00:00', span: '--:--' }),
    nextTransitionAt: () => 0,
    formatFranjaLine: () => 'Franja: VALLE [--:--] UTC — hasta 00:00 UTC',
    windowFromConfig: () => ({ peakWindows: { weekday: [1, 2, 3, 4, 5, 6, 7], hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] } })
  })
  ctx.provide('deepartments.execRoots', {
    resolveAllowedRoots: async () => [...DEPT_EXEC_DEFAULT_ROOTS, '/tmp/probe-root']
  })
}