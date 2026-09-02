// dsh-deepartments — POLICY-SUBSTITUTION test (LANE 0.2.2, P4 — policies as
// substitutable services). The NORTH total-modularity gap 2: `deepartments.
// pacing` and `deepartments.execRoots` are POLICY SERVICES the consumers
// resolve service-FIRST with pure/inline fallbacks (the dshd-core pacing
// module / the tools inline closure). A policy PLUGIN can be composed to
// substitute either policy WITHOUT touching any consumer (the swap-without-
// touching-core P4 contract).
//
// Test shape (spec §3.5): the fixture is a loader row composed BETWEEN the P1
// packages and the bundle — it PROVIDES `deepartments.pacing` (always-VALLE)
// and `deepartments.execRoots` (extended roots). dshd-orchestration is NOT
// composed in this test (the fixture is the sole provider of the two policy
// names — Cordis allows exactly ONE provider per service name per composition,
// and this isolates the substitution from the default wrappers):
//   - deepartments.pacing { isPeakAt: () => false, pacingStateAt: VALLE } →
//     the work-register-idle watchdog emits its ALERT even when the REAL UTC
//     hour is PEAK (the 0.2.1 behavior would NOT alert — RED), AND the
//     wake-pack franja line says VALLE;
//   - deepartments.execRoots { resolveAllowedRoots: () => DEFAULT_ROOTS +
//     ['/tmp/probe-root'] } → the probe root is ALLOWED through the expert
//     deny function (the inline default would deny it — RED).
//
// Hermetic: temp stateDir; fixture register + driver files; dispose clears.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { deptExecDenyReason, DEPT_EXEC_DEFAULT_ROOTS, WORK_REGISTER_IDLE_STATE_FILE, scanWorkRegisterIdle } from '../lib/invoke.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

class StubWebServer extends Service {
  constructor(ctx) { super(ctx, 'webServer'); this.routes = [] }
  register(route) { this.routes.push(route); return () => {} }
}
class StubWebRuntime extends Service {
  constructor(ctx) { super(ctx, 'webRuntime'); this.trustedHosts = [] }
}
class StubConnection extends Service {
  constructor(ctx) { super(ctx, 'connection'); this.trustedHosts = [] }
}

/** The fixture register (heterogeneous: §1 NON-gated pending + §3 gated — the
 * wri-alert census counts the NON-gated ones). */
const FIXTURE_REGISTER = [
  '## 1. IPD — cola activa (DAG seriado)',
  '',
  '- **LANE 3 — fb-28 (QD, MEDIO)** [en cola]',
  '',
  '## 3. PENDIENTE-OWNER (decisiones — estado al 09-01)',
  '',
  '- **top-up ws10 → NO por ahora (owner 09-01)**'
].join('\n')

/** The dev-profile composition WITHOUT dshd-orchestration: dshd-core → 6 P1 →
 * the policy FIXTURE row → the bundle (the fixture provides the two policy
 * services; the bundle consumes them service-first). */
async function bootWithFixture(stateDir, { peakOrgPacing = true } = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  new StubWebServer(root)
  new StubWebRuntime(root)
  new StubConnection(root)
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org: { departments: [] } } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  // The policy FIXTURE (the ONLY provider of deepartments.pacing/.execRoots
  // in this composition — a substitutable policy plugin).
  loader.create({ id: 'policy-fixture', name: new URL('./fixtures/policy-substitution-fixture.js', import.meta.url).href, config: {} })
  // The bundle: org.pacing PEAKS at the REAL UTC hour (the current weekday
  // with a full-day peak window) so the PRE-substitution path would leave the
  // work-register-idle watchdog SILENT (RED) — the always-VALLE fixture policy
  // makes it alert (GREEN).
  const org = {
    departments: [],
    pacing: peakOrgPacing
      ? { peakWindows: { weekday: [new Date().getUTCDay() === 0 ? 7 : new Date().getUTCDay()], hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] } }
      : undefined
  }
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return { root, loader, pluginCtx, dispose: () => loaderFiber.dispose() }
}

