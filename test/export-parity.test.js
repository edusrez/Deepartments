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
// M1 spec 09-04 (owner 2026-09-04, pooler-capacity 3-class grading) extended
// the SEVENTH statement (the DISPATCH-HARDENING block) with the FOUR
// grading-default exports (POOLER_CAPACITY_DEFAULT_WARNING_USABLE_KEYS /
// POOLER_CAPACITY_DEFAULT_OK_USABLE_KEYS /
// POOLER_CAPACITY_DEFAULT_GLOBAL_REMAINING_PERCENT /
// POOLER_CAPACITY_DEFAULT_WEEKLY_REMAINING_PERCENT from dshd-health — the
// spec knobs the 3-class tests import; WARNING_USABLE_KEYS was already an
// export, this adds it to the TEST import surface) — an INTENTIONAL,
// verified surface extension that bumps the frozen count.
// R1 (2026-09-04, WORK-REGISTER post-CIERRE — pooler zombie + probe
// visibility): ADDED POOLER_CAPACITY_KEY_PROBE_FAILED to the FIRST health
// import statement (the probe-failed dedupe key the R1 M1 tests assert — an
// INTENTIONAL, verified test-surface extension, 194 → 195).
const FROZEN_IMPORT_STATEMENT_COUNTS = [195, 5, 5, 1, 5, 3, 18, 2]

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

test('export-parity: test/invoke.test.js imports EXACTLY 8 statements / 234 symbols from ../lib/invoke.js (the frozen pre-decoupling surface; M-5+M-6+M-7+fb-43+hardening-401+LANE-2+fb-30+LANE-5+spec-09-04+R1 bumped the health + dispatch statements)', () => {
  const statements = extractInvokeImports()
  assert.equal(statements.length, 8, 'exactly 8 import statements from ../lib/invoke.js')
  const counts = statements.map((names) => names.length)
  assert.deepEqual(counts, FROZEN_IMPORT_STATEMENT_COUNTS, 'the per-statement symbol counts are frozen (195+5+5+1+5+3+18+2 = 234)')
  const total = counts.reduce((a, b) => a + b, 0)
  assert.equal(total, 234, '234 named symbols total (the audit-verified import surface)')
})

