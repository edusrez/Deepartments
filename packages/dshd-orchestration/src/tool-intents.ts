/**
 * Deepartments — LANE R4 (2026-09-05, «aborts sin detalle + clase O1»): the
 * WRITE-AHEAD TOOL-INTENT sidecar. The abort family
 * (fb-69/70/81/83/126/133 — «tool call aborted before dispatch» / «tool call
 * aborted» with NO durable trace of the intent; fb-110/111 — the O1 class
 * where ask_user_question / pure READS abort without a durable reason) is
 * closed at the HARNESS TOOL-DISPATCH SEAM: the deepartments tools factory
 * registers `tools/pre-execute` (persist the INTENT — tool, arguments, target,
 * ts — BEFORE the real dispatch; a turn that dies mid-dispatch leaves the
 * intent row WITHOUT a settle = the recoverable record) and `tools/post-execute`
 * (settle the intent; a life-abort settle writes the REASON durably + surfaces
 * it through the post-error health pipeline).
 *
 * This module is the PURE + FS half: the sidecar (append-only JSONL, bounded
 * to the most-recent TOOL_INTENTS_MAX_LINES rows — the same cap discipline as
 * the toolset-audit / deliveries sidecars), the tolerant parsers, the
 * ABORT SCAN (intents started within a window that NEVER settled = the abort
 * class, and settles with status 'aborted' carrying the reason), the abort
 * REASON classifier (interruption / cancel / churn / read-only abort), and the
 * interrupt-state.json CONNECTION (recordToolAbortInterruptDetail — the O1-EXT
 * P4 (m-1311) detail ledger, the same `interrupt-detail:` sibling entries
 * safeInterrupt writes).
 *
 * Row shapes (append-only, one row per transition — the deliveries.jsonl
 * pattern):
 *   {kind:'intent', id, tool, agent, memberId, target, args, ts}
 *   {kind:'settle', id, tool, agent, status:'settled'|'error'|'aborted', reason?, cause?, ts}
 *
 * CONTRACT (fb-957, 2026-09-14 — the cause/abort split; read this before
 * touching either field): the two diagnostics are MUTUALLY EXCLUSIVE and each
 * rides exactly ONE status.
 *   - `reason` (the abort taxonomy, R4) rides ONLY an `aborted` settle (a
 *     life-abort: interruption / cancel / churn / read-only abort / abort). A
 *     SUCCESSFUL settle NEVER records a reason (the noise-guard contract).
 *   - `cause` (the closed ERROR enum, fb-957) rides ONLY an `error` settle.
 *     It is a CLOSED enum key — NEVER free text (the sibling `intent` row of
 *     the SAME `id` already carries the capped `args`, so the long form is
 *     reachable by join and must not be duplicated here).
 *   - a `settled` row carries NEITHER.
 *
 * NO export default (pitfall 0001 — breaks `inject`).
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
// The interrupt-state.json connect consumes the dshd-health EXPORTED helpers
// (readInterruptState / writeInterruptState — safeInterrupt's own ledger
// writers); the detail map is preserved raw across the write.
import { readInterruptState, writeInterruptState } from 'dshd-health'

/** The tool-intent sidecar filename under the runtime stateDir. */
export const TOOL_INTENTS_FILE = 'tool-intents.jsonl'

/** The bounded record cap of tool-intents.jsonl (trim the OLDEST rows on
 * append — a scan window is far below this cap, so the abort evidence never
 * ages out of the sidecar before the health window does). */
export const TOOL_INTENTS_MAX_LINES = 2000

/** The conservative BYTE guard for the trim: the read+rewrite only runs once
 * the file plausibly exceeds TOOL_INTENTS_MAX_LINES rows (a generous 2 KiB per
 * row bound — the actual rows are far smaller) — so the append hot path never
 * reads the whole sidecar per tool call; the bounded trim stays O(1) typical. */
export const TOOL_INTENTS_MAX_BYTES = TOOL_INTENTS_MAX_LINES * 2048

