// dshd-health — the Deepartments system-health DOMAIN (the dshd-health phase
// of the modular Cordis split). A PURE LIBRARY package (NO cordis plugin, NO
// tool, NO patch — the owner-confirmed MODO LIB, precedent 0f792cd — superseded
// for the PLUGIN surface by P1, 2026-08-29: the bottom of this file adds a thin
// name/inject/apply + the `deepartments.health` service; the scan/tick surface
// stays MODO LIB, the daemon EFFECT is now ALSO exposed with binder-injected
// deps): it owns the W6 system-health machinery extracted VERBATIM from the
// bundle (src/invoke.ts, extraction map
// 2026-08-27-health-quality-extraction-map.md):
//   - the POST-ERROR capture (readPostErrorsFile/appendPostError, C9 window)
//     + the durable UNUSABLE-SESSION markers (B5, all 5 symbols),
//   - the heartbeat / alerts ledger + audit (C4 cap) / error-identity (Bug C),
//   - the W8-i 'session not found' class + per-class recording dedupe,
//   - the M3 per-recipient interrupt back-off (safeInterrupt) + the
//     materialization-cascade quarantine,
//   - the W8-c safeguards (turn-error capture, stale-live watchdog, preset
//     audit — auditPresetText uses dshd-core BOUND_TEMPLATE_VARS),
//   - the W8-d system heartbeat (wait scan, inbox reader, heartbeat section),
//   - the W8-h interrupted-post boot reconciliation,
//   - the C6 delivery-row tail-reader FACTORY (createDeliveryRowsTailReader —
//     the per-process byte-offset cursor lives in the factory's closure, created
//     by the BUNDLE wiring once per daemon; twin-safe: it points INTO the shared
//     append-only deliveries.jsonl, so a twin daemon's rows are exposed to both)
//     + the scans + the pure tick runHealthDaemonTick (stateless except deps;
//     ledgers on-disk).
//
// SPLIT BOUNDARY (what MOVED vs what STAYED in the bundle):
//   - MOVED: the public surface below (constants, fs-pure helpers, scans, the
//     tick) + the private INTERRUPT_CANCEL_CAUSE/INTERRUPT_CANCEL_OPTIONS
//     (safeInterrupt) + formatHeartbeatAge (buildHeartbeatSection).
//   - STAYED in src/invoke.ts: the DAEMON WIRING (the setInterval + the ONE
//     per-daemon createDeliveryRowsTailReader call + the notifyHost closure
//     that store.append + busDeliverToHost-delivers the ALERT — C8), the
//     deliverDaemonNotice gate (shared scheduler/monitor), and the QD gate
//     CALL-SITES (the retire/head-slept inspect DICE, Lote Q — the gate
//     DECISION + directive text live in the dshd-quality LIB; only the
//     call-sites/emitter stay in the bundle), and every bundle call-site
//     (assembleHeartbeat, the W8-h boot
//     reconciliation, the scheduler/retire captures, the busDeliverToPost/Host
//     catches, the B5 boot reconcile/materializePost marks, the preset audit).
//
// DEPENDENCIES: node:fs + node:path + `dshd-core` (workspace:*) — the shared
// core state machinery: parseDeliveryRows/resolveDeliveriesPath/
// parseMessageRecords/resolveMessagesPath (+ type DeliveryRow), the durable
// registry readers readDurableHostEntries/readDurableRetiredHostIds/
// pickLiveHostEntry (+ type HostEntryLike) and the wake-pack
// BOUND_TEMPLATE_VARS. M1 adds `dshd-quality` (workspace:*, a leaf package —
// dshd-quality depends on NOTHING, so no cycle): the exported
// QUALITY_INSPECT_WORKER_RETIRED_PREFIX, the SINGLE literal the qi-silence
// watchdog matches messages.jsonl records against (one literal, no drift).
//
// CONFIG SPLIT: the tick's `config` dep is a STRUCTURAL HealthConfigLike
// (declared below) — ONLY the `health.*` knobs the tick reads. The bundle
// passes its org.ts Config cast structurally; there is NO back-dependency
// bundle→package (org.ts stays bundle-only).
//
// NO export default (pitfall 0001 — breaks `inject`).
import { readFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename, appendFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import {
  parseDeliveryRows,
  resolveDeliveriesPath,
  parseMessageRecords,
  resolveMessagesPath,
  readDurableHostEntries,
  readDurableRetiredHostIds,
  pickLiveHostEntry,
  BOUND_TEMPLATE_VARS
} from 'dshd-core'
import { QUALITY_INSPECT_WORKER_RETIRED_PREFIX } from 'dshd-quality'
// PACING (owner m-PACING, 2026-08-28) — the peak/valley FRANJA domain: the
// pure UTC window machinery the transition monitor runs on EVERY tick
// (isPeakAt / pacingStateAt / pacingWindowFromConfig / countPendingWorkRegister
// + the structural PacingConfigLike mirror). Same workspace dependency as the
// registry readers above — no cycle.
import { isPeakAt, pacingStateAt, pacingWindowFromConfig, countPendingWorkRegister } from 'dshd-core'
import type { PacingConfigLike, PacingState } from 'dshd-core'
import type { DeliveryRow, HostEntryLike } from 'dshd-core'

/** The semantic interrupt cancel-cause: a `hook` cause whose `reason` carries
 * 'interrupted' (the harness `AgentCancelCause` union has no literal kind). */
const INTERRUPT_CANCEL_CAUSE = { kind: 'hook', reason: 'interrupted' } as const

/** The abort options: `keepInbox: true` preserves any already-pending inbox
 * work so the interrupt never loses an earlier queued item. */
const INTERRUPT_CANCEL_OPTIONS = { keepInbox: true } as const

// ---------------------------------------------------------------------------
// W6 system-health (owner request 2026-08-23: "monitorizar que todo va bien").
// Two halves: (1) POST-ERROR CAPTURE — the bus materialization/wake seam
// records every head/worker session create/resume/wake failure to
// `<stateDir>/post-errors.jsonl` (bounded to the most-recent 500 lines); (2)
// the HEALTH DAEMON — a plugin daemon that every `health.intervalMs` (default
// 60000) writes `<stateDir>/health-heartbeat.json`, scans post-errors.jsonl +
// deliveries.jsonl (delivery 'failed' rows) for anomalies inside
// HEALTH_ERROR_WINDOW_MS, dedupes per key inside HEALTH_DEDUPE_WINDOW_MS and,
// on a net-new anomaly, alerts the HOST (the Asistente) by bus. The tick is
// PURE (injected clock + injected notify hook) so the tests drive it
// deterministically with a fixed clock. NEVER throws (every internal failure
// is a warn).
// ---------------------------------------------------------------------------

/** A recorded post (head/worker) session create/resume/wake failure. */
export interface PostErrorEntry {
  /** The failure ts (ms epoch). */
  ts: number
  /** The durable member id (a postId, or the hostId for a host delivery). A
   * W8-c scheduler no-fire records postId 'scheduler'. */
  postId: string
  /** The bus message id whose delivery failed (when known). */
  messageId?: string
  /** The captured error message. */
  error: string
  /** fb-25 (b) — the SESSION PROVENANCE of the failed turn (when known): the
   * session id whose event log carried the turn/end error. The turn-error
   * capture attaches it from the post's live session at capture time, so the
   * post-error scan/alert can show "this error belongs to the ARCHIVED
   * session <id>", never implying the FRESH session failed. Absent (legacy /
   * non-turn-capture rows) → omitted (R6 — the {ts,postId,error} shape never
   * changes). */
  sessionId?: string
  /** fb-25 (b) — the TURN NUMBER of the failed turn/end event (when known). */
  turn?: number
  /** W8-c scheduler-visibility: the jobId whose agenda auto-run did not fire
   * (when the row is a scheduler no-fire). */
  jobId?: string
  /** W8-c scheduler-visibility: the no-fire reason ('no head' |
   * 'idempotency-skip' | the thrown error text). */
  reason?: string
}

export const POST_ERRORS_FILE = 'post-errors.jsonl'
/** The bounded record cap of post-errors.jsonl (the oldest lines are trimmed). */
export const POST_ERRORS_MAX_LINES = 500
/** The forensia archive of the C9 discard: `<stateDir>/post-errors-archive.jsonl`
 * — append-only (the durable evidence store; a row the HEALTH_ERROR_WINDOW_MS
 * window drops from the LIVE file is ARCHIVED here first, never deleted). */
export const POST_ERRORS_ARCHIVE_FILE = 'post-errors-archive.jsonl'
/** The LARGE record cap of the post-errors archive (the rotation trigger). The
 * feedback.jsonl/messages pattern: the live file is tightly bounded (500 rows,
 * 2h window), the archive is the durable evidence with a large cap + an R6
 * backup on rotation (the full pre-rotation archive survives in a
 * `post-errors-archive.jsonl.bak-<ts>-rotate` copy — reversible, never delete
 * evidence). */
export const POST_ERRORS_ARCHIVE_MAX_LINES = 50_000
/** The bounded record cap of health-alerts.jsonl (the oldest audit lines are
 * trimmed on append, mirroring POST_ERRORS_MAX_LINES — C4). */
export const HEALTH_ALERTS_MAX_LINES = 500

/** Pure row-mapping of post-error JSONL lines (the reader-side validation is the
 * single source of truth for the row shape: a line without a numeric `ts` or a
 * string `postId` is dropped, mirroring the append-side C9 filter). */
function parsePostErrorLines(lines: readonly string[]): PostErrorEntry[] {
  const out: PostErrorEntry[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const entry = parsed as Record<string, unknown>
    if (typeof entry.ts !== 'number' || typeof entry.postId !== 'string') continue
    out.push({
      ts: entry.ts,
      postId: entry.postId,
      ...(typeof entry.messageId === 'string' ? { messageId: entry.messageId } : {}),
      error: typeof entry.error === 'string' ? entry.error : '',
      ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
      ...(typeof entry.turn === 'number' && Number.isFinite(entry.turn) ? { turn: entry.turn } : {}),
      ...(typeof entry.jobId === 'string' ? { jobId: entry.jobId } : {}),
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {})
    })
  }
  return out
}

/** Read `<stateDir>/post-errors.jsonl` → the bounded post-error rows, in file
 * order. Absent / unreadable / malformed → [] (never throws); a malformed line
 * (e.g. a partial append) is dropped, mirroring the other JSONL readers. */
export function readPostErrorsFile(stateDir: string): PostErrorEntry[] {
  try {
    const text = readFileSync(path.join(stateDir, POST_ERRORS_FILE), 'utf8')
    // Filter the (possibly trailing) empty line BEFORE slicing so the bounded
    // window is exactly the most-recent POST_ERRORS_MAX_LINES content rows (a
    // trailing '\n' would otherwise shift the slice by one).
    const lines = text.split('\n').filter((line) => line.trim() !== '').slice(-POST_ERRORS_MAX_LINES)
    return parsePostErrorLines(lines)
  } catch {
    return []
  }
}

/** Read `<stateDir>/post-errors-archive.jsonl` → the ARCHIVED post-error rows
 * (the append-only forensia archive the C9 discard fills — see
 * `archivePostErrorLines`), in file order (oldest first). Absent / unreadable /
 * malformed → [] (never throws); a malformed line is dropped, mirroring
 * `readPostErrorsFile`. Sliced to the archive cap so an oversized raw-written
 * archive still reads bounded (the rotation keeps it ≤ the cap anyway). */
export function readPostErrorsArchiveFile(stateDir: string): PostErrorEntry[] {
  try {
    const text = readFileSync(path.join(stateDir, POST_ERRORS_ARCHIVE_FILE), 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '').slice(-POST_ERRORS_ARCHIVE_MAX_LINES)
    return parsePostErrorLines(lines)
  } catch {
    return []
  }
}

/** Append ONE post-error row to `<stateDir>/post-errors.jsonl` and keep the
 * file BOUNDED: rows OLDER than the HEALTH_ERROR_WINDOW_MS anomaly window are
 * DISCARDED AT APPEND (C9 — the scan window-filters the same rows
 * (`scanPostErrorFindings`), so a row the scan can never alert is pure hygiene
 * to drop), and the file stays capped to the most-recent POST_ERRORS_MAX_LINES
 * surviving rows (read + append + window-discard + slice-most-recent on write).
 * ARCHIVE-ON-DISCARD (forensia): BEFORE the C9 discard drops an expired row
 * from the live file, the row is appended to the durable archive
 * `<stateDir>/post-errors-archive.jsonl` (see `archivePostErrorLines`) — the
 * evidence NEVER vanishes, the live file keeps its tight bounding (C9 intact).
 * `nowMs` is injectable (default Date.now()) so tests are deterministic; every
 * production call-site ends a fresh `ts` nearby `now`, so nothing observable
 * changes there. mkdir -p the dir first; a malformed/nonexistent file degrades
 * to empty (the append still lands). Never throws — callers fold a persist
 * failure into a warn. */
export async function appendPostError(stateDir: string, entry: PostErrorEntry, nowMs: number = Date.now()): Promise<void> {
  const filePath = path.join(stateDir, POST_ERRORS_FILE)
  await mkdir(path.dirname(filePath), { recursive: true })
  const lines: string[] = []
  try {
    const existing = await readFile(filePath, 'utf8')
    lines.push(...existing.split('\n').filter((line) => line.trim() !== ''))
  } catch {
    /* ENOENT or unreadable → a cold start; lines stays [] */
  }
  lines.push(JSON.stringify(entry))
  // C9: drop parsed rows older than the anomaly window BEFORE the cap-slice. A
  // line that fails to parse (e.g. a crash-mid-append partial) is KEPT (the
  // read side drops it anyway), and a row without a numeric ts is KEPT too (the
  // reader-side validation is the single source of truth for the row shape).
  // ARCHIVE-ON-DISCARD: the rows the window filter EXPIRES are archived (never
  // deleted) before they leave the live file; the fresh rows go through the
  // unchanged cap-slice.
  const inWindow: string[] = []
  const expired: string[] = []
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      inWindow.push(line)
      continue
    }
    const row = parsed as { ts?: unknown }
    if (typeof row.ts !== 'number' || nowMs - row.ts <= HEALTH_ERROR_WINDOW_MS) inWindow.push(line)
    else expired.push(line)
  }
  if (expired.length > 0) await archivePostErrorLines(stateDir, expired, nowMs)
  const bounded = inWindow.slice(-POST_ERRORS_MAX_LINES)
  await writeFile(filePath, bounded.join('\n') + '\n', 'utf8')
}

/** Append the C9-expired rows to the durable evidence archive
 * `<stateDir>/post-errors-archive.jsonl` — append-only, the forensia half of
 * the discard: evidence is ARCHIVED, never deleted. R6 rotation when the
 * archive grows past POST_ERRORS_ARCHIVE_MAX_LINES: FIRST a FULL pre-rotation
 * backup (`post-errors-archive.jsonl.bak-<ts>-rotate` — the whole archive,
 * new batch included, survives byte-for-byte → reversible), THEN the archive is
 * rewritten holding the newest POST_ERRORS_ARCHIVE_MAX_LINES rows. The new
 * batch lands FIRST (a failed rotation aborts the trim, never the batch — an
 * over-cap archive stays intact until a backup succeeds). Best-effort (never
 * throws): a persist failure degrades silently — the live C9 append must still
 * land. */
async function archivePostErrorLines(stateDir: string, lines: readonly string[], nowMs: number): Promise<void> {
  const archivePath = path.join(stateDir, POST_ERRORS_ARCHIVE_FILE)
  await mkdir(path.dirname(archivePath), { recursive: true })
  try {
    const existing: string[] = []
    try {
      const text = await readFile(archivePath, 'utf8')
      existing.push(...text.split('\n').filter((line) => line.trim() !== ''))
    } catch {
      /* ENOENT or unreadable → a cold archive; existing stays [] */
    }
    const merged = [...existing, ...lines]
    await appendFile(archivePath, lines.join('\n') + '\n', 'utf8')
    if (merged.length > POST_ERRORS_ARCHIVE_MAX_LINES) {
      const backupPath = path.join(stateDir, `post-errors-archive.jsonl.bak-${nowMs}-rotate`)
      await copyFile(archivePath, backupPath)
      const kept = merged.slice(-POST_ERRORS_ARCHIVE_MAX_LINES)
      await writeFile(archivePath, kept.join('\n') + '\n', 'utf8')
    }
  } catch {
    /* a failed archive is a silent best-effort (never throws — the live C9
       append still lands); a failed BACKUP aborts the trim, so the over-cap
       archive stays intact: evidence is never truncated without a backup */
  }
}

// ---------------------------------------------------------------------------
// B5 — the durable "unusable worker session" marker.
// ---------------------------------------------------------------------------
// A worker whose materialization throws the harness `agent "session-<uuid>" has
// no provider/model` error (the VARIANT-2 / builder-87 ghost — a DURABLE session
// PRESENT but with NO usable AgentOptions) is recorded here so the boot
// reconcile's `isSessionUnusable` resolver can classify it as a retire-leak
// candidate WITHOUT needing to inspect the session content (which carries no
// provider/model field). The marker is CLEARED on a successful materialization,
// and CHECKED against the current sessionId — so a worker that recovers (a later
// create with proper options) is never over-retired (conservative). A new
// sidecar file (not a posts.json field) keeps the on-disk registry shape
// unchanged (R6).

/** The marker sidecar filename: `<stateDir>/unusable-agent-options.json`. */
export const UNUSABLE_SESSIONS_FILE = 'unusable-agent-options.json'

/** One durable "unusable worker session" mark (the latest per worker postId). */
export interface UnusableSessionMark {
  sessionId: string
  ts: number
  error: string
}

/** Read `<stateDir>/unusable-agent-options.json` → `{ [postId]: mark }`.
 * Absent / unreadable / malformed → {} (never throws). */
export function readUnusableSessionsMark(stateDir: string): Record<string, UnusableSessionMark> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, UNUSABLE_SESSIONS_FILE), 'utf8')) as Record<string, unknown>
    const out: Record<string, UnusableSessionMark> = {}
    for (const [postId, raw] of Object.entries(parsed)) {
      if (raw === null || typeof raw !== 'object') continue
      const m = raw as Record<string, unknown>
      if (typeof m.sessionId !== 'string') continue
      out[postId] = {
        sessionId: m.sessionId,
        ts: typeof m.ts === 'number' ? m.ts : 0,
        error: typeof m.error === 'string' ? m.error : ''
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/unusable-agent-options.json` atomically (mkdir -p first).
 * Never throws — callers fold a persist failure into a warn. */
export async function writeUnusableSessionsMark(stateDir: string, marks: Record<string, UnusableSessionMark>): Promise<void> {
  try {
    await mkdir(path.dirname(path.join(stateDir, UNUSABLE_SESSIONS_FILE)), { recursive: true })
    const tmpPath = path.join(stateDir, `${UNUSABLE_SESSIONS_FILE}.tmp-${Date.now()}`)
    await writeFile(tmpPath, JSON.stringify(marks, null, 2), 'utf8')
    await rename(tmpPath, path.join(stateDir, UNUSABLE_SESSIONS_FILE))
  } catch (error: unknown) {
    // Never throw — the marker is a conservative hint, not a hard requirement.
  }
}

/** Record (or refresh) the unusable mark for a worker post. */
export async function markUnusableWorkerSession(stateDir: string, postId: string, sessionId: string, error: string): Promise<void> {
  const marks = readUnusableSessionsMark(stateDir)
  marks[postId] = { sessionId, ts: Date.now(), error }
  await writeUnusableSessionsMark(stateDir, marks)
}

/** Clear the unusable mark for a worker post (a SUCCESSFUL materialization —
 * the worker is usable again). */
export async function clearUnusableWorkerSession(stateDir: string, postId: string): Promise<void> {
  const marks = readUnusableSessionsMark(stateDir)
  if (marks[postId] === undefined) return
  delete marks[postId]
  await writeUnusableSessionsMark(stateDir, marks)
}

/** The heartbeat written every daemon tick. */
export interface HealthHeartbeat {
  ts: number
  bootId: string
}

/** Read `<stateDir>/health-heartbeat.json` (absent/unreadable/malformed → undefined). */
export function readHealthHeartbeatFile(stateDir: string): HealthHeartbeat | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, 'health-heartbeat.json'), 'utf8')) as Record<string, unknown>
    if (typeof parsed.ts === 'number' && typeof parsed.bootId === 'string') return { ts: parsed.ts, bootId: parsed.bootId }
    return undefined
  } catch {
    return undefined
  }
}

/** Write `<stateDir>/health-heartbeat.json` (mkdir -p the dir, then the file). */
export async function writeHealthHeartbeatFile(stateDir: string, heartbeat: HealthHeartbeat): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, 'health-heartbeat.json')), { recursive: true })
  await writeFile(path.join(stateDir, 'health-heartbeat.json'), JSON.stringify(heartbeat), 'utf8')
}

// ---------------------------------------------------------------------------
// fb-43 (2026-09-01) — the RESTART-REGISTRY: the durable, append-only audit of
// every daemon boot (the memory-closing line for the department heads — the
// documented historical restarts no longer live only in the heads' memory).
// `<stateDir>/restart-registry.jsonl` holds one row per daemon BOOT
// `{ bootId, ts, cause }`:
//   - SEED (one-time): when the file is ABSENT (the registry's first start) it
//     is created with a provenance header comment + the FOUR documented
//     historical restart rows (seen 08-31/09-01 — the flota switch to glm at
//     08-31T22:31Z, the reversal to deepseek-v4-flash at 08-31T22:50Z, the
//     09-01T05:23:31Z UNKNOWN (investigation pending), and the version-watch
//     smart_restart canary reload at 09-01T06:08:57Z). A file that ALREADY
//     exists is NEVER re-seeded.
//   - APPEND (every new boot): the daemon (tick) compares the CURRENT
//     `bootId` (the EXISTING per-process boot id the bundle already stamps into
//     the heartbeat — REUSED, never duplicated) against the LAST row's bootId
//     (or the seed rows on the registry's first run); a NEW bootId → ONE row
//     `{ bootId, ts: nowMs, cause: 'unknown' }` (the cause is attributed
//     later/documentally; the runtime can only know the boot happened). A
//     same-boot re-tick sees the last row's bootId === the current → no append
//     (idempotent per boot).
// READ + DIGEST: `readRestartRegistry` parses the rows (comment lines are
// skipped — the post-errors reader pattern) and `buildRestartDigest` renders
// the last N restarts with their cause (for the pulse digest + debug). All
// helpers NEVER throw (a missing/malformed file degrades to [] / a no-op).
// ---------------------------------------------------------------------------

/** fb-43 — the restart-registry filename: `<stateDir>/restart-registry.jsonl`. */
export const RESTART_REGISTRY_FILE = 'restart-registry.jsonl'

/** fb-43 — ONE durable restart-registry row: a daemon boot (or a documented
 * historical restart). */
export interface RestartRegistryRow {
  /** The boot's id (the daemon's per-process bootId; the SEED rows carry
   * synthetic `seed-<n>` ids — the historical boots' real ids are unknown). */
  bootId: string
  /** The boot/restart moment (ms epoch). */
  ts: number
  /** The cause ('unknown' for a runtime-detected new boot; the documented
   * attribution for a seed row: 'switch flota glm' / 'reversión flota
   * deepseek-v4-flash' / 'DESCONOCIDA (pendiente investigación)' / 'reload
   * version-watch smart_restart canary'). */
  cause: string
}

/** fb-43 — the ONE-TIME historical seed: the 4 documented restarts the
 * registry closes from the heads' memory (ts ISO 2026-08-31/09-01, see the
 * block comment above for the attributions). */
export const RESTART_REGISTRY_SEED_ROWS: readonly RestartRegistryRow[] = [
  { bootId: 'seed-1', ts: Date.UTC(2026, 7, 31, 22, 31, 0), cause: 'switch flota glm' },
  { bootId: 'seed-2', ts: Date.UTC(2026, 7, 31, 22, 50, 0), cause: 'reversión flota deepseek-v4-flash' },
  { bootId: 'seed-3', ts: Date.UTC(2026, 8, 1, 5, 23, 31), cause: 'DESCONOCIDA (pendiente investigación)' },
  { bootId: 'seed-4', ts: Date.UTC(2026, 8, 1, 6, 8, 57), cause: 'reload version-watch smart_restart canary' }
]

/** The provenance header line the seed writes above the 4 historical rows. */
const RESTART_REGISTRY_SEED_HEADER =
  '# restart-registry (fb-43, 2026-09-01): append-only daemon-boot audit {bootId, ts, cause}. ' +
  'Seeded ONCE with the 4 documented historical restarts; every later new boot appends cause=\'unknown\' until attributed.'

/** Pure row-mapping of restart-registry JSONL lines (a non-JSON line — the
 * header comment or a crash-mid-append partial — is DROPPED, the
 * parsePostErrorLines pattern; a row without a string bootId / numeric ts is
 * dropped too). */
function parseRestartRegistryLines(lines: readonly string[]): RestartRegistryRow[] {
  const out: RestartRegistryRow[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const row = parsed as Record<string, unknown>
    if (typeof row.bootId !== 'string' || typeof row.ts !== 'number' || !Number.isFinite(row.ts)) continue
    out.push({
      bootId: row.bootId,
      ts: row.ts,
      cause: typeof row.cause === 'string' ? row.cause : 'unknown'
    })
  }
  return out
}

/** fb-43 — read `<stateDir>/restart-registry.jsonl` → the boot rows, in file
 * order (oldest first), the header comment skipped. Absent / unreadable /
 * malformed → [] (never throws). */
export function readRestartRegistry(stateDir: string): RestartRegistryRow[] {
  try {
    const text = readFileSync(path.join(stateDir, RESTART_REGISTRY_FILE), 'utf8')
    return parseRestartRegistryLines(text.split('\n'))
  } catch {
    return []
  }
}

/** fb-43 — write the restart-registry SEED (the provenance header + the 4
 * documented historical rows) when the file is ABSENT (mkdir -p the dir
 * first). A file that already exists is NEVER re-seeded (the seed is the
 * registry's one-time historical birth, not a per-boot reset). Never throws
 * (a persist failure degrades silently — the audit is best-effort). */
export async function seedRestartRegistry(stateDir: string): Promise<void> {
  const filePath = path.join(stateDir, RESTART_REGISTRY_FILE)
  try {
    await readFile(filePath, 'utf8')
    return // the file already exists → NO re-seed (the one-time seed contract)
  } catch {
    /* ENOENT → the first start: seed below */
  }
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    const lines = [RESTART_REGISTRY_SEED_HEADER, ...RESTART_REGISTRY_SEED_ROWS.map((row) => JSON.stringify(row))]
    await writeFile(filePath, lines.join('\n') + '\n', 'utf8')
  } catch {
    /* never throws — a failed seed degrades to a silent no-op */
  }
}

/** fb-43 — reconcile ONE daemon tick against the registry: seed-if-absent,
 * then append `{ bootId, ts: nowMs, cause: 'unknown' }` ONLY when the current
 * bootId is NOT the last row's (a NEW daemon boot — the bootId is the EXISTING
 * per-process boot id the bundle stamps into the heartbeat; REUSED, never
 * duplicated). A same-boot re-tick is a no-op (idempotent per boot). Never
 * throws. */
export async function reconcileRestartRegistry(stateDir: string, bootId: string, nowMs: number): Promise<void> {
  try {
    await seedRestartRegistry(stateDir)
    const rows = readRestartRegistry(stateDir)
    const last = rows[rows.length - 1]
    if (last !== undefined && last.bootId === bootId) return
    await mkdir(path.dirname(path.join(stateDir, RESTART_REGISTRY_FILE)), { recursive: true })
    await appendFile(path.join(stateDir, RESTART_REGISTRY_FILE), JSON.stringify({ bootId, ts: nowMs, cause: 'unknown' }) + '\n', 'utf8')
  } catch {
    /* never throws — the audit append is best-effort (the tick contract) */
  }
}

/** fb-43 — render the digest of the LAST N restarts with their cause (for the
 * pulse digest + debug). PURE — the caller reads the rows once and slices.
 * Empty → a single '(no restart-registry rows)' line. */
export function buildRestartDigest(rows: readonly RestartRegistryRow[], n: number): string {
  const last = rows.slice(-Math.max(1, Math.floor(n)))
  if (last.length === 0) return '(no restart-registry rows)'
  return last.map((row) => `- restart ${new Date(row.ts).toISOString()} (boot ${row.bootId}) cause=${row.cause}`).join('\n')
}

/** The dedupe ledger of the health daemon: key → lastAlertedAtMs. The key is the
 * per-anomaly dedupe key (`post-error:<postId>` / `delivery-failed:<messageId>`). */
export type HealthAlertsState = Record<string, number>

/** Read `<stateDir>/health-alerts-state.json` → `{ [key]: lastAlertedAtMs }`.
 * Absent / unreadable / malformed → {} (never throws). */
export function readHealthAlertsState(stateDir: string): HealthAlertsState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, 'health-alerts-state.json'), 'utf8')) as Record<string, unknown>
    const out: HealthAlertsState = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/health-alerts-state.json` (mkdir -p the dir, then the file). */
export async function writeHealthAlertsState(stateDir: string, state: HealthAlertsState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, 'health-alerts-state.json')), { recursive: true })
  await writeFile(path.join(stateDir, 'health-alerts-state.json'), JSON.stringify(state), 'utf8')
}

/** One detected system-health anomaly (grouped per dedupe key). */
export interface HealthFinding {
  /** The anomaly class. W8-c adds `config-preset` (a preset text holding an
   * unbound template reference) and `stalled-post` (a catalog-live post with no
   * session activity while it holds pending messages). W8-d adds `system-wait`
   * (a host-sent message to a post with no reply + no session activity within
   * `waitThresholdMs` — the conditional wake; NOT part of the System-health
   * ALERT frame, it rides `buildSystemWaitFrame`). M1 adds `pooler-capacity`
   * (the key-pooler capacity watchdog: usable-key count / blocks / 429-rotation
   * / stale state, warning|critical via the dedupe key), `qi-silence` (a
   * rate-aware silence of quality-inspect directives over worker retirements —
   * the anti-hang guarantee over the worker-retire trigger) and M4 adds
   * `system-idle` (the GLOBAL-quiet watchdog: zero catalog agents running for
   * >= `idleWindowMs` while SOME post still has pending work — the
   * 'the system stopped and the expected continuation never arrived' alarm).
    * M-A adds `context-threshold` (the context-pressure monitor: a post OR the
    * host using more than `contextThreshold` of its session context window —
    * a live agent on track to run out of context; the dedupe KEY is per-BAND
    * `context-threshold:<agentId>:b<floor(pct*10)>`). M-5 adds
    * `mission-stalled` (a HEAD post whose host→head mission DELIVERY — a
    * mission message the HOST handed to it — was never PROCESSED within
    * `missionStallMs` (default 600000 = 10 min): the «misión entregada a un
    * head pero NO INICIADA» alarm (the owner's gap); the dedupe KEY is
    * per-mission `mission-stall:<postId>:<messageId>`, re-alerting every
    * HEALTH_DEDUPE_WINDOW_MS while the mission stays unprocessed). M-6 adds
    * `main-red` (the post-commit re-verification watchdog: a NEW commit at the
    * dev repo HEAD — a light git poll at `mainRedPollMs` (default 300000 =
    * 5 min) sees `headSha ≠ last-seen` — runs ONLY the FAST locks (~seconds,
    * NEVER the full suite) via `node --test`; a failing lock → the «main rojo
    * post-commit <sha> — lock <X> falló (detectado en <N> min)» alarm (the
    * adopted lesson after the boot-factory anchor left the suite red on main
    * since f28c719 undetected for hours); the dedupe KEY is per-sha
    * `main-red:<sha>`, re-alerting every HEALTH_DEDUPE_WINDOW_MS while the
    * broken commit stays at HEAD). M-7 adds `mission-queue` (Fase 4 — the
     * head-mission QUEUE watchdog: a non-retired HEAD post whose PENDING
     * (undrained) message count — the buildPostSnapshot pendingCount — is
     * >= `missionQueueLimit` (default 5) SUSTAINED for >= `missionQueuePersistMs`
     * (default 60000 = one poll tick — a transient spike never alerts) → the
     * «cola de misiones <postId>: <n> pendientes sin drenar — posible backlog»
     * alarm; the dedupe KEY is per-post `mission-queue:<postId>` in the SHARED
     * ledger, re-alerting every HEALTH_DEDUPE_WINDOW_MS while the backlog
     * persists). LANE 5 adds `work-register-idle` (fb-46 — the docs-level
     * WORK-REGISTER watchdog: the register is the org's SINGLE pending-work
     * queue and NO watchdog reads it at the DOCS level — M4 system-idle only
     * sees the MESSAGE-level pendingCount. CONDITION: franja VALLE
     * (isPeakAt == false) ∧ countPendingWorkRegister > 0 ∧ ≥1 NON-GATED
     * (despatchable) item ∧ 0 agents running ∧ quiet ≥ `workRegisterIdleQuietMs`
     * → the «WORK-REGISTER con trabajo NO-gateado sin despachar» alarm; the
     * OWNER-GATED §3 PENDIENTE-OWNER section NEVER triggers it (an
     * owner-pending decision waits for the owner BY DESIGN — the frame lists
     * the NON-gated items and the dedupe KEY is `work-register-idle` in the
     * SHARED ledger, re-alerting every HEALTH_DEDUPE_WINDOW_MS while the
     * condition persists). */
  kind: 'post-error' | 'delivery-failed' | 'config-preset' | 'stalled-post' | 'system-wait' | 'pooler-capacity' | 'qi-silence' | 'system-idle' | 'context-threshold' | 'mission-stalled' | 'main-red' | 'mission-queue' | 'work-register-idle'
  /** The dedupe key (≤1 alert per key per HEALTH_DEDUPE_WINDOW_MS). */
  key: string
  /** The postId (post-error / stalled-post / context-threshold post row). */
  postId?: string
  /** The hostId (the context-threshold HOST row — the live host's own context
   * pressure; a host row has NO postId — the M4 host-not-a-pseudo-post rule). */
  hostId?: string
  /** The messageId (delivery-failed) — the bus record that failed delivery. */
  messageId?: string
  /** The most-recent row ts of the group (ms epoch). */
  ts: number
  /** The captured error message (post-error / config-preset — the unbound
   * template variable names; the literal double-brace token is never written). */
  error?: string
  /** The grouped row count (post-error / stalled-post / config-preset). */
  count?: number
  /** fb-25 (b) — the SESSION PROVENANCE of the post-error group's rows[0] (the
   * row whose `error` text + `count` the alert shows), when the row carried it
   * (the turn-error capture writes sessionId+turn). The host alert frame uses
   * it to show "this error is from the ARCHIVED session <id> turn <n>" —
   * pointing at the FRESH session is impossible once the provenance exists. */
  sessionId?: string
  /** fb-25 (b) — the turn number of the post-error group's rows[0] (when the
   * row carried it). */
  turn?: number
  /** fb-30 — the BOOT CATCH-UP marker: true ONLY on findings produced by the
   * boot catch-up pass (durable rows OUTSIDE the live 2 h window, WITHIN the
   * bounded 24 h look-back — the quiet-band recovery). The kind/key are the
   * SAME as the live scan's (the shared health-alerts ledger applies verbatim:
   * a catch-up finding never duplicates a live alert — the windows are
   * disjoint — and never re-alerts an already-alerted identity); the marker
   * only changes the FRAME (the bullet renders a `CATCH-UP` prefix — the host
   * sees the alert is a missed-window recovery, not a fresh anomaly). */
  catchup?: boolean
}

/** One alert audit line appended to `<stateDir>/health-alerts.jsonl`. */
export interface HealthAlertAuditEntry {
  ts: number
  findings: HealthFinding[]
  dedupeKeys: string[]
}

/** Append ONE audit row to `<stateDir>/health-alerts.jsonl` and keep the file
 * BOUNDED to the most-recent HEALTH_ALERTS_MAX_LINES rows (read + append +
 * slice-most-recent on write — the appendPostError pattern; C4). mkdir -p the
 * dir first; a malformed/nonexistent file degrades to a fresh append. Never
 * throws — callers fold a persist failure into a warn. */
export async function appendHealthAlertAudit(stateDir: string, entry: HealthAlertAuditEntry): Promise<void> {
  const filePath = path.join(stateDir, 'health-alerts.jsonl')
  await mkdir(path.dirname(filePath), { recursive: true })
  const lines: string[] = []
  try {
    const existing = await readFile(filePath, 'utf8')
    lines.push(...existing.split('\n').filter((line) => line.trim() !== ''))
  } catch {
    /* ENOENT or unreadable → a cold start; lines stays [] */
  }
  lines.push(JSON.stringify(entry))
  const bounded = lines.slice(-HEALTH_ALERTS_MAX_LINES)
  await writeFile(filePath, bounded.join('\n') + '\n', 'utf8')
}

/** Anomaly freshness window: only anomalies with `now - ts <= 2h` are scanned. */
export const HEALTH_ERROR_WINDOW_MS = 2 * 60 * 60 * 1000
/** Alert dedupe window: ≤1 alert per key inside this window. */
export const HEALTH_DEDUPE_WINDOW_MS = 30 * 60 * 1000
/** fb-30 CATCH-UP (LANE 4, 2026-09-01) — the BOUNDED BOOT look-back window
 * (24 h default): at the daemon's FIRST tick (a new boot), durable event rows
 * (post-errors + the C9 archive + failed deliveries) that are OLDER than the
 * live 2 h anomaly window but WITHIN this look-back are caught up ONCE (their
 * own CATCH-UP frame) — the quiet-band blind-window recovery (§3b of the VALLE
 * lane-A report: events that entered a freshness window [turn-error 10 min /
 * scan 2 h] during a capture gap with a LIVE heartbeat and were never
 * alerted). Rows BEYOND the look-back stay silent by design (the bound is
 * intentional — the harness never re-alerts ancient history). */
export const HEALTH_CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000

/** Bug C — the stable ERROR-IDENTITY token of a post-error finding. A stable
 * FNV-1a hash (hex) of the error message maps the SAME error string to the SAME
 * token, so the alert ledger can distinguish a delivered error stream from a
 * NEW occurrence: `post-error:<postId>:<errorIdentityHash(error)>`. The same
 * (postId, error) identity is delivered ONCE and NEVER re-alerts inside the
 * window; only a genuinely-NEW error identity alerts. PURE (deterministic, no
 * collision-sensitive crypto — the token is only a ledger key). */
export function errorIdentityHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

