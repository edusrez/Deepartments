# Research Department — repo layout (jobs + roles)

This directory is the repository-side home of the **Research Department**
(`docs/specs/004-research-department.md`, §0-D3/D7, §3.1–§3.3, §5.4–§5.5). It
holds the department's versioned **job definitions**; the department's
**roles** (person templates) live in `presets/departments/research/` (see
`presets/departments/research/README.md`).

## Model

- A **job** is a versioned, reusable task definition: the name of a role
  template + a concrete task body (D3). The definition is saved in the repo so
  any agent of the department can execute it later.
- A **role** is a person template referenced by name (D4): persona text + tool
  allowance. Today: `researcher`, `reviewer`, `organizer` — used by jobs and
  by one-off ephemerals.
- **Execution is the Research Head's business** (§5.4): `dept_job_run <id>`
  reads a definition in `jobs/`, materializes a worker with the role's persona
  + the job body as its task, and returns the worker ids. `dept_job_list`
  lists the department's jobs from the same directory (`jobDir` in config,
  §3.1).

## Tree

```
docs/departments/research/
├── README.md      ← this file (layout + job-definition convention)
├── INDEX.md       ← report index — maintained by the weekly-report-organize
│                     job (created on its first run; not edited by hand)
└── jobs/          ← versioned job definitions, one file per job
    ├── monitor-dsh-updates.md
    ├── weekly-report-organize.md
    └── fact-check-queue.md
```

## Job file format (frontmatter)

One markdown file per job, `---`-delimited frontmatter with exactly these
keys (order as shown):

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | stable job id — kebab-case, equals the file name `<slug>.md`; used by `dept_job_run`/`dept_job_list` |
| `title` | yes | human-readable title |
| `role` | yes | the role template id referenced by name — MUST be one of `presets/departments/research/*.md` (today: `researcher`, `reviewer`, `organizer`) |
| `description` | yes | one line: what the job does / what it is for |
| `schedule` | info | intended cadence — **informational only**, see Status below |
| `owner` | yes | who owns/runs the job: `research-head` |
| `outbox` | info | where the worker leaves its deliverable (report path) |

### Template

```markdown
---
id: <slug>
title: <human title>
role: researcher | reviewer | organizer
description: <one line: what it does / what it is for>
schedule: "<informative text, e.g. daily 09:00 (reserved — calendar not yet implemented; manual run via dept_job_run)>"
owner: research-head
outbox: <where the deliverable lands, e.g. .dsh/reports/researcher/<YYYY-MM-DD>-<slug>.md>
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
   the head. The body is the assignment message the worker receives, so it
   goes together with the role persona (general protocol: BOOT-QUIET,
   messaging ACL, memo + sleep are in the persona, not here).
4. English only (AGENTS.md language policy); quote the `schedule` value.
5. Commit the new file — the definition is versioned; a job with broken
   frontmatter fails loudly at `dept_job_run`.

## Status: `schedule` is informational (reserved)

Per owner decision **D7**, automatic triggering (calendar/scheduler/cron) is
**NOT implemented in this phase**: the `schedule` field is parsed and
displayed (§5.5) but never triggers anything. The Research Head executes jobs
manually with `dept_job_run` — e.g. on the owner's/Asistente's request, or on
the cadence the head decides.

## Relations

- Roles & personas: `presets/departments/research/README.md` and
  `presets/departments/research/{researcher,reviewer,organizer}.md` (F6).
- Job execution machinery (code): spec 004 §5.4 (`dept_job_run`), §5.5
  (`dept_job_list`) — F4b.
- Department definition (config, sidebar workspace): spec 004 §3.1, §6.
- Spec: `docs/specs/004-research-department.md`.
