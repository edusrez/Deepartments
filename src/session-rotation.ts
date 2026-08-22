// dsh-deepartments — U2: HOST SESSION ROTATION at dept_sleep (pure helpers +
// dependency-injected orchestration).
//
// Spec: docs/specs/002-host-session-rotation.md — §3.3 (S1.5b-S8 state machine),
// §3.2 (server-side session creation), §3.5 (hosts.json D4 schema + loader
// validation), §3.6 (crash windows), §4 (wake-time retired-skip), §5 (the
// cleanup target: rotation NEVER sets webUiCleanupPending). Owner decisions D1
// (server-side archive via workspaceRegistry.archiveSession), D2 (belt-and-
// suspenders artifact copy, never a move, no retention cap), D3 (journal
// re-key: `author:` rewritten host-<oldId> → host-<newId>, room unchanged; the
// rotation seed is built from the re-keyed journal), D4 (retired/retiredAt/
// rotatedTo/previousSessionId + `schemaVersion` marker with load validation).
//
// Design notes (spec-mapped):
//   * The NEW session id is PRE-MINTED (`session-<uuid>`) before the
//     persistence call (S2) so the re-keyed journal (S1.5b) can name
//     `host-<newId>` BEFORE the session exists — the ordering the spec's
//     crash-window table requires (the journal file must exist before
//     hosts.json can name the member). The spec §3.2 wrote
//     `ctx.get('sessions').create(undefined, …)` (store-minted id); FIX 1
//     (see .dsh/reports/explore-deep/2026-08-22-rotation-resume-live-race.md —
//     the session-6e49895c… incident, 2026-08-22 16:19:52 UTC) persists the
//     seed via the dsh-session-persistence seam with the pre-minted id, which
//     keeps every §3.3 step + invariant intact and makes the invariant
//     STRICTER: the artifact is written COLD — the new session is NEVER
//     attached to `ctx.sessions` (the attached-but-agentless store state is
//     the poison that made every later resume hit the live-guard `cannot
//     prepare session "<id>" while it is live`).
//   * `runHostRotation` is DI so the crash windows are unit-testable without
//     the real Loader: seed-persist failure / missing persistence seam →
//     `{rotated:false}` (invoke.ts then runs the LEGACY in-place path);
//     archive + artifact-copy failures are NON-FATAL (the hosts.json retire
//     still commits).
//   * Never truncates, never deletes: the old artifact + old journal stay
//     byte-identical (G4/D2); the archive registry only hides, the archive dir
//     copy only copies.

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { findSessionArtifact } from './session-cleanup.js'

/** The durable hosts.json schema version (D4). Written by `persistHosts` at the
 * top level of every persisted file; ABSENT on legacy (v1) files, which the
 * loader still accepts (see validateHostsRotationFile). */
export const ROTATION_SCHEMA_VERSION = 2

/** Deterministic member prefix for a host session (`host-<sessionId>`); must
 * match invoke.ts's HOST_ID_PREFIX ('host-'). */
const HOST_ID_PREFIX = 'host-'

/** Notice summary for the seeded journal node of the rotated session (the
 * rotation counterpart of buildSleepJournalMessage's "in-place reset" line). */
export const ROTATION_JOURNAL_NOTICE_SUMMARY =
  'Host session rotation — this session is seeded from the re-keyed journal (long-term memory; the previous session was archived whole).'

/** One durable host registry entry (hostId → host session in a room). The
 * shape mirrors invoke.ts's HostEntry; the four trailing fields are the D4
 * rotation schema. */
export interface HostRotationEntry {
  hostId: string
  sessionId: string
  roomId: string
  sleepEpoch?: number
  boundarySeq?: number
  webUiCleanupPending?: boolean
  deferredJournalSeed?: string
  /** D4: set on the retired old entry — the sleep gate skips retired hosts. */
  retired?: boolean
  /** D4: when the entry was retired (ms epoch). */
  retiredAt?: number
  /** D4: the hostId this retired entry rotated to. */
  rotatedTo?: string
  /** D4: the sessionId this live entry rotated FROM (references a retired entry). */
  previousSessionId?: string
}

/** One seed event for the new session (the minimal-artifact event-list shape
 * planMinimalArtifact produces; contiguous seq 0..k is the Session ctor
 * contract — dsh-session lib:1381). */
