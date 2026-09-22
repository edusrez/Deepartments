// dsh-deepartments — LANE W3 (MISIÓN POOLER, host 2026-09-22) — DETECTOR/ALERTA:
// the appearance of the OFFICIAL API in the pooler can NEVER be silent.
//
// WHY (measured by the host): the owner's official key entered the pooler on
// 2026-09-17T10:31 as the declared channel `ds-official` and dried his balance
// (402 Insufficient Balance at 09-18T07:50:42Z and 09-22T06:13:29Z) with ZERO
// ALERTS — the owner learned it from a 503 of his own turn. The binding host
// decision (D2) was to REUSE the health pipeline that already exists
// (findings → shared dedupe ledger → notifyHost), never a new channel: a
// channel with no consumer is worse than none.
//
// THE SEAM UNDER TEST: the pooler publishes the ADDITIVE marker
// `officialApiGuard` on keyPooler-state.json (produced by lane W1);
// `scanPoolerCapacity` turns >=1 entry into ONE finding on its OWN per-mode
// dedupe key, and the finding rides the EXISTING pipeline. ABSENT / null / an
// EMPTY entries list → 0 findings (byte-identical to the pre-W3 scan).
//
// fb-95 (AGENTS.md): this is a BUILT-lib test (plain `node --test` over
// lib/invoke.js) — it does NOT self-register the ts-src-loader hook.
//
// WHAT THIS FILE DOES NOT MEASURE (declared honestly): the real bus transport
// (notifyHost is a recording spy here), the live pooler producer (lane W1 owns
// the write side; these fixtures are the FROZEN interface contract), and the
// 30-min WALL-CLOCK cadence (the assertions drive the ledger with injected
// clocks — the same technique the sibling pool/machine suite uses).
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  POOLER_CAPACITY_KEY_CRITICAL,
  buildHealthAlertFrame,
  readHealthAlertsState,
  runHealthDaemonTick,
  scanPoolerCapacity
} from '../lib/invoke.js'

const T0 = 1_788_000_000_000
const MIN = 60_000

// The per-mode dedupe keys the lane freezes. They are asserted as LITERALS
// (module-private in the source — the bundle's compiled export surface is
// frozen at 349 by test/export-parity.test.js, so this lane adds no export).
const KEY_DECLARED = 'pooler-capacity:official-api:declared'
const KEY_LEGACY = 'pooler-capacity:official-api:legacy'

const SCAN_KNOBS = {
  stateStaleMs: 600_000,
  warningUsableKeys: 1,
  okUsableKeys: 2,
  blockedKeysInWindow: 3,
  criticalGlobalRemainingPercent: 20,
  criticalWeeklyRemainingPercent: 10
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'pooler-official-api-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** The healthy Go-pool key shape (the sibling pool suite's oc-6 device): one
 * usable key with plenty of quota — so the ONLY possible finding is the one
 * this lane adds (the control that makes every positive assertion attributable). */
const oc6 = (weeklyPct = 10, monthlyPct = 20) => ({
  id: 'oc-6',
  workspace: 'ws6',
  invalid: false,
  blockedUntil: 0,
  cooldownUntil: 0,
  usageWeekly: { status: 'ok', percent: weeklyPct, resetsAt: new Date(1_789_000_000_000).toISOString() },
  usageMonthly: { status: 'ok', percent: monthlyPct, resetsAt: new Date(1_790_000_000_000).toISOString() },
  lastError: null,
  lastCheckedAt: 0
})

/** A LEGITIMATE declared channel of the Go pool (the fb-630 `commandcode`
 * shape — declaring a channel is NORMAL and must never trip the official-API
 * class). */
const legitChannel = (id = 'commandcode') => ({ id, enabled: true, peer: true, halted: false, cooldownUntil: 0 })

/** Write a pooler snapshot. `officialApiGuard` is written ONLY when given:
 * `undefined` leaves the field ABSENT (the pre-W3 legacy shape), an explicit
 * `null` writes null (the healthy producer shape). */
