// dsh-deepartments — board file store (owner decision 17): the plugin-owned
// append-only board file in the room's workspace is the COLD source of truth
// for room state. On rc.6 the harness persistence catalog refuses cold reads
// of third-party session event types (assertEventsSupported; no runtime
// registration surface — explore report
// .dsh/reports/explore-deep/2026-08-16-session-event-persistence.md), so the
// durable history must live in this file. The live session projection is
// initialized from it and folds live session events on top (src/org.ts).
//
// Wire format: one JSON record per line (JSONL), append-only:
//   {id, seq, ts, from, to[], cc[], threadId, kind, payload}
// kind ∈ 'ready' | 'message' | 'agenda'; `payload` carries the kind-specific
// fields (message kind/text/parts; agenda title/owner/status/cursorOfLastTouch;
// ready room metadata). Records are ID-addressable (decision 12).
//
// Seq semantics (documented choice): the board file seq is 0-based and
// contiguous — seq equals the record's index in the file. It is the ONLY
// ordering cursor board state references (e.g. agenda cursorOfLastTouch).
// The room session's own envelope seqs drift by one after a resumed boot
// (the harness appends its own session/end-seed marker after a constructor
// seed), so folds always read the seq carried INSIDE the record, never the
// session envelope seq. Emit sites assign seq = (last record's seq + 1),
// or 0 for an empty file.
//
// cwd caveat: `stateDir` comes from plugin config (default '.deepartments')
// and is resolved against the BOOTING process cwd — the same convention the
// harness's session-storage namespace uses. A boot from a different
// workspace resolves a different board file for the same room id. This
// batch does NOT change the resolution scheme (owner decision).
//
// NO export default (pitfall 0001 — breaks `inject`).
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Record wire types (shared by the board file and the session event payloads).
// ---------------------------------------------------------------------------

/** Lifecycle states of an agenda item (decision 12). */
export type AgendaStatus = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled'

/** Discriminator of a board record. */
export type BoardKind = 'ready' | 'message' | 'agenda'

/** `ready` payload: the boot marker's room metadata. */
export interface ReadyPayload {
  room: {
    id: string
    name: string
    purpose: string
    members: string[]
  }
}

/** `message` payload: message-kind + text; `parts` is reserved for future multimodal content. */
export interface MessagePayload {
  kind: string
  text: string
  parts?: unknown[]
}

/**
 * `agenda` payload: the item's own fields. `cursorOfLastTouch` is written by
 * the emit site equal to the record's own seq (self-description); the fold
 * re-derives it from `record.seq` — the single ordering source.
 */
export interface AgendaPayload {
  title: string
  owner: string
  status: AgendaStatus
  cursorOfLastTouch: number
}

/** The common envelope of every board record (one addressed envelope). */
export interface BoardRecordEnvelope {
  id: string
  seq: number
  /** Epoch ms of the record (mirrors the carrying session event's time). */
  ts: number
  from: string
  to: string[]
  cc: string[]
  threadId: string | null
}

/** One addressable board record — the single wire shape shared by the file and session events. */
export type BoardRecord = BoardRecordEnvelope & (
  | { kind: 'ready'; payload: ReadyPayload }
  | { kind: 'message'; payload: MessagePayload }
  | { kind: 'agenda'; payload: AgendaPayload }
)

/** The session event type that carries a record of this kind. */
export function boardEventType(kind: BoardKind): 'deepartments/room-message' | 'deepartments/agenda-update' | 'deepartments/room-ready' {
  switch (kind) {
    case 'message': return 'deepartments/room-message'
    case 'agenda': return 'deepartments/agenda-update'
    case 'ready': return 'deepartments/room-ready'
  }
}

// ---------------------------------------------------------------------------
// Store operations (node:fs only — no new dependencies).
// ---------------------------------------------------------------------------

/** Board file location for one room: `<stateDir>/rooms/<roomId>/board.jsonl`. */
export function resolveBoardPath(stateDir: string, roomId: string): string {
  return path.join(stateDir, 'rooms', roomId, 'board.jsonl')
}

/**
 * Pure parse of JSONL board text. Tolerant of a trailing partial line (a
 * crash mid-append): a final line that fails to parse is dropped; a
 * malformed non-final line throws (mid-file corruption fails loud).
 */
export function parseBoardRecords(text: string, label = 'board file'): BoardRecord[] {
  const records: BoardRecord[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.length === 0) continue
    try {
      records.push(JSON.parse(line) as BoardRecord)
    } catch (error) {
      if (index === lines.length - 1) break // trailing partial line: drop
      throw new Error(`${label}: malformed record on line ${index + 1} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return records
}

/** Read and parse every record in the board file. Missing file → empty list. */
export async function loadRecords(filePath: string): Promise<BoardRecord[]> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return parseBoardRecords(text, filePath)
}

/**
 * Append one record as a JSON line (mkdir -p the file's directory first).
 * Single-process assumption: the room boot fiber is the only writer per
 * room, so no locking is needed. A non-JSON-serializable record throws here
 * (fail loud at the emit site).
 */
export async function appendRecord(filePath: string, record: BoardRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, JSON.stringify(record) + '\n', 'utf8')
}
