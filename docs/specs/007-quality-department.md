---
agent: builder
date: 2026-08-24
task: quality-department-spec
spec_ref: "Owner decisions (2026-08-24), Epic QD: the Deepartments organization gains a **Quality Department (QD)** — the QA/analysis counterpart of the Research Department (RD, spec 004) and the Internal Programming Department (IPD, spec 005). It OWNS nothing and FIXES nothing: every department head archive (a head's dept_sleep) AND every host session rotation (the Asistente's dept_sleep host branch) is INSPECTED at 100% (EXCEPT the Quality Head's own sleep, which is SAMPLED at the 10% worker dice — D-Q7), and every DISPOSABLE WORKER retire is INSPECTED with probability 0.10 (configurable, deterministic under a test seed / env override). Findings are REPORTED, never auto-fixed: the Quality Head (QH) reports to the Asistente AND auto-files a PROGRAMMING REQUEST to internal-programming-head (head↔head synergy). TWO analysis paths: (a) EVENT-DRIVEN — a new post-error record (spec 006 post-errors.jsonl capture) triggers a QD analysis directive to quality-head (with the error record); (b) A DAILY DIGEST JOB `quality-daily` (role quality-inspector, cron 0 8 * * *, owner quality-head, calendar entry departmentId=quality). ONE role — `quality-inspector` (ephemeral-per-round, W8-g lifecycle, Flash tier, literal model deepseek-v4-flash-vision-exp provider opencode-zen reasoning max, reports to `.dsh/reports/quality/<YYYY-MM-DD>-<slug>.md`). Primary sources: docs/specs/005-internal-programming-department.md (master style + departments/roles/jobs/ACL/phases), docs/specs/004-research-department.md (§0 owner table, §3 conceptual model, §7 personas, §9 open questions), docs/specs/006-system-health.md (the post-error capture seam, post-errors.jsonl, the daemon ALERT-to-host pattern, the daily digest job precedent), src/org.ts + src/invoke.ts + presets/ + .dsh/skills verified in-repo at spec time."
outcome: FINAL DRAFT (owner decisions adopted) — DRAFT-ONLY, no commit, no other files touched; DOCUMENTATION-ONLY (only docs/specs/007 created)
files_touched:
  - docs/specs/007-quality-department.md (this draft)
