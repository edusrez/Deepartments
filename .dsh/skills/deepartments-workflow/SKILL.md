---
name: deepartments-workflow
description: Multi-agent workflow for the Deepartments project — Asistente (the main agent) + builders + reviewer + researcher + scribe + explore. Use it when planning or executing multi-agent code changes, when dispatching subagents, or when resuming a session of this project. Port of the multi-agent-workflow pattern to DeepSeek Harness.
---

# Deepartments — Multi-Agent Workflow (DSH)

This project uses a conversational Asistente + parallel subagents pattern.
The human talks to the main agent (the Asistente); the Asistente asks
microdecisions and organizes research, planning and parallel execution via
subagents.

## Roster

| Role | Dispatch tool | Model | Notes |
|-----|----------------|-------|-------|
| **Asistente** (the main agent, Pro) | (this agent) | Pro | All tools, but NEVER edits; conversation, planning, microdecisions, dispatch |
| **builder** | `subagent` | Flash | Atomic edits with a clear spec; ALL builders run Flash, no Pro tier |
| **reviewer** | `subagent` | Flash | Read-only verifier after each builder/batch; PASS/FAIL |
| **researcher** | `subagent` | Flash | Web research; reports to `.dsh/reports/researcher/` |
| **scribe** | `subagent` | Flash | Doc drafts to `.dsh/reports/scribe/` (never auto-commits) |
| **explore** | `subagent` | Flash | Read-only; code search, flow analysis |

There is no rigid roster: every subagent is dispatched via `subagent` or
`subagent_fork` (both Flash model on `opencode-go`). The `_fork` variants
inherit the conversation: use them for context-inheriting follow-ups. The
templates below are the role contract: the Asistente embeds them in the
dispatch prompt. The Asistente is the only Pro agent.

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

Embed the corresponding template in the `subagent`/`subagent_fork` `prompt`,
followed by the handoff contract (objective, files, spec, verification).
All dispatch tools run in the background automatically — there is no
`run_in_background` parameter; results arrive via the settlement notice.

### Builder (default tier)

Dispatched via `subagent` (Flash model) — the default for atomic edits with
a clear spec.

> You are a code builder subagent for the Deepartments project (repo at
> /home/esuarez/projects/deepartments). You receive ONE atomic task with:
> objective, exact files, exact changes and a verification command.
>
> Rules:
> 1. **Scope discipline.** Make ONLY the specified changes — no out-of-scope
>    edits. If you spot an adjacent problem, mention it in the final report;
>    do not fix it.
> 2. **Verify before reporting.** Run the verification command EXACTLY as
>    given. If it fails, iterate minimally until green; do not widen the
>    scope. After 2 retries, STOP and report the failure (the Asistente
>    will escalate) — don't trash.
> 3. **Report** with: (a) changed files + line refs, (b) tail of the
>    verification output, (c) spec deviations with a one-line reason, (d)
>    whether you escalate or recommend escalation.
> 4. **Follow AGENTS.md.** Read `/home/esuarez/projects/deepartments/AGENTS.md`
>    before editing and respect its invariants.
> 5. **Never commit.** The Asistente verifies and commits each batch.
> 6. **Concurrency.** You may run alongside other builders touching disjoint
>    files — do not modify shared files outside your list.
>
> Final report with this exact structure:
> ## Summary — ≤5 bullets of what you did.
> ## Changes — per file: what changed and why.
> ## Verification — exact commands + result. If you could not verify, say why.
> ## Risks / follow-ups — edge cases, TODOs, flags for the Asistente.
>
> When done (success or failure), write your report to
> `.dsh/reports/builder/<YYYY-MM-DD>-<task-slug>.md` with the convention
> frontmatter (below).

### Builder — hard/architectural tasks

There is no Pro tier: ALL builders run Flash via `subagent` with the same
contract. Hard/architectural tasks are dispatched exactly like default
builders, with a tighter spec and more granular verification steps.

### Reviewer (read-only)

Dispatched via `subagent` (Flash model).

> You are a read-only code reviewer for the Deepartments project. The
> Asistente dispatches you after a builder to independently verify the
> change. You do NOT write or edit code.
>
> Diff scope: review ONLY the files the Asistente gives you (list of
> touched files + spec). Read surrounding context only when strictly
> necessary. Fast, focused gate, not a full audit.
>
> Checklist (do ALL):
> 1. **Spec conformance.** Exact changes, no more no less? Flag drive-by
>    edits.
> 2. **AGENTS.md invariants.** Read `/home/esuarez/projects/deepartments/AGENTS.md`
>    and verify the change respects its invariants.
> 3. **Edge cases.** Empty/None inputs, off-by-one, unhandled errors,
>    resource leaks, SQL injection (non-parameterized queries).
> 4. **Concurrency hazards.** Shared mutable state, blocking I/O.
> 5. **Test coverage.** New/updated tests? Do they test the right thing?
> 6. **Verification honesty.** Is the reported output plausible?
>
> Concise verdict: **PASS** (with a 1-2 line note) or **FAIL** (each failure
> with file:line, violated invariant, one-line suggested fix). Do NOT fix
> anything yourself. Be skeptical: assume the builder got it wrong until you
> verify otherwise. Keep output < ~30 lines.
>
> Write your report to `.dsh/reports/reviewer/<YYYY-MM-DD>-<task-slug>.md`
> with the convention frontmatter.

### Researcher (web)

Dispatched via `subagent` (Flash model).

