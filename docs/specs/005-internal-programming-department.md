---
agent: builder
date: 2026-08-23
task: internal-programming-department-spec
spec_ref: "Owner decisions (2026-08-23), Epic W5: the internal programming of DSH, dsh-deepartments and its plugins moves under a dedicated **Internal Programming Department (IPD)** — the programming counterpart of the Research Department (RD, spec 004). The Asistente becomes an interface/coordinator: it NO LONGER plans internal-programming work (the IPD head does); delegating is ONE `send_message` to `internal-programming-head`. The agenda is COMMON — one shared runtime calendar, all departments see the same agenda, the Asistente sees it all unified. Permission model: the IPD may touch everything (DSH harness, repos, plugins) in the DEV profile; the stable profile `/opt/dsh/.dsh` is a HARD safeguard (explicit owner approval only, escalations via the Asistente); anything outside dsh/repos/plugins (system files, other paths) requires owner approval. Enforced by a new **`dept_exec`** scoped-shell tool with a pre-exec guard (allowed roots + command denylist + `/opt/dsh/.dsh` token + absolute-path scope). Department id `internal-programming` (not `programming`) — chosen so a future \u2018external programming\u2019 department cannot collide. CalendarEntry gains optional `departmentId` attribution; the shared `calendar.json` stays single. Primary sources: explore-deep/2026-08-23-programming-dept-machinery.md (org schema §1, role-template/tool ALLOW-LIST mechanics §0/§7, head-preset regeneration §3), explore-deep/2026-08-23-jobs-agenda-architecture.md (calendar §1, jobs §2, monitors §3, common-agenda refactor §5a), docs/specs/004-research-department.md (spec style), presets/departments/research/*.md + src/invoke.ts + src/org.ts verified in-repo."
outcome: FINAL DRAFT (owner decisions adopted) — DRAFT-ONLY, no commit, no other files touched
files_touched:
  - docs/specs/005-internal-programming-department.md (this draft)
---

# The Internal Programming Department — design spec (Epic W5)

Status: **FINAL DRAFT — all decisions below are owner-approved (2026-08-23) and
are requirements, not proposals. Ready for builder dispatch (phases I1–I6, §8).**
`❓` marks owner-decision points (§9) and builder-verify points (implementation
detail, deferred to the builder). All harness/plugin file:line facts come from the
explore traces listed in `spec_ref`; plugin `src/` line refs were verified against
the working tree at spec time.

---

## 0. Owner decisions adopted (2026-08-23) — requirements, not proposals

| # | Decision | Baked in as |
|---|---|---|
| I1 | **Internal Programming Department (IPD)** — the programming counterpart of the Research Department (RD, spec 004). It owns the *internal programming* of DSH, `dsh-deepartments`, and their plugins. | §1, §3, §7 |
| I2 | **The Asistente becomes an interface/coordinator.** It no longer plans internal-programming work — the **IPD head** does. Delegating internal-programming work is **ONE `send_message` to `internal-programming-head`** (mission + shape); the Asistente never addresses IPD workers (like D2 research); the head's consolidated report is the source of truth. Emergency fallback only if the department is unavailable, annotated as an exception. | §3.5, §5.7, §7.2 |
| I3 | **COMMON agenda.** One shared runtime calendar (`<stateDir>/calendar.json`); all departments see the same agenda; the Asistente sees it all unified. `CalendarEntry` gains optional `departmentId` attribution; `dept_calendar_add` stamps it from the caller's department; `dept_calendar_list` returns the global agenda by default with an optional `departmentId` filter; `agenda/list` + the Agenda UI stay unified (already global). Contract text updated to \u201cshared/global agenda across departments\u201d. | §6 |
| I4 | **Permission model.** The IPD may touch everything (DSH harness, repos, plugins) in the **DEV profile**. The **stable profile `/opt/dsh/.dsh` is a HARD safeguard** — explicit owner approval only, escalations via the Asistente. Anything outside dsh/repos/plugins (system files, other paths) requires owner approval. Enforced at the tool level by `dept_exec` (§5.1). | §5.1, §5.2 |
| I5 | **New tool `dept_exec`** — a scoped shell for the IPD's posts, with a pre-exec guard (allowed roots, command denylist, `/opt/dsh/.dsh` token, absolute-path scope). Only attachable to posts whose role declares it (existing role-tools allow-list machinery — id MUST be exactly `dept_exec`). | §5.1 |
| I6 | **Jobs (first two programmatic posts)** — `weekly-repo-health` (Mon 08:00 GMT) and `version-watch` (daily 06:00 GMT), versioned in `docs/departments/internal-programming/jobs/`. The existing RD job `monitor-dsh-updates` (reporting only) stays untouched; a possible future consolidation is flagged, not performed. | §3.3, §8 |
| I7 | **Naming.** Department id `internal-programming`; name \u201cInternal Programming\u201d; coordinator postId `internal-programming-head`, title \u201cInternal Programming Head\u201d, role \u201cInternal Programming department head\u201d, sessionTitle \u201cInternal Programming Head\u201d; head preset id `deepartments-head-internal-programming`. Chosen explicitly so a future \u201cexternal programming\u201d department cannot collide. | §3.1, §7.4 |
| I8 | **Out of scope (explicit).** No board rooms (0859823 removed them — do NOT resurrect `rooms`/`roomId`/`opencode-go`); no stable-profile changes; no new scheduler engine (reuse `runJobForDepartment`/`spawnWorkerForDepartment`); no RPC/schema for \u201cposts\u201d beyond what exists. | §2 |

---

## 1. Context & Motivation

