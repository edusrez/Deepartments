// dsh-deepartments — O6 (VALLE 09-07): the ROTATION BASELINE assertion.
//
// Automates the hygiene invariants the Quality Department currently checks BY
// HAND in every D-Q3 host-rotation inspection (family
// quality/2026-08-<dia>-host-rotation-*.md): retained == archive + N, no turn
// post-sleep, write-ahead memo < sleep. THE CONTRACT is
// reports/explore-deep/2026-09-07-o6-rotation-baseline-design-7c8d90c1.md
// (§3 invariants I1-I6, §4.1 module shape, §5 knobs, §7 no-touch list).
//
// DESIGN RULES (spec 002 §8 + the lane decision M1):
//   * PURE — 0 io except the injected roots (stateDir/sessionsRoot/archiveDir)
//     and the injected file/artifact readers; 0 LLM; NEVER writes; NEVER
//     throws: every failure resolves {ok:false, violations:[...]} — missing
//     paths are `missing-artifact` violations, never exceptions.
//   * BOUNDED decode: artifacts are read through the injected `decodeArtifact`
//     seam (tests = full read of small fixtures; a runtime probe would zstd-
//     decode a bounded head/tail window) and a line budget (`artifact-too-large`
//     instead of a hang). Analyses run over what the decoder returned.
//   * T1 (HOST rotation spec 002) asserts I1-I6 in FULL; T2 (HEAD rotation
//     dept_head_rotate) is the REDUCED 'head' mode (no hosts.json, no re-key,
//     no snapshot, BOOT-QUIET successor); T3 (WORKER retire) does NOT apply
//     (no post-sleep turn exists by construction — the dispose-grace O1 rule —
//     and D-Q2 already covers the retire family; documented in the lane report).
//   * Severity: the module logs ONE `logger.warn` inline when violations are
//     found; NO dept_feedback emission from the assertion itself.
//
// The boundarySeq predicate (I5c) is FIXED against the three documented D-Q3
// baselines: the new hosts entry's boundarySeq equals the SEQ OF THE dept_sleep
// tool/RESULT in the old artifact (evidence: boundarySeq 295016 == seq of the
// dept_sleep tool/result; `agent.session.seq` is read at tool execution time,
// when the log ends at the tool/call, so the recorded value lands on the NEXT
// event — the tool/result).
//
// T4 DISCRIMINATOR: a restart (the same session ids, or a boot since the last
// retirement — marker.json `lastBootAt` after the old entry's retiredAt / an
// old entry with NO retiredAt) is NOT a rotation: the assertion SKIPS with
// {ok:true, skipped} instead of reporting a false positive on a resumed
// artifact that only GROWS contiguously. The marker branch applies to the
// runtime probe (M2, deferred to backlog); M1 covers the ids-equal branch + a
// marker fixture.

import path from 'node:path'
import { findSessionArtifact } from './session-cleanup.js'
import { rekeyJournal, validateHostsRotationFile } from './session-rotation.js'
import { parseDeliveryRows, parseMessageRecords, resolveDeliveriesPath, resolveMessagesPath } from './messages.js'

/** One baseline violation: a machine code + a human detail. */
export interface RotationBaselineViolation {
  code: string
  detail: string
}

/** The assertion result. `ok` = zero violations. `skipped` is set when the T4
 * discriminator classified the invocation as a restart, not a rotation (the
 * caller must then NOT interpret the artifacts as a rotation). */
export interface RotationBaselineResult {
  ok: boolean
  violations: RotationBaselineViolation[]
  skipped?: 'restart-same-ids' | 'restart-after-boot'
}

/** T1 (host rotation, spec 002) asserts the full D-Q3 set; T2 (head rotation
 * dept_head_rotate) reduces to the head-applicable subset (no hosts.json, no
 * re-key, no snapshot, BOOT-QUIET successor). */
export type RotationBaselineMode = 'host' | 'head'

/** Dependency surface of one assertion run. Every path is derived from the
 * injected roots; the file readers are injected so the pure-fixture suite
 * runs with ZERO fs and the integration suite runs against real state. */
export interface RotationBaselineDeps {
  mode?: RotationBaselineMode
  /** `<stateDir>` — hosts.json + journals/ + messages.jsonl/deliveries.jsonl. */
  stateDir: string
  /** The state-home sessions root (artifact lookup, same derive as lifecycle.ts:537-540). */
  sessionsRoot: string
  /** The state-home evidence archive dir (snapshots). */
  archiveDir: string
  oldSessionId: string
  newSessionId: string
  hostIdOld: string
  hostIdNew: string
  /** Artifact decode seam (DI): tests read plain fixtures; a runtime probe
   * would zstd-decode a bounded head/tail window. `byteOk` false = the
   * artifact does not decode (violation `artifact-undecodable`). */
  decodeArtifact: (artifactPath: string) => Promise<{ lines: string[]; byteOk: boolean }>
  /** Text-file read seam (DI): undefined = missing/unreadable (→ `missing-artifact`). */
  readFileText: (filePath: string) => Promise<string | undefined>
  /** Artifact locator (DI; default = findSessionArtifact's sessions-root scan). */
  findArtifact?: (sessionsRoot: string, sessionId: string) => Promise<string | undefined>
  /** The S2.7 snapshot path (DI; default = scan archiveDir for the canonical
   * `session-<oldId>-pre-rotation-<stamp>.jsonl.zstd` name, latest stamp). */
  snapshotPath?: string
  hostsPath?: string
  messagesPath?: string
  deliveriesPath?: string
  oldJournalPath?: string
  newJournalPath?: string
  /** The smart-restart marker (T4 discriminator). Absent → the marker branch
   * is inert (all M1 fixture/integration runs). */
  markerPath?: string
  /** PR-2 settle window: a terminal delivery row must land in
   * [retiredAt, retiredAt + settleWindowMs] (default 5 min — the in-session
   * settle runs inside the sleep turn itself). */
  settleWindowMs?: number
  /** Line budget for one artifact decode (default 100_000 — fixtures are tiny;
   * a pathological/oversized artifact violates `artifact-too-large`). */
  maxArtifactLines?: number
  logger?: { warn(message: string): void }
}

/** Default PR-2 settle observation window (see deps.settleWindowMs). */
export const DEFAULT_SETTLE_WINDOW_MS = 5 * 60_000

/** Default per-artifact line budget (see deps.maxArtifactLines). */
export const DEFAULT_MAX_ARTIFACT_LINES = 100_000

