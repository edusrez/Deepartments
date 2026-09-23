// dsh-deployments — STALE-LIB GATE test (fb-2673 → fb-2230, fb-1855).
//
// THE HOLE THIS BLINDS: `pnpm build` compiled ONLY the ROOT `src/` (tsconfig
// `"include": ["src"]`), while the runtime RESOLVES each package's compiled
// `lib/` (the `node_modules/dshd-*` symlink targets) — and `lib/` is
// `.gitignore:7`, so the artifact does NOT travel in the commit. MEASURED
// (fb-2673): with the whole ladder GREEN the FIRST restart loaded PRE-FIX code
// (`packages/dshd-core/lib/messages.js` kept its old mtime + 0 occurrences of
// the symbol) and only a forced package rebuild made the SECOND restart load
// the fix. The canonical gate already existed and was documented
// (docs/VERIFICATION-LADDER.md §9) and was STILL SKIPPED, because it was a
// DOC-ONLY obligation (this repo has NO CI — `.github/` absent; AGENTS.md:79).
// So the fix has TWO halves, and this test blinds BOTH:
//   (a) the WIRING: `package.json` "build" IS the gate — the canonical ladder
//       step 1 cannot be run without it (no extra step to forget);
//   (b) the INSTRUMENT: the detector fails loud on a stale or MISSING artifact,
//       including the class the old aggregate "newest src vs oldest lib" rule
//       was structurally BLIND to (a missing output among fresh siblings).
// Hermetic: every fixture is a mkdtemp tree passed via `--root`; the real
// checkout is only read for structural facts (never for global freshness, so a
// concurrent lane's in-flight src edit cannot false-fail this suite).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  ALWAYS_REBUILD,
  REPO_ROOT,
  expectedOutputs,
  internalDeps,
  listTargets,
  sortTopologically,
  staleArtifacts,
} from '../scripts/check-root-build.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/check-root-build.mjs', import.meta.url))
const ROOT_PKG = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    rootDir: 'src', outDir: 'lib', declaration: true, sourceMap: false, skipLibCheck: true,
  },
  include: ['src'],
  exclude: [],
}

/** A minimal mini-CHECKOUT with the REAL shape: a root `package.json` (whose
 * `build:tsc` is the tsc the gate wraps) + one `packages/<name>/` target. The
 * fixture root carries NO `src/`, so the `(root)` target is inert here and the
 * assertions address the package target alone.
 * `stale: true` back-dates the lib by 60s (the fb-2673 shape); `drop` lists
 * lib-relative paths to omit (the MISSING class). */
function makeCheckout(name = 'pkg-a', { stale = false, drop = [], scripts = { build: 'tsc' } } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'stalegate-'))
  const dir = path.join(root, 'packages', name)
  mkdirSync(path.join(root, 'packages'), { recursive: true })
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  mkdirSync(path.join(dir, 'lib'), { recursive: true })
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'mini-checkout', private: true, scripts: { build: 'node scripts/check-root-build.mjs', 'build:tsc': 'tsc' } }, null, 2),
  )
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'lib/index.js', scripts }, null, 2))
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2))
  writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a = 1\n')
  const now = Date.now() / 1000
  for (const [rel, text] of [['lib/index.js', 'export const a = 1\n'], ['lib/index.d.ts', 'export declare const a = 1\n']]) {
    if (drop.includes(rel)) continue
    const abs = path.join(dir, rel)
    writeFileSync(abs, text)
    if (stale) utimesSync(abs, now - 60, now - 60)
  }
  return { root, dir }
}

function cleanup(...dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

/** Run the REAL CLI (never a re-implementation) → {status, stdout, stderr}.
 * spawnSync captures BOTH streams on success AND on failure — the gate prints
 * its verdict to stderr, and execFileSync would discard it on exit 0. */
function runCli(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO_ROOT })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

