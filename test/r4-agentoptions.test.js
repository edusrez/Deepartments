// dsh-deepartments — R4 test (LANE 0.2.3 — providers → org config): the presets
// surface resolves WORKER_AGENT_OPTIONS / HOST_AGENT_OPTIONS ORG-DRIVEN —
// org.workerAgentOptions / org.hostAgentOptions when the org declares them (the
// SHARED config source), the code literals otherwise (movement-only for every
// consumer: spawn/tools/delivery read the SAME surface members). The same
// composed boot shape as smoke-boot (dshd-core + 6 P1 + dshd-orchestration +
// bundle). Hermetic: temp stateDir; dispose clears.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
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

/** The dev-profile composition (the smoke-boot shape) with a custom org. */
async function bootWithOrg(stateDir, org) {
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
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return { pluginCtx, dispose: () => loaderFiber.dispose() }
}

test('R4 (providers → org config): org.workerAgentOptions / org.hostAgentOptions RESOLVE ORG-DRIVEN — the presets surface returns the org-declared route (a distinguishable probe model) as WORKER_AGENT_OPTIONS / HOST_AGENT_OPTIONS (the consumers see the ORG route, not the code literal)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-r4-'))
  try {
    const org = {
      departments: [],
      // A DISTINGUISHABLE probe route: if the surface returned the code
      // literal (deepseek-v4-flash) the asserts below fail — the org-driven
      // read is the point being proven.
      workerAgentOptions: { provider: 'opencode-zen', model: 'deepseek-v4-flash-r4-worker-probe', reasoningEffort: 'max' },
      hostAgentOptions: { provider: 'opencode-zen', model: 'deepseek-v4-flash-r4-host-probe', reasoningEffort: 'max' }
    }
    const { pluginCtx, dispose } = await bootWithOrg(stateDir, org)
    try {
      const presets = pluginCtx().get('deepartments.presets')
      assert.ok(presets !== undefined, 'deepartments.presets resolves (the orchestration factory surface)')
      assert.equal(presets.WORKER_AGENT_OPTIONS.model, 'deepseek-v4-flash-r4-worker-probe', 'WORKER_AGENT_OPTIONS resolves the ORG-DECLARED worker route (org.workerAgentOptions wins over the code literal)')
      assert.equal(presets.WORKER_AGENT_OPTIONS.provider, 'opencode-zen', 'the org-declared worker provider is resolved')
      assert.equal(presets.HOST_AGENT_OPTIONS.model, 'deepseek-v4-flash-r4-host-probe', 'HOST_AGENT_OPTIONS resolves the ORG-DECLARED host route (org.hostAgentOptions wins over the code literal)')
      // The materializePost fallback follows the ORG-resolved worker route.
      assert.equal(presets.resolveMaterializeAgentOptions({}).model, 'deepseek-v4-flash-r4-worker-probe', 'resolveMaterializeAgentOptions falls back to the ORG-RESOLVED worker route')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('R4 (providers → org config): an org WITHOUT the R4 fields falls back to the CODE literals (deepseek-v4-flash both — the runtime truth; the pre-R4 vision-exp host literal is GONE) — the compose-untouched contract', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-r4-default-'))
  try {
    const { pluginCtx, dispose } = await bootWithOrg(stateDir, { departments: [] })
    try {
      const presets = pluginCtx().get('deepartments.presets')
      assert.equal(presets.WORKER_AGENT_OPTIONS.model, 'deepseek-v4-flash', 'absent org.workerAgentOptions → the code literal (deepseek-v4-flash)')
      assert.equal(presets.HOST_AGENT_OPTIONS.model, 'deepseek-v4-flash', 'absent org.hostAgentOptions → the code literal (deepseek-v4-flash — the runtime truth; NO vision-exp anywhere)')
      assert.equal(presets.WORKER_AGENT_OPTIONS.reasoningEffort, 'max', 'the code-default reasoning effort is max')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})