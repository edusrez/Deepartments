#!/usr/bin/env node
/**
 * dev-health-watch.mjs — vigilante de la CLASE de fallo del 2026-09-16/17 en la
 * instancia Dev (perfil `deepartments-dev`).
 *
 * POR QUÉ EXISTE (medido): el 2026-09-16/17 Dev se degradó sin avisar —
 * `session.list` pasó de 40 s a 279 s y a "sin respuesta", el hilo principal se
 * quedó al 100 % (dos bucles O(n²)/O(n) sobre el ledger de entregas y sobre el log
 * de sesión), el heap V8 tocó su techo (~2,08 GB) y el proceso murió por OOM a las
 * 22:25:51 (8 sesiones mid-turn perdidas). Nada de eso emitía una señal: el GUI se
 * quedaba "cargando" y la org no se enteraba. Este script convierte cada una de
 * esas señales en una línea de salud y en un ALERT cuando cruza el umbral.
 *
 * QUÉ MIDE (todo read-only, sin tocar la instancia):
 *   1. CPU del hilo principal del proceso Dev (delta de /proc/<pid>/stat).
 *   2. Latencia de `/deepartments/presence/get` (la RPC más barata del canal).
 *   3. RSS del proceso y `memory.current` del cgroup del servicio.
 *   4. Tormenta de entregas: filas vs mensajes distintos y backlog `prepared`
 *      sin `delivered`/`terminal` en `deliveries.jsonl`.
 *   5. Tamaño del corpus CALIENTE (`$DSH_HOME/sessions`) — el coste de escaneo.
 *
 * SALIDA: una línea JSON por ejecución en `<stateDir>/dev-health-watch.jsonl`
 * (serie durable) y líneas `ALERT ...` por stderr → journald (para que la salud
 * de la org las vea). Exit code 0 siempre que el script pueda medir; 1 si mide y
 * hay ALERT (para que un `ExecCondition`/timer pueda reaccionar).
 *
 * Uso: node dev-health-watch.mjs [--state-dir /.deepartments] [--home /opt/dsh/.dsh-dev]
 *                               [--unit dsh-deepartments-dev] [--port 3090] [--quiet]
 */
import { readFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, dflt) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1] }
const flag = (name) => argv.includes(name)

const STATE_DIR = arg('--state-dir', '/.deepartments')
const HOME = arg('--home', '/opt/dsh/.dsh-dev')
const UNIT = arg('--unit', 'dsh-deepartments-dev')
const PORT = Number(arg('--port', '3090'))
const QUIET = flag('--quiet')

/** Umbrales (los del incidente: por encima = la clase de fallo que ya nos costó un OOM). */
const LIMITS = {
  mainCpuPct: 85,          // hilo principal saturado de forma sostenida
  rssMb: 3500,             // cerca del techo práctico del heap V8 (~2 GB) + nativos
  cgroupMb: 4200,
  presenceMs: 2000,        // la RPC barata debe responder en ms
  stormRatio: 3,           // filas de entrega por mensaje distinto en 1 h
  preparedBacklog: 25,     // `prepared` sin delivered/terminal…
  backlogStuckMs: 1800000, // …y el más antiguo parado ≥ 30 min (el atasco real, no la cola viva)
  hotSessions: 1000        // coste de escaneo: directorios calientes
}

const now = Date.now()
const alerts = []
const alert = (key, message, value) => { alerts.push({ key, message, value }); if (!QUIET) console.error(`ALERT ${key}: ${message} (valor=${JSON.stringify(value)})`) }

function mainPid() {
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      let cmd = ''
      try { cmd = readFileSync(join('/proc', entry, 'cmdline'), 'utf8') } catch { continue }
      if (cmd.includes('--profile') && cmd.includes('deepartments-dev')) return Number(entry)
    }
  } catch { /* sin /proc legible */ }
  return undefined
}

function cpuTicks(pid) {
  try {
    const stat = readFileSync(join('/proc', String(pid), 'stat'), 'utf8')
    const close = stat.lastIndexOf(')')
    const fields = stat.slice(close + 2).split(' ')
    return Number(fields[11]) + Number(fields[12]) // utime + stime (post-comm)
  } catch { return undefined }
}

function rssMb(pid) {
  try {
    const status = readFileSync(join('/proc', String(pid), 'status'), 'utf8')
    const m = status.match(/VmRSS:\s+(\d+) kB/)
    return m === null ? undefined : Math.round(Number(m[1]) / 1024)
  } catch { return undefined }
}

function cgroupMb() {
  try { return Math.round(Number(readFileSync(`/sys/fs/cgroup/system.slice/${UNIT}.service/memory.current`, 'utf8')) / 1024 / 1024) } catch { return undefined }
}

function countDirs(root) {
  if (!existsSync(root)) return 0
  let n = 0
  for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    try { n += readdirSync(join(root, bucket.name), { withFileTypes: true }).filter((e) => e.isDirectory()).length } catch { /* ignore */ }
  }
  return n
}

