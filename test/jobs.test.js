// dsh-deepartments — dshd-jobs package unit tests (the dshd-jobs phase: the pure
// agenda/jobs engine extracted to packages/dshd-jobs which the bundle consumes
// via the drop-in bridge src/core/jobs.ts / src/jobs.ts → lib/jobs.js).
//
// The engine is a standalone pure fs module (NO cordis services), so these are
// HERMETIC unit tests against the compiled lib/jobs.js (the bridge re-export of
// dshd-jobs) — the same direct-test shape as test/feedback.test.js which tests
// the dshd-feedback package. temp stateDirs + jobDirs, no network, no live
// DSH_HOME. (pnpm build first.)
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  CRON_DESYNC_WINDOW_MIN,
  CLASS_OUTAGE_REASON_RE,
  JOB_BACKFILL_OFFSETS_MIN,
  JOB_BACKFILL_MAX_ATTEMPTS,
  cronAll,
  cronFieldParse,
  cronIsDue,
  cronMatches,
  collectClassOutageCandidate,
  isClassOutageReason,
  isJobDispatchBlockReason,
  jobDirFor,
  nextCronFire,
  parseCronSchedule,
  parseJobDefFrontmatter,
  readAgendaJobs,
  readCalendarStateFile,
  readJobDefinitionFile,
  readJobRunsBackfillFile,
  readJobRunsDetailFile,
  readJobRunsStateFile,
  runAgendaSchedulerTick,
  runJobBackfillTick,
  stampJobRun,
  unwrapQuotedScalar,
  writeCalendarStateFile,
  writeJobRunsBackfillFile,
  writeJobRunsDetailFile,
  writeJobRunsStateFile
} from '../lib/jobs.js'

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-jobs-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

async function withTempJobDir(fn) {
  const jobDir = await mkdtemp(path.join(tmpdir(), 'deepartments-jobs-def-'))
  try {
    return await fn(jobDir)
  } finally {
    await rm(jobDir, { recursive: true, force: true })
  }
}

/** A minimal valid job-definition frontmatter builder. */
function defText(overrides = {}) {
  const meta = {
    id: 'job',
    title: 'Job title',
    role: 'researcher',
    description: 'description',
    owner: 'research-head',
    ...overrides
  }
  const lines = ['---']
  for (const [k, v] of Object.entries(meta)) {
    // Quote the schedule so a free-text / human cadence survives the reader.
    const value = k === 'schedule' ? `"${v}"` : String(v)
    lines.push(`${k}: ${value}`)
  }
  lines.push('---', '', 'The concrete task body.')
  return lines.join('\n')
}

// --- cron: parseCronSchedule --------------------------------------------------

test('parseCronSchedule: a 5-field cron parses into the field value sets', () => {
  const c = parseCronSchedule('0 9 * * *')
  assert.ok(c, 'a valid 5-field cron parses')
  assert.deepEqual([...c.minutes], [0])
  assert.deepEqual([...c.hours], [9])
  assert.equal(c.dom.size, 31, 'dom covers days 1..31')
  assert.equal(c.months.size, 12, 'months covers 1..12')
  assert.equal(c.dow.size, 8, 'dow covers 0..7 (0 = Sunday)')
})

test('parseCronSchedule: @aliases expand (@daily/@hourly/@weekly/@monthly/@yearly/@annually/@minutely)', () => {
  const daily = parseCronSchedule('@daily')
  assert.deepEqual([...daily.minutes], [0])
  assert.deepEqual([...daily.hours], [0])
  assert.equal(daily.dom.size, 31)

  const hourly = parseCronSchedule('@hourly')
  assert.deepEqual([...hourly.minutes], [0])
  assert.equal(hourly.hours.size, 24)

  const weekly = parseCronSchedule('@weekly')
  assert.deepEqual([...weekly.dow], [0], 'weekly fires on Sunday (dow 0)')

  const monthly = parseCronSchedule('@monthly')
  assert.deepEqual([...monthly.dom], [1], 'monthly fires on day 1')
  assert.equal(monthly.months.size, 12)

  const yearly = parseCronSchedule('@yearly')
  assert.deepEqual([...yearly.months], [1], 'yearly fires in January')
  assert.deepEqual([...yearly.dom], [1])
  assert.deepEqual([...parseCronSchedule('@annually').months], [1], '@annually == @yearly')

  assert.equal(parseCronSchedule('@minutely').minutes.size, 60)
})

test('parseCronSchedule: a non-cron (human/empty/invalid) schedule → undefined', () => {
  assert.equal(parseCronSchedule(''), undefined, 'empty schedule is not a cron')
  assert.equal(parseCronSchedule('daily 09:00 (reserved)'), undefined, 'the deployment human cadence is NOT a cron')
  assert.equal(parseCronSchedule('0 9 * *'), undefined, '4 fields is not a 5-field cron')
  assert.equal(parseCronSchedule('a b c d e'), undefined, 'non-numeric tokens are not a cron')
  assert.equal(parseCronSchedule(undefined), undefined)
})

// --- cron: cronFieldParse edges (star / ranges / lists / steps) ---------------

test('cronFieldParse: star, */n, n-m ranges, comma lists and out-of-range rejection', () => {
  assert.equal(cronFieldParse('*', 0, 59).size, 60)
  assert.deepEqual([...cronFieldParse('*/10', 0, 59)], [0, 10, 20, 30, 40, 50])
  assert.deepEqual([...cronFieldParse('*/15', 0, 59)], [0, 15, 30, 45])
  assert.deepEqual([...cronFieldParse('1-5', 1, 31)], [1, 2, 3, 4, 5])
  assert.deepEqual([...cronFieldParse('1,3,5', 1, 31)], [1, 3, 5])
  assert.deepEqual([...cronFieldParse('30', 0, 59)], [30])
  // Out-of-range bounds → the field is NOT valid cron.
  assert.equal(cronFieldParse('61', 0, 59), undefined, 'a value above max is rejected')
  assert.equal(cronFieldParse('1-32', 1, 31), undefined, 'a range crossing max is rejected')
  assert.equal(cronFieldParse('1,61', 0, 59), undefined, 'a list containing an out-of-range value is rejected')
  assert.equal(cronFieldParse('abc', 0, 59), undefined, 'a non-numeric token is rejected')
  // A whole set between min..max yields the lower bound when start < min is impossible (start==min).
  assert.deepEqual([...cronAll(0, 3)], [0, 1, 2, 3])
})

// --- cron: cronMatches / nextCronFire / cronIsDue -----------------------------

test('cronMatches: true on a matching minute, false when any field is off', () => {
  const c = parseCronSchedule('0 9 * * *')
  // Local-time Date (cron matches on LOCAL date fields, like the real engine).
  assert.equal(cronMatches(c, new Date(2026, 7, 23, 9, 0, 0)), true)
  assert.equal(cronMatches(c, new Date(2026, 7, 23, 9, 5, 0)), false, 'minute off')
  assert.equal(cronMatches(c, new Date(2026, 7, 23, 10, 0, 0)), false, 'hour off')
})

