// dsh-deepartments — R6 SUITE-INTEGRITY GUARD (fb-91).
//
// The 2026-09-04 fb-91 incident: the run AUTO-MUTATED
// packages/dshd-orchestration/src/tools.ts ±1B mid-suite (the CUT-4 zone
// 78050↔78051B; the frozen md5 7b5b1c91… only fit post-rewrite; the tree was
// restored by the end), so no before/after-only check could ever see it — the
// file was byte-identical again when the suite finished. The writer was never
// identified. This helper is the detector that was missing:
//
//   - START   : the guarded file must match git HEAD (a pre-existing mutation
//               fails loudly — the tree was NOT quiet when the run started).
//   - DURING  : md5/size/CUT-4-zone-md5 are polled while `node --test` runs —
//               ANY rewrite event (even one that is restored before the end,
//               the exact fb-91 shape) fails the run with its timestamp.
//   - END     : the guarded file must equal its start snapshot (a surviving
//               mutation fails).
//
// Usage:
//   pnpm test:guarded                 # plain `node --test` (fb-95) + the guard
//   node scripts/r6-suite-guard.mjs --test-name-pattern=xxx   # passthrough args
//   R6_GUARD_SKIP_START=1 pnpm test:guarded  # shared-tree WIP escape hatch:
//     skip the git-HEAD start check (during + end checks still enforced; run
//     on a quiet tree for the authoritative verdict).
//
// The guard targets the ONE file fb-91 hit (the CUT-4 factory the frozen
// tools-factory.test.js zone md5 reads from SOURCE); other lanes edit
// tools.ts legitimately OUTSIDE the CUT-4 span (tools.ts:1313/1400-1600/5593-5635),
// so the during-monitor keys on the WHOLE file md5/size (any change = event,
// reported) but the FAIL threshold is the CUT-4 ZONE md5 + the end-delta (a
// whole-file change in a foreign zone is reported as an informational event,
// not a failure — the shared-tree WIP class).
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
export const GUARDED_FILE_REL = 'packages/dshd-orchestration/src/tools.ts'
export const GUARDED_FILE = path.join(REPO_ROOT, GUARDED_FILE_REL)

/** The CUT-4 zone span markers — the SAME strings the frozen
 * tools-factory.test.js:292-293 uses to slice the factory text. */
export const ZONE_BANNER = '  // --- messaging bus TOOL DEFINITIONS (ONE body per tool; registered in the'
export const ZONE_CLOSE = "  }, 'deepartments: host-plane tools')"

/** P2-HYGIENE (fb-91 class, 2026-09-06) — the per-zone md5 MANIFEST snapshot
 * (`scripts/zone-md5-manifest.json`): the frozen md5 of every guarded file
 * zone, asserted at START (= the CURRENT source must match the FROZEN value,
 * closing the commit-drift observability gap the LADDER §2 documents — a zone
 * changed by a NEW HEAD passes the worktree==HEAD mutation phases) and at END
 * (no drift may survive the run). `zoneMd5WithMarkers` is the generic slicer;
 * `zoneMd5(text)` stays the CUT-4 single-zone special case (back-compat with
 * the hermetic freeze test). */
export function zoneMd5WithMarkers(text, banner, close) {
  const first = text.indexOf(banner)
  const last = text.indexOf(close)
  if (first === -1 || last === -1 || last <= first) return null
  const zone = text.slice(first, last + close.length) + '\n'
  return createHash('md5').update(zone, 'utf8').digest('hex')
}

export function zoneMd5(text) {
  return zoneMd5WithMarkers(text, ZONE_BANNER, ZONE_CLOSE)
}

/** The per-zone md5 manifest path (P2-HYGIENE). */
export const ZONE_MANIFEST_REL = 'scripts/zone-md5-manifest.json'
export const ZONE_MANIFEST_FILE = path.join(REPO_ROOT, ZONE_MANIFEST_REL)

