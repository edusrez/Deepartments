// dsh-deepartments — fb-2432 (LANE A, host rotation): THE FALLBACK MUST LEAVE A
// DURABLE, NAMED TRACE.
//
// THE MEASURED DEFECT (2026-09-22, HEAD 804e87d, dev profile):
//   The host's `dept_sleep` ROTATION did NOT run — it always took the LEGACY
//   in-place reset. The durable fingerprint was there (`hosts.json` live entry
//   with `webUiCleanupPending: true` and `boundarySeq: 7540`, against 275974 /
//   346497 / 448753 on the three preceding successful retirements), but the
//   REASON was nowhere: `grep "ROTATION could not run"` over journald returned 0
//   rows AND over the session transcript returned 0 rows.
//
//   WHY THE EMPTY GREP WAS EXPECTED, NOT EVIDENCE OF HEALTH — the double root
//   cause this test locks down:
//     (1) The literal is emitted through `ctx.logger.error`, and that logger is
//         the cordis EXPORTER logger: "never reaches stdout; journald only sees
//         raw stdout" (src/index.ts:32-34). The process DID reach journald (947
//         `[deepartments]` lines from the same pid) — but ONLY the 2 lines that
//         go through `console.log`. So there was NO durable sink for the reason
//         at all: it was computed and DISCARDED.
//     (2) The session transcript was never a candidate sink: the fallback's
//         in-place reset APPENDS to the surface and defers the fold, so the
//         sleep-turn log carries the journal, never the fallback's reason.
//   => Criterion (i): the `reason` `runHostRotation` ALREADY computes must land
//   in a durable, greppable sink. It now does, through the registry layer's
//   EXISTING append-only state channel the consumers already read
//   (`<stateDir>/registry-anomalies.jsonl`, the same file/kind taxonomy as
//   REGISTRY_ANOMALY.MUTE_HOST_SENDER) — ZERO new exports, ZERO new knobs.
//
// THE TEST THAT FAILS WITH THE OLD CODE AND PASSES WITH THE CHANGE:
//   It drives a REAL Loader + the REAL bundle through a REAL host-plane
//   `dept_sleep` whose rotation is FORCED to fail (the persistence seam's
//   `create` rejects — the exact S2 "session create failed" path the live
//   incident took), then asserts the durable row exists WITH THE VERBATIM
//   REASON. Pre-change, `registry-anomalies.jsonl` is never created at all
//   (measured: the emission did not exist), so the assertion fails on a missing
//   file — which is the honest red.
//
// Rule 5 (AGENTS.md): tests go through the REAL Cordis Loader with the REAL
// dsh services. Temp stateDirs, no network, no live DSH_HOME, no LLM. Tests run
// against the compiled lib (pnpm build first — same discipline as
// session-cleanup.test.js, whose harness shape this file mirrors).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { readRegistryAnomalyRows, REGISTRY_ANOMALY, REGISTRY_ANOMALIES_FILE } from '../lib/core/registry.js'

const HOST_SESSION = 'session-rotationtrace-0000-0000-000000000000'
const HOST_ID = `host-${HOST_SESSION}`

