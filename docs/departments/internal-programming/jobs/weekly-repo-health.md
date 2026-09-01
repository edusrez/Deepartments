---
id: weekly-repo-health
title: Weekly repository health check
role: builder
description: Audit the READMEs of the deployment's repos for existence, currency, structure (badges, build/test instructions, feature list, config) and broken links; fix README staleness directly and report a per-repo health table to the Internal Programming Head.
schedule: '0 8 * * 1'
owner: internal-programming-head
outbox: reports/builder/<YYYY-MM-DD>-repo-health.md
---

# Weekly repository health check

Task for the worker the Internal Programming Head materializes with this job
(role: `builder` — persona:
`presets/departments/internal-programming/builder.md`; the general protocol —
plan first, implement, verify, report — is that persona's, this body is the
concrete task).

## Objective

Audit the README health of this deployment's main repositories and fix README
staleness directly. The worker reads and writes in those repos (README updates
are the worker's job); git commits are NOT — report all changes to the head so
the Asistente commits them.

## Repos in scope

`/home/esuarez/projects/{deepartments,dsh-smart-restart,dsh-tool-web-enhanced}`.

## What to check (per repo)

1. **README.md exists?** If missing, note it (do NOT invent a whole README for a
   repo you do not own — flag it for the head).
2. **Current?** Does the README's stated version / feature list / config match
   the repo's actual `package.json` and source (features, commands, options)?
   Flag anything stale.
3. **Structure.** Conventional README sections: a short description, badges
   (CI/status, npm version, license) if the repo publishes them, install/copy
   instructions, **build + test instructions** (the commands a contributor runs),
   a **feature list**, and **configuration** (env vars, settings, options).
   Note what is missing or weak.
4. **Broken links.** `grep` the README for URLs and verify reachability
   (`web_fetch`, prefer HTTP status via API/JSON where possible); note any that
   are dead or redirected. Do not chase every link exhaustively — flag the
   obvious ones and mark the rest for a follow-up.
5. **i18n & docs staleness.** If the repo has `README.zh.md` or a `docs/`
   directory, confirm it is in sync with the canonical `README.md`; flag any
   drift (do not silently edit an i18n file that differs — note it).

## Fix directly (README only)

Fix README staleness you are confident about with `edit` (e.g. a stale version
in the badge, a now-wrong install command, a broken link you verified). Do NOT
commit. Report every change you made. When in doubt whether a change is right,
list it as a recommendation instead of editing.

## Report

Write the full findings to
`reports/builder/<YYYY-MM-DD>-repo-health.md` (`reports/` = the department
workspace reports dir; your cwd is the department workspace), frontmatter in the
project report convention (`agent: builder`, `date`, `task: weekly-repo-health`,
`spec_ref: docs/departments/internal-programming/jobs/weekly-repo-health.md`,
`outcome`, `files_touched`, `error_type`, `key_findings`), then the body:

- a **per-repo table**: repo / status (healthy / needs-attention) / issues found
  / changes made (files + short description of each fix);
- **recommendations** for the head: what needs a human decision, what to defer,
  which repos need a new README or a docs follow-up.

## Reply to the head

`send_message` to the Internal Programming Head: a concise summary (3–5 bullets)
— health per repo, the count of README fixes made, the top 1–2 follow-ups, the
report path, open questions. You report only to your head (ACL).

## Constraints

- Never touch files outside those repos (only README.md / README.zh.md / docs in
  the three repos in scope).
- Never commit — commits are the Asistente's job.
- Reference prior report paths you build on (≤ 3 per category).

## MEMO NORM (F3)

At the end of EVERY round, write `dept_memo_write` with the job's accumulated
state (results, decisions, anomalies, follow-up queue) so the next round picks
up where this one left off. Rounds are ephemeral — each round materializes a
FRESH worker with no carried state — and stale journals are the anti-pattern to
avoid (version-watch/monitor-dsh-updates stale since 2026-08-24): the memo is
the required continuity mechanism between rounds.
