// dsh-deepartments — FB-253 mark-delivery CLI tests: the host-run hygiene CLI
// (scripts/mark-delivery-cli.mjs) LISTs and APPLY-settles stale 'prepared'/
// 'failed' delivery-sidecar rows addressed to RETIRED posts (append-only
// 'terminal' via dshd-core markDelivery; the criterion EXACTLY mirrors the
// in-session settleRetiredPostDeliveries / the boot DeliveryRedeliverer).
//
// Hermetic: every case runs against a mkdtemp fixture stateDir (posts.json +
// messages.jsonl + deliveries.jsonl) — NEVER the live stateDir. The pure
// helpers are unit-tested in-process; the CLI surface (modes, exit codes,
// append-only proof, loud aborts) is exercised via child_process against the
// REAL script. Tests run against the compiled lib/ (pnpm build first — the
// script imports 'dshd-core' exactly like a repo consumer).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseMessageRecords, parseDeliveryRows } from 'dshd-core'

const SCRIPT = fileURLToPath(new URL('../scripts/mark-delivery-cli.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

// The fixture store: one RETIRED worker recipient ('worker-gone'), one LIVE
// worker ('worker-live'), a message record per pair (m-104 REBOUND — the
// current record addresses only worker-live; m-105 TRIMMED — record absent),
// and the append-ordered delivery rows (latestPerKey: a later
// delivered/terminal row shadows an earlier prepared). Expected candidates:
// ONLY m-101 (prepared) and m-107 (failed).
const FIXTURE_POSTS = {
  'worker-gone': { sessionId: 'worker-worker-gone-uuid', roomId: 'internal-programming', agentPreset: 'deepartments-worker', provider: 'worker', retired: true },
  'worker-live': { sessionId: 'worker-worker-live-uuid', roomId: 'internal-programming', agentPreset: 'deepartments-worker', provider: 'worker' }
}
const FIXTURE_MESSAGES = [
  { id: 'm-101', seq: 101, ts: 1000, from: 'internal-programming-head', to: ['worker-gone'], text: 'hi', kind: 'agent' },
  { id: 'm-102', seq: 102, ts: 1001, from: 'internal-programming-head', to: ['worker-live'], text: 'hi', kind: 'agent' },
  { id: 'm-104', seq: 104, ts: 1002, from: 'internal-programming-head', to: ['worker-live'], text: 'rebound', kind: 'agent' },
  { id: 'm-106', seq: 106, ts: 1004, from: 'internal-programming-head', to: ['worker-gone'], text: 'settled', kind: 'agent' },
  { id: 'm-107', seq: 107, ts: 1006, from: 'internal-programming-head', to: ['worker-gone'], text: 'failed', kind: 'agent' },
  { id: 'm-108', seq: 108, ts: 1008, from: 'internal-programming-head', to: ['worker-gone'], text: 'terminal', kind: 'agent' }
].map((record) => JSON.stringify(record)).join('\n') + '\n'
const FIXTURE_DELIVERIES = [
  ['m-101', 'worker-gone', 'prepared', 1000],
  ['m-102', 'worker-live', 'prepared', 1001],
  ['m-104', 'worker-gone', 'prepared', 1002],
  ['m-105', 'worker-gone', 'prepared', 1003],
  ['m-106', 'worker-gone', 'prepared', 1004],
  ['m-106', 'worker-gone', 'delivered', 1005],
  ['m-107', 'worker-gone', 'prepared', 1006],
  ['m-107', 'worker-gone', 'failed', 1007],
  ['m-108', 'worker-gone', 'prepared', 1008],
  ['m-108', 'worker-gone', 'terminal', 1009]
].map(([messageId, recipientId, status, ts]) => JSON.stringify({ messageId, recipientId, status, ts })).join('\n') + '\n'

async function makeFixtureDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mark-delivery-cli-'))
  await writeFile(path.join(dir, 'posts.json'), JSON.stringify(FIXTURE_POSTS, null, 2))
  await writeFile(path.join(dir, 'messages.jsonl'), FIXTURE_MESSAGES)
  await writeFile(path.join(dir, 'deliveries.jsonl'), FIXTURE_DELIVERIES)
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

/** Run the REAL CLI expecting exit 0 → stdout. */
function runCli(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO_ROOT })
}

