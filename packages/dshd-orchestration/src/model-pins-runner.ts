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
// F9 (gate unit-2) — REPARTO DE ESCRITURA, y es una regla, no un detalle:
//   (a) el CANAL COMPARTIDO (`health-alerts.jsonl`, compartido con el daemon de
//       salud) se escribe SÓLO POR APPEND: una línea por corrida, sin leer, sin
//       truncar y sin reescribir el fichero. Un read-modify-write ahí pierde en
//       silencio la fila del otro escritor — justo el canal con el que se
//       detectaría el próximo incidente.
//   (b) TODO read-modify-write del guard vive en su estado PROPIO
//       (`mpc-preflight-state.json`): latches, decisión, sello de entrada (F8) y
//       contadores. Si el guard necesitara dedupe, se calcula contra ESE estado.
//
// NO export default (pitfall 0001 — breaks `inject`).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseLlmPiAiProviderSettings, readLlmPiAiProviderSettings } from 'dshd-pooler'
import {
  buildCoherenceReport,
  builtinCatalogSource,
  BUILTIN_CATALOG_SOURCE_ID,
  comparePinsAgainstCatalogSources,
  pinLabel,
  runtimeHalfConsulted,
  WORKER_AGENT_OPTIONS,
  HOST_AGENT_OPTIONS
} from './model-pins.js'
import type {
  AgentPinOptions,
  LiveCatalogSource,
  ModelPin,
  ModelPinCoherenceReport,
  ModelPinGateDecision,
  ModelPinInputsStamp,
  ModelPinTramo,
  ModelPinVerdict
} from './model-pins.js'

/** El fichero del ledger de marcas del guard (`<stateDir>/…`). */
export const MPC_PREFLIGHT_STATE_FILE = 'mpc-preflight-state.json'

/** F6 — el fichero de DECLARACIONES de pines benignos (`<stateDir>/…`). Es una
 * DECLARACIÓN HUMANA (opt-in): el guard lo LEE, jamás lo escribe. */
export const MPC_PIN_DECLARATIONS_FILE = 'mpc-pin-declarations.json'

/** El cap de filas que el DUEÑO del canal (dshd-health, HEALTH_ALERTS_MAX_LINES)
 * aplica al podar. El guard YA NO LO APLICA ÉL MISMO: escribir el canal ajeno
 * está PROHIBIDO (F9) — el cap se cita aquí sólo como referencia documental de la
 * forma del canal (el guard NO importa dshd-health: el seam lo reserva la lane
 * fb-337, serial detrás de ésta). */
export const MPC_PREFLIGHT_ALERT_MAX_LINES = 500

/** El postId SINTÉTICO del finding durable de la puerta de boot (mismo patrón
 * que PROVIDER_ADAPTER_CHECK_POST_ID de dshd-pooler: un id que jamás minta el
 * registro, para que el daemon de salud lo surfacee como anomalía). */
export const MPC_PREFLIGHT_POST_ID = 'mpc-preflight'

// ---------------------------------------------------------------------------
// Enumeración de pines — P1/P2/P3/P4 sobre ficheros REALES
// ---------------------------------------------------------------------------

/** Extrae los pines de un texto de configuración. Devuelve además el `line` de
 * cada pin (1-based) para que el `ref` del hallazgo sea `file:line` — el gate
 * unit-2 exige que el tramo P4 sea MEDIBLE (un pin sin su file:line no es
 * accionable).
 *
 * FORMAS QUE RECONOCE (todas sobre los ficheros REALES del harness):
 *  (1) `agentOptions:` en cualquier indentación, con provider/model dentro del
 *      bloque acotado por indentación (la forma clásica, y la del `.bak-*`);
 *  (2) la fila del PERFIL/BUNDLE `- id: <row>` + `config:` cuyo config LLEVA un
 *      `agentOptions:` anidado (la forma de los insert de un `cordis.patch.yml`);
 *  (3) la fila P1 en sus DOS formas: raíz `agent-default-model:` + provider/model,
 *      y la del patch `- id: agent-default-model` + `config:` + provider/model.
 *      El caller decide el TRAMO (`editTramo`, P1 en un patch): hoy todo lo
 *      extraído de un patch salía etiquetado P2 (riesgo R5 del gate).
 * PARSER ACOTADO + HONESTO: es un lector de la forma REAL de estos ficheros
 * (documentos YAML de configuración del harness, sin anclas ni multi-doc), no un
 * parser YAML general. Devuelve además los `problems` encontrados para que el
 * guard NUNCA convierta un fallo de lectura en un «ok» implícito. */