error_type: none (design doc — no build/test required)
key_findings:
  - The QD is a REPORT-ONLY department: it never repairs code, never spawns on its own (the hook only sends a bus directive to quality-head — quality-head orchestrates), and is deliberately SINGLE-ROLE (quality-inspector).
  - OWNER AMENDMENT (2026-08-25, M4 docs-only): the QH is the CONSOLIDATOR + ANALYZER (verdict per round "todo bien" / "issue X → dirigido a Y (Z)"; findings to the Asistente AND/OR a PROGRAMMING REQUEST → IPD, a RESEARCH REQUEST → RD, or the Asistente for an owner decision); the QH's sleep is governed AUTONOMOUSLY by the Asistente via the SLEEP DIRECTIVE (no request/approval — DISCARDED); and the QH's OWN sleep is SAMPLED at 0.10 (anti-loop D-Q7), not 100%.
  - The worker-archive dice (D-Q2) and the head/host 100% mandate (D-Q3) are the same event hook: `qualityInspectDecision(kind, deps)` — a PURE injectable-rng function where kind 'head' ALWAYS true EXCEPT 'quality-head' (D-Q7 dice — the QH's own sleep is sampled at the 0.10 worker dice), kind 'host' ALWAYS true, and kind 'worker' rolls `rng() < (workerInspectProbability ?? 0.10)`.
  - All three archive events have an EXISTING seam to hang the hook on (verified): worker retire dept_worker_retire → retirePost (invoke.ts:7593) + archiveWorkerSession (invoke.ts:7644); head dept_sleep head-branch → archivePostSessionOnSleep (invoke.ts:6779-6781/7667); host dept_sleep host-branch → runHostRotation (invoke.ts:9479, S2.5 archives the OLD host session).
  - The hook must NEVER throw and NEVER spawn; it emits an ADDRESSED QUALITY INSPECT directive to quality-head via the plugin's direct delivery seam (store.append + busDeliverToPost, the daemon notifyHead pattern), reusable because the hook fires inside plugin-internal functions (not the host send_message).
  - The QD inspector reports under `.dsh/reports/quality/` (stateDir/repo), NOT the department-workspace reports dir — per D-Q6, a deliberate divergence from RD/IPD.
---

# The Quality Department — design spec (Epic QD)

Status: **FINAL DRAFT — all decisions below are owner-approved (2026-08-24) and
are requirements, not proposals. Ready for builder dispatch (phases Q1–Q5, §8).**
**OWNER AMENDMENT (2026-08-25, docs-only M4):** the QD consolidation/analysis loop
(§3.5/§7.2 — the QH is the CONSOLIDATOR + ANALYZER, verdict per round), the QH's
autonomous sleep lifecycle (§7.2 — the Asistente manages head sleep; heads do NOT
request/approve sleep — the "request/approval" model is DISCARDED), and the
anti-loop QH inspect exception (D-Q7 — the QH's own sleep is SAMPLED at 0.10, not
100%).
`❓` marks owner-decision points (§9) and builder-verify points (implementation
detail, deferred to the builder). All harness/plugin file:line facts were verified
against the working tree at spec time. The exploration seam report
(`reports/explore-deep/2026-08-24-quality-seam-map.md`) is being produced by a
parallel explore worker and was **not present at spec time** — where a runtime
anchor is cited here it is a direct in-repo verification; the seam report is the
authoritative cross-check and is expected to name the same hooks with exact
file:line anchors. If a seam-map anchor differs, the seam report wins and this §5/§6
line refs are treated as design-level.

---

## 0. Owner decisions adopted (2026-08-24) — requirements, not proposals

| # | Decision | Baked in as |
|---|---|---|
| D-Q1 | **Naming.** Department id `quality`; name "Quality Department"; coordinator postId `quality-head`, title "Head of Quality", role "Quality department head", sessionTitle "Head of Quality"; head preset `deepartments-head-quality`; workspacePath `/root/.deepartments/departments/quality`; jobDir `docs/departments/quality/jobs`; spec `docs/specs/007-quality-department.md`. | §3.1, §7.4 |
| D-Q2 | **Random control (worker archive).** When a NON-head agent session is archived (a disposable WORKER retired via `dept_worker_retire`/`dept_post_retire`), wake a QD inspection with probability `0.10` — a configurable constant (default 0.10) in the org config (`quality: { workerInspectProbability?: number }`), testable deterministically via an injected seed / env override (`DEEPARTMENTS_QUALITY_INSPECT`-style env OR an injected rng so tests are deterministic). | §4, §5.2, §6.1 |
| D-Q3 | **Mandatory 100% (head + host) — with a single anti-loop exception.** EVERY head archive (a department head's `dept_sleep`, which archives the head session) AND EVERY host session rotation (the Asistente's `dept_sleep` host branch, which archives the OLD host session) is inspected at **100% — never gated by the dice** — EXCEPT the **Quality Head's own sleep**, which is SAMPLED at the 0.10 worker dice (D-Q7). The host counts as a "H" (head-equivalent). | §6.2, §6.3, §7.2 |
| D-Q4 | **Analysis of architecture errors — two paths.** (a) EVENT-DRIVEN: a new post-error record (the spec 006 system-health post-error capture, `post-errors.jsonl`) triggers a QD analysis directive to quality-head (with the error record); (b) A DAILY DIGEST JOB `quality-daily` (role `quality-inspector`, cron `0 8 * * *`, owner `quality-head`, calendar entry `departmentId=quality`) that consolidates patterns (post-errors, stalled posts, delivery failures, inspection results). | §6.4, §6.5 |
| D-Q5 | **Fix flow.** QD findings → report to the Asistente AND auto-request a PROGRAMMING REQUEST to `internal-programming-head` (head↔head synergy). QD does NOT fix directly. | §3.5, §6.6, §7.2 |
| D-Q6 | **Subagents — ONE role.** `quality-inspector` (ephemeral per round, W8-g lifecycle, Flash tier, model literal `deepseek-v4-flash-vision-exp` provider `opencode-zen` reasoning max, reports to `.dsh/reports/quality/<YYYY-MM-DD>-<slug>.md` — the stateDir/repo `.dsh/reports/quality/` path, NOT the department-workspace reports dir, per the owner decision). | §7.1, §7.2 |
| D-Q7 | **Anti-loop inspection (Quality Head only).** The head-sleep 100% mandate (D-Q3) EXCLUDES the quality-head: the QH's OWN sleep is inspected with the DICE 10% (`workerInspectProbability`), like a worker retire. Every OTHER configured head stays at 100%. Invariant: "QH sleeps each round" must NOT auto-feed inspections (no QH-sleep → q-i → QH-wake loop). | §6.2, §7.2 |

---

## 1. Context & Motivation

The organization already runs two durable, reporting-chain-clean departments:
the **Research Department** (spec 004, implemented) and the **Internal
Programming Department** (spec 005, implemented). Both are HEAD + WORKERS with a
strict "worker → head → host (Asistente)" reporting ACL and versioned
jobs. **There is no quality/QA layer.** Nothing observes *how the organization
itself behaves* — whether a retired worker left noise in the session logs,
whether a head's sleep or a host rotation left a stale artifact, whether a
recurring post-error pattern is a symptom of a real bug.

The owner wants (D-Q1–D-Q6) a **Quality Department** so that:

1. **Every lifecycle archive is a QA sample.** Worker retires are sampled
   (10% by default, D-Q2), head sleeps and host rotations are sampled 100%
   (D-Q3) — because a bad head/host archive is a *systemic* signal while a bad
   worker retire is a *noisy* one. (**Anti-loop D-Q7:** the Quality Head's OWN
   sleep is the one head sleep NOT sampled 100% — it is SAMPLED at the 0.10
   worker dice, so the QH's recurring per-round sleep never auto-feeds an
   inspection back into the QD.)
2. **The QD inspects and reports; it never fixes.** Findings go to the
   Asistente (the only one the QH reports to, §3.5) AND are auto-requested as a
   PROGRAMMING REQUEST to the internal-programming-head for the genuinely
   fixable ones (D-Q5).
3. **Architecture-error analysis is both event-driven and digested.** A new
   post-error record (spec 006) immediately triggers a QD directive (D-Q4a);
   a daily digest job (`quality-daily`) consolidates the week's patterns so the
   owner sees the shape, not just the spikes (D-Q4b).
4. **One precise role.** `quality-inspector` — read the archived session logs,
   find the signal, write the report, report to the QH (D-Q6).

The machinery to add an RD/IPD-equivalent department is **already generic**
(spec 005 §1 + its explore traces): the org schema, per-head preset generation,
role-template allow-list binding, department workspace, worker-role resolution and
the run/job engines are all `config.departments[]`-driven and need **no new
lifecycle machinery**. The genuinely **new** items are: (a) the **archive-event
hooks** in the org plugin (§5.1, §6 — the retire/sleep/rotation seams), (b) the
**probability gate** (`qualityInspectDecision`, a pure injectable-rng function,
§5.2), and (c) the **event-driven post-error directive** (§6.4) + the **daily
digest job** (§6.5).

The QD is deliberately **small** (one role, one job, no dept_exec by default) —
it is a *read/report* department, the closest in spirit to the RD's `reviewer`
but scoped to the **organization's own runtime**, not to report factuality.

---

## 2. Goals & Non-Goals

### Goals (requirements — do NOT re-litigate)

1. **G1 — The QD as a durable department.** `org.departments[]` gains a
   `quality` entry (D-Q1): `{id, name, workspacePath, jobDir, coordinator}`. It
   groups 1 head + N quality-inspector workers + 1 role template + the versioned
   `quality-daily` job, and owns one sidebar folder at
   `/root/.deepartments/departments/quality`.
2. **G2 — The archive-event hooks (D-Q2, D-Q3).** In the org plugin, on the
   three archive events — worker retire (`dept_post_retire`/`dept_worker_retire`),
   head `dept_sleep`, host session rotation — emit an ADDRESSED QUALITY INSPECT
   directive to `quality-head` via the message bus. Worker retire: dice (default
   0.10). Head + host: always (100%) except the Quality Head's own sleep, which is
   SAMPLED at 0.10 (D-Q7). The hooks NEVER throw, NEVER spawn a QD
   worker, and are non-fatal to the retire/sleep/rotation they hook.
3. **G3 — Event-driven post-error analysis (D-Q4a).** A NEW post-error record
   (the spec 006 capture, `post-errors.jsonl`) triggers a QD analysis directive
   to `quality-head` (with the error record). Separate from (and additive to) the
   spec-006 host ALERT.
4. **G4 — Daily digest job (D-Q4b).** `quality-daily` (role `quality-inspector`,
   cron `0 8 * * *`, owner `quality-head`, calendar entry `departmentId=quality`)
   consolidates post-errors, stalled posts, delivery failures and inspection
   results into a once-a-day pattern report.
5. **G5 — One role, read-only inspector (D-Q6).** `quality-inspector` role
   template materializes root-agent workers that read the archived session logs
   (stateDir `journals/sessions/*.md`, `journals/archive/`, `sessions/*.jsonl.zstd`),
   find the signal, write the report under `.dsh/reports/quality/`, and report to
   the QH.
6. **G6 — Report-only fix flow (D-Q5).** The QH consolidates inspector findings and
   reports to the Asistente (3–5 bullets + report paths), AND auto-files a
   PROGRAMMING REQUEST to `internal-programming-head` for real fixable issues.
   QD never fixes directly.
7. **G7 — Roles/presets/profile discipline.** Personas + head preset materialize;
   workspace autogenerates; the role + workflow contract are mirrored in the skill
   and the QH/worker presets use the literal model, never `{{model}}`.

### Non-Goals (explicitly out of scope for this spec)

- **QDs never auto-repair.** No `edit`, no `dept_exec` mutating, no commit — the
  QD inspects and reports. Fixes are a PROGRAMMING REQUEST to the IPD (D-Q5). The
  `quality-inspector` role has **NO `edit`** and, by default, **NO `dept_exec`**.
- **No new lifecycle machinery.** No new head/worker engine, no new scheduler
  engine — reuse `runJobForDepartment`/`spawnWorkerForDepartment` (§6.5), the
  existing daemon/effect wiring, the existing archive seams, the existing bus.
- **No stable-profile changes.** `/opt/dsh/.dsh` is a hard safeguard (spec 005
  I4/§5.1); the QD operates in the DEV profile. Nothing here touches stable.
- **No board rooms / rooms / roomId / opencode-go resurrection** (spec 005 §2/I8).
- **No change to the spec-006 health daemon or its host-ALERT** — the QD event
  directive is an ADDITIVE parallel signal, not a replacement for the system-health
  ALERT.
- **Out of scope (explicit, for the whole team) — `dsh-key-pooler` repo and
  `settings.yaml` wiring (W9-c(a)):** a SEPARATE queued item (recently tracked in
  the IPD; the W9 report names it). QD builders DO NOT touch that repo or that
  wiring. The STABLE profile `/opt/dsh/.dsh` is likewise NEVER touched.
  **Tail-queue milestone pointer (M5, after the M4 workflow/owner docs):** the
  `dsh-key-pooler` **Settings pane** (read-only per-key usage) is M5 — a SEPARATE,
  later milestone, NOT part of this spec's phases. Ref:
  `reports/researcher/2026-08-25-dsh-settings-pane.md`. Do NOT implement it here.
- **No sampling the host directly as a "worker".** The host is head-equivalent
  ("H", D-Q3) and its rotation is 100%; it is never put through the worker dice.

---

## 3. Conceptual model

```
Quality Department (org.departments[], id: quality)
 ├── Role   (presets/departments/quality/<role>.md — persona + toolset template)
 ├── Job    (docs/departments/quality/jobs/<slug>.md — versioned task definition)
 ├── Head   (coordinator quality-head — permanent root agent, today's ensureHead machinery, unchanged)
 └── Worker (root agent worker-<slug>-<uuid>: the quality-inspector role + task; ephemeral or job-backed)
```

### 3.1 Department

```jsonc
// config.org.departments[] — new entry (D-Q1; copied from the `research` block shape, spec 005 §3.1)
{
  "id": "quality",                      // D-Q1 — department id
  "name": "Quality Department",         // sidebar folder label (D-Q1)
  "workspacePath": "/root/.deepartments/departments/quality",   // D-Q1 — one real workspace folder
  "jobDir": "docs/departments/quality/jobs",                    // default from jobDirFor (org.ts)
  "coordinator": {
    "postId": "quality-head",
    "title": "Head of Quality",
    "role": "Quality department head",
    "sessionTitle": "Head of Quality",
    "provider": "opencode-zen",
    "agentOptions": { "provider": "opencode-zen", "model": "deepseek-v4-flash-vision-exp", "reasoningEffort": "max" }
  }
}
```

- The **head preset** derives automatically: `headPresetIdFor('quality')` →
  `deepartments-head-quality` (head-presets.ts — the same derivation as
  `internal-programming`; spec 005 §3.1/§7.4).
- The department is **config-only and hot in boot** — `ensureAllHeads`
  iterates `org.departments[]`, so the new entry flows through: the head preset is
  regenerated fresh on every boot (NOT durable; edit the base/coordinator config,
  never the runtime copy — spec 005 §3.1).

### 3.2 Role

A role is a **person template referenced by name** — the same shape as the RD/IPD
roles. File at `presets/departments/quality/<role>.md`, frontmatter
`{id, title, tools}` + body = persona. The `tools` **allow-list IS the effective
`restrict` mask** for the role (implemented — spec 004 §7.1 / spec 005 §3.2).
The QD has **ONE role**:

| Role | Persona (template intent) | Tools (allow-list → restrict mask) |
|---|---|---|
| `quality-inspector` | Read-only QA inspector: reads the archived session logs (the retire/sleep/rotation artifacts), finds the quality signal (stale rows, leaked artifacts, post-error patterns, delivery-failure patterns), writes a report under `.dsh/reports/quality/`, and reports to the QH | read, write, glob, grep, web_search, web_fetch, send_message, agent_messages, dept_who, dept_memo_write, dept_sleep — **NO `edit`, NO `dept_exec` by default** |

- **NO `edit`** (deliberate — the QD never repairs; D-Q5). **NO `dept_exec`** by
  default (a read-only inspector does not need a shell; the file-tools + fs-scope
  §5.3 are enough). ❓ §9 whether `dept_exec` is granted read-only.
- The inspector **reads the archived session logs**, which live under the stateDir
  — so the role must get read access to those paths (§5.3, the file-tool scope fix
  like the research-worker fix, commit `d4faeca`).

### 3.3 Job

Identical mechanism to the RD/IPD (§3.3 of spec 004/005). File at
`docs/departments/quality/jobs/<slug>.md`, frontmatter
`{id, title, role, description, owner, schedule?, outbox?}` + body = task. A
5-field cron `schedule` auto-fires via the 30s scheduler; a non-cron (human)
schedule never auto-fires.

| Job | schedule | role | purpose |
|---|---|---|---|
| `quality-daily` | `0 8 * * *` (daily 08:00 GMT) | `quality-inspector` | Daily consolidated quality digest: post-error deltas, stalled-posts, delivery-failure deltas, and the previous day's inspection results — the pattern report the QH folds into its weekly/the Asistente-facing report. |

- The job's `owner` is `quality-head`; the **calendar entry** is stamped
  `departmentId=quality` (spec 005 I3/common-agenda attribution).
- Reuses the **existing job-run machinery** (`runJobForDepartment` for the manual
  `dept_job_run` AND the scheduler auto-fire) — NO new engine (spec 005 §3.3/§8).

### 3.4 Worker

Identical to the RD/IPD: a **DISCONNECTED root agent** (`worker-<slug>-<uuid>`,
`provider:'worker'`, own sidebar session in the Quality folder), never a harness
subagent. Lifecycle: spawn (role persona + task) → work the task → write the
report `.dsh/reports/quality/<date>-<slug>.md` & reply to the QH
(`dept_memo_write` only if durable notes are wanted) → QH retires
(`dept_worker_retire`). EPHEMERAL PER ROUND — a worker does NOT sleep and does NOT
request permission from ITS head (never the host); a job worker is retried fresh
each round (W8-g). **BOOT-QUIET** (never acts unaddressed). The QD worker is a
**ROOT agent**: `worker-<slug>-<uuid>`, no `subagent`/`descriptor` (spec 005 §3.4).

### 3.5 Who coordinates what (D-Q5, D-Q6)

- **The Quality Head (QH) coordinates the Quality Department**: it receives the
  ADDRESSED QUALITY INSPECT directive from the archive-event hooks (D-Q2/D-Q3) —
  which is a **bus directive, never a spawned worker** — and *decides/spawns* its
  own `quality-inspector` workers (`dept_worker_spawn`), runs the `quality-daily`
  job (`dept_job_run`), reads results, and is the **ONLY one** who communicates
  findings.
- **The QH is the CONSOLIDATOR + ANALYZER, not a retransmitter.** A
  `quality-inspector`'s report ALWAYS goes to the QH; the QH ANALYZES the set (is
  everything well?) and issues a **verdict per round** — one line in the response
  to the requester: **"todo bien"** OR **"issue X → dirigido a Y (Z)"**. It never
  forwards raw worker output; it consolidates first.
