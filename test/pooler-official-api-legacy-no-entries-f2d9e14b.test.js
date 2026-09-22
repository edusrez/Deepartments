// dsh-deepartments — MICRO-TAREA (head, 2026-09-22) — CERRAR EL HUECO `legacy`
// SIN ENTRADAS en el detector de la API oficial. Run token: f2d9e14b.
//
// THE HOLE THIS FILE CLOSES (measured, then posted to the head): the W3 branch
// required `officialApiGuard.entries.length > 0` TO ALERT, so it read an
// ABSENT/EMPTY list as «nothing appeared» UNCONDITIONALLY. That is true for
// `declared` (a rejected config entry is a LIST: no rejected entry = healthy)
// but FALSE for `legacy`: the legacy singleton is a DECLARATION ABOUT THE BOOT,
// armed by `DEEPSEEK_API_KEY` resolving through the systemd `EnvironmentFile`
// (`/etc/dsh/dsh-deepartments-dev.env` — a LIVE mechanism whose file does not
// contain it TODAY; ONE added line arms the singleton's `default:true` WITHOUT
// TOUCHING CONFIG). That appearance has NO `channels:` row to name, and with
// `channels:` declared the singleton stays INERT and is never loaded — so
// `{mode:'legacy', entries: []}` (or `entries` absent) is a REAL reachable
// state, and the old predicate answered it with ZERO findings: the SILENT
// appearance the owner forbade (the owner's «que la aparición nunca sea
// silenciosa» — m-781 §4).
//
// THE THREE CASES (verbatim from the assignment):
//   (i)   {mode:'legacy', entries: []} ⇒ 1 finding;
//   (ii)  {mode:'legacy'} WITHOUT `entries` ⇒ 1 finding;
//   (iii) {mode:'declared', entries: []} ⇒ 0 findings (NO-REGRESSION, plus
//         null/absent ⇒ 0).
// NEVER FABRICATE: the bullet must say EXPLICITLY that no entry is nameable —
// no `channelId`/`upstreamHost` may be invented (the contract forbids
// synthesizing one).
//
// fb-95 (AGENTS.md): BUILT-lib test (plain `node --test` over lib/invoke.js) —
// it does NOT self-register the ts-src-loader hook, so the built lib must carry
// the change (hence `pnpm --filter dshd-health run build` before running this).
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildHealthAlertFrame, scanPoolerCapacity } from '../lib/invoke.js'

const T0 = 1_788_000_000_000

// The per-mode dedupe keys, asserted as LITERALS (they are module-private in the
// source: the compiled export surface is frozen at 349 by
// test/export-parity.test.js, so no export was added for this micro-tarea).
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

/** The healthy Go-pool key shape (the sibling suites' oc-6 device): one usable
 * key with plenty of quota — so the ONLY possible finding is the one this lane
 * adds (the control that makes every positive assertion attributable). */
const oc6 = () => ({
  id: 'oc-6',
  workspace: 'ws6',
  invalid: false,
  blockedUntil: 0,
  cooldownUntil: 0,
  usageWeekly: { status: 'ok', percent: 10 },
  usageMonthly: { status: 'ok', percent: 20 }
})

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'w3-legacy-no-entries-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Write a pooler snapshot. `officialApiGuard` is written ONLY when given:
 * `undefined` leaves the field ABSENT (the pre-W3 shape), an explicit `null`
 * writes null, and `{…}` writes the marker verbatim — so «absent entry» and
 * «empty entries» are two DISTINCT on-disk states, never conflated. */
async function writeSnapshot(stateDir, name, { keys = { 'oc-6': oc6() }, officialApiGuard } = {}) {
  const p = path.join(stateDir, `${name}.json`)
  const snapshot = { updatedAt: new Date(T0 - 60_000).toISOString(), keys, lastRotation: null }
  if (officialApiGuard !== undefined) snapshot.officialApiGuard = officialApiGuard
  await writeFile(p, JSON.stringify(snapshot), 'utf8')
  return p
}

// ===========================================================================
// (i) {mode:'legacy'} + `entries: []` ⇒ 1 finding on the legacy key.
// ===========================================================================
test("MICRO-TAREA (i) {mode:'legacy'} SIN entradas (`entries: []`) ⇒ 1 hallazgo en la clave `…:legacy` — el singleton CARGADO-INERTE es una declaración sobre el ARRANQUE, no una lista: un vacío NO puede silenciarlo", async () => {
  await withTempStateDir(async (stateDir) => {
    const p = await writeSnapshot(stateDir, 'legacy-empty', {
      officialApiGuard: { at: '2026-09-22T06:00:00.000Z', mode: 'legacy', entries: [] }
    })
    const findings = scanPoolerCapacity(p, T0, SCAN_KNOBS)
    assert.equal(findings.length, 1, 'legacy + entries: [] → the ALERT fires (this was the hole: it used to be 0)')
    assert.equal(findings[0].kind, 'pooler-capacity', 'the kind reuses the EXISTING pooler-capacity class (no new kind)')
    assert.equal(findings[0].key, KEY_LEGACY, 'the SAME per-mode dedupe key of its mode (never a third key)')
    assert.notEqual(findings[0].key, KEY_DECLARED, 'and never the declared key: the modes do not share a key')
    assert.equal(findings[0].ts, T0, 'the finding is stamped at the tick clock')
    assert.equal(buildHealthAlertFrame(findings).match(/- pooler-capacity critical:/g)?.length, 1, 'and it renders through the SAME path, labelled critical exactly once')
  })
})

