// dshd-jobs — the deepartments AGENDA/JOBS ENGINE (the dshd-jobs phase of the
// modular Cordis split). A PURE LIBRARY package: it owns the pure agenda/jobs
// machinery — the cron scheduler (parseCronSchedule/cronMatches/nextCronFire/
// cronIsDue/CRON_DESYNC_WINDOW_MIN), the job-definition reader (unwrapQuotedScalar/
// parseJobDefFrontmatter/jobDirFor/readJobDefinitionFile/readAgendaJobs), the
// calendar + job-runs state store helpers (read/write `<stateDir>/calendar.json`
// and `<stateDir>/job-runs-state.json`) and the PURE scheduler tick
// (runAgendaSchedulerTick + AgendaSchedulerDeps). These were MOVED verbatim from
// the bundle (src/invoke.ts) so the engine is fs-pure and re-usable; the bundle
// consumes them through the drop-in bridge `src/core/jobs.ts`
// (`export * from 'dshd-jobs'`).
//
// The engine is a pure fs module (NO cordis dependencies — just `node:fs` +
// `node:fs/promises` + `node:path`), same shape as dshd-core's stores and
// dshd-feedback: the BUNDLE wires the tools + the daemon on top. dshd-jobs is a
// LIBRARY, NOT a Cordis plugin: it does not compose a service nor define a tool
// (that is a later split phase).
// [P1 — 2026-08-29]: that "later split phase" starts HERE: the package now ALSO
// exposes a thin Cordis plugin surface (name/inject/apply, bottom of this file)
// providing the `deepartments.jobs` service. The bundle's inline scheduler stays
// (R6) until the DECOUPLING hito rewires it to the composed service.
//
// SPLIT BOUNDARY (what MOVED vs what STAYED in the bundle — documented so a
// future reader knows the seam):
//   - MOVED: cron, job-def reader, calendar/job-runs store helpers, the pure
//     tick + its deps type.
//   - STAYED in src/invoke.ts (territory dshd-department / W6-health, NOT this
//     package): runJobForDepartment / spawnWorkerForDepartment / runningJobWorker
//     / validateJobRole (the worker-SPAWN framework, depends on agents/registry/
//     delivery), the agenda daemon effect (setInterval + the live runJob/
//     notifyHead/departmentForJob closures), the calendar/job-list/run TOOLS, and
//     the W6 HEALTH helpers (appendPostError/readHealthAlertsState/
//     writeHealthAlertsState/HEALTH_DEDUPE_WINDOW_MS/captureSchedulerAutoRunFailure).
//     The tick receives the health sink as the `onAutoRunSkip` CALLBACK — dshd-jobs
//     does NOT couple to the bundle's health system (jobs→health cleaned).
//
// NO export default (pitfall 0001 — breaks `inject`).
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

// ---------------------------------------------------------------------------
// The minimal department shape the engine reads. The bundle's real
// `DepartmentConfig` (src/org.ts) carries MORE fields (workspacePath, etc.), but
// the engine never reads beyond id/name/jobDir/coordinator — so a structural
// subset keeps the package a pure library with NO bundle dependency. The full
// bundle `DepartmentConfig` is assignable to this type (and this type to the
// subset runJobForDepartment needs), so the deps closures type-check without
// importing the bundle.
// ---------------------------------------------------------------------------

/** The minimal configured-department shape the jobs engine needs: `id` + `name`
 * (required, structurally matching the bundle's `DepartmentConfig`), plus the
 * optional `jobDir` (repo-relative or absolute) and `coordinator`. The engine
 * never reads beyond these — kept structurally compatible with the bundle's
 * richer `DepartmentConfig` so the deps closures bind without a bundle import. */
export interface JobsDepartment {
  id: string
  name: string
  jobDir?: string
  coordinator?: { postId: string; role: string }
}

// ---------------------------------------------------------------------------
// Cron (pure).
// ---------------------------------------------------------------------------

/** A parsed 5-field cron expression (`m h dom mon dow`), each a Set of the
 * matching minute/hour/day/month/weekday values. `undefined` from
 * `parseCronSchedule` means "NOT a cron schedule" (e.g. the deployment's HUMAN
 * job `schedule` text) — such a schedule is displayed but never auto-fires. */
export interface CronSchedule {
  minutes: Set<number>
  hours: Set<number>
  dom: Set<number>
  months: Set<number>
  dow: Set<number>
}

/** Build the full value set `[min..max]` for a cron field. */
export function cronAll(min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (let v = min; v <= max; v++) out.add(v)
  return out
}

/** Parse ONE cron field (min..max) into a value set, or undefined on a
 * non-cron token. Supported: an asterisk, an asterisk-slash-step, plain
 * numbers, comma lists and `n-m` ranges. Anything else → undefined (the
 * expression is NOT cron). */
