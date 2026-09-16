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
| `dsh-host-sampler.service` | `Restart=always` + `RestartSec=15` + **`StartLimitIntervalSec=0` (NO start limit ⇒ the unit retries indefinitely and is self-repairing; the recipe needs NO `systemctl reset-failed`)**, `User=root`, `WorkingDirectory=/home/esuarez/projects/deepartments`, `ExecStart=/usr/bin/node scripts/host-sampler.mjs --state-dir /.deepartments --interval 45 --quiet --log /.deepartments/host-sampler.log`, stdout+stderr `append:`ed to that same log, and **MainPID in its OWN cgroup** `/system.slice/dsh-host-sampler.service` |

The failure this closes: the sampler used to live inside the
`dsh-deepartments-dev.service` cgroup (`KillMode=control-group`), so **every
restart of the daemon SIGTERMed it** — 4 measured deaths in 71 min and
**69,7 min of blindness (48,8 % of the span)**. The unit's own cgroup covers
**100 % of those measured deaths**.

**No start limit (correction of 2026-09-10 — the unit used to declare
`5/300 s`):** with `StartLimitIntervalSec=0` the unit **self-repairs** — a start
that fails is retried every `RestartSec=15` **indefinitely** and the unit never
latches into `failed`, so the rescue recipe needs **no `systemctl reset-failed`**
(and must not rely on `failed` as its trigger — see §6).

Read it back on the **SERIES**, never on the log: `systemctl is-active
dsh-host-sampler` **== `active`** (PRIMARY life signal — a **STRICT EQUALITY**
test: `failed` **or `activating`** is NOT alive, see §6 for the reason) · `cat
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
| `daemon.{unit,profile,pid,rssKb,vmSizeKb,threads,state,cpuTicks}` | the `node` process of the unit `dsh-deepartments-dev` (`/proc/<pid>/status` VmRSS, `/proc/<pid>/stat` utime+stime); `null` = not resolvable this tick |
| `daemon.pressure.{source,usedMb,ceilingMb,usedPct,level}` | **THE HEAP BAND** — §4.6. `source` = `heapUsed` (the daemon's OWN heap, relayed from its `health-heartbeat.json`) or `rss-upper-bound` (`rssKb` = VmRSS, an **upper bound** on the heap). **ABSENT when there is no reading — never a `null` slot** (§4.7) |
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

### 4.6 THE HEAP BAND (2026-09-16 — the V8 OOM, and the ceiling that is NOT 5,8 G)

**What it is for.** On **2026-09-16T14:43:47Z** the daemon died with
`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of
memory` → `status=6/ABRT` → systemd relaunched at 14:45:11Z. The host's
question ("is the server too small?") was answered **post-mortem**, because
`host-health.jsonl` published `rssKb`/`vmSizeKb`/`threads` and **no memory
band at all** → ficha **`fb-1587`**. This subsection is the band.

**The ceiling — and the number that must NOT be used.** The band is read against
**V8's own `heap_size_limit`**, which on this host is:

```
$ node -e "console.log(require('v8').getHeapStatistics().heap_size_limit/1048576)"
2096.0        # node v22.23.2, os.totalmem() = 7,57 GB; no --max-old-space-size,
              # no NODE_OPTIONS in the unit or its 6 drop-ins
