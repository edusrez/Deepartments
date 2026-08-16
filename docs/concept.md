# Deepartments — concepto (2026-08-16): decisiones cerradas + research resuelto

> Memoria de las decisiones del propietario (2026-08-16) y del mapeo
> IDEA→DSH resuelto. Este documento es la referencia de trabajo del repo:
> qué se decidió, por qué, y cómo se mapea la idea a primitivas de
> DeepSeek Harness (DSH). La idea reenmarcada vive en [IDEA.md](IDEA.md);
> el plan en [ROADMAP.md](ROADMAP.md).

## 1. Resumen y registro de decisiones

**Resumen.** La fase 1 de Deepartments (debate y forma) se cierra. Las 9
decisiones del propietario fijan el producto — un **paquete npm bundle de
plugin** de DSH, **headless-first**, con dogfooding sobre el propio repo — y
el research confirma la API de plugins (`@deepseek-ai/dsh@0.1.0-rc.6`). Este
concepto consolida el mapeo IDEA→DSH **sin celdas pendientes**, define el
**MVP definitivo** (fase 2) y registra la propuesta de naming del paquete.

**Registro de decisiones del propietario (2026-08-16) — VINCULANTES.**

| # | Decisión | Elección (decidido) | Implicación |
|---|---|---|---|
| 1 | Distribución | **Paquete npm bundle de plugin** (no un profile) | El repo Deepartments **ES** el paquete del plugin: package.json con `dsh.bundle`, `cordis.patch.yml`, `src/`→`lib/`. Un profile de ejemplo `deepartments` puede documentarse, pero no es el producto. |
| 2 | UI | **Headless-first** | El MVP no lleva client plugin; la UI (observador total) entra en fase 3+. |
| 3 | Destino del workspace legado | **Residual** — "nos quedamos solo con la idea adaptada al harness de DSH" | La idea migra a Deepartments; el workspace legado queda como legado y workspace del preset (el preset del workspace anterior sigue funcionando desde ahí mientras Deepartments no lo sustituya). **Dogfooding del MVP sobre el propio repo Deepartments**: el primer departamento —programación— construye el plugin que lo ejecuta (auto-bootstrap). |
| 4 | Preset del workspace anterior | **Congelado de facto**; su contenido se absorbe como contenido del plugin | El skill de flujo multi-agente, las plantillas de roles (orquestador, builders, reviewer) y la convención de reportes pasan a ser contenido de Deepartments. El preset sigue operando, sin features nuevas. |
| 5 | Licencia | **MIT** | Ya materializada: el repo tiene `LICENSE` MIT. |
| 6 | Nombre | **Deepartments**; paquete `dsh-deepartments`; el nombre del despliegue propuesto queda **anulado** | Justificación en §1.1: el primer despliegue se llama simplemente "el primer despliegue" (la organización de programación). |
| 7 | Testigo | **Frontmatter YAML + cuerpo markdown** | La convención `_reports/` actual; compatible con la memoria inter-agente ya establecida. Es la capa humana sobre el mecanismo nativo (eventos de sesión, §3). |
| 8 | Gobernanza MVP | **Mínima** | Operativo delegado al jefe de grupo; diseño/dirección suben al CEO (`ask_user_question`). Política editable en fase 3. |
| 9 | Puesto dormido | **Subagente continuable + testigo en fichero** | `send_message`/`followup` reanuda la conversación del puesto; el testigo frontmatter/cuerpo es el relevo; el research añade `session.append` + `sessionProjections` como capa programática del mismo estado. |

### 1.1 Naming (decisión 6) — propuesta con justificación

- **Paquete npm: `dsh-deepartments`.** La convención de la comunidad DSH para
  plugins de terceros es `dsh-<nombre>` (`dsh-hello-plugin` en hello-dsh,
  `dsh-agent-teams`); los plugins de primera parte usan `@deepseek-ai/*`.
  `@deepartments/dsh-plugin` es válido pero añade fricción de instalación
  (scope en npm) sin beneficio en el MVP. `dsh-deepartments` comunica "plugin
  de DSH" de un vistazo y matchea el prefijo de los bundles de referencia.
