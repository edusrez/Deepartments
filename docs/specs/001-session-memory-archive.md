# Session Memory Archive — spec

Feature: **SESSION MEMORY ARCHIVE** — a persistent, searchable store of the full journal
history and a per-session complete session log for every sleeping actor, captured
automatically at each checkpoint, while the injected wake pack stays **lean** (only the
last single journal entry injected, unchanged).

Status: **B: APPROVED for implementation (owner sign-off 2026-08-20).** This is the definitive
spec; builders implement to it, reviewers gate against it. All `file:line` anchors were verified
against the current `src/invoke.ts` (3769 lines), `src/org.ts`, `src/index.ts` and
`test/invoke.test.js` in this session and are current as of 2026-08-20.

Authoritative sources (both read and incorporated):
- `.dsh/reports/explore-deep/2026-08-20-journal-archive-hooks.md` (choke-point map)
- `.dsh/reports/explore-deep/2026-08-20-session-log-capture-feasibility.md` (one-cycle capture)

---

## Goal & non-goals

**Goals**
1. **Lean wake pack untouched.** Sleeping and waking keeps injecting ONLY the last single
   journal entry (`journals/<memberId>.md`) exactly as today. The accepted mechanism
   (already true in code): the pack reads ONLY the single checkpoint via
   `readWakeJournalKpi` (src/invoke.ts:1906-1923) and the `agent/pre-step` injector
   (1990-2013) passes only `journalPathFor(hostId)` (2007); pack §2 injects only the path,
   not the body. Archive files living in *other* paths are **structurally invisible** to the
   pack — no pack change, no lean-surface regression. Prove it with test (5).
2. **Persistent searchable history of ALL journal entries.** Append-only per-member archive
   + a small mutable index (`journals/index.json`) updated at every checkpoint write and
   every sleep bump.
3. **Persistent per-session full session log for EVERY journal entry.** Each archive entry
   is tied to a complete session log for that cycle, captured **automatically** at the moment
   the journal entry is created.
4. **Automatic one-cycle capture (WAKE→memo), one log per cycle.** Distinct from the
   multi-sleep GUI "Session log" ZIP. Sliced by event `seq` (exact) or `time` (fallback).
5. **The journal must CITE the archive entry + session log path.**
6. **Storage in the live stateDir (`.deepartments`), for ALL members** — host (Asistente),
   heads AND workers — registry **parity**.
7. **Semantic search via RAG/embeddings** (a `journals` embeddings DB) + key/value grep.

**Non-goals (out of scope, do NOT build)**
- Do NOT change the injected checkpoint (`journals/<memberId>.md`) structure, its
  `wake_counter` regex the pack's KPI relies on (:1909-1912), or the surface-reset path.
- Do NOT capture the multi-sleep descendant tree (the GUI "Session log"
  `includeDescendants=true` behavior) — one log per cycle only.
- Do NOT build a cross-instance lock (accepted risk, see Risks); do NOT block tool results.
- Do NOT auto-capture board events beyond the transcript (future, see Out of scope).
- No semantic dedupe of session logs / archive entries (future).
- No HTTP route, no authentication gate: capture is a pure in-process session-service read.

---

## Artifacts layout

All under the live `stateDir` (`.deepartments`, default org.ts:97). The checkpoint path and
structure are **unchanged**; everything else is new.

| Artifact | Path | Written by | Mode |
|----------|------|-----------|------|
| Checkpoint (unchanged) | `journals/<memberId>.md` | `writeJournal` / `bump*` | overwrite (unchanged) |
| Per-member append-only archive | `journals/archive/<memberId>.md` | `archiveJournalEntry` (+ buffer) | append-with-delimiter |
| Per-cycle full session log | `journals/sessions/<memberId>-<wake_counter>.md` | `captureSessionLog` | atomic tmp+rename |
| Per-member search index | `journals/index.json` | `archiveJournalEntry` | atomic tmp+rename (last-write-wins) |

Where `<memberId>` is the durable id — host `host-<sessionId>`, head/worker `head-<postId>`
— and `<wake_counter>` is the ORDINAL the sleep layer bumps (uniform parity since
2026-08-20, Batch B).

