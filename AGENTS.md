# AGENTS.md — contrato de trabajo del repo Deepartments

## Qué es este repo

El repo **es** el bundle `dsh-deepartments`: un paquete npm de plugin para
DeepSeek Harness (DSH) que aporta una capa de organización agéntica
(departamentos, puestos que duermen y despiertan, testigos, activaciones,
gobernanza). DSH responde al *cómo se ejecuta*; Deepartments al *cómo se
organiza*. Contexto: [docs/IDEA.md](docs/IDEA.md) (la idea),
[docs/concept.md](docs/concept.md) (decisiones y mapeo),
[docs/ROADMAP.md](docs/ROADMAP.md) (fases y kickoff).

## Estructura

- `package.json` — name `dsh-deepartments`, versión `0.1.0-rc.1`, `type:
  module`, `main: lib/index.js`, `dsh.bundle` (patch → `cordis.patch.yml`),
  `peerDependencies` en canal rc (`^0.1.0-rc.x`; un `^0.0.1` no matchea rc).
- `cordis.patch.yml` — la capa de configuración: top-level YAML array de
  entradas de patch; la fila referencia el paquete por nombre (`name:
  dsh-deepartments`).
- `src/` → `lib/` — el plugin Cordis; compila con **tsc NodeNext** a `lib/`.
- `docs/` — IDEA, concept, ROADMAP (memoria del proyecto).
- `.dsh/skills/` — skills de autoría interna (raíz de descubrimiento
  `<project>/.dsh/skills`, rango 100): `dsh-plugin-dev` para escribir el
  plugin.

## Verificación TIERED

1. `pnpm build` — tsc NodeNext compila (src → lib), sin errores de tipos.
2. `dsh plugin --profile deepartments-dev add /home/esuarez/projects/deepartments` — instala el bundle en el profile de desarrollo.
3. `dsh --profile deepartments-dev --dump-config` — compone el árbol SIN bootear; **debe mostrar la capa `# == dsh-deepartments`**.
4. Smoke headless real en el profile `deepartments-dev` (port independiente) que ejercita el tool/servicio tocado.

Desarrollo y smoke SIEMPRE en `deepartments-dev` — **nunca contra el profile
web en uso**. Reinicio requerido tras `add` (manifest y metadata de client se
cachean); los edits de `cordis.patch.yml` del usuario sí son HMR.

## Reglas no negociables

1. **Sin `export default`** (postmortem 0001 — rompe `inject`).
2. **`!!js` solo dentro de `config`**, nunca en campos de metadatos
   (postmortem 0002).
3. **`defineTool` con `output.{schema,render}` obligatorio**; `parameters`
   flat con `required: true`.
4. Todo registro como **effect reversible**; sin estado mutable global fuera
   de `apply`.
5. **Tests que pasen por el Loader real** (nunca solo mount manual).
6. Desarrollo y smoke en **profile/port independientes** (`deepartments-dev`).
7. Aislar servicios renombrables: `ctx.get('webServer') ?? ctx.get('httpServer')`.
8. `peerDependencies` en canal rc (`^0.1.0-rc.x`) y **pin del CLI**:
   `npx -p @deepseek-ai/dsh@0.1.0-rc.6`.

Detalle y motivos de cada regla: skill `dsh-plugin-dev`
(`.dsh/skills/dsh-plugin-dev/SKILL.md`).

## Ritual de sesión

- **START**: lee este AGENTS.md y `docs/ROADMAP.md`; comprueba git
  (`git status`, `git log --oneline -5`); presenta el plan de la sesión.
- **WORK**: carga el skill `dsh-plugin-dev`; tareas atómicas; verificación
  TIERED; revisión independiente tras cada cambio.
- **END**: verificación verde, commit con el estilo del repo (`git log
  --oneline -5` para verlo), estado actualizado en `docs/ROADMAP.md` si
  aplica.
