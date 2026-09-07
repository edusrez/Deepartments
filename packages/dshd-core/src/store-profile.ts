// dsh-deepartments — LANE fb-134 (store separation) F2(a): the `.store-profile`
// STORE CLAIM MARKER + assert-on-open, plus the F2(c) GHOST-STORE TREE SCAN.
//
// The runtime `stateDir` is RELATIVE (`.deepartments`, cordis.patch.yml:43) and
// resolves against the process CWD — so any composition with a DIFFERENT cwd
// (a headless smoke, a CLI run from the repo, a pre-flight) resolves the SAME
// relative name to a PARALLEL tree that LOOKS canonical (the fb-134 class: the
// host reconciled a crashStreak against the stale /root/.deepartments copy).
// The store cannot be told apart by its own files (identical names), so the
// FIRST opener claims the store by writing a `.store-profile` marker that
// records WHICH profile/home/host opened it; every later open asserts the
// marker — a MISMATCH (a different profile writing the same store) is the
// split-brain class (08-22/08-25) and fires a warn + health-alert. Separating
// stores is a CWD decision (systemd WorkingDirectory per unit — F1, owner-
// gated); this module only makes the ambiguity VISIBLE. Everything here is
// NON-DESTRUCTIVE: a claim writes ONLY the marker (never touches the store's
// own files), a mismatch NEVER deletes/renames/overwrites the foreign marker.
//
// NO export default (pitfall 0001 — breaks `inject`).
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, realpathSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseProfileNameFromArgv } from './bundle-patches.js'

/** The store-claim marker file: `<stateDir>/.store-profile`. */
export const STORE_PROFILE_FILE = '.store-profile'

/** One `.store-profile` claim record — WHO opened the store first. */
export interface StoreProfileMark {
  /** The profile identity: the `--profile <name>` argv value (absent → the
   * fallback string below). Two DIFFERENT profiles cannot share a store. */
  profile: string
  /** The DSH_HOME (absent → `homedir()`/'.dsh'). A home change re-claims. */
  home: string
  /** The hostname — a store mounted across hosts is a shared-store suspect. */
  host: string
  /** The RESOLVED absolute store path (realpath-normalized). */
  storeDir: string
  /** The claim moment (ms epoch). */
  createdAt: number
}

/** The profile-name fallback when argv carries no `--profile` flag. */
export const STORE_PROFILE_FALLBACK_PROFILE = '(no-profile)'

/** The profile identity string used in warn frames (compact, one line). */
export function storeProfileLabel(mark: StoreProfileMark): string {
  return `${mark.profile}@${mark.host}:${mark.home}`
}

/** Derive the CURRENT opener identity for a store. Pure — no I/O. */
export function deriveStoreProfileMark(
  storeDir: string,
  opts: { argv?: readonly string[]; home?: string; host?: string; now?: number } = {},
): StoreProfileMark {
  const argv = opts.argv ?? process.argv
  const home = opts.home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return {
    profile: parseProfileNameFromArgv(argv) ?? STORE_PROFILE_FALLBACK_PROFILE,
    home,
    host: opts.host ?? os.hostname(),
    storeDir: path.resolve(storeDir),
    createdAt: opts.now ?? Date.now(),
  }
}

/** Resolve the marker path of a store. */
export function resolveStoreProfilePath(storeDir: string): string {
  return path.join(storeDir, STORE_PROFILE_FILE)
}

/** Read the stored claim of a store. `undefined` when absent/unreadable/
 * malformed (never throws) — the first-open case. */
