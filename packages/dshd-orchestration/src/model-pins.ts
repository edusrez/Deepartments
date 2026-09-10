// dshd-orchestration — MPC-PREFLIGHT (lane IPD; spec CONGELADA del QD:
// .dsh/reports/quality/2026-09-10-incidente-congelacion-modelo-prevencion.md
// §3.2-§3.5/§4.2/§5; familia fb-42 SUBCLASE C1 / fb-25). The PURE CORE of the
// model-pin ↔ live-catalog coherence guard:
//
//   I-MP — en TODO instante, para cada tramo de pines del runtime, todo par
//   (provider, model) resoluble debe existir en el catálogo vivo de ese
//   provider. Un subconjunto prohibido del catálogo es un ESTADO CAÍDO.
//
// El incidente 09-10 congeló el org 96-101 min porque la edición del catálogo
// vivo fue SUBTRACTIVA (settings.yaml perdió los ids legacy) mientras los
// pines desplegados (agent-default-model, filas de coordinador, constantes
// WORKER_AGENT_OPTIONS/HOST_AGENT_OPTIONS, presets live) seguían resolviendo
// el legacy: la puerta de admisión del adapter pi-ai rechazó TODO turno de
// todo head/worker, incluidos los agentes que podían repararlo (auto-bloqueo).
//
// ESTE MÓDULO ES PURO: 0 I/O, nunca lanza, sin dependencias nuevas. Enumera
// los PINES (P1..P6) y COMPARA contra el catálogo vivo (C) con el vocabulario y
// el estilo del probe R2 existente (delivery.ts probeRotationMintModel):
//   ok / retrofitted / unknown-model + la clase SEPARADA NO_ADAPTER (fb-6:
//   un provider no REGISTRADO no es una ausencia de modelo — se reporta
//   distinto y NUNCA se confunde con la subclase C1).
//
// Seams reservados por la lane fb-337 (plane-watchdog, SERIAL detrás de esta):
// NO se toca packages/dshd-health (ni su composición de tick). El finding
// durable de la puerta de boot se escribe por el RUNNER (model-pins-runner.ts)
// con la FORMA de una fila de health-alerts.jsonl — la LANE fb-337 es dueña de
// los scanners nuevos de ese paquete.
//
// NO export default (pitfall 0001 — breaks `inject`).

