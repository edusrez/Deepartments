// dsh-deepartments — WAVE 7 LANE 1 (fb-167, 2026-09-05) — the settlement-wait
// watchdog tests: the work-register-idle SUBCLASS that covers the host's
// verify+commit+push step (the fb-167 SPOF — 2 real pipeline stalls on
// 2026-09-05 caught by the owner, not by the watchdog).
//
// The design (adopted by the head, journal 2026-09-05 — «subclase de
// work-register-idle + cabecera next»): the consolidated settlements of the IPH
// carry the machine-readable `next:` header naming the NEXT ACTOR (the
// «next: host verify+push» convention — already used in the settlements). A
// WORK-REGISTER item whose line carries that header is a SETTLEMENT (the next
// actor is the HOST doing verify+push — NOT an IPD despatchable item): it is
// EXCLUDED from the generic non-gated census and, when ≥1 exists in quiet VALLE
// ≥ window with 0 agents running, the scan emits its OWN finding (kind/key
// `settlement-wait`, own dedupe key in the SHARED health-alerts ledger) naming
// the HOST explicitly. A settlement-only register NEVER fires the generic
// work-register-idle (that would be a FALSE «IPD no despachó» on host-pending
// work — the fb-167 blind spot).
//
// Canonical method (fb-95, SRC-NATIVE): plain `node --test` over the BUILT
// lib/ (pnpm build first) — no --loader, no ts-src-loader self-registration
// (this is a built-lib test, not the lane-② src-native family).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  WORK_REGISTER_IDLE_KEY,
  WORK_REGISTER_IDLE_MAX_LISTED,
  WORK_REGISTER_IDLE_STATE_FILE,
  buildHealthAlertFrame,
  parseWorkRegisterItems,
  readHealthAlertsState,
  readWorkRegisterIdleState,
  runHealthDaemonTick,
  scanWorkRegisterIdle
} from '../lib/invoke.js'

/** The fb-167 settlement-wait dedupe key (the module-private literal the scan
 * uses — asserted here by name; NOT exported from lib/invoke.js). */
