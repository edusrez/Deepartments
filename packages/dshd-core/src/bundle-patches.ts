// dshd-core — R3 BUNDLE-LAYER PATCH STALENESS WATCHDOG (WORK-REGISTER
// post-cierre 2026-09-04, QD finding 09-04). The launcher's HMR watcher
// (`watchUserPatches`, dsh-app-boot lib/index.js + apps/cli profile-boot)
// watches ONLY the active profile's own `cordis.patch.yml` and the home-level
// `cordis.patch.yml` — NOT the BUNDLE-LAYER patch files each bundle's
// `dsh.bundle.patch` declares (e.g. the dshd-core row / dsh-deepartments row).
// A knob committed in a bundle layer therefore stays INACTIVE until a daemon
// restart — silently (live evidence: org.offlineReap, ignition 939e942, only
// loaded at the 2026-09-04 20:49:48Z smart_restart).
//
// This module provides the durable + noisy mitigation: at apply time (boot) it
// snapshots the resolved-at-boot mtimes of every bundle-layer patch file the
// active profile actually composes (parsed from the profile manifest + each
// bundle's `dsh.bundle.patch`), and on every interval re-stats them. A changed
// mtime = "a new bundle-layer patch was committed but is NOT loaded" →
// REPEATED loud warns (each interval, until restart) + a DURABLE sidecar
// (`<stateDir>/bundle-patch-alerts.json`) a report/health surface can read.
//
// DESIGN CONSTRAINTS (mission R3): minimal + non-intrusive — the check is
// READ-ONLY (stat/read, never a knob reload, never a restart), it has ZERO
// impact on the normal knob-loading path (it does not touch the Loader or the
// include tree), and a resolution failure degrades to ONE warn, never a throw
// into apply. Code default ON (a knob committed today must never be silently
// inactive); `org.bundlePatchCheck: false` opts out; the interval is
// `org.bundlePatchCheckIntervalMs` (default 60 s).
//
// NO export default (pitfall 0001 — breaks `inject`).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** The durable sidecar filename: `<stateDir>/bundle-patch-alerts.json`. */
export const BUNDLE_PATCH_ALERTS_FILE = 'bundle-patch-alerts.json'

/** The default watchdog interval: 60 s (aligned with the health daemon tick). */
export const BUNDLE_PATCH_CHECK_INTERVAL_MS = 60_000

/** The config slice the watchdog reads (structurally compatible with the
 * dshd-core `org` row — see CoreConfig.org in ./index.ts). */
export interface BundlePatchWatchConfig {
  /** The org stateDir (the sidecar lands under it). */
  stateDir: string
  /** The shared org config; only the R3 keys are read. */
  org?: {
    /** `false` opts the watchdog OUT entirely; absent/`true` = ON (default). */
    bundlePatchCheck?: boolean
    /** The interval override (ms); absent = {@link BUNDLE_PATCH_CHECK_INTERVAL_MS}. */
    bundlePatchCheckIntervalMs?: number
  }
}

/** Injectable inputs (tests fix argv/home/clock — the daemon uses the runtime
 * process.argv / DSH_HOME / Date.now()). */
export interface BundlePatchWatchdogDeps {
  /** The process argv to parse `--profile` from (default `process.argv`). */
  argv?: readonly string[]
  /** The Harness home (default `process.env.DSH_HOME ?? ~/.dsh`). */
  home?: string
  /** The clock (default `Date.now`). */
  now?: () => number
}

/** One bundle-layer patch file whose mtime moved after boot. */
export interface ChangedBundlePatch {
  /** The absolute patch path (a bundle's `dsh.bundle.patch` file). */
  path: string
  /** The mtime recorded at boot (resolved-at-boot, ms epoch). */
  bootMtimeMs: number
  /** The current mtime (ms epoch); `undefined` = the file disappeared. */
  nowMtimeMs: number | undefined
}

/** The durable sidecar state. */
export interface BundlePatchAlertsState {
  /** The moment the change was first seen (ms epoch). */
  seenAt: number
  /** The changed bundle-layer patch files of the CURRENT staleness. */
  changed: ChangedBundlePatch[]
}

/**
 * Parse the profile name from a `dsh`-style argv (`--profile <name>`). Returns
 * `undefined` when absent — the check then cannot know the active profile and
 * disables itself with ONE warn (fail-soft, never a throw).
 */
export function parseProfileNameFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === '--profile') {
      const value = argv[i + 1]
      if (value !== undefined && value !== '' && !value.startsWith('--')) return value
    }
  }
  return undefined
}

