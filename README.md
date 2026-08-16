# Deepartments

Deepartments es una **capa de organización agéntica para DeepSeek Harness (DSH)** —
departamentos, puestos que duermen y despiertan, testigos, activaciones y
gobernanza — construida como **plugin npm (bundle)** del runtime. La idea del
workspace legado se materializa aquí como software: DSH responde a *cómo se
ejecuta* (sesiones, subagentes, schedule, skills, jobs, tools); Deepartments
responde a *cómo se organiza* (qué es un puesto, un departamento, una sala, un
testigo, una activación, una política de gobernanza).

## Estado

- **Fase 2 (MVP) en desarrollo** — ver [docs/ROADMAP.md](docs/ROADMAP.md).
- **Versión:** `0.1.0-rc.1` (paquete `dsh-deepartments`).
- **Licencia:** MIT.
- **Documentación:** [docs/IDEA.md](docs/IDEA.md) (la idea) ·
  [docs/concept.md](docs/concept.md) (decisiones y mapeo) ·
  [docs/ROADMAP.md](docs/ROADMAP.md) (fases y kickoff).

## Quick-start

```sh
dsh plugin --profile <x> add dsh-deepartments
```

Instala el bundle en el profile `<x>` y aporta su capa de configuración y
servicios al runtime. En desarrollo se usa el profile aislado
`deepartments-dev` (ver [AGENTS.md](AGENTS.md) — verificación TIERED).

## Documentación

- **`docs/IDEA.md`** — la idea reenmarcada: la organización agéntica como capa
  sobre DSH, con cada concepto y su mecanismo nativo.
- **`docs/concept.md`** — la memoria de las decisiones (2026-08-16) y del
  mapeo IDEA→DSH resuelto, el MVP y los riesgos.
- **`docs/ROADMAP.md`** — las fases 0-4 con criterios de salida y las tareas
  del kickoff de fase 2.

## Contrato de trabajo

Para construir el plugin: lee [AGENTS.md](AGENTS.md) y carga el skill
`dsh-plugin-dev` (`.dsh/skills/dsh-plugin-dev/SKILL.md`).