- **The QH reports to the Asistente (host) AND/OR to the specific department** —
  and to nobody else outside the org, per where the verdict points. It sends:
  1. A CONSOLIDATED findings message to the **Asistente** (3–5 bullets + findings
     + the report paths) — the owner-facing result;
  2. An **auto-filed PROGRAMMING REQUEST** to `internal-programming-head` for each
     genuinely fixable issue (D-Q5) — the IPD then plans/fixes, exactly as it
     plans any other internal-programming work (spec 005 I2);
  3. A **RESEARCH REQUEST** to `research-head` when the finding needs
     investigation/evidence the RD provides;
  4. The **Asistente** when the finding is an owner decision. The QD NEVER fixes
     directly.
- **Workers report only to the QH.** A `quality-inspector` never writes to the
  Asistente, to the IPD, or to another department (worker → own dept only; spec
  004 §5.6 ACL). Everything crosses departments through the QH.
- **The QH does NOT coordinate harness subagents** — its deployment unit is the
  WORKER (spec 004 §5.6 / spec 005 §3.5 structure).

---

## 4. Data & catalog

The QD reuses the **existing** worker catalog machinery — no new PostEntry shape
is required beyond what the RD/IPD already add (`provider:'worker'`,
`departmentId`, `managerId`, `jobId?`, `kind:'worker'`, `retired?`, spec 004
§4.1). The QD adds a **config block** (mirroring the `parallel` / `health`
pattern in src/org.ts) and a **PostEntry / delivery seam** it reads:

