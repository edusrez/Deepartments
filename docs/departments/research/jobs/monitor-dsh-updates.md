---
id: monitor-dsh-updates
title: Monitor DSH + Deepartments ecosystem updates
role: researcher
description: Check DSH core and the Deepartments deployment plugin set for new versions on the rc channel, read the changelogs, and report potential improvements or regressions to the Research Head.
schedule: "daily 09:00 (reserved — calendar not yet implemented; manual run via dept_job_run)"
owner: research-head
outbox: reports/researcher/<YYYY-MM-DD>-dsh-updates.md
---

# Monitor DSH + Deepartments ecosystem updates

Task for the worker the Research Head materializes with this job (role:
`researcher` — persona: `presets/departments/research/researcher.md`; the
general protocol — web-first investigation, citations, memo, sleep — is that
persona's, this body is the concrete task).

## Objective

Determine whether DeepSeek Harness (DSH) and the packages this deployment
uses have newer versions than what the repo/deployment is currently on, read
the changelogs of what is new, and inform the Research Head of anything worth
upgrading, fixing or watching (improvements, breaking changes, regressions).

## What to check (all verifiable, web-first)

1. **DSH core** — npm `@deepseek-ai/dsh`: fetch
   `https://registry.npmjs.org/@deepseek-ai/dsh` and read the `dist-tags`
   (`latest`, `rc`). Reference versions of THIS repo: `package.json`
   (`peerDependencies`/`devDependencies` on `@deepseek-ai/dsh-*` — what the
   plugin is built against) and the CLI pin in `AGENTS.md`. Release feed:
   `https://api.github.com/repos/deepseek-ai/deepseek-harness/releases`
   (tags prefixed `dsh-v...`). Identity facts were verified in
   `reports/researcher/2026-08-22-dsh-plugin-listing.md` — reuse them.
2. **This plugin** — `dsh-deepartments` (this repo): registry
   `https://registry.npmjs.org/dsh-deepartments` dist-tags vs the repo's own
   `version` in `package.json`; if published upstream, read its changelog /
   release notes too.
3. **Ecosystem plugins the deployment uses** — the known set:
   `dsh-smart-restart` (npm `dsh-smart-restart`, repo
   `github.com/edusrez/dsh-smart-restart`; see
   `reports/researcher/2026-08-23-smart-restart-awesome-pr.md`),
   `dsh-smooth-stream`, and the `dshmarket` storefront package. For each:
   dist-tags from `https://registry.npmjs.org/<package-name>`, release notes
   from `https://api.github.com/repos/<owner>/<repo>/releases`; when the repo
   is unknown, take it from the package's npm metadata `repository` field —
   never guess an owner/repo. If a package is unpublished or cannot be
   verified, record that state explicitly.
4. **Compatibility signal** — peerDependencies ranges in this repo's
   `package.json` vs the newest verified DSH rc (a range that does not match
   the current rc line caused `ERESOLVE` problems before — same class of
   check).

## Report

Write the full findings to
`reports/researcher/<YYYY-MM-DD>-dsh-updates.md` (`reports/` = the department
workspace reports dir; your cwd is the department workspace), frontmatter in the
project report convention (`agent: researcher`, `date`, `task: dsh-updates`,
`spec_ref: docs/departments/research/jobs/monitor-dsh-updates.md`,
`outcome`, `files_touched`, `error_type`, `key_findings`), then the body:

- a per-package table: package / current published (`latest` + `rc` tags) /
  what this repo or deployment is on / delta / verdict (upgrade, hold,
  watch);
- changelog highlights since the current pinned version: improvements, bug
  fixes, breaking changes, regressions (cite each release);
- recommended actions for the Research Head to pass to the Asistente
  (upgrade candidate, PR needed, hold because X) — recommendations ONLY;
- every claim cited (URL + date); a source that changed or is unreachable →
  record its CURRENT state, never guess.

## Reply to the head

`send_message` to the Research Head: a concise summary (3–5 bullets) — new
versions yes/no, the top 1–2 actionable findings, the report path, open
questions. You report only to your head (ACL).

## Constraints

- Research-only: no code/repo changes, no commits, no builds. The report is
  the only file you write.
- Prefer API/JSON endpoints; never trust truncated HTML shells of anti-bot
  pages; respect dates.
- Reference prior report paths you build on (≤ 3 per category):
  `reports/researcher/2026-08-22-dsh-plugin-listing.md`,
  `reports/researcher/2026-08-23-smart-restart-awesome-pr.md`.