/** The per-row ARGS projection cap (a send_message text / dept_exec command /
 * a read path — the recoverable content — is persisted in full up to this
 * bound, then truncated with a marker; bounds the sidecar rows). */
export const TOOL_INTENT_ARGS_MAX_CHARS = 2000

/** The synthetic post id of the abort SURFACE row (the W6 daemon scans
 * post-errors.jsonl and displays findings by post+class — the
 * REASONING_CONTENT_PREFLIGHT_POST_ID precedent). */
export const TOOL_ABORT_POST_ID = 'tool-abort-intent'

/** The post-error dedupe key prefix (appendPostErrorDeduped — same-class
 * aborts within HEALTH_DEDUPE_WINDOW_MS collapse to ONE surfaced row). */
export const TOOL_ABORT_DEDUPE_KEY_PREFIX = 'tool-abort:'

/** fb-957 — the CLOSED cause enum of an ERRORED settle. Every value is
 * DERIVABLE at the point the settle row is written (see
 * {@link classifyToolErrorCause}); a cause the settle point cannot derive is
 * NOT in this enum — it degrades to 'other'. The enum is the measurement
 * contract: a failure rate BY CAUSE is computed from it, so a value may only be
 * added together with the structured signal that derives it. */
export type ToolErrorCause =
  | 'guard-denied'
  | 'tool-unknown'
  | 'schema-invalid'
  | 'output-invalid'
  | 'timeout'
  | 'path-not-found'
  | 'other'

/** The enum as a runtime list (a CLOSED set — the display order). */
export const TOOL_ERROR_CAUSES: readonly ToolErrorCause[] = [
  'guard-denied',
  'tool-unknown',
  'schema-invalid',
  'output-invalid',
  'timeout',
  'path-not-found',
  'other'
]

/** The byte-locked prefix EVERY dept_exec / dept_zstd_read scope denial
 * carries: `src/invoke.ts:3002/3013/3024/3036/3042/3057/3064` (deptExecDenyReason)
 * + `:3133` (deptZstdReadDenyReason), thrown as a PLAIN Error by
 * `packages/dshd-orchestration/src/tools.ts:1964/2044` — and pinned
 * byte-identically by the guard tests (e.g. test/r5-dx-guards.test.js:115). A
 * guard denial is therefore the ONE cause anchored to a MESSAGE (the scope
 * guards leave no structured code: dsh-tools/lib/index.js:2501-2511 sets
 * `error.info` only for a HarnessError). */
export const GUARD_DENY_REASON_PREFIX = 'OUT_OF_SCOPE / DENIED'

/** One write-ahead INTENT row (persist BEFORE dispatch). */
export interface ToolIntentStartRow {
  kind: 'intent'
  /** The exec callId when available, else a minted id (settle matches it). */
  id: string
  /** The tool name (exec.name). */
  tool: string
  /** The raw agent id (exec.agent.id). */
  agent: string
  /** The resolved member id (postIdForChild(agentId) ?? agentId) — the TARGET. */
  memberId: string
  /** A compact target label (for send_message: the to[] recipients; for
   * dept_exec: the cwd; for read/glob/grep: the path; else the memberId). */
  target: string
  /** The lossless-JSON projection of the parsed arguments (capped). */
  args: string
  /** Epoch ms. */
  ts: number
}

/** One SETTLE row — the intent's terminal transition. */
export interface ToolIntentSettleRow {
  kind: 'settle'
  /** The correlated intent id (exec.callId when available). */
  id: string
  tool: string
  agent: string
  status: 'settled' | 'error' | 'aborted'
  /** The durable ABORT REASON when status === 'aborted' (interruption / cancel
   * / churn / read-only abort / the raw abort message excerpt). NEVER present
   * on a successful settle (the noise-guard contract) and never on an error
   * settle — see {@link ToolErrorCause}. */
  reason?: string
  /** fb-957 — the CLOSED cause key of an ERRORED settle (status === 'error').
   * Absent on 'settled' and on 'aborted' rows: the abort taxonomy is `reason`
   * and the two diagnostics never mix. Shorter than a free-text reason BY
   * CONSTRUCTION (a key of {@link TOOL_ERROR_CAUSES}) — the failure rate by
   * cause is measurable from this field while the long form stays reachable
   * through the sibling intent row of the SAME id. */
  cause?: ToolErrorCause
  ts: number
}

