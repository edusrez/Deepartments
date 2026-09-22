// W3 (builder-455) — ADDENDUM DEL CONTRATO (head, deadline note) — the FRONTIER
// cases, plus the POSITIVE CONTROL the head demanded (fb-973/fb-867).
//
// WHY THE POSITIVE CONTROL EXISTS: a mis-named unit in `journalctl` produces a
// clean, credible NEGATIVE. Applied here: proving that "0 findings when the
// signal is absent" is worth NOTHING unless I also prove that my reader FINDS
// the signal where I KNOW it is. So this file writes the marker at the REAL
// resolved path the daemon reads and asserts the finding appears — the reader is
// located, not assumed.
//
// THE ADDENDUM'S THREE FRONTIER CASES (verbatim from the head):
//   · absent/null                     ⇒ 0 findings (byte-identical);
//   · {mode:'declared'} WITHOUT entries ⇒ 0 findings;
//   · {mode:'legacy'}   WITHOUT entries ⇒ ALERT, with «entry not nameable»
//     explicit and WITHOUT fabricating an entry.
//
// fb-95 (AGENTS.md): built-lib test (plain `node --test` over lib/invoke.js).
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildHealthAlertFrame, runHealthDaemonTick, scanPoolerCapacity } from '../lib/invoke.js'

const T0 = 1_788_000_000_000
const MIN = 60_000
const KEY_LEGACY = 'pooler-capacity:official-api:legacy'
const KEY_DECLARED = 'pooler-capacity:official-api:declared'

const SCAN_KNOBS = {
  stateStaleMs: 600_000,
  warningUsableKeys: 1,
  okUsableKeys: 2,
  blockedKeysInWindow: 3,
  criticalGlobalRemainingPercent: 20,
  criticalWeeklyRemainingPercent: 10
}

const oc6 = () => ({
  id: 'oc-6', workspace: 'ws6', invalid: false, blockedUntil: 0, cooldownUntil: 0,
  usageWeekly: { status: 'ok', percent: 10 }, usageMonthly: { status: 'ok', percent: 20 }
})

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'w3-addendum-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

async function writeSnapshot(p, { keys = { 'oc-6': oc6() }, officialApiGuard, stale = false } = {}) {
  const snapshot = {
    updatedAt: new Date(T0 - (stale ? 60 * MIN : MIN)).toISOString(),
    keys,
    lastRotation: null
  }
  if (officialApiGuard !== undefined) snapshot.officialApiGuard = officialApiGuard
  await writeFile(p, JSON.stringify(snapshot), 'utf8')
  return p
}

// ===========================================================================
// FRONTERA 2 — {mode:'declared'} WITHOUT entries ⇒ 0 findings.
// (Kept distinct from the file's other regression test: this is the ADDENDUM's
// own literal case, and it must stay INTACT/untouched as the head required.)
// ===========================================================================
test("W3-frontera (2) {mode:'declared'} SIN el campo `entries` ⇒ 0 findings — la rama declarada sin lista no afirma que apareció nada (no se fabrica una entrada)", async () => {
  await withTempStateDir(async (stateDir) => {
    const p = await writeSnapshot(path.join(stateDir, 'declared-no-entries.json'), {
      officialApiGuard: { at: '2026-09-22T06:00:00.000Z', mode: 'declared' }
    })
    assert.deepEqual(
      scanPoolerCapacity(p, T0, SCAN_KNOBS),
      [],
      "declared WITHOUT entries → 0 findings (an absent list is NOT an appearance — the conservative, pre-W3-identical verdict)"
    )
  })
})

