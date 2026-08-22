# ROADMAP — Deepartments phases

Roadmap of the Deepartments project (`dsh-deepartments`): phases with their
status, content and exit criterion, and the phase 2 kickoff tasks. Decisions
and mapping in [concept.md](concept.md); the idea in [IDEA.md](IDEA.md).

## Phases

| Phase | Status | Content | Exit criterion |
|---|---|---|---|
| **0. Research** | ✅ **COMPLETE** (2026-08-16) | Research of the DSH plugin API: mapping cells resolved; feasibility confirmed (rc.6, native mechanisms for posts/activations/witness); decisions 1-2. | Report delivered; feasibility verdict: **positive**; mapping with no pending items blocking the MVP. |
| **1. Concept** | ✅ **COMPLETE** (2026-08-16) | v1 draft + debate; 10 v1 questions → 9 binding decisions + naming proposal; the concept (docs/concept.md). | Decisions taken; concept approved; phase 2 authorized. |
| **2. MVP** | 🚧 **IN PROGRESS** | **Milestone 1 (first, reordered 2026-08-16): board room + research department** — coordination room, research department and coordinator post in the plugin config; addressed envelopes + agenda; `dept_invoke` owner flow. First milestone (board room + research department) done 2026-08-16; next = programming-department dogfooding. **Milestone 2 (former MVP):** one department (programming) with roles absorbed from the previous setup; persistent posts (continuable + witness); CEO → Asistente → head → parallel builders → reviewer → verification → commit flow; sleep/wake cycle managed by the plugin; dogfooding on the repo itself; headless. — Superseded by the 2026-08-19 aggressive restructure A-G (board-as-bus, permanent lean department heads, host direct channel, nap/sleep lifecycle), which now implements this milestone's success criteria (a post falling asleep midway and resuming without loss) under the new model. | MVP success criteria (concept.md §4): end-to-end assignment with a post that falls asleep midway and resumes without loss; cycle managed without manual glue. |
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
| ✅ 4 | **Board room architecture in the plugin**: coordination room + research department + coordinator post defined in `cordis.patch.yml`; the plugin instantiates the room state (log, cursors, agenda) at boot. | `--dump-config` shows the layer with room config; headless smoke shows the room instantiated; the room board persists in `<stateDir>/rooms/<roomId>/board.jsonl` across restarts (decision 17). — DONE 2026-08-16: board room architecture (org config, room-state projection, boot instantiation) + durable board.jsonl persistence (decision 17). |
| ✅ 5 | **`dept_invoke`**: the Asistente forks into the board room, converses with the research coordinator (addressed envelopes, agenda), and merges back via the board delta + relevo witness. | Headless smoke: the Asistente's `dept_invoke` spawns a fork that posts addressed messages to the board room and converses with the research coordinator; the fork merges back (board delta + relevo witness) and the Asistente's session receives the result. — DONE 2026-08-16: dept_invoke + board toolset (dept_room_read/write, dept_witness_write) + plugin wake relay + coordinator post bootstrap; verified in the dev GUI (long-lived profile). |
| ✅ 6 | **Milestone smoke** (success criterion of decision 10): owner invokes the Asistente → board room → short conversation with the research coordinator → back to the owner. | Decision 10's success criterion: owner invokes the Asistente → board room → short conversation with the research coordinator → back to the owner's office chat; the room state persists across sessions. — DONE 2026-08-16 — MILESTONE ACHIEVED: the owner invoked the Asistente on the dev GUI (deepartments-dev); the fork conversed with the research coordinator on the board (6 addressed messages); the coordinator delivered a full research report; the fork closed with its schema-constrained relevo witness; the Asistente returned to the owner with the result (7 turns). Room state persisted across a service restart. |
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
- **2026-08-16** — Milestone 1 (decision 10) ACHIEVED on the dev GUI: owner →
  Asistente → board room → research coordinator conversation → relevo witness
  → result delivered back to the owner; board state survives restarts
  (decision 17). Known limitation: the one-shot headless CLI kills
  continuable children at exit — milestone smokes must run on the long-lived
  GUI profile. Follow-ups queued: durable read cursors, respawn of posts
  whose parent is no longer live, dept_room_read truncation of long messages,
  then task 7 (dept_post_create).
- **2026-08-16** — LLM provider migrated from `deepseek-official` to
  `opencode-go` (from `@earendil-works/pi-ai`, registered by
  `@deepseek-ai/dsh-llm-pi-ai`) in both homes (stable `/opt/dsh/.dsh`, dev
  `/opt/dsh/.dsh-dev`) and the plugin coordinator post (cordis.patch.yml),
  keeping the same DeepSeek models `deepseek-v4-pro` (Pro) and
  `deepseek-v4-flash` (Flash). Key insight: the harness `apiKeyEnv` field is a
  **credential-ref** resolved against `$DSH_HOME/.credentials.yaml`, not a
  physical env var name. TIERED ladder green (build, plugin add, dump-config,
  headless smoke self-identifies pro/flash); reviewer PASS; committed
  `ed907ef`. Follow-ups remain queued: durable read cursors, respawn of
  orphaned posts, dept_room_read truncation, then task 7 (dept_post_create).
- **2026-08-17** — **J-Space evaluated and SKIPPED** (owner decision 2026-08-17):
  the third-party "cognitive enhancement" skills suite
  (J-Space-Cognition-Suite-V3.6) + its self-published benchmark claiming
  DeepSeek V4 capability gains will **not** be adopted as a default. Why
  rejected: no demonstrated benefit (an independent A/B in the plugin's own
  issue tracker showed no correctness gain at ~3× tokens and +17–36% time); a
  headline benchmark (TB2.1) was not reproducible and a reviewer suggested
  some entries were "fake boosts" — single-run, vendor-reported, not
  reproducible; it duplicates our existing AGENTS.md/workflow discipline; and
  open-code-go compatibility is unanswered. Reference:
  `.dsh/reports/researcher/2026-08-17-jspace-evaluation.md` (report path is
  gitignored; filename cited here). If ever re-considered: pilot only on a
  throwaway dev agent with an A/B measuring correctness + tokens + time.

- **2026-08-18** — **`dshmarket@1.13.1`** adopted as the plugin store on both
  DSH instances (owner decision; research report
  `.dsh/reports/researcher/2026-08-18-dsh-plugin-store-selection.md`):
  stable profile `web` (`/opt/dsh/.dsh`, port 3080) and dev GUI profile
  `deepartments-dev` (`/opt/dsh/.dsh-dev`, port 3090), installed via
  `dsh plugin add dshmarket@1.13.1` (exact pin, auto-appended to
  `dsh.profile.bundles`). Chosen as the ecosystem-convergence winner over the
  awesome-dsh-plugin catalog: 951★, ~25k npm downloads/day, recommended by
  the awesome list, default preset of two DSH desktop apps, peerDeps matching
  our rc.7 exactly. `allowRestart: false` set in both profiles'
  `cordis.patch.yml` because both instances run under systemd
  (`dsh.service` / `dsh-deepartments-dev.service`) — the market's one-click
  restart is disabled. Reviewer PASS; both services restarted;
  `/dsh-market/status` reports `version 1.13.1` and `restart:false` on
  3080 and 3090. Headless twin `deepartments-dev-headless` intentionally not
  touched (market is web-GUI-only). Follow-ups: builder
  `2026-08-18-dshmarket-allowrestart` reported but did not write its report
  (process gap); re-evaluate store choice if DSH ships an official
  marketplace.

