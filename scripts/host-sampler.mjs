#!/usr/bin/env node
// dsh-deepartments — HOST HEALTH SAMPLER (LANE HOST-SAMPLER, 2026-09-10).
//
// WHY: the owner's question is "is the server too small?" and the org cannot
// answer it today: `sar` publishes 10-minute AVERAGES and PSI (`/proc/pressure`)
// is only CUMULATIVE, so a 234 s tool call hides inside one average. This
// sampler appends ONE JSON line every <interval> seconds (the 30-60 s band,
// default 45 s) to a JSONL in the stateDir, so that any later reader can join a
// slow tool call (`<stateDir>/tool-intents.jsonl`) with the host state in
// +/-60 s of it. The JOIN and the READING CRITERION are NOT here: they live in
// `scripts/host-slowcall-correlate.mjs` and in the canonical norm
// `docs/departments/internal-programming/HOST-SAMPLER.md`.
//
// RUNNER HONESTY: a department JOB (the cron agenda) can only MATERIALIZE AN
// LLM WORKER (`runJobForDepartment`) — it cannot sample every 45 s without
// spawning a worker per tick. The SAMPLING is therefore done by THIS detached
// OS process; the agenda job `host-sampler`
// (docs/departments/internal-programming/jobs/host-sampler.md) is its
// CUSTODIAN (liveness check + periodic cross-read), not its engine.
//
// fb-16 (NO SECRETS): every field below is a NUMBER or a fixed system label
// read from `/proc`, the `df`-equivalent `statfsSync` and the daemon's
// `/proc/<pid>/status`. The sampler NEVER reads message bodies, NEVER reads the
// `args` of `tool-intents.jsonl`, and never records env vars, credentials,
// tokens, usernames, hostnames or agent content.
//
// USAGE
//   node scripts/host-sampler.mjs                       # foreground loop, 45 s
//   node scripts/host-sampler.mjs --once                # one sample, print it
//   node scripts/host-sampler.mjs --interval 30 --log /.deepartments/host-sampler.log
// Detached (the deployment's way — survives the launching shell):
//   setsid nohup node scripts/host-sampler.mjs \
//     --state-dir /.deepartments --interval 45 \
//     --log /.deepartments/host-sampler.log >>/.deepartments/host-sampler.log 2>&1 &
//
// SCHEMA (v1 — one JSON object per line, keys in this order):
//   v            schema version (1)
//   ts           epoch ms of the sampling instant (THE CUT)
//   iso          ISO-8601 UTC of ts
//   intervalSec  the DECLARED cadence (a reader detects gaps against it)
//   uptimeSec    host uptime
//   nproc        logical CPUs (os.cpus().length)
//   load1/5/15   1/5/15-minute load average (/proc/loadavg)
//   runnable     currently runnable tasks (loadavg field 4 numerator)
//   procs        total tasks on the host (loadavg field 4 denominator)
//   load1PerCore load1 / nproc (convenience; the criterion compares this)
//   mem          { totalKb, availableKb, usedKb, usedPct, swapTotalKb,
//                  swapFreeKb, swapUsedKb, dirtyKb, writebackKb }
//                usedKb = totalKb - availableKb (MemAvailable, NEVER
//                MemFree-only: MemAvailable is the kernel's own estimate of
//                the memory available for new work without swapping)
//   psi          { cpu|io|memory: { some: {avg10,avg60,avg300,totalUs},
//                                   full: {..} | null } | null }
//                Percent-of-window values exactly as `/proc/pressure/*` prints
//                them; totalUs = the cumulative microsecond counter (the ONLY
//                way to reconstruct a window retroactively). `full` = ALL tasks
//                stalled, `some` = at least one. null = file absent (kernel
//                without PSI, < 4.20) or unreadable.
//   daemon       { unit, profile, pid, rssKb, vmSizeKb, threads, state,
//                  cpuTicks } | null
//                The `node` process of the systemd unit (RSS from
//                /proc/<pid>/status VmRSS, cumulative utime+stime from
//                /proc/<pid>/stat — USER_HZ = 100, so cpuTicks/100 = CPU
//                seconds used since boot); null = not resolvable this tick.
//                cpuTicks is what separates "the daemon was COMPUTING" from
//                "the daemon was WAITING": its delta over a window divided by
//                the window's wall time is the CPU-core share it burned.
//   disk         { path: '/', totalBytes, usedBytes, availBytes, usedPct,
//                  inodesUsedPct } — df semantics (usedPct = used/(used+avail))
//   stateDir     { path, bytes, files, bytesAt, ageSec, truncated, skipped }
//                bytes = apparent-size sum of the stateDir tree; BYTE-CAPPED
//                walk (deadline) — `bytes` may be the last successful walk
//                (see bytesAt/ageSec) and `truncated` flags an incomplete walk.
//   tickMs       cost of building this sample (the sampler's own overhead)
//   errors       array of "source: message" strings ([] when clean); a source
//                that fails degrades to null, the series NEVER breaks — a
//                SILENT hole is what this sampler exists to prevent.
//
// ROTATION (declared cap + criterion): the JSONL is trimmed IN PLACE to the
// last KEEP_LINES (12000) lines whenever the file exceeds MAX_LINES (20000)
// lines OR MAX_BYTES (16 MiB). At the default 45 s cadence 20000 lines is
// ~10,4 days of history and the retained 12000 lines is ~6,25 days; the trim
// keeps the NEWEST rows (a host sample is only useful next to its call), is
// atomic (tmp + rename) and never touches another file. The optional log is
// trimmed the same way (MAX 4000 lines -> keep 1000).
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { cpus, loadavg, uptime } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SAMPLER_SCHEMA_VERSION = 1
export const DEFAULT_INTERVAL_SEC = 45
export const DEFAULT_MAX_LINES = 20000
export const DEFAULT_KEEP_LINES = 12000
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
export const DEFAULT_LOG_MAX_LINES = 4000
export const DEFAULT_LOG_KEEP_LINES = 1000
export const DEFAULT_DIR_BYTES_EVERY_SEC = 900
export const DEFAULT_DIR_WALK_DEADLINE_MS = 10000

