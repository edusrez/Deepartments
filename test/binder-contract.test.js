// dsh-deepartments — binder-contract LOCK test (LANE DI-BY-SERVICES — the
// binder is DEAD: this lock was the FASE-2.6 register-bucket contract and is
// now the ABSENCE + deps-holders contract). Freezes what the DI-by-services
// lane replaced:
//
// TODAY (post-LANE-DI-BY-SERVICES) the bundle registers NOTHING into a binder
// (MutableBinder / deepartments.binder / BinderDeps are GONE — grep-verified
// 0 hits) — the closure sets flow into the deps HOLDERS:
//   - the 5 BASELINE sets → deepartments.lifecycleDeps / wakepackDeps /
//     busDeps / deliverDeps (provided by dshd-core, filled by the bundle),
//   - the 4 ZONE holders (healthDeps / jobsDeps / poolerDeps / guiDeps) stay
//     as they were (LANE 0.2.1 — the P1 services' primary path).
// This lock freezes the ABSENCE (no binder register may ever return) + the
// HOLDER-FILL contract (the bundle's holder fills carry the closure fields the
// consumers read):
//   - the bundle's tools factory contains NO `binder?.register` and NO
//     `ctx.get('deepartments.binder')`,
//   - each package declares the exact deps it consumes (frozen field-name
//     lists from the package sources),
//   - the INVARIANT check is FORWARD-looking: the bundle holder fills may only
//     carry fields that the consuming consumer's interface declares.
// The test reads STATIC SOURCES (the bundle's tools.ts fills + the package
// index.ts sources) — hermetic, no boot.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

// --- the FROZEN post-DI-by-services contract ----------------------------------
// The 4 baseline deps holders + the fields the dshd-core lazy shells consume.
const BASELINE_HOLDERS = {
  lifecycleDeps: ['ensureHost', 'writeJournal', 'readJournal', 'bumpHostSleepCounter', 'bumpPostSleepCounter', 'archivePostSessionOnSleep', 'disposeHeadHandleOnce', 'maybeEmitQualityInspectDirective', 'enqueueHostWake'],
  wakepackDeps: ['refreshPresence', 'wakePackInjected', 'deferredSleepReplace', 'roleForSession', 'buildSubagentOrientation', 'computeHostSleepSurfacePlan', 'assembleHeartbeat', 'readPresenceStateFile', 'messagesStoreReady', 'repoRoot'],
  busDeps: ['redeliver'],
  deliverDeps: ['resolveChild', 'deliverChild', 'resolveCatalogRoute', 'busProfileFor', 'deliverPost', 'deliverHost']
}
// The 4 zone holders PASO 1 fills, and the EXACT field names each package's
// binder-dep interface declares for its bucket (the contract the fill serves).
const ZONE_HOLDERS = ['health', 'jobs', 'pooler', 'gui']
const ZONE_BUCKET_CONTRACTS = {
  gui: ['endpointDeps'],
  jobs: ['runJob', 'notifyHead', 'departmentForEntry', 'departmentForJob', 'onAutoRunSkip', 'captureAutoRunFailure', 'repoRoot'],
  health: ['bootId', 'config', 'posts', 'hostWaits', 'sessionContexts', 'hostRunning', 'missionActivity', 'mainRed', 'missionQueue', 'notifyHost', 'poolerStatePath', 'workRegisterPath', 'qiDirectiveRate'],
  pooler: ['configuredProviders', 'appendPostError']
}

/** Extract the holder-register call blocks of the bundle's tools factory:
 * returns [{ holder, body }] for each `depsX?.register({...})` fill. */
function extractHolderFills(sourcePath) {
  const src = readFileSync(sourcePath, 'utf8')
  const out = []
  const re = /(deps(Bus|Deliver|Lifecycle|Wakepack|Health|Jobs|Pooler|Gui))\?\.register\(\{/g
  let match
  while ((match = re.exec(src)) !== null) {
    const holder = match[2]
    const start = match.index + match[0].length - 1 // the register call's open brace
    let depth = 1
    let i = start + 1 // skip the register's OWN open brace (already counted)
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) break
      }
    }
    out.push({ holder, body: src.slice(start + 1, i) })
  }
  return out
}

/** Extract the property names of ONE `export interface <Name>BinderDeps {...}`
 * from a package source file. Returns them in declaration order. */
function extractBinderDepsFields(sourcePath, name) {
  const src = readFileSync(sourcePath, 'utf8')
  const marker = `export interface ${name} {`
  const start = src.indexOf(marker)
  assert.ok(start !== -1, `${name} declared in ${sourcePath}`)
  const bodyStart = start + marker.length
  // Braces at 2-space indent (the interface body); scan to the closing brace.
  // depth starts at 1: the interface's OWN open brace is the marker's last char.
  let depth = 1
  let i = bodyStart
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  const body = src.slice(bodyStart, i)
  const fields = []
  for (const line of body.split('\n')) {
    const m = /^ {2}([A-Za-z_$][\w$]*)(\?)?:/.exec(line)
    if (m !== null) fields.push(m[1])
  }
  return fields
}

