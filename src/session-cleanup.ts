// dsh-deepartments — "clean the web GUI at host sleep" (Option A, plugin-side).
//
// WHY THIS RUNS AT BOOT, NOT INSIDE dept_sleep (SPEC-DRIVEN DEVIATION, proved
// from the runtime code — see .dsh/reports/2026-08-21-ui-cleanup-build.md):
//   * dsh-session's Session constructor (every seed path, create AND restore)
//     requires events CONTIGUOUS from seq 0: "seed event at index N has seq M
//     (expected N); seed must be contiguous from 0" (dsh-session lib/index.js,
//     rc.2). A minimal artifact (header + permission + journal node) whose
//     journal keeps its original high seq can therefore never be loaded.
//   * Re-numbering the kept events to 0..3 makes the artifact loadable — but
//     ONLY while nothing appends to it afterwards. In the dept_sleep host flow
//     the harness ALWAYS appends tool/result + step/end + turn/end AFTER the
//     tool's execute() returns (verified in the live artifact: journal node at
//     seq 323055, then tool/result 323056, step/end 323057, turn/end 323058),
//     with the LIVE in-memory seq numbers (the persistence coordinator
//     validates appends against its own cursor, dsh-session-persistence
//     lib/index.js:835, not against the file). So a truncation performed inside
//     dept_sleep is guaranteed to end up with a non-contiguous tail the next
//     process rejects at resume — bricking the host session.
//   * SAFE POINT: the first boot AFTER the sleep, BEFORE the host session is
//     materialized. At that moment NO process holds the session, the file is
//     the full contiguous log, and rewriting it to header + permission + the
//     last append-origin journal node (renumbered 0..3) is race-free: the next
//     materialization loads the truncated log and continues appending at
//     seq 4,5,6... — contiguous forever. The trigger is a durable marker set
//     at dept_sleep and cleared after a successful truncation, so mid-wake
//     restarts are exact no-ops (one cleanup per sleep cycle).
//
// Every helper mirrors the runtime's own structures (read RAW through the
// same decode the jsonl backend uses; the two-frame zstd encoding matches
// backends' encodeMaterialization: header in its OWN first frame + one event
// frame; checksummed frames like the backend's compressZstdFrame). All file
// mutations are atomic (tmp + rename). Every piece is best-effort: a failure
// logs a warning and never blocks boot or sleep.
import { execFile as execFileCb } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)
/** Matching the jsonl backend's compressZstdFrame: checksummed frames. */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** Minimal structural log interface used by the cleanup (read-only). */
export interface PersistenceLike {
  root?: string
  compression?: string
  readRaw?: (id: unknown, signal?: AbortSignal) => Promise<{ meta?: Record<string, unknown>; filename?: string; content: string } | undefined>
}

/** One parsed JSONL event line (source of truth = the durable artifact). */
export interface LogEvent {
  line: string
  type: string
  seq: number
  surfaceOp: unknown
}

export interface MinimalPlan {
  headerLine: string | undefined
  /** Kept event lines in keep order (permission/sandbox/approval + journal). */
  keptEventLines: string[]
  /** Total event lines in the source artifact (excluding the header). */
  sourceEvents: number
  /** Events dropped by the truncation. */
  droppedEvents: number
}

export interface TruncateResult {
  beforeEvents: number
  afterEvents: number
  journalLine: string | undefined
  artifactPath: string
  /** Path of the verified pre-truncation backup, when one was written or
   * reused (undefined on a no-op path / when no archive was configured). */
  backupPath?: string
  /** true when a NEW backup was written; false when an existing byte-identical
   * backup in the archive was reused (no duplicate); undefined when no backup
   * was attempted. */
  backupCreated?: boolean
}

/** Result of the crash-safe pre-truncation backup. */
export interface BackupArtifactResult {
  backupPath: string
  bytes: number
  created: boolean
}

/** Matches `session-<sessionId>-pre-cleanup-<YYYYMMDD-HHmmss>.jsonl.zstd` so
 * an existing backup for the same session can be located and reused. */
const PRE_CLEANUP_RE = /^session-(.+?)-pre-cleanup-\d{8}-\d{6}\.jsonl\.zstd$/

export interface ArchiveResult {
  archivedDirs: string[]
  skippedLive: string[]
  archivePath: string | undefined
}