async function writeSnapshot(stateDir, name, { nowMs, keys, updatedAtOffsetMs = 60_000, channels, officialApiGuard }) {
  const p = path.join(stateDir, `${name}.json`)
  const snapshot = {
    updatedAt: new Date(nowMs - updatedAtOffsetMs).toISOString(),
    keys,
    lastRotation: null
  }
  if (channels !== undefined) snapshot.channels = channels
  if (officialApiGuard !== undefined) snapshot.officialApiGuard = officialApiGuard
  await writeFile(p, JSON.stringify(snapshot), 'utf8')
  return p
}

/** The FROZEN interface contract (lane W1) — the `declared` branch: the channel
 * entry RESOLVED to the official API and was REJECTED (never loaded, never
 * serves). */
const GUARD_DECLARED = {
  at: '2026-09-22T06:00:00.000Z',
  mode: 'declared',
  entries: [{
    channelId: 'ds-official',
    upstreamHost: 'api.deepseek.com',
    rule: 'official-upstream',
    keySource: 'env:DEEPSEEK_API_KEY'
  }]
}

/** The FROZEN interface contract (lane W1) — the `legacy` branch: the singleton
 * WAS LOADED but is INERT (it never serves). */
const GUARD_LEGACY = {
  at: '2026-09-22T06:00:00.000Z',
  mode: 'legacy',
  entries: [{
    channelId: 'ds-official',
    upstreamHost: 'api.deepseek.com',
    rule: 'official-key-sha16',
    keySource: 'file:deepseek-official.key'
  }]
}

// ===========================================================================
// (a) THE EXACT REGRESSION — no marker ⇒ 0 findings.
// ===========================================================================
test('W3 (a) REGRESIÓN EXACTA: a snapshot WITHOUT `officialApiGuard` (the pre-W3 legacy shape) and one with an explicit `null` (the healthy producer shape) ⇒ 0 findings — the added branch is INERT when nothing appeared', async () => {
  await withTempStateDir(async (stateDir) => {
    const legacy = await writeSnapshot(stateDir, 'no-field', { nowMs: T0, keys: { 'oc-6': oc6() } })
    assert.deepEqual(scanPoolerCapacity(legacy, T0, SCAN_KNOBS), [], 'absent field → 0 findings (byte-identical to the pre-W3 scan)')
    const healthyNull = await writeSnapshot(stateDir, 'null-field', { nowMs: T0, keys: { 'oc-6': oc6() }, officialApiGuard: null })
    assert.deepEqual(scanPoolerCapacity(healthyNull, T0, SCAN_KNOBS), [], 'explicit null → 0 findings (the healthy producer shape)')
    // SOUNDNESS: the marker is present but says NOTHING appeared (0 entries) —
    // an empty list must never be inflated into an appearance.
    const emptyEntries = await writeSnapshot(stateDir, 'empty-entries', {
      nowMs: T0,
      keys: { 'oc-6': oc6() },
      officialApiGuard: { at: '2026-09-22T06:00:00.000Z', mode: 'declared', entries: [] }
    })
    assert.deepEqual(scanPoolerCapacity(emptyEntries, T0, SCAN_KNOBS), [], 'entries: [] → 0 findings (nothing appeared; never fabricate)')
    const noEntriesField = await writeSnapshot(stateDir, 'no-entries', {
      nowMs: T0,
      keys: { 'oc-6': oc6() },
      officialApiGuard: { at: '2026-09-22T06:00:00.000Z', mode: 'declared' }
    })
    assert.deepEqual(scanPoolerCapacity(noEntriesField, T0, SCAN_KNOBS), [], 'entries ABSENT → 0 findings (only >=1 entry is an appearance)')
  })
})

