---
id: host-sampler
title: Host-health sampler custody + slow-call cross-read
role: builder
description: Keep the host-health sampler alive (liveness, coverage, rotation) and run the documented slow-call cross-read over the period; report the verdicts (FLAT = the machine is not the cause, PRESSURE = sizing has a basis) to the Internal Programming Head.
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

**Custodian, not engine.** The SAMPLING is done by the detached process
`scripts/host-sampler.mjs` (a job round can only materialize an LLM worker — it
cannot sample every 45 s). This job keeps that process alive and turns its data
into a decision. The norm — schema, rotation caps and the READING CRITERION —
is `docs/departments/internal-programming/HOST-SAMPLER.md`; **read it, never
restate it**.

## Objective

1. Report whether the sampler was ALIVE and COMPLETE over the period, and
2. run the cross-read: for every slow call of the carrier tools
   (`send_message`, `dept_feedback`, `dept_worker_spawn`) in the period, the
   host state in +/-60 s and its **verdict** — so the open question ("is the
   server short?") is answered by a criterion instead of an impression.

## What to do

1. **Liveness** — `tail -20 /.deepartments/host-sampler.log`;
   the last row of `/.deepartments/host-health.jsonl` must be younger than
   `3 x intervalSec` (45 s default); `pgrep -af host-sampler` and the pid in
   `/.deepartments/host-health.jsonl.pid` must name the SAME live process.
   A missing/younger-than-expected series is a FINDING, not a formality.
2. **Coverage** — count rows in the period, compute the largest gap and the
   declared cadence (`intervalSec`), and count rows with a non-empty `errors[]`.
   Report the numbers, not an adjective.
3. **Restart if dead** (the norm §2 command, verbatim):
   `cd /home/esuarez/projects/deepartments && setsid nohup node scripts/host-sampler.mjs --state-dir /.deepartments --interval 45 --quiet --log /.deepartments/host-sampler.log >>/.deepartments/host-sampler.log 2>&1 < /dev/null &`
   A restart is allowed; **touching the stable profile `/opt/dsh/.dsh`, editing
   `packages/dshd-orchestration/**` or `scripts/mpc-preflight.mjs`, or
   restarting the service is NOT**.
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
