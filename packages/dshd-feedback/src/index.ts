// dshd-feedback — the deepartments UNIVERSAL FEEDBACK STORE (the dshd-feedback
// phase of the modular Cordis split). A PURE LIBRARY package: it owns the
// durable append-only feedback backlog `<stateDir>/feedback.jsonl` + the
// archive `feedback-archive.jsonl` (non-destructive prune), the record schema
// (m-371), the append-only state machine (abierto → en-estudio → resuelto |
// descartado | duplicado, reopen only en-estudio→abierto, NEVER from a
// terminal state), the
// live-cap prune (evict TERMINAL records to the archive, never delete a line),
// and the paged surfacing list.
//
// The store is a pure fs module (NO cordis dependencies — just `node:fs/promises`
// + `node:path`), same shape as dshd-core's `MessagesStore`/`RegistryStore`: the
// BUNDLE (invoke.ts) opens ONE `FeedbackStore` per apply (AGENTS.md rule 4 — no
// module-global mutable state) and registers the `dept_feedback*` tools on top.
// The dshd-feedback package is a LIBRARY, NOT a Cordis plugin: it does not
// compose a service nor define a tool (that is a later split phase); the bundle
// consumes it through the drop-in bridge `src/core/feedback.ts`
// (`export * from 'dshd-feedback'`).
// [P1 — 2026-08-29]: that "later split phase" starts HERE: the package now ALSO
// exposes a thin Cordis plugin surface (name/inject/apply, bottom of this file)
// providing the `deepartments.feedback` service. The bundle's inline use stays
// (R6) until the DECOUPLING hito rewires it to the composed service.
//
// Wire format: one JSON record per line (JSONL), append-only. Each state
// transition (and each new feedback record) is a FULL new line; the LIVE view
// of a record (`get`/`list`) is the LAST tail line with that id.
//
// NO export default (pitfall 0001 — breaks `inject`).
import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Record types (m-371) + machine enums.
// ---------------------------------------------------------------------------

/** `source` origin of a feedback record (m-371). */
export type FeedbackSource = 'dshd-feedback' | 'quality-inspect'

/** Feedback type: a defect or an improvement. */
export type FeedbackTipo = 'fallo' | 'mejora'

/** Severity = priority ordering (critico > alto > medio > bajo). */
export type FeedbackSeveridad = 'critico' | 'alto' | 'medio' | 'bajo'

/** Backlog state. `resuelto`/`descartado`/`duplicado` are TERMINAL. */
export type FeedbackEstado = 'abierto' | 'en-estudio' | 'resuelto' | 'descartado' | 'duplicado'

/** One feedback record/transition line (m-371). A full record per line
 * (append-only — a transition is a NEW tail line with the SAME id). */
export interface FeedbackRecord {
  id: string
  createdAt: number
  updatedAt: number
  emisor: string
  source: FeedbackSource
  tipo: FeedbackTipo
  severidad: FeedbackSeveridad
  estado: FeedbackEstado
  resumen: string
  archivo_linea?: string
  event?: string
  evidencia?: string
  notas_qh?: string
  report_path?: string
  escalado?: boolean
  escalado_a?: string
  cerrado_por?: string
  /** LOOP FASE 1 (RD spec §4): the canonical record this record is a duplicate
   * of (estado `duplicado`); its evidence is MERGED into the canonical tail. */
  duplicate_of?: string
  /** Cross-links to related feedback ids (the duplicate links both ways). */
  related?: string[]
  /** The member id triaging the record (set when estado → en-estudio). */
  triage_owner?: string
  /** How/why the record was closed (recorded on terminal transitions — e.g.
   * the delivery link that resolved it). */
  resolution?: string
  /** QH lifecycle flag (spec §4c): a `frozen` record is NEVER stale-closed
   * nor nudged — the K8s `/lifecycle frozen` escape, a boolean flag (decided
   * over a new estado: frozen is a lifecycle property, not a state-machine
   * step; frozen records still flow abierto→en-estudio→terminal normally). */
  frozen?: boolean
}

/** The create input: everything the caller authors; id/createdAt/updatedAt/
 * source/estado are assigned by the store. */
export interface FeedbackInput {
  emisor: string
  tipo: FeedbackTipo
  severidad: FeedbackSeveridad
  resumen: string
  source?: FeedbackSource
  archivo_linea?: string
  event?: string
  evidencia?: string
  report_path?: string
  /** LOOP FASE 1: OPT-IN duplicate creation — the canonical fb-id this record
   * duplicates. When set, the record is created as estado `duplicado` (an
   * ACL-free TERMINAL at creation — spec §4a.3: "el QD (o el emisor) lo marca
   * duplicate_of en la creación") and its evidence is merged into the
   * canonical tail (emisor + origen fb-XXX). */
  duplicate_of?: string
}

/** The update input (append-only transition): each provided field becomes the
 * new tail line's value; estado follows the state machine. LOOP FASE 1 adds
 * the duplicate marking (`duplicate_of` → estado `duplicado` + evidence merge)
 * and the new metadata fields. */
export interface FeedbackUpdateInput {
  estado?: FeedbackEstado
  notas_qh?: string
  escalado?: boolean
  escalado_a?: string
  /** Mark as duplicate: transitions the record to `duplicado` (a QH-terminal)
   * and merges its evidence into the canonical tail (spec §4a.3). */
  duplicate_of?: string
  /** REPLACE the related[] cross-links (the caller passes the full list). */
  related?: string[]
  /** The member id triaging the record (set alongside estado → en-estudio). */
  triage_owner?: string
  /** How/why the record was closed (recorded on terminal transitions — the
   * auto-close-by-reference flow records the delivery link here). */
  resolution?: string
  /** The QH lifecycle flag: true → never stale-closed nor nudged. */
  frozen?: boolean
}

/** The list (surfacing) filters + paging. */
export interface FeedbackListOptions {
  estado?: FeedbackEstado
  severidad?: FeedbackSeveridad
  tipo?: FeedbackTipo
  emisor?: string
  /** A feedback record id, EXCLUSIVE in the sorted/filtered order. An unknown
   * cursor clamps to the start of the list (defensive, like MessagesStore). */
  cursor?: string
  /** Page size (default 20, capped 100). */
  limit?: number
}