// ===========================================================================
// (b) mode:'declared' — the REJECTED branch.
// ===========================================================================
test("W3 (b) mode:'declared' con 1 entrada ⇒ 1 hallazgo con la CLAVE NUEVA y el texto nombrando canal/host/regla (la aparición del canal declarado `ds-official` fue RECHAZADA, y aun así alerta)", async () => {
  await withTempStateDir(async (stateDir) => {
    const p = await writeSnapshot(stateDir, 'declared', { nowMs: T0, keys: { 'oc-6': oc6() }, officialApiGuard: GUARD_DECLARED })
    const findings = scanPoolerCapacity(p, T0, SCAN_KNOBS)
    assert.equal(findings.length, 1, 'EXACTAMENTE 1 hallazgo')
    assert.equal(findings[0].kind, 'pooler-capacity', 'the kind reuses the EXISTING pooler-capacity class (no new kind)')
    assert.equal(findings[0].key, KEY_DECLARED, 'the dedupe key is the NEW per-mode key — never POOLER_CAPACITY_KEY_CRITICAL')
    assert.notEqual(findings[0].key, POOLER_CAPACITY_KEY_CRITICAL, 'it never collides with the capacity critical key')
    assert.equal(findings[0].ts, T0, 'the finding is stamped at the tick clock')
    assert.equal(findings[0].count, 1, 'the count is the number of matching sources')
    const error = findings[0].error
    assert.match(error, /ds-official/, 'the text NAMES the channel')
    assert.match(error, /api\.deepseek\.com/, 'the text NAMES the upstream host')
    assert.match(error, /official-upstream/, 'the text NAMES the rule')
    assert.match(error, /env:DEEPSEEK_API_KEY/, 'the text NAMES the key PROVENANCE (never the key value)')
    assert.match(error, /mode declared .*REJECTED/, 'the text names the branch: the entry was REJECTED (never loaded)')
    assert.match(error, /PERSONAL RESERVE/, "the text states WHY it matters: the owner's key is personal reserve")
    assert.match(error, /must NEVER use it/, 'the text states the architectural rule')
  })
})

// ===========================================================================
// (c) mode:'legacy' — the LOADED-but-INERT branch.
// ===========================================================================
test("W3 (c) mode:'legacy' ⇒ 1 hallazgo con la clave de SU modo (`…:legacy`) y el texto diciendo que el singleton se CARGÓ pero es INERTE — la aparición alerta en AMBAS ramas", async () => {
  await withTempStateDir(async (stateDir) => {
    const p = await writeSnapshot(stateDir, 'legacy', { nowMs: T0, keys: { 'oc-6': oc6() }, officialApiGuard: GUARD_LEGACY })
    const findings = scanPoolerCapacity(p, T0, SCAN_KNOBS)
    assert.equal(findings.length, 1, 'EXACTAMENTE 1 hallazgo')
    assert.equal(findings[0].key, KEY_LEGACY, 'the legacy branch has its OWN key (a declared→legacy transition is a new fact, never swallowed)')
    assert.notEqual(findings[0].key, KEY_DECLARED, 'the two modes do not share a key')
    const error = findings[0].error
    assert.match(error, /ds-official/, 'the text NAMES the channel')
    assert.match(error, /api\.deepseek\.com/, 'the text NAMES the upstream host')
    assert.match(error, /official-key-sha16/, 'the text NAMES the rule of THIS branch')
    assert.match(error, /file:deepseek-official\.key/, 'the text NAMES the key provenance of THIS branch')
    assert.match(error, /mode legacy .*WAS LOADED but is INERT/, 'the text names the branch: LOADED but INERT — it never serves, the owner decided, no opt-in')
  })
})

