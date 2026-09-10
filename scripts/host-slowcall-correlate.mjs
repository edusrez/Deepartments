#!/usr/bin/env node
// dsh-deepartments — SLOW-TOOL-CALL x HOST-STATE CORRELATOR (LANE HOST-SAMPLER,
// 2026-09-10).
//
// THE QUESTION: a tool call took 234 s — WAS THE HOST SHORT during it, or did
// the latency come from somewhere else? Without a READING CRITERION the datum
// decides nothing: this script prints, for each slow call, the host state in
// +/-<window> s of it AND a verdict.
//
// THE CRITERION (declared, not improvised — the canonical text is
// docs/departments/internal-programming/HOST-SAMPLER.md §4, incl. the §4.3
// amendment RECORD of 2026-09-10). TWO FAMILIES, because "the box is short"
// and "the box was busy" are different findings:
//   CAPACITY (widening HAS a basis) — any of:
//     psi.cpu.full.avg60  >= 1 %   (ALL tasks CPU-stalled: the unambiguous
//                                   global shortage)
//     psi.io.full.avg60   >= 1 %
//     psi.io.some.avg60   >= 5 %
//     psi.memory.some.avg60 >= 1 %
//     MemAvailable falls >= 25 % AND psi.memory.some >= 0,5 % (real reclaim)
//     load1/nproc >= 2 in >= 2 CONSECUTIVE samples (sustained runqueue)
//   CONTENTION (names a scheduling hypothesis, does NOT justify widening) —
//   no capacity signal, and any of:
//     psi.cpu.some.avg60  >= 5 %   (>= 1 task CPU-stalled; on a box with idle
//                                   cores this is scheduling contention)
//     MemAvailable falls >= 10 %   (page-cache churn unless psi.memory agrees)
//   FLAT          the window is FULLY covered and NO signal of either family
//   INSUFFICIENT  no verdict — no samples, or no signal with a hole
//                 (> 3 x cadence) that could hide the pressure. A POSITIVE
//                 signal always wins over a hole (pressure is never invented by
//                 a gap); a NEGATIVE one requires full coverage.
//   ⇒ FLAT / CONTENTION mean "widening is not the answer": the lateness lives in
//     the DELIVERY/queue machinery (the tool return waits on the wake/settle
//     chain) or in scheduling; CAPACITY means the machine is a plausible
//     contributor. The CONTENTION reading also prints the ARITHMETIC BOUND:
//     even attributing the whole window stall share to the call leaves most of
//     the latency unexplained by host stall.
// The thresholds are anchored on THIS host's own 32-day baseline (CPU-stall
// 1,82 %, IO 0,11 %, memory 0,00 %).
//
// METHOD (identical to the QD norm `TOOL-TIMING-WATCHDOG.md` §3 — it is the
// source of truth and this script NEVER re-derives it differently): read
// <stateDir>/tool-intents.jsonl, pair the `intent` and `settle` lines BY `id`
// (never by order or timestamps alone), duration = settle.ts - intent.ts.
// Calls with no settle are counted as `unpaired` — never as 0 s.
//
// fb-16 (NO SECRETS): the output names tool, agent/member id, recipient ids,
// the call id and NUMBERS. It NEVER prints the `args` of an intent, message
// bodies, tokens or sensitive paths.
//
// USAGE (the recipe — "for this slow call, the host state in +/-60 s"):
//   node scripts/host-slowcall-correlate.mjs                       # last 2 h, the 3 tools, >=60 s
//   node scripts/host-slowcall-correlate.mjs --since 30m --min 60 --window 60
//   node scripts/host-slowcall-correlate.mjs --call call_00_ABC   # ONE call id
//   node scripts/host-slowcall-correlate.mjs --tool any --top 10  # every tool
//   node scripts/host-slowcall-correlate.mjs --json               # machine output
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_TOOLS = ['send_message', 'dept_feedback', 'dept_worker_spawn']
export const DEFAULT_MIN_SEC = 60
export const DEFAULT_WINDOW_SEC = 60
export const DEFAULT_TOP = 5
export const DEFAULT_SINCE = '2h'

