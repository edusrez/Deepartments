// dshd-core — R3 BUNDLE-LAYER PATCH WATCHDOG tests (WORK-REGISTER post-cierre
// 2026-09-04, QD finding 09-04). Covers the pure resolution/snapshot/detect
// seams (parseProfileNameFromArgv, resolveBundlePatchPaths,
// snapshotBundlePatchMtimes, findChangedBundlePatches) + the durable sidecar
// roundtrip + the REAL installer (installBundlePatchWatchdog against a live
// @deepseek-ai/cordis Context with a fixture profile: boot snapshot, no alert
// on a quiet interval, LOUD warn + durable sidecar on a committed bundle-layer
// change, opt-out, no-profile disable, and the disposer clearing the timer).
//
// Style: M1/M4 — injectable argv/home/clock + fixtures under tmpdir; the
// installer's warns are captured through the cordis logger exporter
// (`levels: { default: 5 }` — warn/info reach a registered exporter). Runs
// against the COMPILED lib (pnpm build first — AGENTS.md TIERED verification).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  BUNDLE_PATCH_ALERTS_FILE,
  BUNDLE_PATCH_CHECK_INTERVAL_MS,
  parseProfileNameFromArgv,
  resolveBundlesFromProfileManifest,
  resolveBundlePatchPath,
  resolveBundlePatchPaths,
  snapshotBundlePatchMtimes,
  findChangedBundlePatches,
  readBundlePatchAlerts,
  writeBundlePatchAlerts,
  installBundlePatchWatchdog,
} from 'dshd-core'

const tmp = () => mkdtempSync(join(tmpdir(), 'r3-bundle-patches-'))

/** Write one bundle package fixture (package.json declaring dsh.bundle.patch +
 * a cordis.patch.yml) under `profileDir/node_modules`. */
function makeBundle(profileDir, packageName, patchRel = './cordis.patch.yml', content = '- id: probe\n  config:\n    value: one\n') {
  const packageDir = join(profileDir, 'node_modules', packageName)
  mkdirSync(join(packageDir, '..'), { recursive: true })
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: packageName,
    dsh: { bundle: { patch: patchRel } },
  }, null, 2))
  const patchPath = join(packageDir, patchRel.replace(/^\.\//, ''))
  writeFileSync(patchPath, content)
  return patchPath
}

const EVENTUALLY_MS = 5_000
async function eventually(test, message) {
  const deadline = Date.now() + EVENTUALLY_MS
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

test('parseProfileNameFromArgv reads --profile from a dsh argv', () => {
  assert.equal(parseProfileNameFromArgv(['node', '/usr/bin/dsh', '--profile', 'deepartments-dev', '--port', '3090']), 'deepartments-dev')
  assert.equal(parseProfileNameFromArgv(['node', '/usr/bin/dsh']), undefined)
  assert.equal(parseProfileNameFromArgv(['node', '/usr/bin/dsh', '--profile']), undefined)
  assert.equal(parseProfileNameFromArgv(['node', 'dsh', '--profile', '--port', '3090']), undefined)
})

test('resolveBundlePatchPaths resolves every resolvable bundle layer of the profile manifest', () => {
  const home = tmp()
  const profileDir = join(home, 'profiles', 'r3-test')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@scope/probe-pkg', 'plain-pkg', 'broken-pkg'] } },
  }))
  const probePatch = makeBundle(profileDir, '@scope/probe-pkg')
  const plainPatch = makeBundle(profileDir, 'plain-pkg', 'cordis.patch.yml')
  assert.deepEqual(resolveBundlesFromProfileManifest(profileDir), ['@scope/probe-pkg', 'plain-pkg', 'broken-pkg'])
  // The broken bundle (no package on disk) is SKIPPED, never fatal.
  assert.deepEqual(resolveBundlePatchPaths(profileDir), [probePatch, plainPatch])
  assert.equal(resolveBundlePatchPath(profileDir, 'broken-pkg'), undefined)
  assert.equal(resolveBundlePatchPath(join(home, 'nope'), 'anything'), undefined)
  rmSync(home, { recursive: true, force: true })
})

