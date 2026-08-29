// dshd-gui — the `/deepartments` RPC channel (server half) + the client plugin
// source (src/client/, built separately to client/client.js by the package's
// own build:client — tsdown + scripts/normalize-client-banner.mjs — the D5
// single build/normalize source of the `deepartments-client` surface; the
// bundle's root ./client is its byte-identical mirror via
// scripts/mirror-client.mjs, R6). This
// package OWNS the PURE server-half surface that was MOVED verbatim from the
// bundle (src/invoke.ts, the dshd-gui phase of the modular Cordis split):
//
//   - the PURE endpoint dispatcher dispatchDeepartmentsEndpoint (the SAME
//     endpoint logic the legacy `ctx.connection.rpc.handle('/deepartments',
//     ...)` served) with its 6 endpoints — agents/list (the client roster
//     heartbeat; `list` = legacy alias), host/status (U3 — the client
//     lifecycle watcher's rotation signal, spec 002 §6.1), presence/get +
//     presence/set (Feature A — the owner-presence toggle) and agenda/list
//     (W1 — the client Agenda view);
//   - the PURE payload builders/types (HostStatusPayload/builder,
//     PresenceState, DeepartmentsDispatchResult, the deps interface);
//   - the client-request envelope validator (parseClientEnvelope) + the
//     authority/trust fence (isLoopbackHostname/parseAuthority/
//     isTrustedAuthority/isTrustedHostFact + HostTrustFacts);
//   - the thin node:http route handler (handleDeepartmentsRequest + its
//     private request/response helpers) — PURE in the structural sense: the
//     node:http types are only loose shapes, there are NO node:http imports,
//     so the whole module is directly unit-testable
//     (test/rpc-channel.test.js) exactly like it was in the bundle.
//
// The bundle consumes this package through the drop-in bridge
// `src/core/gui.ts` (`export * from 'dshd-gui'`). SPLIT BOUNDARY: the
// webServer MOUNT EFFECT + the endpointDeps WIRING CLOSURE (the bundle's
// `ctx.inject(['webServer','webRuntime','connection'], ...)` effect that binds
// the LIVE apply-fiber registries: org.departments, byPost, hosts, the
// sessionLive/sessionRunning signals, the presence cache wrappers, the
// journalPathFor wake-counter reader, repoRoot/stateDir/clock) STAY in the
// bundle (invoke.ts) — same criterion as dshd-jobs (the wiring closure stays,
// the pure computation moves). The deps interface below is the ONLY injected
// seam: the bundle's closure provides the live values; the tests construct
// them directly.
//
// dshd-gui deps-injection design (what the bundle's closure provides that the
// OLD module imported directly):
//   - `buildAgentRows` (deps.buildAgentRows): the PURE roster-row builder
//     still lives in the bundle (src/agents.ts — NOT moved in this phase), so
//     the agents/list branch receives it as an INJECTED dep (the same
//     "functions, never imports" rule as the sessionLive/unread signals).
//   - `pickLiveHostEntry` (deps.pickLiveHostEntry): the PURE deterministic
//     live-host pick lives in dshd-core (packages/dshd-core/src/registry.ts),
//     so the host/status branch receives it as an INJECTED dep too. The
//     structural `HostEntryLike` mirror below is field-for-field equal to
//     dshd-core's, so the bundle's real function binds without any cast.
//   - the agenda reads (readAgendaJobs/readCalendarStateFile + the
//     JobsDepartment shape) are imported FROM dshd-jobs (a pure library dep of
//     this package — the same source the bundle's dept_job_list/scheduler
//     reuse).
//   - `REPO_ROOT` (the agenda/list default-jobDir fallback when deps.repoRoot
//     is absent) is resolved from THIS package's lib dir — identical VALUE to
//     the bundle's REPO_ROOT (lib/invoke.js → `..`); production always passes
//     the apply-scope repoRoot explicitly.
//
// rc.8 TRANSPORT FIX (why the routes are self-mounted — documented here so a
// future reader knows the context): `ctx.connection.rpc.handle('/deepartments',
// ...)` did NOT mount an HTTP route in rc.8 — dsh-client-connection registers
// ONLY the `/api` prefix + its in-memory channel SERVICE via webServer; a
// channel registered on `.rpc.handle` is NOT exposed as an HTTP endpoint. The
// CONFIRMED WORKING rc.8 pattern (dshmarket) is to self-mount `kind:'exact'`
// routes on the live webServer; the bundle's mount effect serves the SAME
// client wire contract (request `POST ${origin}/deepartments/<endpoint>` with
// body `{type:'client-request', rpcId, method:<endpoint>, payload}`; response
// 200 JSON `{type:'server-response', rpcId, result:{ok,value|error}}`), and
// THIS module is the transport-agnostic computation behind it. The client
// contract is unchanged by the extraction.
//
// NO export default (pitfall 0001 — breaks `inject`).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAgendaJobs, readCalendarStateFile } from 'dshd-jobs'
import type { JobsDepartment } from 'dshd-jobs'

