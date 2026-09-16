// sidebarfix1 — resolve hook for the session-list lane.
//
// The session fix lives in an INSTALLED harness artifact, not in this repo, so
// the lane's test builds its subjects in a TEMP dir from the deployment tree:
//   <tmp>/pristine/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js
//   <tmp>/patched/… (the same file with patches/dsh-api-session-controller-list-archived.patch applied)
//
// Two things must hold for that to work:
//   1. those files must load as ESM even though the temp dir has no
//      package.json (Node would otherwise treat `.js` as CommonJS), and
//   2. their BARE specifiers must resolve against the TREE's node_modules — the
//      repo pins different harness versions, so letting the repo win would test
//      the wrong runtime (measured: the repo's dsh-llm does not export the symbol
//      the tree's controller imports).
//
// Read-only on the tree: nothing under /opt/dsh is ever written here.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const TREE = process.env.DSH_DEV_TREE || '/opt/dsh/trees/deepartments-dev-0.1.5-rc.2'
const TREE_NM = path.join(TREE, 'node_modules')
const treeRequire = createRequire(path.join(TREE_NM, 'noop.js'))

/** The temp dirs this lane builds (see the test). */
const ARM_MARKER = '/sidebarfix1-arms-'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('node:')) return { url: specifier, shortCircuit: true }
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
    return nextResolve(specifier, context)
  }
  // EVERY bare specifier resolves against the deployment tree first.
  try {
    return { url: `file://${treeRequire.resolve(specifier)}`, shortCircuit: true }
  } catch {
    return nextResolve(specifier, context)
  }
}

export async function load(url, context, nextLoad) {
  // The lane's temp subjects load verbatim as ESM (no package.json beside them).
  if (url.startsWith('file:') && url.includes(ARM_MARKER) && url.endsWith('.js')) {
    let source = fs.readFileSync(new URL(url), 'utf8')
    // DECLARED TEST SEAM (fb-512 oracle note): the shipped bundle does not export
    // the `ApiSessionList` class — the exact unit this fix patches — so the test
    // could not reach it otherwise. This appends that ONE export line.
    //
    // It is applied IDENTICALLY to BOTH arms, in memory only, and is NEVER
    // written to disk: the tracked patch is produced by diffing the two files on
    // disk, which this seam does not touch. It adds a binding, not a behaviour.
    if (source.includes('var ApiSessionList = class')) source += '\nexport { ApiSessionList };\n'
    return { format: 'module', source, shortCircuit: true }
  }
  return nextLoad(url, context)
}
