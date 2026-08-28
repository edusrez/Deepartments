// dsh-deepartments — PACING (peak/valley franja) tests (owner m-PACING,
// 2026-08-28, pacing/coste MEDIUM). Covers:
//   (1) the pure UTC pacing module (isPeakAt boundaries, buffer edges,
//       weekday filter, custom windows, the «hasta HH:MM UTC» state);
//   (2) the WORK-REGISTER pending-count heuristic (the VALLE notice's N);
//   (3) the wake-pack seam (the ONE `## Pacing (franja)` section in the pure
//       builder + the assembly with a FIXED clock — DEEPARTMENTS_TEST_NOW);
//   (4) the daemon transitions (PEAK notice ×1 / VALLE notice ×1 with N when
//       legible; first-boot baseline; no-duplicate; the shared-ledger dedupe;
//       no live host → retry; knob off → legacy behavior);
//   (5) the org.ts schema (`org.pacing.*`, M4 style).
// Style: M1/M4 — fixed clocks (literal UTC Dates / deps.now()), fixtures, a
// recording notifyHost stub. Pure-function tests + the daemon tick run against
// the COMPILED lib (pnpm build first — AGENTS.md rule 5: the real Loader
// surface through lib/invoke.js).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  isPeakAt,
  pacingStateAt,
  nextTransitionAt,
  formatFranjaLine,
  pacingSpan,
  hhMmUtc,
  pacingWindowFromConfig,
  resolvePacingWindow,
  countPendingWorkRegister,
  PACING_DEFAULT_WEEKDAY,
  PACING_DEFAULT_HOURS,
  PACING_DEFAULT_BUFFER_MS,
  buildWakePack,
  createWakePackService
} from 'dshd-core'
import { runHealthDaemonTick, PACING_TRANSITION_KEY, PACING_STATE_FILE, readPacingState, buildPacingTransitionFrame } from '../lib/invoke.js'
import { Config as configSchema } from '../lib/org.js'

// ---------------------------------------------------------------------------
// FIXTURES — fixed UTC instants: 2026-08-24 is a MONDAY; 2026-08-29 SATURDAY;
// 2026-08-30 SUNDAY. All times UTC (the formula is UTC-only, no tz lib).
// ---------------------------------------------------------------------------
const MON = new Date(Date.UTC(2026, 7, 24))
const at = (hh, mm = 0, ss = 0, ms = 0) => new Date(Date.UTC(2026, 7, 24, hh, mm, ss, ms))

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-pacing-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** The recording notifyHost stub (M1/M4 style). */
function stubNotify(log) {
  const calls = []
  return {
    calls,
    async notifyHost(hostEntry, frame) {
      calls.push({ hostEntry, frame })
      log?.push(frame)
    }
  }
}

const HOSTS = [{ hostId: 'host-asst', sessionId: 's-live', roomId: 'board' }]
const LOGGER = { warn() {}, info() {} }

/** The daemon tick helper: fixed clock, hermetic stateDir, config + recording
 * notifyHost. `config.org.pacing` defaults to a SHARP window (weekday [1],
 * hours [8], buffer 0 → Mon PEAK [08:00,09:00) UTC — minutes-sharp so the
 * test clock needs no 30-min alignment). */
function makeTick(stateDir, opts = {}) {
  const { notifyHost, calls } = stubNotify(opts.onNotify)
  let nowMs = opts.nowMs
  const tick = async (atMs, overrides = {}) => {
    nowMs = atMs
    await runHealthDaemonTick({
      now: () => nowMs,
      stateDir,
      bootId: overrides.bootId ?? 'boot-pacing',
      config: overrides.config ?? opts.config ?? {
        org: { pacing: { enabled: true, peakWindows: { weekday: [1], hours: [8] }, peakBufferMs: 0 } },
        health: {}
      },
      hosts: overrides.hosts ?? opts.hosts ?? HOSTS,
      posts: [],
      workRegisterPath: overrides.workRegisterPath ?? opts.workRegisterPath,
      notifyHost,
      logger: LOGGER
    })
  }
  return { tick, calls, notifyHost }
}