/** Accepted I1b deltas: {0} post-finalize (m-423 snapshot-anchor), {3,4}
 * pre-finalize (tool/result → step/end → turn/end, ±1 trailing log-only node).
 * The HARD zombie lock is delta ≥ 8 (the m-437/m-438 +66/151 class). */
export const ACCEPTED_SNAPSHOT_DELTAS: readonly number[] = [0, 3, 4]
export const HARD_ZOMBIE_DELTA = 8

/** I5a stamp tolerance: the archive name stamp (YYYYMMDD-HHmmss) must match
 * the old entry's retiredAt within ±10 min. */
export const SNAPSHOT_STAMP_TOLERANCE_MS = 10 * 60_000

// ---------------------------------------------------------------------------
// Parsed-artifact shape + parsing (bounded, tolerant, never throws).
// ---------------------------------------------------------------------------

interface ArtifactEvent {
  seq: number
  type: string
  time?: number
  data: Record<string, unknown>
}

interface ParsedArtifact {
  path: string
  lines: string[]
  byteOk: boolean
  tooLarge: boolean
  events: ArtifactEvent[]
}

/** The internal accumulator of one run. */
interface VerifyState {
  violations: RotationBaselineViolation[]
}

/** Parse JSONL artifact lines into events. Lines that are not event objects
 * (the header row, blank lines, a trailing partial line) are skipped
 * defensively — the same tolerance as parseSessionLog. */
function parseArtifactLines(lines: string[]): ArtifactEvent[] {
  const events: ArtifactEvent[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const obj = parsed as Record<string, unknown>
    if (typeof obj.type !== 'string' || typeof obj.seq !== 'number') continue
    events.push({
      seq: obj.seq,
      type: obj.type,
      time: typeof obj.time === 'number' ? obj.time : undefined,
      data: (typeof obj.data === 'object' && obj.data !== null ? obj.data : {}) as Record<string, unknown>
    })
  }
  events.sort((a, b) => a.seq - b.seq)
  return events
}

async function loadArtifact(deps: RotationBaselineDeps, artifactPath: string): Promise<ParsedArtifact> {
  let decoded: { lines: string[]; byteOk: boolean }
  try {
    decoded = await deps.decodeArtifact(artifactPath)
  } catch {
    decoded = { lines: [], byteOk: false }
  }
  if (decoded === null || typeof decoded !== 'object' || typeof decoded.byteOk !== 'boolean') {
    decoded = { lines: [], byteOk: false }
  }
  if (!decoded.byteOk) {
    return { path: artifactPath, lines: [], byteOk: false, tooLarge: false, events: [] }
  }
  const lines = Array.isArray(decoded.lines) ? decoded.lines : []
  const tooLarge = lines.length > (deps.maxArtifactLines ?? DEFAULT_MAX_ARTIFACT_LINES)
  const events = parseArtifactLines(lines)
  return { path: artifactPath, lines, byteOk: true, tooLarge, events }
}

/** stable-enough identity of one event for the no-replay (I2d) comparison:
 * type + time + JSON of the data. */
function eventSignature(ev: ArtifactEvent): string {
  let dataJson: string
  try {
    dataJson = JSON.stringify(ev.data)
  } catch {
    dataJson = String(ev.data)
  }
  return `${ev.type}|${ev.time ?? '?'}|${dataJson}`
}

function toolName(ev: ArtifactEvent): string | undefined {
  const n = ev.data?.['name']
  return typeof n === 'string' ? n : undefined
}

function callIdOf(ev: ArtifactEvent): string | undefined {
  const c = ev.data?.['callId']
  return typeof c === 'string' ? c : undefined
}

function turnOf(ev: ArtifactEvent): number | undefined {
  const t = ev.data?.['turn']
  return typeof t === 'number' ? t : undefined
}

/** A tool/result that carried no internal failure (isError:false — the
 * optional `error` identity absent + the message's isError flag not true). */
function isCleanToolResult(ev: ArtifactEvent): boolean {
  if (ev.type !== 'tool/result') return false
  if (ev.data?.['error'] !== undefined) return false
  const message = ev.data?.['message']
  if (message !== null && typeof message === 'object' && (message as { isError?: unknown }).isError === true) return false
  return true
}

function messageTextOf(ev: ArtifactEvent): string {
  const content = ev.data?.['content']
  if (!Array.isArray(content) || content.length === 0) return ''
  const first = content[0]
  if (first !== null && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string') {
    return (first as { text: string }).text
  }
  return ''
}

function isJournalLikeText(text: string): boolean {
  return text.startsWith('---\nauthor: ')
}

/** hosts.json → the parsed entry records (hostId → fields; schemaVersion skipped). */
async function loadHosts(deps: RotationBaselineDeps): Promise<Record<string, Record<string, unknown>> | undefined> {
  const hostsPath = deps.hostsPath ?? path.join(deps.stateDir, 'hosts.json')
  const text = await deps.readFileText(hostsPath)
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const entries: Record<string, Record<string, unknown>> = {}
  for (const [hostId, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (hostId === 'schemaVersion') continue
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      entries[hostId] = raw as Record<string, unknown>
    }
  }
  return entries
}

/** Find the S2.7 snapshot under archiveDir by the canonical name for
 * `oldSessionId`; multiple stamps pick the LATEST (a double rotation leaves
 * one per chain link). */