The Deepartments organization already has a **Research Department** (spec 004,
implemented): a durable department with a head who coordinates and deploys
researchers, and a strict \u201cworker → head → Asistente\u201d reporting chain. There is
**no programming counterpart**. Today all internal programming work of DSH,
`dsh-deepartments`, and its plugins is *planned and dispatched by the Asistente
itself* using transient harness subagents (builders/reviewer/explore), which
subjects the Asistente's own planning loop to the entire build lifecycle and keeps
no durable department around it.

The owner wants (I1–I8) to turn this into a **department** exactly mirroring the
RD, so that:

1. **Planning moves to the IPD head.** The IPD head plans *who* does what *how*
   — the Asistente only issues the high-level mission via `send_message` (I2).
2. **A durable programming workspace + role set** exists (`builder`,
   `reviewer`, `explore-deep`, `organizer`), each with a precise tool
   allow-list — the *only* role with `edit` is `builder` (§7).
3. **A scoped execution path** exists so the IPD can actually *change* the code
   it programs — `dept_exec` — with a real security guard, not an open shell
   (I4, I5).
4. **The agenda is COMMON** across departments (one runtime calendar), so the
   Asistente and every department see the same unified schedule (I3).
5. **Two jolt jobs** are declared and scheduled: a weekly repo-health audit and
   a daily version-watch (I6).

The machinery to build an RD-equivalent department is **already generic** —
verified in `explore-deep/2026-08-23-programming-dept-machinery.md` — so adding a
new department needs **no new lifecycle machinery**: the org schema, per-head
preset generation, role-template allow-list binding, department workspace,
worker-role resolution and the run/job engines are all `config.departments[]`-driven
(machinery §0–§7). The genuinely **new** items are (a) **`dept_exec`** (I5), (b)
the **common-agenda attribution** refactor (I3), and (c) the **two jobs** (I6).

---

## 2. Goals & Non-Goals

### Goals (requirements — do NOT re-litigate)

1. **G1 — The IPD as a durable department.** `org.departments[]` gains an
   `internal-programming` entry: `{id, name, workspacePath, coordinator}` (§3.1).
   It groups 1 head + N workers + N role templates + versioned jobs, and owns
   one sidebar folder (its `workspacePath`).
2. **G2 — Planning owned by the IPD head (I2).** The Asistente does not plan
   internal-programming work; a single `send_message` to
   `internal-programming-head` starts it. The Asistente never addresses IPD
   workers (structure mirrors D2 research).
3. **G3 — Four role templates (I7).** `builder`, `reviewer`, `explore-deep`,
   `organizer` under `presets/departments/internal-programming/`. `builder` is
   the ONLY role with `edit` (and the only one that needs `dept_exec` for full
   code changes); `reviewer`/`explore-deep` get `dept_exec` read-only;
   `organizer` gets neither `edit` nor `dept_exec` (planning/consolidation only).
4. **G4 — `dept_exec` scoped shell (I4, I5).** A real, guarded execution tool
   for the IPD's programming posts, with allowed roots + a command denylist +
   the `/opt/dsh/.dsh` hard safeguard + absolute-path scope.
5. **G5 — COMMON agenda (I3).** `CalendarEntry` gains optional `departmentId`;
   `dept_calendar_add` stamps it; `dept_calendar_list` returns global by default
   with an optional `departmentId` filter; contract text says \u201cshared/global\u201d.
6. **G6 — Two jobs (I6).** `weekly-repo-health` and `version-watch`, both
   cron-scheduled, versioned in the IPD jobDir.
7. **G7 — Roles/presets/profile discipline.** Personas + head preset materialize;
   workspace autogenerates; role updates applied in the skill + host preset.

### Non-Goals (explicitly out of scope for this spec, I8)

- **No board rooms.** `0859823` removed the board schema (`rooms`/`roomId`,
  `opencode-go`, `deepseek-v4-flash`); do NOT resurrect any of it. The IPD is
  declared in the *current* org schema (§3.1) — a copy of the `research` block,
  not a re-add of the deleted lines (machinery §2, `:102`).
- **No stable-profile changes.** `/opt/dsh/.dsh` is a hard safeguard (I4); the
  IPD operates in the DEV profile (`deepartments-dev`, DSH_HOME
  `/opt/dsh/.dsh-dev`). Nothing in this spec touches stable.
- **No new scheduler engine.** Reuse `runJobForDepartment` /
  `spawnWorkerForDepartment` (the shared engine used by the manual `dept_job_run`
  AND the 30s scheduler daemon — agenda §2.2). No tool-vs-daemon drift.
- **No new RPC/schema for \u201cposts\u201d** beyond what exists (PostEntry/posts.json,
  dept_who, the messaging ACL). The IPD workers are ordinary `provider:
  'worker'` root agents.
- **No empty-shell or unfiltered shell.** `dept_exec` is *not* a passthrough to a
  full system shell; it is guarded (§5.1) and is only attached to IPD roles.
- **No change to the RD job `monitor-dsh-updates`** — it stays reporting-only; a
  future consolidation into `version-watch` is flagged as an open item (§9), not
  performed here.

---

## 3. Conceptual model

```
Internal Programming Department (org.departments[], id: internal-programming)
 ├── Role   (presets/departments/internal-programming/<role>.md — persona + toolset template)
 ├── Job    (docs/departments/internal-programming/jobs/<slug>.md — versioned task definition)
 ├── Head   (coordinator — permanent root agent, today's ensureHead machinery, unchanged)
 └── Worker (root agent worker-<slug>-<uuid>: role template + task; ephemeral or job-backed)
```

### 3.1 Department

