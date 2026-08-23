---
agent: builder
date: 2026-08-23
task: research-department-spec
spec_ref: "Owner decisions (2026-08-23): the Deepartments project becomes ONE REAL COMPANY — durable departments with a head who coordinates and deploys agents, and only the head reports to the Asistente or to other departments. The RESEARCH DEPARTMENT is headed by the Research Head (RH): the RH coordinates/deploys researchers and is the one who reports results; the Asistente never coordinates any research (no on-demand, no scheduled, no reply-triggered) — delegating a research request is send_message to the RH, the only path. TWO operational agent kinds (jobs — versioned, reusable task definitions; ephemerals — one-off, retired after), both materialized as DISCONNECTED root-agent workers with their own sidebar session (never harness subagents). ROLES are person templates referenced by name. Sidebar folder 'Research Department' (L1 recommended: real workspace per department; 'Ungrouped' removed). Messaging ACL: worker → own department only; head → any head + own department; host → everyone. Jobs versioned in the repo (schedule RESERVED — no scheduler this phase; manual dept_job_run). Primary sources: explore-deep/2026-08-23-sidebar-catalog-departments.md (sidebar/catalog file:line facts), explore-deep/2026-08-22-head-machinery.md, docs/specs/003-agent-messaging.md (spec style), presets/ + org.ts + invoke.ts + messages-store.ts verified in-repo."
outcome: FINAL DRAFT (owner decisions adopted) — DRAFT-ONLY, no commit, no other files touched
files_touched:
  - docs/specs/004-research-department.md (this draft)
---

# Departments & the Research Department — design spec (phase 3)

Status: **FINAL DRAFT — all decisions below are owner-approved (2026-08-23) and are
requirements, not proposals. Ready for builder dispatch (phases F1–F6, §8).**
`❓` marks owner-decision points (§9) and builder-verify points (implementation
detail, deferred to the builder). All harness file:line facts come from the
explore traces listed in `spec_ref`; plugin `src/` line refs were verified
against the working tree at spec time.

---

## 0. Owner decisions adopted (2026-08-23) — requirements, not proposals

| # | Decision | Baked in as |
|---|---|---|
| D1 | **One real company**: durable departments, each with a head who coordinates and deploys its agents; **only the head** communicates results to the Asistente or to other departments. | §3.1, §5.6 |
| D2 | **Research Department**: the Research Head (RH) is the chief; it coordinates and deploys researchers and is the one who reports results to the Asistente or to the requesting department. **The Asistente never coordinates anything research-related** (not on-demand, not scheduled, not as a reply to something): delegating research to the RH is the only path (a message to the RH). | §3.5, §5.6, §7.2 |
| D3 | **Two kinds of operational agents** (both runtime-ephemeral, both DISCONNECTED subagents with their own sidebar session — never harness subagents): **jobs** (posts defined with person + concrete task, versioned in the repo, reusable by any agent — the definition/task is SAVED so another agent can execute it) and **ephemerals** (no fixed task; deployed for a one-off need and removed afterward). | §3.3, §3.4, §5.2–5.4 |
| D4 | **Roles inside each department** (e.g. researchers, reviewers who check report factuality, organizers who organize reports weekly). Organic: in the future the RH or another department may ask the future internal-programming department to add NEW subroles. Roles are person templates (system prompt + toolset) referenced by name. | §3.2, §7.1 |
| D5 | **UI/sidebar**: the Research Department agents appear in the sidebar inside a folder named **"Research Department"** (today: "root" and "Ungrouped"). **"Ungrouped" is removed.** The Research Head and its workers appear in that folder. | §6 |
| D6 | **Messaging**: workers → only agents of THEIR department (incl. their head); heads → any head (RH ↔ Asistente ↔ other heads) + the agents of their department. A worker CANNOT write to heads of other departments nor to agents of other departments (everything goes via its head). The Asistente (host) can talk to everyone. | §5.6 |
| D7 | **Jobs**: definitions versioned in the repo (what the role does, periodicity, assignment — e.g. `docs/departments/research/jobs/*.md`). **Automatic triggering (calendar/scheduler/cron) is NOT implemented in this phase** — `schedule` field RESERVED; manual execution by the RH (tool `dept_job_run`) meanwhile. | §3.3, §5.4 |
| D8 | **Session scope**: marathon — design + COMPLETE implementation in this session. | §8 |

---

## 1. Context & Motivation

The Deepartments organization becomes **one real company**: not a flat catalog of
agents, but durable departments, each with a head, workers and roles, and a
messaging ACL that mirrors the reporting chain (worker → head → Asistente).
There are also jobs: reusable, versioned task definitions the head can execute
on demand.

Today the plugin is **flat** (verified in the working tree):

- The catalog has no department dimension: `PostEntry` (src/invoke.ts:219-255,
  persisted :257-267) carries `postId/sessionId/roomId(inert
  'board')/agentPreset/provider?/role?/sleepEpoch?/boundarySeq?/previousChildId?`
  — **no `departmentId`, no manager, no job link**. Department membership exists
  only in config (`org.departments[].coordinator.postId`, src/org.ts:23-43,
  schema :71-90); workers have no department link at all (the creating head is
  not recorded — `dept_post_create` only copies the inert `roomId`, invoke.ts:
  2963-2970).
- `dept_post_create` is **head-only** (the tool is registered only in the head
  own-layer under `if (manager)`, invoke.ts:2920-2988) and the host has no
  worker tools (per D2, the Asistente must never mint research workers).
- `retirePost` (invoke.ts:3129-3150) has a **generic scope check**: a HEAD
  caller may retire any `provider: 'worker'` post — not "only MY workers"
  (:3134-3141).
- `dept_who` reports every post as `kind: 'head'` (invoke.ts:3952 — the schema
  only has `'host'|'head'`), so workers are indistinguishable from heads.
