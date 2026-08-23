---
id: weekly-report-organize
title: Weekly report organization of the department
role: organizer
description: Index, normalize and keep tidy the department's report archive (researcher + reviewer reports), maintaining docs/departments/research/INDEX.md; never destroys anything on its own judgment.
schedule: "weekly Monday 09:00 (reserved — calendar not yet implemented; manual run via dept_job_run)"
owner: research-head
outbox: reply to the Research Head (summary) — index at docs/departments/research/INDEX.md
---

# Weekly report organization of the department

Task for the worker the Research Head materializes with this job (role:
`organizer` — persona: `presets/departments/research/organizer.md`; the
general protocol — inventory, normalize, never delete on own judgment —
is that persona's, this body is the concrete task).

## Objective

Keep the department's report archive tidy: everything named per convention,
duplicates/obsoletes detected, one index up to date. The index is
`docs/departments/research/INDEX.md` (a repo file, kept SEPARATE from
`docs/departments/research/README.md`, which is the static layout doc; if the
Research Head later directs the index into the README, follow that
instruction instead).

## What to do

1. **Locate the archive.** The report directories are `.dsh/reports/researcher/`
   and `.dsh/reports/reviewer/` (the same relative paths the researcher and
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
4. **Maintain the index.** Create/update `docs/departments/research/INDEX.md`
   (absolute: the repo file; if the repo root is not your cwd, confirm the
   repo path with the head): a table with columns — date, report path, task /
   slug, agent, outcome, review status (verified / unverified / FAIL), notes.
   First run creates the file; later runs update it. Keep the README
   untouched.
5. **Report.** `send_message` to the Research Head: what was
   renamed/indexed/fixed, the index path, and the candidate list awaiting the
   head's decision (renames, duplicates, obsolete, anything you could not
   do). One line per candidate with file path + recommendation.
6. **Finish.** `dept_memo_write`, then the worker sleep protocol (request
   permission, wait, `dept_sleep`) — per the organizer persona.

## Constraints

- Only the report directories and `docs/departments/research/INDEX.md` may be
  touched by this job (plus your own summary message). Never modify
  researcher/reviewer report BODIES; never touch `jobs/` definitions, presets
  or code.
- Deleting/removing anything is ALWAYS a head decision — the job only lists
  candidates.