const PSI_RESOURCES = ['cpu', 'io', 'memory']

/** Read a small /proc file as UTF-8 text; null when absent/unreadable. */
function readProcText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Parse one `/proc/pressure/*` line: `some avg10=0.00 avg60=0.00 avg300=0.00 total=1234`.
 * Returns { avg10, avg60, avg300, totalUs } or undefined on an unexpected
 * shape. PURE (exported for the hermetic test). */
export function parsePressureLine(line) {
  if (typeof line !== 'string') return undefined
  const m = /\bavg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)/.exec(line)
  if (m === null) return undefined
  return { avg10: Number(m[1]), avg60: Number(m[2]), avg300: Number(m[3]), totalUs: Number(m[4]) }
}

/** Parse a whole `/proc/pressure/<res>` file into { some, full } (`full` is
 * null when the kernel does not publish it). PURE. */
export function parsePressure(text) {
  if (typeof text !== 'string') return null
  const out = { some: null, full: null }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('some ')) out.some = parsePressureLine(trimmed) ?? null
    else if (trimmed.startsWith('full ')) out.full = parsePressureLine(trimmed) ?? null
  }
  return out.some === null && out.full === null ? null : out
}

/** Read all three PSI resources from `dir` (default /proc/pressure). A missing
 * file degrades to null for that resource only — never a hole, the caller
 * records the error string. */
export function readPressure(dir = '/proc/pressure') {
  const out = { cpu: null, io: null, memory: null, missing: [] }
  for (const res of PSI_RESOURCES) {
    const text = readProcText(path.join(dir, res))
    if (text === null) out.missing.push(res)
    else out[res] = parsePressure(text)
  }
  return out
}

/** Parse /proc/meminfo into a `key -> kB number` map (values exactly as the
 * kernel publishes them, in kB). PURE (exported for the hermetic test). */
export function parseMeminfo(text) {
  const out = {}
  if (typeof text !== 'string') return out
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_()]+):\s+(\d+)(?:\s+kB)?\s*$/.exec(line)
    if (m !== null) out[m[1]] = Number(m[2])
  }
  return out
}

