---
name: deepartments-workflow
description: Multi-agent workflow for the Deepartments project — Asistente (the main agent) + its personal secretary (transient, read-only NON-CODE; the pre-M2 builder/reviewer/scribe/researcher roles are R6-unified into it; deep analysis is the IPD's explore-deep), with research delegated to the Research Department (RD), internal programming delegated to the Internal Programming Department (IPD), and org-runtime quality inspection delegated to the Quality Department (QD). Use it when planning or executing multi-agent code changes, when dispatching a secretary, or when resuming a session of this project. Port of the multi-agent-workflow pattern to DeepSeek Harness.
---

# Deepartments — Multi-Agent Workflow (DSH)

This project uses a conversational Asistente + parallel subagents pattern.
The human talks to the main agent (the Asistente); the Asistente asks
microdecisions and organizes planning and parallel execution via subagents.
Research is NOT run by the Asistente: it is delegated to the Research
Department (RD) — see "Research requests → Research Department (RD)".
Quality of the org's own runtime is NOT inspected by the Asistente either: it is
delegated to the Quality Department (QD) — see "Quality requests → Quality
Department (QD)".

## Roster

| Role | Dispatch tool | Model | Notes |
|-----|----------------|-------|-------|
| **Asistente** (host main agent) | (this agent) | deepseek-v4-flash-vision-exp | All tools, but NEVER edits; interface/coordinator — positional authority (HOST), NOT a model tier; translates the owner's vision, asks microdecisions, and runs verification/commits/deploys; does NOT plan internal programming (the IPD head does) |
| **Research Head** (`research-head`) | `send_message` | deepseek-v4-flash | DELEGATING head of the Research Department; ephemeral workers researcher/analyst/reviewer/organizer. Owns all research — see "Research requests → Research Department (RD)" |
| **Internal Programming Head** (`internal-programming-head`) | `send_message` | deepseek-v4-flash | DELEGATING head of the Internal Programming Department; ephemeral workers builder/reviewer/explore-deep/organizer. Owns all internal programming work — see "Programming requests → Internal Programming Department (IPD)" |
| **Quality Head** (`quality-head`) | `send_message` | deepseek-v4-flash | DELEGATING head of the Quality Department; ephemeral-per-round worker quality-inspector. Inspects the org's own runtime (archive events sampled/100%, post-errors, daily digest) — see "Quality requests → Quality Department (QD)" |
| **Secretary** (HOST + HEADS) | `secretary` (`dsh-deepartments/subagent`, HOST's tool row / heads' `tool-secretary`) | inherits the parent (host vision-exp; a head flash) | UNIFIED transient role (M2, owner 2026-08-28): ONE personal NON-CODE READ-ONLY helper that reads journals/files/reports, searches (glob/grep) and summarises for its deployer; never edits/writes/runs commands (code → IPD). It is a transient subagent child (followups via `send_message` to the child id), NOT a department worker |
| Pre-M2 transient roles (builder/reviewer/scribe/researcher, R6-DEPRECATED; explore, RETIRED) | `secretary` (explore→`generic`) | — | All map to the secretary contract via `normalizeRole` (explore→generic); kept for vocabulary/record — see "Secretary" + "Explore (code analysis)" below. The department workers (builder/reviewer/explore-deep) are the real paths |

The Asistente's transient delegation (`secretary` / the context-inheriting fork
variant of the same tool) is the **personal NON-CODE read-only helper** path
(M2, owner decision 2026-08-28): a secretary reads journals/files/reports,
searches (glob/grep) and summarises for its deployer — it NEVER edits, writes,
runs commands, or deploys anything. Normal **internal code changes do NOT go
through it** — they are delegated to the Internal Programming Department, which
owns its own ephemeral workers (builder / reviewer / explore-deep / organizer)
under a delegating head. For the department dispatch flow see "Programming
requests → Internal Programming Department (IPD)".

That transient surface is a single role, not a roster: every dispatch is the
same tool (`secretary` for the host; `tool-secretary` for department heads —
the SAME plugin `dsh-deepartments/subagent`, renamed). The child's MODEL
INHERITS the parent's (the host's secretary runs `deepseek-v4-flash-vision-exp`
via `opencode-zen`; a head's secretary runs the head's `deepseek-v4-flash`) —
no override, no new tier (M2 decision: "herencia del padre"). The child JOINS
the parent's preset + a shadow persona + the tool's `toolFilter` restrict
(read/glob/grep only — one-visibility; inheritance never widens). The pre-M2
transient roles builder/reviewer/scribe/researcher are R6-DEPRECATED and
UNIFIED into `secretary` (`normalizeRole` maps them — the dispatch `role` param
defaults to secretary); `explore` stays retired (F2/F3). The per-role contract
is NOT re-written into the prompt — it is INJECTED at the child's first
pre-step from the bundled ROLE_CONTRACTS map (Task T4): pass the `role` param
and the dispatch prompt stays objective+files+spec+verification. Department
heads run `deepseek-v4-flash`. There is NO Pro model tier (redesign F10): the
Asistente's authority is POSITIONAL (host/orchestrator), not model-based. Fleet:
the host + its transient secretaries run `deepseek-v4-flash-vision-exp`
(provider `opencode-zen`, reasoning_effort `max`); department heads +
department workers run `deepseek-v4-flash` (provider `opencode-zen`, reasoning
max).

## Departments directory