```jsonc
// config.org.departments[] — new entry (copied from the `research` block, machinery §7 :186)
{
  "id": "internal-programming",            // I7 — NOT "programming" (avoids a future "external programming" collision)
  "name": "Internal Programming",          // sidebar folder label (I7)
  "workspacePath": "/root/.deepartments/departments/internal-programming",
  "jobDir": "docs/departments/internal-programming/jobs",   // default from jobDirFor (org.ts:56)
  "coordinator": {
    "postId": "internal-programming-head",
    "title": "Internal Programming Head",
    "role": "Internal Programming department head",
    "sessionTitle": "Internal Programming Head",
    "provider": "opencode-zen",
    "agentOptions": { "provider": "opencode-zen", "model": "deepseek-v4-flash", "reasoningEffort": "max" }
  }
}
```

- The **head preset** derives automatically: `headPresetIdFor('internal-programming')`
  → `deepartments-head-internal-programming` (head-presets.ts:31-33); the
  **head persona + composition** are built from the base
  `presets/deepartments-head/agent.cordis.yml` + the role line
  (buildHeadPresetComposition, head-presets.ts:71-77).
- The department is **config-only and hot in boot** —
  `ensureAllHeads` (invoke.ts:6017-6049) iterates `org.departments[]`, so the new
  entry just flows through: the head preset is regenerated fresh on every boot
  (machinery §3 `:119-121` — NOT durable; edit the base/coordinator config, never
  the runtime copy).

### 3.2 Role

A role is a **person template referenced by name**, the same shape as the RD's
roles (§3.2 of spec 004). File at `presets/departments/internal-programming/<role>.md`,
frontmatter `{id, title, tools}` + body = persona. The `tools` **allow-list IS
the effective `restrict` mask** for the role (binding implemented in F3/spec 004
§7.1 — `readRoleTemplate`/`parseRoleTemplateFrontmatter`, invoke.ts:4365/4326;
applied via `agentCtx.tools.restrict({allow})`, invoke.ts:5476-5482).

**Crucial dept difference:** the RD role toolset grants file *read/write* and no
shell. The IPD's `builder` role additionally grants **`edit`** and **`dept_exec`**
(the scoped shell); `reviewer`/`explore-deep` grant `dept_exec` read-only; and
`builder` is the ONLY role with `edit`. The tool allow-lists are enumerated in
§7.1. Any IPD role that needs git/build/install/worktree access does so **through
`dept_exec`** — there is no generic `bash` tool in the department tool vocabulary
(machinery §7 note `:190`); `dept_exec` is that new capability and is the reason
the permission model in §5.1 exists.

### 3.3 Job

Identical mechanism to the RD (§3.3 spec 004). File at
`docs/departments/internal-programming/jobs/<slug>.md`, frontmatter
`{id, title, role, description, owner, schedule?, outbox?}` + body = task. A
5-field cron `schedule` auto-fires via the 30s scheduler; a non-cron (human)
schedule never auto-fires (agenda §1.6).

| Job | schedule | role | purpose |
|---|---|---|---|
| `weekly-repo-health` | `0 8 * * 1` (Mon 08:00 GMT) | `builder` | Audit READMEs of the local project repos; fix directly (`edit`) and report changes + recommendations to the head; commits are the Asistente's job — the worker only edits files and reports (§8). |
| `version-watch` | `0 6 * * *` (daily 06:00 GMT) | `builder` | Compare published vs installed versions for `@deepseek-ai/dsh` + the ecosystem plugins; evaluate security/breaking/viability; if viable AND a plugin, build + install into the **deepartments-dev** profile (never stable); if core DSH, propose exact upgrade steps (do NOT auto-upgrade the harness — the Asistente owns deployments); then notify the Asistente via the head so it can `smart_restart` (canary) to load the new plugin. |

### 3.4 Worker

Identical to the RD (§3.4 spec 004): a **DISCONNECTED root agent**
(`worker-<slug>-<uuid>`, `provider:'worker'`, own sidebar session in the IPD
folder), never a harness subagent.

**Vocabulary note (F3/M2):** the host's (and heads') transient subagent surface
is the single read-only NON-CODE **`secretary`** (M2, owner decision 2026-08-28:
plugin `dsh-deepartments/subagent`, toolName `secretary` — deployed from the
host's delegation row and from each head's preset `tool-secretary` row); the
pre-M2 transient names builder/reviewer/scribe/researcher are R6-DEPRECATED and
UNIFIED into `secretary` by `normalizeRole`, and `explore` stays retired (F2/F3).
Those names are a DIFFERENT class from the IPD workers with the same names
(`builder`/`reviewer`/`explore-deep`/`organizer` — ROOT agents via
`dept_worker_spawn`). The Asistente never dispatches a transient subagent for
IPD-owned work (AGENTS.md rule 10); shared names are vocabulary, not identity.
Deep code analysis belongs to the IPD's `explore-deep` worker.

Lifecycle: spawn (role persona + task) → work
the task → write the report & reply to the head (`dept_memo_write` only if durable
notes are wanted) → head retires (`dept_worker_retire`). EPHEMERAL PER ROUND — a
worker does NOT sleep and does NOT request permission from ITS head (never the
host); a job worker is retried fresh each round. **Boot-quiet** (never acts
unaddressed). The IPD `builder` worker is typically **ephemeral** for a one-off
task and **job-backed** for the scheduled jobs — both are EPHEMERAL PER ROUND
(§7.5 pattern of spec 004).

### 3.5 Who coordinates what (I2)