- Workers are never title-pinned (only heads, `ensureHead` pin at invoke.ts:
  3347-3356, via `pinSessionTitle` :1173-1188) → the sidebar row shows the raw
  id or the cwd basename (dsh-client-runtime/lib/client.js:8821-8833).
- The sidebar is 100% the native harness `WorkspaceBrowser`: the plugin client
  renders nothing (src/client/index.tsx:1-28, U1). Heads AND workers are created
  with `meta.cwd = resolveWorkspaceRootPath()` (invoke.ts:3179-3223; create
  :2959, ensureHead :3322/3331, materializePost :3513) → they all land in the
  SAME workspace as the host ("root"). There is no folder per department.
- There is **no send-permission check** anywhere: `deliverBusRecord` (invoke.ts:
  3624-3691) routes child-first, then catalog, with no ACL (explore report
  `sidebar-catalog-departments` §d).

What the owner wants (D1–D8) maps to five concrete capabilities the explore
report identified as gaps:

1. **Folder per department** in the sidebar (§6) — L1 (plugin-only, recommended)
   vs L2 (harness change).
2. **Disconnected workers + jobs** — a job/task mechanism beyond the single
   first-bus-message assignment (explore §b).
3. **A worker kind + a department link** in the catalog (explore §a.3/§d).
4. **Retire cleanup** — the row must disappear from the sidebar: today
   `retirePost` never archives the durable session (explore §c: the harness has
   no delete; the plugin already owns the archive seam, src/session-rotation.ts:
   270-291 `WorkspaceRegistryLike.archiveSession`, used by host rotation S2.5).
5. **Send scoping** — the D6 ACL (§5.6).

---

## 2. Goals & Non-Goals

### Goals (requirements — do NOT re-litigate)

1. **G1 — Departments as durable units.** `org.departments[]` (config) is
   extended: `{id, name, workspacePath?, jobDir?, coordinator: {postId, title,
   sessionTitle}}`; the department groups 1 head + N workers + N roles +
   versioned jobs. The Research Department exists in config
   (cordis.patch.yml:15-28 already declares `id: research`, `name: Research
   Department`, coordinator `research-head`).
2. **G2 — Two operational agent kinds (D3).** Both are workers — same
   materialization (`worker-<slug>-<uuid>` root agent, own session, own sidebar row);
   the difference is provenance: a **job worker** carries a versioned job id
   (reusable definition) and **an ephemeral** carries a one-off task. Neither is
   a harness subagent (no `subagent/descriptor`, no parent; they are catalog
   root agents, D3 + §4).
3. **G3 — Roles as named templates (D4).** `researcher` / `reviewer` /
   `organizer` for the Research Department; a role = persona text + tool
   allowance, versioned in the repo, referenced by name from jobs and
   ephemerals; extensible organically (§3.2, §7.1).
4. **G4 — Research is the RH's business only (D2).** No research tool is
   registered on the host plane; the Asistente delegates by `send_message` to
   `research-head`; the RH spawns/retires workers and reports back.
5. **G5 — Sidebar folder "Research Department" + no "Ungrouped" (D5)** via L1
   (§6.2): a real workspace entity per department, department agents created
   with that cwd, title-pinned rows, retired workers archived.
6. **G6 — Messaging ACL (D6)** in `deliverBusRecord`: worker → own department
   only; head → any head + own department; host → everyone; per-recipient
   `'failed'` on violation (never fails the whole send).
7. **G7 — Jobs versioned + manually executed (D7).** `dept_job_run`/`dept_job_list`
   read the repo definitions; `schedule` is reserved (no scheduler).

### Non-goals (explicitly out of scope for this spec)

- **No scheduler/calendar/cron** (D7): `schedule` is a reserved, informational
  field; `dept_job_run` is manual.
- **No job status/queue registry** beyond the worker lifecycle (created → work
  → memo → sleep → retired): no `jobs.json` status projection, no re-assign
  queue, no `dsh-goal` integration this phase.
- **No host-plane worker tools** (D2): the Asistente does NOT create workers;
  `dept_post_create` stays head-only.
- **No virtual-folder harness change unless the owner picks L2** ($9 Q1).
- **No harness modification for "Ungrouped" removal** (hygiene only, §6.4).
- **No message purge on retire by default** (§9 Q5 — recommended: keep).
- **No GUI-chat resume fix** for posts opened directly from the sidebar (the
  `composeAgent` own-layer gap, §6.6) — documented, deferred.
- **No cross-department worker spawning**: a head can only spawn/retire workers
  of its own department (§5.2–5.3).

---

## 3. Conceptual model

```
Department (org.departments[], config + repo dirs)
 ├── Role   (presets/departments/<dept>/<role>.md — persona + toolset template)
 ├── Job    (docs/departments/<dept>/jobs/<slug>.md — versioned task definition)
 ├── Head   (worker 0: the coordinator — a permanent root agent, today's
 │           ensureHead machinery, unchanged: head-<postId>, manager gate)
 └── Worker (root agent worker-<slug>-<uuid>: role template + task; ephemeral or
             job-backed; its own sidebar session in the department folder)
```

### 3.1 Department

```jsonc
// config.org.departments[] — extended (schema in src/org.ts:71-90)
{
  "id": "research",                       // stable department id (config-only)
  "name": "Research Department",          // folder label (D5) — today cordis.patch.yml:18
  "workspacePath": "/root/.deepartments/departments/research",  // ❓ Q2 (L1, §6.2)
  "jobDir": "docs/departments/research/jobs",                    // repo-relative (❓ Q7)
  "coordinator": { "postId": "research-head", "title": "Head of Research", "sessionTitle": "Research Head" }
}
```

- A department **aggressively groups**: 1 head + N workers + N roles + versioned
  jobs, and owns one sidebar folder (the workspace of `workspacePath`, §6.2).
- The department is **defined in config** (org.departments[]) — hot-created
  departments (`dept_create`) are a future phase (§9 Q6).