- **2026-08-18** — **`dsh-smart-restart`** (edusrez/dsh-smart-restart, npm + GitHub, MIT)
  built, dogfooded and installed on both instances (stable `web` 3080, dev
  `deepartments-dev` 3090). After any DSH restart it wakes the session that was
  active: via the `smart_restart` tool (explicit — records the caller session +
  reason, restarts the systemd unit detached) or, for a plain `systemctl
  restart` made while an agent was active, via a SIGTERM/SIGINT shutdown hook
  that persists the last-active session and pins the post-restart notice to it
  within a configurable grace (`shutdownGraceMs`, default 10 min). Live-verified
  end-to-end multiple times (auto-wakes without the owner prompting). A critical
  issue was caught in an isolated smoke before release: a SIGTERM handler that
  does not re-raise the signal suppresses Node's default termination and hangs
  systemd restarts to TimeoutStopSec/SIGKILL (fixed — handler now re-raises).
  Versions 0.1.0 → 0.2.0 → 0.3.0 published (npm + tagged GitHub); installed as
  `dsh-smart-restart@0.3.0` in both profiles with per-profile `restartUnit`
  (`dsh.service` / `dsh-deepartments-dev.service`). Research reports:
  `.dsh/reports/researcher/2026-08-18-dsh-boot-notify-plugins.md`,
  `.dsh/reports/explore-deep/2026-08-18-dsh-boot-notify-apis.md`.

- **2026-08-18** — **Bilingual Chinese README** (owner decision 2026-08-18):
  `README.zh.md` (Simplified Chinese) added to the three DSH repos
  (`edusrez/Deepartments`, `edusrez/dsh-smart-restart`,
  `edusrez/dsh-tool-web-enhanced`), following the official deepseek-harness
  convention — English `README.md` stays canonical/default, the zh file is a
  full mirror, and each `README.md` opens with `English | [中文](README.zh.md)`.
  `deepartments/AGENTS.md` gained an explicit i18n carve-out sanctioning the
  README.zh.md pair (English still canonical). Reviewer PASS on both batches;
  all three repos pushed (deepartments also published its 24-commit backlog).

- **2026-08-19** — **`dept_invoke` generalized**: `dept_invoke` gained an
  optional `to` parameter so an assignment can be addressed to ARBITRARY
  board members (a sibling fork post id `asistente-fork-<id>` or a department
  head), replacing the hardcoded coordinator-only addressing. Coordinator
  ensure/wake preserved as the default (no-`to`) path only. Fork prompt
  rewritten mission-driven and room-generic (room + assignment + named
  addressees), keeping the resident-post close (concludes with a report to
  its principal; the post stays resumable/registered in posts.json and is
  re-woken by the relay). Return shape unchanged. Verification: `pnpm build`
  clean, `node --test test/invoke.test.js` 5/5, full `node --test` 19/19,
  TIERED ladder green (plugin add + dump-config layer + headless smoke on the
  twin). Reviewer PASS. Committed as `05abad1`. Purpose: enable the
  cross-session resident-post test (two GUI sessions sharing the board room,
  fork↔fork addressing, settlement-delivered reports).
- **2026-08-19** — **Twin-profile env fix**: the `deepartments-dev-headless`
  twin linked `dsh-smart-restart` via its dev path, whose repo had its
  declared dep `@deepseek-ai/dsh-home-paths` missing from node_modules
  (caused `ERR_MODULE_NOT_FOUND` in the headless smoke). Fixed by `pnpm
  install` in `/home/esuarez/projects/dsh-smart-restart`. Headless smoke now
  green.
- **2026-08-19** — **Next**: the owner will signal when ready to restart the
  `deepartments-dev` GUI service to load the new build, then run the
  cross-session live test (session 1 fork A resident in the board room →
  session 2 fork B → message to fork A → wake relay → settlement report back
  to session 1). Technical validation: the explore report
  `.dsh/reports/explore-deep/2026-08-19-continuable-settle-and-cross-parent-wake.md`
  (NO-BLOCKER verdict).
- **2026-08-19** — **`dept_room_who` board roster tool**: added a read-only
  roster tool to the continuable-child board toolset in `src/invoke.ts`:
  `dept_room_who(room)` lists the room's static org members plus every
  registered post in that room from the live `byPost` registry, with per-post
  `parentLive` (parent agent resident in ctx.agents; false when the agents
  service is absent). It lets a coordinator/fork enumerate the authoritative
  occupants of a room instead of inferring presence from stale board history.
  Root cause this fixes (observed live in the first cross-session test):
  research-head addressed a ghost post `asistente-fork-e7cd9ad5...` left over
  from the 2026-08-16 milestone and visible in the ancient board.jsonl, which
  was NOT in posts.json and thus not wakeable. Verification: `pnpm build`
  clean, invoke tests 6/6, full suite 20/20, TIERED ladder green (plugin add,
  dump-config layer, headless smoke pong). Reviewer PASS. Committed as
  `2aa6561`.
- **Silent-truncation fix + full-message fetch (2026-08-19):** live
  cross-session log analysis (4 reviewers, consolidated at
  `.dsh/reports/scribe/2026-08-19-cross-session-log-analysis-consolidated.md`)
  found the wake relay was silently slicing every addressed message to 200
  chars (invoke.ts:228) with no marker, while `dept_room_read` sliced to 240
  and capped the digest at 10 lines — which caused two forks to accuse each
  other of fabricating truncation, and left no way to recover full text
  except dumping the whole shared `board.jsonl`. Fix (owner choice, option
  A): the wake relay is now pointer-only (message id + from, never body);
  `dept_room_read` supports optional `messageId` full untruncated fetch
  (never advances the cursor), `limit` (default 20) and `offset` pagination,
  with TOC previews `- <id> | from -> to | <preview>` and an explicit `…`
  at 140 chars; the 10-line `digestDelta` cap was removed. Empty reads keep
  the exact `No board messages addressed to you.`. Verification: `pnpm
  build` clean, invoke tests 8/8, full suite 22/22, TIERED ladder green
  (plugin add, dump-config layer, headless smoke pong). Reviewer PASS.
  Committed as `530049a`. The same analysis also surfaced following
  candidates (documented, not yet scheduled): identity/roster validation
  before addressing, secret hygiene on the shared board, persistent
  per-member cursors, minor guards (self-writes, inject canonical postId,
  resolve `anyParentId()` ambiguity).