/** A paged list result (sorted severity desc, then createdAt asc — §4). */
export interface FeedbackListResult {
  total: number
  items: FeedbackRecord[]
  remaining: number
  /** The next-page exclusive cursor (the last item's id), when a page is
   * returned and more items may follow. */
  cursor?: string
}

// ---------------------------------------------------------------------------
// State machine (m-371) — pure helpers.
// ---------------------------------------------------------------------------

/** The severity ordering: HIGHER = more severe (sort desc). */
export const SEVERITY_RANK: Record<FeedbackSeveridad, number> = { critico: 4, alto: 3, medio: 2, bajo: 1 }

/** Whether an estado is TERMINAL (resolved/discarded/duped — no further
 * transitions). `duplicado` is the LOOP FASE 1 triage-terminal (Linear
 * Canceled / K8s reference-and-close, RD spec §4a). */
export function isTerminalEstado(estado: FeedbackEstado): boolean {
  return estado === 'resuelto' || estado === 'descartado' || estado === 'duplicado'
}

/**
 * The append-only state machine transition rule (m-371): returns an error string
 * when `current → next` is ILLEGAL, `undefined` when allowed.
 *
 * Rule: `abierto`/`en-estudio` are OPEN (transitionable); `resuelto`/
 * `descartado`/`duplicado` are TERMINAL — a terminal record NEVER transitions
 * again (reopen is never
 * allowed from a terminal state). A transition to `abierto` (reopen) is only
 * legal from `en-estudio` (with new evidence — the "evidence" requirement is a
 * tool/review concern, surfaced here as a machine rule); `abierto → abierto` and
 * any same-state metadata update is a no-op (allowed). The QH-only authority
 * (who may close / reopen) is enforced by the TOOL, not here.
 */
export function feedbackTransitionError(current: FeedbackEstado, next: FeedbackEstado): string | undefined {
  if (current === next) return undefined
  if (isTerminalEstado(current)) {
    return `estado "${current}" is terminal — no further transitions (reopen is never allowed from a terminal state)`
  }
  if (next === 'abierto' && current !== 'en-estudio') {
    return `reopen to "abierto" requires the current estado to be "en-estudio" (new evidence) — an "abierto" record with state "${current}" cannot be reopened`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// LOOP FASE 1 (2026-09-08, RD spec §4 — "mínimo viable profesional") — the
// DEDUPE (search-before-create), the BRIDGE to the shared queue, and the
// STALE review. All PURE helpers, no infra, no daemon: the QD can run the
// stale review via a scheduled job; the bridge is append-only runtime state
// the IPD register-sync absorbs into the WORK-REGISTER.
// ---------------------------------------------------------------------------

/** A duplicate-candidate suggestion (NON-blocking, ≤3 — the GitHub/Linear
 * pattern; spec §4a). `fb-id` carries the candidate record id (the spec shape
 * `{fb-id, resumen, tipo, severidad, estado, score}`). */
export interface FeedbackDedupeCandidate {
  'fb-id': string
  resumen: string
  tipo: FeedbackTipo
  severidad: FeedbackSeveridad
  estado: FeedbackEstado
  score: number
}

/** ONE normalized bridge-to-queue line (spec §4b) appended to
 * `<stateDir>/feedback-bridge.jsonl` for EVERY record created as `abierto`
 * (a `duplicado` is terminal — nothing to queue). APPEND-ONLY: never edit a
 * previous line; the file format is documented here + the department report. */
export interface FeedbackBridgeLine {
  'fb-id': string
  tipo: FeedbackTipo
  severidad: FeedbackSeveridad
  resumen: string
  evidencia_ref: string
  solicitante: string
  fecha: string
  destino: readonly string[]
}

/** The bridge destination: the shared queue is consumed by host + IPD (the
 * WORK-REGISTER sync); the QD notification stays severity-gated separately. */
export const FEEDBACK_BRIDGE_DESTINO: readonly string[] = ['host', 'internal-programming-head']

/** Bridge file name: `<stateDir>/feedback-bridge.jsonl` (runtime state — NOT
 * the human docs/WORK-REGISTER.md, which IPD + host maintain daily). */
export const FEEDBACK_BRIDGE_FILE = 'feedback-bridge.jsonl'

/** Bridge file location: `<stateDir>/feedback-bridge.jsonl`. */
export function resolveFeedbackBridgePath(stateDir: string): string {
  return path.join(stateDir, FEEDBACK_BRIDGE_FILE)
}

/** Append ONE normalized bridge line for a created record (mkdir -p). */
export async function appendFeedbackBridgeLine(stateDir: string, record: FeedbackRecord): Promise<void> {
  const line: FeedbackBridgeLine = {
    'fb-id': record.id,
    tipo: record.tipo,
    severidad: record.severidad,
    resumen: record.resumen,
    evidencia_ref: `${FEEDBACK_FILE} ${record.id} tail`,
    solicitante: record.emisor,
    fecha: new Date(record.createdAt).toISOString(),
    destino: FEEDBACK_BRIDGE_DESTINO
  }
  const filePath = resolveFeedbackBridgePath(stateDir)
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, JSON.stringify(line) + '\n', 'utf8')
}

/** The dedupe STOPWORDS set (Spanish/English function words — "significant
 * tokens" excludes these). Kept deliberately small — the lexer is documented
 * and tuned by tests. */
const DEDUPE_STOPWORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'del', 'al', 'en', 'y', 'o', 'u', 'a', 'con', 'por', 'para', 'que', 'un', 'una', 'unos', 'unas', 'se', 'su', 'sus', 'es', 'son', 'este', 'esta', 'esto',
  'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'at', 'with', 'from', 'is', 'are'
])

/** The dedupe lexer: lowercase, letters+digits tokens (`\p{L}\p{N}+`), unique,
 * length ≥ 2, stopwords dropped. Day-1 is LEXICAL (embeddings = the future
 * upgrade — GitHub/Linear precedent, RD spec §3). */
