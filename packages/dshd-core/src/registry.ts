// dsh-deepartments — the DURABLE REGISTRY (the single catalog of hosts/posts).
//
// This module OWNS the organization's durable registry store carved out of the
// invoke.ts monolith (FASE 2 STEP a). It is the SINGLE source of the catalog:
//   - the persisted `<stateDir>/posts.json` + `<stateDir>/hosts.json` READ
//     (cold load at boot) and PERSIST (atomic write + `.bak` backup), byte-
//     compatible with the pre-extraction on-disk format (R6);
//   - the `retired`-MARKED, NEVER-ERASED semantics (`isRetired`, `retirePost`'s
//     mark primitive, `registerEntry`);
//   - the deterministic worker session-id mint (`mintWorkerSessionId`);
//   - the host registry (`ensureHost`, `hostIdForSession`) and the member
//     resolver (`postIdForChild` / `getPost` / `getHost`);
//   - the durable reconcile/leak analyzers + the pure live-host pick.
//
// The state is PER-APPLY (a `RegistryStore` is constructed inside `applyInvoke`
// on the plugin fiber) — AGENTS.md rule 4: NO module-global mutable state.
// Everything below is either a pure function/constant or instance state of a
// `RegistryStore`; nothing mutates a module-level binding across apply calls.
//
// NO export default (pitfall 0001 — breaks `inject`).
import { readFileSync, existsSync } from 'node:fs'
import { copyFile, writeFile, rename, readFile, appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ROTATION_SCHEMA_VERSION, validateHostsRotationFile } from './session-rotation.js'

/** Prefix of a runtime host-address registry entry: `host-<sessionId>`. */
export const HOST_ID_PREFIX = 'host-'

/** Prefix of a department head's STABLE root-agent session id: `head-<postId>`.
 * Deterministic and namespaced (never collides with host/room/parent sessions),
 * so a head's durable session is resolvable across boots and cold restarts. */
export const HEAD_SESSION_PREFIX = 'head-'

/** Prefix of a DISPOSABLE department WORKER's root-agent session id:
 * `worker-<postId>` (the DETERMINISTIC derivation) and, at create time, the
 * UNIQUE `worker-<postId>-<uuid>` mint (see `mintWorkerSessionId`). Namespaced
 * so it NEVER collides with a configured head's `head-<postId>` id. */
export const WORKER_SESSION_PREFIX = 'worker-'

/** The stable root-agent session id of a configured department head. */
export function headSessionId(postId: string): string {
  return `${HEAD_SESSION_PREFIX}${postId}`
}

/** The DETERMINISTIC worker-session derivation (`worker-<postId>`). NOT the id
 * minted at create — it is the legacy/guard form used ONLY by
 * `dedupedWorkerSlug`'s live-agent check (a legacy orphan session with the
 * deterministic id is still deduped against), and by seed fixtures. A worker
 * created today mints `worker-<postId>-<uuid>` instead (see below). */
export function workerSessionId(postId: string): string {
  return `${WORKER_SESSION_PREFIX}${postId}`
}

/** Mint a fresh, UNIQUE root-agent session id for a disposable worker:
 * `worker-<postId>-<uuid>` — the F8 head-rotation pattern applied to the WORKER
 * create path. The deterministic `worker-<postId>` base is NEVER reused as a
 * session id: a retired worker's session was ARCHIVED and re-using the id would
 * collide with the archived entry. A fresh uuid guarantees a worker session
 * NEVER collides with an archived — or live — session, so a retired-and-
 * respawned same-role worker is always visible. The worker's IDENTITY is
 * unchanged (postId/slug, title, dept_who, postId-keyed messaging). */
export function mintWorkerSessionId(postId: string): string {
  return `${WORKER_SESSION_PREFIX}${postId}-${randomUUID()}`
}

/** One durable post registry entry — a FIRST-CLASS ROOT-AGENT department head
 * (Batch 1a). Keyed by postId; the durable root-agent session id is `sessionId`
 * (= `head-<postId>`). Drops the old continuable-subagent `parentId`/`provider`
 * continuation fields from the persisted JSON — a root head has no parent. The
 * `agentPreset: 'deepartments-head'` field is the marker that this is a
 * CONFIGURED permanent head (vs a future disposable worker). */
export interface PostEntry {
  postId: string
  /** Root-agent session id (`head-<postId>` for a configured head, the UNIQUE
   * `worker-<postId>-<uuid>` mint for a DISPOSABLE worker — created fresh and
   * never reused across a retired-and-respawned same-role worker), shared by
   * the agent registry and its persisted session; the wake/dispose/resume
   * identity. */
  sessionId: string
  roomId: string
  /** The root-agent preset id this post mounts. `'deepartments-head'` marks a
   * CONFIGURED permanent head; `'deepartments-worker'` marks a DISPOSABLE
   * worker created at runtime by dept_post_create. */
  agentPreset: string
  /** Batch 3a: disposable-worker marker. Only set (`'worker'`) for workers
   * created by `dept_post_create`. Absent/undefined = a configured permanent
   * head. This registry-level flag is what lets `dept_post_retire` (head path)
   * retire workers without ever touching permanent heads, and it is NOT read by
   * `ensureAllHeads` (which only iterates config coordinators). */
  provider?: 'worker'
  /** Batch 3a: the ROLE captured at create time (e.g. 'rank-and-file
   * researcher'). Used as the persona/role fallback when waking a worker —
   * `coordinatorForPost` is undefined for workers (they have no config), so the
   * durable entry carries the role the creating head supplied. */
  role?: string
  /** F1 (spec 004 §4.1): the durable department link of a WORKER — the config
   * department id of the creating head's department, recorded at create (the
   * pre-F1 code only copied the inert roomId). A configured department head is
   * derived from config instead (`departmentForPost`). Absent on legacy workers
   * (pre-F1 entries) and on heads (config-derived). */
  departmentId?: string
  /** F1 (spec 004 §4.1/§4.2): the postId of the HEAD that created this worker
   * ("my workers" — the per-owner retire scope). Absent on legacy workers.
   * Never set on heads (they come from config, not from a creator). */
  managerId?: string
  /** F1 (spec 004 §3.4/§5.4): set when the worker was spawned by a JOB run
   * (F4) — the versioned job definition id. Absent on plain ephemeral workers
   * (dept_post_create) and on heads. */
  jobId?: string
  /** F1 (spec 004 §4.3): RETIREMENT IS MARKED, NEVER ERASED. `dept_post_retire`
   * on a worker sets this flag and KEEPS the registry entry (byPost +
   * posts.json), so the history stays queryable; the LIVE catalog
   * (busDeliverCatalog addressing, dept_who, the wake-pack roster) filters
   * retired entries. Absent/false = live. Never set on configured heads
   * (a head retire stays cosmetic — the config re-materializes it). */
  retired?: boolean
  /** Batch G: set when the head SLEPT (memoized + marked). On the next wake the
   * relay cold-resumes the SAME durable session (context reset + journal reload)
   * instead of waking a live incarnation; cleared once the respawn lands.
   * Absent/undefined = never slept. */
  sleepEpoch?: number
  /** Task T1 (Session Memory Archive): the session event `seq` recorded at the
   * previous dept_sleep boundary. Stored so the next cycle's session-log capture
   * can slice events with `seq > boundarySeq` EXACTLY. Absent = first ever cycle. */
  boundarySeq?: number
  /** Batch G: the sessionId of the PREVIOUS incarnation (recording where a slept
   * head's old live session went), kept so trace stays honest. Absent = first. */
  previousChildId?: string
  /** M-A (dept_head_rotate, 2026-08-28): set when the head was ROTATED — its
   * durable session was fresh-minted (NEW sessionId + previousChildId) as an
   * ACTIVE CONTEXT REFRESH (NOT sleep — no sleepEpoch is set). Marks the
   * rotation event on the entry so the durable lineage distinguishes a
   * rotation from a legacy slept-head wake. Absent = never rotated. */
  rotated?: boolean
  /** Fix (head-sleep worker drain): the durable list of the head's IN-FLIGHT
   * workers recorded at dept_sleep, so the sleep is handed off through the SAME
   * persistPosts write with a durable "n workers in flight" ledger. The boot
   * reconcile reads it to reap/flag any worker whose manager is still dormant.
   * Only set on a slept HEAD; cleared on respawn. Absent = never slept with
   * in-flight workers. */
  inflightWorkers?: string[]
  /** VALLE lane B (fb-29 structural fix): a WORKER's role-template `tools`
   * allow-list, threaded into the durable entry at spawn (dept_worker_spawn /
   * dept_job_run — the warm paths pass `template.tools` to workerSetup; the
   * durable copy is the COLD re-materialization fast-path). Absent on a head,
   * on a legacy worker (pre-VALLE-B entries — the delivery seam re-resolves the
   * role template instead) and on the legacy dept_post_create board-only class
   * (no role template — messaging-only by design). */
  tools?: string[]
}

/** The DURABLE shape persisted to posts.json. */
export interface PostEntryPersisted {
  sessionId: string
  roomId: string
  agentPreset: string
  provider?: 'worker'
  role?: string
  /** F1 — persisted only when set (absent = legacy/pre-F1 entry). */
  departmentId?: string
  managerId?: string
  jobId?: string
  retired?: boolean
  sleepEpoch?: number
  boundarySeq?: number
  previousChildId?: string
  /** M-A — the rotation marker (see PostEntry.rotated). Persisted only when set. */
  rotated?: boolean
  inflightWorkers?: string[]
  /** VALLE lane B (fb-29 structural fix) — a worker's role-template `tools`
   * allow-list (see PostEntry.tools). Persisted only when set (absent = legacy/
   * pre-VALLE-B or the board-only dept_post_create class). */
  tools?: string[]
}

/** One durable host registry entry (hostId → host session in a room). */
export interface HostEntry {
  hostId: string
  sessionId: string
  roomId: string
  /** Batch 7: set when the host SLEPT (dept_sleep, host branch — journal
   * persisted + surface reset to the journal). Absent = never slept. */
  sleepEpoch?: number
  /** Task T1 (Session Memory Archive): the session-event `seq` recorded at the
   * previous dept_sleep boundary. Absent = first-ever cycle. */
  boundarySeq?: number
  /** Web-UI sleep cleanup (Option A): set at dept_sleep (host branch), cleared
   * by the FIRST boot that successfully truncates the host session artifact.
   * Absent = no cleanup pending. */
  webUiCleanupPending?: boolean
  /** Fix wake-12: the DURABLE seed for Fix A's deferred sleep surface replace.
   * Absent = no deferred replace pending. */
  deferredJournalSeed?: string
  /** U2 (spec 002 §3.5/D4): set on the RETIRED old entry after a host session
   * ROTATION at dept_sleep. The entry STAYS in hosts.json (queryable as
   * evidence, D1) but the wake gate skips it. Absent (or false) = live. */
  retired?: boolean
  /** U2 (D4): when this entry was retired (ms epoch); required on retired. */
  retiredAt?: number
  /** U2 (D4): the `host-<newId>` this retired entry rotated to; required on
   * retired. */
  rotatedTo?: string
  /** U2 (D4): on a LIVE entry that was created by a rotation — the sessionId it
   * rotated FROM (must reference a retired entry in the same file). */
  previousSessionId?: string
}

