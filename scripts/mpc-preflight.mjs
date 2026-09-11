#!/usr/bin/env node
// dsh-deepartments — MPC-PREFLIGHT CLI (lane IPD; spec CONGELADA del QD
// .dsh/reports/quality/2026-09-10-incidente-congelacion-modelo-prevencion.md
// §4.2). El PRE-FLIGHT DE DEPLOY BLOQUEANTE y el WRITE-GUARD del catálogo
// subtractivo sobre los ficheros REALES, invocable por el ritual de deploy del
// host:
//
//   node scripts/mpc-preflight.mjs deploy      # puertas 1-2: ANTES de la fase
//                                              # live y DESPUÉS de build+plugin
//                                              # add, SIEMPRE antes del restart
//   node scripts/mpc-preflight.mjs check       # informe read-only (sin efectos)
//   node scripts/mpc-preflight.mjs boot        # puerta 3 (DEGRADED, no bloquea)
//   node scripts/mpc-preflight.mjs subtractive --candidate <settings.yaml.new>
//                                              # write-guard del catálogo
//
// `DSH_MPC_MODE=deploy|boot` es la señal EXPLÍCITA del modo; en su ausencia el
// modo se deriva de la ruta del ejecutable (un `node_modules` en argv[1] sólo
// puede ser el plugin instalado ⇒ boot).
//
// LAS DOS VÍAS DEL CATÁLOGO (fix-forward F5 del gate unit-2). El invariante
// I-MP exige la COINCIDENCIA de las DOS mitades del catálogo, y este CLI no
// tiene un `llm` vivo ⇒ cada invocación necesita UNA de estas dos salidas:
//
//   (1) IN-PROCESS (vía CANÓNICA): quien SÍ tiene la primitiva viva llama al
//       runner directamente — `runMpcPreflight({ llm: ctx.llm, … })`
//       (packages/dshd-orchestration/src/model-pins-runner.ts). Es la forma
//       preferida en CUALQUIER punto del runtime (un gate dentro del bundle, un
//       job, un hook): la fuente `runtime-llm` sale de
//       `llm.listProviders()`/`llm.listModels()` — el MISMO probe R2.
//   (2) `--catalog <fichero.json>`: el puente para quien corre el CLI FUERA del
//       runtime (deploy/rotación desde shell). El fichero lleva el catálogo live
//       con la forma de `LiveCatalogSource` (model-pins.ts:100-105):
//
//         { "id": "runtime-llm",
//           "providers": { "opencode-zen": { "models": ["deepseek-flash"], "registered": true } } }
//
//       Son válidas además dos formas abreviadas: un objeto de providers pelado
//       (`{ "opencode-zen": { "models": [...] } }`) y la lista de ids por
//       provider (`{ "opencode-zen": ["deepseek-flash"] }`). `registered` por
//       defecto = true (una lista de ids declarada afirma el registro).
//
// ✗ SIN ESCAPE HATCH: NO existe —ni se añadirá aquí— ningún flag del tipo
//   «desplegar con la mitad estática». Un catálogo estático solo NO es evidencia
//   del catálogo vivo del adapter (los ids estáticos pueden resolver mientras el
//   adapter niega el modelo: exactamente el estado del 09-10).
//
// EXIT (el contrato REAL, fix-forward del header que mentía):
//   0 = I-MP verificado por las DOS mitades (allow) y, en `subtractive`, ningún
//       id retirado que siga pinneado.
//   2 = BLOQUEO (fail-loud, nunca fail-open). En `deploy`/`check` cuando
//       `decision === 'blocked'`: hay pares pines⊄catálogo, NO se pudo leer
//       ninguna fuente estática, o —F5— la mitad RUNTIME no se consultó (sin
//       `--catalog` y sin `llm` in-process). MATIZ MEDIDO POR EL GATE (el header
//       mentía): el 2 NO es exclusivo de `blocked` — en `deploy` un
//       `decision === 'degraded'` (pin NO VERIFICABLE, no violación) también
//       sale 2 (abajo, el mapa real): un `deploy` nunca sale 0 con `degraded`.
//       —F5-bis— BLOQUEA TAMBIÉN cuando las DOS mitades consultadas
//       **DISCREPAN** (una resuelve el pin y la otra lo NIEGA): el invariante
//       exige que COINCIDAN (§4.2:221) y la discrepancia es en sí misma un
//       hallazgo, así que el veto de un catálogo consultado NUNCA queda tapado
//       por el `ok` del otro (ese `allow` por unión fue el residuo del fail-open
//       de F5: la mitad runtime era decisivamente inerte). NO se reinicia.
//   3 = REJECTED por el write-guard subtractivo (se retira un id aún
//       referenciado por un pin desplegado, sin DSH_MPC_PHASE=subtractive-after-deploy).
//   4 = el `--catalog` nombrado no se pudo leer/parsear (fail-loud: pedir el
//       puente y no tenerlo NUNCA se degrada en un ok silencioso).
//   1 = cualquier otro fallo no clasificado.
// El guard es READ-ONLY sobre el home vivo: sólo escribe la marca DEGRADED y la
// fila durable del canal de alertas bajo el stateDir.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveGuardMode, runMpcPreflight, renderRunReport, readOrgPinsFromPatch } from 'dshd-orchestration/model-pins-runner'
import { WORKER_AGENT_OPTIONS } from 'dshd-orchestration/model-pins'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1]
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  if (inline !== undefined) return inline.slice(`--${name}=`.length)
  return fallback
}

