---
agent: scribe
date: 2026-08-22
task: host-session-rotation-spec
spec_ref: "Owner decisions (2026-08-22 finalization): Q1 → server-side archive at sleep (canonical workspaceRegistry.archiveSession; NO shadow clone; pure native sidebar); Q2 → keep ALL retired sessions in full (no cap; pre-rotation archive copy kept); Q4 → journal re-key on rotation (frontmatter author/room → host-<newId>; seed built from the re-keyed journal); Q6 → delete /.deepartments/ui.json in the removal step; hosts.json schema additions (retired/rotatedTo/previousSessionId + version marker) with validation. Primary sources: explore-deep/2026-08-22-native-sidebar-clone.md, explore-deep/2026-08-22-custom-sidebar.md, explore-deep/2026-08-22-context-injection-gate.md; runtime verification (this session): dsh-workspace lib/index.js:407-432 archiveSession (pure registry-set add, durable setState → global.set, NO agent/subagent termination), dsh-host-apiproxy lib/index.js:3091-3104 (the RPC maps to ctx.workspaceRegistry.archiveSession), dsh-client-ui-workspace 100-101 sessionVisible (archived hidden everywhere), apiproxy:1187-1189 sessionBlank (blank := no turn/start — a seeded journal user/message keeps blank:true), dsh-client-runtime:9637/9673-9676 (host/archived-sessions-changed → installArchived), :10065 (archived current → selection cleared). Incident history: builder/2026-08-21-ui-cleanup-build.md, explore-deep/2026-08-21-cleanup-trigger-mechanics.md, builder/2026-08-21-fix-deferred-replace-islive.md, ROADMAP.md wake-11/wake-12."
outcome: FINAL DRAFT (owner decisions adopted) — DRAFT-ONLY, no commit, no live-doc edits
files_touched:
  - .dsh/reports/scribe/2026-08-22-host-session-rotation-spec.md (this draft)
---

# Host session rotation at dept_sleep — design spec (FINAL DRAFT, owner decisions adopted)

Status: **FINAL DRAFT — the four open questions the owner answered are closed and baked in as
requirements (see §9 Decisions); only the two genuinely-open items remain there. Ready for
builder dispatch after the owner's remaining two answers.** All file:line facts are from the
primary sources and this session's runtime verification (listed in spec_ref); `❓` marks the
only remaining owner items and builder-verify points.

---

## 0. Owner decisions adopted (2026-08-22) — requirements, not proposals

| # | Decision | Baked in as |
|---|---|---|
| D1 (was Q1) | **SERVER-SIDE ARCHIVE at sleep.** The old session is retired AND archived via the canonical session-archive path, called **server-side inside the sleep flow**: `ctx.get('workspaceRegistry').archiveSession(oldSessionId)` — NOT `workspace.archiveSession` from the client at view time, NOT a minimal filter shadow. Consequence: **no shadow clone at all** — the native sidebar shows live sessions and hides archived ones automatically. | §3.3 S2.5, §4, §6, §7 |
| D2 (was Q2) | **Keep ALL retired sessions in full** (no retention cap); the pre-rotation belt-and-suspenders copy to the archive dir is still made (copy, not move). | §3.3 S2.7, §7 C2 |
| D3 (was Q4) | **Journal RE-KEY on rotation**: frontmatter `author`/`room` re-keyed to `host-<newId>`, written at `journals/host-<newId>.md`; **the rotation seed is built from the re-keyed journal**. | §3.1, §3.3 S1.5b, §4 |
| D4 (was Q6) | **Delete `/.deepartments/ui.json`** in the migration/removal step; **hosts.json schema additions** (`retired`/`rotatedTo`/`previousSessionId` + a version marker) **with validation**. | §3.3 S3, §3.5, §7 C11 |

---

## 1. Context & Motivation

Today the GUI's "main agents" sidebar is a **plugin shadow** of the native sidebar
(`ctx.slots.register({ name: "sidebar.workspaces", priority: -1 }, AgentList)` at
`src/client/index.tsx:938-958`) that renders live polled rows. The owner's goal
(cycle-12 wording, per `explore-deep/2026-08-22-custom-sidebar.md` §4 Reading A): **remove the
custom sidebar entirely and return to the TRUE native sidebar**, with one behavioral
addition from the clean-chat UX: when the Asistente sleeps, the GUI must present a **fresh
session** (the native "New Session" row) and **hide the old host session**, while the old
session and its full log are **preserved intact** (no truncation, no deletion).

The current sleep machinery does **not** create or switch sessions: host `dept_sleep`
performs an **in-place** journal reset of the SAME hosts.json-registered session
(`src/invoke.ts:4283-4374`; the wake pack then goes only to that registered session —
gate `bfe50ff`, `invoke.ts:2661-2663`). Hiding the old host row in the native sidebar is
impossible with the shadow removed and archive forbidden-by-the-old-model: the previous
exploration flagged `workspace.archiveSession` as breaking the wake resume because the resume
targeted hosts.json's `sessionId` (invariant #4 in `native-sidebar-clone.md` §5). The owner
resolved this by adopting a **per-wake new-session model (host session rotation)** — the
machinery change `native-sidebar-clone.md` §6-C4 explicitly said "needs its own owner
decision" — AND by deciding that archiving the retired session server-side is now SAFE,
because under rotation **nothing resumes the old session anymore** (hosts.json points at the
new session; the wake gate then targets only the new id).

---

## 2. Goals & Non-Goals

### Goals (requirements — do NOT re-litigate)