### 4.1 The `quality` config block (D-Q2)

Add a `quality` section to the org config, mirrored by the `Config` schema in
`src/org.ts` (which already holds the runtime+mirror pattern for `parallel`,
org.ts:214-240, and `health`, org.ts:250-268). The runtime resolution follows the
established pattern: read `(config as unknown as { quality?: … }).quality`, fall
back to code defaults for absent keys; the schema and the typed cast always agree.
`default(void 0)` mirrors `health` so an ABSENT section composes untouched.

```jsonc
// config.org.quality — optional; defaults are CODE-level
{
  workerInspectProbability?: number   // default 0.10; must be in [0,1]; the worker-retire dice (D-Q2)
}
```

- `workerInspectProbability` **ABSENT** → **code default `0.10`** (the worker-retire
  dice probability). Present → that value. Invalid/out-of-[0,1] → code default
  (the same fallback pattern as `health.staleLiveMinutes`, org.ts:86-90).
- The **head/host 100% mandate is NOT a knob** — it is structural (D-Q3): the
  gate returns `true` for `kind 'head' | 'host'` regardless of any probability —
  for a **NON-QH head** (and the host); the QH's OWN sleep is a dice (D-Q7).
- **Determinism for tests (D-Q2):** the gate accepts an **injected rng** (a
  `() => number` in `[0,1)`) and/or a **seed**; the **env override**
  `DEEPARTMENTS_QUALITY_INSPECT` (a number string in `[0,1]`) overrides the
  **worker** probability path for determinism — the SAME path the QH dice takes
  (D-Q7). The structural NON-QH head/host mandate is never overridden (it is not a
  dice).

### 4.2 PostEntry / delivery seam (what the QD reads)

The QD is a **consumer**, not a producer, of the runtime state. It reads (no new
shape required):

| Source | Artifact | Read by |
|---|---|---|
| Post-error capture (spec 006 §4) | `<stateDir>/post-errors.jsonl` (bounded 500) | the event-driven directive (D-Q4a) + the `quality-daily` digest |
| Delivery sidecar (messages-store §4.4) | `<stateDir>/deliveries.jsonl` | the `quality-daily` digest (delivery-failure delta) |
| Archived session logs (spec 005 §5.3 archive seam) | stateDir `journals/sessions/*.md`, `journals/archive/`, `sessions/*.jsonl.zstd` | the `quality-inspector` worker (read access, §5.3) |

- The QD worker **report path** `.dsh/reports/quality/<YYYY-MM-DD>-<slug>.md`
  lives under the **stateDir/repo** `.dsh/reports/quality/` (D-Q6) — NOT the
  department-workspace `reports/` dir. This is a deliberate divergence from the
  RD/IPD and is why the QD inspector's report protocol (§7.1) names that exact
  root.

---

## 5. Tools

### 5.1 The archive-event hooks — the D2 principle (D-Q2, D-Q3)

The hooks are **pure event emitters** (the D2 principle). On each archive event
they:

- compute a **decision** via `qualityInspectDecision` (§5.2);
- if the decision is true, **emit ONE ADDRESSED QUALITY INSPECT directive to
  `quality-head`** via the message bus — an addressed bus message with the archive
  event details (archived member, kind, session id, ts, event surface).

**The hook NEVER spawns a QD worker.** The bus directive is the ONLY output; the
QH orchestrates its own workers (`dept_worker_spawn`). The directive is a
first-class bus message (framed `[From deepartments → quality-head]: Quality
inspect: <event>`), delivered via the plugin's internal delivery seam — NOT via a
tool the hosted agent calls at archive time (the archive runs inside plugin-internal
functions: `retirePost`, the head `dept_sleep` branch, `runHostRotation`).
The directive delivery therefore mirrors the **daemon-not-a-catalog-member**
notify pattern (spec 006 §6): `messagesStoreReady.append({from:'deepartments',
to:[qualityHeadEntry.postId], text: frame, kind:'agent'})` →
`busDeliverToPost(qualityHeadEntry, frame, record, void 0)`. `quality-head` is a
registered head, so `busDeliverToPost` reaches it (a dormant head is woken); the
directive is NEVER gated by the catalog-route ACL because the hook delivers via the
direct seam, exactly like the agenda scheduler `notifyHead` and the health daemon
ALERT.

**Invariants (mandatory):**
- The hooks **NEVER throw** — wrap the whole emit in its own try/catch that
  degrades to `ctx.logger.warn`; the retire/sleep/rotation they hook still
  completes (the archive mark / sleep mark is the durable part).
- The hooks are **non-fatal** and **side-observable only**; a failed directive
  delivery never aborts the retire/sleep/rotation.
- The hooks emit at the SAME place the archive/sleep/rotation seal happens, so the
  directive and the archive stay in lock-step.