- **2026-08-19** — **Fork identity + mission-as-official-context**: after
  the live cross-session test exposed role-confusion (a fork receiving its
  mission as a user-role start prompt read it as an injection and refused),
  the explore report
  `.dsh/reports/explore-deep/2026-08-19-fork-identity-context-delivery.md`
  established that rc.7 has no `role:'system'` channel: "official context"
  is a user-role message with a distinguished `source` (settlement
  `{kind:'subagent-settled', form:'notice'}`; report `{kind:'subagent-report',
  form:'relay'}`; the plugin's wake relay already used `{kind:'coordinator',
  form:'relay'}`), and `request.prompt` is always delivered as plain user.
  Fix (owner design): (1) new child tool `dept_whereami` answering spatial
  identity — `kind:'post'` (postId/roomId/members/posts+parentLive) for a
  registered board post vs `kind:'host'` (the Asistente in its private
  room), fixing the `'unknown'` fallback; (2) `dept_invoke` deploys with a
  neutral role prompt and delivers the mission as OFFICIAL context via
  `subagents.followup` with source `{kind:'coordinator', form:'relay'}`
  (deployment snapshot: where you are, who was present on entry, your
  mission), never writing the mission to the board (secret hygiene);
  `messageId` removed from the return; (3) hardening: a failed deliver
  followup no longer leaves a silent orphan — it rolls back the
  just-registered post (awaiting the last registry write to avoid a
  lost-update race) and rejects with an actionable error. Verification:
  `pnpm build` clean, invoke tests 10/10, full suite 24/24, TIERED ladder
  green (plugin add, dump-config layer, headless smoke pong). Two reviewers
  PASS. Committed as `bd518cc`. Next (pending live re-test): a fork
  receives its deployment context and mission via the official channel,
  multi-session password test.
- **2026-08-19** — **Dept_invoke now deploys a spatial-only clone — "the fork
  is you, divided"**: per the owner model, `dept_invoke` no longer carries a
  mission. It only deploys a continuable clone (fork) to the board room with
  a SPATIAL deployment context and injects a spatial notice into the copy
  that stays with the owner. Removed: the `assignment`/`threadId`/`to`
  parameters and the entire coordinator-ensure path (department lookup,
  spawn-provider coordinator, coordinatorInFlight) — `dept_invoke` only
  carries `room` and only ever materializes the fork. Kept: post registry,
  wake relay (kind 'coordinator'/form 'relay'), board toolset
  (dept_room_read/write/witness/who/whereami), registerContinuableSetup,
  rollback-on-followup-failure hardening, and the new non-fatal parent
  context injection (via Agent.inject with a non-user plugin source —
  renders CONTEXT). The fork start prompt is minimal identity framing; the
  deployment followup is spatial-only (official-context prefix, kind
  'post'/postId/room, presence snapshot, dept_whereami pointer) with NO
  mission text — the clone is an identical copy of the Asistente and knows
  what to do, only where it is. Added `@deepseek-ai/dsh-llm` to
  peerDependencies (rc channel, rule 8). Background mechanics (verified):
  the LLM never sees a message's source — the only model-visible "official"
  marker is a textual prefix (per
  `.dsh/reports/explore-deep/2026-08-19-context-input-delivery.md`);
  `request.prompt` is unavoidably a user-role row in rc.7; deployment via
  `subagents.followup` with `{kind:'coordinator', form:'relay'}` already
  renders as CONTEXT in the UI and survives end-to-end. Verification:
  `pnpm build` clean, invoke tests 11/11, full suite 25/25, `pnpm peers
  check` clean (single-instance dsh-llm), TIERED ladder green (plugin add,
  dump-config layer, headless smoke pong). Two reviewers PASS. Committed as
  `45233da`. Follow-up note: `CoordinatorConfig` schema remains declared in
  `src/org.ts` (unused by dept_invoke now; harmless — optional separate
  schema-pruning). The skill now fixes the model: "## The fork is you,
  divided" (WHERE not WHO; no role-confusion resistance; spatial identity
  via dept_whereami). Next (pending): live multi-session password test with
  the spatial clone (no mission).
- **2026-08-19** — **Aggressive restructure A-G (2026-08-19):** after an
  11-auditor critical log review (reports
  `.dsh/reports/reviewer/2026-08-19-logaudit-*.md`, consolidated
  `.dsh/reports/scribe/2026-08-19-cross-session-log-analysis-consolidated.md`)
  found ~271M tokens spent 95% on cache re-reads of inherited context,
  unbounded confirmation ping-pong, ghost posts, in-memory cursor replays,
  and self-asserted identity, the owner approved retiring the fork model
  entirely and restructuring to the "board-as-bus, departments = company"
  model. Commits: `46215d0` (A: host bus — retire dept_invoke/fork, global
  board tools for the host, hosts.json registry, raw host wake kind:'board',
  no anyParentId), `22b5af4` (B: permanent department heads — spawn fresh +
  toolFilter {allow:[]} lean + persona role + spatial deploy +
  dept_post_retire), `27e51ed` (C: wake-relay guard — ack:true flag +
  ack-loop suppression N>=3/T=120s + cursor dedup), `3c8be93` (D: persistent
  cursors.json high-water, ready single-once, fork-ghost sweep), `6fe60cf`
  (E: roster host liveness, whereami self-registration, sensitive/
  senderVerified trust signal), `83b4999` (F: O(1) board writes via per-room
  seq counter, boot compaction with mandatory cursor reset, dev-state
  clean), `72a86c4` (G: head lifecycle — dept_nap siesta keeps context,
  dept_memo_write journal, dept_sleep dormir resets context and respawns
  fresh with the journal in its first-turn start prompt; reviewer FAIL on
  respawn state-ordering fixed with deliver-before-commit). Each batch:
  builder → reviewer → TIERED ladder → commit. Final: build green, 51/51
  tests, `ready` single-once (1 record/room), dev state clean, GUI restarted
  on the new bus. Next: live test of the direct bus
  (Asistente↔heads↔Asistentes) and the nap/sleep lifecycle.

- **2026-08-19** — **Batch G follow-up: the slept head's journal rides the
  spawn START PROMPT (first-turn memory)**: the respawn path delivered the
  journal as a SECOND turn (a post-start `subagents.followup`), so a
  re-materialized head could answer its first wake before seeing its memory.
  Fix: `respawnAsleepPost` builds the spawn start prompt as the neutral
  `headPrompt(postId)` plus a sleep-resume section carrying the FULL journal
  text, and passes it to `startContinuable` — the real manager submits that
  prompt as the child's first inbox turn and resolves only after acceptance,
  so the start IS the delivery and still precedes the registry commit
  (read → build prompt → start → commit; on any failure the OLD child +
  sleepEpoch stay set and the next wake retries the respawn). The post-start
  journal followup is removed entirely; later wakes are pointer-only relays
  that never re-carry journal text (tests assert this, secret-phrase
  included). The fork-era lesson stands: the plain-user start prompt is
  framed as the head's OWN authored memory (neutral head identity + persona
  = role), never as a mission. Tests: the two Batch G lifecycle tests now
  spy `startContinuable` (success: journal + secret phrase in `inbox[0]`
  with source kind 'user', no separate followup; failure: rejected first
  start leaves the registry untouched, retry succeeds). Verification: build
  green, 35/35 invoke tests, 51/51 full suite, TIERED ladder green.
  Committed as `c39de68`.

- **2026-08-19** — **Live test battery PASSED (2026-08-19):** the restructured bus was exercised end-to-end in the live dev GUI: (1) direct host↔head channel — the Asistente host posted an assignment to research-head on the board (no fork), the wake relay woke the spawn head, the head replied, and the relay RAW-woke the host with the kind:'board' source; (2) spatial identity — dept_whereami returns kind host (address host-session-<uuid>) for the Asistente and kind post for the head; (3) nap/sleep lifecycle — the head wrote its journal via dept_memo_write, slept via dept_sleep (durable sleepEpoch), re-materialized as a FRESH incarnation (new childId, previousChildId chain) with the journal in its FIRST-turn start prompt (fix c39de68, found by the incarnation's own honest report that the pre-fix journal arrived as a second turn), and recovered a secret phrase that existed ONLY in the journal (0 occurrences on the board); (4) trust signal — the head saw [sensitive — sender verified: yes]; (5) ack-loop guard — terminal acks did not ping-pong; (6) TWO HOSTS LATERAL — the owner's second session registered host-session-8f1009e1, each host raw-woke the other bidirectionally (m-board-14/15) and both saw a consistent roster (2 live hosts). All autonomous tests were verified with independent evidence (registry files, session logs), not the agents' word. Commits: c39de68 (journal-first-turn fix) + deed386 (docs). Next: departmental multi-head/multi-post scenarios and the programming-department dogfooding on the new bus.

- **2026-08-20** — **Wake optimization (W1 + W2)**: audited and hardened the
  deterministic wake machinery for host and head agents. **W1** (commit
  `cfaffe9`, "fix(org): wake machinery — atomic journal write,
  dept_room_who global schema, host-sleep ordering (Batch W1)") shipped three
  fixes from the wake audit: (A3) the GLOBAL `dept_room_who` hosts output
  schema now declares `sleeping` (it was crashing with
  `additionalProperties:false` after host sleep — root cause was copy-paste
  drift from the head own-layer copy when Batch 7 landed); (A1) `writeJournal`
  is now atomic (tmp file + rename); (A5) host `dept_sleep` persists
  `sleepEpoch` only AFTER the in-place surface-reset append, closing the crash
  window (Session.append is synchronous, verified by reviewer). Regression
  test added; 97/97 tests and the TIERED ladder green; reviewer PASS; audit +
  fixes + builder reports `.dsh/reports/reviewer/2026-08-20-wake-audit.md`,
  `.dsh/reports/reviewer/2026-08-20-wake-fixes-review.md`,
  `.dsh/reports/builder/2026-08-20-wake-fixes.md` (all gitignored; filenames
  cited). **W2** (commit `109272b`, "feat(org): wake identity+cursor block in
  journals + version deepartments-workflow skill in repo (Batch W2)") adds a
  journal identity+cursor block (`wake_counter` monotonic, `last_wake`,
  optional `current_step`) plus a Wake-routine footer per journal; both
  `dept_memo_write` tools gained an optional `currentStep` parameter; 98/98
  tests and the TIERED ladder green; reviewer PASS (`w2-journal-review`). The
  lean wake routine ("Wake routine (injected wake)") — identity →
  read journal → board delta → health check → decide, loading
  AGENTS/ROADMAP-tail lazily — is encoded in the `deepartments-workflow`
  skill. Owner microdecisions 2026-08-20: audit+fix+optimize the wake
  (reviewer examined the wake sequence live; researcher investigated SOTA —
  `.dsh/reports/researcher/2026-08-20-agent-wake-best-practices.md`); scope
  "Completa" (lean routine + journal identity/cursor block + health check);
  the routine is encoded in BOTH the skill and the journal; the skill is
  versioned in the repo under `.dsh/skills/deepartments-workflow/` and both
  dev + stable presets symlink to it (backups preserved as
  `deepartments-workflow.bak-20260816/` siblings). Both DSH homes (dev
  `/opt/dsh/.dsh-dev` and stable `/opt/dsh/.dsh`) verified on DSH 0.1.0-rc.8 —
  AGENTS.md CLI pin updated (rule 8).
- **2026-08-20** — **Main agents sidebar**: the left DSH sidebar's workspaces region is replaced by a list of main agents (host row always first + department heads), shipped as a CLIENT bundle inside `dsh-deepartments` (fully reversible; shadows `sidebar.workspaces` at priority -1). Server: new `/deepartments` loopback RPC (`agents`/`list`) via `ctx.connection.rpc` (resolved optionally via `ctx.get('connection')`, skipped in headless profiles); pure status computation in `src/agents.ts` (precedence sleeping → completed-notice(unread addressed-to-host) → working(running) → idle); optional `title` display field on coordinators; new **Internal Programming** department (room `programming`, post `programming-head`, board member) and research dept renamed to Research Department. Client: `dsh.client` (web) + `exports["./client"]` + tsdown `build:client` wrapped by `scripts/normalize-client-banner.mjs`; host row "Assistant — User's Office" with DSH default status dots (ongoing/warning/done), head rows with lifecycle dots (spinner working, green completed-notice, gray idle, gray moon sleeping) fed by 5s+focus RPC polling; clicking the host row opens the current session (`ctx.sessions.open`) or starts a new one when none; the New Session button is hidden via CSS targeting `.hHd-Xa_newSession` ONLY — the shared aria-label selector was removed because the brand button bears the same aria-label and the logo disappeared. Commits: `9ead681` (feature), `bb7b734` (export `./package.json`), `bd82d67` (version client source — `/client/` gitignore anchored). Verification: `pnpm build`, `node --test` 63/63, build:client envelope checks, plugin add, dump-config `# == dsh-deepartments` layer with programming, headless smoke (`room ready: programming`), reviewer PASS. Dev GUI restarted twice with owner approval; `/plugins/dsh-deepartments/client.js` serves (HTTP 200) and the `/deepartments` RPC route is mounted.