/** The memory block of a sample from a meminfo map (MemAvailable-based).
 * PURE. Missing keys degrade to null instead of throwing. */
export function memBlock(info) {
  const totalKb = info['MemTotal'] ?? null
  const availableKb = info['MemAvailable'] ?? null
  const swapTotalKb = info['SwapTotal'] ?? null
  const swapFreeKb = info['SwapFree'] ?? null
  const usedKb = totalKb !== null && availableKb !== null ? totalKb - availableKb : null
  return {
    totalKb,
    availableKb,
    usedKb,
    usedPct: usedKb !== null && totalKb ? Number(((usedKb / totalKb) * 100).toFixed(2)) : null,
    swapTotalKb,
    swapFreeKb,
    swapUsedKb: swapTotalKb !== null && swapFreeKb !== null ? swapTotalKb - swapFreeKb : null,
    dirtyKb: info['Dirty'] ?? null,
    writebackKb: info['Writeback'] ?? null,
  }
}

/** Parse /proc/loadavg: `load1 load5 load15 runnable/total lastpid`. PURE. */
export function parseLoadavg(text) {
  if (typeof text !== 'string') return null
  const m = /^([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\/(\d+)\s+(\d+)/.exec(text.trim())
  if (m === null) return null
  return { load1: Number(m[1]), load5: Number(m[2]), load15: Number(m[3]), runnable: Number(m[4]), procs: Number(m[5]) }
}

/** The cmdline of a pid as a string array (NUL separated), or null when the
 * proc entry vanished / is unreadable. */
export function readCmdline(pid) {
  const raw = readProcText(`/proc/${pid}/cmdline`)
  if (raw === null) return null
  return raw.split('\0').filter((s) => s.length > 0)
}

/** Whether a cmdline belongs to the DSH daemon of `profile` (the systemd unit
 * runs `node /usr/bin/dsh --profile <profile> ...`). `dsh web` is a SEPARATE
 * process WITHOUT --profile and an agent session never carries --profile, so
 * the match is unambiguous. PURE (exported for the hermetic test). */
export function cmdlineMatchesDaemon(args, profile) {
  if (!Array.isArray(args) || args.length === 0) return false
  if (!args.some((a) => a === 'dsh' || a.endsWith('/dsh'))) return false
  return args.includes(`--profile=${profile}`) || (args.includes('--profile') && args.includes(String(profile)))
}

/** Resolve the daemon PID: the REUSED pid while it still matches, else a
 * bounded /proc scan (numeric entries only). Returns { pid, args } | null. */
export function resolveDaemonPid(profile, cachedPid) {
  if (Number.isFinite(cachedPid) && cachedPid > 0) {
    const args = readCmdline(cachedPid)
    if (args !== null && cmdlineMatchesDaemon(args, profile)) return { pid: cachedPid, args }
  }
  let entries
  try {
    entries = readdirSync('/proc')
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    const args = readCmdline(pid)
    if (args !== null && cmdlineMatchesDaemon(args, profile)) return { pid, args }
  }
  return null
}

/** Parse /proc/<pid>/status for the RSS block. PURE (exported for the test). */
export function parseProcStatus(text) {
  if (typeof text !== 'string') return null
  const num = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)
    return m === null ? null : Number(m[1])
  }
  const state = /^State:\s+(\S+)/m.exec(text)
  return { rssKb: num('VmRSS'), vmSizeKb: num('VmSize'), threads: num('Threads'), state: state === null ? null : state[1] }
}

/** Parse /proc/<pid>/stat for the cumulative CPU time (utime + stime, in clock
 * ticks — USER_HZ = 100 on this Linux). The comm field may contain spaces and
 * parentheses, so the parse starts after the LAST ')'. PURE (exported for the
 * hermetic test). */