test('nextCronFire: the NEXT fire strictly AFTER `from` (minute resolution, never the same minute)', () => {
  const c = parseCronSchedule('0 9 * * *')
  const from = new Date(2026, 7, 23, 8, 0, 0)
  const next = nextCronFire(c, from)
  assert.equal(next.getHours(), 9)
  assert.equal(next.getMinutes(), 0)
  assert.ok(next.getTime() > from.getTime(), 'strictly after from')

  // From EXACTLY the fire minute → the next fire is the following day (strictly after).
  const fromSame = new Date(2026, 7, 23, 9, 0, 0)
  const nextSame = nextCronFire(c, fromSame)
  assert.equal(nextSame.getDate(), 24, 'a forward scan skips the from minute')
  assert.equal(nextSame.getHours(), 9)
})

test('nextCronFire: undefined when no fire falls within the 1-year horizon', () => {
  // Feb 31 never exists in the Gregorian calendar → no fire within the horizon.
  const c = parseCronSchedule('0 0 31 2 *')
  assert.equal(nextCronFire(c, new Date(2026, 0, 1, 0, 0, 0)), undefined)
})

test('cronIsDue: idempotent by the ALIGNED minute within the desync window', () => {
  const everyMin = parseCronSchedule('* * * * *')
  const now = new Date(2026, 7, 23, 9, 0, 30)
  assert.equal(cronIsDue(everyMin, now, undefined), true, 'never fired → due')
  // Last fired at the SAME aligned minute → NOT due (a per-minute job fires once a minute).
  const sameMinute = new Date(2026, 7, 23, 9, 0, 5).getTime()
  assert.equal(cronIsDue(everyMin, now, sameMinute), false)
  // Last fired at the PREVIOUS minute → a fresh aligned minute is still within the window → due.
  const prevMinute = new Date(2026, 7, 23, 8, 59, 0).getTime()
  assert.equal(cronIsDue(everyMin, now, prevMinute), true)
})

test('CRON_DESYNC_WINDOW_MIN is the 2-minute wake/skew tolerance', () => {
  assert.equal(CRON_DESYNC_WINDOW_MIN, 2)
})

// --- job-def reader -----------------------------------------------------------

test('unwrapQuotedScalar: strips a wrapped single/double quote; leaves unquoted + short strings', () => {
  assert.equal(unwrapQuotedScalar('"daily 09:00 (reserved)"'), 'daily 09:00 (reserved)')
  assert.equal(unwrapQuotedScalar("'monthly'"), 'monthly')
  assert.equal(unwrapQuotedScalar('"a"'), 'a')
  assert.equal(unwrapQuotedScalar('plain'), 'plain')
  assert.equal(unwrapQuotedScalar('"a'), '"a', 'an unclosed quote is left unchanged')
  assert.equal(unwrapQuotedScalar(''), '')
})

test('parseJobDefFrontmatter: parses a valid definition (required id/title/role/description/owner; schedule/outbox optional)', () => {
  const text = [
    '---',
    'job-id-alpha: x', // an unrecognised key is tolerated (ignored by the reader)
    'id: my-job',
    'title: My Job',
    'role: researcher',
    'description: a job',
    'owner: research-head',
    'schedule: "0 9 * * *"',
    'outbox: reports/x.md',
    '---',
    '',
    'The task body.'
  ].join('\n')
  const parsed = parseJobDefFrontmatter(text)
  assert.ok(parsed)
  assert.equal(parsed.meta.id, 'my-job')
  assert.equal(parsed.meta.title, 'My Job')
  assert.equal(parsed.meta.schedule, '0 9 * * *', 'the quoted scalar is unwrapped')
  assert.equal(parsed.meta.outbox, 'reports/x.md')
  assert.equal(parsed.body, 'The task body.')
})

test('parseJobDefFrontmatter: undefined on no block / missing required key / empty body / no closing delimiter', () => {
  assert.equal(parseJobDefFrontmatter('no frontmatter here\n'), undefined, 'no --- block')
  assert.equal(parseJobDefFrontmatter('---\nid: only-id\n---\n\nbody\n'), undefined, 'a required key is missing (title/role/...)')
  assert.equal(parseJobDefFrontmatter('---\nid: x\ntitle: t\nrole: r\ndescription: d\nowner: o\n---\n\n\n'), undefined, 'empty body is rejected')
  assert.equal(parseJobDefFrontmatter('---\nid: x\ntitle: t\nrole: r\ndescription: d\nowner: o\n\nbody'), undefined, 'no closing --- delimiter')
})

test('jobDirFor: default <repoRoot>/docs/departments/<id>/jobs and the config override (repo-relative / absolute)', () => {
  assert.equal(jobDirFor('/repo', { id: 'research' }), path.join('/repo', 'docs', 'departments', 'research', 'jobs'))
  assert.equal(jobDirFor('/repo', { id: 'research', jobDir: 'custom/jobs' }), path.join('/repo', 'custom', 'jobs'))
  assert.equal(jobDirFor('/repo', { id: 'research', jobDir: '/abs/jobs' }), '/abs/jobs')
  // Empty/whitespace jobDir → default.
  assert.equal(jobDirFor('/repo', { id: 'research', jobDir: '   ' }), path.join('/repo', 'docs', 'departments', 'research', 'jobs'))
})

test('readJobDefinitionFile: missing / broken frontmatter / id-mismatch all throw LOUD; a valid file resolves', async () => {
  await withTempJobDir(async (jobDir) => {
    await writeFile(path.join(jobDir, 'ok.md'), defText({ id: 'ok' }), 'utf8')
    const ok = await readJobDefinitionFile('/repo', { id: 'x', jobDir }, 'ok')
    assert.equal(ok.meta.id, 'ok')
    assert.equal(ok.body, 'The concrete task body.')
    assert.ok(ok.path.endsWith('ok.md'))

    await assert.rejects(() => readJobDefinitionFile('/repo', { id: 'x', jobDir }, 'missing'), /job not found: missing/)
    await writeFile(path.join(jobDir, 'broken.md'), '---\nid: broken\n---\n\nbody\n', 'utf8')
    await assert.rejects(() => readJobDefinitionFile('/repo', { id: 'x', jobDir }, 'broken'), /no valid frontmatter/)
    await writeFile(path.join(jobDir, 'mismatch.md'), defText({ id: 'other' }), 'utf8')
    await assert.rejects(() => readJobDefinitionFile('/repo', { id: 'x', jobDir }, 'mismatch'), /declares frontmatter id "other"/)
  })
})