// ---------------------------------------------------------------------------
// (1) PURE pacing unit — formula, UTC boundaries, buffer, days/hours.
// ---------------------------------------------------------------------------

test('PACING pure: isPeakAt defaults — Mon-Fri UTC hours {1,2,3,6,7,8,9} with a 30-min edge buffer on BOTH boundaries (the dsh-key-pooler mirror)', () => {
  assert.deepEqual([...PACING_DEFAULT_WEEKDAY], [1, 2, 3, 4, 5], 'default weekdays Mon-Fri')
  assert.deepEqual([...PACING_DEFAULT_HOURS], [1, 2, 3, 6, 7, 8, 9], 'default hours {1,2,3,6,7,8,9} UTC')
  assert.equal(PACING_DEFAULT_BUFFER_MS, 1_800_000, 'default buffer 30 min')
  // Leading edge of the first window: 01:00 − 30 min = 00:30 (inclusive).
  assert.equal(isPeakAt(at(0, 29, 59, 999)), false, '00:29:59.999 UTC is VALLE (before the buffer edge)')
  assert.equal(isPeakAt(at(0, 30, 0)), true, '00:30:00 UTC is PEAK (the buffer-expanded window opens)')
  // Inside the first sub-window 01:00-04:00 (buffer-expanded [00:30,04:30)).
  assert.equal(isPeakAt(at(1, 0)), true, '01:00 UTC is PEAK')
  assert.equal(isPeakAt(at(3, 59, 59, 999)), true, '03:59:59.999 UTC is PEAK')
  assert.equal(isPeakAt(at(4, 29, 59, 999)), true, '04:29:59.999 UTC is PEAK (inside the end buffer)')
  assert.equal(isPeakAt(at(4, 30, 0)), false, '04:30:00 UTC is VALLE (end-exclusive, buffer expired)')
  // The valley between the two sub-windows.
  assert.equal(isPeakAt(at(5, 0)), false, '05:00 UTC is VALLE (between windows)')
  assert.equal(isPeakAt(at(5, 29, 59, 999)), false, '05:29:59.999 UTC is VALLE (before the next buffer edge)')
  assert.equal(isPeakAt(at(5, 30, 0)), true, '05:30:00 UTC is PEAK (second window opens with its buffer)')
  // Second sub-window 06:00-10:00 (buffer-expanded [05:30,10:30)).
  assert.equal(isPeakAt(at(6, 0)), true, '06:00 UTC is PEAK')
  assert.equal(isPeakAt(at(8, 0)), true, '08:00 UTC is PEAK')
  assert.equal(isPeakAt(at(10, 29, 59, 999)), true, '10:29:59.999 UTC is PEAK')
  assert.equal(isPeakAt(at(10, 30, 0)), false, '10:30:00 UTC is VALLE (last window ends)')
  assert.equal(isPeakAt(at(23, 0)), false, '23:00 UTC is VALLE')
})

test('PACING pure: isPeakAt weekday filter — the weekday is evaluated in UTC BEFORE the buffer (a Friday window never creeps into Saturday)', () => {
  // 2026-08-24 Mon … 2026-08-28 Fri are peak days; Sat 2026-08-29 / Sun 2026-08-30 are not.
  assert.equal(isPeakAt(new Date(Date.UTC(2026, 7, 24, 8, 0))), true, 'Monday 08:00 UTC is PEAK')
  assert.equal(isPeakAt(new Date(Date.UTC(2026, 7, 25, 8, 0))), true, 'Tuesday 08:00 UTC is PEAK')
  assert.equal(isPeakAt(new Date(Date.UTC(2026, 7, 28, 8, 0))), true, 'Friday 08:00 UTC is PEAK')
  assert.equal(isPeakAt(new Date(Date.UTC(2026, 7, 29, 8, 0))), false, 'Saturday 08:00 UTC is VALLE (weekday filter)')
  assert.equal(isPeakAt(new Date(Date.UTC(2026, 7, 30, 8, 0))), false, 'Sunday 08:00 UTC is VALLE (weekday filter)')
  // The Sunday→Monday edge: the Monday 01:00 window's buffer (00:30 Mon) never
  // reaches into Sunday.
  assert.equal(isPeakAt(new Date(Date.UTC(2026, 7, 30, 23, 59, 59, 999))), false, 'Sunday 23:59:59.999 UTC is VALLE')
  assert.equal(isPeakAt(new Date(Date.UTC(2026, 7, 31, 0, 30, 0))), true, 'Monday 00:30 UTC is PEAK (window opens)')
})