const TEST_ORG = {
  departments: [
    {
      id: 'research',
      name: 'Research',
      coordinator: {
        postId: 'research-head',
        role: 'Research department head',
        provider: 'deepseek-official',
        agentOptions: { provider: 'stub-coord', model: 'deepseek-v4-flash' }
      }
    }
  ]
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-rotation-trace-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

/** Stub session persistence whose `create` REJECTS — the S2 path the live
 * incident took (S1.5b re-key succeeds, so the re-keyed journal exists on disk,
 * exactly as measured in `/.deepartments/journals/`). `root` is what resolves
 * `sessionsRoot`. */
class StubPersistenceWithRoot {
  constructor(ctx, root) {
    this.ctx = ctx
    this.root = root ?? undefined
    this.created = []
  }

  async create(meta) {
    this.created.push(meta)
    throw new Error('injected session-create failure (the S2 refusal the live incident took)')
  }

  async list() { return [] }
}

/** Boot the REAL Loader + the bundle with the stub persistence (mirrors
 * session-cleanup.test.js's bootPlugin shape). */
async function bootPlugin(stateDir, { persistenceRoot } = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  await root.plugin(StubPersistenceWithRoot, persistenceRoot)
  loader.create({
    id: 'deepartments',
    name: '../lib/index.js',
    config: { stateDir, org: TEST_ORG }
  })
  await loader.await()
  return { root, dispose: () => loaderFiber.dispose() }
}

async function seedHostJournal(stateDir) {
  const journalPath = path.join(stateDir, 'journals', `${HOST_ID}.md`)
  await mkdir(path.dirname(journalPath), { recursive: true })
  await writeFile(journalPath, [
    '---',
    `author: ${HOST_ID}`,
    `timestamp: ${new Date().toISOString()}`,
    'wake_counter: 1',
    'board_cursor: none',
    'decisions: []',
    'constraints: []',
    'open_items: []',
    '---',
    '',
    'HOST-ROTATION-TRACE fixture journal.',
    ''
  ].join('\n'), 'utf8')
  return journalPath
}

/** A REAL dsh Session (detached) so the host branch's fallback append runs. */
async function buildHostAgent() {
  const { Session, SessionId } = await import('@deepseek-ai/dsh-session')
  const session = Session.create(SessionId(HOST_SESSION), [
    { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } }
  ], { version: 0, id: HOST_SESSION, createdAt: 1787000000000, cwd: '/root', delegationDepth: 0, isSeeded: false })
  return {
    id: HOST_SESSION,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    status: 'idle',
    session,
    followup() {}, steer() {}, inject() {}, send() {}, cancel() {},
    whenIdle() { return new Promise(() => {}) }
  }
}

test('fb-2432 (i): a host dept_sleep whose ROTATION cannot run leaves a DURABLE, NAMED trace — `registry-anomalies.jsonl` carries the fallback kind WITH the verbatim reason (pre-change: the file is never created, because the reason went only to the exporter logger that never reaches stdout/journald)', async () => {
  await withTempStateDir(async (stateDir) => {
    await seedHostJournal(stateDir)
    const sessionsRoot = path.join(stateDir, 'sessions')
    const { root, dispose } = await bootPlugin(stateDir, { persistenceRoot: sessionsRoot })
    try {
      const host = await buildHostAgent()
      const signal = new AbortController().signal
      let concluded = false
      const result = await root.tools.get('dept_sleep').execute({}, {
        agent: host,
        signal,
        concludeTurn: () => { concluded = true }
      })
      assert.equal(result.member, HOST_ID, 'dept_sleep completed on the fallback path (the sleep itself is never blocked)')
      assert.equal(concluded, true, 'the fallback concluded the turn')

      // ---- CRITERION (i): THE DURABLE, GREPPABLE TRACE ----------------------
      // The row lands SYNCHRONOUSLY (appendFileSync), so no waitFor is needed —
      // and that is deliberate: the trace must not be racy with the sleep.
      const rowsPath = path.join(stateDir, REGISTRY_ANOMALIES_FILE)
      await stat(rowsPath) // PRE-CHANGE: ENOENT — there was no durable sink at all
      const rows = readRegistryAnomalyRows(stateDir)
        .filter((row) => row.kind === REGISTRY_ANOMALY.HOST_ROTATION_FALLBACK)
      assert.equal(rows.length, 1, 'EXACTLY ONE fallback row for ONE fallback event (dedupe-free by design: a fallback IS the event)')
      const row = rows[0]
      assert.equal(row.memberId, HOST_ID, 'the row names the host whose rotation refused')
      assert.equal(typeof row.ts, 'number', 'the row is dated (a fallback with no date cannot be ordered against its side effects)')
      // THE DISCRIMINANT: the VERBATIM `reason` of whichever of the five
      // refusal paths (`session-rotation.ts` S1.5b re-key / re-keyed write /
      // S2 seam / S2 create-append / S2.2 workspace attach) returned
      // `{rotated:false}`. Asserted by SHAPE-FROM-THE-SOURCE, not by a copied
      // literal — the point of the row is that the string is nameable, so the
      // test pins the contract (a non-empty reason of one of the five known
      // families) rather than one deployment's current cause.
      assert.equal(typeof row.reason, 'string', 'the reason is a string')
      assert.ok(row.reason.trim() !== '', 'the reason is NON-EMPTY — an empty reason would be the pre-change defect in a new suit')
      const KNOWN_FAMILIES = [
        /journal re-key failed/,
        /re-keyed journal write failed/,
        /persistence seam unavailable/,
        /session create failed/,
        /workspace attach failed/
      ]
      assert.ok(
        KNOWN_FAMILIES.some((re) => re.test(row.reason)),
        `the reason names ONE of the five refusal paths (measured: ${JSON.stringify(row.reason)}) — this is the whole point of criterion (i): \`grep host-rotation-fallback\` now names WHICH one fired`
      )

      // The row is also GREPPABLE as one JSON line on disk (the raw form the
      // host greps), not merely via the reader helper.
      const raw = await readFile(rowsPath, 'utf8')
      const line = raw.split('\n').find((l) => l.includes(REGISTRY_ANOMALY.HOST_ROTATION_FALLBACK))
      assert.ok(line, 'the row is one greppable line in the append-only file')
      assert.match(line, /"kind":"host-rotation-fallback"/, 'the kind is a stable literal in the raw line')
    } finally {
      await dispose()
    }
  })
})

