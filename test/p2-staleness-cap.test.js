// dsh-deepartments — P2-HYGIENE (LANE P2, LOTE B, 2026-09-06): the HEARTBEAT
// STALENESS CAP.
//
// Context: health-heartbeat.json carries the daemon's freshness datum `ts`
// (spec 006 §3: heartbeat FRESH = the daemon is running, STALE = it died). The
// interrupted-post boot reconciliation (tools.ts runInterruptedPostReconciliation
// → reconcileInterruptedPosts) uses the PREVIOUS boot's last heartbeat ts as the
// restart-window LOWER BOUND (`restartAfterTs`): only an interruption whose
// crash-tail is AFTER that ts is flagged as THIS restart's casualty. Without a
// staleness cap, an OLD heartbeat ts (a prior era, a dead-liveness claim) would
// silently establish/skew the bound.
//
// THE FIX (tools.ts, INLINE — no new dshd-health exports): the restart bound is
// only passed while the previous heartbeat is FRESH — `now - ts >
// heartbeatStaleCapMs` (the knob `health.heartbeatStaleMs`, default = the 2h
// anomaly freshness window HEALTH_ERROR_WINDOW_MS) ⇒ STALE ⇒ restartAfterTs =
// undefined → the documented ABSENT path in reconcileInterruptedPosts («the 2h
// freshness window alone bounds it»). INLINE matters: the export-parity lock
// (lib/invoke.js frozen at 324 names) is part of the PREP package — the lane
// adds ZERO named exports to the bundle surface, so the lock stays untouched.
//
// Cases:
//   (i)   the staleness RULE itself (mirroring the tools.ts inline predicate):
//         absent / fresh / stale / the cap edge / skew tolerance;
//   (ii)  the cap KNOB resolution rule: default / explicit / invalid (the same
//         positive-number-safeguard pattern tools.ts applies);
//   (iii) SEMANTIC: a STALE previous heartbeat → restartAfterTs = undefined,
//         and reconcileInterruptedPosts then flags the post via the freshness
//         window alone (appended = 1); a FRESH heartbeat whose ts is AFTER the
//         crash-tail → restartAfterTs = ts and the post is NOT appended
//         (appended = 0 — the bound is respected).
//
// Hermetic: temp stateDir for reconcileInterruptedPosts (its only I/O); a
// FIXED clock via the `now` dep (no wall clock); the built dshd-health lib
// import (fb-95 canonical plain `node --test` over lib — NO ts-src-loader
// self-registration, the r6-ladder-flat meta-guard allow-list stays intact).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HEALTH_ERROR_WINDOW_MS,
  reconcileInterruptedPosts,
  scanInterruptedTurn,
} from '../packages/dshd-health/lib/index.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

/** The STALENESS RULE the tools.ts interrupted-post seam applies (mirrored
 * here for the pure tests; the seam's inline expression is the same
 * predicate). `nowMs - ts > capMs` ⇒ STALE; absent/non-finite ts ⇒ STALE. */
function heartbeatIsStale(heartbeat, nowMs, capMs) {
  return heartbeat === undefined || !Number.isFinite(heartbeat?.ts ?? NaN) || nowMs - heartbeat.ts > capMs
}

/** The cap KNOB resolution rule (the positive-number-safeguard pattern): a
 * finite `heartbeatStaleMs` > 0 wins; absent/invalid → the 2h anomaly window. */
function resolveStaleCapMs(healthCfg) {
  const v = healthCfg?.heartbeatStaleMs
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : HEALTH_ERROR_WINDOW_MS
}

/** An interrupted-turn fixture whose crash-tail (last event) is `ts` — the
 * exact Case-A shape (open turn, never closed) the reconciliation flags. */
const interruptedLogAt = (ts) => [{ type: 'turn/start', time: ts, data: { turn: 1 } }]