test('fb-2673 (a) WIRING: package.json "build" IS the gate — the canonical ladder step 1 cannot be run without the stale-artifact check', () => {
  const build = ROOT_PKG.scripts?.build
  assert.equal(
    build,
    'node scripts/check-root-build.mjs',
    'package.json "build" must be the gate itself: the fb-2673 hole was that the ladder was green WITHOUT it, so an extra step that an operator must remember is NOT a fix (doc-only obligation, already skipped once — ladder §9)',
  )
  // The gate's own root tsc step must exist, and must NOT be `pnpm run build`
  // (that is the gate — invoking it inside would recurse forever).
  assert.equal(ROOT_PKG.scripts?.['build:tsc'], 'tsc', 'build:tsc is the real tsc the gate wraps (no recursion)')
  assert.ok(!build.includes('build:tsc'), 'the gate must not be `pnpm run build:tsc` under another name')
  for (const name of ['build:root-check', 'build:check']) {
    assert.match(ROOT_PKG.scripts?.[name] ?? '', /scripts\/check-root-build\.mjs/, `package.json keeps the "${name}" alias wired to the gate`)
  }
})

test('fb-2673 (b) INSTRUMENT: a STALE lib (fb-2673 shape: lib older than its src) is reported per FILE, for BOTH the .js and the .d.ts output', () => {
  const { root, dir } = makeCheckout('pkg-a', { stale: true })
  try {
    const rows = staleArtifacts(root)
    assert.equal(rows.length, 2, `exactly the two stale outputs are reported (got ${JSON.stringify(rows.map((r) => path.basename(r.out)))}; the fixture is fresh except for the back-dated lib)`)
    assert.ok(rows.every((r) => r.kind === 'STALE'), 'both rows are STALE')
    assert.deepEqual(rows.map((r) => path.basename(r.out)).sort(), ['index.d.ts', 'index.js'], 'the .js AND the .d.ts are checked (a stale d.ts is what MASKS the root tsc: fb-266)')
    assert.ok(rows.every((r) => r.deltaSeconds >= 59), 'the row carries the measured age delta (never an unsourced instant)')
    assert.ok(rows.every((r) => r.target === 'pkg-a'), 'the row names the TARGET (the package whose lib the runtime resolves)')
  } finally {
    cleanup(root, dir)
  }
})

test('fb-2673 (b) INSTRUMENT: a MISSING output is RED even while every sibling looks fresh — the class the aggregate rule is structurally BLIND to', () => {
  // The OLD rule (newest src vs OLDEST lib) says "fresh" here: the surviving
  // lib file is newer than src, so the aggregate comparison cannot see the
  // absent one. The identity mapping can.
  const { root, dir } = makeCheckout('pkg-a', { drop: ['lib/index.js'] })
  try {
    const rows = staleArtifacts(root)
    assert.equal(rows.length, 1, `exactly ONE violation (the missing output); got ${JSON.stringify(rows)}`)
    assert.equal(rows[0].kind, 'MISSING', 'the row is MISSING')
    assert.match(rows[0].detail, /index\.js/, 'the row names the missing artifact AND its source')
    // Proof the aggregate rule is blind to THIS state: src is older than the
    // surviving lib, so `newestSrc > oldestLib` is FALSE (looks fresh).
    const srcMs = statSync(path.join(dir, 'src', 'index.ts')).mtimeMs
    const survivingLibMs = statSync(path.join(dir, 'lib', 'index.d.ts')).mtimeMs
    assert.ok(srcMs <= survivingLibMs, 'the surviving lib IS newer than src — an aggregate mtime rule reports fresh here (the blind class this test pins)')
  } finally {
    cleanup(root, dir)
  }
})