// ===========================================================================
// (ii) {mode:'legacy'} WITH the `entries` FIELD ABSENT ⇒ 1 finding.
// ===========================================================================
test("MICRO-TAREA (ii) {mode:'legacy'} SIN el CAMPO `entries` ⇒ 1 hallazgo — «ausente» y «vacío» son dos estados de disco distintos y AMBOS alertan en la rama legacy (ni un hueco por omisión)", async () => {
  await withTempStateDir(async (stateDir) => {
    const p = await writeSnapshot(stateDir, 'legacy-no-field', {
      officialApiGuard: { at: '2026-09-22T06:00:00.000Z', mode: 'legacy' }
    })
    const findings = scanPoolerCapacity(p, T0, SCAN_KNOBS)
    assert.equal(findings.length, 1, 'legacy WITHOUT the entries field → the ALERT fires (the field being absent is not health)')
    assert.equal(findings[0].key, KEY_LEGACY, 'on the legacy key')
    // NEVER FABRICATE: the bullet must NAME the absence explicitly and invent
    // no channel/host/rule/provenance (the contract forbids synthesizing one).
    const error = findings[0].error
    assert.match(error, /0 source\(s\)/, 'the bullet declares 0 sources explicitly (it does not fake a list of one)')
    assert.match(error, /entry not nameable from the marker/, 'and says EXPLICITLY that no entry is nameable — the reader can tell «not nameable» from «named zero»')
    assert.match(error, /mode legacy/, 'the branch is named (legacy = WAS LOADED but INERT)')
    assert.match(error, /PERSONAL RESERVE/, 'the WHY is unchanged (the same tail as the with-entries bullet)')
    assert.doesNotMatch(error, /ds-official/, 'NO channel is invented')
    assert.doesNotMatch(error, /api\.deepseek\.com/, 'NO upstream host is invented')
    assert.doesNotMatch(error, /official-upstream|official-key-sha16|official-key-env|official-key-file/, 'NO rule is invented')
    assert.doesNotMatch(error, /key-source/, 'NO keySource is invented')
    assert.equal(findings[0].count, 1, 'the count floors at 1: the DECLARATION is the source of record, not a list length')
  })
})

// ===========================================================================
// (iii) NO-REGRESSION — `declared` with no entries stays healthy (0 findings),
//       and so do the absent/null marker shapes.
// ===========================================================================
test("MICRO-TAREA (iii) NO-REGRESIÓN: {mode:'declared'} sin entradas ⇒ 0 hallazgos (ninguna entrada rechazada = SANO) y el marcador ausente/null ⇒ 0 — el cambio es aditivo y NO toca el comportamiento fijado por el test existente", async () => {
  await withTempStateDir(async (stateDir) => {
    const declaredEmpty = await writeSnapshot(stateDir, 'declared-empty', {
      officialApiGuard: { at: '2026-09-22T06:00:00.000Z', mode: 'declared', entries: [] }
    })
    assert.deepEqual(scanPoolerCapacity(declaredEmpty, T0, SCAN_KNOBS), [], "mode:'declared' + entries: [] → 0 findings (NO-REGRESSION: a rejected config entry is a LIST, and no rejected entry is HEALTHY)")

    const declaredNoField = await writeSnapshot(stateDir, 'declared-no-field', {
      officialApiGuard: { at: '2026-09-22T06:00:00.000Z', mode: 'declared' }
    })
    assert.deepEqual(scanPoolerCapacity(declaredNoField, T0, SCAN_KNOBS), [], "mode:'declared' WITHOUT the entries field → 0 findings (an absent list is NOT an appearance)")

    const absent = await writeSnapshot(stateDir, 'absent')
    assert.deepEqual(scanPoolerCapacity(absent, T0, SCAN_KNOBS), [], 'the marker ABSENT → 0 findings (byte-identical to the pre-W3 scan)')

    const nullMarker = await writeSnapshot(stateDir, 'null-marker', { officialApiGuard: null })
    assert.deepEqual(scanPoolerCapacity(nullMarker, T0, SCAN_KNOBS), [], 'explicit null → 0 findings (the healthy producer shape)')

    // AND THE DISCRIMINATING CONTROL: the SAME «no entries» shape on the OTHER
    // branch DOES alert — so the 0s above are a per-mode DECISION, not a
    // vacuous «nothing ever fires» (fb-973: a clean negative is worth nothing
    // unless the instrument is shown to find the signal where it exists).
    const legacyEmpty = await writeSnapshot(stateDir, 'legacy-empty-control', {
      officialApiGuard: { at: '2026-09-22T06:00:00.000Z', mode: 'legacy', entries: [] }
    })
    assert.equal(scanPoolerCapacity(legacyEmpty, T0, SCAN_KNOBS).length, 1, 'CONTROL: the identical empty list on `legacy` DOES fire — the 0s above are per-mode, not vacuous')
  })
})