- **2026-08-20** — **Deepartments Settings tab + trusted-host rework**: owner wanted a Settings tab with a slider to enable/disable the Deepartments UI, but the initial DSH settingsScope is loopback-only (owner on Tailscale → switch disabled). Reworked to persist toggle in `<stateDir>/ui.json` served over `/deepartments` RPC `ui/config` / `ui/config/set` with authority `trusted-host` (declared Tailscale hosts, loopback still allowed) so it works from any origin; Deleted `src/settings.ts` and `dsh-settings` deps. Client now drives a live gate polling `ui/config` and a segmented Enabled/Disabled selector (DSH options style). Commits: `30901ea` then `2c4ba9c` (rework).

- **2026-08-20** — **Agents-only sidebar + multiple Assistants**: sidebar made agents-only (removed Sessions section). Assistant sessions now appear as separate agents (Assistant, Assistant 2, ...) in creation order oldest-first, only after first message (blank filter), each clickable to open its session, active highlighted, collapsed dots per assistant. Subagents hidden (`origin !== 'subagent'`) and archived Assistants hidden via `archivedSessionIds` from `workspace.list` (rpc). Ordering fix: original Assistant stays on top, new below; restored ⋯ hover menu per Assistant with Archive agent via `workspaces.archiveSession`. Commits: `bdb972f`, `02f1c5b`, `37915b0`, `bf6e4e9`, `f768971`, `de367da`.

- **2026-08-20** — **Dept nap removal**: `dept_nap` was a no-op conclude marker; DSH wake relay / settlement injection wakes heads regardless, so the tool was redundant. Removed both host-plane and child-layer definitions, rewrote head spawn prompt, cleaned lifecycle comments, deleted Batch G nap test, renamed head status `napping`→`idle` across `src/agents.ts` and `src/client/index.tsx`. Commit `8c2c3fe`. 62/62 tests.