/** One AgentOptions-like route (the exact shape the runtime pins). */
export interface AgentPinOptions {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * Las CONSTANTES DE CÓDIGO del bundle (tramo P3).
 *
 * VIVEN AQUÍ como ÚNICA fuente de verdad: `presets.ts` las IMPORTA y las
 * re-expone (compat R6 para todo consumidor que las lea de su superficie), y
 * ESTE guard las importa del MISMO módulo — así el tramo P3 no puede derivar
 * por un literal duplicado (el requisito «cero drift» de §4.2/:216: «importar
 * del propio bundle, no grep»). La evidencia del incidente (lib/presets.js:71
 * seguía legacy a las 12:41Z, host) es exactamente lo que un literal duplicado
 * en el guard reproduciría.
 */
export const WORKER_AGENT_OPTIONS: AgentPinOptions = {
  provider: 'opencode-zen',
  model: 'deepseek-flash',
  reasoningEffort: 'max'
}

/** VARIANT-2 (2026-08-24) — the D4 dormant-host resume AgentOptions (tramo
 * P3, espejo de WORKER_AGENT_OPTIONS; ver el comment largo en presets.ts). */
export const HOST_AGENT_OPTIONS: AgentPinOptions = {
  provider: 'opencode-zen',
  model: 'deepseek-flash',
  reasoningEffort: 'max'
}

/** Los 6 tramos del §4.2 (cada uno con la evidencia del incidente en el
 * comment de su enumerador). P5 (handles persistidos) NO es un tramo de
 * enumeración estática: es el pin que SOBREVIVE al fix y se resuelve AL
 * RE-MATERIALIZAR (delivery.ts, create/resume) — ver `resolvedStaleHandleVerdict`. */
export type ModelPinTramo = 'P1' | 'P2' | 'P3' | 'P4' | 'P6'

/** Quién resuelve el pin (el `fichero/constante que lo fija` del mensaje
 * accionable exigido por §4.2). */
export interface ModelPinSource {
  /** El tramo del §4.2: P1 agent-default-model · P2 filas de coordinador /
   * org.workerAgentOptions/hostAgentOptions · P3 constantes de código ·
   * P4 presets live · P6 twin/profiles + key-pooler. */
  tramo: ModelPinTramo
  /** Clase corta legible ('agent-default-model', 'coordinator', 'code-constant',
   * 'org.workerAgentOptions', 'preset', 'twin-profile', 'key-pooler-probe'). */
  class: string
  /** El fichero/constante concreto que fija el pin (nunca vacío). */
  ref: string
}

/** ONE resolved pin `(provider, model)` + de dónde sale. */
export interface ModelPin extends AgentPinOptions {
  source: ModelPinSource
}

/** El catálogo VIVO de un provider tal como lo devuelve una fuente. Absent =
 * esa fuente no declara el provider (NO es lo mismo que una lista vacía: una
 * lista vacía SÍ declara el provider y niega todo modelo). */
export interface ProviderCatalog {
  models: string[]
  /** El provider está REGISTRADO en el adapter (fb-6: un provider ausente del
   * registro es la clase NO_ADAPTER, reportada aparte). */
  registered: boolean
}

/** El catálogo vivo `C` (una o varias fuentes, cada una con su etiqueta). */
export interface LiveCatalogSource {
  /** 'settings-yaml' (vía estática) · 'dump-config' (vía estática) ·
   * 'runtime-llm' (la primitiva llm.listModels del probe R2) · 'fixture'. */
  id: string
  providers: Record<string, ProviderCatalog>
}

/**
 * LAS RUTAS **BUILT-IN** DEL HARNESS (fix-forward F6, gate unit-2): un provider
 * que NO está en `llm-pi-ai.providers` de settings.yaml no es «desconocido» si
 * lo REGISTRA un paquete del propio bundle. Medición que obliga a esta fuente
 * (`reports/explore-deep/2026-09-10-p6-aux-pins-keypooler-probe-twin-profile-08e5bcf3.md`):
 * el twin `deepartments-dev-headless` fija `deepseek-official/deepseek-v4-flash-vision-exp`
 * y `deepseek-official` SÍ existe como ruta built-in
 * (`@deepseek-ai/dsh-llm-deepseek`, `PROVIDER = "deepseek-official"`,
 * `DEFAULT_MODELS` de 3 ids) ⇒ el `AUX(unknown)` era un artefacto de la mitad
 * ESTÁTICA (settings.yaml sólo declara pi-ai), no un hallazgo real.
 *
 * ALCANCE DELIBERADAMENTE CONSERVADOR (una allowlist corta, no un descubrimiento
 * automático): sólo la ruta que el incidente/twin realmente pinnea y sus ids por
 * defecto. No es una lista mantenible a mano sin control: el test comprueba los
 * ids contra el `DEFAULT_MODELS` del paquete bundled y FALLA si derivan.
 */
export const BUILTIN_DEEPSEEK_PROVIDER = 'deepseek-official'

/** Los ids por defecto del adapter built-in `deepseek-official` (ver el
 * comment de arriba: el adapter los anuncia cuando el settings namespace
 * `llm-deepseek` no trae una lista explícita). */
export const BUILTIN_DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'] as const

/** La fuente de catálogo de las rutas built-in. Va SIEMPRE LA ÚLTIMA en la
 * lista de fuentes: sólo rellena lo que ninguna fuente live (settings.yaml /
 * runtime llm.listModels / un `--catalog` explícito) resolvió, y así jamás
 * tapa ni enmascara un catálogo vivo. */
export const BUILTIN_CATALOG_SOURCE_ID = 'builtin-adapter'

export function builtinCatalogSource(): LiveCatalogSource {
  return {
    id: BUILTIN_CATALOG_SOURCE_ID,
    providers: { [BUILTIN_DEEPSEEK_PROVIDER]: { models: [...BUILTIN_DEEPSEEK_MODELS], registered: true } }
  }
}

/** El veredicto del comparador para UN pin — vocabulario del probe R2. */
export type ModelPinVerdictKind =
  | 'ok'
  | 'retrofitted'
  | 'unknown-model'
  | 'NO_ADAPTER'
  | 'unknown'

/** El resultado por pin. `retrofitted` SOLO lo produce un handle stale con
 * modelo ausente y pin actual presente (P5); un PIN no puede retrofitarse
 * silenciosamente: sustituir el modelo de un pin es un cambio de semántica no
 * autorizado (§4.2 «Qué hace al fallar»). */
export interface ModelPinVerdict {
  pin: ModelPin
  kind: ModelPinVerdictKind
  /** El modelo al que se re-resuelve (sólo `retrofitted`). */
  retrofitModel?: string
  /** El sello de la fuente que produjo el veredicto. */
  check: string
  /** La línea accionable (provider + model + tramo + quién lo fija). */
  detail: string
  /** F6 — la declaración de BENIGNIDAD escrita que cubre a este pin (la
   * superficie `<stateDir>/mpc-pin-declarations.json`). Presente ⇒ el informe lo
   * muestra como «declared benign + reason»; el veredicto NO cambia. El tipo es
   * estructural (el runner es el dueño del lector: cero import circular). */
  declaration?: { provider: string; model: string; reason: string; declaredBy?: string; declaredAt?: string; expiresAt?: string }
}

/** La disposición de una PUERTA. `blocked` = exit ≠ 0 (puertas 1-2 y
 * mint); `degraded` = NO bloquea pero JAMÁS un ok silencioso (puerta 3 boot). */
export type ModelPinGateDecision = 'allow' | 'blocked' | 'degraded'

/**
 * F8 (gate unit-2) — el SELLO DE ENTRADA del informe: qué `settings.yaml`, qué
 * patches, qué perfil y qué fuentes de catálogo se leyeron, con su `ts`. Un
 * informe cuyo §2.5 no es datable es exactamente la familia de «detalle caduco»
 * (fb-352/fb-356): no se puede saber si mide el árbol que se cree.
 */
export interface ModelPinInputsStamp {
  /** El `ts` de la ejecución (el mismo que lleva la marca durable). */
  ts: number
  /** El `settings.yaml` leído (o la cadena vacía si no se leyó ninguno). */
  settingsYaml: string
  /** Los patches de perfil/bundle leídos, en orden. */
  patches: string[]
  /** El perfil nombrado en la invocación ('' cuando no se nombró). */
  profile: string
  /** El id de cada fuente de catálogo consultada (incluye las suplidas vía
   * `--catalog` y la built-in cuando aporta). */
  catalogSources: string[]
  /** La vía RUNTIME (`llm.listModels`) SÍ se consultó en esta ejecución. */
  runtimeCatalogConsulted: boolean
}

/** El informe completo del guard (la ÚNICA estructura que el wiring consume). */
export interface ModelPinCoherenceReport {
  verdicts: ModelPinVerdict[]
  /** Los pares ausentes (el `P \ C` del invariante) con su tramo y su fuente. */
  missing: ModelPinVerdict[]
  /** La clase NO_ADAPTER de fb-6 (aviso, NUNCA el bloqueo por subclase C1). */
  noAdapter: ModelPinVerdict[]
  /** Los pares que NINGUNA fuente pudo resolver (surface ausente) — información,
   * nunca permiso para callar: la puerta de BOOT degrada con ellos. */
  unverifiable: ModelPinVerdict[]
  decision: ModelPinGateDecision
  /** La línea única accionable (vacía cuando decision === 'allow'). */
  message: string
}

/** Normaliza para comparar (los ids comparan case-insensitive — el mismo
 * contrato del probe R2). */
function norm(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

/** El identificador legible de un pin: `provider/model` (o el provider solo
 * cuando el modelo está vacío — un pin incompleto se reporta, no se omite). */
export function pinLabel(pin: { provider: string; model: string }): string {
  const provider = (pin.provider ?? '').trim()
  const model = (pin.model ?? '').trim()
  if (provider === '' && model === '') return '(empty)'
  return model === '' ? `${provider}/(no-model)` : `${provider}/${model}`
}

/** La línea ACCIONABLE del §4.2: provider, model, tramo P#, y el fichero o
 * constante que lo fija. Un solo formato para todas las puertas. */
export function actionablePinLine(verdict: ModelPinVerdict): string {
  const { pin } = verdict
  return `${pinLabel(pin)} — tramo ${pin.source.tramo} (${pin.source.class}), fixed by ${pin.source.ref}`
}

/** La línea de re-resolución de un handle stale (P5) — la mitigación de fb-332:
 * NO exige un retire manual, RE-RESUELVE al pin actual al re-materializar. */
export function staleHandleRepairLine(verdict: ModelPinVerdict): string {
  return `${pinLabel(verdict.pin)} → ${verdict.retrofitModel} (handle stale re-resolved to the current pin; source ${verdict.pin.source.ref})`
}

/** Extrae el pin de la ÚLTIMA línea `request/header` de un log de sesión ya
 * decodificado (JSONL). Puro: `undefined` cuando no hay señal — nunca inventa
 * un route. La búsqueda se ACOTA a la COLA del log (16 MB): la última cabecera
 * de request está por definición cerca del final, así que el coste queda O(1)
 * para sesiones enormes (la latencia de una re-materialización no debe pagar
 * por todo el histórico) y `lastIndexOf` sigue siendo correcto.
 *
 * Es el lector del SUJETO del guard P5: el pin RESUELTO POR SESIÓN. NUNCA la
 * fecha de nacimiento del sessionId (los heads longevos reutilizan directorio
 * de sesión ⇒ 4 falsos positivos permanentes sobre heads vivos con ese
 * criterio ingenuo). */
export const MPC_RESOLVED_ROUTE_SCAN_TAIL_CHARS = 16 * 1024 * 1024

export function resolvedRoutePinFromSessionLog(text: string): { provider: string; model: string } | undefined {
  const tail = text.length > MPC_RESOLVED_ROUTE_SCAN_TAIL_CHARS ? text.slice(-MPC_RESOLVED_ROUTE_SCAN_TAIL_CHARS) : text
  const last = tail.lastIndexOf('"request/header"')
  if (last < 0) return undefined
  const lineEnd = tail.indexOf('\n', last)
  const line = tail.slice(last, lineEnd < 0 ? undefined : lineEnd)
  const provider = /"provider"\s*:\s*"([^"]+)"/.exec(line)
  const model = /"model"\s*:\s*"([^"]+)"/.exec(line)
  if (provider === null || model === null) return undefined
  return { provider: provider[1] ?? '', model: model[1] ?? '' }
}