test('PACING pure: custom windows — weekday/hours/bufferMs are honored (Sat-only window, zero buffer)', () => {
  const opts = { weekday: [6], hours: [8], bufferMs: 0 }
  assert.equal(isPeakAt(new Date(Date.UTC(2026, 7, 29, 8, 30)), opts), true, 'Saturday 08:30 UTC is PEAK with a Sat-only window')
  assert.equal(isPeakAt(new Date(Date.UTC(2026, 7, 29, 9, 0)), opts), false, 'Saturday 09:00 UTC is VALLE (end-exclusive, no buffer)')
  assert.equal(isPeakAt(new Date(Date.UTC(2026, 7, 29, 7, 59, 59, 999)), opts), false, 'Saturday 07:59:59.999 UTC is VALLE (no leading buffer)')
  assert.equal(isPeakAt(new Date(Date.UTC(2026, 7, 24, 8, 0)), opts), false, 'Monday 08:00 UTC is VALLE (weekday not in the window)')
})

test('PACING pure: resolvePacingWindow falls back to the defaults on invalid/empty entries (never throws)', () => {
  const d = resolvePacingWindow()
  assert.deepEqual([...d.weekday], [1, 2, 3, 4, 5])
  assert.deepEqual([...d.hours], [1, 2, 3, 6, 7, 8, 9])
  assert.equal(d.bufferMs, 1_800_000)
  // An out-of-range hour is filtered; an ALL-invalid array falls back whole.
  assert.deepEqual([...resolvePacingWindow({ hours: [8, 24, -1] }).hours], [8], 'in-range hours survive, out-of-range are filtered')
  assert.deepEqual([...resolvePacingWindow({ hours: [24] }).hours], [1, 2, 3, 6, 7, 8, 9], 'an all-invalid hours array falls back to the default')
  assert.deepEqual([...resolvePacingWindow({ weekday: [9] }).weekday], [1, 2, 3, 4, 5], 'an all-invalid weekday falls back')
  assert.equal(resolvePacingWindow({ bufferMs: -5 }).bufferMs, 1_800_000, 'a negative buffer falls back')
  assert.equal(resolvePacingWindow({ bufferMs: 0 }).bufferMs, 0, 'a ZERO buffer is valid')
})

test('PACING pure: pacingStateAt — «hasta HH:MM UTC» is the end of the CURRENT franja (the next transition)', () => {
  // In PEAK: until = the buffer-expanded end of the current window.
  const p = pacingStateAt(at(8, 0))
  assert.equal(p.peak, true, 'Monday 08:00 UTC is peak')
  assert.equal(p.span, '01:00-10:00', 'merged peak span: min hour 01:00 → max hour end 10:00')
  assert.equal(p.untilHhMm, '10:30', 'in-peak «hasta» = 10:30 UTC (10:00 + the 30-min end buffer)')
  assert.equal(p.untilMs, Date.UTC(2026, 7, 24, 10, 30), 'untilMs is the exact next-transition epoch')
  // In VALLE between the two windows: until = the next (buffer-expanded) window start.
  const v1 = pacingStateAt(at(4, 40))
  assert.equal(v1.peak, false, '04:40 UTC is valley')
  assert.equal(v1.untilHhMm, '05:30', 'in-valley «hasta» = 05:30 UTC (06:00 − the 30-min leading buffer)')
  // In VALLE after the last window: until = the NEXT weekday's first window.
  const v2 = pacingStateAt(at(10, 45))
  assert.equal(v2.peak, false, '10:45 UTC Monday is valley')
  assert.equal(v2.untilHhMm, '00:30', 'after the last window «hasta» = the next day 00:30 UTC')
  // Weekend valley: until = Monday 00:30 UTC.
  const sun = pacingStateAt(new Date(Date.UTC(2026, 7, 30, 23, 59)))
  assert.equal(sun.peak, false, 'Sunday 23:59 UTC is valley')
  assert.equal(sun.untilHhMm, '00:30', 'the weekend valley ends at Monday 00:30 UTC')
  assert.equal(sun.untilMs, Date.UTC(2026, 7, 31, 0, 30), 'the weekend→Monday transition instant')
})