1. **G1 — Remove the custom sidebar COMPLETELY and delete its config.** Client:
   `registerSidebar` (index.tsx:938-958), `AgentList` (547-703),
   `AssistantRowView`/`HeadRowView`/`AgentRowView` (412-542), status helpers
   `asistenteStatus`/`headDotFor`/`HEAD_SESSION_PREFIX` (351-399), `AGENT_CSS` (215 ff.) +
   `STYLE_ID`/`injectSidebarStyle` (767, 925-936), the **native-shell CSS patch
   `.hHd-Xa_newSession{display:none}` (221) — MUST be dropped** so the native New Session
   button returns, the live swap gate effect **except the slim status poll described in §6**
   (820-922), `agentStore` (121-155), `uiStore` (67-80), RPC shapes (37-64),
   `AgentsOwner`/`ClientCtx` surface (196-210, 157-194 — slim back to what remains), the
   settings card `DeepartmentsSettings` (714-762) + registration (776-809) +
   `SETTINGS_CSS`/`SETTINGS_STYLE_ID` (768). Server: `uiConfig { sidebarEnabled }` (1277),
   `ui/config` + `ui/config/set` dispatch (848-866), `ui.json` boot load (1579-1591),
   `persistUiConfig` (1281-1285) — and **(D4) DELETE the file `/.deepartments/ui.json`**
   (the code default `true` is gone with the feature; the file must not linger as dead
   config). The `/deepartments agents`/`list` RPC (invoke.ts:919-925 — static host literal)
   is replaced by the new status RPC (§6).
   **Everything board/tools/sleep/wake-pack/webUiCleanup STAYS** (defence-in-depth per ROADMAP
   wake-12; the wake gate `bfe50ff` stays).

2. **G2 — Pure NATIVE sidebar; NO shadow clone.** The sidebar is the native
   `WorkspaceBrowser`, unshadowed. Hiding the retired host row is done by **server-side
   archiving** (D1): the native `sessionVisible` rule hides archived sessions everywhere
   (`dsh-client-ui-workspace` 100-101: `session.origin !== "subagent" && !archived.has(id)
   && (!session.blank || session.id === current)`). The previous "clone" idea is fulfilled by
   **native rendering + server archiving** — no plugin sidebar code survives.

3. **G3 — NEW: host session ROTATION at `dept_sleep`.**
   - The OLD host session is **retired AND ARCHIVED** (D1) via the canonical session-archive
     path executed server-side in the sleep flow, and its artifact + journal stay **fully
     intact** (D2/G4).
   - hosts.json is updated to register a **NEW host session id** (a fresh session **created
     server-side** during `dept_sleep`, seeded with the **re-keyed journal** — D3).
   - The client shows the old session hidden (native archive visibility) and opens the new
     session screen (§6).

4. **G4 — Journal/log preserved in full.** The old session's session-log artifact and its
   journal file are never truncated, never renumbered in place, never deleted. The new
   session gets a **copy** of the journal (re-keyed, D3), and the old copy stays as the
   archive. No retention cap (D2).

### Non-goals (explicitly out of scope for this spec)

- No web-GUI truncation of the NEW session either (it is born already-minimal; §5).
- No changes to head/worker lifecycle, board tools/cursors, `dept_memo_write`, role-orient/
  subagent machinery, or the wake-pack content.
- No workspace-level restructuring (no new buckets, no archive-workspace, no re-parenting).
- Not modifying the native sidebar shell beyond the CSS patch removal (G1).

---

## 3. Architecture — Sleep-time rotation state machine

### 3.1 Where it lives + the journal re-key (D3)

The host branch of `dept_sleep` (`src/invoke.ts:4283-4374`) is **reworked in place**: steps
1–2 (journal required → bump) stay; step 3 (in-place append + deferred replace) is replaced
by **server-side session creation + archive + hosts.json rotation**; steps 3.5/4/5 keep their
durable persist + concludeTurn shape but target the NEW entry. **D3:** the sleep's journal
seed is the **re-keyed** journal: `bumpHostSleepCounter` still advances `wake_counter` on the
OLD file (`journals/host-<oldId>.md`, kept byte-identical as the archive), then a new file
`journals/host-<newId>.md` is written with the bumped content **and frontmatter `author:`
rewritten from `host-<oldId>` to `host-<newId>`** (room unchanged), atomic tmp+rename. The
rotation seed (§3.2) is built from that re-keyed text, so every artifact of the new member
points at the new member id.

### 3.2 The server-side session creation — which ctx/API