/** The union row type of tool-intents.jsonl. */
export type ToolIntentRow = ToolIntentStartRow | ToolIntentSettleRow

/** A PURE tolerant parse of the sidecar JSONL (the deliveries parse pattern:
 * a trailing partial row is dropped, a malformed mid-file row throws with a
 * clear label). */
export function parseToolIntentRows(text: string, label = 'tool-intents file'): ToolIntentRow[] {
  const rows: ToolIntentRow[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      if (index === lines.length - 1) break // trailing partial row: drop
      throw new Error(`${label}: malformed row on line ${index + 1} (${error instanceof Error ? error.message : String(error)})`)
    }
    if (!isToolIntentRowShape(parsed)) {
      throw new Error(`${label}: malformed row on line ${index + 1} (not a tool-intent row shape)`)
    }
    rows.push(parsed)
  }
  return rows
}

function isToolIntentRowShape(value: unknown): value is ToolIntentRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  if (row.kind === 'intent') {
    return typeof row.id === 'string' && typeof row.tool === 'string' && typeof row.ts === 'number'
  }
  if (row.kind === 'settle') {
    return typeof row.id === 'string' && typeof row.tool === 'string' && typeof row.status === 'string' && typeof row.ts === 'number'
  }
  return false
}

/** The sidecar path under the stateDir. */
export function resolveToolIntentsPath(stateDir: string): string {
  return path.join(stateDir, TOOL_INTENTS_FILE)
}

/** APPEND ONE row to the sidecar (mkdir + appendFile — the deliveries
 * markDelivery write-ahead pattern). Then, when the file exceeds
 * TOOL_INTENTS_MAX_LINES, REWRITE atomically (tmp + rename) keeping the newest
 * rows — the bounded-trim discipline; the abort evidence (recent rows) is never
 * the trimmed side. NEVER throws. */