/** El comparador PURO: por pin, contra UNA fuente de catálogo.
 *  - provider no registrado ⇒ NO_ADAPTER (aviso; fb-6, jamás C1);
 *  - modelo ausente en un provider REGISTRADO con catálogo ⇒ unknown-model;
 *  - pin incompleto (provider o model vacío) ⇒ unknown (no verificable);
 *  - modelo presente (case-insensitive) ⇒ ok.
 * NUNCA lanza. Un `check` vacío degrada a 'unknown' (surface ausente) — nunca
 * a un 'ok' implícito.
 */
export function comparePins(pins: readonly ModelPin[], catalog: LiveCatalogSource | undefined): ModelPinVerdict[] {
  const check = catalog?.id ?? ''
  return pins.map((pin): ModelPinVerdict => {
    const provider = (pin.provider ?? '').trim()
    const model = (pin.model ?? '').trim()
    if (provider === '' || model === '') {
      return { pin, kind: 'unknown', check, detail: `incomplete pin (provider/model empty) — not verifiable` }
    }
    if (check === '') {
      return { pin, kind: 'unknown', check, detail: `no catalog source available (surface absent) — pin not verified` }
    }
    const entry = catalog?.providers?.[provider]
    if (entry === undefined) {
      return { pin, kind: 'unknown', check, detail: `catalog source "${check}" declares no provider "${provider}" — pin not verified` }
    }
    if (!entry.registered) {
      return { pin, kind: 'NO_ADAPTER', check, detail: `provider "${provider}" is NOT registered (fb-6 class — the boot FIX-2 check owns the alert); model "${model}" not verified` }
    }
    const has = entry.models.some((id) => norm(id) === norm(model))
    return has
      ? { pin, kind: 'ok', check, detail: `model "${model}" is in the live catalog of provider "${provider}"` }
      : { pin, kind: 'unknown-model', check, detail: `model "${model}" is NOT in the live catalog of provider "${provider}" — add it BEFORE rotating/restarting` }
  })
}