**`ctx.get('sessionPersistence')` — `create({ id, version: 0, createdAt, cwd, seedLength,
delegationDepth: 0 })` + `append(id, seed)` (FIX 1 — amended 2026-08-22).** The seed is
persisted via the **dsh-session-persistence coordinator** (the `sessionPersistence` service),
NOT the live sessions store: `create` registers DETACHED lazy metadata (cursor 0, no artifact,
no store attach — dsh-session-persistence lib/index.js:802-816) and `append` seq-validates and
materializes the artifact (lib:824-840), so the new session is written **COLD to disk** and is
NEVER attached to `ctx.sessions`. The earlier choice (`ctx.get('sessions').create(undefined,
{ seed, meta })`, the `SessionStore.create` shape per `explore-deep/2026-08-16-plugin-api-map.md`)
was the root cause of the session-6e49895c… incident (2026-08-22 16:19:52 UTC): it attached the
session IN-MEMORY **without an agent** (attached-but-agentless), and every later resume then
hit the persistence live-guard `cannot prepare session "<id>" while it is live`
(dsh-session-persistence lib:849-863/852) — the registered host never woke. Full analysis:
`.dsh/reports/explore-deep/2026-08-22-rotation-resume-live-race.md` (FIX 1, §4). The resumed
path (`agents.resume` → `persistence.prepare` → `Session.fromRestore`) is contractually COLD,
so S2 must hand it a COLD artifact. The new session's meta `cwd = <old session's cwd>` (its
workspace path) attributes it to the same workspace and `seedLength = seed.length`; `createdAt`
set to now; `delegationDepth: 0`. The artifact header the jsonl backend writes is identical to
the pre-incident shape (`{"type":"session","version":0,...,"seedLength":4,"delegationDepth":0}`
— `toHeaderLine`, dsh-session-persistence-jsonl lib:36-47).

- No client-side creation. The client only OPENS the server-created id (§6) — kills the
  duplicate-blank race and the "client-created session is not the registered host" hazard.
- **The seed = `buildRotationSeed(reKeyedJournal)`**: header + permission/sandbox/approval +
  the LAST append-origin **re-keyed** journal node, renumbered 0..k — the **exact
  minimal-artifact event list shape** that `planMinimalArtifact` already produces and that
  `verifyMinimalArtifact`/`Session.fromRestore` prove cold-bootable (session-cleanup.ts:332-341;
  `2026-08-21-ui-cleanup-build.md`). Seed-contiguity invariants hold: the ctor throws
  `"seed event at index N has seq M (expected N); seed must be contiguous from 0"` on any
  non-contiguous seed (`dsh-session` lib/index.js:1381) and `appendCore` validates appends
  against its in-memory cursor (lib/index.js:835). ❓ Builders re-verify the ctor accepts this
  exact list as a balanced seed via `Session.fromRestore` (T1/T7) — the shape is already proven
  for the TRUNCATION path, so this is a reuse, not a new risk.
- **`blank` stays TRUE**: the host's `sessionBlank` projector defines blank as
  `!events.some(e => e.type === "turn/start")` (dsh-host-apiproxy lib/index.js:1187-1189) — a
  seeded `user/message` journal node never opens a turn, so the new session's wire summary is
  `blank: true` and the native sidebar renders it as the "New Session" row WHEN current
  (ui-workspace 100-101). This is exactly the clean-chat end-state.

### 3.3 Exact steps of the rotated host `dept_sleep` (replaces invoke.ts:4283-4374's steps 3–5)

Let `oldId = sessionId` (the current host), `oldHostId = host-<oldId>`,
`newHostId = host-<newId>`.

1. **S1 (unchanged)** read journal; loud throw if absent (invoke.ts:4287-4290).
2. **S1.5 (unchanged)** `seeded = await bumpHostSleepCounter(oldHostId, journal, { sessionId,
   roomId, boundarySeq })` (invoke.ts:4298) — atomic tmp+rename bump of
   `journals/host-<oldId>.md`, wake_counter N → N+1; OLD file stays byte-identical as archive.
3. **S1.5b (NEW, D3)** write the **re-keyed** journal to `journals/host-<newId>.md`: same
   atomic tmp+rename pattern; content = `seeded` with frontmatter `author:` rewritten
   `host-<oldId>` → `host-<newId>` (room unchanged). MUST precede S3's persist so a crash
   can never leave hosts.json pointing at a member whose journal file does not exist (the
   wake pack reads `readWakeJournalKpi(journalPath)` at pack assembly).
4. **S2 (NEW — FIX 1, amended 2026-08-22)** seed the new session COLD via the persistence
   seam (§3.2): `await ctx.get('sessionPersistence').create({ id: newSessionId, version: 0,
   createdAt: Date.now(), cwd: workspacePath, seedLength: seed.length, delegationDepth: 0 })`
   then `await ctx.get('sessionPersistence').append(newSessionId, buildRotationSeed(
   reKeyedJournal))` → `newSessionId` is the pre-minted id. The session is persisted to disk
   and is **NOT** entered in the in-memory store — the previous sentence "session store merges
   it into the list immediately" described the poison state (attached-but-agentless → the
   resume live-guard) and is revoked by FIX 1 (incident session-6e49895c…, 2026-08-22
   16:19:52 UTC; see §3.2).
5. **S2.2 (NEW, FIX 1b — amended 2026-08-22) — WORKSPACE ATTACH.** Durable workspace
   membership for the new session: iterate `ctx.get('workspaceRegistry').list()` and call
   `entity.attachSession(newSessionId)` on each entity, first match wins — `attachSession`
   validates the session's PERSISTED header cwd against the entity's `path` and throws on any
   mismatch, so mismatches fall through (dsh-workspace lib/index.js:87-105; the canonical
   session-creation flow calls exactly this after create — dsh-host-apiproxy lib/index.js:2539,
   hard-failing the create as `workspace-attach-failed` when it cannot attach). **FATAL when no
   entity resolves** (empty list, missing `list`, or every attach throws) → rotation returns
   `rotated:false` and the LEGACY in-place fallback runs: a host that is REGISTERED in
   hosts.json but INVISIBLE in the sidebar is worse than no rotation (the session-6e49895c…
   incident — live entry + cold artifact with ZERO rows in `storages/workspace.json` →
   `global.workspaceIds` entity sessionIds: the native sidebar groups sessions by workspace
   membership and the U3 watcher's membership check (src/client/index.tsx:115) never passes →
   host unreachable). The stray COLD artifact remains harmless garbage (§3.6). MUST run AFTER
   S2 (the attach validates the persisted header) and BEFORE S2.5.
6. **S2.5 (NEW, D1) — SERVER-SIDE ARCHIVE of the old session**:
   `await ctx.get('workspaceRegistry').archiveSession(oldId)`.
   - This is the **exact canonical API**: `dsh-workspace`'s `WorkspaceRegistry` (service name
     `workspaceRegistry`, `super(ctx, "workspaceRegistry")` lib/index.js:309), method
     `archiveSession(sessionId)` (lib/index.js:422-432); the web RPC `workspace.archiveSession`
     is a thin wrapper over the same service (dsh-host-apiproxy lib/index.js:3091-3104), so
     calling the service in-process is identical to the canonical path.
   - **Verified semantics**: it is a **pure registry-global set addition + durable persist**
     (`enqueueOperation` → `sessionKnown(oldId)` (live store — passes, the host is live) →
     `setState({ archivedSessionIds: [...set, oldId] })` → `this.global.set(state)`).
     **NO session termination and NO subagent termination anywhere**: greps of `dsh-agent`
     and `dsh-subagent` for `archive`/`archived` return zero matches; the "stops the session
     + its subagents" annotation in the removed client surface (src/client/index.tsx:208)
     described the OLD plugin sidebar's archive UX, not the native registry operation. In the
     native client, archiving only (a) hides the row (ui-workspace 100-101) and (b) clears
     the CURRENT selection if the archived id was current (dsh-client-runtime:10065) — both
     desirable here: the old tab drops to no-selection and the status poll then opens the new
     session (§6).
   - **Artifact preserved** (G4/D2): the registry write touches only the workspace domain
     state; the session artifact and journal files are untouched.
   - The client receives the new archive set automatically via the pushed envelope
     `host/archived-sessions-changed` (dsh-client-runtime:9637 → `installArchived`
     9673-9676), no polling needed for hiding.
   - **Ordering**: archive AFTER S2.2 (the new session is already visible via the workspace
     attach, so the client never sees a moment with neither session visible) and BEFORE
     hosts.json rotation (so the retire is durable even if the process dies before S3).
7. **S2.7 (NEW, D2) — belt-and-suspenders archive copy of the OLD artifact**: copy (NOT
   move) `<sessionsRoot>/<oldId>/session.jsonl.zstd` → archive dir
   `/opt/dsh/.dsh-dev/archive/session-<oldId>-pre-rotation-<stamp>.jsonl.zstd` (reuse the
   `formatBackupStamp`/`PRE_CLEANUP_RE` conventions, session-cleanup.ts:344-347, 381), best-
   effort, never throws (like `runSleepCleanup`'s per-piece best-effort). The live artifact
   stays in place; the copy is evidence + insurance. All retired sessions kept in full, no
   cap (D2).
8. **S3 (NEW, D4) — rotate hosts.json.** In the in-memory `hosts` Map (`HostEntry`,
   invoke.ts:308-346):
   - **Old entry** becomes `{ ...old, retired: true, retiredAt, rotatedTo: newHostId }` —
     REMAINS in the persisted file (queryable for evidence, D1); the wake gate and roster
     treat it as retired (§4). It is NOT moved out of hosts.json (D1: "stays queryable").
   - **New live entry** `host-<newId>` = `{ hostId: newHostId, sessionId: newSessionId, roomId,
     sleepEpoch: Date.now(), boundarySeq: <old session's seq at the boundary>, previousSessionId:
     oldId }`.
   - **D4 schema**: add `retired?: boolean`, `retiredAt?: number`, `rotatedTo?: string` (on
     retired entries), `previousSessionId?: string` (on live entries), and a **version
     marker** (e.g. `schemaVersion: 2` at the top level or per entry — builder freedom, keep
     loader-compatible with legacy files). **Validation at load**: retired entries MUST carry
     `retiredAt` + `rotatedTo`; live entries MUST carry `sleepEpoch` when they were rotated
     (not on never-slept); `previousSessionId` must reference an existing retired entry id;
     unknown/missing version markers on legacy files are tolerated (absent `retired` = legacy
     in-place host — pre-rotation behavior preserved), malformed NEW fields fail loud with a
     descriptive error instead of being silently dropped.
9. **S4 (CHANGED) — do NOT set `webUiCleanupPending`** on either entry (G4; old preserved in
   full, new already minimal). §5 details.
10. **S5 (CHANGED) — do NOT set `deferredJournalSeed`** on the new entry, and do NOT call
   `session.append('user/message', buildSleepJournalMessage(seeded), {surfaceOp:'append'})` on
   the OLD session's live surface. The new session IS the journal (seeded); the in-place
   deferred-replace choreography (Fix A/wake-12) becomes rotation-unreachable. The machinery
   stays in code for **legacy (in-place) sleeps only** (§5).
11. **S6 (NEW) — wake-pack bookkeeping**: `wakePackInjected.delete(oldId)` (old, retired —
    safety); the NEW session has an empty per-process set by definition, so its first pre-step
    injects (§4).
12. **S7 (changed shape) — durable markers on the NEW entry**: `sleepEpoch = Date.now()`,
    boundary seq (invoke.ts:4358-4364 equivalents written to `host-<newId>`) then
    `persistHosts()`. Ordering invariant (kept from the current Step 4 comment, invoke.ts:
    4353-4357): the journal file (S1.5/S1.5b) exists BEFORE `sleepEpoch` is durably persisted.
13. **S8 (unchanged) — concludeTurn** on the OLD session (invoke.ts:4370-4372). The old handle
    stays owned by the web api-proxy (hosts never dispose their AgentHandle) but is inert:
    nothing targets `host-<oldId>` for wake anymore (gate §4; archived).

### 3.5 hosts.json schema (D4) — concrete shape

```json
{
  "schemaVersion": 2,
  "host-session-<newUuid>": {
    "sessionId": "session-<newUuid>",
    "roomId": "board",
    "sleepEpoch": 1787337794152,
    "boundarySeq": 430435,
    "previousSessionId": "session-<oldUuid>"
  },
  "host-session-<oldUuid>": {
    "sessionId": "session-<oldUuid>",
    "roomId": "board",
    "sleepEpoch": 1787337790000,
    "boundarySeq": 430404,
    "retired": true,
    "retiredAt": 1787337794152,
    "rotatedTo": "host-session-<newUuid>"
  }
}
```

Loader contract (D4): keep loading legacy files (no `schemaVersion`, no `retired` fields) with
exact pre-rotation behavior; validate the NEW fields type-wise and relationally (see S3);
never drop an entry silently. ❓ Builder freedom on whether `schemaVersion` is top-level or
per-entry; pick one and validate it.

### 3.6 Crash windows (sleep-time ordering guarantees)

- Crash between S1.5b and S2.2: an orphan re-keyed journal file `host-<newId>.md` exists,
  referenced by nothing — harmless; the next rotation uses a fresh id; optionally swept.
- Crash between S2 and S2.2: a freshly-seeded **COLD artifact** exists (persistence.create/
  append landed, NOT yet workspace-attached, nothing live, no hosts.json reference; old host
  still the live host — correct). Amendment 2026-08-22 (FIX 1): the previous row said a
  "freshly-seeded session exists in the store — harmless", but that in-store state was exactly
  the POISON — attached-but-agentless → every later resume hit the live-guard (incident
  session-6e49895c…, 2026-08-22 16:19:52 UTC; `.dsh/reports/explore-deep/2026-08-22-rotation-
  resume-live-race.md`). With the cold seed the crash window holds only harmless garbage (an
  orphan artifact + re-keyed journal); the next rotation uses a fresh id.
- Crash between S2.2 and S2.5: the new session is workspace-attached (visible as a stray blank
  in the sidebar) but hosts.json still points at the OLD host (still the live registered
  member — correct; S2.5 archive not yet run). No hosts.json reference to the new member — a
  later rotation with a fresh id leaves the stray blank as harmless garbage (optionally swept).
  Amendment 2026-08-22 (FIX 1b): without S2.2 the NEW host would be registered-but-INVISIBLE —
  the exact session-6e49895c… side effect (a live hosts.json entry with ZERO workspace
  sessionIds rows → no sidebar row, the client membership check never passes, host
  unreachable); S2.2 makes the attach a prerequisite of the rotation (fatal when no workspace
  entity resolves), and the BOOT REPAIR HOOK heals this legacy/crash state: on boot, when
  hosts.json holds EXACTLY ONE non-retired live host entry, the plugin attaches its session to
  the workspace whose path matches the session's persisted header cwd (same iterate-and-try
  as S2.2; zero live hosts skip, 2+ live hosts skip + warn — ambiguous; no-match/failure warn,
  never crash; idempotent — `attachSession` no-ops when already attached; the hook uses a
  NON-STRICT `ctx.get('workspaceRegistry', false)` plus a bounded retry (250 ms, ≤10 s) around
  `list()` — the strict get races the registry provider's init (cordis lib/index.js:762-771:
  `_getImpl` bails until the provider fiber reaches state 2; FIX 1b.1), so it attaches on the
  first resolved `list()` and never leaves the host unhealed when the registry is merely slow
  to start).
- Crash between S2.5 and S3: old host archived but hosts.json still points at it — **the wake
  resume would target an archived session**. ❓ This is the one real hazard window: the gate
  would inject the pack into a session the client cannot select (archived). Mitigations: (a)
  persist hosts.json rotation INSIDE the same `S3` immediately after `archiveSession` resolves
  (the window is one await wide); (b) the boot loader treats "live host entry whose sessionId
  is in the archive registry" as retired and rolls to the newest retired's `rotatedTo` if
  present; (c) subagent/notice targeting is unaffected (targets the hosts.json id — the
  session still exists, archived just hides it from the GUI). Recommended: (a) + (b) as a
  boot-time repair; assert in T6.
- Crash between S3 and S8: hosts.json already points at the new member; old artifact fully
  intact; concludeTurn may be missed but the process is dying anyway — wake side fully
  consistent (new member + journal file + gate).
- **Never truncate a live session** (wake-10/11 corruption class: ROADMAP wake-11) — rotation
  removes the truncation entirely; the remaining live-guard (`isLive`, 196eb75 + registry
  probe + TOCTOU, 1fd4543) still guards any legacy truncation path (§5).

---

## 4. Wake-time behavior (unchanged machinery, new target)

- **The wake pack targets the NEW session** automatically: `bfe50ff`'s gate
  (`invoke.ts:2661-2663`) is `hosts.get(hostIdForSession(sessionId))` membership on the
  boot-loaded `hosts` Map — the map now holds `host-<newId>` → the new session's first
  pre-step injects the full pack, assembled from `journals/host-<newId>.md` (present per
  S1.5b/D3) with `wake_counter` N+1. No change to the gate code.
- **Retired old session never gets the pack**: the gate rejects retired entries — one-line
  strictification at invoke.ts:2663: `if (hostEntry === undefined || hostEntry.retired ===
  true) return decision` (mirroring the bfe50ff shape; keep the off-path free of
  `wakePackInjected` so a legacy mid-session registration still works). A message typed into
  an old tab (before the client rotates the view) behaves as a **plain session** — deliberate.
- **The deferred fold (Fix A / wake-12, invoke.ts:2678-2699) does not fire under rotation**:
  keyed by `sessionId` in `deferredSleepReplace`; the new session's durable seed is absent
  (S5); its surface is already `[journal]`. The fold code stays intact for legacy in-place
  sleeps (a host that slept under the OLD plugin and restarts first: loader restores
  `deferredJournalSeed` → first pre-step folds → consumed+cleared, exactly as `1fd4543`
  documents).
- **Board roster / `dept_room_who` / `dept_wake_snapshot`**: the new `host-<newId>` is the
  member; the old entry (still queryable, D1) is filtered from "present" by the retired flag.
  ❓ Remaining owner item (R-Q3): display as `retired` in the roster vs hide entirely, and
  whether `dept_post_retire` semantics change (recommendation: no change — posts registry is a
  separate lifecycle).

---

## 5. Web-GUI cleanup retarget (webUiCleanupPending + boot hook + session-cleanup.ts)

- **`webUiCleanupPending` is never set by the rotated sleep** (S4). Its truncate/projcache/
  subagent-archive purpose (session-cleanup.ts; boot hook at invoke.ts:1477-1574 /
  `hostsLoaded.then(() => runPendingWebUiCleanups())`, invoke.ts:1495) is **obsolete for hosts
  that sleep under rotation**: the old session's artifact is now a preserved archive (G4/D2),
  and the new session is already minimal by construction.
- **What STAYS**: the boot hook + `session-cleanup.ts` remain as the **legacy path** for (a)
  hosts that slept under the previous in-place plugin (a persisted `webUiCleanupPending` must
  still be honored exactly once — they exist per ROADMAP wake-11/12), and (b)
  belt-and-suspenders. The live-guard `196eb75` + registry probe + TOCTOU (`1fd4543`) stay and
  now ALSO guard archived sessions: add `retired` AND `archived` to the skip condition
  (`runSleepCleanup`/`runPendingWebUiCleanups` must never truncate a retired/archived entry's
  artifact — defence-in-depth for G4).
- **Reuse (cheap win)**: `planMinimalArtifact`'s event list (header + permission/sandbox/
  approval + last append-origin journal node renumbered 0..k) is the **same shape** as the
  rotation's seed builder (§3.2) — one shared `buildRotationSeed(reKeyedJournal)`, used by
  both the new-session seed (rotation) and, only in legacy truncation, the minimal artifact.
- **projcache / archive-dir conventions**: rotation itself resets nothing; the D2 copy at
  S2.7 + the existing `archive/` conventions cover evidence. projcache rows for the OLD
  session are left intact (historical), the NEW session generates its own.
- **RAG journals path**: `journals/` now holds BOTH `host-<oldId>.md` (archive) and
  `host-<newId>.md` (live, re-keyed). Distinct member ids → no double-key hazard; the wake
  pack's journal-path/KPI reads only the live member's file.

---

## 6. Client behavior

### 6.1 How the client learns of the sleep — the status RPC (NEW)

There is **no push event and no host-sleep signal on any wire surface today** (the 5 s poll
carries ui/config + agents + workspace.list; the host stream envelope carries no sleep signal;
`native-sidebar-clone.md` §3). With the sidebar and `ui/config` gone, the plugin serves a
small status RPC on the existing `/deepartments` HTTP channel (pure dispatch, unit-testable —
`deps.hosts` already flows in, invoke.ts:4477-4484):

`GET /deepartments host/status` → `{ sleeping: true, sleepEpoch, boundarySeq, liveSessionId,
archivedSessionIds: string[], hostName }` — derived from the in-memory `hosts` Map (live
entry = the non-retired host). ❓ Endpoint shape is builder freedom; the payload contract
above is the requirement.

### 6.2 The polling + view-effect (the ONLY survivor of the removed live-gate 820-922)

A slim effect replaces the deleted heartbeat: same 5 s cadence + focus/visibility gating
(`window.setInterval(..., 5000)` shape into a NEW effect — do NOT keep code inside the
deleted gate effect). On each poll:

1. Read `host/status`.
2. **Transition detection: `liveSessionId` CHANGED** (under rotation every sleep changes it;
   a legacy in-place host keeps the id — no transition, no action).
3. **Hide the old row — NOTHING to do in the client.** The server archived the old session
   (S2.5); the pushed `host/archived-sessions-changed` envelope (dsh-client-runtime:9637)
   installs the archive set and the native sidebar hides the row automatically
   (ui-workspace:100-101). **No `workspace.archiveSession` call from the client, NO
   `retiredSet` filter, NO shadow** (D1). If the old session was the current selection, the
   runtime clears the selection (client-runtime:10065) — the row disappears immediately.
4. **Open the new session screen**: `ctx.sessions.open(liveSessionId)` (the server created
   it; `open` sets selection `dsh.sessions.current`, persisted, and the native sidebar shows
   the fresh blank as the active "New Session" row because its wire summary is `blank: true`,
   §3.2). Fallback when the id is absent from the store (poll raced create — practically
   impossible since S2 precedes S3): **re-poll, never client-create** (a client-created id is
   NOT the registered host — the wake pack would not fire for that tab; log loudly instead of
   silently diverging).
5. **Ordering guarantees**: process status BEFORE any list refresh (the native list derives
   from the same store); guard double-open (only on id change); never `connectWorkspace` a
   blank (blank-reuse would resurrect a still-blank legacy session — Surprise 3); stale-poll
   ignore (a transition already applied for this id + epoch is a no-op).

### 6.3 What the client does NOT do

No creation at sleep-observation time (server creates, S2); no archive calls (server archives,
S2.5); no CSS hash patches (`.hHd-Xa_newSession` dropped per G1); no shadow (D1).

---

## 7. Compatibility & risks

| # | Surface | Impact under rotation | Mitigation / disposition |
|---|---|---|---|
| C1 | **Wake resume** | Resume targets hosts.json `sessionId` — now the NEW id; nothing resumes the old session. Old tab's first message = plain session (no pack) by gate. Amendment 2026-08-22 (FIX 1): S2 now persists the seed via the **dsh-session-persistence seam (cold artifact; no in-memory store attach)** BECAUSE the live-store attach is the poison state (attached-but-agentless → resume live-guard `cannot prepare session … while it is live` — incident session-6e49895c…, 2026-08-22 16:19:52 UTC; `.dsh/reports/explore-deep/2026-08-22-rotation-resume-live-race.md`). Resume stays the pure cold path: `prepare` → `preparedSession` → `Session.fromRestore` (which re-derives `session/end-seed`) | Gate unchanged; retired-skip added (§4); S2 persistence seam (§3.2); tests T2/T4/T6 + the cold-seed regression (no store attach) |
| C2 | **Old artifact + journal preservation (G4/D2)** | Server archive touches only the workspace registry state; `archiveSession` does NOT touch the artifact; pre-rotation copy made at S2.7; ALL retired sessions kept in full, no cap | Verified from dsh-workspace code; T3/T7 assert byte-identity |
| C3 | **Subagent `parentSession` references** | Existing children still reference `oldId`; their send_message/notices target the retired+archived parent → parked/unwaked | ❓ Remaining owner item (R-Q5): orphan-sweep vs park; document behavior |
| C4 | **Pending-notice / shutdown-notice targeting** (smart-restart) | Notices after rotation target the NEW session (correct); pre-rotation pending notices addressed to the old session are lost/hidden | Acceptable (sleep boundary = notice boundary); flag in ROADMAP |
| C5 | **projcache rows** | Old session's row remains (historical); new session generates its own | No reset of the old row (G4); reset logic keyed on live id only |
| C6 | **RAG journals path** | Two journal files under `journals/` (old archive + new live, re-keyed D3) | Distinct ids; live member feeds the pack/KPI |
| C7 | **Board roster / `dept_room_who` / snapshot** | Old hostId retired but queryable; new hostId is the member | Roster excludes retired (R-Q3 decides display) |
| C8 | **Seed contiguity (381/1381)** | New session seed must be contiguous from 0 (ctor throw, dsh-session lib:1381; seedJournal helper shape invoke.test.js:382-403); re-keyed journal file written atomically | Shared `buildRotationSeed` + `Session.fromRestore` cold-boot test (T1/T7) |
| C9 | **Legacy in-place sleeps** | Old `webUiCleanupPending`/`deferredJournalSeed` hosts keep working | Legacy paths stay (§5); loader tolerates absent new fields (§3.5) |
| C10 | **`dept_post_retire` semantics** | Board-post retirement is a separate lifecycle (post registry); host retirement is hosts.json-only | ❓ R-Q3: keep separate (recommended); no posts.json changes |
| C11 | **Archive-vs-archive semantics** | The word "archive" now means TWO things: the native visibility archive (D1, hides rows, no termination) and the evidence archive dir (D2, copies artifacts). Never conflate them; never call `workspace.archiveSession` on anything but a retired host | Terminology in ROADMAP/AGENTS.md: "retire+archive at rotation"; "evidence archive" for dirs |
| C12 | **Crash between S2.5 and S3** | Archived old + hosts.json still pointing at it → wake pack would target an unselectable session | Await-wide window; S3 immediately after S2.5; boot repair (§3.6) |
| C13 | **Stale bundle / hashed CSS** | `.hHd-Xa_newSession` removed; any residual hashed-class CSS drifts across rc versions | Drop the patch entirely (G1); tokens are the only stable seam |
| C14 | **Never truncate a live session; archive ≠ delete** (wake-11/12 incident history) | Rotation never truncates (G4); "archive" must not mean deletion anywhere | S4 + retired/archived skip guard (§5); terminology discipline |

Hazards from the incident history baked in: the wake-10/11 corruption class (truncation racing
a live/materialized session) is eliminated by never truncating; the wake-12 first-turn 400
(journal-interleaved close tail shipping to the strict API) is eliminated by never appending
the sleep close onto a resumed surface (the new session starts life as the journal).

---

## 8. Test plan

**Unit (invoke.test.js + session-cleanup.test.js, real Loader + temp stateDir patterns already
established — `seedJournal` invoke.test.js:382-403, `seedHostRegistration` from
`2026-08-22-context-injection-gate-fix.md`):**

- T1 — rotation seed builder: `buildRotationSeed(reKeyedJournal)` output is contiguous-from-0,
  cold-boots via `Session.fromRestore` (the resume ctor), journal node byte-identical to
  `buildSleepJournalMessage(seeded)` modulo re-key + renumber.
- T2 — rotated `dept_sleep`: creates a NEW session (assert session store contents), calls
  `ctx.get('workspaceRegistry').archiveSession(oldId)` (assert oldId in `archivedSessionIds`),
  rotates hosts.json (old entry `retired:true`/`rotatedTo`, new entry with
  `sleepEpoch`/`boundarySeq`/`previousSessionId`, `schemaVersion` present), does NOT set
  `webUiCleanupPending`/`deferredJournalSeed`, old artifact byte-identical, `concludeTurn`
  called.
- T3 — journal re-key (D3): `journals/host-<newId>.md` exists with `wake_counter` N+1 and
  `author: host-<newId>`; old file byte-identical; writes atomic (tmp+rename).
- T4 — wake gate + retirement: first pre-step of the NEW session injects the full pack
  (exactly +1 `plugin`/`notice` node, `## Deepartments wake pack` + `pack-v1: present`,
  mirrors invoke.test.js:3048); a pre-step against the OLD session (seeded retired entry)
  injects NOTHING; second pre-step on the new session gated (no re-inject); a legacy hosts.json
  (no new fields) keeps pre-rotation behavior.
