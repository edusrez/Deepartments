// dsh-deepartments — LANE WFD (m-1416/QH — org.pacing franja) test: the
// franja-aware watchdog/nudge.
//
// FAMILY (QH m-1416 + WORK-REGISTER §5 + feedback.jsonl):
//   (a) MISSION-STALLED NO-WAKE EXCLUSION — the 10-min mission-stalled
//       watchdog fires a FALSE POSITIVE over deliveries that are NO-WAKE-
//       GATED BY DESIGN (the m-410/fb-89 class: a low-severity QH feedback
//       send persists the record but never wakes the recipient — it drains at
//       the next REAL wake; minutes of quiet are the CONTRACT, never a stall).
//       The exclusion signal is the explicit m-707 `noWake` flag on the
//       delivery row (DeliveryRow.noWake — the source of truth the transport
//       writes for the WIRED no-wake-until-wake branch):
//         (i)   the PURE scan: a no-wake row 12 min quiet → NO finding; the
//               always-wake CONTROL with the same quiet → the finding;
//         (ii)  the REAL daemon tick (runHealthDaemonTick): same exclusion
//               through the tick, the no-wake key never enters the ledger;
//         (iii) the bundle's buildMissionActivity carries the flag off the
//               LATEST host→head delivery row (max ts wins — the no-wake
//               flag is NOT sticky: a later always-wake delivery re-arms).
//   (b) NUDGE FRANJA GATE — the feedback-nudge post-execute listener
//       (packages/dshd-orchestration/src/tools.ts, LANE FEEDBACK-NUDGE) is a
//       NEW-dispatch EMITTER and therefore NEVER launches inside PEAK: the
//       org.pacing.* knobs (enabled / peakWindows / peakBufferMs) drive the
//       SAME dshd-core pacing computation as the wake-pack franja + the health
//       daemon (ONE source of truth, zero drift):
//         (i)   PURE decision (`nudgeFranjaDeferred`): PEAK (Mon-Fri, hours
//               {1,2,3,6,7,8,9} UTC) → deferred; VALLE → dispatch;
//         (ii)  the peakBufferMs EDGE (30 min de borde, [start, end)):
//               07:29/09:30 boundaries around a 08:00-09:00 window;
//         (iii) the knob DISARM (org.pacing.enabled:false) + an ABSENT
//               org.pacing → the pre-pacing legacy: the nudge ALWAYS
//               dispatches;
//         (iv)  the REAL composed-bundle waterfall (the tools-factory
//               smokeBoot pattern): PEAK-forced (a window covering the real
//               current UTC hour — the policy-substitution determinism trick)
//               → ZERO nudge contexts; VALLE-forced → ONE; the DISARM at a
//               PEAK hour → ONE.
// Hermetic: temp stateDirs; the real waterfall boots the REAL Loader subset
// (dshd-core + the P1 packages + dshd-orchestration + the bundle — dev order).
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scanMissionStalled, MISSION_STALL_DEFAULT_MS, missionStallKey, runHealthDaemonTick, readHealthAlertsState } from 'dshd-health'
import { nudgeFranjaDeferred } from '../packages/dshd-orchestration/lib/tools.js'
import { buildMissionActivity } from '../lib/invoke.js'