function dedupeTokens(text: string): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(tokens.filter((token) => token.length >= 2 && !DEDUPE_STOPWORDS.has(token)))]
}

/** Find ≤`max` duplicate candidates (default 3) among a record POOL: ≥2
 * shared significant resumen tokens = a match; tipo/severidad equality
 * REFINES the score (score = shared + tipo-equal + severidad-equal). The
 * suggestions are NON-blocking — the create always proceeds. Deterministic:
 * score desc, then updatedAt desc, then id desc. */
export function findDuplicateCandidates(
  records: readonly FeedbackRecord[],
  input: { resumen: string; tipo: FeedbackTipo; severidad: FeedbackSeveridad },
  opts: { max?: number } = {}
): FeedbackDedupeCandidate[] {
  const max = opts.max ?? 3
  const inputTokens = dedupeTokens(input.resumen)
  if (inputTokens.length < 2) return []
  const inputSet = new Set(inputTokens)
  const scoreOf = (record: FeedbackRecord): number => {
    const shared = dedupeTokens(record.resumen).filter((token) => inputSet.has(token)).length
    return shared < 2 ? -1 : shared + (record.tipo === input.tipo ? 1 : 0) + (record.severidad === input.severidad ? 1 : 0)
  }
  const matches = records.filter((record) => scoreOf(record) >= 2)
  matches.sort((a, b) => (scoreOf(b) - scoreOf(a)) || (b.updatedAt - a.updatedAt) || b.id.localeCompare(a.id))
  return matches.slice(0, max).map((record) => ({
    'fb-id': record.id,
    resumen: record.resumen,
    tipo: record.tipo,
    severidad: record.severidad,
    estado: record.estado,
    score: scoreOf(record)
  }))
}

/** Stale-review window constants (RD spec §4c — adapted from the K8s
 * stale bot to the org's scale). */
export const STALE_REVIEW_ABIERTO_DAYS = 14
export const STALE_REVIEW_EN_ESTUDIO_DAYS = 30
export const STALE_REVIEW_INACTIVITY_DAYS = 90

/** A single-record stale-review result (kind `none` = nothing due). */
export interface FeedbackStaleNudge {
  kind: 'none' | 'nudge-qd' | 'nudge-owner' | 'stale-descartado'
  days: number
  reason: string
}

/** Pure stale review for ONE record (exported per the mission: "exponer
 * helpers puros de stale-check exportados + documentar el nudge" — the QD may
 * trigger it by job; NO daemon day-1). Windows: 14d in `abierto` sin triage →
 * nudge QD; 30d in `en-estudio` sin movimiento → nudge `triage_owner` (or QD
 * when unset); 90d sin actividad y severidad ≠ critica/alto → `descartado`
 * (stale) con nota de audit. A record with `frozen: true` NEVER stale-closes
 * nor nudges (the `/lifecycle frozen` escape — a boolean flag, not an estado;
 * decision documented). */
export function feedbackStaleNudge(record: FeedbackRecord, now: number = Date.now()): FeedbackStaleNudge {
  const days = Math.floor((now - record.updatedAt) / 86_400_000)
  const open = record.estado === 'abierto' || record.estado === 'en-estudio'
  const lowSeverity = record.severidad !== 'critico' && record.severidad !== 'alto'
  if (record.frozen === true) {
    return { kind: 'none', days, reason: 'frozen escape — marked frozen, never stale-closed nor nudged' }
  }
  if (days >= STALE_REVIEW_INACTIVITY_DAYS && open && lowSeverity) {
    return { kind: 'stale-descartado', days, reason: `${days}d sin actividad y severidad ${record.severidad} (no critica/alto) → descartado(stale) con nota de audit` }
  }
  if (record.estado === 'abierto' && days >= STALE_REVIEW_ABIERTO_DAYS) {
    return { kind: 'nudge-qd', days, reason: `${days}d en "abierto" sin triage → nudge a quality-head` }
  }
  if (record.estado === 'en-estudio' && days >= STALE_REVIEW_EN_ESTUDIO_DAYS) {
    return { kind: 'nudge-owner', days, reason: `${days}d en "en-estudio" sin movimiento → nudge a ${record.triage_owner ?? 'quality-head (sin triage_owner)'}` }
  }
  return { kind: 'none', days, reason: 'dentro de los plazos de stale-review' }
}

/** Extract the `fb-<seq>` references from a text (the "Fixes #NN"-analog): the
 * STABLE pattern the QD/IPD tooling parses delivery notes / bridge lines to
 * detect which feedback records a delivery references (auto-close by
 * reference — the QH then closes the record with `resolution` + the delivery
 * link; QD keeps the terminal authority). Unique, in order of appearance. */
export function extractFeedbackReferences(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(/\bfb-(\d+)\b/gi)) {
    const id = `fb-${match[1]}`
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Paths + parse/append/rewrite (mirror messages-store / registry patterns).
// ---------------------------------------------------------------------------

export const FEEDBACK_FILE = 'feedback.jsonl'
export const FEEDBACK_ARCHIVE_FILE = 'feedback-archive.jsonl'

/** The default live-file line cap (N=200, configurable). */
export const DEFAULT_LIVE_CAP = 200

/** Live file location: `<stateDir>/feedback.jsonl`. */
export function resolveFeedbackPath(stateDir: string): string {
  return path.join(stateDir, FEEDBACK_FILE)
}

/** Archive file location: `<stateDir>/feedback-archive.jsonl`. */
export function resolveFeedbackArchivePath(stateDir: string): string {
  return path.join(stateDir, FEEDBACK_ARCHIVE_FILE)
}

/** Parse the `fb-<seq>` id and return its seq (the append counter seed). */
export function parseFeedbackSeq(id: string): number {
  const match = /^fb-(\d+)$/.exec(id)
  return match === null ? -1 : Number(match[1])
}

function isFeedbackShape(value: unknown): value is FeedbackRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    typeof record.emisor === 'string' &&
    typeof record.source === 'string' &&
    typeof record.tipo === 'string' &&
    typeof record.severidad === 'string' &&
    typeof record.estado === 'string' &&
    typeof record.resumen === 'string'
}

