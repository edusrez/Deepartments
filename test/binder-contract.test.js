// dsh-deepartments — binder-contract LOCK test (HITO 3 DECOUPLING, PASO 1 —
// E2-parcial). Freezes the FASE 2.6 Binder bucket contracts the decoupling must
// fill WITHOUT breaking anything.
//
// TODAY (the pre-fill anchor, invoke.ts:8921-8959) the bundle registers ONLY:
//   { bus, deliver, wakepack, lifecycle, redeliver }
// and the four P1 plugin services (dshd-gui/dshd-jobs/dshd-health/dshd-pooler)
// read their own bucket from the binder ON USE (fail-loud R1 when absent):
//   - gui.endpointDeps   (DeepartmentsEndpointDeps — buildAgentRows +
//     pickLiveHostEntry + the live maps/hooks),
//   - jobs.{runJob, notifyHead, departmentForEntry, departmentForJob} required
//     + onAutoRunSkip/repoRoot optional,
//   - health.{bootId, config, posts, hostWaits, sessionContexts, hostRunning,
//     notifyHost, poolerStatePath, workRegisterPath, qiDirectiveRate} (all
//     optional per HealthBinderDeps — the tick degrades by scan),
//   - pooler.{configuredProviders, appendPostError} (optional; appendPostError
//     REQUIRED only when a finding materializes).
// This lock freezes the CONTRACT (what the packages consume) so the PASO 1
// bucket fill can never silently break a consumer:
//   - the bundle's register keeps the 5 baseline buckets (R6 — the anchor is a
//     SUBSET assertion: nothing existing is removed),
//   - each package declares the exact binder bucket fields it reads (frozen
//     field-name lists from the package sources),
//   - the INVARIANT check is FORWARD-looking: the bundle register may only
//     carry fields that the consuming package's binder-dep interface declares
//     (a field the package does not read would be dead — the fill must serve
//     the contract, never augment it).
// The test reads STATIC SOURCES (the bundle's invoke.ts register + the 4
// package index.ts sources) — hermetic, no boot.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

// --- the FROZEN pre-decoupling contract --------------------------------------
// The 5 baseline buckets the bundle registers today (the anchor — R6: they
// must NEVER disappear, whatever the decoupling adds).
const BASELINE_BUCKETS = ['bus', 'deliver', 'wakepack', 'lifecycle', 'redeliver']
// The 4 zone buckets PASO 1 fills, and the EXACT field names each package's
// binder-dep interface declares for its bucket (the contract the fill serves).
const ZONE_BUCKETS = ['health', 'jobs', 'pooler', 'gui']
const ZONE_BUCKET_CONTRACTS = {
  gui: ['endpointDeps'],
  jobs: ['runJob', 'notifyHead', 'departmentForEntry', 'departmentForJob', 'onAutoRunSkip', 'repoRoot'],
  // NOTE: posts/hostWaits/sessionContexts/hostRunning are OPTIONAL (absent →
  // the tick degrades); notifyHost has a composed fallback (wakepack +
  // deliver buckets, FASE 2.6-C). Frozen here = the fields the package SERVICE
  // reads from its bucket (see HealthBinderDeps + the apply's merge).
  health: ['bootId', 'config', 'posts', 'hostWaits', 'sessionContexts', 'hostRunning', 'notifyHost', 'poolerStatePath', 'workRegisterPath', 'qiDirectiveRate'],
  pooler: ['configuredProviders', 'appendPostError']
}
// The REQUIRED-at-use fields per zone bucket (a matching slack is the package's
// fail-loud path — the lock asserts the fill provides them so R1 never fires).
const REQUIRED_ZONE_FIELDS = {
  gui: ['endpointDeps'],
  jobs: ['runJob', 'notifyHead', 'departmentForEntry', 'departmentForJob'],
  health: [],   // all health bucket fields are optional (the tick degrades)
  pooler: []    // both optional; appendPostError required only on a finding
}

/** Extract the TOP-LEVEL bucket keys of the bundle's `binder?.register({...})`
 * call in src/invoke.ts (the FASE 2.6-C late-binding seam, :8921). Returns the
 * list of registered bucket names. */