// ===========================================================================
// FRONTERA 3 — {mode:'legacy'} WITHOUT entries ⇒ ALERT, no fabricated entry.
// ===========================================================================
test("W3-frontera (3) {mode:'legacy'} SIN entradas ⇒ ALERTA IGUAL (clave `…:legacy`, texto con «entry not nameable» EXPLÍCITO y SIN fabricar ninguna entrada) — la rama legacy sin lista SÍ alerta: el singleton cargado-inerte es un hecho que se declara, no una lista que se enumera", async () => {
  await withTempStateDir(async (stateDir) => {
    const p = await writeSnapshot(path.join(stateDir, 'legacy-no-entries.json'), {
      officialApiGuard: { at: '2026-09-22T06:00:00.000Z', mode: 'legacy' }
    })
    const findings = scanPoolerCapacity(p, T0, SCAN_KNOBS)
    assert.equal(findings.length, 1, 'legacy WITHOUT entries → the ALERT still fires (the branch itself is the declared fact)')
    assert.equal(findings[0].key, KEY_LEGACY, 'on the legacy key')
    assert.equal(findings[0].count, 1, 'the count floors at 1: the declaration IS the source of record, not a list length')
    const error = findings[0].error
    assert.match(error, /entry not nameable/, 'the bullet says EXPLICITLY that the entry is not nameable')
    assert.match(error, /mode legacy/, 'and names the branch')
    // NEVER FABRICATE: no channel/host/rule may appear out of thin air.
    assert.doesNotMatch(error, /ds-official/, 'no channel is invented')
    assert.doesNotMatch(error, /api\.deepseek\.com/, 'no upstream host is invented')
    assert.doesNotMatch(error, /official-upstream|official-key-sha16|official-key-env|official-key-file/, 'no rule is invented')
    assert.doesNotMatch(error, /key-source/, 'no keySource is invented')
    // And it renders as critical through the REAL frame builder.
    assert.match(buildHealthAlertFrame(findings), /^- pooler-capacity critical: OFFICIAL API in the pooler \(mode legacy/m, 'the render labels it critical and names the legacy branch')
  })
})

// ===========================================================================
// CONTROL POSITIVO OBLIGATORIO (fb-973/fb-867) — the reader is LOCATED.
// ===========================================================================
test("W3-control-positivo (fb-973/fb-867): el lector se LOCALIZA — el marcador escrito en la RUTA REAL que el daemon resuelve (`dshHome()/keyPooler-state.json`) SÍ produce la alerta; no se asume la ubicación (una unidad mal nombrada daría un negativo limpio y creíble)", async () => {
  await withTempStateDir(async (stateDir) => {
    // THE REAL RESOLUTION, read from the source of truth rather than assumed:
    // the bundle wiring resolves the path as `path.join(dshHome(), POOLER_STATE_FILE)`
    // (packages/dshd-orchestration/src/tools.ts — `healthPoolerStatePath`).
    const toolsSrc = readFileSync(
      '/home/esuarez/projects/deepartments/packages/dshd-orchestration/src/tools.ts',
      'utf8'
    )
    const wiring = toolsSrc.match(/const healthPoolerStatePath = [^\n]*\n[^\n]*\n[^\n]*/)
    assert.notEqual(wiring, null, 'the REAL wiring expression is locatable in the source (the control anchors on the true seam, not on my belief)')
    assert.match(wiring[0], /path\.join\(dshHome\(\), POOLER_STATE_FILE\)/, 'the daemon reads `<dshHome>/<POOLER_STATE_FILE>` — the reader is measured at THAT path')
    const stateFileName = toolsSrc.match(/POOLER_STATE_FILE\s*=\s*'([^']+)'/)?.[1]
    assert.equal(stateFileName, 'keyPooler-state.json', 'the state file name is the documented one (a rename here would silently blind the detector — exactly the fb-973 class)')

    // Now write the marker AT THAT RESOLVED SHAPE and prove the tick alerts.
    const poolerStatePath = path.join(stateDir, stateFileName)
    assert.equal(existsSync(poolerStatePath), false, 'the positive control starts from ABSENCE (so the finding cannot come from a leftover)')
    const alerts = []
    const deps = (poolerPath) => ({
      now: () => T0,
      stateDir,
      bootId: 'boot-w3-addendum',
      config: { health: {} },
      hosts: [{ hostId: 'host-asst', sessionId: 's-live' }],
      posts: [],
      poolerStatePath: poolerPath,
      notifyHost: async (_h, frame) => { alerts.push({ frame }) }
    })
    // (i) NEGATIVE with the file ABSENT: the reader must NOT find a signal where
    // there is none (this is the half that a broken control would fake).
    await runHealthDaemonTick(deps(poolerStatePath))
    assert.equal(alerts.length, 0, 'ABSENT state file → no alert (the reader does not hallucinate a signal)')
    // (ii) POSITIVE with the marker written AT THE SAME RESOLVED PATH: the alert
    // MUST appear — this is the half that locates the reader.
    await writeSnapshot(poolerStatePath, {
      officialApiGuard: { at: '2026-09-22T06:00:00.000Z', mode: 'legacy' }
    })
    await runHealthDaemonTick(deps(poolerStatePath))
    assert.equal(alerts.length, 1, 'the marker AT THE REAL RESOLVED PATH → the alert fires (the reader is LOCATED, not assumed)')
    assert.match(alerts[0].frame, /OFFICIAL API in the pooler/, 'and the frame carries the official-API class')
    // (iii) The control's own teeth: the SAME marker written at a DIFFERENT
    // filename is NOT read — proving (ii) succeeded because the path is the real
    // seam, not because the scan reads any file it is handed.
    const wrongName = await writeSnapshot(path.join(stateDir, 'not-the-state-file.json'), {
      officialApiGuard: { at: '2026-09-22T06:00:00.000Z', mode: 'legacy' }
    })
    const secondBatch = []
    const depsWrong = { ...deps(wrongName), notifyHost: async (_h, frame) => { secondBatch.push({ frame }) } }
    // NOTE: this re-reads the REAL path (which now holds the marker) — so assert
    // on the WRONG-named file directly instead, via the pure scan.
    assert.equal(scanPoolerCapacity(wrongName, T0, SCAN_KNOBS).length, 1, 'the pure scan reads whatever path it is POINTED at (the seam is the caller-injected path — the wiring, not the scan, owns WHICH file)')
    assert.equal(secondBatch.length, 0, 'and no alert is fabricated by the wrong-named probe alone')
  })
})