/** Pure parse of feedback JSONL text. Tolerant of a trailing partial line (a
 * crash mid-append): a final line that fails to parse is dropped. A malformed
 * NON-final line throws (mid-file corruption fails loud). */
export function parseFeedbackRecords(text: string, label = 'feedback file'): FeedbackRecord[] {
  const records: FeedbackRecord[] = []
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
    if (!isFeedbackShape(parsed)) {
      throw new Error(`${label}: malformed record on line ${index + 1} (not a feedback record shape)`)
    }
    records.push(parsed)
  }
  return records
}

async function loadFeedbackText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Read + parse every record in the live file. Missing file → empty list. */
export async function loadFeedbackRecords(filePath: string): Promise<FeedbackRecord[]> {
  return parseFeedbackRecords(await loadFeedbackText(filePath), filePath)
}

/** Append one record as a JSON line (mkdir -p the file's directory first). */
export async function appendFeedbackRecord(filePath: string, record: FeedbackRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, JSON.stringify(record) + '\n', 'utf8')
}

/** Atomic rewrite (tmp + rename) of a JSONL file from a record list. */
async function rewriteJsonl(filePath: string, records: readonly FeedbackRecord[]): Promise<void> {
  const tmpPath = `${filePath}.tmp-${Date.now()}`
  const text = records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '')
  await writeFile(tmpPath, text, 'utf8')
  await rename(tmpPath, filePath)
}

// ---------------------------------------------------------------------------
// The in-memory store: boot open (+ prune to cap), append, update, list.
// ---------------------------------------------------------------------------

/** Optional logger the store may report to (the cordis `ctx.logger` shape —
 * `warn` is the only one used; a silent store passes `undefined`). */
export interface FeedbackStoreLogger {
  warn(message: string): void
}

/** Open options. */
export interface FeedbackOpenOptions {
  /** Live-file line cap (default 200). When the live file exceeds it, the
   * OLDEST TERMINAL (resuelto/descartado) records are moved to the archive;
   * non-terminal records are NEVER pruned. */
  liveCap?: number
  logger?: FeedbackStoreLogger
}

/**
 * The durable feedback store: the append-only backlog + the live view by id.
 * Boot via `open()` (load + prune-terminal-to-archive + index); the ONLY writer
 * is `append()`/`update()` (single-process; no locking — same contract as the
 * MessagesStore).
 *
 * IDENTITY, NOT POSITION (fb-690 id-collision fix): an `fb-<seq>` id is an
 * IDENTITY — it must name ONE logical record forever. Because the prune moves
 * terminal records to `<stateDir>/feedback-archive.jsonl` (out of the live
 * file), a counter seeded from the LIVE FILE ALONE rewinds to the first free
 * position after a prune and re-issues ids that already exist in the archive
 * (measured: 22 ids live in BOTH files in the live profile — e.g. `fb-690`
 * exists live AND archived+`resuelto` as two different records). The counter is
 * therefore seeded from the UNION live ∪ archive (`knownIds`) and every
 * allocation is guarded: a candidate id that already exists is REJECTED and the
 * conflicting record(s) ENUMERATED — never resolved by file order.
 */
export class FeedbackStore {
  private readonly stateDir: string
  private readonly filePath: string
  private readonly archivePath: string
  private readonly liveCap: number
  private readonly logger: FeedbackStoreLogger | undefined
  private records: FeedbackRecord[] = []
  private readonly byId = new Map<string, FeedbackRecord>()
  /** The ARCHIVE tails by id (read at boot — the id-identity ledger half of the
   * census; LIVE-only seeding is the fb-690 bug). */
  private readonly archivedById = new Map<string, FeedbackRecord[]>()
  /** Every id ever allocated = live ∪ archive: the allocation guard + counter seed. */
  private readonly knownIds = new Set<string>()
  /** Set when the archive census was UNREADABLE at boot: the store still boots
   * (reads keep working) but NEW allocations are REFUSED until the census can be
   * read — never a silent live-only seed that could re-issue an archived id. */
  private archiveCensusError: string | undefined
  private nextSeq = 0

  private constructor(stateDir: string, filePath: string, archivePath: string, liveCap: number, logger: FeedbackStoreLogger | undefined) {
    this.stateDir = stateDir
    this.filePath = filePath
    this.archivePath = archivePath
    this.liveCap = liveCap
    this.logger = logger
  }

  /**
   * Boot entry: load `<stateDir>/feedback.jsonl`, prune terminal records beyond
   * the live cap to the archive (non-destructive — backup + append + atomic
   * rewrite), then build the live-by-id index and seed the append counter from
   * the max seq + 1 OF LIVE ∪ ARCHIVE (fb-690 fix: an id that exists in the
   * archive is NEVER re-issued). Missing file → empty store. A malformed
   * non-final line throws loud; a trailing partial line is dropped.
   */
  static async open(stateDir: string, opts: FeedbackOpenOptions = {}): Promise<FeedbackStore> {
    const filePath = resolveFeedbackPath(stateDir)
    const archivePath = resolveFeedbackArchivePath(stateDir)
    const store = new FeedbackStore(stateDir, filePath, archivePath, opts.liveCap ?? DEFAULT_LIVE_CAP, opts.logger)
    let records = await loadFeedbackRecords(filePath)
    if (records.length > store.liveCap) {
      const pruned = await store.pruneToCap(records)
      if (pruned) records = await loadFeedbackRecords(filePath)
    }
    // The archive census is read AFTER the prune (records evicted by THIS boot
    // are already in the archive and must count as allocated ids).
    store.load(records, await store.loadArchiveCensus())
    return store
  }

  /** The total number of JSONL lines in the live file (all tails). */
  get size(): number {
    return this.records.length
  }

  /** The LIVE (latest tail) record for an id, or undefined. */
  get(id: string): FeedbackRecord | undefined {
    return this.byId.get(id)
  }