- **Nombre del despliegue — ANULADO.** El v2 proponía conservar el nombre del
  workspace legado como nombre del despliegue / de la primera organización que
  ejecute el plugin. Esa propuesta queda **anulada** (2026-08-16): el primer
  despliegue se llama simplemente **"el primer despliegue"** — la
  **organización de programación** que hace dogfooding sobre el propio repo.
  El producto es **Deepartments**.

## 2. Posicionamiento

**Deepartments, en una frase:** la idea del workspace legado materializada
como **plugin npm de DeepSeek Harness** — una capa de organización agéntica
(departamentos, puestos que duermen y despiertan, testigos, activaciones,
gobernanza) sobre el runtime DSH.

**Deepartments es el proyecto.** Ya no es "una idea con su propio repo": es un
**paquete bundle** instalable (`dsh plugin --profile <x> add dsh-deepartments`)
que aporta su capa de configuración y servicios al runtime. DSH responde al
*cómo se ejecuta* (sesiones, subagentes, schedule, skills, jobs, tools);
Deepartments responde al *cómo se organiza* (qué es un puesto, un
departamento, una sala, un testigo, una activación, una política de
gobernanza).

**El workspace legado es residual.** Sigue existiendo como legado y como
workspace del preset del workspace anterior (que sigue operando desde ahí,
congelado de facto, decisión 4). La idea viva vive en Deepartments.

**La forma concreta** sigue siendo el entorno de programación agéntico (el
"giro" de IDEA.md): se habla con un equipo de agentes que se especializa con
el tiempo, no con un único agente con subagentes. El primer despliegue
(auto-bootstrap) es un equipo de desarrollo cuyo primer cliente es el propio
sistema — **el repo Deepartments mismo** (decisión 3): el departamento de
programación construye el plugin que lo ejecuta.

## 3. Mapeo IDEA → primitivas DSH — RESUELTO

> Fuente: `_research/2026-08-16-dsh-plugin-api.md` (sección 4 y
> Recommendations). Todas las celdas `[pendiente de research]` del v1 quedan
> sustituidas por el hallazgo concreto. Estado por fila:
> **[nativo]** primitiva DSH lista para adoptar · **[convención a construir]**
> modelo de ficheros/procesos que el plugin define · **[código plugin]**
> servicio/listener que el bundle implementa sobre primitivas nativas.