test('PACING pure: nextTransitionAt is exactly consistent with isPeakAt (the franja flips AT the reported instant)', () => {
  for (const hh of [0, 1, 2, 4, 5, 9, 10, 12, 23]) {
    const t = at(hh, 0)
    const until = nextTransitionAt(t)
    assert.equal(isPeakAt(new Date(until - 1)), !isPeakAt(new Date(until + 1)), `flip at the transition instant (probe ${hh}:00)`)
    assert.equal(isPeakAt(new Date(t)), isPeakAt(t), 'the state is stable before/after the reported transition')
  }
  // hhMmUtc renders UTC zero-padded.
  assert.equal(hhMmUtc(Date.UTC(2026, 7, 24, 0, 30)), '00:30')
  assert.equal(hhMmUtc(Date.UTC(2026, 7, 24, 23, 59)), '23:59')
})

test('PACING pure: formatFranjaLine renders the ONE stable line for PEAK and VALLE (the wake-pack line)', () => {
  assert.equal(
    formatFranjaLine(pacingStateAt(at(8, 0))),
    'Franja: PEAK [01:00-10:00] UTC — hasta 10:30 UTC',
    'the stable PEAK line'
  )
  assert.equal(
    formatFranjaLine(pacingStateAt(at(4, 40))),
    'Franja: VALLE [01:00-10:00] UTC — hasta 05:30 UTC',
    'the stable VALLE line'
  )
  assert.equal(pacingSpan({ hours: [1] }), '01:00-02:00', 'a single hour spans its own range')
})

test('PACING pure: pacingWindowFromConfig maps the org.pacing.* shape (peakWindows + sibling peakBufferMs)', () => {
  assert.deepEqual(
    pacingWindowFromConfig({ peakWindows: { weekday: [6], hours: [8] }, peakBufferMs: 0 }),
    { weekday: [6], hours: [8], bufferMs: 0 },
    'config window + sibling buffer map to the pure options'
  )
  const mapped = pacingWindowFromConfig({})
  assert.deepEqual([...resolvePacingWindow(mapped).hours], [1, 2, 3, 6, 7, 8, 9], 'an absent config maps to the defaults')
})

// ---------------------------------------------------------------------------
// (2) WORK-REGISTER pending-count heuristic (the VALLE notice's N).
// ---------------------------------------------------------------------------

test('PACING pure: countPendingWorkRegister — legible register → the bold-item count; CERRADO sections + DONE tags excluded; not-a-register → undefined', () => {
  const register = [
    '## 1. IPD — cola activa',
    '- **M4** watchdog … · **M-A** monitor …',
    '## 2. DAG técnico — CERRADO (referencia)',
    '- **F-HIGH** — CERRADO …',
    '## 3. PENDIENTE-OWNER',
    '- **Publish** … · **METR → nada** …',
    '## 4. Backlog',
    '- **F3** ítem … · **DONE** (de-flakeado) · **O3** firma …'
  ].join('\n')
  assert.equal(countPendingWorkRegister(register), 6, 'bold item headers across the OPEN sections (1: M4, M-A; 3: Publish, METR; 4: F3, O3) — DONE tagged + the CERRADO section excluded')
  assert.equal(countPendingWorkRegister('# no section headings'), undefined, 'a doc without ## headings is not legible → undefined (the count is omitted)')
  assert.equal(countPendingWorkRegister('## Solo — CERRADO\n- **X** cerrado'), 0, 'a fully-closed register counts 0')
  assert.equal(countPendingWorkRegister(''), undefined, 'empty text → undefined')
})

// ---------------------------------------------------------------------------
// (3) WAKE-PACK SEAM — the ONE `## Pacing (franja)` section.
// ---------------------------------------------------------------------------