/** Load the per-zone md5 MANIFEST snapshot. NEVER throws: an absent /
 * unreadable / malformed file or an empty zone list → undefined (the guard
 * keeps running with the legacy single-zone behavior — the manifest is the
 * DRIFT detector, not a hard requirement of the mutation phases). */
export function loadZoneManifest() {
  try {
    const parsed = JSON.parse(readFileSync(ZONE_MANIFEST_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const zones = Array.isArray(parsed.zones) ? parsed.zones : []
    const clean = zones.filter(
      (z) =>
        z !== null &&
        typeof z === 'object' &&
        typeof z.id === 'string' &&
        typeof z.file === 'string' &&
        typeof z.banner === 'string' &&
        typeof z.close === 'string' &&
        typeof z.md5 === 'string' &&
        /^[0-9a-f]{32}$/.test(z.md5),
    )
    return clean.length > 0 ? { schemaVersion: parsed.schemaVersion, zones: clean } : undefined
  } catch {
    return undefined
  }
}

/** Zone-vs-manifest drift rows for the CURRENT on-disk files ([] = every
 * manifest zone matches its frozen md5). Reads each zone's file fresh; a
 * missing/unreadable file or a missing marker span is reported as a drift row
 * (the snapshot cannot be verified). PURE-ish (file reads, no writes). */
export function diffManifestZones(manifest) {
  const out = []
  for (const zone of manifest.zones) {
    let text
    try {
      text = readFileSync(path.join(REPO_ROOT, zone.file), 'utf8')
    } catch {
      out.push(`zone "${zone.id}" file unreadable (${zone.file}) — the frozen snapshot cannot be verified`)
      continue
    }
    const cur = zoneMd5WithMarkers(text, zone.banner, zone.close)
    if (cur === null) out.push(`zone "${zone.id}" markers not found in ${zone.file} (banner/close drifted?)`)
    else if (cur !== zone.md5) out.push(`zone "${zone.id}" md5 ${cur.slice(0, 8)}… != frozen ${zone.md5.slice(0, 8)}… — the zone drifted by COMMIT (the freeze test tools-factory.test.js AND this manifest must move in the SAME commit)`)
  }
  return out
}

export function fileSnapshot(text) {
  return { md5: createHash('md5').update(text, 'utf8').digest('hex'), size: Buffer.byteLength(text, 'utf8'), zoneMd5: zoneMd5(text) }
}

export function snapshotPath(p) {
  return fileSnapshot(readFileSync(p, 'utf8'))
}

/** Human-readable deltas between two snapshots ([] = identical). */
export function diffSnapshots(from, to) {
  const out = []
  if (from.md5 !== to.md5) out.push(`md5 ${from.md5.slice(0, 8)}… -> ${to.md5.slice(0, 8)}…`)
  if (from.size !== to.size) out.push(`size ${from.size}B -> ${to.size}B`)
  if (from.zoneMd5 !== to.zoneMd5) out.push(`CUT-4 zone md5 ${from.zoneMd5?.slice(0, 8) ?? 'null'}… -> ${to.zoneMd5?.slice(0, 8) ?? 'null'}…`)
  return out
}

export function gitHeadText(rel) {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'show', `HEAD:${rel}`], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return undefined
  }
}

