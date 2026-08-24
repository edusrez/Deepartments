# Quality Department — repo layout (jobs + roles)

This directory is the repository-side home of the **Quality Department**
(`docs/specs/007-quality-department.md`). It holds the department's versioned
**job definitions**; the department's **roles** (person templates) live in
`presets/departments/quality/` (see `presets/departments/quality/README.md`) and
its **static design** in `presets/departments/quality/ARCHITECTURE.md`.

## Model

- A **job** is a versioned, reusable task definition: the name of a role template
  + a concrete task body (D3). The definition is saved in the repo so any agent
  of the department can execute it later.
- A **role** is a person template referenced by name (D4): persona text + tool
  allowance. This department's ONE role: `quality-inspector` — used by jobs and
  by one-off ephemerals. The role's `tools` frontmatter IS the effective tool
  allowance (binding implemented).
- **Execution is the Quality Head's business**: `dept_job_run <id>` reads a
  definition in `jobs/`, materializes a worker with the role's persona + the job
  body as its task, and returns the worker ids. `dept_job_list` lists the
  department's jobs from the same directory (`jobDir` in config).

## Tree

```
docs/departments/quality/
├── README.md      ← this file (layout + job-definition convention)
└── jobs/          ← versioned job definitions, one file per job
    └── quality-daily.md
```

> The Quality Department's **runtime report archive** lives under the
> stateDir/repo `.dsh/reports/quality/` directory (D-Q6) — NOT the department
> workspace's `reports/` dir and NOT the repo's `.dsh/reports/<agent>/` dirs. This
> is a deliberate divergence from the RD/IPD (their reports live in the department
> workspace `reports/`).

## Job file format (frontmatter)

One markdown file per job, `---`-delimited frontmatter with exactly these keys
(order as shown):

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | stable job id — kebab-case, equals the file name `<slug>.md`; used by `dept_job_run`/`dept_job_list` |
| `title` | yes | human-readable title |
| `role` | yes | the role template id referenced by name — MUST be one of `presets/departments/quality/*.md` (today: `quality-inspector`) |
| `description` | yes | one line: what the job does / what it is for |
| `schedule` | info | when the job **auto-fires** (W1 — real cron scheduler): a 5-field cron (e.g. `0 8 * * *`). A non-cron (human) schedule is displayed but never auto-fires — the head runs it manually. |
| `owner` | yes | who owns/runs the job: `quality-head` |
| `outbox` | info | where the worker leaves its deliverable (D-Q6 — e.g. `.dsh/reports/quality/<YYYY-MM-DD>-<slug>.md`) |

### Template

```markdown
---
id: <slug>
title: <human title>
role: quality-inspector
description: <one line: what it does / what it is for>
schedule: "<when it auto-fires: a 5-field cron, e.g. `0 8 * * *` (auto-runs via the plugin scheduler daemon); OR plain human text (displayed, never auto-fires — manual run via dept_job_run)>"
owner: quality-head
outbox: <where the deliverable lands, e.g. .dsh/reports/quality/<YYYY-MM-DD>-<slug>.md>
---

# <Title>

<The concrete TASK: what the worker must do, how, and what to deliver.>
```

## How to add a job

1. Copy the template to `jobs/<slug>.md` (slug = kebab-case, = `id`).
2. Frontmatter: `role` MUST match a role id in `presets/departments/quality/`;
   `owner` is `quality-head` (only the head runs jobs).
3. Write the body as the self-contained task: what to check/do, exact inputs
   (files, URLs, endpoints), the deliverable (`outbox`), and how to reply to the
   head. The body is the assignment message the worker receives, so it goes
   together with the role persona (general protocol: BOOT-QUIET, messaging ACL,
   execution scope, ephemeral vs job-worker cycle are in the persona, not here).
4. English only (AGENTS.md language policy); quote the `schedule` value.
5. Commit the new file — the definition is versioned; a job with broken
   frontmatter fails loudly at `dept_job_run`.

## Relations

- Roles & personas: `presets/departments/quality/README.md`, its
  `ARCHITECTURE.md` and `presets/departments/quality/quality-inspector.md`.
- Department definition (config, sidebar workspace): spec 007.
- Spec: `docs/specs/007-quality-department.md`.