### (a) `journals/archive/<memberId>.md` — append-only entry history
Every checkpoint write appends the full entry text, delimited so interleaving from the
shared-stateDir case is tolerable:

```
=== ENTRY ts=<agent local> wake_counter=<n> seq=<boundary or last seq> ===
<the full journal entry text, i.e. the `content` string built by writeJournal>
=== END ENTRY ===
```

- Written with `appendFile` (crash loses at most the tail entry, never corrupts the
  checkpoint). To keep the whole-archive write self-consistent across instances, the
  delimiter carries a per-write unique marker (`seq=…` or an incrementing
  `<utcMs><sessionId-hash>` suffix) so a reader can split entries even after interleaved
  appends.
- The granularity is per **checkpoint write**: since `dept_memo_write` and `dept_sleep`
  both mutate the checkpoint through the same two functions, both must append (capture on
  write AND on the sleep bump — see Capture flow).

### (b) `journals/sessions/<memberId>-<wake_counter>.md` — one-cycle session log
The complete, bounded markdown serialization of that awake session's transcript
(WAKE→memo), named by the bumped ordinal. Format (frontmatter + body):

```
---
member: <memberId>
room: <roomId>
session_id: <agent.id — the durable session id>
wake_counter: <n>
start_seq: <boundarySeq+1>
end_seq: <lastSeq>
start_time: <iso>
end_time: <iso>
journal: <relative path to journals/<memberId>.md>
---
## cycle
- **user:** (≤2000 chars)
- **assistant:** (≤2000 chars)
- **tool** `bash` → *ok/failed*: input `…` (≤800 chars); result … [truncated] (≤2000 chars)
- **turn/step boundaries**, **title/plan** as short one-liners
```

If the transcript cannot be captured, write the **stub** form (see Capture flow → fallback):
same frontmatter with `transcript: unavailable` + reason + a pointer to the checkpoint, plus
the checkpoint text or its path. **Never throw** — `ctx.logger.warn` only.

### (c) `journals/index.json` — search index (see Index schema)

### Journal-body citation
The generated entry must cite BOTH new artifacts so the entry is self-locating and
searchable. Add to writeJournal's produced content (alongside the existing frontmatter) two
lines inside the frontmatter block:

```
archive_seq: <n>                 # or the archive entry marker
session_log: journals/sessions/<memberId>-<wake_counter>.md
```

The journal `summary` body may additionally reference the session log path in prose; the
frontmatter `session_log:` line is the durable, machine-readable citation. This satisfies
owner rule "The journal must CITE it."
**Constraint:** these are ADDITIVE frontmatter lines after `open_items:`/before the closing
`---`; they must not disturb the `wake_counter`/`open_items` lines the pack's KPI regex
reads (:1909-1912) — the KPI regex anchors `^wake_counter:` and `^open_items:` per-line, so
extra later lines are safe.

---

## Capture flow

**Single choke point.** All three archive artifacts are produced from ONE internal helper
set invoked inside the two closures every sleeping actor already funnels through:

- `archiveJournalEntry(memberId, roomId, ctx, exec, {checkpointText, wakeCounter})` — called
  from inside `writeJournal` **after** the checkpoint tmp+rename commit (src/invoke.ts:1675),
  so every `dept_memo_write` (head own-layer 2386-2415, host-plane 3494-3531) archives.
- Also invoked from inside `bumpHostSleepCounter` (after rename commit, :1703) and
  `bumpPostSleepCounter` (after :1730), so the **sleep boundary** (the ordinal advance +
  session end) is recorded. Because both call sites already have `memberId`, `roomId`,
  `wake_counter`, `prevTimestamp`/`last_wake`, `board_cursor`, and the tool's `exec`
  (`exec.agent.id` = session id, `exec.agent.session` = live Session), no extra plumbing is
  needed to name the file, find the session, and compute the boundary.

**Per-cycle session-log capture** — `captureSessionLog(memberId, roomId, sessionId,
wakeCounter, boundarySeq)`:
1. **Resolve the service**: `ctx.get('sessionPersistence')` (must be injected — see
   Service injection). If absent, → stub.