test('p2-staleness-cap (i): the staleness rule — absent / fresh / stale / cap edge', () => {
  const now = 10_000_000
  const cap = 60_000
  // absent → stale (a missing heartbeat can never be a live bound).
  assert.equal(heartbeatIsStale(undefined, now, cap), true, 'absent heartbeat is stale')
  assert.equal(heartbeatIsStale(null, now, cap), true, 'an empty/malformed heartbeat is stale')
  // exactly at the cap edge → NOT stale (the cap is the max age; `now - ts <= cap` is fresh).
  assert.equal(heartbeatIsStale({ ts: now - cap }, now, cap), false, 'a heartbeat exactly `cap` old is still fresh')
  assert.equal(heartbeatIsStale({ ts: now - cap - 1 }, now, cap), true, 'a heartbeat older than the cap is stale')
  assert.equal(heartbeatIsStale({ ts: now }, now, cap), false, 'a just-written heartbeat is fresh')
  // a ts in the future (clock skew) is not stale (now - ts < 0 <= cap).
  assert.equal(heartbeatIsStale({ ts: now + 5_000 }, now, cap), false, 'a future ts is not stale (skew tolerance)')
})

test('p2-staleness-cap (ii): the cap knob resolution rule — default / explicit / invalid', () => {
  assert.equal(resolveStaleCapMs(undefined), HEALTH_ERROR_WINDOW_MS, 'absent knob → the default (2h anomaly window)')
  assert.equal(resolveStaleCapMs({}), HEALTH_ERROR_WINDOW_MS, 'empty config → the default')
  assert.equal(resolveStaleCapMs({ health: { heartbeatStaleMs: 5 * 60_000 } }), HEALTH_ERROR_WINDOW_MS, 'the knob lives UNDER health — tools.ts reads config.health')
  assert.equal(resolveStaleCapMs({ heartbeatStaleMs: 5 * 60_000 }), 5 * 60_000, 'an explicit finite > 0 knob wins')
  assert.equal(resolveStaleCapMs({ heartbeatStaleMs: 0 }), HEALTH_ERROR_WINDOW_MS, 'a 0 knob is invalid → the default')
  assert.equal(resolveStaleCapMs({ heartbeatStaleMs: -1 }), HEALTH_ERROR_WINDOW_MS, 'a negative knob is invalid → the default')
  assert.equal(resolveStaleCapMs({ heartbeatStaleMs: Number.NaN }), HEALTH_ERROR_WINDOW_MS, 'a NaN knob is invalid → the default')
})