- **2026-08-20** — **Batch C (committed `f2454a1`)**: `feat(org) wake pack injected FRESH at agent/pre-step (message arrival) — Batch C timing` — the Deepartments wake-context pack moved from a frozen dept_sleep-surface append to a fresh agent/pre-step injection (reusing `assembleWakePack`/`buildWakePackMessage`, no dsh-core change); the pack now reflects live board-delta/git/roster/cursor at the moment the owner's message arrives, alongside the standard DSH injections (`@deepseek-ai/dsh-system-prompts` + skill-catalog). `dept_sleep` host surface reduced to a single journal node. Never-slept host degrades gracefully (no throw). P1 sentinel `pack-v1: present` + P2 KPI line (`wake_counter` + top-1 open item) added; journal footer deduped to a one-line pointer. 109/109 tests; reviewer PASS (arch GO, stale comments fixed). Loaded into dev + smart-restart 23:10; live re-validation GREEN (`pack-v1: present` + KPI visible at next wake).
- **2026-08-20** — **Batch B (committed `3ddec57`)**: `feat(org) head+worker wake_counter ordinal parity` — heads AND workers now bump `wake_counter` at their own-layer `dept_sleep` seed boundary (new `bumpPostSleepCounter`, atomic tmp+rename); `writeJournal` post/worker route unified to host-style `Math.max(prevCounter,1)` so the +1 happens only at sleep seed (was advancing on every write). 106/106 tests; reviewer PASS.
- **2026-08-20** — **Docs + config (committed `a48b2c1`)**: AGENTS.md + ROADMAP wake-routine label renamed 'Wake routine (deterministic orientation)' → 'Wake routine (injected wake)' (owner-approved); Session ritual START rewritten to injected-wake wording byte-identical to the canonical skill text. Plus audit finding C1 fixed in the dev host persona (rule 8 → injected wake; config outside repo, mirrored to stable at deploy time). Context-injection audit PASS (coherent composite; skill-catalog only injects the 1-line summary — no full-body duplication; routine text deduped to one source). Note on the audit: C1 HIGH resolved in the dev persona; C2 LOW-MED is dsh-core/out-of-scope; P1/P2 folded into Batch C.