test('readAgendaJobs: skips invalid definitions, computes next + cron for a cron schedule and omits cron/next for a human schedule', async () => {
  await withTempJobDir(async (jobDir) => {
    await writeFile(path.join(jobDir, 'cron.md'), defText({ id: 'c1', schedule: '0 9 * * *' }), 'utf8')
    await writeFile(path.join(jobDir, 'human.md'), defText({ id: 'h1', schedule: 'daily 09:00 (reserved)' }), 'utf8')
    await writeFile(path.join(jobDir, 'invalid.md'), 'not a frontmatter file\n', 'utf8')
    const nowMs = new Date(2026, 0, 1, 8, 0, 0).getTime()
    const items = await readAgendaJobs('/repo', [{ id: 'research', name: 'Research', jobDir }], nowMs)
    const byId = Object.fromEntries(items.map((i) => [i.id, i]))
    assert.ok(byId.c1, 'the cron-defining job is returned')
    assert.ok(byId.c1.cron, 'a cron schedule is parsed')
    assert.equal(byId.c1.next, new Date(2026, 0, 1, 9, 0, 0).toISOString(), 'the next fire (09:00) is computed')
    assert.ok(byId.h1, 'the human-schedule job is returned (displayed, never auto-fired)')
    assert.equal(byId.h1.cron, undefined, 'a non-cron schedule is not a cron')
    assert.equal(byId.h1.next, undefined)
    assert.equal(byId.invalid, undefined, 'a broken definition is skipped from the agenda')
  })
})

test('readAgendaJobs: a missing jobDir is an empty list', async () => {
  const items = await readAgendaJobs('/repo', [{ id: 'ghost', name: 'Ghost' }], Date.now())
  assert.deepEqual(items, [])
})

// --- calendar + job-runs state store ------------------------------------------

test('readCalendarStateFile: absent / malformed JSON → { entries: [] }; non-entry records are dropped', async () => {
  await withTempStateDir(async (stateDir) => {
    assert.deepEqual(readCalendarStateFile(path.join(stateDir, 'nope')), { entries: [] })
    await writeFile(path.join(stateDir, 'calendar.json'), 'NOT JSON', 'utf8')
    assert.deepEqual(readCalendarStateFile(stateDir), { entries: [] })
    await writeFile(path.join(stateDir, 'calendar.json'), JSON.stringify({
      entries: [
        { id: 'e1', label: 'L', at: '2026-08-24T09:00:00.000Z' }, // valid
        { id: 'e2', label: 'no-at' }, // missing `at` → dropped
        'not-an-entry' // not an object → dropped
      ]
    }), 'utf8')
    const state = readCalendarStateFile(stateDir)
    assert.equal(state.entries.length, 1)
    assert.equal(state.entries[0].id, 'e1')
  })
})

test('writeCalendarStateFile: mkdir -p + overwrite (round-trip)', async () => {
  await withTempStateDir(async (stateDir) => {
    const dir = path.join(stateDir, 'nested', 'sub')
    await writeCalendarStateFile(dir, { entries: [{ id: 'e1', label: 'L', at: '2026-08-24T09:00:00.000Z', fired: false }] })
    assert.deepEqual(readCalendarStateFile(dir), { entries: [{ id: 'e1', label: 'L', at: '2026-08-24T09:00:00.000Z', fired: false }] })
    // Overwrite.
    await writeCalendarStateFile(dir, { entries: [] })
    assert.deepEqual(readCalendarStateFile(dir), { entries: [] })
  })
})

test('readJobRunsStateFile: absent / malformed → {}; numeric values kept', async () => {
  await withTempStateDir(async (stateDir) => {
    assert.deepEqual(readJobRunsStateFile(path.join(stateDir, 'nope')), {})
    await writeFile(path.join(stateDir, 'job-runs-state.json'), 'NOT JSON', 'utf8')
    assert.deepEqual(readJobRunsStateFile(stateDir), {})
    await writeFile(path.join(stateDir, 'job-runs-state.json'), JSON.stringify({ a: 1, b: 'x', c: 2.5, d: 'NaN' }), 'utf8')
    assert.deepEqual(readJobRunsStateFile(stateDir), { a: 1, c: 2.5 })
  })
})

test('writeJobRunsStateFile: mkdir + overwrite (round-trip)', async () => {
  await withTempStateDir(async (stateDir) => {
    const dir = path.join(stateDir, 'nested', 'sub')
    await writeJobRunsStateFile(dir, { jobA: 1700000000000 })
    assert.deepEqual(readJobRunsStateFile(dir), { jobA: 1700000000000 })
    await writeJobRunsStateFile(dir, {})
    assert.deepEqual(readJobRunsStateFile(dir), {})
  })
})

// --- O3-a (VALLE 09-07 — job-runs visibility): the MANUAL re-run stamp --------
// The scheduler tick stamps AUTO-runs (`runs[job.id] = nowMs`); before O3-a a
// MANUAL `dept_job_run` re-fire never touched the ledger, so a head's re-queue
// after a class-outage death (09-07: auto 09:00:02Z died, head re-ran 10:39Z)
// was invisible. `stampJobRun` writes the SAME flat {jobId: lastRunAtMs} form,
// same state file — a manual re-run is recorded exactly like an auto-run.

test('O3-a stampJobRun: a MANUAL re-run stamps the SAME flat {jobId: lastRunAtMs} form + round-trips (state file)', async () => {
  await withTempStateDir(async (stateDir) => {
    const ts = 1724400000000
    const returned = await stampJobRun(stateDir, 'quality-daily', ts)
    // The SAME flat numeric form the tick writes for auto-runs — never a
    // second schema (a non-auto run must not silently vanish).
    assert.deepEqual(returned, { 'quality-daily': ts }, 'the stamp returns the new full ledger')
    assert.deepEqual(readJobRunsStateFile(stateDir), { 'quality-daily': ts }, 'manual run lands in the same ledger read')
    // The canonical file carries it (the same file the tick persists).
    const raw = JSON.parse(await readFile(path.join(stateDir, 'job-runs-state.json'), 'utf8'))
    assert.deepEqual(raw, { 'quality-daily': ts }, 'the canonical <stateDir>/job-runs-state.json carries the manual stamp')
  })
})

test('O3-a stampJobRun: read-modify-write — other jobs\' entries are preserved; a re-stamp of the SAME job advances its ts (the re-fire is the LAST run)', async () => {
  await withTempStateDir(async (stateDir) => {
    // An AUTO-run entry (as the tick would have left it) already sits there.
    const autoTs = 1724400000000
    await writeJobRunsStateFile(stateDir, { 'pulse-digest': autoTs })
    const manualTs = autoTs + 99 * 60 * 1000 // the 10:39Z re-fire, ~99 min later
    await stampJobRun(stateDir, 'pulse-digest', manualTs)
    // The same job's entry ADVANCED to the manual ts (the re-fire is now the
    // last run — visible to health's readLatestJobRunTs as a fresh run).
    assert.deepEqual(readJobRunsStateFile(stateDir), { 'pulse-digest': manualTs }, 'the manual re-fire becomes the last run of its job')
    // A DIFFERENT job's entry is preserved untouched.
    await stampJobRun(stateDir, 'weekly-repo-health', autoTs)
    assert.deepEqual(readJobRunsStateFile(stateDir), { 'pulse-digest': manualTs, 'weekly-repo-health': autoTs }, 'read-modify-write preserves the other entries (mixed auto+manual ledger)')
  })
})

test('O3-a stampJobRun: absent/malformed ledger tolerated (mirrors readJobRunsStateFile — a stamp never throws on the read)', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeFile(path.join(stateDir, 'job-runs-state.json'), 'junk', 'utf8')
    const returned = await stampJobRun(stateDir, 'c1', 42)
    assert.deepEqual(returned, { c1: 42 }, 'malformed ledger → starts from {} (a manual stamp still lands)')
    assert.deepEqual(readJobRunsStateFile(stateDir), { c1: 42 })
  })
})

