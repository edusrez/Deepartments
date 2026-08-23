# Internal Programming Department — repo layout (jobs + roles)

This directory is the repository-side home of the **Internal Programming
Department** (`docs/specs/005-internal-programming-department.md`). It holds the
department's versioned **job definitions**; the department's **roles** (person
templates) live in `presets/departments/internal-programming/` (see
`presets/departments/internal-programming/README.md`) and its **static design**
in `presets/departments/internal-programming/ARCHITECTURE.md`.

## Model

- A **job** is a versioned, reusable task definition: the name of a role
  template + a concrete task body (D3). The definition is saved in the repo so
  any agent of the department can execute it later.
- A **role** is a person template referenced by name (D4): persona text + tool
  allowance. This department's roles: `builder`, `reviewer`, `explore-deep`,
  `organizer` — used by jobs and by one-off ephemerals. The role's `tools`
  frontmatter IS the effective tool allowance (binding implemented).
- **Execution is the Internal Programming Head's business**: `dept_job_run <id>`
  reads a definition in `jobs/`, materializes a worker with the role's persona
  + the job body as its task, and returns the worker ids. `dept_job_list`
  lists the department's jobs from the same directory (`jobDir` in config).

## Tree

```
docs/departments/internal-programming/
├── README.md      ← this file (layout + job-definition convention)
└── jobs/          ← versioned job definitions, one file per job
    ├── weekly-repo-health.md
    └── version-watch.md
```

> The department's **runtime report archive** does NOT live in the repo. It is
> the department workspace's `reports/` directory (`<workspacePath>/reports/<role>/`,
> where `<workspacePath>` is `/root/.deepartments/departments/internal-programming`
> per config). The report index `reports/INDEX.md` is maintained by the
> organizer.

## Job file format (frontmatter)

One markdown file per job, `---`-delimited frontmatter with exactly these keys
(order as shown):

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | stable job id — kebab-case, equals the file name `<slug>.md`; used by `dept_job_run`/`dept_job_list` |
| `title` | yes | human-readable title |
| `role` | yes | the role template id referenced by name — MUST be one of `presets/departments/internal-programming/*.md` (today: `builder`, `reviewer`, `explore-deep`, `organizer`) |
| `description` | yes | one line: what the job does / what it is for |
| `schedule` | info | when the job **auto-fires** (W1 — real cron scheduler): a 5-field cron (e.g. `0 6 * * *`). A non-cron (human) schedule is displayed but never auto-fires — the head runs it manually. |
| `owner` | yes | who owns/runs the job: `internal-programming-head` |
| `outbox` | info | where the worker leaves its deliverable, relative to the department workspace (e.g. `reports/builder/<YYYY-MM-DD>-<slug>.md`) |

### Template

```markdown
---
id: <slug>
title: <human title>
role: builder | reviewer | explore-deep | organizer
description: <one line: what it does / what it is for>
schedule: "<when it auto-fires: a 5-field cron, e.g. `0 6 * * *` (auto-runs via the plugin scheduler daemon); OR plain human text (displayed, never auto-fires — manual run via dept_job_run)>"
owner: internal-programming-head
outbox: <where the deliverable lands, e.g. reports/builder/<YYYY-MM-DD>-<slug>.md>
---

# <Title>

<The concrete TASK: what the worker must do, how, and what to deliver.>
```

## How to add a job

1. Copy the template to `jobs/<slug>.md` (slug = kebab-case, = `id`).
2. Frontmatter: `role` MUST match a role id in
   `presets/departments/internal-programming/`; `owner` is
   `internal-programming-head` (only the head runs jobs).
3. Write the body as the self-contained task: what to check/do, exact inputs
   (files, URLs, endpoints), the deliverable (`outbox`), and how to reply to the
   head. The body is the assignment message the worker receives, so it goes
   together with the role persona (general protocol: BOOT-QUIET, messaging ACL,
   execution scope, ephemeral vs job-worker cycle are in the persona, not here).
4. English only (AGENTS.md language policy); quote the `schedule` value.
5. Commit the new file — the definition is versioned; a job with broken
   frontmatter fails loudly at `dept_job_run`.

## Relations

- Roles & personas: `presets/departments/internal-programming/README.md`, its
  `ARCHITECTURE.md` and
  `presets/departments/internal-programming/{builder,reviewer,explore-deep,organizer}.md`.
- Department definition (config, sidebar workspace): spec 005.
- Spec: `docs/specs/005-internal-programming-department.md`.
