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
// ────────────────────────────────────────────────────────────────────────────
// COMPACTION (Batch F) — semantics.
// The board file grows without bound (every emit appends) and — because board
// seq == record index — the ONLY ordering source the read model uses. Batch F
// adds a BOOT-ONLY compaction pass (src/org.ts): when a room's raw board file
// exceeds COMPACTION_LINE_THRESHOLD records or COMPACTION_BYTE_THRESHOLD bytes,
// it is rewritten keeping only records a fresh reader still needs (a single
// ready seed + messages between two registered members; everything else
// dropped), renumbering seq 0..N-1 and re-deriving ids from the new seq, and
// resetting that room's read cursors to the FRESH state (D3/D4/D5). Up next,
// the O(1) emit counter (D6, src/invoke.ts) removes the per-emit full-file
// re-read that made total writes O(n²) (audit finding H2).
//
// Compaction NEVER runs mid-conversation: the live room session projection is
// seeded from the board file at boot and is NOT re-seedable mid-process (the
// Session is append-only; SessionStore.create throws on a duplicate live id
// and there is no public remove). Compaction therefore runs only inside the
// room-boot effect, BEFORE the session is seeded, so the in-memory read model
// is rebuilt from the compacted, renumbered file. A mid-process compact cannot
// reseed the projection, so NO runtime `dept_compact` tool exists (by design).
//
// Sequence-source consistency: after a boot compaction renumbers the file, the
// invoke counter (seedNextSeq, src/invoke.ts) lazily re-reads that SAME
// post-boot file on its first emit and seeds from it, so the counter and the
// file always agree (both originate from the same post-boot bytes). Because
// compaction resets every member's cursor to fresh, it is an explicit, RARE,
// ROOM-WIDE reset of read progress (members re-read the small kept set once) —
// never a continuous process.
//
// NO export default (pitfall 0001 — breaks `inject`).
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
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
  /**
   * Optional pure-acknowledgement flag (Batch C): set true when the message is
   * a content-free confirmation/receipt (no new substance). The wake relay uses
   * it to suppress confirmation ping-pong — a content-free ack addressed back
   * to its sender no longer re-wakes the other party past the ack-loop budget.
   */
  ack?: boolean
  /**
   * Optional SENSITIVE flag (Batch E, sender-trust): set true when the sender
   * marks the message sensitive/mission-critical via dept_room_write
   * `sensitive:true`. Recipients surface it in the read delta so they can see
   * a message was flagged sensitive by its sender. It is a MODEL-FACING
   * TRUST SIGNAL ONLY — a PRAGMATIC sender-verification marker, NOT a
   * cryptographic signature or an enforcement block. See the honest trust
   * bound documented in src/invoke.ts.
   */
  sensitive?: boolean
  /**
   * Optional sender-verification flag (Batch E): present only when
   * `sensitive` is set; TRUE iff the recorded sender (`from`) resolved to a
   * live registry entry at emit time — a registered post, or a registered
   * host whose agent session is live. It tells a recipient that the message
   * came from a registry-verified board member, but it does NOT prove the
   * content's authenticity beyond that registry admission (trust bound).
   */
  senderVerified?: boolean
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
 * Read the raw board file text; a missing file → empty string. Used by the org
 * boot path to evaluate `shouldCompact` (byte threshold) without a double
 * read (the same text is then `parseBoardRecords`'d for the seed).
 */
export async function loadBoardText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
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

// ---------------------------------------------------------------------------
// Compaction (Batch F): boot-only board rewrite + cursor reset. See the header
// comment for the full semantics (renumbering, re-id, cursor reset, boot-only).
// ---------------------------------------------------------------------------

/**
 * Number of records above which a room's board file is compacted at boot.
 * MUST stay in sync with the "Line" branch of `shouldCompact` below and with
 * the org boot trigger (src/org.ts). Tuned so the default test fixtures (tiny
 * boards) never reach it.
 */
export const COMPACTION_LINE_THRESHOLD = 2000

/**
 * Raw file bytes above which a room's board file is compacted at boot. MUST
 * stay in sync with the "Bytes" branch of `shouldCompact`. The default test
 * fixtures stay far below it.
 */
export const COMPACTION_BYTE_THRESHOLD = 256 * 1024

/**
 * Pure trigger predicate: compact when the record count OR the raw file
 * byte-length exceeds its threshold. `text` is the raw board file text so the
 * byte-length check reflects the on-disk size (`Buffer.byteLength`).
 */
export function shouldCompact(records: readonly BoardRecord[], text: string): boolean {
  return records.length > COMPACTION_LINE_THRESHOLD ||
    Buffer.byteLength(text, 'utf8') > COMPACTION_BYTE_THRESHOLD
}

/**
 * Re-derive a kept record's `id` from its NEW seq (D4), so post-compaction ids
 * stay unique against future emits (`m-${roomId}-${newSeq}` can never collide).
 * Only ids matching `/^(m-|ready-|agenda-)/` are rewritten as
 * `<prefix><roomId>-<newSeq>`; an opaque id that does not match is left
 * unchanged (it stays unique). Example: `m-board-87` → `m-board-0`.
 */
export function reIdForSeq(id: string, roomId: string, newSeq: number): string {
  const match = /^(m-|ready-|agenda-)/.exec(id)
  if (match === null) return id
  return `${match[1]}${roomId}-${newSeq}`
}

/**
 * Disk shape of one member's cursor in `<stateDir>/cursors.json`
 * (`lastMessageId` is `null` when fresh — the wire mirror of invoke.ts's
 * in-memory `CursorState`, which uses `undefined`).
 */
interface PersistedCursor {
  lastMessageId: string | null
  lastMessageSeq: number
  lastAgendaSeq: number
}

/**
 * The disk cursor shape for a fresh (never-seen) history — what a reset writes.
 */
const FRESH_CURSOR: PersistedCursor = { lastMessageId: null, lastMessageSeq: -1, lastAgendaSeq: -1 }

/**
 * Pure compaction: filter to the records a fresh reader still needs, renumber
 * seq 0..N-1 in ORIGINAL file order (deterministic), and re-id from the new seq.
 *
 * Keep-rule (D3): a `ready` record is kept only ONCE per room (the FIRST ready
 * in the file; duplicate re-emitted ready noise is dropped); a `message` record
 * is kept only when `keepFn(record)` is true (built by the caller from the
 * durable+static registered-member set — D2/D7); everything else (agenda,
 * ghost-sender messages, messages addressed only to ghosts) is dropped. This
 * is consistent with the fold, which ignores `kind:'ready'` and for which
 * agenda only affects dropped agenda records.
 */
export function compactRecords(
  records: readonly BoardRecord[],
  keepFn: (record: BoardRecord) => boolean,
  roomId: string
): BoardRecord[] {
  const kept: BoardRecord[] = []
  let readySeen = false
  for (const record of records) {
    if (record.kind === 'ready') {
      if (readySeen) continue // drop duplicate ready noise (D3)
      readySeen = true
      kept.push(record)
      continue
    }
    if (keepFn(record)) kept.push(record)
  }
  return kept.map((record, index) => ({
    ...record,
    seq: index,
    id: reIdForSeq(record.id, roomId, index)
  }))
}

/**
 * Durable cursor reset (D5): rewrite `<stateDir>/cursors.json` setting every
 * key with prefix `${roomId}:` to the FRESH state (`{ lastMessageId: null,
 * lastMessageSeq: -1, lastAgendaSeq: -1 }`), preserving all other rooms' keys.
 * Missing file → no-op. `mkdir -p` the directory before writing.
 */
export async function resetRoomCursorsFile(cursorsPath: string, roomId: string): Promise<void> {
  let parsed: Record<string, PersistedCursor> = {}
  try {
    parsed = JSON.parse(await readFile(cursorsPath, 'utf8')) as Record<string, PersistedCursor>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // nothing to reset
    throw error
  }
  const prefix = `${roomId}:`
  let changed = false
  for (const key of Object.keys(parsed)) {
    if (key.startsWith(prefix)) {
      parsed[key] = { ...FRESH_CURSOR }
      changed = true
    }
  }
  if (!changed) return
  await mkdir(path.dirname(cursorsPath), { recursive: true })
  await writeFile(cursorsPath, JSON.stringify(parsed, null, 2), 'utf8')
}

/**
 * Registered (durable ∪ static) member ids for the compaction keep-rule (D3):
 * the keys of `<stateDir>/posts.json` and `<stateDir>/hosts.json` (durable
 * registered ids) unioned with every configured room's `members` (static).
 * Best-effort: a missing registry file (ENOENT) contributes an empty set;
 * static config members still apply.
 */
export async function durableMemberIds(
  stateDir: string,
  config: { org: { rooms: { members: string[] }[] } }
): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const room of config.org.rooms) {
    for (const member of room.members) ids.add(member)
  }
  // Best-effort durable registries: a missing or unreadable registry must not
  // block compaction — the keep-rule just falls back to static members.
  for (const file of ['posts.json', 'hosts.json']) {
    try {
      const parsed = JSON.parse(await readFile(path.join(stateDir, file), 'utf8')) as Record<string, unknown>
      for (const key of Object.keys(parsed)) ids.add(key)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      // A malformed registry is treated as best-effort empty (same resilience).
      continue
    }
  }
  return ids
}

/**
 * Compaction driver (D1/D2/D4/D5): apply the keep-rule, rewrite the board file
 * renumbered+re-id'd, then reset the affected room's cursors in
 * `<stateDir>/cursors.json` (derived from the board path). Returns the record
 * count before → after (for logging). Boot-only (see header semantics).
 */
export async function compactBoardFile(
  filePath: string,
  records: readonly BoardRecord[],
  keepFn: (record: BoardRecord) => boolean,
  roomId: string
): Promise<{ before: number; after: number }> {
  const compacted = compactRecords(records, keepFn, roomId)
  const text = compacted.map((record) => JSON.stringify(record)).join('\n') + '\n'
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, text, 'utf8')
  // The board path is `<stateDir>/rooms/<roomId>/board.jsonl` (see
  // resolveBoardPath); walk up three dirs to recover `<stateDir>`.
  const stateDir = path.dirname(path.dirname(path.dirname(filePath)))
  await resetRoomCursorsFile(path.join(stateDir, 'cursors.json'), roomId)
  return { before: records.length, after: compacted.length }
}