test('PACING pack: buildWakePack renders the section from the pure `pacing` part (+ the franja line only)', () => {
  const base = { memberId: 'host-asst', role: 'host', messageDelta: '- m-1 | a → h | hi', roster: 'x', includeGuidance: false }
  const withPacing = buildWakePack({ ...base, pacing: 'Franja: PEAK [01:00-10:00] UTC — hasta 10:30 UTC' })
  assert.match(withPacing, /^## Pacing \(franja\)$/m, 'the franja section header is present')
  assert.match(withPacing, /Franja: PEAK \[01:00-10:00\] UTC — hasta 10:30 UTC/, 'the stable PEAK line is embedded')
  assert.match(withPacing, /## Condensed roster/, 'the rest of the pack is untouched')
  const legacy = buildWakePack(base)
  assert.ok(!legacy.includes('## Pacing (franja)'), 'a pack WITHOUT the pacing part omits the section (the pre-pacing pack, R6-legacy)')
})

test('PACING pack (assembly, fixed clock): the lean wake snapshot carries the franja line in PEAK and VALLE — and omits it when `enabled:false`', async () => {
  await withTempStateDir(async (stateDir) => {
    const prevNow = process.env.DEEPARTMENTS_TEST_NOW
    const svc = () => createWakePackService({
      byPost: new Map(),
      hosts: new Map(),
      getHost: () => undefined,
      postIdForChild: () => undefined,
      hostIdForSession: (sid) => `host-${sid}`,
      refreshPresence() {},
      wakePackInjected: new Set(),
      deferredSleepReplace: new Map(),
      persistHosts() {},
      roleForSession: () => 'generic',
      buildSubagentOrientation: () => '',
      computeHostSleepSurfacePlan: () => ({ surfaceOp: 'append' }),
      buildSleepJournalMessage: () => ({}),
      assembleHeartbeat: () => undefined,
      readPresenceStateFile: () => ({ present: true }),
      journalPathFor: (id) => path.join(stateDir, 'journals', `${id}.md`),
      messagesStoreReady: async () => ({ page: () => ({ messages: [] }) }),
      stateDir,
      repoRoot: '/nonexistent',
      pacing: undefined,
      logger: { warn() {} }
    })
    try {
      // PEAK instant (Monday 08:00 UTC).
      process.env.DEEPARTMENTS_TEST_NOW = String(Date.UTC(2026, 7, 24, 8, 0))
      const peakSnapshot = await svc().assembleWakeSnapshot('host-asst')
      assert.match(peakSnapshot, /Franja: PEAK \[01:00-10:00\] UTC — hasta 10:30 UTC/, 'the snapshot carries the PEAK franja line (fixed clock)')
      // VALLE instant (Monday 04:40 UTC).
      process.env.DEEPARTMENTS_TEST_NOW = String(Date.UTC(2026, 7, 24, 4, 40))
      const valleSnapshot = await svc().assembleWakeSnapshot('host-asst')
      assert.match(valleSnapshot, /Franja: VALLE \[01:00-10:00\] UTC — hasta 05:30 UTC/, 'the snapshot carries the VALLE franja line (fixed clock)')
      // Knob off → legacy (no section, no line).
      process.env.DEEPARTMENTS_TEST_NOW = String(Date.UTC(2026, 7, 24, 8, 0))
      const offSvc = createWakePackService({
        byPost: new Map(),
        hosts: new Map(),
        getHost: () => undefined,
        postIdForChild: () => undefined,
        hostIdForSession: (sid) => `host-${sid}`,
        refreshPresence() {},
        wakePackInjected: new Set(),
        deferredSleepReplace: new Map(),
        persistHosts() {},
        roleForSession: () => 'generic',
        buildSubagentOrientation: () => '',
        computeHostSleepSurfacePlan: () => ({ surfaceOp: 'append' }),
        buildSleepJournalMessage: () => ({}),
        assembleHeartbeat: () => undefined,
        readPresenceStateFile: () => ({ present: true }),
        journalPathFor: (id) => path.join(stateDir, 'journals', `${id}.md`),
        messagesStoreReady: async () => ({ page: () => ({ messages: [] }) }),
        stateDir,
        repoRoot: '/nonexistent',
        pacing: { enabled: false },
        logger: { warn() {} }
      })
      const legacySnapshot = await offSvc.assembleWakeSnapshot('host-asst')
      assert.ok(!legacySnapshot.includes('## Pacing (franja)'), 'enabled:false → no franja section (the pre-pacing snapshot)')
    } finally {
      if (prevNow === undefined) delete process.env.DEEPARTMENTS_TEST_NOW
      else process.env.DEEPARTMENTS_TEST_NOW = prevNow
    }
  })
})

// ---------------------------------------------------------------------------
// (4) DAEMON TRANSITIONS — once per transition, durable channel, dedupe.
// ---------------------------------------------------------------------------

test('PACING daemon: VALLE → PEAK transition notifies the host ONCE («pausa de nuevos despachos»); the re-tick in the same franja stays silent; PEAK → VALLE notifies ONCE («reanuda; despachos diferidos: N») with the WORK-REGISTER count', async () => {
  await withTempStateDir(async (stateDir) => {
    // A legible WORK-REGISTER fixture for the count.
    const registerPath = path.join(stateDir, 'WORK-REGISTER.md')
    await writeFile(registerPath, [
      '## 1. IPD — cola activa',
      '- **M4** watchdog …',
      '## 2. DAG — CERRADO (referencia)',
      '- **F-HIGH** — CERRADO',
      '## 3. PENDIENTE-OWNER',
      '- **Publish** … · **METR → nada** …',
      '## 4. Backlog',
      '- **F3** … · **DONE** … · **O3** …'
    ].join('\n'), 'utf8')

    const { tick, calls } = makeTick(stateDir, { workRegisterPath: registerPath })
    // Boot at 07:59 (VALLE): first tick records the baseline — NO notice.
    await tick(Date.UTC(2026, 7, 24, 7, 59))
    assert.equal(calls.length, 0, 'first boot records the baseline and emits NOTHING (documented)')
    const baseline = readPacingState(stateDir)
    assert.equal(baseline.franja, 'valle', 'the first-boot baseline records the current franja')
    // 08:01 — VALLE → PEAK transition: notify EXACTLY once.
    await tick(Date.UTC(2026, 7, 24, 8, 1))
    assert.equal(calls.length, 1, 'the PEAK transition notifies the host exactly once')
    assert.equal(calls[0].hostEntry.hostId, 'host-asst', 'the notice targets the live host')
    assert.match(calls[0].frame, /^\[From deepartments\] Pacing PEAK:/, 'the PEAK notice uses the pacing frame')
    assert.match(calls[0].frame, /pausa de nuevos despachos a departamentos \(los in-flight continúan\)/, 'the PEAK notice says «pausa de nuevos despachos» + the in-flight clause')
    assert.match(calls[0].frame, /hasta 09:00 UTC/, 'the PEAK frame names when the franja ends')
    // 08:02 — same franja: silent.
    await tick(Date.UTC(2026, 7, 24, 8, 2))
    assert.equal(calls.length, 1, 'a re-tick inside the SAME franja does NOT re-notify')
    assert.equal(readPacingState(stateDir).franja, 'peak', 'the baseline advanced to peak')
    // 09:01 — PEAK → VALLE transition: notify EXACTLY once, WITH the count.
    await tick(Date.UTC(2026, 7, 24, 9, 1))
    assert.equal(calls.length, 2, 'the VALLE transition notifies the host exactly once')
    assert.match(calls[1].frame, /^\[From deepartments\] Pacing VALLE:/, 'the VALLE notice uses the pacing frame')
    assert.match(calls[1].frame, /reanuda los despachos a departamentos/, 'the VALLE notice says «reanuda»')
    assert.match(calls[1].frame, /despachos diferidos: 5 \(cola del WORK-REGISTER\)/, 'the VALLE notice carries the legible WORK-REGISTER pending count (bold headers M4, Publish, METR, F3, O3 — DONE excluded, the CERRADO section skipped)')
  })
})

test('PACING daemon: the VALLE notice OMITS the count when the WORK-REGISTER is unreadable (no workRegisterPath)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { tick, calls } = makeTick(stateDir)
    await tick(Date.UTC(2026, 7, 24, 7, 59)) // boot baseline valle
    await tick(Date.UTC(2026, 7, 24, 8, 1)) // peak notice
    await tick(Date.UTC(2026, 7, 24, 9, 1)) // valle notice — NO register path
    assert.equal(calls.length, 2, 'both transitions notify')
    assert.ok(!calls[1].frame.includes('despachos diferidos'), 'an unreadable register → the count is omitted (si no, sin conteo)')
  })
})