// ---------------------------------------------------------------------------
// W8-i (live production noise): the 'session "<id>" not found' host-delivery
// loop. A bus host delivery to a dormant host whose durable session is not yet
// workspace-attached throws `session "<id>" not found` from the
// session-persistence / session-query / api-remotes seam. The delivery seam was
// recording that transient first-attempt failure as a post-error, so the W6
// health daemon re-alerted the HOST every dedupe window — alert spam (16 rows
// live). THREE fixes: (1) RETRY a 'not found' through the host-attach repair
// seam BEFORE recording; (2) the post-error dedupe for this class is keyed per
// (post + class + window), NOT per messageId/attempt; (3) a later-retried
// SUCCESSFUL delivery leaves NO post-error row.
// ---------------------------------------------------------------------------

/** The W8-i 'session not found' error class token (the dedupe/alert class
 * suffix; the harness message shape is `session "<id>" not found`, incl. the
 * `(not attached)` suffix). */
export const POST_ERROR_CLASS_SESSION_NOT_FOUND = 'session-not-found'

/** The W8-i RECORDING-dedupe key prefix (distinct from the daemon's ALERT key
 * `post-error:<postId>:<class>` so the FIRST recorded 'not found' row still
 * ALERTS; a repeat inside the window re-records nothing). */
export const POST_ERROR_RECORD_KEY_PREFIX = 'record:post-error:'

/**
 * W8-i: the stable error CLASS of a post-error message (absent = the generic
 * class). The 'session not found' class is thrown by the session-persistence /
 * session-query / api-remotes seams when a bus resume cannot find the durable
 * session — the transient first-attempt failure that must be retried through
 * the host-attach repair seam BEFORE it is recorded. PURE. */
export function postErrorClass(error: string | unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error)
  return /session "[^"]*" not found/.test(message) ? POST_ERROR_CLASS_SESSION_NOT_FOUND : undefined
}

/** W8-i: whether an error is the 'session "<id>" not found' class. PURE. */
export function isSessionNotFoundError(error: unknown): boolean {
  return postErrorClass(error) === POST_ERROR_CLASS_SESSION_NOT_FOUND
}

/**
 * W8-i recording dedupe (the shared health-alerts-state.json ledger, the
 * W8-c/W8-d `key → lastAlertedAt` pattern): append ONE post-error row ONLY when
 * `key` is OUTSIDE HEALTH_DEDUPE_WINDOW_MS, then advance `key` to `nowMs`.
 * Returns whether a row was appended. The `key` is a RECORDING key (distinct
 * from the daemon's ALERT key) so the FIRST recorded row still ALERTS and a
 * repeat inside the window re-records nothing. If a persist write fails it
 * silently degrades to a best-effort append (never throws — the caller wraps a
 * warn). */
export async function appendPostErrorDeduped(stateDir: string, entry: PostErrorEntry, key: string, nowMs: number): Promise<boolean> {
  const state = readHealthAlertsState(stateDir)
  if (state[key] !== undefined && nowMs - state[key] <= HEALTH_DEDUPE_WINDOW_MS) return false
  // The recording `nowMs` doubles as the append's window clock (C9): the row was
  // just recorded as fresh, so it can never be discarded by the window filter.
  await appendPostError(stateDir, entry, nowMs)
  await writeHealthAlertsState(stateDir, { ...state, [key]: nowMs })
  return true
}

// ---------------------------------------------------------------------------
// M3 (dshd-error-handler): the per-recipient interrupt back-off + the
// materialization-cascade quarantine. Two CORE guards over the
// dispatch/materialization/post-error path (spec §2.4, §3.3):
//   (1) safeInterrupt — the interrupt-LOOP bound + re-entrancy guard;
//   (2) the per-host materialization-failure cooldown (the SAFEST subset of
//       R2/R3 — gates REPEATED post-error recording, keeps the durable repair).
// ---------------------------------------------------------------------------

/** M3 — the per-recipient interrupt cooldown. At most ONE bus interrupt (a live
 * turn aborted with reason 'interrupted') per recipient per this window is
 * ALLOWED, regardless of how many net-new alert identities/classes/rows appear
 * — a host turn can be canceled at most once per cooldown (identity-independent),
 * which is BOTH the primary interrupt-loop bound AND the re-entrancy guard (a
 * turn the daemon just interrupted is within the cooldown → never interrupted
 * again → the self-referential interrupted-post loop closes). A code constant
 * (a `health.interruptCooldownMs` runtime knob is a future org.ts schema change
 * — deliberately NOT done here; see the M3 report). */
export const INTERRUPT_COOLDOWN_MS = 5 * 60 * 1000

/** M3 — the interrupt-cooldown ledger key prefix (`interrupt:<recipientId>`). */
export const INTERRUPT_COOLDOWN_KEY_PREFIX = 'interrupt:'

/** M3 — the interrupt-cooldown ledger file (a key→lastInterruptAtMs JSON ledger,
 * mirroring the health-alerts-state.json pattern). A SEPARATE file so the
 * system-health tick's own health-alerts-state.json write can never clobber the
 * interrupt gate (the tick reads the ledger at the top and rewrites it at the
 * end; the interrupt gate is written DURING the bus delivery). */
export const INTERRUPT_COOLDOWN_FILE = 'interrupt-state.json'

/** Read `<stateDir>/interrupt-state.json` → `{ [key]: lastInterruptAtMs }`.
 * Absent / unreadable / malformed → {} (never throws). */
export function readInterruptState(stateDir: string): HealthAlertsState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, INTERRUPT_COOLDOWN_FILE), 'utf8')) as Record<string, unknown>
    const out: HealthAlertsState = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/interrupt-state.json` (mkdir -p the dir, then the file). */
export async function writeInterruptState(stateDir: string, state: HealthAlertsState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, INTERRUPT_COOLDOWN_FILE)), { recursive: true })
  await writeFile(path.join(stateDir, INTERRUPT_COOLDOWN_FILE), JSON.stringify(state), 'utf8')
}

/** M3 — the per-recipient interrupt back-off. A shared helper that gates EVERY
 * bus interrupt at the choke point (busDeliverToHost + busDeliverToPost): at most
 * ONE interrupt per recipient per INTERRUPT_COOLDOWN_MS, regardless of identity
 * count. Returns FALSE (no interrupt — the delivery falls through to QUEUE
 * semantics) when a prior interrupt is inside the cooldown; TRUE when the turn
 * was actually aborted. NEVER throws (a ledger failure degrades to an
 * in-memory-only gate — the cooldown is best-effort but bounded; a cancel
 * failure returns false WITHOUT advancing the gate, so a failed abort never
 * caps a future genuine interrupt). */
export async function safeInterrupt(
  agent: { cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void },
  recipientId: string,
  nowMs: number,
  stateDir: string
): Promise<boolean> {
  const key = `${INTERRUPT_COOLDOWN_KEY_PREFIX}${recipientId}`
  let state: HealthAlertsState = {}
  try { state = readInterruptState(stateDir) } catch { state = {} }
  const last = state[key]
  if (last !== undefined && nowMs - last < INTERRUPT_COOLDOWN_MS) return false
  try {
    agent.cancel(INTERRUPT_CANCEL_CAUSE, INTERRUPT_CANCEL_OPTIONS)
  } catch {
    return false
  }
  const next = { ...state, [key]: nowMs }
  // Bounded: prune entries that aged out of the cooldown so the ledger never
  // grows unbounded over time (an entry older than the cooldown is immaterial).
  for (const [k, v] of Object.entries(next)) {
    if (nowMs - v > INTERRUPT_COOLDOWN_MS) delete next[k]
  }
  try { await writeInterruptState(stateDir, next) } catch { /* best-effort */ }
  return true
}

/** M3 — the N consecutive materialization failures after which a NON-retired
 * host is quarantined (post-error recording + QD directive suppressed), keeping
 * the durable-retry repair (the W8-i host-attach retry STILL runs — the
 * delivery ATTEMPT is never skipped, only the RECORDING is gated). */
export const MATERIALIZE_QUARANTINE_N = 3
/** M3 — the per-host materialization quarantine window (ms). */
export const MATERIALIZE_QUARANTINE_MS = 5 * 60 * 1000
/** M3 — the materialization-issue ledger file (a per-host consecutive-failure
 * counter + quarantineUntil, persisted so the back-off survives ticks). */
export const MATERIALIZE_STATE_FILE = 'materialize-state.json'

/** One host's materialization issue state. */
export interface HostMaterializeIssue {
  /** Consecutive materialization failures (saturated at MATERIALIZE_QUARANTINE_N). */
  consecutiveFailures: number
  /** When the host is quarantined (recording suppressed) until this epoch-ms. */
  quarantineUntil: number
}
/** The materialization-issue ledger: hostId → issue state. */
export type MaterializeIssueLedger = Record<string, HostMaterializeIssue>

/** Read `<stateDir>/materialize-state.json` → `{ [hostId]: issue }`.
 * Absent / unreadable / malformed → {} (never throws). */
export function readMaterializeState(stateDir: string): MaterializeIssueLedger {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, MATERIALIZE_STATE_FILE), 'utf8')) as Record<string, unknown>
    const out: MaterializeIssueLedger = {}
    for (const [hostId, value] of Object.entries(parsed)) {
      if (typeof value === 'object' && value !== null) {
        const row = value as Record<string, unknown>
        if (typeof row.consecutiveFailures === 'number' && typeof row.quarantineUntil === 'number') {
          out[hostId] = { consecutiveFailures: row.consecutiveFailures, quarantineUntil: row.quarantineUntil }
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/materialize-state.json` (mkdir -p the dir, then the file). */
export async function writeMaterializeState(stateDir: string, state: MaterializeIssueLedger): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, MATERIALIZE_STATE_FILE)), { recursive: true })
  await writeFile(path.join(stateDir, MATERIALIZE_STATE_FILE), JSON.stringify(state), 'utf8')
}

/** M3 — increment a host's consecutive-failure counter and, once it reaches
 * MATERIALIZE_QUARANTINE_N, quarantine it for MATERIALIZE_QUARANTINE_MS (a FIXED
 * window from the Nth failure; an already-quarantined host is NOT extended — a
 * continuously-failing host re-quarantines each time the window lapses). PURE.
 * Returns the next ledger + whether the host is quarantined. */
export function markHostMaterializeFailure(state: MaterializeIssueLedger, hostId: string, nowMs: number): { next: MaterializeIssueLedger; quarantined: boolean } {
  const prevFailures = state[hostId]?.consecutiveFailures ?? 0
  const consecutiveFailures = Math.min(prevFailures + 1, MATERIALIZE_QUARANTINE_N)
  const prevQuarantineUntil = state[hostId]?.quarantineUntil ?? 0
  const alreadyQuarantined = nowMs < prevQuarantineUntil
  const quarantineUntil = alreadyQuarantined
    ? prevQuarantineUntil
    : (consecutiveFailures >= MATERIALIZE_QUARANTINE_N ? nowMs + MATERIALIZE_QUARANTINE_MS : 0)
  const quarantined = quarantineUntil !== 0 && nowMs < quarantineUntil
  return { next: { ...state, [hostId]: { consecutiveFailures, quarantineUntil } }, quarantined }
}

/** M3 — clear a host's materialization issue (DURABLE): read the ledger, drop
 * the host's entry if present, and persist ONLY when there was one (a healthy
 * host's successful delivery performs no write). Promoted to a helper so the
 * bus-deliver success path can reset the counter without touching the ledger on
 * the common no-op case. */
export async function resetHostMaterializeFailures(stateDir: string, hostId: string): Promise<void> {
  const state = readMaterializeState(stateDir)
  if (state[hostId] === undefined) return
  const next = { ...state }
  delete next[hostId]
  await writeMaterializeState(stateDir, next)
}

// ---------------------------------------------------------------------------
// W8-c SAFEGUARDS PACKAGE (owner "tenemos que crear salvaguardas para
// protegerse de estos errores", 2026-08-24) — four default-on, individually
// disable-able safeguards built on the W6 system-health machinery
// (post-errors.jsonl, the health daemon tick, health-alerts-state.json dedupe,
// the bus ALERT to the host):
//   1. TURN-FAILURE CAPTURE — a post session whose turn/end ends in an ERROR
//      reason is recorded into post-errors.jsonl so the daemon ALERTS (a
//      BOUNDED TAIL-SCAN of the live posts' session event logs — the harness
//      exposes no global turn/end cordis event, so the tick observes the live
//      agent session logs it already reads, see the doc below).
//   2. STALE-LIVE WATCHDOG — a catalog-live post with pending addressed
//      messages AND no session writes for >= N minutes is a 'stalled post'.
//   3. PRESET AUDIT — preset/persona text (COMMENTS INCLUDED) holding an
//      UNBOUND template reference (not one of the KNOWN-BOUND persona vars)
//      records a config-preset finding.
//   4. CONFIG KNOBS — `health.turnErrorCaptureEnabled` /
//      `staleLiveWatchdogEnabled` (+ `staleLiveMinutes`) / `presetAuditEnabled`.
// A SHARED pure activity/pending-age snapshot service (`buildPostSnapshot` +
// the exported scan helpers) is reused by the stale-live watchdog AND the
// eventual W8-d heartbeat.
// ---------------------------------------------------------------------------

/** One session event of a post's session log (the live agent's in-memory event
 * list, or a durable slice). STRUCTURAL — only the fields the health safeguards
 * read are declared, so the plugin never hard-depends on the harness session
 * event type. */
export interface HealthSessionEvent {
  type?: string
  /** The event ts (ms epoch) — the session log's write timestamp. */
  time?: number
  data?: unknown
}

/** One catalog post's snapshot inputs for the health safeguards. */
export interface PostActivityInput {
  postId: string
  /** fb-25 (b) — the post's LIVE session id at scan time (whose event log
   * `events` belongs to). The turn-error capture threads it into the
   * post-error row so the alert carries the SESSION PROVENANCE ("session <id>
   * turn <n>"). Absent (legacy callers / unknown) → omitted — the capture
   * row degrades to the legacy {ts,postId,error} shape (R6). */
  sessionId?: string
  /** True when the post is a retired/removed member — a retired post is never a
   * stale-live or turn-error signal. Absent/false = a live catalog member. */
  retired?: boolean
  /** True when the post's LIVE agent is CURRENTLY in an executing turn
   * (`agents.get(sessionId)?.status === 'running'`). A genuinely-running turn is
   * NOT stalled (Bug B) — a long in-flight model call is healthy progress, NOT a
   * stale/stuck post, so `scanStalledPosts` short-circuits it as alive. Absent/
   * false = not running (the post is idle/dormant and may be candidly stale). */
  running?: boolean
  /** The post's session event log (the live agent's in-memory events, or a
   * durable slice). Absent/empty → no activity signal (never misclassified). */
  events?: readonly HealthSessionEvent[]
  /** The ts (ms epoch) of messages ADDRESSED to the post in the recent window
   * (its inbox). */
  inboxTs?: readonly number[]
  /** True when the post is DORMANT (sleepEpoch set — deliberately asleep by a
   * sleep directive). A dormant post's pending queue drains at its next WAKE,
   * so it is NEVER a stale/stalled post (owner m-169/m-174). Absent/false = a
   * live (awake) post, candidly stale. */
  sleeping?: boolean
  /** The post's provider marker: 'worker' for a disposable worker; ABSENT for a
   * configured head (and any non-worker post). `scanStalledPosts` uses it to
   * recognize the ORPHANED-WORKER class (m-228) — a non-retired WORKER whose
   * retire step was cut by a restart. A configured head is never an orphan. */
  provider?: string
  /** Whether the post's LIVE AgentHandle still exists in the `agents` registry
   * (`agents.get(sessionId) !== undefined`). A non-retired worker with
   * `hasLiveHandle: false` and NO session activity is an ORPHAN (its durable
   * session is gone + no live handle) — it must never feed the stalled detector.
   * Absent (undefined) = unknown/live-permissive → never treated as orphaned
   * (a post that never reports its handle is never falsely orphan-swept). */
  hasLiveHandle?: boolean
}

/** The SHARED activity/pending snapshot of one post — the reusable pure helper
 * the W8-c-2 stale-live watchdog AND the eventual W8-d heartbeat read. */
export interface PostActivitySnapshot {
  postId: string
  /** The last session-log write ts (ms epoch), or undefined for an empty/absent
   * log. */
  lastActivityTs?: number
  /** Count of PENDING (addressed but not yet answered) messages in the post's
   * inbox: the address ts entries with NO completed `turn/end` AFTER them (a
   * message whose turn is still open, or was never started, is unprocessed). A
   * message followed by a completed turn (a `turn/end` after it) is answered. */
  pendingCount: number
  /** The OLDEST pending message ts (ms epoch), or undefined. */
  oldestPendingTs?: number
}

/**
 * W8-c SHARED snapshot primitive (PURE, exported — W8-d reuses it). From a
 * post's session event log + its addressed-message ts list, compute the
 * activity snapshot: the last session-log write ts, and the COUNT + oldest age
 * of PENDING (addressed-but-unanswered) messages. A message is answered iff the
 * log holds a completed turn (`turn/end`) AFTER its ts; otherwise a delivered
 * message that never produced a completed turn is still unprocessed. An empty
 * inbox or no events degrade cleanly (never throws).
 */
export function buildPostSnapshot(post: PostActivityInput): PostActivitySnapshot {
  const events = post.events ?? []
  let lastActivityTs: number | undefined
  for (const event of events) {
    if (typeof event.time === 'number' && Number.isFinite(event.time)) {
      if (lastActivityTs === undefined || event.time > lastActivityTs) lastActivityTs = event.time
    }
  }
  const pending = (post.inboxTs ?? []).filter((ts) => {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return false
    if (lastActivityTs === undefined) return true // no activity → every addressed message is unprocessed
    if (ts <= lastActivityTs) {
      // A turn may have completed after this message; if the log holds a
      // `turn/end` AFTER it, the message was answered.
      for (const event of events) {
        if (event.type === 'turn/end' && typeof event.time === 'number' && Number.isFinite(event.time) && event.time > ts) {
          return false // completed turn after the message → answered
        }
      }
      return true
    }
    return true
  })
  let oldestPendingTs: number | undefined
  for (const ts of pending) {
    if (oldestPendingTs === undefined || ts < oldestPendingTs) oldestPendingTs = ts
  }
  return {
    postId: post.postId,
    ...(lastActivityTs !== undefined ? { lastActivityTs } : {}),
    pendingCount: pending.length,
    ...(oldestPendingTs !== undefined ? { oldestPendingTs } : {})
  }
}

/** The stale-live staleness threshold (W8-c PART 2, default 10 min). */
export const STALE_LIVE_DEFAULT_MINUTES = 10

/** W8-c PART 2 (Bug B) — the tight "recent activity" window that counts as ALIVE.
 * A post with a session write OR an inbox/queue delivery within this window is
 * NOT stalled even when its LAST session write is older than `staleMinutes`
 * (fresh queue/delivery traffic is healthy progress, not a stale post). Chosen
 * as a sub-stale window (2 min) so it only catches genuinely-fresh activity and
 * never masks a truly-stalled post. */
export const POST_RECENT_ACTIVITY_WINDOW_MS = 2 * 60 * 1000

/** PURE — does an error surface a benign transient PROVIDER-QUOTA / rate-limit /
 * 429 / usage-limit failure (the exhausted-monthly-quota a holding head records
 * at its last turn/end)? Matched against the message OR its `code`, tolerant of
 * a nested `reason.error.{message,code}` / LlmError `.failure` surface. A hard
 * crash / generic LLM failure does NOT match (it must not exempt a genuine
 * stall). */
export function isProviderQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /429|quota|rate.?limit|usage.?limit|go.?usage.?limit|too many request|resource.*exhausted/i.test(message)
}

/** PURE — did a post's MOST-RECENT turn/end event terminate BENIGNLY? A turn/end
 * is benign when it is NOT an error termination (a clean/normal end,
 * `kind !== 'error'`) OR when its error reason is a benign transient
 * provider-quota / rate-limit error. A configured head whose last turn ended
 * benignly AND who has no in-flight turn is DELIBERATELY idle-holding (a
 * quota-hold, a post-delivery hold, a boot-quiet-between-tasks pause) → healthy,
 * NOT a stall. The signal is DURABLE (NOT freshness-bounded): a benign-ended
 * head is exempt REGARDLESS of how long ago that turn ended — the honest
 * discriminator is the durable "demonstrably finished its last turn benignly +
 * not in-flight" signal, not a recency window (a deliberate quota-hold resets
 * over many hours / days). A genuine stall NEVER matches: a HARD-crash /
 * non-quota error reason, or NO turn/end at all (stuck mid-turn), returns false
 * so the existing predicate still flags it. Pure, never throws (a malformed
 * event degrades to "not benign"). Only the MOST-RECENT turn/end is judged — an
 * earlier benign end is discounted once a later (non-benign) termination
 * superseded it. `nowMs` is retained for caller/API compatibility; the decision
 * does not depend on it. */
export function lastTurnEndedBenignly(events: readonly HealthSessionEvent[], nowMs: number): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'turn/end') continue
    const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
    const reason = (typeof data.reason === 'object' && data.reason !== null ? data.reason : {}) as Record<string, unknown>
    const nested = (typeof reason.error === 'object' && reason.error !== null ? reason.error : {}) as Record<string, unknown>
    const failure = typeof nested.failure === 'object' && nested.failure !== null ? (nested.failure as Record<string, unknown>) : undefined
    const errorSurface = failure ?? nested
    const kind = reason.kind
    // (a) clean / normal end (kind !== 'error'): the turn terminated NOT in an error.
    const isError = kind === 'error' || (typeof kind === 'string' && /error/i.test(kind))
    if (!isError) return true
    // (b) benign transient provider-quota / rate-limit error: the reason (or its
    // nested error / LlmError failure / top-level message-carrying field) matches
    // the quota class.
    const candidates: unknown[] = [reason.message, reason.code, nested.message, nested.code, errorSurface.message, errorSurface.code]
    if (candidates.some((candidate) => typeof candidate === 'string' && isProviderQuotaError(candidate))) return true
    // A non-quota error termination (a hard crash / generic failure) is NOT benign.
    return false
  }
  return false
}

/** W8-c PART 2 — flag a catalog-live post that is STALLED: it holds at least
 * one PENDING unprocessed addressed message AND its session log has NO writes
 * for >= `staleMinutes` (or no writes at all for that long — the oldest pending
 * message is itself >= `staleMinutes` old). Emits ONE 'stalled-post' finding per
 * stale post (key `stalled:<postId>`, deduped by the daemon's alert ledger).
 * Retired posts never produce a finding. Pure, never throws.
 *
 * W8-c PART 2 (Bug B — false-positive de-dupe): a post is NEVER flagged when it
 * is ALIVE, independent of the last-write age:
 *   - `post.running === true` — the LIVE agent is currently executing a turn
 *     (a genuinely-running turn / long in-flight model call is healthy progress,
 *     NOT a stalled post);
 *   - RECENT activity — a session write OR an inbox/queue delivery within
 *     `POST_RECENT_ACTIVITY_WINDOW_MS` (an actively-receiving post is alive even
 *     when its last session write is old).
 * Both short-circuit BEFORE the stale test so a live/running/recently-active
 * post is never emitted. */
export function scanStalledPosts(
  posts: Iterable<PostActivityInput>,
  nowMs: number,
  staleMinutes: number
): HealthFinding[] {
  const windowMs = staleMinutes * 60_000
  const findings: HealthFinding[] = []
  for (const post of posts) {
    if (post.retired === true) continue
    // Dormant-exclusion (owner m-169/m-174): a post with sleepEpoch set is
    // DELIBERATELY asleep by a sleep directive; its pre-sleep pending messages
    // drain at its next WAKE, so it is NEVER a stalled post (the stale pendings
    // are the EXPECTED dormant state, not a stuck session).
    if (post.sleeping === true) continue
    // m-228 — ORPHANED-WORKER exclusion: a non-retired WORKER with NO live
    // AgentHandle (`hasLiveHandle === false`) AND NO session activity (no events)
    // is an ORPHAN — its retire step was cut by a deploy restart, so the normal
    // retire path never re-retires it and it would FEED this detector forever (a
    // zombie post). It is NOT stalled (nothing is running and nothing is
    // progressing); treat it as orphaned → skip the finding. A LIVE worker has a
    // handle (`hasLiveHandle !== false`) and is never excluded; a configured head
    // has `provider !== 'worker'` and is never excluded; a post that never reports
    // its handle (hasLiveHandle undefined) is never treated as orphaned (the
    // conservative unknown → live-permissive default). The durable auto-retire is
    // deliberately NOT done here (the m-119 boot reconcile stays read-only) — this
    // only stops the orphan from generating alerts.
    if (post.provider === 'worker' && post.hasLiveHandle === false && (post.events?.length ?? 0) === 0) continue
    const snap = buildPostSnapshot(post)
    if (snap.pendingCount === 0) continue
    // Bug B liveness short-circuits (last-write-age independent).
    if (post.running === true) continue
    // A RECENT session write OR a RECENT inbox/queue delivery = alive (fresh
    // queue/delivery traffic is not a stalling post, even with an old last write).
    let recentActivityTs: number | undefined = snap.lastActivityTs
    if (post.inboxTs !== undefined) {
      for (const ts of post.inboxTs) {
        if (typeof ts === 'number' && Number.isFinite(ts) && (recentActivityTs === undefined || ts > recentActivityTs)) recentActivityTs = ts
      }
    }
    if (recentActivityTs !== undefined && nowMs - recentActivityTs < POST_RECENT_ACTIVITY_WINDOW_MS) continue
    const stale =
      (snap.lastActivityTs !== undefined && nowMs - snap.lastActivityTs >= windowMs) ||
      (snap.lastActivityTs === undefined && snap.oldestPendingTs !== undefined && nowMs - snap.oldestPendingTs >= windowMs)
    if (!stale) continue
    // FASE (system-health STALLED-POST false-positive, 2026-08-26): the GENERAL
    // deliberate-idle-hold exemption. A CONFIGURED HEAD (provider !== 'worker')
    // that is NOT running (no in-flight turn) AND whose MOST-RECENT turn/end
    // event terminated BENIGNLY — a clean/normal end (kind !== 'error') OR a
    // benign transient provider-quota/rate-limit error — is DELIBERATELY
    // idle-holding between tasks (a quota-hold, a post-delivery hold, a
    // boot-quiet-between-tasks pause) → HEALTHY, NOT a stall. The signal is
    // DURABLE, NOT freshness-bounded: a benign-ended head is exempt REGARDLESS of
    // how long ago that turn ended (a deliberate quota-hold resets over many
    // hours / days), because the honest discriminator is the durable
    // "demonstrably finished its last turn benignly + not in-flight" signal, not
    // recency. A genuine stall is NEVER exempted: its last turn/end is a HARD
    // crash / non-quota error, or its turn never terminated cleanly (no benign
    // turn/end), or it is actively running (the Bug-B short-circuit at the
    // `post.running === true` check above has ALREADY skipped a running post — so
    // a post reaching here is not running, satisfying the no-in-flight-turn
    // condition). WORKERS (provider === 'worker') are unaffected — the
    // orphan/phantom detection and the worker stale-clearing stay intact; the
    // retired/sleeping/orphan exclusions run ABOVE, unchanged.
    if (post.provider !== 'worker' && lastTurnEndedBenignly(post.events ?? [], nowMs)) continue
    findings.push({
      kind: 'stalled-post',
      key: `stalled:${post.postId}`,
      postId: post.postId,
      ts: snap.oldestPendingTs ?? snap.lastActivityTs ?? nowMs,
      count: snap.pendingCount,
      error: `no session writes for >= ${staleMinutes} min`
    })
  }
  return findings
}

/** W8-c PART 1 — how fresh a turn-error must be to be captured (<= 10 min). */
export const TURN_ERROR_FRESH_WINDOW_MS = 10 * 60 * 1000
/** W8-c PART 1 — the bounded tail of the session log scanned per post per tick. */
export const TURN_ERROR_CAPTURE_MAX_TAIL = 30

/** A turn-error capture candidate: the post + a fresh turn/end error reason. */
export interface TurnErrorCapture {
  postId: string
  /** The captured error message (the turn/end reason message/code). */
  error: string
  /** The turn/end event ts (ms epoch). */
  ts: number
  /** fb-25 (b) — the TURN NUMBER of the captured turn/end event (the turn that
   * errored; when the event data carries it). The provenance the post-error
   * row/alert shows ("session <id> turn <n>"). */
  turn?: number
  /** fb-25 (b) — the SESSION whose event log carried the turn/end error. The
   * scan itself cannot read it (the harness events carry {turn, reason} only —
   * dsh-agent-loop lib/index.js:592), so the caller threads it in (the post's
   * live sessionId at scan time). Absent → omitted (R6 — capture without
   * provenance degrades to the legacy shape, never breaks). */
  sessionId?: string
  /** A stable dedupe key for the captured (postId, turn) pair — a turn that
   * already produced a post-error row is never double-captured. */
  key: string
}

/** W8-c PART 1 — BOUNDED TAIL-SCAN of one post's session event log for a
 * turn/end that ended in an ERROR reason (`reason.kind === 'error'` — the
 * malformed-reference / no-provider/no-model class). Returns the MOST-RECENT
 * error turn in the tail, or undefined. Pure, never throws (a malformed event
 * shape degrades to "no capture"). NO HARNESS EVENT HOOK IS USED: the harness
 * exposes NO global turn/end cordis event (turn/end is a per-session append,
 * dsh-agent-loop index.js:592 — there is no `ctx.on('turn/end')`), and the
 * plugin already reads the live agents' `session.events` (the real session log
 * the harness maintains) in the daemon tick, so the cleanest available
 * observation point is a bounded per-tick tail-scan there. */
export function scanTurnErrorCaptures(events: readonly HealthSessionEvent[], postId: string, sessionId?: string): TurnErrorCapture | undefined {
  const tail = events.slice(-TURN_ERROR_CAPTURE_MAX_TAIL)
  for (let i = tail.length - 1; i >= 0; i--) {
    const event = tail[i]
    if (event.type !== 'turn/end') continue
    const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
    const reason = (typeof data.reason === 'object' && data.reason !== null ? data.reason : {}) as Record<string, unknown>
    // The harness writes the turn/end error reason NESTED under `reason.error`
    // (dsh-agent-loop lib/index.js:582-588: turnEnds = { kind:'error', error:
    // error instanceof LlmError ? error.failure : { message: errorChain(error),
    // code:'UNKNOWN' } }), so also surface the nested error (and its `failure`
    // sub-object for the LlmError case) to extract the real message/code. The
    // top-level `reason.message`/`reason.code` are preserved for backward-compat.
    const nested = (typeof reason.error === 'object' && reason.error !== null ? reason.error : {}) as Record<string, unknown>
    const failure = typeof nested.failure === 'object' && nested.failure !== null ? (nested.failure as Record<string, unknown>) : undefined
    const errorSurface = failure ?? nested
    const kind = reason.kind
    const isError = kind === 'error' || (typeof kind === 'string' && /error/i.test(kind))
    if (!isError) continue
    const turn = data.turn
    const ts = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
    const message =
      (typeof reason.message === 'string' && reason.message !== '')
        ? reason.message
        : (typeof errorSurface.message === 'string' && errorSurface.message !== '')
          ? errorSurface.message
          : (typeof reason.code === 'string' && reason.code !== '')
            ? reason.code
            : (typeof errorSurface.code === 'string' && errorSurface.code !== '')
              ? errorSurface.code
              : `${String(kind ?? 'error')} (turn ${String(turn ?? '?')})`
    return {
      postId,
      error: message,
      ts,
      ...(typeof turn === 'number' && Number.isFinite(turn) ? { turn } : {}),
      ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
      key: `${postId}:turn-error:${typeof turn === 'number' ? String(turn) : '?'}:${ts}`
    }
  }
  return undefined
}

/** The dedupe ledger of turn-error capture: `postId:turn-error:<turn>:<ts>` →
 * lastCapturedAtMs. Prevents re-recording the same turn on a later tick. */
export type TurnErrorsState = Record<string, number>

export const TURN_ERRORS_STATE_FILE = 'turn-errors-state.json'

/** Read `<stateDir>/turn-errors-state.json` → `{ [key]: lastCapturedAtMs }`.
 * Absent / unreadable / malformed → {} (never throws). */
export function readTurnErrorsState(stateDir: string): TurnErrorsState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, TURN_ERRORS_STATE_FILE), 'utf8')) as Record<string, unknown>
    const out: TurnErrorsState = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/turn-errors-state.json` (mkdir -p the dir, then the file). */
export async function writeTurnErrorsState(stateDir: string, state: TurnErrorsState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, TURN_ERRORS_STATE_FILE)), { recursive: true })
  await writeFile(path.join(stateDir, TURN_ERRORS_STATE_FILE), JSON.stringify(state), 'utf8')
}

// ---------------------------------------------------------------------------
// LANE 2 (fb-27, QD ALTO/mejora, 2026-09-01) — TURN/END-ERROR HEAD NOTIFICATION.
// A FRESH turn/end ERROR in a live post's session event log is notified to the
// POST'S OWN HEAD (its creator `managerId`, or its department coordinator)
// with the session+turn provenance, deduped via its OWN ledger
// `turn-end-notify-state.json` keyed `postId:turn` (INDEPENDENT of the capture
// ledger — a head is alarmed even when `turnErrorCaptureEnabled` is off; the
// capture records into post-errors.jsonl, the notification pages the head).
// The classification is PURE (turnErrorNotifyClass); the frame is PURE
// (buildTurnErrorNotifyFrame); the notify block lives in the daemon tick
// (right after the capture block) and DELIVERS via the `notifyHead` dep — the
// bundle's `healthNotifyHead` closure (store.append + busDeliverToPost, the
// daemon→head pattern) — NOT `deliverDaemonNotice` (which respects
// sleepEpoch='queued' and belongs to the scheduler/parallel paths).
// ---------------------------------------------------------------------------

/** LANE 2 — the turn/end-error NOTIFICATION class. `turnErrorNotifyClass`
 * returns one of the NOTIFIED classes, or `undefined` (the CONFIG class and any
 * unclassifiable error are NEVER notified — the conservative direction: a head
 * is only paged for a recognized actionable turn/end failure). */
export type TurnErrorNotifyClass =
  | 'config'
  | 'stream-idle'
  | 'http-5xx'
  | '429'
  | '40x'
  | 'provider'
  | 'rate-limit'

/** PURE — classify a turn/end-error message for HEAD NOTIFICATION. The CONFIG
 * class (no adapter / no provider / no model / malformed — a
 * wiring/dependency fault, not a turn outage to page the head about) and any
 * unclassifiable error return `undefined` → NOT notified. The recognized
 * classes (stream-idle / http-5xx / 429 / 40x / provider / rate-limit) are
 * matched with a DETERMINISTIC precedence: config excluded first, then the
 * specific code/symptom classes (stream-idle, http 5xx, 429, other 4xx,
 * rate-limit) before the GENERIC provider/upstream/model class. Pure, never
 * throws (a non-string input degrades to undefined). */
export function turnErrorNotifyClass(error: unknown): Exclude<TurnErrorNotifyClass, 'config'> | undefined {
  const message = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error ?? ''))
  // CONFIG class — NEVER notified (a no-adapter/no-provider/no-model/malformed
  // error is a configuration/dependency fault, not a turn outage to page for).
  if (/no adapter|adapter.*(not found|missing|unregistered)|unknown adapter|no provider|provider.*(missing|not found|unregistered)|unknown provider|no model|model.*(missing|not found)|malformed|invalid config|not configured|misconfig/i.test(message)) return undefined
  // stream-idle — a turn that received NO tokens within the stream idle window.
  if (/stream.?idle|idle timeout|stream.*(empty|closed|timed? ?out|disconnect)|no (tokens?|chunks?|response|output) received|stream.*no output/i.test(message)) return 'stream-idle'
  // http-5xx — an upstream server-class failure (502/503/504/bad-gateway/...).
  if (/\b(50[0-9]|51[0-9]|52[0-9])\b|bad gateway|service unavailable|internal server error|upstream.*(error|fail)|gateway timeout|server error|5\d\d/i.test(message)) return 'http-5xx'
  // 429 — the explicit HTTP 429 too-many-requests class (rate-limited).
  if (/\b429\b|too many requests?/i.test(message)) return '429'
  // 40x — any other HTTP client-class failure (400/401/403/404/422/...).
  if (/\b(400|401|402|403|404|405|406|408|409|413|415|422|429)\b|client error|unauthorized|forbidden|not found|invalid request|bad request|auth(entication|orization).*(failed|error)|4\d\d/i.test(message)) return '40x'
  // rate-limit — a provider-level quota/rate-limit symptom NOT carrying the 429 code.
  if (/quota|rate.?limit|usage.?limit|go.?usage.?limit|resource.*exhausted|request.*limit|throttl|rate limited|limit exceeded|exceeded.*(quota|limit)|insufficient.*(quota|balance|credit)/i.test(message)) return 'rate-limit'
  // provider — a GENERIC provider/upstream/model API failure not matched above.
  if (/provider|upstream|llm|openai|anthropic|azure|vertex|gemini|cohere|mistral|api error|model/i.test(message)) return 'provider'
  return undefined
}

/** PURE — build the turn/end-error HEAD-NOTIFICATION frame (the daemon→head
 * bus message text): `[From deepartments] Turn-error <cls>: post <postId>
 * session <sessionId> turn <turn> (<HH:MMZ>) — <error>`. The HH:MMZ is the
 * capture ts rendered in UTC (zero-padded). Pure, never throws (a missing
 * field degrades to '?'). */
export function buildTurnErrorNotifyFrame(capture: TurnErrorCapture, cls: string): string {
  const d = new Date(capture.ts)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `[From deepartments] Turn-error ${cls}: post ${capture.postId} session ${capture.sessionId ?? '?'} turn ${capture.turn ?? '?'} (${hh}:${mm}Z) — ${capture.error}`
}

/** LANE 2 — the dedupe ledger of turn/end-error HEAD NOTIFICATION:
 * `postId:turn` → lastNotifiedAtMs. INDEPENDENT of the capture ledger — a
 * post+turn is notified at most once per window even when the capture is off. */
export type TurnEndNotifyState = Record<string, number>

export const TURN_END_NOTIFY_STATE_FILE = 'turn-end-notify-state.json'

/** Read `<stateDir>/turn-end-notify-state.json` → `{ [postId:turn]:
 * lastNotifiedAtMs }`. Absent / unreadable / malformed → {} (never throws). */
export function readTurnEndNotifyState(stateDir: string): TurnEndNotifyState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, TURN_END_NOTIFY_STATE_FILE), 'utf8')) as Record<string, unknown>
    const out: TurnEndNotifyState = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/turn-end-notify-state.json` (mkdir -p the dir, then the file). */
