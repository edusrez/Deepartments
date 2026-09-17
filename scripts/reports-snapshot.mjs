#!/usr/bin/env node
/**
 * reports-snapshot.mjs — round-bounded snapshot + integrity manifest for the
 * agent-report directory `.dsh/reports/` (the house report convention writes
 * every agent deliverable there, and `.gitignore:2` ignores it: measured
 * 2026-09-17 = 1,618 files / 31 MB / NO version control / NO `git checkout`
 * to bring any of it back).
 *
 * WHY THIS EXISTS
 *   The reports tree is the house deliverable path ("agents → `.dsh/reports/
 *   <agent>/<date>-<slug>.md`") and it is UNVERSIONED. On 2026-09-17 an
 *   already-committed file vanished from the working tree (it survived by six
 *   seconds of margin): over a file git tracks there is a net, over an IGNORED
 *   file there is NO NET AT ALL.
 *
 * WHAT IT DOES — ONE ROUND = ONE SNAPSHOT
 *   Copies the whole source tree into `<dest>/rounds/<round>/` and writes a
 *   manifest `{path, bytes, md5}` of the ORIGIN, plus the total count of the
 *   origin. Retention is declared IN ROUNDS (`--rounds`, default 7) — the unit
 *   that matters, because one round is one full copy of the tree.
 *
 * THE LAW THIS SCRIPT OBEYS — A CONTROL MUST NOT SHARE ITS DESTINATION WITH
 * WHAT IT CONTROLS (neither the CALCULATION nor the LOCATION)
 *   CALCULATION: the md5 is computed on the ORIGIN **and** on the COPY and the
 *   two are COMPARED. A manifest computed over the copy matches BY
 *   CONSTRUCTION even when the copy is crooked — that is a tautology, not a
 *   control.
 *   LOCATION: the manifest does NOT live inside the snapshot; it goes to a
 *   THIRD SITE — (1) stdout (the job journal of the scheduler), (2) the
 *   department reports dir OUTSIDE the repo (`--manifest-mirror`). A copy is
 *   ALSO kept at `<dest>/manifests/<round>.json` (outside the round dir) for
 *   operator convenience, but `--verify` reads the MANIFEST ARGUMENT — the
 *   external mirror by default — never that convenience copy.
 *
 * THE TWO VERDICTS THAT MUST NEVER BE MIXED
 *   FAILED  = md5(origin) != md5(copy) while the ORIGIN HELD STILL, or present
 *             at the origin and absent in the copy, or the count did not add up.
 *             ONLY THIS INVALIDATES THE ROUND.
 *   MODIFIED DURING THE WINDOW is NOT a failure: a report written while the
 *   snapshot runs is perfectly captured if its copy is intact. A file that
 *   changes mid-capture is RE-READ (up to MAX_CAPTURE_ATTEMPTS); one that never
 *   holds still is captured anyway and reported as `unstable` — the snapshot of
 *   a directory the agents WRITE TO is a PHOTOGRAPH OF A MOVING SUBJECT: the
 *   window is DECLARED (`{snapshotados, modificados-en-la-ventana, fallidos}`)
 *   but it never fails the round — a control that cries over normal activity
 *   gets switched off, and that is how alerts die.
 *
 * USAGE
 *   node scripts/reports-snapshot.mjs [options]
 *     --source <dir>            Source tree (default: <repo>/.dsh/reports).
 *     --dest <dir>              Snapshot root (default:
 *                               /home/esuarez/projects/.dsh-reports-backups).
 *     --rounds <n>              Rounds to KEEP, newest first (default 7; >=1).
 *     --manifest-mirror <dir>   Third site for the manifest (default: the IPD
 *                               reports dir OUTSIDE the repo).
 *     --quiet                   Only the machine `ROUND-JSON:` line.
 *     --verify <manifest|round|latest>
 *                               RESTORE-VERIFY mode: bring N files back from a
 *                               snapshot into a temporary directory and compare
 *                               their md5 against the manifest.
 *     --verify-sample <n>       Files to restore (default 25; 0 = all, i.e. the
 *                               COMPLETE restore proof the job orders ONCE A DAY).
 *     --restore-dir <dir>       Restore scratch root (default:
 *                               /home/esuarez/projects/.dsh-reports-restore,
 *                               OUTSIDE both the repo and the snapshot dest; the
 *                               per-run temp dir is removed after the check).
 *     --help                    This text.
 *
 * THE BANDS (the two counts that used to share one name)
 *   origin@scan  = the PRE-loop walk (`sourceAtScan`): the population the copy
 *                  loop enumerated. This is the band the accounting guard judges.
 *   origin@open  = the POST-loop walk (`originAtOpen`), a DIFFERENT band one
 *                  window later; it used to be served UNDER the name
 *                  `sourceAtScan` (measured 2026-09-17: `const sourceAtScan =
 *                  atOpen`), so a normal write of the house between the scan and
 *                  the open read as a `count-mismatch` — verdict FAILED + exit 1
 *                  on a round whose own artifact declared that very class
 *                  "REPORTED, NOT A FAILURE".
 *   Letting a file appear after the scan is therefore DECLARED, never fatal; any
 *   difference the script cannot NAME still fails the round (the guard absorbs
 *   only movement it reports: appeared-not-captured and vanished-before-open).
 *
 * THE REACH OF THE NET IS A MEASURED FIELD, NOT A SENTENCE
 *   `redundancy` carries the real sites of the round (origin, round copy,
 *   manifest mirror), each site's device id read from the mounts, `deviceIds`,
 *   `sameDeviceAll` and `offMachine`. On a single-machine deployment every site
 *   shares ONE device id ⇒ ONE failure domain: the net survives `rm`, a bad edit
 *   and `git checkout`, and does NOT survive the loss of the disk. A copy
 *   outside the machine is an OWNER decision, declared as such.
 *
 * RECOVERY WINDOW: `--rounds 7` with a 6-hourly run ≈ 42 h of history — a file
 * lost more than ~42 h ago is NOT recoverable from this net.
 *
 * EXIT CODES: 0 = round COMPLETE (or restore-verify all matched);
 *             1 = FAILED (integrity / accounting / restore mismatch);
 *             2 = usage or environment error (e.g. source missing/empty).
 *
 * HYGIENE: read-only on the SOURCE (never writes, deletes or moves anything
 * there); the ONLY destructive operation is the retention of THIS script's own
 * older rounds inside its own `--dest` (+ its own mirror manifests). Never
 * commits anything.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'

const REPO_ROOT = '/home/esuarez/projects/deepartments'
const DEFAULT_SOURCE = join(REPO_ROOT, '.dsh', 'reports')
const DEFAULT_DEST = '/home/esuarez/projects/.dsh-reports-backups'
const DEFAULT_MIRROR = '/root/.deepartments/departments/internal-programming/reports/builder'
const DEFAULT_RESTORE_ROOT = '/home/esuarez/projects/.dsh-reports-restore'
const ROUND_RE = /^\d{8}T\d{6}Z(?:-\d+)?$/
const MIRROR_RE = /^(\d{4}-\d{2}-\d{2})-reports-snapshot-manifest-(\d{8}T\d{6}Z(?:-\d+)?)\.json$/
/** Capture attempts per file: a file that MOVES between md5(origin) and the
 * copy is re-read (a moving subject is normal here); a STABLE origin with a
 * divergent copy is a hard failure on the first attempt. */