/**
 * El veredicto de coherencia sobre N fuentes: el pin es `ok` cuando AL MENOS
 * una fuente lo resuelve; es `unknown-model` cuando TODAS las fuentes que
 * declaran su provider lo niegan (evidencia POSITIVA de ausencia); y es
 * `unknown` cuando ninguna fuente declara el provider (surface ausente).
 *
 * Esta distinción es la que separa un bloqueo legítimo de un falso positivo:
 * un `unknown-model` es una discrepancia DECLARADA (hallazgo), un `unknown` es
 * ausencia de evidencia (aviso + DEGRADED en boot, bloqueo sólo cuando NO
 * existe ninguna fuente estática).
 */
export function comparePinsAgainstCatalogSources(pins: readonly ModelPin[], sources: readonly LiveCatalogSource[]): ModelPinVerdict[] {
  return pins.map((pin): ModelPinVerdict => {
    const provider = (pin.provider ?? '').trim()
    const model = (pin.model ?? '').trim()
    const perSource = sources.map((source) => comparePins([pin], source)[0] as ModelPinVerdict)
    if (provider === '' || model === '') {
      return { pin, kind: 'unknown', check: sources.map((s) => s.id).join('+'), detail: 'incomplete pin (provider/model empty) — not verifiable' }
    }
    if (sources.length === 0) {
      return { pin, kind: 'unknown', check: '', detail: 'no catalog source available (surface absent) — pin not verified' }
    }
    const ok = perSource.find((v) => v.kind === 'ok')
    if (ok !== undefined) return ok
    const noAdapter = perSource.find((v) => v.kind === 'NO_ADAPTER')
    const denied = perSource.find((v) => v.kind === 'unknown-model')
    if (denied !== undefined) {
      return {
        pin,
        kind: 'unknown-model',
        check: denied.check,
        detail: `${denied.detail} (declared absent by: ${perSource.filter((v) => v.kind === 'unknown-model').map((v) => v.check).join(', ')})`
      }
    }
    if (noAdapter !== undefined) return noAdapter
    return {
      pin,
      kind: 'unknown',
      check: perSource.map((v) => v.check).filter((id) => id !== '').join('+'),
      detail: perSource[0]?.detail ?? 'catalog sources could not resolve the provider — pin not verified'
    }
  })
}