2. **Flush, then read**: `await ctx.get('sessions').flush(session)` (mirrors
   `flushLiveSessionLog`, session-export.js:95-101) then
   `await ctx.get('sessionPersistence').readRaw(SessionId(agent.id))` (the exact
   `dsh-host-apiproxy`/`sessionLogExportDeps` in-process read, session-export.js:55/207).
   `exec.agent.id` IS the durable session id (host `host-<sessionId>` :3566, head
   `head-<postId>` :3524) — pass `SessionId(agent.id)` directly.
3. **Slice one cycle** — keep events where:
   - **exact (recommended)**: `event.seq > boundarySeq`, where `boundarySeq` is the
     persisted `session.seq` at the previous dept_sleep boundary (see Boundary seq below);
     or
   - **fallback**: `event.time > lastWakeMs` using `Date.parse(prevTimestamp)` from the
     prior journal (`last_wake`, :1635/:1648) — clock-tick-tolerant enough for a first cut,
     but `seq` is authoritative (do NOT rely on `time` alone for the boundary).
4. **Serialization** — the bounded markdown (Artifacts (b)) with caps:
   `MAX_TOOL_ARGS=800`, `MAX_TOOL_RESULT=2000`, `MAX_TEXT=2000` chars per field, elide the
   tail with `… [truncated]`. Emit final `assistant/message` (skip `assistant/chunk`),
   tool call as `tool <name> → ok/failed: <args capped>`, keep tool **name + status +
   truncated input** (the high-value searchable signal). Keep `attachmentId` references,
   never bytes / `data:` URIs. Hard cap `MAX_FILE_BYTES = 512 KB` per file: on overflow drop
   chunk/step event classes first, then truncate oldest tool results, then stop — never an
   unbounded file.
5. **Write** to `journals/sessions/<memberId>-<wake_counter>.md` atomically (tmp+rename,
   same pattern as writeJournal :1672-1680). Return the relative path for the citation.
6. **Best-effort/non-fatal**: wrap 1-5 in `try/catch`; on any failure write the **stub**
   (frontmatter + `transcript: unavailable` + reason + pointer to the checkpoint),
   `ctx.logger.warn('[deepartments] session log capture skipped: …')`, and **always let
   writeJournal's memo commit proceed**. Never throw into the tool result (owner rule).

**Boundary seq** (make the time-independent slice exact): at the dept_sleep host surface
reset (src/invoke.ts:3603, `session.append('user/message', buildSleepJournalMessage(seeded),
{surfaceOp})`) — and at the head own-layer dept_sleep (:2454 bump + sleepEpoch) — persist
`agent.session.seq` (immediately after the boundary append) into the same durable record
already saved (`sleepEpoch` in hosts.json/posts.json, :3621-3622/:3641-3642). On the next
`captureSessionLog`, read that stored `boundarySeq` and slice `seq > boundarySeq`. This is
exact, independent of clocks, and is the natural "previous sleep ended / this wake began"
marker. Timestamp fallback (`time > lastWakeMs`) is the default when no boundarySeq exists
(first-ever cycle).

**Append-only archive write**: append the delimiter + entry to `journals/archive/<memberId>.md`
with `appendFile`; update `journals/index.json` via atomic tmp+rename (last-write-wins,
documented acceptable — see Risks).

**Service injection** — the only plugin bootstrap change: `src/index.ts:17` currently
`inject = ['tools', 'sessions', 'sessionProjections']`. **ADD `'sessionPersistence'`** (+
optional `'sessionQuery'` for future lineage) to the array. Follow the existing optional
`ctx.get(...)` discipline (resolve at use, fail-loud if a board tool needs it and it is
absent); session-service reads do NOT require the `tools`/`sessionProjections` already there.
Captured `sessionPersistence` must be resolved in `applyInvoke`'s scope so both the head
own-layer and host-plane dept_sleep paths see it.

---

## Index schema

`journals/index.json` — one JSON document, per-member keyed, last-write-wins rewritten
atomically (tmp+rename) at every `archiveJournalEntry`:

