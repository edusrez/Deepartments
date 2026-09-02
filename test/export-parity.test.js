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
// (149+5+5+1+5+3+14+2 = 184.) The DECOUPLING hito MUST NOT touch these imports
// (shim compat) — a changed count/statement means the migration started
// migrating tests, which is hito 4's job and breaks this lock. M-5 (2026-08-31)
// extended the FIRST statement (the health surface) with the three new
// mission-stalled watchdog exports (scanMissionStalled /
// MISSION_STALL_DEFAULT_MS / missionStallKey — the M-5 tests import them) —
// an INTENTIONAL, verified surface extension that bumps the frozen count.
// M-6 (2026-08-31) extended it again with the NINE new main-red watchdog
// exports (scanMainRed / MAIN_RED_DEFAULT_POLL_MS / MAIN_RED_KEY_PREFIX /
// mainRedKey / MAIN_RED_STATE_FILE / readMainRedState / writeMainRedState /
// MAIN_RED_DEFAULT_LOCKS from dshd-health + buildMainRedState from the bundle
// — the M-6 tests import them) — an INTENTIONAL, verified surface extension
// (the post-commit re-verification watchdog) that bumps the frozen count.
// M-7 + fb-43 (VALLE lane A, 2026-09-01) extended it again with the FOURTEEN
// new exports (scanMissionQueue / MISSION_QUEUE_DEFAULT_LIMIT /
// MISSION_QUEUE_DEFAULT_PERSIST_MS / MISSION_QUEUE_KEY_PREFIX / missionQueueKey
// / MISSION_QUEUE_STATE_FILE / readMissionQueueState / writeMissionQueueState
// from dshd-health — the M-7 mission-queue watchdog — + RESTART_REGISTRY_FILE /
// RESTART_REGISTRY_SEED_ROWS / readRestartRegistry / seedRestartRegistry /
// reconcileRestartRegistry / buildRestartDigest — the fb-43 restart-registry)
// — INTENTIONAL, verified surface extensions that bump the frozen count.
// LANE 1 hardening-401 (fb-39, 2026-09-01) extended the FIRST statement with
// the SIX capacity-gate exports (CAPACITY_GATE_STATE_FILE /
// CAPACITY_GATE_TRANSITION_KEY / capacityGateDedupeKey / readCapacityGateState
// / writeCapacityGateState / buildCapacityGateFrame from dshd-health — the
// pooler-capacity CRÍTICO transition monitor, MOLDE FRANJA PEAK) — an
// INTENTIONAL, verified surface extension that bumps the frozen count.
// LANE 2 (fb-27, 2026-09-01) extended the FIRST statement with the FIVE
// turn/end-ERROR HEAD-NOTIFICATION exports (turnErrorNotifyClass /
// buildTurnErrorNotifyFrame / readTurnEndNotifyState / writeTurnEndNotifyState
// / TURN_END_NOTIFY_STATE_FILE from dshd-health — the LANE 2 head-notification
// watchdog) — an INTENTIONAL, verified surface extension that bumps the frozen
// count.
// LANE 5 (fb-46, 2026-09-01) extended the FIRST statement with the NINE new
// work-register-idle watchdog exports (scanWorkRegisterIdle /
// parseWorkRegisterItems / WORK_REGISTER_IDLE_KEY /
// WORK_REGISTER_IDLE_STATE_FILE / WORK_REGISTER_IDLE_DEFAULT_QUIET_MS /
// WORK_REGISTER_IDLE_GATED_SECTION_RE / WORK_REGISTER_IDLE_MAX_LISTED /
// readWorkRegisterIdleState / writeWorkRegisterIdleState from dshd-health —
// the docs-level WORK-REGISTER stall watchdog) — an INTENTIONAL, verified
// surface extension that bumps the frozen count.
const FROZEN_IMPORT_STATEMENT_COUNTS = [194, 5, 5, 1, 5, 3, 14, 2]

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

test('export-parity: test/invoke.test.js imports EXACTLY 8 statements / 229 symbols from ../lib/invoke.js (the frozen pre-decoupling surface; M-5+M-6+M-7+fb-43+hardening-401+LANE-2+fb-30+LANE-5 bumped the health statement)', () => {
  const statements = extractInvokeImports()
  assert.equal(statements.length, 8, 'exactly 8 import statements from ../lib/invoke.js')
  const counts = statements.map((names) => names.length)
  assert.deepEqual(counts, FROZEN_IMPORT_STATEMENT_COUNTS, 'the per-statement symbol counts are frozen (194+5+5+1+5+3+14+2 = 229)')
  const total = counts.reduce((a, b) => a + b, 0)
  assert.equal(total, 229, '229 named symbols total (the audit-verified import surface)')
})