function extractRegisterBucketKeys() {
  const src = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
  const marker = 'binder?.register({'
  const start = src.indexOf(marker)
  assert.ok(start !== -1, 'the bundle binder.register call exists in invoke.ts')
  // Brace-scan the object literal (it spans many lines; nested braces inside
  // the bucket objects are balanced by this scan). depth starts at 1: the
  // register call's OWN open brace is the last char of the marker.
  let depth = 1
  let i = start + marker.length
  const bodyStart = i
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  assert.ok(i < src.length, 'the register call object literal closes')
  const body = src.slice(bodyStart, i)
  // Top-level keys: each line of the form `    <key>: {` at the object's own
  // depth (4-space indented bucket declarations).
  const keys = []
  for (const line of body.split('\n')) {
    const m = /^ {4}([A-Za-z_$][\w$]*):\s*\{/.exec(line)
    if (m !== null) keys.push(m[1])
  }
  return keys
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

test('binder-contract: the bundle register keeps the 5 baseline buckets (R6 anchor — nothing existing is removed)', () => {
  const keys = extractRegisterBucketKeys()
  for (const bucket of BASELINE_BUCKETS) {
    assert.ok(keys.includes(bucket), `baseline bucket "${bucket}" still registered (found: ${keys.join(', ')})`)
  }
})

test('binder-contract: the 4 P1 packages declare exactly the frozen binder bucket contracts (the fill must serve them)', () => {
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
  for (const zone of ZONE_BUCKETS) {
    const fields = extractBinderDepsFields(sources[zone], iface[zone])
    assert.deepEqual(fields, ZONE_BUCKET_CONTRACTS[zone], `${zone} bucket contract frozen (${iface[zone]} field list)`)
  }
})

test('binder-contract: IF a zone bucket is registered, it carries ONLY fields the package interface declares (the fill never augments the contract)', () => {
  const keys = extractRegisterBucketKeys()
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
  for (const zone of ZONE_BUCKETS) {
    const declared = extractBinderDepsFields(sources[zone], iface[zone])
    // Read the register body for THIS bucket's fields (the register call uses a
    // single combined object today — the fields of a zone bucket are the
    // top-level keys nested under the bucket). The tokenizer extracts the
    // object literal once; bucket field lines are 8-space indented under it.
    const src = readFileSync(path.join(REPO_ROOT, 'src', 'invoke.ts'), 'utf8')
    const marker = 'binder?.register({'
    const start = src.indexOf(marker)
    let depth = 1
    let i = start + marker.length
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) break
      }
    }
    const body = src.slice(start + marker.length, i)
    // Find the `<zone>: { ... }` block inside the register and collect its keys.
    const zoneStart = body.indexOf(`    ${zone}: {`)
    if (zoneStart === -1) {
      // Not registered (the pre-fill state) — the invariant is vacuous.
      assert.ok(!keys.includes(zone), `zone bucket "${zone}" consistency`)
      continue
    }
    let zd = 1
    let j = zoneStart + `    ${zone}: {`.length
    for (; j < body.length; j++) {
      const ch = body[j]
      if (ch === '{') zd++
      else if (ch === '}') {
        zd--
        if (zd === 0) break
      }
    }
    const zoneBody = body.slice(zoneStart + `    ${zone}: {`.length, j)
    // Collect the PROPERTY KEYS inside the zone bucket object (both the
    // multi-line `\n      field: ...` form and the single-line inline
    // `{ field: value }` form): every identifier immediately before a `:` that
    // is not the bucket's own leftover prefix. The zone buckets are pure
    // object literals of closure refs — a valid identifier before `:` is a key.
    const fields = []
    for (const m of zoneBody.matchAll(/[A-Za-z_$][\w$]*\s*:/g)) {
      const candidate = m[0].trim().replace(/:\s*$/, '')
      if (!fields.includes(candidate)) fields.push(candidate)
    }
    for (const field of fields) {
      assert.ok(declared.includes(field), `registered "${zone}.${field}" is declared by the ${iface[zone]} interface (the fill must serve the contract)`)
    }
    // The REQUIRED-at-use fields must be present once the bucket is registered
    // (otherwise the package's fail-loud R1 fires at the first use).
    for (const required of REQUIRED_ZONE_FIELDS[zone]) {
      assert.ok(fields.includes(required), `zone bucket "${zone}" registers the required-at-use field "${required}"`)
    }
  }
})