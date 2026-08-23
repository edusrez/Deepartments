---
id: system-health-report
title: System health daily report
role: builder
description: Daily system-health digest: service units, endpoints (HTTP 200 dev local), repo git statuses, delivery-failure + post-error counts, plugin/DSH versions vs published; report to the Internal Programming Head.
schedule: '0 7 * * *'
owner: internal-programming-head
outbox: reports/builder/<YYYY-MM-DD>-system-health.md
---

# System health daily report

Task for the worker the Internal Programming Head materializes with this job
(role: `builder` — persona:
`presets/departments/internal-programming/builder.md`; the general protocol —
plan first, implement, verify, report — is that persona's, this body is the
concrete task).

## Objective

Produce a daily **system-health digest** of the deployment the owner can act on
(W6, owner request 2026-08-23 — "monitorizar que todo va bien"): confirm the
service units are alive, the DEV endpoints answer HTTP 200, the three in-scope
repos are clean, no sustained delivery/error anomaly, and the deployed
plugin/DSH versions are the expected ones. The Asistente cannot be messaged by a
worker, so you report the digest to the **Internal Programming Head**, who
forwards it.

## What to check

1. **Service units (liveness — NO `systemctl`).** `systemctl` is DENIED by the
   `dept_exec` guard (command denylist) — you MUST NOT run it, and must NOT
   attempt to get around the guard. Determine liveness via ALLOWED means, in
   this order:
   - **Primary liveness: HTTP 200 on the DEV local endpoint(s)** (`web_fetch`;
     the dev web server serving this deployment).
   - **Process presence** via allowed commands (`ps`/`pgrep` on the unit's
     binary or the `node`/`tsx` process that serves the DSH dev web + the
     plugin), matched to the unit's expected working directory.
   - **Reading the systemd unit state files** if reachable (e.g.
     `/run/systemd/system/*.service`, `/etc/systemd/system/*.service`) — read
     only, to confirm the unit exists/Enabled — never `systemctl`.
   If the authoritative `systemctl is-active` state is strictly required for a
   unit, add it to the report's **ESCALATION** list instead of running it (only
   the Asistente/owner may run `systemctl`). Record the unit's name(s) as you
   actually verified them.
2. **Endpoints.** HTTP 200 on the DEV local URL(s) of this deployment
   (`web_fetch`; use the dev web server origin, not the public/stable one).
   Report each URL + its status. A non-200/redirect is a finding.
3. **Repo git statuses.** The three local repos
   `/home/esuarez/projects/{deepartments,dsh-smart-restart,dsh-tool-web-enhanced}`:
   `git status --porcelain` (allowed) → report per repo **dirty/clean** + the
   count of changed/untracked paths. No commits, no writes.
4. **Delivery-failure + post-error counts SINCE LAST RUN.** Read
   `<stateDir>/deliveries.jsonl` rows with `status:'failed'` and
   `<stateDir>/post-errors.jsonl` rows (stateDir default `.deepartments`; your
   cwd is the department workspace, per the report paths below). Track the prior
   run's last-seen positions in a per-run ledger
   (e.g. `<workspacePath>/reports/builder/system-health-ledger.json`) so the
   **delta since last run** (count and the new failed messageIds / new
   postIds) is what you report, not the all-time total. On the first run (no
   ledger) note the baseline all-time counts and mark the delta as N/A.
5. **Plugin/DSH versions vs published.** Use the `version-watch` npm/GitHub
   conventions (see
   `docs/departments/internal-programming/jobs/version-watch.md`): the repo's
   `package.json` versions and `/opt/dsh/.dsh-dev/*` (or `$DSH_HOME`) manifests
   vs `https://registry.npmjs.org/@deepseek-ai/dsh` (`latest`/`rc`) and
   `https://registry.npmjs.org/dsh-deepartments` (+ the plugins' dist-tags).
   Report the deployed vs published delta per package. **Never touch the stable
   profile `/opt/dsh/.dsh`.**

## Report

Write the full digest to
`reports/builder/<YYYY-MM-DD>-system-health.md` (`reports/` = the department
workspace reports dir; your cwd is the department workspace), frontmatter in the
project report convention (`agent: builder`, `date`, `task: system-health-report`,
`spec_ref: docs/departments/internal-programming/jobs/system-health-report.md`,
`outcome`, `files_touched`, `error_type`, `key_findings`), then the body:

- a **health summary table**: check (service liveness per unit / endpoints /
  repo git status per repo / delivery-failures delta / post-errors delta /
  versions) → status (ok / attention / escalation) → detail;
- the **delta counts** (since last run) for delivery-failures and post-errors,
  with the new messageIds/postIds;
- the **versions table** (package / deployed / published / delta / verdict);
- the **ESCALATION list** — anything that needs the Asistente (e.g. a unit whose
  authoritative state is unverifiable without `systemctl`) and any real anomaly.

Update the ledger file so the next run's delta is computable. Reference prior
report paths you build on (≤ 3 per category).

## Reply to the head

`send_message` to the Internal Programming Head with the **forward-ready
digest** (health-per-check, the delta counts, the versions table, escalate
Y/N + the escalation items, the report path). The head forwards it to the
Asistente. You report only to your head (ACL).

## Constraints

- **NEVER run `systemctl`** (or `systemctl is-active`/`reboot`/`sudo`/etc.) —
  the `dept_exec` guard denies them; a strictly-required authoritative state goes
  on the ESCALATION list.
- **Never touch the stable profile `/opt/dsh/.dsh`** — DEV profile only, and only
  read for manifests/versions.
- Read-only for the repos and the state dirs; no code edits, no commits.
- Every claim cited (URL + date for versions/endpoints). A source unreachable →
  record its CURRENT state, never guess.
