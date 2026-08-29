// dsh-deepartments — client-ROW invariant test (GUI boot FAIL fix, 2026-08-29).
//
// The client-modules host keys every boot-graph row by the LOADER ENTRY name
// and a bundle must register that exact id via `window.__ModuleLoader__.load`
// (a loaded bundle that does not register the row id fails the client boot
// with "loaded without registering" → the "Failed to load plugins" screen).
// The deepartments client bundle registers the module id "dsh-deepartments"
// (the deepartments-client identity, D5 — see the ID constant in
// packages/dshd-gui/scripts/normalize-client-banner.mjs), so the `dsh.client`
// row must belong to the dsh-deepartments BUNDLE entry. packages/dshd-gui is a
// SEPARATE loader entry ("dshd-gui") — it must NOT declare `dsh.client`: the
// row "dshd-gui" could never be satisfied by a bundle registering
// "dsh-deepartments". Locked here so the split can never regress into the
// P1 boot failure (2026-08-29 dev outage: row dshd-gui → FAIL, row
// dsh-deepartments → OK).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

const readPkg = async (rel) => JSON.parse(await readFile(path.join(REPO_ROOT, rel), 'utf8'))
const bundlePkg = await readPkg('package.json')
const guiPkg = await readPkg(path.join('packages', 'dshd-gui', 'package.json'))
const normalize = await readFile(
  path.join(REPO_ROOT, 'packages', 'dshd-gui', 'scripts', 'normalize-client-banner.mjs'),
  'utf8'
)

test('client row: the deepartments-client row is declared by the dsh-deepartments BUNDLE entry', () => {
  assert.equal(bundlePkg.dsh?.client?.platform, 'web')
  assert.equal(typeof bundlePkg.exports?.['./client'], 'string')
  assert.equal(bundlePkg.name, 'dsh-deepartments')
})

test('client row: dshd-gui (loader entry "dshd-gui") must NOT declare dsh.client', () => {
  // A row is keyed by the loader entry name; this bundle registers
  // "dsh-deepartments", so a dsh.client declaration under the entry "dshd-gui"
  // is unfulfillable and fails the GUI boot.
  assert.equal(guiPkg.dsh?.client, undefined)
  assert.equal(guiPkg.name, 'dshd-gui')
})

test('client row: the envelope module id is the bundle identity (dsh-deepartments)', () => {
  // The registered id must equal the row id of the client-bearing entry.
  assert.match(normalize, /const ID = "dsh-deepartments"/)
})