/** Run the REAL CLI expecting a non-zero exit → the stderr text. */
function runCliFail(args) {
  try {
    runCli(args)
  } catch (error) {
    assert.equal(error.status, 1, `CLI must exit 1 for: ${args.join(' ')}`)
    return error.stderr.toString()
  }
  assert.fail(`CLI unexpectedly succeeded for: ${args.join(' ')}`)
}

test('fb-253 (a): --list lists EXACTLY the prepared-stale/failed candidates to RETIRED recipients (record guard OK), with recipient + status — a dry probe that writes nothing', async (t) => {
  const dir = await makeFixtureDir(t)
  const stdout = runCli(['--list', '--stateDir', dir])
  assert.match(stdout, /m-101 → worker-gone\s+\(was prepared\)/, 'the prepared-stale pair to the retired recipient is listed')
  assert.match(stdout, /m-107 → worker-gone\s+\(was failed\)/, 'the failed pair to the retired recipient is listed')
  assert.match(stdout, /candidate pairs .*: 2/, 'exactly TWO candidates')
  // Never listed: the LIVE recipient (m-102), the REBOUND pair (m-104), the
  // TRIMMED-record pair (m-105), the already-settled pairs (m-106/m-108).
  assert.doesNotMatch(stdout, /m-102/, 'a LIVE recipient is never a candidate')
  assert.doesNotMatch(stdout, /m-104/, 'a pair whose current record does NOT address the recipient (rebound) is never a candidate')
  assert.doesNotMatch(stdout, /m-105/, 'a pair with NO current record (trimmed) is never a candidate')
  assert.doesNotMatch(stdout, /m-106/, 'an already-delivered pair is never a candidate')
  assert.doesNotMatch(stdout, /m-108/, 'an already-terminal pair is never a candidate')
  assert.equal(await readFile(path.join(dir, 'deliveries.jsonl'), 'utf8'), FIXTURE_DELIVERIES, 'LIST writes nothing — the sidecar is byte-identical')
})

test('fb-253 (b): --apply appends ONE \'terminal\' row per VALID pair via markDelivery — APPEND-ONLY (prior rows byte-identical, only 2 rows appended, never re-marked prepared)', async (t) => {
  const dir = await makeFixtureDir(t)
  const before = await readFile(path.join(dir, 'deliveries.jsonl'), 'utf8')
  const stdout = runCli(['--apply', '--stateDir', dir])
  assert.match(stdout, /applied 2 terminal row/, '2 candidates applied')
  const after = await readFile(path.join(dir, 'deliveries.jsonl'), 'utf8')
  const beforeLines = before.split('\n').filter(Boolean)
  const afterLines = after.split('\n').filter(Boolean)
  assert.equal(afterLines.length, beforeLines.length + 2, 'exactly TWO rows appended — nothing rewritten')
  assert.deepEqual(afterLines.slice(0, beforeLines.length), beforeLines, 'the FIRST rows are byte-identical (append-only — never rewritten, never re-marked)')
  const appended = afterLines.slice(beforeLines.length).map((line) => JSON.parse(line))
  assert.deepEqual(
    appended.map((row) => [row.messageId, row.recipientId, row.status]),
    [['m-101', 'worker-gone', 'terminal'], ['m-107', 'worker-gone', 'terminal']],
    'ONLY the two valid pairs get \'terminal\' (live/rebound/trimmed/settled are skipped)'
  )
  assert.ok(appended.every((row) => typeof row.ts === 'number'), 'terminal rows carry a numeric ts')
  assert.ok(appended.every((row) => row.noWake === undefined), 'terminal rows are plain rows (no noWake flag)')
})