/** Loose structural view of one host-registry entry (hosts.json value). */
export interface HostEntryLike {
  hostId: string
  sessionId: string
  roomId?: string
  /** U2 (spec 002 §3.5/D4): rotation schema — set on RETIRED old entries (the
   * entry STAYS in hosts.json as evidence; the wake gate skips it). */
  retired?: boolean
  /** U2 (D4): when the entry was retired (ms epoch); required on retired. */
  retiredAt?: number
  /** U2 (D4): the `host-<newId>` this retired entry rotated to. */
  rotatedTo?: string
  /** U2 (D4): on a LIVE entry created by a rotation — the session id it
   * rotated FROM (references a retired entry in the same file). */
  previousSessionId?: string
}

/** Read the DURABLE hosts registry (`<stateDir>/hosts.json`) as a plain
 * `{ [hostId]: { retired } }` object (the `retired` flag normalized to boolean;
 * the top-level `schemaVersion` marker is skipped). Returns `undefined` (never
 * throws) when the file is absent/unreadable/malformed, so the caller can fall
 * back to the in-memory registry. This is the Bug A AUTHORITATIVE on-disk
 * source: a long-lived process may hold a STALE in-memory `hosts` Map, but the
 * file is the truthful rotation record. */
export function readDurableHostsRegistry(stateDir: string): Record<string, { retired: boolean }> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, 'hosts.json'), 'utf8')) as Record<string, unknown>
    const out: Record<string, { retired: boolean }> = {}
    for (const [hostId, entry] of Object.entries(parsed)) {
      if (hostId === 'schemaVersion') continue
      if (entry !== null && typeof entry === 'object') {
        const e = entry as { retired?: unknown }
        out[hostId] = { retired: e.retired === true }
      }
    }
    return out
  } catch {
    return undefined
  }
}

/** Bug A authoritative source gate: `true` iff the DURABLE hosts.json marks the
 * given host `retired: true` ON DISK. `undefined` (file unreadable/malformed)
 * lets the caller fall back to the in-memory registry — NEVER throws. Because
 * the on-disk file is the truthful rotation record, a STALE in-memory `hosts`
 * Map cannot bypass this check. */
export function isHostRetiredOnDisk(stateDir: string, hostId: string): boolean | undefined {
  const registry = readDurableHostsRegistry(stateDir)
  if (registry === undefined) return undefined
  return registry[hostId]?.retired === true
}

/** The set of RETIRED host ids computed from the DURABLE hosts.json (re-read
 * fresh on every call). `undefined` when the file is unreadable/malformed. Used
 * by the system-health daemon so the retired-host scan gate is robust to a
 * STALE in-memory registry (a process that booted before a rotation). */
export function readDurableRetiredHostIds(stateDir: string): Set<string> | undefined {
  const registry = readDurableHostsRegistry(stateDir)
  if (registry === undefined) return undefined
  const ids = new Set<string>()
  for (const [hostId, entry] of Object.entries(registry)) {
    if (entry.retired === true) ids.add(hostId)
  }
  return ids
}

/** Read the DURABLE hosts registry (`<stateDir>/hosts.json`) FRESH and return
 * ALL host entries as `HostEntryLike[]` (hostId, sessionId, roomId?, retired?,
 * retiredAt?, rotatedTo?, previousSessionId?), PRESERVING the rotation-chain
 * metadata so a subsequent `pickLiveHostEntry` succeeds exactly as it does for
 * the in-memory registry. The top-level `schemaVersion` marker is skipped.
 * Returns `undefined` (never throws) when the file is absent/unreadable/
 * malformed, so the caller falls back to the in-memory registry; an EMPTY array
 * (a readable file with no entries) is a valid read. This is the DURABLE source
 * the system-health daemon ALERT recipient must resolve from. */
export function readDurableHostEntries(stateDir: string): HostEntryLike[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, 'hosts.json'), 'utf8')) as Record<string, unknown>
    const entries: HostEntryLike[] = []
    for (const [hostId, raw] of Object.entries(parsed)) {
      if (hostId === 'schemaVersion') continue
      if (raw === null || typeof raw !== 'object') continue
      const e = raw as Record<string, unknown>
      const entry: HostEntryLike = {
        hostId,
        sessionId: typeof e.sessionId === 'string' ? e.sessionId : ''
      }
      if (typeof e.roomId === 'string') entry.roomId = e.roomId
      if (e.retired === true) entry.retired = true
      if (typeof e.retiredAt === 'number') entry.retiredAt = e.retiredAt
      if (typeof e.rotatedTo === 'string') entry.rotatedTo = e.rotatedTo
      if (typeof e.previousSessionId === 'string') entry.previousSessionId = e.previousSessionId
      entries.push(entry)
    }
    return entries
  } catch {
    return undefined
  }
}

/** ONE issue the durable host-registry validation detected (warn-class). */
export interface DurableHostReconcileIssue {
  code: 'zero-live' | 'multi-live' | 'chain-integrity'
  hostId?: string
  message: string
}

/** The idempotent repair plan for a degenerate durable hosts.json. `clean` is
 * true when NO host-entry change is needed. `writable` is true only when there
 * is a CONCRETE, safe change to commit. */
export interface DurableHostRepair {
  /** The single non-retired live host to keep (the deterministic pick). */
  liveHostId: string | undefined
  /** Non-picked live hostIds to mark RETIRED (multi-live repair). */
  retireHostIds: string[]
  /** The chain-terminal hostId to UN-RETIRE (zero-live repair). undefined = none. */
  unretireHostId: string | undefined
  /** True when NO write is needed (the invariant already holds). */
  clean: boolean
  /** True when there is a concrete, safe write to commit. */
  writable: boolean
}

/** Result of the durable host-registry reconciliation (pure analysis). */
export interface DurableHostReconcileResult {
  /** The deterministic live entry (pickLiveHostEntry), or undefined when no live. */
  liveEntry: HostEntryLike | undefined
  /** Number of non-retired live entries. */
  liveCount: number
  /** True when the ambiguity fallback fired (multiple live, none rotation-created). */
  ambiguous: boolean
  /** Invariant breach: ZERO non-retired live hosts. */
  zeroLive: boolean
  /** Invariant breach: MORE THAN ONE non-retired live host. */
  multiLive: boolean
  /** Rotation-chain integrity: ok | dangling | cycle | retired-terminal. */
  chainIntegrity: 'ok' | 'dangling' | 'cycle' | 'retired-terminal'
  /** All detected issues (warn-class), in detection order. */
  issues: DurableHostReconcileIssue[]
  /** The idempotent repair plan (no-op when clean). */
  repair: DurableHostRepair
}

/** The host that is the rotation-chain TERMINAL: the target of some host's
 * `rotatedTo` AND carrying NO `rotatedTo` of its own (the chain end). Returns
 * `undefined` when no single terminal exists (a dangling chain, a cycle, or a
 * bare retired host with no chain — none of which are safe repair candidates). */
export function findRotationTerminal(entries: HostEntryLike[], byId: Map<string, HostEntryLike>): string | undefined {
  const targets = new Set<string>()
  for (const entry of entries) {
    if (typeof entry.rotatedTo === 'string' && entry.rotatedTo !== '') targets.add(entry.rotatedTo)
  }
  const terminals = entries.filter((entry) => targets.has(entry.hostId) && (entry.rotatedTo === undefined || entry.rotatedTo === ''))
  return terminals.length === 1 ? terminals[0].hostId : undefined
}

/** LANE ② (fb-58 F-3 — the 'prepared'-stuck acks to a rotated host session,
 * m-424/425/429) — follow the ROTATION CHAIN (`rotatedTo`) from ONE host id to
 * its LIVE SUCCESSOR: the explicit spec-002 successor chain (old → rotatedTo →
 * newer → … → the single live terminal), so a message addressed to a RETIRED
 * host session re-routes to the session VIVA. Returns the live terminal entry;
 * `undefined` when the walk cannot reach a live host — an id absent from the
 * registry, a terminal that is RETIRED (no successor), a DANGLING target, or
 * the hop cap exceeded (a corrupted cycle) — the caller falls back to
 * `pickLiveHostEntry` (the single-live invariant) / 'unknown'. BOUNDED: at most
 * `HOST_ROTATION_CHAIN_MAX_HOPS` hops, so a corrupted file can never loop. */
export function followRotationChainToLive(entries: readonly HostEntryLike[], startHostId: string): HostEntryLike | undefined {
  const byId = new Map(entries.map((entry) => [entry.hostId, entry]))
  const start = byId.get(startHostId)
  if (start === undefined) return undefined
  let current = start
  for (let hop = 0; hop < HOST_ROTATION_CHAIN_MAX_HOPS; hop++) {
    if (current.retired !== true) return current
    const next = typeof current.rotatedTo === 'string' ? current.rotatedTo : ''
    if (next === '') return undefined
    const nextEntry = byId.get(next)
    if (nextEntry === undefined) return undefined
    current = nextEntry
  }
  return undefined
}

/** The hop cap of `followRotationChainToLive` (a spec-002 chain is short — one
 * retired id per rotation; 16 covers a pathological many-rotation history). */
export const HOST_ROTATION_CHAIN_MAX_HOPS = 16

/** Whether the `rotatedTo` graph contains a cycle among the entries present in
 * the file (a chain-integrity violation — the chain never reaches a terminal). */
export function hasRotatedToCycle(entries: HostEntryLike[], byId: Map<string, HostEntryLike>): boolean {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const dfs = (hostId: string): boolean => {
    if (visited.has(hostId)) return false
    if (visiting.has(hostId)) return true
    const entry = byId.get(hostId)
    if (entry === undefined) return false
    visiting.add(hostId)
    const next = typeof entry.rotatedTo === 'string' ? entry.rotatedTo : ''
    if (next !== '' && byId.has(next) && dfs(next)) return true
    visiting.delete(hostId)
    visited.add(hostId)
    return false
  }
  for (const entry of entries) if (dfs(entry.hostId)) return true
  return false
}

/** PURE durable host-registry invariant validator (m-119). Non-throwing,
 * deterministic, and side-effect free — unit-testable without the invoke
 * context. Given the durable hosts.json entries it verifies the invariant
 * "exactly ONE non-retired live host (the rotation successor)" and reports the
 * degenerate cases with an idempotent repair plan:
 *   (a) ZERO non-retired live hosts → the repair UN-RETIRES the chain terminal.
 *   (b) MULTIPLE non-retired live hosts → the repair KEEPS the deterministic
 *       pick and RETIRES the other live entries.
 *   (c) chain-integrity → flagged + warned; repaired ONLY when it coincides
 *       with (a)/(b).
 * The LIVE-side correctness is NOT changed: a host retired in the durable file
 * stays terminal (never live-resolvable / row-producing) and a live host stays
 * resolvable — this helper is purely about the durable registry's own shape. */
