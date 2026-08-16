# ROADMAP — fases de Deepartments

Hoja de ruta del proyecto Deepartments (`dsh-deepartments`): fases con su
estado, contenido y criterio de salida, y las tareas del kickoff de fase 2.
Decisiones y mapeo en [concept.md](concept.md); la idea en [IDEA.md](IDEA.md).

## Fases

| Fase | Estado | Contenido | Criterio de salida |
|---|---|---|---|
| **0. Investigación** | ✅ **COMPLETA** (2026-08-16) | Research de la API de plugins de DSH: celdas del mapeo resueltas; viabilidad confirmada (rc.6, mecanismos nativos para puestos/activaciones/testigo); decisiones 1-2. | Reporte entregado; veredicto de viabilidad: **positivo**; mapeo sin pendientes que bloqueen el MVP. |
| **1. Concepto** | ✅ **COMPLETA** (2026-08-16) | Borrador v1 + debate; 10 preguntas del v1 → 9 decisiones vinculantes + propuesta de naming; el concepto (docs/concept.md). | Decisiones tomadas; concepto aprobado; fase 2 autorizada. |
| **2. MVP** | 🚀 **LISTA PARA ARRANCAR** | Un departamento (programación) con roles absorbidos del setup anterior; puestos persistentes (continuable + testigo); flujo CEO → orchestrator → jefe → builders en paralelo → reviewer → verificación → commit; ciclo dormir/despertar gestionado por el plugin; dogfooding sobre el propio repo; headless. | Criterios de éxito del MVP (concept.md §4): encargo end-to-end con un puesto que se duerme a mitad y retoma sin pérdida; ciclo gestionado sin pegamento manual. |
| **3. Salas y activaciones** | Pendiente | Salas múltiples con recepción y visitas; activaciones programáticas (`dsh-schedule`) y reactivas (eventos/MCP); encargos entre puestos; política de gobernanza editable; **client plugin UI — observador total** (decisión 2); archivo/consulta de salas muertas. | Dos departamentos coordinándose vía jefe → orchestrator; un ritmo programático corriendo sin intervención humana; una sala muerta archivada y consultable; una excepción de gobernanza aplicada; la UI muestra el estado de la organización. |
| **4. Auto-observación, calidad, auto-modificación** | Pendiente | Grupo de calidad + sueño/entrevista post-sesión; contextualizador proactivo; emergencia canalizada operativa; auto-modificación de estructura e implementación con salvaguardas y recuperación (estructura por defecto). | La organización propone un cambio de estructura o implementación, el CEO lo aprueba, se aplica con gates de calidad, y el camino de vuelta (estructura por defecto) funciona. |

## Kickoff de fase 2

Tareas concretas para arrancar el desarrollo, en orden, cada una con su
criterio de "hecho". (El skill `dsh-plugin-dev` se crea primero — Recommendation
1 del research — para que ningún builder necesite re-investigar.)

| # | Tarea | Criterio de "hecho" |
|---|---|---|
| 1 | **Sembrar el repo** (docs + skill primero): `README.md`, `docs/IDEA.md`, `docs/concept.md`, `docs/ROADMAP.md`, `AGENTS.md` y `.dsh/skills/dsh-plugin-dev/SKILL.md` (texto literal del anexo del concepto) + commit inicial. | `git status` limpio en `/home/esuarez/projects/deepartments`; una sesión de builder en el repo carga el skill `dsh-plugin-dev` desde el catálogo (raíz `<project>/.dsh/skills`, rango 100). |
| 2 | **Profile de desarrollo**: crear `deepartments-dev` (template headless, port independiente) para desarrollo y smoke sin tocar el profile web. | `dsh --profile deepartments-dev --dump-config` compone sin errores; el boot headless arranca en su puerto propio. |
| 3 | **Scaffold del bundle**: `package.json` (name `dsh-deepartments`, 0.1.0-rc.1, `dsh.bundle`, peerDeps rc), `cordis.patch.yml` (fila `deepartments`), `src/index.ts` mínimo (`name`/`inject`/`apply` con un effect de log), tsconfig NodeNext, build a `lib/`. | `dsh plugin --profile deepartments-dev add /home/esuarez/projects/deepartments` instala y `dsh --profile deepartments-dev --dump-config` muestra la capa `# == dsh-deepartments`. |
| 4 | **Primer tool `dept_*`**: `dept_puesto_create` (crea un puesto: `session.append('deepartments/puesto-created', …)` + `startContinuable` opcional) y, si aplica, `dept_testigo_write`. | Un smoke headless crea un puesto y el evento `deepartments/*` aparece en el log de la sesión (verificable por lista de sesiones o proyección). |
| 5 | **Esqueleto de testigo**: convención frontmatter+cuerpo + proyección del estado del puesto (`sessionProjections`) + listener `agent/turn-stopping` que escribe el testigo al dormirse. | Un puesto escribe testigo, se duerme (evento `deepartments/puesto-sleep` con testigo) y **despierta en una sesión nueva con el testigo cargado sin pérdida** — criterio de éxito 1 del MVP. |
| 6 | **Flujo end-to-end dogfooded**: el departamento de programación se ejecuta sobre el repo: CEO → orchestrator → jefe → N builders en paralelo → reviewer → verificación → commit, con un encargo real de construcción del plugin. | Encargo completo con un puesto dormido a mitad de camino sin pérdida y **sin pegamento manual del orchestrator** — criterio de éxito 2 del MVP. |

## Estado actual

- **2026-08-16** — fases 0 y 1 completas; fase 2 lista para arrancar; tarea 1
  (sembrar el repo) en curso.