- T5 — boot hook: retired AND archived entries never truncated even if a stray
  `webUiCleanupPending` is present; legacy flagged hosts still cleaned exactly once.
- T6 — crash windows: (a) hosts.json persists with the new member → wake consistent (journal
  file exists); (b) the S2.5→S3 window is repaired at boot (live entry whose sessionId is in
  the archive registry → roll to `rotatedTo`/treat retired); (c) orphan re-keyed journal/new
  session garbage tolerated.
- T7 — REAL-Loader end-to-end (like the `1fd4543` restart regression "ok 76"): dispose →
  re-boot with the ROTATED hosts.json + both journal files → first pre-step of the new session
  folds nothing, injects the pack from the new journal path; **wire summary assertions**: new
  session `blank: true` + `archived: false` in `workspace.list`; old session in
  `archivedSessionIds`; old artifact + old journal byte-identical; workspace registry state
  file holds `archivedSessionIds: [oldId]`.

**Live sleep→wake validation matrix (owner-run at the next real sleep→boot cycle — the
NON-NEGOTIABLE rule "NEVER run the real dept_sleep as verification" still applies; the
real-Loader suite is the automated gate):**

| Case | Expect |
|---|---|
| sleep → wake (same process) | old tab hidden (archived), new blank opens, native sidebar shows fresh "New Session" row; old session gone from list |
| sleep → restart → wake | boot clean, no cleanup, new session resumes with pack (wake_counter N+1), old artifact + journal intact, old row absent |
| crash between S1.5b and S2.5 | old session continues (hosts.json unchanged); garbage tolerated |
| crash after S2.5 before S3 | boot repair rolls to the new member; old artifact intact (T6) |
| crash after S3 before S8 | hosts.json points at new member; old artifact intact; next boot consistent |
| message typed in the OLD tab | plain-session behavior (no pack), new session unaffected |
| last legacy in-place host resumes | deferred fold fires once and clears (1fd4543 behavior unchanged) |

