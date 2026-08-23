# Research Department role templates (F6 — spec 004)

Persona templates ("roles") of the Research Department, per
`docs/specs/004-research-department.md` §3.2. A role is a **person template
referenced by name** — this phase: `researcher`, `reviewer`, `organizer`
(§7.1). Roles are NOT agent presets: no `preset.yml`/`agent.cordis.yml` pair
here. They are repo-versioned templates the plugin resolves by name at
spawn time (`dept_worker_spawn`) and job-run time (`dept_job_run`), §7.4.

## Layout (proposal — owner confirm, spec §9 Q7)

`presets/departments/<dept-id>/<role>.md` (this directory) — the convention
proposed by spec 004 §3.2. Alternative considered: per-role subdirectories
inside the existing `presets/deepartments-head|worker/` base tree — rejected:
that tree is the *neutral agent preset* materialized into the profile
`.agent-presets/`, while a role is a leaner persona+tool delta, not a new base
agent preset.

## File format

- **Frontmatter** (`---` delimited): `id` (stable role id referenced by jobs
  and spawns), `title` (display), `tools` (the model-facing tool ids allowed
  for this role — the exact binding to the `restrict` allow-list is a
  builder-verify point, spec §7.1 / §9 last block).
- **Body**: the persona text. English (AGENTS.md language policy).
- **Literals**: the model is a FIXED literal
  `deepseek-v4-flash-vision-exp` (provider `opencode-zen`,
  reasoning max) — never the model template variable (fix 3203b69,
  spec §7.3); `{{cwd}}` is allowed and bound.

## Tool vocabulary (model-facing ids, as used by the harness surface)

- Web: `web_search`, `web_fetch`. Files: `read`, `write`, `edit`, `glob`,
  `grep`.
- Bus / lifecycle (plugin own layer): `send_message`, `agent_messages`,
  `dept_who`, `dept_memo_write`, `dept_sleep`.
- NEVER for department workers: `subagent`/`subagent_fork`/`workflow`/`ralph`
  — a worker is a root agent, not a coordinator (D3, §3.4).

## Report conventions referenced by the personas

- Researcher reports: `.dsh/reports/researcher/<YYYY-MM-DD>-<slug>.md`.
- Reviewer verdicts: `.dsh/reports/reviewer/<YYYY-MM-DD>-<slug>.md`
  (`outcome: PASS|FAIL` + per-point reasons) — the convention already in use
  in this repo.
- Organizer: indexes/normalizes both directories.