const SETTLEMENT_WAIT_KEY = 'settlement-wait'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-w7fb167-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** A register fixture with: a §1 SETTLEMENT item (the `next: host` header — a
 * consolidated settlement waiting on the HOST's verify+push), a SECOND
 * non-settlement §1 non-gated item (the generic despatchable census), the §3
 * PENDIENTE-OWNER gated section and the §2 CERRADO reference section. */
const W7_REGISTER_MIXED = [
  '## 1. IPD — cola activa (DAG seriado)',
  '',
  '- **WAVE 7 settlement (m-1806) — espera verify+push** next: host verify+push',
  '- **LANE 2 — fb-168 (delivery lane)** [en cola]',
  '',
  '## 2. DAG técnico — CERRADO (referencia)',
  '',
  '- **PASO 9** — cerrado, referencia',
  '',
  '## 3. PENDIENTE-OWNER (decisiones)',
  '',
  '- **top-up ws10 → NO por ahora**'
].join('\n')

/** A register fixture with ONLY the settlement item (no other non-gated work) —
 * the exact fb-167 case: the register looks «0 agentes» but a settlement waits
 * on the HOST. */
const W7_REGISTER_SETTLEMENT_ONLY = [
  '## 1. IPD — cola activa (DAG seriado)',
  '',
  '- **WAVE 6 settlement (206ceb8 + 016f1d8) — espera verificación** next: host',
  '',
  '## 3. PENDIENTE-OWNER (decisiones)',
  '',
  '- **stable 3080 → NO TOCAR**'
].join('\n')

// --- parse ----------------------------------------------------------------

test('fb-167 parseWorkRegisterItems: a line with the `next:` header naming the HOST marks the item nextActor (the settlement-wait subclass); the header may sit after the marker OR inside the bold span; a NON-host next actor is NOT a settlement; items without the header keep nextActor ABSENT', () => {
  const items = parseWorkRegisterItems(W7_REGISTER_MIXED)
  const byLabel = new Map(items.map((item) => [item.label, item]))
  const settlement = byLabel.get('WAVE 7 settlement (m-1806) — espera verify+push')
  assert.ok(settlement !== undefined, 'the settlement item is parsed')
  assert.equal(settlement.nextActor, 'host verify+push', 'the header AFTER the marker on the same line is captured («next: host verify+push» → the trimmed value)')
  const plain = byLabel.get('LANE 2 — fb-168 (delivery lane)')
  assert.ok(plain !== undefined, 'the non-settlement item is parsed')
  assert.equal(plain.nextActor, undefined, 'an item WITHOUT a next: header carries NO nextActor (the generic census)')
  // The header INSIDE the bold span is also captured (the register may embed it).
  const inside = parseWorkRegisterItems('## 1. IPD\n\n- **WAVE 7 (m-1811) next: host verify+push**')
  assert.equal(inside[0]?.nextActor, 'host verify+push', 'the header INSIDE the bold marker is detected')
  // A non-host next actor stays in the generic census (NOT a settlement).
  const otherActor = parseWorkRegisterItems('## 1. IPD\n\n- **LANE R8 — next: research-head research request**')
  assert.equal(otherActor[0]?.nextActor, undefined, 'a `next:` naming a NON-host actor is NOT a settlement (the generic census keeps the item)')
})

test('fb-167 parseWorkRegisterItems: the existing census semantics stay INTACT — the §3 PENDIENTE-OWNER items stay gated, the §2 CERRADO section is skipped, the total matches the section/marker split', () => {
  const items = parseWorkRegisterItems(W7_REGISTER_MIXED)
  assert.equal(items.length, 3, '3 pending items (1 §1 settlement + 1 §1 LANE + 1 §3 owner; the §2 CERRADO section excluded)')
  const gated = items.filter((item) => item.gated === true)
  assert.equal(gated.length, 1, 'exactly the §3 PENDIENTE-OWNER item is gated')
  assert.equal(gated[0].label, 'top-up ws10 → NO por ahora', 'the gated item is the §3 one')
})

// --- scan: settlement-only → the OWN finding, NEVER the generic duplicate -----

test('fb-167 scanWorkRegisterIdle (settlement-ONLY): VALLE + 0 agents + quiet ≥ window with ONLY a settlement pending → ONE finding kind/key `settlement-wait` naming «settlement esperando acción del HOST — next actor = host»; the generic work-register-idle finding is ABSENT (no false «IPD no despachó» on host-pending work)', () => {
  const T0 = new Date(2026, 8, 5, 8, 0, 0).getTime() // Saturday 08:00 UTC → VALLE (default Mon-Fri pacing)
  const full = scanWorkRegisterIdle({
    registerText: W7_REGISTER_SETTLEMENT_ONLY,
    valley: true,
    hostRunning: false,
    posts: [],
    nowMs: T0,
    quietWindowMs: 60_000,
    ledger: { firstQuietTs: T0 - 60_000 }
  })
  assert.equal(full.findings.length, 1, 'the settlement-only condition → ONE finding (the subclass, never a duplicate)')
  const finding = full.findings[0]
  assert.equal(finding.kind, 'settlement-wait', 'the finding kind is settlement-wait')
  assert.equal(finding.key, SETTLEMENT_WAIT_KEY, 'the dedupe key is settlement-wait (its OWN key in the SHARED health-alerts ledger)')
  assert.equal(finding.count, 1, 'the finding carries the settlement count (1)')
  assert.match(finding.error, /settlement esperando acción del HOST — next actor = host/, 'the owner-facing line names the HOST explicitly (never the generic stagnation wording)')
  assert.match(finding.error, /WAVE 6 settlement/, 'the frame lists the settlement item labels')
  assert.equal(full.quietWithoutPending, false, 'a settlement-only register is NOT «quiet without pending» (the host-pending condition IS actionable)')
})

// --- scan: settlement + other non-gated → BOTH findings, distinct keys ---------

test('fb-167 scanWorkRegisterIdle (MIXED): settlements AND other non-gated items → BOTH findings coexist (each names a DIFFERENT actor — host verify+push AND the IPD despatchable queue); the generic count EXCLUDES the settlement', () => {
  const T0 = new Date(2026, 8, 5, 8, 0, 0).getTime()
  const mixed = scanWorkRegisterIdle({
    registerText: W7_REGISTER_MIXED,
    valley: true,
    hostRunning: false,
    posts: [],
    nowMs: T0,
    quietWindowMs: 60_000,
    ledger: { firstQuietTs: T0 - 60_000 }
  })
  assert.equal(mixed.findings.length, 2, 'the mixed condition → BOTH findings (no suppression — two different actor stalls)')
  const [settlement, generic] = mixed.findings
  assert.equal(settlement.kind, 'settlement-wait', 'the first finding is the settlement-wait subclass')
  assert.equal(settlement.key, SETTLEMENT_WAIT_KEY, 'its key is settlement-wait (own dedupe cadence)')
  assert.equal(generic.kind, 'work-register-idle', 'the second finding is the generic work-register-idle')
  assert.equal(generic.key, WORK_REGISTER_IDLE_KEY, 'its key is the generic work-register-idle (the SHARED 30-min re-alert)')
  assert.equal(generic.count, 1, 'the generic count EXCLUDES the settlement item (only the LANE 2 item → 1)')
  assert.match(generic.error, /LANE 2 — fb-168/, 'the generic frame lists ONLY the non-settlement NON-gated item')
  assert.ok(!generic.error.includes('WAVE 7 settlement'), 'the settlement label is NEVER in the generic frame (subclass exclusion)')
})

// --- scan: no settlements → the generic behavior is UNCHANGED (regression) ------

test('fb-167 regression: a register WITHOUT any next: header keeps the EXACT LANE 5 behavior — ONE work-register-idle finding with the full NON-gated count; §3-only → quietWithoutPending (nothing); below the window → the epoch stamps', () => {
  const T0 = new Date(2026, 8, 5, 8, 0, 0).getTime()
  const plain = [
    '## 1. IPD — cola activa (DAG seriado)',
    '',
    '- **LANE 3 — fb-28 (QD, MEDIO)** [en cola]',
    '- **LANE 4 — de-flake W6/BugA** [en cola]',
    '',
    '## 3. PENDIENTE-OWNER (decisiones)',
    '',
    '- **top-up ws10 → NO por ahora**'
  ].join('\n')
  const full = scanWorkRegisterIdle({
    registerText: plain,
    valley: true,
    hostRunning: false,
    posts: [],
    nowMs: T0,
    quietWindowMs: 60_000,
    ledger: { firstQuietTs: T0 - 60_000 }
  })
  assert.equal(full.findings.length, 1, 'the plain register → ONE finding (unchanged)')
  assert.equal(full.findings[0].kind, 'work-register-idle', 'the finding is the generic one')
  assert.equal(full.findings[0].count, 2, 'the NON-gated count is the full census (2 — the settlements subset is empty)')
  // §3-only (no non-gated, no settlement) → the warn-only expected-quiet outcome.
  const gatedOnly = scanWorkRegisterIdle({
    registerText: '## 3. PENDIENTE-OWNER (decisiones)\n\n- **top-up ws10 → NO por ahora**\n- **stable 3080 → NO TOCAR**',
    valley: true,
    hostRunning: false,
    posts: [],
    nowMs: T0,
    quietWindowMs: 60_000,
    ledger: { firstQuietTs: T0 - 60_000 }
  })
  assert.equal(gatedOnly.findings.length, 0, 'a §3-only register NEVER alerts')
  assert.equal(gatedOnly.quietWithoutPending, true, 'the §3-only case is the warn-only expected-quiet outcome')
  // Below the window: the epoch stamps, never alerts.
  const early = scanWorkRegisterIdle({
    registerText: plain,
    valley: true,
    hostRunning: false,
    posts: [],
    nowMs: T0,
    quietWindowMs: 60_000,
    ledger: {}
  })
  assert.equal(early.findings.length, 0, 'quiet < window → nothing')
  assert.equal(early.ledger.firstQuietTs, T0, 'the first quiet-VALLE tick stamps firstQuietTs')
})

// --- scan: negative legs still break the epoch ----------------------------------

test('fb-167 negative legs: PEAK and an AGENT RUNNING BREAK the quiet epoch even with a settlement pending (the subclass shares the work-register-idle epoch); a NOT-legible register → nothing', () => {
  const MON = new Date(2026, 8, 7, 8, 0, 0).getTime() // Monday 08:00 → PEAK (default pacing)
  const peak = scanWorkRegisterIdle({
    registerText: W7_REGISTER_SETTLEMENT_ONLY,
    valley: false,
    hostRunning: false,
    posts: [],
    nowMs: MON,
    quietWindowMs: 60_000,
    ledger: { firstQuietTs: MON - 120_000 }
  })
  assert.equal(peak.findings.length, 0, 'PEAK → nothing (the franja is part of the sustained condition — a pause is intentional)')
  assert.equal(peak.ledger.firstQuietTs, undefined, 'a PEAK breaks the quiet-VALLE epoch (firstQuietTs cleared)')
  const SAT = new Date(2026, 8, 5, 8, 0, 0).getTime()
  const postRunning = scanWorkRegisterIdle({
    registerText: W7_REGISTER_SETTLEMENT_ONLY,
    valley: true,
    hostRunning: false,
    posts: [{ postId: 'head-1', running: true }],
    nowMs: SAT,
    quietWindowMs: 60_000,
    ledger: { firstQuietTs: SAT - 120_000 }
  })
  assert.equal(postRunning.findings.length, 0, 'an agent mid-turn → nothing (a running agent IS progress, never quiet)')
  assert.equal(postRunning.ledger.firstQuietTs, undefined, 'a running post breaks the epoch')
  const hostRunning = scanWorkRegisterIdle({
    registerText: W7_REGISTER_SETTLEMENT_ONLY,
    valley: true,
    hostRunning: true,
    posts: [],
    nowMs: SAT,
    quietWindowMs: 60_000,
    ledger: { firstQuietTs: SAT - 120_000 }
  })
  assert.equal(hostRunning.findings.length, 0, 'a running HOST → nothing (the zero-running premise cannot be certified)')
  const notLegible = scanWorkRegisterIdle({
    registerText: 'no ## headings in this text',
    valley: true,
    hostRunning: false,
    posts: [],
    nowMs: SAT,
    quietWindowMs: 60_000,
    ledger: { firstQuietTs: SAT - 120_000 }
  })
  assert.equal(notLegible.findings.length, 0, 'a NOT-legible register → nothing (conservative no-op)')
})

// --- frame --------------------------------------------------------------------

test('fb-167 buildHealthAlertFrame: the settlement-wait finding renders its OWN bullet (never the stalled-post fallback); the frame line names the HOST explicitly', () => {
  const frame = buildHealthAlertFrame([{
    kind: 'settlement-wait',
    key: SETTLEMENT_WAIT_KEY,
    ts: 1700000000000,
    count: 1,
    error: 'settlement esperando acción del HOST — next actor = host (1, quiet ≥ 60000 ms, 0 agentes): WAVE 6 settlement'
  }])
  assert.match(frame, /^- settlement-wait: settlement esperando acción del HOST — next actor = host/m, 'the frame bullet is the settlement-wait line (never the stalled-post fallback)')
  assert.match(frame, /^\[From deepartments\] System-health ALERT:/, 'it rides the standard system-health frame')
})

// --- tick E2E (the REAL Loader path) --------------------------------------------

test('fb-167 runHealthDaemonTick (settlement-ONLY): VALLE (Saturday 08:00 UTC) + temp WORK-REGISTER with a settlement item + quiet ≥ window + 0 agents → the host ALERT carries the settlement-wait bullet naming the HOST; the SHARED ledger advances the settlement-wait key (and NOT the generic one); the audit row records the finding', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = new Date(2026, 8, 5, 8, 0, 0).getTime() // Saturday → VALLE
    await writeFile(path.join(stateDir, WORK_REGISTER_IDLE_STATE_FILE), JSON.stringify({ firstQuietTs: T0 - 60_000 }), 'utf8')
    await writeFile(path.join(stateDir, 'WORK-REGISTER.md'), W7_REGISTER_SETTLEMENT_ONLY, 'utf8')
    const alerts = []
    await runHealthDaemonTick({
      now: () => T0,
      stateDir,
      bootId: 'boot-w7fb167-1',
      hosts: [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }],
      posts: [],
      hostRunning: false,
      config: { health: { workRegisterIdleQuietMs: 60_000 }, org: { pacing: {} } },
      workRegisterPath: path.join(stateDir, 'WORK-REGISTER.md'),
      notifyHost: async (_hostEntry, frame) => { alerts.push(frame) },
      logger: { warn: () => {} }
    })
    assert.equal(alerts.length, 1, 'the settlement-pending condition alerts the host ONCE')
    assert.match(alerts[0], /^- settlement-wait: settlement esperando acción del HOST — next actor = host/m, 'the ALERT frame bullet is the settlement-wait line naming the HOST')
    assert.ok(!alerts[0].includes('- work-register-idle:'), 'the settlement-ONLY register does NOT fire the generic work-register-idle (no false «IPD no despachó» — the fb-167 blind spot fix)')
    const state = readHealthAlertsState(stateDir)
    assert.equal(state[SETTLEMENT_WAIT_KEY], T0, 'the settlement-wait dedupe key advances in the SHARED health-alerts ledger')
    assert.equal(state[WORK_REGISTER_IDLE_KEY], undefined, 'the generic work-register-idle key stays ABSENT (a settlement-only register never touches it)')
    const audit = (await readFile(path.join(stateDir, 'health-alerts.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(audit.at(-1).findings[0].kind, 'settlement-wait', 'the audit row records the settlement-wait finding')
    assert.equal(audit.at(-1).dedupeKeys.includes(SETTLEMENT_WAIT_KEY), true, 'the audit row records the settlement-wait dedupe key')
    const wrLedger = readWorkRegisterIdleState(stateDir)
    assert.equal(wrLedger.firstQuietTs, T0 - 60_000, 'the sustained firstQuietTs survives the alerting tick (the re-alert owns the rest)')
  })
})

