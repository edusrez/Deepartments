---
title: DOC-DRIFT — the drift check that keeps the docs alive
owner: internal-programming-head
verified_at: 2026-09-22T16:20:07.073Z
verified_commit: 51204e60
verified_by: organizer-7 (run 4ba60dc5, LANE W7-DOCS)
anchors:
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:5405
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:5500
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:8784
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:10185
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:10205
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:1082
  - /home/esuarez/projects/deepartments/packages/dshd-jobs/src/index.ts:278
  - /home/esuarez/projects/deepartments/packages/dshd-jobs/src/index.ts:296
  - /home/esuarez/projects/deepartments/packages/dshd-jobs/src/index.ts:305
  - /home/esuarez/projects/deepartments/packages/dshd-orchestration/src/tools.ts:2451
  - /home/esuarez/projects/deepartments/docs/departments/internal-programming/jobs/doc-drift.md
---

# DOC-DRIFT — the drift check

This is the difference between a living page and **one more register nobody
reads**. The owner already carries 809 open feedback records and ~322
WORK-REGISTER items; a documentation set without a decay mechanism would be a
third such pile. So every page written under this convention declares what it
cites and when it was verified, and a versioned job checks that declaration
against the code.

**Design rules, binding (host decision):**

1. **The docs live in the repo, under `docs/`** — versioned WITH the code they
   describe. A separate package would drift by construction.
2. **The drift job is a versioned job of the existing job system** — NOT a new
   systemd unit and NOT a loose cron. The `reviewer`/commit flow already lives
   there.
3. **Never a silent correction.** If drift is detected, the job ALERTS. It never
   rewrites the page, never "fixes" a line, never updates `verified_at` on its
   own. A page that lies must be *visible* as lying.
4. **Never a new channel.** Drift is emitted through the SAME health pipeline the
   watchdogs already use: findings → dedupe ledger → `notifyHost` (§3).
5. **Never duplicate a register.** The docs link `docs/WORK-REGISTER.md`,
   `/.deepartments/feedback.jsonl`, `docs/ROADMAP.md` and `docs/STORES-MAP.md`.

## 1. The mandatory frontmatter of every doc page

Every page under this convention MUST open with this block:

```yaml
---
title: WHERE TO LOOK — the routing index of this deployment
owner: internal-programming-head          # the ONE accountable post
verified_at: 2026-09-22T16:20:07.073Z     # ISO-8601, full instant, with ms
verified_commit: 51204e60                 # the short commit of verification
verified_by: organizer-7 (run 4ba60dc5)   # the run that verified it
anchors:                                   # EVERY archivo:linea the page cites
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:5405
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:761
---
```

| Key | Required | Why exactly this |
|---|---|---|
| `owner` | YES | A drift alert needs a NAME to route to. A page with no owner cannot be repaired because nobody is accountable for it. |
| `verified_at` | YES | An **INSTANT**, not a date. A date-only stamp went stale within 31 minutes elsewhere in this house and produced a false correction (`fb-1399`) — a date is not a verifiable anchor. |
| `verified_commit` | YES | The commit against which the `anchors` were read. This is what makes "falls behind" computable (§2.3). A short sha is enough to resolve; the checker MUST resolve it to a full sha before comparing. |
| `anchors` | YES (may be `[]`) | The `archivo:línea` set the page puts its weight on. An **EMPTY** list is legal and means "this page cites no line" — which is itself a claim the checker can verify (§2.1). Missing `anchors:` is a **defect of form**, not an empty set: the two must never be confused. |
| `verified_by` | recommended | Who to ask; also lets a reader weigh the claim. |

**Anchors are ABSOLUTE paths.** A relative citation resolves against the
reader's cwd and is the ghost-store win this house already paid for
(`docs/STORES-MAP.md` §2.3).

**Every anchor carries its SYMBOL, not only its line.** A line number is a
perishable anchor; a symbol is a durable one. The pages therefore write
`symbol → line at verified_at`. This is not style: measured on 2026-09-22, two
cited files were edited LIVE by other lanes while a page was being written
(§2.4) — the anchors moved THREE times in one session — and the symbol is the
only part that survived.