/** The declared reading criterion. TWO families (amendment 2026-09-10, see the
 * norm §4.3): CAPACITY signals decide "widening has a basis"; CONTENTION signals
 * only name a scheduling hypothesis and explicitly do NOT justify widening.
 * Percent values; load in runqueue-per-core. */
export const CRITERION = {
  // --- capacity family (the box is short) ---
  cpuFullAvg60Pct: 1,
  ioFullAvg60Pct: 1,
  ioSomeAvg60Pct: 5,
  memorySomeAvg60Pct: 1,
  loadPerCore: 2,
  loadConsecutiveSamples: 2,
  memAvailableCapacityDropPct: 25,
  memoryCorroborationPct: 0.5,
  // --- contention family (the box is busy, NOT short) ---
  cpuSomeAvg60Pct: 5,
  memAvailableDropPct: 10,
  /** A window whose largest hole exceeds this many cadences is NOT fully
   * covered (a FLAT verdict is then not assertable). */
  gapToleranceCadences: 3,
}

/** Parse a duration/instant: `2h`, `90m`, `45s`, `1d`, an ISO string or epoch
 * ms. Returns epoch ms, or null when unparseable. PURE. */
export function parseInstant(text, now = Date.now()) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const trimmed = text.trim()
  const rel = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(trimmed)
  if (rel !== null) {
    const n = Number(rel[1])
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[rel[2]]
    return Math.round(now - n * unit)
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

/** Pair intent/settle rows BY id (the QD norm §3 method). PURE. */
export function pairCalls(records) {
  const intents = new Map()
  const settles = new Map()
  for (const row of records) {
    if (row === null || typeof row !== 'object') continue
    const id = row.id
    if (typeof id !== 'string' || id.length === 0) continue
    const phase = row.kind ?? row.phase
    if (phase === 'intent') intents.set(id, row)
    else if (phase === 'settle') settles.set(id, row)
  }
  const calls = []
  let unpaired = 0
  let orphanSettles = 0
  for (const [id, intent] of intents) {
    const settle = settles.get(id)
    if (settle === undefined) {
      unpaired++
      continue
    }
    const targets = typeof intent.target === 'string' && intent.target.length > 0 ? intent.target.split(',') : null
    calls.push({
      id,
      tool: intent.tool ?? intent.name ?? '?',
      agent: intent.agent ?? null,
      memberId: intent.memberId ?? null,
      targets,
      intentTs: intent.ts,
      settleTs: settle.ts,
      durationMs: settle.ts - intent.ts,
      durationSec: Number(((settle.ts - intent.ts) / 1000).toFixed(3)),
      status: settle.status ?? null,
    })
  }
  for (const id of settles.keys()) if (!intents.has(id)) orphanSettles++
  return { calls, unpaired, orphanSettles, intents: intents.size, settles: settles.size }
}

/** Select the slow calls: tool filter, minimum duration, lower time bound.
 * PURE. `tools` = null/['any'] means every tool. */
export function selectSlowCalls(calls, { tools, minSec, sinceTs, callId }) {
  const all = tools === null || tools.includes('any')
  const wanted = new Set(tools ?? [])
  const out = calls.filter((c) => {
    if (callId !== undefined && callId !== null && c.id !== callId) return false
    if (!all && !wanted.has(c.tool)) return false
    if (callId === undefined || callId === null) {
      if (c.durationSec < minSec) return false
      if (sinceTs !== null && typeof c.intentTs === 'number' && c.intentTs < sinceTs) return false
    }
    return true
  })
  out.sort((a, b) => b.durationSec - a.durationSec)
  return out
}

/** Parse one JSONL file into row objects (skipping malformed lines, counting
 * them). Returns { rows, malformed }. */
export function readJsonl(file) {
  if (!existsSync(file)) return { rows: [], malformed: 0, missing: true }
  const rows = []
  let malformed = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      malformed++
    }
  }
  return { rows, malformed, missing: false }
}

const maxOf = (values) => (values.length === 0 ? null : Math.max(...values))

/** Evaluate ONE call against the host samples, applying the declared
 * criterion. PURE (self-contained; exported for the hermetic test).
 * `samples` = rows of <stateDir>/host-health.jsonl (any order). */
