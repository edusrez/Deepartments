# Internal Programming Department — Incident Playbook

Runbook for the incident classes the department has diagnosed. Each entry
records: the **symptom** (how to recognize it), the **forensic map** (where the
durable evidence lives), the **verified root cause** (with `file:line`
references from the diagnosis), and the **escalation checklist** (what to
verify BEFORE escalating to the owner so a misclassification is not replayed).

- **Language:** English (AGENTS.md language policy, binding).
- **Path citations:** absolute everywhere, per the canonical rule of
  `docs/STORES-MAP.md` §3 (fb-136/140/147/159/165/170) — a short relative form
  resolves against the reader's cwd and is a ghost-store win.
- **Evidence:** every entry sources from a department report in the department
  workspace (`/root/.deepartments/departments/internal-programming/reports/`).
- **Updating:** add a new entry when the head/explore-deep closes a new
  incident class; keep the existing structure and style; never delete a lesson
  without the head's decision.

---

## 1. Session archives map (forensic evidence — workers and heads)

WHERE the durable trace of a dead agent actually lives. This map exists because
a verification that looked only at the org state stores concluded **«0
artifacts / no session archive»** in false for the fb-251 bare-400 class
(2026-09-09) — the session archives were there all along, in the DSH dev home.

### 1.1 Worker sessions — DSH dev home (`/opt/dsh/.dsh-dev`), OUTSIDE the org state

| What | Path |
|---|---|
| Worker session archives (deepartments-dev profile) | `/opt/dsh/.dsh-dev/sessions/--root-.deepartments-departments-internal-programming--/<sessionId>/session.jsonl.zstd` |
| Session dir naming | `<role>-<n>-<uuid>` — e.g. `worker-builder-192-9f168bba-2e7f-4608-a30b-d138f2de195c/`, `worker-explore-deep-66-c9944b14-.../`, `head-internal-programming-head-<uuid>/` |
| Archive file | `session.jsonl.zstd` — zstd-compressed JSONL (one event per line); decompress with `zstd -dc` or `dept_zstd_read` (bounded, read-only) |

Key properties (verified live 2026-09-09):

- The base `/opt/dsh/.dsh-dev` is the **DSH dev home of the
  `deepartments-dev` profile** — it is **NOT** `/.deepartments` (the LIVE org
  stateDir, resolved by the daemon with `WorkingDirectory=/`) and **NOT**
  `/root/.deepartments` (which holds only the department workspace tree
  `<workspacePath>/departments/<dept>/` — **no session state there**).
- The archive holds the FULL event stream of the session, including the
  assistant/chunk `usage` events (real token consumption), tool results, and
  the fatal frame — the evidence that post-error rows only summarize.
- Compressed examples from fb-251: `worker-builder-192` ≈ 315 KB decompressed
  (102 KB zstd), `worker-explore-deep-59` ≈ 243 KB, `worker-explore-deep-66` ≈
  1.35 MB. A session is NOT "missing" because its archive is small.

### 1.2 Head traces — the org stateDir