test('PACING daemon: no-duplicate — a lost baseline write cannot double-notify the SAME transition (shared-ledger dedupe key pacing-transition)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { tick, calls } = makeTick(stateDir)
    // Boot at 07:59 (baseline valle), transition at 08:01 → ONE notice.
    await tick(Date.UTC(2026, 7, 24, 7, 59))
    await tick(Date.UTC(2026, 7, 24, 8, 1))
    assert.equal(calls.length, 1, 'the transition notified once')
    // Simulate a crash that lost the BASELINE write: delete pacing-state.json
    // (the shared ledger stamp survives in health-alerts-state.json).
    await rm(path.join(stateDir, PACING_STATE_FILE), { force: true })
    // 08:02 — the daemon re-detects the transition (baseline gone), but the
    // shared-ledger key 'pacing-transition' is inside the 30-min window → the
    // SAME transition is NOT re-notified.
    await tick(Date.UTC(2026, 7, 24, 8, 2))
    assert.equal(calls.length, 1, 'a re-detected transition inside the dedupe window does NOT double-notify')
    assert.equal(readPacingState(stateDir).franja, 'peak', 'the baseline recovered quietly')
    // After the 30-min window the ledgers key is pruned/expired — a REAL new
    // transition (09:01 valle) still notifies (the dedupe never blocks a
    // genuine next transition).
    await tick(Date.UTC(2026, 7, 24, 9, 1))
    assert.equal(calls.length, 2, 'the NEXT genuine transition still notifies')
  })
})

