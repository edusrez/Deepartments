// fb-1289 (QD inspector, adopted by IPH — GUARD DEFECT, security class): the
// dept_exec scope guard decided on the TEXTUAL FORM of a path. Only
// `/`-leading words were scope-checked (`deptExecPathTokens`, src/invoke.ts),
// so a RELATIVE multi-segment traversal (`../…`) was NEVER inspected: the SAME
// destination was DENIED in absolute form and ALLOWED by `../`.
//
// This test is the two-legged symmetry law of the fix + its controls:
//   (1) THE PAIR (fb-1289 proper): an out-of-scope destination reachable from
//       the guard cwd gets the SAME verdict in both forms — DENY/DENY. RED
//       without the canonicalization fix (the relative leg was ALLOW while the
//       absolute leg was DENY), GREEN with it.
//   (2) POSITIVE CONTROL A (the fix must not OPEN the guard): a genuinely
//       out-of-scope path stays DENIED by BOTH forms.
//   (3) POSITIVE CONTROL B (the fix must not deny all `..`): a destination
//       that really IS inside an allowed root stays ALLOWED by BOTH forms —
//       absolute AND via a `../` traversal that lands inside the root. This is
//       what stops «deny every `..`» from passing as a fix.
//   (4) POSITIVE CONTROL C (highest-value security leg): the protected stable
//       profile `/opt/dsh/.dsh` stays DENIED by BOTH forms (no mission grant).
//
// The guard is the PURE `deptExecDenyReason` the dept_exec tool runs
// (src/invoke.ts; the tool realpath's cwd + roots before calling it). Tests run
// against the compiled lib/ (pnpm build first) — same convention as the other
// guard tests (test/r5-dx-guards.test.js, test/invoke.test.js).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { deptExecDenyReason } from '../lib/invoke.js'

/** The guard's verdict as one token, so the two FORMS of a destination are
 * comparable with a single assertion (the whole point of fb-1289). */
function verdict(cmd, cwd, roots) {
  return deptExecDenyReason(cmd, cwd, roots) === undefined ? 'ALLOW' : 'DENY'
}

test('fb-1289 — the guard is FORM-BLIND: one destination, two forms (absolute vs relative `../`), ONE verdict', async () => {
  // A REAL tree (realpath'd) so the guard sees genuine `..` resolution and a
  // genuine outside-the-roots sibling directory.
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'fb1289-')))
  const root = path.join(base, 'scoped')          // the ONLY allowed root
  const ws = path.join(root, 'dept-ws')           // the guard cwd (a real dir)
  const insideDir = path.join(root, 'shared')     // IN-root destination
  const outsideDir = path.join(base, 'outside')   // OUT-of-root destination
  await mkdir(ws, { recursive: true })
  await mkdir(insideDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  await writeFile(path.join(insideDir, 'in.txt'), 'in\n')
  await writeFile(path.join(outsideDir, 'out.txt'), 'out\n')
  const roots = [root]

  // The relative forms as the SHELL would resolve them from `ws`:
  // ws = base/scoped/dept-ws → `../..` = base → `base/outside/out.txt`.
  const absOut = path.join(outsideDir, 'out.txt')
  const relOut = '../../outside/out.txt'
  assert.equal(path.resolve(ws, relOut), absOut, 'the fixture relative form resolves to the SAME destination as the absolute form')

  // ---- (1) THE PAIR (fb-1289): same destination, two forms → same verdict.
  const pairAbs = verdict(`cat ${absOut}`, ws, roots)
  const pairRel = verdict(`cat ${relOut}`, ws, roots)
  assert.deepEqual(
    [pairAbs, pairRel],
    ['DENY', 'DENY'],
    `fb-1289: the SAME out-of-scope destination must be DENIED in BOTH forms — absolute=${pairAbs}, relative=${pairRel} (before the fix the relative form was ALLOW: an evadable denial)`
  )

  // The order/lexical symmetry law, stated directly: whatever the absolute
  // form decides, the relative form decides the same.
  assert.equal(pairRel, pairAbs, 'fb-1289 symmetry: verdict(relative) === verdict(absolute)')

  // ---- (2) POSITIVE CONTROL A: genuinely out-of-scope, denied by BOTH forms.
  // ws is under /tmp → four `..` reach `/`, then `etc/hostname`.
  const ctrlA = ['cat /etc/hostname', 'cat ../../../../etc/hostname']
  const ctrlAVerdicts = ctrlA.map((cmd) => verdict(cmd, ws, roots))
  assert.deepEqual(ctrlAVerdicts, ['DENY', 'DENY'], `control A: an out-of-scope path stays DENIED by both forms — got ${JSON.stringify(ctrlAVerdicts)}`)

  // ---- (3) POSITIVE CONTROL B: really inside the root → ALLOWED by both forms.
  const absIn = path.join(insideDir, 'in.txt')
  const relIn = '../shared/in.txt'
  assert.equal(path.resolve(ws, relIn), absIn, 'the in-root relative form resolves to the SAME in-root destination')
  const ctrlB = [verdict(`cat ${absIn}`, ws, roots), verdict(`cat ${relIn}`, ws, roots)]
  assert.deepEqual(ctrlB, ['ALLOW', 'ALLOW'], `control B: an IN-root destination (absolute and via ../) stays ALLOWED — got ${JSON.stringify(ctrlB)} (the fix must canonicalize, never blanket-deny every .. )`)

  // ---- (4) POSITIVE CONTROL C: the stable profile is still protected.
  const ctrlC = [verdict('cat /opt/dsh/.dsh/fb1289-probe.yaml', ws, roots), verdict('cat ../../../../opt/dsh/.dsh/fb1289-probe.yaml', ws, roots)]
  assert.deepEqual(ctrlC, ['DENY', 'DENY'], `control C: the stable profile stays DENIED by both forms — got ${JSON.stringify(ctrlC)}`)
  assert.match(deptExecDenyReason('cat ../../../../opt/dsh/.dsh/fb1289-probe.yaml', ws, roots), /the stable profile is protected/, 'control C: the relative form is denied by the STABLE-PROFILE rule (canonicalized before the decision), not by the containment rule')

  // ---- NEGATIVE CONTROL (no false positive on ordinary words): a relative
  // word that is not a multi-segment upward traversal (`..` inside a FILENAME,
  // a bare `..`) is not a path reference and must not be denied.
  const benign = ['cat notes..txt', 'cat main..feature']
  for (const cmd of benign) {
    assert.equal(verdict(cmd, ws, roots), 'ALLOW', `no new FP: «${cmd}» is not a path traversal (a .. inside a filename is not a segment)`)
  }
})