export async function writeTurnEndNotifyState(stateDir: string, state: TurnEndNotifyState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, TURN_END_NOTIFY_STATE_FILE)), { recursive: true })
  await writeFile(path.join(stateDir, TURN_END_NOTIFY_STATE_FILE), JSON.stringify(state), 'utf8')
}

/** W8-c PART 3 — the config-preset finding markers file. */
export const CONFIG_PRESETS_FILE = 'config-presets.jsonl'

/** One preset-audit marker: a preset/persona text holding unbound template vars. */
export interface ConfigPresetMarker {
  ts: number
  /** The preset/source name audited (e.g. `deepartments-head/agent.cordis.yml`). */
  preset: string
  /** The UNBOUND template variable NAMES found (no braces — the literal
   * double-brace token is never written into a prompt-facing artifact). */
  unbound: string[]
}

/** Read `<stateDir>/config-presets.jsonl` → the markers, in file order. Absent /
 * unreadable / malformed → [] (never throws). */
export function readConfigPresetMarkers(stateDir: string): ConfigPresetMarker[] {
  try {
    const text = readFileSync(path.join(stateDir, CONFIG_PRESETS_FILE), 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    const out: ConfigPresetMarker[] = []
    for (const line of lines) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const marker = parsed as Record<string, unknown>
      if (typeof marker.ts !== 'number' || typeof marker.preset !== 'string' || !Array.isArray(marker.unbound)) continue
      out.push({ ts: marker.ts, preset: marker.preset, unbound: marker.unbound.filter((v): v is string => typeof v === 'string') })
    }
    return out
  } catch {
    return []
  }
}

/** Append ONE config-preset marker to `<stateDir>/config-presets.jsonl`
 * (mkdir -p the dir, then appendFile). Never throws — callers fold a persist
 * failure into a warn. */
export async function appendConfigPresetMarker(stateDir: string, marker: ConfigPresetMarker): Promise<void> {
  try {
    const filePath = path.join(stateDir, CONFIG_PRESETS_FILE)
    await mkdir(path.dirname(filePath), { recursive: true })
    await appendFile(filePath, JSON.stringify(marker) + '\n', 'utf8')
  } catch {
    /* non-fatal: a preset-audit marker that cannot persist must not fail boot */
  }
}

/**
 * W8-c PART 3 — PRESET AUDIT scanner (PURE, exported — COMMENTS INCLUDED).
 * Returns the NAMES of the unbound template-variable references in `text`: a
 * double-brace template token is UNBOUND unless its name is one of the
 * KNOWN-BOUND persona vars (cwd / headPostId / workspacePath / reportDir /
 * deptName — the W8-b BOUND_TEMPLATE_VARS set). A bound var reference is
 * allowed; any other reference (including a bare two-opening-braces marker)
 * is an UNBOUND token. Text without any double-brace token → []. The literal
 * double-brace token is described verbatim; only NAMES (no braces) are returned,
 * so the caller never emits the fatal token into a prompt-facing artifact.
 */
export function auditPresetText(text: string): string[] {
  if (!text.includes('{{')) return []
  const unbound = new Set<string>()
  let i = 0
  while (i < text.length) {
    if (text[i] === '{' && text[i + 1] === '{') {
      const ref = /^([a-zA-Z][a-zA-Z0-9_]*)}}/.exec(text.slice(i + 2))
      if (ref !== null) {
        if (!BOUND_TEMPLATE_VARS.has(ref[1])) unbound.add(ref[1])
      } else {
        // A bare two-opening-braces marker (no closing/name) — an unhandled token.
        unbound.add('<bare-marker>')
      }
      i += 2
      continue
    }
    i += 1
  }
  return [...unbound]
}

/** W8-c PART 3 — group fresh config-preset markers inside HEALTH_ERROR_WINDOW_MS
 * into ONE 'config-preset' finding (key 'config-preset'; deduped per 30min by
 * the daemon ledger, so a boot audit re-alerts at most once per window). */
export function scanConfigPresetFindings(stateDir: string, nowMs: number): HealthFinding[] {
  const fresh = readConfigPresetMarkers(stateDir).filter((marker) => nowMs - marker.ts <= HEALTH_ERROR_WINDOW_MS)
  if (fresh.length === 0) return []
  const ts = fresh.reduce((max, marker) => Math.max(max, marker.ts), 0)
  const names = [...new Set(fresh.flatMap((marker) => marker.unbound))]
  return [
    {
      kind: 'config-preset',
      key: 'config-preset',
      postId: 'config',
      ts,
      error: names.join(', '),
      count: fresh.length
    }
  ]
}

/** W8-c PART 2 — the production inbox reader: map recipientId → the ts of its
 * ADDRESSED messages (delivery rows with status 'prepared'/'delivered'/'resumed'
 * inside the window, resolved to the message record ts). PURE — the parsed rows
 * are injected so a test drives it with fixtures. */
export function computeInboxTsByPost(
  messageTsById: ReadonlyMap<string, number>,
  deliveryRows: readonly DeliveryRow[],
  nowMs: number,
  windowMs: number
): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const row of deliveryRows) {
    if (nowMs - row.ts > windowMs) continue
    if (row.status !== 'prepared' && row.status !== 'delivered' && row.status !== 'resumed') continue
    const ts = messageTsById.get(row.messageId)
    if (ts === undefined) continue
    let list = out.get(row.recipientId)
    if (list === undefined) {
      list = []
      out.set(row.recipientId, list)
    }
    list.push(ts)
  }
  return out
}

// ---------------------------------------------------------------------------
// W8-d SYSTEM HEARTBEAT to the Asistente (owner idea 2026-08-24 "que el
// asistente reciba un latido cada hora con la última entrada de actividad propia
// y de los agentes activos"). Amended final design (m-159 + m-163): NO
// standalone hourly message — (1) a LEAN `## System heartbeat:` section is
// injected into every HOST wake pack; (2) the health daemon wakes the host ONLY
// when the WAIT condition holds, via a `[From deepartments] system-wait: <reason>`
// bus message (zero noise otherwise). Both REUSE the shared pure snapshot
// primitives above (buildPostSnapshot / computeInboxTsByPost) — the ages are
// NEVER reimplemented. `health.heartbeatEnabled` (default on) gates both; an
// explicit false omits the wake-pack section + the conditional wake.
// ---------------------------------------------------------------------------

/** W8-d PART C — the quiet-expectation threshold default (30 min). */
export const SYSTEM_WAIT_DEFAULT_MS = 30 * 60 * 1000

/** W8-d PART C — resolve the effective wait threshold from `health` config:
 * a positive finite `waitThresholdMs` wins; absent/invalid → the 30min default.
 * Pure (never throws). */
export function resolveSystemWaitMs(health: { waitThresholdMs?: number } | undefined): number {
  const raw = health?.waitThresholdMs
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  return SYSTEM_WAIT_DEFAULT_MS
}

/** W8-d PART B — one post's input to the WAIT scan (a quiet-expectation check):
 * the post's session event log + the ts of messages ADDRESSED to it that the
 * HOST sent, each with its messageId (a delivered-but-never-answered class,
 * e.g. m-78). STRUCTURAL — only the fields the WAIT scan reads are declared. */
export interface HostWaitPostInput {
  postId: string
  /** True when the post is a retired member — a retired post is never a wait
   * signal (its messages are terminal-settled, W7-A). */
  retired?: boolean
  /** True when the post is DORMANT (sleepEpoch set — deliberately asleep by a
   * sleep directive). A dormant post's pending queue drains at its next WAKE,
   * so it is NEVER a system-wait (owner m-169/m-174). Absent/false = a live
   * (awake) post, candidly quiet. */
  sleeping?: boolean
  /** The post's session event log. Absent/empty → no activity signal. */
  events?: readonly HealthSessionEvent[]
  /** Host-ADDRESSED message rows (messageId + ts) in the recent window — the
   * candidate WAIT set (the host sent these; they may still be unanswered). */
  hostMessages?: readonly { messageId: string; ts: number }[]
}

/**
 * W8-d PART B — scan for the WAIT condition (PURE, exported): a HOST-SENT
 * message to a post that produced NO reply AND NO session activity within
 * `waitThresholdMs`. Reuses `buildPostSnapshot` (the pending-age primitive) with
 * the host-sent ts as the INBOX — so a host-sent message followed by a completed
 * turn (`turn/end` AFTER it) is answered and NOT a wait, and the pending count /
 * oldest age are the SAME computation the W8-c watchdog uses. A retired post is
 * never flagged. Emits ONE 'system-wait' finding per quiet host expectation, key
 * `wait:<postId>:<messageId>` (deduped by the daemon's health-alerts-state.json
 * ledger, so a quiet expectation alerts ONCE per HEALTH_DEDUPE_WINDOW_MS).
 * Pure, never throws.
 */
export function scanHostWaits(
  posts: Iterable<HostWaitPostInput>,
  nowMs: number,
  waitThresholdMs: number
): HealthFinding[] {
  const windowMs = waitThresholdMs
  const findings: HealthFinding[] = []
  for (const post of posts) {
    if (post.retired === true) continue
    // Dormant-exclusion (owner m-169/m-174/m-192/m-193): a post with sleepEpoch
    // set is DELIBERATELY asleep by a sleep directive; its pre-sleep pending
    // host messages drain at its next WAKE, so it is NEVER a system-wait (the
    // quiet period is the EXPECTED dormant state, not an unanswered host
    // expectation). Same criterion as scanStalledPosts.
    if (post.sleeping === true) continue
    const hostTs = (post.hostMessages ?? []).map((m) => m.ts)
    if (hostTs.length === 0) continue
    // Reuse the SHARED pending-age primitive with the HOST-sent ts as the inbox:
    // pendingCount + oldestPendingTs are computed exactly like the watchdog does.
    const snap = buildPostSnapshot({ postId: post.postId, events: post.events, inboxTs: hostTs })
    if (snap.pendingCount === 0) continue
    // Quiet: no session activity for >= the wait window (or NO session at all
    // while the oldest host-sent message is already that old). Mirrors the
    // stalled-post predicate (scanStalledPosts) so a stale claim is never < the
    // threshold.
    const quiet =
      (snap.lastActivityTs !== undefined && nowMs - snap.lastActivityTs >= windowMs) ||
      (snap.lastActivityTs === undefined && snap.oldestPendingTs !== undefined && nowMs - snap.oldestPendingTs >= windowMs)
    if (!quiet) continue
    const oldestRow = (post.hostMessages ?? []).find((m) => m.ts === snap.oldestPendingTs)
    const messageId = oldestRow?.messageId ?? `${post.postId}:${String(snap.oldestPendingTs)}`
    findings.push({
      kind: 'system-wait',
      key: `wait:${post.postId}:${messageId}`,
      postId: post.postId,
      messageId,
      ts: snap.oldestPendingTs ?? nowMs,
      count: snap.pendingCount,
      error: `no reply or session activity in ${Math.round(windowMs / 60_000)} min`
    })
  }
  return findings
}

/** Build the framed conditional-wake bus message — `[From deepartments]
 * system-wait: <reason>` where the reason names the quiet post + the window.
 * The only host delivery of the heartbeat is this conditional system-wait (no
 * standalone hourly heartbeat message). */
export function buildSystemWaitFrame(wait: HealthFinding): string {
  const quiet = wait.error !== undefined && wait.error !== '' ? ` (${wait.error})` : ''
  return `[From deepartments] system-wait: ${wait.postId}${quiet}`
}

/** One catalog post's heartbeat row (the per-agent activity/pending line). */
export interface HeartbeatRow {
  postId: string
  /** True when the post is dormant (sleepEpoch set). */
  sleeping: boolean
  /** The post's last session-log write ts (ms epoch), or undefined for an empty
   * log — rendered 'NO SESSION' (catalog-live without session activity). */
  lastActivityTs?: number
  /** Count of PENDING (addressed-but-unanswered) messages in the post's inbox. */
  pendingCount: number
  /** The OLDEST pending message ts (ms epoch), or undefined. */
  oldestPendingTs?: number
}

/** The heartbeat snapshot `buildHeartbeatSection` renders — PURE (no I/O), built
 * at wake-pack assembly time by `assembleWakePack` from the same snapshots the
 * W8-c watchdog reads. */
export interface HeartbeatSnapshot {
  /** The host (Asistente) session's last logged event ts, or undefined ('NO
   * SESSION' — the harness session record carries no events). */
  hostLastActivityTs?: number
  /** Per ACTIVE (and dormant) catalog post rows. */
  rows: HeartbeatRow[]
  /** The WAIT line reason when the host holds an unanswered/quiet expectation
   * (a host-sent message to a post with no reply + no session activity within
   * `waitThresholdMs`), or undefined (no wait → no WAIT line). */
  waitReason?: string
  /** W8-h — the postIds whose session shows an INTERRUPTED (stopped) turn (the
   * 'Stopped' badge). Absent/empty → the section renders `- interrupted: none`. */
  interruptedPostIds?: string[]
}

/** Human age label for a millisecond delta (`5m`, `1h`, `45s`) — the ONLY place
 * a raw age is formatted (the SNAPSHOT computation stays in buildPostSnapshot). */
function formatHeartbeatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ''}`
  if (minutes >= 1) return `${minutes}m`
  return `${Math.max(1, Math.floor(ms / 1000))}s`
}

/**
 * W8-d PART A — render the LEAN `## System heartbeat:` section BODY (PURE,
 * exported; the `## System heartbeat:` header is added by `buildWakePack`). A
 * few compact lines: host last-activity, per-agent activity/state (NO SESSION /
 * SLEEPING / last activity), pending message count + oldest age, and a WAIT
 * line when the host holds a quiet expectation. Brace-safe (never emits the
 * literal double-brace template token — the section rides through
 * `sanitizePromptLiterals` at the wake-pack seam). Never throws.
 */
export function buildHeartbeatSection(snapshot: HeartbeatSnapshot, nowMs: number): string {
  const lines: string[] = []
  // HOST last-activity (the Asistente session's last logged event).
  lines.push(
    snapshot.hostLastActivityTs !== undefined
      ? `- host: last activity ${formatHeartbeatAge(nowMs - snapshot.hostLastActivityTs)} ago`
      : '- host: NO SESSION'
  )
  // Per ACTIVE agent/head/worker (a dormant post is 'SLEEPING'; catalog-live
  // with no session activity is 'NO SESSION').
  for (const row of snapshot.rows) {
    const activity = row.sleeping
      ? 'SLEEPING'
      : row.lastActivityTs === undefined
        ? 'NO SESSION'
        : `last activity ${formatHeartbeatAge(nowMs - row.lastActivityTs)} ago`
    lines.push(`- ${row.postId}: ${activity}`)
    if (row.pendingCount > 0 && row.oldestPendingTs !== undefined) {
      lines.push(`  pending ${row.pendingCount}; oldest ${formatHeartbeatAge(nowMs - row.oldestPendingTs)} ago (unanswered)`)
    }
  }
  // WAIT line (only when the host has an unanswered/quiet expectation).
  if (snapshot.waitReason !== undefined && snapshot.waitReason.trim() !== '') {
    lines.push(`- WAIT: ${snapshot.waitReason}`)
  }
  // W8-h INTERRUPTED line (always): the postIds in an interrupted/stopped state,
  // or 'none' when clean. The postIds carry no double-brace template token (they
  // are member ids, never a template reference).
  const interrupted = (snapshot.interruptedPostIds ?? []).filter((id) => id.trim() !== '')
  lines.push(interrupted.length > 0 ? `- interrupted: ${interrupted.join(' ')}` : '- interrupted: none')
  return lines.join('\n')
}

/** W8-d SHARED store read (SYNC, non-pure but never throws): resolve the
 * per-post inbox ts (from the delivery sidecar + the message-record ts map) AND
 * the host-ADDRESSED message rows per post (`messageId` + ts, from messages
 * whose `from === hostId`). The delivery sidecar + messages.jsonl are read fresh
 * (never frozen at boot), so a post that wakes/stalls mid-process is judged
 * against its CURRENT activity; a missing/malformed store degrades to empty
 * (never throws). Reuses `computeInboxTsByPost` for the general inbox (the W8-c
 * watchdog path) and produces the host-sender-aware rows for the W8-d WAIT scan.
 */
export function readInboxByPost(
  stateDir: string,
  hostId: string,
  nowMs: number,
  windowMs: number
): { inboxTsByPost: Map<string, number[]>; hostRowsByPost: Map<string, { messageId: string; ts: number }[]> } {
  let deliveryRows: DeliveryRow[] = []
  try {
    deliveryRows = parseDeliveryRows(readFileSync(resolveDeliveriesPath(stateDir), 'utf8'))
  } catch {
    deliveryRows = []
  }
  const messageTs = new Map<string, number>()
  const messageFrom = new Map<string, string>()
  try {
    for (const record of parseMessageRecords(readFileSync(resolveMessagesPath(stateDir), 'utf8'))) {
      messageTs.set(record.id, record.ts)
      messageFrom.set(record.id, record.from)
    }
  } catch {
    /* messages.jsonl absent/malformed → the inbox is empty (never fatal) */
  }
  const inboxTsByPost = computeInboxTsByPost(messageTs, deliveryRows, nowMs, windowMs)
  const hostRowsByPost = new Map<string, { messageId: string; ts: number }[]>()
  for (const row of deliveryRows) {
    if (nowMs - row.ts > windowMs) continue
    if (row.status !== 'prepared' && row.status !== 'delivered' && row.status !== 'resumed') continue
    if (messageFrom.get(row.messageId) !== hostId) continue
    const ts = messageTs.get(row.messageId)
    if (ts === undefined) continue
    let list = hostRowsByPost.get(row.recipientId)
    if (list === undefined) {
      list = []
      hostRowsByPost.set(row.recipientId, list)
    }
    list.push({ messageId: row.messageId, ts })
  }
  return { inboxTsByPost, hostRowsByPost }
}

// ---------------------------------------------------------------------------
// W8-h INTERRUPTED-POST REPORTING (owner: "when the DSH service restarts and
// stops department posts mid-turn, the restart notice only lists the MAIN
// session — department posts are NOT reported; they must surface automatically").
// BOOT RECONCILIATION reuses the W6/W8 alert path: a post whose session log ends
// in an INTERRUPTED (open/stopped) turn is recorded into post-errors.jsonl
// (error class 'interrupted-post') so the W6 health daemon ALERTS the host.
// MECHANISM — NOT a cordis event hook: the harness exposes no global turn/end
// event (the W8-c PART 1 hook decision, see scanTurnErrorCaptures). Instead we
// REUSE the harness's OWN crash-recovery marker: the dsh-session persistence
// backend closes every crash-orphaned OPEN turn with a synthetic `turn/end {
// reason: { kind: 'interrupted' } }` on reload (its `interruptedTurnClosers`).
// A post is INTERRUPTED (stopped) when its session log ends in that state — an
// OPEN turn that no `turn/end` closed (the repair is NOT yet persisted for a
// NOT-resumed post, e.g. a worker), OR a persisted `turn/end` whose
// `reason.kind === 'interrupted'` with no subsequent completed work (the repair
// WAS persisted for a resumed post). A BALANCED log (every turn closed by a
// non-interrupted `turn/end`) is HEALTHY → never flagged (no false positives).
// ---------------------------------------------------------------------------

/** The W8-h dedupe key prefix (`interrupted-post:<postId>`), advanced in
 * health-alerts-state.json so a repeated boot reconciliation does NOT re-alert
 * the same post within HEALTH_DEDUPE_WINDOW_MS. */
export const INTERRUPTED_POST_KEY_PREFIX = 'interrupted-post:'

/** W8-h — ONE post whose session was INTERRUPTED (stopped) by a restart. */
export interface InterruptedPostCapture {
  postId: string
  /** The interrupted (open) turn number, when known (the repair may already have
   * closed it as an explicit `turn/end { interrupted }` marker). */
  turn?: number
  /** The crash-tail ts (ms epoch) — the LAST real session event's time (the
   * persistence backend stamps the synthetic interrupted turn/end with the SAME
   * time, so this is the crash moment bound, not the reload moment). */
  ts: number
  /** The session id the interrupted turn belongs to. */
  sessionId: string
  /** A short human-readable evidence line (the session state/evidence). */
  evidence: string
  /** The bus message id whose processing was interrupted, when the session log
   * carries it (the last surface message before the interrupted turn). */
  messageId?: string
}

/**
 * W8-h DETECTION (PURE, exported) — is a post's session log in an
 * INTERRUPTED/STOPPED state? Reproduces the harness's OWN crash-recovery
 * semantics (`interruptedTurnClosers`): a post is interrupted when its session
 * log ends with an OPEN turn that no `turn/end` closed (Case A — the repair is
 * not yet persisted, a NOT-resumed post), OR when the MOST-RECENT `turn/end` is
 * the persistence backend's synthetic `interrupted` marker with no subsequent
 * completed work (Case B — the repair WAS persisted for a resumed post whose
 * turn was cut by the restart). A BALANCED log (every `turn/start` closed by a
 * non-interrupted `turn/end`) is HEALTHY → undefined (never flagged). An empty /
 * malformed log → undefined (never throws). NO event hook is used (see
 * scanTurnErrorCaptures — the harness exposes no global turn/end event).
 */
export function scanInterruptedTurn(
  events: readonly HealthSessionEvent[],
  sessionId: string,
  postId: string
): InterruptedPostCapture | undefined {
  let openTurn: number | undefined
  let lastTurnEndKind: string | undefined
  let lastTurnEndTs: number | undefined
  let lastEventTs: number | undefined
  let lastSurfaceMessageId: string | undefined
  for (const event of events) {
    if (typeof event.time === 'number' && Number.isFinite(event.time)) {
      if (lastEventTs === undefined || event.time > lastEventTs) lastEventTs = event.time
    }
    if (event.type === 'turn/start') {
      const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
      openTurn = typeof data.turn === 'number' ? data.turn : openTurn
    } else if (event.type === 'turn/end') {
      const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
      const reason = (typeof data.reason === 'object' && data.reason !== null ? data.reason : {}) as Record<string, unknown>
      lastTurnEndKind = typeof reason.kind === 'string' ? reason.kind : undefined
      lastTurnEndTs = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : undefined
      openTurn = undefined
      lastSurfaceMessageId = undefined
    } else if (event.type === 'user/message' || event.type === 'assistant/message') {
      // A surface message BEFORE an open turn is the message the post was
      // processing when the turn was interrupted — a best-effort messageId.
      const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
      const message = (typeof data.message === 'object' && data.message !== null ? data.message : {}) as Record<string, unknown>
      const candidate = typeof message.id === 'string'
        ? message.id
        : (typeof data.id === 'string' ? data.id : (typeof data.messageId === 'string' ? data.messageId : undefined))
      if (candidate !== undefined) lastSurfaceMessageId = candidate
    }
  }
  // Case A — an OPEN turn with no turn/end after it (the repair is not persisted).
  if (openTurn !== undefined) {
    const ts = lastEventTs ?? lastTurnEndTs ?? 0
    return {
      postId,
      sessionId,
      turn: openTurn,
      ts,
      ...(lastSurfaceMessageId !== undefined ? { messageId: lastSurfaceMessageId } : {}),
      evidence: `interrupted turn ${openTurn} (no turn/end — stopped by a restart)`
    }
  }
  // Case B — the most-recent turn/end is the persistence backend's synthetic
  // `interrupted` marker with no subsequent completed work.
  if (lastTurnEndKind === 'interrupted') {
    const ts = lastTurnEndTs ?? lastEventTs ?? 0
    return {
      postId,
      sessionId,
      ...(lastTurnEndTs === undefined && lastSurfaceMessageId !== undefined ? { messageId: lastSurfaceMessageId } : {}),
      ts,
      evidence: 'interrupted turn (closed by the reload repair — stopped by a restart)'
    }
  }
  return undefined
}

/** W8-h — one registered post's reconciliation input (the session event log is
 * injected so the pure reconciliation is fixture-testable). */
export interface InterruptedPostInput {
  postId: string
  sessionId: string
  retired?: boolean
  events?: readonly HealthSessionEvent[]
}

/** W8-h — the result of ONE interrupted-post boot reconciliation. */
export interface InterruptedPostReconciliation {
  /** Every post whose session shows an interrupted (stopped) turn. */
  interrupted: string[]
  /** How many NET-NEW post-error rows were appended (after the dedupe window). */
  appended: number
}

/**
 * W8-h BOOT RECONCILIATION (exported; the I/O is parameterized so a test drives
 * it with injected fixtures + a fixed clock). For each registered post, read its
 * session event log (the production wiring reads the DURABLE session so a
 * NOT-resumed worker is judged against its on-disk crash tail; a test injects
 * fixtures). A post whose session ends in an INTERRUPTED turn, FRESH inside the
 * restart window (the crash-tail ts is AFTER the previous boot's last heartbeat
 * `restartAfterTs` AND within HEALTH_ERROR_WINDOW_MS), gets ONE post-error row
 * (error class 'interrupted-post') appended to post-errors.jsonl → the W6 daemon
 * ALERTS the host. NET-NEW per post per HEALTH_DEDUPE_WINDOW_MS (the shared
 * health-alerts-state.json ledger, key 'interrupted-post:<postId>'); a repeated
 * reconciliation inside the window does NOT re-append/alert, and re-alerts once
 * AFTER the window. A retired post is never flagged; a balanced (healthy) log is
 * never flagged. NEVER throws (every internal failure is a warn/skip).
 */