export function evaluateCall(call, samples, opts = {}) {
  const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC
  const from = call.intentTs - windowSec * 1000
  const to = call.settleTs + windowSec * 1000
  const inWindow = (samples ?? [])
    .filter((s) => s !== null && typeof s === 'object' && typeof s.ts === 'number' && s.ts >= from && s.ts <= to)
    .sort((a, b) => a.ts - b.ts)
  const all = (samples ?? []).filter((s) => s !== null && typeof s === 'object' && typeof s.ts === 'number').sort((a, b) => a.ts - b.ts)
  const firstSample = all.length > 0 ? all[0].ts : null
  const lastSample = all.length > 0 ? all[all.length - 1].ts : null

  const result = {
    from,
    to,
    fromIso: new Date(from).toISOString(),
    toIso: new Date(to).toISOString(),
    sampleCount: inWindow.length,
    firstSample: firstSample === null ? null : new Date(firstSample).toISOString(),
    lastSample: lastSample === null ? null : new Date(lastSample).toISOString(),
    expectedCount: null,
    gapSec: null,
    coverage: 'none',
    peaks: {},
    psiWindow: {},
    memAvailableDropPct: null,
    rssKbFirst: null,
    rssKbLast: null,
    swapUsedKbFirst: null,
    swapUsedKbLast: null,
    hostStallBoundSharePct: null,
    hostStallBoundSec: null,
    hostStallBoundUnexplainedPct: null,
    daemonCpuSec: null,
    daemonCpuRatio: null,
    signals: [],
    capacitySignals: [],
    contentionSignals: [],
    pressureClass: null,
    verdict: 'INSUFFICIENT',
    reasons: [],
  }
  if (inWindow.length === 0) {
    const why =
      firstSample !== null && to < firstSample
        ? `the window ends ${Math.round((firstSample - to) / 1000)} s BEFORE the sampler's first row (${result.firstSample})`
        : lastSample !== null && from > lastSample
          ? `the window starts ${Math.round((from - lastSample) / 1000)} s AFTER the sampler's last row (${result.lastSample}) — sampler stopped?`
          : 'the sampler has no row inside the window (a hole)'
    result.reasons.push(`no host sample in the window: ${why}`)
    return result
  }

  const cadences = inWindow.map((s) => (Number.isFinite(s.intervalSec) ? s.intervalSec : 45))
  const cadence = maxOf(cadences) ?? 45
  const gaps = []
  gaps.push(Math.round((inWindow[0].ts - from) / 1000))
  for (let i = 1; i < inWindow.length; i++) gaps.push(Math.round((inWindow[i].ts - inWindow[i - 1].ts) / 1000))
  gaps.push(Math.round((to - inWindow[inWindow.length - 1].ts) / 1000))
  result.gapSec = maxOf(gaps)
  result.expectedCount = Math.round((to - from) / 1000 / cadence) + 1
  const fullCoverage = result.gapSec <= cadence * CRITERION.gapToleranceCadences
  result.coverage = fullCoverage ? 'full' : 'partial'

  const num = (s, pick) => {
    const v = pick(s)
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  const cpuSome60 = inWindow.map((s) => num(s, (x) => x.psi?.cpu?.some?.avg60)).filter((v) => v !== null)
  const cpuSome10 = inWindow.map((s) => num(s, (x) => x.psi?.cpu?.some?.avg10)).filter((v) => v !== null)
  const cpuFull60 = inWindow.map((s) => num(s, (x) => x.psi?.cpu?.full?.avg60)).filter((v) => v !== null)
  const ioSome60 = inWindow.map((s) => num(s, (x) => x.psi?.io?.some?.avg60)).filter((v) => v !== null)
  const ioFull60 = inWindow.map((s) => num(s, (x) => x.psi?.io?.full?.avg60)).filter((v) => v !== null)
  const memSome60 = inWindow.map((s) => num(s, (x) => x.psi?.memory?.some?.avg60)).filter((v) => v !== null)
  const memFull60 = inWindow.map((s) => num(s, (x) => x.psi?.memory?.full?.avg60)).filter((v) => v !== null)
  const loadPerCore = inWindow.map((s) => num(s, (x) => x.load1PerCore)).filter((v) => v !== null)
  const available = inWindow.map((s) => num(s, (x) => x.mem?.availableKb)).filter((v) => v !== null)
  const rss = inWindow.map((s) => num(s, (x) => x.daemon?.rssKb)).filter((v) => v !== null)
  const swap = inWindow.map((s) => num(s, (x) => x.mem?.swapUsedKb)).filter((v) => v !== null)

  result.peaks = {
    cpuSomeAvg60Pct: maxOf(cpuSome60),
    cpuSomeAvg10Pct: maxOf(cpuSome10),
    cpuFullAvg60Pct: maxOf(cpuFull60),
    ioSomeAvg60Pct: maxOf(ioSome60),
    ioFullAvg60Pct: maxOf(ioFull60),
    memSomeAvg60Pct: maxOf(memSome60),
    memFullAvg60Pct: maxOf(memFull60),
    load1PerCore: maxOf(loadPerCore),
  }

  if (available.length >= 2) {
    const high = Math.max(...available)
    const low = Math.min(...available)
    result.memAvailableDropPct = high > 0 ? Number((((high - low) / high) * 100).toFixed(2)) : null
  }
  if (rss.length >= 2) {
    result.rssKbFirst = rss[0]
    result.rssKbLast = rss[rss.length - 1]
  }
  if (swap.length >= 2) {
    result.swapUsedKbFirst = swap[0]
    result.swapUsedKbLast = swap[swap.length - 1]
  }
  // The DAEMON'S OWN CPU over the window (USER_HZ = 100): a ratio near 1,0 means
  // its compute saturated a core; a near-zero ratio means it was WAITING (so the
  // latency is outside its CPU).
  const cpuTicks = inWindow.map((s) => num(s, (x) => x.daemon?.cpuTicks)).filter((v) => v !== null)
  if (cpuTicks.length >= 2) {
    const last = inWindow[inWindow.length - 1]
    const first = inWindow[0]
    const firstTicks = num(first, (x) => x.daemon?.cpuTicks)
    const lastTicks = num(last, (x) => x.daemon?.cpuTicks)
    const dtSec = (last.ts - first.ts) / 1000
    if (firstTicks !== null && lastTicks !== null && dtSec > 0) {
      result.daemonCpuSec = Number(((lastTicks - firstTicks) / 100).toFixed(1))
      result.daemonCpuRatio = Number(((lastTicks - firstTicks) / 100 / dtSec).toFixed(3))
    }
  }

  // PSI window totals: the EXACT average over the window from the cumulative
  // microsecond counters (independent of the avg10/60/300 exponential windows).
  const psiWindow = {}
  for (const res of ['cpu', 'io', 'memory']) {
    for (const kind of ['some', 'full']) {
      const first = inWindow[0]
      const last = inWindow[inWindow.length - 1]
      const a = num(first, (x) => x.psi?.[res]?.[kind]?.totalUs)
      const b = num(last, (x) => x.psi?.[res]?.[kind]?.totalUs)
      const dtMs = last.ts - first.ts
      if (a !== null && b !== null && dtMs > 0) {
        psiWindow[`${res}.${kind}Pct`] = Number((((b - a) / (dtMs * 1000)) * 100).toFixed(3))
      }
    }
  }
  result.psiWindow = psiWindow

  // THE BOUND (threshold-independent, norm §4.4): the largest window-exact PSI
  // share is an UPPER BOUND on the fraction of the call that the host's own
  // stall can explain — even granting that the whole stall was this call's.
  const shares = Object.values(psiWindow).filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (shares.length > 0) {
    const maxShare = Math.max(...shares)
    result.hostStallBoundSharePct = Number(maxShare.toFixed(3))
    result.hostStallBoundSec = Number(((maxShare / 100) * (call.durationSec ?? 0)).toFixed(1))
    result.hostStallBoundUnexplainedPct = Number((100 - maxShare).toFixed(1))
  }

  // --- THE CRITERION -------------------------------------------------------
  // TWO families: CAPACITY (widening has a basis) and CONTENTION (the box was
  // busy but had idle capacity — it does NOT justify widening). Every signal is
  // still REPORTED; only the reading is classed.
  const capacitySignals = []
  const contentionSignals = []
  const peak = (arr) => maxOf(arr)
  // CAPACITY — psi `full` = ALL tasks stalled (the unambiguous global shortage).
  if (peak(cpuFull60) !== null && peak(cpuFull60) >= CRITERION.cpuFullAvg60Pct) {
    capacitySignals.push(`psi.cpu.full.avg60 peak ${peak(cpuFull60)}% >= ${CRITERION.cpuFullAvg60Pct}% (ALL tasks CPU-stalled)`)
  }
  if (peak(ioFull60) !== null && peak(ioFull60) >= CRITERION.ioFullAvg60Pct) {
    capacitySignals.push(`psi.io.full.avg60 peak ${peak(ioFull60)}% >= ${CRITERION.ioFullAvg60Pct}% (ALL tasks IO-stalled)`)
  }
  if (peak(ioSome60) !== null && peak(ioSome60) >= CRITERION.ioSomeAvg60Pct) {
    capacitySignals.push(`psi.io.some.avg60 peak ${peak(ioSome60)}% >= ${CRITERION.ioSomeAvg60Pct}% (IO stall)`)
  }
  if (peak(memSome60) !== null && peak(memSome60) >= CRITERION.memorySomeAvg60Pct) {
    capacitySignals.push(`psi.memory.some.avg60 peak ${peak(memSome60)}% >= ${CRITERION.memorySomeAvg60Pct}% (memory pressure)`)
  }
  if (result.memAvailableDropPct !== null && result.memAvailableDropPct >= CRITERION.memAvailableCapacityDropPct && peak(memSome60) !== null && peak(memSome60) >= CRITERION.memoryCorroborationPct) {
    capacitySignals.push(
      `MemAvailable fell ${result.memAvailableDropPct}% inside the window AND psi.memory.some.avg60 peaked ${peak(memSome60)}% (>= ${CRITERION.memoryCorroborationPct}%) — a real reclaim, not page-cache churn`,
    )
  }
  let run = 0
  let bestRun = 0
  for (const s of inWindow) {
    const perCore = num(s, (x) => x.load1PerCore)
    if (perCore !== null && perCore >= CRITERION.loadPerCore) {
      run++
      bestRun = Math.max(bestRun, run)
    } else {
      run = 0
    }
  }
  if (bestRun >= CRITERION.loadConsecutiveSamples) {
    capacitySignals.push(`load1/nproc >= ${CRITERION.loadPerCore} in ${bestRun} consecutive samples (sustained runqueue)`)
  }
  // CONTENTION — partial stalls on a box that still had idle capacity.
  if (peak(cpuSome60) !== null && peak(cpuSome60) >= CRITERION.cpuSomeAvg60Pct) {
    contentionSignals.push(`psi.cpu.some.avg60 peak ${peak(cpuSome60)}% >= ${CRITERION.cpuSomeAvg60Pct}% (at least ONE task CPU-stalled)`)
  }
  if (result.memAvailableDropPct !== null && result.memAvailableDropPct >= CRITERION.memAvailableDropPct) {
    contentionSignals.push(`MemAvailable fell ${result.memAvailableDropPct}% inside the window (>= ${CRITERION.memAvailableDropPct}%) — page-cache churn unless psi.memory corroborates`)
  }
  result.capacitySignals = capacitySignals
  result.contentionSignals = contentionSignals
  result.signals = [...capacitySignals, ...contentionSignals]

  if (capacitySignals.length > 0) {
    result.verdict = 'PRESSURE'
    result.pressureClass = 'capacity'
    result.reasons.push(...capacitySignals)
  } else if (contentionSignals.length > 0) {
    result.verdict = 'PRESSURE'
    result.pressureClass = 'contention'
    result.reasons.push(...contentionSignals)
    const idleNote =
      result.peaks.cpuFullAvg60Pct === 0
        ? 'psi.cpu.full = 0% and load1/nproc peaked at ' +
          `${result.peaks.load1PerCore} — the box had idle capacity: this is SCHEDULING CONTENTION, not a shortage`
        : 'the runqueue stayed below the capacity threshold'
    result.reasons.push(idleNote)
  } else if (fullCoverage) {
    result.verdict = 'FLAT'
    result.reasons.push(
      `fully covered (${inWindow.length} samples, largest gap ${result.gapSec} s vs cadence ${cadence} s) and NO signal fired`,
    )
  } else {
    result.verdict = 'INSUFFICIENT'
    result.reasons.push(
      `no signal fired BUT coverage is partial: largest gap ${result.gapSec} s > ${cadence * CRITERION.gapToleranceCadences} s (${result.sampleCount}/${result.expectedCount} expected samples) — a hole could hide the pressure`,
    )
  }
  return result
}

/** The reading of a verdict (the sentence that DECIDES what to do). PURE.
 * `evaluation` is optional and only refines the PRESSURE reading into its
 * CAPACITY / CONTENTION class (the amendment of 2026-09-10, norm §4.3) and adds
 * the threshold-independent BOUND (norm §4.4). */
export function verdictReading(verdict, call, evaluation = null) {
  const bound =
    evaluation !== null && typeof evaluation?.hostStallBoundSec === 'number'
      ? ` Even attributing the WHOLE window stall share (${evaluation.hostStallBoundSharePct}%) to this call bounds the host-attributable part at ~${evaluation.hostStallBoundSec} s of ${call.durationSec} s (${evaluation.hostStallBoundUnexplainedPct}% UNEXPLAINED by host stall).`
      : ''
  const daemonNote =
    evaluation !== null && typeof evaluation?.daemonCpuRatio === 'number'
      ? ` The daemon itself burned ${evaluation.daemonCpuSec} s of CPU over the window (${evaluation.daemonCpuRatio} core) — ` +
        (evaluation.daemonCpuRatio >= 0.75
          ? 'its own compute was near a FULL core: look INSIDE the daemon (single-threaded event loop / turn machinery), not at the box size.'
          : 'so it was mostly WAITING: the delay is in the wake/delivery chain (or in a network call), not in its own CPU.')
      : ''
  if (verdict === 'PRESSURE') {
    const cls = evaluation?.pressureClass ?? null
    if (cls === 'contention') {
      return (
        `HOST BUSY BUT NOT SHORT during this ${call.durationSec}s call (CONTENTION, not capacity) ⇒ widening the box does NOT have a basis from this datum: ` +
        `psi.cpu.full was 0% (no global stall) and the runqueue stayed under the capacity threshold, so part of the latency is scheduling contention among many runnable processes.` +
        bound +
        daemonNote +
        ' Next step: the per-agent concurrency / delivery-machinery cross-check (deliveries.jsonl, QD norm §4).'
      )
    }
    return (
      `HOST UNDER CAPACITY PRESSURE during this ${call.durationSec}s call ⇒ the machine IS a plausible contributor: naming the metric above is the basis for widening/resizing (or for moving the work in time).` +
      bound +
      daemonNote +
      (evaluation !== null && typeof evaluation?.hostStallBoundUnexplainedPct === 'number' && evaluation.hostStallBoundUnexplainedPct > 75
        ? ' NOTE: the bound is small — the signal is REAL but it cannot account for most of the latency; treat widening as one factor, not THE cause.'
        : '')
    )
  }
  if (verdict === 'FLAT') {
    return `HOST FLAT during this ${call.durationSec}s call ⇒ the machine is NOT the cause: widening would not have helped.${bound}${daemonNote} The latency lives in the DELIVERY/queue machinery (the tool's return waits on the wake/settle chain) — next step: cross-check <stateDir>/deliveries.jsonl for the held (messageId, recipientId) pair (QD TOOL-TIMING-WATCHDOG §4).`
  }
  return 'NO VERDICT — insufficient host coverage for this window; the datum does not decide anything. Restore/verify the sampler and re-run.'
}

const fmt = (v, unit = '') => (typeof v === 'number' ? `${v}${unit}` : 'n/a')

/** Render one evaluated call as text. */
export function renderCall(call, evaluation, opts = {}) {
  const lines = []
  lines.push(`--- ${call.id}  ${call.tool}  ${call.durationSec}s  settle=${call.status ?? 'n/a'}`)
  lines.push(`    caller: ${call.memberId ?? call.agent ?? 'n/a'}${call.targets === null ? '' : `  ->  ${call.targets.join(', ')}`}`)
  lines.push(`    call  : ${new Date(call.intentTs).toISOString()} .. ${new Date(call.settleTs).toISOString()}`)
  lines.push(
    `    window: ${evaluation.fromIso} .. ${evaluation.toIso}  (+/-${opts.windowSec ?? DEFAULT_WINDOW_SEC}s)  ` +
      `samples=${evaluation.sampleCount}/${evaluation.expectedCount ?? '?'}  largest-gap=${fmt(evaluation.gapSec, 's')}  coverage=${evaluation.coverage}`,
  )
  const p = evaluation.peaks
  lines.push(
    `    peaks : cpu.some.avg60=${fmt(p.cpuSomeAvg60Pct, '%')} (avg10 ${fmt(p.cpuSomeAvg10Pct, '%')}, full ${fmt(p.cpuFullAvg60Pct, '%')})  ` +
      `io.some.avg60=${fmt(p.ioSomeAvg60Pct, '%')} (full ${fmt(p.ioFullAvg60Pct, '%')})  mem.some.avg60=${fmt(p.memSomeAvg60Pct, '%')}  load1/nproc=${fmt(p.load1PerCore)}`,
  )
  const w = evaluation.psiWindow
  lines.push(
    `    window: psi cpu some ${fmt(w['cpu.somePct'], '%')} / full ${fmt(w['cpu.fullPct'], '%')}   ` +
      `io some ${fmt(w['io.somePct'], '%')} / full ${fmt(w['io.fullPct'], '%')}   mem some ${fmt(w['memory.somePct'], '%')}   ` +
      `MemAvailable drop=${fmt(evaluation.memAvailableDropPct, '%')}  daemon RSS ${fmt(evaluation.rssKbFirst)} -> ${fmt(evaluation.rssKbLast)} kB  ` +
      `daemon CPU ${fmt(evaluation.daemonCpuSec, 's')} (${fmt(evaluation.daemonCpuRatio, ' core')})  ` +
      `swapUsed ${fmt(evaluation.swapUsedKbFirst)} -> ${fmt(evaluation.swapUsedKbLast)} kB`,
  )
  lines.push(`    VERDICT: ${evaluation.verdict}${evaluation.pressureClass === null ? '' : ` (${evaluation.pressureClass})`}`)
  if (evaluation.hostStallBoundSec !== null) {
    lines.push(
      `    bound : the host's own stall explains AT MOST ${evaluation.hostStallBoundSec} s of this ${call.durationSec} s call ` +
        `(largest window-exact PSI share ${evaluation.hostStallBoundSharePct}% → ${evaluation.hostStallBoundUnexplainedPct}% unexplained)`,
    )
  }
  for (const reason of evaluation.reasons) lines.push(`      · ${reason}`)
  lines.push(`      ⇒ ${verdictReading(evaluation.verdict, call, evaluation)}`)
  return lines.join('\n')
}

/** Parse the CLI options (defaults declared). */
export function parseArgs(argv) {
  const opts = {
    stateDir: '/.deepartments',
    intents: null,
    samples: null,
    tools: DEFAULT_TOOLS.slice(),
    minSec: DEFAULT_MIN_SEC,
    windowSec: DEFAULT_WINDOW_SEC,
    since: DEFAULT_SINCE,
    top: DEFAULT_TOP,
    callId: null,
    json: false,
    quiet: false,
  }
  const takesValue = new Set(['state-dir', 'intents', 'samples', 'tool', 'min', 'window', 'since', 'top', 'call'])
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) continue
    const eq = raw.indexOf('=')
    const key = eq === -1 ? raw.slice(2) : raw.slice(2, eq)
    let value = eq === -1 ? null : raw.slice(eq + 1)
    if (takesValue.has(key) && value === null) {
      value = argv[i + 1]
      i++
    }
    switch (key) {
      case 'state-dir':
        opts.stateDir = String(value)
        break
      case 'intents':
        opts.intents = String(value)
        break
      case 'samples':
        opts.samples = String(value)
        break
      case 'tool':
        opts.tools = String(value).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        break
      case 'min':
        opts.minSec = Number(value)
        break
      case 'window':
        opts.windowSec = Number(value)
        break
      case 'since': {
        const ts = parseInstant(String(value))
        if (ts === null) throw new Error(`--since must be an ISO instant, epoch ms or a duration like 2h/30m (got ${value})`)
        opts.since = String(value)
        opts.sinceTs = ts
        break
      }
      case 'top':
        opts.top = Number(value)
        break
      case 'call':
        opts.callId = String(value)
        break
      case 'json':
        opts.json = true
        break
      case 'quiet':
        opts.quiet = true
        break
      default:
        break
    }
  }
  if (opts.sinceTs === undefined) opts.sinceTs = parseInstant(opts.since)
  opts.intents = opts.intents ?? path.join(opts.stateDir, 'tool-intents.jsonl')
  opts.samples = opts.samples ?? path.join(opts.stateDir, 'host-health.jsonl')
  if (!Number.isFinite(opts.windowSec) || opts.windowSec < 0) throw new Error('--window must be a number of seconds >= 0')
  if (!Number.isFinite(opts.minSec) || opts.minSec < 0) throw new Error('--min must be a number of seconds >= 0')
  if (!Number.isFinite(opts.top) || opts.top < 0) throw new Error('--top must be a number >= 0 (0 = all)')
  return opts
}

