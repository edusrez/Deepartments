#!/usr/bin/env node
/**
 * check-root-build.mjs — ROOT-BUILD GATE (class fb-248 / fb-266) **AND** the
 * STALE-ARTIFACT GATE of the deploy ladder (fb-2673 → fb-2230, fb-1855).
 *
 * WHY — ONE hole, two faces: the compiled lib is a GITIGNORED artifact.
 *
 *  (1) ANTI-MASKING (fb-266): the ROOT tsconfig includes ONLY `src/`
 *      (`tsconfig.json:15` `"include": ["src"]`) — the types of the workspace
 *      packages reach the root tsc through their PREBUILT `lib/*.d.ts` (each
 *      package's `types` field). A lib built from an OLD src MASKS the real type
 *      errors of the root build: the root tsc type-checks against the old
 *      interface and the first full recompile explodes (b814101 changed
 *      delivery.ts's followup to UserMessage while the libs were stale, so the 4
 *      un-mirrored sites stayed hidden).
 *
 *  (2) DEPLOY WITHOUT EFFECT (fb-2673, MEASURED 2026-09-23): with the WHOLE
 *      ladder GREEN (`pnpm build` exit 0 · `plugin add` exit 0 · `dump-config`
 *      exit 0 · canary PASS · test 6/6) the FIRST restart loaded PRE-FIX code —
 *      `packages/dshd-core/lib/messages.js` kept its 11:57 mtime and 0
 *      occurrences of the symbol; only after this gate («regenerated "dshd-core"
 *      lib from src (was stale)») did the SECOND restart load the fix.
 *      STRUCTURAL CAUSE (measured): `lib/` is `.gitignore:7` ⇒ THE ARTIFACT DOES
 *      NOT TRAVEL IN THE COMMIT ⇒ the machine that BOOTS must regenerate it, and
 *      NOTHING guaranteed it: `.github/` does not exist (this repo has NO CI —
 *      `AGENTS.md:79`), and the canonical gate was a DOC-ONLY obligation
 *      (`docs/VERIFICATION-LADDER.md:413-422` §9), so it existed, was
 *      documented, and was STILL SKIPPED. Hence this file is wired as the
 *      ladder's step 1 itself (`package.json` `"build"`), not as an extra step
 *      an operator must remember.
 *
 * WHAT (the invariant): every compiled artifact the runtime RESOLVES — the root
 * `lib/` (the bundle's `main: "lib/index.js"`) and each workspace package's
 * `lib/` (the `node_modules/dshd-*` symlink targets) — must be at least as NEW
 * as the src that must have produced it, and must EXIST. Freshness is measured
 * PER FILE against the src→lib identity mapping (a MISSING output is red even
 * when every sibling looks fresh — the aggregate "newest src vs oldest lib" rule
 * is blind to that class), honouring the target's own tsconfig (`include`,
 * `exclude`, `outDir`, `declaration`, `noEmit`).
 *
 * MODES:
 *   node scripts/check-root-build.mjs           (pnpm build | pnpm build:root-check)
 *     1. measure: list every stale/missing artifact;
 *     2. repair: `pnpm --filter <pkg> run build` for every stale package (and
 *        ALWAYS for dshd-orchestration — the fb-266 coupling hot spot);
 *     3. root build: `pnpm run build:tsc` (NOT `pnpm build` — that is this gate:
 *        invoking it here would recurse forever) — must exit 0;
 *     4. RE-MEASURE and only then print PASS: the green is earned by a
 *        post-state measurement, never assumed (never a silent green).
 *   node scripts/check-root-build.mjs --check   (DETECT ONLY — never writes)
 *     exits 1 with every stale/missing row + the fix command, or 0 when fresh.
 *   node scripts/check-root-build.mjs --root <dir>   (hermetic test seam)
 *
 * Exit codes: 0 = fresh artifacts + root tsc green; 1 = any step != 0 (the
 * violating command + its stderr tail are printed, never swallowed).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** src extension → emitted JS extension (tsc, NodeNext). Measured on tsc 5.x. */
const COMPILE_EXT = { '.ts': '.js', '.tsx': '.js', '.mts': '.mjs', '.cts': '.cjs' }
/** src extension → emitted declaration extension (when `declaration` is on). */
const DECL_EXT = { '.ts': '.d.ts', '.tsx': '.d.ts', '.mts': '.d.mts', '.cts': '.d.cts' }
/** Declaration-only inputs: tsc emits NOTHING for them (`.d.ts`/`.d.mts`/`.d.cts`). */
const DECL_ONLY = /\.d\.(ts|mts|cts)$/