| Concepto IDEA | Primitiva DSH (resuelto) | Estado |
|---|---|---|
| **Salas** (comunicación agente↔agente, de 2 a N, una sala a la vez) | Sin chat grupal en DSH: la comunicación es 1-a-1 (`subagent`/`send_message`/`report`) o vía workspace compartido. La sala se modela como **convención**: directorio del grupo (workspace) + agentes dedicados (jefe, recepción) + lecturas cruzadas nativas vía `ctx.sessionReferenceResolver` (snapshots read-only de otras sesiones inyectados como contexto `@[label](dsh-session:<id>)`, límites configurables). | [convención a construir] |
| **Puestos persistentes** que duermen/despiertan | `ctx.subagents.startContinuable(spec)` → hijo durable que devuelve `{childId, messageId}` y hace **cold-resume desde su sesión persistida**; `followup(parent, childId, content)` lo reanuda — literalmente "un puesto que despierta". El research lo confirma: "exactamente el mecanismo para puestos que despiertan". | [nativo] |
| **Sesiones finitas** | Sesiones headless **persistidas event-sourced** (JSONL zstd por workspace): `dsh --profile headless "job"` = one fresh persisted session; `ctx.sessions.create/fork/get/list/flush`. Cada activación abre una sesión nueva. | [nativo] |
| **Testigo** (relevo entre sesiones; lo escribe el sistema, no el agente) | **Doble capa.** Nativa: `session.append('deepartments/<evento>', data)` con tipos propios vía `declare module '@deepseek-ai/dsh-session/types'` (durable, auditable, reproducible) + `ctx.sessionProjections` (unidad pura `{key, schema, init, apply, view}`) que proyecta el **estado vivo del puesto**; la escritura automática al dormirse se hace con un listener sobre `agent/turn-stopping` (el hook existe). Convención humana (decisión 7): frontmatter YAML + cuerpo markdown, los `_reports/` actuales. | [nativo + convención a construir] |
| **Puestos efímeros** | `subagent` spawn de un solo uso; `workflow` para fan-out desechable. | [nativo] |
| **Activaciones — ritmos (programáticas)** | **`dsh-schedule`**: `schedule_create/list/delete`; el estado vive en el log de la sesión (`schedule/change`); al vencer, el agente se despierta con un **`followup()`** normal cuando está idle (one-shot `at`/`after_seconds`, recurrencia `every_seconds` ≥5min). "Este es el mecanismo nativo para 'activaciones' de puestos." Nota: requiere montarse tras sessions/agents/tools/sessionPersistence; los runtime children no lo reciben. | [nativo] |
| **Activaciones — eventos del mundo (reactivas)** | Eventos del sistema (`session/event` stream completo, `agent/pre-step`, `agent/turn-stopping`…) + **MCP client** (`dsh-mcp-client`) para el mundo externo. El plugin **mapea eventos→activaciones** (listener + `startContinuable`/`followup`). | [código plugin] (sobre eventos nativos) |
| **Activaciones — encargos** (una sesión despierta a otra) | `send_message` / `followup(parent, childId, content)` a un subagente continuable dormido; la "bandeja" = estado persistido del puesto (eventos de sesión + proyección). | [nativo] |
| **Activación — el CEO** (la palabra del humano) | Mensaje del usuario en la GUI + `ask_user_question` como canal de veto/microdecisión. No es una excepción: un evento más que despierta al orchestrator. | [nativo] |
| **Orchestrator** (mano derecha del CEO) | **Agent preset** — ya existe el preset del workspace anterior (agent.cordis.yml + preset.yml + skills/); API `ctx.agentPresets` (list/resolve/read/copy/mount/recompose). Deepartments lo generaliza y productiza. Regla del plano: un preset contribuye al agente (tools, persona, prompt sections); los registries son del host; un servicio propio del preset exige grupo con `isolate: true`. | [nativo] |
| **Memoria SESIÓN** (corto plazo) | Contexto activo + compactación (`dsh-compaction-basic`) + token-meter. Efímera por naturaleza, como en IDEA. | [nativo] |
| **Memoria TESTIGO** | Ver "Testigo": eventos de sesión + proyección + convención `_reports/`. | [nativo + convención] |
| **Memoria SALA** | Workspace del grupo (directorio con su memoria: archivos, reportes, pizarra) + `_reports/<agente>/`. | [convención a construir] |
| **Memoria ORGANIZACIONAL** | Repo global, docs vivos (AGENTS.md, docs/), skills, `_research/`, historial de sesiones (`ctx.sessions.get/list`). Consultable desde todas las "salas". | [convención (ya en uso)] |
| **Contextualizador** (3 modos) | Modo 1 (al despertar): system-prompt / agent-instructions + skill inyectado por preset. Modo 2 (a demanda): grep/glob, `scripts/report_search.py`, web. Modo 3 (proactivo / lecturas cruzadas): **`ctx.sessionReferenceResolver`** — snapshots read-only de otras sesiones inyectados como contexto model (maxReferences=3 por defecto). | [nativo (modo 3) + convención (modos 1-2)] |
| **Gobernanza** (operativo/diseño/dirección; política con excepciones) | Config declarativa del plugin + persona del orchestrator + `ask_user_question` como canal de veto. No hay primitiva de "política de permisos": se modela en config y prompts. MVP: mínima (decisión 8); política editable en fase 3. | [código plugin + convención] |
| **Emergencia canalizada** (el sistema propone, el CEO aprueba/veta) | Convención: el sistema propone en reportes/documentos; el CEO decide vía `ask_user_question`; el CEO crea grupos directamente cuando él lo decide. | [convención] |
| **Auto-modificación** (estructura e implementación) | Los builders editan presets/skills/el propio plugin (`ctx.agentPresets` + ficheros del repo; precedente: patch de `trustedHosts` en STATUS.md). Dogfooding: el primer departamento (programación) construye el plugin. Salvaguardas y "estructura por defecto" recuperable: decisión de diseño. | [nativo + código plugin] |
| **Auto-observación** (funcionamiento, resultados, evolución) | Señales crudas **nativas**: `sessionProjections`, token-meter, job registry, `list_agents`, historial de sesiones, eventos `goal/change`. La interpretación es agéntica (grupo de calidad, fase 4). | [nativo (señales) + código plugin (interpretación)] |
| **Calidad / sueño** (entrevista post-sesión) | El `reviewer` es el germen del grupo de calidad. El "sueño" = listener sobre `agent/turn-stopping` que despacha un agente de calidad con los datos de la sesión — los hooks de ciclo de vida **existen**. | [código plugin] (hooks nativos) |
| **UI web — observador total** (leer cualquier sala) | **Client plugin doble cara npm**: manifest `dsh.client`, export `"./client"`, bundle CJS con tsdown (closure-factory `window.__ModuleLoader__.load`), Slots, `host.call` JSON-RPC; exige **dos programas tsc separados** (host vs client). Diferido a fase 3+ (decisión 2). | [nativo — diferido] |
| **Infraestructura no agéntica** (activador, contextualizador, escritor de testigos, memoria) | El runtime host (registry de subagentes, jobs, skills, goals, sesiones, schedule) + los servicios que el plugin registre. "Permanente y no agéntica", como en IDEA. | [nativo] |

