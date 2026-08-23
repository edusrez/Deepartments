// dsh-deepartments — agent messaging store (spec 003 §3): the plugin-owned
// append-only message log `<stateDir>/messages.jsonl` plus the write-ahead
// delivery sidecar `<stateDir>/deliveries.jsonl` (§4.4). The store is the
// durable source of truth for everything ever sent: the send_message tool
// persists records HERE before any delivery (persist-before-deliver, D4).
//
// Wire format: one JSON record per line (JSONL), append-only (spec §3.1):
//   {id, seq, ts, from, to[], text, kind, threadId?, sensitive?}
//   - id = `m-<seq>`; seq = the GLOBAL contiguous counter (0-based): the
//     record's file index, the board-store central invariant (board-store.ts
//     :16-23); seeded at boot from the loaded file's last seq +1 (no gaps, no
//     reordering under the single-process one-writer assumption);
//   - ts = Date.now() at persist (epoch ms);
//   - from / to[] = durable MEMBER ids (postId / hostId — never session ids,
//     so from/to survive host rotation, §3.1);
//   - kind = 'agent' | 'notice' | 'ack' ("notice" producers are deferred to
//     B3 — B2's only producer, send_message, writes 'agent' or 'ack');
//   - threadId = optional reply-to record id; sensitive = optional flag.
//
// Persistence mirrors the board-store pattern (board-store.ts:161-396 — that
// module is superseded by this store, §7.1: the patterns are COPIED, not
// imported, and board-store.ts is left untouched until Batch B3):
//   - flush-on-append: mkdir (recursive) + appendFile of one serialized
//     record, AWAITED — the record is on disk before any delivery starts;
//     single-process assumption (one writer) → no locking, same as the board;
//   - load: missing file → empty; tolerant of a TRAILING partial line (a
//     mid-append crash drops it); a malformed NON-final line throws loud
//     (mid-file corruption fails loud);
//   - compaction: BOOT-ONLY (no runtime compact tool — a mid-process compact
//     cannot reseed the in-memory index; spec §3.2). Triggered when the
//     record count exceeds COMPACTION_LINE_THRESHOLD (2000) or the raw file
//     bytes exceed COMPACTION_BYTE_THRESHOLD (256 KiB) — the board-store
//     thresholds, unchanged. Keep-rule: keep a record when `from` ∪ any `to`
//     intersects the durable member ids (posts.json ∪ NON-RETIRED hosts.json,
//     best-effort like the board registry read). Renumber seq 0..N-1 in
//     original order and re-id `m-<newSeq>`; remap every kept record's
//     `threadId` through the old→new id map (a threadId whose target was
//     trimmed becomes null); write ONE pre-compaction backup copy
//     `messages.jsonl.bak` (spec §3.2 builder recommendation: the board store
//     does not back up — the message store does; the legacy-room rename stays
//     the other guaranteed backup, §8.2).
//
// Per-recipient seq index (§3.3) — built at boot, maintained by append:
//   recipientSeqs: Map<recipientId, number[]>   // ascending own seqs
// (one entry per recorded message with that recipient ∈ to[]; ascending
// because the file is append-only). `page()` resolves the `before` cursor (a
// `m-<seq>` id, EXCLUSIVE) via binary search (O(log n)) and slices the page
// (O(1)); `remaining` = index.length − (startPos + pageLen) = EXACTLY the
// recipient's own records older than the page — sparse-subset correct (the
// naive `total − (seqLo + pageLen)` is wrong because own seqs are a sparse
// subset of the global seq, §5).
// Cursor clamp rule (§3.2): a `before` id MISSING from the store (renumbered
// by a compaction) clamps to the newest record — the cursor resolves to the
// newest record's seq (exclusive), so the page restarts from the newest
// boundary instead of erroring; the history is still valid, only the cursor
// was renumbered (the consumer documents this in the tool render text).
//
// The delivery sidecar (§4.4) is a separate append-only JSONL file of rows
// {messageId, recipientId, status, ts}: send_message appends 'prepared'
// BEFORE delivering (write-ahead) and the final status ('delivered' |
// 'resumed' | 'failed' | 'self') after; boot re-delivery consults the LATEST
// row per (messageId, recipientId) — 'delivered'/'resumed' are skipped,
// 'prepared' (crash between persist and delivery / mid-fan-out) and 'failed'
// are re-run. One row per transition (rows are never edited in place — the
// store is append-only); `compactDeliveryRows` keeps only the latest row per
// key for the sidecar's own boot compaction (spec §4.4 builder-verify point).
//
// NO export default (pitfall 0001 — breaks `inject`).
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Record types (spec §3.1) + sidecar types (spec §4.4).
// ---------------------------------------------------------------------------