```jsonc
{
  "version": 1,
  "members": {
    "<memberId>": {
      "entries": [
        {
          "timestamp": "<ISO — the entry's checkpoint timestamp>",
          "wake_counter": 3,
          "current_step": "<optional>",
          "keywords": ["<topics/extracted ≥chunk-min 20 chars>"],
          "files_touched": ["<relative paths from summary/tool activity>"],
          "commits": ["<optional — derived from summary, best-effort>"],
          "open_items": ["<copied from frontmatter open_items>"],
          "report_paths": ["<.dsh/reports/… paths cited in the summary>"],
          "session_log_path": "journals/sessions/<memberId>-<wake_counter>.md",
          "archive_seq": "<the === ENTRY … === marker>"
        }
        // … one per checkpoint write / sleep bump
      ]
    }
  }
}
```

- **Search usage — grep/JSON**: the index gives instant O(entries) k/v lookup: "what did
  head-research do at wake 3?", "which cycle touched file X?" → `readFile(index)` +
  filter. The append-only archive gives the raw full text for `grep` over
  `journals/archive/*.md` and `journals/sessions/*.md`. No new search tool is required —
  the existing `tool-fs-search` / `tool-web-enhanced` surfaces read these files.
- **Search usage — semantic (RAG)**: see RAG integration. `web_search`'s RAG section returns
  document titles/paths/excerpts → the Asistente then reads the cited
  `journals/sessions/…` / archive file for full context.
- **Field population is best-effort**: `keywords`/`files_touched`/`commits`/`report_paths`
  are derived from the journal `summary` via lightweight heuristics (regex over known
  report paths, commit-style lines, link/backtick file tokens). Absent → `[]`. The
  authoritative fields are `timestamp`, `wake_counter`, `session_log_path`, `archive_seq`.

---

## RAG integration

**Database**: add a **`journals`** embeddings database to the `tool-web-enhanced` config in
BOTH personae and BOTH headless twins. `storePath` → the archive + sessions dirs
(`journals/archive` and `journals/sessions`) so every archive entry and every session log
is ingested as a flat Markdown document (the `tool-web-enhanced` RAG engine already chunks
heading-aligned Markdown, strips frontmatter, embeds, and stores in sqlite-vec).

Target config (mirrors the existing `reports` DB, verified present in the twins):

```yaml
databases:
  - name: reports
    path: /home/esuarez/projects/deepartments/.dsh/reports
    topK: 5
  - name: journals
    path: <stateDir>/journals      # covers archive/ + sessions/ (storePath family)
    topK: 5
```

**Embeddings provider fix — resolve the smoke 401.** The twins currently set
`embeddings.provider: remote` with `apiKeyEnv: DEEPINFRA_TOKEN` (verified:
`/opt/dsh/.dsh-dev/profiles/deepartments-dev-headless/cordis.patch.yml:65-69` and
`/opt/dsh/.dsh/profiles/headless-deepartments/cordis.patch.yml:68-72`). The remote provider
calls `https://api.deepinfra.com/v1/openai` (model `Qwen/Qwen3-Embedding-0.6B`) and **throws
a non-fatal 401** when `DEEPINFRA_TOKEN` is absent from the shell env. The spec **requires
the `journals` DB to resolve this so smoke ends with zero 401**. Two acceptable resolutions
(owner picks — see Questions):

- **(Preferred) Local provider**: switch `embeddings.provider: remote → local` (use
  `localModel: Xenova/bge-small-en-v1.5`). `onnxruntime-node` + `@huggingface/transformers`
  are ALREADY installed in the web profile node_modules (verified) — no new install, no
  network, deterministic, zero 401. Trade-off: slower first-time local embedding, smaller
  model quality.
- **Token at runtime**: keep `provider: remote` but ensure `DEEPINFRA_TOKEN` (or
  `EMBEDDING_API_KEY`) is present in the shell env at smoke/run time. Trade-off: secrets in
  env, external dependency, network needed.