const DSH_HOME = argOf('dsh-home', process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(process.env.HOME ?? '/root', '.dsh'))
const STATE_DIR = argOf('state-dir', path.join('/.deepartments'))
const ProfileName = argOf('profile', process.env.DSH_PROFILE)
const sub = (process.argv[2] ?? '').replace(/^--/, '')
const mode = sub === 'deploy' || sub === 'check' || sub === 'boot' || sub === 'subtractive' ? sub : resolveGuardMode()
const candidatePath = argOf('candidate')
const catalogPath = argOf('catalog')
const settingsYaml = argOf('settings', path.join(DSH_HOME, 'settings.yaml'))

/**
 * Normaliza el JSON de `--catalog` a la forma `LiveCatalogSource`
 * (model-pins.ts:100-105): `{ id?, providers: { <provider>: { models: string[],
 * registered?: boolean } } }`. Acepta las tres formas documentadas en el header.
 * Devuelve `undefined` + problem si no se puede.
 */
function loadCatalogSource(file) {
  if (!existsSync(file)) return { problem: `--catalog ${file}: absent` }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { problem: `--catalog ${file}: unparseable (${error instanceof Error ? error.message : String(error)})` }
  }
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isPlainObject(parsed)) return { problem: `--catalog ${file}: the JSON must be an object` }
  const rawProviders = isPlainObject(parsed.providers) ? parsed.providers : parsed
  const providers = {}
  for (const [provider, entry] of Object.entries(rawProviders)) {
    if (Array.isArray(entry)) {
      providers[provider] = { models: entry.filter((id) => typeof id === 'string'), registered: true }
      continue
    }
    if (!isPlainObject(entry)) return { problem: `--catalog ${file}: provider "${provider}" must be an object with "models" (or an array of ids)` }
    const models = Array.isArray(entry.models) ? entry.models.filter((id) => typeof id === 'string') : []
    providers[provider] = { models, registered: entry.registered === undefined ? true : entry.registered === true }
  }
  const id = typeof parsed.id === 'string' && parsed.id.trim() !== '' ? parsed.id.trim() : 'catalog-json'
  return { source: { id, providers } }
}

const catalogSources = []
let catalogProblem
if (catalogPath !== undefined) {
  const loaded = loadCatalogSource(catalogPath)
  if (loaded.problem !== undefined) catalogProblem = loaded.problem
  else catalogSources.push(loaded.source)
}
if (catalogProblem !== undefined) {
  process.stderr.write(`[MPC-PREFLIGHT] ${catalogProblem}\n`)
  process.stderr.write('[MPC-PREFLIGHT] A --catalog that cannot be read is a BLOCK (never a silent ok): fix the file or run the guard IN-PROCESS with the live llm (runMpcPreflight({ llm })).\n')
  process.exit(4)
}

