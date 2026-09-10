#!/usr/bin/env node
/**
 * projcache-retention.mjs — bounded retention for the session projection cache
 * (`<DSH_HOME>/storages/session_projcache.json`).
 *
 * WHY THIS EXISTS (measured 2026-09-10, dev instance dsh-deepartments-dev):
 *   The `session-projection-cache` write-behind throttles PER SESSION
 *   (writeEveryEvents / writeIntervalMs), but `dsh-storage-json.publish()`
 *   serializes the WHOLE unit on every single `putRecord` — there is no
 *   coalescing, and the file is pretty-printed (2-space indent). With 2,348
 *   rows and ~9 live sessions the unit was rewritten ~1.8x/second:
 *     2,348 rows -> 7.99 MB -> serialize() = 64.7 ms of MAIN-THREAD block,
 *     ~21.5 MB/s of disk writes (212 GB in 3h36m), p99 latency 1,458 ms.
 *   The cost is O(active_sessions x total_rows), so the cold tail is not free:
 *   2,227 of 2,348 rows were older than a day (median 13.1 days).
 *
 * SAFETY — this loses NO information:
 *   The projcache is a DERIVED fold shortcut ("a fold shortcut, never an
 *   authority" — dshd-core/src/session-cleanup.ts). The source of truth is
 *   `sessions/<bucket>/<id>/session.jsonl.zstd`, which this script NEVER
 *   touches. A dropped row is recomputed from the log on the next cold read
 *   (`coldSnapshot` -> `readFrom(id, 0)` -> write-back). Consequences of
 *   dropping a row, exhaustively:
 *     - the session still APPEARS in `session.list` — `summarizeCold` falls
 *       back to the persistence header, and
 *       `sessionListUpdatedAt(header, undefined) = header.createdAt`;
 *     - its list position falls back to createdAt instead of `lastPromptAt`,
 *       which is why the default retention window is measured on LAST ACTIVITY:
 *       anything touched inside the window keeps its exact ordering;
 *     - opening it re-reads the log once and re-adds the row.
 *   NON-SESSION KEYS ARE ALWAYS PRESERVED, unconditionally: the
 *   `deepartments-room-*` rows are NOT session ids, have no session log, and
 *   are therefore NOT reconstructible. Dropping them WOULD lose information.
 *
 * CRITICAL OPERATIONAL NOTE — run it with the service STOPPED:
 *   `dsh-storage-json` loads the whole unit into memory at boot
 *   (`this.state.tables`) and serializes THAT on every publish. Deleting rows
 *   from the file while the server is running is undone within one throttle
 *   interval (<5 s by default): the in-memory rows are rewritten verbatim.
 *   This is why the sanctioned flow is stop -> prune -> start, and why a plain
 *   restart alone does NOT shrink the file (the boot `runSleepCleanup` is
 *   selective — it only acts on hosts holding a pending cleanup flag).
 *
 * USAGE
 *   node scripts/projcache-retention.mjs --projcache <path> [options]
 *     --projcache <path>   Path to session_projcache.json (required).
 *     --state-dir <dir>    Deepartments stateDir; sessions referenced by
 *                          hosts.json/posts.json are ALWAYS kept. Optional.
 *     --retain-days <n>    Keep rows whose last activity is within n days
 *                          (default 7). 0 = keep only non-session keys.
 *     --apply              EXECUTE. WITHOUT it: dry-run (report only).
 *     --no-backup          Skip the pre-write backup (NOT recommended).
 *     --help               This text.
 *
 * EXIT CODES: 0 ok; 1 usage error; 2 real error.
 */

import { readFile, writeFile, rename, rm, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SESSION_PREFIXES = ['session-', 'worker-', 'head-', 'host-']

function usage(stream = process.stdout) {
  const text = `Usage: node scripts/projcache-retention.mjs --projcache <path> [options]
  --projcache <path>   Path to session_projcache.json (required).
  --state-dir <dir>    Deepartments stateDir (hosts.json/posts.json); sessions
                       referenced there are ALWAYS kept. Optional.
  --retain-days <n>    Keep rows with last activity within n days (default 7).
  --apply              EXECUTE. WITHOUT it: dry-run only.
  --no-backup          Skip the pre-write backup.
  --help               This text.

Dropping a row loses NO conversation data: the projcache is a derived fold
shortcut and the row is recomputed from the session log on the next cold read.
Non-session keys (deepartments-room-*) are ALWAYS preserved.

Run with the DSH service STOPPED: the running server holds the unit in memory
and rewrites pruned rows within one throttle interval.
`
  stream.write(text)
}

function parseArgs(argv) {
  const opts = { projcache: undefined, stateDir: undefined, retainDays: 7, apply: false, backup: true }
  const next = () => {
    const v = argv[++i]
    if (v === undefined) { usage(process.stderr); process.exit(1) }
    return v
  }
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { usage(); process.exit(0) }
    else if (a === '--projcache') opts.projcache = next()
    else if (a === '--state-dir') opts.stateDir = next()
    else if (a === '--retain-days') {
      const n = Number(next())
      if (!Number.isFinite(n) || n < 0) { usage(process.stderr); process.exit(1) }
      opts.retainDays = n
    }
    else if (a === '--apply') opts.apply = true
    else if (a === '--no-backup') opts.backup = false
    else { process.stderr.write(`unknown option: ${a}\n`); usage(process.stderr); process.exit(1) }
  }
  if (!opts.projcache) { process.stderr.write('--projcache is required\n'); usage(process.stderr); process.exit(1) }
  return opts
}

const isSessionKey = (k) => UUID_RE.test(k) || SESSION_PREFIXES.some((p) => k.startsWith(p))

