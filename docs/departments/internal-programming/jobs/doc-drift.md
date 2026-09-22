---
id: doc-drift
title: Doc drift check — verify the routing pages still describe the code
role: reviewer
description: Read every page of the documentation set under the DOC-DRIFT convention, check that each cited file still exists and that its archivo:linea anchors still resolve, degrade a page to stale when a cited file moved since verified_commit (or is dirty in the working tree), and report per page — ALERT ONLY, never a silent correction.
schedule: '0 11 * * 1'
owner: internal-programming-head
outbox: reports/reviewer/<YYYY-MM-DD>-doc-drift-<token>.md
---

# Doc drift check

Task for the worker the Internal Programming Head materializes with this job
(role: `reviewer` — persona:
`presets/departments/internal-programming/reviewer.md`; the general protocol —
verify read-only, report, never edit — is that persona's, this body is the
concrete task).

`role: reviewer` is deliberate: this job VERIFIES a claim against its ground
truth and owns exactly one written artifact (the report). It must never repair
the page it inspects.

## Objective

The owner's problem (2026-09-22): *"many agents have to investigate a lot to
understand where they are and what exists — up-to-date documentation would let
the systems read the pages they care about"*, plus the anti-junk objective. The
failure mode of every documentation effort in this house is that it becomes
**one more register nobody reads** (the owner already carries 809 open feedback
records and ~322 WORK-REGISTER items).

So the documentation set is guarded by a **drift check**: every page declares
what it cites and when it was verified, and this job checks that declaration
against the code. The full specification — the mandatory frontmatter, the
criterion, the emission path — lives in **`docs/DOC-DRIFT.md`**. Read it first:
this body is the round's task, that page is the design.

**The rule that governs the whole round: if drift is detected, ALERT — NEVER
correct it silently.** You do not edit the page, the anchor, the line number or
the `verified_at` stamp. A page that lies must be VISIBLE as lying; a silent
repair destroys the only evidence that the set is decaying.

## Pages in scope

The documentation set delivered under this convention. As of the first round:

- `docs/WHERE-TO-LOOK.md` (the routing index — the page that is read first)

A new page adopts the convention by stamping its frontmatter and being added to
this list. The architecture map and the runbook are deliberately NOT yet written
(W1/W2/W3/W6/W7 are moving the files they would describe ⇒ they would be born
`stale`).

## What to check

For EACH page in scope, read its frontmatter first (`read` the file; the
frontmatter is the contract).

1. **Form.** The page MUST carry: `owner`, `verified_at` (a FULL ISO-8601
   instant with ms — a date is not a verifiable anchor, see `fb-1399`),
   `verified_commit` (short sha), and `anchors` (the list of `archivo:línea` it
   cites).
   - **`anchors:` ABSENT** ⇒ finding, severity `medio`: a defect of form. An
     empty list `anchors: []` is LEGAL (it claims "I cite no line"); a MISSING
     list is a different claim and must never be read as an empty one.
   - Missing `owner` / `verified_at` / `verified_commit` ⇒ finding, `alto`:
     a page with no owner cannot be repaired (nobody is accountable) and a page
     with no stamp cannot be aged.
2. **Every cited file exists.** Resolve each anchor's path and confirm the file
   is readable. Use `read` on the LITERAL path — when two instruments disagree
   about EXISTENCE, `read` wins (`docs/VERIFICATION-LADDER.md` §11.5).
   - File absent (deleted/renamed) ⇒ finding, `alto`.
3. **The names are still true.** For each `archivo:línea`, read that line and
   confirm the page's row still describes it.
   - **Mechanical:** the cited line must EXIST (a file shortened below the cited
     line number is a hard finding), and every unit/file/symbol name the page
     states in a row must still appear at (or near) its anchor. A symbol that
     MOVED is reported with its NEW line — that is the actionable payload.
   - **Symbols, not only lines.** The pages cite `symbol → line at verified_at`.
     A moved SYMBOL is the finding; the old line number alone is not, because a
     line number is perishable by construction (measured 2026-09-22: two cited
     files were edited live by other lanes while a page was being written).
   - **Not mechanical — do NOT guess it:** whether the page's PROSE still matches
     the code's BEHAVIOUR. Report "anchor resolves, prose not judged" and leave
     the judgement to the page's `owner`. A fabricated prose verdict is a false
     finding, and a false finding is worse than no alarm.
   - **A unit/file name is verified in the OBJECT, not in prose:** to confirm
     `dsh-deepartments-dev.service` is still the unit, read that unit file and
     its drop-in directory — never re-read the page that claims it. *"Does X
     exist?" is answered where X is written, not where X is requested.*
