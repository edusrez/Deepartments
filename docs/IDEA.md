# IDEA — la organización agéntica como capa sobre DeepSeek Harness

> El "giro": en lugar de hablar con un único agente que despacha subagentes, se
> habla con un **equipo de agentes** — una organización que se especializa con
> el tiempo y que puede cambiar su propia estructura. Este documento reenmarca
> la idea original **adaptada al harness de DeepSeek Harness (DSH)**: cada
> concepto describe su naturaleza y su mecanismo "en DSH". Las decisiones y el
> mapeo detallado viven en [concept.md](concept.md); el plan en
> [ROADMAP.md](ROADMAP.md).

## Naturaleza: una organización genérica y auto-mutable sobre DSH

Una organización agéntica (no solo de programación) compuesta por
**departamentos** y **puestos**. Los puestos no son procesos: son roles
persistentes que **duermen y despiertan**, ocupados por agentes. La
organización se observa, se evalúa y se modifica a sí misma, con gobernanza
y salvaguardas.

**En DSH:** DSH es "todo es un plugin" sobre Cordis. Deepartments es un
**paquete npm bundle** (`dsh-deepartments`) que aporta su capa de
configuración y servicios al runtime. DSH delega (sesiones, subagentes,
schedule, skills, jobs, tools); Deepartments organiza (puestos,
departamentos, salas, testigos, activaciones, gobernanza).

## Puesto, sesión y testigo

- **Puesto**: un rol persistente de la organización. Un agente lo ocupa
  mientras está activo; al terminar su turno, el puesto **se duerme** y deja
  un **testigo** (el relevo entre sesiones, escrito por el sistema, no por el
  agente). Al despertar, retoma desde donde quedó.
- **Sesión**: cada activación abre una **sesión finita** — el turno de
  trabajo del puesto. La sesión termina; el puesto permanece.
- **Testigo**: el puente entre sesiones: qué se hizo, qué quedó pendiente,
  qué contexto necesita el siguiente turno.

**En DSH:** puestos = `ctx.subagents.startContinuable(spec)` → hijo durable
con **cold-resume desde su sesión persistida**; despertar =
`followup(parent, childId, content)` (literalmente "un puesto que despierta").
Sesiones = sesiones headless **persistidas event-sourced** (JSONL zstd por
workspace). Testigo = **doble capa**: nativa (`session.append(
'deepartments/<evento>', data)` + `ctx.sessionProjections` para el estado
vivo del puesto; la escritura al dormirse se hace con un listener sobre
`agent/turn-stopping`) + convención humana (frontmatter YAML + cuerpo
markdown).

## Sistema de salas

La comunicación entre agentes se organiza en **salas**: de 2 a N agentes,
una sala a la vez. La sala es la memoria viva del grupo (sus archivos, sus
reportes, su pizarra).

**En DSH:** no hay chat grupal nativo — la comunicación es 1-a-1
(`subagent`/`send_message`/`report`) o vía workspace compartido. La sala se
modela como **convención**: directorio del grupo (workspace) + agentes
dedicados (jefe, recepción) + lecturas cruzadas nativas vía
`ctx.sessionReferenceResolver` (snapshots read-only de otras sesiones
inyectados como contexto, límites configurables). Salas múltiples con
recepción y visitas: fase 3.

## Sistema de activaciones

Cuatro vías por las que un puesto despierta:

1. **El CEO** — la palabra del humano.
2. **Encargos** — una sesión despierta a otra.
3. **Ritmos** — programáticas, por calendario o intervalo.
4. **Eventos del mundo** — reactivas, del sistema o externas.

**En DSH:** CEO = mensaje del usuario en la GUI + `ask_user_question` como
canal de veto (no es una excepción: un evento más que despierta al
orchestrator). Encargos = `send_message`/`followup` a un subagente
continuable dormido (la "bandeja" = estado persistido del puesto). Ritmos =
`dsh-schedule` (`schedule_create/list/delete`; al vencer, el agente se
despierta con un `followup()` cuando está idle) — fase 3. Eventos = eventos
del sistema (`session/event`, `agent/pre-step`, `agent/turn-stopping`…) +
MCP client para el mundo externo, mapeados eventos→activaciones por el
plugin — fase 3. El MVP solo lleva CEO y encargos manuales.

## Memoria en cuatro niveles

1. **SESIÓN** (corto plazo) — el contexto activo del turno.
2. **TESTIGO** (relevo entre sesiones) — lo que sobrevive al dormirse.
3. **SALA** (memoria del grupo) — el workspace del departamento.
4. **ORGANIZACIONAL** — el repo global, consultable desde todas las salas.

**En DSH:** SESIÓN = contexto activo + compactación + token-meter (efímera
por naturaleza). TESTIGO = `session.append` + proyecciones + convención
`_reports/`. SALA = workspace del grupo (directorio con su memoria) +
`_reports/<agente>/`. ORGANIZACIONAL = repo global, docs vivos (AGENTS.md,
docs/), skills, investigación, historial de sesiones (`ctx.sessions.get/
list`).

## Orchestrator y cadena de mando

El **orchestrator** es la mano derecha del CEO: descompone, planifica y
delega. La cadena es CEO → orchestrator → jefe de departamento →
trabajadores; los puestos intermedios también duermen y dejan testigo.

**En DSH:** el orchestrator es un **agent preset** (agent.cordis.yml +
preset.yml + skills/) que contribuye tools, persona y prompt sections.
Deepartments generaliza y productiza el patrón de preset como cadena de
mando.

## Gobernanza

Tres niveles: **operativo** (delegado al jefe de grupo), **diseño**
(dirección de producto) y **dirección** (decisiones de fondo). La política
admite excepciones; el sistema propone, el CEO aprueba o veta.

**En DSH:** no hay primitiva de "política de permisos": se modela en config
declarativa del plugin + persona del orchestrator + `ask_user_question` como
canal de veto. MVP: gobernanza **mínima** (operativo delegado, diseño/
dirección suben al CEO); política editable en fase 3.

## Auto-modificación y auto-observación

La organización puede **cambiarse a sí misma** (estructura e
implementación, con salvaguardas y estructura por defecto recuperable) y
**observarse** (funcionamiento, resultados, evolución).

**En DSH:** los builders editan presets, skills y el propio plugin
(`ctx.agentPresets` + ficheros del repo). Dogfooding: el primer departamento
(programación) construye el plugin que lo ejecuta. Señales crudas nativas:
`sessionProjections`, token-meter, job registry, `list_agents`, historial de
sesiones, eventos `goal/change`; la interpretación es agéntica (grupo de
calidad, fase 4).

## Calidad como principio

El sistema se evalúa a sí mismo: revisión independiente tras cada cambio y
**entrevista post-sesión** ("sueño") en la que el sistema se examina con los
datos de la sesión.

**En DSH:** el reviewer es el germen del grupo de calidad (fase 4). El
"sueño" = listener sobre `agent/turn-stopping` que despacha un agente de
calidad con los datos de la sesión — los hooks de ciclo de vida existen.

## El MVP en una frase

Un departamento (programación) con puestos que duermen y despiertan con
testigo, ciclo de vida gestionado por el plugin, haciendo dogfooding sobre el
propio repo Deepartments, headless. Detalles y criterios de éxito en
[concept.md](concept.md) y [ROADMAP.md](ROADMAP.md).