// ===========================================================================
// (d) THE TRAP — the check must run BEFORE the stale early-return.
// ===========================================================================
test('W3 (d) LA TRAMPA: el marcador sobre un snapshot STALE (updatedAt 60 min > stateStaleMs 10 min) SALE IGUAL — la declaración es FIRME y NO envejece (el precedente billing), y NO se emite el warn de stale (el estado no es UNKNOWN: es CONOCIDO y alarmante)', async () => {
  await withTempStateDir(async (stateDir) => {
    for (const [name, guard, key] of [['stale-declared', GUARD_DECLARED, KEY_DECLARED], ['stale-legacy', GUARD_LEGACY, KEY_LEGACY]]) {
      const stale = await writeSnapshot(stateDir, name, {
        nowMs: T0,
        keys: { 'oc-6': oc6() },
        officialApiGuard: guard,
        updatedAtOffsetMs: 60 * MIN // > stateStaleMs (10 min) → the dead-man's-switch would call it UNKNOWN
      })
      const warns = []
      const findings = scanPoolerCapacity(stale, T0, SCAN_KNOBS, { warn: (m) => warns.push(m) })
      assert.equal(findings.length, 1, `(${name}) a STALE snapshot carrying the marker STILL alerts — the appearance is NEVER silenced by staleness`)
      assert.equal(findings[0].key, key, `(${name}) and on its own per-mode key`)
      assert.deepEqual(warns, [], `(${name}) NO stale warn: the marker branch runs BEFORE the stale early-return (the state is not UNKNOWN — it is KNOWN and alarming)`)
    }
    // THE CONTROL that proves the position is load-bearing: the SAME staleness
    // WITHOUT the marker DOES return [] and DOES warn.
    const stalePlain = await writeSnapshot(stateDir, 'stale-plain', { nowMs: T0, keys: { 'oc-6': oc6() }, updatedAtOffsetMs: 60 * MIN })
    const warnsPlain = []
    assert.deepEqual(scanPoolerCapacity(stalePlain, T0, SCAN_KNOBS, { warn: (m) => warnsPlain.push(m) }), [], 'CONTROL: a stale snapshot WITHOUT the marker keeps the m-2333 behavior (UNKNOWN ≠ exhausted → 0 findings)')
    assert.equal(warnsPlain.length, 1, 'CONTROL: and it DOES emit the stale warn (so the empty-warns assertions above are discriminating, not vacuous)')
    assert.match(warnsPlain[0], /pooler state unknown\/stale/, 'CONTROL: the warn names the stale class')
  })
})

// ===========================================================================
// (e) A LEGITIMATE declared channel is NOT the official API.
// ===========================================================================
test('W3 (e) un canal declarado LEGÍTIMO (`commandcode`) ⇒ 0 hallazgos de la clase nueva Y la semántica de serving/criticals intacta (declarar un canal es NORMAL)'  , async () => {
  await withTempStateDir(async (stateDir) => {
    // A healthy Go pool + the legitimate declared channel: the channel COUNT as
    // serving (fb-630) and NO official-API finding (the marker is absent — the
    // only thing that can produce the new class).
    const p = await writeSnapshot(stateDir, 'legit-channel', {
      nowMs: T0,
      keys: { 'oc-6': oc6() },
      channels: [legitChannel()]
    })
    assert.deepEqual(scanPoolerCapacity(p, T0, SCAN_KNOBS), [], 'a legitimate declared channel → 0 findings of ANY class (the new branch is not a channel census)')
    // The SAME legitimate channel PLUS the marker: exactly ONE finding and it is
    // the official-API one — the legit channel never appears in it.
    const withMarker = await writeSnapshot(stateDir, 'legit-channel-marker', {
      nowMs: T0,
      keys: { 'oc-6': oc6() },
      channels: [legitChannel()],
      officialApiGuard: GUARD_DECLARED
    })
    const findings = scanPoolerCapacity(withMarker, T0, SCAN_KNOBS)
    assert.equal(findings.length, 1, 'the legit channel adds no finding of its own')
    assert.equal(findings[0].key, KEY_DECLARED, 'and the single finding is the official-API one')
    assert.doesNotMatch(findings[0].error, /commandcode/, 'the legitimate channel is NEVER named by the official-API finding')
    // SERVING/CRITICAL SEMANTICS INTACT: a snapshot whose only serving source is
    // the legitimate channel (0 Go keys usable) keeps the fb-630 verdict — the
    // PRE-FIX bug was the HALT firing while a declared channel was serving.
    const channelOnly = await writeSnapshot(stateDir, 'channel-only', {
      nowMs: T0,
      keys: { 'oc-6': { ...oc6(), invalid: true } },
      channels: [legitChannel()]
    })
    assert.deepEqual(scanPoolerCapacity(channelOnly, T0, SCAN_KNOBS), [], 'a serving declared channel still satisfies the fb-630 predicate (the outage branch requires 0 serving sources) — 0 regression')
    // And the CERTAIN outage is untouched: no usable key AND no serving channel.
    const outage = await writeSnapshot(stateDir, 'outage', { nowMs: T0, keys: { 'oc-6': { ...oc6(), invalid: true } } })
    const outageFindings = scanPoolerCapacity(outage, T0, SCAN_KNOBS)
    assert.equal(outageFindings.length, 1, 'the 0-usable outage still fires')
    assert.equal(outageFindings[0].key, POOLER_CAPACITY_KEY_CRITICAL, 'and it keeps its OWN critical key (the new class never replaces it)')
    assert.match(outageFindings[0].error, /outage total/, 'and its byte-identical text')
  })
})

