---
id: fact-check-queue
title: Fact-check the department's unverified reports
role: reviewer
description: Review the department's new reports — every claim and citation, against primary sources — and issue per-point PASS/FAIL verdicts to the Research Head.
schedule: "on-demand / after new reports (no calendar trigger)"
owner: research-head
outbox: .dsh/reports/reviewer/<YYYY-MM-DD>-<slug>-review.md
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
  `.dsh/reports/researcher/<YYYY-MM-DD>-<slug>.md`), or
- asks for "the queue": all researcher reports in
  `.dsh/reports/researcher/<YYYY-MM-DD>-<slug>.md` that have NO matching
  verdict file `.dsh/reports/reviewer/<YYYY-MM-DD>-<slug>-review.md`.

## What to do (per report in the queue)

1. **Read the report** (`read`) and extract every claim and citation
   (facts, numbers, quotes, dates, attributions, source URLs + dates).
2. **Verify against primary sources.** Re-fetch each cited source
   (`web_search`/`web_fetch`, prefer API/JSON endpoints). Do not trust the
   report's framing. If a source changed or is unreachable, record the
   CURRENT state instead of the report's claim. Flag anything wrong,
   unverifiable or stale.
3. **Write the verdict report** to
   `.dsh/reports/reviewer/<YYYY-MM-DD>-<slug>-review.md` — same date + slug
   as the reviewed report, with the `-review` suffix; frontmatter in the
   project report convention (`agent: reviewer`, `date`, `task`,
   `spec_ref: .dsh/reports/researcher/<YYYY-MM-DD>-<slug>.md`,
   `outcome: PASS|FAIL`, `verification`, ...). Body: one entry per point —
   claim → checked what → found what → corrected fact (if any) → PASS/FAIL
   per point — plus the overall verdict (PASS only if every point passes or
   the FAILs are non-material and documented; otherwise FAIL).
4. **Never edit the reviewed report!** Corrections and findings go into the
   review only.
5. **Reply to the head.** `send_message` with the verdict(s): PASS/FAIL, the
   per-point reasons (concise), and the review path(s). You report only to
   your head (ACL).

## Constraints

- One review file per verified report; verify ALL reports in the queue in
  one run.
- No code/repo changes, no commits: the only files you write are the review
  report(s).