/**
 * La DISPOSICIÓN de la puerta, PURA. `phase`:
 *  - 'deploy-preflight' (puertas 1-2, BLOQUEANTE, fail-loud): bloquea con
 *    cualquier par ausente; bloquea también cuando NO existe ninguna fuente
 *    estática (el invariante no se pudo establecer ⇒ un subconjunto prohibido
 *    podría estar activo — PROHIBIDO el fail-open). Un provider no registrado
 *    (NO_ADAPTER) AVISA, no bloquea (fb-6: es otra clase).
 *  - 'boot' (puerta 3, NO bloqueante pero JAMAIS un ok silencioso): `allow`
 *    sólo con 0 ausentes Y 0 no-verificables; si hay ausentes o el surface
 *    falta ⇒ `degraded` (alerta + finding durable + marca DEGRADED).
 *  - 'mint' (puerta 4, R2 conservado): `blocked` con ausentes (el caller de
 *    mint ABORTA fail-loud); 'ok'/'retrofitted' los decide el caller.
 *
 * F5 (fix-forward del gate unit-2): en 'deploy-preflight' la COINCIDENCIA de
 * ambas vías es el invariante, así que la AUSENCIA de la vía RUNTIME también
 * BLOQUEA (`runtimeSourcePresent === false`). Antes el PROBLEM sólo se acumulaba
 * y el CLI salía 0: una mitad estática sola es un «ok» silencioso, que es
 * exactamente el fallo del 09-10. Para la mitad runtime ausente NO se usa
 * `degraded` (sería indistinguible de un «allow con aviso») y NO hay escape
 * hatch: las dos salidas legítimas son correr in-process con `llm`, o suplir el
 * catálogo con `--catalog`.
 *
 * MATIZ CORREGIDO (defecto de precisión MEDIDO por el gate unit-2 — este
 * comentario decía que `degraded` «está reservada a la puerta de BOOT», y es
 * INEXACTO): 'deploy-preflight' SÍ devuelve `degraded` —para los pines NO
 * VERIFICABLES, `unverifiable.length > 0`, abajo— y el CLI lo mapea a EXIT=2
 * (`scripts/mpc-preflight.mjs`: un `deploy` nunca sale 0 con `degraded`). La
 * distinción real es «`blocked` = violación o evidencia ausente / `degraded` =
 * no verificable», no «`degraded` = sólo boot».
 */