export function cronFieldParse(expr: string, min: number, max: number): Set<number> | undefined {
  const out = new Set<number>()
  for (const partRaw of expr.split(',')) {
    const part = partRaw.trim()
    if (part === '*') {
      for (let v = min; v <= max; v++) out.add(v)
      continue
    }
    const step = /^\*\/(\d+)$/.exec(part)
    if (step !== null) {
      const n = Number(step[1])
      if (!Number.isFinite(n) || n <= 0) return undefined
      for (let v = min; v <= max; v += n) out.add(v)
      continue
    }
    const range = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (range !== null) {
      const start = Number(range[1])
      const end = range[2] !== undefined ? Number(range[2]) : start
      if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
      for (let v = start; v <= end; v++) out.add(v)
      continue
    }
    return undefined
  }
  for (const v of out) {
    if (v < min || v > max) return undefined
  }
  return out
}

/** Parse a 5-field cron string, or undefined when it is not a valid cron
 * schedule. Includes the common `@` aliases (`@daily`/`@hourly`/`@weekly`/
 * `@monthly`/`@yearly`); a NON-5-field (HUMAN) schedule returns undefined. */
export function parseCronSchedule(schedule: string): CronSchedule | undefined {
  const s = String(schedule ?? '').trim()
  if (s === '') return undefined
  const allMin = cronAll(0, 59)
  const allHour = cronAll(0, 23)
  const allDom = cronAll(1, 31)
  const allMon = cronAll(1, 12)
  const allDow = cronAll(0, 7)
  const aliases: Record<string, CronSchedule> = {
    '@minutely': { minutes: allMin, hours: allHour, dom: allDom, months: allMon, dow: allDow },
    '@hourly': { minutes: new Set([0]), hours: allHour, dom: allDom, months: allMon, dow: allDow },
    '@daily': { minutes: new Set([0]), hours: new Set([0]), dom: allDom, months: allMon, dow: allDow },
    '@weekly': { minutes: new Set([0]), hours: new Set([0]), dom: allDom, months: allMon, dow: new Set([0]) },
    '@monthly': { minutes: new Set([0]), hours: new Set([0]), dom: new Set([1]), months: allMon, dow: allDow },
    '@yearly': { minutes: new Set([0]), hours: new Set([0]), dom: new Set([1]), months: new Set([1]), dow: allDow },
    '@annually': { minutes: new Set([0]), hours: new Set([0]), dom: new Set([1]), months: new Set([1]), dow: allDow }
  }
  const alias = aliases[s]
  if (alias !== undefined) return alias
  const parts = s.split(/\s+/)
  if (parts.length !== 5) return undefined
  const minutes = cronFieldParse(parts[0], 0, 59)
  const hours = cronFieldParse(parts[1], 0, 23)
  const dom = cronFieldParse(parts[2], 1, 31)
  const months = cronFieldParse(parts[3], 1, 12)
  const dow = cronFieldParse(parts[4], 0, 7)
  if (minutes === undefined || hours === undefined || dom === undefined || months === undefined || dow === undefined) return undefined
  return { minutes, hours, dom, months, dow }
}

/** Whether `at` falls on a minute the cron matches (minute resolution). */
export function cronMatches(cron: CronSchedule, at: Date): boolean {
  return (
    cron.minutes.has(at.getMinutes()) &&
    cron.hours.has(at.getHours()) &&
    cron.dom.has(at.getDate()) &&
    cron.months.has(at.getMonth() + 1) &&
    cron.dow.has(at.getDay())
  )
}

const CRON_HORIZON_MS = 366 * 24 * 60 * 60 * 1000 // 1 year: the next-fire search horizon

/** The NEXT fire of `cron` STRICTLY AFTER `from`, or undefined when none falls
 * within the 1-year horizon. Minute-resolution forward scan (cheap — a cron
 * that rarely matches still only scans to its first match). */
export function nextCronFire(cron: CronSchedule, from: Date): Date | undefined {
  const candidate = new Date(from.getTime())
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)
  const horizon = from.getTime() + CRON_HORIZON_MS
  while (candidate.getTime() <= horizon) {
    if (cronMatches(cron, candidate)) return new Date(candidate.getTime())
    candidate.setMinutes(candidate.getMinutes() + 1)
  }
  return undefined
}

/** Cron desync window for the scheduler: a fire whose aligned minute is within
 * the last N minutes of `now` (a small wake/skew tolerance) is treated as due. */
export const CRON_DESYNC_WINDOW_MIN = 2

/** Whether the cron job should FIRE at `now`, given the persisted
 * `lastFiredAt` (ms epoch, optional). Idempotent: a fire ALIGNED minute that is
 * still within the desync window is due ONLY if it is STRICTLY after the last
 * fired minute (so a per-minute cron fires once a minute, never re-fires inside
 * the same window). Never throws. */