const MAX_CAPTURE_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    source: DEFAULT_SOURCE,
    dest: DEFAULT_DEST,
    rounds: 7,
    mirror: DEFAULT_MIRROR,
    verify: undefined,
    verifySample: 25,
    restoreRoot: DEFAULT_RESTORE_ROOT,
    quiet: false
  }
  const need = (i, flag) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} requires a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--source') opts.source = need(i++, '--source')
    else if (a === '--dest') opts.dest = need(i++, '--dest')
    else if (a === '--manifest-mirror') opts.mirror = need(i++, '--manifest-mirror')
    else if (a === '--rounds') opts.rounds = Number(need(i++, '--rounds'))
    else if (a === '--verify') opts.verify = need(i++, '--verify')
    else if (a === '--verify-sample') opts.verifySample = Number(need(i++, '--verify-sample'))
    else if (a === '--restore-dir') opts.restoreRoot = need(i++, '--restore-dir')
    else if (a === '--quiet') opts.quiet = true
    else throw new UsageError(`unknown argument: ${a}`)
  }
  for (const k of ['source', 'dest', 'mirror', 'restoreRoot']) opts[k] = resolve(opts[k])
  if (!Number.isInteger(opts.rounds) || opts.rounds < 1) throw new UsageError('--rounds must be an integer >= 1')
  if (!Number.isInteger(opts.verifySample) || opts.verifySample < 0) throw new UsageError('--verify-sample must be an integer >= 0')
  return opts
}

class UsageError extends Error {}

function iso(d) {
  return d.toISOString()
}

/** `20260917T171500Z` — UTC, second resolution (deterministic given the clock). */
function roundStamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function roundDate(round) {
  return `${round.slice(0, 4)}-${round.slice(4, 6)}-${round.slice(6, 8)}`
}

function bytes(n) {
  return `${n} (${(n / 1048576).toFixed(2)} MiB)`
}

async function md5File(path) {
  const h = createHash('md5')
  const s = createReadStream(path, { highWaterMark: 1 << 20 })
  for await (const chunk of s) h.update(chunk)
  return h.digest('hex')
}

async function sha256File(path) {
  const h = createHash('sha256')
  const s = createReadStream(path, { highWaterMark: 1 << 20 })
  for await (const chunk of s) h.update(chunk)
  return h.digest('hex')
}

/** Deterministic recursive walk: sorted names, relative posix-ish paths. */
async function walk(dir, base = dir, out = []) {
  const ents = await readdir(dir, { withFileTypes: true })
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of ents) {
    const abs = join(dir, e.name)
    const rel = relative(base, abs)
    if (e.isDirectory()) {
      await walk(abs, base, out)
    } else if (e.isFile()) {
      out.push({ rel, abs, kind: 'file' })
    } else {
      out.push({ rel, abs, kind: e.isSymbolicLink() ? 'symlink' : 'other' })
    }
  }
  return out
}

async function statOrUndefined(path) {
  try {
    const st = await stat(path)
    // `dev` is carried through deliberately: it is the device id read off the
    // REAL mount, the measurement the redundancy field is built from. Keeping it
    // costs nothing and stops the redundancy block from re-stat'ing the tree.
    return { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, mode: st.mode }
  } catch {
    return undefined
  }
}

