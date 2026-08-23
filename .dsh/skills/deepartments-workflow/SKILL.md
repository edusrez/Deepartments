---
name: deepartments-workflow
description: Multi-agent workflow for the Deepartments project — Asistente (the main agent) + builders + reviewer + scribe + explore, with research delegated to the Research Department (RD). Use it when planning or executing multi-agent code changes, when dispatching subagents, or when resuming a session of this project. Port of the multi-agent-workflow pattern to DeepSeek Harness.
---

# Deepartments — Multi-Agent Workflow (DSH)

This project uses a conversational Asistente + parallel subagents pattern.
The human talks to the main agent (the Asistente); the Asistente asks
microdecisions and organizes planning and parallel execution via subagents.
Research is NOT run by the Asistente: it is delegated to the Research
Department (RD) — see "Research requests → Research Department (RD)".

## Roster

| Role | Dispatch tool | Model | Notes |
|-----|----------------|-------|-------|
| **Asistente** (the main agent, Pro) | (this agent) | Pro | All tools, but NEVER edits; conversation, planning, microdecisions, dispatch |
| **builder** | `subagent` | deepseek-v4-flash-vision-exp | Atomic edits with a clear spec; ALL builders run Flash, no Pro tier |
| **reviewer** | `subagent` | deepseek-v4-flash-vision-exp | Read-only verifier after each builder/batch; PASS/FAIL |
| **scribe** | `subagent` | deepseek-v4-flash-vision-exp | Doc drafts to `.dsh/reports/scribe/` (never auto-commits) |
| **explore** | `subagent` | deepseek-v4-flash-vision-exp | Read-only; code search, flow analysis |

There is no rigid roster: every subagent is dispatched via `subagent` or
`subagent_fork` (all Flash-tier, defaulting to `deepseek-v4-flash-vision-exp`
via the direct DeepSeek API — provider `deepseek-official`, reasoning_effort
`max`, endpoint/API key wired in the dev profile; stable profile untouched).
The `_fork` variants
inherit the conversation: use them for context-inheriting follow-ups. The
per-role contract is NOT re-written into the prompt — it is INJECTED at the
child's first pre-step from the bundled ROLE_CONTRACTS map (Task T4): pass the
`role` param and the dispatch prompt stays objective+files+spec+verification.
The Asistente is the only Pro agent.

## Key principles

- **Microdecisions**: the Asistente asks with `ask_user_question` before
  assuming defaults. No silent conventions.
- **One file, one owner**: parallel builders never touch the same file.
- **Verify, don't trust**: reviewer + real verification, every batch.
- **Never auto-commit docs**: scribe drafts to `.dsh/reports/scribe/`, the
  human merges.
- **Escalate, don't trash**: if a builder (Flash) fails twice, human
  decision (no Pro tier).
- **Specs first**: write/update the spec before implementing.
- **Reports are inter-agent memory**: dispatch prompts reference paths of
  previous reports instead of re-dumping context.
- **Always-async delegation.** The subagent tools
  (`subagent`/`subagent_fork`) have no blocking mode: every dispatch returns
  a child id immediately and the settlement notice wakes the Asistente when
  the child finishes. Dispatch
  independent builders in parallel in one message; continue dependent work
  only when the notice arrives; never wait inline or busy-poll. Use
  `send_message` for follow-up turns in the same child conversation.

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
role with the `role` param on `subagent`/`subagent_fork`
(builder|reviewer|scribe|explore; `researcher` = emergency RD-fallback only;
default generic). Unknown roles fall back to generic.

### Builder (default tier)

Dispatched via `subagent` (Flash model, `role: builder`) — the default for
atomic edits with a clear spec.

> Your role contract (builder) is injected by Deepartments — follow it.
> - **Objective**: <one atomic task>.
> - **Files in scope**: <only these — do not touch others>.
> - **Spec / acceptance**: <what "done" means>.
> - **Verification**: <exact command — run EXACTLY, iterate minimally until
>   green; after 2 retries STOP and report>.
> - **Report**: `.dsh/reports/builder/<YYYY-MM-DD>-<task-slug>.md` (frontmatter
>   convention below) + a concise Summary/Changes/Verification/Risks back to the
>   Asistente.

### Builder — hard/architectural tasks

