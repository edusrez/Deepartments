---
title: WHERE TO LOOK — the routing index of this deployment
owner: internal-programming-head
verified_at: 2026-09-22T16:20:07.073Z
verified_commit: 51204e60
verified_by: organizer-7 (run 4ba60dc5, LANE W7-DOCS)
anchors:
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:761
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:839
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:845
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:3525
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:3856
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:3858
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:3743
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:418
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:3543
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:3870
  - /home/esuarez/projects/dsh-key-pooler/src/proxy.ts:4016
  - /home/esuarez/projects/dsh-key-pooler/src/config.ts:232-300
  - /home/esuarez/projects/dsh-key-pooler/src/config.ts:292
  - /home/esuarez/projects/dsh-key-pooler/src/config.ts:530
  - /home/esuarez/projects/dsh-key-pooler/src/state.ts:4
  - /home/esuarez/projects/dsh-key-pooler/src/index.ts:116
  - /home/esuarez/projects/dsh-key-pooler/src/balance-meter.ts:6
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:5405
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:5500
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:8784
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:10185
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:10205
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:1082
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:1330
  - /home/esuarez/projects/deepartments/packages/dshd-health/src/index.ts:197
  - /home/esuarez/projects/deepartments/packages/dshd-orchestration/src/tools.ts:6133
  - /home/esuarez/projects/deepartments/packages/dshd-orchestration/src/tools.ts:6164
  - /home/esuarez/projects/deepartments/packages/dshd-orchestration/src/tools.ts:6211
  - /home/esuarez/projects/deepartments/packages/dshd-orchestration/src/tools.ts:6219
  - /home/esuarez/projects/deepartments/packages/dshd-orchestration/src/tools.ts:6275
  - /home/esuarez/projects/deepartments/packages/dshd-orchestration/src/tools.ts:2451
  - /home/esuarez/projects/deepartments/packages/dshd-core/src/messages.ts:187
  - /home/esuarez/projects/deepartments/packages/dshd-core/src/messages.ts:141
  - /home/esuarez/projects/deepartments/packages/dshd-core/src/messages.ts:1142
  - /home/esuarez/projects/deepartments/packages/dshd-core/src/messages.ts:1031
  - /home/esuarez/projects/deepartments/packages/dshd-core/src/messages.ts:698
  - /home/esuarez/projects/deepartments/packages/dshd-jobs/src/index.ts:278
  - /home/esuarez/projects/deepartments/packages/dshd-jobs/src/index.ts:296
  - /home/esuarez/projects/deepartments/packages/dshd-jobs/src/index.ts:305
  - /home/esuarez/projects/deepartments/packages/dshd-core/src/delivery.ts:324
  - /home/esuarez/projects/deepartments/packages/dshd-orchestration/src/delivery.ts:3194
  - /home/esuarez/projects/deepartments/src/invoke.ts:4256
  - /home/esuarez/projects/deepartments/src/invoke.ts:5299
  - /etc/systemd/system/dsh-deepartments-dev.service:7
  - /etc/systemd/system/dsh-deepartments-dev.service:11
  - /etc/systemd/system/dsh-deepartments-dev.service:12
  - /etc/systemd/system/dsh-deepartments-dev.service.d/zz-execstart.conf:20-21
  - /etc/systemd/system/dsh-deepartments-dev.service.d/resilience.conf:29-35
  - /etc/systemd/system/dsh-deepartments-dev.service.d/resilience.conf:55-73
  - /etc/systemd/system/dsh-deepartments-dev.service.d/crash-breaker.conf:5
  - /home/esuarez/projects/deepartments/.gitignore:7
  - /home/esuarez/projects/deepartments/docs/VERIFICATION-LADDER.md:584-606
---

# WHERE TO LOOK