/** Temp stateDir harness (the withTempStateDir pattern of invoke.test.js). */
async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-wfd-'))
  try {
    await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

// Fixed UTC anchors (the pacing.test.js convention): 2026-08-24 is a MONDAY,
// 2026-08-29 a SATURDAY — the default franja is Mon-Fri hours {1,2,3,6,7,8,9}.
const MONDAY = Date.UTC(2026, 7, 24)
const SATURDAY = Date.UTC(2026, 7, 29)

// ---------------------------------------------------------------------------
// (a) MISSION-STALLED — the no-wake exclusion
// ---------------------------------------------------------------------------

test('WFD (a) mission-stalled no-wake exclusion (PURE): a NO-WAKE-GATED row (DeliveryRow.noWake — the m-707 explicit flag, the m-410/fb-89 class) 12 min quiet → NO finding even though it never processed; the always-wake CONTROL with the SAME quiet → the mission-stalled finding; a no-wake row PROCESSED after delivery → nothing', () => {
  const T0 = new Date(2026, 7, 31, 9, 0, 0).getTime()
  const findings = scanMissionStalled({
    rows: [
      // The m-410/fb-89 class: a no-wake-gated delivery 12 min quiet, NEVER
      // processed (lastActivityTs absent) — BY DESIGN it drains at the next
      // real wake → must NOT alarm.
      { postId: 'quality-head', mission: { messageId: 'm-nw-1', ts: T0 - 12 * 60_000 }, noWake: true },
      // A no-wake row that ALSO got processed after delivery → nothing.
      { postId: 'quality-head', mission: { messageId: 'm-nw-2', ts: T0 - 12 * 60_000 }, noWake: true, lastActivityTs: T0 - 6 * 60_000 },
      // CONTROL: the always-wake row, same 12-min quiet, never processed →
      // the ONLY stall.
      { postId: 'research-head', mission: { messageId: 'm-aw-1', ts: T0 - 12 * 60_000 } },
      // An always-wake row inside the 10-min window → nothing (the existing rule).
      { postId: 'research-head', mission: { messageId: 'm-aw-2', ts: T0 - 5 * 60_000 } }
    ],
    stallMs: MISSION_STALL_DEFAULT_MS,
    nowMs: T0
  })
  assert.equal(findings.length, 1, 'EXACTLY the always-wake stuck row alarms (the no-wake-gated rows are BY DESIGN quiet)')
  const stalled = findings[0]
  assert.equal(stalled.postId, 'research-head', 'the stalled row is the CONTROL')
  assert.equal(stalled.messageId, 'm-aw-1')
  assert.equal(stalled.key, missionStallKey('research-head', 'm-aw-1'), 'the per-mission dedupe key')
  assert.match(stalled.error, /^misión m-aw-1 entregada a research-head hace 12 min sin inicio — posible cola stale$/, 'the owner-facing line: misión <id> entregada a <head> hace N min sin inicio — posible cola stale')
})

test('WFD (a) mission-stalled no-wake exclusion (real daemon tick): runHealthDaemonTick with a no-wake-gated stuck row + an always-wake stuck CONTROL → ONE alert (the CONTROL); the no-wake dedupe key NEVER enters the shared ledger; a young no-wake row stays silent', async () => {
  await withTempStateDir(async (stateDir) => {
    const T0 = new Date(2026, 7, 31, 9, 30, 0).getTime()
    const alerts = []
    await runHealthDaemonTick({
      now: () => T0,
      stateDir,
      bootId: 'boot-wfd-a1',
      hosts: [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }],
      missionActivity: [
        // The m-410/fb-89 class — 12 min quiet, deliberately never processed.
        { postId: 'quality-head', mission: { messageId: 'm-601', ts: T0 - 12 * 60_000 }, noWake: true },
        // CONTROL — the always-wake row, 12 min quiet, never processed.
        { postId: 'research-head', mission: { messageId: 'm-602', ts: T0 - 12 * 60_000 } },
        // A young no-wake row — inside the window → nothing either way.
        { postId: 'quality-head', mission: { messageId: 'm-603', ts: T0 - 3 * 60_000 }, noWake: true }
      ],
      config: { health: {} },
      notifyHost: async (hostEntry, frame) => { alerts.push({ hostEntry, frame }) },
      logger: { warn: () => {} }
    })
    assert.equal(alerts.length, 1, 'exactly the always-wake CONTROL alerts (the no-wake rows never alarm)')
    assert.match(alerts[0].frame, /^\[From deepartments\] System-health ALERT:/, 'the alert frame is the system-health frame')
    assert.match(alerts[0].frame, /- mission-stalled: misión m-602 entregada a research-head hace 12 min sin inicio — posible cola stale/, 'the FRAME bullet is the CONTROL (the no-wake rows are excluded)')
    const ledger = readHealthAlertsState(stateDir)
    assert.equal(ledger[missionStallKey('quality-head', 'm-601')], undefined, 'the no-wake key NEVER enters the shared ledger')
    assert.equal(ledger[missionStallKey('quality-head', 'm-603')], undefined, 'the young no-wake row never alarms / no key')
    assert.equal(ledger[missionStallKey('research-head', 'm-602')], T0, 'the CONTROL dedupe key advances')
  })
})

