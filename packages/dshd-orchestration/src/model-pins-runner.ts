// dshd-orchestration — MPC-PREFLIGHT (lane IPD; spec CONGELADA del QD
// .dsh/reports/quality/2026-09-10-incidente-congelacion-modelo-prevencion.md
// §4.2/§5). El RUNNER del guard de coherencia pines↔catálogo vivo: la única
// superficie con I/O del núcleo puro ./model-pins.ts.
//
// QUÉ HACE (las 4 puertas del §4.2):
//   1. DEPLOY PRE-FLIGHT (BLOQUEANTE, fail-loud, exit ≠ 0): enumerar TODOS los
//      pines P1..P4 (+ P6 read-only) contra el catálogo vivo (settings.yaml
//      estático + la primitiva runtime llm.listModels cuando existe) y ABORTAR
//      si P ⊄ C. Ejecución 1 ANTES de la fase live; ejecución 2 DESPUÉS del
//      build+plugin add y ANTES del smart_restart. PROHIBIDO el fail-open de
//      las puertas 1-2: sin fuente estática legible el guard BLOQUEA (un
//      subconjunto prohibido puede estar activo; un «ok» silencioso es
//      exactamente el fallo del 09-10).
//   2. WRITE-GUARD DEFENSIVO del catálogo subtractivo: el modo `subtractive`
//      compara el contenido NUEVO de settings.yaml (stdin) contra el vigente y
//      responde si RETIRA un id referenciado por un pin desplegado (rechazo /
//      exigencia del flag de fase explícito `subtractive-after-deploy`). Un id
//      AÑADIDO siempre es OK (ADITIVA-FIRST: el catálogo es superconjunto por
//      construcción).
//   3. BOOT (NO bloqueante, JAMÁS un ok silencioso): el modo `boot` devuelve la
//      marca DEGRADED + la lista de pares ausentes; el wiring de boot emite la
//      alerta con interrupt al host + el finding durable + la marca.
//   4. MINT/ROTATE: el probe R2 existente (probeRotationMintModel) se conserva
//      y se EXTIENDE al punto de materialización create/resume de heads Y
//      workers (delivery.ts) — la puerta por la que pasó el incidente.
//
// READ-ONLY sobre el home vivo (A6): el guard NUNCA escribe settings.yaml, no
// auto-restaura legacy, no reinicia, no retira handles. Sus ÚNICAS escrituras
// son (a) la fila durable de alerta en el canal existente
// `<stateDir>/health-alerts.jsonl` y (b) la marca DEGRADED
// `<stateDir>/mpc-preflight-state.json` — ambas bajo el stateDir del runtime.
//
// NO export default (pitfall 0001 — breaks `inject`).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseLlmPiAiProviderSettings, readLlmPiAiProviderSettings } from 'dshd-pooler'
import {
  buildCoherenceReport,
  comparePinsAgainstCatalogSources,
  pinLabel,
  WORKER_AGENT_OPTIONS,
  HOST_AGENT_OPTIONS
} from './model-pins.js'
import type {
  AgentPinOptions,
  LiveCatalogSource,
  ModelPin,
  ModelPinCoherenceReport,
  ModelPinGateDecision,
  ModelPinTramo,
  ModelPinVerdict
} from './model-pins.js'

/** El fichero del ledger de marcas del guard (`<stateDir>/…`). */
export const MPC_PREFLIGHT_STATE_FILE = 'mpc-preflight-state.json'

/** El cap de filas del canal de alertas — MISMO valor que
 * HEALTH_ALERTS_MAX_LINES de dshd-health (el guard NO importa ese paquete: el
 * seam lo reserva la lane fb-337, serial detrás de ésta). Un cambio de cap en
 * dshd-health deja al guard escribiendo un fichero con la forma correcta (la
 * fila es idéntica; sólo el truncado antiguo difiere). */
export const MPC_PREFLIGHT_ALERT_MAX_LINES = 500

/** El postId SINTÉTICO del finding durable de la puerta de boot (mismo patrón
 * que PROVIDER_ADAPTER_CHECK_POST_ID de dshd-pooler: un id que jamás minta el
 * registro, para que el daemon de salud lo surfacee como anomalía). */
export const MPC_PREFLIGHT_POST_ID = 'mpc-preflight'

// ---------------------------------------------------------------------------
// Enumeración de pines — P1/P2/P3/P4 sobre ficheros REALES
// ---------------------------------------------------------------------------

/** Extrae el par provider/model de un bloque `agentOptions:` (cualquier
 * indentación) y, opcionalmente, el bloque `agent-default-model.config`.
 * PARSER ACOTADO + HONESTO: es un lector de la forma REAL de estos ficheros
 * (documentos YAML de configuración del harness, sin anclas ni multi-doc), no
 * un parser YAML general. Devuelve además los `problems` encontrados para que
 * el guard NUNCA convierta un fallo de lectura en un «ok» implícito. */
