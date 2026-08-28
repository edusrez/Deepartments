---
id: quality-daily
title: Quality daily digest
role: quality-inspector
description: "Consolidate post-errors, stalled posts, delivery failures and prior inspection results into a once-a-day quality digest. Post-error delta is diffed from health-alerts.jsonl (post-errors.jsonl is subject to log-rotation and no longer diff-able)."
schedule: '0 8 * * *'
owner: quality-head
outbox: .dsh/reports/quality/<YYYY-MM-DD>-quality-daily.md
---

# Quality daily digest

Task for the worker the Quality Head materializes with this job (role:
`quality-inspector` — persona:
`presets/departments/quality/quality-inspector.md`; the general protocol —
BOOT-QUIET, messaging ACL, read-only, ephemeral-per-round — is that persona's,
this body is the concrete task).

## Objective

Consolidate the organization's runtime quality signal into a once-a-day digest:
the post-error deltas, stalled posts, delivery-failure deltas, and the previous
day's inspection results — the pattern report the QH folds into its
weekly/Asistente-facing report.

## What to read

1. `<stateDir>/health-alerts.jsonl` + `<stateDir>/health-alerts-state.json` —
   the **DURABLE per-tick capture** and the PRIMARY source for the post-error
   delta (RE-BASED 2026-08-27, per QH decision on the digest's own open
   question). `<stateDir>/post-errors.jsonl` is subject to 26ac649-style
   log-rotation (observed 184→1 at the 02:07-08-27 deploy), so its live rows
   vanish between digests and all-time totals are NOT diff-able. Diff the
   health-alerts `post-error` findings with row-ts > previous digest run ts;
   treat post-errors.jsonl as a SECONDARY sanity check. Note the rotation
   caveat in the digest body when a mid-window reset occurred.
2. `<stateDir>/deliveries.jsonl` — the delivery sidecar (messages-store §4.4).
   Filter `status: 'failed'` and diff against the previous digest: the
   delivery-failure delta. NOTE (forensics gap): after the 26ac649 renumber,
   sidecar rows may carry pre-renumber ids that do not resolve to
   messages.jsonl (epoch-map them; flag unresolvable rows). Also note:
   `prepared` rows WITHOUT a terminal row that target RETIRED hosts/sessions
   (class documented from m-243/m-356) — report recurrence but do NOT re-file
   as new PRs (already an IPD hygiene line).
3. The **archived session logs** (the retire/sleep/rotation artifacts under
   stateDir: `journals/sessions/*.md`, `journals/archive/`,
   `sessions/*.jsonl.zstd`) — look for a stale/leaked row, a post-error pattern,
   a delivery-failure thread, a head/host rotation that left an artifact. Use
   `read`/`glob`/`grep`; use `dept_exec` READ-ONLY to read the raw session
   artifacts (`sessions/*.jsonl.zstd`, `journals/archive/`) via the extended
   session-artifact root.
4. The **previous inspection results**: the prior digest (and any recent
   `quality-inspector` reports) under `.dsh/reports/quality/`. Reference the
   prior report paths you build on (≤ 3).

## Consolidate

Produce the digest sections:

- **Post-error delta** — new post-errors since the last run (health-alerts
  findings row-ts > prior digest run), with the recurring `postId`/`error`
  pattern (+ its likely cause if evident from the session logs).
- **Stalled posts** — posts that show as interrupted/stalled in the session logs
  (a reconcile/auto-run failure footprint).
- **Delivery-failure delta** — the `status: 'failed'` delivery delta since the
  last run (`deliveries.jsonl`), with id-resolution caveat.
- **WATCH CLASSES (post-barrido 2026-08-27)** — track recurrence of two
  low-severity state classes with no owner yet: (i) `config-preset "model"
  unbound` — `config-presets.jsonl` markers / health-alerts `config-preset`
  frames (last observed 08-25, auto-resolved; report if it recurs — it is NOT
  yet a registered class on its own); (ii) identical `lastRun-ms` for 2+ jobs
  in `job-runs-state.json` (scheduler scribe anomaly; first seen
  1787821214777 on daily-ai-news + monitor-dsh-updates). Report ONLY new
  recurrence; no re-filing as PRs.
- **Prior inspection results** — what the recent inspector reports found, and
  whether any signal is repeating (incl. the worker-retired ANALYZE
  opportunities that remain undirected).

## Report

Write the digest to
`.dsh/reports/quality/<YYYY-MM-DD>-quality-daily.md` — the stateDir/repo
`.dsh/reports/quality/` path (D-Q6), NOT the department-workspace `reports/`,
frontmatter in the project report convention (`agent: quality-inspector`, `date`,
`task: quality-daily`, `spec_ref: docs/departments/quality/jobs/quality-daily.md`,
`outcome`, `files_touched`, `error_type`, `key_findings`), then the body: the
four digest sections above.

## Reply to the head

`send_message` to the Quality Head with a CONCISE summary (the four digest
headlines + the report path). You report only to your head (ACL) — worker → host
(the Asistente) is PROHIBITED.

## Constraints

- Read-only inspection only: no code edits, no commits, no stable profile, no
  restarts. Never message the host directly (ACL) — report to the QH, which
  forwards to the Asistente.
- Every claim cited (file:line / report path); never guess.
- Reference prior report paths you build on (≤ 3 per category).