```

**2.096 MB — NOT 5,8 G.** The **5,8 G** systemd prints for the unit is the
**CGROUP `MemoryPeak`** (page cache + native memory included), **not the heap**.
The distinction is not pedantic, it is the whole defect: at the FATAL the
daemon's `VmRSS` was **3.261 MB = 156 % of the 2096 MB ceiling**, so a band
computed against 5,8 G would have read **56 % — `NORMAL` — at the very instant
the process was dying.** A threshold that ignores the real ceiling does not warn
late; it never warns.

| term | value | why |
|---|---|---|
| `ceilingMb` | **2096 MB** (`HEAP_CEILING_MB`), or the daemon's own `limit` when it publishes one | V8's `heap_size_limit`: the hard wall. **The CGROUP peak is NOT a ceiling** |
| `usedMb` | the daemon's heap when relayed; else `rssKb / 1024` | see §4.7 — **RSS ≥ V8 heap**, always |
| `usedPct` | `usedMb / ceilingMb x 100` | compared **unrounded**; the rounding is for the reader, not the decision |
| **`WARN`** | `usedPct >= 80 %` (**1677 MB**) | the "act soon" line |
| **`CRITICAL`** | `usedPct >= 90 %` (**1886 MB**) | the "this daemon can die with `Reached heap limit`" line |
| `NORMAL` | `< 80 %` | silent |

**The reading rule (what is NORMAL, what is INVESTIGATE).**

- **`NORMAL` (< 80 % of the ceiling)** — no action. **`NORMAL` is NOT a clean
  bill of health:** the daemon's RSS on this host has sat **≥ 2096 MB in 73,7 % of
  the 11.493 samples** of the 6-day series, so a band that only looks at the top
  of the range is looking at a chronic condition, not an incident.
- **`WARN` (>= 80 %) ⇒ INVESTIGATE.** Name the incarnation (`daemon.pid`) and
  read `daemon.cpuTicks` (§4.5) next: heap near the ceiling **with the loop
  saturated** is the OOM lane (§4.5's `ratio near 1,0`), not a sizing lane.
- **`CRITICAL` (>= 90 %) ⇒ INVESTIGATE, and expected within hours-to-minutes.**
  Measured on the fatal incarnation (`pid 1191415`, 17,0 h): it crossed **80 %
  16,8 h** and **90 % 16,4 h** before its last sample — i.e. the band would have
  been open **~16 h before the crash**, and the crash itself was a **puntual
  event on an already-saturated base** (Mark-Compact freed 0,1 MB of 2027 MB: a
  periodic message blew a heap that was 99,6 % live).
- **The band's alert is written to `host-sampler.log`** (`HEAP CRITICAL ...`)
  **once per crossing** — never once per tick. The AUTHORITATIVE record is the
  sample's `daemon.pressure`; the log line is the notification. See §4.6.1.

**WHY THERE IS NO "GROWTH" BAND — measured, not assumed.** The obvious second
rule (a MB/h rate) would have **failed on the exact incident it was written
for**: over the fatal incarnation, a `>= 3000 MB/h` rule on a 30-minute
lookback fired **0 times in 1.361 samples**, because that daemon reached
**2.446 MB in its first 3 h and then sat on a plateau** (2.67-2.81 GB for 12,5 h)
before the puntual event killed it. Calibrated against the healthiest measured
plateau (`pid 810027`, 62,8 h lived, h12-30: 1.440 samples) a 12-sample (~9 min)
window at a sane threshold carries a **1,05 % false-positive rate** while a
40-sample (~30 min) window carries **0,00 %** — so a growth rule is *feasible*
(>= 3000 MB/h, 30-min lookback: 1 false positive in 11.504 samples), but it is
**not what saves the daemon**. **A ceiling event needs a LEVEL band; adding a
growth band would raise the alert count without covering the incident.** If one
is ever added it must be justified by a case this band missed — not by symmetry.

#### 4.6.1 The consumer: WHO warns the host

**The path is real and already proven — there is no new mechanism here.**

1. **Every sample** carries the level in `daemon.pressure` (`host-health.jsonl`).
   That is the record a reader (or a human) opens for *when* the daemon was
   near its ceiling — the datum `fb-1587` asked for.
2. **The crossing is announced** on the lane's own bounded log,
   `<stateDir>/host-sampler.log`, via the same `logLine` seam every other
   sampler event already uses (`scripts/host-sampler.mjs`, `tick()`): one line
   per crossing, and one `HEAP NORMAL again` when it clears.
3. **The human/agent channel is the `host-sampler` custodian job** (every 6 h,
   `docs/departments/internal-programming/jobs/host-sampler.md`), which already
   reports to the Internal Programming Head and is the **only** reader that
   turns this series into a message. **A crossing must be reported there like a
   dead sampler is** — that is the escalation, and it needs no invention.

**What this lane must NOT do:** write `<stateDir>/health-alerts.jsonl`. That
file is **`dshd-health`'s** (`packages/dshd-health/src/index.ts`: its audit cap,
its `health-alerts-state.json` dedupe ledger, its host notification). The
sampler is a **separate OS process with no daemon context**; writing into that
ledger from here would forge another component's audit trail and bypass its
dedupe. **It is also structurally out of reach: `dshd-health` never reads
`host-health.jsonl`** (0 matches in `packages/dshd-health`), so nothing there
would see the sampler's number even if the sampler wrote it. The relay is the
custodian job, by design.

### 4.7 WHERE THE HEAP DATUM CAN BE BORN (and why it is not reachable from this lane)

**This is the finding that decides the design, and it is a hard technical limit,
not a preference.**

**`heapUsed`/`heapTotal` are RUNTIME datums.** They come from
`process.memoryUsage()` **inside** the process. **`/proc` has no such field** —
it is a **KERNEL** interface that describes **process** memory, and `VmRSS` is a
different (and larger) quantity. Measured on this host:

| what | value | source |
|---|---|---|
| heap ceiling | **2096 MB** | `v8.getHeapStatistics().heap_size_limit` |
| daemon RSS **at the heap FATAL** | **3261 MB** (= 156 % of the ceiling) | `host-health.jsonl`, `pid 1191415`, 14:45:01Z |
| daemon RSS that **never** died of the heap | **3917 MB** (= 187 % of the ceiling) | `pid 810027`, 62,8 h lived |

**⇒ An external reader can NEVER say "the heap is at X".** Two daemons with the
same RSS can have heap at 40 % or at 95 %; and the one that died had **less** RSS
than one that survived 62,8 h.

**Measured reachability, one line per route:**

| route | verdict | evidence |
|---|---|---|
| **V1** any `/proc` file | **NO** — no V8 heap field exists | `parseProcStatus` reads `VmRSS`/`VmSize`/`Threads`/`State` only |
| **V1** `/proc/<pid>/smaps` | **NO — and it is a trap**: it gives the PROCESS's memory (per-mapping RSS/Pss), **not the V8 heap** | same `/proc` surface as VmRSS; a larger heap does not map to a larger `smaps` row |
| **V1** V8 inspector (port 9229 / `--inspect`) | **NO** — nothing is listening | `ss -ltnp`: the daemon (pid 1314627) owns only `127.0.0.1:3090` and `127.0.0.1:4097`; **no 9229** anywhere on the host; `--inspect`/`NODE_OPTIONS` appear in **no** unit and no drop-in |
| **V1** HTTP/metrics endpoint | **NO** | `/api/health`, `/api/status`, `/health`, `/metrics` on :3090 all **404** |
| **V1** `writeHeapSnapshot` / heap snapshot | **NO** — and it is a **write inside the daemon** | 0 matches in the tree (V3); it requires code inside the process |
| **V2** the daemon publishes it itself | **YES — the only route** | `writeHealthHeartbeatFile` (`packages/dshd-health/src/index.ts:611-613`), called from inside the health tick at `:7667`, writes `<stateDir>/health-heartbeat.json` |

**WHAT THIS LANE DOES ABOUT IT (already implemented, no scope extension
needed for the band):** the sampler **relays** the datum when the daemon
publishes it. `readHeartbeatHeap()` reads `heapMb` from
`<stateDir>/health-heartbeat.json` and the band is then computed over the
**daemon's own heap** (`source: 'heapUsed'`). **Until the daemon publishes it,
the band runs on `rssKb` (`source: 'rss-upper-bound'`)** — an **upper bound**
on the heap (RSS ≥ heap), which can therefore warn **early or unnecessarily,
never late**. **The relay is the whole handoff: this lane needs NO change to
receive the datum.**

**THE PIECE THAT MUST BE ASKED FOR OUTSIDE THIS LANE (declared, NOT
implemented here).** One file, three additions, in
**`packages/dshd-health/src/index.ts`** — *outside this lane; the head and the
host decide*:

1. **`:506` — the `HealthHeartbeat` interface:** add one optional field, in
   the same "ABSENT → the tick never guesses" style the other optional fields
   already use:
   ```ts
   /** The daemon's OWN V8 heap, MB (process.memoryUsage(): heapUsed/heapTotal,
    * and v8.getHeapStatistics().heap_size_limit). The ONLY place this datum can
    * be born: it is a RUNTIME datum and no external reader can obtain it from
    * /proc. ABSENT → unreadable. */
   heapMb?: { used: number; total: number; limit: number }
   ```
2. **`:7667` — the `writeHealthHeartbeatFile(...)` object:** one spread, the
   exact pattern of the lines already there:
   ```ts
   ...(heapMb() !== undefined ? { heapMb: heapMb() } : {}),
   ```
   (resolve it once into a local, the way `gatedIdleHeld` is resolved above.)
3. **The producer** — a tiny helper next to the other health datums:
   ```ts
   const m = process.memoryUsage()
   const limit = (await import('node:v8')).getHeapStatistics().heap_size_limit
   return { used: Math.round(m.heapUsed / 1048576), total: Math.round(m.heapTotal / 1048576), limit: Math.round(limit / 1048576) }
   ```

**`used`/`total`/limit MB, integers: no secret, no content, and `fb-16`-clean.**

**One caveat the head must weigh, measured:** the heartbeat file is written
**non-atomically** (`writeFile`, not tmp+rename) and the sampler reads it
**every 45 s**. A torn read is therefore possible and was **observed** while
measuring this report; `readHeartbeatHeap()` handles it (`null` → the band
falls back to RSS for that tick, no error, no hole). **If the daemon adopts this
field, an atomic write (tmp + rename, the pattern `rotateIfNeeded` already uses
in this lane) is worth requesting at the same time** — otherwise a tick can
silently lose the datum it was added for.

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
  dsh-host-sampler` = the **PRIMARY** life signal, and it is read as a **STRICT
  EQUALITY to `active`** — `is-active` **== `active`**, **NEVER** "it is not
  `failed`" and **never** "it is not inactive". **The reason is
  `StartLimitIntervalSec=0` (§2):** with NO start limit a unit in a
  pathological restart loop does **not** read `failed` — it reads
  **`activating`** (the auto-restart state) — so a lax check would report
  **ALIVE** a sampler that has not started for hours. Hence **`activating` OR
  `failed` ⇒ INVESTIGATE**, and the **fine discriminator is the FRESHNESS OF
  THE SERIES** (item (2) below: `<stateDir>/host-health.jsonl`
  `<= 2 x intervalSec` = 90 s), which is what says whether it is really
  SAMPLING; (2) **freshness of
  `<stateDir>/host-health.jsonl` is the truth of the SAMPLING** (one row per
  tick): last row `<= 2 x intervalSec` (90 s) = **HEALTHY**, `> 3 x` (135 s) =
  **INVESTIGATE** — this is criterion (a) of §4; (3) the pidfile must name a
  **live** pid matching the unit's MainPID (anti-double-sampler); (4) the log
  line is **AUXILIARY** (a heartbeat every ~20 ticks, §2) — its age is not
  evidence of death. **The LIFE is guaranteed by the unit's `Restart=always`
  with `StartLimitIntervalSec=0` (self-repairing: a failed start is retried
  every `RestartSec=15` indefinitely and the unit never latches into `failed`,
  so the recipe needs NO `systemctl reset-failed`); the custodian job (every 6 h)
  VERIFIES it and, when the pidfile names a DEAD pid while the unit is `active`,
  restarts via `systemctl restart dsh-host-sampler`** — the §2 manual launch is
  the LAST RESORT (a manual launch with a live sampler is REFUSED by the
  script's anti-double-sampling guard).
- **Never** point it at the stable profile `/opt/dsh/.dsh` (out of scope) and
  never at the web profile: the target is the DEV deployment (`--profile
  deepartments-dev`, `--state-dir /.deepartments`).
- **Cost:** one `/proc` read set + one `statfsSync` + a 15-minute `du`-equivalent
  walk per tick; the documented `tickMs` field is the observable overhead
  (single-digit ms on this host).