test('export-parity: lib/invoke.js exports EVERY one of the 234 imported symbols (the drop-in superset invariant)', async () => {
  const statements = extractInvokeImports()
  const required = [...new Set(statements.flat())]
  assert.equal(required.length, 234, '234 distinct imported symbols')
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
  // LANES ②/②-bis (2026-09-03, ec2d405 — delivery hardening: gate age-check
  // rotationStaleMs + re-drive sweep + fb-79 backoff + fb-58 settle/rotatedTo
  // + O1 dispose-grace + storm thresholds) added the SIX delivery-health
  // exports (HEALTH_DELIVERY_STORM_MAX_ATTEMPT_RATIO /
  // HEALTH_DELIVERY_STORM_MAX_ROWS_PER_HOUR / HEALTH_DELIVERY_STORM_WINDOW_MS /
  // POOLER_CAPACITY_DEFAULT_ROTATION_STALE_MS / POOLER_CAPACITY_KEY_ROTATION_STALE
  // / scanDeliveryStormFindings — all six from dshd-health, provenance
  // re-verified per-export via git log -S) — an INTENTIONAL, verified surface
  // extension that bumps the frozen count (311 → 317).
  // LANE OBJETIVE B finisher (2026-09-04, run b7b4c158): the FOUR boot-crash
  // breaker exports (BOOT_CRASH_FILE / readBootCrashFile / resolveBootCrashStreak
  // / stampBootCrash from dshd-health — the post-incidente 609-restarts
  // breaker datums) reach the bundle surface via the star re-export bridge
  // src/core/health.ts (`export * from 'dshd-health'`) → invoke.ts — an
  // INTENTIONAL, verified surface extension (317 → 321). The session-surface
  // helpers (getSessionEvents / detectSessionSurface) are NOT re-exported by
  // invoke.ts (module-scope — verified ABSENT from this export list; B's
  // invoke.ts diff adds 0 new `export` lines).
  // M1 spec 09-04 (owner 2026-09-04, pooler-capacity 3-class grading) — the
  // pooler knob surface change: REMOVED the retired count-critical default
  // (POOLER_CAPACITY_DEFAULT_CRITICAL_USABLE_KEYS — the count can no longer
  // produce critical) and ADDED the THREE new grading defaults
  // (POOLER_CAPACITY_DEFAULT_OK_USABLE_KEYS /
  // POOLER_CAPACITY_DEFAULT_GLOBAL_REMAINING_PERCENT /
  // POOLER_CAPACITY_DEFAULT_WEEKLY_REMAINING_PERCENT from dshd-health — the
  // spec knobs of the 3-class scan; all four flow through the star re-export
  // bridge src/core/health.ts) — an INTENTIONAL, verified surface extension
  // (321 → 323, net +3 −1 = +2).
  // R1 (2026-09-04, WORK-REGISTER post-CIERRE — pooler zombie + probe
  // visibility): ADDED the probe-failed dedupe key
  // (POOLER_CAPACITY_KEY_PROBE_FAILED from dshd-health — the «probe timeout —
  // % unavailable» class of the M1 scan, surfaced for a USABLE key whose
  // health probe timed out; flows through the same star re-export bridge) — an
  // INTENTIONAL, verified surface extension (323 → 324).
  // P1-EXT (2026-09-06, WAKE-SEAM mitigation — Etapa 1): ADDED the
  // manager-delivery-stuck detector export (scanGatedManagerDeliveryStuck from
  // dshd-health — the q-i idle-hold watchdog over the delivery sidecar; flows
  // through the same star re-export bridge src/core/health.ts) — an
  // INTENTIONAL, verified surface extension (324 → 325).
  // P1-EXT-EXT (2026-09-06, WAKE-SEAM mitigation — the m-2415 no-wake-head
  // DISCRIMINATOR extension): the new pure gating-head probe
  // (gatingHeadIsNoWake from dshd-core/src/messages.ts) is consumed ONLY via
  // the package imports (the engine/redeliverer dep wiring + the orchestration
  // fallback) — it does NOT reach the bundle surface (invoke.ts re-exports a
  // curated dshd-core messages list, never `export *`), so the frozen count
  // stays 325 (verified: hasEarlierPendingPair is likewise ABSENT from
  // lib/invoke.js — the two gate helpers share the same non-surface status).
  // fb-235 (2026-09-09, R6 request-failure ATTRIBUTION — turn-error/finish-chunk
  // additive fields): the pure attribution machinery reached the bundle surface
  // through the SAME star re-export bridge src/core/health.ts — TWO new RUNTIME
  // exports from dshd-health (deriveTurnErrorAttribution +
  // TURN_ERROR_POOLER_JOIN_WINDOW_MS — the 2-min lastBare400 join window; the
  // scanTurnErrorCaptures signature was EXTENDED with poolerState?, a
  // count-neutral MOVE on the same name) — an INTENTIONAL, verified surface
  // extension (325 → 327). The TurnErrorLastUsage / PoolerLastBare400Like
  // interfaces are type-only and emit NO runtime export. The test import
  // surface stays 234 (invoke.test.js imports nothing new from lib/invoke.js —
  // tests 1 + 2 of this lock keep passing).
  // LOCK CORRECTED 327 → 328 (05cb3cb, fb-473): the lock held 327 CORRECTLY at
  // 8aba9dd. 05cb3cb extended the surface with verifyLabelFor (source
  // dshd-quality/src/index.ts:206; it reaches the superset through the star
  // re-export bridge src/core/quality.ts — NO `export` line was written in
  // invoke.ts, and test/invoke.test.js does not import it) and the rebuild
  // propagated it into lib/invoke.js ⇒ 328. The bump is INTENTIONAL and verified
  // (3/3), NOT an off-by-one at freeze time: the name-level source diff
  // 8aba9dd→HEAD is +verifyLabelFor / −0.
  assert.equal(names.length, 328, `lib/invoke.js export count frozen at 328 (got ${names.length}) — a decoupling step must not grow/shrink the superset`)
})