/** Read the ordered bundle list of one profile manifest (`dsh.profile.bundles`).
 * A missing/unreadable/invalid manifest → [] (never throws). */
export function resolveBundlesFromProfileManifest(profileDir: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as
      | { dsh?: { profile?: { bundles?: unknown } } }
      | undefined
    const bundles = manifest?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return []
    return bundles.filter((name): name is string => typeof name === 'string' && name !== '')
  } catch {
    return []
  }
}

/**
 * Resolve the absolute path of one listed bundle's `dsh.bundle.patch` file.
 * Resolution mirrors the launcher's anchor order enough for the runtime: first
 * Node module resolution from the PROFILE directory (the profile's node_modules
 * holds the composed bundles — in the dev deployment they symlink into the live
 * repos), then a plain `node_modules/<name>` walk. A bundle that does not
 * resolve — or whose manifest declares no `dsh.bundle.patch` — is SKIPPED
 * (best-effort: the watchdog must never fail over one unresolvable package).
 * Returns `undefined` when the bundle cannot be resolved.
 */
export function resolveBundlePatchPath(profileDir: string, packageName: string): string | undefined {
  const readManifest = (packageJsonPath: string): string | undefined => {
    try {
      const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as
        | { dsh?: { bundle?: { patch?: unknown } } }
        | undefined
      const patch = manifest?.dsh?.bundle?.patch
      return typeof patch === 'string' && patch !== '' ? join(dirname(packageJsonPath), patch) : undefined
    } catch {
      return undefined
    }
  }
  const direct = join(profileDir, 'node_modules', packageName, 'package.json')
  if (existsSync(direct)) {
    const fromDirect = readManifest(direct)
    if (fromDirect !== undefined) return fromDirect
  }
  try {
    const resolved = createRequire(join(profileDir, 'package.json')).resolve(`${packageName}/package.json`)
    return readManifest(resolved)
  } catch {
    return undefined
  }
}

/** Resolve EVERY bundle-layer patch path the active profile composes. Absolute
 * paths, in profile manifest order; unresolvable bundles are skipped. Never
 * throws. */
export function resolveBundlePatchPaths(profileDir: string): string[] {
  const out: string[] = []
  for (const packageName of resolveBundlesFromProfileManifest(profileDir)) {
    const patchPath = resolveBundlePatchPath(profileDir, packageName)
    if (patchPath !== undefined) out.push(patchPath)
  }
  return out
}

/** One snapshot: bundle patch path → mtimeMs (`undefined` = missing/unreadable). */
export type PatchMtimeSnapshot = Record<string, number | undefined>

/** Stat every path into a snapshot. A missing/unreadable file → `undefined`
 * (a file committed later or removed is DETECTABLE as a change). Never throws. */
export function snapshotBundlePatchMtimes(paths: readonly string[]): PatchMtimeSnapshot {
  const out: PatchMtimeSnapshot = {}
  for (const patchPath of paths) {
    try {
      out[patchPath] = statSync(patchPath).mtimeMs
    } catch {
      out[patchPath] = undefined
    }
  }
  return out
}

/** The bundle-layer patch files whose mtime differs from the boot snapshot.
 * PURE. `now` is expected to cover the same path set (both snapshots are taken
 * from the same resolved path list). */
export function findChangedBundlePatches(
  boot: PatchMtimeSnapshot,
  now: PatchMtimeSnapshot,
): ChangedBundlePatch[] {
  const changed: ChangedBundlePatch[] = []
  for (const [patchPath, bootMtimeMs] of Object.entries(boot)) {
    const nowMtimeMs = now[patchPath]
    if (bootMtimeMs !== nowMtimeMs) {
      changed.push({ path: patchPath, bootMtimeMs: bootMtimeMs ?? 0, nowMtimeMs })
    }
  }
  return changed
}

/** Read the durable sidecar (absent/unreadable/malformed → undefined). */
export function readBundlePatchAlerts(stateDir: string): BundlePatchAlertsState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, BUNDLE_PATCH_ALERTS_FILE), 'utf8')) as Record<string, unknown>
    if (typeof parsed.seenAt !== 'number' || !Array.isArray(parsed.changed)) return undefined
    return {
      seenAt: parsed.seenAt,
      changed: parsed.changed.filter((row): row is ChangedBundlePatch =>
        typeof row === 'object' && row !== null
        && typeof (row as ChangedBundlePatch).path === 'string'
        && typeof (row as ChangedBundlePatch).bootMtimeMs === 'number'),
    }
  } catch {
    return undefined
  }
}

/** Write the durable sidecar atomically (README-described tmp + rename).
 * Best-effort — never throws (the per-interval warn is the live channel; the
 * sidecar is the durable complement for reports/surfaces). */