test('WFD (a) buildMissionActivity carries the DeliveryRow.noWake flag (the LATEST host→head row wins — the flag is NOT sticky): a no-wake-gated latest delivery → the activity row has noWake:true → the scan over the BUILT rows stays silent; a LATER always-wake delivery to the same post RE-ARMS the alarm', async () => {
  await withTempStateDir(async (stateDir) => {
    const T = new Date(2026, 7, 31, 9, 0, 0).getTime()
    // messages.jsonl — the `from` attribution (the mission SENDER = the live host).
    await writeFile(path.join(stateDir, 'messages.jsonl'), [
      JSON.stringify({ id: 'm-700', seq: 1, ts: T - 12 * 60_000, from: 'host-asst', to: ['quality-head'], text: 'low-severity QH feedback (no-wake by design)', kind: 'agent' }),
      JSON.stringify({ id: 'm-701', seq: 2, ts: T - 11 * 60_000, from: 'host-asst', to: ['research-head'], text: 'a real mission', kind: 'agent' })
    ].join('\n') + '\n', 'utf8')
    // deliveries.jsonl — the sidecar rows (the m-707 noWake flag rides the
    // row the transport wrote for the WIRED no-wake branch; the LATEST
    // consummated row per (postId, messageId) pair decides).
    await writeFile(path.join(stateDir, 'deliveries.jsonl'), [
      JSON.stringify({ messageId: 'm-700', recipientId: 'quality-head', status: 'delivered', ts: T - 12 * 60_000, noWake: true }),
      JSON.stringify({ messageId: 'm-701', recipientId: 'research-head', status: 'delivered', ts: T - 11 * 60_000 })
    ].join('\n') + '\n', 'utf8')
    const byPost = new Map([
      ['quality-head', { postId: 'quality-head', provider: 'deepseek-official', sessionId: 's-qh' }],
      ['research-head', { postId: 'research-head', provider: 'deepseek-official', sessionId: 's-rh' }]
    ])
    const rows = buildMissionActivity({ stateDir, byPost, hosts: [{ hostId: 'host-asst', sessionId: 's-host', roomId: 'board' }], agents: undefined })
    assert.ok(rows !== undefined, 'the mission-sender seam resolves (a live host exists)')
    const qh = rows.find((r) => r.postId === 'quality-head')
    const rh = rows.find((r) => r.postId === 'research-head')
    assert.ok(qh !== undefined && rh !== undefined, 'both head rows materialized')
    assert.equal(qh.noWake, true, 'the no-wake-gated delivery carries noWake:true into the activity row')
    assert.equal(rh.noWake, undefined, 'the always-wake control row carries NO noWake flag')
    // The scan over the BUILT rows: exactly the always-wake control alarms.
    const findings = scanMissionStalled({ rows, stallMs: MISSION_STALL_DEFAULT_MS, nowMs: T })
    assert.equal(findings.length, 1, 'the built rows: one stall (the always-wake control)')
    assert.equal(findings[0].messageId, 'm-701', 'the no-wake-gated m-700 never alarms')
    // RE-ARM: a LATER always-wake host→head delivery to quality-head (the
    // max-ts row wins) → the no-wake flag is NOT sticky → the row alarms.
    await writeFile(path.join(stateDir, 'messages.jsonl'), [
      JSON.stringify({ id: 'm-700', seq: 1, ts: T - 12 * 60_000, from: 'host-asst', to: ['quality-head'], text: 'low-severity QH feedback (no-wake by design)', kind: 'agent' }),
      JSON.stringify({ id: 'm-702', seq: 3, ts: T - 10 * 60_000, from: 'host-asst', to: ['quality-head'], text: 'a real always-wake mission', kind: 'agent' }),
      JSON.stringify({ id: 'm-701', seq: 2, ts: T - 11 * 60_000, from: 'host-asst', to: ['research-head'], text: 'a real mission', kind: 'agent' })
    ].join('\n') + '\n', 'utf8')
    await writeFile(path.join(stateDir, 'deliveries.jsonl'), [
      JSON.stringify({ messageId: 'm-700', recipientId: 'quality-head', status: 'delivered', ts: T - 12 * 60_000, noWake: true }),
      JSON.stringify({ messageId: 'm-702', recipientId: 'quality-head', status: 'delivered', ts: T - 10 * 60_000 }),
      JSON.stringify({ messageId: 'm-701', recipientId: 'research-head', status: 'delivered', ts: T - 11 * 60_000 })
    ].join('\n') + '\n', 'utf8')
    const rows2 = buildMissionActivity({ stateDir, byPost, hosts: [{ hostId: 'host-asst', sessionId: 's-host', roomId: 'board' }], agents: undefined })
    const qh2 = rows2.find((r) => r.postId === 'quality-head')
    assert.equal(qh2.noWake, undefined, 'the LATEST always-wake row wins — noWake is not sticky')
    const findings2 = scanMissionStalled({ rows: rows2, stallMs: MISSION_STALL_DEFAULT_MS, nowMs: T })
    assert.equal(findings2.length, 2, 'both heads now alarm (quality-head re-armed by its later always-wake delivery)')
    assert.ok(findings2.some((f) => f.postId === 'quality-head' && f.messageId === 'm-702'), 'the re-armed quality-head row alarms with the always-wake mission')
  })
})