test('PACING daemon: first boot INSIDE PEAK emits nothing (documented); knob off → NO monitor at all (the legacy behavior)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { tick, calls } = makeTick(stateDir)
    // The very first tick lands INSIDE the peak (08:01) — the entry window is
    // already past → baseline only, NO notice (documented decision; the wake
    // pack carries the current franja).
    await tick(Date.UTC(2026, 7, 24, 8, 1))
    assert.equal(calls.length, 0, 'a first boot inside PEAK does NOT emit (the entry transition is unknowable)')
    assert.equal(readPacingState(stateDir).franja, 'peak', 'the baseline records the peak')
    // Subsequent re-ticks stay silent (same franja).
    await tick(Date.UTC(2026, 7, 24, 8, 2))
    assert.equal(calls.length, 0, 'no transition → no notice')
  })
  await withTempStateDir(async (stateDir) => {
    // Knob OFF: the scan is a NO-OP — no baseline, no notices (legacy).
    const { tick, calls } = makeTick(stateDir, { config: { org: { pacing: { enabled: false } }, health: {} } })
    await tick(Date.UTC(2026, 7, 24, 7, 59))
    await tick(Date.UTC(2026, 7, 24, 8, 1))
    await tick(Date.UTC(2026, 7, 24, 9, 1))
    assert.equal(calls.length, 0, 'org.pacing.enabled:false → no transition notices (the pre-pacing behavior)')
    let baselineWritten = true
    try {
      await readFile(path.join(stateDir, PACING_STATE_FILE), 'utf8')
    } catch {
      baselineWritten = false
    }
    assert.equal(baselineWritten, false, 'enabled:false → the monitor never writes pacing-state.json')
  })
})