**Lectura del mapeo.** El research cambia el veredicto del v1: lo que parecía
"a construir" es en su mayoría **nativo y listo para adoptar** — puestos que
duermen (`startContinuable`), activaciones (`dsh-schedule` + `followup()`),
testigo/estado (`session.append` + `sessionProjections`), lecturas cruzadas
(`sessionReferenceResolver`), hooks de ciclo de vida (`agent/session-start`,
`agent/turn-stopping`). El plugin **construye**: la sala como convención, la
capa humana del testigo, la política de gobernanza, el mapeo
eventos→activaciones y la interpretación de señales (calidad). El valor
diferencial se mantiene y se refuerza: **DSH delega; Deepartments organiza.**

## 4. MVP definitivo (fase 2)

**Objetivo del MVP:** formalizar como plugin lo que hoy hacemos a mano con el
preset del workspace anterior (que queda congelado, decisión 4) y añadir lo
único que el preset no tiene: **puestos persistentes con testigo entre
sesiones**, con el ciclo de vida gestionado por el plugin (decisión 9 +
research).

**Alcance del MVP — "un departamento, puestos que duermen, dogfooding":**

1. **Un departamento: programación.** Roles absorbidos del setup anterior
   (decisión 4): jefe de grupo, builders (tiers builder/builder-pro/builder-max)
   y reviewer. Su "sala" (memoria de grupo) es el **propio repo Deepartments**:
   workspace + convención de ficheros (reportes, estado del puesto).
2. **Puestos persistentes.** Cada trabajador es un puesto: **subagente
   continuable** (dormido en storage entre activaciones) + **testigo**
   frontmatter YAML + cuerpo markdown (decisión 7) + eventos de sesión
   (`session.append('deepartments/*')` + proyección del puesto) como capa
   programática.
3. **El flujo del CEO.** Propietario → orchestrator (preset) → jefe del
   departamento → **N builders en paralelo** (ficheros disjuntos) → reviewer →
   verificación → commit. Al terminar (o al agotar contexto), el puesto del
   jefe se duerme dejando testigo; el **plugin** gestiona dormir/despertar/
   testigo — no el orchestrator manual de pegamento.
4. **Dogfooding (decisión 3).** El primer encargo real del CEO al departamento
   de programación es **construir el propio plugin**: auto-bootstrap — el
   primer departamento construye la herramienta que lo ejecuta, sobre el repo
   Deepartments.