/** Loose structural view of a `webServer`/`httpServer` HTTP route. */
export interface WebServerRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

/** Loose structural view of the renamable `webServer`/`httpServer` service
 * (AGENTS.md rule 7; resolved via `ctx.get('webServer') ?? ctx.get('httpServer')`). */
export interface WebServerLike {
  register(route: WebServerRouteLike): () => void
}

/** The owner-presence state (Feature A — the "Presencia/Ausencia" toggle), the
 * `presence/get` RPC value and the `presence.set` input. Persisted at
 * `<stateDir>/presence.json` as `{ present: boolean, updatedAt: number }`;
 * DEFAULT present:true — the owner is considered present until explicitly
 * toggled absent, so the guard is never over-eager at boot. `updatedAt` is
 * omitted when the file has none (the owner never toggled). */
export interface PresenceState {
  present: boolean
  updatedAt?: number
}

/** Structural mirror of the bundle's `PostEntryLike` (src/agents.ts — the
 * loose durable post-registry entry view). Field-for-field equal to the
 * bundle's type so the bundle's deps closures bind without a cast; the package
 * declares its OWN copy so it stays a pure library with no bundle import
 * (same discipline as dshd-jobs' JobsDepartment). */
export interface EndpointPostEntryLike {
  postId: string
  /** The head's stable root-agent session id (`head-<postId>`). */
  sessionId: string
  roomId: string
  /** Set when the head SLEPT (next wake cold-resumes a fresh incarnation). */
  sleepEpoch?: number
  /** The sessionId of the PREVIOUS incarnation (trace marker). */
  previousChildId?: string
}

/** Structural mirror of the bundle's `AgentRow` (src/agents.ts — one row in
 * the client's "main agents" / department-heads list). Same field-for-field
 * shape as the bundle's `AgentRow` (status widened to string); the injected
 * `buildAgentRows` returns rows in this shape. */
export interface EndpointAgentRow {
  id: string
  sessionId: string
  name: string
  department: string
  kind: 'post'
  status: string
  unread: number
  running: boolean
  sleeping: boolean
  sessionLive: boolean
}

/** Structural mirror of dshd-core's `HostEntryLike` (the hosts.json value
 * view — packages/dshd-core/src/registry.ts). Field-for-field equal so the
 * bundle's real `pickLiveHostEntry` (and its `Map.values()` iterator wire)
 * bind without a cast; declared locally so this package stays a pure library. */
export interface HostEntryLike {
  hostId: string
  sessionId: string
  roomId?: string
  /** U2 (spec 002 §3.5/D4): rotation schema — set on RETIRED old entries. */
  retired?: boolean
  /** U2 (D4): when the entry was retired (ms epoch); required on retired. */
  retiredAt?: number
  /** U2 (D4): the `host-<newId>` this retired entry rotated to. */
  rotatedTo?: string
  /** U2 (D4): on a LIVE entry created by a rotation — the session id it
   * rotated FROM (references a retired entry in the same file). */
  previousSessionId?: string
}