test('fb-2432 (i): THE DISCRIMINANT DISCRIMINATES — a DIFFERENT refusing path writes a DIFFERENT verbatim reason through the SAME row kind (the trace names WHICH of the five candidates fired, it is not hardcoded to one cause)', async () => {
  await withTempStateDir(async (stateDir) => {
    await seedHostJournal(stateDir)
    const sessionsRoot = path.join(stateDir, 'sessions')
    // A WORKING sessionPersistence (registered as the REAL service id, so
    // `ctx.deptGet('sessionPersistence')` resolves): the rotation now gets PAST
    // S1.5b AND past S2 (the seed handle completes), and refuses LATER — at
    // S2.2, because this harness registers no `workspaceRegistry` entity to
    // attach to. Same lifecycle branch, same row kind, DIFFERENT reason.
    // POST-MIGRATION (v2→v3, 2026-09-21) HANDLE shape: `create(header)` returns
    // the owned write handle (the SERVICE exposes no `append(id, events)`).
    class WorkingPersistence extends Service {
      constructor(ctx) {
        super(ctx, 'sessionPersistence')
        this.root = sessionsRoot
        this.created = []
      }
      async create(meta) {
        this.created.push(meta)
        return { append: async () => {}, flush: async () => {}, close: async () => {} }
      }
      async list() { return [] }
    }
    const root = new Context()
    const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
    const loader = root.loader
    loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
    loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
    loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
    loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
    const persistence = new WorkingPersistence(root)
    loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org: TEST_ORG } })
    await loader.await()
    try {
      const host = await buildHostAgent()
      await root.tools.get('dept_sleep').execute({}, {
        agent: host,
        signal: new AbortController().signal,
        concludeTurn: () => {}
      })
      const rows = readRegistryAnomalyRows(stateDir)
        .filter((row) => row.kind === REGISTRY_ANOMALY.HOST_ROTATION_FALLBACK)
      assert.equal(rows.length, 1, 'still EXACTLY ONE row (one fallback event)')
      // The seam resolved and the seed was created, so S2 PASSED — and the
      // reason must therefore be a DIFFERENT one from the previous test. This
      // is the property that makes `grep` able to NAME the candidate.
      assert.ok(persistence.created.length >= 1, 'S2 really ran (the seam resolved and create() was reached) — otherwise this test proves nothing')
      assert.doesNotMatch(rows[0].reason, /persistence seam unavailable/, 'the reason is NOT the S2-seam refusal (the seam was available here)')
      assert.match(rows[0].reason, /workspace attach failed/, `measured: ${JSON.stringify(rows[0].reason)}`)
    } finally {
      await loaderFiber.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// fb-2432 (i) SECOND HALF — THE CHANNEL ITSELF: `ctx.logger.error` must be
// reachable by the SAME `grep` on the service journal that today returns ZERO.
//
// THE MEASURED DEFECT (2026-09-22, HEAD 846cf40, dev profile): the ONLY default
// exporter on `ctx.logger` is cordis's in-memory RING BUFFER (a GUI-console
// feed, `bufferSize = 1e3`) — NOT stdout. So every `ctx.logger.*` line was
// unreachable from journald, and `console.log` was the only thing that ever
// appeared. Proven empirically: with no exporter, `ctx.logger.error(…)` emits
// zero bytes while `console.log` appears.
//
// THE REAL CASE THIS PINS (the host's two-half control, measured by the IPH):
//   * POSITIVE half (the backstop RAN): an `fb-946 mute-host-sender` row exists
//     in `/.deepartments/registry-anomalies.jsonl` with a real timestamp.
//   * NEGATIVE half (the WARNING did not surface): `grep "HOST MUTE ANOMALY"`
//     over journald returns ZERO.
//   i.e. a backstop whose entire job is to warn that a HOST IS MUTE was
//   warning over a MUTE CHANNEL.
//
// This test drives the REAL bundle and asserts the two halves TOGETHER: the
// `error` line reaches stdout AND `warn`/`info` do NOT (no flood). It fails
// pre-change because nothing was ever exported.
test('fb-2432 (i): the bundle\'s `ctx.logger.error` IS reachable on the service journal (the channel the fallback diagnosis needs), while `warn`/`info` stay filtered — measured against the REAL bundle through stdout, the only stream journald sees', async () => {
  await withTempStateDir(async (stateDir) => {
    // Capture stdout exactly as journald would receive it.
    const captured = []
    const realLog = console.log
    console.log = (...args) => { captured.push(args.join(' ')); }
    let root
    let dispose
    try {
      ({ root, dispose } = await bootPlugin(stateDir, { persistenceRoot: path.join(stateDir, 'sessions') }))
      // The bundle is mounted: its export path must be live for the REAL
      // `ctx.logger` of this composition.
      root.logger.error('[deepartments] PROBE-ERROR-must-be-visible-in-journald')
      root.logger.warn('[deepartments] PROBE-WARN-must-NOT-flood-stdout')
      root.logger.info('[deepartments] PROBE-INFO-must-NOT-flood-stdout')
    } finally {
      console.log = realLog
      if (dispose !== undefined) await dispose()
    }

    const isErrorVisible = captured.some((line) => line.includes('PROBE-ERROR-must-be-visible-in-journald'))
    const isWarnVisible = captured.some((line) => line.includes('PROBE-WARN-must-NOT-flood-stdout'))
    const isInfoVisible = captured.some((line) => line.includes('PROBE-INFO-must-NOT-flood-stdout'))

    // THE CRITERION: the `error` line is greppable in the journal.
    assert.equal(isErrorVisible, true, `the ctx.logger.error line reached stdout (journald's only stream) — captured=${JSON.stringify(captured)}`)
    // THE GUARD: no flood (181 of the bundle's 236 ctx.logger sites are `warn`).
    assert.equal(isWarnVisible, false, 'warn is FILTERED OUT of the exporter (no stdout flood)')
    assert.equal(isInfoVisible, false, 'info is FILTERED OUT of the exporter (no stdout flood)')
  })
})