export async function reconcileInterruptedPosts(deps: {
  now: () => number
  stateDir: string
  postEvents: Iterable<InterruptedPostInput>
  /** The restart-window lower bound (the PREVIOUS boot's last heartbeat ts): only
   * an interruption whose crash-tail ts is AFTER this is flagged (the 'Stopped'
   * class is THIS restart, not an old crash). Absent → the 2h freshness window
   * alone bounds it. */
  restartAfterTs?: number
  logger?: { warn(message: string): void; info(message: string): void }
}): Promise<InterruptedPostReconciliation> {
  const nowMs = deps.now()
  const out: InterruptedPostReconciliation = { interrupted: [], appended: 0 }
  try {
    const state = readHealthAlertsState(deps.stateDir)
    const nextState = { ...state }
    let stateChanged = false
    for (const post of deps.postEvents) {
      if (post.retired === true) continue
      const capture = scanInterruptedTurn(post.events ?? [], post.sessionId, post.postId)
      if (capture === undefined) continue
      out.interrupted.push(post.postId)
      // Restart-window bound: crash-tail AFTER the previous heartbeat AND fresh
      // inside the W6 alert freshness window (the daemon scans the SAME window).
      const afterRestart = deps.restartAfterTs === undefined || capture.ts > deps.restartAfterTs
      const fresh = nowMs - capture.ts <= HEALTH_ERROR_WINDOW_MS
      if (!afterRestart || !fresh) continue
      // Dedupe: ≤1 post-error row per post per HEALTH_DEDUPE_WINDOW_MS.
      const key = `${INTERRUPTED_POST_KEY_PREFIX}${post.postId}`
      if (nextState[key] !== undefined && nowMs - nextState[key] <= HEALTH_DEDUPE_WINDOW_MS) continue
      await appendPostError(deps.stateDir, {
        ts: capture.ts,
        postId: post.postId,
        ...(capture.messageId !== undefined ? { messageId: capture.messageId } : {}),
        error: `interrupted-post: ${capture.evidence}`
      }, nowMs)
      nextState[key] = nowMs
      stateChanged = true
      out.appended++
    }
    if (stateChanged) await writeHealthAlertsState(deps.stateDir, nextState)
  } catch (error: unknown) {
    deps.logger?.warn(`[deepartments] interrupted-post reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return out
}

// ---- W6 system-health tick (PURE — injectable clock + notify hook) ---------
// Mirrors the agenda/parallel-monitor ticks: a plugin daemon (NOT an agent)
// that every `health.intervalMs` writes the heartbeat and scans for anomalies.
// The tick is PURE — the clock + the host notify hook are injected — so a test
// drives it deterministically with a fixed clock; the production wiring binds
// the live hosts registry + the bus delivery seam.

/** Injected hooks + inputs one system-health tick reads. The PRODUCTION wiring
 * binds the live hosts registry + the bus delivery seam; tests construct this
 * directly with a FIXED clock + a recording notifyHost. NEVER throws (every
 * internal failure is a warn). */


/** Structural view of the plugin config the tick reads. The BUNDLE passes its
 * org.ts `Config` (whose `health?: HealthConfig` carries these knobs) — the
 * package declares ONLY the `health.*` fields the tick consumes, so there is
 * NO back-dependency on the bundle (a structural cast; extra config fields are
 * ignored by the assignment). */
export interface HealthConfigLike {
  health?: {
    /** W8-c PART 1 — turn-error capture (default ON; an explicit false disables). */
    turnErrorCaptureEnabled?: boolean
    /** LANE 2 (fb-27, QD ALTO/mejora) — turn/end-ERROR HEAD NOTIFICATION
     * (default ON; an explicit false disables — no head notification is
     * emitted). A FRESH turn/end error in a live post's session event log is
     * notified to the POST'S OWN HEAD (its creator `managerId`, or its
     * department coordinator) with the session+turn provenance, deduped via its
     * OWN ledger `turn-end-notify-state.json` keyed `postId:turn` — INDEPENDENT
     * of `turnErrorCaptureEnabled` (which records into post-errors.jsonl), so a
     * head is alarmed even when the capture is off. Only a capture with BOTH a
     * sessionId AND a turn is notified (fb-25 mandatory provenance); the
     * `notifyHead` dep absent → conservative no-op (R6). */
    turnEndErrorNotifyEnabled?: boolean
    /** W8-c PART 2 — stale-live watchdog (default ON; explicit false disables). */
    staleLiveWatchdogEnabled?: boolean
    /** W8-c PART 2 — the staleness threshold in minutes (default 10). */
    staleLiveMinutes?: number
    /** W8-c PART 3 — preset audit (default ON; explicit false disables). */
    presetAuditEnabled?: boolean
    /** W8-d — the system-heartbeat gate (default ON; explicit false omits the
     * wake-pack section + the conditional wake). */
    heartbeatEnabled?: boolean
    /** W8-d PART C — the quiet-expectation wait threshold (default 30 min). */
    waitThresholdMs?: number
    /** M1 — pooler-capacity watchdog gate (default ON; explicit false disables
     * the pooler-capacity scan). The scan READS the pooler's own state file
     * (`<dshHome>/keyPooler-state.json` — the path the bundle injects via
     * `deps.poolerStatePath`, override `health.poolerStateFilePath`) SOLO-LECTURA:
     * the pooler owns every write, the watchdog never writes it. */
    poolerCapacityEnabled?: boolean
    /** HARDENING-401 (fb-39, 2026-09-01) — the CAPACITY GATE monitor gate
     * (default ON; explicit false restores the gate-less daemon). When ON, the
     * system-health daemon's capacity-gate TRANSITION monitor pauses new
     * host→dept dispatches the moment the pool reaches capacity CRÍTICO (the
     * billing/credits class or the CERTAIN usable=0 / 429-rotation prelude —
     * the SAME `scanPoolerCapacity` verdict the M1 watchdog uses) and resumes
     * on recovery — the «pausa de nuevos despachos» mirror of the franja PEAK
     * pause, with a durable notice on every state flip (never silent). Absent
     * → ON (0 change with a healthy pool: the verdict stays OK, no notice). */
    poolerGateEnabled?: boolean
    /** DISPATCH-HARDENING (QH «429-primer-call», 2026-08-28) — the DISPATCH
     * pre-check gate (default ON; explicit false restores the pre-check-less
     * dispatch). When ON, the worker/head dispatch seams reject LOUDLY and
     * EARLY when the pooler snapshot certifies NO workspace can serve the
     * spawn's first call (zero usable keys, every usable key at/above
     * `highPercent`, or a last 429 rotation to no key). Reads the SAME
     * `<dshHome>/keyPooler-state.json` SOLO-LECTURA; absent/stale → passthrough
     * (conservative — the pre-check is a warning, never a blocker). */
    poolerDispatchEnabled?: boolean
    /** M1 — ≤ this many USABLE keys (same eligibility the pooler uses:
     * `!invalid && blockedUntil<=now && cooldownUntil<=now`) → a
     * `pooler-capacity:warning` finding (default 2). */
    warningUsableKeys?: number
    /** M1 — ≤ this many USABLE keys → a `pooler-capacity:critical` finding —
     * the mission's "alert BEFORE paralysis" threshold (default 1). */
    criticalUsableKeys?: number
    /** M1 — ≥ this many currently BLOCKED/cooldown keys (blockedUntil/cooldownUntil
     * in the future) → a `pooler-capacity:warning` finding (default 3). */
    blockedKeysInWindow?: number
    /** M1 — a usable key whose upstream usage percent (`lastUsage.percent`, the
     * x-ratelimit leading indicator the pooler already fetched) is >= this →
     * a `pooler-capacity:warning` finding (default 90 — mirrors the pooler's own
     * highPercent). */
    highPercent?: number
    /** M1 — the staleness window (default 10 min): the pooler writes the state
     * file ONLY on health changes, so `updatedAt` ages on a quiet grid. When
     * `now - updatedAt` exceeds this the pool's state is STALE = UNKNOWN → the
     * scan logs a `warn` (naming the age) and returns NO finding — a
     * quiet-but-healthy grid looks stale by design; the real exhaustion (the
     * dead-man's-switch intent) is caught by the CERTAIN critical branches: a
     * 429 rotation to NO key (`lastRotation.to === null`) or usable ≤
     * `criticalUsableKeys`. */
    stateStaleMs?: number
    /** M1 — qi-silence watchdog gate (default ON; explicit false disables the
     * qi-silence scan). */
    qiSilenceEnabled?: boolean
    /** M1 — the qi-silence window in minutes: worker retirements (ledger
     * firstSeen) AND quality-inspect directives (messages.jsonl ts) are counted
     * inside this window (default 120). */
    qiSilenceWindowMinutes?: number
    /** M1 — the minimum worker retirements in the window with ZERO emitted
     * quality-inspect directives that alerts (`qi-silence`). Absent → the
     * RATE-AWARE default: the smallest n with P(0 directives | p)^n <= 5% =
     * ceil(ln(0.05)/ln(1-p)) (p = the shared worker-inspect dice from
     * `deps.qiDirectiveRate`): p=0.25 → 11, p=1 → 1 (any silent retirement is a
     * symptom), p<=0 → never (by-design silence). An explicit value overrides
     * the rate-aware formula. */
    qiSilenceMinRetiresInWindow?: number
    /** M4 — the system-idle watchdog gate (default ON; explicit false disables
     * the system-idle scan — the global-quiet detector). */
    systemIdleEnabled?: boolean
    /** M4 — the GLOBAL-quiet window in ms: the catalog has ZERO agents running
     * for >= this long while SOME non-retired post still holds pending work →
     * a `system-idle` finding + host ALERT (default 900000 = 15 min — shorter
     * than the 30-min per-message system-wait threshold because global quiet is
     * graver than one per-message wait). */
    idleWindowMs?: number
    /** M-A — the context-threshold watchdog gate (default ON; explicit false
     * disables the context-pressure monitor). */
    contextThresholdEnabled?: boolean
    /** M-A — the session-context window-usage FRACTION that alerts: a post or
     * the host using MORE than this of its contextWindow (projected tokens /
     * window) → a `context-threshold` finding + host ALERT (default 0.5 = the
     * 50% trigger). A fraction in (0,1); absent/invalid → 0.5. */
    contextThreshold?: number
    /** M-A — the context-threshold scan cadence in ms (default 60000 = the
     * per-minute WAIT pattern): the scan runs at most once per
     * `contextThresholdPollMs` bucket (the first tick of a bucket; a faster
     * `health.intervalMs` re-fire inside the SAME bucket skips the scan).
     * Absent/invalid → 60000. */
    contextThresholdPollMs?: number
    /** M-5 — the mission-stalled watchdog gate (default ON; explicit false
     * disables the delivered-but-unstarted-mission scan). */
    missionStallEnabled?: boolean
    /** M-5 — the mission-stall window in ms: a HEAD post with a host→head
     * mission DELIVERY at least this old and NO turn/session write after the
     * delivery ts → a `mission-stalled` finding + host ALERT (default 600000
     * = 10 min). Absent/invalid → 600000. */
    missionStallMs?: number
    /** M-6 — the main-red watchdog gate (default ON; explicit `false`
     * disables the post-commit re-verification scan). */
    mainRedEnabled?: boolean
    /** M-6 — the main-red HEAD POLL cadence in ms (default 300000 = 5 min): a
     * NEW commit at HEAD is detected within minutes (the mission's core
     * promise — never hours). Absent/invalid → 300000. */
    mainRedPollMs?: number
    /** M-6 — the FAST locks the post-commit re-verification runs (repo-relative
     * paths). Absent → the 8-lock default (boot-factory + the 4 orchestration
     * factories + the surface locks). An explicit non-empty array overrides. */
    mainRedLocks?: string[]
    /** M-6 — the repo root whose git HEAD the watchdog reads (default: the
     * bundle's REPO_ROOT — the dev repo the host commits; override for a
     * packaged deployment where the repo lives elsewhere, and for the SMOKE
     * fixture). Absent → REPO_ROOT. */
    mainRedRepoRoot?: string
    /** M-7 — the mission-queue watchdog gate (default ON; explicit false
     * disables the head mission-backlog scan). */
    missionQueueEnabled?: boolean
    /** M-7 — the pendingCount THRESHOLD: a non-retired HEAD post whose PENDING
     * (undrained) addressed messages — the buildPostSnapshot pendingCount —
     * are >= this count → a `mission-queue` finding + host ALERT (default 5).
     * Absent/invalid → 5. */
    missionQueueLimit?: number
    /** M-7 — the PERSISTENCE window in ms: the over-limit queue must HOLD for
     * >= this long before it alerts (a transient spike — one tick over the
     * limit — NEVER does; the M4 firstQuietTs sustained-condition precedent:
     * the M-7 ledger records the firstSeen of the sustained over-limit queue).
     * Default 60000 = one poll tick at the default 60 s health interval.
     * Absent/invalid → 60000. */
    missionQueuePersistMs?: number
    /** fb-30 — the BOOT CATCH-UP gate (default ON; an explicit false disables
     * the boot catch-up pass — the daemon boot never re-scans the old durable
     * windows). Runs ONLY on the FIRST tick of a NEW daemon process (the
     * per-process bootId differs from the on-disk heartbeat's — the same id
     * the fb-43 restart-registry reconcile REUSES); a re-tick of the SAME
     * boot never re-runs it. Never touches the scheduler/dispatch; finds ride
     * the EXISTING findings→dedupe→notifyHost→audit path (the shared
     * health-alerts ledger). */
    catchupEnabled?: boolean
    /** fb-30 — the bounded BOOT catch-up look-back window in ms (default 24 h):
     * durable post-error / delivery-failed rows OLDER than the live 2 h anomaly
     * window but WITHIN this look-back are caught up ONCE at boot (their own
     * CATCH-UP frame); rows beyond the look-back stay silent by design.
     * Absent/invalid → 86400000 (24 h). */
    catchupWindowMs?: number
    /** LANE 5 (fb-46) — the work-register-idle watchdog gate (default ON; an
     * explicit false disables the WORK-REGISTER docs-level stall scan). */
    workRegisterIdleEnabled?: boolean
    /** LANE 5 (fb-46) — the WORK-REGISTER-idle VALLE-quiet window in ms (default
     * 900000 = 15 min): the franja VALLE ∧ WORK-REGISTER has NON-gated pending
     * items ∧ ZERO agents running must hold for >= this long before the
     * `work-register-idle` finding + host ALERT (the M4 firstQuietTs
     * sustained-condition precedent, own ledger work-register-idle-state.json).
     * Absent/invalid → 900000. */
    workRegisterIdleQuietMs?: number
  }
  /** PACING (owner m-PACING, 2026-08-28) — the top-level `org.pacing.*`
   * franja config the transition monitor reads (the bundle passes its whole
   * Config cast structurally; `config.org.pacing` mirrors the bundle org.ts
   * PacingConfig → the dshd-core PacingConfigLike). ABSENT → the code defaults
   * (enabled ON, weekday [1..5], hours {1,2,3,6,7,8,9} UTC, peakBufferMs
   * 1800000 = 30 min); an explicit `org.pacing.enabled === false` restores the
   * pre-pacing behavior (no transition monitor, no notices). */
  org?: {
    pacing?: PacingConfigLike
  }
}


export interface HealthDaemonDeps {
  /** The clock (ms epoch) — injectable so a tick test is deterministic. */
  now(): number
  /** The stateDir whose health-heartbeat.json / post-errors.jsonl /
   * deliveries.jsonl / health-alerts-state.json / health-alerts.jsonl the tick
   * reads/writes. */
  stateDir: string
  /** The per-process boot id (randomUUID) stamped into the heartbeat. */
  bootId: string
  /** The plugin Config (W6: `health.enabled`/`health.intervalMs`). The pure tick
   * reads the W8-c per-safeguard knobs (`turnErrorCaptureEnabled` /
   * `staleLiveWatchdogEnabled` + `staleLiveMinutes` / `presetAuditEnabled`) from
   * `config.health`, with code-defaults (all enabled, 10 min) when absent.
   * STRUCTURAL (HealthConfigLike — see above): the bundle passes its org.ts
   * Config cast structurally; the package never imports org.ts. */
  config?: HealthConfigLike
  /** The live hosts registry (the Asistente). Resolved per tick via
   * pickLiveHostEntry (consumed once — a single-use iterator is fine). */
  hosts: Iterable<HostEntryLike>
  /** W8-c PART 1/2 — the catalog posts (activity + inbox inputs) the turn-error
   * capture and the stale-live watchdog scan. Absent → [] (the safeguards are
   * no-ops; a hermetic test omits it). CONSUMED ONE — the tick materializes it
   * into an array so both safeguards share the same snapshot. */
  posts?: Iterable<PostActivityInput>
  /** W8-d PART B — the host-sender-aware inputs the CONDITIONAL system-wait scan
   * reads (postId + events + host-sent message rows). Absent → [] (the
   * conditional wake is a no-op; a hermetic test omits it). CONSUMED ONE — the
   * tick materializes it into an array so the WAIT scan shares the same
   * `buildPostSnapshot` computation. The production wiring resolves it from the
   * LIVE host's sent messages (see buildHostWaits). */
  hostWaits?: Iterable<HostWaitPostInput>
  /** C6 — the delivery-row reader for the delivery-failed scan. Absent → the
   * legacy FULL-file read (every tick re-parses ALL of deliveries.jsonl — the
   * default/tests); the PRODUCTION daemon injects a TAIL reader
   * (createDeliveryRowsTailReader) whose byte-offset cursor lives in its own
   * closure (created once per daemon), so a 60 s tick parses only the rows
   * written since the previous tick. The findings/alerts are IDENTICAL either
   * way (the scan filter pipeline is unchanged) — only the per-tick work
   * shrinks. */
  deliveryRowsReader?: DeliveryRowsReader
  /** M1 — the absolute path of the pooler's `keyPooler-state.json` the
   * pooler-capacity watchdog READS (READ-ONLY — the pooler owns every write;
   * the scan never writes it). Absent → the pooler-capacity scan is a no-op
   * (the production wiring resolves it as `<dshHome>/keyPooler-state.json`,
   * `health.poolerStateFilePath` override; a hermetic tick test injects a path
   * into a temp fixture). */
  poolerStatePath?: string
  /** M1 — the shared worker-inspect dice probability p (the bundle resolves it
   * from `quality.workerInspectProbability` via resolveQualityWorkerInspectProbability
   * — the SAME p the directive EMITTER samples, single source of truth). The
   * qi-silence watchdog derives its rate-aware minimum on it. Absent →
   * 0.25 (the code default). */
  qiDirectiveRate?: number
  /** M4 — the HOST agent's live running signal: whether the LIVE (non-retired)
   * host's session is CURRENTLY mid-turn (`agents.get(SessionId(hostEntry.sessionId))
   * ?.status === 'running'` — the SAME expression the bundle's buildCatalogRows
   * uses for the host row; absent `agents` registry → false). ABSENT (undefined)
   * → the system-idle scan is a NO-OP (a wiring that cannot resolve the host's
   * live status can never certify zero-running — the conservative direction:
   * unknown liveness never fabricates a global-quiet ALERT; the
   * `poolerStatePath`-absent pattern). */
  hostRunning?: boolean
  /** M-A — the per-agent session-context rows the context-threshold scan reads:
   * one row per non-retired post + the live host's OWN row (hostId, no
   * postId — the M4 host-not-a-pseudo-post rule), with the token-meter
   * `contextPressure` projection numbers (contextWindow / pressureTokens /
   * surfaceTokens / sampledSurfaceTokens) resolved LIVE by the bundle from the
   * in-process `ctx.sessionProjections` service (`stateOf(session,
   * 'contextPressure')` — the eager-driven, zero-I/O projection; the durable
   * session_projcache.json is only its cross-process mirror). ABSENT
   * (undefined) → the context-threshold scan is a NO-OP (a wiring that cannot
   * resolve the projection registry can never certify window usage; unknown
   * pressure never fabricates an alert — the hostRunning/poolerStatePath-
   * absent pattern). CONSUMED ONE — the tick materializes it once. */
  sessionContexts?: Iterable<SessionContextInput>
  /** M-5 — the per-HEAD-post mission-activity rows the mission-stalled scan
   * reads: one row per non-retired HEAD post with the LAST host→head mission
   * DELIVERY row (messageId + delivery-row ts) + the post's last session
   * activity ts — computed by the bundle's `buildMissionActivity` from the
   * message store (messages.jsonl + deliveries.jsonl), the catalog
   * (non-retired posts) and the session-event primitive (buildPostSnapshot).
   * ABSENT (undefined) → the mission-stalled scan is a NO-OP (a wiring that
   * cannot resolve the mission-delivery seam never fabricates a
   * delivered-but-unstarted ALERT — the hostRunning/sessionContexts-absent
   * pattern). CONSUMED ONE — the tick materializes it once. */
  missionActivity?: Iterable<MissionActivityInput>
  /** M-7 — the per-HEAD-post mission-queue input rows the mission-queue scan
   * reads: ONE row per non-retired HEAD post (postId + the SAME activity
   * inputs buildPostSnapshot consumes — events + inboxTs — so the pendingCount
   * the scan thresholds is the EXACT W8-c/M4 primitive, no duplication).
   * Computed by the bundle from `buildHealthPosts` (the EXISTING per-tick
   * catalog source, materialized ONCE, filtered to `provider !== 'worker'`).
   * ABSENT (undefined) → the mission-queue scan is a NO-OP (a wiring that
   * cannot resolve the per-head queue never fabricates a backlog ALERT — the
   * hostRunning/missionActivity-absent pattern). CONSUMED ONE — the tick
   * materializes it once. */
  missionQueue?: Iterable<MissionQueueInput>
  /** M-6 — the main-red watchdog runtime: the bundle's `buildMainRedState`
   * over `repoRoot` (knob `mainRedRepoRoot` ?? REPO_ROOT) — the git-HEAD
   * reader (`readHeadSha()` = git rev-parse HEAD) + the fast-lock runner
   * (`runLocks(paths)` = node --test per lock, one single execution per new
   * sha). ABSENT (undefined) → the main-red scan is a NO-OP (a wiring without
   * the repo/git seam can never certify the HEAD — unknown main state never
   * fabricates a post-commit alert; the hostRunning/sessionContexts-absent
   * pattern). CONSUMED ONE — the tick materializes it once per poll bucket. */
  mainRed?: MainRedRuntime
  /** Deliver the framed ALERT bus message to the host (production:
   * messagesStoreReady.append + busDeliverToHost; tests: a recording stub).
   * NEVER throws. */
  notifyHost(hostEntry: HostEntryLike, alertFrame: string): Promise<void>
  /** LANE 2 (fb-27) — deliver the framed turn/end-error NOTIFICATION to the
   * POST'S OWN HEAD (production: the bundle's `healthNotifyHead` closure —
   * resolves the head via the post's creator `managerId` / department
   * coordinator and store.append + busDeliverToPost, the daemon→head pattern;
   * hermetic tests: a recording stub). ABSENT (undefined) → the turn-end-notify
   * block is a CONSERVATIVE NO-OP (the legacy behavior, R6 — an unresolved
   * wiring never fabricates a head notification). NEVER throws. */
  notifyHead?: (postId: string, frame: string) => Promise<void>
  /** PACING (owner m-PACING, 2026-08-28) — the absolute path of the repo's
   * WORK-REGISTER.md (docs/WORK-REGISTER.md in the bundle wiring), read ONLY
   * at a VALLE transition for the «reanuda; despachos diferidos: N» count.
   * ABSENT (or unreadable) → the notice omits the count (never throws). */
  workRegisterPath?: string
  /** Optional warn-capable logger (absent dep → the warn is dropped). */
  logger?: { warn(message: string): void; info(message: string): void }
}

/** Group fresh post-errors inside HEALTH_ERROR_WINDOW_MS, deduped per postId
 * (multiple rows for the same postId within the window → ONE finding). W8-i: a
 * DISTINCT error class (e.g. 'session not found') gets its OWN per-(post+class)
 * dedupe key `post-error:<postId>:<class>` so a repeated not-found attempt
 * never re-alerts per attempt; the generic class keeps the legacy
 * `post-error:<postId>` key (existing behavior unchanged).
 * Bug A (defense-in-depth): a `retiredHostIds` set of RETIRED host ids is
 * threaded in so a LEGACY post-error row for a retired host on disk (e.g. a
 * pre-rotation row) is never a finding/alert — a retired host is terminal (W7
 * philosophy) and its rows must not re-alert the live host. Optional (logical
 * OR default) so existing callers/tests that do not have the set keep working. */
export function scanPostErrorFindings(stateDir: string, nowMs: number, retiredHostIds?: ReadonlySet<string>): HealthFinding[] {
  const inWindow = readPostErrorsFile(stateDir).filter((row) => nowMs - row.ts <= HEALTH_ERROR_WINDOW_MS)
  const fresh = retiredHostIds === undefined ? inWindow : inWindow.filter((row) => !retiredHostIds.has(row.postId))
  const byGroup = new Map<string, PostErrorEntry[]>()
  for (const row of fresh) {
    const cls = postErrorClass(row.error)
    const groupKey = cls === undefined ? row.postId : `${row.postId}\u0000${cls}`
    const list = byGroup.get(groupKey) ?? []
    list.push(row)
    byGroup.set(groupKey, list)
  }
  const findings: HealthFinding[] = []
  for (const [groupKey, rows] of byGroup) {
    const split = groupKey.indexOf('\u0000')
    const postId = split === -1 ? groupKey : groupKey.slice(0, split)
    const cls = split === -1 ? undefined : groupKey.slice(split + 1)
    findings.push({
      kind: 'post-error',
      key: cls === undefined ? `post-error:${postId}` : `post-error:${postId}:${cls}`,
      postId,
      ts: rows.reduce((max, row) => Math.max(max, row.ts), 0),
      error: rows[0].error,
      count: rows.length,
      // fb-25 (b): the PROVENANCE of rows[0] (the row whose error text the alert
      // shows) rides ONLY when the row carried it — additive, the legacy
      // postId-only grouping/identity never changes (R6).
      ...(typeof rows[0].sessionId === 'string' && rows[0].sessionId !== '' ? { sessionId: rows[0].sessionId } : {}),
      ...(typeof rows[0].turn === 'number' && Number.isFinite(rows[0].turn) ? { turn: rows[0].turn } : {})
    })
  }
  return findings
}

/** The delivery-row read seam of one health scan (C6). A `DeliveryRowsReader`
 * returns the rows a tick must scan from `<stateDir>/deliveries.jsonl` and
 * NEVER throws (an absent sidecar → []). */
export type DeliveryRowsReader = (stateDir: string) => DeliveryRow[]

/** The DEFAULT reader — the legacy FULL-file read: every call re-reads + parses
 * ALL of deliveries.jsonl (byte-identical to the pre-C6 behavior). Any caller
 * that does not inject a reader (the W7-A direct-scan tests included) keeps
 * working unchanged. */
export function readDeliveryRowsFull(stateDir: string): DeliveryRow[] {
  try {
    return parseDeliveryRows(readFileSync(resolveDeliveriesPath(stateDir), 'utf8'))
  } catch {
    return []
  }
}

/** C6 — build ONE tail-reading `DeliveryRowsReader` for a daemon process. The
 * reader keeps a `{ fileSize, offset }` byte-offset cursor in its own closure
 * (created ONCE per daemon in the production wiring, so the cursor survives the
 * 60 s ticks): a call parses ONLY the rows written AFTER the previous call —
 * the sidecar is append-only JSONL (one writer `markDelivery`, rows timestamped
 * at write), so the delta is exactly what the tick has not scanned yet. This
 * replaces the O(n)-per-tick full re-parse (n unbounded between boots) with
 * O(delta) typical work. Correctness guards: (1) the FIRST call (cursor at 0)
 * and a call after a SHRINK — the boot redelivery driver REWRITES the sidecar,
 * `stat.size < offset` — re-read from byte 0 ONCE (a read from a past-the-end
 * offset would silently return nothing); (2) an absent sidecar → [] (cursor
 * reset). The tick's filter pipeline (status window, retired set, last-wins
 * dedupe) is applied by the CALLER unchanged, so the observed findings/alerts
 * are identical to the full scan in the same window — only the per-tick parse
 * work shrinks. NOTE (twin-daemon safety): the cursor points INTO THE FILE,
 * never into a per-process index — a twin daemon sharing the stateDir appends
 * rows the file tail still exposes to BOTH daemons (no false negatives). */
export function createDeliveryRowsTailReader(): DeliveryRowsReader {
  let fileSize = 0
  let offset = 0
  return (stateDir: string): DeliveryRow[] => {
    const filePath = resolveDeliveriesPath(stateDir)
    let fd: number
    try {
      fd = openSync(filePath, 'r')
    } catch {
      fileSize = 0
      offset = 0
      return []
    }
    try {
      const stat = fstatSync(fd)
      // Clamp: the file shrank below the cursor (boot compaction / rewrite) →
      // re-scan from byte 0 once; otherwise resume from the previous EOF.
      const start = stat.size < offset ? 0 : offset
      const tailSize = stat.size - start
      fileSize = stat.size
      offset = stat.size
      if (tailSize <= 0) return []
      const buffer = Buffer.alloc(tailSize)
      let read = 0
      while (read < tailSize) {
        const n = readSync(fd, buffer, read, tailSize - read, start + read)
        if (n <= 0) break
        read += n
      }
      // The tail starts right after a '\n' (every row is written with a trailing
      // newline) → the delta is whole rows; parseDeliveryRows keeps its tolerance
      // for a trailing partial line (a crash mid-append).
      return parseDeliveryRows(buffer.toString('utf8', 0, read))
    } finally {
      closeSync(fd)
    }
  }
}

/** Group fresh delivery 'failed' rows inside HEALTH_ERROR_WINDOW_MS, deduped per
 * messageId (multiple rows for the same messageId → ONE finding).
 * Bug (re-alert loop): a `retiredMemberIds` set of RETIRED member ids (hosts +
 * posts) is threaded in so a `failed` row whose recipient is a RETIRED member is
 * never a finding/alert — a retired member is terminal (W7 philosophy) and its
 * `failed` rows must not re-alert the live host every ~30 min until a boot lets
 * the redeliver driver settle them to 'terminal'. Optional (logical OR default)
 * so existing callers/tests that do not have the set keep working.
 * C6: the OPTIONAL 4th arg is the delivery-row READER (default = the legacy
 * full-file read, `readDeliveryRowsFull`) — the production daemon injects a TAIL
 * reader whose byte-offset cursor re-reads only the rows appended since the last
 * tick; the filter pipeline below is IDENTICAL either way (same window, same
 * dedupe, same alerts — only the per-tick parse work shrinks).
 * C8 (structural-loop invariant): the daemon's ALERT is delivered via
 * store.append + busDeliverToHost DIRECT (`notifyHost` in the production wiring)
 * and NEVER through the delivery engine — no `prepared`/`failed`/`terminal` row
 * for an ALERT is ever written to deliveries.jsonl. This scanner therefore can
 * never see an ALERT as a `failed` row, so the audit's theoretical
 * alert→delivery-failed→re-alert loop is structurally impossible here; a
 * delivery failure of an ALERT is bounded elsewhere (W8-i attach-repair retry +
 * the DEDUPED post-error recording + M3 quarantine). */
export function scanDeliveryFindings(
  stateDir: string,
  nowMs: number,
  retiredMemberIds?: ReadonlySet<string>,
  reader: DeliveryRowsReader = readDeliveryRowsFull
): HealthFinding[] {
  let rows: DeliveryRow[] = []
  try {
    rows = reader(stateDir)
  } catch {
    rows = []
  }
  // W7-A: only `status === 'failed'` rows are anomalies. A `terminal` row (a
  // dead/unknown recipient settled once by the boot re-delivery driver) is by
  // definition NOT a failure and is NEVER re-attempted, so it is naturally
  // excluded here — a terminal row can never become a `delivery-failed` alert.
  // Guard: an unknown/garbage status is likewise never an anomaly (the filter
  // is the whitelist — only 'failed' is scanned).
  const inWindow = rows.filter((row) => row.status === 'failed' && nowMs - row.ts <= HEALTH_ERROR_WINDOW_MS)
  const fresh = retiredMemberIds === undefined ? inWindow : inWindow.filter((row) => !retiredMemberIds.has(row.recipientId))
  const byMessage = new Map<string, DeliveryRow>()
  for (const row of fresh) byMessage.set(row.messageId, row) // last-wins
  const findings: HealthFinding[] = []
  for (const [messageId, row] of byMessage) {
    findings.push({
      kind: 'delivery-failed',
      key: `delivery-failed:${messageId}`,
      messageId,
      ts: row.ts,
      count: 1
    })
  }
  return findings
}

/** fb-30 CATCH-UP (LANE 4, 2026-09-01) — the BOUNDED BOOT scan over the
 * DURABLE event ledgers for events that fell OUTSIDE the LIVE anomaly window
 * and were never alerted (the quiet-band blind spots documented in §3b of the
 * VALLE lane-A report: a capture gap with a LIVE heartbeat — a turn-error /
 * post-error / failed delivery entered a freshness window [turn-error 10 min,
 * scan 2 h] and NO tick observed it, so it was permanently invisible to the
 * snapshot scanner). Runs ONLY at the daemon's FIRST tick (a new boot —
 * `isBootTick` in runHealthDaemonTick), bounded by `windowMs` (default
 * HEALTH_CATCHUP_WINDOW_MS = 24 h):
 *
 *   - SOURCES (the durable ledgers §3b identifies): post-errors.jsonl + the C9
 *     forensia archive post-errors-archive.jsonl (an appendPostError C9
 *     discard archives every row older than the 2 h anomaly window — the
 *     archive therefore holds EXACTLY the rows the live scan can never alert)
 *     + deliveries.jsonl `failed` rows.
 *   - WINDOW: `nowMs - row.ts > HEALTH_ERROR_WINDOW_MS` (strictly OUTSIDE the
 *     live 2 h scan — the live scan owns the fresh rows; the windows are
 *     DISJOINT, so a catch-up finding can never duplicate a live alert by
 *     construction) AND `nowMs - row.ts <= windowMs` (inside the bounded
 *     look-back; older rows stay silent by design).
 *   - GROUPING: identical to the live scans (per (postId, class) /
 *     per messageId) with the LIVE identity keys — the SHARED health-alerts
 *     ledger dedupes them verbatim: an identity already alerted by a previous
 *     boot (its ledger entry is still on disk at the new boot's FIRST tick —
 *     the first-tick ledger read happens BEFORE the defensive 2 h prune) is
 *     NEVER re-alerted (nunca re-alertar lo ya alertado).
 *   - MARKER: every catch-up finding carries `catchup: true` (additive) →
 *     buildHealthAlertFrame renders the CATCH-UP bullet (frame propio).
 *   - Bug A parity: the `retiredHostIds` / `retiredMemberIds` sets are
 *     threaded in — a terminal member's legacy rows never re-alert (the live
 *     scan rules). PURE besides the reads; never throws (the readers degrade
 *     to [] like the live scanners). */
export function scanHealthCatchup(
  stateDir: string,
  nowMs: number,
  windowMs: number = HEALTH_CATCHUP_WINDOW_MS,
  retiredHostIds?: ReadonlySet<string>,
  retiredMemberIds?: ReadonlySet<string>
): HealthFinding[] {
  const findings: HealthFinding[] = []
  // (1) post-errors + the C9 archive: exactly the rows STRICTLY older than the
  // live window and within the bounded look-back.
  const oldPostErrors = [...readPostErrorsFile(stateDir), ...readPostErrorsArchiveFile(stateDir)]
    .filter((row) => nowMs - row.ts > HEALTH_ERROR_WINDOW_MS && nowMs - row.ts <= windowMs)
  const postErrors = retiredHostIds === undefined ? oldPostErrors : oldPostErrors.filter((row) => !retiredHostIds.has(row.postId))
  const byGroup = new Map<string, PostErrorEntry[]>()
  for (const row of postErrors) {
    const cls = postErrorClass(row.error)
    const groupKey = cls === undefined ? row.postId : `${row.postId}\u0000${cls}`
    const list = byGroup.get(groupKey) ?? []
    list.push(row)
    byGroup.set(groupKey, list)
  }
  for (const [groupKey, rows] of byGroup) {
    const split = groupKey.indexOf('\u0000')
    const postId = split === -1 ? groupKey : groupKey.slice(0, split)
    const cls = split === -1 ? undefined : groupKey.slice(split + 1)
    findings.push({
      kind: 'post-error',
      key: cls === undefined ? `post-error:${postId}` : `post-error:${postId}:${cls}`,
      postId,
      ts: rows.reduce((max, row) => Math.max(max, row.ts), 0),
      error: rows[0].error,
      count: rows.length,
      catchup: true,
      // fb-25 (b): the provenance of rows[0] rides the finding (additive, the
      // live-scan rule) so the CATCH-UP bullet shows the archived-session
      // provenance the same way.
      ...(typeof rows[0].sessionId === 'string' && rows[0].sessionId !== '' ? { sessionId: rows[0].sessionId } : {}),
      ...(typeof rows[0].turn === 'number' && Number.isFinite(rows[0].turn) ? { turn: rows[0].turn } : {})
    })
  }
  // (2) delivery-failed rows: the same window rule (the live scan's
  // whitelist filter — only 'failed' is ever an anomaly).
  const oldDeliveries = readDeliveryRowsFull(stateDir)
    .filter((row) => row.status === 'failed' && nowMs - row.ts > HEALTH_ERROR_WINDOW_MS && nowMs - row.ts <= windowMs)
  const deliveries = retiredMemberIds === undefined ? oldDeliveries : oldDeliveries.filter((row) => !retiredMemberIds.has(row.recipientId))
  const byMessage = new Map<string, DeliveryRow>()
  for (const row of deliveries) byMessage.set(row.messageId, row) // last-wins
  for (const [messageId, row] of byMessage) {
    findings.push({
      kind: 'delivery-failed',
      key: `delivery-failed:${messageId}`,
      messageId,
      ts: row.ts,
      count: 1,
      catchup: true
    })
  }
  return findings
}

/**
 * M1 — the pooled-key capacity watchdog (owner decision 2026-08-27; the
 * anti-hang hardening after the key-pooler incident). TWO new scans in the
 * system-health tick, both alerting the host BEFORE paralysis:
 *
 *   (a) `pooler-capacity`: READS the pooler's OWN `keyPooler-state.json`
 *       (join(DSH_HOME||cwd,'keyPooler-state.json'); in DEV
 *       /opt/dsh/.dsh-dev/keyPooler-state.json) — SOLO-LECTURA, the scan NEVER
 *       writes it. The snapshot is the pooler's truthful health: `updatedAt`,
 *       `keys{id,workspace,invalid,blockedUntil,cooldownUntil,
 *       lastUsage{status,percent,resetsAt},lastError,lastCheckedAt}`, and
 *       `lastRotation`. A key is USABLE with the SAME eligibility the pooler's
 *       `select()` uses (pool.ts:237-241): `!invalid && blockedUntil<=now &&
 *       cooldownUntil<=now`. Levels: warning (usable<=warningUsableKeys OR
 *       blocked>=blockedKeysInWindow OR a usable key's usage percent >=
 *       highPercent); critical (usable<=criticalUsableKeys OR the state file is
 *       STALE beyond stateStaleMs — the dead-man's switch — OR the last
 *       rotation was a 429-usage-limit rotation to NO key, to:null — the exact
 *       prelude of the 503 KeyPoolerExhausted).
 *
 *   (b) `qi-silence`: the guarantee over the worker-retire quality-inspect
 *       TRIGGER (A+B fixed the trigger; this WATCHDOG guarantees it). RETIREMENTS
 *       = the post-census DELTA of the catalog `posts` the tick already receives
 *       (posts with retired+provider==='worker'; posts.json has NO retiredAt →
 *       the watchdog keeps its OWN ledger `qi-silence-state.json`
 *       {postId → firstSeenRetiredMs} + the reserved census marker
 *       QI_SILENCE_CENSUS_KEY → baseline ts, the turn-errors-state pattern; the
 *       firstSeen MARKER is pruned only when the post leaves the retired
 *       catalog, never by age — the window bound applies at COUNT time, so a
 *       pruned entry can never re-count). M1.1 CENSUS PRIMING (the deployed
 *       false-positive incident 2026-08-27 19:26Z, 2 min post-deploy): the
 *       FIRST tick after a boot is a CENSUS — the already-retired posts the C2
 *       prune retains (~50) are PRIMED with the sentinel QI_SILENCE_PRIMED_MS
 *       (0) and NEVER count as window events (the pre-fix code stamped + counted
 *       them at the boot census ts with 0 directives → a false `qi-silence`
 *       alert). The window count is the post-census DELTA ONLY: (a) a post
 *       observed NOT-retired in an earlier tick and retired in the next, or
 *       (b) a post NEW to the catalog, already retired, whose FIRST observation
 *       is post-census (firstSeen > the census baseline). RE-observations of
 *       already-known / primed retired posts NEVER re-count or re-stamp (the
 *       ledger entry IS the retirement; the latent bug of the incident).
 *       DIRECTIVES = messages.jsonl records from='deepartments' → ['quality-head']
 *       whose text STARTS WITH the EXPORTED
 *       QUALITY_INSPECT_WORKER_RETIRED_PREFIX (dshd-quality — one literal, no
 *       drift). Finding when retirements-in-window >= the RATE-AWARE minimum
 *       (ceil(ln(0.05)/ln(1-p)): P(0 directives | p) <= 5%; p=0.25 → 11,
 *       p=1 → 1) AND directives-in-window == 0 — so a SINGLE silent retirement
 *       at p=0.25 (expected 75% of the time) never alerts, while a TRUE trigger
 *       outage (≥11 retirements, ZERO directives) does.
 * --------------------------------------------------------------------------- */

/** The default pooler state FILE NAME (the pooler writes
 * join(DSH_HOME||cwd, 'keyPooler-state.json'); the bundle derives the path). */
export const POOLER_STATE_FILE = 'keyPooler-state.json'

/** Resolve a positive-number safeguard knob shared by the M1 watchdogs: a
 * finite value > 0 → it; absent/invalid → the fallback (the staleLiveMinutes +
 * resolveSystemWaitMs pattern — an explicit knob always wins, a broken one
 * never throws). */
export function resolvePositiveKnob(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** M1-a code defaults (absent knobs → these). */
export const POOLER_CAPACITY_DEFAULT_WARNING_USABLE_KEYS = 2
export const POOLER_CAPACITY_DEFAULT_CRITICAL_USABLE_KEYS = 1
export const POOLER_CAPACITY_DEFAULT_BLOCKED_KEYS_IN_WINDOW = 3
export const POOLER_CAPACITY_DEFAULT_HIGH_PERCENT = 90
export const POOLER_CAPACITY_DEFAULT_STATE_STALE_MS = 10 * 60 * 1000

/** The pooler-capacity dedupe key LEVEL marker (the finding `key` is
 * `pooler-capacity:critical` | `pooler-capacity:warning` — DISTINCT keys so a
 * warning→critical escalation re-alerts instead of being swallowed by the
 * 30-min dedupe). */
export const POOLER_CAPACITY_KEY_CRITICAL = 'pooler-capacity:critical'
export const POOLER_CAPACITY_KEY_WARNING = 'pooler-capacity:warning'

/** M1 (b) code defaults. */
export const QI_SILENCE_DEFAULT_WINDOW_MS = 120 * 60 * 1000
/** The rate-aware false-positive tolerance: the default minimum n satisfies
 * P(0 directives | p)^n <= 0.05 (a ≤5% chance a healthy dice emits zero
 * directives over n retirements). */
export const QI_SILENCE_DEFAULT_FALSE_POSITIVE_TOLERANCE = 0.05
/** The worker-inspect dice fallback when `deps.qiDirectiveRate` is absent
 * (mirrors QUALITY_WORKER_INSPECT_DEFAULT_PROBABILITY). */
export const QI_SILENCE_DEFAULT_DIRECTIVE_RATE = 0.25
/** The qi-silence ledger file (a SEPARATE file — the shared health-alerts
 * ledger's defensive 2h prune would drop its entries; precedent
 * interrupt-state.json). */
export const QI_SILENCE_STATE_FILE = 'qi-silence-state.json'
/** The qi-silence dedupe key (one key — re-alerts only after the 30-min dedupe
 * window, and only while the silence condition STILL holds). */
export const QI_SILENCE_KEY = 'qi-silence'
/** M1.1 — the RESERVED census-marker ledger key (never a postId): its value is
 * the epoch-ms of the FIRST tick (the boot-census baseline). The ledger is
 * ARMING (census pending) while the key is absent and ARMED once present. A
 * legacy marker-less ledger (deployed pre-M1.1 — every entry stamped at the
 * boot census ts, the false-positive incident) is RE-CENSUSED on the first
 * post-fix tick: present retired posts are re-primed so the stale boot stamps
 * can never alert again. */
export const QI_SILENCE_CENSUS_KEY = '__qi-silence-census'
/** M1.1 — the PRIMED sentinel firstSeenRetiredMs: an entry stamped with 0 was
 * ALREADY retired when the watchdog FIRST ticked (the boot census baseline —
 * the ~50 posts the C2 prune retains). A primed entry is NEVER a window event
 * (now - 0 is beyond any window) and is never re-stamped; it lives until the
 * post leaves the retired catalog (the prune-by-catalog rule). */
export const QI_SILENCE_PRIMED_MS = 0

/** One key of the pooler snapshot — STRUCTURAL (only the fields the watchdog
 * reads, so the pooler's own type never hard-depends on this package). */
export interface PoolerKeyStateLike {
  id?: string
  workspace?: string
  invalid?: boolean
  /** Epoch-ms until which the key is blocked (a usage-limit 429 blocks the WHOLE
   * workspace). Absent/0 = not blocked. */
  blockedUntil?: number
  /** Epoch-ms until which the key is on a transient cooldown. Absent/0 = none. */
  cooldownUntil?: number
  /** The last upstream /usage result the pooler fetched (the leading indicator;
   * null when the pooler has no usage data). */
  lastUsage?: { status?: string; percent?: number; resetsAt?: string } | null
  lastError?: string | null
  lastCheckedAt?: number
  /** HARDENING-401 (fb-39, 2026-09-01) — the BILLING/credits class: the pooler
   * sets this when the key's last 401 was a billing/credits block (CreditsError
   * / Insufficient balance — the «todas-secas» class), NOT a plain auth 401.
   * Near-PERMANENT (a billing block does not reset with time like a quota
   * cooldown). Absent/undefined = not billing-blocked. The pooler owns the
   * write; this scan only reads it — the class lets the capacity gate pause
   * new dispatches BEFORE the pool paralyzes (the 08-31 outage lesson: all
   * jobs died 401 CreditsError with the state going stale). */
  billingBlocked?: boolean
}

/** The last rotation record of the pooler snapshot (a 429 usage-limit rotation
 * to NO key — `to: null` — is the prelude of the 503 KeyPoolerExhausted). */
export interface PoolerRotationLike {
  from?: string
  to?: string | null
  reason?: string
  at?: string
  resetsAt?: string
  message?: string
}

/** The pooler snapshot — STRUCTURAL mirror of dsh-key-pooler PoolSnapshot
 * (pool.ts:71-93). */
export interface PoolerSnapshotLike {
  /** ISO ts of the LAST health CHANGE the pooler persisted (the file is written
   * ONLY when health changed — proxy.ts:691 — so an old updatedAt means a quiet
   * grid, judged by the stateStaleMs dead-man's switch). */
  updatedAt?: string
  keys?: Record<string, PoolerKeyStateLike>
  lastRotation?: PoolerRotationLike | null
}

/** Read the pooler's `keyPooler-state.json` snapshot. Absent / unreadable /
 * malformed → undefined (never throws) — the scan is then a no-op. READ-ONLY:
 * this helper never writes the pooler's file. */
export function readPoolerStateFile(statePath: string): PoolerSnapshotLike | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed as PoolerSnapshotLike
  } catch {
    return undefined
  }
}

/** The resolved pooler-capacity knobs (code defaults when the config knob is
 * absent/invalid — the staleLiveMinutes fallback pattern). */
export interface PoolerCapacityKnobs {
  warningUsableKeys: number
  criticalUsableKeys: number
  blockedKeysInWindow: number
  highPercent: number
  stateStaleMs: number
}

/** M1-a — scan the pooler state file for capacity findings. ONE finding per
 * tick (a single dedupe key per level), priority critical > warning. The state
 * file is READS ONLY; an absent/unreadable file → [] (no-op). The CRITICAL
 * branches are the CERTAIN exhaustion signals ONLY — the three candidate
 * branches, and the one that is NOT critical:
 *  (1) the 429-rotation prelude — the last rotation was a 429 usage-limit to
 *      NO key (`lastRotation.to === null`, the pool is one request away from
 *      the 503 KeyPoolerExhausted) → CRITICAL;
 *  (2) usable keys ≤ `criticalUsableKeys` (the same eligibility the pooler's
 *      scheduler uses: !invalid && blockedUntil<=now && cooldownUntil<=now) →
 *      CRITICAL;
 *  (3) HARDENING-401 (fb-39, 2026-09-01) — the BILLING/credits class: EVERY
 *      configured key flagged `billingBlocked` (401 CreditsError / Insufficient
 *      balance — the «todas-secas» class; an isolated billing-flagged key in a
 *      pool that can still serve never pauses). Runs BEFORE the stale check
 *      because a billing block is near-PERMANENT (it does not age out like a
 *      quota cooldown) — a STALE snapshot that still carries the durable
 *      billing flag on every key is still a billing-blocked pool → CRITICAL
 *      even when the dead-man's-switch would otherwise call the state UNKNOWN
 *      (the 08-31 outage class: every key billed-out → the pooler stops writing
 *      → the snapshot went stale).
 *  (4) STALE state (`updatedAt` missing/unparseable or older than
 *      `stateStaleMs`) — NOT a critical branch: the pooler writes the file
 *      ONLY on health changes, so a quiet-but-healthy grid looks stale by
 *      design → stale = UNKNOWN, and unknown ≠ exhausted. A stale snapshot →
 *      return [] (NO finding) + a logger `warn` naming the age (absent logger
 *      dep → the warn is dropped). The dead-man's-switch intent is served by
 *      the CERTAIN branches (1)+(2), which detect the real exhaustion.
 * The WARNING branches (fresh state only): usable ≤ `warningUsableKeys`,
 * blocked/cooldown keys ≥ `blockedKeysInWindow`, a usable key at usage percent
 * ≥ `highPercent` (the x-ratelimit leading indicator). */
export function scanPoolerCapacity(statePath: string, nowMs: number, knobs: PoolerCapacityKnobs, logger?: { warn(message: string): void }): HealthFinding[] {
  const state = readPoolerStateFile(statePath)
  if (state === undefined) return []
  const keys = Object.values(state.keys ?? {})
  const totalCount = keys.length
  // HARDENING-401 (fb-39, 2026-09-01) — the BILLING/credits class is
  // near-PERMANENT: a billing block (401 CreditsError / Insufficient balance)
  // does NOT reset with time like a quota cooldown, and the pooler clears the
  // flag ONLY after a real successful probe. This branch runs BEFORE the stale
  // early-return on purpose — the 08-31 outage class: every key billed-out →
  // the pooler stops writing (writes only on health CHANGES) → the snapshot
  // goes STALE, but the durable billing flag is STILL true. A stale snapshot
  // that carries `billingBlocked` is still a billing-blocked pool (the flag
  // does not age out), so the capacity gate must see the CRÍTICO class even
  // when the dead-man's-switch would otherwise call the state UNKNOWN. The
  // branch fires ONLY when EVERY configured key is billing-blocked (the
  // mission's «todas markadas billing/limit-blocked» definition — an isolated
  // billing-flagged key in a pool that can still serve never pauses).
  const billingBlockedKeys = keys.filter((k) => k.billingBlocked === true)
  if (billingBlockedKeys.length > 0 && billingBlockedKeys.length === totalCount) {
    return [{
      kind: 'pooler-capacity',
      key: POOLER_CAPACITY_KEY_CRITICAL,
      ts: nowMs,
      count: keys.filter((k) => !k.invalid && (Number(k.blockedUntil) || 0) <= nowMs && (Number(k.cooldownUntil) || 0) <= nowMs).length,
      error: `billing/credits block on ${billingBlockedKeys.length}/${totalCount} keys (401 CreditsError class) — pausa de nuevos despachos; resume al recuperar`
    }]
  }
  const updatedMs = state.updatedAt !== undefined ? Date.parse(state.updatedAt) : Number.NaN
  const stale = !Number.isFinite(updatedMs) || nowMs - updatedMs > knobs.stateStaleMs
  if (stale) {
    const ageMin = Number.isFinite(updatedMs) ? Math.round((nowMs - updatedMs) / 60000) : Number.NaN
    // M1 — stale = UNKNOWN, never a finding: a silent pooler on a quiet-but-
    // healthy grid is the EXPECTED case (the pooler writes the file ONLY on
    // health changes). Warn (naming the age) and return [] — the real
    // dead-man's-switch is the CERTAIN exhaustion branches below (a 429
    // rotation to:null, usable ≤ critical).
    logger?.warn(Number.isFinite(ageMin)
      ? `pooler state unknown/stale (age ${ageMin} min) — no capacity finding`
      : `pooler state unknown/stale (unparseable updatedAt) — no capacity finding`)
    return []
  }
  const usable = keys.filter((k) => !k.invalid && (Number(k.blockedUntil) || 0) <= nowMs && (Number(k.cooldownUntil) || 0) <= nowMs)
  const usableCount = usable.length
  const blockedCount = keys.filter((k) => (Number(k.blockedUntil) || 0) > nowMs || (Number(k.cooldownUntil) || 0) > nowMs).length
  // The 429-usage-limit rotation to NO key (`lastRotation.to === null` — the
  // pool rotated a key OUT and NO other key was eligible) — the pool is one
  // request away from the 503 KeyPoolerExhausted. Critical (owner M1).
  const rotation = state.lastRotation ?? undefined
  const rotation429ToNull = rotation !== undefined && rotation.to === null && (rotation.reason ?? '').includes('429')
  if (rotation429ToNull) {
    return [{
      kind: 'pooler-capacity',
      key: POOLER_CAPACITY_KEY_CRITICAL,
      ts: nowMs,
      count: usableCount,
      error: `last rotation ${rotation?.reason ?? '429 usage-limit'} → no key (to:null) — 503 prelude`
    }]
  }
  if (usableCount <= knobs.criticalUsableKeys) {
    return [{
      kind: 'pooler-capacity',
      key: POOLER_CAPACITY_KEY_CRITICAL,
      ts: nowMs,
      count: usableCount,
      error: `${usableCount} usable / ${totalCount} keys (≤ ${knobs.criticalUsableKeys} critical)`
    }]
  }
  if (usableCount <= knobs.warningUsableKeys) {
    return [{
      kind: 'pooler-capacity',
      key: POOLER_CAPACITY_KEY_WARNING,
      ts: nowMs,
      count: usableCount,
      error: `${usableCount} usable / ${totalCount} keys (≤ ${knobs.warningUsableKeys} warning)`
    }]
  }
  if (blockedCount >= knobs.blockedKeysInWindow) {
    return [{
      kind: 'pooler-capacity',
      key: POOLER_CAPACITY_KEY_WARNING,
      ts: nowMs,
      count: usableCount,
      error: `${blockedCount} blocked / ${totalCount} keys (≥ ${knobs.blockedKeysInWindow})`
    }]
  }
  const hot = usable.find((k) => typeof k.lastUsage?.percent === 'number' && (k.lastUsage?.percent ?? 0) >= knobs.highPercent)
  if (hot !== undefined) {
    return [{
      kind: 'pooler-capacity',
      key: POOLER_CAPACITY_KEY_WARNING,
      ts: nowMs,
      count: usableCount,
      error: `usable key ${hot.id} usage percent ${hot.lastUsage?.percent}% ≥ ${knobs.highPercent}% (rate-limit headroom low)`
    }]
  }
  return []
}

/** DISPATCH-HARDENING (QH — the «429-primer-call» class; 2026-08-28) — the
 * POOLER-CAPACITY DISPATCH PRE-CHECK (the BEFORE half; the AFTER half is the
 * b5-ghost live-post guard). The worker/head dispatch seams (runJobForDepartment
 * / spawnWorkerForDepartment / dept_post_create / the materializePost resume
 * seam — the SAME 3+1 seams as the fb-9 reasoning-content pre-flight) reject
 * the dispatch LOUDLY and EARLY when the pooler snapshot certifies that NO
 * workspace can serve the spawn's FIRST call — the class where a freshly
 * spawned worker's very first LLM turn would 429/503 (burning the
 * materialization). READS the pooler's OWN `keyPooler-state.json` SOLO-LECTURA
 * (the pooler owns every write; this check never writes it) — the same reader
 * the M1 watchdog uses. CONSERVATIVE — the pre-check is a warning, never a
 * blocker: absent / unreadable / STALE state → passthrough (unknown ≠
 * exhausted — a quiet-but-healthy grid looks stale by design, the M1 rule);
 * only the CERTAIN exhaustion branches block (zero usable keys, EVERY usable
 * key at/above the highPercent quota — the «AGOTADOS (percent>=umbral)» pooler
 * criterion — or the last rotation was a 429 usage-limit to NO key, the 503
 * prelude). An explicit `health.poolerDispatchEnabled: false` knob restores
 * the pre-check-less dispatch (the M1 `poolerCapacityEnabled` pattern). */
export interface PoolerDispatchBlockResult {
  /** The CLEAR EARLY error for the dispatch seam — names the at-quota
   * workspaces + the «dispatch delayed; retry when a fresh key resolves»
   * guidance. */
  reason: string
}

/** Resolve the pooler-capacity dispatch pre-check for ONE dispatch: read the
 * pooler snapshot and return a block verdict ONLY on the CERTAIN exhaustion
 * branches, or `undefined` (passthrough — the dispatch proceeds) otherwise.
 * Never throws. `knobs.highPercent` (default 90) is the at-quota usage
 * threshold; `knobs.stateStaleMs` (default 10 min = the M1 default) is the
 * freshness window — STALE state is UNKNOWN → passthrough + a logger warn
 * naming the age (the M1 dead-man's-switch rule: the pooler writes the file
 * only on health changes, so a quiet grid looks stale by design; the CERTAIN
 * branches below never rely on freshness). */
export function resolvePoolerDispatchBlock(
  statePath: string,
  nowMs: number,
  knobs: { highPercent: number; stateStaleMs: number },
  logger?: { warn(message: string): void }
): PoolerDispatchBlockResult | undefined {
  const state = readPoolerStateFile(statePath)
  if (state === undefined) return undefined
  const updatedMs = state.updatedAt !== undefined ? Date.parse(state.updatedAt) : Number.NaN
  if (!Number.isFinite(updatedMs) || nowMs - updatedMs > knobs.stateStaleMs) {
    const ageMin = Number.isFinite(updatedMs) ? Math.round((nowMs - updatedMs) / 60000) : Number.NaN
    logger?.warn(Number.isFinite(ageMin)
      ? `pooler state unknown/stale (age ${ageMin} min) — dispatch pre-check passes conservatively (unknown ≠ exhausted)`
      : `pooler state unknown/stale (unparseable updatedAt) — dispatch pre-check passes conservatively (unknown ≠ exhausted)`)
    return undefined
  }
  const keys = Object.values(state.keys ?? {})
  const usable = keys.filter((k) => !k.invalid && (Number(k.blockedUntil) || 0) <= nowMs && (Number(k.cooldownUntil) || 0) <= nowMs)
  // The workspace(s) the at-quota keys belong to (the pooler's `workspace`
  // field, e.g. wrk_…/ws6; a key without one falls back to its id).
  const workspaceNames = (list: PoolerKeyStateLike[]): Set<string> =>
    new Set(list.map((k) => String(k.workspace ?? k.id ?? '').trim()).filter((w) => w !== ''))
  const atQuotaReason = (blocked: PoolerKeyStateLike[], total: number, cause: string): string => {
    const names = workspaceNames(blocked)
    const head = [...names].slice(0, 3).join(',')
    const ws = names.size > 3 ? `${head},… (${names.size} at quota)` : head
    return `pool: workspace${names.size === 1 ? '' : 's'} ${ws === '' ? '(all)' : ws} at quota (${cause}; ${blocked.length}/${total} keys) — dispatch delayed; retry when a fresh key resolves`
  }
  // (1) ZERO usable keys — every workspace is blocked/cooldown/invalid; the
  // FIRST call of the spawn would find NO usable key (the 503
  // KeyPoolerExhausted / 429-primer-call class). CERTAIN → block.
  if (usable.length === 0) {
    return { reason: atQuotaReason(keys, keys.length, '0 usable keys — all blocked/cooldown/invalid') }
  }
  // (2) EVERY usable key is at/above the highPercent usage quota (the
  // x-ratelimit leading indicator — the pooler's own highPercent criterion).
  // The pool can still serve, but every workspace is HOT: the first call may
  // 429 on the rate-limit headroom. CERTAIN-enough → block.
  const hot = usable.filter((k) => typeof k.lastUsage?.percent === 'number' && (k.lastUsage?.percent ?? 0) >= knobs.highPercent)
  if (hot.length > 0 && hot.length === usable.length) {
    return { reason: atQuotaReason(hot, keys.length, `usage percent >= ${knobs.highPercent}% on every usable key`) }
  }
  // (3) The 429-usage-limit rotation to NO key (the M1 CRITICAL branch — the
  // pool rotated a key OUT and NO other key was eligible): the pool is one
  // request away from the 503 KeyPoolerExhausted — blocking the dispatch NOW
  // avoids the primer-call 429/503 (the M1 "alert BEFORE paralysis" intent,
  // applied to the dispatch). CERTAIN → block.
  const rotation = state.lastRotation ?? undefined
  if (rotation !== undefined && rotation.to === null && (rotation.reason ?? '').includes('429')) {
    return { reason: `pool: last rotation 429 usage-limit → no key (to:null; 503 prelude) — dispatch delayed; retry when a fresh key resolves (${usable.length}/${keys.length} usable)` }
  }
  return undefined
}

/** The qi-silence ledger: `postId → firstSeenRetiredMs` — when the watchdog
 * FIRST observed the post as retired+worker in the catalog (posts.json has no
 * retiredAt, so the ledger IS the retirement timestamp; the turn-errors-state
 * pattern). M1.1 CENSUS PRIMING: the ledger ALSO holds ONE reserved key
 * QI_SILENCE_CENSUS_KEY → the boot-census baseline ts (armed once the census
 * ran); an entry stamped with the sentinel QI_SILENCE_PRIMED_MS (0) was PRIMED
 * by that census (the post was already retired before the watchdog existed =
 * the baseline, NOT a window event). */
export type QiSilenceState = Record<string, number>

/** Read `<stateDir>/qi-silence-state.json` → `{ [postId]: firstSeenRetiredMs }`.
 * Absent / unreadable / malformed → {} (never throws). */
export function readQiSilenceState(stateDir: string): QiSilenceState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, QI_SILENCE_STATE_FILE), 'utf8')) as Record<string, unknown>
    const out: QiSilenceState = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/qi-silence-state.json` (mkdir -p the dir, then the file). */
export async function writeQiSilenceState(stateDir: string, state: QiSilenceState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, QI_SILENCE_STATE_FILE)), { recursive: true })
  await writeFile(path.join(stateDir, QI_SILENCE_STATE_FILE), JSON.stringify(state), 'utf8')
}

