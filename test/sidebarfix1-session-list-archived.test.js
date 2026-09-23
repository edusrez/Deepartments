// sidebarfix1 — RED→GREEN evidence for the session.list sidebar fix.
//
// WHAT IS UNDER TEST (declared — fb-512): the REAL
// `@deepseek-ai/dsh-api-session-controller/lib/index.js` of the DECLARED CONTROL
// tree, plus the tracked patch. Both arms are built in a TEMP dir at test time:
//   pristine = the CONTROL tree's file, byte-for-byte
//   patched  = the same bytes with `patches/dsh-api-session-controller-list-archived.patch`
//              applied by `patch -p1` (the SAME patch file that is the deliverable)
// so this file is SELF-CONTAINED: it depends on no scratch artifact, and a green
// here means the TRACKED PATCH is what produces the behaviour — if the patch
// stops applying, the lane fails loudly instead of silently testing a stale copy.
//
// THE TWO TREES ARE INDEPENDENT (oracle repair, sidebarfix1). Seeding the
// pristine arm from the SERVED tree was the defect: on a POST deployment the
// "pristine" copy WAS the already-patched file, so `patch` reported "previously
// applied" and the lane went RED BY DEFAULT — an oracle deriving its control
// from the artifact under test. The pristine arm is therefore built from the
// DECLARED CONTROL tree only; the served tree remains the RESOLUTION ROOT (the
// runtime the arms' bare imports resolve against) and is presence-checked.
//
// The unit driven is `ApiSessionList` — the class whose `list()` the RPC calls
// (`SessionController.list()` → `this.listState.list(signal)`,
// lib/index.js:2826/2790). Its module-level export is not part of the shipped
// bundle, so the loader appends ONE `export { ApiSessionList }` line; that seam
// is applied IDENTICALLY to both arms, in memory only, and cannot decide which
// arm passes.
//
// THE DISCRIMINATOR: the fix (a) drops registry-archived rows BEFORE the
// per-item projection work and (b) reuses one corpus listing across a refresh
// burst (TTL). The arms therefore differ on numbers that only the fix moves:
// items returned, per-item projection reads, and listings taken per burst.
// Reverting the fix flips them — so a green cannot come from the unchanged path.
//
// ORACLE DECLARATION: everything asserted comes from those two harness files.
// No build step is involved, and nothing is claimed about the repo's own `src/`.
import { register } from 'node:module'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

register(new URL('./sidebarfix1-tree-loader.mjs', import.meta.url), { parentURL: import.meta.url })

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const CONTROL_TREE = process.env.DSH_CONTROL_TREE || '/opt/dsh/trees/control-0.1.5-rc.2-pristine'
const TREE = process.env.DSH_DEV_TREE || '/opt/dsh/trees/deepartments-dev-0.1.5-rc.2'
const REL = path.join('node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'lib', 'index.js')
const TREE_CONTROLLER = path.join(TREE, REL)
const CONTROL_CONTROLLER = path.join(CONTROL_TREE, REL)
const PATCH = path.join(REPO_ROOT, 'patches', 'dsh-api-session-controller-list-archived.patch')

// The subject is the DECLARED CONTROL artifact plus the tracked patch; the
// SERVED tree supplies the runtime the arms resolve against. Where either
// controller, or the patch, is absent there is no subject, so the lane SKIPS
// loudly, naming EVERY missing piece, rather than reporting a red that is really
// an absent subject — or a green measured over nothing.
const missing = []
if (!fs.existsSync(CONTROL_CONTROLLER)) missing.push(`control controller ${CONTROL_CONTROLLER}`)
if (!fs.existsSync(TREE_CONTROLLER)) missing.push(`served controller ${TREE_CONTROLLER}`)
if (!fs.existsSync(PATCH)) missing.push(`tracked patch ${PATCH}`)
const hasSubject = missing.length === 0
if (!hasSubject) console.error(`# sidebarfix1: SKIPPING - missing subject(s): ${missing.join('; ')}`)

// ── build both arms in a temp dir ───────────────────────────────────────────
let ARMS
if (hasSubject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebarfix1-arms-'))
  const pristinePath = path.join(dir, 'pristine', REL)
  const patchedPath = path.join(dir, 'patched', REL)
  for (const p of [pristinePath, patchedPath]) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // BOTH arms come from the CONTROL tree — never from the served artifact,
    // which may already carry the patch.
    fs.writeFileSync(p, fs.readFileSync(CONTROL_CONTROLLER))
  }
  // The patched arm IS the tracked patch: apply it for real (no --dry-run), so a
  // patch that no longer applies to the PRISTINE control file fails this lane.
  execFileSync('patch', ['-p1', '-s', '-i', PATCH], { cwd: path.join(dir, 'patched') })
  assert.notEqual(
    fs.readFileSync(patchedPath, 'utf8'), fs.readFileSync(pristinePath, 'utf8'),
    'the tracked patch changed nothing — it no longer describes the control artifact',
  )
  ARMS = { dir, pristine: pristinePath, patched: patchedPath }
}