export interface RotationSeedEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
  sourceEventSeqs?: number[]
}

/** The old/new persisted hosts.json entries produced by a rotation (S3/D4). */
export interface HostsRotationRecords {
  /** The RETIRED old entry: spread of the old persisted fields + retired/
   * retiredAt/rotatedTo. Stays in hosts.json, queryable as evidence (D1). */
  oldEntry: Omit<HostRotationEntry, 'hostId'>
  /** The NEW live entry: sessionId/roomId/sleepEpoch/boundarySeq?/
   * previousSessionId (NEVER webUiCleanupPending/deferredJournalSeed — S4/S5). */
  newEntry: Omit<HostRotationEntry, 'hostId'>
}

/** Result of the tidy archive-call + artifact-copy wrappers (never throw). */
export interface RotationArchiveResult {
  ok: boolean
  reason?: string
  path?: string
}

/**
 * D3 — re-key a sleep journal for the rotated member: rewrite ONLY the
 * frontmatter `author:` line from `host-<oldId>` to `host-<newId>` (room and
 * every other byte untouched). Throws loudly when the journal has no
 * `author:` frontmatter line (mirrors bumpHostSleepCounter's loud style).
 */
export function rekeyJournal(content: string, newHostId: string): string {
  const authorLine = content.match(/^author:\s*(\S+)$/m)
  if (authorLine === null) {
    throw new Error(`[deepartments] rekeyJournal: journal has no "author:" frontmatter line — cannot re-key to ${newHostId}`)
  }
  return content.replace(/^author:\s*\S+$/m, `author: ${newHostId}`)
}

/** The model-visible message the rotation seed's journal node carries: the
 * re-keyed journal framed as a plugin/notice context (never a user-typed
 * message — same framing as buildSleepJournalMessage, with the rotation
 * summary). */
export function buildRotationSeedMessage(reKeyedJournal: string) {
  return createUserMessage({
    content: [{ type: 'text', text: reKeyedJournal }],
    source: {
      kind: 'plugin',
      plugin: 'deepartments',
      form: 'notice',
      summary: boundContextSummary(ROTATION_JOURNAL_NOTICE_SUMMARY)
    }
  })
}

/**
 * §3.2 — the rotation seed: permission/sandbox/approval setup events + the
 * LAST append-origin RE-KEYED journal node, renumbered 0..k (the exact
 * minimal-artifact event-list shape planMinimalArtifact produces and
 * Session.fromRestore proves cold-bootable). The Session constructor validates
 * contiguous-from-0 seqs, so nothing here may renumber independently. The
 * setup values mirror what the harness stamps on fresh sessions (the host runs
 * danger-full-access; overridable for tests).
 */
export function buildRotationSeed(reKeyedJournal: string, opts: { preset?: string; sandbox?: string; policy?: string; now?: number } = {}): RotationSeedEvent[] {
  const now = opts.now ?? Date.now()
  const message = buildRotationSeedMessage(reKeyedJournal)
  return [
    { type: 'permission/preset', seq: 0, time: now, data: { preset: opts.preset ?? 'danger-full-access' } },
    { type: 'sandbox/mode', seq: 1, time: now, data: { mode: opts.sandbox ?? 'danger-full-access' } },
    { type: 'approval/policy', seq: 2, time: now, data: { policy: opts.policy ?? 'never' } },
    { type: 'user/message', seq: 3, time: now, data: message as unknown as Record<string, unknown>, surfaceOp: 'append' }
  ]
}

/**
 * S3/D4 — the old/new hosts.json entries for one rotation. The old entry
 * becomes `{...old, retired: true, retiredAt, rotatedTo: newHostId}` (stays in
 * the file, queryable — D1); the new entry carries sessionId/roomId/sleepEpoch/
 * boundarySeq?/previousSessionId and NEVER webUiCleanupPending/deferredJournalSeed
 * (S4/S5).
 */
