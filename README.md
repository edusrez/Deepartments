# Deepartments

Deepartments is an **agentic organization layer for DeepSeek Harness (DSH)** —
departments, posts that sleep and wake, witnesses, activations and
governance — built as an **npm plugin (bundle)** of the runtime. The idea of
the legacy workspace is materialized here as software: DSH answers *how things
run* (sessions, subagents, schedule, skills, jobs, tools); Deepartments
answers *how things are organized* (what a post, a department, a room, a
witness, an activation, a governance policy is).

## Status

- **Phase 2 (MVP) in development** — see [docs/ROADMAP.md](docs/ROADMAP.md).
- **Version:** `0.1.0-rc.1` (package `dsh-deepartments`).
- **License:** MIT.
- **Documentation:** [docs/IDEA.md](docs/IDEA.md) (the idea) ·
  [docs/concept.md](docs/concept.md) (decisions and mapping) ·
  [docs/ROADMAP.md](docs/ROADMAP.md) (phases and kickoff).

## Quick-start

```sh
dsh plugin --profile <x> add dsh-deepartments
```

Installs the bundle into profile `<x>` and contributes its configuration layer
and services to the runtime. Development uses the isolated profile
`deepartments-dev` (see [AGENTS.md](AGENTS.md) — TIERED verification).

## Documentation

- **`docs/IDEA.md`** — the reframed idea: the agentic organization as a layer
  over DSH, with each concept and its native mechanism.
- **`docs/concept.md`** — the record of the decisions (2026-08-16) and of the
  resolved IDEA→DSH mapping, the MVP and the risks.
- **`docs/ROADMAP.md`** — phases 0-4 with exit criteria and the phase 2
  kickoff tasks.

## Working agreement

To build the plugin: read [AGENTS.md](AGENTS.md) and load the skill
`dsh-plugin-dev` (`.dsh/skills/dsh-plugin-dev/SKILL.md`).