export function cronIsDue(cron: CronSchedule, now: Date, lastFiredAt?: number): boolean {
  const lastMinute = lastFiredAt === undefined ? -1 : Math.floor(lastFiredAt / 60000)
  for (let back = 0; back <= CRON_DESYNC_WINDOW_MIN; back++) {
    const candidate = new Date(now.getTime() - back * 60000)
    if (!cronMatches(cron, candidate)) continue
    if (Math.floor(candidate.getTime() / 60000) > lastMinute) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Job definition reading (shared by dept_job_list/dept_job_run + agenda + the
// scheduler).
// ---------------------------------------------------------------------------

/** Unwrap a QUOTED-YAML scalar (the F4a jobs convention quotes free-text values
 * like `schedule`: `"daily 09:00 (reserved — …)"`). */
export function unwrapQuotedScalar(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/** A parsed job definition frontmatter + its non-empty task body. */
export interface JobDefParsed {
  meta: Record<string, string>
  body: string
}

/** Parse a JOB definition frontmatter (spec 004 §5.4-§5.5): the `---`-delimited
 * `key: value` one-line scalars for id/title/role/description/schedule?/owner/
 * outbox? PLUS a NON-EMPTY task body. Same lean YAML-lite shape as the role
 * parser, with the quoted-scalar unwrapping + REQUIRED-key validation
 * (id/title/role/description/owner). Returns undefined when the file has no
 * well-formed frontmatter block or omits a required key. PURE + exported so the
 * agenda/dispatch reader and the scheduler reuse the SAME reader as
 * dept_job_list/dept_job_run. */
export function parseJobDefFrontmatter(text: string): JobDefParsed | undefined {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) return undefined
  const meta: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const scalar = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i])
    if (scalar !== null) meta[scalar[1]] = unwrapQuotedScalar(scalar[2].trim())
  }
  const body = lines.slice(end + 1).join('\n').trim()
  if (body === '') return undefined
  for (const key of ['id', 'title', 'role', 'description', 'owner']) {
    if (typeof meta[key] !== 'string' || meta[key].trim() === '') return undefined
  }
  return { meta, body }
}

/** Resolve the department jobDir (spec 004 §3.1/§3.3): the config
 * `org.departments[].jobDir` (repo-relative OR absolute), defaulting to
 * `<repoRoot>/docs/departments/<dept-id>/jobs` when absent/empty. */
export function jobDirFor(repoRoot: string, department: { id: string; jobDir?: string }): string {
  const configured = (department.jobDir ?? '').trim()
  if (configured === '') return path.join(repoRoot, 'docs', 'departments', department.id, 'jobs')
  return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured)
}

/** Read + resolve ONE job definition (spec 004 §5.4): locate `<jobId>.md` in the
 * department jobDir, parse the frontmatter, validate the declared `id` matches
 * the requested jobId. LOUD errors — a versioned definition with broken
 * syntax/keys must fail the run, never spawn a task-less worker. Reused by
 * dept_job_run AND the scheduler (identical messages). */
export async function readJobDefinitionFile(
  repoRoot: string,
  department: { id: string; jobDir?: string },
  jobId: string
): Promise<{ meta: Record<string, string>; body: string; path: string }> {
  const jobDir = jobDirFor(repoRoot, department)
  const filePath = path.join(jobDir, `${jobId}.md`)
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    throw new Error(`[deepartments] dept_job_run: job not found: ${jobId} (searched ${jobDir})`)
  }
  const parsed = parseJobDefFrontmatter(text)
  if (parsed === void 0) {
    throw new Error(`[deepartments] dept_job_run: job "${jobId}" (${filePath}) has no valid frontmatter — expected a '---' block (id/title/role/description/owner required; schedule/outbox optional) plus a non-empty task body`)
  }
  if (parsed.meta.id !== jobId) {
    throw new Error(`[deepartments] dept_job_run: job "${jobId}" (${filePath}) declares frontmatter id "${parsed.meta.id}" — the file name must match the job id it is referenced by`)
  }
  return { meta: parsed.meta, body: parsed.body, path: filePath }
}

/** One agenda job item: the dept_job_list frontmatter fields, a human `next`
 * (the ISO next-cron-fire, when the `schedule` is cron-style), and the internal
 * `cron` (a parsed CronSchedule, omitted when the schedule is NOT cron — e.g.
 * the deployment's HUMAN schedule text, which never auto-fires). The client
 * (AgendaJob) reads id/title/schedule/next; role/description are extras. */
export interface AgendaJobItem {
  id: string
  title: string
  role?: string
  description?: string
  schedule?: string
  next?: string
  cron?: CronSchedule
}

/** Read ALL departments' job definitions into agenda items (pure-ish fs read;
 * `nowMs` supplies the clock for the `next` computation so the dispatch tests
 * are deterministic). A missing jobDir is an empty list; an INVALID definition
 * is SKIPPED (the agenda is a read-only listing — per-entry errors belong to
 * dept_job_list, which keeps its own per-entry reporting). */