**Read this page first.** It answers three questions — *where is X implemented?*,
*which service does Y?*, *how do I verify Z?* — so a reader does **not** sweep the
tree with `grep`/`glob`/`find` to find out where they are. Two linked pages are
covered by the acceptance criterion of this page; both are named in §0.

**This page does not duplicate any register.** The work queue, the quality
backlog, the roadmap and the store topology are linked in §7, never copied.

## ⚠️ Read this before trusting any line number below

**A line number is a perishable anchor; a SYMBOL is a durable one.** While this
page was written (2026-09-22, ~16:20Z) two of its source files were being edited
LIVE by other lanes, and the anchors moved under the author **three times**:

| File | Was | Became | Lanes in flight |
|---|---|---|---|
| `packages/dshd-orchestration/src/tools.ts` | 8037 lines | 8100+ lines | W9 |
| `packages/dshd-health/src/index.ts` | 10694 lines | 10880+ lines | W3 |

Measured displacements, same session: `scanPoolerCapacity` `:5307` → `:5394` →
`:5405`; the `pooler-capacity` render `:8620` → `:8767` → `:8778` → `:8784`;
`notifyHost` `:10021` → `:10168` → `:10199` → `:10205`. **The numbers below are
the positions MEASURED at `verified_at`; the SYMBOL is what you should search
for.** If a number is off by a few lines, the symbol is still right and
`doc-drift` (`docs/DOC-DRIFT.md`) will have flagged the page.

**For any row below, the robust verification is:** read the file, find the
SYMBOL, then check the claim against that line — not against the number.

## 0. The first hop (if the table below doesn't cover your question)

| Need | Page |
|---|---|
| The org's runtime stores, and which tree is canonical | `docs/STORES-MAP.md` |
| Which instrument is blind to what (and the tie-break rule) | `docs/VERIFICATION-LADDER.md` §11.5 |
| Incidents already diagnosed: symptom → forensic map → root cause | `docs/departments/internal-programming/INCIDENT-PLAYBOOK.md` |
| How this repository must be worked on (suite ladder, language policy, commit flow) | `AGENTS.md` |

**Do not read these while looking for code truth:** they are queues or designs,
not the implementation — `docs/ROADMAP.md` (phases), `docs/WORK-REGISTER.md`
(work queue), `/.deepartments/feedback.jsonl` (quality backlog). Their source of
truth is the register itself; this page links them (§7).

## 1. The key pooler — `dsh-key-pooler`

Repo `/home/esuarez/projects/dsh-key-pooler` (NOT inside `deepartments`). The
pooler decides which upstream key serves a turn, and which channel is *dead*.

| Topic | Symbol (durable) | Line at `verified_at` | Verify with |
|---|---|---|---|
| Classify one channel error into a verdict | `classifyChannelError` | `src/proxy.ts:761` | `read` the file at 761 and check the ordered branches |
| The request-side exemption is **one datum**, not a predicate at the call site | `REQUEST_SIDE_CHANNEL_CLASSES` | `src/proxy.ts:839` | `read` at 839 |
| Is a verdict request-side? | `isRequestSideChannelClass` | `src/proxy.ts:845` | `read` at 845 |
| Where the request-side class is recorded per leg | (assignment to `lastRequestSideClass`) | `src/proxy.ts:3525` | `read` at 3519-3526 |
| Where the exemption is consumed, per slot | (the `skip` branch) | `src/proxy.ts:3856-3866` | `read` at 3846-3879 |
| The request-side TERMINAL (answers once, never a balance report) | `KeyPoolerRequestRejected` | `src/proxy.ts:3743-3768` | `read` at 3743-3768 |
| Halting a channel: the write seam | `setChannelHalted` | `src/proxy.ts:418` | `read` at 410-438 |
| The TWO halt causes already declared | `'billing'` / `'no-serve'` | `:3543` / `:3870` | `read` those lines |
| The vocabulary (signatures, statuses) | `DEFAULT_REQUEST_REJECTED_VOCAB` | `src/config.ts:232-300`, default at `:292` | `read` at 292-300 |
| The state file name (relative; resolved against DSH home) | `stateFile: 'keyPooler-state.json'` | `src/config.ts:530`; resolution `src/index.ts:116` | `read` those lines |
| The state file's purpose, in one line | (module docstring) | `src/state.ts:4` | `read src/state.ts` at 1-8 |
| Who else reads the state | `readState` | `src/balance-meter.ts:6`; health scan §2 | `read` those lines |

