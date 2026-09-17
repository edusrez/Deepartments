#!/usr/bin/env node
/**
 * cold-tier.mjs — mueve (NUNCA borra) las sesiones frías fuera del root de escaneo
 * de un DSH_HOME, para que `session.list` / `SessionCorpus.load` dejen de recorrer
 * miles de directorios.
 *
 * Política: NO borrar, NO comprimir (comprimir no reduce el número de directorios,
 * que es lo que cuesta). Sólo se MUEVE dentro del mismo filesystem (rename atómico)
 * a `<home>/sessions-cold/<bucket>/<id>/`, dejando un manifiesto JSONL reversible y
 * un modo `--restore <id>` para devolver una sesión al tier caliente.
 *
 * Criterio de KEEP (todo lo demás se MUEVE):
 *   - host VIVO (hosts.json sin retired), o
 *   - registrada en un workspace y NO archivada (visible en el sidebar), o
 *   - citada por el estado activo de la org (posts.json, hosts.json y los *-state.json
 *     de /.deepartments), o
 *   - log tocado dentro de --hot-hours (por defecto 36), o
 *   - entre las --min-per-bucket más recientes de su bucket (por defecto 25).
 *
 * Uso:
 *   node cold-tier.mjs --dry-run [--home DIR] [--state DIR] [--hot-hours N] [--limit N]
 *   node cold-tier.mjs --apply   [--manifest FILE] ...
 *   node cold-tier.mjs --rollback FILE
 *   node cold-tier.mjs --restore <id|uuid>
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, dflt) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1] }
const flag = (name) => argv.includes(name)
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const uuidOf = (name) => { const m = String(name).match(UUID); return m === null ? null : m[m.length - 1] }

const HOME = arg('--home', '/opt/dsh/.dsh-dev')
const STATE = arg('--state', '/.deepartments')
const HOT_HOURS = Number(arg('--hot-hours', '36'))
const MIN_PER_BUCKET = Number(arg('--min-per-bucket', '25'))
const LIMIT = arg('--limit', undefined) === undefined ? Infinity : Number(arg('--limit'))
const APPLY = flag('--apply')
const DRY = !APPLY
const ROLLBACK = arg('--rollback', undefined)
const RESTORE = arg('--restore', undefined)
const SESSIONS = join(HOME, 'sessions')
const COLD = join(HOME, 'sessions-cold')
const TS = new Date().toISOString().replace(/[:.]/g, '-')
const MANIFEST = arg('--manifest', join(HOME, 'storages', `sessions-cold-tier-${TS}.jsonl`))

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }

function loadRegistry() {
  const ws = readJson(join(HOME, 'storages', 'workspace.json'), {})
  const registered = new Set()
  const archived = new Set(ws?.global?.archivedSessionIds ?? [])
  for (const w of Object.values(ws?.tables?.workspaces ?? {})) for (const id of w.sessionIds ?? []) registered.add(id)
  return { registered, archived }
}

function loadHosts() {
  const h = readJson(join(STATE, 'hosts.json'), {})
  const all = new Set(), live = new Set()
  for (const [key, value] of Object.entries(h)) {
    if (key === 'schemaVersion' || !value || typeof value !== 'object') continue
    if (typeof value.sessionId === 'string') { all.add(value.sessionId); if (value.retired !== true) live.add(value.sessionId) }
  }
  return { all, live }
}

/** UUIDs citados por el estado activo de la org (roster, misiones, interrupciones…). */
function loadReferenced() {
  const referenced = new Set()
  let names = []
  try { names = readdirSync(STATE) } catch { return referenced }
  for (const name of names) {
    if (!/^(posts\.json|.*-state\.json|hosts\.json)$/.test(name)) continue
    let text = ''
    try { text = readFileSync(join(STATE, name), 'utf8') } catch { continue }
    for (const m of text.match(UUID) ?? []) referenced.add(m)
  }
  return referenced
}