/** Injected data/closure bundle the PURE endpoint dispatcher reads. The caller
 * (the route handler's wiring closure in the bundle's applyInvoke) wires these
 * to the live registries; tests construct this directly. dshd-gui phase: the
 * two bundle-owned PURE functions the agents/list + host/status branches need
 * (`buildAgentRows` from src/agents.ts, `pickLiveHostEntry` from dshd-core)
 * are now REQUIRED injected deps — same "functions, never imports" rule as the
 * sessionLive/unread signals. */
export interface DeepartmentsEndpointDeps {
  /** org.departments — one row built per (coordinator-bearing) department. The
   * structural subset dshd-jobs reads (id/name/jobDir/coordinator), kept
   * assignable from the bundle's richer DepartmentConfig (dshd-jobs discipline). */
  departments: JobsDepartment[]
  /** The durable post registry (postId → entry). */
  byPost: Map<string, EndpointPostEntryLike>
  /** The host registry, iterated to resolve a caller host member id by sessionId.
   * Re-iterable wire required (see the bundle's fresh-iterator view). */
  hosts: Iterable<HostEntryLike>
  /** Live signal: the head's session is present in the agents registry. */
  sessionLive(sessionId: string): boolean
  /** Optional refinement: the head's session is currently running (status). */
  sessionRunning?: (sessionId: string) => boolean
  /** Optional (U3): read the live host's journal wake_counter (number) for the
   * `host/status` payload. Absent dep → the payload omits wakeCounter (the
   * payload must stay minimal and stable). Contract: never throws (a read
   * failure is an omission, never an RPC error). */
  loadHostWakeCounter?: (hostId: string) => Promise<number | undefined>
  /** Optional (U3 fix): a minimal warn-capable logger for AMBIGUOUS live-host
   * selection in `host/status` (the pickLiveHostEntry fallback — multiple live
   * entries with no rotation successor). Absent dep → the warn is skipped and
   * the fallback pick is still deterministic (never throws). */
  logger?: { warn: (message: string) => void }
  /** A2 — read the current owner-presence state. Absent dep → `presence/get`
   * defaults to present:true (the owner is here until toggled). Never throws
   * (an unreadable state file defaults present:true). */
  presenceState?: () => Promise<PresenceState>
  /** A2 — persist a new owner-presence state (atomic write to
   * `presence.json`). Absent dep → `presence/set` returns the value but does
   * NOT persist (a graceful degrade, never an RPC error). */
  savePresenceState?: (state: PresenceState) => Promise<void>
  /** A3/A4 — fire-and-forget host notification fired when `presence/set`
   * CHANGES the state. Absent dep → the notification is dropped (the reliable
   * transition signal remains the A4 pre-step injector). */
  notifyPresenceChange?: (present: boolean) => void
  /** W1 — `agenda/list`: the repo root used to resolve the DEFAULT department
   * jobDir (matches the live applyInvoke `repoRoot`). Absent dep → module
   * `REPO_ROOT` (the repo root, resolved from this package's lib dir — the
   * same value as the bundle's). */
  repoRoot?: string
  /** W1 — `agenda/list`: the stateDir whose `calendar.json` supplies the
   * calendar entries. Absent dep → an EMPTY calendar (never an error). */
  calendarStateDir?: string
  /** W1 — `agenda/list`: a clock for the next-due job computation (ms epoch).
   * Absent dep → `Date.now` — the agenda shows the live next-due snapshot. */
  now?: () => number
  /** dshd-gui phase: the bundle-owned PURE roster-row builder (src/agents.ts
   * `buildAgentRows`, injected like the other live deps). Feeds the
   * `agents`/`list` branch; structurally typed here so the bundle's real
   * function binds without a cast. */
  buildAgentRows: (args: {
    departments: JobsDepartment[]
    posts: Map<string, EndpointPostEntryLike>
    sessionLive: (sessionId: string) => boolean
    sessionRunning?: (sessionId: string) => boolean
    unreadFor: (postId: string) => number
    sessionId?: string
  }) => EndpointAgentRow[]
  /** dshd-gui phase: the bundle-owned PURE deterministic live-host pick
   * (dshd-core registry `pickLiveHostEntry`, injected like the other live
   * deps). Feeds the `host/status` branch (U3 fix — the rotation-successor
   * selection). */
  pickLiveHostEntry: (entries: Iterable<HostEntryLike>) => { live?: HostEntryLike; ambiguous: boolean }
}