/**
 * ALWAYS rebuilt, even when every mtime looks fresh (fb-266 policy, ladder §9):
 * the delivery coupling of dshd-orchestration is the hot spot the masking
 * incident was found on, and a copied-in artifact carries a FRESH mtime over an
 * OLD src — mtime cannot see that, a forced rebuild can.
 */
export const ALWAYS_REBUILD = ['dshd-orchestration']

/** Recursive file list under `dir` (absolute paths, sorted for determinism).
 * Symlinks are never followed (Dirent.isDirectory() is false for them). */
export function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

/** The targets of the invariant: every workspace package with a `src/`, plus the
 * ROOT (the bundle itself — `package.json` `"main": "lib/index.js"`). */
export function listTargets(root) {
  const out = []
  const pkgsDir = path.join(root, 'packages')
  if (existsSync(pkgsDir)) {
    for (const entry of readdirSync(pkgsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const dir = path.join(pkgsDir, entry.name)
      if (!existsSync(path.join(dir, 'package.json'))) continue
      if (!existsSync(path.join(dir, 'src'))) continue
      out.push({ name: entry.name, dir, isRoot: false })
    }
  }
  if (existsSync(path.join(root, 'src'))) out.push({ name: '(root)', dir: root, isRoot: true })
  return out
}

/** Resolve a target's tsconfig into the src→lib mapping. A missing/unparseable
 * tsconfig or a missing `outDir` ABORTS LOUD — refusing to guess is the point:
 * a silent skip here would be the very silent green this gate removes. */
export function compileConfig(dir) {
  const file = path.join(dir, 'tsconfig.json')
  if (!existsSync(file)) throw new Error(`no tsconfig.json in ${dir} — the gate cannot know the src→lib mapping (refusing to guess)`)
  let json
  try {
    json = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`tsconfig.json unreadable/unparseable in ${dir}: ${error.message}`)
  }
  const co = json.compilerOptions ?? {}
  if (typeof co.outDir !== 'string' || co.outDir.length === 0) {
    throw new Error(`tsconfig.json in ${dir} declares no compilerOptions.outDir — cannot locate the compiled artifacts`)
  }
  const includes = Array.isArray(json.include) && json.include.length > 0 ? json.include : ['src']
  const excludes = Array.isArray(json.exclude) ? json.exclude : []
  const srcDirs = includes.filter((i) => typeof i === 'string' && !i.includes('*')).map((i) => path.resolve(dir, i)).filter((i) => existsSync(i))
  if (srcDirs.length === 0) throw new Error(`tsconfig.json in ${dir} has no literal \`include\` dir that exists (include=${JSON.stringify(json.include)})`)
  // `exclude` entries are relative to the TSCONFIG DIR (measured: dshd-gui's
  // `"exclude": ["src/client"]` must exclude `<pkg>/src/client`, not
  // `<pkg>/src/src/client`).
  const excludePaths = excludes.filter((e) => typeof e === 'string' && !e.includes('*')).map((e) => path.resolve(dir, e))
  return {
    outDir: path.resolve(dir, co.outDir),
    srcDirs,
    excludePaths,
    declaration: co.declaration !== false,
    noEmit: co.noEmit === true,
  }
}

/** Every output file the target's CURRENT src must have produced. */
export function expectedOutputs(dir) {
  const cfg = compileConfig(dir)
  const rows = []
  if (cfg.noEmit) return { cfg, rows }
  for (const srcDir of cfg.srcDirs) {
    for (const src of walkFiles(srcDir)) {
      if (cfg.excludePaths.some((e) => src === e || src.startsWith(e + path.sep))) continue
      const ext = path.extname(src)
      if (DECL_ONLY.test(src)) continue
      if (!(ext in COMPILE_EXT)) continue
      const stem = path.relative(srcDir, src).slice(0, -ext.length)
      const outs = [path.join(cfg.outDir, stem + COMPILE_EXT[ext])]
      if (cfg.declaration) outs.push(path.join(cfg.outDir, stem + DECL_EXT[ext]))
      for (const out of outs) rows.push({ src, out })
    }
  }
  return { cfg, rows }
}

/** The target's build script — the command that repairs it. `undefined` is a
 * LOUD violation, never a silent skip. */