export interface SleepCleanupReport {
  hostSessionId: string
  /** true when the ENTIRE cleanup was SKIPPED without running any mutation
   * (the host session is ALREADY materialized/live — a live session keeps
   * appending at its ORIGINAL seqs, so rewriting its artifact mid-life would
   * open a mid-log seq seam; see the module header + the live guard in
   * runSleepCleanup). A skipped cleanup keeps the pending flag (invoke.ts). */
  skipped?: boolean
  /** Machine-readable reason for a skipped cleanup ('session-live'). */
  skipReason?: 'session-live'
  truncate: TruncateResult | undefined
  truncateError: string | undefined
  projCacheRemoved: number
  projCacheError: string | undefined
  archive: ArchiveResult | undefined
  archiveError: string | undefined
}

// ---------------------------------------------------------------------------
// Path helpers (faithful re-implementation of the jsonl backend's small pure
// helpers — dsh-session-persistence-jsonl/lib/types/format.js — so the plugin
// locates artifacts under the sessions root WITHOUT a wrong assumption; the
// test suite covers them against the backend's real session ids).
// ---------------------------------------------------------------------------

/** Injectively encode a SessionId to one safe path segment (backend copy). */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** Locate a session's durable artifact under the sessions root by scanning the
 * project directories (the backend's findLog semantics; bounded — few project
 * dirs). Returns undefined when the session has no stored artifact. */