**Record what you cite, not only what the prose names.** The frontmatter
`anchors` list must cover EVERY `archivo:línea` the page puts weight on —
including the `systemd` unit/drop-in files and `.gitignore`. A page whose prose
cites a file it does not declare is the same defect it is trying to prevent.
(This was caught in this very round, on the first page: systemd paths were cited
in the body and were missing from `anchors`.)

**Convention note (language).** `AGENTS.md:3-14` is binding: *"All repository
content, code, comments, commit messages, reports and documentation are written
in English."* These pages therefore ship in **English** — including this one and
`docs/WHERE-TO-LOOK.md` — because they are repository content. Mission briefs and
messages to the owner stay in Spanish.

## 2. What the job checks

The job is a **read-only** auditor. It never writes a page.

### 2.1 Every cited file exists

For each entry in `anchors`, resolve the path and confirm the file is readable
(`read` on the literal path — the tie-break instrument for EXISTENCE, see
`docs/VERIFICATION-LADDER.md` §11.5).

- **File absent** ⇒ finding, severity `alto` — the page points at a deleted or
  renamed file, which is the fastest-rotting kind of anchor.
- **`anchors:` absent from the frontmatter** ⇒ finding, severity `medio` — a
  defect of FORM (an empty list and a missing list are different claims).

### 2.2 The names are still true

For each cited `archivo:línea`, read that line and confirm the page's ROW still
describes it. This is the part that cannot be fully automated, and the job must
say so instead of pretending:

- **Mechanical, automatable:** the cited line must exist (a file shortened below
  the cited line number is a hard finding), and every `systemd` unit name, file
  name and symbol name the page mentions in a table row must still appear at (or
  near) the cited anchor. A symbol that has moved is reported with its NEW line,
  which is exactly what the reviewing worker needs.
- **Not automatable:** whether the page's PROSE still matches the code's
  behaviour. **The job never guesses this.** It reports "anchor resolves, prose
  not judged" and leaves the judgement to the page's `owner`.
- **A unit/file name is checked in the OBJECT, not in prose:** to confirm
  `dsh-deepartments-dev.service` is still the unit, read the unit file
  (`/etc/systemd/system/dsh-deepartments-dev.service`) and its drop-in directory
  — do not re-read the page that claims it. *"Does X exist?" is answered where X
  is written, never where X is requested.*

### 2.3 Degrading to `stale` — the criterion, and why this one

> **CRITERION (chosen): PER-ANCHOR COMMIT DISTANCE, an UNCOMMITTED-TREE leg, and
> an age backstop.**
>
> For each file cited by the page:
>
> ```
> git -C <repo> rev-list --count <verified_commit>..HEAD -- <cited-file>
> git -C <repo> status --porcelain -- <cited-file>
> ```
>
> - **Leg 1 — the file moved since the stamp.** `rev-list --count` `> 0` for a
>   cited file ⇒ **`stale`** (severity `alto`): the page's line anchors are exactly
>   what a change to that file moves.
> - **Leg 2 — the file is dirty in the WORKING TREE.** `status --porcelain`
>   non-empty for a cited file ⇒ **`suspect`** (severity `alto`). A tree with
>   in-flight edits is ahead of HEAD, and Leg 1 is BLIND to it (§2.4).
> - **Leg 3 — age backstop.** `verified_at` older than **30 days** ⇒
>   **`suspect`** (severity `medio`) even if neither leg fired.
> - Otherwise ⇒ **`fresh`**: no finding at all.

