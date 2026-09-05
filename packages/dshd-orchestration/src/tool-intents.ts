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
 *   {kind:'settle', id, tool, agent, status:'settled'|'error'|'aborted', reason?, ts}
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
   * / churn / read-only abort / the raw abort message excerpt). */
  reason?: string
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

/** The PURE abort-REASON classifier (objective 2 — the durable reason the
 * abort family lacked). Maps the harness abort message + the tool name to a
 * stable class:
 *   interruption (W9-b / harness interrupt),
 *   cancel (an explicit user cancel),
 *   churn (a killed / terminated / stopped turn — restarts, process stops),
 *   read-only abort (a READ-ONLY tool aborted — the fb-111 pure-read class),
 *   abort (a generic «tool call aborted»),
 *   else the raw message excerpt (capped) — NEVER a flat empty reason. */
export function classifyToolAbortReason(message: string, tool: string): string {
  const text = message.trim()
  if (/interrupt/i.test(text)) return 'interruption'
  if (/cancel/i.test(text)) return 'cancel'
  if (/killed|terminated|stopped by|process was stopped|restart/i.test(text)) return 'churn'
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