export async function readAgendaJobs(repoRoot: string, departments: JobsDepartment[], nowMs: number): Promise<AgendaJobItem[]> {
  const now = new Date(nowMs)
  const items: AgendaJobItem[] = []
  for (const department of departments) {
    const jobDir = jobDirFor(repoRoot, department)
    let files: string[]
    try {
      files = (await readdir(jobDir)).filter((name) => name.endsWith('.md')).sort()
    } catch {
      continue
    }
    for (const name of files) {
      let parsed: JobDefParsed | undefined
      try {
        parsed = parseJobDefFrontmatter(await readFile(path.join(jobDir, name), 'utf8'))
      } catch {
        parsed = void 0
      }
      if (parsed === void 0) continue
      const schedule = parsed.meta.schedule !== undefined ? parsed.meta.schedule : undefined
      const cron = schedule !== undefined ? parseCronSchedule(schedule) : undefined
      const next = cron === undefined ? undefined : (() => {
        const fire = nextCronFire(cron, now)
        return fire === undefined ? undefined : fire.toISOString()
      })()
      items.push({
        id: parsed.meta.id,
        title: parsed.meta.title,
        ...(parsed.meta.role !== undefined ? { role: parsed.meta.role } : {}),
        ...(parsed.meta.description !== undefined ? { description: parsed.meta.description } : {}),
        ...(schedule !== undefined ? { schedule } : {}),
        ...(next !== undefined ? { next } : {}),
        ...(cron !== undefined ? { cron } : {})
      })
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// Calendar + job-runs state store helpers (pure fs — `<stateDir>/calendar.json`
// and `<stateDir>/job-runs-state.json`, both overwrite-complete).
// ---------------------------------------------------------------------------

/** One runtime calendar entry (spec §Agenda — `<stateDir>/calendar.json`).
 * `at` is an ISO datetime; `fired` is the scheduler's ONE-SHOT marker (an
 * ad-hoc entry fires once — no recurrence; a job's recurrence lives in its own
 * `schedule`). All optional fields are omitted, never `undefined` (the caller
 * and the client output stay JSON-lossless). */
export interface CalendarEntry {
  id: string
  label: string
  at: string
  jobId?: string
  createdBy?: string
  createdAt?: number
  fired?: boolean
  /** B2 (spec W5): the CONFIG department id of the caller that added the entry
   * (stamped at `dept_calendar_add` from the caller's department). Optional so
   * a legacy/malformed entry loads untouched; set for every entry added by a
   * configured department post. Lets `dept_calendar_list` filter by department
   * while the DEFAULT (no filter) still returns the FULL shared (global)
   * agenda — the agenda stays unified across departments. */
  departmentId?: string
}

export interface CalendarState {
  entries: CalendarEntry[]
}

/** Structural guard for a calendar entry (a malformed/partial record is dropped
 * rather than leaking an unrenderable shape). */
function isCalendarEntry(value: unknown): value is CalendarEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && typeof entry.label === 'string' && typeof entry.at === 'string'
}

/** Read `<stateDir>/calendar.json`. Absent, unreadable or malformed →
 * `{ entries: [] }` (never throws — PURE, mirrors readPresenceStateFile).
 * Exported so the dispatch/scheduler tests exercise the same reader as the
 * live wiring. */
export function readCalendarStateFile(stateDir: string): CalendarState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, 'calendar.json'), 'utf8')) as { entries?: unknown }
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      return { entries: parsed.entries.filter(isCalendarEntry) }
    }
    return { entries: [] }
  } catch {
    return { entries: [] }
  }
}

/** Write `<stateDir>/calendar.json` (mkdir -p the dir, then write the state).
 * Returns nothing; throws on an fs failure — the writing tool folds that into a
 * warn so an RPC/tick never fails on a persist error, while a test can assert
 * the write directly. */
export async function writeCalendarStateFile(stateDir: string, state: CalendarState): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, 'calendar.json')), { recursive: true })
  await writeFile(path.join(stateDir, 'calendar.json'), JSON.stringify(state), 'utf8')
}

/** Read `<stateDir>/job-runs-state.json` — the idempotency ledger
 * `{ jobId: lastFiredAtMs }`. Absent/unreadable/malformed → `{}` (never throws).
 * Value = the ms epoch of the last scheduler fire for that job (minute
 * resolution; the scheduler relies on the minute floor so a per-minute job
 * fires exactly once a minute and never re-fires inside the same window). */
export function readJobRunsStateFile(stateDir: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDir, 'job-runs-state.json'), 'utf8')) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [jobId, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[jobId] = value
    }
    return out
  } catch {
    return {}
  }
}

/** Write `<stateDir>/job-runs-state.json` (mkdir -p the dir, then the ledger). */
export async function writeJobRunsStateFile(stateDir: string, state: Record<string, number>): Promise<void> {
  await mkdir(path.dirname(path.join(stateDir, 'job-runs-state.json')), { recursive: true })
  await writeFile(path.join(stateDir, 'job-runs-state.json'), JSON.stringify(state), 'utf8')
}

