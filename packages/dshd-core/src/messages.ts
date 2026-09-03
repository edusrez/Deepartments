// dsh-deepartments — agent messaging store + redelivery guard (spec 003 §3/§4.4).
//
// THIS module OWNS the bus STORE and the redelivery GUARD carved out of the
// invoke.ts monolith (FASE 2 STEP b). It is the SINGLE source of:
//   - the append-only message log `<stateDir>/messages.jsonl` (§3.1/§3.2):
//     schema, append semantics, per-recipient paging index, and the BOOT-only
//     compaction (thresholds `COMPACTION_BYTE_THRESHOLD`=256 KiB +
//     `COMPACTION_LINE_THRESHOLD`=2000, the keep-set / `loadMemberIds`, the
//     `shouldCompact` + open-compaction driver) — byte-IDENTICAL to the
//     pre-extraction on-disk format (R6);
//   - the write-ahead delivery sidecar `<stateDir>/deliveries.jsonl` (§4.4):
//     `markDelivery` 'prepared'→final and the `needsRedelivery` predicate
//     (null/prepared/failed → redelivery; delivered/resumed/self/terminal →
//     settled);
//   - the BOOT redelivery DRIVER (`DeliveryRedeliverer`): the sidecar boot
//     compaction, the `latestPerPair` dedupe, and the dead-recipient
//     `terminal`-una-vez settlement (W7-A) — including the C8′ extension that
//     settles a NON-CATALOG (finished subagent-child) recipient ONCE.
//
// Wire format: one JSON record per line (JSONL), append-only (spec §3.1):
//   {id, seq, ts, from, to[], text, kind, threadId?, sensitive?}
//   - id = `m-<seq>`; seq = the GLOBAL contiguous counter (0-based): the
//     record's file index, the board-store central invariant (board-store.ts
//     :16-23); seeded at boot from the loaded file's MAX seq +1 (fb-68 B1 —
//     concurrent O_APPEND flushes can land out of order, so a last-line seed
//     could re-mint; max-seq never does — no gaps, no reordering under the
//     single-process one-writer assumption); the append advances the counter
//     BEFORE its awaited flush so the in-process id-mint is atomic (fb-68 B1);
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
// 'resumed' | 'failed' | 'self' | 'terminal') after; boot re-delivery consults
// the LATEST row per (messageId, recipientId) — 'delivered'/'resumed'/
// 'terminal' are skipped, 'prepared' (crash between persist and delivery /
// mid-fan-out) and 'failed' are re-run. 'terminal' is the SETTLED death-mark of
// a delivery pair whose recipient is no longer a live catalog member (a
// removed/closed/retired session — W7-A): it is never re-delivered and the
// W6 health scan ignores it, so a dead recipient is not re-attempted at every
// boot (which spawned fresh 'failed' rows and a re-alert every boot). One row
// per transition (rows are never edited in place — the store is append-only);
// `compactDeliveryRows` keeps only the latest row per key for the sidecar's own
// boot compaction (spec §4.4 builder-verify point).
//
// THE ID-STABLE CONTRACT (ALTO-1 — QD audit 2026-08-28, F1): `messageId` in
// deliveries.jsonl is a STABLE key — it ALWAYS denotes the CURRENT record in
// messages.jsonl. Guaranteed by the compaction pass: `compactMessagesFile`
// remaps/prunes the sidecar IN THE SAME PASS it rewrites the message file
// (`remapDeliveryRows` through the run's old→new id map — surviving ids are
// remapped, a row whose record was TRIMMED is dropped, because keeping it
// under a re-used id would contaminate every correlation by messageId and
// every (messageId, recipientId) settle). Consumers — the boot re-delivery
// driver, the PR-2 settles (lifecycle.ts / invoke.ts), the W6 health scan, the
// health alerts — read the STABLE key and additionally cross-check the current
// record (a row whose id has no record, or whose record never addressed the
// recipient, is a stale pre-fix row → never driven, never settled).
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

/** Delivery lifecycle of one (messageId, recipientId) pair (§4.1/§4.4).
 * `terminal` is the SETTLED death-mark appended by the boot re-delivery driver
 * when the recipient is no longer a live catalog member (W7-A): it is never
 * re-delivered and the W6 health scan ignores it (see `needsRedelivery`). */
