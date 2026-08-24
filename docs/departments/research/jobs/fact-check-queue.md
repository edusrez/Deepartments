---
id: fact-check-queue
title: Fact-check the department's unverified reports
role: reviewer
description: Review the department's new reports — every claim and citation, against primary sources — and issue per-point PASS/FAIL verdicts to the Research Head.
schedule: "on-demand / after new reports (no calendar trigger)"
owner: research-head
outbox: reports/reviewer/<YYYY-MM-DD>-<slug>-review.md
---

# Fact-check the department's unverified reports

Task for the worker the Research Head materializes with this job (role:
`reviewer` — persona: `presets/departments/research/reviewer.md`; the
verification protocol — verify every claim/citation, record current state,
never guess — is that persona's, this body is the concrete task).

## Objective

Verify the factuality of the department's research reports that have not
been reviewed yet, and hand the Research Head a per-point PASS/FAIL verdict
for each.

## Input

The trigger is the Research Head's message (this job has no calendar
trigger), which either:

- names the report file(s) to verify (e.g.
  `reports/researcher/<YYYY-MM-DD>-<slug>.md`), or
- asks for "the queue": all researcher reports in
  `reports/researcher/<YYYY-MM-DD>-<slug>.md` that have NO matching
  verdict file `reports/reviewer/<YYYY-MM-DD>-<slug>-review.md`.

## What to do (per report in the queue)

1. **Read the report** (`read`) and extract every claim and citation
   (facts, numbers, quotes, dates, attributions, source URLs + dates).
2. **Verify against primary sources.** Re-fetch each cited source
   (`web_search`/`web_fetch`, prefer API/JSON endpoints). Do not trust the
   report's framing. If a source changed or is unreachable, record the
   CURRENT state instead of the report's claim. Flag anything wrong,
   unverifiable or stale.
3. **Write the verdict report** to
   `reports/reviewer/<YYYY-MM-DD>-<slug>-review.md` (`reports/` = the department
   workspace reports dir; your cwd is the department workspace) — same date +
   slug as the reviewed report, with the `-review` suffix; frontmatter in the
   project report convention (`agent: reviewer`, `date`, `task`,
   `spec_ref: reports/researcher/<YYYY-MM-DD>-<slug>.md`,
   `outcome: PASS|FAIL`, `verification`, ...). Body: one entry per point —
   claim → checked what → found what → corrected fact (if any) → PASS/FAIL
   per point — plus the overall verdict (PASS only if every point passes or
   the FAILs are non-material and documented; otherwise FAIL).
4. **Never edit the reviewed report!** Corrections and findings go into the
   review only.
5. **Reply to the head.** `send_message` with the verdict(s): PASS/FAIL, the
   per-point reasons (concise), and the review path(s). You report only to
   your head (ACL).
6. **Finish (JOB WORKER).** You carry a `jobId` (deployed by schedule/reactive
   trigger via the Research Head's `dept_job_run`), but you are EPHEMERAL PER
   ROUND: complete the job for this round (work, write the report, reply to the
   head via `send_message`) and you are DONE. Do NOT `dept_sleep`; do NOT request
   sleep permission from anyone (worker → host is PROHIBITED). The head collects
   your result and RETIRES you (`dept_worker_retire`); the NEXT job round spawns
   a FRESH worker (a new `worker-<slug>-<uuid>`) with the same `jobId`. No
   round-to-round state carries over.

## Review flow

This job verifies the department's RESEARCH reports (`reports/researcher/`).
It never edits the reviewed report; it produces a verdict review
(`reports/reviewer/`) the head uses to decide whether a result is sound enough
to report out. Reports awaiting review are those with no matching `-review`
file — the organizer flags them too (see the weekly-report-organize job).

## Constraints

- One review file per verified report; verify ALL reports in the queue in
  one run.
- No code/repo changes, no commits: the only files you write are the review
  report(s).
