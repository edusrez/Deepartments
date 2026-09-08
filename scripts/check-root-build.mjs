#!/usr/bin/env node
/**
 * check-root-build.mjs — FB-266 ROOT-BUILD GATE (class fb-248: «los prebuilt NO
 * deben enmascarar»).
 *
 * WHY: the ROOT tsconfig includes ONLY `src/` — the types of the workspace
 * packages reach the root tsc through their PREBUILT `lib/*.d.ts` (each
 * package's `types` field). A stale lib (built from an OLD package src) MASKES
 * the real type errors of the root build: the root tsc type-checks against the
 * old interface, the first time the packages are recompiled from current src
 * the root build explodes (the exact fb-266 shape: b814101 changed
 * delivery.ts's followup to UserMessage but the libs were stale, so the 4
 * un-mirrored sites stayed masked until a full recompile).
 *
 * WHAT: the gate REGENERATES every workspace package lib from its current src
 * (forcing the d.ts to TRUTH) and THEN runs the root tsc — so the root verdict
 * never rides on a stale artifact:
 *   1. staleness scan: any package lib (its "lib" tree of d.ts files) OLDER
 *      than its src is stale → regenerated (missing lib = stale by default,
 *      so a pristine checkout is also forced-fresh);
 *   2. regenerate: runs `pnpm --filter <name> run build` for every stale
 *      package (and ALWAYS for dshd-orchestration — the delivery coupling is
 *      the fb-266 hot spot, printed when forced);
 *   3. root build: `pnpm build` (root tsc over src) — must exit 0.
 * Any non-zero step fails the gate loudly (never swallowed).
 *
 * USE (verification ladder — see docs/VERIFICATION-LADDER.md §9):
 *   pnpm build:root-check
 * A lane touching package src or the root build wiring runs this INSTEAD of
 * the bare `pnpm build` — it is the anti-masking form of the root build.
 *
 * Exit codes: 0 = fresh packages + root tsc green; 1 = a package build or the
 * root tsc failed (the violating command + its stderr tail are printed).
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const PACKAGES_DIR = path.join(ROOT, 'packages')

/** All workspace package dirs (each has a package.json + a "build": "tsc"). */
function packageDirs() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(PACKAGES_DIR, d.name, 'package.json')))
    .map((d) => d.name)
}

/** True when the package lib is likely STALE relative to its src: the newest
 * src file is newer than the OLDEST lib d.ts (or lib is missing). */
function isStaleLib(pkgDir) {
  const srcDir = path.join(PACKAGES_DIR, pkgDir, 'src')
  const libDir = path.join(PACKAGES_DIR, pkgDir, 'lib')
  if (!existsSync(srcDir) || !existsSync(libDir)) return true
  const newestSrc = walkMtimes(srcDir).reduce((m, t) => Math.max(m, t), 0)
  const oldestLib = walkMtimes(libDir).reduce((m, t) => (m === 0 || t < m ? t : m), 0)
  if (oldestLib === 0) return true
  return newestSrc > oldestLib
}

/** Recursive mtime list of every file under `dir` (empty dir → []). */
function walkMtimes(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkMtimes(full))
    else if (entry.isFile()) out.push(statSync(full).mtimeMs)
  }
  return out
}

function run(cmd, args, { cwd = ROOT } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return { ok: res.status === 0, status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

// --- 1+2: regenerate stale package libs (dshd-orchestration ALWAYS — fb-266 hot spot) ----
const stale = []
for (const pkg of packageDirs()) {
  const always = pkg === 'dshd-orchestration'
  if (always || isStaleLib(pkg)) stale.push({ pkg, forced: always })
}
for (const { pkg, forced } of stale) {
  const res = run('pnpm', ['--filter', pkg, 'run', 'build'], { cwd: ROOT })
  if (!res.ok) {
    console.error(`[check-root-build] FAIL: package build of "${pkg}" (${forced ? 'forced-fresh' : 'stale-lib regen'})`)
    console.error(res.stderr.trim().split('\n').slice(-15).join('\n'))
    process.exit(1)
  }
  console.error(`[check-root-build] regenerated "${pkg}" lib from src (${forced ? 'forced-fresh' : 'was stale'})`)
}

// --- 3: the ROOT build (tsc over src) — verdict against FRESH packages ----
const root = run('pnpm', ['build'])
if (!root.ok) {
  console.error('[check-root-build] FAIL: the root tsc (root build over src/) is NOT green against fresh package libs')
  console.error(root.stdout.trim().split('\n').slice(-30).join('\n'))
  process.exit(1)
}
console.error('[check-root-build] PASS: packages fresh + root tsc exit 0 (no stale-prebuilt masking)')
process.exit(0)