/** Payload typology of a record (spec §3.1). */
export type MessageKind = 'agent' | 'notice' | 'ack'

/** One addressed message record — the single wire shape of messages.jsonl. */
export interface MessageRecord {
  id: string
  seq: number
  ts: number
  from: string
  to: string[]
  text: string
  kind: MessageKind
  threadId?: string | null
  sensitive?: boolean
}

/** The append input: everything the caller authors; id/seq/ts are assigned by the store. */
export interface MessageInput {
  from: string
  to: string[]
  text: string
  kind?: MessageKind
  threadId?: string | null
  sensitive?: boolean
}

/** Delivery lifecycle of one (messageId, recipientId) pair (§4.1/§4.4). */
export type DeliveryStatus = 'prepared' | 'delivered' | 'resumed' | 'failed' | 'self'

/** One sidecar row: one delivery transition (append-only, §4.4). */
export interface DeliveryRow {
  messageId: string
  recipientId: string
  status: DeliveryStatus
  ts: number
}

/** Page request: `limit` (default 10, defensively capped at 50) + optional exclusive id cursor. */
export interface PageOptions {
  limit: number
  before?: string
}

/** Page response (spec §5): own records newest-first + the exact older-record count. */
export interface PageResult {
  total: number
  messages: MessageRecord[]
  remaining: number
}

// ---------------------------------------------------------------------------
// Paths + parse/append (mirror board-store.ts:161-222, copied not imported).
// ---------------------------------------------------------------------------

export const MESSAGE_FILE = 'messages.jsonl'
export const DELIVERIES_FILE = 'deliveries.jsonl'

/** Message file location: `<stateDir>/messages.jsonl` (spec §3.2). */
export function resolveMessagesPath(stateDir: string): string {
  return path.join(stateDir, MESSAGE_FILE)
}

/** Delivery sidecar location: `<stateDir>/deliveries.jsonl` (spec §4.4). */
export function resolveDeliveriesPath(stateDir: string): string {
  return path.join(stateDir, DELIVERIES_FILE)
}

/**
 * Pure parse of JSONL message text. Tolerant of a trailing partial line (a
 * crash mid-append): a final line that fails to parse is dropped. A malformed
 * NON-final line throws (mid-file corruption fails loud) — and so does any
 * line that parses as JSON but is NOT a message record shape (a full line of
 * wrong shape cannot come from a partial write).
 */
export function parseMessageRecords(text: string, label = 'messages file'): MessageRecord[] {
  const records: MessageRecord[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      if (index === lines.length - 1) break // trailing partial line: drop
      throw new Error(`${label}: malformed record on line ${index + 1} (${error instanceof Error ? error.message : String(error)})`)
    }
    if (!isMessageShape(parsed)) {
      throw new Error(`${label}: malformed record on line ${index + 1} (not a message record shape)`)
    }
    records.push(parsed)
  }
  return records
}

function isMessageShape(value: unknown): value is MessageRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' &&
    typeof record.seq === 'number' &&
    typeof record.ts === 'number' &&
    typeof record.from === 'string' &&
    Array.isArray(record.to) &&
    typeof record.text === 'string' &&
    typeof record.kind === 'string'
}