test('fb-2673 (b) INSTRUMENT: --check FAILS LOUD (exit 1 + the fix command) on stale/missing and NEVER writes (a detector must not repair behind your back)', () => {
  const { root, dir } = makeCheckout('pkg-a', { stale: true })
  try {
    const libJs = path.join(dir, 'lib', 'index.js')
    const before = { text: readFileSync(libJs, 'utf8'), mtime: statSync(libJs).mtimeMs }
    const res = runCli(['--check', '--root', root])
    assert.equal(res.status, 1, '--check exits 1 on a stale artifact')
    assert.match(res.stderr, /FAIL \(--check\)/, 'the verdict is a LOUD fail — never a silent green')
    assert.match(res.stderr, /STALE/, 'the stale row is printed')
    assert.match(res.stderr, /pnpm build/, 'the fix command is printed (fail loud AND actionable)')
    assert.equal(readFileSync(libJs, 'utf8'), before.text, '--check wrote NOTHING (text byte-identical)')
    assert.equal(statSync(libJs).mtimeMs, before.mtime, '--check wrote NOTHING (mtime untouched)')
  } finally {
    cleanup(root, dir)
  }
})

test('fb-2673 (b) INSTRUMENT: --check on a FRESH target exits 0 with an explicit PASS (the green is earned by measurement, never assumed)', () => {
  const { root, dir } = makeCheckout('pkg-a')
  try {
    assert.deepEqual(staleArtifacts(root), [], 'a fresh tree reports no violation')
    const res = runCli(['--check', '--root', root])
    assert.equal(res.status, 0, `--check exits 0 on a fresh tree (stderr: ${res.stderr})`)
    assert.match(res.stderr, /PASS \(--check\)/, 'the PASS is explicit')
  } finally {
    cleanup(root, dir)
  }
})

test('fb-2673 (b) INSTRUMENT: a target with NO build script is a LOUD violation — the gate never skips a target it cannot repair', () => {
  const { root, dir } = makeCheckout('pkg-a', { scripts: {} })
  try {
    const rows = staleArtifacts(root)
    assert.equal(rows.length, 1, `exactly one violation; got ${JSON.stringify(rows)}`)
    assert.equal(rows[0].kind, 'NO_BUILD_SCRIPT', 'the kind names the real problem (not a silent skip)')
    assert.match(rows[0].detail, /build/, 'the row says which script is missing')
  } finally {
    cleanup(root, dir)
  }
})

test('fb-2673 (b) INSTRUMENT: a tsconfig WITHOUT outDir aborts LOUD (CONFIG row) — refusing to guess beats a guessed green', () => {
  const { root, dir } = makeCheckout('pkg-a')
  try {
    const cfg = { ...TSCONFIG, compilerOptions: { ...TSCONFIG.compilerOptions, outDir: undefined } }
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(cfg, null, 2))
    const rows = staleArtifacts(root)
    assert.equal(rows.length, 1, `exactly one violation; got ${JSON.stringify(rows)}`)
    assert.equal(rows[0].kind, 'CONFIG', 'the kind is CONFIG (a loud config refusal, not an exception and not a pass)')
    assert.match(rows[0].detail, /outDir/, 'the message names the missing key')
  } finally {
    cleanup(root, dir)
  }
})

test('fb-2673 (b) INSTRUMENT: `exclude` is resolved against the TSCONFIG DIR — an excluded src dir is NOT required as an output (no false red)', () => {
  const { root, dir } = makeCheckout('pkg-a')
  try {
    // dshd-gui's real shape: `"exclude": ["src/client"]` for a src/client/index.tsx.
    mkdirSync(path.join(dir, 'src', 'client'))
    writeFileSync(path.join(dir, 'src', 'client', 'index.tsx'), 'export const c = 1\n')
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ ...TSCONFIG, exclude: ['src/client'] }, null, 2))
    assert.deepEqual(staleArtifacts(root), [], 'the excluded src/client output is NOT demanded — the gate must not invent a false stale row')
    assert.equal(expectedOutputs(dir).rows.length, 2, 'only the non-excluded input contributes outputs')
    // Control: WITHOUT the exclude that same input IS demanded (the exclusion is
    // what made the difference — not a silent zero).
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ ...TSCONFIG, exclude: [] }, null, 2))
    const rows = staleArtifacts(root)
    assert.equal(rows.length, 2, 'without the exclude, the client output is MISSING → 2 rows (the .js/.d.ts are demandable again)')
    assert.ok(rows.every((r) => r.kind === 'MISSING'), 'both rows are MISSING')
  } finally {
    cleanup(root, dir)
  }
})

