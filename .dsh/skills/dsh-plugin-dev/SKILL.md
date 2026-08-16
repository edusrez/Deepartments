---
name: dsh-plugin-dev
description: Autoría de plugins para DeepSeek Harness (DSH) en el repo Deepartments — esqueleto de bundle, API Cordis, herramientas, sesiones y puestos, instalación/verificación y reglas no negociables (pitfalls 0001/0002). Úsalo al crear o modificar el plugin dsh-deepartments, tools dept_* o servicios del runtime.
---

# dsh-plugin-dev — autoría de plugins DSH

Reglas portadas de `_research/2026-08-16-dsh-plugin-api.md`. Runtime auditado:
`@deepseek-ai/dsh@0.1.0-rc.6` — developer preview, habrá breaking changes.

## Modelo mental

- DSH = "todo es un plugin" sobre Cordis (fork `@deepseek-ai/cordis@4.0.1`).
  Un plugin de terceros = paquete npm que aporta una **capa de configuración**
  (bundle).
- **Bundle** = package.json con `dsh.bundle.patch` + `cordis.patch.yml` +
  código (src → lib). **Profile** = `$DSH_HOME/profiles/<name>/` que ensambla
  bundles en orden. El repo Deepartments ES un bundle.
- Orden de capas (último gana por fila; el `config` de una fila se REEMPLAZA
  entero, no se mergea): bundles (`dsh.profile.bundles`) → `cordis.patch.yml`
  del profile → `$DSH_HOME/cordis.patch.yml` → `--patch`.

## Esqueleto mínimo de un bundle

```
dsh-deepartments/
├── package.json       # name/version/type/main/files + dsh.bundle
├── cordis.patch.yml   # la capa: top-level YAML array de entradas de patch
└── src/index.ts       # el plugin Cordis (compila a lib/)
```

```jsonc
// package.json
{
  "name": "dsh-deepartments",
  "version": "0.1.0-rc.1",
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib", "cordis.patch.yml", "assets"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.6"
  }
}
```

```yaml
# cordis.patch.yml — la fila referencia el paquete por NOMBRE
- insert:
    - id: deepartments
      name: dsh-deepartments
      config:
        stateDir: .deepartments
```

```ts
// src/index.ts — SIN export default (pitfall 0001)
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// import type {} from '@deepseek-ai/dsh-session'   // type-only: activa declaration merging

export const name = 'deepartments'
export const inject = ['tools', 'sessions']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'dept_puesto_create',
    description: 'Crea un puesto persistente (agente durmiente) en la organización.',
    parameters: { nombre: { type: 'string', required: true, description: 'Nombre del puesto' } },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
              render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args, exec) {
      // session.append('deepartments/puesto-created', {...}) — durable en el log
      // opcional: subagents.startContinuable(...) para el agente del puesto
      return { ok: true }
    },
  }))
  // ctx.on('session/event', (_s, e) => { ... })
  // ctx.effect(() => cleanup, 'deepartments: resources')
}
```

## API Cordis

- `apply(ctx, config)`; `ctx.on(event, handler)` (modos emit/bail/serial/
  waterfall); `ctx.effect(disposer)` para recursos explícitos; `ctx.get(name)`
  para servicios opcionales; `ctx.<service>` solo con `inject` declarado
  (si no: `UNDECLARED_ACCESS`).
- Servicios clave: `tools`, `sessions`, `sessionQuery`,
  `sessionReferenceResolver`, `sessionProjections`, `agents`, `subagents`,
  `goals`, `jobs`, `skills`, `agentPresets`, `systemPrompt`, `settings`,
  `credentials`, `compaction`, `sandbox`, `approval`, `llm`, `webServer`
  (antes `httpServer`), `cmdlineArgs`, `schedule`.
- Eventos: `session/event` (stream completo: `assistant/chunk`, `turn/end`…),
  `agent/session-start`, `agent/pre-step`, `agent/request`,
  `agent/turn-stopping`, `goal/change`, `agent-preset/selected`,
  `skills/change`, `hmr/*`.