/** Import one arm's ApiSessionList (see the loader's export seam). */
async function loadArm(arm) {
  const url = pathToFileURL(ARMS[arm]).href
  const mod = await import(url)
  return mod.ApiSessionList
}

const treeRequire = createRequire(path.join(TREE, 'node_modules', 'noop.js'))
let Context
if (hasSubject) Context = (await import(pathToFileURL(treeRequire.resolve('@deepseek-ai/cordis')).href)).Context

const ARCHIVED = 3_000
const VISIBLE = 12

/** One synthetic corpus record shaped like `sessionQuery.listSessions()` returns.
 * `cwd` is taken from `options` so an explicit `undefined` is expressible (a
 * default parameter would swallow it — measured the hard way). */
function record(id, options = {}) {
  const cwd = 'cwd' in options ? options.cwd : '/root/.deepartments'
  return {
    header: { id, ...(cwd === undefined ? {} : { cwd }), createdAt: 1_700_000_000_000, seq: 5 },
    live: false,
    persisted: true,
  }
}

/**
 * A cordis Context carrying exactly the services `ApiSessionList` touches, with
 * counters on the per-item projection read — the cost this fix removes.
 *
 * @param options - `archivedIds` is the registry archive set; `registry`
 *   overrides the accessor (the throwing-fallback arm); `listSessions`
 *   overrides the corpus read (the burst/slow arms); `sessions`/`agents` back
 *   the live-session path.
 */
function makeHarness({ archivedIds, registry, listSessions, sessions, agents } = {}) {
  const ctx = new Context()
  const counters = { projectionReads: 0, projectionIds: [], warns: [] }

  const records = []
  for (let i = 0; i < ARCHIVED; i += 1) records.push(record(`archived-${i}`))
  for (let i = 0; i < VISIBLE; i += 1) records.push(record(`visible-${i}`))

  ctx.logger.exporter({
    levels: { default: 5 },
    export: (message) => { if (message.type === 'warn') counters.warns.push(String(message.args[0] ?? '')) },
  })

  // `summaryFor(session)` derives `running` from ctx.agents, NOT from the listing.
  ctx.provide('agents', agents ?? { get: () => undefined })
  ctx.provide('sessions', sessions ?? { get: () => undefined, list: () => [] })
  ctx.provide('sessionQuery', {
    listSessions: listSessions ?? (async () => records.map((r) => ({ ...r, header: { ...r.header } }))),
  })
  ctx.provide('workspaceRegistry', registry ?? {
    archivedSessionIds: archivedIds,
    list: () => [],
    get: () => undefined,
  })
  ctx.provide('sessionProjections', {
    register: () => {},
    // One call here == one per-item projection read. The listing path reaches
    // projections through `projectionsFor(header, undefined)` →
    // `sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0))`, i.e.
    // the CACHE service below; the registry's own cachedSnapshot serves a LIVE
    // session. Both are counted so the assertion holds on either path.
    cachedSnapshot: () => { counters.projectionReads += 1; counters.projectionIds.push('registry'); return undefined },
  })
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (header) => {
      counters.projectionReads += 1
      counters.projectionIds.push(header?.id)
      return { asOfSeq: 5, values: { sessionListMetadata: { blank: false, lastPromptAt: null } } }
    },
    cachedPredecessorTitle: () => undefined,
  })
  return { ctx, counters }
}

/** Run one arm's body only when the subject exists; otherwise SKIP. */
const withSubject = (name, fn) => test(name, { skip: hasSubject ? false : `missing subject(s): ${missing.join('; ')}` }, fn)

const allArchived = () => Array.from({ length: ARCHIVED }, (_, i) => `archived-${i}`)

// ── the RED arm: assertions that must FAIL on the unpatched file ────────────
withSubject('RED/GREEN: the PATCHED arm hides every archived row; the PRISTINE arm leaks all of them', async () => {
  const ApiSessionList = await loadArm('patched')
  const { ctx } = makeHarness({ archivedIds: allArchived() })
  const items = await new ApiSessionList(ctx).list(undefined)
  assert.equal(items.length, VISIBLE, `patched must return exactly the ${VISIBLE} renderable rows`)
  assert.equal(items.filter((i) => i.sessionId.startsWith('archived-')).length, 0, 'no archived row may be returned')
  await ctx.fiber.dispose()

  // And the same measurement on the unpatched file: the numbers the fix moves.
  const PristineList = await loadArm('pristine')
  const p = makeHarness({ archivedIds: allArchived() })
  const leaked = await new PristineList(p.ctx).list(undefined)
  assert.equal(leaked.length, ARCHIVED + VISIBLE,
    'the pristine arm must leak the whole corpus — if it does not, this lane is no longer discriminating')
  await p.ctx.fiber.dispose()
})