**Measured consequence (2026-09-22, the incident this lane exists for):** with
ZERO eligible Go keys, a request-side verdict used to be charged to the channel's
fail window and suspended a measurably SANE channel; the suspension diverted
traffic to the official channel and reported a balance nobody had reported. The
exemption is deliberately `skip` — it neither charges NOR resets.

**How to verify a live pooler fact:** read
`<DSH_HOME>/keyPooler-state.json` (in DEV: `/opt/dsh/.dsh-dev/keyPooler-state.json`).
The file is written ONLY on health changes, so an old `updatedAt` is UNKNOWN, not
broken (§2). Recovery triggers for a halted channel are `SIGHUP` and
`POST /__keypool/revalidate`.

## 2. Health and the gates — `packages/dshd-health/src/index.ts`

> ⚠️ **In flight when this page was written (W3).** Symbols first; the lines are
> the `verified_at` positions and they moved three times in one session.

| Topic | Symbol (durable) | Line at `verified_at` |
|---|---|---|
| Scan the pooler's capacity | `scanPoolerCapacity` | `:5405` |
| The stale early-return (stale ⇒ UNKNOWN, **no** finding) | `const stale = …` + the warn + `return []` | `:5500-5511` |
| Render the alert line | `if (finding.kind === 'pooler-capacity')` | `:8784` |
| Which findings get alerted | `const findingsToAlert = findings.filter(…)` | `:10185` |
| The host notification (**the alert IS this call**) | `await deps.notifyHost(live, buildHealthAlertFrame(…))` | `:10205` |
| The audit append | `await appendHealthAlertAudit(deps.stateDir, …)` | `:10265` |
| The dedupe ledger key → lastAlertedAtMs | `readHealthAlertsState` | `:1082` |
| The audit writer + the audit file path | `appendHealthAlertAudit` / `path.join(stateDir, 'health-alerts.jsonl')` | `:1330` / `:1331` |
| The audit cap | `HEALTH_ALERTS_MAX_LINES = 500` | `:197` |

**Two traps measured here:**

- **`health-alerts.jsonl` is an AUDIT, not a feed.** Its only writer is
  `appendHealthAlertAudit`; no consumer reads it back. Its cap is 500 lines and
  the append is read-modify-write, so it is **not** append-only. ⇒ *The alert the
  host receives is the `notifyHost` call; if you are looking for "did we alert?",
  read the dedupe ledger and the delivery of that call — not this file.*
- **A stale pooler snapshot yields NO finding on purpose.** Silence there is not
  a clean bill of health; it is UNKNOWN. (The same `unknown ≠ exhausted`
  discipline appears in the dispatch pre-check and the work-register-idle leg —
  three consumers, one honest default.)

## 3. The bus and delivery — `packages/dshd-core`, `dshd-orchestration`

| Topic | Symbol (durable) | Line at `verified_at` |
|---|---|---|
| The delivery sidecar name + location | `DELIVERIES_FILE` → `<stateDir>/deliveries.jsonl` | `packages/dshd-core/src/messages.ts:187` |
| The delivery states | `DeliveryStatus` | `:141` |
| What needs re-delivery | `needsRedelivery` | `:1031` |
| Write one transition | `markDelivery` | `:698` |
| The engine's sidecar seam | `DeliveryEngineDeps.stateDir` | `packages/dshd-core/src/delivery.ts:324`; wiring `packages/dshd-orchestration/src/delivery.ts:3194` |
| The mission scan that reads the sidecar | `readDeliveryRowsFull` | `src/invoke.ts:4256` |
| The health tick that scans it | (W6 daemon comment) | `src/invoke.ts:5299` |

