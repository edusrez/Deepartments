// dsh-deepartments — EXECROOTS-SERVICE REPRO test (HOTFIX 0.2.2-1 — post-deploy
// runtime regression: dept_exec broken in the LIVE profile with «Error:
// execRoots.resolveAllowedRoots is not a function» on EVERY call, while
// read/glob/grep/write work). Reproduces the REAL dev-profile composition
// (dshd-core → the 6 P1 packages → dshd-orchestration → the bundle — the
// profile bundles array at /opt/dsh/.dsh-dev/profiles/deepartments-dev/
// package.json:34-35) and drives the dept_exec allowed-roots PATH:
//   - the DEFAULT `deepartments.execRoots` service (provided by the
//     dshd-orchestration row, index.ts:296-318) resolves AND its
//     resolveAllowedRoots is FUNCTIONAL in the real order (RED WITHOUT the
//     fix: calling it rejects with «execRoots.resolveAllowedRoots is not a
//     function» — the shape mismatch at packages/dshd-orchestration/
//     src/index.ts:308 over the ToolsSurface `execRoots` member, which was the
//     tools factory's RAW service-first resolver closure — OLD tools.ts:5095
//     `execRoots: deptExecAllowedRoots` — NOT an ExecRootsPolicySurface
//     object; the parameterless-Yet-truthy function slipped past the then
//     `=== undefined` fail-loud);
//   - the resolved set carries the fixed defaults + the runtime stateDir + the
//     repo root (the SAME computation the tools factory runs inline), and the
//     REAL dept_exec guard predicate (deptExecDenyReason) ALLOWS an in-root
//     cwd (inside=fine) and DENIES an out-of-root cwd (outside=denied) + the
//     STABLE home stays protected (no mission grant in this profile);
//   - the DEEPEST reachable chain — the ToolsSurface `execRoots` member via
//     the lazy `deepartments.tools` service (the very closure the default
//     service binds — the path the dept_exec/dept_zstd_read tool guards run)
//     resolves the same set.
// TDD: the test is RED against the 0.2.2 code (the assertions that CALL
// resolveAllowedRoots / the surface member throw the shape TypeError) and
// GREEN after the 0.2.2-1 hotfix (the surface exports the PURE inline
// computation «deptExecAllowedRootsInline» and the default calls it AS A
// FUNCTION — acyclic by construction).
// Hermetic: temp stateDir; dispose clears effects. The package/bundle libs are
// BUILD ARTIFACTS (gitignored) — the HOST rebuilds (pnpm build) before running
// the suite.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { deptExecDenyReason, DEPT_EXEC_DEFAULT_ROOTS } from '../lib/invoke.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

/** Stub webServer/webRuntime/connection so the bundle's RPC mount effect runs
 * (the smoke-boot pattern — the client-graph server half). */
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

/** The REAL dev-profile composition subset (the smoke-boot pattern — SAME
 * order as the profile bundles array): the harness rows + dshd-core + the 6 P1
 * packages + dshd-orchestration (BETWEEN the P1 rows and the bundle — the
 * provider row) + the bundle. dshd-orchestration provides the DEFAULT
 * deepartments.execRoots service; the bundle registers the tools deps into the
 * `deepartments.toolsDeps` holder and consumes the tools surface service-first. */
async function smokeBoot(stateDir, { org = { departments: [] } } = {}) {
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
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  // The PROVIDER row — IN THE REAL ORDER (dshd-core → … → dshd-orchestration →
  // the bundle): it provides the DEFAULT policy services dshd-orchestration
  // owns (deepartments.execRoots / deepartments.pacing).
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return { root, loader, pluginCtx, dispose: () => loaderFiber.dispose() }
}

// --- the department the resolution drives (a REAL org id, no workspacePath —
// the composition has no workspaceRegistry service, so the dept cwd falls to
// the repoRoot floor — same as the tools-factory E2). -----------------------
const DEPARTMENT = { id: 'internal-programming', name: 'Internal Programming', roomId: 'room-ipd' }