/** The RATE-AWARE minimum: the smallest n retirements with which a ZERO-directive
 * window is suspicious — P(0 directives | n, p) = (1-p)^n <= `tolerance`
 * (default 0.05) → n = ceil(ln(tolerance)/ln(1-p)). p=0.25 → 11 (a single silent
 * retirement is the EXPECTED 75% case — the dice — and never alerts); p=1 → 1
 * (a 100%-inspect deployment must emit a directive per retirement, so ANY silent
 * retirement is a symptom); p<=0 → Infinity (by-design zero-inspection → silence
 * is expected, the finding can never fire). The `qiSilenceMinRetiresInWindow`
 * knob overrides this formula. PURE. */
export function qiSilenceMinRetiresForRate(rate: number, tolerance: number = QI_SILENCE_DEFAULT_FALSE_POSITIVE_TOLERANCE): number {
  if (!Number.isFinite(rate) || rate <= 0) return Number.POSITIVE_INFINITY
  if (rate >= 1) return 1
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= 1) return Number.POSITIVE_INFINITY
  return Math.max(1, Math.ceil(Math.log(tolerance) / Math.log(1 - rate)))
}

/** Count the QUALITY-INSPECT WORKER-RETIRED directives inside the window:
 * messages.jsonl records `from==='deepartments'` → includes 'quality-head'
 * whose text STARTS WITH the exported dshd-quality prefix (the SINGLE literal —
 * no drift) and whose `ts` is within `windowMs`. A missing/unreadable/malformed
 * messages file → 0 (never throws — the scan degrades to "no directives", the
 * conservative direction for the guarantee). */
export function readQiDirectiveCount(stateDir: string, windowMs: number, nowMs: number): number {
  try {
    const records = parseMessageRecords(readFileSync(resolveMessagesPath(stateDir), 'utf8'))
    return records.filter(
      (r) => r.from === 'deepartments' && r.to.includes('quality-head') && r.text.startsWith(QUALITY_INSPECT_WORKER_RETIRED_PREFIX) && nowMs - r.ts <= windowMs
    ).length
  } catch {
    return 0
  }
}

/** The qi-silence scan inputs: the catalog posts (already materialized by the
 * tick — retired+provider workers), the stateDir (messages.jsonl), the clock,
 * the window + the RESOLVED minimum (rate-aware or knob) + the dice p (for the
 * finding text), and the current ledger. */
export interface QiSilenceScanInput {
  posts: readonly PostActivityInput[]
  stateDir: string
  nowMs: number
  windowMs: number
  /** The RESOLVED minimum (knob override `qiSilenceMinRetiresInWindow`, else
   * `qiSilenceMinRetiresForRate(rate)`); Number.POSITIVE_INFINITY never fires. */
  minRetires: number
  /** The shared worker-inspect dice p (deps.qiDirectiveRate fallback 0.25) —
   * carried into the finding text so the alert states the bound it enforced. */
  rate: number
  /** The CURRENT ledger (read by the tick; mutated → the returned next ledger). */
  ledger: QiSilenceState
}

/** The qi-silence scan result: the findings (≤1 per tick, key `qi-silence`),
 * the NEXT ledger, and whether the ledger CHANGED (the tick persists only then —
 * the turn-errors pattern: 1914-1935). */
export interface QiSilenceScanResult {
  findings: HealthFinding[]
  ledger: QiSilenceState
  changed: boolean
}

/** M1-b — scan the qi-silence condition: retirements in the window (the
 * post-census DELTA of retired+worker posts) vs directives in the window
 * (messages.jsonl prefix records). Finding: retirements >= minRetires AND zero
 * directives — the aggregate guarantee (never a per-retirement alarm, so the
 * 25% dice's normal silence does not scream). LEDGER SEMANTICS (M1.1 — the
 * deployed false-positive incident): the entry is the post's FIRST-SEEN marker
 * and is pruned ONLY when the post leaves the retired+worker catalog (retention
 * dropped it). It is NEVER time-pruned while the post stays in the catalog —
 * the WINDOW bound applies at COUNT time (`now - firstSeen <= windowMs`), never
 * at storage time: deleting an aged marker and re-stamping the SAME still-
 * retired post on the next tick would re-count an OLD retirement as fresh
 * (permanent false alerts — the very guarantee this watchdog must not
 * fabricate). CENSUS PRIMING (M1.1): a ledger WITHOUT the QI_SILENCE_CENSUS_KEY
 * marker means the watchdog has never ticked — the CURRENT tick is the BOOT
 * CENSUS: every present retired+worker post was retired BEFORE the watchdog
 * existed (the ~50 the C2 prune retains), so each is PRIMED with the sentinel
 * QI_SILENCE_PRIMED_MS (0) and NEVER counts as a window event (the real 19:26Z
 * incident: 50 boot-retired posts stamped + counted with 0 directives → false
 * `qi-silence` alert 2 min post-deploy). A legacy marker-less ledger (the
 * pre-fix boot stamps) is re-primed → healed. Only the DELTA observed AFTER the
 * census counts: (a) a post observed NOT-retired in an earlier tick and retired
 * in the next, or (b) a post NEW to the catalog, already retired, whose FIRST
 * observation is post-census — both stamp firstSeenRetiredMs = nowMs and count
 * while inside the window. RE-observations of an already-known / primed retired
 * post NEVER re-count and NEVER re-stamp (the ledger entry IS the retirement —
 * the latent re-count bug of the incident). NEVER throws. */
export function scanQiSilence(input: QiSilenceScanInput): QiSilenceScanResult {
  const retiredWorkers = input.posts.filter((p) => p.provider === 'worker' && p.retired === true)
  const retiredPostIds = new Set(retiredWorkers.map((p) => p.postId))
  const ledger = { ...input.ledger }
  let changed = false
  let inWindow = 0
  const censusMs = ledger[QI_SILENCE_CENSUS_KEY]
  if (censusMs === undefined) {
    // THE BOOT CENSUS (the FIRST tick — no marker in the ledger): the already-
    // retired workers the catalog retains are the BASELINE, not events. Prime
    // each present retired+worker post with the sentinel 0 — never counts, never
    // re-stamped. A legacy marker-less ledger (the deployed pre-M1.1 boot stamps)
    // is re-primed here → healed (the stale stamps can never alert again).
    for (const post of retiredWorkers) {
      if (ledger[post.postId] !== QI_SILENCE_PRIMED_MS) {
        ledger[post.postId] = QI_SILENCE_PRIMED_MS
        changed = true
      }
    }
    ledger[QI_SILENCE_CENSUS_KEY] = input.nowMs
    changed = true
  } else {
    // Census done → the ledger is ARMED: every NEW retired+worker observation is
    // a real post-census retirement (a transition or a catalog arrival) →
    // stamped at its observation ts and counted while inside the window. A
    // PRIMED entry (0) NEVER counts (now - 0 is beyond any window) — the census
    // is not a retirement event and re-observations never re-count.
    for (const post of retiredWorkers) {
      const firstSeen = ledger[post.postId]
      if (firstSeen === undefined) {
        ledger[post.postId] = input.nowMs
        changed = true
        inWindow += 1
      } else if (firstSeen !== QI_SILENCE_PRIMED_MS && input.nowMs - firstSeen <= input.windowMs) {
        inWindow += 1
      }
    }
  }
  for (const [postId] of Object.entries(ledger)) {
    if (postId === QI_SILENCE_CENSUS_KEY) continue
    if (!retiredPostIds.has(postId)) {
      delete ledger[postId]
      changed = true
    }
  }
  const directives = readQiDirectiveCount(input.stateDir, input.windowMs, input.nowMs)
  const findings: HealthFinding[] = []
  if (inWindow > 0 && inWindow >= input.minRetires && directives === 0) {
    const windowMinutes = Math.round(input.windowMs / 60000)
    findings.push({
      kind: 'qi-silence',
      key: QI_SILENCE_KEY,
      ts: input.nowMs,
      count: inWindow,
      error: `${inWindow} worker retire(s) in ${windowMinutes} min with zero quality-inspect directive(s) (workerInspectProbability=${input.rate}, min retires ${input.minRetires})`
    })
  }
  return { findings, ledger, changed }
}

// ---------------------------------------------------------------------------
// M4 — the system-idle watchdog (owner request directa 2026-08-27): GLOBAL
// quiet. EVERY existing detector is per-message / per-post (W8-d system-wait
// covers a host-sent expectation to ONE post; W8-c stalled covers ONE post's
// staleness; qi-silence covers ONE retired-worker→directive guarantee) — NONE
// of them can see "the WHOLE catalog has been running ZERO agents for N minutes
// while some post STILL has pending work". That is the M4 gap: a stopped
// dispatch pipeline (a head/worker that terminated without re-dispatching, an
// interrupted turn nobody resumed, a message that never materialized its
// recipient) leaves the system QUIET with work pending and NO per-message
// window open — W8-d returns 0 finds, nobody alerts. The scan ALERTS iff ALL
// three hold:
//   1. [zero running] — no non-retired post reports `running:true` (the same
//      per-post signal the stale-live watchdog uses — Bug B: a mid-turn is
//      healthy progress, NEVER quiet) AND `deps.hostRunning !== true` (the
//      host's mid-turn signal, resolved by the bundle with the buildCatalogRows
//      expression);
//   2. [pending work] — some non-retired post has `pendingCount > 0`
//      (buildPostSnapshot over the ALREADY-materialized deps.posts — zero new
//      I/O) OR an INTERRUPTED turn (scanInterruptedTurn over deps.posts[].events
//      — the W8-h 'stopped without re-dispatch' class). Quality-inspect
//      directives fall in pendingCount (quality-head is a post with an inbox);
//      agenda/calendar is EXCLUDED (fired:false is transient — the scheduler
//      resolves it in <30 s and must never silence or trigger an alarm);
//   3. [quiet >= idleWindowMs] — since `firstQuietTs` (the LEDGER — kept in the
//      SEPARATE system-idle-state.json: the shared health-alerts ledger's
//      defensive 2h prune would drop a long first-quiet (the qi-silence-state
//      precedent)).
// Without pending work → expected quiet → WARN-only (logger, no finding, no
// dedupe). The ALERT rides the existing findings→dedupe→notifyHost flow (key
// `system-idle` — re-alerts every HEALTH_DEDUPE_WINDOW_MS while the condition
// persists, never a one-shot). The ALERT NEVER goes through deliverDaemonNotice
// (the B4 gate excludes health ALERTs — the daemon wiring delivers DIRECT).
// The host (Asistente) IS the alert channel: there is no direct owner channel
// in the harness — the host surfaces the ALERT to the owner at its next wake.
// ---------------------------------------------------------------------------

/** M4 — the default global-quiet window (15 min — shorter than the 30-min
 * per-message system-wait threshold: global quiet is graver than one
 * per-message wait, and 15 min sits well above the daemon interval + typical
 * turn cycles without waiting half an hour to learn of a paralysis). */
export const SYSTEM_IDLE_DEFAULT_WINDOW_MS = 900000
/** The system-idle ledger file — a SEPARATE file (the shared health-alerts
 * ledger's defensive 2h prune would drop a long firstQuietTs; precedent
 * qi-silence-state.json / interrupt-state.json). */
export const SYSTEM_IDLE_STATE_FILE = 'system-idle-state.json'
/** The system-idle dedupe key (ONE key in the shared health-alerts ledger —
 * re-alerts only after the 30-min dedupe window and only while the quiet-with-
 * pending condition STILL holds — the qi-silence cadence precedent). */
export const SYSTEM_IDLE_KEY = 'system-idle'

/** The system-idle ledger: `firstQuietTs` = the ts (ms epoch) of the FIRST tick
 * that observed the catalog with ZERO agents running. The quiet duration is
 * `nowMs - firstQuietTs`; the entry is REPLACED on the next tick where ANY
 * agent runs (the quiet epoch is broken → the entry is deleted, the window
 * restarts when quiet returns). Persisted only when it changes (the
 * turn-errors pattern). */
export interface SystemIdleState {
  firstQuietTs?: number
}

/** Read `<stateDir>/system-idle-state.json` → `{ firstQuietTs? }`. Absent /
 * unreadable / malformed → {} (never throws). */
export function readSystemIdleState(stateDir: string): SystemIdleState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, SYSTEM_IDLE_STATE_FILE), 'utf8')) as Record<string, unknown>
    const out: SystemIdleState = {}
    if (typeof parsed.firstQuietTs === 'number' && Number.isFinite(parsed.firstQuietTs)) out.firstQuietTs = parsed.firstQuietTs
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/system-idle-state.json` (mkdir -p the dir, then the file). */
export async function writeSystemIdleState(stateDir: string, state: SystemIdleState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, SYSTEM_IDLE_STATE_FILE)), { recursive: true })
  await writeFile(path.join(stateDir, SYSTEM_IDLE_STATE_FILE), JSON.stringify(state), 'utf8')
}

/** The system-idle scan inputs: the catalog posts (ALREADY materialized by the
 * tick — zero new I/O), the host's running signal, the clock, the resolved
 * window (knob `idleWindowMs` or the 15-min code default) and the current
 * ledger. */
export interface SystemIdleScanInput {
  posts: readonly PostActivityInput[]
  /** The host's live running signal (true/false — the tick only RUNS the scan
   * when the bundle resolved it; absent here is treated as not-running by the
   * pure scan — see the deps contract for the tick-level no-op gate). */
  hostRunning?: boolean
  nowMs: number
  idleWindowMs: number
  /** The CURRENT ledger (read by the tick; mutated → the returned next ledger). */
  ledger: SystemIdleState
}

/** The system-idle scan result: the findings (≤1 per tick, key `system-idle`),
 * the NEXT ledger, whether the ledger CHANGED (the tick persists only then) and
 * the warn-only flag (quiet >= window with NO pending work — expected quiet: no
 * finding, the tick logs a warn). */
export interface SystemIdleScanResult {
  findings: HealthFinding[]
  ledger: SystemIdleState
  changed: boolean
  /** True when the quiet window COMPLETED (>= idleWindowMs) with ZERO pending
   * work — expected quiet → the tick warns (logger) and emits no finding. */
  quietWithoutPending: boolean
}

/** M4 — scan the GLOBAL-quiet condition (PURE, NEVER throws). Running = any
 * non-retired post with `running:true` OR `hostRunning === true` (the Bug B
 * rule: a mid-turn is healthy progress, never quiet). While ANY agent runs the
 * quiet epoch is BROKEN (the ledger's firstQuietTs is deleted — the window
 * restarts when quiet returns). While NOTHING runs: (a) the first quiet tick
 * stamps firstQuietTs = nowMs; (b) once `nowMs - firstQuietTs >= idleWindowMs`
 * the pending census decides: pending work (a post with pendingCount > 0 or an
 * interrupted turn — scanInterruptedTurn over its events) → the `system-idle`
 * finding (key SYSTEM_IDLE_KEY — the shared dedupe gives the 30-min re-alert
 * cadence while the condition persists); NO pending work → quietWithoutPending
 * (the tick warns, no finding). Retired/sleeping posts are excluded from BOTH
 * running and pending (terminal / drains at its next wake — the stalled/wait
 * criterion). */
export function scanSystemIdle(input: SystemIdleScanInput): SystemIdleScanResult {
  const ledger = { ...input.ledger }
  let changed = false
  const anyRunning = input.hostRunning === true || input.posts.some((p) => p.retired !== true && p.running === true)
  if (anyRunning) {
    if (ledger.firstQuietTs !== undefined) {
      delete ledger.firstQuietTs
      changed = true
    }
    return { findings: [], ledger, changed, quietWithoutPending: false }
  }
  // Quiet epoch: stamp the first quiet tick, then measure the quiet duration.
  const firstQuietTs = ledger.firstQuietTs ?? input.nowMs
  if (ledger.firstQuietTs === undefined) {
    ledger.firstQuietTs = input.nowMs
    changed = true
  }
  const quietMs = input.nowMs - firstQuietTs
  if (quietMs < input.idleWindowMs) {
    return { findings: [], ledger, changed, quietWithoutPending: false }
  }
  // The window COMPLETED → the pending census decides finding vs warn-only.
  // Pending = a non-retired post with pendingCount > 0 (buildPostSnapshot — the
  // same no-I/O primitive the stalled/wait scans use) OR an INTERRUPTED turn
  // (W8-h 'stopped without re-dispatch' — the class no per-message window
  // covers). Quality-inspect directives fall in pendingCount (quality-head is a
  // post with an inbox); agenda/calendar is NOT a pending signal (transient).
  const pendingPosts: { postId: string; pendingCount: number }[] = []
  for (const post of input.posts) {
    if (post.retired === true) continue
    const snap = buildPostSnapshot(post)
    const interrupted = scanInterruptedTurn(post.events ?? [], '', post.postId) !== undefined
    if (snap.pendingCount > 0 || interrupted) {
      pendingPosts.push({ postId: post.postId, pendingCount: snap.pendingCount + (interrupted ? 1 : 0) })
    }
  }
  if (pendingPosts.length === 0) {
    return { findings: [], ledger, changed, quietWithoutPending: true }
  }
  const minutes = Math.round(quietMs / 60000)
  const findings: HealthFinding[] = [{
    kind: 'system-idle',
    key: SYSTEM_IDLE_KEY,
    ts: input.nowMs,
    count: pendingPosts.length,
    error: `${pendingPosts.length} pendiente(s) sin agente running durante ${input.idleWindowMs} ms — posible espera que nunca llegó (idle since ${firstQuietTs}, ${minutes} min)`
  }]
  return { findings, ledger, changed, quietWithoutPending: false }
}

// M-A — the context-threshold watchdog (owner request directa 2026-08-28,
// mission M-A MONITOR de contexto — the 50% trigger): a post OR the host uses
// MORE than `contextThreshold` (default 0.5) of its session context window →
// a `context-threshold` finding + host ALERT through the EXISTING
// findings→dedupe→notifyHost flow. The percent comes from the token-meter's
// `contextPressure` projection (contextWindow / pressureTokens /
// surfaceTokens / sampledSurfaceTokens), read by the bundle live in-process
// via `ctx.sessionProjections.snapshot(session).values.contextPressure` (the
// eager-driven, zero-I/O WIRE VIEW — the version-agnostic common surface of
// dsh-session-projection) and passed as the structural dep
// `deps.sessionContexts` (the package stays MODO LIB, no harness import).
// DEDUPE BY BAND (mission decision — no ledger of its own): the finding key
// is `context-threshold:<agentId>:b<floor(pct*10)>`, so the SHARED
// health-alerts ledger gives exactly the wanted cadence —
//   * a BAND CROSSING (52% → 61%) is a NEW key → an IMMEDIATE re-alert (the
//     mission's «re-alerta cuando cruza cada 10% más») even inside the 30-min
//     window of the previous band;
//   * a PERSISTENT band re-alerts every HEALTH_DEDUPE_WINDOW_MS (30 min) while
//     the condition still holds (the qi-silence/M4 «nunca one-shot» precedent);
//   * the shared 2h defensive prune is safe: band keys are per-agent bands,
//     a ≥2h-old key is already immune to the 30-min window.
// KINDS/KEYS DISJOINT from M4/system-idle and M1/pooler-capacity/qi-silence —
// the same tick composes all of them (system-idle says «nadie corre»;
// context-threshold says «alguien se está quedando sin contexto»). The scan
// NEVER reads settings.yaml (`contextWindow` is carried per-request by the
// projection) and NEVER fabricates a false positive: a row WITHOUT a resolved
// `contextWindow` (a session that never emitted a request/context — inactive)
// is SKIPPED (0% safe). `deps.sessionContexts` ABSENT → the tick no-ops the
// whole scan (the hostRunning/poolerStatePath-absent pattern).
// ---------------------------------------------------------------------------

/** M-A — the default context threshold: the 50% window-usage trigger. */
export const CONTEXT_THRESHOLD_DEFAULT = 0.5
/** M-A — the default scan cadence (per-minute — the WAIT per-minute gate
 * pattern); a sub-minute daemon tick re-fires inside the same bucket and skips
 * the scan. */
export const CONTEXT_THRESHOLD_DEFAULT_POLL_MS = 60_000

/** M-A — ONE session-context input row: the token-meter `contextPressure`
 * projection numbers for one agent (a post or the host). All numeric fields
 * are OPTIONAL — a row with a missing/invalid `contextWindow` is skipped by
 * the scan (never a false positive), a row with no numbers at all is a no-op. */
export interface SessionContextInput {
  /** The catalog postId (a post row). EXACTLY ONE of postId/hostId is set. */
  postId?: string
  /** The hostId (the live host's OWN row — no postId; the M4
   * host-not-a-pseudo-post rule). */
  hostId?: string
  /** The session contextWindow (the denominator, carried by the projection
   * from the last request/context — never read from settings.yaml here). */
  contextWindow?: number
  /** The provider pressure tokens (the numerator base). */
  pressureTokens?: number
  /** The surface tokens (added to the numerator). */
  surfaceTokens?: number
  /** The sampled surface tokens (subtracted from the numerator). */
  sampledSurfaceTokens?: number
  /** The token-meter WIRE-VIEW projected numerator
   * (`max(0, pressureTokens + surfaceTokens − sampledSurfaceTokens)`): the
   * bundle reads the version-agnostic `snapshot()` wire view, which already
   * publishes this. Absent → the scan derives it from the raw fields (a
   * raw-state wiring fallback). */
  projectedTokens?: number
}

/** M-A — the context-threshold scan inputs. */
export interface ContextThresholdScanInput {
  /** The per-agent context rows (ALREADY materialized by the tick — zero new
   * I/O). */
  rows: readonly SessionContextInput[]
  /** The resolved threshold fraction (knob `contextThreshold` or the 0.5 code
   * default). */
  threshold: number
  /** The clock (ms epoch) — stamped into the finding ts. */
  nowMs: number
}

/** M-A — build the per-BAND dedupe key: `context-threshold:<agentId>:b<band>`
 * (band = floor(pct*10): 52% → b5, 61% → b6). A band crossing is a NEW key →
 * an immediate re-alert; a persistent band re-alerts at the shared 30-min
 * cadence — the mission's dedupe-by-band decision, no ledger of its own. */
export function contextThresholdKey(agentId: string, band: number): string {
  return `context-threshold:${agentId}:b${band}`
}

/** M-A — scan the context-pressure threshold (PURE, NEVER throws). For every
 * row with a viable `contextWindow`: project the used tokens — the wire-view
 * `projectedTokens` when present (the bundle's snapshot wiring already
 * publishes it), else `max(0, pressureTokens + surfaceTokens −
 * sampledSurfaceTokens)` when `pressureTokens` is present (the raw-state
 * formula), else the surface-only heuristic fallback (a pre-first-request
 * session — conservative, never over-counts) — and alert when
 * `pct = projected / window` EXCEEDS `input.threshold`. Each finding carries
 * the per-(agent,band) dedupe key and an informative error line
 * (`<agent> <pct>% (<proj>/<win>) — cruce b<band>`) so every 30-min re-alert
 * of a persistent band stays readable. */
export function scanContextThreshold(input: ContextThresholdScanInput): HealthFinding[] {
  const findings: HealthFinding[] = []
  for (const row of input.rows) {
    const agentId = row.postId ?? row.hostId
    if (agentId === undefined || agentId === '') continue
    // No viable denominator → skip (a session without any request/context is
    // inactive — 0% safe; never a false positive).
    if (typeof row.contextWindow !== 'number' || !Number.isFinite(row.contextWindow) || row.contextWindow <= 0) continue
    let projected: number
    if (typeof row.projectedTokens === 'number' && Number.isFinite(row.projectedTokens)) {
      projected = Math.max(0, row.projectedTokens)
    } else if (typeof row.pressureTokens === 'number' && Number.isFinite(row.pressureTokens)) {
      const surface = typeof row.surfaceTokens === 'number' && Number.isFinite(row.surfaceTokens) ? row.surfaceTokens : 0
      const sampled = typeof row.sampledSurfaceTokens === 'number' && Number.isFinite(row.sampledSurfaceTokens) ? row.sampledSurfaceTokens : 0
      projected = Math.max(0, row.pressureTokens + surface - sampled)
    } else {
      projected = typeof row.surfaceTokens === 'number' && Number.isFinite(row.surfaceTokens) ? row.surfaceTokens : 0
    }
    const pct = projected / row.contextWindow
    if (pct <= input.threshold) continue
    const band = Math.floor(pct * 10)
    findings.push({
      kind: 'context-threshold',
      key: contextThresholdKey(agentId, band),
      ...(row.postId !== undefined ? { postId: row.postId } : { hostId: row.hostId }),
      ts: input.nowMs,
      error: `${agentId} ${Math.round(pct * 100)}% (${projected}/${row.contextWindow}) — cruce b${band}`
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// M-5 (FASE 4 kickoff 2026-08-31, owner gap «misión entregada a un head pero
// NO INICIADA») — the mission-stalled watchdog: a HEAD post whose HOST→head
// mission delivery (a mission message the host handed the head through the bus
// — the delivery-row seam) was NEVER PROCESSED within `missionStallMs`
// (default 600000 = 10 min) after the DELIVERY ts. "No procesada" = a
// host→head delivery row with NO turn/session write AFTER the delivery ts (a
// turn started / session write after the ts proves the mission was picked up —
// the buildPostSnapshot lastActivityTs primitive). DEDUPE: key
// `mission-stall:<postId>:<messageId>` in the SHARED health-alerts-state.json
// ledger — a persistent unprocessed mission re-alerts every
// HEALTH_DEDUPE_WINDOW_MS (30 min) while it stays stalled (the M-A per-band
// shared-ledger precedent). The quiet window is ABSOLUTE from the DELIVERY ts
// (a per-row fact, never accumulated) → NO ledger of its own is needed (the
// system-idle firstQuietTs pattern is NOT applicable: M-5 has no epoch to
// accumulate, every tick recomputes `nowMs - deliveryTs` from the same row).
// The dep `deps.missionActivity` ABSENT (undefined — a wiring that cannot
// resolve the mission-delivery seam) → the scan is a NO-OP (the hostRunning/
// sessionContexts-absent pattern: unknown delivery state never fabricates a
// stalled-mission ALERT). PURE — NEVER throws. Kinds/keys DISJOINT from every
// other scan: the same tick composes mission-stalled with system-idle /
// context-threshold / qi-silence / pooler-capacity (mission-stalled says "a
// mission was handed over but never started"; system-idle says "nobody is
// running at all" — different conditions, different keys).
// ---------------------------------------------------------------------------

/** M-5 — the default mission-stall window (10 min): a delivered-but-unstarted
 * mission alerts once this much time passed since its DELIVERY row ts. */
export const MISSION_STALL_DEFAULT_MS = 600000

/** M-5 — the mission-stalled dedupe key prefix (`mission-stall:<postId>:
 * <messageId>` — the SHARED health-alerts ledger gives the 30-min re-alert
 * cadence while the mission persists; per-mission keys, never per-post). */
export const MISSION_STALL_KEY_PREFIX = 'mission-stall:'

/** M-5 — build the per-mission dedupe key. */
export function missionStallKey(postId: string, messageId: string): string {
  return `${MISSION_STALL_KEY_PREFIX}${postId}:${messageId}`
}

/** M-5 — ONE head post's mission-activity input row: the LAST host→head
 * mission DELIVERY row (messageId + the DELIVERY-row ts — the ABSOLUTE quiet
 * anchor) + the post's last session-activity ts. STRUCTURAL — only the fields
 * the scan reads are declared (the bundle's buildMissionActivity computes
 * them from the message store + the catalog + the session-event primitive). */
export interface MissionActivityInput {
  postId: string
  /** True when the post is a retired member — a retired post is never a
   * stalled-mission signal (its rows terminal-settle, W7-A). */
  retired?: boolean
  /** The LAST host→head mission DELIVERY row: messageId + the DELIVERY-row ts
   * (ms epoch). ABSENT → no mission was delivered to this post (no input).
   * The delivery statuses that count are the host-handoff consummated classes
   * (delivered/prepared/resumed — the addressed-inbox trio) AND failed (a
   * mission attempt the delivery engine has not settled — still
   * delivered-but-unstarted from the head's viewpoint); self/terminal rows
   * are NEVER a mission (self = the post addressed itself; terminal = a
   * settled death-mark). */
  mission?: { messageId: string; ts: number }
  /** The post's LAST session-activity ts (the buildPostSnapshot lastActivityTs
   * — a session write/turn AFTER the mission's delivery ts proves the mission
   * was PROCESSED; absent → no session activity at all). */
  lastActivityTs?: number
}

/** M-5 — the mission-stalled scan inputs (the rows are ALREADY materialized by
 * the tick — zero new I/O in the scan). */
export interface MissionStallScanInput {
  rows: readonly MissionActivityInput[]
  /** The resolved stall window (knob `missionStallMs` or the 600000 default). */
  stallMs: number
  /** The clock (ms epoch) — stamped into the finding ts. */
  nowMs: number
}

/** M-5 — scan the delivered-but-unstarted mission condition (PURE, NEVER
 * throws). For every row with a mission delivery: a RETIRED post is skipped
 * (terminal); a post whose last session activity is AFTER the delivery ts is
 * PROCESSED (a turn started / a session write landed after the hand-off — the
 * mission is NOT stalled, the Bug-B "a running turn is healthy progress"
 * rule); a delivery younger than `stallMs` is not stalled yet; the rest →
 * the `mission-stalled` finding with the per-mission dedupe key + the
 * owner-facing line «misión <id> entregada a <head> hace N min sin inicio —
 * posible cola stale». */
export function scanMissionStalled(input: MissionStallScanInput): HealthFinding[] {
  const findings: HealthFinding[] = []
  for (const row of input.rows) {
    if (row.retired === true) continue
    const mission = row.mission
    if (mission === undefined) continue
    // Processed? A session write AFTER the delivery ts proves the mission was
    // picked up — a started turn is healthy progress, NEVER stalled.
    if (row.lastActivityTs !== undefined && row.lastActivityTs > mission.ts) continue
    // The quiet window is ABSOLUTE from the DELIVERY ts.
    const quietMs = input.nowMs - mission.ts
    if (quietMs < input.stallMs) continue
    const minutes = Math.round(quietMs / 60000)
    findings.push({
      kind: 'mission-stalled',
      key: missionStallKey(row.postId, mission.messageId),
      postId: row.postId,
      messageId: mission.messageId,
      ts: mission.ts,
      error: `misión ${mission.messageId} entregada a ${row.postId} hace ${minutes} min sin inicio — posible cola stale`
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// M-6 (FASE 4 lane 1, VALLE, 2026-08-31, owner gap «main rojo post-commit») —
// the MAIN-RED watchdog: detect a NEW commit at the dev repo HEAD whose FAST
// LOCKS fail, in MINUTES. The adopted lesson after the boot-factory anchor
// (a live `git show HEAD:src/invoke.ts` region calibration) left the suite red
// on main from f28c719 for HOURS without detection: the `node --test` FULL
// suite never runs on every commit (it is minutes-to-hours), so the post-commit
// re-verification runs ONLY the FAST locks (~seconds):
//   - `test/boot-factory` + `presets-factory` + `spawn-factory` +
//     `tools-factory` + `delivery-factory` + `export-parity` +
//     `binder-contract` + `client-row-invariant` (the default `mainRedLocks`).
//
// DETECTION (the I/O lives OUTSIDE the pure scan — the missionActivity
// pattern): the BUNDLE exposes `deps.mainRed` = buildMainRedState(repoRoot)
// with { readHeadSha() (git rev-parse HEAD), runLocks(paths) (node --test PER
// lock — a separate invocation per lock so the FAILED lock is named in the
// frame; results per file {file, ok}; ONE single execution per new sha) }. The
// TICK materializes { headSha, lastSeenSha, firstSeenMs, lockResults } and the
// SCAN (PURE, NEVER throws) decides the finding + the NEXT durable state:
//   - FIRST RUN (state has no lastSeenSha) → BASELINE only: record the current
//     HEAD sha, NO lock run, NO alert — the scan NEVER alerts at boot (a boot
//     mid-red cannot know when the commit landed; the M4/pacing first-boot
//     precedent). The NEXT new commit is what the watchdog detects.
//   - SAME sha at HEAD (no new commit) → NOTHING (the locks are NOT re-run — 1
//     ejecución por sha nuevo); a remembered RED state keeps RE-EMITTING the
//     finding (the SHARED health-alerts ledger gives the 30-min re-alert
//     cadence while the broken commit stays at HEAD — the dedupe key
//     `main-red:<sha>`).
//   - NEW sha (HEAD ≠ last-seen) → the tick ran the FAST locks for this sha;
//     a failed lock → the finding + the state advances { lastSeenSha: new,
//     firstSeenMs: nowMs } (+ redLocks = the failed lock files); all green →
//     the state advances SILENTLY (a green commit is the goal, never an alert).
// The red memory (redLocks) is DURABLE in main-red-state.json (the
// system-idle-state.json precedent — the shared ledger holds timestamps only,
// never values, and its 2h defensive prune would drop a long red window).
// KNOBS (`health.*`, default-on): `mainRedEnabled` (gate) + `mainRedPollMs`
// (the light HEAD poll cadence; absent/invalid → 300000 = 5 min) +
// `mainRedLocks` (the fast-lock paths; an explicit non-empty array overrides
// the 8-lock default).
// ---------------------------------------------------------------------------

/** M-6 — the default main-red HEAD poll cadence (5 min: a NEW commit at HEAD
 * is detected within minutes, never hours — the mission's core promise). */
export const MAIN_RED_DEFAULT_POLL_MS = 300000

/** M-6 — the default FAST locks (the post-commit re-verification set — the
 * boot factory + the 4 orchestration factories + the surface locks; ~seconds
 * each, NEVER the full suite). Repo-relative paths (joined against
 * `mainRedRepoRoot`/REPO_ROOT by the bundle's runLocks). */
export const MAIN_RED_DEFAULT_LOCKS = [
  'test/boot-factory.test.js',
  'test/presets-factory.test.js',
  'test/spawn-factory.test.js',
  'test/tools-factory.test.js',
  'test/delivery-factory.test.js',
  'test/export-parity.test.js',
  'test/binder-contract.test.js',
  'test/client-row-invariant.test.js'
]

/** M-6 — the main-red durable-state file — a SEPARATE file (the shared
 * health-alerts ledger's defensive 2h prune would drop a long red window;
 * precedent qi-silence-state.json / system-idle-state.json). */
export const MAIN_RED_STATE_FILE = 'main-red-state.json'
/** M-6 — the main-red dedupe key prefix (`main-red:<sha>` — the SHARED
 * health-alerts ledger holds the timestamps; the 30-min re-alert cadence while
 * the broken commit stays at HEAD). */
export const MAIN_RED_KEY_PREFIX = 'main-red:'

/** M-6 — build the per-sha dedupe key. */
export function mainRedKey(sha: string): string {
  return `${MAIN_RED_KEY_PREFIX}${sha}`
}

/** M-6 — the main-red durable state: the last-seen HEAD sha + when it was
 * first seen (the «detectado en N min» anchor — the system-idle firstQuietTs
 * precedent) + the REMEMBERED red locks (only while the current last-seen sha
 * is RED — the re-alert memory WITHOUT a lock re-run). */
export interface MainRedState {
  /** The last git HEAD sha the watchdog saw. ABSENT → no baseline yet (the
   * first-run case: the scan records the baseline, never alerts at boot). */
  lastSeenSha?: string
  /** The ms epoch when the CURRENT lastSeenSha was FIRST seen at HEAD. The
   * re-alert frame's N minutes = round((nowMs - firstSeenMs)/60000). */
  firstSeenMs?: number
  /** The lock files that FAILED for the current lastSeenSha (present ONLY
   * while the broken commit is RED — the durable re-alert memory). */
  redLocks?: string[]
}

/** Read `<stateDir>/main-red-state.json` → `{ lastSeenSha?, firstSeenMs?,
 * redLocks? }`. Absent / unreadable / malformed → {} (never throws). */
export function readMainRedState(stateDir: string): MainRedState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, MAIN_RED_STATE_FILE), 'utf8')) as Record<string, unknown>
    const out: MainRedState = {}
    if (typeof parsed.lastSeenSha === 'string' && parsed.lastSeenSha !== '') out.lastSeenSha = parsed.lastSeenSha
    if (typeof parsed.firstSeenMs === 'number' && Number.isFinite(parsed.firstSeenMs)) out.firstSeenMs = parsed.firstSeenMs
    if (Array.isArray(parsed.redLocks)) {
      const redLocks = parsed.redLocks.filter((x): x is string => typeof x === 'string' && x !== '')
      if (redLocks.length > 0) out.redLocks = redLocks
    }
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/main-red-state.json` (mkdir -p the dir, then the file). */
export async function writeMainRedState(stateDir: string, state: MainRedState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, MAIN_RED_STATE_FILE)), { recursive: true })
  await writeFile(path.join(stateDir, MAIN_RED_STATE_FILE), JSON.stringify(state), 'utf8')
}

