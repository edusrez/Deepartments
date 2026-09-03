// dsh-deepartments — LANE ② test resolver hook (ts-src-loader).
//
// The 0.1.2-rc.1 tree builds to the gitignored `lib/`, and the LANE ②
// discipline is 0 builds until the rc.1 jump — so the NEW tests exercise the
// SOURCE (packages/*/src + src/) directly through Node's native type-stripping
// (node --test over src, Node ≥ 22.6). Node's type stripping does NOT rewrite
// import specifiers, so this hook supplies the two resolution seams the src
// graph needs:
//   1. `.js` → `.ts` SIBLING REWRITE for a RELATIVE specifier whose `.js`
//      sibling does not exist but whose `.ts` sibling does (the src modules
//      import `./x.js` per NodeNext while the tree holds `./x.ts`);
//   2. WORKSPACE PACKAGE → SRC INDEX mapping for a `.ts` importer inside the
//      repo: `dshd-core` (and the other `dshd-*` workspace packages) resolve
//      to `packages/<pkg>/src/index.ts` instead of the STALE built lib, so
//      the whole src graph links against the CURRENT source.
// The built-lib tests (parentURL inside `lib/`) are UNTOUCHED — the hook only
// rewrites when the IMPORTER is a `.ts` file inside the repo, so the existing
// lib-based suite runs byte-identical under `node --loader ./test/ts-src-loader.mjs --test`.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The workspace packages whose src index the hook targets (repo-root
 * packages/<pkg>/src/index.ts — every package the src graph imports by name). */
const WORKSPACE_SRC = new Map(
  [
    'dshd-core',
    'dshd-core-min',
    'dshd-feedback',
    'dshd-gui',
    'dshd-health',
    'dshd-jobs',
    'dshd-orchestration',
    'dshd-pooler',
    'dshd-quality',
    'dshd-webfetch'
  ].map((id) => [id, path.join(REPO_ROOT, 'packages', id, 'src', 'index.ts')])
)

function isRepoTs(parentURL) {
  if (typeof parentURL !== 'string') return false
  const file = fileURLToPath(parentURL)
  return file.startsWith(REPO_ROOT + path.sep) && /\.ts$/.test(file)
}

/** The sibling `.ts` for a RELATIVE `.js` specifier: only when the `.js`
 * sibling does NOT exist and the `.ts` sibling DOES (a real `.js` file is
 * never shadowed — the lib/ tree loads byte-identical). */
function tsSiblingFor(specifier, parentURL) {
  if (!specifier.endsWith('.js')) return undefined
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined
  const parentDir = path.dirname(fileURLToPath(parentURL))
  const jsPath = path.resolve(parentDir, specifier)
  const tsPath = jsPath.replace(/\.js$/, '.ts')
  if (existsSync(jsPath)) return undefined
  return existsSync(tsPath) ? pathToFileURL(tsPath).href : undefined
}

export async function resolve(specifier, context, nextResolve) {
  const parentURL = context.parentURL
  if (isRepoTs(parentURL)) {
    // (2) workspace package → src index (the CURRENT source, never the stale lib).
    if (WORKSPACE_SRC.has(specifier)) {
      const target = pathToFileURL(WORKSPACE_SRC.get(specifier)).href
      if (process.env.DSH_TS_LOADER_DEBUG === '1') console.error(`[ts-src-loader] MAP ${specifier} <- ${parentURL}\n            -> ${target}`)
      return await nextResolve(target, context)
    }
    // (1) relative .js → .ts sibling.
    const ts = tsSiblingFor(specifier, parentURL)
    if (ts !== undefined) {
      if (process.env.DSH_TS_LOADER_DEBUG === '1') console.error(`[ts-src-loader] REWRITE ${specifier} <- ${parentURL}\n            -> ${ts}`)
      return await nextResolve(ts, context)
    }
  }
  return nextResolve(specifier, context)
}