export type DeliveryStatus = 'prepared' | 'delivered' | 'resumed' | 'failed' | 'self' | 'terminal'

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

/** Records above which messages.jsonl is compacted at boot (spec §3.2). */
export const COMPACTION_LINE_THRESHOLD = 2000

/** Raw file bytes above which messages.jsonl is compacted at boot (spec §3.2). */
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
 * Pure old→new id map of ONE compaction run (spec §3.2 + the ALTO-1 id-STABLE
 * contract): for every KEPT record, the old `m-<seq>` id → the NEW
 * `m-<index>` id (0..N-1 in original file order). This single table is what
 * the compaction applies to every consumer that references record ids — a kept
 * record's `threadId` (`compactMessages`) and, IN THE SAME PASS, the delivery
 * sidecar rows (`remapDeliveryRows` via `compactMessagesFile`) — so after a
 * pass no id-based reference can point at a different record.
 */
export function compactionIdMap(
  records: readonly MessageRecord[],
  keepFn: (record: MessageRecord) => boolean
): Map<string, string> {
  const oldToNew = new Map<string, string>()
  let index = 0
  for (const record of records) {
    if (keepFn(record)) {
      oldToNew.set(record.id, `m-${index}`)
      index++
    }
  }
  return oldToNew
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
  const oldToNew = compactionIdMap(records, keepFn)
  const kept: MessageRecord[] = []
  for (const record of records) if (keepFn(record)) kept.push(record)
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
 * registry contributes an empty set.
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
 * Pure delivery-sidecar remap/prune of ONE compaction run (ALTO-1 — the
 * id-STABLE contract, spec §4.4): remap every row's `messageId` through the
 * run's old→new map (`compactionIdMap`), preserving file order, and DROP every
 * row whose `messageId` is ABSENT from the map — its record was TRIMMED by the
 * compaction, so its delivery trace is stale: keeping it under a RE-USED id
 * would make the row collide with the current record's rows (the
 * pre-fix production sidecar: 89.8% of 1901 rows referenced a renumbered id).
 * A keep-all run (no registry — the defensive keep-rule) maps every id onto
 * itself, so no row is pruned and ids are unchanged.
 */
export function remapDeliveryRows(
  rows: readonly DeliveryRow[],
  oldToNew: ReadonlyMap<string, string>
): DeliveryRow[] {
  const result: DeliveryRow[] = []
  for (const row of rows) {
    const nextId = oldToNew.get(row.messageId)
    if (nextId === undefined) continue // the record was trimmed → prune its trace
    result.push(nextId === row.messageId ? row : { ...row, messageId: nextId })
  }
  return result
}

/**
 * The SAME-PASS sidecar rewrite (ALTO-1): after the message file is
 * compacted+renumbered, the sibling `<stateDir>/deliveries.jsonl` is rewritten
 * with `remapDeliveryRows` — surviving ids remapped to their NEW id, trimmed
 * records' rows pruned — so the sidecar NEVER holds a row under a recycled id
 * (the id-STABLE contract; every consumer's messageId correlation stays
 * truthful). Backup-first, exactly like the message file: the pre-remap sidecar
 * is copied to `deliveries.jsonl.bak` BEFORE the rewrite (a failed backup
 * leaves the original intact and throws — the message file rewrite already
 * happened by then, but the sidecar was NOT touched, so the boot re-delivery
 * pass simply skips the stale rows as settled no-ops). A missing sidecar is a
 * clean no-op (nothing was ever delivered). A sidecar whose rows need NO change
 * is left untouched (no gratuitous rewrite — the file is only rewritten when a
 * remap or prune actually happened).
 */