test('fb-253 (c): the ALTO-1 rebind guard skips a pair whose CURRENT record is missing (trimmed) OR does not address the recipient (rebound) — the settle never touches the wrong record', async () => {
  const mod = await import('../scripts/mark-delivery-cli.mjs')
  const rows = parseDeliveryRows(FIXTURE_DELIVERIES)
  const recordsById = new Map(parseMessageRecords(FIXTURE_MESSAGES).map((record) => [record.id, record]))
  const candidates = mod.selectSettleCandidates(rows, recordsById, new Set(['worker-gone']))
  const ids = candidates.map((candidate) => candidate.messageId).sort()
  assert.deepEqual(ids, ['m-101', 'm-107'], 'only the guarded-OK pairs are candidates')
  assert.ok(!ids.includes('m-104'), 'rebound: the record EXISTS but its to[] excludes the recipient → skipped')
  assert.ok(!ids.includes('m-105'), 'trimmed: NO current record → skipped')
  // A defensive double-check: even when the sidecar holds a stale row for a
  // message whose CURRENT record addresses the recipient differently, the
  // guard (not the sidecar) decides — the sidecar is never alone.
  const reboundRow = [{ messageId: 'm-104', recipientId: 'worker-gone', status: 'prepared', ts: 2000 }]
  assert.equal(mod.selectSettleCandidates(reboundRow, recordsById, new Set(['worker-gone'])).length, 0, 'a row for m-104 → worker-gone is skipped while the record addresses worker-live')
})

test('fb-253 (d): a LIVE recipient is NEVER touched — not in the full scan, and not even when --recipient scopes it explicitly', async (t) => {
  const mod = await import('../scripts/mark-delivery-cli.mjs')
  const rows = parseDeliveryRows(FIXTURE_DELIVERIES)
  const recordsById = new Map(parseMessageRecords(FIXTURE_MESSAGES).map((record) => [record.id, record]))
  assert.equal(mod.selectSettleCandidates(rows, recordsById, new Set(['worker-gone']), 'worker-live').length, 0, 'a LIVE scope yields 0 candidates')
  const dir = await makeFixtureDir(t)
  const stdout = runCli(['--apply', '--recipient', 'worker-live', '--stateDir', dir])
  assert.match(stdout, /candidate pairs .*: 0/, 'CLI-level: scoped live → 0 candidates')
  assert.equal(await readFile(path.join(dir, 'deliveries.jsonl'), 'utf8'), FIXTURE_DELIVERIES, 'no rows appended for the live recipient')
})

test('fb-253 (e): IDEMPOTENT — a second --apply after the first lists 0 candidates and appends NOTHING (the \'terminal\' row shadows the stale one)', async (t) => {
  const dir = await makeFixtureDir(t)
  runCli(['--apply', '--stateDir', dir])
  const afterFirst = await readFile(path.join(dir, 'deliveries.jsonl'), 'utf8')
  const stdout = runCli(['--apply', '--stateDir', dir])
  assert.match(stdout, /candidate pairs .*: 0/, 'second run: THE terminal row shadows — 0 candidates')
  assert.match(stdout, /nothing to settle/, 'second run: nothing to do')
  assert.equal(await readFile(path.join(dir, 'deliveries.jsonl'), 'utf8'), afterFirst, 'second run appends NOTHING — the file is byte-identical')
  assert.match(stdout, /LIST|APPLY/, 'mode label present')
})

test('fb-253 (f): --apply --dry-run computes the plan but writes NOTHING (sidecar byte-identical)', async (t) => {
  const dir = await makeFixtureDir(t)
  const stdout = runCli(['--apply', '--dry-run', '--stateDir', dir])
  assert.match(stdout, /DRY-RUN/, 'the dry-run marker is printed')
  assert.match(stdout, /m-101 → worker-gone/, 'the plan lists the candidate')
  assert.match(stdout, /nothing written/, 'explicitly states nothing was written')
  assert.equal(await readFile(path.join(dir, 'deliveries.jsonl'), 'utf8'), FIXTURE_DELIVERIES, 'dry-run never writes')
})

test("fb-253: latestPerKey dedupe — ONE pair is evaluated no matter how many (messageId, recipientId) rows exist (a multi-'prepared' pair is a single candidate)", async () => {
  const mod = await import('../scripts/mark-delivery-cli.mjs')
  const rows = [
    { messageId: 'm-109', recipientId: 'worker-gone', status: 'prepared', ts: 1 },
    { messageId: 'm-109', recipientId: 'worker-gone', status: 'prepared', ts: 2 },
    { messageId: 'm-109', recipientId: 'worker-gone', status: 'prepared', ts: 3 }
  ]
  const recordsById = new Map([['m-109', { id: 'm-109', seq: 109, ts: 1, from: 'internal-programming-head', to: ['worker-gone'], text: 'x', kind: 'agent' }]])
  const candidates = mod.selectSettleCandidates(rows, recordsById, new Set(['worker-gone']))
  assert.equal(candidates.length, 1, 'one PAIR — never one candidate per row')
  assert.equal(candidates[0].status, 'prepared', 'the LATEST row\'s status is the pair\'s status')
})