// ---------------------------------------------------------------------------
// W8-c scheduler auto-run visibility + the PURE scheduler tick.
//
// NOTE (split boundary): `captureSchedulerAutoRunFailure` + the W6-health
// helpers (appendPostError/readHealthAlertsState/writeHealthAlertsState/
// HEALTH_DEDUPE_WINDOW_MS) STAY in the bundle (invoke.ts) — they couple the
// scheduler to the health system, and dshd-jobs must NOT. The tick receives
// the health sink via the `onAutoRunSkip` dep, so a pure tick test stays
// hermetic and the production wiring binds captureSchedulerAutoRunFailure.
// ---------------------------------------------------------------------------

/** A scheduler auto-run no-fire finding surfaced by the pure tick (W8-c
 * scheduler-visibility): the fire resolved a head but runJob THREW, OR it
 * SKIPPED because the head post was unresolved, OR it returned FALSE (an
 * idempotency skip). */
export interface SchedulerAutoRunFinding {
  /** The job id that did not fire. */
  jobId: string
  /** The no-fire reason: 'no head' | 'idempotency-skip' | the thrown error text. */
  reason: string
  /** The thrown error text (when reason is a thrown error). */
  error?: string
}

/** Normalize a scheduler no-fire reason into the dedupe-key reason: a
 * 'job already running' idempotency trip maps to 'idempotency-skip'; every
 * other reason is used verbatim. */
export function normalizeSchedulerAutoRunReason(reason: string): string {
  return /job already running/.test(reason) ? 'idempotency-skip' : reason
}

/** The scheduler dedupe key (W8-c scheduler-visibility): one key per
 * (jobId, reason) so a given no-fire is recorded ≤1 per HEALTH_DEDUPE_WINDOW_MS. */
export function schedulerAutoRunKey(jobId: string, reason: string): string {
  return `scheduler:${jobId}:${normalizeSchedulerAutoRunReason(reason)}`
}

// ---------------------------------------------------------------------------
// W1 scheduler tick (PURE — an injectable clock + injected hooks).
// ---------------------------------------------------------------------------

/** Injected hooks + inputs the scheduler tick reads. The PRODUCTION wiring
 * (applyInvoke) binds the live registries (departments, post registry, the
 * job-run engine, the bus delivery seam); tests construct this directly with a
 * FIXED clock + stub runJob/notifyHead. Abstracted exactly like the endpoint
 * dispatcher deps so the tick is unit-testable without a booted plugin. */
export interface AgendaSchedulerDeps {
  /** The clock (ms epoch) — injectable so a tick test is deterministic. */
  now(): number
  /** Every configured department the scheduler fires for. */
  departments: JobsDepartment[]
  /** The repo root for the default department jobDir resolution. */
  repoRoot: string
  /** The stateDir whose `calendar.json` the tick reads/marks fired. */
  calendarStateDir: string
  /** The stateDir whose `job-runs-state.json` persists the last-fired ledger. */
  jobRunsStateDir: string
  /** Resolve the head MEMBER id (postId) a department fires under, or undefined
   * when the department has no registered head ("sin head" → skip + warn). */
  headForDepartment(department: JobsDepartment): string | undefined
  /** Run ONE department job. Resolves `true` when it FIRED (spawned the worker);
   * `false` when it was SKIPPED (already running / no head / any non-fatal
   * error) — the tick never throws from here. */
  runJob(department: JobsDepartment, headPostId: string, jobId: string): Promise<boolean>
  /** Deliver a simple agenda NOTICE to a head (never throws). */
  notifyHead(headPostId: string, message: string): Promise<void>
  /** Which department OWNS a calendar entry (its `createdBy` post). */
  departmentForEntry(entry: CalendarEntry): JobsDepartment | undefined
  /** Which department owns a jobId (scans the jobDirs). */
  departmentForJob(jobId: string): JobsDepartment | undefined
  /** Optional warn-capable logger (absent dep → the warn is dropped). */
  logger?: { warn(message: string): void }
  /** W8-c scheduler-visibility: optional AUTO-RUN no-fire sink. The tick calls
   * it for every job auto-run that did NOT fire — (a) the fire resolved a head
   * but runJob THREW, (b) the fire SKIPPED because the head post was unresolved
   * (no head), (c) the fire returned FALSE (idempotency skip). Absent dep → the
   * finding is dropped (the existing tests keep the tick hermetic). May be
   * async (the tick awaits it, so a capture is never lost to a fire-and-forget). */
  onAutoRunSkip?: (finding: SchedulerAutoRunFinding) => void | Promise<void>
}

/** ONE scheduler tick (spec §5.7 — W1): (a) fire any cron-scheduled job whose
 * next run is DUE within the desync window and not already fired (idempotent by
 * the persisted job-runs-state ledger), attempting the SAME dept_job_run engine
 * and skipping+warn on "already running" / no-head; (b) fire any CALENDAR entry
 * whose `at ≤ now` and `fired:false` — a `jobId` entry runs the job, a plain
 * entry notifies the owning head with the label; (c) NEVER throws (every
 * internal failure is a warn). The deps keep it pure: a fixed clock + stubbed
 * hooks make a tick test deterministic. */