For heads (and any post whose session lifecycle is the org's), the durable
trace is the **post-error rows** in the LIVE stateDir:

| Trace | Path |
|---|---|
| Live post-error rows | `/.deepartments/post-errors.jsonl` |
| Post-error archive (rotated rows, incl. research-head turn 37 of fb-251) | `/.deepartments/post-errors-archive.jsonl` |

### 1.3 The lesson (fb-251 forensic gap)

- **Before concluding «0 artifacts / no session»:** verify against the **DSH
  dev home** first — `/opt/dsh/.dsh-dev/sessions/--root-.deepartments-departments-internal-programming--/`
  — in ADDITION to the org state stores. The fb-251 class was mis-attributed
  («turn-1 / 0 tokens / 0 artifacts») precisely because the earlier check only
  inspected `/.deepartments` and `/root/.deepartments`.
- **`/root/.deepartments` holds only the department workspaces**, not session
  state. Do not treat the absence of a session dir there as evidence of
  "no session" — look in the dev home.
- **Do not trust the post-error row alone for token attribution:** a
  `usage(0,0)` on the failed request does not mean zero tokens were consumed;
  the previous requests' usage lives in the session archive.
- Citation canon: always cite the archive with its **absolute** path
  (`/opt/dsh/.dsh-dev/sessions/.../<sessionId>/session.jsonl.zstd`), never a
  relative form.

---

## 2. bare-400 class (fb-251, 2026-09-09) — «400 status code (no body)» misclassified as `CONTEXT_WINDOW_EXCEEDED`

### 2.1 Symptom / typical fatal frame

A worker/head dies mid-session with a 400 from the upstream. In the session
archive (`session.jsonl.zstd`) the fatal sequence is IDENTICAL across victims
(builder-192 seq 1003-1006, explore-deep-59 seq 955-958, explore-deep-66 seq
8149-8152):

```json
{"type":"assistant/chunk",...,"chunk":{"type":"usage","usage":{"inputTokens":0,"outputTokens":0}}}
{"type":"assistant/chunk",...,"chunk":{"type":"finish","reason":{"kind":"error","failure":{"message":"400 status code (no body)","code":"CONTEXT_WINDOW_EXCEEDED"}}}}
{"type":"turn/end",...,"data":{"turn":1,"reason":{"kind":"error","error":{"message":"400 status code (no body)","code":"CONTEXT_WINDOW_EXCEEDED"}}}}
```

The post-error row (pre-fb-251) only kept the raw text:
`{"error":"400 status code (no body)"}` — the `code` was DISCARDED, which made
the class opaque. Since the fb-251 fix (LISTO-PARA-COMMIT), the row also
carries the code: `{"error":"400 status code (no body)","code":"CONTEXT_WINDOW_EXCEEDED"}`.

### 2.2 What it is NOT (do not re-play the fb-251 mis-attribution)

| False attribution (fb-251 triage) | Verified reality |
|---|---|
| «first request of the session / turn-1 death» | victims ran **5 / 10 / 56 work steps** (real tokens: up to 136K `cacheReadTokens`) BEFORE the fatal 400; research-head died on turn 37. The «turn 1» in the post-error is the session turn, not the first request. |
| «0 tokens / 0 artifacts» | the `usage(0,0)` belongs to the FAILED request (rejected before generating) — previous requests consumed tokens (builder-192: 12349/5650/7182/4595 input; explore-deep-66: 136192 cacheReadTokens on step 56, SUCCESSFUL). The session archives EXIST (see §1). |
| «context overflow» (`CONTEXT_WINDOW_EXCEEDED`) | **MISCLASSIFICATION by pi-ai.** Declared contextWindow is **1048576** (settings.yaml); fatal contexts were **24.6K / 26K / 136K** tokens — orders of magnitude below. The label is a classification artifact, not a measurement. |

### 2.3 Verified root-cause chain

1. **Upstream returns a 400 with EMPTY body mid-session** — `https://opencode.ai/zen/go/v1`
   (provider `opencode-zen`, keyEnv `OPENCODE_GO_KEY_6`) via the key-pooler
   (`dsh-key-pooler`). The pooler NEVER generates a 400: its own errors are 502
   (`src/proxy.ts:630/640`) and an upstream 400 is relayed RAW (`relayRaw`).
   The 400 observed by the openai SDK is therefore the upstream's, body empty.
2. **pi-ai misclassifies ANY «400 status code (no body)» as context overflow**:
   `@earendil-works/pi-ai dist/utils/overflow.js:60` — `OVERFLOW_PATTERNS`
   contains `/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i` commented
   «Cerebras: 400/413 with no body» (a GENERIC pattern, provider-blind);
   `isContextOverflow` Case 1 (`:128-136`) matches it without checking the
   provider or the real size; `dsh-llm-pi-ai/lib/index.js:1287-1293` maps
   `piAiOverflow` → `{kind:'error', failure:{message, code:'CONTEXT_WINDOW_EXCEEDED'}}`.
3. **No recovery possible** — `dsh-compaction-basic/lib/index.js:803` only
   retries compaction when `failure.code === CONTEXT_WINDOW_EXCEEDED`; being a
   misclassification, compaction cannot fix a non-context 400 → the session
   dies anyway (no retry visible in any archive).
4. **Not quota/key** — key pool state at the time: oc-6 15%, oc-13 14%, oc-14
   18%, `invalid:false`, `blockedUntil:0`.
5. **Exact upstream reason still UNKNOWN** (empty body). Candidates
   DISPROVEN: common body size (243KB/315KB/1.35MB differ); char class
   U+00D7/U+201C/U+201D (sanitizer applies to all models ≤16MB,
   `src/proxy.ts:488-504`); fb-57 invalid-arguments (that case carries body
   text). The fb-235 instrumentation (dsh-key-pooler, commit f3d9c87) will
   capture key + workspace of the next bare-400 — but only after the daemon is
   restarted to load the rebuilt lib (log goes to the systemd unit journal,
   outside worker scope).

### 2.4 Escalation checklist — BEFORE saying «context exceeded»

1. **Compare against the declared contextWindow** for the model/provider
   (settings.yaml) — the fatal context measured from the archive's real usage
   vs the window. Orders-of-magnitude below ⇒ misclassification, not overflow.
2. **Read the PREVIOUS `assistant/chunk usage`** in the session archive
   (`inputTokens` + `cacheReadTokens`) — never the `usage(0,0)` of the failed
   request.
3. **Check whether the 400 was mid-session** (many successful steps before) —
   a mid-session upstream 400 with empty body is the bare-400 signature, NOT a
   window overflow.
4. **Read the post-error row's `code`** — post-fb-251 the row carries code +
   raw text: `code:"CONTEXT_WINDOW_EXCEEDED"` + `error:"400 status code (no
   body)"` is the misclassification signature. Pre-fb-251 rows carry raw text
   only (no code key) — consult the session archive for the frame.
5. **Check pooler/key state** (`keyPooler-state.json` in the dev home) —
   healthy keys + a raw 400 relay point to the upstream, not to quota/rotation.
6. **Check the fb-235 `provider-400 BARE` capture** in the daemon journal after
   a restart — it names the key + workspace of the next bare-400.

### 2.5 Handling / next steps

- Class the incident as **bare-400 (upstream 400, empty body)** — NOT context
  overflow; do not route it into context-window escalation, do not blame the
  session size.
- Re-spawn the post (the standard fb-76 pattern); the death is environmental
  (upstream), not a state/context problem.
- Record evidence with ABSOLUTE archive paths per §1.3; keep the row's `code`
  in any write-up so the misclassification stays visible.
- If a REAL overflow is ever suspected, demonstrate it with cumulative actual
  usage vs the declared window from the session archive before escalating.

---

## 3. Provenance and updates

| Date | Class | Sources |
|---|---|---|
| 2026-09-09 | bare-400 + session-archives map (fb-251) | `/root/.deepartments/departments/internal-programming/reports/explore-deep/2026-09-09-fb251-bare400-repro-b56486b1.md`, `/root/.deepartments/departments/internal-programming/reports/builder/2026-09-09-fb251-code-capture-3c1113c0.md` |

Related repo docs: `docs/STORES-MAP.md` (store topology + absolute-path canon),
`docs/specs/005-internal-programming-department.md` (role protocol),
`docs/specs/006-system-health.md` (health alerting, where post-errors surface).