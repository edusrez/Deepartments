# Deepartments — concept (2026-08-16): closed decisions + resolved research

> Record of the owner's decisions (2026-08-16) and of the resolved IDEA→DSH
> mapping. This document is the repo's working reference: what was decided,
> why, and how the idea maps to DeepSeek Harness (DSH) primitives. The
> reframed idea lives in [IDEA.md](IDEA.md); the plan in
> [ROADMAP.md](ROADMAP.md).
>
> **Superseded (2026-08-22):** the board/rooms parts of this decision register
> are replaced by direct agent→agent messaging — see
> [spec 003](specs/003-agent-messaging.md) (D1). This document stays as the
> historical design record; the current messaging protocol lives in spec 003.

## 1. Summary and decision register

**Summary.** Deepartments phase 1 (debate and shape) closes. The owner's 9
decisions, plus the second binding register (decisions 10-17, 2026-08-16),
fix the product — a **DSH npm plugin bundle package**, **headless-first**,
with dogfooding on the repo itself — and the research confirms the plugin
API (`@deepseek-ai/dsh@0.1.0-rc.7`). This concept consolidates the IDEA→DSH
mapping **with no pending cells**, defines the **reordered milestones**
(first milestone = board room + research department; the former MVP becomes
the second milestone) and records the package naming proposal.

**Owner decision register (2026-08-16) — BINDING.**

| # | Decision | Choice (decided) | Implication |
|---|---|---|---|
| 1 | Distribution | **npm plugin bundle package** (not a profile) | The Deepartments repo **IS** the plugin package: package.json with `dsh.bundle`, `cordis.patch.yml`, `src/`→`lib/`. An example `deepartments` profile may be documented, but it is not the product. |
| 2 | UI | **Headless-first** | The MVP has no client plugin; the UI (total observer) comes in phase 3+. |
| 3 | Legacy workspace fate | **Residual** — "we keep only the idea adapted to the DSH harness" | The idea migrates to Deepartments; the legacy workspace remains as legacy and as the preset's workspace (the previous workspace's preset keeps working from there until Deepartments replaces it). **MVP dogfooding on the Deepartments repo itself**: the first department —programming— builds the plugin that runs it (auto-bootstrap). |
| 4 | Previous workspace's preset | **Frozen de facto**; its content is absorbed as plugin content | The multi-agent flow skill, the role templates (Asistente, builders, reviewer) and the report convention become Deepartments content. The preset keeps operating, with no new features. |
| 5 | License | **MIT** | Already materialized: the repo has an MIT `LICENSE`. |
| 6 | Name | **Deepartments**; package `dsh-deepartments`; the proposed deployment name is **voided** | Justification in §1.1: the first deployment is simply called "the first deployment" (the programming organization). |
| 7 | Witness | **YAML frontmatter + markdown body** | The current `_reports/` convention; compatible with the already established inter-agent memory. It is the human layer over the native mechanism (session events, §3). |
| 8 | MVP governance | **Minimal** | Operational delegated to the group head; design/direction go up to the CEO (`ask_user_question`). Editable policy in phase 3. |
| 9 | Sleeping post | **Continuable subagent + witness in file** | `send_message`/`followup` resumes the post's conversation; the frontmatter/body witness is the handoff; the research adds `session.append` + `sessionProjections` as the programmatic layer of the same state. |

**Owner decision register (2026-08-16, second batch) — BINDING.**