// ---------------------------------------------------------------------------
// (b) NUDGE — the franja gate
// ---------------------------------------------------------------------------

test('WFD (b) nudge franja gate (PURE): PEAK (Mon-Fri, horas {1,2,3,6,7,8,9} UTC) → DEFERRED; VALLE (weekend / non-peak hour) → dispatch; org.pacing ABSENT → the pre-pacing legacy (always dispatch); org.pacing.enabled:false → the knob DISARM (always dispatch even at a PEAK hour); an org whose OWN window says the instant is PEAK → deferred (the knobs win over the defaults)', () => {
  const defaults = { enabled: true } // the code defaults: Mon-Fri, {1,2,3,6,7,8,9}, ±30 min
  assert.equal(nudgeFranjaDeferred(defaults, MONDAY + 8 * 3_600_000), true, 'Monday 08:00 UTC → PEAK → deferred')
  assert.equal(nudgeFranjaDeferred(defaults, SATURDAY + 8 * 3_600_000), false, 'Saturday 08:00 UTC → VALLE (weekend) → dispatch')
  assert.equal(nudgeFranjaDeferred(defaults, MONDAY + 11 * 3_600_000), false, 'Monday 11:00 UTC → VALLE (after the last peak hour + its 30-min end-buffer → 10:30) → dispatch')
  assert.equal(nudgeFranjaDeferred(undefined, MONDAY + 8 * 3_600_000), false, 'org.pacing ABSENT → the pre-pacing legacy (always dispatch — an undeclared franja cannot defer)')
  assert.equal(nudgeFranjaDeferred({ enabled: false, peakWindows: { weekday: [1, 2, 3, 4, 5], hours: [1, 2, 3, 6, 7, 8, 9] } }, MONDAY + 8 * 3_600_000), false, 'enabled:false → the knob DISARM restores the legacy (always dispatch at a PEAK hour)')
  assert.equal(nudgeFranjaDeferred({ peakWindows: { weekday: [6], hours: [8] } }, SATURDAY + 8 * 3_600_000), true, 'an org whose window says Saturday 08:00 is PEAK follows ITS knobs (the knobs win over the defaults)')
})