- **The IPD Head coordinates the Internal Programming Department**: plans the
  work (splitting missions into tasks/roles), deploys/retires workers, runs jobs,
  reads results, and is the ONLY one who communicates results to the Asistente or
  another department. **It plans the internal-programming work** — this is the
  core I2 deltas vs the RD: the RD's head does *not* plan what the Asistente
  plans (the Asistente delegated research as a message); the **IPD head DOES plan**
  the internal-programming work that the *today-Asistente* used to plan.
- **The Asistente no longer plans or dispatches internal programming work.** Its
  only path is **one `send_message` to `internal-programming-head`** carrying the
  mission + its shape. The Asistente never addresses IPD workers directly
  (structural, like D2 research).

The Asistente's persona is UNIVOCAL (F4): internal programming = IPD, ONE
`send_message` to `internal-programming-head`; its transient subagents are the
NON-CODE/emergency path only ("You are the Asistente — the host main agent…",
cordis.patch.yml system-prompt row).
- **The IPD head's consolidated report is the source of truth** for what was
  done. **Emergency fallback:** only if the IPD is unavailable — DEFINED as
  exactly ONE `send_message` to `internal-programming-head` that fails or goes
  unanswered — and only AFTER the Asistente escalates to the owner via
  `ask_user_question` (fallback needs owner approval), may it dispatch a
  transient builder directly (NON-CODE only; never explore/analysis). Must be
  annotated as an *exception* in the report/ROADMAP.

---

## 4. Data & catalog

The IPD reuses the **existing** worker catalog machinery — no new PostEntry shape
is required beyond what the RD already adds (`provider:'worker'`, `departmentId`,
`managerId`, `jobId?`, `kind:'worker'`, `retired?`, spec 004 §4.1). The IPD adds:

- **`org.execRoots`** (new optional config, §5.1) — an allow-list of root
  directories under which `dept_exec` commands may run. Defaults (when absent):
  `/home/esuarez/projects`, `/usr/lib/node_modules/@deepseek-ai/dsh`,
  `/opt/dsh/.dsh-dev` (the DEV deployment home), the plugin repo root, the
  department workspace, and the runtime stateDir. The stable home `/opt/dsh/.dsh`
  is deliberately NOT a default root (the cwd-in-root check + the protected
  token deny it).
- **`CalendarEntry.departmentId?`** (optional attribution, §6) — no new file;
  the single `<stateDir>/calendar.json` stays one shared store.

**Catalog/cwd facts (verified):** head + workers are created with
`meta.cwd = resolveDepartmentWorkspaceCwd(dept)` (invoke.ts:5758-5762 →
`ensureDepartmentWorkspace`, mkdir + idempotent registry.create,
invoke.ts:5696-5746) when `workspacePath` is set, so they land in the IPD folder
(\u201cInternal Programming\u201d) in the sidebar and produce reports under
`.../internal-programming/reports/`. `role` is a role-template name resolved via
`readRoleTemplate`; the persona body + `{{workspacePath}}`/`{{reportDir}}`/`{{deptName}}`/
`{{headPostId}}` templating (invoke.ts:5264-5291) wires job instructions to the
workspace.

---

## 5. Tools

### 5.1 `dept_exec` — the scoped shell (I4, I5) — NEW

This is the one genuinely new tool in W5. It gives the IPD's programming posts a
real way to run commands (build, install, git, test) **without** handing over an
open system shell.

```
dept_exec({ command: string, cwd?: string })
  → { command, exitCode, stdout?, stderr?, guard?: 'denied'|'out-of-scope' }
```