export function parseProcStat(text) {
  if (typeof text !== 'string') return null
  const idx = text.lastIndexOf(')')
  if (idx === -1) return null
  const rest = text.slice(idx + 2).trim().split(/\s+/)
  // rest[0] = field 3 (state) → field N sits at rest[N - 3]; utime = field 14,
  // stime = field 15.
  const utimeTicks = Number(rest[11])
  const stimeTicks = Number(rest[12])
  if (!Number.isFinite(utimeTicks) || !Number.isFinite(stimeTicks)) return null
  return { utimeTicks, stimeTicks, cpuTicks: utimeTicks + stimeTicks }
}

/** The daemon block of a sample (block null when the PID cannot be resolved). */
export function daemonBlock(opts, cachedPid) {
  const found = resolveDaemonPid(opts.profile, cachedPid)
  if (found === null) return { block: null, pid: null }
  const status = parseProcStatus(readProcText(`/proc/${found.pid}/status`) ?? '')
  const stat = parseProcStat(readProcText(`/proc/${found.pid}/stat`) ?? '')
  return {
    pid: found.pid,
    block: {
      unit: opts.unit,
      profile: opts.profile,
      pid: found.pid,
      rssKb: status === null ? null : status.rssKb,
      vmSizeKb: status === null ? null : status.vmSizeKb,
      threads: status === null ? null : status.threads,
      state: status === null ? null : status.state,
      cpuTicks: stat === null ? null : stat.cpuTicks,
    },
  }
}

/** df-compatible disk block of a mount point (portable statfsSync). */
export function diskBlock(mount = '/') {
  const st = statfsSync(mount)
  const totalBytes = st.bsize * st.blocks
  const usedBytes = st.bsize * (st.blocks - st.bfree)
  const availBytes = st.bsize * st.bavail
  const denom = usedBytes + availBytes
  return {
    path: mount,
    totalBytes,
    usedBytes,
    availBytes,
    usedPct: denom > 0 ? Number(((usedBytes / denom) * 100).toFixed(2)) : null,
    inodesUsedPct: st.files > 0 ? Number((((st.files - st.ffree) / st.files) * 100).toFixed(2)) : null,
  }
}

/** Bounded recursive apparent-size walk of a directory: sum of `st.size` (the
 * `du -sb` semantics) with a hard DEADLINE. On deadline the walk stops and
 * reports truncated:true (the caller keeps the last complete measurement
 * instead of writing a partial size as if it were the truth). */
export function dirBytes(dir, deadlineMs = DEFAULT_DIR_WALK_DEADLINE_MS) {
  const started = Date.now()
  let bytes = 0
  let files = 0
  let dirs = 0
  let skipped = 0
  let truncated = false
  const stack = [dir]
  while (stack.length > 0) {
    if (Date.now() - started > deadlineMs) {
      truncated = true
      break
    }
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      skipped++
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      let st
      try {
        st = lstatSync(full)
      } catch {
        skipped++
        continue
      }
      if (st.isDirectory()) {
        dirs++
        stack.push(full)
      } else {
        files++
        bytes += st.size
      }
    }
  }
  return { bytes, files, dirs, skipped, truncated, ms: Date.now() - started }
}

/** Build ONE sample object (the schema documented in the header). Never
 * throws: a failing source degrades to null + an `errors` entry. */