test('WFD (b) the peakBufferMs EDGE (30 min de borde) is respected: the covered interval is [h:00 − buffer, (h+1):00 + buffer) — start INCLUSIVE, end EXCLUSIVE — and the buffer NEVER crosses the weekday filter (a Friday window does not creep into Saturday)', () => {
  const pacing = { enabled: true, peakWindows: { weekday: [1, 2, 3, 4, 5], hours: [8] }, peakBufferMs: 1_800_000 }
  const mon = (h, min) => MONDAY + (h * 60 + min) * 60_000
  assert.equal(nudgeFranjaDeferred(pacing, mon(7, 29)), false, 'Monday 07:29 → VALLE (1 min before the buffer start edge 07:30)')
  assert.equal(nudgeFranjaDeferred(pacing, mon(7, 30)), true, 'Monday 07:30 → PEAK (the buffer start edge is INCLUSIVE — [start, end))')
  assert.equal(nudgeFranjaDeferred(pacing, mon(9, 29)), true, 'Monday 09:29 → PEAK (inside the buffer end edge 09:30)')
  assert.equal(nudgeFranjaDeferred(pacing, mon(9, 30)), false, 'Monday 09:30 → VALLE (the buffer end edge is EXCLUSIVE)')
  assert.equal(nudgeFranjaDeferred(pacing, SATURDAY + 7 * 3_600_000 + 30 * 60_000), false, 'Saturday 07:30 (the instant a Friday window with the buffer would cover) → VALLE (the weekday filter applies BEFORE the buffer — never creeps into the weekend)')
})

test('WFD (b) nudge franja gate (REAL waterfall — composed bundle): a NEW nudge NEVER dispatches in PEAK (zero nudge contexts), dispatches in VALLE, the enabled:false DISARM restores the legacy always-nudge at a PEAK hour, and an ABSENT org.pacing keeps the pre-pacing always-nudge', async () => {
  // (1) PEAK-forced (a window covering the REAL current UTC hour) → no nudge.
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, dispose } = await smokeBoot(stateDir, { org: peakForcedOrg() })
    try {
      const decision = await pluginCtx().waterfall('tools/post-execute', nudgeExec(), nudgeErrorResult('wfd peak boom'), accept)
      assert.equal(decision.kind, 'accept', 'the downstream accept is preserved on a deferred nudge')
      assert.equal(nudgeContexts(decision.additionalContexts).length, 0, 'PEAK → the nudge is DEFERRED (no nudge context — a new dispatch never launches in PEAK)')
    } finally {
      dispose()
    }
  })
  // (2) VALLE-forced (a window on a weekday that is NEVER the current one) →
  // the nudge dispatches as today.
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, dispose } = await smokeBoot(stateDir, { org: valleForcedOrg() })
    try {
      const decision = await pluginCtx().waterfall('tools/post-execute', nudgeExec(), nudgeErrorResult('wfd valley boom'), accept)
      assert.equal(decision.kind, 'accept', 'the downstream accept is preserved on a dispatched nudge')
      assert.equal(nudgeContexts(decision.additionalContexts).length, 1, 'VALLE → the nudge dispatches (exactly one nudge context)')
    } finally {
      dispose()
    }
  })
  // (3) DISARM (enabled:false at a REAL PEAK hour) → the legacy always-nudge.
  await withTempStateDir(async (stateDir) => {
    const now = new Date()
    const curDow = now.getUTCDay() === 0 ? 7 : now.getUTCDay()
    const { pluginCtx, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT], pacing: { enabled: false, peakWindows: { weekday: [curDow], hours: [now.getUTCHours()] }, peakBufferMs: 0 } } })
    try {
      const decision = await pluginCtx().waterfall('tools/post-execute', nudgeExec(), nudgeErrorResult('wfd disarm boom'), accept)
      assert.equal(nudgeContexts(decision.additionalContexts).length, 1, 'enabled:false → the knob DISARM restores the legacy always-nudge (even at a REAL PEAK hour)')
    } finally {
      dispose()
    }
  })
  // (4) ABSENT org.pacing → the pre-pacing legacy (always nudge).
  await withTempStateDir(async (stateDir) => {
    const { pluginCtx, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] } })
    try {
      const decision = await pluginCtx().waterfall('tools/post-execute', nudgeExec(), nudgeErrorResult('wfd absent boom'), accept)
      assert.equal(nudgeContexts(decision.additionalContexts).length, 1, 'org.pacing ABSENT → the pre-pacing legacy (always dispatch)')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// the real composed-bundle boot (the tools-factory smokeBoot pattern)
// ---------------------------------------------------------------------------

/** Stub webServer/webRuntime/connection so the bundle RPC mount effect runs. */
class StubWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = []
  }
  register(route) { this.routes.push(route); return () => {} }
}
class StubWebRuntime extends Service {
  constructor(ctx) { super(ctx, 'webRuntime'); this.trustedHosts = [] }
}
class StubConnection extends Service {
  constructor(ctx) { super(ctx, 'connection'); this.trustedHosts = [] }
}

