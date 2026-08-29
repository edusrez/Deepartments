// dsh-deepartments — export-parity LOCK test (HITO 3 DECOUPLING, PASO 1 — E2-parcial).
//
// The DECOUPLING hito moves orchestration OUT of the bundle (applyInvoke) into
// the 6 P1 plugin packages + the binder buckets WITHOUT touching the drop-in
// superset surface: while ANY test imports symbols from `../lib/invoke.js`, the
// compiled lib/invoke.js MUST stay a superset of everything they import
// (shim-compat phase — the 181-symbol import surface is FROZEN). This lock
// freezes that contract:
//   - the test's import surface: EXACTLY 8 import statements from
//     '../lib/invoke.js' importing EXACTLY 181 named symbols (the verified
//     pre-decoupling counts: 146+5+5+1+5+3+14+2),
//   - the superset: lib/invoke.js still exports EVERY one of those 181 names
//     (a drop-in superset — a moved/removed symbol breaks the lock),
//   - the superset SIZE: the compiled lib/invoke.js export count is frozen at
//     the pre-decoupling value, so an UNINTENDED export drift (add OR remove)
//     is caught before any consumer regresses.
//
// The lock reads STATIC SOURCES (test/invoke.test.js + the compiled
// lib/invoke.js) — it never boots anything, so it is hermetic and fast.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

// The FROZEN pre-decoupling import surface (verified 2026-08-29, the
// release-0.1.0 baseline): the 8 import statements in test/invoke.test.js that
// import from '../lib/invoke.js' and their EXACT per-statement symbol counts.
// (146+5+5+1+5+3+14+2 = 181.) The DECOUPLING hito MUST NOT touch these imports
// (shim compat) — a changed count/statement means the migration started
// migrating tests, which is hito 4's job and breaks this lock.
const FROZEN_IMPORT_STATEMENT_COUNTS = [146, 5, 5, 1, 5, 3, 14, 2]

/** Parse `test/invoke.test.js` and return the 8 import statements that import
 * from '../lib/invoke.js' as arrays of imported symbol names (aliases resolved
 * to the SOURCE name — `X as Y` counts `X`). Multiline imports and `type`
 * imports are handled. */
function extractInvokeImports() {
  const src = readFileSync(path.join(REPO_ROOT, 'test', 'invoke.test.js'), 'utf8')
  const statements = []
  // Match a full import statement ending in `from '../lib/invoke.js'` (multiline
  // aware: `[^]*?` lazily spans newlines; the braced list may be multiline).
  const stmtRe = /import\s+(?:type\s+)?(?:{([^}]*?)}|\*\s*as\s+\w+|\w+)\s*from\s*['"]\.\.\/lib\/invoke\.js['"]/g
  let match
  while ((match = stmtRe.exec(src)) !== null) {
    const names = match[1] === undefined
      ? []
      : match[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split(/\s+as\s+/)[0].trim())
    statements.push(names)
  }
  return statements
}

test('export-parity: test/invoke.test.js imports EXACTLY 8 statements / 181 symbols from ../lib/invoke.js (the frozen pre-decoupling surface)', () => {
  const statements = extractInvokeImports()
  assert.equal(statements.length, 8, 'exactly 8 import statements from ../lib/invoke.js')
  const counts = statements.map((names) => names.length)
  assert.deepEqual(counts, FROZEN_IMPORT_STATEMENT_COUNTS, 'the per-statement symbol counts are frozen (146+5+5+1+5+3+14+2 = 181)')
  const total = counts.reduce((a, b) => a + b, 0)
  assert.equal(total, 181, '181 named symbols total (the audit-verified pre-decoupling import surface)')
})

test('export-parity: lib/invoke.js exports EVERY one of the 181 imported symbols (the drop-in superset invariant)', async () => {
  const statements = extractInvokeImports()
  const required = [...new Set(statements.flat())]
  assert.equal(required.length, 181, '181 distinct imported symbols')
  // Load the COMPILED superset (lib/invoke.js — the exact module the tests import).
  const require = createRequire(import.meta.url)
  const invoke = require(path.join(REPO_ROOT, 'lib', 'invoke.js'))
  const missing = required.filter((name) => !(name in invoke))
  assert.deepEqual(missing, [], `every imported symbol is still exported by lib/invoke.js; missing: ${missing.join(', ')}`)
})

test('export-parity: the lib/invoke.js export COUNT is frozen (no unintended superset drift during the decoupling)', async () => {
  const require = createRequire(import.meta.url)
  const invoke = require(path.join(REPO_ROOT, 'lib', 'invoke.js'))
  const names = Object.keys(invoke).sort()
  // The pre-decoupling verified count (2026-08-29, release 0.1.0 baseline):
  // 259 named exports (the 181 test-imported symbols are a strict subset).
  assert.equal(names.length, 259, `lib/invoke.js export count frozen at 259 (got ${names.length}) — a decoupling step must not grow/shrink the superset`)
})