export function analyzeDurableHostRegistry(entries: Iterable<HostEntryLike>): DurableHostReconcileResult {
  const all = [...entries]
  const byId = new Map(all.map((entry) => [entry.hostId, entry]))
  const liveEntries = all.filter((entry) => entry.retired !== true)
  const { live: selectedLive, ambiguous } = pickLiveHostEntry(all)
  const liveCount = liveEntries.length
  const zeroLive = liveCount === 0
  const multiLive = liveCount > 1

  const issues: DurableHostReconcileIssue[] = []
  let chainIntegrity: DurableHostReconcileResult['chainIntegrity'] = 'ok'
  const danglingTargets = all.filter((entry) => entry.retired === true && typeof entry.rotatedTo === 'string' && entry.rotatedTo !== '' && !byId.has(entry.rotatedTo))
  const cycle = hasRotatedToCycle(all, byId)
  const terminalId = findRotationTerminal(all, byId)
  if (cycle) {
    chainIntegrity = 'cycle'
  } else if (danglingTargets.length > 0) {
    chainIntegrity = 'dangling'
  } else if (terminalId !== undefined && byId.get(terminalId)?.retired === true) {
    chainIntegrity = 'retired-terminal'
  }

  if (zeroLive) {
    issues.push({ code: 'zero-live', message: `durable hosts.json has ZERO non-retired live hosts (${all.length} entries, all retired) — the rotation chain lost its live successor` })
  }
  if (multiLive) {
    issues.push({ code: 'multi-live', message: `durable hosts.json has ${liveCount} non-retired live hosts (exactly one required) — selected ${selectedLive?.hostId ?? 'none'} deterministically; the others are retire candidates` })
  }
  if (chainIntegrity !== 'ok') {
    const detail = chainIntegrity === 'dangling'
      ? `retired host(s) ${danglingTargets.map((d) => `${d.hostId}→${d.rotatedTo}`).join(', ')} point at a host NOT in hosts.json (lost successor)`
      : chainIntegrity === 'cycle'
        ? 'the rotatedTo chain contains a cycle'
        : `the chain terminal ${terminalId} is RETIRED (the chain does not reach a live host)`
    issues.push({ code: 'chain-integrity', message: `durable hosts.json chain-integrity: ${detail}` })
  }

  let repair: DurableHostRepair
  if (multiLive && selectedLive !== undefined) {
    const retireHostIds = liveEntries.filter((entry) => entry.hostId !== selectedLive.hostId).map((entry) => entry.hostId)
    repair = { liveHostId: selectedLive.hostId, retireHostIds, unretireHostId: undefined, clean: retireHostIds.length === 0, writable: retireHostIds.length > 0 }
  } else if (zeroLive && terminalId !== undefined && byId.get(terminalId)?.retired === true) {
    repair = { liveHostId: terminalId, retireHostIds: [], unretireHostId: terminalId, clean: false, writable: true }
  } else {
    repair = { liveHostId: selectedLive?.hostId, retireHostIds: [], unretireHostId: undefined, clean: true, writable: false }
  }

  return { liveEntry: selectedLive, liveCount, ambiguous, zeroLive, multiLive, chainIntegrity, issues, repair }
}

/** Read + parse a DURABLE JSON registry file with a bounded RETRY for the
 * boot-time torn-write race (a concurrent persistHosts/persistPosts may be
 * writing the file while this reads it — a transient `Unexpected end of JSON
 * input`). An ABSENT file (ENOENT) is a clean no-op. Returns the parsed object,
 * or `undefined` after exhausting the retries (malformed). Never throws. */
async function readDurableJsonFile(stateDir: string, filename: string): Promise<Record<string, unknown> | undefined> {
  const filePath = path.join(stateDir, filename)
  if (!existsSync(filePath)) return undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
      // torn/malformed → retry after a short backoff (a concurrent write may
      // still be in-flight); exhausted retries fall through to undefined.
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 30))
  }
  return undefined
}

/** Apply the repair plan to the RAW parsed hosts.json (preserving every field
 * the durable file carries that HostEntryLike does not model). Returns a new
 * object; the input is never mutated. */
function applyHostRepairToRaw(raw: Record<string, unknown>, repair: DurableHostRepair, nowMs: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  for (const hostId of repair.retireHostIds) {
    const e = out[hostId]
    if (e !== null && typeof e === 'object') {
      out[hostId] = { ...(e as Record<string, unknown>), retired: true, retiredAt: nowMs }
    }
  }
  if (repair.unretireHostId !== undefined) {
    const e = out[repair.unretireHostId]
    if (e !== null && typeof e === 'object') {
      const { retired: _retired, retiredAt: _retiredAt, rotatedTo: _rotatedTo, ...rest } = e as Record<string, unknown>
      out[repair.unretireHostId] = rest
      if (repair.liveHostId !== undefined) out[repair.liveHostId] = out[repair.unretireHostId]
    }
  }
  return out
}

/** Options for `reconcileDurableHostRegistry`. */
export interface ReconcileDurableHostOpts {
  logger?: { warn(message: string): void }
  /** When true, WRITE the repaired durable hosts.json when degenerate (backing
   * up the pre-repair file first). When false/absent the helper is read-only
   * (validate + warn). */
  write?: boolean
  /** Clock (ms epoch) for retiredAt + the backup timestamp. Absent → Date.now. */
  now?: () => number
}

/** Read-only validate, or WRITE a repaired durable hosts.json, per m-119.
 * Never throws. When `write: true` and the state is degenerate + a safe repair
 * exists, the pre-repair hosts.json is copied to
 * `<stateDir>/hosts.json.bak-<ts>-reconcile` FIRST, then the repaired file is
 * written atomically (tmp + rename). The repair is IDEMPOTENT. Returns the
 * analysis result (issues + repair plan). */