Because the personae (`deepartments-dev`/`web` GUI) currently disable stock `tool-web` and
the enhanced bundle is only wired in the twins, the `journals` DB must be added in **both**
realms: the dev + stable persona configs and the dev + stable headless twin patches
(4 config targets, all outside the repo — see T2). Where a persona has no
`tool-web-enhanced` row, T2 adds the `journals` database alongside whatever the persona's
search/RAG surface already declares.

**Retrieval surface**: `web_search`'s RAG section (`sources: ...,rag`), which the toolkit
already exposes; a RAG query against `journals` returns a journal-hit result (title/path/
excerpt/score) with zero 401 after the provider fix.

---

## Build tasks

Non-overlapping files; each task one atomic unit, one owner, reviewer-gated, committed
after green. Tasks **T1** (org invoke) and **T2** (config, outside repo) are independent →
parallelizable after owner signs off the questions; **T3** (docs) can run in parallel last.

### T1 — Org layer: archive + session-log capture + index + service injection (src only, + tests)
**Files in scope**: `src/invoke.ts`, `src/index.ts`, `test/invoke.test.js`.

1. **Service injection** (`src/index.ts:17`): add `'sessionPersistence'` (+ optional
   `'sessionQuery'`) to the `inject` array.
2. **New internal helpers in `src/invoke.ts`** (all best-effort/non-fatal):
   - `archiveJournalEntry(memberId, roomId, ctx, exec, {checkpointText, wakeCounter,
     lastWakeMs, boundarySeq})` — appends to `journals/archive/<memberId>.md`, rewrites
     `journals/index.json` atomically, cites paths.
   - `captureSessionLog(memberId, roomId, sessionId, wakeCounter, boundarySeq)` — flush +
     readRaw, seq/time slice, bounded markdown to
     `journals/sessions/<memberId>-<wake_counter>.md`, stub on failure, returns path.
   - **Boundary persist**: at dept_sleep host surface reset (`src/invoke.ts:3603`) and head
     own-layer dept_sleep, persist `agent.session.seq` alongside `sleepEpoch` in
     hosts.json/posts.json.
3. **Hook points**: call `archiveJournalEntry` (+ `captureSessionLog`) inside `writeJournal`
   after the checkpoint commit (`:1675`) and inside `bumpHostSleepCounter` (`:1703`) /
   `bumpPostSleepCounter` (`:1730`).
4. **Citation**: add `archive_seq:` / `session_log:` frontmatter lines to the content built
   in `writeJournal` (`:1642-1654` block, after `open_items:`/before `---`), preserving the
   KPI regex lines (:1909-1912).
5. **Serialization module**: bounded markdown constants
   (`MAX_TOOL_ARGS=800`, `MAX_TOOL_RESULT=2000`, `MAX_TEXT=2000`,
   `MAX_FILE_BYTES=512*1024`) in the serializer.
6. **Tests — 5 new, through the REAL Loader (temp stateDir), anchored to the existing
   journal tests** (`invoke.test.js:1837/1866/1894/1933/2202/2482/2507/2553/2677/2725`,
   `seedJournal` 382-403):
   1. **writeJournal archives the entry** (via head own-layer `dept_memo_write`) → asserts
      `journals/archive/<postId>.md` grows by one per write and `journals/index.json`
      reflects it.
   2. **sleep boundary records per-session log named by the bumped ordinal** (via head
      own-layer `dept_sleep` and host-plane host `dept_sleep`) → asserts
      `journals/sessions/<memberId>-<wake_counter>.md` exists for the bumped ordinal.
   3. **index.json reflects both archive + session log** → `session_log_path` +
      `archive_seq` populated for the entry.
   4. **archive failure degrades silently** (simulate an archive write/flush/readRaw
      failure) → checkpoint write / dept_sleep still succeeds, stub written, no throw.
   5. **no archive leakage into the injected pack** → after archive writes,
      `readWakeJournalKpi` + the `agent/pre-step` pack still read the single checkpoint
      (no archive/session content in the wake surface).

   **Acceptance**: `pnpm build` green; `node --test` expected **114/114** (109 current + 5 new).