// ===========================================================================
// (f) DEDUPE — the new key rides the SHARED ledger without collision.
// ===========================================================================
test('W3 (f) DEDUPE en el ledger COMPARTIDO: la clave nueva avanza en health-alerts-state.json y NO colisiona con `pooler-capacity:critical` — una aparición y una caída de capacidad alertan en el MISMO tramo (dos hechos independientes)', async () => {
  await withTempStateDir(async (stateDir) => {
    const hosts = [{ hostId: 'host-asst', sessionId: 's-live' }]
    // The notifyHost spy collects EVERY alert leg the tick emits (the pooler and
    // the PRE-EXISTING capacity-gate monitor both ride this seam — a raw call
    // count would conflate them, so the assertions filter on the BULLET).
    const tickDeps = (nowMs, alerts, poolerStatePath) => ({
      now: () => nowMs,
      stateDir,
      bootId: 'boot-w3-1',
      config: { health: {} },
      hosts,
      posts: [],
      poolerStatePath,
      notifyHost: async (_hostEntry, frame) => { alerts.push({ frame }) }
    })
    const poolerBullets = (alerts) => alerts.flatMap((a) => a.frame.match(/- pooler-capacity[^\n]*/g) ?? [])
    // TICK 1 — the official-API appearance (STALE, to prove the trap end-to-end
    // through the REAL tick, not only the pure scan).
    const guardPath = await writeSnapshot(stateDir, 'tick-guard', {
      nowMs: T0,
      keys: { 'oc-6': oc6() },
      officialApiGuard: GUARD_DECLARED,
      updatedAtOffsetMs: 60 * MIN
    })
    const a1 = []
    await runHealthDaemonTick(tickDeps(T0, a1, guardPath))
    const bullets1 = poolerBullets(a1)
    assert.equal(bullets1.length, 1, 'the REAL tick alerts the host through the EXISTING pipeline (the alert IS the notifyHost — no new channel)')
    assert.match(bullets1[0], /^- pooler-capacity critical: OFFICIAL API in the pooler/, 'the frame bullet is the official-API class, labelled critical')
    const ledger1 = readHealthAlertsState(stateDir)
    assert.equal(ledger1[KEY_DECLARED], T0, 'the NEW key advanced in the SHARED ledger')
    assert.equal(ledger1[POOLER_CAPACITY_KEY_CRITICAL], undefined, 'and it did NOT write the capacity critical key (no collision)')
    // TICK 2 — a REAL capacity outage in the SAME ledger, one minute later: it
    // must alert on ITS OWN key (the new class did not eat its dedupe).
    const outagePath = await writeSnapshot(stateDir, 'tick-outage', {
      nowMs: T0 + MIN,
      keys: { 'oc-6': { ...oc6(), invalid: true } }
    })
    const a2 = []
    await runHealthDaemonTick(tickDeps(T0 + MIN, a2, outagePath))
    const bullets2 = poolerBullets(a2)
    assert.equal(bullets2.length, 1, 'the capacity critical fires in the same ledger window (it was NOT swallowed by the official-API key)')
    assert.match(bullets2[0], /^- pooler-capacity critical: 0 usable/, 'with the EXISTING critical rendering (unchanged text)')
    const ledger2 = readHealthAlertsState(stateDir)
    assert.equal(ledger2[POOLER_CAPACITY_KEY_CRITICAL], T0 + MIN, 'the capacity critical key has its OWN entry')
    assert.equal(ledger2[KEY_DECLARED], T0, 'while the official-API key keeps its own stamp (independent cadences)')
    // TICK 3 — the SAME outage 2 min later: deduped (≤1 alert per key per window).
    const a3 = []
    await runHealthDaemonTick(tickDeps(T0 + 3 * MIN, a3, outagePath))
    assert.equal(poolerBullets(a3).length, 0, 'the capacity key deduped its own repeat (the legacy per-key 30-min window is preserved)')
    // TICK 4 — and the OFFICIAL-API marker again, still inside the window on its
    // own key: ALSO deduped (it has a real cadence, not a re-alert loop).
    const a4 = []
    await runHealthDaemonTick(tickDeps(T0 + 4 * MIN, a4, guardPath))
    assert.equal(poolerBullets(a4).length, 0, 'the official-API key deduped its own repeat inside the 30-min window')
    // TICK 5 — PAST the 30-min window the appearance RE-ALERTS (the marker is
    // still there: the condition persists, so the alert must persist).
    const a5 = []
    await runHealthDaemonTick(tickDeps(T0 + 31 * MIN, a5, guardPath))
    assert.equal(poolerBullets(a5).length, 1, 'past the dedupe window the official-API appearance re-alerts while the condition persists')
    assert.match(poolerBullets(a5)[0], /OFFICIAL API in the pooler/, 'and it is the same class/key identity')
  })
})

