# Research Department role templates (spec 004 — F6/F10)

Persona templates ("roles") of the Research Department, per
`docs/specs/004-research-department.md` §3.2. A role is a **person template
referenced by name** — this department's roles: `researcher`, `analyst`,
`reviewer`, `organizer` (§7.1). Roles are NOT agent presets: no
`preset.yml`/`agent.cordis.yml` pair here. They are repo-versioned templates the
plugin resolves by name at spawn time (`dept_worker_spawn`) and job-run time
(`dept_job_run`).

The department's **static design** (what it is, org chart, organic pipeline,
ACL, worker lifecycle, knowledge system, report convention, tools) lives in
[ARCHITECTURE.md](ARCHITECTURE.md) — read it first.

## Layout

`presets/departments/<dept-id>/<role>.md` (this directory) — the convention
proposed by spec 004 §3.2. Each role is a leaner persona+tool delta, not a new
base agent preset (the neutral head/worker bases live in
`presets/deepartments-head|worker/`).

## File format

- **Frontmatter** (`---` delimited): `id` (stable role id referenced by jobs and
  spawns), `title` (display), `tools` (the model-facing tool ids allowed — the
  `restrict` allow-list binding to this list is **implemented**, so the declared
  `tools` ARE the effective allowance for the role).
- **Body**: the persona text. English (AGENTS.md language policy).
- **Literals**: the model is a FIXED literal `deepseek-v4-flash-vision-exp`
  (provider `opencode-zen`, reasoning max) — never the model template variable
  (fix 3203b69, spec §7.3); `{{cwd}}`, `{{deptName}}`, `{{headPostId}}`,
  `{{workspacePath}}`, `{{reportDir}}` are allowed and templated at runtime.

## Tool vocabulary (model-facing ids, as used by the harness surface)

- Web: `web_search`, `web_fetch`. Files: `read`, `write`, `edit`, `glob`,
  `grep`.
- Bus / lifecycle (plugin own layer): `send_message`, `agent_messages`,
  `dept_who`, `dept_memo_write`, `dept_sleep`.
- NEVER for department workers: `subagent`/`subagent_fork`/`workflow`/`ralph`
  — a worker is a root agent, not a coordinator (D3, §3.4).
- Role-specific allowance, by design: `edit` is granted to `organizer` (safe
  frontmatter/rename) but NOT to `researcher`/`reviewer`/`analyst` — the analyst
  deliberately consolidates without mutating source reports (see analyst.md).

## Worker cycle (ephemeral vs job-worker)

- **EPHEMERAL (default)**: a one-off task worker. Completes the task, reports to
  its head, and the head retires it (`dept_worker_retire`). NO sleep, no
  permission request (worker → host is PROHIBITED by ACL).
- **JOB worker** (spawned by `dept_job_run`, carries a `jobId`): EPHEMERAL PER
  ROUND — completes the job for this round (work, report, reply to its head) and
  is DONE; the head retires it and the NEXT round spawns a fresh worker with the
  same `jobId`. NO sleep, no permission request (worker → host is PROHIBITED by
  ACL).

## Report + source conventions referenced by the personas

- Researcher reports / reviewer verdicts / analyst syntheses:
  `{{reportDir}}/<role>/<YYYY-MM-DD>-<slug>.md` (reviewer verdicts
  `...-<slug>-review.md`) — the DEPARTMENT workspace `reports/` dir, NOT
  `.dsh/reports/...`.
- Sources: `{{workspacePath}}/sources/<topic-slug>.md` — see
  `docs/departments/research/SOURCES.md`.
- Organizer: indexes/normalizes both report dirs and maintains
  `{{reportDir}}/INDEX.md`.