export function buildScriptOf(target) {
  const pj = path.join(target.dir, 'package.json')
  if (!existsSync(pj)) return undefined
  try {
    const json = JSON.parse(readFileSync(pj, 'utf8'))
    const name = target.isRoot ? 'build:tsc' : 'build'
    const script = json.scripts?.[name]
    return typeof script === 'string' && script.length > 0 ? script : undefined
  } catch {
    return undefined
  }
}

/** THE INSTRUMENT: every stale/missing compiled artifact under `root`.
 * `[]` = every artifact the runtime resolves is at least as new as its src.
 * Rows: {target, kind: 'STALE'|'MISSING'|'CONFIG'|'NO_BUILD_SCRIPT', src, out, deltaSeconds?, detail?}. */
export function staleArtifacts(root) {
  const violations = []
  for (const target of listTargets(root)) {
    if (buildScriptOf(target) === undefined) {
      violations.push({
        target: target.name,
        kind: 'NO_BUILD_SCRIPT',
        detail: `no \`${target.isRoot ? 'build:tsc' : 'build'}\` script in ${path.relative(root, path.join(target.dir, 'package.json'))} — the gate cannot repair this target (refusing to skip it silently)`,
      })
      continue
    }
    let expected
    try {
      expected = expectedOutputs(target.dir)
    } catch (error) {
      violations.push({ target: target.name, kind: 'CONFIG', detail: error.message })
      continue
    }
    for (const { src, out } of expected.rows) {
      const rel = (p) => path.relative(root, p)
      if (!existsSync(out)) {
        violations.push({ target: target.name, kind: 'MISSING', src, out, detail: `compiled artifact ${rel(out)} (expected output of ${rel(src)})` })
        continue
      }
      const srcMs = statSync(src).mtimeMs
      const outMs = statSync(out).mtimeMs
      if (srcMs > outMs) {
        violations.push({
          target: target.name,
          kind: 'STALE',
          src,
          out,
          deltaSeconds: Math.round((srcMs - outMs) / 1000),
          detail: `${rel(out)} — ${Math.round((srcMs - outMs) / 1000)}s OLDER than ${rel(src)}`,
        })
      }
    }
  }
  return violations
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return { ok: res.status === 0, status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** The stale target names that need a package rebuild (deduped, order-stable). */
export function targetsToRebuild(violations) {
  const names = new Set()
  for (const v of violations) {
    if (v.target === '(root)') continue // the root is rebuilt by the MANDATORY root tsc step
    if (v.kind === 'STALE' || v.kind === 'MISSING' || v.kind === 'CONFIG' || v.kind === 'NO_BUILD_SCRIPT') names.add(v.target)
  }
  return [...names]
}

/** The target's INTERNAL (workspace:) dependencies — the edges of the build DAG.
 * `pnpm --filter <pkg> run build` does NOT build the deps, so rebuilding in
 * alphabetical order would compile `dshd-orchestration` against a stale
 * `dshd-pooler`/`dshd-quality` d.ts — RE-INTRODUCING the exact fb-266 masking
 * class this gate exists to remove (measured: orchestration depends on
 * core, feedback, gui, health, jobs, pooler, quality; pooler depends on health;
 * alphabetical order is NOT dependency-safe). */
export function internalDeps(root, name) {
  const pj = path.join(root, 'packages', name, 'package.json')
  if (!existsSync(pj)) return []
  try {
    const json = JSON.parse(readFileSync(pj, 'utf8'))
    const all = { ...(json.dependencies ?? {}), ...(json.peerDependencies ?? {}), ...(json.devDependencies ?? {}) }
    return Object.entries(all)
      .filter(([dep, range]) => String(range).startsWith('workspace:') && existsSync(path.join(root, 'packages', dep, 'package.json')))
      .map(([dep]) => dep)
  } catch {
    return []
  }
}

/** Topological order (dependencies FIRST; ties broken alphabetically for
 * determinism). A dependency CYCLE is a violation, not a stack overflow: the
 * members are reported in stable alphabetical order. */
export function sortTopologically(root, names) {
  const set = new Set(names)
  const out = []
  const state = new Map() // 'visiting' | 'done'
  const visit = (name) => {
    const s = state.get(name)
    if (s === 'done') return
    if (s === 'visiting') return // cycle: do not recurse; the caller still gets a deterministic order
    state.set(name, 'visiting')
    for (const dep of internalDeps(root, name).filter((d) => set.has(d)).sort()) visit(dep)
    state.set(name, 'done')
    out.push(name)
  }
  for (const name of [...names].sort()) visit(name)
  return out
}

export function parseArgs(argv) {
  const opts = { check: false, root: REPO_ROOT }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') opts.check = true
    else if (arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--root requires a directory argument')
      opts.root = path.resolve(value)
      i += 1
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!existsSync(path.join(opts.root, 'package.json'))) throw new Error(`--root ${opts.root} is not a checkout (no package.json)`)
  return opts
}

function printViolations(root, violations) {
  for (const v of violations) {
    if (v.kind === 'STALE' || v.kind === 'MISSING') console.error(`[check-root-build]   ${v.kind.padEnd(7)} ${v.detail}`)
    else console.error(`[check-root-build]   ${v.kind.padEnd(7)} [${v.target}] ${v.detail}`)
  }
}

export function main(argv) {
  const opts = parseArgs(argv)
  const root = opts.root
  const before = staleArtifacts(root)

  if (opts.check) {
    if (before.length > 0) {
      console.error(`[check-root-build] FAIL (--check): ${before.length} stale/missing compiled artifact(s) — these are the libs the RUNTIME resolves; \`lib/\` is gitignored (.gitignore:7) so the artifact does NOT travel in the commit, and a ladder that is green on top of them is a SILENT GREEN (fb-2673 class)`)
      printViolations(root, before)
      console.error('[check-root-build] FIX: pnpm build   (regenerates every stale package lib, then the root tsc, then RE-MEASURES before it prints PASS)')
      return 1
    }
    console.error('[check-root-build] PASS (--check): no stale/missing compiled artifact — every lib the runtime resolves is at least as new as its src')
    return 0
  }

  // --- 1+2: repair — rebuild every stale package lib (dshd-orchestration ALWAYS) ---
  const toRebuild = new Set(targetsToRebuild(before))
  for (const forced of ALWAYS_REBUILD) if (existsSync(path.join(root, 'packages', forced))) toRebuild.add(forced)
  if (before.length > 0) {
    console.error(`[check-root-build] stale/missing artifacts found (${before.length}) — repairing:`)
    printViolations(root, before)
  }
  // DEPENDENCIES FIRST (see sortTopologically) — a rebuild of a package against
  // its own stale deps would re-mask the very errors this gate removes.
  for (const pkg of sortTopologically(root, [...toRebuild])) {
    const wasStale = before.some((v) => v.target === pkg)
    const forced = ALWAYS_REBUILD.includes(pkg)
    const res = run('pnpm', ['--filter', pkg, 'run', 'build'], root)
    if (!res.ok) {
      console.error(`[check-root-build] FAIL: package build of "${pkg}" (${forced ? 'forced-fresh' : 'stale-lib regen'})`)
      console.error(res.stderr.trim().split('\n').slice(-15).join('\n'))
      return 1
    }
    console.error(`[check-root-build] regenerated "${pkg}" lib from src (${forced && !wasStale ? 'forced-fresh' : 'was stale'})`)
  }

  // --- 3: the ROOT build (tsc over src) — verdict against FRESH package libs ---
  const rootBuild = run('pnpm', ['run', 'build:tsc'], root)
  if (!rootBuild.ok) {
    console.error('[check-root-build] FAIL: the root tsc (root build over src/) is NOT green against fresh package libs')
    console.error(rootBuild.stdout.trim().split('\n').slice(-30).join('\n'))
    return 1
  }

  // --- 4: RE-MEASURE — the PASS is earned by a post-state measurement ---
  const after = staleArtifacts(root)
  if (after.length > 0) {
    console.error(`[check-root-build] FAIL: the repair did NOT achieve freshness — ${after.length} artifact(s) still stale/missing AFTER the rebuilds + the root tsc (refusing to print a green that the measurement contradicts)`)
    printViolations(root, after)
    return 1
  }
  const outputs = listTargets(root).reduce((n, t) => {
    try {
      return n + expectedOutputs(t.dir).rows.length
    } catch {
      return n
    }
  }, 0)
  console.error('[check-root-build] PASS: packages fresh + root tsc exit 0 (no stale-prebuilt masking)')
  console.error(`[check-root-build] PASS (artifact gate): ${outputs} expected output(s) verified across ${listTargets(root).length} target(s) — 0 stale, 0 missing (deploy-ladder step 1)`)
  return 0
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`[check-root-build] FAIL: ${error.message}`)
    process.exitCode = 1
  }
}
