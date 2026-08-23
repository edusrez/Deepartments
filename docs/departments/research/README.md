# Research Department — repo layout (jobs + roles)

This directory is the repository-side home of the **Research Department**
(`docs/specs/004-research-department.md`, §0-D3/D7, §3.1–§3.3, §5.4–§5.5). It
holds the department's versioned **job definitions**; the department's
**roles** (person templates) live in `presets/departments/research/` (see
`presets/departments/research/README.md`) and its **static design** in
`presets/departments/research/ARCHITECTURE.md`.

## Model

- A **job** is a versioned, reusable task definition: the name of a role
  template + a concrete task body (D3). The definition is saved in the repo so
  any agent of the department can execute it later.
- A **role** is a person template referenced by name (D4): persona text + tool
  allowance. This department's roles: `researcher`, `analyst`, `reviewer`,
  `organizer` — used by jobs and by one-off ephemerals. The role's `tools`
  frontmatter IS the effective tool allowance (binding implemented).
- **Execution is the Research Head's business** (§5.4): `dept_job_run <id>`
  reads a definition in `jobs/`, materializes a worker with the role's persona
  + the job body as its task, and returns the worker ids. `dept_job_list`
  lists the department's jobs from the same directory (`jobDir` in config,
  §3.1).

## Tree

```
docs/departments/research/
├── README.md      ← this file (layout + job-definition convention)
├── SOURCES.md     ← the sources/ convention (curation, index, no-duplication, TTL)
└── jobs/          ← versioned job definitions, one file per job
    ├── monitor-dsh-updates.md
    ├── weekly-report-organize.md
    └── fact-check-queue.md
```

> The department's **runtime report archive** does NOT live in the repo. It is
> the department workspace's `reports/` directory (`<workspacePath>/reports/<role>/`,
> where `<workspacePath>` is `/root/.deepartments/departments/research` per
> config). The report index `reports/INDEX.md` is maintained by the organizer.

## Job file format (frontmatter)

One markdown file per job, `---`-delimited frontmatter with exactly these
keys (order as shown):

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | stable job id — kebab-case, equals the file name `<slug>.md`; used by `dept_job_run`/`dept_job_list` |
| `title` | yes | human-readable title |
| `role` | yes | the role template id referenced by name — MUST be one of `presets/departments/research/*.md` (today: `researcher`, `analyst`, `reviewer`, `organizer`) |
| `description` | yes | one line: what the job does / what it is for |
| `schedule` | info | when the job **auto-fires** (W1 — real cron scheduler): a 5-field cron (e.g. `0 9 * * *`). A non-cron (human) schedule is displayed but never auto-fires — the head runs it manually. See Status below |
| `owner` | yes | who owns/runs the job: `research-head` |
| `outbox` | info | where the worker leaves its deliverable, relative to the department workspace (e.g. `reports/researcher/<YYYY-MM-DD>-<slug>.md`) |

### Template

```markdown
---
id: <slug>
title: <human title>
role: researcher | analyst | reviewer | organizer
description: <one line: what it does / what it is for>
schedule: "<when it auto-fires: a 5-field cron, e.g. `0 9 * * *` (auto-runs via the plugin scheduler daemon); OR plain human text (displayed, never auto-fires — manual run via dept_job_run)>"
owner: research-head
outbox: <where the deliverable lands, e.g. reports/researcher/<YYYY-MM-DD>-<slug>.md>
---

# <Title>

<The concrete TASK: what the worker must do, how, and what to deliver.>
```

## How to add a job

1. Copy the template to `jobs/<slug>.md` (slug = kebab-case, = `id`).
2. Frontmatter: `role` MUST match a role id in
   `presets/departments/research/`; `owner` is `research-head` (only the head
   runs jobs).
3. Write the body as the self-contained task: what to check/do, exact inputs
   (files, URLs, endpoints), the deliverable (`outbox`), and how to reply to
   the head. The body is the assignment message the worker receives, so it goes
   together with the role persona (general protocol: BOOT-QUIET, messaging ACL,
   ephemeral vs job-worker cycle are in the persona, not here).
4. English only (AGENTS.md language policy); quote the `schedule` value.
5. Commit the new file — the definition is versioned; a job with broken
   frontmatter fails loudly at `dept_job_run`.

## Status: `schedule` auto-fires (W1 — cron scheduler + calendar runtime)

Implemented **2026-08-23 (W1)**: automatic triggering is REAL. A job whose
`schedule` is a **5-field cron** (e.g. `0 9 * * *`) is fired automatically by
the plugin's scheduler daemon — through the same `dept_job_run` engine. A
**non-cron (human)** `schedule` text is displayed but never auto-fires: the
Research Head runs that job manually with `dept_job_run` (e.g. on the
owner's/Asistente's request, or on the cadence the head decides).

The department also has a **calendar/agenda runtime**: `dept_calendar_add`,
`dept_calendar_list` and `dept_calendar_remove` manage ad-hoc one-shot entries
(stored in `<stateDir>/calendar.json`; an entry with a `jobId` runs that job
when it passes), and the client `agenda/list` endpoint surfaces the jobs'
next-cron-fire plus the calendar entries as the department's agenda.

## Relations

- Roles & personas: `presets/departments/research/README.md`, its
  `ARCHITECTURE.md` and `presets/departments/research/{researcher,analyst,reviewer,organizer}.md`.
- Source convention: `docs/departments/research/SOURCES.md`.
- Job execution machinery (code): spec 004 §5.4 (`dept_job_run`), §5.5
  (`dept_job_list`) — F4b.
- Department definition (config, sidebar workspace): spec 004 §3.1, §6.
- Spec: `docs/specs/004-research-department.md`.