### T2 — Config: RAG `journals` DB + embeddings provider fix (OUTSIDE the repo — config only)
**Files in scope** (all outside the repo; owner/system config — edit with care, keep
backups):
- Dev persona: `/opt/dsh/.dsh-dev/.agent-presets/deepartments/agent.cordis.yml`
- Stable persona: `/opt/dsh/.dsh/.agent-presets/deepartments/agent.cordis.yml`
- Dev headless twin patch: `/opt/dsh/.dsh-dev/profiles/deepartments-dev-headless/cordis.patch.yml`
- Stable headless twin patch: `/opt/dsh/.dsh/profiles/headless-deepartments/cordis.patch.yml`

1. Add the **`journals`** database to the `tool-web-enhanced` `rag.databases` list in all 4
   targets (path → `<stateDir>/journals` covering archive/ + sessions/, `topK: 5`).
2. Resolve the **embeddings 401**: prefer `embeddings.provider: local` / keep
   `localModel: Xenova/bge-small-en-v1.5` (already installed); fall back to
   `DEEPINFRA_TOKEN` in the shell env at runtime (owner decision, QUESTION 2).
3. Keep a timestamped backup of each edited config (convention: `.bak-YYYYMMDD`) before
   editing, mirroring the existing `.bak-20260820` backups.
4. **Acceptance**: `dsh --dump-config` for dev + stable composes with the `# ==
   dsh-deepartments` layer AND the `rag.databases` list containing `journals`.

### T3 — Spec materialization + doc notes (repo docs)
**Files in scope**: `docs/specs/001-session-memory-archive.md` (NEW — `docs/specs/` does not
exist yet; numbering resolved to `001` by owner sign-off, T3), plus PROPOSED additions to
`AGENTS.md` +
`docs/ROADMAP.md` (marked, NOT committed by the scribe; the Asistente/owner applies).

1. Materialize this spec (verbatim) as the repo spec under `docs/specs/`.
2. PROPOSED, for the human: AGENTS.md note pointing at the archive layout + the
   session-log citation contract; ROADMAP tail entry for the new W-batch.

**Handoff order**: T1 + T2 in parallel (disjoint files), then T3, then the full
verification ladder. Each task's builder reports + reviewer PASS gate before commit.

---

## Verification ladder

Run in order (from AGENTS.md, TIERED, non-negotiable). Development/smoke ALWAYS in
`deepartments-dev`/`deepartments-dev-headless` (`DSH_HOME=/opt/dsh/.dsh-dev`), never
against the live web profile.

1. `pnpm build` — tsc NodeNext compiles `src → lib`, zero type errors.
2. `DSH_HOME=/opt/dsh/.dsh-dev dsh plugin --profile deepartments-dev add
   /home/esuarez/projects/deepartments` — installs the bundle in the isolated dev home.
   (Restart the service after `add` — manifest/client metadata are cached.)
3. `DSH_HOME=/opt/dsh/.dsh-dev dsh --profile deepartments-dev --dump-config` — composes the
   tree WITHOUT booting; **must show the `# == dsh-deepartments` layer** AND
   `rag.databases` containing `journals`.
4. **Tests**: `node --test` through the real Loader → expected **114/114** (109 + 5 new
   archive tests). SRC-NATIVE METHOD (fb-95, 2026-09-04 — the ladder's
   `--loader ./test/ts-src-loader.mjs --test` default produces FALSE FAILS in the
   composition/Loader family even on a clean tree): the default test command is
   PLAIN `node --test` over the BUILT `lib/` (`pnpm test`); the `--loader`
   `ts-src-loader.mjs` variant is used ONLY where the test itself self-registers
   the hook (the lane-② src-native tests), never as a whole-suite default.