test('policy-substitution (P4 pacing): a composed deepartments.pacing fixture (always-VALLE) OVERRIDES the real UTC franja — the work-register-idle watchdog ALERTS at a REAL-PEAK hour and the wake-pack franja line is VALLE (the substituted policy wins over the pure pacing module)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-policy-'))
  const registerPath = path.join(stateDir, 'WR-fixture.md')
  await writeFile(registerPath, FIXTURE_REGISTER, 'utf8')
  // Pre-seed the wri OWN ledger with a firstQuietTs comfortably in the past
  // (the watchdog's quiet window — 15 min default — needs `now - firstQuietTs
  // >= quietWindowMs`; the single driven tick must see the window COMPLETED).
  await writeFile(
    path.join(stateDir, WORK_REGISTER_IDLE_STATE_FILE),
    JSON.stringify({ firstQuietTs: Date.now() - 2 * 60 * 60 * 1000 }),
    'utf8'
  )
  try {
    const { pluginCtx, dispose } = await bootWithFixture(stateDir)
    try {
      const ctx = pluginCtx()
      // The fixture PROVIDED the policy (assert 1 — substitution happened).
      const pacingSvc = ctx.get('deepartments.pacing')
      assert.ok(pacingSvc !== undefined, 'deepartments.pacing resolves (the fixture provided the always-VALLE policy)')
      assert.equal(pacingSvc.isPeakAt(new Date()), false, 'the policy says always-VALLE (regardless of the real UTC hour)')

      // Assert 2 — the work-register-idle watchdog: drive ONE composed
      // dshd-health tick at the REAL now with the fixture register + a live
      // host. The watchdog's franja VALLE leg reads the SUBSTITUTED policy →
      // valley === true even though the REAL UTC hour is inside the org peak
      // window → the ALERT finding is produced (0.2.1 pure-path would be
      // silent: RED before the service-first consumption).
      const health = ctx.get('deepartments.health')
      assert.ok(health !== undefined && typeof health.runDaemonTick === 'function', 'deepartments.health resolves (composed)')
      const alerts = []
      await health.runDaemonTick({
        now: () => Date.now(),
        hosts: [{ hostId: 'host-asst', sessionId: 's-lv', roomId: 'board' }],
        posts: [],
        hostRunning: false,
        sessionContexts: [],
        hostWaits: [],
        workRegisterPath: registerPath,
        // The wri watchdog knob: a 0-quiet window so the FIRST tick alerts
        // (the default 15-min quiet records a baseline only — RED for this
        // single-tick drive).
        config: { health: { workRegisterIdleQuietMs: 0 } },
        notifyHost: async (hostEntry, frame) => { alerts.push(frame) },
        logger: { warn: () => {}, info: () => {} }
      })
      assert.ok(alerts.some((f) => f.includes('work-register-idle') && f.includes('NO-gateado')), 'the work-register-idle ALERT is emitted at a REAL-PEAK hour (the always-VALLE substituted pacing policy dominates — P4 substitution holds)')

      // Assert 3 — the wake-pack franja: assembleWakePack through the composed
      // dshd-core service renders the franja line from the SUBSTITUTED policy
      // (VALLE). The deps carry `pacingService` (the fixture) — the franja
      // section is `Franja: VALLE …`.
      const wakepack = ctx.get('deepartments.wakepack')
      assert.ok(wakepack !== undefined && typeof wakepack.assembleWakePack === 'function', 'deepartments.wakepack resolves (composed dshd-core service)')
      const pack = await wakepack.assembleWakePack('member-x', path.join(stateDir, 'journals', 'member-x.md'))
      assert.match(pack, /Franja: VALLE/, 'the wake-pack franja line says VALLE (the substituted pacing policy drives the pack)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('policy-substitution (P4 execRoots): a composed deepartments.execRoots fixture (extended roots) WIDENS the dept_exec allowed set — the probe root resolves and the expert deny function PERMITS it (the inline default would deny — RED)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-policy-exec-'))
  try {
    const { pluginCtx, dispose } = await bootWithFixture(stateDir)
    try {
      const ctx = pluginCtx()
      // The fixture PROVIDED the execRoots policy (substitution happened).
      const execRootsSvc = ctx.get('deepartments.execRoots')
      assert.ok(execRootsSvc !== undefined && typeof execRootsSvc.resolveAllowedRoots === 'function', 'deepartments.execRoots resolves (the fixture provided the extended-roots policy)')
      const roots = await execRootsSvc.resolveAllowedRoots({ id: 'research' })
      // The fixture's extended set INCLUDES the probe root (the inline default
      // would NOT) → the expert deny function (the SAME predicate the
      // dept_exec tool gates against) permits it.
      assert.ok(roots.includes('/tmp/probe-root'), 'the fixture widened the allowed-roots set with /tmp/probe-root')
      assert.equal(deptExecDenyReason('ls', '/tmp/probe-root', roots), undefined, 'the probe root is ALLOWED through the expert deny function (the substituted execRoots policy wins)')
      // Sanity: a NON-root path is still denied (the substitute only WIDENED).
      assert.ok(deptExecDenyReason('rm', '/etc/passwd', roots) !== undefined, 'a real privilege boundary is still denied (the widened policy is not a widening of ALL roots)')
      // The fixed defaults are STILL present in the substituted policy (the
      // fixture returned DEFAULT_ROOTS + the probe root — consumption parity).
      for (const def of DEPT_EXEC_DEFAULT_ROOTS) {
        assert.ok(roots.includes(def), `fixed default root ${def} present in the substituted policy`)
      }
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})