function extractPinEntries(text: string, declaredProviders?: readonly string[]): { entries: Array<{ pin: AgentPinOptions; line: number }>; problems: string[] } {
  const entries: Array<{ pin: AgentPinOptions; line: number }> = []
  const problems: string[] = []
  const lines = text.split('\n')
  const indentOf = (line: string): number => {
    const m = /^\s*/.exec(line)
    return m ? m[0].length : 0
  }
  const unquote = (value: string): string => value.replace(/^['"]|['"]$/g, '').trim()
  /** El cuerpo del bloque indentado que sigue a la línea `startLine`
   * (la línea `key:` y todo lo MÁS indentado que ella). */
  const blockBody = (startLine: number, baseIndent: number): { body: string[]; end: number } => {
    const body: string[] = []
    let j = startLine + 1
    for (; j < lines.length; j += 1) {
      const inner = lines[j] ?? ''
      if (inner.trim() !== '' && indentOf(inner) <= baseIndent) break
      body.push(inner)
    }
    return { body, end: j }
  }
  /** Lee provider/model de un cuerpo YAML. `declaredProviders` (cuando se pasa)
   * acota el parser: una entrada cuyo `provider` NO es un provider del catálogo
   * no es un PIN de modelo (los DOCs del harness usan `provider:` para el
   * SUBAGENTE — `provider: spawn|fork|codex|claude-code` — y `model:` para el
   * modelo de EMBEDDINGS del RAG: tratarlos como pines llenaba el informe de
   * `unknown` de ruido, que es la misma clase de falso positivo que el gate
   * unit-2 reprocha en el tramo P4). */
  const readRoute = (body: readonly string[], declaredProviders?: readonly string[]): { provider?: string; model?: string; keyMismatch: boolean; filteredByProvider: boolean } => {
    let provider: string | undefined
    let model: string | undefined
    let keyMismatch = false
    for (const inner of body) {
      const innerTrimmed = inner.trim()
      if (innerTrimmed === '' || innerTrimmed.startsWith('#')) continue
      const key = /^([A-Za-z0-9_-]+)\s*:/.exec(innerTrimmed)
      if (key !== null && key[1] !== 'provider' && key[1] !== 'model') {
        // Clave hermana/index de nivel superior del bloque: si declara un
        // provider/model por su cuenta, el par es un PIN declarado.
        if (indentOf(inner) <= 6 && /^(agentOptions|options|provider|model)$/.test(key[1] ?? '')) keyMismatch = true
        continue
      }
      const providerMatch = /^provider\s*:\s*(.+)$/.exec(innerTrimmed)
      // Un valor que termina en `:` es una CLAVE anidada, no un valor escalar
      // (`default-model:` no es un provider).
      if (providerMatch !== null && provider === undefined && !/:\s*$/.test(providerMatch[1] ?? '')) provider = unquote(providerMatch[1] ?? '')
      const modelMatch = /^model\s*:\s*(.+)$/.exec(innerTrimmed)
      if (modelMatch !== null && model === undefined && !/:\s*$/.test(modelMatch[1] ?? '')) model = unquote(modelMatch[1] ?? '')
    }
    const undeclared = declaredProviders !== undefined && provider !== undefined && provider !== '' && !declaredProviders.some((id) => id.toLowerCase() === provider?.toLowerCase())
    return {
      ...(undeclared ? {} : { ...(provider !== undefined ? { provider } : {}), ...(model !== undefined ? { model } : {}) }),
      keyMismatch: undeclared ? false : keyMismatch,
      filteredByProvider: undeclared
    }
  }
  const seen = new Set<number>()
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    const trimmed = raw.trim()
    if (!/^agentOptions\s*:\s*$/.test(trimmed)) continue
    const blockIndent = indentOf(raw)
    const { body } = blockBody(i, blockIndent)
    const route = readRoute(body, declaredProviders)
    if ((route.provider ?? '') !== '' || (route.model ?? '') !== '') entries.push({ pin: { provider: route.provider ?? '', model: route.model ?? '' }, line: i + 1 })
    // Un bloque de provider NO declarado (subagente/embeddings) se OMITE en
    // silencio: no es un pin de modelo y reportarlo sería ruido, no señal. Un
    // bloque que NO declara NI provider NI model sí es un problem (lectura rota).
    else if (!route.filteredByProvider) problems.push(`an "agentOptions:" block declares neither provider nor model (line ${i + 1})`)
  }
  // F2 — la fila `- id: <row>` + `config:`. Se enumera cuando su config declara
  // provider/model sin un `agentOptions:` que ya lo cubra (evita duplicar (1)).
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    if (!/^\s*-\s+id\s*:\s*\S/.test(raw)) continue
    const id = /^\s*-\s+id\s*:\s*(\S+)/.exec(raw)?.[1] ?? ''
    const rowIndent = indentOf(raw)
    const rowBody = blockBody(i, rowIndent)
    const isDefaultModelRow = id === 'agent-default-model'
    const configLine = rowBody.body.findIndex((line) => /^\s*config\s*:\s*$/.test(line))
    const configText = configLine < 0 ? rowBody.body.join('\n') : rowBody.body.slice(configLine + 1).join('\n')
    const hasNestedOptions = /^\s*agentOptions\s*:\s*$/m.test(configText)
    if (isDefaultModelRow) {
      const { body } = blockBody(i + configLine + 1, indentOf(rowBody.body[configLine] ?? ''))
      const route = readRoute(configLine < 0 ? rowBody.body : body, declaredProviders)
      if ((route.provider ?? '') !== '' || (route.model ?? '') !== '') {
        entries.push({ pin: { provider: route.provider ?? '', model: route.model ?? '' }, line: i + 1 })
        seen.add(i + 1)
      } else {
        problems.push(`the "agent-default-model" row declares neither provider nor model (line ${i + 1})`)
      }
      continue
    }
    if (hasNestedOptions) continue
    const direct = readRoute(configText.split('\n'), declaredProviders)
    if ((direct.provider ?? '') !== '' || (direct.model ?? '') !== '') {
      entries.push({ pin: { provider: direct.provider ?? '', model: direct.model ?? '' }, line: i + 1 })
      seen.add(i + 1)
    }
  }
  // P1 — la clave RAÍZ `agent-default-model:` de settings.yaml / del perfil
  // raíz. Acotado por INDENTACIÓN (no un lookahead suelto: un `[\s\S]*?` sobre
  // el fichero entero capturaría la PRIMERA aparición en cualquier parte y
  // leería el provider/model de un bloque posterior). Se recorren TODAS las
  // apariciones raíz (la de settings.yaml y, si la hubiera, la del perfil).
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    if (!/^agent-default-model\s*:\s*$/.test(raw.trim())) continue
    if (raw.length - raw.trimStart().length !== 0) continue
    if (seen.has(i + 1)) continue
    const { body } = blockBody(i, 0)
    const route = readRoute(body, declaredProviders)
    if ((route.provider ?? '') !== '' || (route.model ?? '') !== '') entries.push({ pin: { provider: route.provider ?? '', model: route.model ?? '' }, line: i + 1 })
  }
  return { entries, problems }
}

/**
 * F1 (fix-forward del gate unit-2) — LOS PINES DEL TEXTO DE UN PRESET LIVE.
 *
 * El incidente rotó el tramo P4 (1/6 → 6/6) y el lector ESTRUCTURADO medía 0
 * pines sobre los presets VIVOS: los 6 vivos NO tienen ningún bloque
 * `agentOptions:` (sólo los `.bak-*` lo tienen) y el pin real es un LITERAL DE
 * PROMPT (`…/deepartments-worker/agent.cordis.yml:44,55`:
 * «Model: deepseek-flash (provider opencode-zen, reasoning max)»).
 *
 * REGLA CONSERVADORA (deliberadamente estrecha, y escrita aquí como contrato):
 *  (a) se enumeran los bloques ESTRUCTURADOS como hasta ahora (vía
 *      `readAgentOptionsPinsFromFile`), y
 *  (b) se enumeran los pares `<provider>/<model>` del TEXTO de esos ficheros en
 *      sus DOS formas, y SÓLO cuando se cumplen estas condiciones:
 *        b1. el `provider` es uno DECLARADO en el catálogo (la lista `providers`
 *            que se le pasa — nunca se inventa un provider leído de un texto);
 *        b2. las dos partes aparecen en la MISMA línea;
 *        b3. se reconoce la RUTA canónica `<provider>/<model>` O la PROSA
 *            etiquetada `Model: <model> … provider <provider>` (como mucho 200
 *            caracteres entre las dos partes y sin cruzar el salto de línea):
 *            el provider NUNCA aparece antes de un modelo sin que la palabra
 *            `Model:` los ligue. La forma desnuda `<provider> <model>` NO se
 *            reconoce — en estos ficheros «provider opencode-zen, reasoning
 *            max» haría de `reasoning` un modelo fantasma (falso positivo
 *            medido en la primera pasada de este mismo fix).
 *      Los pines de (b) entran como **P4** con su `ref` = `file:line` (la
 *      línea del par). Un pin (b) NO puede sustituir a un (a) del mismo
 *      fichero: son hallazgos ADICIONALES y el dedupe se hace por (provider,
 *      model).
 */