test('fb-253: parseRetiredPostsText — the EXACT retired flag (retired: true) builds the set; a malformed registry aborts loud (never a silent empty set)', async () => {
  const mod = await import('../scripts/mark-delivery-cli.mjs')
  const retired = mod.parseRetiredPostsText(JSON.stringify(FIXTURE_POSTS))
  assert.deepEqual([...retired].sort(), ['worker-gone'], 'only the retired:true entry is in the set')
  assert.throws(() => mod.parseRetiredPostsText('{not json'), /malformed/, 'malformed registry → loud abort')
  assert.throws(() => mod.parseRetiredPostsText(JSON.stringify(['a'])), /not a posts-registry object/, 'a JSON array is not a registry → loud abort')
  // A registry with the old worker also carrying a NON-boolean/missing retired
  // field is simply not retired — the flag must be boolean true.
  const absent = mod.parseRetiredPostsText(JSON.stringify({ 'worker-x': { sessionId: 's' }, 'worker-y': { sessionId: 's', retired: 'yes' } }))
  assert.equal(absent.size, 0, 'no retired:true → empty set (no false positives)')
})

test('fb-253: loud aborts — usage errors and corrupt/missing store files exit 1 and write NOTHING', async (t) => {
  // usage: --stateDir is REQUIRED (never defaulted — a wrong tree must fail loud)
  const usage = runCliFail(['--list'])
  assert.match(usage, /--stateDir is REQUIRED/)
  assert.match(usage, /usage: node scripts\/mark-delivery-cli\.mjs/)

  // usage: an unknown flag (a typo like --aplly must never silently no-op)
  const unknown = runCliFail(['--stateDir', '/tmp', '--aplly'])
  assert.match(unknown, /unknown argument: --aplly/)

  // stateDir canary: a MISSING posts.json aborts loud
  const emptyDir = await mkdtemp(path.join(tmpdir(), 'mark-delivery-cli-empty-'))
  t.after(async () => { await rm(emptyDir, { recursive: true, force: true }) })
  const noPosts = runCliFail(['--list', '--stateDir', emptyDir])
  assert.match(noPosts, /posts\.json missing/, 'missing posts.json → loud abort (wrong --stateDir?)')

  // ALTO-1 guard is non-negotiable: a MISSING messages.jsonl aborts loud (never
  // a guard-less settle)
  const noMessagesDir = await mkdtemp(path.join(tmpdir(), 'mark-delivery-cli-nomsg-'))
  t.after(async () => { await rm(noMessagesDir, { recursive: true, force: true }) })
  await writeFile(path.join(noMessagesDir, 'posts.json'), JSON.stringify(FIXTURE_POSTS))
  await writeFile(path.join(noMessagesDir, 'deliveries.jsonl'), FIXTURE_DELIVERIES)
  const noMessages = runCliFail(['--list', '--stateDir', noMessagesDir])
  assert.match(noMessages, /ALTO-1 record guard is unavailable/)

  // a malformed mid-file deliveries row aborts loud (corruption must never
  // produce a false 0-candidate hygiene run)
  const badDeliveriesDir = await mkdtemp(path.join(tmpdir(), 'mark-delivery-cli-baddel-'))
  t.after(async () => { await rm(badDeliveriesDir, { recursive: true, force: true }) })
  await writeFile(path.join(badDeliveriesDir, 'posts.json'), JSON.stringify(FIXTURE_POSTS))
  await writeFile(path.join(badDeliveriesDir, 'messages.jsonl'), FIXTURE_MESSAGES)
  const deliveriesLines = FIXTURE_DELIVERIES.split('\n').filter(Boolean)
  const badDeliveries = [...deliveriesLines.slice(0, 5), 'NOT-JSON', ...deliveriesLines.slice(6)].join('\n') + '\n'
  await writeFile(path.join(badDeliveriesDir, 'deliveries.jsonl'), badDeliveries)
  const badDeliveriesOut = runCliFail(['--list', '--stateDir', badDeliveriesDir])
  assert.match(badDeliveriesOut, /malformed row/, 'malformed deliveries row → loud abort')

  // a malformed posts.json aborts loud
  const badPostsDir = await mkdtemp(path.join(tmpdir(), 'mark-delivery-cli-badposts-'))
  t.after(async () => { await rm(badPostsDir, { recursive: true, force: true }) })
  await writeFile(path.join(badPostsDir, 'posts.json'), '{not json')
  const badPosts = runCliFail(['--list', '--stateDir', badPostsDir])
  assert.match(badPosts, /posts\.json malformed/, 'malformed posts.json → loud abort')
})

