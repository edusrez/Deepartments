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
// EXIT: 0 = invariante I-MP verificado (allow) · NON-ZERO = BLOQUEO (fail-loud,
// nunca fail-open). El guard es READ-ONLY sobre el home vivo: sólo escribe la
// marca DEGRADED y la fila durable del canal de alertas bajo el stateDir.
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
const settingsYaml = argOf('settings', path.join(DSH_HOME, 'settings.yaml'))

// Los patches del perfil ACTIVO + del root del repo (tramo P2: filas de
// coordinador + org.workerAgentOptions/hostAgentOptions).
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

if (mode === 'deploy' && result.decision === 'blocked') process.exit(2)
if (mode === 'check' && result.decision === 'blocked') process.exit(2)
process.exit(0)