test('export-parity: lib/invoke.js exports EVERY one of the 229 imported symbols (the drop-in superset invariant)', async () => {
  const statements = extractInvokeImports()
  const required = [...new Set(statements.flat())]
  assert.equal(required.length, 229, '229 distinct imported symbols')
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
  // 259 named exports (the 184 test-imported symbols are a strict subset).
  // M-5 (2026-08-31) added the FIVE mission-stalled watchdog exports
  // (scanMissionStalled / MISSION_STALL_DEFAULT_MS / MISSION_STALL_KEY_PREFIX /
  // missionStallKey from dshd-health + the bundle's buildMissionActivity) —
  // an INTENTIONAL, verified surface extension that bumps the frozen count.
  // M-6 (2026-08-31) added the NINE main-red watchdog exports (scanMainRed /
  // MAIN_RED_DEFAULT_POLL_MS / MAIN_RED_KEY_PREFIX / mainRedKey /
  // MAIN_RED_STATE_FILE / readMainRedState / writeMainRedState /
  // MAIN_RED_DEFAULT_LOCKS from dshd-health + the bundle's buildMainRedState)
  // — the post-commit re-verification watchdog, an INTENTIONAL, verified
  // surface extension that bumps the frozen count.
  // M-7 + fb-43 (VALLE lane A, 2026-09-01) added the FOURTEEN new exports
  // (scanMissionQueue / MISSION_QUEUE_DEFAULT_LIMIT /
  // MISSION_QUEUE_DEFAULT_PERSIST_MS / MISSION_QUEUE_KEY_PREFIX / missionQueueKey
  // / MISSION_QUEUE_STATE_FILE / readMissionQueueState / writeMissionQueueState
  // — the M-7 mission-queue watchdog — + RESTART_REGISTRY_FILE /
  // RESTART_REGISTRY_SEED_ROWS / readRestartRegistry / seedRestartRegistry /
  // reconcileRestartRegistry / buildRestartDigest — the fb-43 restart-registry)
  // — INTENTIONAL, verified surface extensions that bump the frozen count.
  // LANE 1 hardening-401 (fb-39, 2026-09-01) added the SIX capacity-gate
  // exports (CAPACITY_GATE_STATE_FILE / CAPACITY_GATE_TRANSITION_KEY /
  // capacityGateDedupeKey / readCapacityGateState / writeCapacityGateState /
  // buildCapacityGateFrame from dshd-health — the pooler-capacity CRÍTICO
  // transition monitor) — an INTENTIONAL, verified surface extension that
  // bumps the frozen count.
  // LANE 2 (fb-27, 2026-09-01) added the FIVE turn/end-ERROR HEAD-NOTIFICATION
  // exports (turnErrorNotifyClass / buildTurnErrorNotifyFrame /
  // readTurnEndNotifyState / writeTurnEndNotifyState /
  // TURN_END_NOTIFY_STATE_FILE from dshd-health) — an INTENTIONAL, verified
  // surface extension that bumps the frozen count.
  // LANE 4 (fb-30, 2026-09-01) added the TWO boot CATCH-UP exports
  // (scanHealthCatchup / HEALTH_CATCHUP_WINDOW_MS from dshd-health — the
  // bounded BOOT catch-up over the durable event ledgers) — an INTENTIONAL,
  // verified surface extension that bumps the frozen count.
  // LANE 5 (fb-46, 2026-09-01) added the NINE work-register-idle exports
  // (scanWorkRegisterIdle / parseWorkRegisterItems / WORK_REGISTER_IDLE_KEY /
  // WORK_REGISTER_IDLE_STATE_FILE / WORK_REGISTER_IDLE_DEFAULT_QUIET_MS /
  // WORK_REGISTER_IDLE_GATED_SECTION_RE / WORK_REGISTER_IDLE_MAX_LISTED /
  // readWorkRegisterIdleState / writeWorkRegisterIdleState from dshd-health
  // — the docs-level WORK-REGISTER stall watchdog) — an INTENTIONAL, verified
  // surface extension that bumps the frozen count.
  // LANE 0.2.1 (2026-09-01, binder → Service, gap 1) added ONE export
  // (createDepsHolder from dshd-health — the 1B per-package mutable deps
  // holder factory the package provides as `deepartments.healthDeps`; the star
  // re-export bridge src/core/health.ts carries it into the surface) — an
  // INTENTIONAL, verified surface extension that bumps the frozen count.
  // fb-50 batch (2026-09-02, M-A completion-reserve calibration) added ONE
  // export (CONTEXT_COMPLETION_RESERVE_DEFAULT from dshd-health — the code
  // default of the `health.contextCompletionReserve` knob; the star re-export
  // bridge carries it into the surface like its M-A siblings
  // CONTEXT_THRESHOLD_DEFAULT / CONTEXT_THRESHOLD_DEFAULT_POLL_MS) — an
  // INTENTIONAL, verified surface extension that bumps the frozen count.
  assert.equal(names.length, 311, `lib/invoke.js export count frozen at 311 (got ${names.length}) — a decoupling step must not grow/shrink the superset`)
})