/** Run the query. Returns the result payload (also used by the test). */
export function correlate(opts) {
  const intents = readJsonl(opts.intents)
  const samples = readJsonl(opts.samples)
  const paired = pairCalls(intents.rows)
  const selected = selectSlowCalls(paired.calls, {
    tools: opts.tools,
    minSec: opts.minSec,
    sinceTs: opts.sinceTs,
    callId: opts.callId,
  })
  const limited = opts.top > 0 && opts.callId === null ? selected.slice(0, opts.top) : selected
  const results = limited.map((call) => ({ call, evaluation: evaluateCall(call, samples.rows, { windowSec: opts.windowSec }) }))
  const summary = {
    generatedAt: new Date().toISOString(),
    sinceTs: opts.sinceTs,
    sinceIso: opts.sinceTs === null ? null : new Date(opts.sinceTs).toISOString(),
    intentsFile: opts.intents,
    samplesFile: opts.samples,
    intentsMissing: intents.missing === true,
    samplesMissing: samples.missing === true,
    malformed: intents.malformed + samples.malformed,
    pairedCalls: paired.calls.length,
    unpairedIntents: paired.unpaired,
    orphanSettles: paired.orphanSettles,
    slowSelected: selected.length,
    reported: limited.length,
    tools: opts.tools,
    minSec: opts.minSec,
    windowSec: opts.windowSec,
    verdicts: results.reduce((acc, r) => {
      acc[r.evaluation.verdict] = (acc[r.evaluation.verdict] ?? 0) + 1
      return acc
    }, {}),
  }
  return { summary, results }
}