5. **Headless smoke** (`deepartments-dev-headless`): a twin cycle (memo → sleep) creates a
   per-cycle session log for the twin's cycle AND the injected pack STAYS LEAN — `pack-v1:
   present` with the single checkpoint only, no archive/session leakage.
6. **RAG check**: `web_search` RAG section (with `sources: ...,rag`) queried against
   `journals` returns a journal hit; **zero 401** in the smoke (provider fix verified).
7. Stable re-validation: `systemctl restart dsh.service`, `--dump-config` on stable, twin
   smoke (`headless-deepartments`) shows the same lean pack + session-log creation.

---

## Risks

- **Concurrency / no cross-instance lock**: `.deepartments` (org.ts:97) is shared by dev
  GUI + dev headless twin + stable (both services `WorkingDirectory=/`). The existing
  tmp+rename is atomic per-file but **last-write-wins with no cross-instance lock**
  (journal-archive-hooks §6). **Mitigation (documented decision)**: index.json deliberately
  last-write-wins (acceptable — it is a cache of the append-only archive, which is the
  durable truth); the archive uses append-with-unique-delimiter so interleaved appends from
  concurrent instances remain **parseable** (each `=== ENTRY … ===` block stays intact even
  if blocks interleave); the per-cycle session log is named by member+ordinal → a concurrent
  same-ordinal write is overwrite-atomic, last-write-wins. A single-writer guard (lock file)
  is explicitly NOT built (non-goal) — revisit if corruption shows up.
- **Transcript size / pathology**: very long awake sessions, packed chunk rows, huge tool
  outputs → bounded by `MAX_*` caps + `MAX_FILE_BYTES=512 KB`; never an unbounded file.
  Attachments referenced by `attachmentId`, never by bytes.
- **Sleep boundary exactness**: timestamps across wake/sleep can land on different clock
  ticks → boundary `seq` (persisted at :3603) is authoritative; `time > lastWakeMs` only a
  first-cut fallback.
- **Embeddings 401**: remote provider fails without `DEEPINFRA_TOKEN` → must switch to local
  Xenova (`bge-small-en-v1.5`, already installed) or inject the token; otherwise smoke shows
  the 401 (non-fatal but breaks the "zero 401" acceptance).
- **Pack-lean regression guard**: any change that reads archive files into the pack path is
  forbidden; test (5) locks this. Keep `readWakeJournalKpi` reading ONLY the single
  checkpoint.
- **Service absence**: in minimal compositions (hermetic tests) `sessionPersistence` may be
  absent → capture must stub + warn, never throw (test 4).

---

## Out of scope / future

- Auto-capture of messaging events (send_message / agent_messages history) beyond the
  model-visible transcript, into the session log (currently only the DSH SessionEvent
  stream; the message store itself is the durable history).
- Semantic dedupe of archive entries / session logs (RAG returns near-duplicate chunks).
- A cross-instance write lock for the archive (accepted last-write-wins for now).
- KPI fallback for never-slept agents' wake pack (already an out-of-scope ROADMAP follow-up;
  unrelated to this archive).
- Multi-sleep descendant-tree log export parity with the GUI "Session log" ZIP (explicit
  non-goal; captured only in the GUI today).
- `sessionQuery.traceSession` lineage ingestion into RAG once the base capture is stable.

---

## Open questions for the owner (sign-off decisions) — RESOLVED 2026-08-20

All four sign-off decisions below were obtained from the owner on 2026-08-20 and are now
RESOLVED. Builders implement to the accepted answers; no further owner input is required
before dispatching T1/T2/T3.

1. **Slice boundary default**: use the persisted **boundary `seq`** (exact, clock-independent)
   with `time > lastWakeMs` as fallback. → **ACCEPTED** (the spec's recommended option; no
   time-only first cut).
2. **Embeddings provider resolution** (T2): **REMOTE with `DEEPINFRA_TOKEN` injected at
   runtime** (not local). → **RESOLVED: REMOTE** — keep `embeddings.provider: remote`,
   `apiKeyEnv: DEEPINFRA_TOKEN`, and ensure `DEEPINFRA_TOKEN` (or `EMBEDDING_API_KEY`) is
   present in the shell env at smoke/run time so the RAG smoke ends with zero 401.
3. **`sessionQuery` injection**: add it **NOW**, alongside `sessionPersistence`, for
   lineage-readiness. → **RESOLVED: INJECTED NOW** — `src/index.ts` `inject` array gains both
   `'sessionPersistence'` and `'sessionQuery'`.
4. **Docs/spec numbering**: this file, `docs/specs/001-session-memory-archive.md` (repo had no
   `docs/specs/` yet; T3 created it). → **RESOLVED: `001`**.