test('execroots-service-repro (composed real order): the DEFAULT deepartments.execRoots service is FUNCTIONAL in the dshd-core → dshd-orchestration → bundle composition — resolveAllowedRoots resolves the root set, the dept_exec guard predicates enforce inside=fine / outside=denied + stable protected, and the ToolsSurface execRoots member (the guard path the default binds) resolves the same set (RED without the 0.2.2-1 hotfix: «execRoots.resolveAllowedRoots is not a function»)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-execroots-repro-'))
  try {
    const { pluginCtx, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] } })
    try {
      const ctx = pluginCtx()
      const stateDirReal = await realpath(stateDir)

      // 1 — the DEFAULT service resolves in the REAL composition order (the
      // dshd-orchestration row between the P1 rows and the bundle).
      const execRootsSvc = ctx.get('deepartments.execRoots')
      assert.ok(execRootsSvc !== undefined, 'deepartments.execRoots resolves (dshd-orchestration provides the DEFAULT policy service in the real profile order)')
      assert.equal(typeof execRootsSvc.resolveAllowedRoots, 'function', 'the default execRoots service exposes a FUNCTIONAL resolveAllowedRoots (a policy surface)')

      // 2 — THE BUG (RED expectation documented): calling it must RESOLVE. On
      // the 0.2.2 code this await rejects with
      //   TypeError: execRoots.resolveAllowedRoots is not a function
      // (index.ts:308 reads the ToolsSurface.execRoots member — the RAW
      // resolver function — and calls .resolveAllowedRoots ON it). After the
      // hotfix it resolves to the same default root set the tools compute
      // inline: the fixed DEPT_EXEC_DEFAULT_ROOTS + the runtime stateDir + the
      // repo root (realpath'd).
      const roots = await execRootsSvc.resolveAllowedRoots({ id: DEPARTMENT.id })
      assert.ok(Array.isArray(roots), 'resolveAllowedRoots through the composed DEFAULT resolves the roots array')
      for (const def of DEPT_EXEC_DEFAULT_ROOTS) {
        assert.ok(roots.includes(def), `the fixed default root "${def}" is present in the resolved set (the default computation parity)`)
      }
      assert.ok(roots.includes(stateDirReal), 'the runtime stateDir is an allowed root (realpath-resolved)')
      assert.ok(roots.includes(REPO_ROOT), 'the repo root is an allowed root (the default computation)')

      // 3 — the dept_exec GUARD predicates on the RESOLVED set (the SAME
      // deptExecDenyReason the tool runs at tools.ts:1216): inside=fine …
      assert.equal(deptExecDenyReason('echo hello', stateDirReal, roots), undefined, 'an in-root cwd + benign command is ALLOWED (inside=fine)')
      // … outside=denied (an absolute cwd NOT inside any allowed root) …
      assert.ok(deptExecDenyReason('ls', '/etc', roots) !== undefined, 'an out-of-root absolute cwd is DENIED (outside=denied — the cwd containment guard)')
      // … and the STABLE home stays PROTECTED (this composition has NO
      // missionExecRoots grant — the default set never includes /opt/dsh/.dsh).
      assert.ok(deptExecDenyReason('ls /opt/dsh/.dsh', stateDirReal, roots) !== undefined, 'the stable profile /opt/dsh/.dsh stays DENIED (no mission-level grant in the default set — the protected-token guard)')

      // 4 — the DEEPEST reachable chain: the ToolsSurface `execRoots` member
      // through the lazy `deepartments.tools` service — the SAME closure the
      // default service binds and the SAME computation the dept_exec/
      // dept_zstd_read guards run (tools.ts:1241/1305). On the 0.2.2 code this
      // ALSO rejects (the surface exported the service-first wrapper — the
      // wrapper's service read lands back on the default and the default's
      // member call throws the shape TypeError).
      const toolsSvc = ctx.get('deepartments.tools')
      assert.ok(toolsSvc !== undefined, 'deepartments.tools resolves (the lazy ToolsSurface service)')
      const surfaceRoots = await toolsSvc.execRoots({ id: DEPARTMENT.id })
      assert.ok(Array.isArray(surfaceRoots), 'the ToolsSurface.execRoots member resolves the roots array (the acyclic default computation)')
      assert.ok(surfaceRoots.includes(stateDirReal), 'the surface member carries the runtime stateDir (the same default set)')
      assert.ok(surfaceRoots.includes(REPO_ROOT), 'the surface member carries the repo root (the same default set)')
      // The in-root guard passes on the surface-resolved set too (the parity
      // between the service path and the guard path the fix restored).
      assert.equal(deptExecDenyReason('echo hello', stateDirReal, surfaceRoots), undefined, 'the in-root guard passes on the surface-resolved set (service/public path parity)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})