export async function runGuard(argv) {
  const start = snapshotPath(GUARDED_FILE)
  const headText = gitHeadText(GUARDED_FILE_REL)
  const skipStart = process.env.R6_GUARD_SKIP_START === '1'
  const violations = []
  const informational = []
  // P2-HYGIENE (fb-91 class): the per-zone md5 MANIFEST snapshot — the frozen
  // value the CURRENT source must match (commit-drift detection; the START
  // escape hatch also skips the manifest assert so a shared-tree lane WIP that
  // LEGITIMATELY re-freezes the zone can run the suite; the END assert stays
  // active in both modes — no drift may survive the run).
  const manifest = loadZoneManifest()
  const manifestStartDrifts = manifest !== undefined && !skipStart ? diffManifestZones(manifest) : []

  if (headText !== undefined && !skipStart) {
    const headSnap = fileSnapshot(headText)
    const deltas = diffSnapshots(headSnap, start)
    if (deltas.length > 0) {
      violations.push(`START: ${GUARDED_FILE_REL} differs from git HEAD (${deltas.join('; ')}) — the tree was NOT quiet when the run started (pre-existing mutation or concurrent lane WIP; run on a quiet tree, or R6_GUARD_SKIP_START=1 for the shared-tree escape hatch)`)
    }
  }
  // P2-HYGIENE (fb-91 class): the MANIFEST START assert — the CURRENT source's
  // zone md5 must equal the FROZEN manifest value (a zone drifted by a NEW
  // HEAD is invisible to the worktree==HEAD mutation phases; this fails loud).
  for (const drift of manifestStartDrifts) {
    violations.push(`START (MANIFEST): ${drift}`)
  }

  const child = spawn('node', ['--test', ...argv], { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
  const events = []
  let lastSeen = { ...start }
  const poll = setInterval(() => {
    try {
      const cur = snapshotPath(GUARDED_FILE)
      const deltas = diffSnapshots(lastSeen, cur)
      if (deltas.length > 0) {
        const evt = { at: new Date().toISOString(), deltas }
        events.push(evt)
        // A CUT-4 ZONE rewrite mid-run is the fb-91 signature — fail even if restored.
        if (cur.zoneMd5 !== lastSeen.zoneMd5) violations.push(`DURING ${evt.at}: CUT-4 zone md5 changed (${deltas.join('; ')}) — a mid-run rewrite of the frozen factory zone (fb-91 class)`)
        else informational.push(`DURING ${evt.at}: whole-file change outside the CUT-4 zone (${deltas.join('; ')}) — shared-tree WIP class (informational)`)
        lastSeen = { ...cur }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
  }, 400)

  const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)))
  clearInterval(poll)

  const end = snapshotPath(GUARDED_FILE)
  const endDeltas = diffSnapshots(start, end)
  if (endDeltas.length > 0) {
    violations.push(`END: ${GUARDED_FILE_REL} differs from its start snapshot (${endDeltas.join('; ')}) — the suite left the tree mutated`)
  }
  // P2-HYGIENE (fb-91 class): the MANIFEST END assert — active in EVERY mode
  // (even R6_GUARD_SKIP_START) — no frozen-zone drift may survive the run.
  const manifestEndDrifts = manifest !== undefined ? diffManifestZones(manifest) : []
  for (const drift of manifestEndDrifts) {
    violations.push(`END (MANIFEST): ${drift}`)
  }

  const report = {
    guardedFile: GUARDED_FILE_REL,
    start: { md5: start.md5.slice(0, 12), size: start.size, zoneMd5: start.zoneMd5?.slice(0, 12) },
    end: { md5: end.md5.slice(0, 12), size: end.size, zoneMd5: end.zoneMd5?.slice(0, 12) },
    gitHeadMatchedStart: headText !== undefined ? diffSnapshots(fileSnapshot(headText), start).length === 0 : 'git-unavailable',
    manifest: manifest !== undefined
      ? {
          file: ZONE_MANIFEST_REL,
          zones: manifest.zones.map((z) => ({ id: z.id, file: z.file, md5: z.md5 }))
        }
      : 'unavailable',
    mutationEvents: events.length,
    informationalEvents: informational,
    violations,
    suiteExitCode: exitCode,
    verdict: violations.length === 0 ? 'PASS' : 'FAIL',
  }
  console.error('\n=== R6 SUITE-INTEGRITY GUARD (fb-91) ===')
  console.error(JSON.stringify(report, null, 2))
  console.error('=== END R6 SUITE-INTEGRITY GUARD ===')
  return violations.length === 0 ? exitCode : 2
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runGuard(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}