/** The `/deepartments host/status` RPC payload (U3, spec 002 §6.1): the CURRENT
 * registered host session — the live (non-retired) hosts.json entry — plus the
 * RETIRED entries. Client contract (src/client/index.tsx mirrors it): the
 * watcher opens ONLY transitions to a DIFFERENT non-null `hostSessionId`;
 * `retired` is informative (the native sidebar already hides archived rows). */
export interface HostStatusPayload {
  /** The current registered host session id, or null when no host is
   * registered (and no live entry — e.g. only retired entries remain). */
  hostSessionId: string | null
  /** The live entry's rotation-source session id; null when absent (legacy
   * in-place host, or no live entry). */
  previousSessionId: string | null
  /** Retired host entries (sessionId + when they were retired), in hosts.json
   * order (oldest rotation first). */
  retired: Array<{ sessionId: string; retiredAt: number }>
  /** The live host's journal wake_counter, when readable; OMITTED otherwise
   * (the payload stays minimal and stable). */
  wakeCounter?: number
}

/** The RpcResult-shaped value the client already understands
 * (serverResponseSchema.result: `{ok:true, value}` | `{ok:false, error}`). */
export type DeepartmentsDispatchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** Repo root, resolved from THIS package's compiled lib dir
 * (`packages/dshd-gui/lib/` → `../../..` = the repo). The SAME value as the
 * bundle's REPO_ROOT (`lib/invoke.js` → `..`), shared as the DEFAULT for the
 * agenda job reader so the `agenda/list` fallback resolves the default
 * department jobDir exactly like the live applyInvoke `repoRoot` (same
 * expression, same value). */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')

/** PURE builder of the `host/status` payload — derived from the in-memory host
 * registry only (no side effects; the only non-pure part is an optional
 * ambiguity `deps.logger.warn`). Empty hosts / no live entry →
 * `{ hostSessionId: null, previousSessionId: null, retired: [] }`. Live-host
 * selection is DETERMINISTIC via the injected `deps.pickLiveHostEntry`
 * (the bundle's dshd-core pick — U3 fix): prefer the rotation successor
 * (`previousSessionId`), then the single live entry, then the first live entry
 * with an ambiguity warn (post-mortem finding #2 — the old first-non-retired
 * pick returned a stale live entry after a rotation). */
async function buildHostStatusPayload(deps: DeepartmentsEndpointDeps): Promise<HostStatusPayload> {
  const { live, ambiguous } = deps.pickLiveHostEntry(deps.hosts)
  if (ambiguous && deps.logger !== undefined) {
    // Multiple live entries with no rotation successor — the pre-fix selection
    // silently chose the FIRST one (a stale live entry, e.g. a dead bare
    // `host-1a4af1ea`). Warn with the candidates so the Asistente can clean
    // the drifted live state; the payload still picks deterministically.
    const candidates = [...deps.hosts]
      .filter((entry) => entry.retired !== true)
      .map((entry) => `${entry.hostId} (sessionId=${entry.sessionId}${entry.previousSessionId === undefined ? '' : `, previousSessionId=${entry.previousSessionId}`})`)
    deps.logger.warn(
      `[deepartments] host/status: ${candidates.length} live host entries with no rotation successor — picked ${live?.hostId ?? 'none'} deterministically; candidates: ${candidates.join(', ')}`
    )
  }
  const retired: Array<{ sessionId: string; retiredAt: number }> = []
  for (const entry of deps.hosts) {
    if (entry.retired === true) {
      // The loader validator guarantees retiredAt on retired entries (spec 002
      // §3.5); the defensive skip keeps the payload shape strict.
      if (typeof entry.retiredAt === 'number') {
        retired.push({ sessionId: entry.sessionId, retiredAt: entry.retiredAt })
      }
    }
  }
  const hostSessionId = live === undefined ? null : live.sessionId
  const previousSessionId = live?.previousSessionId ?? null
  let wakeCounter: number | undefined
  if (live !== undefined && deps.loadHostWakeCounter !== undefined) {
    try {
      const counter = await deps.loadHostWakeCounter(live.hostId)
      if (typeof counter === 'number' && Number.isFinite(counter)) wakeCounter = counter
    } catch {
      // Never throw from the dispatcher; the field is simply omitted.
    }
  }
  return {
    hostSessionId,
    previousSessionId,
    retired,
    ...(wakeCounter === undefined ? {} : { wakeCounter })
  }
}