export function collectSample(opts, state = {}) {
  const errors = []
  const started = Date.now()
  const ts = started

  const pressure = readPressure(opts.pressureDir)
  for (const res of pressure.missing) errors.push(`psi.${res}: unreadable`)
  const psi = { cpu: pressure.cpu, io: pressure.io, memory: pressure.memory }
  if (psi.cpu === null && pressure.missing.length === 0) errors.push('psi.cpu: unparseable')
  if (psi.io === null && pressure.missing.length === 0) errors.push('psi.io: unparseable')

  const meminfoText = readProcText('/proc/meminfo')
  if (meminfoText === null) errors.push('meminfo: unreadable')
  const mem = memBlock(meminfoText === null ? {} : parseMeminfo(meminfoText))

  let load = parseLoadavg(readProcText('/proc/loadavg') ?? '')
  if (load === null) {
    errors.push('loadavg: unreadable (fell back to os.loadavg(); runnable/procs null)')
    const os3 = loadavg()
    load = { load1: os3[0], load5: os3[1], load15: os3[2], runnable: null, procs: null }
  }

  let daemon = null
  let daemonPid = Number.isFinite(state.daemonPid) ? state.daemonPid : null
  try {
    const resolved = daemonBlock(opts, daemonPid)
    daemon = resolved.block
    daemonPid = resolved.pid
    if (daemon === null) {
      daemonPid = null
      errors.push(`daemon: no pid for --profile ${opts.profile}`)
    }
  } catch (err) {
    errors.push(`daemon: ${err?.message ?? String(err)}`)
  }

  let disk = null
  try {
    disk = diskBlock('/')
  } catch (err) {
    errors.push(`disk: ${err?.message ?? String(err)}`)
  }

  const now = Date.now()
  let stateDirBlock = state.stateDirBlock ?? null
  const due = stateDirBlock === null || now - stateDirBlock.bytesAt >= opts.dirBytesEverySec * 1000
  if (due) {
    const walk = dirBytes(opts.stateDir, opts.dirWalkDeadlineMs)
    if (walk.truncated) {
      errors.push(`stateDir: walk hit the ${opts.dirWalkDeadlineMs} ms deadline (keeping the last complete size)`)
    } else {
      stateDirBlock = {
        path: opts.stateDir,
        bytes: walk.bytes,
        files: walk.files,
        bytesAt: Date.now(),
        ageSec: 0,
        truncated: false,
        skipped: walk.skipped,
      }
    }
  }

  const nproc = cpus().length
  return {
    sample: {
      v: SAMPLER_SCHEMA_VERSION,
      ts,
      iso: new Date(ts).toISOString(),
      intervalSec: opts.intervalSec,
      uptimeSec: Math.round(uptime()),
      nproc,
      load1: load.load1,
      load5: load.load5,
      load15: load.load15,
      runnable: load.runnable,
      procs: load.procs,
      load1PerCore: nproc > 0 ? Number((load.load1 / nproc).toFixed(3)) : null,
      mem,
      psi,
      daemon,
      disk,
      stateDir:
        stateDirBlock === null
          ? { path: opts.stateDir, bytes: null, files: null, bytesAt: null, ageSec: null, truncated: true, skipped: null }
          : { ...stateDirBlock, ageSec: Math.round((now - stateDirBlock.bytesAt) / 1000) },
      tickMs: Date.now() - started,
      errors,
    },
    daemonPid,
    stateDirBlock,
  }
}

/** Count the lines of a file WITHOUT reading it whole (bounded 256 KiB buffer). */
export function countLines(file) {
  let fd
  try {
    fd = openSync(file, 'r')
  } catch {
    return 0
  }
  try {
    const buf = Buffer.alloc(256 * 1024)
    let lines = 0
    let bytes = 0
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null)
      if (read <= 0) break
      bytes += read
      for (let i = 0; i < read; i++) if (buf[i] === 10) lines++
    }
    if (bytes > 0 && lines === 0) lines = 1
    return lines
  } catch {
    return 0
  } finally {
    closeSync(fd)
  }
}

/** Trim `file` in place to its last `keepLines` lines when it exceeds
 * `maxLines` lines or `maxBytes` bytes. Returns { rotated, lines, keep }.
 * Atomic (tmp + rename), newest rows win, no other file is touched. */
export function rotateIfNeeded(file, { maxLines, keepLines, maxBytes }) {
  if (!existsSync(file)) return { rotated: false, lines: 0, keep: keepLines }
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return { rotated: false, lines: 0, keep: keepLines }
  }
  const overBytes = maxBytes > 0 && size > maxBytes
  const lines = overBytes ? 0 : countLines(file)
  if (!overBytes && lines <= maxLines) return { rotated: false, lines, keep: keepLines }
  const text = readFileSync(file, 'utf8')
  const all = text.split('\n')
  const body = all.length > 0 && all[all.length - 1] === '' ? all.slice(0, all.length - 1) : all
  const kept = body.slice(Math.max(0, body.length - keepLines))
  const tmp = `${file}.tmp`
  writeFileSync(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8')
  renameSync(tmp, file)
  return { rotated: true, lines: body.length, keep: kept.length }
}

