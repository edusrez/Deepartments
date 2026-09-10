// dsh-deepartments — MPC-PREFLIGHT tests (lane IPD; spec CONGELADA del QD:
// .dsh/reports/quality/2026-09-10-incidente-congelacion-modelo-prevencion.md
// §4.2). Guard de coherencia PINES (P1..P4 + P6 read-only) ↔ CATÁLOGO VIVO:
// pre-flight de deploy BLOQUEANTE, write-guard del catálogo subtractivo, puerta
// de boot DEGRADED (jamás un ok silencioso) y el punto de materialización
// create/resume con el retrofit del handle stale (fb-332/P5).
//
// HERMÉTICO: cada caso corre sobre fixtures en mkdtemp — NUNCA el home vivo
// (A6: el guard no escribe settings.yaml, no auto-restaura legacy, no
// reinicia). Los módulos ejecutados son los compilados del paquete
// (pnpm build && pnpm -r build antes de la suite — el mismo contrato que el
// resto de la suite lib-based).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { comparePins, comparePinsAgainstCatalogSources, decide, buildCoherenceReport, resolvedStaleHandleVerdict, WORKER_AGENT_OPTIONS, HOST_AGENT_OPTIONS } from 'dshd-orchestration/model-pins'
import { runMpcPreflight, runMpcPreflightSync, staticCatalogFromSettingsYaml, resolveModelPins, readOrgPinsFromPatch, readLiteralPinsFromFile, subtractiveRetirement, renderRunReport, MPC_PREFLIGHT_STATE_FILE, MPC_PREFLIGHT_POST_ID, resolveGuardMode } from 'dshd-orchestration/model-pins-runner'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI = path.join(REPO_ROOT, 'scripts', 'mpc-preflight.mjs')
const PRESETS_TS = path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'model-pins.ts')
const LIVE_POOLER_CONFIG = '/home/esuarez/projects/dsh-key-pooler/lib/config.js'

// --- fixtures -----------------------------------------------------------------

/** El HOME de fixture + su CATÁLOGO SUPLIDO (F5, gate unit-2): el pre-flight
 * exige LAS DOS mitades — la estática (settings.yaml) Y la del adapter vivo
 * (`llm` in-process o `--catalog <json>`). Un fixture que sólo pasa
 * `paths.settingsYaml` describe una composición SIN la mitad runtime, y esa
 * composición DEBE bloquear (es el gate que desbloquea el deploy); por eso los
 * run gates de este fichero declaran además su fuente suplida, igual que hace el
 * CLI con `--catalog`. El catálogo suplido se construye con el MISMO parser real
 * (`staticCatalogFromSettingsYaml`), sólo con su propio id. */
function suppliedCatalogFromYaml(settingsPath, id = 'fixture-catalog') {
  const staticRead = staticCatalogFromSettingsYaml(settingsPath)
  return { id, providers: staticRead.providers }
}

/** El catálogo vivo de un org SANO **aditivo-antes-de-retirar**: el id nuevo Y
 * el legacy cuyo pin sigue desplegado (por eso el pre-flight PASA y sólo el
 * write-guard subtractivo lo rechaza). */
const SETTINGS_COVERED = `agent-default-model:
  provider: opencode-zen
  model: deepseek-flash
  reasoningEffort: max
llm-pi-ai:
  providers:
    opencode-zen:
      apiKeyEnv: OPENCODE_GO_KEY_6
      api: openai-completions
      baseURL: http://127.0.0.1:4097/v1
      models:
        - id: deepseek-flash
          name: DeepSeek V4.1 Flash
        - id: deepseek-v4-legacy-phantom
          name: Legacy (still pinned by the deployed rows)
`

/** EL ESTADO CAÍDO DEL 09-10 — exactamente la escritura subtractiva que congeló
 * el org: el catálogo ya NO tiene el id legacy, pero el pin desplegado sí. */
const SETTINGS_SUBTRACTIVE = `agent-default-model:
  provider: opencode-zen
  model: deepseek-flash
  reasoningEffort: max
llm-pi-ai:
  providers:
    opencode-zen:
      apiKeyEnv: OPENCODE_GO_KEY_6
      api: openai-completions
      baseURL: http://127.0.0.1:4097/v1
      models:
        - id: deepseek-flash
          name: DeepSeek V4.1 Flash
`

/** El pin fila-a-fila de un ORG desplegado (P1/P2/P3): el legacy es el pin. */
const PATCH_LEGACY_PIN = `org:
  departments:
    - id: internal-programming
      coordinator:
        postId: internal-programming-head
        role: Internal Programming department head
        provider: opencode-zen
        agentOptions:
          provider: opencode-zen
          model: deepseek-v4-legacy-phantom
          reasoningEffort: max
  workerAgentOptions:
    provider: opencode-zen
    model: deepseek-v4-legacy-phantom
    reasoningEffort: max
  hostAgentOptions:
    provider: opencode-zen
    model: deepseek-v4-legacy-phantom
    reasoningEffort: max
`
function fixtureDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mpc-preflight-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Un HOME de fixture: settings.yaml + .agent-presets/**. */
function makeHome(t, settingsText) {
  const home = fixtureDir(t)
  writeFileSync(path.join(home, 'settings.yaml'), settingsText, 'utf8')
  return home
}

/**
 * El CATÁLOGO SUPLIDO del fixture (F5, gate unit-2): el pre-flight exige LAS DOS
 * mitades — la estática (settings.yaml) Y la del adapter vivo (`llm` in-process o
 * `--catalog <json>`). Un fixture que sólo pasa `paths.settingsYaml` describe una
 * composición SIN la mitad runtime, y esa composición DEBE bloquear: por eso
 * todos los run gates de este fichero declaran su catálogo, igual que hace el
 * CLI con `--catalog`.
 */
function catalogSourceFor(settingsText, id = 'fixture-catalog') {
  const parsed = parseLlmPiAiProviderSettings(settingsText)
  const providers = {}
  for (const [provider, profile] of Object.entries(parsed)) {
    providers[provider] = { models: [...(profile.modelIds ?? [])], registered: true }
  }
  return { id, providers }
}

/** El mismo catálogo, leído del settings.yaml de un home de fixture. */
function catalogSourceFromYaml(settingsPath) {
  return catalogSourceFor(readFileSync(settingsPath, 'utf8'))
}

/** Un preset live con un pin ESTRUCTURADO (agentOptions) — la forma que el
 * guard enumera para P4. */
function addPresetPin(home, presetId, { provider, model }) {
  const dir = path.join(home, '.agent-presets', presetId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'agent.cordis.yml'), `- id: some-row
  name: 'dsh-deepartments/some'
  config:
    agentOptions:
      provider: ${provider}
      model: ${model}
`, 'utf8')
}

/**
 * LA PUERTA REAL de boot (F4, 2ª pasada — el punto que el fixture con catálogo
 * suplido NO PODÍA representar): el `registerMpcBootPinCoherenceGate` del módulo
 * de arranque COMPILADO — el mismo que el bundle ejecuta — con su wiring real,
 * que corre `runMpcPreflightSync` **SIN `catalogSources`**. La vía del boot es
 * SÍNCRONA por diseño (una promesa que aterrice tras el dispose escribiría en un
 * stateDir retirado), así que suple catálogo NUNCA ⇒ `runtimeCatalogConsulted`
 * es `false` SIEMPRE y el flag `degraded` es una constante. Un test que pasa
 * `catalogSources` apaga justo esa constante: mide una composición que
 * producción no usa (clase R8 del gate anterior).
 *
 * `process.env.DSH_HOME` es la ÚNICA entrada del home en esta puerta (igual que
 * en el arranque real): se fija y se restaura.
 */
async function runRealBootGate({ home, stateDir, org = {}, hosts, agents }) {
  const { registerMpcBootPinCoherenceGate } = await import('../packages/dshd-orchestration/lib/boot.js')
  const logs = { info: [], warn: [] }
  const ctx = { logger: { info: (line) => logs.info.push(String(line)), warn: (line) => logs.warn.push(String(line)) } }
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const loaded = Promise.resolve()
    registerMpcBootPinCoherenceGate(ctx, loaded, {
      stateDir,
      org,
      ...(hosts !== undefined ? { hosts } : {}),
      ...(agents !== undefined ? { agents } : {})
    })
    await loaded
    // `hostsLoaded.then(run)` es síncrono dentro del microtask; el setImmediate
    // garantiza que la puerta terminó antes de leer los efectos en disco.
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  return logs
}

/** Un host VIVO de fixture (la forma del registro real: sesión + handle) con su
 * `followup` capturador — el mismo seam que la fábrica inyecta por
 * `options.hosts`/`options.agents`. */