test('O3-a + tick: the AUTO-run still stamps (ledger advances on fired) AND a MANUAL stamp of the same run is recorded identically — the auto-run is NOT broken', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      await writeFile(path.join(jobDir, 'c1.md'), defText({ id: 'c1', schedule: '* * * * *' }), 'utf8')
      const runCalls = []
      const nowMs = new Date(2026, 7, 23, 9, 0, 30).getTime()
      const deps = {
        now: () => nowMs,
        departments: [{ id: 'research', name: 'Research', jobDir }],
        repoRoot: '/nonexistent',
        calendarStateDir: stateDir,
        jobRunsStateDir: stateDir,
        headForDepartment: () => 'research-head',
        runJob: async (dept, head, jobId) => { runCalls.push({ dept: dept.id, head, jobId }); return true },
        notifyHead: async () => {},
        departmentForEntry: () => ({ id: 'research', name: 'Research', jobDir }),
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir })
      }
      await runAgendaSchedulerTick(deps)
      assert.deepEqual(readJobRunsStateFile(stateDir), { c1: nowMs }, 'the AUTO-run still stamps the ledger (unchanged behavior)')
      // A manual re-fire of the same job lands in the SAME state, SAME form.
      const manualTs = nowMs + 60 * 60000
      await stampJobRun(stateDir, 'c1', manualTs)
      assert.deepEqual(readJobRunsStateFile(stateDir), { c1: manualTs }, 'the manual re-run is stamped identically — one ledger, one form')
    })
  })
})

// --- the pure scheduler tick (injectable clock + deps) ------------------------

test('runAgendaSchedulerTick: a due cron job fires runJob + advances the ledger; a not-due job never fires', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      await writeFile(path.join(jobDir, 'c1.md'), defText({ id: 'c1', schedule: '* * * * *' }), 'utf8') // every minute → due
      await writeFile(path.join(jobDir, 'later.md'), defText({ id: 'later', schedule: '30 9 * * *' }), 'utf8') // 09:30 → not due at 09:00:30
      const runCalls = []
      const notifyCalls = []
      const warns = []
      const nowMs = new Date(2026, 7, 23, 9, 0, 30).getTime()
      const deps = {
        now: () => nowMs,
        departments: [{ id: 'research', name: 'Research', jobDir }],
        repoRoot: '/nonexistent',
        calendarStateDir: stateDir,
        jobRunsStateDir: stateDir,
        headForDepartment: () => 'research-head',
        runJob: async (dept, head, jobId) => { runCalls.push({ dept: dept.id, head, jobId }); return true },
        notifyHead: async (target, message) => { notifyCalls.push({ target, message }) },
        departmentForEntry: () => ({ id: 'research', name: 'Research', jobDir }),
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir }),
        logger: { warn: (m) => { warns.push(m) } }
      }
      await runAgendaSchedulerTick(deps)
      assert.equal(runCalls.length, 1, 'only the due cron job fired')
      assert.equal(runCalls[0].jobId, 'c1')
      assert.equal(runCalls[0].head, 'research-head')
      assert.equal(notifyCalls.length, 0)
      assert.deepEqual(readJobRunsStateFile(stateDir), { c1: nowMs }, 'the ledger records the fire time for the fired job only')
      assert.equal(warns.length, 0, 'a clean tick logs no warns')
    })
  })
})

test('runAgendaSchedulerTick: the ledger advances only when runJob returns true; a returned-false fire is an idempotency-skip and never advances', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      await writeFile(path.join(jobDir, 'c1.md'), defText({ id: 'c1', schedule: '* * * * *' }), 'utf8')
      const skipCalls = []
      const warns = []
      const nowMs = new Date(2026, 7, 23, 9, 0, 30).getTime()
      const base = {
        now: () => nowMs,
        departments: [{ id: 'research', name: 'Research', jobDir }],
        repoRoot: '/nonexistent',
        calendarStateDir: stateDir,
        jobRunsStateDir: stateDir,
        headForDepartment: () => 'research-head',
        notifyHead: async () => {},
        departmentForEntry: () => ({ id: 'research', name: 'Research', jobDir }),
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir }),
        logger: { warn: (m) => { warns.push(m) } },
        onAutoRunSkip: async (finding) => { skipCalls.push(finding) }
      }
      // (a) a returned-FALSE fire (idempotency skip) never advances the ledger.
      await runAgendaSchedulerTick({ ...base, runJob: async () => false })
      assert.deepEqual(readJobRunsStateFile(stateDir), {}, 'a skipped fire never advances the ledger')
      assert.equal(skipCalls.filter((s) => s.reason === 'idempotency-skip').length, 1, 'the returned-false fire surfaces an idempotency-skip finding')
      assert.equal(warns.length, 0)
      // (b) a fire that THROWS is a warn + an onAutoRunSkip (error), and never advances.
      await runAgendaSchedulerTick({ ...base, runJob: async () => { throw new Error('boom') } })
      assert.deepEqual(readJobRunsStateFile(stateDir), {}, 'a thrown fire never advances the ledger')
      assert.equal(skipCalls.filter((s) => s.reason === 'boom').length, 1)
      assert.equal(warns.some((w) => w.includes('run failed: boom')), true)
    })
  })
})

test('runAgendaSchedulerTick: a non-due cron job is NOT fired', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      await writeFile(path.join(jobDir, 'later.md'), defText({ id: 'later', schedule: '0 9 * * *' }), 'utf8')
      const runCalls = []
      // 10:00 — the 09:00 daily cron is not due in the 2-minute window.
      await runAgendaSchedulerTick({
        now: () => new Date(2026, 7, 23, 10, 0, 0).getTime(),
        departments: [{ id: 'research', name: 'Research', jobDir }],
        repoRoot: '/nonexistent',
        calendarStateDir: stateDir,
        jobRunsStateDir: stateDir,
        headForDepartment: () => 'research-head',
        runJob: async (dept, head, jobId) => { runCalls.push(jobId); return true },
        notifyHead: async () => {},
        departmentForEntry: () => ({ id: 'research', name: 'Research', jobDir }),
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir })
      })
      assert.deepEqual(runCalls, [], 'a non-due cron job never fires')
    })
  })
})

