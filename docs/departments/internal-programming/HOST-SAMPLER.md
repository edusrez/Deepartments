# IPD — Host-health sampler + slow-call cross-read (norm)

**Status: DURABLE NORM** (LANE `HOST-SAMPLER`, 2026-09-10; owner request relayed
by the host). This file is the **canonical home** of three things: the JSONL
**schema**, the **rotation caps** and — the part that makes the datum decide
anything — the **READING CRITERION** (§4). The agenda job
`docs/departments/internal-programming/jobs/host-sampler.md` and the two scripts
**point here**; they do not restate it.

> The owner suspects the server "comes up short". The host measured and it is
> **not** the cause (slow window ~30-35 % user + ~10 % system, iowait ~2 %;
> 32 days: CPU-stall 1,82 %, IO 0,11 %, memory 0,00 %, 0 OOM, disk 60 %). But the
> **fine correlation was impossible**: `sar` publishes 10-minute averages and PSI
> is only cumulative, so a 234 s tool call hides inside one average. This lane
> closes exactly that gap — and, above all, gives the number a **criterion**:
> without one, "the host looked normal" is not a finding.

## 1. Artifacts and where they live

| artifact | what it is |
|---|---|
| `scripts/host-sampler.mjs` | the **sampler process**: one JSON line every 30-60 s (default 45 s) into the stateDir JSONL |
| `dsh-host-sampler.service` | the **systemd unit that OWNS the sampler's LIFE** (`Restart=always`, own cgroup) — §2 |
| `scripts/host-slowcall-correlate.mjs` | the **recipe**: for a slow tool call, the host state in +/-60 s **and the verdict** |
| `<stateDir>/host-health.jsonl` | the series (stateDir = `/.deepartments` in the DEV deployment) |
| `<stateDir>/host-sampler.log` | bounded status log (same trim policy) |
| `<stateDir>/host-health.jsonl.pid` | single-instance lock (a second sampler refuses to start) |
| `docs/departments/internal-programming/jobs/host-sampler.md` | the **custodian job** (agenda: liveness VERIFICATION + periodic cross-read) |

**NOT this lane:** the QD's tool-timing watchdog
(`docs/departments/quality/TOOL-TIMING-WATCHDOG.md`) OWNS the timing metric
(per-tool p50/p95/max + the anomaly criterion) and the `deliveries.jsonl`
cross-check. This lane **consumes** the same intent/settle pairing (§4.1) and
adds the **host window**; it duplicates no timing instrumentation.

## 2. Runner: the sampling is a PROCESS, and its LIFE is systemd's (not the job's)

A department JOB fires through `runJobForDepartment`, which **materializes an
LLM worker** — it cannot sample every 45 s (that would be a worker per tick).
The sampling is therefore done by the **detached OS process**; the agenda job
**VERIFIES** it — it neither sustains it nor restarts it as its first resource.

**Since 2026-09-10 the life is owned by a dedicated systemd unit:**

| unit | what it declares |
|---|---|
| `dsh-host-sampler.service` | `Restart=always` + `RestartSec=15` (start limit `5/300 s`), `User=root`, `WorkingDirectory=/home/esuarez/projects/deepartments`, `ExecStart=/usr/bin/node scripts/host-sampler.mjs --state-dir /.deepartments --interval 45 --quiet --log /.deepartments/host-sampler.log`, stdout+stderr `append:`ed to that same log, and **MainPID in its OWN cgroup** `/system.slice/dsh-host-sampler.service` |

The failure this closes: the sampler used to live inside the
`dsh-deepartments-dev.service` cgroup (`KillMode=control-group`), so **every
restart of the daemon SIGTERMed it** — 4 measured deaths in 71 min and
**69,7 min of blindness (48,8 % of the span)**. The unit's own cgroup covers
**100 % of those measured deaths**.

Read it back on the **SERIES**, never on the log: `systemctl is-active
dsh-host-sampler` (PRIMARY life signal) · `cat
/.deepartments/host-health.jsonl.pid` vs the live process (`pgrep -af
host-sampler`: the SAME live pid, and no second one) · last row of
`/.deepartments/host-health.jsonl` younger than `2 x intervalSec` = 90 s
(HEALTHY), `> 3 x` = 135 s (INVESTIGATE).