**Ladder:** `pnpm build` → `pnpm test` → `dsh plugin --profile deepartments-dev add …` →
`dsh --profile deepartments-dev --dump-config` → headless smoke on a **scratch** stateDir (the
headless twin cannot replay a seeded host-session resume — the restart fold is covered by the
real-Loader test, per the `1fd4543` smoke limitation).

---

## 9. Decisions + remaining open items for the owner

### Resolved (baked in — do NOT re-litigate)

- **Q1 → server-side archive (D1)** — closed. Canonical API + semantics verified in this
  session (dsh-workspace lib/index.js:422-432; no agent/subagent termination; artifact
  untouched; native UI hides archived automatically; retired hosts.json entry stays
  queryable).
- **Q2 → keep all retired sessions in full (D2)** — closed. No cap; pre-rotation copy at S2.7.
- **Q4 → journal re-key (D3)** — closed. `host-<newId>` path + author/room re-key; seed built
  from the re-keyed journal.
- **Q6 → ui.json deletion + hosts.json schema (D4)** — closed. `/.deepartments/ui.json`
  deleted in the removal step; `retired`/`rotatedTo`/`previousSessionId` + version marker with
  loader validation.

### Genuinely open (need the owner's answer before dispatch)

- **R-Q3 — Board-roster semantics of the retired hostId.** The old entry stays in hosts.json
  (D1), but should it appear in `dept_room_who`/`dept_wake_snapshot` as `retired` (recommended,
  transparent evidence) or be excluded from "present" entirely? And does `dept_post_retire`
  change at all (recommendation: no — posts registry is a separate lifecycle, C10)?