export async function findSessionArtifact(sessionsRoot: string, sessionId: string): Promise<string | undefined> {
  const encoded = encodeSegment(sessionId)
  let projects: string[] = []
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
      .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name))
  } catch {
    return undefined
  }
  for (const project of projects) {
    const dir = path.join(sessionsRoot, project, encoded)
    for (const suffix of ['session.jsonl.zstd', 'session.jsonl']) {
      const candidate = path.join(dir, suffix)
      try {
        await readFile(candidate)
        return candidate
      } catch { /* try next suffix/project */ }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Zstandard frames — same container semantics the jsonl backend owns
// (concatenated, independently decodable, checksummed frames).
// ---------------------------------------------------------------------------

export function scanZstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== 4247762216) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** Decode a concatenated-frame zstd artifact to its JSONL text (byte-faithful,
 * mirroring the jsonl backend's readRaw decode). */
export async function decodeZstdArtifact(buffer: Buffer): Promise<string> {
  const frames = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  const parts: Buffer[] = []
  for (const frame of frames) {
    parts.push(Buffer.from(await zstdDecompressAsync(buffer.subarray(frame.start, frame.end)) as Uint8Array))
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Compress one independently decodable, checksummed frame (backend copy). */
export async function compressZstdFrame(input: string | Buffer): Promise<Buffer> {
  return Buffer.from(await zstdCompressAsync(input, CHECKSUM_OPTIONS) as Uint8Array)
}

// ---------------------------------------------------------------------------
// Log parsing + the minimal-artifact plan.
// ---------------------------------------------------------------------------

/** Read the first newline-terminated line of an artifact WITHOUT full decode
 * (bounded; mirrors the backend's readFirstZstdLine for header inspection). */
export async function readArtifactFirstLine(artifactPath: string): Promise<string | undefined> {
  const buffer = await readFile(artifactPath)
  if (buffer.length === 0) return undefined
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 4247762216) {
    const frames = scanZstdFrames(buffer)
    if (frames.length === 0) return undefined
    const plaintext = Buffer.from(await zstdDecompressAsync(buffer.subarray(frames[0].start, frames[0].end)) as Uint8Array).toString('utf8')
    return plaintext.split('\n', 1)[0] || undefined
  }
  return buffer.toString('utf8').split('\n', 1)[0] || undefined
}

/** Parse the durable JSONL text into a header line + event rows (malformed
 * lines are skipped defensively, exactly like captureSessionLog). */
export function parseSessionLog(content: string): { headerLine: string | undefined; events: LogEvent[] } {
  const lines = content.split('\n')
  let headerLine: string | undefined
  const events: LogEvent[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      const ev = JSON.parse(line) as { type?: unknown; seq?: unknown; surfaceOp?: unknown }
      if (ev === null || typeof ev !== 'object') continue
      if (headerLine === undefined && ev.type === 'session') {
        headerLine = line
        continue
      }
      if (typeof ev.type === 'string' && typeof ev.seq === 'number') {
        events.push({ line, type: ev.type, seq: ev.seq, surfaceOp: ev.surfaceOp })
      }
    } catch { /* skip malformed line */ }
  }
  return { headerLine, events }
}

/** True for the durable journal node the dept_sleep close appends:
 * plugin/notice user message whose content carries the journal's markdown
 * frontmatter (`---\nauthor: <member>...`, `wake_counter:`). The wake pack
 * (starts "## Deepartments wake pack") and the smart-restart notice are
 * deliberately NOT matched. */
export function isJournalNode(ev: LogEvent): boolean {
  if (ev.type !== 'user/message') return false
  let data: { source?: { kind?: unknown; form?: unknown }; content?: Array<{ text?: unknown }> } | undefined
  try {
    data = JSON.parse(ev.line).data
  } catch { return false }
  if (data?.source?.kind !== 'plugin') return false
  const text = typeof data.content?.[0]?.text === 'string' ? data.content[0].text : ''
  return text.startsWith('---\nauthor: ') && text.includes('\nwake_counter:')
}

/** TRUE for the session-setup events every DSH artifact opens with: the
 * permission preset, the sandbox mode and the approval policy rows. */
export function isSetupEvent(type: string): boolean {
  return type === 'permission/preset' || type === 'sandbox/mode' || type === 'approval/policy'
}

/** Build the minimal keep plan over a parsed artifact: header line +
 * permission/sandbox/approval setup events + the LAST append-origin journal
 * node. Setup events and the journal are renumbered 0..k so the artifact is
 * contiguous from seq 0 (the Session.fromRestore contract). */
export function planMinimalArtifact(content: string): MinimalPlan {
  const { headerLine, events } = parseSessionLog(content)
  const setup = events.filter((ev) => isSetupEvent(ev.type))
  const journals = events.filter((ev) => isJournalNode(ev) && ev.surfaceOp === 'append')
  const journal = journals.length > 0 ? journals[journals.length - 1] : undefined
  const kept: string[] = []
  for (const ev of [...setup, ...(journal !== undefined ? [journal] : [])]) {
    const parsed = JSON.parse(ev.line) as Record<string, unknown>
    parsed.seq = kept.length
    kept.push(JSON.stringify(parsed))
  }
  return {
    headerLine,
    keptEventLines: kept,
    sourceEvents: events.length,
    droppedEvents: events.length - kept.length
  }
}

/** Write the minimal artifact atomically (tmp + rename): the header in its own
 * first frame + one event frame, exactly like the backend's
 * encodeMaterialization. Returns the artifact text for verification. */
export async function writeMinimalArtifact(artifactPath: string, plan: MinimalPlan): Promise<{ path: string; text: string }> {
  if (plan.headerLine === undefined) throw new Error('cannot write a minimal session artifact without a header line')
  const headerFrame = await compressZstdFrame(`${plan.headerLine}\n`)
  const eventFrame = plan.keptEventLines.length > 0 ? await compressZstdFrame(`${plan.keptEventLines.join('\n')}\n`) : Buffer.alloc(0)
  const body = Buffer.concat([headerFrame, eventFrame])
  const tmpPath = `${artifactPath}.cleanup-${process.pid}-${Date.now().toString(36)}.tmp`
  await writeFile(tmpPath, body)
  try {
    await rename(tmpPath, artifactPath)
  } catch (error) {
    try { await rm(tmpPath, { force: true }) } catch { /* ignore */ }
    throw error
  }
  const text = await decodeZstdArtifact(body)
  return { path: artifactPath, text }
}

/** Verify a truncated artifact: contiguous seqs from 0 over kept events and
 * exactly the planned line counts. Throws on any mismatch. */
export function verifyMinimalArtifact(plan: MinimalPlan, writtenText: string): void {
  const { headerLine, events } = parseSessionLog(writtenText)
  if (headerLine === undefined || headerLine !== plan.headerLine) throw new Error('verify: header line lost')
  if (events.length !== plan.keptEventLines.length) throw new Error(`verify: expected ${plan.keptEventLines.length} events, got ${events.length}`)
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== i) throw new Error(`verify: non-contiguous seq ${events[i].seq} at index ${i} (cold boot would reject this artifact)`)
  }
  const journal = events.filter((ev) => isJournalNode(ev))
  if (plan.keptEventLines.length > 0 && journal.length !== 1) throw new Error(`verify: expected exactly 1 journal node, got ${journal.length}`)
}