test('runAgendaSchedulerTick: a due CALENDAR entry — a jobId entry runs the job, a plain entry notifies the owning head; both are marked fired (B4 delegated to notifyHead)', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      // A job with a HUMAN schedule never auto-fires via the cron path (so the
      // ONLY reason it runs is the calendar jobId entry below).
      await writeFile(path.join(jobDir, 'cal-job.md'), defText({ id: 'cal-job', schedule: 'daily 09:00 (reserved)' }), 'utf8')
      const runCalls = []
      const notifyCalls = []
      const warns = []
      const nowMs = new Date(2026, 7, 23, 9, 0, 30).getTime()
      const deps = {
        now: () => nowMs,
        departments: [{ id: 'research', name: 'Research', jobDir }],
        repoRoot: '/nonexistent',
        calendarStateDir: stateDir,
        jobRunsStateDir: stateDir,
        headForDepartment: () => 'research-head',
        runJob: async (dept, head, jobId) => { runCalls.push({ dept: dept.id, head, jobId }); return true },
        notifyHead: async (target, message) => { notifyCalls.push({ target, message }) },
        departmentForEntry: () => ({ id: 'research', name: 'Research', jobDir }),
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir }),
        logger: { warn: (m) => { warns.push(m) } }
      }
      const future = new Date(nowMs + 60 * 60 * 1000).toISOString()
      await writeCalendarStateFile(stateDir, { entries: [
        { id: 'j1', label: 'Run cal job', at: new Date(nowMs - 5 * 60000).toISOString(), jobId: 'cal-job', createdBy: 'research-head', fired: false },
        { id: 'p1', label: 'Team sync', at: new Date(nowMs - 5 * 60000).toISOString(), createdBy: 'research-head', fired: false },
        { id: 'future', label: 'Not yet', at: future, createdBy: 'research-head', fired: false }
      ] })
      await runAgendaSchedulerTick(deps)
      assert.equal(runCalls.filter((c) => c.jobId === 'cal-job').length, 1, 'the due calendar jobId entry ran the job')
      assert.equal(runCalls[0].head, 'research-head')
      assert.equal(notifyCalls.length, 1, 'the plain due entry notified the head once')
      assert.equal(notifyCalls[0].target, 'research-head')
      assert.equal(notifyCalls[0].message, 'Team sync')
      assert.equal(warns.length, 0)
      const cal = readCalendarStateFile(stateDir)
      const fired = cal.entries.filter((e) => e.fired === true).map((e) => e.id).sort()
      assert.deepEqual(fired, ['j1', 'p1'], 'both due entries are marked fired; the future one is untouched')
      assert.equal(cal.entries.find((e) => e.id === 'future').fired, false, 'a future entry remains un-fired (untouched)')
    })
  })
})

test('runAgendaSchedulerTick: the B4 wake gate is DELEGATED — the pure tick never enforces a wake, it only calls deps.notifyHead', async () => {
  // A dormant-head scenario is modelled by the deps.notifyHead stub recording the
  // call: the PURE tick has NO concept of sleep/wake (its AgendaSchedulerDeps
  // carries no sleepEpoch/wake-gate member). The actual gate lives in the
  // bundle's notifyHead closure → deliverDaemonNotice (tested in invoke.test.js),
  // so a pure-tick test asserts the tick delegates and never forces a wake.
  await withTempStateDir(async (stateDir) => {
    const notifyCalls = []
    const deps = {
      now: () => new Date(2026, 7, 23, 9, 0, 30).getTime(),
      departments: [{ id: 'research', name: 'Research' }],
      repoRoot: '/nonexistent',
      calendarStateDir: stateDir,
      jobRunsStateDir: stateDir,
      headForDepartment: () => 'research-head',
      runJob: async () => true,
      notifyHead: async (target, message) => { notifyCalls.push({ target, message }) },
      departmentForEntry: () => undefined,
      departmentForJob: () => undefined
    }
    await writeCalendarStateFile(stateDir, { entries: [{ id: 'p1', label: 'Due sync', at: new Date(2026, 7, 23, 9, 0, 0).toISOString(), createdBy: 'research-head', fired: false }] })
    await runAgendaSchedulerTick(deps)
    assert.equal(notifyCalls.length, 1, 'a due plain entry notifies the head')
    assert.equal(notifyCalls[0].message, 'Due sync')
    assert.equal('sleepEpoch' in deps, false, 'the pure tick deps expose no wake/sleep gate (the B4 gate is out of scope for dshd-jobs)')
  })
})

test('runAgendaSchedulerTick: NEVER throws — an fs failure while persisting the ledger/calendar is folded to a warn', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      await writeFile(path.join(jobDir, 'c1.md'), defText({ id: 'c1', schedule: '* * * * *' }), 'utf8')
      const warns = []
      const nowMs = new Date(2026, 7, 23, 9, 0, 30).getTime()
      const base = {
        now: () => nowMs,
        departments: [{ id: 'research', name: 'Research', jobDir }],
        repoRoot: '/nonexistent',
        calendarStateDir: stateDir,
        jobRunsStateDir: stateDir,
        headForDepartment: () => 'research-head',
        runJob: async () => true,
        notifyHead: async () => {},
        departmentForEntry: () => ({ id: 'research', name: 'Research', jobDir }),
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir }),
        logger: { warn: (m) => { warns.push(m) } }
      }
      // A due cron job fires TRUE so the tick must persist the ledger — but the
      // stateDir path lands under a REGULAR FILE (mkdir/parent fails) → the write
      // throws, and the tick folds it to a warn instead of throwing.
      const asFile = path.join(stateDir, 'as-file')
      await writeFile(asFile, 'x', 'utf8')
      const boomStateDir = path.join(asFile, 'sub')
      await runAgendaSchedulerTick({ ...base, jobRunsStateDir: boomStateDir })
      assert.equal(warns.some((w) => w.includes('scheduler tick failed')), true, 'an fs persist failure is a warn, never a throw')
    })
  })
})

test('readJobDefinitionFile path + readJobRunsStateFile/writeJobRunsStateFile use the documented file names', async () => {
  await withTempStateDir(async (stateDir) => {
    // The ledger round-trips at the canonical <stateDir>/job-runs-state.json.
    await writeJobRunsStateFile(stateDir, { k: 42 })
    const raw = JSON.parse(await readFile(path.join(stateDir, 'job-runs-state.json'), 'utf8'))
    assert.deepEqual(raw, { k: 42 })
  })
})

// --- O3-b (VALLE 09-07 — class-outage auto-backfill): the collector + stores +
// the pure backfill tick. A job whose AUTO-run died with a class-outage
// (400/503/429 family) registers ONE pending candidate per episode (dedupe);
// the tick retries it at +15min/+60min FROM THE FIRST failure, only when the
// pool is healthy (O1 never bypassed) and the cron is still due OR the job is
// in debt (its last run predates the episode) — max 2 retries per episode.
// ----------------------------------------------------------------------------

test('O3-b: the class-outage family regex + classifiers match the 400/503/429 reasons and reject the O1 dispatch-block family', () => {
  assert.ok(isClassOutageReason('HTTP 429 rate limit exceeded'), '429 class')
  assert.ok(isClassOutageReason('503 service unavailable'), '503 class')
  assert.ok(isClassOutageReason('provider rejected: reasoning_content must be passed back'), 'the 400 reasoning_content class')
  assert.ok(isClassOutageReason('MissingSessionID'), 'MissingSessionID class')
  assert.ok(isClassOutageReason('quota exceeded for the current month'), 'quota class')
  assert.ok(isClassOutageReason('UPSTREAM 429 TOO MANY REQUESTS (rate limit)'), 'case-insensitive')
  assert.equal(isClassOutageReason('idempotency-skip'), false)
  assert.equal(isClassOutageReason('no head'), false)
  assert.equal(isClassOutageReason('boom'), false)
  // The O1 family (PEAK-deferred) — regex source of truth.
  assert.equal(isJobDispatchBlockReason('[deepartments] pool: HALT — 1 usable key oc-6 (weekly available 5% < 20%)'), true)
  assert.equal(isJobDispatchBlockReason('[deepartments] pool: workspace ws1 at quota (0 usable keys) — dispatch delayed'), true)
  assert.equal(isJobDispatchBlockReason('503 service unavailable'), false)
  assert.equal(CLASS_OUTAGE_REASON_RE.source, /reasoning_content|MissingSessionID|429|rate limit|503|service unavailable|quota/i.source, 'the family regex is the approved design §4.2 regex verbatim')
  assert.deepEqual(JOB_BACKFILL_OFFSETS_MIN, [15, 60], 'the fixed backoff is +15min / +60min')
  assert.equal(JOB_BACKFILL_MAX_ATTEMPTS, 2, 'max 2 retries per episode')
})