export function readLiteralPinsFromFile(
  filePath: string,
  refBase: string,
  tramo: ModelPinTramo,
  sourceClass: string,
  providers: readonly string[]
): { pins: ModelPin[]; problems: string[] } {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error: unknown) {
    return { pins: [], problems: [`${refBase}: unreadable (${error instanceof Error ? error.message : String(error)})`] }
  }
  if (providers.length === 0) return { pins: [], problems: [] }
  // El provider más LARGO primero: si no, un provider prefijo de otro ganaría el
  // match y el par quedaría mal atribuido.
  const ordered = [...providers].filter((id) => id.trim() !== '').sort((a, b) => b.length - a.length)
  // Los ids y los providers de este harness NO llevan `.`: fuera del lookbehind
  // (un `.` ahí haría fallar el match dentro de la prosa real, p.ej. tras un
  // punto y aparte). El lookbehind evita las rutas parciales (`/x/deepseek-flash`).
  const escaped = ordered.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const lines = text.split('\n')
  const pins: ModelPin[] = []
  const hit = new Set<string>()
  const consider = (provider: string, model: string, lineNumber: number): void => {
    if (provider === '' || model === '') return
    const key = `${provider.toLowerCase()}/${model.toLowerCase()}`
    if (hit.has(key)) return
    hit.add(key)
    pins.push({ provider, model, source: { tramo, class: sourceClass, ref: `${refBase}:${lineNumber}` } })
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    // b3 — el provider aparece (en la MISMA línea) ANTES del modelo. Las dos
    // formas que reconoce la regla:
    //  (A) la RUTA canónica `<provider>/<model>` del catálogo (`opencode-zen/deepseek-flash`);
    //  (B) la PROSA del literal real de los presets vivos, etiquetada por
    //      `Model:` — «Model: deepseek-flash (provider opencode-zen, reasoning
    //      max)» — con el modelo y el provider separados por a lo sumo 200
    //      caracteres y SIN cruzar un salto de línea (nunca una frase entera).
    // NO se reconoce la forma desnuda `<provider> <model>`: en estos ficheros
    // «provider opencode-zen, reasoning max» haría de `reasoning` un modelo
    // fantasma (falso positivo medido en la primera pasada de este mismo fix).
    const pathRe = new RegExp(`(?<![\\w./-])(?:provider\\s+)?(${escaped})/([A-Za-z0-9][\\w.-]*)(?![\\w.-])`, 'g')
    let pathMatch: RegExpExecArray | null
    while ((pathMatch = pathRe.exec(line)) !== null) {
      consider(pathMatch[1] ?? '', pathMatch[2] ?? '', i + 1)
    }
    const proseRe = new RegExp(`\\bModel:\\s*([A-Za-z0-9][\\w.-]*)[^\\n]{0,200}?\\bprovider\\s+(${escaped})(?![\\w.-])`, 'g')
    let proseMatch: RegExpExecArray | null
    while ((proseMatch = proseRe.exec(line)) !== null) {
      consider(proseMatch[2] ?? '', proseMatch[1] ?? '', i + 1)
    }
  }
  return { pins, problems: [] }
}

/** Extrae los pines `agentOptions` de un fichero de PRESET live / patch de
 * perfil. Un fichero ilegible NO se omite en silencio: devuelve un problem.
 * El `ref` de cada pin lleva `file:line` (la línea de la clave del bloque).
 * `declaredProviders` (opcional) acota el parser a los providers del catálogo. */