### 5.2 `qualityInspectDecision` — the probability gate (D-Q2, D-Q3, PURE)

A **pure, injectable-rng function** (the "pure tick" habit of spec 006 §5.1 / the
health daemon) so a test drives it deterministically and offline:

```
qualityInspectDecision(kind, deps): boolean
  kind: 'worker' | 'head' | 'host'
  deps: {
    rng?: () => number              // injected [0,1) rng (default Math.random)
    workerInspectProbability?: number  // default 0.10 (D-Q2); clamped to [0,1]
    headPostId?: string             // the caller head postId (D-Q7): 'quality-head' → SAME worker dice; any other head → structural true
  }
```

| kind | result |
|---|---|
| `'head'` | **ALWAYS true** (D-Q3 mandate — the head archive is never gated) for ANY head EXCEPT the QD's own `'quality-head'` (D-Q7 anti-loop: the QH's OWN sleep is sampled by the SAME worker dice, default 0.10, no dedicated knob) |
| `'host'` | **ALWAYS true** (D-Q3 mandate — the host counts as "H", head-equivalent) |
| `'worker'` | `(rng ?? Math.random)() < (workerInspectProbability ?? 0.10)` (D-Q2 dice) |

- The head/host branch is **structural** — no probability, no knob, no env override
  can make it false (D-Q3 "never gated by the dice") for a **NON-QH head** (and the
  host); the Quality Head's OWN sleep is the one head case that IS a dice (D-Q7).
- The **env override** `DEEPARTMENTS_QUALITY_INSPECT` (a number string in `[0,1]`)
  overrides the **worker** probability path (when present and valid) so tests are
  deterministic — the SAME path the QH dice takes (D-Q7) — and it never turns the
  structural NON-QH head/host mandate off.
- **Purity** — `kind` + `deps` in, boolean out, no side effects. This is what makes
  the QD probability-gate tests (f-1, §8) trivial to write through the real Loader.

### 5.3 `dept_exec` / fs-scope for the QD inspector (D-Q6)

- The `quality-inspector` role has **NO `dept_exec`** by default (read-only
  inspector; it uses `read`/`glob`/`grep` + the bus). ❓ §9 whether a read-only
  `dept_exec` is granted.
- The inspector MUST have **read access to archived session logs**: stateDir
  `journals/sessions/*.md`, `journals/archive/`, `sessions/*.jsonl.zstd` — the
  file-tool scope like the research-worker fix (commit `d4faeca`). The role's
  file allow-list + the fs-scope this phase widens to those stateDir reads. ❓ §9
  the exact roots (stateDir resolves to `.deepartments` in production — the exact
  root must survive the service cwd, spec 004 §9).

### 5.4 Existing tools reused (no change)

The QH uses the same head-layer tools as the RD/IPD heads: `dept_worker_spawn`,
`dept_worker_retire`, `dept_job_run`, `dept_job_list`, `dept_who`, `dept_sleep`,
`dept_memo_write` — all resolve the department from the calling head, so a
`quality-head` config immediately gets the lifecycle tools for its own department
(spec 005 §5.3). The messaging ACL (`aclDenyGround`) is generic — a new `quality`
department is automatically scoped: workers message only within the QD (incl. the
QH), never the Asistente directly; the QH is addressed by the host and peers.

### 5.5 QD workers are ROOT agents with NO harness subagent tools

The `quality-inspector` worker materializes as a **root agent**
(`worker-<slug>-<uuid>`) with a role allow-list that has **NO
`subagent`/`subagent_fork`/`workflow`/`ralph`** (they are in
`DENIED_POST_TOOLS`, spec 005 §5.1) — the inspector never deploys, organizes, or
coordinates anyone. Its delivery is only the catalog route + the bus (BOOT-QUIET
until addressed). `kind:'worker'` derivation + `departmentId`/`managerId`/`jobId`
are already handled by the F3 spawn machinery (spec 004 §5.2).

---

## 6. The runtime hooks (D-Q2, D-Q3, D-Q4)

### 6.1 Worker retire — the dice (D-Q2)

When a NON-head agent session is archived — a disposable WORKER retired via
`dept_worker_retire` (invoke.ts:7175, which calls `retirePost` invoke.ts:7593 +
`archiveWorkerSession` invoke.ts:7644) OR the legacy `dept_post_retire`
(invoke.ts:6909/9321, same `retirePost` engine) — the hook:

1. resolves `kind = 'worker'`, `sessionId = entry.sessionId`;
2. calls `qualityInspectDecision('worker', {rng, workerInspectProbability})`;
3. on `true`, emits the ADDRESSED QUALITY INSPECT directive to `quality-head`
   with the worker's `postId`/`sessionId`/`retired:true` marker and the archive
   event (the `archivedKind:'worker'` sample).

The hook sits **after** the retire mark commits and **alongside** the (non-fatal)
`archiveWorkerSession` call — it is a side signal, never a blocker. A worker that
lands `false` on the dice is not inspected (D-Q2: sampled, not exhaustive).

### 6.2 Head `dept_sleep` — MANDATE 100% (D-Q3, with the anti-loop D-Q7 exception)

The head branch of `dept_sleep` (invoke.ts:6703; the archive is
`archivePostSessionOnSleep`, invoke.ts:6779-6781/7667) is a **head archive** —
the head's durable session is archived server-side (the sidebar row disappears,
the journal + messages stay). The hook:

1. resolves `kind = 'head'`, `sessionId` (the ACTUAL head session id, per the
   F8 ghost-row fix);
2. for a NON-QH head: **ALWAYS** emits (no dice — the D-Q3 100% mandate); for the
   **Quality Head's OWN sleep**: rolls the 0.10 worker dice (D-Q7) so it does
   NOT reliably trigger — the "QH sleeps each round" recurrence must never
   auto-feed an inspection (no QH-sleep → q-i → QH-wake loop);
3. emits the ADDRESSED QUALITY INSPECT directive to `quality-head` with the
   archived head's `postId`/`sessionId` + `sleepEpoch` surface.

**The mandate is never gated by the environment or a knob.** (🧭 the speculative
env / seed only affects the worker path, §5.2. The D-Q7 QH exception is the ONLY
case a head sleep is sampled instead of 100%.)

### 6.3 Host session rotation — MANDATE 100% (D-Q3, host = "H")

The host branch of `dept_sleep` (invoke.ts:9397) performs the **host session
rotation** (`runHostRotation`, invoke.ts:9479) which **archives the OLD host
session** (S2.5) and creates a fresh one. The host counts as a **"H"
(head-equivalent)** — a host rotation is inspected at **100%**:

1. resolves `kind = 'host'`, `sessionId` = the OLD (archived) host session;
2. **ALWAYS** emits (no dice);
3. emits the ADDRESSED QUALITY INSPECT directive to `quality-head` with the
   rotated host's identity and the rotation surface.

### 6.4 Event-driven post-error analysis (D-Q4a)