/** Read the raw message-file text; a missing file → empty string. */
async function loadMessagesText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Read and parse every record in the message file. Missing file → empty list. */
export async function loadMessageRecords(filePath: string): Promise<MessageRecord[]> {
  return parseMessageRecords(await loadMessagesText(filePath), filePath)
}

/**
 * Append one record as a JSON line (mkdir -p the file's directory first).
 * Single-process assumption (one writer) → no locking, same as the board.
 * A non-JSON-serializable record throws here (fail loud at the emit site).
 */
export async function appendMessageRecord(filePath: string, record: MessageRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, JSON.stringify(record) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Compaction (spec §3.2): BOOT-ONLY rewrite with a pre-compaction .bak copy.
// ---------------------------------------------------------------------------

/** Records above which messages.jsonl is compacted at boot (board-store threshold, spec §3.2). */
export const COMPACTION_LINE_THRESHOLD = 2000

/** Raw file bytes above which messages.jsonl is compacted at boot (board-store threshold, spec §3.2). */
export const COMPACTION_BYTE_THRESHOLD = 256 * 1024

/**
 * Pure trigger predicate: compact when the record count OR the raw file
 * byte-length exceeds its threshold (`Buffer.byteLength` matches the on-disk
 * size).
 */
export function shouldCompact(records: readonly MessageRecord[], text: string): boolean {
  return records.length > COMPACTION_LINE_THRESHOLD ||
    Buffer.byteLength(text, 'utf8') > COMPACTION_BYTE_THRESHOLD
}

/**
 * Pure compaction: keep the records `keepFn` admits, renumber seq 0..N-1 in
 * ORIGINAL file order (deterministic), re-id `m-<newSeq>`, and remap every
 * kept record's `threadId` through the old→new id map: a threadId targeting a
 * KEPT record becomes the target's NEW id; a threadId whose target was
 * trimmed — or that does not resolve — becomes null (spec §3.2).
 */
export function compactMessages(
  records: readonly MessageRecord[],
  keepFn: (record: MessageRecord) => boolean
): MessageRecord[] {
  const kept: MessageRecord[] = []
  for (const record of records) if (keepFn(record)) kept.push(record)
  const oldToNew = new Map<string, string>()
  kept.forEach((record, index) => oldToNew.set(record.id, `m-${index}`))
  return kept.map((record, index) => {
    const next: MessageRecord = {
      id: `m-${index}`,
      seq: index,
      ts: record.ts,
      from: record.from,
      to: [...record.to],
      text: record.text,
      kind: record.kind
    }
    if (record.sensitive === true) next.sensitive = true
    if (typeof record.threadId === 'string') {
      next.threadId = oldToNew.get(record.threadId) ?? null
    } else if (record.threadId === null) {
      next.threadId = null
    }
    return next
  })
}

/**
 * The durable member ids for the compaction keep-rule (spec §3.2): the keys
 * of `<stateDir>/posts.json` (every registered post — posts.json holds only
 * live posts; retired workers are unregistered at retire) unioned with the
 * keys of `<stateDir>/hosts.json` EXCLUDING retired host entries (rotated
 * identities stay in the file as evidence but are no longer addressable
 * members — §3.1 note). Best-effort: a missing (ENOENT) or malformed
 * registry contributes an empty set — same resilience as the board store's
 * `durableMemberIds` (board-store.ts:346-373).
 */
export async function loadMemberIds(stateDir: string): Promise<Set<string>> {
  const ids = new Set<string>()
  await absorbRegistry(path.join(stateDir, 'posts.json'), ids, false)
  await absorbRegistry(path.join(stateDir, 'hosts.json'), ids, true)
  return ids
}

async function absorbRegistry(filePath: string, ids: Set<string>, skipRetired: boolean): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return // ENOENT or malformed: best-effort, must never block compaction
  }
  if (typeof parsed !== 'object' || parsed === null) return
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (skipRetired && typeof entry === 'object' && entry !== null && (entry as { retired?: unknown }).retired === true) continue
    ids.add(key)
  }
}