test('p2-staleness-cap (iii): a STALE previous heartbeat degrades restartAfterTs to undefined (the documented absent path still appends the interruption); a FRESH heartbeat applies the bound (a crash-tail BEFORE it is not this restart\'s casualty)', async () => {
  const now = 10_000_000
  const stateDir = await mkdtemp(path.join(tmpdir(), 'p2-staleness-cap-'))
  try {
    const heartbeatTs = now - HEALTH_ERROR_WINDOW_MS - 1 // STALE: older than the 2h cap
    const interruptTs = now - 60_000 // the crash-tail: 1 min ago (inside the 2h freshness window)

    // --- STALE heartbeat → the tools.ts wiring derives restartAfterTs = undefined.
    const staleRestartAfterTs = heartbeatIsStale({ ts: heartbeatTs }, now, resolveStaleCapMs({}))
      ? undefined
      : heartbeatTs
    assert.equal(staleRestartAfterTs, undefined, 'a STALE previous heartbeat must NOT establish the bound (undefined)')

    const staleResult = await reconcileInterruptedPosts({
      now: () => now,
      stateDir,
      postEvents: [{ postId: 'p-stale', sessionId: 's-stale', events: interruptedLogAt(interruptTs) }],
      restartAfterTs: staleRestartAfterTs,
    })
    // `interrupted` = every post whose session reads as an interrupted turn;
    // `appended` = post-error rows actually written (the bound + freshness +
    // dedupe gates). The STALE (absent) bound admits the fresh interruption.
    assert.ok(staleResult.interrupted.includes('p-stale'), 'the scan detects the interrupted turn (stale case)')
    assert.equal(staleResult.appended, 1, 'with restartAfterTs = undefined the fresh interruption IS appended (the staleness cap preserves the documented absent path)')
    assert.ok(
      scanInterruptedTurn(interruptedLogAt(interruptTs), 's-stale', 'p-stale')?.ts !== undefined,
      'the fixture really reads as an interrupted turn (the scanner agrees)',
    )

    // --- FRESH heartbeat with restartAfterTs = ts AFTER the crash-tail → the
    // interruption is NOT this restart's casualty (the bound is respected: the
    // scan STILL detects the post, but NO row is appended).
    const freshBoundTs = interruptTs + 5_000
    const freshRestartAfterTs = heartbeatIsStale({ ts: freshBoundTs }, now, resolveStaleCapMs({}))
      ? undefined
      : freshBoundTs
    assert.equal(freshRestartAfterTs, freshBoundTs, 'a fresh heartbeat establishes the bound (ts passed through)')

    const freshResult = await reconcileInterruptedPosts({
      now: () => now,
      stateDir,
      postEvents: [{ postId: 'p-fresh', sessionId: 's-fresh', events: interruptedLogAt(interruptTs) }],
      restartAfterTs: freshRestartAfterTs,
    })
    assert.ok(freshResult.interrupted.includes('p-fresh'), 'the scan detects the post either way (fresh case)')
    assert.equal(freshResult.appended, 0, 'a crash-tail BEFORE the fresh bound is NOT appended (the restart window excludes it)')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('p2-staleness-cap: the tools.ts interrupted-post seam is WIRED to the cap (source-level lock) AND the lane adds ZERO new exports to the bundle surface (export-parity 324 untouched — PREP)', () => {
  const toolsSrc = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts'), 'utf8')
  // the seam derives staleness from the previous heartbeat + the cap knob.
  assert.match(toolsSrc, /heartbeatStaleCapMs/, 'the cap knob is resolved in tools.ts')
  assert.match(toolsSrc, /prevHeartbeatStale/, 'the staleness predicate is applied to the previous heartbeat')
  assert.match(toolsSrc, /restartAfterTs: prevHeartbeatStale \? undefined : prevHeartbeat\?\.ts/, 'a STALE heartbeat → restartAfterTs = undefined (the absent path)')
  assert.match(toolsSrc, /typeof config\.health\?\.heartbeatStaleMs === 'number'/, 'the knob is resolved with the positive-number pattern')
  assert.match(toolsSrc, /HEALTH_ERROR_WINDOW_MS/, 'the default cap is the shared 2h anomaly window')

  // The quirk: HEAD of the worktree STILL freezes the CUT-4 zone (the cap
  // lives OUTSIDE the frozen span — lines 4885-6196; the tools.ts edit here is
  // at the interrupted-post seam, safely before the banner).
  const toolsLines = toolsSrc.split('\n')
  const bannerLine = toolsLines.findIndex((l) => l.includes('messaging bus TOOL DEFINITIONS'))
  const closeLine = toolsLines.findIndex((l) => l.includes("'deepartments: host-plane tools')"))
  const seamLine = toolsLines.findIndex((l) => l.includes('prevHeartbeatStale'))
  assert.ok(bannerLine !== -1 && closeLine !== -1 && seamLine !== -1)
  assert.ok(seamLine < bannerLine, 'the staleness-cap edit sits BEFORE the CUT-4 frozen span (the zone md5 7693beaa is untouched)')

  // Export-parity: the lane's ONLY runtime-visible additions would be in the
  // dshd-health surface (the star bridge) — NONE were added (the guard manifest
  // + tools.ts inline + org-types type-only knob). org-types is TYPE-only (no
  // runtime export), so lib/invoke.js's export COUNT is unchanged.
  const healthSrc = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-health', 'src', 'index.ts'), 'utf8')
  assert.doesNotMatch(healthSrc, /HeartbeatStale|heartbeatStale/, 'dshd-health src carries NO stale-cap additions (zero surface drift)')
})