# Internal Programming Department role templates

Persona templates ("roles") of the Internal Programming Department, per
`docs/specs/005-internal-programming-department.md`. A role is a **person
template referenced by name** — this department's roles: `builder`, `reviewer`,
`explore-deep`, `organizer`. Roles are NOT agent presets: no
`preset.yml`/`agent.cordis.yml` pair here. They are repo-versioned templates the
plugin resolves by name at spawn time (`dept_worker_spawn`) and job-run time
(`dept_job_run`).

The department's **static design** (what it is, org chart, organic pipeline,
ACL, worker lifecycle, execution scope, knowledge system, report convention,
tools) lives in [ARCHITECTURE.md](ARCHITECTURE.md) — read it first.

## Layout

`presets/departments/<dept-id>/<role>.md` (this directory) — the convention
proposed by spec 005. Each role is a leaner persona+tool delta, not a new base
agent preset (the neutral head/worker bases live in
`presets/deepartments-head|worker/`).

## File format

- **Frontmatter** (`---` delimited): `id` (stable role id referenced by jobs and
  spawns), `title` (display), `tools` (the model-facing tool ids allowed — the
  `restrict` allow-list binding to this list is **implemented**, so the declared
  `tools` ARE the effective allowance for the role).
- **Body**: the persona text. English (AGENTS.md language policy).
- **Literals**: the model is a FIXED literal `deepseek-v4-flash-vision-exp`
  (provider `opencode-zen`, reasoning max) — never the model template variable;
  `{{cwd}}`, `{{deptName}}`, `{{headPostId}}`, `{{workspacePath}}`,
  `{{reportDir}}` are allowed and templated at runtime.

## Tool vocabulary (model-facing ids, as used by the harness surface)

- Web: `web_search`, `web_fetch`. Files: `read`, `write`, `edit`, `glob`,
  `grep`.
- Execution (restricted roots): `dept_exec` — the `builder`, `reviewer` and
  `explore-deep` roles. See ARCHITECTURE (execution scope) for the allowed roots
  and the read-only rule for `reviewer`/`explore-deep`.
- Bus / lifecycle (plugin own layer): `send_message`, `agent_messages`,
  `dept_who`, `dept_memo_write`, `dept_sleep`.
- NEVER for department workers: `subagent`/`subagent_fork`/`workflow`/`ralph`
  — a worker is a root agent, not a coordinator (D3, §3.4).
- Role-specific allowance, by design: `edit` is granted to `builder` (it
  implements) but NOT to `reviewer`/`explore-deep` (read-only) or `organizer`
  (planning/consolidation only); `dept_exec` is granted to `builder`/`reviewer`/
  `explore-deep` but NOT to `organizer`.

## Worker cycle (ephemeral vs job-worker)

- **EPHEMERAL (default)**: a one-off task worker. Completes the task, reports to
  its head, and the head retires it (`dept_worker_retire`). NO sleep, no
  permission request (worker → host is PROHIBITED by ACL).
- **JOB worker** (spawned by `dept_job_run`, carries a `jobId`): iterates across
  rounds — `dept_memo_write` → request sleep permission from its **head** (never
  the host) → wait → `dept_sleep`; switched off for good when the head retires
  it.

## Report conventions referenced by the personas

- Builder reports / reviewer verdicts / explore analyses / organizer plans:
  `{{reportDir}}/<role>/<YYYY-MM-DD>-<slug>.md` (reviewer verdicts
  `...-<slug>-review.md`) — the DEPARTMENT workspace `reports/` dir, NOT
  `.dsh/reports/...`. The Asistente's harness-subagent reports live in
  `.dsh/reports/<agent>/...`; department worker reports live in the workspace.
- Sources: `{{workspacePath}}/sources/<topic-slug>.md`.
- Organizer: indexes/normalizes the report dirs and maintains
  `{{reportDir}}/INDEX.md`.