/** Parse the CLI into the options object (declared defaults). */
export function parseArgs(argv) {
  const opts = {
    stateDir: '/.deepartments',
    out: null,
    intervalSec: DEFAULT_INTERVAL_SEC,
    once: false,
    force: false,
    quiet: false,
    log: null,
    unit: 'dsh-deepartments-dev',
    profile: 'deepartments-dev',
    pressureDir: '/proc/pressure',
    maxLines: DEFAULT_MAX_LINES,
    keepLines: DEFAULT_KEEP_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
    dirBytesEverySec: DEFAULT_DIR_BYTES_EVERY_SEC,
    dirWalkDeadlineMs: DEFAULT_DIR_WALK_DEADLINE_MS,
    daemonPid: null,
  }
  const takesValue = new Set([
    'state-dir',
    'out',
    'interval',
    'log',
    'unit',
    'profile',
    'pressure-dir',
    'max-lines',
    'keep-lines',
    'max-bytes',
    'dir-bytes-every',
    'dir-walk-deadline',
    'daemon-pid',
  ])
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
    const num = value === null ? NaN : Number(value)
    switch (key) {
      case 'state-dir':
        opts.stateDir = String(value)
        break
      case 'out':
        opts.out = String(value)
        break
      case 'interval':
        opts.intervalSec = num
        break
      case 'once':
        opts.once = true
        break
      case 'force':
        opts.force = true
        break
      case 'quiet':
        opts.quiet = true
        break
      case 'log':
        opts.log = String(value)
        break
      case 'unit':
        opts.unit = String(value)
        break
      case 'profile':
        opts.profile = String(value)
        break
      case 'pressure-dir':
        opts.pressureDir = String(value)
        break
      case 'max-lines':
        opts.maxLines = num
        break
      case 'keep-lines':
        opts.keepLines = num
        break
      case 'max-bytes':
        opts.maxBytes = num
        break
      case 'dir-bytes-every':
        opts.dirBytesEverySec = num
        break
      case 'dir-walk-deadline':
        opts.dirWalkDeadlineMs = num
        break
      case 'daemon-pid':
        opts.daemonPid = num
        break
      default:
        break
    }
  }
  if (!Number.isFinite(opts.intervalSec) || opts.intervalSec < 5 || opts.intervalSec > 600) {
    throw new Error(`--interval must be a number of seconds in [5,600] (got ${opts.intervalSec})`)
  }
  if (!Number.isFinite(opts.maxLines) || !Number.isFinite(opts.keepLines) || opts.keepLines >= opts.maxLines) {
    throw new Error(`--max-lines (${opts.maxLines}) must exceed --keep-lines (${opts.keepLines})`)
  }
  if (!Number.isFinite(opts.dirWalkDeadlineMs) || opts.dirWalkDeadlineMs <= 0) throw new Error('--dir-walk-deadline must be a positive number of ms')
  opts.intervalSec = Math.round(opts.intervalSec)
  opts.maxLines = Math.round(opts.maxLines)
  opts.keepLines = Math.round(opts.keepLines)
  opts.maxBytes = Math.round(opts.maxBytes)
  opts.dirBytesEverySec = Math.round(opts.dirBytesEverySec)
  opts.dirWalkDeadlineMs = Math.round(opts.dirWalkDeadlineMs)
  opts.out = opts.out ?? path.join(opts.stateDir, 'host-health.jsonl')
  opts.log = opts.log ?? `${opts.out}.log`
  return opts
}

