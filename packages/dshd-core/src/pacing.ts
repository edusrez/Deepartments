// dsh-deepartments — the PACING (peak/valley FRANJA) domain module.
//
// Owner mission 2026-08-28 (pacing/coste, MEDIUM): the org lives in BURST mode
// around the owner's off-peak/peak pricing boundary; the goal is a GATE that
// reduces 429s and cost (NEW host→department dispatches pause inside the peak).
// This module owns the PURE UTC clock machinery: is the current instant inside
// a peak window (given the weekday/hour window config + an edge buffer), and
// UNTIL WHEN does the CURRENT franja last (the «hasta HH:MM UTC» state).
//
// MIRROR of the dsh-key-pooler peak definition (dsh-key-pooler, src/pool.ts
// DEFAULT_PEAK_WINDOWS + inPeakWindow — SEPARATE repository; crossed by
// comment BOTH ways): the owner's off-peak/peak boundary expressed in UTC.
//   PEAK ⇔ weekday(UTC) ∈ {1..5} (Mon-Fri) ∧ UTC hour ∈ {1,2,3,6,7,8,9},
//   with a configurable edge buffer (default 30 min) on BOTH boundaries
//   (request start/finish bias).
// The pooler models the windows as TWO day-ranges (Mon-Fri 01:00-04:00 and
// 06:00-10:00, each ± bufferMs); the per-HOUR model here (each hour h ∈ hours
// covers [h:00 − buffer, (h+1):00 + buffer)) is MATHEMATICALLY EQUIVALENT —
// adjacent per-hour intervals with the same buffer merge to exactly the same
// covered set ([00:30,04:30) ∪ [05:30,10:30) for the defaults). The matching
// inequality is the pooler's, verbatim: `dayMs >= startMs && dayMs < endMs`
// (start inclusive, end exclusive) with the weekday filter applied to the
// SAMPLE's UTC day-of-week BEFORE the buffer (a Friday window's buffer never
// creeps into Saturday). NO timezone library — Date UTC accessors only.
//
// NO export default (pitfall 0001 — breaks `inject`).

/** Default peak weekdays: 1=Monday .. 7=Sunday (UTC). Mon-Fri. */
export const PACING_DEFAULT_WEEKDAY: readonly number[] = [1, 2, 3, 4, 5]
/** Default peak UTC hours {1,2,3,6,7,8,9} ≡ the pooler's two day-windows
 * 01:00-04:00 + 06:00-10:00. */
export const PACING_DEFAULT_HOURS: readonly number[] = [1, 2, 3, 6, 7, 8, 9]
/** Default edge buffer on BOTH window boundaries (30 min — the pooler's
 * `fallback.peakBufferMs` default: the request start/finish bias). */
export const PACING_DEFAULT_BUFFER_MS = 30 * 60 * 1000

/** The UTC peak-window options `isPeakAt`/`pacingStateAt` accept (pure —
 * identical shape to the pooler's fallback.peakWindows + peakBufferMs). Absent
 * keys fall back to the code defaults above. */
export interface PacingWindowOptions {
  /** Weekdays in peak, 1=Monday .. 7=Sunday (UTC). Default [1,2,3,4,5]. */
  weekday?: number[]
  /** UTC hours in peak. Default [1,2,3,6,7,8,9]. */
  hours?: number[]
  /** Edge buffer (ms) on BOTH boundaries. Default 1800000 = 30 min. */
  bufferMs?: number
}

/** The `org.pacing.*` config shape the wake-pack assembly and the system-health
 * daemon read (STRUCTURAL — this package never imports the bundle's org.ts;
 * the bundle's org.ts `PacingConfig` declares the same shape for its zod
 * schema). Absent section/keys → code defaults (enabled on). */
export interface PacingConfigLike {
  /** When explicitly false the franja monitor is OFF — the wake-pack section
   * is omitted and NO transition notices are emitted (the pre-pacing
   * behavior). Absent → enabled (default). */
  enabled?: boolean
  /** The peak window: weekdays × hours (UTC). Absent → the code defaults. */
  peakWindows?: {
    /** Weekdays in peak, 1=Monday .. 7=Sunday (UTC). Default [1..5]. */
    weekday?: number[]
    /** UTC hours in peak. Default {1,2,3,6,7,8,9}. */
    hours?: number[]
  }
  /** Edge buffer (ms) on BOTH window boundaries (request start/finish bias).
   * Default 1800000 = 30 min (the pooler's peakBufferMs default). */
  peakBufferMs?: number
}

/** The window options RESOLVED to concrete numbers (the code defaults filled).
 * Mutable arrays (freshly copied per resolve — never a reference to the const
 * defaults), so a resolved window is assignable back to `PacingWindowOptions`. */
export interface ResolvedPacingWindow {
  weekday: number[]
  hours: number[]
  bufferMs: number
}