export function decide({
  phase,
  verdicts,
  staticSourcePresent,
  runtimeSourcePresent
}: {
  phase: 'deploy-preflight' | 'boot' | 'mint'
  verdicts: readonly ModelPinVerdict[]
  staticSourcePresent: boolean
  /** La vía RUNTIME (`llm.listModels`) se consultó. `undefined` = el caller no
   * la mira (comportamiento previo, sin cambio); `false` = NO corrió ⇒ en
   * deploy-preflight BLOQUEA. */
  runtimeSourcePresent?: boolean
}): { decision: ModelPinGateDecision; message: string } {
  const missing = verdicts.filter((v) => v.kind === 'unknown-model')
  const unverifiable = verdicts.filter((v) => v.kind === 'unknown')
  const noAdapter = verdicts.filter((v) => v.kind === 'NO_ADAPTER')
  if (phase === 'deploy-preflight') {
    if (!staticSourcePresent) {
      return {
        decision: 'blocked',
        message: `[MPC-PREFLIGHT] ABORTED (fail-loud, never fail-open): NO static catalog source could be read — the invariant pines ⊆ live catalog is UNVERIFIED and a prohibited subset may be active; fix the catalog path/parse and re-run (a deploy must never restart with the invariant unverified)`
      }
    }
    if (runtimeSourcePresent === false) {
      return {
        decision: 'blocked',
        message: `[MPC-PREFLIGHT] ABORTED (I-MP UNVERIFIED — the RUNTIME half was NOT consulted): the static catalog alone (settings.yaml) is NOT evidence of the live adapter catalog, so a prohibited subset could be active while the static ids still resolve; the deploy must NOT proceed (DO NOT restart). Two legitimate exits: (1) run the guard IN-PROCESS with the live llm primitive — runMpcPreflight({ llm: ctx.llm }) (model-pins-runner.ts; the runtime source llm.listProviders()/llm.listModels() is the probe R2 route) — or (2) supply that catalog to the CLI as JSON: --catalog <json> (shape { "id": "runtime-llm", "providers": { "<provider>": { "models": ["<id>"], "registered": true } } }). There is deliberately NO flag to deploy with the static half alone`
      }
    }
    if (missing.length > 0) {
      return {
        decision: 'blocked',
        message: `[MPC-PREFLIGHT] ABORTED (I-MP violated): ${missing.length} model pin(s) are NOT in the live catalog — the deploy must NOT proceed (DO NOT restart). Missing: ${missing.map((v) => actionablePinLine(v)).join(' | ')}. Fix the LIVE CATALOG (ADD the id — additive-first: never remove an id still referenced by a deployed pin) or rotate the pin, then re-run`
      }
    }
    if (unverifiable.length > 0) {
      return {
        decision: 'degraded',
        message: `[MPC-PREFLIGHT] WARN (never a silent ok): ${unverifiable.length} pin(s) could not be verified against any source — ${unverifiable.map((v) => actionablePinLine(v)).join(' | ')}`
      }
    }
    if (noAdapter.length > 0) {
      return {
        decision: 'allow',
        message: `[MPC-PREFLIGHT] ok with ${noAdapter.length} NO_ADAPTER warning(s) (fb-6 class — separate from I-MP): ${noAdapter.map((v) => actionablePinLine(v)).join(' | ')}`
      }
    }
    return { decision: 'allow', message: '' }
  }
  if (phase === 'mint') {
    if (missing.length > 0) {
      return {
        decision: 'blocked',
        message: `[MPC-PREFLIGHT] mint ABORTED (fb-42 class): ${missing.map((v) => actionablePinLine(v)).join(' | ')} — configure the model in the provider settings BEFORE materializing`
      }
    }
    return { decision: 'allow', message: '' }
  }
  // phase === 'boot' — NON-blocking (denying the boot loses the repairing
  // actor) but NEVER a silent ok: a degraded mark is mandatory.
  if (missing.length > 0 || unverifiable.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push(`${missing.length} missing: ${missing.map((v) => actionablePinLine(v)).join(' | ')}`)
    if (unverifiable.length > 0) parts.push(`${unverifiable.length} unverified: ${unverifiable.map((v) => actionablePinLine(v)).join(' | ')}`)
    return {
      decision: 'degraded',
      message: `[MPC-PREFLIGHT] DEGRADED (I-MP not fully verified at boot — the boot is NOT denied, the repairing actor must survive): ${parts.join(' ;; ')}`
    }
  }
  return { decision: 'allow', message: '' }
}