/** The main entry point (CLI). */
export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  const { summary, results } = correlate(opts)
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          summary,
          calls: results.map((r) => ({ ...r.call, host: r.evaluation })),
        },
        null,
        2,
      )}\n`,
    )
    return { summary, results }
  }
  const out = []
  out.push(
    `[host-slowcall-correlate] since=${summary.sinceIso} tools=${summary.tools.join(',')} min=${summary.minSec}s window=+/-${summary.windowSec}s`,
  )
  out.push(
    `[population] paired calls ${summary.pairedCalls} · unpaired intents ${summary.unpairedIntents} · orphan settles ${summary.orphanSettles} · slow selected ${summary.slowSelected} (reporting ${summary.reported})`,
  )
  out.push(`[samples] ${summary.samplesFile}${summary.samplesMissing ? ' (MISSING — no host data at all)' : ''}`)
  out.push('')
  if (results.length === 0) {
    out.push('No slow call matched the filter in the window.')
  }
  for (const { call, evaluation } of results) {
    out.push(renderCall(call, evaluation, { windowSec: opts.windowSec }))
    out.push('')
  }
  out.push(`[verdicts] ${JSON.stringify(summary.verdicts)}`)
  if ((summary.verdicts.INSUFFICIENT ?? 0) > 0) {
    out.push(
      '[note] INSUFFICIENT windows are NOT evidence of a flat host — check `--samples` covers the call window (sampler cadence, restarts, rotation).',
    )
  }
  process.stdout.write(`${out.join('\n')}\n`)
  return { summary, results }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  try {
    main()
  } catch (err) {
    process.stderr.write(`[host-slowcall-correlate] FATAL ${err?.stack ?? String(err)}\n`)
    process.exit(1)
  }
}