### ⚠️ THE MEASURED TRAP (fb-913) — read this BEFORE citing a delivery row

**`deliveries.jsonl` is NOT append-only.** The G2 legacy settle rewrites
`prepared` rows to `terminal` **IN PLACE, keeping their `ts`** (documented in
`packages/dshd-core/src/messages.ts:1142`). Measured twice on
`/.deepartments/deliveries.jsonl` (12/12 rows, `m-7764`/`m-7772`).

Two consequences:

1. **The `ts` of a `terminal` row does NOT date the terminal.** A rewritten row
   keeps the timestamp of the *prepared* write-ahead; an appended one carries a
   new `ts`. Measured error window: ~51 min in one case.
2. **`pairConsecutiveAttemptCount` is not monotonic** — the flip REMOVES rows from
   the counter.

**Citation rule (mandatory):** to cite a delivery row you must give
**(file, line, `ts`, AND the instant you read it)**. Any of the four alone is a
non-reproducible anchor. Live instance: `fb-913` (open, `medio/fallo`, emisor
`internal-programming-head`).

## 4. Shared tools — `packages/dshd-orchestration/src/tools.ts`

> ⚠️ **In flight when this page was written (W9).** Symbols first.

| Topic | Symbol (durable) | Line at `verified_at` |
|---|---|---|
| The closed argument surface of `dept_feedback_update` | `FEEDBACK_UPDATE_EXPECTED_FIELDS` | `:6133` |
| The org validator | `feedbackUpdateArgsViolations` | `:6164` |
| The validator runs FIRST (zero side effects on reject) | `const violations = feedbackUpdateArgsViolations(…)` | `:6211` |
| Workers are rejected | `is for department HEADS … not a worker` | `:6219` |
| The empty-update door | `if (Object.keys(input).length === 0)` | `:6275` |
| Job execution (the entry point of a versioned job) | `name: 'dept_job_run'` | `:2451` |

**The two doors — the current, verified state.** Both are CLOSED:

1. **An UNDECLARED key is refused as a whole** — zero side effects, before any
   authority check. The fb-775 cure.
2. **A call declaring NONE of the write fields is refused** — the symmetric gap
   the whitelist left open (a call with `{id}` alone reached an empty
   `store.update` and returned normal: it confirmed what it did not do). This is
   fb-2112.

⇒ **Do not document "no key = open" as a live gate.** As of `verified_at`, it is
closed. Both doors live in the same validator so the contract is reported in ONE
message.

## 5. systemd units and drop-ins (RUNBOOK-lite)

The dev deployment's unit is `dsh-deepartments-dev.service`. **A worker cannot
run `systemctl` (denied by the `dept_exec` guard)** — everything below is read
from the files themselves, which IS the worker-accessible instrument.

| Fact | Where (verified file) | Verify with |
|---|---|---|
| The unit loads an environment FILE (never an inline secret) | `/etc/systemd/system/dsh-deepartments-dev.service:7` (`EnvironmentFile=/etc/dsh/dsh-deepartments-dev.env`) | `read` the unit |
| The unit runs with `WorkingDirectory=/` (this is WHY the stateDir resolves to `/.deepartments`) | unit `:11` | `read` the unit |
| The dev profile home | unit `:12` (`DSH_HOME=/opt/dsh/.dsh-dev`) | `read` the unit |
| Which drop-ins apply | `/etc/systemd/system/dsh-deepartments-dev.service.d/` — 8 files | `glob` that directory |
| The ExecStart is OVERRIDDEN to a release tree | `…service.d/zz-execstart.conf:20-21` | `read` that drop-in |

### ⚠️ THE INERT-KEY TRAP — this one already bit us