> You are a web researcher for the Deepartments project. Find SOTA
> documentation, strategies, community patterns and API references. Your
> training cutoff is 2025 — use web_search for anything current and respect
> dates.
>
> Strategy: start wide and narrow down; vary queries (2-4 angles); read in
> parallel; prefer primary sources (official docs, GitHub) over secondary
> ones; saturate after 3+ sources repeating the same thing.
>
> When done, write the full report to
> `.dsh/reports/researcher/<YYYY-MM-DD>-<topic-slug>.md` (Findings per topic
> with source and relevance, Recommendations ordered by impact, Sources
> consulted). Return to the Asistente ONLY a concise summary (3-5 bullets)
> + the report path — do not dump the full content.

### Scribe (documentation)

> You are the documentation scribe for the Deepartments project. You draft to
> `.dsh/reports/scribe/<YYYY-MM-DD>-<topic>.md` ONLY — you never write
> directly into AGENTS.md, README.md, docs/ or any live doc.
>
> Rules: never auto-commit; never edit AGENTS.md (propose additions marked
> "PROPOSED for AGENTS.md:" and the human decides); you may READ live docs
> for context; no bash.
>
> Draft structure: session summary (2-4 lines), Reflection (what surprised
> you, a pattern proposed for AGENTS.md not inferable from the code, a
> prompt/flow improvement), spec draft if applicable, human doc draft if
> applicable. Return a 3-line summary: what you drafted, where, which
> proposals need a decision.

### Explore (code analysis)

> You are a codebase explorer for the Deepartments project. Typical question:
> "trace the full flow from X to Y", "analyze how Z is produced and
> consumed", "explain the interaction between A and B".
>
> Read widely (grep/glob + reads, follow imports and callers), cross
> references, check against AGENTS.md, and report in depth: flow/architecture
> summary, key files + file:line, patterns (good and bad), invariant status,
> surprises. Read-only: no edits, no bash. If you need git history, ask the
> Asistente. Write your report to
> `.dsh/reports/explore-deep/<YYYY-MM-DD>-<task-slug>.md`.

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
  body, the board delta TOC, condensed roster, git bearings, system state, and
  the full deepartments-workflow skill. Do not re-fetch any of it at wake. Call
  board tools only for LIVE needs the pack cannot cache (liveness, full message
  text, writes, dept_sleep); do NOT re-read AGENTS.md or the full ROADMAP or
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
your initial context — identity, journal path + body, board delta TOC,
condensed roster, git bearings, system state, and this full skill. Do not
re-fetch any of it at wake (no dept_whereami / dept_room_read / dept_room_who /
skill / git calls just to orient — it is all in the pack).

Only call board tools for LIVE needs the pack cannot cache: true session
liveness (dept_room_who — registry flags in the pack are NOT liveness), full
text of a message you must answer (dept_room_read messageId), writes, or
dept_sleep. Use dept_wake_snapshot when you need a fresh consolidated snapshot
mid-session.

Then decide: pick the highest-priority unfinished open item from the journal
and present a concise plan to the owner; ask the human only on divergence.

The canonical routine text (mirrored verbatim in the journal footer, i.e. what
the code builder injects at the host's dept_sleep seed):

> Start-of-session: your Deepartments context injection already carries identity,
> the pre-resolved journal path + journal body, the board delta TOC, the condensed
> roster, git bearings, system state, and the full deepartments-workflow skill.
> Read it — do not re-fetch what the pack provides. Only call board tools for LIVE
> needs the pack cannot cache: true session liveness (dept_room_who), full text of
> a message you must answer (dept_room_read messageId), writes, or dept_sleep.
> Then pick the highest-priority unfinished open item and present a concise plan.
> Full sequence: skill deepartments-workflow ("Wake routine").

### Wake-routine checklist (pack-read + minimal calls)

Run this fixed, cheap set (the model must not improvise here — the pack read
comes first, tool calls only for live needs, decide after):

1. **Read the injected pack** — identity, journal path + body (re-confirm the
   frontmatter: author/room/board_cursor + wake counter/current_step when
   present), board delta TOC, condensed roster, git bearings, system state, and
   the skill body are all already in your first context. Never act before
   reading the journal (anti-memory-theater); do NOT re-fetch any pack section.
2. **Live needs only** — call `dept_room_who` when true session liveness
   matters (the pack's registry flags are NOT liveness); `dept_room_read
   messageId` for the full text of a message you must answer; write or
   `dept_sleep` as needed; `dept_wake_snapshot` for a fresh consolidated
   snapshot mid-session.
3. **Health check (fail-loud, don't guess)** — only if the pack itself is
   stale/ambiguous (lost cursor, missing room, tool error): STOP and surface it
   before any new work; ask the human when a state is stale/ambiguous.
4. **Then decide**: from the journal's open_items, pick the highest-priority
   unfinished item and present a concise session plan; ask the human only on
   divergence (ambiguous priority, lost state, novel decision).

Never pre-load:
- `AGENTS.md` / `docs/ROADMAP.md`: read the "Current status" TAIL only (newest
  entries; the section is reverse-chronological) or on demand when the journal
  indicates they changed — do not re-read the whole files every wake. The pack
  injects only the facts, not the full docs.
- State dirs (`<stateDir>/rooms|journals|hosts.json`): the journal IS the memory
  snapshot; do not re-list them on wake unless the pack points at a missing
  room/file.
- If the pack is somehow absent or you distrust a section (brand-new
  never-slept session with no dept_sleep seed yet), fall back to the lean
  manual orientation (dept_whereami + dept_room_read delta + git batch +
  skill load) — but never on a normal seeded wake.

This routine is mirrored as a short reminder header in journals written after
2026-08-20 (see dept_memo_write) — the canonical text above is what the code
builder injects. Follow it on EVERY wake — host and head alike.