withSubject('RED/GREEN: the per-item projection read is never spent on an archived row once patched', async () => {
  const ApiSessionList = await loadArm('patched')
  const { ctx, counters } = makeHarness({ archivedIds: allArchived() })
  await new ApiSessionList(ctx).list(undefined)
  assert.equal(counters.projectionIds.filter((id) => String(id).startsWith('archived-')).length, 0,
    'no projection read may be spent on an archived row')
  assert.equal(counters.projectionReads, VISIBLE, `expected ${VISIBLE} projection reads, got ${counters.projectionReads}`)
  await ctx.fiber.dispose()

  const PristineList = await loadArm('pristine')
  const p = makeHarness({ archivedIds: allArchived() })
  await new PristineList(p.ctx).list(undefined)
  assert.ok(p.counters.projectionIds.filter((id) => String(id).startsWith('archived-')).length > 0,
    'the pristine arm must waste projection reads on archived rows — otherwise this is not the fix being measured')
  await p.ctx.fiber.dispose()
})

withSubject('PATCHED: an unavailable archive set degrades to the full corpus, loudly, instead of failing', async () => {
  const ApiSessionList = await loadArm('patched')
  const { ctx, counters } = makeHarness({
    registry: {
      get archivedSessionIds() { throw new Error('registry exploded') },
      list: () => [],
      get: () => undefined,
    },
  })
  const items = await new ApiSessionList(ctx).list(undefined)
  assert.equal(items.length, ARCHIVED + VISIBLE, 'a broken registry must fall back to listing everything, never fail the RPC')
  assert.ok(counters.warns.some((w) => w.includes('archive set unavailable')), 'the fallback must be LOUD (F4), not silent')
  await ctx.fiber.dispose()
})

withSubject('PATCHED: F4 — a slow listing warns instead of failing silently', async () => {
  const ApiSessionList = await loadArm('patched')
  const { ctx, counters } = makeHarness({
    archivedIds: [],
    listSessions: async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_100))
      return [record('visible-0')]
    },
  })
  await new ApiSessionList(ctx).list(undefined)
  assert.ok(
    counters.warns.some((w) => w.includes('slow listing took') && w.includes('renderable row(s)')),
    `expected one slow-listing warn naming the corpus size; got: ${JSON.stringify(counters.warns)}`,
  )
  await ctx.fiber.dispose()
})

withSubject('PATCHED: a refresh burst reuses one corpus listing (TTL), and never serves live state stale', async () => {
  // The header sweep is the remaining O(corpus) term and it is NOT free: measured
  // 1.9-3.1 s wall / 2.1-4.0 s CPU per listing over ~3,100 session directories.
  // The client re-polls in bursts (every reconnect, every rotation, on a 5 s
  // retry loop), so that cost recurred per burst. This asserts a burst collapses
  // onto ONE sweep — while LIVE state stays per-call.
  const ApiSessionList = await loadArm('patched')
  let listings = 0
  let running = false
  const { ctx } = makeHarness({
    archivedIds: [],
    listSessions: async () => { listings += 1; return [record('visible-0')] },
    sessions: {
      get: (id) => (id === 'visible-0' ? { id, header: record('visible-0').header, seq: 1 } : undefined),
      list: () => [],
    },
    agents: { get: (id) => (id === 'visible-0' ? { status: running ? 'running' : 'idle' } : undefined) },
  })
  const list = new ApiSessionList(ctx)
  const a = await list.list(undefined)
  running = true
  const b = await list.list(undefined)

  assert.equal(listings, 1, `a burst of 2 calls within the TTL must take ONE corpus listing; took ${listings}`)
  assert.equal(a[0]?.running, false, 'first call must report the live flag as of that call')
  assert.equal(b[0]?.running, true,
    'LIVE state (running) must be re-derived per call — a cached listing must never serve it stale')
  await ctx.fiber.dispose()
})

withSubject('CONTROL: rows with no cwd are still dropped exactly as before (both arms)', async () => {
  // Pre-existing behaviour (lib/index.js:1841 `if (record.header.cwd === void 0)
  // continue;`): a session with no cwd never reaches the list. Asserted on BOTH
  // arms so the fix is not credited for a rule it did not introduce.
  for (const arm of ['pristine', 'patched']) {
    const ApiSessionList = await loadArm(arm)
    const { ctx } = makeHarness({
      archivedIds: [],
      listSessions: async () => [record('no-cwd', { cwd: undefined }), record('has-cwd')],
    })
    const items = await new ApiSessionList(ctx).list(undefined)
    assert.deepEqual(items.map((i) => i.sessionId), ['has-cwd'], `${arm}: the cwd rule must be unchanged`)
    await ctx.fiber.dispose()
  }
})