/** Las fuentes que NO son la vía estática (settings.yaml): la vía runtime
 * (`runtime-llm`) y un catálogo suplido por el caller (`--catalog`, id libre).
 * TODAS cuentan como «la mitad runtime/live se consultó» para el gate F5, porque
 * cada una declara el REGISTRO del adapter en lugar de los ids estáticos del
 * fichero.
 *
 * NO cuenta la fuente built-in (`builtin-adapter`): es una declaración ESTÁTICA
 * de las rutas del bundle, no evidencia del catálogo vivo — si contara, un
 * deploy sin `llm` ni `--catalog` pasaría el gate con la mitad estática sola
 * (exactamente el fail-open que el gate unit-2 exige cerrar). */
export function runtimeHalfConsulted(sources: readonly LiveCatalogSource[]): boolean {
  return sources.some((s) => s.id !== 'settings-yaml' && s.id !== BUILTIN_CATALOG_SOURCE_ID)
}

/** El informe PURO completo: compara + decide. El caller (runner/wiring) le
 * añade los handles P5 (que son dinámicos) y los efectos (alerta/finding). */
export function buildCoherenceReport({
  pins,
  sources,
  phase,
  explicitRuntimeSources
}: {
  pins: readonly ModelPin[]
  sources: readonly LiveCatalogSource[]
  phase: 'deploy-preflight' | 'boot' | 'mint'
  /** El caller suplió una fuente de catálogo NO estática (p.ej. `--catalog`):
   * satisface la mitad runtime del gate F5 aunque no exista `runtime-llm`. */
  explicitRuntimeSources?: boolean
}): ModelPinCoherenceReport {
  const verdicts = comparePinsAgainstCatalogSources(pins, sources)
  const { decision, message } = decide({
    phase,
    verdicts,
    // §4.2: el pre-flight usa la vía ESTÁTICA (--dump-config / settings.yaml) y
    // exige coincidencia; una composición SOLO-runtime (sin fuente estática) no
    // puede establecer el invariante y NO pasa en silencio.
    staticSourcePresent: sources.some((s) => s.id !== 'runtime-llm' && Object.keys(s.providers).length > 0),
    // F5: con el conjunto vacío de fuentes el bloqueo por «sin fuente estática»
    // ya es el mensaje correcto; el gate runtime sólo se evalúa con fuentes.
    runtimeSourcePresent: sources.length === 0 ? undefined : runtimeHalfConsulted(sources) || explicitRuntimeSources === true
  })
  return {
    verdicts,
    missing: verdicts.filter((v) => v.kind === 'unknown-model'),
    noAdapter: verdicts.filter((v) => v.kind === 'NO_ADAPTER'),
    unverifiable: verdicts.filter((v) => v.kind === 'unknown'),
    decision,
    message
  }
}