| # | Decision | Choice (decided) | Implication |
|---|---|---|---|
| 10 | Milestone reorder | **First milestone = board room + research department inter-agent flow** (former MVP programming dogfooding becomes the NEXT milestone) | Success criterion: the owner invokes the Asistente with a research request → the Asistente forks into the board-of-directors room → short conversation with the research coordinator → returns to the owner's office chat with the result; the structure persists across sessions. |
| 11 | Organization structure | **Nested rooms**: owner office (CEO ↔ Asistente) → board of directors room (Asistente's representative + department heads) → department rooms (head + workers). Rooms are **part of the program's architecture**, defined by us in the plugin configuration — **never created by agents** (a future internal programming department will iterate on the harness and the plugin). One representative per principal in each room; a newer fork **supersedes** the older one. | |
| 12 | Room model | **A room is a passive board**: append-only ID-addressable message log + per-member read cursors + **agenda** of structured items (owner, lifecycle state ∈ {submitted, working, input-required, completed, failed, canceled}, cursor-of-last-touch) + **addressed envelopes** (to/cc; silent by default). Members read only their addressed deltas since their cursor; joiners get an **onboarding kit** (agenda snapshot + decision log + charter + pointers), never the full archive. Validated by inter-agent communication research (report `.dsh/reports/researcher/2026-08-16-interagent-communication.md`): board coordination beats SOTA topologies; broadcast redundancy costs 28-73% of tokens (AgentPrune). | Durability of the board: see decision 17 (2026-08-16). |
| 13 | Supersession merge | The successor fork merges from three layers: (1) fork seed (the Asistente's conversation), (2) **board delta scoped to its thread**, (3) the predecessor's **1:1 relevo witness** (private state: what was asked, what is awaited, the plan). The predecessor is interrupted/retired (cursor frozen, agenda ownership transferred to the successor). LLM-session context splicing between fork generations is **forbidden** — the board is the merge bus. | |
| 14 | Witness format (refines D7) | **Schema-constrained YAML frontmatter** (provenance: author, timestamp, board cursor covered; decisions; constraints; open items) + markdown body as the human layer | Research: structured handoffs 0.96 vs narrative 0.48 feasibility (arXiv 2607.18265) — the witness **never collapses into prose**. |
| 15 | Federation + sleep | Nested rooms federate through **explicit permission scoping** (what each agent may see/change), not shared context. Scheduled sleep cycles are **consolidation time** (agenda upkeep, witness refresh), not idleness (Letta sleep-time compute). | |
| 16 | Rename | The owner-facing main agent is called **Asistente** (formerly "orchestrator" as its name) | Internal role names (builder, reviewer, researcher, scribe, explore) unchanged. |
| 17 | Board durability | **Plugin-owned append-only board file in the room's workspace (stateDir) as the cold source of truth + session projection as the live in-memory view initialized from the file; session events remain live signal** | rc.6's persistence catalog cannot cold-read third-party event types (`assertEventsSupported`, no runtime registration surface — explore report `.dsh/reports/explore-deep/2026-08-16-session-event-persistence.md`). The board file is ID-addressable and human-readable; witnesses live beside it. |

### 1.1 Naming (decision 6) — justified proposal

- **npm package: `dsh-deepartments`.** The DSH community convention for
  third-party plugins is `dsh-<name>` (`dsh-hello-plugin` in hello-dsh,
  `dsh-agent-teams`); first-party plugins use `@deepseek-ai/*`.
  `@deepartments/dsh-plugin` is valid but adds installation friction
  (npm scope) without MVP benefit. `dsh-deepartments` communicates "DSH
  plugin" at a glance and matches the reference bundles' prefix.
- **Deployment name — VOIDED.** v2 proposed keeping the legacy workspace
  name as the name of the deployment / of the first organization that runs
  the plugin. That proposal is **voided** (2026-08-16): the first deployment
  is simply called **"the first deployment"** — the **programming
  organization** that dogfoods on the repo itself. The product is
  **Deepartments**.

## 2. Positioning

**Deepartments, in one sentence:** the legacy workspace idea materialized as
an **npm plugin of DeepSeek Harness** — an agentic organization layer
(departments, posts that sleep and wake, witnesses, activations,
governance) over the DSH runtime.

**Deepartments is the project.** It is no longer "an idea with its own repo":
it is an installable **bundle package** (`dsh plugin --profile <x> add
dsh-deepartments`) that contributes its configuration layer and services to
the runtime. DSH answers *how things run* (sessions, subagents, schedule,
skills, jobs, tools); Deepartments answers *how things are organized* (what a
post, a department, a room, a witness, an activation, a governance policy
is).

**The legacy workspace is residual.** It keeps existing as legacy and as the
workspace of the previous workspace's preset (which keeps operating from
there, frozen de facto, decision 4). The living idea lives in Deepartments.

**The concrete form** remains the agentic programming environment (the "turn"
of IDEA.md): you talk to a team of agents that specializes over time, not to
a single agent with subagents. The first deployment (auto-bootstrap) is a
development team whose first client is the system itself — **the
Deepartments repo itself** (decision 3): the programming department builds
the plugin that runs it.

## 3. IDEA → DSH primitives mapping — RESOLVED

> Source: `_research/2026-08-16-dsh-plugin-api.md` (section 4 and
> Recommendations). All the v1 `[research pending]` cells are replaced by the
> concrete finding. Status per row:
> **[native]** DSH primitive ready to adopt · **[convention to build]**
> files/processes model the plugin defines · **[plugin code]**
> service/listener the bundle implements on native primitives.

| IDEA concept | DSH primitive (resolved) | Status |
|---|---|---|
| **Rooms** (agent↔agent communication, 2 to N, one room at a time) | No group chat in DSH: communication is 1-to-1 (`subagent`/`send_message`/`report`) or via the shared workspace. The room is modeled as a **convention**: group directory (workspace) + dedicated agents (head, reception) + native cross-reads via `ctx.sessionReferenceResolver` (read-only snapshots of other sessions injected as context `@[label](dsh-session:<id>)`, configurable limits). | [convention to build] |
| **Persistent posts** that sleep/wake | `ctx.subagents.startContinuable(spec)` → durable child that returns `{childId, messageId}` and does **cold-resume from its persisted session**; `followup(parent, childId, content)` resumes it — literally "a post that wakes up". The research confirms it: "exactly the mechanism for posts that wake up". | [native] |
| **Finite sessions** | Headless sessions **persisted event-sourced** (JSONL zstd per workspace): `dsh --profile headless "job"` = one fresh persisted session; `ctx.sessions.create/fork/get/list/flush`. Each activation opens a new session. | [native] |
| **Witness** (handoff between sessions; written by the system, not the agent) | **Two layers.** Native: `session.append('deepartments/<event>', data)` with custom types via `declare module '@deepseek-ai/dsh-session/types'` (durable, auditable, reproducible) + `ctx.sessionProjections` (pure unit `{key, schema, init, apply, view}`) that projects the **post's live state**; the automatic write on sleep is done with a listener on `agent/turn-stopping` (the hook exists). Human convention (decision 7): YAML frontmatter + markdown body, the current `_reports/`. | [native + convention to build] |
| **Ephemeral posts** | One-shot `subagent` spawn; `workflow` for disposable fan-out. | [native] |
| **Activations — rhythms (scheduled)** | **`dsh-schedule`**: `schedule_create/list/delete`; state lives in the session log (`schedule/change`); on expiry, the agent wakes with a normal **`followup()`** when idle (one-shot `at`/`after_seconds`, recurrence `every_seconds` ≥5min). "This is the native mechanism for post 'activations'." Note: requires mounting after sessions/agents/tools/sessionPersistence; runtime children do not receive it. | [native] |
| **Activations — world events (reactive)** | System events (full `session/event` stream, `agent/pre-step`, `agent/turn-stopping`…) + **MCP client** (`dsh-mcp-client`) for the external world. The plugin **maps events→activations** (listener + `startContinuable`/`followup`). | [plugin code] (on native events) |
| **Activations — assignments** (one session wakes another) | `send_message` / `followup(parent, childId, content)` to a sleeping continuable subagent; the "inbox" = persisted state of the post (session events + projection). | [native] |
| **Activation — the CEO** (the human's word) | User message in the GUI + `ask_user_question` as the veto/microdecision channel. Not an exception: one more event that wakes the Asistente. | [native] |
| **Asistente** (CEO's right hand) | **Agent preset** — the previous workspace's preset already exists (agent.cordis.yml + preset.yml + skills/); API `ctx.agentPresets` (list/resolve/read/copy/mount/recompose). Deepartments generalizes and productizes it. Plane rule: a preset contributes to the agent (tools, persona, prompt sections); registries belong to the host; a preset-owned service requires a group with `isolate: true`. | [native] |
| **SESSION memory** (short-term) | Active context + compaction (`dsh-compaction-basic`) + token-meter. Ephemeral by nature, as in IDEA. | [native] |
| **WITNESS memory** | See "Witness": session events + projection + `_reports/` convention. | [native + convention] |
| **ROOM memory** | Group workspace (directory with its memory: files, reports, board) + `_reports/<agent>/`. | [convention to build] |
| **ORGANIZATIONAL memory** | Global repo, living docs (AGENTS.md, docs/), skills, `_research/`, session history (`ctx.sessions.get/list`). Queryable from all "rooms". | [convention (already in use)] |
| **Contextualizer** (3 modes) | Mode 1 (on wake): system-prompt / agent-instructions + skill injected by preset. Mode 2 (on demand): grep/glob, `scripts/report_search.py`, web. Mode 3 (proactive / cross-reads): **`ctx.sessionReferenceResolver`** — read-only snapshots of other sessions injected as model context (maxReferences=3 by default). | [native (mode 3) + convention (modes 1-2)] |
| **Governance** (operational/design/direction; policy with exceptions) | Plugin declarative config + Asistente persona + `ask_user_question` as the veto channel. There is no "permission policy" primitive: it is modeled in config and prompts. MVP: minimal (decision 8); editable policy in phase 3. | [plugin code + convention] |
| **Channeled escalation** (the system proposes, the CEO approves/vetoes) | Convention: the system proposes in reports/documents; the CEO decides via `ask_user_question`; the CEO creates groups directly when he decides so. | [convention] |
| **Self-modification** (structure and implementation) | Builders edit presets/skills/the plugin itself (`ctx.agentPresets` + repo files; precedent: `trustedHosts` patch in STATUS.md). Dogfooding: the first department (programming) builds the plugin. Safeguards and recoverable "default structure": design decision. | [native + plugin code] |
| **Self-observation** (functioning, results, evolution) | Raw **native** signals: `sessionProjections`, token-meter, job registry, `list_agents`, session history, `goal/change` events. Interpretation is agentic (quality group, phase 4). | [native (signals) + plugin code (interpretation)] |
| **Quality / dream** (post-session interview) | The `reviewer` is the germ of the quality group. The "dream" = listener on `agent/turn-stopping` that dispatches a quality agent with the session data — the lifecycle hooks **exist**. | [plugin code] (native hooks) |
| **Web UI — total observer** (read any room) | **Two-faced npm client plugin**: manifest `dsh.client`, export `"./client"`, CJS bundle with tsdown (closure-factory `window.__ModuleLoader__.load`), Slots, `host.call` JSON-RPC; requires **two separate tsc programs** (host vs client). Deferred to phase 3+ (decision 2). | [native — deferred] |
| **Non-agentic infrastructure** (activator, contextualizer, witness writer, memory) | The host runtime (registry of subagents, jobs, skills, goals, sessions, schedule) + the services the plugin registers. "Permanent and non-agentic", as in IDEA. | [native] |

**Reading the mapping.** The research changes the v1 verdict: what seemed "to
build" is mostly **native and ready to adopt** — sleeping posts
(`startContinuable`), activations (`dsh-schedule` + `followup()`),
witness/state (`session.append` + `sessionProjections`), cross-reads
(`sessionReferenceResolver`), lifecycle hooks (`agent/session-start`,
`agent/turn-stopping`). The plugin **builds**: the room as convention, the
witness's human layer, the governance policy, the events→activations mapping
and the interpretation of signals (quality). The differentiating value is
kept and reinforced: **DSH delegates; Deepartments organizes.**

## 4. Milestones (reordered 2026-08-16)

**First milestone — board room + research department (decision 10).** The
owner invokes the Asistente with a research request → the Asistente forks
into the board-of-directors room → short conversation with the research
coordinator → returns to the owner's office chat with the result; the
structure persists across sessions.

**Second milestone — "one department, sleeping posts, dogfooding"** (the
former MVP scope; decision 10 reorders it after the first milestone).

**Goal:** formalize as a plugin what we currently do by hand with the
previous workspace's preset (which stays frozen, decision 4) and add the one
thing the preset does not have: **persistent posts with a witness between
sessions**, with the lifecycle managed by the plugin (decision 9 +
research).

1. **One department: programming.** Roles absorbed from the previous setup
   (decision 4): group head, builders (tiers builder/builder-pro/builder-max)
   and reviewer. Its "room" (group memory) is the **Deepartments repo
   itself**: workspace + file convention (reports, post state).
2. **Persistent posts.** Each worker is a post: **continuable subagent**
   (asleep in storage between activations) + **witness** YAML frontmatter +
   markdown body (decision 7) + session events
   (`session.append('deepartments/*')` + post projection) as the programmatic
   layer.
3. **The CEO flow.** Owner → Asistente (preset) → department head →
   **N builders in parallel** (disjoint files) → reviewer → verification →
   commit. On completion (or when context runs out), the head's post falls
   asleep leaving a witness; the **plugin** manages sleep/wake/witness — not
   the manual glue Asistente.
4. **Dogfooding (decision 3).** The CEO's first real assignment to the
   programming department is **building the plugin itself**: auto-bootstrap —
   the first department builds the tool that runs it, on the Deepartments
   repo.
5. **Headless (decision 2).** No client plugin; verification is via
   `--dump-config` + headless smoke + tests (CLI/reports), not visual.

**Second milestone success criteria (measurable, inherited from v1):**

1. A CEO assignment goes through CEO → Asistente → head → N builders in
   parallel → reviewer → verification → commit **and**, halfway, the head's
   post (or a builder's) falls asleep and resumes the task in a new session
   **without loss of information**: the witness works.
2. The flow works **without the manual Asistente acting as glue**: the
   plugin (or the group head via `dept_*` tools) manages sleep/wake/witness.

**What is NOT in the MVP:** multiple rooms and visit reception; scheduled
(rhythms) and reactive (world events) activations — only the CEO activation
and manual assignments; web UI (client plugin, decision 2); full
quality/dream (the reviewer stays); proactive contextualizer (the manual one
stays); editable governance policy (decision 8); structural
self-modification (yes dogfooding of the workflow, no self-changing the
plugin configuration).

## 5. Risks (updated with the research mitigation)

1. **Plugin API in rc with promised breaking changes.** The runtime is
   0.1.0-rc.7 and the README declares "THERE WILL BE COMPATIBILITY-BREAKING
   CHANGES" (rc.2 already renamed `httpServer`→`webServer`). *Mitigation
   (research):* **CLI pin** (`npx -p @deepseek-ai/dsh@0.1.0-rc.7`),
   build against Cordis's stable API (`apply/ctx/inject/events/
   effects`) and the long-lived services (sessions, tools, skills,
   agentPresets), **isolate renamable services** with `ctx.get('webServer') ??
   ctx.get('httpServer')`, `peerDependencies` on the rc channel (`^0.1.0-rc.x`
   — a `^0.0.1` does not match rc), version the bundle as its own rc with its
   pin.
2. **IDEA scope vs MVP.** The temptation to implement everything (rooms,
   activations, quality, self-modification) at once would kill the MVP.
   *Mitigation (no changes):* explicit minimal MVP (§4) and per-phase exit
   criteria; what is not included is written down and validated later.
3. **Redundancy with DSH primitives.** The research reduces this risk: the
   mechanisms that seemed to need building are native — **don't invent a
   custom scheduler** (use `dsh-schedule`), don't rebuild posts (use
   `startContinuable`), don't reimplement persistence (use session events
   + projections). *Mitigation:* thin layer that adopts primitives where they
   fit (the §3 mapping distinguishes native/convention/code); the plugin's
   value is the organizational model, not reimplementing delegation.
4. **Web UI effort (client plugin).** Complex client plugin API (two tsc
   programs, tsdown, Slots). *Mitigation:* **headless-first decided**
   (decision 2); the UI is deferred to phase 3+ with the already validated
   reference guide (dsh-agent-teams) and numeric verification (CLI/reports),
   not visual.
5. **Hooks that might not exist — RESOLVED.** The research confirms the hooks
   exist: `agent/session-start`, `agent/pre-step`, `agent/turn-
   stopping`, `session/event`, `sessionReferenceResolver`, `sessionProjections`
   and `dsh-schedule`. Residual risk: service renames (→ `ctx.get` with
   fallback) and authoring accidents (→ the research's **non-negotiable
   rules**: no `export default` — postmortem 0001; `!!js` only in config —
   0002; `defineTool` with `output`; tests through the real Loader).
   *Additional mitigation:* development in the **isolated profile**
   `deepartments-dev` with offline `--dump-config` verification (never
   against the web profile in use) and **behavior skills** (markdown, immune
   to breaking changes) instead of code where sufficient.