function liveHostFixture(sessionId = 'host-session-fixture-live') {
  const delivered = []
  return {
    delivered,
    hosts: { values: () => [{ hostId: 'host-fixture', sessionId, retired: false }] },
    agents: { get: (id) => (id === sessionId ? { followup: (message) => { delivered.push(message) } } : undefined) }
  }
}

// --- A1: comparador puro, los 6 casos del §4.2 --------------------------------

test('MPC-PREFLIGHT A1(a): a covered pin is ok — the invariant holds', () => {
  const catalog = { id: 'fixture', providers: { 'opencode-zen': { models: ['deepseek-flash'], registered: true } } }
  const verdict = comparePins([{ provider: 'opencode-zen', model: 'deepseek-flash', source: { tramo: 'P3', class: 'code-constant', ref: 'model-pins.ts' } }], catalog)[0]
  assert.equal(verdict.kind, 'ok')
})

test('MPC-PREFLIGHT A1(b): a SUBTRACTIVE catalog with a deployed pin => unknown-model (the 09-10 class)', () => {
  const pin = { provider: 'opencode-zen', model: 'deepseek-v4-flash', source: { tramo: 'P3', class: 'code-constant', ref: 'model-pins.ts WORKER_AGENT_OPTIONS' } }
  const catalog = { id: 'settings-yaml', providers: { 'opencode-zen': { models: ['deepseek-flash'], registered: true } } }
  const verdict = comparePins([pin], catalog)[0]
  assert.equal(verdict.kind, 'unknown-model')
  assert.match(verdict.detail, /NOT in the live catalog/)
})

test('MPC-PREFLIGHT A1(c): the OPPOSITE direction (pin ahead of the catalog) also blocks', () => {
  // fb-42 C0: el código ya pinnea el id nuevo y el adapter aún no lo tiene.
  const pin = { provider: 'opencode-zen', model: 'glm-5.3-flash', source: { tramo: 'P1', class: 'agent-default-model', ref: 'settings.yaml agent-default-model' } }
  const catalog = { id: 'settings-yaml', providers: { 'opencode-zen': { models: ['deepseek-v4-flash'], registered: true } } }
  const report = buildCoherenceReport({ pins: [pin], sources: [catalog], phase: 'deploy-preflight' })
  assert.equal(report.decision, 'blocked')
  assert.equal(report.missing.length, 1)
})