/** The REAL Loader composition of the dev-profile subset (dshd-core + the P1
 * packages + dshd-orchestration + the bundle, in order). */
async function smokeBoot(stateDir, { org = { departments: [] } } = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  new StubWebServer(root)
  new StubWebRuntime(root)
  new StubConnection(root)
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return { pluginCtx, dispose: () => loaderFiber.dispose() }
}

/** The department the composed bundle drives (the tools-factory shape). */
const DEPARTMENT = {
  id: 'internal-programming',
  name: 'Internal Programming',
  roomId: 'room-ipd',
  coordinator: { postId: 'internal-programming-head' }
}

/** The exact nudge line (byte-identical to FEEDBACK_NUDGE_LINE in
 * packages/dshd-orchestration/src/tools.ts). */
const FEEDBACK_NUDGE_LINE = '¿Error de tool o propuesta de mejora? Repórtala con dept_feedback al QD'

/** A minimal ToolExecution the real `tools/post-execute` waterfall accepts. */
function nudgeExec(name = 'probe_tool', agent = { id: 'probe-agent' }) {
  return { name, arguments: {}, agent }
}

/** An errored ToolExecutionResult (the shape a thrown/denied tool yields). */
function nudgeErrorResult(message = 'boom') {
  return { isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] }
}

/** The nudge additionalContexts among a decision's contexts. */
function nudgeContexts(contexts) {
  return (contexts ?? []).filter((c) => {
    const text = Array.isArray(c?.content) ? c.content.map((b) => b?.text ?? '').join('') : ''
    return c?.source?.kind === 'plugin' && text.includes(FEEDBACK_NUDGE_LINE)
  })
}

const accept = () => Promise.resolve({ kind: 'accept' })

/** The org.pacing window that GUARANTEES PEAK at the REAL current UTC instant
 * (the policy-substitution determinism trick: the window covers the current
 * weekday + hour, buffer 0). */
function peakForcedOrg() {
  const now = new Date()
  const curDow = now.getUTCDay() === 0 ? 7 : now.getUTCDay()
  return { departments: [DEPARTMENT], pacing: { enabled: true, peakWindows: { weekday: [curDow], hours: [now.getUTCHours()] }, peakBufferMs: 0 } }
}

/** GUARANTEED VALLE: a window on a weekday that is NEVER the current one. */
function valleForcedOrg() {
  const now = new Date()
  const curDow = now.getUTCDay() === 0 ? 7 : now.getUTCDay()
  const altDow = curDow === 7 ? 1 : curDow + 1
  return { departments: [DEPARTMENT], pacing: { enabled: true, peakWindows: { weekday: [altDow], hours: [1] }, peakBufferMs: 0 } }
}