test('fb-2673 (b) INSTRUMENT: a declaration-only input (.d.ts) demands NO emitted output — the gate must not demand what tsc never writes', () => {
  const { root, dir } = makeCheckout('pkg-a')
  try {
    writeFileSync(path.join(dir, 'src', 'globals.d.ts'), 'declare const g: number\nexport { g }\n')
    assert.deepEqual(staleArtifacts(root), [], 'a .d.ts input is declaration-only: no .js/.d.ts output is demanded from it (else every run is a false red)')
  } finally {
    cleanup(root, dir)
  }
})

test('fb-2673 (b) ROUND-TRIP: a repair that exits 0 but leaves the artifact STALE must FAIL — the gate never prints a green its own re-measurement contradicts', () => {
  // THE SILENT GREEN, REPRODUCED. A package build that exits 0 without actually
  // refreshing the lib (`tsc` that wrote nothing, a build script that swallows
  // its error, a no-op override) is EXACTLY the fb-2673 shape: every signal is
  // green and the runtime still loads the old bytes. The gate's step 4 exists to
  // refuse that green, so this test blinds it.
  const { root, dir } = makeCheckout('pkg-a', { stale: true, scripts: { build: 'node -e "process.exit(0)"' } })
  try {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'mini-checkout', private: true, scripts: { build: 'node scripts/check-root-build.mjs', 'build:tsc': 'node -e "process.exit(0)"' } }, null, 2),
    )
    const res = runCli(['--root', root])
    assert.equal(res.status, 1, `the gate MUST exit 1 when the re-measure still finds staleness (got ${res.status})`)
    assert.match(res.stderr, /did NOT achieve freshness/, 'the failure names the real cause (the repair did not work) — never a silent green')
    assert.match(res.stderr, /STALE/, 'the surviving stale row is printed after the repair')
    assert.doesNotMatch(res.stderr, /PASS: packages fresh/, 'no PASS is printed on this path')
    // The lib really was NOT refreshed — the gate reported the truth.
    assert.match(readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8'), /export const a = 1/, 'the fixture lib is unchanged (the repair was a no-op — the state the gate must refuse)')
  } finally {
    cleanup(root, dir)
  }
})

test('fb-2673 (b) ROUND-TRIP: a repair that REALLY refreshes the lib reaches the double PASS — both halves of the verdict are earned by measurement', () => {
  // The positive control for the round-trip above: with a build script that
  // writes fresh outputs, the same command must reach exit 0 and print BOTH the
  // fb-266 verdict AND the artifact-gate verdict.
  const { root, dir } = makeCheckout('pkg-a', { stale: true, scripts: { build: 'node build-ok.mjs' } })
  try {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'mini-checkout', private: true, scripts: { build: 'node scripts/check-root-build.mjs', 'build:tsc': 'node -e "process.exit(0)"' } }, null, 2),
    )
    writeFileSync(
      path.join(dir, 'build-ok.mjs'),
      'import { writeFileSync } from "node:fs"\nwriteFileSync("lib/index.js", "export const a = 2\\n")\nwriteFileSync("lib/index.d.ts", "export declare const a: number\\n")\n',
    )
    const res = runCli(['--root', root])
    assert.equal(res.status, 0, `a real repair must reach exit 0 (got ${res.status}; stderr: ${res.stderr})`)
    assert.match(res.stderr, /regenerated "pkg-a" lib from src \(was stale\)/, 'the repair is reported with the true cause')
    assert.match(res.stderr, /PASS: packages fresh \+ root tsc exit 0/, 'the fb-266 verdict is printed')
    assert.match(res.stderr, /PASS \(artifact gate\): \d+ expected output\(s\) verified/, 'the artifact-gate verdict is printed WITH its measured coverage')
    assert.match(readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8'), /export const a = 2/, 'the lib really was refreshed by the repair')
    // And the tree is now genuinely green read-only.
    assert.deepEqual(staleArtifacts(root), [], 'the post-state is fresh (the PASS was not a lie)')
  } finally {
    cleanup(root, dir)
  }
})