export function hostsRotationRecords(
  oldEntry: HostRotationEntry,
  newSessionId: string,
  opts: { newHostId: string; roomId: string; sleepEpoch: number; boundarySeq?: number; retiredAt: number }
): HostsRotationRecords {
  const persisted: Omit<HostRotationEntry, 'hostId'> = {
    sessionId: oldEntry.sessionId,
    roomId: oldEntry.roomId,
    ...(oldEntry.sleepEpoch !== void 0 ? { sleepEpoch: oldEntry.sleepEpoch } : {}),
    ...(oldEntry.boundarySeq !== void 0 ? { boundarySeq: oldEntry.boundarySeq } : {})
  }
  return {
    oldEntry: {
      ...persisted,
      retired: true,
      retiredAt: opts.retiredAt,
      rotatedTo: opts.newHostId
    },
    newEntry: {
      sessionId: newSessionId,
      roomId: opts.roomId,
      sleepEpoch: opts.sleepEpoch,
      ...(opts.boundarySeq !== void 0 ? { boundarySeq: opts.boundarySeq } : {}),
      previousSessionId: oldEntry.sessionId
    }
  }
}

/**
 * §3.5/D4 loader validation: keep loading legacy files (no `schemaVersion`, no
 * `retired` fields) with exact pre-rotation behavior; validate the NEW fields
 * type-wise and relationally; malformed NEW fields THROW a descriptive error
 * instead of being silently dropped. Relational rule: `previousSessionId` must
 * reference an existing RETIRED entry id (by `sessionId`). Live entries that
 * were rotated (carry `previousSessionId`) must also carry a numeric
 * `sleepEpoch`.
 */
