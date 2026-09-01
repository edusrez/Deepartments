---
id: pulse-digest
title: Daily job pulse digest (concise job metrics to the Asistente)
role: builder
description: Assemble a CONCISE daily digest of job-run metrics — rounds of the period (jobs run / cron), durations, results (ok / fail / pauses), and anomalies (fails, flakes, restart-registry restarts) — from the EXISTING job-runs state, calendar entries and recent reports; forward it to the Asistente via the Internal Programming Head.
schedule: '30 7 * * *'
owner: internal-programming-head
outbox: reports/builder/<YYYY-MM-DD>-pulse-digest.md
---

# Daily job pulse digest (concise job metrics to the Asistente)

Task for the worker the Internal Programming Head materializes with this job
(role: `builder` — persona:
`presets/departments/internal-programming/builder.md`; the general protocol —
plan first, implement, verify, report — is that persona's, this body is the
concrete task).

## Objective

Produce a **CONCISE daily digest** of this deployment's job-run metrics for the
Asistente (host): which jobs ran in the period, how long they took, what the
results were, and what anomalies appeared. The Asistente cannot be messaged by
a worker, so you report the digest to the **Internal Programming Head**, who
forwards it. The digest is a PULSE readout of the job system — short, factual,
forwardable; it is NOT a report of your own round's work (this job's output IS
the digest).

## Sources (EXISTING only — assemble, never invent)

1. **Job-runs state** — the job-runs state file (`readJobRunsStateFile`, runs
   per job: timestamps, durations, results, pauses), read from the runtime
   stateDir (default `.deepartments`; your cwd is the department workspace).
   If the primitive is not present in your round, fall back to the run history
   derivable from recent reports + the calendar, and note the gap under
   "Missing primitives" below.
2. **Calendar entries** — `dept_calendar_list` for the period: which jobs were
   due (cron/recurring, ad-hoc) and whether they fired or were missed.
3. **Recent reports** — the latest reports in `reports/builder/` (department
   workspace reports dir) and `.dsh/reports/builder/` (repo-level): each recent
   round's `outcome` + `key_findings` (≤ 3 reports per job per period).

## Digest contents (3–5 CONCISE bullets)

Assemble SHORT bullets covering the period since the last pulse-digest round:

- **Rounds** — which jobs ran (id + role), via cron/schedule or ad-hoc; jobs
  that were due but did not run.
- **Durations** — approximate per-job duration (job-runs state runs; otherwise
  from report timestamps).
- **Results** — ok / fail / pauses per job (job-runs state results or each
  report's `outcome` frontmatter).
- **Anomalies** — fails, flakes (report `error_type`), and restarts from the
  restart-registry if it exists (same stateDir). Name each anomaly + the job it
  belongs to.
- **Standout / follow-up** — at most one bullet with the top item the Asistente
  should act on (escalate Y/N).

If the period had NO job activity, say so in one bullet (pulse = quiet) instead
of padding.

## Deliver via the head (workers cannot message the host)

You cannot send_message to the Asistente (host) — worker → host is PROHIBITED by
the ACL. Report the digest to the **Internal Programming Head**, who forwards
it. Your summary to the head must be **forward-ready**: the 3–5 bullets exactly
as the Asistente should read them.

## Report

Write the digest to
`reports/builder/<YYYY-MM-DD>-pulse-digest.md` (`reports/` = the department
workspace reports dir; your cwd is the department workspace), frontmatter in the
project report convention (`agent: builder`, `date`, `task: pulse-digest`,
`spec_ref: docs/departments/internal-programming/jobs/pulse-digest.md`,
`outcome`, `files_touched`, `error_type`, `key_findings`), then the body: the
3–5 bullet digest, and the per-source detail it is based on (runs list,
calendar window, reports consulted).

## Reply to the head

`send_message` to the Internal Programming Head with the **forward-ready
digest** (the 3–5 bullets), the report path, and escalate Y/N. The head forwards
it to the Asistente. You report only to your head (ACL).

## MEMO NORM (F3)

At the end of EVERY round, write `dept_memo_write` with the job's accumulated
state (the digest bullets, decisions, anomalies, follow-up queue) so the next
round picks up where this one left off. Rounds are ephemeral — each round
materializes a FRESH worker with no carried state — and stale journals are the
anti-pattern to avoid (version-watch/monitor-dsh-updates stale since
2026-08-24): the memo is the required continuity mechanism between rounds.

## Missing primitives → recommendations only (0 code)

This job NEVER invents primitives: it assembles from EXISTING sources only. If a
required source does not exist in your round (e.g. the job-runs state file or
the restart-registry), do NOT build it here (0 code) — document the gap as a
recommendation in the report body (the exact primitive + why it is needed) so
the head can task it to a code lane.

## Schedule (why 07:30 daily)

The other daily IPD jobs use this deployment's local-time 5-field cron
(version-watch `0 6 * * *`, system-health-report `0 7 * * *`,
weekly-repo-health `0 8 * * 1`). The system-health digest runs at 07:00; this
job runs at `30 7 * * *` — 30 minutes later — so the pulse digest summarizes the
same window the health digest just checked, catching any overnight/failed job
rounds the health run reports. The 5-field cron mirrors the existing pattern.

## Constraints

- 0 code edits, 0 commits, never the stable profile `/opt/dsh/.dsh` — assemble
  only from existing sources.
- Every claim cited: the report path / job id it comes from.
- Keep it CONCISE: 3–5 bullets are the deliverable, not an essay.