// ===========================================================================
// (g) THE RENDER — the class is named EXPLICITLY (never mis-labelled warning).
// ===========================================================================
test("W3 (g) RENDER: `buildHealthAlertFrame` etiqueta la clase `official-api` EXPLÍCITAMENTE como critical (la inferencia por clave la habría llamado `warning`) y NOMBRA mode + channelId + upstreamHost + rule + keySource — sin tocar el grado ni el texto de NINGUNA clase existente", async () => {
  // The two real findings, rendered through the REAL frame builder.
  const frameDeclared = buildHealthAlertFrame([{
    kind: 'pooler-capacity',
    key: KEY_DECLARED,
    ts: T0,
    count: 1,
    error: 'OFFICIAL API in the pooler (mode declared (the channel entry was REJECTED — never loaded, never serves)) — 1 source(s): ds-official → api.deepseek.com (rule official-upstream key-source env:DEEPSEEK_API_KEY) — the owner\'s official key is PERSONAL RESERVE and this architecture must NEVER use it; remove the source from the pooler config (the guard keeps it INERT/REJECTED — it is NOT serving)'
  }])
  assert.match(frameDeclared, /^- pooler-capacity critical: OFFICIAL API in the pooler \(mode declared/m, 'the bullet is labelled CRITICAL — the old key-inference would have said `warning`')
  assert.doesNotMatch(frameDeclared, /pooler-capacity warning/, 'never rendered as a soft warning')
  for (const token of ['ds-official', 'api.deepseek.com', 'official-upstream', 'env:DEEPSEEK_API_KEY', 'PERSONAL RESERVE', 'must NEVER use it']) {
    assert.ok(frameDeclared.includes(token), `the bullet names ${token}`)
  }
  const frameLegacy = buildHealthAlertFrame([{
    kind: 'pooler-capacity',
    key: KEY_LEGACY,
    ts: T0,
    count: 1,
    error: "OFFICIAL API in the pooler (mode legacy (the singleton WAS LOADED but is INERT — it never serves; the owner's decision, no opt-in)) — 1 source(s): ds-official → api.deepseek.com (rule official-key-sha16 key-source file:deepseek-official.key) — the owner's official key is PERSONAL RESERVE and this architecture must NEVER use it; remove the source from the pooler config (the guard keeps it INERT/REJECTED — it is NOT serving)"
  }])
  assert.match(frameLegacy, /^- pooler-capacity critical: OFFICIAL API in the pooler \(mode legacy/m, 'the legacy branch is ALSO labelled critical (both branches alert)')
  assert.ok(frameLegacy.includes('official-key-sha16'), 'the legacy bullet names ITS rule')
  assert.ok(frameLegacy.includes('file:deepseek-official.key'), 'the legacy bullet names ITS key provenance')
  // ZERO REGRESSION on the existing classes: the critical and the (retired but
  // still renderable) warning literals are byte-identical. The comparison is on
  // the BULLET (the frame prepends its own header — that header is not part of
  // the per-finding rendering under test).
  const bulletOf = (frame) => (frame.match(/- pooler-capacity[^\n]*/g) ?? [])[0]
  assert.equal(
    bulletOf(buildHealthAlertFrame([{ kind: 'pooler-capacity', key: POOLER_CAPACITY_KEY_CRITICAL, ts: T0, count: 0, error: '0 usable / 3 keys — outage total: NO usable key (scarcity decides; the «todas-secas» class — pool cannot serve; resume with a fresh key)' }])),
    '- pooler-capacity critical: 0 usable / 3 keys — outage total: NO usable key (scarcity decides; the «todas-secas» class — pool cannot serve; resume with a fresh key)',
    'the EXISTING critical bullet is byte-identical (the new branch is additive)'
  )
  assert.equal(
    bulletOf(buildHealthAlertFrame([{ kind: 'pooler-capacity', key: 'pooler-capacity:warning', ts: T0, count: 1, error: 'solo una key' }])),
    '- pooler-capacity warning: solo una key',
    'and any OTHER pooler key still renders `warning` EXACTLY as before (only the official-api keys take the new branch)'
  )
  // The FALLBACK literals (no `error`) are untouched too — the branch only
  // intercepts the two official-api keys, so their defaults never move.
  assert.equal(
    bulletOf(buildHealthAlertFrame([{ kind: 'pooler-capacity', key: 'pooler-capacity:warning', ts: T0, count: 1 }])),
    '- pooler-capacity warning: pool capacity low (1 usable)',
    'the warning FALLBACK text is unchanged'
  )
})

// ===========================================================================
// (h) ADDITIVITY — the appearance must survive a COINCIDENT capacity class.
// ===========================================================================
test('W3 (h) ADITIVIDAD (el caso MEDIDO): una aparición COINCIDENTE con una clase de capacidad (todas las keys billing-blocked / outage 0-usable / HALT) NO queda silenciada — los hallazgos de capacidad salen BYTE-IDÉNTICOS y la clase nueva se AÑADE a su lado, de forma que el veredicto `pooler-capacity:critical` del gate de capacidad no cambia', async () => {
  await withTempStateDir(async (stateDir) => {
    // THE MEASURED INCIDENT exactly: the official key dried the balance AND the
    // pool went dry in the same snapshot. Before this lane the billing branch's
    // early-return would have made the appearance unreachable.
    const billingKey = { ...oc6(), billingBlocked: true }
    const coincident = await writeSnapshot(stateDir, 'coincident-billing', {
      nowMs: T0,
      keys: { 'oc-6': billingKey },
      officialApiGuard: GUARD_DECLARED
    })
    const findings = scanPoolerCapacity(coincident, T0, SCAN_KNOBS)
    assert.equal(findings.length, 2, 'BOTH facts alert in the SAME tick (the appearance is additive, never a branch that steals it)')
    const capacity = findings.find((f) => f.key === POOLER_CAPACITY_KEY_CRITICAL)
    const official = findings.find((f) => f.key === KEY_DECLARED)
    assert.notEqual(capacity, undefined, 'the capacity CRITICAL is still emitted')
    assert.equal(capacity.error, 'billing/credits block on 1/1 keys (401 CreditsError class) — pausa de nuevos despachos; resume al recuperar', 'and its text is BYTE-IDENTICAL to the pre-W3 billing finding')
    assert.notEqual(official, undefined, 'and the official-API appearance is emitted ALONGSIDE it (never silenced)')
    // The 0-usable outage coincidence.
    const outage = await writeSnapshot(stateDir, 'coincident-outage', {
      nowMs: T0,
      keys: { 'oc-6': { ...oc6(), invalid: true } },
      officialApiGuard: GUARD_LEGACY
    })
    const outageFindings = scanPoolerCapacity(outage, T0, SCAN_KNOBS)
    assert.equal(outageFindings.length, 2, 'the 0-usable outage + the appearance both alert')
    assert.match(outageFindings.find((f) => f.key === POOLER_CAPACITY_KEY_CRITICAL).error, /^0 usable \/ 1 keys — outage total/, 'the outage text is byte-identical')
    assert.equal(outageFindings.find((f) => f.key === KEY_LEGACY).key, KEY_LEGACY, 'and the appearance rides its own key')
    // The HALT coincidence (1 usable, monthly available < 10%).
    const halt = await writeSnapshot(stateDir, 'coincident-halt', {
      nowMs: T0,
      keys: { 'oc-6': oc6(10, 95) },
      officialApiGuard: GUARD_DECLARED
    })
    const haltFindings = scanPoolerCapacity(halt, T0, { ...SCAN_KNOBS, haltWeeklyAvailablePercent: 20, haltMonthlyAvailablePercent: 10 })
    assert.equal(haltFindings.length, 2, 'the HALT + the appearance both alert')
    assert.match(haltFindings.find((f) => f.key === POOLER_CAPACITY_KEY_CRITICAL).error, /^HALT \(m-2333\)/, 'the HALT text is byte-identical')
    // AND THE CONTROL THAT PROVES THE ADDITIVITY IS INERT WITHOUT THE MARKER:
    // the SAME capacity snapshots carry NO extra finding when the marker is
    // absent (byte-identical pre-W3 behavior, the regression guarantee).
    const billingNoMarker = await writeSnapshot(stateDir, 'billing-no-marker', { nowMs: T0, keys: { 'oc-6': billingKey } })
    assert.equal(scanPoolerCapacity(billingNoMarker, T0, SCAN_KNOBS).length, 1, 'CONTROL: all-billing-blocked WITHOUT the marker → exactly the 1 pre-W3 finding')
    const outageNoMarker = await writeSnapshot(stateDir, 'outage-no-marker', { nowMs: T0, keys: { 'oc-6': { ...oc6(), invalid: true } } })
    assert.equal(scanPoolerCapacity(outageNoMarker, T0, SCAN_KNOBS).length, 1, 'CONTROL: 0-usable WITHOUT the marker → exactly the 1 pre-W3 finding')
  })
})

// ===========================================================================
// BONUS — the finding is DEFENSIVE on a malformed/foreign marker (the blind
// cast of readPoolerStateFile means the union is NOT enforced on disk).
// ===========================================================================
test('W3 (bono) ROBUSTEZ del cast ciego: un marcador con entradas PARCIALES o con un `mode` desconocido NUNCA produce un hallazgo sin clave ni un throw — los campos ausentes se declaran ausentes (nunca se inventan) y el modo cae en la lectura conservadora', async () => {
  await withTempStateDir(async (stateDir) => {
    const partial = await writeSnapshot(stateDir, 'partial', {
      nowMs: T0,
      keys: { 'oc-6': oc6() },
      officialApiGuard: { mode: 'declared', entries: [{ channelId: 'ds-official' }] }
    })
    const findings = scanPoolerCapacity(partial, T0, SCAN_KNOBS)
    assert.equal(findings.length, 1, 'a partial entry is still an APPEARANCE — it must alert (never a silent skip)')
    assert.equal(findings[0].key, KEY_DECLARED, 'the key is always resolvable')
    assert.match(findings[0].error, /\(host unknown\)/, 'the absent host is declared absent, never invented')
    assert.match(findings[0].error, /\(rule unknown\)/, 'the absent rule is declared absent')
    assert.doesNotMatch(findings[0].error, /key-source/, 'the absent keySource is omitted (never synthesized)')
    const oddMode = await writeSnapshot(stateDir, 'odd-mode', {
      nowMs: T0,
      keys: { 'oc-6': oc6() },
      officialApiGuard: { mode: 'a-future-branch', entries: [{ channelId: 'ds-official', upstreamHost: 'api.deepseek.com', rule: 'future-rule' }] }
    })
    const oddFindings = scanPoolerCapacity(oddMode, T0, SCAN_KNOBS)
    assert.equal(oddFindings.length, 1, 'an unknown mode is still an appearance')
    assert.equal(oddFindings[0].key, KEY_DECLARED, 'an unknown mode reads conservatively (the declared key), never a keyless finding')
    assert.match(oddFindings[0].error, /mode unknown/, 'and the unknown mode is rendered verbatim as unknown (never labelled as a known branch)')
  })
})