export async function reconcileDurableHostRegistry(
  stateDir: string,
  opts: ReconcileDurableHostOpts = {}
): Promise<DurableHostReconcileResult> {
  const logger = opts.logger
  const raw = await readDurableJsonFile(stateDir, 'hosts.json')
  if (raw === undefined) {
    // Absent (ENOENT) → nothing to reconcile (the loader is empty; the next
    // ensureHost registers the first host on first register). Malformed (after
    // the retry window) → warn.
    if (!existsSync(path.join(stateDir, 'hosts.json'))) {
      return { liveEntry: undefined, liveCount: 0, ambiguous: false, zeroLive: false, multiLive: false, chainIntegrity: 'ok', issues: [], repair: { liveHostId: undefined, retireHostIds: [], unretireHostId: undefined, clean: true, writable: false } }
    }
    logger?.warn('[deepartments] reconcile-host: hosts.json unreadable/malformed — cannot validate the durable rotation invariant (no repair)')
    return { liveEntry: undefined, liveCount: 0, ambiguous: false, zeroLive: false, multiLive: false, chainIntegrity: 'ok', issues: [], repair: { liveHostId: undefined, retireHostIds: [], unretireHostId: undefined, clean: true, writable: false } }
  }
  // Build the HostEntryLike[] for the pure analysis from the raw (same shape as
  // readDurableHostEntries).
  const entries: HostEntryLike[] = []
  for (const [hostId, rawEntry] of Object.entries(raw)) {
    if (hostId === 'schemaVersion') continue
    if (rawEntry === null || typeof rawEntry !== 'object') continue
    const e = rawEntry as Record<string, unknown>
    const entry: HostEntryLike = { hostId, sessionId: typeof e.sessionId === 'string' ? e.sessionId : '' }
    if (typeof e.roomId === 'string') entry.roomId = e.roomId
    if (e.retired === true) entry.retired = true
    if (typeof e.retiredAt === 'number') entry.retiredAt = e.retiredAt
    if (typeof e.rotatedTo === 'string') entry.rotatedTo = e.rotatedTo
    if (typeof e.previousSessionId === 'string') entry.previousSessionId = e.previousSessionId
    entries.push(entry)
  }
  const result = analyzeDurableHostRegistry(entries)
  for (const issue of result.issues) logger?.warn(`[deepartments] reconcile-host: ${issue.message}`)
  if (opts.write === true && !result.repair.clean && result.repair.writable) {
    try {
      const nowMs = (opts.now ?? (() => Date.now()))()
      const backupPath = path.join(stateDir, `hosts.json.bak-${nowMs}-reconcile`)
      await copyFile(path.join(stateDir, 'hosts.json'), backupPath)
      const repairedRaw = applyHostRepairToRaw(raw, result.repair, nowMs)
      const tmpPath = path.join(stateDir, `hosts.json.tmp-${nowMs}`)
      await writeFile(tmpPath, JSON.stringify(repairedRaw, null, 2), 'utf8')
      await rename(tmpPath, path.join(stateDir, 'hosts.json'))
      logger?.warn(`[deepartments] reconcile-host: REPAIRED durable hosts.json (backup ${path.basename(backupPath)})`)
    } catch (error: unknown) {
      logger?.warn(`[deepartments] reconcile-host: repair write failed (the durable file is left untouched): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}

/** Loose durable post-registry entry the posts reconcile reads (provider marks a
 * disposable worker; a configured head has NO provider). */
export interface DurablePostReconcileLike {
  postId: string
  sessionId: string
  provider?: string
  role?: string
  retired?: boolean
  /** A configured HEAD (or worker) deliberately put to sleep by dept_sleep_all
   * — a session archived + this epoch set. A slept head is DORMANT-BY-DESIGN,
   * NOT absent-by-accident, so it is never classified as a stale candidate. */
  sleepEpoch?: number
}

/** Result of the durable posts-registry reconcile (m-119 + B5). */
export interface DurablePostsReconcileResult {
  /** Non-retired WORKER posts whose session is definitively gone OR unusable
   * (retire-leak candidates — flagged/warned, never auto-retired unless opted
   * in). B5: "unusable" = a DURABLE session PRESENT but with no usable
   * AgentOptions (the builder-87 / VARIANT-2 ghost — an interrupted materialize
   * that left a catalog-live worker with no working session). */
  workerRetireCandidates: Array<{ postId: string; sessionId: string }>
  /** Candidates that were actually marked retired (when `retireGoneWorkers`). */
  workersRetired: Array<{ postId: string; sessionId: string }>
  /** B5 — a CONFIGURED HEAD (no `provider`) whose durable session is gone OR
   * unusable. WARN-ONLY: a configured head is NEVER auto-retired (the invariant
   * at the analyzer comment below); this surface exists so a head-session leak
   * is visible without ever touching the head. */
  headStaleCandidates: Array<{ postId: string; sessionId: string }>
  /** True when the durable posts.json was written (a retire happened). */
  changed: boolean
  /** A3/C2 — the postIds of the retired entries that were PRUNED (moved to the
   * retired archive) in this reconcile, when `enableRetiredPrune` ran AND the
   * retired count exceeded `retiredKeep`. Empty when no prune happened. The
   * caller MUST drop these from the in-memory catalog (`byPost`/`byChild`) so a
   * LATER `persistPosts()` writes the PRUNED set, not the full pre-prune set
   * (the C2 partial-prune regression — a file-based prune with no in-memory
   * sync gets overwritten by the next full-set persist). Never erased: the
   * pruned entries are preserved in the retired archive + the pre-prune
   * backup. */
  prunedPostIds: string[]
}

/** PURE durable posts-registry leak detector (m-119, W8-g). Given the durable
 * posts.json entries + a session-gone predicate + (B5) an optional
 * session-unusable predicate, it FLAGS every non-retired WORKER (the
 * disposable-worker marker `provider: 'worker'`) whose session is DEFINITIVELY
 * gone OR definitively unusable — the retire-leak class. B5: it ALSO surfaces a
 * CONFIGURED HEAD (no `provider`) whose session is gone OR unusable as a
 * `headStaleCandidates` entry — WARN-ONLY, never a worker retire candidate (a
 * configured head is NEVER auto-retired). The retire decision itself is the
 * caller's (`opts.retireGoneWorkers`): this function only classifies. */
export function analyzeDurablePostsRegistry(
  entries: Iterable<DurablePostReconcileLike>,
  isSessionGone: (entry: DurablePostReconcileLike) => boolean,
  isSessionUnusable: (entry: DurablePostReconcileLike) => boolean = () => false
): DurablePostsReconcileResult {
  const candidates: Array<{ postId: string; sessionId: string }> = []
  const headStale: Array<{ postId: string; sessionId: string }> = []
  for (const entry of entries) {
    if (entry.retired === true) continue
    const gone = isSessionGone(entry)
    const unusable = isSessionUnusable(entry)
    if (entry.provider !== 'worker') {
      // B5 — a CONFIGURED HEAD (or a non-worker entry): its session is gone OR
      // unusable → a STALE candidate. Never auto-retired (warn-only surface).
      // EXCEPTION: a head with `sleepEpoch` set was deliberately put to sleep
      // (dept_sleep_all — session ARCHIVED). A slept head is DORMANT-BY-DESIGN,
      // NOT absent-by-accident, so it is NOT a stale candidate. Only a head with
      // NO sleepEpoch (a genuinely-abandoned session) is surfaced as stale.
      if ((gone || unusable) && entry.sleepEpoch === undefined) headStale.push({ postId: entry.postId, sessionId: entry.sessionId })
      continue
    }
    if (gone || unusable) candidates.push({ postId: entry.postId, sessionId: entry.sessionId })
  }
  return { workerRetireCandidates: candidates, workersRetired: [], headStaleCandidates: headStale, changed: false, prunedPostIds: [] }
}

/** Options for `reconcileDurablePostsRegistry`. */
export interface ReconcileDurablePostsOpts {
  logger?: { warn(message: string): void }
  /** Resolve whether a session is DEFINITIVELY gone (no durable session). A
   * conservative resolver (unable to determine) MUST return false. */
  isSessionGone: (sessionId: string) => boolean | Promise<boolean>
  /** B5 — resolve whether a session is DEFINITIVELY UNUSABLE (a DURABLE session
   * PRESENT but with no usable AgentOptions — the builder-87 / VARIANT-2 ghost:
   * an interrupted materialize that left a catalog-live worker with no working
   * session). A conservative resolver (unable to determine) MUST return false.
   * Optional — ABSENT ⇒ never treats a session as unusable (the pre-B5
   * flag-gone-only behavior is a strict subset). */
  isSessionUnusable?: (sessionId: string, postId: string) => boolean | Promise<boolean>
  /** When true, WRITE the retire mark for the flagged candidates (backup the
   * pre-repair posts.json first). Default false → flag + warn only. */
  retireGoneWorkers?: boolean
  /** A3/C2 — max RETIRED entries to KEEP in posts.json when pruning is enabled.
   * Absent → 50. When the durable posts.json holds MORE retired entries than
   * this, the OLDEST retired entries beyond the newest `retiredKeep` are Moved
   * to the retired archive (non-destructive; never erased). */
  retiredKeep?: number
  /** A3/C2 — the archive filename to append pruned retired entries to, under
   * `stateDir`. Absent → `posts-retired-archive.jsonl`. */
  retiredArchiveFile?: string
  /** A3/C2 — when TRUE, retired-entry pruning RUNS. When false or ABSENT,
   * pruning is SKIPPED (the retire mark + gone-worker logic still run).
   * Absent → false (conservative default — pruning is OFF unless explicitly
   * enabled with true). */
  enableRetiredPrune?: boolean
  /** Clock (ms epoch) for the backup timestamp. Absent → Date.now. */
  now?: () => number
}

/** Read-only flag (or retire-if-safe) the durable posts.json for gone WORKER
 * sessions, per m-119. Never throws. A configured head is never touched. When
 * `retireGoneWorkers`, the pre-repair posts.json is copied to
 * `<stateDir>/posts.json.bak-<ts>-reconcile` FIRST, then the retires are
 * written atomically (tmp + rename). Idempotent.
 *
 * A3/C2 — RETIRED-ENTRY PRUNING (non-destructive): when `enableRetiredPrune`
 * is EXPLICITLY true (default false — pruning is OFF unless enabled) and the
 * durable posts.json holds MORE than `retiredKeep`
 * (default 50) retired entries, the OLDEST retired entries beyond the newest
 * `retiredKeep` are moved to the retired archive (`retiredArchiveFile`,
 * default `posts-retired-archive.jsonl`) — FIRST backing up posts.json to
 * `<stateDir>/posts.json.bak-<ts>-prune`, then appending a JSONL line per pruned
 * entry, then writing posts.json atomically. The remaining on-disk shape is
 * UNCHANGED (R6); the pruned entries are preserved in the archive, never erased. */
export async function reconcileDurablePostsRegistry(
  stateDir: string,
  opts: ReconcileDurablePostsOpts
): Promise<DurablePostsReconcileResult> {
  const logger = opts.logger
  const raw = await readDurableJsonFile(stateDir, 'posts.json')
  if (raw === undefined) {
    if (!existsSync(path.join(stateDir, 'posts.json'))) {
      return { workerRetireCandidates: [], workersRetired: [], headStaleCandidates: [], changed: false, prunedPostIds: [] }
    }
    logger?.warn('[deepartments] reconcile-posts: posts.json unreadable/malformed — cannot reconcile gone workers (no change)')
    return { workerRetireCandidates: [], workersRetired: [], headStaleCandidates: [], changed: false, prunedPostIds: [] }
  }
  const entries: DurablePostReconcileLike[] = []
  for (const [postId, rawEntry] of Object.entries(raw)) {
    if (rawEntry === null || typeof rawEntry !== 'object') continue
    const e = rawEntry as Record<string, unknown>
    const entry: DurablePostReconcileLike = { postId, sessionId: typeof e.sessionId === 'string' ? e.sessionId : '' }
    if (typeof e.provider === 'string') entry.provider = e.provider
    if (typeof e.role === 'string') entry.role = e.role
    if (e.retired === true) entry.retired = true
    if (typeof e.sleepEpoch === 'number') entry.sleepEpoch = e.sleepEpoch
    entries.push(entry)
  }
  // Resolve the session-gone + session-unusable predicates (async-tolerant) to
  // sync predicates, for EVERY non-retired entry (workers AND configured heads
  // — B5 surfaces a stale HEAD as a warn-only candidate too).
  const goneByPostId = new Map<string, boolean>()
  const unusableByPostId = new Map<string, boolean>()
  for (const entry of entries) {
    if (entry.retired === true) continue
    let gone = false
    try {
      gone = Boolean(await opts.isSessionGone(entry.sessionId))
    } catch {
      gone = false
    }
    goneByPostId.set(entry.postId, gone)
    if (opts.isSessionUnusable !== undefined) {
      let unusable = false
      try {
        unusable = Boolean(await opts.isSessionUnusable(entry.sessionId, entry.postId))
      } catch {
        unusable = false
      }
      unusableByPostId.set(entry.postId, unusable)
    }
  }
  const result = analyzeDurablePostsRegistry(
    entries,
    (entry) => goneByPostId.get(entry.postId) === true,
    (entry) => unusableByPostId.get(entry.postId) === true
  )
  for (const candidate of result.workerRetireCandidates) {
    logger?.warn(`[deepartments] reconcile-posts: worker "${candidate.postId}" (session ${candidate.sessionId}) is a retire-leak candidate — its durable session is gone or unusable${opts.retireGoneWorkers === true ? '; auto-retiring (retire-if-safe)' : '; NOT auto-retired (flag only)'}`)
  }
  // B5 — a configured HEAD whose session is gone OR unusable is a STALE
  // candidate: WARN ONLY (a configured head is NEVER auto-retired — the
  // analyzer's invariant). Purposely separate from the worker warn so the
  // operator sees the head leak WITHOUT any retire-eligibility ambiguity.
  for (const stale of result.headStaleCandidates) {
    logger?.warn(`[deepartments] reconcile-posts: head "${stale.postId}" (session ${stale.sessionId}) is a STALE candidate — its durable session is gone or unusable; WARN ONLY (a configured head is NEVER auto-retired)`)
  }
  // Stage the retired marks into `workingRaw` (NOT written yet — the single
  // atomic write at the end folds in any pruning so posts.json is written ONCE
  // when either operation changed it).
  let changed = false
  let workersRetired: Array<{ postId: string; sessionId: string }> = []
  let prunedPostIds: string[] = []
  let workingRaw: Record<string, unknown> | undefined
  if (opts.retireGoneWorkers === true && result.workerRetireCandidates.length > 0) {
    try {
      const nowMs = (opts.now ?? (() => Date.now()))()
      const backupPath = path.join(stateDir, `posts.json.bak-${nowMs}-reconcile`)
      await copyFile(path.join(stateDir, 'posts.json'), backupPath)
      const repairedRaw = { ...raw }
      for (const candidate of result.workerRetireCandidates) {
        const e = repairedRaw[candidate.postId]
        if (e !== null && typeof e === 'object') repairedRaw[candidate.postId] = { ...(e as Record<string, unknown>), retired: true }
      }
      workingRaw = repairedRaw
      changed = true
      workersRetired = result.workerRetireCandidates
      logger?.warn(`[deepartments] reconcile-posts: RETIRED ${result.workerRetireCandidates.length} gone worker(s) in durable posts.json (backup ${path.basename(backupPath)})`)
    } catch (error: unknown) {
      logger?.warn(`[deepartments] reconcile-posts: retire write failed (the durable file is left untouched): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // A3/C2 — prune OLDEST retired entries beyond the newest `retiredKeep`.
  // Gated on an EXPLICIT `true` so an ABSENT/false value (conservative default)
  // SKIPS pruning entirely.
  if (opts.enableRetiredPrune === true) {
    try {
      const retiredKeep = opts.retiredKeep ?? 50
      const archiveFile = opts.retiredArchiveFile ?? 'posts-retired-archive.jsonl'
      const archivePath = path.join(stateDir, archiveFile)
      const baseRaw = workingRaw ?? raw
      // Collect retired postIds in on-disk (insertion) order.
      const retiredPostIds: string[] = []
      for (const [postId, rawEntry] of Object.entries(baseRaw)) {
        if (rawEntry !== null && typeof rawEntry === 'object' && (rawEntry as Record<string, unknown>).retired === true) retiredPostIds.push(postId)
      }
      if (retiredPostIds.length > retiredKeep) {
        const nowMs = (opts.now ?? (() => Date.now()))()
        const backupPath = path.join(stateDir, `posts.json.bak-${nowMs}-prune`)
        await copyFile(path.join(stateDir, 'posts.json'), backupPath)
        // Order retired entries OLDEST-first so the oldest beyond `retiredKeep`
        // are pruned. Prefer `retiredAt` (readable ms epoch) when present;
        // otherwise fall back to the entry's insertion-index in posts.json (a
        // monotonic fallback — a legacy entry with no retiredAt sorts as the
        // pre-timestamp lineage, i.e. OLDER than any explicit retiredAt).
        const items = retiredPostIds.map((postId, idx) => {
          const e = baseRaw[postId] as Record<string, unknown>
          const retiredAt = typeof e.retiredAt === 'number' ? e.retiredAt : undefined
          return { postId, idx, retiredAt }
        })
        items.sort((a, b) => {
          if (a.retiredAt !== undefined && b.retiredAt !== undefined) return a.retiredAt - b.retiredAt
          if (a.retiredAt !== undefined && b.retiredAt === undefined) return 1
          if (a.retiredAt === undefined && b.retiredAt !== undefined) return -1
          return a.idx - b.idx
        })
        const pruneCount = items.length - retiredKeep
        const pruned = items.slice(0, pruneCount)
        const prunedSet = new Set(pruned.map((item) => item.postId))
        // Archive each pruned entry (append-only JSONL — full entry preserved).
        const archiveLines = pruned.map((item) => JSON.stringify({ postId: item.postId, entry: baseRaw[item.postId], prunedAt: nowMs }))
        await appendFile(archivePath, `${archiveLines.join('\n')}\n`, 'utf8')
        // Rebuild posts.json WITHOUT the pruned entries (live + newest retirement
        // keep the exact on-disk shape — R6).
        const newRaw: Record<string, unknown> = {}
        for (const [postId, value] of Object.entries(baseRaw)) {
          if (!prunedSet.has(postId)) newRaw[postId] = value
        }
        workingRaw = newRaw
        changed = true
        prunedPostIds = pruned.map((item) => item.postId)
        logger?.warn(`[deepartments] reconcile-posts: PRUNED ${pruned.length} retired post(s) beyond the newest ${retiredKeep} (backup ${path.basename(backupPath)}, archive ${path.basename(archivePath)})`)
      }
    } catch (error: unknown) {
      logger?.warn(`[deepartments] reconcile-posts: retired-prune failed (the durable file is left untouched): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Write the now-current posts.json atomically (tmp + rename) when either the
  // gone-retire mark or the retired-prune changed the durable file.
  if (changed && workingRaw !== undefined) {
    try {
      const nowMs = (opts.now ?? (() => Date.now()))()
      const tmpPath = path.join(stateDir, `posts.json.tmp-${nowMs}`)
      await writeFile(tmpPath, JSON.stringify(workingRaw, null, 2), 'utf8')
      await rename(tmpPath, path.join(stateDir, 'posts.json'))
    } catch (error: unknown) {
      logger?.warn(`[deepartments] reconcile-posts: posts.json write failed (the process state stays in-memory only): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { workerRetireCandidates: result.workerRetireCandidates, workersRetired, headStaleCandidates: result.headStaleCandidates, changed, prunedPostIds }
}

/** B5-GHOST (QH — dispatch-hardening, 2026-08-28): the AFTER half of the
 * «429-primer-call» class — a catalog-LIVE post (the durable posts.json entry
 * is non-retired, so it still shows in the roster) whose session is NO LONGER
 * USABLE (offline/muerto: the durable session is definitively gone, or the B5
 * VARIANT-2 ghost — a durable session present but with no usable
 * AgentOptions). A post "solo entre materializaciones" (a live post whose
 * session exists but is merely not materialized right now) is NOT a ghost: its
 * durable session is resumable → USABLE. THE HEURISTIC IS THE CENSUS LEDGER:
 * the first observation NEVER auto-retires (false-positive risk); a
 * `ghost-suspect` MARKER appears only after `warnAfterTicks` CONSECUTIVE
 * census ticks without a usable session, and auto-retire happens ONLY when the
 * marker persists > `retireAfterTicks` MORE ticks (conservative defaults). A
 * post whose session becomes usable again at ANY census is CLEARED (consecutive
 * misses reset) — an intermittent session NEVER accumulates a marker.
 * The census runs at BOOT (each boot = ONE tick), seeded with the durable
 * ledger `<stateDir>/ghost-suspect-state.json`. */
export const GHOST_SUSPECT_STATE_FILE = 'ghost-suspect-state.json'

/** One ledger entry: the CONSECUTIVE census misses + the marker epoch. The
 * entry IS the `ghost-suspect` marker once `markedAt` is set. */
export interface GhostSuspectLedgerEntry {
  /** Consecutive census ticks whose census found the post WITHOUT a usable
   * session. Any census finding the session usable RESETS this (the entry is
   * dropped entirely — a recovered/intermittent post never accumulates). */
  misses: number
  /** Epoch-ms when the marker first appeared (misses crossed
   * `warnAfterTicks`). Absent = no marker yet (warn-only pending). */
  markedAt?: number
  /** Epoch-ms of the LAST census that counted a miss. */
  lastMissAt: number
}

/** The durable ledger: `postId → GhostSuspectLedgerEntry`. */
export type GhostSuspectLedger = Record<string, GhostSuspectLedgerEntry>

/** One census row: a catalog-LIVE worker the census judges. */
export interface GhostSuspectCensusRow {
  postId: string
  sessionId: string
  /** Whether the post currently HAS a usable session (live in the agents
   * registry, or a durable session present + not B5-unusable). A conservative
   * resolver (unable to determine) MUST return true — a post whose session is
   * merely unverifiable is NEVER treated as a ghost (m-119 conservatism). */
  usable: boolean
}

/** The b5-ghost config knobs (code defaults when absent — conservative). */
export interface GhostSuspectCensusKnobs {
  /** The marker threshold: N = consecutive census misses before the
   * `ghost-suspect` MARKER appears (default 2 — a single miss is never a
   * marker: the first observation could be a between-materializations
   * transient). */
  warnAfterTicks: number
  /** The retire threshold: M = how many MORE consecutive misses (beyond the
   * marker) before the post is AUTO-RETIRED — the marker must PERSIST > M
   * ticks (default 8 — conservative; a ghost lingers as a WARN for 8+ census
   * ticks before the auto-retire). `misses > warnAfterTicks + retireAfterTicks`
   * triggers the retire. */
  retireAfterTicks: number
}

/** The b5-ghost census verdict for ONE census pass. */
export interface GhostSuspectCensusResult {
  /** The NEXT ledger (persisted by the caller). */
  ledger: GhostSuspectLedger
  /** Posts whose marker appeared THIS census (crossed `warnAfterTicks`) —
   * the caller WARNS for each (ghost-suspect, NOT auto-retired yet). */
  newlyMarked: string[]
  /** Posts whose marker persisted > N + M ticks — the caller AUTO-RETIRES
   * each (the ONLY auto-retire branch of the heuristic). */
  retireCandidates: string[]
  /** Posts whose session became usable again THIS census (the ledger entry
   * was dropped — a recovered/intermittent post, never retired). */
  cleared: string[]
}

/** Read `<stateDir>/ghost-suspect-state.json` → the ledger. Absent /
 * unreadable / malformed → {} (never throws — the census starts clean). */
export function readGhostSuspectLedger(stateDir: string): GhostSuspectLedger {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, GHOST_SUSPECT_STATE_FILE), 'utf8')) as Record<string, unknown>
    const ledger: GhostSuspectLedger = {}
    for (const [postId, raw] of Object.entries(parsed)) {
      if (raw === null || typeof raw !== 'object') continue
      const e = raw as Record<string, unknown>
      const misses = typeof e.misses === 'number' && Number.isFinite(e.misses) ? e.misses : 0
      const lastMissAt = typeof e.lastMissAt === 'number' && Number.isFinite(e.lastMissAt) ? e.lastMissAt : 0
      const entry: GhostSuspectLedgerEntry = { misses: Math.max(0, misses), lastMissAt }
      if (typeof e.markedAt === 'number' && Number.isFinite(e.markedAt)) entry.markedAt = e.markedAt
      ledger[postId] = entry
    }
    return ledger
  } catch {
    return {}
  }
}

/** Write `<stateDir>/ghost-suspect-state.json` (mkdir -p the dir, then the
 * file). NEVER throws. */
export async function writeGhostSuspectLedger(stateDir: string, ledger: GhostSuspectLedger): Promise<void> {
  try {
    await mkdir(path.dirname(path.join(stateDir, GHOST_SUSPECT_STATE_FILE)), { recursive: true })
    await writeFile(path.join(stateDir, GHOST_SUSPECT_STATE_FILE), JSON.stringify(ledger), 'utf8')
  } catch {
    /* non-fatal — the in-memory ledger still drives THIS pass; the next boot re-seeds */
  }
}

/** B5-GHOST — the PURE census step. Given the census rows + the PREVIOUS
 * ledger + nowMs + the knobs, computes the NEXT ledger + the verdicts. Rules:
 *  - usable row → the ledger entry is DROPPED (cleared — a session recovered;
 *    the consecutive-miss chain is broken: an intermittent session NEVER
 *    accumulates toward a marker);
 *  - unusable row → misses = prev.misses + 1; when misses >= warnAfterTicks the
 *    marker appears (markedAt = nowMs, first crossing → newlyMarked);
 *  - when the marker exists AND misses > warnAfterTicks + retireAfterTicks →
 *    retireCandidates (the ONLY auto-retire branch — the marker persisted > M
 *    ticks);
 *  - ledger entries for posts NOT in this census (retired / unregistered) are
 *    PRUNED (a retired post's marker must not linger).
 * Pure, never throws — deterministic for the tests (a fixture of N censuses
 * drives the marker → retire ladder exactly). */
export function stepGhostSuspectCensus(
  rows: readonly GhostSuspectCensusRow[],
  previous: GhostSuspectLedger,
  nowMs: number,
  knobs: GhostSuspectCensusKnobs
): GhostSuspectCensusResult {
  const ledger: GhostSuspectLedger = {}
  const seen = new Set<string>()
  const newlyMarked: string[] = []
  const retireCandidates: string[] = []
  const cleared: string[] = []
  const warnAfterTicks = Math.max(1, Math.trunc(knobs.warnAfterTicks) || 2)
  const retireAfterTicks = Math.max(1, Math.trunc(knobs.retireAfterTicks) || 8)
  for (const row of rows) {
    seen.add(row.postId)
    const prev = previous[row.postId]
    if (row.usable === true) {
      if (prev !== undefined) cleared.push(row.postId)
      // usable → entry dropped: no ledger row at all
      continue
    }
    // unusable: extend the consecutive-miss chain.
    const misses = (prev?.misses ?? 0) + 1
    const markedAt = prev?.markedAt !== undefined ? prev.markedAt : misses >= warnAfterTicks ? nowMs : undefined
    if (markedAt !== undefined && prev?.markedAt === undefined) newlyMarked.push(row.postId)
    if (markedAt !== undefined && misses > warnAfterTicks + retireAfterTicks) retireCandidates.push(row.postId)
    const entry: GhostSuspectLedgerEntry = { misses, lastMissAt: nowMs }
    if (markedAt !== undefined) entry.markedAt = markedAt
    ledger[row.postId] = entry
  }
  // Prune ledger entries whose post left the census (retired/unregistered).
  for (const postId of Object.keys(previous)) {
    if (!seen.has(postId)) {
      const entry = previous[postId]
      if (entry !== undefined && entry.markedAt !== undefined) {
        // A marked ghost that left the census is a RESOLVED case (retired
        // elsewhere, e.g. by its head) — the marker is retired with it.
        cleared.push(postId)
      }
    }
  }
  return { ledger, newlyMarked, retireCandidates, cleared }
}

// ===========================================================================
// fb-78 A2 — the OFFLINE-WORKER REAP ledger (the fb-56 orphaned class): the
// wall-clock sibling of the b5-ghost census. Where b5-ghost judges a catalog-
// LIVE post whose DURABLE SESSION is gone/unusable (a tick ladder over the
// SAME boot-only census), A2 judges a NON-RETIRED WORKER whose session is
// PRESENT but has NO LIVE HANDLE for a WALL-CLOCK window — the mid-mission
// daemon-kill class (fb-56: the 7 IPD orphans with durable sessions mtime'd
// 09-02, never re-woken because no delivery row is pending). The ledger is
// durable (`<stateDir>/offline-reap-state.json`) and each BOOT is one census:
//   - a worker OFFLINE at a census gets its FIRST observation STAMPED
//     (offlineSince ??= now — the FIRST census NEVER retires: warm-up, the
//     same conservatism as b5's "a single miss is never a marker");
//   - a worker LIVE at any census is CLEARED (the entry drops — an
//     intermittent/returning worker never accumulates);
//   - only when now − offlineSince > maxOfflineMs (a PREVIOUS census stamped
//     the entry) does the worker become a retireCandidate — the pass then
//     re-checks liveness immediately before retirePost.
// ALTERNATIVE (documented, not the default): the first observation could seed
// offlineSince from the DURABLE ARTIFACT's mtime instead of now (an orphan
// that has been dead for days would then retire on the FIRST boot after the
// knob is enabled, without a 72h warm-up boot). The default keeps the
// conservative warm-up (never retire on an un-warmed observation) — the
// mtime-seed variant is a policy choice for a later owner decision.
// ===========================================================================

/** The durable A2 ledger file name. */
export const OFFLINE_REAP_STATE_FILE = 'offline-reap-state.json'

/** One A2 ledger entry: the wall-clock stamp of the worker's FIRST observed
 * offline census. Absent entry = the worker was never observed offline (or was
 * cleared by a later live census). */
export interface OfflineReapLedgerEntry {
  /** Epoch-ms when the worker was FIRST observed offline (no live handle, no
   * sleepEpoch). Stamped on the first offline census — never the basis of a
   * retire on the SAME census (warm-up). */
  offlineSince: number
  /** Epoch-ms of the LAST census that observed the worker offline. */
  lastSeenOfflineAt: number
}

/** The durable A2 ledger: `postId → OfflineReapLedgerEntry`. */
export type OfflineReapLedger = Record<string, OfflineReapLedgerEntry>

/** One A2 census row: a NON-RETIRED worker post the census judges. */
export interface OfflineReapCensusRow {
  postId: string
  sessionId: string
  /** Whether the worker is OFFLINE at this census: NO live agent handle
   * (agents.get(sessionId) === undefined) AND NO sleepEpoch mark (a slept
   * worker is dormant-by-design and is NEVER reaped — the registry.ts:625-629
   * sleepEpoch exception mirrored from computeDeptWhoState). */
  offline: boolean
}

/** The A2 census knobs (code defaults when absent — conservative). */
export interface OfflineReapCensusKnobs {
  /** The wall-clock window (ms): how long a worker must be continuously
   * offline (offlineSince → now) before it becomes a retire candidate.
   * Default 72h. */
  maxOfflineMs: number
}

/** The A2 census verdict for ONE census pass. */
export interface OfflineReapCensusResult {
  /** The NEXT ledger (persisted by the caller). */
  ledger: OfflineReapLedger
  /** Workers whose offline window crossed `maxOfflineMs` THIS census — the
   * caller re-verifies liveness and calls retirePost for each (the ONLY
   * auto-retire branch of the reap). */
  retireCandidates: string[]
  /** Workers that were observed LIVE (or left the census) THIS census — their
   * entries were cleared (an intermittent/returning worker never accumulates). */
  cleared: string[]
}

/** Read `<stateDir>/offline-reap-state.json` → the ledger. Absent / unreadable
 * / malformed → {} (never throws — the census starts clean). */
export function readOfflineReapLedger(stateDir: string): OfflineReapLedger {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, OFFLINE_REAP_STATE_FILE), 'utf8')) as Record<string, unknown>
    const ledger: OfflineReapLedger = {}
    for (const [postId, raw] of Object.entries(parsed)) {
      if (raw === null || typeof raw !== 'object') continue
      const e = raw as Record<string, unknown>
      const offlineSince = typeof e.offlineSince === 'number' && Number.isFinite(e.offlineSince) ? e.offlineSince : 0
      const lastSeenOfflineAt = typeof e.lastSeenOfflineAt === 'number' && Number.isFinite(e.lastSeenOfflineAt) ? e.lastSeenOfflineAt : 0
      if (offlineSince <= 0) continue
      ledger[postId] = { offlineSince, lastSeenOfflineAt }
    }
    return ledger
  } catch {
    return {}
  }
}