/**
 * PURE endpoint dispatcher for the `/deepartments` channel — the SAME endpoint
 * logic the legacy `ctx.connection.rpc.handle('/deepartments', ...)` served,
 * extracted into a testable function (no node:http imports). Handles
 * `agents`/`list` (department-head roster rows with per-host unread counts —
 * the client roster heartbeat; kept per U1, it is NOT part of the removed
 * sidebar) and `host/status` (U3 — the client lifecycle watcher's rotation
 * signal, spec 002 §6.1). Never throws for a normal call:
 * an unknown endpoint is a bad-request result, and internal failures are left
 * to the caller to fold (the route handler maps them to the `internal` branch).
 */
export async function dispatchDeepartmentsEndpoint(
  endpoint: string,
  payload: unknown,
  deps: DeepartmentsEndpointDeps
): Promise<DeepartmentsDispatchResult> {
  if (endpoint === 'host/status') {
    return { ok: true, value: await buildHostStatusPayload(deps) }
  }
  if (endpoint === 'presence/get') {
    // A2 — return the current owner-presence state. Absent/unreadable state →
    // default present:true (never an error); the dep must never throw.
    const state = deps.presenceState === undefined
      ? { present: true as const }
      : await deps.presenceState()
    return {
      ok: true,
      value: {
        present: state.present === true,
        ...(typeof state.updatedAt === 'number' ? { updatedAt: state.updatedAt } : {})
      }
    }
  }
  if (endpoint === 'presence/set') {
    // A2 — toggle the owner presence. The payload MUST be a boolean `present`
    // (any other shape is a bad-request, mirroring the strict client contract).
    const rawPresent = typeof payload === 'object' && payload !== null
      ? (payload as { present?: unknown }).present
      : undefined
    if (typeof rawPresent !== 'boolean') {
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: 'presence.set requires a boolean `present`',
          details: { issues: [] }
        }
      }
    }
    const present = rawPresent
    // Capture the PRIOR value BEFORE the save (the state object the dep writes
    // may be the same reference the reader returns — never compare after write).
    const prior = deps.presenceState === undefined
      ? { present: true as const }
      : await deps.presenceState()
    const priorPresent = prior.present === true
    const changed = priorPresent !== present
    const updatedAt = Date.now()
    if (deps.savePresenceState !== undefined) {
      await deps.savePresenceState({ present, updatedAt })
    }
    // A3/A4 — notify the HOST only when the state actually CHANGED (an
    // idempotent re-set to the same value must not re-wake/re-notify).
    if (changed && deps.notifyPresenceChange !== undefined) {
      deps.notifyPresenceChange(present)
    }
    return { ok: true, value: { present, updatedAt } }
  }
  if (endpoint === 'agenda/list') {
    // W1 — the client Agenda view (src/client/index.tsx calls `agenda/list`).
    // `jobs` = every configured department's JOB definitions (dept_job_list's
    // reader from dshd-jobs, reused: id/title/role/description/schedule + a
    // human `next` when the schedule is cron-style), `calendar` = the runtime
    // calendar.json entries. Never throws: an empty/missing jobDir or calendar
    // state degrades to an empty list, and the client already defaults to
    // empty arrays.
    const repoRoot = deps.repoRoot ?? REPO_ROOT
    const nowMs = deps.now === undefined ? Date.now() : deps.now()
    const jobs = await readAgendaJobs(repoRoot, deps.departments, nowMs)
    const rawCalendar = deps.calendarStateDir === undefined ? [] : readCalendarStateFile(deps.calendarStateDir).entries
    // Client contract (AgendaCalendarEntry reads `label`/`time`): map the
    // runtime `at` ISO to `time` and keep the full runtime shape as extras. The
    // client ignores the extras; the raw `at`/`id`/`fired` remain for tooling.
    const calendar = rawCalendar.map((entry) => ({ ...entry, time: entry.at }))
    return {
      ok: true,
      value: {
        jobs: jobs.map((job) => ({
          id: job.id,
          title: job.title,
          ...(job.schedule !== undefined ? { schedule: job.schedule } : {}),
          ...(job.next !== undefined ? { next: job.next } : {}),
          ...(job.role !== undefined ? { role: job.role } : {}),
          ...(job.description !== undefined ? { description: job.description } : {})
        })),
        calendar
      }
    }
  }
  if (endpoint !== 'agents' && endpoint !== 'list') {
    return {
      ok: false,
      error: {
        code: 'bad-request',
        message: 'unknown endpoint: ' + endpoint,
        details: { issues: [] }
      }
    }
  }
  // Resolve the caller host member id (host-<sessionId>) from its sessionId.
  // If the caller host is not (yet) registered in `hosts`, nothing to count
  // against. B3 cutover: the board-based unread derivation is KILLED (spec
  // 003 §7.1 — no read/seen marks in the messaging phase, §5 note: repoint to
  // messages.jsonl counts or kill); the row's `unread` is a stable 0 and the
  // `completed-notice` status branch simply never fires.
  let sessionId: string | undefined
  if (typeof payload === 'object' && payload !== null) {
    const rawSession = (payload as { sessionId?: unknown }).sessionId
    if (typeof rawSession === 'string') sessionId = rawSession
  }
  const unreadFor = (_postId: string): number => 0
  const rows = deps.buildAgentRows({
    departments: deps.departments,
    posts: deps.byPost,
    sessionLive: deps.sessionLive,
    sessionRunning: deps.sessionRunning,
    unreadFor,
    sessionId
  })
  return {
    ok: true,
    value: {
      host: { id: 'asistente', name: 'Asistente', department: "User's Office" },
      agents: rows
    }
  }
}