test('PACING daemon: a transition with NO live host is skipped and the baseline is NOT advanced — it RETRIES once a host is live (the no-perdible contract)', async () => {
  await withTempStateDir(async (stateDir) => {
    const { tick, calls } = makeTick(stateDir)
    await tick(Date.UTC(2026, 7, 24, 7, 59), { hosts: [] }) // boot baseline valle (hostless boot is fine)
    // Transition at 08:01 with NO host → skipped, baseline stays valle.
    await tick(Date.UTC(2026, 7, 24, 8, 1), { hosts: [] })
    assert.equal(calls.length, 0, 'no live host → no notice')
    assert.equal(readPacingState(stateDir).franja, 'valle', 'the baseline is NOT advanced (the notice retries)')
    // The SAME transition with a live host (08:02, still valle→peak pending)
    // → delivers exactly once.
    await tick(Date.UTC(2026, 7, 24, 8, 2), { hosts: HOSTS })
    assert.equal(calls.length, 1, 'the pending transition notifies once the host is live')
    assert.match(calls[0].frame, /Pacing PEAK:/, 'the retried notice is the PEAK pause')
  })
})

test('PACING daemon: the shared ledger records the dedupe key (pacing-transition) + the health frame builder composes the PEAK/VALLE text', async () => {
  await withTempStateDir(async (stateDir) => {
    const { tick } = makeTick(stateDir)
    await tick(Date.UTC(2026, 7, 24, 7, 59))
    await tick(Date.UTC(2026, 7, 24, 8, 1))
    const ledger = JSON.parse(await readFile(path.join(stateDir, 'health-alerts-state.json'), 'utf8'))
    assert.equal(typeof ledger[PACING_TRANSITION_KEY], 'number', 'the shared health-alerts ledger records the pacing-transition stamp')
  })
  // The pure frame builder (a VALLE instant: 11:00 UTC — after the last
  // window's buffer-expanded end 10:30):
  assert.match(buildPacingTransitionFrame(pacingStateAt(at(8, 0)), 7), /pausa de nuevos despachos/, 'PEAK frame: pause clause')
  assert.ok(!buildPacingTransitionFrame(pacingStateAt(at(8, 0)), 7).includes('despachos diferidos'), 'the PEAK frame never carries the count')
  assert.match(buildPacingTransitionFrame(pacingStateAt(at(11, 0)), 7), /despachos diferidos: 7/, 'VALLE frame carries the count when given')
  assert.ok(!buildPacingTransitionFrame(pacingStateAt(at(11, 0))).includes('despachos diferidos'), 'VALLE frame omits the count when undefined')
})

// ---------------------------------------------------------------------------
// (5) ORG SCHEMA — org.pacing.* (M4 style: absent → code defaults).
// ---------------------------------------------------------------------------

test('PACING schema: `org.pacing` is declared in Config (absent → undefined → code defaults; explicit values are preserved; out-of-range is rejected)', () => {
  const base = { stateDir: '.deepartments', org: { departments: [{ id: 'r', name: 'R' }] } }
  const absent = configSchema(base)
  assert.equal(absent.org.pacing, undefined, 'an absent pacing section → undefined (the code defaults apply)')
  const explicit = configSchema({
    ...base,
    org: {
      departments: base.org.departments,
      pacing: { enabled: true, peakWindows: { weekday: [1, 2, 3, 4, 5], hours: [1, 2, 3, 6, 7, 8, 9] }, peakBufferMs: 1_800_000 }
    }
  })
  assert.deepEqual(explicit.org.pacing, {
    enabled: true,
    peakWindows: { weekday: [1, 2, 3, 4, 5], hours: [1, 2, 3, 6, 7, 8, 9] },
    peakBufferMs: 1_800_000
  }, 'an explicit pacing section is preserved verbatim')
  const disabled = configSchema({ ...base, org: { departments: base.org.departments, pacing: { enabled: false } } })
  assert.deepEqual(disabled.org.pacing, { enabled: false }, 'pacing:{enabled:false} is preserved (the config-toggle path)')
  assert.throws(() => configSchema({ ...base, org: { departments: base.org.departments, pacing: { peakWindows: { hours: [24] } } } }), /24|hours/, 'an out-of-range hour is REJECTED by the schema')
  assert.throws(() => configSchema({ ...base, org: { departments: base.org.departments, pacing: { peakWindows: { weekday: [0] } } } }), undefined, 'an out-of-range weekday is rejected by the schema')
})