  /**
   * Append one NEW feedback record (the ACL-free write — ANY agent may emit
   * feedback). id `fb-<seq>`, createdAt/updatedAt = now, source default
   * 'dshd-feedback', estado default 'abierto'. LOOP FASE 1: when
   * `duplicate_of` is provided, the record is created as estado `duplicado`
   * (a TERMINAL triage state — ACL-free at creation, spec §4a.3) and its
   * evidence is MERGED into the canonical record tail (emisor + origen
   * fb-XXX — append-only, a NEW canonical tail; both stay cross-linked via
   * `related[]`). Every record created as `abierto` emits a BRIDGE line to
   * `<stateDir>/feedback-bridge.jsonl` (spec §4b). Flushed to disk AWAITED
   * before the in-memory index updates (persist-before-deliver).
   */
  async append(input: FeedbackInput): Promise<FeedbackRecord> {
    this.validateInput(input)
    const seq = this.nextSeq
    await this.assertIdAvailable(`fb-${seq}`)
    const ts = Date.now()
    const record: FeedbackRecord = {
      id: `fb-${seq}`,
      createdAt: ts,
      updatedAt: ts,
      emisor: input.emisor,
      source: input.source ?? 'dshd-feedback',
      tipo: input.tipo,
      severidad: input.severidad,
      estado: input.duplicate_of !== undefined ? 'duplicado' : 'abierto',
      resumen: input.resumen
    }
    if (input.archivo_linea !== undefined) record.archivo_linea = input.archivo_linea
    if (input.event !== undefined) record.event = input.event
    if (input.evidencia !== undefined) record.evidencia = input.evidencia
    if (input.report_path !== undefined) record.report_path = input.report_path
    if (input.duplicate_of !== undefined) {
      const canonical = this.byId.get(input.duplicate_of)
      if (canonical === undefined) {
        throw new Error(`[deepartments] feedback: duplicate_of "${input.duplicate_of}" is not a live feedback record (the canonical must be live, not archived)`)
      }
      record.duplicate_of = canonical.id
      record.related = [canonical.id]
      await appendFeedbackRecord(this.filePath, record)
      await this.mergeEvidenceIntoCandidate(canonical, record.id, record.emisor, record.evidencia, ts)
      this.nextSeq = seq + 1
      this.records.push(record)
      this.byId.set(record.id, record)
      await this.emitBridgeLine(record)
      return record
    }
    await appendFeedbackRecord(this.filePath, record)
    this.nextSeq = seq + 1
    this.records.push(record)
    this.byId.set(record.id, record)
    await this.emitBridgeLine(record)
    return record
  }

  /**
   * Append-only transition: apply an update to the LIVE record (the same id,
   * NEW tail line with a bumped `updatedAt`). Validates the state-machine
   * transition; `cerradoPor` (the QH) is stamped when the new estado is
   * TERMINAL. LOOP FASE 1: `duplicate_of` marks the record as a duplicate
   * (estado → `duplicado`, a QH-terminal — the evidence is merged into the
   * canonical tail); `related` (REPLACE), `triage_owner`, `resolution` and
   * `frozen` are the new metadata fields. Returns the new live record. Throws
   * on an unknown id or an illegal transition.
   */
  async update(id: string, input: FeedbackUpdateInput, opts: { cerradoPor?: string } = {}): Promise<FeedbackRecord> {
    const current = this.byId.get(id)
    if (current === undefined) throw new Error(`[deepartments] feedback: no record with id "${id}"`)
    const duplicate_of = input.duplicate_of !== undefined && input.duplicate_of !== '' ? input.duplicate_of : undefined
    const nextEstado = duplicate_of !== undefined ? 'duplicado' : (input.estado ?? current.estado)
    const transitionError = feedbackTransitionError(current.estado, nextEstado)
    if (transitionError !== undefined) {
      throw new Error(`[deepartments] feedback ${id}: ${transitionError}`)
    }
    let canonical: FeedbackRecord | undefined
    if (duplicate_of !== undefined) {
      canonical = this.byId.get(duplicate_of)
      if (canonical === undefined) {
        throw new Error(`[deepartments] feedback: duplicate_of "${duplicate_of}" is not a live feedback record (the canonical must be live, not archived)`)
      }
      if (canonical.id === id) {
        throw new Error(`[deepartments] feedback: record "${id}" cannot be a duplicate of itself`)
      }
    }
    const ts = Date.now()
    const next: FeedbackRecord = { ...current, updatedAt: ts, estado: nextEstado }
    if (input.notas_qh !== undefined) next.notas_qh = input.notas_qh
    if (input.escalado !== undefined) next.escalado = input.escalado
    if (input.escalado_a !== undefined) next.escalado_a = input.escalado_a
    if (input.related !== undefined) next.related = input.related
    if (input.triage_owner !== undefined) next.triage_owner = input.triage_owner
    if (input.resolution !== undefined) next.resolution = input.resolution
    if (input.frozen !== undefined) next.frozen = input.frozen
    if (canonical !== undefined) {
      next.duplicate_of = canonical.id
      next.related = [...(next.related ?? [])]
      if (!next.related.includes(canonical.id)) next.related.push(canonical.id)
    }
    if (isTerminalEstado(nextEstado) && opts.cerradoPor !== undefined) next.cerrado_por = opts.cerradoPor
    await appendFeedbackRecord(this.filePath, next)
    this.records.push(next)
    this.byId.set(id, next)
    if (canonical !== undefined) {
      await this.mergeEvidenceIntoCandidate(canonical, id, current.emisor, current.evidencia, ts)
    }
    return next
  }