test('MPC-PREFLIGHT A1(d): an unregistered provider is the SEPARATE NO_ADAPTER class (warning, never C1)', () => {
  const pin = { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', source: { tramo: 'P6', class: 'twin-profile', ref: 'profiles/x/cordis.patch.yml' } }
  const catalog = { id: 'settings-yaml', providers: { 'opencode-zen': { models: ['deepseek-flash'], registered: true } } }
  const report = buildCoherenceReport({ pins: [pin], sources: [catalog], phase: 'deploy-preflight' })
  // el provider NO está declarado en la fuente ⇒ 'unknown' (evidencia ausente),
  // NO un unknown-model (el bloqueo por subclase C1 exige evidencia POSITIVA).
  assert.equal(report.missing.length, 0)
  assert.equal(report.unverifiable.length, 1)
  // y cuando la fuente SÍ lo declara sin registro, es NO_ADAPTER (aviso).
  const declaredNoAdapter = { id: 'dump-config', providers: { 'deepseek-official': { models: [], registered: false } } }
  const verdict = comparePins([pin], declaredNoAdapter)[0]
  assert.equal(verdict.kind, 'NO_ADAPTER')
  const report2 = buildCoherenceReport({ pins: [pin], sources: [declaredNoAdapter], phase: 'deploy-preflight' })
  assert.equal(report2.decision, 'allow')
  assert.equal(report2.noAdapter.length, 1)
})

test('MPC-PREFLIGHT A1(e): a missing llm surface is warn + DEGRADED at boot — NEVER a silent ok', () => {
  const pin = { provider: 'opencode-zen', model: 'deepseek-flash', source: { tramo: 'P3', class: 'code-constant', ref: 'model-pins.ts' } }
  const verdict = comparePins([pin], undefined)[0]
  assert.equal(verdict.kind, 'unknown')
  const boot = buildCoherenceReport({ pins: [pin], sources: [], phase: 'boot' })
  assert.equal(boot.decision, 'degraded', 'an absent surface must NEVER produce an implicit ok')
  assert.match(boot.message, /DEGRADED/)
  // y en el pre-flight de deploy, sin fuente estática, BLOQUEA (fail-loud).
  const deploy = buildCoherenceReport({ pins: [pin], sources: [], phase: 'deploy-preflight' })
  assert.equal(deploy.decision, 'blocked')
  assert.match(deploy.message, /fail-loud, never fail-open/)
})

test('MPC-PREFLIGHT A1(f): a STALE handle (P5) resolves to the current pin — never keyed on the sessionId birth date', () => {
  const catalog = { id: 'settings-yaml', providers: { 'opencode-zen': { models: ['deepseek-flash'], registered: true } } }
  const currentPin = { provider: 'opencode-zen', model: 'deepseek-flash', source: { tramo: 'P2', class: 'org.workerAgentOptions', ref: 'org.workerAgentOptions' } }
  const verdict = resolvedStaleHandleVerdict({
    handleOptions: { provider: 'opencode-zen', model: 'deepseek-v4-flash' },
    currentPin,
    catalog,
    source: { tramo: 'P1', class: 'resolved-session-route', ref: 'session log request/header' }
  })
  assert.equal(verdict?.kind, 'retrofitted')
  assert.equal(verdict?.retrofitModel, 'deepseek-flash')
  // REQUISITO DURO §P5: el sujeto es el par (provider, model) RESUELTO POR
  // SESIÓN — la función no recibe NI LEE ningún timestamp/sessionId, así que
  // un head longevo con sessionId pre-fix y route sano NO puede dar un FP.
  const healthy = resolvedStaleHandleVerdict({
    handleOptions: { provider: 'opencode-zen', model: 'deepseek-flash' },
    currentPin,
    catalog,
    source: { tramo: 'P1', class: 'resolved-session-route', ref: 'session log request/header' }
  })
  assert.equal(healthy, undefined, 'a live head whose RESOLVED route is covered is never flagged')
})

// --- A2: fixtures reales P1–P4 + contrato de sensibilidad ---------------------

test('MPC-PREFLIGHT A2(a): the REAL fixtures (P1 agent-default-model + P2 coordinator rows/org routes + P3 code constants + P4 live preset) are enumerated and compared', async (t) => {
  const home = makeHome(t, SETTINGS_COVERED)
  addPresetPin(home, 'deepartments-worker', { provider: 'opencode-zen', model: 'deepseek-flash' })
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const result = await runMpcPreflight({
    mode: 'deploy',
    paths: { settingsYaml: path.join(home, 'settings.yaml'), agentPresetsDir: path.join(home, '.agent-presets') },
    catalogSources: [suppliedCatalogFromYaml(path.join(home, 'settings.yaml'))],
    patches: [patch]
  })
  const tramos = new Set(result.report.verdicts.map((v) => v.pin.source.tramo))
  assert.ok(tramos.has('P1'), 'agent-default-model (P1) must be enumerated')
  assert.ok(tramos.has('P2'), 'coordinator rows / org routes (P2) must be enumerated')
  assert.ok(tramos.has('P3'), 'the code constants (P3) must be enumerated')
  assert.ok(tramos.has('P4'), 'the live presets (P4) must be enumerated')
  // El fixture es el catálogo ADITIVO-ANTES-DE-RETIRAR: el id legacy sigue
  // admitido ⇒ el pre-flight PASA (la retirada sólo la rechaza el write-guard).
  assert.equal(result.decision, 'allow')
  const p2 = result.report.verdicts.filter((v) => v.pin.source.tramo === 'P2')
  assert.ok(p2.length >= 3, `the coordinator pin + the two org routes must be enumerated (got ${p2.length})`)
  assert.ok(p2.every((v) => v.kind === 'ok'))
  assert.ok(p2.every((v) => v.pin.source.ref.includes('cordis.patch.yml')))
})

test('MPC-PREFLIGHT A2(b): SENSIBILITY CONTRACT — rotating a literal in the guard constants without touching the catalog makes the guard FAIL', async (t) => {
  const home = makeHome(t, SETTINGS_COVERED)
  const settingsPath = path.join(home, 'settings.yaml')
  const before = await runMpcPreflight({ mode: 'deploy', paths: { settingsYaml: settingsPath }, catalogSources: [suppliedCatalogFromYaml(settingsPath)] })
  assert.equal(before.decision, 'allow')
  // Rotar el literal de la CONSTANTE (el equivalente exacto de editar
  // model-pins.ts sin rotar el catálogo): el guard debe FALLAR.
  const original = WORKER_AGENT_OPTIONS.model
  try {
    WORKER_AGENT_OPTIONS.model = 'glm-5.3-phantom'
    const after = await runMpcPreflight({ mode: 'deploy', paths: { settingsYaml: settingsPath }, catalogSources: [suppliedCatalogFromYaml(settingsPath)] })
    assert.equal(after.decision, 'blocked', 'a rotated literal with an unchanged catalog MUST fail the guard')
    assert.ok(after.report.missing.some((v) => v.pin.model === 'glm-5.3-phantom'))
  } finally {
    WORKER_AGENT_OPTIONS.model = original
  }
})

test('MPC-PREFLIGHT A2(c): SENSIBILITY on the REAL SOURCE FILE — rotating the literal in presets-in-tree model-pins.ts trips the guard', (t) => {
  // El fichero real se COPIA a un sandbox y se rota un literal; el test prueba
  // que la constante canónica que el guard importa es la del árbol (cero drift
  // por literales duplicados: si alguien edita el literal y no el catálogo, el
  // contrato de sensibilidad lo caza).
  const realSource = readFileSync(PRESETS_TS, 'utf8')
  assert.match(realSource, /model: 'deepseek-flash'/, 'the canonical constant must hold the current fleet id')
  const rotated = realSource.replace(/model: 'deepseek-flash'/, "model: 'glm-5.3-phantom'")
  assert.notEqual(rotated, realSource, 'the rotation must actually change a literal in the source')
  const sandbox = fixtureDir(t)
  const sandboxFile = path.join(sandbox, 'model-pins.ts')
  writeFileSync(sandboxFile, rotated, 'utf8')
  assert.match(readFileSync(sandboxFile, 'utf8'), /glm-5\.3-phantom/)
  // Y el comparador puro, sobre la constante rotada, FALLA contra el catálogo
  // real del fixture (la prueba semántica del contrato).
  const catalog = staticCatalogFromSettingsYaml(joinFixture(t, SETTINGS_COVERED))
  const rotatedConstant = { provider: 'opencode-zen', model: 'glm-5.3-phantom', source: { tramo: 'P3', class: 'code-constant', ref: 'model-pins.ts WORKER_AGENT_OPTIONS' } }
  const verdict = comparePins([rotatedConstant], { id: catalog.id, providers: catalog.providers })[0]
  assert.equal(verdict.kind, 'unknown-model')
})

function joinFixture(t, settingsText) {
  const home = makeHome(t, settingsText)
  return path.join(home, 'settings.yaml')
}

test('MPC-PREFLIGHT A2(d): the coordinator/org rows of the ACTIVE profile patch are read (P2) with their file:line provenance', (t) => {
  const home = fixtureDir(t)
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const read = readOrgPinsFromPatch(patch)
  assert.equal(read.pins.length, 3, 'one coordinator agentOptions + org.workerAgentOptions + org.hostAgentOptions')
  for (const pin of read.pins) assert.equal(pin.source.tramo, 'P2')
  assert.equal(read.org?.workerAgentOptions?.model, 'deepseek-v4-legacy-phantom')
  assert.ok(read.pins.every((pin) => pin.source.ref.includes('cordis.patch.yml')))
})

// --- A3: simulación del incidente — BLOQUEO sin boot nuevo --------------------

test('MPC-PREFLIGHT A3: the 09-10 incident is reproduced — the deploy pre-flight ABORTS (exit != 0) and NOTHING restarts', (t) => {
  const home = makeHome(t, SETTINGS_SUBTRACTIVE)
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const stateDir = path.join(home, 'state')
  const bootMarker = path.join(stateDir, 'boot-crash.json')
  // La evidencia DURA de que NO se ejecuta un boot nuevo: sellamos el estado de
  // arranque y comprobamos que sigue byte-idéntico tras el gate.
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(bootMarker, JSON.stringify({ bootId: 'fixture-boot', seq: 1 }, null, 2) + '\n', 'utf8')
  const before = readFileSync(bootMarker, 'utf8')
  let exitCode = 0
  let stdout = ''
  try {
    stdout = execFileSync('node', [CLI, 'deploy', '--dsh-home', home, '--state-dir', stateDir], { encoding: 'utf8' })
  } catch (error) {
    exitCode = error.status ?? 1
    stdout = String(error.stdout ?? '')
  }
  assert.notEqual(exitCode, 0, 'a violated I-MP must abort with exit != 0')
  assert.match(stdout, /decision=blocked/)
  assert.match(stdout, /MISSING opencode-zen\/deepseek-v4-legacy-phantom/)
  // la línea ACCIONABLE: provider + model + tramo + quién lo fija (§4.2)
  assert.match(stdout, /tramo P[123]/)
  assert.match(stdout, /fixed by /)
  assert.equal(readFileSync(bootMarker, 'utf8'), before, 'the pre-flight must NOT trigger any boot/restart (no new boot recorded)')
  // y el catálogo vivo del home NO se ha tocado (A6 read-only)
  assert.equal(readFileSync(path.join(home, 'settings.yaml'), 'utf8'), SETTINGS_SUBTRACTIVE)
})

test('MPC-PREFLIGHT A3(b): the same gate with the ADDITIVE catalog passes (exit 0) — the ladder is not gated unnecessarily', (t) => {
  const home = makeHome(t, SETTINGS_COVERED)
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const stateDir = path.join(home, 'state')
  // El catálogo del adapter vivo se declara con el PUENTE `--catalog` (la
  // segunda salida legítima del gate F5): sin él —y sin `llm`— el pre-flight
  // BLOQUEA, que es exactamente lo que prueba el test F5 de más abajo.
  const catalogPath = path.join(home, 'catalog.json')
  writeFileSync(catalogPath, JSON.stringify({ id: 'runtime-llm', providers: { 'opencode-zen': { models: ['deepseek-flash', 'deepseek-v4-legacy-phantom'], registered: true } } }), 'utf8')
  const stdout = execFileSync('node', [CLI, 'deploy', '--dsh-home', home, '--state-dir', stateDir, '--catalog', catalogPath], { encoding: 'utf8' })
  assert.match(stdout, /mode=deploy decision=allow/)
  assert.match(stdout, /catalogs=\[settings-yaml, runtime-llm, builtin-adapter\]/)
  assert.match(stdout, /runtimeConsulted=true/)
})

// --- F5 (gate unit-2): la mitad RUNTIME ausente BLOQUEA el deploy --------------

test('MPC-PREFLIGHT F5: without the RUNTIME half —no llm, no --catalog— the deploy pre-flight BLOCKS (exit 2) and the message names BOTH exits', (t) => {
  const home = makeHome(t, SETTINGS_COVERED)
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const stateDir = path.join(home, 'state')
  let exitCode = 0
  let stdout = ''
  try {
    stdout = execFileSync('node', [CLI, 'deploy', '--dsh-home', home, '--state-dir', stateDir], { encoding: 'utf8' })
  } catch (error) {
    exitCode = error.status ?? 1
    stdout = String(error.stdout ?? '')
  }
  assert.equal(exitCode, 2, 'an unconsulted RUNTIME half must BLOCK the deploy (fail-loud, no escape hatch)')
  assert.match(stdout, /decision=blocked/)
  assert.match(stdout, /the RUNTIME half was NOT consulted/)
  // el mensaje nombra LAS DOS salidas (in-process con llm, o --catalog)
  assert.match(stdout, /runMpcPreflight\(\{ llm/)
  assert.match(stdout, /--catalog <json>/)
  // y NO existe un flag de «desplegar con la mitad estática»
  assert.match(stdout, /NO flag to deploy with the static half alone/)
})

test('MPC-PREFLIGHT F5(b) + F5(c): the guard BLOCKS without the runtime half, PASSES with an in-process llm, and reads the `--catalog` bridge (three documented forms)', async (t) => {
  const home = makeHome(t, SETTINGS_COVERED)
  const settingsPath = path.join(home, 'settings.yaml')
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const base = { mode: 'deploy', paths: { settingsYaml: settingsPath }, patches: [patch] }
  // (i) SIN mitad runtime: BLOCKED y —F5b— `degraded:true` durable aunque la
  //     decisión no llegue a 'allow' (la marca viaja con el problema declarado).
  const blocked = await runMpcPreflight({ ...base, stateDir: path.join(home, 'state-no-runtime'), persist: true, now: () => 1789040000000 })
  assert.equal(blocked.decision, 'blocked')
  assert.equal(blocked.degraded, true)
  const mark = JSON.parse(readFileSync(path.join(home, 'state-no-runtime', MPC_PREFLIGHT_STATE_FILE), 'utf8'))
  assert.equal(mark.degraded, true, 'F5b: the durable mark carries degraded:true when the runtime half is missing')
  assert.equal(mark.inputs.runtimeCatalogConsulted, false)
  // (ii) la vía CANÓNICA in-process: la primitiva `llm` (probe R2) ⇒ allow.
  const llm = {
    listProviders: () => [{ id: 'opencode-zen' }],
    listModels: async () => ['deepseek-flash', 'deepseek-v4-legacy-phantom']
  }
  const withLlm = await runMpcPreflight({ ...base, llm })
  assert.equal(withLlm.decision, 'allow')
  assert.equal(withLlm.degraded, false)
  assert.equal(withLlm.inputs.runtimeCatalogConsulted, true)
  // (iii) el puente `--catalog` (forma LiveCatalogSource) ⇒ allow.
  const withCatalog = await runMpcPreflight({ ...base, catalogSources: [{ id: 'runtime-llm', providers: { 'opencode-zen': { models: ['deepseek-flash', 'deepseek-v4-legacy-phantom'], registered: true } } }] })
  assert.equal(withCatalog.decision, 'allow')
  assert.equal(withCatalog.degraded, false)
})

// --- Puerta 2 — write-guard del catálogo SUBTRACTIVO --------------------------

test('MPC-PREFLIGHT gate 2: a subtractive catalog edit that retires a still-pinned id is REJECTED (adding an id is always ok)', async (t) => {
  const home = makeHome(t, SETTINGS_COVERED)
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const stateDir = path.join(home, 'state')
  const candidate = path.join(home, 'settings.candidate.yaml')
  writeFileSync(candidate, SETTINGS_SUBTRACTIVE, 'utf8')
  let exitCode = 0
  let stdout = ''
  try {
    stdout = execFileSync('node', [CLI, 'subtractive', '--dsh-home', home, '--state-dir', stateDir, '--candidate', candidate], { encoding: 'utf8' })
  } catch (error) {
    exitCode = error.status ?? 1
    stdout = String(error.stdout ?? '')
  }
  assert.notEqual(exitCode, 0)
  assert.match(stdout, /REJECTED \(subtractive catalog edit\)/)
  assert.match(stdout, /opencode-zen\/deepseek-v4-legacy-phantom/)
  // el fichero RETIRADO es exactamente el id aún referenciado por un pin
  const read = subtractiveRetirement({ currentSettingsText: SETTINGS_COVERED, candidateSettingsText: SETTINGS_SUBTRACTIVE, pins: readOrgPinsFromPatch(patch).pins })
  assert.deepEqual(read, ['opencode-zen/deepseek-v4-legacy-phantom'])
  // un candidato que AÑADE un id nunca se retira (aditiva-first)
  const additive = SETTINGS_COVERED.replace('        - id: deepseek-v4-legacy-phantom', '        - id: deepseek-v4-legacy-phantom\n        - id: deepseek-v4-pro')
  assert.deepEqual(subtractiveRetirement({ currentSettingsText: SETTINGS_COVERED, candidateSettingsText: additive, pins: readOrgPinsFromPatch(patch).pins }), [])
  assert.notEqual(additive, SETTINGS_COVERED)
})

// --- Puerta 3 — BOOT: DEGRADED + finding durable, nunca un ok silencioso ------

test('MPC-PREFLIGHT gate 3: the boot gate writes a DURABLE finding (channel shape) + the DEGRADED mark, DELIVERS the alert to the host and NEVER blocks the boot', async (t) => {
  const home = makeHome(t, SETTINGS_SUBTRACTIVE)
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const stateDir = path.join(home, 'state')
  // F3 (gate unit-2): la ENTREGA se asserta como una LLAMADA REAL al sink, no
  // como un campo auto-declarado de la fila. El sink es exactamente el seam que
  // el wiring de boot (boot.ts, registerMpcBootPinCoherenceGate) inyecta.
  const delivered = []
  const result = await runMpcPreflight({
    mode: 'boot',
    stateDir,
    persist: true,
    now: () => 1789040000000,
    paths: { settingsYaml: path.join(home, 'settings.yaml') },
    patches: [patch],
    hostAlertSink: (frame) => { delivered.push(frame) }
  })
  assert.equal(result.decision, 'degraded', 'the boot gate marks DEGRADED (never a silent ok)')
  // LA ENTREGA — una llamada, con el mensaje y los pares ausentes.
  assert.equal(delivered.length, 1, 'the degraded boot gate MUST deliver to the host (hostAlertSink called exactly once)')
  assert.equal(delivered[0].postId, 'mpc-preflight')
  assert.ok(delivered[0].missing.includes('opencode-zen/deepseek-v4-legacy-phantom'))
  assert.match(delivered[0].message, /MISSING opencode-zen\/deepseek-v4-legacy-phantom/)
  assert.deepEqual(result.hostAlertDelivery, { attempted: true, delivered: true })
  // fila duradera en el canal EXISTENTE con la forma exacta (ts/findings/dedupeKeys)
  const alerts = readFileSync(path.join(stateDir, 'health-alerts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].ts, 1789040000000)
  assert.ok(Array.isArray(alerts[0].findings) && alerts[0].findings.length === 1)
  assert.equal(alerts[0].findings[0].kind, 'config-preset')
  assert.equal(alerts[0].findings[0].postId, 'mpc-preflight')
  assert.equal(alerts[0].findings[0].interrupt, true, 'a DEGRADED boot row carries interrupt (and only a degraded one does)')
  assert.equal(alerts[0].findings[0].count, 3, 'the count is the REAL number of missing pairs (never Math.max(1, …)): the legacy pin is enumerated once per pin row')
  assert.ok(alerts[0].findings[0].error.includes('MISSING opencode-zen/deepseek-v4-legacy-phantom'))
  // la marca DEGRADED visible + la lista de pares ausentes + el RECIBO de entrega
  const state = JSON.parse(readFileSync(path.join(stateDir, MPC_PREFLIGHT_STATE_FILE), 'utf8'))
  assert.equal(state.degraded, true)
  assert.ok(state.missing.includes('opencode-zen/deepseek-v4-legacy-phantom'))
  assert.deepEqual(state.hostAlertDelivery, { attempted: true, delivered: true }, 'the durable mark records the REAL delivery outcome')
})

test('MPC-PREFLIGHT F9(a): the guard APPENDS to the SHARED ledger — a daemon row written BEFORE and one AFTER the guard run BOTH survive (no truncation, no rewrite)', async (t) => {
  // F4 (2ª pasada del gate): el home es el SUBTRACTIVO (catálogo vivo SIN el id
  // legacy + pin desplegado que lo referencia) porque la corrida del guard tiene
  // que producir un HALLAZGO REAL para escribir su fila. Con el home CUBIERTO
  // este mismo test contaba la fila del guard que sólo existía por el defecto de
  // F4 («fila en todo boot, incluso allow»): la expectativa del fixture estaba
  // codificando el bug, no el contrato.
  const home = makeHome(t, SETTINGS_SUBTRACTIVE)
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const stateDir = path.join(home, 'state')
  mkdirSync(stateDir, { recursive: true })
  const ledger = path.join(stateDir, 'health-alerts.jsonl')
  // La fila del DAEMON (forma exacta de `HealthAlertAuditEntry` de dshd-health).
  const daemonRow = (key, ts) => JSON.stringify({ ts, findings: [{ kind: 'config-preset', key, ts, error: `daemon finding ${key}` }], dedupeKeys: [key] })
  // El estado que hace sangrar la carrera: un ledger GRANDE. Con el truncado
  // anterior (read-modify-write + slice(-500)), la corrida del guard reescribía
  // el fichero entero y podía llevarse la fila ajena; el tamaño grande además
  // forzaba la poda en cada corrida.
  const filler = []
  for (let i = 0; i < 700; i += 1) filler.push(daemonRow(`daemon-filler-${i}`, 1789000000000 + i))
  const before = daemonRow('daemon-before-the-guard-run', 1789040000000)
  const after = daemonRow('daemon-after-the-guard-run', 1789040005000)
  writeFileSync(ledger, [...filler, before].join('\n') + '\n', 'utf8')
  const sizeBefore = readFileSync(ledger, 'utf8').length
  // La corrida del guard (mismo código que la puerta de boot / el CLI).
  await runMpcPreflight({
    mode: 'boot',
    stateDir,
    persist: true,
    now: () => 1789040009000,
    paths: { settingsYaml: path.join(home, 'settings.yaml') },
    patches: [patch]
  })
  // ...y el daemon escribe OTRA fila después (append concurrente, el uso real).
  appendFileSync(ledger, after + '\n', 'utf8')
  const lines = readFileSync(ledger, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  const keys = lines.flatMap((row) => row.findings.map((f) => f.key))
  assert.ok(keys.includes('daemon-before-the-guard-run'), 'F9(a): the daemon row written BEFORE the guard run SURVIVES')
  assert.ok(keys.includes('daemon-after-the-guard-run'), 'F9(a): the daemon row written AFTER the guard run SURVIVES')
  // El guard sólo AÑADE: el fichero no se reescribe ni se poda desde aquí.
  assert.ok(readFileSync(ledger, 'utf8').length > sizeBefore, 'F9(a): the shared ledger only GROWS across a guard run')
  assert.equal(lines.length, 700 + 1 + 1 + 1, 'F9(a): every row is still there (700 filler + 1 daemon before + 1 guard + 1 daemon after)')
  // y el guard sigue escribiendo su fila (una por corrida, append)
  const guardRows = lines.filter((row) => row.findings.some((f) => f.postId === MPC_PREFLIGHT_POST_ID))
  assert.equal(guardRows.length, 1, 'the guard appended exactly ONE row for its one run')
})

test('MPC-PREFLIGHT F9(b): the guard row has the SAME SCHEMA as the daemon rows of the shared ledger (same fields, same types) + only ADDITIVE extras', async (t) => {
  const home = makeHome(t, SETTINGS_SUBTRACTIVE)
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const stateDir = path.join(home, 'state')
  await runMpcPreflight({
    mode: 'boot',
    stateDir,
    persist: true,
    now: () => 1789040000000,
    paths: { settingsYaml: path.join(home, 'settings.yaml') },
    patches: [patch]
  })
  const rows = readFileSync(path.join(stateDir, 'health-alerts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.length, 1)
  const row = rows[0]
  // (1) La fila del ledger: `HealthAlertAuditEntry` de dshd-health — ts, findings, dedupeKeys.
  assert.equal(typeof row.ts, 'number', 'F9(b): row.ts is a number')
  assert.ok(Array.isArray(row.findings) && row.findings.length > 0, 'F9(b): row.findings is a non-empty array')
  assert.ok(Array.isArray(row.dedupeKeys) && row.dedupeKeys.every((k) => typeof k === 'string'), 'F9(b): row.dedupeKeys is a string[]')
  // (2) El finding: `HealthFinding` — los campos que el daemon declara, con sus tipos.
  const finding = row.findings[0]
  assert.equal(typeof finding.kind, 'string', 'F9(b): finding.kind is a string')
  assert.ok(['post-error', 'delivery-failed', 'delivery-storm', 'config-preset', 'stalled-post', 'system-wait', 'pooler-capacity', 'qi-silence', 'system-idle', 'context-threshold', 'mission-stalled', 'main-red', 'mission-queue', 'work-register-idle', 'settlement-wait', 'manager-delivery-stuck', 'ghost-store', 'work-register-idle:l2', 'work-register-idle:l3'].includes(finding.kind), 'F9(b): finding.kind is one of the channel kinds')
  assert.equal(typeof finding.key, 'string', 'F9(b): finding.key is a string')
  assert.equal(typeof finding.postId, 'string', 'F9(b): finding.postId is a string')
  assert.equal(typeof finding.ts, 'number', 'F9(b): finding.ts is a number')
  assert.equal(typeof finding.error, 'string', 'F9(b): finding.error is a string')
  assert.equal(typeof finding.count, 'number', 'F9(b): finding.count is a number')
  assert.ok(Array.isArray(finding.recipients) && finding.recipients.every((r) => typeof r === 'string'), 'F9(b): finding.recipients is a string[]')
  // (3) Extras del guard: declarados y también tipados (nunca sustituyen un campo del canal).
  assert.equal(typeof finding.degraded, 'boolean', 'F9(b): finding.degraded (guard extra) is a boolean')
  assert.equal(typeof finding.interrupt, 'boolean', 'F9(b): finding.interrupt (guard extra) is a boolean')
  // La CONTRAPRUEBA hermenéutica: los dos conjuntos de campos que el daemon usa en
  // su propia fila están presentes en la del guard (el mismo esquema, no una
  // forma parecida). `interrupt`/`degraded` son ADITIVOS: el canal nunca los
  // exige.
  const daemonFindingFields = ['kind', 'key', 'postId', 'ts', 'error', 'count', 'recipients']
  const guardFindingFields = Object.keys(finding)
  for (const field of daemonFindingFields) assert.ok(guardFindingFields.includes(field), `F9(b): the daemon finding field "${field}" is present in the guard row`)
  const extras = guardFindingFields.filter((f) => !daemonFindingFields.includes(f))
  assert.deepEqual(extras.sort(), ['degraded', 'interrupt'], 'F9(b): the ONLY extras are the two documented guard flags (additive, never a replacement)')
})

test('MPC-PREFLIGHT F9(c): the guard keeps its OWN read-modify-write state (mpc-preflight-state.json) — the shared ledger is never the place', async (t) => {
  const home = makeHome(t, SETTINGS_SUBTRACTIVE)
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const stateDir = path.join(home, 'state')
  // Dos corridas seguidas: el estado propio se REESCRIBE (latches/decisión/sello),
  // el ledger compartido sólo CRECE (una fila por corrida).
  await runMpcPreflight({ mode: 'boot', stateDir, persist: true, now: () => 1789040000000, paths: { settingsYaml: path.join(home, 'settings.yaml') }, patches: [patch] })
  const first = JSON.parse(readFileSync(path.join(stateDir, MPC_PREFLIGHT_STATE_FILE), 'utf8'))
  await runMpcPreflight({ mode: 'boot', stateDir, persist: true, now: () => 1789040009000, paths: { settingsYaml: path.join(home, 'settings.yaml') }, patches: [patch] })
  const second = JSON.parse(readFileSync(path.join(stateDir, MPC_PREFLIGHT_STATE_FILE), 'utf8'))
  const rows = readFileSync(path.join(stateDir, 'health-alerts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.length, 2, 'F9(c): one APPENDED row per run (the ledger is append-only, never rewritten)')
  assert.equal(first.ts, 1789040000000)
  assert.equal(second.ts, 1789040009000, 'F9(c): the guard state is REWRITTEN in place with the latest run (the read-modify-write lives here)')
  assert.equal(second.degraded, true)
  assert.equal(second.inputs.runtimeCatalogConsulted, false)
  assert.ok(second.missing.length > 0)
  // El estado propio es JSON con su sello de entrada (F8) y NO toca el ledger
  // (ninguna clave del canal aparece en él).
  assert.equal(second.inputs.settingsYaml, path.join(home, 'settings.yaml'))
  assert.equal(Object.keys(second).includes('findings'), false, 'F9(c): the guard state is NOT a ledger row')
})

test('MPC-PREFLIGHT gate 3(b): a HEALTHY boot gate writes NO durable row at all (no ledger noise) — on the REAL path, where `degraded` is a constant', async (t) => {
  const home = makeHome(t, SETTINGS_COVERED)
  const stateDir = path.join(home, 'state')
  // F4 (2ª pasada del gate): SIN `catalogSources`. El test anterior SÍ suplía el
  // catálogo (`suppliedCatalogFromYaml`) y por eso medía `degraded=false` ⇒ una
  // composición que producción NUNCA tiene: el boot corre la vía síncrona y
  // jamás suple catálogo (clase R8 del gate anterior). Con la vía real el flag
  // `degraded` es `true` POR CONSTRUCCIÓN (mitad runtime no consultada) y aun así
  // el boot sano no puede escribir nada: eso es F4.
  const result = await runMpcPreflight({
    mode: 'boot',
    stateDir,
    persist: true,
    paths: { settingsYaml: path.join(home, 'settings.yaml') }
  })
  assert.equal(result.decision, 'allow')
  assert.equal(result.inputs.runtimeCatalogConsulted, false, 'the boot path can never consult the runtime half')
  assert.equal(result.degraded, true, 'the permanent half-runtime degraded is TRUE (never a silent ok) — and it is NOT a finding')
  // F4 (gate unit-2): un boot SANO no escribe ni fila de canal ni marca. La fila
  // del 09-10 llevaba `count: Math.max(1, 0)` + `interrupt: true` en un boot
  // limpio: ruido de ledger y un carrier de interrupt vacío.
  assert.equal(existsSync(path.join(stateDir, 'health-alerts.jsonl')), false, 'a healthy boot writes NO alert row')
  assert.equal(existsSync(path.join(stateDir, MPC_PREFLIGHT_STATE_FILE)), false, 'a healthy boot writes NO degraded mark')
  assert.equal(result.hostAlertDelivery, undefined, 'nothing to deliver on a healthy boot')
  // ...y el «no pude verificar la mitad runtime» sigue siendo LOUD (problema del
  // informe), no un silencio.
  assert.ok(result.problems.some((p) => p.includes('the RUNTIME catalog source')), 'the unverified half is declared LOUD in the report (never a silent ok)')
})

// --- F4 (2ª pasada) — LA PUERTA REAL: registerMpcBootPinCoherenceGate /
// --- runMpcPreflightSync SIN catalogSources (el único objeto que produce la fila
// --- fantasma que el reviewer midió en §5, líneas 144-159). --------------------

test('MPC-PREFLIGHT F4-REAL(a): the REAL sync door (runMpcPreflightSync, NO catalogSources) on a HEALTHY home writes NEITHER row NOR mark (the permanent degraded is not a finding)', async (t) => {
  const home = makeHome(t, SETTINGS_COVERED)
  const stateDir = path.join(home, 'state')
  const result = runMpcPreflightSync({
    mode: 'boot',
    stateDir,
    persist: true,
    now: () => 1789040000000,
    paths: {
      settingsYaml: path.join(home, 'settings.yaml'),
      agentPresetsDir: path.join(home, '.agent-presets'),
      profilesDir: path.join(home, 'profiles')
    }
  })
  assert.equal(result.decision, 'allow', 'a healthy real home IS `allow` at boot (there is nothing to report)')
  assert.equal(result.degraded, true, 'the half-runtime flag stays TRUE (permanent, by construction of the sync door)')
  assert.equal(result.inputs.runtimeCatalogConsulted, false)
  assert.equal(result.report.missing.length, 0)
  assert.equal(result.retiredStillPinned.length, 0)
  // EL DEFECTO QUE CIERRA F4: con `worthWriting` dependiente de `degraded`, este
  // caso (un boot `allow`) escribía fila `{count:0, interrupt:true,
  // degraded:true}` + marca en CADA arranque.
  assert.equal(existsSync(path.join(stateDir, 'health-alerts.jsonl')), false, 'F4: NO channel row on a healthy real boot')
  assert.equal(existsSync(path.join(stateDir, MPC_PREFLIGHT_STATE_FILE)), false, 'F4: NO degraded mark on a healthy real boot')
  assert.equal(result.hostAlertDelivery, undefined, 'F4: nothing is delivered when there is no finding')
  assert.ok(result.problems.some((p) => p.includes('the RUNTIME catalog source was not consulted')), 'the unverified half is declared LOUD in the report (never a silent ok)')
})

test('MPC-PREFLIGHT F4-REAL(b): the REAL boot GATE (registerMpcBootPinCoherenceGate, no catalogSources) on a HEALTHY home pings NO host and leaves NO durable artifact', async (t) => {
  const home = makeHome(t, SETTINGS_COVERED)
  const stateDir = path.join(home, 'state')
  const host = liveHostFixture()
  const logs = await runRealBootGate({ home, stateDir, hosts: host.hosts, agents: host.agents })
  // La puerta CORRIÓ y verificó I-MP: sin esto, «no escribió nada» sería vacuo
  // (un no-op trivial también escribe cero filas).
  assert.ok(logs.info.some((line) => line.includes('MPC-PREFLIGHT boot gate: I-MP verified')), `the real gate ran and verified I-MP — logs: ${JSON.stringify(logs)}`)
  assert.ok(logs.warn.some((line) => line.includes('the RUNTIME catalog source was not consulted')), 'the unverified half is a LOUD warn (and only that)')
  assert.equal(host.delivered.length, 0, 'F4: a healthy real boot NEVER writes into the host inbox')
  assert.equal(existsSync(path.join(stateDir, 'health-alerts.jsonl')), false, 'F4: no channel row')
  assert.equal(existsSync(path.join(stateDir, MPC_PREFLIGHT_STATE_FILE)), false, 'F4: no degraded mark')
})

test('MPC-PREFLIGHT F4-REAL(c): POSITIVE — the REAL boot GATE with a REAL finding writes ONE row with the CHANNEL SCHEMA and DELIVERS to the live host (the gate is NOT a no-op)', async (t) => {
  // El hallazgo REAL, el del 09-10, sin inventar nada: el catálogo vivo
  // (settings.yaml) NO tiene el id legacy y el pin DESPLEGADO sí. Las dos vías
  // del pin son las reales de la puerta: la fila del org que el boot recibe del
  // config vivo (P2) y el preset live (P4 — el tramo que el incidente rotó).
  const home = makeHome(t, SETTINGS_SUBTRACTIVE)
  addPresetPin(home, 'deepartments-worker', { provider: 'opencode-zen', model: 'deepseek-v4-legacy-phantom' })
  const stateDir = path.join(home, 'state')
  const org = { workerAgentOptions: { provider: 'opencode-zen', model: 'deepseek-v4-legacy-phantom', reasoningEffort: 'max' } }
  const host = liveHostFixture()
  const logs = await runRealBootGate({ home, stateDir, org, hosts: host.hosts, agents: host.agents })
  assert.ok(logs.warn.some((line) => line.includes('DEGRADED')), `the real gate reports DEGRADED (fail-loud) — logs: ${JSON.stringify(logs)}`)
  // (1) LA ENTREGA OBSERVADA: el sink REAL del wiring (deliverToLiveHost) hace un
  // followup al handle del host vivo — se asserta el frame recibido, no un campo
  // auto-declarado.
  assert.equal(host.delivered.length, 1, 'the real gate delivers EXACTLY one frame to the live host')
  const frame = JSON.stringify(host.delivered[0])
  assert.ok(frame.includes('MPC-PREFLIGHT mpc-preflight'), 'the delivered frame is the MPC-PREFLIGHT boot alert')
  assert.ok(frame.includes('opencode-zen/deepseek-v4-legacy-phantom'), 'the delivered frame names the missing pair')
  // (2) LA FILA, con el ESQUEMA DEL CANAL (HealthAlertAuditEntry + HealthFinding).
  const rows = readFileSync(path.join(stateDir, 'health-alerts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.length, 1, 'EXACTLY one row: the gate is neither a no-op nor a flood')
  const row = rows[0]
  assert.equal(typeof row.ts, 'number')
  assert.ok(Array.isArray(row.dedupeKeys) && row.dedupeKeys.every((k) => typeof k === 'string'))
  assert.ok(Array.isArray(row.findings) && row.findings.length === 1)
  const finding = row.findings[0]
  assert.equal(finding.kind, 'config-preset')
  assert.equal(finding.postId, MPC_PREFLIGHT_POST_ID)
  assert.equal(typeof finding.key, 'string')
  assert.equal(typeof finding.ts, 'number')
  assert.equal(finding.count, 2, 'the count is the REAL number of missing pairs (org P2 + preset P4) — never Math.max(1, …)')
  assert.equal(finding.interrupt, true, 'a DEGRADED row carries the interrupt')
  assert.equal(finding.degraded, true)
  assert.deepEqual(finding.recipients, ['host'])
  assert.ok(finding.error.includes('MISSING opencode-zen/deepseek-v4-legacy-phantom'))
  // (3) LA MARCA DURABLE + el RECIBO de la entrega (jamás un «entregado» falso).
  const mark = JSON.parse(readFileSync(path.join(stateDir, MPC_PREFLIGHT_STATE_FILE), 'utf8'))
  assert.equal(mark.decision, 'degraded')
  assert.equal(mark.degraded, true)
  assert.ok(mark.missing.includes('opencode-zen/deepseek-v4-legacy-phantom'))
  assert.deepEqual(mark.hostAlertDelivery, { attempted: true, delivered: true }, 'the durable receipt records the REAL delivery outcome')
  assert.equal(mark.inputs.runtimeCatalogConsulted, false, 'the REAL door never supplies a catalog — the case the supplied-catalog fixture cannot represent')
  assert.equal(mark.inputs.settingsYaml, path.join(home, 'settings.yaml'))
  assert.deepEqual(mark.inputs.catalogSources, ['settings-yaml', 'builtin-adapter'], 'only the static half + the built-in routes: NO supplied catalog')
})

// --- A6: read-only + detección de modo ---------------------------------------

test('MPC-PREFLIGHT A6: the guard is READ-ONLY on the live home — it never edits settings.yaml, never restores legacy, never restarts', async (t) => {
  const home = makeHome(t, SETTINGS_SUBTRACTIVE)
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, PATCH_LEGACY_PIN, 'utf8')
  const settingsPath = path.join(home, 'settings.yaml')
  const before = readFileSync(settingsPath, 'utf8')
  const stateDir = path.join(home, 'state')
  // El catálogo SUPLIDO del fixture es el ADITIVO (declara el id legacy aún
  // pinneado) ⇒ el gate de deploy PASA y lo que se prueba aquí es que el guard
  // es read-only sobre el home, no la disposición del gate.
  const result = await runMpcPreflight({
    mode: 'deploy',
    stateDir,
    persist: true,
    paths: { settingsYaml: settingsPath },
    catalogSources: [{ id: 'fixture-catalog-additive', providers: { 'opencode-zen': { models: ['deepseek-flash', 'deepseek-v4-legacy-phantom'], registered: true } } }],
    patches: [patch]
  })
  assert.equal(result.decision, 'allow')
  assert.equal(readFileSync(settingsPath, 'utf8'), before, 'settings.yaml must be byte-identical after the guard')
  // el guard NO auto-restaura el id retirado: el catálogo sigue siendo el mismo
  const catalog = staticCatalogFromSettingsYaml(settingsPath)
  assert.deepEqual(catalog.providers['opencode-zen'].models, ['deepseek-flash'])
  // y no crea ningún artefacto de restart/boot fuera del stateDir
  assert.equal(existsSync(path.join(home, 'boot-crash.json')), false)
  assert.equal(existsSync(path.join(home, 'health-heartbeat.json')), false)
})

test('MPC-PREFLIGHT A6(b): the run mode is derived from the executable path (the plugin path can only be the BOOT gate)', () => {
  assert.equal(resolveGuardMode(['node', '/usr/lib/node_modules/@deepseek-ai/dsh/lib/index.js'], {}), 'boot')
  assert.equal(resolveGuardMode(['node', '/home/esuarez/projects/deepartments/scripts/mpc-preflight.mjs'], {}), 'deploy')
  assert.equal(resolveGuardMode(['node', '/whatever'], { DSH_MPC_MODE: 'boot' }), 'boot')
  assert.equal(resolveGuardMode(['node', '/whatever'], { DSH_MPC_MODE: 'deploy' }), 'deploy')
})

// --- A8: el informe y el vocabulario -----------------------------------------

test('MPC-PREFLIGHT A8: the run report carries provider+model+tramo+ref for every missing pair (the actionable single line) + the F8 ENTRY STAMP', () => {
  const verdicts = comparePins(
    [{ provider: 'opencode-zen', model: 'deepseek-v4-flash', source: { tramo: 'P3', class: 'code-constant', ref: 'presets.ts WORKER_AGENT_OPTIONS' } }],
    { id: 'settings-yaml', providers: { 'opencode-zen': { models: ['deepseek-flash'], registered: true } } }
  )
  const report = buildCoherenceReport({
    pins: verdicts.map((v) => v.pin),
    sources: [
      { id: 'settings-yaml', providers: { 'opencode-zen': { models: ['deepseek-flash'], registered: true } } },
      { id: 'runtime-llm', providers: { 'opencode-zen': { models: ['deepseek-flash'], registered: true } } }
    ],
    phase: 'deploy-preflight'
  })
  const text = renderRunReport({
    mode: 'deploy',
    decision: report.decision,
    report,
    auxiliaryFindings: [],
    pinCount: 1,
    auxiliaryCount: 0,
    problems: [],
    retiredStillPinned: [],
    degraded: false,
    inputs: {
      ts: 1789040000000,
      settingsYaml: '/fixture/settings.yaml',
      patches: ['/fixture/cordis.patch.yml'],
      profile: 'fixture-profile',
      catalogSources: ['settings-yaml'],
      runtimeCatalogConsulted: true
    }
  })
  assert.match(text, /MISSING opencode-zen\/deepseek-v4-flash — tramo P3 \(code-constant\) fixed by presets\.ts WORKER_AGENT_OPTIONS/)
  assert.match(text, /ADD the id — additive-first/)
  // F8 — el SELLO DE ENTRADA: qué settings.yaml, qué patches, qué perfil, qué
  // fuentes de catálogo y su ts (un §2.5 NO datable es otro «detalle caduco»).
  assert.match(text, new RegExp(`entry-stamp ts=${new Date(1789040000000).toISOString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} settings=/fixture/settings\\.yaml`))
  assert.match(text, /patches=\[\/fixture\/cordis\.patch\.yml\] profile=fixture-profile catalogs=\[settings-yaml\] runtimeConsulted=true/)
})

test('MPC-PREFLIGHT A8(b): the PER-SESSION resolved route is read from the LAST request/header of the session log (never from a sessionId/date)', async () => {
  const { resolvedRoutePinFromSessionLog } = await import('dshd-orchestration/model-pins')
  const log = [
    '{"type":"session/header","id":"worker-builder-247-old-uuid"}',
    '{"type":"request/header","provider":"opencode-zen","model":"deepseek-v4-legacy-phantom"}',
    '{"type":"turn/end"}',
    '{"type":"request/header","provider":"opencode-zen","model":"deepseek-flash"}'
  ].join('\n')
  const pin = resolvedRoutePinFromSessionLog(log)
  assert.deepEqual(pin, { provider: 'opencode-zen', model: 'deepseek-flash' }, 'the LAST resolved route wins (the pin of the NEXT turn)')
  assert.equal(resolvedRoutePinFromSessionLog('{"type":"turn/start"}'), undefined, 'no request header ⇒ no pin (never an invented route)')
  // el criterio NO mira la fecha del sessionId: el id del fixture es "pre-fix" y
  // el veredicto sale del par provider/model resuelto, que es servible.
  const covered = { id: 'settings-yaml', providers: { 'opencode-zen': { models: ['deepseek-flash'], registered: true } } }
  const verdict = resolvedStaleHandleVerdict({ handleOptions: pin, currentPin: { ...pin, source: { tramo: 'P2', class: 'org.workerAgentOptions', ref: 'org.workerAgentOptions' } }, catalog: covered, source: { tramo: 'P1', class: 'resolved-session-route', ref: 'session log request/header' } })
  assert.equal(verdict, undefined, 'a live head whose resolved route is covered is NEVER a false positive (A4 zero-FP baseline)')
})

test('MPC-PREFLIGHT A2(e): the REAL live home enumerates P1..P4 — including the P4 LITERAL pins with their file:line — without touching it (integration, read-only)', async () => {
  const liveHome = '/opt/dsh/.dsh-dev'
  if (!existsSync(path.join(liveHome, 'settings.yaml'))) return
  const liveCatalog = staticCatalogFromSettingsYaml(path.join(liveHome, 'settings.yaml'))
  const pins = resolveModelPins({
    paths: {
      settingsYaml: path.join(liveHome, 'settings.yaml'),
      agentPresetsDir: path.join(liveHome, '.agent-presets'),
      profilesDir: path.join(liveHome, 'profiles'),
      ...(existsSync(LIVE_POOLER_CONFIG) ? { keyPoolerConfigPath: LIVE_POOLER_CONFIG } : {})
    },
    catalogProviders: [...Object.keys(liveCatalog.providers), 'deepseek-official']
  })
  // los tramos enumerados del home vivo: P1 (settings) + P3 (constantes).
  const tramos = new Set(pins.pins.map((pin) => pin.source.tramo))
  assert.ok(tramos.has('P1'), 'the live agent-default-model must be enumerated')
  assert.ok(tramos.has('P3'), 'the code constants must be enumerated')
  assert.ok(pins.auxiliary.length >= 1, 'P6 (twin/key-pooler) must be read-only enumerated')
  // F1 (gate unit-2) — LO QUE EL GATE MIDIÓ COMO 0: los presets VIVOS no tienen
  // ningún bloque `agentOptions:` (sólo los `.bak-*`); su pin real es un LITERAL
  // de prompt y el tramo P4 debe medir > 0 con su ref `file:line`.
  assert.ok(tramos.has('P4'), 'the LIVE presets must enumerate pins (P4) — the incident rotated this tramo')
  const p4 = pins.pins.filter((pin) => pin.source.tramo === 'P4')
  assert.ok(p4.length > 0, `P4 must be > 0 on the real home (got ${p4.length})`)
  for (const pin of p4) assert.match(pin.source.ref, /\.agent-presets\/.+\/agent\.cordis\.yml:\d+$/, `every P4 pin carries its file:line ref (got ${pin.source.ref})`)
  assert.equal(HOST_AGENT_OPTIONS.provider, WORKER_AGENT_OPTIONS.provider)
})

// --- F1: el tramo P4 REAL (el literal del preset) -----------------------------

test('MPC-PREFLIGHT F1: the P4 reader enumerates BOTH the structured blocks and the PROMPT LITERAL (with its file:line), and never invents a provider outside the catalog', (t) => {
  const home = fixtureDir(t)
  const presetDir = path.join(home, '.agent-presets', 'fixture-worker')
  mkdirSync(presetDir, { recursive: true })
  // El literal EXACTO de la forma que el incidente rotó (línea 3 del fixture):
  // «Model: <model> (provider <provider>, reasoning max)».
  writeFileSync(path.join(presetDir, 'agent.cordis.yml'), [
    '- id: persona',
    '  config:',
    '    text: >-',
    '      You are a disposable worker. Model: deepseek-flash (provider opencode-zen, reasoning max). Working',
    '      directory: {{cwd}}.',
    '      (una ruta canónica suelta: opencode-zen/glm-5.3-flash)',
    '      (un provider NO declarado en el catálogo: other-vendor/some-model — se ignora)'
  ].join('\n') + '\n', 'utf8')
  const read = readLiteralPinsFromFile(path.join(presetDir, 'agent.cordis.yml'), '.agent-presets/fixture-worker/agent.cordis.yml', 'P4', 'session-preset', ['opencode-zen'])
  const pairs = read.pins.map((pin) => `${pin.provider}/${pin.model}`).sort()
  assert.deepEqual(pairs, ['opencode-zen/deepseek-flash', 'opencode-zen/glm-5.3-flash'], 'both the prompt literal and the canonical path are enumerated (and the undeclared provider is ignored)')
  const literal = read.pins.find((pin) => pin.model === 'deepseek-flash')
  assert.equal(literal.source.ref, '.agent-presets/fixture-worker/agent.cordis.yml:4', 'the literal pin carries its file:line')
  assert.equal(literal.source.tramo, 'P4')
  // Y un bloque `provider: spawn` (subagente) NO es un pin de modelo: sin
  // provider del catálogo, el lector no inventa un par.
  writeFileSync(path.join(presetDir, 'agent.cordis.yml'), '- id: delegation\n  config:\n    agentOptions:\n      provider: spawn\n      model: default-model\n', 'utf8')
  assert.deepEqual(readLiteralPinsFromFile(path.join(presetDir, 'agent.cordis.yml'), 'x', 'P4', 'session-preset', ['opencode-zen']).pins, [])
})

// --- F2: la fila P1 de la capa bundle ----------------------------------------

test('MPC-PREFLIGHT F2: the bundle-layer P1 row (`- id: agent-default-model` + `config:`) is enumerated and labelled P1 with its file:line', (t) => {
  const home = fixtureDir(t)
  const patch = path.join(home, 'cordis.patch.yml')
  writeFileSync(patch, [
    '- id: system-prompt',
    '  config:',
    '    persona: >-',
    '      You are the Asistente. Model: deepseek-flash (opencode-zen, reasoning max).',
    '- id: agent-default-model',
    '  config:',
    '    provider: opencode-zen',
    '    model: deepseek-flash'
  ].join('\n') + '\n', 'utf8')
  const read = readOrgPinsFromPatch(patch, ['opencode-zen'])
  const p1 = read.pins.filter((pin) => pin.source.tramo === 'P1')
  assert.equal(p1.length, 1, 'the bundle-layer agent-default-model row is ONE P1 pin (before this fix: 0 pins)')
  assert.equal(p1[0].provider, 'opencode-zen')
  assert.equal(p1[0].model, 'deepseek-flash')
  assert.equal(p1[0].source.class, 'agent-default-model')
  assert.equal(p1[0].source.ref, `${patch}:5`, 'the P1 row carries its file:line (riesgo R5: el tramo correcto, no P2)')
  assert.deepEqual(read.agentDefaultModel, { provider: 'opencode-zen', model: 'deepseek-flash' })
  assert.ok(read.pins.every((pin) => pin.source.tramo === 'P1' || pin.source.tramo === 'P2'))
})

// --- F6: la superficie de declaración de pines benignos -----------------------

test('MPC-PREFLIGHT F6: a DECLARED BENIGN pin is reported as «declared benign + reason» (and an undeclared one is not), with the reason MANDATORY', async (t) => {
  const home = makeHome(t, SETTINGS_COVERED)
  const stateDir = path.join(home, 'state')
  mkdirSync(stateDir, { recursive: true })
  // El pin AUX/P6 latente real: el `probeModel` del key-pooler (default de código
  // TAPADO por la fila live del perfil activo) — hallazgo legítimo, y benigno.
  const poolerConfig = path.join(home, 'pooler-config.js')
  writeFileSync(poolerConfig, "const config = { probeModel: 'deepseek-v4-flash' }\n", 'utf8')
  const declarationsPath = path.join(stateDir, 'mpc-pin-declarations.json')
  writeFileSync(declarationsPath, JSON.stringify({
    declarations: [
      { provider: 'opencode-zen', model: 'deepseek-v4-flash', tramo: 'P6', class: 'key-pooler-probe', reason: 'default de código del key-pooler tapado por la fila live del perfil activo (literal latente, no resuelto)', declaredBy: 'host' }
    ]
  }, null, 2), 'utf8')
  const result = await runMpcPreflight({
    mode: 'deploy',
    stateDir,
    paths: { settingsYaml: path.join(home, 'settings.yaml'), keyPoolerConfigPath: poolerConfig },
    catalogSources: [suppliedCatalogFromYaml(path.join(home, 'settings.yaml'))],
    declarationsPath
  })
  const aux = result.auxiliaryFindings.find((v) => v.pin.model === 'deepseek-v4-flash')
  assert.ok(aux !== undefined, 'the key-pooler probe pin is enumerated (P6)')
  assert.ok(aux.declaration !== undefined, 'the declaration is MATCHED (F6)')
  assert.match(aux.declaration.reason, /default de código del key-pooler/)
  // el informe lo muestra como declarado benigno CON su razón
  const text = renderRunReport(result)
  assert.match(text, /AUX\(unknown-model\) opencode-zen\/deepseek-v4-flash — declared benign \+ reason: default de código del key-pooler/)
  assert.match(text, /\(declared by host\)/)
  // Una declaración SIN razón NO se aplica (y se reporta como problem).
  writeFileSync(declarationsPath, JSON.stringify({ declarations: [{ provider: 'opencode-zen', model: 'deepseek-v4-flash', reason: '   ' }] }), 'utf8')
  const noReason = await runMpcPreflight({
    mode: 'deploy',
    paths: { settingsYaml: path.join(home, 'settings.yaml'), keyPoolerConfigPath: poolerConfig },
    catalogSources: [suppliedCatalogFromYaml(path.join(home, 'settings.yaml'))],
    declarationsPath
  })
  assert.equal(noReason.auxiliaryFindings[0].declaration, undefined, 'a declaration without a written reason is NOT a declaration')
  assert.ok(noReason.problems.some((p) => /has NO reason/.test(p)))
})

test('MPC-PREFLIGHT F6(b): the BUILT-IN provider route is resolved (the AUX(unknown) artefact of the static half disappears)', async (t) => {
  const home = makeHome(t, SETTINGS_COVERED)
  // El twin declara un provider que NO está en llm-pi-ai: la ruta BUILT-IN del
  // paquete bundled (`@deepseek-ai/dsh-llm-deepseek`), que es exactamente el
  // artefacto que el gate unit-2 marcó como hallazgo de la mitad ESTÁTICA.
  const profilesDir = path.join(home, 'profiles', 'twin')
  mkdirSync(profilesDir, { recursive: true })
  writeFileSync(path.join(profilesDir, 'cordis.patch.yml'), '- insert:\n    - id: tool-subagent-test\n      config:\n        provider: spawn\n        agentOptions:\n          provider: deepseek-official\n          model: deepseek-v4-flash-vision-exp\n', 'utf8')
  const result = await runMpcPreflight({
    mode: 'deploy',
    paths: { settingsYaml: path.join(home, 'settings.yaml'), profilesDir: path.join(home, 'profiles') },
    catalogSources: [suppliedCatalogFromYaml(path.join(home, 'settings.yaml'))]
  })
  assert.equal(result.decision, 'allow')
  assert.equal(result.auxiliaryFindings.length, 0, 'the built-in deepseek-official route is NOT an unverifiable finding any more')
  assert.equal(result.auxiliaryCount, result.auxiliaryFindings.length, 'the report counter counts FINDINGS (what it prints), never enumerated-but-resolved pins')
  const twinVerdict = result.report.verdicts.find((v) => v.pin.provider === 'deepseek-official')
  assert.equal(twinVerdict, undefined, 'the twin pin stays an AUXILIARY read-only tramo (never part of the active profile decision)')
  assert.ok(result.inputs.catalogSources.includes('builtin-adapter'), 'the built-in catalog source is declared in the entry stamp')
})