// Los patches del perfil ACTIVO + del root del repo (tramo P2: filas de
// coordinador + org.workerAgentOptions/hostAgentOptions; tramo P1: la fila
// `agent-default-model` de la capa bundle).
const patchCandidates = []
// El root del repo SIEMPRE (la fila agent-default-model + las capas del bundle
// que el deploy recompone), el `cordis.patch.yml` del HOME cuando existe (la
// composición viva) y el perfil activo cuando se nombra.
for (const candidate of [path.join(DSH_HOME, 'cordis.patch.yml'), path.join(REPO_ROOT, 'cordis.patch.yml'), path.join(REPO_ROOT, 'packages/dshd-core/cordis.patch.yml')]) {
  if (existsSync(candidate) && !patchCandidates.includes(candidate)) patchCandidates.push(candidate)
}
if (ProfileName !== undefined && ProfileName !== '') {
  const profilePatch = path.join(DSH_HOME, 'profiles', ProfileName, 'cordis.patch.yml')
  if (existsSync(profilePatch)) patchCandidates.push(profilePatch)
}
// El org RESUELTO (worker/host routes) se lee de los patches — en el CLI no hay
// bundle vivo que lo resuelva, así que se re-deriva de las MISMAS filas.
const org = {}
for (const patch of patchCandidates) {
  const read = readOrgPinsFromPatch(patch)
  if (read.org?.workerAgentOptions !== undefined) org.workerAgentOptions = read.org.workerAgentOptions
  if (read.org?.hostAgentOptions !== undefined) org.hostAgentOptions = read.org.hostAgentOptions
}

const result = await runMpcPreflight({
  mode: mode === 'check' ? 'deploy' : mode,
  stateDir: STATE_DIR,
  persist: mode !== 'check',
  paths: {
    settingsYaml,
    agentPresetsDir: path.join(DSH_HOME, '.agent-presets'),
    profilesDir: path.join(DSH_HOME, 'profiles'),
    ...(existsSync('/home/esuarez/projects/dsh-key-pooler/lib/config.js') ? { keyPoolerConfigPath: '/home/esuarez/projects/dsh-key-pooler/lib/config.js' } : {})
  },
  patches: patchCandidates,
  org,
  ...(ProfileName !== undefined && ProfileName !== '' ? { profile: ProfileName } : {}),
  ...(catalogSources.length > 0 ? { catalogSources } : {}),
  ...(mode === 'subtractive' ? { candidateSettingsText: candidatePath !== undefined && existsSync(candidatePath) ? readFileSync(candidatePath, 'utf8') : '' } : {})
})

process.stdout.write(renderRunReport(result) + '\n')

// WRITE-GUARD (puerta 2): retirar un id AÚN referenciado por un pin desplegado
// es el cambio que congeló el org. Añadir un id siempre es OK (aditiva-first).
if (mode === 'subtractive' && result.retiredStillPinned.length > 0) {
  const phase = process.env.DSH_MPC_PHASE ?? ''
  if (phase !== 'subtractive-after-deploy') {
    process.stdout.write(
      `[MPC-PREFLIGHT] REJECTED (subtractive catalog edit): the candidate settings.yaml RETIRES id(s) still referenced by a deployed pin — ${result.retiredStillPinned.join(', ')}. ` +
      'Contract: ADD the new id FIRST (additive), deploy + verify + re-materialize handles, and only THEN retire the legacy id in a SEPARATE phase. ' +
      'To proceed anyway the phase MUST be declared explicitly: DSH_MPC_PHASE=subtractive-after-deploy (and the deploy pre-flight must still pass).\n'
    )
    process.exit(3)
  }
}

// EXIT (contrato real del header): 2 = BLOQUEO del invariante. La mitad runtime
// ausente SIN `--catalog` bloquea en deploy/check (F5) porque `decide()` ya lo
// devuelve como `blocked` — no hay un camino silencioso a un 0.
if ((mode === 'deploy' || mode === 'check') && result.decision === 'blocked') process.exit(2)
if (mode === 'deploy' && result.decision === 'degraded') process.exit(2)
process.exit(0)