**The log is AUXILIARY:** `logLine` emits a **heartbeat every ~20 ticks (~15 min
at 45 s)** — `state.ticks % 20 === 1` (`scripts/host-sampler.mjs:728`), NOT one
line per tick — so the age of the last log line is **NOT** evidence of death and
must never be used as a liveness test (the old "log row younger than
`3 x intervalSec`" test would declare a healthy sampler dead at ~2 minutes).

**Manual launch — LAST RESORT** (only with the unit unavailable and no sampler
alive): the script has an **anti-double-sampling guard** and REFUSES a manual
start while the pidfile names a live process (`another sampler is alive …
refusing to double-sample`, `scripts/host-sampler.mjs:680-686`):

```bash
cd /home/esuarez/projects/deepartments && \
  setsid nohup node scripts/host-sampler.mjs \
    --state-dir /.deepartments --interval 45 --quiet \
    --log /.deepartments/host-sampler.log >>/.deepartments/host-sampler.log 2>&1 < /dev/null &
```

One-shot (for a check, no loop): `node scripts/host-sampler.mjs --once --quiet`.

## 3. JSONL schema (v1)

One JSON object per line, keys in this order (the script header is the
authoritative list; this table is the reader's contract):

| key | meaning |
|---|---|
| `v` | schema version (`1`) |
| `ts` / `iso` | **the sampling instant** (epoch ms / ISO-8601 UTC) — the CUT |
| `intervalSec` | the DECLARED cadence; a reader detects holes against it |
| `uptimeSec` | host uptime |
| `nproc` | logical CPUs |
| `load1` `load5` `load15` | load average (`/proc/loadavg`) |
| `runnable` `procs` | currently runnable tasks / total tasks |
| `load1PerCore` | `load1 / nproc` (the criterion's convenience form) |
| `mem.totalKb` `availableKb` `usedKb` `usedPct` | `usedKb = totalKb - availableKb` — **MemAvailable**, never MemFree-only |
| `mem.swapTotalKb` `swapFreeKb` `swapUsedKb` `dirtyKb` `writebackKb` | swap + writeback (evidence, not criteria) |
| `psi.{cpu,io,memory}.{some,full}.{avg10,avg60,avg300,totalUs}` | `/proc/pressure/*` verbatim: percent-of-window + the **cumulative** microsecond counter (the only way to reconstruct a window retroactively) |
| `daemon.{unit,profile,pid,rssKb,vmSizeKb,threads,state}` | the `node` process of the unit `dsh-deepartments-dev` (`/proc/<pid>/status` VmRSS); `null` = not resolvable this tick |
| `disk.{path,totalBytes,usedBytes,availBytes,usedPct,inodesUsedPct}` | `/` with **df semantics** (`usedPct = used/(used+avail)`) |
| `stateDir.{path,bytes,files,bytesAt,ageSec,truncated,skipped}` | apparent-size sum of the stateDir tree (`du -sb` semantics), computed at most every 15 min |
| `tickMs` | the sampler's own overhead |
| `errors[]` | `"source: message"` — a failing source degrades to `null`, the series NEVER breaks (a silent hole is what the sampler exists to prevent) |

**fb-16 (no secrets):** every field is a number or a fixed system label. The
sampler never reads message bodies, never reads the `args` of
`tool-intents.jsonl`, and never records env vars, credentials, tokens, usernames,
hostnames or agent content.

**Rotation (declared cap + criterion):** trim in place to the last
`--keep-lines` (**12000**) lines whenever the file exceeds `--max-lines`
(**20000**) lines or `--max-bytes` (**16 MiB**); atomic (tmp + rename), newest
rows win. At 45 s, 20000 lines is ~10,4 days and the retained 12000 lines
~6,25 days. The log is trimmed the same way (4000 → 1000).

## 4. THE READING CRITERION (the decision, not the datum)

For a slow call, the window is **[intent - W, settle + W]** with `W = 60 s`
(`--window`). A **verdict** is emitted per call out of **two families** —
"the box is short" and "the box was busy" are different findings and only the
first one is answered by buying a bigger box.

**CAPACITY** (widening HAS a basis) — any of:

| signal | threshold | why this threshold |
|---|---|---|
| `psi.cpu.full.avg60` | **>= 1 %** | `full` = ALL runnable tasks stalled: the unambiguous GLOBAL shortage |
| `psi.io.full.avg60` | **>= 1 %** | same, for IO |
| `psi.io.some.avg60` | **>= 5 %** | >= 1 task IO-stalled; the host's 32-day IO-stall baseline is 0,11 % |
| `psi.memory.some.avg60` | **>= 1 %** | memory baseline is 0,00 %; ANY sustained memory stall is a departure |
| `MemAvailable` falls >= 25 % **and** `psi.memory.some` >= 0,5 % | both | a big fall PLUS real memory stalls = reclaim; the fall alone is page cache |
| `load1/nproc` | **>= 2 in >= 2 CONSECUTIVE samples** | a sustained runqueue; "consecutive" excludes a single-sample blip |

**CONTENTION** (names a scheduling hypothesis; does NOT justify widening) — no
capacity signal above, and any of:

| signal | threshold | reading |
|---|---|---|
| `psi.cpu.some.avg60` | **>= 5 %** | >= 1 task CPU-stalled while the box kept idle cores — scheduling contention among many runnable processes, not a shortage |
| `MemAvailable` falls | **>= 10 %** | page-cache churn unless `psi.memory` corroborates |

**FLAT** — the window is **FULLY covered** and NO signal of either family fires.
`FULLY covered` = at least one sample and no hole larger than
`3 x intervalSec` (including the two boundaries).

> **TWO different `x intervalSec` criteria — do not confuse them.** (a)
> **Liveness FRESHNESS** (§6, about the SAMPLER): the series is alive if the last
> row is within **`2 x intervalSec` = 90 s**; beyond **`3 x` = 135 s** it is
> INVESTIGATE (restart via the unit). (b) **Window COVERAGE** (this §4, about a
> CALL): a verdict may be FLAT only if the call window hides **no hole larger
> than `3 x intervalSec` = 135 s**. In practice: (a) answers "is the sampler
> alive right now?" — the criterion the custodian job applies; (b) answers "may
> THIS window's verdict be trusted?" — a perfectly healthy sampler can still
> leave a hole inside a window, and a hole makes a NEGATIVE verdict
> INSUFFICIENT, never "flat".

**INSUFFICIENT** — no verdict. Either **no sample at all** in the window
(before the sampler's first row / after its last row / a hole), or **no signal
but partial coverage**: a hole could hide the pressure. A **POSITIVE signal
always wins over a hole** (pressure is not invented by a gap); a **NEGATIVE** one
requires full coverage.

### 4.1 What each verdict MEANS (the sentence that decides)

- **FLAT ⇒ the machine is NOT the cause.** The lateness is in the **delivery /
  queue machinery**: the tool's return waits on the wake/settle chain, not on a
  starved CPU. **Widening the box would not have helped.** Next step (the QD's,
  §4 of their norm): cross-check `<stateDir>/deliveries.jsonl` for the held
  `(messageId, recipientId)` pair of that call.
- **PRESSURE (contention) ⇒ the box was BUSY, NOT SHORT.** Part of the latency
  is scheduling contention, but `psi.cpu.full = 0 %` and the runqueue stayed
  under the capacity threshold, so **enlarging the box is not supported by this
  datum**. The reading prints the **ARITHMETIC BOUND**: even attributing the
  whole window stall share to the call leaves most of the latency unexplained by
  host stall (e.g. 8,9 % x 212 s ≈ 19 s of a 212 s call).
- **PRESSURE (capacity) ⇒ the machine IS a plausible contributor.** The named
  metric + its peak sample is the basis for sizing (or for moving the work out
  of the window).
- **INSUFFICIENT ⇒ the datum decides NOTHING.** Do not read it as "flat".

### 4.2 Reading discipline (fb-137: no number without its instant and population)

1. The pairing is **by `id`** (`kind: intent` ↔ `kind: settle`), never by order
   or timestamps alone — the method is the QD norm §3, which is the source of
   truth. `unpaired` intents are reported as their own number (a call with no
   settle is not "0 s").
2. A `settle.status = aborted` means the turn was CUT: the duration is a **lower
   bound on the wait**, not a completed latency. Print it with the verdict.
3. PSI `avg60` is an **exponentially-weighted** window, so for a short call
   prefer the **`totalUs` delta** the reporter also prints
   (`psi cpu some X %`): it is the EXACT average over the covered window.
4. `daemon.rssKb` and `swapUsed` are **evidence**, not criteria: a 2 GB RSS on a
   7,9 GB host is worth naming, but the criterion is the stall/queue list above.

### 4.3 AMENDMENT RECORD (2026-09-10 — the first live run corrected the criterion)

The v1 criterion (a single `PRESSURE` class: `cpu.some.avg60 >= 5 %`,
`io.some.avg60 >= 5 %`, `memory.some.avg60 >= 1 %`, sustained
`load1/nproc >= 2`, `MemAvailable` drop >= 10 %) fired **PRESSURE on 9 of the
first 9 covered calls** of the 15:51-16:01Z burst — with `psi.cpu.full = 0,00 %`
in every one of them and `load1/nproc` between 0,51 and 0,66. That is a box with
**idle capacity**, so a criterion that answers "widen it" there is wrong: the
v1 threshold read a **scheduling-contention** datum as a **shortage**.

The amendment does not hide anything: every signal is still reported (and a
v1-style `PRESSURE` is still emitted for `psi.cpu.some`), but the **reading is
classed** — `cpu.some` alone and a bare `MemAvailable` dip became **CONTENTION**
(no sizing verdict), and the capacity family was anchored on `full`, on the
sustained runqueue, on memory/IO stall and on the corroborated reclaim. Lesson
for the next tuning: a `some`-based threshold must always be read together with
`full` and with `load/nproc`, because `some` counts "at least one task waited",
which on 4 cores and ~300 processes happens on a healthy box.

### 4.4 THE BOUND (threshold-independent — the criterion that always decides)

A threshold answers "is the host short?"; it does not answer "could the host have
caused THIS 234 s wait?". The reporter therefore prints, for every call, the
**BOUND**:

```
bound = max over resources of the WINDOW-EXACT PSI share (from the totalUs delta)
hostStallBoundSec = bound% x call duration
```

Even granting that the **whole** stall share belonged to this call, the host's own
stall explains at most `hostStallBoundSec` of it. Read it as:

- **bound < 25 % of the call** ⇒ the host CANNOT explain the latency, whatever
  the class: the answer to "would a bigger box have helped?" is **no**, and the
  work continues in the delivery/queue machinery.
- **bound >= 25 %** ⇒ the host is a first-order suspect (the capacity class then
  tells you which resource).

This is the only reading that survives threshold tuning, and it is why the
capacity class prints `NOTE: the bound is small — the signal is REAL but it
cannot account for most of the latency` when it fires with a small bound (the
2026-09-10 live case: `psi.io.full.avg60 = 1,05 %` on a 260 s call = **2,7 s**).

### 4.5 COMPUTE vs WAIT — the daemon's own CPU over the window

`daemon.cpuTicks` (utime+stime of the daemon process, USER_HZ = 100) turns the
"machinery" reading into a measurable: the reporter prints the daemon's CPU
seconds over the window and its **core share** (`ΔcpuTicks/100 ÷ Δwall`).

- **ratio near or above 1,0** ⇒ the daemon's own COMPUTE saturated its single
  JavaScript event loop (a Node process can only ever hold ONE core in that loop;
  the excess is the libuv pool + V8 GC). The box may still be idle, and the tool
  call still queues behind the loop ⇒ the fix is *inside the daemon* (what it
  spends the loop on: GG/GC, ledger writes, wake fan-out) — **not** more cores.
- **ratio near 0** ⇒ the daemon was WAITING: the latency is in the wake/delivery
  chain or in a network call.

Measured 2026-09-10 (the live case): `ps -o time` for the unit's pid showed
**15 s of CPU per 10 s of wall (1,5 core)**, lifetime average `%cpu` **111**, and
the JSONL delta **59,1 s / 45 s = 1,31 core** — one process eating ~1,3 of the
4 cores, i.e. most of the box's used CPU, while `psi.cpu.full` stayed at 0,00 %.

## 5. The recipe (the command the owner asked for)

```bash
# For every call of the three carrier tools slower than 60 s in the last 2 h,
# print the host state in +/-60 s AND the verdict:
node scripts/host-slowcall-correlate.mjs --since 2h --min 60 --window 60 --top 5
# ONE known call id:
node scripts/host-slowcall-correlate.mjs --call call_00_ABCD...
# every tool (incl. dept_exec/bash, whose long tail is the interpretable baseline):
node scripts/host-slowcall-correlate.mjs --tool any --min 60 --top 10
# machine-readable:
node scripts/host-slowcall-correlate.mjs --json
```

It prints, per call: tool, duration, settle status, caller -> recipients, the
window and its coverage, the PSI/load/memory **peaks**, the window-exact PSI
percentages, the daemon RSS and swap deltas, then `VERDICT` + the reading.
`--tool any` is deliberate: `dept_exec`/`bash` long tails are legitimate work and
are what makes the others interpretable.

## 6. Maintenance

- **Liveness (the protocol, in this order):** (1) `systemctl is-active
  dsh-host-sampler` = the **PRIMARY** life signal; (2) **freshness of
  `<stateDir>/host-health.jsonl` is the truth of the SAMPLING** (one row per
  tick): last row `<= 2 x intervalSec` (90 s) = **HEALTHY**, `> 3 x` (135 s) =
  **INVESTIGATE** — this is criterion (a) of §4; (3) the pidfile must name a
  **live** pid matching the unit's MainPID (anti-double-sampler); (4) the log
  line is **AUXILIARY** (a heartbeat every ~20 ticks, §2) — its age is not
  evidence of death. **The LIFE is guaranteed by the unit's `Restart=always`;
  the custodian job (every 6 h) VERIFIES it and, when the pidfile names a DEAD
  pid while the unit is `active`, restarts via `systemctl restart
  dsh-host-sampler`** — the §2 manual launch is the LAST RESORT (a manual launch
  with a live sampler is REFUSED by the script's anti-double-sampling guard).
- **Never** point it at the stable profile `/opt/dsh/.dsh` (out of scope) and
  never at the web profile: the target is the DEV deployment (`--profile
  deepartments-dev`, `--state-dir /.deepartments`).
- **Cost:** one `/proc` read set + one `statfsSync` + a 15-minute `du`-equivalent
  walk per tick; the documented `tickMs` field is the observable overhead
  (single-digit ms on this host).