**Why this criterion and not a global commit count.** A global distance ("N
commits since the stamp") is blind to WHERE the change landed, and it fails in
BOTH directions — measurably, in this very repo:

- **False positive:** a page about the key pooler does not rot when forty commits
  land in `packages/dshd-gui`. A global threshold would cry `stale` on a page
  that is still exact.
- **False negative:** ONE commit that inserts ten lines above a cited anchor
  invalidates `archivo:línea` completely while moving the global counter by one.
  The anchor is a LINE-SENSITIVE instrument; the criterion that guards it must be
  line-sensitive too.

**Why the threshold is `> 0` and not a larger N.** Because the anchor's failure
mode is *displacement*, not *semantic change*: a single inserted line above a
citation makes every subsequent citation on that page point one line off — the
exact class this house has already been bitten by. A tolerance of N commits would
mean shipping pages known to be off by N line-shifts. **Cost of `> 0` is bounded
on purpose:** the remedy is cheap and local for the page's `owner` — re-read the
cited lines, correct the numbers, re-stamp `verified_at`/`verified_commit`. That
is one small commit, and it is the ONLY thing that renews the stamp. (If a page
proves noisy in practice, its owner may split it or narrow its `anchors` to the
rows that carry weight — never silence the check.)

**Cost of Leg 2 (the dirty-tree leg) is bounded but noisy.** A repo with constant
in-flight edits will mark every page `suspect` while a lane is running. That is
the HONEST verdict — the page cannot be certified against a tree that is moving —
but it must not page the owner: `suspect` from Leg 2 is reported to the head in
the round's report, and never escalated as `alto`-severity drift on its own.

### 2.4 Worked example — measured on the day this page was written

The strongest argument for the criterion is that it caught a real defect within
the hour it appeared:

1. **Real displacement, per-anchor.** The anchor
   `packages/dshd-orchestration/src/tools.ts:6127` (the fb-775 validator) was
   verified, and then MOVED to `:6164` while this page was being written (the file
   grew 8037 → 8100 lines, W9 in flight). In the same hour
   `packages/dshd-health/src/index.ts` grew 10694 → 10880 lines (W3 in flight) and
   **every** health anchor moved, three times: `scanPoolerCapacity` `:5307` →
   `:5394` → `:5405`; the `pooler-capacity` render `:8620` → `:8767` → `:8778` →
   `:8784`; `notifyHost` `:10021` → `:10168` → `:10199` → `:10205`. Under Leg 1
   those pages are `stale` — and that is the CORRECT verdict, because the pages
   WERE wrong. **A global commit counter would have moved by an irrelevant
   amount; the per-anchor reading named the exact rows.**
2. **The discovery that Leg 2 exists because of.** Both files were edited in the
   WORKING TREE while HEAD stayed at `51204e60`. A checker running only
   `rev-list --count 51204e60..HEAD -- <file>` returns **0** — a FALSE NEGATIVE on
   a file that changed under the author's hands minutes ago. Commit distance
   measures the HISTORY, not the TREE. That is why Leg 2 is part of the criterion
   and not an optional extra.

**Consequence adopted by this convention:** a page whose claim depends on files
that are being edited RIGHT NOW cannot be honestly stamped `fresh`. The author's
remedy is to say so on the page (see the in-flight warning in
`docs/WHERE-TO-LOOK.md`) and to anchor on the SYMBOL, which does not move.

### 2.5 What the job must NOT do

- It must not edit the page, the anchor, or the stamp. **Alert, never correct.**
- It must not raise a finding for a page whose `stale` state it already reported
  inside the dedupe window — the ledger (§3) already collapses repeats to ≤1 per
  key per window; re-alerting faster than that would train the reader to ignore it.
- It must not claim a check it did not run. A tree it cannot read (no git, no
  path) ⇒ report `NOT MEASURED` with the reason. A `stale` that comes from a
  broken instrument is worse than no alarm at all.

## 3. How it emits — the existing pipeline, never a new channel

Drift travels the road the watchdogs already use, and nothing else is added:

```
scan produces findings
  → filter the ones worth alerting        packages/dshd-health/src/index.ts:10185
  → dedupe ledger (≤1 per key/window)     health-alerts-state.json  (:1082)
  → notifyHost(...)  ← THE ALERT        packages/dshd-health/src/index.ts:10205
  → audit append                          health-alerts.jsonl       (:1330)
```

(Line numbers measured at the `verified_at` of this page — the health file is in
flight; the SYMBOLS are the durable anchors.)

**PROPOSED AND NOT EXECUTED (needs code, host rule).** Carrying drift through
this road requires a producer that yields a `HealthFinding`, which touches
`packages/dshd-health/src/index.ts`. Per the host rule — *"if a lane has to touch
code to expose a truth, PROPOSE the row before writing it"* — this page does NOT
write it. The proposal is:

| Proposal | Shape |
|---|---|
| New producer | `scanDocDrift(pagesDir, repoRoot, nowMs, knobs, logger?): HealthFinding[]` in `packages/dshd-health/src/index.ts`, modelled on `scanPoolerCapacity` (`:5405`) — including its stale/unknown discipline (`:5500-5511`): a state the producer cannot measure yields **no finding** plus a `warn`, never a fabricated one. |
| New finding kind | `kind: 'doc-drift'`, `key: 'doc-drift:<page-relpath>'` (one dedupe key per page, so two rotted pages are two alerts and a re-alert is one). |
| New render row | one branch beside `pooler-capacity` at `:8784`, rendering page + verdict + the offending anchor. That code is explicit that a new kind MUST get its own branch — "never let these kinds hit" the stalled-post fallback. |
| Dedupe | reuse the shared ledger verbatim (`health-alerts-state.json`) — no new state file. |
| Severity mapping | `stale` (a cited file moved or is absent) → `alto`; `suspect` (dirty tree / age backstop) → reported in the round, `medio`; `NOT MEASURED` → not an alert, a log line. |

Until that producer exists, the job's worker still runs the check and reports to
its head (§5) — the check is useful on day one; only the routing through health
waits for the row above.

## 4. The instrument's blind spots (declare them, do not hide them)

The check is built on `git` and `read`. Both have measured blind classes:

- **Commit distance sees HISTORY, not the TREE** — the false negative that forced
  Leg 2 (§2.4, measured). Leg 2 covers it; a page verified against a dirty tree is
  `suspect`, never `fresh`.
- **`lib/` is gitignored** (`.gitignore:7`). A page citing the DEPLOYED artifact
  cannot be drift-checked by commit distance, because no git instrument sees it.
  Such a row must say so, or cite the source instead. (See the blindness table,
  `docs/VERIFICATION-LADDER.md:584-606`.)
- **A commit that does not touch a cited file can still falsify a page** — a
  behaviour change elsewhere (a config default, a schedule, a drop-in that wins).
  Neither Leg 1 nor Leg 2 catches this; the 30-day backstop is the only net under
  it, which is why the backstop is not optional.
- **Discovery calls have a 30 s budget and fail ALL-OR-NOTHING** (measured
  2026-09-22: `fb-2394` folded into `fb-1447`, and `fb-2398`). ⇒ The check must
  target explicit paths, never walk a tree. A verification command that sweeps is
  not a verification command.

## 5. How it is used

The job definition lives at
`docs/departments/internal-programming/jobs/doc-drift.md` (frontmatter:
`id`/`title`/`role`/`description`/`schedule`/`owner`/`outbox` — the exact shape
the parser requires, `packages/dshd-jobs/src/index.ts:278` + the required-key
list at `:296`; the jobDir resolver at `:305`).

**Trigger it manually (the head):**

```text
dept_job_run(jobId: "doc-drift")
```

`dept_job_run` takes ONLY `jobId` (plus an optional `peakOverride` justification
for a run inside a PEAK window — the tool is at
`packages/dshd-orchestration/src/tools.ts:2451`). `schedule` does **not** gate a
manual run; the weekly cron fires it automatically.

**What it produces:**

1. a WORKER (role from the definition) that runs the check read-only, and
2. a report in the department workspace —
   `reports/reviewer/<YYYY-MM-DD>-doc-drift-<token>.md` — carrying, per page:
   `page → verdict (fresh|stale|suspect|missing|not-measured) → offending anchor
   or file → which leg fired → the new line`, plus
3. a summary to the Internal Programming Head, who dispatches repairs to a
   `builder` and — when drift must reach the owner — folds it into the health
   report rather than opening a second channel.

**Idempotency:** a `doc-drift` worker already running is not duplicated
(`dept_job_run` errors `job already running: <workerId>`); retire it explicitly
to re-run.

## 6. Adoption

This convention applies to the mission's documentation set, delivered by page:
`docs/WHERE-TO-LOOK.md` (delivered, this round) first, then the architecture map
(a) and the runbook (b). Pages (a) and (b) are deliberately deferred: W1/W2/W3/W6
and W7 are moving the very files they would describe (measured live during this
round, §2.4), so writing them today would ship them `stale` on arrival.

To adopt a new page: write it, stamp its frontmatter, add it to the job's page
list, and make sure its `anchors` list covers everything the prose cites. From
that moment the check owns it.
