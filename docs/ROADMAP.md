# ROADMAP — Deepartments phases

Roadmap of the Deepartments project (`dsh-deepartments`): phases with their
status, content and exit criterion, and the phase 2 kickoff tasks. Decisions
and mapping in [concept.md](concept.md); the idea in [IDEA.md](IDEA.md).

## Phases

| Phase | Status | Content | Exit criterion |
|---|---|---|---|
| **0. Research** | ✅ **COMPLETE** (2026-08-16) | Research of the DSH plugin API: mapping cells resolved; feasibility confirmed (rc.6, native mechanisms for posts/activations/witness); decisions 1-2. | Report delivered; feasibility verdict: **positive**; mapping with no pending items blocking the MVP. |
| **1. Concept** | ✅ **COMPLETE** (2026-08-16) | v1 draft + debate; 10 v1 questions → 9 binding decisions + naming proposal; the concept (docs/concept.md). | Decisions taken; concept approved; phase 2 authorized. |
| **2. MVP** | 🚧 **IN PROGRESS** | **Milestone 1 (first, reordered 2026-08-16): board room + research department** — coordination room, research department and coordinator post in the plugin config; addressed envelopes + agenda; `dept_invoke` owner flow. **Milestone 2 (former MVP):** one department (programming) with roles absorbed from the previous setup; persistent posts (continuable + witness); CEO → Asistente → head → parallel builders → reviewer → verification → commit flow; sleep/wake cycle managed by the plugin; dogfooding on the repo itself; headless. | MVP success criteria (concept.md §4): end-to-end assignment with a post that falls asleep midway and resumes without loss; cycle managed without manual glue. |
| **3. Rooms and activations** | Pending | Multiple rooms with reception and visits; scheduled (`dsh-schedule`) and reactive (events/MCP) activations; assignments between posts; editable governance policy; **client plugin UI — total observer** (decision 2); archiving/querying dead rooms. | Two departments coordinating via head → Asistente; a scheduled rhythm running without human intervention; a dead room archived and queryable; a governance exception applied; the UI shows the organization's state. |
| **4. Self-observation, quality, self-modification** | Pending | Quality group + dream/post-session interview; proactive contextualizer; operational channeled escalation; self-modification of structure and implementation with safeguards and recovery (default structure). | The organization proposes a structure or implementation change, the CEO approves it, it is applied with quality gates, and the way back (default structure) works. |

## Phase 2 kickoff

Concrete tasks to start development, in order, each with its "done"
criterion. (The `dsh-plugin-dev` skill is created first — Recommendation 1
of the research — so no builder needs to re-research.)

| # | Task | "Done" criterion |
|---|---|---|
| ✅ 1 | **Seed the repo** (docs + skill first): `README.md`, `docs/IDEA.md`, `docs/concept.md`, `docs/ROADMAP.md`, `AGENTS.md` and `.dsh/skills/dsh-plugin-dev/SKILL.md` (verbatim text of the concept annex) + initial commit. | `git status` clean in `/home/esuarez/projects/deepartments`; a builder session in the repo loads the `dsh-plugin-dev` skill from the catalog (root `<project>/.dsh/skills`, rank 100). — DONE 2026-08-16 (docs, AGENTS.md and the dsh-plugin-dev skill committed; repo clean). |
| ✅ 2 | **Development profile**: create `deepartments-dev` (headless template, independent port) for development and smoke without touching the web profile. | `dsh --profile deepartments-dev --dump-config` composes without errors; the headless boot starts on its own port. — DONE 2026-08-16: dev profile `deepartments-dev` (web GUI clone of `web`, port 3090, isolated DSH_HOME `/opt/dsh/.dsh-dev`, systemd `dsh-deepartments-dev`, Tailscale https://laagencia.taildb5a7a.ts.net:8445) + headless twin profile `deepartments-dev-headless` for automated smoke. |
| ✅ 3 | **Bundle scaffold**: `package.json` (name `dsh-deepartments`, 0.1.0-rc.1, `dsh.bundle`, rc peerDeps), `cordis.patch.yml` (`deepartments` row), minimal `src/index.ts` (`name`/`inject`/`apply` with a log effect), tsconfig NodeNext, build to `lib/`. | `dsh plugin --profile deepartments-dev add /home/esuarez/projects/deepartments` installs and `dsh --profile deepartments-dev --dump-config` shows the `# == dsh-deepartments` layer. — DONE 2026-08-16: bundle scaffolded (package.json rc.1, cordis.patch.yml, src/index.ts, tsconfig NodeNext), installed in both dev profiles, TIERED verification green (layer `# == dsh-deepartments` + real headless smoke answering `pong`). |
| 4 | **Board room architecture in the plugin**: coordination room + research department + coordinator post defined in `cordis.patch.yml`; the plugin instantiates the room state (log, cursors, agenda) at boot. | `--dump-config` shows the layer with room config; headless smoke shows the room instantiated. |
| 5 | **`dept_invoke`**: the Asistente forks into the board room, converses with the research coordinator (addressed envelopes, agenda), and merges back via the board delta + relevo witness. | Headless smoke: the Asistente's `dept_invoke` spawns a fork that posts addressed messages to the board room and converses with the research coordinator; the fork merges back (board delta + relevo witness) and the Asistente's session receives the result. |
| 6 | **Milestone smoke** (success criterion of decision 10): owner invokes the Asistente → board room → short conversation with the research coordinator → back to the owner. | Decision 10's success criterion: owner invokes the Asistente → board room → short conversation with the research coordinator → back to the owner's office chat; the room state persists across sessions. |
| 7 | **`dept_post_create`** (moved): the coordinator creates department agents (researcher posts) inside its department room. | Headless smoke: the coordinator creates a researcher post (asleep) in its department room and wakes it with a followup; the `deepartments/post-created` event appears in the session log. |
| 8 | **Programming-department dogfooding** (former MVP, moved): CEO → Asistente → head → N parallel builders → reviewer → verification → commit; a post falls asleep halfway and resumes without loss. | Complete assignment through CEO → Asistente → head → N parallel builders → reviewer → verification → commit, with a post asleep halfway and resumed without loss; includes the witness skeleton (schema-constrained frontmatter, `agent/turn-stopping` sleep listener, post projection) folded from the former task 5. |

> The former 'witness skeleton' task (witness convention + post projection + sleep listener) is folded into task 8 (milestone 2); `dept_invoke` (task 5) already carries the 1:1 relevo witness for supersession.

## Current status

- **2026-08-16** — phases 0 and 1 complete; phase 2 ready to start; task 1
  (seed the repo) in progress.
- **2026-08-16** — tasks 1, 2 and 3 complete (dev topology: isolated DSH_HOME
  `/opt/dsh/.dsh-dev`; GUI profile `deepartments-dev` on port 3090/Tailscale
  8445; headless twin `deepartments-dev-headless` for smoke); task 4
  (`dept_post_create`) ready to start.
- **2026-08-16** — owner decision: subagent dispatch must never block. New
  plugin entry `dsh-deepartments/subagent` provides the four delegation tools
  always-async (no `run_in_background`; settlement notices continue dependent
  chains); installed in the stable profile (restart pending owner's go).
- **2026-08-16** — decisions 10-16 recorded (concept.md); roadmap reordered:
  research milestone (board room + research department) first, programming
  dogfooding next; research report
  `.dsh/reports/researcher/2026-08-16-interagent-communication.md` validates
  the board model; rename of the main agent to **Asistente** applied (docs +
  preset + skill).