/** Write `<stateDir>/offline-reap-state.json` (mkdir -p the dir, then the
 * file). NEVER throws. */
export async function writeOfflineReapLedger(stateDir: string, ledger: OfflineReapLedger): Promise<void> {
  try {
    await mkdir(path.dirname(path.join(stateDir, OFFLINE_REAP_STATE_FILE)), { recursive: true })
    await writeFile(path.join(stateDir, OFFLINE_REAP_STATE_FILE), JSON.stringify(ledger), 'utf8')
  } catch {
    /* non-fatal — the in-memory ledger still drives THIS pass; the next boot re-seeds */
  }
}

/** fb-78 A2 — the PURE census step. Given the census rows + the PREVIOUS
 * ledger + nowMs + the knobs, computes the NEXT ledger + the verdicts. Rules:
 *  - offline row → the entry's `offlineSince` is STAMPED on the FIRST offline
 *    observation (offlineSince ??= now — warm-up: a first observation NEVER
 *    retires, its window is 0); only a PRE-EXISTING entry whose
 *    now − offlineSince > maxOfflineMs becomes a retireCandidate (the window
 *    was opened by an EARLIER census);
 *  - live row → the entry is DROPPED (cleared — the worker returned;
 *    intermittent workers never accumulate);
 *  - ledger entries for posts NOT in this census (retired / unregistered) are
 *    PRUNED (a retired worker's stamp must not linger).
 * Pure, never throws — deterministic for the tests (a fixture of censuses
 * drives the stamp → clear → candidate ladder exactly). */
