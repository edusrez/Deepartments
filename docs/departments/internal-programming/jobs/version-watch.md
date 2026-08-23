---
id: version-watch
title: Watch DSH + installed plugins for new versions (evaluate, install, notify)
role: builder
description: Compare the published latest of DSH core and the installed plugins against what the deployment is on; read changelogs for security, breaking changes and compat; install viable plugin updates into the deepartments-dev profile (never stable); propose (never auto-install) a DSH core upgrade; hand the head a forwardable summary.
schedule: '0 6 * * *'
owner: internal-programming-head
outbox: reports/builder/<YYYY-MM-DD>-version-watch.md
---

# Watch DSH + installed plugins for new versions (evaluate, install, notify)

Task for the worker the Internal Programming Head materializes with this job
(role: `builder` — persona:
`presets/departments/internal-programming/builder.md`; the general protocol —
plan first, implement, verify, report — is that persona's, this body is the
concrete task).

## Objective

Determine whether DeepSeek Harness (DSH) core and the installed plugin set of
this deployment have newer published versions than what the deployment is on;
read the changelogs; install **viable plugin** updates into the
`deepartments-dev` profile (NEVER the stable profile); for core DSH propose (do
not auto-install) the upgrade steps; and hand the head a forwardable summary for
the Asistente.

## What to compare (web-first, all verifiable)

For **each package**, fetch the published `dist-tags`/releases and compare to
what the DEPLOYMENT is on (the repos' `package.json` and the DSH home manifests,
e.g. `/opt/dsh/.dsh-dev/*` manifests / `$DSH_HOME`):

1. **DSH core** — `@deepseek-ai/dsh`: npm dist-tags
   `https://registry.npmjs.org/@deepseek-ai/dsh` (`latest`, `rc`) + release feed
   `https://api.github.com/repos/deepseek-ai/deepseek-harness/releases`
   (tags prefixed `dsh-v...`). Reference the deployment's current version
   (`package.json` `peerDependencies`/`devDependencies` on `@deepseek-ai/dsh-*`
   — what this plugin is built against — and the CLI pin in AGENTS.md).
2. **`dsh-deepartments`** (this repo): registry
   `https://registry.npmjs.org/dsh-deepartments` dist-tags vs the repo's own
   `version` in `package.json`.
3. **Installed plugins**: `dsh-smart-restart`, `dsh-smooth-stream`, and the
   `dshmarket` storefront package — dist-tags from
   `https://registry.npmjs.org/<package-name>`, release notes from
   `https://api.github.com/repos/<owner>/<repo>/releases` (take owner/repo from
   the package's npm metadata `repository` field — never guess).
4. **Compatibility signal**: peerDependencies ranges in this repo's
   `package.json` vs the newest verified DSH rc; flag a mismatch (the class of
   `ERESOLVE` problem seen before).

For each newer version, record: **security notices**, **changelog highlights**,
**breaking changes**, and **compatibility** with the peer dep ranges.

## Install viable PLUGIN updates (never stable)

If a plugin update is viable (no breaking change against the deployment's DSH
line, peer ranges satisfied, tests pass):
`pnpm build` in the repo dir, then install into the **deepartments-dev** profile
with `dsh plugin --profile deepartments-dev add <dir>` (or the appropriate
update path for that plugin), using `DSH_HOME=/opt/dsh/.dsh-dev`. **NEVER the
stable profile** (that is the live Web profile, out of scope). Record the exact
commands run and their output.

## Core DSH: propose, never auto-upgrade

If core DSH has a newer version, **DO NOT auto-upgrade**. Propose the exact
upgrade steps for the Asistente (commands, manifest edits, risks, what breaks),
as recommendations only.

## Notify via the head (workers cannot message the host)

You cannot send_message to the Asistente (host) — worker → host is PROHIBITED by
the ACL. Report to the **Internal Programming Head**, and write your summary so
the head can forward it to the Asistente. Your summary to the head must be
forward-ready and contain:

- a **new-versions table**: package / current published (`latest` + `rc`) /
  what the deployment is on / delta / verdict (installed, upgrade-proposed,
  hold);
- **installs performed** (plugin builds + installs into deepartments-dev, the
  exact commands) with the verification result;
- **restart needed Y/N** — so the Asistente can `smart_restart` (canary) to load
  the installed changes. Say YES only if an install materially changed the
  running plugin (manifest/client metadata is cached; a restart is required
  after `add`). Never run a restart yourself.

## Report

Write the full findings to
`reports/builder/<YYYY-MM-DD>-version-watch.md` (`reports/` = the department
workspace reports dir; your cwd is the department workspace), frontmatter in the
project report convention (`agent: builder`, `date`, `task: version-watch`,
`spec_ref: docs/departments/internal-programming/jobs/version-watch.md`,
`outcome`, `files_touched`, `error_type`, `key_findings`), then the body:
the per-package table, the newer-version details (security/changelog/breaking/
compat), the installs performed with command output, and the core-DSH upgrade
proposal.

## Reply to the head

`send_message` to the Internal Programming Head with the forward-ready summary
(new-versions table, installs performed, restart needed Y/N, the report path).
The head forwards it to the Asistente. You report only to your head (ACL).

## Constraints

- Research/install only: no code edits outside the plugins' own dependencies, no
  commits, no stable profile, no restarts.
- Every claim cited (URL + date); a source that changed or is unreachable →
  record its CURRENT state, never guess.
- Prefer API/JSON endpoints (registry.npmjs.org, api.github.com); never trust
  truncated HTML shells of anti-bot pages; respect dates.
- Reference prior report paths you build on (≤ 3 per category); reuse the
  npm/GitHub API conventions of
  `docs/departments/research/jobs/monitor-dsh-updates.md` and the plugin listing
  report it cites.