/** Format a Date as `<YYYYMMDD-HHmmss>` (the backup-name timestamp). */
function formatBackupStamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** CRASH-SAFE: copy the ORIGINAL (pre-truncation) artifact into the state-home
 * archive, byte-identical and VERIFIED (md5 + size) before returning. Written
 * atomically (tmp + rename). If a byte-identical backup for this session
 * already exists in the archive (e.g. a retry after a partial failure left the
 * artifact untruncated), it is REUSED (`created:false`) — never a duplicate.
 * Throws on any failure (caller must abort the truncation). */
export async function backupOriginalArtifact(
  artifactPath: string,
  originalBuffer: Buffer,
  opts: { archiveDir: string; sessionId: string }
): Promise<BackupArtifactResult> {
  const md5 = createHash('md5').update(originalBuffer).digest('hex')
  const bytes = originalBuffer.length
  await mkdir(opts.archiveDir, { recursive: true })
  // Reuse an existing backup that is already byte-identical to this artifact
  // (a retry after a partial failure must NOT duplicate the backup).
  let existing: string | undefined
  try {
    for (const name of await readdir(opts.archiveDir)) {
      if (PRE_CLEANUP_RE.test(name) !== true) continue
      const candidate = path.join(opts.archiveDir, name)
      let candidateBuffer: Buffer
      try {
        candidateBuffer = await readFile(candidate)
      } catch { continue }
      if (candidateBuffer.length === bytes && createHash('md5').update(candidateBuffer).digest('hex') === md5) {
        existing = candidate
        break
      }
    }
  } catch { /* archive unreadable — a fresh backup is written below */ }
  if (existing !== undefined) return { backupPath: existing, bytes, created: false }
  const backupPath = path.join(opts.archiveDir, `session-${opts.sessionId}-pre-cleanup-${formatBackupStamp(new Date())}.jsonl.zstd`)
  const tmpPath = `${backupPath}.cleanup-${process.pid}-${Date.now().toString(36)}.tmp`
  try {
    await writeFile(tmpPath, originalBuffer)
    await rename(tmpPath, backupPath)
  } catch (error) {
    try { await rm(tmpPath, { force: true }) } catch { /* ignore */ }
    throw error
  }
  // Verify the written copy is byte-identical BEFORE the caller truncates.
  const written = await readFile(backupPath)
  if (written.length !== bytes || createHash('md5').update(written).digest('hex') !== md5) {
    throw new Error('backup verification failed: written copy is not byte-identical to the original artifact')
  }
  return { backupPath, bytes, created: true }
}

/** Optional backup config for the truncation (see runSleepCleanup). When
 * absent, no backup is attempted (legacy / unit-test callers). */
export interface TruncateOptions {
  /** The state-home archive dir the pre-truncation backup is written to. */
  archiveDir?: string
  /** The host session id, used to name/locate `session-<id>-pre-cleanup-*`. */
  sessionId?: string
  /** Live-session probe — DEFENSIVE guard for DIRECT callers of
   * truncateSessionArtifact. When `sessionId` is supplied and the session is
   * live, the truncation REFUSES to run (throws). The canonical guard lives in
   * runSleepCleanup (which skips the whole cleanup, archive + projcache
   * included — the truncate guard alone is NOT sufficient); this one protects
   * code paths that call the truncate step directly. */
  isLive?: (sessionId: string) => boolean
}