export function stepOfflineReapCensus(
  rows: readonly OfflineReapCensusRow[],
  previous: OfflineReapLedger,
  nowMs: number,
  knobs: OfflineReapCensusKnobs
): OfflineReapCensusResult {
  const maxOfflineMs = Math.max(1, Number.isFinite(knobs.maxOfflineMs) ? Math.trunc(knobs.maxOfflineMs) : 259200000)
  const ledger: OfflineReapLedger = {}
  const seen = new Set<string>()
  const retireCandidates: string[] = []
  const cleared: string[] = []
  for (const row of rows) {
    seen.add(row.postId)
    const prev = previous[row.postId]
    if (row.offline === false) {
      // live at this census → entry dropped (never accumulate).
      if (prev !== undefined) cleared.push(row.postId)
      continue
    }
    // offline: stamp the first observation (warm-up — window 0, never a
    // candidate on the same census); a pre-existing entry with a crossed
    // window IS a candidate.
    const offlineSince = prev?.offlineSince ?? nowMs
    if (prev !== undefined && nowMs - offlineSince > maxOfflineMs) retireCandidates.push(row.postId)
    ledger[row.postId] = { offlineSince, lastSeenOfflineAt: nowMs }
  }
  // Prune ledger entries whose post left the census (retired/unregistered).
  for (const postId of Object.keys(previous)) {
    if (!seen.has(postId)) cleared.push(postId)
  }
  return { ledger, retireCandidates, cleared }
}

/** Result of the deterministic live-host selection (U3 fix, spec 002 §6.1). */
export interface PickLiveHostResult {
  /** The selected live entry, or undefined when NO live entry exists. */
  live: HostEntryLike | undefined
  /** True when the AMBIGUITY FALLBACK branch fired (multiple live entries,
   * none carrying `previousSessionId`): the caller should log a warn listing
   * the candidates. False for the successor / single-live / no-live branches. */
  ambiguous: boolean
}

/** PURE deterministic live-host selection (U3 fix, spec 002 §6.1). Among the
 * NON-RETIRED entries, prefer, in order:
 *   (a) the rotation-created SUCCESSOR — the entry carrying
 *       `previousSessionId` (the true current host after a rotation);
 *   (b) the ONLY live entry, when exactly one exists;
 *   (c) the first live entry in iteration (insertion) order, flagged
 *       `ambiguous: true` so the caller can warn.
 * Deterministic for every hosts.json shape. No side effects — unit-testable
 * without the invoke context. */
export function pickLiveHostEntry(entries: Iterable<HostEntryLike>): PickLiveHostResult {
  let successor: HostEntryLike | undefined
  const liveEntries: HostEntryLike[] = []
  for (const entry of entries) {
    if (entry.retired === true) continue
    liveEntries.push(entry)
    if (
      successor === undefined &&
      entry.previousSessionId !== undefined &&
      entry.previousSessionId !== ''
    ) {
      successor = entry
    }
  }
  if (successor !== undefined) return { live: successor, ambiguous: false }
  if (liveEntries.length === 1) return { live: liveEntries[0], ambiguous: false }
  if (liveEntries.length === 0) return { live: undefined, ambiguous: false }
  // Multiple live entries, none rotation-created → ambiguity fallback.
  return { live: liveEntries[0], ambiguous: true }
}

/** ONE ACTIVE (non-retired) catalog member as the roster / live-catalog lense
 * sees it. A discriminated union so a consumer keeps the post-vs-host kind and
 * its durable fields (postId/hostId, agentPreset, sleepEpoch) without re-deriving
 * which map each came from. */
export type ActiveCatalogMember =
  | { kind: 'post'; entry: PostEntry }
  | { kind: 'host'; entry: HostEntry }

/** THE single-source ACTIVE-ONLY catalog list (FASE 2 STEP e): every non-retired
 * post + every non-retired host, in catalog (map) iteration order — posts first,
 * then hosts. This is the ONE implementation of "who is a live member" today: the
 * condensed roster (`buildCondensedRoster`) and the future `dept_who` / live
 * registry both derive the active-only filter from THIS function, so the filter
 * is never duplicated across consumers. PURE: no I/O, no module-global mutable
 * state — only iterates the two catalog maps it is handed. */