- The head = the department's manager: `dept_worker_spawn` / `dept_worker_retire`
  / `dept_job_run` / `dept_job_list` are registered in its own layer only
  (manager gate, today `if (manager)` at invoke.ts:2920).

### 3.2 Role

A role is a **person template referenced by name** (D4): a persona text (system
prompt) + a tool allowance, NOT a living agent. Conventions:

- **Repo layout (proposal, ❓ Q7)**: `presets/departments/<dept-id>/<role>.md` —
  frontmatter `{id, title, tools}` + body = persona text. The existing
  `presets/` tree (presets/deepartments-head/, presets/deepartments-worker/,
  each `preset.yml` + `agent.cordis.yml`) holds the *base* presets; the role
  template is the leaner per-role delta (persona + tool list), materialized at
  spawn time by the plugin (no new base agent preset per role).
- **Initial Research Department roles**: `researcher` (web research), `reviewer`
  (report factuality checks), `organizer` (weekly report organization) — §7.1.
- **Organic extension**: a new role is a new file + a person-name; the future
  internal-programming department (or the RH) may add roles without touching
  code (the plugin reads `presets/departments/<dept>/<role>.md` by name).
- Roles are reusable by jobs AND ephemerals: `dept_job_run` / `dept_worker_spawn`
  resolve the role name → template → persona + toolset.

### 3.3 Job

A job is a **versioned task definition** in the repo (D3/D7):

```markdown
---                     # docs/departments/research/jobs/<slug>.md   (❓ Q7 layout)
id: monitor-dsh-updates
title: Monitor dsh + plugin updates daily
role: researcher        # the role template to materialize (D4)
description: Check the dsh release + this plugin's updates, report to the RH.
schedule: daily         # RESERVED (D7) — NOT implemented; informational only
owner: research-head
---
<the task body: the full prompt the head would otherwise write>
```

- `dept_job_run <id>` reads the definition and materializes a worker with the
  role's persona + the job's task as its assignment (equivalent to
  `dept_worker_spawn` with `jobId`), §5.4.
- `schedule` is parsed and displayed but **never triggers anything** in this
  phase (D7).