export function readAgentOptionsPinsFromFile(filePath: string, ref: string, tramo: ModelPinTramo, sourceClass: string, declaredProviders?: readonly string[]): { pins: ModelPin[]; problems: string[] } {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error: unknown) {
    return { pins: [], problems: [`${ref}: unreadable (${error instanceof Error ? error.message : String(error)})`] }
  }
  const { entries, problems } = extractPinEntries(text, declaredProviders)
  return {
    pins: entries.map((entry) => ({ ...entry.pin, source: { tramo, class: sourceClass, ref: `${ref}:${entry.line}` } })),
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
export function readAuxiliaryPins(paths: MpcPreflightPaths = {}, declaredProviders?: readonly string[]): { pins: ModelPin[]; problems: string[] } {
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
      const read = readAgentOptionsPinsFromFile(patch, `profiles/${profile}/cordis.patch.yml`, 'P6', 'twin-profile', declaredProviders)
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
 * `deps` permite inyectar los ficheros (tests herméticos) sin tocar el home.
 * `catalogProviders` = los providers DECLARADOS en el catálogo vivo: es el
 * conjunto que acota la regla P4 (b) (el par literal `<provider>/<model>`). */
export function resolveModelPins(deps: {
  org?: MpcPreflightOrg
  paths?: MpcPreflightPaths
  catalogProviders?: readonly string[]
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
  // La lista de providers DECLARADOS en el catálogo acota los DOS lectores
  // (bloques estructurados y pares literales): nunca se inventa un provider
  // leído de un texto.
  const declaredProviders = [...(deps.catalogProviders ?? [])]
  if (paths.settingsYaml !== undefined) {
    // El `agent-default-model` de settings.yaml es el tramo P1 (el pin con el
    // que el host resuelve cada turno — la vía por la que el host SOBREVIVIÓ al
    // incidente). Otros bloques `agentOptions` del mismo fichero son presets.
    const read = readAgentOptionsPinsFromFile(paths.settingsYaml, `${paths.settingsYaml} agent-default-model`, 'P1', 'agent-default-model', declaredProviders)
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
      const refBase = `.agent-presets/${preset}/agent.cordis.yml`
      const read = readAgentOptionsPinsFromFile(file, refBase, 'P4', 'session-preset', declaredProviders)
      pins.push(...read.pins)
      problems.push(...read.problems)
      // (b) los pines LITERALES del texto del preset (la forma que el incidente
      // rotó y que el lector estructurado medía como 0 pines). El dedupe es POR
      // FICHERO (el pin literal de un preset NO es el mismo hallazgo que el de
      // otro: cada uno lleva su file:line) y compara sólo contra lo que ESE
      // fichero ya produjo por la vía (a) — un dedupe global se comería el pin
      // literal por colisión con la constante P3 del mismo par.
      if (declaredProviders.length > 0) {
        const literal = readLiteralPinsFromFile(file, refBase, 'P4', 'session-preset', declaredProviders)
        const fromThisFile = new Set(read.pins.map((pin) => `${pin.provider.toLowerCase()}/${pin.model.toLowerCase()}`))
        for (const pin of literal.pins) {
          const key = `${pin.provider.toLowerCase()}/${pin.model.toLowerCase()}`
          if (fromThisFile.has(key)) continue
          fromThisFile.add(key)
          pins.push(pin)
        }
        problems.push(...literal.problems)
      }
    }
  }
  const aux = readAuxiliaryPins(paths, declaredProviders)
  return { pins, auxiliary: aux.pins, problems: [...problems, ...aux.problems] }
}

// ---------------------------------------------------------------------------
// F6 — la SUPERFICIE DE DECLARACIÓN de pines benignos (`mpc-pin-declarations.json`)
// ---------------------------------------------------------------------------

/**
 * F6 (gate unit-2, pedido del host) — declarar un pin AUX/P6 como **BENIGNO CON
 * RAZÓN ESCRITA**.
 *
 * El problema real: un AUX(unknown) legítimo (el `probeModel` latente del
 * key-pooler, el twin de otro perfil) se queda «sin declarar» y ensucia todo
 * informe, y un operador no tiene forma de decir «esto lo he mirado y es
 * benigno, por ESTO» que el guard pueda citar. La superficie es un fichero JSON
 * en el stateDir, `<stateDir>/mpc-pin-declarations.json`:
 *
 *   {
 *     "declarations": [
 *       { "provider": "opencode-zen", "model": "deepseek-v4-flash",
 *         "tramo": "P6", "class": "key-pooler-probe",
 *         "reason": "default de código del key-pooler TAPADO por la fila live del perfil activo",
 *         "declaredBy": "host", "declaredAt": "2026-09-10T00:00:00Z" }
 *     ]
 *   }
 *
 * REGLAS (deliberadas):
 *  - Es OPT-IN y READ-ONLY para el guard: si el fichero no existe, no hay
 *    declaraciones y el informe no cambia (cero regresión).
 *  - `reason` NO VACÍA es OBLIGATORIA: una declaración sin razón se reporta como
 *    problem y NO se aplica (una declaración sin razón es exactamente el
 *    «detalle caduco» que la familia fb-352/fb-356 persigue).
 *  - `tramo`/`class` son OPCIONALES: acotan la declaración (si se omiten, la
 *    declaración cubre cualquier tramo/clase de ese par). El match de
 *    provider/model es case-insensitive (el mismo contrato del comparador).
 *  - Declarar NO silencia: el veredicto del pin sigue siendo el mismo
 *    (`unknown-model`/`NO_ADAPTER`/`unknown`) y sigue contando como hallazgo —
 *    lo que cambia es que el informe lo muestra como «declared benign + reason».
 *  - Un `expiresAt` (ISO, opcional) permite una declaración CON CADUCIDAD.
 */
export interface MpcPinDeclaration {
  provider: string
  model: string
  tramo?: string
  class?: string
  reason: string
  declaredBy?: string
  declaredAt?: string
  expiresAt?: string
}

/** Elige la declaración aplicable a un veredicto (la razón más específica: se
 * prefiere la que fija tramo Y clase sobre la genérica). */
export function matchPinDeclaration(
  pin: { provider: string; model: string; source: { tramo: string; class: string } },
  declarations: readonly MpcPinDeclaration[],
  now: number
): MpcPinDeclaration | undefined {
  const provider = (pin.provider ?? '').trim().toLowerCase()
  const model = (pin.model ?? '').trim().toLowerCase()
  const candidates = declarations.filter((decl) => {
    if ((decl.provider ?? '').trim().toLowerCase() !== provider) return false
    if ((decl.model ?? '').trim().toLowerCase() !== model) return false
    if (decl.tramo !== undefined && decl.tramo.trim() !== '' && decl.tramo.trim() !== pin.source.tramo) return false
    if (decl.class !== undefined && decl.class.trim() !== '' && decl.class.trim() !== pin.source.class) return false
    if (decl.expiresAt !== undefined && decl.expiresAt.trim() !== '') {
      const at = Date.parse(decl.expiresAt)
      if (Number.isFinite(at) && at < now) return false
    }
    return true
  })
  if (candidates.length === 0) return undefined
  return candidates.sort((a, b) => ((b.tramo !== undefined ? 1 : 0) + (b.class !== undefined ? 1 : 0)) - ((a.tramo !== undefined ? 1 : 0) + (a.class !== undefined ? 1 : 0)))[0]
}

/** Lee las declaraciones de pines benignos del stateDir (o de la ruta explícita
 * que se le pase). Un fichero ausente NO es un problem; uno ILEGIBLE o con una
 * declaración sin razón SÍ (con la razón reportada, nunca un silencio). */
export function readPinDeclarations(declarationsPath: string | undefined): { declarations: MpcPinDeclaration[]; problems: string[] } {
  const problems: string[] = []
  if (declarationsPath === undefined || !existsSync(declarationsPath)) return { declarations: [], problems }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(declarationsPath, 'utf8'))
  } catch (error: unknown) {
    return { declarations: [], problems: [`${declarationsPath}: unparseable (${error instanceof Error ? error.message : String(error)})`] }
  }
  const raw = (parsed as { declarations?: unknown })?.declarations
  if (!Array.isArray(raw)) {
    return { declarations: [], problems: [`${declarationsPath}: no "declarations" array (F6 declaration surface)`] }
  }
  const declarations: MpcPinDeclaration[] = []
  for (const [index, entry] of raw.entries()) {
    const row = entry as Partial<MpcPinDeclaration>
    const provider = (row.provider ?? '').trim()
    const model = (row.model ?? '').trim()
    const reason = (row.reason ?? '').trim()
    if (provider === '' || model === '') {
      problems.push(`${declarationsPath}: declaration #${index + 1} has no provider/model (ignored)`)
      continue
    }
    if (reason === '') {
      problems.push(`${declarationsPath}: declaration #${index + 1} (${provider}/${model}) has NO reason — a benign declaration without a written reason is not a declaration (ignored)`)
      continue
    }
    declarations.push({
      provider,
      model,
      reason,
      ...(row.tramo !== undefined && row.tramo.trim() !== '' ? { tramo: row.tramo.trim() } : {}),
      ...(row.class !== undefined && row.class.trim() !== '' ? { class: row.class.trim() } : {}),
      ...(row.declaredBy !== undefined ? { declaredBy: row.declaredBy } : {}),
      ...(row.declaredAt !== undefined ? { declaredAt: row.declaredAt } : {}),
      ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {})
    })
  }
  return { declarations, problems }
}

/** El bloque `org:` de un patch (coordinadores + workerAgentOptions /
 * hostAgentOptions) — el runner lo lee del patch del perfil ACTIVO.
 *
 * ETIQUETADO (riesgo R5 del gate unit-2): hoy todo lo extraído de un patch salía
 * `P2`, incluida la fila `agent-default-model` (que es **P1**: es la clave raíz
 * de la composición, la que fija el modelo por defecto de los agentes). La
 * entrada `agentDefaultModel` de la vuelta lleva la fila P1 — con su `file:line`
 * — cuando el patch la declara (forma `- id: agent-default-model` + `config:`),
 * y `undefined` cuando no. El resto sigue siendo P2 (filas de coordinador /
 * rutas org), que es lo correcto. */