**A key placed in the WRONG SECTION is silently ignored by systemd.**

Measured (2026-09-21, `systemd-analyze verify`, systemd 255.4), recorded verbatim
in `…service.d/resilience.conf:29-35`:

- `StartLimitIntervalSec` is a **[Unit]** key. Placed in **[Service]** it is
  ignored ("Unknown key name … in section 'Service', ignoring") — so the
  crash-breaker's limiter (`crash-breaker.conf:5`) stayed ARMED while the file
  declared it disabled. The consequence was measured: 31 falls and, at 16:59:06,
  `Start request repeated too quickly` — **the org was left STOPPED**, exactly the
  failure mode the change claimed to have removed.
- `OOMPolicy` accepts only `continue|stop|kill`. `restart` **does not exist** and
  was ignored ("Failed to parse OOM policy, ignoring: restart").

**Verification rule:** never trust a drop-in's prose about its own effect. Read
the SECTION the key sits in, and prefer `systemd-analyze verify` (root) as the
instrument. The corrected state lives in `resilience.conf:55-73` (`[Unit]
StartLimitIntervalSec=0`, `[Service] Restart=always`, `OOMPolicy` deliberately
undeclared).

**Drop-in application order is ALPHABETICAL**
(`crash-breaker` < `resilience` < `zz-execstart`), so a later file WINS — that is
why `zz-execstart.conf` (the `ExecStart` switch) is named `zz-`.

## 6. Where NOT to look

This section saves more time than the five above.

| Not a source of truth for | What it actually is | The real source |
|---|---|---|
| what work is pending | `docs/WORK-REGISTER.md` is the work QUEUE (linked, not copied here) | the register itself |
| what defects are open | `/.deepartments/feedback.jsonl` is the quality BACKLOG (append-only tails) | the file + `dept_feedback_list` |
| what the plan is | `docs/ROADMAP.md` is a design/phase document | the roadmap itself |
| where data lives | `docs/STORES-MAP.md` is the topology correlato | that page |
| `lib/` (the deployed artifact) | **gitignored** (`.gitignore:7`) ⇒ **no git-based instrument sees it** | the build config, or a report that names the path |
| live effect of a systemd drop-in | its own comment header | `systemd-analyze verify` (§5) |

### Two measured instrument traps (do not re-learn these)

- **`grep`/`glob` without an explicit target do not see ignored or hidden paths**
  — canonical case: `lib/` (`.gitignore:7`). Measured, with the full blindness
  table and the tie-break rule, in `docs/VERIFICATION-LADDER.md:584-606`.
  **Tie-break: when two instruments disagree about EXISTENCE, `read` on a literal
  path wins.**
- **Discovery calls have a 30 s budget and fail ALL-OR-NOTHING.** Measured by the
  author of this page on 2026-09-22: a `grep` over a reports tree returned
  `Error: tool call timed out after 30000ms` with **no scope line and no partial
  result** (folded into `fb-1447` as `fb-2394`), and a `glob` with `path="/"`
  failed outright with `exit 2` because ONE transient
  `/tmp/departments-invoke-*` directory was already gone (filed as `fb-2398`).
  ⇒ **Narrow the path; name the file when you know it; use `read` with `offset`
  on the cited line.** A verification command that walks a big tree is not a
  verification command.

## 7. Linked registers (not duplicated here)

- Work queue: `docs/WORK-REGISTER.md`
- Quality backlog: `/.deepartments/feedback.jsonl` (+ `feedback-archive.jsonl`) — query with `dept_feedback_list`
- Roadmap: `docs/ROADMAP.md`
- Store topology: `docs/STORES-MAP.md`
- Verification convention: `docs/VERIFICATION-LADDER.md`
- Incident runbook: `docs/departments/internal-programming/INCIDENT-PLAYBOOK.md`
- Drift checking of THIS page: `docs/DOC-DRIFT.md`