- **R-Q5 — Orphans of the retired host.** The old host's still-live subagents keep a
  `parentSession` to a retired+archived parent: (a) leave parked + document (recommended —
  archive does not terminate them, §3.3-S2.5; sweep is a separate feature), or (b) sweep/
  archive their sessions at rotation.

---

## PATTERNS / INVARIANTS / SURPRISES (for the builders)

- **Invariants kept:** host wake targets only the hosts.json-registered session (bfe50ff);
  seeds contiguous from seq 0 (dsh-session lib:1381); never truncate a live/resumed session
  (196eb75 + 1fd4543 guards stay); archive ≠ delete (the archive registry hides, never
  deletes; the evidence archive copies, never deletes; no `workspace.archiveSession` on
  anything but a retired host); blank-reuse resurrects a still-blank session (never
  `connectWorkspace` to a legacy blank); hashed CSS classes are not a stable seam (drop the
  patch, never add another).
- **Surprises verified this session:** (1) `archiveSession` is a PURE registry-set add — the
  "stops session+subagents" annotation belonged to the removed plugin sidebar, not the
  runtime; (2) a seeded `user/message` journal node keeps `blank: true` (blank := no
  `turn/start`), so the rotated new session IS the native "New Session" row; (3) the archived
  push (`host/archived-sessions-changed`) clears the current selection if the old tab was
  current — the GUI drops to no-selection for at most one poll before opening the new
  session; (4) the entire deferred-replace machinery (Fix A/wake-12) becomes
  rotation-unreachable — keep it only for legacy in-place sleeps; do not "simplify" it away
  until migration is done.
- **Primary source line refs for builders:** `native-sidebar-clone.md` §2 (seam), §3 (rows/
  no sleep signal), §4 (connectWorkspace/create-open/archive dangers), §5 (full removal list);
  `context-injection-gate.md` §2 (hosts shape + gate point invoke.ts:2661-2664);
  `cleanup-trigger-mechanics.md` §2-4 (hook ordering, backup path, boot-before-materialize);
  `ui-cleanup-build.md` (contiguity proof, safe-point = boot); `fix-deferred-replace-islive.md`
  (deferredJournalSeed restore + live-guard + smoke limitation). Runtime verification for D1
  defined in spec_ref.