A **new post-error record** (the spec 006 system-health capture,
`post-errors.jsonl`, written in the bus materialization catch blocks) triggers a
QD **analysis directive to `quality-head` (with the error record)**. This is a
separate, additive signal to the spec-006 host ALERT — the QD directive is for
*analysis/organizational-quality*, the spec-006 ALERT is for *host visibility*.
The hook fires where the post-error row is appended (the capture seam) or when
the health daemon scan surfaces a fresh row; it emits a directive to `quality-head`
carrying the `{ts, postId, messageId?, error}` record. ❓ §9 whether this is
wired at the capture seam (append-time) or the daemon scan (tick-time) — both are
non-fatal; the seam-report cross-check decides.

### 6.5 The daily digest job + calendar (D-Q4b)

`quality-daily` (role `quality-inspector`, cron `0 8 * * *`, owner `quality-head`,
calendar entry `departmentId=quality`) consolidates the week's patterns —
post-errors, stalled posts, delivery failures, inspection results — into one
once-a-day report. Declared in
`docs/departments/quality/jobs/quality-daily.md`. Reuses the **existing** job-run
machinery (`runJobForDepartment` invoke.ts:6055 for the manual `dept_job_run` AND
the scheduler auto-fire; `dept_calendar_add` stamps `departmentId=quality`). The
worker reports to the QH (never the host — worker → host is PROHIBITED).

---

## 7. Personas & presets

### 7.1 The `quality-inspector` role template (D-Q6)

`presets/departments/quality/quality-inspector.md` — the QD's ONE role. The role
`tools` binding is IMPLEMENTED (spec 004 §7.1). The QD inspector's **report path is
`.dsh/reports/quality/<YYYY-MM-DD>-<slug>.md`** (the stateDir/repo
`.dsh/reports/quality/`, D-Q6) — NOT the department-workspace `reports/`.

| Role | Persona (template intent) | Tools (allow-list → restrict mask) | Report protocol |
|---|---|---|---|
| `quality-inspector` | Read-only QA inspector for the QD: reads the archived session logs (the retire/sleep/rotation artifacts under stateDir), finds the quality signal (a stale/leaked row, a post-error pattern, a delivery-failure thread, a head/host rotation that left an artifact), writes a report under `.dsh/reports/quality/`, and reports to the QH | read, write, glob, grep, web_search, web_fetch, send_message, agent_messages, dept_who, dept_memo_write, dept_sleep — **NO `edit`, NO `dept_exec` (default)** | writes `.dsh/reports/quality/<YYYY-MM-DD>-<slug>.md`; replies to the QH via send_message; communicates ONLY within the QD (ACL, D-Q5/D-Q6). **BOOT-QUIET**, **EPHEMERAL PER ROUND** (W8-g) |

- **NO `edit`** — the QD never repairs (D-Q5). **NO harness subagent tools** — it is
  a root worker. **BOOT-QUIET** — it acts only when the QH addresses it. **Memory via
  `dept_memo_write`; ephemeral by default; job workers EPHEMERAL PER ROUND** (§7.5
  of spec 004 carries).
- The role template uses the **literal model**
  `deepseek-v4-flash-vision-exp` (provider `opencode-zen`, reasoning max) — never
  `{{model}}` (spec 005 §7.3 / fix 3203b69).

### 7.2 Quality Head (QH) persona (D-Q5, D-Q6)

The `deepartments-head-quality` persona becomes, in effect:

> You are the **Head of Quality** of the **Quality Department** (Deepartments,
> DeepSeek Harness). You OWN the QUALITY of the Deepartments organization's own
> runtime — you do NOT fix it. You receive **Quality Inspect directives** (bus
> messages from the archive-event hooks: a retired worker sampled at 10%, a
> department head sleep at 100% — EXCEPT your own sleep, which is SAMPLED at 10%
> by design, D-Q7; a host session rotation at 100%; a new post-error record; the
> daily digest) and you DECIDE/SPAWN your own `quality-inspector`
> workers with `dept_worker_spawn`/`dept_worker_retire` and run the `quality-daily`
> job with `dept_job_run`/`dept_job_list`. **You are the CONSOLIDATOR + ANALYZER,
> not a retransmitter:** each `quality-inspector` reports to you, you ANALYZE the
> set (all well?), and you issue a **verdict per round** — "todo bien" OR "issue X
> → dirigido a Y (Z)". You communicate with your department and
> with the heads — you report consolidated findings (3–5 bullets + findings + the
> report paths) to the **Asistente** AND/OR you file a **PROGRAMMING REQUEST** to
> `internal-programming-head` for a genuinely fixable issue, a **RESEARCH REQUEST**
> to `research-head` when the finding needs investigation, or the **Asistente**
> for an owner decision. You do NOT coordinate harness subagents (that is the
> Asistente's machinery); your deployment unit is the WORKER. You never repair code
> yourself — the QD inspects, the IPD fixes.

**QH lifecycle (owner amendment 2026-08-25, autonomous sleep).** The QH's round
ends with it producing the report/verdict to the Asistente; it does **NOT request
sleep** (the "head requests sleep → Asistente approves" model is DISCARDED). After
a mission-concluded report/verdict — or on a large context window / inactivity —
the **Asistente** emits the SLEEP DIRECTIVE autonomously and the QH concludes with
`dept_memo_write` + `dept_sleep` (or the Asistente keeps it awake for a chained /
pending round). The QH's own sleep is NOT inspected at 100% (D-Q7, anti-loop): it
is SAMPLED at the 0.10 worker dice, so its recurring per-round sleep never
auto-feeds an inspection back into the QD.

### 7.3 Literals, never `{{model}}` (lesson 3203b69)

Same discipline as spec 004 §7.3 / spec 005 §7.3: persona text uses the **fixed
literal** `deepseek-v4-flash-vision-exp` (provider `opencode-zen`, reasoning max);
base profile `opencode-zen`/`deepseek-v4-flash-vision-exp`; **no Pro subagents** in
the department. `{{cwd}}` stays (it is bound).

### 7.4 Head preset id (D-Q1)

`headPresetIdFor('quality')` → `deepartments-head-quality` (derived
automatically, head-presets.ts — the same derivation as
`internal-programming`). Materialized fresh at boot into
`$DSH_HOME/.agent-presets/deepartments-head-quality/` — generated, not durable
(spec 005 §3.1/§7.4).

### 7.5 Cross-department requests

The QD **does not request research** (unlike the IPD's `version-watch` it needs no
external community evidence). Its one cross-department synergy is the **auto-file
PROGRAMMING REQUEST to the IPD** (D-Q5): the QH sends it to
`internal-programming-head`, which plans/fixes. Workers never message across
departments — everything crosses through the QH. The QD is served by the IPD (fix
requests) and produces for the Asistente (findings); it needs no RD service.

---

## 8. Implementation phases (Q1–Q5) — parallel builders, no file overlap

**Whole-team files in scope (ALL QD work is confined to these):**
`docs/specs/007*`; `presets/departments/quality/*`;
`src/org.ts` (the org config source — `departments[]` + the new `quality` config
block, D-Q2) **and** `src/invoke.ts` (the org-plugin hooks, ONLY the QD-related
seams); `tests/**`; `.dsh/skills/deepartments-workflow/SKILL.md`;
`docs/departments/quality/*`. **Explicitly OUT OF SCOPE:** the `dsh-key-pooler`
repo and `settings.yaml` wiring (W9-c(a) is a SEPARATE queued item). **Do NOT
touch the stable profile `/opt/dsh/.dsh`** (spec 005 I4). (`config/org.ts` in the
owner's brief is the org config source; the file in this repo is `src/org.ts`.)

| Phase | Scope | Files |
|---|---|---|
| **Q1 — config + probability gate** | `org` config gains the `quality` block (D-Q1 + the `quality: { workerInspectProbability?: number }` knob, §4.1); `QualityConfig` + schema (mirror `health`); `qualityInspectDecision(kind, deps)` PURE function (§5.2) + the env override `DEEPARTMENTS_QUALITY_INSPECT` | `src/org.ts` (`Config` + schema), `src/invoke.ts` (the gate fn + env override), `test/invoke.test.js` (probability-gate unit tests: 0.10 / clamp / mandate 100% head+host except the QH's own sleep (D-Q7) / deterministic seed+env) |
| **Q2 — archive-event hooks** | The three archive-event hooks (D-Q2/D-Q3): worker retire dice (invoke.ts:7175/7593/7644 seam), head `dept_sleep` 100% (invoke.ts:6779-6781/7667 seam; EXCEPT the QH's own sleep — D-Q7, sampled at 10%), host rotation 100% (invoke.ts:9479 seam); the emit-to-`quality-head` directive seam (store.append + busDeliverToPost, daemon-not-a-catalog-member pattern); NEVER throw / NEVER spawn; non-fatal | `src/invoke.ts` (the hook seams + the resolve-quality-head + directive emit), `test/invoke.test.js` (hook wiring: worker dice OFF/ON, head+host always, non-fatal, no worker spawn) |
| **Q3 — event-driven post-error + daily digest** | The event-driven post-error analysis directive (D-Q4a, spec-006 capture → directive to `quality-head` with the error record); the `quality-daily` job (role `quality-inspector`, cron `0 8 * * *`, owner `quality-head`) + the calendar entry `departmentId=quality` | `src/invoke.ts` (the post-error → directive hook), `docs/departments/quality/jobs/quality-daily.md` (job def), `test/invoke.test.js` (event wiring) |
| **Q4 — role / head preset / workspace** | `quality-inspector` role template + the QH head preset (D-Q6, literal model, BOOT-QUIET, report path `.dsh/reports/quality/`) + the department workspace autogen (`/root/.deepartments/departments/quality`) + the fs-scope for the archived session logs (§5.3) | `presets/departments/quality/quality-inspector.md`, `presets/departments/quality/{ARCHITECTURE.md,README.md}`, `src/invoke.ts` (fs-scope widening for the inspector role), the workspace dir |
| **Q5 — skill + docs** | Add the QD to the workflow skill (roster + a "Quality requests → Quality Department" section mirroring RD/IPD); the department job docs + workspace README/ARCHITECTURE; the report path `.dsh/reports/quality/` documented | `.dsh/skills/deepartments-workflow/SKILL.md`, `docs/departments/quality/*`, `presets/departments/quality/{README,ARCHITECTURE}.md` |

**File-ownership note (no overlap).** `src/invoke.ts` is touched by Q1–Q4 **and**
`src/org.ts` by Q1 only. Apply Q1→Q2→Q3→Q4 **in sequence** (they share `invoke.ts`
and each builds on the previous phase's seam); Q5 (skill + docs) is **parallel** and
can run at any time (no shared file with Q1–Q4). Q1's `src/org.ts` is the ONLY
config edit. `test/invoke.test.js` grows in each of Q1–Q4 — sequential. Within the
sequence the "no overlap" rule still holds per commit: one builder edits `invoke.ts`
at a time.

**Order & verification (per phase, AGENTS.md tiered):**

1. `pnpm build` (tsc NodeNext, clean).
2. `DSH_HOME=/opt/dsh/.dsh-dev dsh plugin --profile deepartments-dev add
   /home/esuarez/projects/deepartments`.
3. `DSH_HOME=/opt/dsh/.dsh-dev dsh --profile deepartments-dev --dump-config` —
   must show the `# == dsh-deepartments` layer with the new `quality` department.
4. Headless smoke in `deepartments-dev-headless`: boot → `dept_who` shows the QH
   + a `quality-inspector` worker with `kind:'worker'`/`departmentId:'quality'` →
   a worker retire rolls the dice (sampled under a fixed seed) → a head + host
   sleep ALWAYS emits a directive → a post-error record emits a directive → the
   `quality-daily` job runs.
5. Reviewer after EVERY phase (independent reviewer PASS before commit);
   commits per phase. **The full existing suite stays green (296+)** — QD tests are
   ADDITIVE (on top of the existing daemon/store/ACL tests), never a replacement.

**Risks**

1. **The hook must never break what it hooks.** The retire/sleep/rotation seams are
   non-throwing by contract (spec 005 §3.4, spec 006 §11); the QD directive emit
   must be wrapped so a failing emit degrades to a warn and the archive/sleep
   still commits. The highest-risk piece.
2. **The dice must be exact and testable.** `qualityInspectDecision` is PURE
   (injected rng/seed/env) — a naive `Math.random()` inline is untestable. The
   head/host mandate MUST be structural (a bug turning it into a die would violate
   D-Q3) for a **NON-QH head** (and the host); the QH's OWN sleep die is INTENTIONAL
   (D-Q7), not a bug turning the mandate into a die.
3. **The directive must find `quality-head`.** The hook emits via
   `busDeliverToPost(qualityHeadEntry, …)`; `quality-head` must be a registered
   head (ensureHead) or the delivery is a silent no-op. Verify the resolve seam.
4. **ACL blast radius.** The QD is generic-ACL (no new rules needed), but any bus
   test must confirm a `quality-inspector` worker is indistinguishable-in-kind from
   an RD/IPD worker.
5. **`dept_exec` scope (❓ §9)** — leaving the inspector without `dept_exec` and
   only file-tool stateDir reads is the safe default; granting a read-only
   `dept_exec` widens the risk surface.
6. **Report-path integrity.** The QD inspector reports to `.dsh/reports/quality/`
   (D-Q6), NOT the department-workspace `reports/`. A builder that copies the RD/IPD
   path convention would violate the owner decision.

---

## 9. Open questions (❓ — resolve with the owner before/at dispatch)

The owner's decisions **D-Q1–D-Q6 are adopted as requirements** (baked in §0–§7).
The points below are **genuine implementation-detail** `❓` points only — they do
NOT re-open an owner decision.

1. **The exact probability-gate signature / seed-injection seam (❓).** The PURE
   function `qualityInspectDecision(kind, deps)` with `deps.rng`/`deps.workerInspectProbability`
   and the `DEEPARTMENTS_QUALITY_INSPECT` env override is the recommended shape
   (§5.2). Confirm the exact signature, how the seed is threaded (an injected
   `rng()` that the code default `Math.random` replaces), and the env-override
   parsing (a numeric `[0,1]` string; invalid → worker default; it never turns the
   **structural NON-QH** head/host mandate off; the QH dice shares the worker
   probability path). ❓ — builder-verify against the health-daemon pure-tick
   precedent (spec 006 §5.1).
2. **The fs-scope roots for the `quality-inspector` (❓).** The inspector must read
   stateDir `journals/sessions/*.md`, `journals/archive/`, `sessions/*.jsonl.zstd`.
   Confirm the exact roots (stateDir resolves to `.deepartments` in production; the
   exact root must survive the service cwd, spec 004 §9) and the file-tool scope
   widening (the research-worker fix commit `d4faeca`). ❓ — the seam report
   cross-checks the precise path set.
3. **Is `dept_exec` granted read-only to `quality-inspector` (❓).** Recommended:
   **NO** (the inspector reads via file tools + the bus; a shell widens the risk
   surface for a role that never mutates). Owner confirm whether a read-only
   `dept_exec` is wanted (e.g. to run `git log`/`git diff` on the repo for a config
   audit) or whether the inspector stays shell-free.
4. **Event-driven directive wiring point (❓).** For D-Q4a, is the directive emitted
   at the post-error **capture seam** (append-time, spec 006 §4) or at the **health
   daemon tick scan** (when a fresh row surfaces)? Both are non-fatal; the
   seam-report cross-check decides. Recommended: the capture seam (immediate), with
   the same never-throw wrap.
5. **`quality` config location + defaults (❓).** Confirm a single optional
   `org.quality` block (mirror `health`/`parallel`, `default(void 0)` → code
   default `workerInspectProbability: 0.10`). Recommended: yes — a config with no
   `quality` section keeps composing untouched.
6. **Does the QD need an ADJUNCT role (`reviewer`-style) or a report archivist (❓).**
   D-Q6 names ONE role (`quality-inspector`). Confirm the QD stays single-role for
   this epic (recommended: yes — a second role is an organic extension a later
   phase adds as `presets/departments/quality/<role>.md`, never code).
7. **The `quality-daily` report destination (❓).** The job worker reports to
   `.dsh/reports/quality/<date>-<slug>.md` (D-Q6 report path). Confirm the digest
   ALSO writes a workspace-relative aggregate (e.g. a `quality/` index) or keeps
   every report under `.dsh/reports/quality/`. Recommended: keep all under the
   D-Q6 path; a workspace `INDEX.md` is an optional nicety.

### Builder-verify points (implementation detail, not owner questions)

- The exact seam-map file:line anchors for the three archive events (seam report
  cross-check — currently verified in-repo: `retirePost` invoke.ts:7593,
  `archiveWorkerSession` invoke.ts:7644, head `dept_sleep` archive
  invoke.ts:6779-6781/7667, host rotation invoke.ts:9479).
- `qualityInspectDecision` purity + the env/seed threading; confirm it survives the
  `restrict` mask / is a pure helper (not a tool) so no `dept_*` tool id is needed
  (the gate is INTERNAL — there is no public `dept_quality_inspect` tool).
- The resolve-`quality-head` seam for the directive emit; the `busDeliverToPost`
  call shape (the daemon `notifyHead` precedent, spec 006 §6).
- Whether the directive emit belongs in `retirePost` / the head-sleep branch /
  `runHostRotation` directly or in a small `maybeEmitQualityInspectDirective(kind,
  entry)` helper invoked by each (recommended: a single helper, three call sites —
  no per-surface drift).
- The `QualityConfig` zod schema (mirror `health`/`parallel`; add to `Config`
  `z.object`, `default(void 0)`).
- The `.dsh/reports/quality/` directory provisioning (created by the inspector on
  first write, or provisioned at spawn).
- The `org` fixture alignment: historical/board-era test fixtures use
  `programming`/`programming-head` names; verify the fixture alignment to `quality`
  / `quality-head` (spec 005 §9 open-item mirror).

---

## PATTERNS / INVARIANTS / SURPRISES (for the builders)

- **Invariants kept**: QD workers are ROOT agents (`worker-<slug>-<uuid>`, no
  subagent/descriptor); BOOT-QUIET; the catalog route + bus is their only delivery
  path; the manager gate (head own-layer) stays structural (the host CANNOT mint
  QD workers); retire is idempotent + dispose deduped; archive is non-fatal;
  per-recipient failure never fails a whole send; the messaging ACL is generic and
  a new `quality` department is automatically scoped; the QD NEVER repairs (no
  `edit`, no mutating `dept_exec`, no commit); the QD NEVER spawns from a hook (the
  hook only sends a bus directive — D2 principle); the head/host mandate is
  structural (100%, D-Q3 — a bug must never make it a die), with the single
  anti-loop D-Q7 exception (the Quality Head's OWN sleep is sampled at 0.10, not
  100%).
- **Surprises verified**: (1) the QD is the ONLY department where a worker's report
  path is `.dsh/reports/quality/` (stateDir/repo) NOT the department-workspace
  `reports/` (D-Q6) — a deliberate divergence; (2) the three archive events ALL
  have an EXISTING seam to hang the hook on — no new archive machinery is needed
  (`retirePost` / `archiveWorkerSession` / `archivePostSessionOnSleep` /
  `runHostRotation`); (3) the hooks emit via the **daemon-not-a-catalog-member**
  notify pattern (`store.append` → `busDeliverToPost`) because they fire inside
  plugin-internal functions, NOT a hosted agent's `send_message` — the catalog-route
  ACL would otherwise deny a non-catalog sender; (4) `qualityInspectDecision` is
  INTERNAL (a pure helper, not a tool) — no new `dept_quality_*` tool id is needed;
  the gate is the ONLY genuinely new logic (the department, role, job, and
  presets are all `config.departments[]`-driven).
- **Primary source refs for builders**: docs/specs/005-internal-programming-
  department.md (master style; departments/roles/jobs/ACL/phases/§0/§9/patterns),
  docs/specs/006-system-health.md (§4 post-error capture seam, §6 bus-ALERT-to-host
  daemon pattern, §9 daily digest precedent, §10 acceptance chain), docs/specs/004-
  research-department.md (§0 owner table, §3 conceptual model, §7 personas, §9 open
  questions), src/org.ts (`Config` 114-155, `DepartmentConfig` 40-58, `HealthConfig`
  /`parallel` mirror pattern 214-268), src/invoke.ts (retirePost 7593,
  archiveWorkerSession 7644, archivePostSessionOnSleep 7667, head dept_sleep 6703
  /6779-6781, host rotation 9479, runJobForDepartment 6055, spawnWorkerForDepartment
  6130, busDeliverToPost 8415, busDeliverToHost 8479), presets/ (role-template
  `tools` allow-list convention), .dsh/skills/deepartments-workflow/SKILL.md (roster
  + RD/IPD sections to mirror).
