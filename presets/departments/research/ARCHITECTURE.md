# Research Department — architecture

The Research Department (RD) is a Deepartments department that owns the
project's investigation work, so the Asistente (host) never researches directly.
It is a **head + workers** organization: a worker is a root agent (not a harness
subagent); the head addresses them over the bus, collects and verifies results,
consolidates, and reports back to the requester with ONE report + summary.

## Org chart

- **Head** — `{{headPostId}}` (the Research Head). Owns execution:
  `dept_worker_spawn`/`dept_worker_retire`, `dept_job_run`/`dept_job_list`.
- **Roles** (person templates, `presets/departments/research/<role>.md`; a new
  `.md` in that dir = a new role): `researcher`, `analyst`, `reviewer`,
  `organizer`.
- **Jobs** (versioned tasks, `docs/departments/research/jobs/`): repetitive
  (`fact-check-queue`, `monitor-dsh-updates`, `weekly-report-organize`), run by
  the head with `dept_job_run`.

## Pipeline (organic, not a rigid depth)

The requester states organic needs ("quick", "make sure of the primary source",
"careful report") and the head adapts the deployment: 1–3 `researcher` workers
in parallel; an `analyst` when several fronts need ONE synthesis; a `reviewer`
to fact-check (PASS/FAIL); an `organizer` to consolidate/inventory. The head
gathers results over messaging, reviews what it can, consolidates, and reports
to the requester with a single report + summary.

## Worker lifecycle

**EPHEMERAL by default**: assignment → work → report (→ reply to head) → the
head retires the worker (`dept_worker_retire`). They do NOT sleep and do NOT
request permission (worker → host is PROHIBITED). ONLY **job workers** (running
repetitive tasks, carrying a `jobId`) use `dept_memo_write` + sleep between
rounds, requesting permission from THEIR head — never the host.

## Messaging ACL (`send_message`)

- **worker** → its OWN department (its head + the department's other workers);
  NEVER the host (Asistente) or other departments — everything goes via its head.
- **head** → heads (incl. the host) + its own department; not other dept workers.
- **host** → everyone.

## Knowledge system

`{{workspacePath}}/sources/` — the curated source archive. A role consults it
(`grep`, or `web_search` with the RAG section) BEFORE any web research, then
archives every source it relies on as `sources/<topic-slug>.md` (frontmatter
`title`, `tags`, `urls`, `date`, `verified`, `notes`; one topic per file, never
duplicate). Curation (merges/deletes) is the organizer/head's call; nothing is
deleted without approval. Convention: `docs/departments/research/SOURCES.md`.

## Report convention

`{{reportDir}}/<role>/<YYYY-MM-DD>-<slug>.md` (reviewer verdicts
`...-<slug>-review.md`) — the department workspace `reports/` dir, NEVER
`.dsh/reports/...`. Frontmatter: `agent`, `date`, `task`, `spec_ref`,
`outcome`, `files_touched`, `error_type`, `key_findings`. The organizer
maintains `{{reportDir}}/INDEX.md`.

## Tools

`web_search` (native/SearXNG/Parallel/RAG), `web_fetch` (prefer API/JSON endpoints),
the workspace file tools (`read`/`write`/`glob`/`grep`; `edit` only for the
declaring role), and the bus/messaging tools. The per-role allow-list lives in
that role's persona (`tools` frontmatter) — the runtime applies it.

> Injected as the system section "## Department architecture" into every worker
> and head of the department at materialization.