test('O3-b collectClassOutageCandidate: classifies the class-outage family (reason OR error) into ONE pending candidate per job', async () => {
  await withTempStateDir(async (stateDir) => {
    // The reason carries the family.
    const r1 = await collectClassOutageCandidate(stateDir, 'c1', 'HTTP 429 rate limit exceeded', undefined, 1000)
    assert.equal(r1.collected, true)
    assert.deepEqual(readJobRunsBackfillFile(stateDir).candidates.c1, { jobId: 'c1', firstFailureAt: 1000, pending: true, attempts: 0 })
    // The ERROR text alone classifies (a normalized/opaque reason still collects).
    const r2 = await collectClassOutageCandidate(stateDir, 'c2', 'run failed', 'provider rejected: reasoning_content must be passed back', 2000)
    assert.equal(r2.collected, true)
    assert.equal(readJobRunsBackfillFile(stateDir).candidates.c2.firstFailureAt, 2000)
    // Non-family reasons never collect (no head / idempotency-skips stay out).
    const nr = await collectClassOutageCandidate(stateDir, 'c3', 'no head', undefined, 3000)
    assert.equal(nr.collected, false)
    assert.equal(readJobRunsBackfillFile(stateDir).candidates.c3, undefined)
    const nr2 = await collectClassOutageCandidate(stateDir, 'c4', 'idempotency-skip', undefined, 3000)
    assert.equal(nr2.collected, false)
  })
})

test('O3-b collectClassOutageCandidate: dedupe per episode — a SECOND outage of the SAME job with a retry pending is IGNORED (the episode start never advances); a resolved episode starts a NEW one', async () => {
  await withTempStateDir(async (stateDir) => {
    await collectClassOutageCandidate(stateDir, 'c1', '503 service unavailable', undefined, 1000)
    const dup = await collectClassOutageCandidate(stateDir, 'c1', '429 rate limit', 'another 503', 99999)
    assert.equal(dup.collected, false, 'a second outage while a retry is pending is ignored')
    let c = readJobRunsBackfillFile(stateDir).candidates.c1
    assert.equal(c.firstFailureAt, 1000, 'the episode start stays the FIRST failure')
    assert.equal(c.attempts, 0)
    // A DIFFERENT job collects its own episode.
    await collectClassOutageCandidate(stateDir, 'c2', 'quota exceeded', undefined, 2000)
    assert.equal(readJobRunsBackfillFile(stateDir).candidates.c2.firstFailureAt, 2000)
    // A RESOLVED episode → a NEW outage starts a NEW episode (fresh budget).
    const state = readJobRunsBackfillFile(stateDir)
    state.candidates.c1.pending = false
    await writeJobRunsBackfillFile(stateDir, state)
    const again = await collectClassOutageCandidate(stateDir, 'c1', '503 service unavailable', undefined, 5000)
    assert.equal(again.collected, true)
    c = readJobRunsBackfillFile(stateDir).candidates.c1
    assert.equal(c.firstFailureAt, 5000, 'a new episode starts from the new first failure')
    assert.equal(c.pending, true)
    assert.equal(c.attempts, 0)
  })
})

test('O3-b PEAK anti-storm: an O1 dispatch block ([deepartments] pool: …) NEVER generates a candidate — the exclusion wins even over a family token (at-quota)', async () => {
  await withTempStateDir(async (stateDir) => {
    // The pooler 0-usable branch carries the family token "quota" — the PEAK
    // rule must win (a job deferred by O1 was never materialized; no backfill).
    const atQuota = '[deepartments] pool: workspace ws1 at quota (0 usable keys — all blocked/cooldown/invalid; 1/1 keys) — dispatch delayed; retry when a fresh key resolves'
    const r1 = await collectClassOutageCandidate(stateDir, 'c1', atQuota, undefined, 1000)
    assert.equal(r1.collected, false)
    // The HALT branch via the ERROR text too.
    const halt = '[deepartments] pool: HALT — 1 usable key oc-6 (weekly available 5% < 20% or monthly available 0% < 10%) — NO new dispatches until ≥2 usable keys or new keys are added'
    const r2 = await collectClassOutageCandidate(stateDir, 'c2', 'run failed', halt, 2000)
    assert.equal(r2.collected, false)
    assert.deepEqual(readJobRunsBackfillFile(stateDir), { candidates: {} }, 'an O1-deferred job never leaves a candidate (no storm at PEAK)')
  })
})

test('O3-b runJobBackfillTick: backoff — retries at +15min and +60min FROM THE FIRST failure (never before, never shifted by earlier attempts)', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      await writeFile(path.join(jobDir, 'c1.md'), defText({ id: 'c1', schedule: '* * * * *' }), 'utf8')
      const firstFailureAt = new Date(2026, 7, 23, 9, 0, 0).getTime()
      const runCalls = []
      const base = {
        stateDir,
        repoRoot: '/nonexistent',
        departments: [{ id: 'research', name: 'Research', jobDir }],
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir }),
        headForDepartment: () => 'research-head',
        // A SKIPPED retry (false) consumes the attempt and keeps the episode
        // pending — so the SECOND slot (+60min) is reached.
        runJob: async (dept, head, jobId) => { runCalls.push(jobId); return false },
        poolDispatchBlockError: () => undefined
      }
      await collectClassOutageCandidate(stateDir, 'c1', '503 service unavailable', undefined, firstFailureAt)
      const tickAt = async (nowMs) => { await runJobBackfillTick({ ...base, now: () => nowMs }) }
      // +5 min → before the first slot (+15) → nothing.
      await tickAt(firstFailureAt + 5 * 60000)
      assert.equal(runCalls.length, 0)
      assert.equal(readJobRunsBackfillFile(stateDir).candidates.c1.attempts, 0)
      // +15 min → attempt 1.
      await tickAt(firstFailureAt + 15 * 60000)
      assert.equal(runCalls.length, 1)
      assert.equal(readJobRunsBackfillFile(stateDir).candidates.c1.attempts, 1)
      // +30 min → before the second slot (+60) → nothing (the FIXED schedule never shifts).
      await tickAt(firstFailureAt + 30 * 60000)
      assert.equal(runCalls.length, 1)
      // +60 min → attempt 2.
      await tickAt(firstFailureAt + 60 * 60000)
      assert.equal(runCalls.length, 2)
      assert.equal(readJobRunsBackfillFile(stateDir).candidates.c1.attempts, 2)
    })
  })
})