test('fb-253: a stateDir with NO deliveries.jsonl is a legitimate no-op — nothing was ever sent, exit 0, 0 candidates', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mark-delivery-cli-nodel-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await writeFile(path.join(dir, 'posts.json'), JSON.stringify(FIXTURE_POSTS))
  await writeFile(path.join(dir, 'messages.jsonl'), FIXTURE_MESSAGES)
  const stdout = runCli(['--list', '--stateDir', dir])
  assert.match(stdout, /candidate pairs .*: 0/)
  assert.match(stdout, /nothing to settle/)
})

test('fb-253: the module import is side-effect free (guarded main) — importing the helpers never runs the CLI', async () => {
  const mod = await import('../scripts/mark-delivery-cli.mjs')
  assert.equal(typeof mod.selectSettleCandidates, 'function', 'pure helper exported')
  assert.equal(typeof mod.main, 'function', 'CLI body exported for integration testing')
  assert.equal(typeof mod.parseRetiredPostsText, 'function', 'registry parser exported')
})

test('fb-253: a scoped apply settles ONLY the scoped retired recipient, leaving every other pair untouched', async (t) => {
  const dir = await makeFixtureDir(t)
  const stdout = runCli(['--apply', '--recipient', 'worker-gone', '--stateDir', dir])
  assert.match(stdout, /scoped to --recipient worker-gone/)
  assert.match(stdout, /applied 2 terminal row/)
  const after = await readFile(path.join(dir, 'deliveries.jsonl'), 'utf8')
  const appended = after.split('\n').filter(Boolean).slice(10).map((line) => JSON.parse(line))
  assert.deepEqual(appended.map((row) => [row.messageId, row.recipientId]), [['m-101', 'worker-gone'], ['m-107', 'worker-gone']], 'only the scoped retired recipient\'s pairs are settled')
})

// ---- hosts.json UNION fixtures (fb-253 addendum: retired HOST-sessions) ----
// hosts.json shape (live store): an object keyed by host-session id (the
// recipient ids deliveries.jsonl uses) + a numeric `schemaVersion` marker. A
// host is retired exactly when its entry carries retired:true (retiredAt +
// rotatedTo are rotation metadata — the retired KEY is the recipient, the
// chain state never un-retires it). Fixture: host-session-gone (retired,
// rotatedTo consumed → its successor is ALSO retired), host-session-gone2
// (retired, rotatedTo → the LIVE host — the chain the QD criterion (1) calls
// "consumed": the mailbox already rotated through to the live successor),
// host-session-live (NOT retired — must never be included), schemaVersion.
const FIXTURE_HOSTS = {
  'host-session-gone': { sessionId: 'session-gone-uuid', roomId: 'board', retired: true, retiredAt: 1000, rotatedTo: 'host-session-gone2' },
  'host-session-gone2': { sessionId: 'session-gone2-uuid', roomId: 'board', retired: true, retiredAt: 2000, rotatedTo: 'host-session-live' },
  'host-session-live': { sessionId: 'session-live-uuid', roomId: 'board' },
  schemaVersion: 2
}
// Records: every pair has a CURRENT record whose to[] includes the recipient —
// the ALTO-1 guard passes for ALL of them, so only the RETIRED-set membership
// discriminates (m-303 → the LIVE host must fall out on the retired check).
const FIXTURE_HOST_MESSAGES = [
  { id: 'm-301', seq: 301, ts: 3000, from: 'internal-programming-head', to: ['host-session-gone'], text: 'a', kind: 'agent' },
  { id: 'm-302', seq: 302, ts: 3001, from: 'internal-programming-head', to: ['host-session-gone2'], text: 'b', kind: 'agent' },
  { id: 'm-303', seq: 303, ts: 3002, from: 'internal-programming-head', to: ['host-session-live'], text: 'c', kind: 'agent' },
  { id: 'm-304', seq: 304, ts: 3003, from: 'internal-programming-head', to: ['worker-gone'], text: 'd', kind: 'agent' }
].map((record) => JSON.stringify(record)).join('\n') + '\n'
const FIXTURE_HOST_DELIVERIES = [
  ['m-301', 'host-session-gone', 'prepared', 3000],
  ['m-302', 'host-session-gone2', 'prepared', 3001],
  ['m-303', 'host-session-live', 'prepared', 3002],
  ['m-304', 'worker-gone', 'prepared', 3003]
].map(([messageId, recipientId, status, ts]) => JSON.stringify({ messageId, recipientId, status, ts })).join('\n') + '\n'