export function readOrgPinsFromPatch(patchPath: string | undefined, declaredProviders?: readonly string[]): {
  pins: ModelPin[]
  org?: { workerAgentOptions?: AgentPinOptions; hostAgentOptions?: AgentPinOptions }
  agentDefaultModel?: AgentPinOptions
  problems: string[]
} {
  if (patchPath === undefined || !existsSync(patchPath)) {
    return { pins: [], problems: patchPath === undefined ? [] : [`${patchPath}: unreadable or absent`] }
  }
  let text: string
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch (error: unknown) {
    return { pins: [], problems: [`${patchPath}: unreadable (${error instanceof Error ? error.message : String(error)})`] }
  }
  const { entries, problems } = extractPinEntries(text, declaredProviders)
  const textLines = text.split('\n')
  // P1 — la fila `agent-default-model` del patch (forma `- id:` + `config:`):
  // el pin por defecto de los agentes. Se separa del resto de pines POR LÍNEA
  // (una fila de coordinador que declare la MISMA ruta sigue siendo P2: el
  // dedupe por (provider,model) la perdería).
  const p1Lines = new Set<number>()
  const p1Pins: ModelPin[] = []
  for (const entry of entries) {
    if (!/^\s*-\s+id\s*:\s*agent-default-model\s*$/.test(textLines[entry.line - 1] ?? '')) continue
    p1Lines.add(entry.line)
    p1Pins.push({ ...entry.pin, source: { tramo: 'P1' as ModelPinTramo, class: 'agent-default-model', ref: `${patchPath}:${entry.line}` } })
  }
  // P2 — las filas de coordinador (agentOptions de cada department). El pin de
  // coordinador es el route que materializa cada head, y NO rotarlo es
  // exactamente lo que el changeset del 09-10 dejó fuera.
  const coordinatorPins: ModelPin[] = entries
    .filter((entry) => !p1Lines.has(entry.line))
    .map((entry) => ({
      ...entry.pin,
      source: { tramo: 'P2' as ModelPinTramo, class: 'coordinator.agentOptions', ref: `${patchPath}:${entry.line}` }
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
  const agentDefaultModel = p1Pins[0]
  return {
    pins: [...p1Pins, ...coordinatorPins],
    org: { ...(workerAgentOptions !== undefined ? { workerAgentOptions } : {}), ...(hostAgentOptions !== undefined ? { hostAgentOptions } : {}) },
    ...(agentDefaultModel !== undefined ? { agentDefaultModel: { provider: agentDefaultModel.provider, model: agentDefaultModel.model } } : {}),
    problems
  }
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
  /** F8 — el sello de entrada: qué ficheros/perfil/fuentes se leyeron y su ts. */
  inputs: ModelPinInputsStamp
  /** F5b — la marca DEGRADED que viaja a la fila durable/marca del stateDir
   * (true también cuando la mitad runtime NO corrió: un `allow` con la mitad
   * estática sola NO es un ok). */
  degraded: boolean
  /** F3 — el resultado de la ENTREGA in-process al host (`undefined` = no se
   * intentó porque el gate no está degradado). */
  hostAlertDelivery?: { attempted: boolean; delivered: boolean; error?: string }
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
  /** Los patches del perfil ACTIVO (root del repo + perfil) — tramo P2 (+P1). */
  patches?: string[]
  llm?: unknown
  /** F5c — las fuentes de catálogo SUPLIDAS por el caller (el puente
   * `--catalog <json>` del CLI, o un caller in-process que ya tiene el live
   * catalog). Cada una satisface la mitad RUNTIME del gate F5. */
  catalogSources?: LiveCatalogSource[]
  /** El perfil nombrado (solo para el sello de entrada F8). */
  profile?: string
  /** F6 — la ruta del fichero de declaraciones benignas (`undefined` ⇒
   * `<stateDir>/mpc-pin-declarations.json`; NUNCA se escribe). */
  declarationsPath?: string
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

/** La fila durable del canal de alertas — escritura SÍNCRONA y **APPEND-ONLY**
 * (F9, gate unit-2).
 *
 * POR QUÉ APPEND-ONLY (defecto medido, riesgo R1 del gate): la versión anterior
 * hacía READ-MODIFY-WRITE + TRUNCADO sobre `<stateDir>/health-alerts.jsonl`, un
 * fichero COMPARTIDO con el daemon de salud (que escribe en él por su cuenta).
 * Dos escritores con un rewrite del fichero entero se pisan: la clase de defecto
 * es «**fila de alerta perdida en silencio**» — justo el canal con el que se
 * detectaría el próximo incidente. Con append (una línea, sin leer ni reescribir)
 * la carrera desaparece POR CONSTRUCCIÓN.
 *
 * LO QUE NO SE HACE NUNCA AQUÍ: truncar, podar, reescribir el fichero completo o
 * leerlo para modificarlo (el cap/poda es del DUEÑO del canal, dshd-health). Todo
 * read-modify-write del guard vive en su estado PROPIO
 * (`mpc-preflight-state.json`): latches, decisión, sello de entrada (F8) y
 * contadores. Si el guard necesitara dedupe, se calcula contra ESE estado.
 *
 * SíNCRONA a propósito: la usa la puerta de BOOT, que corre en el arranque del
 * bundle y NO debe solapar trabajo asíncrono con el ciclo de vida del stateDir
 * del runtime (una promesa de E/S que aterriza después de que el contexto se
 * disponga escribe en un directorio ya retirado). La vía asíncrona
 * (appendMpcAlertRow) queda para el CLI. Nunca lanza. */
export function appendMpcAlertRowSync(stateDir: string, row: { ts: number; findings: Array<Record<string, unknown>>; dedupeKeys: string[] }): void {
  try {
    const filePath = path.join(stateDir, 'health-alerts.jsonl')
    mkdirSync(stateDir, { recursive: true })
    // UNA escritura en modo append (O_APPEND): el núcleo posiciona al final y
    // escribe; no hay read-modify-write ni truncado. `\n` explícito para que la
    // línea siempre cierre (el canal es JSONL).
    appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8')
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
 * EL ENSAMBLADO COMPARTIDO de las dos vías (sync/async). Devuelve TODO lo que no
 * es efecto durable: pines, fuentes, informe, hallazgos auxiliares, problemas y
 * el sello de entrada (F8). La mitad RUNTIME no se consulta aquí: el caller
 * decide si consulta `llm.listModels` (async), si corre la puerta síncrona o si
 * el catálogo le llega suplido (`catalogSources` / `--catalog`).
 */
function assembleRun(deps: MpcPreflightRunDeps, runtimeSource: LiveCatalogSource | undefined): {
  mode: MpcPreflightMode
  phase: 'deploy-preflight' | 'boot' | 'mint'
  pinSet: ModelPin[]
  sources: LiveCatalogSource[]
  report: ModelPinCoherenceReport
  auxiliaryFindings: ModelPinVerdict[]
  /** Cuántos pines auxiliares (P6) se enumeraron (== auxiliaryFindings sólo
   * cuando ninguno está cubierto). */
  auxiliaryCount: number
  problems: string[]
  retiredStillPinned: string[]
  runtimeCatalogConsulted: boolean
  catalogSourceIds: string[]
  ts: number
} {
  const mode: MpcPreflightMode = deps.mode ?? (deps.candidateSettingsText !== undefined ? 'subtractive' : 'deploy')
  const phase: 'deploy-preflight' | 'boot' | 'mint' = mode === 'boot' ? 'boot' : mode === 'mint' ? 'mint' : 'deploy-preflight'
  const ts = (deps.now ?? Date.now)()
  const paths = deps.paths ?? {}
  const problems: string[] = []
  const pinSet: ModelPin[] = []
  // Conjunto C — vía estática (settings.yaml) + vía runtime + suplidas + built-in.
  const settingsPath = paths.settingsYaml
  const staticSource = settingsPath !== undefined ? staticCatalogFromSettingsYaml(settingsPath) : undefined
  if (staticSource !== undefined) problems.push(...staticSource.problems)
  const sources: LiveCatalogSource[] = []
  if (staticSource !== undefined && staticSource.readable) sources.push({ id: staticSource.id, providers: staticSource.providers })
  if (runtimeSource !== undefined) sources.push(runtimeSource)
  // El catálogo SUPLIDO (`--catalog <json>` o un caller in-process): es la
  // segunda salida legítima del gate F5 cuando no hay `llm` vivo.
  for (const supplied of deps.catalogSources ?? []) sources.push(supplied)
  // La lista de providers DECLARADOS acota la regla P4 (b) y es la que la
  // enumera: se calcula ANTES de enumerar los pines.
  const catalogProviders = [...new Set(sources.flatMap((source) => Object.keys(source.providers)))]
  // Las rutas BUILT-IN del harness: van ÚLTIMAS y sólo rellenan lo que ninguna
  // fuente live resolvió (así un `deepseek-official` no es «unknown» cuando el
  // adapter está en el bundle — artefacto de la mitad estática, gate unit-2 F6).
  sources.push(builtinCatalogSource())
  // P2 — las filas de coordinador + org.workerAgentOptions/hostAgentOptions del
  // patch del perfil ACTIVO (y del root del repo cuando existe). La fila
  // `agent-default-model` de un patch es P1 (readOrgPinsFromPatch). Se lee
  // DESPUÉS de conocer los providers declarados (el parser los usa para no
  // confundir el `provider:` de un SUBAGENTE con un provider de modelo).
  for (const patch of deps.patches ?? []) {
    const read = readOrgPinsFromPatch(patch, catalogProviders)
    pinSet.push(...read.pins)
    problems.push(...read.problems)
  }
  const enumerados = resolveModelPins({
    ...(deps.org !== undefined ? { org: deps.org } : {}),
    paths,
    catalogProviders
  })
  pinSet.push(...enumerados.pins)
  problems.push(...enumerados.problems)
  // F6 — la superficie de declaración de pines benignos (OPT-IN, read-only).
  const declarationsPath = deps.declarationsPath ?? (deps.stateDir !== undefined ? path.join(deps.stateDir, MPC_PIN_DECLARATIONS_FILE) : undefined)
  const declared = readPinDeclarations(declarationsPath)
  problems.push(...declared.problems)
  const explicitRuntimeSources = (deps.catalogSources ?? []).length > 0
  const report = buildCoherenceReport({ pins: pinSet, sources, phase, explicitRuntimeSources })
  // Los pines AUXILIARES: TODA no-cobertura se reporta (unknown-model,
  // NO_ADAPTER y también `unknown` — el twin declara un provider que NO existe
  // en el catálogo del home, que es justo el hallazgo del §4.2/P6). NUNCA
  // entran en la decisión del perfil activo.
  const auxVerdicts = comparePinsAgainstCatalogSources(enumerados.auxiliary, sources)
    .filter((v) => v.kind !== 'ok')
    .map((verdict) => {
      const declaration = matchPinDeclaration(verdict.pin, declared.declarations, ts)
      return declaration === undefined ? verdict : { ...verdict, declaration: { provider: declaration.provider, model: declaration.model, reason: declaration.reason, ...(declaration.declaredBy !== undefined ? { declaredBy: declaration.declaredBy } : {}), ...(declaration.declaredAt !== undefined ? { declaredAt: declaration.declaredAt } : {}), ...(declaration.expiresAt !== undefined ? { expiresAt: declaration.expiresAt } : {}) } }
    })
  // Write-guard defensivo del catálogo subtractivo (puerta 2).
  let retiredStillPinned: string[] = []
  if (mode === 'subtractive') {
    const currentText = settingsPath !== undefined && existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
    retiredStillPinned = subtractiveRetirement({ currentSettingsText: currentText, candidateSettingsText: deps.candidateSettingsText ?? '', pins: pinSet })
  }
  return {
    mode,
    phase,
    pinSet,
    sources,
    report,
    auxiliaryFindings: auxVerdicts,
    // El contador del informe cuenta HALLAZGOS auxiliares (lo que se imprime),
    // no pines enumerados: si no, `auxiliary=3` con 1 sola línea AUX visible
    // (medido: los dos pines del twin salen `ok` por la ruta built-in).
    auxiliaryCount: auxVerdicts.length,
    problems,
    retiredStillPinned,
    runtimeCatalogConsulted: runtimeSource !== undefined || explicitRuntimeSources,
    catalogSourceIds: sources.map((source) => source.id),
    ts
  }
}

/** F3 (gate unit-2) — ¿este run tiene un HALLAZGO POSITIVO que interrumpirle al
 * host? Un `missing` (I-MP violado con evidencia) o un id retirado aún pinneado
 * SÍ lo son. Un `unknown` (el catálogo no se pudo leer / el provider no está
 * declarado) NO es un hallazgo, es AUSENCIA DE EVIDENCIA.
 *
 * Medición que obliga a esta precisión (no es teoría): con la condición ancha
 * —cualquier `degraded`— una composición SIN `settings.yaml` (perfil hermético;
 * cualquier test del harness que sólo registre un host falso) ENTREGABA un
 * «integrity alert de 0 pines» al inbox del host en cada arranque y rompía
 * asertos de inbox ajenos. Evidencia: test/invoke.test.js «B2 send_message:
 * SELF-addressed send is held» (afirma `inboxMessages.length === 0`) falló 3/3
 * con la entrega ancha y pasa con ésta; el payload capturado era
 * «[MPC-PREFLIGHT mpc-preflight] 0 pin(s) missing/unverified at boot».
 *
 * Regla final: se entrega SOLO con evidencia POSITIVA —
 *  (1) pares AUSENTES (evidencia positiva de violación), o
 *  (2) un id retirado aún pinneado, o
 *  (3) un pin no verificable CUANDO existe al menos una fuente de catálogo
 *      declarada ADEMÁS de la built-in (se leyó un catálogo real y aun así ese
 *      provider no aparece en él), o
 *  (4) F5-bis: una DISCREPANCIA entre las fuentes LIVE consultadas (una resuelve
 *      y otra NIEGA el mismo pin): es evidencia POSITIVA — dos catálogos
 *      consultados no pueden contradecirse en silencio. Sin `settings.yaml` ni
 *      `--catalog` ni `llm` sólo queda la built-in ⇒ el guard no puede establecer
 *      el invariante y NO le pone un sello de alarma al host: eso vive en el log
 *      DEGRADED y en la marca durable, que es donde va un «no pude verificar». */
export function hasPositiveIntegrityFinding(result: {
  report: { missing: readonly unknown[]; unverifiable: readonly unknown[]; discrepancies?: readonly unknown[] }
  retiredStillPinned: readonly string[]
  inputs: { catalogSources: readonly string[] }
}): boolean {
  if (result.retiredStillPinned.length > 0) return true
  if (result.report.missing.length > 0) return true
  if ((result.report.discrepancies ?? []).length > 0) return true
  return result.report.unverifiable.length > 0 && result.inputs.catalogSources.some((id) => id !== BUILTIN_CATALOG_SOURCE_ID)
}

/** LEE la marca durable del guard (su propio latch). `undefined` cuando no
 * existe o no se puede parsear: un latch ilegible NO se inventa — y tampoco
 * bloquea (la marca es un aviso, no una fuente de decisión). */
export function readMpcPreflightStateSync(stateDir: string): Record<string, unknown> | undefined {
  const filePath = path.join(stateDir, MPC_PREFLIGHT_STATE_FILE)
  if (!existsSync(filePath)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * GATE 3(c) — LIMPIAR EL LATCH CADUCADO. Un run sin nada que decir (boot sano)
 * REESCRIBE como sana una marca previa que declaraba DEGRADED, dejando la
 * procedencia (`clearedFrom`) para que la limpieza sea auditable. Es la única
 * defensa contra el defecto medido: la marca se escribía una vez y sobrevivía
 * para siempre, con el árbol ya reparado (el fichero no tenía NINGÚN lector).
 * Nunca lanza y nunca escribe si no hay marca previa degradada.
 */
function clearStaleDegradedMark(stateDir: string, result: MpcPreflightRunResult, context: { ts: number; mode: MpcPreflightMode }): void {
  const previous = readMpcPreflightStateSync(stateDir)
  if (previous === undefined || previous.degraded !== true) return
  const { ts, mode } = context
  writeMpcPreflightStateSync(stateDir, {
    ts,
    mode,
    decision: result.report.decision,
    degraded: false,
    missing: [],
    pins: result.report.verdicts.map((verdict) => pinLabel(verdict.pin)),
    message: '',
    retiredStillPinned: [],
    disagreements: [],
    inputs: result.inputs,
    clearedFrom: {
      ts: previous.ts ?? null,
      mode: previous.mode ?? null,
      decision: previous.decision ?? null,
      missing: Array.isArray(previous.missing) ? previous.missing : []
    }
  })
}

/** LOS EFECTOS DURABLES (fila del canal + marca DEGRADED + entrega al host).
 *
 * F4 (gate unit-2): un boot SANO (`allow`, sin ausentes, sin retirados) NO
 * escribe NADA — antes escribía una fila con `count: Math.max(1, 0)` y
 * `interrupt: true` en un boot limpio: ruido de ledger y un carrier de interrupt
 * vacío. La fila (y con ella el interrupt) sólo existe cuando hay algo que
 * decir.
 *
 * SEGUNDA PASADA DEL GATE (F4 seguía ABIERTO en la vía REAL — defecto medido,
 * no hipótesis): la condición era `degraded`, y en la puerta de BOOT `degraded`
 * es SIEMPRE `true` POR CONSTRUCCIÓN: `boot.ts` corre la vía SÍNCRONA y NUNCA
 * suple catálogo, luego `inputs.runtimeCatalogConsulted === false` ⇒ `degraded
 * = … || !inputs.runtimeCatalogConsulted` es una constante, no un hallazgo.
 * Medición del reviewer sobre el wiring real: un boot `decision=allow` escribía
 * fila `{count:0, interrupt:true, degraded:true}` + la marca en CADA arranque
 * (la clase R2 del gate anterior: «fila en todo boot, incluso allow»).
 * Por eso la condición que decide aquí es el HALLAZGO —`decision !== 'allow'`,
 * pares ausentes, retirados aún pinneados— y NUNCA el `degraded` permanente por
 * mitad-runtime ausente: ese «no pude verificar la mitad runtime» vive en el
 * log DEGRADED + el problema del informe (jamás un ok silencioso) y no se
 * disfraza de hallazgo en el canal COMPARTIDO. La marca, cuando se escribe,
 * sigue declarando `degraded: true` (F5b): lo que cambia es que un boot sin
 * nada que decir no deja artefacto durable alguno.
 * F3: la entrega al host es una LLAMADA REAL al sink inyectado y su resultado
 * (`hostAlertDelivery`) viaja en la marca durable — no un campo auto-declarado. */
function applyDurableEffects(
  result: MpcPreflightRunResult,
  deps: MpcPreflightRunDeps,
  context: { ts: number; mode: MpcPreflightMode; missing: string[]; degraded: boolean; retiredStillPinned: string[] }
): void {
  const stateDir = deps.stateDir
  if (stateDir === undefined) return
  const { ts, mode, missing, degraded, retiredStillPinned } = context
  // F4 (2ª pasada del gate, vía REAL): la condición es el HALLAZGO, no el
  // `degraded` —que en el boot es una constante por la mitad runtime ausente
  // (ver el bloque de arriba)—. `missing` ya incluye los pares AUSENTES del
  // informe Y los id retirados aún pinneados.
  const worthWriting = mode !== 'boot' || result.decision !== 'allow' || missing.length > 0 || retiredStillPinned.length > 0
  if (!worthWriting) {
    // GATE 3(c) — EL LATCH NO PUEDE MENTIR: si este run no tiene nada que decir
    // pero existe una marca PREVIA que declaraba DEGRADED, se REESCRIBE como sana
    // (con la procedencia del latche anterior). Nadie más lee ese fichero; sin
    // esta limpieza, una marca escrita una sola vez sobrevive para siempre a la
    // reparación del árbol y cualquier lector humano concluye «DEGRADED» con el
    // árbol coherente (la clase «detalle caduco», fb-352/fb-356). Sin marca
    // previa NO se escribe nada (contrato F4: un boot sano no deja artefacto).
    clearStaleDegradedMark(stateDir, result, { ts, mode })
    return
  }
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
        count: missing.length,
        // §4.2 puerta 3: la alerta va CON INTERRUPT al host. El interrupt es el
        // carrier del hallazgo y SOLO viaja en una fila degradada (un boot sano
        // no tiene nada que interrumpir). La ENTREGA la hace el sink inyectado
        // (wiring de boot: logger + recibo durable); NUNCA una sustitución de
        // modelo.
        recipients: ['host'],
        interrupt: degraded,
        degraded
      }
    ],
    dedupeKeys: [key]
  })
  if (degraded && deps.hostAlertSink !== undefined && hasPositiveIntegrityFinding(result)) {
    const frame = { message: renderRunReport(result), missing, postId: MPC_PREFLIGHT_POST_ID }
    try {
      deps.hostAlertSink(frame)
      result.hostAlertDelivery = { attempted: true, delivered: true }
    } catch (error: unknown) {
      result.hostAlertDelivery = { attempted: true, delivered: false, error: error instanceof Error ? error.message : String(error) }
    }
  } else if (degraded) {
    result.hostAlertDelivery = {
      attempted: false,
      delivered: false,
      error: deps.hostAlertSink === undefined
        ? 'no hostAlertSink injected (the durable row remains the only signal)'
        : 'degraded WITHOUT a positive integrity finding — no host interrupt (the boot log + the durable mark carry the unverifiable half)'
    }
  }
  writeMpcPreflightStateSync(stateDir, {
    ts,
    mode,
    decision: result.report.decision,
    degraded,
    missing,
    pins: result.report.verdicts.map((verdict) => pinLabel(verdict.pin)),
    message: result.report.message,
    retiredStillPinned,
    // F5-bis — las discrepancias entre las fuentes LIVE consultadas viajan a la
    // marca durable (son hallazgo propio, no un `ok` de unión).
    disagreements: result.report.discrepancies.map((verdict) => ({ pin: pinLabel(verdict.pin), detail: verdict.detail })),
    // F8 — el sello de entrada, DENTRO de la marca durable: la marca y el informe
    // comparten los mismos `ts`/entradas (nunca un §2.5 no datable).
    inputs: result.inputs,
    ...(result.hostAlertDelivery !== undefined ? { hostAlertDelivery: result.hostAlertDelivery } : {}),
    auxiliaryFindings: result.auxiliaryFindings.map((verdict) => ({
      pin: pinLabel(verdict.pin),
      kind: verdict.kind,
      ref: verdict.pin.source.ref,
      ...(verdict.declaration !== undefined ? { declaredBenign: verdict.declaration.reason, declaredBy: verdict.declaration.declaredBy ?? '' } : {})
    }))
  })
}

/**
 * EL RUN del guard sobre los pines REALES. No bloquea por sí mismo: devuelve la
 * disposición y (según el modo) emite los efectos durables. El caller (CLI o
 * wiring de boot) mapea `blocked` a exit ≠ 0 / abortar.
 *
 * La PUERTA DE BOOT omite la vía RUNTIME (`llm.listModels`, que es asíncrona) y
 * la sustituye por el hallazgo explícito «runtime half not consulted»: el boot
 * debe terminar su comprobación —y sus escrituras— dentro del turno en que
 * arranca, sin trabajo asíncrono que aterrice después de que el contexto se haya
 * dispuesto. NUNCA es un «ok» silencioso: la mitad ausente viaja como PROBLEM y
 * (F5b) fuerza `degraded: true` en la marca durable, así el host lo ve.
 */
export function runMpcPreflightSync(deps: MpcPreflightRunDeps = {}): MpcPreflightRunResult {
  const assembled = assembleRun(deps, undefined)
  const { mode, ts } = assembled
  const problems = [...assembled.problems]
  if (deps.catalogSources === undefined || deps.catalogSources.length === 0) {
    problems.push('the RUNTIME catalog source was not consulted on this gate (this door runs SYNCHRONOUSLY — the static catalog half alone is NOT evidence; never a silent ok)')
  }
  const inputs: ModelPinInputsStamp = {
    ts,
    settingsYaml: deps.paths?.settingsYaml ?? '',
    patches: [...(deps.patches ?? [])],
    profile: deps.profile ?? '',
    catalogSources: assembled.catalogSourceIds,
    runtimeCatalogConsulted: assembled.runtimeCatalogConsulted
  }
  const missing = [...assembled.report.missing.map((v) => pinLabel(v.pin)), ...assembled.retiredStillPinned.map((id) => `retired-but-pinned:${id}`)]
  const degraded = assembled.report.decision !== 'allow' || assembled.retiredStillPinned.length > 0 || !inputs.runtimeCatalogConsulted
  const result: MpcPreflightRunResult = {
    mode,
    decision: assembled.report.decision,
    report: assembled.report,
    auxiliaryFindings: assembled.auxiliaryFindings,
    pinCount: assembled.pinSet.length,
    auxiliaryCount: assembled.auxiliaryCount,
    problems,
    retiredStillPinned: assembled.retiredStillPinned,
    inputs,
    degraded
  }
  if (deps.persist === true) applyDurableEffects(result, deps, { ts, mode, missing, degraded, retiredStillPinned: assembled.retiredStillPinned })
  return result
}

/** La vía ASÍNCRONA (CLI/deploy): el mismo núcleo + la consulta RUNTIME
 * (`llm.listModels`, la primitiva del probe R2) — las puertas 1-2 exigen la
 * COINCIDENCIA de ambas vías, así que su ausencia se declara como problema Y
 * bloquea el deploy (F5: el gate BLOQUEANTE nunca es fail-open). */
export async function runMpcPreflight(deps: MpcPreflightRunDeps = {}): Promise<MpcPreflightRunResult> {
  const problems: string[] = []
  const runtime = await runtimeCatalogFromLlm(deps.llm)
  if (runtime !== undefined) problems.push(...runtime.problems)
  const assembled = assembleRun(deps, runtime?.source)
  const { mode, ts } = assembled
  const allProblems = [...assembled.problems, ...problems]
  if (runtime === undefined && (deps.catalogSources === undefined || deps.catalogSources.length === 0)) {
    allProblems.push('the RUNTIME catalog source is absent — the static half alone would be a silent ok (never accepted on the deploy gate). Two exits: run IN-PROCESS with the live llm (runMpcPreflight({ llm })), or supply the catalog with --catalog <json>')
  }
  const inputs: ModelPinInputsStamp = {
    ts,
    settingsYaml: deps.paths?.settingsYaml ?? '',
    patches: [...(deps.patches ?? [])],
    profile: deps.profile ?? '',
    catalogSources: assembled.catalogSourceIds,
    runtimeCatalogConsulted: assembled.runtimeCatalogConsulted
  }
  const missing = [...assembled.report.missing.map((v) => pinLabel(v.pin)), ...assembled.retiredStillPinned.map((id) => `retired-but-pinned:${id}`)]
  const degraded = assembled.report.decision !== 'allow' || assembled.retiredStillPinned.length > 0 || !inputs.runtimeCatalogConsulted
  const result: MpcPreflightRunResult = {
    mode,
    decision: assembled.report.decision,
    report: assembled.report,
    auxiliaryFindings: assembled.auxiliaryFindings,
    pinCount: assembled.pinSet.length,
    auxiliaryCount: assembled.auxiliaryCount,
    problems: allProblems,
    retiredStillPinned: assembled.retiredStillPinned,
    inputs,
    degraded
  }
  if (deps.persist === true && (mode === 'boot' || mode === 'deploy' || mode === 'subtractive')) {
    applyDurableEffects(result, deps, { ts, mode, missing, degraded, retiredStillPinned: assembled.retiredStillPinned })
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
 * tramo y el fichero/constante que lo fija + (F8) el SELLO DE ENTRADA de la
 * ejecución: qué settings.yaml, qué patches, qué perfil y qué fuentes de
 * catálogo se leyeron, con su `ts`. */
export function renderRunReport(result: MpcPreflightRunResult): string {
  const lines: string[] = []
  lines.push(`[MPC-PREFLIGHT] mode=${result.mode} decision=${result.decision} pins=${result.pinCount} auxiliary=${result.auxiliaryCount} degraded=${result.degraded}`)
  lines.push(
    `[MPC-PREFLIGHT] entry-stamp ts=${new Date(result.inputs.ts).toISOString()} settings=${result.inputs.settingsYaml === '' ? '(none)' : result.inputs.settingsYaml} ` +
    `patches=[${result.inputs.patches.join(', ')}] profile=${result.inputs.profile === '' ? '(unnamed)' : result.inputs.profile} ` +
    `catalogs=[${result.inputs.catalogSources.join(', ')}] runtimeConsulted=${result.inputs.runtimeCatalogConsulted}`
  )
  if (result.report.message !== '') lines.push(result.report.message)
  for (const verdict of result.report.missing) lines.push(`  MISSING ${pinLabel(verdict.pin)} — tramo ${verdict.pin.source.tramo} (${verdict.pin.source.class}) fixed by ${verdict.pin.source.ref}`)
  // F5-bis: la DISCREPANCIA entre las fuentes LIVE consultadas (una resuelve,
  // otra niega) es un hallazgo propio y se imprime como tal (antes se diluía en
  // un `ok` de unión).
  for (const verdict of result.report.discrepancies) lines.push(`  DISAGREEMENT ${verdict.detail}`)
  for (const verdict of result.report.unverifiable) lines.push(`  UNVERIFIED ${pinLabel(verdict.pin)} — tramo ${verdict.pin.source.tramo} (${verdict.pin.source.class}): ${verdict.detail}`)
  for (const verdict of result.report.noAdapter) lines.push(`  NO_ADAPTER ${pinLabel(verdict.pin)} — ${verdict.detail}`)
  for (const verdict of result.auxiliaryFindings) {
    const declaration = verdict.declaration
    lines.push(
      declaration === undefined
        ? `  AUX(${verdict.kind}) ${pinLabel(verdict.pin)} — tramo ${verdict.pin.source.tramo} (${verdict.pin.source.class}) ref ${verdict.pin.source.ref}: ${verdict.detail}`
        : `  AUX(${verdict.kind}) ${pinLabel(verdict.pin)} — declared benign + reason: ${declaration.reason}${declaration.declaredBy !== undefined && declaration.declaredBy !== '' ? ` (declared by ${declaration.declaredBy})` : ''} — ref ${verdict.pin.source.ref}: ${verdict.detail}`
    )
  }
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