test('O3-b runJobBackfillTick: MAX attempts — 2 per episode, then the candidate DIES (pending=false, never a 3rd); a later outage starts a new episode', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      await writeFile(path.join(jobDir, 'c1.md'), defText({ id: 'c1', schedule: '* * * * *' }), 'utf8')
      const firstFailureAt = new Date(2026, 7, 23, 9, 0, 0).getTime()
      const runCalls = []
      const base = {
        stateDir, repoRoot: '/nonexistent',
        departments: [{ id: 'research', name: 'Research', jobDir }],
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir }),
        headForDepartment: () => 'research-head',
        // Both retries FAIL with a fresh class-outage (the retry's own spawn died).
        runJob: async (dept, head, jobId) => { runCalls.push(jobId); throw new Error('503 service unavailable — the retry also died') },
        poolDispatchBlockError: () => undefined
      }
      await collectClassOutageCandidate(stateDir, 'c1', '503 service unavailable', undefined, firstFailureAt)
      // +15 → attempt 1 FAILS → stays pending (1 < 2).
      await runJobBackfillTick({ ...base, now: () => firstFailureAt + 15 * 60000 })
      let c = readJobRunsBackfillFile(stateDir).candidates.c1
      assert.equal(c.attempts, 1)
      assert.equal(c.pending, true)
      assert.equal(c.lastOutcome, 'failed')
      // +60 → attempt 2 FAILS → the candidate DIES.
      await runJobBackfillTick({ ...base, now: () => firstFailureAt + 60 * 60000 })
      c = readJobRunsBackfillFile(stateDir).candidates.c1
      assert.equal(c.attempts, 2)
      assert.equal(c.pending, false)
      // A tick after death does nothing more (≤2 always).
      await runJobBackfillTick({ ...base, now: () => firstFailureAt + 120 * 60000 })
      assert.equal(runCalls.length, 2, 'never more than 2 retries per episode')
      // A NEW outage → a NEW episode (fresh base, fresh budget).
      const nextDay = firstFailureAt + 24 * 3600 * 1000
      await collectClassOutageCandidate(stateDir, 'c1', '503 service unavailable', undefined, nextDay)
      c = readJobRunsBackfillFile(stateDir).candidates.c1
      assert.equal(c.pending, true)
      assert.equal(c.attempts, 0)
      assert.equal(c.firstFailureAt, nextDay)
    })
  })
})

test('O3-b runJobBackfillTick: pool NOT healthy → the retry is SKIPPED and the candidate STAYS PENDING — the O1 gate is never bypassed (the gate AND the engine belt)', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      await writeFile(path.join(jobDir, 'c1.md'), defText({ id: 'c1', schedule: '* * * * *' }), 'utf8')
      const firstFailureAt = new Date(2026, 7, 23, 9, 0, 0).getTime()
      const block = '[deepartments] pool: HALT — 1 usable key oc-6 (weekly available 5% < 20% or monthly available 0% < 10%) — NO new dispatches until ≥2 usable keys or new keys are added'
      const runCalls = []
      await collectClassOutageCandidate(stateDir, 'c1', '503 service unavailable', undefined, firstFailureAt)
      // (a) The GATE blocks: poolDispatchBlockError() returns the block → the
      // runJob stub (which would itself throw the O1 block if ever reached) is
      // NEVER called; the candidate stays pending with 0 attempts consumed.
      await runJobBackfillTick({
        stateDir, repoRoot: '/nonexistent',
        departments: [{ id: 'research', name: 'Research', jobDir }],
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir }),
        headForDepartment: () => 'research-head',
        now: () => firstFailureAt + 15 * 60000,
        runJob: async () => { runCalls.push('unreachable'); throw new Error(block) },
        poolDispatchBlockError: () => block
      })
      let c = readJobRunsBackfillFile(stateDir).candidates.c1
      assert.equal(runCalls.length, 0, 'a blocked pool never reaches the engine')
      assert.equal(c.attempts, 0, 'the gate skip never consumes an attempt')
      assert.equal(c.pending, true, 'a blocked retry leaves the candidate pending')
      // (b) The ENGINE belt: a HEALTHY gate + a runJob that throws the O1 block
      // (the pool declined between the check and the dispatch) → STILL no
      // attempt consumed and the candidate stays pending (nothing materialized).
      await runJobBackfillTick({
        stateDir, repoRoot: '/nonexistent',
        departments: [{ id: 'research', name: 'Research', jobDir }],
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir }),
        headForDepartment: () => 'research-head',
        now: () => firstFailureAt + 15 * 60000,
        runJob: async () => { runCalls.push('engine'); throw new Error(block) },
        poolDispatchBlockError: () => undefined
      })
      c = readJobRunsBackfillFile(stateDir).candidates.c1
      assert.equal(runCalls.length, 1, 'the engine was reached once (healthy gate)')
      assert.equal(c.attempts, 0, 'an O1 engine throw never consumes an attempt')
      assert.equal(c.pending, true)
    })
  })
})

test('O3-b runJobBackfillTick: a GREEN retry stamps with stampJobRun (the SAME flat O3-a ledger) and writes job-runs-detail.json with trigger "backfill" — the flat ledger stays intact (numbers only)', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      await writeFile(path.join(jobDir, 'c1.md'), defText({ id: 'c1', schedule: '* * * * *' }), 'utf8')
      const firstFailureAt = new Date(2026, 7, 23, 9, 0, 0).getTime()
      // A previous successful round (yesterday) + an unrelated entry occupy the ledger.
      await writeJobRunsStateFile(stateDir, { c1: firstFailureAt - 24 * 3600 * 1000, 'other-job': 42 })
      await collectClassOutageCandidate(stateDir, 'c1', '503 service unavailable', undefined, firstFailureAt)
      const retryTs = firstFailureAt + 15 * 60000
      await runJobBackfillTick({
        stateDir, repoRoot: '/nonexistent',
        departments: [{ id: 'research', name: 'Research', jobDir }],
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir }),
        headForDepartment: () => 'research-head',
        now: () => retryTs,
        runJob: async () => true,
        poolDispatchBlockError: () => undefined
      })
      // The retry stamped the FLAT ledger — SAME form as the auto/manual runs
      // (the O3-a helper; job-runs-state.json stays the ONLY idempotency source).
      assert.deepEqual(readJobRunsStateFile(stateDir), { c1: retryTs, 'other-job': 42 }, 'the flat ledger advanced for c1 (stampJobRun) with the other entry untouched')
      // The OPTIONAL sibling detail ledger distinguishes the trigger without
      // touching the flat schema.
      assert.deepEqual(readJobRunsDetailFile(stateDir), { c1: { ts: retryTs, trigger: 'backfill' } }, 'job-runs-detail.json carries {ts, trigger:"backfill"}')
      const rawDetail = JSON.parse(await readFile(path.join(stateDir, 'job-runs-detail.json'), 'utf8'))
      assert.deepEqual(rawDetail, { c1: { ts: retryTs, trigger: 'backfill' } }, 'the canonical <stateDir>/job-runs-detail.json carries the entry')
      // The candidate resolved.
      const c = readJobRunsBackfillFile(stateDir).candidates.c1
      assert.equal(c.pending, false)
      assert.equal(c.attempts, 1)
      assert.equal(c.lastOutcome, 'fired')
      // A later MANUAL re-run still stamps the SAME flat form (the ledger is not broken).
      const manualTs = retryTs + 60 * 60000
      await stampJobRun(stateDir, 'c1', manualTs)
      assert.deepEqual(readJobRunsStateFile(stateDir), { c1: manualTs, 'other-job': 42 })
    })
  })
})