async function makeHostsFixtureDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mark-delivery-cli-hosts-'))
  await writeFile(path.join(dir, 'posts.json'), JSON.stringify(FIXTURE_POSTS, null, 2))
  await writeFile(path.join(dir, 'hosts.json'), JSON.stringify(FIXTURE_HOSTS, null, 2))
  await writeFile(path.join(dir, 'messages.jsonl'), FIXTURE_HOST_MESSAGES)
  await writeFile(path.join(dir, 'deliveries.jsonl'), FIXTURE_HOST_DELIVERIES)
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

test('fb-253 (hosts union): parseRetiredHostsText builds the RETIRED host-session set — retired:true keys only, the schemaVersion marker and LIVE hosts excluded', async () => {
  const mod = await import('../scripts/mark-delivery-cli.mjs')
  const retired = mod.parseRetiredHostsText(JSON.stringify(FIXTURE_HOSTS))
  assert.deepEqual([...retired].sort(), ['host-session-gone', 'host-session-gone2'], 'only the retired:true host-session ids are in the set')
  assert.ok(!retired.has('host-session-live'), 'a LIVE host is never in the set')
  assert.ok(!retired.has('schemaVersion'), 'the numeric schemaVersion marker is never treated as a host id')
  assert.throws(() => mod.parseRetiredHostsText('{not json'), /malformed/, 'malformed hosts.json → loud abort')
  assert.throws(() => mod.parseRetiredHostsText(JSON.stringify(['a'])), /not a hosts-registry object/, 'a JSON array is not a hosts registry → loud abort')
})

test('fb-253 (hosts union): readRetiredPostIds merges posts.json ∪ hosts.json — retired hosts join retired posts, a MISSING hosts.json still yields the posts-only set', async (t) => {
  const mod = await import('../scripts/mark-delivery-cli.mjs')
  const dir = await makeHostsFixtureDir(t)
  const retired = mod.readRetiredPostIds(dir)
  assert.deepEqual([...retired].sort(), ['host-session-gone', 'host-session-gone2', 'worker-gone'], 'the union = retired posts ∪ retired host-sessions')
  // Missing hosts.json is a legitimate posts-only store (never an abort):
  const postsOnly = await mkdtemp(path.join(tmpdir(), 'mark-delivery-cli-nohosts-'))
  t.after(async () => { await rm(postsOnly, { recursive: true, force: true }) })
  await writeFile(path.join(postsOnly, 'posts.json'), JSON.stringify(FIXTURE_POSTS))
  const postsSet = mod.readRetiredPostIds(postsOnly)
  assert.deepEqual([...postsSet], ['worker-gone'], 'no hosts.json → the posts-only retired set (backward compatible)')
})