## Herramientas (defineTool)

- `parameters` = **flat map** de campos (cada key un schema; solo
  `required: true`).
- `output` **OBLIGATORIO** con `{schema, render}` (JSON Schema + render a
  bloques).
- `execute(args, exec)` con `exec.agent` (el Agent llamador) y `exec.signal`
  (cancelación).
- Todo registro como **effect reversible**; nada de estado mutable global
  fuera de `apply`.

## Sesiones y puestos dormidos

- **Testigo/estado:** `session.append('deepartments/<evento>', data)` con
  `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap
  {...} }` — durable, auditable, reproducible.
- **Estado vivo:** `ctx.sessionProjections` — unidad pura `{key, schema, init,
  apply, view}` que se pliega sobre los eventos de la sesión; el framework la
  sirve como JSON consistente.
- **Lecturas cruzadas:** `ctx.sessionReferenceResolver` — snapshots read-only
  de OTRAS sesiones inyectados como contexto `@[label](dsh-session:<id>)`
  (maxReferences=3 por defecto).
- **Activaciones:** `dsh-schedule` — `schedule_create/list/delete`; el estado
  vive en el log de la sesión (`schedule/change`); al vencer, el agente se
  despierta con un `followup()` cuando está idle (one-shot `at`/
  `after_seconds`, recurrencia `every_seconds` ≥5min). Requiere montarse tras
  sessions/agents/tools/sessionPersistence; los runtime children no lo
  reciben.
- **Puestos:** `ctx.subagents.startContinuable(spec)` → `{childId, messageId}`
  (hijo durable, cold-resume desde su sesión persistida);
  `followup(parent, childId, content)`; `interrupt(...)`;
  `listChildren/listDescendants`.

## Client plugin (solo fase 3+; no en el MVP)

- Dos caras: host (`main`) + client (`exports["./client"]` → lib/client.js);
  manifest `dsh.client` `{inject, platform: "web"}`; compilar con **tsdown**
  (CJS closure-factory `window.__ModuleLoader__.load(...)`) y **DOS programas
  tsc separados** (host vs client) por conflicto de `declare module` en
  `Context`.
- Registrar Slots (`conversation.chat.node`, `sidebar.footer.action`, …);
  llamadas al host vía `host.call(method, args)` (JSON-RPC package-private).

## Instalación y verificación (nunca contra el profile web en uso)

```sh
pnpm build                                  # tsc host (y tsdown client si hay UI)
dsh plugin --profile deepartments-dev add /abs/path/dsh-deepartments
dsh --profile deepartments-dev --dump-config   # compone el árbol SIN bootear; debe mostrar "# == dsh-deepartments"
dsh --profile deepartments-dev "smoke real"     # boot headless + prueba
```

- Reinicio requerido tras `add` (manifest y metadata de client se cachean);
  los edits de `cordis.patch.yml` del usuario sí son HMR.

## Reglas no negociables

1. **Sin `export default`** (postmortem 0001 — rompe `inject`).
2. **`!!js` solo dentro de `config`**, nunca en campos de metadatos
   (postmortem 0002).
3. **`defineTool` con `output.{schema,render}` obligatorio**; `parameters`
   flat con `required: true`.
4. Todo registro como **effect reversible**; sin estado mutable global fuera
   de `apply`.
5. **Tests que pasen por el Loader real** (nunca solo mount manual).
6. Desarrollo y smoke en **profile/port independientes** (deepartments-dev).
7. Aislar servicios renombrables: `ctx.get('webServer') ?? ctx.get('httpServer')`.
8. `peerDependencies` en canal rc (`^0.1.0-rc.x`; un `^0.0.1` no matchea rc) y
   pin del CLI: `npx -p @deepseek-ai/dsh@0.1.0-rc.6`.

## Checklist de verificación (antes de reportar)

- [ ] `tsc` compila (programa host; y cliente si hay UI)
- [ ] `--dump-config` muestra la capa `# == dsh-deepartments`
- [ ] smoke headless real ejecuta el tool/servicio
- [ ] test que pasa por el Loader real