test('O3-b runJobBackfillTick: DEBT — a job whose cron desync window has PASSED is still retried when its last run predates the episode (the round is owed), never more than 2', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      // A DAILY job (09:00): the retry at 09:15 / 10:00 is NEVER window-due —
      // only the DEBT (yesterday's run < today's failed episode) entitles it.
      await writeFile(path.join(jobDir, 'daily.md'), defText({ id: 'daily', schedule: '0 9 * * *' }), 'utf8')
      const firstFailureAt = new Date(2026, 7, 23, 9, 0, 0).getTime() // the lost round today (exact — the +15 slot is 09:15:00)
      await writeJobRunsStateFile(stateDir, { daily: new Date(2026, 7, 22, 9, 0, 0).getTime() }) // yesterday 09:00 OK
      await collectClassOutageCandidate(stateDir, 'daily', '429 rate limit', undefined, firstFailureAt)
      const runCalls = []
      const base = {
        stateDir, repoRoot: '/nonexistent',
        departments: [{ id: 'research', name: 'Research', jobDir }],
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir }),
        headForDepartment: () => 'research-head',
        runJob: async (dept, head, jobId) => { runCalls.push(jobId); return false },
        poolDispatchBlockError: () => undefined
      }
      // 09:15 — the 09:00 cron window (2 min) has PASSED; the debt still
      // entitles the retry (the round is owed).
      await runJobBackfillTick({ ...base, now: () => new Date(2026, 7, 23, 9, 15, 0).getTime() })
      assert.equal(runCalls.length, 1, 'a debt job is retried even after the desync window passed')
      // 10:00 (+60min) — the second and LAST debt retry.
      await runJobBackfillTick({ ...base, now: () => new Date(2026, 7, 23, 10, 0, 0).getTime() })
      assert.equal(runCalls.length, 2, 'never more than 2 retries per episode')
      const c = readJobRunsBackfillFile(stateDir).candidates.daily
      assert.equal(c.attempts, 2)
      assert.equal(c.pending, false)
    })
  })
})

test('O3-b runJobBackfillTick: a candidate whose round was completed by a LATER run RESOLVES without firing (never a duplicate round)', async () => {
  await withTempStateDir(async (stateDir) => {
    await withTempJobDir(async (jobDir) => {
      await writeFile(path.join(jobDir, 'daily.md'), defText({ id: 'daily', schedule: '0 9 * * *' }), 'utf8')
      const firstFailureAt = new Date(2026, 7, 23, 9, 0, 30).getTime()
      await collectClassOutageCandidate(stateDir, 'daily', '503 service unavailable', undefined, firstFailureAt)
      // The head manually re-ran the job at 10:39 (the O3-a stamp) → recovered.
      await stampJobRun(stateDir, 'daily', new Date(2026, 7, 23, 10, 39, 0).getTime())
      const runCalls = []
      // 11:00 (past the +60 slot): the cron is NOT due AND the job is NOT in
      // debt (10:39 > 09:00:30) → resolved WITHOUT a retry.
      await runJobBackfillTick({
        stateDir, repoRoot: '/nonexistent',
        departments: [{ id: 'research', name: 'Research', jobDir }],
        departmentForJob: () => ({ id: 'research', name: 'Research', jobDir }),
        headForDepartment: () => 'research-head',
        now: () => new Date(2026, 7, 23, 11, 0, 0).getTime(),
        runJob: async (dept, head, jobId) => { runCalls.push(jobId); return true },
        poolDispatchBlockError: () => undefined
      })
      assert.equal(runCalls.length, 0, 'a completed round is never re-fired')
      const c = readJobRunsBackfillFile(stateDir).candidates.daily
      assert.equal(c.pending, false)
      assert.equal(c.attempts, 0)
    })
  })
})

test('O3-b job-runs-backfill.json + job-runs-detail.json stores: absent/malformed tolerated, non-record values dropped (the canonical file names)', async () => {
  await withTempStateDir(async (stateDir) => {
    assert.deepEqual(readJobRunsBackfillFile(stateDir), { candidates: {} }, 'absent → empty')
    assert.deepEqual(readJobRunsBackfillFile(path.join(stateDir, 'nope')), { candidates: {} })
    assert.deepEqual(readJobRunsDetailFile(stateDir), {}, 'absent detail → empty')
    await writeFile(path.join(stateDir, 'job-runs-backfill.json'), 'NOT JSON', 'utf8')
    assert.deepEqual(readJobRunsBackfillFile(stateDir), { candidates: {} }, 'malformed → empty (never throws)')
    await writeFile(path.join(stateDir, 'job-runs-detail.json'), 'junk', 'utf8')
    assert.deepEqual(readJobRunsDetailFile(stateDir), {}, 'malformed detail → empty')
    // Structural guards: partial / non-numeric / non-object records are dropped.
    await writeFile(path.join(stateDir, 'job-runs-backfill.json'), JSON.stringify({
      candidates: {
        ok: { jobId: 'ok', firstFailureAt: 1000, pending: true, attempts: 0 },
        partial: { jobId: 'partial' },
        notnum: { jobId: 'notnum', firstFailureAt: 'x', pending: true, attempts: 0 },
        junk: 'not-an-object'
      }
    }), 'utf8')
    assert.deepEqual(readJobRunsBackfillFile(stateDir).candidates, { ok: { jobId: 'ok', firstFailureAt: 1000, pending: true, attempts: 0 } })
    // The canonical file name carries the store (the collector/tick round-trip).
    const raw = JSON.parse(await readFile(path.join(stateDir, 'job-runs-backfill.json'), 'utf8'))
    assert.ok(raw.candidates.ok, 'the canonical <stateDir>/job-runs-backfill.json persists the candidates object')
    // Detail guards: ts/trigger required, workerId/sessionId optional strings.
    await writeFile(path.join(stateDir, 'job-runs-detail.json'), JSON.stringify({
      good: { ts: 1000, trigger: 'backfill' },
      withIds: { ts: 2000, trigger: 'backfill', workerId: 'w1', sessionId: 's1' },
      noTs: { trigger: 'backfill' },
      badTrigger: { ts: 3000, trigger: 42 }
    }), 'utf8')
    const detail = readJobRunsDetailFile(stateDir)
    assert.deepEqual(detail.good, { ts: 1000, trigger: 'backfill' })
    assert.deepEqual(detail.withIds, { ts: 2000, trigger: 'backfill', workerId: 'w1', sessionId: 's1' })
    assert.equal(detail.noTs, undefined)
    assert.equal(detail.badTrigger, undefined)
  })
})