/** Resolve window options to the concrete defaults (absent/invalid entries fall
 * back; a malformed array entry is skipped — never throws). An array whose
 * entries are ALL invalid resolves to the code default (an empty kept-set is
 * useless — the default window wins). */
export function resolvePacingWindow(options?: PacingWindowOptions): ResolvedPacingWindow {
  const keptWeekday = Array.isArray(options?.weekday)
    ? options!.weekday!.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    : []
  const weekday = keptWeekday.length > 0 ? keptWeekday : [...PACING_DEFAULT_WEEKDAY]
  const keptHours = Array.isArray(options?.hours)
    ? options!.hours!.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    : []
  const hours = keptHours.length > 0 ? keptHours : [...PACING_DEFAULT_HOURS]
  const bufferMs = typeof options?.bufferMs === 'number' && Number.isFinite(options.bufferMs) && options.bufferMs >= 0
    ? options.bufferMs
    : PACING_DEFAULT_BUFFER_MS
  return { weekday, hours, bufferMs }
}

/** Map an `org.pacing.*` config value to the PacingWindowOptions the pure
 * functions consume (the config's `peakWindows` + sibling `peakBufferMs`).
 * Absent/partial config → the code defaults via resolvePacingWindow. */
export function pacingWindowFromConfig(config?: PacingConfigLike): PacingWindowOptions {
  return {
    ...(config?.peakWindows !== undefined ? {
      weekday: config.peakWindows.weekday,
      hours: config.peakWindows.hours
    } : {}),
    ...(config?.peakBufferMs !== undefined ? { bufferMs: config.peakBufferMs } : {})
  }
}

/** The UTC day-of-week of `date`, normalized 1=Monday .. 7=Sunday (the
 * dsh-key-pooler convention). */
export function utcDow(date: Date): number {
  const dow = date.getUTCDay()
  return dow === 0 ? 7 : dow
}

/** Milliseconds since UTC midnight for `date` (the pooler's `dayMs`). */
export function utcDayMs(date: Date): number {
  return (date.getUTCHours() * 60 + date.getUTCMinutes()) * 60_000 + date.getUTCSeconds() * 1000 + date.getUTCMilliseconds()
}

/**
 * PURE: is `date` inside ANY configured peak window, in UTC, with an optional
 * `bufferMs` margin on BOTH edges? EXACT MIRROR of the dsh-key-pooler
 * `inPeakWindow` (the same inequality + the same weekday-first filter): the
 * sample matches when its UTC day-of-week is listed in `weekday` AND its
 * milliseconds-since-UTC-midnight falls in any covered interval
 * [h:00 − buffer, (h+1):00 + buffer). A negative start (a window whose buffer
 * wraps before midnight) matches from 00:00 of the sample's day — the
 * pooler's `dayMs >= startMs` is trivially true there; an end past midnight
 * extends the match to the END of the sample's day (it never creeps into the
 * next day — the pooler's day-boundary semantics). Malformed/empty windows
 * are skipped (never throws).
 */
export function isPeakAt(date: Date, options?: PacingWindowOptions): boolean {
  const win = resolvePacingWindow(options)
  if (!win.weekday.includes(utcDow(date))) return false
  const dayMs = utcDayMs(date)
  for (const h of win.hours) {
    const startMs = h * 3_600_000 - win.bufferMs
    const endMs = (h + 1) * 3_600_000 + win.bufferMs
    if (dayMs >= startMs && dayMs < endMs) return true
  }
  return false
}

const DAY_MS = 86_400_000

/** PURE: the ms epoch of the NEXT franja transition after `date` — the instant
 * the CURRENT franja ends («hasta HH:MM UTC»). Exact: candidate edges are the
 * buffer-expanded window boundaries (start−buffer / end+buffer) over a full
 * 7-day cycle + 1 day of slack (a wrapped edge clamps to its day boundary —
 * start−buffer < 0 → the window opens AT the day start; end+buffer ≥ 24h →
 * the window closes at the NEXT day start); an edge is a transition iff
 * `isPeakAt(edge−1ms) !== isPeakAt(edge+1ms)`. Returns `date` itself when no
 * transition is found in the horizon (cannot happen with a non-empty hours
 * config — defensive). */
export function nextTransitionAt(date: Date, options?: PacingWindowOptions): number {
  const win = resolvePacingWindow(options)
  const nowMs = date.getTime()
  const edges: number[] = []
  for (let day = 0; day <= 8; day++) {
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + day)
    for (const h of win.hours) {
      const startEdge = dayStart + h * 3_600_000 - win.bufferMs
      const endEdge = dayStart + (h + 1) * 3_600_000 + win.bufferMs
      if (startEdge - dayStart < 0) edges.push(dayStart)
      else edges.push(startEdge)
      if (endEdge - dayStart >= DAY_MS) edges.push(dayStart + DAY_MS)
      else edges.push(endEdge)
    }
  }
  let best = Number.POSITIVE_INFINITY
  for (const edge of edges) {
    if (edge <= nowMs) continue
    const before = isPeakAt(new Date(edge - 1), win)
    const after = isPeakAt(new Date(edge + 1), win)
    if (before !== after && edge < best) best = edge
  }
  return Number.isFinite(best) ? best : nowMs
}