5. **Headless (decisión 2).** Sin client plugin; la verificación es por
   `--dump-config` + smoke headless + tests (CLI/reportes), no visual.

**Criterios de éxito del MVP (medibles, heredados del v1):**

1. Un encargo del CEO atraviesa CEO → orchestrator → jefe → N builders en
   paralelo → reviewer → verificación → commit **y**, en mitad del camino, el
   puesto del jefe (o de un builder) se duerme y retoma la tarea en una sesión
   nueva **sin pérdida de información**: el testigo funciona.
2. El flujo funciona **sin que el orchestrator manual haga de pegamento**: el
   plugin (o el jefe de grupo vía tools `dept_*`) gestiona dormir/despertar/
   testigo.

**Qué NO entra en el MVP:** salas múltiples y recepción de visitas;
activaciones programáticas (ritmos) y reactivas (eventos del mundo) — solo la
activación del CEO y encargos manuales; UI web (client plugin, decisión 2);
calidad/sueño completo (se queda el reviewer); contextualizador proactivo (se
queda el manual); política de gobernanza editable (decisión 8);
auto-modificación estructural (sí dogfooding del flujo de trabajo, no
auto-cambio de la configuración del plugin).

## 5. Riesgos (actualizados con la mitigación del research)

1. **API de plugins en rc con breaking changes prometidos.** El runtime es
   0.1.0-rc.6 y el README declara "THERE WILL BE COMPATIBILITY-BREAKING
   CHANGES" (rc.2 ya renombró `httpServer`→`webServer`). *Mitigación
   (research):* **pin del CLI** (`npx -p @deepseek-ai/dsh@0.1.0-rc.6`),
   construir contra la API estable de Cordis (`apply/ctx/inject/events/
   effects`) y los servicios longevos (sessions, tools, skills, agentPresets),
   **aislar servicios renombrables** con `ctx.get('webServer') ??
   ctx.get('httpServer')`, `peerDependencies` en canal rc (`^0.1.0-rc.x` — un
   `^0.0.1` no matchea rc), versionar el bundle como rc propio con su pin.
2. **Alcance del IDEA vs MVP.** La tentación de implementar todo (salas,
   activaciones, calidad, auto-modificación) de golpe mataría el MVP.
   *Mitigación (sin cambios):* MVP mínimo explícito (§4) y criterios de salida
   por fase; lo que no entra está escrito y se valida después.
3. **Redundancia con primitivas DSH.** El research reduce este riesgo: los
   mecanismos que parecían a construir son nativos — **no inventar un
   scheduler propio** (usar `dsh-schedule`), no reconstruir puestos (usar
   `startContinuable`), no reimplementar persistencia (usar eventos de sesión
   + proyecciones). *Mitigación:* capa fina que adopta primitivas donde encajan
   (el mapeo de §3 distingue nativo/convención/código); el valor del plugin es
   el modelo organizativo, no reimplementar delegación.
4. **Esfuerzo de UI web (client plugin).** API de client plugins compleja (dos
   tsc programs, tsdown, Slots). *Mitigación:* **headless-first decidido**
   (decisión 2); la UI se difiere a fase 3+ con la guía de referencia ya
   validada (dsh-agent-teams) y verificación numérica (CLI/reportes), no
   visual.
5. **Hooks que podían no existir — RESUELTO.** El research confirma que los
   hooks existen: `agent/session-start`, `agent/pre-step`, `agent/turn-
   stopping`, `session/event`, `sessionReferenceResolver`, `sessionProjections`
   y `dsh-schedule`. Riesgo residual: renombramientos de servicios (→ `ctx.get`
   con fallback) y accidentes de autoría (→ **reglas no negociables** del
   research: sin `export default` — postmortem 0001; `!!js` solo en config —
   0002; `defineTool` con `output`; tests por el Loader real). *Mitigación
   adicional:* desarrollo en **profile aislado** `deepartments-dev` con
   verificación offline `--dump-config` (nunca contra el profile web en uso) y
   **skills para conducta** (markdown, inmunes a breaking changes) en lugar de
   código donde baste.