| Aspect | Value |
|---|---|
| **id** | `dept_exec` (MUST be exactly this — the role-tools allow-list names it verbatim) |
| **params** | `command` (required, string); `cwd` (optional, default = the calling worker's workspace cwd) |
| **exec** | `bash -lc <command>` via `child_process`; **timeout 120s**; **maxBuffer 8MB** |
| **registration** | Only attached to posts whose role allows it, via the existing role-tools allow-list machinery (spec 004 §7.1: `tools` frontmatter = the restrict mask). `subagent`/`subagent_fork`/`workflow`/`ralph`/`run_code` stay hard-denied (`DENIED_POST_TOOLS`, invoke.ts:5385). |

**Pre-exec guard** (all of the following, checked BEFORE any command runs):

1. **(a) cwd scope** — `cwd` must resolve (realpath) under an allowed root
   (`org.execRoots`, see defaults). NOT under a root → `OUT_OF_SCOPE`.
2. **(b) command denylist** (case-insensitive substring/word match): `systemctl`,
   `reboot`, `shutdown`, `poweroff`, `halt`, `init 0`, `sudo`, `su -`, `mkfs`,
   `fdisk`, `parted`, `dd if=`, `rm -rf /`, `nsenter`, `:(){`. Any hit → `DENIED`.
3. **(c) stable-profile token** — any `/opt/dsh/.dsh` token in the command or the
   resolved cwd →
   `DENIED` with reason: **\u201cstable profile protected — requires explicit owner
   approval via the Asistente\u201d**. (The IPD operates in DEV; stable is a hard
   safeguard, I4.) The token is **boundary-aware**: a bare `/opt/dsh/.dsh-dev`
   also contains the literal `/opt/dsh/.dsh`, so the guard matches the literal
   **only as a whole path component** — preceded by a start/in-shell word
   boundary and NOT followed by a word/path-continuation char (so
   `/opt/dsh/.dsh-dev` and everything under it is NOT denied; the DEV home is a
   normal allowed root). Implemented by a single pure helper (`isStablePath`)
   applied to BOTH the command and the resolved cwd.
4. **(d) absolute-path scope** — any absolute path token in the command must be
   under an allowed root; otherwise `OUT_OF_SCOPE` with reason **\u201crequires owner
   approval\u201d**.

   **Token normalization:** before the containment check each `/`-leading
   absolute path token is canonicalized to `path.posix.normalize(token)` and,
   when the path exists, to its `realpathSync` target — so a `..`-escape or
   symlink cannot smuggle an out-of-root or stable path past a lexical check
   (both the stable-profile check and the allowed-root containment run on the
   canonical target). A token carrying a shell metachar/variable/glob (`$`, `*`,
   `?`, `[`, `{`, `~`, backtick, quotes) cannot be resolved safely and stays
   heuristic (lexical-only). The fd-redirect `>`/`<` digit-guard is removed: every
   `>`/`<`-adjacent absolute path token is checked, EXCEPT an explicit whitelist
   of device sinks — `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/zero`,
   `/dev/tty` — which are always allowed (not paths under scope control).

**Allowed roots** (defaults, overridable via the new optional config
`org.execRoots`): `/home/esuarez/projects`,
`/usr/lib/node_modules/@deepseek-ai/dsh`, `/opt/dsh/.dsh-dev` (the DEV
deployment home), the plugin repo root (`/home/esuarez/projects/deepartments`),
the department workspace (`/root/.deepartments/departments/internal-programming`),
and the runtime stateDir (`$DSH_HOME`/`.deepartments`). The stable home
`/opt/dsh/.dsh` is deliberately NOT an allowed root (the cwd-in-root check + the
protected token both deny it).

**Why this shape (design intent):** the IPD must be able to *build* the plugin,
*install* it into the dev profile and *run* the test suite — but it must never
be able to destabilize the host, escalate privileges, or touch the stable
deployment. The guard enforces that mechanically rather than by persona
discipline (machinery §7 `:190` flagged the absence of any shell tool for a
git-capable dept role; `dept_exec` closes that gap **scoped**, not open).

### 5.2 Permission model summary (I4)

| Target | IPD access | Guard |
|---|---|---|
| DSH harness (`/usr/lib/node_modules/@deepseek-ai/dsh`) | **Yes** (DEV context) | allowed root |
| Project repos (`/home/esuarez/projects`) | **Yes** | allowed root |
| Plugins (`dsh-deepartments`, ecosystem plugins in the repo) | **Yes** | allowed root |
| Department workspace | **Yes** | allowed root |
| Runtime stateDir (`.deepartments`) | **Yes** | allowed root |
| **Stable profile `/opt/dsh/.dsh`** | **NO** — explicit owner approval only, escalations via the Asistente | `(c)` hard deny |
| System files / other paths | **NO** — owner approval required | `(d)` out-of-scope |

### 5.3 Existing tools reused (no change)

The IPD head uses the same head-layer tools as the RD head: `dept_worker_spawn`,
`dept_worker_retire`, `dept_job_run`, `dept_job_list`, `dept_who`,
`dept_memo_write` — all resolve the department from the calling head, so a
`internal-programming-head` config immediately gets the lifecycle tools for its
own department (agenda §5c: invoke.ts:5007, 5086, 5133). (LOTE A, 2026-08-27:
heads no longer carry `dept_sleep` in their own layer — only the host sleeps.)
The messaging ACL
(`aclDenyGround`, invoke.ts:4678-4723) is generic — a new `internal-programming`
department is automatically scoped: workers message only within the dept (incl.
the IPD head), never the Asistente directly; the IPD head is addressed by the
host and peers.

### 5.4 Post-create/retire compatibility

`dept_post_create`/`dept_post_retire` (the raw head-layer machinery) keep working
and are reimplemented on the same engine as `dept_worker_spawn`/`dept_worker_retire`
(per spec 004 §5.7 — same engine, both stay consistent). No change in W5.

---

## 6. COMMON agenda (I3)

### 6.1 Current state (verified, agenda §1)

- The runtime agenda is **one file**: `<stateDir>/calendar.json`. `CalendarEntry`
  = `{id, label, at, jobId?, createdBy?, createdAt?, fired?}` — **no
  `departmentId`** (invoke.ts:1083-1091).
- `dept_calendar_add` (invoke.ts:4499-4555) registers on **every post's
  own-layer**; `jobId` is validated against the caller's OWN department jobDir;
  `createdBy = caller.postId`. `dept_calendar_list` (invoke.ts:4557-4602) reads
  the whole store and filters ONLY by the `from`/`to` window — **no department
  filter**, returns every department's entries. `dept_calendar_remove`
  (invoke.ts:4604-4648) ACL = entry creator OR head of the entry's department.
- The GUI `agenda/list` (invoke.ts:2016-2045) already returns **all departments'
  jobs** + the single shared calendar — **already unified**. The Agenda UI has no
  department filter either.
- **Contract mismatch to fix:** the tool **descriptions** say \u201cYOUR
  department's runtime agenda\u201d while the store + GUI are global. This is the
  gap the owner's COMMON-agenda decision targets.

### 6.2 Change (minimal — attribution + contract clarity)

1. **`CalendarEntry.departmentId?`** (optional, invoke.ts:1083-1091) set at add
   time from `departmentForEntry(createdBy)` so each entry is attributable. Keep
   the **single** shared `calendar.json` — do NOT split per-dept (splitting kills
   the \u201ccommon\u201d requirement).
2. **`dept_calendar_add`** stamps `departmentId` from the caller's department
   (invoke.ts:4499-4555).
3. **`dept_calendar_list`** returns the **global agenda by default** (no arg), with
   an optional `departmentId` filter; surfaces `departmentId` in the output
   schema (invoke.ts:4557-4600).
4. **Contract text** updated to \u201cshared/global agenda across departments\u201d in
   the tool descriptions (invoke.ts:4501, 4559), while the **jobId add
   validation** (caller's dept) and the **remove ACL** (creator/head-of-owner-dept)
   correctly stay owner-scoped.
5. `agenda/list` + the Agenda UI stay unchanged (already global/unified — this is
   the \u201cAsistente sees it all unified\u201d part that already works).

---

## 7. Personas & presets

### 7.1 Role templates of the Internal Programming Department

The role `tools` binding is **implemented** (spec 004 §7.1) — the `tools`
frontmatter list IS the effective `restrict` allow-list. Worker cwd = the IPD
workspace, so deliverable paths are relative to that workspace (`reports/...`).

| Role | Persona (template intent) | Tools (allow-list → restrict mask) | Notes |
|---|---|---|---|
| `builder` | Internal programming executor: edits code in the repos/plugin, builds + tests, fixes READMEs, runs scoped `dept_exec` commands; reports to the IPD head | read, write, **edit**, glob, grep, web_search, web_fetch, send_message, agent_messages, dept_who, dept_memo_write, **dept_exec** | **ONLY role with `edit`** and the ONLY role that legitimately needs `dept_exec` for full code changes. Never commits (the Asistente commits); reports. |
| `reviewer` | Independent review: reads changed files, runs verification commands via `dept_exec` (read-only usage), issues PASS/FAIL; **never writes code** | read, write, glob, grep, web_search, web_fetch, send_message, agent_messages, dept_who, dept_memo_write, **dept_exec** | **minus `edit`** (no code writes); `dept_exec` used read-only (verification commands only — build/test/lint/`git log`/`git diff`, never a mutating command). Its deliverable is its review report. |
| `explore-deep` | Deep read-only code analysis: traces machinery, git/log/diff analysis, writes a report for the head | read, write, glob, grep, web_search, web_fetch, send_message, agent_messages, dept_who, dept_memo_write, **dept_exec** | **minus `edit`**; `dept_exec` read-only (git/log/diff, never a mutating command). Never writes code. |
| `organizer` | Planning/consolidation: indexes/normalizes the dept's report archive, consolidates findings for the head | read, write, glob, grep, send_message, agent_messages, dept_who, dept_memo_write | **no `edit`, NO `dept_exec`** — purely planning/consolidation via messaging + reads (it must never mutate code or run a command). |

- All four: **BOOT-QUIET** (never act unaddressed); message only inside the IPD
  (ACL); memory via `dept_memo_write`; **ephemeral by default**, and JOB workers
  are EPHEMERAL PER ROUND too — they work the round, report, reply to **their**
  IPD head, and are retired; they never sleep and never ask the host. §7.5
  spec-004 pattern carries.
- Role templates live at `presets/departments/internal-programming/<role>.md`;
  the static department design is
  `presets/departments/internal-programming/{ARCHITECTURE.md,README.md}`.

### 7.2 IPD Head persona (I2, updated workflow)

The `deepartments-head-internal-programming` persona becomes, in effect:

> You are the **Internal Programming Head** of the **Internal Programming
> Department** (Deepartments, DeepSeek Harness). You OWN the internal programming
> of DSH, `dsh-deepartments`, and their plugins, and you **PLAN** it: you split the
> Asistente's high-level mission into concrete tasks, select the roles
> (`builder`/`reviewer`/`explore-deep`/`organizer`) and deploy/retire workers with
> `dept_worker_spawn`/`dept_worker_retire`, execute and list the department's
> versioned jobs with `dept_job_run`/`dept_job_list`. You communicate with your
> department and with the heads (the Asistente, other department heads). You do
> NOT coordinate harness subagents (builders/reviewer) — that is the Asistente's
> machinery; your deployment unit is the WORKER. The Asistente's mission arrives as
> a message; you plan, dispatch, collect, verify and report results back in a
> single consolidated report. **Permission boundary:** you operate in the DEV
> profile; the stable profile `/opt/dsh/.dsh` is a hard safeguard — any need to
> touch it escalates to the Asistente for explicit owner approval.

### 7.3 Literals, never `{{model}}` (lesson 3203b69)

Same discipline as spec 004 §7.3: persona text uses the **fixed literal**
`deepseek-v4-flash` (provider `opencode-zen`, reasoning max); base
profile `opencode-zen`/`deepseek-v4-flash`; **no Pro subagents** in the
department.

### 7.4 Head preset id (I7)

`headPresetIdFor('internal-programming')` → `deepartments-head-internal-programming`
(derived automatically, head-presets.ts:31-33). Materialized fresh at boot into
`$DSH_HOME/.agent-presets/deepartments-head-internal-programming/` — generated, not
durable (machinery §3 `:119-121`); the source is the base
`presets/deepartments-head/agent.cordis.yml` + the coordinator config.

### 7.5 Persona `tools` vocabulary note

There is **no generic `bash` tool** in the current head/worker tool vocabulary
(machinery §7 `:190`). The IPD's ability to run commands comes **only** through
`dept_exec` (§5.1), and the `git`/build/test/install capability is the express
reason it exists. The denylist + stable-token + absolute-path guards (§5.1) are
what let `builder` run `pnpm build`/`git log`/`dsh plugin add` without opening a
free shell.

### 7.6 Cross-department requests

The Internal Programming Department may request Research Department services
through its head. When a programming mission needs information, advice,
strategies or community opinions (e.g. the `version-watch` security/community
assessment of a new release, library-choice evidence, practice research), the
**Internal Programming Head** sends a single RESEARCH REQUEST to `research-head`
(in the RD's request format) and folds the RD's consolidated answer into its own
mission report. Workers never contact the other department directly — everything
crosses departments through the IPD head (D2). See the skill section
"Cross-department synergies (heads talk to heads)".

**Head↔head as operational habit (m-422, M3 SYNERGY-DOCS 2026-08-27).** The
IPD→RD RESEARCH REQUEST is **research-on-demand in missions — THE NORM**: a
programming mission that needs information/advice/community opinions ALWAYS
routes ONE RESEARCH REQUEST via the IPD head into its mission report, never as an
afterthought. Rule: **results, not exchanges, toward the Asistente** — the
Asistente receives the consolidated mission report, never the raw head↔head
exchanges. The total pending-work register lives in `docs/WORK-REGISTER.md`
(maintained by the IPD + the Asistente).

---

## 8. Implementation phases (I1–I6) — parallel builders, no file overlap

| Phase | Scope | Files |
|---|---|---|
| **I1 — `dept_exec` (scoped shell)** | The new tool: `bash -lc` via child_process (timeout 120s, maxBuffer 8MB); pre-exec guard (a) cwd scope, (b) command denylist, (c) `/opt/dsh/.dsh` token, (d) absolute-path scope; `org.execRoots` config + schema; attach only to roles that declare `dept_exec` | `src/invoke.ts` (tool + guard), `src/org.ts` (`execRoots`), `test/` (guard tests: deny stable, deny system, allow repo/workspace) |
| **I2 — common agenda** | `CalendarEntry.departmentId?`; `dept_calendar_add` stamps; `dept_calendar_list` optional `departmentId` filter + global default; contract text \u201cshared/global agenda across departments\u201d | `src/invoke.ts` (calendar tools), `test/invoke.test.js` |
| **I3 — dept config + catalog** | `org.departments[]` gains the `internal-programming` entry (id/name/workspacePath/coordinator); PostEntry already carries `departmentId`/`kind`; no new lifecycle machinery | `cordis.patch.yml`, `test/` (config-shape, fixture alignment) |
| **I4 — roles + head/workspace** | `presets/departments/internal-programming/{builder,reviewer,explore-deep,organizer}.md` (+`ARCHITECTURE.md`,`README.md`); IPD head persona wording; workspace autogeneration (already generic) | `presets/departments/internal-programming/*`, `src/invoke.ts` (role resolution — already generic), workspace dir |
| **I5 — jobs** | `weekly-repo-health` (cron `0 8 * * 1`) + `version-watch` (cron `0 6 * * *`) in the IPD jobDir; reuse `runJobForDepartment` (manual + scheduler), NO new engine | `docs/departments/internal-programming/jobs/*.md` |
| **I6 — skill + host preset + docs** | Asistente workflow update: internal-programming work is delegated via ONE `send_message` to `internal-programming-head`; the Asistente no longer plans/dispatches internal-programming work; the head's consolidated report is the source of truth | `.dsh/skills/deepartments-workflow`, the Asistente (host) preset at `/opt/dsh/.dsh-dev/.agent-presets/deepartments/*` (dev profile — NOT stable, NOT in repo), `docs/README/AGENTS/ROADMAP` |

**Order & verification (per phase, AGENTS.md tiered):**

1. `pnpm build` (tsc NodeNext, clean).
2. `DSH_HOME=/opt/dsh/.dsh-dev dsh plugin --profile deepartments-dev add
   /home/esuarez/projects/deepartments` (restart after add).
3. `DSH_HOME=/opt/dsh/.dsh-dev dsh --profile deepartments-dev --dump-config` —
   must show the `# == dsh-deepartments` layer with the new department present.
4. Headless smoke in `deepartments-dev-headless`: boot → `dept_who` shows the IPD
   head + workers with kinds/departments → `dept_exec` scoped (denies
   stable/system, allows repo/workspace) → calendar entries carry `departmentId`
   → both jobs exist and run (manual `dept_job_run` or a real run) → a real task
   E2E through `internal-programming-head`.
5. Reviewer after EVERY phase (independent reviewer PASS before commit); commits
   per phase.

**Risks**

1. **`dept_exec` guard correctness** (§5.1): the `/opt/dsh/.dsh-dev`-vs-`/opt/dsh/.dsh`
   boundary (`(c)`) and the absolute-path tokenization (`(d)`) are the highest-risk
   pieces — a too-loose guard leaks stable/system; a too-tight guard breaks legit
   builds. Discriminating tests are mandatory.
2. **`restrict` allow-list semantics** for `dept_exec` in the role tools (spec 004
   §8 risk 4 / invoke.ts:5476-5482) — verify `dept_exec` survives the mask when a
   role declares it, and is absent when it doesn't.
3. **ACL blast radius** — no per-dept ACL change needed (generic), but any new
   bus test must confirm the IPD is indistinguishable-in-kind from the RD.
4. **Persona/tool drift** — `builder` is the only role with `edit`; a reviewer or
   explore-deep accidentally gaining `edit`/mutating `dept_exec` defeats the
   guard's read-only intent. Verify the allow-lists are exact (§7.1).
5. **Deployment discipline** — presets materialize at boot into the DEV profile
   (`/opt/dsh/.dsh-dev/.agent-presets/*`); the Asistente host preset is durable in
   that profile (machinery §3 `:119`), so the I6 workflow change needs a sync +
   restart; stable `/opt/dsh/.dsh` must be untouched (I4).

---

## 9. Open questions (❓ — resolve with the owner before/at dispatch)

1. **`org.execRoots` location + defaults (❓)** — confirm the default root set
   (`/home/esuarez/projects`, `/usr/lib/node_modules/@deepseek-ai/dsh`, plugin repo
   root, department workspace, runtime stateDir) and whether `execRoots` should be
   per-department or a single global config. Recommended: single optional
   `org.execRoots` array, absent = the defaults above.
2. **`/opt/dsh/.dsh` tokenization (❓ — RESOLVED)** — the `(c)` guard denies the
   stable home exactly while NOT blocking `-dev`, via the boundary-aware pure
   helper `isStablePath` (whole-path-component match: a start/in-shell word
   boundary before the literal, no word/path-continuation char after it —
   `/opt/dsh/.dsh-dev` and everything under it is allowed as a normal DEV root,
   per §5.1 (c)).
3. **IPD head planning depth (I2)** — the RD head does NOT plan (the Asistente
   sends a message); the IPD head DOES plan. Confirm the split is \u201cthe Asistente
   sends a mission + shape; the IPD head plans the tasks/roles/order.\u201d
4. **Naming confirmation** — `internal-programming` (department id), \u201cInternal
   Programming\u201d (name), `internal-programming-head` (coordinator postId),
   \u201cInternal Programming Head\u201d (title + sessionTitle) — confirm per I7
   (deliberately NOT `programming`, so \u201cexternal programming\u201d can be added
   later without collision).
5. **`version-watch` install boundary** — confirm \u201cif viable AND a plugin → build +
   install into **deepartments-dev** only; if core DSH → propose upgrade steps (do
   NOT auto-upgrade the harness; the Asistente owns deployments)\u201d and that the
   final `smart_restart` (canary) is the Asistente's action after the head notifies it.
6. **Organization** — the historical/board-era fixtures use `programming` /
   `programming-head` (e.g. test/agents-status.test.js:34-58,
   test/messages-store.test.js, test/invoke.test.js TEST_ORG). Confirm the fixture
   alignment to `internal-programming` (recommended: align, so reality matches),
   or leave them as legacy since they inject their own config and don't read the
   live file (machinery §6 `:175`).
7. **`monitor-dsh-updates` consolidation** — flagged open item (I6); do NOT merge
   it into `version-watch` now. Confirm the eventual-consolidation intent only.

### Builder-verify points (implementation detail, not owner questions)

- `bash -lc` invocation + timeout/maxBuffer semantics; how to capture stdout/stderr
  and the exit code into the tool result (child_process `exec` vs `spawn`).
- The role-tools allow-list insertion for `dept_exec` (must use the exact id;
  confirm it is exempt from the restrict mask like the own-layer tools, or that
  declaring it in the allow-list permits it).
- The exact `/opt/dsh/.dsh` tokenization boundary (§5.1 (c)).
- Whether `org.execRoots` conflicts with the existing org schema (zod) — add it
  to `src/org.ts` Config + schema.
- Reuse of `runJobForDepartment`/`spawnWorkerForDepartment` for the two jobs (no
  new scheduler engine); cron auto-fire vs manual `dept_job_run` (agenda §2.2).
- The IPD workspace autogeneration + the IPD head migration (archives + reseed if
  a stale `deepartments-head-programming`/`deepartments-head-internal-programming`
  runtime preset dir exists — machinery §4 says clean the orphan, let boot
  regenerate; re-add in the current schema, NOT `rooms`/`roomId`/`opencode-go`).

---

## PATTERNS / INVARIANTS / SURPRISES (for the builders)

- **Invariants kept**: workers are ROOT agents (`worker-<slug>-<uuid>`, no
  subagent/descriptor); the catalog route + bus is their only delivery path;
  BOOT-QUIET; the manager gate (head own-layer only) stays structural (the host
  CANNOT mint IPD workers — I2); retire is idempotent + dispose deduped; archive
  is non-fatal; per-recipient failure never fails a whole send; the messaging ACL
  is generic and a new department is automatically scoped (machinery §6).
- **Surprises verified by exploration**: (1) `dept_exec` is the only genuinely NEW
  tool in W5 — the lifecycle, catalog, job-run and spawn engines are all
  `config.departments[]`-driven and need no new machinery (machinery §7); (2)
  the agenda is ALREADY global at the store + GUI level — the fix is attribution +
  contract wording, not a schema split (agenda §1); (3) the stale
  `deepartments-head-programming` runtime preset dir is a boot artifact of the
  OLD board era (contains `{{model}}`, board tools, wrong dept name, no fs tools)
  — clean it and let boot regenerate under the new id, never reuse it (machinery
  §4); (4) there is NO `bash` tool in the department vocabulary today — `dept_exec`
  is the scoped capability that closes the git/build gap (machinery §7 `:190`); (5)
  the 0859823 reversal is a REFERENCE, not a drop-in — the current schema has no
  `rooms`/`roomId` and uses `opencode-zen`/`deepseek-v4-flash`, so the
  IPD is a copy of the current `research` config block, never a re-add of the
  deleted board lines (machinery §2 `:102`).
- **Primary source refs for builders**: explore-deep/2026-08-23-programming-dept-
  machinery.md §1 (org schema + live RD config), §3 (head preset regeneration), §6
  (tests), §7 (reuse/create/cleanup + the reversal caveat); explore-deep/2026-08-23-
  jobs-agenda-architecture.md §1 (calendar/scheduler), §2 (jobs/run engine), §5a
  (common-agenda refactor), §6 (patterns to watch); docs/specs/004-research-
  department.md (department/role/job/worker machinery + ACL + personas); 
  src/invoke.ts (calendar tools 4499-4648, job engine 4140-4240, worker spawn
  4253-4316, ACL 4678-4723, role→tools 5360-5491, workspace 5663-5761,
  agenda/list 2016-2045); src/org.ts (DepartmentConfig/CoordinatorConfig 24-58).
