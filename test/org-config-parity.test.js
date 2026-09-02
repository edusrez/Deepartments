// dsh-deepartments — org-config PARITY test (D5 modularization, 2026-08-29;
// RE-AIMED in LANE 0.2.3a — single-source of the org config).
//
// The `deepartments.org` config has TWO SHARED SOURCE declarations in the repo:
// the dshd-core row (packages/dshd-core/cordis.patch.yml — the ONE source of
// truth in the full composition) and the dshd-core-min row
// (packages/dshd-core-min/cordis.patch.yml — the DECLARED MINIMAL-COMPOSITION
// FALLBACK for bundle-alone / hermetic compositions where dshd-core is
// absent). This test locks the single-source contract:
//   - the SHARED keys (`stateDir`, `org.departments`, `org.poolerBaseURL`,
//     `org.workerAgentOptions`, `org.hostAgentOptions`) MUST stay EQUAL
//     between the dshd-core row and the dshd-core-min row (the fallback is a
//     faithful copy — a drift fails the suite loudly);
//   - the BUNDLE `deepartments` row (cordis.patch.yml) carries NO org mirror
//     anymore: the shared keys are ABSENT there (LANE 0.2.3 eliminated the
//     in-bundle fallback mirror — the runtime reads `deepartments.org` from
//     dshd-core / dshd-core-min, falling back to config.org only in a
//     composition with NEITHER, dead-trap R6).
// The one-sided keys are INTENTIONAL and asserted as such so nobody "fixes"
// them by copying:
//   * `org.postsRetention` — core-only (the minimal fallback leaves it absent
//     on purpose: hermetic/minimal pruning stays OFF, conservative default);
//   * `org.pacing` + `quality` — bundle-only (bundle-side knobs with code
//     defaults; the shared rows never carry them).
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
const MIN_PATCH = path.join(REPO_ROOT, 'packages', 'dshd-core-min', 'cordis.patch.yml')

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
  const minText = await readFile(MIN_PATCH, 'utf8')
  const bundleRow = extractRow(rootText, 'deepartments')
  const coreRow = extractRow(coreText, 'dshd-core')
  const minRow = extractRow(minText, 'dshd-core-min')
  assert.ok(bundleRow !== null, 'cordis.patch.yml contains the deepartments patch row')
  assert.ok(coreRow !== null, 'packages/dshd-core/cordis.patch.yml contains the dshd-core patch row')
  assert.ok(minRow !== null, 'packages/dshd-core-min/cordis.patch.yml contains the dshd-core-min patch row')
  return { bundleRow, coreRow, minRow }
}

test('D5 org-config parity (single-source): the dshd-core-min fallback row stateDir MIRRORS the dshd-core shared source stateDir (the minimal-composition fallback is a faithful copy)', async () => {
  const { coreRow, minRow } = await loadRows()
  const core = normalize(extractKey(coreRow, 'stateDir'))
  const min = normalize(extractKey(minRow, 'stateDir'))
  assert.equal(min, core, 'stateDir must be identical between the dshd-core row (source) and the dshd-core-min row (fallback) — sync packages/dshd-core/cordis.patch.yml and packages/dshd-core-min/cordis.patch.yml')
  assert.equal(min, 'stateDir: .deepartments')
})

test('D5 org-config parity (single-source): org.departments is identical between dshd-core (source) and dshd-core-min (fallback) — the same 3 departments, never a silent drift', async () => {
  const { coreRow, minRow } = await loadRows()
  const core = normalize(extractKey(coreRow, 'departments'))
  const min = normalize(extractKey(minRow, 'departments'))
  assert.ok(core.length > 0 && min.length > 0, 'both SHARED source rows MUST declare org.departments (the fallback contract is the 3 configured departments)')
  assert.equal(min, core, 'org.departments must be identical between the dshd-core row (source) and the dshd-core-min row (fallback) — the fallback MAY NOT drift silently (audit flag: doble fuente de verdad de org, ahora fallback declarado)')
  for (const deptId of ['research', 'internal-programming', 'quality']) {
    assert.ok(min.includes(`- id: ${deptId}`), `the fallback departments include ${deptId}`)
  }
})

test('D5 org-config parity (single-source): org.poolerBaseURL is identical between dshd-core (source) and dshd-core-min (fallback) — the endpoint-drift exemption route', async () => {
  const { coreRow, minRow } = await loadRows()
  const core = normalize(extractKey(coreRow, 'poolerBaseURL'))
  const min = normalize(extractKey(minRow, 'poolerBaseURL'))
  assert.ok(core.length > 0 && min.length > 0, 'both SHARED source rows MUST declare org.poolerBaseURL (the endpoint-drift exemption route)')
  assert.equal(min, core, 'org.poolerBaseURL must be identical between the dshd-core row (source) and the dshd-core-min row (fallback)')
  assert.equal(min, 'poolerBaseURL: http://127.0.0.1:4097/v1')
})