test('snapshot + findChanged detect an mtime move and a disappearance; quiet stays quiet', () => {
  const dir = tmp()
  const fileA = join(dir, 'a.patch.yml')
  const fileB = join(dir, 'b.patch.yml')
  writeFileSync(fileA, '- id: a\n')
  writeFileSync(fileB, '- id: b\n')
  utimesSync(fileA, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
  utimesSync(fileB, new Date(1_700_000_100_000), new Date(1_700_000_100_000))
  const paths = [fileA, fileB]
  const boot = snapshotBundlePatchMtimes(paths)
  assert.equal(boot[fileA], 1_700_000_000_000)
  assert.equal(boot[fileB], 1_700_000_100_000)

  // No change → nothing to alert.
  assert.deepEqual(findChangedBundlePatches(boot, snapshotBundlePatchMtimes(paths)), [])

  // A committed edit moves only fileA.
  utimesSync(fileA, new Date(1_700_000_200_000), new Date(1_700_000_200_000))
  const changed = findChangedBundlePatches(boot, snapshotBundlePatchMtimes(paths))
  assert.equal(changed.length, 1)
  assert.equal(changed[0].path, fileA)
  assert.equal(changed[0].bootMtimeMs, 1_700_000_000_000)
  assert.equal(changed[0].nowMtimeMs, 1_700_000_200_000)

  // A disappeared file is a change too (nowMtimeMs undefined).
  rmSync(fileB)
  const disappeared = findChangedBundlePatches(boot, snapshotBundlePatchMtimes(paths))
  assert.ok(disappeared.some(row => row.path === fileB && row.nowMtimeMs === undefined))
  rmSync(dir, { recursive: true, force: true })
})

test('the durable sidecar roundtrips (write → read)', async () => {
  const stateDir = tmp()
  const state = {
    seenAt: 1_700_000_000_000,
    changed: [{ path: '/x/cordis.patch.yml', bootMtimeMs: 1, nowMtimeMs: 2 }],
  }
  await writeBundlePatchAlerts(stateDir, state)
  const read = readBundlePatchAlerts(stateDir)
  assert.deepEqual(read, state)
  assert.ok(existsSync(join(stateDir, BUNDLE_PATCH_ALERTS_FILE)))
  // A malformed file degrades to undefined (never throws).
  writeFileSync(join(stateDir, BUNDLE_PATCH_ALERTS_FILE), 'not json')
  assert.equal(readBundlePatchAlerts(stateDir), undefined)
  rmSync(stateDir, { recursive: true, force: true })
})

test('installBundlePatchWatchdog: quiet at boot snapshot, LOUD + durable on a committed bundle-layer edit, timer cleared on dispose', async () => {
  const home = tmp()
  const stateDir = tmp()
  const profileDir = join(home, 'profiles', 'r3-live')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@scope/probe-pkg'] } },
  }))
  const patchPath = makeBundle(profileDir, '@scope/probe-pkg')
  utimesSync(patchPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000))

  const ctx = new Context()
  const logs = []
  ctx.logger.exporter({ levels: { default: 5 }, export: message => {
    logs.push({ type: message.type, text: String(message.args[0] ?? '') })
  } })

  const disposer = installBundlePatchWatchdog(ctx, {
    stateDir,
    org: { bundlePatchCheckIntervalMs: 20 },
  }, { argv: ['node', 'dsh', '--profile', 'r3-live'], home })

  // At boot the snapshot is recorded (info line); a quiet interval stays quiet.
  await eventually(() => logs.some(l => l.type === 'info' && l.text.includes('boot snapshot')), 'the boot snapshot info line was not logged')
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(logs.filter(l => l.type === 'warn' && l.text.includes('restart required')).length, 0, 'no warn while the bundle patch is unchanged')

  // A bundle-layer patch committed after boot → LOUD repeated warn + durable sidecar.
  utimesSync(patchPath, new Date(1_700_000_300_000), new Date(1_700_000_300_000))
  await eventually(
    () => logs.some(l => l.type === 'warn' && l.text.includes('restart required') && l.text.includes(patchPath)),
    'the bundle-layer change was not announced loudly',
  )
  await eventually(() => readBundlePatchAlerts(stateDir)?.changed.length === 1, 'the durable sidecar was not written')
  const sidecar = readBundlePatchAlerts(stateDir)
  assert.equal(sidecar?.changed[0].path, patchPath)
  assert.equal(sidecar.changed[0].bootMtimeMs, 1_700_000_000_000)
  assert.equal(sidecar.changed[0].nowMtimeMs, 1_700_000_300_000)
  // Durable + noisy: the warn REPEATS on the next interval (never one-shot).
  const warnsBefore = logs.filter(l => l.type === 'warn' && l.text.includes('restart required')).length
  await eventually(() => logs.filter(l => l.type === 'warn' && l.text.includes('restart required')).length > warnsBefore, 'the warn must repeat every interval while stale')

  // Dispose clears the interval: no further warns after a NEW change.
  disposer()
  const warnsAtDispose = logs.filter(l => l.type === 'warn' && l.text.includes('restart required')).length
  utimesSync(patchPath, new Date(1_700_000_500_000), new Date(1_700_000_500_000))
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(logs.filter(l => l.type === 'warn' && l.text.includes('restart required')).length, warnsAtDispose, 'the interval must be cleared by the disposer')

  await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