async function scanSnapshotPath(deps: RotationBaselineDeps, oldSessionId: string): Promise<string | undefined> {
  const escaped = oldSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^session-${escaped}-pre-rotation-(\\d{8})-(\\d{6})\\.jsonl\\.zstd$`)
  try {
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(deps.archiveDir)
    let best: { name: string; stampSeq: number } | undefined
    for (const name of names) {
      const match = pattern.exec(name)
      if (match === null) continue
      const stampSeq = Number(match[1]) * 1000000 + Number(match[2])
      if (best === undefined || stampSeq > best.stampSeq) best = { name, stampSeq }
    }
    return best === undefined ? undefined : path.join(deps.archiveDir, best.name)
  } catch {
    return undefined
  }
}

/** Parse the canonical archive stamp (YYYYMMDD-HHmmss, LOCAL components — the
 * exact convention of session-rotation.ts formatBackupStamp) to epoch ms. */
function parseArchiveStampToEpoch(stamp: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  if (match === null) return undefined
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), 0)
  const epoch = date.getTime()
  return Number.isNaN(epoch) ? undefined : epoch
}

function numField(entry: Record<string, unknown> | undefined, key: string): number | undefined {
  if (entry === undefined) return undefined
  const v = entry[key]
  return typeof v === 'number' ? v : undefined
}

function strField(entry: Record<string, unknown> | undefined, key: string): string | undefined {
  if (entry === undefined) return undefined
  const v = entry[key]
  return typeof v === 'string' ? v : undefined
}

function boolField(entry: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (entry === undefined) return undefined
  const v = entry[key]
  return typeof v === 'boolean' ? v : undefined
}

// ---------------------------------------------------------------------------
// The assertion.
// ---------------------------------------------------------------------------

/** Verify ONE rotation's durable hygiene invariants (I1-I6 of the design §3)
 * over the artifacts it produced. Pure: 0 writes, 0 LLM, 0 throw — always
 * resolves. Missing paths are `missing-artifact` violations. The T4
 * discriminator (same ids / boot-after-retirement via marker.json) skips with
 * {ok:true, skipped}. */
export async function verifyRotationBaseline(deps: RotationBaselineDeps): Promise<RotationBaselineResult> {
  const state: VerifyState = { violations: [] }
  const mode = deps.mode ?? 'host'

  // ---- T4 discriminator FIRST (before any artifact read). HOST mode only:
  // a head-rotation successor legitimately shares the MEMBER id (the stable
  // postId) across the rotation — the discriminator must not skip it. -------
  if (mode !== 'head') {
    if (deps.hostIdOld === deps.hostIdNew || deps.oldSessionId === deps.newSessionId) {
      // A resume keeps the SAME session identity — the artifact only grows
      // contiguously; nothing rotated, nothing to verify.
      return { ok: true, violations: [], skipped: 'restart-same-ids' }
    }
    if (deps.markerPath !== undefined && (await isMarkerRestart(deps))) {
      return { ok: true, violations: [], skipped: 'restart-after-boot' }
    }
  }

  try {
    await verifyCore(deps, state)
  } catch (error) {
    // Never throw — a runaway internal fault degrades to a violation.
    state.violations.push({ code: 'verification-fault', detail: error instanceof Error ? error.message : String(error) })
  }

  if (state.violations.length > 0 && deps.logger?.warn !== undefined) {
    // Severity decision (lane): a WARN inline in the module; no dept_feedback.
    deps.logger.warn(`[deepartments] ROTATION BASELINE VIOLATION (${state.violations.length}): ${JSON.stringify(state.violations)}`)
  }
  return { ok: state.violations.length === 0, violations: state.violations }
}

/** T4 marker branch: when the smart-restart marker's `lastBootAt` is at/after
 * the old entry's retirement (or the old entry has NO retiredAt at all), the
 * invocation pair is a pre-boot reference — a restart, not a rotation.
 * Never throws (any read/parse fault → proceed as a rotation; the M1 suite
 * never provides a marker path, so this branch is fixture-driven only). */
async function isMarkerRestart(deps: RotationBaselineDeps): Promise<boolean> {
  try {
    if (deps.markerPath === undefined) return false
    const markerText = await deps.readFileText(deps.markerPath)
    if (markerText === undefined) return false
    const marker = JSON.parse(markerText) as { lastBootAt?: unknown }
    if (typeof marker.lastBootAt !== 'number') return false
    const hosts = await loadHosts(deps)
    const oldEntry = hosts === undefined ? undefined : hosts[deps.hostIdOld]
    const retiredAt = numField(oldEntry, 'retiredAt')
    return retiredAt === undefined || retiredAt < marker.lastBootAt
  } catch {
    return false
  }
}

async function verifyCore(
  deps: RotationBaselineDeps,
  state: VerifyState
): Promise<void> {
  const warn = (code: string, detail: string): void => {
    state.violations.push({ code, detail })
  }
  const mode = deps.mode ?? 'host'

  // ---- Artifact + ledger discovery --------------------------------------------
  const findArtifact = deps.findArtifact ?? findSessionArtifact
  let oldArtifactPath: string | undefined
  let newArtifactPath: string | undefined
  try {
    oldArtifactPath = await findArtifact(deps.sessionsRoot, deps.oldSessionId)
  } catch (error) {
    warn('missing-artifact', `old artifact lookup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    newArtifactPath = await findArtifact(deps.sessionsRoot, deps.newSessionId)
  } catch (error) {
    warn('missing-artifact', `new artifact lookup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (oldArtifactPath === undefined) {
    warn('missing-artifact', `old artifact for ${deps.oldSessionId} not found under ${deps.sessionsRoot}`)
  }
  if (newArtifactPath === undefined) {
    warn('missing-artifact', `new artifact for ${deps.newSessionId} not found under ${deps.sessionsRoot}`)
  }

  const oldArtifact = oldArtifactPath === undefined ? undefined : await loadArtifact(deps, oldArtifactPath)
  const newArtifact = newArtifactPath === undefined ? undefined : await loadArtifact(deps, newArtifactPath)
  if (oldArtifact !== undefined && !oldArtifact.byteOk) {
    warn('artifact-undecodable', `old artifact ${oldArtifact.path} does not decode (zstd/format fault)`)
  }
  if (newArtifact !== undefined && !newArtifact.byteOk) {
    warn('artifact-undecodable', `new artifact ${newArtifact.path} does not decode (zstd/format fault)`)
  }

  // ---- Ledger files -------------------------------------------------------------
  let hosts: Record<string, Record<string, unknown>> | undefined
  if (mode === 'host') {
    hosts = await loadHosts(deps)
    if (hosts === undefined) {
      warn('missing-artifact', `hosts.json not found/parseable at ${deps.hostsPath ?? path.join(deps.stateDir, 'hosts.json')}`)
    }
  }

  const oldJournalPath = deps.oldJournalPath ?? path.join(deps.stateDir, 'journals', `${deps.hostIdOld}.md`)
  const newJournalPath = deps.newJournalPath ?? path.join(deps.stateDir, 'journals', `${deps.hostIdNew}.md`)
  const hjOld = await deps.readFileText(oldJournalPath)
  const hjNew = mode === 'host' ? await deps.readFileText(newJournalPath) : undefined
  if (mode === 'host') {
    if (hjOld === undefined) warn('missing-artifact', `old journal ${oldJournalPath} not found`)
    if (hjNew === undefined) warn('missing-artifact', `new journal ${newJournalPath} not found`)
  }

  const messagesPath = deps.messagesPath ?? resolveMessagesPath(deps.stateDir)
  const deliveriesPath = deps.deliveriesPath ?? resolveDeliveriesPath(deps.stateDir)
  const messagesText = await deps.readFileText(messagesPath)
  const deliveriesText = await deps.readFileText(deliveriesPath)
  let messageRecords: Array<Record<string, unknown>> | undefined
  if (mode === 'host' && messagesText === undefined) {
    warn('missing-artifact', `messages ledger ${messagesPath} not found (the rotation-wake handoff record is mandatory for a host rotation)`)
  } else if (messagesText !== undefined) {
    try {
      messageRecords = parseMessageRecords(messagesText, messagesPath).map((r) => r as unknown as Record<string, unknown>)
    } catch (error) {
      warn('ledger-corrupt', `messages ledger parse failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let deliveryRows: Array<Record<string, unknown>>
  if (deliveriesText === undefined) {
    deliveryRows = [] // a fresh stateDir may have no deliveries — empty set, nothing pending
  } else {
    try {
      deliveryRows = parseDeliveryRows(deliveriesText, deliveriesPath).map((r) => r as unknown as Record<string, unknown>)
    } catch (error) {
      warn('ledger-corrupt', `deliveries ledger parse failed: ${error instanceof Error ? error.message : String(error)}`)
      deliveryRows = []
    }
  }

  // ---- I2a/I2b: the OLD artifact's sleep turn + no post-sleep turn ---------------
  // (head mode: no dept_sleep tool exists — only the closed-turn + no-orphan part.)
  const sleepPair = oldArtifact === undefined || mode === 'head' ? undefined : locateSleepPair(oldArtifact, warn)
  if (oldArtifact !== undefined) {
    assertNoPostSleepTurn(deps, warn, oldArtifact, sleepPair)
  }

  // ---- I2c/I2d + I3c: the successor's shape ---------------------------------------
  if (newArtifact !== undefined) {
    assertSuccessorShape(deps, warn, oldArtifact, newArtifact, mode)
    assertJournalNodeVerbatim(warn, newArtifact, mode, hjNew, hjOld)
  }

  // ---- I3a/I3b/I3d: write-ahead + the re-keyed journal pair (host mode) -----------
  if (mode === 'host') {
    assertWriteAhead(warn, oldArtifact, sleepPair)
    assertJournalPair(deps, warn, hjOld, hjNew)
  }

  // ---- I4: hosts.json ledger (host mode) ---------------------------------------------
  if (mode === 'host') {
    assertHostsLedger(deps, warn, hosts)
  }

  // ---- I1 + I5: retained == archive + boundary (host mode) ---------------------------
  if (mode === 'host') {
    await assertArchiveAndBoundary(deps, warn, oldArtifact, sleepPair, hosts)
  }

  // ---- I6: handoff + settle -------------------------------------------------------------
  await assertHandoffAndSettle(deps, warn, newArtifact, messageRecords, deliveryRows, hosts, mode)
}

/** Locate the dept_sleep tool/call + its immediate clean result in the OLD
 * artifact's LAST turn. Reports the shape violation when the pair is broken. */
function locateSleepPair(
  artifact: ParsedArtifact,
  warn: (code: string, detail: string) => void
): { call: ArtifactEvent; result: ArtifactEvent; callIndex: number } | undefined {
  const events = artifact.events
  if (events.length === 0) {
    warn('sleep-tool-shape', 'old artifact has no parseable events')
    return undefined
  }
  // The last turn number = the LAST turn/start's `turn` (falls back to the
  // max `turn` among events when no turn/start exists).
  let lastTurn: number | undefined
  const turnStarts = events.filter((ev) => ev.type === 'turn/start')
  if (turnStarts.length > 0) {
    lastTurn = turnOf(turnStarts[turnStarts.length - 1])
  } else {
    for (const ev of events) {
      const t = turnOf(ev)
      if (t !== undefined && (lastTurn === undefined || t > lastTurn)) lastTurn = t
    }
  }
  const sleepCalls = events
    .map((ev, index) => ({ ev, index }))
    .filter(({ ev }) => ev.type === 'tool/call' && toolName(ev) === 'dept_sleep')
  const inLastTurn = sleepCalls.filter(({ ev }) => (lastTurn === undefined ? true : turnOf(ev) === lastTurn))
  if (sleepCalls.length !== 1 || inLastTurn.length !== 1) {
    warn('sleep-tool-shape', `expected exactly ONE dept_sleep tool/call in the old artifact's last turn (found ${sleepCalls.length} total, ${inLastTurn.length} in turn ${String(lastTurn)})`)
    return undefined
  }
  const { ev: call, index: callIndex } = inLastTurn[0]
  // The tool/result must be the IMMEDIATE next event, same callId, isError:false.
  const result = events[callIndex + 1]
  if (result === undefined || result.type !== 'tool/result' || callIdOf(result) !== callIdOf(call) || !isCleanToolResult(result)) {
    warn('sleep-tool-shape', `dept_sleep tool/call (seq ${call.seq}) is not immediately followed by its clean tool/result (next: ${result === undefined ? 'none' : `${result.type}@${result.seq}`})`)
    return undefined
  }
  return { call, result, callIndex }
}

/** I2a — the OLD artifact must end inside a closed turn and carry NO turn/start
 * after the dept_sleep turn's close (the zombie lock: an orphan or duplicated
 * turn/start after the boundary). */
function assertNoPostSleepTurn(
  deps: RotationBaselineDeps,
  warn: (code: string, detail: string) => void,
  artifact: ParsedArtifact,
  sleepPair: { call: ArtifactEvent; result: ArtifactEvent; callIndex: number } | undefined
): void {
  if (artifact.tooLarge) {
    warn('artifact-too-large', `old artifact ${artifact.path} exceeds ${deps.maxArtifactLines ?? DEFAULT_MAX_ARTIFACT_LINES} lines — bounded analyses skipped`)
    return
  }
  if (artifact.events.length === 0) return
  const events = artifact.events
  const last = events[events.length - 1]
  const allowedFinal = ['turn/end', 'step/end', 'tool/result']
  if (!allowedFinal.includes(last.type)) {
    warn('final-event', `old artifact ends with ${last.type}@${last.seq} — expected one of {${allowedFinal.join(', ')}}`)
  } else if (last.type === 'turn/end') {
    const reason = last.data?.['reason']
    const kind = reason !== null && typeof reason === 'object' ? (reason as { kind?: unknown }).kind : undefined
    if (kind !== 'completed') {
      warn('final-event', `old artifact ends with turn/end@${last.seq} reason ${String(kind)} — expected 'completed'`)
    }
  }
  if (sleepPair === undefined) {
    // Head-mode / pre-finalize OLD without the sleep pair: the orphan boundary
    // falls back to the artifact's LAST turn/end (nothing may open a NEW turn
    // after the last closed one).
    const lastTurnEnd = events.filter((ev) => ev.type === 'turn/end').at(-1)
    const boundary = lastTurnEnd === undefined ? Number.MAX_SAFE_INTEGER : lastTurnEnd.seq
    const orphanStarts = events.filter((ev) => ev.type === 'turn/start' && ev.seq > boundary)
    if (orphanStarts.length > 0) {
      warn('post-rotation-turn', `turn/start after the last turn/end: ${orphanStarts.map((ev) => `seq ${ev.seq} (turn ${String(turnOf(ev))})`).join(', ')} (zombie class m-437/m-438)`)
    }
    return
  }
  // The post-sleep boundary: the seq of the dept_sleep turn's turn/end (when
  // present), else the seq of the sleep tool/result.
  const lastTurn = turnOf(sleepPair.call)
  let boundary = sleepPair.result.seq
  for (const ev of events) {
    if (ev.type === 'turn/end' && turnOf(ev) === lastTurn) boundary = Math.max(boundary, ev.seq)
  }
  const orphanStarts = events.filter((ev) => ev.type === 'turn/start' && ev.seq > boundary)
  // Duplicated turn/start (same turn number twice) also fires the lock.
  const seenTurns = new Set<number>()
  let duplicated = false
  for (const ev of events) {
    if (ev.type !== 'turn/start') continue
    const t = turnOf(ev)
    if (t === undefined) continue
    if (seenTurns.has(t)) duplicated = true
    seenTurns.add(t)
  }
  if (orphanStarts.length > 0 || duplicated) {
    const detail = orphanStarts.length > 0
      ? `turn/start after the dept_sleep turn close: ${orphanStarts.map((ev) => `seq ${ev.seq} (turn ${String(turnOf(ev))})`).join(', ')} (zombie class m-437/m-438)`
      : 'a turn/start number is duplicated (zombie class — out-of-order/duplicated turn opens)'
    warn('post-rotation-turn', detail)
  }
}

/** I2c/I2d — the NEW artifact's pre-turn block is the balanced seed (+end-seed
 * + the handoff notice), no second orphan turn/start after the first turn/end,
 * and no event replays an OLD event. */
function assertSuccessorShape(
  deps: RotationBaselineDeps,
  warn: (code: string, detail: string) => void,
  oldArtifact: ParsedArtifact | undefined,
  newArtifact: ParsedArtifact,
  mode: RotationBaselineMode
): void {
  if (newArtifact.tooLarge) {
    warn('artifact-too-large', `new artifact ${newArtifact.path} exceeds ${deps.maxArtifactLines ?? DEFAULT_MAX_ARTIFACT_LINES} lines — bounded analyses skipped`)
    return
  }
  if (!newArtifact.byteOk) return // artifact-undecodable already reported
  const events = newArtifact.events
  if (events.length === 0) {
    warn('seed-unbalanced', 'new artifact has no parseable events')
    return
  }
  const firstTurnStartIndex = events.findIndex((ev) => ev.type === 'turn/start')
  const preTurn = firstTurnStartIndex === -1 ? events : events.slice(0, firstTurnStartIndex)

  const seedTypes = ['permission/preset', 'sandbox/mode', 'approval/policy', 'user/message', 'session/title']
  const allowedPreTurn = new Set([...seedTypes, 'session/end-seed'])
  let unbalanced = ''
  if (preTurn.length < 5) {
    unbalanced = `pre-turn block has ${preTurn.length} events — expected at least the 5-event balanced seed`
  } else {
    for (let i = 0; i < 5; i++) {
      const ev = preTurn[i]
      if (ev.type !== seedTypes[i] || ev.seq !== i) {
        unbalanced = `seed index ${i}: expected ${seedTypes[i]}@seq ${i}, got ${ev.type}@${ev.seq}`
        break
      }
    }
    if (unbalanced === '') {
      for (const ev of preTurn.slice(5)) {
        if (!allowedPreTurn.has(ev.type)) {
          unbalanced = `unexpected pre-turn event ${ev.type}@${ev.seq} (allowed after the seed: session/end-seed + the handoff notice)`
          break
        }
      }
    }
  }
  const otherUserBeforeCount = preTurn.filter((ev) => ev.type === 'user/message' && !isJournalLikeText(messageTextOf(ev))).length
  if (mode === 'host' && otherUserBeforeCount > 1) {
    unbalanced = `${unbalanced === '' ? '' : unbalanced + '; '}pre-turn user/message nodes beyond the seed journal: ${otherUserBeforeCount} (only the seed journal + ONE host-rotation handoff notice are legal)`
  }
  if (mode === 'head' && otherUserBeforeCount > 0) {
    unbalanced = `${unbalanced === '' ? '' : unbalanced + '; '}a head-rotation successor must be BOOT-QUIET — no pre-turn notice node found (${otherUserBeforeCount})`
  }
  const endSeedCount = preTurn.filter((ev) => ev.type === 'session/end-seed').length
  if (endSeedCount !== 1) {
    unbalanced = `${unbalanced === '' ? '' : unbalanced + '; '}expected exactly ONE session/end-seed marker in the pre-turn block (found ${endSeedCount})`
  }
  if (unbalanced !== '') {
    warn('seed-unbalanced', unbalanced)
  }

  // I2c second half: no second turn/start after the first turn/end.
  const firstTurnEndIndex = events.findIndex((ev) => ev.type === 'turn/end')
  if (firstTurnEndIndex !== -1) {
    const laterStarts = events.slice(firstTurnEndIndex + 1).filter((ev) => ev.type === 'turn/start')
    if (laterStarts.length > 0) {
      warn('orphan-turn-start', `a second turn/start appears after the new artifact's first turn/end: ${laterStarts.map((ev) => `seq ${ev.seq}`).join(', ')}`)
    }
  }

  // I2d: no NEW event replays an OLD event (same type+time+data identity).
  if (oldArtifact !== undefined && oldArtifact.byteOk && !oldArtifact.tooLarge) {
    const oldSignatures = new Set(oldArtifact.events.map(eventSignature))
    for (const ev of events) {
      if (oldSignatures.has(eventSignature(ev))) {
        warn('seq-replay', `new artifact replays an old artifact event: ${ev.type}@${ev.seq} (identical type/time/data — the old queue was not replayed into the successor)`)
        break
      }
    }
  }
}

/** I3c — the seed's journal node (NEW seq-3 user/message) carries the journal
 * VERBATIM: in host mode the re-keyed new journal; in head mode the raw old
 * journal (no re-key — the head journal is seeded verbatim). */
function assertJournalNodeVerbatim(
  warn: (code: string, detail: string) => void,
  newArtifact: ParsedArtifact,
  mode: RotationBaselineMode,
  hjNew: string | undefined,
  hjOld: string | undefined
): void {
  if (newArtifact.tooLarge || !newArtifact.byteOk) return
  const journalNode = newArtifact.events.find(
    (ev) => ev.type === 'user/message' && isJournalLikeText(messageTextOf(ev))
  )
  if (journalNode === undefined) {
    warn('seed-journal-truncated', 'the new artifact carries NO journal node in its seed (the re-keyed/verbatim journal must be the seq-3 user/message)')
    return
  }
  const expected = mode === 'host' ? hjNew : hjOld
  if (expected === undefined) return // missing-artifact already reported
  const actual = messageTextOf(journalNode)
  if (actual !== expected) {
    warn('seed-journal-truncated', `the seed journal node (seq ${journalNode.seq}) is NOT the ${mode === 'host' ? 're-keyed new journal' : 'verbatim head journal'} (${expected.length} vs ${actual.length} chars — truncated or rewritten)`)
  }
}

/** I3a — write-ahead: the LAST dept_memo_write tool/result seq must be < the
 * dept_sleep tool/call seq in the OLD artifact. */
function assertWriteAhead(
  warn: (code: string, detail: string) => void,
  oldArtifact: ParsedArtifact | undefined,
  sleepPair: { call: ArtifactEvent; result: ArtifactEvent; callIndex: number } | undefined
): void {
  if (oldArtifact === undefined || oldArtifact.tooLarge || !oldArtifact.byteOk) return
  if (sleepPair === undefined) return
  const events = oldArtifact.events
  let lastMemoResultSeq: number | undefined
  const memoCalls = events
    .map((ev, index) => ({ ev, index }))
    .filter(({ ev }) => ev.type === 'tool/call' && toolName(ev) === 'dept_memo_write')
  for (const { ev: call, index } of memoCalls) {
    const result = events[index + 1]
    if (result !== undefined && result.type === 'tool/result' && callIdOf(result) === callIdOf(call)) {
      lastMemoResultSeq = result.seq
    }
  }
  if (lastMemoResultSeq === undefined) return // no memo tool in the artifact — the I3b journal pair governs
  if (lastMemoResultSeq >= sleepPair.call.seq) {
    warn('memo-after-sleep', `write-ahead violated: last dept_memo_write tool/result at seq ${lastMemoResultSeq} is NOT before the dept_sleep tool/call at seq ${sleepPair.call.seq} (memo must precede sleep)`)
  }
}

/** I3b/I3d — the re-keyed journal pair: HJ_new == rekeyJournal(HJ_old)
 * byte-for-byte (only the author line changes), and re-keying HJ_new back to
 * the old author reproduces HJ_old byte-for-byte (nothing truncated or
 * renumbered). */
function assertJournalPair(
  deps: RotationBaselineDeps,
  warn: (code: string, detail: string) => void,
  hjOld: string | undefined,
  hjNew: string | undefined
): void {
  if (hjOld === undefined || hjNew === undefined) return // missing-artifact already reported
  let rekeyed: string
  try {
    rekeyed = rekeyJournal(hjOld, deps.hostIdNew)
  } catch (error) {
    warn('journal-rekey-mismatch', `old journal cannot be re-keyed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (rekeyed !== hjNew) {
    warn('journal-rekey-mismatch', `HJ_new is not rekeyJournal(HJ_old) byte-for-byte (${rekeyed.length} vs ${hjNew.length} chars — the S1.5b re-key must be the ONLY mutation)`)
  }
  let rekeyedBack: string
  try {
    rekeyedBack = rekeyJournal(hjNew, deps.hostIdOld)
  } catch (error) {
    warn('journal-tampered', `new journal cannot be re-keyed back: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (rekeyedBack !== hjOld) {
    warn('journal-tampered', `HJ_old is not rekeyJournal(HJ_new) byte-for-byte — the old journal was truncated, renumbered or further mutated beyond the author re-key`)
  }
}

/** I4 — hosts.json ledger (host mode): validation reuses the loader (I4a),
 * exactly one non-retired host (I4b), the rotatedTo/previousSessionId pair
 * (I4c) and a cycle/orphan-free chain (I4d). */
function assertHostsLedger(
  deps: RotationBaselineDeps,
  warn: (code: string, detail: string) => void,
  hosts: Record<string, Record<string, unknown>> | undefined
): void {
  if (hosts === undefined) return // missing-artifact already reported
  // I4a — reuse the loader validation (throws → violation, never propagates).
  const parsedDoc: Record<string, unknown> = { schemaVersion: 2, ...hosts }
  try {
    validateHostsRotationFile(parsedDoc)
  } catch (error) {
    warn('hosts-validation', `validateHostsRotationFile failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  // I4b — EXACTLY ONE non-retired host entry.
  const live = Object.entries(hosts).filter(([hostId, entry]) => hostId.startsWith('host-') && boolField(entry, 'retired') !== true)
  if (live.length !== 1) {
    warn('hosts-live-count', `expected EXACTLY ONE non-retired host entry, found ${live.length} (${live.map(([id]) => id).join(', ') || 'none'})`)
  }
  // I4c — the rotation link.
  const oldEntry = hosts[deps.hostIdOld]
  const newEntry = hosts[deps.hostIdNew]
  const rotatedTo = strField(oldEntry, 'rotatedTo')
  const previousSessionId = strField(newEntry, 'previousSessionId')
  if (rotatedTo !== deps.hostIdNew || previousSessionId !== deps.oldSessionId) {
    warn('hosts-chain-mismatch', `rotation link broken: old.rotatedTo=${String(rotatedTo)} (expected ${deps.hostIdNew}); new.previousSessionId=${String(previousSessionId)} (expected ${deps.oldSessionId})`)
  }
  // I4d — walk the previousSessionId chain: no revisits (cycles), every link
  // lands on a retired entry in the same file, and every retired entry's
  // rotatedTo names the successor host (no orphans).
  const seen = new Set<string>([deps.hostIdNew])
  let curHost = deps.hostIdNew
  let cur: Record<string, unknown> | undefined = newEntry
  for (let hops = 0; hops < Object.keys(hosts).length + 1; hops++) {
    const prevSession = strField(cur, 'previousSessionId')
    if (prevSession === undefined) break
    const prevHost = Object.keys(hosts).find(
      (id) => strField(hosts[id], 'sessionId') === prevSession && boolField(hosts[id], 'retired') === true
    )
    if (prevHost === undefined) {
      warn('hosts-chain-cycle', `previousSessionId ${prevSession} of ${curHost} references no retired entry in the same file (orphan link)`)
      break
    }
    if (seen.has(prevHost)) {
      warn('hosts-chain-cycle', `rotation chain cycles: ${[...seen, prevHost].join(' -> ')}`)
      break
    }
    if (strField(hosts[prevHost], 'rotatedTo') !== curHost) {
      warn('hosts-chain-cycle', `reverse link broken: retired ${prevHost}.rotatedTo=${String(strField(hosts[prevHost], 'rotatedTo'))} (expected ${curHost}) — orphan/mismatched chain`)
      break
    }
    seen.add(prevHost)
    curHost = prevHost
    cur = hosts[prevHost]
  }
}

/** I1 + I5 — retained == archive and the boundary (host mode): the SNAP exists
 * under the canonical pre-rotation name with stamp ≈ retiredAt (I5a), decodes
 * (I5b), is a PREFIX of OLD (I1a) with delta ∈ {0,3,4} and the hard zombie
 * lock at ≥ 8 (I1b/I1c), and the new entry's boundarySeq == the seq of the
 * dept_sleep tool/RESULT (I5c). */
async function assertArchiveAndBoundary(
  deps: RotationBaselineDeps,
  warn: (code: string, detail: string) => void,
  oldArtifact: ParsedArtifact | undefined,
  sleepPair: { call: ArtifactEvent; result: ArtifactEvent; callIndex: number } | undefined,
  hosts: Record<string, Record<string, unknown>> | undefined
): Promise<void> {
  const oldEntry = hosts === undefined ? undefined : hosts[deps.hostIdOld]
  const newEntry = hosts === undefined ? undefined : hosts[deps.hostIdNew]
  const retiredAt = numField(oldEntry, 'retiredAt')

  // -- I1a/I1b/I1c/I5a/I5b: the snapshot exists, decodes, is a prefix with a
  //    tolerable delta. --
  let snapPath = deps.snapshotPath
  if (snapPath === undefined) {
    snapPath = await scanSnapshotPath(deps, deps.oldSessionId)
  }
  if (snapPath === undefined) {
    warn('missing-artifact', `pre-rotation snapshot for ${deps.oldSessionId} not found under ${deps.archiveDir}`)
  } else {
    const baseName = path.basename(snapPath)
    const canonical = new RegExp(`^session-${deps.oldSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-pre-rotation-(\\d{8})-(\\d{6})\\.jsonl\\.zstd$`)
    const stampMatch = canonical.exec(baseName)
    if (stampMatch === null) {
      warn('snapshot-stamp', `snapshot name ${baseName} is not canonical (session-<oldId>-pre-rotation-<YYYYMMDD-HHmmss>.jsonl.zstd)`)
    } else if (retiredAt !== undefined) {
      const stampEpoch = parseArchiveStampToEpoch(`${stampMatch[1]}-${stampMatch[2]}`)
      if (stampEpoch === undefined) {
        warn('snapshot-stamp', `snapshot stamp ${stampMatch[1]}-${stampMatch[2]} is not parseable`)
      } else if (Math.abs(stampEpoch - retiredAt) > SNAPSHOT_STAMP_TOLERANCE_MS) {
        warn('snapshot-stamp', `snapshot stamp ${stampMatch[1]}-${stampMatch[2]} (epoch ${stampEpoch}) diverges from retiredAt ${retiredAt} by ${Math.abs(stampEpoch - retiredAt)}ms (> ${SNAPSHOT_STAMP_TOLERANCE_MS}ms)`)
      }
    }
    const snapArtifact = await loadArtifact(deps, snapPath)
    if (!snapArtifact.byteOk) {
      warn('artifact-undecodable', `snapshot ${baseName} does not decode (zstd/format fault)`)
    } else if (snapArtifact.tooLarge) {
      warn('artifact-too-large', `snapshot ${baseName} exceeds ${deps.maxArtifactLines ?? DEFAULT_MAX_ARTIFACT_LINES} lines`)
    } else if (oldArtifact !== undefined && oldArtifact.byteOk && !oldArtifact.tooLarge) {
      // I1a — SNAP is a PREFIX of OLD (every snap event, in order).
      const prefixOk = snapArtifact.events.length <= oldArtifact.events.length &&
        snapArtifact.events.every((sev, i) => {
          const oev = oldArtifact.events[i]
          return oev !== undefined && oev.seq === sev.seq && oev.type === sev.type
        })
      if (!prefixOk) {
        warn('snapshot-not-prefix', `snapshot events are not a prefix of the old artifact (${snapArtifact.events.length} vs ${oldArtifact.events.length} events)`)
      }
      // I1b/I1c — delta tolerance {0,3,4} + the hard zombie lock at ≥ 8.
      const delta = oldArtifact.lines.length - snapArtifact.lines.length
      if (delta >= HARD_ZOMBIE_DELTA) {
        warn('post-rotation-turn', `retained != archive + N: live artifact is ${delta} lines ahead of the snapshot (>= ${HARD_ZOMBIE_DELTA} — the m-437/m-438 zombie class; lock)`)
      } else if (!ACCEPTED_SNAPSHOT_DELTAS.includes(delta)) {
        warn('snapshot-delta', `retained != archive + N: delta ${delta} not in {${ACCEPTED_SNAPSHOT_DELTAS.join(',')}} (0 post-finalize m-423; 3/4 pre-finalize)`)
      }
    }
  }

  // -- I5c — the boundary seq (FIXED semantics): newEntry.boundarySeq == the
  //    seq of the dept_sleep tool/RESULT in the old artifact. --
  if (sleepPair !== undefined) {
    const boundarySeq = numField(newEntry, 'boundarySeq')
    if (boundarySeq === undefined) {
      warn('boundary-seq-mismatch', 'the new hosts entry carries NO boundarySeq')
    } else if (boundarySeq !== sleepPair.result.seq) {
      warn('boundary-seq-mismatch', `boundarySeq ${boundarySeq} != seq ${sleepPair.result.seq} of the dept_sleep tool/result (the fixed D-Q3 semantics: the recorded value lands on the tool/RESULT)`)
    }
  }
}

/** I6 — the successor woke ONLY by its handoff + the PR-2 settle:
 * EXACTLY ONE rotation-wake record to the new host (I6a), the new artifact's
 * first turn/start is post-handoff (I6b), and every pending pair of the old
 * whose record addresses the recipient has a terminal row inside the settle
 * window (I6c — ALTO-1/m-728 guard rows are EXCLUDED). Head mode asserts the
 * BOOT-QUIET invariant instead (zero records address the fresh head). */
async function assertHandoffAndSettle(
  deps: RotationBaselineDeps,
  warn: (code: string, detail: string) => void,
  newArtifact: ParsedArtifact | undefined,
  messageRecords: Array<Record<string, unknown>> | undefined,
  deliveryRows: Array<Record<string, unknown>>,
  hosts: Record<string, Record<string, unknown>> | undefined,
  mode: RotationBaselineMode
): Promise<void> {
  if (mode === 'head') {
    // T2: a head-rotation successor is BOOT-QUIET — NOTHING may wake it.
    const unexpected = (messageRecords ?? []).filter(
      (r) => strField(r, 'from') === 'deepartments'
        && Array.isArray(r['to']) && (r['to'] as unknown[]).includes(deps.hostIdNew)
    )
    if (unexpected.length > 0) {
      warn('handoff-count', `a head-rotation successor must stay BOOT-QUIET, but ${unexpected.length} durable record(s) address ${deps.hostIdNew}`)
    }
    return
  }

  // -- I6a — EXACTLY ONE rotation-wake handoff record to the NEW host. --
  const handoffRecords = (messageRecords ?? []).filter(
    (r) => strField(r, 'from') === 'deepartments'
      && typeof r['text'] === 'string' && /rotation/i.test(String(r['text']))
      && Array.isArray(r['to']) && (r['to'] as unknown[]).includes(deps.hostIdNew)
  )
  if (handoffRecords.length !== 1) {
    warn('handoff-count', `expected EXACTLY ONE rotation-wake handoff record to ${deps.hostIdNew}, found ${handoffRecords.length} (0 réplicas — write-ahead exactly-once)`)
  }

  // -- I6b — the new artifact's first turn/start is PÓSTUMO to the handoff. --
  if (newArtifact !== undefined && !newArtifact.tooLarge && newArtifact.byteOk && handoffRecords.length === 1) {
    const firstTurnStart = newArtifact.events.find((ev) => ev.type === 'turn/start')
    if (firstTurnStart !== undefined) {
      const handoffTs = numField(handoffRecords[0], 'ts')
      const turnTime = firstTurnStart.time
      if (handoffTs !== undefined && turnTime !== undefined && turnTime < handoffTs) {
        warn('handoff-order', `the new artifact's first turn/start (time ${turnTime}) PRECEDES the handoff record (ts ${handoffTs}) — the successor must wake only by its handoff`)
      }
    }
  }

  // -- I6c — PR-2 settle: pending pairs of the old, guard-excluded. --
  const retiredAt = hosts === undefined ? undefined : numField(hosts[deps.hostIdOld], 'retiredAt')
  const settleWindow = deps.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS
  const oldRecipients = new Set([deps.hostIdOld, deps.oldSessionId])
  const pending = deliveryRows.filter(
    (row) => row['status'] === 'prepared' || row['status'] === 'failed'
      ? oldRecipients.has(String(row['recipientId']))
      : false
  )
  const byId = new Map<string, Record<string, unknown>>()
  for (const record of messageRecords ?? []) {
    const id = strField(record, 'id')
    if (id !== undefined) byId.set(id, record)
  }
  const terminalPairs = new Set<string>()
  for (const row of deliveryRows) {
    if (row['status'] === 'terminal') {
      terminalPairs.add(`${String(row['messageId'])}|${String(row['recipientId'])}`)
    }
  }
  for (const row of pending) {
    const messageId = String(row['messageId'])
    const recipientId = String(row['recipientId'])
    const record = byId.get(messageId)
    // ALTO-1/m-728 guard: a pair whose record does NOT address the recipient
    // is EXCLUDED from the settlement obligation (the guard class).
    const to = record === undefined ? undefined : record['to']
    if (to === undefined || !Array.isArray(to) || !(to as unknown[]).includes(recipientId)) continue
    // LANE ② (m-440 / fb-58 F-3) reroutable guard: a pending row addressed to
    // the retired host MEMBER id whose rotation chain resolves a LIVE successor
    // is RE-DRIVEN at the rotation boundary (deliverOrQueue through the
    // rotatedTo chain), NEVER terminal-settled — no terminal row is produced
    // (or required) for it. Only raw retired SESSION-id rows and dead-end
    // chains carry the in-session terminal obligation.
    const oldEntry = hosts === undefined ? undefined : hosts[deps.hostIdOld]
    const rotatedTo = strField(oldEntry, 'rotatedTo')
    const reroutableTargetLive = rotatedTo !== undefined && hosts !== undefined &&
      hosts[rotatedTo] !== undefined && boolField(hosts[rotatedTo], 'retired') !== true
    const isReroutableHostMember = recipientId === deps.hostIdOld && reroutableTargetLive
    if (isReroutableHostMember) continue
    if (terminalPairs.has(`${messageId}|${recipientId}`)) {
      if (retiredAt !== undefined) {
        // The terminal row must also be INSIDE the settle window.
        const terminalTs = deliveryRows.find(
          (r) => r['status'] === 'terminal' && String(r['messageId']) === messageId && String(r['recipientId']) === recipientId
        )
        const ts = terminalTs === undefined ? undefined : numField(terminalTs, 'ts')
        if (ts !== undefined && (ts < retiredAt || ts > retiredAt + settleWindow)) {
          warn('delivery-unsettled', `pending pair ${messageId} → ${recipientId} has a terminal row at ${ts} OUTSIDE [retiredAt ${retiredAt}, +${settleWindow}ms]`)
        }
      }
    } else {
      warn('delivery-unsettled', `pending pair ${messageId} → ${recipientId} of the retired host has NO terminal row in [retiredAt, retiredAt+${settleWindow}ms] (PR-2 settle missing)`)
    }
  }
}