async function remapDeliveriesSidecar(dir: string, oldToNew: ReadonlyMap<string, string>): Promise<void> {
  const deliveriesPath = path.join(dir, DELIVERIES_FILE)
  let text: string
  try {
    text = await readFile(deliveriesPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // nothing ever delivered
    throw error
  }
  const remapped = remapDeliveryRows(parseDeliveryRows(text), oldToNew)
  const nextText = remapped.map((row) => JSON.stringify(row)).join('\n') + '\n'
  if (nextText === text) return // no remap, no prune → leave the sidecar untouched
  await writeFile(`${deliveriesPath}.bak`, text, 'utf8')
  await writeFile(deliveriesPath, nextText, 'utf8')
}

/**
 * Compaction driver (spec §3.2 + ALTO-1): apply the keep-rule, rewrite the message file
 * renumbered+re-id'd, with ONE pre-compaction backup copy (`messages.jsonl.bak`
 * — the spec's builder recommendation for the message store), and — IN THE
 * SAME PASS — remap/prune the delivery sidecar (`deliveries.jsonl` in the same
 * directory) through the run's old→new map (`remapDeliveryRows`), so a
 * `messageId` in the sidecar always denotes the CURRENT record (the id-STABLE
 * contract). Boot-only (see header semantics): a mid-process compact cannot
 * reseed the in-memory index. The backup is written FIRST and strictly: if it
 * fails the original file is still intact (nothing has been rewritten yet) and
 * the call throws. Returns the record count before → after (for logging).
 */
export async function compactMessagesFile(
  filePath: string,
  records: readonly MessageRecord[],
  keepFn: (record: MessageRecord) => boolean
): Promise<{ before: number; after: number }> {
  const oldToNew = compactionIdMap(records, keepFn)
  const compacted = compactMessages(records, keepFn)
  const raw = await readFile(filePath, 'utf8') // the file exists (it was just parsed); fail loud otherwise
  await writeFile(`${filePath}.bak`, raw, 'utf8')
  const text = compacted.map((record) => JSON.stringify(record)).join('\n') + '\n'
  await writeFile(filePath, text, 'utf8')
  await remapDeliveriesSidecar(path.dirname(filePath), oldToNew)
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
   * the per-recipient index and seed the append counter from the max seq +1.
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
    // fb-68 B1: advance the counter IMMEDIATELY after reading it — BEFORE the
    // first await below. The sync stretch from here to the durable flush has
    // NO await, so two concurrent appends (two in-flight async chains, e.g.
    // overlapping daemon ticks or two live agents) can never read the same seq
    // (single-threaded): the id-mint is atomic in-process. Previously the
    // advance ran AFTER the awaited flush, so two in-flight appends both
    // minted `m-<seq>` (a duplicated id — the fb-61 DIAG reproduced 2x m-0).
    // A flush that throws now burns the seq (a gap, never a duplicate); the
    // boot seed (max-seq + 1, see `load()`) never re-mints an on-disk id.
    this.nextSeq = seq + 1
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
    // Seed the append counter from the LOADED file's MAX seq +1 (spec §3.1;
    // fb-68 B1 companion): the append now advances `nextSeq` BEFORE its
    // awaited flush, so two concurrent O_APPEND flushes can land OUT OF ORDER
    // on disk — a last-line seed could then RE-MINT an id that already exists
    // earlier in the file. Max-seq + 1 never re-mints; a record whose append
    // crashed mid-write is simply not on disk and its seq is re-issued (no
    // gaps, no reordering for the sequential boot-append path).
    this.nextSeq = records.reduce((max, record) => (record.seq > max ? record.seq : max), -1) + 1
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
 * held by design (no wake, ack-loop guard), 'terminal' → the recipient is a
 * dead/unknown catalog member that was settled once and is NEVER re-delivered
 * (W7-A).
 */
export function needsRedelivery(status: DeliveryStatus | null): boolean {
  return status === null || status === 'prepared' || status === 'failed'
}

// --- LANE ② (incident-delivery 2026-09-03) — REDELIVERY BACKOFF + MAX-ATTEMPTS
// (fb-79: the retry-storm class — m-183 = 450 attempts, m-188 = 226 — and the
// no-boot-only re-drive gap). The re-drive machinery below (the boot pass +
// the NEW non-boot sweep) shares these constants + the PURE helpers, so the
// cadence/storm math is testable in isolation. The attempt count is derived
// from the pair's OWN sidecar rows (`prepared`/`failed` transitions inside
// `RE_DELIVERY_STORM_WINDOW_MS`) — the sidecar IS the attempt ledger, so no
// extra state file is needed; the boot compaction collapse is the documented
// caveat (a compaction restarts the count — the sweep stays bounded, never a
// storm, because the backoff applies from the first attempt of the new count).
// ---------------------------------------------------------------------------

/** LANE ② — the bounded sweep cadence (default 60 s = ONE sweep per health
 * poll tick; the sweep re-drives ONLY the pairs whose per-pair backoff window
 * has elapsed, so a 60 s cadence can never become a retry storm). */
export const RE_DELIVERY_SWEEP_DEFAULT_INTERVAL_MS = 60_000

/** LANE ② — the exponential backoff BASE (15 s): attempt #1 is re-driven 15 s
 * after its failure, #2 after 30 s, #3 after 60 s, … — the m-183 7–14 s storm
 * cadence becomes ~7 attempts in the first hour (≤ 30/h alert threshold). */
export const RE_DELIVERY_DEFAULT_BASE_DELAY_MS = 15_000

/** LANE ② — the backoff CAP (10 min): the per-pair delay never grows beyond
 * this, so a long-lived failure still re-drives at least ~6 times/hour (the
 * gate-clean recovery reaches a pair within ≤ 10 min of its last attempt). */
export const RE_DELIVERY_DEFAULT_MAX_DELAY_MS = 10 * 60_000

/** LANE ② — the MAX-ATTEMPTS stop (12): after this many failed attempts
 * (windowed by the storm window), the automatic re-drive STOPS for that pair —
 * ONE 'terminal' row + a loud WARN (stop-with-alert) — instead of re-attempting
 * forever (the 450/226-attempt storms). The DURABLE record stays in
 * messages.jsonl (no content loss — recovery is manual/operational). */
export const RE_DELIVERY_DEFAULT_MAX_ATTEMPTS = 12

/** LANE ② — the attempt-count window (1 h): only the pair's rows inside the
 * last hour count toward the backoff/exhaustion math (an OLD failure history
 * never keeps a pair permanently exhausted). */
export const RE_DELIVERY_STORM_WINDOW_MS = 60 * 60_000

/** LANE ② (fb-58) — the prepared-stuck criterion (10 min): 0 prepared rows
 * stuck > 10 min to a live non-dormant recipient (the crash-recovery class the
 * boot-only re-drive left parked until the next boot). */
export const RE_DELIVERY_PREPARED_STUCK_MS = 10 * 60_000

/** PURE — the exponential-backoff delay AFTER `priorAttempts` FAILED attempts:
 * 0 prior → 0 (the FIRST re-drive of a pair is immediate — the gate-clean
 * recovery must not be delayed); n > 0 → `min(maxDelayMs, baseDelayMs * 2^(n-1))`
 * (the 2nd waits base, the 3rd 2×base, … the cadence never storms: 0,15s,30s,
 * 60s,2m,4m,8m,10m(cap) ≈ 8 attempts in the first hour — well under the 30/h
 * alert threshold and the < 3:1 attempts/deliveries ratio by construction). */
export function redeliveryBackoffMs(
  priorAttempts: number,
  baseDelayMs: number = RE_DELIVERY_DEFAULT_BASE_DELAY_MS,
  maxDelayMs: number = RE_DELIVERY_DEFAULT_MAX_DELAY_MS
): number {
  const n = Number.isFinite(priorAttempts) && priorAttempts > 0 ? Math.floor(priorAttempts) : 0
  if (n === 0) return 0
  const exponent = Math.min(n - 1, 30) // 2^30 ≈ 1e9 ms — far beyond the cap
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent)
}

/** PURE — whether a pair's attempt count has EXCEEDED the max-attempts stop
 * (the automatic re-drive gives up + alerts). attempts ≥ maxAttempts → true. */
export function redeliveryAttemptsExhausted(attempts: number, maxAttempts: number = RE_DELIVERY_DEFAULT_MAX_ATTEMPTS): boolean {
  return Number.isFinite(attempts) && attempts >= maxAttempts
}

/** PURE — count the delivery ATTEMPTS of one pair (the sidecar rows whose
 * status is 'prepared' or 'failed' inside `windowMs`): the attempt ledger the
 * backoff/exhaustion math reads. */
export function pairAttemptCount(
  rows: readonly DeliveryRow[],
  messageId: string,
  recipientId: string,
  nowMs: number,
  windowMs: number = RE_DELIVERY_STORM_WINDOW_MS
): number {
  let count = 0
  for (const row of rows) {
    if (row.messageId !== messageId || row.recipientId !== recipientId) continue
    if (nowMs - row.ts > windowMs) continue
    if (row.status !== 'prepared' && row.status !== 'failed') continue
    count++
  }
  return count
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

// ---------------------------------------------------------------------------
// Boot redelivery guard (spec §4.4 + W7-A): construct ONE instance per apply
// (AGENTS.md rule 4 — no module-global mutable state) and `run()` it at boot.
// OWNS the sidecar boot compaction, the `latestPerPair` dedupe, and the
// dead-recipient `terminal`-una-vez settlement. The LIVE delivery seam
// (`deliverBusRecord`) is NOT owned here — it stays in invoke.ts (step c) and
// is injected as a dep so the guard never duplicates the active path.
// ---------------------------------------------------------------------------

/** Dependencies a `DeliveryRedeliverer` needs from the apply fiber (or a test
 * harness). Injected so the guard stays free of any module-global state. */
export interface DeliveryRedelivererDeps {
  /** The org stateDir hosting `<stateDir>/deliveries.jsonl`. */
  stateDir: string
  /** A warn/info-capable logger (the cordis `ctx.logger` shape). */
  logger: { info(message: string): void; warn(message: string): void }
  /** Resolve whether a recipient is ALIVE in the durable catalog: true iff it
   * exists as a NON-RETIRED post (posts.json / byPost) OR a NON-RETIRED host
   * (hosts.json / hosts) — OR a RETIRED HOST that is REROUTABLE (a host whose
   * rotation chain still resolves a live successor — the delivery engine's
   * catalog route re-routes the send to the live host, so a pending pair to
   * the retired id is re-driven instead of settled dead; the fb-58 F-3 class).
   * A NON-CATALOG recipient (a finished subagent-child session id — present in
   * NEITHER durable registry) resolves FALSE, which is C8′: it is settled to
   * 'terminal' ONCE (see `run`). */
  recipientAlive(recipientId: string): boolean
  /** LANE ② (fb-58/B3) — OPTIONAL: whether a recipient is DORMANT (a
   * deliberate sleepEpoch mark — its noWake/'prepared' queue waits for its
   * next REAL wake; the sweep must NEVER re-drive/wake it). Absent → false
   * (no dormancy knowledge — the legacy behavior). */
  recipientDormant?(recipientId: string): boolean
  /** Resolve the message record for a sidecar row (the open MessagesStore). May
   * resolve async (the store is OPENED at boot via a promise, not synchronously). */
  getRecord(messageId: string): Promise<MessageRecord | undefined>
  /** Resolve the CALLER session id for a re-delivered record (the sender's
   * durable session: its post sessionId, else its host sessionId, else the
   * member id itself). Passed to `deliver` as the caller/sender identity. */
  resolveCallerSessionId(from: string): string
  /** The LIVE delivery seam: deliver ONE record to ONE recipient and record the
   * final sidecar status (deliverBusRecord in invoke.ts — the ACTIVE path, step
   * c; the guard only re-runs it for eligible pairs). Returns the final status. */
  deliver(record: MessageRecord, recipientId: string, callerSessionId: string): Promise<DeliveryStatus>
}

/**
 * The boot redelivery guard: re-run ONLY the delivery pairs whose LATEST
 * sidecar status needs re-delivery ('prepared' — crash between persist and
 * delivery / mid-fan-out — and 'failed'), settle a DEAD/UNKNOWN or NON-CATALOG
 * recipient as ONE 'terminal' row (never re-attempted, never re-alerted), and
 * compact the sidecar once it grows past `COMPACTION_LINE_THRESHOLD`. The
 * `latestPerPair` dedupe (the last row per (messageId, recipientId)) makes the
 * pass idempotent: a pair settled 'delivered'/'resumed'/'terminal' is never
 * touched again.
 *
 * C8′ (m-406/m-407): a delivery whose `failed`/`prepared` row addresses a
 * NON-CATALOG recipient — not present in posts.json AND not a host id in
 * hosts.json, i.e. a FINISHED subagent-child session id like `75a826f6-…` —
 * is settled to 'terminal' ONCE (markDelivery 'terminal'), exactly like the
 * existing dead-recipient settlement, WITHOUT any catalog match. A
 * catalog-LIVE recipient with a 'failed'/'prepared' row is unaffected and is
 * still re-delivered at boot.
 *
 * LANE ② (incident-delivery 2026-09-03) — the re-drive machinery now owns:
 *   (a) PER-PAIR EXPONENTIAL BACKOFF with a cap (fb-79 — the m-183/188 retry
 *       storms: 450/226 attempts at a 7–14 s cadence with NO backoff): the
 *       NON-BOOT SWEEP (`sweepDue()`) gated by `redeliveryBackoffMs(count)`,
 *       so a continuous failure degrades to ~8 attempts/hour (well under the
 *       >30/h alert threshold; the attempts/deliveries ratio lands < 3:1 by
 *       construction). The BOOT pass keeps its ONE-TIME immediate semantics
 *       (the "no-retry-hasta-boot" recovery contract — a single boot is not a
 *       storm; the restart-loop storm is bounded by the max-attempts stop);
 *   (b) MAX-ATTEMPTS STOP-WITH-ALERT (boot + sweep): a pair whose in-window
 *       attempt count reaches `maxAttempts` is settled to ONE 'terminal' row
 *       + a loud WARN — the automatic re-drive STOPS (the message record stays
 *       durable in messages.jsonl — no content loss, recoverable manually);
 *   (c) the non-boot SWEEP (the no-restart re-drive seam): a bounded,
 *       scheduled pass that re-drives the DUE pairs (gate-clean recovery
 *       without a daemon restart — the 14 lost messages of 09-03 were only
 *       re-delivered on the first boot post-restart) and settles the rest; a
 *       DORMANT recipient's 'prepared' queue is NEVER re-driven (B3 — its
 *       noWake intent waits for its next real wake); a recipient that is
 *       DEAD/UNKNOWN settles as ONE 'terminal' row exactly like the boot pass;
 *   (d) the fb-58 prepared-stuck criterion: any 'prepared' row OLDER than
 *       `preparedStuckMs` (10 min) to a LIVE non-dormant recipient is due —
 *       re-driven by the sweep (the crash-recovery class the boot-only re-drive
 *       parked until the next boot → "0 prepared-stuck > 10 min" as closure
 *       criterion); a FRESH prepared row (< 10 min) is left alone (the B3
 *       noWake queue grace — never double-delivered/woken prematurely).
 */
export class DeliveryRedeliverer {
  private readonly deps: DeliveryRedelivererDeps
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly maxAttempts: number
  private readonly stormWindowMs: number
  private readonly preparedStuckMs: number

  constructor(
    deps: DeliveryRedelivererDeps,
    opts: {
      /** The exponential-backoff base (default `RE_DELIVERY_DEFAULT_BASE_DELAY_MS`). */
      baseDelayMs?: number
      /** The backoff cap (default `RE_DELIVERY_DEFAULT_MAX_DELAY_MS`). */
      maxDelayMs?: number
      /** The in-window attempt count that stops the automatic re-drive with an
       * alert (default `RE_DELIVERY_DEFAULT_MAX_ATTEMPTS`). */
      maxAttempts?: number
      /** The attempt-count window (default `RE_DELIVERY_STORM_WINDOW_MS`). */
      stormWindowMs?: number
      /** The prepared-stuck criterion (default `RE_DELIVERY_PREPARED_STUCK_MS`). */
      preparedStuckMs?: number
    } = {}
  ) {
    this.deps = deps
    this.baseDelayMs = opts.baseDelayMs ?? RE_DELIVERY_DEFAULT_BASE_DELAY_MS
    this.maxDelayMs = opts.maxDelayMs ?? RE_DELIVERY_DEFAULT_MAX_DELAY_MS
    this.maxAttempts = opts.maxAttempts ?? RE_DELIVERY_DEFAULT_MAX_ATTEMPTS
    this.stormWindowMs = opts.stormWindowMs ?? RE_DELIVERY_STORM_WINDOW_MS
    this.preparedStuckMs = opts.preparedStuckMs ?? RE_DELIVERY_PREPARED_STUCK_MS
  }

  /** The sidecar parse (full read — the SAME seam the boot pass uses). */
  private async readSidecarRows(): Promise<DeliveryRow[]> {
    const { stateDir } = this.deps
    try {
      return parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] // nothing ever sent
      throw error
    }
  }

  /** The attempt-count of one pair in the storm window (the pair's own sidecar
   * rows — the attempt ledger). */
  private pairAttempts(rows: readonly DeliveryRow[], messageId: string, recipientId: string): number {
    return pairAttemptCount(rows, messageId, recipientId, Date.now(), this.stormWindowMs)
  }

  /** Drive ONE eligible (messageId, recipientId) pair: decide terminal / skip /
   * re-deliver under the LANE ② gates. Shared by the boot pass and the sweep.
   * The `nowMs` is injected so a test is deterministic. Non-fatal: every error
   * logs and is swallowed (the pass must never block the boot/tick). */
  private async drivePair(row: DeliveryRow, attempts: number, nowMs: number, source: string): Promise<void> {
    const { stateDir, logger } = this.deps
    const pairLabel = `${row.messageId} → ${row.recipientId}`
    try {
      // ALTO-1 / Issue-3 guard (the boot driver's own rebind rule): settle/re-drive
      // ONLY a pair whose CURRENT record exists AND actually addresses the
      // recipient — a stale row (its record trimmed, or the current record never
      // addressed this recipient) is SKIPPED, never driven (the m-728 class).
      const record = await this.deps.getRecord(row.messageId)
      if (record === void 0 || !record.to.includes(row.recipientId)) return
      // W7-A + C8′ (order matters — a DEAD recipient is settled regardless of
      // backoff/exhaustion: re-attempting a dead recipient is pointless; the
      // one-time 'terminal' makes the W6 scan silent).
      if (!this.deps.recipientAlive(row.recipientId)) {
        await markDelivery(stateDir, row.messageId, row.recipientId, 'terminal')
        logger.info(`[deepartments] ${source} re-delivery: ${pairLabel} (was ${row.status}) → 'terminal' — recipient is dead/unknown (no longer a live catalog member), settled once and never re-attempted`)
        return
      }
      // LANE ② (b) — MAX-ATTEMPTS STOP-WITH-ALERT: beyond the cap the automatic
      // re-drive STOPS for the pair (one terminal + a loud warn — the alert;
      // the durable record stays in messages.jsonl, recoverable manually). This
      // bounds the restart-loop storm (450/226-attempt m-183/m-188 class).
      if (redeliveryAttemptsExhausted(attempts, this.maxAttempts)) {
        await markDelivery(stateDir, row.messageId, row.recipientId, 'terminal')
        logger.warn(`[deepartments] ${source} re-delivery: ${pairLabel} (was ${row.status}) STOPPED after ${attempts} attempts (max ${this.maxAttempts}) — settled 'terminal' (stop-with-alert; the message record stays durable; recover it manually if the recipient class is temporary)`)
        return
      }
      // LANE ② (c) — B3 dormancy guard: a DORMANT recipient's 'prepared' queue
      // is a deliberate noWake — it drains at its next REAL wake, NEVER here.
      if (this.deps.recipientDormant?.(row.recipientId) === true && row.status === 'prepared') return
      try {
        const callerSessionId = this.deps.resolveCallerSessionId(record.from)
        const status = await this.deps.deliver(record, row.recipientId, callerSessionId)
        logger.info(`[deepartments] ${source} re-delivery: ${pairLabel} (was ${row.status}) → ${status}`)
      } catch (error: unknown) {
        logger.warn(`[deepartments] ${source} re-delivery ${pairLabel} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } catch (error: unknown) {
      logger.warn(`[deepartments] ${source} re-delivery ${pairLabel} failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Whether the pair is DUE for a SWEEP re-drive:
   *  - a `failed` row → due when the per-pair exponential backoff elapsed since
   *    the last attempt (`redeliveryBackoffMs(attempts)` — the FIRST re-drive
   *    waits the base delay (15 s), which the 60 s sweep tick bounds anyway;
   *    repeated failures spread 15 s → 30 s → 60 s → … — the m-183 7–14 s
   *    storm cadence is structurally impossible);
   *  - a `prepared` row → due ONLY once it is OLDER than `preparedStuckMs`
   *    (10 min — the fb-58 criterion; a fresh prepared row is the B3 noWake
   *    queue grace / mid-delivery crash window, left alone). */
  private pairDue(row: DeliveryRow, attempts: number, nowMs: number): boolean {
    const ageMs = nowMs - row.ts
    if (row.status === 'prepared') return ageMs > this.preparedStuckMs
    // 'failed' (and any other needsRedelivery status): the backoff cadence.
    return ageMs >= redeliveryBackoffMs(attempts, this.baseDelayMs, this.maxDelayMs)
  }

  /**
   * Run one boot pass. Non-fatal: any unexpected error is logged and swallowed
   * (the boot must never be blocked by a re-delivery issue); its re-delivery
   * is re-attempted on the NEXT boot, IDEMPOTENTLY. The pass keeps its
   * ONE-TIME immediate semantics (every eligible pair is re-delivered in ONE
   * boot pass — the crash-recovery contract; a single boot is not a storm) and
   * gains the LANE ② gates: the DEAD settle (unchanged), the MAX-ATTEMPTS
   * stop-with-alert, and the B3 dormancy skip — see `drivePair`.
   */
  async run(): Promise<void> {
    const { stateDir, logger } = this.deps
    try {
      const filePath = resolveDeliveriesPath(stateDir)
      let text: string
      try {
        text = await readFile(filePath, 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // nothing ever sent
        throw error
      }
      let rows = parseDeliveryRows(text)
      // Sidecar boot compaction: keep only the latest row per key once the
      // sidecar grows past the line threshold (spec §4.4 builder-verify).
      if (rows.length > COMPACTION_LINE_THRESHOLD) {
        rows = compactDeliveryRows(rows)
        await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
        logger.info(`[deepartments] deliveries sidecar compacted to ${rows.length} latest-state rows (boot)`)
      }
      // `latestPerPair` dedupe: iterate ONLY the latest row per (messageId,
      // recipientId), in row order — a pair settled later (delivered/resumed/
      // terminal) shadows an earlier prepared/failed row.
      const latestPerKey = new Map<string, DeliveryRow>()
      for (const row of rows) latestPerKey.set(`${row.messageId}\u0000${row.recipientId}`, row)
      for (const row of latestPerKey.values()) {
        if (!needsRedelivery(row.status)) continue
        const attempts = this.pairAttempts(rows, row.messageId, row.recipientId)
        await this.drivePair(row, attempts, Date.now(), 'boot')
      }
    } catch (error: unknown) {
      logger.warn(`[deepartments] boot deliveries re-delivery pass failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * LANE ② (incident-delivery 2026-09-03) — the NON-BOOT redelivery SWEEP:
   * the no-restart re-drive seam (the failed/prepared pairs were previously
   * re-delivered ONLY at boot — the 14 lost messages of 09-03 re-entered on
   * the first boot post-restart). A scheduled, BOUNDED pass (the caller ticks
   * it on a timer) that re-drives the DUE pairs — the same latestPerPair
   * dedupe + DEAD settle + MAX-ATTEMPTS stop as the boot pass, PLUS the
   * per-pair exponential backoff (fb-79 — a continuous failure degrades to
   * ~8 attempts/hour, never a storm) and the B3 dormancy skip — and settles
   * the rest. `nowMs` is injected (a test deterministically drives the sweep
   * through the backoff/prepared-stuck windows without real waiting). NEVER
   * throws (the tick must not be wedged by a re-delivery issue).
   */
  async sweepDue(nowMs: number = Date.now()): Promise<void> {
    const { logger } = this.deps
    try {
      const rows = await this.readSidecarRows()
      const latestPerKey = new Map<string, DeliveryRow>()
      for (const row of rows) latestPerKey.set(`${row.messageId}\u0000${row.recipientId}`, row)
      for (const row of latestPerKey.values()) {
        if (!needsRedelivery(row.status)) continue
        const attempts = pairAttemptCount(rows, row.messageId, row.recipientId, nowMs, this.stormWindowMs)
        // A DEAD recipient settles regardless (the alive check inside
        // drivePair); a NOT-yet-due live pair is left for a LATER sweep.
        if (this.deps.recipientAlive(row.recipientId) && !this.pairDue(row, attempts, nowMs)) continue
        await this.drivePair(row, attempts, nowMs, 'sweep')
      }
    } catch (error: unknown) {
      logger.warn(`[deepartments] re-delivery sweep failed (non-fatal — the boot pass + the next sweep re-evaluate): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