No Pro tier: ALL builders run Flash via `subagent` (`role: builder`) with the
same contract. Hard/architectural tasks are dispatched exactly like default
builders, with a tighter spec and more granular verification steps.

### Reviewer (read-only)

Dispatched via `subagent` (Flash model, `role: reviewer`), after a builder.

> Your role contract (reviewer) is injected by Deepartments — follow it.
> - **Diff scope**: <the exact touched files + spec>.
> - **Verdict**: PASS (1-2 line note) or FAIL (each failure file:line + one-line
>   fix) in ≤30 lines. Read-only: do NOT fix anything.
> - **Report**: `.dsh/reports/reviewer/<YYYY-MM-DD>-<task-slug>.md` (frontmatter
>   convention below) + the verdict back to the Asistente.

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

**Emergency fallback** (exception, not the norm): ONLY if the RD is unavailable
(`research-head` asleep with no reply, department down) may the Asistente run
research itself via its transient `researcher` subagent (`subagent`,
`role: researcher`). Such use MUST be annotated in the session summary to the
owner as an exception, with the reason. Return to RD delegation as soon as the
department recovers.

### Scribe (documentation)

> Your role contract (scribe) is injected by Deepartments — follow it.
> - **Draft to** `.dsh/reports/scribe/<YYYY-MM-DD>-<topic>.md` ONLY.
> - **Return**: a 3-line summary — what you drafted, where, which proposals need
>   a decision.

### Explore (code analysis)

> Your role contract (explore) is injected by Deepartments — follow it.
> - **Question**: <trace the flow from X to Y / analyze how Z is produced and
>   consumed / explain the interaction between A and B>.
> - **Report**: write to
>   `.dsh/reports/explore-deep/<YYYY-MM-DD>-<task-slug>.md`; return a concise
>   flow/architecture summary + key files (file:line) back to the Asistente.

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

All subagents write their report after EACH task:

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

**Searching past reports** (report-awareness when dispatching): search past
reports with grep/glob over `.dsh/reports/`. Include the paths of relevant
reports (≤3 per category) in dispatch prompts — e.g. when re-dispatching a
builder after a reviewer FAIL, the prompt MUST include the reviewer report
path.

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

- Builders: builder (`subagent`, Flash). If a builder fails twice, the
  Asistente asks the human for a decision (no Pro tier).
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
- **WORK**: break into atomic tasks → dispatch builders (parallel if no file
  overlap) → reviewer gate after each batch → commit after each green batch.
- **END**: verification, commit, update `docs/ROADMAP.md` (transient status
  only; git is the permanent record; never auto-generated), concise summary.
- **Microdecisions**: any ambiguous detail (library, pattern, naming,
  structure, tier) → `ask_user_question` BEFORE dispatching. Present options;
  the owner decides. No silent defaults.

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

The canonical routine text (injected verbatim as wake-pack section 9 guidance
and mirrored here — the boot-time wording the model follows on every wake):

> Start-of-session: your Deepartments context injection already carries identity,
> the pre-resolved journal path + journal body, the message delta TOC (your
> latest-received messages, newest-first), the condensed roster, git bearings,
> system state, and the full deepartments-workflow skill.
> Read it — do not re-fetch what the pack provides. Only call messaging tools for
> LIVE needs the pack cannot cache: true session liveness (dept_who), full text of
> messages beyond the pack's delta (agent_messages), writes (send_message), or
> dept_sleep.
> REPLY FIRST: your first output of the wake turn is the owner-facing message —
> greeting + a <=5-line top-item plan + the explicit ask "what do you want this
> session?" — before ANY tool call (the only exception: the fail-loud health check
> when the pack itself is stale/ambiguous, which still surfaces the situation to
> the owner before working). The plan is PROPOSED, not authorized: do NOT dispatch
> subagents, explore the codebase, or start the item until the human answers; to
> ground the plan, at most 1–2 reads of a journal-referenced report and zero
> src/checkout exploration or bash before go-ahead. Then pick the highest-priority
> unfinished open item, present a concise plan, and WAIT for the owner's answer
> before working. Full sequence: skill deepartments-workflow ("Wake routine").

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
   present), message delta TOC, condensed roster, git bearings, system state, and
   the skill body are all already in your first context. Never act before
   reading the journal (anti-memory-theater); do NOT re-fetch any pack section.
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