/** M-6 — ONE fast-lock run result: the repo-relative lock path + whether
 * `node --test` exited 0 for it. */
export interface MainRedLockResult {
  file: string
  ok: boolean
}

/** M-6 — the main-red watchdog runtime (bundle-side — `buildMainRedState`):
 * the git-HEAD reader + the fast-lock runner over one repo root. The I/O
 * (child_process git / node --test) lives HERE, never in the pure scan. */
export interface MainRedRuntime {
  /** The CURRENT git HEAD sha (git rev-parse HEAD over the repo root).
   * Unreadable / not-a-repo → undefined (the tick then no-ops the scan). */
  readHeadSha(): string | undefined
  /** Run the FAST locks (node --test PER lock — a separate invocation per lock
   * so the failed lock is named in the frame; result per file {file, ok}).
   * NEVER throws. ONE single execution per new sha. */
  runLocks(paths: readonly string[]): Promise<readonly MainRedLockResult[]>
}

/** M-6 — the main-red scan inputs (ALREADY materialized by the tick — zero
 * new I/O in the scan; the missionActivity pattern). */
export interface MainRedScanInput {
  /** The CURRENT git HEAD sha (the bundle's readHeadSha over repoRoot). */
  headSha: string
  /** The durable last-seen sha (main-red-state.json; ABSENT on the first run). */
  lastSeenSha?: string
  /** The durable first-seen epoch of lastSeenSha (the N-minutes anchor). */
  firstSeenMs?: number
  /** The remembered red locks of the current lastSeenSha (state.redLocks). */
  redLocks?: readonly string[]
  /** The lock-run results for a NEW sha (the tick ran deps.mainRed.runLocks
   * ONLY when headSha ≠ last-seen — 1 ejecución por sha nuevo; a same-sha tick
   * passes an EMPTY list). */
  lockResults: readonly MainRedLockResult[]
  /** The clock (ms epoch) — stamped into the finding ts + the N minutes. */
  nowMs: number
}

/** M-6 — the main-red scan result: the findings + the NEXT durable state (the
 * tick persists only when changed). */
export interface MainRedScanResult {
  findings: HealthFinding[]
  state: MainRedState
  changed: boolean
}

/** M-6 — scan the post-commit red condition (PURE, NEVER throws):
 *  - FIRST RUN (no lastSeenSha) → BASELINE only — record the current HEAD,
 *    NEVER alert at boot;
 *  - SAME sha at HEAD → a remembered RED state re-emits the finding (the
 *    shared 30-min ledger re-alerts while the broken commit stays at HEAD); a
 *    green state → nothing (no lock re-run — 1 ejecución por sha nuevo);
 *  - NEW sha at HEAD → the fresh lock results decide: any failed lock → the
 *    `main-red` finding + the state advances (redLocks remembered); all green
 *    → the state advances SILENTLY.
 * The finding error carries the FULL owner-facing line («main rojo post-commit
 * <sha> — lock <X> falló (detectado en <N> min)» — N = round((nowMs -
 * firstSeenMs)/60000)) so every 30-min re-alert stays informative. */
export function scanMainRed(input: MainRedScanInput): MainRedScanResult {
  // FIRST RUN — the scan NEVER alerts at boot (a boot mid-red cannot know when
  // the commit landed; the M4/pacing first-boot precedent). Baseline only.
  if (input.lastSeenSha === undefined) {
    return { findings: [], state: { lastSeenSha: input.headSha, firstSeenMs: input.nowMs }, changed: true }
  }
  // SAME sha at HEAD — NO new commit. The locks are NOT re-run (1 ejecución
  // por sha nuevo); a remembered RED state keeps re-emitting the finding (the
  // shared 30-min ledger gives the re-alert cadence while it stays broken).
  if (input.headSha === input.lastSeenSha) {
    const red = input.redLocks ?? []
    if (red.length === 0) {
      return { findings: [], state: { lastSeenSha: input.lastSeenSha, firstSeenMs: input.firstSeenMs }, changed: false }
    }
    const minutes = Math.round((input.nowMs - (input.firstSeenMs ?? input.nowMs)) / 60000)
    return {
      findings: [{
        kind: 'main-red',
        key: mainRedKey(input.headSha),
        ts: input.nowMs,
        error: `main rojo post-commit ${input.headSha} — lock ${red.join(', ')} falló (detectado en ${minutes} min)`
      }],
      state: { lastSeenSha: input.lastSeenSha, firstSeenMs: input.firstSeenMs, redLocks: [...red] },
      changed: false
    }
  }
  // NEW commit at HEAD — the tick ran the FAST locks for THIS sha. A failed
  // lock → the finding + the red memory; all green → the state advances
  // silently (a green commit is the goal, never an alert).
  const failed = input.lockResults.filter((r) => r.ok !== true).map((r) => r.file)
  const state: MainRedState = {
    lastSeenSha: input.headSha,
    firstSeenMs: input.nowMs,
    ...(failed.length > 0 ? { redLocks: failed } : {})
  }
  if (failed.length === 0) {
    return { findings: [], state, changed: true }
  }
  const minutes = Math.round((input.nowMs - input.nowMs) / 60000)
  return {
    findings: [{
      kind: 'main-red',
      key: mainRedKey(input.headSha),
      ts: input.nowMs,
      error: `main rojo post-commit ${input.headSha} — lock ${failed.join(', ')} falló (detectado en ${minutes} min)`
    }],
    state,
    changed: true
  }
}

// ---------------------------------------------------------------------------
// M-7 (FASE 4 VALLE lane A, 2026-09-01, owner gap «cola de misiones por head
// con umbral de pendingCount») — the MISSION-QUEUE watchdog: a non-retired
// HEAD post whose PENDING (undrained) addressed-message count — the
// buildPostSnapshot pendingCount, the SAME primitive the W8-c stale-live /
// W8-d wait / M4 system-idle scans consume (REUSED, never duplicated) — is
// >= `missionQueueLimit` (default 5) SUSTAINED for >= `missionQueuePersistMs`
// (default 60000 = one poll tick at the default health interval) → a
// `mission-queue` finding + host ALERT through the existing
// findings→dedupe→notifyHost flow: a head with N missions heaped in its
// inbox undrained = the «posible backlog» condition (Fase 4 auto-
// observación).
//
// ANTI-TRANSIENT (the «ventana de persistencia mínima»): the scan never
// alerts on a one-tick spike. Its OWN ledger `mission-queue-state.json`
// (`{ [postId]: firstSeenMs }`) records the FIRST tick where a head's queue
// crossed the limit; the finding is emitted ONLY once `nowMs - firstSeenMs
// >= persistMs` (the M4 firstQuietTs precedent, generalized per-post); the
// next tick where the queue drops BELOW the limit DELETES the entry (the
// spike cleared → the window restarts clean). The ledger persists ONLY on
// change (the turn-errors/system-idle pattern).
//
// DEDUPE/RE-ALERT: the finding key `mission-queue:<postId>` rides the SHARED
// health-alerts-state.json ledger — a persistent backlog re-alerts every
// HEALTH_DEDUPE_WINDOW_MS (30 min) while it stays undrained (never a
// one-shot), a sub-threshold tick never alerts. Kinds/keys DISJOINT from
// every other scan (mission-stalled says «a mission was delivered but never
// started»; mission-queue says «a head has N+ undrained missions heaped»).
// The dep `deps.missionQueue` ABSENT (undefined — a wiring that cannot
// resolve the per-head queue) → the scan is a NO-OP (the
// hostRunning/missionActivity-absent pattern: unknown queues never fabricate
// a backlog ALERT). PURE — NEVER throws.
// ---------------------------------------------------------------------------

/** M-7 — the default mission-queue threshold: a HEAD post with >= 5 PENDING
 * (undrained) addressed messages is a mission backlog candidate. */
export const MISSION_QUEUE_DEFAULT_LIMIT = 5

/** M-7 — the default persistence window (1 min = ONE poll tick at the default
 * 60 s health interval): the over-limit queue must hold for >= this long
 * before it alerts (a transient spike — a burst the head is about to drain —
 * never does). */
export const MISSION_QUEUE_DEFAULT_PERSIST_MS = 60_000

/** M-7 — the mission-queue dedupe key prefix (`mission-queue:<postId>` — the
 * SHARED health-alerts ledger gives the 30-min re-alert cadence while the
 * backlog persists; per-post keys, never per-message). */
export const MISSION_QUEUE_KEY_PREFIX = 'mission-queue:'

/** M-7 — build the per-post dedupe key. */
export function missionQueueKey(postId: string): string {
  return `${MISSION_QUEUE_KEY_PREFIX}${postId}`
}

/** M-7 — the mission-queue LEDGER file — a SEPARATE file (the shared
 * health-alerts ledger's defensive 2h prune would drop a long firstSeen; the
 * system-idle-state.json precedent): `{ [postId]: firstSeenMs }`. */
export const MISSION_QUEUE_STATE_FILE = 'mission-queue-state.json'

/** M-7 — the mission-queue ledger: postId → the firstSeenMs of the SUSTAINED
 * over-limit queue (the anti-transient memory; deleted when the queue drops
 * below `missionQueueLimit`). */
export type MissionQueueState = Record<string, number>

/** Read `<stateDir>/mission-queue-state.json` → `{ [postId]: firstSeenMs }`.
 * Absent / unreadable / malformed → {} (never throws). */
export function readMissionQueueState(stateDir: string): MissionQueueState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, MISSION_QUEUE_STATE_FILE), 'utf8')) as Record<string, unknown>
    const out: MissionQueueState = {}
    for (const [postId, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[postId] = value
    }
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/mission-queue-state.json` (mkdir -p the dir, then the
 * file). */
export async function writeMissionQueueState(stateDir: string, state: MissionQueueState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, MISSION_QUEUE_STATE_FILE)), { recursive: true })
  await writeFile(path.join(stateDir, MISSION_QUEUE_STATE_FILE), JSON.stringify(state), 'utf8')
}

/** M-7 — ONE head post's mission-queue input row: the SAME activity inputs
 * buildPostSnapshot consumes (events + inboxTs → pendingCount) + the head
 * discriminator. STRUCTURAL — only the fields the scan reads are declared
 * (the bundle materializes the rows from the EXISTING buildHealthPosts
 * output, filtered to non-retired HEADS). */
export interface MissionQueueInput {
  postId: string
  /** True when the post is a retired member — a retired head is never a
   * mission-queue signal (its rows terminal-settle, W7-A). */
  retired?: boolean
  /** The post's provider marker: 'worker' for a disposable worker (NEVER a
   * mission-queue signal — only heads hold mission queues); ABSENT for a
   * configured head (and any non-worker post). */
  provider?: string
  /** The post's session event log (the buildPostSnapshot lastActivityTs term —
   * a turning head DRAINS its queue; absent/empty → no activity signal). */
  events?: readonly HealthSessionEvent[]
  /** The ts of messages ADDRESSED to the post (its inbox — the pendingCount
   * numerator). */
  inboxTs?: readonly number[]
}

/** M-7 — the mission-queue scan inputs (the rows are ALREADY materialized by
 * the tick — zero new I/O in the scan). */
export interface MissionQueueScanInput {
  rows: readonly MissionQueueInput[]
  /** The resolved pendingCount threshold (knob `missionQueueLimit` or the 5
   * code default). */
  limit: number
  /** The resolved persistence window (knob `missionQueuePersistMs` or the
   * 60000 code default): the over-limit queue must hold >= this long before
   * the finding emits. */
  persistMs: number
  /** The clock (ms epoch) — stamped into the finding ts + the sustained
   * window. */
  nowMs: number
  /** The CURRENT ledger (read by the tick; mutated → the returned next
   * ledger). */
  ledger: MissionQueueState
}

/** M-7 — the mission-queue scan result: the findings + the NEXT ledger +
 * whether the ledger CHANGED (the tick persists only then). */
export interface MissionQueueScanResult {
  findings: HealthFinding[]
  ledger: MissionQueueState
  changed: boolean
}

/** M-7 — scan the head mission-backlog condition (PURE, NEVER throws). For
 * every row: a RETIRED post or a WORKER is skipped (never a mission-queue
 * signal); the queue's pendingCount is the SHARED buildPostSnapshot
 * computation (REUSED — no duplicated pending logic); a queue BELOW the limit
 * clears the ledger entry (the spike broke / the head drained → the window
 * restarts clean); an over-limit queue records its firstSeen (first crossing
 * tick) and emits the `mission-queue` finding ONLY once the SUSTAINED window
 * `nowMs - firstSeenMs >= persistMs` completed (a transient spike never
 * alerts). The finding: key `mission-queue:<postId>` (the SHARED ledger gives
 * the 30-min re-alert cadence while the backlog persists), the owner-facing
 * line «cola de misiones <postId>: <n> pendientes sin drenar — posible
 * backlog». */
export function scanMissionQueue(input: MissionQueueScanInput): MissionQueueScanResult {
  const ledger = { ...input.ledger }
  let changed = false
  const findings: HealthFinding[] = []
  for (const row of input.rows) {
    if (row.retired === true) continue
    // HEADS ONLY — a disposable worker's queue is never a mission backlog
    // (the bundle filters it too; this is the scan's own guard).
    if (row.provider === 'worker') continue
    const snap = buildPostSnapshot(row)
    if (snap.pendingCount < input.limit) {
      // Below the limit: the backlog cleared → forget the sustained window.
      if (ledger[row.postId] !== undefined) {
        delete ledger[row.postId]
        changed = true
      }
      continue
    }
    // Over the limit: record the first sustained crossing, then wait for the
    // persistence window (a one-tick spike never alerts).
    if (ledger[row.postId] === undefined) {
      ledger[row.postId] = input.nowMs
      changed = true
    }
    const firstSeen = ledger[row.postId]
    if (input.nowMs - firstSeen < input.persistMs) continue
    findings.push({
      kind: 'mission-queue',
      key: missionQueueKey(row.postId),
      postId: row.postId,
      ts: snap.oldestPendingTs ?? input.nowMs,
      count: snap.pendingCount,
      error: `cola de misiones ${row.postId}: ${snap.pendingCount} pendientes sin drenar — posible backlog`
    })
  }
  return { findings, ledger, changed }
}

// ---------------------------------------------------------------------------
// LANE 5 — the work-register-idle watchdog (fb-46, QUALITY REQUEST QH,
// 2026-09-01 — the reviewer mission «watchdog work-register-idle»). The
// WORK-REGISTER (docs/WORK-REGISTER.md) is the org's SINGLE pending-work queue
// (the «cola de diferidos» — §7 of the register itself) and NO existing
// watchdog reads it at the DOCS level: M4 system-idle sees only the
// MESSAGE-level pendingCount (a register item that never became a message is
// invisible to it) — the stagnation audit found the org STATIC in VALLE with a
// despatchable queue (~12 h of risk) while zero health-alerts fired. This
// watchdog ALERTS the HOST (never dispatches — the host decides/re-dispatches)
// iff ALL hold:
//   1. [VALLE] — `isPeakAt(now, pacingWindow) == false` (the dshd-core pacing
//      epoch; PEAK is the INTENTIONAL dispatch pause — a queue accumulating in
//      PEAK is expected, NEVER an idle alarm);
//   2. [pending WORK-REGISTER] — `countPendingWorkRegister(registerText) > 0`
//      (the REUSED dshd-core count utility — same section-split + bold-marker
//      semantics, single source of truth) AND at least ONE NON-GATED
//      (despatchable) item exists: the §3 PENDIENTE-OWNER section is GATED —
//      an owner-pending decision waits for the owner BY DESIGN and never
//      triggers the alarm (a §3-only register is 0 frames);
//   3. [0 agents running] — `hostRunning !== true` AND no non-retired post
//      reports `running:true` (the M4 Bug B rule: a mid-turn is progress);
//   4. [quiet >= quietWindow] — since `firstQuietTs` (the OWN ledger — a
//      SEPARATE file like system-idle-state.json: the shared health-alerts
//      ledger's defensive 2h prune would drop a long first-quiet). ANY running
//      agent OR a PEAK franja BREAKS the epoch (the window restarts when the
//      full condition returns).
// The ALERT rides the EXISTING findings→dedupe→notifyHost flow (key
// `work-register-idle` — re-alerts every HEALTH_DEDUPE_WINDOW_MS while the
// condition persists, never a one-shot) and NEVER goes through
// deliverDaemonNotice (the B4 gate — the daemon wiring delivers DIRECT). The
// frame lists the NON-GATED items (the despatchable queue — the §3 gated items
// are never listed). The watchdog NEVER dispatches: it only alerts.
// ---------------------------------------------------------------------------

/** The work-register-idle dedupe key (ONE key in the SHARED health-alerts
 * ledger — the 30-min re-alert cadence while the condition persists). */
export const WORK_REGISTER_IDLE_KEY = 'work-register-idle'

/** The work-register-idle ledger file — a SEPARATE file (the shared
 * health-alerts ledger's 2h prune would drop a long firstQuietTs; the
 * system-idle-state.json precedent): `{ firstQuietTs }`. */
export const WORK_REGISTER_IDLE_STATE_FILE = 'work-register-idle-state.json'

/** LANE 5 — the default VALLE-quiet window (15 min — the mission's quietWindow;
 * shorter than the 30-min dedupe so the FIRST alert lands when the quiet
 * completes (15 min) and the re-alert cadence owns the rest). */
export const WORK_REGISTER_IDLE_DEFAULT_QUIET_MS = 900000

/** The OWNER-GATED section marker: a `## ` heading carrying this class (the §3
 * PENDIENTE-OWNER / owner-decision section of the register) marks every item
 * under it as GATED — an owner-pending decision waits for the owner BY DESIGN
 * and NEVER triggers the work-register-idle alarm (the «PENDIENTE-OWNER»
 * literal is the register's stable §3 heading, verified 2026-09-01). */
export const WORK_REGISTER_IDLE_GATED_SECTION_RE = /PENDIENTE-OWNER/i

/** The frame-list bound: at most this many NON-gated item labels render in the
 * ALERT bullet (the count + «… y N más» carry the rest). */
export const WORK_REGISTER_IDLE_MAX_LISTED = 8

/** ONE parsed WORK-REGISTER item: the `**…**`-bolded label under an open `## `
 * section, with its GATE classification (the §3 PENDIENTE-OWNER class = gated). */
export interface WorkRegisterItem {
  /** The `## ` section heading the item lives under (its gate class source). */
  section: string
  /** True when the item sits under an OWNER-GATED section (the §3
   * PENDIENTE-OWNER class — waits on the owner; NEVER despatchable). */
  gated: boolean
  /** The bold-marked item label (`**…**` text with the asterisks stripped). */
  label: string
}

/** LANE 5 — parse the WORK-REGISTER into its item census with the GATED vs
 * NON-gated classification. REUSES the exact `countPendingWorkRegister`
 * semantics (the same `## ` section split, the same CERRADO/closed reference
 * section skip, the same `**…**` bold-marker extraction skipping the
 * DONE/CERRADO/RESUELTO/RETIRADO status tags) so the TOTAL agrees with the
 * existing dshd-core utility byte-for-byte, and ADDS the gate class: a section
 * whose heading matches WORK_REGISTER_IDLE_GATED_SECTION_RE (the §3
 * PENDIENTE-OWNER class) is GATED; every other open section's items are
 * NON-gated (despatchable — the §1/§4/§5 classes; a closed/reference section
 * contributes nothing). PURE — NEVER throws (not a register-shaped doc → []). */
export function parseWorkRegisterItems(text: string): WorkRegisterItem[] {
  const sections = text.split(/^##\s+/m)
  if (sections.length <= 1) return []
  const out: WorkRegisterItem[] = []
  for (let i = 1; i < sections.length; i++) {
    const lines = sections[i].split('\n')
    const heading = (lines[0] ?? '').trim()
    if (/CERRADO|closed/i.test(heading)) continue
    const gated = WORK_REGISTER_IDLE_GATED_SECTION_RE.test(heading)
    const body = lines.slice(1).join('\n')
    const markers = body.match(/\*\*([^*]+)\*\*/g)
    if (markers === null) continue
    for (const marker of markers) {
      if (/\b(DONE|CERRADO|RESUELTO|RETIRADO)\b/i.test(marker)) continue
      out.push({ section: heading, gated, label: marker.slice(2, -2) })
    }
  }
  return out
}

/** The work-register-idle ledger: `firstQuietTs` = the ts (ms epoch) of the
 * FIRST tick that observed the full quiet-VALLE state (0 agents running in a
 * VALLE franja). The quiet duration is `nowMs - firstQuietTs`; the entry is
 * REPLACED when ANY agent runs OR the franja leaves VALLE (the epoch is broken
 * → the window restarts when the full condition returns). Persisted only when
 * it changes (the turn-errors/system-idle pattern). */
export interface WorkRegisterIdleState {
  firstQuietTs?: number
}

/** Read `<stateDir>/work-register-idle-state.json` → `{ firstQuietTs? }`.
 * Absent / unreadable / malformed → {} (never throws). */
export function readWorkRegisterIdleState(stateDir: string): WorkRegisterIdleState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, WORK_REGISTER_IDLE_STATE_FILE), 'utf8')) as Record<string, unknown>
    const out: WorkRegisterIdleState = {}
    if (typeof parsed.firstQuietTs === 'number' && Number.isFinite(parsed.firstQuietTs)) out.firstQuietTs = parsed.firstQuietTs
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/work-register-idle-state.json` (mkdir -p the dir, then the
 * file). */
export async function writeWorkRegisterIdleState(stateDir: string, state: WorkRegisterIdleState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, WORK_REGISTER_IDLE_STATE_FILE)), { recursive: true })
  await writeFile(path.join(stateDir, WORK_REGISTER_IDLE_STATE_FILE), JSON.stringify(state), 'utf8')
}

/** The work-register-idle scan inputs: the register TEXT (read by the tick from
 * `deps.workRegisterPath` — the scan itself is PURE, zero I/O), the franja
 * valley flag (computed by the tick with the REUSED dshd-core pacing — the
 * `isPeakAt == false` leg), the host's running signal, the catalog posts, the
 * clock, the resolved quiet window (knob `workRegisterIdleQuietMs` or the
 * 15-min code default) and the current ledger. */
export interface WorkRegisterIdleScanInput {
  /** The WORK-REGISTER markdown text (the tick reads `deps.workRegisterPath`;
   * unreadable/absent → '' → the pending-census legs fail → conservative no-op). */
  registerText: string
  /** True when the current franja is VALLE (isPeakAt == false — the tick
   * computes it with the REUSED dshd-core pacing window). PEAK → the epoch is
   * broken (an intentional pause never accumulates idle time). */
  valley: boolean
  /** The host's live running signal (true → not quiet — the M4 Bug B rule). */
  hostRunning?: boolean
  /** The catalog posts (a non-retired post with running:true → not quiet). */
  posts: readonly PostActivityInput[]
  /** The clock (ms epoch). */
  nowMs: number
  /** The resolved quiet window (knob or default). */
  quietWindowMs: number
  /** The CURRENT ledger (read by the tick; mutated → the returned next ledger). */
  ledger: WorkRegisterIdleState
}

/** The work-register-idle scan result: the findings (≤1 per tick, key
 * WORK_REGISTER_IDLE_KEY), the NEXT ledger, whether the ledger CHANGED (the
 * tick persists only then) and the warn-only flag (window done with ZERO
 * NON-gated pending items — expected quiet: no finding, the tick warns). */
export interface WorkRegisterIdleScanResult {
  findings: HealthFinding[]
  ledger: WorkRegisterIdleState
  changed: boolean
  /** True when the quiet window COMPLETED with ZERO NON-gated pending items —
   * expected quiet (either no register work at all, or a §3-only register whose
   * gated items wait on the owner BY DESIGN) → warn-only, no finding. */
  quietWithoutPending: boolean
}

/** LANE 5 — scan the WORK-REGISTER-idle condition (PURE, NEVER throws). The
 * quiet epoch is BROKEN (firstQuietTs deleted) when ANY agent runs
 * (hostRunning===true or a non-retired post running:true — M4 Bug B) OR the
 * franja is PEAK (an intentional dispatch pause never accumulates idle time);
 * while the full quiet-VALLE state holds: (a) the first quiet tick stamps
 * firstQuietTs; (b) once `nowMs - firstQuietTs >= quietWindowMs` the pending
 * census decides: pending NON-gated register items → the `work-register-idle`
 * finding (key WORK_REGISTER_IDLE_KEY — the SHARED dedupe gives the 30-min
 * re-alert cadence while the condition persists; the frame lists the NON-gated
 * items); NO NON-gated pending (a §3-only register or an empty one) →
 * quietWithoutPending (the tick warns, no finding). The total-pending leg
 * REUSES `countPendingWorkRegister` (the dshd-core utility — byte-consistent
 * with the parsed census by construction). */
export function scanWorkRegisterIdle(input: WorkRegisterIdleScanInput): WorkRegisterIdleScanResult {
  const ledger = { ...input.ledger }
  let changed = false
  const anyRunning = input.hostRunning === true || input.posts.some((p) => p.retired !== true && p.running === true)
  if (anyRunning || !input.valley) {
    // The quiet-VALLE epoch is broken: an agent is mid-turn (progress, NEVER
    // quiet) OR the franja left VALLE (a PEAK is the intentional pause — the
    // window must restart when VALLE returns).
    if (ledger.firstQuietTs !== undefined) {
      delete ledger.firstQuietTs
      changed = true
    }
    return { findings: [], ledger, changed, quietWithoutPending: false }
  }
  // Quiet-VALLE epoch: stamp the first quiet tick, then measure the duration.
  const firstQuietTs = ledger.firstQuietTs ?? input.nowMs
  if (ledger.firstQuietTs === undefined) {
    ledger.firstQuietTs = input.nowMs
    changed = true
  }
  const quietMs = input.nowMs - firstQuietTs
  if (quietMs < input.quietWindowMs) {
    return { findings: [], ledger, changed, quietWithoutPending: false }
  }
  // The window COMPLETED → the WORK-REGISTER census decides. The total-pending
  // leg REUSES the existing count utility; the item census separates GATED
  // (§3 PENDIENTE-OWNER — waits on the owner BY DESIGN) from NON-gated.
  const totalPending = countPendingWorkRegister(input.registerText)
  const items = parseWorkRegisterItems(input.registerText)
  const nonGated = items.filter((item) => item.gated !== true)
  if (totalPending === undefined || totalPending <= 0 || nonGated.length === 0) {
    return { findings: [], ledger, changed, quietWithoutPending: true }
  }
  const minutes = Math.round(quietMs / 60000)
  // The frame's item list: the NON-gated labels, bounded (a huge register must
  // not produce an unbounded ALERT frame) — the count carries the full census.
  const listLabels = nonGated.map((item) => item.label)
  const listText = listLabels.slice(0, WORK_REGISTER_IDLE_MAX_LISTED).join('; ') +
    (listLabels.length > WORK_REGISTER_IDLE_MAX_LISTED ? `; … y ${listLabels.length - WORK_REGISTER_IDLE_MAX_LISTED} más` : '')
  const findings: HealthFinding[] = [{
    kind: 'work-register-idle',
    key: WORK_REGISTER_IDLE_KEY,
    ts: input.nowMs,
    count: nonGated.length,
    error: `WORK-REGISTER con ${nonGated.length} item(s) NO-gateado(s) sin despachar en VALLE (quiet ≥ ${input.quietWindowMs} ms, 0 agentes): ${listText}`
  }]
  return { findings, ledger, changed, quietWithoutPending: false }
}

/** Build the framed host ALERT text — `[From deepartments] System-health ALERT:
 * <grouped findings>`. Each finding is a one-line bullet. The config-preset and
 * stalled-post bullets describe their anomaly verbally (never the literal
 * double-brace template token — the ALERT is a prompt-facing bus message). */
export function buildHealthAlertFrame(findings: HealthFinding[]): string {
  const lines = findings.map((finding) => {
    if (finding.kind === 'post-error') {
      const detail = finding.error !== undefined && finding.error !== '' ? `: ${finding.error}` : ''
      // fb-30 — the CATCH-UP bullet prefix (frame propio): a boot catch-up
      // finding renders its line with the marker so the host distinguishes a
      // missed-window recovery from a fresh anomaly; the LIVE bullets are
      // byte-intact (the marker is additive, R6).
      const prefix = finding.catchup === true ? 'CATCH-UP ' : ''
      // fb-25 (b): the SESSION PROVENANCE — when the finding's rows[0] carried
      // sessionId/turn, the frame appends `[session <id> turn <n> (HH:MMZ)]` so
      // the host sees the error belongs to an ARCHIVED session (never the fresh
      // one). Legacy rows WITHOUT provenance render the current text (R6).
      // The time label derives from the finding ts (the group's most-recent row
      // ts, UTC HH:MM).
      const provenance: string[] = []
      if (finding.sessionId !== undefined) provenance.push(`session ${finding.sessionId}`)
      if (finding.turn !== undefined) provenance.push(`turn ${finding.turn}`)
      const provenanceLabel = provenance.length === 0
        ? ''
        : ` [${provenance.join(' ')} (${new Date(finding.ts).toISOString().slice(11, 16)}Z)]`
      return `- ${prefix}post-error: ${finding.postId} (${finding.count ?? 1} in window)${detail}${provenanceLabel}`
    }
    if (finding.kind === 'delivery-failed') {
      // fb-30 — the CATCH-UP bullet prefix (frame propio, the post-error rule).
      const prefix = finding.catchup === true ? 'CATCH-UP ' : ''
      return `- ${prefix}delivery-failed: ${finding.messageId}`
    }
    if (finding.kind === 'config-preset') {
      return `- config-preset: unbound template reference(s) in preset text${finding.error !== undefined && finding.error !== '' ? `: ${finding.error}` : ''}`
    }
    // M1 — the two new kinds need their OWN branches (the fallback below would
    // render an unknown kind as a stalled-post — never let these kinds hit it).
    if (finding.kind === 'pooler-capacity') {
      const level = finding.key === POOLER_CAPACITY_KEY_CRITICAL ? 'critical' : 'warning'
      return `- pooler-capacity ${level}: ${finding.error ?? `pool capacity low (${finding.count ?? 0} usable)`}`
    }
    if (finding.kind === 'qi-silence') {
      return `- qi-silence: ${finding.error ?? `worker retirements with no quality-inspect directive (${finding.count ?? 0})`}`
    }
    // M4 — the system-idle branch (NEVER let it reach the stale-post fallback).
    // The owner-facing wording is the mission's own («<n> pendiente(s) sin
    // agente running durante <idleWindowMs> ms — posible espera que nunca
    // llegó»): the finding error carries the full line (count, window, the
    // quiet since ts + minutes — so every 30-min re-alert stays informative).
    if (finding.kind === 'system-idle') {
      return `- system-idle: ${finding.error ?? `${finding.count ?? 0} pendiente(s) sin agente running — posible espera que nunca llegó`}`
    }
    // M-A — the context-threshold branch (NEVER let it reach the stale-post
    // fallback). The owner-facing wording is the finding's own line (agent +
    // percent + tokens/window + the band crossed — the error carries the FULL
    // line so every 30-min per-band re-alert stays informative).
    if (finding.kind === 'context-threshold') {
      return `- context-threshold: ${finding.error ?? `${finding.postId ?? finding.hostId} context window usage above the threshold`}`
    }
    // M-5 — the mission-stalled branch (NEVER let it reach the stale-post
    // fallback). The owner-facing wording is the mission's own line (misión
    // <id> entregada a <head> hace N min sin inicio — posible cola stale: the
    // error carries the FULL line so every 30-min re-alert stays informative).
    if (finding.kind === 'mission-stalled') {
      return `- mission-stalled: ${finding.error ?? `misión ${finding.messageId ?? ''} entregada a ${finding.postId ?? ''} sin inicio — posible cola stale`}`
    }
    // M-6 — the main-red branch (NEVER let it reach the stale-post fallback).
    // The owner-facing wording is the finding's own line (sha + the failed
    // lock + the detection delay — the error carries the FULL line so every
    // 30-min re-alert stays informative).
    if (finding.kind === 'main-red') {
      return `- main-red: ${finding.error ?? 'main rojo post-commit <sha> — lock <X> falló (detectado en <?> min)'}`
    }
    // M-7 — the mission-queue branch (NEVER let it reach the stale-post
    // fallback). The owner-facing wording is the finding's own line (cola de
    // misiones <postId>: <n> pendientes sin drenar — posible backlog: the
    // error carries the FULL line so every 30-min re-alert stays
    // informative).
    if (finding.kind === 'mission-queue') {
      return `- mission-queue: ${finding.error ?? `cola de misiones ${finding.postId ?? ''}: ${finding.count ?? 0} pendientes sin drenar — posible backlog`}`
    }
    // LANE 5 — the work-register-idle branch (NEVER let it reach the stale-post
    // fallback). The owner-facing wording is the finding's own line (the
    // WORK-REGISTER has N NON-gated despatchable items sitting in VALLE with
    // zero agents — possible stagnation: the error carries the FULL line
    // including the NON-gated item labels, so every 30-min re-alert stays
    // informative and the host sees WHAT to re-dispatch).
    if (finding.kind === 'work-register-idle') {
      return `- work-register-idle: ${finding.error ?? `WORK-REGISTER con ${finding.count ?? 0} item(s) NO-gateado(s) sin despachar en VALLE — posible espera que nunca llegó`}`
    }
    return `- stalled-post: ${finding.postId} (${finding.count ?? 1} pending message(s), ${finding.error ?? 'no session activity'})`
  })
  return `[From deepartments] System-health ALERT:\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// PACING — the peak/valley FRANJA transition monitor (owner m-PACING,
