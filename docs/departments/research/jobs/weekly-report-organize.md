---
id: weekly-report-organize
title: Weekly report organization of the department
role: organizer
description: Index, normalize and keep tidy the department's report archive (researcher + reviewer reports), maintaining reports/INDEX.md in the department workspace; never destroys anything on its own judgment.
schedule: "weekly Monday 09:00 (reserved — calendar not yet implemented; manual run via dept_job_run)"
owner: research-head
outbox: reply to the Research Head (summary) — index at reports/INDEX.md
---

# Weekly report organization of the department

Task for the worker the Research Head materializes with this job (role:
`organizer` — persona: `presets/departments/research/organizer.md`; the
general protocol — inventory, normalize, never delete on own judgment —
is that persona's, this body is the concrete task).

## Objective

Keep the department's report archive tidy: everything named per convention,
duplicates/obsoletes detected, one index up to date. The index is
`reports/INDEX.md` (the department workspace reports index; your cwd is the
department workspace, so this is relative to it). It is SEPARATE from
`docs/departments/research/README.md`, the static layout doc.

## What to do

1. **Locate the archive.** The report directories are `reports/researcher/`
   and `reports/reviewer/` (the same relative paths the researcher and
   reviewer personas use). Resolve them against your working directory; if
   they are not reachable from your cwd, ask the Research Head for the
   absolute location before doing anything.
2. **Inventory.** `glob` both directories: naming convention
   `<YYYY-MM-DD>-<slug>.md`, missing/broken frontmatter (parse with the
   report frontmatter convention: `agent`, `date`, `task`, `spec_ref`,
   `outcome`, ...), duplicates (same date + topic, or a re-run superseding an
   older report of the same task), and obsolete entries (superseded reports,
   empty files, orphan artifacts). For researcher reports also note which
   ones have NO matching reviewer verdict (see the fact-check-queue job).
3. **Normalize.** Rename to the convention where the content is safe:
   - a pure rename (content unchanged, only the file name is wrong): record
     the candidate — do NOT recreate the file; list it for the head;
   - broken/missing frontmatter: you MAY fix the frontmatter in place with
     `edit` and report what you changed (safe metadata only — never alter
     findings, conclusions or citations);
   - duplicates/obsoletes: list the candidate (keep/replace/remove) — the
     head decides. **You never delete anything on your own judgment.**
4. **Maintain the index.** Create/update `reports/INDEX.md` (relative to your
   cwd = the department workspace): a table with columns — date, report path,
   task / slug, agent, outcome, review status (verified / unverified / FAIL),
   notes. First run creates the file; later runs update it. Keep the README
   untouched.
5. **Report.** `send_message` to the Research Head: what was
   renamed/indexed/fixed, the index path, and the candidate list awaiting the
   head's decision (renames, duplicates, obsolete, anything you could not
   do). One line per candidate with file path + recommendation.
6. **Finish (JOB WORKER).** `dept_memo_write` your summary, then REQUEST sleep
   permission from YOUR HEAD (via `send_message` — never the host), WAIT for
   the approval, then `dept_sleep` — per the organizer persona's job-worker
   cycle. You are switched off for good only when the head retires you.

## Constraints

- Only the report directories and `reports/INDEX.md` may be touched by this
  job (plus your own summary message). Never modify researcher/reviewer report
  BODIES; never touch `jobs/` definitions, presets or code.
- Deleting/removing anything is ALWAYS a head decision — the job only lists
  candidates.