export function validateHostsRotationFile(data: Record<string, unknown>): void {
  // sessionId → whether the entry is retired (for the relational reference
  // check; a retired entry's ROTATION field set is validated inline below).
  const retiredBySession = new Map<string, boolean>()
  for (const [hostId, raw] of Object.entries(data)) {
    if (hostId === 'schemaVersion') continue
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    if (typeof entry.sessionId !== 'string' || typeof entry.roomId !== 'string' || !hostId.startsWith(HOST_ID_PREFIX)) continue
    const retired = entry.retired
    const retiredAt = entry.retiredAt
    const rotatedTo = entry.rotatedTo
    const previousSessionId = entry.previousSessionId
    if (retired !== void 0 && typeof retired !== 'boolean') {
      throw new Error(`[deepartments] hosts.json schema violation: "${hostId}" carries a non-boolean retired marker (${JSON.stringify(retired)})`)
    }
    if (retiredAt !== void 0 && typeof retiredAt !== 'number') {
      throw new Error(`[deepartments] hosts.json schema violation: "${hostId}" carries a non-numeric retiredAt (${JSON.stringify(retiredAt)})`)
    }
    if (rotatedTo !== void 0 && typeof rotatedTo !== 'string') {
      throw new Error(`[deepartments] hosts.json schema violation: "${hostId}" carries a non-string rotatedTo (${JSON.stringify(rotatedTo)})`)
    }
    if (previousSessionId !== void 0 && typeof previousSessionId !== 'string') {
      throw new Error(`[deepartments] hosts.json schema violation: "${hostId}" carries a non-string previousSessionId (${JSON.stringify(previousSessionId)})`)
    }
    if (retired === true) {
      if (typeof retiredAt !== 'number') throw new Error(`[deepartments] hosts.json schema violation: retired entry "${hostId}" must carry a numeric retiredAt`)
      if (typeof rotatedTo !== 'string' || rotatedTo === '') throw new Error(`[deepartments] hosts.json schema violation: retired entry "${hostId}" must carry a non-empty rotatedTo`)
      retiredBySession.set(entry.sessionId, true)
    }
    if (previousSessionId !== void 0 && typeof entry.sleepEpoch !== 'number') {
      throw new Error(`[deepartments] hosts.json schema violation: rotated (previousSessionId-bearing) live entry "${hostId}" must carry a numeric sleepEpoch`)
    }
  }
  // Relational pass (order-independent): every previousSessionId must reference
  // a RETIRED entry's sessionId present in the same file.
  for (const [hostId, raw] of Object.entries(data)) {
    if (hostId === 'schemaVersion' || raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const previousSessionId = entry.previousSessionId
    if (typeof previousSessionId !== 'string') continue
    if (retiredBySession.get(previousSessionId) !== true) {
      throw new Error(`[deepartments] hosts.json schema violation: "${hostId}" references previousSessionId "${previousSessionId}" which is not a retired entry in the same file`)
    }
  }
}

/** The workspace-registry archive seam (dsh-workspace `archiveSession`),
 * structurally narrowed so the plugin never hard-depends on the package. */
export interface WorkspaceRegistryLike {
  archiveSession(sessionId: string): Promise<unknown> | unknown
}

/**
 * D1 — the archive CALL WRAPPER around `ctx.get('workspaceRegistry')
 * .archiveSession(oldId)`. Never throws: a missing registry or a failing call
 * resolves `{ok:false, reason}` and the caller logs loudly but continues (the
 * hosts.json retire is the durable part; §3.3 S2.5 is non-fatal by design).
 */
export async function archiveOldSession(
  registry: WorkspaceRegistryLike | undefined,
  oldSessionId: string,
  logger?: { error(message: string): void }
): Promise<RotationArchiveResult> {
  if (registry?.archiveSession === void 0) {
    const reason = 'workspaceRegistry unavailable (headless/profile without the GUI service) — the hosts.json retire still commits'
    logger?.error(`[deepartments] host rotation: archiveSession(${oldSessionId}) skipped: ${reason}`)
    return { ok: false, reason }
  }
  try {
    await registry.archiveSession(oldSessionId)
    return { ok: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger?.error(`[deepartments] host rotation: archiveSession(${oldSessionId}) failed (non-fatal — hosts.json retire still commits): ${reason}`)
    return { ok: false, reason }
  }
}

/** Format a Date as `<YYYYMMDD-HHmmss>` (the archive-backup name timestamp;
 * the same convention as session-cleanup.ts's private formatBackupStamp). */
function formatBackupStamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * S2.7/D2 — belt-and-suspenders COPY (never move) of the OLD session artifact
 * into the state-home evidence archive:
 *   `<archiveDir>/session-<oldId>-pre-rotation-<stamp>.jsonl.zstd`
 * Best-effort, never throws (mirrors runSleepCleanup's per-piece tolerance).
 * The live artifact stays in place; all retired sessions are kept in full, no
 * cap.
 */
export async function copyOldArtifactToArchive(opts: { sessionsRoot: string; oldSessionId: string; archiveDir: string; now?: number }): Promise<RotationArchiveResult> {
  try {
    const artifactPath = await findSessionArtifact(opts.sessionsRoot, opts.oldSessionId)
    if (artifactPath === undefined) {
      return { ok: false, reason: `no stored artifact for ${opts.oldSessionId} (nothing to copy)` }
    }
    await mkdir(opts.archiveDir, { recursive: true })
    const stamp = formatBackupStamp(new Date(opts.now ?? Date.now()))
    const backupPath = path.join(opts.archiveDir, `session-${opts.oldSessionId}-pre-rotation-${stamp}.jsonl.zstd`)
    await copyFile(artifactPath, backupPath)
    return { ok: true, path: backupPath }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The session-persistence seam (dsh-session-persistence coordinator
 * `create`/`append`), structurally narrowed so the plugin never hard-depends
 * on the package (mirrors dsh-session-persistence lib/index.js:802-840).
 * `create` registers DETACHED lazy metadata (`states.set`, cursor 0, NO
 * artifact, NO live store attach — the session stays COLD); `append`
 * seq-validates against the cursor and materializes the artifact. This is the
 * same service the RESUME path reads (`prepare` → live-guard at
 * dsh-session-persistence lib/index.js:852: a session already in
 * `ctx.sessions` is rejected as "while it is live"), so S2 must write the
 * seed here and NEVER via the live sessions store. */
export interface RotationPersistenceLike {
  create(meta: { id: string; version?: number; createdAt: number; cwd?: string; seedLength?: number; delegationDepth?: number }): Promise<unknown>
  append(id: string, events: unknown[]): Promise<unknown>
}

/** Logger seam for runHostRotation. */
export interface RotationLoggerLike {
  error(message: string): void
  warn(message: string): void
}

/** Dependency surface of one rotation attempt (all live services resolved by
 * invoke.ts; every seam optional so the crash windows are unit-testable). */
export interface RotationDeps {
  /** The CURRENT (old) host session id. */
  oldSessionId: string
  /** The OLD host member id (`host-<oldId>`). */
  oldHostId: string
  roomId: string
  /** S1.5 output: the BUMPED journal text (wake_counter N+1) — re-key source. */
  seededJournal: string
  /** `<stateDir>/journals` — where the re-keyed journal lands (S1.5b). */
  journalsDir: string
  /** The old session's cwd (workspace path) — the new session's header cwd. */
  workspacePath: string
  /** The old session's seq at the boundary (S3 new-entry boundarySeq). */
  boundarySeq?: number
  /** The session-persistence seam (S2 — FIX 1: cold seed). Absent or partial
   * (missing create/append) → rotation cannot run (legacy fallback). The
   * new session is persisted COLD and is NEVER store-attached. */
  persistence?: RotationPersistenceLike
  /** The workspace registry (S2.5). Absent → non-fatal, logged. */
  workspaceRegistry?: WorkspaceRegistryLike
  /** The state-home sessions root (S2.7 artifact search). */
  sessionsRoot: string
  /** The state-home evidence archive dir (S2.7). */
  archiveDir: string
  /** The in-memory host registry (mutated by S3/S7). */
  hosts: Map<string, HostRotationEntry>
  /** The sessionId → hostId reverse map (S3). */
  hostForSession?: Map<string, string>
  /** Fire-and-forget hosts.json persistence (S3/S7). */
  persistHosts: () => void
  logger: RotationLoggerLike
  /** Clock seam for deterministic tests. */
  now?: () => number
}

/** Outcome of one rotation attempt. `rotated:false` → invoke.ts runs the
 * LEGACY in-place path (the only fallback trigger: S1.5b write failure or S2
 * seed-persist failure / missing persistence seam — crash windows §3.6).
 * Archive + copy failures never make the rotation fail (non-fatal). */
export type HostRotationOutcome =
  | {
    rotated: true
    newHostId: string
    newSessionId: string
    newJournalPath: string
    reKeyedJournal: string
    sleepEpoch: number
    archive: RotationArchiveResult
    archiveCopy: RotationArchiveResult
  }
  | { rotated: false; reason: string }

/** Atomic journal write (tmp + rename) with a rotation-unique tmp suffix so it
 * never collides with bumpHostSleepCounter's `.tmp`. The journals dir is
 * created defensively (production always has it — dept_memo_write made it). */
async function writeJournalAtomic(journalPath: string, content: string): Promise<void> {
  const tmpPath = `${journalPath}.rotation-${process.pid}-${Date.now().toString(36)}.tmp`
  try {
    await mkdir(path.dirname(journalPath), { recursive: true })
    await writeFile(tmpPath, content, 'utf8')
    await rename(tmpPath, journalPath)
  } catch (error) {
    try { await unlink(tmpPath) } catch { /* ignore cleanup failure */ }
    throw error
  }
}

/**
 * The rotated host `dept_sleep` core — S1.5b → S7 (S1/S1.5 stay in invoke.ts;
 * S6/S8 — wakePackInjected bookkeeping + concludeTurn — stay in invoke.ts):
 *
 *   S1.5b write the re-keyed journal `journals/host-<newId>.md` (atomic),
 *   S2    persist the new session seed via the dsh-session-persistence seam
 *         (`create` detached metadata + `append` the seed artifact — the
 *         session stays COLD, never store-attached; FIX 1),
 *   S2.5  server-side archive of the old session (non-fatal, D1),
 *   S2.7  evidence COPY of the old artifact (best-effort, D2),
 *   S3/S7 rotate hosts.json (old retired + new live, single persistHosts).
 *
 * Ordering guarantees (crash windows §3.6): the re-keyed journal exists before
 * any hosts.json persist names the member; the archive resolves BEFORE the
 * hosts.json rotation (one-await window); after S2 succeeds the rotation never
 * silently falls back (a stray COLD artifact — no live attachment — plus the
 * re-keyed journal is harmless garbage; the attached-but-agentless store
 * state is exactly what FIX 1 eliminates).
 */
export async function runHostRotation(deps: RotationDeps): Promise<HostRotationOutcome> {
  const now = deps.now ?? Date.now
  const retiredAt = now()
  // Pre-mint the NEW session id so S1.5b can name `host-<newId>` BEFORE the
  // store call (see the module header — the spec's ordering invariant).
  const newSessionId = SessionId(`session-${randomUUID()}`)
  const newHostId = `${HOST_ID_PREFIX}${newSessionId}`

  // S1.5b — the re-keyed journal (D3), atomic, MUST precede any hosts.json
  // persist that names the new member.
  let reKeyed: string
  try {
    reKeyed = rekeyJournal(deps.seededJournal, newHostId)
  } catch (error) {
    return { rotated: false, reason: `journal re-key failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const newJournalPath = path.join(deps.journalsDir, `${newHostId}.md`)
  try {
    await writeJournalAtomic(newJournalPath, reKeyed)
  } catch (error) {
    return { rotated: false, reason: `re-keyed journal write failed: ${error instanceof Error ? error.message : String(error)}` }
  }

  // S2 — COLD server-side session seed (spec §3.2, FIX 1). THE fallback
  // trigger: a missing/partial persistence seam or a failing create/append
  // returns {rotated:false} — invoke.ts then runs the legacy in-place path
  // with a loud log. The seed is persisted via the dsh-session-persistence
  // seam (`create` registers detached lazy metadata at cursor 0 —
  // dsh-session-persistence lib:802-816; `append` seq-validates and
  // materializes the artifact — lib:824-840), so the new session is written
  // to disk COLD and is NEVER attached to ctx.sessions. The later resume
  // (agents.resume → persistence.prepare) requires exactly that: its
  // live-guard rejects any id present in ctx.sessions ("cannot prepare
  // session … while it is live", lib:849-863/852) — the attached-but-
  // agentless state the old `ctx.get('sessions').create` manufactured.
  if (deps.persistence?.create === void 0 || deps.persistence?.append === void 0) {
    return { rotated: false, reason: "persistence seam unavailable (no ctx.get('sessionPersistence'))" }
  }
  const seed = buildRotationSeed(reKeyed)
  try {
    await deps.persistence.create({
      id: newSessionId,
      version: 0,
      createdAt: now(),
      cwd: deps.workspacePath,
      seedLength: seed.length,
      delegationDepth: 0
    })
    await deps.persistence.append(newSessionId, seed)
  } catch (error) {
    return { rotated: false, reason: `session create failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const actualSessionId = newSessionId

  // S2.5 — SERVER-SIDE ARCHIVE of the old session (D1). NON-FATAL: a registry
  // miss or a failing call logs loudly and the rotation still commits the
  // hosts.json retire (the durable part).
  const archive = await archiveOldSession(deps.workspaceRegistry, deps.oldSessionId, deps.logger)

  // S2.7 — belt-and-suspenders evidence COPY (D2). Best-effort, never throws.
  const archiveCopy = await copyOldArtifactToArchive({
    sessionsRoot: deps.sessionsRoot,
    oldSessionId: deps.oldSessionId,
    archiveDir: deps.archiveDir,
    now: now()
  })
  if (!archiveCopy.ok) {
    deps.logger.warn(`[deepartments] host rotation: pre-rotation artifact copy failed (non-fatal — G4 preserved by the untouched original): ${archiveCopy.reason ?? 'unknown'}`)
  }

  // S3 + S7 — rotate hosts.json (old retired + new live) + durable markers on
  // the NEW entry (sleepEpoch, boundarySeq); single persistHosts. Ordering
  // invariant (kept from the legacy Step-4 comment): the journal files exist
  // BEFORE sleepEpoch is durably persisted.
  const sleepEpoch = now()
  const oldEntry = deps.hosts.get(deps.oldHostId) ?? { hostId: deps.oldHostId, sessionId: deps.oldSessionId, roomId: deps.roomId }
  const records = hostsRotationRecords(oldEntry, actualSessionId, {
    newHostId,
    roomId: deps.roomId,
    sleepEpoch,
    boundarySeq: deps.boundarySeq,
    retiredAt
  })
  deps.hosts.set(newHostId, { hostId: newHostId, ...records.newEntry })
  const liveOld = deps.hosts.get(deps.oldHostId)
  if (liveOld !== void 0) {
    Object.assign(liveOld, records.oldEntry)
  } else {
    deps.hosts.set(deps.oldHostId, { hostId: deps.oldHostId, ...records.oldEntry })
  }
  deps.hostForSession?.set(actualSessionId, newHostId)
  deps.persistHosts()

  return {
    rotated: true,
    newHostId,
    newSessionId: actualSessionId,
    newJournalPath,
    reKeyedJournal: reKeyed,
    sleepEpoch,
    archive,
    archiveCopy
  }
}