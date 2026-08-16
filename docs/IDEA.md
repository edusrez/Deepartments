# IDEA — the agentic organization as a layer over DeepSeek Harness

> The "turn": instead of talking to a single agent that dispatches subagents,
> you talk to a **team of agents** — an organization that specializes over
> time and can change its own structure. This document reframes the original
> idea **adapted to the DeepSeek Harness (DSH) harness**: each concept
> describes its nature and its mechanism "in DSH". The decisions and the
> detailed mapping live in [concept.md](concept.md); the plan in
> [ROADMAP.md](ROADMAP.md).

## Nature: a generic, self-mutating organization over DSH

An agentic organization (not only a programming one) composed of
**departments** and **posts**. Posts are not processes: they are persistent
roles that **sleep and wake**, occupied by agents. The organization observes,
evaluates and modifies itself, with governance and safeguards.

**In DSH:** DSH is "everything is a plugin" on Cordis. Deepartments is an
**npm bundle package** (`dsh-deepartments`) that contributes its configuration
layer and services to the runtime. DSH delegates (sessions, subagents,
schedule, skills, jobs, tools); Deepartments organizes (posts,
departments, rooms, witnesses, activations, governance).

## Post, session and witness

- **Post**: a persistent role of the organization. An agent occupies it while
  active; when its turn ends, the post **falls asleep** and leaves a
  **witness** (the handoff between sessions, written by the system, not by the
  agent). On waking, it resumes where it left off.
- **Session**: each activation opens a **finite session** — the post's work
  turn. The session ends; the post remains.
- **Witness**: the bridge between sessions: what was done, what remains
  pending, what context the next turn needs.

**In DSH:** posts = `ctx.subagents.startContinuable(spec)` → durable child
with **cold-resume from its persisted session**; waking =
`followup(parent, childId, content)` (literally "a post that wakes up").
Sessions = headless sessions **persisted event-sourced** (JSONL zstd per
workspace). Witness = **two layers**: native (`session.append(
'deepartments/<event>', data)` + `ctx.sessionProjections` for the live state
of the post; the write on sleep is done with a listener on
`agent/turn-stopping`) + human convention (YAML frontmatter + markdown
body).

## Rooms system

Communication between agents is organized in **rooms**: 2 to N agents,
one room at a time. The room is the group's living memory (its files, its
reports, its board).

**In DSH:** there is no native group chat — communication is 1-to-1
(`subagent`/`send_message`/`report`) or via the shared workspace. The room is
modeled as a **convention**: group directory (workspace) + dedicated agents
(head, reception) + native cross-reads via
`ctx.sessionReferenceResolver` (read-only snapshots of other sessions
injected as context, configurable limits). Multiple rooms with
reception and visits: phase 3.

## Activation system

Four ways a post wakes up:

1. **The CEO** — the human's word.
2. **Assignments** — one session wakes another.
3. **Rhythms** — scheduled, by calendar or interval.
4. **World events** — reactive, from the system or external.

**In DSH:** CEO = user message in the GUI + `ask_user_question` as the veto
channel (not an exception: one more event that wakes the Asistente).
Assignments = `send_message`/`followup` to a sleeping continuable subagent
(the "inbox" = persisted state of the post). Rhythms =
`dsh-schedule` (`schedule_create/list/delete`; on expiry, the agent wakes
up with a `followup()` when idle) — phase 3. Events = system events
(`session/event`, `agent/pre-step`, `agent/turn-stopping`…) + MCP client
for the external world, mapped events→activations by the plugin —
phase 3. The MVP only carries CEO and manual assignments.

## Memory in four levels

1. **SESSION** (short-term) — the turn's active context.
2. **WITNESS** (handoff between sessions) — what survives sleeping.
3. **ROOM** (group memory) — the department's workspace.
4. **ORGANIZATIONAL** — the global repo, queryable from all rooms.

**In DSH:** SESSION = active context + compaction + token-meter (ephemeral
by nature). WITNESS = `session.append` + projections + `_reports/`
convention. ROOM = group workspace (directory with its memory) +
`_reports/<agent>/`. ORGANIZATIONAL = global repo, living docs (AGENTS.md,
docs/), skills, research, session history (`ctx.sessions.get/
list`).

## Asistente and chain of command

The **Asistente** is the CEO's right hand: decomposes, plans and
delegates. The chain is CEO → Asistente → department head →
workers; intermediate posts also sleep and leave a witness.

**In DSH:** the Asistente is an **agent preset** (agent.cordis.yml +
preset.yml + skills/) that contributes tools, persona and prompt sections.
Deepartments generalizes and productizes the preset pattern as a chain of
command.

## Governance

Three levels: **operational** (delegated to the group head), **design**
(product direction) and **direction** (fundamental decisions). The policy
allows exceptions; the system proposes, the CEO approves or vetoes.

**In DSH:** there is no "permission policy" primitive: it is modeled in the
plugin's declarative config + Asistente persona + `ask_user_question` as
the veto channel. MVP: **minimal** governance (operational delegated,
design/direction go up to the CEO); editable policy in phase 3.

## Self-modification and self-observation

The organization can **change itself** (structure and implementation, with
safeguards and a recoverable default structure) and **observe itself**
(functioning, results, evolution).

**In DSH:** builders edit presets, skills and the plugin itself
(`ctx.agentPresets` + repo files). Dogfooding: the first department
(programming) builds the plugin that runs it. Raw native signals:
`sessionProjections`, token-meter, job registry, `list_agents`, session
history, `goal/change` events; interpretation is agentic (quality group,
phase 4).

## Quality as a principle

The system evaluates itself: independent review after every change and a
**post-session interview** ("dream") in which the system examines itself
with the session data.

**In DSH:** the reviewer is the germ of the quality group (phase 4). The
"dream" = listener on `agent/turn-stopping` that dispatches a quality agent
with the session data — the lifecycle hooks exist.

## The MVP in one sentence

A department (programming) with posts that sleep and wake with a witness,
lifecycle managed by the plugin, dogfooding on the Deepartments repo itself,
headless. Details and success criteria in [concept.md](concept.md) and
[ROADMAP.md](ROADMAP.md).