// 2026-08-28, pacing/coste MEDIUM — the gate that reduces 429s and cost).
//
// The org lives in BURST mode around the owner's off-peak/peak pricing
// boundary; the FRANJA state is a pure UTC clock fact (dshd-core src/pacing.ts
// — the MIRROR of the dsh-key-pooler peak definition, crossed by comment).
// The daemon computes the current franja on EVERY tick and, on a TRANSITION,
// delivers EXACTLY ONE durable bus notice to the host:
//   - ENTERING PEAK (valle → peak)  → «pausa de nuevos despachos» (new
//     host→department dispatches pause; in-flight continues);
//   - ENTERING VALLE (peak → valle) → «reanuda; despachos diferidos: N» (the N
//     is the WORK-REGISTER pending queue count when legible — the deferred
//     dispatches ARE the pending WORK-REGISTER items, there is NO new data
//     queue; unreadable → the count is omitted).
//
// CHANNEL (no-perdible): the notice rides the SAME notifyHost seam as the
// health ALERTs — the bundle wiring store.append()s a DURABLE bus record and
// busDeliverToHost(..., { interrupt: true }) PREEMPTS a busy host turn (C8 —
// the delivery goes DIRECT, never through the delivery engine, so no
// 'prepared'/'failed' row can ever re-alert it).
//
// DETECTION + DEDUPE:
//   - the PREVIOUS franja is the DURABLE `<stateDir>/pacing-state.json`
//     baseline (survives restarts — the qi-silence/sidecar precedent);
//   - the EMISSION dedupe rides the SHARED health-alerts-state.json ledger
//     (key 'pacing-transition' → lastEmittedAtMs — a re-emission inside
//     HEALTH_DEDUPE_WINDOW_MS is impossible even when a crash loses the
//     baseline write between emit and persist);
//   - FIRST BOOT (no baseline): the current franja is RECORDED, NOTHING is
//     emitted — a boot mid-peak cannot know when the entry transition
//     happened (the window may be long past) and the wake pack already carries
//     the CURRENT franja (the pack injection covers the state; documented
//     decision — the only "boot in peak" notices that CAN exist are fast
//     restarts, and the durable baseline + ledger dedupe still block any
//     duplicate);
//   - NO live host → the notice is SKIPPED and the baseline is NOT advanced
//     (it retries on a later tick — the no-perdible contract).
// KNOB: `org.pacing.enabled === false` → the monitor is a NO-OP (the
// pre-pacing / R6-legacy behavior — no watches, no notices).
// ---------------------------------------------------------------------------

/** The pacing durable baseline file (the PREVIOUS franja; survives restarts —
 * a SEPARATE file like system-idle-state.json — the shared ledgers here hold
 * timestamps, not values). */
export const PACING_STATE_FILE = 'pacing-state.json'
/** The pacing emission Dedupe key in the SHARED health-alerts ledger (≤1
 * 'pacing-transition' delivery inside HEALTH_DEDUPE_WINDOW_MS — the exact
 * invariant of every other key in that ledger). */
export const PACING_TRANSITION_KEY = 'pacing-transition'

/** The pacing durable baseline: the franja observed at the last transition
 * (or first boot) + when it was recorded. */
export interface PacingDurableState {
  franja: 'peak' | 'valle'
  /** The ms epoch when the baseline was recorded. */
  at: number
}

/** Read `<stateDir>/pacing-state.json` → the durable baseline. Absent /
 * unreadable / malformed → undefined (the first-boot case; never throws). */
export function readPacingState(stateDir: string): PacingDurableState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, PACING_STATE_FILE), 'utf8')) as Record<string, unknown>
    if (parsed.franja !== 'peak' && parsed.franja !== 'valle') return undefined
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return undefined
    return { franja: parsed.franja, at: parsed.at }
  } catch {
    return undefined
  }
}

/** Write `<stateDir>/pacing-state.json` (mkdir -p the dir, then the file). */
export async function writePacingState(stateDir: string, state: PacingDurableState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, PACING_STATE_FILE)), { recursive: true })
  await writeFile(path.join(stateDir, PACING_STATE_FILE), JSON.stringify(state), 'utf8')
}

/** Build the pacing transition bus notice (the PEAK pause / VALLE resume frame
 * delivered to the host — the same `[From deepartments] …` frame convention as
 * the system-wait wake). `deferredCount` is the WORK-REGISTER pending count for
 * the VALLE notice; UNDEFINED → the count is OMITTED (the register was not
 * legible). PURE. */
export function buildPacingTransitionFrame(state: PacingState, deferredCount?: number): string {
  const span = `[${state.span}] UTC`
  if (state.peak) {
    return `[From deepartments] Pacing PEAK: pausa de nuevos despachos a departamentos (los in-flight continúan); franja PEAK ${span} — hasta ${state.untilHhMm} UTC`
  }
  const count = deferredCount === undefined ? '' : `; despachos diferidos: ${deferredCount} (cola del WORK-REGISTER)`
  return `[From deepartments] Pacing VALLE: reanuda los despachos a departamentos${count}; franja VALLE — próximo PEAK hasta ${state.untilHhMm} UTC`
}

// ---------------------------------------------------------------------------
// HARDENING-401 (fb-39, 2026-09-01) — the CAPACITY GATE (pooler capacity
// CRÍTICO) transition monitor. MOLDE FRANJA PEAK: the same transition-monitor
// shape as the pacing franja monitor above — compute the pool capacity verdict
// every tick, and on a TRANSITION (ok → critical, or critical → ok) deliver
// EXACTLY ONE durable bus notice to the host (the notifyHost seam). The gate
// PAUSES new dispatches while the pool is CRÍTICO (billing exhausted / all
// keys dry — the «todas-secas» class) and RESUMES on recovery. NOTICE NEVER
// SILENT: every state flip emits a durable notice (the PAUSE names the billing
// class; the RESUME names the WORK-REGISTER deferred count). A billing block
// is near-PERMANENT (fb-39) so the pause only lifts when the pool RECOVERS
// (a fresh usable key / the billing flag cleared by the pooler).
//
// COMPOSITION WITH THE FRANJA PEAK: in PEAK the franja monitor already pauses
// host→dept dispatches. The capacity gate is a SEPARATE pause whose CRÍTICO
// verdict takes PRIORITY: when BOTH are active in the same tick, the CRÍTICO
// notice is emitted (and the PEAK notice is suppressed that tick for clarity —
// the resume cadence is: leave CRÍTICO first, then the franja transition).
// They share the SAME health-alerts ledger (distinct dedupe keys), so neither
// double-notifies inside HEALTH_DEDUPE_WINDOW_MS.
//
// KNOB: `health.poolerGateEnabled === false` → the monitor is a NO-OP. Default
// ON (the mission's 0-change-with-a-healthy-pool contract: with a healthy pool
// the verdict stays OK and NO notice is ever emitted).
// ---------------------------------------------------------------------------

/** The capacity-gate durable baseline file (the PREVIOUS verdict; survives
 * restarts like pacing-state.json). */
export const CAPACITY_GATE_STATE_FILE = 'capacity-gate-state.json'
/** The capacity-gate emission Dedupe key PREFIX in the SHARED health-alerts
 * ledger — the PAUSE (critical) and RESUME (ok) use DISTINCT per-verdict keys
 * (`capacity-gate:critical` / `capacity-gate:ok`) so a fast pause→resume cycle
 * emits BOTH (the host must learn it can resume even shortly after a pause;
 * each direction is ≤1 delivery inside HEALTH_DEDUPE_WINDOW_MS). */
export const CAPACITY_GATE_TRANSITION_KEY = 'capacity-gate'
/** The per-verdict dedupe key for a capacity-gate transition (the PAUSE names
 * the CRÍTICO class, the RESUME the recovery — separate cadences). */
export function capacityGateDedupeKey(verdict: 'critical' | 'ok'): string {
  return `${CAPACITY_GATE_TRANSITION_KEY}:${verdict}`
}

/** The capacity-gate durable baseline: the verdict observed at the last
 * transition (or first boot) + when it was recorded. */
export interface CapacityGateDurableState {
  verdict: 'critical' | 'ok'
  /** The ms epoch when the baseline was recorded. */
  at: number
}

/** Read `<stateDir>/capacity-gate-state.json` → the durable baseline. Absent /
 * unreadable / malformed → undefined (the first-boot case; never throws). */
export function readCapacityGateState(stateDir: string): CapacityGateDurableState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, CAPACITY_GATE_STATE_FILE), 'utf8')) as Record<string, unknown>
    if (parsed.verdict !== 'critical' && parsed.verdict !== 'ok') return undefined
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return undefined
    return { verdict: parsed.verdict, at: parsed.at }
  } catch {
    return undefined
  }
}

/** Write `<stateDir>/capacity-gate-state.json` (mkdir -p the dir, then the file). */
export async function writeCapacityGateState(stateDir: string, state: CapacityGateDurableState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, CAPACITY_GATE_STATE_FILE)), { recursive: true })
  await writeFile(path.join(stateDir, CAPACITY_GATE_STATE_FILE), JSON.stringify(state), 'utf8')
}

/** Build the capacity-gate transition bus notice (the CRÍTICO PAUSE / OK RESUME
 * frame delivered to the host — the same `[From deepartments] …` convention).
 * `verdict` is the NEW state; `detail` is the scan finding's error text for the
 * CRÍTICO notice (the billing class / the usable count); `deferredCount` is the
 * WORK-REGISTER pending count for the RESUME notice (UNDEFINED → omitted).
 * PURE. */
export function buildCapacityGateFrame(verdict: 'critical' | 'ok', detail: string | undefined, deferredCount?: number): string {
  if (verdict === 'critical') {
    const cause = (detail ?? '').trim() !== '' ? ` (${detail?.trim()})` : ''
    return `[From deepartments] Pool capacity CRÍTICO: pausa de nuevos despachos a departamentos (los in-flight continúan)${cause}; se reanuda al recuperar capacidad`
  }
  const count = deferredCount === undefined ? '' : `; despachos diferidos: ${deferredCount} (cola del WORK-REGISTER)`
  return `[From deepartments] Pool capacity OK: reanuda los despachos a departamentos${count}`
}

/** ONE system-health tick: (1) write the heartbeat; (2) W8-c turn-failure
 * capture (record fresh turn errors into post-errors.jsonl); (3) scan
 * post-errors + delivery-failed + config-preset + stalled-post + the M1
 * watchdogs (pooler-capacity: the key-pooler state file when
 * `deps.poolerStatePath` is injected; qi-silence: the retirement/directive
 * silence guarantee) + the M4 system-idle watchdog (GLOBAL quiet: zero agents
 * running >= `idleWindowMs` with pending work — runs only when the bundle
 * resolved `deps.hostRunning`; expected quiet → warn-only) + the M-A
 * context-threshold watchdog (context-pressure: a post or the host over
 * `contextThreshold` of its window — runs only when the bundle resolved
 * `deps.sessionContexts` from the in-process sessionProjections service; the
 * per-`contextThresholdPollMs` bucket gate; dedupe by band) for anomalies
 * inside HEALTH_ERROR_WINDOW_MS; (4) dedupe
 * per key inside
 * HEALTH_DEDUPE_WINDOW_MS (persisted to health-alerts-state.json so the ≤1
 * alert per key per 30min invariant survives restarts); (5) resolve the live
 * host and alert it by bus for each NET-NEW anomaly; (6) append one audit row
 * per alert. The W8-c per-safeguard knobs are read from `config.health`
 * (default-on): `turnErrorCaptureEnabled`, `staleLiveWatchdogEnabled` +
 * `staleLiveMinutes`, `presetAuditEnabled` — and the M1 watchdog knobs
 * (`poolerCapacityEnabled` + the pooler thresholds / `qiSilenceEnabled` +
 * `qiSilenceWindowMinutes` + `qiSilenceMinRetiresInWindow`) + the M4 knob
 * (`systemIdleEnabled` + `idleWindowMs`) + the M-A knob
 * (`contextThresholdEnabled` + `contextThreshold` + `contextThresholdPollMs`).
 * NEVER throws
 * (every internal
 * failure is a warn). If no host is registered the anomaly is NOT deduped (it
 * retries — a real deployment without a reachable host must not silently
 * forget an alert). */