function extractAgentOptionsPins(text: string): { pins: AgentPinOptions[]; problems: string[] } {
  const pins: AgentPinOptions[] = []
  const problems: string[] = []
  const lines = text.split('\n')
  const indentOf = (line: string): number => {
    const m = /^\s*/.exec(line)
    return m ? m[0].length : 0
  }
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    const trimmed = raw.trim()
    if (!/^agentOptions\s*:\s*$/.test(trimmed)) continue
    const blockIndent = indentOf(raw)
    let provider = ''
    let model = ''
    for (let j = i + 1; j < lines.length; j += 1) {
      const inner = lines[j] ?? ''
      const innerTrimmed = inner.trim()
      if (innerTrimmed === '' || innerTrimmed.startsWith('#')) continue
      if (indentOf(inner) <= blockIndent) break
      const providerMatch = /^provider\s*:\s*(.+)$/.exec(innerTrimmed)
      if (providerMatch !== null && provider === '') provider = (providerMatch[1] ?? '').replace(/^['"]|['"]$/g, '').trim()
      const modelMatch = /^model\s*:\s*(.+)$/.exec(innerTrimmed)
      if (modelMatch !== null && model === '') model = (modelMatch[1] ?? '').replace(/^['"]|['"]$/g, '').trim()
    }
    if (provider !== '' || model !== '') pins.push({ provider, model })
    else problems.push(`an "agentOptions:" block declares neither provider nor model (line ${i + 1})`)
  }
  // P1 — el bloque `agent-default-model:` de settings.yaml / del perfil raíz.
  // Acotado por INDENTACIÓN (no un lookahead suelto: un `[\s\S]*?` sobre el
  // fichero entero capturaría la PRIMERA aparición en cualquier parte y leería
  // el provider/model de un bloque posterior).
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    if (!/^agent-default-model\s*:\s*$/.test(raw.trim())) continue
    if (raw.length - raw.trimStart().length !== 0) continue
    const block: string[] = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const inner = lines[j] ?? ''
      if (inner.trim() !== '' && inner.length - inner.trimStart().length === 0) break
      block.push(inner)
    }
    const body = block.join('\n')
    const provider = /^\s+provider\s*:\s*(.+)$/m.exec(body)
    const model = /^\s+model\s*:\s*(.+)$/m.exec(body)
    if (provider !== null || model !== null) {
      pins.push({
        provider: (provider?.[1] ?? '').replace(/^['"]|['"]$/g, '').trim(),
        model: (model?.[1] ?? '').replace(/^['"]|['"]$/g, '').trim()
      })
    }
    break
  }
  return { pins, problems }
}

/** Extrae los pines `agentOptions` de un fichero de PRESET live / patch de
 * perfil. Un fichero ilegible NO se omite en silencio: devuelve un problem. */
export function readAgentOptionsPinsFromFile(filePath: string, ref: string, tramo: ModelPinTramo, sourceClass: string): { pins: ModelPin[]; problems: string[] } {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error: unknown) {
    return { pins: [], problems: [`${ref}: unreadable (${error instanceof Error ? error.message : String(error)})`] }
  }
  const { pins, problems } = extractAgentOptionsPins(text)
  return {
    pins: pins.map((pin) => ({ ...pin, source: { tramo, class: sourceClass, ref } })),
    problems: problems.map((p) => `${ref}: ${p}`)
  }
}

/** Los patrones de fichero que el runner trata como PRESET/settings por
 * defecto (overridables en tests; JAMÁS escritos). */
export interface MpcPreflightPaths {
  /** El settings.yaml del home vivo (default `<dshHome>/settings.yaml`). */
  settingsYaml?: string
  /** El directorio de presets live (default `<dshHome>/.agent-presets`). */
  agentPresetsDir?: string
  /** Los perfiles del harness home (default `<dshHome>/profiles`) — tramo P6. */
  profilesDir?: string
  /** El repo hermano del key-pooler (default `/home/esuarez/projects/dsh-key-pooler`) — tramo P6. */
  keyPoolerConfigPath?: string
}

/** Los PINES AUXILIARES (tramo P6) — evidencia del incidente §4.2/P6: el twin
 * sigue pinneando `deepseek-v4-flash-vision-exp` con un provider
 * `deepseek-official` NO configurado, y el key-pooler tiene el default de
 * código legacy `probeModel: 'deepseek-v4-flash'` tapado por la fila live.
 *
 * NO son el conjunto que bloquea el restart del perfil ACTIVO (el twin es otro
 * perfil; el probeModel del pooler es el default de otro repo) — pero tampoco
 * pueden callarse: van como HALLazgo (aviso) del mismo informe. */
export function readAuxiliaryPins(paths: MpcPreflightPaths = {}): { pins: ModelPin[]; problems: string[] } {
  const pins: ModelPin[] = []
  const problems: string[] = []
  const profilesDir = paths.profilesDir
  if (profilesDir !== undefined && existsSync(profilesDir)) {
    let entries: string[] = []
    try {
      entries = readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    } catch (error: unknown) {
      problems.push(`profiles dir unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const profile of entries) {
      const patch = path.join(profilesDir, profile, 'cordis.patch.yml')
      if (!existsSync(patch)) continue
      const read = readAgentOptionsPinsFromFile(patch, `profiles/${profile}/cordis.patch.yml`, 'P6', 'twin-profile')
      pins.push(...read.pins)
      problems.push(...read.problems)
    }
  }
  const keyPoolerConfigPath = paths.keyPoolerConfigPath
  if (keyPoolerConfigPath !== undefined && existsSync(keyPoolerConfigPath)) {
    try {
      const text = readFileSync(keyPoolerConfigPath, 'utf8')
      // `probeModel: '<id>'` (el default de código del key-pooler — repo
      // hermano, READ-ONLY). El provider del probe es el MISMO del route
      // activo (opencode-zen, la fila live lo tapa hoy).
      const match = /probeModel\s*:\s*['"]([^'"]+)['"]/.exec(text)
      if (match !== null) {
        pins.push({ provider: WORKER_AGENT_OPTIONS.provider, model: match[1] ?? '', source: { tramo: 'P6', class: 'key-pooler-probe', ref: keyPoolerConfigPath } })
      }
    } catch (error: unknown) {
      problems.push(`key-pooler config unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { pins, problems }
}

/** La fila ORG que el runner consume (subconjunto ESTRUCTURAL del org resuelto
 * por el bundle: en el CLI puede faltar; cada campo es opcional y un campo
 * ausente simplemente no aporta pin). */
export interface MpcPreflightOrg {
  workerAgentOptions?: Partial<AgentPinOptions>
  hostAgentOptions?: Partial<AgentPinOptions>
}

/** Enumera el conjunto COMPLETO de pines del runtime sobre ficheros reales.
 * `deps` permite inyectar los ficheros (tests herméticos) sin tocar el home. */
export function resolveModelPins(deps: {
  org?: MpcPreflightOrg
  paths?: MpcPreflightPaths
} = {}): { pins: ModelPin[]; auxiliary: ModelPin[]; problems: string[] } {
  const paths = deps.paths ?? {}
  const pins: ModelPin[] = []
  const problems: string[] = []
  // P3 — las CONSTANTES DE CÓDIGO, importadas del MISMO módulo que el runtime
  // consume (cero drift por literales duplicados).
  pins.push({ ...WORKER_AGENT_OPTIONS, source: { tramo: 'P3', class: 'code-constant', ref: 'packages/dshd-orchestration/src/model-pins.ts WORKER_AGENT_OPTIONS' } })
  pins.push({ ...HOST_AGENT_OPTIONS, source: { tramo: 'P3', class: 'code-constant', ref: 'packages/dshd-orchestration/src/model-pins.ts HOST_AGENT_OPTIONS' } })
  // P2 — la fila ORG (org.workerAgentOptions / org.hostAgentOptions): cuando
  // declara el route, los consumidores usan ESE valor (R4), no la constante.
  if (deps.org?.workerAgentOptions !== undefined) {
    const row = deps.org.workerAgentOptions
    pins.push({ provider: row.provider ?? '', model: row.model ?? '', ...(row.reasoningEffort !== undefined ? { reasoningEffort: row.reasoningEffort } : {}), source: { tramo: 'P2', class: 'org.workerAgentOptions', ref: 'org.workerAgentOptions (cordis.patch.yml)' } })
  }
  if (deps.org?.hostAgentOptions !== undefined) {
    const row = deps.org.hostAgentOptions
    pins.push({ provider: row.provider ?? '', model: row.model ?? '', ...(row.reasoningEffort !== undefined ? { reasoningEffort: row.reasoningEffort } : {}), source: { tramo: 'P2', class: 'org.hostAgentOptions', ref: 'org.hostAgentOptions (cordis.patch.yml)' } })
  }
  // P1/P2/P4 — settings.yaml vivo (agent-default-model) + presets live.
  if (paths.settingsYaml !== undefined) {
    // El `agent-default-model` de settings.yaml es el tramo P1 (el pin con el
    // que el host resuelve cada turno — la vía por la que el host SOBREVIVIÓ al
    // incidente). Otros bloques `agentOptions` del mismo fichero son presets.
    const read = readAgentOptionsPinsFromFile(paths.settingsYaml, `${paths.settingsYaml} agent-default-model`, 'P1', 'agent-default-model')
    pins.push(...read.pins)
    problems.push(...read.problems)
  }
  if (paths.agentPresetsDir !== undefined && existsSync(paths.agentPresetsDir)) {
    let presets: string[] = []
    try {
      presets = readdirSync(paths.agentPresetsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    } catch (error: unknown) {
      problems.push(`agent-presets dir unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const preset of presets) {
      const file = path.join(paths.agentPresetsDir, preset, 'agent.cordis.yml')
      if (!existsSync(file)) continue
      const read = readAgentOptionsPinsFromFile(file, `.agent-presets/${preset}/agent.cordis.yml`, 'P4', 'session-preset')
      pins.push(...read.pins)
      problems.push(...read.problems)
    }
  }
  const aux = readAuxiliaryPins(paths)
  return { pins, auxiliary: aux.pins, problems: [...problems, ...aux.problems] }
}

/** El bloque `org:` de un patch (coordinadores + workerAgentOptions /
 * hostAgentOptions) — el runner lo lee del patch del perfil ACTIVO. */
export function readOrgPinsFromPatch(patchPath: string | undefined): { pins: ModelPin[]; org?: { workerAgentOptions?: AgentPinOptions; hostAgentOptions?: AgentPinOptions }; problems: string[] } {
  if (patchPath === undefined || !existsSync(patchPath)) {
    return { pins: [], problems: patchPath === undefined ? [] : [`${patchPath}: unreadable or absent`] }
  }
  let text: string
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch (error: unknown) {
    return { pins: [], problems: [`${patchPath}: unreadable (${error instanceof Error ? error.message : String(error)})`] }
  }
  const { pins } = extractAgentOptionsPins(text)
  // P2 — las filas de coordinador (agentOptions de cada department). El pin de
  // coordinador es el route que materializa cada head, y NO rotarlo es
  // exactamente lo que el changeset del 09-10 dejó fuera.
  const coordinatorPins: ModelPin[] = pins.map((pin, index) => ({
    ...pin,
    source: { tramo: 'P2', class: 'coordinator.agentOptions', ref: `${patchPath} coordinator #${index + 1}` }
  }))
  const readOpt = (key: string): AgentPinOptions | undefined => {
    // El bloque va ACOTADO POR INDENTACIÓN (la línea `key:` y todo lo más
    // indentado que ella): el `org:` del patch es YAML anidado y un lookahead
    // suelto se tragaría el bloque HERMANO siguiente.
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] ?? ''
      if (!new RegExp(`^\\s*${key}\\s*:\\s*$`).test(raw)) continue
      const baseIndent = raw.length - raw.trimStart().length
      const block: string[] = []
      for (let j = i + 1; j < lines.length; j += 1) {
        const inner = lines[j] ?? ''
        if (inner.trim() !== '' && inner.length - inner.trimStart().length <= baseIndent) break
        block.push(inner)
      }
      const body = block.join('\n')
      const provider = /^\s+provider\s*:\s*(.+)$/m.exec(body)
      const model = /^\s+model\s*:\s*(.+)$/m.exec(body)
      if (provider === null && model === null) return undefined
      return {
        provider: (provider?.[1] ?? '').replace(/^['"]|['"]$/g, '').trim(),
        model: (model?.[1] ?? '').replace(/^['"]|['"]$/g, '').trim()
      }
    }
    return undefined
  }
  const workerAgentOptions = readOpt('workerAgentOptions')
  const hostAgentOptions = readOpt('hostAgentOptions')
  if (workerAgentOptions !== undefined) {
    coordinatorPins.push({ ...workerAgentOptions, source: { tramo: 'P2', class: 'org.workerAgentOptions', ref: `${patchPath} org.workerAgentOptions` } })
  }
  if (hostAgentOptions !== undefined) {
    coordinatorPins.push({ ...hostAgentOptions, source: { tramo: 'P2', class: 'org.hostAgentOptions', ref: `${patchPath} org.hostAgentOptions` } })
  }
  return { pins: coordinatorPins, org: { ...(workerAgentOptions !== undefined ? { workerAgentOptions } : {}), ...(hostAgentOptions !== undefined ? { hostAgentOptions } : {}) }, problems: [] }
}

// ---------------------------------------------------------------------------
// Lado C — el catálogo vivo (vía estática + vía runtime)
// ---------------------------------------------------------------------------

/** La vía ESTÁTICA: `settings.yaml` → `llm-pi-ai.providers[p].models[].id`.
 * Un provider declarado sin lista de ids ES una negación positiva (el adapter
 * no admitiría ningún modelo de ese provider). */
export function staticCatalogFromSettingsYaml(settingsPath: string): LiveCatalogSource & { readable: boolean; problems: string[] } {
  const providers: Record<string, { models: string[]; registered: boolean }> = {}
  const problems: string[] = []
  let readable = false
  if (existsSync(settingsPath)) {
    try {
      const parsed = parseLlmPiAiProviderSettings(readFileSync(settingsPath, 'utf8'))
      for (const [id, profile] of Object.entries(parsed)) {
        providers[id] = { models: [...(profile.modelIds ?? [])], registered: true }
      }
      readable = Object.keys(providers).length > 0
      if (!readable) problems.push(`${settingsPath}: parsed but declares NO llm-pi-ai provider (no catalog)`)
    } catch (error: unknown) {
      problems.push(`${settingsPath}: parse failed (${error instanceof Error ? error.message : String(error)})`)
    }
  } else {
    problems.push(`${settingsPath}: absent — NO static catalog source (the invariant cannot be verified)`)
  }
  return { id: 'settings-yaml', providers, readable, problems }
}

/** La vía RUNTIME (la primitiva del probe R2): `llm.listProviders()` +
 * `llm.listModels(provider)`. Fail-loud en su AUSENCIA: devuelve `undefined`
 * (nunca un catálogo vacío que se leería como «todo ausente»). */
export async function runtimeCatalogFromLlm(llm: unknown): Promise<{ source: LiveCatalogSource; problems: string[] } | undefined> {
  const problems: string[] = []
  const surface = llm as { listProviders?: () => Array<{ id?: string }>; listModels?: (provider: string) => Promise<Array<string | { id?: string }>> } | undefined
  if (surface === undefined || typeof surface.listProviders !== 'function' || typeof surface.listModels !== 'function') {
    problems.push('the "llm" surface is absent (headless/hermetic profile or not injected) — the RUNTIME half of the check could not run (never a silent ok)')
    return undefined
  }
  const providers: Record<string, { models: string[]; registered: boolean }> = {}
  try {
    for (const provider of surface.listProviders() ?? []) {
      const id = provider?.id
      if (typeof id !== 'string' || id === '') continue
      try {
        const models = await surface.listModels(id)
        providers[id] = { models: (models ?? []).map((m) => (typeof m === 'string' ? m : m?.id)).filter((x): x is string => typeof x === 'string'), registered: true }
      } catch (error: unknown) {
        problems.push(`llm.listModels("${id}") failed (${error instanceof Error ? error.message : String(error)})`)
      }
    }
  } catch (error: unknown) {
    problems.push(`llm.listProviders() failed (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
  return { source: { id: 'runtime-llm', providers }, problems }
}

// ---------------------------------------------------------------------------
// El informe sobre pines REALES + la escritura de la marca/alerta durable
// ---------------------------------------------------------------------------

/** El informe del runner: el del núcleo puro + los metadatos de ejecución. */
export interface MpcPreflightRunResult {
  mode: MpcPreflightMode
  decision: ModelPinGateDecision
  report: ModelPinCoherenceReport
  /** Los pines AUXILIARES (P6) que NO están cubiertos — HALLAZGO (aviso),
   * NUNCA bloqueo ni DEGRADED del perfil activo (el twin es otro perfil; el
   * probeModel del key-pooler es el default de otro repo). Se reportan para que
   * un tramo FUERA del bundle del org no quede invisible (§4.2/P6). */
  auxiliaryFindings: ModelPinVerdict[]
  pinCount: number
  auxiliaryCount: number
  problems: string[]
  /** Los ids RETIRADOS aún referenciados por un pin desplegado (subtractive). */
  retiredStillPinned: string[]
}

/** Los modos del guard (§4.2, las 4 puertas). `deploy` = puertas 1-2
 * (BLOQUEANTE), `boot` = puerta 3 (DEGRADED, nunca ok silencioso),
 * `mint` = puerta 4 (abort fail-loud del mint), `subtractive` = write-guard
 * defensivo del catálogo subtractivo, `check` = informe read-only sin efectos. */
export type MpcPreflightMode = 'deploy' | 'boot' | 'mint' | 'subtractive' | 'check'

/** Los efectos inyectables (tests herméticos: sin home vivo). */
export interface MpcPreflightRunDeps {
  stateDir?: string
  /** El modo/puerta (default 'deploy'; con `candidateSettingsText` → 'subtractive'). */
  mode?: MpcPreflightMode
  org?: MpcPreflightOrg
  paths?: MpcPreflightPaths
  /** Los patches del perfil ACTIVO (root del repo + perfil) — tramo P2. */
  patches?: string[]
  llm?: unknown
  /** El settings.yaml CANDIDATO del modo `subtractive` (el contenido nuevo). */
  candidateSettingsText?: string
  now?: () => number
  /** Escribe la fila durable + la marca DEGRADED (default false = dry-run; el
   * CLI/wiring lo activa explícitamente). */
  persist?: boolean
  /** El sink de alerta al host (in-process). El runner NO depende del bundle:
   * si está ausente, la fila durable es la única señal (nunca un ok silencioso). */
  hostAlertSink?: (frame: { message: string; missing: string[]; postId: string }) => void
}

/** Decide si el par (provider, model) del HANDLE sigue siendo servible por el
 * catálogo vivo (usado por el wiring de re-materialización — P5). */
export function handleRouteServable(handleOptions: AgentPinOptions | undefined, sources: readonly LiveCatalogSource[]): boolean {
  const provider = (handleOptions?.provider ?? '').trim()
  const model = (handleOptions?.model ?? '').trim()
  if (provider === '' || model === '') return true // fb-6 owns this class
  const verdict = comparePinsAgainstCatalogSources([{ provider, model, source: { tramo: 'P1', class: 'handle', ref: 'live handle' } }], sources)[0]
  return verdict?.kind !== 'unknown-model'
}

/** La fila durable del canal de alertas — escritura SÍNCRONA (misma forma,
 * mismo cap): la usa la puerta de BOOT, que corre en el arranque del bundle y
 * NO debe solapar trabajo asíncrono con el ciclo de vida del stateDir del
 * runtime (una promesa de E/S que aterriza después de que el contexto se
 * disponga escribe en un directorio ya retirado). La vía asíncrona
 * (appendMpcAlertRow) queda para el CLI. Nunca lanza. */
export function appendMpcAlertRowSync(stateDir: string, row: { ts: number; findings: Array<Record<string, unknown>>; dedupeKeys: string[] }): void {
  try {
    const filePath = path.join(stateDir, 'health-alerts.jsonl')
    mkdirSync(stateDir, { recursive: true })
    let lines: string[] = []
    try {
      lines = readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim() !== '')
    } catch {
      lines = []
    }
    lines.push(JSON.stringify(row))
    const bounded = lines.slice(-MPC_PREFLIGHT_ALERT_MAX_LINES)
    writeFileSync(filePath, bounded.join('\n') + '\n', 'utf8')
  } catch {
    /* a persistence failure never throws into the caller (the caller logs) */
  }
}

/** La marca DEGRADED — escritura SÍNCRONA (ver appendMpcAlertRowSync). */
export function writeMpcPreflightStateSync(stateDir: string, state: Record<string, unknown>): string {
  const filePath = path.join(stateDir, MPC_PREFLIGHT_STATE_FILE)
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
  } catch {
    /* best-effort marker — never fatal */
  }
  return filePath
}

/** Escribe UNA fila durable en `<stateDir>/health-alerts.jsonl` con la FORMA
 * exacta del canal (ts/findings[]/dedupeKeys[]) —append + cap, mismo patrón que
 * appendHealthAlertAudit de dshd-health (que NO se importa: seam reservado por
 * la lane fb-337). Nunca lanza. */
export async function appendMpcAlertRow(stateDir: string, row: { ts: number; findings: Array<Record<string, unknown>>; dedupeKeys: string[] }): Promise<void> {
  appendMpcAlertRowSync(stateDir, row)
}

/** Escribe la marca DEGRADED del guard (visible + durable). */
export async function writeMpcPreflightState(stateDir: string, state: Record<string, unknown>): Promise<string> {
  const filePath = path.join(stateDir, MPC_PREFLIGHT_STATE_FILE)
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await rename(tmp, filePath)
  } catch {
    /* best-effort marker — never fatal */
  }
  return filePath
}

/**
 * EL RUN del guard sobre los pines REALES. No bloquea por sí mismo: devuelve la
 * disposición y (según el modo) emite los efectos durables. El caller (CLI o
 * wiring de boot) mapea `blocked` a exit ≠ 0 / abortar.
 *
 * `syncOnly: true` (la PUERTA DE BOOT) omite la vía RUNTIME (`llm.listModels`,
 * que es asíncrona) y la sustituye por el hallazgo explícito «runtime half not
 * consulted»: el boot debe terminar su comprobación —y sus escrituras— dentro
 * del turno en que arranca, sin trabajo asíncrono que aterrice después de que
 * el contexto se haya dispuesto. NUNCA es un «ok» silencioso (el problema se
 * declara y la puerta de boot es no-bloqueante por diseño).
 */
export function runMpcPreflightSync(deps: MpcPreflightRunDeps = {}): MpcPreflightRunResult {
  const mode: MpcPreflightMode = deps.mode ?? (deps.candidateSettingsText !== undefined ? 'subtractive' : 'deploy')
  const phase: 'deploy-preflight' | 'boot' | 'mint' = mode === 'boot' ? 'boot' : mode === 'mint' ? 'mint' : 'deploy-preflight'
  const paths = deps.paths ?? {}
  // P2 — las filas de coordinador + org.workerAgentOptions/hostAgentOptions del
  // patch del perfil ACTIVO (y del root del repo cuando existe).
  const pinSet: ModelPin[] = []
  const problems: string[] = []
  for (const patch of deps.patches ?? []) {
    const read = readOrgPinsFromPatch(patch)
    pinSet.push(...read.pins)
    problems.push(...read.problems)
  }
  const enumerados = resolveModelPins({ ...(deps.org !== undefined ? { org: deps.org } : {}), paths })
  pinSet.push(...enumerados.pins)
  problems.push(...enumerados.problems)
  // Conjunto C — vía estática (settings.yaml) + vía runtime (llm.listModels).
  const settingsPath = paths.settingsYaml
  const staticSource = settingsPath !== undefined ? staticCatalogFromSettingsYaml(settingsPath) : undefined
  if (staticSource !== undefined) problems.push(...staticSource.problems)
  const sources: LiveCatalogSource[] = []
  if (staticSource !== undefined && staticSource.readable) sources.push({ id: staticSource.id, providers: staticSource.providers })
  problems.push('the RUNTIME catalog source was not consulted on this gate (the boot door runs SYNCHRONOUSLY — the static catalog half is the evidence; never a silent ok)')
  const report = buildCoherenceReport({ pins: pinSet, sources, phase })
  // Los pines AUXILIARES: TODA no-cobertura se reporta (unknown-model,
  // NO_ADAPTER y también `unknown` — el twin declara un provider que NO existe
  // en el catálogo del home, que es justo el hallazgo del §4.2/P6). NUNCA
  // entran en la decisión del perfil activo.
  const auxVerdicts = comparePinsAgainstCatalogSources(enumerados.auxiliary, sources).filter((v) => v.kind !== 'ok')
  // Write-guard defensivo del catálogo subtractivo (puerta 2).
  let retiredStillPinned: string[] = []
  if (mode === 'subtractive') {
    const currentText = settingsPath !== undefined && existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
    retiredStillPinned = subtractiveRetirement({ currentSettingsText: currentText, candidateSettingsText: deps.candidateSettingsText ?? '', pins: pinSet })
  }
  const result: MpcPreflightRunResult = {
    mode,
    decision: report.decision,
    report,
    auxiliaryFindings: auxVerdicts,
    pinCount: pinSet.length,
    auxiliaryCount: enumerados.auxiliary.length,
    problems,
    retiredStillPinned
  }
  const stateDir = deps.stateDir
  if (deps.persist === true && stateDir !== undefined) {
    const ts = (deps.now ?? Date.now)()
    const missing = [...report.missing.map((v) => pinLabel(v.pin)), ...result.retiredStillPinned.map((id) => `retired-but-pinned:${id}`)]
    const degraded = report.decision !== 'allow' || retiredStillPinned.length > 0
    const key = `mpc-preflight:${mode}`
    appendMpcAlertRowSync(stateDir, {
      ts,
      findings: [
        {
          kind: 'config-preset',
          key,
          postId: MPC_PREFLIGHT_POST_ID,
          ts,
          error: renderRunReport(result),
          count: Math.max(1, missing.length),
          // §4.2 puerta 3: la alerta va CON INTERRUPT al host. El flag es el
          // carrier explícito del hallazgo (la entrega la ejecuta el daemon de
          // salud, que es el dueño del canal); NUNCA una sustitución de modelo.
          recipients: ['host'],
          interrupt: true,
          degraded
        }
      ],
      dedupeKeys: [key]
    })
    writeMpcPreflightStateSync(stateDir, {
      ts,
      mode,
      decision: report.decision,
      degraded,
      missing,
      pins: pinSet.map((pin) => pinLabel(pin)),
      message: report.message,
      retiredStillPinned
    })
    if (degraded && deps.hostAlertSink !== undefined) {
      try {
        deps.hostAlertSink({ message: renderRunReport(result), missing, postId: MPC_PREFLIGHT_POST_ID })
      } catch {
        /* the sink is best-effort; the durable row above is the contract */
      }
    }
  }
  return result
}

/** La vía ASÍNCRONA (CLI/deploy): el mismo núcleo + la consulta RUNTIME
 * (`llm.listModels`, la primitiva del probe R2) — las puertas 1-2 exigen la
 * COINCIDENCIA de ambas vías, así que su ausencia se declara como problema. */
export async function runMpcPreflight(deps: MpcPreflightRunDeps = {}): Promise<MpcPreflightRunResult> {
  const mode: MpcPreflightMode = deps.mode ?? (deps.candidateSettingsText !== undefined ? 'subtractive' : 'deploy')
  const phase: 'deploy-preflight' | 'boot' | 'mint' = mode === 'boot' ? 'boot' : mode === 'mint' ? 'mint' : 'deploy-preflight'
  const paths = deps.paths ?? {}
  // P2 — las filas de coordinador + org.workerAgentOptions/hostAgentOptions del
  // patch del perfil ACTIVO (y del root del repo cuando existe).
  const pinSet: ModelPin[] = []
  const problems: string[] = []
  for (const patch of deps.patches ?? []) {
    const read = readOrgPinsFromPatch(patch)
    pinSet.push(...read.pins)
    problems.push(...read.problems)
  }
  const enumerados = resolveModelPins({ ...(deps.org !== undefined ? { org: deps.org } : {}), paths })
  pinSet.push(...enumerados.pins)
  problems.push(...enumerados.problems)
  // Conjunto C — vía estática (settings.yaml) + vía runtime (llm.listModels).
  const settingsPath = paths.settingsYaml
  const staticSource = settingsPath !== undefined ? staticCatalogFromSettingsYaml(settingsPath) : undefined
  if (staticSource !== undefined) problems.push(...staticSource.problems)
  const sources: LiveCatalogSource[] = []
  if (staticSource !== undefined && staticSource.readable) sources.push({ id: staticSource.id, providers: staticSource.providers })
  const runtime = await runtimeCatalogFromLlm(deps.llm)
  if (runtime !== undefined) {
    sources.push(runtime.source)
    problems.push(...runtime.problems)
  } else {
    problems.push('the RUNTIME catalog source is absent — the static half alone would be a silent ok (never accepted on the boot/deploy gates)')
  }
  const report = buildCoherenceReport({ pins: pinSet, sources, phase })
  // Los pines AUXILIARES: TODA no-cobertura se reporta (unknown-model,
  // NO_ADAPTER y también `unknown` — el twin declara un provider que NO existe
  // en el catálogo del home, que es justo el hallazgo del §4.2/P6). NUNCA
  // entran en la decisión del perfil activo.
  const auxVerdicts = comparePinsAgainstCatalogSources(enumerados.auxiliary, sources).filter((v) => v.kind !== 'ok')
  // Write-guard defensivo del catálogo subtractivo (puerta 2).
  let retiredStillPinned: string[] = []
  if (mode === 'subtractive') {
    const currentText = settingsPath !== undefined && existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
    retiredStillPinned = subtractiveRetirement({ currentSettingsText: currentText, candidateSettingsText: deps.candidateSettingsText ?? '', pins: pinSet })
  }
  const result: MpcPreflightRunResult = {
    mode,
    decision: report.decision,
    report,
    auxiliaryFindings: auxVerdicts,
    pinCount: pinSet.length,
    auxiliaryCount: enumerados.auxiliary.length,
    problems,
    retiredStillPinned
  }
  // Efectos durables: la marca DEGRADED + la fila del canal de alertas (boot) —
  // NUNCA en modo check (read-only puro) y nunca fuera del stateDir.
  const stateDir = deps.stateDir
  if (deps.persist === true && stateDir !== undefined && (mode === 'boot' || mode === 'deploy' || mode === 'subtractive')) {
    const ts = (deps.now ?? Date.now)()
    const missing = [...report.missing.map((v) => pinLabel(v.pin)), ...result.retiredStillPinned.map((id) => `retired-but-pinned:${id}`)]
    const degraded = report.decision !== 'allow' || retiredStillPinned.length > 0
    const key = `mpc-preflight:${mode}`
    await appendMpcAlertRow(stateDir, {
      ts,
      findings: [
        {
          kind: 'config-preset',
          key,
          postId: MPC_PREFLIGHT_POST_ID,
          ts,
          error: renderRunReport(result),
          count: Math.max(1, missing.length),
          // §4.2 puerta 3: la alerta va CON INTERRUPT al host. El flag es el
          // carrier explícito del hallazgo (la entrega la ejecuta el daemon de
          // salud, que es el dueño del canal); NUNCA una sustitución de modelo.
          recipients: ['host'],
          interrupt: true,
          degraded
        }
      ],
      dedupeKeys: [key]
    })
    await writeMpcPreflightState(stateDir, {
      ts,
      mode,
      decision: report.decision,
      degraded,
      missing,
      pins: pinSet.map((pin) => pinLabel(pin)),
      message: report.message,
      retiredStillPinned
    })
    if (degraded && deps.hostAlertSink !== undefined) {
      try {
        deps.hostAlertSink({ message: renderRunReport(result), missing, postId: MPC_PREFLIGHT_POST_ID })
      } catch {
        /* the sink is best-effort; the durable row above is the contract */
      }
    }
  }
  return result
}

/** El modo del guard en el proceso actual (el brief lo usa para detectar que
 * corre DENTRO del runtime vivo). `DSH_MPC_MODE` es la señal EXPLÍCITA del
 * runner de deploy; en su ausencia, un `node_modules` en las rutas del
 * ejecutable sólo puede ser el plugin instalado (⇒ boot). */
export function resolveGuardMode(argv: readonly string[] = process.argv, env: Record<string, string | undefined> = process.env): 'deploy' | 'boot' {
  const explicit = (env.DSH_MPC_MODE ?? '').trim().toLowerCase()
  if (explicit === 'deploy' || explicit === 'boot') return explicit
  const exe = argv[1] ?? ''
  return exe.includes(`${path.sep}node_modules${path.sep}`) ? 'boot' : 'deploy'
}

/** El texto del CLI: un mensaje accionable ÚNICO (§4.2) con provider, model,
 * tramo y el fichero/constante que lo fija. */
export function renderRunReport(result: MpcPreflightRunResult): string {
  const lines: string[] = []
  lines.push(`[MPC-PREFLIGHT] mode=${result.mode} decision=${result.decision} pins=${result.pinCount} auxiliary=${result.auxiliaryCount}`)
  if (result.report.message !== '') lines.push(result.report.message)
  for (const verdict of result.report.missing) lines.push(`  MISSING ${pinLabel(verdict.pin)} — tramo ${verdict.pin.source.tramo} (${verdict.pin.source.class}) fixed by ${verdict.pin.source.ref}`)
  for (const verdict of result.report.unverifiable) lines.push(`  UNVERIFIED ${pinLabel(verdict.pin)} — tramo ${verdict.pin.source.tramo} (${verdict.pin.source.class}): ${verdict.detail}`)
  for (const verdict of result.report.noAdapter) lines.push(`  NO_ADAPTER ${pinLabel(verdict.pin)} — ${verdict.detail}`)
  for (const verdict of result.auxiliaryFindings) lines.push(`  AUX(${verdict.kind}) ${pinLabel(verdict.pin)} — tramo ${verdict.pin.source.tramo} (${verdict.pin.source.class}) ref ${verdict.pin.source.ref}: ${verdict.detail}`)
  for (const problem of result.problems) lines.push(`  PROBLEM ${problem}`)
  return lines.join('\n')
}

/** El `subtractive verdict`: ¿el contenido NUEVO retira un id referenciado por
 * un pin desplegado? Devolver la lista de ids RETIRADOS aún referenciados (el
 * caller rechaza / exige el flag de fase explícito). Un id AÑADIDO nunca entra
 * aquí (ADITIVA-FIRST: añadir siempre es OK). */
export function subtractiveRetirement({
  currentSettingsText,
  candidateSettingsText,
  pins
}: {
  currentSettingsText: string
  candidateSettingsText: string
  pins: readonly ModelPin[]
}): string[] {
  const before = parseLlmPiAiProviderSettings(currentSettingsText)
  const after = parseLlmPiAiProviderSettings(candidateSettingsText)
  const retired: string[] = []
  for (const [provider, profile] of Object.entries(before)) {
    const beforeIds = profile.modelIds ?? []
    const afterIds = new Set((after[provider]?.modelIds ?? []).map((id) => id.toLowerCase()))
    for (const id of beforeIds) {
      if (afterIds.has(id.toLowerCase())) continue
      if (pins.some((pin) => pin.provider === provider && pin.model.toLowerCase() === id.toLowerCase())) retired.push(`${provider}/${id}`)
    }
  }
  return retired
}

/** Re-lectura del catálogo vivo por la vía del pooler (helper para wiring). */
export function readStaticModelIds(stateDir: string): Record<string, string[]> {
  const settings = readLlmPiAiProviderSettings(stateDir)
  const out: Record<string, string[]> = {}
  for (const [provider, profile] of Object.entries(settings)) out[provider] = [...(profile.modelIds ?? [])]
  return out
}