export async function truncateSessionArtifact(artifactPath: string, opts: TruncateOptions = {}): Promise<TruncateResult> {
  // DEFENSIVE LIVE GUARD (direct-call site): when the session is reported
  // live, REFUSE — rewriting a LIVE session's artifact to a minimal log while
  // its in-memory history keeps the original seq cursor makes the session's
  // next append land at an ORIGINAL seq onto the truncated file, a mid-log
  // seq seam the reader rejects on any cold read. The canonical guard sits at
  // the top of runSleepCleanup (the whole cleanup — truncate, archive,
  // projcache — is skipped for a live host); this guard protects direct
  // callers so the truncate step itself can never corrupt a live session.
  if (opts.sessionId !== undefined && opts.isLive?.(opts.sessionId) === true) {
    throw new Error(`refusing to truncate the session artifact of LIVE session ${opts.sessionId} (session-live): a live session appends at its original seqs onto the truncated file, producing a mid-log seq seam — retry at a boot where the session is not materialized`)
  }
  const buffer = await readFile(artifactPath)
  const content = buffer.length >= 4 && buffer.readUInt32LE(0) === 4247762216
    ? await decodeZstdArtifact(buffer)
    : buffer.toString('utf8')
  const before = parseSessionLog(content).events.length
  const plan = planMinimalArtifact(content)
  // CRASH-SAFE ORDER, before any rewrite: if events would be dropped (not a
  // no-op), preserve the ORIGINAL artifact in the archive — verified
  // byte-identical — and ONLY THEN truncate. A FAILED backup ABORTS the
  // truncation (the caller keeps the pending flag → the next boot retries).
  // On a no-op path (already minimal, nothing would be lost) no backup.
  const minimal = plan.droppedEvents === 0
  let backup: BackupArtifactResult | undefined
  if (!minimal && opts.archiveDir !== undefined && opts.sessionId !== undefined) {
    backup = await backupOriginalArtifact(artifactPath, buffer, {
      archiveDir: opts.archiveDir,
      sessionId: opts.sessionId
    })
  }
  const { text } = await writeMinimalArtifact(artifactPath, plan)
  verifyMinimalArtifact(plan, text)
  const after = parseSessionLog(text).events.length
  const journal = parseSessionLog(text).events.find((ev) => isJournalNode(ev))
  return {
    beforeEvents: before,
    afterEvents: after,
    journalLine: journal?.line,
    artifactPath,
    backupPath: backup?.backupPath,
    backupCreated: backup?.created
  }
}

// ---------------------------------------------------------------------------
// Projcache reset (storages/session_projcache.json — the session-projection
// cache domain: "a fold shortcut, never an authority", so dropping rows is
// safe; stats recompute from the (truncated) log on the next cold read).
// ---------------------------------------------------------------------------

export interface ProjCacheFile {
  unit?: unknown
  global?: unknown
  tables?: { sessions?: Record<string, unknown> }
}

/** Drop the given session rows from the projection cache atomically.
 * Missing/corrupt file degrades to a no-op. Returns the number of rows
 * removed. */