/** Best-effort "last activity" for a cache row, mirroring the fields the
 *  projection writes. Falls back to the bound log identity's createdAt. */
function lastActivity(row) {
  const r = row?.rows ?? {}
  const paths = [
    ['sessionStats', 'state', 'updatedAt'],
    ['sessionStats', 'state', 'lastActivityAt'],
    ['sessionListMetadata', 'state', 'lastPromptAt'],
    ['sessionStats', 'state', 'createdAt'],
  ]
  for (const path of paths) {
    let cur = r
    for (const p of path) {
      cur = cur && typeof cur === 'object' ? cur[p] : undefined
      if (cur === undefined) break
    }
    if (typeof cur === 'number' && cur > 0) return cur
  }
  const created = row?.identity?.createdAt
  return typeof created === 'number' && created > 0 ? created : undefined
}

/** Session ids referenced by the org registry — never dropped even if idle. */
async function referencedSessionIds(stateDir) {
  const ids = new Set()
  if (!stateDir) return ids
  for (const file of ['hosts.json', 'posts.json']) {
    const p = join(stateDir, file)
    if (!existsSync(p)) continue
    try {
      const doc = JSON.parse(await readFile(p, 'utf8'))
      const walk = (node) => {
        if (node === null || typeof node !== 'object') return
        if (Array.isArray(node)) { for (const n of node) walk(n); return }
        for (const [k, v] of Object.entries(node)) {
          if (k === 'sessionId' && typeof v === 'string') ids.add(v)
          else if (k === 'session' && typeof v === 'string') ids.add(v)
          else walk(v)
        }
      }
      walk(doc)
    } catch { /* unreadable registry — ignore, retention still applies */ }
  }
  return ids
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const path = opts.projcache

  let data
  try {
    data = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    process.stderr.write(`projcache unreadable: ${error.message}\n`)
    process.exit(2)
  }
  const sessions = data?.tables?.sessions
  if (sessions === undefined || typeof sessions !== 'object' || sessions === null) {
    process.stderr.write('projcache has no tables.sessions object — refusing to write\n')
    process.exit(2)
  }

  const referenced = await referencedSessionIds(opts.stateDir)
  const now = Date.now()
  const cutoff = now - opts.retainDays * 86_400_000

  const drop = []
  let keptSpecial = 0
  let keptRecent = 0
  let keptReferenced = 0
  const droppedByAge = []

  for (const [key, row] of Object.entries(sessions)) {
    if (!isSessionKey(key)) { keptSpecial++; continue }          // rooms: NEVER drop
    if (referenced.has(key)) { keptReferenced++; continue }      // live registry
    const t = lastActivity(row)
    if (t === undefined || t >= cutoff) { keptRecent++; continue }
    drop.push(key)
    droppedByAge.push(((now - t) / 86_400_000))
  }

  const bytesOf = (keys) => keys.reduce((n, k) => n + Buffer.byteLength(JSON.stringify(sessions[k])), 0)
  const keptKeys = Object.keys(sessions).filter((k) => !drop.includes(k))
  const beforeBytes = Buffer.byteLength(JSON.stringify(data, null, 2))

  process.stdout.write(
    `projcache : ${path}\n` +
    `rows      : ${Object.keys(sessions).length} -> ${keptKeys.length}  (dropping ${drop.length})\n` +
    `  kept    : ${keptSpecial} non-session (rooms, ALWAYS) + ${keptReferenced} registry-referenced + ${keptRecent} within ${opts.retainDays}d\n` +
    `  dropped : ${drop.length} rows older than ${opts.retainDays}d\n` +
    `policy    : retain-days=${opts.retainDays}${opts.stateDir ? ` state-dir=${opts.stateDir}` : ''}\n`
  )
  if (droppedByAge.length > 0) {
    droppedByAge.sort((a, b) => a - b)
    const p = (q) => droppedByAge[Math.min(droppedByAge.length - 1, Math.floor(droppedByAge.length * q))].toFixed(1)
    process.stdout.write(`  dropped age days: p10=${p(0.1)} median=${p(0.5)} p90=${p(0.9)} max=${droppedByAge.at(-1).toFixed(1)}\n`)
  }
  process.stdout.write(
    `size      : ${(beforeBytes / 1048576).toFixed(2)} MB -> ~${(bytesOf(keptKeys) / 1048576).toFixed(2)} MB compact` +
    ` (pretty-printed ~${(bytesOf(keptKeys) * 2.15 / 1048576).toFixed(2)} MB; serialize ~${(bytesOf(keptKeys) / 1048576 * 17.4).toFixed(0)} ms)\n`
  )

  if (drop.length === 0) { process.stdout.write('nothing to do.\n'); return }
  if (!opts.apply) {
    process.stdout.write('\nDRY RUN — no changes written. Re-run with --apply to execute.\n')
    return
  }

  if (opts.backup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const bak = `${path}.bak-retention-${stamp}`
    await copyFile(path, bak)
    process.stdout.write(`backup    : ${bak}\n`)
  }

  for (const key of drop) delete sessions[key]

  // Preserve the storage backend's on-disk format exactly:
  // `JSON.stringify(document, null, 2)` + trailing newline (dsh-storage-json
  // serialize()). `unit` is carried through untouched so the version/name
  // header still validates on open.
  const tmp = `${path}.retention-${process.pid}-${Date.now().toString(36)}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  try {
    await rename(tmp, path)
  } catch (error) {
    try { await rm(tmp, { force: true }) } catch { /* ignore */ }
    throw error
  }
  process.stdout.write(`applied   : ${drop.length} rows dropped, written atomically\n`)
}

main().catch((error) => {
  process.stderr.write(`error: ${error?.stack ?? String(error)}\n`)
  process.exit(2)
})