export function readStoreProfile(storeDir: string): StoreProfileMark | undefined {
  try {
    const parsed = JSON.parse(readFileSync(resolveStoreProfilePath(storeDir), 'utf8')) as Record<string, unknown>
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof parsed.profile === 'string' &&
      typeof parsed.home === 'string' &&
      typeof parsed.host === 'string' &&
      typeof parsed.storeDir === 'string' &&
      typeof parsed.createdAt === 'number'
    ) {
      return {
        profile: parsed.profile,
        home: parsed.home,
        host: parsed.host,
        storeDir: parsed.storeDir,
        createdAt: parsed.createdAt,
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Write a claim marker (mkdir -p the store dir, then the file). Only the
 * FIRST opener claims — an existing marker is NEVER overwritten here. */
export function writeStoreProfile(storeDir: string, mark: StoreProfileMark): void {
  try {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(resolveStoreProfilePath(storeDir), JSON.stringify(mark, null, 2), 'utf8')
  } catch {
    /* never throws — a failed claim degrades to no marker (the store still
       works; the split-brain guard is best-effort observability) */
  }
}

/** True when two claims describe the SAME opener (profile+home+host equal).
 * The storeDir is a path fact, not part of the identity. */
export function storeProfileMatches(a: StoreProfileMark, b: StoreProfileMark): boolean {
  return a.profile === b.profile && a.home === b.home && a.host === b.host
}

/** The assert-on-open verdict. */
export type StoreProfileAssert =
  | { status: 'claimed' | 'ok'; mark: StoreProfileMark }
  | { status: 'mismatch'; mark: StoreProfileMark; existing: StoreProfileMark }

/** ASSERT the store claim on OPEN (non-destructive):
 *  - marker ABSENT → the current opener CLAIMS the store (writes the marker);
 *  - marker PRESENT + SAME identity → ok (a re-open by the same profile);
 *  - marker PRESENT + DIFFERENT identity → `mismatch` (the caller warns +
 *    emits the health-alert); the foreign marker is NEVER touched.
 *  - A store dir that does not exist is left alone (no claim on a phantom).
 * Returns the verdict; NEVER throws. */
export function assertStoreProfile(
  storeDir: string,
  opts: { argv?: readonly string[]; home?: string; host?: string; now?: number } = {},
): StoreProfileAssert {
  const current = deriveStoreProfileMark(storeDir, opts)
  if (!existsSync(path.resolve(storeDir))) {
    // A phantom store (the dir was never created) — nothing to claim.
    return { status: 'claimed', mark: current }
  }
  const existing = readStoreProfile(storeDir)
  if (existing === undefined) {
    writeStoreProfile(storeDir, current)
    return { status: 'claimed', mark: current }
  }
  return storeProfileMatches(existing, current)
    ? { status: 'ok', mark: current }
    : { status: 'mismatch', mark: current, existing }
}

// ---------------------------------------------------------------------------
// F2(c) — GHOST-STORE TREE SCAN (boot): a PARALLEL tree (a non-canonical
// `.deepartments` resolved from another cwd — the headless-smoke / repo-cwd /
// CLI-cwd footprints of STORES-MAP §2.2) that carries store MARKER FILES
// (boot-crash.json, capacity-gate-state.json) is a GHOST STORE: it can be
// mistaken for the canonical store by a reconciler. The scan is READ-ONLY
// (existsSync/stat only — 0 destructive action) and flags the trees it finds;
// the caller emits a health-alert (ADVERTENCIA). The canonical stateDir itself
// is always excluded (its own boot-crash.json/capacity-gate-state.json are
// legitimate — §7.2's duplicate lives in the REPO-RELATIVE leftover). */
// ---------------------------------------------------------------------------

/** The store marker files a ghost-store tree is recognized by (fb-134 §7.2:
 * `boot-crash.json` + `capacity-gate-state.json` — the files whose DUPLICATE
 * presence in a parallel tree confused the crashStreak reconcile). */
export const GHOST_STORE_MARKER_FILES = ['boot-crash.json', 'capacity-gate-state.json']

/** ONE ghost-store tree finding: the tree path + the marker files present. */
export interface GhostStoreTreeNode {
  /** The parallel tree path (the non-canonical `.deepartments` dir). */
  tree: string
  /** The marker files found inside it. */
  markers: string[]
}

/** Scan explicit candidate TREES for ghost-store markers. The canonical
 * `stateDir` (realpath-normalized) is ALWAYS excluded — its OWN marker files
 * are legitimate. PURE + READ-ONLY (existsSync/statSync only; never writes).
 * A candidate that is missing/unreadable degrades to no finding. */
export function scanGhostStoreTrees(
  stateDir: string,
  candidates: readonly string[],
  markerFiles: readonly string[] = GHOST_STORE_MARKER_FILES,
): GhostStoreTreeNode[] {
  const canonical = realpathSafe(stateDir)
  const out: GhostStoreTreeNode[] = []
  for (const candidate of candidates) {
    const candidateAbs = path.resolve(candidate)
    if (candidateAbs === canonical) continue // the LIVE store — never a ghost
    if (!existsSync(candidateAbs)) continue
    const markers = markerFiles.filter((name) => existsSync(path.join(candidateAbs, name)))
    if (markers.length > 0) out.push({ tree: candidateAbs, markers })
  }
  return out
}

/** realpath with a fail-safe to the non-resolved path (never throws). */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

// ---------------------------------------------------------------------------
// F2(b) — STALE-READ CAP (the M1 `stateStaleMs` pattern on store-file reads):
// a store-file READ that finds the file OLDER than the staleness window is a
// STALE read — the file may come from a PARALLEL/stale store (the fb-134
// class) or be legitimately old; the caller must know so it never trusts the
// data as fresh. NON-DESTRUCTIVE: the read still returns what it read; it just
// warns (opt-in via the logger) with the DX hint of the fb-119/135/146 family
// («path no existe — usa glob»). Default window = the M1 code default.
// ---------------------------------------------------------------------------

/** The default stale-read window (ms): the M1 `stateStaleMs` code default
 * (10 min = POOLER_CAPACITY_DEFAULT_STATE_STALE_MS in dshd-health). */
export const STORE_FILE_STALE_DEFAULT_MS = 10 * 60 * 1000

/** The optional opts of a stale-capable store-file read. */
export interface StoreFileReadOpts {
  /** The staleness window (ms). Absent → `STORE_FILE_STALE_DEFAULT_MS`. */
  staleAfterMs?: number
  /** An optional warn-capable logger (absent → the staleness is silent). */
  logger?: { warn(message: string): void }
  /** The read's clock (ms epoch) — injectable for deterministic tests. */
  now?: number
}

/** The STALE-READ warn frame: names the file, the age, and carries the DX
 * hint of the fb-119/135/146 family («path no existe — usa glob»). */
export function staleReadWarn(filePath: string, mtimeMs: number, nowMs: number, windowMs: number): string {
  const ageMin = Math.round((nowMs - mtimeMs) / 60_000)
  const windowMin = Math.round(windowMs / 60_000)
  return `store read STALE: ${filePath} is ${ageMin} min old (> ${windowMin} min window) — the file may come from a stale/parallel store or be a wrong path: if the path "no existe", use glob to resolve the canonical store path (fb-119/135/146)`
}

/** Check a file's mtime against the staleness window and warn when stale.
 * Returns `true` when the read is STALE. NON-DESTRUCTIVE — the caller decides
 * what a stale read means (never affects the returned data). */
export function checkStoreFileStale(filePath: string, opts: StoreFileReadOpts = {}): boolean {
  try {
    const nowMs = opts.now ?? Date.now()
    const windowMs = opts.staleAfterMs !== undefined && Number.isFinite(opts.staleAfterMs) && opts.staleAfterMs > 0
      ? opts.staleAfterMs
      : STORE_FILE_STALE_DEFAULT_MS
    const st = statSync(filePath)
    const stale = nowMs - st.mtimeMs > windowMs
    if (stale) opts.logger?.warn(staleReadWarn(filePath, st.mtimeMs, nowMs, windowMs))
    return stale
  } catch {
    return false // missing/unreadable → the callers already degrade silently
  }
}