function deliveryStats() {
  const path = join(STATE_DIR, 'deliveries.jsonl')
  if (!existsSync(path)) return undefined
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const hourAgo = now - 3600_000
  const rows = []
  for (const line of lines.slice(-8000)) {
    try { const row = JSON.parse(line); if (row.ts >= hourAgo) rows.push(row) } catch { /* ignore */ }
  }
  const ids = new Set(rows.map((r) => r.messageId))
  const prepared = new Map(), resolved = new Set()
  for (const line of lines.slice(-8000)) {
    try {
      const row = JSON.parse(line)
      if (row.status === 'prepared') prepared.set(`${row.messageId}#${row.recipientId}`, row.ts)
      if (row.status === 'delivered' || row.status === 'terminal') resolved.add(`${row.messageId}#${row.recipientId}`)
    } catch { /* ignore */ }
  }
  const backlog = [...prepared.keys()].filter((k) => !resolved.has(k))
  return {
    rowsLastHour: rows.length,
    distinctLastHour: ids.size,
    ratio: ids.size === 0 ? 0 : Number((rows.length / ids.size).toFixed(2)),
    backlog: backlog.length,
    oldestBacklogTs: backlog.length === 0 ? null : Math.min(...backlog.map((k) => prepared.get(k)))
  }
}

async function presenceMs() {
  const started = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(`http://127.0.0.1:${PORT}/deepartments/presence/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'watch', method: 'presence/get', payload: {} }),
      signal: controller.signal
    })
    clearTimeout(timer)
    if (!response.ok) return { ms: Date.now() - started, ok: false, status: response.status }
    await response.text()
    return { ms: Date.now() - started, ok: true, status: response.status }
  } catch (error) {
    return { ms: Date.now() - started, ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

const pid = mainPid()
const sample = { ts: now, unit: UNIT, pid }
if (pid === undefined) {
  alert('dev-down', `el proceso de ${UNIT} no está corriendo`, null)
} else {
  const t0 = cpuTicks(pid)
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const t1 = cpuTicks(pid)
  const cpuPct = t0 === undefined || t1 === undefined ? undefined : Math.round(((t1 - t0) / 100 / 3) * 100)
  sample.mainCpuPct = cpuPct
  sample.rssMb = rssMb(pid)
  sample.cgroupMb = cgroupMb()
  sample.presence = await presenceMs()
  sample.deliveries = deliveryStats()
  sample.hotSessions = countDirs(join(HOME, 'sessions'))
  sample.coldSessions = countDirs(join(HOME, 'sessions-cold'))

  if (cpuPct !== undefined && cpuPct >= LIMITS.mainCpuPct && (sample.presence.ok === false || sample.presence.ms >= LIMITS.presenceMs)) alert('main-thread-saturated', `hilo principal al ${cpuPct}% CON la RPC barata a ${sample.presence.ms} ms — event loop hambriento (la clase de fallo del 09-17)`, { cpuPct, presenceMs: sample.presence.ms })
  if (sample.rssMb !== undefined && sample.rssMb >= LIMITS.rssMb) alert('rss-high', `RSS ${sample.rssMb} MB — cerca del techo de heap (~2 GB) que tumbó Dev el 09-16`, sample.rssMb)
  if (sample.cgroupMb !== undefined && sample.cgroupMb >= LIMITS.cgroupMb) alert('cgroup-high', `cgroup ${sample.cgroupMb} MB`, sample.cgroupMb)
  if (sample.presence.ok === false || sample.presence.ms >= LIMITS.presenceMs) alert('rpc-slow', `presence/get ${sample.presence.ms} ms (ok=${sample.presence.ok}) — event loop bloqueado`, sample.presence.ms)
  if (sample.deliveries !== undefined) {
    if (sample.deliveries.ratio >= LIMITS.stormRatio && sample.deliveries.rowsLastHour >= 20) alert('delivery-storm', `ratio ${sample.deliveries.ratio} filas/mensaje en 1 h (${sample.deliveries.rowsLastHour} filas / ${sample.deliveries.distinctLastHour} mensajes)`, sample.deliveries.ratio)
    if (sample.deliveries.backlog >= LIMITS.preparedBacklog && sample.deliveries.oldestBacklogTs !== null && now - sample.deliveries.oldestBacklogTs >= LIMITS.backlogStuckMs) alert('prepared-backlog', `${sample.deliveries.backlog} pares 'prepared' sin delivered/terminal y el más antiguo lleva ${Math.round((now - sample.deliveries.oldestBacklogTs) / 60000)} min parado`, sample.deliveries.backlog)
  }
  if (sample.hotSessions >= LIMITS.hotSessions) alert('hot-corpus-large', `${sample.hotSessions} sesiones en el root de escaneo — correr scripts/session-cold-tier.mjs`, sample.hotSessions)
}

sample.alerts = alerts.map((a) => a.key)
try { appendFileSync(join(STATE_DIR, 'dev-health-watch.jsonl'), JSON.stringify(sample) + '\n') } catch { /* state dir no escribible: la línea de journal basta */ }
if (!QUIET) console.log(`[dev-health-watch] cpu=${sample.mainCpuPct ?? '-'}% rss=${sample.rssMb ?? '-'}MB cgroup=${sample.cgroupMb ?? '-'}MB presence=${sample.presence?.ms ?? '-'}ms hot=${sample.hotSessions ?? '-'} frio=${sample.coldSessions ?? '-'} alertas=${alerts.length}`)
process.exitCode = alerts.length === 0 ? 0 : 1
