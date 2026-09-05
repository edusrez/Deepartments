# Quality Department role templates

Persona templates ("roles") of the Quality Department, per
`docs/specs/007-quality-department.md` §3.2. A role is a **person template
referenced by name** — this department's ONE role: `quality-inspector` (D-Q6).
Roles are NOT agent presets: no `preset.yml`/`agent.cordis.yml` pair here. They
are repo-versioned templates the plugin resolves by name at spawn time
(`dept_worker_spawn`) and job-run time (`dept_job_run`).

The department's **static design** (what it is, org chart, pipeline, ACL, worker
lifecycle, execution scope, report convention, tools) lives in
[ARCHITECTURE.md](ARCHITECTURE.md) — read it first.

## Layout

`presets/departments/<dept-id>/<role>.md` (this directory) — the convention
proposed by spec 007. Each role is a leaner persona+tool delta, not a new base
agent preset (the neutral head/worker bases live in
`presets/deepartments-head|worker/`).

## File format

- **Frontmatter** (`---` delimited): `id` (stable role id referenced by jobs and
  spawns), `title` (display), `tools` (the model-facing tool ids allowed — the
  `restrict` allow-list binding to this list is **implemented**, so the declared
  `tools` ARE the effective allowance for the role).
- **Body**: the persona text. English (AGENTS.md language policy).
- **Literals**: the model is a FIXED literal `deepseek-v4-flash`
  (provider `opencode-zen`, reasoning max) — never the model template variable
  (fix 3203b69, spec §7.3); `{{cwd}}`, `{{deptName}}`, `{{headPostId}}`,
  `{{workspacePath}}` are allowed and templated at runtime. (The QD report path
  is `.dsh/reports/quality/`, NOT `{{reportDir}}`.)

## Tool vocabulary (model-facing ids, as used by the harness surface)

- Web: `web_search`, `web_fetch`. Files: `read`, `write`, `glob`, `grep`.
- Execution (READ-ONLY restricted roots): `dept_exec` — the `quality-inspector`
  role. See ARCHITECTURE (execution scope) for the allowed roots + the read-only
  rule.
- Bus / lifecycle (plugin own layer): `send_message`, `agent_messages`,
  `dept_who`, `dept_memo_write`, `dept_feedback` (universal/ACL-free — ANY
  agent, worker/head/host, may emit a durable feedback record to the
  quality-head backlog). (2026-08-27 LOTE A: `dept_sleep` is RETIRED for
  heads/workers — they stay `idle|running`; only the host keeps dept_sleep.)
- NEVER for department workers: `subagent`/`subagent_fork`/`workflow`/`ralph`
  — a worker is a root agent, not a coordinator (D3, §3.4).
- Role-specific allowance, by design: the `quality-inspector` has **NO `edit`**
  (the QD never repairs — it inspects and reports, never fixes) and NO harness
  subagent tools; `dept_exec` is READ-ONLY (the inspector reads the archived
  session artifacts, never mutates); `write` is for the inspection report only.

## Toolset guarantee (R9/fb-29/fb-35/fb-121)

The role's declared `tools` are a **contract enforced at spawn**, not a hint:
the spawn seam validates the RESULT against the DECLARED set
(`packages/dshd-orchestration/src/spawn.ts` `assertWorkerToolsetResult`, R9) and
the worker-slug dedup counts the durable retired archive (fb-121). Two absolute
guarantees:

- **Fail-loud toolset (fb-29/fb-35)** — an inspector/worker NEVER materializes
  with a mutilated toolset. After `agents.create` and BEFORE `registerEntry`,
  the spawn validates that every declared exec-gate tool (`dept_exec`,
  `dept_zstd_read`) is present on the LIVE agent scope and — when the
  toolset-audit proves the environment serves capability tools (any probe row
  with `allowCount > 0`) — that every declared file/web tool
  (`read`/`write`/`glob`/`grep`/`web_search`/`web_fetch`) is on the RESULT
  allow-list. A degraded toolset (a declared tool ABSENT from the result) =
  **dispose + throw LOUD**: the created agent is disposed, `0` durable rows are
  written, `0` deliveries happen — a worker is never spawned
  silently-mutilated / messaging-only (the 2026-08-31 empty-scope incident
  class).
- **Never-reused slugs (fb-121)** — the worker-slug dedup (`dedupedWorkerSlug`)
  consults the DURABLE RETIRED ARCHIVE
  (`<stateDir>/posts-retired-archive.jsonl` — the never-erased ledger the A3/C2
  prune + retire-annex rows feed), NOT only the live catalog (`posts.json` /
  byPost). A slug RETIRED — even PRUNED from `posts.json` (the
  `maxRetiredKept` class: q-i-16..23 live are archive-only) — is NEVER returned
  by a later spawn: «a registered (even retired) slug is never reused» is the
  law (the dedup returns `-2`/`-3`… suffixes, never the base).

**How to verify a slug is free or retired:** `dept_who` shows the live catalog
(scope `all` renders retired workers with `retired: true`); the ground truth is
the durable registry `posts.json` (byPost) + the retired archive file
(`<stateDir>/posts-retired-archive.jsonl`) — a slug in EITHER is taken, a slug
in neither is free.

## Worker cycle (ephemeral vs job-worker)

- **EPHEMERAL (default)**: a one-off task worker. Completes the task, reports to
  its head, and the head retires it (`dept_worker_retire`). NO sleep, no
  permission request (worker → host is PROHIBITED by ACL).
- **JOB worker** (spawned by `dept_job_run`, carries a `jobId`): EPHEMERAL PER
  ROUND (W8-g) — completes the job for this round (work, report, reply to its
  head) and is DONE; the head retires it and the NEXT round spawns a fresh
  worker with the same `jobId`. NO sleep, no permission request (worker → host is
  PROHIBITED by ACL).

## Report conventions referenced by the personas

- Quality inspector reports / digests:
  `.dsh/reports/quality/<YYYY-MM-DD>-<slug>.md` (D-Q6) — the stateDir/repo
  `.dsh/reports/quality/` path, a deliberate divergence from the department
  workspace `reports/` dir (NOT `{{reportDir}}/`).
- Sources: the QD inspects the org's own runtime (no external research — spec
  §7.5), so it curates no `sources/` archive by default; if a later phase adds
  one it follows `{{workspacePath}}/sources/<topic-slug>.md`.

## Secretary-first report awareness (POST-go-ahead, fb-47)

When a mission needs prior-context, **search previous reports via your
secretary** (`tool-secretary`) instead of reading bulk files inline — a
secretary greps/globs `.dsh/reports/` and returns a compact briefing (relevant
report paths, ≤3 per category). This is POST-go-ahead ONLY: never dispatch the
secretary before the wake/owner permission gate.