function sessionDirs() {
  const out = []
  let buckets = []
  try { buckets = readdirSync(SESSIONS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return out }
  for (const bucket of buckets) {
    let entries = []
    try { entries = readdirSync(join(SESSIONS, bucket), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { continue }
    for (const id of entries) {
      const dir = join(SESSIONS, bucket, id)
      let log = null
      for (const suffix of ['.jsonl.zstd', '.jsonl']) {
        const candidate = join(dir, `session${suffix}`)
        if (existsSync(candidate)) { log = candidate; break }
      }
      if (log === null) continue
      let st
      try { st = statSync(log) } catch { continue }
      out.push({ bucket, id, uuid: uuidOf(id), dir, log, bytes: st.size, mtime: st.mtimeMs })
    }
  }
  return out
}

function restore(target) {
  const uuid = uuidOf(target) ?? target
  const rows = []
  const scan = (base) => {
    let buckets = []
    try { buckets = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return }
    for (const bucket of buckets) {
      for (const id of readdirSync(join(base, bucket))) if (uuidOf(id) === uuid) rows.push({ bucket, id, src: join(base, bucket, id) })
    }
  }
  scan(COLD)
  if (rows.length === 0) { console.error(`no encontrada en el tier frío: ${target}`); process.exitCode = 1; return }
  for (const row of rows) {
    const dst = join(SESSIONS, row.bucket, row.id)
    if (existsSync(dst)) { console.log(`ya está en caliente: ${dst}`); continue }
    mkdirSync(dirname(dst), { recursive: true })
    renameSync(row.src, dst)
    console.log(`restaurada: ${row.id} -> ${dst}`)
  }
}

function rollback(manifestPath) {
  const lines = readFileSync(manifestPath, 'utf8').trim().split('\n').filter(Boolean)
  let ok = 0, skipped = 0, failed = 0
  for (const line of lines.reverse()) {
    let row
    try { row = JSON.parse(line) } catch { failed++; continue }
    if (!existsSync(row.dst)) { skipped++; continue }
    if (existsSync(row.src)) { console.error(`SKIP (destino ocupado): ${row.src}`); failed++; continue }
    try { mkdirSync(dirname(row.src), { recursive: true }); renameSync(row.dst, row.src); ok++ }
    catch (error) { console.error(`FALLO rollback ${row.id}: ${error.message}`); failed++ }
  }
  console.log(`rollback: restauradas=${ok} saltadas=${skipped} fallidas=${failed}`)
  process.exitCode = failed === 0 ? 0 : 1
}

if (RESTORE !== undefined) {
  restore(RESTORE)
} else if (ROLLBACK !== undefined) {
  rollback(ROLLBACK)
} else {
  const { registered, archived } = loadRegistry()
  const { all: hostAll, live: hostLive } = loadHosts()
  const referenced = loadReferenced()
  const now = Date.now()
  const hotCut = now - HOT_HOURS * 3600_000

  const rows = sessionDirs()
  // margen de seguridad: las N más recientes de cada bucket se quedan siempre
  const recentByBucket = new Map()
  for (const row of [...rows].sort((a, b) => b.mtime - a.mtime)) {
    const list = recentByBucket.get(row.bucket) ?? []
    if (list.length < MIN_PER_BUCKET) { list.push(row.id); recentByBucket.set(row.bucket, list) }
  }

  const plan = []
  for (const row of rows) {
    const isRegistered = [...registered].some((id) => uuidOf(id) === row.uuid)
    const isArchived = [...archived].some((id) => uuidOf(id) === row.uuid)
    let keep = null
    if (hostLive.has(row.id) || [...hostLive].some((id) => uuidOf(id) === row.uuid)) keep = 'host-vivo'
    else if (isRegistered && !isArchived) keep = 'registrada-visible'
    else if (row.uuid !== null && referenced.has(row.uuid)) keep = 'citada-por-la-org'
    else if (row.mtime >= hotCut) keep = `reciente(<${HOT_HOURS}h)`
    else if (recentByBucket.get(row.bucket)?.includes(row.id)) keep = `top${MIN_PER_BUCKET}-del-bucket`
    plan.push({ ...row, action: keep === null ? 'MOVE' : 'KEEP', reason: keep ?? (isArchived ? 'archivada' : isRegistered ? 'archivada+registrada' : 'huerfana-antigua') })
  }

  const moving = plan.filter((r) => r.action === 'MOVE')
  const keeping = plan.filter((r) => r.action === 'KEEP')
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`
  const byReason = {}, byBucket = {}
  for (const r of keeping) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1
  for (const r of moving) byBucket[r.bucket] = (byBucket[r.bucket] ?? 0) + 1

  console.log(`home=${HOME}  hot-hours=${HOT_HOURS}  min-por-bucket=${MIN_PER_BUCKET}  modo=${DRY ? 'DRY-RUN' : 'APPLY'}`)
  console.log(`sesiones con log: ${plan.length}  |  KEEP: ${keeping.length} (${mb(keeping.reduce((a, r) => a + r.bytes, 0))})  |  MOVE: ${moving.length} (${mb(moving.reduce((a, r) => a + r.bytes, 0))})`)
  console.log('KEEP por motivo:', JSON.stringify(byReason))
  console.log('MOVE por bucket:', JSON.stringify(byBucket))
  if (moving.length > 0) {
    console.log(`MOVE rango de mtime: ${new Date(Math.min(...moving.map((r) => r.mtime))).toISOString()} .. ${new Date(Math.max(...moving.map((r) => r.mtime))).toISOString()}`)
    console.log(`primeros 5 MOVE: ${moving.slice(0, 5).map((r) => r.id).join(', ')}`)
  }

  if (DRY) {
    console.log('\n(DRY-RUN: no se movió nada. Manifiesto NO escrito.)')
  } else {
    mkdirSync(dirname(MANIFEST), { recursive: true })
    let done = 0, failed = 0, movedBytes = 0
    for (const row of moving.slice(0, LIMIT)) {
      const dst = join(COLD, row.bucket, row.id)
      if (existsSync(dst)) { console.error(`SKIP (ya existe): ${dst}`); failed++; continue }
      try {
        mkdirSync(dirname(dst), { recursive: true })
        renameSync(row.dir, dst)
        if (!existsSync(join(dst, row.log.split('/').pop()))) throw new Error('log ausente tras el rename')
        appendFileSync(MANIFEST, JSON.stringify({ id: row.id, bucket: row.bucket, src: row.dir, dst, bytes: row.bytes, mtime: row.mtime, reason: row.reason, ts: Date.now() }) + '\n')
        done++; movedBytes += row.bytes
      } catch (error) { console.error(`FALLO ${row.id}: ${error.message}`); failed++ }
    }
    console.log(`\nAPPLY: movidas=${done} (${mb(movedBytes)}) fallidas=${failed}  manifiesto=${MANIFEST}`)
    console.log(`rollback: node ${process.argv[1]} --rollback ${MANIFEST}`)
    console.log(`restaurar una: node ${process.argv[1]} --restore <uuid>`)
    process.exitCode = failed === 0 ? 0 : 1
  }
}