export async function appendToolIntent(stateDir: string, row: ToolIntentRow): Promise<void> {
  try {
    const filePath = resolveToolIntentsPath(stateDir)
    await mkdir(path.dirname(filePath), { recursive: true })
    await appendFile(filePath, JSON.stringify(row) + '\n', 'utf8')
    // Bounded trim GUARDED BY BYTES (the abort class is rare, but a busy org
    // emits many tool calls/h — the whole-file read must not run per call):
    // only once the file plausibly exceeds the cap (each row ≤ ~2 KiB) is the
    // O(n) read+rewrite (atomic tmp + rename) performed keeping the newest
    // rows — the abort evidence (recent rows) is never the trimmed side.
    let size = 0
    try {
      size = (await stat(filePath)).size
    } catch {
      return
    }
    if (size <= TOOL_INTENTS_MAX_BYTES) return
    const text = await readFile(filePath, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    if (lines.length <= TOOL_INTENTS_MAX_LINES) return
    const kept = lines.slice(-TOOL_INTENTS_MAX_LINES)
    const tmpPath = `${filePath}.tmp-${Date.now()}`
    await writeFile(tmpPath, kept.join('\n') + '\n', 'utf8')
    await rename(tmpPath, filePath)
  } catch {
    /* best-effort: the write-ahead must never break a tool call */
  }
}

/** Read the sidecar → the parsed rows. Absent/unreadable → [] (never throws). */
export async function readToolIntents(stateDir: string): Promise<ToolIntentRow[]> {
  try {
    return parseToolIntentRows(await readFile(resolveToolIntentsPath(stateDir), 'utf8'))
  } catch {
    return []
  }
}

/** The latest row per intent id (append-ordered — the LAST match wins). */
export function latestToolIntentRows(rows: readonly ToolIntentRow[]): Map<string, ToolIntentRow> {
  const latest = new Map<string, ToolIntentRow>()
  for (const row of rows) latest.set(row.id, row)
  return latest
}

/** ONE abort finding of the scan. */
export interface ToolIntentAbortFinding {
  /** 'unsettled' — the intent was persisted (write-ahead BEFORE dispatch) but
   * NEVER settled: the dispatch died / the turn was aborted mid-call (the
   * «tool call aborted before dispatch» class). 'aborted' — the settle row
   * itself carries status 'aborted' with the durable reason (the O1 class). */
  kind: 'unsettled' | 'aborted'
  id: string
  tool: string
  agent: string
  memberId: string
  /** The recoverable INTENT projection (unsettled rows only — the re-drive
   * content that would otherwise be lost without a trace). */
  args?: string
  /** The durable reason (aborted rows only). */
  reason?: string
  ts: number
}

/** PURE abort scan over rows: the intents started within `windowMs` whose
 * LATEST row is an 'intent' (no settle = the pre-dispatch/dead-mid-dispatch
 * class) AND the intents whose latest settle has status 'aborted' — each with
 * the recoverable args (unsettled) or the durable reason (aborted). Rows
 * outside the window are ignored (the sidecar is bounded but old rows age
 * out). */
export function scanAbortedToolIntents(rows: readonly ToolIntentRow[], nowMs: number, windowMs: number): ToolIntentAbortFinding[] {
  const latest = latestToolIntentRows(rows)
  const findings: ToolIntentAbortFinding[] = []
  for (const [id, row] of latest) {
    if (row.kind === 'intent') {
      if (nowMs - row.ts > windowMs) continue
      findings.push({
        kind: 'unsettled',
        id,
        tool: row.tool,
        agent: row.agent,
        memberId: row.memberId,
        args: row.args,
        ts: row.ts
      })
      continue
    }
    if (row.kind === 'settle' && row.status === 'aborted') {
      if (nowMs - row.ts > windowMs) continue
      const start = rows.find((r) => r.id === id && r.kind === 'intent')
      findings.push({
        kind: 'aborted',
        id,
        tool: row.tool,
        agent: row.agent,
        memberId: start !== undefined && start.kind === 'intent' ? start.memberId : row.agent,
        reason: row.reason,
        ts: row.ts
      })
    }
  }
  return findings
}

/** The STRUCTURED EFFECT of one tool call — whether a kill/signal actually
 * reached the call in flight, and whether the kill ACHIEVED its effect. Read
 * from the result/exec object the settle point holds, NEVER from the message
 * wording (see {@link classifyToolAbortReason}): the `error.info.code` /
 * `error.code` the harness itself owns, plus the explicit `aborted` flag a
 * cancelled exec/result may carry. */
export interface ToolAbortSignal {
  /** `error.info.code` (the harness vocabulary — dsh-tools TOOL_ABORTED /
   * TOOL_ABORTED_BEFORE_DISPATCH; dsh-tools/lib/index.js:3552-3584). */
  code?: string
  /** The top-level `code` arm (a HarnessError-shaped value the registry did
   * not wrap into `error.info`). */
  topLevelCode?: string
  /** The explicit cancellation marker on the exec OR the result (the
   * defensive flag path isNudgeLifeAbort already honours). */
  aborted?: boolean
}

/** The harness abort CODES — the text-independent vocabulary of an in-flight
 * cancellation (dsh-tools/lib/index.js:2432/:2434 + the two canonical results
 * at :3552-3584). A call whose result carries one of these WAS killed in
 * flight; a call whose MESSAGE merely says «restart» was not. */
const TOOL_ABORT_CODES = new Set(['ABORTED', 'ABORTED_BEFORE_DISPATCH'])

/** The kill/turn-stop VOCABULARY. It is evidence of the EFFECT only together
 * with the structured kill signal — see {@link classifyToolAbortReason}: it
 * names WHAT the kill ended, it never establishes that a kill happened. */
const TOOL_KILL_VOCABULARY_RE = /killed|terminated|stopped by|process was stopped|restart/i

/** fb-1PROC (2026-09-15) — THE KILL EFFECT of one tool call, read from the
 * STRUCTURED signal ONLY: either the harness cancellation code (a REAL
 * in-flight kill: the signal arrived after the body started → ABORTED, or
 * before it → ABORTED_BEFORE_DISPATCH) or the explicit `aborted` marker. PURE.
 * NOTHING else counts — in particular a kill WORD in the message does not: the
 * measured false-positive class (2026-09-15) is a completed/plainly-errored
 * call whose message or path merely NAMED a `restart-window` artefact and was
 * still classified 'churn'. */
export function toolAbortSignalFrom(signal: ToolAbortSignal | undefined): boolean {
  if (signal === undefined) return false
  if (signal.aborted === true) return true
  if (typeof signal.code === 'string' && TOOL_ABORT_CODES.has(signal.code)) return true
  return typeof signal.topLevelCode === 'string' && TOOL_ABORT_CODES.has(signal.topLevelCode)
}

/** The PURE abort-REASON classifier (objective 2 — the durable reason the
 * abort family lacked). Maps the harness abort message + the tool name + THE
 * EFFECT to a stable class:
 *   churn (a kill/signal ACTUALLY reached the call in flight AND the message
 *          names the turn end the kill caused — a killed / terminated /
 *          stopped turn, a restart/process stop),
 *   interruption (W9-b / harness interrupt),
 *   cancel (an explicit user cancel),
 *   read-only abort (a READ-ONLY tool aborted — the fb-111 pure-read class),
 *   abort (a generic «tool call aborted»),
 *   else the raw message excerpt (capped) — NEVER a flat empty reason.
 * fb-1PROC (2026-09-15) — THE CLASSIFICATION IS BY EFFECT, NOT BY WORDING:
 * the pre-fix rule was `if (/killed|terminated|stopped by|process was
 * stopped|restart/i.test(text)) return 'churn'` over the WHOLE message, with no
 * position and no provenance, so a plain body error / a path / a command that
 * NAMED a `restart-…` artefact was classified 'churn' (the measured
 * false-positive family), while the REAL in-flight aborts — whose harness
 * message is the bare «tool call aborted» / «tool call aborted before
 * dispatch» (dsh-tools/lib/index.js:3552-3584, code ABORTED /
 * ABORTED_BEFORE_DISPATCH) — were NOT churn at all: the effect was invisible.
 * The churn class therefore requires the STRUCTURED kill signal
 * ({@link toolAbortSignalFrom}: the harness code — ABORTED after the body
 * started, ABORTED_BEFORE_DISPATCH before it — or the explicit flag) AND the
 * kill vocabulary, which then names WHAT the kill ended (a restart/process
 * stop). WITHOUT the signal the word decides NOTHING: a text-only caller (an
 * un-upgraded one) degrades to the honest reading ('abort' / the raw excerpt),
 * NEVER to a guessed 'churn' — the same text belongs to both the killed and the
 * merely-named class, so electing one of them from the text is precisely the
 * defect. The family is NOT vacated: BOTH in-flight kill shapes classify
 * 'churn' when the message names the turn end, and the vetted call sites
 * (tools.ts settle + nudge gate) always thread the real effect. */
export function classifyToolAbortReason(message: string, tool: string, signal?: ToolAbortSignal): string {
  const text = message.trim()
  const killEffect = toolAbortSignalFrom(signal)
  if (killEffect && TOOL_KILL_VOCABULARY_RE.test(text)) return 'churn'
  if (/interrupt/i.test(text)) return 'interruption'
  if (/cancel/i.test(text)) return 'cancel'
  if (/abort|before dispatch|tool call aborted/i.test(text)) {
    return isReadOnlyTool(tool) ? 'read-only abort' : 'abort'
  }
  return text === '' ? 'aborted' : text.slice(0, 200)
}

/** Whether a tool is READ-ONLY (the fb-111 class — aborts on pure reads). The
 * set names the harness fs/read family + the deepartments read-only tools. */
export function isReadOnlyTool(tool: string): boolean {
  return /^(read|glob|grep|readFile|web_fetch|dept_zstd_read|dept_who|agent_messages|dept_calendar_list|dept_memo_read)$/.test(tool)
}

/** fb-957 — the STRUCTURED error code → the closed cause enum. Only the codes
 * the harness / the wrapped plugins ACTUALLY own are mapped; every other code
 * degrades to 'other' (never the raw code — the field stays a closed enum).
 * Anchors (file:line, all in the loaded harness):
 *   - `UNKNOWN_TOOL` — dsh-tools/lib/index.js:2427-2437 (ToolNotFoundError;
 *     a model call naming a tool the scope does not resolve);
 *   - `INVALID_ARGS` — dsh-tools/lib/index.js:811-818 (ToolArgsError, the
 *     model-generated arguments failed the declared parameter schema);
 *   - `INVALID_TOOL_OUTPUT` — dsh-tools/lib/index.js:2440-2448 (ToolOutputError)
 *     plus `:2450-2452` (a throwing render / presentationMeta);
 *   - `TOOL_TIMEOUT` — dsh-tool-call-timeout-policy/lib/index.js:80-107 (the
 *     timeout plugin's structured replacement result);
 *   - the fs FAMILY (`FS_*`) — dsh-fs/lib/types/types.d.ts:162 declares the
 *     closed `FsErrorCode` union (`FS_NOT_FOUND` / `FS_EDIT_NOT_FOUND` /
 *     `FS_NOT_DIRECTORY` / `FS_SANDBOX_DENIED` / `FS_PERMISSION_DENIED` / …)
 *     and dsh-fs/lib/index.js:34-40 shows FsError extends HarnessError — so the
 *     code DOES reach `error.info.code`; `SEARCH_PATH_NOT_FOUND` —
 *     dsh-tool-fs-search/lib/index.js:65-71 + :89/:174.
 * The fs family is mapped by its DECLARED prefix/marker convention (the
 * vocabulary the harness itself owns), never by a guessed phrase. PURE. */
export function causeFromToolErrorCode(code: string): ToolErrorCause {
  if (code === 'UNKNOWN_TOOL') return 'tool-unknown'
  if (code === 'INVALID_ARGS') return 'schema-invalid'
  if (code === 'INVALID_TOOL_OUTPUT') return 'output-invalid'
  if (code === 'TOOL_TIMEOUT') return 'timeout'
  if (code === 'SEARCH_PATH_NOT_FOUND') return 'path-not-found'
  if (code.startsWith('FS_')) {
    if (code.includes('NOT_FOUND') || code.includes('NOT_DIRECTORY')) return 'path-not-found'
    if (code.includes('DENIED')) return 'guard-denied'
    return 'other'
  }
  return 'other'
}

/** fb-957 — the PURE cause classifier of an ERRORED tool settle. It reads ONLY
 * the structured signal the settle point holds:
 *   (1) `error.info.code` — the `{name, code}` pair dsh-tools/lib/index.js:2501-2511
 *       attaches to a HarnessError (the fs/search/timeout/tools families all
 *       carry one; the code is the harness's OWN vocabulary);
 *   (2) the top-level `code` arm — a body may throw a HarnessError-shaped VALUE
 *       the registry does not wrap into `error.info`;
 *   (3) our own byte-locked guard-deny PREFIX ({@link GUARD_DENY_REASON_PREFIX}),
 *       the ONE message-anchored rule: src/invoke.ts:3002-3064 throws PLAIN
 *       Errors (no code) whose phrase is pinned byte-identically by
 *       test/r5-dx-guards.test.js:115.
 * Everything else is 'other' — a class this point cannot DERIVE is never
 * invented. In particular the harness marks NO structural difference between a
 * `tools/pre-execute` deny / a `tools.guard()` denial (dsh-tools/lib/index.js:
 * :3116-3128 materializes `error: {message: denialReason}` with NO info) and a
 * body that throws the same plain string — so only OUR OWN guard phrase is
 * claimed. Likewise `provider` / `network` leave NO tool-layer marker at all
 * (the cloud-4xx class is classified at the JOB layer: packages/dshd-jobs/src/
 * index.ts:530 CLASS_OUTAGE_REASON_RE), and a failed shell command is not even
 * an error row (dsh-tool-bash/lib/index.js:36-43: «Non-zero exits are reported,
 * not errored … only infrastructure failures (spawn errors, aborts) surface as
 * isError results»). PURE. */
export function classifyToolErrorCause(error: unknown): ToolErrorCause {
  const record = (error ?? {}) as { message?: unknown; info?: unknown; code?: unknown }
  const info = (record.info ?? {}) as { code?: unknown }
  if (typeof info.code === 'string' && info.code !== '') return causeFromToolErrorCode(info.code)
  if (typeof record.code === 'string' && record.code !== '') return causeFromToolErrorCode(record.code)
  const message = typeof record.message === 'string' ? record.message : ''
  if (message.includes(GUARD_DENY_REASON_PREFIX)) return 'guard-denied'
  return 'other'
}

/** The write-ahead args projection (capped + truncation marker; lossless JSON
 * for the honest intent content the abort would otherwise lose). PURE. */
export function projectToolIntentArgs(argumentsValue: unknown): string {
  let text: string
  try {
    text = JSON.stringify(argumentsValue ?? {})
  } catch {
    text = '{}'
  }
  if (text.length <= TOOL_INTENT_ARGS_MAX_CHARS) return text
  return `${text.slice(0, TOOL_INTENT_ARGS_MAX_CHARS)}\u2026[truncated]`
}

/** The compact TARGET label of a tool call (send_message → the recipients;
 * dept_exec → the cwd; read/glob/grep → the path; else the member id). PURE. */
export function toolIntentTarget(tool: string, argumentsValue: unknown, memberId: string): string {
  const args = (argumentsValue ?? {}) as Record<string, unknown>
  if (tool === 'send_message') {
    const to = args.to
    return Array.isArray(to) ? String(to.join(',')) : memberId
  }
  if (typeof args.cwd === 'string' && args.cwd !== '') return String(args.cwd)
  if (typeof args.path === 'string' && args.path !== '') return String(args.path)
  return memberId
}

/** O1-EXT P4 (m-1311) CONNECTION: record a tool-abort reason as an
 * `interrupt-detail:<memberId>` sibling entry IN THE SAME interrupt-state.json
 * ledger safeInterrupt writes (the gate numeric entries + the existing detail
 * entries are PRESERVED — the write merges the raw maps). NEVER throws. */
export async function recordToolAbortInterruptDetail(stateDir: string, memberId: string, detail: { reason: string; sourceKey: string; ts: number }): Promise<void> {
  try {
    // Preserve the CURRENT numeric gate map + the CURRENT detail entries (raw
    // read of the same file readInterruptState parses — the additive detail
    // key is `interrupt-detail:<memberId>`, the m-1311 shape).
    const filePath = path.join(stateDir, 'interrupt-state.json')
    const raw: Record<string, unknown> = {}
    try {
      Object.assign(raw, JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>)
    } catch {
      /* absent/unreadable/malformed → start from {} */
    }
    const gate: Record<string, number> = {}
    const details: Record<string, { reason: string; sourceKey: string; ts: number }> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number' && Number.isFinite(value)) gate[key] = value
      else if (typeof value === 'object' && value !== null) details[key] = value as { reason: string; sourceKey: string; ts: number }
    }
    details[`interrupt-detail:${memberId}`] = detail
    // readInterruptState re-reads the SAME file (a concurrent safeInterrupt
    // may have written between our read and this call — the LAST write wins,
    // matching the ledger's own best-effort contract).
    await writeInterruptState(stateDir, { ...readInterruptState(stateDir), ...gate }, details)
  } catch {
    /* best-effort — the durable reason also lives in the settle row */
  }
}