export function listActiveMembers(
  posts: Iterable<PostEntry>,
  hosts: Iterable<HostEntry>
): ActiveCatalogMember[] {
  const members: ActiveCatalogMember[] = []
  for (const entry of posts) {
    if (entry.retired === true) continue
    members.push({ kind: 'post', entry })
  }
  for (const entry of hosts) {
    if (entry.retired === true) continue
    members.push({ kind: 'host', entry })
  }
  return members
}

/** Minimal warn/info-capable logger the RegistryStore uses (the cordis logger
 * shape). `info` is optional (only the load paths need it). */
export interface RegistryLogger {
  warn(message: string): void
  info?(message: string): void
}

/** Constructor deps for a `RegistryStore`. */
export interface RegistryStoreDeps {
  /** The org stateDir (`config.stateDir`): the directory hosting
   * `posts.json` + `hosts.json`. */
  stateDir: string
  /** A warn/info-capable logger (the cordis `ctx.logger`). */
  logger: RegistryLogger
}

/** Optional extras for `ensureHost` — the ctx-dependent side effects the store
 * does NOT own. */
export interface EnsureHostExtras {
  /** Pin the "Asistente" title on the host session (a session-title concern
   * that needs the live `ctx.sessions`; the store stays session-service-free).
   * Called ONLY after the registration guards pass, exactly where the
   * pre-extraction ensureHost pinned the title. */
  pinHostTitle?(sessionId: string): void
}

/** The DURABLE REGISTRY — the single source of the hosts/posts catalog.
 *
 * Constructed PER-APPLY inside `applyInvoke` (AGENTS.md rule 4: no module-global
 * mutable state). OWNS:
 *   - the in-memory catalog (`byPost`, `byChild`, `hosts`, `hostForSession`);
 *   - the DURABLE read (cold load of `posts.json`/`hosts.json`) + PERSIST
 *     (atomic write, byte-compatible with the pre-extraction format — R6);
 *   - the `retired`-MARKED, NEVER-ERASED catalog semantics (`isRetired`,
 *     `markPostRetired`, `registerEntry`);
 *   - the host registration (`ensureHost`) + the member resolver
 *     (`postIdForChild` / `getPost` / `getHost` / `hostIdForSession`).
 *
 * The mutation + persist methods are the ONLY writers of `posts.json` /
 * `hosts.json` in the org layer, so every consumer (the bus, the lifecycle
 * tools, the roster) reads the SAME live catalog through the SAME maps. */
export class RegistryStore {
  /** The durable post registry (postId → entry). */
  readonly byPost = new Map<string, PostEntry>()
  /** The postId-by-session reverse index (child session → postId). */
  readonly byChild = new Map<string, string>()
  /** The host registry (hostId → entry). */
  readonly hosts = new Map<string, HostEntry>()
  /** The hostId-by-session reverse index (session → hostId). */
  readonly hostForSession = new Map<string, string>()
  /** `<stateDir>/posts.json`. */
  readonly postsPath: string
  /** `<stateDir>/hosts.json`. */
  readonly hostsPath: string
  private readonly deps: RegistryStoreDeps

  constructor(deps: RegistryStoreDeps) {
    this.deps = deps
    this.postsPath = path.join(deps.stateDir, 'posts.json')
    this.hostsPath = path.join(deps.stateDir, 'hosts.json')
  }

  // --- catalog accessors ---------------------------------------------------

  /** The durable post entry for a postId, or `undefined`. */
  getPost(postId: string): PostEntry | undefined {
    return this.byPost.get(postId)
  }

  /** The durable host entry for a hostId, or `undefined`. */
  getHost(hostId: string): HostEntry | undefined {
    return this.hosts.get(hostId)
  }

  /** Deterministic durable member id for a HOST session (Batch 7): the same
   * `host-<sessionId>` address used for the journal path and hosts.json. */
  hostIdForSession(sessionId: string): string {
    return `${HOST_ID_PREFIX}${sessionId}`
  }

  /** The postId a child session is registered under, or `undefined`. */
  postIdForChild(childId: string): string | undefined {
    return this.byChild.get(childId)
  }

  /** `true` iff the post is MARKED retired (never erased). */
  isRetired(postId: string): boolean {
    return this.byPost.get(postId)?.retired === true
  }

  // --- durable PERSIST (fire-and-forget, byte-compatible — R6) --------------

  /** Fire-and-forget persistence of the host registry (callers never await it).
   * Every persisted file carries the top-level schemaVersion marker (D4); the
   * loader validation tolerates legacy files without it. */
  persistHosts(): void {
    const data: Record<string, unknown> = { schemaVersion: ROTATION_SCHEMA_VERSION }
    for (const entry of this.hosts.values()) {
      data[entry.hostId] = {
        sessionId: entry.sessionId,
        roomId: entry.roomId,
        ...(entry.sleepEpoch !== void 0 ? { sleepEpoch: entry.sleepEpoch } : {}),
        ...(entry.boundarySeq !== void 0 ? { boundarySeq: entry.boundarySeq } : {}),
        ...(entry.webUiCleanupPending === true ? { webUiCleanupPending: true } : {}),
        ...(entry.deferredJournalSeed !== void 0 ? { deferredJournalSeed: entry.deferredJournalSeed } : {}),
        ...(entry.retired === true ? { retired: true } : {}),
        ...(entry.retiredAt !== void 0 ? { retiredAt: entry.retiredAt } : {}),
        ...(entry.rotatedTo !== void 0 ? { rotatedTo: entry.rotatedTo } : {}),
        ...(entry.previousSessionId !== void 0 ? { previousSessionId: entry.previousSessionId } : {})
      }
    }
    writeFile(this.hostsPath, JSON.stringify(data, null, 2), 'utf8').catch(
      (error: unknown) => { this.deps.logger.warn(`[deepartments] hosts.json write failed: ${error instanceof Error ? error.message : String(error)}`) }
    )
  }

  /** Persistence of the post registry. Callers MAY await it (returns the write
   * promise) so a durability-critical step can be gated on the write completing;
   * all other callers keep the fire-and-forget shape. The promise ALWAYS
   * settles — a failed write resolves (the error is logged), never rejects. */
  persistPosts(): Promise<void> {
    const data: Record<string, PostEntryPersisted> = {}
    for (const entry of this.byPost.values()) {
      data[entry.postId] = {
        sessionId: entry.sessionId,
        roomId: entry.roomId,
        agentPreset: entry.agentPreset,
        ...(entry.provider !== void 0 ? { provider: entry.provider } : {}),
        ...(entry.role !== void 0 ? { role: entry.role } : {}),
        ...(entry.departmentId !== void 0 ? { departmentId: entry.departmentId } : {}),
        ...(entry.managerId !== void 0 ? { managerId: entry.managerId } : {}),
        ...(entry.jobId !== void 0 ? { jobId: entry.jobId } : {}),
        ...(entry.retired === true ? { retired: true } : {}),
        ...(entry.sleepEpoch !== void 0 ? { sleepEpoch: entry.sleepEpoch } : {}),
        ...(entry.boundarySeq !== void 0 ? { boundarySeq: entry.boundarySeq } : {}),
        ...(entry.previousChildId !== void 0 ? { previousChildId: entry.previousChildId } : {}),
        ...(entry.rotated === true ? { rotated: true } : {}),
        ...(Array.isArray(entry.inflightWorkers) && entry.inflightWorkers.length > 0 ? { inflightWorkers: entry.inflightWorkers } : {}),
        ...(Array.isArray(entry.tools) && entry.tools.length > 0 ? { tools: entry.tools } : {})
      }
    }
    return writeFile(this.postsPath, JSON.stringify(data, null, 2), 'utf8').catch(
      (error: unknown) => { this.deps.logger.warn(`[deepartments] posts.json write failed: ${error instanceof Error ? error.message : String(error)}`) }
    )
  }

  // --- catalog ops (the ONLY writers of the in-memory catalog) --------------

  /** Register/refresh a post entry and persist. Keeps the postId-by-session
   * reverse index in sync. */
  registerEntry(entry: PostEntry): void {
    this.byPost.set(entry.postId, entry)
    this.byChild.set(entry.sessionId, entry.postId)
    this.persistPosts()
  }