/**
 * Compaction driver (spec §3.2): apply the keep-rule, rewrite the message file
 * renumbered+re-id'd, with ONE pre-compaction backup copy (`messages.jsonl.bak`
 * — the spec's builder recommendation for the message store). Boot-only (see
 * header semantics): a mid-process compact cannot reseed the in-memory index.
 * The backup is written FIRST and strictly: if it fails the original file is
 * still intact (nothing has been rewritten yet) and the call throws. Returns
 * the record count before → after (for logging).
 */
export async function compactMessagesFile(
  filePath: string,
  records: readonly MessageRecord[],
  keepFn: (record: MessageRecord) => boolean
): Promise<{ before: number; after: number }> {
  const compacted = compactMessages(records, keepFn)
  const raw = await readFile(filePath, 'utf8') // the file exists (it was just parsed); fail loud otherwise
  await writeFile(`${filePath}.bak`, raw, 'utf8')
  const text = compacted.map((record) => JSON.stringify(record)).join('\n') + '\n'
  await writeFile(filePath, text, 'utf8')
  return { before: records.length, after: compacted.length }
}

// ---------------------------------------------------------------------------
// The in-memory store: boot load (+ compaction), append, per-recipient paging.
// ---------------------------------------------------------------------------

/**
 * The message store: index + paging over `<stateDir>/messages.jsonl`.
 * Boot via `open()` (load + compact + index); the ONLY writer is `append()`
 * (single-process; no locking — same contract as the board store).
 */
export class MessagesStore {
  private readonly filePath: string
  private records: MessageRecord[] = []
  private readonly byId = new Map<string, MessageRecord>()
  /** §3.3: recipientId → ascending own seqs (insertion order — file is append-only). */
  private readonly recipientSeqs = new Map<string, number[]>()
  private nextSeq = 0

  private constructor(filePath: string) {
    this.filePath = filePath
  }

  /**
   * Boot entry (spec §3.2/§3.3): load `<stateDir>/messages.jsonl`, compact it
   * if it exceeds the thresholds (with a pre-compaction .bak copy), then build
   * the per-recipient index and seed the append counter from the last seq +1.
   * Missing file → empty store. A malformed non-final line throws loud; a
   * trailing partial line (crash mid-append) is dropped.
   */
  static async open(stateDir: string): Promise<MessagesStore> {
    const filePath = resolveMessagesPath(stateDir)
    const text = await loadMessagesText(filePath)
    let records = parseMessageRecords(text, filePath)
    if (shouldCompact(records, text)) {
      const memberIds = await loadMemberIds(stateDir)
      // Defensive keep-rule: with an EMPTY durable member set (no registries
      // yet) nothing can be judged a ghost — keep everything. Compaction is
      // defensive only; it must never wipe a live history (spec §3.2).
      const keepFn = memberIds.size === 0
        ? (): boolean => true
        : (record: MessageRecord): boolean => memberIds.has(record.from) || record.to.some((recipient) => memberIds.has(recipient))
      await compactMessagesFile(filePath, records, keepFn)
      records = await loadMessageRecords(filePath) // re-index from the REWRITTEN file (disk is the truth)
    }
    const store = new MessagesStore(filePath)
    store.load(records)
    return store
  }

  /** Total records in the store (the global log length). */
  get size(): number {
    return this.records.length
  }

  /** The record with this id, or undefined. Treat as read-only. */
  get(id: string): MessageRecord | undefined {
    return this.byId.get(id)
  }

  /** A recipient's own seqs (defensive copy, ascending). For tests/tools. */
  seqsFor(recipientId: string): number[] {
    return [...(this.recipientSeqs.get(recipientId) ?? [])]
  }