/** Whether a normalized URL hostname names the local loopback authority
 * (localhost, IPv6 `[::1]`, or any IPv4 address in 127/8). Pure — mirrors
 * dsh-client-connection isLoopbackHostname. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
export function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether the parsed request authority matches a `trustedHosts` entry (an
 * exact host:port, or a port-less host matching the hostname on any port).
 * Pure — mirrors dsh-client-connection isTrustedAuthority. */
export function isTrustedAuthority(hostUrl: URL, trustedHosts: string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
    const canonical = port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
    // An entry with no explicit port matches the hostname on ANY port; an entry
    // with an explicit port matches that exact host:port.
    return canonical === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** Plain request-header facts (no node:http / Headers dependency) the trust
 * fence reads; unit-testable directly. */
export interface HostTrustFacts {
  host?: unknown
  origin?: unknown
  secFetchSite?: unknown
}

/** Decide whether one request's headers may reach the channel: loopback hosts
 * always accepted; otherwise the Host:port must be a declared trusted host;
 * a `cross-site` fetch or a cross-origin page never passes. Pure — mirrors
 * dsh-client-connection isTrustedApiRequest without node/http types. */
export function isTrustedHostFact(facts: HostTrustFacts, trustedHosts: string[]): boolean {
  const host = typeof facts.host === 'string' ? facts.host : undefined
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (facts.secFetchSite === 'cross-site') return false
  if (facts.origin === undefined) return true
  try {
    return new URL(String(facts.origin)).host === hostUrl.host
  } catch {
    return false
  }
}

/** A validated `client-request` envelope (client-proxy schema). */
export interface ClientEnvelope {
  rpcId: string
  method: string
  payload: unknown
}

export type ParseClientEnvelopeResult =
  | { ok: true; message: ClientEnvelope }
  | { ok: false; issues: unknown[] }

/** Validate the client-request envelope `{type, rpcId, method, payload}`.
 * Pure — no deps, mirrors the reference clientRequestSchema constraints. */
export function parseClientEnvelope(body: unknown): ParseClientEnvelopeResult {
  if (typeof body !== 'object' || body === null) return { ok: false, issues: ['body is not an object'] }
  const raw = body as Record<string, unknown>
  const issues: unknown[] = []
  if (raw.type !== 'client-request') issues.push('type must be "client-request"')
  if (typeof raw.rpcId !== 'string') issues.push('rpcId must be a string')
  if (typeof raw.method !== 'string') issues.push('method must be a string')
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, message: { rpcId: raw.rpcId as string, method: raw.method as string, payload: raw.payload } }
}