test('fb-2673 (b) ORDER: package rebuilds are TOPOLOGICAL (deps first) — rebuilding a package against its OWN stale deps would re-mask the fb-266 class', () => {
  // The real graph is the contract: orchestration depends on pooler+quality, and
  // pooler on health — so alphabetical order is NOT dependency-safe.
  const all = listTargets(REPO_ROOT).filter((t) => !t.isRoot).map((t) => t.name)
  const orchDeps = internalDeps(REPO_ROOT, 'dshd-orchestration')
  assert.ok(orchDeps.includes('dshd-pooler') && orchDeps.includes('dshd-quality'), `the measured orchestration deps include pooler+quality (got ${JSON.stringify(orchDeps)})`)
  assert.ok(internalDeps(REPO_ROOT, 'dshd-pooler').includes('dshd-health'), 'pooler depends on health')
  const ordered = sortTopologically(REPO_ROOT, ['dshd-orchestration', 'dshd-pooler', 'dshd-quality', 'dshd-health'])
  for (const [pkg, deps] of [['dshd-orchestration', ['dshd-pooler', 'dshd-quality']], ['dshd-pooler', ['dshd-health']]]) {
    for (const dep of deps) {
      assert.ok(ordered.indexOf(dep) < ordered.indexOf(pkg), `${dep} must be rebuilt BEFORE ${pkg} (got ${ordered.join(' → ')})`)
    }
  }
  assert.deepEqual(sortTopologically(REPO_ROOT, all).length, all.length, 'every target appears exactly once (no lost target, no duplicate)')
  // Determinism: the same input yields the same order (stable ties).
  assert.deepEqual(sortTopologically(REPO_ROOT, all), sortTopologically(REPO_ROOT, [...all].reverse()), 'the order is deterministic under input permutation')
  // A cycle must not hang or overflow — it degrades to a deterministic order.
  assert.deepEqual(sortTopologically(REPO_ROOT, ['dshd-core']), ['dshd-core'], 'a leaf sorts to itself')
})

test('fb-2673 (b) COVERAGE: the real checkout has the targets the invariant names — the root (the bundle main:lib/index.js) AND the packages the node_modules symlinks resolve', () => {
  const targets = listTargets(REPO_ROOT)
  const names = targets.map((t) => t.name)
  assert.ok(names.includes('(root)'), 'the ROOT src/ is a target (the ladder step 1 compiles it)')
  const pkgs = new Set(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8') ? Object.keys(JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).dependencies ?? {}) : [])
  const workspacePkgs = [...pkgs].filter((d) => d.startsWith('dshd-'))
  for (const name of workspacePkgs) {
    assert.ok(names.includes(name), `${name} is a workspace dep of the root bundle (its \`lib/\` IS resolved at runtime) → it must be a gate target`)
  }
  assert.ok(ALWAYS_REBUILD.includes('dshd-orchestration'), 'dshd-orchestration stays the ALWAYS-rebuilt fb-266 hot spot (ladder §9)')
  // Structural (never global-freshness — a concurrent lane's in-flight src edit
  // must not false-fail this suite): each real target's mapping is computable
  // and honours its own tsconfig.
  for (const target of targets) {
    const { cfg, rows } = expectedOutputs(target.dir)
    assert.ok(rows.length > 0 || cfg.noEmit, `${target.name}: the src→lib mapping is non-empty (or explicitly noEmit)`)
    assert.ok(cfg.outDir.startsWith(target.dir), `${target.name}: outDir resolves inside the target`)
  }
})