/**
 * P5 (fb-332) — el HANDLE PERSISTIDO/STALE en el punto de RE-MATERIALIZACIÓN.
 *
 * REQUISITO DURO (coordinación con el QD, NO reinterpretable): el sujeto es el
 * pin/modelo RESUELTO POR TURNO/SESIÓN (lo que el handle va a pedir en su
 * próximo request), NUNCA la fecha de nacimiento del sessionId. Los heads
 * longevos REUTILIZAN directorio de sesión; un criterio por fecha de sessionId
 * produce 4 falsos positivos permanentes sobre heads vivos (evidencia: los 3
 * heads actuales con sessionId pre-fix resuelven deepseek-flash/opencode-zen,
 * 0 campos legacy). Por eso ESTA función sólo mira el par
 * (provider, model) del handle y el catálogo: nada de timestamps.
 *
 * Devuelve:
 *  - undefined cuando el par del handle ES servible (o incompleto: el
 *    resolveMaterializeAgentOptions de fb-6 ya posee esa clase, no se pisa);
 *  - un veredicto `retrofitted` cuando el modelo del handle está ausente del
 *    catálogo PERO el pin actual SÍ está ⇒ el caller re-materializa con el pin
 *    actual + aviso (mitiga fb-332 SIN exigir un retire manual);
 *  - un veredicto `unknown-model` cuando NI el modelo del handle NI el pin
 *    actual están en el catálogo ⇒ el caller avisa fail-loud (el fix global no
 *    cubre ese handle).
 */
export function resolvedStaleHandleVerdict({
  handleOptions,
  currentPin,
  catalog,
  source
}: {
  handleOptions: AgentPinOptions | undefined
  currentPin: ModelPin | undefined
  catalog: LiveCatalogSource | undefined
  source: ModelPinSource
}): ModelPinVerdict | undefined {
  const provider = (handleOptions?.provider ?? '').trim()
  const model = (handleOptions?.model ?? '').trim()
  if (provider === '' || model === '') return undefined
  const handlePin: ModelPin = { provider, model, source }
  const verdict = comparePins([handlePin], catalog)[0] as ModelPinVerdict
  if (verdict.kind !== 'unknown-model') return undefined
  const current = currentPin === undefined
    ? undefined
    : comparePins([{ ...currentPin, provider: currentPin.provider, model: currentPin.model }], catalog)[0]
  if (current?.kind === 'ok' && norm(currentPin?.model) !== norm(model)) {
    return { pin: handlePin, kind: 'retrofitted', retrofitModel: currentPin?.model, check: verdict.check, detail: verdict.detail }
  }
  return verdict
}