test('installBundlePatchWatchdog: opt-out and no-profile disable are silent no-ops', async () => {
  const home = tmp()
  const profileDir = join(home, 'profiles', 'r3-off')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@scope/probe-pkg'] } } }))
  const patchPath = makeBundle(profileDir, '@scope/probe-pkg')
  utimesSync(patchPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000))

  // --profile with org.bundlePatchCheck === false: nothing armed, nothing logged.
  {
    const ctx = new Context()
    const logs = []
    ctx.logger.exporter({ levels: { default: 5 }, export: message => logs.push(`${message.type}: ${String(message.args[0])}`) })
    installBundlePatchWatchdog(ctx, { stateDir: tmp(), org: { bundlePatchCheck: false } },
      { argv: ['node', 'dsh', '--profile', 'r3-off'], home })
    utimesSync(patchPath, new Date(1_700_000_200_000), new Date(1_700_000_200_000))
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(logs.filter(l => l.includes('restart required')).length, 0)
    await ctx.fiber.dispose()
  }

  // No --profile: ONE warn explaining the disable, then silence.
  {
    const ctx = new Context()
    const logs = []
    ctx.logger.exporter({ levels: { default: 5 }, export: message => logs.push(`${message.type}: ${String(message.args[0])}`) })
    installBundlePatchWatchdog(ctx, { stateDir: tmp(), org: { bundlePatchCheckIntervalMs: 20 } },
      { argv: ['node', 'dsh', '--port', '3090'], home })
    const disables = logs.filter(l => l.includes('R3 bundle-layer patch watchdog: no --profile flag'))
    assert.equal(disables.length, 1)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(logs.filter(l => l.includes('restart required')).length, 0)
    assert.equal(logs.filter(l => l.includes('R3 bundle-layer patch watchdog: no --profile flag')).length, 1, 'the disable warn fires ONCE')
    await ctx.fiber.dispose()
  }

  rmSync(home, { recursive: true, force: true })
})

test('defaults: the interval constant is 60 s and a stale default install does not throw', () => {
  assert.equal(BUNDLE_PATCH_CHECK_INTERVAL_MS, 60_000)
  // A minimal config (no org) installs with the code defaults and disposes.
  const ctx = new Context()
  const disposer = installBundlePatchWatchdog(ctx, { stateDir: tmp() }, { argv: ['node', 'dsh', '--profile', 'missing-profile'], home: tmp() })
  assert.equal(typeof disposer, 'function')
  disposer()
  void ctx.fiber.dispose()
})