> E2 mirror of the wake pack's `## Departments directory` section (section 5b):
> SAME text in BOTH places, but the PACK assembles it live from
> `config.org.departments[].purpose/services` (the org chart is never hardcoded
> in the pack — add/remove a department = edit the config); this skill mirror
> is the static render of the CURRENT configuration. KEEP THE TWO IN SYNC when
> editing `cordis.patch.yml` (`org.departments[].purpose`/`services`) — the pack
> renders it automatically; update this mirror to the same text. Any agent that
> does NOT receive the pack (department workers — the pack is HOST-only) reads
> the directory HERE.

- Research Department (research-head): investigación web-first de la org — evidencia actual/community/security (research-on-demand + tech-watch biweekly; roles researcher/analyst/reviewer/organizer). Pídelo con un RESEARCH REQUEST (send_message a research-head) — devuelve informe + resumen 3-5 bullets.
- Internal Programming (internal-programming-head): todo el trabajo de código interno de DSH/dsh-deepartments/plugins — planificación, implementación (builder), análisis profundo (explore-deep), revisión (reviewer), jobs semanales (weekly-repo-health, version-watch); DAG/cola IPD. Pídelo con un PROGRAMMING REQUEST (send_message a internal-programming-head).
- Quality Department (quality-head): inspecciona el runtime de la propia org (eventos de archivo 25%/100%, post-errors, digest diario quality-daily); SOLO reporta, nunca arregla (los fixes van al IPD vía PROGRAMMING REQUEST). Pídelo con un QUALITY REQUEST (send_message a quality-head).
- Cualquier head puede pedir los servicios de otro departamento por send_message a su head (ACL head↔head); un worker nunca cruza departamentos — pide a su propio head, que retransmite.

## Head lifecycle

Department heads are PERMANENT and **do NOT sleep** (owner decision 2026-08-27,
LOTE A: the head/worker sleep system is RETIRED — heads and workers stay
`idle|running`). There is **no more SLEEP DIRECTIVE**: the Asistente no longer
emits head sleeps, a head NEVER requests sleep and NEVER concludes with
`dept_sleep` — it simply ends its turn and stays idle until the next addressed
message arrives (BOOT-QUIET). The head's lifecycle is: receive mission →
dispatch → collect → report / emit verdict → end turn → idle until addressed.
A head's long-term memory is persisted with `dept_memo_write` (its journal), but
the head itself remains a live resident. Only the **Asistente (host)** conserves
its own `dept_sleep` session rotation (spec 002) and the host rotation stays
inspected at 100% by the Quality Department. (Legacy entries carrying a
`sleepEpoch` on disk still resurrect fresh on their next wake — the residual
legacy path, R6.) This mirrors the worker ephemeral rule (a worker is retired by
its head); only the host sleeps.

## Head rotation (context refresh — `dept_head_rotate`)

A head whose context window is nearly exhausted does NOT sleep and is NOT
retired — it is **ROTATED** (micro-decision owner 2026-08-28, M-A): an ACTIVE
session refresh with journal, host-plane tool `dept_head_rotate {postId,
reason?}`, visible to the Asistente only.

**When to use it:** a context-threshold crossing (a head ≥ 50% of its context
window — the M-A monitor alerts on it) or on direct instruction. The QH is the
typical first target (over-threshold); the QH is NOT excluded — a rotation by
instruction is a one-shot event, the old anti-loop exclusion was sleep-specific.

**The host's routine (window permitting):**
1. Confirm the head is IDLE (`dept_who`) — a RUNNING head is rejected loudly
   (rotate in a free window, never mid-turn).
2. If the head is operative, ask it for `dept_memo_write` FIRST (send_message)
   so the rotation seeds the freshest memo.
3. Call `dept_head_rotate {postId, reason}`. The tool: bounded-disposes the old
   live handle → server-side archives the old session → FRESH-MINTS a new
   session (`head-<postId>-<uuid>`) seeded with the head's LAST durable journal
   (the journal author is the stable postId — NO re-key) + the department title
   pin → mirrors `Quality inspect: head rotated …` to quality-head (100%
   mandate). No `sleepEpoch` is set (rotation ≠ sleep); the entry records
   `previousChildId` + `rotated`.
4. **Critical-unblock rule:** the rotation ALWAYS uses the last durable journal
   and NEVER delays for a fresh memo — a context-blocked head (the QH) may not
   be able to run `dept_memo_write`. The result surfaces
   `journal.stale` ("memo no actualizado — journal previo") when the seeded
   journal predates the freshness window; request the refresh at the first
   opportunity, never to unblock.
5. **No immediate wake:** the fresh head lands LIVE but BOOT-QUIET (its first
   turn starts on the NEXT message/daemon wake — the journal is already in its
   context as the seed + the wake pack is injected at pre-step). Greet it with
   the substantive message right after (the "resume" handoff); it re-orients
   from the seeded journal in its first turn (M-B hook).
6. A head with NO durable journal at all fails loudly — request a
   `dept_memo_write` first. Workers and unconfigured posts are rejected loudly;
   a head can never rotate (host-plane ACL).

## Key principles

- **Asistente = interface/coordinator.** It translates the owner's vision into
  microdecisions and dispatch; it runs the verification ladder, git commits and
  deploys. It does NOT plan internal programming — the Internal Programming
  Department head does. It also does NOT inspect the org's own runtime quality —
  the Quality Department head does. Internal code changes are delegated (see the
  IPD section); the Asistente keeps verification/commits/docs/restart duties.
- **Microdecisions**: the Asistente asks with `ask_user_question` before
  assuming defaults. No silent conventions.
- **One file, one owner**: parallel builders never touch the same file.
- **Verify, don't trust**: reviewer + real verification, every batch.
- **Never auto-commit docs**: scribe drafts to `.dsh/reports/scribe/`, the
  human merges.
