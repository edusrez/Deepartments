---
id: host-sampler
title: Host-health sampler custody + slow-call cross-read
role: builder
description: VERIFY the host-health sampler's liveness (coverage, rotation) — its life is owned by the systemd unit dsh-host-sampler.service (Restart=always) — and run the documented slow-call cross-read over the period; report the verdicts (FLAT = the machine is not the cause, PRESSURE = sizing has a basis) to the Internal Programming Head.
schedule: '15 */6 * * *'
owner: internal-programming-head
outbox: reports/builder/<YYYY-MM-DD>-host-sampler-custody.md
---

# Host-health sampler custody + slow-call cross-read

Task for the worker the Internal Programming Head materializes with this job
(role: `builder` — persona:
`presets/departments/internal-programming/builder.md`; the general protocol —
plan first, implement, verify, report, BOOT-QUIET, messaging ACL, ephemeral —
is that persona's, this body is the concrete task).

**Custodian, not engine — and now a VERIFIER, not the source of life.** The
SAMPLING is done by the detached process `scripts/host-sampler.mjs` (a job round
can only materialize an LLM worker — it cannot sample every 45 s). Its LIFE is
owned by the dedicated systemd unit `dsh-host-sampler.service`
(`Restart=always`, `RestartSec=15`, start limit 5/300 s, **MainPID in its OWN
cgroup** `/system.slice/dsh-host-sampler.service` — so a restart of the daemon
no longer SIGTERMs it); this job **VERIFIES** that life and turns the data into
a decision. The norm — schema, rotation caps and the READING CRITERION — is
`docs/departments/internal-programming/HOST-SAMPLER.md`; **read it, never
restate it**.

## Objective

1. Report whether the sampler was ALIVE and COMPLETE over the period, and
2. run the cross-read: for every slow call of the carrier tools
   (`send_message`, `dept_feedback`, `dept_worker_spawn`) in the period, the
   host state in +/-60 s and its **verdict** — so the open question ("is the
   server short?") is answered by a criterion instead of an impression.

## What to do

1. **Liveness** (the FULL protocol, in this order — the norm §6 is its durable
   copy):
   - `systemctl is-active dsh-host-sampler` ⇒ **PRIMARY** life signal.
   - **FRESHNESS OF `/.deepartments/host-health.jsonl` is the truth of the
     SAMPLING** (one row PER TICK; measured deltas 45,0 s): last row within
     **≤ 2 x intervalSec (90 s) = HEALTHY**; **> 3 x (135 s) = INVESTIGATE**.
     A missing/younger-than-expected series is a FINDING, not a formality.
   - **`pidfile == MainPID`** (anti-double-sampler): the pid in
     `/.deepartments/host-health.jsonl.pid` and `pgrep -af host-sampler` must
     name the SAME live process — and there must be no second one.
   - The line in `/.deepartments/host-sampler.log` is **AUXILIARY**: it is a
     **HEARTBEAT every ~20 ticks (~15 min at 45 s)** — `state.ticks % 20 === 1`
     — and NOT one line per tick, so **its age is NOT evidence of death**. The
     old "log row younger than 3 x intervalSec" test is FALSE: it would declare
     a healthy sampler dead at ~2 minutes and restart a healthy service on
     every pass.
2. **Coverage** — count rows in the period, compute the largest gap and the
   declared cadence (`intervalSec`), and count rows with a non-empty `errors[]`.
   Report the numbers, not an adjective.
3. **Restart if dead — VIA THE UNIT** (the inverse of the old recipe):
   - **The path is `systemctl restart dsh-host-sampler`** — the unit owns the
     process, its cwd, its flags and the log append targets. Use it when
     `is-active` is not `active`, or when the pidfile names a **DEAD** pid while
     the unit is `active`.
   - **The manual launch is the LAST RESORT** (only when no sampler is alive and
     the unit is unavailable): the script has an **anti-double-sampling guard**
     and REFUSES a manual start while the pidfile names a live process
     (`another sampler is alive … refusing to double-sample`): `cd
     /home/esuarez/projects/deepartments && setsid nohup node
     scripts/host-sampler.mjs --state-dir /.deepartments --interval 45 --quiet
     --log /.deepartments/host-sampler.log >>/.deepartments/host-sampler.log 2>&1
     < /dev/null &`
   - What is STILL FORBIDDEN: **restarting the DAEMON**
     (`dsh-deepartments-dev`), touching the stable profile `/opt/dsh/.dsh`,
     editing `packages/dshd-orchestration/**` or `scripts/mpc-preflight.mjs`.
4. **Cross-read** (the norm §5 recipe):
   `node scripts/host-slowcall-correlate.mjs --since 6h --min 60 --window 60 --top 5`
   (add `--tool any` when the three carrier tools show nothing). Report the
   `[verdicts]` line and, per slow call, the tool + duration + caller ->
   recipients + the peaks that decided. A **PRESSURE** verdict names the metric
   and the peak sample (that is the sizing evidence); a **FLAT** verdict means
   the lateness is in the delivery/queue machinery — say so explicitly and do
   NOT recommend enlarging the box; **INSUFFICIENT** is reported as a coverage
   problem of the SAMPLER, never as "flat".
5. **Do not duplicate the QD** — the per-tool p50/p95/max watchdog is the QD's
   (`docs/departments/quality/TOOL-TIMING-WATCHDOG.md`). Cite its numbers only
   if you need them; your deliverable is the HOST side + the verdict.

## Report

Write `reports/builder/<YYYY-MM-DD>-host-sampler-custody.md` in the department
workspace, frontmatter in the project report convention (`agent: builder`,
`date`, `task: host-sampler`, `spec_ref:
docs/departments/internal-programming/HOST-SAMPLER.md`, `outcome`,
`files_touched`, `error_type`, `key_findings`), then the body: liveness +
coverage table (with the commands and their instants), the verdict table per
slow call, any PRESSURE evidence in full, and the sampler-restart events.

## Reply to the head

`send_message` to the Internal Programming Head: the liveness/coverage line, the
`[verdicts]` counts, every PRESSURE call with its metric, and the report path.
Worker -> host is PROHIBITED (ACL).

## Constraints

- **Read-only on the repository** except the sampler's own two scripts when a
  real bug is evidenced (then say so with file:line + the md5 before/after).
  Never touch `packages/dshd-orchestration/**` or `scripts/mpc-preflight.mjs`.
- **No commits** — report the changes; committing is the host's job.
- **fb-16**: never reproduce message bodies, `args`, tokens or sensitive paths.
- Every claim cited with file:line or a command + its instant (fb-137: no number
  without its instant and population).