test('fb-253 (hosts union): selectSettleCandidates lists prepared rows to RETIRED HOST-sessions (incl. a consumed-rotatedTo chain) — a LIVE host is never a candidate, retired posts stay included', async () => {
  const mod = await import('../scripts/mark-delivery-cli.mjs')
  const rows = parseDeliveryRows(FIXTURE_HOST_DELIVERIES)
  const recordsById = new Map(parseMessageRecords(FIXTURE_HOST_MESSAGES).map((record) => [record.id, record]))
  const retired = new Set(['host-session-gone', 'host-session-gone2', 'worker-gone'])
  const candidates = mod.selectSettleCandidates(rows, recordsById, retired)
  const ids = candidates.map((candidate) => candidate.messageId).sort()
  assert.deepEqual(ids, ['m-301', 'm-302', 'm-304'], 'the retired HOST pairs (m-301/m-302) AND the retired POST pair (m-304) are candidates')
  assert.ok(!ids.includes('m-303'), 'a prepared row to a LIVE host-session is NEVER a candidate — the FIFO gate and live-queue isolation hold')
  assert.ok(candidates.every((c) => c.status === 'prepared'), 'the pair status is untouched — the CLI never re-marks anything')
})

test('fb-253 (hosts union): the CLI --list shows the union candidates and --apply settles them append-only, leaving the LIVE host untouched', async (t) => {
  const dir = await makeHostsFixtureDir(t)
  const list = runCli(['--list', '--stateDir', dir])
  assert.match(list, /retired recipients \(posts\.json ∪ hosts\.json\): 3/, 'the union count is reported')
  assert.match(list, /m-301 → host-session-gone\s+\(was prepared\)/, 'the retired-host pair is listed')
  assert.match(list, /m-302 → host-session-gone2\s+\(was prepared\)/, 'the consumed-rotatedTo chain host is listed (retired key is the recipient)')
  assert.match(list, /m-304 → worker-gone\s+\(was prepared\)/, 'the retired post pair is still listed')
  assert.match(list, /candidate pairs .*: 3/, 'exactly THREE candidates')
  assert.doesNotMatch(list, /m-303/, 'the LIVE host pair is never a candidate')

  const before = await readFile(path.join(dir, 'deliveries.jsonl'), 'utf8')
  const apply = runCli(['--apply', '--stateDir', dir])
  assert.match(apply, /applied 3 terminal row/, 'three terminal rows applied')
  const after = await readFile(path.join(dir, 'deliveries.jsonl'), 'utf8')
  const beforeLines = before.split('\n').filter(Boolean)
  const afterLines = after.split('\n').filter(Boolean)
  assert.equal(afterLines.length, beforeLines.length + 3, 'exactly THREE rows appended — nothing rewritten')
  assert.deepEqual(afterLines.slice(0, beforeLines.length), beforeLines, 'the FIRST rows are byte-identical (append-only)')
  const appended = afterLines.slice(beforeLines.length).map((line) => JSON.parse(line))
  assert.deepEqual(
    appended.map((row) => [row.messageId, row.recipientId, row.status]),
    [
      ['m-301', 'host-session-gone', 'terminal'],
      ['m-302', 'host-session-gone2', 'terminal'],
      ['m-304', 'worker-gone', 'terminal']
    ],
    'ONLY the retired-host/retired-post pairs get \'terminal\' — the LIVE host is never touched'
  )
  // Idempotent: a re-run now lists 0 candidates.
  const second = runCli(['--list', '--stateDir', dir])
  assert.match(second, /candidate pairs .*: 0/, 'idempotent — the terminal rows shadow the stale prepared rows')
})

test('fb-253 (hosts union): a MALFORMED hosts.json aborts loud — corruption must never shrink the RETIRED set silently', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mark-delivery-cli-badhosts-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await writeFile(path.join(dir, 'posts.json'), JSON.stringify(FIXTURE_POSTS))
  await writeFile(path.join(dir, 'hosts.json'), '{not json')
  await writeFile(path.join(dir, 'messages.jsonl'), FIXTURE_MESSAGES)
  await writeFile(path.join(dir, 'deliveries.jsonl'), FIXTURE_DELIVERIES)
  const badHosts = runCliFail(['--list', '--stateDir', dir])
  assert.match(badHosts, /hosts\.json malformed/, 'malformed hosts.json → loud abort (nothing written)')
})