  /**
   * MARK a post RETIRED (never erased — F1). Sets `retired: true` on the live
   * entry, prunes it from its manager's in-flight ledger, and persists. Returns
   * `false` (no-op) when the post is unknown. The caller decides whether a
   * configured head is also UNREGISTERED (a head retire is cosmetic today) —
   * this primitive only computes the durable MARK for workers.
   *
   * O4 RETIRE-ON-DELIVERY (m-952 + D-Q2 c4739f3d, fold-in tramo 3A): the REAL
   * retire ALSO appends the post's audit row to the retired archive
   * (`retiredArchiveFile`, default `posts-retired-archive.jsonl`) — the SAME
   * `{postId, entry, prunedAt}` row shape the boot prune appends — so EVERY
   * real retire (dept_post_retire / dept_worker_retire / the auto-retire-on-
   * delivery / the boot-reconcile reap — all funnel through this mark)
   * inventories a row REGARDLESS of the retired-count prune threshold (the
   * archive-log gap: frozen with 0 rows for 09-04 despite several retires —
   * the archive previously grew ONLY at boot prunes beyond `retiredKeep`).
   * Awaited by the retire seam so the row is on disk BEFORE the retire returns.
   * Non-fatal: a failed append only warns (the retire mark already committed —
   * the mark is the durable part; a later boot prune re-inventories the entry
   * once the retired count crosses the keep).
   */
  async markPostRetired(postId: string, opts?: { retiredArchiveFile?: string; now?: () => number }): Promise<void> {
    const entry = this.byPost.get(postId)
    if (entry === void 0 || entry.retired === true) return
    entry.retired = true
    if (entry.managerId !== void 0) {
      const manager = this.byPost.get(entry.managerId)
      if (manager !== void 0 && Array.isArray(manager.inflightWorkers)) {
        const idx = manager.inflightWorkers.indexOf(postId)
        if (idx >= 0) manager.inflightWorkers = manager.inflightWorkers.filter((w) => w !== postId)
      }
    }
    this.persistPosts()
    // O4 — the RETIRE-ON-DELIVERY archive row (see the doc above). The archived
    // entry is the DURABLE shape (postId stripped — the row's top-level postId
    // carries the key, exactly like the boot-prune rows).
    try {
      const nowMs = (opts?.now ?? (() => Date.now()))()
      const archiveFile = opts?.retiredArchiveFile ?? 'posts-retired-archive.jsonl'
      const archivePath = path.join(this.deps.stateDir, archiveFile)
      const { postId: _postId, ...archivedEntry } = entry
      await appendFile(archivePath, `${JSON.stringify({ postId, entry: archivedEntry, prunedAt: nowMs })}\n`, 'utf8')
    } catch (error: unknown) {
      this.deps.logger.warn(`[deepartments] retire archive append failed for "${postId}" (non-fatal — the retire mark already committed; a future prune/retire re-inventories it): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Remove a post from the live catalog (a configured-head cosmetic retire:
   * the entry is deleted from byPost/byChild and persisted; the durable
   * posts.json entry is rewritten without it — the config re-materializes it at
   * boot). Returns `false` when the post is unknown. */
  unregisterPost(postId: string): boolean {
    const entry = this.byPost.get(postId)
    if (entry === void 0) return false
    this.byPost.delete(postId)
    this.byChild.delete(entry.sessionId)
    this.persistPosts()
    return true
  }

  /** A3/C2 — DROP the given postIds from the in-memory catalog ONLY (NO persist).
   * The durable A3/C2 prune already rewrote posts.json atomically; calling this
   * keeps the in-memory `byPost`/`byChild` CONSISTENT with the pruned file so a
   * LATER `persistPosts()` writes the PRUNED set — never the full pre-prune set
   * (the C2 partial-prune regression: a file-based prune with no in-memory sync
   * is overwritten by the next full-set persist). The pruned entries are the
   * OLDEST retired posts beyond `retiredKeep` — already archived + backed up, so
   * removing them from the live catalog is safe (a pruned post is no longer a
   * roster/wake target). The reverse index (`byChild`: sessionId → postId) is
   * dropped for the same entries. Unknown ids are ignored. Returns the count of
   * posts actually removed. Do NOT call `persistPosts()` here — the durable file
   * is ALREADY the pruned (correct) state; persisting would be a redundant write
   * and would resurrect a boot race with a concurrent writer. */
  removePosts(postIds: string[]): number {
    let removed = 0
    for (const postId of postIds) {
      const entry = this.byPost.get(postId)
      if (entry === void 0) continue
      this.byPost.delete(postId)
      this.byChild.delete(entry.sessionId)
      removed++
    }
    return removed
  }

  /** Lazy host registration — the SINGLE-LIVE-HOST guard + rotation MERGE
   * semantics (see the pre-extraction ensureHost contract). Calls
   * `extras.pinHostTitle` (if supplied) ONLY after the guards pass, exactly
   * where the pre-extraction ensureHost pinned the title, and persists. Returns
   * the host's member id. */
  ensureHost(sessionId: string, roomId: string, extras: EnsureHostExtras = {}): string {
    const hostId = `${HOST_ID_PREFIX}${sessionId}`
    const existing = this.hosts.get(hostId)
    if (existing?.retired === true) {
      this.deps.logger.warn(`[deepartments] ensureHost: refusing to re-register retired host ${hostId} (rotated to ${existing.rotatedTo ?? 'unknown'}) — the session stays a plain session`)
      return hostId
    }
    // Single-live-host guard: a NEW registration while another non-retired host
    // entry exists must NOT mint a second live host (wake-12→13).
    if (existing === undefined) {
      for (const candidate of this.hosts.values()) {
        if (candidate.retired !== true && candidate.sessionId !== sessionId) {
          this.deps.logger.warn(`[deepartments] ensureHost: refusing new host registration ${hostId} — live host already exists: ${candidate.hostId}; the session stays a plain session`)
          return candidate.hostId
        }
      }
    }
    // U4 — pin the durable "Asistente" title (ctx-dependent side effect; the
    // store injects it via the hook, keeping the registry session-service-free).
    extras.pinHostTitle?.(sessionId)
    // MERGE (relay-fix): preserve every field ensureHost does not own and
    // refresh only the durable identity (hostId/sessionId). roomId is assigned
    // ONLY at CREATE (host-roomId latch fix).
    this.hosts.set(hostId, existing === undefined
      ? { hostId, sessionId, roomId }
      : { ...existing, hostId, sessionId })
    this.hostForSession.set(sessionId, hostId)
    this.persistHosts()
    return hostId
  }

  // --- durable READ (cold load at boot) -------------------------------------

  /** Best-effort cold load of the post registry from `posts.json`. Legacy
   * continuable-subagent entries (no sessionId/roomId/agentPreset) and orphaned
   * fork ghosts are NOT registered (kept out of the in-memory registry only;
   * posts.json is untouched until a later persistPosts overwrites it). Never
   * throws (a malformed/absent file logs a warn + starts empty). */
  async loadPosts(): Promise<void> {
    const text = await readFile(this.postsPath, 'utf8')
    const parsed = JSON.parse(text) as Record<string, Record<string, unknown>>
    let sweptLegacy = 0
    for (const [postId, entry] of Object.entries(parsed)) {
      if (entry?.provider === 'fork') {
        sweptLegacy++
        continue
      }
      const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId : undefined
      if (sessionId !== undefined && typeof entry?.roomId === 'string' && typeof entry?.agentPreset === 'string') {
        const sleepEpoch = typeof entry.sleepEpoch === 'number' ? entry.sleepEpoch : undefined
        const boundarySeq = typeof entry.boundarySeq === 'number' ? entry.boundarySeq : undefined
        const previousChildId = typeof entry.previousChildId === 'string' ? entry.previousChildId : undefined
        const rotated = entry.rotated === true
        const provider = entry.provider === 'worker' ? 'worker' as const : undefined
        const role = typeof entry.role === 'string' ? entry.role : undefined
        const departmentId = typeof entry.departmentId === 'string' ? entry.departmentId : undefined
        const managerId = typeof entry.managerId === 'string' ? entry.managerId : undefined
        const jobId = typeof entry.jobId === 'string' ? entry.jobId : undefined
        const retired = entry.retired === true
        const inflightWorkers = Array.isArray(entry.inflightWorkers)
          ? entry.inflightWorkers.filter((w): w is string => typeof w === 'string')
          : undefined
        // VALLE lane B (fb-29 structural fix): the worker's durable role-template
        // `tools` allow-list survives the RESTART (design B — the cold
        // re-materialization fast-path), so it is restored into the in-memory
        // entry exactly like the other durable worker fields.
        const tools = Array.isArray(entry.tools)
          ? entry.tools.filter((t): t is string => typeof t === 'string')
          : undefined
        // Populate the in-memory catalog DIRECTLY (mirroring `loadHosts`) instead
        // of `registerEntry`, which fired a fire-and-forget `persistPosts()` PER
        // ENTRY — an unawaited, non-atomic write storm that raced the boot
        // reconcile's single read+prune of posts.json (the C2 boot-gate hang).
        // posts.json is persisted ONCE, awaited, after the loop (see below).
        this.byPost.set(postId, {
          postId,
          sessionId,
          roomId: entry.roomId,
          agentPreset: entry.agentPreset,
          ...(provider !== void 0 ? { provider } : {}),
          ...(role !== void 0 ? { role } : {}),
          ...(departmentId !== void 0 ? { departmentId } : {}),
          ...(managerId !== void 0 ? { managerId } : {}),
          ...(jobId !== void 0 ? { jobId } : {}),
          ...(retired ? { retired: true } : {}),
          ...(sleepEpoch !== void 0 ? { sleepEpoch } : {}),
          ...(boundarySeq !== void 0 ? { boundarySeq } : {}),
          ...(previousChildId !== void 0 ? { previousChildId } : {}),
          ...(rotated ? { rotated: true } : {}),
          ...(inflightWorkers !== void 0 && inflightWorkers.length > 0 ? { inflightWorkers } : {}),
          ...(tools !== void 0 && tools.length > 0 ? { tools } : {})
        })
        this.byChild.set(sessionId, postId)
      } else {
        sweptLegacy++
      }
    }
    // ONE awaited persist at the end INSTEAD of the per-entry fire-and-forget
    // write storm — posts.json is STABLE before `registryLoaded` resolves, so
    // the boot reconcile always reads a complete file (deterministic C2 prune).
    // Only fires when legacy/fork entries were actually swept (the loaded file
    // was rewritten): in the common no-drop case the file is already complete
    // and is left untouched (no gratuitous boot-time rewrite — preserves the
    // pre-fix boot timing for the delivery/noWake/QD tests).
    if (sweptLegacy > 0) {
      await this.persistPosts()
    }
    this.deps.logger.info?.(`[deepartments] loaded ${this.byPost.size} head registry entries from posts.json${sweptLegacy > 0 ? `; skipped ${sweptLegacy} legacy/non-head entry/entries (head model)` : ''}`)
  }

  /** Best-effort cold load of the host registry from `hosts.json`. Validates the
   * rotation schema BEFORE restoring (a malformed new field rejects the whole
   * load loudly); restores every host entry (a retired one is never re-armed)
   * and re-arms the DEFERRED sleep-replace intent (fix wake-12) into the given
   * `deferredSleepReplace` map. Never throws (a malformed/absent file logs a
   * warn + starts empty). */
  async loadHosts(opts: { deferredSleepReplace?: Map<string, string> } = {}): Promise<void> {
    const text = await readFile(this.hostsPath, 'utf8')
    const parsed = JSON.parse(text) as Record<string, Omit<HostEntry, 'hostId'>>
    validateHostsRotationFile(parsed)
    for (const [hostId, entry] of Object.entries(parsed)) {
      if (hostId === 'schemaVersion') continue
      if (typeof entry.sessionId === 'string' && typeof entry.roomId === 'string' && hostId.startsWith(HOST_ID_PREFIX)) {
        const sessionId = hostId.slice(HOST_ID_PREFIX.length)
        if (sessionId === entry.sessionId) {
          const sleepEpoch = typeof entry.sleepEpoch === 'number' ? entry.sleepEpoch : undefined
          const boundarySeq = typeof entry.boundarySeq === 'number' ? entry.boundarySeq : undefined
          const deferredJournalSeed = typeof entry.deferredJournalSeed === 'string' ? entry.deferredJournalSeed : undefined
          const retired = entry.retired === true
          const retiredAt = typeof entry.retiredAt === 'number' ? entry.retiredAt : undefined
          const rotatedTo = typeof entry.rotatedTo === 'string' ? entry.rotatedTo : undefined
          const previousSessionId = typeof entry.previousSessionId === 'string' ? entry.previousSessionId : undefined
          this.hosts.set(hostId, {
            hostId,
            sessionId: entry.sessionId,
            roomId: entry.roomId,
            ...(sleepEpoch !== void 0 ? { sleepEpoch } : {}),
            ...(boundarySeq !== void 0 ? { boundarySeq } : {}),
            ...(deferredJournalSeed !== void 0 ? { deferredJournalSeed } : {}),
            ...(entry.webUiCleanupPending === true ? { webUiCleanupPending: true } : {}),
            ...(retired ? { retired: true } : {}),
            ...(retiredAt !== void 0 ? { retiredAt } : {}),
            ...(rotatedTo !== void 0 ? { rotatedTo } : {}),
            ...(previousSessionId !== void 0 ? { previousSessionId } : {})
          })
          this.hostForSession.set(entry.sessionId, hostId)
          if (retired) continue
          if (deferredJournalSeed !== void 0) opts.deferredSleepReplace?.set(entry.sessionId, deferredJournalSeed)
        }
      }
    }
    this.deps.logger.info?.(`[deepartments] loaded ${this.hosts.size} host registry entries from hosts.json`)
    // Postmortem nº1 fix — the SINGLE-LIVE cardinality invariant, WARN ONLY.
    const liveHostEntries = [...this.hosts.values()].filter((candidate) => candidate.retired !== true)
    if (liveHostEntries.length > 1) {
      this.deps.logger.warn(`[deepartments] hosts.json: ${liveHostEntries.length} live host entries (exactly one required) — pickLiveHostEntry will choose deterministically among: ${liveHostEntries.map((candidate) => candidate.hostId).join(', ')}`)
    }
  }
}