async function listDirs(path) {
  try {
    const ents = await readdir(path, { withFileTypes: true })
    return ents.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// REDUNDANCY — MEASURED, not narrated
// ---------------------------------------------------------------------------
/**
 * The reach of the net as a REFUTABLE FIELD, never as prose. `offMachine` is
 * DERIVED from the measured device ids (a copy on the same device id as any
 * other site is not a second failure domain), so the sentence that overstates
 * the net is now CONTRADICTED by the artifact instead of being readable
 * selectively: `sites: 3` is refuted by showing two of them share a `deviceId`,
 * and `offMachine: false` is refuted by exhibiting a copy on another machine
 * (a device id absent from `mounts`). Every number here is read off the real
 * mounts at the moment of the round; when a probe fails the block degrades
 * LOUDLY (`probe.errors`) and `sourcesVerified` drops below `sites` — it never
 * silently claims a site it did not measure.
 */
export function parseMounts(procMountsText) {
  const out = []
  for (const line of procMountsText.split('\n')) {
    const f = line.split(' ').filter((s) => s !== '')
    if (f.length < 4) continue
    out.push({ device: f[0], mount: f[1].replace(/\\040/g, ' '), fs: f[2] })
  }
  return out
}

/** The device id of a path's containing directory (the directory that would
 * HOLD the file): a path that exists is stat'd directly, a path that does not
 * yet exist is stat'd through its existing ancestor. `deviceId` is the raw
 * `st.dev` read from the real mount, so two paths are on the same device IFF
 * their ids are equal — refutable by the reader with a single `stat`. */
export async function deviceIdOf(path) {
  let p = path
  for (let i = 0; i < 64; i++) {
    const st = await statOrUndefined(p)
    if (st !== undefined && typeof st.dev === 'number') return { deviceId: st.dev, probed: p }
    const parent = dirname(p)
    if (parent === p) break
    p = parent
  }
  return { deviceId: null, probed: path }
}

export async function measureRedundancy(paths, label) {
  const probe = { ok: true, errors: [] }
  const sites = []
  for (const p of paths) {
    const entry = { label: label(p), path: p, deviceId: null, fs: null, mount: null }
    try {
      const dev = await deviceIdOf(resolve(p))
      entry.deviceId = dev.deviceId
      entry.probedVia = dev.probed
    } catch (err) {
      probe.ok = false
      probe.errors.push(`stat failed: ${p}: ${err && err.message ? err.message : err}`)
    }
    let mounts = []
    try {
      mounts = parseMounts(execFileSync('cat', ['/proc/mounts'], { encoding: 'utf8' }))
      const m = mounts.filter((x) => x.mount !== '/').sort((a, b) => b.mount.length - a.mount.length).find((x) => resolve(p) === resolve(x.mount) || resolve(p).startsWith(resolve(x.mount) + '/'))
      const root = m === undefined ? mounts.find((x) => x.mount === '/') : m
      entry.fs = root?.fs ?? null
      entry.mount = root?.mount ?? null
    } catch (err) {
      probe.ok = false
      probe.errors.push(`/proc/mounts unreadable: ${err && err.message ? err.message : err}`)
    }
    try {
      const df = execFileSync('df', ['-P', resolve(p)], { encoding: 'utf8' }).split('\n')
      const row = df.length >= 2 ? df[1].trim().split(/\s+/) : []
      entry.fsFromDf = row[0] ?? null
      entry.mountFromDf = row[5] ?? null
      if (row[0] === undefined || row[5] === undefined) probe.errors.push(`df row unparsable for ${p}`)
    } catch (err) {
      entry.fsFromDf = null
      entry.mountFromDf = null
      probe.errors.push(`df failed (path not created yet, or unreadable): ${p}: ${err && err.message ? err.message.split('\n')[0] : err}`)
    }
    sites.push(entry)
  }
  const ids = sites.map((s) => s.deviceId)
  const known = ids.filter((d) => d !== null)
  const deviceIds = [...new Set(known)]
  // offMachine is TRUE only when a site sits on a device id the CURRENT round
  // measured as NOT one of this machine's own bands (see LABELED_LOCAL_DEVICES,
  // filled below from the source+dest measurements): an artifact can only refute
  // "off-machine" with a measurement, never with a sentence — so the flag is
  // false on a single-machine deployment and the failure-domain claim is carried
  // by the device ids, which ARE refutable.
  const offMachine = known.some((d) => LABELED_LOCAL_DEVICES.size > 0 && !LABELED_LOCAL_DEVICES.has(d))
  const sameDeviceAll = known.length > 0 && deviceIds.length === 1
  const file = {
    sites: sites.length,
    measuredSites: known.length,
    sameDeviceAll,
    offMachine,
    deviceIds,
    distinctDeviceIds: deviceIds.length,
    deviceIdsRefutableBy: 'stat -c %d <site path> — two paths are a single failure domain IFF the ids are equal',
    singleFailureDomain: sameDeviceAll
      ? `ALL ${sites.length} site(s) resolve to the SAME device id ${deviceIds[0]} ⇒ ONE copy of the disk, ONE failure domain (survives rm / bad edit / git checkout, NOT the loss of the disk)`
      : `site(s) span ${deviceIds.length} device id(s)`,
    offMachineNote: 'offMachine=false means: NO site of this round was measured off this machine; a copy outside the machine was NOT taken and is an OWNER decision, not a property of this script',
    sitesDetail: sites,
    probe,
    refutationRecipe: {
      offMachine: 'refute offMachine=false by exhibiting a copy whose deviceId is NOT in deviceIds (another machine / another disk)',
      sites: 'refute sites=N by showing two of the N paths resolve to the SAME path or the SAME deviceId',
      singleFailureDomain: 'refute singleFailureDomain by showing two sites with DIFFERENT deviceIds'
    }
  }
  return file
}

/** The device ids this script treats as THIS machine's band: filled at run time
 * from the SOURCE + DEST measurements of the current round (never hard-coded),
 * so `offMachine` can only become true from an actual measurement difference. */
const LABELED_LOCAL_DEVICES = new Set()

// ---------------------------------------------------------------------------
// the round
// ---------------------------------------------------------------------------

async function runRound(opts) {
  const started = new Date()
  const source = opts.source
  const dest = opts.dest

  const srcStat = await statOrUndefined(source)
  if (srcStat === undefined) throw new UsageError(`source does not exist: ${source}`)
  const probe = await walk(source)
  if (probe.length === 0) throw new UsageError(`source is EMPTY: ${source} — refusing to report a round of nothing`)

  // round id (collision-safe: never overwrite an existing round)
  let round = roundStamp(started)
  let n = 1
  while ((await listDirs(join(dest, 'rounds'))).includes(round)) round = `${roundStamp(started)}-${++n}`

  const roundDir = join(dest, 'rounds', round)
  const destManifestDir = join(dest, 'manifests')
  await mkdir(roundDir, { recursive: true })
  await mkdir(destManifestDir, { recursive: true })

  const windowStart = started
  const enumerated = probe.filter((e) => e.kind === 'file')
  const nonRegular = probe.filter((e) => e.kind !== 'file')

  const entries = []
  const anomalies = []
  let snapshotados = 0
  let failed = 0
  let totalBytes = 0
  let unstableCaptured = 0

  for (const f of enumerated) {
    const destAbs = join(roundDir, f.rel)
    // Capture WITH RETRY: a file that CHANGES MID-FLIGHT is re-read (a moving
    // subject is normal in a directory the agents write to). ONLY a file whose
    // ORIGIN IS STABLE while md5(origin) != md5(copy) is a hard FAILURE — a
    // control that cries over normal activity gets switched off.
    let last = null
    for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
      const pre = await statOrUndefined(f.abs)
      if (pre === undefined) {
        // Enumerated at the origin, gone before it could be read: it was NOT
        // captured — by the law a FAILURE (present at origin, absent in the
        // copy), never a silent skip.
        last = { kind: 'failed', reason: 'vanished-before-read', detail: 'enumerated at the origin, unreadable at read time', attempt, bytes: null, md5: null, copyMd5: null, mtimeMs: null }
        break
      }
      let srcMd5
      try {
        srcMd5 = await md5File(f.abs)
      } catch (err) {
        last = { kind: 'failed', reason: 'origin-unreadable', detail: String(err && err.message ? err.message : err), attempt, bytes: pre.size, md5: null, copyMd5: null, mtimeMs: pre.mtimeMs }
        break
      }
      let copyMd5 = null
      let copyBytes = null
      let copyErr
      try {
        await mkdir(dirname(destAbs), { recursive: true })
        await copyFile(f.abs, destAbs)
        copyMd5 = await md5File(destAbs)
        copyBytes = (await statOrUndefined(destAbs))?.size ?? null
      } catch (err) {
        copyErr = String(err && err.message ? err.message : err)
      }
      const post = (await statOrUndefined(f.abs)) ?? pre
      const stable = post.size === pre.size && post.mtimeMs === pre.mtimeMs
      last = {
        kind: 'attempt', attempt, bytes: pre.size, md5: srcMd5, copyMd5, copyBytes,
        mtimeMs: post.mtimeMs, stable, copyErr,
        preSize: pre.size, postSize: post.size, preMtimeMs: pre.mtimeMs, postMtimeMs: post.mtimeMs
      }
      if (copyErr === undefined && copyMd5 === srcMd5 && copyBytes === pre.size && stable) {
        last.kind = 'ok'
        break
      }
      if (copyErr === undefined && stable) {
        // the origin held still and the copy still diverges: HARD FAILURE, no retry
        last.kind = 'failed'
        last.reason = copyMd5 === null || copyBytes === null ? 'absent-in-copy' : 'md5-mismatch'
        last.detail = `origin=${srcMd5}/${pre.size} copy=${copyMd5}/${copyBytes}`
        break
      }
      if (copyErr !== undefined && stable) {
        last.kind = 'failed'
        last.reason = 'copy-error'
        last.detail = copyErr
        break
      }
      // unstable (or unstable + copy error): retry
    }

    let status
    if (last !== null && last.kind === 'ok') {
      status = 'ok'
      snapshotados++
      totalBytes += last.bytes
    } else if (last !== null && last.kind === 'failed') {
      status = 'failed'
      failed++
      anomalies.push({ path: f.rel, reason: last.reason, detail: last.detail, originMd5: last.md5, copyMd5: last.copyMd5 })
    } else {
      // attempts exhausted and the origin never held still: CAPTURED, but the
      // capture is a moving target — REPORTED (window declaration), NOT A FAILURE
      status = 'unstable'
      snapshotados++
      unstableCaptured++
      totalBytes += last?.bytes ?? 0
      anomalies.push({
        path: f.rel,
        reason: 'unstable-during-window',
        detail: `origin kept changing through ${MAX_CAPTURE_ATTEMPTS} capture attempts (last: size ${last?.preSize}->${last?.postSize} bytes, mtimeMs ${last?.preMtimeMs}->${last?.postMtimeMs}) — REPORTED, NOT A FAILURE`,
        attempts: MAX_CAPTURE_ATTEMPTS
      })
    }
    entries.push({
      path: f.rel,
      bytes: last?.bytes ?? null,
      md5: last?.md5 ?? null,
      copyMd5: last?.copyMd5 ?? null,
      mtimeMs: last?.mtimeMs ?? null,
      status,
      attempts: last?.attempt ?? null
    })
  }

  const windowEnd = new Date()

  // STEP 2 of the count check (condition 4): the LIVE COUNT AT THE WINDOW END,
  // read ALOUD, immediately before the round DECLARES its window closed — and it
  // is read TWICE. The version captured BEFORE the capture loop is the round's
  // `Scope:`; this one is the DISK-LEVEL recount (a plain count over the same
  // directory), and a third one closes the declaration below. The check is
  // `captured == atOpen == atClose`: a manifest is what the SNAPSHOT BELIEVES,
  // the recount is what is ON DISK — they must agree, and that is not an
  // algebraic identity (it is falsifiable: the house creating or deleting files
  // during the window moves the count, and the round must then DECLARE the
  // movement instead of hiding it).
  // TWO DISTINCT MEASUREMENTS, TWO DISTINCT NAMES (measured bug 2026-09-17):
  // `sourceAtScan` used to be `atOpen`, i.e. the name PROMISED the pre-loop scan
  // count and SERVED the post-loop open count — a DIFFERENT band. The scan count
  // is the pre-loop probe (the population the copy loop `enumerated`); the open
  // count is this post-loop walk, run AFTER every copy, one window later. Both
  // are emitted (`bands`), and the accounting is judged against the band each
  // number really belongs to.
  const atOpenWalk = (await walk(source)).filter((e) => e.kind === 'file')
  const originAtOpen = atOpenWalk.length
  const openSet = new Set(atOpenWalk.map((e) => e.rel))
  const sourceAtScan = enumerated.length
  const declaredFound = entries.filter((e) => openSet.has(e.path)).length
  let afterMap = null
  let windowObservation = 'available'
  try {
    const after = (await walk(source)).filter((e) => e.kind === 'file')
    afterMap = new Map()
    for (const f of after) {
      const st = await statOrUndefined(f.abs)
      afterMap.set(f.rel, st ?? { size: null, mtimeMs: null })
    }
  } catch (err) {
    windowObservation = `unavailable: ${err && err.message ? err.message : err}`
    anomalies.push({ path: '<round>', reason: 'window-observation-unavailable', detail: windowObservation })
  }
  const inManifest = new Set(entries.map((e) => e.path))
  const appeared = afterMap === null ? [] : [...afterMap.keys()].filter((p) => !inManifest.has(p))
  const vanished = afterMap === null ? [] : entries.filter((e) => !afterMap.has(e.path)).map((e) => e.path)
  const modified = afterMap === null
    ? []
    : entries
      .filter((e) => {
        const now = afterMap.get(e.path)
        if (now === undefined) return false
        return now.size !== e.bytes || (e.mtimeMs !== null && now.mtimeMs !== e.mtimeMs)
      })
      .map((e) => e.path)

  // THE ACCOUNTING GUARD, IN THE TWO BANDS THE ARTIFACT ITSELF MEASURES — and
  // NEVER relaxed: every difference the script can OBSERVE must be EXPLAINED by
  // movement it can NAME, or the round still fails.
  //   sourceAtScan = ORIGIN AT SCAN: the pre-loop walk, the population the copy
  //   loop enumerated. `lostAtScan` = a manifest entry the ORIGIN AT OPEN no
  //   longer holds: the round says it captured a file the origin does not have —
  //   the one thing a round must never claim. So
  //     guardAtScan: captured == origin@scan − lostAtScan.
  //   originAtOpen = ORIGIN AT OPEN: the post-loop walk, one window later.
  //   `appearedNotCaptured` = LIVE at the origin at open and NOT in the manifest:
  //   a file that showed up after the scan, which the round CAPTURED NOTHING of.
  //   That class is DECLARED by this same artifact (`aparecidos` … "REPORTED, NOT
  //   A FAILURE"), so it must NOT fail the round:
  //     guardAtOpen: origin@open == captured + appearedNotCaptured.
  //   WITHOUT that second term a normal write of the house between the scan and
  //   the open read as `count-mismatch` ⇒ verdict FAILED + exit 1 on a round whose
  //   OWN artifact printed `failed=0 … REPORTED, NOT A FAILURE` (reproduced
  //   2026-09-17 19:58Z) — the job that forbids itself to cry over normal activity
  //   switches itself off in three rounds. The guard keeps its teeth in BOTH
  //   directions: an unaccounted difference in EITHER band is still a
  //   count-mismatch, and a captured entry that has left the origin is still one.
  const lostAtScan = entries.filter((e) => !openSet.has(e.path)).map((e) => e.path)
  const appearedAtOpen = afterMap === null ? [] : [...afterMap.keys()].filter((p) => !inManifest.has(p))
  const appearedNotCaptured = appearedAtOpen
  const guardAtScan = entries.length === sourceAtScan - lostAtScan.length
  const guardAtOpen = originAtOpen === entries.length + appearedNotCaptured.length
  const enumerationAddsUp = guardAtScan && guardAtOpen

  // DECLARE THE WINDOW CLOSED: the third count, again read aloud off the DISK —
  // movement of these numbers IS the declared window (a report written while the
  // snapshot runs, or one deleted while it runs — the deleted one is a file the
  // round RESCUED), and movement alone never fails the round.
  const atClose = afterMap === null ? null : afterMap.size
  const countCheck = {
    mode: 'this script\'s manifest count vs the origin count enumerated at scan; a single pass has NO second independent measurement of the same instant, so the check is an ACCOUNTING guard (proven live by fault injection), not a re-measurement',
    bands: {
      sourceAtScan: 'the ORIGIN AT SCAN: the pre-loop walk (the population the copy loop enumerated) — NOT the open walk',
      originAtOpen: 'the ORIGIN AT OPEN: the post-loop walk, one window after the scan — a different band; it used to be served under the name `sourceAtScan`',
      originAtWindowEnd: 'the ORIGIN AT CLOSE: the after-walk that closes the declaration'
    },
    originAtScan: sourceAtScan,
    originAtOpen,
    captured: entries.length,
    originAtWindowEnd: atClose,
    manifestEntriesPresentAtOpen: declaredFound,
    arithmetic: `origin@scan ${sourceAtScan} - lostAtScan ${lostAtScan.length} = ${sourceAtScan - lostAtScan.length} vs captured(manifest) ${entries.length}; | origin@open ${originAtOpen} vs captured ${entries.length} + appearedNotCaptured ${appearedNotCaptured.length} = ${entries.length + appearedNotCaptured.length}; | origin@close ${atClose ?? 'unavailable'}`,
    guards: { atScan: guardAtScan, atOpen: guardAtOpen },
    windowMovement: {
      appeared: appeared.length,
      appearedNotCaptured: appearedNotCaptured.length,
      vanished: vanished.length,
      lostAtScan: lostAtScan.length,
      modified: modified.length,
      note: 'DECLARED movement — never a failure; a vanished file that WAS captured is a file RESCUED'
    },
    accountedFor: enumerationAddsUp
  }
  if (!enumerationAddsUp) {
    anomalies.push({
      path: '<round>',
      reason: 'count-mismatch',
      detail: `ALERT: origin@scan ${sourceAtScan} - lostAtScan ${lostAtScan.length} = ${sourceAtScan - lostAtScan.length} vs captured=${entries.length} (guardAtScan=${guardAtScan}); origin@open ${originAtOpen} vs captured=${entries.length} + appearedNotCaptured=${appearedNotCaptured.length} = ${entries.length + appearedNotCaptured.length} (guardAtOpen=${guardAtOpen}) — the manifest does NOT account for every file enumerated at the origin (probe=${probe.length}, nonRegular=${nonRegular.length}); band numbers: origin@scan=${sourceAtScan} origin@open=${originAtOpen} origin@close=${atClose ?? 'unavailable'}`
    })
  }
  const accountedFor = countCheck.accountedFor
  for (const f of nonRegular) {
    anomalies.push({ path: f.rel, reason: 'skipped-non-regular', detail: `kind=${f.kind} (declared scope exception, NOT a failure)` })
  }

  const verdict = failed === 0 && accountedFor ? 'COMPLETE' : 'FAILED'
  const sourceBytesFinal = entries.reduce((acc, e) => acc + (typeof e.bytes === 'number' ? e.bytes : 0), 0)

  // THE REACH OF THE NET, MEASURED (never narrated): the three sites of THIS
  // round — origin, round copy, external mirror — plus their real device ids
  // read off the mounts. The mirror is a site like any other and is measured
  // like one: a prose note ("same filesystem for source and dest") let a reader
  // believe the copy was somewhere else; a FIELD cannot: `offMachine:false` is
  // contradicted by any copy on another machine, and `sites:3` by showing two of
  // them share a deviceId.
  const redundancy = await measureRedundancy(
    [source, join(dest, 'rounds', round), opts.mirror],
    (p) => (p === source ? 'origin' : p === join(dest, 'rounds', round) ? 'round-copy' : 'manifest-mirror')
  )
  // the LOCAL band is whatever the source+dest of THIS round measured: built at
  // run time, never hard-coded, so `offMachine` can only turn true from a real
  // measurement difference (an artifact cannot claim off-machine reach).
  for (const s of redundancy.sitesDetail) if (s.label !== 'manifest-mirror' && s.deviceId !== null) LABELED_LOCAL_DEVICES.add(s.deviceId)
  redundancy.offMachine = redundancy.sitesDetail.some((s) => s.deviceId !== null && !LABELED_LOCAL_DEVICES.has(s.deviceId))
  redundancy.roundsRetained = opts.rounds
  redundancy.recoveryWindowHours = opts.rounds * 6
  redundancy.recoveryWindowNote = 'a round every 6 h with --rounds 7 keeps ≈ 42 h of history: the net recovers a file lost up to ~42 h ago, NOT older'

  const manifest = {
    round,
    script: 'scripts/reports-snapshot.mjs',
    generatedAt: iso(windowEnd),
    source,
    dest,
    roundDir,
    window: {
      start: iso(windowStart),
      end: iso(windowEnd),
      seconds: Number(((windowEnd.getTime() - windowStart.getTime()) / 1000).toFixed(3)),
      note: 'DECLARED WINDOW — the source is a directory the agents write to: this snapshot is a photograph of a moving subject'
    },
    scope: {
      sourceAtScan,
      sourceAtScanBand: 'ORIGIN AT SCAN (pre-loop walk) — the population the copy loop enumerated',
      originAtOpen,
      originAtOpenBand: 'ORIGIN AT OPEN (post-loop walk) — a DIFFERENT band, one window later',
      nonRegular: nonRegular.length,
      accountedFor,
      bytesAtOrigin: sourceBytesFinal,
      redundancy,
      windowObservation
    },
    redundancy,
    countCheck,
    counts: {
      snapshotados,
      failed,
      modifiedDuringWindow: modified.length,
      appearedDuringWindow: appeared.length,
      vanishedDuringWindow: vanished.length,
      unstableCaptured
    },
    integrity: {
      md5Compared: entries.filter((e) => e.copyMd5 !== null).length,
      md5Mismatch: anomalies.filter((a) => a.reason === 'md5-mismatch').length,
      absentInCopy: anomalies.filter((a) => a.reason === 'absent-in-copy' || a.reason === 'copy-error' || a.reason === 'vanished-before-read').length
    },
    verdict,
    entries: entries.map((e) => ({ path: e.path, bytes: e.bytes, md5: e.md5, copyMd5: e.copyMd5, mtimeMs: e.mtimeMs, status: e.status, attempts: e.attempts })),
    anomalies
  }

  const manifestName = `${roundDate(round)}-reports-snapshot-manifest-${round}.json`
  const mirrorPath = join(opts.mirror, manifestName)
  const destManifestPath = join(destManifestDir, `${round}.json`)
  await mkdir(opts.mirror, { recursive: true })
  const manifestJson = JSON.stringify(manifest, null, 2)
  await writeFile(mirrorPath, manifestJson)
  await writeFile(destManifestPath, manifestJson)

  // retention IN ROUNDS (the only destructive op: our OWN older rounds)
  const pruned = await pruneRounds(opts, round)
  const prunedMirrors = await pruneMirrors(opts)

  const summary = {
    round,
    source,
    dest,
    roundDir,
    manifest: { mirror: mirrorPath, destCopy: destManifestPath, sha256: await sha256File(mirrorPath), bytes: Buffer.byteLength(manifestJson) },
    window: manifest.window,
    counts: manifest.counts,
    scope: manifest.scope,
    redundancy: manifest.redundancy,
    countCheck: manifest.countCheck,
    integrity: manifest.integrity,
    verdict,
    retention: { rounds: opts.rounds, pruned, prunedMirrors },
    anomalies: anomalies.length
  }

  if (!opts.quiet) {
    const out = []
    out.push(`=== reports-snapshot round ${round} ===`)
    out.push(`source:    ${source}`)
    out.push(`dest:      ${dest}`)
    out.push(`window:    ${manifest.window.start} -> ${manifest.window.end} (${manifest.window.seconds} s) [DECLARED WINDOW]`)
    out.push(`bands:     origin@scan=${sourceAtScan} (PRE-loop, the population enumerated) origin@open=${originAtOpen} (POST-loop, one window later) origin@close=${atClose ?? 'unavailable'}`)
    out.push(`scope:     enumerated=${sourceAtScan} snapshotados=${snapshotados} failed=${failed} bytes=${bytes(totalBytes)}`)
    out.push(`redundancy: sites=${redundancy.sites} measured=${redundancy.measuredSites} deviceIds=[${redundancy.deviceIds.join(',')}] distinctDeviceIds=${redundancy.distinctDeviceIds} offMachine=${redundancy.offMachine} sameDeviceAll=${redundancy.sameDeviceAll}`)
    out.push(`            ${redundancy.singleFailureDomain}`)
    out.push(`            ${redundancy.offMachineNote}`)
    for (const s of redundancy.sitesDetail) out.push(`            site ${s.label}: ${s.path} deviceId=${s.deviceId ?? '<unmeasured>'} fs=${s.fs ?? s.fsFromDf ?? '<unmeasured>'} mount=${s.mount ?? s.mountFromDf ?? '<unmeasured>'}`)
    out.push(`integrity: md5(ORIGIN) vs md5(COPY) compared=${manifest.integrity.md5Compared} match=${manifest.integrity.md5Compared - manifest.integrity.md5Mismatch} mismatch=${manifest.integrity.md5Mismatch} absent-in-copy=${manifest.integrity.absentInCopy}`)
    out.push(`window obs: appeared=${appeared.length} vanished=${vanished.length} modified=${modified.length} unstableCaptured=${unstableCaptured} (REPORTED, NOT A FAILURE)`)
    out.push(`scope note: ${accountedFor ? 'count OK (accounting guard): ' + countCheck.arithmetic + ` (manifest entries present at open ${countCheck.manifestEntriesPresentAtOpen}/${entries.length})` : 'COUNT MISMATCH vs the origin — ALERT: ' + countCheck.arithmetic}`)
    out.push(`manifest:  ${mirrorPath} sha256=${summary.manifest.sha256}`)
    out.push(`           + dest copy ${destManifestPath} (NOT inside the round dir)`)
    out.push(`retention: rounds=${opts.rounds} prunedRounds=${pruned.length} prunedMirrors=${prunedMirrors.length}`)
    out.push(`verdict:   ${verdict}${verdict === 'FAILED' ? ' (integrity/accounting — the round does NOT count)' : ''}`)
    for (const a of anomalies) out.push(`anomaly:   ${a.path} :: ${a.reason} :: ${a.detail}`)
    out.push(`manifest-head (first 5 of ${entries.length}):`)
    for (const e of entries.slice(0, 5)) out.push(`  ${e.path} ${e.bytes} ${e.md5 ?? '<none>'} ${e.status}`)
    out.push(`WINDOW-DECLARATION: ${JSON.stringify({ round, start: manifest.window.start, end: manifest.window.end, snapshotados, modificadosDuranteLaVentana: modified.length, aparecidosDuranteLaVentana: appeared.length, desaparecidosDuranteLaVentana: vanished.length, fallidos: failed, verdict, cuenta: { originAtScan: sourceAtScan, originAtOpen, originAtClose: atClose } })}`)
    out.push(`ROUND-JSON: ${JSON.stringify(summary)}`)
    process.stdout.write(out.join('\n') + '\n')
  } else {
    process.stdout.write(`ROUND-JSON: ${JSON.stringify(summary)}\n`)
  }
  return verdict === 'COMPLETE' ? 0 : 1
}

/** Retention of OUR OWN older rounds (never anything else, never the current). */
async function pruneRounds(opts, currentRound) {
  const roundsRoot = join(opts.dest, 'rounds')
  const names = (await listDirs(roundsRoot)).filter((n) => ROUND_RE.test(n)).sort()
  const keep = new Set(names.slice(-opts.rounds))
  const pruned = []
  for (const name of names) {
    if (keep.has(name)) continue
    if (name === currentRound) continue
    const p = join(roundsRoot, name)
    let fileCount = 0
    let byteCount = 0
    try {
      for (const f of await walk(p)) {
        if (f.kind !== 'file') continue
        fileCount++
        byteCount += (await statOrUndefined(f.abs))?.size ?? 0
      }
      await rm(p, { recursive: true, force: false })
      // its manifest copy (a convenience artifact of a round we just dropped)
      await rm(join(opts.dest, 'manifests', `${name}.json`), { force: true })
      pruned.push({ round: name, files: fileCount, bytes: byteCount })
    } catch (err) {
      pruned.push({ round: name, error: String(err && err.message ? err.message : err) })
    }
  }
  return pruned
}

/** Retention of OUR OWN older mirror manifests (filename pattern enforced). */
async function pruneMirrors(opts) {
  let names = []
  try {
    names = (await readdir(opts.mirror)).filter((n) => MIRROR_RE.test(n)).sort()
  } catch {
    return []
  }
  const keep = new Set(names.slice(-opts.rounds))
  const pruned = []
  for (const name of names) {
    if (keep.has(name)) continue
    try {
      await rm(join(opts.mirror, name), { force: true })
      pruned.push({ manifest: name })
    } catch (err) {
      pruned.push({ manifest: name, error: String(err && err.message ? err.message : err) })
    }
  }
  return pruned
}

// ---------------------------------------------------------------------------
// RESTORE-VERIFY: a backup that has never been restored is not a backup
// ---------------------------------------------------------------------------

async function resolveVerifyTarget(opts) {
  const target = opts.verify
  if (target === 'latest' || ROUND_RE.test(target)) {
    const round = target === 'latest'
      ? (await listDirs(join(opts.dest, 'rounds'))).filter((n) => ROUND_RE.test(n)).sort().pop()
      : target
    if (round === undefined) throw new UsageError(`no round found under ${join(opts.dest, 'rounds')}`)
    // the manifest is read from the THIRD SITE (the mirror), never from inside the snapshot
    const mirrored = `${roundDate(round)}-reports-snapshot-manifest-${round}.json`
    const p = join(opts.mirror, mirrored)
    if ((await statOrUndefined(p)) === undefined) throw new UsageError(`mirror manifest not found: ${p}`)
    return p
  }
  const p = resolve(target)
  if ((await statOrUndefined(p)) === undefined) throw new UsageError(`manifest not found: ${p}`)
  return p
}

async function runVerify(opts) {
  const manifestPath = await resolveVerifyTarget(opts)
  const manifest = JSON.parse(await new Promise((res, rej) => {
    let s = ''
    createReadStream(manifestPath, { encoding: 'utf8' })
      .on('data', (c) => { s += c })
      .on('end', () => res(s))
      .on('error', rej)
  }))
  const ok = manifest.entries.filter((e) => e.md5 !== null)
  if (ok.length === 0) throw new UsageError(`manifest ${manifestPath} has no hashed entries`)

  // deterministic sample: stride over the sorted ok entries + the largest file
  const sorted = [...ok].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const n = opts.verifySample === 0 || opts.verifySample >= sorted.length ? sorted.length : opts.verifySample
  const stride = sorted.length / n
  const pick = new Map()
  for (let i = 0; i < n; i++) pick.set(sorted[Math.floor(i * stride)].path, sorted[Math.floor(i * stride)])
  const largest = [...sorted].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))[0]
  if (largest !== undefined) pick.set(largest.path, largest)

  const tmp = join(opts.restoreRoot, `${manifest.round}-${process.pid}`)
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })

  const results = []
  let matched = 0
  for (const e of pick.values()) {
    const src = join(manifest.roundDir, e.path)
    const dst = join(tmp, e.path)
    const r = { path: e.path, manifestBytes: e.bytes, manifestMd5: e.md5 }
    try {
      await mkdir(dirname(dst), { recursive: true })
      await copyFile(src, dst)
      const st = await statOrUndefined(dst)
      r.restoredBytes = st?.size ?? null
      r.restoredMd5 = await md5File(dst)
      r.match = r.restoredMd5 === e.md5 && r.restoredBytes === e.bytes
    } catch (err) {
      r.error = String(err && err.message ? err.message : err)
      r.match = false
    }
    if (r.match) matched++
    results.push(r)
  }
  await rm(tmp, { recursive: true, force: true })

  const mismatched = results.filter((r) => r.match !== true)
  const verdict = mismatched.length === 0 ? 'RESTORE-VERIFIED' : 'RESTORE-FAILED'
  // SAMPLE vs COMPLETE, AS A FIELD: the per-round proof restores a deterministic
  // stride sample + the largest file, so it is a COVERAGE statement, never a
  // claim that every file was restored — 1,594 of 1,620 files sat un-restored
  // under `--verify-sample 25`. The hole is closed BY TIME, not by cost: the job
  // declaration orders ONE `--verify-sample 0` (full restore, every file) per day,
  // which this block makes visible (`complete: true`, `coveragePct: 100`).
  const complete = opts.verifySample === 0 || results.length === ok.length
  const summary = {
    mode: 'restore-verify',
    manifest: manifestPath,
    manifestSha256: await sha256File(manifestPath),
    round: manifest.round,
    snapshotWindow: manifest.window,
    restoredInto: tmp,
    sampled: results.length,
    complete,
    sampleRequested: opts.verifySample,
    manifestHashedEntries: ok.length,
    coveragePct: ok.length === 0 ? null : Number(((results.length / ok.length) * 100).toFixed(2)),
    sampleNote: complete
      ? 'COMPLETE restore proof: EVERY hashed entry of the manifest was restored and compared (the daily order)'
      : `SAMPLE restore proof: ${results.length} of ${ok.length} hashed entries (${Number(((results.length / ok.length) * 100).toFixed(2))} %) — deterministic stride + the largest file; ${ok.length - results.length} file(s) have NOT been restored by this pass (the gap is closed by the once-a-day complete pass, not by this sample)`,
    matched,
    mismatched: mismatched.length,
    verdict,
    results
  }
  if (!opts.quiet) {
    const out = []
    out.push(`=== reports-snapshot RESTORE-VERIFY round ${manifest.round} ===`)
    out.push(`manifest:  ${manifestPath} sha256=${summary.manifestSha256}`)
    out.push(`snapshot:  ${manifest.roundDir} (window ${manifest.window.start} -> ${manifest.window.end})`)
    out.push(`restored:  ${results.length} file(s) into ${tmp} (removed after the check)`)
    out.push(`coverage:  ${complete ? 'COMPLETE' : 'SAMPLE'} ${results.length}/${ok.length} hashed entr(ies) (${summary.coveragePct}%) sampleRequested=${opts.verifySample} (0 = all)`)
    out.push(`compared:  md5(restored) vs md5(ORIGIN, from the manifest) => matched=${matched} mismatched=${mismatched.length}`)
    for (const r of results) out.push(`  ${r.match ? 'MATCH' : 'MISMATCH'} ${r.path} bytes=${r.restoredBytes ?? '<none>'}/${r.manifestBytes} md5=${r.restoredMd5 ?? '<none>'}/${r.manifestMd5}`)
    out.push(`verdict:   ${verdict}`)
    out.push(`VERIFY-JSON: ${JSON.stringify(summary)}`)
    process.stdout.write(out.join('\n') + '\n')
  } else {
    process.stdout.write(`VERIFY-JSON: ${JSON.stringify(summary)}\n`)
  }
  return mismatched.length === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return 2
  }
  if (opts.help) {
    const header = (await readFileSelf()).split('\n').slice(0, 60).join('\n')
    process.stdout.write(header + '\n')
    return 0
  }
  try {
    return opts.verify === undefined ? await runRound(opts) : await runVerify(opts)
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`reports-snapshot: ${err.message}\n`)
      return 2
    }
    process.stderr.write(`reports-snapshot: ${err && err.stack ? err.stack : err}\n`)
    return 2
  }
}

async function readFileSelf() {
  const { readFile } = await import('node:fs/promises')
  return await readFile(new URL(import.meta.url), 'utf8')
}

process.exitCode = await main()