// ---- thin node:http wiring (NOT pure; kept minimal — the logic lives above) --

/** Loose structural view of the node:http request the route handler receives. */
interface HttpRequestLike {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<Buffer>
}

/** Loose structural view of the node:http response the route handler owns. */
interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(chunk?: string): unknown
}

/** Carrier cap for channel bodies (tiny JSON; bound resident memory defensively). */
const MAX_REQUEST_BODY_BYTES = 160 * 1024 * 1024

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

async function readRequestBody(req: HttpRequestLike): Promise<string> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buf.byteLength
    if (received > MAX_REQUEST_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function respondJson(res: HttpResponseLike, rpcId: string, result: DeepartmentsDispatchResult): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/** Echo-token for an invalid envelope: the request's rpcId when readable, else
 * the dsh-reference sentinel `invalid-request`. */
function envelopeRpcId(body: unknown): string {
  const raw = body as { rpcId?: unknown } | null
  return typeof raw?.rpcId === 'string' ? raw.rpcId : 'invalid-request'
}

/** One exact `/deepartments/<endpoint>` POST route handler. Enforces the trust
 * fence (method + authority), decodes + validates the envelope, checks the
 * method↔endpoint match, then delegates to the PURE dispatch and answers the
 * standard `{type:'server-response', rpcId, result}` the client validates.
 * A dispatch THROW is folded into the `internal` error result — never crossed
 * the wire as a parse failure. Exported so the bundle's webServer mount effect
 * can wire it per-route (the mount + the trustedHosts/endpointDeps closures
 * stay in the bundle). */
export async function handleDeepartmentsRequest(
  req: unknown,
  res: unknown,
  endpoint: string,
  trustedHosts: string[],
  deps: DeepartmentsEndpointDeps
): Promise<void> {
  const httpReq = req as HttpRequestLike
  const httpRes = res as HttpResponseLike
  // Only the channel's POST endpoints are served; any other method on these
  // EXACT paths returns 405 so the SPA fallback never leaks index.html for the
  // channel (the old rc.8 behavior handed those GETs the SPA HTML).
  if (httpReq.method !== 'POST') {
    httpRes.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    httpRes.end('method not allowed')
    return
  }
  // Trust fence: loopback always accepted; otherwise the request Host:port must
  // be in the deployment's trusted hosts (mirrors isTrustedApiRequest loopback
  // behavior + the connection channel's trusted-host authority).
  if (!isTrustedHostFact({
    host: headerValue(httpReq.headers?.['host']),
    origin: headerValue(httpReq.headers?.['origin']),
    secFetchSite: headerValue(httpReq.headers?.['sec-fetch-site'])
  }, trustedHosts)) {
    httpRes.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    httpRes.end('forbidden')
    return
  }
  let body: unknown
  try {
    body = JSON.parse(await readRequestBody(httpReq))
  } catch {
    httpRes.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    httpRes.end('body is not JSON')
    return
  }
  const parsed = parseClientEnvelope(body)
  if (!parsed.ok) {
    respondJson(httpRes, envelopeRpcId(body), {
      ok: false,
      error: { code: 'bad-request', message: 'invalid client-request message', details: { issues: parsed.issues } }
    })
    return
  }
  const { rpcId, method } = parsed.message
  if (method !== endpoint) {
    respondJson(httpRes, rpcId, {
      ok: false,
      error: {
        code: 'bad-request',
        message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: { issues: [] }
      }
    })
    return
  }
  try {
    const result = await dispatchDeepartmentsEndpoint(endpoint, parsed.message.payload, deps)
    respondJson(httpRes, rpcId, result)
  } catch (error) {
    respondJson(httpRes, rpcId, {
      ok: false,
      error: { code: 'internal', message: String(error), details: {} }
    })
  }
}