export async function resetProjectionRows(projCachePath: string, idsToDrop: string[]): Promise<number> {
  if (idsToDrop.length === 0) return 0
  let data: ProjCacheFile
  try {
    data = JSON.parse(await readFile(projCachePath, 'utf8')) as ProjCacheFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw new Error(`projcache unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const sessions = data?.tables?.sessions
  if (sessions === undefined || typeof sessions !== 'object') return 0
  let removed = 0
  for (const id of idsToDrop) {
    if (Object.hasOwn(sessions, id)) {
      delete sessions[id]
      removed += 1
    }
  }
  if (removed === 0) return 0
  const tmpPath = `${projCachePath}.cleanup-${process.pid}-${Date.now().toString(36)}.tmp`
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8')
  try {
    await rename(tmpPath, projCachePath)
  } catch (error) {
    try { await rm(tmpPath, { force: true }) } catch { /* ignore */ }
    throw error
  }
  return removed
}

// ---------------------------------------------------------------------------
// Subagent child archiving (mirrors subagent.listChildren criteria:
// header.parentSession === <host> && header.origin === 'subagent' — a durable
// dir scan of the sessions root header lines). NEVER touches posts/heads or
// any directory without that header pair; LIVE children are skipped so a
// running background subagent is not torn down mid-work.
// ---------------------------------------------------------------------------

/** Enumerate direct child subagent session DIRECTORIES of the host under the
 * sessions root (relative to the root, for tar member names). */
export async function listSubagentChildDirs(sessionsRoot: string, hostSessionId: string): Promise<string[]> {
  const children: string[] = []
  let projects: string[] = []
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true }).then((e) => e.filter((x) => x.isDirectory()).map((x) => x.name))
  } catch {
    return children
  }
  for (const project of projects) {
    let dirs: string[] = []
    try {
      dirs = await readdir(path.join(sessionsRoot, project), { withFileTypes: true }).then((e) => e.filter((x) => x.isDirectory()).map((x) => x.name))
    } catch { continue }
    for (const dir of dirs) {
      const relative = path.join(project, dir)
      const artifact = path.join(sessionsRoot, relative, 'session.jsonl.zstd')
      let headerLine: string | undefined
      try {
        headerLine = await readArtifactFirstLine(artifact)
      } catch { continue }
      if (headerLine === undefined) continue
      try {
        const header = JSON.parse(headerLine) as { origin?: unknown; parentSession?: unknown }
        if (header.origin === 'subagent' && header.parentSession === hostSessionId) children.push(relative)
      } catch { /* skip */ }
    }
  }
  return children
}

/** Archive the child dirs into a tarball under `archiveDir` (tar CLI; falls
 * back to a plain directory copy so history is NEVER lost), then delete the
 * source dirs. Returns the archived relative dirs. */
export async function archiveAndDeleteSubagentChildren(
  sessionsRoot: string,
  archiveDir: string,
  hostSessionId: string,
  opts: { isLive?: (sessionId: string) => boolean } = {}
): Promise<ArchiveResult> {
  const children = await listSubagentChildDirs(sessionsRoot, hostSessionId)
  const archivedDirs: string[] = []
  const skippedLive: string[] = []
  for (const relative of children) {
    const id = path.basename(relative)
    if (opts.isLive?.(id) === true) {
      skippedLive.push(relative)
      continue
    }
    archivedDirs.push(relative)
  }
  if (archivedDirs.length === 0) {
    return { archivedDirs, skippedLive, archivePath: undefined }
  }
  await mkdir(archiveDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archiveBase = path.join(archiveDir, `subagents-${hostSessionId}-${stamp}`)
  const tarPath = `${archiveBase}.tar.gz`
  const tmpTar = `${tarPath}.tmp`
  // Prefer the system tar CLI (present on this host); fall back to a plain
  // recursive directory copy so an absent tar never loses the history. The
  // `--` separator ends option parsing BEFORE the member list: project dirs
  // are `--via-project--`-style names beginning with `--`, which GNU tar
  // would otherwise misread as long options.
  try {
    await new Promise<void>((resolve, reject) => {
      execFileCb('tar', ['-czf', tmpTar, '-C', sessionsRoot, '--', ...archivedDirs], (error) => {
        if (error !== null) reject(error)
        else resolve()
      })
    })
    await rename(tmpTar, tarPath)
  } catch (error) {
    try { await rm(tmpTar, { force: true }) } catch { /* ignore */ }
    const copyDir = `${archiveBase}.dir`
    await mkdir(copyDir, { recursive: true })
    for (const relative of archivedDirs) {
      await cp(path.join(sessionsRoot, relative), path.join(copyDir, relative), { recursive: true })
    }
    const fallback = error instanceof Error ? error.message : String(error)
    // Report the fallback via the archive path convention (a .dir suffix marks
    // the plain-copy fallback; the caller logs it).
    return { archivedDirs, skippedLive, archivePath: copyDir + ` (tar fallback: ${fallback})` }
  }
  for (const relative of archivedDirs) {
    await rm(path.join(sessionsRoot, relative), { recursive: true, force: true })
  }
  return { archivedDirs, skippedLive, archivePath: tarPath }
}

// ---------------------------------------------------------------------------
// Orchestrator — the boot-time cleanup (after a real dept_sleep set the
// pending marker). Every piece is individually best-effort; a failure is
// reported and NEVER rethrown (boot must not block or crash).
// ---------------------------------------------------------------------------

export interface SleepCleanupOptions {
  /** The located durable artifact path of the host session (undefined → skip). */
  artifactPath: string | undefined
  /** Absolute path of storages/session_projcache.json in the state home. */
  projCachePath: string
  /** Absolute sessions root (the persistence backend's root). */
  sessionsRoot: string
  /** Absolute archive directory (derived from the state home). */
  archiveDir: string
  /** Live-session probe (skip archiving live children). */
  isLive?: (sessionId: string) => boolean
  /** Logging hook (ctx.logger-compatible). */
  log?: { warn: (msg: string) => void; info?: (msg: string) => void }
}

/** Run the whole cleanup for ONE host session. Never throws: each piece is
 * contained and its failure lands in the report + log. */
export async function runSleepCleanup(hostSessionId: string, opts: SleepCleanupOptions): Promise<SleepCleanupReport> {
  // LIVE-SESSION GUARD — FIRST, before ANY mutation (truncate, projcache
  // reset, children archive). This is the wake-11 corruption ROOT-CAUSE fix:
  // the boot-time cleanup once truncated the host artifact UNCONDITIONALLY
  // (the archive step already skipped live CHILDREN, but the host artifact
  // itself was truncated even while the host session was ALREADY materialized
  // — a resident agent holding the full history in memory). The live session
  // then kept appending at its ORIGINAL seqs onto the truncated file → a
  // mid-log seq seam the reader rejects ("complete frame contains a torn
  // JSONL record"). When the host is live, skip the ENTIRE cleanup and mark
  // the report `skipped: true, skipReason: 'session-live'` so the caller
  // (invoke.ts) KEEPS the pending flag and retries at a boot where the
  // session is verifiably NOT materialized (mirrors the archive step's
  // per-child live guard — but for the host itself, the GUI-critical piece).
  if (opts.isLive?.(hostSessionId) === true) {
    opts.log?.warn(`[deepartments] web-ui sleep cleanup: SKIPPED for live host session ${hostSessionId} (session-live): the session is materialized, so truncation would corrupt its artifact — pending flag kept for the next boot`)
    return {
      hostSessionId,
      skipped: true,
      skipReason: 'session-live',
      truncate: undefined,
      truncateError: undefined,
      projCacheRemoved: 0,
      projCacheError: undefined,
      archive: undefined,
      archiveError: undefined
    }
  }
  const report: SleepCleanupReport = { hostSessionId, projCacheRemoved: 0, truncate: undefined, truncateError: undefined, projCacheError: undefined, archive: undefined, archiveError: undefined }
  const warn = (msg: string): void => { opts.log?.warn(`[deepartments] web-ui sleep cleanup: ${msg}`) }
  // 1. Truncate the host artifact (the GUI-critical piece). The crash-safe
  //    backup of the ORIGINAL artifact happens INSIDE truncateSessionArtifact
  //    BEFORE any rewrite; a failed backup aborts the truncation (the report
  //    carries truncateError and truncate stays undefined → the pending flag
  //    is kept for the next boot — see invoke.ts).
  if (opts.artifactPath !== undefined) {
    try {
      report.truncate = await truncateSessionArtifact(opts.artifactPath, {
        archiveDir: opts.archiveDir,
        sessionId: hostSessionId,
        // Defense-in-depth: the top-of-runSleepCleanup guard already returned
        // for a live host; passing the probe down keeps the truncate step's
        // own direct-call guard coherent (it can never fire from here).
        isLive: opts.isLive
      })
    } catch (error) {
      report.truncateError = error instanceof Error ? error.message : String(error)
      warn(`truncate failed for ${hostSessionId}: ${report.truncateError}`)
    }
  }
  // 2. Archive + delete the direct child subagent dirs.
  if (opts.sessionsRoot !== undefined && opts.sessionsRoot !== '') {
    try {
      report.archive = await archiveAndDeleteSubagentChildren(opts.sessionsRoot, opts.archiveDir, hostSessionId, { isLive: opts.isLive })
    } catch (error) {
      report.archiveError = error instanceof Error ? error.message : String(error)
      warn(`subagent child archiving failed: ${report.archiveError}`)
    }
  }
  // 3. Reset projection-cache rows: the host + every archived child (their
  //    dirs are gone, so their cache rows are dead weight; the host row is
  //    rebuilt from the truncated log on the next cold read).
  const idsToDrop = [hostSessionId, ...(report.archive?.archivedDirs ?? []).map((d) => path.basename(d))]
  try {
    report.projCacheRemoved = await resetProjectionRows(opts.projCachePath, idsToDrop)
  } catch (error) {
    report.projCacheError = error instanceof Error ? error.message : String(error)
    warn(`projcache reset failed: ${report.projCacheError}`)
  }
  return report
}