  /**
   * Surfacing: the live backlog (one entry per record = the latest tail),
   * filtered by estado/severidad/tipo/emisor, sorted severity desc then
   * createdAt asc, paged with an exclusive `cursor` id. A `cursor` id missing
   * from the filtered set clamps to the start of the list (defensive).
   */
  list(opts: FeedbackListOptions = {}): FeedbackListResult {
    const limit = normalizeLimit(opts.limit)
    let items = [...this.byId.values()]
    if (opts.estado !== undefined) items = items.filter((record) => record.estado === opts.estado)
    if (opts.severidad !== undefined) items = items.filter((record) => record.severidad === opts.severidad)
    if (opts.tipo !== undefined) items = items.filter((record) => record.tipo === opts.tipo)
    if (opts.emisor !== undefined) items = items.filter((record) => record.emisor === opts.emisor)
    items.sort((a, b) => {
      const rankDelta = SEVERITY_RANK[b.severidad] - SEVERITY_RANK[a.severidad]
      if (rankDelta !== 0) return rankDelta
      return a.createdAt - b.createdAt
    })
    const total = items.length
    let start = 0
    if (opts.cursor !== undefined) {
      const index = items.findIndex((record) => record.id === opts.cursor)
      if (index >= 0) start = index + 1
    }
    const window = items.slice(start, start + limit)
    const remaining = Math.max(0, total - start - window.length)
    const result: FeedbackListResult = { total, items: window, remaining }
    if (window.length > 0 && start + window.length < total) result.cursor = window[window.length - 1].id
    return result
  }

  /**
   * LOOP FASE 1: the search-before-create DEDUPE — NON-blocking duplicate
   * candidates (≤`max`, default 3) over the LIVE backlog (every live estado
   * except `duplicado` — a linked dup is noise as a suggestion) AND THE
   * ARCHIVE (`feedback-archive.jsonl` IS consulted, spec §4a "abiertos +
   * archivados" — decided: yes, the archive is part of the searchable backlog;
   * the store's byId view alone indexes live records, so the archive is read
   * on demand here). Lexical: ≥2 shared significant resumen tokens (tipo/
   * severidad refine the score). A missing/malformed archive degrades to the
   * live pool (dedupe is best-effort suggestions — creates never block).
   */
  async dedupeCandidates(
    input: { resumen: string; tipo: FeedbackTipo; severidad: FeedbackSeveridad },
    opts: { max?: number } = {}
  ): Promise<FeedbackDedupeCandidate[]> {
    const live = [...this.byId.values()].filter((record) => record.estado !== 'duplicado')
    let archived: FeedbackRecord[] = []
    try {
      archived = await loadFeedbackRecords(this.archivePath)
    } catch {
      archived = [] // a malformed archive must never break a create
    }
    return findDuplicateCandidates([...live, ...archived], input, opts)
  }

  /** LOOP FASE 1: the duplicate-merge — append the dup's evidence to the
   * CANONICAL record as a NEW tail line (same estado — a no-op transition,
   * append-only; the machine allows same-state tails) + the `related[]`
   * cross-link, with emisor + origen fb-XXX (spec §4a.3). The canonical must
   * be LIVE (an archived record cannot receive a tail — the create/update
   * validate this before calling). */
  private async mergeEvidenceIntoCandidate(canonical: FeedbackRecord, dupId: string, emisor: string, evidencia: string | undefined, ts: number): Promise<void> {
    const mergeNote = evidencia !== undefined
      ? `[evidencia de ${dupId} aportada por ${emisor} (origen ${dupId})]: ${evidencia}`
      : `[${dupId} marcado como duplicado por ${emisor} (origen ${dupId})]`
    const related = [...(canonical.related ?? [])]
    if (!related.includes(dupId)) related.push(dupId)
    const mergeTail: FeedbackRecord = {
      ...canonical,
      updatedAt: ts,
      related,
      evidencia: canonical.evidencia !== undefined ? `${canonical.evidencia}\n${mergeNote}` : mergeNote
    }
    await appendFeedbackRecord(this.filePath, mergeTail)
    this.records.push(mergeTail)
    this.byId.set(canonical.id, mergeTail)
  }