  /**
   * Append one record (the ONLY producer — send_message calls this BEFORE any
   * delivery; spec §3.1/§4.3). id/seq/ts are assigned here; the record is
   * flushed to disk AWAITED before the in-memory index updates, so a crash
   * after this call returns leaves the record on disk (re-indexed at boot).
   */
  async append(input: MessageInput): Promise<MessageRecord> {
    this.validateInput(input)
    const seq = this.nextSeq
    const record: MessageRecord = {
      id: `m-${seq}`,
      seq,
      ts: Date.now(),
      from: input.from,
      to: [...input.to],
      text: input.text,
      kind: input.kind ?? 'agent'
    }
    if (input.threadId !== undefined && input.threadId !== null) record.threadId = input.threadId
    if (input.sensitive === true) record.sensitive = true
    await appendMessageRecord(this.filePath, record) // durable first (persist-before-deliver)
    this.nextSeq = seq + 1
    this.records.push(record)
    this.byId.set(record.id, record)
    for (const recipient of record.to) {
      let own = this.recipientSeqs.get(recipient)
      if (own === undefined) {
        own = []
        this.recipientSeqs.set(recipient, own)
      }
      own.push(record.seq)
    }
    return record
  }

  /**
   * Page the recipient's OWN received history (records where recipient ∈
   * to[]), newest-first (spec §5). `before` is a `m-<seq>` id cursor,
   * EXCLUSIVE (records STRICTLY older than the cursor). The page boundary is
   * O(log n) (binary search on the per-recipient index) + O(1) slice;
   * `remaining` is the EXACT count of the recipient's own records older than
   * the page (sparse-subset-correct — §5). A `before` id missing from the
   * store (renumbered by a compaction) clamps to the newest record (§3.2).
   */
  page(recipientId: string, opts: PageOptions): PageResult {
    const index = this.recipientSeqs.get(recipientId) ?? []
    const total = index.length
    const limit = normalizeLimit(opts.limit)
    let hi = index.length
    if (opts.before !== undefined) {
      const cursor = this.byId.get(opts.before)
      // Clamp rule (§3.2): an unresolvable cursor (post-compaction renumber)
      // resolves to the newest record (exclusive) — page restarts from there.
      hi = cursor !== undefined ? lowerBound(index, cursor.seq) : lowerBound(index, index.length > 0 ? index[index.length - 1] : -1)
    }
    const lo = Math.max(0, hi - limit)
    const window = index.slice(lo, hi) // ascending window; newest = last
    const messages: MessageRecord[] = []
    for (let i = window.length - 1; i >= 0; i--) {
      const record = this.byId.get(`m-${window[i]}`)
      // Defensive copy: callers must not mutate the store's index state.
      if (record !== undefined) messages.push({ ...record, to: [...record.to] })
    }
    // §5: remaining = index.length - (startPos + pageLen) where startPos = own
    // records NEWER than the page window (total - hi).
    const startPos = total - hi
    const remaining = Math.max(0, total - startPos - messages.length)
    return { total, messages, remaining }
  }

  private load(records: MessageRecord[]): void {
    this.records = records
    // Seed the append counter from the LOADED file's last seq +1 (spec §3.1):
    // a record whose append crashed mid-write is not on disk and is re-issued
    // with the SAME seq — no gaps, no reordering.
    this.nextSeq = records.length > 0 ? records[records.length - 1].seq + 1 : 0
    for (const record of records) {
      this.byId.set(record.id, record)
      for (const recipient of record.to) {
        let own = this.recipientSeqs.get(recipient)
        if (own === undefined) {
          own = []
          this.recipientSeqs.set(recipient, own)
        }
        own.push(record.seq)
      }
    }
  }

  private validateInput(input: MessageInput): void {
    if (typeof input.from !== 'string' || input.from.length === 0) {
      throw new TypeError('messages-store: `from` must be a non-empty member id')
    }
    if (!Array.isArray(input.to) || input.to.length === 0) {
      throw new TypeError('messages-store: `to` must be a non-empty array of member ids')
    }
    if (typeof input.text !== 'string') {
      throw new TypeError('messages-store: `text` must be a string')
    }
    if (input.kind !== undefined && input.kind !== 'agent' && input.kind !== 'notice' && input.kind !== 'ack') {
      throw new TypeError(`messages-store: unknown kind ${String(input.kind)}`)
    }
  }
}

