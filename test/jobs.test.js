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
  cronAll,
  cronFieldParse,
  cronIsDue,
  cronMatches,
  jobDirFor,
  nextCronFire,
  parseCronSchedule,
  parseJobDefFrontmatter,
  readAgendaJobs,
  readCalendarStateFile,
  readJobDefinitionFile,
  readJobRunsStateFile,
  runAgendaSchedulerTick,
  unwrapQuotedScalar,
  writeCalendarStateFile,
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