  /** LOOP FASE 1: the bridge line — emitted for every record CREATED as
   * `abierto` (a `duplicado` is terminal — nothing to queue; decided and
   * documented: "cada fb abierto emite una línea"). Best-effort: the record
   * is durable regardless (the bridge is runtime state the IPD register-sync
   * absorbs into the WORK-REGISTER). */
  private async emitBridgeLine(record: FeedbackRecord): Promise<void> {
    if (record.estado !== 'abierto') return
    try {
      await appendFeedbackBridgeLine(this.stateDir, record)
    } catch (error: unknown) {
      this.logger?.warn(`[deepartments] feedback bridge line for ${record.id} failed (non-fatal — the record is durable): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Read the ARCHIVE half of the id census (the live half is `this.byId`).
   * A missing archive is a legitimate EMPTY census (nothing was ever pruned).
   * A MALFORMED archive is NOT degraded silently: it is recorded and every NEW
   * allocation is REFUSED (see `assertIdAvailable`) — an unreadable census
   * cannot prove a candidate id is free, and an id must NEVER be reused.
   */
  private async loadArchiveCensus(): Promise<FeedbackRecord[]> {
    try {
      const archived = await loadFeedbackRecords(this.archivePath)
      this.archiveCensusError = undefined
      return archived
    } catch (error: unknown) {
      this.archiveCensusError = error instanceof Error ? error.message : String(error)
      this.logger?.warn(`[deepartments] feedback: the ARCHIVE id census (${path.basename(this.archivePath)}) is UNREADABLE (${this.archiveCensusError}) — the counter CANNOT be seeded against the archive, so NEW record allocation is REFUSED (fail-loud; never a live-only seed that could re-issue an archived id). Fix (or remove) the archive and retry.`)
      return []
    }
  }

  /** Merge archive tails into the census: every archived id is KNOWN (never
   * free), grouped by id (append order) for the conflict enumeration. */
  private mergeArchived(archived: readonly FeedbackRecord[]): void {
    for (const record of archived) {
      const group = this.archivedById.get(record.id)
      if (group === undefined) this.archivedById.set(record.id, [record])
      else group.push(record)
      this.knownIds.add(record.id)
      const seq = parseFeedbackSeq(record.id)
      if (seq >= this.nextSeq) this.nextSeq = seq + 1
    }
  }

  /**
   * The allocation guard (fb-690 fix, acceptance 3): REJECT and ENUMERATE a
   * candidate id that already exists — never choose a side by file order, never
   * overwrite, never silently skip to another id. A degraded archive census is
   * re-attempted HERE (one read, only on the degraded path) so a transient
   * archive failure can never produce a reused id.
   */
  private async assertIdAvailable(id: string): Promise<void> {
    if (this.archiveCensusError !== undefined) {
      this.mergeArchived(await this.loadArchiveCensus())
      if (this.archiveCensusError !== undefined) {
        throw new Error(`[deepartments] feedback: REFUSING to allocate "${id}" — the archive census (${path.basename(this.archivePath)}) is unreadable (${this.archiveCensusError}); an id that exists in the archive must NEVER be re-issued and without the census we cannot prove "${id}" is free. Fix (or remove) the archive and retry.`)
      }
    }
    if (!this.knownIds.has(id)) return
    const conflicts: string[] = []
    const liveRecord = this.byId.get(id)
    if (liveRecord !== undefined) {
      conflicts.push(`LIVE (emisor=${liveRecord.emisor}, createdAt=${liveRecord.createdAt}, estado=${liveRecord.estado})`)
    }
    const archivedGroup = this.archivedById.get(id)
    if (archivedGroup !== undefined) {
      const identities = [...new Set(archivedGroup.map((record) => `${record.emisor}@${record.createdAt}`))]
      conflicts.push(`ARCHIVE (${archivedGroup.length} tail(s): ${identities.join(', ')})`)
    }
    throw new Error(`[deepartments] feedback: REFUSING to allocate "${id}" — the id ALREADY EXISTS (${conflicts.join(' | ')}). A feedback id is an IDENTITY, not a position: a NEW record never reuses a live or archived id (the counter is seeded from LIVE ∪ ARCHIVE). Conflicting record(s) ENUMERATED — no side is chosen by file order.`)
  }

  /**
   * Build the in-memory views + the id census. The counter is seeded from the
   * MAX seq of LIVE ∪ ARCHIVE + 1 (fb-690 fix) so a prune can never rewind it,
   * and ids living in BOTH files as DIFFERENT records (disjoint identities) are
   * ENUMERATED once — the store never picks which of the two "owns" the id.
   */
  private load(records: FeedbackRecord[], archived: readonly FeedbackRecord[] = []): void {
    this.records = records
    this.byId.clear()
    this.archivedById.clear()
    this.knownIds.clear()
    this.nextSeq = 0
    for (const record of records) {
      this.byId.set(record.id, record) // latest tail wins (file order = append order)
      this.knownIds.add(record.id)
      const seq = parseFeedbackSeq(record.id)
      if (seq >= this.nextSeq) this.nextSeq = seq + 1
    }
    this.mergeArchived(archived)
    this.reportIdCollisions()
  }

  /** Enumerate (loudly, once per boot) the ids that exist in BOTH files as
   * different records: same id, DISJOINT identity sets (emisor@createdAt) = the
   * id was REUSED after a prune. An OVERLAPPING identity is a benign duplicated
   * tail (a crash between the archive append and the live rewrite), not a
   * collision. Nothing is fixed here — the census only makes the class VISIBLE. */
  private reportIdCollisions(): void {
    const collisions: string[] = []
    for (const [id, liveRecord] of this.byId) {
      const archivedGroup = this.archivedById.get(id)
      if (archivedGroup === undefined) continue
      const archivedIdentities = archivedGroup.map((record) => `${record.emisor}@${record.createdAt}`)
      if (archivedIdentities.includes(`${liveRecord.emisor}@${liveRecord.createdAt}`)) continue
      collisions.push(`${id} [LIVE ${liveRecord.emisor}@${liveRecord.createdAt} vs ARCHIVE ${[...new Set(archivedIdentities)].join(', ')}]`)
    }
    if (collisions.length === 0) return
    this.logger?.warn(`[deepartments] feedback ID COLLISION: ${collisions.length} id(s) exist in BOTH the live file and the archive as DIFFERENT records — the id was REUSED after a prune (an id is an IDENTITY, not a position). ENUMERATED (no side chosen by file order): ${collisions.join(' ; ')}. The counter is seeded PAST every known id (live ∪ archive), so none of these is ever re-issued.`)
  }

  /** The prune-to-cap (R6): when the live file exceeds `liveCap`, evict the
   * OLDEST TERMINAL logical records (all their lines) to the archive. Non-destructive:
   * backup the live file, append the evicted lines to the archive, then rewrite
   * the live file atomically (tmp + rename). Never deletes a line destructively.
   * Best-effort: a failure leaves the durable file untouched (warn). Returns
   * true when the live file was rewritten.
   */
  private async pruneToCap(records: readonly FeedbackRecord[]): Promise<boolean> {
    // Group lines by logical record id (append order) + final estado.
    const groups = new Map<string, FeedbackRecord[]>()
    for (const record of records) {
      const group = groups.get(record.id)
      if (group === undefined) groups.set(record.id, [record])
      else group.push(record)
    }
    // Terminal logical records, OLDEST-first (by final tail updatedAt, then first createdAt).
    const terminalGroups = [...groups.values()]
      .filter((group) => isTerminalEstado(group[group.length - 1].estado))
      .sort((a, b) => {
        const aFinal = a[a.length - 1]
        const bFinal = b[b.length - 1]
        if (aFinal.updatedAt !== bFinal.updatedAt) return aFinal.updatedAt - bFinal.updatedAt
        return aFinal.createdAt - bFinal.createdAt
      })
    // Evict terminal groups until the live line count is within the cap.
    const evictIds = new Set<string>()
    let evictedLines = 0
    for (const group of terminalGroups) {
      if (records.length - evictedLines <= this.liveCap) break
      evictIds.add(group[0].id)
      evictedLines += group.length
    }
    if (evictIds.size === 0) return false
    try {
      const nowMs = Date.now()
      const backupPath = path.join(this.stateDir, `feedback.jsonl.bak-${nowMs}-prune`)
      await copyFile(this.filePath, backupPath)
      const evictedLinesList: FeedbackRecord[] = []
      const remaining: FeedbackRecord[] = []
      for (const record of records) {
        if (evictIds.has(record.id)) evictedLinesList.push(record)
        else remaining.push(record)
      }
      const archiveText = evictedLinesList.map((record) => JSON.stringify(record)).join('\n') + '\n'
      await mkdir(path.dirname(this.archivePath), { recursive: true })
      await appendFile(this.archivePath, archiveText, 'utf8')
      await rewriteJsonl(this.filePath, remaining)
      this.logger?.warn(`[deepartments] feedback prune: moved ${evictIds.size} terminal record(s) (${evictedLines} line(s)) to ${path.basename(this.archivePath)} (live cap ${this.liveCap}; backup ${path.basename(backupPath)})`)
      return true
    } catch (error: unknown) {
      this.logger?.warn(`[deepartments] feedback prune failed (the durable file is left untouched): ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private validateInput(input: FeedbackInput): void {
    if (typeof input.emisor !== 'string' || input.emisor.length === 0) {
      throw new TypeError('dshd-feedback: `emisor` must be a non-empty member id')
    }
    if (input.tipo !== 'fallo' && input.tipo !== 'mejora') {
      throw new TypeError(`dshd-feedback: unknown tipo "${String(input.tipo)}" (expected "fallo" | "mejora")`)
    }
    if (input.severidad !== 'critico' && input.severidad !== 'alto' && input.severidad !== 'medio' && input.severidad !== 'bajo') {
      throw new TypeError(`dshd-feedback: unknown severidad "${String(input.severidad)}"`)
    }
    if (typeof input.resumen !== 'string' || input.resumen.length === 0) {
      throw new TypeError('dshd-feedback: `resumen` must be a non-empty string')
    }
    if (input.source !== undefined && input.source !== 'dshd-feedback' && input.source !== 'quality-inspect') {
      throw new TypeError(`dshd-feedback: unknown source "${String(input.source)}"`)
    }
    if (input.duplicate_of !== undefined && (typeof input.duplicate_of !== 'string' || !/^fb-\d+$/.test(input.duplicate_of))) {
      throw new TypeError(`dshd-feedback: duplicate_of must be a canonical feedback id ("fb-<seq>"), got "${String(input.duplicate_of)}"`)
    }
  }
}

/** Defensive limit normalization: positive integer, capped at 100. */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return 20
  return Math.min(limit, 100)
}

// ---------------------------------------------------------------------------
// P1 (MODULARIZACIÓN, 2026-08-29) — the dshd-feedback Cordis PLUGIN surface.
// Thin name/inject/apply (the dshd-core/dshd-webfetch pattern): the package
// now ALSO composes as a real plugin row (cordis.patch.yml) and provides
// `deepartments.feedback` — the opened feedback store the bundle formerly
// constructed INLINE per apply (invoke.ts `FeedbackStore.open`). The store is
// LAZY (built on FIRST service use, never at apply time — an apply must be
// side-effect free); deps are injected via the FASE 2.6 seam, never imported
// from the bundle: stateDir comes from `ctx.get('deepartments.org')` (the
// dshd-core SHARED CONFIG SOURCE) and — once the DECOUPLING hito lands — the
// bundle's ALREADY-OPENED per-apply instance arrives through a future
// `deepartments.feedbackDeps` holder (`feedback.store`); since the 9-bucket
// register (LANE DI-BY-SERVICES) NEVER carried a feedback bucket, the service
// ALWAYS opened its own store from the shared stateDir (same files, same
// semantics — the bundle's inline store remains the live one, R6). A required
// dep missing at USE FAILS LOUD (R1), never a silently-unbound surface.
// Nothing is removed: the existing exports (the drop-in bridge superset) stay
// intact.
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'

/** The FASE 2.6 deps-holder bucket for the feedback service (STRUCTURAL — a
 * future `deepartments.feedbackDeps` holder; the DECOUPLING bundle may fill it
 * with the already-open store). */
export interface FeedbackBinderDeps {
  /** The bundle's ALREADY-OPENED per-apply feedback store (DECOUPLING). Absent
   * → the service opens its own from the shared org stateDir. */
  store?: FeedbackStore
}

/** The `deepartments.feedback` service surface — the opened store the bundle's
 * `dept_feedback*` tools own (the "service provided inline today"). */
export interface FeedbackSurface {
  /** The opened FeedbackStore (load + prune-to-cap + live-by-id index). */
  storeReady: Promise<FeedbackStore>
}

/** The dshd-feedback plugin config (minimal — the org stateDir is NOT copied
 * here: it resolves from the shared `deepartments.org` source, one truth). */
export interface FeedbackConfig {
  /** Optional open options for the lazily-opened store (liveCap / logger).
   * Absent → the defaults (DEFAULT_LIVE_CAP, no logger). */
  open?: FeedbackOpenOptions
}

export const name = 'dshd-feedback'
// Resolve everything via `ctx.get` at USE (inject EMPTY) so the plugin stays
// loadable in minimal compositions (the dshd-core discipline).
export const inject: string[] = []

export function apply(ctx: Context, config: FeedbackConfig = {}) {
  // Lazy on-first-use facade (the derived service contract: never built at
  // apply time — an apply registers the seam, the build happens on demand).
  let cache: FeedbackSurface | undefined
  const build = (): FeedbackSurface => {
    const org = ctx.get('deepartments.org') as { stateDir?: string } | undefined
    if (org?.stateDir === undefined) {
      throw new Error('[deepartments] feedback lazy build: ctx.get("deepartments.org") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.org)')
    }
    // DI-by-services (FASE 2 — R6 byte-igual): the DECOUPLING bundle's
    // already-open store was NEVER registered through the binder (the 9-bucket
    // register had no feedback bucket and no top-level `store` — the old
    // late-binding read here always resolved undefined), so
    // the service ALWAYS opened its own from the shared org stateDir. The dead
    // binder read is GONE — the open-from-stateDir path is the sole (and
    // identical) behavior. `FeedbackBinderDeps` (the structural `store?` seam)
    // stays exported for any FUTURE holder registration.
    const storeReady = FeedbackStore.open(org.stateDir, config.open)
    return { storeReady }
  }
  ctx.provide('deepartments.feedback', {
    get storeReady(): Promise<FeedbackStore> { return (cache ??= build()).storeReady }
  })
}