/** 'HH:MM' (UTC) of a ms epoch — the «hasta HH:MM UTC» rendering. */
export function hhMmUtc(epochMs: number): string {
  const d = new Date(epochMs)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** The merged peak-span text 'HH:MM-HH:MM' (UTC) for the bracket of the franja
 * line: from the MIN hour's start to the MAX hour's end (e.g. hours
 * {1,2,3,6,7,8,9} → '01:00-10:00'). The span summarizes the WINDOWS, not the
 * current instant — it is identical in a PEAK line and in a VALLE line. */
export function pacingSpan(win: PacingWindowOptions | ResolvedPacingWindow): string {
  const resolved = resolvePacingWindow(win)
  if (resolved.hours.length === 0) return '--:--'
  const min = Math.min(...resolved.hours)
  const max = Math.max(...resolved.hours)
  const hh = (ms: number): string => hhMmUtc(ms)
  return `${hh(min * 3_600_000)}-${hh((max + 1) * 3_600_000)}`
}

/** The current franja STATE: whether `date` is in the peak, UNTIL WHEN the
 * current franja ends (the next transition instant + its 'HH:MM' UTC), and the
 * merged peak span for the info line. PURE, UTC, no timezone library. */
export interface PacingState {
  /** True when `date` is inside a peak window (with its edge buffer). */
  peak: boolean
  /** The ms epoch of the NEXT franja transition — the instant the CURRENT
   * franja ends (a peak ends at its buffer-extended end; a valley ends at the
   * next buffer-extended window start). */
  untilMs: number
  /** 'HH:MM' UTC of `untilMs` (the «hasta» time). */
  untilHhMm: string
  /** The merged peak span 'HH:MM-HH:MM' UTC (see `pacingSpan`). */
  span: string
}

/** PURE: the franja state at `date` (see PacingState). */
export function pacingStateAt(date: Date, options?: PacingWindowOptions): PacingState {
  const win = resolvePacingWindow(options)
  const peak = isPeakAt(date, win)
  const untilMs = nextTransitionAt(date, win)
  return { peak, untilMs, untilHhMm: hhMmUtc(untilMs), span: pacingSpan(win) }
}

/** The ONE stable franja line injected into the wake pack (section 5c) and
 * used by the transition notices:
 *   `Franja: PEAK [01:00-10:00] UTC — hasta 10:30 UTC`
 *   `Franja: VALLE [01:00-10:00] UTC — hasta 00:30 UTC`
 * (the bracket = the merged peak span; «hasta» = the end of the CURRENT
 * franja — the next transition). PURE. */
export function formatFranjaLine(state: PacingState): string {
  return `Franja: ${state.peak ? 'PEAK' : 'VALLE'} [${state.span}] UTC — hasta ${state.untilHhMm} UTC`
}

/**
 * Legible-count heuristic for the WORK-REGISTER pending queue (the «N» of the
 * VALLE resume notice — «reanuda; despachos diferidos: N»): the register is the
 * org's SINGLE pending-work queue (docs/WORK-REGISTER.md); the count is the
 * number of BOLD-MARKED item headers (`**…**`) across the OPEN `## ` sections
 * (a section whose heading contains CERRADO/closed is a reference section and
 * is excluded), skipping bold markers that are pure DONE/CERRADO/RESUELTO/
 * RETIRADO status tags. A legible approximation ONLY (never the full item
 * grammar — bullets pack many `·`-separated items) — "si legible; si no, sin
 * conteo". Returns UNDEFINED when the text is not a register-shaped doc (no
 * `## ` section headings → not legible → the notice omits the count). Never
 * throws.
 */
export function countPendingWorkRegister(text: string): number | undefined {
  const sections = text.split(/^##\s+/m)
  if (sections.length <= 1) return undefined
  let count = 0
  for (let i = 1; i < sections.length; i++) {
    const lines = sections[i].split('\n')
    const heading = (lines[0] ?? '').trim()
    if (/CERRADO|closed/i.test(heading)) continue
    const body = lines.slice(1).join('\n')
    const markers = body.match(/\*\*([^*]+)\*\*/g)
    if (markers === null) continue
    for (const marker of markers) {
      if (/\b(DONE|CERRADO|RESUELTO|RETIRADO)\b/i.test(marker)) continue
      count += 1
    }
  }
  return count
}