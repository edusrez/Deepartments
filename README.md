# Deepartments

English | [中文](README.zh.md)

Deepartments is an **agentic organization layer for DeepSeek Harness (DSH)** —
departments, posts that sleep and wake, witnesses, activations and
governance — built as an **npm plugin (bundle)** of the runtime. The idea of
the legacy workspace is materialized here as software: DSH answers *how things
run* (sessions, subagents, schedule, skills, jobs, tools); Deepartments
answers *how things are organized* (what a post, a department, a message, a
witness, an activation, a governance policy is).

## Features

- **Departments & roles** — a configurable organization of department heads
  and role workers (builder / reviewer / explore-deep…), surfaced by
  `dept_who` and managed with worker spawn / retire.
- **Jobs & shared agenda** — versioned department jobs (`dept_job_run` /
  `dept_job_list`) and a single runtime `calendar.json` agenda
  (`dept_calendar_add` / `list` / `remove`), driven by a scheduler daemon.
- **Monitors** — a monitor module that polls external signals and on a
  trigger spawns a fresh worker and notifies the department head.
- **System-health** — a health daemon that writes a heartbeat, raises silent
  incidents as bus alerts to the host, plus a daily system-health digest job.
- **The bus (messaging)** — agent-to-agent messaging with a per-department ACL
  (`send_message` / `agent_messages`) backed by a durable message store.
- **Sleep / wake session lifecycle** — posts that nap and resume without loss,
  with a durable per-agent journal (`dept_memo_write`) and session rotation.
- **Client plugin UI** — the sidebar department catalog, the shared Agenda
  panel, and the owner presence toggle.

## Status

- **Phase 2 (MVP) in development** — see [docs/ROADMAP.md](docs/ROADMAP.md).
- **Version:** `0.1.0` (package `dsh-deepartments`, first stable release).
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

## Development

```sh
pnpm build         # the GATE (`node scripts/check-root-build.mjs`) — (1) per-file freshness vs each target's tsconfig src→lib map (a MISSING output is red even when its siblings look fresh); (2) repair the stale packages, ALWAYS `dshd-orchestration` (`ALWAYS_REBUILD`, fb-266); (3) root build with `build:tsc`; (4) RE-MEASURE — PASS is earned by that post-state measurement, never assumed
pnpm build:check   # DETECT ONLY — never writes: exit 1 with every stale/missing row plus its fix command, exit 0 when fresh
pnpm build:client  # dshd-gui owns the client build — `pnpm --filter dshd-gui run build:client && node scripts/mirror-client.mjs` — bundle the client plugin in the package, then mirror it byte-identical to ./client (the bundle's R6 mirror)
pnpm test          # `node --test` — run the unit tests
```

Verification is TIERED — see [AGENTS.md](AGENTS.md) for the level instructions.

## Working agreement

To build the plugin: read [AGENTS.md](AGENTS.md) and load the skill
`dsh-plugin-dev` (`.dsh/skills/dsh-plugin-dev/SKILL.md`).
