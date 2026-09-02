// dsh-deepartments — P7 GROWTH-WITHOUT-FORK test (LANE 0.2.3, TOTAL MODULARITY
// gap 3 — "crecer = añadir plugins, sin fork"). The policy-substitution test
// (P4) proved a composed plugin can SUBSTITUTE a policy service; P7 proves the
// GROWTH direction: a NEW plugin-fixture (test/fixtures/p7-feature-plugin.js)
// ADDS a service/role the org did not have — `deepartments.deptRoles` — by
// PATCH (a loader row composed BETWEEN dshd-orchestration and the bundle),
// with ZERO edits to the bundle, dshd-core or any existing consumer.
//
// Asserts (the P7 criterion, harness level — the real dump-config layer is the
// host's ladder):
//   (a) the NEW service resolves via ctx.get — the key exists ONLY because the
//       plugin was composed (pure addition; RED without the fixture);
//   (b) FUNCTIONAL resolution: roleTemplateFor('security-auditor') resolves a
//       MATERIALIZABLE role descriptor against an EXISTING repo template
//       (reuse, never fork — the department-as-plugin pattern);
//   (c) the plugin LAYER is present in the loader composition (the harness
//       equivalent of a `# == deepartments-p7-feature-plugin` dump-config
//       layer);
//   (d) coexistence: the bundle boots GREEN with the fixture composed and its
//       own existing services (deepartments.spawn) still resolve — growing
//       never breaks the tree.
// The BUNDLE SOURCE IS NOT TOUCHED — the fixture only provides; the bundle only
// consumes what it already consumes. Hermetic: temp stateDir; dispose clears.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

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

/** Resolve a loader row by id WITHOUT throwing for an un-composed row (the
 * loader's `resolve` throws "cannot resolve entry <id>" for an absent row —
 * the RED assertion needs the ABSENT case to be assertable). */
const resolveRowSafe = (loader, id) => { try { return loader.resolve(id) } catch { return undefined } }

/** The dev-profile composition + the P7 fixture row (BETWEEN dshd-orchestration
 * and the bundle — the exact "mount a plugin by patch" shape). `withFixture:
 * false` composes the SAME composition WITHOUT the fixture row (the TDD RED
 * shape: the key must NOT resolve). */
async function bootWithFixture(stateDir, { withFixture = true } = {}) {
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
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  // The P7 plugin-fixture row (the growth it proves: the org grows by ADDING
  // this row — the only way `deepartments.deptRoles` comes to exist).
  if (withFixture) {
    loader.create({ id: 'p7-feature-plugin', name: new URL('./fixtures/p7-feature-plugin.js', import.meta.url).href, config: {} })
  }
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org: { departments: [] } } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return { root, loader, pluginCtx, dispose: () => loaderFiber.dispose() }
}

test('P7 (growth without fork): the composed p7 FEATURE PLUGIN (patch row) ADDS a NEW service — deepartments.deptRoles resolves by ctx.get with the new key, the plugin LAYER is in the loader composition, the bundle coexists GREEN and its own services still resolve (0 bundle edits)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-p7-'))
  try {
    const { loader, pluginCtx, dispose } = await bootWithFixture(stateDir)
    try {
      const ctx = pluginCtx()
      // (a) The NEW service key resolves — it exists ONLY because the plugin
      // row was composed (pure addition; the bundle/core surfaces never
      // declared it).
      const deptRoles = ctx.get('deepartments.deptRoles')
      assert.ok(deptRoles !== undefined && typeof deptRoles.roleTemplateFor === 'function', 'deepartments.deptRoles resolves with roleTemplateFor (the plugin-provided NEW service)')
      // (c) The plugin LAYER is present in the composition (the harness-level
      // dump-config layer equivalent — the host verifies the real
      // `# == deepartments-p7-feature-plugin` in its ladder).
      assert.ok(resolveRowSafe(loader, 'p7-feature-plugin') !== undefined, 'the p7-feature-plugin row is composed (the layer is visible in the loader)')
      // (b) FUNCTIONAL resolution: the plugin-declared role materializes
      // against an EXISTING repo template (reuse, never fork).
      const template = await deptRoles.roleTemplateFor('security-auditor')
      assert.ok(template !== undefined, 'roleTemplateFor resolves the NEW role descriptor')
      assert.equal(template.id, 'security-auditor', 'the resolved role id is the plugin-declared role')
      assert.ok(template.path !== undefined && existsSync(template.path), `the resolved role is MATERIALIZABLE (its template file exists: ${template.path})`)
      assert.ok(template.persona !== undefined && template.persona.length > 0, 'the resolved role carries a persona (spawnable)')
      assert.ok(template.title === 'Security Auditor', 'the resolved role carries a human title')
      assert.equal(deptRoles.roleTemplateFor('research'), undefined, 'the plugin shadows NO existing role (pure addition)')
      // (d) Coexistence: the bundle + the existing services resolve exactly as
      // WITHOUT the plugin (a growing tree never breaks).
      assert.ok(ctx.get('deepartments.spawn') !== undefined, 'deepartments.spawn still resolves (the orchestration service coexists with the plugin)')
      assert.ok(ctx.get('deepartments.org') !== undefined && ctx.get('deepartments.org').stateDir === stateDir, 'deepartments.org still resolves from dshd-core (the shared source untouched)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('P7 (TDD RED guard): WITHOUT the fixture row the key does NOT resolve — deepartments.deptRoles is ABSENT from the bundle/core/orchestration surfaces (the plugin is the ONLY way the org grows it)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-p7-red-'))
  try {
    const { loader, pluginCtx, dispose } = await bootWithFixture(stateDir, { withFixture: false })
    try {
      const ctx = pluginCtx()
      // RED: the service key does not exist (the bundle booted fine without
      // it — the growth contract: adding the plugin is a pure addition).
      assert.equal(ctx.get('deepartments.deptRoles'), undefined, 'deepartments.deptRoles does NOT resolve without the p7 fixture (the key is a pure plugin addition)')
      assert.equal(resolveRowSafe(loader, 'p7-feature-plugin'), undefined, 'the p7-feature-plugin row is NOT composed without the fixture (no layer)')
      // The bundle still boots + works (coexistence baseline).
      assert.ok(ctx.get('deepartments.spawn') !== undefined, 'the bundle baseline services still resolve (RED composition is healthy)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})