export async function writeBundlePatchAlerts(stateDir: string, state: BundlePatchAlertsState): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true })
    const target = join(stateDir, BUNDLE_PATCH_ALERTS_FILE)
    const tmpPath = join(stateDir, `${BUNDLE_PATCH_ALERTS_FILE}.tmp-${Date.now()}`)
    await writeFile(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await rename(tmpPath, target)
  } catch {
    /* a failed sidecar write degrades silently — the warns still fire */
  }
}

/**
 * Install the R3 watchdog into a dshd-core apply. Resolves the active profile
 * (from `--profile` in argv), snapshots the resolved bundle-layer patch mtimes
 * at boot, and arms a per-interval stat check that warns LOUDLY (repeated
 * until restart) + durably (the sidecar) when a bundle-layer patch changed
 * after boot. The interval is a plain `setInterval` cleared by the returned
 * disposer — the caller returns it from `apply`, so the effect is reversible
 * (AGENTS.md rule 4). NEVER throws into apply: a resolution failure warns ONCE
 * and disables the check. ZERO impact on the knob-loading path (read-only).
 * @param ctx - the dshd-core plugin context (logger).
 * @param config - stateDir + the org keys the watchdog reads.
 * @param deps - injectable argv/home/clock (tests).
 * @returns a disposer that clears the interval (the apply's reversible effect).
 */
export function installBundlePatchWatchdog(
  ctx: Context,
  config: BundlePatchWatchConfig,
  deps: BundlePatchWatchdogDeps = {},
): () => void {
  if (config.org?.bundlePatchCheck === false) return () => {}
  const logger = ctx.logger as { warn: (message: string) => void; info?: (message: string) => void }
  const stateDir = config.stateDir
  const intervalMs = typeof config.org?.bundlePatchCheckIntervalMs === 'number'
    && Number.isFinite(config.org.bundlePatchCheckIntervalMs)
    && config.org.bundlePatchCheckIntervalMs > 0
    ? config.org.bundlePatchCheckIntervalMs
    : BUNDLE_PATCH_CHECK_INTERVAL_MS
  const argv = deps.argv ?? process.argv
  const home = deps.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const now = deps.now ?? Date.now
  const profileName = parseProfileNameFromArgv(argv)

  let disabled = false
  let paths: string[] = []
  let boot: PatchMtimeSnapshot = {}

  const resolveOnce = (): void => {
    if (disabled) return
    if (profileName === undefined) {
      disabled = true
      logger.warn(`[deepartments] R3 bundle-layer patch watchdog: no --profile flag in argv — the check is disabled for this process (a bundle-layer knob committed later would stay silently inactive; start the daemon with --profile <name>)`)
      return
    }
    const profileDir = join(home, 'profiles', profileName)
    if (!existsSync(join(profileDir, 'package.json'))) {
      disabled = true
      logger.warn(`[deepartments] R3 bundle-layer patch watchdog: profile ${profileName} not found under ${home} — the check is disabled for this process`)
      return
    }
    paths = resolveBundlePatchPaths(profileDir)
    if (paths.length === 0) {
      disabled = true
      logger.warn(`[deepartments] R3 bundle-layer patch watchdog: no bundle-layer patch files resolved for profile ${profileName} — the check is disabled for this process`)
      return
    }
    boot = snapshotBundlePatchMtimes(paths)
    logger.info?.(`[deepartments] R3 bundle-layer patch watchdog: boot snapshot of ${paths.length} bundle-layer patch file(s) (${profileName}, interval ${intervalMs} ms) — a bundle-layer edit will be announced as 'restart required'`)
  }

  // Snapshot EAGERLY at apply (= the daemon's resolved-at-boot moment), so a
  // patch committed even seconds after boot is caught by the first interval.
  resolveOnce()

  if (disabled) return () => {}

  const check = (): void => {
    if (disabled || paths.length === 0) return
    const changed = findChangedBundlePatches(boot, snapshotBundlePatchMtimes(paths))
    if (changed.length === 0) return
    void writeBundlePatchAlerts(stateDir, { seenAt: now(), changed })
    for (const row of changed) {
      logger.warn(`[deepartments] R3: bundle-layer patch changed — restart required: ${row.path} (boot mtime ${row.bootMtimeMs}, now ${row.nowMtimeMs ?? 'missing'}) — the knob stays INACTIVE until the daemon restarts (watchUserPatches watches only the profile + home user layers)`)
    }
  }

  const timer = setInterval(check, intervalMs)
  return () => clearInterval(timer)
}