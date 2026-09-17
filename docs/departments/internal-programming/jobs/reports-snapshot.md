---
id: reports-snapshot
title: Reports snapshot — round-bounded backup + restore proof of .dsh/reports
role: builder
description: Run the deterministic `scripts/reports-snapshot.mjs` round (copy of `.dsh/reports/` into /home/esuarez/projects/.dsh-reports-backups, manifest {path,bytes,md5} of the ORIGIN, md5(ORIGIN) vs md5(COPY) compared, declared window, retention in ROUNDS) plus the RESTORE-VERIFY of the newest round, and report the round verdict {snapshotados, modificados-en-la-ventana, fallidos} to the Internal Programming Head.
schedule: '20 */6 * * *'
owner: internal-programming-head
outbox: reports/builder/<YYYY-MM-DD>-reports-snapshot-<token>.md
---

# Reports snapshot — the net under the house report convention

Task for the worker the Internal Programming Head materializes with this job
(role: `builder` — persona: `presets/departments/internal-programming/builder.md`;
the general protocol — plan first, implement, verify, report, BOOT-QUIET,
messaging ACL, ephemeral — is that persona's, this body is the concrete task).

## Why this job exists (measured 2026-09-17)

`.gitignore:2` ignores `.dsh/reports/`, and `.dsh/reports/` is exactly where the
house workflow sends every agent deliverable (`<agent>/<date>-<slug>.md`):
measured 1,618 files / 29,067,091 bytes / 31 MB with **no version control and no
`git checkout` that can bring any of it back**. The same day an ALREADY-COMMITTED
file vanished from the working tree (it survived by six seconds of margin): over
a git-tracked file there is a net, over an IGNORED file there is **no net at
all**. This job is that net. **Nothing moves and the report convention does not
change** — the snapshot is additive.

**The script does the work; NO agent decides anything inside the copy loop.**
This round only RUNS it, READS its verdict, and reports. A manual step is not a
control.

## What to do

1. **Run the round** (the script is deterministic; it is the control):

   ```
   cd /home/esuarez/projects/deepartments && node scripts/reports-snapshot.mjs
   ```

   Defaults: `--source /home/esuarez/projects/deepartments/.dsh/reports`,
   `--dest /home/esuarez/projects/.dsh-reports-backups`, `--rounds 7`,
   `--manifest-mirror /root/.deepartments/departments/internal-programming/reports/builder`.
   Capture the WHOLE stdout (it ends in a `ROUND-JSON:` line): it is the round's
   third-location record. **Do not pass `--quiet` in the report round** — the
   human block is the evidence. Do not invent extra flags: change the cadence or
   the retention only through this definition, not per round.

2. **Run the RESTORE PROOF on the round you just took** — a backup that has
   never been restored is not a backup, it is a promise:

   ```
   cd /home/esuarez/projects/deepartments && node scripts/reports-snapshot.mjs --verify latest
   ```

   It brings N files (default 25, deterministic stride sample + the largest file)
   from the snapshot back into a temporary directory and compares their `md5`
   against the manifest — **the manifest holds the md5 of the ORIGIN, so this
   comparison is not a tautology**. The temp dir is removed afterwards. Paste
   the `compared:` and `verdict:` lines. `--verify-sample 0` = every file.

2b. **AND ONCE A DAY, THE COMPLETE PROOF — `--verify-sample 0`** (order, not
   option): on the round whose window opens in the 00:00–06:00 UTC band (the
   `20 */6 * * *` tick whose stamp is `T00:20:…`), run the FULL restore after the
   sampled one:

   ```
   cd /home/esuarez/projects/deepartments && node scripts/reports-snapshot.mjs --verify latest --verify-sample 0
   ```

   **Why, measured:** the per-round proof samples (26 of 1,620 = 1.60 %, stride +
   the largest), so **1,594 files had never been restored** — a hole closed BY
   TIME, not by cost: the complete pass over the same round took **2.8 s /
   1,638 files** (measured 2026-09-17 20:04Z). The per-round sampling STAYS (cheap
   every 6 h); the daily pass is what turns "sampled" into "every file has been
   restored at least once". The artifact declares which one ran
   (`coverage: SAMPLE 26/1638 (1.59 %)` vs `coverage: COMPLETE 1638/1638 (100 %)`)
   — never report a sample as if it were the whole population.

3. **Read the verdict — and never mix the two definitions** (this is where the
   alert lives or dies):
   - **FAILED** = `md5(origin) != md5(copy)` while the origin held still, or
     present at the origin and absent in the copy (`absent-in-copy`,
     `copy-error`, `vanished-before-read`), or **the count did not add up**
     with the origin (`count-mismatch`). **ONLY this invalidates the round**
     (exit 1).
   - **MODIFIED DURING THE WINDOW is NOT a failure.** Reports are written while
     the snapshot runs; such a file is captured if its copy is intact and the
     script re-reads a file that moves mid-capture. It is DECLARED
     (`modificados-en-la-ventana`, `aparecidos`, `desaparecidos`,
     `unstableCaptured`) and **never fails the round**: a control that cries
     over the house's normal activity gets switched off in three rounds.
     **And the accounting guard now ABSORBS that declared movement instead of
     contradicting it** (in this same change, `scripts/reports-snapshot.mjs`):
     the round prints two NAMED bands — `origin@scan` (the PRE-loop walk, the
     population the copy loop enumerated) and `origin@open` (the POST-loop walk,
     ONE WINDOW LATER) — and judges `captured == origin@scan − lostAtScan` and
     `origin@open == captured + aparecidos-no-capturados`. Before this, the number
     served under the name `sourceAtScan` was the post-loop count (`const
     sourceAtScan = atOpen`), so **a normal write of the house between the scan
     and the open produced `count-mismatch` ⇒ verdict FAILED + exit 1** on a round
     whose own artifact printed `failed=0 … REPORTED, NOT A FAILURE`
     (reproduced 2026-09-17 19:58Z). **When reading a count-mismatch anomaly, read
     WHICH band it names; a mismatch whose numbers differ only by declared
     movement is a bug in the guard, not a broken snapshot.**
   - If the round is FAILED: **do NOT repair it by hand** (no re-copying a file,
     no editing the manifest — that would destroy the evidence). Report it with
     the `anomaly:` lines and put it on the ESCALATION list; the next round takes
     a fresh, independent copy.

4. **Retention is declared in ROUNDS, not in files**: `--rounds 7` (one round =
   one full copy of the tree ≈ 31 MB ⇒ a ceiling of ≈ 217 MB, not unbounded
   growth). It prunes ONLY this script's own older rounds inside
   `/home/esuarez/projects/.dsh-reports-backups` (+ its own mirror manifests).
   Report the `retention:` line (pruned rounds + the bytes they freed).

   **READ THE RETENTION AS A RECOVERY WINDOW: `--rounds 7` at `20 */6 * * *` ⇒
   ≈ 42 h.** A file lost more than ~42 h ago is **NOT recoverable** from this net
   — state that number in the report instead of leaving the reader to derive it
   from the two parameters. The manifest carries it as
   `redundancy.recoveryWindowHours: 42`.

5. **The reach of the net is a MEASURED FIELD, not a sentence** — and it is
   refutable in one line each:
   - `redundancy: { sites, measuredSites, deviceIds, distinctDeviceIds,
     sameDeviceAll, offMachine, singleFailureDomain }` is built from the mounts at
     the moment of the round (the device id of each site, read with `stat`/`df`;
     the field travels INSIDE `scope` and at the top level of the manifest).
     Measured 2026-09-17 20:04Z: **`sites: 3` (origin, round copy, manifest
     mirror), `deviceIds: [2049]`, `distinctDeviceIds: 1`,
     `sameDeviceAll: true`, `offMachine: false`** — all three sites live on
     `/dev/sda1`.
   - **The net is LOCAL: it survives an `rm`, a bad edit and a `git checkout`; it
     does NOT survive the loss of the disk.** ⇒ **A copy outside the machine is
     an OWNER decision and is declared as such** (`offMachineNote`) — never
     assumed, never implied by a prose note.
   - **Why a field and not a sentence** (measured motive): prose ("same filesystem
     for source and dest") let an optimist read the sentence selectively and
     overstate the net silently; a field cannot be overstated quietly, because
     `offMachine: false` is contradicted by exhibiting any copy outside the
     machine, and `sites: 3` by showing that two of the three paths share a
     `deviceId`. **Refute, don't trust:** `stat -c %d <site>`.

5. **The manifest lives in a THIRD site, never inside the snapshot**: (a) stdout
   — the `ROUND-JSON:` line, the scheduler journal; (b) the department reports
   dir `reports/builder/` OUTSIDE the repo; (c) a convenience copy at
   `<dest>/manifests/<round>.json`, outside the round dir. A control cannot share
   a destination with what it controls: if the manifest lived inside the
   snapshot, one deletion would take the material AND its proof of integrity.
   `--verify latest` reads the manifest from the MIRROR, never from the dest copy.

6. **AUTO-FIRE IS CONFIRMED — do NOT re-escalate it, and do NOT verify it with a
   clock.** The cron `20 */6 * * *` **fired at 18:20:15.071Z** (its exact minute)
   and its round came out `COMPLETE` (1,620/0/0, `RESTORE-VERIFIED 26/26`).
   **⇒ The next round must NOT report "auto-fire not observed"**: that question is
   CLOSED. The evidence is not the wall clock but the job's own key **plus its
   instant** in the runtime ledger:

   ```
   node -e "console.log(new Date(require('/.deepartments/job-runs-state.json')['reports-snapshot']).toISOString())"
   # => 2026-09-17T18:20:15.071Z  (measured 2026-09-17)
   ```

   That file is the runtime stateDir ledger (`<stateDir>/job-runs-state.json`, a
   flat `{jobId: lastRunTs}`), read-only, and it is the ONLY admissible proof of
   an auto-fire: a stale key means no run, a fresh key means a run — the clock
   says nothing either way.

7. **THE HUMAN ROUND RECORD LIVES IN THE DEPARTMENT REPORTS DIR — OUTSIDE the
   net, and it is NEVER pruned.** The per-round audit is
   `/root/.deepartments/departments/internal-programming/reports/builder/<date>-reports-snapshot-<token>.md`,
   and **the durable record of the NET itself is the MIRROR MANIFEST** (md5 per
   entry + the third copy with its `sha256`). **⇒ The `<token>` report is NOT
   written inside `.dsh/reports/`:** there it would not protect itself (a LATER
   round would capture it) and it would pollute every round's count — the count
   the guard judges. Cite the ROUND TOKEN in the report header (`md5` of both
   report paths, fb-28 convention) so a round can never overwrite another's record.

## Report

Write `reports/builder/<YYYY-MM-DD>-reports-snapshot-<token>.md` (`<token>` = your
run token, fb-28 — this job runs every 6 h, so WITHOUT the suffix two rounds of
the same day overwrite each other), frontmatter in the project report convention
(`agent: builder`, `date`, `task: reports-snapshot`, `spec_ref:
docs/departments/internal-programming/jobs/reports-snapshot.md`, `outcome`,
`files_touched`, `error_type`, `key_findings`), then the body:

- the round block VERBATIM (`window:` / `scope:` / `integrity:` / `window obs:` /
  `verdict:` / `retention:` + every `anomaly:` line);
- the `bands:` line (origin@scan / origin@open / origin@close) and the
  `redundancy:` line with its `deviceIds` / `sameDeviceAll` / `offMachine`;
- the RESTORE-VERIFY block (`coverage:` + `compared:` + `verdict:` + the
  `MATCH`/`MISMATCH` lines) — and, on the daily round, the COMPLETE coverage line
  (`COMPLETE n/n (100 %)`);
- the window declaration `{snapshotados, modificados-en-la-ventana, fallidos}`
  with the explicit instant of the reading;
- **delta vs the previous round** (file count and bytes): the trend is the
  reason the round exists; a count that JUMPS is information, not noise;
- WHEN IT MATTERS: a restore drill of a REAL vanished file (delete nothing in
  the source — restore into a temp dir and show the md5 match), or the reason
  the round could not be taken;
- **QUÉ NO PUDE VERIFICAR** — always present, even when empty.

## Reply to the head

`send_message` to the Internal Programming Head (worker → host is PROHIBITED):
the round verdict line, the counts (`snapshotados` / `modificados-en-la-ventana`
/ `fallidos`), the `redundancy:` field (`sites` / `deviceIds` / `offMachine`), the
restore-verify verdict AND ITS COVERAGE (sample or complete), the recovery window
(≈ 42 h), the round’s disk ceiling in rounds, any anomaly, the report path + the
`md5` of the two report copies, and the open questions.

## Constraints

- **READ-ONLY on `/home/esuarez/projects/deepartments/.dsh/reports`**: copy OUT,
  never write, delete or move anything inside it. There is no `--delete` flag and
  you must not create one.
- The ONLY destructive operation permitted is the RETENTION of this script's own
  older rounds inside its own destination, plus its own mirror manifests.
- Never touch `/.deepartments` (the runtime stateDir), `storages/`, the
  `.bak-*` trees, or the other department's live edit of
  `docs/departments/research/SOURCES.md`.
- No credentials, no `systemctl`/`smart_restart`/daemon restarts, no commits
  (commits are the Asistente's job).
- Scratch outside the repo; the repo tree stays clean except the task artifacts.
- Every number reported with its instant and its population (fb-137).

## MEMO NORM (F3)

At the end of EVERY round, write `dept_memo_write` with the round's accumulated
state (rounds taken, verdicts, anomalies, disk ceiling, follow-up queue) so the
next round picks up where this one left off: rounds are ephemeral — each round
materializes a FRESH worker with no carried state — and the memo is the required
continuity mechanism between rounds.