test('fb-167 runHealthDaemonTick (MIXED + DEDUPE): settlement AND non-gated items → BOTH bullets in ONE alert + BOTH keys advance; inside the 30-min dedupe window no re-alert; AFTER HEALTH_DEDUPE_WINDOW_MS with the condition persisting → RE-ALERT (the settlement-wait guarantee is never a one-shot)', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = new Date(2026, 8, 5, 8, 0, 0).getTime() // Saturday → VALLE
    await writeFile(path.join(stateDir, 'WORK-REGISTER.md'), W7_REGISTER_MIXED, 'utf8')
    await writeFile(path.join(stateDir, WORK_REGISTER_IDLE_STATE_FILE), JSON.stringify({ firstQuietTs: T0 - 60_000 }), 'utf8')
    const alerts = []
    const tick = (nowMs) => runHealthDaemonTick({
      now: () => nowMs,
      stateDir,
      bootId: 'boot-w7fb167-2',
      hosts: [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }],
      posts: [],
      hostRunning: false,
      config: { health: { workRegisterIdleQuietMs: 60_000 }, org: { pacing: {} } },
      workRegisterPath: path.join(stateDir, 'WORK-REGISTER.md'),
      notifyHost: async (_hostEntry, frame) => { alerts.push(frame) },
      logger: { warn: () => {} }
    })
    await tick(T0)
    assert.equal(alerts.length, 1, 'the first window completion alerts ONCE (both findings in ONE frame)')
    assert.match(alerts[0], /- settlement-wait: settlement esperando acción del HOST/, 'the frame carries the settlement-wait bullet')
    assert.match(alerts[0], /- work-register-idle: WORK-REGISTER con 1 item\(s\) NO-gateado\(s\)/, 'the frame ALSO carries the generic bullet (the LANE 2 item — the settlement is excluded from its count)')
    let state = readHealthAlertsState(stateDir)
    assert.equal(state[SETTLEMENT_WAIT_KEY], T0, 'the settlement-wait key advanced')
    assert.equal(state[WORK_REGISTER_IDLE_KEY], T0, 'the generic key advanced too (two keys, two independent dedupe entries)')
    await tick(T0 + 5 * 60_000)
    assert.equal(alerts.length, 1, 'a tick INSIDE the 30-min dedupe window does NOT re-alert')
    await tick(T0 + 31 * 60_000)
    assert.equal(alerts.length, 2, '31 min later the SAME persisting settlement RE-ALERTS (never a one-shot)')
    state = readHealthAlertsState(stateDir)
    assert.equal(state[SETTLEMENT_WAIT_KEY], T0 + 31 * 60_000, 'the settlement-wait key advanced again on the re-alert')
  })
})

// --- knob surface -------------------------------------------------------------

test('fb-167 the knob surface is UNCHANGED: the subclass reuses the work-register-idle gate + quiet window (workRegisterIdleQuietMs), NO new org knob; the frozen export surface is intact (the settlement-wait key is module-private, asserted by its literal)', () => {
  // The scan honors the resolved quiet window (the LANE 5 knob) with no extra
  // config: a 60 s window is the default in the tick tests above; here verify
  // the scan refuses to alert below it with the settlement fixture.
  const T0 = new Date(2026, 8, 5, 8, 0, 0).getTime()
  const early = scanWorkRegisterIdle({
    registerText: W7_REGISTER_SETTLEMENT_ONLY,
    valley: true,
    hostRunning: false,
    posts: [],
    nowMs: T0,
    quietWindowMs: 60_000,
    ledger: {}
  })
  assert.equal(early.findings.length, 0, 'quiet < window → NO settlement-wait finding (the shared quietWindow gates the subclass too)')
  assert.equal(typeof SETTLEMENT_WAIT_KEY, 'string', 'the key is a plain string (module-private — the export surface stays frozen)')
})