- First jobs of the Research Department (§8 F4): `monitor-dsh-updates`
  (daily-ish), `weekly-report-organize` (the organizer's weekly run), plus
  reusable research templates as the RH sees fit.

### 3.4 Worker

- A worker is a **DISCONNECTED root agent** (D3): `worker-<slug>-<uuid>` session id (id único por encarnación, como los heads F8)
  (WORKER_SESSION_PREFIX, invoke.ts:170-175), created via `ctx.agents.create`
  from the plugin root ctx — `origin: undefined`, lands in `agents.roots()` like
  host/heads; **never** a harness subagent (no parent, no `subagent/descriptor`;
  the native `send_message` child adapter can never reach it — it always goes
  through the catalog route, §5.6).
- Lifecycle: spawn (role persona + task) → work the task → `dept_memo_write` →
  `dept_sleep` → head retires (`dept_worker_retire`: unregister + archive
  session, §5.3). BOOT-QUIET persona (never acts unaddressed) — today's
  `installRoleSection` worker framing (invoke.ts:3024-3034) carries it.
- Two provenances (D3): **job worker** (`jobId` set, slug = job id, deduped) and
  **ephemeral** (`jobId` absent, slug = head-chosen slug, deduped `-2`, `-3`…).
  Both are runtime-only (never in config) → a retired worker is never
  re-materialized by boot (`ensureAllHeads` iterates config only, invoke.ts:
  3371-3403).
- Re-materialization on restart: a live-but-dormant worker is lazily resumed on
  its next bus delivery (materializePost resume path, invoke.ts:3476-3528) —
  unchanged.

### 3.5 Who coordinates what

- **The Research Head coordinates the Research Department** (D2): spawns /
  retires researchers, runs jobs, reads results, and is the ONLY one who
  communicates results to the Asistente or to another department.
- **The Asistente never coordinates research** — no `dept_worker_spawn` on the
  host plane, no research presets for the host; delegating research = one
  `send_message` to `research-head` (D2).
- The RH does NOT coordinate harness subagents either (no builder delegation;
  that is the Asistente's machinery) — it deploys *workers* (§7.2 persona).

---

## 4. Data & catalog

### 4.1 `PostEntry` extension (invoke.ts:219-255 + persisted :257-267)

```jsonc
{
  postId, sessionId, roomId, agentPreset,          // unchanged
  provider: 'worker',                              // unchanged marker
  kind: 'worker',                                  // NEW derivation ONLY
  role: 'researcher',                              // role TEMPLATE id (was free text)
  departmentId: 'research',                        // NEW — durable department link (D6, §5.2)
  managerId: 'research-head',                      // NEW — the creating head (restore "my workers")
  jobId: 'monitor-dsh-updates',                    // NEW — set when spawned by dept_job_run
  retired?: true,                                  // NEW — retired workers stay in posts.json (§4.3)
  sleepEpoch?, boundarySeq?, previousChildId?      // unchanged
}
```

- `kind` joins `'host'|'head'|'worker'` in the roster vocabulary (D5/explore
  §d.4): a post is a `'worker'` when `provider === 'worker'`, a `'head'` when it
  is a configured coordinator (`coordinatorForPost`); the host stays `'host'`
  (hosts.json). The `dept_who` hardcode `kind: 'head'` for every post
  (invoke.ts:3952) is corrected in F3.
- `role` currently captures free text (invoke.ts:240 comment); it becomes the
  **role template name** ("researcher" | "reviewer" | "organizer" | a future
  subrole), so the durable entry fully defines how to re-persona a resumed
  worker.
- Backfill: existing posts.json entries lack the new fields. Heads are derived
  from config (departmentId = config department); workers created before this
  change have **no departmentId** → ❓ builder-verify backfill policy
  (recommended: workers without departmentId are treated as legacy ungated
  orphans for retire — retire-by-head keeps requiring a match — and are listed
  by dept_who with `departmentId` absent; the known legacy worker
  `worker-researcher-alpha` is retired+archived in F5 hygiene, §6.4).
- `managerId` (the creating head postId) is recorded at create time — today the
  creator is NOT recorded (only the inert roomId copy, invoke.ts:2963-2970);
  this restores the per-owner scope on retire (§5.3).

### 4.2 Registered creator + "only MY workers" retire

- `dept_worker_spawn` records `departmentId` + `managerId` (and `jobId` when job
  run). `dept_worker_retire` scope check: the caller's post must be the entry's
  **manager** (or same `departmentId` head) — replacing the current generic
  `provider === 'worker'` check (retirePost :3134-3141), per explore §d.3.

### 4.3 Retirement = marked, not erased

- `dept_worker_retire` (D3/D5): unregister from addressing + **`archiveSession`**
  of the durable session (seam src/session-rotation.ts:270-291, host-rotation
  precedent S2.5 :301+) so the row disappears from the sidebar; the worker stays
  in posts.json as **`retired: true`** (hosts.json precedent:
  `HostEntry.retired`).
- Addressing filters retired entries: `busDeliverCatalog` (invoke.ts:3695-3706),
  `dept_who` (shown with `retired: true`, not addressed), wake paths skip them.
- Message history stays (Q5 recommended): the per-recipient index is compacted
  against durable members; **recommended** keep-rule = retired workers' messages
  are kept (no purge) — a purge tool is a later phase. ❓ Q5.

### 4.4 Catalog per department

- posts.json can list the workers of a department (filter `departmentId`) — for
  `dept_who` (each entry carries `departmentId`, `kind`, `role`, `jobId`) and for
  the RH to manage its own (§5.1).

---

## 5. Tools

### 5.1 `dept_who` extended (invoke.ts:3896-3966)

- No new parameter (the roster stays the org; a filter is a later phase).
- Per-entry fields added: `departmentId?`, `kind: 'host'|'head'|'worker'`,
  `role?` (template id), `jobId?`, `retired?` (workers). `you: true` preserved.
- Title for worker rows: the pinned session title (spawn `title?` → the role
  template id → postId fallback; §4.1 title chain stays head-presets.ts
  `headRoleLine`-style: title → role → postId).
- The RH manages its workers by filtering `departmentId === 'research'`.

### 5.2 `dept_worker_spawn` (head, manager gate, own department only)

```
dept_worker_spawn({ department, role, task?, jobId?, title? })
  → { postId, sessionId, departmentId, role, jobId?, definitionPath? }
```

- Registered only in the head own-layer (the `if (manager)` block, invoke.ts:
  2920) — a worker or the host never sees it (D2: the Asistente CANNOT mint
  research workers; structural, not policed).
- Validation: the caller is a registered head; `department` MUST equal the
  caller's own department (a head cannot spawn into another department);
  `role` MUST name an existing role template (§3.2); `postId`-ish slug dedup:
  `worker-<slug>` — a collision reuses the slug with `-2`, `-3`… (today
  `dept_post_create` rejects duplicates, invoke.ts:2951; the new tool dedups
  instead, D3 reusability).
- Materialization: the existing `dept_post_create` engine (create root agent +
  registerEntry + first bus message, invoke.ts:2921-2988) with these deltas:
  `cwd = department.workspacePath` (department-aware
  `resolveWorkspaceRootPath`, §6.2 — NOT the host workspace root);
  persona = the role template's persona + the task (or the job's body);
  `title` pin on the session (pinSessionTitle) so the sidebar row is
  human-readable (workers are unpinned today — explore §b);
  PostEntry gets `departmentId` + `managerId` + `jobId?`.
- Returns the post id + session id (the head reports it and can address it).

### 5.3 `dept_worker_retire` (head, manager gate, ONLY its workers)

```
dept_worker_retire({ postId }) → { postId, retired: true, archived: boolean }
```

- Scope (HARD): the target MUST be a worker (`provider: 'worker'`), NOT retired,
  and its `managerId`/`departmentId` MUST match the calling head (restore the
  per-owner check — retirePost :3134-3141 becomes
  `entry.departmentId === callerEntry.departmentId` (or manager match) instead
  of the generic "any worker").
- Body: `retirePost` (dispose handle deduped via `disposeHeadHandleOnce` +
  unregister from addressing + persist, :3129-3150) **plus** `archiveSession`
  (non-fatal, src/session-rotation.ts:270-291) so the sidebar row disappears;
  the entry remains in posts.json as `retired: true` (§4.3).
- ALWAYS succeeds for a worker of the head's department; loud rejection
  otherwise (unknown id, not-a-worker, other-department).

### 5.4 `dept_job_run` (head)

```
dept_job_run({ jobId }) → { postId, sessionId, jobId, role, definitionPath }
```

- Reads the job definition from the department's jobDir (§3.3 layout) — the repo
  path is resolved relative to... ❓ builder-verify the repo-root resolution
  (candidate: the plugin's own `repoRoot`-style constant, the same the bundle
  uses for `presets/` materialization; the job files live in the SAME repo as the
  bundle, so the bundle dir is the floor).
- Spawns a worker exactly like `dept_worker_spawn` with `role` + the job body as
  task + `jobId` recorded; returns the id + the definition path. `schedule` is
  ignored (reserved, D7).
- Missing job / unknown role / bad frontmatter → loud error (the definition file
  is versioned; a syntax error must fail the run, not silently spawn a
  task-less worker).

### 5.5 `dept_job_list` (head)

- Lists the department's jobs from the repo: `{id, title, role, schedule?,
  owner, path}` per job (id/title/role/schedule/owner from frontmatter).
- No parameter or an optional `department` that must equal the caller's.

### 5.6 ACL of `send_message` — in `deliverBusRecord` (invoke.ts:3624-3691)

The check runs per recipient, per catalog-route target (the child route is out —
see below), BEFORE any wake, consistently with the `'failed'` per-recipient
pattern of unknown ids (invoke.ts:3704-3705):

| Sender (resolved via `busMemberIdFor` :3720 + entry of byPost/hosts) | May send to | May NOT send to |
|---|---|---|
| **worker** (`provider: 'worker'`, non-retired) | agents of its OWN `departmentId` (incl. its head) + `'self'` | heads/workers of OTHER departments; **the host (Asistente) — PROHIBITED** (D6: it must go via its head) |
| **head** | any head (incl. the host — the host is the top head in the reporting chain; D6 "RH ↔ Asistente ↔ other heads") + agents of its own department | workers of other departments (they go via the other department's head) |
| **host** | everyone (any head, any worker, any host entry) (D6) | — |

- Violation → that recipient is reported `'failed'` with an ACL reason (the send
  is not aborted; one blocked recipient does not kill a multi-send — the
  `unknown` precedent, invoke.ts:3704).
- **`'self'`** stays held (acked, never woken; :3635-3638).
- **Framing / always-wake unchanged**: the framed `[From X → a, b]: text` text
  and the wakePost/materializePost delivery seam are untouched; only the
  permission gate is added.
- **The child route is OUTSIDE the ACL**: `subagents.followup` targets (the
  Asistente's transient builders/reviewers) are NOT department workers — they
  are never catalog-validated, and the router already decides child-first
  (:3639-3676). Workers are ROOT agents of the catalog, NOT children, so they
  always go through the catalog route — the ACL always applies to them.
- ❓ Builder-verify: sender resolution edge — a plain session that self-registered
  as host via `busEnsureHostForCaller` (:3731-3742) is a `'host'` (full reach);
  a transient subagent calling `send_message` keeps the native tool (spec 003
  D2: the plugin's own-layer shadow covers posts + host sessions only) and is
  not an ACL subject.

### 5.7 `dept_post_create` / `dept_post_retire` compatibility

- The head-layer tools KEEP working (they are the raw machinery: create/retire a
  worker with a hand-written role + task). The new `dept_worker_spawn` /
  `dept_worker_retire` are the department-scoped refinement of the same engine
  (role template resolution, creator recording, cwd, archive-on-retire, retired
  marker) — recommended: reimplement the old tools on top of the new engine so
  both stay consistent; the RH uses the new ones. ❓ Builder-verify exact
  refactor boundary (an old tool calling the new engine keeps its schema).
- The host plane has NO worker tools (D2) and keeps none.
- Uniqueness: a worker slug must not shadow a configured head (today's guard
  `coordinatorForPost`, invoke.ts:2952) — kept in both engines.

---

## 6. Sidebar / UI (the folder)

### 6.1 Facts that shape the design (explore §a, verified)

- The sidebar is **100% native**: the plugin client renders nothing
  (src/client/index.tsx:1-28, U1); a "folder" IS a `dsh-workspace` Workspace
  entity — durable record `{path, title, sessionIds}`
  (dsh-workspace/lib/index.js:181-189), title default `basename(path)`
  (:456-458), renameable.
- Membership is a HARD invariant: a session attaches ONLY if its persisted
  header cwd canonicalizes to the workspace path (`attachSession` realpath
  validation, dsh-workspace/lib/index.js:87-105; strict equality — a mismatch
  throws). The cwd is **immutable per session** (SessionCwdConflict,
  dsh-host-apiproxy) → sessions cannot be re-homed at runtime.
- The client groups by workspace entity; sessions outside every trail go to
  **"Ungrouped"** (dsh-client-ui-workspace/lib/client.js:147-165, stray push
  :162, label :456) — the group is created ONLY when ≥1 stray exists.
- Row label = `displayTitleOf(durable title, cwd, id)` (dsh-client-runtime/lib/
  client.js:8821-8833): the plugin pins titles (host :1198-1200, heads
  :3347-3356 via pinSessionTitle :1173-1188) — workers are NEVER pinned today.

### 6.2 Option L1 (RECOMMENDED, plugin-only)

1. **One real workspace per department**: create the workspace entity via the
   workspace service — `create(path, title)` (the SERVICE accepts a title;
   dsh-workspace/lib/index.js:331-344; ❓ builder-verify widening the plugin's
   structural `WorkspaceRegistryLike`, src/session-rotation.ts:283-291, to
   include `create(path, title?)` / the api-proxy `ensureWorkspace` shape
   dsh-host-apiproxy/lib/index.js:2140-2148). Path proposal (❓ Q2):
   `/root/.deepartments/departments/<dept-id>` — a real directory OUTSIDE
   `sessions/`, inside the plugin stateDir; the directory must exist (create
   realpath-validates).
2. **Department-aware cwd**: `resolveWorkspaceRootPath` (invoke.ts:3179-3223)
   becomes department-aware — head AND workers of a department are created with
   `meta.cwd = department.workspacePath`; `attachHeadSession` (invoke.ts:
   3246-3280) then attaches them to the department workspace → the client groups
   them under the workspace title **"Research Department"** automatically
   (D5). The host stays in its own workspace ("root") — the folder separation is
   a direct consequence of the cwd policy, not a harness change.
3. **Title pins**: heads pin `coordinator.sessionTitle` (today), workers pin
   `title ?? role ?? slug` (F3) so rows are human-readable.
4. Result: folder "Research Department" = {Research Head, worker rows}; the
   Asistente stays in "root"; no harness change (L1 cost: a department of agents
   works with its own cwd — the intended department workspace).

### 6.3 Option L2 (alternative — harness change, only if the owner prefers)

- Virtual workspace / metadata grouping: a workspace entity with a synthetic
  path + per-session `workspaceOverride` (from `meta.agentPreset`/`org`) or
  client-side grouping by departmentId — requires changes in dsh-workspace
  (attach validation), dsh-host-apiproxy (`workspaceView`, a move API) and
  dsh-client-ui-workspace (`groupByWorkspace`). More invasive; only gain over L1:
  label folders without moving cwd. ❓ Q1 (recommended: L1).

### 6.4 Remove "Ungrouped"

- The bucket renders only when strays exist (client.js:147-165 — group pushed
  at :162 only when `stray.length > 0`). No harness change needed:
  - every plugin-created session is workspace-attached (already done
    :attachHeadSession / materializePost :3526);
  - **retire archives the session** (§5.3) — cold session artifacts (which the
    native list still shows) stop being listed;
  - known legacy strays are cleaned in F5 (e.g. the durable
    `worker-researcher-alpha` session artifact — archive it; the current
    research-head migration is §6.5).
- NOTE: cold sessions of RETIRED-but-not-archived posts remain in the sidebar
  (delimitable durable artifacts) — that is precisely why `dept_worker_retire`
  MUST archive (D5: "quitar Ungrouped" fails silently otherwise).

### 6.5 Migration of the current research head (F5, ❓ builder-verify mechanics)

- Today `head-research-head` lives with `cwd /root` (created via
  `resolveWorkspaceRootPath` → the host workspace). The workspace is bound at
  creation; cwd is immutable → migration = **archive the old session and
  re-materialize** (retire style: `archiveSession` old `head-research-head`,
  `ensureHead` creates the head fresh at the department cwd; the journal
  (`journals/research-head.md`) and posts agentPreset carry the identity
  continuity across the new session — the session log is not carried, accepted).
- Alternative (documented, not recommended): keep the head at `/root` and only
  move NEW workers into the department workspace — leaves the head row in
  "root" against D5.
- ❓ Builder-verify the exact reseed ordering so posts.json/`byPost` never has
  two live entries for one postId.

### 6.6 Open note (document, out of scope)

- A post opened directly from the GUI (resume with `composeAgent` on the stored
  preset — dsh-host-apiproxy/lib/index.js:2080-2120 — without the plugin's own
  layer setup, since the agent/created hook skips registered posts, invoke.ts:
  4021) would miss the dept_* own-layer tools. Bus wake flows are fine (plugin
  resume with setup). NOT in scope this phase; document in the deploy notes +
  a later smoke if the owner starts chatting with head rows directly.

---

## 7. Personas & presets

### 7.1 Role templates of the Research Department

The role `tools` **binding is IMPLEMENTED** — the `tools` frontmatter list IS
the effective `restrict` allow-list for the role (no longer a "later phase" /
builder-verify point). `role` = person template referenced by name; the runtime
worker's cwd is the department workspace, so the deliverable paths below are
relative to that workspace (`reports/...`), not `.dsh/reports/...`.

| Role | Persona (template) | Tools (binding implemented) | Report protocol |
|---|---|---|---|
| `researcher` | Research agent: web investigation (web_search/web_fetch), reads the head's request → consults `sources/` → investigates → archives sources → writes a report → reports to the head | web_search, web_fetch, read, write, glob, grep + bus tools (send_message/agent_messages/dept_who) + dept_memo_write + dept_sleep. **NO subagent tools** — it is a root worker, not a harness subagent | writes `reports/researcher/<date>-<slug>.md`; replies to the RH via send_message; communicates ONLY within the department (ACL, D6) |
| `analyst` | Organic synthesis layer: reads one or more researcher reports, prioritizes/trims/consolidates them into a structured synthesis (key findings, evidence, uncertainties, gaps) for the head | read, write, glob, grep, web_search, web_fetch + bus + dept_memo_write + dept_sleep. **NO `edit`** (deliberate — synthesizes, never mutates a researcher report) | writes `reports/analyst/<date>-<slug>-synthesis.md`; replies to the RH |
| `reviewer` | Factuality checker: verifies claims/citations of research reports, runs checks, issues PASS/FAIL verdicts with evidence | read, write, glob, grep, web_search, web_fetch + bus + dept_memo_write + dept_sleep | writes `reports/reviewer/<date>-<slug>-review.md` (PASS/FAIL + citations); replies to the RH |
| `organizer` | Weekly organizer: indexes/naming/cleanup of the department report archive | read, write, edit, glob, grep + bus + dept_memo_write + dept_sleep | summary to the head; maintains the reports index `reports/INDEX.md` |

- All four: BOOT-QUIET (never act unaddressed — today's worker framing,
  invoke.ts:3024-3034); messages only inside the department; memory via
  `dept_memo_write`; **ephemeral by default** (see §7.5) — a JOB worker sleeps
  between rounds asking ITS head, never the host (worker → host PROHIBITED, §5.6).
- Role templates live at `presets/departments/research/<role>.md` (§3.2, ❓ Q7);
  the static department design is `presets/departments/research/ARCHITECTURE.md`.

### 7.2 Research Head persona (updated)

The `deepartments-head-<departmentId>` persona text (generated from the base
`presets/deepartments-head/agent.cordis.yml` + role line) becomes, in effect:

> You are the **Research Head** of the **Research Department** (Deepartments,
> DeepSeek Harness). You manage YOUR department: deploy and retire researchers
> with `dept_worker_spawn`/`dept_worker_retire`, execute and list the
> department's versioned jobs with `dept_job_run`/`dept_job_list`. You
> communicate with your department (workers/researchers) and with the heads
> (the Asistente, other department heads). You do NOT coordinate harness
> subagents (builders/reviewers) — that is the Asistente's machinery; your
> deployment unit is the WORKER. Research requests arrive from the Asistente
> (or another department) as messages; you dispatch, collect, verify and report
> results back to the requester.

Concretely: `presets/deepartments-head/agent.cordis.yml` persona + the
`coordinator.role` prompt section (invoke.ts:3024-3034 head branch) + the
own-layer tool block (`if (manager)`) carry the wording; F6 rewrites both.

### 7.3 Literals, never `{{model}}` (fix 3203b69 lesson)

- Persona text uses the **fixed literal**
  `deepseek-v4-flash-vision-exp` (provider `opencode-zen`, reasoning max)
  — the `{{model}}`-style variable is NOT bound at first post-restart assembly
  and broke the persona (3203b69; the current presets already carry the literal:
  presets/deepartments-head/agent.cordis.yml:44, worker :51). F6 keeps that.
- **Base profile**: workers inherit the current base —
  `opencode-zen` / `deepseek-v4-flash-vision-exp` (reasoning max), materialized
  via `WORKER_AGENT_OPTIONS` (invoke.ts:1878). **No Pro
  subagents anywhere in the department** — the worker is flash, same as today's
  transient subagents (cordis.patch.yml:24-28).
- `{{cwd}}` stays (it IS bound — the post-restart fix kept it).

### 7.4 Worker materialization

- Base preset: `deepartments-worker` (WORKER_PRESET_ID, invoke.ts:3075-3076);
  persona = role template text + task text (the job body or the head's task);
  tool allowance = role template's tool list (the `restrict({allow: []})` mask
  at postSetup :3051 becomes role-driven — `allow: <role tools>`); provider/
  model per §7.3.

### 7.5 Owner decisions (2026-08-23) — ephemeral default & organic flow

Two owner decisions SUPERSEDE the earlier "sleep-with-permission" prototype.
They are ADOPTED requirements for the personas and presets (F6), implemented in
`presets/departments/research/*.md`, the head/worker presets and the docs:

- **Workers are EPHEMERAL by default.** A one-off task worker (one research, one
  fact-check, one synthesis) does NOT sleep: it completes the task, reports to
  its head, and the head retires it (`dept_worker_retire`). No sleep protocol,
  no permission to ask — there is nobody to ask (worker → host is PROHIBITED by
  the ACL, §5.6).
- **Only JOB workers sleep between rounds.** A worker deployed from a job
  (`dept_job_run`, carries a `jobId`) iterates across sessions: it persists
  findings with `dept_memo_write`, then requests sleep permission from ITS HEAD
  (never the host/Asistente — worker → host prohibited by the ACL), waits, and
  `dept_sleep`s. It is switched off for good only when the head retires it.
- **Organic flow, not rigid depth/parameters.** The requester expresses an
  ORGANIC need ("be quick", "verify the primary source", "a careful report");
  the head plans and ADAPTS — more/fewer subagents and layers
  (researcher → analyst → reviewer → organizer) per the head's judgment, with
  heuristics as a guide, never a rule. The head still reports to the requester
  with a single consolidated report.

---

## 8. Implementation phases (F1–F6) — parallel builders, no file overlap

| Phase | Scope | Files |
|---|---|---|
| **F1 — core config + catalog** | `org.departments[]` extended (workspacePath/jobDir + schema, org.ts); PostEntry + PostEntryPersisted (`departmentId`, `role` as template id, `jobId`, `managerId`, `retired?`); creator recording at create; retirePost scope restored to "only MY department's workers"; `kind: 'worker'` derivation; backfill policy | `src/org.ts`, `src/invoke.ts` (PostEntry + registry parts), `test/invoke.test.js`, `cordis.patch.yml` (config docs) |
| **F2 — ACL** | `deliverBusRecord` permission check (sender kind + department vs recipient) with per-recipient `'failed': 'acl-*'` reasons; child route untouched | `src/invoke.ts` (deliverBusRecord), `test/invoke.test.js` (discriminating tests: worker→own ok, worker→other dept blocked, worker→host blocked, head→any head ok, head→other-dept worker blocked, host→everyone ok, self held) |
| **F3 — workers** | `dept_worker_spawn` / `dept_worker_retire` (head own-layer, dedup slugs, cwd = department workspace, role template + task persona, title pin, archive-on-retire, retired marker); `dept_who` extension (departmentId/kind/role/jobId/retired) | `src/invoke.ts` (tools + pin), `src/session-rotation.ts` (WorkspaceRegistryLike widening ❓), `test/invoke.test.js` |
| **F4 — jobs** | Job definition reader (frontmatter), `dept_job_run` / `dept_job_list`; first jobs `monitor-dsh-updates`, `weekly-report-organize`; job layout conventions | `src/invoke.ts` (tools + reader), `docs/departments/research/jobs/*.md` (new), `test/invoke.test.js` |
| **F5 — sidebar** | Workspace per department (L1): create entity `create(workspacePath, dept.name)`, department-aware `resolveWorkspaceRootPath`/attach, directory provisioning (mkdir + realpath), migration of `research-head` (archive + reseed, §6.5), stray cleanup (`worker-researcher-alpha` → archive), "Ungrouped" gone | `src/invoke.ts` (resolve/attach/migration), `src/session-rotation.ts` or a small `src/workspace.ts` ❓, `test/` (workspace tests), deploy notes |
| **F6 — roles/presets/docs/skill** | `presets/departments/research/{researcher,reviewer,organizer}.md` role templates; RH persona wording (head preset + role section); README/AGENTS/ROADMAP updates; `.dsh/skills/deepartments-workflow` protocol section (departments + jobs + ACL) | `presets/departments/*`, `src/invoke.ts` (role resolution + installRoleSection wording), `docs/README/AGENTS/ROADMAP`, `.dsh/skills/...` |

**Order & verification (per phase, AGENTS.md tiered):**

1. `pnpm build` (tsc NodeNext, clean).
2. `DSH_HOME=/opt/dsh/.dsh-dev dsh plugin --profile deepartments-dev add
   /home/esuarez/projects/deepartments` (restart after add).
3. `DSH_HOME=/opt/dsh/.dsh-dev dsh --profile deepartments-dev --dump-config` —
   must show the `# == dsh-deepartments` layer with the extended departments.
4. Headless smoke in `deepartments-dev-headless`: boot → `dept_who` shows
   head + workers with kinds/departments → ADDRESSED spawn: the RH's
   `dept_worker_spawn` creates a worker whose session row appears (L1, F5)
   → worker replies only within department (ACL F2) → `dept_job_run` →
   job worker gets the task → `dept_worker_retire` archives the row
   ("Ungrouped" never appears) → retire scope rejects other-department workers.
5. Reviewer after EVERY phase (independent reviewer PASS before commit);
   commits per phase; the marathon keeps a deployment+reseed batch at the end
   (§6.5) with the live re-validation.

**Risks**

1. **cwd immutability** (§6.5): migration requires archive + reseed; a mistake
   leaves two registrations for one postId → the ordering ❓ in §6.5.
2. **Directory provisioning**: the workspace `create` realpath-validates → the
   department dir MUST exist before agent creation (F5 creates it first).
3. **ACL blast radius**: every existing bus test with cross-member sends must be
   re-checked against the new rules (worker→host is now PROHIBITED — old tests
   may encode the old freedom).
4. **`restrict` allow-list semantics** for role tools ❓ (postSetup :3051 today
   hides all globals; the role allowance must be verified against rc.8
   dsh-tools `restrict` behavior).
5. **Deployment**: presets are materialized at boot into the profile
   (`/opt/dsh/.dsh-dev/.agent-presets/*`); F6 changes require sync + restart;
   the live profile GUI (port 3090) must not be broken mid-marathon (dev-only
   profile discipline, AGENTS.md).

---

## 9. Open questions (❓ — resolve with the owner before/at dispatch)

1. **L1 vs L2** for the sidebar folder — recommended: **L1** (plugin-only, real
   workspace per department). L2 (virtual folders) only if the owner prefers
   label-folders that keep all cwds at `/root` and accepts a harness patch.
2. **Path of the department workspace** — proposal (owner):
   `/root/.deepartments/departments/<dept-id>` (outside `sessions/`, inside the
   plugin stateDir). Alternative: `<stateDir>/departments/<dept-id>` (stateDir
   today resolves to `/.deepartments` in production, per head-machinery §1) —
   the exact root must survive the service cwd. ❓ confirm.
3. **Can the Asistente create workers directly too, or ONLY the RH?** —
   recommended (D2): **only the RH**; the host plane keeps NO worker tools
   (`dept_post_create` stays head-only today — structural).
4. **Exact folder name**: "Research Department" (owner proposal) — confirm
   (the workspace title is `department.name`; `cordis.patch.yml:18` already
   declares it).
5. **History on worker retire**: keep old messages in `messages.jsonl`
   (**recommended** — the per-recipient index compacts against durable members;
   retired entries stop being valid recipients but their history stays; a purge
   tool is a later phase) or purge on retire.
6. **Departments defined only in config** (`org.departments[]`) **or also
   hot-created by the Asistente** (future `dept_create` tool)? — this phase:
   **config + register** (the Research Department is in config).
7. ❓ **(proposal, confirm)** Repo layout convention for roles and jobs:
   `presets/departments/<dept>/<role>.md` and `docs/departments/<dept>/jobs/
   <slug>.md` — an experienced alternative (jobs at a top-level
   `departments/` tree instead of `docs/`) is acceptable; pick one convention
   and keep it consistent everywhere (F4/F6).

### Builder-verify points (implementation detail, not owner questions)

- Exact seam to read/render a job definition (repo-root resolution ❓ §5.4).
- `WorkspaceRegistryLike` widening for `create(path, title)` (§6.2).
- `restrict` allow-list mechanics for role tools (rc.8 dsh-tools) (§7.1).
- Backfill policy for legacy posts.json entries without `departmentId` (§4.1);
  whether the messages-store compaction keep-rule treats `retired: true` workers
  as durable members (Q5-recommended: yes).
- Re-seed ordering of the research-head migration (§6.5).
- Whether `dept_post_create`/`retire` reimplement on the new engine or remain
  thin siblings (§5.7).
- The exact head-persona wording source (preset base vs `installRoleSection`)
  so F6 touches ONE canonical place (§7.2).

---

## PATTERNS / INVARIANTS / SURPRISES (for the builders)

- **Invariants kept**: workers are ROOT agents (`worker-<slug>-<uuid>`, no
  subagent/descriptor) — the native child-followup can never reach them; the
  catalog route + bus is their only delivery path; BOOT-QUIET; the manager gate
  (head own-layer only) stays structural (host CANNOT — D2); retire is
  idempotent + dispose deduped (`disposeHeadHandleOnce`); archive is non-fatal
  (host-rotation precedent, session-rotation.ts S2.5); per-recipient failure
  never fails a whole send; fan-out cap 20; persist-before-deliver.
- **Surprises verified by exploration**: (1) the sidebar is fully native — the
  plugin renders nothing, a folder IS a workspace entity, membership is the
  canonical-cwd invariant, and cwd is immutable per session; (2) the harness has
  NO session delete — only rename/fork/archive; the plugin ALREADY owns the
  archive seam (used by host rotation) — retire just never called it; (3)
  `dept_who` hardcodes `kind: 'head'` for every post; (4) the catalog has no
  department dimension at all (workers are not linked to their creating head);
  (5) `dept_post_create` is head-only — the host cannot mint workers today and
  must not (D2); (6) the workspace SERVICE accepts a `create(path, title)` —
  the folder title does not have to be the basename; (7) worker rows are never
  pinned today → raw-id rows.
- **Primary source refs for builders**: explore-deep/2026-08-23-sidebar-catalog-
  departments.md §a-e (workspace/attach mechanics, worker materialization,
  retire cleanup, send scoping), explore-deep/2026-08-22-head-machinery.md §2-5
  (preset materialization, heads, sidebar, cycles), docs/specs/003-agent-
  messaging.md (bus/tools/wakePost/messages-store — the base this phase builds
  on), src/invoke.ts (PostEntry 219-267, manager block 2920-3013, retirePost
  3129-3150, deliverBusRecord 3624-3706, deptWhoTool 3896-3966),
  src/session-rotation.ts 270-291 (archive seam), src/org.ts 23-90 (config).