/** The pidfile path guarding against a second sampler on the same output. */
export function pidFileFor(out) {
  return `${out}.pid`
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** Print one line to the log (best effort, never fatal) + stderr when not
 * silenced. */
function logLine(opts, message) {
  const line = `${new Date().toISOString()} [host-sampler] ${message}\n`
  try {
    appendFileSync(opts.log, line, 'utf8')
  } catch {
    /* best effort */
  }
  if (!opts.quiet) writeSync(2, line)
}

/** One sampling tick: collect + append + rotate. Returns the sample. */
export function tick(opts, state) {
  const { sample, daemonPid, stateDirBlock } = collectSample(opts, state)
  state.daemonPid = daemonPid
  state.stateDirBlock = stateDirBlock
  mkdirSync(path.dirname(opts.out), { recursive: true })
  appendFileSync(opts.out, `${JSON.stringify(sample)}\n`, 'utf8')
  const rot = rotateIfNeeded(opts.out, { maxLines: opts.maxLines, keepLines: opts.keepLines, maxBytes: opts.maxBytes })
  if (rot.rotated) logLine(opts, `rotated ${opts.out}: ${rot.lines} -> ${rot.keep} lines (caps ${opts.maxLines} lines / ${opts.maxBytes} bytes)`)
  state.ticks = (state.ticks ?? 0) + 1
  if (state.ticks % 100 === 0) {
    const logRot = rotateIfNeeded(opts.log, { maxLines: DEFAULT_LOG_MAX_LINES, keepLines: DEFAULT_LOG_KEEP_LINES, maxBytes: 0 })
    if (logRot.rotated) logLine(opts, `rotated ${opts.log}: ${logRot.lines} -> ${logRot.keep} lines`)
  }
  return sample
}

/** Compact one-line status render (used by the loop log). */
export function renderStatus(sample, ticks) {
  return (
    `tick ${ticks} ts=${sample.iso} load1=${sample.load1} ` +
    `cpu.some60=${sample.psi.cpu?.some?.avg60 ?? 'n/a'} io.some60=${sample.psi.io?.some?.avg60 ?? 'n/a'} ` +
    `mem.some60=${sample.psi.memory?.some?.avg60 ?? 'n/a'} rssKb=${sample.daemon?.rssKb ?? 'n/a'} tickMs=${sample.tickMs}`
  )
}

/** The main entry point: lock, loop (or one shot), clean shutdown. */
export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  mkdirSync(opts.stateDir, { recursive: true })
  mkdirSync(path.dirname(opts.out), { recursive: true })
  const pidFile = pidFileFor(opts.out)
  if (!opts.force && existsSync(pidFile)) {
    const previous = Number(readFileSync(pidFile, 'utf8').trim())
    if (pidAlive(previous)) {
      const message = `another sampler is alive (pid ${previous}, pidfile ${pidFile}) — refusing to double-sample (use --force to override)`
      logLine(opts, message)
      return { ok: false, reason: 'already-running', pid: previous }
    }
    logLine(opts, `stale pidfile ${pidFile} (pid ${previous} is gone) — taking over`)
  }
  writeFileSync(pidFile, `${process.pid}\n`, 'utf8')
  const cleanup = () => {
    try {
      if (existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8').trim()) === process.pid) unlinkSync(pidFile)
    } catch {
      /* best effort */
    }
  }
  process.on('SIGINT', () => {
    logLine(opts, 'SIGINT — stopping')
    cleanup()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    logLine(opts, 'SIGTERM — stopping')
    cleanup()
    process.exit(0)
  })
  process.on('exit', cleanup)

  const state = { daemonPid: opts.daemonPid, stateDirBlock: null, ticks: 0 }
  logLine(
    opts,
    `start pid=${process.pid} out=${opts.out} interval=${opts.intervalSec}s ` +
      `caps=${opts.maxLines} lines/${opts.maxBytes} bytes keep=${opts.keepLines} unit=${opts.unit} profile=${opts.profile}`,
  )

  if (opts.once) {
    const sample = tick(opts, state)
    writeSync(1, `${JSON.stringify(sample, null, 2)}\n`)
    cleanup()
    return { ok: true, once: true, sample }
  }

  // The loop: a drift-free schedule (next = previous + interval) so a slow tick
  // never accumulates drift.
  let next = Date.now()
  for (;;) {
    const sample = tick(opts, state)
    if (state.ticks % 20 === 1) logLine(opts, renderStatus(sample, state.ticks))
    next += opts.intervalSec * 1000
    const wait = next - Date.now()
    await new Promise((resolve) => setTimeout(resolve, wait > 0 ? wait : 0))
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[host-sampler] FATAL ${err?.stack ?? String(err)}\n`)
    process.exit(1)
  })
}