- **2026-08-20** — **Dev-only trial LLM route rolled back**: a trial LLM provider route that a previous session had extended to the department heads and the delegation tools was reverted from the hot path. The trial model rejected the harness's reasoning-effort mapping (the `none` wire value is unsupported) and returned HTTP 400 before generating any token, so the rollout never ran a single real turn. Department heads are back to `deepseek-v4-flash` on `opencode-go` (commit `e38f339`); the delegation rows are back to `deepseek-v4-flash` in the dev preset. The trial route stays declared only in the dev harness home (outside this repo), off-by-default. Reviewer PASS recorded in the gitignored `.dsh/reports/reviewer/` (2026-08-20).
- **2026-08-20** — **W3 (committed `ba5c24c`)**: `fix(org) host wake_counter advances at the dept_sleep seed boundary (Batch W3)` — ordinal now correct (wake 2 saw 1 before; the one-behind gap closed); builder+reviewer PASS; tests 98/98.
- **2026-08-20** — **W4 (this unit)**: `feat(org) wake context pack` — Deepartments context injection at host wake: identity/journal path/board delta/condensed roster/git/system state/full workflow skill injected pre-thought (owner doctrine: no lazy for what will always run); + `dept_wake_snapshot` on-demand; wake routine rewritten. Live re-validation GREEN at the 2026-08-20 23:14 host wake (host-session-cf5225e4…, seeded journal `wake_counter: 4` on disk, KPI `wake_counter 4` present in the injected pack) and confirmed on stable via the headless twin smoke (`pack-v1: present`).
- **2026-08-20** — **STABLE deployed (Batch 6 + W1..W4 + B + C)**: stable instance `dsh.service` (3080, DSH_HOME=/opt/dsh/.dsh, profile `web`, bundle `dsh-deepartments` link:repo) reloaded — `pnpm build` tsc clean, dump-config shows `# == dsh-deepartments` layer, `systemctl restart dsh.service` active (HTTP 200, marker.json updated); tests 109/109. C1 persona full-sync dev→stable (backup `.bak-20260820`; injected-wake START rule 8 now live in stable). Stable headless twin `/opt/dsh/.dsh/profiles/headless-deepartments/` created (mirror of dev twin) for automated CLI smoke. Re-validation on stable: twin smoke post-restart → `pack-v1: present` + identity + `kpi (unavailable)` (never-slept degrade by design, Batch C); real host wake seeded with `wake_counter 4` + KPI present (GREEN). Reviewer wake-compare PARTIAL → effectively GREEN (flagged anomalies were the never-slept SUBAGENT session's own pack, not the host wake); out-of-scope follow-up: optional KPI fallback to adjacent seeded journal for never-slept agents.
- **2026-08-21** — **Batch S1: Session Memory Archive** (committed `7418b69`): append-only per-member entry history under the journals tree (one archive file per member, `<memberId>.md`, unique per-write delimiter) + one-cycle automatic session log per wake (one file per `<memberId>-<wake-counter>` cycle; in-process `sessions.flush` + `sessionPersistence.readRaw` via OPTIONAL `ctx.get`, exact `seq > boundarySeq` slice with time fallback, bounded caps MAX_TOOL_ARGS 800 / MAX_TOOL_RESULT 2000 / MAX_TEXT 2000 / 512 KB, stub+warn never-throw) + per-member mutable `journals/index.json` (atomic tmp+rename, last-write-wins) captured from the writeJournal/bump* choke point; journal citations `archive_seq`/`session_log` marker lines (KPI regex lines untouched); `boundarySeq` (`session.seq`) persisted at both dept_sleep sites; inject array stays `['tools','sessions','sessionProjections']` with services resolved optionally (owner-ratified deviation); spec materialized as `docs/specs/001-session-memory-archive.md`. RAG wired (config, outside repo — T2/T2b): a `journals` embeddings database added to dev+stable personae AND both GUI profile patches (tool-web-enhanced `rag.databases = [reports, journals]`, embeddings remote via `apiKeyEnv DEEPINFRA_TOKEN` at runtime → zero-401 smoke when the token is exported from the systemd unit env; backups `.bak-20260820-t2`/`.bak-20260821`). 5 new tests (→114), reviewer PASS. Headless observation: CLI one-shot calling dept_sleep does not terminate cleanly (related to the T4 subagent guard).
- **2026-08-21** — **T4: role-focused Deepartments injection for subagents** (committed `4b1713d`): `subagent`/`subagent_fork` accept an optional `role` param (builder|reviewer|researcher|scribe|explore, default generic) carried via an in-process `roleRegistry` (dsh-session strips non-whitelisted meta fields, so `meta.role` is not an option; cold-resumed children fall back to generic). The agent/pre-step injector now branches on `session.header.meta.origin === 'subagent'` → injects ONE slim role contract block (new `src/role-orient.ts`) INSTEAD of the full host wake pack (~4.6–4.9k tokens saved per subagent; host + registered posts keep the full packet unchanged). Global `dept_sleep` REFUSES subagent-origin callers (guard before the host branch). SKILL.md dispatch templates rewritten to the light form (objective+files+spec+verification; "your role contract is injected"). Flaky test 74 (Batch 7 host dept_sleep) hardened with waitFor. `node --test` **117/117** (114 + 3 new), build clean; reviewer PASS. Two non-blocking follow-ups: evict `roleRegistry` at child settlement; comment-accuracy nit in role-orient.ts.
- **2026-08-21** — **Wake-5 session hardening (4 commits, all reviewer PASS; tests 120/120)**: closes the T4 follow-ups, fixes the pre-existing test-93 regression and the S1 live session-log capture, and amends the wake routine from the wake-5 audit. (1) **T4 follow-ups closed** (commit `bbdd2b5`): `roleRegistry` now evicted at child SETTLEMENT via the dsh `subagent/end` lifecycle listener (module-scope, single registration; guards non-string ids, never throws) + a `forgetRole` helper; comment-accuracy nit fixed (SKILL dispatch templates = handoff contract, ROLE_CONTRACTS = injected discipline rules — complementary, not byte-identical). (2) **Pre-existing test-93 regression fixed** (commit `aab6e5c`): the S1 ROADMAP entry was reworded so the wake-packed ROADMAP tail carries no literal session-log/archive path patterns — test stays strict, 118/118. (3) **Wake-routine amendment** (commit `34e8a5e`, wake-5 audit): hard REPLY-FIRST rule (first wake output = owner-facing greeting + ≤5-line plan + explicit "what do you want this session?" ask before ANY tool call), permission gate (plan is PROPOSED, not authorized — no subagent dispatch, codebase exploration, or item start until the owner answers), grounding cap (≤1–2 reads of a journal-referenced report; zero src/checkout exploration before go-ahead) — mirrored in the HOST_WAKE_ROUTINE_TEXT / HOST_WAKE_NEXT_STEP constants and the SKILL.md checklist (rule 0). (4) **S1 session-log live-capture fixed** (commit `e38163e`): root cause — `captureSessionLog` extracted `flush`/`readRaw` and invoked them UNBOUND, losing `this` inside the real dsh-session implementation → every live session log degraded to the stub (`Cannot read properties of undefined (reading 'liveEntryFor')`); fixed with bound method calls; +2 tests (→120/120).
- **2026-08-21** — **Wake-6 environment upgrade + S1 live verification** (tests 120/120; docs-only entry): (a) **Environment upgraded**: dsh core `0.1.0-rc.8` → `0.1.1-rc.1` (npm global reinstall of `@deepseek-ai/dsh`, published 2026-08-21 — brings the Bubblewrap security fix, vision-exp support and subagent improvements) and the `dshmarket` plugin `1.16.2` → `1.17.1` in the `web`/stable and `deepartments-dev` profiles (via `dsh plugin add dshmarket@1.17.1`); pre-upgrade backups under `/opt/dsh/backups` (tarballs `*-20260821-1117`). Verified: `--dump-config` clean in both profiles (`# == dsh-deepartments` layer present), smart-restart clean, GUIs 3080/3090 respond. (b) **S1 verified LIVE**: first REAL capture of the session log — the wake-5 cycle materialized with a full transcript (159 KB) under the ordinal bumped at rebirth, exactly as the open item predicted; the `wake_counter 6` ordinal matches triple (journal = wake pack = session log). The dept_sleep stub stays flagged as a P2 follow-up (explore in progress). (c) **Ecosystem research (2026-08-21)**: `dsh-store@0.5.2` is a NON-official community plugin and NOT adopted (we stay on dshmarket); `deepseek-v4-flash` is DeepSeek's latest flash model (checkpoint DeepSeek-V4-Flash-0731, no successor) and is available on opencode-go with the same ID as the direct API — our config is already the correct one; the experimental multimodal variant `deepseek-v4-flash-vision-exp` is only reachable via the direct API (not curated on opencode-go). No RAG/embeddings changes in the core.
- **2026-08-21** — **Wake-9 environment upgrade: dsh 0.1.1-rc.1 → 0.1.1-rc.2 (dev only)** (tests 122/122; docs-only entry): (a) **Core upgraded**: `@deepseek-ai/dsh@0.1.1-rc.2` installed via npm global reinstall (456 packages changed; rc.2 is the npm `latest`, published 2026-08-21 12:42Z, ~6h after rc.1) — the delta is an image/attachment/vision pipeline rework (DeepSeek adapter uploads images via the Files API first with file-id reuse, inline-base64 fallback, deterministic canonical attachment encoding, `read_image` gains sourceWidth/sourceHeight); researcher verified NO breaking changes across config/profile loading, agent-default-model/provider settings, subagent tool-calling, session-log, smart-restart and plugin manifest — no migration steps; dshmarket stays at 1.17.1 (already newest). (b) **Fix B re-applied to rc.2**: the orphan `role:'tool'` sweep was ported to the new `serializeMessages`/`serializeMessagesWithImages` codebase (Set + collect + guard; in the image path the guard wraps the ENTIRE result body including `pendingToolImages`) — 13/13 simulation asserts, reviewer PASS, clean sequences byte-identical; pristine pre-edit backup and the rc.1 patched file preserved under `/opt/dsh/backups` (the fix lives in the global npm install and is lost on every upgrade). (c) **Verification ladder**: plugin add up to date + `--dump-config` shows the `dsh-deepartments` layer; real headless smoke in the headless twin (web_fetch tool-call round-trip against the strict direct API) → 200, no 400s. (d) **Restart + post-boot**: dev service restarted 13:37:18 UTC via smart-restart (boot on rc.2, GUI 3090 HTTP 200), and the live session log confirms the resumed session still runs `deepseek-official` / `deepseek-v4-flash-vision-exp` (direct API, reasoningEffort max). (e) **Observation (P2)**: rc.2 changes the `read_image` coordinate semantics for downscaled images (now uses the reported scale multiplier instead of assuming 1:1) — relevant to our vision-exp screenshot workflows; stable profile untouched (stays on rc.1).
- **2026-08-21** — **Wake-9 live verification** (tests 122/122; docs-only entry): (a) **S1 session-log capture REAL**: the wake-8 cycle materialized under the ordinal bumped to 9 with a full 51 479 B transcript (12:41:46→12:57:28 UTC, frontmatter wake_counter 9) — no stub; at wake-9 birth the file carries the previous-cycle seed, exactly as the wake-8 file did with the wake-7 cycle at its verification. (b) **Runtime model continuity**: the dev service process (port 3090) started 12:42:32 UTC and has NOT restarted since wake 8, so the runtime descriptor remains `deepseek-official` / `deepseek-v4-flash-vision-exp` (direct API, reasoningEffort max) by continuity from the wake-8 live verification (turns 163+); no smart-restart notice in wake 9. (c) **Capture finalization at sleep confirmed**: `-8.md` now holds the wake-8 own cycle (51 130 B, 12:41:46→12:57:25 UTC) — the ordinal-bump capture rewrites the file at sleep with the current cycle, consistent with the -6/-7/-8 pattern. (d) **No new findings**: the P2 queue is unchanged; the wake-9 invariant open item is now closed.
- **2026-08-21** — **Wake-8 live verification** (tests 122/122; docs-only entry): (a) **Runtime model descriptor LIVE**: the dev service restarted (12:42:34 UTC); from the third post-reboot turn onward every LLM request of the resumed session carries `deepseek-official` / `deepseek-v4-flash-vision-exp` (direct API, reasoningEffort max) — confirmed in the live session log; caveat: the first two post-reboot turns still used the cached pre-restart config (`opencode-go` / `deepseek-v4-flash`), the new default took effect from the next turn. (b) **T4 slim-injection fix (commit `279ce10`) LIVE**: the first wake-8 subagent (an explore verification probe) received the slim `## Deepartments context` block (~750 chars — role identity + role contract + reporting) instead of the previous full 25 313-char host wake pack — no journal/ROADMAP/board_cursor/wake_counter markers present. (c) **dept_sleep subagent-origin guard LIVE**: a subagent attempting `dept_sleep` is refused with the expected loud rejection ("dept_sleep is refused for a transient delegated subagent — a subagent cannot sleep; its task ends with the settlement notice"). (d) **S1 session-log capture REAL**: the wake-7 cycle materialized under the ordinal bumped to 8 with a full 123 432 B transcript (11:36:10→12:41:46 UTC) — no stub. (e) **End-to-end flip**: the verification probe itself ran on vision-exp with real tool calling against the strict direct API — no 400s — the flip is functional end-to-end.
- **2026-08-21** — **Wake-7: dev-profile default-model flip to vision-exp on the direct API + root-cause fixes A/B** (tests 122/122; docs-only entry): (a) **Model flip (owner-approved, outside the repo)**: the dev profile default model is now `deepseek-v4-flash-vision-exp` via the DIRECT DeepSeek API — provider `deepseek-official`, reasoningEffort `max` kept, headless twin pinned the same; dev-only, the stable profile is untouched. (b) **Root-cause Fix A (commit `7333ea5`, in repo)**: `dept_sleep` now defers the surface replace so the host close no longer leaves an orphaned `role:'tool'` message on wake — 121/121 tests (+1 regression test), reviewer PASS. (c) **Fix B (outside the repo, re-apply after each dsh upgrade)**: the orphan sweep in the DeepSeek LLM provider's message serialization (plain and image-variant paths) lives outside the repo and must be re-applied after every provider/dsh upgrade. Diagnosis: the orphaned `role:'tool'` generated by the host dept_sleep close trips the upstream strict validator as a direct-API 400; the pre-flip strict-API smoke PASS (workflow agent on vision-exp with tool calling) confirms the fix end-to-end. (d) **T4 subagent-injection discriminator dead-code fixed** (commit `279ce10`): the live owner audit found the role discriminator read `header.meta?.origin`, but dsh-session flattens meta to top-level `header.origin` — so EVERY subagent received the full host wake pack instead of the slim role block (real session-log capture: one 25 313-char pack, zero slim blocks) and the subagent dept_sleep guard never fired; the fix reads the flat field, with a real fixture and a regression test through the real Loader — 122/122, reviewer PASS. This session closes with a dev service restart; wake 8 must verify live BOTH the runtime model descriptor and the slim subagent injection (the next wake materializes on the new model).
- **2026-08-21** — **Wake-11: corrupt session log root-caused + fixed + recovered** (owner-reported dev error "Failed to load history: history unavailable for session session-cf5225e4-4261-4eba-bb34-733864243587: corrupt Zstandard session log: complete frame contains a torn JSONL record"): (a) **Diagnosis** (explore: `.dsh/reports/explore-deep/2026-08-21-corrupt-session-log-diagnosis.md`, confidence HIGH): NOT a torn tail — the artifact was 581 complete zstd frames ending at EOF with a complete last record; the failure is a SINGLE MID-LOG seq discontinuity at decompressed line 6 (the cleanup's minimal artifact events 0..3, then a jump to seq 405164) — raised by the scanner's commit-continuity check (`dsh-session-persistence-jsonl lib/index.js:984`); the seam was born 15:39:23.36 UTC, 1 s after the cleanup backup, and both service stops were graceful ("Deactivated successfully") — so it is OUR wake-10 web-GUI cleanup (`runSleepCleanup` truncate step on a session ALREADY materialized/live 24 s earlier; only the child-archive step had a live guard), not an external crash. (b) **Recovery (owner-approved Option A, full history)**: forensic copy of the corrupt artifact (184,279 B → `archive/…-corrupt-20260821-180114.jsonl.zstd`); restored the verified pre-cleanup backup (14,198,147 B, 41,161 frames, 54,620 lines, 0 seq gaps, ends seq 403490) over the live artifact; dev service restarted; boot clean and append-only growth resumed (first 54,620 lines md5 == backup; last record seq 403493 `session/end-seed`); wake-11 tail (seqs 403491–416663, turns 193–194) intentionally dropped per owner decision — preserved in the wake-11 journal + subagents archive tar. (c) **Root-cause fix (commit `196eb75`)**: `runSleepCleanup` now returns a skipped report BEFORE any mutation when `opts.isLive(hostSessionId) === true` (mirrors the archive-step guard), `truncateSessionArtifact` gets a defensive direct-call guard, and `runPendingWebUiCleanups` clears `webUiCleanupPending` only behind the new pure gate `shouldClearCleanupPending` (skipped-live or failed truncate → flag KEPT, retry next boot); 136/136 tests (+3 regression: live-skip holds artifact byte-identical, direct-call refusal, gate truth table), reviewer PASS (`.dsh/reports/reviewer/2026-08-21-fix-cleanup-live-guard.md`); fix LIVE in dev (plugin re-added, restart 18:13:26 UTC — clean boot, 0 error matches). Remaining caveat: the boot-before-materialize ordering assumption still exists (hook runs after resume relay in the fast path) — mitigated by the skip-and-retry semantics, next real test is the next sleep→boot cycle of a live host session.
  **Post-fix LIVE validation & P1 closure (owner-confirmed, 2026-08-21 ~19:00 UTC)**: after the fix restart (18:13:26, bundle with `196eb75`), the dev GUI reloads cleanly — owner visual confirmation: full restored history visible, no `corrupt Zstandard` error (expected with Option A recovery; the journal-only look is NOT the current state, it is deferred). Server-side evidence: live artifact healthy append-only (14 297 355 B, 54 910 lines, last record seq 408360 at 18:31, prefix md5 matches the restored backup); `/opt/dsh/.dsh-dev/archive/` holds the complete incident evidence set — `session-…-corrupt-20260821-180114.jsonl.zstd` (184 279 B forensic copy), `session-…-pre-cleanup-20260821-153922.jsonl.zstd` (14 198 147 B verified restoration source, 0 seq gaps), `subagents-…-2026-08-21T15-39-25-701Z.tar.gz` (38 557 158 B); `hosts.json` flag cleared (the 15:39:22 cleanup run completed fully: truncate+backup+projcache-reset+subagent archive; 397→260 session dirs = 137 archived); scan found NO remaining host-child subagent dirs (the 4 extra `cf5225e4` mentions in other dirs are content-only, no `parentSession`/`origin` schema). **P1 CLOSED.** The visual-cleanup outcome (journal-only chat, zeroed stats, empty subagent list) is re-scoped to the next real sleep→boot cycle: the boot hook will run `runSleepCleanup` with the live-guard (`196eb75`) — if the host session is already materialized it SKIPS before any mutation and KEEPS `webUiCleanupPending` for the next boot (skip-and-retry, no corruption possible); expected: journal-only at the first post-sleep boot where the host is not yet live. Wake-12 validates that cycle.
- **2026-08-21** — **Wake-10 session** (three units): (a) **Fix B folded**
  (commit `f9ffdcd`): `patches/dsh-llm-deepseek-orphan-sweep.patch` +
  `scripts/reapply-dsh-patches.sh` (fingerprint-gated: PASS/NOT-APPLIED/drift-FAIL,
  idempotent, stable-home guard) + `patches/README.md`; verified 11/11 + ladder
  (smoke OK); reviewer PASS. Correction surfaced: dev and stable SHARE the single
  global CLI rc.2 — stable's process still holds rc.1 in memory (untouched); a
  future stable restart boots rc.2. (b) **Context-injection analysis**: wake-8 vs
  wake-10 boot diff → root cause is commit `7333ea5` (Fix A surface-deferral), NOT
  rc.2 (runtime byte-identical for injection packages): the DSH snapshot +
  skill-catalog re-emit only when their previous node leaves the surface, so they
  arrive at the owner's 2nd message instead of the 1st; all 19 wake-pack sections
  present at both boots; owner decision: leave as-is, documented (report
  .dsh/reports/explore-deep/2026-08-21-wake-context-injection-diff.md). (c)
  **Web-GUI cleanup at sleep** (Option A plugin-side, owner-approved: reset total,
  log guardada): dept_sleep sets durable `webUiCleanupPending` (hosts.json); first
  boot after sleep truncates the host session artifact to journal-only (WITH
  full-artifact backup to <stateHome>/archive/), resets session_projcache rows,
  archives+deletes child subagent session dirs (idempotent, atomic, best-effort);
  129/129 + new backup test; reviewer PASS (deviation sanctioned: truncation moved
  out of dept_sleep — seed-contiguity proof dsh-session lib/index.js:1381 +
  persistence:835). Caveat: boot-before-materialize ordering verified by
  construction — first LIVE validation is the wake-11 sleep→restart.

- **2026-08-22** — **Wake-13: dev crash-loop root-caused + recovered + repair-script framing fix** (owner-reported "no puedo conectarme al dsh dev"): (a) **Incident**: `dsh-deepartments-dev` en crash-loop desde 2026-08-21 20:06 UTC (restart counter 4840, ~9 s/ciclo) — cada boot moría en el init del workspace con `corrupt Zstandard session log: first frame is not exactly one header line` (dsh-session-persistence-jsonl lib:742 `assertZstdHeaderFrame`); causa raíz: ejecución de `scripts/repair-session-renumber.py` (commit `37be8b3` original) sobre el artifact del host `session-cf5225e4…` (a las 20:06:23, backup `.pre-repair-20260821-200623.jsonl.zstd` de 730 KB) — su `compress_file` re-comprimía TODO el log reordenado en UN único frame zstd, violando el invariante dsh (primer frame = exactamente la línea header); el gate del script (sha round-trip del stream) no cubría el invariante → artifact de 279 KB inusable y servicio imposible de arrancar. (b) **Diagnóstico**: validación autoritativa de los ~250 artifacts del dev home con un port 1:1 del escáner real (`scanZstdFrames` primer frame + `SessionLogScanner`/`decodeStorageRecord`, regla `seq == índice expandido`): solo 1 corrupto (el reparado); el backup pre-cleanup 18:45:38 (14 642 459 B) OK — 430 438 eventos, termina en `turn/end` del turn 198; el pre-repair 730 KB FAIL (seam `expected 4, got 430449` — truncado por el cleanup del sleep; por eso se intentó reparar). (c) **Recuperación (precedente wake-11 Option A)**: restaurado el backup full 18:45:38 como artifact live; forense del corrupto en `/opt/dsh/.dsh-dev/archive/…-broken-repair-20260821-200623.jsonl.zstd`; dev UP verificado (HTTP 200 en :3090, NRestarts=0, tailscale serve 8445→3090 intacto, boot completo pasa el workspace init que valida todos los artifacts). (d) **Fix durable (commit `36a0cf5`)**: `compress_log_file` (frame 1 = header re-escrito solo; body en frames ~512 KiB independientes con checksum — módulo `write_checksum=True` con fallback TypeError documentado; CLI `zstd --check` porque `--checksum` es rechazado por zstd 1.5.5) + gate `verify_artifact_framing` ANTES del `os.replace` (port de `assertZstdHeaderFrame` + `scanZstdFrames` + re-scan de continuidad estricta sobre el artifact comprimido final; falla = RepairError rc 1, artifact intacto); `renumber`/`expand_record`/`verify_strict` sin cambio de semántica; `scripts/README-REPAIR.md` + sección "Output format (zstd framing)"; **12/12 tests nuevos** en `scripts/test-repair-renumber.py` (todo en tempdirs), incl. el caso del incidente (artifact de 1 frame → el gate lo rechaza con el mensaje exacto del boot) y red-con-stash comprobado por el reviewer; reviewer PASS (2 nits no bloqueantes anotados: bounds-guard del frame-descriptor para artifact de 4 bytes → IndexError en vez de RepairError; `--check` incondicional en la ruta CLI, fails-safe). (e) **Pendiente opcional**: recuperar los turns 199–211 (seqs 430449+) desde la copia `.pre-repair` de 730 KB con el script corregido — decisión del owner.
   **Pendiente RESUELTA (decisión owner, 2026-08-22)**: los turns 199–211 se dejan COMO EVIDENCIA — preservados en la copia `.pre-repair` (730 KB), en los forenses de `/opt/dsh/.dsh-dev/archive/` y en el capture del journal de sesión 12; recuperables en cualquier momento con el script corregido (`36a0cf5`, framing conforme + gate verify) en una ventana planificada, si el owner lo pide.

- **2026-08-22** — **Wake-12 continuation: clean-chat UX (sidebar Asistente) + dsh-smart-restart v0.4.0/0.4.1 canary + awesome-dsh-plugin submission**: (a) **Clean-chat UX path (owner decision)**: instead of the truncation/cleanup machinery, the owner's play — the sidebar shows the workspace's blank/new session as `Asistente` (commit `caf15e6`, plugin-side `src/client/index.tsx`: `!s.blank` un-hidden; blank rows labeled with the host RPC name; non-blank labels unchanged; 140/140, reviewer PASS; live in dev after restart 10:03:02). Explore-verified: blank sessions have NO artifact (lazy persistence — file only on first append), no auto-close/GC, tab close disposes nothing; the old session stays fully intact (log preserved). On first message the blank becomes the new host (wake pack injection unchanged — owner-approved, old host stays dormant; no host-identity conflict). (b) **dsh-smart-restart v0.4.0** (`9890d83`, 57/57, reviewer PASS, npm-published): optional canary gate on `smart_restart` — `canary` param (per-call, default from config `canary: false`); `runCanary` derives binary/profile from the systemd unit ExecStart (generic), builds a temp patch overlay (this plugin disabled + `canaryStateDirOverrides` rows' stateDir → tmp — verified against the dsh-deepartments bundle row id `deepartments`; dump-config composition tested twice), pre-flight `--dump-config`, ephemeral boot on an auto-picked port, HTTP liveness probe (45 s), process-group kill + temp cleanup; FAIL → restart ABORTED (no pending-notice persist, no spawn) + live caller alert (plugin-source notice); derivation impossible → `skipped` (never blocks — generic installs safe). Genericity audit (Q8): zero env-specific runtime code, only `restartUnit` needed, tests env-free. Dev profile configured (`canaryStateDirOverrides: {deepartments: ''}` + `.bak-20260822-canary` backup) and **LIVE SMOKE PASS** (2026-08-22, 10:45 UTC): canary→`Canary: passed — restarting…`, real restart, zero residue (no temp dirs, no stray processes, marker clean). (c) **v0.4.1** (`c9fc515`, 59/59, reviewer PASS, npm-published): single-line canary-failure render, quoted patch `stateDir` paths, hoisted merged `smart-restart` row block (pre-existing mixed-overrides bug found by the builder + fixed + regression test). Repo bar for the list: LICENSE (MIT), GitHub Actions CI workflow, 10 commits, `dsh-plugin` topic set via API. (d) **awesome-dsh-plugin submission**: PR [#2726](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2726) — `data/plugins/edusrez__dsh-smart-restart.yml` (category `notify`; description verified line-by-line against v0.4.1 source; READMEs regenerated — 1838 entries, entry at line 1490; `generate-readme.mjs --check` passes; awesome-lint 0 warnings on the entry). Fork `edusrez/awesome-dsh-plugin` + branch push + topic via the GitHub token at `/root/.config/gh.token` (fine-grained, cannot open PRs on upstream — `Pull requests: write` missing; owner opened PR #2726 with the official template, all boxes verifiably ticked). (e) **Other**: Deepartments repo pushed (`origin/main` = `caf15e6`; 54 commits pushed, 8 of them this session's work); wake-13 turns 199–211 kept as evidence (commit `416ac1a`); the sidebar change replaces the journal-only cleanup goal (machinery stays as defense-in-depth with the 196eb75/1fd4543 guards).