- **Escalate, don't trash**: if a builder (Flash) fails twice, human
  decision (no tiered models).
- **Specs first**: write/update the spec before implementing.
- **Reports are inter-agent memory**: dispatch prompts reference paths of
  previous reports instead of re-dumping context.
- **Always-async delegation.** The secretary tool (the `dsh-deepartments/
  subagent` plugin, host row renamed `secretary`, heads' `tool-secretary`) has
  no blocking mode: every dispatch returns a child id immediately and the
  settlement notice wakes the deployer when the child finishes. Dispatch
  independent secretaries in parallel in one message; continue dependent work
  only when the notice arrives; never wait inline or busy-poll. Use
  `send_message` for follow-up turns in the same child conversation.
- **Restart only with `smart_restart`.** Never restart the DSH service with a
  raw `systemctl restart`/`reboot`: `smart_restart` runs a canary (aborts if the
  boot is unhealthy), records reason+session, restarts detached, and anchors the
  post-restart notice to this session. A raw `systemctl restart` with active
  subagents kills their in-flight turn (session "Stopped", result "outcome
  unknown") and gives no durable result. Always use `smart_restart`
  (canary:true).

## Dispatch templates

Dispatch is LIGHT (Task T4, 2026-08-21). Every transient subagent receives, at
its first `agent/pre-step`, an injected **role contract block** (from the bundled
`src/role-orient.ts` ROLE_CONTRACTS map) instead of the full host wake pack — so
the Asistente does NOT re-embed the whole role contract in the dispatch prompt.
The dispatch prompt carries only the handoff contract: **objective + files in
scope + spec/acceptance + verification**, plus the role. Each template opens with
the single line telling the child its role contract is injected.

All dispatch tools run in the background automatically — there is no
`run_in_background` parameter; results arrive via the settlement notice. Pass the
role with the `role` param on the tool: `secretary` is the ONE read-only
NON-CODE contract (default); `builder`|`reviewer`|`scribe`|`researcher` are
R6-DEPRECATED and map to secretary; `explore` is RETIRED (see F2/F3). Unknown
roles fall back to generic.

### Secretary (personal NON-CODE read-only helper)

The ONE transient delegation: HOST and HEADS deploy a personal secretary with
the same tool (the host's delegation row renamed `secretary`; a head's
`tool-secretary` preset row — both are the `dsh-deepartments/subagent` plugin).
The secretary is a transient subagent CHILD (followups via `send_message` to
the child id — the CHILD route is outside the ACL, F2), NOT a department
worker (those are root agents via `dept_worker_spawn`).

- **READ-ONLY NON-CODE**: it reads journals/files/reports, searches (glob/grep)
  and summarises — e.g. "read my journal and summarise the open items", "review
  the report at <path>". Its `toolFilter` allow whitelist is exactly
  `[read, glob, grep]` (one-visibility: write/edit/web/delegation tools are
  masked from prompt AND execution; the harness validates the names loudly).
- **Model: inherits the parent** (M2): the host's secretary runs
  `deepseek-v4-flash-vision-exp`; a head's secretary runs `deepseek-v4-flash` —
  no override, no new tier.
- **CODE BELONGS TO THE IPD**: the secretary NEVER edits, writes, runs commands,
  or deploys anything (the pre-M2 builder/reviewer/scribe/researcher transient
  contracts are R6-deprecated and unified into it). Internal programming and
  deep code analysis are routed with ONE `send_message` to
  `internal-programming-head` — never attempted by the secretary.
- **Report**: the secretary returns a concise self-contained summary to its
  deployer (it does not write report files). Follow-ups continue the same child
  conversation via `send_message` to the child id.

### Builder / Reviewer — R6-DEPRECATED (unified into Secretary, M2)

> R6 (M2): the transient pre-M2 roles `builder` and `reviewer` map to the unified
> read-only `secretary` contract (`normalizeRole`). **Code/edits / independent
> review NEVER run as transient dispatches — they go to the IPD** (PROGRAMMING
> REQUEST; the department `builder`/`reviewer` WORKERS in
> presets/departments/internal-programming are the normal path). No tiered models
> remain; the transient surface is the single read-only secretary.

### Research requests → Research Department (RD)

The Asistente NEVER runs research itself — a host `researcher` subagent is NOT
the normal path (D2). Every research request is delegated to the **Research
Department**. Dispatch is a single `send_message` to `research-head` (the RD's
head) in this format:

```
RESEARCH REQUEST
- Topic: <what to research>
- Why/context: <why now; what decision it feeds>
- Needs: <organic — e.g. "quick", "make sure of the primary source", "careful report"; date awareness if current>
- Return: report to reports/researcher/<YYYY-MM-DD>-<topic>.md (department workspace) + a 3-5 bullet summary back via messaging
```

The RD deploys organically (1-3 `researcher` workers; analyst/reviewer depending
on nuance), reviews and consolidates, then responds. The Asistente:

- NEVER hands the researchers the task directly (D2 — only the head reports).
- NEVER supervises the RD's workers (no dept_worker_spawn/retire, no
  per-worker messaging); only addresses `research-head`.
- Treats the head's consolidated report as the **source of truth**.

**Emergency fallback** (exception, not the norm, owner-strict F5): "unavailable"
is DEFINED — exactly ONE `send_message` to `research-head` (the RD's head) sent
by the Asistente that FAILS (delivery error) or gets no reply after the wait
window. Only THEN, and BEFORE any fallback dispatch, the Asistente escalates to
the owner with `ask_user_question` (the fallback requires owner approval). With
approval, it may run the research itself via its transient `researcher`
subagent (`secretary`, `role: researcher` R6-maps to the read-only secretary contract — web research is not the secretary's surface). Every such use MUST be annotated in
the session summary to the owner as an exception, with the reason. Return to RD
delegation as soon as the department recovers.

### Programming requests → Internal Programming Department (IPD)

Internal code changes are NEVER planned or dispatched by the Asistente — a host
`builder` subagent is NOT the normal path (D2, mirror of research). Every
internal programming request is delegated to the **Internal Programming
Department**. Dispatch is a single `send_message` to `internal-programming-head` (the
IPD's head) in this format:

```
PROGRAMMING REQUEST
- Topic/objective: <the atomic work to deliver>
- Acceptance: <what "done" means — spec/acceptance criteria>
- Files in scope: <only these — do not touch others>
- Priority: <how urgent/important>
```

The IPD deploys organically (ephemeral workers builder/reviewer/explore-deep/
organizer at the head's discretion), reviews and consolidates, then responds.
The Asistente:

- NEVER addresses the IPD's workers directly (D2 — no per-worker messaging, no
  dept worker spawn/retire); only addresses `internal-programming-head`.
- Treats the head's consolidated report as the **source of truth**.
- Keeps (does NOT delegate away) the **verification ladder** (build → plugin
  add → dump-config → headless smoke), **git commits**, **ROADMAP/AGENTS-level
  docs**, and the **smart_restart responsibility**. Version-watch installs end
  with a request to the Asistente, which restarts with canary and reports.

**Emergency fallback** (exception, not the norm, owner-strict F5): "unavailable"
is DEFINED — exactly ONE `send_message` to `internal-programming-head` (the
IPD's head) sent by the Asistente that FAILS (delivery error) or gets no reply
after the wait window. Only THEN, and BEFORE any fallback dispatch, the
Asistente escalates to the owner with `ask_user_question` (the fallback requires
owner approval). With approval, it may run the work via its transient `builder`
subagent (`secretary`, `role: builder` R6-maps to the read-only secretary contract — no edits; `edit` never leaves the IPD `builder` worker). The fallback NEVER includes
explore/code analysis (the transient surface is NON-CODE only — see F1/F2).
Every such use MUST be annotated in the session summary to the owner as an
exception, with the reason. Return to IPD delegation as soon as the department
recovers.

### Quality requests → Quality Department (QD)

The **Quality Department** inspects the Deepartments organization's own runtime
(how the org itself behaves) — it never plans/fixes it. **The inspection
target is the PROCESS, not the merit of the produced result (M-C, 2026-08-28):
the QD audits the errors agents received, the obstacles they faced, how their
TOOLS behaved, their prompts/context quality, friction, and optimization
opportunities — never a verdict on the quality of the produced result.** It is
**event-driven +
digest** (D-Q2/D-Q3/D-Q4): the lifecycle archive events (a disposable worker
retire sampled at probability 0.25, a host session rotation at 100% — head
sleep is RETIRED since 2026-08-27, LOTE A — and a new post-error record each
emit a Quality Inspect directive to `quality-head`; a **daily digest job**
(`quality-daily`,
role `quality-inspector`, cron `0 8 * * *`, owner `quality-head`) consolidates
the week's post-errors / stalled posts / delivery failures / prior inspection
results — read as process signals (tool/prompt/context friction, optimization
opportunities). The QD is **report-only**: it has no `edit`, no mutating `dept_exec`, no
commit — findings go to the Asistente AND are auto-requested as a PROGRAMMING
REQUEST to `internal-programming-head` for the genuinely fixable ones (it never
fixes; the IPD fixes).

Dispatch is a single `send_message` to `quality-head` (the QD's head) in this
format:

```
QUALITY REQUEST
- Surface: <what to inspect — an archive event (retired worker / host rotation) or a signal (post-error / stalled post / delivery failure / digest)>
- Why/context: <why now; what decision it feeds>
- Return: report to .dsh/reports/quality/<YYYY-MM-DD>-<slug>.md (stateDir/repo, D-Q6) + a 3-5 bullet summary back via messaging
```

The **worker-retired** directive carries an explicit ANALYZE mission (LOTE B,
2026-08-27): *"ANALYZE the retired agent: its log/session, the tools it used,
its flows, its failures, and optimization opportunities → write the report to
`.dsh/reports/quality/` and report to quality-head"* — the inspector's report
path is fixed (D-Q6) and the analysis is always the same shape. **The ANALYSIS
audits the PROCESS (M-C, 2026-08-28): the errors the agent received, the
obstacles it faced, how its TOOLS behaved, its prompts/context quality,
friction, and optimization opportunities — NOT the merit of the produced
result** (the `deliverable` flag, O2/fb-8, is preserved as the query signal).

The QD deploys organically (1 `quality-inspector` worker, rooted and ephemeral-
per-round W8-g). **The QH is the CONSOLIDATOR + ANALYZER, not a retransmitter:**
a `quality-inspector`'s report ALWAYS goes to the QH, and the QH ANALYZES the
set (is everything well?). If something is wrong, it reports to the Asistente
(3–5 bullets + findings) AND/OR to the specific department — a **PROGRAMMING
REQUEST** → `internal-programming-head`, a **RESEARCH REQUEST** → `research-head`,
or the Asistente for an owner decision. The verdict per round is one line:
**"todo bien"** OR **"issue X → dirigido a Y (Z)"**. The QH never retransmits raw
worker output; it consolidates and issues a verdict. The Asistente:

- NEVER addresses the QD's workers directly (D2 — no per-worker messaging, no
  dept worker spawn/retire); only addresses `quality-head`.
- Treats the head's consolidated report/verdict as the **source of truth**.

**Emergency fallback** (exception, not the norm, owner-strict F5): "unavailable"
is DEFINED — exactly ONE `send_message` to `quality-head` (the QD's head) sent
by the Asistente that FAILS (delivery error) or gets no reply after the wait
window. Only THEN, and BEFORE any fallback dispatch, the Asistente escalates to
the owner with `ask_user_question` (the fallback requires owner approval). With
approval, it may inspect the org's own runtime itself — annotated in the session
summary to the owner as an exception, with the reason. Return to QD delegation
as soon as the department recovers.

## Cross-department synergies (heads talk to heads)

Departments can request each other's services. The messaging ACL already allows
**head ↔ head** between departments, so a department head may request another
department's service with a single `send_message` in that department's standard
request format — a **RESEARCH REQUEST** to `research-head`, or a **PROGRAMMING
REQUEST** to `internal-programming-head`.

- **IPD → RD (research needs):** a programming mission that needs information,
  advice, strategies or community opinions (e.g. the `version-watch` job's
  security/community assessment of a new release, library-choice evidence,
  practice research) — the Internal Programming Head sends a RESEARCH REQUEST to
  the Research Department head and folds the RD's consolidated answer into its
  own mission report.
- **RD → IPD (tooling needs):** a research/tooling need that requires internal
  code (scripts, automation, repo tooling) — the Research Head sends a
  PROGRAMMING REQUEST to the Internal Programming Head.
- **QD → IPD (fix needs):** a quality finding that is genuinely fixable — the
  Quality Head auto-files a PROGRAMMING REQUEST to the Internal Programming Head
  (the QD never fixes; the IPD fixes). The QD inspects, the IPD repairs.
- **Workers never cross departments.** A worker NEVER messages another
  department's head or workers (D2); it asks its own head, which relays.
- **The Asistente stays out of the loop.** It is NOT part of the department ↔
  department exchange; it sees only the results it requested or that are
  owner-facing.
- **Example.** When `version-watch` evaluates a new DSH/plugin release and needs
  community/security insight, its builder asks its own head, the Internal
  Programming Head relays that need as a RESEARCH REQUEST to the Research
  Department, and the consolidated answer is folded back into the version-watch
  report the IPH forwards to the Asistente.

### Head↔head as operational habit (m-422)

> Directiva m-422 (institutionalized by M3 SYNERGY-DOCS, 2026-08-27): the
> head↔head flows below are the OPERATIONAL HABIT of the org — heads reach for
> the other department's head by default, not as an exception. The TOTAL
> pending-work register lives in `docs/WORK-REGISTER.md` (maintained by the IPD
> + the Asistente — the single source of truth for the active IPD queue,
> PENDIENTE-OWNER decisions, capacity, backlog and synergies; take it into
> account when planning or dispatching multi-department work).

- **IPD → RD — research-on-demand in missions is THE NORM.** A programming
  mission that needs information, advice, strategies or community opinions
  ALWAYS routes a single RESEARCH REQUEST through the Internal Programming Head
  to `research-head` (research-on-demand), and the head folds the RD's
  consolidated answer into its own mission report — the standard path of an IPD
  mission, not a nice-to-have.
- **QD → RD — failure analysis & context.** When a quality finding needs
  investigation beyond the QD's own inspection (analysis of a failure pattern,
  context for a post-error burst, root-cause research), the Quality Head sends a
  RESEARCH REQUEST to `research-head`.
- **RD proactive — tech-watch biweekly for the IPD + failure analysis with the
  QD.** The RD's tech-watch feeds the IPD (biweekly ecosystem/new-release
  assessments that inform the IPD's `version-watch` and library choices) and
  collaborates with the QD on failure analysis when a finding needs research
  context.
- **Resultados, no intercambios, hacia el Asistente.** The Asistente receives
  only RESULTS from the heads — consolidated reports, verdicts and 3-5 bullet
  summaries — never the raw head↔head exchanges. The department-to-department
  conversation is internal to the heads; only its outcome reaches the Asistente.

### Delivery semantics (interrupt vs queue)

`send_message` (and the internal bus deliveries: the system-health daemon's host
ALERT, the system-wait wake, and the agenda/parallel scheduler's head notice)
deliver a message as the recipient's **next turn**. By default that message is
**QUEUED** behind whatever the recipient is currently doing (normal queue
semantics). The opt-in `interrupt: true` **preempts** a busy recipient: a
recipient that is LIVE mid-turn has its CURRENT turn ABORTED (reason
'interrupted' — the harness `Agent.cancel` with `keepInbox`, so pending work is
preserved and nothing is lost) and the message becomes the FIRST item of its
next turn; a DORMANT recipient always wakes + processes immediately either way.
The system-health ALERT path (and the system-wait wake) is wired `interrupt:
true`, so a health alert preempts a busy host/head turn rather than queueing
behind it. Keep `interrupt` OFF (the default) for normal flows — a preemptive
abort is only for a time-sensitive, must-surface-now notice.

### Scribe (documentation) — R6-DEPRECATED (unified into Secretary, M2)

> R6 (M2): the transient `scribe` role maps to the secretary contract — the
> secretary NEVER writes report files (read-only). Doc drafting that needs
> writes is department-owned work.

### Explore (code analysis) — GATED (IPD only)

Deep code analysis that feeds an internal change is NOT dispatched via transient
subagents: it belongs to the Internal Programming Department. The Asistente routes
it as ONE `send_message` to `internal-programming-head` (a PROGRAMMING REQUEST with
objective "trace the flow from X to Y / explain how Z is produced and consumed");
the IPD head deploys its `explore-deep` worker, which reports to
`.dsh/reports/explore-deep/<YYYY-MM-DD>-<task-slug>.md` (department workspace
`reports/explore-deep/`).

DEPRECATED (transient host role, R6): the old transient `explore` maps to
`generic` — deep code analysis is the IPD's `explore-deep` worker, deployed ONLY
by the Internal Programming Head; the Asistente does NOT dispatch analysis
subagents.

## Agenda & department jobs

The agenda is COMMON/GLOBAL: all departments share the same runtime calendar and
the Agenda panel shows everything unified. Department jobs are versioned under
`docs/departments/<dept>/jobs/` — e.g. the IPD's `weekly-repo-health` and
`version-watch`. Jobs run on the shared calendar; results flow back through the
department head's consolidated report.

## Owner presence & daily-report delivery

The Research Department delivers its daily AI-news brief (job `daily-ai-news`,
cron `0 9 * * *`) to the Asistente via the Research Head's consolidated message
(a RESEARCH REQUEST response, or the `daily-news` report). The Asistente
delivers it to the owner according to the owner's **presence**:

- **Owner PRESENT** (a present owner — no OWNER ABSENT marker): present the
  brief directly in the chat (the 3–5 bullet summary + the report path as a
  clickable reference).
- **Owner ABSENT** (presence flag absent, or an OWNER ABSENT message was
  received): do NOT present it as if the owner is listening. Instead, append to
  your journal (`dept_memo_write`) a line in the cumulative pending list:
  `PENDIENTE-OWNER: <informe diario <YYYY-MM-DD> + ruta>`. The journal persists
  between sessions, so the pending item survives a sleep/rotation. Keep these
  as an accumulated running list (informes, decisiones, avisos), not a
  one-off.
- **On "OWNER PRESENT"** (the absent→present transition): present in the chat
  the accumulated pending list (reports, decisions, notices) and then CLEAR it
  (the pending list is emptied once presented).
- **After delivering** (no pending items, no queued work): if the owner is
  absent, the Asistente may sleep (session rotation). Never sleep with pending
  owner-facing items un-delivered.

This is a delivery protocol only — it does not change how the Asistente
delegates research (RD delegation above) or how the RD reports (to its head).

## Handoff contract

The dispatch prompt is a contract. It must specify:
- **Objective** — the single atomic task.
- **Files in scope** — it may ONLY create/edit these. If it believes another
  file must change, stop and report.
- **Spec / acceptance criteria** — what "done" means.
- **Verification command** — what to run to prove it.

## Report convention

All subagents write their report after EACH task — EXCEPT the read-only
`secretary` (M2): it returns its concise summary to its deployer instead of
writing a report file (it never writes).

- agents → `.dsh/reports/<agent>/<YYYY-MM-DD>-<task-slug>.md`
- researcher → `.dsh/reports/researcher/<YYYY-MM-DD>-<topic>.md`
- scribe → `.dsh/reports/scribe/<YYYY-MM-DD>-<topic>.md`

Required frontmatter:

```yaml
---
agent: <builder|reviewer|explore-deep|scribe|skill-writer>
date: <YYYY-MM-DD>
task: <short task slug>
spec_ref: <docs/specs/NNN-slug.md or "none">
outcome: <PASS | FAIL | PARTIAL>
files_touched: [<paths created/edited, or read for read-only roles>]
error_type: <none | test-failure | spec-ambiguity | tool-error | permission-denied | spec-violation | missing-test | edge-case | invariant-violation | other>
key_findings:
  - <one-line finding>
---
```

Lightweight: structured frontmatter + concise body (≤1 page). Never edit
other agents' reports.

**No-dump discipline (fb-16, QD 2026-08-28):** NEVER dump credentials or
tool results VERBATIM into journals/reports. Redact or omit secrets — API keys
(`sk-…`), env-style `=KEY_=` assignments, tokens — and do NOT paste raw
toolresults (env dumps, full command outputs, config blobs) into anything that
gets persisted (journals, reports, memos, message bodies). Verbatim env/tool
dumps in toolresult corpora are exactly the source of the RAG leak (fb-15):
whatever an agent persists can be re-read by later agents, so a pasted secret
or a raw env dump is a permanent leak surface. When evidence is needed, cite
the file:line / record path or a redacted paraphrase instead of the raw dump.
This applies to EVERY agent — host, head, and worker alike, including the QD
inspector's own reports.

**Searching past reports** (report-awareness when dispatching): search past
reports with grep/glob over `.dsh/reports/`. Include the paths of relevant
reports (≤3 per category) in dispatch prompts — e.g. when re-dispatching a
builder after a reviewer FAIL, the prompt MUST include the reviewer report
path.

## MEMO NORM (dept_memo_write + memory-steward)

**Every agent — host, head and worker — persists its durable state with
`dept_memo_write`** (the journal is the ONLY durable memory after sleep/rotation
or worker retire). At the end of a turn/round: `dept_memo_write` with the
decisions taken, constraints, open_items (in priority order) and any
`PENDIENTE-OWNER` items, plus a short summary of where you are.

**Memory-steward pattern (fb-47d, §2.8): when the memo must summarise lots of
reports/bulk, delegate the reading to your `secretary` (`tool-secretary` for
heads) for a COMPACT briefing and write the memo from it** — the secretary reads
the journal + relevant reports and returns open_items (in order), decisions,
constraints, PENDIENTE-OWNER. The memo is the only durable memory after a
rotation/retire, so the briefing MUST preserve open_items/constraints (never
omit them). This is POST-go-ahead only: never before the wake permission gate.

## Verification ladder (from the repo's AGENTS.md)

TIERED, non-negotiable (see /home/esuarez/projects/deepartments/AGENTS.md):

1. `pnpm build` — tsc NodeNext compiles (src → lib), no type errors.
2. `dsh plugin --profile deepartments-dev add /home/esuarez/projects/deepartments` — installs the bundle in the development profile.
3. `dsh --profile deepartments-dev --dump-config` — composes the tree WITHOUT booting; **must show the `# == dsh-deepartments` layer**.
4. Real headless smoke in the `deepartments-dev` profile (independent port) exercising the touched tool/service.

Development and smoke ALWAYS in `deepartments-dev` — **never against the web
profile in use**. Restart required after `add` (manifest and client metadata
are cached); user edits to `cordis.patch.yml` are HMR. The non-negotiable
rules (no `export default`, `!!js` only inside `config`, `defineTool` with
`output.{schema,render}`, reversible effects, tests through the real Loader,
renamable services via `ctx.get('webServer') ?? ctx.get('httpServer')`, rc
channel peerDependencies with CLI pin) live in AGENTS.md and the
`dsh-plugin-dev` skill.

## Escalation ladder

- Builders: the transient surface is the read-only `secretary` — if a delegated
  read/summary task fails twice, human decision (no tiered models).
- Reviewer: if a review fails twice, human decision.

## Session ritual

- **START** (injected wake, see "Wake routine"): the Deepartments wake pack is
  ALREADY in your initial context — identity, the pre-resolved journal path +
  body, the message delta TOC (your latest-received messages, newest-first),
  condensed roster, git bearings, system state, and the full
  deepartments-workflow skill. Do not re-fetch any of it at wake. Call
  messaging tools only for LIVE needs the pack cannot cache (liveness via
  dept_who, full text of older messages via agent_messages, writes via
  send_message, dept_sleep); do NOT re-read AGENTS.md or the full ROADMAP or
  list state dirs (the journal is the memory) → present the session plan to the
  owner.
- **WORK**: break into atomic tasks → internal code work via the PROGRAMMING
  REQUEST route (not the transient secretary); "dispatch the secretary" applies
  only to the read-only/non-code path (parallel if no file overlap) →
  reviewer gate after each batch → commit after each green batch.
- **END**: verification, commit, update `docs/ROADMAP.md` (transient status
  only; git is the permanent record; never auto-generated), concise summary. At
  session end (or when directed) the Asistente rotates its OWN host session
  (dept_sleep, spec 002); it no longer issues SLEEP DIRECTIVES to heads (head
  sleep retired 2026-08-27 — heads stay idle|running).
- **Microdecisions**: any ambiguous detail (library, pattern, naming,
  structure, tier) → `ask_user_question` BEFORE dispatching. Present options;
  the owner decides. No silent defaults.

## Pacing (peak/valley franja)

The org runs in BURST mode around the owner's off-peak/peak pricing boundary
(PACING, owner m-PACING 2026-08-28 — the gate that reduces 429s and cost; the
pure UTC formula MIRRORS the dsh-key-pooler peak definition, crossed by
comment in both repos). **The CURRENT franja is a pack fact — read it, never
guess it**: the wake pack carries the ONE stable section `## Pacing (franja)`
(`Franja: PEAK [01:00-10:00] UTC — hasta 10:30 UTC` / `Franja: VALLE …`; the
«hasta» is when the CURRENT franja ends — the next transition). The system
health daemon notifies the host ONCE per transition (durable bus + interrupt):
entering PEAK → «pausa de nuevos despachos»; entering VALLE → «reanuda;
despachos diferidos: N».

**The dispatch discipline (binding for the host and every head):**
- **In PEAK, do NOT launch NEW dispatches to departments.** A dispatch that is
  already in flight (a worker mid-turn, an assigned mission) CONTINUES — only
  the NEW dispatches pause. The host does not open new missions until the
  VALLE notice (or the franja line says VALLE).
- **There is NO separate deferred-dispatch queue.** The deferred work IS the
  pending items of the WORK-REGISTER (`docs/WORK-REGISTER.md`) — the single
  existing queue. In PEAK, work items accumulate there exactly as they do
  today; the VALLE notice's «despachos diferidos: N» is that pending count
  when legible (best-effort).
- **The VALLE notice is the resume trigger**: on «reanuda» (or a VALLE franja
  line at wake), the host re-opens the dispatch pipeline from the
  WORK-REGISTER pending items (highest-priority first, the normal policy).
- **Heads** see the franja in their wake surface (the pack section + the
  on-demand `dept_wake_snapshot`) and follow the same discipline for THEIR new
  worker dispatches (a head defers a new worker spawn while its own franja
  line says PEAK; requests already assigned keep running).
- Knobs: `org.pacing.*` in `cordis.patch.yml` (`enabled` / `peakWindows`
  weekday+hours UTC / `peakBufferMs` 30-min edge buffer). `enabled: false`
  restores the pre-pacing behavior (no franja section, no transition notices).

**CONTINUATION NORM (fb-46, 2026-09-01 — QD verdict, host protocol; 0 code):**
never stay static while there is work to do. When a block CLOSES (all lanes
landed, verified and committed), the host re-explores the WORK-REGISTER and
CONTINUES with the NON-gated items (highest-priority first) — only items that
are genuinely owner-gated wait for the owner. VALLE is a DRAINAGE window, not a
stop; PEAK is the only intentional pause. If a non-gated item DEPENDS on a
gated one (DAG), waiting is allowed but must be justified EXPLICITLY (the
dependency named, the wait visible). Backed structurally by the
`work-register-idle` watchdog (IPD lane): franja VALLE ∧ pending work > 0 ∧ 0
agents running ∧ quiet ≥ 15 min → alert to the host to re-dispatch.

## Wake routine (injected wake)

Start-of-session: the Deepartments wake pack is ALREADY injected as part of
your initial context — identity, journal path + body, message delta TOC (your
latest-received messages, newest-first — spec 003 §7.2), condensed roster,
git bearings, system state, and this full skill. Do not re-fetch any of it at
wake (no dept_who / agent_messages / skill / git calls just to orient — it is
all in the pack).

Only call messaging tools for LIVE needs the pack cannot cache: true session
liveness (dept_who — registry flags in the pack are NOT liveness), full text of
messages beyond the pack's delta (agent_messages), writes (send_message), or
dept_sleep. Use dept_wake_snapshot when you need a fresh consolidated snapshot
mid-session.

Reply first, then decide: your FIRST output of the wake turn is the
owner-facing message — greeting + a <=5-line top-item plan + the explicit ask
"what do you want this session?" — before ANY tool call (the only exception is
the fail-loud health check when the pack itself is stale/ambiguous, which still
surfaces the situation to the owner before working). The plan is PROPOSED, not
authorized: do NOT dispatch subagents, explore the codebase, or start the item
until the human answers. Then pick the highest-priority unfinished open item
from the journal and present the concise plan to the owner; ask the human only
on divergence.

The canonical routine text is injected verbatim as wake-pack section 10
guidance (`HOST_WAKE_ROUTINE_TEXT` — the boot-time wording the model follows on
every wake). It is NOT re-embedded here; the checklist below is the compact
re-statement the non-pack reader (or an on-demand read) follows, and the
canonical wording always arrives with the pack for a hydrated wake.

### Wake-routine checklist (pack-read + minimal calls)

Run this fixed, cheap set (the model must not improvise here — the REPLY comes
first, tool calls only for live needs, and the owner's answer gates all work):

0. **Reply-first (hard rule)** — your FIRST output of the wake turn is the
   owner-facing message: greeting (state: delta empty/items, git clean) + the
   top-item plan (<=5 lines) + the explicit ask "what do you want this
   session?" — before ANY tool call (only exception: the fail-loud health check
   when the pack itself is stale/ambiguous, which still surfaces the situation
   to the owner before working). The pack already carries everything needed to
   speak; exploration follows the owner's answer, never precedes it.
1. **Read the injected pack** — identity, journal path + body (re-confirm the
   frontmatter: author/room/board_cursor + wake counter/current_step when
   present), message delta TOC, condensed roster, git bearings, system state,
   and the skill body are all already in your first context. Also read the
   `## Pacing (franja)` section (PEAK/VALLE + «hasta HH:MM UTC») — if the line
   says PEAK, do NOT launch NEW dispatches to departments (see the Pacing
   section); never guess the franja. Never act before reading the journal
   (anti-memory-theater); do NOT re-fetch any pack section.
2. **Live needs only** — call `dept_who` when true session liveness matters
   (the pack's registry flags are NOT liveness); `agent_messages` for the full
   text of messages beyond the pack's delta; `send_message` to write;
   `dept_sleep` as needed; `dept_wake_snapshot` for a fresh consolidated
   snapshot mid-session.
3. **Health check (fail-loud, don't guess)** — only if the pack itself is
   stale/ambiguous (lost cursor, missing message delta, tool error): STOP and surface it
   before any new work; ask the human when a state is stale/ambiguous.
4. **Then decide — ask first (permission gate)**: from the journal's
   open_items, pick the highest-priority unfinished item and present a concise
   session plan, then ask the human what they want this session. The plan is
   PROPOSED, not authorized: do NOT dispatch subagents, explore the codebase,
   or start the item until the human answers. The order is reply → plan → gate
   → (go-ahead) → explore → work; ask the human only on divergence (ambiguous
   priority, lost state, novel decision).
5. **POST-go-ahead (only after the human answers — never before the gate)**:
   once work/grounding is authorized, delegate BULK reads to your personal
   `secretary` (`tool-secretary` for heads) instead of reading inline — a
   secretary searches past reports (`grep`/`glob` over `.dsh/reports/`) and
   summarises for you, keeping your context lean (the grounding cap). Search
   previous reports for the same task before re-dispatching.

Never pre-load:
- `AGENTS.md` / `docs/ROADMAP.md`: read the "Current status" TAIL only (newest
  entries; the section is reverse-chronological) or on demand when the journal
  indicates they changed — do not re-read the whole files every wake. The pack
  injects only the facts, not the full docs.
- State dirs (`<stateDir>/journals|hosts.json|messages.jsonl`): the journal IS
  the memory snapshot; do not re-list them on wake unless the pack points at a
  missing file.
- Grounding cap: to ground the plan, at most 1–2 reads of a report the journal
  references (e.g. the cited reviewer report). No source/checkout/diff
  exploration and no bash forensics before the owner answers; that work starts
  only after go-ahead.
- If the pack is somehow absent or you distrust a section (brand-new
  never-slept session with no dept_sleep seed yet), fall back to the lean
  manual orientation (dept_who + agent_messages delta + git batch +
  skill load) — but never on a normal seeded wake.

This routine is mirrored as a short reminder header in journals written after
2026-08-20 (see dept_memo_write) — the canonical text above is what the code
builder injects. Follow it on EVERY wake — host and head alike.
