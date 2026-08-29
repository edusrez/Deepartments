// dshd-feedback — the deepartments UNIVERSAL FEEDBACK STORE (the dshd-feedback
// phase of the modular Cordis split). A PURE LIBRARY package: it owns the
// durable append-only feedback backlog `<stateDir>/feedback.jsonl` + the
// archive `feedback-archive.jsonl` (non-destructive prune), the record schema
// (m-371), the append-only state machine (abierto → en-estudio → resuelto |
// descartado, reopen only en-estudio→abierto, NEVER from a terminal state), the
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

/** Backlog state. `resuelto`/`descartado` are TERMINAL. */
export type FeedbackEstado = 'abierto' | 'en-estudio' | 'resuelto' | 'descartado'

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
}

/** The update input (append-only transition): each provided field becomes the
 * new tail line's value; estado follows the state machine. */
export interface FeedbackUpdateInput {
  estado?: FeedbackEstado
  notas_qh?: string
  escalado?: boolean
  escalado_a?: string
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

/** Whether an estado is TERMINAL (resolved/discarded — no further transitions). */
export function isTerminalEstado(estado: FeedbackEstado): boolean {
  return estado === 'resuelto' || estado === 'descartado'
}

/**
 * The append-only state machine transition rule (m-371): returns an error string
 * when `current → next` is ILLEGAL, `undefined` when allowed.
 *
 * Rule: `abierto`/`en-estudio` are OPEN (transitionable); `resuelto`/`descartado`
 * are TERMINAL — a terminal record NEVER transitions again (reopen is never
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
 */
export class FeedbackStore {
  private readonly stateDir: string
  private readonly filePath: string
  private readonly archivePath: string
  private readonly liveCap: number
  private readonly logger: FeedbackStoreLogger | undefined
  private records: FeedbackRecord[] = []
  private readonly byId = new Map<string, FeedbackRecord>()
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
   * the max seq + 1. Missing file → empty store. A malformed non-final line
   * throws loud; a trailing partial line is dropped.
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
    store.load(records)
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
   * 'dshd-feedback', estado default 'abierto'. Flushed to disk AWAITED before
   * the in-memory index updates (persist-before-deliver).
   */
  async append(input: FeedbackInput): Promise<FeedbackRecord> {
    this.validateInput(input)
    const seq = this.nextSeq
    const ts = Date.now()
    const record: FeedbackRecord = {
      id: `fb-${seq}`,
      createdAt: ts,
      updatedAt: ts,
      emisor: input.emisor,
      source: input.source ?? 'dshd-feedback',
      tipo: input.tipo,
      severidad: input.severidad,
      estado: 'abierto',
      resumen: input.resumen
    }
    if (input.archivo_linea !== undefined) record.archivo_linea = input.archivo_linea
    if (input.event !== undefined) record.event = input.event
    if (input.evidencia !== undefined) record.evidencia = input.evidencia
    if (input.report_path !== undefined) record.report_path = input.report_path
    await appendFeedbackRecord(this.filePath, record)
    this.nextSeq = seq + 1
    this.records.push(record)
    this.byId.set(record.id, record)
    return record
  }

  /**
   * Append-only transition: apply an update to the LIVE record (the same id,
   * NEW tail line with a bumped `updatedAt`). Validates the state-machine
   * transition; `cerradoPor` (the QH) is stamped when the new estado is
   * TERMINAL. Returns the new live record. Throws on an unknown id or an
   * illegal transition.
   */
  async update(id: string, input: FeedbackUpdateInput, opts: { cerradoPor?: string } = {}): Promise<FeedbackRecord> {
    const current = this.byId.get(id)
    if (current === undefined) throw new Error(`[deepartments] feedback: no record with id "${id}"`)
    const nextEstado = input.estado ?? current.estado
    const transitionError = feedbackTransitionError(current.estado, nextEstado)
    if (transitionError !== undefined) {
      throw new Error(`[deepartments] feedback ${id}: ${transitionError}`)
    }
    const ts = Date.now()
    const next: FeedbackRecord = { ...current, updatedAt: ts, estado: nextEstado }
    if (input.notas_qh !== undefined) next.notas_qh = input.notas_qh
    if (input.escalado !== undefined) next.escalado = input.escalado
    if (input.escalado_a !== undefined) next.escalado_a = input.escalado_a
    if (isTerminalEstado(nextEstado) && opts.cerradoPor !== undefined) next.cerrado_por = opts.cerradoPor
    await appendFeedbackRecord(this.filePath, next)
    this.records.push(next)
    this.byId.set(id, next)
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

  private load(records: FeedbackRecord[]): void {
    this.records = records
    this.byId.clear()
    this.nextSeq = 0
    for (const record of records) {
      this.byId.set(record.id, record) // latest tail wins (file order = append order)
      const seq = parseFeedbackSeq(record.id)
      if (seq >= this.nextSeq) this.nextSeq = seq + 1
    }
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
// bundle's ALREADY-OPENED per-apply instance arrives through the
// `deepartments.binder` bucket (`feedback.store`); until then the service
// opens its own store from the shared stateDir (same files, same semantics —
// the bundle's inline store remains the live one, R6). A required dep missing
// at USE FAILS LOUD (R1), never a silently-unbound surface. Nothing is removed:
// the existing exports (the drop-in bridge superset) stay intact.
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'

/** The FASE 2.6 binder bucket for the feedback service (STRUCTURAL — read from
 * `ctx.get('deepartments.binder')` widened; dshd-core's BinderDeps carries the
 * core buckets, this one is filled by the DECOUPLING bundle). */
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
    // FASE 2.6 injection: the DECOUPLING bundle's already-open store wins when
    // registered via the binder; otherwise open from the shared stateDir.
    const binder = ctx.get('deepartments.binder') as { get(): unknown } | undefined
    const bound = (binder?.get() ?? {}) as FeedbackBinderDeps
    const storeReady = bound.store !== undefined
      ? Promise.resolve(bound.store)
      : FeedbackStore.open(org.stateDir, config.open)
    return { storeReady }
  }
  ctx.provide('deepartments.feedback', {
    get storeReady(): Promise<FeedbackStore> { return (cache ??= build()).storeReady }
  })
}