test('binder-contract: the binder register is ABSENT from the bundle tools factory (0 register — MutableBinder/deepartments.binder/BinderDeps are dead)', () => {
  const factory = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts'), 'utf8')
  assert.ok(!/binder\?\.register\(/.test(factory), 'no binder?.register( in the factory (the register DIED — LANE DI-BY-SERVICES)')
  assert.ok(!/ctx\.get\('deepartments\.binder'\)/.test(factory), 'no ctx.get("deepartments.binder") in the factory (the seam is gone)')
  const core = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-core', 'src', 'index.ts'), 'utf8')
  assert.ok(!/MutableBinder/.test(core), 'MutableBinder is gone from dshd-core')
  assert.ok(!/deepartments\.binder/.test(core), 'the deepartments.binder provide is gone from dshd-core')
})

test('binder-contract: the tools factory FILLS the 4 BASELINE deps holders with the closure fields the dshd-core lazy shells read (the DI-by-services register replacement)', () => {
  const factory = path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts')
  const fills = extractHolderFills(factory)
  const holderName = (holder) => `deepartments.${holder === 'Bus' ? 'bus' : holder === 'Deliver' ? 'deliver' : holder === 'Lifecycle' ? 'lifecycle' : 'wakepack'}Deps`
  for (const holder of Object.keys(BASELINE_HOLDERS)) {
    const key = holder === 'lifecycleDeps' ? 'Lifecycle' : holder === 'wakepackDeps' ? 'Wakepack' : holder === 'busDeps' ? 'Bus' : 'Deliver'
    const fill = fills.find((f) => f.holder === key)
    assert.ok(fill !== undefined, `the ${holderName(key)} holder has a register fill in the factory`)
    for (const field of BASELINE_HOLDERS[holder]) {
      assert.ok(new RegExp(`\\b${field}\\b`).test(fill.body), `${holderName(key)} carries the ${field} field (the dshd-core lazy shell reads it)`)
    }
  }
})

test('binder-contract: the 4 P1 packages declare exactly the frozen holder contracts (the zone fills must serve them)', () => {
  const sources = {
    gui: path.join(REPO_ROOT, 'packages', 'dshd-gui', 'src', 'index.ts'),
    jobs: path.join(REPO_ROOT, 'packages', 'dshd-jobs', 'src', 'index.ts'),
    health: path.join(REPO_ROOT, 'packages', 'dshd-health', 'src', 'index.ts'),
    pooler: path.join(REPO_ROOT, 'packages', 'dshd-pooler', 'src', 'index.ts')
  }
  const iface = {
    gui: 'GuiBinderDeps',
    jobs: 'JobsBinderDeps',
    health: 'HealthBinderDeps',
    pooler: 'PoolerBinderDeps'
  }
  for (const zone of ZONE_HOLDERS) {
    const fields = extractBinderDepsFields(sources[zone], iface[zone])
    assert.deepEqual(fields, ZONE_BUCKET_CONTRACTS[zone], `${zone} holder contract frozen (${iface[zone]} field list)`)
  }
})

test('binder-contract: IF a zone holder is filled, it carries ONLY fields the package interface declares (the fill never augments the contract)', () => {
  const factory = path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts')
  const fills = extractHolderFills(factory)
  const sources = {
    gui: path.join(REPO_ROOT, 'packages', 'dshd-gui', 'src', 'index.ts'),
    jobs: path.join(REPO_ROOT, 'packages', 'dshd-jobs', 'src', 'index.ts'),
    health: path.join(REPO_ROOT, 'packages', 'dshd-health', 'src', 'index.ts'),
    pooler: path.join(REPO_ROOT, 'packages', 'dshd-pooler', 'src', 'index.ts')
  }
  const iface = {
    gui: 'GuiBinderDeps',
    jobs: 'JobsBinderDeps',
    health: 'HealthBinderDeps',
    pooler: 'PoolerBinderDeps'
  }
  const zoneToHolder = { gui: 'Gui', jobs: 'Jobs', health: 'Health', pooler: 'Pooler' }
  for (const zone of ZONE_HOLDERS) {
    const declared = extractBinderDepsFields(sources[zone], iface[zone])
    const fill = fills.find((f) => f.holder === zoneToHolder[zone])
    if (fill === undefined) {
      // Not filled (the pooler 1C case — intentionally unfilled) — vacuous.
      continue
    }
    const fields = []
    // Strip COMMENT lines first — the fill bodies carry explanatory //-lines
    // whose identifiers are NOT keys. Then capture only TOP-LEVEL keys: lines
    // indented exactly at the object-literal level (4 spaces) that carry a
    // `key:` (multi-line `    key: value`) or a bare shorthand identifier
    // (`    key,`). Nested arrow-function parameters (e.g. `(finding: ...)`)
    // and deeper indentations are NOT keys.
    const codeBody = fill.body.split('\n').filter((l) => !/^\s*\/\//.test(l))
    for (const line of codeBody) {
      const m = /^ {4}([A-Za-z_$][\w$]*)\s*:/.exec(line)
      const m2 = /^ {4}([A-Za-z_$][\w$]*),?\s*$/.exec(line)
      const key = m ? m[1] : m2 ? m2[1] : undefined
      if (key !== undefined && !fields.includes(key)) fields.push(key)
    }
    for (const field of fields) {
      assert.ok(declared.includes(field), `filled "${zone}.${field}" is declared by the ${iface[zone]} interface (the fill must serve the contract)`)
    }
  }
})