/** Defensive limit normalization: positive integer, capped at 50 (the tool schema's max). */
function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return 10
  return Math.min(limit, 50)
}

/** First index whose seq is >= target (ascending array). */
function lowerBound(seqs: readonly number[], target: number): number {
  let lo = 0
  let hi = seqs.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (seqs[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ---------------------------------------------------------------------------
// Delivery sidecar (spec §4.4): write-ahead JSONL, one row per transition.
// ---------------------------------------------------------------------------

/** Pure parse of sidecar JSONL text (same tolerance rules as the message file). */
export function parseDeliveryRows(text: string, label = 'deliveries file'): DeliveryRow[] {
  const rows: DeliveryRow[] = []
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
    if (!isDeliveryRowShape(parsed)) {
      throw new Error(`${label}: malformed row on line ${index + 1} (not a delivery row shape)`)
    }
    rows.push(parsed)
  }
  return rows
}

function isDeliveryRowShape(value: unknown): value is DeliveryRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.messageId === 'string' &&
    typeof row.recipientId === 'string' &&
    typeof row.status === 'string' &&
    typeof row.ts === 'number'
}

/**
 * Append one delivery-transition row (mkdir + appendFile, awaited). Called by
 * send_message as 'prepared' BEFORE any delivery and with the final status
 * ('delivered' | 'resumed' | 'failed' | 'self') AFTER (spec §4.4 — the
 * write-ahead makes boot re-delivery idempotent).
 */
export async function markDelivery(
  stateDir: string,
  messageId: string,
  recipientId: string,
  status: DeliveryStatus,
  ts: number = Date.now()
): Promise<DeliveryRow> {
  const row: DeliveryRow = { messageId, recipientId, status, ts }
  const filePath = resolveDeliveriesPath(stateDir)
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, JSON.stringify(row) + '\n', 'utf8')
  return row
}

/**
 * The LATEST delivery status of one (messageId, recipientId) pair (rows are
 * append-ordered — the last matching row wins) or null when no row exists.
 * Read from disk on every call (tolerant of a trailing partial row); the
 * sidecar is small and this path is not hot.
 */
export async function deliveryStatus(stateDir: string, messageId: string, recipientId: string): Promise<DeliveryStatus | null> {
  let text: string
  try {
    text = await readFile(resolveDeliveriesPath(stateDir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let latest: DeliveryStatus | null = null
  for (const row of parseDeliveryRows(text)) {
    if (row.messageId === messageId && row.recipientId === recipientId) latest = row.status
  }
  return latest
}

/**
 * Idempotent re-delivery predicate (spec §4.4): true when the pair must be
 * (re-)delivered — no row yet, or the last transition was 'prepared' (crash
 * between persist and delivery / mid-fan-out) or 'failed' (never delivered);
 * false when the pair is settled — 'delivered'/'resumed' → skip, 'self' →
 * held by design (no wake, ack-loop guard).
 */
export function needsRedelivery(status: DeliveryStatus | null): boolean {
  return status === null || status === 'prepared' || status === 'failed'
}

/**
 * Sidecar boot compaction (spec §4.4 builder-verify): keep ONLY the latest
 * row per (messageId, recipientId), preserving the file order of the kept
 * rows. Pure — the (future) sidecar boot driver rewrites
 * `<stateDir>/deliveries.jsonl` with the result once it grows past a
 * threshold.
 */
export function compactDeliveryRows(rows: readonly DeliveryRow[]): DeliveryRow[] {
  const latestIndex = new Map<string, number>()
  for (let i = 0; i < rows.length; i++) latestIndex.set(deliveryKey(rows[i]), i)
  const result: DeliveryRow[] = []
  for (let i = 0; i < rows.length; i++) {
    if (latestIndex.get(deliveryKey(rows[i])) === i) result.push(rows[i])
  }
  return result
}

function deliveryKey(row: Pick<DeliveryRow, 'messageId' | 'recipientId'>): string {
  return `${row.messageId}\u0000${row.recipientId}`
}