4. **The stale criterion — per-anchor commit distance, PLUS the working tree,
   PLUS an age backstop** (the exact rule and its justification are in
   `docs/DOC-DRIFT.md` §2.3). For each cited file:

   ```
   git -C <repo> rev-list --count <verified_commit>..HEAD -- <cited-file>
   git -C <repo> status --porcelain -- <cited-file>
   ```

   - **Leg 1** — `rev-list --count` `> 0` ⇒ **`stale`**, severity `alto`.
   - **Leg 2** — `status --porcelain` non-empty (the file is dirty in the
     WORKING TREE) ⇒ **`suspect`**, severity `alto`. **This leg is not optional:
     commit distance measures the HISTORY, not the TREE, and a file edited but
     not committed yields a count of 0 — a measured FALSE NEGATIVE** (2026-09-22:
     two cited files changed under the author's hands while HEAD stayed put).
     Report these to the head in the round, but do NOT escalate a dirty-tree
     `suspect` to the owner on its own: a busy repo would page him constantly.
   - **Leg 3** — `verified_at` older than **30 days** ⇒ **`suspect`**,
     severity `medio` (the backstop for rot that arrives through a path neither
     git leg can see).
   - otherwise ⇒ **`fresh`** ⇒ NO finding at all.
   - **If an instrument cannot run** (the guard denies the `git` form, the repo
     is not readable) ⇒ report **`NOT MEASURED` with the reason**. NEVER
     approximate it, and never emit a `stale` you did not measure. As a
     read-only fallback for "what is HEAD right now", reading
     `<repo>/.git/refs/heads/main` (the literal file) is measured to work — but
     it answers HEAD only, NOT the distance, and NOT the working tree. If the
     distance is not measurable, the verdict is NOT MEASURED.
5. **Declare the instrument's blind spots in the report** (`docs/DOC-DRIFT.md`
   §4): commit distance sees history and not the tree (Leg 2); `lib/` is
   gitignored (`.gitignore:7`) so no git instrument sees the deployed artifact; a
   behaviour change in a file the page does NOT cite is caught by no leg (only the
   30-day backstop touches it); and a discovery call that WALKS a tree is not a
   verification instrument (30 s budget, all-or-nothing failure — measured
   2026-09-22, `fb-2394` folded into `fb-1447`, and `fb-2398`). Therefore: target
   explicit paths, never sweep.

## Emission

Report the findings to the Internal Programming Head — **never open a new
channel**, and never write to `health-alerts.jsonl` yourself.

The design routes drift through the SAME health pipeline the watchdogs use
(findings → dedupe ledger `health-alerts-state.json` → `notifyHost`). That path
needs a producer that the docs lane did NOT write (it is code, and the host rule
is: propose the row before writing it). The proposal — the producer, the finding
kind, the render row, the dedupe key and the severity mapping — is declared in
`docs/DOC-DRIFT.md` §3. Until the head lands it, THIS job's report to the head IS
the alert — say so explicitly in the report so the reader knows which road was
taken.

## Report

Write the full findings to
`reports/reviewer/<YYYY-MM-DD>-doc-drift-<token>.md` (`reports/` = the department
workspace reports dir; your cwd is the department workspace). The `<token>` in
the file name is REQUIRED (fb-28): this job is scheduled, and two rounds must
never overwrite each other. Frontmatter in the project report convention
(`agent: reviewer`, `date`, `instant` — the COMPLETE ISO-8601 instant of the
round, in addition to `date`; `task: doc-drift`,
`spec_ref: docs/departments/internal-programming/jobs/doc-drift.md`, `outcome`,
`files_touched`, `error_type`, `key_findings`), then the body:

- a **per-page table**: page → verdict (`fresh` | `stale` | `suspect` |
  `missing` | `not-measured`) → the offending anchor or file → which leg fired →
  the NEW line, when a symbol moved;
- the **form findings** (missing `owner`/`verified_at`/`verified_commit`,
  missing-vs-empty `anchors`);
- the **NOT MEASURED list** with the reason for each;
- the **declared blind spots** of this round (item 5);
- the **repair queue** for the head: per page, what a `builder` must change —
  the page's own text and its stamp. You never make the change.

## Reply to the head

`send_message` to the Internal Programming Head: 3-5 bullets — how many pages
checked, the verdict per page, the top 1-2 actionable drifts (with the new line),
what is NOT MEASURED, and the report path. You report only to your head (ACL).

## Constraints

- **Read-only.** You NEVER `edit` a page, never update a stamp, never touch the
  code. Corrections are the head's dispatch to a `builder`.
- **ALERT, never a silent correction** — the rule the host underlined. A repair
  that erases the evidence is a defect, not a fix.
- **No new channel. No new register.** Never write to `health-alerts.jsonl`
  yourself, never append to `docs/WORK-REGISTER.md` or `/.deepartments/feedback.jsonl`
  (they are linked sources of truth, not destinations for this job — if a drift
  deserves a durable quality record, that is the head's call).
- **Do not duplicate the registers.** The pages this job guards LINK
  `docs/WORK-REGISTER.md`, `/.deepartments/feedback.jsonl`, `docs/ROADMAP.md` and
  `docs/STORES-MAP.md` — they never copy them, and neither do you.
- **Never touch the stable profile `/opt/dsh/.dsh`** and never mutate a unit.
- Every claim cited with its instrument and instant; a source unreachable →
  record its CURRENT state, never guess.

## MEMO NORM (F3)

At the end of EVERY round, write `dept_memo_write` with the job's accumulated
state — which pages are in scope, the verdicts, the unresolved NOT MEASURED
items, the pending repairs, and whether the health-pipeline producer of
`docs/DOC-DRIFT.md` §3 has landed. Rounds are ephemeral: each round materializes
a FRESH worker with no carried state, so the memo is the only continuity
mechanism between rounds.