export async function runAgendaSchedulerTick(deps: AgendaSchedulerDeps): Promise<void> {
  try {
    const nowMs = deps.now()
    const now = new Date(nowMs)
    // (a) cron-scheduled jobs, per department.
    const runs = readJobRunsStateFile(deps.jobRunsStateDir)
    let runsChanged = false
    for (const department of deps.departments) {
      const headPostId = deps.headForDepartment(department)
      const jobs = await readAgendaJobs(deps.repoRoot, [department], nowMs)
      for (const job of jobs) {
        if (job.cron === undefined) continue
        if (!cronIsDue(job.cron, now, runs[job.id])) continue
        if (headPostId === undefined) {
          deps.logger?.warn(`[deepartments] scheduler: job "${job.id}" (department ${department.id}) is due but the department has NO head — skip`)
          await deps.onAutoRunSkip?.({ jobId: job.id, reason: 'no head' })
          continue
        }
        try {
          const fired = await deps.runJob(department, headPostId, job.id)
          if (fired) {
            runs[job.id] = nowMs
            runsChanged = true
          } else {
            await deps.onAutoRunSkip?.({ jobId: job.id, reason: 'idempotency-skip' })
          }
        } catch (error: unknown) {
          const errorText = error instanceof Error ? error.message : String(error)
          deps.logger?.warn(`[deepartments] scheduler: job "${job.id}" run failed: ${errorText}`)
          await deps.onAutoRunSkip?.({ jobId: job.id, reason: errorText, error: errorText })
        }
      }
    }
    if (runsChanged) await writeJobRunsStateFile(deps.jobRunsStateDir, runs)
    // (b) calendar entries due (at ≤ now, not fired).
    const cal = readCalendarStateFile(deps.calendarStateDir)
    let calChanged = false
    for (const entry of cal.entries) {
      if (entry.fired === true) continue
      const at = Date.parse(entry.at)
      if (Number.isNaN(at) || at > nowMs) continue
      if (entry.jobId !== undefined && entry.jobId !== '') {
        const department = deps.departmentForJob(entry.jobId) ?? deps.departmentForEntry(entry)
        const headPostId = department === void 0 ? undefined : deps.headForDepartment(department)
        if (headPostId === void 0) {
          deps.logger?.warn(`[deepartments] scheduler: calendar "${entry.id}" (job ${entry.jobId}) is due but no head is available — skip`)
          await deps.onAutoRunSkip?.({ jobId: entry.jobId, reason: 'no head' })
        } else {
          try {
            const fired = await deps.runJob(department as JobsDepartment, headPostId, entry.jobId)
            if (!fired) await deps.onAutoRunSkip?.({ jobId: entry.jobId, reason: 'idempotency-skip' })
          } catch (error: unknown) {
            const errorText = error instanceof Error ? error.message : String(error)
            deps.logger?.warn(`[deepartments] scheduler: calendar job "${entry.jobId}" run failed: ${errorText}`)
            await deps.onAutoRunSkip?.({ jobId: entry.jobId, reason: errorText, error: errorText })
          }
        }
      } else {
        const department = deps.departmentForEntry(entry)
        const ownHead = department === void 0 ? undefined : deps.headForDepartment(department)
        const target = ownHead ?? (deps.departments[0] !== void 0 ? deps.headForDepartment(deps.departments[0]) : undefined)
        if (target === void 0) {
          deps.logger?.warn(`[deepartments] scheduler: calendar "${entry.id}" is due but no head is available for the notice — skip`)
        } else {
          await deps.notifyHead(target, entry.label)
        }
      }
      entry.fired = true
      calChanged = true
    }
    if (calChanged) await writeCalendarStateFile(deps.calendarStateDir, cal)
  } catch (error: unknown) {
    deps.logger?.warn(`[deepartments] scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// P1 (MODULARIZACIÓN, 2026-08-29) — the dshd-jobs Cordis PLUGIN surface.
// Thin name/inject/apply (the dshd-core/dshd-webfetch pattern): the package
// now ALSO composes as a real plugin row (cordis.patch.yml) and provides
// `deepartments.jobs` — the scheduler tick the bundle wires INLINE today
// (invoke.ts `runAgendaSchedulerTick` inside the agenda daemon). The tick is
// LAZY (runs on FIRST service use, never at apply time — an apply is
// side-effect free); deps are INJECTED via the FASE 2.6 seam, never imported
// from the bundle:
//   - departments / stateDir ← `ctx.get('deepartments.org')` (the SHARED
//     source; `headForDepartment` derives the configured coordinator postId),
//   - `repoRoot` ← the `jobs.repoRoot` bucket, then the EXISTING
//     `binder.wakepack.repoRoot` bucket (registered by the composed bundle),
//   - the closure-bound hooks (runJob / notifyHead / departmentForEntry /
//     departmentForJob / onAutoRunSkip) ← the `jobs` binder bucket (the
//     DECOUPLING bundle registers its live closures there).
// A required closure missing at USE FAILS LOUD (R1), never a silently-unbound
// tick. The cron/calendar machinery exports (the drop-in bridge superset) stay
// intact. Nothing is removed (R6).
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'

/** The FASE 2.6 binder bucket for the jobs service (STRUCTURAL — read from
 * `ctx.get('deepartments.binder')` widened; filled by the DECOUPLING bundle). */
export interface JobsBinderDeps {
  /** The shared dept_job_run engine: fires ONE department job under the head
   * (idempotent; false = skipped). REQUIRED at use. */
  runJob?: AgendaSchedulerDeps['runJob']
  /** Deliver a simple agenda NOTICE to a head (never throws). REQUIRED at use. */
  notifyHead?: AgendaSchedulerDeps['notifyHead']
  /** Which department OWNS a calendar entry (its `createdBy` post). REQUIRED at
   * use (the tick contract). */
  departmentForEntry?: AgendaSchedulerDeps['departmentForEntry']
  /** Which department owns a jobId (scans the jobDirs). REQUIRED at use (the
   * tick contract). */
  departmentForJob?: AgendaSchedulerDeps['departmentForJob']
  /** W8-c scheduler-visibility: the auto-run no-fire sink (optional — the tick
   * drops the finding when absent). */
  onAutoRunSkip?: AgendaSchedulerDeps['onAutoRunSkip']
  /** LANE 0.2.3b (W8-c re-plumb): the runJobForDepartment-EXCEPTION capture
   * sink — the post-error row the register-era schedulerRunJob produced. The
   * service-first runJob adapter (deepartments.spawn) calls it after a spawn
   * exception (reason normalized like schedulerRunJob: an 'already running'
   * trip → 'idempotency-skip'); the bundle registers the
   * captureSchedulerAutoRunFailure-backed sink into this holder. Absent sink
   * (minimal composition) → the adapter stays warn-only (R6). */
  captureAutoRunFailure?: (finding: SchedulerAutoRunFinding) => void | Promise<void>
  /** The bundle's repoRoot (registers the same value the `wakepack` bucket
   * carries; absent → the wakepack bucket). */
  repoRoot?: string
}

/** The `deepartments.jobs` service surface — the scheduler tick the bundle
 * wires inline today. */
export interface JobsSurface {
  /** ONE scheduler tick bound to the shared org config + the binder-injected
   * closures: (a) fires due cron jobs, (b) fires due calendar entries. NEVER
   * throws (every internal failure is a warn — the tick contract); a MISSING
   * INJECTED DEP at use FAILS LOUD (R1). */
  runSchedulerTick(opts?: { now?: () => number }): Promise<void>
}

/** The dshd-jobs plugin config (minimal — departments/stateDir/repoRoot
 * resolve from the shared sources; nothing is mirrored here). */
export interface JobsConfig {
  /** Optional default department list (absent → `deepartments.org.departments`). */
  departments?: JobsDepartment[]
}

export const name = 'dshd-jobs'
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

export function apply(ctx: Context, config: JobsConfig = {}) {
  // LANE 0.2.1 (1B): the scheduler deps arrive via the PER-PACKAGE deps holder
  // (`deepartments.jobsDeps` — provided HERE; the DECOUPLING bundle WRITES it
  // via register — the bundle still fills, the package only exposes the holder,
  // P1 intact). The jobs bind RELOCATES (gap 2 keeps it; the spawn Service is
  // the next lane), so the fail-loud R1 contract is unchanged — a cleared/
  // unfilled holder fails loud at use, never stale scheduler closure execution.
  const depsHolder = createDepsHolder<JobsBinderDeps>()
  ctx.provide('deepartments.jobsDeps', depsHolder)
  // Derived service: the tick itself is the surface; deps resolve per run.
  ctx.provide('deepartments.jobs', {
    runSchedulerTick: async (opts: { now?: () => number } = {}): Promise<void> => {
      const org = ctx.get('deepartments.org') as { stateDir?: string; org?: { departments?: JobsDepartment[] } } | undefined
      if (org?.stateDir === undefined) {
        throw new Error('[deepartments] jobs scheduler tick: ctx.get("deepartments.org") is undefined — dshd-core is not composed (register the core plugin + provide deepartments.org)')
      }
      const bound = depsHolder.get()
      // jobs→spawn-Service (LANE 0.2.3 — gap 3 TOTAL MODULARITY): the tick's
      // runJob resolves SERVICE-FIRST — `ctx.get('deepartments.spawn')?.runJobForDepartment`
      // (the dshd-orchestration spawn SERVICE — the SAME engine the bundle's
      // schedulerRunJob wrapped) with the DECOUPLING holder's runJob as the R6
      // fallback for compositions where the spawn service is absent (the
      // bundle stopped registering runJob into the holder; the frozen binder
      // register still carries it for the legacy path). The head ENTRY is
      // resolved via the SHARED catalog service (deepartments.catalog — the
      // SAME byPost map schedulerRunJob read). The scheduler CONTRACT is
      // unchanged: runJob resolves true when the job FIRED, false when skipped
      // (missing head / already-running / any non-fatal error — the tick never
      // throws from here).
      const spawnService = ctx.get('deepartments.spawn') as
        | { runJobForDepartment?: (department: JobsDepartment, headEntry: { postId: string; roomId: string; sessionId?: string }, jobId: string, opts?: { callerSessionId?: string; signal?: AbortSignal }) => Promise<unknown> }
        | undefined
      const catalog = ctx.get('deepartments.catalog') as
        | { byPost?: Map<string, { postId: string; roomId: string; sessionId?: string }> }
        | undefined
      const runJobFromService: AgendaSchedulerDeps['runJob'] | undefined =
        spawnService?.runJobForDepartment !== undefined && catalog?.byPost !== undefined
          ? async (department, headPostId, jobId) => {
              const headEntry = catalog!.byPost!.get(headPostId)
              if (headEntry === undefined) {
                // The same no-head record the bundle's schedulerRunJob wrote
                // (W8-c — the health sink via onAutoRunSkip, reason 'no head').
                await bound.onAutoRunSkip?.({ jobId, reason: 'no head', error: 'no head' })
                ctx.logger.warn(`[deepartments] scheduler: job "${jobId}" (department ${department.id}) head "${headPostId}" not in the catalog — skip`)
                return false
              }
              try {
                await spawnService!.runJobForDepartment!(department, headEntry, jobId, { callerSessionId: headEntry.sessionId })
                return true
              } catch (error: unknown) {
                const errorText = error instanceof Error ? error.message : String(error)
                // LANE 0.2.3b (W8-c re-plumb): the runJobForDepartment-EXCEPTION
                // post-error row — the register-era schedulerRunJob produced it
                // (reason normalized: an 'already running' trip →
                // 'idempotency-skip'); the bundle registers the sink into the
                // holder (captureSchedulerAutoRunFailure — post-errors.jsonl,
                // postId 'scheduler', dedupe-keyed). Absent sink → warn-only
                // (R6, minimal composition).
                await bound.captureAutoRunFailure?.({ jobId, reason: normalizeSchedulerAutoRunReason(errorText), error: errorText })
                ctx.logger.warn(`[deepartments] scheduler: job "${jobId}" could not run (${errorText}) — skip`)
                return false
              }
            }
          : undefined
      const runJob: AgendaSchedulerDeps['runJob'] | undefined = runJobFromService ?? bound.runJob
      // notifyHead/departmentForEntry/departmentForJob stay holder-required (the
      // spawn service does not expose them); runJob is required ONLY when the
      // spawn service cannot provide it (fail loud R1 with both sources named).
      const required: Array<keyof JobsBinderDeps> = ['notifyHead', 'departmentForEntry', 'departmentForJob']
      const missing = required.filter((key) => bound[key] === undefined)
      if (missing.length > 0 || runJob === undefined) {
        const runJobNote = runJob === undefined
          ? ' (runJob: the deepartments.spawn service is absent AND the holder has no runJob — compose dshd-orchestration for the spawn service or register runJob in the holder)'
          : ''
        throw new Error(`[deepartments] jobs scheduler tick: required deps-holder dep(s) missing: ${missing.join(', ')}${runJobNote} — the DECOUPLING bundle must call ctx.get('deepartments.jobsDeps').register({ runJob, notifyHead, ... })`)
      }
      // The repoRoot fallback keeps reading the composed `wakepack` Binder
      // bucket (the FASE 2.6-C seam, still filled by the frozen register) —
      // R6 until the register is dismantled in gap 2.
      const binderWakepackRepoRoot = ((ctx.get('deepartments.binder') as { get(): unknown } | undefined)?.get() as { wakepack?: { repoRoot?: string } } | undefined)?.wakepack?.repoRoot
      const repoRoot = bound.repoRoot ?? binderWakepackRepoRoot
      if (repoRoot === undefined) {
        throw new Error('[deepartments] jobs scheduler tick: no repoRoot — the bundle must register ctx.get("deepartments.jobsDeps").register({ repoRoot }) (LANE 0.2.1, composed today) or the wakepack bucket (FASE 2.6-C)')
      }
      await runAgendaSchedulerTick({
        now: opts.now ?? (() => Date.now()),
        departments: config.departments ?? org.org?.departments ?? [],
        repoRoot,
        calendarStateDir: org.stateDir,
        jobRunsStateDir: org.stateDir,
        headForDepartment: (department) => department.coordinator?.postId,
        runJob: runJob!,
        notifyHead: bound.notifyHead!,
        departmentForEntry: bound.departmentForEntry!,
        departmentForJob: bound.departmentForJob!,
        onAutoRunSkip: bound.onAutoRunSkip,
        logger: ctx.logger
      })
    }
  })
}