export async function runHealthDaemonTick(deps: HealthDaemonDeps): Promise<void> {
  try {
    const nowMs = deps.now()
    // LATENT BUG (Bug A/the single-use-iterator seam): `deps.hosts` is a
    // SINGLE-USE iterable (HostMap.values() in production) consumed by
    // pickLiveHostEntry in the ALERT path AND the CONDITIONAL-WAKE path. On a
    // tick where BOTH run, the WAIT path read an exhausted iterator → live =
    // undefined → the system-wait wake was silently dropped. Materialize it ONCE
    // and reuse the SAME array for BOTH picks AND the Bug A retired-host set.
    const hostList = [...(deps.hosts ?? [])]
    // HEALTH ALERT RECIPIENT (the durable file is the truthful rotation record):
    // the alert recipient MUST be resolved DURABLE-FIRST from hosts.json, NOT the
    // in-memory `hostList`. `hostList` is a boot-loaded IN-MEMORY registry; in a
    // LONG-LIVED/twin daemon that booted BEFORE a rotation it is STALE — it
    // still lists the retired host as live and has no knowledge of the rotation
    // successor (pickLiveHostEntry's `retired` skip is correct, but it never sees
    // the new `retired` marker). Re-read hosts.json FRESH each tick and prefer
    // its entries (falling back to `hostList` only when the durable file is
    // unreadable/empty). This makes the ALERT + CONDITIONAL-WAIT paths address
    // the CURRENT non-retired host (the rotation successor) robustly.
    const durableHostEntries = readDurableHostEntries(deps.stateDir)
    const pickLiveHost = () =>
      durableHostEntries !== undefined && durableHostEntries.length > 0 ? pickLiveHostEntry(durableHostEntries) : pickLiveHostEntry(hostList)
    // Bug A (defense-in-depth): the set of RETIRED host ids, threaded into the
    // post-error scan so a legacy post-error row for a retired host on disk is
    // never a finding/alert (a retired host is terminal — W7 philosophy). The
    // in-memory `hostList` is a boot-time registry and may be STALE in a long-lived
    // process that booted BEFORE a rotation (a second daemon twin sharing the
    // stateDir) — so ALSO re-read the DURABLE hosts.json fresh each tick and merge
    // its retired ids. The durable file is authoritative; a stale in-memory
    // registry must not let a terminal host's rows re-alert. Never throws (a
    // read/parse failure degrades to the in-memory set only).
    const retiredHostIds = new Set<string>(hostList.filter((entry) => entry.retired === true).map((entry) => entry.hostId))
    const durableRetiredHostIds = readDurableRetiredHostIds(deps.stateDir)
    if (durableRetiredHostIds !== undefined) {
      for (const hostId of durableRetiredHostIds) retiredHostIds.add(hostId)
    }
    // W8-d PART B — a COARSER per-minute gate for the conditional system-wait:
    // read the PREVIOUS tick's minute marker BEFORE overwriting the heartbeat,
    // so the WAIT condition is evaluated at most ONCE per minute even when
    // `health.intervalMs` is faster (e.g. 10s) — a sub-minute re-fire skips the
    // scan (the 30-min dedupe ledger, shared with the W6 alert path, already
    // prevents a re-wake; this just avoids a redundant scan).
    const prevTick = readHealthHeartbeatFile(deps.stateDir)
    const currentMinute = Math.floor(nowMs / 60_000)
    const prevMinute = prevTick !== undefined ? Math.floor(prevTick.ts / 60_000) : undefined
    // fb-30 — the BOOT marker: the FIRST tick of a NEW daemon process. The
    // on-disk heartbeat precedes the current boot (written by a PREVIOUS boot
    // — a crash-restart leaves it behind) or is absent (a cold start); its
    // bootId is the SAME per-process id the fb-43 restart-registry reconcile
    // REUSES — never duplicated. The CATCH-UP pass runs ONLY here (a re-tick
    // of the same boot never re-runs it; the shared-ledger dedupe blocks a
    // re-alert across boots).
    const isBootTick = prevTick === undefined || (prevTick.bootId ?? '') !== deps.bootId
    // 1. heartbeat (always — even with no anomalies).
    await writeHealthHeartbeatFile(deps.stateDir, { ts: nowMs, bootId: deps.bootId })
    // fb-43 — the restart-registry reconcile (right after the heartbeat — the
    // boot-identity bookkeeping): seed-once-if-absent (the 4 documented
    // historical restarts) + append `{ bootId, ts, cause:'unknown' }` when the
    // current bootId is a NEW boot (the last row's bootId differs — the bootId
    // is the SAME per-process id the heartbeat stamps above; REUSED, never
    // duplicated). Idempotent per boot; never throws.
    try {
      await reconcileRestartRegistry(deps.stateDir, deps.bootId, nowMs)
    } catch (error: unknown) {
      deps.logger?.warn(`[deepartments] system-health: restart-registry reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // W8-c per-safeguard knobs (default-on).
    const health = deps.config?.health
    const turnErrorCaptureEnabled = health?.turnErrorCaptureEnabled !== false
    // LANE 2 (fb-27) — the turn/end-error HEAD-NOTIFICATION gate (default ON;
    // an explicit false disables; INDEPENDENT of the capture gate).
    const turnEndErrorNotifyEnabled = health?.turnEndErrorNotifyEnabled !== false
    const staleLiveWatchdogEnabled = health?.staleLiveWatchdogEnabled !== false
    const presetAuditEnabled = health?.presetAuditEnabled !== false
    const staleLiveMinutes =
      typeof health?.staleLiveMinutes === 'number' && Number.isFinite(health.staleLiveMinutes) && health.staleLiveMinutes > 0
        ? health.staleLiveMinutes
        : STALE_LIVE_DEFAULT_MINUTES
    // M1 — the pooler-capacity + qi-silence watchdog knobs (default-on gates;
    // numeric knobs fall back to the code defaults when absent/invalid — the
    // staleLiveMinutes pattern).
    const poolerCapacityEnabled = health?.poolerCapacityEnabled !== false
    const qiSilenceEnabled = health?.qiSilenceEnabled !== false
    const poolerKnobs: PoolerCapacityKnobs = {
      warningUsableKeys: resolvePositiveKnob(health?.warningUsableKeys, POOLER_CAPACITY_DEFAULT_WARNING_USABLE_KEYS),
      criticalUsableKeys: resolvePositiveKnob(health?.criticalUsableKeys, POOLER_CAPACITY_DEFAULT_CRITICAL_USABLE_KEYS),
      blockedKeysInWindow: resolvePositiveKnob(health?.blockedKeysInWindow, POOLER_CAPACITY_DEFAULT_BLOCKED_KEYS_IN_WINDOW),
      highPercent: resolvePositiveKnob(health?.highPercent, POOLER_CAPACITY_DEFAULT_HIGH_PERCENT),
      stateStaleMs: resolvePositiveKnob(health?.stateStaleMs, POOLER_CAPACITY_DEFAULT_STATE_STALE_MS)
    }
    const qiWindowMs =
      typeof health?.qiSilenceWindowMinutes === 'number' && Number.isFinite(health.qiSilenceWindowMinutes) && health.qiSilenceWindowMinutes > 0
        ? health.qiSilenceWindowMinutes * 60_000
        : QI_SILENCE_DEFAULT_WINDOW_MS
    const qiDirectiveRate =
      typeof deps.qiDirectiveRate === 'number' && Number.isFinite(deps.qiDirectiveRate) && deps.qiDirectiveRate >= 0 && deps.qiDirectiveRate <= 1
        ? deps.qiDirectiveRate
        : QI_SILENCE_DEFAULT_DIRECTIVE_RATE
    // The rate-aware minimum (the owner's decision): P(0 directives | p) ≤ 5% →
    // ceil(ln(0.05)/ln(1-p)) — p=0.25 → 11 (a single silent retirement at the
    // 25% dice is the EXPECTED 75% case), p=1 → 1, p≤0 → never. An explicit
    // `qiSilenceMinRetiresInWindow` knob overrides the formula.
    const qiMinRetires =
      typeof health?.qiSilenceMinRetiresInWindow === 'number' && Number.isFinite(health.qiSilenceMinRetiresInWindow) && health.qiSilenceMinRetiresInWindow >= 1
        ? Math.floor(health.qiSilenceMinRetiresInWindow)
        : qiSilenceMinRetiresForRate(qiDirectiveRate, QI_SILENCE_DEFAULT_FALSE_POSITIVE_TOLERANCE)
    // M4 — the system-idle watchdog knobs: `systemIdleEnabled` gate (default
    // ON) + `idleWindowMs` (the global-quiet window; absent/invalid → the
    // 15-min code default via the shared resolvePositiveKnob pattern).
    const systemIdleEnabled = health?.systemIdleEnabled !== false
    const systemIdleWindowMs = resolvePositiveKnob(health?.idleWindowMs, SYSTEM_IDLE_DEFAULT_WINDOW_MS)
    // M-A — the context-threshold watchdog knobs: `contextThresholdEnabled`
    // gate (default ON) + `contextThreshold` (the window-usage fraction that
    // alerts; absent/invalid → the 0.5 code default — an explicit knob always
    // wins, a broken one never throws) + `contextThresholdPollMs` (the scan
    // cadence; absent/invalid → the 60 s code default via resolvePositiveKnob).
    // The per-poll BUCKET gate derives from the pre-overwrite heartbeat (read
    // above): currentContextBucket = floor(nowMs/pollMs),
    // prevContextBucket = floor(prevTick.ts/pollMs) — the scan runs only when
    // they DIFFER (the FIRST tick of a bucket; prevTick undefined → runs).
    const contextThresholdEnabled = health?.contextThresholdEnabled !== false
    const contextThreshold =
      typeof health?.contextThreshold === 'number' && Number.isFinite(health.contextThreshold) && health.contextThreshold > 0 && health.contextThreshold < 1
        ? health.contextThreshold
        : CONTEXT_THRESHOLD_DEFAULT
    const contextThresholdPollMs = resolvePositiveKnob(health?.contextThresholdPollMs, CONTEXT_THRESHOLD_DEFAULT_POLL_MS)
    // M-5 — the mission-stalled watchdog knobs: `missionStallEnabled` gate
    // (default ON) + `missionStallMs` (the delivered-but-unstarted window;
    // absent/invalid → the 10-min code default via resolvePositiveKnob). The
    // quiet window is ABSOLUTE from the mission's DELIVERY ts (a per-row
    // fact — no epoch ledger needed, unlike M4's firstQuietTs).
    const missionStallEnabled = health?.missionStallEnabled !== false
    const missionStallMs = resolvePositiveKnob(health?.missionStallMs, MISSION_STALL_DEFAULT_MS)
    // M-6 — the main-red watchdog knobs: `mainRedEnabled` gate (default ON) +
    // `mainRedPollMs` (the light HEAD poll cadence; absent/invalid → the 5-min
    // code default via resolvePositiveKnob) + `mainRedLocks` (the fast-lock
    // paths; an explicit non-empty array overrides the 8-lock default — a
    // broken/empty array → the default, never a throw).
    const mainRedEnabled = health?.mainRedEnabled !== false
    const mainRedPollMs = resolvePositiveKnob(health?.mainRedPollMs, MAIN_RED_DEFAULT_POLL_MS)
    const mainRedLocks =
      Array.isArray(health?.mainRedLocks) && health.mainRedLocks.every((p) => typeof p === 'string' && p !== '')
        ? health.mainRedLocks
        : MAIN_RED_DEFAULT_LOCKS
    // M-7 — the mission-queue watchdog knobs: `missionQueueEnabled` gate
    // (default ON) + `missionQueueLimit` (the pendingCount threshold; absent/
    // invalid → the 5 code default via resolvePositiveKnob) +
    // `missionQueuePersistMs` (the anti-transient persistence window; absent/
    // invalid → the 60000 one-poll-tick code default via resolvePositiveKnob).
    const missionQueueEnabled = health?.missionQueueEnabled !== false
    const missionQueueLimit = resolvePositiveKnob(health?.missionQueueLimit, MISSION_QUEUE_DEFAULT_LIMIT)
    const missionQueuePersistMs = resolvePositiveKnob(health?.missionQueuePersistMs, MISSION_QUEUE_DEFAULT_PERSIST_MS)
    // fb-30 — the BOOT CATCH-UP knobs: `catchupEnabled` gate (default ON; an
    // explicit false restores the pre-fb-30 daemon — a boot never re-scans the
    // old durable windows) + `catchupWindowMs` (the bounded look-back; absent/
    // invalid → the 24 h code default via resolvePositiveKnob).
    const catchupEnabled = health?.catchupEnabled !== false
    const catchupWindowMs = resolvePositiveKnob(health?.catchupWindowMs, HEALTH_CATCHUP_WINDOW_MS)
    // LANE 5 (fb-46) — the work-register-idle watchdog knobs:
    // `workRegisterIdleEnabled` gate (default ON) + `workRegisterIdleQuietMs`
    // (the VALLE-quiet window; absent/invalid → the 15-min code default via
    // resolvePositiveKnob).
    const workRegisterIdleEnabled = health?.workRegisterIdleEnabled !== false
    const workRegisterIdleQuietMs = resolvePositiveKnob(health?.workRegisterIdleQuietMs, WORK_REGISTER_IDLE_DEFAULT_QUIET_MS)
    // The per-poll BUCKET gate (the M-A per-poll precedent): the main-red scan
    // runs at most once per `mainRedPollMs` bucket — the FIRST tick of a bucket
    // (prevTick undefined → runs); a faster `health.intervalMs` re-fire inside
    // the SAME bucket skips the scan.
    const currentMainRedBucket = Math.floor(nowMs / mainRedPollMs)
    const prevMainRedBucket = prevTick !== undefined ? Math.floor(prevTick.ts / mainRedPollMs) : undefined
    const currentContextBucket = Math.floor(nowMs / contextThresholdPollMs)
    const prevContextBucket = prevTick !== undefined ? Math.floor(prevTick.ts / contextThresholdPollMs) : undefined
    const posts = [...(deps.posts ?? [])]
    // Bug (delivery-failed re-alert loop): the set of RETIRED member ids — the
    // union of the retired HOST ids (already computed above) and the RETIRED
    // POST ids from the catalog — is threaded into the delivery-failed scan so a
    // `failed` row for a retired recipient (e.g. m-570 → builder-82) is never a
    // finding/alert. A retired member is terminal (W7 philosophy) and its rows
    // must not re-alert the live host every ~30 min until the next boot lets the
    // redeliver driver settle them to 'terminal'.
    const retiredMemberIds = new Set<string>([...retiredHostIds, ...posts.filter((p) => p.retired === true).map((p) => p.postId)])
    // 2. W8-c PART 1 — turn-failure capture: a fresh turn/end ERROR reason in a
    // live post's session event log is recorded into post-errors.jsonl (deduped
    // via turn-errors-state.json so a turn is never double-counted) so the
    // post-error scan below ALERTS the host. Never throws.
    if (turnErrorCaptureEnabled) {
      try {
        const captureState = readTurnErrorsState(deps.stateDir)
        let changed = false
        for (const post of posts) {
          if (post.retired === true) continue
          const capture = scanTurnErrorCaptures(post.events ?? [], post.postId, post.sessionId)
          if (capture === undefined) continue
          // A turn already captured (and still fresh) is not re-recorded.
          const lastCaptured = captureState[capture.key]
          if (lastCaptured !== undefined && nowMs - lastCaptured < TURN_ERROR_FRESH_WINDOW_MS) continue
          // Only a FRESH error (<= the turn-error window) is recorded now.
          if (nowMs - capture.ts > TURN_ERROR_FRESH_WINDOW_MS) continue
          // fb-25 (b): the row carries the SESSION PROVENANCE (sessionId+turn
          // when the capture knew them) so the alert names the ARCHIVED session,
          // never the fresh one — additive (R6: a capture without provenance
          // writes the legacy {ts,postId,error} row).
          await appendPostError(deps.stateDir, {
            ts: capture.ts,
            postId: capture.postId,
            error: capture.error,
            ...(capture.sessionId !== undefined ? { sessionId: capture.sessionId } : {}),
            ...(capture.turn !== undefined ? { turn: capture.turn } : {})
          }, nowMs)
          captureState[capture.key] = nowMs
          changed = true
        }
        // fb-30 CATCH-UP (BOOT only) — the WIDENED turn-error capture: a
        // turn/end error that happened DURING a capture gap (OLDER than the
        // 10-min freshness window, WITHIN the bounded look-back) was NEVER
        // recorded by the live capture above (the §3b mechanism-1 blind spot:
        // an error observed late is treated as stale). At boot ONLY the
        // freshness bound is widened to the catch-up window so the error is
        // recorded into post-errors.jsonl — the SAME appendPostError, whose C9
        // discard ARCHIVES the old row into post-errors-archive.jsonl (the
        // durable evidence home scanHealthCatchup reads) — and then grouped by
        // the post-error catch-up scan of the SAME tick. The turn-errors-state
        // dedupe (the key embeds the turn ts) prevents a re-record across
        // boots; a fresh turn the live capture recorded THIS tick is skipped
        // (lastCaptured within the window). Runs only when the capture gate is
        // ON (consistent with the live capture) + the catch-up gate is ON +
        // this is a boot tick.
        if (catchupEnabled && isBootTick) {
          for (const post of posts) {
            if (post.retired === true) continue
            const capture = scanTurnErrorCaptures(post.events ?? [], post.postId, post.sessionId)
            if (capture === undefined) continue
            // Only a BOUNDED-old error (within the look-back) is caught up.
            if (nowMs - capture.ts > catchupWindowMs) continue
            const lastCaptured = captureState[capture.key]
            if (lastCaptured !== undefined && nowMs - lastCaptured < catchupWindowMs) continue
            await appendPostError(deps.stateDir, {
              ts: capture.ts,
              postId: capture.postId,
              error: capture.error,
              ...(capture.sessionId !== undefined ? { sessionId: capture.sessionId } : {}),
              ...(capture.turn !== undefined ? { turn: capture.turn } : {})
            }, nowMs)
            captureState[capture.key] = nowMs
            changed = true
          }
        }
        if (changed) await writeTurnErrorsState(deps.stateDir, captureState)
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] system-health: turn-error capture failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // LANE 2 (fb-27) — TURN/END-ERROR HEAD NOTIFICATION: a FRESH turn/end
    // ERROR in a live post's session event log is notified to the POST'S OWN
    // HEAD (via the `notifyHead` dep — the bundle's `healthNotifyHead` closure:
    // store.append + busDeliverToPost, the daemon→head pattern; NEVER
    // `deliverDaemonNotice` — that respects sleepEpoch='queued' and belongs to
    // the scheduler/parallel paths). Deduped via its OWN ledger
    // `turn-end-notify-state.json` keyed `postId:turn` — INDEPENDENT of the
    // capture ledger, so a head is alarmed even when `turnErrorCaptureEnabled`
    // is off. Only a capture with BOTH sessionId AND turn is notified (fb-25
    // mandatory provenance); the `notifyHead` dep ABSENT → conservative no-op;
    // the gate off → nothing. NEVER throws.
    if (turnEndErrorNotifyEnabled && deps.notifyHead !== undefined) {
      try {
        const notifyState = readTurnEndNotifyState(deps.stateDir)
        let changed = false
        for (const post of posts) {
          if (post.retired === true) continue
          const capture = scanTurnErrorCaptures(post.events ?? [], post.postId, post.sessionId)
          if (capture === undefined) continue
          // Only a capture with BOTH sessionId AND turn is notified (fb-25).
          if (capture.sessionId === undefined || capture.turn === undefined) continue
          const cls = turnErrorNotifyClass(capture.error)
          if (cls === undefined) continue
          // A post+turn already notified (and still fresh) is not re-notified.
          const lastNotified = notifyState[`${capture.postId}:${capture.turn}`]
          if (lastNotified !== undefined && nowMs - lastNotified < TURN_ERROR_FRESH_WINDOW_MS) continue
          // Only a FRESH error (<= the turn-error window) is notified now.
          if (nowMs - capture.ts > TURN_ERROR_FRESH_WINDOW_MS) continue
          const frame = buildTurnErrorNotifyFrame(capture, cls)
          await deps.notifyHead(capture.postId, frame)
          notifyState[`${capture.postId}:${capture.turn}`] = nowMs
          changed = true
        }
        if (changed) await writeTurnEndNotifyState(deps.stateDir, notifyState)
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] system-health: turn-end head-notify failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // M1 (b) — the qi-silence watchdog: maintain the retirement ledger
    // (firstSeen per retired+worker post; pruned by the scan) and find a
    // silence once retirements in the window pass the rate-aware minimum with
    // ZERO emitted directives. The ledger is persisted ONLY when it changed
    // (the turn-errors pattern); it never relies on the shared health-alerts
    // ledger (whose defensive 2h prune would drop its entries).
    let qiFindings: HealthFinding[] = []
    if (qiSilenceEnabled) {
      try {
        const qiLedger = readQiSilenceState(deps.stateDir)
        const qiScan = scanQiSilence({
          posts,
          stateDir: deps.stateDir,
          nowMs,
          windowMs: qiWindowMs,
          minRetires: qiMinRetires,
          rate: qiDirectiveRate,
          ledger: qiLedger
        })
        qiFindings = qiScan.findings
        if (qiScan.changed) await writeQiSilenceState(deps.stateDir, qiScan.ledger)
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] system-health: qi-silence scan failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // M1 (a) — the pooler-capacity watchdog: READS the pooler's own
    // keyPooler-state.json (path injected by the wiring; absent dep → no-op).
    const poolerFindings = poolerCapacityEnabled && deps.poolerStatePath !== undefined
      ? scanPoolerCapacity(deps.poolerStatePath, nowMs, poolerKnobs, deps.logger)
      : []
    // M4 — the system-idle watchdog (the GLOBAL-quiet scan). Gate: enabled AND
    // `deps.hostRunning` RESOLVED (the bundle computes it from the live agents
    // registry; ABSENT → the scan is a NO-OP — without the host's liveness the
    // zero-running premise cannot be certified and the watchdog never
    // fabricates an alert; the poolerStatePath-absent pattern). Its own ledger
    // system-idle-state.json (firstQuietTs) persists ONLY on change; the
    // shared health-alerts ledger never holds the quiet window (its 2h prune
    // would drop it). Expected quiet (window done, NO pending work) → a warn,
    // no finding, no dedupe — the mission's warn-only contract.
    let systemIdleFindings: HealthFinding[] = []
    if (systemIdleEnabled && deps.hostRunning !== undefined) {
      try {
        const idleLedger = readSystemIdleState(deps.stateDir)
        const idleScan = scanSystemIdle({
          posts,
          hostRunning: deps.hostRunning,
          nowMs,
          idleWindowMs: systemIdleWindowMs,
          ledger: idleLedger
        })
        systemIdleFindings = idleScan.findings
        if (idleScan.changed) await writeSystemIdleState(deps.stateDir, idleScan.ledger)
        if (idleScan.quietWithoutPending) {
          const minutes = Math.round(systemIdleWindowMs / 60000)
          deps.logger?.warn(`[deepartments] system-health: system idle ${minutes} min with zero pending work — expected quiet, no alert`)
        }
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] system-health: system-idle scan failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // M-A — the context-threshold watchdog (the context-pressure monitor).
    // Gate: enabled AND `deps.sessionContexts` RESOLVED (the bundle builds the
    // rows from the in-process `ctx.sessionProjections` token-meter projection;
    // ABSENT → the scan is a NO-OP — unknown context pressure never fabricates
    // an alert; the hostRunning/poolerStatePath-absent pattern) AND the
    // per-poll bucket turned (the WAIT per-minute precedent generalized: the
    // FIRST tick of a `contextThresholdPollMs` bucket runs the scan, a re-fire
    // inside the SAME bucket skips it). Zero I/O (the projections are
    // materialized in-process); the findings join the shared array — kinds/keys
    // DISJOINT from system-idle/qi-silence/pooler-capacity
    // (`context-threshold:<agentId>:b<band>`), so the same tick composes them
    // without collision; the shared 30-min dedupe gives the re-alert cadence
    // per band, no ledger of its own.
    let contextFindings: HealthFinding[] = []
    if (contextThresholdEnabled && deps.sessionContexts !== undefined && currentContextBucket !== prevContextBucket) {
      try {
        contextFindings = scanContextThreshold({ rows: [...(deps.sessionContexts ?? [])], threshold: contextThreshold, nowMs })
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] system-health: context-threshold scan failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // M-5 — the mission-stalled watchdog (the delivered-but-unstarted-mission
    // scan). Gate: enabled AND `deps.missionActivity` RESOLVED (the bundle
    // builds the rows from the message store + the catalog + the session
    // activity primitive; ABSENT → the scan is a NO-OP — a wiring that cannot
    // resolve the mission-delivery seam never fabricates a stalled-mission
    // alert; the hostRunning/sessionContexts-absent pattern). The quiet window
    // is ABSOLUTE from each mission's DELIVERY ts → NO ledger of its own; the
    // SHARED health-alerts ledger (per-mission keys `mission-stall:<postId>:
    // <messageId>`) gives the 30-min re-alert cadence while the mission
    // persists. Zero new I/O (the rows are materialized by the bundle).
    let missionFindings: HealthFinding[] = []
    if (missionStallEnabled && deps.missionActivity !== undefined) {
      try {
        missionFindings = scanMissionStalled({ rows: [...(deps.missionActivity)], stallMs: missionStallMs, nowMs })
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] system-health: mission-stalled scan failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // M-6 — the main-red watchdog (the post-commit re-verification scan). Gate:
    // enabled AND `deps.mainRed` RESOLVED (the bundle's buildMainRedState over
    // repoRoot; ABSENT → the scan is a NO-OP — a wiring without the repo/git
    // seam never fabricates a post-commit alert; the hostRunning/sessionContexts
    // -absent pattern) AND the per-poll bucket turned (the FIRST tick of a
    // `mainRedPollMs` bucket; a re-fire inside the SAME bucket skips it). The
    // I/O (git HEAD + node --test per lock) lives in `deps.mainRed`, OUTSIDE
    // the pure scan: the tick materializes { headSha, lastSeenSha, firstSeenMs,
    // lockResults } and runs the locks ONLY on a NEW sha (1 ejecución por sha
    // nuevo); the first run is a BASELINE (never alerts at boot). Its own
    // durable state main-red-state.json (lastSeenSha + firstSeenMs + redLocks)
    // persists ONLY on change (the turn-errors pattern); the SHARED
    // health-alerts ledger never holds the red window (its 2h prune would drop
    // a long one). The 30-min RE-ALERT cadence comes from the SHARED dedupe
    // key `main-red:<sha>` while the broken commit stays at HEAD.
    let mainRedFindings: HealthFinding[] = []
    if (mainRedEnabled && deps.mainRed !== undefined && currentMainRedBucket !== prevMainRedBucket) {
      try {
        const mainRedState = readMainRedState(deps.stateDir)
        const headSha = deps.mainRed.readHeadSha()
        if (headSha !== undefined) {
          // The fast locks run ONLY when HEAD moved to a NEW sha (never on the
          // first run — baseline; never re-run for the same sha — 1 ejecución
          // por sha nuevo). A same-sha / first-run tick passes NO results.
          const isNewSha = mainRedState.lastSeenSha !== undefined && headSha !== mainRedState.lastSeenSha
          const lockResults = isNewSha ? await deps.mainRed.runLocks(mainRedLocks) : []
          const mainRedScan = scanMainRed({
            headSha,
            lastSeenSha: mainRedState.lastSeenSha,
            firstSeenMs: mainRedState.firstSeenMs,
            redLocks: mainRedState.redLocks,
            lockResults: lockResults as readonly MainRedLockResult[],
            nowMs
          })
          mainRedFindings = mainRedScan.findings
          if (mainRedScan.changed) await writeMainRedState(deps.stateDir, mainRedScan.state)
        }
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] system-health: main-red scan failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // M-7 — the mission-queue watchdog (the head mission-backlog scan). Gate:
    // enabled AND `deps.missionQueue` RESOLVED (the bundle builds the rows
    // from the EXISTING buildHealthPosts output, filtered to non-retired
    // HEADS — the SAME catalog source the W8-c safeguards consume, materialized
    // ONCE; ABSENT → the scan is a NO-OP — a wiring that cannot resolve the
    // per-head queue never fabricates a backlog alert; the
    // missionActivity/hostRunning-absent pattern). Its OWN ledger
    // mission-queue-state.json (firstSeen per sustained over-limit queue)
    // persists ONLY on change (the system-idle pattern); the SHARED
    // health-alerts ledger (per-post keys `mission-queue:<postId>`) gives the
    // 30-min re-alert cadence while the backlog persists. Zero new I/O (the
    // rows are materialized by the bundle). The anti-transient persistence
    // window (a spike shorter than `missionQueuePersistMs` never alerts) is
    // the M4 firstQuietTs sustained-condition precedent.
    let missionQueueFindings: HealthFinding[] = []
    if (missionQueueEnabled && deps.missionQueue !== undefined) {
      try {
        const mqLedger = readMissionQueueState(deps.stateDir)
        const mqScan = scanMissionQueue({
          rows: [...(deps.missionQueue ?? [])],
          limit: missionQueueLimit,
          persistMs: missionQueuePersistMs,
          nowMs,
          ledger: mqLedger
        })
        missionQueueFindings = mqScan.findings
        if (mqScan.changed) await writeMissionQueueState(deps.stateDir, mqScan.ledger)
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] system-health: mission-queue scan failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // LANE 5 (fb-46) — the work-register-idle watchdog (the docs-level
    // WORK-REGISTER stall scan). Gate: enabled AND `deps.workRegisterPath`
    // RESOLVED (the bundle injects it — docs/WORK-REGISTER.md; ABSENT → the
    // scan is a NO-OP: a wiring without the register seam never fabricates a
    // register-stall alert; the poolerStatePath-absent pattern) AND
    // `deps.hostRunning` RESOLVED (the M4 pattern: without the host's liveness
    // the zero-running premise cannot be certified). Its OWN ledger
    // work-register-idle-state.json (firstQuietTs) persists ONLY on change;
    // the SHARED health-alerts ledger (key `work-register-idle`) gives the
    // 30-min re-alert cadence while the condition persists. Expected quiet
    // (window done, NO NON-gated pending — a §3-only register or an empty one)
    // → a warn, no finding, no dedupe.
    let workRegisterIdleFindings: HealthFinding[] = []
    if (workRegisterIdleEnabled && deps.workRegisterPath !== undefined && deps.hostRunning !== undefined) {
      try {
        // The franja VALLE leg REUSES the dshd-core pacing (isPeakAt == false
        // — the same window the transition monitor uses).
        const pacingWindow = pacingWindowFromConfig(deps.config?.org?.pacing)
        const valley = !isPeakAt(new Date(nowMs), pacingWindow)
        // The register is read SOLO-LECTURA (best-effort — the watchdog NEVER
        // writes it; an unreadable/absent register degrades to '' → the census
        // legs fail → conservative no-op).
        let registerText = ''
        try {
          registerText = readFileSync(deps.workRegisterPath, 'utf8')
        } catch {
          registerText = ''
        }
        const wrLedger = readWorkRegisterIdleState(deps.stateDir)
        const wrScan = scanWorkRegisterIdle({
          registerText,
          valley,
          hostRunning: deps.hostRunning,
          posts,
          nowMs,
          quietWindowMs: workRegisterIdleQuietMs,
          ledger: wrLedger
        })
        workRegisterIdleFindings = wrScan.findings
        if (wrScan.changed) await writeWorkRegisterIdleState(deps.stateDir, wrScan.ledger)
        if (wrScan.quietWithoutPending) {
          const minutes = Math.round(workRegisterIdleQuietMs / 60000)
          deps.logger?.warn(`[deepartments] system-health: work-register idle ${minutes} min in VALLE with zero NON-gated pending items — expected quiet (or owner-gated §3 only), no alert`)
        }
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] system-health: work-register-idle scan failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // 3. scan.
    const findings = [
      ...scanPostErrorFindings(deps.stateDir, nowMs, retiredHostIds),
      ...scanDeliveryFindings(deps.stateDir, nowMs, retiredMemberIds, deps.deliveryRowsReader),
      // fb-30 CATCH-UP (BOOT only): the bounded pass over the DURABLE event
      // ledgers — rows OUTSIDE the live 2 h window, WITHIN the look-back, that
      // were never alerted (the quiet-band blind spots) — the findings ride
      // the EXISTING dedupe/alert/audit path below with their LIVE identity
      // keys (the shared ledger never duplicates a live alert, never re-alerts
      // an already-alerted identity); the `catchup: true` marker renders their
      // own CATCH-UP frame bullet. The widened boot capture above recorded any
      // gap turn-error FIRST, so its archived row is grouped here.
      ...(catchupEnabled && isBootTick ? scanHealthCatchup(deps.stateDir, nowMs, catchupWindowMs, retiredHostIds, retiredMemberIds) : []),
      ...(presetAuditEnabled ? scanConfigPresetFindings(deps.stateDir, nowMs) : []),
      ...(staleLiveWatchdogEnabled ? scanStalledPosts(posts, nowMs, staleLiveMinutes) : []),
      ...poolerFindings,
      ...qiFindings,
      ...systemIdleFindings,
      ...contextFindings,
      ...missionFindings,
      ...missionQueueFindings,
      ...workRegisterIdleFindings,
      ...mainRedFindings
    ]
    // W8-d PART B/C — the system-heartbeat knobs: `heartbeatEnabled` (default
    // on) gates the CONDITIONAL-WAKE path; `waitThresholdMs` is resolved with
    // the 30min code default when absent/invalid (see `resolveSystemWaitMs`).
    const heartbeatEnabled = health?.heartbeatEnabled !== false
    const waitThresholdMs = resolveSystemWaitMs(health)
    // Per-minute gate: only evaluate the WAIT condition ONCE per minute (a tick
    // that re-fires within the same minute — `intervalMs < 60s` — is skipped).
    const hostWaits = heartbeatEnabled && currentMinute !== prevMinute ? [...(deps.hostWaits ?? [])] : []
    // Read the dedupe ledger ONCE; the ALERT path + the CONDITIONAL-WAKE path
    // SHARE it (a key advanced by either is never re-emitted inside the window).
    const state = readHealthAlertsState(deps.stateDir)
    const nextState = { ...state }
    let stateChanged = false
    // 4. ALERT path (W6/W8-c): group the net-new findings and alert the LIVE host
    // by a single `System-health ALERT:` bus frame; advance the ledger + audit.
    // Bug C — ERROR-IDENTITY alert-eligibility: a post-error finding alerts ONLY
    // when its error identity was NEVER delivered (the SAME (postId,error)
    // stream is delivered ONCE and NEVER re-alerts inside the window — no
    // per-window re-fire, the Bug C re-alert loop). The identity is stored in
    // the SAME shared health-alerts-state.json ledger (key → lastAlertedAtMs).
    // M3 (stable-class identity, spec §2.4): for a post-error finding the
    // identity is `post-error:<postId>:<class>` when the error has a STABLE
    // class (postErrorClass non-undefined — e.g. `session-not-found`), and ONLY
    // falls back to the raw-text hash `post-error:<postId>:<errorIdentityHash>`
    // when the error has NO stable class. This aligns the alert identity with the
    // ALREADY-classed scan grouping (scanPostErrorFindings) so a recurring
    // identical-class error whose text embeds a per-attempt variable (a rotating
    // session id, a 429 token-count) is a ONE-SHOT alert regardless of text
    // instability — the ROOT of the 1h host-stuck interrupt loop. For
    // delivery-failed / stalled / config-preset findings the identity IS the
    // existing finding key and the legacy per-key 30min window is preserved
    // (already identity-typed; do not regress).
    if (findings.length > 0) {
      const identityOf = (finding: HealthFinding): string => {
        if (finding.kind !== 'post-error') return finding.key
        const cls = postErrorClass(finding.error)
        return cls === undefined
          ? `post-error:${finding.postId}:${errorIdentityHash(finding.error ?? '')}`
          : `post-error:${finding.postId}:${cls}`
      }
      const findingsToAlert = findings.filter((finding) => {
        const identity = identityOf(finding)
        if (finding.kind === 'post-error') return nextState[identity] === undefined
        return nextState[identity] === undefined || nowMs - nextState[identity] > HEALTH_DEDUPE_WINDOW_MS
      })
      if (findingsToAlert.length > 0) {
        // 5. resolve the live host (the Asistente) DURABLE-FIRST (the on-disk
        // hosts.json rotation chain is the truthful recipient; a stale in-memory
        // registry in a long-lived/twin daemon must not address the retired
        // host). No host → warn + skip (the dedupe state is NOT advanced — the
        // alert retries once a host is live).
        const { live } = pickLiveHost()
        if (live === undefined) {
          deps.logger?.warn('[deepartments] system-health: anomalies detected but no live host to alert — skip (retries on the next tick)')
        } else {
          const alertFindings = findingsToAlert
          // 6. notify (never throw) + advance the dedupe ledger + audit.
          try {
            await deps.notifyHost(live, buildHealthAlertFrame(alertFindings))
          } catch (error: unknown) {
            deps.logger?.warn(`[deepartments] system-health: host alert delivery failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          for (const finding of findingsToAlert) {
            nextState[identityOf(finding)] = nowMs
            stateChanged = true
          }
          await appendHealthAlertAudit(deps.stateDir, { ts: nowMs, findings: alertFindings, dedupeKeys: [...new Set(findingsToAlert.map((f) => f.key))] })
        }
      }
    }
    // 5. CONDITIONAL WAKE path (W8-d PART B): NO scheduled hourly heartbeat
    // message. When `heartbeatEnabled`, evaluate the WAIT condition (a HOST-SENT
    // message to a post with NO reply AND NO session activity within
    // `waitThresholdMs`) and wake the HOST by a `[From deepartments]
    // system-wait: <reason>` bus message — ONCE per recipient+message per
    // HEALTH_DEDUPE_WINDOW_MS (the same health-alerts-state.json ledger, key
    // `wait:<postId>:<messageId>`). If nothing is waiting → NO wake, ZERO noise.
    // No live host → the ledger is NOT advanced (the wake retries once live).
    if (hostWaits.length > 0) {
      const waits = scanHostWaits(hostWaits, nowMs, waitThresholdMs)
      const waitsToWake = waits.filter((wait) => nextState[wait.key] === undefined || nowMs - nextState[wait.key] > HEALTH_DEDUPE_WINDOW_MS)
      if (waitsToWake.length > 0) {
        // LATENT BUG fix: reuse the materialized hostList (NOT the single-use
        // deps.hosts iterator — the ALERT path above already consumed it) via the
        // DURABLE-first pickLiveHost() pick (the rotation chain, not a stale
        // in-memory registry, chooses the wake recipient).
        const { live } = pickLiveHost()
        if (live === undefined) {
          deps.logger?.warn('[deepartments] system-health: system-wait condition but no live host to wake — skip (retries on the next tick)')
        } else {
          for (const wait of waitsToWake) {
            try {
              await deps.notifyHost(live, buildSystemWaitFrame(wait))
              nextState[wait.key] = nowMs
              stateChanged = true
            } catch (error: unknown) {
              deps.logger?.warn(`[deepartments] system-health: system-wait delivery failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
      }
    }
    // PACING — the peak/valley FRANJA transition monitor (owner m-PACING,
    // 2026-08-28): compute the CURRENT franja every tick (a pure UTC
    // check — the mini scan "cuando cambia"); on a CHANGE vs the durable
    // baseline, deliver EXACTLY ONE durable bus notice to the host (the
    // notifyHost seam — see the block comment above the helpers). First boot
    // records the baseline and emits NOTHING (documented); no live host →
    // skipped AND the baseline NOT advanced (retries — the no-perdible
    // contract); the emission dedupe key 'pacing-transition' rides the SHARED
    // health-alerts ledger (≤1 inside HEALTH_DEDUPE_WINDOW_MS — a crash that
    // loses the baseline write can never double-notify the same transition).
    if (deps.config?.org?.pacing?.enabled !== false) {
      try {
        const pacingWindow = pacingWindowFromConfig(deps.config?.org?.pacing)
        const franja: 'peak' | 'valle' = isPeakAt(new Date(nowMs), pacingWindow) ? 'peak' : 'valle'
        const prev = readPacingState(deps.stateDir)
        if (prev === undefined) {
          // FIRST BOOT: baseline only, no notice (documented decision — see
          // the block comment; the wake pack carries the current franja).
          await writePacingState(deps.stateDir, { franja, at: nowMs })
        } else if (prev.franja !== franja) {
          const lastEmitted = state[PACING_TRANSITION_KEY]
          const deduped = lastEmitted !== undefined && nowMs - lastEmitted <= HEALTH_DEDUPE_WINDOW_MS
          if (deduped) {
            // Already notified inside the 30-min window (e.g. a baseline write
            // lost to a crash): advance the baseline quietly — never re-send.
            await writePacingState(deps.stateDir, { franja, at: nowMs })
          } else {
            const { live } = pickLiveHost()
            if (live === undefined) {
              deps.logger?.warn('[deepartments] system-health: pacing transition detected but no live host to notify — skip (retries on the next tick)')
            } else {
              const pacingState = pacingStateAt(new Date(nowMs), pacingWindow)
              // The VALLE notice's N: the WORK-REGISTER pending queue when
              // legible (best-effort; unreadable → the count is omitted).
              let deferredCount: number | undefined
              if (franja === 'valle' && deps.workRegisterPath !== undefined) {
                try {
                  deferredCount = countPendingWorkRegister(readFileSync(deps.workRegisterPath, 'utf8'))
                } catch {
                  deferredCount = undefined
                }
              }
              try {
                await deps.notifyHost(live, buildPacingTransitionFrame(pacingState, deferredCount))
                nextState[PACING_TRANSITION_KEY] = nowMs
                stateChanged = true
                await writePacingState(deps.stateDir, { franja, at: nowMs })
              } catch (error: unknown) {
                // The bundle notifyHost never throws (it catches internally);
                // a stub that does must NOT advance the baseline (retry).
                deps.logger?.warn(`[deepartments] system-health: pacing transition delivery failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          }
        }
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] system-health: pacing transition scan failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // CAPACITY GATE — the pooler capacity CRÍTICO transition monitor
    // (HARDENING-401 / fb-39, 2026-09-01 — MOLDE FRANJA PEAK). Every tick the
    // pool verdict derives from the SAME scan findings the M1 watchdog already
    // computed this tick (`poolerFindings`, over deps.poolerStatePath +
    // poolerKnobs): CRÍTICO when one is a `POOLER_CAPACITY_KEY_CRITICAL`
    // finding (the billing/credits class — even on STALE state the durable
    // billing flag still reads CRÍTICO, the 08-31 outage class; or the CERTAIN
    // usable=0 / 429-rotation prelude), OK otherwise (a healthy/quiet/stale-
    // UNKNOWN pool stays OK — the gate NEVER pauses on unknown). On a
    // TRANSITION (ok → critical | critical → ok) deliver EXACTLY ONE durable
    // bus notice to the host (never silent). First boot records the baseline,
    // emits NOTHING (the pacing first-boot precedent); no live host → skipped
    // AND the baseline NOT advanced (retry). Dedupe key 'capacity-gate' rides
    // the SHARED health-alerts ledger (≤1 inside HEALTH_DEDUPE_WINDOW_MS). It
    // runs ONLY when the pooler-capacity scan is enabled AND the state path is
    // injected (the poolerFindings-absent pattern). KNOB:
    // `health.poolerGateEnabled === false` → no-op (default ON).
    if (deps.config?.health?.poolerGateEnabled !== false && poolerCapacityEnabled && deps.poolerStatePath !== undefined) {
      try {
        const critical = poolerFindings.some((f) => f.key === POOLER_CAPACITY_KEY_CRITICAL)
        const verdict: 'critical' | 'ok' = critical ? 'critical' : 'ok'
        const detail = poolerFindings.find((f) => f.key === POOLER_CAPACITY_KEY_CRITICAL)?.error
        const prev = readCapacityGateState(deps.stateDir)
        if (prev === undefined) {
          // FIRST BOOT: baseline only, no notice (the pacing precedent).
          await writeCapacityGateState(deps.stateDir, { verdict, at: nowMs })
        } else if (prev.verdict !== verdict) {
          const dedupeKey = capacityGateDedupeKey(verdict)
          const lastEmitted = state[dedupeKey]
          const deduped = lastEmitted !== undefined && nowMs - lastEmitted <= HEALTH_DEDUPE_WINDOW_MS
          if (deduped) {
            // Already notified this direction inside the 30-min window (e.g. a
            // baseline write lost to a crash): advance the baseline quietly —
            // never re-send.
            await writeCapacityGateState(deps.stateDir, { verdict, at: nowMs })
          } else {
            const { live } = pickLiveHost()
            if (live === undefined) {
              deps.logger?.warn('[deepartments] system-health: capacity-gate transition detected but no live host to notify — skip (retries on the next tick)')
            } else {
              // The OK notice's N: the WORK-REGISTER pending queue when
              // legible (best-effort; unreadable → the count is omitted).
              let deferredCount: number | undefined
              if (verdict === 'ok' && deps.workRegisterPath !== undefined) {
                try {
                  deferredCount = countPendingWorkRegister(readFileSync(deps.workRegisterPath, 'utf8'))
                } catch {
                  deferredCount = undefined
                }
              }
              try {
                await deps.notifyHost(live, buildCapacityGateFrame(verdict, detail, deferredCount))
                nextState[dedupeKey] = nowMs
                stateChanged = true
                await writeCapacityGateState(deps.stateDir, { verdict, at: nowMs })
              } catch (error: unknown) {
                deps.logger?.warn(`[deepartments] system-health: capacity-gate transition delivery failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          }
        }
      } catch (error: unknown) {
        deps.logger?.warn(`[deepartments] system-health: capacity-gate transition scan failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Persist the merged ledger once if the ALERT, CONDITIONAL-WAKE or PACING
    // path advanced any key.
    if (stateChanged) {
      // Defensive 2h prune (Bug C): drop delivered-identity entries that aged out
      // of the anomaly window so the shared ledger never grows unbounded. Every
      // key's dedupe/re-arm window is <= HEALTH_DEDUPE_WINDOW_MS, so a >=2h-old
      // entry is already immune to the alert window (re-derivable at zero cost) —
      // pruning it is safe for the alert AND the W8-i recording keys it shares.
      for (const [k, v] of Object.entries(nextState)) {
        if (nowMs - v > HEALTH_ERROR_WINDOW_MS) delete nextState[k]
      }
      await writeHealthAlertsState(deps.stateDir, nextState)
    }
  } catch (error: unknown) {
    deps.logger?.warn(`[deepartments] system-health tick failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// P1 (MODULARIZACIÓN, 2026-08-29) — the dshd-health Cordis PLUGIN surface.
// Thin name/inject/apply (the dshd-core/dshd-webfetch pattern): the package
// now ALSO composes as a real plugin row (cordis.patch.yml) and provides
// `deepartments.health` — the system-health daemon TICK the bundle wires
// INLINE today (invoke.ts: the setInterval + the ONE per-daemon
// createDeliveryRowsTailReader + the notifyHost ALERT closure). The service is
// LAZY (the tick runs on FIRST service use, never at apply time — an apply is
// side-effect free); deps are INJECTED via the FASE 2.6 seam, never imported
// from the bundle:
//   - stateDir ← `ctx.get('deepartments.org')` (the SHARED CONFIG SOURCE),
//   - hosts ← `ctx.get('deepartments.catalog')` (the shared registry),
//   - notifyHost ← the `health.notifyHost` bucket (DECOUPLING) OR the EXISTING
//     composed buckets (`binder.wakepack.messagesStoreReady` + the
//     `binder.deliver.deliverHost` closure — the SAME closures the bundle's own
//     daemon uses; the interrupt:true W9-b ALERT contract is mirrored), so the
//     alert path is FUNCTIONAL today without the bundle's literals,
//   - bootId / config / the closure-bound scan inputs (posts / hostWaits /
//     sessionContexts / hostRunning / poolerStatePath / workRegisterPath /
//     qiDirectiveRate) ← the `health` binder bucket (DECOUPLING); absent →
//     the tick's own no-op/degrade contracts (a missing `health` bucket makes
//     the W8-c/M1/M-A scans no-ops, NEVER false alerts).
// A required dep missing at USE FAILS LOUD (R1), never a silently-unbound tick
// (the explicit `runDaemonTick(deps?)` arg merges OVER the binder, so a
// DECOUPLING caller can also inject the closure-bound inputs per call). The
// scan/tick exports (the drop-in bridge superset) stay intact. Nothing is
// removed (R6).
//
// NO export default (pitfall 0001 — breaks `inject`).
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

/** A structurally-typed message-record append input (the MessagesStore surface
 * the daemon alert path needs — the package never imports dshd-core for it). */
export interface HealthStoreAppendInput {
  from: string
  to: string[]
  text: string
  kind: string
}

/** A minimal structural view of the appended record. */
export interface HealthStoreAppendResult {
  id: string
}

/** The FASE 2.6 binder bucket for the health service (STRUCTURAL — read from
 * `ctx.get('deepartments.binder')` widened; filled by the DECOUPLING bundle
 * with the closure-bound scan inputs that only applyInvoke state can build). */
export interface HealthBinderDeps {
  /** The bundle's per-process boot id (invoke.ts `healthBootId`). Absent → a
   * per-build randomUUID (the heartbeat bootId is informational). */
  bootId?: string
  /** The bundle's plugin Config `health` slice (the W8-c per-safeguard knobs
   * + `health.enabled`/`intervalMs`). Absent → the code defaults. */
  config?: HealthConfigLike
  /** W8-c — the catalog-post inputs (activity + inbox) for the turn-error +
   * stale-live safeguards. Absent → the safeguards are no-ops (tick contract). */
  posts?: HealthDaemonDeps['posts']
  /** W8-d PART B — the host-sender-aware inputs for the conditional system-wait
   * scan. Absent → the WAIT scan is a no-op. */
  hostWaits?: HealthDaemonDeps['hostWaits']
  /** M-A — the session-context-pressure rows for the context-threshold
   * watchdog. Absent → the scan is a no-op. */
  sessionContexts?: HealthDaemonDeps['sessionContexts']
  /** M4 — the host's live running signal. Absent → the system-idle scan is a
   * no-op (unknown liveness never fabricates an alert). */
  hostRunning?: HealthDaemonDeps['hostRunning']
  /** M-5 — the mission-activity rows (per non-retired HEAD post: the LAST
   * host→head mission delivery + last session activity) for the
   * mission-stalled watchdog. Absent → the scan is a no-op. */
  missionActivity?: HealthDaemonDeps['missionActivity']
  /** M-6 — the main-red watchdog runtime (buildMainRedState over repoRoot —
   * git HEAD reader + fast-lock runner). Absent → the scan is a no-op. */
  mainRed?: HealthDaemonDeps['mainRed']
  /** M-7 — the mission-queue rows (per non-retired HEAD post: the SAME
   * activity inputs buildPostSnapshot consumes — events + inboxTs) for the
   * mission-queue backlog watchdog. Absent → the scan is a no-op. */
  missionQueue?: HealthDaemonDeps['missionQueue']
  /** The framed ALERT delivery (the bundle's own closure). Absent → the
   * service builds one from the EXISTING composed buckets (wakepack
   * messagesStoreReady + deliver.deliverHost, interrupt:true). */
  notifyHost?: HealthDaemonDeps['notifyHost']
  /** M1 — the pooler state file path. Absent → the pooler-capacity scan is a
   * no-op. */
  poolerStatePath?: string
  /** PACING — the repo WORK-REGISTER path. Absent → the notice omits the
   * deferred count. */
  workRegisterPath?: string
  /** M1 — the shared worker-inspect dice probability p. Absent → 0.25 (the
   * code default). */
  qiDirectiveRate?: number
}

/** The `deepartments.health` service surface — the daemon tick the bundle
 * wires inline today. */
export interface HealthSurface {
  /** Run ONE system-health daemon tick with the composed deps. The explicit
   * `deps` arg merges OVER the binder bucket (a DECOUPLING daemon injects the
   * closure-bound inputs per call). NEVER throws (the tick contract); a MISSING
   * INJECTED DEP at use FAILS LOUD (R1). */
  runDaemonTick(deps?: Partial<HealthDaemonDeps>): Promise<void>
}

/** The dshd-health plugin config (minimal — stateDir/org resolve from the
 * shared `deepartments.org` source; only the W8-c `health` knobs mirror the
 * bundle's row when a deployment sets them, absent → code defaults). */
export interface HealthConfig {
  health?: HealthConfigLike['health']
}

export const name = 'dshd-health'
// Resolve everything via `ctx.get` at USE (inject EMPTY) so the plugin stays
// loadable in minimal compositions (the dshd-core discipline).
export const inject: string[] = []

/** LANE 0.2.1 (1B) — a minimal per-apply mutable deps holder (register/get/
 * clear + an EPOCH counter for cache invalidation), mirroring the dshd-core
 * MutableBinder contract so the DECOUPLING bundle FILLS it via `register` (the
 * bundle owns the fill; P1 "the bundle consumes, never provides" intact) and
 * the P6 unload effect RELEASES it via `clear`. AGENTS.md rule 4: per-apply
 * instance provided as a service (no module-global mutable state). */
export interface DepsHolder<T> {
  register(deps: Partial<T>): void
  get(): T
  clear(): void
  getEpoch(): number
}

/** Create a per-apply mutable deps holder (see `DepsHolder`). */
export function createDepsHolder<T>(): DepsHolder<T> {
  let deps = {} as T
  let epoch = 0
  return {
    register(partial) { deps = { ...deps, ...partial } },
    get() { return deps },
    clear() { deps = {} as T; epoch++ },
    getEpoch() { return epoch }
  }
}

export function apply(ctx: Context, config: HealthConfig = {}) {
  // LANE 0.2.1 (1B/1C — binder → Service, P6): the per-process STATIC deps
  // arrive via the PER-PACKAGE deps holder (`deepartments.healthDeps` —
  // provided HERE; the DECOUPLING bundle WRITES it via register — P1 intact).
  // 1C: ONLY the shared quality dice (qiDirectiveRate — the policy this lane
  // does NOT touch; gap 2 moves it to a policy service) stays bound through
  // the holder. EVERY other bind is ELIMINATED and derived:
  //   - the W8-c knobs (`config`) → the package row (`config.health`) + code
  //     defaults (the profile rows are empty today → the same defaults),
  //   - `notifyHost` → the composed bus+deliver fallback (the EXISTING
  //     FASE 2.6-C fallback, promoted to PRIMARY: store.append +
  //     deliverHost(..., { interrupt: true }) — the C8 direct ALERT seam,
  //     never the delivery engine),
  //   - `bootId` → a per-apply randomUUID (the heartbeat bootId is
  //     informational; the same fallback cadence as the bundle's),
  //   - `poolerStatePath` / `workRegisterPath` → the EXPLICIT per-tick deps
  //     (the bundle daemon wiring passes them, exactly like the inline path).
  const bootId = randomUUID()
  const depsHolder = createDepsHolder<HealthBinderDeps>()
  ctx.provide('deepartments.healthDeps', depsHolder)
  // Derived service: the tick itself is the surface; deps resolve per run.
  ctx.provide('deepartments.health', {
    runDaemonTick: async (explicit: Partial<HealthDaemonDeps> = {}): Promise<void> => {
      const org = ctx.get('deepartments.org') as { stateDir?: string } | undefined
      if (org?.stateDir === undefined) {
        throw new Error('[deepartments] health daemon tick: ctx.get("deepartments.org") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.org)')
      }
      const catalog = ctx.get('deepartments.catalog') as { hosts?: Map<string, HostEntryLike> } | undefined
      if (catalog?.hosts === undefined) {
        throw new Error('[deepartments] health daemon tick: ctx.get("deepartments.catalog") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.catalog)')
      }
      // 1C — the ALERT delivery: the composed bus+deliver fallback is now the
      // PRIMARY (the bundle closure it used to shadow is gone). The ALERT
      // path stays the C8 direct seam (store.append + deliverHost with
      // interrupt:true — never a delivery-engine row); a missing seam
      // POST-DISPOSE fails loud (R1), never stale closure execution.
      let notifyHost = explicit.notifyHost
      if (notifyHost === undefined) {
        const all = (ctx.get('deepartments.binder') as { get(): unknown } | undefined)?.get() ?? {}
        const composed = all as {
          deliver?: { deliverHost?: (host: { hostId: string }, framed: string, record: HealthStoreAppendResult, callerSessionId?: string, opts?: { interrupt?: boolean }) => Promise<unknown> }
          wakepack?: { messagesStoreReady?: () => Promise<{ append(input: HealthStoreAppendInput): Promise<HealthStoreAppendResult> }> }
        }
        const storeReady = composed.wakepack?.messagesStoreReady ?? (() => {
          const bus = ctx.get('deepartments.bus') as { storeReady?: Promise<{ append(input: HealthStoreAppendInput): Promise<HealthStoreAppendResult> }> } | undefined
          if (bus?.storeReady === undefined) {
            throw new Error('[deepartments] health daemon tick: no message-store closure — the bundle must register ctx.get("deepartments.binder").register({ wakepack: { messagesStoreReady } }) (composed today) or provide deepartments.bus')
          }
          return bus.storeReady
        })
        const deliverHost = composed.deliver?.deliverHost
        if (deliverHost === undefined) {
          throw new Error('[deepartments] health daemon tick: no ALERT delivery closure — the bundle must register ctx.get("deepartments.binder").register({ deliver: { deliverHost } }) (FASE 2.6-C, composed today)')
        }
        notifyHost = async (hostEntry: HostEntryLike, alertFrame: string): Promise<void> => {
          try {
            const store = await storeReady()
            const record = await store.append({ from: 'deepartments', to: [hostEntry.hostId], text: alertFrame, kind: 'agent' })
            await deliverHost(hostEntry as { hostId: string }, alertFrame, record, void 0, { interrupt: true })
          } catch (error: unknown) {
            ctx.logger.warn(`[deepartments] system-health: host alert delivery failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      await runHealthDaemonTick({
        now: explicit.now ?? (() => Date.now()),
        stateDir: org.stateDir,
        bootId: explicit.bootId ?? bootId,
        config: { health: config.health ?? explicit.config?.health ?? {} } as HealthConfigLike,
        hosts: explicit.hosts ?? [...catalog.hosts.values()],
        posts: explicit.posts,
        hostWaits: explicit.hostWaits,
        sessionContexts: explicit.sessionContexts,
        hostRunning: explicit.hostRunning,
        missionActivity: explicit.missionActivity,
        mainRed: explicit.mainRed,
        missionQueue: explicit.missionQueue,
        // LANE 0.2.1 (1C): the C6 bounded tail reader + the static paths flow
        // through the EXPLICIT per-tick deps (the composed daemon wiring
        // passes them, exactly like the inline path) — absent → the legacy
        // no-op/scan-gate behavior, the tick contract.
        deliveryRowsReader: explicit.deliveryRowsReader,
        poolerStatePath: explicit.poolerStatePath,
        qiDirectiveRate: explicit.qiDirectiveRate ?? depsHolder.get().qiDirectiveRate,
        notifyHost,
        // LANE 2 (fb-27): the turn/end-error HEAD notification closure flows
        // through the EXPLICIT per-tick deps (the bundle's `healthNotifyHead`).
        // Absent → the turn-end-notify block is a conservative no-op (tick
        // contract).
        notifyHead: explicit.notifyHead,
        workRegisterPath: explicit.workRegisterPath,
        logger: ctx.logger
      })
    }
  })
}