test('D5 org-config parity (single-source): the R4 agent-options (workerAgentOptions/hostAgentOptions) are identical between dshd-core (source) and dshd-core-min (fallback) — the single declared provider/model route', async () => {
  const { coreRow, minRow } = await loadRows()
  for (const key of ['workerAgentOptions', 'hostAgentOptions']) {
    const core = normalize(extractKey(coreRow, key))
    const min = normalize(extractKey(minRow, key))
    assert.ok(core.length > 0 && min.length > 0, `both SHARED source rows MUST declare org.${key} (the R4 route, single source)`)
    assert.equal(min, core, `org.${key} must be identical between the dshd-core row (source) and the dshd-core-min row (fallback)`)
    assert.ok(min.includes('deepseek-v4-flash'), `org.${key} declares the runtime truth deepseek-v4-flash (aligned with the dump-config reality)`)
  }
})

test('D5 org-config parity (LANE 0.2.3 single-source): the BUNDLE `deepartments` row carries NO org mirror — the shared org keys are ABSENT (only pacing/quality one-sided + its own stateDir remain)', async () => {
  const { bundleRow, coreRow, minRow } = await loadRows()
  // The bundle row keeps its OWN boot stateDir (the schema default value) but
  // carries NO org mirror: the shared source keys are ABSENT by contract.
  assert.equal(normalize(extractKey(bundleRow, 'stateDir')), 'stateDir: .deepartments', 'the bundle row keeps its own stateDir (the boot value)')
  // Absence asserts for the shared org keys (the mirror is GONE — LANE 0.2.3).
  assert.equal(extractKey(bundleRow, 'departments'), null, 'the bundle deepartments row must NOT carry org.departments (single-source — the org lives ONLY in dshd-core/dshd-core-min)')
  assert.equal(extractKey(bundleRow, 'poolerBaseURL'), null, 'the bundle deepartments row must NOT carry org.poolerBaseURL (single-source — the P1 exemption comes from the shared source)')
  assert.equal(extractKey(bundleRow, 'workerAgentOptions'), null, 'the bundle deepartments row must NOT carry org.workerAgentOptions (single-source — R4 is org-driven from the shared source)')
  assert.equal(extractKey(bundleRow, 'hostAgentOptions'), null, 'the bundle deepartments row must NOT carry org.hostAgentOptions (single-source — R4 is org-driven from the shared source)')
  // postsRetention: ONLY the shared source (core) declares it — the minimal
  // fallback AND the bundle deliberately leave it absent so hermetic/minimal
  // pruning stays OFF (conservative default; the A3/C2 gate). Copying it into
  // either row would silently turn pruning ON in a minimal composition.
  assert.equal(extractKey(bundleRow, 'postsRetention'), null, 'the bundle deepartments row must NOT carry org.postsRetention (core-only one-sided key)')
  assert.equal(extractKey(minRow, 'postsRetention'), null, 'the dshd-core-min fallback row must NOT carry org.postsRetention (core-only one-sided key — minimal pruning stays OFF)')
  assert.ok(extractKey(coreRow, 'postsRetention') !== null, 'the dshd-core shared source MUST carry org.postsRetention')
  // pacing: ONLY the bundle declares org.pacing (bundle-side knob with code
  // defaults). The shared source rows must NOT carry it — do not copy it in.
  assert.ok(extractKey(bundleRow, 'pacing') !== null, 'the bundle deepartments row MUST carry org.pacing (bundle-side knob, code-default-capable)')
  assert.equal(extractKey(coreRow, 'pacing'), null, 'the dshd-core shared source must NOT carry org.pacing (bundle-only one-sided key)')
  assert.equal(extractKey(minRow, 'pacing'), null, 'the dshd-core-min fallback must NOT carry org.pacing (bundle-only one-sided key)')
  // quality: ONLY the bundle declares the quality block (the worker-inspect
  // dice, spec 007 §4.1). Core never carries it.
  assert.ok(extractKey(bundleRow, 'quality') !== null, 'the bundle deepartments row MUST carry the quality block (worker-inspect dice)')
  assert.equal(extractKey(coreRow, 'quality'), null, 'the dshd-core shared source must NOT carry the quality block (bundle-only one-sided key)')
  assert.equal(extractKey(minRow, 'quality'), null, 'the dshd-core-min fallback must NOT carry the quality block (bundle-only one-sided key)')
})