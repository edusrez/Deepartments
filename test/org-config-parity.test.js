// dsh-deepartments — org-config PARITY test (D5 modularization, 2026-08-29).
//
// The `deepartments.org` config has TWO declarations in the repo: the dshd-core
// row (packages/dshd-core/cordis.patch.yml — the SHARED CONFIG SOURCE, the ONE
// source of truth for the org fallback) and the bundle's own `deepartments`
// row (cordis.patch.yml — the FALLBACK MIRROR used ONLY in minimal/hermetic
// compositions where dshd-core is absent). This test locks the mirror contract
// (R6 behavior-neutral): the SHARED keys (`stateDir`, `org.departments`,
// `org.poolerBaseURL`) MUST stay equal between the two rows — a drift fails
// the suite loudly instead of silently diverging the fallback. The one-sided
// keys are INTENTIONAL and asserted as such so nobody "fixes" them by copying:
//   * `org.postsRetention` — core-only (the bundle fallback leaves it absent on
//     purpose: hermetic/minimal pruning stays OFF, conservative default);
//   * `org.pacing` + `quality` — bundle-only (bundle-side knobs with code
//     defaults; the core row never carries them).
// Style: read-only + dependency-free indentation scan (mirrors the P1
// rewire-pooler line scan in test/invoke.test.js — no YAML parser dependency).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const ROOT_PATCH = path.join(REPO_ROOT, 'cordis.patch.yml')
const CORE_PATCH = path.join(REPO_ROOT, 'packages', 'dshd-core', 'cordis.patch.yml')

const indentOf = (line) => (line.match(/^\s*/)?.[0].length ?? 0)

/** Extract ONE patch row (from its `- id: <rowId>` line to the next top-level
 * patch row) from a cordis.patch.yml text. Returns the raw row block. */
function extractRow(text, rowId) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^\\s*- id: ${rowId}\\s*$`).test(l))
  if (start < 0) return null
  const rowIndent = indentOf(lines[start])
  const row = [lines[start]]
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      const ind = indentOf(lines[i])
      if (ind <= rowIndent && /^-\s/.test(trimmed)) break // next top-level patch row
    }
    row.push(lines[i])
  }
  return row.join('\n')
}

/** Extract a subtree under a matching `key:` line inside a row block (includes
 * the `key:` line itself; stops at the next sibling at <= the key's indent). */
function extractKey(rowBlock, key) {
  if (rowBlock === null) return null
  const lines = rowBlock.split('\n')
  const start = lines.findIndex((l) => {
    const t = l.trim()
    return t === `${key}:` || t.startsWith(`${key}: `)
  })
  if (start < 0) return null
  const keyIndent = indentOf(lines[start])
  const out = []
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (i > start && trimmed !== '' && !trimmed.startsWith('#')) {
      const ind = indentOf(lines[i])
      if (ind <= keyIndent) break
    }
    out.push(lines[i])
  }
  return out.join('\n')
}

/** Normalize a YAML subtree for comparison: drop comments + blanks, trim every
 * line (the two rows are hand-mirrored, so indentation may differ slightly). */
const normalize = (block) =>
  (block ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .join('\n')

async function loadRows() {
  const rootText = await readFile(ROOT_PATCH, 'utf8')
  const coreText = await readFile(CORE_PATCH, 'utf8')
  const bundleRow = extractRow(rootText, 'deepartments')
  const coreRow = extractRow(coreText, 'dshd-core')
  assert.ok(bundleRow !== null, 'cordis.patch.yml contains the deepartments patch row')
  assert.ok(coreRow !== null, 'packages/dshd-core/cordis.patch.yml contains the dshd-core patch row')
  return { bundleRow, coreRow }
}

test('D5 org-config parity: the bundle `deepartments` row stateDir MIRRORS the dshd-core shared source stateDir', async () => {
  const { bundleRow, coreRow } = await loadRows()
  const bundle = normalize(extractKey(bundleRow, 'stateDir'))
  const core = normalize(extractKey(coreRow, 'stateDir'))
  assert.equal(bundle, core, 'stateDir must be identical between the dshd-core row (source) and the bundle deepartments fallback row (mirror) — sync packages/dshd-core/cordis.patch.yml and cordis.patch.yml')
  assert.equal(bundle, 'stateDir: .deepartments')
})

test('D5 org-config parity: the bundle `deepartments` row org.departments MIRRORS the dshd-core shared source (same departments, never a silent drift)', async () => {
  const { bundleRow, coreRow } = await loadRows()
  const bundle = normalize(extractKey(bundleRow, 'departments'))
  const core = normalize(extractKey(coreRow, 'departments'))
  assert.ok(bundle.length > 0 && core.length > 0, 'both rows MUST declare org.departments (the mirror contract is the 3 configured departments)')
  assert.equal(bundle, core, 'org.departments must be identical between the dshd-core row (source) and the bundle deepartments fallback row (mirror) — the double source of truth MAY NOT drift silently (audit flag: dobis fuente de verdad de org)')
  for (const deptId of ['research', 'internal-programming', 'quality']) {
    assert.ok(bundle.includes(`- id: ${deptId}`), `the mirrored departments include ${deptId}`)
  }
})

test('D5 org-config parity: the bundle `deepartments` row org.poolerBaseURL MIRRORS the dshd-core shared source poolerBaseURL', async () => {
  const { bundleRow, coreRow } = await loadRows()
  const bundle = normalize(extractKey(bundleRow, 'poolerBaseURL'))
  const core = normalize(extractKey(coreRow, 'poolerBaseURL'))
  assert.ok(bundle.length > 0 && core.length > 0, 'both rows MUST declare org.poolerBaseURL (the endpoint-drift exemption route)')
  assert.equal(bundle, core, 'org.poolerBaseURL must be identical between the dshd-core row (source) and the bundle deepartments fallback row (mirror)')
})

test('D5 org-config parity: the one-sided keys are INTENTIONAL (postsRetention core-only; pacing + quality bundle-only) — never copy them across', async () => {
  const { bundleRow, coreRow } = await loadRows()
  // postsRetention: ONLY the shared source (core) declares it — the bundle
  // fallback deliberately leaves it absent so hermetic/minimal pruning stays OFF
  // (conservative default; the A3/C2 gate). Copying it into the bundle row
  // would silently turn pruning ON in minimal compositions.
  assert.equal(extractKey(bundleRow, 'postsRetention'), null, 'the bundle fallback row must NOT carry org.postsRetention (core-only one-sided key)')
  assert.ok(extractKey(coreRow, 'postsRetention') !== null, 'the dshd-core shared source MUST carry org.postsRetention')
  // pacing: ONLY the bundle fallback declares org.pacing (bundle-side knob with
  // code defaults). The core row's OrgConfig type supports it but the SHARED
  // SOURCE deliberately does not carry it — do not copy it in.
  assert.ok(extractKey(bundleRow, 'pacing') !== null, 'the bundle fallback row MUST carry org.pacing (bundle-side knob, code-default-capable)')
  assert.equal(extractKey(coreRow, 'pacing'), null, 'the dshd-core shared source must NOT carry org.pacing (bundle-only one-sided key)')
  // quality: ONLY the bundle fallback declares the quality block (the
  // worker-inspect dice, spec 007 §4.1). Core never carries it.
  assert.ok(extractKey(bundleRow, 'quality') !== null, 'the bundle deepartments row MUST carry the quality block (worker-inspect dice)')
  assert.equal(extractKey(coreRow, 'quality'), null, 'the dshd-core shared source must NOT carry the quality block (bundle-only one-sided key)')
})