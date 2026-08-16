---
name: dsh-plugin-dev
description: Authorship of plugins for DeepSeek Harness (DSH) in the Deepartments repo — bundle skeleton, Cordis API, tools, sessions and posts, installation/verification and non-negotiable rules (pitfalls 0001/0002). Use it when creating or modifying the dsh-deepartments plugin, dept_* tools or runtime services.
---

# dsh-plugin-dev — DSH plugin authorship

Rules carried over from `_research/2026-08-16-dsh-plugin-api.md`. Audited
runtime: `@deepseek-ai/dsh@0.1.0-rc.6` — developer preview, breaking changes
expected.

## Mental model

- DSH = "everything is a plugin" on Cordis (fork `@deepseek-ai/cordis@4.0.1`).
  A third-party plugin = npm package that contributes a **configuration
  layer** (bundle).
- **Bundle** = package.json with `dsh.bundle.patch` + `cordis.patch.yml` +
  code (src → lib). **Profile** = `$DSH_HOME/profiles/<name>/` that assembles
  bundles in order. The Deepartments repo IS a bundle.
- Layer order (last wins per row; a row's `config` is REPLACED entirely, not
  merged): bundles (`dsh.profile.bundles`) → profile `cordis.patch.yml` →
  `$DSH_HOME/cordis.patch.yml` → `--patch`.

## Minimal bundle skeleton

```
dsh-deepartments/
├── package.json       # name/version/type/main/files + dsh.bundle
├── cordis.patch.yml   # the layer: top-level YAML array of patch entries
└── src/index.ts       # the Cordis plugin (compiles to lib/)
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
# cordis.patch.yml — the row references the package by NAME
- insert:
    - id: deepartments
      name: dsh-deepartments
      config:
        stateDir: .deepartments
```

```ts
// src/index.ts — NO export default (pitfall 0001)
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// import type {} from '@deepseek-ai/dsh-session'   // type-only: enables declaration merging

export const name = 'deepartments'
export const inject = ['tools', 'sessions']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'dept_post_create',
    description: 'Creates a persistent post (sleeping agent) in the organization.',
    parameters: { name: { type: 'string', required: true, description: 'Post name' } },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
              render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args, exec) {
      // session.append('deepartments/post-created', {...}) — durable in the log
      // optional: subagents.startContinuable(...) for the post's agent
      return { ok: true }
    },
  }))
  // ctx.on('session/event', (_s, e) => { ... })
  // ctx.effect(() => cleanup, 'deepartments: resources')
}
```

## Cordis API

- `apply(ctx, config)`; `ctx.on(event, handler)` (modes emit/bail/serial/
  waterfall); `ctx.effect(disposer)` for explicit resources; `ctx.get(name)`
  for optional services; `ctx.<service>` only with `inject` declared
  (otherwise: `UNDECLARED_ACCESS`).
- Key services: `tools`, `sessions`, `sessionQuery`,
  `sessionReferenceResolver`, `sessionProjections`, `agents`, `subagents`,
  `goals`, `jobs`, `skills`, `agentPresets`, `systemPrompt`, `settings`,
  `credentials`, `compaction`, `sandbox`, `approval`, `llm`, `webServer`
  (formerly `httpServer`), `cmdlineArgs`, `schedule`.
- Events: `session/event` (full stream: `assistant/chunk`, `turn/end`…),
  `agent/session-start`, `agent/pre-step`, `agent/request`,
  `agent/turn-stopping`, `goal/change`, `agent-preset/selected`,
  `skills/change`, `hmr/*`.

## Tools (defineTool)

- `parameters` = **flat map** of fields (each key a schema; only
  `required: true`).
- `output` **MANDATORY** with `{schema, render}` (JSON Schema + render to
  blocks).
- `execute(args, exec)` with `exec.agent` (the calling Agent) and
  `exec.signal` (cancellation).
- Every registration as a **reversible effect**; no global mutable state
  outside `apply`.

## Sessions and sleeping posts

- **Witness/state:** `session.append('deepartments/<event>', data)` with
  `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap
  {...} }` — durable, auditable, reproducible.
- **Live state:** `ctx.sessionProjections` — pure unit `{key, schema, init,
  apply, view}` that folds over the session's events; the framework serves it
  as consistent JSON.
- **Cross-reads:** `ctx.sessionReferenceResolver` — read-only snapshots of
  OTHER sessions injected as context `@[label](dsh-session:<id>)`
  (maxReferences=3 by default).
- **Activations:** `dsh-schedule` — `schedule_create/list/delete`; state
  lives in the session log (`schedule/change`); on expiry, the agent wakes
  with a `followup()` when idle (one-shot `at`/
  `after_seconds`, recurrence `every_seconds` ≥5min). Requires mounting after
  sessions/agents/tools/sessionPersistence; runtime children do not
  receive it.
- **Posts:** `ctx.subagents.startContinuable(spec)` → `{childId, messageId}`
  (durable child, cold-resume from its persisted session);
  `followup(parent, childId, content)`; `interrupt(...)`;
  `listChildren/listDescendants`.

## Client plugin (phase 3+ only; not in the MVP)

- Two faces: host (`main`) + client (`exports["./client"]` → lib/client.js);
  manifest `dsh.client` `{inject, platform: "web"}`; compile with **tsdown**
  (CJS closure-factory `window.__ModuleLoader__.load(...)`) and **TWO
  separate tsc programs** (host vs client) due to the `declare module`
  conflict in `Context`.
- Register Slots (`conversation.chat.node`, `sidebar.footer.action`, …);
  host calls via `host.call(method, args)` (JSON-RPC package-private).

## Installation and verification (never against the web profile in use)

```sh
pnpm build                                  # tsc host (and tsdown client if there's UI)
dsh plugin --profile deepartments-dev add /abs/path/dsh-deepartments
dsh --profile deepartments-dev --dump-config   # composes the tree WITHOUT booting; must show "# == dsh-deepartments"
dsh --profile deepartments-dev "real smoke"     # headless boot + test
```

- Restart required after `add` (manifest and client metadata are cached);
  user edits to `cordis.patch.yml` are HMR.

## Non-negotiable rules

1. **No `export default`** (postmortem 0001 — breaks `inject`).
2. **`!!js` only inside `config`**, never in metadata fields
   (postmortem 0002).
3. **`defineTool` with `output.{schema,render}` mandatory**; `parameters`
   flat with `required: true`.
4. Every registration as a **reversible effect**; no global mutable state
   outside `apply`.
5. **Tests that go through the real Loader** (never only manual mount).
6. Development and smoke in **independent profiles/ports** (deepartments-dev).
7. Isolate renamable services: `ctx.get('webServer') ?? ctx.get('httpServer')`.
8. `peerDependencies` on the rc channel (`^0.1.0-rc.x`; a `^0.0.1` does not
   match rc) and CLI pin: `npx -p @deepseek-ai/dsh@0.1.0-rc.6`.

## Verification checklist (before reporting)

- [ ] `tsc` compiles (host program; and client if there's UI)
- [ ] `--dump-config` shows the `# == dsh-deepartments` layer
- [ ] real headless smoke runs the tool/service
- [ ] test that goes through the real Loader
