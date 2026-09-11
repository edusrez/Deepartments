---
id: monitor-dsh-updates
title: Monitor DSH + Deepartments ecosystem updates
role: researcher
description: Check DSH core and the Deepartments deployment plugin set for new versions on the rc channel, read the changelogs, and report potential improvements or regressions to the Research Head.
schedule: '0 9 * * *'
owner: research-head
outbox: reports/researcher/<YYYY-MM-DD>-dsh-updates-<token>.md
---

# Monitor DSH + Deepartments ecosystem updates

Task for the worker the Research Head materializes with this job (role:
`researcher` — persona: `presets/departments/research/researcher.md`; the
general protocol — web-first investigation, citations, memo, sleep — is that
persona's, this body is the concrete task).

## Objective

**Target line (declared HERE — this file is the single source of the target,
and it is updated here when the target moves):** the deployment tracks
`0.1.5-rc.x`, with `0.1.2-rc.1` as the peer-covered step below it. Every
verified release is compared against this declared line, and each delta is
classified on the alert ladder:

- `informa` — patch-level or UX-level change: no action, note it.
- `recomienda` — features or fixes that touch what we use: propose action.
- `URGENTE` — breaking change or security fix affecting the surface we use:
  flag it at the top of the report.

Determine whether DeepSeek Harness (DSH) and the packages this deployment
uses have newer versions than what the repo/deployment is currently on, read
the changelogs of what is new, and inform the Research Head of anything worth
upgrading, fixing or watching (improvements, breaking changes, regressions).

## What to check (all verifiable, web-first)

1. **DSH core** — npm `@deepseek-ai/dsh`: fetch
   `https://registry.npmjs.org/@deepseek-ai/dsh` and list the `dist-tags`
   EXACTLY as the registry publishes them (read the real tag names; never a
   remembered or expected set). `rc` is NOT a tag of this package —
   pre-releases live under `next`/`alpha`. A tag that was expected and is
   absent is recorded as ABSENT: never inferred, never substituted.
   Reference versions of THIS repo: `package.json`
   (`peerDependencies`/`devDependencies` on `@deepseek-ai/dsh-*` — what the
   plugin is built against) and the CLI channel/pin in `AGENTS.md`. Release feed:
   `https://api.github.com/repos/deepseek-ai/deepseek-harness/releases`
   (tags prefixed `dsh-v...`). Identity facts were verified in
   `reports/researcher/2026-08-22-dsh-plugin-listing.md` — reuse them.
2. **This plugin** — `dsh-deepartments` (this repo): registry
   `https://registry.npmjs.org/dsh-deepartments` dist-tags vs the repo's own
   `version` in `package.json`; if published upstream, read its changelog /
   release notes too.
3. **Ecosystem plugins the deployment uses** — the watch set is DERIVED at
   round time from the deployment profile manifest
   `/opt/dsh/.dsh-dev/profiles/deepartments-dev/package.json`: its
   `dependencies` keys plus its `dsh.profile.bundles` entries. Never
   enumerate the set from memory — a parallel list goes silently stale the
   day the profile changes (it already did: this item used to list the
   packages by hand and the list was wrong). For each derived package:
   dist-tags from `https://registry.npmjs.org/<package-name>`, release notes
   from `https://api.github.com/repos/<owner>/<repo>/releases`; when the repo
   is unknown, take it from the package's npm metadata `repository` field —
   never guess an owner/repo. If the manifest cannot be read, declare the set
   NOT MEASURED and do NOT enumerate from memory. If a package is unpublished or
   cannot be verified, record that state explicitly.
   - Derived example (`2026-09-11`, NON-NORMATIVE — re-derive, never reuse):
     that manifest yielded 16 `dependencies` entries and 17
     `dsh.profile.bundles` entries, including `dsh-key-pooler` and nine
     `dshd-*` packages; the repo's own `packages/dshd-*` glob resolves 10,
     so `dshd-core-min` exists in the repo but is NOT in the profile set.
4. **Compatibility signal — admissibility of peers against the INSTALLED
   kernel** — admissibility is decided by EVALUATING the declared range with
   `node-semver` (`semver.satisfies(installedVersion, declaredRange)`), not
   by reading a range and eyeballing it. The comparison reference is the
   INSTALLED kernel, located at round time by globbing
   `/opt/dsh/**/node_modules/@deepseek-ai/dsh/package.json` and reading its
   `version` — never the documentation, never memory, never the registry's
   newest rc (judging a range against the registry instead of the installed
   kernel produced a wrong "semver-compatible" verdict on 2026-09-10, which
   the next round had to correct). If the installed kernel cannot be located
   or read, declare the check NOT MEASURED. A range that does not match the
   current rc line caused `ERESOLVE` problems before — same class of check.

## Report

Write the full findings to
`reports/researcher/<YYYY-MM-DD>-dsh-updates-<token>.md` — the round token in
the file name is REQUIRED: two rounds of the same day must never overwrite
each other (a same-day sibling round risked exactly that on 2026-09-10). The
token-free path `reports/researcher/<YYYY-MM-DD>-dsh-updates.md` remains as a
POINTER that names the real report of that day. (`reports/` = the department
workspace reports dir; your cwd is the department workspace.) Frontmatter in the
project report convention (`agent: researcher`, `date`, `task: dsh-updates`,
`spec_ref: docs/departments/research/jobs/monitor-dsh-updates.md`,
`outcome`, `files_touched`, `error_type`, `key_findings`), then the body:

- a per-package table: package / current published (the dist-tags EXACTLY as
  the registry publishes them — a tag that is absent is recorded as ABSENT,
  never inferred) / what this repo or deployment is on / delta / verdict on
  the alert ladder (`informa`, `recomienda`, `URGENTE`; add `hold` when the
  delta is not admissible against the installed kernel);
- changelog highlights since the current pinned version: improvements, bug
  fixes, breaking changes, regressions (cite each release);
- recommended actions, each NAMING ITS EXECUTOR: a repo change ⇒ the Internal
  Programming Department; a profile/deployment change, a restart, a backup or
  an `npm i -g` ⇒ the Asistente (host). The core is NOT profile-scoped — `dsh
  plugin add` does not move it, the kernel is shared — so "upgrade the core"
  is a HOST action, never an assumed profile-side effect. This job NEVER
  installs, deploys or restarts anything: recommendations ONLY;
- every claim cited (URL + date); a source that changed or is unreachable →
  record its CURRENT state, never guess.

## Reply to the head

`send_message` to the Research Head: a concise summary (3–5 bullets) — new
versions yes/no, the top 1–2 actionable findings, the report path, open
questions. You report only to your head (ACL).

## Memo norm (F3)

Rounds are EPHEMERAL — every round materializes a FRESH worker with a new post
id and NO carried state (`monitor-dsh-updates`, `monitor-dsh-updates-2`, …) —
so the memo is the REQUIRED continuity mechanism between rounds. A stale job
journal is the anti-pattern to avoid (this job's journal went stale on
2026-08-24; after that the accumulated state was carried only by the head's
memo — the norm fixes the hole).

- At the END of every round, write `dept_memo_write` with the job's accumulated
  state — results summary, decisions, anomalies, follow-up queue, report paths
  — so the next round picks up where this one left off. The memo lands at
  `<stateDir>/journals/<yourPostId>.md`.
- At the START of the round, before researching, search the journal store for
  this job's prior memos (glob `journals/monitor-dsh-updates*`) AND the head's
  memo (`journals/research-head.md`) to pick up the carried state; then build
  on the prior reports (Constraints).

## Constraints

- Research-only: no code/repo changes, no commits, no builds. The report (and
  its token-free pointer) is the only file you write.
- Prefer API/JSON endpoints; never trust truncated HTML shells of anti-bot
  pages; respect dates.
- Reference prior report paths you build on (≤ 3 per category):
  `reports/researcher/2026-08-22-dsh-plugin-listing.md`,
  `reports/researcher/2026-08-23-smart-restart-awesome-pr.md`.